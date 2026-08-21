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
