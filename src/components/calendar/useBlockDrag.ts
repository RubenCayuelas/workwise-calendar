'use client';

/**
 * Mouse dragging on the week grid: move a job's run, or resize a row by its bottom
 * edge. Pointer events on the absolutely positioned grid — no library, no HTML5
 * native drag, no touch. The shop uses a PC (CLAUDE.md, "Desktop only, mouse driven").
 *
 * WHAT A DROP MEANS, because it decides the whole design of this file: a drop writes a
 * QUEUE RANK, not a time. "A dropped block does not stay at the exact time it was
 * dropped at. It keeps that position in the sequence and then settles contiguously
 * after the preceding block." So this hook's job is to report a rank the engine can
 * read unambiguously, and the SCREEN's job is to make the settling visible (it
 * animates the row from where it was released to where it landed) instead of looking
 * like a bug.
 *
 * A press that does not travel is a click, so the same handler opens the job panel.
 * That is why there is no `onClick` on a block: one gesture, one decision point.
 *
 * ONE AXIS PER GESTURE, FIXED AT PRESS. The mapping a gesture is resolved against is
 * captured when the pointer goes down and kept for the whole gesture; only the grid's
 * ORIGIN is re-measured on every pointer event, which is what keeps a scroll mid-drag
 * honest. The two halves are different in kind: an origin that moves means THE GRID
 * MOVED under a still hand, and the minute under the pointer really did change; a SCALE
 * that changes means the same pixel now means a different minute, so the gesture ends
 * somewhere the owner never chose.
 *
 * That is not hypothetical — it was the defect behind «a veces no se coloca exactamente
 * donde quiero» (measured 2026-08-13). Publishing the drag's own preview swapped the two
 * legend lines under the grid for a one-line hint, the legend lost 9.2 px, `.gridArea`
 * absorbed them, and the axis re-fitted by 1.2% about 50 ms into the drag: a resize
 * released on 17:30 was read as 17:22 and committed 5,75 h instead of 6 h. The gesture's
 * own preview was moving the ruler it was being measured with. The trigger is gone (the
 * legend now reserves its box) and the axis is held for the whole gesture on screen too
 * (see `CalendarScreen`), but neither of those is what makes this correct: nothing the
 * layout does can reach a gesture that has already fixed its axis.
 *
 * A move looked unaffected only by accident. Subtracting `grabOffsetMinutes` cancels an
 * ORIGIN error, and there was none; against a changed SCALE it re-anchors the error to
 * the press DEPTH, which a Friday or weekend drop — where the exact minute is kept rather
 * than re-flowed — stored as a quarter of an hour out.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { clockEndOf, dayEndMinutes } from '../../lib/manualWindow';
import {
  clampDropStart,
  durationTo,
  rankFor,
  slotAt,
  snapTo,
  type GridMetrics,
  type Timeline,
} from './geometry';
import type { WeekDay } from '../../lib/api-client';

/** Pixels of travel before a press becomes a drag rather than a click. */
const DRAG_THRESHOLD = 4;

export type DragKind = 'move' | 'resize';

/** What is being dragged. Built by the grid from a group and its rows. */
export interface DragTarget {
  /** The grouped unit's id (its first row). One drag handle per unit. */
  groupId: string;
  projectId: string;
  name: string;
  color: string;
  date: string;
  /** The unit's first row start for a move; the row's own start for a resize. */
  startMinutes: number;
  /**
   * Net working minutes. The group's TOTAL for a move — the unit is "one 3h job" even
   * when stored as two rows — and the row's own duration for a resize.
   */
  durationMinutes: number;
  /**
   * The rows to re-rank, in queue order. A group has to move as a whole: the engine
   * merges consecutive rows of one job into a single queue item, so re-ranking only
   * half of a unit would leave the other half behind and split the job.
   */
  blockIds: string[];
  /** The single row a resize applies to: the LAST of the unit. */
  blockId: string;
  /**
   * Every row of the unit is locked, so it stays a fixed obstacle wherever it lands.
   * Read only by the drop preview, which needs it to pick the side an overlapping drop
   * is resolved on — see `dropEffect.ts`.
   */
  locked: boolean;
}

export interface DragPreview {
  kind: DragKind;
  groupId: string;
  color: string;
  date: string;
  startMinutes: number;
  durationMinutes: number;
  /** False over a day that takes no work — a frozen (past) day. */
  allowed: boolean;
}

export interface BlockDragOptions {
  /**
   * Live measurement of the grid: its ORIGIN and its columns, so a scroll mid-drag
   * cannot offset the pointer. The scale is NOT taken from here — see `timeline`.
   */
  measure: () => GridMetrics | null;
  /**
   * The axis. Read ONCE PER GESTURE, at press, and held in the session from there on:
   * a gesture is resolved against the mapping that was true when the pointer went down.
   */
  timeline: Timeline;
  dayAt: (date: string) => WeekDay | undefined;
  /** The starts already taken on a date, so a drop rank never ties. */
  takenStartsOn: (date: string, excludeBlockIds: readonly string[]) => number[];
  /** Off while a mutation is in flight or the week is still loading. */
  enabled: boolean;
  onMove: (target: DragTarget, drop: { date: string; startMinutes: number }) => void;
  onResize: (target: DragTarget, durationMinutes: number) => void;
  /**
   * The drag ended somewhere nothing can be written — a past day, which `allowed`
   * marks and the ghost draws in red.
   *
   * It used to be a bare `return`: the ghost vanished and the block stayed put, which
   * is precisely what a drop the app has quietly swallowed looks like. A gesture the
   * app refuses has to say so, in the same breath as one it accepts.
   */
  onRejected: (target: DragTarget, drop: { date: string; startMinutes: number }) => void;
  onClick: (target: DragTarget) => void;
}

/** What is different about a press that lands on the hover action bar. */
export interface BeginOptions {
  /**
   * The press landed on the ACTION BAR floating over the block, not on the block itself.
   *
   * It still begins a move — the bar is 102 px anchored 4 px from the block's right edge and
   * appears UNDER the cursor on the first mouse move, so on every weekend column (129 px
   * wide) and on every weekday block from about 210 px down it covers the block's own name:
   * the owner's most natural grab point. Swallowing the press there made the drag do
   * NOTHING — no ghost, no request, no toast, no console error, which is precisely what «la
   * app me ignora» looks like.
   *
   * Two things then have to be different, or the buttons stop working: the press is not
   * cancelled (so the button still gets its click when the pointer does not travel), and a
   * press that does not travel is NOT read as a click on the block.
   */
  overlay?: boolean;
}

export interface DragController {
  preview: DragPreview | null;
  /**
   * What is being dragged, while it is being dragged. `preview` says WHERE the unit
   * would land; this says WHAT would land there, which is what the grid needs to work
   * out whether the drop cuts, merges or is refused.
   */
  target: DragTarget | null;
  /** The unit currently being dragged, for the "lifted" styling. */
  activeGroupId: string | null;
  kind: DragKind | null;
  beginMove: (event: React.PointerEvent, target: DragTarget, options?: BeginOptions) => void;
  beginResize: (event: React.PointerEvent, target: DragTarget) => void;
}

/**
 * One gesture in flight. Exported because the two previews below are pure functions of
 * it and are tested directly — the arithmetic of a drag has no business being reachable
 * only through a pointer event and a DOM.
 */
export interface DragSession {
  kind: DragKind;
  target: DragTarget;
  /** The press landed on the hover action bar — see `BeginOptions.overlay`. */
  overlay?: boolean;
  /**
   * The axis AS IT WAS AT PRESS. Every minute this gesture reports is read off this one,
   * never off `options.timeline`, which may re-fit while the pointer is still down.
   */
  timeline: Timeline;
  originX: number;
  originY: number;
  /** Pointer minute minus the unit's start, so the unit does not jump to the cursor. */
  grabOffsetMinutes: number;
  moved: boolean;
  /** The unsnapped minute under the pointer: it breaks a rank tie's direction. */
  exactMinutes: number;
  preview: DragPreview | null;
}

export function useBlockDrag(options: BlockDragOptions): DragController {
  // Only `enabled` is read during render. Everything else is read through `live` at the
  // moment the pointer fires, which is what keeps a drag started three renders ago from
  // committing against a stale week.
  const { enabled } = options;

  const [preview, setPreview] = useState<DragPreview | null>(null);
  const [kind, setKind] = useState<DragKind | null>(null);
  // Published only once the press has become a drag, so it always arrives and leaves
  // with `preview` and the grid never sees one without the other.
  const [target, setTarget] = useState<DragTarget | null>(null);
  const session = useRef<DragSession | null>(null);
  const teardown = useRef<(() => void) | null>(null);

  // Latest options, read from the window listeners. Without this the listeners would
  // capture the first render's callbacks and drop onto a stale week.
  const live = useRef(options);
  live.current = options;

  const finish = useCallback(() => {
    teardown.current?.();
    teardown.current = null;
    session.current = null;
    setPreview(null);
    setKind(null);
    setTarget(null);
  }, []);

  useEffect(() => finish, [finish]);

  const begin = useCallback(
    (event: React.PointerEvent, target: DragTarget, dragKind: DragKind, options: BeginOptions = {}): void => {
      if (!enabled || event.button !== 0 || session.current !== null) return;

      const metrics = live.current.measure();
      if (metrics === null) return;

      // Stops the browser turning the drag into a text selection. NOT on the action bar: a
      // cancelled press there would take the button's click with it, and the block's own
      // `user-select: none` is what keeps the selection away anyway.
      if (options.overlay !== true) event.preventDefault();
      event.stopPropagation();

      // The axis this gesture owns, from here to the release. Everything below reads it
      // off the session; `live.current.timeline` is never consulted again.
      const timeline = live.current.timeline;
      const pointerMinutes = timeline.minutesAt(event.clientY - metrics.top);
      session.current = {
        kind: dragKind,
        target,
        overlay: options.overlay === true,
        timeline,
        originX: event.clientX,
        originY: event.clientY,
        grabOffsetMinutes: dragKind === 'move' ? pointerMinutes - target.startMinutes : 0,
        moved: false,
        exactMinutes: pointerMinutes,
        preview: null,
      };

      const onPointerMove = (moveEvent: PointerEvent): void => {
        const current = session.current;
        if (current === null) return;

        if (!current.moved) {
          const travelled = Math.hypot(moveEvent.clientX - current.originX, moveEvent.clientY - current.originY);
          if (travelled < DRAG_THRESHOLD) return;
          current.moved = true;
          setKind(current.kind);
          setTarget(current.target);
        }

        const nextMetrics = live.current.measure();
        if (nextMetrics === null) return;

        const next =
          current.kind === 'move'
            ? previewMove(moveEvent, current, nextMetrics, live.current)
            : previewResize(moveEvent, current, nextMetrics, live.current);

        current.preview = next;
        setPreview(next);
      };

      const onPointerUp = (): void => {
        const current = session.current;
        teardown.current?.();
        teardown.current = null;
        session.current = null;
        setPreview(null);
        setKind(null);
        setTarget(null);
        if (current === null) return;

        // A press that never travelled is a click: open the job. On the action bar it is the
        // BUTTON's click, which is already on its way — reading it as a click on the block
        // too would open the job panel every time the owner locked or split a row.
        if (!current.moved) {
          if (current.kind === 'move' && current.overlay !== true) live.current.onClick(current.target);
          return;
        }
        // A drag that STARTED on the action bar and travelled must not also press the button
        // it started on: the pointer may still be over it at the release.
        if (current.overlay === true) swallowNextClick();

        const settled = current.preview;
        if (settled === null) return;
        if (!settled.allowed) {
          live.current.onRejected(current.target, {
            date: settled.date,
            startMinutes: settled.startMinutes,
          });
          return;
        }

        if (current.kind === 'move') {
          if (settled.date === current.target.date && settled.startMinutes === current.target.startMinutes) return;
          const taken = live.current.takenStartsOn(settled.date, current.target.blockIds);
          const windows = live.current.dayAt(settled.date)?.manualWindows ?? [];
          live.current.onMove(current.target, {
            date: settled.date,
            startMinutes: rankFor(settled.startMinutes, current.exactMinutes, taken, (minutes) =>
              // The tie-break is one minute, and on a day that PINS that minute is stored:
              // it may not carry the row past the end of the day either.
              clampDropStart(windows, minutes, settled.durationMinutes, current.timeline),
            ),
          });
          return;
        }

        if (settled.durationMinutes !== current.target.durationMinutes) {
          live.current.onResize(current.target, settled.durationMinutes);
        }
      };

      const onKeyDown = (keyEvent: KeyboardEvent): void => {
        if (keyEvent.key !== 'Escape') return;
        keyEvent.stopPropagation();
        finish();
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
    [enabled, finish],
  );

  const beginMove = useCallback(
    (event: React.PointerEvent, target: DragTarget, options?: BeginOptions) =>
      begin(event, target, 'move', options),
    [begin],
  );

  const beginResize = useCallback(
    (event: React.PointerEvent, target: DragTarget) => begin(event, target, 'resize'),
    [begin],
  );

  return {
    preview,
    target,
    activeGroupId: preview?.groupId ?? null,
    kind,
    beginMove,
    beginResize,
  };
}

/**
 * Eats the ONE click a completed drag would otherwise deliver to the button it started on.
 *
 * Capture phase, so it lands before any handler, and removed either by the click it ate or on
 * the next macrotask — a listener that outlived the gesture would swallow the owner's next
 * real click.
 */
function swallowNextClick(): void {
  const swallow = (event: MouseEvent): void => {
    event.stopPropagation();
    event.preventDefault();
    window.removeEventListener('click', swallow, true);
  };
  window.addEventListener('click', swallow, true);
  window.setTimeout(() => window.removeEventListener('click', swallow, true), 0);
}

// ---------------------------------------------------------------------------
// The two previews
// ---------------------------------------------------------------------------
//
// Both are pure: a pointer position, the session (which carries the axis), the grid's
// CURRENT origin and columns, and the week. Exported so the arithmetic of a gesture can
// be tested for what the owner actually does — press here, release there, get that — with
// no browser and no React in the way. `options.timeline` is deliberately NOT read by
// either: the axis comes from `current`, fixed at press.

/** Where the unit would land. The pointer's minute, less the offset it was grabbed at. */
export function previewMove(
  event: { clientX: number; clientY: number },
  current: DragSession,
  metrics: GridMetrics,
  options: Pick<BlockDragOptions, 'dayAt'>,
): DragPreview {
  const { timeline } = current;
  const { dayAt } = options;
  const hit = slotAt({ x: event.clientX, y: event.clientY }, metrics, timeline);
  // Leaving the grid sideways keeps the last column rather than snapping home: the
  // owner is usually on their way to the next one.
  const date = hit?.date ?? current.preview?.date ?? current.target.date;

  const exact = timeline.minutesAt(event.clientY - metrics.top) - current.grabOffsetMinutes;
  current.exactMinutes = exact;

  const day = dayAt(date);
  // Clamped over the DAY the unit is over, not over the axis: `durationMinutes` is net
  // working minutes, so only the day's windows can say where a 6 h unit still fits.
  const startMinutes = clampDropStart(
    day?.manualWindows ?? [],
    snapTo(exact),
    current.target.durationMinutes,
    timeline,
  );

  return {
    kind: 'move',
    groupId: current.target.groupId,
    color: current.target.color,
    date,
    startMinutes,
    durationMinutes: current.target.durationMinutes,
    // The engine never writes to the past and neither does a drop; the day is still
    // editable by hand from the job panel, which is where CLAUDE.md puts that.
    allowed: day !== undefined && !day.isPast,
  };
}

/**
 * The bottom edge, in NET WORKING MINUTES over the day's manual windows.
 *
 * Not `pointer − start`: that arithmetic counts the lunch break as work, and the cap that
 * went with it stopped the drag at the end of the row's own period. Both are the owner's
 * report B — "debería dejarme hacerlo más grande, y que ignore la hora de comer". The
 * conversion lives in `durationTo`, with the worked example as its test, and the margins
 * are inside the windows so report C's "extend into those bands" falls out of the same
 * change.
 */
export function previewResize(
  event: { clientY: number },
  current: DragSession,
  metrics: GridMetrics,
  options: Pick<BlockDragOptions, 'dayAt'>,
): DragPreview {
  const { timeline } = current;
  const { dayAt } = options;
  const day = dayAt(current.target.date);
  const manualWindows = day?.manualWindows ?? [];

  const pointerMinutes = timeline.minutesAt(event.clientY - metrics.top);
  const durationMinutes = durationTo(current.target.startMinutes, pointerMinutes, manualWindows, {
    // The DAY's end, never the axis's — `cover` widens the axis to show a row that already
    // overran, and reading the cap off it let the next drag push the row further out.
    endOfDayMinutes: dayEndMinutes(manualWindows),
    currentMinutes: current.target.durationMinutes,
  });

  return {
    kind: 'resize',
    groupId: current.target.groupId,
    color: current.target.color,
    date: current.target.date,
    startMinutes: current.target.startMinutes,
    durationMinutes,
    allowed: true,
  };
}
