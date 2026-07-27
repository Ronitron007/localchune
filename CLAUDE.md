## Supabase

- Changes to `auth`/`supabase/config.toml` (e.g. auth hooks) require `npx supabase stop && npx supabase start` to take effect. `npx supabase db reset` only restarts containers — it does NOT reload GoTrue's auth config.
