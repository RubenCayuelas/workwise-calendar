/**
 * The schedule strip's sentence, rendered against the REAL locale files and the REAL
 * date formatters, in both languages.
 *
 * Why this file exists: the sentence used to have two implementations — this one and an
 * inline copy in the week view's `SummaryStrip` — and they drifted within a day. The
 * strip was fixed to print a MEDIUM buffer date while this copy still printed a long
 * one, so the create-job form said "el viernes viernes 14 de agosto". Both screens now
 * call `scheduleSummaryMessage`, and the test below is what keeps the wording rule from
 * coming back: `summary.*FridayBusy` already writes the weekday into the sentence, so
 * `bufferDate` must never carry one of its own.
 */

import { describe, expect, it } from 'vitest';
import es from '../../../public/locales/es/common.json';
import en from '../../../public/locales/en/common.json';
import { formatHourNumber, formatLongDate, formatMediumDate } from '../../lib/format';
import type { ScheduleSummary } from '../../lib/composition';
import { scheduleSummaryMessage, type SummaryFormatter } from './summary';

const THURSDAY = '2026-08-20';
const FRIDAY = '2026-08-14';

/** The real bundles, interpolated the way i18next does. */
function translator(bundle: Record<string, unknown>) {
  return (key: string, values: Record<string, unknown> = {}): string => {
    const text = key
      .split('.')
      .reduce<unknown>((node, part) => (node as Record<string, unknown>)?.[part], bundle);
    if (typeof text !== 'string') throw new Error(`missing key: ${key}`);
    return text.replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(values[name] ?? `{{${name}}}`));
  };
}

function formatter(language: string): SummaryFormatter {
  return {
    hourNumber: (minutes) => formatHourNumber(minutes, language),
    longDate: (date) => formatLongDate(date, language),
    mediumDate: (date) => formatMediumDate(date, language),
  };
}

const languages = [
  ['es', es as Record<string, unknown>],
  ['en', en as Record<string, unknown>],
] as const;

function summary(overrides: Partial<ScheduleSummary> = {}): ScheduleSummary {
  return {
    lastOccupiedDate: THURSDAY,
    queuedMinutes: 66 * 60,
    bufferDate: FRIDAY,
    bufferClear: true,
    ...overrides,
  };
}

describe('scheduleSummaryMessage', () => {
  it('states how far the shop is booked and that Friday is clear', () => {
    const text = scheduleSummaryMessage(summary(), translator(es as Record<string, unknown>), formatter('es'));
    expect(text).toBe('Taller ocupado hasta el jueves 20 de agosto · 66 h en cola · viernes libre');
  });

  it('names the buffer date once the colchón carries work', () => {
    const text = scheduleSummaryMessage(
      summary({ bufferClear: false }),
      translator(es as Record<string, unknown>),
      formatter('es'),
    );
    expect(text).toBe(
      'Taller ocupado hasta el jueves 20 de agosto · 66 h en cola · el viernes 14 ago 2026 ya tiene carga',
    );
  });

  it('reads the empty shop as free rather than as booked until nothing', () => {
    const text = scheduleSummaryMessage(
      summary({ lastOccupiedDate: null, queuedMinutes: 0 }),
      translator(es as Record<string, unknown>),
      formatter('es'),
    );
    expect(text).toBe('Taller libre · sin trabajos en cola · viernes libre');
  });

  // The regression. A long buffer date would put the weekday in twice.
  for (const [language, bundle] of languages) {
    for (const bufferClear of [false] as const) {
      it(`never repeats the weekday around the buffer date (${language})`, () => {
        const text = scheduleSummaryMessage(
          summary({ bufferClear, lastOccupiedDate: THURSDAY }),
          translator(bundle),
          formatter(language),
        );
        const weekday = formatLongDate(FRIDAY, language).split(',')[0].split(' ')[0].toLowerCase();
        const occurrences = text.toLowerCase().split(weekday).length - 1;
        expect(occurrences, `"${weekday}" appears ${occurrences} times in: ${text}`).toBe(1);
      });

      it(`never repeats the weekday with an empty queue either (${language})`, () => {
        const text = scheduleSummaryMessage(
          summary({ bufferClear, lastOccupiedDate: null, queuedMinutes: 0 }),
          translator(bundle),
          formatter(language),
        );
        const weekday = formatLongDate(FRIDAY, language).split(',')[0].split(' ')[0].toLowerCase();
        expect(text.toLowerCase().split(weekday).length - 1, text).toBe(1);
      });
    }
  }
});
