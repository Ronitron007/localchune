// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.

/** PRD §1 non-goal: long DJ mixes are explicitly rejected. */
export const MAX_DURATION_MS = 900_000

/**
 * Single PUT below this, presigned multipart above.
 *
 * The threshold is about RESUME, not size — R2 accepts a 5 GiB single PUT,
 * but a 100 MB upload that dies at 95% on venue wifi restarts at byte zero.
 */
export const MULTIPART_THRESHOLD_BYTES = 48 * 1024 * 1024

/**
 * Fixed part size. Every presigned PUT triggers a CORS preflight and the
 * preflight cache is keyed per URL, so each part costs a round trip and
 * small parts are latency-expensive. 16 MiB is ~13 s on a 10 Mbps uplink —
 * a tolerable amount of work to lose to a retry — and 16 MiB × 10,000 parts
 * is 156 GiB, far past any audio file.
 */
export const PART_SIZE_BYTES = 16 * 1024 * 1024

/** R2's hard ceiling on parts per multipart upload. */
export const MAX_PARTS = 10_000

const MIB = 1024 * 1024

export type Container = 'mp3' | 'flac' | 'wav' | 'aiff' | 'm4a' | 'ogg' | 'opus'

/**
 * Highest bitrate a real file in this container can carry, in kbps.
 *
 * Lossless is capped at 4608 = 24-bit/96 kHz stereo, deliberately. 24/192
 * would need 9216 kbps and push the 15-minute ceiling past 1 GB, which makes
 * the size gate meaningless; nothing above 96 kHz has any use in a DJ pool.
 */
const MAX_KBPS: Record<Container, number> = {
  mp3: 320,
  m4a: 512,
  ogg: 512,
  opus: 512,
  flac: 4608,
  wav: 4608,
  aiff: 4608,
}

const EXTENSIONS: Record<string, Container> = {
  mp3: 'mp3', flac: 'flac', wav: 'wav', wave: 'wav',
  aiff: 'aiff', aif: 'aiff', aifc: 'aiff',
  m4a: 'm4a', mp4: 'm4a', ogg: 'ogg', oga: 'ogg', opus: 'opus',
}

const CONTENT_TYPES: Record<Container, string> = {
  mp3: 'audio/mpeg', flac: 'audio/flac', wav: 'audio/wav',
  aiff: 'audio/aiff', m4a: 'audio/mp4', ogg: 'audio/ogg', opus: 'audio/opus',
}

/** Extension is a hint for the size cap and the key suffix only. ffprobe in
 *  the analysis worker is authoritative for the real container. */
export function containerFromFilename(name: string): Container | null {
  const dot = name.lastIndexOf('.')
  if (dot <= 0 || dot === name.length - 1) return null
  return EXTENSIONS[name.slice(dot + 1).toLowerCase()] ?? null
}

export function contentTypeFor(c: Container): string {
  return CONTENT_TYPES[c]
}

/**
 * The largest a 15-minute file in this container can be, plus 10% for ID3
 * tags, embedded artwork and container overhead.
 *
 * This IS the server-side duration check available before bytes move.
 * `bytes * 8 / max_bitrate` is the minimum possible duration, so "under this
 * many bytes" and "could conceivably be under 15 minutes" are the same
 * inequality — there is no second lower-bound check to write.
 *
 * The 10% headroom is applied as `* 11 / 10` on an already-integer byte
 * count rather than `* 1.1`, because 1.1 has no exact binary floating-point
 * representation: `900*512*1000/8*1.1` evaluates to 63_360_000.00000001,
 * one byte over the intended ceiling once `Math.ceil` rounds it up.
 */
export function maxBytesFor(c: Container): number {
  const bytesNoHeadroom = (MAX_DURATION_MS * MAX_KBPS[c]) / 8
  return Math.ceil((bytesNoHeadroom * 11) / 10)
}

/** One part size per file, computed once and then stored. Never per part. */
export function partSizeFor(byteSize: number): number {
  if (Math.ceil(byteSize / PART_SIZE_BYTES) <= MAX_PARTS) return PART_SIZE_BYTES
  return Math.ceil(byteSize / MAX_PARTS / MIB) * MIB
}

export type UploadPlan =
  | { multipart: false; partSize: null; partCount: null }
  | { multipart: true; partSize: number; partCount: number }

export function planUpload(byteSize: number): UploadPlan {
  if (byteSize < MULTIPART_THRESHOLD_BYTES) {
    return { multipart: false, partSize: null, partCount: null }
  }
  const partSize = partSizeFor(byteSize)
  return { multipart: true, partSize, partCount: Math.ceil(byteSize / partSize) }
}

/** Byte range for a 1-based S3 part number. Derived from the stored
 *  partSize so every non-trailing part is exactly the same length. */
export function partRange(
  partNumber: number, partSize: number, byteSize: number,
): { start: number; end: number } {
  if (partNumber < 1) throw new Error('part numbers are 1-based')
  const start = (partNumber - 1) * partSize
  if (start >= byteSize) throw new Error(`part ${partNumber} is past the end of the file`)
  return { start, end: Math.min(start + partSize, byteSize) }
}

export type PreflightReason = 'unsupported_container' | 'too_long' | 'too_large' | 'empty'

export type PreflightVerdict =
  | { ok: true; container: Container; plan: UploadPlan }
  | { ok: false; reason: PreflightReason }

/**
 * Run before a byte moves — in the browser to skip the file, and again in
 * the API route because the browser's answer is a bandwidth optimisation,
 * not a control.
 *
 * `clientDurationMs === null` is legal and means the file header carried no
 * usable duration (header-less VBR MP3, non-faststart M4A). That is not a
 * rejection: the size gate still applies, and the analysis worker's decoded
 * duration is the number that actually decides.
 */
export function preflight(
  filename: string, byteSize: number, clientDurationMs: number | null,
): PreflightVerdict {
  const container = containerFromFilename(filename)
  if (!container) return { ok: false, reason: 'unsupported_container' }
  if (!Number.isFinite(byteSize) || byteSize <= 0) return { ok: false, reason: 'empty' }
  if (clientDurationMs !== null && clientDurationMs > MAX_DURATION_MS) {
    return { ok: false, reason: 'too_long' }
  }
  if (byteSize > maxBytesFor(container)) return { ok: false, reason: 'too_large' }
  return { ok: true, container, plan: planUpload(byteSize) }
}

const MESSAGES: Record<PreflightReason, string> = {
  unsupported_container: 'skipped — not an audio file we accept (mp3, flac, wav, aiff, m4a, ogg, opus)',
  too_long: 'skipped — longer than 15 minutes',
  too_large: 'skipped — too big to be under 15 minutes in this format (24-bit/192 kHz sources must be downsampled to 96 kHz first)',
  empty: 'skipped — the file is empty',
}

export function preflightMessage(v: PreflightVerdict): string {
  return v.ok ? 'ready' : MESSAGES[v.reason]
}
