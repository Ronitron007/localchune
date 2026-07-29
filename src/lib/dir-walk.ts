// src/lib/dir-walk.ts
// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.

/**
 * "A user can select a folder and we're supposed to recursively travel and
 * look for all the music files" — owner, 2026-07-29. This module is the
 * recursive travel. It is pure: no DOM globals, no fetch, no timers other
 * than the microtask queue the fake readers in dir-walk.test.ts use. That
 * is what lets it be unit-tested in vitest's `node` environment (see
 * vitest.config.ts) with hand-built fake entries — no jsdom, no real
 * FileSystemEntry, which has no public constructor and could not be faked
 * otherwise.
 *
 * The entry shapes below are typed by hand rather than borrowed from
 * lib.dom's FileSystemEntry / FileSystemDirectoryEntry / FileSystemFileEntry
 * / FileSystemDirectoryReader. Two reasons: those types use a plain
 * `boolean` for isFile/isDirectory, which does not narrow a discriminated
 * union the way the literal `true`/`false` below does, and depending on the
 * full DOM lib shape here would make a test double harder to construct than
 * this module's own two-file, two-directory contract needs. UploadDropzone
 * (the DOM-touching caller) narrows a real `webkitGetAsEntry()` result to
 * this shape at the boundary.
 */

import { containerFromFilename } from './upload-policy'

export interface EntryLike {
  readonly name: string
  readonly isFile: boolean
  readonly isDirectory: boolean
}

export interface FileEntryLike extends EntryLike {
  readonly isFile: true
  readonly isDirectory: false
  file(success: (file: File) => void, error?: (err: unknown) => void): void
}

export interface DirectoryReaderLike {
  /**
   * THE bug this module exists to not have: a real DirectoryReader hands
   * back at most ~100 entries per call and signals "no more" with an EMPTY
   * array, not with a sentinel and not after exactly one call. Every caller
   * in this file loops until it sees length === 0 (readAllEntries, below) —
   * nothing else in this module is allowed to call readEntries() directly.
   * dir-walk.test.ts's mandatory 100+100+3 case exists to catch a
   * regression to a single, un-looped call.
   */
  readEntries(
    success: (entries: FileSystemEntryLike[]) => void,
    error?: (err: unknown) => void,
  ): void
}

export interface DirectoryEntryLike extends EntryLike {
  readonly isFile: false
  readonly isDirectory: true
  createReader(): DirectoryReaderLike
}

export type FileSystemEntryLike = FileEntryLike | DirectoryEntryLike

/** Folders this deep are almost certainly a mistake (a symlink-like re-mount,
 *  an accidentally-nested backup) rather than a real DJ pool. Traversal just
 *  stops descending past this depth; it is not an error. Root = depth 0. */
export const MAX_DEPTH = 12

/**
 * Hard ceiling on files discovered from one walk. There is no separate
 * "batch ceiling" elsewhere in upload-policy.ts — this constant is that
 * ceiling for folder discovery. Chosen well above any real DJ pool (a few
 * hundred tracks) while still bounding a pathological drop (a whole music
 * library, a mounted network share) to something the existing pump/journal
 * pipeline in upload-queue.ts can reason about.
 */
export const MAX_FILES = 2_000

export type WalkOptions = {
  maxDepth?: number
  maxFiles?: number
}

export type WalkOutcome =
  | { ok: true; files: File[]; skipped_unsupported: number }
  /** Typed, not thrown: hitting the cap is an expected outcome of a big
   *  drop, not a defect. `files` holds whatever was collected up to
   *  `limit` — the caller can still upload those while telling the user
   *  the rest were left out. */
  | { ok: false; reason: 'too_many_files'; files: File[]; limit: number; skipped_unsupported: number }

/**
 * One path segment (a bare filename, or one directory name on the way down
 * to it) that must be excluded outright: OS/archive housekeeping, never a
 * track a DJ meant to upload.
 *
 *  - dotfiles (`.DS_Store`, `.git`, a resource fork's `._track.mp3`) —
 *    conventionally hidden, never intentionally dropped.
 *  - `__MACOSX` — the metadata folder macOS's Archive Utility adds next to
 *    every extracted zip.
 */
export function isAcceptableSegment(name: string): boolean {
  if (name.startsWith('.')) return false
  if (name === '__MACOSX') return false
  return true
}

/**
 * The one filter shared by both discovery paths (drop-a-folder via
 * webkitGetAsEntry, and the `webkitdirectory` picker input, which flattens
 * to `File[]` with `webkitRelativePath` before this module ever sees it).
 * Takes a path rather than a bare name so a picker's full relative path
 * (`Album/__MACOSX/track.mp3`) is checked segment-by-segment exactly like a
 * walked directory tree would be — a bare filename is just a one-segment
 * path, so the same function serves both callers with no special-casing.
 */
export function isAcceptableAudioPath(path: string, size: number): boolean {
  if (!Number.isFinite(size) || size <= 0) return false
  if (!path.split('/').every(isAcceptableSegment)) return false
  return containerFromFilename(path) !== null
}

/**
 * Returns both entries and an error flag. If error occurs, we still return
 * what we collected so far, but flag indicates the directory walk was
 * truncated mid-read (the user did not get everything).
 */
function readAllEntries(reader: DirectoryReaderLike): Promise<{ entries: FileSystemEntryLike[]; error: boolean }> {
  const out: FileSystemEntryLike[] = []
  let error = false
  const step = (): Promise<FileSystemEntryLike[]> =>
    new Promise<FileSystemEntryLike[]>((resolve) => {
      reader.readEntries(resolve, () => {
        error = true
        resolve([])
      })
    })
  const loop = async (): Promise<{ entries: FileSystemEntryLike[]; error: boolean }> => {
    for (;;) {
      const batch = await step()
      if (batch.length === 0) return { entries: out, error }
      out.push(...batch)
    }
  }
  return loop()
}

function readFile(entry: FileEntryLike): Promise<File | null> {
  return new Promise((resolve) => {
    entry.file(resolve, () => resolve(null))
  })
}

/**
 * Recursively walk one FileSystemEntry-shaped root — typically the return
 * of a single `DataTransferItem.webkitGetAsEntry()` call, or a lone file
 * entry when the user dropped loose files rather than a folder.
 *
 * The walker only discovers and filters files; it feeds the existing
 * pump/journal pipeline (upload-queue.ts, upload-journal.ts) untouched, and
 * does not itself dedupe — that stays the journal's job.
 */
export async function walkEntry(
  root: FileSystemEntryLike | null,
  options: WalkOptions = {},
): Promise<WalkOutcome> {
  const maxDepth = options.maxDepth ?? MAX_DEPTH
  const maxFiles = options.maxFiles ?? MAX_FILES
  const files: File[] = []
  let truncated = false
  let skipped_unsupported = 0

  const visit = async (entry: FileSystemEntryLike | null, depth: number): Promise<void> => {
    if (entry === null) return
    // Don't check truncated here - let file-cap checks below handle stopping
    if (!isAcceptableSegment(entry.name)) return

    if (entry.isFile) {
      const file = await readFile(entry)
      if (file === null || !isAcceptableAudioPath(file.name, file.size)) {
        if (file !== null) skipped_unsupported += 1
        return
      }
      // Checked AFTER reading and filtering, not before: an unacceptable
      // file (wrong extension, zero bytes) must never count against the
      // cap, and landing exactly on the limit with nothing left over is not
      // "too many" — only a file that would have gone PAST the limit is.
      if (files.length >= maxFiles) { truncated = true; return }
      files.push(file)
      return
    }

    // isDirectory. Depth cap: this directory's OWN depth must be below the
    // cap to descend into it — a directory sitting exactly at the cap is
    // where traversal stops, so its children (one level deeper) are never
    // reached. No error, just no deeper files.
    if (depth >= maxDepth) return
    if (truncated) return // Don't descend into new directories if cap reached
    const { entries: children, error } = await readAllEntries(entry.createReader())
    // Process children before checking error. If readEntries errored, we still
    // have a batch to process from before the error occurred.
    for (const child of children) {
      if (truncated) return // Stop if file cap was hit during recursion
      await visit(child, depth + 1)
    }
    // Mark truncated AFTER processing this batch if we got an error
    if (error) { truncated = true }
  }

  await visit(root, 0)
  return truncated
    ? { ok: false, reason: 'too_many_files', files, limit: maxFiles, skipped_unsupported }
    : { ok: true, files, skipped_unsupported }
}

/**
 * Walk every top-level item from one drop or paste — a drag can mix loose
 * files and folders in the same `DataTransferItemList`, and the count guard
 * has to apply across all of them together, not reset per root (dropping
 * five folders of 500 files each must not yield 2,500 files).
 */
export async function walkEntries(
  roots: (FileSystemEntryLike | null)[],
  options: WalkOptions = {},
): Promise<WalkOutcome> {
  const maxFiles = options.maxFiles ?? MAX_FILES
  const files: File[] = []
  let truncated = false
  let skipped_unsupported = 0

  for (const root of roots) {
    const remaining = maxFiles - files.length
    if (remaining <= 0) { truncated = true; break }
    const result = await walkEntry(root, { ...options, maxFiles: remaining })
    files.push(...result.files)
    skipped_unsupported += result.skipped_unsupported
    if (!result.ok) { truncated = true; break }
  }

  return truncated
    ? { ok: false, reason: 'too_many_files', files, limit: maxFiles, skipped_unsupported }
    : { ok: true, files, skipped_unsupported }
}

/**
 * The picker-side counterpart to walkEntry/walkEntries. `input.files` from a
 * `webkitdirectory` `<input>` already arrives flat — the browser did the
 * recursion — with each File's `webkitRelativePath` carrying the folder
 * structure (`MyPool/Subfolder/track.mp3`). No entry-walking is needed here,
 * only the identical filter and the identical typed cap, which is the whole
 * point of sharing `isAcceptableAudioPath` rather than re-deriving it.
 */
export function filterFlatFiles(
  files: Iterable<File>,
  options: WalkOptions = {},
): WalkOutcome {
  const maxFiles = options.maxFiles ?? MAX_FILES
  const kept: File[] = []
  let truncated = false
  let skipped_unsupported = 0

  for (const file of files) {
    // webkitRelativePath is non-standard and TS's lib.dom types do not
    // declare it, hence the cast; it is empty/undefined for a plain (non
    // -directory) file input, so fall back to the bare name.
    const relativePath = (file as File & { webkitRelativePath?: string }).webkitRelativePath
    const path = relativePath !== undefined && relativePath.length > 0 ? relativePath : file.name
    if (!isAcceptableAudioPath(path, file.size)) {
      skipped_unsupported += 1
      continue
    }
    if (kept.length >= maxFiles) { truncated = true; break }
    kept.push(file)
  }

  return truncated
    ? { ok: false, reason: 'too_many_files', files: kept, limit: maxFiles, skipped_unsupported }
    : { ok: true, files: kept, skipped_unsupported }
}
