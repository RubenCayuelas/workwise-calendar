'use client';

/**
 * One row of a job on the grid, and the whole gesture vocabulary of a block.
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
import {
  ACTIONS_BAR_HEIGHT,
  MIN_ACTIONS_HEIGHT,
  MIN_LABEL_HEIGHT,
  blockHoldsActions,
  type Timeline,
} from './geometry';
import type { BlockSegment, LanePlacement } from './grouping';
import styles from './CalendarBlock.module.css';

export interface CalendarBlockProps {
  segment: BlockSegment;
  timeline: Timeline;
  lane: LanePlacement;
  /**
   * This block's own width in pixels — its lane's share of the column — or `null` before the
   * grid has been measured. Read for one decision only: `blockHoldsActions`.
   */
  blockWidth: number | null;
  /** Placed on Friday BY THE ENGINE. Derived, not stored — see `isOverflow` in WeekGrid. */
  overflow: boolean;
  /** A past day: the hover bar is withheld, but the row stays editable by hand. */
  frozen: boolean;
  /** This unit is being dragged: the ghost shows the target, this stays put. */
  lifted: boolean;
  /** A drop in progress will CUT this row here, in minutes from midnight. Drawn as a seam. */
  cutAtMinutes?: number;
  /**
   * A mutation or a reload is in flight: the bar locks and the row stops offering a grab it
   * cannot honour. The press is not swallowed — it says why (`InertReason.busy`).
   */
  busy: boolean;
  onPointerDownBody: (event: React.PointerEvent) => void;
  /** A press on the hover ACTION BAR: it begins the same move as a press on the body. */
  onPointerDownActions: (event: React.PointerEvent) => void;
  /**
   * The server would accept a resize of this row. False only on a past day, where the bottom
   * edge is not drawn at all.
   */
  resizable: boolean;
  onPointerDownResize: (event: React.PointerEvent) => void;
  onOpen: () => void;
  onToggleLock: () => void;
  /** "Stop the day here": omitted when there is nothing left to close. */
  onCloseDay?: () => void;
  onSplit: () => void;
  onDelete: () => void;
}

export function CalendarBlock({
  segment,
  timeline,
  lane,
  blockWidth,
  overflow,
  frozen,
  lifted,
  cutAtMinutes,
  busy,
  onPointerDownBody,
  onPointerDownActions,
  resizable,
  onPointerDownResize,
  onOpen,
  onToggleLock,
  onCloseDay,
  onSplit,
  onDelete,
}: CalendarBlockProps): React.JSX.Element {
  const { t } = useTranslation();
  const format = useFormat();
  const { block, group, isFirst, isLast, seamAbove, seamBelow } = segment;

  const endMinutes = block.startMinutes + block.durationMinutes;
  const height = timeline.heightBetween(block.startMinutes, endMinutes);

  /*
   * A row with no surface left of its own: too short for the bar (`MIN_ACTIONS_HEIGHT`), or
   * too narrow for its buttons (`blockHoldsActions`). Either way the bar docks against the
   * OUTSIDE of the top edge, flush and still a DOM child so `:hover` survives out there, and
   * goes BELOW when there is nothing above the row but the sticky day header.
   */
  const buttonCount = 3 + (onCloseDay === undefined ? 0 : 1);
  const detached = height < MIN_ACTIONS_HEIGHT || !blockHoldsActions(blockWidth, buttonCount);
  const barBelow = detached && timeline.yOf(block.startMinutes) < ACTIONS_BAR_HEIGHT;

  /*
   * Every row states ITS OWN hours; what makes the unit one thing is visual, not arithmetic.
   * The ellipsis marks the HOLE and so reads `seamAbove` / `seamBelow`, never `isFirst` /
   * `isLast` — two rows that merely touch are one unit with no break between them.
   */
  const continuesBelow = seamBelow;
  const continuesAbove = seamAbove;
  const hoursLabel = continuesAbove
    ? t('block.continuesAbove', { hours: format.hourNumber(block.durationMinutes) })
    : overflow
      ? t('block.overflow', { hours: format.hourNumber(block.durationMinutes) })
      : continuesBelow
        ? t('block.continuesBelow', { hours: format.hourNumber(block.durationMinutes) })
        : format.hours(block.durationMinutes);

  /* A list of one: the row's tooltip is built by joining whatever lines the row has. */
  const markHints = [block.locked ? t('block.markLocked') : null].filter(
    (line): line is string => line !== null,
  );

  /*
   * The seam said in words: the label's ellipsis is quiet by design, and a `desborde 2 h`
   * row has no room for it at all, so the fact must not live only there.
   */
  const seamHints = [
    continuesAbove ? t('block.markContinuesAbove') : null,
    continuesBelow ? t('block.markContinuesBelow') : null,
  ].filter((line): line is string => line !== null);

  const classes = [
    styles.block,
    // Two independent questions on one edge: `first`/`last` round the unit's outer corners,
    // `continued`/`continuesBelow` dash the edge a real break falls on.
    isFirst ? styles.first : '',
    isLast ? styles.last : '',
    seamAbove ? styles.continued : '',
    seamBelow ? styles.continuesBelow : '',
    overflow ? styles.overflow : '',
    frozen ? styles.frozen : '',
    // Not merely the buttons: a press on the row cannot start a drag while a save is in flight.
    busy && !frozen ? styles.saving : '',
    lifted ? styles.lifted : '',
    block.locked ? styles.pinned : '',
    cutAtMinutes === undefined ? '' : styles.cutting,
    detached ? styles.detached : '',
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
      /*
       * The row's facts AND its gesture vocabulary: neither drag is discoverable by looking.
       * Withheld on a frozen day, where neither gesture is offered at all.
       */
      title={[
        format.dayTimeHours(block.date, block.startMinutes, block.durationMinutes),
        ...seamHints,
        ...markHints,
        ...(frozen
          ? [t('day.frozenHint')]
          : [t('block.drag'), t('block.resize')]),
      ].join('\n')}
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
      {/* Clipped on its own: the block does not clip, so the bar can hang outside a narrow one. */}
      <div className={styles.body}>
        <span className={styles.name}>{block.project.name}</span>
        {height >= MIN_LABEL_HEIGHT ? <span className={styles.hours}>{hoursLabel}</span> : null}
      </div>

      {/* The mark sits in the corner the action bar takes over on hover. One glyph, one state. */}
      {markHints.length === 0 ? null : (
        <span className={styles.marks} aria-hidden="true">
          {block.locked ? <IconLock size={13} stroke={1.9} /> : null}
        </span>
      )}

      {/* Positioned against the row's own top, so it lands on the minute the ghost starts at. */}
      {cutAtMinutes === undefined ? null : (
        <span
          className={styles.cutSeam}
          aria-hidden="true"
          style={{ top: `${timeline.heightBetween(block.startMinutes, cutAtMinutes)}px` }}
        />
      )}

      {frozen ? null : (
        <div
          className={[styles.actions, barBelow ? styles.actionsBelow : ''].filter(Boolean).join(' ')}
          // The bar sits ON the drag surface, so a press here starts the same drag as one on the
          // body. A press that does not travel is still the BUTTON's click.
          onPointerDown={onPointerDownActions}
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

      {/*
       * The bottom edge, in its two forms: it SIZES a row the engine does not lay out and
       * EXPLAINS on one it does. The same ten pixels either way, so a reach for a length never
       * lands on the body and becomes a move; none at all on a past row.
       *
       * On EVERY row of a unit, not only its last — a unit has one handle for the MOVE, but
       * its rows are separate rectangles with real bottom edges. What the edge sizes is the
       * STRETCH from this row's start, in net working minutes over the day's manual windows:
       * see `durationTo` and `maxDurationFrom` in geometry.ts.
       */}
      {frozen ? null : (
        <div
          className={styles.resize}
          role="separator"
          aria-label={t('block.resize')}
          title={t('block.resizeHint')}
          onPointerDown={onPointerDownResize}
        />
      )}
    </div>
  );
}
