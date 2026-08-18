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
 * NO PRESS MAY END IN SILENCE. That decision point has exactly three outcomes and every
 * press reaches one of them: it starts a drag, it opens the job, or it says why it can do
 * neither (`InertReason`). The three holes this closed were all the same shape — the app
 * appearing to ignore the owner:
 *
 * - a press while a save was in flight was dropped on the floor, and that is precisely the
 *   second AFTER a drop, when the next press is most likely;
 * - a press on the resize edge that did not travel was not read as a click, so clicking
 *   the bottom of a row — most of a short row — opened nothing;
 * - a press that travelled five pixels was a DRAG, and a five-pixel drag lands on the slot
 *   it started from, so it wrote nothing and was not a click either (`CLICK_SLOP`).
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
 *
 * HOLDING THE BLOCK AT AN EDGE PAGES THE WEEK, and the same rule survives it: the axis is
 * VERTICAL and the week is a set of COLUMNS, so a page turn changes what is under the
 * pointer horizontally and nothing at all about the mapping the gesture was fixed to.
 * `CalendarScreen` holds the painted axis for as long as a block is in the air, so the new
 * week is drawn on the axis the press captured, and the two stay the same ruler.
 *
 * Everything else about the drop is re-read at the moment it is released — the day under
 * the pointer, the rows to aim against, the starts already taken — because all of it comes
 * from `live.current`, which is the CURRENT week. So a drop is always resolved against the
 * week it was released in, and never against the week it was picked up in. THREE places
 * could have remembered the old week, and each is named where it is fixed:
 *
 * - `previewMove`'s fallback date, which keeps the remembered column only while it is still a
 *   column and otherwise takes the nearest one;
 * - the GHOST, re-resolved from the last pointer position the moment the columns change
 *   (`weekKey`), in a LAYOUT effect so no paint and no event can fall between the two;
 * - the RELEASE itself, which re-resolves rather than committing the preview it happens to
 *   be holding (`resolveRelease`). That was the real hole: the ghost being right one render
 *   later is no use to a `pointerup` that has already been handled.
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

/** Pixels of travel before a press becomes a drag rather than a click. */
const DRAG_THRESHOLD = 4;

/** One array, so a render with nothing in the air never invalidates a memo. */
const EMPTY_IDS: readonly string[] = [];

/**
 * How far a press may wander and still be read as a click WHEN THE DRAG RESOLVED TO
 * NOTHING.
 *
 * The dead zone this closes: a press that travels five pixels is a drag, and a drag of
 * five pixels lands on the slot it started from, so the release wrote nothing AND was not
 * a click either. Nothing opened, nothing moved, nothing was said — on a shop PC with a
 * worn mouse that is a routine outcome, and it teaches the owner the app is broken.
 *
 * Deliberately only consulted when the gesture came to nothing: a drag that really
 * travelled and was deliberately put back stays silent, because the ghost was under the
 * pointer the whole way and said so.
 */
const CLICK_SLOP = 12;

export type DragKind = 'move' | 'resize';

/**
 * Why a press cannot write, when it cannot. Every one of these used to be a press that
 * did NOTHING AT ALL — no ghost, no message — which is the single worst thing a gesture
 * can do (CLAUDE.md's own rule about drops applies to presses: "a gesture the app refuses
 * has to say so, in the same breath as one it accepts").
 *
 * | reason      | the press lands on…                                            |
 * |-------------|----------------------------------------------------------------|
 * | `busy`      | the calendar while a save or a reload is still in flight        |
 * | `past`      | a frozen day, which is a record and not a plan                 |
 * | `gap`       | a gap, which has no drag gesture at all                        |
 * | `automatic` | the BOTTOM EDGE of a row the engine lays out (2026-08-18)      |
 *
 * A CLICK still happens on all but `gap`: opening the job panel writes nothing, and it is
 * the very place the owner has to go to edit a past day — or to change a job's hours — by
 * hand.
 *
 * `automatic` IS THE ONE THAT IS NOT A CIRCUMSTANCE BUT A RULE, and it is why this list
 * grew: since the hand-set duration was deleted, an automatic row is exactly as big as the
 * room it has, so its bottom edge sizes nothing (the server refuses it,
 * `resize-needs-padlock`). Withholding the strip would have made the reach for it start a
 * MOVE instead — the press falls through to the block's own body — which is a re-ranked
 * queue for a gesture about a length. So the strip stays, it is inert, and it explains: the
 * owner asked for the free resize two days before it was taken away, so the explanation is
 * the feature.
 */
export type InertReason = 'busy' | 'past' | 'gap' | 'automatic';

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
   * THE WHOLE RUN, in queue order — every row of this job the engine holds as one queue
   * item, across days (see `BlockRun` in grouping.ts). A drag moves all of it: re-ranking
   * part of a run leaves the rest behind at its old rank and splits the job, and the
   * owner's own rule is that a split is something they do on purpose, with another job.
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
  /**
   * THE GHOST HAD TO BE PULLED UP: the pointer is below the last minute this unit can
   * start on and still end inside the day, AND no later day could hold it either
   * (`resolveDropDay`).
   *
   * It exists so the preview can SAY that rather than simply stopping. A 6 h unit cannot
   * start after 13:00 on the documented shift, so the last 350 px of the column all mean
   * 13:00 — the ghost freezes, the pointer keeps going, and nothing on screen explains the
   * distance between them. That is a rule about the day, and a rule the owner cannot see is
   * indistinguishable from a drag the app has stopped listening to.
   *
   * It is now the LAST RESORT rather than the ordinary answer: aiming below what a day can
   * hold moves the drop to the next day (`rolled`), and this is only what is left when
   * there is no next day on screen that can hold the run either.
   *
   * A resize never sets it: its edge follows the pointer all the way down.
   */
  clamped?: boolean;
  /**
   * THE DROP MOVED TO THE NEXT DAY, because the day the pointer is over cannot hold the
   * run from where it was released. `date` is already that next day, so the ghost is drawn
   * on its column and the release is never a surprise — this is only what lets the hint
   * name the reason.
   *
   * The owner, on the old behaviour (refuse and freeze): «Que se rechaza, de qué friki.
   * Pasa al siguiente día. ¿Sabes cómo funciona un calendario?»
   */
  rolled?: boolean;
  /**
   * THE ROW WILL KEEP THE MINUTE IT IS RELEASED ON, so the ghost's clock range is a promise
   * and the hint says the owner is in charge here.
   *
   * Not the same question as "can this drop be refused" (`dayReflowsOn`, which is about the
   * day). A drop into a visual margin or the lunch band pins on EVERY day, Monday included
   * — see the note where this is computed.
   */
  pinned?: boolean;
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
  /**
   * The week's days IN CALENDAR ORDER. `dayAt` answers "what is this day", this answers
   * "what comes after it" — which is what a release below the end of a day needs, since
   * the answer is another column (`resolveDropDay`).
   */
  days: () => readonly WeekDay[];
  /**
   * The rows already on a date, minus the ones being dragged. The aim is quantised
   * against them (`aimAtThirds`): over a row the owner is choosing the ROW, not a minute.
   */
  rowsOn: (date: string, excludeBlockIds: readonly string[]) => readonly AimRow[];
  /** The starts already taken on a date, so a drop rank never ties. */
  takenStartsOn: (date: string, excludeBlockIds: readonly string[]) => number[];
  /**
   * The gestures are WIRED AT ALL: the axis has arrived and no split fragment is waiting
   * for its target (during which the columns own the pointer).
   *
   * It no longer covers "a save is in flight". That used to live here and it made every
   * press in the second after a drop do nothing at all — no drag, no click, no message —
   * which is the moment the owner is most likely to press again. That state is now an
   * `inert` press instead: see `BeginOptions.inert`.
   */
  enabled: boolean;
  /**
   * "Can anything be written RIGHT NOW?", asked at the moment the pointer goes down.
   *
   * The grid already tags a press `inert: 'busy'` from render state, and that covers the
   * whole visible saving window — but state arrives one render late, and the frame between
   * a mutation starting and the grid re-rendering is precisely where a fast second press
   * lands. Asked here as a function so the answer is the current tick's, not the last
   * render's, and so a gesture that slips through the frame still explains itself instead
   * of queueing a second write against a calendar already being rewritten.
   */
  writable: () => boolean;
  /**
   * THE WEEK ON SCREEN, as one value that changes when the columns do (its Monday).
   *
   * Everything else about the week is read through a callback at the moment the pointer
   * fires, which is deliberately not reactive. This one has to be: a page turn changes the
   * columns while the hand is still down, and the ghost has to move to the new week THEN,
   * not on the next pointer event — a hand that holds still at the edge would otherwise
   * watch the block disappear, because no column carries the date it remembers any more.
   */
  weekKey: string;
  /**
   * PAGE THE CALENDAR WITH THE BLOCK STILL IN HAND. Called when the pointer has dwelt in
   * an edge zone, and again for each accelerating repeat; also by the arrow keys, which
   * are the same gesture without the wait.
   *
   * It is a GET and writes nothing (`useWeek`), so it cannot interfere with the drop that
   * follows it.
   */
  onPageWeek: (side: EdgeSide) => void;
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
  /**
   * A press that cannot become a gesture said so. Called ONCE per press, the moment the
   * pointer travels far enough to prove the owner meant to drag — not on the press itself,
   * because a press that turns out to be a click has nothing to apologise for.
   *
   * THE TARGET TRAVELS WITH THE REASON, because one of them needs it: `automatic` answers
   * with what DOES change the shape of that day, and the gap that would end it early
   * belongs to that row and no other. The other three are facts about the calendar and
   * ignore it.
   */
  onInert: (reason: InertReason, target: DragTarget) => void;
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
  /**
   * This press may not write, and why. It is still TRACKED rather than dropped: a click
   * still opens the job panel, and the first real travel says why nothing will move.
   *
   * Undefined is the ordinary case. See `InertReason` for the four that are not.
   */
  inert?: InertReason;
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
  /**
   * The ROWS in the air, for the "lifted" styling — every row of the run, not just the
   * unit the pointer grabbed. It has to be the run: the ghost draws the run's whole
   * duration, so a Tuesday unit left looking solid while its Wednesday half faded out
   * would say the drag had picked up two different things.
   */
  liftedBlockIds: readonly string[];
  kind: DragKind | null;
  /**
   * The hold in progress at one edge of the grid, or `null` when the pointer is anywhere
   * else. The grid draws the rails from it — which side is counting down, how long the
   * count is, and whether it is waiting for the week it just asked for.
   */
  edge: EdgeHold | null;
  beginMove: (event: React.PointerEvent, target: DragTarget, options?: BeginOptions) => void;
  /**
   * The bottom edge. It takes the same options as a move because it needs the same
   * `inert`: the past is read-only to EVERY block gesture, and a resize of a past row is
   * as much a rewrite of the record as a drag of it.
   */
  beginResize: (event: React.PointerEvent, target: DragTarget, options?: BeginOptions) => void;
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
  /** The press cannot write — see `BeginOptions.inert`. No ghost, no request. */
  inert?: InertReason;
  /** The inert press has already explained itself; it must not do so twice. */
  explained?: boolean;
  /**
   * The furthest the pointer ever got from the press, in pixels. Read once, at the
   * release, and only to tell a shaky click from a deliberate put-back — see `CLICK_SLOP`.
   */
  travelled: number;
  /**
   * The axis AS IT WAS AT PRESS. Every minute this gesture reports is read off this one,
   * never off `options.timeline`, which may re-fit while the pointer is still down.
   */
  timeline: Timeline;
  originX: number;
  originY: number;
  /**
   * Pointer minute minus the GRABBED UNIT's start, so the run does not jump to the cursor.
   *
   * The unit on screen, not the run: a run reaches across days, and a run's head measured
   * from a unit two days later is not a distance on any clock. The run is one job in one
   * colour, so what the owner sees is a rectangle of the run's hours whose top edge sits
   * exactly as far below the pointer as their grab did below the top of what they grabbed.
   */
  grabOffsetMinutes: number;
  moved: boolean;
  preview: DragPreview | null;
  /**
   * WHERE THE POINTER LAST WAS, so the ghost can be re-resolved without a pointer event.
   * A page turn arrives while the hand is deliberately holding still; the columns under it
   * change, and the answer to "where would this land" changes with them.
   */
  point: { clientX: number; clientY: number } | null;
  /**
   * The edge zone has been LEFT at least once, so it may now arm.
   *
   * The right-hand zone overlaps the last 40 px of Sunday — there is no gutter on that
   * side — so a block grabbed there and dragged straight up its own column would sit in
   * the zone for the whole gesture and page the week out from under itself. Requiring the
   * pointer to leave the zone once makes paging something the owner goes TO. The left zone
   * needs no such protection (it is the time-axis gutter, where nothing can be grabbed),
   * but the rule is one rule for both sides.
   */
  edgeArmed: boolean;
  /** The hold at one edge, with the timer that will fire the next turn. */
  edge: (EdgeHold & { timer: number | null }) | null;
}

export function useBlockDrag(options: BlockDragOptions): DragController {
  // Only these two are read during render. Everything else is read through `live` at the
  // moment the pointer fires, which is what keeps a drag started three renders ago from
  // committing against a stale week. `weekKey` is the one fact that MUST be reactive —
  // see the option's own note.
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
   * Start the countdown on one side. `turns` is how many page turns this hold has already
   * made, which is what makes the repeats accelerate.
   *
   * The turn itself does NOT schedule the next one. It marks the hold `waiting` and asks
   * for the week; the effect below re-arms when that week arrives. So the repeat can never
   * outrun the calendar it is paging, and a week that fails to load simply stops the
   * gesture rather than hammering the endpoint behind an error banner.
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
   * THE COLUMNS CHANGED UNDER THE POINTER — a page turn landed while the block is still in
   * hand. Two things follow, and neither can wait for the hand to move:
   *
   * - the ghost is re-resolved from the last pointer position, against the week that has
   *   just arrived. Without this the preview keeps a date no column carries any more, so
   *   the block vanishes from the hand until the mouse is jiggled;
   * - the hold, if it was waiting for this week, arms its next countdown.
   *
   * A LAYOUT EFFECT, NOT A PASSIVE ONE, and that is a correctness difference rather than a
   * frame of polish. A passive effect is flushed in a scheduler callback, so there is a
   * moment when the new columns are in the DOM and the preview still names a day of the week
   * that has left the screen — and a `pointerup` dispatched in that moment was committed
   * against the OLD week. Measured 2026-08-17 by releasing from inside a MutationObserver
   * callback: the columns read `2026-08-24`, no ghost was drawn at all, and the drop was
   * stored on `2026-08-23` and padlocked there, after which `showWeekOf` pulled the screen
   * back a week to show the owner where their block had gone. A layout effect runs inside
   * the same synchronous commit, so that moment does not exist. The release re-resolves as
   * well (see `onPointerUp`), because a guarantee this load-bearing should not rest on one
   * scheduling detail.
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
      // cancelled press there would take the button's click with it, and the block's own
      // `user-select: none` is what keeps the selection away anyway.
      if (options.overlay !== true) event.preventDefault();
      event.stopPropagation();

      // The axis this gesture owns, from here to the release. Everything below reads it
      // off the session; `live.current.timeline` is never consulted again.
      const timeline = live.current.timeline;
      const pointerMinutes = timeline.minutesAt(event.clientY - metrics.top);
      // The row's own reason wins — the past is a stronger rule than a save in flight, and
      // it names the thing the owner can actually do about it.
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

        // A press that cannot write never becomes a drag: no ghost is published, so
        // nothing on screen promises a move. It only speaks, once, as soon as the travel
        // proves a drag was meant.
        if (current.inert !== undefined) {
          if (travelled < DRAG_THRESHOLD || current.explained === true) return;
          current.explained = true;
          // `moved` without a kind or a target: nothing is published, so no ghost and no
          // "lifted" styling — but the release is no longer read as a click either. A
          // refused drag refuses; it does not quietly navigate somewhere instead.
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
        // Before the session is dropped: the teardown is what clears a countdown still
        // running at an edge, and a timer that outlived its gesture would page the week
        // with nothing in hand.
        teardown.current?.();
        teardown.current = null;
        session.current = null;
        setPreview(null);
        setKind(null);
        setTarget(null);
        setEdge(null);
        if (current === null) return;

        // A press that never travelled is a click: open the job. On the action bar it is the
        // BUTTON's click, which is already on its way — reading it as a click on the block
        // too would open the job panel every time the owner locked or split a row.
        //
        // THE RESIZE EDGE COUNTS AS THE BLOCK. It used to be excluded (`kind === 'move'`),
        // which made a click on the bottom ten pixels of a row do nothing whatsoever — and
        // on a short row that strip is most of what there is to aim at. A click is a click
        // wherever on the block it lands; only the DRAG differs between the two surfaces.
        if (!current.moved) {
          if (current.overlay !== true) live.current.onClick(current.target);
          return;
        }
        // A drag that STARTED on the action bar and travelled must not also press the button
        // it started on: the pointer may still be over it at the release.
        if (current.overlay === true) swallowNextClick();

        /*
         * THE DROP IS RESOLVED AGAINST THE WEEK IT IS RELEASED IN — resolved HERE, at the
         * release, and not read off a preview computed on the last pointer event.
         *
         * Everything a release needs is already live: `measure()` re-reads the columns from
         * the DOM and `live.current` carries the current week's days and rows. What was not
         * live was the ANSWER: `current.preview` is only recomputed by a pointer move or by
         * the week-change effect above, and edge paging replaces the columns while the hand is
         * deliberately holding STILL. Release inside that gap and the drop was written to a
         * week that had already left the screen (reproduced 2026-08-17 — see the effect's
         * note). Re-resolving costs one measurement and is IDEMPOTENT: `previewMove` is pure,
         * so a release with nothing changed under it returns the ghost the owner was looking
         * at, to the minute.
         *
         * It does not touch `current.timeline`. ONE AXIS PER GESTURE is about the VERTICAL
         * mapping, which `previewMove` takes from the session and never from the options; what
         * is re-read here is the set of COLUMNS, which is a horizontal fact and the one thing
         * a page turn really changes.
         *
         * Only a MOVE: a resize belongs to one row on one day, another week has nothing to
         * offer it, and `previewResize` reads no columns at all.
         */
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
            // The drag came to nothing. If the pointer barely wandered, the owner was
            // clicking and the mouse moved under their hand — so honour the click rather
            // than swallowing the press. See `CLICK_SLOP`.
            if (current.travelled <= CLICK_SLOP && current.overlay !== true) {
              live.current.onClick(current.target);
            }
            return;
          }
          const taken = live.current.takenStartsOn(settled.date, current.target.blockIds);
          live.current.onMove(current.target, {
            date: settled.date,
            // The rank, or the clock: `rankFor` leaves a PINNED drop alone. See its note.
            startMinutes: rankFor(
              settled.startMinutes,
              taken,
              /*
               * THE NUDGE IS KEPT ON THE AXIS AND NOTHING MORE (2026-08-17).
               *
               * `rankFor` only ever consults this for a drop that is a RANK — a pinned one
               * keeps its minute untouched — and a rank stores no geometry: since *Fill and
               * Overflow, Always* the engine takes what the day has left and carries the rest
               * on, and `assertFitsInDay` is not even asked of it. It used to be
               * `clampDropStart`, the day-END clamp, and that made the one-minute nudge into a
               * different gesture: a 6 h run released on an afternoon row's start at Monday
               * 15:30 was nudged to 15:29, found not to fit the day, and re-ranked at 13:00 —
               * inside the morning, cutting a row the owner never aimed at.
               */
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
        // pixels off the bottom edge was clicking, not resizing.
        if (current.travelled <= CLICK_SLOP) live.current.onClick(current.target);
      };

      const onKeyDown = (keyEvent: KeyboardEvent): void => {
        if (keyEvent.key === 'Escape') {
          keyEvent.stopPropagation();
          finish();
          return;
        }

        /*
         * THE ARROWS PAGE THE WEEK WITH THE BLOCK IN HAND — the same thing the edge does,
         * without the wait, for an owner who already knows where they are going.
         *
         * It also closes a hole rather than only adding a shortcut: the screen binds the
         * arrows to the pager at the window, and it did so DURING a drag too, so pressing
         * one paged the calendar while a gesture was in flight and nothing re-resolved the
         * ghost. Handled here, in the capture phase, the screen's own listener never sees
         * the key — and the week change goes through the one path that answers for it.
         */
        const current = session.current;
        if (current === null || !current.moved || current.kind !== 'move') return;
        if (current.inert !== undefined) return;
        if (keyEvent.key !== 'ArrowLeft' && keyEvent.key !== 'ArrowRight') return;
        if (keyEvent.metaKey || keyEvent.ctrlKey || keyEvent.altKey || keyEvent.shiftKey) return;
        keyEvent.preventDefault();
        keyEvent.stopPropagation();
        // The hold and the key are two ways to ask for the same thing; letting a countdown
        // survive a keypress would page twice for one intent.
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
    liftedBlockIds: preview === null ? EMPTY_IDS : target?.blockIds ?? EMPTY_IDS,
    kind,
    edge,
    beginMove,
    beginResize,
  };
}

/**
 * A press on something that has no drag gesture at all, wired so it explains itself.
 *
 * The one on the grid is a GAP. It is a `<button>`: pressing and releasing on it opens its
 * form, and pressing it and DRAGGING — which is the obvious thing to try when you want the
 * breakdown moved to another hour — used to produce nothing at all, because the click never
 * fired. This turns that into a sentence, once per press, the moment the travel proves a
 * drag was meant.
 *
 * Deliberately not a drag: a gap's date and time live in its form (CLAUDE.md gives gaps a
 * form and no drop rules), so there is nothing here to make draggable yet — only something
 * to stop being silent about.
 */
export function usePressHint(
  onHint: () => void,
  /**
   * Speak on the RELEASE too, not only once the press has travelled.
   *
   * The default is for something that HAS a click — a gap opens its form — where a press
   * that did not travel is that click and has nothing to apologise for. `true` is for a
   * press that can do nothing at all right now (a gap while a save is in flight): there is
   * no click to fall back on, so every press has to answer, and it must answer ONCE —
   * which is why this lives here rather than in a second `onClick` that would toast the
   * same sentence twice on a short drag.
   */
  onRelease = false,
): (event: React.PointerEvent) => void {
  const live = useRef(onHint);
  live.current = onHint;
  const speakOnRelease = useRef(onRelease);
  speakOnRelease.current = onRelease;

  return useCallback((event: React.PointerEvent): void => {
    if (event.button !== 0) return;
    const originX = event.clientX;
    const originY = event.clientY;
    let spoken = false;

    const speak = (): void => {
      if (spoken) return;
      spoken = true;
      live.current();
    };
    const onMove = (moveEvent: PointerEvent): void => {
      if (spoken) return;
      if (Math.hypot(moveEvent.clientX - originX, moveEvent.clientY - originY) < DRAG_THRESHOLD) return;
      speak();
    };
    const done = (): void => {
      if (speakOnRelease.current) speak();
      /*
       * A PRESS THAT EXPLAINED ITSELF MUST NOT ALSO DO THE OTHER THING (fixed 2026-08-14).
       *
       * Dragging a gap said «Los huecos no se arrastran…» AND opened its form in the same
       * breath: the element is a `<button>`, so the browser delivers its click on release
       * however far the pointer travelled in between. Two answers to one gesture, one of
       * them contradicting the other — the owner is told the gesture does nothing and is
       * then shown a form they did not ask for.
       *
       * Swallowed HERE rather than where the sentence is spoken, because the swallow only
       * survives to the end of the current task: the sentence is said the moment the travel
       * proves a drag was meant, which can be seconds before the release.
       */
      if (spoken) swallowNextClick();
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', done);
      window.removeEventListener('pointercancel', done);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', done);
    window.addEventListener('pointercancel', done);
  }, []);
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

/**
 * WHERE THE RUN WOULD LAND, in the three steps the release really goes through.
 *
 * 1. THE POINTER'S MINUTE, less the offset the unit was grabbed at, snapped.
 * 2. THE ROW UNDER IT has the last word on the minute (`aimAtThirds`): over a row the
 *    owner is choosing that row — before it, after it, or cut it — not a clock reading.
 * 3. THE DAY may not be able to hold the run from there, and then the drop is on the NEXT
 *    day (`resolveDropDay`), which is what a calendar means by aiming past the bottom of a
 *    column. Only when no later day can hold it either does the ghost stop following the
 *    hand, and it says so (`clamped`).
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
  /*
   * The pointer is off the columns — over the time axis, or past the last one. Leaving the
   * grid sideways keeps the last column rather than snapping home: the owner is usually on
   * their way to the next one.
   *
   * UNLESS THAT COLUMN IS NOT THERE ANY MORE. Holding the block at an edge pages the week,
   * and the left-hand zone is the axis gutter — where `dateAtX` answers nothing — so the
   * date the drag remembers is a day of the week that has just left the screen. Kept, the
   * ghost would be drawn on no column at all and the drop would be resolved against a day
   * `dayAt` cannot find. The nearest column is what the pointer is really over.
   */
  const remembered = current.preview?.date ?? current.target.date;
  const aimedDate =
    hit?.date ??
    (metrics.columns.some((column) => column.date === remembered)
      ? remembered
      : nearestColumnDate(event.clientX, metrics.columns, remembered));

  const exact = timeline.minutesAt(event.clientY - metrics.top) - current.grabOffsetMinutes;
  // The rows of the run itself are not obstacles to it: they are what is being moved.
  const aimed = aimAtThirds(snapTo(exact), rowsOn(aimedDate, current.target.blockIds));
  const settled = resolveDropDay({
    days: days(),
    date: aimedDate,
    startMinutes: aimed,
    durationMinutes: current.target.durationMinutes,
    // A padlocked unit lands literally, so its footprint has to fit the day — which is
    // what makes the roll and the clamp its business and not an unlocked run's.
    locked: current.target.locked,
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
    // The drop is on the day AFTER the one the pointer is over: the run does not fit
    // below where the hand is. The ghost has already moved there; this names the reason.
    rolled: settled.rolled,
    // Pulled UP from where the hand actually is, and only when there was no next day to
    // go to instead. Downwards only — a release above the top of the axis is not a rule
    // the owner needs explaining, it is the edge of the screen.
    clamped: settled.clamped,
    /*
     * WILL THE ROW KEEP THE MINUTE IT IS RELEASED ON? The ghost and the hint under the grid
     * are drawn from this, and it is NOT the same question as "can this drop be refused"
     * (that one is `dayReflowsOn`, and it is about the day alone).
     *
     * `dropPins` is the mirror of the server's `pinsTheRow`, one implementation asked from
     * both sides. A drop into manual-only time — a VISUAL MARGIN — is stored exactly as
     * released ON ANY DAY, Monday included, because the engine's index space has no margin
     * minutes in it and an unpinned margin row would be pulled straight back inside the
     * periods. It is asked of `startMinutes` AFTER `resolveDropDay`, which matters for the
     * lunch band: a release there is read as 15:30, so on Monday-Thursday it asks for no
     * manual-only time and does not pin.
     *
     * It is the INTENT. On a day the engine reflows the server may still slide the row
     * forward past a gap or a lock, or give the pin up altogether; the grid applies both
     * (`resolveDropPreview`), because only there are the day's rows and gaps in reach.
     */
    pinned:
      day === undefined ||
      dropPins({
        locked: current.target.locked,
        role: day.role,
        periods: day.periods,
        manualWindows: day.manualWindows,
        startMinutes,
        durationMinutes: current.target.durationMinutes,
      }),
    // The engine never writes to the past and neither does a drop; the day is still
    // editable by hand from the job panel, which is where CLAUDE.md puts that.
    allowed: day !== undefined && !day.isPast,
  };
}

/**
 * WHERE THE RUN LANDS, ASKED AT THE MOMENT THE BUTTON COMES UP.
 *
 * The same `previewMove` the ghost is drawn from, run once more against the columns and the
 * week that are live at the release rather than against the ones the last pointer event saw.
 * With nothing changed under the pointer it returns exactly what the ghost was showing —
 * `previewMove` is pure — so this is a correction and never a surprise.
 *
 * It falls back to the last preview rather than refusing when the grid cannot be measured
 * (it has been unmounted, or the week has none of it left): a release that cannot be
 * re-resolved is still a release, and dropping it on the floor is the silence this whole
 * file exists to remove.
 */
function resolveRelease(current: DragSession, options: BlockDragOptions): DragPreview | null {
  if (current.point === null) return current.preview;
  const metrics = options.measure();
  if (metrics === null) return current.preview;
  return previewMove(current.point, current, metrics, options);
}

/**
 * The column the pointer is closest to, for the two places it is over none of them: the
 * time-axis gutter and the space past the last column. `fallback` covers the week having
 * no columns at all, which only happens before the first measurement.
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
