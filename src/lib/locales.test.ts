import { describe, expect, it } from 'vitest';
import es from '../../public/locales/es/common.json';
import en from '../../public/locales/en/common.json';
import { EDIT_MESSAGE_KEYS, HORIZON_EXCEEDED_KEY, MANUAL_PLACEMENT_MESSAGE_KEYS } from './composition';
import { ERROR_MESSAGE_KEYS } from './errors';
import { SUPPORTED_LANGUAGES } from './i18n';
import { deletedJobGapReason, textLanguages } from './text';

type Json = { [key: string]: string | Json };

function flatten(value: Json, prefix = ''): string[] {
  return Object.entries(value).flatMap(([key, entry]) => {
    const path = prefix === '' ? key : `${prefix}.${key}`;
    return typeof entry === 'string' ? [path] : flatten(entry, path);
  });
}

const esKeys = flatten(es as Json);
const enKeys = flatten(en as Json);

describe('locale files', () => {
  it('hold exactly the same keys in both languages', () => {
    expect([...enKeys].sort()).toEqual([...esKeys].sort());
  });

  it('has no empty string anywhere', () => {
    for (const [name, bundle] of [
      ['es', es],
      ['en', en],
    ] as const) {
      const empty = flatten(bundle as Json).filter((key) => resolve(bundle as Json, key).trim() === '');
      expect(empty, `${name} has empty values`).toEqual([]);
    }
  });

  it('defines every error key the data layer can emit', () => {
    const emitted = [
      ...Object.values(ERROR_MESSAGE_KEYS),
      ...Object.values(EDIT_MESSAGE_KEYS),
      ...Object.values(MANUAL_PLACEMENT_MESSAGE_KEYS),
      HORIZON_EXCEEDED_KEY,
    ];
    for (const key of new Set(emitted)) {
      expect(esKeys, `missing in es: ${key}`).toContain(key);
      expect(enKeys, `missing in en: ${key}`).toContain(key);
    }
  });

  it('keeps every interpolation placeholder identical across languages', () => {
    for (const key of esKeys) {
      const spanish = placeholdersOf(resolve(es as Json, key));
      const english = placeholdersOf(resolve(en as Json, key));
      expect(english, `placeholders differ for ${key}`).toEqual(spanish);
    }
  });

  it('provides both plural forms wherever it provides one', () => {
    for (const key of esKeys) {
      if (key.endsWith('_one')) {
        expect(esKeys).toContain(`${key.slice(0, -4)}_other`);
      }
      if (key.endsWith('_other')) {
        expect(esKeys).toContain(`${key.slice(0, -6)}_one`);
      }
    }
  });

  // Measured: CLDR es-ES abbreviates September "sept" while this list said "sep", so two headers
  // on the same page spelled the same month differently.
  it('spells weekdays and months the way format.ts does', () => {
    for (const [language, bundle, locale] of [
      ['es', es, 'es-ES'],
      ['en', en, 'en-GB'],
    ] as const) {
      for (let weekday = 1; weekday <= 7; weekday += 1) {
        // 2026-08-10 is a Monday.
        const date = new Date(2026, 7, 9 + weekday, 12);
        expect(resolve(bundle as Json, `weekdays.short.${weekday}`).toLowerCase(), language).toBe(
          intl(locale, date, { weekday: 'short' }).toLowerCase(),
        );
        expect(resolve(bundle as Json, `weekdays.long.${weekday}`).toLowerCase(), language).toBe(
          intl(locale, date, { weekday: 'long' }).toLowerCase(),
        );
      }
      for (let month = 1; month <= 12; month += 1) {
        const date = new Date(2026, month - 1, 15, 12);
        expect(resolve(bundle as Json, `months.short.${month}`).toLowerCase(), language).toBe(
          intl(locale, date, { month: 'short' }).toLowerCase(),
        );
        expect(resolve(bundle as Json, `months.long.${month}`).toLowerCase(), language).toBe(
          intl(locale, date, { month: 'long' }).toLowerCase(),
        );
      }
    }
  });

  // text.ts cannot import SUPPORTED_LANGUAGES: that module initialises i18next, and with it React,
  // which the data layer must stay clear of.
  it('offers the server the same languages the app does', () => {
    expect([...textLanguages()].sort()).toEqual([...SUPPORTED_LANGUAGES].sort());
  });

  it('composes the deleted job gap reason in each of them, and falls back to Spanish', () => {
    expect(deletedJobGapReason('Barandilla', 'es')).toBe('Trabajo «Barandilla» eliminado');
    expect(deletedJobGapReason('Barandilla', 'en')).toBe('Job «Barandilla» deleted');
    expect(deletedJobGapReason('Barandilla', 'kl')).toBe('Trabajo «Barandilla» eliminado');
    expect(deletedJobGapReason('Barandilla')).toBe('Trabajo «Barandilla» eliminado');
  });

  it('words the wireframe strings exactly', () => {
    expect(resolve(es as Json, 'header.week')).toBe('Semana {{week}} · {{range}}');
    expect(resolve(es as Json, 'summary.bookedFridayFree')).toBe(
      'Taller ocupado hasta el {{date}} · {{hours}} h en cola · viernes libre',
    );
    expect(resolve(es as Json, 'grid.bandsLegend')).toBe(
      'Bandas grises: márgenes visuales y comida — solo arrastre manual',
    );
    expect(resolve(es as Json, 'block.continuesBelow')).toBe('{{hours}} h · sigue…');
    expect(resolve(es as Json, 'block.continuesAbove')).toBe('…sigue · {{hours}} h');
    expect(resolve(es as Json, 'block.overflow')).toBe('desborde {{hours}} h');
    expect(resolve(es as Json, 'day.frozen')).toBe('congelado');
    expect(resolve(es as Json, 'day.buffer')).toBe('colchón');
    expect(resolve(es as Json, 'grid.free')).toBe('libre');
    expect(resolve(es as Json, 'jobPanel.blocks_other')).toBe(
      'Bloques · {{hours}} h en {{count}} tramos',
    );
  });
});

function resolve(bundle: Json, key: string): string {
  const value = key.split('.').reduce<string | Json | undefined>((node, part) => {
    if (node === undefined || typeof node === 'string') return undefined;
    return node[part];
  }, bundle);
  if (typeof value !== 'string') throw new Error(`Not a string key: ${key}`);
  return value;
}

function intl(locale: string, date: Date, options: Intl.DateTimeFormatOptions): string {
  // The same trailing-dot trim `format.ts` applies, so the two are compared like for like.
  return new Intl.DateTimeFormat(locale, options).format(date).replace(/\.$/, '');
}

function placeholdersOf(value: string): string[] {
  return [...value.matchAll(/\{\{(\w+)/g)].map((match) => match[1]).sort();
}
