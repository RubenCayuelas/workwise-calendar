'use client';

/**
 * `/settings` — the shell around `SettingsScreen`.
 *
 * The overflow menu in the week view's header points here (`header.menuSettings`), and
 * `settings.back` gets the owner back to the calendar. A client component because
 * everything on it is client state: i18next, the language toggle and the form itself.
 */

import { useRouter } from 'next/navigation';
import { useTranslation } from 'react-i18next';
import { IconArrowLeft } from '@tabler/icons-react';
import { Button, LanguageSwitcher, Logo } from '../../src/components/ui';
import { SettingsScreen } from '../../src/components/settings/SettingsScreen';

export default function SettingsPage(): React.JSX.Element {
  const { t } = useTranslation();
  const router = useRouter();

  return (
    <div className="ww-app">
      <header className="ww-app__header">
        <Logo />
        <span className="ww-spacer" />
        <div className="ww-toolbar">
          <Button icon={<IconArrowLeft size={15} stroke={1.75} />} onClick={() => router.push('/')}>
            {t('settings.back')}
          </Button>
          <LanguageSwitcher />
        </div>
      </header>

      <main className="ww-app__body">
        <SettingsScreen />
      </main>
    </div>
  );
}
