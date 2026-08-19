import type { Metadata } from 'next';
import type { ReactNode } from 'react';
// Brand tokens FIRST: globals.css derives from them and would otherwise be
// declaring against custom properties that do not exist yet.
import '../public/brand/workwise-tokens.css';
import './globals.css';
import { I18nProvider } from '../src/components/I18nProvider';
import { ToastProvider } from '../src/components/ui';

/** Icons exactly as the brand guidelines specify them. */
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
    // `lang="es"` must match what i18next initialises with or hydration sees different markup;
    // `I18nProvider` rewrites it after mount. `data-theme="light"` keeps the dark values that
    // workwise-tokens.css ships behind `prefers-color-scheme` dormant — removing it turns dark on.
    <html lang="es" data-theme="light">
      <body>
        <I18nProvider>
          <ToastProvider>{children}</ToastProvider>
        </I18nProvider>
      </body>
    </html>
  );
}
