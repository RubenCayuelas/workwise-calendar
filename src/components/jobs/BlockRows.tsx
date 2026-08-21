'use client';

/**
 * `Bloques · 11 h en 4 stretches` and the rows under it: display plus one padlock toggle, and the
 * only place a row in another week can be unlocked.
 */

import { useTranslation } from 'react-i18next';
import { IconLock, IconLockOpen, IconScissors } from '@tabler/icons-react';
import { IconButton } from '../ui';
import { useFormat } from '../../lib/useFormat';
import { FRIDAY, compareDates, weekdayOf } from '../../lib/dates';
import { sumMinutes } from './placement';
import type { Block } from '../../types';
import styles from './jobs.module.css';

export interface BlockRowsProps {
  /** Every row of ONE job, any week. Sorted here, so the caller need not. */
  blocks: readonly Block[];
  /** The shop's local today, from `WeekView.today`. Dims the frozen past. */
  today?: string;
  /** Toggles the padlock. Omit to render the state read-only, as a PAST row always is. */
  onToggleLock?: (block: Block) => void;
  /** Adds the scissors to each row. Never drawn on a past row. */
  onSplit?: (block: Block) => void;
  /** The row with a request in flight: its buttons lock. */
  busyBlockId?: string | null;
  disabled?: boolean;
}

export function BlockRows({
  blocks,
  today,
  onToggleLock,
  onSplit,
  busyBlockId = null,
  disabled = false,
}: BlockRowsProps): React.JSX.Element {
  const { t } = useTranslation();
  const format = useFormat();

  const ordered = [...blocks].sort(
    (a, b) => compareDates(a.date, b.date) || a.startMinutes - b.startMinutes,
  );
  const totalMinutes = sumMinutes(ordered);

  return (
    <section className={styles.section}>
      <p className={styles.sectionTitle}>
        {t('jobPanel.blocks', { count: ordered.length, hours: format.hourNumber(totalMinutes) })}
      </p>

      {ordered.length === 0 ? (
        <p className={styles.empty}>{t('jobPanel.noBlocks')}</p>
      ) : (
        <ul className={styles.blockList}>
          {ordered.map((block) => {
            const isPast = today !== undefined && compareDates(block.date, today) < 0;
            const busy = busyBlockId === block.id;
            const tag = tagOf(block, today);

            return (
              <li
                key={block.id}
                className={[styles.blockRow, isPast ? styles.blockRowPast : ''].filter(Boolean).join(' ')}
              >
                <span className={styles.blockWhen}>
                  {format.dayTime(block.date, block.startMinutes, block.startMinutes + block.durationMinutes)}
                </span>

                <span className={styles.blockHours}>{format.hours(block.durationMinutes)}</span>

                {tag === undefined ? null : <span className={styles.blockTag}>{t(tag)}</span>}

                {/* Absent on a past row, not disabled: a control only ever answered with a
                    refusal is worse than no control. */}
                {onSplit === undefined || isPast ? null : (
                  <IconButton
                    size="sm"
                    variant="ghost"
                    icon={<IconScissors size={15} stroke={1.75} />}
                    label={t('block.split')}
                    disabled={disabled || busy}
                    onClick={() => onSplit(block)}
                  />
                )}

                {onToggleLock === undefined || isPast ? (
                  <span
                    className={styles.blockTag}
                    aria-label={t(block.locked ? 'block.locked' : 'block.unlocked')}
                    title={t(block.locked ? 'block.locked' : 'block.unlocked')}
                  >
                    {block.locked ? (
                      <IconLock size={15} stroke={1.75} />
                    ) : (
                      <IconLockOpen size={15} stroke={1.75} />
                    )}
                  </span>
                ) : (
                  <IconButton
                    size="sm"
                    variant="ghost"
                    active={block.locked}
                    icon={
                      block.locked ? (
                        <IconLock size={15} stroke={1.75} />
                      ) : (
                        <IconLockOpen size={15} stroke={1.75} />
                      )
                    }
                    // The label names the ACTION, the icon shows the state.
                    label={t(block.locked ? 'block.unlock' : 'block.lock')}
                    disabled={disabled || busy}
                    onClick={() => onToggleLock(block)}
                  />
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/**
 * The one word a row is worth annotating with, in the day header's own vocabulary. The
 * frozen past first (it explains the dimming), then the Friday buffer, then today.
 */
function tagOf(block: Block, today: string | undefined): string | undefined {
  if (today !== undefined && compareDates(block.date, today) < 0) return 'day.frozen';
  if (weekdayOf(block.date) === FRIDAY) return 'day.buffer';
  if (today !== undefined && block.date === today) return 'day.today';
  return undefined;
}
