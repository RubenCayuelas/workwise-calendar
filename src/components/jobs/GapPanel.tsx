'use client';

/**
 * The gap form: date, start, duration, reason. Creates or edits, and deletes.
 *
 * A gap is not a drawing: "Gaps are time: they consume the day's plannable hours
 * exactly like locked work does." Saving one therefore reflows the week, and it can be
 * REFUSED — CLAUDE.md's implementer default is "If the space is held by a locked
 * block, refuse the save with a message naming the block rather than creating an
 * overlap." The server's message already names the first offender; this panel also
 * lists the others from `details.conflicts`, so the owner can unlock everything that
 * is in the way in one pass instead of hitting the same refusal three times.
 *
 * Lunch is deliberately NOT a gap (it is the space between the two shift periods, set
 * in Settings), which `gapForm.lunchNote` says out loud — otherwise the obvious first
 * thing an owner does with this form is recreate the lunch break by hand.
 */

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { IconTrash } from '@tabler/icons-react';
import {
  Button,
  ColorDot,
  ConfirmDialog,
  Field,
  IconButton,
  InlineBanner,
  Input,
  NumberStepper,
  SidePanel,
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
import { useFormat } from '../../lib/useFormat';
import { HOUR_STEP, parseClockTime } from './forms';
import { otherGapConflicts } from './placement';
import type { JobsMutationHandler } from './events';
import styles from './jobs.module.css';

/** One hour: what a breakdown or an errand usually costs. */
const DEFAULT_GAP_MINUTES = 60;
/** Without a `shape` to bound it, a gap may not be longer than half a day. */
const FALLBACK_MAX_HOURS = 12;

export interface GapPanelProps {
  open: boolean;
  /** Omit to create a gap; pass one to edit it. */
  gap?: Gap;
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
}

export function GapPanel({
  open,
  gap,
  onClose,
  onChanged,
  onDeleted,
  defaultDate,
  defaultStartMinutes,
  defaultDurationMinutes,
  shape,
  gapColor,
  today,
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

  const fallbackStart = defaultStartMinutes ?? shape?.periods[0]?.startMinutes ?? 8 * 60;

  useEffect(() => {
    if (!open) {
      // A confirmation must never outlive the panel it belongs to.
      setConfirmOpen(false);
      return;
    }
    setDate(gap?.date ?? defaultDate ?? reference);
    setStartTime(minutesToHHmm(gap?.startMinutes ?? fallbackStart));
    setHours(minutesToHours(gap?.durationMinutes ?? defaultDurationMinutes ?? DEFAULT_GAP_MINUTES));
    setReason(gap?.reason ?? '');
    setLocalError(null);
    setActionError(null);
  }, [open, gap, defaultDate, defaultDurationMinutes, fallbackStart, reference]);

  const maxHours =
    shape === undefined
      ? FALLBACK_MAX_HOURS
      : minutesToHours(shape.timelineEndMinutes - shape.timelineStartMinutes);

  const submit = async (): Promise<void> => {
    if (saving || deleting) return;

    if (!isValidDate(date)) {
      setLocalError({ field: 'date', key: 'errors.invalidDate' });
      return;
    }
    const durationMinutes = hoursToMinutes(hours);
    if (durationMinutes <= 0) {
      setLocalError({ field: 'duration', key: 'errors.invalidDuration' });
      return;
    }
    const startMinutes = parseClockTime(startTime);
    if (startMinutes === undefined || startMinutes + durationMinutes > MINUTES_PER_DAY) {
      setLocalError({ field: 'startTime', key: 'errors.invalidTime' });
      return;
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
        title={t(gap === undefined ? 'gapForm.newTitle' : 'gapForm.editTitle')}
        accent={gapColor === undefined ? undefined : <ColorDot color={gapColor} />}
        footer={
          <>
            <Button className={styles.grow} variant="primary" disabled={busy} onClick={submit}>
              {saving ? t('common.saving') : t('gapForm.submit')}
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

        <Field label={t('gapForm.date')} error={errorFor('date')}>
          <Input
            type="date"
            value={date}
            disabled={busy}
            onChange={(event) => setDate(event.target.value)}
          />
        </Field>

        <div className={styles.row}>
          <Field label={t('gapForm.startTime')} error={errorFor('startTime')}>
            <Input
              type="time"
              value={startTime}
              disabled={busy}
              onChange={(event) => setStartTime(event.target.value)}
            />
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

        <Field label={t('gapForm.reason')} optional error={errorFor('reason')}>
          <Input
            value={reason}
            placeholder={t('gapForm.reasonPlaceholder')}
            disabled={busy}
            onChange={(event) => setReason(event.target.value)}
          />
        </Field>

        <p className={styles.hint}>{t('gapForm.hint')}</p>
        <p className={styles.hint}>{t('gapForm.blockedHint')}</p>
        <p className={styles.hint}>{t('gapForm.lunchNote')}</p>
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

/** The payload keys the API validates, mapped onto this form's controls. */
const API_FIELD: Record<string, GapField | undefined> = {
  date: 'date',
  startTime: 'startTime',
  startMinutes: 'startTime',
  durationHours: 'duration',
  durationMinutes: 'duration',
  reason: 'reason',
};
