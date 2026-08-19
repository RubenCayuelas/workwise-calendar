'use client';

/**
 * The scissors: a form rather than a gesture, because only a form can choose an AMOUNT. The
 * fragment then goes back to the calendar for its drop.
 */

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { IconScissors } from '@tabler/icons-react';
import {
  Button,
  ColorDot,
  DateSelect,
  Field,
  InlineBanner,
  NumberStepper,
  SidePanel,
  TimeSelect,
} from '../ui';
import {
  apiErrorMessage,
  getProject,
  isAbortError,
  splitBlock,
  type Block,
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
import { HOUR_STEP as STEP_HOURS, parseClockTime } from './forms';
import type { JobsMutationHandler } from './events';
import styles from './jobs.module.css';

export interface SplitResult {
  /**
   * The row the split created, or `null` when auto-merge absorbed it into a neighbouring row
   * of the same job — or when the job's rows could not be read before the split.
   */
  fragment: Block | null;
  /** The row that was cut, re-read after the reflow. `null` if it was merged away. */
  source: Block | null;
  /** Every row of the job after the split, in queue order. */
  blocks: Block[];
}

export interface SplitBlockPanelProps {
  open: boolean;
  /** The row being cut. */
  block: Block;
  /** Name and colour for the header — `WeekBlock.project` fits as-is. */
  project?: { id: string; name: string; color: string };
  onClose: () => void;
  /** Fired on success. The parent MUST refetch the week. */
  onChanged?: JobsMutationHandler;
  /** The fragment, for a parent that wants to start dragging it immediately. */
  onSplit?: (result: SplitResult) => void;
  /** Where the fragment is sent. Defaults to the source row's own day and time. */
  defaultDate?: string;
  defaultStartMinutes?: number;
  /** The shop's local today, from the server. Anchors the day picker's window. */
  today?: string;
  /** `settings.planningHorizonWeeks`: how far ahead the day picker reaches. */
  horizonWeeks?: number;
}

export function SplitBlockPanel({
  open,
  block,
  project,
  onClose,
  onChanged,
  onSplit,
  defaultDate,
  defaultStartMinutes,
  today,
  horizonWeeks,
}: SplitBlockPanelProps): React.JSX.Element {
  const { t } = useTranslation();
  const format = useFormat();
  const reference = today ?? todayLocal();

  const blockHours = minutesToHours(block.durationMinutes);
  const maxHours = Math.max(STEP_HOURS, blockHours - STEP_HOURS);

  const [hours, setHours] = useState(() => defaultSplitHours(blockHours));
  const [date, setDate] = useState(defaultDate ?? block.date);
  const [startTime, setStartTime] = useState(minutesToHHmm(defaultStartMinutes ?? block.startMinutes));
  const [localError, setLocalError] = useState<{ field: SplitField; key: string } | null>(null);
  const [actionError, setActionError] = useState<unknown>(null);
  const [saving, setSaving] = useState(false);
  /** The job's row ids before the split, which is how the fragment is recognised. */
  const [knownBlockIds, setKnownBlockIds] = useState<Set<string> | null>(null);

  useEffect(() => {
    if (!open) return;
    setHours(defaultSplitHours(blockHours));
    setDate(defaultDate ?? block.date);
    setStartTime(minutesToHHmm(defaultStartMinutes ?? block.startMinutes));
    setLocalError(null);
    setActionError(null);
  }, [open, block.id, block.date, block.startMinutes, blockHours, defaultDate, defaultStartMinutes]);

  // Read the job's rows so the new one can be told apart afterwards. A missing list only
  // costs `onSplit` its fragment; the split itself does not depend on it.
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setKnownBlockIds(null);

    getProject(block.projectId, { signal: controller.signal })
      .then((detail) => {
        if (controller.signal.aborted) return;
        setKnownBlockIds(new Set(detail.blocks.map((row) => row.id)));
      })
      .catch((error: unknown) => {
        if (!isAbortError(error)) setKnownBlockIds(null);
      });

    return () => controller.abort();
  }, [open, block.projectId]);

  const submit = async (): Promise<void> => {
    if (saving) return;

    const durationMinutes = hoursToMinutes(hours);
    if (durationMinutes <= 0 || durationMinutes >= block.durationMinutes) {
      setLocalError({ field: 'hours', key: 'errors.splitExceedsBlock' });
      return;
    }
    if (!isValidDate(date)) {
      setLocalError({ field: 'date', key: 'errors.invalidDate' });
      return;
    }
    const startMinutes = parseClockTime(startTime);
    if (startMinutes === undefined || startMinutes + durationMinutes > MINUTES_PER_DAY) {
      setLocalError({ field: 'startTime', key: 'errors.invalidTime' });
      return;
    }

    setSaving(true);
    setLocalError(null);
    setActionError(null);

    try {
      const result = await splitBlock(block.id, { durationMinutes, date, startMinutes });
      const fragment =
        knownBlockIds === null
          ? null
          : (result.blocks.find((row) => !knownBlockIds.has(row.id)) ?? null);

      onChanged?.({
        kind: 'block-split',
        projectId: block.projectId,
        blockId: block.id,
        summary: result.summary,
      });
      onSplit?.({ fragment, source: result.block, blocks: result.blocks });
      onClose();
    } catch (error) {
      setActionError(error);
    } finally {
      setSaving(false);
    }
  };

  const actionMessage =
    actionError === null ? undefined : apiErrorMessage(actionError, t, format.language);
  const errorFor = (field: SplitField): string | undefined =>
    localError?.field === field ? t(localError.key) : undefined;

  return (
    <SidePanel
      open={open}
      onClose={onClose}
      title={t('block.splitTitle')}
      accent={project === undefined ? undefined : <ColorDot color={project.color} />}
      footer={
        <>
          <Button
            className={styles.grow}
            variant="primary"
            icon={<IconScissors size={15} stroke={1.75} />}
            disabled={saving}
            onClick={submit}
          >
            {saving ? t('common.saving') : t('block.splitConfirm')}
          </Button>
          <Button variant="secondary" disabled={saving} onClick={onClose}>
            {t('common.cancel')}
          </Button>
        </>
      }
    >
      {actionMessage === undefined ? null : (
        <InlineBanner tone="error" title={t('errors.title')} onDismiss={() => setActionError(null)}>
          {actionMessage}
        </InlineBanner>
      )}

      {/* What is being cut, so the amount below has something to be a portion OF. */}
      <div className={styles.context}>
        {project === undefined ? null : <span className={styles.contextLabel}>{project.name}</span>}
        <span className={styles.contextValue}>
          {format.dayTimeHours(block.date, block.startMinutes, block.durationMinutes)}
        </span>
      </div>

      <Field label={t('block.splitHours')} error={errorFor('hours')}>
        <NumberStepper
          value={hours}
          min={STEP_HOURS}
          max={maxHours}
          step={STEP_HOURS}
          suffix={t('units.hoursSuffix')}
          disabled={saving}
          onChange={setHours}
        />
      </Field>

      <div className={styles.row}>
        {/* Never a native date input. The row's own day is
            always offered, however old it is. */}
        <Field
          label={t('gapForm.date')}
          error={errorFor('date')}
          hint={isValidDate(date) ? format.longDate(date) : undefined}
        >
          <DateSelect
            value={date}
            today={reference}
            horizonWeeks={horizonWeeks}
            disabled={saving}
            onChange={setDate}
          />
        </Field>

        {/* Quarter hours, like the grid's snap. */}
        <Field label={t('gapForm.startTime')} error={errorFor('startTime')}>
          <TimeSelect value={startTime} disabled={saving} onChange={setStartTime} />
        </Field>
      </div>

      <p className={styles.hint}>{t('block.splitHint')}</p>
    </SidePanel>
  );
}

type SplitField = 'hours' | 'date' | 'startTime';

/** Half the row, snapped to the step and kept strictly inside it. */
function defaultSplitHours(blockHours: number): number {
  const half = Math.round(blockHours / 2 / STEP_HOURS) * STEP_HOURS;
  const most = Math.max(STEP_HOURS, blockHours - STEP_HOURS);
  return Math.min(Math.max(half, STEP_HOURS), most);
}
