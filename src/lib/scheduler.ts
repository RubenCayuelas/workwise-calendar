/**
 * The seam where the pure engine (src/lib/composition.ts) meets the database: it reads the
 * snapshot, resolves each day, calls the engine and writes the placement. There is exactly
 * one of it so `SUM(blocks.duration) == projects.total_hours` can be asserted inside the
 * transaction, before the commit — every failure throws, and a throw is what rolls the
 * transaction back, so a half-recomposed calendar is impossible rather than merely unlikely.
 */

import { getDb, type Db } from './db';
import { minutesToHHmm, todayLocal } from './dates';
import {
  compose,
  createDayConfigResolver,
  plannableMinutes,
  resolveManualPlacement,
  summarizeSchedule,
  type ComposeInput,
  type DayConfig,
  type ManualPlacementError,
  type ScheduleSummary,
} from './composition';
import { conflict, internal, ERROR_MESSAGE_KEYS, type AppError } from './errors';
import { dayEndMinutes } from './manualWindow';
import { assertRowWithinDayEnd } from './validation';
import { newId } from './ids';
import { nowTimestamp } from './timestamps';
import { dayShapeFromSettings, readSettings } from './settings';
import {
  blockMinutesByProject,
  deleteBlocks,
  insertBlock,
  listBlocks,
  updateBlock,
  type BlockPlacement,
} from './repositories/blocks';
import { listGaps } from './repositories/gaps';
import { listDayOverrides } from './repositories/dayOverrides';
import { findProject, totalMinutesByProject } from './repositories/projects';
import type { Block, DayShape, Gap, Settings } from '../types';

// ---------------------------------------------------------------------------
// Transactions
// ---------------------------------------------------------------------------

/**
 * Runs `work` as one atomic unit — the row edit AND the recomposition it triggers — so a
 * refusal from either half leaves the calendar exactly as it was. `better-sqlite3`
 * transactions nest as savepoints, so `recompose` wrapping itself inside an outer
 * `runTransaction` is harmless.
 */
export function runTransaction<T>(db: Db, work: () => T): T {
  return db.transaction(work)();
}

// ---------------------------------------------------------------------------
// Day configuration
// ---------------------------------------------------------------------------

/**
 * The single resolution path: global settings, then the weekday rule (Mon-Thu `auto`, Friday
 * `buffer`, Sat/Sun `manual`), then `day_overrides`. Built once per operation and handed to
 * the engine, so every day in a recomposition is read the same way.
 */
export function dayConfigResolver(db: Db = getDb(), settings: Settings = readSettings(db)): (date: string) => DayConfig {
  return createDayConfigResolver(dayShapeFromSettings(settings), listDayOverrides(db));
}

/** One day's configuration. The same resolution path, for a single date. */
export function getDayConfig(date: string, db: Db = getDb()): DayConfig {
  return dayConfigResolver(db)(date);
}

// ---------------------------------------------------------------------------
// The snapshot
// ---------------------------------------------------------------------------

/**
 * Everything the engine and the week view read, taken in one consistent pass.
 *
 * The snapshot is the WHOLE calendar, not a window: overflow chains forward across weeks up
 * to the horizon, so a window could hide the rows a reflow is about to displace, and rows
 * outside the movable pool cost nothing to pass in while being visible as obstacles.
 */
export interface ScheduleSnapshot {
  today: string;
  settings: Settings;
  shape: DayShape;
  blocks: Block[];
  gaps: Gap[];
  getDayConfig: (date: string) => DayConfig;
}

export function readSnapshot(db: Db = getDb(), today: string = todayLocal()): ScheduleSnapshot {
  const settings = readSettings(db);
  return {
    today,
    settings,
    shape: dayShapeFromSettings(settings),
    blocks: listBlocks(db),
    gaps: listGaps(db),
    getDayConfig: dayConfigResolver(db, settings),
  };
}

/**
 * Why a recomposition is running. It is the Friday rule's only input and deliberately not
 * inferable: a job whose hours were just raised and a job displaced by someone else's edit
 * look identical in the blocks table, so the engine has to be told. Everything else — a
 * deletion, a drag, a gap, a capacity change, a rename — passes neither list and keeps its
 * hands off the buffer.
 */
export interface RecomposeIntent {
  /** Projects CREATED by this operation. Their hours never target Friday. */
  newProjectIds?: readonly string[];
  /** Projects whose hours this operation RAISED. The only thing the colchón absorbs. */
  grownProjectIds?: readonly string[];
}

export interface RecomposeOptions extends RecomposeIntent {
  /** Local `YYYY-MM-DD`. Defaults to the shop clock; an input so tests are fixed. */
  today?: string;
  /**
   * Compose THESE rows instead of the stored calendar — the output of an edit transform that
   * has decided how many hours each row carries but not where they sit. Rows carrying an id
   * the table does not have yet are INSERTed.
   */
  blocks?: readonly Block[];
  /** Rows an edit transform already resolved to delete (a row that reached zero). */
  deletedBlockIds?: readonly string[];
  /**
   * The row a human just DROPPED, when this recomposition is a placement gesture. Overlaps it
   * created are resolved by `resolveManualPlacement` before the reflow, in this same
   * transaction. Leave it out for every other operation: it must never become a general pass
   * over the calendar, because two fixed rows that were ALREADY overlapping are somebody's
   * decision.
   */
  manualPlacementBlockId?: string;
}

export interface RecomposeReport {
  today: string;
  /** The calendar as stored after the write, in queue order. */
  blocks: Block[];
  /**
   * THE CALENDAR IS NOT WHAT IT WAS — asked of the rows the OWNER can see rather than of the
   * ids. A gesture on a multi-row run folds the run into one row and lets the reflow lay it
   * out again, so ids churn on a pass that moved nothing; the comparison is over `(project,
   * date, start, duration, marks)` and ignores identity.
   */
  changed: boolean;
  insertedBlockIds: string[];
  updatedBlockIds: string[];
  deletedBlockIds: string[];
  /** Rows of the dropped row's own job that were absorbed into it. */
  mergedBlockIds: string[];
  /** Jobs whose row the drop cut in two. Their totals are unchanged. */
  displacedProjectIds: string[];
  /** The header strip's arithmetic, recomputed from what was just written. */
  summary: ScheduleSummary;
}

/**
 * Reflows the movable pool and writes the result: read the snapshot (or take the caller's
 * edited rows), call the engine, write only the rows that changed, assert the hours
 * invariant, return the fresh calendar. The last two sit in one transaction so the invariant
 * can veto the write.
 */
export function recompose(db: Db, options: RecomposeOptions = {}): RecomposeReport {
  const today = options.today ?? todayLocal();
  const settings = readSettings(db);
  const stored = new Map(listBlocks(db).map((block) => [block.id, block]));

  const dropped = new Set(options.deletedBlockIds ?? []);
  const source = options.blocks ?? [...stored.values()];
  const blocks = source.filter((block) => !dropped.has(block.id));

  const snapshot: ComposeInput = {
    today,
    blocks,
    gaps: listGaps(db),
    getDayConfig: dayConfigResolver(db, settings),
    planningHorizonWeeks: settings.planningHorizonWeeks,
    newProjectIds: options.newProjectIds,
    grownProjectIds: options.grownProjectIds,
  };

  // A drop can leave two rows the reflow may not move sitting on top of each other, so the
  // overlap is resolved BEFORE composing, inside this same transaction.
  const resolved = resolvePlacement(db, snapshot, options.manualPlacementBlockId);
  const input: ComposeInput = { ...snapshot, blocks: resolved.blocks };

  const result = compose(input);
  if (!result.ok) {
    // The engine's single failure mode. It reports an i18n key, and the UI is expected to
    // surface `horizonEndDate` and point at Settings, because widening the horizon is the way
    // out.
    throw conflict(result.error.code, result.error.messageKey, {
      details: {
        projectId: result.error.projectId,
        unplacedMinutes: result.error.unplacedMinutes,
        horizonEndDate: result.error.horizonEndDate,
      },
    });
  }

  return runTransaction(db, () => {
    const insertedBlockIds: string[] = [];
    const updatedBlockIds: string[] = [];
    const surviving = new Set<string>();
    const writes: Array<{ placement: BlockPlacement; exists: boolean }> = [];

    for (const placed of result.blocks) {
      const id = placed.id ?? newId();
      surviving.add(id);
      const placement: BlockPlacement = {
        id,
        projectId: placed.projectId,
        date: placed.date,
        startMinutes: placed.startMinutes,
        durationMinutes: placed.durationMinutes,
        locked: placed.locked,
      };
      const current = stored.get(id);
      if (current === undefined) {
        writes.push({ placement, exists: false });
      } else if (hasMoved(current, placement)) {
        writes.push({ placement, exists: true });
      }
    }

    // The end of the day, once, over everything this transaction is about to store — one
    // place, one rule, whatever gesture produced the row.
    for (const write of writes) {
      assertRowWithinDayEnd(
        write.placement,
        dayEndMinutes(snapshot.getDayConfig(write.placement.date).manualWindows),
        endOf(stored.get(write.placement.id)),
      );
    }

    // Rows the reflow did not keep: what auto-merge absorbed, what an edit zeroed, and
    // whatever the caller handed over as deleted. Removed FIRST, so the table never holds
    // both halves of a merge.
    const removedBlockIds = [...stored.keys()].filter((id) => !surviving.has(id));
    deleteBlocks(removedBlockIds, db);

    for (const write of writes) {
      if (write.exists) {
        updateBlock(write.placement, db);
        updatedBlockIds.push(write.placement.id);
      } else {
        insertBlock(write.placement, db);
        insertedBlockIds.push(write.placement.id);
      }
    }

    assertProjectHours(db);

    const written = listBlocks(db);
    return {
      today,
      blocks: written,
      changed: !sameCalendar([...stored.values()], written),
      insertedBlockIds,
      updatedBlockIds,
      deletedBlockIds: removedBlockIds,
      mergedBlockIds: resolved.mergedBlockIds,
      displacedProjectIds: resolved.displacedProjectIds,
      summary: summarizeSchedule(written, today),
    };
  });
}

/**
 * The invariant, in integer minutes so the comparison is exact: every project's blocks must
 * sum to its estimate. Checked for EVERY project, not only the one the request touched,
 * because a recomposition may rewrite any unlocked row on the calendar and there is no undo.
 *
 * For a database edited by hand this means an existing mismatch fails every write until it is
 * corrected, deletions included. That is the intended trade, and the error names both totals.
 */
export function assertProjectHours(db: Db = getDb()): void {
  const totals = totalMinutesByProject(db);
  const sums = blockMinutesByProject(db);

  for (const [projectId, totalMinutes] of totals) {
    const blockMinutes = sums.get(projectId) ?? 0;
    if (blockMinutes !== totalMinutes) {
      throw internal('invariant-violated', ERROR_MESSAGE_KEYS.invariantViolated, {
        details: { projectId, totalMinutes, blockMinutes },
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Derived reads
// ---------------------------------------------------------------------------

/**
 * The snapshot as the engine's input, for the read-only questions the UI asks. No intent,
 * because nothing is being placed.
 */
export function composeInputOf(snapshot: ScheduleSnapshot): ComposeInput {
  return {
    today: snapshot.today,
    blocks: snapshot.blocks,
    gaps: snapshot.gaps,
    getDayConfig: snapshot.getDayConfig,
    planningHorizonWeeks: snapshot.settings.planningHorizonWeeks,
  };
}

/**
 * `min(capacity, period minutes − gaps and locked blocks)` for one day, as a union
 * of intervals. Zero for the past, a closed day and the weekend.
 */
export function plannableMinutesOf(snapshot: ScheduleSnapshot, date: string): number {
  return plannableMinutes(composeInputOf(snapshot), date);
}

/** The header strip: booked-until across all weeks, hours queued, Friday's state. */
export function readSummary(db: Db = getDb(), today: string = todayLocal()): ScheduleSummary {
  return summarizeSchedule(listBlocks(db), today);
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * The manual-overlap half of a placement gesture, as a value `recompose` can splice into its
 * snapshot. Without a dropped row it is the identity, which is what keeps every other
 * operation from tidying overlaps it did not create. A refusal is thrown, because the caller
 * is already inside a transaction and a throw is what rolls it back.
 */
function resolvePlacement(
  db: Db,
  snapshot: ComposeInput,
  manualPlacementBlockId: string | undefined,
): { blocks: readonly Block[]; mergedBlockIds: string[]; displacedProjectIds: string[] } {
  if (manualPlacementBlockId === undefined) {
    return { blocks: snapshot.blocks, mergedBlockIds: [], displacedProjectIds: [] };
  }

  const result = resolveManualPlacement(snapshot, {
    blockId: manualPlacementBlockId,
    now: nowTimestamp(),
    newBlockId: newId,
  });

  if (!result.ok) throw placementRefusal(db, result.error);

  return {
    blocks: result.blocks,
    mergedBlockIds: result.mergedBlockIds,
    displacedProjectIds: result.displacedProjectIds,
  };
}

/**
 * A placement refusal, with everything its translation interpolates. The engine reports the
 * row in machine terms because it may not read the database or invent prose; the sentence the
 * owner sees names the job and the hours. The same shape `assertGapFits` builds, so the two
 * refusals read alike.
 */
function placementRefusal(db: Db, error: ManualPlacementError): AppError {
  const project = error.projectId === undefined ? undefined : findProject(error.projectId, db);
  return conflict(error.code, error.messageKey, {
    details: {
      ...(error.blockId === undefined ? {} : { blockId: error.blockId }),
      ...(error.projectId === undefined ? {} : { projectId: error.projectId }),
      ...(error.date === undefined ? {} : { date: error.date }),
      // A gap has no job, and its reason is what the owner recognises it by.
      ...(error.reason === undefined ? {} : { reason: error.reason }),
      projectName: project?.name ?? '',
      ...(error.startMinutes === undefined
        ? {}
        : {
            startTime: minutesToHHmm(error.startMinutes),
            endTime: minutesToHHmm(error.startMinutes + (error.durationMinutes ?? 0)),
          }),
    },
  });
}

/**
 * Do these two calendars look the same to the owner? Every field a row is DRAWN from, and not
 * its id — see `RecomposeReport.changed`.
 */
function sameCalendar(before: readonly Block[], after: readonly Block[]): boolean {
  const shape = (rows: readonly Block[]): string =>
    rows
      .map(
        (row) =>
          `${row.date} ${row.startMinutes} ${row.durationMinutes} ${row.projectId} ${row.locked ? 1 : 0}`,
      )
      .sort()
      .join('|');
  return shape(before) === shape(after);
}

/** A stored row's end, for the guard's "no write may make an overrun worse" clause. */
function endOf(block: Block | undefined): number | undefined {
  return block === undefined ? undefined : block.startMinutes + block.durationMinutes;
}

/** True when the row the engine returned differs in any way from the one on disk. */
function hasMoved(current: Block, placement: BlockPlacement): boolean {
  return (
    current.projectId !== placement.projectId ||
    current.date !== placement.date ||
    current.startMinutes !== placement.startMinutes ||
    current.durationMinutes !== placement.durationMinutes ||
    // The padlock can change while the geometry stays exactly as it was — a drop onto a
    // margin adds it without moving the row a minute — and it must still reach the table.
    current.locked !== placement.locked
  );
}
