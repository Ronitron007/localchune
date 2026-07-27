# Foundations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A deployed Astro app on Cloudflare where only allowlisted Google accounts can sign in, backed by the core Postgres schema with RLS, plus an owner-only admin page for managing the allowlist.

**Architecture:** Supabase Auth with Google OAuth, gated by a **Before User Created Hook** that rejects non-allowlisted emails *before* an `auth.users` row exists. Access is an `access_expires_at timestamptz` on `members` — never a mutable credits integer — extended by an append-only `credit_grants` ledger whose idempotency is a `UNIQUE` constraint. RLS is the enforcement boundary; v1 checks `members` directly, and the JWT-claim optimisation is deferred until query stats justify it.

**Tech Stack:** Astro 7 + Solid islands, `@astrojs/cloudflare` (SSR), Supabase (Postgres 15 + Auth), `@supabase/supabase-js`, Vitest (node environment, no jsdom), Wrangler 4.

## Global Constraints

- **Astro must be SSR**, not `output: 'static'`. butternutcrack is static and fetches Supabase at build time; a pool with continuous uploads cannot work that way.
- **Every table has RLS enabled. No table gets an `INSERT`/`UPDATE`/`DELETE` policy.** All mutations go through `security definer` functions with `set search_path = ''`, `revoke execute from public`, explicit `grant execute`. This includes admin paths: the service-role key bypasses RLS, so routing admin writes through a definer function keeps the authorisation check in the database rather than only in the Worker, where a routing mistake would expose it.
- **No RLS policy on table X may `SELECT FROM` table X.** Postgres raises `42P17 infinite recursion detected in policy`. Use a `security definer` helper (`is_owner()`), which bypasses RLS on its own reads.
- Every RLS policy is `TO authenticated` and wraps `auth.uid()` / `auth.jwt()` in a scalar subquery — `(select auth.uid())`. Both are large measured performance wins.
- `timestamptz` everywhere. Never `timestamp`.
- Allowlist emails are stored lowercased, with Gmail dot/plus normalisation applied on insert.
- Auth hooks are registered in `supabase/config.toml`, not only the dashboard.
- Vitest runs in the **node** environment. No jsdom. Test pure logic; stub browser globals when needed.
- No secrets in the repo. `.env` is gitignored from commit 1.
- Own source files carry an MIT header (PRD §7.3 rule 1) — do this now, before any outside contribution.

---

## File Structure

| Path | Responsibility |
|---|---|
| `astro.config.ts` | Astro config, Cloudflare SSR adapter, Solid integration |
| `wrangler.jsonc` | Worker name, compat date, R2 binding, vars |
| `src/lib/email.ts` | Email normalisation (lowercase, Gmail dot/plus folding). Pure, no deps. |
| `src/lib/email.test.ts` | Tests for the above |
| `src/lib/supabase.ts` | Browser Supabase client factory (anon key, session persistence) |
| `src/lib/supabase.server.ts` | Server-side client factory from a request's cookies; service-role client |
| `src/lib/session.ts` | `requireMember(request)` → member or redirect. Used by every protected route. |
| `src/lib/session.test.ts` | Tests for the above |
| `src/middleware.ts` | Astro middleware: attach `locals.member`, redirect unauthenticated |
| `src/pages/login.astro` | Google sign-in button, error surface for the 403 |
| `src/pages/auth/callback.ts` | OAuth code exchange → cookie |
| `src/pages/auth/signout.ts` | Sign out |
| `src/pages/index.astro` | Placeholder pool page (proves auth works) |
| `src/pages/admin/index.astro` | Owner-only member list |
| `src/pages/api/admin/allowlist.ts` | POST add / DELETE revoke, owner-only |
| `src/components/AllowlistForm.tsx` | Solid island for the admin page |
| `supabase/migrations/…_01_members.sql` | `allowlist`, `members`, `credit_grants`, `grant_days()` |
| `supabase/migrations/…_02_auth_hooks.sql` | `hook_before_user_created`, `handle_new_user` trigger |
| `supabase/migrations/…_03_views.sql` | `my_membership` view |
| `supabase/migrations/…_04_seed_owner.sql` | Bootstrap the owner row |
| `supabase/config.toml` | Project config **including `[auth.hook.before_user_created]`** |

---

### Task 1: Project scaffold

**Files:**
- Create: `package.json`, `astro.config.ts`, `tsconfig.json`, `vitest.config.ts`, `wrangler.jsonc`, `.gitignore`, `.env.example`, `LICENSE`, `README.md`

**Interfaces:**
- Produces: a buildable Astro SSR project. Later tasks assume `npm run dev`, `npm test`, `npm run build` work.

- [ ] **Step 1: Create the project**

```bash
cd /Users/rohanmalik/localchune
npm create astro@latest . -- --template minimal --typescript strict --no-install --no-git --skip-houston
npm i @astrojs/cloudflare @astrojs/solid-js solid-js @supabase/supabase-js
npm i -D vitest wrangler @cloudflare/workers-types
```

- [ ] **Step 2: Write `astro.config.ts`**

```ts
import { defineConfig } from 'astro/config'
import cloudflare from '@astrojs/cloudflare'
import solid from '@astrojs/solid-js'

export default defineConfig({
  output: 'server',
  adapter: cloudflare({ imageService: 'passthrough' }),
  integrations: [solid()],
  vite: { ssr: { external: ['node:buffer'] } },
})
```

- [ ] **Step 3: Write `wrangler.jsonc`**

```jsonc
{
  "name": "localchune",
  "main": "./dist/_worker.js/index.js",
  "compatibility_date": "2026-07-01",
  "compatibility_flags": ["nodejs_compat"],
  "assets": { "directory": "./dist", "binding": "ASSETS" },
  "observability": { "enabled": true }
}
```

- [ ] **Step 4: Write `vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config'
export default defineConfig({
  test: { environment: 'node', include: ['src/**/*.test.ts'], passWithNoTests: true },
})
```

- [ ] **Step 5: Write `.gitignore` and `.env.example`**

`.gitignore`:
```
node_modules/
dist/
.astro/
.wrangler/
.env
.env.*
!.env.example
*.local
```

`.env.example`:
```
PUBLIC_SUPABASE_URL=https://xxxx.supabase.co
PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_KEY=
```

- [ ] **Step 6: Add the MIT header note to `README.md`**

```markdown
# localchune

A private, invite-only track pool for a small DJ circle.

## Licence

This project's own source is MIT (see `LICENSE`). **The distributed combination
is AGPL-3.0**, because the analysis worker includes Essentia (AGPL-3.0).
Source: <https://github.com/…> — see the footer of the running app for the
exact deployed commit.
```

- [ ] **Step 7: Verify the build**

Run: `npm run build`
Expected: exits 0, produces `dist/_worker.js/`

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "chore: astro ssr scaffold on cloudflare"
```

---

### Task 2: Email normalisation

Gmail delivers `r.o.h.a.n@gmail.com` and `rohan+dj@gmail.com` to `rohan@gmail.com`, but a naive `lower(email)` allowlist match rejects both. Normalise on the way in.

**Files:**
- Create: `src/lib/email.ts`
- Test: `src/lib/email.test.ts`

**Interfaces:**
- Produces: `normalizeEmail(raw: string): string` — used by the admin API before insert, and mirrored in SQL by the auth hook.

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/email.test.ts
import { describe, it, expect } from 'vitest'
import { normalizeEmail } from './email'

describe('normalizeEmail', () => {
  it('lowercases and trims', () => {
    expect(normalizeEmail('  Rohan@Example.COM ')).toBe('rohan@example.com')
  })
  it('strips dots in the gmail local part', () => {
    expect(normalizeEmail('r.o.h.a.n@gmail.com')).toBe('rohan@gmail.com')
  })
  it('strips a gmail plus-tag', () => {
    expect(normalizeEmail('rohan+dj@gmail.com')).toBe('rohan@gmail.com')
  })
  it('treats googlemail as gmail', () => {
    expect(normalizeEmail('ro.han+x@googlemail.com')).toBe('rohan@gmail.com')
  })
  it('leaves non-gmail dots and plus alone', () => {
    expect(normalizeEmail('first.last+tag@fastmail.com')).toBe('first.last+tag@fastmail.com')
  })
  it('throws on input with no @', () => {
    expect(() => normalizeEmail('nope')).toThrow('invalid email')
  })
  it('throws on input with more than one @', () => {
    expect(() => normalizeEmail('a@b@c')).toThrow('invalid email')
  })
})
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run src/lib/email.test.ts`
Expected: FAIL — `Failed to resolve import "./email"`

- [ ] **Step 3: Implement**

```ts
// src/lib/email.ts
const GMAIL_DOMAINS = new Set(['gmail.com', 'googlemail.com'])

/**
 * Fold an email to the address that actually receives mail, so an allowlist
 * cannot be bypassed with dots or plus-tags on Gmail.
 */
export function normalizeEmail(raw: string): string {
  const trimmed = raw.trim().toLowerCase()
  const parts = trimmed.split('@')
  if (parts.length !== 2 || !parts[0] || !parts[1]) throw new Error('invalid email')
  let [local, domain] = parts
  if (GMAIL_DOMAINS.has(domain)) {
    local = local.split('+')[0].replaceAll('.', '')
    domain = 'gmail.com'
    if (!local) throw new Error('invalid email')
  }
  return `${local}@${domain}`
}
```

- [ ] **Step 4: Run it and confirm it passes**

Run: `npx vitest run src/lib/email.test.ts`
Expected: PASS, 7 tests

- [ ] **Step 5: Commit**

```bash
git add src/lib/email.ts src/lib/email.test.ts
git commit -m "feat: email normalisation — gmail dot/plus folding"
```

---

### Task 3: Core schema

**Files:**
- Create: `supabase/migrations/20260727120000_01_members.sql`

**Interfaces:**
- Produces: tables `allowlist`, `members`, `credit_grants`; function `public.grant_days(uuid, int, text, text) returns timestamptz`. Task 4's trigger calls `grant_days`. Task 6's admin API inserts into `allowlist`.

- [ ] **Step 0: Enable pgTAP**

Tasks 3, 4 and 6 all write pgTAP assertions (`plan()`, `is()`, `ok()`, `throws_ok()`). Nothing enables the extension by default, and `supabase test db` fails with `function plan(integer) does not exist` without it.

Create `supabase/migrations/20260727115900_00_pgtap.sql`:

```sql
create extension if not exists pgtap with schema extensions;
```

Keep it in its own migration ordered before the schema, so a `db reset` always has the test harness available before any test runs.

- [ ] **Step 1: Write the migration**

```sql
-- supabase/migrations/20260727120000_01_members.sql

create table public.allowlist (
  email              text primary key check (email = lower(email)),
  note               text,
  initial_grant_days int not null default 30 check (initial_grant_days > 0),
  invited_at         timestamptz not null default now(),
  revoked_at         timestamptz
);
alter table public.allowlist enable row level security;
-- Deliberately ZERO policies for anon/authenticated => invisible to clients.
-- service_role has BYPASSRLS, so admin paths still work.

-- Auth hooks run as supabase_auth_admin, which is NOT bypassrls:
grant usage on schema public to supabase_auth_admin;
grant select on public.allowlist to supabase_auth_admin;
create policy "auth admin reads allowlist"
  on public.allowlist for select to supabase_auth_admin using (true);

create table public.members (
  user_id           uuid primary key references auth.users(id) on delete cascade,
  email             text not null unique,
  role              text not null default 'member' check (role in ('member','owner')),
  access_expires_at timestamptz not null default now(),
  created_at        timestamptz not null default now()
);
alter table public.members enable row level security;
create index members_expires_idx on public.members (access_expires_at);

grant select on public.members to supabase_auth_admin;
create policy "auth admin reads members"
  on public.members for select to supabase_auth_admin using (true);

-- CRITICAL: an RLS policy ON members that SELECTs FROM members recurses
-- infinitely. Postgres raises 42P17 "infinite recursion detected in policy".
-- The escape is a SECURITY DEFINER function, which bypasses RLS on its own
-- reads. This is the single most common Supabase RLS footgun.
create or replace function public.is_owner()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.members
                  where user_id = auth.uid() and role = 'owner');
$$;
revoke execute on function public.is_owner() from public, anon;
grant  execute on function public.is_owner() to authenticated;

-- Exactly one row, always. The middleware calls this instead of selecting
-- from members, because with the owner policy below a plain select returns
-- EVERY member for an owner, and .maybeSingle() then errors on >1 row.
create or replace function public.current_member()
returns table (user_id uuid, email text, role text, access_expires_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select m.user_id, m.email, m.role, m.access_expires_at
    from public.members m
   where m.user_id = auth.uid();
$$;
revoke execute on function public.current_member() from public, anon;
grant  execute on function public.current_member() to authenticated;

create policy "members read own row"
  on public.members for select to authenticated
  using ( user_id = (select auth.uid()) );

create policy "owner reads all members"
  on public.members for select to authenticated
  using ( (select public.is_owner()) );

-- Append-only grant ledger. Idempotency is the UNIQUE constraint, not careful code.
create table public.credit_grants (
  id         bigserial primary key,
  user_id    uuid not null references public.members(user_id) on delete cascade,
  days       int  not null check (days > 0),
  reason     text not null check (reason in ('invite','track_upload','quality_upgrade','manual')),
  dedupe_key text not null,
  created_at timestamptz not null default now(),
  unique (user_id, dedupe_key)
);
alter table public.credit_grants enable row level security;
create policy "members read own grants"
  on public.credit_grants for select to authenticated
  using ( user_id = (select auth.uid()) );

create or replace function public.grant_days(
  p_user uuid, p_days int, p_reason text, p_dedupe text
) returns timestamptz
language plpgsql security definer set search_path = '' as $$
declare v_new timestamptz;
begin
  insert into public.credit_grants(user_id, days, reason, dedupe_key)
  values (p_user, p_days, p_reason, p_dedupe)
  on conflict (user_id, dedupe_key) do nothing;

  if not found then
    select access_expires_at into v_new from public.members where user_id = p_user;
    return v_new;
  end if;

  update public.members
     set access_expires_at = greatest(access_expires_at, now())
                             + make_interval(days => p_days)
   where user_id = p_user
  returning access_expires_at into v_new;
  return v_new;
end $$;

revoke execute on function public.grant_days(uuid,int,text,text) from public, anon, authenticated;
grant  execute on function public.grant_days(uuid,int,text,text) to service_role;

-- ============================================================
-- BASE TABLE GRANTS — without these, every RLS policy above is
-- dead code.
-- ============================================================
-- RLS filters rows only AFTER Postgres' table-level ACL check passes.
-- Supabase's current default (`auto_expose_new_tables` unset, matching the
-- cloud default) gives anon/authenticated/service_role only Dxtm on new
-- tables — no SELECT/INSERT/UPDATE/DELETE. So a policy without a matching
-- GRANT never runs: the query fails with "permission denied for table".
--
-- And service_role's BYPASSRLS does NOT rescue this. BYPASSRLS skips row
-- filtering; it does not skip the ACL. A service-role write to a table with
-- no INSERT grant fails outright.
grant select on public.members, public.credit_grants to authenticated;
grant select, insert, update, delete
   on public.allowlist, public.members, public.credit_grants to service_role;

-- allowlist is deliberately NOT granted to authenticated: it has zero
-- policies for that role, so it stays invisible to clients. Owners reach it
-- only through the security definer functions in Task 6.
```

- [ ] **Step 2: Apply it locally**

Run: `npx supabase start && npx supabase db reset`
Expected: migration applies without error

- [ ] **Step 3: Write the idempotency test as SQL**

Create `supabase/tests/grant_days.sql`:

```sql
begin;
select plan(4);

insert into auth.users (id, email) values ('00000000-0000-0000-0000-000000000001','a@b.com');
insert into public.members (user_id, email) values ('00000000-0000-0000-0000-000000000001','a@b.com');

select ok(
  public.grant_days('00000000-0000-0000-0000-000000000001', 30, 'invite', 'invite')
    > now() + interval '29 days',
  'first grant extends by 30 days');

select ok(
  public.grant_days('00000000-0000-0000-0000-000000000001', 30, 'invite', 'invite')
    < now() + interval '31 days',
  'replayed grant with the same dedupe_key is a no-op');

select is( (select count(*)::int from public.credit_grants), 1,
  'replayed grant inserted no second ledger row');

select ok(
  public.grant_days('00000000-0000-0000-0000-000000000001', 1, 'track_upload', 'track:abc')
    > now() + interval '30 days',
  'a different dedupe_key does extend');

select * from finish();
rollback;
```

- [ ] **Step 4: Run it**

Run: `npx supabase test db`
Expected: 4 tests pass. **The second and third assertions are the point** — they prove a double-fire cannot double-grant.

- [ ] **Step 4b: Prove the RLS policies are actually reachable**

Every assertion above calls `grant_days()`, which is `security definer` and therefore immune to the base-ACL problem. That means the suite above would still pass with every table grant missing and all three read policies dead. Test the role-based paths explicitly.

Create `supabase/tests/rls_reachable.sql`:

```sql
begin;
select plan(6);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000c1','m1@gmail.com'),
  ('00000000-0000-0000-0000-0000000000c2','m2@gmail.com');
insert into public.members (user_id, email) values
  ('00000000-0000-0000-0000-0000000000c1','m1@gmail.com'),
  ('00000000-0000-0000-0000-0000000000c2','m2@gmail.com');

set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000c1"}';

-- If the base GRANT is missing these raise 42501 "permission denied for
-- table", NOT an empty result. lives_ok distinguishes the two.
select lives_ok( $$ select 1 from public.members limit 1 $$,
                 'authenticated can reach members at all (base grant present)' );
select is( (select count(*)::int from public.members), 1,
           'members RLS returns exactly the caller''s own row' );
select lives_ok( $$ select 1 from public.credit_grants limit 1 $$,
                 'authenticated can reach credit_grants' );

-- allowlist stays invisible. Note this is NOT "returns zero rows" — it has no
-- base grant to authenticated at all, so the query is refused at the ACL
-- before RLS runs. throws_ok is the accurate assertion; a count(*) = 0 check
-- would never even evaluate.
select throws_ok( $$ select 1 from public.allowlist $$, '42501',
                  'allowlist is refused to authenticated at the ACL' );

reset role;
set local role service_role;
select lives_ok( $$ insert into public.allowlist (email) values ('svc@gmail.com') $$,
                 'service_role can write allowlist (BYPASSRLS does not grant ACL)' );
select lives_ok( $$ update public.members set role = 'member'
                     where user_id = '00000000-0000-0000-0000-0000000000c1' $$,
                 'service_role can update members' );

select * from finish();
rollback;
```

Run: `npx supabase test db`
Expected: 10 assertions pass across both files. **If any `lives_ok` fails with `42501 permission denied for table`, the base grants are missing** — that is the exact failure this step exists to catch, and it is invisible to a suite that only calls definer functions.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations supabase/tests
git commit -m "feat: members schema + idempotent grant_days ledger"
```

---

### Task 4: The allowlist gate

This is the security boundary. Get it wrong and the platform is open.

**Files:**
- Create: `supabase/migrations/20260727120100_02_auth_hooks.sql`
- Modify: `supabase/config.toml`

**Interfaces:**
- Consumes: `public.grant_days` from Task 3, `public.allowlist`, `public.members`.
- Produces: `public.hook_before_user_created(jsonb) returns jsonb`; trigger `on_auth_user_created` on `auth.users`.

- [ ] **Step 1: Write the migration**

Note the Gmail normalisation mirrors `src/lib/email.ts`. **Do not** copy Supabase's own `signup_email_domains` example — it calls `lower($1)` on the `event` jsonb and declares a `domain` variable that collides with the column.

```sql
-- supabase/migrations/20260727120100_02_auth_hooks.sql

create or replace function public.normalize_email(p_raw text)
returns text language plpgsql immutable as $$
declare v text := lower(trim(p_raw)); v_local text; v_domain text;
begin
  if v is null or array_length(string_to_array(v,'@'),1) <> 2 then return null; end if;
  v_local  := split_part(v,'@',1);
  v_domain := split_part(v,'@',2);
  if v_domain in ('gmail.com','googlemail.com') then
    v_local  := replace(split_part(v_local,'+',1), '.', '');
    v_domain := 'gmail.com';
    if v_local = '' then return null; end if;
  end if;
  return v_local || '@' || v_domain;
end $$;

create or replace function public.hook_before_user_created(event jsonb)
returns jsonb language plpgsql as $$
declare
  v_email    text := public.normalize_email(event->'user'->>'email');
  v_provider text := event->'user'->'app_metadata'->>'provider';
begin
  if v_provider is distinct from 'google' then
    return jsonb_build_object('error', jsonb_build_object(
      'http_code', 403, 'message', 'Please sign in with Google.'));
  end if;
  if v_email is null then
    return jsonb_build_object('error', jsonb_build_object(
      'http_code', 403, 'message', 'No usable email on that account.'));
  end if;
  if not exists (select 1 from public.allowlist a
                  where a.email = v_email and a.revoked_at is null) then
    return jsonb_build_object('error', jsonb_build_object(
      'http_code', 403, 'message', 'This email is not on the invite list.'));
  end if;
  return '{}'::jsonb;
end $$;

grant  execute on function public.hook_before_user_created(jsonb) to supabase_auth_admin;
revoke execute on function public.hook_before_user_created(jsonb) from public, anon, authenticated;

-- Provision on first successful signup.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_days int; v_email text := public.normalize_email(new.email);
begin
  select a.initial_grant_days into v_days
    from public.allowlist a
   where a.email = v_email and a.revoked_at is null;
  if v_days is null then
    raise exception 'not allowlisted';   -- belt; the hook already rejected this
  end if;

  insert into public.members(user_id, email, access_expires_at)
  values (new.id, v_email, now())
  on conflict (user_id) do nothing;

  perform public.grant_days(new.id, v_days, 'invite', 'invite');
  return new;
end $$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
```

- [ ] **Step 2: Register the hook in `supabase/config.toml`**

A dashboard-only hook is lost on a project restore. Add:

```toml
[auth.hook.before_user_created]
enabled = true
uri = "pg-functions://postgres/public/hook_before_user_created"
```

- [ ] **Step 3: Write the gate test**

Create `supabase/tests/allowlist_gate.sql`:

```sql
begin;
select plan(5);

insert into public.allowlist (email) values ('yes@gmail.com');

select is(
  public.hook_before_user_created(
    '{"user":{"email":"yes@gmail.com","app_metadata":{"provider":"google"}}}'::jsonb),
  '{}'::jsonb, 'allowlisted google account passes');

select is(
  public.hook_before_user_created(
    '{"user":{"email":"y.e.s+dj@gmail.com","app_metadata":{"provider":"google"}}}'::jsonb),
  '{}'::jsonb, 'gmail dots and plus-tag still match the allowlist');

select is(
  public.hook_before_user_created(
    '{"user":{"email":"no@gmail.com","app_metadata":{"provider":"google"}}}'::jsonb)
    ->'error'->>'http_code', '403', 'non-allowlisted account is rejected');

select is(
  public.hook_before_user_created(
    '{"user":{"email":"yes@gmail.com","app_metadata":{"provider":"github"}}}'::jsonb)
    ->'error'->>'http_code', '403', 'non-google provider is rejected');

update public.allowlist set revoked_at = now() where email = 'yes@gmail.com';
select is(
  public.hook_before_user_created(
    '{"user":{"email":"yes@gmail.com","app_metadata":{"provider":"google"}}}'::jsonb)
    ->'error'->>'http_code', '403', 'revoked account is rejected');

select * from finish();
rollback;
```

- [ ] **Step 4: Run it**

Run: `npx supabase test db`
Expected: 5 pass. The dots/plus case is the one people ship broken.

- [ ] **Step 5: Verify end to end against the hosted project**

This cannot be unit-tested — it needs a real Google OAuth round trip.

1. `npx supabase db push` to the hosted project
2. Confirm Authentication → Hooks shows the before-user-created hook enabled
3. Sign in with a Google account **not** in `allowlist`
4. Expected: 403 with "This email is not on the invite list."
5. **Then run `select count(*) from auth.users;` and confirm it did not increase.** This is the assertion that matters — a rejected signup must leave no row.

- [ ] **Step 6: Commit**

```bash
git add supabase/
git commit -m "feat: allowlist gate — before-user-created hook + provisioning trigger"
```

---

### Task 5: Session plumbing

**Files:**
- Create: `src/lib/supabase.ts`, `src/lib/supabase.server.ts`, `src/lib/session.ts`, `src/lib/session.test.ts`, `src/middleware.ts`, `src/env.d.ts`
- Create: `src/pages/login.astro`, `src/pages/auth/callback.ts`, `src/pages/auth/signout.ts`, `src/pages/index.astro`

**Interfaces:**
- Produces: `type Member = { user_id: string; email: string; role: 'member'|'owner'; access_expires_at: string }`; `creditsRemaining(expiresAt: string, now?: Date): number`; `isActive(m: Member, now?: Date): boolean`; `serverClient(cookies: AstroCookies, request: Request)`; `browserClient()`; `App.Locals.member: Member | null`.

> ⚠️ **The client/callback code blocks below are SUPERSEDED. As shipped, this task uses `@supabase/ssr`.** Two things in the original draft were wrong and are kept here only as a record:
>
> 1. **`Astro.locals.runtime.env` does not exist.** It was removed in Astro v6; the getter now throws unconditionally and the adapter's `Runtime` type no longer declares `env`. Use `import.meta.env` for `PUBLIC_` values.
> 2. **A server-side PKCE exchange cannot work.** The `code_verifier` is generated by the browser client and stored in *localStorage*, so a server client has nothing to exchange and throws `AuthPKCECodeVerifierMissingError` before any network call — meaning **no one could ever sign in**. The fix is `@supabase/ssr`'s `createServerClient`/`createBrowserClient`, which keep the verifier and session in cookies that both sides can read. `flowType: 'implicit'` is not an alternative: tokens then arrive in the URL fragment, which the server never sees.
>
> There is also **no `serviceClient`** — deleted, because Vite's `envPrefix` means `import.meta.env` cannot carry a non-`PUBLIC_` secret into the bundle at all, and because admin authorisation belongs in the database (`is_owner()` inside `security definer` RPCs), not in a Worker route.
>
> Read `src/lib/supabase.server.ts`, `src/lib/supabase.ts` and `src/middleware.ts` for the real implementation.

- [ ] **Step 1: Write the failing test for the derived-credits logic**

Credits are **derived, never stored**. This is the whole point of the timestamp model.

```ts
// src/lib/session.test.ts
import { describe, it, expect } from 'vitest'
import { creditsRemaining, isActive } from './session'

const NOW = new Date('2026-07-27T12:00:00Z')
const m = (iso: string) =>
  ({ user_id: 'u', email: 'a@b.com', role: 'member' as const, access_expires_at: iso })

describe('creditsRemaining', () => {
  it('rounds a partial day up', () => {
    expect(creditsRemaining('2026-07-28T06:00:00Z', NOW)).toBe(1)
  })
  it('counts whole days', () => {
    expect(creditsRemaining('2026-08-26T12:00:00Z', NOW)).toBe(30)
  })
  it('is zero, never negative, once expired', () => {
    expect(creditsRemaining('2026-07-20T12:00:00Z', NOW)).toBe(0)
  })
  it('is zero exactly at expiry', () => {
    expect(creditsRemaining('2026-07-27T12:00:00Z', NOW)).toBe(0)
  })
})

describe('isActive', () => {
  it('is true while expiry is in the future', () => {
    expect(isActive(m('2026-07-27T12:00:01Z'), NOW)).toBe(true)
  })
  it('is false at and after expiry', () => {
    expect(isActive(m('2026-07-27T12:00:00Z'), NOW)).toBe(false)
    expect(isActive(m('2026-07-01T00:00:00Z'), NOW)).toBe(false)
  })
})
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run src/lib/session.test.ts`
Expected: FAIL — cannot resolve `./session`

- [ ] **Step 3: Implement `src/lib/session.ts`**

```ts
// src/lib/session.ts
export type Member = {
  user_id: string
  email: string
  role: 'member' | 'owner'
  access_expires_at: string
}

const DAY_MS = 86_400_000

/** Credits are a display projection of access_expires_at. Never stored. */
export function creditsRemaining(expiresAt: string, now: Date = new Date()): number {
  const ms = new Date(expiresAt).getTime() - now.getTime()
  return ms <= 0 ? 0 : Math.ceil(ms / DAY_MS)
}

export function isActive(m: Member, now: Date = new Date()): boolean {
  return new Date(m.access_expires_at).getTime() > now.getTime()
}
```

- [ ] **Step 4: Run it and confirm it passes**

Run: `npx vitest run src/lib/session.test.ts`
Expected: PASS, 6 tests

- [ ] **Step 5: Write the Supabase clients**

```ts
// src/lib/supabase.ts
import { createClient } from '@supabase/supabase-js'

export function browserClient() {
  return createClient(
    import.meta.env.PUBLIC_SUPABASE_URL,
    import.meta.env.PUBLIC_SUPABASE_ANON_KEY,
    { auth: { flowType: 'pkce', persistSession: true, autoRefreshToken: true } },
  )
}
```

```ts
// src/lib/supabase.server.ts
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

/** Client bound to the caller's access token, so RLS applies as that user. */
export function userClient(env: Record<string, string>, accessToken: string): SupabaseClient {
  return createClient(env.PUBLIC_SUPABASE_URL, env.PUBLIC_SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  })
}

/** BYPASSRLS. Server only. Never construct this in code reachable from the browser. */
export function serviceClient(env: Record<string, string>): SupabaseClient {
  return createClient(env.PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
}
```

- [ ] **Step 6: Write `src/env.d.ts` and the middleware**

```ts
// src/env.d.ts
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
```

```ts
// src/middleware.ts
import { defineMiddleware } from 'astro:middleware'
import { userClient } from './lib/supabase.server'

const PUBLIC_PATHS = new Set(['/login', '/auth/callback', '/auth/signout'])

export const onRequest = defineMiddleware(async (ctx, next) => {
  ctx.locals.member = null
  ctx.locals.accessToken = null

  const token = ctx.cookies.get('sb-access-token')?.value ?? null
  if (token) {
    const env = ctx.locals.runtime?.env ?? import.meta.env
    const sb = userClient(env as Record<string, string>, token)
    // current_member() rather than .from('members') — the owner RLS policy
    // returns EVERY member row for an owner, and .maybeSingle() errors on >1.
    // The function returns exactly one row for any caller.
    const { data } = await sb.rpc('current_member')
    if (data && data.length === 1) {
      ctx.locals.member = data[0]
      ctx.locals.accessToken = token
    }
  }

  const path = new URL(ctx.request.url).pathname
  if (!ctx.locals.member && !PUBLIC_PATHS.has(path)) {
    return ctx.redirect('/login')
  }
  if (path.startsWith('/admin') && ctx.locals.member?.role !== 'owner') {
    return new Response('Not found', { status: 404 })
  }
  return next()
})
```

Note the admin guard returns **404, not 403** — it does not confirm the route exists to a non-owner.

- [ ] **Step 7: Write the login, callback and signout routes**

```astro
---
// src/pages/login.astro
const error = Astro.url.searchParams.get('error_description')
---
<html><body>
  <h1>localchune</h1>
  {error && <p role="alert" style="color:#c00">{error}</p>}
  <button id="in">Sign in with Google</button>
  <script>
    import { browserClient } from '../lib/supabase'
    document.getElementById('in')!.addEventListener('click', () => {
      browserClient().auth.signInWithOAuth({
        provider: 'google',
        options: { redirectTo: `${location.origin}/auth/callback` },
      })
    })
  </script>
</body></html>
```

```ts
// src/pages/auth/callback.ts
import type { APIRoute } from 'astro'
import { createClient } from '@supabase/supabase-js'

export const GET: APIRoute = async ({ url, cookies, redirect, locals }) => {
  const err = url.searchParams.get('error_description')
  if (err) return redirect(`/login?error_description=${encodeURIComponent(err)}`)

  const code = url.searchParams.get('code')
  if (!code) return redirect('/login')

  const env = (locals.runtime?.env ?? import.meta.env) as Record<string, string>
  const sb = createClient(env.PUBLIC_SUPABASE_URL, env.PUBLIC_SUPABASE_ANON_KEY, {
    auth: { flowType: 'pkce', persistSession: false },
  })
  const { data, error } = await sb.auth.exchangeCodeForSession(code)
  if (error || !data.session) {
    return redirect(`/login?error_description=${encodeURIComponent(error?.message ?? 'sign-in failed')}`)
  }
  cookies.set('sb-access-token', data.session.access_token, {
    path: '/', httpOnly: true, secure: true, sameSite: 'lax',
    maxAge: data.session.expires_in,
  })
  cookies.set('sb-refresh-token', data.session.refresh_token, {
    path: '/', httpOnly: true, secure: true, sameSite: 'lax', maxAge: 60 * 60 * 24 * 30,
  })
  return redirect('/')
}
```

```ts
// src/pages/auth/signout.ts
import type { APIRoute } from 'astro'
export const POST: APIRoute = async ({ cookies, redirect }) => {
  cookies.delete('sb-access-token', { path: '/' })
  cookies.delete('sb-refresh-token', { path: '/' })
  return redirect('/login')
}
```

- [ ] **Step 8: Write the placeholder pool page**

```astro
---
// src/pages/index.astro
import { creditsRemaining } from '../lib/session'
const m = Astro.locals.member!
---
<html><body>
  <h1>localchune</h1>
  <p>{m.email} — {creditsRemaining(m.access_expires_at)} credits</p>
  {m.role === 'owner' && <a href="/admin">Admin</a>}
  <form method="post" action="/auth/signout"><button>Sign out</button></form>
</body></html>
```

- [ ] **Step 9: Verify manually**

Run: `npm run dev`, open `http://localhost:4321`
Expected: redirected to `/login`. Sign in with an allowlisted account → the pool page shows your email and 30 credits. Sign in with a non-allowlisted account → back at `/login` with "This email is not on the invite list."

- [ ] **Step 10: Commit**

```bash
git add src/
git commit -m "feat: google oauth session, middleware guard, derived credits"
```

---

### Task 6: Admin page

**Files:**
- Create: `src/pages/admin/index.astro`, `src/pages/api/admin/allowlist.ts`, `src/components/AllowlistForm.tsx`
- Create: `supabase/migrations/20260727120200_03_admin_rpc.sql`

**Interfaces:**
- Consumes: `normalizeEmail` (Task 2), `serverClient(cookies, request)` (Task 5), `Member` (Task 5).
- Produces: `POST /api/admin/allowlist {email, note?}` → `201 {email}`; `DELETE /api/admin/allowlist {email}` → `200 {revoked: true}`.

- [ ] **Step 1: Write the admin overview RPC**

A single owner-only view rather than N queries from the page.

```sql
-- supabase/migrations/20260727120200_03_admin_rpc.sql
create or replace function public.admin_members()
returns table (
  email             text,
  role              text,
  access_expires_at timestamptz,
  credits           int,
  invited_at        timestamptz,
  revoked_at        timestamptz,
  signed_up         boolean
)
language sql security definer set search_path = '' as $$
  select a.email,
         coalesce(m.role, 'member'),
         m.access_expires_at,
         greatest(0, ceil(extract(epoch from (m.access_expires_at - now())) / 86400.0))::int,
         a.invited_at,
         a.revoked_at,
         m.user_id is not null
    from public.allowlist a
    left join public.members m on m.email = a.email
   where public.is_owner()
   order by a.invited_at desc;
$$;

revoke execute on function public.admin_members() from public, anon;
grant  execute on function public.admin_members() to authenticated;

-- Mutations as definer functions, per the global constraint. The owner check
-- lives HERE, in the database, not only in the Worker route — so a routing
-- mistake cannot expose it.
create or replace function public.admin_invite(p_email text, p_note text default null)
returns text language plpgsql security definer set search_path = '' as $$
declare v_email text := public.normalize_email(p_email);
begin
  if not public.is_owner() then raise exception 'forbidden' using errcode = '42501'; end if;
  if v_email is null then raise exception 'invalid email' using errcode = '22023'; end if;
  insert into public.allowlist (email, note)
  values (v_email, p_note)
  on conflict (email) do update set revoked_at = null, note = coalesce(excluded.note, allowlist.note);
  return v_email;
end $$;

create or replace function public.admin_revoke(p_email text)
returns text language plpgsql security definer set search_path = '' as $$
declare v_email text := public.normalize_email(p_email);
begin
  if not public.is_owner() then raise exception 'forbidden' using errcode = '42501'; end if;
  update public.allowlist set revoked_at = now() where email = v_email;
  return v_email;
end $$;

revoke execute on function public.admin_invite(text,text), public.admin_revoke(text) from public, anon;
grant  execute on function public.admin_invite(text,text), public.admin_revoke(text) to authenticated;
```

The `public.is_owner()` guard inside each function body is what makes `security definer` safe — a non-owner calling `admin_members()` gets zero rows, and a non-owner calling `admin_invite` gets a `42501`.

- [ ] **Step 2: Write the API route**

```ts
// src/pages/api/admin/allowlist.ts
import type { APIRoute } from 'astro'
import { normalizeEmail } from '../../../lib/email'
import { serverClient } from '../../../lib/supabase.server'

/** 404, not 403 — do not confirm the route exists to a non-owner. */
const guard = (locals: App.Locals) => locals.member?.role === 'owner'

async function readEmail(request: Request): Promise<string | null> {
  const body = (await request.json().catch(() => ({}))) as { email?: string }
  try {
    return normalizeEmail(body.email ?? '')
  } catch {
    return null
  }
}

export const POST: APIRoute = async ({ request, locals, cookies }) => {
  if (!guard(locals)) return new Response('Not found', { status: 404 })
  const email = await readEmail(request)
  if (!email) return Response.json({ error: 'invalid email' }, { status: 400 })
  // The caller's own cookie session, NOT a service key: admin_invite re-checks
  // is_owner() in the database, so authorisation is enforced in one place.
  const sb = serverClient(cookies, request)
  const { data, error } = await sb.rpc('admin_invite', { p_email: email })
  if (error) return Response.json({ error: error.message }, { status: 500 })
  return Response.json({ email: data }, { status: 201 })
}

export const DELETE: APIRoute = async ({ request, locals, cookies }) => {
  if (!guard(locals)) return new Response('Not found', { status: 404 })
  const email = await readEmail(request)
  if (!email) return Response.json({ error: 'invalid email' }, { status: 400 })
  const sb = serverClient(cookies, request)
  const { error } = await sb.rpc('admin_revoke', { p_email: email })
  if (error) return Response.json({ error: error.message }, { status: 500 })
  return Response.json({ revoked: true })
}
```

> **API note.** `serverClient(cookies, request)` comes from `@supabase/ssr` and reads the session from cookies. There is **no `serviceClient`** — it was deleted in Task 5 because `import.meta.env` cannot deliver a non-`PUBLIC_` secret to the bundle, and because admin authorisation belongs in the database, not in a Worker route. Do not reintroduce it. `Astro.locals.runtime.env` also does not exist — it was removed in Astro v6.

Revoking sets `revoked_at`; it does not delete. The member keeps their data and their uploads keep their attribution (PRD §11).

Note there is **no `serviceClient` use here**. The service key bypasses RLS entirely, so using it for admin writes would put the only authorisation check in the Worker route — one routing mistake from an open door. Routing through `admin_invite` / `admin_revoke` keeps the check in the database where it cannot be bypassed.

- [ ] **Step 3: Write the Solid island**

```tsx
// src/components/AllowlistForm.tsx
import { createSignal } from 'solid-js'

export default function AllowlistForm() {
  const [email, setEmail] = createSignal('')
  const [status, setStatus] = createSignal('')

  const submit = async (e: Event) => {
    e.preventDefault()
    setStatus('adding…')
    const res = await fetch('/api/admin/allowlist', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: email() }),
    })
    if (res.ok) {
      const j = (await res.json()) as { email: string }
      setStatus(`invited ${j.email}`)
      setEmail('')
      location.reload()
    } else {
      const j = (await res.json().catch(() => ({}))) as { error?: string }
      setStatus(j.error ?? `failed (${res.status})`)
    }
  }

  return (
    <form onSubmit={submit}>
      <input type="email" required placeholder="dj@gmail.com"
             value={email()} onInput={(e) => setEmail(e.currentTarget.value)} />
      <button type="submit">Invite</button>
      <span aria-live="polite">{status()}</span>
    </form>
  )
}
```

- [ ] **Step 4: Write the admin page**

```astro
---
// src/pages/admin/index.astro
import AllowlistForm from '../../components/AllowlistForm'
import { serverClient } from '../../lib/supabase.server'

const sb = serverClient(Astro.cookies, Astro.request)
const { data: rows, error } = await sb.rpc('admin_members')
if (error) console.error('admin_members failed:', error.message)
---
<html><body>
  <h1>Members</h1>
  <AllowlistForm client:load />
  <table>
    <thead><tr><th>Email</th><th>Role</th><th>Credits</th><th>Signed up</th><th>Status</th></tr></thead>
    <tbody>
      {(rows ?? []).map((r: any) => (
        <tr>
          <td>{r.email}</td><td>{r.role}</td>
          <td>{r.signed_up ? r.credits : '—'}</td>
          <td>{r.signed_up ? 'yes' : 'pending'}</td>
          <td>{r.revoked_at ? 'revoked' : 'active'}</td>
        </tr>
      ))}
    </tbody>
  </table>
  <p><a href="/">← pool</a></p>
</body></html>
---
```

- [ ] **Step 5: Write the authorisation and recursion tests**

These two failure modes — RLS recursion and a non-owner reaching admin functions — are the ones that would ship silently.

Create `supabase/tests/admin_authz.sql`:

```sql
begin;
select plan(6);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000aa','owner@gmail.com'),
  ('00000000-0000-0000-0000-0000000000bb','member@gmail.com');
insert into public.allowlist (email) values ('owner@gmail.com'), ('member@gmail.com');
insert into public.members (user_id, email, role) values
  ('00000000-0000-0000-0000-0000000000aa','owner@gmail.com','owner'),
  ('00000000-0000-0000-0000-0000000000bb','member@gmail.com','member');

-- As the OWNER
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000aa"}';

select ok( public.is_owner(), 'owner is recognised' );

-- The regression test for 42P17: with two members present, an owner selecting
-- from members must return both rows and MUST NOT recurse.
select is( (select count(*)::int from public.members), 2,
           'owner reads all members without infinite recursion' );

select is( (select count(*)::int from public.current_member()), 1,
           'current_member returns exactly one row even for an owner' );

select is( public.admin_invite('New.Person+tag@gmail.com'), 'newperson@gmail.com',
           'admin_invite normalises and returns the email' );

-- As a plain MEMBER
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000bb"}';

select ok( not public.is_owner(), 'plain member is not an owner' );

select throws_ok( $$ select public.admin_invite('sneaky@gmail.com') $$, '42501',
                  'a non-owner calling admin_invite is refused in the database' );

select * from finish();
rollback;
```

- [ ] **Step 6: Run it**

Run: `npx supabase test db`
Expected: 6 pass. **If the second assertion fails with `42P17 infinite recursion detected in policy for relation "members"`, the `is_owner()` definer function is missing or the policy is still self-referential.**

- [ ] **Step 7: Verify manually**

1. `npm run dev`, sign in as the owner, open `/admin`
2. Invite a second Google address you control → row appears as `pending`
3. Sign in as that address in a private window → it works, row flips to `signed_up` with 30 credits
4. Sign in as the owner, revoke it
5. Sign out and back in as the revoked address → rejected
6. **Sign in as a non-owner member and request `/admin` → 404, not 403**

- [ ] **Step 8: Commit**

```bash
git add src/pages/admin src/pages/api src/components supabase/migrations supabase/tests
git commit -m "feat: owner-only admin page — invite and revoke"
```

---

### Task 7: Owner bootstrap and deploy

**Files:**
- Create: `supabase/migrations/20260727120300_04_seed_owner.sql`
- Modify: `package.json` (deploy script)

**Interfaces:**
- Consumes: everything above.

- [ ] **Step 1: Write the seed migration**

Chicken-and-egg: the first owner cannot be invited through the UI.

```sql
-- supabase/migrations/20260727120300_04_seed_owner.sql
insert into public.allowlist (email, note, initial_grant_days)
values (public.normalize_email('rohan.maliko99@gmail.com'), 'owner', 3650)
on conflict (email) do nothing;

-- Promote to owner on (or after) first sign-in.
create or replace function public.promote_owner() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.email = public.normalize_email('rohan.maliko99@gmail.com') then
    update public.members set role = 'owner' where user_id = new.user_id;
  end if;
  return new;
end $$;

create trigger members_promote_owner
  after insert on public.members
  for each row execute function public.promote_owner();
```

- [ ] **Step 2: Add the deploy script to `package.json`**

```json
"scripts": {
  "dev": "astro dev",
  "build": "astro build",
  "check": "astro check",
  "test": "vitest run",
  "deploy": "astro build && wrangler deploy"
}
```

- [ ] **Step 3: Set production secrets**

```bash
npx wrangler secret put SUPABASE_SERVICE_KEY
npx wrangler secret put PUBLIC_SUPABASE_ANON_KEY
npx wrangler secret put PUBLIC_SUPABASE_URL
```

- [ ] **Step 4: Push migrations and deploy**

```bash
npx supabase db push
npm run deploy
```

- [ ] **Step 5: Verify in production**

Confirm each, in order:
1. Visiting the deployed URL redirects to `/login`
2. Signing in as the owner works and shows `/admin`
3. Signing in with a random Google account is rejected with the invite-list message
4. `select count(*) from auth.users;` did **not** increase from step 3
5. Supabase dashboard → Authentication → Hooks shows before-user-created enabled

- [ ] **Step 6: Run the full test suite**

Run: `npm test && npx supabase test db && npm run check`
Expected: all green, no type errors

- [ ] **Step 7: Commit and open the PR**

```bash
git add -A
git commit -m "feat: owner bootstrap + deploy"
git push -u origin rohan/m1-foundations
gh pr create --title "M1: foundations — allowlist auth, schema, admin" --fill
gh pr list --state open
```

---

## Done when

- A non-allowlisted Google account cannot create an `auth.users` row. Verified by row count, not by the error message.
- The owner can invite and revoke from `/admin`.
- A member sees their derived credit count.
- `grant_days` is proven idempotent by test.
- Non-owners get 404 on `/admin`.
