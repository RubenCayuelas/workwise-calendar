/**
 * The calendar every suite is written against: the wireframe's week, Monday 10 to Sunday 16
 * August 2026, with the days either side of it that the horizon tests need.
 *
 * Declared here because nine test files were declaring it, and two of them had drifted: one called
 * `2026-08-20` THURSDAY while the rest call `2026-08-13` THU, so the same word meant two days
 * depending on the file it was read in.
 */

export const LAST_WED = '2026-08-05';
export const LAST_FRI = '2026-08-07';

export const MON = '2026-08-10';
export const TUE = '2026-08-11';
export const WED = '2026-08-12';
export const THU = '2026-08-13';
export const FRI = '2026-08-14';
export const SAT = '2026-08-15';
export const SUN = '2026-08-16';

export const NEXT_MON = '2026-08-17';
export const NEXT_TUE = '2026-08-18';
export const NEXT_WED = '2026-08-19';
export const NEXT_THU = '2026-08-20';

/** Past the planning horizon of a default-settings calendar, for the rollback tests. */
export const FAR_MON = '2026-09-07';
