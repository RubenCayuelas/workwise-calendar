/**
 * The one place the SERVER composes a sentence — and it does it out of the locale files,
 * like every other string in the app.
 *
 * Almost nothing here needs prose: an error carries an i18n KEY and the UI translates it,
 * which is what keeps the data layer free of wording. The exception is text that becomes
 * USER DATA and is therefore stored: deleting a job turns its past rows into gaps, and
 * each of those gaps has to say what it replaced — `Trabajo «Barandilla» eliminado` — for
 * ever. The job is gone by the time the gap exists, so there is nothing left to look the
 * name up in and nothing for a key to be resolved against later. The sentence has to be
 * composed at deletion time and written into `gaps.reason`.
 *
 * TWO CONSEQUENCES THE OWNER ACCEPTED (2026-08-13). The gap is frozen in whatever language
 * the app was in when the job was deleted, and switching to English later will not
 * translate it. That is the right trade: a gap's `reason` is user data, the same field
 * that holds "Avería torno", and it stays editable afterwards like any other gap.
 *
 * The bundles are IMPORTED, exactly as src/lib/i18n.ts imports them, so there is one copy
 * of the wording and no filesystem read at runtime. i18next itself is deliberately NOT
 * imported: it pulls React in, and the data layer must stay something a test can call
 * without mounting anything.
 */

import esCommon from '../../public/locales/es/common.json';
import enCommon from '../../public/locales/en/common.json';

/**
 * Kept in step with `SUPPORTED_LANGUAGES` (src/lib/i18n.ts) by a test in
 * `locales.test.ts`, rather than by importing it — see the note above.
 */
const BUNDLES = { es: esCommon, en: enCommon } as const;

export type TextLanguage = keyof typeof BUNDLES;

/** Spanish is the shop's language and the fallback for anything unrecognised. */
export const DEFAULT_TEXT_LANGUAGE: TextLanguage = 'es';

export function textLanguages(): TextLanguage[] {
  return Object.keys(BUNDLES) as TextLanguage[];
}

export function isTextLanguage(value: unknown): value is TextLanguage {
  return typeof value === 'string' && value in BUNDLES;
}

/**
 * The reason stored on a gap that stands in for a deleted job's past row.
 *
 * `«…»` is the app's quote style everywhere a job is named in prose, so a gap the owner
 * reads next to their own notes is punctuated like the rest of the calendar.
 */
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
  // A missing key is a bug in the locale files, and `locales.test.ts` is what catches it.
  // Returning the key rather than throwing keeps a deletion from failing over wording.
  return typeof value === 'string' ? value : key;
}

/** i18next's `{{name}}` placeholders, for the handful this module ever fills. */
function interpolate(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (whole, key: string) => values[key] ?? whole);
}
