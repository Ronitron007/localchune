// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.

// getViteConfig, not vitest's own defineConfig: it hands the test run the
// project's real Astro/Vite pipeline, which is what lets a test `import`
// a `.astro` component and render it through experimental_AstroContainer.
// Without it, vite's import analysis reads the component's template as JS
// and the file fails to parse. Phase 2's element/byte budget tests
// (track-row.test.ts, divergence-strip.test.ts) measure RENDERED markup —
// a budget checked against the template source would count the template,
// not the page.
/// <reference types="vitest/config" />
import { getViteConfig } from 'astro/config'

export default getViteConfig({
  // The Astro pipeline brings a dev server with it, and its websocket
  // listener binds a fixed port. Two checkouts running vitest at once (the
  // redesign was executed by two workers in parallel worktrees) then race
  // for it and the second run dies with EADDRINUSE before a single test
  // executes. Nothing in this suite uses HMR — turn the socket off.
  server: { hmr: false, ws: false },
  test: {
    environment: 'node',
    // workers/** is here because the maintenance Worker's pure logic lives
    // outside src/. With the old src-only glob its tests were collected by
    // nothing and passWithNoTests kept the run green.
    include: ['src/**/*.test.ts', 'workers/**/*.test.ts'],
    passWithNoTests: true,
  },
})
