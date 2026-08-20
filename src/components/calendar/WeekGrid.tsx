'use client';

/**
 * The week grid: a time axis and seven day columns. Sole owner of MEASUREMENT (`metricsRef`,
 * read live rather than cached so scrolling mid-drag cannot offset the pointer), the edge
 * rails, the week-change direction, the settle animation and placement mode.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { IconChevronLeft, IconChevronRight } from '@tabler/icons-react';
import { useFormat } from '../../lib/useFormat';
import { addDays } from '../../lib/dates';
import { clockEndOf, netMinutesOf } from '../../lib/manualWindow';
import { fillStartFor, planDropSpill, spillByDay, type SpillDay } from '../../lib/dropSpill';
import { segmentDroppedRow } from '../../lib/dropSegments';
import type { CloseDayInput, CloseDayRequest } from '../../lib/closeDay';
import { closeDayAfter, closeDayInputFor } from './closeDayOffer';
import type { Gap, GapUnit } from '../../types';
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
  gapDropEffect,
  resolveDropPreview,
  type DropEffect,
  type DropResolution,
  type GapEffect,
  type QueueRow,
} from './dropEffect';
import {
  buildRuns,
  gapSegmentsOf,
  gapUnitOf,
  groupBlocks,
  groupGaps,
  packDay,
  segmentsOf,
  type BlockGroup,
  type BlockRun,
  type GapGroup,
} from './grouping';
import { EDGE_ZONE_PX, type EdgeHold, type EdgeSide } from './edgePaging';
import type { BlockDragTarget, DragController, GapDragTarget } from './useBlockDrag';
import type { PaintController } from './usePaintAbsence';
import styles from './WeekGrid.module.css';

/** A fragment waiting for the click that says where it goes. */
export interface PlacingFragment {
  blockId: string;
  projectName: string;
  color: string;
  durationMinutes: number;
}

/**
 * The drop as the reflow will lay it out: rows across DAYS, not one rectangle on one column.
 * `null` for a gesture whose minute is the promise, which keeps the literal drawing.
 */
interface GhostPlan {
  /** The day the pointer released on — which may take none of the hours. */
  date: string;
  /** Every row the hours will be stored as, in calendar order, over every column. */
  pieces: readonly { date: string; startMinutes: number; durationMinutes: number }[];
  /** The same, one entry per DAY, which is what the ghost's label reads. */
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
   * The week as it was WHEN THE ROW WAS RELEASED: the animation runs against the SETTLED layout,
   * so the grid waits until `view` is no longer this object. Without it the row slides from the
   * drop point back to where it already was, which reads as a rejection.
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
  /**
   * Painting a band on EMPTY grid space, which only ever opens the absences form pre-filled. Its
   * press lives on the column background: every draggable thing on the grid stops propagation, so a
   * press on a block or an absence never reaches it.
   */
  paint: PaintController;
  placing: PlacingFragment | null;
  onPlace: (slot: { date: string; startMinutes: number }) => void;
  onOpenJob: (projectId: string) => void;
  /**
   * The KEYBOARD's way into a gap's form (Enter or Space). The pointer's click goes through the drag
   * layer instead, exactly like a block's, so one press can never answer twice. Wired only when the
   * gap form exists; without it a gap is a label — which can still be dragged.
   */
  onOpenGap?: (unit: GapUnit) => void;
  onToggleLock: (block: WeekBlock) => void;
  /** "Stop the day here": opens the gap form pre-filled. Wired only when that form exists. */
  onCloseDay?: (request: CloseDayRequest) => void;
  onSplit: (block: WeekBlock) => void;
  onDelete: (block: WeekBlock) => void;
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
  paint,
  placing,
  onPlace,
  onOpenJob,
  onOpenGap,
  onToggleLock,
  onCloseDay,
  onSplit,
  onDelete,
  metricsRef,
  settle,
  onSettled,
}: WeekGridProps): React.JSX.Element {
  const { t } = useTranslation();
  const format = useFormat();
  const gridRef = useRef<HTMLDivElement | null>(null);
  // The visible box: the grid can be WIDER and scroll inside it on a narrow window, which is
  // why the edge zones are measured from the frame. See `GridMetrics.frame`.
  const frameRef = useRef<HTMLDivElement | null>(null);

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
    // The frame if it has been measured; the columns' own span before that.
    const left = frameBox === undefined ? columns[0].left : frameBox.left;
    const right = frameBox === undefined ? last.left + last.width : frameBox.right;
    return {
      top: cells[0].getBoundingClientRect().top,
      columns,
      frame: {
        left,
        right,
        // The gutter belongs to no day, and a narrower strip leaves the hour labels sliced
        // down the middle for the whole drag. `.edgePrevious` draws over the same width.
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

  // Which way the calendar just travelled, or `null` when this is not a page turn.
  const slide = useWeekSlide(view.week.startDate);

  // One pass: each day's rows grouped into units and packed into lanes, so a hand-made
  // overlap (allowed on the weekend and in the past) stays visible.
  const layout = useMemo(() => buildLayout(view), [view]);
  const ticks = useMemo(() => axisTicks(view.shape.periods, timeline), [view.shape.periods, timeline]);

  // The queue, so a re-ranking drop can name the row it will fall in behind — the only true
  // thing its ghost can print. Built for the whole week: a Thursday drop usually ranks after
  // a row on Wednesday.
  const queue = useMemo<QueueRow[]>(() => {
    const reflowing = new Set(
      view.days.filter((day) => !day.isPast && !day.isWeekend).map((day) => day.date),
    );
    return buildDropQueue(view.blocks, (date) => reflowing.has(date));
  }, [view.blocks, view.days]);

  /**
   * Where the drop's hours will really go while the pointer is down. Computed for the WEEK,
   * because the answer spans columns.
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

      // The run in the air is not an obstacle to itself.
      const moving = new Set(input.movingBlockIds);
      const rowsOn = (date: string): WeekBlock[] =>
        view.blocks.filter((block) => block.date === date && !moving.has(block.id));
      const gapsOn = (date: string): Gap[] => view.gaps.filter((gap) => gap.date === date);
      // What nothing will move out of the way, which is what the engine treats as an obstacle:
      // a gap and a padlocked row. Ordinary work is ranked BEHIND the drop, so it costs nothing.
      const immovableOn = (date: string) =>
        [...gapsOn(date), ...rowsOn(date).filter((row) => row.locked)].map((row) => ({
          startMinutes: row.startMinutes,
          durationMinutes: row.durationMinutes,
        }));

      // The hours begin where the work in FRONT of them ends — see `fillStartFor`.
      const fromMinutes = fillStartFor(
        released.periods,
        [...gapsOn(input.date), ...rowsOn(input.date)],
        input.startMinutes,
      );
      // The day's stop-line less what the work ahead has spent of it. `plannableMinutes` has
      // the gaps and the locks out already, so only ordinary rows above the fill start count.
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
        // The days the overflow may use: the ones the engine lays out, minus the colchón, which
        // takes overflow only from work that GREW (`acceptsItem`).
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
      movingBlockIds: target.rowIds,
    });
  }, [drag.preview, drag.target, planDrop]);

  useSettleAnimation({ gridRef, settle, timeline, view, onSettled });

  // Where the fragment would land. Only tracked while placing, so the grid does not re-render
  // on every mouse move the rest of the time.
  const [hover, setHover] = useState<{ date: string; startMinutes: number } | null>(null);
  useEffect(() => {
    if (placing === null) setHover(null);
  }, [placing]);

  /**
   * The same answer for the scissors' second click, a fragment being a drop. `movingBlockIds` is
   * EMPTY: the source row does not leave the calendar, so it is still in front of the fragment.
   */
  const placingGhost = useMemo<GhostPlan | null>(() => {
    if (placing === null || hover === null) return null;
    const day = view.days.find((candidate) => candidate.date === hover.date);
    if (day === undefined || day.isPast) return null;
    if (
      dropPins({
        fixed: false,
        role: day.role,
        closed: day.isClosed,
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
       * Clamped over the day only where the fragment lands LITERALLY, where it is stored exactly
       * as put. On a day the engine lays out the click is a RANK, and pulling it up to "the
       * latest start that fits" would rank a 6 h fragment aimed at the afternoon back inside the
       * morning, cutting a row nobody aimed at.
       */
      const literal =
        day === undefined ||
        dropPins({
          fixed: false,
          role: day.role,
          closed: day.isClosed,
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
      {/* Drawn while a MOVE is in the air and never otherwise, so the gesture is discovered
          rather than fallen into. Not for a RESIZE, whose edge is one row on one day. */}
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
                // Keyed on the MINUTE, never on the tick's index: `axisTicks` may drop either
                // end, and `labelBox` tests the minute against the axis bounds too.
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
              gapGroups={layout.gapGroups.get(day.date) ?? []}
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
              paint={paint}
              placing={placing}
              placingSlot={hover}
              placingGhost={placingGhost}
              onOpenJob={onOpenJob}
              onOpenGap={onOpenGap}
              onToggleLock={onToggleLock}
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

// --- The edge rails ---

/**
 * One end of the calendar while a block is in hand: the strip that pages the week. It names the
 * destination by DATES, and its fill runs exactly as long as the drag layer's countdown
 * (`EdgeHold.delayMs`, published rather than re-derived). `pointer-events: none` and exactly as
 * wide as the zone it draws: a release on the rail is still a drop on the column under it.
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
      // The width the zone really has, from the same variable the column template uses.
      style={{ '--ww-edge-zone': `${EDGE_ZONE_PX}px` } as React.CSSProperties}
      // The same paging is on two named buttons in the header.
      aria-hidden="true"
    >
      {!active ? null : (
        <span
          // Keyed on the turn, so the fill restarts from empty for each turn of a long hold.
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

// --- Day header ---

function DayHeader({ day, slide }: { day: WeekDay; slide: WeekSlide }): React.JSX.Element {
  const { t } = useTranslation();
  const format = useFormat();

  // Past wins over everything: a frozen Friday is not a buffer any more. On a CLOSED day the
  // owner's own words are the state — `Mar 1 · Feria` — because "cerrado" is what the dimmed
  // column already says and the reason is the only thing it cannot.
  const state = day.isPast
    ? t('day.frozen')
    : day.isClosed
      ? day.note ?? t('day.closed')
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
        // The header carries the DATE, so it travels with the columns rather than jumping.
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

// --- Day column ---

interface DayColumnProps {
  day: WeekDay;
  groups: BlockGroup[];
  gaps: Gap[];
  /** The same gaps grouped into units, so the halves of one gap are drawn as one thing. */
  gapGroups: GapGroup[];
  lanes: Map<string, { lane: number; lanes: number }>;
  /** The whole week's runs, keyed by group id: what a drag of a unit picks up. */
  runs: Map<string, BlockRun>;
  /** Measured width in pixels, `null` before the first measurement. Read only by the bar. */
  columnWidth: number | null;
  ticks: { minutes: number; boundary: boolean }[];
  timeline: Timeline;
  /** Which way the calendar just travelled, for the entry animation. */
  slide: WeekSlide;
  gapColor: string;
  /** Nothing can be written right now: a mutation is in flight, or the week is reloading. */
  busy: boolean;
  /**
   * The whole gesture's ghost, or `null` for a literal placement. Every column reads it, because
   * a drop's hours land on more than one, and draws only the pieces that are its own.
   */
  ghost: GhostPlan | null;
  drag: DragController;
  paint: PaintController;
  placing: PlacingFragment | null;
  /** The slot the pointer is over while placing a fragment. */
  placingSlot: { date: string; startMinutes: number } | null;
  /** The fragment's hours as the reflow will lay them out, or `null` where it lands literally. */
  placingGhost: GhostPlan | null;
  onOpenJob: (projectId: string) => void;
  /** The keyboard's way into a gap's form; the pointer's goes through the drag layer. */
  onOpenGap?: (unit: GapUnit) => void;
  onToggleLock: (block: WeekBlock) => void;
  onCloseDay?: (request: CloseDayRequest) => void;
  onSplit: (block: WeekBlock) => void;
  onDelete: (block: WeekBlock) => void;
}

const SINGLE_LANE = { lane: 0, lanes: 1 };

function DayColumn({
  day,
  groups,
  gaps,
  gapGroups,
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
  paint,
  placing,
  placingSlot,
  placingGhost,
  onOpenJob,
  onOpenGap,
  onToggleLock,
  onCloseDay,
  onSplit,
  onDelete,
}: DayColumnProps): React.JSX.Element {
  const { t } = useTranslation();
  const format = useFormat();

  const bands = nonWorkingBands(day.periods, timeline);
  /** The band being painted, when it is being painted on THIS column. */
  const painting = paint.painting?.date === day.date ? paint.painting : null;
  const preview = drag.preview?.date === day.date ? drag.preview : null;
  // The gesture itself, whichever column it was released over: `preview` is null on every other
  // one, while the ghost's colour and total hours are needed wherever its hours land.
  const gesture = drag.preview;

  /*
   * Is this column's content travelling right now? It makes the sideways clip (`.columnSliding`)
   * last exactly as long as the slide — permanently would hide most of the SETTLE, which crosses
   * a whole column. `slide` cannot serve: it stays non-null for the rest of the session.
   *
   * `animationend` is the ONLY thing that clears this (and the settle): globals.css shortens a
   * `prefers-reduced-motion` animation to 0.01 ms rather than removing it, so the event always
   * arrives. Tidying that CSS to `animation: none` would leave the sideways clip on for ever.
   */
  const [sliding, setSliding] = useState(slide !== null);

  /**
   * What the server will do with this drop: the minute it will be stored at, whether that minute
   * is a promise, and what it does to the row underneath. One call, because the server decides
   * them together. Computed here: only the grid has the day's rows and gaps.
   */
  const resolution = useMemo<DropResolution | null>(() => {
    // Nothing to promise about a drop that will not be accepted; a resize touches its own row.
    if (preview === null || !preview.allowed || preview.kind !== 'move') return null;
    // An ABSENCE is answered for by `gapEffect` below: the server resolves it with a different
    // vocabulary — no slide, no merge, no cut — so this resolver has nothing true to say about one.
    if (drag.target === null || drag.target.kind !== 'block') return null;
    return resolveDropPreview({
      rows: groups.flatMap((group) => group.blocks),
      // Gaps are occupancy too: what a drop is refused by, or slid past.
      gaps,
      movingBlockIds: drag.target.rowIds,
      projectId: drag.target.projectId,
      dayIsWeekend: day.isWeekend,
      // The gesture asked the whole pin question, day AND slot. See `DragPreview.pinned`.
      pinned: preview.pinned === true,
      // The engine lays this day out, so a collision here can never refuse the drop.
      dayReflows: dayReflowsOn(day),
      locked: drag.target.fixed,
      // Measured against this day's MANUAL WINDOWS, the same view the server cuts the drop over.
      manualWindows: day.manualWindows,
      startMinutes: preview.startMinutes,
      durationMinutes: preview.durationMinutes,
    });
  }, [preview, drag.target, groups, gaps, day]);

  /**
   * The same question for an absence, and for BOTH its gestures: what the save will refuse over, or
   * push aside. A gap is never slid and never merged, so there is no minute to settle either — the
   * one it was released on is the one that is stored. A resize is asked too, because growing an
   * absence over a padlocked row is refused exactly as dragging it there is, and the footprint is
   * the same shape either way: the unit's start and the gesture's net minutes.
   */
  const gapEffect = useMemo<GapEffect | null>(() => {
    if (preview === null || !preview.allowed) return null;
    if (drag.target?.kind !== 'gap') return null;
    return gapDropEffect({
      rows: groups.flatMap((group) => group.blocks),
      dayIsWeekend: day.isWeekend,
      manualWindows: day.manualWindows,
      startMinutes: preview.startMinutes,
      durationMinutes: preview.durationMinutes,
    });
  }, [preview, drag.target, groups, day]);

  /** A rank, not a place: `ghost` is non-null exactly when the drop is a queue rank. */
  const ranked = ghost !== null;

  /** Where the ghost is really drawn: the release point, or the slid one. */
  const ghostStartMinutes = resolution?.startMinutes ?? preview?.startMinutes ?? 0;

  // The row a re-ranked drop lands behind, or `null` when the queue reaches further back than
  // this week. Read off the plan: the rank belongs to the RELEASE, while the label may be
  // drawn on another column.
  const rankAfter = ghost?.rankAfter ?? null;

  // The pieces that land on this column. The label goes on the FIRST piece of the whole
  // gesture: the release column, unless that day could not take a single legal row.
  const spillPieces = ghost === null ? [] : ghost.pieces.filter((piece) => piece.date === day.date);
  const carriesLabel =
    ghost === null
      ? preview !== null
      : (ghost.pieces[0]?.date ?? ghost.date) === day.date;
  /** This column's own share of the hours, for the bare "…sigue" label on a continuation. */
  const spillMinutes = spillPieces.reduce((total, piece) => total + piece.durationMinutes, 0);

  /** What the drop will do to the row underneath: a cut, a displacement, a merge, a refusal. */
  const dropEffect: DropEffect | null = resolution?.effect ?? null;

  /**
   * The ONE sentence the ghost prints about what it lands on, whichever gesture is in the air. Two
   * vocabularies, because the server has two: a block's drop cuts, merges or is blocked; an absence
   * is refused or pushes work forward.
   */
  const effectSentence =
    dropEffect !== null
      ? { key: DROP_EFFECT_KEYS[dropEffect.kind], name: dropEffect.projectName }
      : gapEffect !== null
        ? { key: GAP_EFFECT_KEYS[gapEffect.kind], name: gapEffect.projectName }
        : null;

  /** Nothing will be saved: a forbidden day, or something in the footprint that will not move. */
  const denied = dropEffect?.kind === 'blocked' || gapEffect?.kind === 'blocked';

  /**
   * The rectangles the ghost is drawn as: one per row the gesture will be STORED as, for a move
   * and a resize alike, since one rectangle through the grey band promises a shape that will
   * never exist. `footprintWithinDay` rather than `dropFootprint`, because a RUN longer than the
   * day is stored UNCUT and drew one rectangle over the whole column. A drop that is a RANK is
   * drawn from the plan instead, `GhostPlan.pieces` already obeying every rule.
   */
  const ghostRows: readonly { startMinutes: number; durationMinutes: number }[] =
    // Where not one day on screen can hold a legal row the literal drawing stands: something
    // has to be under the pointer, and the label says where the hours carry on to.
    ghost !== null && ghost.pieces.length > 0
      ? spillPieces
      : preview === null
        ? []
        : footprintWithinDay({
            manualWindows: day.manualWindows,
            // The SLID minute, not the released one: a ghost left under the pointer would
            // promise a slot the row never takes.
            startMinutes: ghostStartMinutes,
            durationMinutes: preview.durationMinutes,
          });

  /**
   * Where the whole gesture ends on the clock, or `null` when it does not end on this day at all.
   * A move's `durationMinutes` is the whole RUN's, across days, so `start + duration` is not a
   * time of day; `footprintEnd` is the one place that is answered. A resize is unaffected.
   */
  const ghostEndMinutes =
    preview === null
      ? null
      : footprintEnd({
          manualWindows: day.manualWindows,
          startMinutes: ghostStartMinutes,
          durationMinutes: preview.durationMinutes,
        });

  // No start on this day could hold the gesture, which is why the clamp has nothing true to
  // say: `latestStartFor` falls back to the first window's start when nothing fits. Asked only
  // of a drop that lands LITERALLY — elsewhere the answer is the DIVISION the plan draws.
  const longerThanTheDay =
    preview !== null &&
    ghost === null &&
    !dayHoldsMinutes(day.manualWindows, preview.durationMinutes);

  /** The day as the "stop the day here" planner reads it, `null` where the action makes no sense. */
  const closeDayInput = useMemo<CloseDayInput | null>(
    () =>
      onCloseDay === undefined
        ? null
        : closeDayInputFor(
            day,
            groups.flatMap((group) => group.blocks),
            gaps,
          ),
    [onCloseDay, day, groups, gaps],
  );

  // What becomes of the hours, named day by day. Said only when some of them leave the day the
  // pointer is on: all of them staying needs no sentence, the rectangle being the answer.
  const carryTextFor = (plan: GhostPlan | null): string | null => {
    if (plan === null) return null;
    const parts = plan.byDay.map((part) => format.hoursOnDay(part.date, part.minutes));
    // The week on screen ran out before the hours did — never "they do not fit".
    if (plan.beyondMinutes > 0) {
      parts.push(t('grid.dropCarriesLater', { hours: format.hourNumber(plan.beyondMinutes) }));
    }
    if (parts.length < 2 && plan.byDay[0]?.date === plan.date) return null;
    return t('grid.dropFillsAndCarries', { parts: parts.join(t('units.listSeparator')) });
  };

  const carrySentence = carriesLabel ? carryTextFor(ghost) : null;

  /** The same three answers for the scissors' fragment. */
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
      /*
       * PAINTING starts here, on the column's own background. Everything draggable on the grid
       * stops propagation at press, so this only ever fires on empty space — and while a split
       * fragment is waiting for its target the controller is disabled, because there a grid click
       * already means "put it here".
       */
      onPointerDown={(event) => paint.begin(event, day.date)}
    >
      {bands.map((band) => (
        <div
          key={`${band.kind}-${band.startMinutes}`}
          // The break is drawn COMPRESSED while the margins keep the axis's ordinary scale: the
          // owner puts real work in a margin by hand and none in the comida.
          className={[styles.band, band.kind === 'lunch' ? styles.bandBreak : '']
            .filter(Boolean)
            .join(' ')}
          style={{
            top: `${timeline.yOf(band.startMinutes)}px`,
            // Between two CLOCK times, so it covers exactly the compressed segment.
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
       * Everything in this column that belongs to the WEEK and nothing that belongs to the
       * gesture: the week-change animation moves this, and the rectangle that must never slide
       * out from under the pointer is the ghost, a sibling of this below.
       */}
      <div
        className={[styles.columnBody, slideClass(slide)].filter(Boolean).join(' ')}
        // Its own animation ending, not a block's `settling` bubbling up through it.
        onAnimationEnd={(event) => {
          if (event.target === event.currentTarget) setSliding(false);
        }}
      >
        {emptyLabel === null ? null : (
          // On the day's own working time, not the column's midpoint, which on the documented
          // shift is 13:45 — the lip of the lunch band, where the word read as debris.
          <span
            className={styles.empty}
            style={{ top: `${timeline.yOf(emptyLabelMinutes(day.periods, timeline))}px` }}
          >
            {emptyLabel}
          </span>
        )}

        {/*
         * The same view the block grouping was read over. A gap's duration is net working minutes, so
         * a gap across the comida is TWO rows, drawn joined with the seam and the `sigue…` marks
         * exactly as a job cut there is — one unit, one reason, one lane.
         *
         * AND IT IS DRAGGED, like a padlocked row: the whole UNIT moves, it lands on the minute it
         * was released and only a press that TRAVELS moves it — a plain click opens the form.
         */}
        {gapSegmentsOf(gapGroups, day.manualWindows).map((segment) => {
          const { gap, group, isFirst, isLast, seamAbove, seamBelow } = segment;
          const lane = lanes.get(group.id) ?? SINGLE_LANE;
          const label = format.dayTimeHours(gap.date, gap.startMinutes, gap.durationMinutes);
          // The absence, not this row: both gestures and the form address the unit.
          const gapTarget = gapTargetFor(group, gapColor);
          // Same order as a block's: the past is a stronger rule than a save in flight. A CLICK
          // still opens the form on both, which is how a past absence is corrected.
          const inert = day.isPast ? ('past' as const) : busy ? ('busy' as const) : undefined;
          const style = {
            '--ww-gap-color': gapColor,
            top: `${timeline.yOf(gap.startMinutes)}px`,
            // The row's own clock interval: no stored row straddles a break any more, gaps
            // included, so its net minutes and its clock minutes are the same number.
            height: `${timeline.heightBetween(gap.startMinutes, gap.startMinutes + gap.durationMinutes)}px`,
            left: `calc(${(lane.lane / lane.lanes) * 100}% + 2px)`,
            width: `calc(${100 / lane.lanes}% - 4px)`,
          } as React.CSSProperties;
          // The reason belongs to the UNIT, so the continuation does not repeat it — it says it
          // carries on instead, the same division of labour a block's two halves use.
          const reason = seamAbove ? '' : group.reason;
          const className = [
            styles.gap,
            isFirst ? styles.gapFirst : '',
            isLast ? styles.gapLast : '',
            seamAbove ? styles.gapContinued : '',
            seamBelow ? styles.gapContinuesBelow : '',
            drag.liftedRowIds.includes(gap.id) ? styles.gapLifted : '',
          ]
            .filter(Boolean)
            .join(' ');
          const body = (
            <>
              <span className={styles.gapReason}>{reason}</span>
              {seamAbove || seamBelow ? (
                <span className={styles.gapContinues}>
                  {t(seamAbove ? 'grid.gapContinuesAbove' : 'grid.gapContinuesBelow')}
                </span>
              ) : null}
            </>
          );
          // The seam said in words, because the ellipsis is quiet by design and a narrow column
          // clips it first.
          const seamHint = seamAbove
            ? t('block.markContinuesAbove')
            : seamBelow
              ? t('block.markContinuesBelow')
              : '';
          // A gap's whole gesture vocabulary, none of it visible by looking. Withheld on a frozen
          // day, where the two gestures are refused and only the form is left.
          const gestures = day.isPast
            ? [t('day.frozenHint')]
            : [t('grid.gapDrag'), isLast ? t('grid.gapResize') : '', t('grid.gapOpens')];
          const facts = [group.reason, label, seamHint, ...gestures].filter((line) => line !== '');

          return (
            <div
              key={gap.id}
              className={className}
              style={style}
              title={facts.join('\n')}
              /*
               * A DIV rather than a BUTTON, and the click comes from the drag layer: `begin`'s
               * `preventDefault` does not stop a button firing its own click, so a press that did
               * not travel would open the form twice — once natively and once as `onClick`. The
               * keyboard has no press to own, so it goes straight to the form.
               */
              role={onOpenGap === undefined ? undefined : 'button'}
              tabIndex={onOpenGap === undefined ? undefined : 0}
              onPointerDown={(event) => drag.beginMove(event, gapTarget, { inert })}
              onKeyDown={
                onOpenGap === undefined
                  ? undefined
                  : (event) => {
                      if (event.key !== 'Enter' && event.key !== ' ') return;
                      event.preventDefault();
                      onOpenGap(gapTarget.gap);
                    }
              }
            >
              {body}
              {/*
               * The bottom edge, on the LAST row of the unit only: an absence has ONE duration,
               * measured from its own start, so that edge is the only one that is its END. It sizes
               * ABSOLUTELY — there is no job to hand hours to, so nothing is ever asked — and this
               * is no exception to «the padlock holds the length»: that rule is about rows the
               * ENGINE lays out, and a gap never is one.
               */}
              {!isLast || day.isPast ? null : (
                <div
                  className={styles.gapResize}
                  role="separator"
                  aria-label={t('grid.gapResize')}
                  title={t('grid.gapResizeHint')}
                  onPointerDown={(event) => drag.beginResize(event, gapTarget, { inert })}
                />
              )}
            </div>
          );
        })}

        {/* The same view the grouping was read over, so a unit and its seam agree. */}
        {segmentsOf(groups, day.manualWindows).map((segment) => {
          const target = targetFor(segment.group, day, runFor(runs, segment.group));
          const closeDay = closeDayAfter(closeDayInput, segment.block);
          const lane = lanes.get(segment.group.id) ?? SINGLE_LANE;
          // Why this press cannot write; it is still tracked, so a CLICK still opens the job.
          // The past comes first because `allowed` is worked out for the day the ghost is OVER
          // — a past row dragged onto a future day was accepted and history moved.
          const inert = day.isPast ? ('past' as const) : busy ? ('busy' as const) : undefined;
          return (
            <CalendarBlock
              key={segment.block.id}
              segment={segment}
              timeline={timeline}
              lane={lane}
              // The block's own width: `.block` is inset 2 px each side of its lane's share.
              blockWidth={columnWidth === null ? null : columnWidth / lane.lanes - 4}
              overflow={isOverflow(segment.group, day)}
              frozen={day.isPast}
              lifted={drag.liftedRowIds.includes(segment.block.id)}
              cutAtMinutes={
                dropEffect?.kind === 'cut' && dropEffect.blockId === segment.block.id
                  ? dropEffect.cutMinutes
                  : undefined
              }
              busy={busy}
              onPointerDownBody={(event) => drag.beginMove(event, target, { inert })}
              // The hover bar is over the block, so it drags it too. See `BeginOptions.overlay`.
              onPointerDownActions={(event) => drag.beginMove(event, target, { overlay: true, inert })}
              // Every row but a past one: `resizeBlock` refuses the past first and for its own
              // reason (`past-block-frozen`), and accepts every other row.
              resizable={!day.isPast}
              onPointerDownResize={(event) =>
                drag.beginResize(
                  event,
                  {
                    ...target,
                    // A move is the whole unit; a resize is the STRETCH THAT BEGINS AT THIS ROW
                    // — this row plus the rows of the unit continuing it after the break, the
                    // same stretch `resizeBlock` sizes on the server.
                    blockId: segment.block.id,
                    startMinutes: segment.block.startMinutes,
                    durationMinutes: segment.group.blocks
                      .slice(segment.index)
                      .reduce((total, row) => total + row.durationMinutes, 0),
                    // THE ROWS IN THE AIR ARE THE STRETCH, not the whole run. A move lifts every row
                    // of the unit because the ghost draws all of it; a resize reshapes ONE day, and
                    // lighting up the job across every day it occupies read as "this is about to cut
                    // hours from those days too" — with no way to aim at them.
                    rowIds: segment.group.blocks.slice(segment.index).map((row) => row.id),
                  },
                  // The past and a save in flight, carried over from the move. There is no third
                  // reason any more: every row the server accepts, the edge now drags.
                  { inert },
                )
              }
              onOpen={() => onOpenJob(segment.block.projectId)}
              onToggleLock={() => onToggleLock(segment.block)}
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
                // An insertion point rather than a placement. See `ranked` above.
                ranked ? styles.ghostRanked : '',
                // ONE insertion point per gesture, however many rectangles and columns the
                // hours land in — asked of the whole gesture, never of this column.
                index === 0 && carriesLabel ? '' : styles.ghostContinued,
                // A refusal is drawn like a forbidden day: the save writes nothing either way.
                gesture.allowed && !denied ? '' : styles.ghostDenied,
              ]
                .filter(Boolean)
                .join(' ')}
              style={{
                '--ww-block-color': gesture.color,
                top: `${timeline.yOf(row.startMinutes)}px`,
                // Both edges through the axis, which clamps, so the ghost never escapes the grid.
                height: `${timeline.heightBetween(row.startMinutes, row.startMinutes + row.durationMinutes)}px`,
              } as React.CSSProperties}
            >
              {/* One label per gesture, on its FIRST rectangle wherever that is; every other is
                   bare. A column holding only the CARRIED hours says just that. */}
              {index === 0 && !carriesLabel ? (
                <div className={styles.ghostLabel}>
                  <span className={styles.ghostMeta}>
                    {t('grid.dropCarries', { hours: format.hourNumber(spillMinutes) })}
                  </span>
                </div>
              ) : null}
              {index === 0 && carriesLabel ? (
                // The words sit on their own backing: the ghost is translucent so what is
                // underneath stays visible, and on a 128 px column the two sentences collided.
                <div className={styles.ghostLabel}>
                  {/* Printed only where the range is a PROMISE — a pinned drop, a resize — and
                       only where there is an end at all. Otherwise the START, still exact. */}
                  {ranked ? null : (
                    <span className={styles.ghostMeta}>
                      {ghostEndMinutes === null
                        ? t('grid.dropStartsAt', { time: format.time(ghostStartMinutes) })
                        : format.timeRange(ghostStartMinutes, ghostEndMinutes)}
                    </span>
                  )}
                  {/* The hours — or, when they do not all land here, WHERE THEY GO. It REPLACES
                       the bare total: a 1,5 h rectangle holds four lines, not six. */}
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
                  {/* This and the clamp below are for a drop that lands LITERALLY only. */}
                  {/* The drop moved to THIS day, the one the pointer is over not holding the run
                       from where the hand is. The ghost is already here; this names the reason. */}
                  {preview?.rolled !== true ? null : (
                    <span className={styles.ghostClamped}>
                      {t('grid.dropNextDay', { day: format.dayHeader(day.date) })}
                    </span>
                  )}
                  {/* A run no day can hold says that instead, clamp or no clamp: at the top of
                       the axis nothing was pulled up and `clamped` is false. */}
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
                  {/* Why the ghost is not under the pointer: a pinned drop onto a gap or a lock
                       is slid to the first clear slot. The rectangle already draws where. */}
                  {resolution?.slid !== true ? null : (
                    <span className={styles.ghostClamped}>
                      {t('grid.dropSlid', { time: format.time(ghostStartMinutes) })}
                    </span>
                  )}
                  {effectSentence === null ? null : (
                    <span className={styles.ghostEffect}>
                      {t(effectSentence.key, { name: effectSentence.name })}
                    </span>
                  )}
                </div>
              ) : null}
            </div>
          ))}

      {/* The band, drawn as the ROWS the absence will be stored as — cut at the comida like every
          other ghost here, because one rectangle through the grey band promises a shape that will
          never exist. It writes nothing: the release opens the form. */}
      {painting === null
        ? null
        : segmentDroppedRow(day.manualWindows, painting).map((row, index) => (
            <div
              key={row.startMinutes}
              className={styles.paintBand}
              style={{
                '--ww-gap-color': gapColor,
                top: `${timeline.yOf(row.startMinutes)}px`,
                height: `${timeline.heightBetween(row.startMinutes, row.startMinutes + row.durationMinutes)}px`,
              } as React.CSSProperties}
            >
              {index !== 0 ? null : (
                <span className={styles.paintLabel}>
                  {/* Through `clockEndOf`: the band's minutes are NET, so `start + duration` is not
                      a time of day — a 2 h band from 13:00 ends at 16:30, not 15:00. */}
                  {format.timeRange(
                    painting.startMinutes,
                    clockEndOf(day.manualWindows, painting.startMinutes, painting.durationMinutes),
                  )}
                  <span className={styles.paintHours}>{format.hours(painting.durationMinutes)}</span>
                </span>
              )}
            </div>
          ))}

      {/* A split fragment waiting for its target, previewed exactly like the drop it is: in
          segments where it lands literally, as the reflow's own rows where it is a rank. */}
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

// --- The week change, drawn ---

/** Which way the calendar last travelled. `null` on the first week and on any other render. */
type WeekSlide = 'next' | 'previous' | null;

/**
 * Which way the week just moved, so the calendar can slide in from that side. DERIVED rather
 * than passed in, so `goToday`, the arrow keys, the header buttons and the edge hold all get it
 * for free (ISO dates compare chronologically). The FIRST week never slides; after that it stays
 * whatever it last was, harmlessly — only a date change remounts anything.
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

/** The same for a day HEADER, which travels its words rather than its box — see the CSS. */
function slideHeadClass(slide: WeekSlide): string {
  return slide === null ? '' : slide === 'next' ? styles.slideHeadNext : styles.slideHeadPrevious;
}

// --- Derived state ---

/** What the ghost says about the row it is over. One key per branch of the resolver. */
const DROP_EFFECT_KEYS: Record<DropEffect['kind'], string> = {
  cut: 'grid.dropCuts',
  displace: 'grid.dropDisplaces',
  merge: 'grid.dropMerges',
  blocked: 'grid.dropBlocked',
  gap: 'grid.dropOnGap',
};

/**
 * The same for an ABSENCE, and the words are its own: the sentences above are about a block landing
 * on something, and «se unirá» or «se queda en la hora exacta» are not things a gap does.
 */
const GAP_EFFECT_KEYS: Record<GapEffect['kind'], string> = {
  blocked: 'grid.gapBlocked',
  displace: 'grid.gapDisplaces',
};

interface WeekLayout {
  groups: Map<string, BlockGroup[]>;
  gaps: Map<string, Gap[]>;
  /** The same gaps as UNITS: the two halves of one gap are one thing on screen. */
  gapGroups: Map<string, GapGroup[]>;
  lanes: Map<string, Map<string, { lane: number; lanes: number }>>;
  /** The RUN each unit belongs to, keyed by group id. Built for the whole week at once. */
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
  const gapGroups = new Map<string, GapGroup[]>();
  const lanes = new Map<string, Map<string, { lane: number; lanes: number }>>();

  for (const day of view.days) {
    // Grouped over the MANUAL WINDOWS: two rows are one unit when nothing WORKABLE separates
    // them, and half an hour of margin between two rows is workable by hand. Gaps go through the
    // same predicate, and their units are packed here so a gap cut at the comida takes ONE lane.
    const dayGroups = groupBlocks(blocksByDate.get(day.date) ?? [], day.manualWindows);
    const dayGapGroups = groupGaps(gapsByDate.get(day.date) ?? [], day.manualWindows);
    groups.set(day.date, dayGroups);
    gapGroups.set(day.date, dayGapGroups);
    lanes.set(day.date, packDay(dayGroups, dayGapGroups));
  }

  // The movable pool as this side can see it — the mirror of `isMovable` in composition.ts.
  // It is what tells a run where to stop.
  const dayByDate = new Map(view.days.map((day) => [day.date, day]));
  const runs = buildRuns(
    view.days.flatMap((day) => groups.get(day.date) ?? []),
    (block) => {
      const day = dayByDate.get(block.date);
      return !block.locked && day !== undefined && !day.isPast && !day.isWeekend;
    },
  );

  return { groups, gaps: gapsByDate, gapGroups, lanes, runs };
}

/**
 * What a press on this unit picks up: the whole RUN it belongs to. The unit on screen is where
 * the gesture STARTS — what the outcome sentence is measured against — but the run is what MOVES.
 */
function targetFor(group: BlockGroup, day: WeekDay, run: BlockRun): BlockDragTarget {
  const first = group.blocks[0];
  const last = group.blocks[group.blocks.length - 1];
  return {
    kind: 'block',
    groupId: group.id,
    projectId: group.projectId,
    name: first.project.name,
    color: first.project.color,
    date: day.date,
    startMinutes: group.startMinutes,
    durationMinutes: run.totalMinutes,
    rowIds: run.blockIds,
    blockId: last.id,
    // A padlocked unit is fixed by itself: it lands on the minute it is released, on any day.
    fixed: group.locked,
  };
}

/**
 * What a press on a gap picks up: the whole ABSENCE. `fixed` is unconditional — a gap lands on the
 * minute it was released, on every day, because it is not in the queue and there is no rank for it
 * to take. Both halves around the comida travel in `rowIds`, so neither is an obstacle to the drag.
 */
function gapTargetFor(group: GapGroup, gapColor: string): GapDragTarget {
  const unit = gapUnitOf(group);
  return {
    kind: 'gap',
    groupId: group.id,
    gap: unit,
    color: gapColor,
    date: unit.date,
    startMinutes: unit.startMinutes,
    durationMinutes: unit.durationMinutes,
    rowIds: group.gaps.map((row) => row.id),
    fixed: true,
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
 * Friday's `desborde` label: hours the ENGINE parked on the colchón. Anything it could have put
 * there IS overflow, so the exclusions are a past Friday and a PADLOCK. `some` rather than
 * `every`: a unit with any padlocked row in it is not something the engine decided.
 */
function isOverflow(group: BlockGroup, day: WeekDay): boolean {
  if (day.role !== 'buffer' || day.isPast) return false;
  return !group.blocks.some((block) => block.locked);
}

// --- Column widths ---

/**
 * Every column's width in pixels, for one decision no stylesheet can take: whether the hover
 * action bar still leaves any of a block to press (`blockHoldsActions`). From the same
 * `measure()` the drag layer uses, and re-read on resize only.
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
        // Rounded, and replaced only on a real change: a ResizeObserver fires on sub-pixel
        // jitter, and a new Map every time would re-render the whole week.
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
    // `dates` is a dependency because paging changes the keys without changing any size, so
    // the observer alone would never fire and every column would read `null`.
  }, [gridRef, measure, dates]);

  return widths;
}

// --- The settle ---

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
    // `view` is a dependency: the animation must run against the SETTLED layout, which only
    // exists once the refetch has re-rendered the grid.
  }, [settle, view, timeline, gridRef, onSettled]);
}
