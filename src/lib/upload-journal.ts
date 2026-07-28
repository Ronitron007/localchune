// src/lib/upload-journal.ts
// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.

/**
 * The browser's half of "tab close mid-batch: the batch survives, the browser
 * does not have to".
 *
 * This stores ONE thing: name|size|lastModified -> file_id. Not part ETags —
 * ListParts recovers those from R2 on demand, which is what makes resume work
 * on a different device. Not upload_id or part_size either; those live in
 * Postgres so the sweeper can abort an orphaned multipart with no browser
 * involved.
 */

export const JOURNAL_DB = 'localchune-upload-journal'
export const JOURNAL_STORE = 'files'

/** Entries older than this are pruned on mount. A month is far longer than
 *  the 24 h sweeper window, so nothing useful is ever thrown away. */
export const JOURNAL_TTL_MS = 30 * 24 * 60 * 60 * 1000

export interface FileIdentity {
  name: string
  size: number
  lastModified: number
}

export interface JournalEntry extends FileIdentity {
  key: string
  userId: string
  fileId: string
  batchId: string
  updatedAt: number
}

/**
 * The identity heuristic. A HEURISTIC, not a content identity: it is three
 * fields off the File handle, and the PRD forbids hashing a 200-file batch up
 * front (Web Crypto has no streaming digest, so a hash means holding each
 * whole file in an ArrayBuffer).
 *
 * Field order is deliberate. `userId` first, because two members can share a
 * browser profile and handing member B member A's file_id makes ingest_begin
 * raise 42501 for reasons nobody can debug from the UI. The free-form `name`
 * LAST, behind a uuid and two integers, so the key is injective — with the
 * name in front, a file called `a|100|5` could collide with a file called `a`.
 *
 * A false match needs the same name, the same byte count AND the same mtime.
 * In practice that is the same file, which is the case this exists to catch.
 * When it is not: if the matched row already reached `received` the file is
 * reported "already uploaded" and the new bytes are silently not sent
 * (recoverable — rename and re-drop); if it is mid-flight, uploadFile()
 * compares the server's stored part_size against the plan for the current
 * File and starts fresh when they disagree. M3 hashes every object anyway.
 */
export function journalKey(userId: string, file: FileIdentity): string {
  return `${userId}|${file.size}|${file.lastModified}|${file.name}`
}

// Fallback store. This is what runs in node (no indexedDB at all) and in
// Safari private mode / a hardened profile where indexedDB.open() throws.
// Losing cross-session resume is acceptable; failing the whole batch is not.
const memory = new Map<string, JournalEntry>()

let dbPromise: Promise<IDBDatabase | null> | null = null

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise !== null) return dbPromise
  dbPromise = new Promise<IDBDatabase | null>((resolve) => {
    if (typeof indexedDB === 'undefined') { resolve(null); return }
    let request: IDBOpenDBRequest
    try {
      request = indexedDB.open(JOURNAL_DB, 1)
    } catch {
      resolve(null)
      return
    }
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(JOURNAL_STORE)) {
        const store = db.createObjectStore(JOURNAL_STORE, { keyPath: 'key' })
        store.createIndex('updatedAt', 'updatedAt')
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => resolve(null)
    request.onblocked = () => resolve(null)
  })
  return dbPromise
}

function withStore<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest,
): Promise<T | null> {
  return openDb().then((db) => {
    if (db === null) return null
    return new Promise<T | null>((resolve) => {
      let request: IDBRequest
      try {
        request = run(db.transaction(JOURNAL_STORE, mode).objectStore(JOURNAL_STORE))
      } catch {
        resolve(null)
        return
      }
      request.onsuccess = () => resolve(request.result as T)
      request.onerror = () => resolve(null)
    })
  })
}

/**
 * Write the mapping BEFORE the first byte moves. A journal entry written after
 * a successful upload is useless — the case it has to survive is the tab
 * closing at 40%.
 */
export async function rememberFile(
  entry: Omit<JournalEntry, 'updatedAt'>,
  now: number = Date.now(),
): Promise<void> {
  const row: JournalEntry = { ...entry, updatedAt: now }
  memory.set(row.key, row)
  await withStore('readwrite', (store) => store.put(row))
}

export async function lookupFile(key: string): Promise<JournalEntry | null> {
  const stored = await withStore<JournalEntry | undefined>('readonly', (store) => store.get(key))
  return stored ?? memory.get(key) ?? null
}

export async function forgetFile(key: string): Promise<void> {
  memory.delete(key)
  await withStore('readwrite', (store) => store.delete(key))
}

export async function pruneJournal(now: number = Date.now()): Promise<void> {
  const cutoff = now - JOURNAL_TTL_MS
  for (const [key, row] of memory) {
    if (row.updatedAt < cutoff) memory.delete(key)
  }
  const db = await openDb()
  if (db === null) return
  await new Promise<void>((resolve) => {
    let cursor: IDBRequest<IDBCursorWithValue | null>
    try {
      cursor = db
        .transaction(JOURNAL_STORE, 'readwrite')
        .objectStore(JOURNAL_STORE)
        .index('updatedAt')
        .openCursor(IDBKeyRange.upperBound(cutoff))
    } catch {
      resolve()
      return
    }
    cursor.onsuccess = () => {
      const c = cursor.result
      if (c === null) { resolve(); return }
      c.delete()
      c.continue()
    }
    cursor.onerror = () => resolve()
  })
}
