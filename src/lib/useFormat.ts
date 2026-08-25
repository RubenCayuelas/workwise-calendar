'use client';

/**
 * `src/lib/format.ts` with the current language and `t` already bound — the one place
 * "Mié 12 · 08:00–14:00 · 6 h" is assembled, so the grid, the job panel and the dialogs
 * cannot drift on the separator, the capitalisation or the decimal comma. The punctuation
 * between the parts belongs to the locale key, not to the code.
 */

import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { isoWeekNumber } from './dates';
import {
  formatHourNumber,
  formatLongDate,
  formatMediumDate,
  formatMonthShort,
  formatMonthYear,
  formatDayOfMonth,
  formatTime,
  formatWeekdayLong,
  formatWeekdayNarrow,
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
  /** "L" — the single letter a month grid heads its columns with. */
  weekdayNarrow(date: string): string;
  /** "miércoles" */
  weekdayLong(date: string): string;
  /** "12" */
  dayOfMonth(date: string): string;
  /** "ago" */
  monthShort(date: string): string;
  /** "agosto 2026" */
  monthYear(date: string): string;
  /** The day-header label: "Mié 12". */
  dayHeader(date: string): string;
  /** "Mié 12 ago" — a whole day, short enough for a form control's option. */
  dayOption(date: string): string;
  /** The same with the shop's today marked: "Mié 12 ago · hoy". */
  todayOption(date: string): string;
  /** "jueves 27 de agosto" — for prose such as the summary strip. */
  longDate(date: string): string;
  /** "27 ago 2026" — for lists and confirmations. */
  mediumDate(date: string): string;
  /** "miércoles 12 de agosto · Semana 33" — the line a date field carries under itself. */
  dayLine(date: string): string;

  /**
   * "4 h el Mié 12" — an amount of work and the day it lands on. One phrase for the ghost
   * and for the notice afterwards, so a drop reads the same before and after it happens.
   */
  hoursOnDay(date: string, minutes: number): string;

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
    // The month belongs to the option itself: a closed select shows it without the
    // week heading above it, and "Mié 12" would not say which month.
    const dayOption = (date: string): string =>
      t('units.dayOption', {
        weekday: formatWeekdayShort(date, language),
        day: formatDayOfMonth(date),
        month: formatMonthShort(date, language),
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
      weekdayNarrow: (date) => formatWeekdayNarrow(date, language),
      weekdayLong: (date) => formatWeekdayLong(date, language),
      dayOfMonth: formatDayOfMonth,
      monthShort: (date) => formatMonthShort(date, language),
      monthYear: (date) => formatMonthYear(date, language),
      dayHeader,
      dayOption,
      todayOption: (date) => t('units.dayOptionToday', { date: dayOption(date) }),
      longDate: (date) => formatLongDate(date, language),
      mediumDate: (date) => formatMediumDate(date, language),
      dayLine: (date) =>
        [formatLongDate(date, language), t('units.week', { week: isoWeekNumber(date) })].join(
          t('units.listSeparator'),
        ),

      hoursOnDay: (date, minutes) =>
        t('units.hoursOnDay', { hours: hourNumber(minutes), day: dayHeader(date) }),

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
