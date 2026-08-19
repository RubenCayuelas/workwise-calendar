'use client';

/**
 * The confirmation every destructive action needs.
 *
 * Required for deleting a job, and since there is no undo anywhere in the app, removing a
 * block or a gap goes through it too.
 *
 * Modal, unlike `SidePanel`: focus starts on CANCEL, not on the destructive button,
 * so a stray Enter cannot delete a job.
 */

import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { Button } from './Button';
import { useMounted } from './useMounted';
import styles from './ConfirmDialog.module.css';

export interface ConfirmDialogProps {
  open: boolean;
  /** Already translated, e.g. `t('jobPanel.deleteTitle', { name })`. */
  title: string;
  /** What will happen. Say that it cannot be undone. */
  description?: ReactNode;
  /** The destructive action's own words — never a bare "OK". */
  confirmLabel: string;
  /** Defaults to `common.cancel`. */
  cancelLabel?: string;
  /** Paints the confirm button as destructive. On by default. */
  danger?: boolean;
  /** The request is in flight: both buttons lock and the confirm label is replaced. */
  busy?: boolean;
  /** Replaces `confirmLabel` while `busy`. Defaults to `common.deleting`. */
  busyLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  cancelLabel,
  danger = true,
  busy = false,
  busyLabel,
  onConfirm,
  onCancel,
}: ConfirmDialogProps): React.JSX.Element | null {
  const { t } = useTranslation();
  const mounted = useMounted();
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !busy) {
        event.stopPropagation();
        onCancel();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, busy, onCancel]);

  useEffect(() => {
    if (open) cancelRef.current?.focus();
  }, [open]);

  if (!mounted || !open) return null;

  return createPortal(
    <div
      className={styles.scrim}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onCancel();
      }}
    >
      <div className={styles.dialog} role="dialog" aria-modal="true" aria-label={title}>
        <h2 className={styles.title}>{title}</h2>
        {description === undefined ? null : <p className={styles.description}>{description}</p>}

        <div className={styles.actions}>
          <Button ref={cancelRef} variant="secondary" onClick={onCancel} disabled={busy}>
            {cancelLabel ?? t('common.cancel')}
          </Button>
          <Button
            variant={danger ? 'danger' : 'primary'}
            onClick={onConfirm}
            disabled={busy}
          >
            {busy ? (busyLabel ?? t('common.deleting')) : confirmLabel}
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
