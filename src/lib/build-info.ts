// src/lib/build-info.ts
// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.

// Replaced textually by vite.define in astro.config.ts. Under Vitest they
// are simply absent, which is why every read is guarded — `typeof` on an
// undeclared identifier is legal JavaScript and yields 'undefined'.
declare const __BUILD_SHA__: string
declare const __BUILD_TIME__: string

export const REPO_URL = 'https://github.com/Ronitron007/localchune'

export const BUILD_SHA: string =
  typeof __BUILD_SHA__ === 'string' ? __BUILD_SHA__ : 'unknown'
export const BUILD_TIME: string =
  typeof __BUILD_TIME__ === 'string' ? __BUILD_TIME__ : ''

const isPinnable = (sha: string) => sha !== 'unknown' && !sha.endsWith('-dirty')

/** AGPL §13: the offer must be for the source of the version actually running. */
export function sourceUrl(sha: string = BUILD_SHA): string {
  return isPinnable(sha) ? `${REPO_URL}/tree/${sha}` : REPO_URL
}

export function shortSha(sha: string = BUILD_SHA): string {
  if (sha === 'unknown') return 'unknown'
  return sha.endsWith('-dirty')
    ? `${sha.slice(0, 7)}+`
    : sha.slice(0, 7)
}
