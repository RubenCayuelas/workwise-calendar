'use client';

/**
 * Mounts the i18next instance for the whole app and owns the language choice.
 *
 * The server render and the client's first render are both `DEFAULT_LANGUAGE`, so the
 * markup matches; the stored preference is applied after mount, as an ordinary update
 * rather than a hydration mismatch. `<html lang>` follows every change.
 */

import { useEffect, useMemo, type ReactNode } from 'react';
import { I18nextProvider, useTranslation } from 'react-i18next';
import i18n, {
  DEFAULT_LANGUAGE,
  SUPPORTED_LANGUAGES,
  isLanguage,
  readStoredLanguage,
  storeLanguage,
  type Language,
} from '../lib/i18n';

export function I18nProvider({ children }: { children: ReactNode }): React.JSX.Element {
  useEffect(() => {
    // Set by the layout for the server render; from here on it tracks the instance.
    const syncDocumentLanguage = (language: string): void => {
      document.documentElement.lang = language;
    };

    i18n.on('languageChanged', syncDocumentLanguage);

    const stored = readStoredLanguage();
    if (stored !== undefined && stored !== i18n.language) {
      void i18n.changeLanguage(stored);
    } else {
      syncDocumentLanguage(i18n.language);
    }

    return () => {
      i18n.off('languageChanged', syncDocumentLanguage);
    };
  }, []);

  return <I18nextProvider i18n={i18n}>{children}</I18nextProvider>;
}

export interface UseLanguageResult {
  /** The language actually in use, always one of `SUPPORTED_LANGUAGES`. */
  language: Language;
  /** Switches language and remembers the choice on this machine. */
  setLanguage: (language: Language) => void;
  /** The language a two-language toggle should offer next. */
  nextLanguage: Language;
  languages: readonly Language[];
}

/** Read and change the interface language; re-renders on i18next's `languageChanged`. */
export function useLanguage(): UseLanguageResult {
  const { i18n: instance } = useTranslation();
  const current = instance.resolvedLanguage ?? instance.language;
  const language = isLanguage(current) ? current : DEFAULT_LANGUAGE;

  return useMemo(() => {
    const index = SUPPORTED_LANGUAGES.indexOf(language);
    return {
      language,
      nextLanguage: SUPPORTED_LANGUAGES[(index + 1) % SUPPORTED_LANGUAGES.length],
      languages: SUPPORTED_LANGUAGES,
      setLanguage: (next: Language) => {
        storeLanguage(next);
        void instance.changeLanguage(next);
      },
    };
  }, [instance, language]);
}
