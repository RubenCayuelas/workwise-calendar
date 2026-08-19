/**
 * The one place the SERVER composes a sentence, out of the locale files. i18next itself is
 * deliberately NOT imported: it pulls React in, and the data layer must stay something a test
 * can call without mounting anything.
 */

import esCommon from '../../public/locales/es/common.json';
import enCommon from '../../public/locales/en/common.json';

/** Kept in step with `SUPPORTED_LANGUAGES` (src/lib/i18n.ts) by `locales.test.ts`. */
const BUNDLES = { es: esCommon, en: enCommon } as const;

export type TextLanguage = keyof typeof BUNDLES;

export const DEFAULT_TEXT_LANGUAGE: TextLanguage = 'es';

export function textLanguages(): TextLanguage[] {
  return Object.keys(BUNDLES) as TextLanguage[];
}

export function isTextLanguage(value: unknown): value is TextLanguage {
  return typeof value === 'string' && value in BUNDLES;
}

/** The reason stored on a gap that stands in for a deleted job's past row. */
export function deletedJobGapReason(name: string, language?: string): string {
  return interpolate(lookup('gapForm.deletedJobReason', language), { name });
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

type Bundle = { [key: string]: string | Bundle };

function lookup(key: string, language?: string): string {
  const bundle: Bundle = BUNDLES[isTextLanguage(language) ? language : DEFAULT_TEXT_LANGUAGE];
  const value = key.split('.').reduce<string | Bundle | undefined>((node, part) => {
    if (node === undefined || typeof node === 'string') return undefined;
    return node[part];
  }, bundle);
  // Returning the key rather than throwing keeps a deletion from failing over wording.
  return typeof value === 'string' ? value : key;
}

/** i18next's `{{name}}` placeholders. */
function interpolate(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (whole, key: string) => values[key] ?? whole);
}
