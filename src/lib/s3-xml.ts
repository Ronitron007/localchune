// src/lib/s3-xml.ts
// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.

/**
 * The four S3 XML bodies this app ever touches, parsed and built by hand.
 *
 * workerd has no DOMParser and pulling an XML library in for four flat,
 * fully-specified documents is not worth the bytes. Nothing here imports
 * anything, so it is the one part of the R2 path that runs under Vitest.
 */

/** Matches `<Tag>`, `<ns:Tag>` and `<Tag attr="x">`. */
function tagPattern(tag: string, flags = ''): RegExp {
  const p = '(?:[A-Za-z0-9._-]+:)?'
  return new RegExp(`<${p}${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${p}${tag}>`, flags)
}

/** `&amp;` is decoded LAST, so `&amp;quot;` yields `&quot;`, not `"`. */
export function decodeXmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, '&')
}

export function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export function extractTag(xml: string, tag: string): string | null {
  const m = tagPattern(tag).exec(xml)
  return m ? decodeXmlEntities(m[1]).trim() : null
}

export function parseUploadId(xml: string): string {
  const id = extractTag(xml, 'UploadId')
  if (!id) throw new Error('CreateMultipartUpload response carried no UploadId')
  return id
}

/**
 * Part ETags are hex; a completed multipart object's ETag is hex plus `-N`.
 * Anything else is either a bug or an attempt to inject markup into the
 * CompleteMultipartUpload body, and both must stop here.
 */
const ETAG_RE = /^[A-Za-z0-9]+(?:-[0-9]+)?$/

export function normalizeEtag(raw: string): string {
  const v = decodeXmlEntities(String(raw)).trim().replace(/^"+|"+$/g, '')
  if (!ETAG_RE.test(v)) throw new Error(`implausible ETag: ${JSON.stringify(raw)}`)
  return v
}

export type UploadedPart = { partNumber: number; etag: string; size: number }

export type ListPartsPage = {
  parts: UploadedPart[]
  isTruncated: boolean
  nextPartNumberMarker: number | null
}

/**
 * ListParts returns at most 1000 parts per call. Our largest legal file is
 * 34 parts, so truncation should never happen — but "should never happen"
 * silently dropping parts would present as a completion failure after every
 * byte was uploaded, so the caller pages properly.
 */
export function parseListParts(xml: string): ListPartsPage {
  const parts: UploadedPart[] = []
  for (const block of xml.matchAll(tagPattern('Part', 'g'))) {
    const body = block[1]
    const n = extractTag(body, 'PartNumber')
    const e = extractTag(body, 'ETag')
    const s = extractTag(body, 'Size')
    if (!n || !e) continue
    parts.push({ partNumber: Number(n), etag: normalizeEtag(e), size: s ? Number(s) : 0 })
  }
  parts.sort((a, b) => a.partNumber - b.partNumber)

  const isTruncated = extractTag(xml, 'IsTruncated') === 'true'
  const marker = extractTag(xml, 'NextPartNumberMarker')
  return {
    parts,
    isTruncated,
    nextPartNumberMarker: isTruncated && marker ? Number(marker) : null,
  }
}

/** Parts must be ascending and unique, or S3 answers InvalidPartOrder. */
export function buildCompleteMultipartUpload(
  parts: { partNumber: number; etag: string }[],
): string {
  if (parts.length === 0) throw new Error('CompleteMultipartUpload needs at least one part')
  const seen = new Set<number>()
  const body = [...parts]
    .sort((a, b) => a.partNumber - b.partNumber)
    .map((p) => {
      if (!Number.isInteger(p.partNumber) || p.partNumber < 1 || p.partNumber > 10_000) {
        throw new Error(`part number out of range: ${p.partNumber}`)
      }
      if (seen.has(p.partNumber)) throw new Error(`duplicate part number ${p.partNumber}`)
      seen.add(p.partNumber)
      const etag = escapeXml(normalizeEtag(p.etag))
      return `<Part><PartNumber>${p.partNumber}</PartNumber><ETag>&quot;${etag}&quot;</ETag></Part>`
    })
    .join('')
  return '<?xml version="1.0" encoding="UTF-8"?>'
    + '<CompleteMultipartUpload xmlns="http://s3.amazonaws.com/doc/2006-03-01/">'
    + body
    + '</CompleteMultipartUpload>'
}

export type S3ErrorBody = { code: string; message: string }

/**
 * Run against EVERY control-plane response, whatever the status.
 * CompleteMultipartUpload can return 200 with an Error body — S3 keeps the
 * connection open while it assembles the object and only then finds the
 * problem — so `res.ok` on its own reports success for a failed completion.
 */
export function parseS3Error(xml: string): S3ErrorBody | null {
  if (!/<(?:[A-Za-z0-9._-]+:)?Error[\s>]/.test(xml)) return null
  const code = extractTag(xml, 'Code')
  if (!code) return null
  return { code, message: extractTag(xml, 'Message') ?? '' }
}
