// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.

/// <reference types="astro/client" />
import type { Member } from './lib/session'
import type { SupabaseClient } from '@supabase/supabase-js'
declare global {
  namespace App {
    interface Locals {
      member: Member | null
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
