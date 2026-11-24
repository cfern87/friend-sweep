# Incoming webhooks — instructions for Lovable (notanotherfriendsweeper.com)

This is the same design Lovable already built for Not Another Social CRM
(`/api/public/crm-inbox` + `inbound_tokens` / `inbound_commands`), applied to
the Friend Sweeper's own Supabase project. If the CRM's implementation can be
copied across, do that — only the names in **bold** below differ:

| | CRM | Friend Sweeper |
|---|---|---|
| Website route | `/api/public/crm-inbox` | **`/api/public/sweeper-inbox`** |
| Token prefix | `crm_in_` | **`nafs_in_`** (56 characters in total) |
| Supabase project | the CRM's | the Friend Sweeper's (the one the extension signs into) |

The extension (`inbound.js`) is already built against exactly these names, so
any rename breaks it. Nothing existing is changed; §6 removes everything again.

Paste everything below the line into Lovable. It is self-contained.

---

## Prompt for Lovable

We are adding **incoming webhooks** to Not Another Friend Sweeper. Outside
systems (Zapier, scripts) POST a command to a public website route. The route
stores it in a table. The user's Chrome extension (signed in as that user via
Supabase Auth) polls the table once a minute, runs the command, and writes the
result back. The caller can then GET the result.

Please implement **exactly** the names, columns and signatures below. Do not
change any existing tables, functions or auth settings.

### 1. Migration: tables

```sql
create extension if not exists pgcrypto with schema extensions;

create table public.inbound_tokens (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null,
  token_hash    text not null unique,          -- sha256 hex of the full token
  token_prefix  text not null,                 -- first 12 chars, for display
  label         text,
  created_at    timestamptz not null default now(),
  last_used_at  timestamptz,
  revoked_at    timestamptz
);
create index inbound_tokens_user_idx on public.inbound_tokens (user_id);

create table public.inbound_commands (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null,
  token_id         uuid references public.inbound_tokens(id) on delete set null,
  command          text not null,
  payload          jsonb not null default '{}'::jsonb,
  idempotency_key  text,
  status           text not null default 'pending'
                   check (status in ('pending','claimed','done','failed','expired')),
  result           jsonb,
  error            text,
  claimed_by       text,
  claimed_at       timestamptz,
  finished_at      timestamptz,
  created_at       timestamptz not null default now(),
  expires_at       timestamptz not null default now() + interval '24 hours'
);
create index inbound_commands_pending_idx on public.inbound_commands (user_id, status, created_at);
create unique index inbound_commands_idem_idx
  on public.inbound_commands (user_id, idempotency_key) where idempotency_key is not null;

alter table public.inbound_tokens   enable row level security;
alter table public.inbound_commands enable row level security;

create policy "own tokens readable"   on public.inbound_tokens   for select to authenticated using (user_id = auth.uid());
create policy "own commands readable" on public.inbound_commands for select to authenticated using (user_id = auth.uid());

revoke all on public.inbound_tokens   from anon, authenticated;
revoke all on public.inbound_commands from anon, authenticated;
grant select (id, user_id, token_prefix, label, created_at, last_used_at, revoked_at)
  on public.inbound_tokens to authenticated;
grant select on public.inbound_commands to authenticated;
```

### 2. Migration: database functions (called by the extension as the signed-in user)

```sql
create or replace function public.create_inbound_token(p_label text)
returns table (id uuid, token text, token_prefix text)
language plpgsql security definer set search_path = public, extensions
as $$
declare
  v_uid uuid := auth.uid();
  v_token text;
  v_id uuid;
begin
  if v_uid is null then raise exception 'not signed in'; end if;
  if (select count(*) from inbound_tokens t where t.user_id = v_uid and t.revoked_at is null) >= 5 then
    raise exception 'You already have 5 active tokens. Revoke one first.';
  end if;
  v_token := 'nafs_in_' || encode(gen_random_bytes(24), 'hex');
  insert into inbound_tokens (user_id, token_hash, token_prefix, label)
  values (v_uid, encode(digest(v_token, 'sha256'), 'hex'), left(v_token, 12), nullif(left(coalesce(p_label, ''), 60), ''))
  returning inbound_tokens.id into v_id;
  return query select v_id, v_token, left(v_token, 12);
end $$;

create or replace function public.revoke_inbound_token(p_id uuid)
returns void
language sql security definer set search_path = public
as $$
  update inbound_tokens set revoked_at = now()
  where id = p_id and user_id = auth.uid() and revoked_at is null;
$$;

create or replace function public.claim_inbound_commands(p_device text, p_limit int default 5)
returns setof public.inbound_commands
language plpgsql security definer set search_path = public
as $$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null then raise exception 'not signed in'; end if;

  update inbound_commands set status = 'expired', finished_at = now()
  where user_id = v_uid and status = 'pending' and expires_at < now();

  return query
  update inbound_commands c
     set status = 'claimed', claimed_by = left(p_device, 100), claimed_at = now()
   where c.id in (
     select id from inbound_commands
      where user_id = v_uid and status = 'pending'
      order by created_at
      limit greatest(1, least(coalesce(p_limit, 5), 20))
      for update skip locked
   )
  returning c.*;
end $$;

create or replace function public.complete_inbound_command(p_id uuid, p_status text, p_result jsonb, p_error text)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  if p_status not in ('done', 'failed') then raise exception 'bad status'; end if;
  update inbound_commands
     set status = p_status, result = p_result, error = left(p_error, 1000), finished_at = now()
   where id = p_id and user_id = auth.uid() and status = 'claimed';
end $$;

revoke all on function public.create_inbound_token(text)               from public, anon;
revoke all on function public.revoke_inbound_token(uuid)               from public, anon;
revoke all on function public.claim_inbound_commands(text, int)        from public, anon;
revoke all on function public.complete_inbound_command(uuid, text, jsonb, text) from public, anon;
grant execute on function public.create_inbound_token(text)               to authenticated;
grant execute on function public.revoke_inbound_token(uuid)               to authenticated;
grant execute on function public.claim_inbound_commands(text, int)        to authenticated;
grant execute on function public.complete_inbound_command(uuid, text, jsonb, text) to authenticated;
```

Note: a scan can take several minutes, so a command can stay `claimed` for a
while before `complete_inbound_command` is called. That is expected.

### 3. Website route `/api/public/sweeper-inbox`

A public server route on the website (same place as `/api/public/entitlement`).
Callers authenticate with our own token, not a Supabase JWT. It uses the
service role key to read/write the tables above.

**Authentication (every request):**
- Token from `Authorization: Bearer <token>`, or header `X-Sweeper-Inbound-Token`.
- SHA-256 of the UTF-8 token, lowercase hex (must equal
  `encode(digest(token,'sha256'),'hex')` in Postgres).
- Look up `inbound_tokens` by `token_hash` with `revoked_at is null`.
  Not found → **401** `{"error":"invalid token"}`.
- On success set `last_used_at = now()` on that token.

**CORS:** `OPTIONS` → 204 with `Access-Control-Allow-Origin: *`,
`Access-Control-Allow-Headers: authorization, content-type, x-sweeper-inbound-token`,
`Access-Control-Allow-Methods: GET, POST, OPTIONS`. Include
`Access-Control-Allow-Origin: *` on every response. All responses are JSON.

**`POST`** — queue a command. Body max 16 KB (→ **413**).

```json
{
  "command": "scan.engagement",
  "payload": { "days": 30 },
  "idempotencyKey": "optional-string-max-100",
  "expiresInMinutes": 60
}
```

Validation (→ **400** `{"error":"<message>"}`):
- body is a JSON object
- `command` matches `^[a-z][a-z0-9_.]{1,63}$` (do NOT hardcode a list — the extension validates)
- `payload`, if present, is a JSON object (default `{}`)
- `idempotencyKey`, if present, string ≤ 100 chars
- `expiresInMinutes`, if present, integer 1–1440 (default 1440)

If the user already has **20 or more** `pending` rows → **429**
`{"error":"too many pending commands"}` (scans are slow; a deep queue is a mistake).

Insert into `inbound_commands`. Idempotency conflict → return the existing row,
**200**, `"duplicate": true`. Otherwise **202**:

```json
{ "id": "<uuid>", "status": "pending", "createdAt": "...", "expiresAt": "...", "duplicate": false }
```

**`GET ?id=<uuid>`** — only the token's user's rows; else **404**. Bad uuid → 400.

```json
{
  "id": "...", "command": "scan.engagement", "status": "done",
  "result": { "command": "scan.engagement", "steps": [ { "scan": "engagementScan", "status": "done", "summary": "..." } ] },
  "error": null,
  "createdAt": "...", "claimedAt": "...", "finishedAt": "...", "expiresAt": "..."
}
```

Any other method → **405**.

### 4. Website account page

On `/account`, add a short "Incoming webhooks" card that says webhooks are
managed from the extension's dashboard (Incoming webhooks panel) and lists the
user's tokens (label, prefix, last used, revoked) read-only. Optional.

### 5. Acceptance checks

1. `select * from create_inbound_token('test')` returns a token starting `nafs_in_`, 56 chars; the table holds only the hash.
2. POST `{"command":"ping"}` with no token → 401; with `Authorization: Bearer <token>` → 202 + id.
3. GET `?id=<id>` → 200, `"status":"pending"`.
4. `claim_inbound_commands('test-device', 1)` returns the row as `claimed`; again → nothing.
5. `complete_inbound_command('<id>','done','{"pong":true}',null)` → GET shows `done` + result.
6. Same `idempotencyKey` twice → same id, `"duplicate": true`.
7. `revoke_inbound_token('<token id>')` → 401 from then on.
8. A second user can't see or claim the first user's rows.

Reply with the route URL.

---

## 6. Rollback

```sql
drop function if exists public.complete_inbound_command(uuid, text, jsonb, text);
drop function if exists public.claim_inbound_commands(text, int);
drop function if exists public.revoke_inbound_token(uuid);
drop function if exists public.create_inbound_token(text);
drop table if exists public.inbound_commands;
drop table if exists public.inbound_tokens;
```

…and remove the `/api/public/sweeper-inbox` route. The extension then shows
"the server side of incoming webhooks is not set up yet" and does nothing else.
