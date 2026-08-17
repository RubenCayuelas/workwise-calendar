import { describe, expect, it } from 'vitest';
import { snapWithinBounds } from './stepper';

const HALF_HOUR = { step: 0.5 };

describe('snapWithinBounds', () => {
  it('snaps to the step', () => {
    expect(snapWithinBounds(2.4, HALF_HOUR)).toBe(2.5);
    expect(snapWithinBounds(2.2, HALF_HOUR)).toBe(2);
    expect(snapWithinBounds(6, HALF_HOUR)).toBe(6);
  });

  it('holds the value inside its bounds', () => {
    expect(snapWithinBounds(99, { step: 0.5, min: 0, max: 2 })).toBe(2);
    expect(snapWithinBounds(-3, { step: 0.5, min: 0, max: 2 })).toBe(0);
  });

  /**
   * THE ONE THAT WAS BROKEN. The Settings capacity's max is the shift, and quarter-hour
   * period times make a 9.75 h shift ordinary. Bounding before snapping returned 10 for a
   * value already sitting on the limit, so focus + click-away raised the capacity above
   * the shift on its own and the screen then asked to lower it again.
   */
  it('never returns a value outside a bound that is off the step grid', () => {
    expect(snapWithinBounds(9.75, { step: 0.5, min: 1, max: 9.75 })).toBe(9.75);
    expect(snapWithinBounds(10, { step: 0.5, min: 1, max: 9.75 })).toBe(9.75);
    expect(snapWithinBounds(13.25, { step: 0.5, min: 0.5, max: 13.25 })).toBe(13.25);
    // And the same at the bottom: a floor of a quarter hour is not rounded up to a half.
    expect(snapWithinBounds(0.25, { step: 0.5, min: 0.25, max: 0.25 })).toBe(0.25);
    expect(snapWithinBounds(0.1, { step: 0.5, min: 0.25 })).toBe(0.25);
  });

  it('leaves a value already on the grid alone, bounds or not', () => {
    expect(snapWithinBounds(10, { step: 0.5, min: 1, max: 10 })).toBe(10);
    expect(snapWithinBounds(10, { step: 0.5, min: 1, max: 6 })).toBe(6);
  });

  it('does not divide by zero when a caller passes step 0', () => {
    expect(snapWithinBounds(2.4, { step: 0 })).toBe(2);
  });
});
