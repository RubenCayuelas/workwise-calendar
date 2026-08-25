/**
 * The fixed project swatch set: the eight values of `--ww-project-1..8` in
 * public/brand/workwise-tokens.css, in that order. The token file stays the authority for
 * how a colour is PAINTED; this list exists because the API has to validate what it stores
 * and a CSS custom property is not readable from a route handler. Pure and dependency-free
 * so the swatch picker can import the same constant and the two cannot drift.
 */
export const PROJECT_COLORS = [
  '#1EA42B',
  '#3087DF',
  '#D1292F',
  '#9B8508',
  '#ED6212',
  '#8D56CD',
  '#DE2189',
  '#867B69',
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
