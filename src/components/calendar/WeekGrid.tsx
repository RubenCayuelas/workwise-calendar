'use client';

/**
 * The week grid: a time axis and seven day columns, everything inside a column
 * absolutely positioned from `date + startMinutes + durationMinutes`.
 *
 * Three things this component is the only owner of:
 *
 * - MEASUREMENT. The drag layer cannot read the DOM, so the grid publishes a `measure()`
 *   through `metricsRef`: the client Y of the timeline's top plus every column's box.
 *   Measured live rather than cached, so scrolling mid-drag cannot offset the pointer.
 * - THE SETTLE. A drop writes a queue rank, so a row lands where the reflow put it. The
 *   grid knows both the released position and the settled one, so it is where the row
 *   is animated from one to the other.
 * - PLACEMENT MODE. While a split fragment is waiting for a target, the columns take the
 *   click instead of the blocks under them.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useFormat } from '../../lib/useFormat';
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
  dayReflowsOn,
  dropFootprint,
  dropPredecessor,
  resolveDropPreview,
  type DropEffect,
  type DropResolution,
  type QueueRow,
} from './dropEffect';
import { buildRuns, groupBlocks, packDay, segmentsOf, type BlockGroup, type BlockRun } from './grouping';
import { usePressHint, type DragController, type DragTarget, type InertReason } from './useBlockDrag';
import styles from './WeekGrid.module.css';

/** A fragment waiting for the click that says where it goes. */
export interface PlacingFragment {
  blockId: string;
  projectName: string;
  color: string;
  durationMinutes: number;
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
    return { top: cells[0].getBoundingClientRect().top, columns };
  }, []);

  useEffect(() => {
    metricsRef.current = measure;
    return () => {
      metricsRef.current = null;
    };
  }, [measure, metricsRef]);

  const columnWidths = useColumnWidths(gridRef, measure, view.week.dates.join());

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

  useSettleAnimation({ gridRef, settle, timeline, view, onSettled });

  // Where the fragment would land. Only tracked while placing, so the grid does not
  // re-render on every mouse move the rest of the time.
  const [hover, setHover] = useState<{ date: string; startMinutes: number } | null>(null);
  useEffect(() => {
    if (placing === null) setHover(null);
  }, [placing]);

  const slotUnder = useCallback(
    (event: { clientX: number; clientY: number }): { date: string; startMinutes: number } | null => {
      const metrics = measure();
      if (metrics === null) return null;
      const hit = slotAt({ x: event.clientX, y: event.clientY }, metrics, timeline);
      if (hit === undefined) return null;
      // Clamped over the DAY, like a drop: the fragment is a row, and a row ends inside its
      // day. Both the ghost and the click that commits it read this one answer, so the
      // scissors cannot promise 19:45 and then store a row running to 20:45.
      const windows = view.days.find((day) => day.date === hit.date)?.manualWindows ?? [];
      return {
        date: hit.date,
        startMinutes: clampDropStart(windows, hit.snappedMinutes, placing?.durationMinutes ?? 0, timeline),
      };
    },
    [measure, placing, timeline, view.days],
  );

  return (
    <div className={styles.frame}>
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
            <DayHeader key={day.date} day={day} />
          ))}

          <div className={styles.axis} aria-hidden="true">
            {ticks.map((tick, index) => (
              <span
                key={tick.minutes}
                className={[
                  styles.tick,
                  tick.boundary ? styles.tickBoundary : '',
                  index === 0 ? styles.tickFirst : '',
                  index === ticks.length - 1 ? styles.tickLast : '',
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
              gapColor={view.settings.gapColor}
              busy={busy || stale}
              queue={queue}
              drag={drag}
              placing={placing}
              placingSlot={hover}
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
// Day header
// ---------------------------------------------------------------------------

function DayHeader({ day }: { day: WeekDay }): React.JSX.Element {
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
  gapColor: string;
  /**
   * NOTHING CAN BE WRITTEN RIGHT NOW: a mutation is in flight, or the week is reloading.
   * It disables the action bar, and it is the reason a press on a block explains itself
   * (`InertReason.busy`) instead of quietly doing nothing.
   */
  busy: boolean;
  /** The week's movable rows in queue order, for what a re-ranking drop will say. */
  queue: readonly QueueRow[];
  drag: DragController;
  placing: PlacingFragment | null;
  /** The slot the pointer is over while placing a fragment. */
  placingSlot: { date: string; startMinutes: number } | null;
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
  gapColor,
  busy,
  queue,
  drag,
  placing,
  placingSlot,
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

  const ranked = resolution !== null && !resolution.pinned;

  /** Where the ghost is really drawn: the release point, or the slid one. */
  const ghostStartMinutes = resolution?.startMinutes ?? preview?.startMinutes ?? 0;

  /**
   * The row a re-ranked drop lands behind, if the week on screen can see it. `null` says
   * the queue reaches back further than this week, and the ghost falls back to naming the
   * rank without naming a neighbour rather than claiming a first place it cannot check.
   */
  const rankAfter =
    !ranked || drag.target === null
      ? null
      : dropPredecessor(queue, drag.target.blockIds, day.date, ghostStartMinutes);

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
   */
  const ghostRows = useMemo(
    () =>
      preview === null
        ? []
        : dropFootprint({
            manualWindows: day.manualWindows,
            // The SLID minute, not the released one: on a reflowing day a pinned drop over
            // a gap or a lock is moved forward by the server, and a ghost that stayed under
            // the pointer would promise a slot the row never takes.
            startMinutes: ghostStartMinutes,
            durationMinutes: preview.durationMinutes,
          }),
    [preview, day.manualWindows, ghostStartMinutes],
  );

  /** Where the whole drop ends on the clock — its last segment's end, lunch included. */
  const ghostEndMinutes =
    ghostRows.length === 0
      ? 0
      : ghostRows[ghostRows.length - 1].startMinutes +
        ghostRows[ghostRows.length - 1].durationMinutes;

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
      ]
        .filter(Boolean)
        .join(' ')}
      data-day-column={day.date}
    >
      {bands.map((band) => (
        <div
          key={`${band.kind}-${band.startMinutes}`}
          className={styles.band}
          style={{
            top: `${timeline.yOf(band.startMinutes)}px`,
            height: `${timeline.heightOf(band.endMinutes - band.startMinutes)}px`,
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
          height: `${timeline.heightOf(gap.durationMinutes)}px`,
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

      {preview === null
        ? null
        : ghostRows.map((row, index) => (
            <div
              key={row.startMinutes}
              className={[
                styles.ghost,
                // An insertion point rather than a placement: hollow, with a rule on the
                // edge the drop ranks itself at. See `ranked` above.
                ranked ? styles.ghostRanked : '',
                index === 0 ? '' : styles.ghostContinued,
                // A refusal is drawn like a forbidden day: the save writes nothing either
                // way. (`dropEffect` is null unless `allowed`, so this reads as one test.)
                preview.allowed && dropEffect?.kind !== 'blocked' ? '' : styles.ghostDenied,
              ]
                .filter(Boolean)
                .join(' ')}
              style={{
                '--ww-block-color': preview.color,
                top: `${timeline.yOf(row.startMinutes)}px`,
                // Both edges through `yOf`, which clamps to the axis: a long unit dropped
                // late in the day genuinely runs past the last period once the lunch break
                // is added back, and the ghost must not escape the grid to say so.
                height: `${Math.max(1, timeline.yOf(row.startMinutes + row.durationMinutes) - timeline.yOf(row.startMinutes))}px`,
              } as React.CSSProperties}
            >
              {/*
               * The first rectangle carries the whole gesture — the span it runs over and
               * the NET hours it is — exactly as a stored unit puts its name and hours on
               * its first row and leaves the continuation bare. Per-rectangle labels would
               * read as two separate drops, which is the one thing this is not.
               */}
              {index === 0 ? (
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
                   */}
                  {ranked ? null : (
                    <span className={styles.ghostMeta}>
                      {format.timeRange(ghostStartMinutes, ghostEndMinutes)}
                    </span>
                  )}
                  <span className={styles.ghostMeta}>{format.hours(preview.durationMinutes)}</span>
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
                   */}
                  {/*
                   * THE DROP MOVED TO THIS DAY because the one the pointer is over cannot
                   * hold the run from where the hand is — which is what aiming past the
                   * bottom of a column means in any calendar. The ghost is already HERE, so
                   * this only names the reason; without it the jump to the next column is
                   * the app appearing to lose the drag.
                   */}
                  {preview.rolled !== true ? null : (
                    <span className={styles.ghostClamped}>
                      {t('grid.dropNextDay', { day: format.dayHeader(day.date) })}
                    </span>
                  )}
                  {preview.clamped !== true ? null : (
                    <span className={styles.ghostClamped}>
                      {t('grid.dropNoLower', {
                        hours: format.hourNumber(preview.durationMinutes),
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
          previewed in segments too — a 5 h fragment placed at 10:00 crosses lunch and is
          stored as two rows exactly as a dragged one is. */}
      {placing === null || placingSlot === null || placingSlot.date !== day.date
        ? null
        : dropFootprint({
            manualWindows: day.manualWindows,
            startMinutes: placingSlot.startMinutes,
            durationMinutes: placing.durationMinutes,
          }).map((row, index) => (
            <div
              key={row.startMinutes}
              className={[
                styles.ghost,
                index === 0 ? '' : styles.ghostContinued,
                day.isPast ? styles.ghostDenied : '',
              ]
                .filter(Boolean)
                .join(' ')}
              style={{
                '--ww-block-color': placing.color,
                top: `${timeline.yOf(row.startMinutes)}px`,
                height: `${Math.max(1, timeline.yOf(row.startMinutes + row.durationMinutes) - timeline.yOf(row.startMinutes))}px`,
              } as React.CSSProperties}
            >
              {index === 0 ? (
                <div className={styles.ghostLabel}>
                  <span className={styles.ghostName}>{placing.projectName}</span>
                  <span className={styles.ghostMeta}>{format.hours(placing.durationMinutes)}</span>
                  <span className={styles.ghostMeta}>{t('grid.dropHere')}</span>
                </div>
              ) : null}
            </div>
          ))}
    </div>
  );
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
