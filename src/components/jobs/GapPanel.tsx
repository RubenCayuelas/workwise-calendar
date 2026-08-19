'use client';

/**
 * The gap form, in two shapes: typed by hand, or "stop the day here" (`closeDay`) with the gap
 * already worked out. One endpoint and one set of refusals either way.
 *
 * `gapForm.lunchNote` is on the form because lunch is IMPLICIT, not a gap: unsaid, the first thing
 * an owner does here is recreate the lunch break by hand.
 */

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { IconTrash } from '@tabler/icons-react';
import {
  Button,
  ColorDot,
  ConfirmDialog,
  DateSelect,
  Field,
  IconButton,
  InlineBanner,
  Input,
  NumberStepper,
  SidePanel,
  TIME_STEP_MINUTES,
  TimeSelect,
  useToast,
} from '../ui';
import {
  apiErrorMessage,
  createGap,
  deleteGap,
  isApiError,
  updateGap,
  type DayShape,
  type Gap,
} from '../../lib/api-client';
import {
  MINUTES_PER_DAY,
  hoursToMinutes,
  isValidDate,
  minutesToHHmm,
  minutesToHours,
  todayLocal,
} from '../../lib/dates';
import { dayEndMinutes, planCloseDay, type CloseDayRequest } from '../../lib/closeDay';
import { netMinutesOf } from '../../lib/manualWindow';
import { useFormat } from '../../lib/useFormat';
import { HOUR_STEP, parseClockTime } from './forms';
import { otherGapConflicts } from './placement';
import type { JobsMutationHandler } from './events';
import styles from './jobs.module.css';

const DEFAULT_GAP_MINUTES = 60;
/** Without a `shape` to bound it, a gap may not be longer than half a day. */
const FALLBACK_MAX_HOURS = 12;

export interface GapPanelProps {
  open: boolean;
  /** Omit to create a gap; pass one to edit it. */
  gap?: Gap;
  /** "Stop the day here": the day, moment and span are already decided. Ignored when editing. */
  closeDay?: CloseDayRequest;
  onClose: () => void;
  /** Fired on every successful write. The parent MUST refetch the week. */
  onChanged?: JobsMutationHandler;
  onDeleted?: (gapId: string) => void;
  /** Where a NEW gap starts. Defaults to today and the start of the morning period. */
  defaultDate?: string;
  defaultStartMinutes?: number;
  defaultDurationMinutes?: number;
  /** `WeekView.shape`: gives the default start time and the duration ceiling. */
  shape?: DayShape;
  /** `settings.gapColor` — the one colour every gap is painted in. */
  gapColor?: string;
  today?: string;
  /** `settings.planningHorizonWeeks`: how far ahead the day picker reaches. */
  horizonWeeks?: number;
}

export function GapPanel({
  open,
  gap,
  closeDay,
  onClose,
  onChanged,
  onDeleted,
  defaultDate,
  defaultStartMinutes,
  defaultDurationMinutes,
  shape,
  gapColor,
  today,
  horizonWeeks,
}: GapPanelProps): React.JSX.Element {
  const { t } = useTranslation();
  const format = useFormat();
  const toast = useToast();
  const reference = today ?? todayLocal();

  const [date, setDate] = useState(reference);
  const [startTime, setStartTime] = useState('');
  const [hours, setHours] = useState(minutesToHours(DEFAULT_GAP_MINUTES));
  const [reason, setReason] = useState('');
  const [localError, setLocalError] = useState<{ field: GapField; key: string } | null>(null);
  const [actionError, setActionError] = useState<unknown>(null);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);

  /** Set only in the "stop the day here" shape: editing a gap always wins over it. */
  const closing = gap === undefined ? closeDay : undefined;
  const fallbackStart =
    closing?.fromMinutes ?? defaultStartMinutes ?? shape?.periods[0]?.startMinutes ?? 8 * 60;

  useEffect(() => {
    if (!open) {
      // A confirmation must never outlive the panel it belongs to.
      setConfirmOpen(false);
      return;
    }
    setDate(gap?.date ?? closing?.input.date ?? defaultDate ?? reference);
    setStartTime(minutesToHHmm(gap?.startMinutes ?? fallbackStart));
    setHours(minutesToHours(gap?.durationMinutes ?? defaultDurationMinutes ?? DEFAULT_GAP_MINUTES));
    setReason(gap?.reason ?? '');
    setLocalError(null);
    setActionError(null);
  }, [open, gap, closing, defaultDate, defaultDurationMinutes, fallbackStart, reference]);

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
      : planCloseDay(closing.input, parseClockTime(startTime) ?? closing.fromMinutes);
  const closeBounds = closing === undefined ? undefined : momentBounds(closing.input.periods);

  const submit = async (): Promise<void> => {
    if (saving || deleting) return;

    if (!isValidDate(date)) {
      setLocalError({ field: 'date', key: 'errors.invalidDate' });
      return;
    }

    let startMinutes: number;
    let durationMinutes: number;

    if (closing !== undefined) {
      // Derived, never typed: from the chosen moment to the end of the last period.
      if (plan === null || plan.workingMinutes <= 0) {
        setLocalError({ field: 'startTime', key: 'gapForm.closeDayNoRoom' });
        return;
      }
      startMinutes = plan.startMinutes;
      durationMinutes = plan.durationMinutes;
    } else {
      durationMinutes = hoursToMinutes(hours);
      if (durationMinutes <= 0) {
        setLocalError({ field: 'duration', key: 'errors.invalidDuration' });
        return;
      }
      const parsed = parseClockTime(startTime);
      if (parsed === undefined || parsed + durationMinutes > MINUTES_PER_DAY) {
        setLocalError({ field: 'startTime', key: 'errors.invalidTime' });
        return;
      }
      startMinutes = parsed;
    }

    const trimmed = reason.trim();
    setSaving(true);
    setLocalError(null);
    setActionError(null);

    try {
      if (gap === undefined) {
        const result = await createGap({
          date,
          startMinutes,
          durationMinutes,
          ...(trimmed === '' ? {} : { reason: trimmed }),
        });
        onChanged?.({ kind: 'gap-created', gapId: result.gap.id, summary: result.summary });
      } else {
        const result = await updateGap(gap.id, {
          date,
          startMinutes,
          durationMinutes,
          // `null` clears a stored reason; omitting it would keep the old text.
          reason: trimmed === '' ? null : trimmed,
        });
        onChanged?.({ kind: 'gap-updated', gapId: result.gap.id, summary: result.summary });
      }

      toast.success(t('gapForm.saved'));
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

  const actionMessage =
    actionError === null ? undefined : apiErrorMessage(actionError, t, format.language);
  // The message names one offender; these are the rest of them.
  const conflicts = isApiError(actionError) ? otherGapConflicts(actionError.details) : [];
  const busy = saving || deleting;
  // Closing at a moment with no plannable time left after it would save a gap that
  // changes nothing, so the button says no rather than the server doing nothing.
  const nothingToClose = closing !== undefined && (plan === null || plan.workingMinutes <= 0);

  const errorFor = (field: GapField): string | undefined => {
    if (localError?.field === field) return t(localError.key);
    if (!isApiError(actionError) || actionError.field === undefined) return undefined;
    return API_FIELD[actionError.field] === field ? actionMessage : undefined;
  };

  return (
    <>
      <SidePanel
        open={open}
        onClose={onClose}
        closeOnEscape={!confirmOpen}
        title={t(
          gap !== undefined
            ? 'gapForm.editTitle'
            : closing !== undefined
              ? 'gapForm.closeDayTitle'
              : 'gapForm.newTitle',
        )}
        accent={gapColor === undefined ? undefined : <ColorDot color={gapColor} />}
        footer={
          <>
            <Button
              className={styles.grow}
              variant="primary"
              disabled={busy || nothingToClose}
              onClick={submit}
            >
              {saving
                ? t('common.saving')
                : t(closing === undefined ? 'gapForm.submit' : 'gapForm.closeDayConfirm')}
            </Button>
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
            {conflicts.length === 0 ? null : (
              <span className={styles.noticeList}>
                {conflicts.map((conflict) => (
                  <span key={conflict.blockId} className={styles.noticeLine}>
                    <span className={styles.noticeLabel}>
                      {format.dayTimeHours(
                        conflict.date,
                        conflict.startMinutes,
                        conflict.durationMinutes,
                      )}
                    </span>
                    {conflict.projectName === '' ? null : (
                      <span className={styles.blockTag}>{conflict.projectName}</span>
                    )}
                  </span>
                ))}
              </span>
            )}
          </InlineBanner>
        )}

        {closing === undefined ? (
          <>
            {/* Never a native date input. The picker keeps a
                stored day outside its window, so editing an old gap can never move it. */}
            <Field
              label={t('gapForm.date')}
              error={errorFor('date')}
              hint={isValidDate(date) ? format.longDate(date) : undefined}
            >
              <DateSelect
                value={date}
                today={reference}
                horizonWeeks={horizonWeeks}
                disabled={busy}
                onChange={setDate}
              />
            </Field>

            <div className={styles.row}>
              <Field label={t('gapForm.startTime')} error={errorFor('startTime')}>
                <TimeSelect value={startTime} disabled={busy} onChange={setStartTime} />
              </Field>

              <Field label={t('gapForm.duration')} error={errorFor('duration')}>
                <NumberStepper
                  value={hours}
                  min={HOUR_STEP}
                  max={maxHours}
                  step={HOUR_STEP}
                  suffix={t('units.hoursSuffix')}
                  disabled={busy}
                  onChange={setHours}
                />
              </Field>
            </div>
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

            <Field label={t('gapForm.closeDayWhen')} error={errorFor('startTime')}>
              <TimeSelect
                value={startTime}
                minMinutes={closeBounds?.minMinutes}
                maxMinutes={closeBounds?.maxMinutes}
                disabled={busy}
                onChange={setStartTime}
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
            placeholder={t('gapForm.reasonPlaceholder')}
            disabled={busy}
            onChange={(event) => setReason(event.target.value)}
          />
        </Field>

        {closing === undefined ? (
          <>
            <p className={styles.hint}>{t('gapForm.hint')}</p>
            <p className={styles.hint}>{t('gapForm.blockedHint')}</p>
            <p className={styles.hint}>{t('gapForm.lunchNote')}</p>
          </>
        ) : (
          <>
            <p className={styles.hint}>{t('gapForm.closeDayHint')}</p>
            <p className={styles.hint}>{t('gapForm.closeDayWhole')}</p>
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

type GapField = 'date' | 'startTime' | 'duration' | 'reason';

/**
 * The moments the day can be stopped at: the start of the shift to one step before it ends,
 * since a gap of nothing is not a gap. `undefined` on a day with no periods, which leaves
 * the control on the whole day rather than on an empty list.
 */
function momentBounds(
  periods: readonly { startMinutes: number; endMinutes: number }[],
): { minMinutes: number; maxMinutes: number } | undefined {
  const end = dayEndMinutes(periods);
  if (end === undefined) return undefined;
  return {
    minMinutes: Math.min(...periods.map((period) => period.startMinutes)),
    maxMinutes: end - TIME_STEP_MINUTES,
  };
}

/** The payload keys the API validates, mapped onto this form's controls. */
const API_FIELD: Record<string, GapField | undefined> = {
  date: 'date',
  startTime: 'startTime',
  startMinutes: 'startTime',
  durationHours: 'duration',
  durationMinutes: 'duration',
  reason: 'reason',
};
