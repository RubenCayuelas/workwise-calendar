'use client';

/**
 * `Absences` — one screen for every way the shop is not working, in two modes the owner picks
 * between inside it: **un gap** (`gaps`, cut at the lunch break) and **cerrar días** (`day_overrides`).
 * Both share ONE range calendar, so a whole Fair week is one gesture instead of one hand-typed row
 * per day, which is what the shop's own database was full of.
 *
 * It is also the gap form in its two OLD shapes, unchanged: editing one absence, and *cerrar el día
 * aquí* with the gap already worked out. Those two write through `/api/gaps` and reach the past;
 * bulk creation goes through `/api/absences`, which PREVIEWS first — a range displaces hours into
 * weeks that are not on screen, so the cost is named before Guardar and cancelling writes nothing.
 *
 * `gapForm.lunchNote` is on the form because lunch is IMPLICIT, not a gap: unsaid, the first thing
 * an owner does here is recreate the lunch break by hand.
 */

import { useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { IconLockOpen, IconTrash } from '@tabler/icons-react';
import {
  Button,
  ColorDot,
  ConfirmDialog,
  DayPicker,
  Field,
  IconButton,
  InlineBanner,
  Input,
  NumberStepper,
  SidePanel,
  TIME_STEP_MINUTES,
  clockMinutes,
  TimeField,
  useToast,
} from '../ui';
import {
  apiErrorMessage,
  createGap,
  deleteGap,
  isAbortError,
  isApiError,
  previewAbsence,
  reopenDays,
  saveAbsence,
  updateGap,
  type AbsenceKind,
  type AbsencePreview,
  type DayWork,
  type DayShape,
  type GapUnit,
} from '../../lib/api-client';
import {
  MINUTES_PER_DAY,
  compareDates,
  hoursToMinutes,
  isValidDate,
  minutesToHHmm,
  minutesToHours,
  todayLocal,
} from '../../lib/dates';
import { lastPeriodEndMinutes, planCloseDay, type CloseDayRequest } from '../../lib/closeDay';
import { netMinutesOf } from '../../lib/manualWindow';
import { useFormat, type Formatter } from '../../lib/useFormat';

/** An absence is drawn on the same quarter-hour grid the calendar snaps to, so the field is too. */
const ABSENCE_HOUR_STEP = TIME_STEP_MINUTES / 60;
import type { GridDraft } from '../calendar/draftBand';
import { dayIsForced, dayMinutes, keepWorkDates } from '../calendar/dayWork';
import { offWeekChoice } from './offWeek';
import { otherGapConflicts } from './placement';
import {
  absenceFormMode,
  summarizeAbsence,
  type AbsenceNote,
  type AbsenceOrigin,
  type AbsenceSummary,
} from './absence';
import { API_FIELD, absenceSpan, rangeError, type AbsenceField } from './absenceFields';
import type { JobsMutationHandler } from './events';
import styles from './jobs.module.css';

const DEFAULT_GAP_MINUTES = 60;
/** Without a `shape` to bound it, a gap may not be longer than half a day. */
const FALLBACK_MAX_HOURS = 12;

/** The range and the hours change on every click of a stepper; a preview per click is a request per click. */
const PREVIEW_DELAY_MS = 220;

export interface AbsencePanelProps {
  open: boolean;
  /**
   * Omit to create; pass one to edit it. THE WHOLE ABSENCE — its day, its start and the NET total of
   * its rows — because `PATCH /api/gaps/:id` addresses the unit through whichever row the id names:
   * handed one half of a lunch-break-crossing gap, this form would save 6 h as the whole of a 10 h absence
   * and the reconcile would delete the other row.
   */
  gap?: GapUnit;
  /** "Stop the day here": the day, moment and span are already decided. Ignored when editing. */
  closeDay?: CloseDayRequest;
  onClose: () => void;
  /** Fired on every successful write. The parent MUST refetch the week. */
  onChanged?: JobsMutationHandler;
  onDeleted?: (gapId: string) => void;
  /** Which mode a NEW absence opens in. The grid's paint gesture only ever asks for `gap`. */
  defaultKind?: AbsenceKind;
  /**
   * Which gesture opened this. It decides whether the RANGE screen or one absence is shown, so it is
   * REQUIRED: a default here is what let a painted band silently keep opening the range screen.
   */
  origin: AbsenceOrigin;
  /** Only for a PAINTED band: keeps it drawn on the grid, following these fields. */
  onDraft?: (draft: GridDraft | null) => void;
  /** The days on screen: without them a date leaving the week cannot be noticed. */
  visibleDates?: readonly string[];
  onShowWeekOf?: (date: string) => void;
  /** Where a NEW absence starts. Defaults to today and the start of the morning period. */
  defaultDate?: string;
  /**
   * The words a day already carries — a closed day's note, when the owner pressed that column.
   * Without it, opening a closed day and pressing Guardar would blank the reason it was closed for.
   */
  defaultReason?: string;
  defaultStartMinutes?: number;
  defaultDurationMinutes?: number;
  /** `WeekView.shape`: gives the default start time and the duration ceiling. */
  shape?: DayShape;
  /** `settings.gapColor` — the one colour every gap is painted in. */
  gapColor?: string;
  today?: string;
  /** `settings.planningHorizonWeeks`: how far ahead the day pickers reach. */
  horizonWeeks?: number;
  /** `WeekController.revision`: what the pickers' day marks are refetched on. */
  revision?: number;
}

export function AbsencePanel({
  open,
  gap,
  closeDay,
  onClose,
  onChanged,
  onDeleted,
  defaultKind = 'gap',
  origin,
  onDraft,
  visibleDates,
  onShowWeekOf,
  defaultDate,
  defaultReason,
  defaultStartMinutes,
  defaultDurationMinutes,
  shape,
  gapColor,
  today,
  horizonWeeks,
  revision,
}: AbsencePanelProps): React.JSX.Element {
  const { t } = useTranslation();
  const format = useFormat();
  const toast = useToast();
  const reference = today ?? todayLocal();
  const modeName = useId();

  const [kind, setKind] = useState<AbsenceKind>(defaultKind);
  const [date, setDate] = useState(reference);
  const [endDate, setEndDate] = useState(reference);
  const [startTime, setStartTime] = useState('');
  const [hours, setHours] = useState(minutesToHours(DEFAULT_GAP_MINUTES));
  const [reason, setReason] = useState('');
  const [localError, setLocalError] = useState<{ field: AbsenceField; key: string } | null>(null);
  /**
   * What the hour field is refusing. It is on screen; `startTime` is not — it still holds the last
   * settled value. Only ever ONE of the two hour fields is mounted, and the field itself clears this
   * on both mount and unmount, so a mode switch cannot leave a refusal behind for a control the
   * screen no longer draws.
   */
  const [timeRefusal, setTimeRefusal] = useState<string | undefined>(undefined);
  const [actionError, setActionError] = useState<unknown>(null);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [preview, setPreview] = useState<AbsencePreview | null>(null);
  /** Displace or keep, per day, for the days the preview says have work on them. Absent = displace. */
  const [keepChoice, setKeepChoice] = useState<Map<string, boolean>>(new Map());
  /** The answers as they stand, joined so the preview effect can depend on their VALUE. */
  const keptKey = [...keepChoice.entries()]
    .filter(([, keep]) => keep)
    .map(([day]) => day)
    .sort()
    .join(',');
  const keptDates = keptKey === '' ? [] : keptKey.split(',');
  const [previewing, setPreviewing] = useState(false);
  const [previewError, setPreviewError] = useState<unknown>(null);
  /** The last day chosen that WAS on screen: the honest place to offer going back to. */
  const [lastVisible, setLastVisible] = useState<string | null>(null);

  /** Set only in the "stop the day here" shape: editing a gap always wins over it. */
  const closing = gap === undefined ? closeDay : undefined;
  // The GESTURE decides this, not the absence of the other two props: a painted band passes neither,
  // so inferring it opened the whole range screen for a gesture that is one column by definition.
  const bulk = absenceFormMode(origin) === 'range' && gap === undefined && closing === undefined;
  const fallbackStart =
    closing?.fromMinutes ?? defaultStartMinutes ?? shape?.periods[0]?.startMinutes ?? 8 * 60;

  useEffect(() => {
    if (!open) {
      // A confirmation must never outlive the panel it belongs to.
      setConfirmOpen(false);
      return;
    }
    const from = gap?.date ?? closing?.input.date ?? defaultDate ?? reference;
    setKind(defaultKind);
    setDate(from);
    setEndDate(from);
    setStartTime(minutesToHHmm(gap?.startMinutes ?? fallbackStart));
    setHours(minutesToHours(gap?.durationMinutes ?? defaultDurationMinutes ?? DEFAULT_GAP_MINUTES));
    setReason(gap?.reason ?? defaultReason ?? '');
    setLocalError(null);
    setActionError(null);
    setPreview(null);
    setPreviewError(null);
  }, [
    open,
    gap,
    closing,
    defaultKind,
    defaultDate,
    defaultReason,
    defaultDurationMinutes,
    fallbackStart,
    reference,
  ]);

  /**
   * A gap's hours are NET working minutes, so the ceiling is the manual window's own minutes — 12 h on
   * the documented shift, not the 13.5 h the axis is tall. The axis span would let the owner type an
   * hour and a half the day cannot hold and have the save refuse it.
   */
  const maxHours =
    shape === undefined ? FALLBACK_MAX_HOURS : minutesToHours(netMinutesOf(shape.manualWindows));

  /**
   * The gap the closing shape would save, recomputed on every keystroke: the moment is the
   * only thing the owner sets, and everything else follows from it.
   */
  const plan =
    closing === undefined
      ? null
      : planCloseDay(closing.input, clockMinutes(startTime) ?? closing.fromMinutes);
  const closeBounds = closing === undefined ? undefined : momentBounds(closing.input.periods);

  const durationMinutes = hoursToMinutes(hours);
  const startMinutes = clockMinutes(startTime);

  // Only a PAINTED band is held on the grid, and a gap's day is as literal as its minute, so the
  // band never leaves the column it was drawn on.
  useEffect(() => {
    if (onDraft === undefined) return;
    if (!open || startMinutes === undefined || durationMinutes <= 0 || !isValidDate(date)) {
      onDraft(null);
      return;
    }
    onDraft({ kind: 'gap', date, startMinutes, durationMinutes });
  }, [onDraft, open, date, startMinutes, durationMinutes]);

  // Only while a BAND is being held: elsewhere there is nothing on the grid to go and look at.
  const offWeek =
    onDraft === undefined || visibleDates === undefined
      ? null
      : offWeekChoice(date, visibleDates, lastVisible);

  const rangeValid =
    isValidDate(date) && isValidDate(endDate) && compareDates(endDate, date) >= 0;
  const previewable =
    open &&
    bulk &&
    rangeValid &&
    (kind === 'closed-days' ||
      (startMinutes !== undefined && durationMinutes > 0 && startMinutes + durationMinutes <= MINUTES_PER_DAY));

  // The warning before the hours move, and it is the SERVER's answer: it runs the real write and
  // rolls it back, so what is on screen is what Guardar will do — refusals included.
  useEffect(() => {
    if (!previewable) {
      setPreview(null);
      setPreviewError(null);
      return;
    }

    let cancelled = false;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setPreviewing(true);
      previewAbsence(
        {
          kind,
          ...absenceSpan(bulk, date, endDate),
          ...(kind === 'gap' ? { startMinutes, durationMinutes } : {}),
          // The answers travel with it: without them the preview reports the displacement of a save
          // nobody is about to make, and the two notices would disagree about the same hours.
          ...(keptKey === '' ? {} : { keepWork: keptKey.split(',') }),
        },
        { signal: controller.signal },
      )
        .then((result) => {
          if (cancelled) return;
          setPreview(result);
          setPreviewError(null);
        })
        .catch((error: unknown) => {
          if (cancelled || isAbortError(error)) return;
          setPreview(null);
          setPreviewError(error);
        })
        .finally(() => {
          if (!cancelled) setPreviewing(false);
        });
    }, PREVIEW_DELAY_MS);

    return () => {
      cancelled = true;
      controller.abort();
      clearTimeout(timer);
    };
  }, [previewable, bulk, kind, date, endDate, startMinutes, durationMinutes, keptKey]);

  const summary: AbsenceSummary | null = preview === null ? null : summarizeAbsence(preview);

  const submit = async (): Promise<void> => {
    if (saving || deleting) return;
    // A refused hour would be saved as the value the field stopped showing — the day closed from
    // 08:00 for a typed 23:00. The blur that refuses it is flushed before this click.
    if (timeRefusal !== undefined) return;

    if (!isValidDate(date)) {
      setLocalError({ field: 'date', key: 'errors.invalidDate' });
      return;
    }
    if (bulk && !rangeValid) {
      setLocalError({ field: 'endDate', key: 'errors.rangeBackwards' });
      return;
    }

    let start: number;
    let minutes: number;

    if (closing !== undefined) {
      // Derived, never typed: from the chosen moment to the end of the last period.
      if (plan === null || plan.workingMinutes <= 0) {
        setLocalError({ field: 'startTime', key: 'gapForm.closeDayNoRoom' });
        return;
      }
      start = plan.startMinutes;
      minutes = plan.durationMinutes;
    } else if (kind === 'closed-days' && bulk) {
      // Closing a day takes no hours at all: a short day is a gap.
      start = 0;
      minutes = 0;
    } else {
      if (durationMinutes <= 0) {
        setLocalError({ field: 'duration', key: 'errors.invalidDuration' });
        return;
      }
      if (startMinutes === undefined || startMinutes + durationMinutes > MINUTES_PER_DAY) {
        setLocalError({ field: 'startTime', key: 'errors.invalidTime' });
        return;
      }
      start = startMinutes;
      minutes = durationMinutes;
    }

    const trimmed = reason.trim();
    setSaving(true);
    setLocalError(null);
    setActionError(null);

    try {
      if (gap !== undefined) {
        const result = await updateGap(gap.id, {
          date,
          startMinutes: start,
          durationMinutes: minutes,
          // `null` clears a stored reason; omitting it would keep the old text.
          reason: trimmed === '' ? null : trimmed,
        });
        onChanged?.({ kind: 'gap-updated', gapId: result.gap.id, summary: result.summary });
        toast.success(t('gapForm.saved'));
      } else if (closing !== undefined) {
        const result = await createGap({
          date,
          startMinutes: start,
          durationMinutes: minutes,
          ...(trimmed === '' ? {} : { reason: trimmed }),
        });
        onChanged?.({ kind: 'gap-created', gapId: result.gap.id, summary: result.summary });
        toast.success(t('gapForm.saved'));
      } else {
        const keepWork =
          kind === 'closed-days' && preview !== null
            ? keepWorkDates(preview.daysWithWork, keepChoice)
            : [];
        const result = await saveAbsence({
          kind,
          ...absenceSpan(bulk, date, endDate),
          ...(trimmed === '' ? {} : { reason: trimmed }),
          ...(kind === 'gap' ? { startMinutes: start, durationMinutes: minutes } : {}),
          ...(keepWork.length === 0 ? {} : { keepWork }),
        });
        onChanged?.({
          kind: kind === 'gap' ? 'gap-created' : 'days-closed',
          ...(result.gaps[0] === undefined ? {} : { gapId: result.gaps[0].id }),
          summary: result.summary,
        });
        toast.success(
          t(kind === 'gap' ? 'absenceForm.savedGaps' : 'absenceForm.savedClosed', {
            count: result.dates.length,
          }),
        );
      }

      onClose();
    } catch (error) {
      setActionError(error);
    } finally {
      setSaving(false);
    }
  };

  const remove = async (): Promise<void> => {
    if (gap === undefined || deleting) return;
    setDeleting(true);
    setActionError(null);

    try {
      const result = await deleteGap(gap.id);
      onChanged?.({ kind: 'gap-deleted', gapId: gap.id, summary: result.summary });
      onDeleted?.(gap.id);
      setConfirmOpen(false);
      onClose();
    } catch (error) {
      setConfirmOpen(false);
      setActionError(error);
    } finally {
      setDeleting(false);
    }
  };

  /** The way back out of a closed day: the range is reopened and the queue fills it again. */
  const reopen = async (): Promise<void> => {
    if (saving || deleting) return;
    setSaving(true);
    setActionError(null);

    try {
      const result = await reopenDays(absenceSpan(bulk, date, endDate));
      onChanged?.({ kind: 'days-reopened', summary: result.summary });
      toast.success(t('absenceForm.reopened', { count: result.dates.length }));
      onClose();
    } catch (error) {
      setActionError(error);
    } finally {
      setSaving(false);
    }
  };

  const actionMessage =
    actionError === null ? undefined : apiErrorMessage(actionError, t, format.language);
  const previewMessage =
    previewError === null ? undefined : apiErrorMessage(previewError, t, format.language);
  // The message names one offender; these are the rest of them.
  const conflicts = isApiError(actionError) ? otherGapConflicts(actionError.details) : [];
  const previewConflicts = isApiError(previewError) ? otherGapConflicts(previewError.details) : [];
  const busy = saving || deleting;
  // Closing at a moment with no plannable time left after it would save a gap that
  // changes nothing, so the button says no rather than the server doing nothing.
  const nothingToClose = closing !== undefined && (plan === null || plan.workingMinutes <= 0);
  // The preview refused, so Guardar would refuse too: it is not offered.
  const refused = previewError !== null;
  const reopenable = bulk && kind === 'closed-days' && (summary?.alreadyClosed.length ?? 0) > 0;

  const errorFor = (field: AbsenceField): string | undefined => {
    if (localError?.field === field) return t(localError.key);
    if (!isApiError(actionError) || actionError.field === undefined) return undefined;
    return API_FIELD[actionError.field] === field ? actionMessage : undefined;
  };

  const title = t(
    gap !== undefined
      ? 'gapForm.editTitle'
      : closing !== undefined
        ? 'gapForm.closeDayTitle'
        : 'absenceForm.title',
  );

  return (
    <>
      <SidePanel
        open={open}
        onClose={onClose}
        closeOnEscape={!confirmOpen}
        title={title}
        accent={gapColor === undefined ? undefined : <ColorDot color={gapColor} />}
        footer={
          <>
            <Button
              className={styles.grow}
              variant="primary"
              disabled={busy || nothingToClose || refused || timeRefusal !== undefined}
              onClick={submit}
            >
              {saving
                ? t('common.saving')
                : t(
                    closing !== undefined
                      ? 'gapForm.closeDayConfirm'
                      : bulk && kind === 'closed-days'
                        ? 'absenceForm.submitClosed'
                        : 'gapForm.submit',
                  )}
            </Button>
            {reopenable ? (
              <Button
                variant="secondary"
                icon={<IconLockOpen size={15} stroke={1.75} />}
                disabled={busy}
                onClick={reopen}
              >
                {t('absenceForm.reopen')}
              </Button>
            ) : null}
            {gap === undefined ? (
              <Button variant="secondary" disabled={busy} onClick={onClose}>
                {t('common.cancel')}
              </Button>
            ) : (
              <IconButton
                variant="danger"
                icon={<IconTrash size={15} stroke={1.75} />}
                label={t('gapForm.delete')}
                disabled={busy}
                onClick={() => setConfirmOpen(true)}
              />
            )}
          </>
        }
      >
        {actionMessage === undefined ? null : (
          <InlineBanner tone="error" title={t('errors.title')} onDismiss={() => setActionError(null)}>
            {actionMessage}
            <ConflictList conflicts={conflicts} format={format} />
          </InlineBanner>
        )}

        {!bulk ? null : (
          <Field label={t('absenceForm.mode')} id={modeName}>
            <div className={styles.modes} role="radiogroup" aria-labelledby={modeName}>
              {(['gap', 'closed-days'] as const).map((option) => (
                <label
                  key={option}
                  className={[styles.mode, kind === option ? styles.modeSelected : '']
                    .filter(Boolean)
                    .join(' ')}
                >
                  <input
                    className="ww-visually-hidden"
                    type="radio"
                    name={modeName}
                    value={option}
                    checked={kind === option}
                    disabled={busy}
                    onChange={() => {
                      setKind(option);
                      setLocalError(null);
                      setPreview(null);
                      setPreviewError(null);
                    }}
                  />
                  <span className={styles.modeName}>
                    {t(option === 'gap' ? 'absenceForm.modeGap' : 'absenceForm.modeClosed')}
                  </span>
                  <span className={styles.modeHint}>
                    {t(option === 'gap' ? 'absenceForm.modeGapHint' : 'absenceForm.modeClosedHint')}
                  </span>
                </label>
              ))}
            </div>
          </Field>
        )}

        {closing === undefined ? (
          <>
            {bulk ? (
              /* One control over both ends of the span: its error slot is the only place
                 `errors.rangeBackwards` and the server's `invalid-range` are ever drawn, and the line
                 under it is the days the preview will WRITE — a Monday-to-Sunday span paints seven
                 cells and writes five. */
              <Field
                label={t('absenceForm.range')}
                error={rangeError(errorFor)}
                hint={
                  summary === null ? undefined : t('absenceForm.days', { count: summary.dayCount })
                }
              >
                <DayPicker
                  range
                  value={date}
                  endValue={endDate}
                  today={reference}
                  horizonWeeks={horizonWeeks}
                  revision={revision}
                  disabled={busy}
                  onChangeRange={(from, to) => {
                    // BOTH ends in one update. A half-chosen range would run `previewAbsence`, which
                    // is the real write inside a transaction that is rolled back, and would drop
                    // `Reabrir` out of the footer while `rangeValid` was false.
                    setDate(from);
                    setEndDate(to);
                  }}
                />
              </Field>
            ) : (
              <div>
                {/* Never a native date input. The picker keeps a
                    stored day outside its window, so editing an old gap can never move it. */}
                <Field
                  label={t('gapForm.date')}
                  // Either end of the span, so a refusal `API_FIELD` maps to `endDate` cannot go
                  // unsaid on a screen that draws no control for it.
                  error={rangeError(errorFor)}
                  hint={isValidDate(date) ? format.dayLine(date) : undefined}
                >
                  <DayPicker
                    value={date}
                    today={reference}
                    horizonWeeks={horizonWeeks}
                    revision={revision}
                    disabled={busy}
                    onChange={(next) => {
                      // Set OPTIMISTICALLY: a painted band on the grid has to follow the field.
                      if (visibleDates?.includes(date) === true) setLastVisible(date);
                      setDate(next);
                    }}
                  />
                </Field>

                {offWeek === null ? null : (
                  <InlineBanner tone="info" title={t('jobForm.offWeekTitle')}>
                    {t('jobForm.offWeek', { date: format.longDate(offWeek.goTo) })}
                    <div className={styles.offWeekActions}>
                      <Button size="sm" onClick={() => onShowWeekOf?.(offWeek.goTo)}>
                        {t('jobForm.offWeekGo')}
                      </Button>
                      {offWeek.backTo === null ? null : (
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() => setDate(offWeek.backTo as string)}
                        >
                          {t('jobForm.offWeekBack', { date: format.dayOption(offWeek.backTo) })}
                        </Button>
                      )}
                    </div>
                  </InlineBanner>
                )}
              </div>
            )}

            {kind === 'closed-days' && bulk ? null : (
              <div className={styles.row}>
                <Field
                  label={t('gapForm.startTime')}
                  error={timeRefusal ?? errorFor('startTime')}
                >
                  <TimeField
                    value={startTime}
                    disabled={busy}
                    onChange={setStartTime}
                    onInvalid={setTimeRefusal}
                  />
                </Field>

                <Field label={t('gapForm.duration')} error={errorFor('duration')}>
                  {/* The QUARTER hour, not the half: the paint gesture snaps to `TIME_STEP_MINUTES`,
                      and a field on a coarser grid silently rewrote the band the owner had just
                      drawn — 3,25 h painted came back 3,5 h on the first press of the stepper. */}
                  <NumberStepper
                    value={hours}
                    min={ABSENCE_HOUR_STEP}
                    max={maxHours}
                    step={ABSENCE_HOUR_STEP}
                    suffix={t('units.hoursSuffix')}
                    disabled={busy}
                    onChange={setHours}
                  />
                </Field>
              </div>
            )}
          </>
        ) : (
          <>
            <div className={styles.context}>
              <span className={styles.contextLabel}>{format.longDate(closing.input.date)}</span>
              <span className={styles.contextValue}>
                {plan === null
                  ? t('gapForm.closeDayNoRoom')
                  : format.timeRange(plan.startMinutes, plan.endMinutes)}
              </span>
            </div>

            <Field
              label={t('gapForm.closeDayWhen')}
              error={timeRefusal ?? errorFor('startTime')}
            >
              <TimeField
                value={startTime}
                minMinutes={closeBounds?.minMinutes}
                maxMinutes={closeBounds?.maxMinutes}
                disabled={busy}
                onChange={setStartTime}
                onInvalid={setTimeRefusal}
              />
            </Field>

            {plan === null ? null : (
              <div className={styles.notices}>
                <p className={styles.hint}>
                  {t('gapForm.closeDaySpan', {
                    start: format.time(plan.startMinutes),
                    end: format.time(plan.endMinutes),
                    hours: format.hourNumber(plan.workingMinutes),
                  })}
                </p>

                {plan.displaced.length === 0 ? (
                  <p className={styles.hint}>{t('gapForm.closeDayMovesNone')}</p>
                ) : (
                  <div>
                    <p className={styles.hint}>{t('gapForm.closeDayMoves')}</p>
                    <span className={styles.noticeList}>
                      {plan.displaced.map((job) => (
                        <span key={job.projectId} className={styles.noticeLine}>
                          <span className={styles.noticeLabel}>{format.hours(job.minutes)}</span>
                          <span className={styles.blockTag}>{job.name}</span>
                        </span>
                      ))}
                    </span>
                  </div>
                )}

                {plan.locked.length === 0 ? null : (
                  <InlineBanner tone="warning">
                    {t('gapForm.closeDayLocked', {
                      names: plan.locked.map((block) => block.name).join(', '),
                    })}
                  </InlineBanner>
                )}
              </div>
            )}
          </>
        )}

        <Field label={t('gapForm.reason')} optional error={errorFor('reason')}>
          <Input
            value={reason}
            placeholder={t(
              bulk && kind === 'closed-days'
                ? 'absenceForm.notePlaceholder'
                : 'gapForm.reasonPlaceholder',
            )}
            disabled={busy}
            onChange={(event) => setReason(event.target.value)}
          />
        </Field>

        {!bulk ? null : (
          <AbsencePreviewNotice
            summary={summary}
            loading={previewing && summary === null}
            message={previewMessage}
            conflicts={previewConflicts}
            daysWithWork={kind === 'closed-days' ? (preview?.daysWithWork ?? []) : []}
            keepChoice={keepChoice}
            onKeepChoice={(day, keep) =>
              setKeepChoice((current) => new Map(current).set(day, keep))
            }
            busy={busy}
            format={format}
            t={t}
          />
        )}

        {closing !== undefined ? (
          <>
            <p className={styles.hint}>{t('gapForm.closeDayHint')}</p>
            <p className={styles.hint}>{t('gapForm.closeDayWhole')}</p>
          </>
        ) : bulk && kind === 'closed-days' ? (
          <>
            <p className={styles.hint}>{t('absenceForm.closedHint')}</p>
            <p className={styles.hint}>{t('absenceForm.noHalfDay')}</p>
          </>
        ) : (
          <>
            <p className={styles.hint}>{t('gapForm.hint')}</p>
            <p className={styles.hint}>{t('gapForm.blockedHint')}</p>
            <p className={styles.hint}>{t('gapForm.lunchNote')}</p>
          </>
        )}
      </SidePanel>

      <ConfirmDialog
        open={confirmOpen && gap !== undefined}
        title={t('gapForm.deleteTitle')}
        description={
          gap === undefined
            ? undefined
            : t('gapForm.deleteBody', {
                hours: format.hourNumber(gap.durationMinutes),
                date: format.longDate(gap.date),
              })
        }
        confirmLabel={t('gapForm.deleteConfirm')}
        busy={deleting}
        onConfirm={remove}
        onCancel={() => setConfirmOpen(false)}
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// The preview
// ---------------------------------------------------------------------------

interface AbsencePreviewNoticeProps {
  summary: AbsenceSummary | null;
  loading: boolean;
  /** A failed preview request, already translated. It is the save's refusal, arriving early. */
  message?: string;
  conflicts: ReturnType<typeof otherGapConflicts>;
  /** `closed-days` only: the days of the range that already have work on them. */
  daysWithWork: readonly DayWork[];
  keepChoice: ReadonlyMap<string, boolean>;
  onKeepChoice: (date: string, keep: boolean) => void;
  busy: boolean;
  format: Formatter;
  t: (key: string, values?: Record<string, unknown>) => string;
}

/**
 * What the save is about to cost: the rows a day would hold, the jobs it pushes and where their hours
 * land. All of the deciding happened in `summarizeAbsence`; this only spells it.
 */
function AbsencePreviewNotice({
  summary,
  loading,
  message,
  conflicts,
  daysWithWork,
  keepChoice,
  onKeepChoice,
  busy,
  format,
  t,
}: AbsencePreviewNoticeProps): React.JSX.Element | null {
  // Where each job's hours land, from the preview that ran with the answers as they stand. A job
  // absent from it is not being moved, which is what «stays here» means.
  const displacedTo = new Map(
    (summary?.displaced ?? []).map((job) => [job.projectId, job.landsOn]),
  );
  if (message !== undefined) {
    return (
      <InlineBanner tone="error" title={t('errors.title')}>
        {message}
        <ConflictList conflicts={conflicts} format={format} />
      </InlineBanner>
    );
  }
  if (summary === null) {
    return loading ? <p className={styles.hint}>{t('absenceForm.previewLoading')}</p> : null;
  }

  const note = (kind: AbsenceNote): string => {
    switch (kind) {
      case 'closesDays':
        return t('absenceForm.closesDays', { count: summary.dayCount });
      case 'alreadyClosedGap':
        return t('absenceForm.alreadyClosedGap', {
          days: summary.alreadyClosed.map((date) => format.dayOption(date)).join(', '),
        });
      case 'alreadyClosed':
        return t('absenceForm.alreadyClosed', {
          count: summary.alreadyClosed.length,
          days: summary.alreadyClosed.map((date) => format.dayOption(date)).join(', '),
        });
      case 'repeatsDaily':
        return t('absenceForm.repeatsDaily', { count: summary.dayCount });
      case 'cutAtBreak':
        return t('absenceForm.cutAtBreak');
      case 'skippedWeekend':
        return t('absenceForm.skippedWeekend', {
          days: summary.skipped.map((date) => format.dayOption(date)).join(', '),
        });
      case 'movesNothing':
        return t('absenceForm.movesNothing');
      case 'reachesFurther':
        return t('absenceForm.reachesFurther', {
          date: summary.reachesUntil === null ? '' : format.longDate(summary.reachesUntil),
        });
    }
  };

  return (
    <div className={styles.notices}>
      {daysWithWork.length === 0 ? null : (
        <InlineBanner tone="warning" title={t('dayWork.title')}>
          <span className={styles.noticeList}>
            {daysWithWork.map((day) => {
              const forced = dayIsForced(day.rows);
              const keep = keepChoice.get(day.date) ?? false;
              return (
                <span key={day.date} className={styles.noticeLine}>
                  <span className={styles.noticeLabel}>{format.dayOption(day.date)}</span>
                  {day.rows.map((job) => {
                    const lands = displacedTo.get(job.projectId);
                    return (
                      <span key={job.projectId} className={styles.hint}>
                        {t('dayWork.hours', { hours: format.hours(job.minutes), jobs: job.name })}{' '}
                        {lands === undefined
                          ? t('dayWork.staysHere')
                          : t('dayWork.movesTo', { day: format.mediumDate(lands) })}
                      </span>
                    );
                  })}
                  {forced ? (
                    <span className={styles.hint}>{t('dayWork.fixed')}</span>
                  ) : (
                    <span className={styles.keepChoice}>
                      <label className={styles.keepOption}>
                        <input
                          type="radio"
                          name={`keep-${day.date}`}
                          checked={!keep}
                          disabled={busy}
                          onChange={() => onKeepChoice(day.date, false)}
                        />
                        {t('dayWork.displace')}
                      </label>
                      <label className={styles.keepOption}>
                        <input
                          type="radio"
                          name={`keep-${day.date}`}
                          checked={keep}
                          disabled={busy}
                          onChange={() => onKeepChoice(day.date, true)}
                        />
                        {t('dayWork.keep')}
                        <span className={styles.hint}>{t('dayWork.keepHint')}</span>
                      </label>
                    </span>
                  )}
                </span>
              );
            })}
          </span>
        </InlineBanner>
      )}

      <InlineBanner tone={summary.tone} title={t('absenceForm.previewTitle')}>
        {summary.rowsPerDay.length === 0 ? null : (
          <span className={styles.noticeList}>
            {summary.rowsPerDay.map((row) => (
              <span key={`${row.date}-${row.startMinutes}`} className={styles.noticeLine}>
                <span className={styles.noticeLabel}>
                  {format.timeRange(row.startMinutes, row.startMinutes + row.durationMinutes)}
                </span>
                <span className={styles.blockHours}>{format.hours(row.durationMinutes)}</span>
              </span>
            ))}
          </span>
        )}

        <span className={styles.previewNotes}>
          {summary.notes.map((kind) => (
            <span key={kind} className={styles.hint}>
              {note(kind)}
            </span>
          ))}
        </span>

      </InlineBanner>
    </div>
  );
}

/** The rows a refusal did not name in its sentence, so everything in the way is visible at once. */
function ConflictList({
  conflicts,
  format,
}: {
  conflicts: ReturnType<typeof otherGapConflicts>;
  format: Formatter;
}): React.JSX.Element | null {
  if (conflicts.length === 0) return null;
  return (
    <span className={styles.noticeList}>
      {conflicts.map((conflict) => (
        <span key={conflict.blockId} className={styles.noticeLine}>
          <span className={styles.noticeLabel}>
            {format.dayTimeHours(conflict.date, conflict.startMinutes, conflict.durationMinutes)}
          </span>
          {conflict.projectName === '' ? null : (
            <span className={styles.blockTag}>{conflict.projectName}</span>
          )}
        </span>
      ))}
    </span>
  );
}

/**
 * The moments the day can be stopped at: the start of the shift to one step before it ends,
 * since a gap of nothing is not a gap. `undefined` on a day with no periods, which leaves
 * the control on the whole day rather than on an empty list.
 */
function momentBounds(
  periods: readonly { startMinutes: number; endMinutes: number }[],
): { minMinutes: number; maxMinutes: number } | undefined {
  const end = lastPeriodEndMinutes(periods);
  if (end === undefined) return undefined;
  return {
    minMinutes: Math.min(...periods.map((period) => period.startMinutes)),
    maxMinutes: end - TIME_STEP_MINUTES,
  };
}
