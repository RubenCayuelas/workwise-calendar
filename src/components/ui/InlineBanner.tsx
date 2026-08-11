'use client';

/**
 * An in-place message, for failures a screen has to keep on screen.
 *
 * The rule of thumb between this and `Toast`: a banner is for something the owner
 * must act on and that stays true until they do — a refused save, a week that would
 * not load, `touchedLockedBlockIds`. A toast is for something that already happened
 * and needs no action.
 *
 * The message text is always a prop, and always the result of `t(...)`. For an API
 * failure that is `apiErrorMessage(error, t, language)` from src/lib/api-client.ts.
 */

import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import {
  IconAlertTriangle,
  IconCircleCheck,
  IconExclamationCircle,
  IconInfoCircle,
  IconX,
} from '@tabler/icons-react';
import { Button } from './Button';
import { IconButton } from './IconButton';
import styles from './InlineBanner.module.css';

export type BannerTone = 'error' | 'warning' | 'info' | 'success';

export interface InlineBannerProps {
  tone?: BannerTone;
  /** Optional headline over the message, e.g. `t('errors.title')`. */
  title?: string;
  children: ReactNode;
  /** Adds a retry button. Label defaults to `common.retry`. */
  onRetry?: () => void;
  retryLabel?: string;
  /** Adds a dismiss cross. Label defaults to `common.dismiss`. */
  onDismiss?: () => void;
  dismissLabel?: string;
  className?: string;
}

const GLYPHS: Record<BannerTone, ReactNode> = {
  error: <IconExclamationCircle size={16} stroke={1.75} />,
  warning: <IconAlertTriangle size={16} stroke={1.75} />,
  info: <IconInfoCircle size={16} stroke={1.75} />,
  success: <IconCircleCheck size={16} stroke={1.75} />,
};

export function InlineBanner({
  tone = 'error',
  title,
  children,
  onRetry,
  retryLabel,
  onDismiss,
  dismissLabel,
  className,
}: InlineBannerProps): React.JSX.Element {
  const { t } = useTranslation();

  return (
    <div
      className={[styles.banner, styles[tone], className].filter(Boolean).join(' ')}
      // Errors interrupt; the rest is announced when the screen reader gets to it.
      role={tone === 'error' ? 'alert' : 'status'}
    >
      <span className={styles.glyph} aria-hidden="true">
        {GLYPHS[tone]}
      </span>

      <div className={styles.body}>
        {title === undefined ? null : <span className={styles.title}>{title}</span>}
        <span className={styles.message}>{children}</span>
      </div>

      {onRetry === undefined && onDismiss === undefined ? null : (
        <div className={styles.actions}>
          {onRetry === undefined ? null : (
            <Button size="sm" variant="secondary" onClick={onRetry}>
              {retryLabel ?? t('common.retry')}
            </Button>
          )}
          {onDismiss === undefined ? null : (
            <IconButton
              size="sm"
              variant="ghost"
              icon={<IconX size={14} stroke={1.75} />}
              label={dismissLabel ?? t('common.dismiss')}
              onClick={onDismiss}
            />
          )}
        </div>
      )}
    </div>
  );
}
