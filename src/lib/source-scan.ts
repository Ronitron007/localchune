// src/lib/source-scan.ts
// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.
//
// A GUARD THAT MATCHES A BARE SUBSTRING EVENTUALLY MATCHES THE COMMENT
// THAT DOCUMENTS THE THING IT GUARDS. This repo has now paid for that five
// times:
//
//   · drag-bundle.test.ts       flagged the note recording that
//                               `is-dragging` was REMOVED;
//   · search-bundle.test.ts     flagged the comment naming the overlay
//                               module it forbids importing;
//   · crate-picker-single-source flagged the comment explaining that the
//                               "New crate…" label is a constant;
//   · crate-art.test.ts          flagged "no perspective transform" while
//                               asserting there is no perspective;
//   · tag-wiring.test.ts         flagged "`×` is U+00D7" while asserting
//                               the built chip contains no `×`.
//
// Every one of those is the same mistake: a rule about CODE reading PROSE.
// The fix is one line at the top of the scan, so it is written once here.
//
// Nothing in the app imports this — it exists for the source-scanning
// guards, which cannot import each other's test files. It is deliberately
// a plain module rather than a test helper so a future guard can find it
// by name.

/**
 * Source with its comments removed: `//` line comments, `/* *​/` blocks,
 * and Astro's `{/* *​/}` expression comments.
 *
 * Deliberately crude — a `//` inside a string literal is eaten too, and a
 * comment marker inside a regex literal is eaten as well. That is the
 * right trade for what this is used for: a guard asserting the ABSENCE of
 * something gets a false PASS from over-stripping only if the thing it
 * forbids is itself inside a string containing `//`, and every such guard
 * in this repo is paired with a positive assertion that the correct form
 * IS present.
 *
 * `(^|[^:])` before `//` keeps `https://` out of the line-comment rule,
 * which is the one over-strip that would otherwise happen constantly.
 */
export function withoutComments(src: string): string {
  return src
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
}
