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

/** A committed span, both ends stored and already in calendar order. */
export interface RangeSpan {
  from: string;
  to: string;
}

export interface RangePaint {
  /** Cells of the committed span the save will WRITE. */
  included: string[];
  /** Cells inside it the save will DROP. */
  skipped: string[];
  /** The end already clicked, while the second is missing. */
  pending?: string;
}

/**
 * What the month grid paints for a range.
 *
 * A pending end paints NO span, only itself: the second click is what decides which way the span
 * runs, and a popover has no pointer position to guess with — a band drawn from a guess moves under
 * the mouse and promises days that were never asked for.
 */
export function rangePaint(state: RangeState, span: RangeSpan | undefined): RangePaint {
  if (state.anchor !== undefined) return { included: [], skipped: [], pending: state.anchor };
  if (span === undefined) return { included: [], skipped: [] };
  return rangeCells(span.from, span.to);
}

/**
 * Closing the popover with only one end clicked. The pending end dies and the stored span is not
 * touched, because a first click reported nothing there is anything to take back.
 *
 * Answers with the state it was given when nothing is pending, so the close path can hand this
 * straight to a setter without costing a render.
 */
export function rangeDiscard(state: RangeState): RangeState {
  return state.anchor === undefined ? state : {};
}

/** Which line the popover shows about a range, as a locale KEY: the wording lives in the bundles. */
export function rangeNoticeKey(
  state: RangeState,
): 'dayPicker.rangePending' | 'dayPicker.rangeStart' {
  return state.anchor === undefined ? 'dayPicker.rangeStart' : 'dayPicker.rangePending';
}
