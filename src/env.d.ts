// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.

/// <reference types="astro/client" />
interface ImportMetaEnv {
  /** Public art bucket origin (spec 2026-08-01-art-bucket-split). */
  readonly PUBLIC_ART_BASE_URL?: string
}
import type { Member } from './lib/session'
import type { ChromeData } from './lib/page-data'
import type { SupabaseClient } from '@supabase/supabase-js'
declare global {
  namespace App {
    interface Locals {
      member: Member | null
      // Perf task 2.1. The nav badge and the storage footer, started by the
      // middleware BEFORE the page runs so their round trips overlap the
      // page's own instead of following them. A promise, deliberately —
      // storing the resolved values would mean awaiting them in middleware,
      // which is the sequential chain this replaces. Undefined on requests
      // the middleware does not start it for (every /api/* route, and any
      // request with no member).
      chrome?: Promise<ChromeData>
      // The cookie-bound client middleware already built for this request.
      // Task 6's admin page/API route must reuse this rather than calling
      // serverClient(cookies, request) again — a second instance's getAll
      // reads the original Cookie header and can race a refresh middleware
      // just performed. See src/middleware.ts.
      supabase: SupabaseClient
    }
  }
}
export {}
