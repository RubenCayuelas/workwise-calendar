/**
 * The app's single i18next instance.
 *
 * CLAUDE.md: Spanish is the primary language, every visible string lives in
 * `public/locales/{lang}/common.json`, and the language must be selectable at any
 * time. This module owns the instance and the persistence; `src/components/
 * I18nProvider.tsx` mounts it and keeps `<html lang>` in step.
 *
 * Two decisions worth knowing:
 *
 * - The locale files are IMPORTED, not fetched. They are two small JSON files and
 *   bundling them means no loading state, no flash of untranslated keys, and no
 *   HTTP backend plugin. `public/locales/` stays their home because CLAUDE.md names
 *   that path.
 * - The instance always INITIALISES in Spanish, on the server and on the client
 *   alike. A stored preference is applied by the provider after mount, which is what
 *   keeps the server's HTML and the client's first render identical — reading
 *   localStorage during render would hydrate-mismatch every string on the page.
 */

import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';
import esCommon from '../../public/locales/es/common.json';
import enCommon from '../../public/locales/en/common.json';

/** Spanish first: it is the shop's language and the source of truth for wording. */
export const SUPPORTED_LANGUAGES = ['es', 'en'] as const;

export type Language = (typeof SUPPORTED_LANGUAGES)[number];

export const DEFAULT_LANGUAGE: Language = 'es';

/** Where the choice is remembered. One key, this machine only — there is no account. */
export const LANGUAGE_STORAGE_KEY = 'workwise.language';

export const DEFAULT_NAMESPACE = 'common';

export function isLanguage(value: unknown): value is Language {
  return typeof value === 'string' && (SUPPORTED_LANGUAGES as readonly string[]).includes(value);
}

/** The stored preference, or `undefined` when there is none or storage is unavailable. */
export function readStoredLanguage(): Language | undefined {
  if (typeof window === 'undefined') return undefined;
  try {
    const stored = window.localStorage.getItem(LANGUAGE_STORAGE_KEY);
    return isLanguage(stored) ? stored : undefined;
  } catch {
    // Private mode or a disabled storage quota: the app still works in Spanish.
    return undefined;
  }
}

export function storeLanguage(language: Language): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(LANGUAGE_STORAGE_KEY, language);
  } catch {
    // Not being able to remember the choice must never break changing it.
  }
}

/**
 * The BCP 47 tag `Intl` should format with for a UI language. Spanish is the shop's
 * (Europe/Madrid), and English is given the British form so dates stay day-month and
 * times stay 24 h — a 12 h clock next to a `08:00`-based grid would be a bug.
 */
export const INTL_LOCALES: Record<Language, string> = {
  es: 'es-ES',
  en: 'en-GB',
};

export function intlLocaleOf(language: string): string {
  return isLanguage(language) ? INTL_LOCALES[language] : INTL_LOCALES[DEFAULT_LANGUAGE];
}

// `isInitialized` guards the double evaluation that Fast Refresh and the
// server/client module graphs both cause. Re-initialising would drop the language
// the user picked a moment ago.
if (!i18next.isInitialized) {
  void i18next.use(initReactI18next).init({
    resources: {
      es: { [DEFAULT_NAMESPACE]: esCommon },
      en: { [DEFAULT_NAMESPACE]: enCommon },
    },
    lng: DEFAULT_LANGUAGE,
    fallbackLng: DEFAULT_LANGUAGE,
    supportedLngs: [...SUPPORTED_LANGUAGES],
    ns: [DEFAULT_NAMESPACE],
    defaultNS: DEFAULT_NAMESPACE,
    // React escapes for us; escaping again turns «Puerta» into entities.
    interpolation: { escapeValue: false },
    // Resources are bundled, so nothing is ever loading and Suspense would only add
    // a boundary every screen would have to provide.
    react: { useSuspense: false },
  });
}

export default i18next;
