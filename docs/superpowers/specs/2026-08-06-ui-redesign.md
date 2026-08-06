# UI redesign — the design system

Date: 2026-08-06. Companion plan:
[`2026-08-06-10-ui-redesign.md`](../plans/2026-08-06-10-ui-redesign.md).

Inputs: the RealDose design study (`.superpowers/sdd/ui-realdose-study.md`) and
the measured audit of this app (`.superpowers/sdd/ui-audit.md`). This document
is the *system*; the plan is the *order of work*. Nothing here is a task.

## 0. The mandate, and its exact edges

The owner, verbatim across three messages:

> the UI is "shabby looking and the performance is bad… unacceptable"

> "the colour scheme stays same. monochrome. the lines and angles stay the same
> 90 degree. what changes are animations and borders" — and, later, "buttons and
> icons"

> "give me a good website that looks nice on a phone… use tricks like modals and
> three dot menus"

Reference points named by the owner: **SoundCloud** and **Apple Music**, mobile.

### 0.1 Frozen — do not touch

| Frozen | Where it lives today |
|---|---|
| The six greyscale tokens: `--bg #fff`, `--fg #000`, `--mid #555`, `--line #000`, `--faint #ddd`, `--zebra #f4f4f4` | `global.css:12-18` |
| The four button colours: `--btn-blue #0b57d0`, `--btn-blue-line #0842a0`, `--btn-red #c0392b`, `--btn-red-line #962d22` | `global.css:33-36` |
| Blue = primary, white = secondary, red = danger. Three tiers, no fourth | `global.css:155-198` |
| `border-radius: 0` on everything, forever | `global.css:39-43` |
| Monochrome everywhere else: a component that needs a new colour is a wrong design, not a missing token | `global.css` header |

### 0.2 In scope — what actually changes

**Animations. Borders. Buttons. Icons.** Plus the structural mobile patterns the
owner asked for by name (modals, three-dot menus) and the performance work,
which is a separate mandate sentence and is specified in the plan, not here.

### 0.3 One reset must be relaxed, and it is worth saying out loud

```css
*, *::before, *::after { border-radius: 0; box-shadow: none; box-sizing: border-box; }
```

`border-radius: 0` stays — that is the 90° rule, enforced globally, and it is
correct. **`box-shadow: none` must go.** It is a blanket veto on the single
device that carries most of RealDose's polish (§4), and it also vetoes the focus
ring (§3.6), which is an accessibility regression hiding inside an aesthetic
rule. Shadows become opt-in per component under the rationing doctrine of §4.3 —
which is a stricter rule than "none", because "none" needs no judgement and a
ration does.

---

## 1. Tokens

All of these are additions to `:root` in `src/styles/global.css`. Nothing listed
in §0.1 changes value.

### 1.1 The ink ladder

RealDose draws nearly everything in one warm near-black at 0.08–0.9 alpha. We
already have exactly one ink: `--fg: #000`. The ladder is that ink at declared
alphas, and it replaces the current situation where hierarchy has only two rungs
(`--line #000` and `--faint #ddd`) and every component picks one by feel.

```css
--ink-04:  rgba(0,0,0,0.04);   /* zebra / inset panel fill      (≈ today's --zebra) */
--ink-08:  rgba(0,0,0,0.08);   /* row hover fill                                    */
--ink-12:  rgba(0,0,0,0.12);   /* hairline dividers INSIDE a bordered container     */
--ink-20:  rgba(0,0,0,0.20);   /* resting component edge: inputs, cards, list boxes */
--ink-35:  rgba(0,0,0,0.35);   /* emphasised container edge; dashed affordances     */
--ink-55:  rgba(0,0,0,0.55);   /* secondary text  (≈ today's --mid #555)            */
--ink-100: #000;               /* --fg. Hover, active, hero, section rules          */
```

`--faint #ddd` is `rgba(0,0,0,0.13)` on white and stays as an alias for
`--ink-12` so nothing that references it has to change in the same commit that
introduces the ladder. `--mid #555` is `rgba(0,0,0,0.67)` — close enough to
`--ink-55` that it also stays as an alias. **Aliasing, not replacing, is
deliberate**: it lets the ladder land in one commit and the migration of ~40
call sites happen per-surface, so no single commit is unreviewable.

### 1.2 Border hierarchy — the one thing the owner asked for by name

**One weight. Hierarchy is alpha, and interaction is what earns full ink.**

```css
--line-hair: 1px   solid var(--ink-12);   /* dividers between rows of one container */
--line-soft: 1.5px solid var(--ink-20);   /* every resting component                */
--line-mid:  1.5px solid var(--ink-35);   /* emphasised / "paper sheet" containers  */
--line-full: 1.5px solid var(--ink-100);  /* hover, active, focus-within, hero      */
--rule-sec:  2px   solid var(--ink-100);  /* section architecture: under an <h2>    */
--accent-3:  3px   solid var(--btn-blue); /* left-edge callout. The ONE coloured border */
--line-dash: 1.5px dashed var(--ink-35);  /* "add / empty" affordance → solid on hover */
```

Four rules that make this a system rather than seven variables:

1. **1.5px is the component stroke.** Not 1px. The half pixel is what separates a
   drawn object from a table gridline, and at 90° with no radius it is the entire
   difference between "brutalist" and "unstyled".
2. **1px is only ever a divider inside something that already owns a 1.5px
   outer edge**, and the last one is removed (`:last-child { border-bottom: 0 }`).
   A list is one object, not N boxes.
3. **Every interactive component darkens its border to `--ink-100` on
   hover/focus/active.** That single coordinated move is most of what reads as
   polish (RealDose §1.6), and it costs one line per component.
4. **`--accent-3` is the only coloured border in the app** and appears at most
   once per view: a left bar on a callout (a danger warning, a review verdict
   panel). Blue means "action", red means "destructive". Nothing else is
   coloured, per §0.1.

### 1.3 Surface ladder

Mono has no cream, mint or warm paper to separate planes with, so the greys do
it:

```css
--surface-0: var(--bg);      /* #fff — the page                                 */
--surface-1: var(--ink-04);  /* inset panels, zebra stripes, disabled fills     */
--surface-2: var(--ink-08);  /* row hover, pressed toggle fill                  */
--surface-inv: var(--fg);    /* SELECTED = inversion: black fill, white text    */
```

**Selection is inversion, never blue.** Blue already means "primary action"; a
blue-tinted selected row would read as a button. This is RealDose adaptation risk
#3, resolved here once so no surface re-litigates it. `aria-pressed="true"`
toggles (like, queue methods) invert; they do not tint and they do not take a
`.btn` class — the existing doctrine (`global.css:232-247`, `:346-359`) already
says this and it survives unchanged.

### 1.4 Spacing and density

The existing `--pad-1: 8px / --pad-2: 16px / --pad-3: 24px` scale stays. Two
additions, both because the current scale has no rung small enough for the dense
row work §5.1 needs:

```css
--pad-0: 4px;    /* icon-to-label gap, chip padding                */
--pad-4: 32px;   /* section separation on ≥640px                   */
--tap: 44px;     /* THE minimum interactive box. Not a suggestion. */
--bar-h: 56px;   /* the collapsed player bar. See §5.3 and §6.5.   */
```

`--tap: 44px` exists as a token rather than a comment because the audit found
**nothing interactive in the app reaches 44px** — the tap-target failure is
systemic, so the fix has to be a token every recipe references, not a number
retyped in twenty places.

### 1.5 The motion menu

Fixed and small. Six values, and a component that wants a seventh is wrong.

```css
:root {
  --dur-fast:  150ms;  /* colour, border, background, opacity. NEVER bounced. */
  --dur-base:  200ms;  /* transforms: lift, sink, nudge                       */
  --dur-panel: 280ms;  /* drawers, sheets, the now-playing expand             */
  --dur-slow:  350ms;  /* one-shot entrances                                  */
  --ease-pop:   cubic-bezier(0.34, 1.56, 0.64, 1);  /* transforms ONLY, ≤3px  */
  --ease-out:   cubic-bezier(0.22, 1, 0.36, 1);     /* fills, sweeps, enters  */
  --ease-panel: cubic-bezier(0.32, 0.72, 0, 1);     /* panels — the iOS curve */
  --ease-std:   cubic-bezier(0.4, 0, 0.2, 1);       /* bottom-bar slide       */
}
```

Binding rules:

- **Colour, border-colour, background and opacity animate at `--dur-fast ease`
  and never overshoot.** `--ease-pop` on a colour is the thing that makes an
  interface feel like a toy.
- **`--ease-pop` is confined to transform deltas of ≤3px** — the lift and the
  sink, nothing else. RealDose's own product doctrine forbids bounce on chrome
  and confines it to small object transforms; applied to a list reflow or a panel
  it turns cartoonish (adaptation risk #5).
- **Panels use `translate3d` + `--ease-panel` at `--dur-panel`, with a two-frame
  rAF mount.** Mount off-screen, then
  `requestAnimationFrame(() => requestAnimationFrame(() => open()))` so the
  browser has a "from" frame; exit flips the class and unmounts on a
  `--dur-panel` timeout. `[data-dragging="true"] { transition: none }` while a
  finger drives it.
- **Meters and bars animate `transform: scaleX()` from `transform-origin: left`,
  never `width`.** The upload chip's `.uploadchip-fill` is the one live case
  today and it is currently a width animation by omission (no transition at all).
- **Nothing loops.** There is no marquee here, no glow, no pulse, no spinner.
  Loading is a shimmer on the label text or a pulsing 6px square — the button
  keeps its size, so nothing reflows when a request resolves.

**Reduced motion — one global block, not per-component:**

```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
    scroll-behavior: auto !important;
  }
}
```

The two-frame rAF mount must **also** short-circuit its JS timeout to 0 under
`matchMedia('(prefers-reduced-motion: reduce)')`, or a sheet stays mounted for
280ms with nothing happening.

**Mobile motion rules (≤640px), from RealDose's own perf doctrine:**

1. No `backdrop-filter` anywhere, at any breakpoint. RealDose disables it on
   mobile themselves; we never introduce it. Sheet scrims are solid
   `rgba(0,0,0,0.4)`.
2. No infinite animation. None exists today; none is added.
3. Every `:hover` recipe is duplicated under `:active` — touch has no hover, and
   a card that only responds to a cursor is dead on the target device.
4. `content-visibility: auto` with a reserved `contain-intrinsic-size` on
   below-fold list sections (the pool list, the queue list). This is the one
   import from RealDose that is purely a performance win.

### 1.6 Z-index ladder

There is no ladder today; `.cratepick-menu` sits at `z-index: 1` and everything
else relies on paint order (`Shell.astro:91-98` mounts the chip after the bar
"so the chip wins the paint order without needing a z-index"). That works until
the second overlay exists, which is this redesign. Declare it once and do not
invent steps:

```
 1  in-row overlays (the crate picker menu — unchanged value)
10  sticky table headers
20  the compact top nav bar
30  the upload chip
40  the player bar (and the queue drawer, its own child)
50  the now-playing sheet surface
60  bottom action sheets and their scrims
70  confirm dialogs
```

The player bar keeps its DOM position after the chip; the chip's `z-index: 30`
against the bar's `40` is a deliberate reversal of today's paint-order rule and
must be commented as such, because the existing comment says the opposite.

---

## 2. Typography

**This is an owner decision, not a spec decision** — see §9(a). The audit's
finding is unambiguous:

> the "shabby" verdict is mostly the browser-default serif plus sub-44px glyph
> controls, not the monochrome system itself

and the owner's change list is animations, borders, buttons, icons. Fonts are
not on it. So the spec states both branches and neither is built until the owner
picks.

**Branch A — system sans (recommended).** Zero webfonts, zero requests, zero
CLS, zero bytes; the perf profile is *identical* to today because no file is
fetched.

```css
--font-ui: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto,
           'Helvetica Neue', Arial, sans-serif;
--font-num: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
```

`--font-num` is what `.num` and `.keychip` already do informally
(`font-family: monospace`, `global.css:118`) — this only names it and pins the
stack so a phone does not pick Courier.

Scale (steps down from the current browser default of 16px, which is why the app
reads spacious-but-unstyled):

```
--text-micro: 11px / 700 / 0.12em / uppercase   labels, eyebrows, column heads
--text-xs:    12px                              chips, meta, table secondary
--text-sm:    13px                              body, list rows, buttons
--text-base:  15px                              prose, form values
--text-lg:    17px                              card titles, h2
--text-xl:    22px                              h1
```

Inputs get `font-size: 16px` on ≤640px regardless of the scale — anything smaller
makes iOS Safari zoom the viewport on focus, and that zoom does not undo itself.

**Branch B — keep the browser-default serif.** Everything else in this spec still
applies; borders, motion, icons and the 44px targets do the whole job. The
honest prediction: the app will look *deliberate* rather than *unstyled*, but the
serif will still read as "a document", and the owner's original complaint is
half about exactly that.

Either way, `--font-num` is adopted — a numeric column in a proportional serif is
a bug at any font decision.

---

## 3. Buttons

Colours frozen (§0.1). Everything else is re-recipied from RealDose §3.2/§5.4.

### 3.1 The shared anatomy

```css
.btn, .btn-secondary, .btn-danger {
  display: inline-flex; align-items: center; justify-content: center;
  gap: var(--pad-0);
  min-height: var(--tap);              /* 44px — was ~27px. THE fix. */
  padding: 0 var(--pad-2);
  border: 1.5px solid;                 /* was 1px */
  font: 700 var(--text-sm)/1 var(--font-ui);
  letter-spacing: 0.01em;
  cursor: pointer;
  transition: transform var(--dur-base) var(--ease-pop),
              box-shadow var(--dur-base) ease,
              background   var(--dur-fast) ease,
              border-color var(--dur-fast) ease,
              opacity      var(--dur-fast) ease;
}
.btn:hover,  .btn-secondary:hover,  .btn-danger:hover,
.btn:active, .btn-secondary:active, .btn-danger:active {
  transform: translate(-1px,-1px);
  box-shadow: 3px 3px 0 var(--ink-100);
}
.btn:active, .btn-secondary:active, .btn-danger:active {
  transform: translate(2px,2px);
  box-shadow: none;                    /* it sinks. Elevation is literal. */
}
```

The `:active` duplication of `:hover` is the mobile-parity rule (§1.5), then
`:active` overrides the transform — order matters, and the sink must be declared
last.

### 3.2 The three tiers — what actually differs

| Tier | Fill | Text | Border | Hover fill |
|---|---|---|---|---|
| `.btn` (primary) | `--btn-blue` | `#fff` | `--btn-blue-line` → `--ink-100` | one step lighter blue |
| `.btn-secondary` | `--bg` | `--fg` | `--ink-35` → `--ink-100` | `--surface-2` |
| `.btn-danger` | `--btn-red` | `#fff` | `--btn-red-line` → `--ink-100` | one step lighter red |

The **border darkening to full ink on hover is what makes the three tiers one
family** — the fills are three different colours, the edge is the same object
language. `.btn-secondary` is the tier that changes most: it moves from a
resting `--line` (full black, `global.css:186`) to `--ink-35`, so that hover has
somewhere to go. Today a secondary button looks identical hovered and resting,
which is half of "shabby" on its own.

**One filled button per bar or row.** Everything else is secondary or ghost.
This is RealDose's masthead rule and it is what stops a toolbar reading as a
ransom note.

**A fourth ghost tier is added, and it is not a colour exception:**

```css
.btn-ghost { background: none; border-color: transparent; color: inherit; }
.btn-ghost:hover { background: var(--surface-2); border-color: var(--ink-20); }
```

Ghost is for icon-only buttons and menu rows. It takes no colour token, so it
does not widen the §0.1 exception — it is the *absence* of the fill, not a new
one.

### 3.3 Sizes

```css
.btn-lg { min-height: 48px; font-size: var(--text-base); }  /* one per page  */
.btn-sm { min-height: 36px; padding: 0 var(--pad-1); font-size: var(--text-xs); }
```

`.btn-sm` is **only legal where a 44px hit area is restored another way** — a
`::after` overlay extending the box, or a parent row that is itself ≥44px tall
and fully tappable. The rule is: the *visual* box may be 36px; the *hit* box may
never be under 44. That distinction is what lets a dense row look dense and still
be usable with a thumb.

### 3.4 Loading and disabled

- **Loading:** `aria-busy="true"`, label text gets a 1.6s linear shimmer
  (`background-clip: text` sweep, greys only). **The button does not change
  size and never becomes a spinner** — a size change reflows the row the moment
  the request resolves.
- **Disabled:** `opacity: 0.45; transform: none; box-shadow: none;
  pointer-events: none`. Today it is `opacity: 0.5` plus
  `cursor: not-allowed` (`global.css:193-198`); `pointer-events: none` already
  makes the cursor rule unreachable, so it goes.

### 3.5 The transport exception — mandatory, not optional

**Play/pause, next, previous and seek NEVER lift and NEVER sink.**

```css
.playertoggle, [data-transport] {
  transition: opacity 80ms linear, background var(--dur-fast) ease;
}
.playertoggle:active, [data-transport]:active { opacity: 0.6; }
```

2–3px of travel on a CTA reads as physicality. The same 2–3px on a play button
reads as **latency** — the eye interprets the movement as the app thinking about
it. This is RealDose adaptation risk #2 and it is the one place where the
signature move is banned outright. `≤100ms`, opacity only, no travel.

The play/pause button also keeps its existing exemption from the tier system
(`global.css:165-167`, `Shell.astro:86` — it takes no `.btn` class). It gains
size (44px), an icon (§4) and this feedback rule; it does not gain a tier.

### 3.6 Focus

One global recipe, and it needs the `box-shadow` reset relaxed (§0.3):

```css
:focus-visible {
  outline: none;
  border-color: var(--btn-blue);
  box-shadow: 0 0 0 3px rgba(11,87,208,0.35);   /* --btn-blue at 0.35 */
}
```

Square ring, free at 90°. Blue is already the action colour, so focus and primary
agree rather than competing — which is only safe because selection is inversion
(§1.3) and can never be confused with it.

---

## 4. Shadows

### 4.1 The scale

```css
--lift-1: 3px 3px 0 var(--ink-100);        /* buttons, chips, small tiles on hover */
--lift-2: 4px 4px 0 var(--ink-100);        /* cards, the active nav item           */
--lift-3: 6px 6px 0 var(--ink-100);        /* the hero object on hover             */
--rest-1: 4px 4px 0 rgba(0,0,0,0.10);      /* the ONE resting hero object per page */
--edge-bar: 0 -2px 0 var(--ink-100);       /* fixed bars: a hard line, not a blur  */
--sheet:   0 -4px 32px rgba(0,0,0,0.12);   /* the only soft shadow in the system   */
```

### 4.2 Why hard offsets and not blur

`Npx Npx 0` is a rectilinear projection. On a 0-radius box it lines up exactly —
it looks *better* here than it does on RealDose's rounded boxes, where the
corners never quite match. In mono it is pure `#000`. This one device replaces
most of what a colour system does with tints.

The single soft shadow (`--sheet`) exists because a bottom sheet needs to read as
*above the page* rather than *attached to its edge*, and a hard offset on a
full-width element pointing up is a black bar, not a shadow.

### 4.3 The rationing doctrine — the rule that prevents the collapse

RealDose adaptation risk #1: mono + 0 radius + hard shadows collapses into an
undifferentiated field of black rectangles. **If everything lifts, nothing
lifts.** Four rations, and they are checkable by reading a page's CSS:

1. **At most ONE resting hard shadow per view** (`--rest-1`, the faint 0.10
   one), on the page's hero object — the now-playing sheet's artwork, the upload
   dropzone on `/upload`, the current review pair on `/review`. A page with two
   is a design error.
2. **Full-ink shadows are earned by interaction only.** `--lift-*` appears in a
   `:hover`/`:active`/`[aria-pressed=true]` block and nowhere else.
3. **Shadow size scales with object size.** A 36px chip gets `--lift-1`; a card
   gets `--lift-2`; only the hero gets `--lift-3`.
4. **Fixed bars use `--edge-bar`, never a lift.** A 4px hard line under a sticky
   masthead reads as a border, not elevation — RealDose learned this and added a
   soft falloff behind it; we do not, because we have no warm plane to fall off
   onto.

Rows do **not** lift. A list of 100 lifting rows is the collapse in its purest
form. Row feedback is a background step (`--surface-2`) plus a revealed
affordance, at `--dur-fast`. That is the whole recipe (§6.2).

---

## 5. Mobile grammar

Design target: **375px**. `640px` is the one breakpoint that matters (it is
already the app's only mobile breakpoint —
`global.css:57,300,431`); `40rem` stays for `/review`'s two-panel split
(`global.css:675`).

### 5.1 Card rows replace tables — the SoundCloud shape

The pool table is 15 columns and ~480px of cell padding against a 375px
viewport, with no `overflow-x` container anywhere. It is not fixable as a table.
Below 640px every table in the app becomes a list of cards; above 640px the
table stays exactly as it is (desktop is not the problem and a 15-column table is
genuinely the right tool there).

```
┌──────────────────────────────────────────────┐
│ ▶  [art]  Artist — Title                  ⋮  │   ← 64px row, 1.5px outer edge
│    44px   8A · 128 · 6:41 · ♥ 12             │      on the LIST, 1px hairlines
└──────────────────────────────────────────────┘      between rows
```

- **Artwork leads.** 44×44 display box. The stored asset is `thumb.jpg` at
  **64px** (analysis worker `make_thumb(size=64)`), so 44 CSS px is within
  source resolution on 1× and upscales 1.4× on a 2× phone. That softness is
  accepted for now: a `thumb@2x.jpg` is an analysis-worker change plus a
  re-analysis of the pool, which is not a UI task. Survive-list #15 is
  unchanged — rows still load only the thumb, still `loading="lazy"`, still
  render a bordered empty box when `has_thumb` is false.
- **Two lines, not fifteen columns.** Line 1: artist — title (one line,
  ellipsis, `--text-sm`). Line 2: the metadata that a DJ actually scans — key,
  BPM, duration, like count — as a `·`-separated `--text-xs` run in `--ink-55`.
  Everything else (quality tier, uploader, added date, downloads, plays, tags)
  moves into the three-dot sheet or onto the track page. **The columns are not
  deleted; the desktop table still renders all fifteen.**
- **The whole row is the play control.** Not a 10×17px `▶` glyph. Tapping the
  row plays; the `▶` becomes an icon inside the 44px leading box and is the
  visual affordance rather than the only target.
- **`⋮` opens the action sheet** (§5.2) carrying: `+ queue`, `add to crate`,
  `like`, `download`, `open track page`, and the metadata that line 2 dropped.
  Six controls that are 8–30px today become six 44px rows in a sheet — that is
  the whole "three dot menus" instruction, and it is also the fix for offender
  #2.
- **Element budget: ≤10 per row.** Today it is 32 (audit §1.4). The `+Q`
  button's five duplicated `data-*` attributes go — site.ts scrapes `a.play`,
  which already carries them (survive-list #7), and the sheet is built from the
  row it was opened on.

The same card shape serves `/uploads`, `/merges`, `/crate/[id]`, `/admin` and
M6c's feed rows. One recipe, six surfaces.

### 5.2 The bottom action sheet

RealDose's `BuySheet` (study §3.4), squared and de-rounded. This is the single
most reused new component in the redesign — the three-dot menu, the mobile nav
(§5.4), the filter panel and the crate picker are all this one thing.

```
Portal:        appended to <body>, z-60
Scrim:         rgba(0,0,0,0.4), fades var(--dur-panel), tap to close
Panel:         fixed bottom; left/right 0; background var(--bg);
               border-top: var(--line-full); box-shadow: var(--sheet);
               max-height: 80vh; padding-bottom: env(safe-area-inset-bottom)
Enter:         translate3d(0,100%,0) → 0, var(--dur-panel) var(--ease-panel),
               two-frame rAF mount
Exit:          reverse, unmount on a var(--dur-panel) timeout
Handle:        36×4px, var(--ink-35), centred, tappable to close (44px hit area)
Header:        title row, padding var(--pad-1) var(--pad-2), border-bottom: var(--line-hair)
Rows:          min-height var(--tap); icon + label + optional trailing meta;
               border-bottom: var(--line-hair); :last-child border-bottom: 0
Scroll:        the row list is the scroller (overflow-y:auto), not the panel
Dismiss:       tap scrim · tap handle · Escape · swipe down past 30% of panel
               height OR flick velocity > 0.5px/ms; |dx|/|dy| > 0.6 is a
               horizontal gesture and is ignored
Body scroll:   locked while open (this differs from RealDose, which deliberately
               does not lock — their sheet is a price comparison read against the
               page behind it; ours is a menu, and a menu that lets the page
               scroll under it loses its anchor row)
Focus:         first row focused on open; focus trapped; restored to the ⋮ on close
```

**No `<form method="post">` inside a sheet unless it carries
`data-astro-reload`** — the house rule (CLAUDE.md, `astro-forms.test.ts`) applies
to markup that only ever appears in a portal exactly as it does to markup on the
page. The safer default: sheet rows are `<button type="button">` that call the
same delegated handlers the inline controls call, and the no-JS path stays the
server-rendered controls that are already there.

### 5.3 Mini-player → full-screen now-playing

Apple Music's pattern: the bottom bar is a mini player; tapping it expands a
full-screen now-playing view; the queue lives inside that view. Adopting it here
runs straight into three load-bearing contracts, so the reconciliation is
specified explicitly rather than discovered during implementation.

**The three contracts it must not break** (audit §3):

- **#2** — `.playerbar` carries `transition:persist="player"`. `#player-audio`,
  `#player-label`, `#player-toggle`, `#player-seek`, `#player-time` are looked up
  **once** at site.ts module load and never re-bound. ClientRouter moves those
  same nodes into every new page.
- **#3/#5** — `#queue-drawer` is an *absolute child* of the fixed `.playerbar`
  at `bottom: 100%`. Child-not-sibling is deliberate: it means the drawer needs
  no eyeballed offset, because `100%` resolves against whatever height the bar
  currently is (one row desktop, two rows mobile).
- **#9** — the mobile two-row player is achieved with CSS `order` alone; DOM
  order stays name/toggle/seek/time and site.ts does not know about visual order.

**Rejected approach: portal the sheet to `<body>` and move the transport into
it.** It fails on all three. A portalled node is outside the persist boundary, so
ClientRouter destroys it on every navigation and the sheet closes itself when a
member taps a track — which is the exact failure the drawer was placed inside the
persist node to avoid. Worse, it forces either (a) moving `#player-audio`, which
risks a playback reset on iOS Safari and is never worth it, or (b) duplicating
`#player-toggle`'s id, which breaks the once-looked-up contract silently and with
no build error.

**Accepted approach: the sheet is a second visual STATE of the persisted bar.**

1. **No new DOM outside `transition:persist="player"`.** The sheet's surface is
   `.playersheet`, a new absolute child of `.playerbar` — the same structural
   trick `#queue-drawer` already uses, and for the same reason. It inherits the
   persist guarantee for free and introduces no new eyeballed constant.
2. **`body.nowplaying-open`** — the same idiom as the existing `body.queueopen`
   (`global.css:425`). Under it, `.playerbar` gains `top: 0` and becomes a
   full-viewport fixed box.
3. **The layout change is instantaneous; only `transform` animates.**
   `top: 0` flips in one frame *underneath* `.playersheet`, which slides
   `translate3d(0,100%,0) → 0` over `--dur-panel var(--ease-panel)` and is opaque.
   The reflow is never seen. Animating `top`/`height` directly would be layout
   work on every frame on the worst device we support; this is one reflow of one
   fixed element.
4. **`#player-audio` never moves and never gains a sibling.** One media element,
   forever. Written as a rule because the temptation to portal it is real.
5. **The sheet's big transport does not duplicate an id.** It renders
   `<button data-transport="toggle|next|prev">` buttons that route through
   site.ts's existing document-level delegation to the *same* module functions
   `#player-toggle` calls. That is not a second code path — it is a third trigger
   on one path, exactly as `mediaSession`'s `nexttrack` handler already is
   (`site.ts:497`). State mirroring (glyph, elapsed, seek position) is written by
   the **one** existing `timeupdate` handler to both hosts, preserving the
   one-writer discipline `setRenderedQueue` already enforces
   (`queue-wiring.test.ts` — "assigns `renderedQueue` in exactly one place").
6. **The queue renders into the sheet from the same pure function.**
   `renderQueueSections(renderedQueue, state)` gets a second mount point, not a
   second implementation. `#queue-drawer`, `#queue-methods`, `#queue-sections`,
   `#queue-toggle` and `#queue-clear` all keep their ids and their position
   inside the persist div — `shell-bundle.test.ts` stays green unmodified.
7. **Breakpoint split.** ≥640px: the drawer behaves exactly as today
   (`bottom: 100%` above the bar) and the sheet is not offered — a desktop has
   the room, and a full-screen takeover on a 1440px monitor is worse than a
   drawer. <640px: `☰ QUEUE` opens the sheet scrolled to its queue section, and
   `#queue-drawer` switches to `position: static` so it flows inside the sheet
   rather than floating above a bar that is now full-height. One class, one
   media query, zero DOM moves.
8. **`.uploadchip-slot` is hidden while the sheet is open**
   (`body.nowplaying-open .uploadchip-slot { display: none }`). The chip exists
   to be visible over page content; there is no page content visible. This
   *removes* an eyeballed-offset case rather than adding a fifth number.
9. **Collapsed-bar tap semantics.** Tapping the title/art area expands the sheet;
   the transport buttons `stopPropagation()` so play/pause does not expand.
   Swipe down on the sheet collapses it, with §5.2's thresholds.

**What the collapsed bar becomes** (the mini player, 56px = `--bar-h`):

```
┌────────────────────────────────────────────────┐
│ [art] Artist — Title              ▶   ⏭   ☰   │  ← 44px targets, 8px gaps
│ ▁▁▁▁▁▁▁▁▁▁▁▁▁▂▂▂▂▂▂▂▂▂▂▂▂▂▂▂▂▂▂▂▂▂▂▂▂▂▂▂▂▂▂▂  │  ← 2px progress line at the
└────────────────────────────────────────────────┘     bar's TOP edge
```

The two-row mobile reflow **goes away**, and with it the audit's offender #7: the
seek `<input type="range">` no longer sits at the extreme bottom edge fighting
the iOS home-indicator gesture. On the collapsed bar, progress is a
non-interactive 2px line at the *top* edge (scrubbing happens in the sheet, where
there is room for a 44px target). `#player-seek` keeps its id and its listeners —
it moves to the sheet's DOM position at build time, not at runtime, and is
`display: none` in the collapsed state. **A `display: none` input keeps its
listeners and its value**, so site.ts's `timeupdate` writer is untouched.

CSS `order` still does the reflow between the two states, per survive-list #9.

### 5.4 Navigation — compact top bar + sheet

The current nav is 6–8 inline links plus who, credits and a sign-out form, all
`flex-wrap`. On a phone it wraps to 3–4 rows, ~120px of chrome, ~17px text
targets, and `margin-left: auto` alignment collapses the moment it wraps.

Two candidates. **Recommended: compact top bar + sheet.** Owner confirms — §9(b).

```
┌───────────────────────────────────────────┐
│ localchune            [search] [⋮]        │  ← 44px, sticky, --edge-bar
└───────────────────────────────────────────┘
```

Wordmark left (links to `/`), a search icon-button, and a `⋮` opening the §5.2
sheet with every destination as a 44px row: Pool, Upload, My uploads, Crates,
Merges, [Review + badge], [Admin], then a hairline, then who / credits / Sign
out.

Five reasons it wins over a bottom tab bar:

1. **The bottom edge is already fully spoken for** — player bar, queue drawer
   anchored to it, upload chip with two eyeballed offsets, plus the iOS home
   indicator. A tab bar makes a fourth fixed layer and forces re-eyeballing every
   one of those constants (survive-list #5). The top edge is empty.
2. **A tab bar tops out at five items; the nav has 5–8.** Two of them are
   owner-only. AppNav deliberately *omits* owner links rather than disabling them
   ("a disabled link is a promise with no delivery date",
   `AppNav.astro:37-39`) — a tab bar whose item count changes by role is a
   layout that has to be designed twice.
3. **The owner asked for three-dot menus by name.** This is that, and it reuses
   the sheet §5.1 needs anyway, so the nav costs one component instance rather
   than a new pattern.
4. **It returns ~120px of vertical space** on a 667px screen — the single
   largest content win available on a phone, and it is offender #4 fixed outright.
5. **The sign-out `<form method="post">` keeps working unchanged** inside a sheet
   row (`data-astro-reload`, native full navigation — survive-list #11 requires
   the full document load so every persisted island is torn down with the
   cookies).

The tab bar's one genuine advantage — one-thumb reachability of the primary
destination — is answered by the wordmark being a `/` link and by the fact that
this app's primary surface is the one you are already on.

**Desktop (≥640px) keeps the current inline nav**, restyled: `--text-micro`
uppercase links, `--rule-sec` under the bar, `aria-current` becomes an inverted
chip (§1.3) rather than bold text.

### 5.5 Safe areas, targets and input sizing

```html
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
```

`viewport-fit=cover` is the prerequisite — without it `env(safe-area-inset-*)`
is always 0 and every rule below silently does nothing. It is missing today
(`Shell.astro:31`, `login.astro:11`).

```css
.playerbar   { padding-bottom: max(var(--pad-1), env(safe-area-inset-bottom)); }
.appnav      { padding-top:    max(var(--pad-1), env(safe-area-inset-top)); }
.sheet-panel { padding-bottom: max(var(--pad-2), env(safe-area-inset-bottom)); }
body         { padding-bottom: calc(var(--bar-h) + env(safe-area-inset-bottom) + var(--pad-2)); }
html         { overscroll-behavior-x: none; }   /* browser back-swipe vs sheet drag */
```

The `body` rule replaces the hard-coded `6rem` (`global.css:55`) and satisfies
survive-list #17 by *deriving* the reservation from `--bar-h` instead of
eyeballing it — which also fixes the chip offsets, since `3.5rem`/`6.75rem`
become `calc(var(--bar-h) + var(--pad-1))` with one value at both breakpoints
(the two-row reflow is gone, §5.3).

**44px minimum, everywhere, no exceptions.** Fixed-width inputs (`16rem` in
`.claimform`, `.cratecreate`, `.renameform`; `12rem` in `.tagform`) become
`width: 100%; max-width: 20rem` — 256px + a button does not fit a 343px content
box, which is offender #9.

---

## 6. Component recipes

### 6.1 Icons — 13 glyphs, square terminals, no library

**Format.** Hand-written inline SVG. `src/lib/icons.ts` exports one named
constant per glyph (the inner markup string, no `<svg>` wrapper);
`src/components/Icon.astro` renders it server-side. site.ts imports only the
names it needs so rolldown tree-shakes the rest — no icon font, no runtime
library, no sprite request, no lucide dependency.

**Geometry doctrine.** `viewBox="0 0 24 24"`, `fill="none"`,
`stroke="currentColor"`, `stroke-width="2"` (**2.5 when rendered ≤14px**),
**`stroke-linecap="square"`** and **`stroke-linejoin="miter"`**. Square
terminals are the icon-level analogue of `border-radius: 0` — RealDose uses
`round`, and that single substitution is what makes this set ours rather than
theirs. Transport glyphs are **solid `fill="currentColor"` with no stroke**: a
filled triangle and two bars are already brutalist primitives and read better at
16px than any outline.

Everything inherits `currentColor`, so an icon is automatically white inside a
`.btn`, red inside `.btn-danger`, and `--ink-55` inside a meta run.

| # | Name | Construction (24×24) | Paint |
|---|---|---|---|
| 1 | `play` | `M8 5 L20 12 L8 19 Z` | fill |
| 2 | `pause` | `rect 7,5,3.5,14` + `rect 13.5,5,3.5,14` | fill |
| 3 | `next` | `M6 5 L16 12 L6 19 Z` + `rect 17,5,2.5,14` | fill |
| — | `prev` | `next` mirrored — `transform: scaleX(-1)`. No second path. | fill |
| 4 | `queue-add` | `M4 7h13 M4 12h13 M4 17h8` + plus `M17 14v7 M13.5 17.5h7` | stroke |
| 5 | `heart` | angular: `M12 20 L4 12 L4 7 L8 5 L12 8 L16 5 L20 7 L20 12 Z` | stroke; **fill when liked** |
| 6 | `kebab` | three 2.5×2.5 **squares** at `x=10.75`, `y=4.5 / 10.75 / 17` | fill |
| 7 | `download` | `M12 4v11 M7 11 l5 5 l5 -5` + tray `M4 20h16` | stroke |
| 8 | `upload` | `M12 20V9 M7 13 l5 -5 l5 5` + `M4 4h16` | stroke |
| 9 | `search` | **square** lens `rect 4,4,11,11` + handle `M15 15 l5 5` | stroke |
| 10 | `close` | `M5 5 l14 14 M19 5 L5 19` — also serves as status `x` | stroke |
| 11 | `drag` | two rows of three 2×2 squares, `y=9 / 14`, `x=6 / 11 / 16` | fill |
| 12 | `crate` | open-top box `M3 8h18 M4.5 8 l1 12 h13 l1 -12 M3 8 l2 -4 h14 l2 4` | stroke |
| 13 | `check` | `M4 12 l5 5 L20 6` | stroke (2.5 at ≤14px) |

Thirteen exports; `prev` is `next` mirrored and status-`x` is `close` reused —
both free, and both deliberate, because two paths that must stay visually
consistent will eventually stop being consistent.

**Sizes:** 12px in dense meta runs · 16px default beside `--text-sm` · 20px in
the collapsed player bar · 28px in the now-playing sheet's transport · icon-only
buttons are `--tap` (44px) with the glyph centred. Decorative icons sit at
`opacity: 0.55` and go to full on hover; functional icons never do.

**Every icon-only button carries an `aria-label`.** The glyphs being replaced
(`▶ +Q ♥ ↓ + ↑ ↓ ✕ ☰`) are text nodes today and are read aloud by a screen
reader as-is; an `<svg aria-hidden="true">` is silent, so the label moves to the
button or the control disappears from assistive tech. Both existing
`aria-label`s on `TrackRow`'s play link and like button already do this and are
the template.

### 6.2 List rows

```css
.row       { min-height: var(--tap); display: flex; align-items: center;
             gap: var(--pad-2); padding: var(--pad-1) var(--pad-2);
             border-bottom: var(--line-hair);
             transition: background var(--dur-fast) ease; }
.row:last-child { border-bottom: 0; }
.row:hover, .row:active { background: var(--surface-2); }
.row-list  { border: var(--line-soft); }   /* the LIST owns the outer edge */
.row-reveal{ opacity: 0; transform: translateX(-4px);
             transition: opacity var(--dur-fast) ease, transform var(--dur-fast) ease; }
.row:hover .row-reveal, .row:focus-within .row-reveal { opacity: 1; transform: none; }
```

The container owns the 1.5px edge; the rows divide with 1px hairlines. **Rows do
not lift** (§4.3). The revealed affordance (a `›` or the `⋮`) is the second
coordinated change that makes hover read as polish rather than as a tint.

Entrance for a freshly rendered queue: 14px rise + fade, `--dur-slow`
`--ease-out`, staggered 60ms per index, capped at the first 8 rows — beyond
that the stagger is a delay, not an animation.

### 6.3 Inputs

```css
input, select, textarea {
  min-height: var(--tap);
  padding: 0 var(--pad-1);
  border: var(--line-soft);
  background: var(--bg);
  font: var(--text-sm)/1 var(--font-ui);
  transition: border-color var(--dur-fast) ease, box-shadow var(--dur-fast) ease;
}
input:hover, select:hover { border-color: var(--ink-55); }
/* focus: §3.6's global recipe */
@media (max-width: 640px) { input, select, textarea { font-size: 16px; } }
```

`accent-color: var(--fg)` stays (`global.css:146`). Checkboxes and radios keep
`border: none` and get a 44px tappable `<label>` wrapper instead — a 13px
checkbox with a 44px label is the correct shape, not a 44px checkbox.

### 6.4 Chips and badges

`.keychip`, `.statechip`, `.tagchip`, `.navbadge`, `.privatechip`,
`.qualitybadge` all converge on one recipe: `--text-micro`, `--pad-0` padding,
`border: 1px solid var(--ink-20)`, `--font-num` for the numeric ones.
`.keychip` keeps its inversion (black fill, white text) — it is already the
system's selected-state idiom (§1.3) applied to data, which is why it looks
right today.

### 6.5 Fixed bars

```css
.playerbar { position: fixed; inset: auto 0 0 0; min-height: var(--bar-h);
             background: var(--bg); border-top: var(--line-full);
             box-shadow: var(--edge-bar); z-index: 40;
             padding-bottom: max(var(--pad-1), env(safe-area-inset-bottom)); }
.appnav    { position: sticky; top: 0; z-index: 20;
             border-bottom: var(--rule-sec); background: var(--bg); }
```

No `backdrop-filter`, at any breakpoint (§1.5). Solid fills only.

### 6.6 Empty, error and loading states

Unchanged in behaviour, restyled: `.empty` gets `--line-dash` (the "nothing here
yet" affordance is the same dashed language as the upload dropzone), `--pad-3`,
centred, with the icon at `opacity: 0.55` above the message.

**EmptyState's three-message contract and the outage-vs-empty distinction are
untouched** (survive-list #16). A restyle that made "the database is down" look
like "you have nothing" would be the worst possible outcome of a redesign, so the
copy paths do not move at all — only the box around them.

---

## 7. Risks, carried forward

The five from the RealDose study, each with the concrete guard that answers it
here:

| # | Risk | Guard in this spec |
|---|---|---|
| 1 | **Black-rectangle collapse** — mono + 0 radius + hard shadows flattens into noise | §4.3's four rations: one resting shadow per view, full ink only on interaction, size-scaled, rows never lift |
| 2 | **Press-sink reads as latency on transport** | §3.5 — banned outright on `[data-transport]`; opacity at 80ms |
| 3 | **Focus and selection collide on blue** | §1.3 selection is inversion; §3.6 focus is blue. Decided once, written down |
| 4 | **Island remount vs ClientRouter** | §5.3's accepted approach: no new DOM outside `transition:persist="player"`; no portal for the now-playing sheet; the §5.2 action sheet *is* portalled and is therefore explicitly ephemeral — it closes on `astro:before-swap`, by design |
| 5 | **Personality deficit after de-warming** | Budget for ALL of: hard shadows, inversion-as-selected, revealed row affordances, staggered list entrance, square-terminal icons, the border-darkens-on-hover coordination. Polish is the coordination, not any one trick — shipping three of the six produces a cheaper-looking app than shipping none |

Two more, specific to this codebase:

| # | Risk | Guard |
|---|---|---|
| 6 | **A restyle silently breaks a site.ts selector** — renaming `a.play`, `.likebtn`, `.queueadd`, `[data-queue-list]`, `[data-reorder]` produces **no build error** (survive-list #7) | Every task in the plan names the selectors it touches and the guard test that proves it; class renames are forbidden in the same commit as a visual change |
| 7 | **An inline `onclick` in the bundle 403s the deploy** via Cloudflare's API WAF (survive-list #6) | Delegated, capture-phase listeners only. Every new sheet/menu control is a `data-*` hook read by an existing document-level listener |

---

## 8. What this spec does not change

Restated compactly so it can be checked against a diff. Full detail in the audit
§3.

`data-astro-reload` on every POST form · the persisted player node and its five
ids · the drawer's five ids, its position inside the persist div and its
zero-`<form>` property · the UX.12 bundle split · delegated capture-phase events
with no inline handlers · every site.ts selector contract · the three-tier button
doctrine and the toggle exemption · CSS-`order`-only player reflow ·
hidden-until-JS controls · POST forms working with JS off · the claim gate and
`/login`'s Shell-less rendering · `#player-label` as the aria-live region ·
resume contracts and click-beats-restore · hashed asset caching · row-thumb-only
art loading · EmptyState's three messages and outage-vs-empty · a bottom
reservation equal to the bar's height.

---

## 9. Open questions — owner decides

**(a) Typography.** Audit: browser-default serif is half of "shabby". Owner's
change list was animations/borders/buttons/icons — fonts were not on it. System
sans (`-apple-system…`, zero webfont, zero bytes, zero CLS) or keep the serif?
§2 specs both.

**(b) Nav.** Compact top bar + `⋮` sheet (recommended, §5.4) or bottom tab bar?

**(c) Desktop tables.** Below 640px every table becomes cards (§5.1). Above it,
keep the 15-column table as-is, or take the cards everywhere for one grammar?

**(d) `/review` page size.** Fixing the 18,000-span page needs both an SVG strip
and a smaller page. Drop `REVIEW_PAGE_SIZE` 50 → 10?

**(e) Hero art.** Track-page art is two round trips (Worker → 302 → R2) serving a
1–3 MB original into a 256px box. Add a derived medium size (analysis-worker
change + pool re-analysis), or leave it?
