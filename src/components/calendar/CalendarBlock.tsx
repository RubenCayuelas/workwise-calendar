'use client';

/**
 * One row of a job on the grid, and the whole gesture vocabulary of a block:
 *
 * | gesture              | effect                                                    |
 * |----------------------|-----------------------------------------------------------|
 * | drag the body        | move the UNIT — reorders the queue, then the reflow runs  |
 * | drag the bottom edge | resize THIS ROW: a transfer of hours inside the job        |
 * | click                | open the job panel                                         |
 * | hover                | the action bar: lock, back to automatic, stop the day here,|
 * |                      | split, delete                                             |
 *
 * The action bar is never behind a modifier key: "on a shop PC an Alt-drag would never
 * be discovered" (CLAUDE.md).
 *
 * THE RESIZE EDGE IS OFFERED ON EVERY ROW (decided with the owner, 2026-08-12). It used
 * to be inert on an unlocked future weekday row, with a tooltip naming the two things
 * that did work, because the reflow re-derived the job's segmentation from its total and
 * undid the transfer — the request answered 200 with the block unchanged. The engine now
 * stores the intent, so the length sticks anywhere; what the owner has to be able to see
 * is the state that buys it, which is the two things this file adds to the row:
 *
 * - THE HAND-SET MARK, deliberately not a padlock. They mean different things and are
 *   independent: the padlock fixes the row's POSITION, the ruler fixes its LENGTH. A
 *   row can carry either, both or neither.
 * - BACK TO AUTOMATIC, in the action bar. A hand-set length is otherwise invisible
 *   except that the row stopped reflowing, so without a one-click release the owner
 *   cannot undo it and the marks accumulate until the engine manages nothing.
 *
 * Every visible string comes from public/locales, and every number goes through
 * `useFormat()` so "6 h" and "2,5 h" are spelled the same here as in the job panel.
 */

import { useTranslation } from 'react-i18next';
import {
  IconClockStop,
  IconLock,
  IconLockOpen,
  IconRuler,
  IconRulerOff,
  IconScissors,
  IconTrash,
} from '@tabler/icons-react';
import { IconButton } from '../ui';
import { useFormat } from '../../lib/useFormat';
import { MIN_LABEL_HEIGHT, type Timeline } from './geometry';
import type { BlockSegment, LanePlacement } from './grouping';
import styles from './CalendarBlock.module.css';

export interface CalendarBlockProps {
  segment: BlockSegment;
  timeline: Timeline;
  lane: LanePlacement;
  /**
   * Placed on Friday by the engine, i.e. work that grew past its estimate. There is no
   * `manually_placed` flag by design, so this is derived: the colchón only ever holds
   * overflow or something the owner locked there.
   */
  overflow: boolean;
  /** A past day: the hover bar is withheld, but the row stays editable by hand. */
  frozen: boolean;
  /** This unit is being dragged: the ghost shows the target, this stays put. */
  lifted: boolean;
  /**
   * A drop in progress lands inside this row and will CUT it here, in minutes from
   * midnight. Drawn as a seam so the owner sees whose block they are about to split
   * before releasing, not afterwards in a toast.
   */
  cutAtMinutes?: number;
  /** A mutation is in flight: the action bar locks so nothing is queued twice. */
  busy: boolean;
  onPointerDownBody: (event: React.PointerEvent) => void;
  onPointerDownResize: (event: React.PointerEvent) => void;
  onOpen: () => void;
  onToggleLock: () => void;
  /**
   * "Back to automatic": give the unit's hand-set length back to the engine. Present
   * exactly when some row of the unit carries the mark. It returns the LENGTH, not the
   * queue position — the row keeps whatever place the calendar now gives it.
   */
  onReleaseDuration?: () => void;
  /**
   * "Stop the day here": a gap from the end of this row to the end of the day. Omitted
   * when there is nothing left to close, or on a day auto-fill never touches.
   */
  onCloseDay?: () => void;
  onSplit: () => void;
  onDelete: () => void;
}

export function CalendarBlock({
  segment,
  timeline,
  lane,
  overflow,
  frozen,
  lifted,
  cutAtMinutes,
  busy,
  onPointerDownBody,
  onPointerDownResize,
  onOpen,
  onToggleLock,
  onReleaseDuration,
  onCloseDay,
  onSplit,
  onDelete,
}: CalendarBlockProps): React.JSX.Element {
  const { t } = useTranslation();
  const format = useFormat();
  const { block, group, isFirst, isLast } = segment;

  const height = timeline.heightOf(block.durationMinutes);
  const endMinutes = block.startMinutes + block.durationMinutes;

  /*
   * Every row states ITS OWN hours, which is what the wireframe does on both of its
   * grouped units ("6 h" on a 6h row, "2 h · sigue" on the 2h continuation). A row that
   * announced the whole unit's total would be unreadable against its own height — "5 h"
   * inside a one-hour box. What makes the unit one thing is visual and behavioural: the
   * outer rounded corners, the dashed seam, one resize handle, and a drag that moves the
   * whole run.
   */
  const hoursLabel = !isFirst
    ? t('block.continues', { hours: format.hourNumber(block.durationMinutes) })
    : overflow
      ? t('block.overflow', { hours: format.hourNumber(block.durationMinutes) })
      : format.hours(block.durationMinutes);

  // One short line, the way the day header words its own state: what this row is, then
  // the one consequence that explains why it stopped moving with the rest.
  const manualHint = `${t('block.manualDuration')}\n${t('block.manualDurationHint')}`;

  const classes = [
    styles.block,
    isFirst ? styles.first : styles.continued,
    isLast ? styles.last : '',
    overflow ? styles.overflow : '',
    frozen ? styles.frozen : '',
    lifted ? styles.lifted : '',
    block.manualDuration ? styles.manual : '',
    cutAtMinutes === undefined ? '' : styles.cutting,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div
      className={classes}
      data-block-id={block.id}
      data-group-id={group.id}
      role="button"
      tabIndex={0}
      aria-label={t('block.label', {
        name: block.project.name,
        day: format.dayHeader(block.date),
        start: format.time(block.startMinutes),
        end: format.time(endMinutes),
        hours: format.hourNumber(block.durationMinutes),
      })}
      title={
        block.manualDuration
          ? `${format.dayTimeHours(block.date, block.startMinutes, block.durationMinutes)}\n${manualHint}`
          : format.dayTimeHours(block.date, block.startMinutes, block.durationMinutes)
      }
      style={{
        '--ww-block-color': block.project.color,
        top: `${timeline.yOf(block.startMinutes)}px`,
        height: `${height}px`,
        left: `calc(${(lane.lane / lane.lanes) * 100}% + 2px)`,
        width: `calc(${100 / lane.lanes}% - 4px)`,
      } as React.CSSProperties}
      onPointerDown={onPointerDownBody}
      onKeyDown={(event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        onOpen();
      }}
    >
      <span className={styles.name}>{block.project.name}</span>
      {height >= MIN_LABEL_HEIGHT ? <span className={styles.hours}>{hoursLabel}</span> : null}

      {/*
       * The two marks share the corner the action bar takes over on hover, and they are
       * independent states, so both can be up at once: the padlock says the engine may
       * not MOVE this row, the ruler says it may not RESIZE it.
       */}
      {block.locked || block.manualDuration ? (
        <span className={styles.marks} aria-hidden="true">
          {block.manualDuration ? (
            <span className={styles.manualMark} title={manualHint}>
              <IconRuler size={13} stroke={1.9} />
            </span>
          ) : null}
          {block.locked ? <IconLock size={13} stroke={1.9} /> : null}
        </span>
      ) : null}

      {/*
       * Where the drop in progress will cut this row. Absolutely positioned against the
       * row's own top, so it lands on the minute the ghost starts at.
       */}
      {cutAtMinutes === undefined ? null : (
        <span
          className={styles.cutSeam}
          aria-hidden="true"
          style={{ top: `${timeline.heightOf(cutAtMinutes - block.startMinutes)}px` }}
        />
      )}

      {frozen ? null : (
        <div
          className={styles.actions}
          // The bar sits on top of the drag surface, so its presses must not start one.
          onPointerDown={(event) => event.stopPropagation()}
        >
          <IconButton
            size="sm"
            icon={block.locked ? <IconLock size={13} stroke={1.9} /> : <IconLockOpen size={13} stroke={1.9} />}
            label={block.locked ? t('block.unlock') : t('block.lock')}
            active={block.locked}
            disabled={busy}
            onClick={onToggleLock}
          />
          {onReleaseDuration === undefined ? null : (
            <IconButton
              size="sm"
              icon={<IconRulerOff size={13} stroke={1.9} />}
              label={t('block.releaseDuration')}
              disabled={busy}
              onClick={onReleaseDuration}
            />
          )}
          {onCloseDay === undefined ? null : (
            <IconButton
              size="sm"
              icon={<IconClockStop size={13} stroke={1.9} />}
              label={t('block.closeDay')}
              disabled={busy}
              onClick={onCloseDay}
            />
          )}
          <IconButton
            size="sm"
            icon={<IconScissors size={13} stroke={1.9} />}
            label={t('block.split')}
            disabled={busy}
            onClick={onSplit}
          />
          <IconButton
            size="sm"
            variant="danger"
            icon={<IconTrash size={13} stroke={1.9} />}
            label={t('block.delete')}
            disabled={busy}
            onClick={onDelete}
          />
        </div>
      )}

      {/*
       * The resize edge. On EVERY row, and that is two changes rather than one: every
       * DAY (it used to be inert wherever the reflow would undo it) and every ROW of a
       * unit (it used to be only the last).
       *
       * The second one is what makes CLAUDE.md's own worked example reachable — "the
       * owner shrinks the Wednesday morning row to 2 h" is the FIRST row of a unit that
       * carries on after lunch. A unit has one handle for the MOVE, because it is one
       * thing to drag; but its rows are two rectangles with the lunch band between them,
       * each with a real bottom edge on screen, and each is a row the engine can size on
       * its own. `maxDurationFrom` caps the drag at the end of that row's own period, so
       * no drag can ever produce a row straddling the break.
       */}
      <div
        className={styles.resize}
        role="separator"
        aria-label={t('block.resize')}
        title={t('block.resizeHint')}
        onPointerDown={onPointerDownResize}
      />
    </div>
  );
}
