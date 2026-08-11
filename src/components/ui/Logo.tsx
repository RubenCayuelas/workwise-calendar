'use client';

/**
 * The header lockup.
 *
 * Uses `workwise-logo.svg`, the `currentColor` variant, and the `.ww-logo` class from
 * the brand token file — which sets `color: var(--ww-logo-ink)`, so the logo repaints
 * itself when a dark theme is eventually turned on. Per the brand guidelines: never
 * add a shadow, an outline, or change the bar heights.
 *
 * A plain `<img>` rather than `next/image`: it is a local SVG of a few hundred bytes,
 * and the optimiser has nothing to do with it.
 */

import { useTranslation } from 'react-i18next';

export interface LogoProps {
  /** Height in px. The brand minimum for the horizontal lockup is 100px WIDE. */
  height?: number;
  className?: string;
}

export function Logo({ height = 28, className }: LogoProps): React.JSX.Element {
  const { t } = useTranslation();
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src="/brand/workwise-logo.svg"
      alt={t('app.logoAlt')}
      className={['ww-logo', className].filter(Boolean).join(' ')}
      style={{ height }}
    />
  );
}
