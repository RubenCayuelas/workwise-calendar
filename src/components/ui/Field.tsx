'use client';

/**
 * `Field` owns the generated id and the `aria-describedby` / `aria-invalid` wiring; every
 * control below inherits it through context. Pass an explicit `id` to opt out.
 *
 * `error` is where `ApiError.field` lands on a 400.
 */

import {
  createContext,
  forwardRef,
  useContext,
  useId,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import { useTranslation } from 'react-i18next';
import { IconChevronDown, IconMinus, IconPlus } from '@tabler/icons-react';
import { snapWithinBounds } from './stepper';
import styles from './Field.module.css';

interface FieldContextValue {
  id: string;
  /** The `<label>`'s own id, for a control whose accessible name has to point AT it. */
  labelId: string;
  describedBy?: string;
  invalid: boolean;
}

const FieldContext = createContext<FieldContextValue | undefined>(undefined);

export interface FieldProps {
  /** Already translated. */
  label: string;
  /** The helper line under the control. */
  hint?: ReactNode;
  /** Replaces the hint and marks the control invalid. */
  error?: string;
  /** Appends the translated word for "optional" to the label. */
  optional?: boolean;
  required?: boolean;
  /** Label on the left of the control, as the Settings rows are laid out. */
  inline?: boolean;
  /** Set when the control cannot own the generated id (a radio group, a stepper). */
  id?: string;
  className?: string;
  children: ReactNode;
}

export function Field({
  label,
  hint,
  error,
  optional = false,
  required = false,
  inline = false,
  id,
  className,
  children,
}: FieldProps): React.JSX.Element {
  const { t } = useTranslation();
  const generated = useId();
  const controlId = id ?? `${generated}-control`;
  const labelId = `${generated}-label`;
  const hintId = `${generated}-hint`;
  const errorId = `${generated}-error`;
  const describedBy = error !== undefined ? errorId : hint !== undefined ? hintId : undefined;

  return (
    <div className={[styles.field, inline ? styles.inline : '', className].filter(Boolean).join(' ')}>
      <label className={styles.label} id={labelId} htmlFor={controlId}>
        {label}
        {required ? (
          <span className={styles.required} aria-hidden="true">
            *
          </span>
        ) : null}
        {optional ? <span className={styles.optional}> · {t('common.optional')}</span> : null}
      </label>

      <div className={styles.control}>
        <FieldContext.Provider
          value={{ id: controlId, labelId, describedBy, invalid: error !== undefined }}
        >
          {children}
        </FieldContext.Provider>
      </div>

      {error !== undefined ? (
        <p className={styles.error} id={errorId} role="alert">
          {error}
        </p>
      ) : hint !== undefined ? (
        <p className={styles.hint} id={hintId}>
          {hint}
        </p>
      ) : null}
    </div>
  );
}

/**
 * What a control inherits from its `Field`, or nothing when it stands alone. Public because a
 * control that does not live in this module — a popover's trigger button — has to inherit the same
 * id, `aria-describedby` and invalid ring as the ones that do, and because `<label for>` cannot
 * name a `<button>`: one takes its accessible name from its own contents, so it has to point
 * `aria-labelledby` at `labelId` itself.
 */
export function useFieldBinding(explicit: {
  id?: string;
  labelId?: string;
  describedBy?: string;
  invalid?: boolean;
}): { id?: string; labelId?: string; describedBy?: string; invalid: boolean } {
  const context = useContext(FieldContext);
  return {
    id: explicit.id ?? context?.id,
    labelId: explicit.labelId ?? context?.labelId,
    describedBy: explicit.describedBy ?? context?.describedBy,
    invalid: explicit.invalid ?? context?.invalid ?? false,
  };
}

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  /** Forces the invalid ring when the control is not inside a `Field`. */
  invalid?: boolean;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { className, invalid, id, 'aria-describedby': describedBy, ...rest },
  ref,
) {
  const bound = useFieldBinding({ id, describedBy, invalid });
  return (
    <input
      ref={ref}
      id={bound.id}
      aria-describedby={bound.describedBy}
      aria-invalid={bound.invalid || undefined}
      className={[styles.input, bound.invalid ? styles.invalid : '', className].filter(Boolean).join(' ')}
      {...rest}
    />
  );
});

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  invalid?: boolean;
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { className, invalid, id, 'aria-describedby': describedBy, rows = 2, ...rest },
  ref,
) {
  const bound = useFieldBinding({ id, describedBy, invalid });
  return (
    <textarea
      ref={ref}
      id={bound.id}
      rows={rows}
      aria-describedby={bound.describedBy}
      aria-invalid={bound.invalid || undefined}
      className={[styles.textarea, bound.invalid ? styles.invalid : '', className].filter(Boolean).join(' ')}
      {...rest}
    />
  );
});

export interface SelectOption {
  value: string;
  /** Already translated. */
  label: string;
  disabled?: boolean;
}

/** A heading over a run of options — how `DateSelect` names each week. */
export interface SelectOptionGroup {
  /** Already translated. */
  label: string;
  options: readonly SelectOption[];
}

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  /** Ungrouped options. They come first, before any `groups`. */
  options?: readonly SelectOption[];
  /** Options under `<optgroup>` headings. */
  groups?: readonly SelectOptionGroup[];
  invalid?: boolean;
}

export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { options = [], groups = [], className, invalid, id, 'aria-describedby': describedBy, ...rest },
  ref,
) {
  const bound = useFieldBinding({ id, describedBy, invalid });
  return (
    <span className={styles.selectWrap}>
      <select
        ref={ref}
        id={bound.id}
        aria-describedby={bound.describedBy}
        aria-invalid={bound.invalid || undefined}
        className={[styles.select, bound.invalid ? styles.invalid : '', className].filter(Boolean).join(' ')}
        {...rest}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value} disabled={option.disabled}>
            {option.label}
          </option>
        ))}
        {groups.map((group) => (
          <optgroup key={group.label} label={group.label}>
            {group.options.map((option) => (
              <option key={option.value} value={option.value} disabled={option.disabled}>
                {option.label}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
      <span className={styles.selectChevron} aria-hidden="true">
        <IconChevronDown size={14} stroke={1.75} />
      </span>
    </span>
  );
});

export interface NumberStepperProps {
  /** Decimal hours, weeks, whatever the field is in — NOT minutes. */
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  /** Half an hour by default: the smallest amount the shop plans in. */
  step?: number;
  /** The unit drawn inside the control, e.g. `t('units.hoursSuffix')`. */
  suffix?: string;
  disabled?: boolean;
  id?: string;
  'aria-describedby'?: string;
  /** Overrides `common.decrease` / `common.increase` for the two buttons. */
  decreaseLabel?: string;
  increaseLabel?: string;
  className?: string;
}

/**
 * Snapped to `step`, then bounded — that order is load-bearing, see `snapWithinBounds`.
 * Never emits `NaN`: an empty or half-typed input keeps the last valid value.
 */
export function NumberStepper({
  value,
  onChange,
  min,
  max,
  step = 0.5,
  suffix,
  disabled = false,
  id,
  'aria-describedby': describedByProp,
  decreaseLabel,
  increaseLabel,
  className,
}: NumberStepperProps): React.JSX.Element {
  const { t } = useTranslation();
  const bound = useFieldBinding({ id, describedBy: describedByProp });

  const clamp = (next: number): number => snapWithinBounds(next, { step, min, max });

  const nudge = (direction: 1 | -1): void => {
    onChange(clamp(value + direction * step));
  };

  return (
    <span
      className={[styles.stepper, disabled ? styles.stepperDisabled : '', className]
        .filter(Boolean)
        .join(' ')}
    >
      <button
        type="button"
        className={styles.stepperButton}
        onClick={() => nudge(-1)}
        disabled={disabled || (min !== undefined && value <= min)}
        aria-label={decreaseLabel ?? t('common.decrease')}
        title={decreaseLabel ?? t('common.decrease')}
      >
        <IconMinus size={14} stroke={1.75} />
      </button>

      <input
        id={bound.id}
        className={styles.stepperInput}
        type="number"
        inputMode="decimal"
        value={String(value)}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        aria-describedby={bound.describedBy}
        onChange={(event) => {
          const parsed = Number(event.target.value);
          if (Number.isFinite(parsed)) onChange(clamp(parsed));
        }}
        onBlur={(event) => {
          const parsed = Number(event.target.value);
          onChange(Number.isFinite(parsed) ? clamp(parsed) : value);
        }}
      />

      {suffix === undefined ? null : (
        <span className={styles.stepperSuffix} aria-hidden="true">
          {suffix}
        </span>
      )}

      <button
        type="button"
        className={styles.stepperButton}
        onClick={() => nudge(1)}
        disabled={disabled || (max !== undefined && value >= max)}
        aria-label={increaseLabel ?? t('common.increase')}
        title={increaseLabel ?? t('common.increase')}
      >
        <IconPlus size={14} stroke={1.75} />
      </button>
    </span>
  );
}

export interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> {
  /** Already translated. */
  label: string;
  hint?: ReactNode;
}

/** A labelled checkbox that owns its own label element. */
export function Checkbox({ label, hint, className, disabled, ...rest }: CheckboxProps): React.JSX.Element {
  return (
    <label
      className={[styles.checkbox, disabled ? styles.checkboxDisabled : '', className]
        .filter(Boolean)
        .join(' ')}
    >
      <input type="checkbox" className={styles.checkboxInput} disabled={disabled} {...rest} />
      <span className={styles.checkboxBody}>
        <span className={styles.checkboxLabel}>{label}</span>
        {hint === undefined ? null : <span className={styles.hint}>{hint}</span>}
      </span>
    </label>
  );
}
