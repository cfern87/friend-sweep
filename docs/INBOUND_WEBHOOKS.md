# Incoming webhooks (Pro, beta)

Start a scan from outside the extension — Zapier, Make, a cron job, an iOS
Shortcut. Same system as Not Another Social CRM's incoming webhooks.

## How it works

1. In the dashboard, open **Incoming webhooks**, switch on **This browser
   answers webhooks**, and create a token.
2. Send a request to your inbox address with the token.
3. The browser checks the inbox once a minute (while Chrome is open), runs the
   request when no other job is going, and logs it in the **Activity log**.
4. Read the outcome back with the request's id.

Only scans can be started. Removals never run remotely. Switch webhooks on in
one browser only, unless you want any of them to pick requests up.

## Commands

| command | payload | does |
|---|---|---|
| `ping` | – | answers straight away with the browser id and extension version |
| `scan.friends` | – | Scan friends: list, order and friend dates |
| `scan.engagement` | `{"days": 30}` (optional, clamped to your plan) | Scan engagement |
| `scan.all` | `{"days": 30}` (optional) | Scan friends, then engagement |

Each command must also be ticked under **Requests it will run**.

## Example

```sh
curl -X POST https://notanotherfriendsweeper.com/api/public/sweeper-inbox \
  -H "Authorization: Bearer nafs_in_…" \
  -H "Content-Type: application/json" \
  -d '{"command":"scan.engagement","payload":{"days":30},"idempotencyKey":"weekly-2026-48"}'
# → 202 {"id":"…","status":"pending"}

curl "https://notanotherfriendsweeper.com/api/public/sweeper-inbox?id=…" \
  -H "Authorization: Bearer nafs_in_…"
# → status pending → claimed (running) → done | failed | expired
```

A request nobody picks up within `expiresInMinutes` (default 24 h) becomes
`expired`. While a scan is running the command stays `claimed`; the result
lists each scan step with its summary.

Server side: [INBOUND_WEBHOOKS_LOVABLE.md](INBOUND_WEBHOOKS_LOVABLE.md).
