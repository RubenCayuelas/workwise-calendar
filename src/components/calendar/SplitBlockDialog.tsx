'use client';

/**
 * The scissors, step one: how many hours leave this row.
 *
 * Step two is a click on the grid, because a split is a MOVE of a portion — the API
 * takes a date and a rank for the fragment, and inventing one here would park those
 * hours somewhere the owner did not ask for. Worse, a fragment dropped right next to
 * its source is auto-merged straight back into it ("auto-merge joins two blocks of the
 * same job when they touch inside the same period on the same day"), so a split with an
 * implicit target would silently do nothing.
 *
 * The hint says what happens next: the fragment takes a queue position and settles; lock
 * it to nail it down.
 */

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ConfirmDialog, NumberStepper } from '../ui';
import { hoursToMinutes, minutesToHours } from '../../lib/dates';
import { useFormat } from '../../lib/useFormat';
import type { WeekBlock } from '../../lib/api-client';

/** The stepper's increment, and therefore the smallest fragment: half an hour. */
const STEP_HOURS = 0.5;

/** Below this a fragment plus a remainder cannot both exist at that step. */
export const MIN_SPLITTABLE_MINUTES = 60;

export interface SplitBlockDialogProps {
  block: WeekBlock | null;
  onCancel: () => void;
  /** The portion that leaves the row. The screen then asks where it goes. */
  onConfirm: (durationMinutes: number) => void;
}

export function SplitBlockDialog({
  block,
  onCancel,
  onConfirm,
}: SplitBlockDialogProps): React.JSX.Element | null {
  const { t } = useTranslation();
  const format = useFormat();
  const [hours, setHours] = useState(STEP_HOURS);

  const total = block === null ? 0 : minutesToHours(block.durationMinutes);
  const max = Math.max(STEP_HOURS, total - STEP_HOURS);

  useEffect(() => {
    if (block === null) return;
    // Half the row, on the step: the most common cut, and always inside the bounds.
    const half = Math.round(minutesToHours(block.durationMinutes) / 2 / STEP_HOURS) * STEP_HOURS;
    setHours(Math.min(Math.max(half, STEP_HOURS), Math.max(STEP_HOURS, minutesToHours(block.durationMinutes) - STEP_HOURS)));
  }, [block]);

  if (block === null) return null;

  return (
    <ConfirmDialog
      open
      danger={false}
      title={t('block.splitTitle')}
      confirmLabel={t('block.splitConfirm')}
      onCancel={onCancel}
      onConfirm={() => onConfirm(hoursToMinutes(hours))}
      description={
        <>
          <label htmlFor="ww-split-hours">{t('block.splitHours')}</label>{' '}
          <NumberStepper
            id="ww-split-hours"
            value={hours}
            min={STEP_HOURS}
            max={max}
            step={STEP_HOURS}
            suffix={t('units.hoursSuffix')}
            onChange={setHours}
          />{' '}
          <span className="ww-muted">
            {format.dayTimeHours(block.date, block.startMinutes, block.durationMinutes)}
          </span>
          <br />
          <span className="ww-small ww-muted">{t('block.splitHint')}</span>
        </>
      }
    />
  );
}
