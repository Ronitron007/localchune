// src/lib/format.ts
// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.

/**
 * Shared by UploadDropzone.tsx (client) and the /upload and /admin Astro
 * frontmatter (server) so the storage-accounting numbers from
 * migration 08's my_storage()/member_storage() and a row's own file size
 * read the same way everywhere. No browser or Worker API, so it is safe on
 * both sides of the client/server seam.
 */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  const units = ['KB', 'MB', 'GB']
  let value = n / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1 }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`
}
