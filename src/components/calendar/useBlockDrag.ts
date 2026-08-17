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
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { dayEndMinutes } from '../../lib/manualWindow';
import {
  clampDropStart,
  durationTo,
  rankFor,
  slotAt,
  snapTo,
  type GridMetrics,
  type Timeline,
} from './geometry';
import { dropPins } from './dropEffect';
import { aimAtThirds, resolveDropDay, type AimRow } from './dropAim';
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
 * | reason | the press lands on…                                    |
 * |--------|--------------------------------------------------------|
 * | `busy` | the calendar while a save or a reload is still in flight |
 * | `past` | a frozen day, which is a record and not a plan           |
 * | `gap`  | a gap, which has no drag gesture at all                  |
 *
 * A CLICK still happens on the first two: opening the job panel writes nothing, and it is
 * the very place the owner has to go to edit a past day by hand.
 */
export type InertReason = 'busy' | 'past' | 'gap';

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
   */
  onInert: (reason: InertReason) => void;
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
   * Undefined is the ordinary case. See `InertReason` for the three that are not.
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
          live.current.onInert(current.inert);
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
          const windows = live.current.dayAt(settled.date)?.manualWindows ?? [];
          live.current.onMove(current.target, {
            date: settled.date,
            // The rank, or the clock: `rankFor` leaves a PINNED drop alone. See its note.
            startMinutes: rankFor(
              settled.startMinutes,
              taken,
              // A drop that lands in manual-only time is stored exactly as sent — on EVERY
              // day, the auto-filled ones included — so the nudge may not carry the row past
              // the end of the day either.
              (minutes) => clampDropStart(windows, minutes, settled.durationMinutes, current.timeline),
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
    (event: React.PointerEvent, target: DragTarget, options?: BeginOptions) =>
      begin(event, target, 'resize', options),
    [begin],
  );

  return {
    preview,
    target,
    liftedBlockIds: preview === null ? EMPTY_IDS : target?.blockIds ?? EMPTY_IDS,
    kind,
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
  // Leaving the grid sideways keeps the last column rather than snapping home: the
  // owner is usually on their way to the next one.
  const aimedDate = hit?.date ?? current.preview?.date ?? current.target.date;

  const exact = timeline.minutesAt(event.clientY - metrics.top) - current.grabOffsetMinutes;
  // The rows of the run itself are not obstacles to it: they are what is being moved.
  const aimed = aimAtThirds(snapTo(exact), rowsOn(aimedDate, current.target.blockIds));
  const settled = resolveDropDay({
    days: days(),
    date: aimedDate,
    startMinutes: aimed,
    durationMinutes: current.target.durationMinutes,
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
     * both sides. A drop into manual-only time — a visual margin or the lunch band — is
     * stored exactly as released ON ANY DAY, Monday included, because the engine's index
     * space has no margin minutes in it and an unpinned margin row would be pulled straight
     * back inside the periods.
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
