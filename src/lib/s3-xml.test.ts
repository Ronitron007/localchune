// src/lib/s3-xml.test.ts
// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.

import { describe, it, expect } from 'vitest'
import {
  decodeXmlEntities, escapeXml, extractTag, normalizeEtag,
  parseUploadId, parseListParts, buildCompleteMultipartUpload, parseS3Error,
} from './s3-xml'

const CREATE_MPU = `<?xml version="1.0" encoding="UTF-8"?>
<InitiateMultipartUploadResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Bucket>localchune-audio-dev</Bucket>
  <Key>audio/11111111-1111-1111-1111-111111111111/22222222-2222-2222-2222-222222222222.flac</Key>
  <UploadId>ABC-123_upload~id</UploadId>
</InitiateMultipartUploadResult>`

const LIST_PARTS = `<?xml version="1.0" encoding="UTF-8"?>
<ListPartsResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Bucket>localchune-audio-dev</Bucket>
  <UploadId>ABC-123_upload~id</UploadId>
  <MaxParts>1000</MaxParts>
  <IsTruncated>false</IsTruncated>
  <Part>
    <PartNumber>2</PartNumber>
    <ETag>&quot;bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb&quot;</ETag>
    <Size>16777216</Size>
  </Part>
  <Part>
    <PartNumber>1</PartNumber>
    <ETag>&quot;aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa&quot;</ETag>
    <Size>16777216</Size>
  </Part>
</ListPartsResult>`

const LIST_PARTS_TRUNCATED = `<?xml version="1.0" encoding="UTF-8"?>
<ListPartsResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <IsTruncated>true</IsTruncated>
  <NextPartNumberMarker>1000</NextPartNumberMarker>
  <Part>
    <PartNumber>1</PartNumber>
    <ETag>"cccccccccccccccccccccccccccccccc"</ETag>
    <Size>16777216</Size>
  </Part>
</ListPartsResult>`

const S3_ERROR = `<?xml version="1.0" encoding="UTF-8"?>
<Error>
  <Code>NoSuchUpload</Code>
  <Message>The specified multipart upload does not exist.</Message>
  <RequestId>abcd</RequestId>
</Error>`

describe('decodeXmlEntities', () => {
  it('decodes the five predefined entities', () => {
    expect(decodeXmlEntities('&lt;a&gt; &quot;b&quot; &apos;c&apos; &amp;')).toBe(`<a> "b" 'c' &`)
  })
  it('decodes &amp; last so &amp;quot; does not become a quote', () => {
    expect(decodeXmlEntities('&amp;quot;')).toBe('&quot;')
  })
})

describe('escapeXml', () => {
  it('escapes the characters that could break out of a text node', () => {
    expect(escapeXml('a & b < c > "d"')).toBe('a &amp; b &lt; c &gt; &quot;d&quot;')
  })
})

describe('extractTag', () => {
  it('reads a tag body', () => {
    expect(extractTag(CREATE_MPU, 'Bucket')).toBe('localchune-audio-dev')
  })
  it('tolerates a namespace prefix', () => {
    expect(extractTag('<s3:UploadId>xyz</s3:UploadId>', 'UploadId')).toBe('xyz')
  })
  it('returns null for a tag that is not there', () => {
    expect(extractTag(CREATE_MPU, 'NoSuchTag')).toBeNull()
  })
})

describe('parseUploadId', () => {
  it('reads the UploadId out of a CreateMultipartUpload response', () => {
    expect(parseUploadId(CREATE_MPU)).toBe('ABC-123_upload~id')
  })
  it('throws rather than returning an empty upload id', () => {
    expect(() => parseUploadId('<Whatever/>')).toThrow('no UploadId')
  })
})

describe('normalizeEtag', () => {
  it('strips the surrounding quotes', () => {
    expect(normalizeEtag('"abc123"')).toBe('abc123')
  })
  it('decodes an entity-escaped quote first', () => {
    expect(normalizeEtag('&quot;abc123&quot;')).toBe('abc123')
  })
  it('accepts the composite -N form and rejects anything else', () => {
    expect(normalizeEtag('"abc123-7"')).toBe('abc123-7')
    expect(() => normalizeEtag('</ETag><script>')).toThrow('implausible ETag')
  })
})

describe('parseListParts', () => {
  it('parses every part', () => {
    expect(parseListParts(LIST_PARTS).parts).toHaveLength(2)
  })
  it('sorts by part number and unquotes the ETags', () => {
    expect(parseListParts(LIST_PARTS).parts.map((p) => [p.partNumber, p.etag])).toEqual([
      [1, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'],
      [2, 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'],
    ])
  })
  it('reports no truncation and no marker on a complete listing', () => {
    expect(parseListParts(LIST_PARTS)).toMatchObject({
      isTruncated: false, nextPartNumberMarker: null,
    })
  })
  it('reports the marker the next page has to start from', () => {
    expect(parseListParts(LIST_PARTS_TRUNCATED)).toMatchObject({
      isTruncated: true, nextPartNumberMarker: 1000,
    })
  })
  it('returns an empty list for an upload nothing has landed in yet', () => {
    expect(parseListParts('<ListPartsResult><IsTruncated>false</IsTruncated></ListPartsResult>').parts)
      .toEqual([])
  })
})

describe('buildCompleteMultipartUpload', () => {
  it('emits one Part element per part, ETag quoted', () => {
    expect(buildCompleteMultipartUpload([{ partNumber: 1, etag: 'abc' }]))
      .toContain('<Part><PartNumber>1</PartNumber><ETag>&quot;abc&quot;</ETag></Part>')
  })
  it('sorts ascending — S3 answers InvalidPartOrder otherwise', () => {
    const xml = buildCompleteMultipartUpload([
      { partNumber: 3, etag: 'ccc' }, { partNumber: 1, etag: 'aaa' }, { partNumber: 2, etag: 'bbb' },
    ])
    expect(xml.indexOf('aaa')).toBeLessThan(xml.indexOf('bbb'))
    expect(xml.indexOf('bbb')).toBeLessThan(xml.indexOf('ccc'))
  })
  it('refuses an empty part list', () => {
    expect(() => buildCompleteMultipartUpload([])).toThrow('at least one part')
  })
  it('refuses a duplicated part number', () => {
    expect(() => buildCompleteMultipartUpload([
      { partNumber: 1, etag: 'aaa' }, { partNumber: 1, etag: 'bbb' },
    ])).toThrow('duplicate part number 1')
  })
  it('refuses an ETag that could inject markup', () => {
    expect(() => buildCompleteMultipartUpload([{ partNumber: 1, etag: '"a"</ETag><X>' }]))
      .toThrow('implausible ETag')
  })
})

describe('parseS3Error', () => {
  it('reads the code and the message', () => {
    expect(parseS3Error(S3_ERROR)).toEqual({
      code: 'NoSuchUpload',
      message: 'The specified multipart upload does not exist.',
    })
  })
  it('returns null for a body that is not an error', () => {
    expect(parseS3Error(CREATE_MPU)).toBeNull()
  })
  it('finds an error even in a 200 CompleteMultipartUpload body', () => {
    // S3 holds the connection open while it assembles the object, so a
    // failed completion can arrive as HTTP 200 with an Error body.
    const body = `<?xml version="1.0" encoding="UTF-8"?>
      <Error><Code>InvalidPart</Code><Message>One or more of the specified parts could not be found.</Message></Error>`
    expect(parseS3Error(body)?.code).toBe('InvalidPart')
  })
})
