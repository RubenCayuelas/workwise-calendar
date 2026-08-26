/**
 * The paint gesture as a state machine. It had no test at all until 2026-08-21: the suite runs in
 * `node` with no jsdom, so the only way to reach the threshold, the refuse-once rule and the
 * click-versus-paint fork is to keep them out of the hook.
 */

import { describe, expect, it } from 'vitest';
import { hhmmToMinutes as t } from '../../lib/dates';
import { manualWindowsOf } from '../../lib/manualWindow';
import { DRAG_THRESHOLD_PX } from './geometry';
import {
  bandStartAt,
  paintRefusalFor,
  paintStep,
  paintedSpan,
  type PaintEffect,
  type PaintRefusal,
  type PaintState,
} from './paintSession';
import { WED } from '../../testing/fixtures';

const WINDOWS = manualWindowsOf(
  [
    { startMinutes: t('08:00'), endMinutes: t('14:00') },
    { startMinutes: t('15:30'), endMinutes: t('19:30') },
  ],
  60,
  60,
);

const IDLE: PaintState = { phase: 'idle' };

function press(refusal: PaintRefusal | null = null) {
  return paintStep(IDLE, {
    kind: 'press',
    date: WED,
    origin: { x: 100, y: 200 },
    anchorMinutes: t('10:00'),
    windows: WINDOWS,
    refusal,
  });
}

/** A move far enough to pass the threshold, landing on `to`. */
function moveTo(state: PaintState, to: string, dy = DRAG_THRESHOLD_PX + 10) {
  return paintStep(state, {
    kind: 'move',
    at: { x: 100, y: 200 + dy },
    minutes: t(to),
  });
}

function kinds(effects: readonly PaintEffect[]): string[] {
  return effects.map((effect) => effect.kind);
}

describe('the paint gesture state machine', () => {
  it('a press alone paints nothing and says nothing', () => {
    const { state, effects } = press();

    expect(state.phase).toBe('pressed');
    expect(effects).toEqual([]);
  });

  it('travel under the threshold is not yet a paint', () => {
    const pressed = press().state;
    const { state, effects } = moveTo(pressed, '12:00', DRAG_THRESHOLD_PX - 1);

    expect(state.phase).toBe('pressed');
    expect(effects).toEqual([]);
  });

  it('a press that never travelled is a CLICK, not an empty paint', () => {
    const pressed = press().state;
    const { state, effects } = paintStep(pressed, { kind: 'release' });

    expect(kinds(effects)).toEqual(['unlisten', 'clicked']);
    expect(state.phase).toBe('idle');
  });

  it('the click carries the minute under the press, unsnapped', () => {
    // The rail lies over the rows, so the answer is whatever is on the row there — which cannot be
    // worked out from the date alone. Unsnapped, because the question is what the pointer is OVER.
    const pressed = paintStep(IDLE, {
      kind: 'press',
      date: WED,
      origin: { x: 100, y: 200 },
      anchorMinutes: t('10:52'),
      windows: WINDOWS,
      refusal: null,
    }).state;
    const { effects } = paintStep(pressed, { kind: 'release' });

    expect(effects).toContainEqual({ kind: 'clicked', date: WED, minutes: t('10:52') });
  });

  it('draws the band once the pointer has travelled', () => {
    const { state } = moveTo(press().state, '13:00');

    expect(state.phase).toBe('painting');
    expect(state.painted).toEqual({
      date: WED,
      startMinutes: t('10:00'),
      durationMinutes: 3 * 60,
    });
  });

  it('paints upwards exactly as readily as downwards', () => {
    const { state } = moveTo(press().state, '08:00');

    expect(state.painted).toEqual({
      date: WED,
      startMinutes: t('08:00'),
      durationMinutes: 2 * 60,
    });
  });

  it('crosses the lunch break for free: the band is NET working minutes', () => {
    const { state } = moveTo(press().state, '17:30');

    // 10:00-14:00 plus 15:30-17:30, never 7.5 h.
    expect(state.painted?.durationMinutes).toBe(6 * 60);
  });

  it('a refusal speaks exactly once, however far the pointer wanders', () => {
    const pressed = press('past').state;
    const first = moveTo(pressed, '12:00');
    const second = moveTo(first.state, '13:00');

    expect(first.effects).toEqual([{ kind: 'refused', reason: 'past', date: WED }]);
    expect(second.effects).toEqual([]);
    expect(first.state.painted).toBeUndefined();
  });

  it('a refused press that travelled does NOT also deliver a click', () => {
    // A gesture that cannot write says so once and does not also do the other thing.
    const refused = moveTo(press('busy').state, '12:00').state;
    const { effects } = paintStep(refused, { kind: 'release' });

    expect(kinds(effects)).toEqual(['unlisten']);
  });

  it('the release KEEPS the band and asks what it is', () => {
    const painting = moveTo(press().state, '13:00').state;
    const { state, effects } = paintStep(painting, { kind: 'release' });

    expect(kinds(effects)).toEqual(['unlisten', 'painted']);
    // The whole point of separating `unlisten` from `ended`: the listeners come off, the band stays.
    expect(state.phase).toBe('choosing');
    expect(state.painted).toEqual({
      date: WED,
      startMinutes: t('10:00'),
      durationMinutes: 3 * 60,
    });
  });

  it('hands the release POINT over, so the question can be asked where the mouse is', () => {
    const painting = moveTo(press().state, '13:00').state;
    const { effects } = paintStep(painting, { kind: 'release' });
    const painted = effects.find((effect) => effect.kind === 'painted');

    expect(painted?.kind === 'painted' ? painted.at : null).toEqual({ x: 100, y: 214 });
  });

  it('a press that TRAVELLED but drew no band is still a click', () => {
    // The create rail lies over 21 px of every row, and the drag layer answers a wobble with 12 px of
    // click slop. Without this, those pixels swallowed the click the row itself used to answer.
    const wandered = moveTo(press().state, '10:05').state;
    const { state, effects } = paintStep(wandered, { kind: 'release' });

    expect(effects).toContainEqual({ kind: 'clicked', date: WED, minutes: t('10:00') });
    expect(state).toEqual(IDLE);
  });

  it('a band under a quarter of an hour is a press that wandered, not a gesture', () => {
    // Both ends snap to 10:00, so there is nothing to draw. The smallest band that can exist is
    // exactly one quarter, because the snap is what the floor is reached through.
    const painting = moveTo(press().state, '10:05').state;
    // While the pointer is still down there is a session but no band to draw.
    expect(painting.painted).toBeNull();

    const { state, effects } = paintStep(painting, { kind: 'release' });

    expect(state).toEqual(IDLE);
    // No band — and the click above, which is the only thing left for it to be.
    expect(kinds(effects)).toEqual(['unlisten', 'clicked']);
  });

  it('a single quarter of an hour IS a band', () => {
    const { state } = moveTo(press().state, '10:10');

    expect(state.painted?.durationMinutes).toBe(15);
  });

  it('a cancel commits nothing, from any phase', () => {
    for (const state of [press().state, moveTo(press().state, '13:00').state]) {
      const cancelled = paintStep(state, { kind: 'cancel' });

      expect(kinds(cancelled.effects)).toEqual(['unlisten']);
      expect(cancelled.state).toEqual(IDLE);
    }
  });

  it('a cancel while the question is open takes the band with it', () => {
    const choosing = paintStep(moveTo(press().state, '13:00').state, { kind: 'release' }).state;
    const { state } = paintStep(choosing, { kind: 'cancel' });

    expect(state).toEqual(IDLE);
  });

  it('answering the question ends the gesture', () => {
    const choosing = paintStep(moveTo(press().state, '13:00').state, { kind: 'release' }).state;
    const { state, effects } = paintStep(choosing, { kind: 'dismiss' });

    expect(state).toEqual(IDLE);
    expect(effects).toEqual([]);
  });

  it('ignores a second press while the question is still open', () => {
    // Otherwise the press that dismisses the chooser starts a paint underneath it.
    const choosing = paintStep(moveTo(press().state, '13:00').state, { kind: 'release' }).state;
    const { state, effects } = paintStep(choosing, {
      kind: 'press',
      date: WED,
      origin: { x: 0, y: 0 },
      anchorMinutes: t('09:00'),
      windows: WINDOWS,
      refusal: null,
    });

    expect(state).toEqual(choosing);
    expect(effects).toEqual([]);
  });

  it('ignores a move that arrives with no session', () => {
    expect(moveTo(IDLE, '13:00')).toEqual({ state: IDLE, effects: [] });
  });
});

describe('bandStartAt', () => {
  it('snaps to the quarter hour', () => {
    expect(bandStartAt(WINDOWS, t('10:52'))).toBe(t('10:45'));
    expect(bandStartAt(WINDOWS, t('10:53'))).toBe(t('11:00'));
  });

  it('moves a minute inside the lunch break forward to the afternoon', () => {
    expect(bandStartAt(WINDOWS, t('14:30'))).toBe(t('15:30'));
  });

  it('takes a margin at its face value, the margins being inside the windows', () => {
    expect(bandStartAt(WINDOWS, t('07:15'))).toBe(t('07:15'));
    expect(bandStartAt(WINDOWS, t('20:00'))).toBe(t('20:00'));
  });

  it('is the same minute a band released there would start on', () => {
    // The reveal names it before the press. If these two could differ, the pointer would promise an
    // hour the release does not use.
    for (const minute of [t('07:10'), t('09:00'), t('13:55'), t('14:20'), t('16:40')]) {
      // Three hours, so neither end can snap onto the other and collapse the band.
      const span = paintedSpan(WINDOWS, minute, minute + 180);
      expect(span?.startMinutes).toBe(bandStartAt(WINDOWS, minute));
    }
  });
});

describe('paintRefusalFor', () => {
  it('refuses the past and a save in flight, and nothing else', () => {
    expect(paintRefusalFor({ isPast: true }, true)).toBe('past');
    expect(paintRefusalFor({ isPast: false }, false)).toBe('busy');
    expect(paintRefusalFor({ isPast: false }, true)).toBeNull();
  });

  it('the past outranks a save in flight', () => {
    expect(paintRefusalFor({ isPast: true }, false)).toBe('past');
  });

  it('a CLOSED day and the weekend take a band', () => {
    // The rule the owner set on 2026-08-26. The signature is half the guarantee — the function is never
    // handed `isClosed` at all — and these are days carrying it, to say so where it can be read.
    const closed = { isPast: false, isClosed: true };
    const weekend = { isPast: false, isWeekend: true, role: 'manual' as const };

    expect(paintRefusalFor(closed, true)).toBeNull();
    expect(paintRefusalFor(weekend, true)).toBeNull();
  });
});
