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
  isApiError,
  moveBlock as apiMoveBlock,
  releaseBlockDuration as apiReleaseBlockDuration,
  resizeBlock as apiResizeBlock,
  setBlockLock as apiSetBlockLock,
  splitBlock as apiSplitBlock,
  type BlockMutation,
  type FreedHoursChoice,
  type ScheduleSummary,
  type WeekBlock,
  type WeekDay,
  type WeekView,
} from '../../lib/api-client';
import type { DayShape, Gap } from '../../types';
import type { CloseDayRequest } from '../../lib/closeDay';
import { PROJECT_COLORS } from '../../lib/projectColors';
import { manualWindowsOf } from '../../lib/manualWindow';
import { clampDropStart, rankFor, createTimeline, type GridMetrics, type Timeline } from './geometry';
import { dropPins } from './dropEffect';
import { describeDrop, type DropOutcomeKind } from './dropOutcome';
import { SummaryStrip } from './SummaryStrip';
import { WeekHeader } from './WeekHeader';
import { WeekGrid, type PlacingFragment, type SettleRequest } from './WeekGrid';
import { MIN_SPLITTABLE_MINUTES, SplitBlockDialog } from './SplitBlockDialog';
import { ResizeChoiceDialog } from './ResizeChoiceDialog';
import { useBlockDrag, type DragTarget, type InertReason } from './useBlockDrag';
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
  /** `settings.planningHorizonWeeks` — how far ahead the panels' day picker reaches. */
  horizonWeeks: number;
}

export interface NewJobContext {
  close: () => void;
  onChanged: () => void;
  today: string;
  /** Where the queue currently ends, which is where a new job will start. */
  summary: ScheduleSummary;
  /** The swatch the calendar shows least of, so two new jobs are not the same colour. */
  suggestedColor: string;
  /**
   * `settings.planningHorizonWeeks` — how far ahead the optional start-date picker
   * reaches. The form's date is a floor, not a deadline; see `NewJobPanel`.
   */
  horizonWeeks: number;
}

export interface GapFormContext {
  /** The gap being edited, or `null` for a new one. */
  gap: Gap | null;
  /**
   * Set when the owner asked to stop a day early from a block's action bar: the gap is
   * already worked out (from that moment to the end of the day) and the form only has to
   * ask for the reason. `null` for the ordinary `Nuevo hueco` form.
   */
  closeDay: CloseDayRequest | null;
  close: () => void;
  onChanged: () => void;
  today: string;
  /** Gives a new gap its default start time and its duration ceiling. */
  shape: DayShape;
  /** `settings.gapColor` — the one colour every gap is painted in. */
  gapColor: string;
  /** A new gap lands on a day the owner can see: today, or this week's Monday. */
  defaultDate: string;
  /** `settings.planningHorizonWeeks` — how far ahead the day picker reaches. */
  horizonWeeks: number;
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
  const [gapTarget, setGapTarget] = useState<{ gap: Gap | null; closeDay?: CloseDayRequest } | null>(
    null,
  );
  const [splitSource, setSplitSource] = useState<WeekBlock | null>(null);
  const [placing, setPlacing] = useState<PlacingFragment | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{ block: WeekBlock; totalMinutes: number } | null>(null);
  const [settle, setSettle] = useState<SettleRequest | null>(null);
  /**
   * A shrink the server is holding open: it wrote nothing and asked what should happen to
   * the freed hours. The whole gesture is kept, not just the ids, because the answer
   * re-sends it verbatim and the toast afterwards needs the length the row started at.
   */
  const [resizeChoice, setResizeChoice] = useState<{
    target: DragTarget;
    durationMinutes: number;
    freedMinutes: number;
    choices: FreedHoursChoice[];
  } | null>(null);

  // The axis: from Settings, widened to cover anything already on the calendar (a block
  // hand-dropped into a margin, or left over from a longer working day, must be visible
  // rather than clipped), and scaled so the whole day fits the space there is.
  const fittedTimeline = useMemo(() => {
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

  /**
   * The week's days in calendar order — what a release below the end of a day needs, since
   * the answer to it is another column (`resolveDropDay`).
   */
  const days = useCallback((): readonly WeekDay[] => viewRef.current?.days ?? [], []);

  /** The rows on a date, so the aim can be quantised against the one it is over. */
  const rowsOn = useCallback(
    (date: string, exclude: readonly string[]): readonly WeekBlock[] =>
      (viewRef.current?.blocks ?? []).filter(
        (block) => block.date === date && !exclude.includes(block.id),
      ),
    [],
  );

  /** Starts already taken on a date, so a drop rank never ties with an older row. */
  const takenStartsOn = useCallback(
    (date: string, exclude: readonly string[]): number[] =>
      rowsOn(date, exclude).map((block) => block.startMinutes),
    [rowsOn],
  );

  /**
   * The honest consequences of a gesture, none of which the grid can show by itself.
   *
   * All three are things the server did that the owner did not ask for in so many words:
   * a locked row adjusted (never silent, CLAUDE.md), an overlapping drop folded into one
   * row of the same job (the hours were summed, so nothing was lost but an id is gone),
   * and another job cut so the drop could have the slot — "if the user does not want it,
   * they move it again" only works if they are told it happened.
   */
  const report = useCallback(
    (result: BlockMutation | undefined): void => {
      if (result === undefined) return;

      const touched = result.touchedLockedBlockIds.length;
      if (touched > 0) toast.warning(t('notices.touchedLockedBlocks', { count: touched }));

      const merged = result.mergedBlockIds.length;
      if (merged > 0) toast.info(t('notices.mergedOverlap', { count: merged }));

      if (result.displacedProjectIds.length > 0) {
        const names = jobNames(result.displacedProjectIds, viewRef.current);
        // A name that cannot be resolved would leave the sentence naming nothing, and the
        // calendar behind the toast already shows the move. Say it only when it can name.
        if (names.length > 0) {
          toast.info(
            t('notices.displacedBlocks', { count: names.length, names: names.join(', ') }),
          );
        }
      }
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
   * ONE REQUEST FOR THE UNIT, so it is one transaction. It used to be one PATCH per row
   * with a full reflow in between, and that is not a smaller version of the same thing: the
   * reflow re-laid the job's remaining hours onto DIFFERENT ids between the two calls, so
   * the second call moved whatever row now carried the id the drag had captured. Dragging a
   * 3 h unit onto Saturday moved 2 h and left an hour on Thursday, and the toast said no
   * hour had been lost — true, and not what the gesture had promised. The same race raised
   * «Ese bloque ya no existe» on drops that had in fact succeeded.
   *
   * A DROP ALWAYS ANSWERS FOR ITSELF. That is this app's oldest sharp edge: a drop
   * writes a queue RANK, so the row lands where the reflow puts it — which may be the
   * same place it started, another week, or nowhere at all if a row of its own job
   * absorbed it — and every one of those is indistinguishable on screen from a drag the
   * app ignored. Friday was the case that shipped (200, nothing moved, no message). So
   * `describeDrop` reads what the server actually stored and the outcome is stated,
   * unless the calendar itself is already the answer. A REFUSAL is not one of these:
   * nothing was written, the request threw, and the banner carries the server's reason.
   */
  const onMove = useCallback(
    (target: DragTarget, drop: { date: string; startMinutes: number }): void => {
      /*
       * THE WEEK THE BLOCK WAS RELEASED IN IS THE WEEK LEFT ON SCREEN.
       *
       * Everything about the drop is already resolved against it — the columns, the day,
       * the rows it was aimed at — because all of that is read at the moment of the
       * release. The one thing that is not is which week the NEXT fetch will ask for, and
       * edge paging opens a window where the two disagree: the hold fires, the reference
       * moves on, and the block is released before the new week has arrived. The refetch
       * that every mutation ends with would then land the owner on a week the block they
       * just dropped is not in. A no-op in every other case.
       */
      week.showWeekOf(drop.date);

      setSettle({
        blockId: target.blockIds[0],
        date: drop.date,
        startMinutes: drop.startMinutes,
        after: viewRef.current,
      });

      void mutate(() =>
        apiMoveBlock(target.blockIds[0], {
          date: drop.date,
          startMinutes: drop.startMinutes,
          // The whole unit, named: the server folds the rows into the one it is given and
          // stores the result in segments, so what lands is what the ghost drew.
          unitBlockIds: target.blockIds,
        }),
      ).then((result) => {
        report(result);
        if (result === undefined) return;

        // The row the pointer released, as the LAST transaction left it. Read from the
        // mutation rather than from the refetched week, so the sentence cannot race the
        // reload — and `null` (the id is gone) is itself one of the answers.
        const landed = result.blocks.find((row) => row.id === target.blockIds[0]);
        const outcome = describeDrop({
          from: { date: target.date, startMinutes: target.startMinutes },
          to: drop,
          landed:
            landed === undefined
              ? null
              : {
                  date: landed.date,
                  startMinutes: landed.startMinutes,
                  locked: landed.locked,
                },
          merged: result.mergedBlockIds.length > 0,
          // The unit as it was BEFORE the drag: a padlock it already had is not what the
          // drop just did to it.
          wasLocked: target.locked,
          visibleDates: viewRef.current?.week.dates ?? [],
        });
        if (outcome === null) return;

        toast.info(
          t(DROP_OUTCOME_KEYS[outcome.kind], {
            name: target.name,
            day: format.dayHeader(outcome.date),
            date: format.longDate(outcome.date),
            // Only `movedWeek` reads it, and it is the whole point of that sentence: the
            // screen changed while the owner was looking at the block, so the answer has
            // to name the week they are now in as well as the day the row is on.
            week:
              viewRef.current === null
                ? ''
                : format.weekRange(viewRef.current.week.startDate, viewRef.current.week.endDate),
          }),
        );
      });
    },
    [format, mutate, report, t, toast, week],
  );

  /**
   * A drag released where nothing can be written — today only the frozen past, which
   * `DragPreview.allowed` marks and the ghost draws in red.
   *
   * Said out loud rather than left to the ghost disappearing. "The engine never writes
   * to a date earlier than today" is a rule about the ENGINE, and the owner can still
   * edit that day by hand from the job panel, so the refusal has a next step and is
   * worth a sentence.
   */
  const onRejected = useCallback((): void => {
    toast.warning(t('notices.dropRefusedPast'));
  }, [t, toast]);

  /**
   * A press that could not become a gesture, saying why.
   *
   * All three used to be a press that did nothing at all, which the owner reads as the app
   * ignoring them — and one of them, `busy`, lands in the second right after a drop, when
   * the next press is most likely. See `InertReason`.
   */
  const onInert = useCallback(
    (reason: InertReason): void => {
      toast.info(t(INERT_KEYS[reason]));
    },
    [t, toast],
  );


  /**
   * The bottom edge. Two things the grid cannot show by itself, so both are said here:
   *
   * - THE CONSEQUENCE IS NOT LOCAL. A resize is a transfer inside the job, so the hours
   *   move to (or come off) the job's LAST block, the job's run ends at the resized row,
   *   its remainder starts on the next auto-fill day, and the jobs behind it take the
   *   hours the day just gained. None of that is visible in the row the owner dragged,
   *   and some of it is not even in the week on screen.
   * - THE ROW IS NOW HAND-SET, which is a state with an undo (*back to automatic*), so
   *   each sentence ends by saying the length is now fixed. The mark on the row and its
   *   tooltip carry that afterwards; this is what says it the moment it becomes true.
   *
   * SHRINKING MAY ASK INSTEAD OF SUCCEEDING (409 `shrink-needs-choice`). That is not a
   * failure and it must not reach the banner: nothing was written, the server is holding
   * the gesture open, and `details` carries the hours and exactly the answers that exist.
   * It is caught here, turned into `ResizeChoiceDialog`, and re-sent verbatim with the
   * owner's `freedHours`. Everything else is rethrown and reaches the banner as usual.
   */
  const onResize = useCallback(
    (target: DragTarget, durationMinutes: number, freedHours?: FreedHoursChoice): void => {
      void mutate(async () => {
        try {
          return await apiResizeBlock(target.blockId, durationMinutes, { freedHours });
        } catch (error) {
          if (isApiError(error) && error.code === 'shrink-needs-choice') {
            setResizeChoice({
              target,
              durationMinutes,
              freedMinutes: Number(error.details.freedMinutes ?? 0),
              choices: (error.details.choices as FreedHoursChoice[] | undefined) ?? [],
            });
            return undefined;
          }
          throw error;
        }
      }).then((result) => {
        report(result);
        if (result === undefined) return;
        setResizeChoice(null);
        /*
         * BOTH THE DIRECTION AND THE HOURS COME FROM THE GESTURE, and they have to: what
         * the owner drew is a STRETCH in net working minutes, and a stretch that crosses
         * the lunch break is stored as two rows — so the row named in the request holds
         * only its first segment, and reading the hours back off it would answer "4 h" to
         * a 6 h drag. The drag layer caps the number at the day's own manual window
         * (`durationTo`), so it is always time that really exists on that day.
         *
         * Only two branches, because the drag never sends a resize to the length the row
         * already had — the engine accepts one (it makes the gesture total from the
         * API's side) but from a mouse it is a drag that went nowhere.
         */
        toast.info(
          t(durationMinutes < target.durationMinutes ? 'notices.resizeShrunk' : 'notices.resizeGrown', {
            name: target.name,
            hours: format.hourNumber(durationMinutes),
          }),
        );
      });
    },
    [format, mutate, report, t, toast],
  );

  /**
   * "Back to automatic". One call per hand-set row of the unit, because a stretch cut at
   * the lunch break is two marked rows and releasing half of it would leave the other
   * half still closing the day.
   *
   * It gives back the LENGTH, not the queue position — the row keeps whatever place the
   * calendar now gives it, exactly as after any drag — so the notice says so.
   */
  const onReleaseDuration = useCallback(
    (blockIds: readonly string[]): void => {
      if (blockIds.length === 0) return;
      void mutate(async () => {
        const results: BlockMutation[] = [];
        for (const blockId of blockIds) results.push(await apiReleaseBlockDuration(blockId));
        return mergeMutations(results);
      }).then((result) => {
        report(result);
        if (result !== undefined) toast.info(t('notices.released'));
      });
    },
    [mutate, report, t, toast],
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
    // real timeline has arrived anyway. Read once per gesture, at press.
    timeline: fittedTimeline ?? FALLBACK_TIMELINE,
    dayAt,
    days,
    rowsOn,
    takenStartsOn,
    // WIRED, not WRITABLE. `busy` and `loading` used to be in here, which made every press
    // in the second after a drop do nothing whatsoever; they are now an `inert` press the
    // grid tags per row, so a click still opens the job and a drag says why it will not
    // move. See `BeginOptions.inert`.
    enabled: fittedTimeline !== null && placing === null,
    // Read at press, in the same tick: `busy` is state and arrives a render late, and that
    // frame is exactly where a fast second press lands.
    writable: () => !week.mutating.current && !loading,
    // The only fact about the week the drag layer needs REACTIVELY: when the columns are
    // replaced under a hand that is holding still at an edge, the ghost has to move with
    // them. `''` until the first week arrives, when gestures are disabled anyway.
    weekKey: view?.week.startDate ?? '',
    // Holding a block at either edge of the grid pages the calendar. It is a GET, so
    // nothing in flight can be disturbed by it.
    onPageWeek: (side) => (side === 'previous' ? week.goPrevious() : week.goNext()),
    onMove,
    onResize,
    onRejected,
    onInert,
    onClick: (target) => setOpenJobId(target.projectId),
  });

  /**
   * The axis the grid PAINTS — held still for as long as a block is in the air.
   *
   * `useBlockDrag` already fixes the axis it MEASURES against at press, so a re-fit
   * mid-gesture can no longer change what a release means. This is the other half of the
   * same promise, and it is about what the owner sees: a re-fit repaints every block,
   * every rule and every ghost at a new scale while their hand is still down. That was
   * visible on essentially every drag — the drag hint under the grid is one line where
   * the resting legend is two, `.gridArea` absorbed the difference, and the whole week
   * jumped by about 1% roughly 50 ms in and jumped back on release. The legend now
   * reserves its box so the loop is gone at the source; holding the painted axis is what
   * makes ANY late re-fit (a window resize, a banner, a refetch that widens `cover`)
   * simply wait until the hand is off the mouse.
   *
   * Written during render rather than in an effect because the paint must not lag the
   * gesture by a frame; the write is idempotent and only ever caches the current value.
   */
  const heldTimeline = useRef<Timeline | null>(fittedTimeline);
  if (drag.kind === null) heldTimeline.current = fittedTimeline;
  const timeline = drag.kind === null ? fittedTimeline : heldTimeline.current;

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
      if (day === undefined) return;
      // The engine never writes to the past, and neither does a placement. Said out loud,
      // and the fragment STAYS ARMED: this used to be a bare `return`, so the one click the
      // owner is being asked for did nothing, said nothing, and left the grid still waiting
      // for it — the same silence as a swallowed drop, in the middle of a two-step gesture.
      if (day.isPast) {
        toast.warning(t('notices.dropRefusedPast'));
        return;
      }

      setPlacing(null);
      void mutate(() =>
        apiSplitBlock(fragment.blockId, {
          durationMinutes: fragment.durationMinutes,
          date: slot.date,
          // Clamped over the DAY, like a drop: the scissors' second click is the one
          // placement that went through `rankFor` with no cap at all, so a fragment could be
          // stored at 19:45-20:45, or 19:30-23:00 — past the end of the day (invariant 3).
          startMinutes: rankFor(
            slot.startMinutes,
            takenStartsOn(slot.date, [fragment.blockId]),
            (minutes) =>
              clampDropStart(day.manualWindows, minutes, fragment.durationMinutes, timeline),
            // The fragment is a drop like any other, so it pins on the same days and in the
            // same bands — and where it pins the minute is stored, so it must not be nudged.
            dropPins({
              locked: false,
              role: day.role,
              periods: day.periods,
              manualWindows: day.manualWindows,
              startMinutes: slot.startMinutes,
              durationMinutes: fragment.durationMinutes,
            }),
          ),
        }),
      ).then((result) => {
        report(result);
        if (result === undefined) return;
        // The fragment IS a drop, so it follows the same rule a move does: the buffer
        // and the weekend PIN it. Its id is minted by the server and is not in the
        // response, so the day's own rule is what the notice is read from — which is
        // exactly what `pinsToTheDay` decides on the other side.
        if (day.role !== 'auto') {
          toast.info(
            t('notices.dropPinned', {
              name: fragment.projectName,
              day: format.dayHeader(slot.date),
              date: format.longDate(slot.date),
            }),
          );
        }
      });
    },
    [dayAt, format, mutate, placing, report, t, takenStartsOn, timeline, toast],
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

  // Left/right page the week. Paging is a GET, so holding a key down is harmless.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
      if (isTypingTarget(event.target)) return;
      // A dialog, a panel or a pending placement owns the keyboard while it is open.
      if (placing !== null || splitSource !== null || deleteTarget !== null) return;
      if (openJobId !== null || newJobOpen || gapTarget !== null) return;
      // A GESTURE IN THE AIR OWNS IT TOO. A move handles the arrows itself, in the capture
      // phase, so it can page and re-resolve its own ghost in one step and this listener
      // never sees the key; a RESIZE has no use for another week at all — its edge belongs
      // to one row on one day — so for it the arrows simply do nothing.
      if (drag.kind !== null) return;
      event.preventDefault();
      if (event.key === 'ArrowLeft') week.goPrevious();
      else week.goNext();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [week, placing, splitSource, deleteTarget, openJobId, newJobOpen, gapTarget, drag.kind]);

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

  /**
   * The sentence under the grid while a gesture is in the air, and there are three of them
   * because a drag means three different things.
   *
   * The move used to always say "it takes this place in the queue and settles behind the
   * one before it" — which is exactly wrong over the weekend and over the colchón, where a
   * drop keeps the minute it was released on and the owner is in charge. Reading the rule
   * off the day the pointer is over is what makes the hint worth reading at all, and it is
   * the same predicate the ghost switches on.
   */
  const dragHintKey =
    drag.preview === null
      ? 'grid.dropRankHint'
      : drag.preview.kind === 'resize'
        ? 'block.resizeHint'
        : // The gesture's own answer, which covers the SLOT as well as the day: a drop into
          // a margin or the lunch band pins on Monday too. See `DragPreview.pinned`.
          drag.preview.pinned === true
          ? 'grid.dropPinHint'
          : 'grid.dropRankHint';

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
          <SummaryStrip summary={view?.summary ?? null} shape={view?.shape ?? null} />

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
                onCloseDay={
                  renderGapForm === undefined
                    ? undefined
                    : // A gap IS how a day stops early, so the action opens the gap form
                      // with everything but the reason already filled in.
                      (closeDay) => setGapTarget({ gap: null, closeDay })
                }
                onToggleLock={onToggleLock}
                onReleaseDuration={onReleaseDuration}
                onSplit={onSplit}
                onDelete={onDelete}
                // The same sentence a press on a block gets, for the one thing on the grid
                // that is not one: every press either starts something or says why not.
                onPressHint={onInert}
                metricsRef={metricsRef}
                settle={settle}
                onSettled={onSettled}
              />
            )}
          </div>

          <div className={styles.legend}>
            {/* The two drags say different things, and the resize now happens on rows
                where it never used to be offered — so it needs its own line rather than
                the drop's. A MOVE says two different things too: see `dragHintKey`. */}
            {drag.preview !== null ? (
              <span className={styles.hint}>{t(dragHintKey)}</span>
            ) : placing !== null ? (
              // NOT `block.splitHint` here, which is what the DIALOG says: by this point the
              // owner has agreed to the split and the grid has taken the pointer, so the one
              // thing worth saying is what to do with it — and how to get out, which nothing
              // on screen used to mention.
              <span className={styles.hint}>{t('grid.placingHint')}</span>
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

      <ResizeChoiceDialog
        request={
          resizeChoice === null
            ? null
            : {
                name: resizeChoice.target.name,
                freedMinutes: resizeChoice.freedMinutes,
                choices: resizeChoice.choices,
              }
        }
        busy={busy}
        // Cancelling is simply not asking again: the 409 wrote nothing, so the row is
        // already at the length it had before the drag.
        onCancel={() => setResizeChoice(null)}
        onChoose={(choice) => {
          if (resizeChoice === null) return;
          onResize(resizeChoice.target, resizeChoice.durationMinutes, choice);
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
                horizonWeeks: view.settings.planningHorizonWeeks,
              })}

          {!newJobOpen || renderNewJob === undefined
            ? null
            : renderNewJob({
                close: () => setNewJobOpen(false),
                onChanged: week.reload,
                today: view.today,
                summary: view.summary,
                suggestedColor: leastUsedColor(view.blocks),
                horizonWeeks: view.settings.planningHorizonWeeks,
              })}

          {gapTarget === null || renderGapForm === undefined
            ? null
            : renderGapForm({
                gap: gapTarget.gap,
                closeDay: gapTarget.closeDay ?? null,
                close: () => setGapTarget(null),
                onChanged: week.reload,
                today: view.today,
                shape: view.shape,
                gapColor: view.settings.gapColor,
                defaultDate: view.week.dates.includes(view.today)
                  ? view.today
                  : view.week.startDate,
                horizonWeeks: view.settings.planningHorizonWeeks,
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
const FALLBACK_PERIODS = [
  { startMinutes: 8 * 60, endMinutes: 14 * 60 },
  { startMinutes: 15 * 60 + 30, endMinutes: 19 * 60 + 30 },
];

const FALLBACK_TIMELINE = createTimeline({
  periods: FALLBACK_PERIODS,
  manualWindows: manualWindowsOf(FALLBACK_PERIODS, 60, 60),
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
 * Several one-row transactions, reported as the one gesture the owner made.
 *
 * A unit is moved (and released) a row at a time — each its own transaction, so the
 * calendar is never half-written — but its consequences belong to the whole gesture.
 * The entity fields come from the LAST call, which saw the final calendar; the three
 * consequence lists are unioned, since each is a set of ids and any of the calls may
 * have contributed to it.
 */
function mergeMutations(results: readonly BlockMutation[]): BlockMutation | undefined {
  const last = results[results.length - 1];
  if (last === undefined) return undefined;

  const union = (pick: (result: BlockMutation) => readonly string[]): string[] => {
    const ids: string[] = [];
    for (const result of results) {
      for (const id of pick(result)) if (!ids.includes(id)) ids.push(id);
    }
    return ids;
  };

  return {
    ...last,
    touchedLockedBlockIds: union((result) => result.touchedLockedBlockIds),
    mergedBlockIds: union((result) => result.mergedBlockIds),
    displacedProjectIds: union((result) => result.displacedProjectIds),
  };
}

/**
 * What a press that cannot write says. One key per `InertReason`, each naming the reason
 * AND what the owner can still do — a message with no next step is only half delivered.
 */
const INERT_KEYS: Record<InertReason, string> = {
  busy: 'notices.pressWhileBusy',
  past: 'notices.pressOnPastDay',
  gap: 'notices.pressOnGap',
};

/**
 * What the toast says about each way a drop can end. One key per branch of
 * `describeDrop`, which is where the branches themselves are decided and tested.
 */
const DROP_OUTCOME_KEYS: Record<DropOutcomeKind, string> = {
  pinned: 'notices.dropPinned',
  settled: 'notices.dropSettles',
  leftWeek: 'notices.dropLeftWeek',
  pulledBack: 'notices.dropPulledBack',
  movedWeek: 'notices.dropMovedWeek',
  unchanged: 'notices.dropUnchanged',
  absorbed: 'notices.dropAbsorbed',
};

/** The names behind a list of job ids, from the week on screen, without repeats. */
function jobNames(projectIds: readonly string[], view: WeekView | null): string[] {
  const names: string[] = [];
  for (const projectId of projectIds) {
    const name = view?.blocks.find((block) => block.projectId === projectId)?.project.name;
    if (name !== undefined && name !== '' && !names.includes(name)) names.push(name);
  }
  return names;
}

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
