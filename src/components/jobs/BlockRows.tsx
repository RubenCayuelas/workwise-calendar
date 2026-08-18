'use client';

/**
 * `Bloques · 11 h en 4 tramos` and the rows under it.
 *
 * Straight from the wireframe: one row per block, `Mié 12 · 08:00–14:00` on the left,
 * its hours next to it, and a padlock that toggles `locked`.
 *
 * THE TWO ROWS AROUND LUNCH ARE NOT A BUG. CLAUDE.md: "Work crossing the lunch break
 * is stored as two blocks of the same job", and the wireframe deliberately lists
 * `Mar 11 · 13:00–14:00` and `Mar 11 · 15:30–17:30` separately. Nothing here merges
 * them — the calendar draws them as one grouped unit, the panel tells the truth about
 * the rows.
 *
 * ONE MARK REACHES THIS LIST — the PADLOCK (`locked`) — and it is pressed off with the
 * padlock button beside it. A drop onto the buffer, the weekend or a margin sets it, so
 * this list is where a row weeks away can be handed back to the engine: the calendar only
 * shows the week on screen. A ruler for a hand-set LENGTH, and *back to automatic* beside
 * it, stood here until 2026-08-18; both went with `manual_duration`, since the padlock now
 * fixes a row's length as well as its position.
 *
 * A PAST ROW IS DIMMED AND SHOWS ITS PADLOCK AS A STATE, WITHOUT THE BUTTON. The past is
 * read-only to the block gestures, so the padlock and the scissors are refused there and
 * are not drawn. Nothing is stranded by that: a padlock on a past row changes nothing the
 * engine reads, since `isMovable` asks the date before it asks the flag.
 *
 * The list is display + one toggle. The requests belong to the panel, which owns the
 * refetch and the error banner.
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
  /**
   * Toggles the padlock. Omit to render the state read-only — as a PAST row always is,
   * whatever is passed, because the gesture is refused there.
   */
  onToggleLock?: (block: Block) => void;
  /**
   * Adds the scissors to each row. The panel is the only way to reach another week's rows.
   * Never drawn on a past row: the past is read-only to the block gestures.
   */
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

                {/*
                 * THE SCISSORS AND THE PADLOCK ARE ABSENT ON A PAST ROW, not disabled: the
                 * past is read-only to the block gestures (decided 2026-08-13), so both are
                 * refused by the server — `split-on-past-day` and a padlock that would
                 * change nothing, since `isMovable` asks the date before it asks the flag.
                 * A control that is only ever answered with a refusal is worse than no
                 * control, and a row already carries its state in the read-only padlock
                 * below.
                 */}
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
                    // The label names the ACTION, the icon shows the state — an
                    // icon-only toggle labelled with its state reads backwards.
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
 * The one word a row is worth annotating with, in the day header's own vocabulary.
 *
 * The frozen past first (it explains why the row is dimmed), then the Friday colchón
 * (it explains why hours are sitting there at all), then today.
 */
function tagOf(block: Block, today: string | undefined): string | undefined {
  if (today !== undefined && compareDates(block.date, today) < 0) return 'day.frozen';
  if (weekdayOf(block.date) === FRIDAY) return 'day.buffer';
  if (today !== undefined && block.date === today) return 'day.today';
  return undefined;
}
