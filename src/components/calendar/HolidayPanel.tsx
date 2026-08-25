'use client';

/**
 * The holidays a check found with work already on them. Nothing has been written for these days: the
 * quiet ones were closed silently and these are waiting for an answer.
 *
 * A day whose work carries a padlock is STATED rather than asked about — see `holidayAnswers.ts`.
 */

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { Button, useMounted } from '../ui';
import { useFormat } from '../../lib/useFormat';
import type { PendingHoliday } from '../../lib/api-client';
import { answersFrom, dayIsForced, dayMinutes } from './holidayAnswers';
import styles from './HolidayPanel.module.css';

export interface HolidayPanelProps {
  pending: readonly PendingHoliday[];
  busy?: boolean;
  onSave: (answers: Array<{ date: string; keep: boolean }>) => void;
  /** Closing without answering writes nothing; the next check asks again. */
  onDismiss: () => void;
}

export function HolidayPanel({
  pending,
  busy = false,
  onSave,
  onDismiss,
}: HolidayPanelProps): React.JSX.Element | null {
  const { t } = useTranslation();
  const format = useFormat();
  const mounted = useMounted();
  const dismissRef = useRef<HTMLButtonElement>(null);
  const [chosen, setChosen] = useState<Map<string, boolean>>(new Map());

  const open = pending.length > 0;

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !busy) {
        event.stopPropagation();
        onDismiss();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, busy, onDismiss]);

  // Focus starts on the way OUT, as in every other dialog here: a stray Enter must not save.
  useEffect(() => {
    if (open) dismissRef.current?.focus();
  }, [open]);

  if (!mounted || !open) return null;

  const title = t('holidayPanel.title');

  return createPortal(
    <div className={styles.scrim}>
      <div className={styles.dialog} role="dialog" aria-modal="true" aria-label={title}>
        <h2 className={styles.title}>{title}</h2>
        <p className={styles.description}>{t('holidayPanel.body')}</p>

        <div className={styles.days}>
          {pending.map((day) => {
            const forced = dayIsForced(day.rows);
            const keep = chosen.get(day.date) ?? false;
            return (
              <div key={day.date} className={styles.day}>
                <div className={styles.dayHead}>
                  <span className={styles.dayDate}>{format.mediumDate(day.date)}</span>
                  <span className={styles.dayName}>{day.name}</span>
                </div>

                <p className={styles.work}>
                  {t('holidayPanel.hours', {
                    hours: format.hours(dayMinutes(day.rows)),
                    jobs: day.rows.map((row) => row.name).join(', '),
                  })}
                </p>

                {forced ? (
                  <p className={styles.forced}>{t('holidayPanel.fixed')}</p>
                ) : (
                  <div className={styles.choices}>
                    <label className={styles.choice}>
                      <input
                        type="radio"
                        name={`holiday-${day.date}`}
                        checked={!keep}
                        disabled={busy}
                        onChange={() => setChosen((current) => next(current, day.date, false))}
                      />
                      {t('holidayPanel.displace')}
                    </label>
                    <label className={styles.choice}>
                      <input
                        type="radio"
                        name={`holiday-${day.date}`}
                        checked={keep}
                        disabled={busy}
                        onChange={() => setChosen((current) => next(current, day.date, true))}
                      />
                      {t('holidayPanel.keep')}
                      <span className={styles.choiceHint}>{t('holidayPanel.keepHint')}</span>
                    </label>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <div className={styles.actions}>
          <Button ref={dismissRef} variant="secondary" onClick={onDismiss} disabled={busy}>
            {t('common.cancel')}
          </Button>
          <Button onClick={() => onSave(answersFrom(pending, chosen))} disabled={busy}>
            {t('holidayPanel.save')}
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function next(current: Map<string, boolean>, date: string, keep: boolean): Map<string, boolean> {
  const updated = new Map(current);
  updated.set(date, keep);
  return updated;
}
