'use client';

/**
 * A day, chosen from the month it lives in. Which days it offers is `dateOptions.ts`, the 42 cells
 * are `monthGrid.ts`, and the two marks the client cannot deduce — closed, and room left — come
 * from `/api/days`. Not a native `<input type="date">`: in the browser's locale `03/08` is
 * genuinely ambiguous.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { IconChevronDown, IconChevronLeft, IconChevronRight } from '@tabler/icons-react';
import { isValidDate, startOfMonth } from '../../lib/dates';
import { getDayMarks, isAbortError, type DaysView } from '../../lib/api-client';
import { useFormat } from '../../lib/useFormat';
import { IconButton } from './IconButton';
import { useFieldBinding } from './Field';
import { planningWindow, type DayWindow } from './dateOptions';
import { MONTH_GRID_ROWS, monthGrid, type MonthCell } from './monthGrid';
import { monthReach, openingMonth, stepMonth } from './monthReach';
import { isDayPickerKey, moveFocusedDay } from './dayPickerKeys';
import { markOf, markRange, type DayMark, type DayMarks } from './pickerDays';
import { popoverPosition } from './popoverBox';
import { dayCellNotes, type DayCellNote } from './dayPickerTitle';
import { useMounted } from './useMounted';
import styles from './DayPicker.module.css';

const DAYS_PER_WEEK = 7;

/** The box drawn by DayPicker.module.css. Pixels, and they must match it. */
const CELL_HEIGHT = 30;
const POPOVER_WIDTH = 226;
/** Everything that is not the six rows: the padding, the month head, the weekday letters, the
    three gaps and the `Hoy` button. */
const POPOVER_CHROME = 100;
const POPOVER_HEIGHT = POPOVER_CHROME + MONTH_GRID_ROWS * CELL_HEIGHT;
/** Clear of the field, so the popover never covers the value it is about to change. */
const POPOVER_GAP = 6;

export interface DayPickerProps {
  /** Local `YYYY-MM-DD`. A stored day outside the window is kept, and its own cell stays pressable. */
  value: string;
  onChange: (value: string) => void;
  /** The shop's today: rings one cell and anchors the window. */
  today: string;
  /** The owner's `planningHorizonWeeks`, which is how far forward the calendar reaches. */
  horizonWeeks?: number;
  /** The `Field`'s own label id. Inherited from the `Field`; pass it only outside one. */
  labelId?: string;
  /** `WeekController.revision`: the marks are refetched whenever the week is. */
  revision?: number;
  disabled?: boolean;
  /** Forces the invalid ring when the control is not inside a `Field`. */
  invalid?: boolean;
  id?: string;
  className?: string;
}

export function DayPicker({
  value,
  onChange,
  today,
  horizonWeeks,
  labelId,
  revision,
  disabled = false,
  invalid,
  id,
  className,
}: DayPickerProps): React.JSX.Element {
  const { t } = useTranslation();
  const format = useFormat();
  const mounted = useMounted();
  const bound = useFieldBinding({ id, labelId, invalid });

  const trigger = useRef<HTMLButtonElement | null>(null);
  const box = useRef<HTMLDivElement | null>(null);

  const [open, setOpen] = useState(false);
  const [at, setAt] = useState({ top: 0, left: 0 });
  const [month, setMonth] = useState(today);
  const [focused, setFocused] = useState(today);
  const [marks, setMarks] = useState<DayMarks | undefined>(undefined);

  // NEVER named `window`: the listeners below are on the global of that name.
  const dayWindow: DayWindow = planningWindow(isValidDate(today) ? today : value, horizonWeeks);
  const { minDate, maxDate } = dayWindow;
  const { from: markFrom, to: markTo } = markRange(
    dayWindow,
    isValidDate(value) ? value : undefined,
  );

  // A save in flight takes the field with it: `disabled` must never leave a calendar open over a
  // form that can no longer be edited.
  const shown = open && !disabled;

  // Read WITHOUT waiting for a render: the capture handler runs before React sees the key.
  const focusedRef = useRef(focused);
  focusedRef.current = focused;

  const dismiss = useCallback((restoreFocus: boolean): void => {
    setOpen(false);
    if (restoreFocus) trigger.current?.focus();
  }, []);

  const choose = (date: string): void => {
    // Reported on the CLICK, never on the close: the panels set the date optimistically because
    // the band drawn on the grid has to follow the field.
    onChange(date);
    dismiss(true);
  };

  const reveal = (): void => {
    const anchor = trigger.current?.getBoundingClientRect();
    const start = isValidDate(value) ? value : today;
    if (anchor !== undefined) {
      setAt(
        popoverPosition(
          { top: anchor.top, left: anchor.left, bottom: anchor.bottom, right: anchor.right },
          { width: POPOVER_WIDTH, height: POPOVER_HEIGHT },
          { width: window.innerWidth, height: window.innerHeight },
          POPOVER_GAP,
        ),
      );
    }
    setMonth(openingMonth(start, { today, window: dayWindow }));
    setFocused(start);
    setOpen(true);
  };

  useEffect(() => {
    if (!shown) {
      // Dropped on close: a stale mark is worse than none, and the next open asks again.
      setMarks(undefined);
      // And closed for good, not merely hidden: `disabled` alone leaves `open` set, so a save that
      // fails and re-enables the field would pop the calendar back open on its own.
      setOpen(false);
      return;
    }

    const controller = new AbortController();
    getDayMarks(markFrom, markTo, { signal: controller.signal })
      .then((view) => setMarks(marksOf(view)))
      .catch((error: unknown) => {
        if (!isAbortError(error)) setMarks(undefined);
      });

    return () => controller.abort();
    // `revision` is the refetch trigger: a write behind the panel can close a day or fill it. The
    // shown MONTH is deliberately absent — the span is the whole window, so the arrows fetch
    // nothing.
  }, [shown, markFrom, markTo, revision]);

  useEffect(() => {
    if (!shown) return;
    box.current?.querySelector<HTMLButtonElement>(`[data-date="${focused}"]`)?.focus();
  }, [shown, focused]);

  useEffect(() => {
    if (!shown) return;

    // CAPTURE, and stopped: `SidePanel` listens for Escape on `document` in the bubble phase, and
    // two listeners on the same node in the same phase cannot be ordered. Capturing on `window`
    // runs before the event ever reaches the panel.
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        dismiss(true);
        return;
      }
      if (!isDayPickerKey(event.key)) return;
      // Swallowed: the trigger is a `<button>`, which `isTypingTarget` does not recognise, so an
      // arrow left alone would page the week under the open calendar.
      const key = event.key;
      event.preventDefault();
      event.stopPropagation();
      const next = moveFocusedDay(focusedRef.current, key, { minDate, maxDate });
      // The month is read off the DAY that came back, never off the key: a press clamped at the
      // edge of the window answers with the day it was given, and must not turn the month over.
      setFocused(next);
      setMonth(startOfMonth(next));
    };

    // CAPTURE, and stopped: without it the press that dismisses this lands on the column
    // underneath and starts a band, or opens the panel of the job under it.
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target as Node;
      if (box.current?.contains(target) === true) return;
      event.preventDefault();
      event.stopPropagation();
      // A press on the TRIGGER — or on the `Field` label that names it, which the browser forwards
      // a click from to the trigger — is left to that click and the toggle to answer.
      // `preventDefault` on a `pointerdown` does not cancel the click that follows it, so closing
      // here would close the popover and that click would immediately re-open it: it would look
      // like it never closes.
      if (trigger.current?.contains(target) === true) return;
      if (labelForwards(trigger.current, target)) return;
      dismiss(true);
    };

    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('pointerdown', onPointerDown, true);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('pointerdown', onPointerDown, true);
    };
  }, [shown, dismiss, minDate, maxDate]);

  const cells = monthGrid(month, {
    today,
    window: dayWindow,
    ...(isValidDate(value) ? { current: value } : {}),
  });
  const reach = monthReach(month, dayWindow);

  const noteText = (note: DayCellNote, mark: DayMark | undefined): string => {
    switch (note) {
      case 'today':
        return t('day.today');
      case 'weekend':
        return t('day.weekend');
      case 'closed':
        return t('day.closed');
      case 'note':
        return mark?.note ?? t('day.closed');
      case 'freeHours':
        return t('day.freeHours', { hours: format.hourNumber(mark?.freeMinutes ?? 0) });
      case 'full':
        return t('day.full');
    }
  };

  const titleOf = (cell: MonthCell, mark: DayMark | undefined): string =>
    [format.dayOption(cell.date), ...dayCellNotes(cell, mark).map((note) => noteText(note, mark))]
      .join(t('units.listSeparator'));

  const labelledBy = [bound.labelId, bound.id]
    .filter((part): part is string => part !== undefined)
    .join(' ');

  return (
    <>
      <button
        ref={trigger}
        type="button"
        id={bound.id}
        // Explicit, so `SidePanel`'s first-field query — inputs and `[tabindex]`, never a button,
        // because the close button is one — still lands on the date.
        tabIndex={0}
        className={[styles.trigger, bound.invalid ? styles.invalid : '', className]
          .filter(Boolean)
          .join(' ')}
        disabled={disabled}
        // NEVER an `aria-label`: on a button it wins over the contents, and it would replace both
        // the field's name and the day already chosen.
        aria-labelledby={labelledBy === '' ? undefined : labelledBy}
        // No `aria-invalid`: the `button` role does not support it, so it would be ignored. The
        // ring is the visual half and the `Field`'s own `role="alert"` error line, pointed at by
        // `aria-describedby`, is the announced one.
        aria-describedby={bound.describedBy}
        aria-haspopup="dialog"
        aria-expanded={shown}
        title={t('dayPicker.open')}
        onClick={() => {
          // A toggle, because this click is the whole answer to a press on the trigger: while the
          // popover is open its own `pointerdown` handler swallowed the press without closing.
          if (shown) dismiss(true);
          else reveal();
        }}
      >
        <span className={styles.value}>{isValidDate(value) ? format.dayOption(value) : value}</span>
        <span className={styles.chevron} aria-hidden="true">
          <IconChevronDown size={14} stroke={1.75} />
        </span>
      </button>

      {!shown || !mounted
        ? null
        : createPortal(
            <div
              ref={box}
              className={styles.popover}
              role="dialog"
              aria-label={t('dayPicker.open')}
              style={{ top: at.top, left: at.left }}
              onBlur={(event) => {
                const next = event.relatedTarget as Node | null;
                // Leaving by TAB fires no pointer event. A press on the popover's own padding
                // blurs with no destination at all, which is not leaving.
                if (next === null) return;
                if (box.current?.contains(next) === true) return;
                if (trigger.current?.contains(next) === true) return;
                dismiss(false);
              }}
            >
              <div className={styles.head}>
                <IconButton
                  icon={<IconChevronLeft size={14} stroke={1.75} />}
                  label={t('dayPicker.previousMonth')}
                  size="sm"
                  variant="ghost"
                  disabled={!reach.canPrevious}
                  onClick={() => setMonth(stepMonth(month, -1, dayWindow))}
                />
                <span className={styles.month}>{format.monthYear(month)}</span>
                <IconButton
                  icon={<IconChevronRight size={14} stroke={1.75} />}
                  label={t('dayPicker.nextMonth')}
                  size="sm"
                  variant="ghost"
                  disabled={!reach.canNext}
                  onClick={() => setMonth(stepMonth(month, 1, dayWindow))}
                />
              </div>

              <div className={styles.weekdays} aria-hidden="true">
                {cells.slice(0, DAYS_PER_WEEK).map((cell) => (
                  <span key={cell.date} className={styles.weekday}>
                    {format.weekdayNarrow(cell.date)}
                  </span>
                ))}
              </div>

              <div className={styles.grid}>
                {cells.map((cell) => {
                  const mark = markOf(cell.date, marks);
                  return (
                    <button
                      key={cell.date}
                      type="button"
                      data-date={cell.date}
                      className={[
                        styles.cell,
                        cell.inMonth ? '' : styles.outside,
                        cell.date === value ? styles.selected : '',
                        cell.isToday ? styles.today : '',
                        cell.isWeekend ? styles.weekend : '',
                        cell.isPast ? styles.past : '',
                        mark?.isClosed === true ? styles.closed : '',
                      ]
                        .filter(Boolean)
                        .join(' ')}
                      disabled={!cell.selectable}
                      tabIndex={cell.date === focused ? 0 : -1}
                      aria-pressed={cell.date === value}
                      aria-current={cell.isToday ? 'date' : undefined}
                      title={titleOf(cell, mark)}
                      onClick={() => choose(cell.date)}
                    >
                      <span className={styles.number}>{format.dayOfMonth(cell.date)}</span>
                      {mark?.hasRoom === true ? (
                        <span className={styles.room} aria-hidden="true" />
                      ) : null}
                    </button>
                  );
                })}
              </div>

              <button
                type="button"
                className={styles.todayButton}
                title={t('dayPicker.todayHint')}
                onClick={() => choose(today)}
              >
                {t('dayPicker.today')}
              </button>
            </div>,
            document.body,
          )}
    </>
  );
}

/**
 * Whether a press landed inside a `<label>` whose click the browser forwards to `button` — the
 * `Field`'s own label, sitting right beside the trigger in every panel.
 *
 * Asked of `HTMLButtonElement.labels` rather than matched by selector: that is the association the
 * browser will actually act on, it needs no id to escape and no id to exist, and `contains` answers
 * for a text node inside the label just as well as for an element.
 */
function labelForwards(button: HTMLButtonElement | null, target: Node): boolean {
  if (button === null) return false;
  return Array.from(button.labels).some((label) => label.contains(target));
}

/** The route's rows keyed by day, which is how a cell asks for its own. */
function marksOf(view: DaysView): DayMarks {
  const marks: Record<string, DayMark> = {};
  for (const day of view.days) {
    marks[day.date] = {
      isClosed: day.isClosed,
      hasRoom: day.hasRoom,
      freeMinutes: day.freeMinutes,
      ...(day.note === undefined ? {} : { note: day.note }),
    };
  }
  return marks;
}
