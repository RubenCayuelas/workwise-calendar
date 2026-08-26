/**
 * Choosing a range of days as a pure state machine. ONE CLICK IS ONE DAY: the click answers with
 * that day as both ends, and a second click extends it. The common absence is a single day, and
 * requiring a second click for it put the cost on the common case to protect the rare one.
 *
 * That every click leaves a COMPLETE span is what makes it safe: the form is never handed a
 * half-chosen range, so `previewAbsence` — a real write inside a rolled-back transaction — is never
 * asked about one.
 */

import { absenceRange } from '../../lib/absences';
import { compareDates } from '../../lib/dates';

export interface RangeState {
  /** The day a click chose, kept so the NEXT click extends from it instead of starting over. */
  anchor?: string;
}

export interface RangeClickResult {
  state: RangeState;
  /** Always set, and always ordered: a click never leaves the span half chosen. */
  committed: { from: string; to: string };
}

/**
 * One click on a cell. With no anchor it answers with that day as BOTH ends and keeps it; with one,
 * it extends to the day clicked, in calendar order whichever end came first, and lets the anchor go
 * so the next click starts over rather than extending a span the owner has finished with.
 */
export function rangeClick(state: RangeState, date: string): RangeClickResult {
  const anchor = state.anchor;
  if (anchor === undefined) {
    return { state: { anchor: date }, committed: { from: date, to: date } };
  }

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
}

/**
 * What the month grid paints for a range: the stored span, and nothing else. It needs no state,
 * because there is no provisional end to draw differently — a click's answer is already complete,
 * and a one-day span paints as the one cell it is.
 */
export function rangePaint(span: RangeSpan | undefined): RangePaint {
  if (span === undefined) return { included: [], skipped: [] };
  return rangeCells(span.from, span.to);
}

/**
 * Closing the popover. The anchor goes, so reopening starts over rather than extending a span the
 * owner has finished with — and nothing is taken back, because the day the last click chose is a
 * real answer the form already holds.
 *
 * Answers with the state it was given when there is no anchor, so the close path can hand this
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
