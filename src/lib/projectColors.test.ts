import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { PROJECT_COLORS, normalizeProjectColor } from './projectColors';

/**
 * The two surfaces a block is drawn on. A swatch is painted twice on each: as a hairline border and
 * the padlock mark at full strength, and as a fill of itself mixed into the surface. The border is
 * the whole of what identifies a job on a short row, so it is the one that has to hold up.
 */
const LIGHT_SURFACE = '#ffffff';
const DARK_SURFACE = '#1e1e1c';

/** Values a job must not be mistaken for: the app's own accent, and the colour every gap is. */
const BRAND_AMBER = '#ef9f27';
const GAP_FILL = '#d3d1c7';

function channels(hex: string): [number, number, number] {
  const raw = hex.replace('#', '');
  return [0, 2, 4].map((at) => parseInt(raw.slice(at, at + 2), 16)) as [number, number, number];
}

function linear(value: number): number {
  const unit = value / 255;
  return unit <= 0.04045 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  const [r, g, b] = channels(hex).map(linear);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (high + 0.05) / (low + 0.05);
}

/** CIE L*a*b*, so "how far apart do these look" is one number rather than three channels. */
function lab(hex: string): [number, number, number] {
  const [r, g, b] = channels(hex).map(linear);
  const x = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047;
  const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883;
  const f = (t: number): number => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
}

function distance(a: string, b: string): number {
  const [first, second] = [lab(a), lab(b)];
  return Math.hypot(...first.map((value, at) => value - second[at]));
}

describe('the job swatches', () => {
  it('is eight distinct upper-case hex values', () => {
    expect(PROJECT_COLORS).toHaveLength(8);
    expect(new Set(PROJECT_COLORS).size).toBe(8);
    for (const color of PROJECT_COLORS) expect(color).toMatch(/^#[0-9A-F]{6}$/);
  });

  /**
   * The yellow, which the owner asked to be a true yellow and not the gold that the rule below
   * produces: `Es más bien dorado, hazlo un poco más amarillo aún, que desencaje un poco con la
   * lógica de colores`. Yellow carries more luminance than any other hue at the same saturation, so
   * one bright enough to read as yellow cannot also be dark enough to clear 3:1 on white — the two
   * are the same dial. The exception is theirs and it is named, not widened: the other seven still
   * hold the rule, this one still holds it against the dark surface, and the floor here keeps a
   * later nudge from quietly walking it down to a border nobody can see.
   */
  const TRUE_YELLOW = '#C0B002';
  const YELLOW_FLOOR_ON_WHITE = 2.2;

  it.each(PROJECT_COLORS)('%s stays visible on both surfaces', (color) => {
    // 3:1, the floor for a graphic that carries meaning. The border and the padlock mark are drawn
    // in the swatch itself, so a value that fails here is a job whose colour cannot be read at all
    // on that theme — which is what five of the previous eight did against the dark surface.
    const floor = color === TRUE_YELLOW ? YELLOW_FLOOR_ON_WHITE : 3;
    expect(contrast(color, LIGHT_SURFACE)).toBeGreaterThanOrEqual(floor);
    expect(contrast(color, DARK_SURFACE)).toBeGreaterThanOrEqual(3);
  });

  it('takes the exception on the yellow and nowhere else', () => {
    // Guards the exception itself: it is spent on the swatch it was granted for, and the day the
    // yellow is retired or repainted this fails rather than silently covering its replacement.
    expect(PROJECT_COLORS).toContain(TRUE_YELLOW);
    const below = PROJECT_COLORS.filter((color) => contrast(color, LIGHT_SURFACE) < 3);
    expect(below).toEqual([TRUE_YELLOW]);
  });

  it.each(PROJECT_COLORS)('%s is not mistakable for the accent or for a gap', (color) => {
    expect(distance(color, BRAND_AMBER)).toBeGreaterThanOrEqual(30);
    expect(distance(color, GAP_FILL)).toBeGreaterThanOrEqual(30);
  });

  it('keeps every pair apart in the pale fill, which is the hardest read', () => {
    // The fill is the swatch mixed into the surface at `--ww-block-tint-strength`, so eight
    // saturated values collapse into eight very close washes — this is where two jobs start looking
    // alike long before their borders do. The pair that retired with the old palette sat at 2.1
    // here, which is no difference at all. The strength is READ rather than written down: raising
    // it is how a block is made to show more, and a copy here would stop testing the real fill.
    const globals = fs.readFileSync(path.join(process.cwd(), 'app', 'globals.css'), 'utf8');
    const strength = Number(globals.match(/--ww-block-tint-strength:\s*(\d+)%/)?.[1]) / 100;
    expect(strength).toBeGreaterThan(0);

    const wash = (color: string): string => {
      const mixed = channels(color).map((value, at) =>
        Math.round(value * strength + channels(LIGHT_SURFACE)[at] * (1 - strength)),
      );
      return `#${mixed.map((value) => value.toString(16).padStart(2, '0')).join('')}`;
    };
    for (const [at, color] of PROJECT_COLORS.entries()) {
      for (const other of PROJECT_COLORS.slice(at + 1)) {
        expect(distance(wash(color), wash(other))).toBeGreaterThanOrEqual(4);
      }
    }
  });

  it('is the same list, in the same order, as --ww-project-1..8', () => {
    // The constant exists only because a route handler cannot read a custom property. Nothing else
    // holds the two in step, and a swatch that paints one colour and validates as another is
    // invisible until the owner reports a job that will not save.
    const tokens = fs.readFileSync(
      path.join(process.cwd(), 'public', 'brand', 'workwise-tokens.css'),
      'utf8',
    );
    const declared = PROJECT_COLORS.map((_, at) => {
      const match = tokens.match(new RegExp(`--ww-project-${at + 1}:\\s*(#[0-9a-fA-F]{6})`));
      return match?.[1].toUpperCase();
    });
    expect(declared).toEqual([...PROJECT_COLORS]);
  });

  it('names every swatch in both locales', () => {
    for (const locale of ['es', 'en']) {
      const strings = JSON.parse(
        fs.readFileSync(path.join(process.cwd(), 'public', 'locales', locale, 'common.json'), 'utf8'),
      ) as { colors: Record<string, string> };
      const named = PROJECT_COLORS.map((_, at) => strings.colors[String(at + 1)]);
      expect(named.filter(Boolean)).toHaveLength(PROJECT_COLORS.length);
    }
  });
});

describe('normalizeProjectColor', () => {
  it('accepts a swatch in either case and names nothing else', () => {
    expect(normalizeProjectColor(PROJECT_COLORS[0].toLowerCase())).toBe(PROJECT_COLORS[0]);
    expect(normalizeProjectColor(` ${PROJECT_COLORS[3]} `)).toBe(PROJECT_COLORS[3]);
    expect(normalizeProjectColor('#123456')).toBeUndefined();
    // A value from the retired palette: stored rows are repainted when the database is opened, so
    // nothing should still be offering one.
    expect(normalizeProjectColor('#185FA5')).toBeUndefined();
  });
});
