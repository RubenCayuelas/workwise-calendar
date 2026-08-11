# Workwise — Brand Guidelines

## The Symbol

Three vertical bars of different heights representing the workshop's weekly workload.
The third, the shortest bar, is always amber. It represents the free capacity — the days you can still sell.

Fixed proportions: bars are 10 units wide with 4 units spacing, rounded corners with radius 5 (perfect semicircle).
Heights: 26 / 36 / 18. Do not change them — the irregular rhythm is what makes it read as a week,
not just a generic chart.

## Color

| Role | Hex | Usage |
|------|-----|-------|
| Amber | `#EF9F27` | The only fixed brand color. Short bar, accents, active states. |
| Graphite | `#2C2C2A` | Structural color on light backgrounds: long bars, logotype, text. |
| Bone | `#F1EFE8` | Replaces graphite on dark backgrounds. Never pure white. |

Graphite is **not** a brand color; it's ink. In dark mode, swap it for bone and you're done.
Amber never changes.

**Contrast warning:** Amber on white = 2.1:1 contrast ratio. Not suitable for text or thin lines.
For amber text on light backgrounds, use `#854F0B` (`--ww-amber-ink`). Use pure amber only in
solid masses: bars, fills, buttons with graphite text on top.

## Typography

Barlow SemiBold (600) for the logotype, with letter spacing of −0.35 px at 27 px.
Already converted to outlines in the SVG files, so files don't depend on the font being installed.
If you need Barlow for the interface: `npm i @fontsource/barlow`.

## Clear Space

Leave at minimum one bar width (10 units, or 26% of symbol height) of clear space around the logo.
When in doubt, leave more.

## Minimum Sizes

- Symbol alone: 16 px height.
- Horizontal lockup: 100 px width. Below that, use symbol only.
- Vertical lockup: 72 px width.

## Do Not

- Don't put amber in the long bars or graphite in the short bar.
- Don't stretch the logo or change the relative heights of the bars.
- Don't place it over photos or mid-tone backgrounds: use white, bone, or graphite only.
- Don't use amber as a project color in the calendar. It's reserved for the app itself,
  and an amber job would blend in with the interface.
- Don't add shadows, gradients, or outlines.

## Files

| File | Purpose |
|------|---------|
| `workwise-logo-light.svg` | Horizontal lockup on light background. |
| `workwise-logo-dark.svg` | Horizontal lockup on dark background. |
| `workwise-logo.svg` | Lockup with `currentColor`: inherits container color. |
| `workwise-logo-mono.svg` | Single ink, for invoices, stamps, or engraving. |
| `workwise-logo-vertical-light.svg` / `-dark.svg` | Vertical lockup. |
| `workwise-wordmark.svg` | Logotype only, no symbol. |
| `workwise-icon-light.svg` / `-dark.svg` / `.svg` / `-mono.svg` | Symbol alone, 48×48. |
| `workwise-favicon.svg` | Favicon with graphite background. |
| `workwise-favicon-32.png` / `-16.png` | Fallback for older browsers. |
| `workwise-apple-touch-icon-180.png` | iOS home screen icon. |
| `workwise-appicon-512.png` | PWA manifest icon. |
| `workwise-tokens.css` | Color variables, including project palette. |

## How to Integrate into the Project

Copy everything to `public/brand/` (and favicon to `public/`). In Next.js 15 with App Router:

```tsx
// app/layout.tsx
export const metadata = {
  title: "Workwise",
  icons: {
    icon: [
      { url: "/workwise-favicon.svg", type: "image/svg+xml" },
      { url: "/workwise-favicon-32.png", sizes: "32x32" },
    ],
    apple: "/workwise-apple-touch-icon-180.png",
  },
};
```

Import `workwise-tokens.css` before your global styles, and use `--ww-logo-ink` so the logo
with `currentColor` automatically switches between light and dark mode:

```tsx
<img src="/brand/workwise-logo.svg" alt="Workwise" className="ww-logo" />
```
