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

export interface CreationOutcome {
  startDate: string;
  day: StartDateDay;
  mode: CreationMode;
  /** Every row of the job was locked: the date is beyond the last occupied day. */
  autoLock: boolean;
  /** The rows on that day were padlocked: the engine would never use it (buffer, weekend). */
  dayLock: boolean;
  /** The floor was not binding, so the job starts later than the day chosen. */
  deferred: boolean;
  startsOn: string | null;
  endsOn: string | null;
}

export interface ProjectMutation {
  project: Project;
  /** The job's rows after the recomposition, in queue order. */
  blocks: Block[];
  summary: ScheduleSummary;
  /** Locked rows the LIFO transfer had to touch. Never silent. */
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
   * where the rows are born and nothing else.
   */
  startDate?: string;
  /** The owner disagreed with the deferral: use that day and push what follows. */
  force?: boolean;
  today?: string;
}

/**
 * The whole estimate is handed to `changeProjectMinutes` for a project with no rows — the
 * same path the hour stepper uses, so "created" and "grown by its full estimate" cannot
 * place hours differently. `newProjectIds` is what keeps the job off Friday. With a start
 * date the rows come from `planCreation`, the same function the preview endpoint renders,
 * so the form cannot promise a placement this write will not perform.
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

export interface CreationPreviewRow {
  date: string;
  startMinutes: number;
  durationMinutes: number;
  /** Padlocked: either every row (`autoLock`) or this one because of its day (`dayLock`). */
  locked: boolean;
}

export interface CreationPreviewCollision extends CreationCollision {
  projectName: string;
}

/** What the create form is told BEFORE it saves. Numbers and flags only; wording is i18n. */
export interface CreationPreview {
  today: string;
  startDate: string;
  totalMinutes: number;
  force: boolean;
  day: StartDateDay;
  mode: CreationMode;
  autoLock: boolean;
  dayLock: boolean;
  /** The buffer and the weekend are honoured only after the owner confirms. */
  needsDayConfirmation: boolean;
  deferred: boolean;
  canForce: boolean;
  startsOn: string | null;
  endsOn: string | null;
  rows: CreationPreviewRow[];
  /** The days the collisions were measured over: the span the job would occupy THAT day. */
  span: { startDate: string; endDate: string } | null;
  collisions: CreationPreviewCollision[];
  /** Auto days with no work at all, from that day onwards — the alternatives. */
  freeDates: string[];
  lastOccupiedDate: string | null;
}

export interface PreviewCreationInput {
  startDate: string;
  totalMinutes: number;
  force?: boolean;
  today?: string;
}

/**
 * Writes NOTHING and opens no transaction: the same `planCreation` the POST uses, on the
 * same snapshot, with a throwaway project id. A refusal is the 409 the save would throw.
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

    // Set to what the owner typed, not incremented: `totalMinutesDelta` equals `deltaMinutes`
    // for this transform, and `recompose`'s invariant assertion proves the two agree.
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
   * Decides the wording of the gaps the job's past rows leave behind, and only that —
   * those sentences become stored user data. Spanish by default.
   */
  language?: string;
}

export interface ProjectDeletion {
  summary: ScheduleSummary;
  /** The gaps that replaced the job's PAST rows, one per row. Editable like any other. */
  preservedGapIds: string[];
}

/**
 * FUTURE blocks go through `ON DELETE CASCADE`; PAST rows become gaps first, so nothing
 * moves there at all. Each gap's reason is composed while the job still exists —
 * afterwards there is nowhere to look the name up.
 *
 * No intent is passed to `recompose`: freeing space is not growth, so work is pulled back
 * into Mon-Thu, including off Friday, and nothing new is pushed onto the colchón.
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

export function readProject(projectId: string, db: Db = getDb()): { project: Project; blocks: Block[] } {
  const project = findProject(projectId, db);
  if (project === undefined) {
    throw notFound('project-not-found', ERROR_MESSAGE_KEYS.projectNotFound, { details: { projectId } });
  }
  return { project, blocks: listBlocksByProject(projectId, db) };
}

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
