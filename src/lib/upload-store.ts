// src/lib/upload-store.ts
// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.

import { createSignal } from 'solid-js'
import { createStore } from 'solid-js/store'
import type { ProgressRow, RowStatus } from './upload-progress'

/**
 * UX.12 — THE UPLOAD QUEUE'S STATE, AND ONLY ITS STATE.
 *
 * This module is deliberately tiny and deliberately dependency-free: Solid
 * and two type imports, nothing else. It is split from upload-engine.ts
 * (which holds the actions) for one concrete reason.
 *
 * Shell.astro mounts UploadChip on EVERY page. Whatever the chip imports is
 * server-rendered in the Worker on every page and shipped in every page's
 * client bundle. The chip needs to READ the queue; it has no business being
 * able to start one. Were it to import the engine, every page in the app
 * would carry uploader.ts, upload-policy.ts, head-check.ts, upload-journal.ts
 * and preflight.ts — a multipart S3 client and an IndexedDB journal loaded to
 * render a pill that says "▲ 14/68". The split keeps that graph on /upload,
 * where it is actually used.
 *
 * THE SINGLETON LIVES HERE. Both islands import THIS path, and Vite emits one
 * shared chunk for a module two islands import, so both see the same store.
 * A copied module — or a second `createStore` anywhere — would be a second,
 * silent queue. That is the same trap upload-batch.ts already documents, and
 * it is the whole mechanism by which a batch survives a ClientRouter
 * navigation: ES modules are cached by URL and a soft navigation does not
 * re-evaluate one the browser has already run.
 */

export interface Row extends ProgressRow {
  key: string
  fileId: string
  name: string
  size: number
  status: RowStatus
  loaded: number
  message: string
  /** mm:ss from formatDuration, suffixed "~" when it is an estimate
   *  (a VBR mp3 with no Xing header — Task 6 measured that ~17% low). */
  duration: string
  /** The journal recognised this file: it will resume, not restart. */
  resumed: boolean
  /** /api/upload/abort was called, so the server row is `failed` and terminal.
   *  Retry must mint a new file_id. */
  discarded: boolean
}

const [rows, setRows] = createStore<Row[]>([])
const [running, setRunning] = createSignal(false)
const [label, setLabel] = createSignal('')
const [notice, setNotice] = createSignal('')

/** The queue. Read it inside a memo or an effect to subscribe to it. */
export const uploadRows = rows
/** True while a pump is draining the queue. Drives Cancel and beforeunload. */
export const uploadRunning = running
export const uploadNotice = notice
export const uploadLabel = label

export const setUploadLabel = setLabel
export const setUploadNotice = setNotice

// The writers below are exported for upload-engine.ts alone. They are not
// part of the surface a rendering island should touch — a component that
// writes rows directly is a second engine.
export const setUploadRows = setRows
export const setUploadRunning = setRunning
