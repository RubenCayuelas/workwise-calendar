/**
 * Block operations: the four gestures the calendar offers on a row.
 *
 * | gesture                  | what it means                                        |
 * |--------------------------|------------------------------------------------------|
 * | drag the body            | reorder the queue, then reflow                        |
 * | drag the bottom edge     | a transfer of hours inside the job                    |
 * | padlock                  | toggle the only exemption from auto-move              |
 * | scissors                 | move a portion of the job out of this row             |
 *
 * The one thing to hold on to while reading: a drag DOES NOT PIN a block.
 * CLAUDE.md is explicit — "Dragging a block reorders the queue — it does not pin
 * the block", and "a dropped block does not stay at the exact time it was dropped
 * at. It keeps that position in the sequence and then settles contiguously after
 * the preceding block." So a move writes the drop point as the row's QUEUE RANK
 * and lets the reflow settle it. To nail a row to a time, lock it.
 */

import { getDb, type Db } from '../db';
import { assertFitsInDay } from '../validation';
import { todayLocal } from '../dates';
import { resizeBlock as resizeBlockHours, type EditSuccess, type ScheduleSummary } from '../composition';
import { conflict, notFound, ERROR_MESSAGE_KEYS } from '../errors';
import { newId } from '../ids';
import { nowTimestamp } from '../timestamps';
import { recompose, runTransaction } from '../scheduler';
import {
  findBlock,
  listBlocks,
  listBlocksByProject,
  setBlockLocked,
  updateBlock,
} from '../repositories/blocks';
import { findProject, updateProject } from '../repositories/projects';
import type { Block } from '../../types';

/**
 * What every block mutation answers with.
 *
 * `block` is nullable on purpose: auto-merge can absorb the row that was edited
 * into a neighbouring row of the same job, in which case the id the request named
 * no longer exists. `blocks` is then the honest answer — the job's rows as they
 * now stand.
 */
export interface BlockMutation {
  block: Block | null;
  /** Every row of the block's job after the recomposition, in queue order. */
  blocks: Block[];
  summary: ScheduleSummary;
  /** Locked rows a transfer had to touch. Never silent — see CLAUDE.md. */
  touchedLockedBlockIds: string[];
}

export interface MoveBlockInput {
  date: string;
  startMinutes: number;
  today?: string;
}

/**
 * A drop. Writes the new queue rank and reflows.
 *
 * No intent is passed: a drag is not growth, so it must not spend the Friday
 * colchón. Dropping ONTO Friday still works — the row is already dated there when
 * the engine runs, and a buffer day accepts an item that is already on it — which
 * is what stops an unrelated save from shoving it into next week.
 *
 * A drop into a visual margin, or onto a weekend, is accepted as-is; note that an
 * UNLOCKED row dropped into a margin is pulled back into the working periods by
 * this very recomposition, so a margin drop only sticks if the row is also locked.
 * That is margins ("manual drag-drop only") meeting the movable pool, not a bug.
 */
export function moveBlock(blockId: string, input: MoveBlockInput, db: Db = getDb()): BlockMutation {
  const today = input.today ?? todayLocal();

  return runTransaction(db, () => {
    const block = requireBlock(blockId, db);
    // The row keeps its duration, so the drop point has to leave room for it: a
    // block is a solid rectangle inside one day and cannot run past midnight.
    assertFitsInDay(input.startMinutes, block.durationMinutes);
    updateBlock({ ...block, date: input.date, startMinutes: input.startMinutes }, db);
    const report = recompose(db, { today });
    return settled(blockId, block.projectId, report.summary, [], db);
  });
}

export interface ResizeBlockInput {
  /** The row's new net working minutes. */
  durationMinutes: number;
  today?: string;
}

/**
 * A bottom-edge drag: a transfer inside the job, with its last block as the
 * counterparty. `resizeBlock` in src/lib/composition.ts owns the four-case table;
 * all that happens here is applying its verdict.
 *
 * `total_hours` moves only when the engine says it does — enlarging the last (or
 * only) block has nothing farther to draw from, so the estimate grows. That is the
 * one case that can generate overflow, and therefore the only one that names the
 * project in `grownProjectIds`: a pure transfer takes hours OFF the job's furthest
 * row, which relieves pressure on the week instead of adding to it.
 */
export function resizeBlock(blockId: string, input: ResizeBlockInput, db: Db = getDb()): BlockMutation {
  const today = input.today ?? todayLocal();

  return runTransaction(db, () => {
    const block = requireBlock(blockId, db);
    const edit = requireEdit(resizeBlockHours(listBlocks(db), { blockId, durationMinutes: input.durationMinutes }));

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

    return settled(blockId, block.projectId, report.summary, edit.touchedLockedBlockIds, db);
  });
}

/**
 * The padlock. `locked` is the only exemption from auto-move, so toggling it moves
 * the row into or out of the movable pool and the rest of the calendar reflows
 * around the result. Locking never fails: "a locked block can never make placement
 * fail", because overflow always chains forward.
 */
export function setBlockLock(
  blockId: string,
  locked: boolean,
  options: { today?: string } = {},
  db: Db = getDb(),
): BlockMutation {
  const today = options.today ?? todayLocal();

  return runTransaction(db, () => {
    const block = requireBlock(blockId, db);
    setBlockLocked(blockId, locked, db);
    const report = recompose(db, { today });
    return settled(blockId, block.projectId, report.summary, [], db);
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
 * The scissors: "User can move a portion of a job (fragment it) or the entire
 * block." The source row shrinks, the portion becomes a new row of the same job at
 * the drop point, and `total_hours` does not move — no hours are created or
 * destroyed, so this is a placement change, not an edit.
 *
 * Taking the WHOLE row is refused rather than silently treated as a move: the
 * caller has `PATCH /api/blocks/:id` with `action: "move"` for that, and a split
 * that leaves nothing behind would delete the row the user was aiming at.
 *
 * The fragment inherits the source's `locked` flag, because splitting is not a
 * decision about mobility. A fragment of an unlocked row is therefore reflowed
 * away from the exact drop time, exactly like any other drop.
 */
export function splitBlock(blockId: string, input: SplitBlockInput, db: Db = getDb()): BlockMutation {
  const today = input.today ?? todayLocal();

  return runTransaction(db, () => {
    const block = requireBlock(blockId, db);
    assertFitsInDay(input.startMinutes, input.durationMinutes);
    if (input.durationMinutes >= block.durationMinutes) {
      throw conflict('split-exceeds-block', ERROR_MESSAGE_KEYS.splitExceedsBlock, {
        field: 'durationMinutes',
        details: { blockId, durationMinutes: block.durationMinutes },
      });
    }

    const now = nowTimestamp();
    const draft: Block[] = listBlocks(db).map((row) =>
      row.id === blockId ? { ...row, durationMinutes: row.durationMinutes - input.durationMinutes } : row,
    );
    draft.push({
      id: newId(),
      projectId: block.projectId,
      date: input.date,
      startMinutes: input.startMinutes,
      durationMinutes: input.durationMinutes,
      locked: block.locked,
      createdAt: now,
      updatedAt: now,
    });

    const report = recompose(db, { today, blocks: draft });
    return settled(blockId, block.projectId, report.summary, [], db);
  });
}

/**
 * The hover bar's delete: these hours leave the job, so `total_hours` drops by the
 * row's duration and the calendar closes the hole.
 *
 * Deleting a job's ONLY block is refused. The invariant leaves nowhere to park
 * hours off the calendar, so it would either strand a job with an estimate and no
 * rows or silently delete the job; deleting the job is a separate, confirmed action
 * (`DELETE /api/projects/:id`), and this points at it.
 */
export function deleteBlock(
  blockId: string,
  options: { today?: string } = {},
  db: Db = getDb(),
): { projectId: string; summary: ScheduleSummary } {
  const today = options.today ?? todayLocal();

  return runTransaction(db, () => {
    const block = requireBlock(blockId, db);
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

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function requireBlock(blockId: string, db: Db): Block {
  const block = findBlock(blockId, db);
  if (block === undefined) {
    throw notFound('block-not-found', ERROR_MESSAGE_KEYS.blockNotFound, { details: { blockId } });
  }
  return block;
}

/** Re-reads the row the request named, which the reflow may have merged away. */
function settled(
  blockId: string,
  projectId: string,
  summary: ScheduleSummary,
  touchedLockedBlockIds: string[],
  db: Db,
): BlockMutation {
  return {
    block: findBlock(blockId, db) ?? null,
    blocks: listBlocksByProject(projectId, db),
    summary,
    touchedLockedBlockIds,
  };
}

function requireEdit(result: ReturnType<typeof resizeBlockHours>): EditSuccess {
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
