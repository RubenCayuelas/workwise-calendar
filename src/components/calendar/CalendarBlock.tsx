'use client';

/**
 * One row of a job on the grid, and the whole gesture vocabulary of a block:
 *
 * | gesture              | effect                                                    |
 * |----------------------|-----------------------------------------------------------|
 * | drag the body        | move the unit — reorders the queue, then the reflow runs   |
 * | drag the bottom edge | resize, but ONLY on a row the engine will not re-lay out   |
 * | click                | open the job panel                                         |
 * | hover                | the action bar: lock, stop the day here, split, delete     |
 *
 * The action bar is never behind a modifier key: "on a shop PC an Alt-drag would never
 * be discovered" (CLAUDE.md).
 *
 * WHY THE RESIZE EDGE IS SOMETIMES INERT (decided with the owner, 2026-08-11). A resize
 * is a transfer of hours inside the job, so on an unlocked future weekday row — one in
 * the movable pool — the very next reflow re-derives the job's segmentation from its
 * total and undoes it. That is correct engine behaviour: it is what makes the calendar
 * self-tidying. Offering the gesture there would be offering something that silently
 * snaps back, so the edge is inert and its tooltip names the two things that DO work:
 * put another job after it, or stop the day with a gap. `resizable` is the complement of
 * the movable pool — a locked row, a past row and a weekend row all keep what they are
 * given, and the past is exactly where "yesterday took longer than I noted" is recorded.
 *
 * Every visible string comes from public/locales, and every number goes through
 * `useFormat()` so "6 h" and "2,5 h" are spelled the same here as in the job panel.
 */

import { useTranslation } from 'react-i18next';
import {
  IconClockStop,
  IconLock,
  IconLockOpen,
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
  /**
   * The bottom edge accepts a resize. True exactly when the engine will not re-lay this
   * row out: it is locked, in the frozen past, or on a weekend. On anything else the edge
   * is inert and explains itself — see the file comment.
   */
  resizable: boolean;
  /** This unit is being dragged: the ghost shows the target, this stays put. */
  lifted: boolean;
  /** A mutation is in flight: the action bar locks so nothing is queued twice. */
  busy: boolean;
  onPointerDownBody: (event: React.PointerEvent) => void;
  onPointerDownResize: (event: React.PointerEvent) => void;
  onOpen: () => void;
  onToggleLock: () => void;
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
  resizable,
  lifted,
  busy,
  onPointerDownBody,
  onPointerDownResize,
  onOpen,
  onToggleLock,
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

  // Two short lines rather than one long one, joined the way the day header joins its
  // own: what cannot be done here, then the two things that can.
  const inertResizeHint = `${t('block.resizeFixedOnly')}\n${t('block.resizeAlternatives')}`;

  const classes = [
    styles.block,
    isFirst ? styles.first : styles.continued,
    isLast ? styles.last : '',
    overflow ? styles.overflow : '',
    frozen ? styles.frozen : '',
    lifted ? styles.lifted : '',
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
      title={format.dayTimeHours(block.date, block.startMinutes, block.durationMinutes)}
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

      {block.locked ? (
        <span className={styles.lockMark} aria-hidden="true">
          <IconLock size={13} stroke={1.9} />
        </span>
      ) : null}

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

      {!isLast ? null : resizable ? (
        <div
          className={styles.resize}
          role="separator"
          aria-label={t('block.resize')}
          title={t('block.resizeHint')}
          onPointerDown={onPointerDownResize}
        />
      ) : (
        /*
         * The same strip of edge, with no handle and no cursor of its own, so a press
         * here falls through to the body and moves the unit like anywhere else. It only
         * exists to answer the hover: this is the muscle memory the gesture used to have,
         * so it has to say what replaced it instead of doing nothing.
         */
        <div
          className={styles.resizeInert}
          role="note"
          aria-label={inertResizeHint}
          title={inertResizeHint}
        />
      )}
    </div>
  );
}
