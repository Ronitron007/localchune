// src/lib/head-check.ts
// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.

/**
 * Content-integrity gate for the upload preflight.
 *
 * The incident this exists for: 29 FLACs selected out of a still-incomplete
 * torrent download. BitTorrent preallocates files at full size, so each one
 * existed, had the right extension and the right byte count — but its head
 * was megabytes of zeros (no `fLaC` magic anywhere in the first 12.4 MB of
 * the file that was checked). The duration preflight fails OPEN on a header
 * parse failure by design, so all 29 uploaded to R2 in full and then died in
 * the analysis worker with a raw ffprobe CalledProcessError.
 *
 * This module is the cheap client-side refusal that stops that class of file
 * before a byte moves. It reads a few KB and rejects ONLY when a KNOWN
 * extension provably contradicts its own bytes:
 *
 *   - the head is all zeros (the preallocation signature), or
 *   - the extension's magic number is absent where the format requires it.
 *
 * Everything ambiguous is allowed through: an unknown extension, an ID3v2
 * tag bigger than the read window, a truncated read. The fail-open
 * philosophy of preflight.ts stands for genuinely unknown formats — a false
 * reject is unrecoverable for the user, a false accept costs one upload that
 * analysis fails loudly (and, post this change, legibly — see
 * explainLastError in file-state.ts).
 *
 * `checkHead` is pure over (extension, bytes) so head-check.test.ts can
 * drive it with hand-built fixtures in vitest's node environment — no DOM,
 * no File, no worker.
 */

/** How much of the file the gate reads. Big enough to skip a typical
 *  ID3v2 tag (a few KB of text frames) and to find an MP3 frame sync
 *  behind junk; small enough to be one cheap read even off a network
 *  volume. An ID3v2 tag with embedded artwork can exceed this — that case
 *  falls through to "in doubt, allow". */
export const HEAD_CHECK_BYTES = 16 * 1024

export type HeadCheck =
  | { ok: true }
  | { ok: false; reason: 'zero_head' | 'magic_mismatch' }

const OK: HeadCheck = { ok: true }

/**
 * Format families this gate knows how to disprove. Deliberately NOT
 * upload-policy's EXTENSIONS map: that one answers "may this extension be
 * uploaded", this one answers "which magic must these bytes carry". `mov`
 * appears here (same ISO-BMFF `ftyp` layout) even though upload-policy does
 * not accept it — the checker stays honest about bytes and lets the size/
 * extension gate make its own decision. ogg/oga/opus carry no magic rule on
 * purpose (conservative: only the all-zeros preallocation signature can
 * reject them here) — see checkHead.
 */
type Family = 'flac' | 'mp3' | 'riff' | 'aiff' | 'isobmff' | 'ogg'

const FAMILY: Record<string, Family> = {
  flac: 'flac',
  mp3: 'mp3',
  wav: 'riff', wave: 'riff',
  aiff: 'aiff', aif: 'aiff', aifc: 'aiff',
  m4a: 'isobmff', mp4: 'isobmff', mov: 'isobmff',
  ogg: 'ogg', oga: 'ogg', opus: 'ogg',
}

/** Bare lowercase extension, or null when the name has none. Mirrors
 *  containerFromFilename's slicing exactly (dot not first, not last). */
export function extensionOf(name: string): string | null {
  const dot = name.lastIndexOf('.')
  if (dot <= 0 || dot === name.length - 1) return null
  return name.slice(dot + 1).toLowerCase()
}

const matchesAt = (head: Uint8Array, offset: number, ascii: string): boolean => {
  if (offset < 0 || offset + ascii.length > head.length) return false
  for (let i = 0; i < ascii.length; i++) {
    if (head[offset + i] !== ascii.charCodeAt(i)) return false
  }
  return true
}

const allZeros = (head: Uint8Array): boolean => head.every((b) => b === 0)

/**
 * Where the audio starts after any leading ID3v2 tags, or null when the
 * answer is past the read window (or the tag header is malformed) — i.e.
 * "cannot tell from these bytes". ID3v2 = "ID3" + version(2) + flags(1) +
 * syncsafe size(4); the size EXCLUDES the 10-byte header and the optional
 * 10-byte footer (flag 0x10). Tags can stack, hence the loop.
 */
function skipId3v2(head: Uint8Array): number | null {
  let offset = 0
  while (matchesAt(head, offset, 'ID3')) {
    if (offset + 10 > head.length) return null
    const flags = head[offset + 5]
    const s = head.subarray(offset + 6, offset + 10)
    // A syncsafe byte never has its top bit set; one that does means a
    // malformed tag this module must not pretend to understand.
    if (s.some((b) => b >= 0x80)) return null
    const size = (s[0] << 21) | (s[1] << 14) | (s[2] << 7) | s[3]
    offset += 10 + size + ((flags & 0x10) !== 0 ? 10 : 0)
    if (offset > head.length) return null
  }
  return offset
}

/** True when an MPEG frame sync (0xFF then top three bits set) appears
 *  anywhere in the head. Scanned, not anchored: legit MP3s open with ID3v2,
 *  APE tags or plain junk, and decoders scan for sync exactly like this. */
function hasMp3FrameSync(head: Uint8Array): boolean {
  for (let i = 0; i + 1 < head.length; i++) {
    if (head[i] === 0xff && (head[i + 1] & 0xe0) === 0xe0) return true
  }
  return false
}

/** `ftyp` box type within the first 64 bytes. Normally at offset 4
 *  ([size][ftyp]...), but scanned across the window so an unusual leading
 *  box does not cause a false reject. */
function hasFtyp(head: Uint8Array): boolean {
  const last = Math.min(64, head.length - 4)
  for (let i = 0; i <= last; i++) {
    if (matchesAt(head, i, 'ftyp')) return true
  }
  return false
}

/**
 * The gate. Pure. `extension` is the bare lowercase extension (extensionOf);
 * `head` is the first HEAD_CHECK_BYTES of the file (or the whole file when
 * shorter). Returns ok unless a KNOWN extension provably contradicts these
 * bytes; every doubt resolves to ok.
 */
export function checkHead(extension: string | null, head: Uint8Array): HeadCheck {
  const family = extension === null ? undefined : FAMILY[extension]
  // Unknown extension: not this gate's business. upload-policy's own
  // extension gate decides whether it uploads at all.
  if (family === undefined) return OK
  // A zero-length read proves nothing (and a zero-SIZE file never gets
  // here — isAcceptableAudioPath and preflight() both reject size <= 0).
  if (head.length === 0) return OK
  // The BitTorrent preallocation signature: a real file of any known audio
  // format cannot open with this many zero bytes.
  if (allZeros(head)) return { ok: false, reason: 'zero_head' }

  switch (family) {
    case 'flac': {
      const start = skipId3v2(head)
      if (start === null) return OK // tag exceeds the window — cannot tell
      if (start + 4 > head.length) return OK
      return matchesAt(head, start, 'fLaC') ? OK : { ok: false, reason: 'magic_mismatch' }
    }
    case 'mp3':
      return matchesAt(head, 0, 'ID3') || hasMp3FrameSync(head)
        ? OK
        : { ok: false, reason: 'magic_mismatch' }
    case 'riff':
      // RF64 is the >4 GB extension of RIFF/WAVE; tools emit it on
      // otherwise ordinary files, so it must not be a false reject.
      return matchesAt(head, 0, 'RIFF') || matchesAt(head, 0, 'RF64')
        ? OK
        : { ok: false, reason: 'magic_mismatch' }
    case 'aiff':
      return matchesAt(head, 0, 'FORM') ? OK : { ok: false, reason: 'magic_mismatch' }
    case 'isobmff':
      return hasFtyp(head) ? OK : { ok: false, reason: 'magic_mismatch' }
    case 'ogg':
      // No magic rule on purpose. `OggS` is near-universal, but this gate
      // only fires on PROOF, and the all-zeros check above already catches
      // the preallocation incident for these files.
      return OK
  }
}

/**
 * The DOM-boundary wrapper UploadDropzone calls: slice the head off a
 * Blob/File and run the pure check. A failed READ is not a failed CHECK —
 * any I/O error resolves to ok, and the existing preflight/upload path gets
 * to produce its own, better error for an unreadable file.
 */
export async function checkBlobHead(name: string, blob: Blob): Promise<HeadCheck> {
  try {
    const buf = await blob.slice(0, HEAD_CHECK_BYTES).arrayBuffer()
    return checkHead(extensionOf(name), new Uint8Array(buf))
  } catch {
    return OK
  }
}
