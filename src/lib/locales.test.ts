import { describe, expect, it } from 'vitest';
import es from '../../public/locales/es/common.json';
import en from '../../public/locales/en/common.json';
import { EDIT_MESSAGE_KEYS, HORIZON_EXCEEDED_KEY, MANUAL_PLACEMENT_MESSAGE_KEYS } from './composition';
import { ERROR_MESSAGE_KEYS } from './errors';
import { formatDayLine } from './format';
import i18next, { SUPPORTED_LANGUAGES, type Language } from './i18n';
import { deletedJobGapReason, textLanguages } from './text';
import { WED } from '../testing/fixtures';

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

  // text.ts cannot import SUPPORTED_LANGUAGES: that module initialises i18next, and with it React,
  // which the data layer must stay clear of.
  it('offers the server the same languages the app does', () => {
    expect([...textLanguages()].sort()).toEqual([...SUPPORTED_LANGUAGES].sort());
  });

  it('composes the deleted job gap reason in each of them, and falls back to Spanish', () => {
    expect(deletedJobGapReason('Railing', 'es')).toBe('Trabajo «Railing» eliminado');
    expect(deletedJobGapReason('Railing', 'en')).toBe('Job «Railing» deleted');
    expect(deletedJobGapReason('Railing', 'kl')).toBe('Trabajo «Railing» eliminado');
    expect(deletedJobGapReason('Railing')).toBe('Trabajo «Railing» eliminado');
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

  it('words the day picker in both languages', () => {
    expect(resolve(es as Json, 'day.weekend')).toBe('fin de semana');
    expect(resolve(en as Json, 'day.weekend')).toBe('weekend');
    expect(resolve(es as Json, 'dayPicker.open')).toBe('Elegir el día');
    expect(resolve(es as Json, 'dayPicker.previousMonth')).toBe('Mes anterior');
    expect(resolve(es as Json, 'dayPicker.nextMonth')).toBe('Mes siguiente');
    expect(resolve(es as Json, 'dayPicker.today')).toBe('Hoy');
    expect(resolve(es as Json, 'dayPicker.todayHint')).toBe('Elige hoy');
    expect(resolve(es as Json, 'dayPicker.rangeStart')).toBe('Elige el primer día');
    expect(resolve(es as Json, 'dayPicker.rangePending')).toBe('Elige el último día');
    expect(resolve(en as Json, 'dayPicker.rangeStart')).toBe('Choose the first day');
    expect(resolve(en as Json, 'dayPicker.rangePending')).toBe('Choose the last day');
  });

  it('words the week label a date field carries under itself', () => {
    // `header.week` carries the week's date range inside it. Under a date field the long date
    // already says the days, so the number has to be available on its own.
    expect(resolve(es as Json, 'units.week')).toBe('Semana {{week}}');
    expect(resolve(en as Json, 'units.week')).toBe('Week {{week}}');
  });

  it('composes the day line a date field shows under itself', () => {
    // `useFormat().dayLine` is a hook and this suite renders nothing, so it calls the real
    // `formatDayLine` directly with a fixed `t`, rather than re-deriving its formula — a swapped
    // join order, a typo'd key or a hardcoded separator in `formatDayLine` fails this test.
    const dayLine = (language: Language): string =>
      formatDayLine(WED, language, i18next.getFixedT(language));
    expect(dayLine('es')).toBe('miércoles 12 de agosto · Semana 33');
    expect(dayLine('en')).toBe('Wednesday 12 August · Week 33');
  });

  it('words the typed time field in both languages', () => {
    expect(resolve(es as Json, 'timeField.earlier')).toBe('Adelantar la hora');
    expect(resolve(es as Json, 'timeField.later')).toBe('Retrasar la hora');
    expect(resolve(es as Json, 'timeField.hint')).toBe(
      'Escríbela, o muévela con ↑ y ↓ de cuarto en cuarto; con Mayús, de hora en hora.',
    );
    expect(resolve(es as Json, 'errors.invalidTimeFormat')).toBe(
      'La hora tiene que tener el formato HH:mm.',
    );
    // The bounds are NAMED, because the field refuses instead of clipping and «entre qué horas»
    // is the only thing that tells the owner what to type instead.
    expect(resolve(es as Json, 'errors.timeOutOfBounds')).toBe(
      'Esa hora tiene que estar entre las {{startTime}} y las {{endTime}}.',
    );
    for (const key of [
      'timeField.earlier',
      'timeField.later',
      'timeField.hint',
      'errors.invalidTimeFormat',
      'errors.timeOutOfBounds',
    ]) {
      expect(enKeys, `missing in en: ${key}`).toContain(key);
    }
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

function placeholdersOf(value: string): string[] {
  return [...value.matchAll(/\{\{(\w+)/g)].map((match) => match[1]).sort();
}
