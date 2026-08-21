/**
 * Measured: the sentence had two implementations — this one and an inline copy in the week
 * view's `SummaryStrip` — and they drifted within a day. The strip printed a MEDIUM buffer
 * date while this copy printed a long one, so the create-job form said "el viernes viernes
 * 14 de agosto". `summary.*FridayBusy` writes the weekday, so `bufferDate` must not.
 */

import { describe, expect, it } from 'vitest';
import es from '../../../public/locales/es/common.json';
import en from '../../../public/locales/en/common.json';
import { formatHourNumber, formatLongDate, formatMediumDate } from '../../lib/format';
import type { ScheduleSummary } from '../../lib/composition';
import { capacityNoticeMessage, scheduleSummaryMessage, type SummaryFormatter } from './summary';
import { FRI, NEXT_THU } from '../../testing/fixtures';

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
    lastOccupiedDate: NEXT_THU,
    queuedMinutes: 66 * 60,
    bufferDate: FRI,
    bufferClear: true,
    ...overrides,
  };
}

describe('scheduleSummaryMessage', () => {
  it('states how far the shop is booked and that Friday is clear', () => {
    const text = scheduleSummaryMessage(summary(), translator(es as Record<string, unknown>), formatter('es'));
    expect(text).toBe('Taller ocupado hasta el jueves 20 de agosto · 66 h en cola · viernes libre');
  });

  it('names the buffer date once the buffer carries work', () => {
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
          summary({ bufferClear, lastOccupiedDate: NEXT_THU }),
          translator(bundle),
          formatter(language),
        );
        const weekday = formatLongDate(FRI, language).split(',')[0].split(' ')[0].toLowerCase();
        const occurrences = text.toLowerCase().split(weekday).length - 1;
        expect(occurrences, `"${weekday}" appears ${occurrences} times in: ${text}`).toBe(1);
      });

      it(`never repeats the weekday with an empty queue either (${language})`, () => {
        const text = scheduleSummaryMessage(
          summary({ bufferClear, lastOccupiedDate: null, queuedMinutes: 0 }),
          translator(bundle),
          formatter(language),
        );
        const weekday = formatLongDate(FRI, language).split(',')[0].split(' ')[0].toLowerCase();
        expect(text.toLowerCase().split(weekday).length - 1, text).toBe(1);
      });
    }
  }
});

describe('capacityNoticeMessage', () => {
  it('states both numbers when the stop line sits below the shift', () => {
    const text = capacityNoticeMessage(
      { capacityMinutes: 6 * 60, shiftMinutes: 10 * 60 },
      translator(es as Record<string, unknown>),
      formatter('es'),
    );
    expect(text).toBe('Relleno automático: 6 h de las 10 h de jornada');
  });

  it('says nothing when auto-fill fills the whole shift', () => {
    expect(
      capacityNoticeMessage(
        { capacityMinutes: 10 * 60, shiftMinutes: 10 * 60 },
        translator(es as Record<string, unknown>),
        formatter('es'),
      ),
    ).toBeUndefined();
  });

  it('says nothing about a day with no working time at all', () => {
    // A closed day is already labelled as closed; "0 h of 0 h" would be noise.
    expect(
      capacityNoticeMessage(
        { capacityMinutes: 0, shiftMinutes: 0 },
        translator(es as Record<string, unknown>),
        formatter('es'),
      ),
    ).toBeUndefined();
  });

  it('is worded in both languages', () => {
    for (const [language, bundle] of languages) {
      const text = capacityNoticeMessage(
        { capacityMinutes: 6 * 60, shiftMinutes: 10 * 60 },
        translator(bundle),
        formatter(language),
      );
      expect(text, language).toContain('6');
      expect(text, language).toContain('10');
    }
  });
});
