'use client';

/**
 * `src/lib/format.ts` with the current language and `t` already bound.
 *
 * This is what a component should use. It exists so that "Mié 12 · 08:00–14:00 · 6 h"
 * is assembled in exactly one place: the calendar grid, the job panel's block list
 * and the confirmation dialogs all show that shape, and three screens formatting it
 * separately would drift on the separator, the capitalisation and the decimal comma.
 *
 * Every label goes through a locale key — the punctuation between the parts ("·",
 * "–", where " h" sits) is part of the translation, not of the code.
 */

import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import {
  formatHourNumber,
  formatLongDate,
  formatMediumDate,
  formatMonthShort,
  formatDayOfMonth,
  formatTime,
  formatWeekdayLong,
  formatWeekdayShort,
  weekRangeLabel,
} from './format';
import { DEFAULT_LANGUAGE, intlLocaleOf, isLanguage, type Language } from './i18n';

export interface Formatter {
  /** The UI language in use. */
  language: Language;
  /** The BCP 47 tag behind it, for a component that needs its own `Intl` call. */
  locale: string;

  /** "6 h" / "2,5 h". `minutes` is the domain's integer minutes. */
  hours(minutes: number): string;
  /** Just the number: "6", "2,5". Use when the unit is already on screen. */
  hourNumber(minutes: number): string;
  /** "08:00" */
  time(minutes: number): string;
  /** "08:00–14:00" */
  timeRange(startMinutes: number, endMinutes: number): string;

  /** "Mié" */
  weekdayShort(date: string): string;
  /** "miércoles" */
  weekdayLong(date: string): string;
  /** "12" */
  dayOfMonth(date: string): string;
  /** "ago" */
  monthShort(date: string): string;
  /** The day-header label: "Mié 12". */
  dayHeader(date: string): string;
  /** "jueves 27 de agosto" — for prose such as the summary strip. */
  longDate(date: string): string;
  /** "27 ago 2026" — for lists and confirmations. */
  mediumDate(date: string): string;

  /** "Mié 12 · 08:00–14:00" — the job panel's block rows. */
  dayTime(date: string, startMinutes: number, endMinutes: number): string;
  /** "Mié 12 · 08:00–14:00 · 6 h" — the same row with its duration. */
  dayTimeHours(date: string, startMinutes: number, durationMinutes: number): string;

  /** "10–16 ago 2026" */
  weekRange(startDate: string, endDate: string): string;
  /** "Semana 33 · 10–16 ago 2026" — the whole header label. */
  weekLabel(isoWeek: number, startDate: string, endDate: string): string;
}

export function useFormat(): Formatter {
  const { t, i18n } = useTranslation();
  const resolved = i18n.resolvedLanguage ?? i18n.language;
  const language = isLanguage(resolved) ? resolved : DEFAULT_LANGUAGE;

  return useMemo<Formatter>(() => {
    const hourNumber = (minutes: number): string => formatHourNumber(minutes, language);
    const timeRange = (startMinutes: number, endMinutes: number): string =>
      t('units.timeRange', { start: formatTime(startMinutes), end: formatTime(endMinutes) });
    const dayHeader = (date: string): string =>
      t('day.header', {
        weekday: formatWeekdayShort(date, language),
        day: formatDayOfMonth(date),
      });
    const weekRange = (startDate: string, endDate: string): string => {
      const label = weekRangeLabel(startDate, endDate, language);
      return t(label.key, label.values);
    };

    return {
      language,
      locale: intlLocaleOf(language),

      hours: (minutes) => t('units.hours', { hours: hourNumber(minutes) }),
      hourNumber,
      time: formatTime,
      timeRange,

      weekdayShort: (date) => formatWeekdayShort(date, language),
      weekdayLong: (date) => formatWeekdayLong(date, language),
      dayOfMonth: formatDayOfMonth,
      monthShort: (date) => formatMonthShort(date, language),
      dayHeader,
      longDate: (date) => formatLongDate(date, language),
      mediumDate: (date) => formatMediumDate(date, language),

      dayTime: (date, startMinutes, endMinutes) =>
        t('units.dayTime', {
          day: dayHeader(date),
          start: formatTime(startMinutes),
          end: formatTime(endMinutes),
        }),
      dayTimeHours: (date, startMinutes, durationMinutes) =>
        t('units.dayTimeHours', {
          day: dayHeader(date),
          start: formatTime(startMinutes),
          end: formatTime(startMinutes + durationMinutes),
          hours: hourNumber(durationMinutes),
        }),

      weekRange,
      weekLabel: (isoWeek, startDate, endDate) =>
        t('header.week', { week: isoWeek, range: weekRange(startDate, endDate) }),
    };
  }, [t, language]);
}
