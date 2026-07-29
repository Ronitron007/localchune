// src/lib/my-files-api.ts
// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.

/**
 * The shape public.my_files() (migration 15a) returns, and the one grouping
 * step /uploads.astro needs on top of it. No DOM, no fetch — the page's
 * frontmatter and this module's test both run in plain node.
 */
export type MyFile = {
  file_id: string
  original_filename: string
  state: string
  last_error: string | null
  byte_size: number
  created_at: string
  batch_id: string
  batch_label: string | null
  bpm: number | null
  key_camelot: string | null
}

/**
 * Composite keyset cursor for my_files() pagination: both created_at and
 * file_id must be passed together to handle tied timestamps correctly.
 */
export type MyFilesCursor = {
  created_at: string
  file_id: string
}

export type BatchGroup = {
  batch_id: string
  batch_label: string | null
  files: MyFile[]
}

/**
 * Groups my_files()'s flat, newest-first rows into batches without
 * disturbing that order: the first batch encountered in the list is the one
 * holding the most recently created row, and every row keeps its place
 * relative to the others in its own batch. A batch is never split into two
 * groups even if a later row from the same batch_id shows up further down
 * the list — which can happen for real, since two members' uploads or a
 * slow multipart part can interleave rows from different batches by
 * created_at.
 */
export function groupFilesByBatch(files: MyFile[]): BatchGroup[] {
  const order: string[] = []
  const groups = new Map<string, BatchGroup>()
  for (const f of files) {
    let g = groups.get(f.batch_id)
    if (g === undefined) {
      g = { batch_id: f.batch_id, batch_label: f.batch_label, files: [] }
      groups.set(f.batch_id, g)
      order.push(f.batch_id)
    }
    g.files.push(f)
  }
  return order.map((id) => groups.get(id)!)
}
