'use client';

/**
 * Painting an absence on empty grid space: press, drag a band down one column, release, and the
 * absences form OPENS PRE-FILLED with the day, the start and the net duration. IT WRITES NOTHING —
 * the owner presses Guardar, because the app never creates a gap by itself.
 *
 * ONE COLUMN per paint: several days go through the form's range instead. No modifier key, ever.
 */

import { useCallback, useRef, useState } from 'react';
import { firstWorkingMinute, netMinutesBetween } from '../../lib/manualWindow';
import { SNAP_MINUTES, snapTo, type GridMetrics, type Timeline } from './geometry';
import type { WeekDay } from '../../lib/api-client';
import type { WorkPeriod } from '../../types';

/** Pixels of travel before a press becomes a paint rather than a click. */
const PAINT_THRESHOLD = 4;

/** What the release hands the form: exactly what fully describes an absence. */
export interface PaintedAbsence {
  date: string;
  startMinutes: number;
  /** NET working minutes over the day's manual windows, so the comida costs nothing. */
  durationMinutes: number;
}

/** Why a press on this column cannot become an absence. */
export type PaintRefusal = 'past' | 'closed' | 'busy';

export interface PaintOptions {
  /** Live measurement, so a scroll mid-paint cannot offset the pointer. */
  measure: () => GridMetrics | null;
  /** The axis. Read ONCE, at press, and held for the gesture. */
  timeline: Timeline;
  dayAt: (date: string) => WeekDay | undefined;
  /** False while another gesture owns the grid: a split fragment waiting for its target. */
  enabled: boolean;
  /** Asked at press: a save or a reload in flight leaves the grid alone. */
  writable: () => boolean;
  onPainted: (painted: PaintedAbsence) => void;
  /** A paint that travelled on a day that cannot take one. Called ONCE per press. */
  onRefused: (reason: PaintRefusal, date: string) => void;
  /** A press that did not travel. The grid background has no click of its own. */
  onClick: (date: string) => void;
}

export interface PaintController {
  /** The band, as the rows it will really be stored as. `null` when nothing is being painted. */
  painting: PaintedAbsence | null;
  begin: (event: React.PointerEvent, date: string) => void;
}

interface PaintSession {
  date: string;
  timeline: Timeline;
  originY: number;
  originX: number;
  anchorMinutes: number;
  windows: readonly WorkPeriod[];
  refusal: PaintRefusal | null;
  /** The refusal has spoken; it must not speak twice. */
  explained: boolean;
  moved: boolean;
  painted: PaintedAbsence | null;
}

/**
 * The band between the minute the press went down on and the minute the pointer is at, in either
 * direction. `null` below a quarter of an hour of working time: that is the smallest row the calendar
 * draws, and a band shorter than one is a press that wandered rather than a gesture.
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
  // The band's own start is the first minute that can hold work: painting from inside the comida
  // means the afternoon, exactly as a drop aimed there does.
  return { startMinutes: firstWorkingMinute(windows, from), durationMinutes };
}

export function usePaintAbsence(options: PaintOptions): PaintController {
  const [painting, setPainting] = useState<PaintedAbsence | null>(null);
  const session = useRef<PaintSession | null>(null);
  const teardown = useRef<(() => void) | null>(null);

  const live = useRef(options);
  live.current = options;

  const finish = useCallback((): void => {
    teardown.current?.();
    teardown.current = null;
    session.current = null;
    setPainting(null);
  }, []);

  const begin = useCallback(
    (event: React.PointerEvent, date: string): void => {
      const current = live.current;
      if (!current.enabled || event.button !== 0 || session.current !== null) return;

      const metrics = current.measure();
      if (metrics === null) return;
      const day = current.dayAt(date);
      if (day === undefined) return;

      event.preventDefault();
      const timeline = current.timeline;
      session.current = {
        date,
        timeline,
        originX: event.clientX,
        originY: event.clientY,
        anchorMinutes: timeline.minutesAt(event.clientY - metrics.top),
        windows: day.manualWindows,
        // Said ONCE, on the first travel, exactly as an inert press on a row is: the past is a
        // record, a closed day holds no work, and a save in flight is a moment that will pass.
        refusal: day.isPast
          ? 'past'
          : day.isClosed
            ? 'closed'
            : current.writable()
              ? null
              : 'busy',
        explained: false,
        moved: false,
        painted: null,
      };

      const onPointerMove = (moveEvent: PointerEvent): void => {
        const running = session.current;
        if (running === null) return;
        const travelled = Math.hypot(
          moveEvent.clientX - running.originX,
          moveEvent.clientY - running.originY,
        );

        if (running.refusal !== null) {
          if (travelled < PAINT_THRESHOLD || running.explained) return;
          running.explained = true;
          running.moved = true;
          live.current.onRefused(running.refusal, running.date);
          return;
        }

        if (!running.moved) {
          if (travelled < PAINT_THRESHOLD) return;
          running.moved = true;
        }

        const nextMetrics = live.current.measure();
        if (nextMetrics === null) return;
        const span = paintedSpan(
          running.windows,
          running.anchorMinutes,
          running.timeline.minutesAt(moveEvent.clientY - nextMetrics.top),
        );
        running.painted = span === null ? null : { date: running.date, ...span };
        setPainting(running.painted);
      };

      const onPointerUp = (): void => {
        const running = session.current;
        finish();
        if (running === null) return;
        if (!running.moved) {
          live.current.onClick(running.date);
          return;
        }
        if (running.painted !== null) live.current.onPainted(running.painted);
      };

      const onKeyDown = (keyEvent: KeyboardEvent): void => {
        if (keyEvent.key === 'Escape') {
          keyEvent.stopPropagation();
          finish();
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
      window.addEventListener('pointercancel', onPointerUp);
      window.addEventListener('keydown', onKeyDown, true);

      teardown.current = () => {
        window.removeEventListener('pointermove', onPointerMove);
        window.removeEventListener('pointerup', onPointerUp);
        window.removeEventListener('pointercancel', onPointerUp);
        window.removeEventListener('keydown', onKeyDown, true);
      };
    },
    [finish],
  );

  return { painting, begin };
}
