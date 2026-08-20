/**
 * The fixed project swatch set: the eight values of `--ww-project-1..8` in
 * public/brand/workwise-tokens.css, in that order. The token file stays the authority for
 * how a colour is PAINTED; this list exists because the API has to validate what it stores
 * and a CSS custom property is not readable from a route handler. Pure and dependency-free
 * so the swatch picker can import the same constant and the two cannot drift.
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

/**
 * The swatch `value` names, or `undefined` when it names none. Case-insensitive because a
 * hex from a form may be lower case; storage is upper case, like `Settings.gapColor`.
 */
export function normalizeProjectColor(value: string): ProjectColor | undefined {
  const candidate = value.trim().toUpperCase();
  return PROJECT_COLORS.find((color) => color === candidate);
}
