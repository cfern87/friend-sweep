// Google Drive I/O for FriendSweep sync, ported from the CRM extension's
// drive.ts (ee-chrome-crm/packages/extension/src/drive.ts).
//
// WHY: chrome.storage.sync gives an extension 100 KB in total. A list of a few
// thousand friends doesn't fit, so sync.js left most of it out. Drive's hidden
// per-app folder (`appDataFolder`) has no such ceiling, lives in the user's
// own Drive (no backend to run), and is the same folder on every browser
// signed into the same Google account.
//
// This file owns auth and Drive requests only. sync.js decides what to write
// and when, and merges what it reads. Loaded into the background worker with
// importScripts, so only the worker ever holds a token.
//
// AUTH, as in the CRM — two paths, because no single one covers both browsers:
//  * 'browser'  — chrome.identity.getAuthToken. Chrome owns the grant and
//                 renews it silently forever: no popup, no refresh token in our
//                 code, nothing for the user to redo. Reads oauth2.client_id
//                 from the manifest, which must be a "Chrome Extension" type
//                 OAuth client for this extension's ID.
//  * 'implicit' — launchWebAuthFlow against a "Web application" client
//                 (WEB_APP_CLIENT_ID below). Edge, and Chrome profiles that
//                 aren't signed into Chrome. Tokens last an hour; the poll
//                 alarm in sync.js renews them silently with prompt=none and a
//                 login_hint before they run out.
// Both clients must be in the same Google Cloud project: appDataFolder is per
// project, so that is what puts Chrome and Edge on the same file.

const FriendDrive = (() => {
  const DRIVE_API = "https://www.googleapis.com/drive/v3";
  const DRIVE_UPLOAD = "https://www.googleapis.com/upload/drive/v3";
  const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
  const REVOKE_ENDPOINT = "https://oauth2.googleapis.com/revoke";
  const USERINFO_ENDPOINT = "https://www.googleapis.com/oauth2/v3/userinfo";

  // Placeholders until real client ids are pasted in (see README → Google
  // Drive sync). isConfigured() treats them as "not set up".
  const CLIENT_ID_PLACEHOLDER = "YOUR_GOOGLE_OAUTH_CLIENT_ID";
  // The "Web application" client used only by the launchWebAuthFlow fallback.
  // It can't live in the manifest: oauth2.client_id is read by getAuthToken,
  // which needs the "Chrome Extension" client. Its Authorized redirect URIs
  // must include https://<extension-id>.chromiumapp.org/ (trailing slash).
  const WEB_APP_CLIENT_ID = "YOUR_GOOGLE_OAUTH_CLIENT_ID_WEB";

  // `openid email` lets us learn the account, and login_hint is what stops a
  // silent renewal failing on a browser signed into several Google accounts.
  const SCOPES = "https://www.googleapis.com/auth/drive.appdata openid email";

  const TOKEN_CACHE_KEY = "fsDriveToken";
  const ACCOUNT_EMAIL_KEY = "fsDriveEmail";
  const AUTH_MODE_KEY = "fsDriveAuthMode";
  // Kept through "Delete all data" — the Drive connection isn't friend data.
  const STORAGE_KEYS = [TOKEN_CACHE_KEY, ACCOUNT_EMAIL_KEY, AUTH_MODE_KEY];

  const TOKEN_SKEW_MS = 90000; // renew a little early so a token can't expire mid-request
  const PROACTIVE_REFRESH_MS = 5 * 60000;
  // A silent auth call that never calls back (worker torn down mid-flow, no
  // window to host the page) would otherwise wedge every later sync behind it.
  const AUTH_FLOW_TIMEOUT_MS = 30000;
  // The interactive consent is a person reading a Google page — give them time.
  const INTERACTIVE_TIMEOUT_MS = 5 * 60000;
  const REQUEST_TIMEOUT_MS = 60000;
  const MAX_TRANSIENT_RETRIES = 3;

  let lastAuthError = "";

  // ------------------------------------------------------------ config

  function manifestClientId() {
    try {
      const o = chrome.runtime.getManifest().oauth2;
      return (o && o.client_id) || "";
    } catch (e) {
      return "";
    }
  }

  function webClientConfigured() {
    return !!WEB_APP_CLIENT_ID && !WEB_APP_CLIENT_ID.startsWith(CLIENT_ID_PLACEHOLDER);
  }

  function browserClientConfigured() {
    const id = manifestClientId();
    return !!id && !id.startsWith(CLIENT_ID_PLACEHOLDER);
  }

  /** True once at least one usable OAuth client is wired in. */
  function isConfigured() {
    return (browserClientConfigured() && browserBrokerAvailable()) || webClientConfigured();
  }

  function identityAvailable() {
    try {
      return !!(chrome.identity && (chrome.identity.getAuthToken || chrome.identity.launchWebAuthFlow));
    } catch (e) {
      return false;
    }
  }

  function redirectUri() {
    try {
      return chrome.identity.getRedirectURL();
    } catch (e) {
      return "";
    }
  }

  // Edge ships the getAuthToken API but wires it to Microsoft identities, so
  // it is present and useless there. Sniffing the UA is crude but far more
  // deterministic than classifying Edge's error strings.
  function browserBrokerAvailable() {
    try {
      if (!chrome.identity || !chrome.identity.getAuthToken) return false;
      const ua = (typeof navigator !== "undefined" && navigator.userAgent) || "";
      return !/Edg\/|OPR\//i.test(ua);
    } catch (e) {
      return false;
    }
  }

  // ------------------------------------------------------------ small storage

  async function take(key) {
    try {
      const got = await chrome.storage.local.get(key);
      return got[key] ?? null;
    } catch (e) {
      return null;
    }
  }

  async function put(key, value) {
    try {
      if (value === null || value === undefined) await chrome.storage.local.remove(key);
      else await chrome.storage.local.set({ [key]: value });
    } catch (e) {
      /* best effort */
    }
  }

  // Which path last worked, remembered WITH the client id it was learned for:
  // swapping the manifest client is exactly how you change which path is
  // possible, so a verdict about the old client must not outlive it.
  async function authModeGet() {
    const rec = await take(AUTH_MODE_KEY);
    if (rec && rec.clientId === manifestClientId() && (rec.mode === "browser" || rec.mode === "implicit")) {
      return rec.mode;
    }
    return browserBrokerAvailable() && browserClientConfigured() ? "browser" : "implicit";
  }
  const authModeSet = (mode) => put(AUTH_MODE_KEY, { mode, clientId: manifestClientId() });
  const authModeReset = () => put(AUTH_MODE_KEY, null);

  // ------------------------------------------------------------ path 1: Chrome brokers it

  function browserGetToken(interactive) {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value, why) => {
        if (settled) return;
        settled = true;
        if (!value && why && interactive) lastAuthError = why;
        resolve(value);
      };
      const timer = setTimeout(
        () => finish(null, "Chrome did not answer the sign-in request in time."),
        interactive ? INTERACTIVE_TIMEOUT_MS : AUTH_FLOW_TIMEOUT_MS
      );
      try {
        chrome.identity.getAuthToken({ interactive, scopes: SCOPES.split(" ") }, (result) => {
          clearTimeout(timer);
          const e = chrome.runtime.lastError;
          // Older signatures pass a bare string; newer ones an object.
          const token = typeof result === "string" ? result : result && result.token;
          if (e || !token) {
            finish(null, (e && e.message) || "Chrome returned no token.");
            return;
          }
          lastAuthError = "";
          finish(token);
        });
      } catch (err) {
        clearTimeout(timer);
        finish(null, String(err));
      }
    });
  }

  function browserForgetToken(token) {
    return new Promise((resolve) => {
      try {
        chrome.identity.removeCachedAuthToken({ token }, () => {
          void chrome.runtime.lastError;
          resolve();
        });
      } catch (e) {
        resolve();
      }
    });
  }

  // ------------------------------------------------------------ path 2: auth window

  function launchFlow(url, interactive) {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value, why) => {
        if (settled) return;
        settled = true;
        // A failed SILENT attempt is routine (that's what prompt=none means).
        if (!value && interactive && why) lastAuthError = why;
        resolve(value);
      };
      const timer = setTimeout(
        () => finish(null, "Google sign-in did not respond in time."),
        interactive ? INTERACTIVE_TIMEOUT_MS : AUTH_FLOW_TIMEOUT_MS
      );
      try {
        chrome.identity.launchWebAuthFlow({ url, interactive }, (redirect) => {
          clearTimeout(timer);
          const e = chrome.runtime.lastError;
          if (e || !redirect) {
            finish(null, (e && e.message) || "No redirect returned.");
            return;
          }
          finish(redirect);
        });
      } catch (err) {
        clearTimeout(timer);
        finish(null, String(err));
      }
    });
  }

  function fetchWithTimeout(url, init, ms) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), ms);
    return fetch(url, { ...init, signal: ctl.signal }).finally(() => clearTimeout(timer));
  }

  async function runImplicitFlow(interactive) {
    if (!webClientConfigured()) return null;
    const params = new URLSearchParams({
      client_id: WEB_APP_CLIENT_ID,
      response_type: "token",
      redirect_uri: redirectUri(),
      scope: SCOPES,
    });
    if (interactive) {
      params.set("prompt", "select_account");
    } else {
      params.set("prompt", "none");
      // Without this, prompt=none fails with account_selection_required on any
      // browser signed into more than one Google account.
      const hint = await take(ACCOUNT_EMAIL_KEY);
      if (hint) params.set("login_hint", hint);
    }
    const redirect = await launchFlow(AUTH_ENDPOINT + "?" + params, interactive);
    if (!redirect) return null;

    const frag = new URLSearchParams(redirect.split("#")[1] || "");
    const query = new URLSearchParams((redirect.split("?")[1] || "").split("#")[0]);
    const err = frag.get("error") || query.get("error");
    if (err) {
      if (interactive) lastAuthError = `Google returned "${err}".`;
      return null;
    }
    const token = frag.get("access_token");
    if (!token) return null;
    const cached = { token, expiresAt: Date.now() + Number(frag.get("expires_in") || "3600") * 1000 };
    await put(TOKEN_CACHE_KEY, cached);
    lastAuthError = "";
    if (!(await take(ACCOUNT_EMAIL_KEY))) learnAccountEmail(token);
    return cached;
  }

  async function learnAccountEmail(token) {
    try {
      const res = await fetchWithTimeout(USERINFO_ENDPOINT, { headers: { Authorization: "Bearer " + token } }, 20000);
      if (!res.ok) return;
      const json = await res.json();
      if (json.email) await put(ACCOUNT_EMAIL_KEY, json.email);
    } catch (e) {
      /* login_hint is an optimisation, not a requirement */
    }
  }

  // ------------------------------------------------------------ the token everything asks for

  // Concurrent callers share one auth attempt instead of each opening a popup.
  let tokenInFlight = null;

  async function obtainToken(interactive) {
    if (!identityAvailable()) {
      lastAuthError = "chrome.identity is unavailable.";
      return null;
    }
    // 1. Let Chrome broker it: silent renewal forever, no window, no cookie.
    if (browserBrokerAvailable() && browserClientConfigured()) {
      const silent = await browserGetToken(false);
      if (silent) {
        await authModeSet("browser");
        return silent;
      }
      if (interactive) {
        const prompted = await browserGetToken(true);
        if (prompted) {
          await authModeSet("browser");
          return prompted;
        }
      }
      // Usually: this profile isn't signed into Chrome. Fall through, but don't
      // record it as permanent — signing into Chrome later should promote it.
    }
    // 2. The auth-window flow. Edge always lands here.
    const silent = await runImplicitFlow(false);
    if (silent) {
      await authModeSet("implicit");
      return silent.token;
    }
    if (interactive) {
      const prompted = await runImplicitFlow(true);
      if (prompted) {
        await authModeSet("implicit");
        return prompted.token;
      }
    }
    return null;
  }

  // In 'browser' mode we don't consult our own cache: Chrome keeps one, renews
  // behind our back and can invalidate a token we still believe in.
  async function getAuthToken(interactive) {
    if ((await authModeGet()) !== "browser") {
      const cached = await take(TOKEN_CACHE_KEY);
      if (cached && cached.token && cached.expiresAt > Date.now() + TOKEN_SKEW_MS) return cached.token;
    }
    if (tokenInFlight) {
      const shared = await tokenInFlight;
      // A failed silent attempt shouldn't stop an interactive caller escalating.
      if (shared || !interactive) return shared;
    }
    const run = obtainToken(interactive);
    tokenInFlight = run;
    try {
      return await run;
    } finally {
      if (tokenInFlight === run) tokenInFlight = null;
    }
  }

  /**
   * Renew BEFORE anything needs it — called from sync.js's poll alarm, so an
   * hourly rollover on the fallback path happens on a schedule rather than in
   * the middle of a push. A cheap liveness check in 'browser' mode.
   */
  async function ensureFreshToken() {
    if (!isConfigured() || !identityAvailable()) return false;
    if ((await authModeGet()) === "browser") return !!(await browserGetToken(false));
    const cached = await take(TOKEN_CACHE_KEY);
    if (cached && cached.expiresAt > Date.now() + PROACTIVE_REFRESH_MS) return true;
    return !!(await getAuthToken(false));
  }

  async function invalidateToken(token) {
    if ((await authModeGet()) === "browser") await browserForgetToken(token);
    else await put(TOKEN_CACHE_KEY, null);
  }

  // ------------------------------------------------------------ requests

  class DriveError extends Error {
    constructor(message, status, reason) {
      super(message);
      this.status = status;
      this.reason = reason;
    }
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // 0.5s, 1s, 2s plus jitter, so browsers that hit the same rate limit don't
  // come back in lockstep.
  const backoffMs = (attempt) => 500 * 2 ** attempt + Math.floor(Math.random() * 250);

  async function safeText(res) {
    try {
      return (await res.text()).slice(0, 300);
    } catch (e) {
      return "";
    }
  }

  async function failureReason(res) {
    const text = await safeText(res);
    try {
      const e = JSON.parse(text).error || {};
      return (e.errors && e.errors[0] && e.errors[0].reason) || e.status || e.message || text;
    } catch (e) {
      return text;
    }
  }

  /**
   * Fetch a Drive endpoint with the current token. Failures meaning "the round
   * trip didn't happen" (no token, network, throttling, 5xx) are retried, then
   * thrown as DriveError. Ordinary HTTP answers, 404 included, are returned.
   * `idempotent: false` (file creation) is never retried blind: a create that
   * timed out may have landed, and a retry would leave two files.
   */
  async function driveFetch(url, init, { interactive = false, idempotent = true } = {}) {
    let authRetried = false;
    let transient = 0;
    for (;;) {
      const token = await getAuthToken(interactive);
      if (!token) {
        throw new DriveError(lastAuthError || "Not signed in to Google.", 401, "no_token");
      }
      let res;
      try {
        res = await fetchWithTimeout(
          url,
          { ...init, headers: { ...(init.headers || {}), Authorization: "Bearer " + token } },
          REQUEST_TIMEOUT_MS
        );
      } catch (e) {
        if (idempotent && transient < MAX_TRANSIENT_RETRIES) {
          await sleep(backoffMs(transient++));
          continue;
        }
        throw new DriveError("Drive unreachable: " + String((e && e.message) || e), 0, "network");
      }
      if (res.status === 401) {
        // Rejected server-side while whoever holds it still thinks it's valid.
        if (!authRetried) {
          authRetried = true;
          await invalidateToken(token);
          continue;
        }
        throw new DriveError("Google rejected the access token.", 401, "unauthorized");
      }
      if (res.status === 403 || res.status === 429 || res.status >= 500) {
        const reason = await failureReason(res);
        // A bare 403 is almost always throttling; a real permission problem
        // won't be fixed by retrying.
        const retryable = res.status !== 403 || /rateLimit|userRateLimit|quota|backendError/i.test(reason);
        if (retryable && idempotent && transient < MAX_TRANSIENT_RETRIES) {
          await sleep(backoffMs(transient++));
          continue;
        }
        throw new DriveError(`Drive request failed (${res.status}): ${reason}`, res.status, reason);
      }
      return res;
    }
  }

  // ------------------------------------------------------------ files

  const META_FIELDS = "id,version,modifiedTime,size";

  function meta(f) {
    return {
      id: f.id,
      version: f.version ? String(f.version) : "",
      modifiedTime: f.modifiedTime || "",
      size: f.size ? Number(f.size) : 0,
    };
  }

  /**
   * Every live file with this name, oldest first. Normally one; two browsers
   * creating the file at the same moment can leave two, and sync.js merges
   * them back into the oldest.
   */
  async function listFiles(name) {
    const params = new URLSearchParams({
      spaces: "appDataFolder",
      q: `name='${name}' and trashed=false`,
      fields: `files(${META_FIELDS})`,
      orderBy: "createdTime",
      pageSize: "10",
    });
    const res = await driveFetch(`${DRIVE_API}/files?${params}`, { method: "GET" });
    if (!res.ok) throw new DriveError(`Drive list failed (${res.status}): ${await safeText(res)}`, res.status);
    const data = await res.json();
    return (data.files || []).map(meta);
  }

  /** Metadata only — the cheap call the poll makes. Null if the file is gone. */
  async function getMeta(id) {
    const res = await driveFetch(`${DRIVE_API}/files/${id}?fields=${META_FIELDS},trashed`, { method: "GET" });
    if (res.status === 404) return null;
    if (!res.ok) throw new DriveError(`Drive read failed (${res.status}): ${await safeText(res)}`, res.status);
    const f = await res.json();
    return f.trashed ? null : meta(f);
  }

  /** File content as text. Null if the file is gone. */
  async function download(id) {
    const res = await driveFetch(`${DRIVE_API}/files/${id}?alt=media`, { method: "GET" });
    if (res.status === 404) return null;
    if (!res.ok) throw new DriveError(`Drive read failed (${res.status}): ${await safeText(res)}`, res.status);
    return res.text();
  }

  /** Overwrite a file's content in place. Null if the file is gone. */
  async function update(id, body) {
    const res = await driveFetch(
      `${DRIVE_UPLOAD}/files/${id}?uploadType=media&fields=${META_FIELDS}`,
      { method: "PATCH", headers: { "Content-Type": "application/json" }, body }
    );
    if (res.status === 404) return null;
    if (!res.ok) throw new DriveError(`Drive write failed (${res.status}): ${await safeText(res)}`, res.status);
    return meta(await res.json());
  }

  /** Create a file in the hidden app-data folder (multipart: metadata + content). */
  async function create(name, body) {
    const boundary = "fs" + Date.now().toString(36) + Math.random().toString(36).slice(2);
    const multipart =
      `--${boundary}\r\n` +
      "Content-Type: application/json; charset=UTF-8\r\n\r\n" +
      JSON.stringify({ name, parents: ["appDataFolder"] }) + "\r\n" +
      `--${boundary}\r\n` +
      "Content-Type: application/json\r\n\r\n" +
      body + "\r\n" +
      `--${boundary}--`;
    const res = await driveFetch(
      `${DRIVE_UPLOAD}/files?uploadType=multipart&fields=${META_FIELDS}`,
      { method: "POST", headers: { "Content-Type": "multipart/related; boundary=" + boundary }, body: multipart },
      { idempotent: false }
    );
    if (!res.ok) throw new DriveError(`Drive create failed (${res.status}): ${await safeText(res)}`, res.status);
    return meta(await res.json());
  }

  async function remove(id) {
    const res = await driveFetch(`${DRIVE_API}/files/${id}`, { method: "DELETE" });
    if (!res.ok && res.status !== 404) {
      throw new DriveError(`Drive delete failed (${res.status}): ${await safeText(res)}`, res.status);
    }
  }

  // ------------------------------------------------------------ connect / disconnect

  /** The interactive Google consent. Also the "Reconnect" action. */
  async function connect() {
    if (!isConfigured()) {
      return { ok: false, error: "Google Drive sync isn't set up in this build (no OAuth client id)." };
    }
    // Start clean: a stale token would short-circuit the very sign-in being
    // redone, and a path verdict from before (say) signing into Chrome
    // shouldn't carry forward.
    await put(TOKEN_CACHE_KEY, null);
    await authModeReset();
    const token = await getAuthToken(true);
    if (!token) return { ok: false, error: lastAuthError || "Sign-in was cancelled or denied." };
    if (!(await take(ACCOUNT_EMAIL_KEY))) await learnAccountEmail(token);
    return { ok: true, email: (await take(ACCOUNT_EMAIL_KEY)) || "", mode: await authModeGet() };
  }

  /**
   * Drop this browser's credentials and best-effort revoke the grant. Leaves
   * the Drive file alone — the data stays for the other browsers.
   */
  async function disconnect() {
    let live = null;
    try {
      live = await getAuthToken(false);
    } catch (e) {
      /* nothing to revoke */
    }
    if ((await authModeGet()) === "browser") {
      if (live) await browserForgetToken(live);
      await new Promise((resolve) => {
        try {
          chrome.identity.clearAllCachedAuthTokens(() => {
            void chrome.runtime.lastError;
            resolve();
          });
        } catch (e) {
          resolve();
        }
      });
    }
    await put(TOKEN_CACHE_KEY, null);
    await put(ACCOUNT_EMAIL_KEY, null);
    await authModeReset();
    if (live) {
      try {
        await fetchWithTimeout(
          REVOKE_ENDPOINT,
          {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({ token: live }).toString(),
          },
          20000
        );
      } catch (e) {
        /* the local credentials are gone either way */
      }
    }
  }

  async function authState() {
    const mode = await authModeGet();
    return {
      configured: isConfigured(),
      mode,
      // False means the fallback path: renewed hourly against a live Google
      // session in this browser.
      silentRenewal: mode === "browser",
      email: (await take(ACCOUNT_EMAIL_KEY)) || "",
      redirectUri: redirectUri(),
      lastError: lastAuthError,
    };
  }

  return {
    STORAGE_KEYS,
    DriveError,
    isConfigured,
    ensureFreshToken,
    listFiles,
    getMeta,
    download,
    update,
    create,
    remove,
    connect,
    disconnect,
    authState,
  };
})();
