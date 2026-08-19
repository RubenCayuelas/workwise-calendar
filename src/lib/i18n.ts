/**
 * The app's single i18next instance; `src/components/I18nProvider.tsx` mounts it and keeps
 * `<html lang>` in step.
 */

import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';
import esCommon from '../../public/locales/es/common.json';
import enCommon from '../../public/locales/en/common.json';

export const SUPPORTED_LANGUAGES = ['es', 'en'] as const;

export type Language = (typeof SUPPORTED_LANGUAGES)[number];

export const DEFAULT_LANGUAGE: Language = 'es';

export const LANGUAGE_STORAGE_KEY = 'workwise.language';

export const DEFAULT_NAMESPACE = 'common';

export function isLanguage(value: unknown): value is Language {
  return typeof value === 'string' && (SUPPORTED_LANGUAGES as readonly string[]).includes(value);
}

export function readStoredLanguage(): Language | undefined {
  if (typeof window === 'undefined') return undefined;
  try {
    const stored = window.localStorage.getItem(LANGUAGE_STORAGE_KEY);
    return isLanguage(stored) ? stored : undefined;
  } catch {
    return undefined;
  }
}

export function storeLanguage(language: Language): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(LANGUAGE_STORAGE_KEY, language);
  } catch {
    // Silent on purpose: failing to REMEMBER the choice must never break making it.
  }
}

/**
 * The BCP 47 tag `Intl` formats with. English is given the BRITISH form so dates stay
 * day-month and times stay 24 h: a 12 h clock beside an `08:00`-based grid would be a bug.
 */
export const INTL_LOCALES: Record<Language, string> = {
  es: 'es-ES',
  en: 'en-GB',
};

export function intlLocaleOf(language: string): string {
  return isLanguage(language) ? INTL_LOCALES[language] : INTL_LOCALES[DEFAULT_LANGUAGE];
}

// Guards the double evaluation Fast Refresh and the server/client module graphs both
// cause: re-initialising would drop the language the user picked a moment ago.
if (!i18next.isInitialized) {
  void i18next.use(initReactI18next).init({
    resources: {
      es: { [DEFAULT_NAMESPACE]: esCommon },
      en: { [DEFAULT_NAMESPACE]: enCommon },
    },
    // Spanish on the server and the client alike; the provider applies a stored preference
    // after mount, because reading localStorage during render hydrate-mismatches every string.
    lng: DEFAULT_LANGUAGE,
    fallbackLng: DEFAULT_LANGUAGE,
    supportedLngs: [...SUPPORTED_LANGUAGES],
    ns: [DEFAULT_NAMESPACE],
    defaultNS: DEFAULT_NAMESPACE,
    // React escapes for us; escaping again turns «Puerta» into entities.
    interpolation: { escapeValue: false },
    // Resources are bundled, so nothing is ever loading.
    react: { useSuspense: false },
  });
}

export default i18next;
