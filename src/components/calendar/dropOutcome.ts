/**
 * What became of a drop, worked out from what the server actually stored.
 *
 * WHY THIS EXISTS. A drop onto Friday used to answer 200 and change nothing: the row was
 * pulled straight back by the reflow and the calendar looked exactly as it had a second
 * earlier. The engine fix (the drop padlocks the row) means that particular drop lands — but the
 * shape of the failure was never Friday's alone. A drop writes a QUEUE RANK, so the row
 * lands where the reflow puts it, which may be the same place it started, another week,
 * or nowhere at all if a row of its own job absorbed it. **Every one of those looks
 * identical to a drag the app ignored.** So the outcome is stated, once, in the owner's
 * terms, and only silence when the calendar itself is already the answer.
 *
 * It is computed from the MUTATION, not from the refetched week: `BlockMutation.blocks`
 * is the job's rows as they stand after the recomposition, so the answer is available
 * the moment the request resolves and cannot race the refetch.
 *
 * AND TWO OF ITS INPUTS ARE THE SERVER'S OWN ANSWERS, not geometry (2026-08-17): `changed`
 * says whether anything was written at all, and `placed` says which DAYS the hours ended up
 * on — routinely more than one now that work fills a day and overflows. Both were added
 * because the client cannot derive them: the reflow answering a drop with the calendar the
 * owner already had looks exactly like a drop that worked.
 *
 * Pure, so the eight branches can be pinned by a test rather than by dragging blocks
 * around a browser.
 */

/** A day-and-minute on the calendar. */
export interface DropPoint {
  date: string;
  startMinutes: number;
}

export interface DropOutcomeInput {
  /** Where the dragged unit sat BEFORE the drag. */
  from: DropPoint;
  /** Where the pointer released it — the queue rank the drop wrote. */
  to: DropPoint;
  /**
   * The dropped row as the server stored it, or `null` when the id no longer exists:
   * a row of the same job absorbed it, by the overlap merge or by auto-merge.
   */
  landed: (DropPoint & { locked: boolean }) | null;
  /** True when the merge was already reported (`BlockMutation.mergedBlockIds`). */
  merged: boolean;
  /**
   * THE SERVER'S OWN ANSWER TO "DID ANYTHING CHANGE" (`BlockMutation.changed`), and the only
   * admissible one.
   *
   * A drop is a rank, so the reflow may answer it with the calendar the owner already had —
   * which is indistinguishable from a drop that worked if you compare rectangles, and
   * comparing them is what let the owner's own case answer 200 in silence. It is asked of the
   * ROWS and not of the ids, because moving a run folds it into one row and lets the reflow
   * lay it out again: ids churn on a pass that moved nothing.
   */
  changed: boolean;
  /**
   * WHERE THE GESTURE'S HOURS ENDED UP, one entry per DAY, in calendar order
   * (`BlockMutation.placedBlockIds` grouped by `spillByDay`).
   *
   * Routinely more than one day since *Fill and Overflow, Always*: 6 h dropped into a 4 h
   * afternoon is stored as `[Monday 4 h, Tuesday 2 h]`. `landed` is only the FIRST of those
   * rows, so an outcome read from it alone tells the owner half of what happened — which is
   * the whole reason this field exists rather than being derived from the geometry.
   *
   * Grouped by DAY on purpose: the two halves of a stretch cut at the comida are one day's
   * share, and a drop that produced them has not overflowed anywhere.
   */
  placed: readonly { date: string; minutes: number }[];
  /**
   * The unit already carried a padlock before the drag. A row that was padlocked and
   * stayed exactly where it was put is not news; a row the DROP padlocked is, because the
   * mark is new state the owner did not press for.
   */
  wasLocked: boolean;
  /**
   * The seven dates the week on screen is showing — the week the block was RELEASED in,
   * which since edge paging is not necessarily the week it was picked up in. That is why
   * this alone can tell both stories: `landed` outside it is a row that left the week,
   * and `from` outside it is a drag that crossed into this one.
   */
  visibleDates: readonly string[];
}

export type DropOutcomeKind =
  /**
   * The drop PADLOCKED the row: it stayed exactly where it was released and the engine has
   * promised to leave it there — the buffer, the weekend, a visual margin. The one outcome
   * that is a new state rather than a movement, so it says how to undo it.
   */
  | 'pinned'
  /**
   * THE HOURS FILLED WHAT THE DAY HAD LEFT AND CARRIED ON — *Fill and Overflow, Always*, which
   * since 2026-08-17 is the ordinary outcome of dropping a job into a hole smaller than it is.
   *
   * It outranks every sentence about WHERE the row settled because it is a different and
   * bigger fact: the job is now in more than one piece, on days the owner has to be told
   * about by name. The one thing they must not have to do is count rectangles to find out.
   */
  | 'filled'
  /** The reflow put it somewhere else on this week. The grid slides it; this says why. */
  | 'settled'
  /** It no longer fits this week: the hours carry on in a LATER one. */
  | 'leftWeek'
  /**
   * THE QUEUE PUT IT BEFORE THE WEEK ON SCREEN. The same fact as `leftWeek` in the other
   * direction, and it needs its own sentence because the reason is the opposite one:
   * nothing overflowed, the drop simply took a rank whose contiguous place is earlier.
   *
   * It is what a drag into a LATER week means on Monday-Thursday, and the answer surprises
   * everyone the first time: a drop there is a rank, so the row settles behind whatever
   * precedes it in the queue — which, on a calendar with nothing in between, is back where
   * the work already is. Reachable before edge paging (page with the header buttons, then
   * drag), and reachable all the time now, so it says the route: padlock first, or drop on
   * a day that keeps the minute.
   */
  | 'pulledBack'
  /**
   * THE DRAG CROSSED INTO THIS WEEK. The block was picked up in a week that is no longer
   * on screen — the pointer held at an edge and the calendar paged under it — so the row
   * has landed somewhere the owner has never seen it before, on a screen that changed
   * while their eyes were on the block.
   *
   * The other four all describe what became of the row; this one describes what became of
   * the VIEW, and it is the only one whose sentence has to name the week. Nothing else
   * would: the row is exactly where it was released, so `settled` stays silent and
   * `unchanged` cannot fire (the block did not come back to a day this week holds).
   */
  | 'movedWeek'
  /** It came back to where it started. The drag really did change nothing visible. */
  | 'unchanged'
  /** Its id is gone: a row of the same job took the hours. */
  | 'absorbed';

export interface DropOutcome {
  kind: DropOutcomeKind;
  /** The day the sentence names, for the kinds that name one. */
  date: string;
}

/**
 * How far a row may settle from the drop point before it is worth a sentence.
 *
 * A drop is a rank, so settling is normal and constant narration would be noise; but
 * a row that moved most of a morning has visibly not gone where the mouse let go.
 */
const SETTLE_TOLERANCE_MINUTES = 60;

/**
 * The one thing worth saying about the drop, or `null` when the calendar has already
 * said it: the row is visible, at the minute it was released, and nothing else changed.
 *
 * A refusal is NOT one of these — nothing was written, the request threw, and the error
 * banner carries the server's own reason.
 */
export function describeDrop(input: DropOutcomeInput): DropOutcome | null {
  const { from, to, landed } = input;

  if (landed === null) {
    // Already reported as an overlap merge, with the hours accounted for. Saying it
    // twice in two different sentences would read as two different things happening.
    return input.merged ? null : { kind: 'absorbed', date: to.date };
  }

  /*
   * THE REQUEST WROTE NOTHING THE OWNER CAN SEE — asked of the server, never of the
   * rectangles (`DropOutcomeInput.changed`).
   *
   * It comes first because it is the one outcome that is about the whole calendar rather than
   * about this row, and because it is the complaint this round came from: the owner dropped a
   * 6 h job into a 4 h hole, got 200 «ok», and watched nothing happen. Silence is not
   * available here — a drag that asked for something and got the calendar it already had has
   * to say so, and teach the route: padlock first, then move.
   */
  if (!input.changed) return { kind: 'unchanged', date: landed.date };

  // Only when the padlock is NEW. Dragging a row that was already padlocked keeps it
  // where it was released, which is what the owner asked for and already knew.
  if (landed.locked && !input.wasLocked) return { kind: 'pinned', date: landed.date };

  // The hours are now on more than one day: they filled what the first day had left and
  // carried on. Above every sentence about where the ROW went, because they describe one row
  // and this describes all of them.
  if (input.placed.length > 1) return { kind: 'filled', date: landed.date };

  if (!input.visibleDates.includes(landed.date)) {
    // Which SIDE of the week it went out of. `leftWeek`'s sentence says the hours carried
    // on, which is only true forwards; a row the queue laid out earlier than the week on
    // screen has not overflowed anywhere and needs the other explanation.
    const first = input.visibleDates[0];
    return first !== undefined && landed.date < first
      ? { kind: 'pulledBack', date: landed.date }
      : { kind: 'leftWeek', date: landed.date };
  }

  /*
   * The row is on the week on screen and the block came from a week that is NOT — the drag
   * paged. Below `pinned`, which already names the day it fixed the row to and says more;
   * above everything else, because "you are looking at a different week now" outranks any
   * statement about where in it the row settled.
   */
  if (!input.visibleDates.includes(from.date)) return { kind: 'movedWeek', date: landed.date };

  // The row came back to its own slot while the pass moved something else. `changed` has
  // already ruled out the case where nothing moved at all, so this is the narrower one: the
  // calendar did change, just not here.
  if (landed.date === from.date && landed.startMinutes === from.startMinutes) {
    return { kind: 'unchanged', date: landed.date };
  }

  const settled =
    landed.date !== to.date ||
    Math.abs(landed.startMinutes - to.startMinutes) >= SETTLE_TOLERANCE_MINUTES;
  return settled ? { kind: 'settled', date: landed.date } : null;
}
