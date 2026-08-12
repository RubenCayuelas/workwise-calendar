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
 * This is also the only place a HAND-SET length can be released on a row that is not in
 * the week on screen — the panel lists every row of the job, across every week, and a
 * hand-set row is one the engine has stopped re-laying out, so it can sit weeks away
 * holding a day open.
 *
 * The list is display + two toggles. The requests belong to the panel, which owns the
 * refetch and the error banner.
 */

import { useTranslation } from 'react-i18next';
import { IconLock, IconLockOpen, IconRuler, IconRulerOff, IconScissors } from '@tabler/icons-react';
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
  /** Toggles the padlock. Omit to render the state read-only. */
  onToggleLock?: (block: Block) => void;
  /**
   * "Back to automatic" on a row whose length was set by hand. Omit to render the mark
   * without its undo — the mark itself is always shown, since a row that has stopped
   * reflowing must never be a silent state.
   */
  onReleaseDuration?: (block: Block) => void;
  /** Adds the scissors to each row. The panel is the only way to reach another week's rows. */
  onSplit?: (block: Block) => void;
  /** The row with a request in flight: its buttons lock. */
  busyBlockId?: string | null;
  disabled?: boolean;
}

export function BlockRows({
  blocks,
  today,
  onToggleLock,
  onReleaseDuration,
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
                 * The hand-set length. Shown either way: with the release action when
                 * the panel wired one, and as a plain mark when it did not, because the
                 * whole point of the mark is that the row's stillness has a reason.
                 */}
                {!block.manualDuration ? null : onReleaseDuration === undefined ? (
                  <span
                    className={styles.blockTag}
                    aria-label={t('block.manualDuration')}
                    title={t('block.manualDurationHint')}
                  >
                    <IconRuler size={15} stroke={1.75} />
                  </span>
                ) : (
                  <IconButton
                    size="sm"
                    variant="ghost"
                    active
                    icon={<IconRulerOff size={15} stroke={1.75} />}
                    label={t('block.releaseDuration')}
                    disabled={disabled || busy}
                    onClick={() => onReleaseDuration(block)}
                  />
                )}

                {onSplit === undefined ? null : (
                  <IconButton
                    size="sm"
                    variant="ghost"
                    icon={<IconScissors size={15} stroke={1.75} />}
                    label={t('block.split')}
                    disabled={disabled || busy}
                    onClick={() => onSplit(block)}
                  />
                )}

                {onToggleLock === undefined ? (
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
