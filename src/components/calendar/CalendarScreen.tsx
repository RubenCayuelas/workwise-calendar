'use client';

/**
 * The week view — the app's main screen, and the only place block gestures turn into API
 * calls. `useWeek` refetches after every mutation, because a recomposition can rewrite rows in
 * weeks this screen is not showing. The job panel, job form and gap form arrive as render
 * props, so a control whose form is not wired is disabled rather than dead.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { IconClockStop } from '@tabler/icons-react';
import { Button, ConfirmDialog, InlineBanner, useToast } from '../ui';
import { useFormat } from '../../lib/useFormat';
import {
  deleteBlock as apiDeleteBlock,
  getProject,
  isApiError,
  moveBlock as apiMoveBlock,
  moveGap as apiMoveGap,
  resizeBlock as apiResizeBlock,
  resizeGap as apiResizeGap,
  setBlockLock as apiSetBlockLock,
  splitBlock as apiSplitBlock,
  type AbsenceKind,
  type BlockMutation,
  type FreedHoursChoice,
  type ScheduleSummary,
  type WeekBlock,
  type WeekDay,
  type WeekView,
} from '../../lib/api-client';
import type { DayShape, GapUnit } from '../../types';
import type { AbsenceOrigin } from '../jobs/absence';
import type { CloseDayRequest } from '../../lib/closeDay';
import { PROJECT_COLORS } from '../../lib/projectColors';
import { clockEndOf, manualWindowsOf } from '../../lib/manualWindow';
import { spillByDay } from '../../lib/dropSpill';
import { closeDayAfter, closeDayInputFor } from './closeDayOffer';
import { rankFor, createTimeline, type GridMetrics, type Timeline } from './geometry';
import { dropPins } from './dropEffect';
import { describeDrop, type DropOutcomeKind } from './dropOutcome';
import { SummaryStrip } from './SummaryStrip';
import { WeekHeader } from './WeekHeader';
import { WeekGrid, type PlacingFragment, type SettleRequest } from './WeekGrid';
import { MIN_SPLITTABLE_MINUTES, SplitBlockDialog } from './SplitBlockDialog';
import { ResizeChoiceDialog } from './ResizeChoiceDialog';
import {
  useBlockDrag,
  type BlockDragTarget,
  type DragTarget,
  type GapDragTarget,
  type InertReason,
} from './useBlockDrag';
import { usePaintAbsence } from './usePaintAbsence';
import { PaintChooser } from './PaintChooser';
import type { PaintPoint, PaintedSpan } from './paintSession';
import { planDraftRows, type DraftRow, type GridDraft } from './draftBand';
import { useWeek } from './useWeek';
import styles from './CalendarScreen.module.css';

/** One array, so a render with no band held never invalidates the grid's memos. */
const EMPTY_DRAFT: readonly DraftRow[] = [];

// --- The seams to the screens that are not the grid ---

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
  /** `settings.planningHorizonWeeks` — how far the optional start-date picker reaches. */
  horizonWeeks: number;
  /**
   * Set when a painted BAND is what opened the form: the day and the minute the hours start on. The
   * form's hours field still decides the LENGTH.
   */
  painted?: { date: string; startMinutes: number };
  /** The band's own hours, pre-filled and editable. */
  defaultHours?: number;
  /**
   * Only when a painted band opened this form: report the day, start and hours on every change so
   * the grid can keep the band drawn on them. `null` when there is nothing to draw.
   */
  onDraft?: (draft: GridDraft | null) => void;
  /** The days on screen, so a form can tell when its own date has left them. */
  visibleDates?: readonly string[];
  /** Page the calendar to the week holding that day. Nothing is written: it is a GET. */
  onShowWeekOf?: (date: string) => void;
}

export interface AbsenceFormContext {
  /**
   * The ABSENCE being edited, or `null` for a new one. The UNIT and never one of its rows: a PATCH
   * addresses the whole gap, so a form fed the `08:00 +6 h` half of a 10 h absence would save it as
   * a 6 h one.
   */
  gap: GapUnit | null;
  /** *Cerrar el día aquí*: the gap is worked out and only the reason is left to ask for. */
  closeDay: CloseDayRequest | null;
  /** Which mode a NEW absence opens in: `closed-days` when the owner pressed a closed column. */
  kind: AbsenceKind;
  /** Which gesture opened it. Decides the RANGE screen versus one absence, never the contents. */
  origin: AbsenceOrigin;
  close: () => void;
  onChanged: () => void;
  today: string;
  /** Gives a new gap its default start time and its duration ceiling. */
  shape: DayShape;
  /** `settings.gapColor` — the one colour every gap is painted in. */
  gapColor: string;
  /** A new absence lands on a day the owner can see: today, or this week's Monday. */
  defaultDate: string;
  /** The words that day already carries: a closed day's note, so saving cannot blank it. */
  defaultReason?: string;
  /** Set by a PAINTED band: the day, start and net duration it drew. Nothing was written. */
  defaultStartMinutes?: number;
  defaultDurationMinutes?: number;
  /** `settings.planningHorizonWeeks` — how far ahead the day picker reaches. */
  horizonWeeks: number;
  /** Only for a PAINTED band: keeps it drawn on the grid while this form is open. */
  onDraft?: (draft: GridDraft | null) => void;
  /** The days on screen, so a form can tell when its own date has left them. */
  visibleDates?: readonly string[];
  /** Page the calendar to the week holding that day. Nothing is written: it is a GET. */
  onShowWeekOf?: (date: string) => void;
}

export interface CalendarScreenProps {
  /** Clicking a block opens this. Without it, a block click does nothing. */
  renderJobPanel?: (context: JobPanelContext) => ReactNode;
  /** `+ Nuevo job`. Without it, the button is disabled. */
  renderNewJob?: (context: NewJobContext) => ReactNode;
  /** `Absences`, clicking a gap, and the paint gesture. Without it, gaps are read-only labels. */
  renderAbsenceForm?: (context: AbsenceFormContext) => ReactNode;
  settingsHref?: string;
}

export function CalendarScreen({
  renderJobPanel,
  renderNewJob,
  renderAbsenceForm,
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
  const [gapTarget, setGapTarget] = useState<{
    gap: GapUnit | null;
    closeDay?: CloseDayRequest;
    /** Which gesture opened it: the RANGE screen is only for the two that name no day. */
    origin: AbsenceOrigin;
    /** Which mode a NEW absence opens in. */
    kind?: AbsenceKind;
    /** The day a NEW absence opens on: a painted band's, or a closed column that was pressed. */
    date?: string;
    /** The hours a paint drew. Nothing is written until the owner presses Guardar. */
    painted?: { startMinutes: number; durationMinutes: number };
  } | null>(null);
  /**
   * A band the pointer has let go of, still drawn, waiting to be told what it is. Nothing has been
   * written and nothing will be by either answer — each one opens a form.
   */
  const [release, setRelease] = useState<{ span: PaintedSpan; at: PaintPoint } | null>(null);
  /** A painted band on its way to the JOB form: its day and its minute. */
  const [paintedJob, setPaintedJob] = useState<{
    date: string;
    startMinutes: number;
    durationMinutes: number;
  } | null>(null);
  /**
   * The band a PAINTED form is still holding, following its fields. It writes nothing and knows
   * nothing about what is underneath it: only the form it came from can say what it is now, so the
   * form pushes it up here on every change and clears it on close.
   */
  const [draft, setDraft] = useState<GridDraft | null>(null);
  const [splitSource, setSplitSource] = useState<WeekBlock | null>(null);
  const [placing, setPlacing] = useState<PlacingFragment | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{ block: WeekBlock; totalMinutes: number } | null>(null);
  const [settle, setSettle] = useState<SettleRequest | null>(null);
  /**
   * A shrink the server is holding open: it wrote nothing and asked what should happen to the
   * freed hours. The whole gesture is kept, because the answer re-sends it verbatim.
   */
  const [resizeChoice, setResizeChoice] = useState<{
    target: BlockDragTarget;
    durationMinutes: number;
    /** Which dead end asked: it decides the dialog's sentence. */
    direction: 'grow' | 'shrink';
    freedMinutes: number;
    choices: FreedHoursChoice[];
  } | null>(null);

  // From Settings, widened to cover anything already on the calendar, and scaled to the space.
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

  /** The week's days in calendar order — what `resolveDropDay` needs, its answer being a column. */
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
   * The honest consequences of a gesture, none of which the grid shows by itself: a locked row
   * adjusted, an overlapping drop merged, another job cut so the drop could have the slot.
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
        // A name that cannot be resolved would leave the sentence naming nothing.
        if (names.length > 0) {
          toast.info(
            t('notices.displacedBlocks', { count: names.length, names: names.join(', ') }),
          );
        }
      }
    },
    [t, toast],
  );

  // --- Gestures ---

  /**
   * A block's drop, in ONE request and so one transaction: the whole grouped unit moves, because the
   * engine merges consecutive rows of one job into a single queue item. And it ANSWERS FOR
   * ITSELF — a rank lands where the reflow puts it, which on screen looks like a
   * drag the app ignored, so `describeDrop` reads what the server actually stored.
   */
  const onMoveBlock = useCallback(
    (target: BlockDragTarget, drop: { date: string; startMinutes: number }): void => {
      /*
       * The week the block was released in is the week left on screen. Everything else about the
       * drop is read at the release; the week the NEXT fetch asks for is not, and edge paging
       * opens a window where the two disagree. A no-op in every other case.
       */
      week.showWeekOf(drop.date);

      setSettle({
        blockId: target.rowIds[0],
        date: drop.date,
        startMinutes: drop.startMinutes,
        after: viewRef.current,
      });

      void mutate(() =>
        apiMoveBlock(target.rowIds[0], {
          date: drop.date,
          startMinutes: drop.startMinutes,
          // The whole unit, named: the server folds the rows into the one it is given.
          unitBlockIds: target.rowIds,
        }),
      ).then((result) => {
        report(result);
        if (result === undefined) return;

        // The row the pointer released, as the LAST transaction left it — read from the
        // mutation, not the refetched week. `null`, the id being gone, is itself an answer.
        const landed = result.blocks.find((row) => row.id === target.rowIds[0]);
        // Every row the gesture's hours ended up on: `placedBlockIds` is routinely more than
        // one now that work fills a day and overflows, and `landed` is only the FIRST of them.
        const placed = spillByDay(
          result.placedBlockIds
            .map((id) => result.blocks.find((row) => row.id === id))
            .filter((row): row is (typeof result.blocks)[number] => row !== undefined),
        );
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
          // The unit as it was BEFORE the drag: a padlock it already had is not the drop's doing,
          // and for a block being fixed by itself is exactly carrying one.
          wasLocked: target.fixed,
          // The server says it. Comparing rectangles cannot tell a drop the reflow answered with
          // the calendar the owner already had from one that worked.
          changed: result.changed,
          placed,
          visibleDates: viewRef.current?.week.dates ?? [],
        });
        if (outcome === null) return;

        toast.info(
          t(DROP_OUTCOME_KEYS[outcome.kind], {
            name: target.name,
            day: format.dayHeader(outcome.date),
            date: format.longDate(outcome.date),
            // Only `filled` reads it, and it is the whole of that sentence: which day got how
            // much of the job.
            parts: placed
              .map((part) => format.hoursOnDay(part.date, part.minutes))
              .join(t('units.listSeparator')),
            // Only `movedWeek` reads it: the screen changed while the owner was looking at the
            // block, so the answer names the week as well as the day.
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
   * An absence's drop: a LITERAL placement, so there is no rank to settle, nothing to say about
   * where the queue put it and no settle animation to run — the ghost already drew the rows it will
   * be stored as, at the minute it was released. The ONE thing the owner cannot see coming is the
   * start moving: a release with no working time under it is stored at the next minute that has
   * some, so a gap aimed at the lunch break comes back at 15:30 and says so.
   */
  const onMoveGap = useCallback(
    (target: GapDragTarget, drop: { date: string; startMinutes: number }): void => {
      week.showWeekOf(drop.date);
      void mutate(() => apiMoveGap(target.gap.id, drop)).then((result) => {
        if (result === undefined || result.gap.startMinutes === drop.startMinutes) return;
        toast.info(
          t('notices.gapMovedTo', {
            day: format.dayHeader(result.gap.date),
            time: format.time(result.gap.startMinutes),
          }),
        );
      });
    },
    [format, mutate, t, toast, week],
  );

  /** One drop, two kinds of thing: a job's run takes a queue rank, an absence keeps its minute. */
  const onMove = useCallback(
    (target: DragTarget, drop: { date: string; startMinutes: number }): void => {
      if (target.kind === 'gap') onMoveGap(target, drop);
      else onMoveBlock(target, drop);
    },
    [onMoveBlock, onMoveGap],
  );

  /**
   * A drag released where nothing can be written — today only the frozen past. Worth saying, because
   * the way out exists: a job is corrected from its panel and an absence from its own form. Which
   * SENTENCE depends on what was in hand — pointing the owner at the job panel for an absence sends
   * them to a screen that knows nothing about it.
   */
  const onRejected = useCallback(
    (target: DragTarget): void => {
      toast.warning(t(target.kind === 'gap' ? 'notices.dropRefusedPastGap' : 'notices.dropRefusedPast'));
    },
    [t, toast],
  );


  /**
   * A press that could not become a gesture, saying why. `automatic` is the odd one out: not a
   * circumstance that will pass but a RULE about a block's row, so it gets its own way forward —
   * and it cannot arrive for a gap, whose length the server always sizes.
   */
  const onInert = useCallback(
    (reason: InertReason, target: DragTarget): void => {
      // The frozen past names THE WAY OUT, and it is a different form for the two of them: a job's
      // hours are changed in its panel, an absence in its own.
      if (reason === 'past' && target.kind === 'gap') {
        toast.info(t('notices.pressOnPastGap'));
        return;
      }
      toast.info(t(INERT_KEYS[reason]));
    },
    [t, toast],
  );


  /**
   * The bottom edge. The consequence is NOT LOCAL — the hours move to or off the job's last
   * block the engine still lays out, which may not even be on screen — so the toast says so.
   *
   * EITHER DIRECTION MAY ASK RATHER THAN SUCCEED — 409 `shrink-needs-choice` and
   * `grow-needs-choice`. Neither is a failure, so neither may reach the banner: both are caught
   * here, turned into `ResizeChoiceDialog` from the server's own `choices`, and re-sent verbatim.
   * The GROW was missing until 2026-08-21, so a question the server had asked arrived as an error.
   */
  const onResizeBlock = useCallback(
    (target: BlockDragTarget, durationMinutes: number, freedHours?: FreedHoursChoice): void => {
      void mutate(async () => {
        try {
          return await apiResizeBlock(target.blockId, durationMinutes, { freedHours });
        } catch (error) {
          if (
            isApiError(error) &&
            (error.code === 'shrink-needs-choice' || error.code === 'grow-needs-choice')
          ) {
            setResizeChoice({
              target,
              durationMinutes,
              direction: error.code === 'grow-needs-choice' ? 'grow' : 'shrink',
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
        // Both numbers come from the GESTURE: the owner drew a STRETCH in net working minutes,
        // and one crossing the lunch break is stored as two rows — so reading the hours back off
        // the row named in the request would answer "4 h" to a 6 h drag.
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
   * An absence's bottom edge, and the gesture is ABSOLUTE: it just sets the duration. There is no
   * counterparty to hand hours to, so nothing is ever asked and `shrink-needs-choice` cannot reach
   * here. The hours are net working minutes and cross the lunch break, so the far half is created or
   * deleted by the same request — which the ghost drew before the release.
   */
  const onResizeGap = useCallback(
    (target: GapDragTarget, durationMinutes: number): void => {
      void mutate(() => apiResizeGap(target.gap.id, durationMinutes)).then((result) => {
        if (result === undefined) return;
        toast.info(t('notices.gapResized', { hours: format.hourNumber(durationMinutes) }));
      });
    },
    [format, mutate, t, toast],
  );

  /** One edge, two kinds of thing: a transfer inside a job, or an absence's own length. */
  const onResize = useCallback(
    (target: DragTarget, durationMinutes: number): void => {
      if (target.kind === 'gap') onResizeGap(target, durationMinutes);
      else onResizeBlock(target, durationMinutes);
    },
    [onResizeBlock, onResizeGap],
  );

  const onToggleLock = useCallback(
    (block: WeekBlock): void => {
      void mutate(() => apiSetBlockLock(block.id, !block.locked)).then(report);
    },
    [mutate, report],
  );

  const drag = useBlockDrag({
    measure: () => metricsRef.current?.() ?? null,
    // A placeholder keeps the hook's contract simple; gestures are disabled until the real
    // timeline arrives anyway. Read once per gesture, at press.
    timeline: fittedTimeline ?? FALLBACK_TIMELINE,
    dayAt,
    days,
    rowsOn,
    takenStartsOn,
    // WIRED, not WRITABLE: `busy` and `loading` here made every press in the second after a
    // drop do nothing at all. They are an `inert` press the grid tags per row. See `BeginOptions`.
    enabled: fittedTimeline !== null && placing === null,
    // Read at press: `busy` is state and arrives a render late, which is where a press lands.
    writable: () => !week.mutating.current && !loading,
    // The one fact the drag layer needs REACTIVELY: when the columns are replaced under a hand
    // holding still at an edge, the ghost has to move with them.
    weekKey: view?.week.startDate ?? '',
    // Holding a block at either edge pages the calendar. It is a GET, so nothing is disturbed.
    onPageWeek: (side) => (side === 'previous' ? week.goPrevious() : week.goNext()),
    onMove,
    onResize,
    onRejected,
    onInert,
    // A press that did not travel: the job panel, or the absence's own form. It arrives here rather
    // than from a native click so one press cannot answer twice — see the gap's `role="button"`.
    onClick: (target) =>
      target.kind === 'gap' ? setGapTarget({ gap: target.gap, origin: 'gap' }) : setOpenJobId(target.projectId),
  });

  /**
   * Painting a band on empty grid space. IT WRITES NOTHING: the release opens the absences form with
   * the day, the start and the net duration already in it, and the owner presses Guardar — the app
   * never creates a gap by itself. Disabled while a split fragment waits for its target, where a
   * grid click already means "put it here".
   */
  const paint = usePaintAbsence({
    measure: () => metricsRef.current?.() ?? null,
    timeline: fittedTimeline ?? FALLBACK_TIMELINE,
    dayAt,
    // A band already waiting for its answer, or a form already open on one, OWNS the grid: without
    // this a second paint reopened the question and replaced a form the owner had typed into.
    enabled:
      fittedTimeline !== null &&
      placing === null &&
      renderAbsenceForm !== undefined &&
      release === null &&
      paintedJob === null,
    writable: () => !week.mutating.current && !loading,
    // IT WRITES NOTHING. The band stays drawn and the question is asked beside it.
    onPainted: (span, at) => setRelease({ span, at }),
    // A day that can take no absence, said once — and for a CLOSED one the honest answer is the
    // screen that can reopen it, since a dimmed column has nothing else to press.
    onRefused: (reason, date) => {
      if (reason !== 'closed') {
        toast.info(t(reason === 'past' ? 'notices.pressOnPastDay' : 'notices.pressWhileBusy'));
        return;
      }
      setGapTarget({ gap: null, origin: 'closed-column', kind: 'closed-days', date });
    },
    // The only press the grid background has ever had a use for: a closed column, whose reason and
    // whose way back out both live on the absences screen.
    //
    // THE SAME PRECEDENCE THE TRAVELLING PATH USES, and it has to be: a column that is both closed
    // AND past was answered by `isPast` on travel and by `isClosed` on a still press, so four pixels
    // of wobble decided which of two different things the owner was told. The past wins in both, and
    // reopening a past day would change nothing the engine reads anyway.
    onClick: (date) => {
      const day = dayAt(date);
      if (day === undefined || day.isPast || !day.isClosed) return;
      setGapTarget({ gap: null, origin: 'closed-column', kind: 'closed-days', date });
    },
  });

  /**
   * The axis the grid PAINTS, held still while a block is in the air — the other half of *One
   * Axis Per Gesture*, so any late re-fit waits until the hand is off the mouse. Written during
   * render rather than in an effect: the paint must not lag the gesture by a frame.
   */
  // A PAINT COUNTS AS A GESTURE IN THE AIR, or the rule protects only half the grid: the band and the
  // hours the form is pre-filled with are read off the axis fixed at press, so a late re-fit under a
  // still-pressed pointer would hand the owner a duration they never drew.
  // `pressed`, not "a band exists": since the release keeps the band drawn while it is asked what
  // it is, freezing the axis on the band would hold a stale scale across a window resize. The band
  // and the form are both held in MINUTES, so they redraw correctly at any scale.
  const gestureInAir = drag.kind !== null || paint.pressed;

  /** The rectangles the held band draws, over every column its hours reach. */
  const draftRows = useMemo(
    () => (draft === null || view === null ? EMPTY_DRAFT : planDraftRows(view.days, draft).rows),
    [draft, view],
  );
  const heldTimeline = useRef<Timeline | null>(fittedTimeline);
  if (!gestureInAir) heldTimeline.current = fittedTimeline;
  const timeline = gestureInAir ? heldTimeline.current : fittedTimeline;

  // The hover bar's delete. The count and total come from `GET /api/projects/:id`, because
  // both are facts about the whole job rather than about the week.
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
      // A fragment and a remainder both have to exist, and neither can be under half an hour.
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
      // The engine never writes to the past, and neither does a placement. The fragment STAYS
      // ARMED: a bare `return` is the same silence as a swallowed drop, mid-gesture.
      if (day.isPast) {
        toast.warning(t('notices.dropRefusedPast'));
        return;
      }

      setPlacing(null);
      void mutate(() =>
        apiSplitBlock(fragment.blockId, {
          durationMinutes: fragment.durationMinutes,
          date: slot.date,
          // Already clamped over the DAY where the fragment lands literally (`slotUnder` in
          // WeekGrid), so the ghost and this click cannot disagree. A rank stores no geometry.
          startMinutes: rankFor(
            slot.startMinutes,
            takenStartsOn(slot.date, [fragment.blockId]),
            (minutes) => timeline.clampStart(minutes),
            // A fragment pins on the same days and bands as any drop, and where it pins the
            // minute is stored, so it must not be nudged.
            dropPins({
              fixed: false,
              role: day.role,
              closed: day.isClosed,
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
        // The fragment IS a drop, so the buffer and the weekend PIN it. Its id is minted by
        // the server and is not in the response, so the notice reads the day's own rule.
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

  // --- Effects ---

  // Left/right page the week. Paging is a GET, so holding a key down is harmless.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
      if (isTypingTarget(event.target)) return;
      // A dialog, a panel or a pending placement owns the keyboard while it is open.
      if (placing !== null || splitSource !== null || deleteTarget !== null) return;
      if (openJobId !== null || newJobOpen || gapTarget !== null) return;
      // A gesture in the air owns it too: a move handles the arrows itself in the capture
      // phase, and a RESIZE has no use for another week — its edge is one row on one day.
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

  // --- Render ---

  const weekLabel =
    view === null ? '' : format.weekLabel(view.week.isoWeek, view.week.startDate, view.week.endDate);

  const emptyWeek = view !== null && view.blocks.length === 0 && view.gaps.length === 0;

  /**
   * The sentence under the grid while a gesture is in the air. FIVE of them: a gap's two gestures
   * mean something else from a block's, and a block's move means two things by itself. The same
   * predicates the ghost switches on.
   */
  const dragHintKey =
    drag.preview === null
      ? 'grid.dropRankHint'
      : drag.target?.kind === 'gap'
        ? drag.preview.kind === 'resize'
          ? 'grid.gapResizeHint'
          : 'grid.gapDragHint'
        : drag.preview.kind === 'resize'
          ? 'block.resizeHint'
          : // The gesture's own answer, covering the SLOT as well as the day. See
            // `DragPreview.pinned`.
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
        onNewAbsence={
          renderAbsenceForm === undefined ? undefined : () => setGapTarget({ gap: null, origin: 'menu' })
        }
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
                paint={paint}
                draftRows={draftRows}
                placing={placing}
                onPlace={onPlace}
                onOpenJob={setOpenJobId}
                onOpenGap={renderAbsenceForm === undefined ? undefined : (gap) => setGapTarget({ gap, origin: 'gap' })}
                onCloseDay={
                  renderAbsenceForm === undefined
                    ? undefined
                    : // A gap IS how a day stops early, so the action opens the gap form
                      // with everything but the reason filled in.
                      (closeDay) => setGapTarget({ gap: null, origin: 'close-day', closeDay })
                }
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
            {/* The two drags say different things, and a MOVE says two of its own — see
                `dragHintKey`. */}
            {drag.preview !== null ? (
              <span className={styles.hint}>{t(dragHintKey)}</span>
            ) : placing !== null ? (
              // NOT `block.splitHint`, which is the DIALOG's: by now the grid has the pointer,
              // so what is left to say is what to do with it and how to get out.
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

      {release === null || view === null ? null : (
        <PaintChooser
          at={release.at}
          label={`${format.dayOption(release.span.date)} · ${format.timeRange(
            release.span.startMinutes,
            clockEndOf(
              dayAt(release.span.date)?.manualWindows ?? view.shape.manualWindows,
              release.span.startMinutes,
              release.span.durationMinutes,
            ),
          )} · ${format.hours(release.span.durationMinutes)}`}
          // Each answer clears the band and opens a form IN THE SAME HANDLER, so the rectangle never
          // blinks between the question and the form that inherits it.
          onJob={() => {
            setPaintedJob(release.span);
            setRelease(null);
            paint.settle();
          }}
          onGap={() => {
            const { date, ...painted } = release.span;
            setGapTarget({ gap: null, origin: 'paint', kind: 'gap', date, painted });
            setRelease(null);
            paint.settle();
          }}
          onCancel={() => {
            setRelease(null);
            paint.settle();
          }}
        />
      )}

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
                direction: resizeChoice.direction,
                freedMinutes: resizeChoice.freedMinutes,
                choices: resizeChoice.choices,
              }
        }
        busy={busy}
        // Cancelling is simply not asking again: the 409 wrote nothing.
        onCancel={() => setResizeChoice(null)}
        onChoose={(choice) => {
          if (resizeChoice === null) return;
          onResizeBlock(resizeChoice.target, resizeChoice.durationMinutes, choice);
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

      {/* The panels are fed the week's own facts — the shop's today, the strip, the shift — so
          no form guesses at the browser's clock. None can open before the first week arrives. */}
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

          {(!newJobOpen && paintedJob === null) || renderNewJob === undefined
            ? null
            : renderNewJob({
                close: () => {
                  setNewJobOpen(false);
                  setPaintedJob(null);
                  setDraft(null);
                },
                onChanged: week.reload,
                today: view.today,
                summary: view.summary,
                suggestedColor: leastUsedColor(view.blocks),
                horizonWeeks: view.settings.planningHorizonWeeks,
                ...(paintedJob === null
                  ? {}
                  : {
                      painted: { date: paintedJob.date, startMinutes: paintedJob.startMinutes },
                      // The band's own hours, which the form's number may then override.
                      defaultHours: paintedJob.durationMinutes / 60,
                      onDraft: setDraft,
                      visibleDates: view.week.dates,
                      onShowWeekOf: week.showWeekOf,
                    }),
              })}

          {gapTarget === null || renderAbsenceForm === undefined
            ? null
            : renderAbsenceForm({
                gap: gapTarget.gap,
                closeDay: gapTarget.closeDay ?? null,
                kind: gapTarget.kind ?? 'gap',
                origin: gapTarget.origin,
                close: () => {
                  setGapTarget(null);
                  setDraft(null);
                },
                ...(gapTarget.origin === 'paint'
                  ? {
                      onDraft: setDraft,
                      visibleDates: view.week.dates,
                      onShowWeekOf: week.showWeekOf,
                    }
                  : {}),
                onChanged: week.reload,
                today: view.today,
                shape: view.shape,
                gapColor: view.settings.gapColor,
                // The day the gesture named — a painted band's, a closed column's — or one the
                // owner can see.
                defaultDate:
                  gapTarget.date ??
                  (view.week.dates.includes(view.today) ? view.today : view.week.startDate),
                // A closed day's note, so pressing Guardar cannot blank the reason it was closed for.
                ...(gapTarget.date === undefined
                  ? {}
                  : dayNote(dayAt(gapTarget.date)?.note)),
                ...(gapTarget.painted === undefined
                  ? {}
                  : {
                      defaultStartMinutes: gapTarget.painted.startMinutes,
                      defaultDurationMinutes: gapTarget.painted.durationMinutes,
                    }),
                horizonWeeks: view.settings.planningHorizonWeeks,
              })}
        </>
      )}
    </div>
  );
}

// --- Internals ---

/** A day's own words as the form's default reason, and nothing at all when it has none. */
function dayNote(note: string | undefined): { defaultReason?: string } {
  return note === undefined ? {} : { defaultReason: note };
}

/** Stands in for `view.shape` before the first response, only so the drag hook has a timeline. */
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

/** One key per `InertReason`, each naming the reason AND what the owner can still do. */
const INERT_KEYS: Record<InertReason, string> = {
  busy: 'notices.pressWhileBusy',
  past: 'notices.pressOnPastDay',
};

/** One key per branch of `describeDrop`, which is where the branches are decided and tested. */
const DROP_OUTCOME_KEYS: Record<DropOutcomeKind, string> = {
  pinned: 'notices.dropPinned',
  settled: 'notices.dropSettles',
  leftWeek: 'notices.dropLeftWeek',
  pulledBack: 'notices.dropPulledBack',
  movedWeek: 'notices.dropMovedWeek',
  filled: 'notices.dropFilled',
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

/** The least-used swatch, so two jobs created back to back are not the same colour. */
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

/** The height of an element, kept current: it chooses the axis's vertical scale. */
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
