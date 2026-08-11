'use client';

/**
 * The `ES` button in the wireframe header.
 *
 * With two languages a toggle is the whole interaction: it shows the language in use
 * and switching is one click. The choice is persisted by `useLanguage` and survives a
 * reload; `<html lang>` follows it.
 *
 * If a third language is ever added, this becomes a `Select` over
 * `SUPPORTED_LANGUAGES` and nothing else changes.
 */

import { useTranslation } from 'react-i18next';
import { useLanguage } from '../I18nProvider';
import { Button } from './Button';

export interface LanguageSwitcherProps {
  size?: 'sm' | 'md';
  className?: string;
}

export function LanguageSwitcher({ size = 'md', className }: LanguageSwitcherProps): React.JSX.Element {
  const { t } = useTranslation();
  const { language, nextLanguage, setLanguage } = useLanguage();

  return (
    <Button
      size={size}
      variant="secondary"
      className={className}
      onClick={() => setLanguage(nextLanguage)}
      title={t('header.languageSwitch', { language: t(`languages.${nextLanguage}`) })}
      aria-label={t('header.languageCurrent', { language: t(`languages.${language}`) })}
    >
      {language.toUpperCase()}
    </Button>
  );
}
