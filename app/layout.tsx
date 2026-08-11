import type { Metadata } from 'next';
import type { ReactNode } from 'react';
// Brand tokens FIRST: globals.css derives from them and would otherwise be
// declaring against custom properties that do not exist yet.
import '../public/brand/workwise-tokens.css';
import './globals.css';
import { I18nProvider } from '../src/components/I18nProvider';
import { ToastProvider } from '../src/components/ui';

/** Icons exactly as public/brand/workwise-brand-guidelines.md specifies them. */
export const metadata: Metadata = {
  title: 'Workwise',
  description: 'Work scheduling for the workshop',
  icons: {
    icon: [
      { url: '/workwise-favicon.svg', type: 'image/svg+xml' },
      { url: '/workwise-favicon-32.png', sizes: '32x32' },
    ],
    apple: '/workwise-apple-touch-icon-180.png',
  },
};

export default function RootLayout({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    // `lang="es"` is the SERVER's language and matches what i18next initialises with,
    // so hydration sees identical markup; `I18nProvider` then rewrites it if the owner
    // has picked another language on this machine.
    //
    // `data-theme="light"` is deliberate: workwise-tokens.css ships dark values behind
    // `prefers-color-scheme`, and this keeps them dormant until dark mode is really
    // built. Removing this one attribute is what will turn dark on.
    <html lang="es" data-theme="light">
      <body>
        <I18nProvider>
          <ToastProvider>{children}</ToastProvider>
        </I18nProvider>
      </body>
    </html>
  );
}
