'use client';

/**
 * The eight fixed project swatches, read from
 * `src/lib/projectColors.ts` — the same constant the API validates against, so the picker
 * and the validator cannot drift. Real radio inputs, so arrow-key navigation, the roving
 * tab stop and form association come for free.
 */

import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import { PROJECT_COLORS, normalizeProjectColor, type ProjectColor } from '../../lib/projectColors';
import styles from './ColorSwatches.module.css';

export interface ColorSwatchesProps {
  /** The current hex. Case-insensitive; anything not in the palette selects nothing. */
  value: string;
  onChange: (color: ProjectColor) => void;
  /** Radio group name. Generated when omitted. */
  name?: string;
  disabled?: boolean;
  /** Group label for assistive tech. Defaults to `colors.groupLabel`. */
  label?: string;
  /** Per-swatch name. Defaults to `colors.1` .. `colors.8`. */
  colorLabel?: (color: ProjectColor, index: number) => string;
  className?: string;
}

export function ColorSwatches({
  value,
  onChange,
  name,
  disabled = false,
  label,
  colorLabel,
  className,
}: ColorSwatchesProps): React.JSX.Element {
  const { t } = useTranslation();
  const generatedName = useId();
  const groupName = name ?? generatedName;
  const selected = normalizeProjectColor(value);

  return (
    <div
      className={[styles.group, className].filter(Boolean).join(' ')}
      role="radiogroup"
      aria-label={label ?? t('colors.groupLabel')}
    >
      {PROJECT_COLORS.map((color, index) => {
        const swatchLabel = colorLabel?.(color, index) ?? t(`colors.${index + 1}`);
        const isSelected = selected === color;
        return (
          <label
            key={color}
            className={[
              styles.swatch,
              isSelected ? styles.selected : '',
              disabled ? styles.disabled : '',
            ]
              .filter(Boolean)
              .join(' ')}
            title={swatchLabel}
          >
            <input
              className={styles.input}
              type="radio"
              name={groupName}
              value={color}
              checked={isSelected}
              disabled={disabled}
              onChange={() => onChange(color)}
            />
            <span
              className={styles.chip}
              // The one sanctioned place a project hex reaches the DOM.
              style={{ '--ww-swatch-color': color } as React.CSSProperties}
              aria-hidden="true"
            />
            <span className="ww-visually-hidden">{swatchLabel}</span>
          </label>
        );
      })}
    </div>
  );
}
