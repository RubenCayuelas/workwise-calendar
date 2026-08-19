'use client';

/**
 * "Taller ocupado hasta el jueves 27 de agosto · 96 h en cola · viernes libre", plus the
 * capacity clause when auto-fill stops below the shift.
 */

import { useTranslation } from 'react-i18next';
import { IconClock } from '@tabler/icons-react';
import { useFormat } from '../../lib/useFormat';
import { capacityNoticeMessage, scheduleSummaryMessage } from '../jobs/summary';
import type { ScheduleSummary } from '../../lib/api-client';
import type { DayShape } from '../../types';
import styles from './SummaryStrip.module.css';

export interface SummaryStripProps {
  /** `null` while the first week loads. */
  summary: ScheduleSummary | null;
  /** The day's minutes, for the capacity clause. `null` while the first week loads. */
  shape?: DayShape | null;
}

export function SummaryStrip({ summary, shape = null }: SummaryStripProps): React.JSX.Element {
  const { t } = useTranslation();
  const format = useFormat();

  // Shared with the create-job form so the two screens cannot word it differently.
  const text = summary === null ? t('summary.loading') : scheduleSummaryMessage(summary, t, format);
  const capacity = shape === null ? undefined : capacityNoticeMessage(shape, t, format);

  return (
    <div
      className={[styles.strip, summary === null ? styles.loading : ''].filter(Boolean).join(' ')}
      role="status"
      aria-label={t('summary.label')}
      title={t('summary.bufferHint')}
    >
      <span className={styles.glyph} aria-hidden="true">
        <IconClock size={17} stroke={1.75} />
      </span>
      <span className={styles.text}>{text}</span>
      {capacity === undefined ? null : (
        <span className={styles.capacity} title={t('settings.defaultDayCapacity')}>
          {capacity}
        </span>
      )}
    </div>
  );
}
