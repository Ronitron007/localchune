// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.

/// <reference types="astro/client" />
import type { Member } from './lib/session'
declare global {
  namespace App {
    interface Locals {
      member: Member | null
      accessToken: string | null
    }
  }
}
export {}
