/**
 * Painting a band on empty grid space, as a pure state machine. The hook around it does nothing but
 * install listeners and carry out the effects, which is what lets the gesture be tested in a suite
 * with no DOM.
 */

import { firstWorkingMinute, netMinutesBetween } from '../../lib/manualWindow';
import { DRAG_THRESHOLD_PX, SNAP_MINUTES, snapTo } from './geometry';
import type { WorkPeriod } from '../../types';

/** Why a press on this column cannot become a band. */
export type PaintRefusal = 'past' | 'closed' | 'busy';

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
  /** The grid background's only press: a still press on a closed column. */
  | { kind: 'clicked'; date: string }
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
  const a = firstWorkingMinute(windows, snapTo(anchorMinutes));
  const b = firstWorkingMinute(windows, snapTo(pointerMinutes));
  const from = Math.min(a, b);
  const durationMinutes = netMinutesBetween(windows, from, Math.max(a, b));
  if (durationMinutes < SNAP_MINUTES) return null;
  // The band's own start is the first minute that can hold work: painting from inside the lunch break
  // means the afternoon, exactly as a drop aimed there does.
  return { startMinutes: firstWorkingMinute(windows, from), durationMinutes };
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
        return { state: IDLE, effects: [unlisten, { kind: 'clicked', date: state.date }] };
      }

      const painted = state.painted ?? null;
      if (painted === null) return { state: IDLE, effects: [unlisten] };

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
