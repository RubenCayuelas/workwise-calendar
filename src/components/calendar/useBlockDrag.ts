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
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
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
  /** Live measurement of the grid, so a scroll mid-drag cannot offset the pointer. */
  measure: () => GridMetrics | null;
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
  beginMove: (event: React.PointerEvent, target: DragTarget) => void;
  beginResize: (event: React.PointerEvent, target: DragTarget) => void;
}

interface Session {
  kind: DragKind;
  target: DragTarget;
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
  const session = useRef<Session | null>(null);
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
    (event: React.PointerEvent, target: DragTarget, dragKind: DragKind): void => {
      if (!enabled || event.button !== 0 || session.current !== null) return;

      const metrics = live.current.measure();
      if (metrics === null) return;

      // Stops the browser turning the drag into a text selection.
      event.preventDefault();
      event.stopPropagation();

      const pointerMinutes = live.current.timeline.minutesAt(event.clientY - metrics.top);
      session.current = {
        kind: dragKind,
        target,
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

        // A press that never travelled is a click: open the job.
        if (!current.moved) {
          if (current.kind === 'move') live.current.onClick(current.target);
          return;
        }

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
          live.current.onMove(current.target, {
            date: settled.date,
            startMinutes: rankFor(
              settled.startMinutes,
              current.exactMinutes,
              taken,
              live.current.timeline,
              settled.durationMinutes,
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
    (event: React.PointerEvent, target: DragTarget) => begin(event, target, 'move'),
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

// ---------------------------------------------------------------------------
// The two previews
// ---------------------------------------------------------------------------

function previewMove(
  event: PointerEvent,
  current: Session,
  metrics: GridMetrics,
  options: BlockDragOptions,
): DragPreview {
  const { timeline, dayAt } = options;
  const hit = slotAt({ x: event.clientX, y: event.clientY }, metrics, timeline);
  // Leaving the grid sideways keeps the last column rather than snapping home: the
  // owner is usually on their way to the next one.
  const date = hit?.date ?? current.preview?.date ?? current.target.date;

  const exact = timeline.minutesAt(event.clientY - metrics.top) - current.grabOffsetMinutes;
  current.exactMinutes = exact;
  const startMinutes = timeline.clampStart(snapTo(exact), current.target.durationMinutes);

  const day = dayAt(date);
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
function previewResize(
  event: PointerEvent,
  current: Session,
  metrics: GridMetrics,
  options: BlockDragOptions,
): DragPreview {
  const { timeline, dayAt } = options;
  const day = dayAt(current.target.date);
  const manualWindows = day?.manualWindows ?? [];

  const pointerMinutes = timeline.minutesAt(event.clientY - metrics.top);
  const durationMinutes = durationTo(
    current.target.startMinutes,
    pointerMinutes,
    manualWindows,
    timeline,
  );

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
