'use client';

/**
 * The job colour picker: the eight fixed swatches, and nothing else.
 *
 * CLAUDE.md: "Project colours are a fixed swatch picker built from
 * `--ww-project-1..8`. No free hex input — amber is reserved for the app itself and a
 * free picker would let a job blend into the interface." There is deliberately no
 * `<input type="color">` here and no way to type a hex; the API rejects anything
 * outside `PROJECT_COLORS` with a 400 anyway.
 *
 * The values come from `src/lib/projectColors.ts`, the same constant the API
 * validates against, so the picker and the validator cannot drift.
 *
 * Real radio inputs rather than `role="radio"` buttons: arrow-key navigation, the
 * roving tab stop and form association all come for free and correct.
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
              // The palette lives in TypeScript because the API has to validate it;
              // this is the one sanctioned place a project hex reaches the DOM.
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
