'use client';

/**
 * One row of a job on the grid, and the whole gesture vocabulary of a block:
 *
 * | gesture              | effect                                                    |
 * |----------------------|-----------------------------------------------------------|
 * | drag the body        | move the UNIT — reorders the queue, then the reflow runs  |
 * | drag the bottom edge | resize THIS ROW — only where the engine does not lay it out |
 * | click                | open the job panel                                         |
 * | hover                | the action bar: lock, stop the day here, split, delete      |
 *
 * The action bar is never behind a modifier key: "on a shop PC an Alt-drag would never
 * be discovered" (CLAUDE.md).
 *
 * THE BOTTOM EDGE SIZES ONLY A ROW THE ENGINE DOES NOT LAY OUT — one carrying a PADLOCK,
 * or one on a weekend. `resizable` is the caller's answer, and it is what the server
 * accepts: everywhere else `resizeBlock` refuses with `resize-needs-padlock`, and the app
 * must not offer what the server refuses.
 *
 * BUT THE EDGE IS STILL DRAWN, AND IT STILL ANSWERS. This reverses something the owner
 * asked for explicitly two days earlier, so the explanation is the feature — and a strip
 * that is simply not there does not explain, it just goes quiet twice over: the press falls
 * through to the block's body and a reach for a length RE-RANKS THE QUEUE instead. So the
 * inert edge keeps the row's bottom ten pixels, marks itself as a question rather than a
 * handle (`.resizeInert`: no `ns-resize` cursor, a grey hover pill instead of the job's
 * colour), and hands the press to the drag as `InertReason.automatic` — no ghost, nothing
 * written, a click still opens the job, and the first real travel says in two lines why the
 * length is not the owner's here and what does change the shape of a day: a GAP that ends
 * it early, another job behind this one, or the job's hours in its form. The padlock is the
 * fourth answer and the one this gesture wants: it fixes the row's length as well as its
 * place. THE APP NEVER MAKES THE GAP ITSELF — the refusal points at the action, the owner
 * presses it.
 *
 * ONE MARK, NOT TWO (2026-08-18), and not three (2026-08-14). `hand_placed` — a pointing
 * hand for "a human chose this DAY" — went first; `manual_duration`, drawn as a ruler for
 * "the length is mine", went with the bottom-edge drag's freedom to touch an automatic row,
 * and *back to automatic* went with it since there is no mark left to give back. What is
 * left is the padlock, which the owner already understands: padlock = fixed, no padlock =
 * free, and what it fixes is the row entire — where it sits AND how long it is.
 *
 * The padlock is also what separates a Friday row the owner put there from one the engine
 * parked: `desborde 2 h` is only ever drawn on a unit with no padlock in it.
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
   * THIS BLOCK'S OWN WIDTH IN PIXELS — its lane's share of the column — or `null` before
   * the grid has been measured.
   *
   * Read for exactly one decision: whether the hover action bar still leaves any of the
   * block to press (`blockHoldsActions`). A percentage cannot answer that, because the
   * bar is a fixed number of 24 px buttons; and the block's own element cannot answer it
   * either without a container query, which would make the block a containment context and
   * trap the bar that hangs outside it behind the next row along.
   */
  blockWidth: number | null;
  /**
   * Placed on Friday BY THE ENGINE, i.e. work that grew past its estimate. Derived from
   * the buffer rule rather than stored: the colchón only ever holds overflow, a lock, or
   * a row a human pinned there — and both of those carry a padlock and read as that
   * instead. See `isOverflow` in WeekGrid.
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
  /**
   * A mutation or a reload is in flight: the action bar locks so nothing is queued twice,
   * and the row stops offering a grab it cannot honour. A press is not swallowed either —
   * it says why nothing moved (`InertReason.busy`).
   */
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
  /**
   * THE SERVER WOULD ACCEPT A RESIZE OF THIS ROW: it carries a padlock, or it is on a
   * weekend, and it is not in the frozen past.
   *
   * The strip is drawn either way (except on a past row, where nothing is) and
   * `onPointerDownResize` is wired either way; this is what the strip SAYS. False: no resize
   * cursor, a muted hover pill, and a tooltip naming what does change a day instead of what
   * the drag would do. The press itself is inert on the caller's side
   * (`InertReason.automatic`), which is what keeps one gesture from quietly becoming the
   * other.
   */
  resizable: boolean;
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
  /*
   * THE RECTANGLE IS THE CLOCK INTERVAL THE ROW OCCUPIES, top and bottom read off the same
   * axis. No row straddles a break (CLAUDE.md, invariant 3), so this is `durationMinutes`
   * at the working scale to the pixel — the bottom edge, which is the resize handle, lands
   * exactly on the minute the row ends at even though the axis compresses the lunch band
   * somewhere else in the column.
   */
  const height = timeline.heightBetween(block.startMinutes, endMinutes);

  /*
   * A ROW WITH NO SURFACE LEFT OF ITS OWN, and what is done about it. TWO WAYS TO GET
   * THERE, one on each axis, and the same answer to both.
   *
   * TOO SHORT (`MIN_ACTIONS_HEIGHT`). The bar is 24 px anchored 3 px inside the top edge
   * and the resize handle owns the bottom; below 56 px they meet. A half-hour row is 24 px
   * at the default scale, so the bar covered ALL of it.
   *
   * TOO NARROW (`blockHoldsActions`, added 2026-08-14 — the same defect, still open on the
   * other axis). The bar is as wide as the buttons it is showing, up to four of them, and
   * it is anchored at the RIGHT edge: on a weekend column, and on any column once the
   * window is small enough, it covers the whole top of the block INCLUDING ITS NAME, which
   * is the owner's most natural place to press. The row is tall, so nothing above caught it.
   *
   * Either way the drag still started (a press on the bar begins the same move) but the
   * CLICK — the gesture that opens the job — could only land on a button, and down the
   * middle of the bar that button is *Cerrar el día aquí*. A gesture that quietly does
   * something else is worse than one that does nothing.
   *
   * So the bar leaves the block's hit area altogether and docks against the outside of its
   * top edge, flush, so the pointer can reach it without crossing a dead pixel (it stays a
   * DOM child, which is what keeps `:hover` alive out there). It goes BELOW instead when
   * the row is at the very top of the axis and there is nothing above it but the sticky day
   * header.
   */
  const buttonCount = 3 + (onCloseDay === undefined ? 0 : 1);
  const detached = height < MIN_ACTIONS_HEIGHT || !blockHoldsActions(blockWidth, buttonCount);
  const barBelow = detached && timeline.yOf(block.startMinutes) < ACTIONS_BAR_HEIGHT;

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
   * TOUCH — the scissors moving an hour into the top margin leaves a padlocked
   * `07:00-08:00` against `08:00-11:00`, and auto-merge never folds a padlocked row. Read
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
   * THE MARK, NAMED AND WITH THE THING IT FIXES — "Bloqueado · el motor no lo mueve de
   * aquí". A list of one since 2026-08-18, kept a list because the row's tooltip is built
   * by joining whatever lines the row has and the padlock's line has to travel with it.
   */
  const markHints = [block.locked ? t('block.markLocked') : null].filter(
    (line): line is string => line !== null,
  );

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
    // Not merely the buttons: while a save is in flight the whole row stops advertising a
    // drag, because a press on it cannot start one.
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
       * The tooltip carries the row's facts AND its gesture vocabulary. The two drags mean
       * different things and neither is discoverable by looking — a shop PC has no gesture
       * tutorial, so the hover is where "drag the body to change the queue position, drag
       * the bottom edge to change the length" has to be said. Withheld on a frozen day,
       * where neither gesture is offered at all.
       */
      title={[
        format.dayTimeHours(block.date, block.startMinutes, block.durationMinutes),
        ...seamHints,
        ...markHints,
        ...(frozen
          ? [t('day.frozenHint')]
          : [t('block.drag'), resizable ? t('block.resize') : t('block.lengthIsAutomatic')]),
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
      {/* Clipped on its own, because the block itself no longer clips — the action bar has
          to be able to hang outside a narrow one. See `.body` in the stylesheet. */}
      <div className={styles.body}>
        <span className={styles.name}>{block.project.name}</span>
        {height >= MIN_LABEL_HEIGHT ? <span className={styles.hours}>{hoursLabel}</span> : null}
      </div>

      {/*
       * The mark sits in the corner the action bar takes over on hover. One glyph, because
       * one state: the padlock says the engine neither moves this row nor re-derives its
       * length. Kept as a `marks` box so the corner keeps its geometry.
       */}
      {markHints.length === 0 ? null : (
        <span className={styles.marks} aria-hidden="true">
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
          style={{ top: `${timeline.heightBetween(block.startMinutes, cutAtMinutes)}px` }}
        />
      )}

      {frozen ? null : (
        <div
          className={[styles.actions, barBelow ? styles.actionsBelow : ''].filter(Boolean).join(' ')}
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
       * The bottom edge, in its two forms. It SIZES on a row the engine does not lay out;
       * on an automatic row the length IS the room the row has — dragging it there was a
       * gesture the reflow undid on the next save, and the mark that used to make it stick
       * is gone (2026-08-18) — so there it EXPLAINS. Same strip, same ten pixels, so the
       * reach never lands on the body and turns into a move. The padlock is how a row gets a
       * length the owner owns; a gap is how a day ends early.
       *
       * ON EVERY ROW OF A UNIT, not only its last. That is what makes shrinking the
       * MORNING half of a padlocked unit reachable: a unit has one handle for the MOVE,
       * because it is one thing to drag, but its rows are two rectangles with the lunch
       * band between them, each with a real bottom edge on screen.
       *
       * NOT DRAWN AT ALL ON A PAST ROW, which is the spec's own list: on a frozen day
       * "drag, resize, split, delete and the padlock are all refused there, and none of them
       * is drawn". Nothing is lost by that — the row's body answers a press with the same
       * sentence about the past — and it takes away the `ns-resize` cursor that used to
       * promise a gesture over the record of a day the shop has already worked.
       *
       * WHAT THE EDGE SIZES is the STRETCH that begins at this row's start, in net working
       * minutes over the day's manual windows: the drag crosses the lunch break (the band
       * costs nothing) and may reach into the visual margins, and the server stores the
       * result cut at the break. So no drag can produce a row that straddles it, and the
       * cap is the end of the day rather than the end of this row's period — which is the
       * defect the owner reported. See `durationTo` and `maxDurationFrom` in geometry.ts.
       */}
      {frozen ? null : resizable ? (
        <div
          className={styles.resize}
          role="separator"
          aria-label={t('block.resize')}
          title={t('block.resizeHint')}
          onPointerDown={onPointerDownResize}
        />
      ) : (
        /*
         * THE SAME TEN PIXELS, ANSWERING INSTEAD OF SIZING. Two lines on the hover and, the
         * moment the press travels, the same two in a toast with *Cerrar el día aquí* beside
         * them — one tap from where the gesture failed, and the owner is the one who presses
         * it. No role and no label: the strip is not a control, and the sentence is already
         * on the row's own tooltip for anything that reads the block rather than hovers it.
         */
        <div
          className={`${styles.resize} ${styles.resizeInert}`}
          aria-hidden="true"
          title={`${t('block.lengthIsAutomatic')}\n${t('block.lengthIsAutomaticHow')}`}
          onPointerDown={onPointerDownResize}
        />
      )}
    </div>
  );
}
