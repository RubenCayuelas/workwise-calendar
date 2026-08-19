'use client';

/**
 * 409 `shrink-needs-choice`, rendered from the server's own `choices` in one round trip.
 */

import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { Button, useMounted } from '../ui';
import { useFormat } from '../../lib/useFormat';
import type { FreedHoursChoice } from '../../lib/api-client';
import styles from './ResizeChoiceDialog.module.css';

/**
 * What the dialog SAYS, deliberately not the gesture it will re-send: the screen keeps the
 * target and the dragged length, since nothing here renders them.
 */
export interface ResizeChoiceRequest {
  /** The job's name, for the sentence. */
  name: string;
  /** The hours with no counterparty. */
  freedMinutes: number;
  /** Exactly the answers that exist. Never empty. */
  choices: readonly FreedHoursChoice[];
}

export interface ResizeChoiceDialogProps {
  request: ResizeChoiceRequest | null;
  busy?: boolean;
  onChoose: (choice: FreedHoursChoice) => void;
  onCancel: () => void;
}

/** The label and the hint under it, per answer. */
const LABELS: Record<FreedHoursChoice, { label: string; hint: string }> = {
  'reduce-total': { label: 'resizeChoice.reduceTotal', hint: 'resizeChoice.reduceTotalHint' },
  'new-block': { label: 'resizeChoice.newBlock', hint: 'resizeChoice.newBlockHint' },
};

export function ResizeChoiceDialog({
  request,
  busy = false,
  onChoose,
  onCancel,
}: ResizeChoiceDialogProps): React.JSX.Element | null {
  const { t } = useTranslation();
  const format = useFormat();
  const mounted = useMounted();
  const cancelRef = useRef<HTMLButtonElement>(null);

  const open = request !== null;

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

  // Focus starts on CANCEL, as in `ConfirmDialog`: neither answer is a safe default, so a
  // stray Enter must choose neither.
  useEffect(() => {
    if (open) cancelRef.current?.focus();
  }, [open]);

  if (!mounted || request === null) return null;

  const hours = format.hourNumber(request.freedMinutes);
  const title = t('resizeChoice.title', { hours });

  return createPortal(
    <div
      className={styles.scrim}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onCancel();
      }}
    >
      <div className={styles.dialog} role="dialog" aria-modal="true" aria-label={title}>
        <h2 className={styles.title}>{title}</h2>
        <p className={styles.description}>{t('resizeChoice.body', { name: request.name })}</p>

        <div className={styles.choices}>
          {request.choices.map((choice) => (
            <button
              key={choice}
              type="button"
              className={styles.choice}
              disabled={busy}
              onClick={() => onChoose(choice)}
            >
              <span className={styles.choiceLabel}>{t(LABELS[choice].label)}</span>
              <span className={styles.choiceHint}>{t(LABELS[choice].hint, { hours })}</span>
            </button>
          ))}
        </div>

        <div className={styles.actions}>
          <Button ref={cancelRef} variant="secondary" onClick={onCancel} disabled={busy}>
            {t('resizeChoice.cancel')}
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
