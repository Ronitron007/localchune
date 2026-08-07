// src/lib/crate-picker.ts
// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.
//
// THE ADD-TO-CRATE PICKER, decided once.
//
// There are now FOUR surfaces that can put a track in a crate: a pool or
// feed row's inline `details.cratepick`, the row ⋮'s crate sheet, the
// search overlay's result rows, and — new — the player bar's crate button,
// which acts on whatever is playing from any page. The owner asked for a
// fifth thing on all of them: "+ New crate…", opening a modal that creates
// the crate AND adds the track in one flow.
//
// Five surfaces times two questions ("what rows does the picker show" and
// "what does it say when it worked") is ten places to disagree, and the
// two-navs incident is what happens when a shape is markup rather than a
// decision. So the shape lives here:
//
//   cratePickerRows()   the row model every picker surface renders
//   normalizeCrateName  what counts as a name a member typed
//   the four messages   what the status region says afterwards
//
// NO DOM AND NO FETCH. src/scripts/site.ts owns every `document` call and
// org-api.ts owns every request — the same split queue-model.ts, sheet.ts
// and play-meter.ts already established, and the reason this file is
// testable under vitest's node environment at all.
import type { SheetRowInput } from './sheet'

/** One crate, as /api/crates?mine=1 returns it. */
export type CrateOption = { id: string; name: string }

/**
 * The "+ New crate…" row's id, and the ONE string both halves agree on.
 * The sheet reports a chosen row by id, so a surface that spelled this
 * differently would render the row and then silently do nothing when it
 * was tapped — the exact failure mode `sheet-single-source.test.ts` was
 * written for, arriving through a literal instead of through markup.
 *
 * It cannot collide with a crate: every other id here is a uuid.
 */
export const NEW_CRATE_ID = 'new-crate'

/** The row's label, in one place so all four surfaces read identically. */
export const NEW_CRATE_LABEL = 'New crate…'

/**
 * `crates.length === 0` is not an error and must not read like one. It is
 * also the case where "+ New crate…" matters most — a member with no
 * crates yet is exactly who the owner was thinking of — so the empty
 * picker is not an empty state at all: it is the create row plus a line
 * saying why the list above it is missing.
 */
export const NO_CRATES_LABEL = 'No crates yet'

/**
 * Every picker surface's rows, in order: the crates, then the one row
 * that makes a new one. Create goes LAST deliberately — the common case
 * is "into one I already have", and a destructive-looking row at the top
 * of a list is the one a thumb hits by accident.
 */
export function cratePickerRows(crates: readonly CrateOption[]): SheetRowInput[] {
  const rows: SheetRowInput[] = crates.map((c) => ({
    id: c.id,
    label: c.name,
    icon: 'crate' as const,
  }))
  if (rows.length === 0) {
    rows.push({ id: 'none', label: NO_CRATES_LABEL, disabled: true })
  }
  rows.push({ id: NEW_CRATE_ID, label: NEW_CRATE_LABEL, icon: 'crate' })
  return rows
}

/**
 * What a member actually typed, or null for "they typed nothing".
 *
 * 80 is `crate_create`'s own limit (migration 27) and the `maxlength` on
 * /crates' server-rendered form. Truncating here rather than letting the
 * server reject keeps the two paths agreeing about what a long name does,
 * and a paste is the one way past a `maxlength` attribute.
 */
export const CRATE_NAME_MAX = 80

export function normalizeCrateName(raw: string): string | null {
  const name = raw.trim().slice(0, CRATE_NAME_MAX)
  return name === '' ? null : name
}

/* ---------------------------------------------------- what it then says
 *
 * All four go to #player-label, the app's one aria-live region. They are
 * functions rather than templates at each call site because the SECOND
 * one is a real distinction a member needs — "already in Warmups" and
 * "could not add to Warmups" are different facts — and the FOURTH is the
 * only message in the app that has to describe a half-finished operation.
 */
export const addedMessage = (crateName: string): string => `added to ${crateName}`

export const duplicateMessage = (crateName: string): string => `already in ${crateName}`

export const addFailedMessage = (crateName: string): string =>
  `Could not add to ${crateName}.`

/**
 * createCrate() succeeded and addToCrate() then failed. The crate EXISTS
 * server-side with nothing in it, and the honest failure message has to
 * say so — a member who reads "could not add" and retypes the same name
 * mints a second crate through crate_create's own "name (2)" auto-suffix,
 * which is a duplicate produced by the error message rather than by the
 * member.
 */
export const createdNotAddedMessage = (crateName: string): string =>
  `"${crateName}" was created, but adding the track failed — pick it from the list to retry`
