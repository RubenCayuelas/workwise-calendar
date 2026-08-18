/**
 * Block operations: the four gestures the calendar offers on a row.
 *
 * | gesture                  | what it means                                        |
 * |--------------------------|------------------------------------------------------|
 * | drag the body            | reorder the queue (or padlock the slot), then reflow  |
 * | drag the bottom edge     | a transfer of hours inside the job                    |
 * | padlock                  | toggle the only exemption from auto-move              |
 * | scissors                 | move a portion of the job out of this row             |
 *
 * NONE OF THEM REACHES A PAST DAY (decided with the owner, 2026-08-13). The past is the
 * record of what the shop did, so every gesture above is refused on a row dated before
 * today, and so is a drop AIMED at such a day — see `assertNotPast`. What is still
 * allowed is the job's own form: renaming it, changing its hours, deleting it. None of
 * those rewrites a past day, because hours added to a job whose last row is past already
 * get a row of their own on a future day (`lastAutomatic`), and deleting a job leaves its
 * past rows behind as gaps (`deleteProject`).
 *
 * The one thing to hold on to while reading: on the days the engine auto-fills, a drag
 * DOES NOT PIN a block. CLAUDE.md is explicit — "Dragging a block reorders the queue —
 * it does not pin the block", and "a dropped block does not stay at the exact time it
 * was dropped at. It keeps that position in the sequence and then settles contiguously
 * after the preceding block." So a move writes the drop point as the row's QUEUE RANK
 * and lets the reflow settle it. To nail a row to a time, lock it.
 *
 * The exception is the one place a rank means nothing: the Friday buffer, the weekend and
 * the visual margins, where the reflow's only possible answer to a hand drop is to undo
 * it. There the drop PADLOCKS the row — see `moveBlock` and `pinsTheRow`.
 */

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
  /**
   * THE ROWS THE GESTURE'S HOURS ENDED UP ON, in calendar order — the run the moved work
   * is stored as, so they can be read straight out of `blocks`.
   *
   * One id for an ordinary gesture. TWO OR MORE once the hours filled what a day had left
   * and carried on to the next day, which since *fill and overflow* is ordinary rather
   * than exceptional: 6 h dropped into a 4 h afternoon comes back as `[Monday 4 h,
   * Tuesday 2 h]`. `block` is only the first of them, so it cannot tell that story on its
   * own — and a client that reads `block` alone reports half of what happened.
   *
   * Empty when the row no longer exists (auto-merge or the overlap merge absorbed it);
   * `mergedBlockIds` is what says so.
   */
  placedBlockIds: string[];
  /**
   * FALSE WHEN THE REQUEST WROTE NOTHING AT ALL — not a row inserted, moved, resized,
   * re-marked or deleted.
   *
   * It exists because a drop writes a queue RANK and the reflow may answer it with the
   * calendar the owner already had, and that used to be indistinguishable from a drop that
   * worked: the owner's own report was a 6 h job dropped onto Monday that answered 200 with
   * the row still on Tuesday. Geometry cannot tell the two apart — a row that legitimately
   * settles back into its own slot looks identical — so the server says it outright.
   */
  changed: boolean;
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
  /**
   * The rows the CALLER drew as one unit with this one — the grid's grouping, which is what
   * the owner grabbed: a unit has a single drag handle, so a body drag moves all of it.
   *
   * They are folded into the named row and moved as ONE row in ONE transaction. It used to be
   * one request per row with a full reflow between them, and that left part of the unit
   * behind: after the first move the reflow re-laid the job's remaining hours onto different
   * ids, so the second request moved whatever row now carried the id the drag had captured —
   * and the message reported that no hour had been lost, which was true and beside the point.
   *
   * Ids that are not really part of the unit (another job, another day, a row a previous
   * gesture already absorbed) are IGNORED rather than refused: the list is a description of
   * what the owner saw, and the server checks it against what is stored (`unitOf`).
   */
  unitBlockIds?: readonly string[];
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
 * ON THE FRIDAY BUFFER, THE WEEKEND OR A VISUAL MARGIN it PADLOCKS the row — because
 * there the reflow's only possible answer is to undo the gesture. Friday is in the movable
 * pool so the engine can park growth overflow there and take it back when Mon-Thu frees
 * up; the cost was that a hand drop onto Friday was pulled straight back and the request
 * answered 200 with nothing changed. The padlock is what tells the two apart — engine-
 * placed overflow has none and stays reclaimable, work the owner dropped there has one and
 * stays — and the weekend and the margins get it too, so "this is fixed" means one thing
 * on every day and in every band the engine would otherwise have recovered from.
 *
 * THE PADLOCK IS ONLY EVER ADDED HERE, never removed: dropping the row back onto Mon-Thu
 * leaves it padlocked, and the way to hand it back to the engine is to press the padlock,
 * which is on the row and says exactly what it does. A gesture that silently unlocked work
 * the owner had fixed would make "padlock = fixed, no padlock = free" a lie in the one
 * direction that loses work.
 *
 * `manualPlacementBlockId` is what stops the drop leaving a silent overlap where the
 * reflow cannot reach — the weekend, the frozen past, and a padlocked row anywhere.
 * Same job: one row, hours summed. Another job: cut, tail pushed after the drop. And the
 * drop is stored in segments, never across the lunch break.
 *
 * A DROP THE ENGINE STILL OWNS CANNOT BE REFUSED for a collision: it is a re-ranking of
 * the queue and the reflow is what finds the room — see the note above
 * `ManualPlacementErrorCode` on why "does it fit here right now" is the wrong question
 * there. A PADLOCKED drop lands literally, so a gap or another lock in the way slides it
 * forward on the day the owner named, and a day with no clear slot is refused naming what
 * is in the way. `resolveManualPlacement` owns both.
 *
 * AND A DROP AIMED BELOW WHAT THE DAY HOLDS MOVES TO THE NEXT DAY THE ENGINE WOULD USE
 * (2026-08-14), rather than being refused for running past the end of it. `dropLanding` is
 * the rule: the whole unit's duration is what it is measured with, only a day the engine
 * lays out is left or landed on, and the landing is decided BEFORE the padlock — so a drop
 * that rolls onto a Friday is padlocked for being on the buffer like any other Friday
 * drop.
 */
export function moveBlock(blockId: string, input: MoveBlockInput, db: Db = getDb()): BlockMutation {
  const today = input.today ?? todayLocal();

  return runTransaction(db, () => {
    const block = requireBlock(blockId, db);
    assertNotPast(block.date, today, { blockId });
    assertNotPastTarget(input.date, today);

    const dayOf = dayConfigResolver(db);
    const stored = listBlocks(db);
    // The unit the owner grabbed, as the GRID groups it, intersected with what the request
    // claims: the whole thing moves, once, in this transaction. Anything else is one row.
    const named = new Set(input.unitBlockIds ?? []);
    const unit = unitOf(stored, block, (date) => dayOf(date).manualWindows, today).filter(
      (row) => row.id === blockId || named.has(row.id),
    );
    const durationMinutes = unit.reduce((total, row) => total + row.durationMinutes, 0);
    const absorbed = unit.filter((row) => row.id !== blockId).map((row) => row.id);

    // Aimed below what the day can hold, a drop that lands LITERALLY goes to the next day
    // the engine would use — the plainest thing a calendar does. A drop that is a queue
    // RANK is left exactly where it was released: the reflow fills what the day has left
    // and carries the rest to the next day, which is the answer the roll was standing in
    // for. Everything below reads the LANDING.
    const landing = dropLanding({
      date: input.date,
      startMinutes: input.startMinutes,
      durationMinutes,
      locked: block.locked,
      dayOf: (date) => landingDay(date, dayOf, today),
    });
    const pinned =
      block.locked || pinsTheRow(landing.date, landing.startMinutes, durationMinutes, dayOf);

    // A row stored where it was released is a solid rectangle inside ONE day, so the drop
    // point has to leave room for the unit's hours. A RANK carries no such promise — the
    // engine decides the geometry — so all that has to hold there is that the rank is a
    // time of day, which the route already checked.
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
              // Added, never taken away: the padlock is the owner's mark, and a drop is
              // not the gesture that removes it.
              locked: pinned,
            }
          : row,
      );

    // Handed to `recompose` rather than written first: a write before the reflow would make
    // the row its own baseline, and the end-of-the-day guard reads that baseline to tell an
    // overrun a gesture just created from one a settings change left behind.
    const report = recompose(db, {
      today,
      blocks,
      deletedBlockIds: absorbed,
      manualPlacementBlockId: blockId,
    });
    return settled(blockId, block.projectId, report, [], today, dayOf, db);
  });
}

/**
 * Whether a drop PADLOCKS the row where it landed — `dropLandsLiterally` asked of a stored
 * day configuration. The policy itself lives in src/lib/dropSlide.ts, with the ghost's
 * `dropPins` and `dropLanding`'s roll reading the same function, because it had grown three
 * readers and two of them were hand-written mirrors.
 *
 * It decides the SLOT, and `resolveManualPlacement` may still move it: on a day the engine
 * reflows a padlocked drop slides forward to the first slot clear of a gap or a lock. What
 * it may not do is come back off — a padlock the owner can see is one they can press.
 *
 * This is not "padlock everything the user drags", which was considered and rejected on
 * 2026-08-12 because it covered Mon-Thu drops, the majority, and would have frozen the
 * working week. It covers only days and bands where the engine never places anything
 * anyway, so it freezes nothing.
 */
function pinsTheRow(
  date: string,
  startMinutes: number,
  durationMinutes: number,
  dayOf: (date: string) => ReturnType<typeof getDayConfig>,
): boolean {
  const config = dayOf(date);
  return dropLandsLiterally({
    // The row's own padlock is the caller's business: it is added, never removed, so a
    // gesture asks this only about the place it is aiming at.
    locked: false,
    role: config.role,
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
   * The owner's answer to "these freed hours have nowhere to go". Send it only after a
   * 409 `shrink-needs-choice` said the question had to be asked, and only with one of the
   * `choices` that refusal listed. Leaving it out asks the question.
   */
  freedHours?: FreedHoursChoice;
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
 * IT ONLY WORKS ON A ROW THE ENGINE DOES NOT LAY OUT — padlocked, or on a weekend (409
 * `resize-needs-padlock`). On an automatic row there is no length to set: the row is exactly
 * as big as the room it has, so the transfer was applied and then undone by the very
 * recomposition that follows it. That used to be papered over by a stored mark; the mark is
 * gone (2026-08-18) and the padlock is what holds a length now, since the engine hands a
 * locked row's geometry straight back. On a PAST row the gesture is refused for a different
 * reason and first: the past is a record, and the owner gave the correction up when they
 * froze it.
 *
 * SHRINKING ASKS INSTEAD OF REFUSING. The freed hours go to the job's last row the engine
 * still lays out, skipping the locked ones; when no row can take them the request is
 * answered with 409 `shrink-needs-choice`, carrying the hours and the answers, and the
 * caller sends one back as `freedHours`. It is never a silent no-op.
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
    assertNotPast(block.date, today, { blockId });
    const edit = requireEdit(
      resizeBlockHours(listBlocks(db), {
        blockId,
        durationMinutes: input.durationMinutes,
        today,
        // The row's day. The stretch is measured and cut over the MANUAL WINDOWS, margins
        // included — a hand gesture reads that view.
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

/**
 * The padlock. `locked` is the only exemption from auto-move, so toggling it moves
 * the row into or out of the movable pool and the rest of the calendar reflows
 * around the result. Locking never fails: "a locked block can never make placement
 * fail", because overflow always chains forward.
 *
 * It is also the only way OFF a row that a drop onto the buffer, the weekend or a margin
 * padlocked — which is why it is on the row's hover bar and in the job panel's list, and
 * why nothing else in the app clears the flag.
 *
 * ON A PAST ROW IT MEANS NOTHING AND IS REFUSED. The past is frozen for the engine
 * whatever the padlock says (`isMovable` asks the date first), so toggling it there would
 * be a mark that changes nothing, on the one part of the calendar that is a record rather
 * than a plan. A padlock a row carried into the past simply stays on it.
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
    assertNotPast(block.date, today, { blockId });
    setBlockLocked(blockId, locked, db);
    // No `manualPlacementBlockId`: the padlock changes no geometry, so it cannot
    // create an overlap. A row that was unlocked was reflowed clear of everything,
    // and locking it leaves it exactly there.
    const report = recompose(db, { today });
    return settled(blockId, block.projectId, report, [], today, dayConfigResolver(db), db, {
      // The padlock is written before the reflow reads its baseline, so the reflow itself
      // never reports it. The toggle is a change whatever else moved.
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
 * row of the summed hours instead of leaving them stacked. It follows a drop's other
 * rules too: aimed below what the day holds, it lands on the next day the calendar would
 * use.
 *
 * Neither end may be a past day: not the row being cut, and not where the portion is
 * dropped.
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
      locked: block.locked,
      dayOf: (date) => landingDay(date, dayOf, today),
    });
    // The fragment IS the drop, so it follows the same rule a move does: padlocked on the
    // buffer, on the weekend and in manual-only time, an ordinary queue rank anywhere
    // Monday to Thursday the engine can reach. On top of whatever the source row already
    // carried, since splitting is not a decision about mobility.
    const pinned =
      block.locked ||
      pinsTheRow(landing.date, landing.startMinutes, input.durationMinutes, dayOf);
    // Only a fragment stored where it was released has a footprint to fit; a rank does not.
    if (pinned) assertFitsInDay(landing.startMinutes, input.durationMinutes);
    if (input.durationMinutes >= block.durationMinutes) {
      throw conflict('split-exceeds-block', ERROR_MESSAGE_KEYS.splitExceedsBlock, {
        field: 'durationMinutes',
        details: { blockId, durationMinutes: block.durationMinutes },
      });
    }
    // BOTH HALVES HAVE TO BE ROWS THE CALENDAR CAN DRAW. The scissors are the one gesture
    // that names a duration outright, and nothing here checked a floor: `durationMinutes: 5`
    // stored a 5-minute fragment and a 10-minute remainder, neither able to show its own
    // hours. The calendar's grid is the quarter hour everywhere the owner can aim.
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
    // `block` stays the row that was CUT — that is the row the request named — while
    // `placedBlockIds` answers for the FRAGMENT, because those are the hours that moved.
    return settled(blockId, block.projectId, report, [], today, dayOf, db, {
      placedBlockId: fragmentId,
    });
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
 *
 * A PAST row is refused too. It takes hours off a day the shop has already worked, which
 * is the plainest case of the record being rewritten — and the hover bar this gesture
 * belongs to is not drawn on a past day at all.
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

/**
 * THE PAST IS READ-ONLY TO THE BLOCK GESTURES (decided with the owner, 2026-08-13).
 *
 * Recomposition exists to close holes, and the engine is already forbidden the past so a
 * Monday cut short by a breakdown does not get its hole closed with Tuesday's work. This
 * is the same rule applied to the HAND: a day the shop has already worked is a record,
 * and a gesture that moves, resizes, cuts, deletes or re-marks a row on it edits that
 * record for no schedule that can still change.
 *
 * The cost was named and accepted: it removes "correcting yesterday", which is the case
 * *Block Resize* was designed for. The way to change a job whose work is behind it is the
 * job's form, where the hours go to a row on a future day.
 */
function assertNotPast(date: string, today: string, details: Record<string, unknown>): void {
  if (compareDates(date, today) >= 0) return;
  throw conflict('past-block-frozen', ERROR_MESSAGE_KEYS.pastBlockFrozen, {
    details: { ...details, date, today },
  });
}

/**
 * One day as `dropLanding` needs it: the configuration, plus the answer to "does the engine
 * lay this day out at all". Kept here rather than in the resolver because `dayReflows` is
 * the ENGINE's predicate and needs `today`, which a day configuration knows nothing about.
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
  };
}

/** The other half: a drop may not be AIMED at a past day either. */
function assertNotPastTarget(date: string, today: string): void {
  if (compareDates(date, today) >= 0) return;
  throw conflict('drop-onto-past-day', ERROR_MESSAGE_KEYS.dropOntoPastDay, {
    field: 'date',
    details: { date, today },
  });
}

/**
 * Re-reads the row the request named, which the reflow may have merged away, and says what
 * the request DID — the two things a gesture cannot be read off geometry.
 *
 * `placedBlockIds` is the RUN the gesture's hours ended up as, read with the engine's own
 * `unitOf` so a client is told about the same unit the grid will draw: consecutive rows of
 * that job with no other movable job between them, a night not breaking one. Since *fill
 * and overflow* that is routinely more than one row, and `block` is only the first of them.
 * Deriving the run from the PLACEMENT is safe here in a way it would never be inside the
 * engine — nothing decides anything from it, it is a report.
 */
function settled(
  blockId: string,
  projectId: string,
  report: RecomposeReport,
  touchedLockedBlockIds: string[],
  today: string,
  dayOf: (date: string) => DayConfig,
  db: Db,
  options: {
    /**
     * The row whose hours the gesture moved, when that is not the row the request named —
     * the scissors' fragment.
     */
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

/**
 * Turns an edit transform's refusal into a 409, carrying everything the caller needs to
 * act on it — including, for `shrink-needs-choice`, the freed hours and the answers that
 * exist. That question must be answerable in ONE round trip: the client puts all three
 * ways out to the owner and sends the one they pick back as `freedHours`.
 */
function requireEdit(result: ReturnType<typeof resizeBlockHours>): EditSuccess {
  if (!result.ok) {
    throw conflict(result.error.code, result.error.messageKey, {
      details: {
        ...(result.error.projectId === undefined ? {} : { projectId: result.error.projectId }),
        ...(result.error.blockId === undefined ? {} : { blockId: result.error.blockId }),
        // Minutes, and only minutes: the sentence does not name a number, and the dialog
        // formats one the way the owner reads hours everywhere else. Two spellings of the
        // same quantity in `details` would also collide with the REQUEST's `freedHours`,
        // which is an answer rather than an amount.
        ...(result.error.freedMinutes === undefined ? {} : { freedMinutes: result.error.freedMinutes }),
        ...(result.error.choices === undefined ? {} : { choices: result.error.choices }),
      },
    });
  }
  return result;
}
