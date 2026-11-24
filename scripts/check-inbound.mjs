#!/usr/bin/env node
// End-to-end check of incoming webhooks against the live site, using a real
// token made in the extension (Dashboard -> Automations -> Incoming webhooks).
//
//   $env:SWEEPER_TOKEN = "nafs_in_..."; node scripts/check-inbound.mjs
//
// Before running: be signed in, turn incoming webhooks on in the dashboard,
// allow "Ping", and keep Chrome open so the extension polls (once a minute).
// Only a ping is sent — nothing is scanned or removed.

const BASE = process.env.SWEEPER_INBOX || "https://notanotherfriendsweeper.com/api/public/sweeper-inbox";
const TOKEN = process.env.SWEEPER_TOKEN;
if (!TOKEN || !TOKEN.startsWith("nafs_in_")) {
  console.error("Set SWEEPER_TOKEN to a token from the dashboard (starts with nafs_in_).");
  process.exit(2);
}

let fails = 0;
const ok = (cond, name, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail ? " — " + detail : ""}`);
  if (!cond) fails++;
};
async function call(method, { query = "", body, headers = {} } = {}) {
  const res = await fetch(BASE + query, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch {}
  return { status: res.status, json };
}
const show = (r) => `${r.status} ${JSON.stringify(r.json).slice(0, 160)}`;

// Validation (server side, nothing queued)
let r = await call("POST", { body: "[1,2]" });
ok(r.status === 400, "non-object body -> 400", show(r));
r = await call("POST", { body: { command: "Bad Command!" } });
ok(r.status === 400, "malformed command -> 400", show(r));
r = await call("POST", { body: { command: "ping", payload: [1] } });
ok(r.status === 400, "array payload -> 400", show(r));
r = await call("POST", { body: { command: "ping", expiresInMinutes: 5000 } });
ok(r.status === 400, "expiresInMinutes out of range -> 400", show(r));
r = await call("POST", { body: { command: "ping", payload: { pad: "x".repeat(17 * 1024) } } });
ok(r.status === 413, "body over 16 KB -> 413", show(r));
r = await call("GET", { query: "?id=not-a-uuid" });
ok(r.status === 400, "GET bad uuid -> 400", show(r));
r = await call("GET", { query: "?id=00000000-0000-0000-0000-000000000000" });
ok(r.status === 404, "GET unknown id -> 404", show(r));

// Queue a ping, with an idempotency key
const key = "check-" + Date.now();
r = await call("POST", { body: { command: "ping", idempotencyKey: key, expiresInMinutes: 10 } });
ok(r.status === 202 && r.json?.id && r.json.status === "pending" && r.json.duplicate === false, "POST ping -> 202 pending", show(r));
const id = r.json?.id;
r = await call("POST", { body: { command: "ping", idempotencyKey: key, expiresInMinutes: 10 } });
ok(r.status === 200 && r.json?.id === id && r.json.duplicate === true, "same idempotencyKey -> same id, duplicate", show(r));

if (id) {
  r = await call("GET", { query: `?id=${id}` });
  ok(r.status === 200 && ["pending", "claimed", "done"].includes(r.json?.status), "GET -> 200", show(r));

  // Wait for the extension to pick it up (polls every minute)
  console.log("…waiting up to 3 minutes for the extension to answer");
  const until = Date.now() + 180_000;
  while (Date.now() < until && !["done", "failed", "expired"].includes(r.json?.status)) {
    await new Promise((s) => setTimeout(s, 10_000));
    r = await call("GET", { query: `?id=${id}` });
    process.stdout.write(`  ${r.json?.status}\n`);
  }
  ok(r.json?.status === "done" && r.json?.result?.pong === true, "extension claimed and answered the ping", show(r));
  if (r.json?.result?.version) console.log(`  answered by extension v${r.json.result.version}`);
}

console.log(fails ? `\n${fails} check(s) failed` : "\nAll checks passed");
process.exit(fails ? 1 : 0);
