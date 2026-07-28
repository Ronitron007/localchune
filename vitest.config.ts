// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.

import { defineConfig } from 'vitest/config'
export default defineConfig({
  test: {
    environment: 'node',
    // workers/** is here because the maintenance Worker's pure logic lives
    // outside src/. With the old src-only glob its tests were collected by
    // nothing and passWithNoTests kept the run green.
    include: ['src/**/*.test.ts', 'workers/**/*.test.ts'],
    passWithNoTests: true,
  },
})
