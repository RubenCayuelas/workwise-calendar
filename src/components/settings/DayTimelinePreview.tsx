'use client';

/**
 * The day diagram, drawn from the DRAFT: proportional bands, updating on every
 * keystroke, with the auto-fill stop line on the period it falls in.
 */

import { useTranslation } from 'react-i18next';
import { hoursToMinutes } from '../../lib/dates';
import { useFormat } from '../../lib/useFormat';
import type { Settings } from '../../types';
import { autoFillStopMinutes, periodsOf, shiftMinutesOf, timelineOf } from './shift';
import styles from './DayTimelinePreview.module.css';

type BandKind = 'margin' | 'work' | 'lunch';

interface Band {
  kind: BandKind;
  key: string;
  label: string;
  startMinutes: number;
  endMinutes: number;
}

export interface DayTimelinePreviewProps {
  settings: Settings;
}

export function DayTimelinePreview({ settings }: DayTimelinePreviewProps): React.JSX.Element | null {
  const { t } = useTranslation();
  const format = useFormat();

  const periods = periodsOf(settings);
  const timeline = timelineOf(settings);
  // A period mid-retype: the caller shows the invalid notice instead.
  if (timeline === undefined || periods.length === 0) return null;

  const bands = buildBands(settings, t);
  const shiftMinutes = shiftMinutesOf(settings);
  const stopMinutes = autoFillStopMinutes(settings);
  // At full capacity the line would sit on the last period's end and read as noise.
  const showStop =
    stopMinutes !== undefined &&
    hoursToMinutes(settings.defaultDayCapacity) < shiftMinutes &&
    stopMinutes < periods[periods.length - 1].endMinutes;

  return (
    <div className={styles.preview}>
      <ul className={styles.timeline}>
        {bands.map((band) => {
          const minutes = band.endMinutes - band.startMinutes;
          const stopInside =
            showStop &&
            band.kind === 'work' &&
            stopMinutes !== undefined &&
            stopMinutes > band.startMinutes &&
            stopMinutes < band.endMinutes;

          return (
            <li
              key={band.key}
              className={[styles.band, styles[band.kind]].join(' ')}
              style={{ flexGrow: minutes }}
            >
              <span className={`${styles.bandTime} ww-tabular`}>{format.time(band.startMinutes)}</span>
              <span className={styles.bandLabel}>{band.label}</span>
              <span className={`${styles.bandHours} ww-tabular`}>{format.hours(minutes)}</span>

              {stopInside && stopMinutes !== undefined ? (
                <span
                  className={styles.stop}
                  style={{ top: `${((stopMinutes - band.startMinutes) / minutes) * 100}%` }}
                >
                  <span className={styles.stopLabel}>
                    <span>{t('settings.capacitySection')}</span>
                    <span className="ww-tabular">{format.time(stopMinutes)}</span>
                  </span>
                </span>
              ) : null}
            </li>
          );
        })}
      </ul>

      <p className={`${styles.end} ww-tabular`}>{format.time(timeline.endMinutes)}</p>

      <p className={styles.caption}>
        {t('settings.timelinePreview', {
          start: format.time(timeline.startMinutes),
          end: format.time(timeline.endMinutes),
        })}
      </p>
      <p className={styles.caption}>
        {t('settings.shiftTotal', { hours: format.hourNumber(shiftMinutes) })}
      </p>
      {/* Deliberately the same wording as the grid's own grey-band legend. */}
      <p className={styles.caption}>{t('grid.bandsLegend')}</p>
    </div>
  );
}

function buildBands(
  settings: Settings,
  t: (key: string, values?: Record<string, unknown>) => string,
): Band[] {
  const periods = periodsOf(settings);
  const timeline = timelineOf(settings);
  if (timeline === undefined || periods.length === 0) return [];

  const bands: Band[] = [];

  push(bands, {
    kind: 'margin',
    key: 'margin-top',
    label: t('grid.marginBand'),
    startMinutes: timeline.startMinutes,
    endMinutes: periods[0].startMinutes,
  });

  periods.forEach((period, index) => {
    push(bands, {
      kind: 'work',
      key: `period-${index}`,
      label: index === 0 ? t('settings.period1') : t('settings.period2'),
      startMinutes: period.startMinutes,
      endMinutes: period.endMinutes,
    });

    const next = periods[index + 1];
    if (next !== undefined) {
      push(bands, {
        kind: 'lunch',
        key: `lunch-${index}`,
        label: t('grid.lunchBand'),
        startMinutes: period.endMinutes,
        endMinutes: next.startMinutes,
      });
    }
  });

  push(bands, {
    kind: 'margin',
    key: 'margin-bottom',
    label: t('grid.marginBand'),
    startMinutes: periods[periods.length - 1].endMinutes,
    endMinutes: timeline.endMinutes,
  });

  return bands;
}

/** Drops empty bands: a 0 h margin, or an afternoon that starts the moment lunch would. */
function push(bands: Band[], band: Band): void {
  if (band.endMinutes > band.startMinutes) bands.push(band);
}
