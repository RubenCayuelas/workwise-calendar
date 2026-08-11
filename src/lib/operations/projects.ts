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
import { todayLocal } from '../dates';
import { changeProjectMinutes, type EditSuccess } from '../composition';
import type { ScheduleSummary } from '../composition';
import { conflict, notFound, ERROR_MESSAGE_KEYS } from '../errors';
import { newId } from '../ids';
import { nowTimestamp } from '../timestamps';
import { recompose, readSummary, runTransaction } from '../scheduler';
import { listBlocks, listBlocksByProject } from '../repositories/blocks';
import {
  deleteProject as deleteProjectRow,
  findProject,
  insertProject,
  updateProject,
} from '../repositories/projects';
import type { Block, Project } from '../../types';

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
}

export interface CreateProjectInput {
  name: string;
  description?: string;
  /** A `PROJECT_COLORS` swatch, already normalised by the route. */
  color: string;
  totalMinutes: number;
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

/**
 * Deletes a job. Its blocks go with it through `ON DELETE CASCADE`, then the
 * calendar closes the hole they left.
 *
 * No intent is passed: freeing space is not growth, so the reflow pulls work back
 * into Mon-Thu — including off Friday, which is the "self-cleaning buffer" half of
 * the rule — but never pushes anything new onto the colchón.
 */
export function deleteProject(
  projectId: string,
  options: { today?: string } = {},
  db: Db = getDb(),
): { summary: ScheduleSummary } {
  const today = options.today ?? todayLocal();

  return runTransaction(db, () => {
    if (!deleteProjectRow(projectId, db)) {
      throw notFound('project-not-found', ERROR_MESSAGE_KEYS.projectNotFound, { details: { projectId } });
    }
    const report = recompose(db, { today });
    return { summary: report.summary };
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
