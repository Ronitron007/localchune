#!/usr/bin/env bash
# The auth hook is wired in config.toml, which no SQL test can see. This
# asserts GoTrue actually loaded it.
set -euo pipefail
grep -q 'before_user_created' supabase/config.toml \
  || { echo "FAIL: before_user_created hook missing from config.toml"; exit 1; }
docker exec supabase_auth_localchune env 2>/dev/null \
  | grep -q 'GOTRUE_HOOK_BEFORE_USER_CREATED_ENABLED=true' \
  || { echo "FAIL: GoTrue has not loaded the hook. Run: npx supabase stop && npx supabase start"; exit 1; }
echo "OK: before_user_created hook registered and loaded"
