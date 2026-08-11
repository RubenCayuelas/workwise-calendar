'use client';

/**
 * The week view — the app's main screen, and the only place block gestures turn into
 * API calls.
 *
 * WHAT LIVES HERE AND WHY:
 *
 * - The week (`useWeek`), which refetches after every mutation. A recomposition can
 *   rewrite rows in weeks this screen is not even showing, so a mutation's response is
 *   never merged into local state.
 * - The gesture handlers. Each one is one transaction on the server, and each one is
 *   followed by the honest consequences: `touchedLockedBlockIds` is surfaced (CLAUDE.md:
 *   a locked block is never grown or shrunk silently), and a row that settled somewhere
 *   other than where it was dropped says so.
 * - The two-step scissors: choose the hours, then click where the fragment goes.
 *
 * WHAT DOES NOT LIVE HERE: the job panel, the job form and the gap form. They are
 * separate screens sharing `SidePanel`, so they arrive as render props — see the three
 * `render*` seams below. Every control whose form is not wired is disabled rather than
 * dead.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ConfirmDialog, InlineBanner, useToast } from '../ui';
import { useFormat } from '../../lib/useFormat';
import {
  deleteBlock as apiDeleteBlock,
  getProject,
  moveBlock as apiMoveBlock,
  resizeBlock as apiResizeBlock,
  setBlockLock as apiSetBlockLock,
  splitBlock as apiSplitBlock,
  type BlockMutation,
  type ScheduleSummary,
  type WeekBlock,
  type WeekDay,
  type WeekView,
} from '../../lib/api-client';
import type { DayShape, Gap } from '../../types';
import { PROJECT_COLORS } from '../../lib/projectColors';
import { rankFor, createTimeline, type GridMetrics } from './geometry';
import { SummaryStrip } from './SummaryStrip';
import { WeekHeader } from './WeekHeader';
import { WeekGrid, type PlacingFragment, type SettleRequest } from './WeekGrid';
import { MIN_SPLITTABLE_MINUTES, SplitBlockDialog } from './SplitBlockDialog';
import { useBlockDrag, type DragTarget } from './useBlockDrag';
import { useWeek } from './useWeek';
import styles from './CalendarScreen.module.css';

// ---------------------------------------------------------------------------
// The seams to the screens that are not the grid
// ---------------------------------------------------------------------------

export interface JobPanelContext {
  projectId: string;
  close: () => void;
  /** Call after a save or a delete: the week refetches. */
  onChanged: () => void;
  /** The shop's local today, from the server. Never the browser's clock. */
  today: string;
}

export interface NewJobContext {
  close: () => void;
  onChanged: () => void;
  today: string;
  /** Where the queue currently ends, which is where a new job will start. */
  summary: ScheduleSummary;
  /** The swatch the calendar shows least of, so two new jobs are not the same colour. */
  suggestedColor: string;
}

export interface GapFormContext {
  /** The gap being edited, or `null` for a new one. */
  gap: Gap | null;
  close: () => void;
  onChanged: () => void;
  today: string;
  /** Gives a new gap its default start time and its duration ceiling. */
  shape: DayShape;
  /** `settings.gapColor` — the one colour every gap is painted in. */
  gapColor: string;
  /** A new gap lands on a day the owner can see: today, or this week's Monday. */
  defaultDate: string;
}

export interface CalendarScreenProps {
  /** Clicking a block opens this. Without it, a block click does nothing. */
  renderJobPanel?: (context: JobPanelContext) => ReactNode;
  /** `+ Nuevo trabajo`. Without it, the button is disabled. */
  renderNewJob?: (context: NewJobContext) => ReactNode;
  /** `Nuevo hueco` and clicking a gap. Without it, gaps are read-only labels. */
  renderGapForm?: (context: GapFormContext) => ReactNode;
  settingsHref?: string;
}

export function CalendarScreen({
  renderJobPanel,
  renderNewJob,
  renderGapForm,
  settingsHref = '/settings',
}: CalendarScreenProps): React.JSX.Element {
  const { t } = useTranslation();
  const format = useFormat();
  const toast = useToast();
  const week = useWeek();
  const { view, busy, loading, mutate } = week;

  const metricsRef = useRef<(() => GridMetrics | null) | null>(null);
  const viewRef = useRef<WeekView | null>(null);
  viewRef.current = view;

  const gridArea = useRef<HTMLDivElement | null>(null);
  const areaHeight = useElementHeight(gridArea);

  const [openJobId, setOpenJobId] = useState<string | null>(null);
  const [newJobOpen, setNewJobOpen] = useState(false);
  const [gapTarget, setGapTarget] = useState<{ gap: Gap | null } | null>(null);
  const [splitSource, setSplitSource] = useState<WeekBlock | null>(null);
  const [placing, setPlacing] = useState<PlacingFragment | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{ block: WeekBlock; totalMinutes: number } | null>(null);
  const [settle, setSettle] = useState<SettleRequest | null>(null);

  // The axis: from Settings, widened to cover anything already on the calendar (a block
  // hand-dropped into a margin, or left over from a longer working day, must be visible
  // rather than clipped), and scaled so the whole day fits the space there is.
  const timeline = useMemo(() => {
    if (view === null) return null;
    const cover: number[] = [];
    for (const block of view.blocks) {
      cover.push(block.startMinutes, block.startMinutes + block.durationMinutes);
    }
    for (const gap of view.gaps) {
      cover.push(gap.startMinutes, gap.startMinutes + gap.durationMinutes);
    }
    return createTimeline(view.shape, {
      cover,
      // The sticky day-header row and the frame's two hairlines come off the top.
      fitHeight: areaHeight === null ? undefined : areaHeight - DAY_HEADER_ALLOWANCE,
    });
  }, [view, areaHeight]);

  const dayAt = useCallback(
    (date: string): WeekDay | undefined => viewRef.current?.days.find((day) => day.date === date),
    [],
  );

  /** Starts already taken on a date, so a drop rank never ties with an older row. */
  const takenStartsOn = useCallback(
    (date: string, exclude: readonly string[]): number[] =>
      (viewRef.current?.blocks ?? [])
        .filter((block) => block.date === date && !exclude.includes(block.id))
        .map((block) => block.startMinutes),
    [],
  );

  const report = useCallback(
    (result: BlockMutation | undefined): void => {
      if (result === undefined) return;
      const count = result.touchedLockedBlockIds.length;
      if (count > 0) toast.warning(t('notices.touchedLockedBlocks', { count }));
    },
    [t, toast],
  );

  // -------------------------------------------------------------------------
  // Gestures
  // -------------------------------------------------------------------------

  /**
   * A drop. The whole grouped unit moves, not just the row that was grabbed: the engine
   * merges consecutive rows of one job into a single queue item, so re-ranking half a
   * unit would leave the other half behind at its old rank and split the job in two.
   *
   * One call per row, in queue order, one minute apart so their internal order survives.
   * Each is its own transaction, so the calendar is never half-written; the cost is that
   * a refusal partway through a two-row unit leaves the first row moved, which the error
   * banner names and a second drag fixes.
   */
  const onMove = useCallback(
    (target: DragTarget, drop: { date: string; startMinutes: number }): void => {
      setSettle({
        blockId: target.blockIds[0],
        date: drop.date,
        startMinutes: drop.startMinutes,
        after: viewRef.current,
      });

      void mutate(async () => {
        let last: BlockMutation | undefined;
        for (const [index, blockId] of target.blockIds.entries()) {
          last = await apiMoveBlock(blockId, {
            date: drop.date,
            startMinutes: drop.startMinutes + index,
          });
        }
        return last;
      }).then(report);
    },
    [mutate, report],
  );

  const onResize = useCallback(
    (target: DragTarget, durationMinutes: number): void => {
      void mutate(() => apiResizeBlock(target.blockId, durationMinutes)).then(report);
    },
    [mutate, report],
  );

  const onToggleLock = useCallback(
    (block: WeekBlock): void => {
      void mutate(() => apiSetBlockLock(block.id, !block.locked)).then(report);
    },
    [mutate, report],
  );

  const drag = useBlockDrag({
    measure: () => metricsRef.current?.() ?? null,
    // A placeholder keeps the hook's contract simple; gestures are disabled until the
    // real timeline has arrived anyway.
    timeline: timeline ?? FALLBACK_TIMELINE,
    dayAt,
    takenStartsOn,
    enabled: timeline !== null && !busy && !loading && placing === null,
    onMove,
    onResize,
    onClick: (target) => setOpenJobId(target.projectId),
  });

  /**
   * The hover bar's delete: these hours leave the job. The job's own block count and
   * total come from `GET /api/projects/:id` rather than the week, because both are facts
   * about the whole job and the week only holds seven days of it.
   */
  const onDelete = useCallback(
    (block: WeekBlock): void => {
      void getProject(block.projectId)
        .then((detail) => {
          if (detail.blocks.length <= 1) {
            toast.error(t('block.deleteOnlyBlock'));
            return;
          }
          setDeleteTarget({ block, totalMinutes: detail.project.totalMinutes - block.durationMinutes });
        })
        .catch(() => toast.error(t('errors.loadFailed')));
    },
    [t, toast],
  );

  const onSplit = useCallback(
    (block: WeekBlock): void => {
      // A fragment and a remainder both have to exist, and the smallest either can be is
      // half an hour — so a row under an hour cannot be cut at all.
      if (block.durationMinutes < MIN_SPLITTABLE_MINUTES) {
        toast.error(t('errors.splitExceedsBlock'));
        return;
      }
      setSplitSource(block);
    },
    [t, toast],
  );

  /** Step two of the scissors: the click that says where the fragment goes. */
  const onPlace = useCallback(
    (slot: { date: string; startMinutes: number }): void => {
      const fragment = placing;
      if (fragment === null || timeline === null) return;

      const day = dayAt(slot.date);
      // The engine never writes to the past, and neither does a placement.
      if (day === undefined || day.isPast) return;

      setPlacing(null);
      void mutate(() =>
        apiSplitBlock(fragment.blockId, {
          durationMinutes: fragment.durationMinutes,
          date: slot.date,
          startMinutes: rankFor(
            slot.startMinutes,
            slot.startMinutes,
            takenStartsOn(slot.date, [fragment.blockId]),
            timeline,
            fragment.durationMinutes,
          ),
        }),
      ).then(report);
    },
    [dayAt, mutate, placing, report, takenStartsOn, timeline],
  );

  // Stable, so the grid's layout effect is not re-armed by every unrelated render.
  const onSettled = useCallback(() => setSettle(null), []);

  const confirmDelete = useCallback((): void => {
    const target = deleteTarget;
    if (target === null) return;
    setDeleteTarget(null);
    void mutate(() => apiDeleteBlock(target.block.id));
  }, [deleteTarget, mutate]);

  // -------------------------------------------------------------------------
  // Effects
  // -------------------------------------------------------------------------

  // A drop writes a QUEUE RANK, so the row lands where the reflow put it. When that is
  // somewhere else, say so once — the grid's slide shows it, this explains it.
  useEffect(() => {
    if (settle === null || view === null || settle.after === view) return;
    const landed = view.blocks.find((block) => block.id === settle.blockId);
    if (landed === undefined) return;
    if (landed.date !== settle.date || Math.abs(landed.startMinutes - settle.startMinutes) >= 60) {
      toast.info(t('notices.dropSettles'));
    }
  }, [settle, view, t, toast]);

  // Left/right page the week. Paging is a GET, so holding a key down is harmless.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
      if (isTypingTarget(event.target)) return;
      // A dialog, a panel or a pending placement owns the keyboard while it is open.
      if (placing !== null || splitSource !== null || deleteTarget !== null) return;
      if (openJobId !== null || newJobOpen || gapTarget !== null) return;
      event.preventDefault();
      if (event.key === 'ArrowLeft') week.goPrevious();
      else week.goNext();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [week, placing, splitSource, deleteTarget, openJobId, newJobOpen, gapTarget]);

  // Escape abandons a pending placement.
  useEffect(() => {
    if (placing === null) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setPlacing(null);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [placing]);

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  const weekLabel =
    view === null ? '' : format.weekLabel(view.week.isoWeek, view.week.startDate, view.week.endDate);

  const emptyWeek = view !== null && view.blocks.length === 0 && view.gaps.length === 0;

  return (
    <div className="ww-app">
      <WeekHeader
        weekLabel={weekLabel}
        disabled={view === null}
        onPrevious={week.goPrevious}
        onNext={week.goNext}
        onToday={week.goToday}
        onNewJob={renderNewJob === undefined ? undefined : () => setNewJobOpen(true)}
        onNewGap={renderGapForm === undefined ? undefined : () => setGapTarget({ gap: null })}
        settingsHref={settingsHref}
      />

      <main className="ww-app__body">
        <div className={styles.screen}>
          <SummaryStrip summary={view?.summary ?? null} />

          {week.loadError === null ? null : (
            <InlineBanner tone="error" title={t('errors.title')} onRetry={week.reload}>
              {week.loadError}
            </InlineBanner>
          )}

          {week.actionError === null ? null : (
            <InlineBanner tone="error" title={t('errors.title')} onDismiss={week.clearActionError}>
              {week.actionError}
            </InlineBanner>
          )}

          <div className={styles.gridArea} ref={gridArea}>
            {view === null || timeline === null ? (
              <p className={styles.loading}>{week.loadError === null ? t('grid.loadingWeek') : ''}</p>
            ) : (
              <WeekGrid
                view={view}
                timeline={timeline}
                stale={loading}
                busy={busy}
                drag={drag}
                placing={placing}
                onPlace={onPlace}
                onOpenJob={setOpenJobId}
                onOpenGap={renderGapForm === undefined ? undefined : (gap) => setGapTarget({ gap })}
                onToggleLock={onToggleLock}
                onSplit={onSplit}
                onDelete={onDelete}
                metricsRef={metricsRef}
                settle={settle}
                onSettled={onSettled}
              />
            )}
          </div>

          <div className={styles.legend}>
            {drag.preview !== null ? (
              <span className={styles.hint}>{t('grid.dropRankHint')}</span>
            ) : placing !== null ? (
              <span className={styles.hint}>{t('block.splitHint')}</span>
            ) : emptyWeek ? (
              <span>{t('jobForm.hint')}</span>
            ) : (
              <>
                <span>{t('grid.bandsLegend')}</span>
                <span>{t('grid.pastLegend')}</span>
              </>
            )}
          </div>
        </div>
      </main>

      <SplitBlockDialog
        block={splitSource}
        onCancel={() => setSplitSource(null)}
        onConfirm={(durationMinutes) => {
          if (splitSource === null) return;
          setPlacing({
            blockId: splitSource.id,
            projectName: splitSource.project.name,
            color: splitSource.project.color,
            durationMinutes,
          });
          setSplitSource(null);
        }}
      />

      {deleteTarget === null ? null : (
        <ConfirmDialog
          open
          title={t('block.deleteTitle')}
          description={t('block.deleteBody', {
            hours: format.hourNumber(deleteTarget.block.durationMinutes),
            name: deleteTarget.block.project.name,
            total: format.hourNumber(deleteTarget.totalMinutes),
          })}
          confirmLabel={t('block.deleteConfirm')}
          busy={busy}
          onCancel={() => setDeleteTarget(null)}
          onConfirm={confirmDelete}
        />
      )}

      {/* The panels are fed the week's own facts — the shop's today, the strip, the
          shift — so no form has to guess at the browser's clock or re-fetch Settings.
          None of them can be open before the first week has arrived. */}
      {view === null ? null : (
        <>
          {openJobId === null || renderJobPanel === undefined
            ? null
            : renderJobPanel({
                projectId: openJobId,
                close: () => setOpenJobId(null),
                onChanged: week.reload,
                today: view.today,
              })}

          {!newJobOpen || renderNewJob === undefined
            ? null
            : renderNewJob({
                close: () => setNewJobOpen(false),
                onChanged: week.reload,
                today: view.today,
                summary: view.summary,
                suggestedColor: leastUsedColor(view.blocks),
              })}

          {gapTarget === null || renderGapForm === undefined
            ? null
            : renderGapForm({
                gap: gapTarget.gap,
                close: () => setGapTarget(null),
                onChanged: week.reload,
                today: view.today,
                shape: view.shape,
                gapColor: view.settings.gapColor,
                defaultDate: view.week.dates.includes(view.today)
                  ? view.today
                  : view.week.startDate,
              })}
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * Stands in for `view.shape` before the first response, only so the drag hook always
 * has a timeline. Gestures are disabled until the real one arrives, so these numbers
 * never reach the screen — they are the documented defaults (07:00 to 20:30).
 */
const FALLBACK_TIMELINE = createTimeline({
  periods: [
    { startMinutes: 8 * 60, endMinutes: 14 * 60 },
    { startMinutes: 15 * 60 + 30, endMinutes: 19 * 60 + 30 },
  ],
  shiftMinutes: 10 * 60,
  capacityMinutes: 10 * 60,
  marginTopMinutes: 60,
  marginBottomMinutes: 60,
  timelineStartMinutes: 7 * 60,
  timelineEndMinutes: 20 * 60 + 30,
});

/** The sticky day-header row plus the frame's hairlines, which are not timeline. */
const DAY_HEADER_ALLOWANCE = 46;

/**
 * The swatch with the fewest hours on the week, ties broken by the palette's order.
 * Only a suggestion for a new job's colour — the owner still picks from the swatches —
 * but it stops two jobs created back to back from being the same colour, which is the
 * one thing that makes the grid unreadable.
 */
function leastUsedColor(blocks: readonly WeekBlock[]): string {
  const used = new Map<string, number>(PROJECT_COLORS.map((color) => [color, 0]));
  for (const block of blocks) {
    const color = block.project.color.toUpperCase();
    const current = used.get(color);
    if (current !== undefined) used.set(color, current + block.durationMinutes);
  }
  let best = PROJECT_COLORS[0] as string;
  let bestMinutes = Number.POSITIVE_INFINITY;
  for (const [color, minutes] of used) {
    if (minutes < bestMinutes) {
      best = color;
      bestMinutes = minutes;
    }
  }
  return best;
}

/**
 * The height of an element, kept current. Used for exactly one thing: choosing the
 * vertical scale so the whole working day fits the space the window has.
 */
function useElementHeight(ref: React.MutableRefObject<HTMLElement | null>): number | null {
  const [height, setHeight] = useState<number | null>(null);

  useEffect(() => {
    const element = ref.current;
    if (element === null) return;
    const observer = new ResizeObserver((entries) => {
      const next = entries[0]?.contentRect.height;
      // Rounded: a sub-pixel jitter must not rebuild the timeline on every frame.
      if (next !== undefined) setHeight(Math.round(next));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);

  return height;
}

/** True when the keyboard belongs to a form control rather than to the calendar. */
function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  return ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
}
