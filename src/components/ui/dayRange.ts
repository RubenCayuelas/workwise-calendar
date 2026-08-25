/**
 * Choosing a range of days as a pure state machine. The pending end is kept HERE and only reaches
 * the form once both ends exist: a first click that wrote the form's two dates would fire a preview
 * — a real write inside a rolled-back transaction — on every click of a walk through the month.
 */

import { absenceRange } from '../../lib/absences';
import { compareDates } from '../../lib/dates';

export interface RangeState {
  /** The end clicked first, while the second is still missing. */
  anchor?: string;
}

export interface RangeClickResult {
  state: RangeState;
  /** Set only when both ends exist, always ordered. */
  committed?: { from: string; to: string };
}

/**
 * One click on a cell. The first sets the anchor and commits nothing; the second commits the span
 * in calendar order whichever end was clicked first, and lets the anchor go so a reopened popover
 * starts a range rather than closing the last one.
 */
export function rangeClick(state: RangeState, date: string): RangeClickResult {
  const anchor = state.anchor;
  if (anchor === undefined) return { state: { anchor: date } };

  const backwards = compareDates(date, anchor) < 0;
  return {
    state: {},
    committed: backwards ? { from: date, to: anchor } : { from: anchor, to: date },
  };
}

/**
 * Which cells of a committed span the save will write, and which it drops. Delegated to
 * `absenceRange`, the same call the preview and the save make, so a painted cell cannot promise a
 * day the write skips — and so the whole-range-is-a-weekend exception is not derived twice.
 *
 * Caller obligation: the walk stops at the range cap, so the tail of an over-long span is painted
 * neither included nor skipped. The count under the field comes from the preview, never from here.
 */
export function rangeCells(from: string, to: string): { included: string[]; skipped: string[] } {
  const range = absenceRange(from, to);
  return { included: range.dates, skipped: range.skipped };
}
