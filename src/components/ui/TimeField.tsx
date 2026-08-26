'use client';

/**
 * A time of day, typed. Not a native `<input type="time">`: that follows the BROWSER's locale, and
 * the Settings screen showed "08:00 AM" beside a calendar reading "08:00–14:00".
 *
 * It draws its OWN string and never `format.time`: passing every keystroke through parse→format
 * rewrites `8:00` to `08:00` under the cursor, and `formatTime` answers `--:--` for anything it
 * cannot read, which is the opposite of leaving an unreadable value on screen. `format.time` is
 * used only where the start is minutes: the bounds named in a refusal.
 *
 * It renders the `Input` from `Field`, so inside a `Field` it picks up the generated id, the
 * `aria-describedby` and the invalid ring like every other control here.
 *
 * A REFUSED value stays on screen while the caller still holds the last settled one, so `onInvalid`
 * is how it says so: unheard, `Guardar` would store the value the field stopped showing.
 */

import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { IconMinus, IconPlus } from '@tabler/icons-react';
import { useFormat } from '../../lib/useFormat';
import { Input } from './Field';
import { commitTypedTime, normalizeTypedTime, stepTypedTime, type TimeBounds } from './timeTyping';
import styles from './Field.module.css';

export interface TimeFieldProps {
  /** `HH:mm`, drawn verbatim: a stored `08:10` is never pulled onto the quarter-hour grid. */
  value: string;
  /** Fired on a SETTLED value only: Enter, leaving the field, a button or an arrow. */
  onChange: (value: string) => void;
  /**
   * What the field is refusing, `undefined` when it settles. REQUIRED, because a refusal keeps the
   * typed string on screen and leaves `value` at the last settled one: a caller that does not hear
   * it saves what the field is no longer showing. Draw it in the `Field`'s `error` — that is where
   * `role="alert"` lives — and hold the save while it stands.
   */
  onInvalid: (message: string | undefined) => void;
  /** Bounds, in minutes from midnight. Outside them the field refuses; it never clips. */
  minMinutes?: number;
  maxMinutes?: number;
  disabled?: boolean;
  /** Forces the invalid ring when the control is not inside a `Field`. */
  invalid?: boolean;
  id?: string;
  className?: string;
}

export function TimeField({
  value,
  onChange,
  onInvalid,
  minMinutes,
  maxMinutes,
  disabled = false,
  invalid,
  id,
  className,
}: TimeFieldProps): React.JSX.Element {
  const { t } = useTranslation();
  const format = useFormat();

  const [text, setText] = useState(value);
  const [rejected, setRejected] = useState<string | undefined>(undefined);
  /** What the field held when focus arrived: an untouched value commits verbatim. */
  const entered = useRef(value);

  // Held in a ref so the effect below stays keyed on the value: a caller's inline closure changes
  // identity every render, and an effect that re-ran that often would wipe the string being typed.
  const report = useRef(onInvalid);
  report.current = onInvalid;

  // The form's value wins whenever it changes from outside — a panel reopening on another absence, a
  // settings draft reset — and the half-typed string is dropped for it. `disabled` counts as outside:
  // a field that can no longer commit must not go on refusing. The cleanup covers the same thing on
  // the way out, so a caller conditionally rendering this is never left holding a refusal for a
  // control that is off screen.
  useEffect(() => {
    setText(value);
    setRejected(undefined);
    report.current(undefined);
    return () => report.current(undefined);
  }, [value, disabled]);

  const bounds: TimeBounds = { minMinutes, maxMinutes };

  const settle = (next: string): void => {
    // Set even when it equals `value`: typing `8` over `08:00` leaves nothing for the effect
    // above to put back, and the field would keep showing `8`.
    setText(next);
    setRejected(undefined);
    onInvalid(undefined);
    entered.current = next;
    if (next !== value) onChange(next);
  };

  const commit = (): void => {
    const result = commitTypedTime(entered.current, text, bounds);
    if (result.ok) {
      settle(result.value);
      return;
    }
    const message =
      result.reason === 'invalid-format'
        ? t('errors.invalidTimeFormat')
        : t('errors.timeOutOfBounds', {
            startTime: format.time(result.minMinutes),
            endTime: format.time(result.maxMinutes),
          });
    // On the field's own `title`, the way `Field` swaps its hint for an error, AND handed to the
    // caller: a tooltip is not announced and cannot hold a save.
    setRejected(message);
    onInvalid(message);
  };

  const step = (direction: 1 | -1, wholeHour: boolean): void => {
    // An unreadable draft has no step of its own, so the arrows move the value the form still holds.
    const from = normalizeTypedTime(text) ?? value;
    settle(stepTypedTime(from, direction, { wholeHour, bounds }));
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Enter') {
      event.preventDefault();
      commit();
      return;
    }
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      event.preventDefault();
      step(event.key === 'ArrowUp' ? 1 : -1, event.shiftKey);
    }
    // Escape is the panel's: there is no buffer of "what was here before" to revert.
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
        disabled={disabled}
        aria-label={t('timeField.earlier')}
        title={t('timeField.earlier')}
        // Keeps the input focused through the click, so `step` always reads the same raw,
        // still-uncommitted `text` an arrow-key press would — otherwise the blur this button
        // would cause fires `commit()` first, snapping the draft under the click's own step.
        onMouseDown={(event) => event.preventDefault()}
        onClick={(event) => step(-1, event.shiftKey)}
      >
        <IconMinus size={14} stroke={1.75} />
      </button>

      <Input
        className={styles.timeInput}
        value={text}
        id={id}
        disabled={disabled}
        invalid={rejected === undefined ? invalid : true}
        inputMode="numeric"
        maxLength={5}
        title={rejected ?? t('timeField.hint')}
        onChange={(event) => setText(event.target.value)}
        onFocus={() => {
          entered.current = text;
        }}
        onBlur={commit}
        onKeyDown={onKeyDown}
      />

      <button
        type="button"
        className={styles.stepperButton}
        disabled={disabled}
        aria-label={t('timeField.later')}
        title={t('timeField.later')}
        onMouseDown={(event) => event.preventDefault()}
        onClick={(event) => step(1, event.shiftKey)}
      >
        <IconPlus size={14} stroke={1.75} />
      </button>
    </span>
  );
}
