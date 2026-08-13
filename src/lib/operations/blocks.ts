/**
 * Block operations: the four gestures the calendar offers on a row.
 *
 * | gesture                  | what it means                                        |
 * |--------------------------|------------------------------------------------------|
 * | drag the body            | reorder the queue (or pin the day), then reflow       |
 * | drag the bottom edge     | a transfer of hours inside the job                    |
 * | padlock                  | toggle the only exemption from auto-move              |
 * | scissors                 | move a portion of the job out of this row             |
 *
 * The one thing to hold on to while reading: on the days the engine auto-fills, a drag
 * DOES NOT PIN a block. CLAUDE.md is explicit — "Dragging a block reorders the queue —
 * it does not pin the block", and "a dropped block does not stay at the exact time it
 * was dropped at. It keeps that position in the sequence and then settles contiguously
 * after the preceding block." So a move writes the drop point as the row's QUEUE RANK
 * and lets the reflow settle it. To nail a row to a time, lock it.
 *
 * The exception is the one place a rank means nothing: the Friday buffer and the
 * weekend, where the reflow's only possible answer to a hand drop is to undo it. There
 * the drop pins (`handPlaced`) — see `moveBlock`.
 */

import { getDb, type Db } from '../db';
import { assertFitsInDay } from '../validation';
import { todayLocal } from '../dates';
import { segmentDroppedRow } from '../dropSegments';
import { usesManualOnlyTime } from '../manualWindow';
import {
  releaseBlock as releaseBlockMarks,
  resizeBlock as resizeBlockHours,
  type EditSuccess,
  type ScheduleSummary,
} from '../composition';
import { conflict, notFound, ERROR_MESSAGE_KEYS } from '../errors';
import { newId } from '../ids';
import { nowTimestamp } from '../timestamps';
import { getDayConfig, recompose, runTransaction, type RecomposeReport } from '../scheduler';
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
  /**
   * Rows of the dropped row's OWN job that the drop absorbed, because it overlapped
   * them on a day the engine may not reflow (the weekend, the frozen past). The
   * hours were summed, never unioned, so nothing was lost. Empty for every gesture
   * that is not a drop.
   */
  mergedBlockIds: string[];
  /**
   * Jobs whose row the drop cut in two, the tail pushed to just after the dropped
   * row. Their totals are unchanged. Tell the owner: "if the user does not want it,
   * they move it again" only works if they are told it happened.
   */
  displacedProjectIds: string[];
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
 * colchón.
 *
 * ON A MON-THU DAY the drop RE-RANKS, it does not pin: the row settles contiguously
 * after whatever precedes it, and to nail it to a time the owner locks it. That is a
 * decision the owner made deliberately, and it is unchanged.
 *
 * ON THE FRIDAY BUFFER OR THE WEEKEND it PINS, via `handPlaced` — because there the
 * reflow's only possible answer is to undo it. Friday is in the movable pool so the
 * engine can park growth overflow there and take it back when Mon-Thu frees up; the
 * cost was that a hand drop onto Friday was pulled straight back and the request
 * answered 200 with nothing changed. The mark is what tells the two apart, and the
 * weekend gets it too so "a human put this here" means one thing on every day the
 * engine would otherwise have recovered from.
 *
 * Dropping the row back onto Mon-Thu CLEARS the mark: the same gesture that sets it
 * takes it away, and *back to automatic* is the one-click alternative.
 *
 * A DROP INTO A VISUAL MARGIN (or into the lunch band) PINS TOO, on any day — see
 * `pinsTheRow`. It used to be accepted and then quietly pulled back into the working
 * periods by this very recomposition, so a margin drop only stuck if the row happened to
 * be locked, and CLAUDE.md's promise that the margins "accept manual drag-drop" was not
 * true of any gesture the owner could make. The margins are hand time; the engine cannot
 * represent them; so the row stays where it was dropped and the reflow flows around it.
 *
 * `manualPlacementBlockId` is what stops the drop leaving a silent overlap where the
 * reflow cannot reach — the weekend, the frozen past, and now a hand-placed Friday row.
 * Same job: one row, hours summed. Another job: cut, tail pushed after the drop. A
 * lock: refused, 409. And the drop is stored in segments, never across the lunch break.
 */
export function moveBlock(blockId: string, input: MoveBlockInput, db: Db = getDb()): BlockMutation {
  const today = input.today ?? todayLocal();

  return runTransaction(db, () => {
    const block = requireBlock(blockId, db);
    // The row keeps its duration, so the drop point has to leave room for it: a
    // block is a solid rectangle inside one day and cannot run past midnight.
    assertFitsInDay(input.startMinutes, block.durationMinutes);
    updateBlock(
      {
        ...block,
        date: input.date,
        startMinutes: input.startMinutes,
        handPlaced: pinsTheRow(input.date, input.startMinutes, block.durationMinutes, db),
      },
      db,
    );
    const report = recompose(db, { today, manualPlacementBlockId: blockId });
    return settled(blockId, block.projectId, report, [], db);
  });
}

/**
 * Whether a drop pins the row where it landed.
 *
 * The policy the engine's `handPlaced` flag is the mechanism for, in one place. Two
 * reasons, and both are "the reflow's only possible answer here would be to undo the
 * drop":
 *
 * - THE DAY. The Friday buffer and the weekend are the days whose whole point is that the
 *   engine does not decide what sits there, so they keep exactly what the owner dropped.
 *   A day the engine auto-fills (Mon-Thu) takes a drop as a queue rank instead.
 * - THE SLOT. A drop into MANUAL-ONLY TIME — a visual margin, or the lunch band — on any
 *   day. CLAUDE.md promises the margins accept manual drag-drop, and the engine's index
 *   space has no margin minutes in it at all: an unpinned margin row is pulled straight
 *   back inside the periods, which is why the margins were configurable and unusable. The
 *   drop is cut over the manual windows first, so the test is asked of the rows that will
 *   really be stored.
 */
function pinsTheRow(
  date: string,
  startMinutes: number,
  durationMinutes: number,
  db: Db,
): boolean {
  const config = getDayConfig(date, db);
  if (config.role !== 'auto') return true;
  return usesManualOnlyTime(
    config.periods,
    segmentDroppedRow(config.manualWindows, { startMinutes, durationMinutes }),
  );
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
 *
 * IT WORKS ON EVERY ROW, and it did not use to. The transfer was applied and then
 * quietly undone by the recomposition that follows it, because `compose` re-derives
 * a job's segmentation from its total — so on an unlocked weekday row the request
 * answered 200 with the block unchanged. The engine now stores the intent
 * (`manualDuration`), keeps the length through the reflow, and ends the job's run
 * there. The refusals stay refusals: shrinking a job's last (or only) row is a 409
 * carrying `errors.shrinkLastBlock`, never a silent no-op.
 *
 * `durationMinutes` is NET working minutes over the day's MANUAL WINDOWS, counted from the
 * row's own start — so the drag crosses the lunch break and may reach into the visual
 * margins, and the engine stores the result in segments. A row starting at 10:00 sized to
 * 6 h comes back as `10:00-14:00` plus `15:30-17:30`.
 */
export function resizeBlock(blockId: string, input: ResizeBlockInput, db: Db = getDb()): BlockMutation {
  const today = input.today ?? todayLocal();

  return runTransaction(db, () => {
    const block = requireBlock(blockId, db);
    const edit = requireEdit(
      resizeBlockHours(listBlocks(db), {
        blockId,
        durationMinutes: input.durationMinutes,
        today,
        // Both views of the row's day: the stretch is measured and cut over the manual
        // windows, and the margins are what tell it to pin the row.
        day: getDayConfig(block.date, db),
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

    return settled(blockId, block.projectId, report, edit.touchedLockedBlockIds, db);
  });
}

/**
 * "Back to automatic": the row gives the engine back its LENGTH and its DAY — both
 * marks a hand gesture can leave on it (`manualDuration`, `handPlaced`).
 *
 * The counterpart of the resize and of a drop onto the buffer, and not a nicety. Both
 * marks are decisions the engine then obeys for ever, and the only way either one shows
 * is that the row stops reflowing — so without a one-click release the owner cannot
 * undo them and they accumulate until the engine manages nothing. One action for both,
 * because pressing the wrong one of two would leave a row that still would not move.
 *
 * Releasing changes no geometry itself; the recomposition that follows is what
 * re-derives the job's segmentation, closes the day a hand-set stretch was holding open,
 * and pulls a released Friday row back into Monday-Thursday.
 *
 * No intent is passed: giving hours back to the engine is not growth, so it must not
 * spend the Friday colchón.
 */
export function releaseBlock(
  blockId: string,
  options: { today?: string } = {},
  db: Db = getDb(),
): BlockMutation {
  const today = options.today ?? todayLocal();

  return runTransaction(db, () => {
    const block = requireBlock(blockId, db);
    const edit = requireEdit(releaseBlockMarks(listBlocks(db), blockId));
    const report = recompose(db, { today, blocks: edit.blocks });
    return settled(blockId, block.projectId, report, [], db);
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
    // No `manualPlacementBlockId`: the padlock changes no geometry, so it cannot
    // create an overlap. A row that was unlocked was reflowed clear of everything,
    // and locking it leaves it exactly there.
    const report = recompose(db, { today });
    return settled(blockId, block.projectId, report, [], db);
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
 *
 * The FRAGMENT is the dropped row, so it is the one whose overlaps are resolved:
 * splitting 2 h onto a Saturday the job already occupies merges the two into one
 * row of the summed hours instead of leaving them stacked.
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
    const fragmentId = newId();
    const draft: Block[] = listBlocks(db).map((row) =>
      row.id === blockId
        ? {
            ...row,
            durationMinutes: row.durationMinutes - input.durationMinutes,
            // The scissors rewrite the source row's length, so a hand-set length on
            // it no longer stands for anything: the engine takes the row back.
            manualDuration: false,
          }
        : row,
    );
    draft.push({
      id: fragmentId,
      projectId: block.projectId,
      date: input.date,
      startMinutes: input.startMinutes,
      durationMinutes: input.durationMinutes,
      locked: block.locked,
      // A fragment's length is the portion the owner chose to MOVE, not a length
      // drawn on the calendar; `locked` is what pins a fragment to a slot.
      manualDuration: false,
      // The fragment IS the drop, so it follows the same rule a move does: pinned on
      // the buffer, on the weekend and in manual-only time, an ordinary queue rank
      // anywhere Monday to Thursday the engine can reach.
      handPlaced: pinsTheRow(input.date, input.startMinutes, input.durationMinutes, db),
      createdAt: now,
      updatedAt: now,
    });

    const report = recompose(db, { today, blocks: draft, manualPlacementBlockId: fragmentId });
    return settled(blockId, block.projectId, report, [], db);
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
  report: RecomposeReport,
  touchedLockedBlockIds: string[],
  db: Db,
): BlockMutation {
  return {
    block: findBlock(blockId, db) ?? null,
    blocks: listBlocksByProject(projectId, db),
    summary: report.summary,
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
      },
    });
  }
  return result;
}
