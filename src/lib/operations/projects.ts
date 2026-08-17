/**
 * Job operations: create, edit, delete.
 *
 * Each function is one API mutation, wrapped in one transaction, ending in one
 * recomposition. The hours arithmetic is never done here — `changeProjectMinutes`
 * in src/lib/composition.ts owns the LIFO rule, and this module's whole job is to
 * hand it the calendar, apply its verdict and keep `projects.total_hours` in step
 * with the rows it produced.
 */

import { getDb, type Db } from '../db';
import { compareDates, todayLocal } from '../dates';
import { changeProjectMinutes, type EditSuccess } from '../composition';
import type { ScheduleSummary } from '../composition';
import {
  planCreation,
  type CreationCollision,
  type CreationMode,
  type CreationResult,
  type StartDateDay,
} from '../creation';
import { conflict, notFound, ERROR_MESSAGE_KEYS } from '../errors';
import { newId } from '../ids';
import { nowTimestamp } from '../timestamps';
import { composeInputOf, readSnapshot, recompose, readSummary, runTransaction } from '../scheduler';
import { deletedJobGapReason } from '../text';
import { insertGap } from '../repositories/gaps';
import { listBlocks, listBlocksByProject } from '../repositories/blocks';
import {
  deleteProject as deleteProjectRow,
  findProject,
  insertProject,
  listProjectLabels,
  updateProject,
} from '../repositories/projects';
import type { Block, Project } from '../../types';

/**
 * What became of a creation that named a start date — the same facts the form was
 * shown BEFORE saving, so the notice afterwards can repeat them without guessing.
 * Absent when no start date was given.
 */
export interface CreationOutcome {
  startDate: string;
  day: StartDateDay;
  mode: CreationMode;
  /** Every row of the job was locked: the date is beyond the last occupied day. */
  autoLock: boolean;
  /** The rows on that day were padlocked, because the engine would never use it (the
   * buffer, or the weekend). */
  dayLock: boolean;
  /** The floor was not binding, so the job starts later than the day chosen. */
  deferred: boolean;
  startsOn: string | null;
  endsOn: string | null;
}

/** What every job mutation answers with. */
export interface ProjectMutation {
  project: Project;
  /** The job's rows after the recomposition, in queue order. */
  blocks: Block[];
  summary: ScheduleSummary;
  /**
   * Locked rows the LIFO transfer had to touch because the job had no unlocked
   * hours left. CLAUDE.md: "A locked block is never grown or shrunk silently" — so
   * these come back for the UI to mention rather than be swallowed.
   */
  touchedLockedBlockIds: string[];
  /** Only on a creation that named a start date. */
  placement?: CreationOutcome;
}

export interface CreateProjectInput {
  name: string;
  description?: string;
  /** A `PROJECT_COLORS` swatch, already normalised by the route. */
  color: string;
  totalMinutes: number;
  /**
   * The optional floor the owner chose: "not before this day". NOT STORED — it decides
   * where the rows are born and nothing else; `src/lib/creation.ts` owns the rule, and
   * the automatic lock is what survives where a date has to. Omit it for the ordinary
   * "append to the end of the queue" creation.
   */
  startDate?: string;
  /**
   * The owner disagreed with the deferral: place the job on that day and push what
   * follows. Only meaningful together with `startDate`.
   */
  force?: boolean;
  today?: string;
}

/**
 * Creates a job and places its hours at the END of the queue.
 *
 * "Appended after the last existing block. Creation order therefore sets the
 * initial position." The append is done by handing the whole estimate to
 * `changeProjectMinutes` for a project that has no rows yet: it invents a single
 * provisional block ranked after everything on the calendar, pulled into the
 * movable pool if the tail happens to be a weekend. That is the same code path the
 * job form's hour stepper uses, so "created" and "grown by its full estimate" can
 * never place hours differently.
 *
 * `newProjectIds` is what keeps the job off Friday: a new job fills Mon-Thu and, if
 * it does not fit, skips the buffer for next week's Monday.
 *
 * WITH A START DATE (`input.startDate`) the rows come from `planCreation` instead — the
 * same function the preview endpoint renders, so the form cannot promise a placement
 * this write will not perform. The date is a FLOOR and is not stored; see
 * `src/lib/creation.ts` for the four modes and for why a job born beyond the last
 * occupied day has every one of its rows locked.
 */
export function createProject(input: CreateProjectInput, db: Db = getDb()): ProjectMutation {
  const today = input.today ?? todayLocal();

  return runTransaction(db, () => {
    const projectId = newId();
    const project = insertProject(
      {
        id: projectId,
        name: input.name,
        description: input.description,
        color: input.color,
        totalMinutes: input.totalMinutes,
      },
      db,
    );

    if (input.startDate !== undefined) {
      const plan = requirePlan(
        planCreation(composeInputOf(readSnapshot(db, today)), {
          projectId,
          minutes: input.totalMinutes,
          blockId: newId(),
          newBlockId: newId,
          now: nowTimestamp(),
          startDate: input.startDate,
          force: input.force,
        }),
      );

      const report = recompose(db, {
        today,
        blocks: plan.blocks,
        newProjectIds: [projectId],
      });

      return {
        project,
        blocks: listBlocksByProject(projectId, db),
        summary: report.summary,
        touchedLockedBlockIds: [],
        placement: {
          startDate: input.startDate,
          day: plan.decision.day,
          mode: plan.decision.mode,
          autoLock: plan.decision.autoLock,
          dayLock: plan.decision.dayLock,
          deferred: plan.deferred,
          startsOn: plan.startsOn,
          endsOn: plan.endsOn,
        },
      };
    }

    const edit = requireEdit(
      changeProjectMinutes(listBlocks(db), {
        projectId,
        deltaMinutes: input.totalMinutes,
        today,
        newBlockId: newId(),
        now: nowTimestamp(),
      }),
    );

    const report = recompose(db, {
      today,
      blocks: edit.blocks,
      deletedBlockIds: edit.deletedBlockIds,
      newProjectIds: [projectId],
    });

    return {
      project,
      blocks: listBlocksByProject(projectId, db),
      summary: report.summary,
      touchedLockedBlockIds: edit.touchedLockedBlockIds,
    };
  });
}

// ---------------------------------------------------------------------------
// The create form's preview
// ---------------------------------------------------------------------------

/** One row the job would be born as. */
export interface CreationPreviewRow {
  date: string;
  startMinutes: number;
  durationMinutes: number;
  /** Padlocked: either every row (`autoLock`) or this one because of its day (`dayLock`). */
  locked: boolean;
}

/** Work in the way, with its job's name so the form can say which job it is. */
export interface CreationPreviewCollision extends CreationCollision {
  projectName: string;
}

/**
 * What the create form is told BEFORE it saves. Numbers and flags only: the wording
 * lives in public/locales and the day names come from `useFormat()`.
 */
export interface CreationPreview {
  today: string;
  startDate: string;
  totalMinutes: number;
  force: boolean;
  day: StartDateDay;
  mode: CreationMode;
  /** Every row of the job would be locked. Mechanical — see `src/lib/creation.ts`. */
  autoLock: boolean;
  /** The rows on that day would be padlocked, because the engine would never use it. */
  dayLock: boolean;
  /** The buffer and the weekend are honoured only after the owner confirms. */
  needsDayConfirmation: boolean;
  /** The job would start later than the day chosen: the floor is not binding. */
  deferred: boolean;
  /** Forcing is worth offering. */
  canForce: boolean;
  startsOn: string | null;
  endsOn: string | null;
  rows: CreationPreviewRow[];
  /** The days the collisions were measured over: the span the job would occupy THAT day. */
  span: { startDate: string; endDate: string } | null;
  collisions: CreationPreviewCollision[];
  /** Auto days with no work at all, from that day onwards — the alternatives. */
  freeDates: string[];
  /** How far the shop is booked, so the form can say where the queue currently ends. */
  lastOccupiedDate: string | null;
}

export interface PreviewCreationInput {
  startDate: string;
  totalMinutes: number;
  force?: boolean;
  today?: string;
}

/**
 * Dry-runs a creation. Writes NOTHING and opens no transaction.
 *
 * It is the same `planCreation` the POST uses, on the same snapshot, with a throwaway
 * project id — so "where will this land" is answered by the engine rather than
 * estimated by the form. A refusal (the hours run past the planning horizon) is thrown
 * as a 409 exactly as the save would throw it, so the form shows one message either way.
 */
export function previewProjectCreation(
  input: PreviewCreationInput,
  db: Db = getDb(),
): CreationPreview {
  const today = input.today ?? todayLocal();
  const snapshot = readSnapshot(db, today);
  const composeInput = composeInputOf(snapshot);
  const projectId = newId();

  const plan = requirePlan(
    planCreation(composeInput, {
      projectId,
      minutes: input.totalMinutes,
      blockId: newId(),
      newBlockId: newId,
      now: nowTimestamp(),
      startDate: input.startDate,
      force: input.force,
    }),
  );

  const names = new Map(listProjectLabels(db).map((label) => [label.id, label.name]));

  return {
    today,
    startDate: input.startDate,
    totalMinutes: input.totalMinutes,
    force: input.force === true,
    day: plan.decision.day,
    mode: plan.decision.mode,
    autoLock: plan.decision.autoLock,
    dayLock: plan.decision.dayLock,
    needsDayConfirmation: plan.decision.needsDayConfirmation,
    deferred: plan.deferred,
    canForce: plan.canForce,
    startsOn: plan.startsOn,
    endsOn: plan.endsOn,
    rows: plan.placed.map((row) => ({
      date: row.date,
      startMinutes: row.startMinutes,
      durationMinutes: row.durationMinutes,
      locked: row.locked,
    })),
    span: plan.span,
    collisions: plan.collisions.map((collision) => ({
      ...collision,
      projectName: names.get(collision.projectId) ?? '',
    })),
    freeDates: plan.freeDates,
    lastOccupiedDate: readSummary(db, today).lastOccupiedDate,
  };
}

export interface PatchProjectInput {
  name?: string;
  /** `null` clears the description. */
  description?: string | null;
  color?: string;
  totalMinutes?: number;
  today?: string;
}

/**
 * Edits a job. Two independent halves, exactly as CLAUDE.md splits them:
 *
 * - Name, description and colour are metadata: "No impact on calendar layout or
 *   block positions." So they are written and nothing is reflowed — a rename must
 *   not be able to move a single block.
 * - `totalMinutes` goes through the LIFO rule: added hours land on the job's last
 *   unlocked block, removed hours are decremented off it, deleting any row that
 *   reaches zero and carrying on into the row before it.
 *
 * Raising the hours is the one thing that may use the Friday colchón, which is why
 * `grownProjectIds` is passed only when the delta is positive.
 */
export function patchProject(projectId: string, input: PatchProjectInput, db: Db = getDb()): ProjectMutation {
  const today = input.today ?? todayLocal();

  return runTransaction(db, () => {
    const current = findProject(projectId, db);
    if (current === undefined) {
      throw notFound('project-not-found', ERROR_MESSAGE_KEYS.projectNotFound, { details: { projectId } });
    }

    const metadataChanged =
      input.name !== undefined || input.description !== undefined || input.color !== undefined;
    if (metadataChanged) {
      updateProject(
        projectId,
        { name: input.name, description: input.description, color: input.color },
        db,
      );
    }

    const deltaMinutes =
      input.totalMinutes === undefined ? 0 : input.totalMinutes - current.totalMinutes;

    if (deltaMinutes === 0) {
      const project = findProject(projectId, db) ?? current;
      return {
        project,
        blocks: listBlocksByProject(projectId, db),
        summary: readSummary(db, today),
        touchedLockedBlockIds: [],
      };
    }

    const edit = requireEdit(
      changeProjectMinutes(listBlocks(db), {
        projectId,
        deltaMinutes,
        today,
        newBlockId: newId(),
        now: nowTimestamp(),
      }),
    );

    // The estimate is set to what the owner typed, not incremented: the engine's
    // `totalMinutesDelta` equals `deltaMinutes` for this transform, and the
    // invariant assertion inside `recompose` is what proves the two agree.
    updateProject(projectId, { totalMinutes: input.totalMinutes }, db);

    const report = recompose(db, {
      today,
      blocks: edit.blocks,
      deletedBlockIds: edit.deletedBlockIds,
      grownProjectIds: deltaMinutes > 0 ? [projectId] : undefined,
    });

    const project = findProject(projectId, db) ?? current;
    return {
      project,
      blocks: listBlocksByProject(projectId, db),
      summary: report.summary,
      touchedLockedBlockIds: edit.touchedLockedBlockIds,
    };
  });
}

export interface DeleteProjectOptions {
  today?: string;
  /**
   * The language the owner is reading the app in. It decides the wording of the gaps the
   * job's past rows leave behind, and only that — those sentences become stored user data
   * and cannot be re-translated later. Spanish when it is not given.
   */
  language?: string;
}

export interface ProjectDeletion {
  summary: ScheduleSummary;
  /**
   * The gaps that took the place of the job's PAST rows, one per row. Tell the owner:
   * the days they are on keep their shape, and the gaps are editable like any other.
   */
  preservedGapIds: string[];
}

/**
 * Deletes a job. Its FUTURE blocks go with it through `ON DELETE CASCADE` and the calendar
 * closes the hole they left; its PAST rows are turned into gaps first, so nothing moves
 * there at all.
 *
 * THE PAST IS A RECORD, AND DELETING A JOB MUST NOT REWRITE IT (decided with the owner,
 * 2026-08-13). Cascading the whole job away would free hours the shop actually worked, and
 * the reflow — which may not write to the past, but which fills forward from today —
 * would leave those days looking emptier than they were. A gap holds the time exactly
 * where the work was: same date, same start, same duration, and the same fixed occupancy a
 * padlocked row had.
 *
 * EACH GAP NAMES THE JOB IT REPLACED — `Trabajo «Barandilla» eliminado` — and the sentence
 * is COMPOSED HERE, before the row is deleted. There is nowhere to look the name up
 * afterwards: the project row is gone and its blocks went with it. See src/lib/text.ts for
 * what that costs (the wording is frozen in one language) and why it is the right trade.
 *
 * No intent is passed to `recompose`: freeing space is not growth, so the reflow pulls work
 * back into Mon-Thu — including off Friday, which is the "self-cleaning buffer" half of
 * the rule — but never pushes anything new onto the colchón.
 */
export function deleteProject(
  projectId: string,
  options: DeleteProjectOptions = {},
  db: Db = getDb(),
): ProjectDeletion {
  const today = options.today ?? todayLocal();

  return runTransaction(db, () => {
    const project = findProject(projectId, db);
    if (project === undefined) {
      throw notFound('project-not-found', ERROR_MESSAGE_KEYS.projectNotFound, { details: { projectId } });
    }

    // Composed while the job still exists, and stored as the gap's own reason.
    const reason = deletedJobGapReason(project.name, options.language);
    const preservedGapIds: string[] = [];
    for (const row of listBlocksByProject(projectId, db)) {
      if (compareDates(row.date, today) >= 0) continue;
      const gap = insertGap(
        {
          id: newId(),
          date: row.date,
          startMinutes: row.startMinutes,
          durationMinutes: row.durationMinutes,
          reason,
        },
        db,
      );
      preservedGapIds.push(gap.id);
    }

    if (!deleteProjectRow(projectId, db)) {
      throw notFound('project-not-found', ERROR_MESSAGE_KEYS.projectNotFound, { details: { projectId } });
    }
    const report = recompose(db, { today });
    return { summary: report.summary, preservedGapIds };
  });
}

/** The job panel's read: the job plus every one of its blocks, across all weeks. */
export function readProject(projectId: string, db: Db = getDb()): { project: Project; blocks: Block[] } {
  const project = findProject(projectId, db);
  if (project === undefined) {
    throw notFound('project-not-found', ERROR_MESSAGE_KEYS.projectNotFound, { details: { projectId } });
  }
  return { project, blocks: listBlocksByProject(projectId, db) };
}

/**
 * Turns an edit transform's refusal into a 409. The transform already carries an
 * i18n key, so nothing is worded here.
 */
/**
 * Turns a start-date plan's refusal into a 409, carrying everything its translation
 * interpolates. The plan already chose the i18n key — the engine's `horizon-exceeded`
 * for hours that run past the horizon — so nothing is worded here either.
 */
function requirePlan(result: CreationResult): Extract<CreationResult, { ok: true }> {
  if (!result.ok) {
    throw conflict(result.error.code, result.error.messageKey, {
      details: {
        ...(result.error.projectId === undefined ? {} : { projectId: result.error.projectId }),
        ...(result.error.unplacedMinutes === undefined
          ? {}
          : { unplacedMinutes: result.error.unplacedMinutes }),
        ...(result.error.horizonEndDate === undefined
          ? {}
          : { horizonEndDate: result.error.horizonEndDate }),
      },
    });
  }
  return result;
}

function requireEdit(result: ReturnType<typeof changeProjectMinutes>): EditSuccess {
  if (!result.ok) {
    throw conflict(result.error.code, result.error.messageKey, {
      details: {
        ...(result.error.projectId === undefined ? {} : { projectId: result.error.projectId }),
        ...(result.error.blockId === undefined ? {} : { blockId: result.error.blockId }),
      },
    });
  }
  return result;
}
