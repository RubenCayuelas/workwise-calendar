/**
 * What became of a drop, worked out from what the server actually STORED
 * (`BlockMutation.blocks`), never from the refetched week, so the answer cannot race the reload.
 * Pure, so the eight branches can be pinned by a test.
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
   * The server's own answer to "did anything change" (`BlockMutation.changed`), and the only
   * admissible one: comparing rectangles cannot tell a reflow that answered with the calendar the
   * owner already had from a drop that worked. Asked of the ROWS, not of the ids, which churn.
   */
  changed: boolean;
  /**
   * Where the gesture's hours ended up, one entry per DAY, in calendar order (`placedBlockIds`
   * grouped by `spillByDay`). Routinely more than one: 6 h into a 4 h afternoon is
   * `[Monday 4 h, Tuesday 2 h]`, of which `landed` is only the FIRST row.
   */
  placed: readonly { date: string; minutes: number }[];
  /** The unit already carried a padlock before the drag: only a padlock the DROP added is news. */
  wasLocked: boolean;
  /**
   * The seven dates the week on screen is showing — the week the block was RELEASED in, which
   * since edge paging is not necessarily the one it was picked up in. That is why this alone
   * tells both stories: `landed` outside it left the week, `from` outside it crossed into this one.
   */
  visibleDates: readonly string[];
}

export type DropOutcomeKind =
  /**
   * The drop PADLOCKED the row: it stayed exactly where it was released. The one outcome that is
   * new state rather than a movement, so it says how to undo it.
   */
  | 'pinned'
  /**
   * The hours filled what the day had left and carried on. It outranks every sentence about where
   * the ROW went, because those describe one row and this describes all of them: the job is now in
   * more than one piece, on days the owner must not have to count rectangles to find.
   */
  | 'filled'
  /** The reflow put it somewhere else on this week. The grid slides it; this says why. */
  | 'settled'
  /** It no longer fits this week: the hours carry on in a LATER one. */
  | 'leftWeek'
  /**
   * The queue put it BEFORE the week on screen — the same fact as `leftWeek` in the other
   * direction, and its own sentence because nothing overflowed: the rank's contiguous place is
   * simply earlier. So it says the route: padlock first, or drop on a day that keeps the minute.
   */
  | 'pulledBack'
  /**
   * The drag crossed INTO this week: the block was picked up in a week no longer on screen. The
   * only one of these that describes what became of the VIEW, and the only one to name a week.
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
 * How far a row may settle from the drop point before it is worth a sentence. An hour, because
 * inside one the row is still on screen where the owner is looking; past it they have to hunt.
 */
const SETTLE_TOLERANCE_MINUTES = 60;

/**
 * The one thing worth saying about the drop, or `null` when the calendar has already said it: the
 * row is visible, at the minute it was released, and nothing else changed.
 *
 * A refusal is NOT one of these — nothing was written, and the banner carries the server's reason.
 */
export function describeDrop(input: DropOutcomeInput): DropOutcome | null {
  const { from, to, landed } = input;

  if (landed === null) {
    // Already reported as an overlap merge, so saying it twice would read as two events.
    return input.merged ? null : { kind: 'absorbed', date: to.date };
  }

  /*
   * The request wrote nothing the owner can see — asked of the server, never of the rectangles.
   * First, because it is about the whole calendar rather than this row, and silence is not
   * available: it has to teach the route, padlock first then move.
   */
  if (!input.changed) return { kind: 'unchanged', date: landed.date };

  // Only when the padlock is NEW. Dragging a row that was already padlocked keeps it where it
  // was released, which is what the owner asked for and already knew.
  if (landed.locked && !input.wasLocked) return { kind: 'pinned', date: landed.date };

  // The hours are on more than one day. Above every sentence about where the ROW went, because
  // those describe one row and this describes all of them.
  if (input.placed.length > 1) return { kind: 'filled', date: landed.date };

  if (!input.visibleDates.includes(landed.date)) {
    // Which SIDE of the week it went out of. `leftWeek` says the hours carried on, which is only
    // true forwards; a row laid out earlier than the week on screen needs the other explanation.
    const first = input.visibleDates[0];
    return first !== undefined && landed.date < first
      ? { kind: 'pulledBack', date: landed.date }
      : { kind: 'leftWeek', date: landed.date };
  }

  /*
   * The row is on the week on screen and the block came from a week that is NOT. Below `pinned`,
   * which says more; above the rest, because "you are looking at a different week" outranks any
   * statement about where in it the row settled.
   */
  if (!input.visibleDates.includes(from.date)) return { kind: 'movedWeek', date: landed.date };

  // The row came back to its own slot while the pass moved something else. `changed` has already
  // ruled out the case where nothing moved at all, so this is the narrower one.
  if (landed.date === from.date && landed.startMinutes === from.startMinutes) {
    return { kind: 'unchanged', date: landed.date };
  }

  const settled =
    landed.date !== to.date ||
    Math.abs(landed.startMinutes - to.startMinutes) >= SETTLE_TOLERANCE_MINUTES;
  return settled ? { kind: 'settled', date: landed.date } : null;
}
