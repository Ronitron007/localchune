// src/lib/crate-picker.test.ts
// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.
import { describe, expect, it } from 'vitest'
import {
  CRATE_NAME_MAX, NEW_CRATE_ID, NEW_CRATE_LABEL, NO_CRATES_LABEL, addFailedMessage,
  addedMessage, cratePickerRows, createdNotAddedMessage, duplicateMessage,
  normalizeCrateName, type CrateOption,
} from './crate-picker'
import { normalizeRows } from './sheet'

const crates: CrateOption[] = [
  { id: '11111111-1111-4111-8111-111111111111', name: 'Warmups' },
  { id: '22222222-2222-4222-8222-222222222222', name: 'Peak time' },
]

describe('cratePickerRows', () => {
  it('lists every crate, in the order it was given', () => {
    const rows = cratePickerRows(crates)
    expect(rows.slice(0, 2).map((r) => r.label)).toEqual(['Warmups', 'Peak time'])
    expect(rows.slice(0, 2).map((r) => r.id)).toEqual(crates.map((c) => c.id))
  })

  it('puts the create row LAST, never first', () => {
    // The common case is "into one I already have". A row that makes a new
    // object sitting at the top of the list is the row a thumb hits by
    // accident on the way to the first crate.
    const rows = cratePickerRows(crates)
    expect(rows[rows.length - 1]?.id).toBe(NEW_CRATE_ID)
    expect(rows[0]?.id).not.toBe(NEW_CRATE_ID)
  })

  it('offers the create row when there are NO crates — that is the point', () => {
    const rows = cratePickerRows([])
    expect(rows.map((r) => r.id)).toEqual(['none', NEW_CRATE_ID])
    // "No crates yet" is a fact, not a choice: it must not be tappable.
    expect(rows[0]?.disabled).toBe(true)
    expect(rows[0]?.label).toBe(NO_CRATES_LABEL)
    expect(rows[1]?.disabled).toBeUndefined()
  })

  it('every crate row carries the crate glyph', () => {
    for (const row of cratePickerRows(crates)) {
      if (row.id === NEW_CRATE_ID || row.id === 'none') continue
      expect(row.icon).toBe('crate')
    }
  })

  it('survives normalizeRows without losing the create row', () => {
    // The sheet runs its rows through normalizeRows, which DROPS a row
    // whose id repeats an earlier one. NEW_CRATE_ID has to be a value no
    // crate id can take — every other id here is a uuid — or the picker
    // would silently lose its create row for one unlucky crate.
    const rows = normalizeRows(cratePickerRows(crates))
    expect(rows).toHaveLength(3)
    expect(rows[rows.length - 1]?.id).toBe(NEW_CRATE_ID)
    expect(rows[rows.length - 1]?.isLast).toBe(true)
  })

  it('a crate literally named like the create row still cannot collide', () => {
    const rows = normalizeRows(cratePickerRows([{ id: NEW_CRATE_LABEL, name: 'x' }]))
    expect(rows.map((r) => r.id)).toEqual([NEW_CRATE_LABEL, NEW_CRATE_ID])
  })
})

describe('normalizeCrateName', () => {
  it('trims, and empty-after-trim is null rather than a crate called " "', () => {
    expect(normalizeCrateName('  Warmups  ')).toBe('Warmups')
    expect(normalizeCrateName('')).toBeNull()
    expect(normalizeCrateName('   ')).toBeNull()
    expect(normalizeCrateName('\n\t ')).toBeNull()
  })

  it('caps at the length crate_create itself enforces', () => {
    // A `maxlength` attribute does not survive a paste, and the server
    // would reject what the field accepted. Both ends agree on 80.
    const long = 'x'.repeat(200)
    expect(normalizeCrateName(long)).toHaveLength(CRATE_NAME_MAX)
  })

  it('trims BEFORE the cap, so leading space cannot eat a character', () => {
    const name = normalizeCrateName('   ' + 'y'.repeat(CRATE_NAME_MAX))
    expect(name).toBe('y'.repeat(CRATE_NAME_MAX))
  })
})

describe('the four messages', () => {
  it('name the crate, so two pickers on one screen read apart', () => {
    expect(addedMessage('Warmups')).toContain('Warmups')
    expect(duplicateMessage('Warmups')).toContain('Warmups')
    expect(addFailedMessage('Warmups')).toContain('Warmups')
    expect(createdNotAddedMessage('Warmups')).toContain('Warmups')
  })

  it('"already in" and "could not add" are different sentences', () => {
    // They are different FACTS with different next actions, and the whole
    // reason org-api.ts has a DuplicateCrateItemError of its own.
    expect(duplicateMessage('W')).not.toBe(addFailedMessage('W'))
  })

  it('the half-finished one says the crate was created', () => {
    // A member who reads only "could not add" retypes the same name and
    // mints a second crate through crate_create's "name (2)" suffix.
    const msg = createdNotAddedMessage('Warmups')
    expect(msg).toContain('created')
    expect(msg).toMatch(/pick it from the list/i)
  })
})
