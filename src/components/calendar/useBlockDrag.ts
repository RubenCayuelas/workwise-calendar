'use client';

/**
 * Mouse dragging on the week grid: move a unit, or resize it by its bottom edge. TWO KINDS OF THING
 * are dragged and they differ in one place only, `DragTarget.kind`: a job's RUN, whose drop writes a
 * queue RANK, and an ABSENCE, whose drop writes the minute it was released on. A press that does not
 * travel is a click on the same handler. The vertical axis is FIXED AT PRESS.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { dayEndMinutes } from '../../lib/manualWindow';
import {
  durationTo,
  rankFor,
  slotAt,
  snapTo,
  type ColumnBox,
  type GridMetrics,
  type Timeline,
} from './geometry';
import { dropPins } from './dropEffect';
import { aimAtThirds, resolveDropDay, type AimRow } from './dropAim';
import { edgeDelayFor, edgeSideAt, type EdgeHold, type EdgeSide } from './edgePaging';
import type { WeekDay } from '../../lib/api-client';
import type { GapUnit } from '../../types';

/** Pixels of travel before a press becomes a drag rather than a click. */
const DRAG_THRESHOLD = 4;

/** One array, so a render with nothing in the air never invalidates a memo. */
const EMPTY_IDS: readonly string[] = [];

/**
 * How far a press may wander and still be read as a click WHEN THE DRAG RESOLVED TO NOTHING:
 * a 5 px drag lands on the slot it started from, so without this it wrote nothing and was not
 * a click either. Never consulted when the gesture really travelled — the ghost said so.
 */
const CLICK_SLOP = 12;

export type DragKind = 'move' | 'resize';

/**
 * Why a press cannot write: a save or reload in flight (`busy`), a frozen day (`past`), or the
 * bottom edge of a row the engine lays out (`automatic`, which the server refuses as
 * `resize-needs-padlock`). A CLICK still happens on every one of them — the panel and the gap form
 * are reads, and a frozen row is corrected in its form.
 */
export type InertReason = 'busy' | 'past' | 'automatic';

/**
 * The geometry every draggable thing on the grid has, whatever it is. Everything this layer needs to
 * draw a ghost and decide where a release lands is here; what the target IS only matters at the two
 * ends, the grid that builds it and the screen that writes it.
 */
interface DragUnit {
  /** The grouped unit's id (its first row). One drag handle per unit. */
  groupId: string;
  color: string;
  date: string;
  /** The unit's first row start for a move; the sized stretch's start for a resize. */
  startMinutes: number;
  /**
   * Net working minutes. The unit's TOTAL for a move — it is "one 3 h thing" even when stored as
   * two rows — and the stretch's total for a resize.
   */
  durationMinutes: number;
  /** Every row the gesture picks up, so a row is never an obstacle to itself. */
  rowIds: string[];
  /**
   * The thing being dragged is fixed BY ITSELF, so it keeps the minute it is released on whatever
   * day that is: a padlocked unit, or an absence. Not the whole pin question — the DAY has its own
   * say (`dropLandsLiterally`), which is why this only feeds it.
   */
  fixed: boolean;
}

/** A job's RUN: the consecutive rows the engine would lay out as one queue item. */
export interface BlockDragTarget extends DragUnit {
  kind: 'block';
  projectId: string;
  name: string;
  /** The single row a resize applies to: the one whose bottom edge was grabbed. */
  blockId: string;
}

/**
 * ONE ABSENCE. `gap` is the whole of it — a PATCH addresses the unit through any of its rows, so a
 * gesture that named one row's duration would claim the absence is that long — and the geometry
 * above restates its day, start and net total in this layer's own vocabulary.
 */
export interface GapDragTarget extends DragUnit {
  kind: 'gap';
  gap: GapUnit;
}

/** What is being dragged. Built by the grid from a unit and its rows. */
export type DragTarget = BlockDragTarget | GapDragTarget;

export interface DragPreview {
  kind: DragKind;
  groupId: string;
  color: string;
  date: string;
  startMinutes: number;
  durationMinutes: number;
  /** False over a day that takes no work — a frozen (past) day. */
  allowed: boolean;
  /**
   * The ghost had to be pulled UP: the pointer is below the last minute this unit can start
   * on and still end inside the day, and no later day could hold it either. The LAST RESORT
   * behind `rolled`, so the preview can say it rather than silently freezing. A resize never
   * sets it.
   */
  clamped?: boolean;
  /**
   * The drop moved to the NEXT day: `date` is already that day, so this only lets the hint
   * name the reason.
   */
  rolled?: boolean;
  /**
   * The row will keep the minute it is released on, so the ghost's clock range is a promise.
   * Not the same question as "can this drop be refused" (`dayReflowsOn`, about the day).
   */
  pinned?: boolean;
}

export interface BlockDragOptions {
  /**
   * Live measurement of the grid: its ORIGIN and its columns, so a scroll mid-drag cannot
   * offset the pointer. The scale is NOT taken from here — see `timeline`.
   */
  measure: () => GridMetrics | null;
  /** The axis. Read ONCE PER GESTURE, at press, and held in the session from there on. */
  timeline: Timeline;
  dayAt: (date: string) => WeekDay | undefined;
  /**
   * The week's days IN CALENDAR ORDER: what a release below the end of a day needs, since
   * the answer is another column (`resolveDropDay`).
   */
  days: () => readonly WeekDay[];
  /** The rows already on a date, minus the ones being dragged, to quantise the aim against. */
  rowsOn: (date: string, excludeRowIds: readonly string[]) => readonly AimRow[];
  /** The starts already taken on a date, so a drop rank never ties. */
  takenStartsOn: (date: string, excludeRowIds: readonly string[]) => number[];
  /**
   * The gestures are WIRED AT ALL: the axis has arrived and no split fragment is waiting
   * for its target. "A save is in flight" is NOT here — it is an `inert` press instead.
   */
  enabled: boolean;
  /**
   * "Can anything be written RIGHT NOW?", asked at the moment the pointer goes down. A
   * function, not render state: state arrives one render late, and the frame between a
   * mutation starting and the grid re-rendering is where a fast second press lands.
   */
  writable: () => boolean;
  /**
   * THE WEEK ON SCREEN (its Monday). The one fact here that must be reactive: a page turn
   * changes the columns while the hand is still down, and the ghost has to move to the new
   * week THEN — no column carries the date it remembers any more.
   */
  weekKey: string;
  /**
   * Page the calendar with the block still in hand: an edge dwell, its repeats, or an arrow
   * key. A GET that writes nothing, so it cannot interfere with the drop that follows.
   */
  onPageWeek: (side: EdgeSide) => void;
  onMove: (target: DragTarget, drop: { date: string; startMinutes: number }) => void;
  onResize: (target: DragTarget, durationMinutes: number) => void;
  /** The drag ended where nothing can be written — a past day. It must SAY so, not return. */
  onRejected: (target: DragTarget, drop: { date: string; startMinutes: number }) => void;
  onClick: (target: DragTarget) => void;
  /**
   * A press that cannot become a gesture said so. Called ONCE per press, the moment the
   * pointer travels far enough to prove a drag was meant. The target travels with the reason
   * because two answers read it: `automatic` offers the gap that would end THAT row's day early,
   * and the frozen past names the form to correct it in — a job's panel, or the absence's own.
   */
  onInert: (reason: InertReason, target: DragTarget) => void;
}

/** What is different about a press that lands on the hover action bar. */
export interface BeginOptions {
  /**
   * The press landed on the ACTION BAR floating over the block, not on the block itself. It
   * still begins a move (the bar covers the block's own name on a narrow column), and two
   * things then have to differ or the buttons stop working: the press is not cancelled, and a
   * press that does not travel is NOT read as a click on the block.
   */
  overlay?: boolean;
  /**
   * This press may not write, and why — see `InertReason`. Still TRACKED rather than dropped:
   * a click still opens the job panel (or an absence's form), and the first real travel says why
   * nothing will move.
   */
  inert?: InertReason;
}

export interface DragController {
  preview: DragPreview | null;
  /**
   * What is being dragged, while it is being dragged. `preview` says WHERE the unit would
   * land; this says WHAT would land there, which is what tells the grid whether the drop
   * cuts, merges or is refused.
   */
  target: DragTarget | null;
  /**
   * The ROWS in the air, for the "lifted" styling — every row of the unit, since the ghost
   * draws its whole duration.
   */
  liftedRowIds: readonly string[];
  kind: DragKind | null;
  /** The hold in progress at one edge of the grid, which is what the rails are drawn from. */
  edge: EdgeHold | null;
  beginMove: (event: React.PointerEvent, target: DragTarget, options?: BeginOptions) => void;
  /** The bottom edge. Same options as a move because it needs the same `inert`. */
  beginResize: (event: React.PointerEvent, target: DragTarget, options?: BeginOptions) => void;
}

/**
 * One gesture in flight. Exported because the two previews below are pure functions of it
 * and are tested directly, with no pointer event and no DOM.
 */
export interface DragSession {
  kind: DragKind;
  target: DragTarget;
  /** The press landed on the hover action bar — see `BeginOptions.overlay`. */
  overlay?: boolean;
  /** The press cannot write — see `BeginOptions.inert`. No ghost, no request. */
  inert?: InertReason;
  /** The inert press has already explained itself; it must not do so twice. */
  explained?: boolean;
  /**
   * The furthest the pointer ever got from the press, in pixels. Read once, at the release,
   * and only to tell a shaky click from a deliberate put-back — see `CLICK_SLOP`.
   */
  travelled: number;
  /** The axis AS IT WAS AT PRESS. Every minute this gesture reports is read off this one. */
  timeline: Timeline;
  originX: number;
  originY: number;
  /**
   * Pointer minute minus the GRABBED UNIT's start, so the run does not jump to the cursor.
   * The unit on screen, not the run: a run reaches across days, so a head measured from a
   * unit two days later is not a distance on any clock.
   */
  grabOffsetMinutes: number;
  moved: boolean;
  preview: DragPreview | null;
  /**
   * Where the pointer last was, so the ghost can be re-resolved without a pointer event — a
   * page turn arrives while the hand is deliberately holding still.
   */
  point: { clientX: number; clientY: number } | null;
  /**
   * The edge zone has been LEFT at least once, so it may now arm: the right-hand zone lies
   * over the last 40 px of Sunday, so a block grabbed there and dragged up its own column
   * would page the week out from under itself.
   */
  edgeArmed: boolean;
  /** The hold at one edge, with the timer that will fire the next turn. */
  edge: (EdgeHold & { timer: number | null }) | null;
}

export function useBlockDrag(options: BlockDragOptions): DragController {
  // Only these two are read during render; everything else goes through `live` at the moment
  // the pointer fires, so a drag started three renders ago cannot commit against a stale week.
  const { enabled, weekKey } = options;

  const [preview, setPreview] = useState<DragPreview | null>(null);
  const [kind, setKind] = useState<DragKind | null>(null);
  // Published only once the press has become a drag, so it always arrives and leaves
  // with `preview` and the grid never sees one without the other.
  const [target, setTarget] = useState<DragTarget | null>(null);
  const [edge, setEdge] = useState<EdgeHold | null>(null);
  const session = useRef<DragSession | null>(null);
  const teardown = useRef<(() => void) | null>(null);

  // Latest options, read from the window listeners. Without this the listeners would
  // capture the first render's callbacks and drop onto a stale week.
  const live = useRef(options);
  live.current = options;

  /** The hold, as the grid needs it. Called only at the transitions, never per move. */
  const publishEdge = useCallback((): void => {
    const held = session.current?.edge ?? null;
    setEdge(
      held === null
        ? null
        : { side: held.side, turns: held.turns, delayMs: held.delayMs, waiting: held.waiting },
    );
  }, []);

  /** Cancel any countdown. Safe to call when there is none, and it always publishes. */
  const stopEdge = useCallback((): void => {
    const current = session.current;
    if (current === null || current.edge === null) return;
    if (current.edge.timer !== null) window.clearTimeout(current.edge.timer);
    current.edge = null;
    publishEdge();
  }, [publishEdge]);

  /**
   * Start the countdown on one side. The turn itself does NOT schedule the next one: it marks
   * the hold `waiting` and asks for the week, and the effect below re-arms when that week
   * arrives — so a hold can never outrun the calendar, and a week that fails to load stops the
   * gesture instead of hammering the endpoint.
   */
  const armEdge = useCallback(
    (side: EdgeSide, turns: number): void => {
      const current = session.current;
      if (current === null) return;
      const delayMs = edgeDelayFor(turns);
      const timer = window.setTimeout(() => {
        const running = session.current;
        if (running === null || running.edge === null) return;
        running.edge = { ...running.edge, timer: null, waiting: true };
        publishEdge();
        live.current.onPageWeek(running.edge.side);
      }, delayMs);
      current.edge = { side, turns, delayMs, waiting: false, timer };
      publishEdge();
    },
    [publishEdge],
  );

  /** Where the pointer is, horizontally, in the vocabulary of the two edge zones. */
  const trackEdge = useCallback(
    (x: number, metrics: GridMetrics): void => {
      const current = session.current;
      if (current === null || current.kind !== 'move' || current.inert !== undefined) return;

      const side = edgeSideAt(x, metrics.frame);
      if (side === null) {
        // Out of both zones: the gesture has proved it can be somewhere else, so the zones
        // may now arm — and whatever was counting down is abandoned.
        current.edgeArmed = true;
        stopEdge();
        return;
      }
      if (!current.edgeArmed) return;
      // Already counting down (or waiting for a week) on this side: leave it running, or
      // every pointer event inside the zone would restart the wait and it would never fire.
      if (current.edge?.side === side) return;
      stopEdge();
      armEdge(side, 0);
    },
    [armEdge, stopEdge],
  );

  const finish = useCallback(() => {
    stopEdge();
    teardown.current?.();
    teardown.current = null;
    session.current = null;
    setPreview(null);
    setKind(null);
    setTarget(null);
    setEdge(null);
  }, [stopEdge]);

  useEffect(() => finish, [finish]);

  /**
   * The columns changed under the pointer — a page turn landed with the block still in hand.
   * The ghost is re-resolved from the last pointer position, and a hold waiting for this week
   * arms its next countdown. Neither can wait for the hand to move.
   *
   * A LAYOUT effect, not a passive one: a passive effect leaves a moment where the new columns
   * are in the DOM and the preview still names a day off screen, and a `pointerup` in that
   * moment committed against the OLD week.
   */
  useLayoutEffect(() => {
    const current = session.current;
    if (current === null || !current.moved || current.kind !== 'move' || current.point === null) {
      return;
    }
    const metrics = live.current.measure();
    if (metrics === null) return;

    const next = previewMove(current.point, current, metrics, live.current);
    current.preview = next;
    setPreview(next);

    const held = current.edge;
    if (held === null || !held.waiting) return;
    armEdge(held.side, held.turns + 1);
    // Only the week matters here: `armEdge` is stable and the session is a ref.
  }, [weekKey, armEdge]);

  const begin = useCallback(
    (event: React.PointerEvent, target: DragTarget, dragKind: DragKind, options: BeginOptions = {}): void => {
      if (!enabled || event.button !== 0 || session.current !== null) return;

      const metrics = live.current.measure();
      if (metrics === null) return;

      // Stops the browser turning the drag into a text selection. NOT on the action bar: a
      // cancelled press there would take the button's click with it.
      if (options.overlay !== true) event.preventDefault();
      event.stopPropagation();

      // The axis this gesture owns, from here to the release; `live.current.timeline` is
      // never consulted again.
      const timeline = live.current.timeline;
      const pointerMinutes = timeline.minutesAt(event.clientY - metrics.top);
      // The row's own reason wins: the past is a stronger rule than a save in flight, and it
      // names something the owner can act on.
      const inert = options.inert ?? (live.current.writable() ? undefined : 'busy');
      session.current = {
        kind: dragKind,
        target,
        overlay: options.overlay === true,
        inert,
        timeline,
        originX: event.clientX,
        originY: event.clientY,
        grabOffsetMinutes: dragKind === 'move' ? pointerMinutes - target.startMinutes : 0,
        moved: false,
        travelled: 0,
        preview: null,
        point: null,
        // A press that GOES DOWN inside an edge zone has not asked for anything yet; see
        // `DragSession.edgeArmed`. The first pointer event outside the zones arms it.
        edgeArmed: edgeSideAt(event.clientX, metrics.frame) === null,
        edge: null,
      };

      const onPointerMove = (moveEvent: PointerEvent): void => {
        const current = session.current;
        if (current === null) return;

        const travelled = Math.hypot(moveEvent.clientX - current.originX, moveEvent.clientY - current.originY);
        current.travelled = Math.max(current.travelled, travelled);

        // A press that cannot write never becomes a drag: no ghost is published, so nothing on
        // screen promises a move. It speaks once, as soon as the travel proves a drag was meant.
        if (current.inert !== undefined) {
          if (travelled < DRAG_THRESHOLD || current.explained === true) return;
          current.explained = true;
          // `moved` without a kind or a target: no ghost and no "lifted" styling, but the
          // release is no longer read as a click either — a refused drag must not navigate.
          current.moved = true;
          live.current.onInert(current.inert, current.target);
          return;
        }

        if (!current.moved) {
          if (travelled < DRAG_THRESHOLD) return;
          current.moved = true;
          setKind(current.kind);
          setTarget(current.target);
        }

        const nextMetrics = live.current.measure();
        if (nextMetrics === null) return;

        // Kept for the one thing that happens without a pointer event: the week changing
        // under a hand that is deliberately holding still at an edge.
        current.point = { clientX: moveEvent.clientX, clientY: moveEvent.clientY };

        const next =
          current.kind === 'move'
            ? previewMove(moveEvent, current, nextMetrics, live.current)
            : previewResize(moveEvent, current, nextMetrics, live.current);

        current.preview = next;
        setPreview(next);

        // After the preview, so a page turn never fires before the ghost it is about to
        // move has been drawn at least once.
        trackEdge(moveEvent.clientX, nextMetrics);
      };

      const onPointerUp = (): void => {
        const current = session.current;
        // Before the session is dropped: the teardown clears a countdown still running at an
        // edge, and a timer that outlived its gesture would page the week with nothing in hand.
        teardown.current?.();
        teardown.current = null;
        session.current = null;
        setPreview(null);
        setKind(null);
        setTarget(null);
        setEdge(null);
        if (current === null) return;

        // A press that never travelled is a click: open the job. On the action bar it is the
        // BUTTON's click, which is already on its way, so reading it as a click on the block too
        // would open the panel every time the owner locked or split a row. The resize edge DOES
        // count as the block: a click is a click wherever on it lands, only the DRAG differs.
        if (!current.moved) {
          if (current.overlay !== true) live.current.onClick(current.target);
          return;
        }
        // A drag that STARTED on the action bar and travelled must not also press the button
        // it started on: the pointer may still be over it at the release.
        if (current.overlay === true) swallowNextClick();

        // Resolved against the week it is RELEASED in, here rather than off the preview the last
        // pointer event computed — an edge hold replaces the columns while the hand holds still.
        // `previewMove` is pure, so this is idempotent, and it re-reads the COLUMNS only: the
        // axis stays the press's own. A MOVE only, since `previewResize` reads no columns.
        const settled =
          current.kind === 'move' && current.point !== null
            ? resolveRelease(current, live.current)
            : current.preview;
        if (settled === null) return;
        if (!settled.allowed) {
          live.current.onRejected(current.target, {
            date: settled.date,
            startMinutes: settled.startMinutes,
          });
          return;
        }

        if (current.kind === 'move') {
          if (settled.date === current.target.date && settled.startMinutes === current.target.startMinutes) {
            // The drag came to nothing. If the pointer barely wandered the owner was clicking
            // and the mouse moved under their hand, so honour the click. See `CLICK_SLOP`.
            if (current.travelled <= CLICK_SLOP && current.overlay !== true) {
              live.current.onClick(current.target);
            }
            return;
          }
          const taken = live.current.takenStartsOn(settled.date, current.target.rowIds);
          live.current.onMove(current.target, {
            date: settled.date,
            // The rank, or the clock: `rankFor` leaves a PINNED drop alone. See its note.
            startMinutes: rankFor(
              settled.startMinutes,
              taken,
              // The nudge is kept on the AXIS and nothing more: `rankFor` consults it only for a
              // drop that is a RANK, and a rank stores no geometry. The day-END clamp here made
              // the nudge a different gesture.
              (minutes) => current.timeline.clampStart(minutes),
              settled.pinned === true,
            ),
          });
          return;
        }

        if (settled.durationMinutes !== current.target.durationMinutes) {
          live.current.onResize(current.target, settled.durationMinutes);
          return;
        }
        // Same dead zone as a move that resolved to its own slot: a hand that slipped a few
        // pixels off the bottom edge was clicking.
        if (current.travelled <= CLICK_SLOP) live.current.onClick(current.target);
      };

      const onKeyDown = (keyEvent: KeyboardEvent): void => {
        if (keyEvent.key === 'Escape') {
          keyEvent.stopPropagation();
          finish();
          return;
        }

        // The arrows page the week with the block in hand: the same thing the edge does, without
        // the wait. Handled here, in the CAPTURE phase, so the screen's own window-level pager
        // never sees the key and the week change goes through the one path that re-resolves.
        const current = session.current;
        if (current === null || !current.moved || current.kind !== 'move') return;
        if (current.inert !== undefined) return;
        if (keyEvent.key !== 'ArrowLeft' && keyEvent.key !== 'ArrowRight') return;
        if (keyEvent.metaKey || keyEvent.ctrlKey || keyEvent.altKey || keyEvent.shiftKey) return;
        keyEvent.preventDefault();
        keyEvent.stopPropagation();
        // The hold and the key ask for the same thing; a countdown surviving a keypress would
        // page twice for one intent.
        stopEdge();
        live.current.onPageWeek(keyEvent.key === 'ArrowLeft' ? 'previous' : 'next');
      };

      window.addEventListener('pointermove', onPointerMove);
      window.addEventListener('pointerup', onPointerUp);
      window.addEventListener('pointercancel', onPointerUp);
      window.addEventListener('keydown', onKeyDown, true);

      teardown.current = () => {
        stopEdge();
        window.removeEventListener('pointermove', onPointerMove);
        window.removeEventListener('pointerup', onPointerUp);
        window.removeEventListener('pointercancel', onPointerUp);
        window.removeEventListener('keydown', onKeyDown, true);
      };
    },
    [enabled, finish, stopEdge, trackEdge],
  );

  const beginMove = useCallback(
    (event: React.PointerEvent, target: DragTarget, options?: BeginOptions) =>
      begin(event, target, 'move', options),
    [begin],
  );

  const beginResize = useCallback(
    (event: React.PointerEvent, target: DragTarget, options?: BeginOptions) =>
      begin(event, target, 'resize', options),
    [begin],
  );

  return {
    preview,
    target,
    liftedRowIds: preview === null ? EMPTY_IDS : target?.rowIds ?? EMPTY_IDS,
    kind,
    edge,
    beginMove,
    beginResize,
  };
}

/**
 * Eats the ONE click a completed drag would otherwise deliver to the button it started on.
 * Capture phase, and removed either by the click it ate or on the next macrotask — a listener
 * that outlived the gesture would swallow the owner's next real click.
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
// Both are pure and exported so a gesture's arithmetic is testable with no browser and no
// React. `options.timeline` is deliberately NOT read by either: the axis comes from
// `current`, fixed at press.

/**
 * Where the run would land, in three steps: the pointer's minute less the grab offset,
 * snapped; then the row under it has the last word (`aimAtThirds`); then the day may not hold
 * the run from there, in which case the drop is on the NEXT day (`resolveDropDay`), or
 * `clamped` when no later day can hold it either.
 */
export function previewMove(
  event: { clientX: number; clientY: number },
  current: DragSession,
  metrics: GridMetrics,
  options: Pick<BlockDragOptions, 'dayAt' | 'days' | 'rowsOn'>,
): DragPreview {
  const { timeline } = current;
  const { dayAt, days, rowsOn } = options;
  const hit = slotAt({ x: event.clientX, y: event.clientY }, metrics, timeline);
  // The pointer is off the columns — over the time axis, or past the last one — so the last
  // column is kept rather than snapping home. UNLESS it has left the screen: an edge hold pages
  // the week from the axis gutter, where `dateAtX` answers nothing, and a remembered date no
  // column carries would draw the ghost nowhere and resolve against a day `dayAt` cannot find.
  const remembered = current.preview?.date ?? current.target.date;
  const aimedDate =
    hit?.date ??
    (metrics.columns.some((column) => column.date === remembered)
      ? remembered
      : nearestColumnDate(event.clientX, metrics.columns, remembered));

  const exact = timeline.minutesAt(event.clientY - metrics.top) - current.grabOffsetMinutes;
  // THIRDS ARE FOR A RANK, SO AN ABSENCE DOES NOT GET THEM. Over another row a block's aim collapses
  // to that row's start, middle or end, because a block's drop is a queue rank and those three mean
  // before / cut / after. A gap is stored on the minute it was released, so the same collapse would
  // let it land only on three minutes of any row taller than half an hour — measured: an absence
  // aimed at 10:00, 12:00 and 13:00 over one 08:00-14:00 row all resolved to the same slot.
  // The rows of the run itself are not obstacles to it: they are what is being moved.
  const snapped = snapTo(exact);
  const aimed =
    current.target.kind === 'block'
      ? aimAtThirds(snapped, rowsOn(aimedDate, current.target.rowIds))
      : snapped;
  const settled = resolveDropDay({
    days: days(),
    date: aimedDate,
    startMinutes: aimed,
    durationMinutes: current.target.durationMinutes,
    // A unit that is fixed by itself lands literally, so its footprint has to fit the day — which
    // is what makes the roll and the clamp its business and not an unlocked run's.
    fixed: current.target.fixed,
    // An ABSENCE names its day as deliberately as its minute, so it is never carried to another
    // one: the clamp answers instead. Only a job's run rolls.
    rolls: current.target.kind === 'block',
    timeline,
  });

  const date = settled.date;
  const startMinutes = settled.startMinutes;
  const day = dayAt(date);

  return {
    kind: 'move',
    groupId: current.target.groupId,
    color: current.target.color,
    date,
    startMinutes,
    durationMinutes: current.target.durationMinutes,
    // The ghost has already moved to the next day; this only names the reason.
    rolled: settled.rolled,
    // Pulled UP from the hand, and only when there was no next day to go to. Downwards only:
    // a release above the top of the axis is the edge of the screen, not a rule.
    clamped: settled.clamped,
    // `dropPins` mirrors the server's `pinsTheRow`, asked of `startMinutes` AFTER
    // `resolveDropDay` so a release in the lunch band reads as 15:30. It is the INTENT: the
    // server may still slide the row or give the pin up, which `resolveDropPreview` applies.
    pinned:
      day === undefined ||
      dropPins({
        fixed: current.target.fixed,
        role: day.role,
        periods: day.periods,
        manualWindows: day.manualWindows,
        startMinutes,
        durationMinutes: current.target.durationMinutes,
      }),
    // The engine never writes to the past and neither does a drop.
    allowed: day !== undefined && !day.isPast,
  };
}

/**
 * Where the run lands, asked at the moment the button comes up: the same `previewMove` the
 * ghost was drawn from, against the columns live at the release. It falls back to the last
 * preview when the grid cannot be measured — a release that cannot be re-resolved is still a
 * release, and dropping it on the floor is the silence this file exists to remove.
 */
function resolveRelease(current: DragSession, options: BlockDragOptions): DragPreview | null {
  if (current.point === null) return current.preview;
  const metrics = options.measure();
  if (metrics === null) return current.preview;
  return previewMove(current.point, current, metrics, options);
}

/**
 * The column the pointer is closest to, for the two places it is over none of them: the
 * time-axis gutter and the space past the last column. `fallback` covers a week with no
 * columns at all, which only happens before the first measurement.
 */
function nearestColumnDate(
  x: number,
  columns: readonly ColumnBox[],
  fallback: string,
): string {
  let best = fallback;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const column of columns) {
    const right = column.left + column.width;
    const distance = x < column.left ? column.left - x : x > right ? x - right : 0;
    if (distance < bestDistance) {
      best = column.date;
      bestDistance = distance;
    }
  }
  return best;
}

/**
 * The bottom edge, in NET WORKING MINUTES over the day's manual windows — never
 * `pointer − start`, which counts the lunch break as work. The conversion lives in
 * `durationTo`; the margins are inside the windows, so the edge reaches them too.
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
    // The DAY's end, never the axis's: `cover` widens the axis to show a row that already
    // overran, so a cap read off it let the next drag push the row further out.
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
