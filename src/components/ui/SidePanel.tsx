'use client';

/**
 * The right-hand panel shell: the job panel and the gap form both live in one.
 *
 * `aria-modal="false"` and no scrim by default, on purpose — the owner edits while still
 * watching the calendar, and the grid stays live behind it. Portalled onto `document.body`
 * so a `transform` or `overflow` on the grid cannot clip it.
 */

import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { IconX } from '@tabler/icons-react';
import { IconButton } from './IconButton';
import { useMounted } from './useMounted';
import styles from './SidePanel.module.css';

export interface SidePanelProps {
  open: boolean;
  onClose: () => void;
  /** Already translated, or the job's own name. */
  title: ReactNode;
  /** Drawn before the title — usually `<ColorDot color={project.color} />`. */
  accent?: ReactNode;
  /** Sticky action row, e.g. Guardar / Eliminar. */
  footer?: ReactNode;
  /** Overrides `common.close` on the close button. */
  closeLabel?: string;
  /** Dims and blocks the rest of the page. Off by default; see the note above. */
  scrim?: boolean;
  /** Escape closes the panel. On by default. */
  closeOnEscape?: boolean;
  children: ReactNode;
}

export function SidePanel({
  open,
  onClose,
  title,
  accent,
  footer,
  closeLabel,
  scrim = false,
  closeOnEscape = true,
  children,
}: SidePanelProps): React.JSX.Element | null {
  const { t } = useTranslation();
  const mounted = useMounted();
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open || !closeOnEscape) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, closeOnEscape, onClose]);

  useEffect(() => {
    if (!open) return;
    // The first real field, not the close button — the panel is opened to edit.
    const first = panelRef.current?.querySelector<HTMLElement>(
      'input, textarea, select, [tabindex]:not([tabindex="-1"])',
    );
    first?.focus();
  }, [open]);

  if (!mounted || !open) return null;

  const label = closeLabel ?? t('common.close');

  return createPortal(
    <>
      {scrim ? <div className={styles.scrim} onClick={onClose} /> : null}
      <aside
        ref={panelRef}
        className={styles.panel}
        role="dialog"
        aria-modal={scrim ? 'true' : 'false'}
        aria-label={typeof title === 'string' ? title : undefined}
      >
        <header className={styles.header}>
          {accent === undefined ? null : <span className={styles.accent}>{accent}</span>}
          <h2 className={styles.title}>{title}</h2>
          <IconButton
            icon={<IconX size={16} stroke={1.75} />}
            label={label}
            variant="ghost"
            onClick={onClose}
          />
        </header>

        <div className={styles.body}>{children}</div>

        {footer === undefined ? null : <footer className={styles.footer}>{footer}</footer>}
      </aside>
    </>,
    document.body,
  );
}

/** The small rounded square of a job's colour, as the panel header and lists show it. */
export function ColorDot({ color, className }: { color: string; className?: string }): React.JSX.Element {
  return (
    <span
      className={[styles.dot, className].filter(Boolean).join(' ')}
      style={{ '--ww-dot-color': color } as React.CSSProperties}
      aria-hidden="true"
    />
  );
}
