'use client';

/**
 * What a released band IS. Two buttons at the pointer, with the band still drawn underneath, and
 * neither one writes anything: each opens a form pre-filled with the day, the start and the hours.
 *
 * A popover rather than a centred dialog because the band it is asking about is right there, and the
 * answer only makes sense beside it.
 */

import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../ui';
import type { PaintPoint } from './paintSession';
import styles from './CalendarScreen.module.css';

/** Kept off the pointer itself so the band is never hidden under the question. */
const OFFSET_PX = 12;
const ESTIMATED_WIDTH = 232;
const ESTIMATED_HEIGHT = 132;

export interface PaintChooserProps {
  at: PaintPoint;
  /** The band, spelled out, so the question names what it is about. */
  label: string;
  onJob: () => void;
  onGap: () => void;
  onCancel: () => void;
}

export function PaintChooser({ at, label, onJob, onGap, onCancel }: PaintChooserProps): React.JSX.Element {
  const { t } = useTranslation();
  const box = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    // CAPTURE, and stopped: without it the press that dismisses this lands on the column underneath
    // and starts a second paint, so the answer and a new band would arrive together.
    const onPointerDown = (event: PointerEvent): void => {
      if (box.current?.contains(event.target as Node) === true) return;
      event.preventDefault();
      event.stopPropagation();
      onCancel();
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      onCancel();
    };

    window.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('keydown', onKeyDown, true);
    };
  }, [onCancel]);

  return (
    <div
      ref={box}
      role="dialog"
      aria-label={t('grid.paintChooserTitle')}
      className={styles.paintChooser}
      style={{
        left: Math.min(at.x + OFFSET_PX, Math.max(0, window.innerWidth - ESTIMATED_WIDTH)),
        top: Math.min(at.y + OFFSET_PX, Math.max(0, window.innerHeight - ESTIMATED_HEIGHT)),
      }}
    >
      <p className={styles.paintChooserLabel}>{label}</p>
      <div className={styles.paintChooserButtons}>
        {/* First and focused, so Enter is the button's own activation rather than a shortcut. */}
        <Button size="sm" variant="primary" onClick={onJob} autoFocus>
          {t('grid.paintChooserJob')}
        </Button>
        <Button size="sm" onClick={onGap}>
          {t('grid.paintChooserGap')}
        </Button>
      </div>
      <button type="button" className={styles.paintChooserCancel} onClick={onCancel}>
        {t('common.cancel')}
      </button>
    </div>
  );
}
