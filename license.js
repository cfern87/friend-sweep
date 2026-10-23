// Not Another Friend Sweeper — account + plan client (background worker).
//
// The extension stays local-first: friends, scores and engagement never leave
// the browser. This module answers two questions for the worker:
//
//   * is someone signed in? (the extension is locked until they are)
//   * what does their plan allow? (Free vs Pro)
//
// Sign-in happens on the website (/extension-auth), which hands the session
// back over chrome.runtime.sendMessage (manifest externally_connectable). The
// session is kept in chrome.storage.local and refreshed against the auth
// service when it expires. Plan answers are cached so normal use never blocks
// on the network; free-plan removals are counted on the server.

const NAFS = (() => {
  const AUTH_URL = "https://qrodsterxosgbpkdenqv.supabase.co";
  const AUTH_KEY = "sb_publishable_oKIyNvAc3_lEksaE8lUnrg_iPHTtaKa";

  /** The production website (sign-in, billing, support). */
  const PLATFORM_URL = "https://notanotherfriendsweeper.com";

  // Sites allowed to hand over a session — keep in sync with
  // manifest.json externally_connectable. Each maps to the origin whose
  // /api/public/* endpoints that session should talk to.
  const PREVIEW_API = "https://project--a16a1936-14fb-4d4b-a630-0ff28ec2b152-dev.lovable.app";
  const PLATFORM_ORIGINS = {
    "https://notanotherfriendsweeper.com": PLATFORM_URL,
    "https://www.notanotherfriendsweeper.com": PLATFORM_URL,
    "https://project--a16a1936-14fb-4d4b-a630-0ff28ec2b152.lovable.app":
      "https://project--a16a1936-14fb-4d4b-a630-0ff28ec2b152.lovable.app",
    "https://id-preview--a16a1936-14fb-4d4b-a630-0ff28ec2b152.lovable.app": PREVIEW_API,
    [PREVIEW_API]: PREVIEW_API,
  };

  // Free plan limits — the server is the source of truth; these are the
  // fallbacks shown before the first plan check comes back.
  const FREE_REMOVALS_PER_MONTH = 40;
  const FREE_MAX_SCAN_DAYS = 30;
  const PRO_MAX_SCAN_DAYS = 365;

  const SESSION_KEY = "nafsAccount";
  const ENT_KEY = "nafsEntitlement";
  const PENDING_KEY = "nafsPendingRemovals";
  const STORAGE_KEYS = [SESSION_KEY, ENT_KEY, PENDING_KEY];

  const ENT_TTL_MS = 60 * 60 * 1000; // re-check hourly
  const PRO_GRACE_MS = 7 * 24 * 3600 * 1000; // keep Pro through a week offline
  const TOKEN_SKEW_MS = 60 * 1000;

  const ALARM = "nafs-entitlement";
  const ALARM_PERIOD_MIN = 60;

  const SIGNED_OUT = {
    signedIn: false,
    email: null,
    isPro: false,
    plan: null,
    status: null,
    removalsLimit: FREE_REMOVALS_PER_MONTH,
    removalsUsed: 0,
    removalsRemaining: 0,
    resetsAt: null,
    scheduledScans: false,
    maxScanDays: FREE_MAX_SCAN_DAYS,
    csvExport: false,
    checkedAt: 0,
  };

  // ---------------------------------------------------------------- storage

  async function get(key) {
    const res = await chrome.storage.local.get(key);
    return res[key] ?? null;
  }
  async function put(key, value) {
    if (value === null || value === undefined) await chrome.storage.local.remove(key);
    else await chrome.storage.local.set({ [key]: value });
  }

  // ---------------------------------------------------------------- session

  const getSession = () => get(SESSION_KEY);

  async function authPost(path, body, token) {
    const headers = { "Content-Type": "application/json", apikey: AUTH_KEY };
    if (token) headers.Authorization = "Bearer " + token;
    const res = await fetch(AUTH_URL + "/auth/v1" + path, {
      method: "POST",
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(json.error_description || json.msg || json.error || "Auth failed (" + res.status + ")");
      err.status = res.status;
      throw err;
    }
    return json;
  }

  async function accessToken() {
    const s = await getSession();
    if (!s) return null;
    if (s.expiresAt > Date.now() + TOKEN_SKEW_MS) return s.accessToken;
    try {
      const t = await authPost("/token?grant_type=refresh_token", { refresh_token: s.refreshToken });
      if (!t.access_token || !t.refresh_token) return null;
      const next = {
        ...s,
        accessToken: t.access_token,
        refreshToken: t.refresh_token,
        expiresAt: Date.now() + (t.expires_in || 3600) * 1000,
        email: (t.user && t.user.email) || s.email,
      };
      await put(SESSION_KEY, next);
      return next.accessToken;
    } catch (e) {
      // A rejected refresh token means the session is gone for good.
      if (e.status === 400 || e.status === 401) await signOutLocal();
      return null;
    }
  }

  async function signOutLocal() {
    await put(SESSION_KEY, null);
    await put(ENT_KEY, null);
  }

  async function signOut() {
    const s = await getSession();
    if (s) {
      try {
        await authPost("/logout", null, s.accessToken);
      } catch (e) {
        /* best effort */
      }
    }
    await signOutLocal();
  }

  /** The site sign-in page, told which extension to hand the session to. */
  function signInUrl() {
    return PLATFORM_URL + "/extension-auth?ext=" + encodeURIComponent(chrome.runtime.id);
  }

  function openWebSignIn() {
    chrome.tabs.create({ url: signInUrl() });
  }

  async function apiBase() {
    const s = await getSession();
    return (s && s.apiBase) || PLATFORM_URL;
  }

  /** Accept a session handed over by one of the allowed sites. */
  async function adoptExternalSession(payload, senderOrigin) {
    const base = PLATFORM_ORIGINS[senderOrigin];
    if (!base) return { ok: false, error: "This site can't sign the extension in." };
    const p = payload || {};
    if (typeof p.accessToken !== "string" || typeof p.refreshToken !== "string") {
      return { ok: false, error: "Incomplete session." };
    }
    await put(SESSION_KEY, {
      accessToken: p.accessToken,
      refreshToken: p.refreshToken,
      expiresAt: Number(p.expiresAt) || Date.now() + 3600 * 1000,
      email: typeof p.email === "string" ? p.email : "",
      userId: typeof p.userId === "string" ? p.userId : "",
      apiBase: base,
    });
    await put(PENDING_KEY, 0);
    try {
      await refreshEntitlement();
    } catch (e) {
      /* offline — next check fills it in */
    }
    return { ok: true };
  }

  // ---------------------------------------------------------------- plan

  function fromServer(json, email) {
    const isPro = !!json.is_pro;
    const f = json.features || {};
    return {
      signedIn: true,
      email: json.email || email || null,
      isPro,
      plan: json.plan || null,
      status: json.subscription_status || null,
      removalsLimit: isPro ? null : json.removals_limit ?? FREE_REMOVALS_PER_MONTH,
      removalsUsed: json.removals_used || 0,
      removalsRemaining: isPro ? null : Math.max(0, json.removals_remaining ?? 0),
      resetsAt: json.period_resets_at || null,
      scheduledScans: !!f.scheduled_scans,
      maxScanDays: f.max_scan_days || (isPro ? PRO_MAX_SCAN_DAYS : FREE_MAX_SCAN_DAYS),
      csvExport: !!f.csv_export,
      checkedAt: Date.now(),
    };
  }

  async function api(path, init) {
    const token = await accessToken();
    if (!token) return { signedOut: true };
    const res = await fetch((await apiBase()) + path, {
      ...init,
      headers: { ...(init && init.headers), Authorization: "Bearer " + token, "Content-Type": "application/json" },
    });
    if (res.status === 401) {
      await signOutLocal();
      return { signedOut: true };
    }
    if (!res.ok) throw new Error("Plan check failed (" + res.status + ")");
    return { json: await res.json() };
  }

  // Removals that happened while the server couldn't be reached.
  async function flushPending() {
    const n = (await get(PENDING_KEY)) || 0;
    if (!n) return null;
    const r = await api("/api/public/removals", { method: "POST", body: JSON.stringify({ count: n }) });
    if (r.json) await put(PENDING_KEY, Math.max(0, ((await get(PENDING_KEY)) || 0) - n));
    return r;
  }

  async function refreshEntitlement() {
    if (!(await getSession())) {
      await put(ENT_KEY, null);
      return { ...SIGNED_OUT };
    }
    try {
      await flushPending();
    } catch (e) {
      /* stays pending */
    }
    const r = await api("/api/public/entitlement", { method: "GET" });
    if (r.signedOut) return { ...SIGNED_OUT };
    const s = await getSession();
    const ent = fromServer(r.json, s && s.email);
    await put(ENT_KEY, ent);
    return ent;
  }

  /** The plan to act on now: fresh cache, else a server check, else a safe fallback. */
  async function getEntitlement(force) {
    const session = await getSession();
    if (!session) return { ...SIGNED_OUT };
    const cached = await get(ENT_KEY);
    if (cached && !force && Date.now() - cached.checkedAt < ENT_TTL_MS) return withPending(cached);
    try {
      return withPending(await refreshEntitlement());
    } catch (e) {
      if (cached && cached.isPro && Date.now() - cached.checkedAt < PRO_GRACE_MS) {
        return { ...cached, stale: true };
      }
      // Free (or unknown) and offline: features stay at free limits.
      const base = cached ? { ...cached, isPro: false } : { ...SIGNED_OUT, signedIn: true, email: session.email };
      return withPending({
        ...base,
        scheduledScans: false,
        maxScanDays: FREE_MAX_SCAN_DAYS,
        csvExport: false,
        stale: true,
      });
    }
  }

  async function withPending(ent) {
    if (!ent || ent.isPro || !ent.signedIn) return ent;
    const pending = (await get(PENDING_KEY)) || 0;
    if (!pending) return ent;
    return {
      ...ent,
      removalsUsed: ent.removalsUsed + pending,
      removalsRemaining: Math.max(0, (ent.removalsRemaining || 0) - pending),
    };
  }

  /**
   * How many of `wanted` removals may run now. Free accounts need a fresh
   * server answer so the monthly allowance can't be exceeded offline.
   */
  async function allowRemovals(wanted) {
    const ent = await getEntitlement(true);
    if (!ent.signedIn) return { allowed: 0, ent, error: "Sign in to remove friends." };
    if (ent.isPro) return { allowed: wanted, ent };
    if (ent.stale) {
      return {
        allowed: 0,
        ent,
        error: "Couldn't reach the server to check your monthly removal allowance. Check your connection and try again.",
      };
    }
    const allowed = Math.min(wanted, ent.removalsRemaining || 0);
    if (!allowed) {
      return {
        allowed: 0,
        ent,
        upgrade: true,
        error: `You've used all ${ent.removalsLimit} free removals this month. Upgrade to Pro for unlimited removals.`,
      };
    }
    return { allowed, ent };
  }

  /** Count one completed removal against the monthly allowance. */
  async function recordRemoval() {
    const ent = await get(ENT_KEY);
    if (ent && ent.isPro) return;
    await put(PENDING_KEY, ((await get(PENDING_KEY)) || 0) + 1);
    try {
      const r = await flushPending();
      if (r && r.json) {
        const s = await getSession();
        await put(ENT_KEY, fromServer(r.json, s && s.email));
      }
    } catch (e) {
      /* stays pending, retried on the next plan check */
    }
  }

  function ensureAlarm() {
    chrome.alarms.get(ALARM, (existing) => {
      if (!existing) chrome.alarms.create(ALARM, { delayInMinutes: 1, periodInMinutes: ALARM_PERIOD_MIN });
    });
  }

  return {
    PLATFORM_URL,
    ALARM,
    STORAGE_KEYS,
    FREE_REMOVALS_PER_MONTH,
    FREE_MAX_SCAN_DAYS,
    getSession,
    getEntitlement,
    refreshEntitlement,
    allowRemovals,
    recordRemoval,
    adoptExternalSession,
    openWebSignIn,
    signOut,
    ensureAlarm,
    billingUrl: () => PLATFORM_URL + "/account/billing",
    supportUrl: () => PLATFORM_URL + "/support",
  };
})();
