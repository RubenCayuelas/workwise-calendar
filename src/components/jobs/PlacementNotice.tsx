'use client';

/** Where the hours actually went after a write: `describePlacement`'s diff, rendered. */

import { useTranslation } from 'react-i18next';
import { InlineBanner } from '../ui';
import { useFormat, type Formatter } from '../../lib/useFormat';
import {
  placementHighlights,
  placementTone,
  type PlacementChange,
  type PlacementOutcome,
} from './placement';
import styles from './jobs.module.css';

export interface PlacementNoticeProps {
  outcome: PlacementOutcome;
  /** The headline, already translated: `jobPanel.saved`, `jobForm.created`. */
  title?: string;
  /** From the mutation response. Rendered as its own warning. */
  touchedLockedBlockIds?: readonly string[];
  onDismiss?: () => void;
}

export function PlacementNotice({
  outcome,
  title,
  touchedLockedBlockIds = [],
  onDismiss,
}: PlacementNoticeProps): React.JSX.Element {
  const { t } = useTranslation();

  const rows = placementHighlights(outcome);
  const detailed = rows.length > 0;

  return (
    <div className={styles.notices}>
      <InlineBanner
        tone={placementTone(outcome)}
        title={detailed ? title : undefined}
        onDismiss={onDismiss}
      >
        {detailed ? (
          <>
            <PlacementLines rows={rows} />
            {outcome.usedBuffer ? <span className={styles.hint}>{t('day.bufferHint')}</span> : null}
          </>
        ) : (
          (title ?? t('common.saved'))
        )}
      </InlineBanner>

      {touchedLockedBlockIds.length > 0 ? (
        <InlineBanner tone="warning">
          {t('notices.touchedLockedBlocks', { count: touchedLockedBlockIds.length })}
        </InlineBanner>
      ) : null}
    </div>
  );
}

/** The rows themselves, for a banner that is not this one — the creation's toast lists the same lines. */
export function PlacementLines({ rows }: { rows: readonly PlacementChange[] }): React.JSX.Element {
  const { t } = useTranslation();
  const format = useFormat();

  return (
    <span className={styles.noticeList}>
      {rows.map((change) => (
        <span key={change.block.id} className={styles.noticeLine}>
          <span className={styles.noticeLabel}>{placementLabel(change, format, t)}</span>
          {change.isBuffer ? <span className={styles.blockTag}>{t('day.buffer')}</span> : null}
        </span>
      ))}
    </span>
  );
}

/** `Mié 12 · 08:00–14:00 · 6 h`, or the full date when the row slipped to a later week. */
function placementLabel(
  change: PlacementChange,
  format: Formatter,
  t: (key: string, values?: Record<string, unknown>) => string,
): string {
  const { date, startMinutes, durationMinutes } = change.block;
  if (!change.isLaterWeek) return format.dayTimeHours(date, startMinutes, durationMinutes);

  return t('units.dayTimeHours', {
    day: format.mediumDate(date),
    start: format.time(startMinutes),
    end: format.time(startMinutes + durationMinutes),
    hours: format.hourNumber(durationMinutes),
  });
}
