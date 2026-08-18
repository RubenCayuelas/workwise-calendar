'use client';

/**
 * The week grid: a time axis and seven day columns, everything inside a column
 * absolutely positioned from `date + startMinutes + durationMinutes`.
 *
 * Three things this component is the only owner of:
 *
 * - MEASUREMENT. The drag layer cannot read the DOM, so the grid publishes a `measure()`
 *   through `metricsRef`: the client Y of the timeline's top, every column's box, and the
 *   visible frame the edge zones are measured from. Measured live rather than cached, so
 *   scrolling mid-drag cannot offset the pointer.
 * - THE EDGE RAILS. Holding a block near either end of the grid pages the week; the rails
 *   are how that is discovered before it is triggered, and how the wait is made legible
 *   while it runs. The rule itself lives in `edgePaging.ts` and the timing in
 *   `useBlockDrag`; this draws it.
 * - THE WEEK CHANGE ITSELF. Which way the calendar just travelled is a fact only this
 *   component can see (it is the only place two consecutive weeks are ever compared), so it
 *   owns `useWeekSlide` and the class that draws it.
 * - THE SETTLE. A drop writes a queue rank, so a row lands where the reflow put it. The
 *   grid knows both the released position and the settled one, so it is where the row
 *   is animated from one to the other.
 * - PLACEMENT MODE. While a split fragment is waiting for a target, the columns take the
 *   click instead of the blocks under them.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { IconChevronLeft, IconChevronRight } from '@tabler/icons-react';
import { useFormat } from '../../lib/useFormat';
import { addDays } from '../../lib/dates';
import { netMinutesOf } from '../../lib/manualWindow';
import { fillStartFor, planDropSpill, spillByDay, type SpillDay } from '../../lib/dropSpill';
import { planCloseDay, type CloseDayInput, type CloseDayRequest } from '../../lib/closeDay';
import type { Gap } from '../../types';
import type { WeekBlock, WeekDay, WeekView } from '../../lib/api-client';
import { CalendarBlock } from './CalendarBlock';
import {
  axisTicks,
  clampDropStart,
  emptyLabelMinutes,
  nonWorkingBands,
  slotAt,
  type GridMetrics,
  type Timeline,
} from './geometry';
import {
  buildDropQueue,
  dayHoldsMinutes,
  dayReflowsOn,
  dropPins,
  dropPredecessor,
  footprintEnd,
  footprintWithinDay,
  resolveDropPreview,
  type DropEffect,
  type DropResolution,
  type QueueRow,
} from './dropEffect';
import { buildRuns, groupBlocks, packDay, segmentsOf, type BlockGroup, type BlockRun } from './grouping';
import { EDGE_ZONE_PX, type EdgeHold, type EdgeSide } from './edgePaging';
import { usePressHint, type DragController, type DragTarget, type InertReason } from './useBlockDrag';
import styles from './WeekGrid.module.css';

/** A fragment waiting for the click that says where it goes. */
export interface PlacingFragment {
  blockId: string;
  projectName: string;
  color: string;
  durationMinutes: number;
}

/**
 * THE DROP AS THE REFLOW WILL LAY IT OUT — the ghost of a drop that is a queue RANK, which
 * since *Fill and Overflow, Always* is a set of rows across DAYS rather than one rectangle on
 * one column.
 *
 * `null` (see `ghost` in `WeekGrid`) for every gesture whose minute is the promise: a resize,
 * and a drop that lands literally. Those keep the literal drawing, the roll and the clamp.
 */
interface GhostPlan {
  /** The day the pointer released on — which may take none of the hours. */
  date: string;
  /** Every row the hours will be stored as, in calendar order, over every column. */
  pieces: readonly { date: string; startMinutes: number; durationMinutes: number }[];
  /** The same, one entry per DAY: what the label's «4 h el lunes · 2 h el martes» reads. */
  byDay: readonly { date: string; minutes: number }[];
  /** Hours that carry on past the week on screen. */
  beyondMinutes: number;
  /** The row the drop ranks itself behind, or `null` when the queue reaches back further. */
  rankAfter: QueueRow | null;
}

/** Where a row was released, so the grid can animate it to where it landed. */
export interface SettleRequest {
  blockId: string;
  date: string;
  startMinutes: number;
  /**
   * The week as it was WHEN THE ROW WAS RELEASED.
   *
   * The animation has to run against the SETTLED layout, and the mutation's refetch is
   * still in flight when the request is made — so the grid waits until `view` is no
   * longer this object. Without it the row slides from the drop point back to where it
   * already was, which reads as "the drop was rejected" when in fact it worked.
   */
  after: WeekView | null;
}

export interface WeekGridProps {
  view: WeekView;
  timeline: Timeline;
  /** Another week is loading: keep this one visible but inert. */
  stale: boolean;
  /** A mutation is in flight. */
  busy: boolean;
  drag: DragController;
  placing: PlacingFragment | null;
  onPlace: (slot: { date: string; startMinutes: number }) => void;
  onOpenJob: (projectId: string) => void;
  /** Wired only when the gap form exists; without it gaps are labels. */
  onOpenGap?: (gap: Gap) => void;
  onToggleLock: (block: WeekBlock) => void;
  /**
   * "Back to automatic" for a whole unit: every row whose LENGTH the owner drew. The
   * padlock is not part of it — that mark is visible on the row and comes off with the
   * padlock.
   */
  onReleaseDuration: (blockIds: readonly string[]) => void;
  /**
   * "Stop the day here". Wired only when the gap form exists — it opens that form
   * pre-filled, since the gap is what makes the day hold fewer hours.
   */
  onCloseDay?: (request: CloseDayRequest) => void;
  onSplit: (block: WeekBlock) => void;
  onDelete: (block: WeekBlock) => void;
  /**
   * A press the grid cannot turn into a gesture, saying why — the same sentence a press on
   * a block gets, for the two things on the grid that are not blocks.
   *
   * `gap`: gaps have no drop rules (their date and time live in their form), so a drag of
   * one has nothing to start. `busy`: a save is in flight, and the gap's form is withheld
   * until it lands — which used to be a `disabled` button, i.e. a press that did nothing at
   * all and said nothing, in the second right after every mutation.
   */
  onPressHint: (reason: InertReason) => void;
  metricsRef: React.MutableRefObject<(() => GridMetrics | null) | null>;
  settle: SettleRequest | null;
  onSettled: () => void;
}

export function WeekGrid({
  view,
  timeline,
  stale,
  busy,
  drag,
  placing,
  onPlace,
  onOpenJob,
  onOpenGap,
  onToggleLock,
  onReleaseDuration,
  onCloseDay,
  onSplit,
  onDelete,
  onPressHint,
  metricsRef,
  settle,
  onSettled,
}: WeekGridProps): React.JSX.Element {
  const { t } = useTranslation();
  const format = useFormat();
  const gridRef = useRef<HTMLDivElement | null>(null);
  // The visible box: the grid can be WIDER than this and scroll inside it on a narrow
  // window, which is exactly why the edge zones are measured from the frame and not from
  // the first and last columns. See `GridMetrics.frame`.
  const frameRef = useRef<HTMLDivElement | null>(null);
  // Two hints for the one thing on the grid that is not a block. Which one a gap arms
  // depends on why it cannot be dragged right now; both are the same promise as a block's.
  const onPressGap = usePressHint(() => onPressHint('gap'));
  // Every press answers, travelled or not: while a save is in flight the gap's form is
  // withheld, so there is no click to fall back on.
  const onPressGapBusy = usePressHint(() => onPressHint('busy'), true);

  const measure = useCallback((): GridMetrics | null => {
    const root = gridRef.current;
    if (root === null) return null;
    const cells = [...root.querySelectorAll<HTMLElement>('[data-day-column]')];
    if (cells.length === 0) return null;

    const columns = cells.map((cell) => {
      const box = cell.getBoundingClientRect();
      return { date: cell.dataset.dayColumn ?? '', left: box.left, width: box.width };
    });
    const frameBox = frameRef.current?.getBoundingClientRect();
    const last = columns[columns.length - 1];
    // The frame if it has been measured; the columns' own span before that, which is the
    // same number whenever the week fits without scrolling.
    const left = frameBox === undefined ? columns[0].left : frameBox.left;
    const right = frameBox === undefined ? last.left + last.width : frameBox.right;
    return {
      top: cells[0].getBoundingClientRect().top,
      columns,
      frame: {
        left,
        right,
        // The time-axis gutter, which belongs to no day — so the strip may as well be all
        // of it, and has to be: a narrower one leaves the hour labels sliced down the
        // middle for the whole drag. `.edgePrevious` draws itself over the same width.
        leftZone: Math.max(EDGE_ZONE_PX, columns[0].left - left),
        rightZone: EDGE_ZONE_PX,
      },
    };
  }, []);

  useEffect(() => {
    metricsRef.current = measure;
    return () => {
      metricsRef.current = null;
    };
  }, [measure, metricsRef]);

  const columnWidths = useColumnWidths(gridRef, measure, view.week.dates.join());

  // Which way the calendar just travelled, or `null` on the first week and on any render
  // that is not a page turn. The columns and the headers slide in from that side.
  const slide = useWeekSlide(view.week.startDate);

  // One pass over the week: the rows of each day, grouped into units and packed into
  // lanes so hand-made overlaps (allowed on the weekend and in the past) stay visible.
  const layout = useMemo(() => buildLayout(view), [view]);
  const ticks = useMemo(() => axisTicks(view.shape.periods, timeline), [view.shape.periods, timeline]);

  /**
   * THE QUEUE, so a re-ranking drop can say what it really means.
   *
   * On Monday-Thursday a drop writes a place in this order and the reflow decides the
   * clock, so the only true thing a ghost can print is the row it will fall in behind. Built
   * once for the whole week rather than per column, because the row a Thursday drop ranks
   * itself after is usually on Wednesday.
   */
  const queue = useMemo<QueueRow[]>(() => {
    const reflowing = new Set(
      view.days.filter((day) => !day.isPast && !day.isWeekend).map((day) => day.date),
    );
    return buildDropQueue(view.blocks, (date) => reflowing.has(date));
  }, [view.blocks, view.days]);

  /**
   * WHERE THE DROP'S HOURS WILL REALLY GO, while the pointer is still down — *Fill and
   * Overflow, Always* drawn instead of described.
   *
   * A drop that is only a queue RANK has no footprint to fit any more: the engine takes what
   * the day has left from the work in front of it and carries the rest to the next day it can
   * use. So the ghost is not one rectangle on one column — it is the ROWS the gesture will be
   * stored as, and for a 6 h release into a 4 h afternoon that is 4 h here and 2 h on the next
   * column. Everything the drag layer used to say instead («6 h no pueden empezar después de
   * las 13:00», «no caben en un solo día») was the deleted rule talking.
   *
   * Computed once for the WEEK rather than per column, because the answer spans columns, and
   * `null` for every gesture whose minute really is the promise — a resize, and a drop that
   * lands LITERALLY (the buffer, the weekend, a margin, a padlocked row). There the roll, the
   * clamp and the end-of-day refusal still apply and the old drawing is exactly right.
   */
  const planDrop = useCallback(
    (input: {
      date: string;
      startMinutes: number;
      durationMinutes: number;
      /** Rows the gesture takes OFF the calendar, so they are not obstacles to themselves. */
      movingBlockIds: readonly string[];
    }): GhostPlan | null => {
      const released = view.days.find((day) => day.date === input.date);
      if (released === undefined) return null;

      // The run in the air is not an obstacle to itself, and the hours it frees on its old day
      // are hours the reflow may use.
      const moving = new Set(input.movingBlockIds);
      const rowsOn = (date: string): WeekBlock[] =>
        view.blocks.filter((block) => block.date === date && !moving.has(block.id));
      const gapsOn = (date: string): Gap[] => view.gaps.filter((gap) => gap.date === date);
      // What nothing will move out of the way, which is exactly what the engine treats as an
      // obstacle: a gap and a padlocked row. Ordinary work is ranked BEHIND the drop now, so it
      // is laid out after these hours rather than costing them room.
      const immovableOn = (date: string) =>
        [...gapsOn(date), ...rowsOn(date).filter((row) => row.locked)].map((row) => ({
          startMinutes: row.startMinutes,
          durationMinutes: row.durationMinutes,
        }));

      // The hours begin where the work in FRONT of them ends — see `fillStartFor`. Measured
      // against everything on the day, because strict queue order keeps all of it in front.
      const fromMinutes = fillStartFor(
        released.periods,
        [...gapsOn(input.date), ...rowsOn(input.date)],
        input.startMinutes,
      );
      // The day's stop-line less what the work ahead of the drop has already spent of it.
      // `plannableMinutes` has the gaps and the locks out of it already; ordinary rows are what
      // is left to account for, and only the part of them above the fill start.
      const spentAhead = rowsOn(input.date)
        .filter((row) => !row.locked)
        .reduce(
          (total, row) =>
            total + Math.max(0, Math.min(row.durationMinutes, fromMinutes - row.startMinutes)),
          0,
        );

      const days: SpillDay[] = [
        {
          date: input.date,
          periods: released.periods,
          immovable: immovableOn(input.date),
          budgetMinutes: Math.max(0, released.plannableMinutes - spentAhead),
          fromMinutes,
        },
        // The days the overflow may use: the ones the engine lays out, and not the colchón —
        // the buffer takes overflow only from work that GREW (`acceptsItem`), so a moved run's
        // remainder skips Friday exactly as a new job's tail does.
        ...view.days
          .filter((day) => day.date > input.date && dayReflowsOn(day) && day.role !== 'buffer')
          .map((day) => ({
            date: day.date,
            periods: day.periods,
            immovable: immovableOn(day.date),
            budgetMinutes: day.plannableMinutes,
          })),
      ];

      const spill = planDropSpill({ days, durationMinutes: input.durationMinutes });
      return {
        date: input.date,
        pieces: spill.pieces,
        byDay: spillByDay(spill.pieces),
        beyondMinutes: spill.beyondMinutes,
        // The one true thing a rank can say about its position: the row it falls in behind.
        rankAfter: dropPredecessor(queue, input.movingBlockIds, input.date, input.startMinutes),
      };
    },
    [view, queue],
  );

  const ghost = useMemo<GhostPlan | null>(() => {
    const preview = drag.preview;
    const target = drag.target;
    if (preview === null || target === null) return null;
    if (preview.kind !== 'move' || !preview.allowed || preview.pinned === true) return null;
    return planDrop({
      date: preview.date,
      startMinutes: preview.startMinutes,
      durationMinutes: preview.durationMinutes,
      movingBlockIds: target.blockIds,
    });
  }, [drag.preview, drag.target, planDrop]);

  useSettleAnimation({ gridRef, settle, timeline, view, onSettled });

  // Where the fragment would land. Only tracked while placing, so the grid does not
  // re-render on every mouse move the rest of the time.
  const [hover, setHover] = useState<{ date: string; startMinutes: number } | null>(null);
  useEffect(() => {
    if (placing === null) setHover(null);
  }, [placing]);

  /**
   * THE SAME ANSWER FOR THE SCISSORS' SECOND CLICK. A fragment is a drop: on a day the engine
   * lays out it takes a queue rank, so its hours fill what the day has left and the rest
   * carries on, and the preview has to draw that rather than one rectangle running into the
   * bottom margin — which is what capping it at the day's manual window produced once the
   * clamp stopped pulling it up the column.
   *
   * `movingBlockIds` is EMPTY here, and that is the difference from a drag: the source row does
   * not leave the calendar, it only gets shorter, so it is still in front of the fragment in
   * the queue and still holds its minutes.
   */
  const placingGhost = useMemo<GhostPlan | null>(() => {
    if (placing === null || hover === null) return null;
    const day = view.days.find((candidate) => candidate.date === hover.date);
    if (day === undefined || day.isPast) return null;
    if (
      dropPins({
        locked: false,
        role: day.role,
        periods: day.periods,
        manualWindows: day.manualWindows,
        startMinutes: hover.startMinutes,
        durationMinutes: placing.durationMinutes,
      })
    ) {
      return null;
    }
    return planDrop({
      date: hover.date,
      startMinutes: hover.startMinutes,
      durationMinutes: placing.durationMinutes,
      movingBlockIds: [],
    });
  }, [placing, hover, view.days, planDrop]);

  const slotUnder = useCallback(
    (event: { clientX: number; clientY: number }): { date: string; startMinutes: number } | null => {
      const metrics = measure();
      if (metrics === null) return null;
      const hit = slotAt({ x: event.clientX, y: event.clientY }, metrics, timeline);
      if (hit === undefined) return null;
      const day = view.days.find((candidate) => candidate.date === hit.date);
      const durationMinutes = placing?.durationMinutes ?? 0;
      /*
       * CLAMPED OVER THE DAY ONLY WHERE THE FRAGMENT LANDS LITERALLY — the weekend, the
       * colchón, a visual margin (2026-08-17).
       *
       * There the fragment is a row stored exactly where it is put, and a row ends inside its
       * day: both the ghost and the click that commits it read this one answer, so the
       * scissors cannot promise 19:45 and then store a row running to 20:45. On a day the
       * engine lays out the click is a queue RANK, and pulling it up to "the latest start that
       * fits" is the deleted rule — it would rank a 6 h fragment aimed at the afternoon back
       * inside the morning, cutting a row nobody aimed at, when the reflow would have filled
       * the afternoon and carried the rest to the next day.
       */
      const literal =
        day === undefined ||
        dropPins({
          locked: false,
          role: day.role,
          periods: day.periods,
          manualWindows: day.manualWindows,
          startMinutes: hit.snappedMinutes,
          durationMinutes,
        });
      return {
        date: hit.date,
        startMinutes: literal
          ? clampDropStart(day?.manualWindows ?? [], hit.snappedMinutes, durationMinutes, timeline)
          : hit.snappedMinutes,
      };
    },
    [measure, placing, timeline, view.days],
  );

  return (
    <div className={styles.frame} ref={frameRef}>
      {/*
       * THE TWO EDGE RAILS, drawn for as long as a block is in the air and never otherwise.
       *
       * This is the whole answer to "how does anyone find out the gesture exists": the
       * first time the owner picks a block up, both ends of the calendar name the week
       * they lead to. Nothing has to be triggered by accident first, and nothing is on
       * screen when there is nothing to drag.
       *
       * Not drawn for a RESIZE: its edge belongs to one row on one day, and another week
       * has nothing to offer it.
       */}
      {drag.kind !== 'move' ? null : (
        <>
          <EdgeRail side="previous" week={view.week} hold={drag.edge} />
          <EdgeRail side="next" week={view.week} hold={drag.edge} />
        </>
      )}

      <div className={styles.scroll}>
        <div
          ref={gridRef}
          className={[styles.grid, placing === null ? '' : styles.placing, stale ? styles.stale : '']
            .filter(Boolean)
            .join(' ')}
          style={{ '--ww-timeline-height': `${timeline.height}px` } as React.CSSProperties}
          role="group"
          aria-label={t('grid.label')}
          onPointerMove={placing === null ? undefined : (event) => setHover(slotUnder(event))}
          onPointerLeave={placing === null ? undefined : () => setHover(null)}
          onClick={
            placing === null
              ? undefined
              : (event) => {
                  const slot = slotUnder(event);
                  if (slot !== null) onPlace(slot);
                }
          }
        >
          <div className={`${styles.head} ${styles.headAxis}`}>
            <span className="ww-visually-hidden">{t('grid.timeAxis')}</span>
          </div>

          {view.days.map((day) => (
            <DayHeader key={day.date} day={day} slide={slide} />
          ))}

          <div className={styles.axis} aria-hidden="true">
            {ticks.map((tick) => (
              <span
                key={tick.minutes}
                /*
                 * The two hanging classes are keyed on the MINUTE, not on the tick's index in
                 * the list. `axisTicks` may now drop either end of the axis when a period
                 * edge is too close to it to share the room (see its precedence note), and
                 * by index the label that inherited position 0 would be hung below its rule
                 * while `labelBox` had measured it as centred — the collision arithmetic and
                 * the paint disagreeing by a whole label. `labelBox` tests the minute
                 * against the axis bounds, so this tests exactly the same thing.
                 */
                className={[
                  styles.tick,
                  tick.boundary ? styles.tickBoundary : '',
                  tick.minutes <= timeline.startMinutes ? styles.tickFirst : '',
                  tick.minutes >= timeline.endMinutes ? styles.tickLast : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
                style={{ top: `${timeline.yOf(tick.minutes)}px` }}
              >
                {format.time(tick.minutes)}
              </span>
            ))}
          </div>

          {view.days.map((day) => (
            <DayColumn
              key={day.date}
              day={day}
              groups={layout.groups.get(day.date) ?? []}
              gaps={layout.gaps.get(day.date) ?? []}
              lanes={layout.lanes.get(day.date) ?? new Map()}
              runs={layout.runs}
              columnWidth={columnWidths.get(day.date) ?? null}
              ticks={ticks}
              timeline={timeline}
              slide={slide}
              gapColor={view.settings.gapColor}
              busy={busy || stale}
              ghost={ghost}
              drag={drag}
              placing={placing}
              placingSlot={hover}
              placingGhost={placingGhost}
              onOpenJob={onOpenJob}
              onOpenGap={onOpenGap}
              onPressGap={onPressGap}
              onPressGapBusy={onPressGapBusy}
              onToggleLock={onToggleLock}
              onReleaseDuration={onReleaseDuration}
              onCloseDay={onCloseDay}
              onSplit={onSplit}
              onDelete={onDelete}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The edge rails
// ---------------------------------------------------------------------------

/**
 * ONE END OF THE CALENDAR, while a block is in hand: the strip that pages the week when
 * the block is held over it.
 *
 * It does three jobs, and the gesture is unusable without any of them:
 *
 * - IT SAYS THE AFFORDANCE EXISTS, before it is triggered and without a legend. The owner
 *   reported the gesture as missing («no sé cómo funciona o no lo he conseguido hacer
 *   funcionar») when it had never been built — but a hot zone with nothing drawn over it
 *   is indistinguishable from that, because it can only be discovered by falling into it.
 * - IT NAMES THE DESTINATION. Not "next week" but the dates themselves, so the owner reads
 *   where they are going before they commit and again while the calendar pages under them.
 * - IT MAKES THE WAIT LEGIBLE. The fill takes exactly as long as the countdown running in
 *   the drag layer (`EdgeHold.delayMs`, published rather than re-derived here), so half a
 *   second of holding still reads as progress instead of as an app that has stopped
 *   listening. It restarts on every turn because the element is keyed on the turn count.
 *
 * It is `pointer-events: none`, and it is exactly as wide as the zone it draws — the
 * minimum on the right, the time-axis gutter on the left, the same two numbers `measure()`
 * hands the drag layer. The rail must cover its own trigger and nothing else, and it must
 * never take the pointer: a release on the rail is still a drop on the column under it.
 */
function EdgeRail({
  side,
  week,
  hold,
}: {
  side: EdgeSide;
  week: WeekView['week'];
  hold: EdgeHold | null;
}): React.JSX.Element {
  const { t } = useTranslation();
  const format = useFormat();

  const offset = side === 'previous' ? -7 : 7;
  const range = format.weekRange(addDays(week.startDate, offset), addDays(week.endDate, offset));
  const active = hold !== null && hold.side === side;

  return (
    <div
      className={[
        styles.edge,
        side === 'previous' ? styles.edgePrevious : styles.edgeNext,
        active ? styles.edgeActive : '',
      ]
        .filter(Boolean)
        .join(' ')}
      // The width the zone really has: the minimum on the right, and on the left whatever
      // the time-axis gutter is (`.edgePrevious` takes the max, from the same variable the
      // grid's own column template uses). The rail must cover its trigger exactly.
      style={{ '--ww-edge-zone': `${EDGE_ZONE_PX}px` } as React.CSSProperties}
      // The paging it offers is also on two named buttons in the header, so nothing is
      // lost by keeping a decorative strip out of the accessibility tree.
      aria-hidden="true"
    >
      {!active ? null : (
        <span
          // Keyed on the turn, so the fill restarts from empty for each page turn of a
          // long hold instead of freezing full after the first.
          key={`${hold.turns}-${hold.waiting}`}
          className={[styles.edgeFill, hold.waiting ? styles.edgeWaiting : ''].filter(Boolean).join(' ')}
          style={hold.waiting ? undefined : { animationDuration: `${hold.delayMs}ms` }}
        />
      )}
      <span className={styles.edgeGlyph}>
        {side === 'previous' ? (
          <IconChevronLeft size={16} stroke={2} />
        ) : (
          <IconChevronRight size={16} stroke={2} />
        )}
      </span>
      <span className={styles.edgeLabel}>
        {t(side === 'previous' ? 'grid.edgePrevious' : 'grid.edgeNext', { range })}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Day header
// ---------------------------------------------------------------------------

function DayHeader({ day, slide }: { day: WeekDay; slide: WeekSlide }): React.JSX.Element {
  const { t } = useTranslation();
  const format = useFormat();

  // One word, the way the wireframe writes it: "Lun 10 · congelado", "Vie 14 · colchón".
  // Past wins over everything, because a frozen Friday is not a buffer any more.
  const state = day.isPast
    ? t('day.frozen')
    : day.isClosed
      ? t('day.closed')
      : day.role === 'buffer'
        ? t('day.buffer')
        : null;

  const freeMinutes = Math.max(0, day.capacityMinutes - day.bookedMinutes);
  const lines = [
    // A weekend or a closed day has no auto-fill capacity to report, only a rule.
    day.isWeekend || day.isClosed || day.isPast
      ? null
      : t('day.occupancy', {
          booked: format.hourNumber(day.bookedMinutes),
          capacity: format.hourNumber(day.capacityMinutes),
        }),
    day.isWeekend || day.isClosed || day.isPast
      ? null
      : freeMinutes === 0
        ? t('day.full')
        : t('day.freeHours', { hours: format.hourNumber(freeMinutes) }),
    day.isPast
      ? t('day.frozenHint')
      : day.isClosed
        ? t('day.closedHint')
        : day.isWeekend
          ? t('day.weekendHint')
          : day.isToday
            ? t('day.todayHint')
            : day.role === 'buffer'
              ? t('day.bufferHint')
              : null,
    day.note === undefined ? null : t('day.note', { note: day.note }),
  ].filter((line): line is string => line !== null);

  return (
    <div
      className={[
        styles.head,
        day.isWeekend ? styles.headWeekend : '',
        day.isPast ? styles.headPast : '',
        // The header carries the DATE, which is what a page turn really changes, so it
        // travels with the columns rather than being the one thing that jumps.
        slideHeadClass(slide),
      ]
        .filter(Boolean)
        .join(' ')}
      title={lines.join('\n')}
    >
      <span className={styles.headName}>{format.dayHeader(day.date)}</span>
      {day.isToday ? <span className={styles.headToday}>{t('day.today')}</span> : null}
      {state === null ? null : <span className={styles.headState}>{state}</span>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Day column
// ---------------------------------------------------------------------------

interface DayColumnProps {
  day: WeekDay;
  groups: BlockGroup[];
  gaps: Gap[];
  lanes: Map<string, { lane: number; lanes: number }>;
  /** The whole week's runs, keyed by group id: what a drag of a unit picks up. */
  runs: Map<string, BlockRun>;
  /**
   * This column's measured width in pixels, or `null` before the first measurement. Only
   * the hover action bar reads it — see `CalendarBlockProps.blockWidth`.
   */
  columnWidth: number | null;
  ticks: { minutes: number; boundary: boolean }[];
  timeline: Timeline;
  /** Which way the calendar just travelled, for the entry animation. */
  slide: WeekSlide;
  gapColor: string;
  /**
   * NOTHING CAN BE WRITTEN RIGHT NOW: a mutation is in flight, or the week is reloading.
   * It disables the action bar, and it is the reason a press on a block explains itself
   * (`InertReason.busy`) instead of quietly doing nothing.
   */
  busy: boolean;
  /**
   * THE WHOLE GESTURE'S GHOST, or `null` when it is a literal placement — see `GhostPlan`.
   * Every column reads it, because a drop's hours now land on more than one of them: the
   * column draws the pieces that are its own and nothing else.
   */
  ghost: GhostPlan | null;
  drag: DragController;
  placing: PlacingFragment | null;
  /** The slot the pointer is over while placing a fragment. */
  placingSlot: { date: string; startMinutes: number } | null;
  /**
   * The fragment's hours as the reflow will lay them out, or `null` when it lands literally
   * (the weekend, the colchón, a margin) and the slot itself is the promise. Same shape and
   * same arithmetic as a drag's `ghost`, because a fragment is a drop.
   */
  placingGhost: GhostPlan | null;
  onOpenJob: (projectId: string) => void;
  onOpenGap?: (gap: Gap) => void;
  /** Arms the "a gap is not dragged" hint. One handler for every gap on the grid. */
  onPressGap: (event: React.PointerEvent) => void;
  /** The same, for a gap pressed while a save is in flight: it says "wait" instead. */
  onPressGapBusy: (event: React.PointerEvent) => void;
  onToggleLock: (block: WeekBlock) => void;
  onReleaseDuration: (blockIds: readonly string[]) => void;
  onCloseDay?: (request: CloseDayRequest) => void;
  onSplit: (block: WeekBlock) => void;
  onDelete: (block: WeekBlock) => void;
}

const SINGLE_LANE = { lane: 0, lanes: 1 };

function DayColumn({
  day,
  groups,
  gaps,
  lanes,
  runs,
  columnWidth,
  ticks,
  timeline,
  slide,
  gapColor,
  busy,
  ghost,
  drag,
  placing,
  placingSlot,
  placingGhost,
  onOpenJob,
  onOpenGap,
  onPressGap,
  onPressGapBusy,
  onToggleLock,
  onReleaseDuration,
  onCloseDay,
  onSplit,
  onDelete,
}: DayColumnProps): React.JSX.Element {
  const { t } = useTranslation();
  const format = useFormat();

  const bands = nonWorkingBands(day.periods, timeline);
  const preview = drag.preview?.date === day.date ? drag.preview : null;
  /**
   * THE GESTURE ITSELF, whichever column it was released over.
   *
   * `preview` is this column's own view of it and is null on every other column. The ghost's
   * COLOUR and its TOTAL HOURS belong to the whole drag, and since a drop's hours now land on
   * the next column too (`GhostPlan`), they are needed where there is no `preview` at all.
   */
  const gesture = drag.preview;

  /*
   * IS THIS COLUMN'S CONTENT TRAVELLING RIGHT NOW? True from the mount of a column that
   * arrived with a page turn until its entry animation ends, and false for ever after.
   *
   * It exists so the sideways clip that keeps the slide inside the grid (`.columnSliding`,
   * and the note on `.column`) lasts exactly as long as the slide does. The clip may NOT be
   * permanent: the SETTLE animates a row in from the column it was released over, so `dx` is
   * a whole column width, and a column that clipped for ever would hide most of that
   * journey — trading one animation for another.
   *
   * `slide` cannot be used directly for this. It is the direction of the LAST page turn and
   * stays non-null for the rest of the session, which is what makes it correct for the
   * animation (a column is remounted by a page turn, so the class is present exactly when a
   * fresh element needs it) and useless as "is it moving now".
   *
   * `animationend` always arrives: the animation has a non-zero duration and one iteration,
   * and `prefers-reduced-motion` shortens it to 0.01 ms rather than removing it.
   */
  const [sliding, setSliding] = useState(slide !== null);

  /**
   * DOES THE GHOST DRAW A PLACE OR A RANK?
   *
   * The whole reason the drag felt broken. A move onto Monday-Thursday writes a place in
   * the queue and the reflow picks the clock — often another day entirely — so a ghost
   * reading `09:00–14:00` over Thursday was promising something the drop could not
   * produce, and the row settling on Wednesday at 12:00 read as the app ignoring the drag.
   *
   * So the two are drawn as different things. A PINNED drop (the weekend, the colchón, a
   * locked unit) keeps the minute it was released on, so its rectangle is the answer and
   * the clock range is a promise. A RE-RANKED drop is an INSERTION POINT: the rectangle is
   * only where the owner is aiming, and what it says is the row it will fall in behind.
   *
   * A resize is neither — it sizes its own row in place — so it keeps the literal reading.
   */
  /**
   * WHAT THE SERVER WILL ACTUALLY DO WITH THIS DROP — the minute it will be stored at,
   * whether that minute is a promise, and what it does to the row underneath.
   *
   * All three come from one call because the server decides them together: a pinned drop
   * that lands on a gap or a lock is SLID forward on the day the owner named, and if the
   * day has no clear slot it gives up the pin and becomes a queue rank. Computed here
   * rather than in the gesture because only the grid has the day's rows and gaps.
   */
  const resolution = useMemo<DropResolution | null>(() => {
    // Nothing to promise about a drop that will not be accepted (a past day), and a
    // resize touches only its own row.
    if (preview === null || !preview.allowed || preview.kind !== 'move') return null;
    if (drag.target === null) return null;
    return resolveDropPreview({
      rows: groups.flatMap((group) => group.blocks),
      // Gaps are occupancy too: on a day that pins AND does not reflow a drop onto one is
      // refused, and on a day that reflows it is what the drop is slid past.
      gaps,
      movingBlockIds: drag.target.blockIds,
      projectId: drag.target.projectId,
      dayIsWeekend: day.isWeekend,
      // The gesture asked the whole pin question — the day AND the slot — so it is not
      // re-derived here. See `DragPreview.pinned`.
      pinned: preview.pinned === true,
      // The engine lays this day out, so a collision here can never refuse the drop.
      dayReflows: dayReflowsOn(day),
      locked: drag.target.locked,
      // The drop is cut at this day's own break, so its footprint is measured against
      // this day's MANUAL WINDOWS rather than the rectangle the pointer drew — the
      // margins are hand time, and the server cuts the drop over the same view.
      manualWindows: day.manualWindows,
      startMinutes: preview.startMinutes,
      durationMinutes: preview.durationMinutes,
    });
  }, [preview, drag.target, groups, gaps, day]);

  /**
   * A RANK, NOT A PLACE. One question, asked of the whole gesture rather than of this column:
   * `ghost` is non-null exactly when the drop is a queue rank, which is exactly when the
   * ghost's minutes are an aim and its clock range would be a promise nothing made.
   */
  const ranked = ghost !== null;

  /** Where the ghost is really drawn: the release point, or the slid one. */
  const ghostStartMinutes = resolution?.startMinutes ?? preview?.startMinutes ?? 0;

  /**
   * The row a re-ranked drop lands behind, if the week on screen can see it. `null` says
   * the queue reaches back further than this week, and the ghost falls back to naming the
   * rank without naming a neighbour rather than claiming a first place it cannot check.
   *
   * Read off the plan rather than recomputed here, because the rank belongs to the RELEASE and
   * the label may be drawn on another column — a drop into ten free minutes takes none of them
   * and its first row is on the next day.
   */
  const rankAfter = ghost?.rankAfter ?? null;

  /**
   * THE PIECES OF THE GESTURE THAT LAND ON THIS COLUMN, and the one that carries the label.
   *
   * A drop's hours fill what the day has left and carry on, so the ghost is drawn on every
   * column they reach: the release column, the day after it, sometimes the day after that.
   * The FIRST piece of the whole gesture carries the sentence — normally on the release
   * column, and on the next one when the release day could not take a single legal row.
   */
  const spillPieces = ghost === null ? [] : ghost.pieces.filter((piece) => piece.date === day.date);
  const carriesLabel =
    ghost === null
      ? preview !== null
      : (ghost.pieces[0]?.date ?? ghost.date) === day.date;
  /** This column's own share of the hours, for the bare "…sigue" label on a continuation. */
  const spillMinutes = spillPieces.reduce((total, piece) => total + piece.durationMinutes, 0);

  /**
   * What the drop hovering over this column will do to the row underneath it — a cut,
   * a displacement, a merge, or a refusal. `null` for a resize (which touches only its
   * own row) and whenever the ghost is over free time.
   */
  const dropEffect: DropEffect | null = resolution?.effect ?? null;

  /**
   * The rectangles the ghost is drawn as: one per row the gesture will be STORED as.
   *
   * A move crossing the lunch break comes back from the server as two rows (CLAUDE.md,
   * *A Drop Is Stored In Segments*), so drawing one rectangle straight through the grey
   * band promises a shape that will never exist. SINCE 2026-08-13 A RESIZE CROSSES THE
   * BREAK TOO — dragging a 10:00 row to 17:30 stores `10:00-14:00` plus `15:30-17:30` —
   * so both gestures are drawn through the same segmentation, and a resize past the break
   * shows the two rectangles with the lunch band left clear rather than one tall block
   * swallowing it.
   *
   * `footprintWithinDay` rather than `dropFootprint`: a RUN longer than the day has no
   * storable footprint here, and the storage answer for that case is one UNCUT segment —
   * which drew a single rectangle over the whole column, hatched lunch band included, for
   * every multi-day run the owner picked up. Capped at what the day holds, the shape is a
   * shape that can exist again.
   *
   * A DROP THAT IS A RANK IS DRAWN FROM THE PLAN INSTEAD (2026-08-17), because the day no
   * longer takes all of it or none of it: `GhostPlan.pieces` are the rows the reflow will
   * store, so they are cut at the break, stop where the day's periods do, skip what nothing
   * will move out of the way, and are never shorter than a quarter of an hour — every rule the
   * old single rectangle had to be capped and clamped into obeying.
   */
  const ghostRows: readonly { startMinutes: number; durationMinutes: number }[] =
    // The exotic case where not one of the days on screen can hold a legal row is left to the
    // literal drawing: something has to be under the pointer, and the label then says where
    // the hours really carry on to.
    ghost !== null && ghost.pieces.length > 0
      ? spillPieces
      : preview === null
        ? []
        : footprintWithinDay({
            manualWindows: day.manualWindows,
            // The SLID minute, not the released one: on a reflowing day a pinned drop over
            // a gap or a lock is moved forward by the server, and a ghost that stayed under
            // the pointer would promise a slot the row never takes.
            startMinutes: ghostStartMinutes,
            durationMinutes: preview.durationMinutes,
          });

  /**
   * Where the whole gesture ends on the clock — its last segment's end, lunch included —
   * or `null` when it does not end on this day at all.
   *
   * A MOVE'S `durationMinutes` IS THE WHOLE RUN'S, ACROSS DAYS (`DragTarget`,
   * `BlockRun.totalMinutes`), and a run does not end at a time of day: it ends on a later
   * DAY. Adding it to a start and printing the sum as an end-of-day produced `420 + 1080 =
   * 1500` for an 18 h run released at 07:00 — 25:00 — which `formatTime` rendered `--:--`
   * and complained about once per pointer move, forty times in one drag. Shorter overruns
   * were worse for being quiet: 13 h at 07:00 read as `21:30`, an hour past every rule the
   * grid draws.
   *
   * `footprintEnd` is the one place the question is answered, against the same line no
   * stored row may cross. A resize is unaffected — its duration is one stretch's, on this
   * day, already capped at the day's end — so the range it prints is as literal as before.
   */
  const ghostEndMinutes =
    preview === null
      ? null
      : footprintEnd({
          manualWindows: day.manualWindows,
          startMinutes: ghostStartMinutes,
          durationMinutes: preview.durationMinutes,
        });

  /**
   * NO START ON THIS DAY COULD HOLD THE GESTURE — its net minutes are more than the day's
   * own. Only a multi-day run gets here, and it is why the clamp has nothing true to say:
   * `latestStartFor` falls back to the first window's start when nothing fits, so the
   * ghost's «no pueden empezar después de las 07:00» claimed 07:00 would do.
   *
   * ASKED ONLY OF A DROP THAT LANDS LITERALLY (2026-08-17). On a day the engine lays out, "these
   * hours do not fit in one day" is the deleted rule speaking: the run takes what the day has
   * and the rest carries on, so what the ghost has to say there is the DIVISION, which the plan
   * draws and the label names. A resize keeps it — its length really is stored on one day.
   */
  const longerThanTheDay =
    preview !== null &&
    ghost === null &&
    !dayHoldsMinutes(day.manualWindows, preview.durationMinutes);

  /**
   * The day as the "stop the day here" planner reads it, or `null` where the action makes
   * no sense: the weekend and a closed day have no plannable hours to cap, and the past
   * is a record rather than a plan.
   */
  const closeDayInput = useMemo<CloseDayInput | null>(() => {
    if (onCloseDay === undefined || day.isPast || day.isWeekend || day.isClosed) return null;
    return {
      date: day.date,
      periods: day.periods,
      blocks: groups.flatMap((group) =>
        group.blocks.map((block) => ({
          id: block.id,
          projectId: block.projectId,
          name: block.project.name,
          startMinutes: block.startMinutes,
          durationMinutes: block.durationMinutes,
          locked: block.locked,
        })),
      ),
      gaps,
    };
  }, [onCloseDay, day, groups, gaps]);

  /**
   * «4 h el lun 17 · 2 h el mar 18» — WHAT BECOMES OF THE HOURS, named day by day, and the
   * one sentence this whole round exists for.
   *
   * Said only when there is something to say: hours that leave the day the pointer is on. All
   * of them staying here needs no sentence, because then the rectangle IS the answer — and the
   * days are named rather than counted, since "se parte en dos" would not tell the owner which
   * two days their week just changed on.
   */
  const carryTextFor = (plan: GhostPlan | null): string | null => {
    if (plan === null) return null;
    const parts = plan.byDay.map((part) => format.hoursOnDay(part.date, part.minutes));
    // The week on screen ran out before the hours did. The engine walks a whole planning
    // horizon, so this is "they carry on further along", never "they do not fit".
    if (plan.beyondMinutes > 0) {
      parts.push(t('grid.dropCarriesLater', { hours: format.hourNumber(plan.beyondMinutes) }));
    }
    if (parts.length < 2 && plan.byDay[0]?.date === plan.date) return null;
    return t('grid.dropFillsAndCarries', { parts: parts.join(t('units.listSeparator')) });
  };

  const carrySentence = carriesLabel ? carryTextFor(ghost) : null;

  /**
   * The same three answers for the scissors' fragment: the rectangles that are this column's,
   * whether this column carries the words, and what the words say about the other days.
   */
  const placingPieces =
    placingGhost === null ? [] : placingGhost.pieces.filter((piece) => piece.date === day.date);
  const placingRows: readonly { startMinutes: number; durationMinutes: number }[] =
    placing === null || placingSlot === null
      ? []
      : placingGhost !== null && placingGhost.pieces.length > 0
        ? placingPieces
        : placingSlot.date === day.date
          ? footprintWithinDay({
              manualWindows: day.manualWindows,
              startMinutes: placingSlot.startMinutes,
              durationMinutes: placing.durationMinutes,
            })
          : [];
  const placingCarriesLabel =
    placingGhost === null || placingGhost.pieces.length === 0
      ? placingSlot?.date === day.date
      : (placingGhost.pieces[0]?.date ?? placingGhost.date) === day.date;
  const placingCarry = placingCarriesLabel ? carryTextFor(placingGhost) : null;

  // "libre" on a working day with nothing on it, "—" on a day the engine never touches.
  const emptyLabel =
    groups.length > 0 || gaps.length > 0
      ? null
      : day.isWeekend || day.isClosed
        ? t('grid.emptyDay')
        : t('grid.free');

  return (
    <div
      className={[
        styles.column,
        day.isWeekend ? styles.columnWeekend : '',
        day.isClosed ? styles.columnClosed : '',
        sliding ? styles.columnSliding : '',
      ]
        .filter(Boolean)
        .join(' ')}
      data-day-column={day.date}
    >
      {bands.map((band) => (
        <div
          key={`${band.kind}-${band.startMinutes}`}
          /*
           * The break between two periods is drawn COMPRESSED — a hatched seam a few pixels
           * tall — while the margins keep the axis's ordinary scale, because the owner puts
           * real work in a margin by hand and none in the comida. The two therefore have to
           * read as different things, not as the same grey at two heights.
           */
          className={[styles.band, band.kind === 'lunch' ? styles.bandBreak : '']
            .filter(Boolean)
            .join(' ')}
          style={{
            top: `${timeline.yOf(band.startMinutes)}px`,
            // Between two CLOCK times, so the band covers exactly the compressed segment
            // the axis gave it.
            height: `${timeline.heightBetween(band.startMinutes, band.endMinutes)}px`,
          }}
          title={band.kind === 'lunch' ? t('grid.lunchBand') : t('grid.marginBand')}
        />
      ))}

      {ticks.map((tick) => (
        <div
          key={tick.minutes}
          className={[styles.line, tick.boundary ? styles.lineBoundary : ''].filter(Boolean).join(' ')}
          style={{ top: `${timeline.yOf(tick.minutes)}px` }}
        />
      ))}

      {/*
       * EVERYTHING IN THIS COLUMN THAT BELONGS TO THE WEEK, and nothing that belongs to the
       * gesture. The wrapper exists so the week-change animation has something to move that
       * is NOT the ghost: a block held at the edge pages the calendar, and the one rectangle
       * that must never slide out from under the pointer is the one promising where that
       * block will land. The ghost and the placing preview are siblings of this, below.
       *
       * `inset: 0` makes it the same box as the column, so every child keeps the exact
       * coordinates the timeline gave it.
       */}
      <div
        className={[styles.columnBody, slideClass(slide)].filter(Boolean).join(' ')}
        // Its own animation ending, not a block's `settling` bubbling up through it.
        onAnimationEnd={(event) => {
          if (event.target === event.currentTarget) setSliding(false);
        }}
      >
        {emptyLabel === null ? null : (
          // Placed on the day's own working time rather than at the column's midpoint,
          // which with the documented shift is 13:45 — on the lip of the lunch band and
          // a hair above the 14:00 rule, where the word read as debris. See
          // `emptyLabelMinutes`.
          <span
            className={styles.empty}
            style={{ top: `${timeline.yOf(emptyLabelMinutes(day.periods, timeline))}px` }}
          >
            {emptyLabel}
          </span>
        )}

        {gaps.map((gap) => {
          const lane = lanes.get(gap.id) ?? SINGLE_LANE;
          const label = format.dayTimeHours(gap.date, gap.startMinutes, gap.durationMinutes);
          const style = {
            '--ww-gap-color': gapColor,
            top: `${timeline.yOf(gap.startMinutes)}px`,
            // A GAP'S DURATION IS CLOCK MINUTES, not net working ones — "stop the day here"
            // runs one from a moment to the end of the last period, straight across the
            // lunch break — so it is the one occupancy on the grid that can contain the
            // compressed band, and it has to be measured between two times to cover it.
            height: `${timeline.heightBetween(gap.startMinutes, gap.startMinutes + gap.durationMinutes)}px`,
            left: `calc(${(lane.lane / lane.lanes) * 100}% + 2px)`,
            width: `calc(${100 / lane.lanes}% - 4px)`,
          } as React.CSSProperties;
          const reason = gap.reason ?? '';

          return onOpenGap === undefined ? (
            <div key={gap.id} className={styles.gap} style={style} title={`${reason}\n${label}`.trim()}>
              <span className={styles.gapReason}>{reason}</span>
            </div>
          ) : (
            <button
              key={gap.id}
              type="button"
              className={`${styles.gap} ${styles.gapButton}`}
              style={style}
              // The third line is the gesture vocabulary of a gap, which is short: it opens,
              // it does not drag. Said on the hover as well as on the failed drag, so the
              // owner can learn it without having to fail first.
              title={`${reason}\n${label}\n${t('grid.gapOpensHint')}`.trim()}
              /*
               * NOT `disabled` WHILE A SAVE IS IN FLIGHT, which is what this used to be. A
               * disabled button takes the press and drops it: no form, no drag, no message,
               * and nothing on screen even looks different — in the second right after every
               * mutation, which is exactly when the next press lands. The form is still
               * withheld; the press now says why.
               */
              aria-disabled={busy}
              // A press that turns into a drag has nothing to start here, so it says so —
              // otherwise the gesture ends with no click and no message. While busy the same
              // handler answers every press, so the click below stays silent rather than
              // repeating the sentence. See `usePressHint`.
              onPointerDown={busy ? onPressGapBusy : onPressGap}
              onClick={() => {
                if (!busy) onOpenGap(gap);
              }}
            >
              <span className={styles.gapReason}>{reason}</span>
            </button>
          );
        })}

        {/* The same view the grouping was read over, so a unit and its seam agree. */}
        {segmentsOf(groups, day.manualWindows).map((segment) => {
          const target = targetFor(segment.group, day, runFor(runs, segment.group));
          const closeDay = closeDayAfter(closeDayInput, segment.block);
          const lane = lanes.get(segment.group.id) ?? SINGLE_LANE;
          /*
           * WHY THIS PRESS CANNOT WRITE, when it cannot — and the press is still tracked, so
           * a CLICK still opens the job. `undefined` is the ordinary row.
           *
           * The past comes first because it is the stronger rule: a frozen day is a record of
           * what the shop did, so no gesture rewrites it (spec, 2026-08-13 — "on a past day:
           * no drag, no resize, no split"). It also closes a hole: `allowed` is worked out for
           * the day the ghost is OVER, so a past row dragged onto a future day was accepted
           * and history moved.
           */
          const inert = day.isPast ? ('past' as const) : busy ? ('busy' as const) : undefined;
          return (
            <CalendarBlock
              key={segment.block.id}
              segment={segment}
              timeline={timeline}
              lane={lane}
              // The block's own width, not the column's: `.block` is inset 2 px on each side
              // of its lane's share (see its inline `left`/`width`).
              blockWidth={columnWidth === null ? null : columnWidth / lane.lanes - 4}
              overflow={isOverflow(segment.group, day)}
              frozen={day.isPast}
              lifted={drag.liftedBlockIds.includes(segment.block.id)}
              cutAtMinutes={
                dropEffect?.kind === 'cut' && dropEffect.blockId === segment.block.id
                  ? dropEffect.cutMinutes
                  : undefined
              }
              busy={busy}
              onPointerDownBody={(event) => drag.beginMove(event, target, { inert })}
              // The hover bar is over the block, so it drags the block too — see
              // `BeginOptions.overlay` for the two things that keeps working.
              onPointerDownActions={(event) => drag.beginMove(event, target, { overlay: true, inert })}
              onPointerDownResize={(event) =>
                drag.beginResize(
                  event,
                  {
                    ...target,
                    // A move is the whole unit; a resize is the STRETCH THAT BEGINS AT THIS
                    // ROW — this row plus the rows of the unit that continue it after the
                    // break, which is the same stretch `resizeBlock` sizes on the server.
                    // Each row of a unit is its own rectangle with its own bottom edge, so
                    // the morning half's edge sizes "from 10:00 to wherever I let go" and
                    // the afternoon half's edge sizes only itself.
                    blockId: segment.block.id,
                    startMinutes: segment.block.startMinutes,
                    durationMinutes: segment.group.blocks
                      .slice(segment.index)
                      .reduce((total, row) => total + row.durationMinutes, 0),
                  },
                  // The same reason a move carries it: a resize of a past row rewrites the
                  // record just as much as a drag of it does.
                  { inert },
                )
              }
              onOpen={() => onOpenJob(segment.block.projectId)}
              onToggleLock={() => onToggleLock(segment.block)}
              // One release for the whole unit: a hand-set stretch cut at the lunch break
              // is two marked rows, and giving the engine back only half of it would leave
              // the other half holding the day open for no visible reason.
              onReleaseDuration={
                segment.group.manualBlockIds.length === 0
                  ? undefined
                  : () => onReleaseDuration(segment.group.manualBlockIds)
              }
              onCloseDay={
                closeDay === null || onCloseDay === undefined
                  ? undefined
                  : () => onCloseDay(closeDay)
              }
              onSplit={() => onSplit(segment.block)}
              onDelete={() => onDelete(segment.block)}
            />
          );
        })}
      </div>

      {gesture === null
        ? null
        : ghostRows.map((row, index) => (
            <div
              key={row.startMinutes}
              className={[
                styles.ghost,
                // An insertion point rather than a placement: hollow, with a rule on the
                // edge the drop ranks itself at. See `ranked` above.
                ranked ? styles.ghostRanked : '',
                // ONE INSERTION POINT PER GESTURE, however many rectangles the hours land in
                // and on however many columns: the heavy rule marks the drop's own first row,
                // everything after it is a continuation. Asked of the whole gesture rather
                // than of this column, or the hours carried to the next day would draw a
                // second rank on a day the owner never released over.
                index === 0 && carriesLabel ? '' : styles.ghostContinued,
                // A refusal is drawn like a forbidden day: the save writes nothing either
                // way. (`dropEffect` is null unless `allowed`, so this reads as one test.)
                gesture.allowed && dropEffect?.kind !== 'blocked' ? '' : styles.ghostDenied,
              ]
                .filter(Boolean)
                .join(' ')}
              style={{
                '--ww-block-color': gesture.color,
                top: `${timeline.yOf(row.startMinutes)}px`,
                // Both edges through the axis, which clamps: a long unit dropped late in the
                // day genuinely runs past the last period once the lunch break is added
                // back, and the ghost must not escape the grid to say so.
                height: `${timeline.heightBetween(row.startMinutes, row.startMinutes + row.durationMinutes)}px`,
              } as React.CSSProperties}
            >
              {/*
               * ONE LABEL PER GESTURE, on its FIRST rectangle wherever that is — normally
               * the release column, and the next one when the release day could not take a
               * single legal row. Every other rectangle of the drop is bare, exactly as a
               * stored unit puts its name and hours on its first row: per-rectangle labels
               * would read as two separate drops, which is the one thing this is not.
               *
               * A column that only holds the CARRIED hours says just that, so the owner can
               * see how much landed there without reading the sentence on the other column.
               */}
              {index === 0 && !carriesLabel ? (
                <div className={styles.ghostLabel}>
                  <span className={styles.ghostMeta}>
                    {t('grid.dropCarries', { hours: format.hourNumber(spillMinutes) })}
                  </span>
                </div>
              ) : null}
              {index === 0 && carriesLabel ? (
                /*
                 * The words sit on their own backing. The ghost itself is translucent so the
                 * row or the reserved gap underneath stays visible — which is the whole point
                 * of hovering there — and on a 128 px weekend column that left the ghost's
                 * sentence and the block's own name printed on top of one another.
                 */
                <div className={styles.ghostLabel}>
                  {/*
                   * THE CLOCK RANGE IS PRINTED ONLY WHERE IT IS A PROMISE — a pinned drop
                   * and a resize. On a re-ranked drop the hours are the only true number,
                   * and what takes the range's place is the rank itself: the row this will
                   * fall in behind, which is what the drop actually writes.
                   *
                   * AND ONLY WHERE THERE IS AN END TO PRINT. A run's minutes can be more
                   * than the day holds, and then it has no end on this day's clock
                   * (`ghostEndMinutes === null`); the START is still exactly where the row
                   * begins, so that is what is said, with the hours on the line below.
                   */}
                  {ranked ? null : (
                    <span className={styles.ghostMeta}>
                      {ghostEndMinutes === null
                        ? t('grid.dropStartsAt', { time: format.time(ghostStartMinutes) })
                        : format.timeRange(ghostStartMinutes, ghostEndMinutes)}
                    </span>
                  )}
                  {/*
                   * THE HOURS — or, when they do not all land on this day, WHERE THEY GO.
                   *
                   * Since *Fill and Overflow, Always* a drop on a day the engine lays out is
                   * not "it fits" or "it does not": it fills what is left and the rest carries
                   * on, so the honest thing to say is which day gets how much. It REPLACES the
                   * bare total rather than being added under it — the total is the sum of the
                   * parts, and on a 155 px column a 1,5 h rectangle holds four lines, not six.
                   */}
                  {carrySentence === null ? (
                    <span className={styles.ghostMeta}>{format.hours(gesture.durationMinutes)}</span>
                  ) : (
                    <span className={styles.ghostSplit}>{carrySentence}</span>
                  )}
                  {!ranked ? null : (
                    <span className={styles.ghostRank}>
                      {rankAfter === null
                        ? t('grid.dropTakesRank')
                        : t('grid.dropAfter', { name: rankAfter.project.name })}
                    </span>
                  )}
                  {/*
                   * WHY THE GHOST STOPPED FOLLOWING THE POINTER. The unit is too long to
                   * start where the hand is and still end inside the day, so the release
                   * point is pulled up to the last minute that fits — and on a 6 h unit
                   * that is 13:00, which leaves the whole afternoon meaning one thing and
                   * the ghost sitting still while the pointer keeps going. The rule is
                   * real; the silence was the defect.
                   *
                   * BOTH OF THESE ARE NOW ABOUT A DROP THAT LANDS LITERALLY ONLY — the
                   * buffer, the weekend, a margin, a padlocked row. On Monday-Thursday a
                   * release below what the day holds is neither rolled nor clamped, so
                   * `preview.rolled` and `preview.clamped` are false there by construction
                   * and the sentence above is what answers instead.
                   */}
                  {/*
                   * THE DROP MOVED TO THIS DAY because the one the pointer is over cannot
                   * hold the run from where the hand is — which is what aiming past the
                   * bottom of a column means in any calendar. The ghost is already HERE, so
                   * this only names the reason; without it the jump to the next column is
                   * the app appearing to lose the drag.
                   */}
                  {preview?.rolled !== true ? null : (
                    <span className={styles.ghostClamped}>
                      {t('grid.dropNextDay', { day: format.dayHeader(day.date) })}
                    </span>
                  )}
                  {/*
                   * A RUN NO DAY CAN HOLD SAYS THAT INSTEAD, and says it whether or not the
                   * clamp fired: at the very top of the axis nothing was pulled up, so
                   * `clamped` is false and the ghost would otherwise explain nothing at all
                   * about why it has no end time. The day's own hours are named because
                   * that is the number the owner has to act on — the run has to be split
                   * with another job, or shortened, before it can be dragged anywhere.
                   */}
                  {longerThanTheDay ? (
                    <span className={styles.ghostClamped}>
                      {t('grid.dropLongerThanDay', {
                        hours: format.hourNumber(gesture.durationMinutes),
                        dayHours: format.hourNumber(netMinutesOf(day.manualWindows)),
                      })}
                    </span>
                  ) : preview?.clamped !== true ? null : (
                    <span className={styles.ghostClamped}>
                      {t('grid.dropNoLower', {
                        hours: format.hourNumber(gesture.durationMinutes),
                        time: format.time(preview.startMinutes),
                      })}
                    </span>
                  )}
                  {/*
                   * WHY THE GHOST IS NOT UNDER THE POINTER. A pinned drop that lands on a
                   * gap or a locked row is not refused on a day the engine reflows — it is
                   * slid down to the first clear slot. The rectangle already draws where
                   * the row will really be; this says who moved it.
                   */}
                  {resolution?.slid !== true ? null : (
                    <span className={styles.ghostClamped}>
                      {t('grid.dropSlid', { time: format.time(ghostStartMinutes) })}
                    </span>
                  )}
                  {dropEffect === null ? null : (
                    <span className={styles.ghostEffect}>
                      {t(DROP_EFFECT_KEYS[dropEffect.kind], { name: dropEffect.projectName })}
                    </span>
                  )}
                </div>
              ) : null}
            </div>
          ))}

      {/* A split fragment waiting for its target. It is a drop like any other, so it is
          previewed exactly like one: in segments where it lands literally, and as the rows the
          reflow will lay it out in — this day's share and the next day's — where it is a rank. */}
      {placing === null || placingSlot === null ? null : placingRows.map((row, index) => (
            <div
              key={row.startMinutes}
              className={[
                styles.ghost,
                placingGhost === null ? '' : styles.ghostRanked,
                index === 0 && placingCarriesLabel ? '' : styles.ghostContinued,
                day.isPast ? styles.ghostDenied : '',
              ]
                .filter(Boolean)
                .join(' ')}
              style={{
                '--ww-block-color': placing.color,
                top: `${timeline.yOf(row.startMinutes)}px`,
                height: `${timeline.heightBetween(row.startMinutes, row.startMinutes + row.durationMinutes)}px`,
              } as React.CSSProperties}
            >
              {index !== 0 ? null : placingCarriesLabel ? (
                <div className={styles.ghostLabel}>
                  <span className={styles.ghostName}>{placing.projectName}</span>
                  {placingCarry === null ? (
                    <span className={styles.ghostMeta}>{format.hours(placing.durationMinutes)}</span>
                  ) : (
                    <span className={styles.ghostSplit}>{placingCarry}</span>
                  )}
                  <span className={styles.ghostMeta}>{t('grid.dropHere')}</span>
                </div>
              ) : (
                <div className={styles.ghostLabel}>
                  <span className={styles.ghostMeta}>
                    {t('grid.dropCarries', {
                      hours: format.hourNumber(
                        placingRows.reduce((total, piece) => total + piece.durationMinutes, 0),
                      ),
                    })}
                  </span>
                </div>
              )}
            </div>
          ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The week change, drawn
// ---------------------------------------------------------------------------

/** Which way the calendar last travelled. `null` on the first week and on any other render. */
type WeekSlide = 'next' | 'previous' | null;

/**
 * WHICH WAY THE WEEK JUST MOVED, so the calendar can slide in from that side.
 *
 * The owner asked for it after using the pager and the edge hold: «estaría bien alguna
 * animación fluida que indique visualmente que se ha cambiado de semana tanto adelante como
 * hacia atrás». The direction is the whole point — an animation that looks the same both ways
 * says "something changed", which the owner already knew, rather than "you went forward".
 *
 * Two decisions worth keeping:
 *
 * - **It is derived, not passed in.** No caller has to remember to say which way it paged, so
 *   `goToday`, the arrow keys, the two header buttons and the edge hold all get it for free —
 *   and none of them can get it wrong. ISO dates compare lexicographically, which for
 *   `YYYY-MM-DD` is chronologically.
 * - **The FIRST week never slides.** `direction` starts `null`, so opening the app is not
 *   dressed up as a page turn. It stays whatever it last was after that, which is harmless:
 *   the class only ever animates something that has just been remounted, and only a date
 *   change remounts anything.
 */
function useWeekSlide(startDate: string): WeekSlide {
  const previous = useRef(startDate);
  const direction = useRef<WeekSlide>(null);
  if (previous.current !== startDate) {
    direction.current = startDate > previous.current ? 'next' : 'previous';
    previous.current = startDate;
  }
  return direction.current;
}

/** The entry animation for a box of the week that has just arrived: a column's contents. */
function slideClass(slide: WeekSlide): string {
  return slide === null ? '' : slide === 'next' ? styles.slideNext : styles.slidePrevious;
}

/**
 * The same, for a day HEADER, which travels its words rather than its box — see the CSS. A
 * separate class rather than a flag because what differs is the SELECTOR, and a selector is a
 * stylesheet's business.
 */
function slideHeadClass(slide: WeekSlide): string {
  return slide === null ? '' : slide === 'next' ? styles.slideHeadNext : styles.slideHeadPrevious;
}

// ---------------------------------------------------------------------------
// Derived state
// ---------------------------------------------------------------------------

/** What the ghost says about the row it is over. One key per branch of the resolver. */
const DROP_EFFECT_KEYS: Record<DropEffect['kind'], string> = {
  cut: 'grid.dropCuts',
  displace: 'grid.dropDisplaces',
  merge: 'grid.dropMerges',
  blocked: 'grid.dropBlocked',
  gap: 'grid.dropOnGap',
};

interface WeekLayout {
  groups: Map<string, BlockGroup[]>;
  gaps: Map<string, Gap[]>;
  lanes: Map<string, Map<string, { lane: number; lanes: number }>>;
  /**
   * The RUN each unit belongs to, keyed by group id — what a drag of it moves. Built for
   * the whole week at once because a run's other half is usually on another day.
   */
  runs: Map<string, BlockRun>;
}

function buildLayout(view: WeekView): WeekLayout {
  const blocksByDate = new Map<string, WeekBlock[]>();
  for (const block of view.blocks) {
    const list = blocksByDate.get(block.date);
    if (list === undefined) blocksByDate.set(block.date, [block]);
    else list.push(block);
  }

  const gapsByDate = new Map<string, Gap[]>();
  for (const gap of view.gaps) {
    const list = gapsByDate.get(gap.date);
    if (list === undefined) gapsByDate.set(gap.date, [gap]);
    else list.push(gap);
  }

  const groups = new Map<string, BlockGroup[]>();
  const lanes = new Map<string, Map<string, { lane: number; lanes: number }>>();

  for (const day of view.days) {
    // Grouped over the MANUAL WINDOWS: two rows are one unit when nothing WORKABLE
    // separates them, and half an hour of margin between two rows is workable by hand.
    // Read against the periods alone, a row in the top margin and one starting at 08:00
    // would be drawn as a single unit with a phantom seam between them.
    const dayGroups = groupBlocks(blocksByDate.get(day.date) ?? [], day.manualWindows);
    groups.set(day.date, dayGroups);
    lanes.set(day.date, packDay(dayGroups, gapsByDate.get(day.date) ?? []));
  }

  /*
   * THE MOVABLE POOL, as this side of the app can see it — the mirror of `isMovable` in
   * src/lib/composition.ts: unlocked, not in the past, not on a weekend. It is what tells
   * a run where to stop, because work the engine never moves is an obstacle it flows
   * around rather than a division the owner made.
   */
  const dayByDate = new Map(view.days.map((day) => [day.date, day]));
  const runs = buildRuns(
    view.days.flatMap((day) => groups.get(day.date) ?? []),
    (block) => {
      const day = dayByDate.get(block.date);
      return !block.locked && day !== undefined && !day.isPast && !day.isWeekend;
    },
  );

  return { groups, gaps: gapsByDate, lanes, runs };
}

/**
 * The "stop the day here" the row offers, or `null` when it has nothing to offer.
 *
 * The moment is the END of this row, so the action reads exactly as it is labelled: the
 * hours up to here stay today and the rest of the day stops being plannable. A row that
 * already runs to the end of the day, or one with nothing but existing gaps after it, has
 * nothing to close — the button is then absent rather than disabled, because there is no
 * state to explain.
 */
function closeDayAfter(input: CloseDayInput | null, block: WeekBlock): CloseDayRequest | null {
  if (input === null) return null;
  const fromMinutes = block.startMinutes + block.durationMinutes;
  const plan = planCloseDay(input, fromMinutes);
  if (plan === null || plan.workingMinutes <= 0) return null;
  return { input, fromMinutes };
}

/**
 * WHAT A PRESS ON THIS UNIT PICKS UP: the whole RUN it belongs to, in queue order.
 *
 * The unit on screen is where the gesture STARTS — its date and start are what "the drag
 * came to nothing" and the outcome sentence are measured against — but what MOVES is the
 * run: every consecutive unit of this job with no other job's work between them, across
 * days. That is the owner's own rule and the engine's own `QueueItem`; see `BlockRun`.
 */
function targetFor(group: BlockGroup, day: WeekDay, run: BlockRun): DragTarget {
  const first = group.blocks[0];
  const last = group.blocks[group.blocks.length - 1];
  return {
    groupId: group.id,
    projectId: group.projectId,
    name: first.project.name,
    color: first.project.color,
    date: day.date,
    startMinutes: group.startMinutes,
    durationMinutes: run.totalMinutes,
    blockIds: run.blockIds,
    blockId: last.id,
    locked: group.locked,
  };
}

/** The run a unit belongs to, or the unit alone before the layout has caught up. */
function runFor(runs: ReadonlyMap<string, BlockRun>, group: BlockGroup): BlockRun {
  return (
    runs.get(group.id) ?? {
      blockIds: group.blocks.map((block) => block.id),
      totalMinutes: group.totalMinutes,
      date: group.date,
      startMinutes: group.startMinutes,
    }
  );
}

/**
 * Friday's `desborde` label: hours the ENGINE parked on the colchón.
 *
 * Derived from the buffer rule itself — the colchón "receives only overflow generated by
 * the growth of already-placed work", so anything the engine could have put there IS
 * overflow. Everything the engine could NOT have put there is excluded, and that is two
 * things: a past Friday, which is a record, and a PADLOCK, which is the owner saying "do
 * this on Friday" — whether they pressed it or a drop onto the buffer put it there for
 * them.
 *
 * That distinction has to read differently from `desborde 2 h` on the very same column
 * (CLAUDE.md): one means the week overran, the other means the owner planned it. `some`
 * rather than `every`, because a unit with any padlocked row in it is not something the
 * engine decided.
 */
function isOverflow(group: BlockGroup, day: WeekDay): boolean {
  if (day.role !== 'buffer' || day.isPast) return false;
  return !group.blocks.some((block) => block.locked);
}

// ---------------------------------------------------------------------------
// Column widths
// ---------------------------------------------------------------------------

/**
 * EVERY COLUMN'S WIDTH IN PIXELS, kept current.
 *
 * Needed for exactly one decision, and it is a decision no stylesheet can take: whether the
 * hover action bar — a fixed number of 24 px buttons — still leaves any of a block to press
 * (`blockHoldsActions`). Percentages cannot compare themselves to pixels, and a container
 * query on the block would make it a containment context, which creates a stacking context
 * and would trap the bar that hangs OUTSIDE a narrow block behind the row next to it.
 *
 * Measured from the same `measure()` the drag layer uses, so there is one answer about where
 * the columns are, and re-read on resize only — never during a drag, which reads `measure()`
 * itself on every pointer event.
 */
function useColumnWidths(
  gridRef: React.MutableRefObject<HTMLDivElement | null>,
  measure: () => GridMetrics | null,
  /** The week's dates, joined. Paging keeps the widths and changes every key. */
  dates: string,
): Map<string, number> {
  const [widths, setWidths] = useState<Map<string, number>>(() => new Map());

  useEffect(() => {
    const root = gridRef.current;
    if (root === null) return;

    const read = (): void => {
      const columns = measure()?.columns;
      if (columns === undefined) return;
      setWidths((current) => {
        // Rounded, and only replaced when something really changed: a ResizeObserver fires
        // on sub-pixel jitter, and a new Map every time would re-render the whole week.
        const next = new Map(columns.map((column) => [column.date, Math.round(column.width)]));
        if (next.size === current.size && [...next].every(([date, width]) => current.get(date) === width)) {
          return current;
        }
        return next;
      });
    };

    read();
    const observer = new ResizeObserver(read);
    observer.observe(root);
    return () => observer.disconnect();
    // `dates` is a dependency because paging the week changes the keys without changing
    // any size, so the observer alone would never fire and every column would read `null`.
  }, [gridRef, measure, dates]);

  return widths;
}

// ---------------------------------------------------------------------------
// The settle
// ---------------------------------------------------------------------------

function useSettleAnimation({
  gridRef,
  settle,
  timeline,
  view,
  onSettled,
}: {
  gridRef: React.MutableRefObject<HTMLDivElement | null>;
  settle: SettleRequest | null;
  timeline: Timeline;
  view: WeekView;
  onSettled: () => void;
}): void {
  useLayoutEffect(() => {
    if (settle === null) return;
    // The refetch has not landed yet: there is nothing to animate TO.
    if (settle.after === view) return;

    const root = gridRef.current;
    const element = root?.querySelector<HTMLElement>(`[data-block-id="${settle.blockId}"]`) ?? null;
    const from = root?.querySelector<HTMLElement>(`[data-day-column="${settle.date}"]`) ?? null;
    const to = element?.closest<HTMLElement>('[data-day-column]') ?? null;

    // The row may have been merged away, or have landed in another week entirely.
    if (element === null || from === null || to === null) {
      onSettled();
      return;
    }

    const dx = from.getBoundingClientRect().left - to.getBoundingClientRect().left;
    const dy = timeline.yOf(settle.startMinutes) - element.offsetTop;
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1) {
      onSettled();
      return;
    }

    element.style.setProperty('--ww-settle-dx', `${dx}px`);
    element.style.setProperty('--ww-settle-dy', `${dy}px`);
    element.classList.add(styles.settling);

    const done = (): void => {
      element.classList.remove(styles.settling);
      onSettled();
    };
    element.addEventListener('animationend', done, { once: true });
    return () => element.removeEventListener('animationend', done);
    // `view` is a dependency because the animation must run against the SETTLED layout,
    // which only exists after the refetch has re-rendered the grid.
  }, [settle, view, timeline, gridRef, onSettled]);
}
