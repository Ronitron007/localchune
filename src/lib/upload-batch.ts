// src/lib/upload-batch.ts
// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.

import { createSignal } from 'solid-js'

/**
 * The batch UploadDropzone is currently filling, published to FileStateTicker.
 *
 * The same module-scope pub/sub the player uses, for the same reason: two
 * sibling islands cannot share a parent's state, and Vite emits one shared
 * chunk for a module both of them import. Both islands must import THIS
 * path — a copied module would be a second, silent instance.
 */
const [batchId, setBatchId] = createSignal<string | null>(null)

export const currentBatchId = batchId
export const setCurrentBatchId = setBatchId

/**
 * The shape /api/upload/status returns. It lives here rather than in the
 * route file so a component never has to import from src/pages — a page
 * module pulls its whole server-side import graph into the type graph, and
 * one careless `import` instead of `import type` would put it in a browser
 * bundle.
 */
export type FileStatus = {
  file_id: string
  original_filename: string
  byte_size: number
  state: string
  state_changed_at: string
  reason: string | null
  terminal: boolean
}
