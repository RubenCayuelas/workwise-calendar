'use client';

/**
 * "These hours have nowhere to go — what should happen to them?"
 *
 * THE ONE QUESTION A GESTURE ASKS. Shrinking a row is a transfer inside the job: the
 * freed hours go to the job's last row the engine still lays out. When there is no such
 * row — it is the job's only one, or every other is padlocked, on a weekend or in the
 * past — the hours have no counterparty, and the server answers 409 `shrink-needs-choice`
 * WITHOUT WRITING ANYTHING rather than refusing the gesture outright. That refusal used to
 * be the whole answer (`shrink-last-block`), which is why the owner reported that resize
 * "only works in one direction": growing had an escape (the estimate rises), shrinking had
 * none.
 *
 * BOTH ANSWERS ARE OFFERED IN ONE GO, and that is why `error.details` carries `choices`
 * rather than the dialog working them out: `new-block` is absent when the freed hours are
 * under a quarter of an hour, because a row that short is one no gesture may ask for. A
 * dialog that offered it anyway would be a second round trip to discover the option was
 * never real.
 *
 * CANCEL IS NOT AN ANSWER — it is simply not asking again. Nothing was written when the
 * question was posed, so closing this leaves the row at the length it already had.
 *
 * The hours are formatted HERE. `details` carries `freedMinutes`, integer minutes like
 * everything else that crosses the wire, so that `freedHours` means exactly one thing in
 * the API: the owner's choice.
 */

import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { Button, useMounted } from '../ui';
import { useFormat } from '../../lib/useFormat';
import type { FreedHoursChoice } from '../../lib/api-client';
import styles from './ResizeChoiceDialog.module.css';

/**
 * What the dialog SAYS. Deliberately not the gesture it will re-send — the screen keeps
 * the target and the length it was dragged to, because nothing here renders them and a
 * dialog holding the request it does not read is how the two drift apart.
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

  // Focus starts on CANCEL, as in `ConfirmDialog`: neither answer is the safe default —
  // one shrinks the job, the other leaves loose hours to place — so a stray Enter must
  // choose neither.
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
