// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.

/**
 * A cosmetic placeholder only — NEVER the value actually submitted, and
 * never trusted. The one true validation (format, reserved list, set-once,
 * uniqueness) lives entirely in username_set() (migration 17); this only
 * has to look plausible in an empty <input>'s placeholder attribute, not be
 * authoritative or collision-free.
 *
 * Loosely mirrors the DB's `^[a-z][a-z0-9_]{2,19}$`: lowercase, fold
 * anything else to '_', collapse repeats, trim the ends, then pad/prefix so
 * the display favours something a person would actually want to see even
 * for a pathological local-part (all-symbols, leading digit, too short).
 */
export function suggestUsername(email: string): string {
  const local = email.split('@')[0] ?? ''
  let s = local
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')

  if (s === '' || !/^[a-z]/.test(s)) s = `x${s}`
  if (s.length < 3) s = s.padEnd(3, '0')
  return s.slice(0, 20)
}
