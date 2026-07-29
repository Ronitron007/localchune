// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.

import { describe, it, expect } from 'vitest'
import {
  MAX_DEPTH, MAX_FILES,
  isAcceptableSegment, isAcceptableAudioPath,
  walkEntry, walkEntries, filterFlatFiles,
  type FileSystemEntryLike, type FileEntryLike, type DirectoryEntryLike,
  type DirectoryReaderLike,
} from './dir-walk'

// ------------------------------------------------------------- fake entries

function fakeFile(name: string, size: number): FileEntryLike {
  return {
    name,
    isFile: true,
    isDirectory: false,
    file(success) {
      success(new File([new Uint8Array(size)], name))
    },
  }
}

/** A directory whose reader replays fixed batches, one per readEntries()
 *  call, ending with an empty array — the real DOM contract. */
function fakeDirBatched(name: string, batches: FileSystemEntryLike[][]): DirectoryEntryLike {
  return {
    name,
    isFile: false,
    isDirectory: true,
    createReader(): DirectoryReaderLike {
      let i = 0
      return {
        readEntries(success) {
          const batch = batches[i] ?? []
          i += 1
          queueMicrotask(() => success(batch))
        },
      }
    },
  }
}

/** A directory whose reader hands back all children in one shot — fine for
 *  tests that are not exercising the pagination behaviour itself. */
function fakeDir(name: string, children: FileSystemEntryLike[]): DirectoryEntryLike {
  return fakeDirBatched(name, [children])
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

// ------------------------------------------------------------------- tests

describe('walkEntry — readEntries() pagination', () => {
  it('loops until an empty batch, mandatory: 100+100+3 => 203 files', async () => {
    const children = Array.from({ length: 203 }, (_, i) => fakeFile(`track-${i}.mp3`, 1000))
    const batches = chunk(children, 100)
    expect(batches.map((b) => b.length)).toEqual([100, 100, 3])
    const dir = fakeDirBatched('pool', batches)

    const result = await walkEntry(dir)

    expect(result.ok).toBe(true)
    expect(result.files).toHaveLength(203)
  })

  it('does not stop after a single readEntries() call when more remain', async () => {
    // A naive one-shot implementation would see only the first 100 and
    // silently drop the rest — the exact bug this module exists to avoid.
    const children = Array.from({ length: 150 }, (_, i) => fakeFile(`t${i}.flac`, 10))
    const dir = fakeDirBatched('folder', chunk(children, 100))
    const result = await walkEntry(dir)
    expect(result.files).toHaveLength(150)
  })
})

describe('walkEntry — recursion', () => {
  it('descends into nested directories', async () => {
    const leaf = fakeDir('inner', [fakeFile('a.mp3', 10), fakeFile('b.wav', 10)])
    const mid = fakeDir('mid', [leaf, fakeFile('c.flac', 10)])
    const root = fakeDir('root', [mid])

    const result = await walkEntry(root)
    expect(result.ok).toBe(true)
    expect(result.files.map((f) => f.name).sort()).toEqual(['a.mp3', 'b.wav', 'c.flac'])
  })

  it('walks a lone file entry (no directory at all)', async () => {
    const result = await walkEntry(fakeFile('solo.mp3', 500))
    expect(result.ok).toBe(true)
    expect(result.files.map((f) => f.name)).toEqual(['solo.mp3'])
  })

  it('returns no files for a null root', async () => {
    const result = await walkEntry(null)
    expect(result).toEqual({ ok: true, files: [] })
  })
})

describe('walkEntry — extension allowlist (from upload-policy, not duplicated)', () => {
  it('keeps every allowlisted container', async () => {
    const names = ['a.mp3', 'b.flac', 'c.wav', 'd.aiff', 'e.m4a', 'f.ogg', 'g.opus']
    const dir = fakeDir('folder', names.map((n) => fakeFile(n, 10)))
    const result = await walkEntry(dir)
    expect(result.files.map((f) => f.name).sort()).toEqual([...names].sort())
  })

  it('drops files with an unsupported or missing extension', async () => {
    const dir = fakeDir('folder', [
      fakeFile('track.mp3', 10),
      fakeFile('cover.jpg', 10),
      fakeFile('tracklist.txt', 10),
      fakeFile('noextension', 10),
      fakeFile('virus.exe', 10),
    ])
    const result = await walkEntry(dir)
    expect(result.files.map((f) => f.name)).toEqual(['track.mp3'])
  })
})

describe('walkEntry — skips dotfiles, __MACOSX, zero-byte', () => {
  it('skips dotfile entries, both files and directories', async () => {
    const hiddenDir = fakeDir('.git', [fakeFile('config.mp3', 10)])
    const dir = fakeDir('folder', [
      fakeFile('.DS_Store', 10),
      fakeFile('track.mp3', 10),
      hiddenDir,
    ])
    const result = await walkEntry(dir)
    expect(result.files.map((f) => f.name)).toEqual(['track.mp3'])
  })

  it('skips a __MACOSX directory and everything under it', async () => {
    const macDir = fakeDir('__MACOSX', [fakeFile('._track.mp3', 10)])
    const dir = fakeDir('folder', [fakeFile('track.mp3', 10), macDir])
    const result = await walkEntry(dir)
    expect(result.files.map((f) => f.name)).toEqual(['track.mp3'])
  })

  it('skips zero-byte files', async () => {
    const dir = fakeDir('folder', [fakeFile('empty.mp3', 0), fakeFile('real.mp3', 10)])
    const result = await walkEntry(dir)
    expect(result.files.map((f) => f.name)).toEqual(['real.mp3'])
  })
})

describe('walkEntry — depth cap', () => {
  // Build a chain `levels` directories deep, with one file at the very
  // bottom. depth 0 is the root passed to walkEntry.
  function buildChain(levels: number, leafName: string): DirectoryEntryLike {
    let node = fakeDir(`d${levels}`, [fakeFile(leafName, 10)])
    for (let i = levels - 1; i >= 0; i -= 1) {
      node = fakeDir(`d${i}`, [node])
    }
    return node
  }

  it('reaches a file within the default cap (12)', async () => {
    // 11 nested directories below the root (depth 0..11), file at depth 12.
    const root = buildChain(11, 'deep.mp3')
    const result = await walkEntry(root)
    expect(result.files.map((f) => f.name)).toEqual(['deep.mp3'])
  })

  it('does not descend past the default cap (12)', async () => {
    // 12 nested directories below the root — the file would sit at depth 13.
    const root = buildChain(12, 'toodeep.mp3')
    const result = await walkEntry(root)
    expect(result.files).toEqual([])
  })

  it('honours a custom maxDepth', async () => {
    const root = buildChain(3, 'leaf.mp3')
    const shallow = await walkEntry(root, { maxDepth: 2 })
    expect(shallow.files).toEqual([])
    const deepEnough = await walkEntry(root, { maxDepth: 4 })
    expect(deepEnough.files.map((f) => f.name)).toEqual(['leaf.mp3'])
  })

  it('exports the documented default', () => {
    expect(MAX_DEPTH).toBe(12)
  })
})

describe('walkEntry — file-count guard', () => {
  it('returns a typed too-many result instead of throwing, and does not exceed the limit', async () => {
    const children = Array.from({ length: 7 }, (_, i) => fakeFile(`t${i}.mp3`, 10))
    const dir = fakeDir('folder', children)

    const result = await walkEntry(dir, { maxFiles: 5 })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe('too_many_files')
      expect(result.limit).toBe(5)
    }
    expect(result.files).toHaveLength(5)
  })

  it('is ok when the count lands exactly on the limit', async () => {
    const children = Array.from({ length: 5 }, (_, i) => fakeFile(`t${i}.mp3`, 10))
    const dir = fakeDir('folder', children)
    const result = await walkEntry(dir, { maxFiles: 5 })
    expect(result.ok).toBe(true)
    expect(result.files).toHaveLength(5)
  })

  it('exports the documented default of 2000', () => {
    expect(MAX_FILES).toBe(2000)
  })
})

describe('walkEntries — multiple top-level roots (mixed drop)', () => {
  it('combines loose files and folders dropped together', async () => {
    const folder = fakeDir('album', [fakeFile('01.mp3', 10), fakeFile('02.mp3', 10)])
    const looseFile = fakeFile('single.wav', 10)

    const result = await walkEntries([looseFile, folder])
    expect(result.ok).toBe(true)
    expect(result.files.map((f) => f.name).sort()).toEqual(['01.mp3', '02.mp3', 'single.wav'])
  })

  it('ignores null roots (browser gave up on webkitGetAsEntry for that item)', async () => {
    const folder = fakeDir('album', [fakeFile('01.mp3', 10)])
    const result = await walkEntries([null, folder, null])
    expect(result.files.map((f) => f.name)).toEqual(['01.mp3'])
  })

  it('enforces the file cap across roots cumulatively, not per root', async () => {
    const folderA = fakeDir('a', Array.from({ length: 4 }, (_, i) => fakeFile(`a${i}.mp3`, 10)))
    const folderB = fakeDir('b', Array.from({ length: 4 }, (_, i) => fakeFile(`b${i}.mp3`, 10)))
    const result = await walkEntries([folderA, folderB], { maxFiles: 5 })
    expect(result.ok).toBe(false)
    expect(result.files).toHaveLength(5)
  })
})

describe('isAcceptableAudioPath — shared filter (drop path and picker path)', () => {
  it('accepts an allowlisted extension at any relative depth', () => {
    expect(isAcceptableAudioPath('track.mp3', 10)).toBe(true)
    expect(isAcceptableAudioPath('Album/Disc 1/track.flac', 10)).toBe(true)
  })

  it('rejects zero-byte files', () => {
    expect(isAcceptableAudioPath('track.mp3', 0)).toBe(false)
  })

  it('rejects a non-audio extension', () => {
    expect(isAcceptableAudioPath('Album/cover.jpg', 10)).toBe(false)
  })

  it('rejects when any path segment is a dotfile', () => {
    expect(isAcceptableAudioPath('.hidden/track.mp3', 10)).toBe(false)
    expect(isAcceptableAudioPath('Album/.trashed/track.mp3', 10)).toBe(false)
  })

  it('rejects when any path segment is __MACOSX', () => {
    expect(isAcceptableAudioPath('__MACOSX/track.mp3', 10)).toBe(false)
    expect(isAcceptableAudioPath('Album/__MACOSX/track.mp3', 10)).toBe(false)
  })
})

describe('isAcceptableSegment', () => {
  it('rejects dotfiles and __MACOSX, accepts everything else', () => {
    expect(isAcceptableSegment('.DS_Store')).toBe(false)
    expect(isAcceptableSegment('__MACOSX')).toBe(false)
    expect(isAcceptableSegment('My Album')).toBe(true)
  })
})

describe('filterFlatFiles — webkitdirectory picker path', () => {
  // input.files from a webkitdirectory <input> arrives flat, each File
  // carrying webkitRelativePath. This is the picker-side counterpart to
  // walkEntry/walkEntries and must apply the identical filter.
  function flatFile(relativePath: string, size: number): File {
    const name = relativePath.split('/').at(-1) as string
    const file = new File([new Uint8Array(size)], name)
    Object.defineProperty(file, 'webkitRelativePath', { value: relativePath })
    return file
  }

  it('keeps allowlisted audio and drops junk, dotfiles, __MACOSX, zero-byte', () => {
    const files = [
      flatFile('MyPool/track1.mp3', 10),
      flatFile('MyPool/cover.jpg', 10),
      flatFile('MyPool/.DS_Store', 10),
      flatFile('MyPool/__MACOSX/track1.mp3', 10),
      flatFile('MyPool/Subfolder/track2.flac', 10),
      flatFile('MyPool/empty.wav', 0),
    ]
    const result = filterFlatFiles(files)
    expect(result.ok).toBe(true)
    expect(result.files.map((f) => f.name).sort()).toEqual(['track1.mp3', 'track2.flac'])
  })

  it('applies the same typed too-many-files guard as the drop path', () => {
    const files = Array.from({ length: 7 }, (_, i) => flatFile(`MyPool/t${i}.mp3`, 10))
    const result = filterFlatFiles(files, { maxFiles: 5 })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe('too_many_files')
      expect(result.limit).toBe(5)
    }
    expect(result.files).toHaveLength(5)
  })

  it('falls back to file.name when webkitRelativePath is absent', () => {
    const plain = new File([new Uint8Array(10)], 'plain.mp3')
    const result = filterFlatFiles([plain])
    expect(result.files.map((f) => f.name)).toEqual(['plain.mp3'])
  })
})
