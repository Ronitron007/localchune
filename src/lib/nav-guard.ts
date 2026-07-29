// src/lib/nav-guard.ts
// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.

/**
 * Shared predicate for "does a mid-flight upload batch warrant blocking
 * this navigation." UploadDropzone already has ONE independent
 * interception point (`beforeunload`, for tab-close/hard-nav) built on
 * `running()`. This module exists so a SECOND interception point (the
 * document click guard, for ClientRouter's soft in-app navigations —
 * see UploadDropzone.tsx's onMount) can never drift out of sync with it.
 * A second, independently-reasoned copy of "is a batch active" is
 * exactly how the beforeunload/ClientRouter asymmetry this fixes came
 * to exist in the first place.
 */

export const NAV_GUARD_MESSAGE =
  'Uploads are still running — leave this page and stop them?'

/**
 * The subset of a MouseEvent + its anchor target that ClientRouter itself
 * inspects before deciding to intercept a click (see
 * node_modules/astro/components/ClientRouter.astro — `leavesWindow` and
 * the click listener body). Kept as plain data, not DOM types, so the
 * predicate is testable without jsdom.
 */
export interface NavClickInfo {
  href: string | null
  target: string | null
  download: boolean
  /** true when the element opts out via `data-astro-reload` */
  reload: boolean
  button: number
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
}

/**
 * True only for a click ClientRouter would otherwise turn into a silent
 * soft navigation: left click, same tab, same origin, no download, and
 * not opted out with `data-astro-reload`. Anything else already produces
 * a real page unload (new tab, external site, forced reload), which
 * `beforeunload` already covers — warning here too would just be a second,
 * redundant prompt.
 */
export function isSoftNavClick(info: NavClickInfo, currentOrigin: string): boolean {
  if (info.reload || info.download || !info.href) return false
  if (info.target && info.target !== '_self') return false
  if (info.button !== 0) return false
  if (info.metaKey || info.ctrlKey || info.altKey || info.shiftKey) return false
  let origin: string
  try {
    origin = new URL(info.href, currentOrigin).origin
  } catch {
    return false
  }
  return origin === currentOrigin
}

/**
 * The single condition both interception points must agree on: warn only
 * while a batch is actively uploading (`running()` in UploadDropzone),
 * and only for a click that would actually navigate away in-app.
 */
export function shouldConfirmBeforeNavigating(
  running: boolean, info: NavClickInfo, currentOrigin: string,
): boolean {
  return running && isSoftNavClick(info, currentOrigin)
}
