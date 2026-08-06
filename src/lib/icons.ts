// src/lib/icons.ts
// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.
//
// Thirteen hand-written glyphs. No icon library, no icon font, no sprite
// request, no runtime dependency — each export is the INNER markup of an
// SVG, and src/components/Icon.astro owns the wrapper. site.ts imports
// only the names it needs, so rolldown drops the rest from the client
// bundle.
//
// WHY THIS EXISTS AT ALL. The app's controls are text glyphs today
// (▶ +Q ♥ ↓ + ↑ ↓ ✕ ☰). A text glyph renders at whatever size the font
// decides, cannot be given a hit box of its own, and cannot take a colour
// independent of its label. All three are why the controls measured
// 9–30px before the 44px floor.
//
// GEOMETRY DOCTRINE, and it is not decoration:
//   viewBox 0 0 24 24 · fill="none" · stroke="currentColor"
//   stroke-width 2 (2.5 when rendered at 14px or under)
//   stroke-linecap="square" · stroke-linejoin="miter"
//
// Square terminals are border-radius: 0 applied to a line end. The set
// this borrows from uses round caps; substituting square is the single
// decision that makes these glyphs belong to this app. icons.test.ts
// asserts no glyph ever regresses to round.
//
// Transport glyphs are solid fills with NO stroke. A filled triangle and
// two bars are already brutalist primitives and read better at 16px than
// any outline does.
//
// Everything inherits currentColor, so a glyph is automatically white
// inside a .btn, red inside .btn-danger, and --ink-55 inside a meta run,
// with no per-context rule anywhere.
//
// ACCESSIBILITY, and it is a real regression risk rather than a nicety:
// the glyphs being replaced are TEXT NODES that a screen reader announces
// today. An <svg aria-hidden="true"> is silent. Every icon-only control
// must therefore carry its own aria-label, or it disappears from
// assistive tech the moment its glyph becomes an icon.

/**
 * `prev` is deliberately absent: it is `next` under
 * `transform: scaleX(-1)`, and the status `x` is `close` reused. Two
 * paths that must stay visually consistent will eventually stop being
 * consistent, so neither is written twice.
 */
export const ICONS = {
  // --- transport: solid fills, no stroke ---------------------------
  play: '<path d="M8 5 L20 12 L8 19 Z" fill="currentColor" />',

  pause:
    '<rect x="7" y="5" width="3.5" height="14" fill="currentColor" />' +
    '<rect x="13.5" y="5" width="3.5" height="14" fill="currentColor" />',

  next:
    '<path d="M6 5 L16 12 L6 19 Z" fill="currentColor" />' +
    '<rect x="17" y="5" width="2.5" height="14" fill="currentColor" />',

  // --- squares, because a dot is a circle and circles are not ours --
  /** Three squares. The owner asked for three-dot menus; these are the dots. */
  kebab:
    '<rect x="10.75" y="4.5" width="2.5" height="2.5" fill="currentColor" />' +
    '<rect x="10.75" y="10.75" width="2.5" height="2.5" fill="currentColor" />' +
    '<rect x="10.75" y="17" width="2.5" height="2.5" fill="currentColor" />',

  /** Two rows of three squares — the reorder handle. */
  drag:
    '<rect x="6" y="9" width="2" height="2" fill="currentColor" />' +
    '<rect x="11" y="9" width="2" height="2" fill="currentColor" />' +
    '<rect x="16" y="9" width="2" height="2" fill="currentColor" />' +
    '<rect x="6" y="14" width="2" height="2" fill="currentColor" />' +
    '<rect x="11" y="14" width="2" height="2" fill="currentColor" />' +
    '<rect x="16" y="14" width="2" height="2" fill="currentColor" />',

  // --- stroked ------------------------------------------------------
  /** Three lines and a plus. Replaces the `+Q` text control. */
  'queue-add':
    '<path d="M4 7h13 M4 12h13 M4 17h8 M17 14v7 M13.5 17.5h7" fill="none" ' +
    'stroke="currentColor" stroke-width="2" stroke-linecap="square" stroke-linejoin="miter" />',

  /**
   * Angular, not lobed: a heart drawn with straight segments is the only
   * version of this shape that belongs in a 90 degree system. Stroked at
   * rest so the liked state can FILL it — which is why it is not a filled
   * primitive like the transport glyphs.
   */
  heart:
    '<path d="M12 20 L4 12 L4 7 L8 5 L12 8 L16 5 L20 7 L20 12 Z" fill="none" ' +
    'stroke="currentColor" stroke-width="2" stroke-linecap="square" stroke-linejoin="miter" />',

  download:
    '<path d="M12 4v11 M7 11 l5 5 l5 -5 M4 20h16" fill="none" ' +
    'stroke="currentColor" stroke-width="2" stroke-linecap="square" stroke-linejoin="miter" />',

  upload:
    '<path d="M12 20V9 M7 13 l5 -5 l5 5 M4 4h16" fill="none" ' +
    'stroke="currentColor" stroke-width="2" stroke-linecap="square" stroke-linejoin="miter" />',

  /** A SQUARE lens. A round one would be the only curve in the app. */
  search:
    '<path d="M4 4h11v11H4Z M15 15 l5 5" fill="none" ' +
    'stroke="currentColor" stroke-width="2" stroke-linecap="square" stroke-linejoin="miter" />',

  /** Also serves as the status `x`. One path, two jobs. */
  close:
    '<path d="M5 5 l14 14 M19 5 L5 19" fill="none" ' +
    'stroke="currentColor" stroke-width="2" stroke-linecap="square" stroke-linejoin="miter" />',

  /** An open-top box, seen slightly from above — a record crate. */
  crate:
    '<path d="M3 8h18 M4.5 8 l1 12 h13 l1 -12 M3 8 l2 -4 h14 l2 4" fill="none" ' +
    'stroke="currentColor" stroke-width="2" stroke-linecap="square" stroke-linejoin="miter" />',

  /** 2.5 rather than 2: a tick is mostly diagonal and thins optically. */
  check:
    '<path d="M4 12 l5 5 L20 6" fill="none" ' +
    'stroke="currentColor" stroke-width="2.5" stroke-linecap="square" stroke-linejoin="miter" />',
} as const

export type IconName = keyof typeof ICONS

/** Every name, for iteration and for exhaustive tests. */
export const ICON_NAMES = Object.keys(ICONS) as IconName[]

/**
 * The glyph's inner markup, with the two variants applied.
 *
 * Lives here rather than in Icon.astro so it can be tested without a
 * renderer, and because both variants are traps that are easy to get
 * wrong in CSS:
 *
 * 1. `stroke-width` on the wrapping `<svg>` does NOT override a
 *    `stroke-width` attribute on a child path — a presentation attribute
 *    on the element beats an inherited one.
 * 2. Markup inserted with Astro's `set:html` is never processed by the
 *    style scoper, so a scoped `.icon path { … }` rule matches nothing.
 *
 * @param small  Rendered at 14px or under. A 2px stroke scaled to 12px is
 *               a hairline and the set stops reading as one family.
 *               `check` already declares 2.5 and is left alone.
 * @param filled `heart` only — the liked state. The same path, painted;
 *               never a second glyph.
 */
export function renderGlyph(
  name: IconName,
  { small = false, filled = false }: { small?: boolean; filled?: boolean } = {},
): string {
  let markup: string = ICONS[name]
  if (small) markup = markup.replaceAll('stroke-width="2"', 'stroke-width="2.5"')
  if (filled) markup = markup.replaceAll('fill="none"', 'fill="currentColor"')
  return markup
}
