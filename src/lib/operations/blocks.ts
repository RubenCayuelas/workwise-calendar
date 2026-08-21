import { getDb, type Db } from '../db';
import { MIN_ROW_MINUTES, assertFitsInDay } from '../validation';
import { compareDates, todayLocal } from '../dates';
import { dropLanding, dropLandsLiterally, type DropDay } from '../dropSlide';
import {
  dayReflows,
  resizeBlock as resizeBlockHours,
  unitOf,
  type DayConfig,
  type EditSuccess,
  type FreedHoursChoice,
  type ScheduleSummary,
} from '../composition';
import { conflict, notFound, ERROR_MESSAGE_KEYS } from '../errors';
import { newId } from '../ids';
import { nowTimestamp } from '../timestamps';
import {
  dayConfigResolver,
  getDayConfig,
  recompose,
  runTransaction,
  type RecomposeReport,
} from '../scheduler';
import {
  findBlock,
  listBlocks,
  listBlocksByProject,
  setBlockLocked,
} from '../repositories/blocks';
import { findProject, updateProject } from '../repositories/projects';
import type { Block } from '../../types';

/** `block` is null when a merge absorbed the row the request named. */
export interface BlockMutation {
  block: Block | null;
  /** Every row of the block's job after the recomposition, in queue order. */
  blocks: Block[];
  summary: ScheduleSummary;
  /**
   * The rows the gesture's hours ended up on, in calendar order — more than one once the
   * hours filled a day and carried on, and `block` is only the first. Empty when a merge
   * absorbed it.
   */
  placedBlockIds: string[];
  /** False when the request wrote nothing visible. Never decide this from geometry. */
  changed: boolean;
  /** Locked rows a transfer had to touch. Never silent. */
  touchedLockedBlockIds: string[];
  /**
   * Rows of the dropped row's own job it absorbed; the hours were summed, never unioned.
   * Empty for every gesture that is not a drop.
   */
  mergedBlockIds: string[];
  /** Jobs whose row the drop cut in two, the tail pushed after it. Totals unchanged. */
  displacedProjectIds: string[];
}

export interface MoveBlockInput {
  date: string;
  startMinutes: number;
  /**
   * The rows the CALLER drew as one unit with this one; they are folded in and moved as ONE
   * row. Ids that are not really part of the unit are ignored.
   */
  unitBlockIds?: readonly string[];
  today?: string;
}

/** No intent is passed: a drag is not growth, so it must not spend the Friday buffer. */
export function moveBlock(blockId: string, input: MoveBlockInput, db: Db = getDb()): BlockMutation {
  const today = input.today ?? todayLocal();

  return runTransaction(db, () => {
    const block = requireBlock(blockId, db);
    assertNotPast(block.date, today, { blockId });
    assertNotPastTarget(input.date, today);

    const dayOf = dayConfigResolver(db);
    const stored = listBlocks(db);
    const named = new Set(input.unitBlockIds ?? []);
    const unit = unitOf(stored, block, (date) => dayOf(date).manualWindows, today).filter(
      (row) => row.id === blockId || named.has(row.id),
    );
    const durationMinutes = unit.reduce((total, row) => total + row.durationMinutes, 0);
    const absorbed = unit.filter((row) => row.id !== blockId).map((row) => row.id);

    // Everything below reads the LANDING, not the minute the drop asked for.
    const landing = dropLanding({
      date: input.date,
      startMinutes: input.startMinutes,
      durationMinutes,
      // A padlocked row is fixed by itself, so its footprint has to fit the day it lands on.
      fixed: block.locked,
      dayOf: (date) => landingDay(date, dayOf, today),
    });
    const pinned =
      block.locked || pinsTheRow(landing.date, landing.startMinutes, durationMinutes, dayOf);

    // Only a row stored where it was released has a footprint to fit; a rank has none.
    if (pinned) assertFitsInDay(landing.startMinutes, durationMinutes);
    const blocks = stored
      .filter((row) => !absorbed.includes(row.id))
      .map((row) =>
        row.id === blockId
          ? {
              ...row,
              date: landing.date,
              startMinutes: landing.startMinutes,
              durationMinutes,
              locked: pinned,
            }
          : row,
      );

    // Handed to `recompose` rather than written first: a write before the reflow would make
    // the row its own baseline for the end-of-day guard.
    const report = recompose(db, {
      today,
      blocks,
      deletedBlockIds: absorbed,
      manualPlacementBlockId: blockId,
    });
    return settled(blockId, block.projectId, report, [], today, dayOf, db);
  });
}

/** The slot this decides is still open to `resolveManualPlacement`'s slide. */
function pinsTheRow(
  date: string,
  startMinutes: number,
  durationMinutes: number,
  dayOf: (date: string) => ReturnType<typeof getDayConfig>,
): boolean {
  const config = dayOf(date);
  return dropLandsLiterally({
    // The row's own padlock is the caller's business: it is added, never removed.
    fixed: false,
    role: config.role,
    closed: config.isClosed,
    periods: config.periods,
    manualWindows: config.manualWindows,
    startMinutes,
    durationMinutes,
  });
}

export interface ResizeBlockInput {
  /** The row's new net working minutes. */
  durationMinutes: number;
  /**
   * The owner's answer to "these freed hours have nowhere to go". Send it only after a 409
   * `shrink-needs-choice`, with one of the `choices` that refusal listed. Leaving it out
   * asks.
   */
  freedHours?: FreedHoursChoice;
  today?: string;
}

/**
 * A transfer inside the job. Enlarging the last (or only) block is the one case that raises
 * `total_hours`, so it is the only one that names the project in `grownProjectIds`.
 */
export function resizeBlock(blockId: string, input: ResizeBlockInput, db: Db = getDb()): BlockMutation {
  const today = input.today ?? todayLocal();

  return runTransaction(db, () => {
    const block = requireBlock(blockId, db);
    assertNotPast(block.date, today, { blockId });
    const edit = requireEdit(
      resizeBlockHours(listBlocks(db), {
        blockId,
        durationMinutes: input.durationMinutes,
        today,
        // Measured and cut over the MANUAL WINDOWS, margins included.
        day: getDayConfig(block.date, db),
        freedHours: input.freedHours,
        newBlockId: newId,
        now: nowTimestamp(),
      }),
    );

    if (edit.totalMinutesDelta !== 0) {
      const project = findProject(block.projectId, db);
      if (project === undefined) {
        throw notFound('project-not-found', ERROR_MESSAGE_KEYS.projectNotFound, {
          details: { projectId: block.projectId },
        });
      }
      updateProject(block.projectId, { totalMinutes: project.totalMinutes + edit.totalMinutesDelta }, db);
    }

    const report = recompose(db, {
      today,
      blocks: edit.blocks,
      deletedBlockIds: edit.deletedBlockIds,
      grownProjectIds: edit.totalMinutesDelta > 0 ? [block.projectId] : undefined,
    });

    return settled(
      blockId,
      block.projectId,
      report,
      edit.touchedLockedBlockIds,
      today,
      dayConfigResolver(db),
      db,
    );
  });
}

export function setBlockLock(
  blockId: string,
  locked: boolean,
  options: { today?: string } = {},
  db: Db = getDb(),
): BlockMutation {
  const today = options.today ?? todayLocal();

  return runTransaction(db, () => {
    const block = requireBlock(blockId, db);
    assertNotPast(block.date, today, { blockId });
    setBlockLocked(blockId, locked, db);
    // No `manualPlacementBlockId`: the padlock changes no geometry, so it cannot overlap.
    const report = recompose(db, { today });
    return settled(blockId, block.projectId, report, [], today, dayConfigResolver(db), db, {
      // Written before the reflow reads its baseline, so the reflow itself never reports it.
      wrote: block.locked !== locked,
    });
  });
}

export interface SplitBlockInput {
  /** The portion to move out of this row. Must be less than the row's duration. */
  durationMinutes: number;
  /** Where the portion is dropped. Its queue rank, not necessarily its final time. */
  date: string;
  startMinutes: number;
  today?: string;
}

/**
 * A portion leaves the row and becomes a new row of the same job at the drop point, so
 * `total_hours` does not move.
 */
export function splitBlock(blockId: string, input: SplitBlockInput, db: Db = getDb()): BlockMutation {
  const today = input.today ?? todayLocal();

  return runTransaction(db, () => {
    const block = requireBlock(blockId, db);
    assertNotPast(block.date, today, { blockId });
    assertNotPastTarget(input.date, today);

    const dayOf = dayConfigResolver(db);
    const landing = dropLanding({
      date: input.date,
      startMinutes: input.startMinutes,
      durationMinutes: input.durationMinutes,
      fixed: block.locked,
      dayOf: (date) => landingDay(date, dayOf, today),
    });
    const pinned =
      block.locked ||
      pinsTheRow(landing.date, landing.startMinutes, input.durationMinutes, dayOf);
    if (pinned) assertFitsInDay(landing.startMinutes, input.durationMinutes);
    if (input.durationMinutes >= block.durationMinutes) {
      throw conflict('split-exceeds-block', ERROR_MESSAGE_KEYS.splitExceedsBlock, {
        field: 'durationMinutes',
        details: { blockId, durationMinutes: block.durationMinutes },
      });
    }
    if (
      input.durationMinutes < MIN_ROW_MINUTES ||
      block.durationMinutes - input.durationMinutes < MIN_ROW_MINUTES
    ) {
      throw conflict('split-below-minimum', ERROR_MESSAGE_KEYS.splitBelowMinimum, {
        field: 'durationMinutes',
        details: {
          blockId,
          durationMinutes: block.durationMinutes,
          minimumMinutes: MIN_ROW_MINUTES,
        },
      });
    }

    const now = nowTimestamp();
    const fragmentId = newId();
    const draft: Block[] = listBlocks(db).map((row) =>
      row.id === blockId
        ? {
            ...row,
            durationMinutes: row.durationMinutes - input.durationMinutes,
          }
        : row,
    );
    draft.push({
      id: fragmentId,
      projectId: block.projectId,
      date: landing.date,
      startMinutes: landing.startMinutes,
      durationMinutes: input.durationMinutes,
      locked: pinned,
      createdAt: now,
      updatedAt: now,
    });

    const report = recompose(db, { today, blocks: draft, manualPlacementBlockId: fragmentId });
    return settled(blockId, block.projectId, report, [], today, dayOf, db, {
      placedBlockId: fragmentId,
    });
  });
}

/**
 * These hours leave the job, so `total_hours` drops by the row's duration. Refused on a
 * job's ONLY block: the invariant leaves nowhere to park hours off the calendar.
 */
export function deleteBlock(
  blockId: string,
  options: { today?: string } = {},
  db: Db = getDb(),
): { projectId: string; summary: ScheduleSummary } {
  const today = options.today ?? todayLocal();

  return runTransaction(db, () => {
    const block = requireBlock(blockId, db);
    assertNotPast(block.date, today, { blockId });
    const own = listBlocksByProject(block.projectId, db);
    if (own.length <= 1) {
      throw conflict('delete-last-block', ERROR_MESSAGE_KEYS.deleteLastBlock, {
        details: { blockId, projectId: block.projectId },
      });
    }

    const project = findProject(block.projectId, db);
    if (project === undefined) {
      throw notFound('project-not-found', ERROR_MESSAGE_KEYS.projectNotFound, {
        details: { projectId: block.projectId },
      });
    }
    updateProject(
      block.projectId,
      { totalMinutes: project.totalMinutes - block.durationMinutes },
      db,
    );

    const report = recompose(db, {
      today,
      blocks: listBlocks(db).filter((row) => row.id !== blockId),
      deletedBlockIds: [blockId],
    });

    return { projectId: block.projectId, summary: report.summary };
  });
}

function requireBlock(blockId: string, db: Db): Block {
  const block = findBlock(blockId, db);
  if (block === undefined) {
    throw notFound('block-not-found', ERROR_MESSAGE_KEYS.blockNotFound, { details: { blockId } });
  }
  return block;
}

function assertNotPast(date: string, today: string, details: Record<string, unknown>): void {
  if (compareDates(date, today) >= 0) return;
  throw conflict('past-block-frozen', ERROR_MESSAGE_KEYS.pastBlockFrozen, {
    details: { ...details, date, today },
  });
}

/**
 * Here rather than in the resolver because `dayReflows` needs `today`, which a day
 * configuration knows nothing about.
 */
function landingDay(
  date: string,
  dayOf: (date: string) => DayConfig,
  today: string,
): DropDay {
  const config = dayOf(date);
  return {
    periods: config.periods,
    manualWindows: config.manualWindows,
    reflows: dayReflows(config, date, today),
    role: config.role,
    closed: config.isClosed,
  };
}

function assertNotPastTarget(date: string, today: string): void {
  if (compareDates(date, today) >= 0) return;
  throw conflict('drop-onto-past-day', ERROR_MESSAGE_KEYS.dropOntoPastDay, {
    field: 'date',
    details: { date, today },
  });
}

function settled(
  blockId: string,
  projectId: string,
  report: RecomposeReport,
  touchedLockedBlockIds: string[],
  today: string,
  dayOf: (date: string) => DayConfig,
  db: Db,
  options: {
    /** The row whose hours the gesture moved, when it is not the row the request named. */
    placedBlockId?: string;
    /** The request wrote something the RECOMPOSITION cannot see: a mark set before it ran. */
    wrote?: boolean;
  } = {},
): BlockMutation {
  const placed = findBlock(options.placedBlockId ?? blockId, db);
  return {
    block: findBlock(blockId, db) ?? null,
    blocks: listBlocksByProject(projectId, db),
    summary: report.summary,
    placedBlockIds:
      placed === undefined
        ? []
        : unitOf(report.blocks, placed, (date) => dayOf(date).manualWindows, today).map(
            (row) => row.id,
          ),
    changed: (options.wrote ?? false) || report.changed,
    touchedLockedBlockIds,
    mergedBlockIds: report.mergedBlockIds,
    displacedProjectIds: report.displacedProjectIds,
  };
}

function requireEdit(result: ReturnType<typeof resizeBlockHours>): EditSuccess {
  if (!result.ok) {
    throw conflict(result.error.code, result.error.messageKey, {
      details: {
        ...(result.error.projectId === undefined ? {} : { projectId: result.error.projectId }),
        ...(result.error.blockId === undefined ? {} : { blockId: result.error.blockId }),
        // Minutes only: the dialog formats them, and a second spelling would collide with the
        // REQUEST's `freedHours`, which is an answer rather than an amount.
        ...(result.error.freedMinutes === undefined ? {} : { freedMinutes: result.error.freedMinutes }),
        ...(result.error.choices === undefined ? {} : { choices: result.error.choices }),
      },
    });
  }
  return result;
}
