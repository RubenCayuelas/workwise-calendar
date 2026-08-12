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
  nonWorkingBands,
  slotAt,
  type GridMetrics,
  type Timeline,
} from './geometry';
import { dropEffectOf, type DropEffect } from './dropEffect';
import { groupBlocks, packDay, segmentsOf, type BlockGroup } from './grouping';
import type { DragController, DragTarget } from './useBlockDrag';
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
  /** "Back to automatic" for a whole unit: the rows whose length was set by hand. */
  onReleaseDuration: (blockIds: readonly string[]) => void;
  /**
   * "Stop the day here". Wired only when the gap form exists — it opens that form
   * pre-filled, since the gap is what makes the day hold fewer hours.
   */
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
  placing,
  onPlace,
  onOpenJob,
  onOpenGap,
  onToggleLock,
  onReleaseDuration,
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

  // One pass over the week: the rows of each day, grouped into units and packed into
  // lanes so hand-made overlaps (allowed on the weekend and in the past) stay visible.
  const layout = useMemo(() => buildLayout(view), [view]);
  const ticks = useMemo(() => axisTicks(view.shape.periods, timeline), [view.shape.periods, timeline]);

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
      return hit === undefined ? null : { date: hit.date, startMinutes: hit.snappedMinutes };
    },
    [measure, timeline],
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
              ticks={ticks}
              timeline={timeline}
              gapColor={view.settings.gapColor}
              busy={busy}
              drag={drag}
              placing={placing}
              placingSlot={hover}
              onOpenJob={onOpenJob}
              onOpenGap={onOpenGap}
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
  ticks: { minutes: number; boundary: boolean }[];
  timeline: Timeline;
  gapColor: string;
  busy: boolean;
  drag: DragController;
  placing: PlacingFragment | null;
  /** The slot the pointer is over while placing a fragment. */
  placingSlot: { date: string; startMinutes: number } | null;
  onOpenJob: (projectId: string) => void;
  onOpenGap?: (gap: Gap) => void;
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
  ticks,
  timeline,
  gapColor,
  busy,
  drag,
  placing,
  placingSlot,
  onOpenJob,
  onOpenGap,
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
   * What the drop hovering over this column will do to the row underneath it — a cut,
   * a merge, or a refusal. `null` for a resize (which touches only its own row) and
   * whenever the ghost is over free time.
   */
  const dropEffect = useMemo<DropEffect | null>(() => {
    // Nothing to promise about a drop that will not be accepted (a past day), and a
    // resize touches only its own row.
    if (preview === null || !preview.allowed || preview.kind !== 'move') return null;
    if (drag.target === null) return null;
    return dropEffectOf({
      rows: groups.flatMap((group) => group.blocks),
      movingBlockIds: drag.target.blockIds,
      projectId: drag.target.projectId,
      dayIsWeekend: day.isWeekend,
      locked: drag.target.locked,
      startMinutes: preview.startMinutes,
      durationMinutes: preview.durationMinutes,
    });
  }, [preview, drag.target, groups, day.isWeekend]);

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

      {emptyLabel === null ? null : <span className={styles.empty}>{emptyLabel}</span>}

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
            title={`${reason}\n${label}`.trim()}
            disabled={busy}
            onClick={() => onOpenGap(gap)}
          >
            <span className={styles.gapReason}>{reason}</span>
          </button>
        );
      })}

      {segmentsOf(groups).map((segment) => {
        const target = targetFor(segment.group, day);
        const closeDay = closeDayAfter(closeDayInput, segment.block);
        return (
          <CalendarBlock
            key={segment.block.id}
            segment={segment}
            timeline={timeline}
            lane={lanes.get(segment.group.id) ?? SINGLE_LANE}
            overflow={isOverflow(segment.group, day)}
            frozen={day.isPast}
            lifted={drag.activeGroupId === segment.group.id}
            cutAtMinutes={
              dropEffect?.kind === 'cut' && dropEffect.blockId === segment.block.id
                ? dropEffect.cutMinutes
                : undefined
            }
            busy={busy}
            onPointerDownBody={(event) => drag.beginMove(event, target)}
            onPointerDownResize={(event) =>
              drag.beginResize(event, {
                ...target,
                // A move is the unit; a resize is THIS row. Each row of a unit is its
                // own rectangle with its own bottom edge, and the engine sizes rows.
                blockId: segment.block.id,
                startMinutes: segment.block.startMinutes,
                durationMinutes: segment.block.durationMinutes,
              })
            }
            onOpen={() => onOpenJob(segment.block.projectId)}
            onToggleLock={() => onToggleLock(segment.block)}
            // One release for the whole unit: a hand-set stretch cut at the lunch break
            // is two marked rows, and giving the engine back only half of it would
            // leave the other half holding the day open for no visible reason.
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

      {preview === null ? null : (
        <div
          className={[
            styles.ghost,
            // A refusal is drawn like a forbidden day: the save writes nothing either
            // way. (`dropEffect` is null unless `allowed`, so this reads as one test.)
            preview.allowed && dropEffect?.kind !== 'blocked' ? '' : styles.ghostDenied,
          ]
            .filter(Boolean)
            .join(' ')}
          style={{
            '--ww-block-color': preview.color,
            top: `${timeline.yOf(preview.startMinutes)}px`,
            height: `${timeline.heightOf(preview.durationMinutes)}px`,
          } as React.CSSProperties}
        >
          <span className={styles.ghostMeta}>
            {format.timeRange(preview.startMinutes, preview.startMinutes + preview.durationMinutes)}
          </span>
          <span className={styles.ghostMeta}>{format.hours(preview.durationMinutes)}</span>
          {dropEffect === null ? null : (
            <span className={styles.ghostEffect}>
              {t(DROP_EFFECT_KEYS[dropEffect.kind], { name: dropEffect.projectName })}
            </span>
          )}
        </div>
      )}

      {placing === null || placingSlot === null || placingSlot.date !== day.date ? null : (
        <div
          className={[styles.ghost, day.isPast ? styles.ghostDenied : ''].filter(Boolean).join(' ')}
          style={{
            '--ww-block-color': placing.color,
            top: `${timeline.yOf(placingSlot.startMinutes)}px`,
            height: `${timeline.heightOf(placing.durationMinutes)}px`,
          } as React.CSSProperties}
        >
          <span className={styles.ghostName}>{placing.projectName}</span>
          <span className={styles.ghostMeta}>{format.hours(placing.durationMinutes)}</span>
          <span className={styles.ghostMeta}>{t('grid.dropHere')}</span>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Derived state
// ---------------------------------------------------------------------------

/** What the ghost says about the row it is over. One key per branch of the resolver. */
const DROP_EFFECT_KEYS: Record<DropEffect['kind'], string> = {
  cut: 'grid.dropCuts',
  merge: 'grid.dropMerges',
  blocked: 'grid.dropBlocked',
};

interface WeekLayout {
  groups: Map<string, BlockGroup[]>;
  gaps: Map<string, Gap[]>;
  lanes: Map<string, Map<string, { lane: number; lanes: number }>>;
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
    const dayGroups = groupBlocks(blocksByDate.get(day.date) ?? [], day.periods);
    groups.set(day.date, dayGroups);
    lanes.set(day.date, packDay(dayGroups, gapsByDate.get(day.date) ?? []));
  }

  return { groups, gaps: gapsByDate, lanes };
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

/** Every row of the unit, in queue order — a group moves as a whole. */
function targetFor(group: BlockGroup, day: WeekDay): DragTarget {
  const first = group.blocks[0];
  const last = group.blocks[group.blocks.length - 1];
  return {
    groupId: group.id,
    projectId: group.projectId,
    name: first.project.name,
    color: first.project.color,
    date: day.date,
    startMinutes: group.startMinutes,
    durationMinutes: group.totalMinutes,
    blockIds: group.blocks.map((block) => block.id),
    blockId: last.id,
    locked: group.locked,
  };
}

/**
 * Friday's `desborde` label.
 *
 * There is no `manually_placed` flag by design, so this is derived from the buffer rule
 * itself: the colchón "receives only overflow generated by the growth of already-placed
 * work", so anything the engine could have put there IS overflow. A locked row was
 * parked there on purpose and a past Friday is a record, so neither counts.
 */
function isOverflow(group: BlockGroup, day: WeekDay): boolean {
  return day.role === 'buffer' && !day.isPast && !group.locked;
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
