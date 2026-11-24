// Not Another Friend Sweeper — incoming webhooks (background worker).
//
// Same design as Not Another Social CRM's incoming webhooks (inbound.ts /
// inboundClient.ts there), so one mental model covers both products:
//
//   An extension can't listen for HTTP, so a request never reaches it
//   directly. An outside system (Zapier, a script, a phone shortcut) POSTs a
//   command to the website (`/api/public/sweeper-inbox`), which stores it as a
//   row in `inbound_commands`. A browser that has webhooks switched on polls
//   that table every minute, claims the next pending row, runs it, and writes
//   the result back. The caller gets 202 + an id straight away and can GET the
//   result later. Server side: docs/INBOUND_WEBHOOKS_LOVABLE.md.
//
// Guard rails, because anything that can be triggered from the internet will
// eventually be triggered by mistake:
//   * OFF by default, per browser. While off, nothing here touches the network.
//   * Only read-only SCANS can be triggered. Removals are never remote — the
//     same rule the schedule follows.
//   * Each command must be ticked in this browser's settings.
//   * One command at a time: nothing is claimed while a job is running, so a
//     queued request waits its turn instead of fighting a scan for the tab.
//   * Scheduled scans and webhooks are the Pro "automation" features.
//
// The background worker supplies the job runner through init(); this module
// owns parsing, the server calls, and the per-browser settings.

const FriendInbound = (() => {
  const ENDPOINT_PATH = "/api/public/sweeper-inbox";
  const SETTINGS_KEY = "inboundSettings"; // chrome.storage.local, never synced
  const STATUS_KEY = "inboundStatus";
  const TOKEN_LABELS_KEY = "inboundTokenLabels";

  const SETUP_PENDING =
    "The server side of incoming webhooks is not set up yet (the inbox tables/functions are missing).";

  /** Every command a request may name, with what the settings screen calls it. */
  const COMMANDS = {
    ping: "Ping (check the connection)",
    "scan.friends": "Scan friends (list, order and friend dates)",
    "scan.engagement": "Scan engagement",
    "scan.all": "Scan friends, then engagement",
  };
  const DEFAULT_ALLOWED = Object.keys(COMMANDS);
  const MAX_DAYS = 365;

  let hooks = {};

  function init(h) {
    hooks = h || {};
  }

  // ------------------------------------------------------------ settings

  async function getSettings() {
    const { [SETTINGS_KEY]: raw } = await chrome.storage.local.get(SETTINGS_KEY);
    const o = raw && typeof raw === "object" ? raw : {};
    return {
      enabled: o.enabled === true,
      allowed: Array.isArray(o.allowed)
        ? o.allowed.filter((c) => c in COMMANDS)
        : DEFAULT_ALLOWED.slice(),
    };
  }

  async function setSettings(patch) {
    const next = { ...(await getSettings()), ...(patch || {}) };
    next.enabled = !!next.enabled;
    next.allowed = Array.from(new Set((next.allowed || []).filter((c) => c in COMMANDS)));
    await chrome.storage.local.set({ [SETTINGS_KEY]: next });
    return next;
  }

  async function saveStatus(s) {
    try {
      await chrome.storage.local.set({ [STATUS_KEY]: s });
    } catch (e) {
      /* cosmetic */
    }
    return s;
  }

  async function getStatus() {
    const { [STATUS_KEY]: s } = await chrome.storage.local.get(STATUS_KEY);
    return s || null;
  }

  async function endpointUrl() {
    const base = await NAFS.apiBase();
    return base.replace(/\/+$/, "") + ENDPOINT_PATH;
  }

  // ------------------------------------------------------------ server

  // Never throws: failures come back as { ok: false, error }, so a missing
  // server piece shows up as readable status rather than a crash.
  async function call(method, path, body) {
    const token = await NAFS.accessToken();
    if (!token) return { ok: false, error: "Not signed in." };
    let res;
    try {
      res = await fetch(NAFS.AUTH_URL + path, {
        method,
        headers: {
          apikey: NAFS.AUTH_KEY,
          Authorization: "Bearer " + token,
          "Content-Type": "application/json",
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch (e) {
      return { ok: false, error: String(e) };
    }
    const text = await res.text().catch(() => "");
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch (e) {
      /* not JSON */
    }
    if (!res.ok) {
      const j = json || {};
      // PGRST202 = function not found, 42P01 / PGRST205 = table not found.
      if (j.code === "PGRST202" || j.code === "42P01" || j.code === "PGRST205" || (res.status === 404 && !j.message)) {
        return { ok: false, error: SETUP_PENDING, status: res.status };
      }
      return { ok: false, error: j.message || j.error || "Server replied " + res.status + ".", status: res.status };
    }
    return { ok: true, data: json };
  }

  const rpc = (name, args) => call("POST", "/rest/v1/rpc/" + name, args);

  async function claim(deviceId) {
    // One at a time: a claimed command owns the Facebook tab until it ends.
    const r = await rpc("claim_inbound_commands", { p_device: deviceId, p_limit: 1 });
    if (!r.ok) return r;
    return { ok: true, rows: Array.isArray(r.data) ? r.data : [] };
  }

  async function complete(id, outcome) {
    const r = await rpc("complete_inbound_command", {
      p_id: id,
      p_status: outcome.status,
      p_result: outcome.result || null,
      p_error: outcome.error || null,
    });
    if (!r.ok) console.warn("[NAFS] inbound: could not report result for", id, r.error);
    return r;
  }

  async function createToken(label) {
    const r = await rpc("create_inbound_token", { p_label: String(label || "").slice(0, 60) });
    if (!r.ok) return r;
    const row = Array.isArray(r.data) ? r.data[0] : r.data;
    if (!row || typeof row.token !== "string") return { ok: false, error: "The server did not return a token." };
    return { ok: true, token: row };
  }

  async function revokeToken(id) {
    const r = await rpc("revoke_inbound_token", { p_id: id });
    return r.ok ? { ok: true } : r;
  }

  async function listTokens() {
    const r = await call(
      "GET",
      "/rest/v1/inbound_tokens?select=id,token_prefix,label,created_at,last_used_at,revoked_at&order=created_at.desc"
    );
    if (!r.ok) return r;
    const tokens = Array.isArray(r.data) ? r.data : [];
    // Remember labels so the activity log can say which token triggered a run.
    const labels = {};
    for (const t of tokens) if (t.label) labels[t.id] = t.label;
    await chrome.storage.local.set({ [TOKEN_LABELS_KEY]: labels });
    return { ok: true, tokens };
  }

  async function listRecent(limit) {
    const n = Math.max(1, Math.min(50, Math.floor(limit) || 20));
    const r = await call(
      "GET",
      "/rest/v1/inbound_commands?select=id,command,status,error,result,created_at,claimed_at,finished_at,expires_at,token_id" +
        "&order=created_at.desc&limit=" + n
    );
    return r.ok ? { ok: true, commands: Array.isArray(r.data) ? r.data : [] } : r;
  }

  async function tokenLabel(tokenId) {
    if (!tokenId) return null;
    const { [TOKEN_LABELS_KEY]: labels } = await chrome.storage.local.get(TOKEN_LABELS_KEY);
    if (labels && labels[tokenId]) return labels[tokenId];
    const r = await listTokens();
    if (!r.ok) return null;
    const t = r.tokens.find((x) => x.id === tokenId);
    return (t && t.label) || null;
  }

  // ------------------------------------------------------------ commands

  function parseCommand(row) {
    const cmd = row && row.command;
    if (!(cmd in COMMANDS)) {
      return {
        ok: false,
        error: `Unknown command "${cmd}". Supported: ${Object.keys(COMMANDS).join(", ")}.`,
      };
    }
    const p = row.payload;
    if (p != null && (typeof p !== "object" || Array.isArray(p))) {
      return { ok: false, error: "payload must be a JSON object." };
    }
    const o = p || {};
    let days;
    if (o.days !== undefined) {
      days = Number(o.days);
      if (!Number.isInteger(days) || days < 1 || days > MAX_DAYS) {
        return { ok: false, error: `payload.days must be a whole number from 1 to ${MAX_DAYS}.` };
      }
    }
    return { ok: true, command: cmd, days };
  }

  // ------------------------------------------------------------ poll

  let polling = null;

  /** One poll: claim the next waiting command and start it. Never throws. */
  function poll() {
    if (!polling) polling = pollOnce().finally(() => (polling = null));
    return polling;
  }

  async function pollOnce() {
    const at = Date.now();
    try {
      const settings = await getSettings();
      if (!settings.enabled) return { at, ok: true, claimed: 0, skipped: "disabled" };
      const ent = await NAFS.getEntitlement();
      if (!ent.signedIn) return saveStatus({ at, ok: true, claimed: 0, skipped: "signed-out" });
      if (!ent.scheduledScans) return saveStatus({ at, ok: true, claimed: 0, skipped: "not-pro" });
      // Leave requests pending while a job runs; they're picked up after it.
      if (hooks.isBusy && (await hooks.isBusy())) {
        return saveStatus({ ...((await getStatus()) || {}), at, ok: true, claimed: 0, skipped: "busy" });
      }

      const got = await claim(await hooks.deviceId());
      if (!got.ok) return saveStatus({ at, ok: false, error: got.error, claimed: 0 });

      let last = null;
      for (const row of got.rows) {
        const outcome = await execute(row, settings);
        // `pending` = a scan was started; the job reports back when it ends.
        if (outcome.status !== "pending") await complete(row.id, outcome);
        last = { id: row.id, command: row.command, status: outcome.status, error: outcome.error || null, at: Date.now() };
      }
      const prev = (await getStatus()) || {};
      return saveStatus({ at, ok: true, claimed: got.rows.length, last: last || prev.last || null });
    } catch (e) {
      return saveStatus({ at, ok: false, error: e && e.message ? e.message : String(e), claimed: 0 });
    }
  }

  async function execute(row, settings) {
    const label = (await tokenLabel(row.token_id).catch(() => null)) || "Incoming webhook";
    const parsed = parseCommand(row);
    const refuse = async (error) => {
      if (hooks.logRequest) await hooks.logRequest({ command: row.command, label, status: "error", error });
      return { status: "failed", error };
    };
    if (!parsed.ok) return refuse(parsed.error);
    if (!settings.allowed.includes(parsed.command)) {
      return refuse(`"${parsed.command}" isn't switched on for webhooks in this browser (Dashboard → Incoming webhooks).`);
    }
    if (parsed.command === "ping") {
      if (hooks.logRequest) await hooks.logRequest({ command: "ping", label, status: "done" });
      return {
        status: "done",
        result: { pong: true, device: await hooks.deviceId(), version: chrome.runtime.getManifest().version, at: Date.now() },
      };
    }
    try {
      const started = await hooks.startScans(parsed.command, {
        days: parsed.days,
        inbound: { id: row.id, label, command: parsed.command },
      });
      if (!started || !started.ok) return refuse((started && started.error) || "Could not start the scan.");
      return { status: "pending" };
    } catch (e) {
      return refuse(e && e.message ? e.message : String(e));
    }
  }

  return {
    COMMANDS,
    init,
    poll,
    getSettings,
    setSettings,
    getStatus,
    endpointUrl,
    complete,
    createToken,
    revokeToken,
    listTokens,
    listRecent,
  };
})();
