# iOS Safari haptics on the player transport

Date: 2026-08-07. Branch: `rohan/ios-haptic-safari-integration-4d892c`.

The owner asked for one thing, in these words:

> "there was a repo that someone made sometime back that helped users get ios
> haptic feedback into websites on safari. can we figure out what is it and is
> it actively maintained....if so can we work on integrating it"

Two later directives shaped the result:

> "also give proper writeups for why you are doing things....this reasoning
> needs to live somewhere"

> "make sure this all lives in a single commit and we can revert the commit
> without breaking other things"

This document is the reasoning. The plan is the order of work.

---

## 1. What the repo was, and what happened to it

Safari has never shipped the Vibration API. Safari 17.4 added a non-standard
`switch` attribute for checkboxes: `<input type="checkbox" switch>`. iOS plays a
system haptic tick when that control toggles. The control was the only route
from a web page to the Taptic Engine.

The repo the owner remembers is almost certainly
[lochie/web-haptics](https://github.com/lochie/web-haptics). It went viral in
February and March 2026. It has 2,728 stars. It called `.click()` on a hidden
switch, so **any** code path could fire a haptic.

**Apple patched that in iOS 26.5, in approximately May 2026.** A script can no
longer fire the haptic. Only a direct finger tap on the native control does.
iOS 26 reached approximately 85% of iPhones by the end of July 2026. Therefore
most members cannot receive a script-triggered haptic.

### 1.1 Maintenance survey, 2026-08-07

| Repo | Last commit | Status |
|---|---|---|
| [lochie/web-haptics](https://github.com/lochie/web-haptics) (2.7k★) | 2026-03-07 | **Abandoned and broken.** 29 open issues. #38 "Not working on iOS 26.5", #40, #41 are unanswered since May |
| [posaune0423/use-haptic](https://github.com/posaune0423/use-haptic) (89★) | 2026-05-03 | Programmatic, therefore broken. React-only, and this app is Solid |
| [tijnjh/ios-haptics](https://github.com/tijnjh/ios-haptics) (116★) | **2026-06-26** | **Alive.** Shipped an `ios-26-5` fix, v3.1.1, MIT |
| [m1ckc3s/project-fathom](https://github.com/m1ckc3s/project-fathom) (86★) | 2026-06-08 | Alive. Verified on a physical iPhone on 26.5 |

The answer to the owner's question is therefore split. The famous repo is dead.
The technique survives in a much smaller form, and one library maintains it.

### 1.2 What survives

`ios-haptics` v3.1.1 is approximately ten lines. It appends a transparent
`<input switch>` over the target element. The finger lands on the switch, and
the click bubbles to the element below. That is the entire remaining mechanism.

What this app gains: a tick on **taps**. What it cannot have: a tick on track
auto-advance, on upload completion, or on any state change with no finger
involved. Those paths are closed and no library can reopen them.

---

## 2. Why we do not take the dependency

The published package is ten lines of minified code. We copy the technique and
write our own module, for three reasons.

1. **It nests the input with `insertAdjacentElement('beforeend')` on the
   target.** Our targets are `<button>` elements. That decision needs a
   deliberate owner, because it produces invalid HTML — see §4.
2. **It sets neither `aria-hidden` nor `tabindex`.** As shipped, it adds an
   unlabeled checkbox to the accessibility tree of every button it touches.
3. **It sizes the overlay at `width: 100%`.** That is wrong for `.likebtn` in
   this codebase — see §5.2.

A dependency we must work around in three places is not a dependency. The
technique is credited in the module header.

---

## 3. Scope: the four transport controls, and no more

Haptics attach to exactly four nodes, all inside the persisted player bar:

| Node | Control |
|---|---|
| `#player-toggle` | play / pause |
| `#player-next` | skip |
| `#queue-toggle` | open the queue drawer |
| `#player-like button.likebtn` | ♥ |

### 3.1 Why not the list rows

This is not caution. It is a defect we found before we wrote it.

`site.ts:1397` defines the row tap contract:

```js
const ROW_TAP_EXEMPT = 'a, button, input, select, textarea, label, summary'
```

`playLinkFromTap` returns `null` when a tap lands on any element that matches
that list inside a `[data-play-row]`. The rule exists so a control inside a row
keeps its own tap. An **`input` is on that list.**

An overlay input inside a row is indistinguishable from a control. Every
whole-row tap would land on it, `playLinkFromTap` would return `null`, and the
row would stop playing. The audit-driven whole-row play grammar, shipped
2026-08-06, would break silently on iOS only.

Rows are therefore out of scope, and this paragraph is the reason a later
change must not put them back in without moving the overlay outside
`ROW_TAP_EXEMPT`'s reach.

### 3.2 Deliberately excluded

`#queue-clear` inside the drawer. It is a destructive control and a tick there
has real value. It is out of the owner's stated scope, and it is a one-line
addition later.

---

## 4. Markup: nested, not a sibling overlay

Two shapes work. We choose the one that adds no event code.

**Nested (chosen).** The input is a child of the button. A tap hits the input,
and the click bubbles to the button. `#player-toggle`'s listener and the ♥
form's submit delegation continue to work with **zero new event code**.

**Sibling overlay (rejected).** The input is a sibling, positioned over the
button. The markup is valid. The tap never reaches the button, so we must
forward the click by hand.

We reject the sibling shape because of this project's own history. The block
comment at `site.ts:1356` records the cost:

> ClientRouter's module loads before this one, so its document-level bubble
> listeners registered first and would run first — intercepting the same
> clicks/submits (double POST, then a swap to the form's action URL: the
> production "♥ → 404" bug, 2026-07-31).

Hand-forwarded clicks into a document that ClientRouter also listens to is the
exact failure class that produced that outage. A synthetic click on
`.likebtn` re-enters the same delegation. We do not add a second one.

### 4.1 The cost we accept

`<input>` inside `<button>` is invalid HTML. The `button` content model is
phrasing content with no interactive descendants. Safari tolerates it, and the
maintained library ships it.

We accept invalid nesting in four runtime-created nodes rather than accept a
second synthetic-click path through ClientRouter. That is the trade, stated
plainly so a later reader does not "fix" it into the outage.

---

## 5. The two CSS facts the feature rests on

### 5.1 `opacity: 0` only. Never `appearance: none`

WebKit's own announcement is explicit: with `appearance: none` "you get full
control over its appearance", and "all properties will have their initial
values". Full control means the control is no longer native. **The native
rendering is the haptic.**

`opacity: 0` hides the switch and keeps it native. This is the one line that
silently kills the feature if a later reader tidies it. The module says so at
the line.

### 5.2 Size the overlay to the real tap target, not to the border box

`.playerbar` is `position: fixed` (`global.css:1056`). None of the four buttons
set `position`. An `absolute` child of an unpositioned button therefore sizes
against `.playerbar` and covers the whole bar, which swallows every tap in it.
The module sets `position: relative` on a target whose computed position is
`static`.

The second half is subtler, and it is why a naive `width: 100%` ships broken.
`.likebtn` is already `position: relative`, and it carries a hit-area extender
at `global.css:806`:

```css
.likebtn::after, … {
  content: '';
  position: absolute;
  top: 50%; left: 50%;
  transform: translate(-50%, -50%);
  width: max(100%, var(--tap));
```

The ♥'s real tap target is **wider than its border box**. An overlay at
`width: 100%` sits inside that ring. A thumb that lands in the outer band would
like the track and produce no tick. The haptic would work in the middle and
fail at the edges, which reads as "the haptic is flaky" rather than as a bug.

The overlay therefore copies the extender's geometry exactly: centered,
`max(100%, var(--tap))` on both axes. `#player-toggle` is already at least
44px, so `max(100%, var(--tap))` resolves to 100% there. One rule serves all
four targets.

The module writes that as an inline style and keeps the `var()`. `--tap: 44px`
is declared in the `:root` block at `global.css:91`, so it inherits to every
element and resolves in an inline style. The module must not hardcode `44px`:
the token is the single place the number lives, and `global-tokens.test.ts`
guards it.

The input is later in DOM order than the `::after` pseudo-element and both have
auto `z-index`, so the input wins hit-testing at equal size.

---

## 6. Accessibility

The overlay carries `aria-hidden="true"` and `tabindex="-1"`.

Without them, every haptic button gains an unlabeled checkbox in the
accessibility tree, and a keyboard user tabs into an invisible control that
does nothing. VoiceOver reports `switch` as "On"/"Off", so an unhidden overlay
would also announce a state that means nothing to the member.

Inside `#player-like` the input stays **unnamed**. Form submission includes
only named controls, so the POST body to `/api/track/[id]/like` is unchanged. A
test asserts this rather than trusting the rule.

---

## 7. Feature detection

```js
'switch' in document.createElement('input')
```

This is a real feature detect. It is true on Safari 17.4 and later, and false
everywhere else. No user-agent sniffing.

`attachHaptic` returns immediately when the detect fails, so Android and
desktop receive no extra DOM node and no invalid nesting.

The detect runs per call, and takes the document as a parameter rather than
reading the global. This is not a style preference. `site.ts` touches
`document` at module scope, and `queue-wiring.test.ts:9` records what that
costs: the module "cannot even be imported, let alone driven" under
`environment: 'node'`. A module-scope detect here would put `haptics.ts`
behind the same wall. Four `createElement` calls per page load cost nothing
and keep the module importable.

`attachHaptic` is idempotent. The player bar survives `astro:after-swap`, and
the wiring runs again on every soft navigation. A second call on the same
element must not stack a second input.

---

## 8. Testing, and the gap we cannot close

**Correction to an earlier draft of this section.** It planned JSDOM tests
that drive `attachHaptic` and click the overlay. That is not possible here and
we did not add a dependency to make it possible. `vitest.config.ts` sets
`environment: 'node'`, and this repo's answer to that wall is already written
down at `queue-wiring.test.ts:9`: extract the decisions into pure data, assert
the data, and read the source for the wiring. `haptics.test.ts` follows it —
15 tests, no new dependency.

**Asserted as data** (`OVERLAY_ATTRS`, `OVERLAY_STYLE`):

- the control is a checkbox carrying `switch`, so it is native;
- `opacity: '0'` is present and `appearance` is absent, in either spelling;
- width and height are `max(100%, var(--tap))`, the hit box and not the
  border box, and no value contains a hardcoded `44px`;
- `aria-hidden="true"` and `tabindex="-1"` are present;
- `name` and `value` are absent, so the ♥ form's POST body cannot change;
- `clip-path` is absent.

**Asserted by reading `haptics.ts`** (comments stripped first, because the
module's own prose quotes every string these forbid):

- no `.click(` and no `dispatchEvent` — nobody re-adds the trigger Apple
  removed in 26.5;
- no `appearance` anywhere in the code;
- `'switch' in` is present and `userAgent` is not — a detect, not a sniff;
- no `addEventListener` — the no-second-click-path rule of §4, enforced.

**Asserted by reading `site.ts`:** exactly four `attachHaptic(` calls, one
naming each of `toggle`, `nextBtn`, `drawerToggle`, `likebtn`; and
`haptics.ts` has exactly one importer, which is the property §9's revert
story depends on.

Each guard was mutation-checked rather than trusted: sizing the overlay at
`width: 100%` fails one test, adding `appearance: 'none'` fails two, and
deleting the ♥ wiring fails one. `astro-forms.test.ts` stays green — this
milestone adds no POST form.

**The haptic itself is still not covered, and no test here will ever cover
it.** See below.

**The haptic itself cannot be verified here.** The iOS Simulator has no Taptic
Engine, and macOS Safari has no path to one. A green suite proves the DOM
contract and proves nothing about the tick.

Confirmation needs a physical iPhone on iOS 17.4 or later, against the deployed
URL, tapping each of the four controls. That check is the owner's, and it is
the only evidence that the feature works. This project's rule is to verify
against the real thing; here the real thing is a phone in a hand.

---

## 9. The single-commit revert story

The owner's constraint:

> "make sure this all lives in a single commit and we can revert the commit
> without breaking other things"

| File | Change |
|---|---|
| `src/lib/haptics.ts` | new |
| `src/lib/haptics.test.ts` | new |
| `src/scripts/site.ts` | one import, one call block |
| `docs/superpowers/specs/2026-08-07-ios-safari-haptics-design.md` | new (this file) |
| `CLAUDE.md` | new short section |

`Shell.astro` and `global.css` are **not touched**. The overlay is created at
runtime, so the authored markup and the stylesheet are identical before and
after. Nothing outside `site.ts` imports `haptics.ts`, and `site.ts`'s call
block is additive — no existing line changes behaviour.

`git revert <sha>` therefore removes the module and its call, and the DOM
returns to exactly what it is today. That property is not a convenience. Apple
has patched this technique once already, so plan for it to disappear.

Note on process: the brainstorming skill commits the spec separately. The
owner's single-commit directive overrides that, so this document lands in the
feature commit.

---

## 10. Rejected alternatives

**Make the play/pause control a real `<input type="checkbox" switch>`.** Play
and pause is genuinely a two-state toggle, so the semantics fit. Rejected:
styling it to look like a transport button needs `appearance: none`, which
removes the native control and the haptic with it. See §5.1.

**Depend on `ios-haptics`.** See §2.

**Depend on `lochie/web-haptics`.** It is unmaintained since March 2026 and
broken on current iOS. See §1.1.

**Ship an audio-click fallback for non-iOS.** It is not a haptic, this app
plays audio, and a click through the same output as the music is a defect.

**Wait for a standard Vibration API in WebKit.** There is no signal. The
technique is small and revertible, so waiting costs more than shipping.

---

## 11. Open risks

1. **Apple can patch this again.** §9 is the mitigation.
2. **iOS 27 is unverified.** It was at approximately 3% at the end of July
   2026. Nobody has confirmed the direct-tap path on it. The feature detect
   still guards it, so the failure mode is "no tick", not a broken button.
3. **Invalid nesting is a lint target.** A future HTML validator in CI would
   flag it. §4.1 is the answer to give it.
