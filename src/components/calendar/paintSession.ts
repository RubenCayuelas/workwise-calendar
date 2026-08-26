/**
 * Painting a band on empty grid space, as a pure state machine. The hook around it does nothing but
 * install listeners and carry out the effects, which is what lets the gesture be tested in a suite
 * with no DOM.
 */

import { firstWorkingMinute, netMinutesBetween } from '../../lib/manualWindow';
import { DRAG_THRESHOLD_PX, SNAP_MINUTES, snapTo } from './geometry';
import type { WorkPeriod } from '../../types';

/**
 * Why a press on this column cannot become a band. A CLOSED day is not one of them: the weekend and a
 * closed day both take a band, and the form each answer opens is what asks about the day being shut.
 */
export type PaintRefusal = 'past' | 'busy';

/** What a released band fully describes, and the one payload every consumer reads. */
export interface PaintedSpan {
  date: string;
  startMinutes: number;
  /** NET working minutes over the day's manual windows, so the lunch break costs nothing. */
  durationMinutes: number;
}

export interface PaintPoint {
  x: number;
  y: number;
}

/**
 * `choosing` is the phase the release lands in: the listeners are gone but the band is still drawn,
 * because the owner has not yet said whether it is a gap or a job.
 */
export type PaintPhase = 'idle' | 'pressed' | 'painting' | 'choosing';

export interface PaintState {
  phase: PaintPhase;
  date?: string;
  origin?: PaintPoint;
  /** Where the pointer is now. The question is asked here. */
  at?: PaintPoint;
  anchorMinutes?: number;
  windows?: readonly WorkPeriod[];
  refusal?: PaintRefusal | null;
  /** The refusal has spoken; it must not speak twice. */
  explained?: boolean;
  /** `null` while the band is too short to be a row. */
  painted?: PaintedSpan | null;
}

export type PaintEvent =
  | {
      kind: 'press';
      date: string;
      origin: PaintPoint;
      /** The minute under the press, off the axis fixed for this gesture. */
      anchorMinutes: number;
      windows: readonly WorkPeriod[];
      refusal: PaintRefusal | null;
    }
  | { kind: 'move'; at: PaintPoint; minutes: number }
  | { kind: 'release' }
  /** A pointercancel, Escape, or the grid unmounting. Commits nothing, from any phase. */
  | { kind: 'cancel' }
  /** The question was answered or dismissed. */
  | { kind: 'dismiss' };

export type PaintEffect =
  | { kind: 'refused'; reason: PaintRefusal; date: string }
  /**
   * A press that did not travel. `minutes` is the minute under it, unsnapped: the answer depends on
   * what is on the row there, since the create rail lies OVER the rows and must not swallow the
   * press they would have answered themselves.
   */
  | { kind: 'clicked'; date: string; minutes: number }
  | { kind: 'painted'; span: PaintedSpan; at: PaintPoint }
  /** Take the window listeners off. Separate from ending, so the band can outlive the pointer. */
  | { kind: 'unlisten' };

export interface PaintStep {
  state: PaintState;
  effects: PaintEffect[];
}

const IDLE: PaintState = { phase: 'idle' };

/**
 * The band between the minute the press went down on and the minute the pointer is at, in either
 * direction. `null` below a quarter of an hour of working time: that is the smallest row the
 * calendar draws, and a band shorter than one is a press that wandered rather than a gesture.
 */
export function paintedSpan(
  windows: readonly WorkPeriod[],
  anchorMinutes: number,
  pointerMinutes: number,
): { startMinutes: number; durationMinutes: number } | null {
  const a = bandStartAt(windows, anchorMinutes);
  const b = bandStartAt(windows, pointerMinutes);
  const from = Math.min(a, b);
  const durationMinutes = netMinutesBetween(windows, from, Math.max(a, b));
  if (durationMinutes < SNAP_MINUTES) return null;
  return { startMinutes: firstWorkingMinute(windows, from), durationMinutes };
}

/**
 * The minute a press here would start a band on: snapped, then moved forward to the first minute
 * that can hold work, so a press inside the lunch break means the afternoon. The grid's reveal names
 * it before the press, so it has to be THIS function and not the raw minute — otherwise the hour the
 * pointer promises and the hour the release stores can differ.
 */
export function bandStartAt(windows: readonly WorkPeriod[], minutes: number): number {
  return firstWorkingMinute(windows, snapTo(minutes));
}

/**
 * Why a press on this day cannot become a band, decided ONCE at the press. The past outranks a save in
 * flight because a column that is both was answered by one on travel and the other on a still press,
 * and four pixels of wobble decided which of two different things the owner was told.
 *
 * A CLOSED day and the weekend are not refusals: both take a band, and being shut is the answer's form
 * to raise. Re-adding one here is how the gesture stops reaching them.
 */
export function paintRefusalFor(day: { isPast: boolean }, writable: boolean): PaintRefusal | null {
  return day.isPast ? 'past' : writable ? null : 'busy';
}

function travelled(from: PaintPoint, to: PaintPoint): number {
  return Math.hypot(to.x - from.x, to.y - from.y);
}

export function paintStep(state: PaintState, event: PaintEvent): PaintStep {
  switch (event.kind) {
    case 'press':
      // A press while the question is open belongs to the chooser, which dismisses itself. Starting
      // a second gesture here would paint underneath the dialog that is still on screen.
      if (state.phase !== 'idle') return { state, effects: [] };
      return {
        state: {
          phase: 'pressed',
          date: event.date,
          origin: event.origin,
          at: event.origin,
          anchorMinutes: event.anchorMinutes,
          windows: event.windows,
          refusal: event.refusal,
          explained: false,
        },
        effects: [],
      };

    case 'move': {
      if (state.phase !== 'pressed' && state.phase !== 'painting') return { state, effects: [] };
      const origin = state.origin;
      const windows = state.windows;
      const date = state.date;
      if (origin === undefined || windows === undefined || date === undefined) {
        return { state, effects: [] };
      }

      const far = travelled(origin, event.at) >= DRAG_THRESHOLD_PX;

      if (state.refusal !== null && state.refusal !== undefined) {
        if (!far || state.explained === true) return { state, effects: [] };
        return {
          state: { ...state, at: event.at, explained: true },
          effects: [{ kind: 'refused', reason: state.refusal, date }],
        };
      }

      if (!far) return { state, effects: [] };

      const span = paintedSpan(windows, state.anchorMinutes ?? 0, event.minutes);
      return {
        state: {
          ...state,
          phase: 'painting',
          at: event.at,
          painted: span === null ? null : { date, ...span },
        },
        effects: [],
      };
    }

    case 'release': {
      if (state.phase === 'idle' || state.phase === 'choosing') return { state, effects: [] };

      const unlisten: PaintEffect = { kind: 'unlisten' };

      // A press that travelled far enough to be refused has already had its one answer.
      if (state.phase === 'pressed' && state.explained !== true && state.date !== undefined) {
        return {
          state: IDLE,
          effects: [
            unlisten,
            { kind: 'clicked', date: state.date, minutes: state.anchorMinutes ?? 0 },
          ],
        };
      }

      // A press that TRAVELLED but drew no band — a wobble inside one snap step — is still a click on
      // whatever is underneath. It used to end in silence, which the create rail turned into a defect:
      // the 21 px it lies over were answered by the drag layer's own 12 px of click slop before it.
      // A REFUSED press is not one of these: it has had its one answer and must not also do something.
      const painted = state.painted ?? null;
      if (painted === null) {
        if (state.explained === true || state.date === undefined) {
          return { state: IDLE, effects: [unlisten] };
        }
        return {
          state: IDLE,
          effects: [
            unlisten,
            { kind: 'clicked', date: state.date, minutes: state.anchorMinutes ?? 0 },
          ],
        };
      }

      return {
        state: { ...state, phase: 'choosing' },
        effects: [unlisten, { kind: 'painted', span: painted, at: state.at ?? { x: 0, y: 0 } }],
      };
    }

    case 'cancel':
      if (state.phase === 'idle') return { state, effects: [] };
      return { state: IDLE, effects: [{ kind: 'unlisten' }] };

    case 'dismiss':
      if (state.phase !== 'choosing') return { state, effects: [] };
      return { state: IDLE, effects: [] };
  }
}
