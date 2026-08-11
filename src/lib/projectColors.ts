/**
 * The fixed project swatch set.
 *
 * CLAUDE.md: "Project colours are a fixed swatch picker built from
 * `--ww-project-1..8`. No free hex input — amber is reserved for the app itself
 * and a free picker would let a job blend into the interface."
 *
 * These are the eight values of `--ww-project-1..8` in
 * public/brand/workwise-tokens.css, in the same order. The token file stays the
 * authority for how a colour is PAINTED (fills, borders, tints); this list exists
 * because the API has to validate what it is asked to store, and a CSS custom
 * property is not readable from a route handler.
 *
 * Pure and dependency-free on purpose: the swatch picker imports the same
 * constant the API validates against, so the two can never drift.
 */
export const PROJECT_COLORS = [
  '#185FA5',
  '#1D9E75',
  '#D85A30',
  '#534AB7',
  '#A32D2D',
  '#0F6E56',
  '#D4537E',
  '#5F5E5A',
] as const;

export type ProjectColor = (typeof PROJECT_COLORS)[number];

/** The CSS custom property a swatch corresponds to, for `var()` in a component. */
export function projectColorToken(color: string): string | undefined {
  const index = PROJECT_COLORS.indexOf(color.trim().toUpperCase() as ProjectColor);
  return index === -1 ? undefined : `--ww-project-${index + 1}`;
}

/**
 * The swatch `value` names, or `undefined` when it names none. Case-insensitive,
 * because a hex arriving from a form or a hand-written request may be lower case;
 * storage is always upper case, like `Settings.gapColor`.
 */
export function normalizeProjectColor(value: string): ProjectColor | undefined {
  const candidate = value.trim().toUpperCase();
  return PROJECT_COLORS.find((color) => color === candidate);
}

export function isProjectColor(value: string): boolean {
  return normalizeProjectColor(value) !== undefined;
}
