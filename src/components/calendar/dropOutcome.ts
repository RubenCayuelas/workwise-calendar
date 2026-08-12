/**
 * What became of a drop, worked out from what the server actually stored.
 *
 * WHY THIS EXISTS. A drop onto Friday used to answer 200 and change nothing: the row was
 * pulled straight back by the reflow and the calendar looked exactly as it had a second
 * earlier. The engine fix (`handPlaced`) means that particular drop now lands — but the
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
 * Pure, so the five branches can be pinned by a test rather than by dragging blocks
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
  landed: (DropPoint & { handPlaced: boolean }) | null;
  /** True when the merge was already reported (`BlockMutation.mergedBlockIds`). */
  merged: boolean;
  /** The seven dates the week on screen is showing. */
  visibleDates: readonly string[];
}

export type DropOutcomeKind =
  /**
   * The row stayed exactly where it was dropped AND the engine has promised to leave it
   * there — the buffer and the weekend. The one outcome that is a new state rather than
   * a movement, so it says how to undo it.
   */
  | 'pinned'
  /** The reflow put it somewhere else on this week. The grid slides it; this says why. */
  | 'settled'
  /** It no longer fits this week: the hours carry on in another one. */
  | 'leftWeek'
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

  if (landed.handPlaced) return { kind: 'pinned', date: landed.date };

  if (!input.visibleDates.includes(landed.date)) return { kind: 'leftWeek', date: landed.date };

  if (landed.date === from.date && landed.startMinutes === from.startMinutes) {
    // The drag asked for something and the calendar answered with what it already had.
    return sameSpot(from, to) ? null : { kind: 'unchanged', date: landed.date };
  }

  const settled =
    landed.date !== to.date ||
    Math.abs(landed.startMinutes - to.startMinutes) >= SETTLE_TOLERANCE_MINUTES;
  return settled ? { kind: 'settled', date: landed.date } : null;
}

function sameSpot(a: DropPoint, b: DropPoint): boolean {
  return a.date === b.date && a.startMinutes === b.startMinutes;
}
