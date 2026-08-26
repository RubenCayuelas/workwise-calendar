'use client';

/**
 * Painting a band on empty grid space: press, drag down one column, release, and the band STAYS
 * DRAWN while it is asked what it is — a gap or a job. IT WRITES NOTHING either way; the form
 * opens pre-filled and the owner presses Guardar, because the app never creates work by itself.
 *
 * ONE COLUMN per paint: several days go through the form's range instead. No modifier key, ever.
 * The state machine lives in `paintSession.ts`; this hook installs listeners and runs the effects.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  paintRefusalFor,
  paintStep,
  type PaintEvent,
  type PaintPoint,
  type PaintRefusal,
  type PaintState,
  type PaintedSpan,
} from './paintSession';
import type { GridMetrics, Timeline } from './geometry';
import type { WeekDay } from '../../lib/api-client';

export type { PaintRefusal, PaintedSpan } from './paintSession';

/** The former name of `PaintedSpan`, kept while callers still speak of absences. */
export type PaintedAbsence = PaintedSpan;

export interface PaintOptions {
  /** Live measurement, so a scroll mid-paint cannot offset the pointer. */
  measure: () => GridMetrics | null;
  /** The axis. Read ONCE, at press, and held for the gesture. */
  timeline: Timeline;
  dayAt: (date: string) => WeekDay | undefined;
  /** False while another gesture owns the grid: a split fragment, or a painted form still open. */
  enabled: boolean;
  /** Asked at press: a save or a reload in flight leaves the grid alone. */
  writable: () => boolean;
  /** The band was released. It is STILL DRAWN — call `settle` once the answer is in. */
  onPainted: (painted: PaintedSpan, at: PaintPoint) => void;
  /** A paint that travelled on a day that cannot take one. Called ONCE per press. */
  onRefused: (reason: PaintRefusal, date: string) => void;
  /**
   * A press that did not travel. `minutes` is the minute under it, unsnapped, because the create
   * rail lies OVER the rows: a still press there is the row's, exactly as pressing the row is.
   */
  onClick: (date: string, minutes: number) => void;
}

export interface PaintController {
  /** The band, as the rows it will really be stored as. `null` when nothing is being painted. */
  painting: PaintedSpan | null;
  /**
   * Whether a press would be taken at all. Read by the grid so the reveal never promises a create
   * the controller is going to ignore — a form already open on a band owns the grid.
   */
  enabled: boolean;
  /** True only while the pointer is DOWN, which is what freezes the axis. */
  pressed: boolean;
  begin: (event: React.PointerEvent, date: string) => void;
  /** Clear the band once the release has been answered. */
  settle: () => void;
}

export function usePaintAbsence(options: PaintOptions): PaintController {
  const [state, setState] = useState<PaintState>({ phase: 'idle' });
  const session = useRef<PaintState>({ phase: 'idle' });
  const teardown = useRef<(() => void) | null>(null);

  const live = useRef(options);
  live.current = options;

  const unlisten = useCallback((): void => {
    teardown.current?.();
    teardown.current = null;
  }, []);

  /** One place where an event becomes the next state and its effects are carried out. */
  const dispatch = useCallback(
    (event: PaintEvent): void => {
      const { state: next, effects } = paintStep(session.current, event);
      session.current = next;
      setState(next);

      for (const effect of effects) {
        switch (effect.kind) {
          case 'unlisten':
            unlisten();
            break;
          case 'refused':
            live.current.onRefused(effect.reason, effect.date);
            break;
          case 'clicked':
            live.current.onClick(effect.date, effect.minutes);
            break;
          case 'painted':
            live.current.onPainted(effect.span, effect.at);
            break;
        }
      }
    },
    [unlisten],
  );

  const settle = useCallback((): void => dispatch({ kind: 'dismiss' }), [dispatch]);

  const begin = useCallback(
    (event: React.PointerEvent, date: string): void => {
      const current = live.current;
      if (!current.enabled || event.button !== 0 || session.current.phase !== 'idle') return;

      const metrics = current.measure();
      if (metrics === null) return;
      const day = current.dayAt(date);
      if (day === undefined) return;

      event.preventDefault();
      const timeline = current.timeline;

      dispatch({
        kind: 'press',
        date,
        origin: { x: event.clientX, y: event.clientY },
        anchorMinutes: timeline.minutesAt(event.clientY - metrics.top),
        windows: day.manualWindows,
        // Said ONCE, on the first travel, exactly as an inert press on a row is.
        refusal: paintRefusalFor(day, current.writable()),
      });

      const onPointerMove = (moveEvent: PointerEvent): void => {
        const metricsNow = live.current.measure();
        if (metricsNow === null) return;
        dispatch({
          kind: 'move',
          at: { x: moveEvent.clientX, y: moveEvent.clientY },
          minutes: timeline.minutesAt(moveEvent.clientY - metricsNow.top),
        });
      };

      const onPointerUp = (): void => dispatch({ kind: 'release' });
      // Its OWN handler. Wired to `pointerup` it committed a band the pointer had abandoned.
      const onPointerCancel = (): void => dispatch({ kind: 'cancel' });

      const onKeyDown = (keyEvent: KeyboardEvent): void => {
        if (keyEvent.key === 'Escape') {
          keyEvent.stopPropagation();
          dispatch({ kind: 'cancel' });
          return;
        }
        // THE WEEK MAY NOT TURN UNDER A PAINT. A block drag pages on the arrows on purpose — it can
        // land on another week — but a paint is one column by definition, so paging left the band
        // drawn nowhere and pre-filled the form for a day off screen with hours nobody saw. Swallowed
        // in the capture phase, the way the drag takes the keys it owns.
        if (keyEvent.key === 'ArrowLeft' || keyEvent.key === 'ArrowRight') {
          keyEvent.stopPropagation();
          keyEvent.preventDefault();
        }
      };

      window.addEventListener('pointermove', onPointerMove);
      window.addEventListener('pointerup', onPointerUp);
      window.addEventListener('pointercancel', onPointerCancel);
      window.addEventListener('keydown', onKeyDown, true);

      teardown.current = () => {
        window.removeEventListener('pointermove', onPointerMove);
        window.removeEventListener('pointerup', onPointerUp);
        window.removeEventListener('pointercancel', onPointerCancel);
        window.removeEventListener('keydown', onKeyDown, true);
      };
    },
    [dispatch],
  );

  // A mid-press unmount left four window listeners behind, as `useBlockDrag` already guards against.
  useEffect(() => unlisten, [unlisten]);

  return {
    painting: state.painted ?? null,
    enabled: options.enabled,
    pressed: state.phase === 'pressed' || state.phase === 'painting',
    begin,
    settle,
  };
}
