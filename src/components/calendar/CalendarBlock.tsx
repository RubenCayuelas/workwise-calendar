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
 * THREE MARKS, NOT TWO (2026-08-12). `hand_placed` — "a human chose this DAY" — is a
 * third independent reason a row has stopped reflowing, and it needed its own glyph
 * rather than a shade of an existing one:
 *
 * | mark            | what it fixes | how it reads                                    |
 * |-----------------|---------------|-------------------------------------------------|
 * | padlock         | the POSITION  | never auto-moved, wherever it is; survives a drag |
 * | ruler           | the LENGTH    | plus a solid bottom edge — the edge that was dragged |
 * | pointing hand   | the DAY       | plus a solid border — the whole outline the owner drew |
 *
 * They are not combinable. A Friday row can be pinned with a perfectly automatic length,
 * and a Monday row can be hand-sized without anyone choosing Monday; folding the two
 * into one mark would make *back to automatic* ambiguous about what it gives back. What
 * IS folded is the ACTION: one release clears both hand marks, because neither is
 * visible in the geometry and pressing the wrong of two buttons would leave a row that
 * still would not move (CLAUDE.md, *A Hand-Placed Row*).
 *
 * The solid border also does the work of separating a hand-placed Friday row from an
 * engine-placed one on the very same column: `desborde 2 h` is drawn dashed.
 *
 * Every visible string comes from public/locales, and every number goes through
 * `useFormat()` so "6 h" and "2,5 h" are spelled the same here as in the job panel.
 */

import { useTranslation } from 'react-i18next';
import {
  IconClockStop,
  IconHandFinger,
  IconLock,
  IconLockOpen,
  IconRestore,
  IconRuler,
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
   * Placed on Friday BY THE ENGINE, i.e. work that grew past its estimate. Derived from
   * the buffer rule rather than stored: the colchón only ever holds overflow, a lock, or
   * a row a human pinned there — and the last of those carries `handPlaced` and reads as
   * that instead. See `isOverflow` in WeekGrid.
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
  /**
   * A press on the hover ACTION BAR, which floats over the block's own surface.
   *
   * It begins the same move as a press on the body, and it has to: the bar is 102 px wide
   * anchored at the block's right edge and it appears under the cursor on the first mouse
   * move, so on a weekend column (129 px) and on any weekday block from about 210 px down it
   * covers the block's NAME — the natural place to grab it. Swallowing the press there (which
   * is what this handler used to do) made the drag do nothing at all, silently.
   */
  onPointerDownActions: (event: React.PointerEvent) => void;
  onPointerDownResize: (event: React.PointerEvent) => void;
  onOpen: () => void;
  onToggleLock: () => void;
  /**
   * "Back to automatic": give the engine back whatever a hand gesture took from it on
   * this unit — a hand-set LENGTH, a hand-placed DAY, or both. Present exactly when some
   * row of the unit carries either mark. It never returns the queue POSITION; the row
   * keeps whatever place the calendar now gives it.
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
  onPointerDownActions,
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
  const { block, group, isFirst, isLast, seamAbove, seamBelow } = segment;

  const height = timeline.heightOf(block.durationMinutes);
  const endMinutes = block.startMinutes + block.durationMinutes;

  /*
   * Every row states ITS OWN hours, which is what the wireframe does on both of its
   * grouped units ("6 h" on a 6h row, "2 h · sigue" on the 2h continuation). A row that
   * announced the whole unit's total would be unreadable against its own height — "5 h"
   * inside a one-hour box. What makes the unit one thing is visual and behavioural: the
   * outer rounded corners, the dashed seam, one resize handle, and a drag that moves the
   * whole run.
   *
   * A UNIT CUT AT THE LUNCH BREAK IS MARKED AT BOTH ENDS (2026-08-13), which is the
   * owner's report: "en el de abajo coloca puntos suspensivos pero en el de arriba no,
   * quiero puntos suspensivos a ambos lados". Only the continuation said anything, so the
   * morning row read as a finished 4 h job and nothing on it hinted the work carried on
   * after lunch. Now the ellipsis sits on the side the work continues — trailing on the
   * row above, leading on the row below — and each end has its own tooltip line naming
   * which is which.
   *
   * IT IS THE HOLE THAT IS MARKED, NOT THE JOIN (fixed 2026-08-13, found by dragging). A
   * unit joins rows with nothing WORKABLE between them, which includes rows that simply
   * TOUCH — the scissors moving an hour into the top margin leaves `07:00-08:00`
   * hand-placed against `08:00-11:00`, and auto-merge may not fold a hand-placed row. Read
   * off `!isFirst` / `!isLast` the marks then drew a seam straight down the middle of one
   * unbroken rectangle and the tooltip announced a lunch break three hours away. So they
   * are read off `seamAbove` / `seamBelow` — a real gap on the clock — while the rounded
   * corners stay with `isFirst` / `isLast`, which is a different question.
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

  /*
   * ONE LINE PER MARK, each naming the mark and the single thing it fixes. Three marks
   * is a lot for one small rectangle, so the wording is what has to keep them apart:
   * "Bloqueado · el motor no lo mueve de aquí", "Duración fija · la longitud la has
   * puesto tú", "Colocado a mano · tú has elegido este día". Each icon carries its own
   * line, and the row's tooltip carries all the lines it has.
   */
  const markHints = [
    block.manualDuration ? t('block.markManualDuration') : null,
    block.handPlaced ? t('block.markHandPlaced') : null,
    block.locked ? t('block.markLocked') : null,
  ].filter((line): line is string => line !== null);

  /*
   * The seam, said in words. The ellipsis in the hours label is quiet by design — three
   * state marks, a name and an hour count already share this rectangle — so the tooltip
   * is where "sigue después de la comida" is spelled out. It is listed even on the one row
   * whose label has no room for the ellipsis (an engine-placed Friday row reading
   * `desborde 2 h`), so the fact is never unavailable.
   */
  const seamHints = [
    continuesAbove ? t('block.markContinuesAbove') : null,
    continuesBelow ? t('block.markContinuesBelow') : null,
  ].filter((line): line is string => line !== null);

  const classes = [
    styles.block,
    // Two independent questions on one edge: `first`/`last` round the unit's outer
    // corners, `continued`/`continuesBelow` dash the edge a real break falls on.
    isFirst ? styles.first : '',
    isLast ? styles.last : '',
    seamAbove ? styles.continued : '',
    seamBelow ? styles.continuesBelow : '',
    overflow ? styles.overflow : '',
    frozen ? styles.frozen : '',
    lifted ? styles.lifted : '',
    block.manualDuration ? styles.manual : '',
    block.handPlaced ? styles.handPlaced : '',
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
      title={[
        format.dayTimeHours(block.date, block.startMinutes, block.durationMinutes),
        ...seamHints,
        ...markHints,
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
      <span className={styles.name}>{block.project.name}</span>
      {height >= MIN_LABEL_HEIGHT ? <span className={styles.hours}>{hoursLabel}</span> : null}

      {/*
       * The three marks share the corner the action bar takes over on hover, and they
       * are independent states, so all three can be up at once: the padlock says the
       * engine may not MOVE this row, the ruler says it may not RESIZE it, the hand says
       * a human chose the DAY it is on.
       */}
      {markHints.length === 0 ? null : (
        <span className={styles.marks} aria-hidden="true">
          {block.manualDuration ? (
            <span className={styles.softMark} title={t('block.markManualDuration')}>
              <IconRuler size={13} stroke={1.9} />
            </span>
          ) : null}
          {block.handPlaced ? (
            <span className={styles.softMark} title={t('block.markHandPlaced')}>
              <IconHandFinger size={13} stroke={1.9} />
            </span>
          ) : null}
          {block.locked ? <IconLock size={13} stroke={1.9} /> : null}
        </span>
      )}

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
          // The bar sits ON the drag surface, so a press here starts the same drag a press on
          // the body would — the alternative was a dead grab point over the block's name on
          // every narrow column. A press that does not travel is still the BUTTON's click.
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
          {onReleaseDuration === undefined ? null : (
            // NOT the ruler-off glyph it used to be: the action gives back a hand-set
            // LENGTH and a hand-placed DAY together, so a ruler would name half of it
            // and would be plainly wrong on a Friday row of automatic length. `restore`
            // is about the undoing, which is the part both marks share.
            <IconButton
              size="sm"
              icon={<IconRestore size={13} stroke={1.9} />}
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
       * each with a real bottom edge on screen.
       *
       * WHAT THE EDGE SIZES is the STRETCH that begins at this row's start, in net working
       * minutes over the day's manual windows: the drag crosses the lunch break (the band
       * costs nothing) and may reach into the visual margins, and the server stores the
       * result cut at the break. So no drag can produce a row that straddles it, and the
       * cap is the end of the day rather than the end of this row's period — which is the
       * defect the owner reported. See `durationTo` and `maxDurationFrom` in geometry.ts.
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
