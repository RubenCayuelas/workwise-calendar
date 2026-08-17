'use client';

/**
 * "Taller ocupado hasta el jueves 27 de agosto · 96 h en cola · viernes libre".
 *
 * The app's stated objective in one line — how long the workshop is booked for and what
 * is still free — so it is not decoration. `composition.ts` owns the arithmetic (last
 * occupied date across ALL weeks, minutes queued, whether the buffer Friday is clear);
 * this picks the sentence that fits those numbers.
 *
 * Four sentences, not one with holes in it: a booked shop and an empty one read
 * differently, and so does a Friday that has already taken overflow — which is the case
 * the owner most needs to notice, because the buffer is what absorbs the next surprise.
 *
 * A fifth clause hangs off the end, and only when it is true: an auto-fill capacity BELOW
 * the shift. "Why is my afternoon empty" is a question about the week, so the week is
 * where the answer belongs — see `capacityNoticeMessage`.
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

  // ONE implementation of the sentence, shared with the create-job form, which shows
  // the same line as its answer to "where will this job land". Rendering both screens
  // is how the two copies were caught having drifted apart.
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
