// src/lib/provenance.ts
// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.
//
// Display helpers for the curated provenance object that pool_get()
// returns (migration 20). Everything this module receives has already
// passed the SQL allowlist in provenance_from_tags() — the privacy
// boundary lives in the database, NOT here. Members call the RPC
// directly with their own session, so nothing in this file (or any
// client code) can be trusted to withhold a key the RPC exposed. Do not
// add fields here without adding them to the migration's allowlist
// first.

/** The shape provenance_from_tags() builds. Every field optional — an
 *  untagged file curates to `{}`. */
export interface Provenance {
  purchase_date?: string
  copyright?: string
  release_date?: string
  genre?: string
  label?: string
  encoder?: string
  /** true iff the file carries Apple atoms (itunnorm/itunsmpb) —
   *  presence-derived in SQL; the blob values never leave the DB. */
  apple?: boolean
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/**
 * "2023-11-06 06:55:31" → "6 Nov 2023". "2017-06-09" → "9 Jun 2017".
 * A bare "2017" passes through as-is. Anything else → null. String
 * slicing, not `new Date()`: tag dates carry no timezone, and a Date
 * round-trip would shift the calendar day for some viewers.
 */
export function formatTagDate(raw: string | null | undefined): string | null {
  if (!raw) return null
  const s = raw.trim()
  if (/^\d{4}$/.test(s)) return s
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s)
  if (!m) return null
  const month = Number(m[2])
  const day = Number(m[3])
  if (month < 1 || month > 12 || day < 1 || day > 31) return null
  return `${day} ${MONTHS[month - 1]} ${m[1]}`
}

// Beatport download filenames lead with the numeric track id:
// "1234567_Some Track_(Original Mix).mp3". Six digits reaches back to
// the early catalogue; current ids are eight.
const BEATPORT_FILENAME = /^\d{6,9}_/

/**
 * The "Source" row: "iTunes purchase · 6 Nov 2023", "Beatport", or null
 * (row omitted). iTunes wins over a Beatport-looking filename — a
 * purchase receipt in the tags outranks a filename pattern.
 */
export function sourceLine(
  p: Provenance | null | undefined,
  filename: string | null | undefined,
): string | null {
  if (p && (p.purchase_date || p.apple)) {
    const d = formatTagDate(p.purchase_date)
    return d ? `iTunes purchase · ${d}` : 'iTunes purchase'
  }
  if (filename && BEATPORT_FILENAME.test(filename)) return 'Beatport'
  return null
}
