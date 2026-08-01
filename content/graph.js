// FriendSweep GraphQL client (isolated world).
//
// This is the fast path for scanning and removal. Instead of scrolling and
// scraping Facebook's obfuscated DOM, it talks to Facebook's internal GraphQL
// endpoint the same way the page itself does:
//
//   * fb-interceptor.js (page/MAIN world) captures a real GraphQL request as
//     "boilerplate" — a form body already carrying every auth token — and
//     relays it here over window.postMessage.
//   * We clone that boilerplate and swap only doc_id + variables to perform
//     the operation we want (list friends, unfriend, …), then hand the body
//     back to the interceptor to POST in page context.
//
// The isolated scanner uses this via `window.FriendSweepGraph`. If no
// boilerplate is ever captured (e.g. Facebook changes transports, or the
// MAIN-world script is blocked), callers fall back to the DOM path.
//
// Persisted-query doc_ids drift over time. We seed known-good values but
// prefer any doc_id we've just seen Facebook use for the same friendly_name —
// so the client self-heals against Facebook's own live traffic.

(() => {
  if (window.FriendSweepGraph) return;

  const CHANNEL = "friendsweep";
  const SELF_MARK = "__fs_self";

  // Diagnostics. Everything on the GraphQL path logs through here so a failing
  // scan/removal leaves a visible trail in the page console. Flip DEBUG off (or
  // set window.__FRIENDSWEEP_DEBUG = false) to silence the verbose logs; errors
  // and warnings always print.
  const DEBUG = window.__FRIENDSWEEP_DEBUG !== false;
  const log = (...a) => DEBUG && console.log("[FriendSweep/graph]", ...a);
  const warn = (...a) => console.warn("[FriendSweep/graph]", ...a);

  // type -> { friendlyName, docId (seed) }. Friendly names are stable; doc_ids
  // are seeds that get overridden by live capture when available.
  const OPS = {
    user_friends: {
      // Facebook's own-friends list. Renamed from the generic
      // ProfileCometAppCollectionListRendererPaginationQuery; both are accepted
      // for token lookup (see FRIENDS_TOKEN_NAMES) and the doc_id self-heals.
      friendlyName: "ProfileCometAppCollectionSelfFriendsListRendererPaginationQuery",
      docId: "27590483443942457",
    },
    user_unfriend: {
      friendlyName: "FriendingCometUnfriendMutation",
      docId: "4281078165250156",
    },
    user_posts: {
      friendlyName: "ProfileCometTimelineFeedRefetchQuery",
      docId: "4430909743683968",
    },
    user_reactions: {
      friendlyName: "CometUFIReactionsDialogTabContentRefetchQuery",
      docId: "9515494628524128",
    },
    user_comments: {
      friendlyName: "CometUFICommentsProviderPaginationQuery",
      docId: "4401540983249473",
    },
  };

  const state = {
    ready: false, // MAIN-world bridge has announced itself
    boilerplate: null, // most recent Facebook GraphQL body (string)
    boilerplateAt: 0,
    actorId: null, // our own FB user id, read from the boilerplate's __user
    docIdByName: Object.create(null), // friendlyName -> doc_id (live)
    tokenByName: Object.create(null), // friendlyName -> collection token (live)
    varsByName: Object.create(null), // friendlyName -> full variables template (live)
  };

  const waiters = []; // resolvers waiting for boilerplate to arrive
  const pending = new Map(); // id -> {resolve,reject} for in-flight sends
  let seq = 0;

  // ------------------------------------------------------------- inbound
  // Messages come from the MAIN-world interceptor over the shared window. We
  // identify them by the private __source marker + same origin rather than an
  // `event.source === window` identity check, which is unreliable across the
  // isolated/MAIN world boundary and would silently drop every message.
  window.addEventListener("message", (event) => {
    if (event.origin !== window.location.origin) return;
    const msg = event.data;
    if (!msg || msg.__source !== CHANNEL) return;

    switch (msg.kind) {
      case "ready":
        state.ready = true;
        log("bridge ready (MAIN-world interceptor connected)");
        break;

      case "observed":
        if (msg.friendlyName && msg.docId) {
          const known = state.docIdByName[msg.friendlyName];
          state.docIdByName[msg.friendlyName] = msg.docId;
          if (!known) log("observed live doc_id", msg.friendlyName, "=", msg.docId);
        }
        if (msg.friendlyName && msg.collectionToken) {
          if (!state.tokenByName[msg.friendlyName])
            log("observed collection token for", msg.friendlyName);
          state.tokenByName[msg.friendlyName] = msg.collectionToken;
        }
        if (msg.friendlyName && msg.variables) state.varsByName[msg.friendlyName] = msg.variables;
        break;

      case "boilerplate": {
        const first = !state.boilerplate;
        state.boilerplate = msg.body;
        state.boilerplateAt = Date.now();
        try {
          state.actorId = new URLSearchParams(msg.body).get("__user") || state.actorId;
        } catch (e) {
          /* ignore */
        }
        if (first) log("captured Facebook GraphQL boilerplate; actor id =", state.actorId);
        while (waiters.length) waiters.shift()();
        break;
      }

      case "sendResult": {
        const p = pending.get(msg.id);
        if (!p) break;
        pending.delete(msg.id);
        if (msg.ok) p.resolve({ status: msg.status, text: msg.text });
        else p.reject(new Error(msg.error || "send failed"));
        break;
      }
    }
  });

  // Handshake: this isolated-world script loads after the MAIN-world interceptor,
  // so ask it to replay anything (boilerplate, tokens, doc_ids) it captured
  // before our listener existed. Sent a few times in case of load-order jitter.
  function hello() {
    window.postMessage({ __source: CHANNEL, kind: "hello" }, window.location.origin);
  }
  hello();
  setTimeout(hello, 250);
  setTimeout(hello, 1000);

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ------------------------------------------------------------- helpers
  function hasBoilerplate() {
    return !!state.boilerplate;
  }

  // Resolve once boilerplate is available, or false on timeout.
  function waitForReady(timeoutMs = 12000) {
    if (state.boilerplate) return Promise.resolve(true);
    return new Promise((resolve) => {
      let done = false;
      const finish = (v) => {
        if (done) return;
        done = true;
        resolve(v);
      };
      waiters.push(() => finish(true));
      setTimeout(() => finish(!!state.boilerplate), timeoutMs);
    });
  }

  function docIdFor(type) {
    const op = OPS[type];
    return state.docIdByName[op.friendlyName] || op.docId;
  }

  function collectionToken(friendlyName) {
    return state.tokenByName[friendlyName] || null;
  }

  // Friends-list pagination query names Facebook has used, newest first. The
  // collection token seeds friends pagination and is captured from whichever of
  // these fired; we read them back in priority order so a rename doesn't break
  // the scan.
  const FRIENDS_TOKEN_NAMES = [
    "ProfileCometAppCollectionSelfFriendsListRendererPaginationQuery",
    "ProfileCometAppCollectionListRendererPaginationQuery",
  ];
  function friendsToken() {
    for (const name of FRIENDS_TOKEN_NAMES) if (state.tokenByName[name]) return state.tokenByName[name];
    // Last resort: any captured token from an AppCollection pagination query.
    for (const name in state.tokenByName)
      if (/AppCollection.*Friends.*PaginationQuery/.test(name)) return state.tokenByName[name];
    return null;
  }

  // Facebook's own variables object for the friends-list query, captured live.
  // Reused as the base for our forged requests so every variable the persisted
  // query requires is present — we only override id/count/cursor.
  function friendsVariablesTemplate() {
    for (const name of FRIENDS_TOKEN_NAMES) if (state.varsByName[name]) return state.varsByName[name];
    for (const name in state.varsByName)
      if (/AppCollection.*Friends.*PaginationQuery/.test(name)) return state.varsByName[name];
    return null;
  }

  // Captured variables template for a query by exact friendly name, falling back
  // to a structural pattern so a Facebook rename doesn't lose it. Returns {} when
  // none was captured, so callers can spread it unconditionally.
  function templateFor(exactName, pattern) {
    if (state.varsByName[exactName]) return state.varsByName[exactName];
    if (pattern) for (const name in state.varsByName) if (pattern.test(name)) return state.varsByName[name];
    return {};
  }

  // Clone the captured boilerplate and swap in our operation. Everything else
  // (all the auth tokens) is carried over untouched.
  function forge(type, variables) {
    if (!state.boilerplate) throw new Error("no boilerplate captured");
    const op = OPS[type];
    const params = new URLSearchParams(state.boilerplate);
    params.set("fb_api_req_friendly_name", op.friendlyName);
    params.set("doc_id", docIdFor(type));
    params.set("variables", JSON.stringify(variables));
    params.set(SELF_MARK, "1"); // so the interceptor ignores our own traffic
    return params.toString();
  }

  // Hand a request to the MAIN world (which runs it in page context) and await
  // the result, keyed by a fresh id. `extra` carries kind-specific fields.
  function dispatch(kind, extra, timeoutMs = 20000) {
    const id = "s" + ++seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (pending.delete(id)) reject(new Error("request timed out"));
      }, timeoutMs);
      pending.set(id, {
        resolve: (v) => (clearTimeout(timer), resolve(v)),
        reject: (e) => (clearTimeout(timer), reject(e)),
      });
      window.postMessage({ __source: CHANNEL, kind, id, ...extra }, window.location.origin);
    });
  }

  // POST a forged GraphQL body; GET an arbitrary same-origin URL.
  const rawSend = (body, timeoutMs) => dispatch("send", { body }, timeoutMs);
  const rawFetch = (url, timeoutMs) => dispatch("fetchText", { url }, timeoutMs);

  // Facebook prefixes JSON responses with `for (;;);` as an anti-hijack guard,
  // and streams multi-part responses (@defer / incremental delivery) as one
  // JSON object per line. Split into every object it contains — single-object
  // responses come back as a one-element array. Mirrors FriendFilter's
  // extract_glued_json: strip to the outermost braces on each line and parse.
  function extractGluedJson(text) {
    return (text || "")
      .split("\n")
      .map((line) => line.substring(line.indexOf("{")))
      .map((line) => line.substring(0, line.lastIndexOf("}") + 1))
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch (e) {
          return null;
        }
      })
      .filter(Boolean);
  }

  function criticalError(obj) {
    const errors = (obj && obj.errors) || [];
    return errors.find((e) => e && e.severity === "CRITICAL") || null;
  }

  // Every error Facebook returned across all parts of a response (regardless of
  // severity), so a non-CRITICAL rejection — e.g. a stale doc_id or a bad
  // variable — is still visible instead of collapsing to "empty response".
  function allErrors(objects) {
    const out = [];
    for (const obj of objects) for (const e of (obj && obj.errors) || []) out.push(e);
    return out;
  }

  // Send a forged operation with retry + exponential backoff, returning every
  // JSON object in the (possibly multi-part) response. A CRITICAL error in any
  // part throws; rate-limit errors cool down and retry.
  async function sendForged(type, variables, { retries = 3 } = {}) {
    const op = OPS[type];
    const docId = docIdFor(type);
    let attempt = 0;
    for (;;) {
      try {
        const body = forge(type, variables);
        log("→", type, "(" + op.friendlyName + " doc_id=" + docId + ") attempt", attempt + 1);
        const { status, text } = await rawSend(body);
        const objects = extractGluedJson(text);

        // Surface any errors Facebook returned, whichever severity.
        const errs = allErrors(objects);
        if (errs.length) warn(type, "response carried", errs.length, "error(s):", errs.map((e) => e.message || e.summary || e.code).join(" | "));

        const crit = objects.map(criticalError).find(Boolean);
        if (crit) {
          const rateLimited = /rate|limit|too many|temporarily/i.test(
            (crit.message || "") + (crit.description || "")
          );
          if (rateLimited && attempt < retries) {
            attempt++;
            log(type, "rate-limited; cooling down");
            await sleep(Math.min(8000, 1000 * Math.pow(2, attempt)));
            continue;
          }
          throw new Error(crit.message || crit.summary || "GraphQL error");
        }
        if (status && status >= 400 && !objects.length) throw new Error("HTTP " + status);
        if (!objects.length) warn(type, "empty/unparseable response (HTTP " + status + "):", (text || "").slice(0, 300));
        log("←", type, "ok — HTTP", status, "-", objects.length, "object(s)");
        return objects;
      } catch (e) {
        attempt++;
        if (attempt > retries) {
          warn(type, "failed after", retries, "retries:", (e && e.message) || e);
          throw e;
        }
        const backoff = Math.min(5000, 400 * Math.pow(2, attempt - 1)) + Math.floor(Math.random() * 200);
        log(type, "retry", attempt, "after", backoff + "ms —", (e && e.message) || e);
        await sleep(backoff);
      }
    }
  }

  // Breadth-first search for the shallowest node satisfying `predicate(node,
  // path)`. The predicate returns the value to yield, or undefined/null/false
  // to keep looking. BFS means the top-level match wins over nested ones (e.g.
  // a post's own feedback over a comment's feedback). Facebook nests the same
  // shapes under different keys across surfaces, so we locate them structurally
  // rather than by a hard-coded path.
  function bfsFind(root, predicate) {
    const queue = [[root, []]];
    const seen = new Set();
    while (queue.length) {
      const [node, path] = queue.shift();
      if (!node || typeof node !== "object" || seen.has(node)) continue;
      seen.add(node);
      const hit = predicate(node, path);
      if (hit !== undefined && hit !== null && hit !== false) return hit;
      for (const k in node) {
        const v = node[k];
        if (v && typeof v === "object") queue.push([v, path.concat(k)]);
      }
    }
    return null;
  }

  function findConnection(objects) {
    for (const obj of objects) {
      const found = bfsFind(obj, (node) => {
        if (Array.isArray(node.edges)) return node;
        if (node.pageItems && (Array.isArray(node.pageItems.edges) || node.pageItems.page_info))
          return node.pageItems;
      });
      if (found) return found;
    }
    return null;
  }

  // Find the connection node reached via a specific parent key (e.g. "reactors",
  // "display_comments") across every part of a response.
  function findNodeByParentKey(objects, key) {
    for (const obj of objects) {
      const hit = bfsFind(obj, (n, p) => {
        if (p[p.length - 1] === key && Array.isArray(n.edges)) return n;
      });
      if (hit) return hit;
    }
    return null;
  }

  // Extract a friend's numeric id from a collection edge node. Tries the
  // action's profile_owner (FriendFilter's path), any nested profile_owner.id,
  // then a profile.php?id= url. Requires an all-digit id so a Relay node id
  // (base64) never gets mistaken for a user id.
  function friendProfileId(node) {
    const numeric = (v) => (v && /^\d+$/.test(String(v)) ? String(v) : null);
    const actorId = state.actorId ? String(state.actorId) : null;

    // 1. Primary: the collection-item node.id is base64 of
    //    "app_item:<ourActorId>:<collection>:<n>::<friendId>". The friend's
    //    numeric id is the last segment. This is present on every edge.
    if (typeof node.id === "string" && /^[A-Za-z0-9+/=]+$/.test(node.id)) {
      try {
        const decoded = atob(node.id);
        if (decoded.indexOf("app_item") === 0) {
          const segs = decoded.split(":").filter(Boolean);
          const owner = segs[1]; // must be our own account for this to be trusted
          const last = segs[segs.length - 1];
          const ownerOk = !actorId || !owner || owner === actorId;
          // Must belong to our collection, be a plausible profile id, and NOT be
          // our own actor id — never risk unfriending the wrong person.
          if (ownerOk && numeric(last) && last !== actorId && last.length >= 8) return last;
        }
      } catch (e) {
        /* not base64 — fall through */
      }
    }

    // 2. The action target's profile_owner (definitively this friend).
    const viaAction =
      node.actions_renderer &&
      node.actions_renderer.action &&
      node.actions_renderer.action.profile_owner &&
      node.actions_renderer.action.profile_owner.id;
    if (numeric(viaAction) && numeric(viaAction) !== actorId) return numeric(viaAction);

    // 3. A profile.php?id= url. (NOT a generic User-node search — the edge's
    //    subtitle lists MUTUAL friends as User nodes, and grabbing one of those
    //    would unfriend the wrong person.)
    const m = (node.url || "").match(/profile\.php\?id=(\d+)/);
    return m ? m[1] : null;
  }

  // ------------------------------------------------------------- public ops

  // Paginate the friends collection. Yields raw friend records; the caller is
  // responsible for keying/deduping. Returns { ok, reason } — ok:false lets the
  // caller fall back to the DOM scan without losing anything.
  async function scanFriends({ token, onBatch, maxPages = 400 } = {}) {
    if (!state.boilerplate) return { ok: false, reason: "no-boilerplate" };
    const id = token || friendsToken();
    if (!id) return { ok: false, reason: "no-token" };

    // Base our variables on Facebook's own captured template (so every required
    // variable is present), overriding only id/count/cursor. Fall back to a
    // minimal set if no template was captured.
    const baseVars = friendsVariablesTemplate();
    log(
      "scanFriends: variable template",
      baseVars ? "captured — keys: " + Object.keys(baseVars).join(",") : "NOT captured; using minimal set"
    );
    // Override only keys that exist in Facebook's template so we never inject an
    // undeclared variable, and use whichever pagination key it uses.
    const varsFor = (cursor) => {
      if (!baseVars) return { id, count: 30, cursor, search: null };
      const v = { ...baseVars, id };
      if ("count" in v) v.count = 30;
      if ("cursor" in v) v.cursor = cursor;
      else if ("after" in v) v.after = cursor;
      else v.cursor = cursor;
      return v;
    };

    let cursor = null;
    let pages = 0;
    let total = 0;
    let loggedShape = false;
    for (;;) {
      const objects = await sendForged("user_friends", varsFor(cursor));
      const conn = findConnection(objects);
      const edges = (conn && conn.edges) || [];
      const pageInfo = (conn && conn.page_info) || {};

      // One-time check of the first edge: confirm we extract a numeric id and
      // whether the node carries a url (needed to key/merge with existing
      // vanity-keyed records).
      if (!loggedShape && edges.length) {
        loggedShape = true;
        const n0 = (edges[0] && edges[0].node) || {};
        log(
          "scanFriends: first edge — name:",
          (n0.title && n0.title.text) || "?",
          "| extracted id:",
          friendProfileId(n0),
          "| node.url:",
          n0.url || "(none)"
        );
      }

      const batch = [];
      for (const edge of edges) {
        const node = (edge && edge.node) || {};
        const url = node.url || null;
        const profileId = friendProfileId(node);
        const name = (node.title && node.title.text) || "";
        const photo =
          (node.image_v2 && node.image_v2.uri) || (node.image && node.image.uri) || "";
        if (!name && !profileId) continue;
        batch.push({ name, photo, url, profileId });
      }
      total += batch.length;
      if (batch.length && onBatch) await onBatch(batch, { total });

      pages++;
      const next = pageInfo.end_cursor || null;
      // Stop on last page, missing cursor, a cursor that didn't advance (guards
      // against a stuck loop), or the page cap.
      if (!pageInfo.has_next_page || !next || next === cursor || pages >= maxPages) break;
      cursor = next;
    }
    return { ok: true, total };
  }

  // Resolve a single friend's numeric id by searching the friends collection by
  // name (the `search` variable the query already supports). Reuses the exact
  // proven friends query, so it's as reliable as the scan and far cheaper than
  // scraping a 1 MB profile page. Prefers the result whose vanity URL matches.
  // Requires the collection token (be on the friends page). Returns id or null.
  async function searchFriendId({ name, vanity } = {}) {
    const token = friendsToken();
    if (!token) {
      log("searchFriendId: no collection token yet");
      return null;
    }
    const query = name || vanity;
    if (!query) return null;

    const base = friendsVariablesTemplate();
    const vars = base
      ? { ...base, id: token, count: 20, search: query }
      : { id: token, count: 20, cursor: null, search: query };
    if ("cursor" in vars) vars.cursor = null;

    let objects;
    try {
      objects = await sendForged("user_friends", vars);
    } catch (e) {
      warn("searchFriendId:", query, "search failed —", (e && e.message) || e);
      return null;
    }
    const conn = findConnection(objects);
    const edges = (conn && conn.edges) || [];

    // Require a DEFINITE match — an exact vanity or exact (case-insensitive) name.
    // We must never return an unverified "first result": unfriending is
    // irreversible, and Facebook's search can return near-matches for a query.
    const wantVanity = vanity ? vanity.toLowerCase() : null;
    const wantName = name ? name.trim().toLowerCase() : null;
    let byName = null;
    for (const edge of edges) {
      const node = (edge && edge.node) || {};
      const id = friendProfileId(node);
      if (!id) continue;
      const nodeVanity = (vanityFromUrl(node.url || "") || "").toLowerCase();
      const nodeName = ((node.title && node.title.text) || "").trim().toLowerCase();
      if (wantVanity && nodeVanity && nodeVanity === wantVanity) {
        log("searchFriendId:", query, "→", id, "(vanity match)");
        return id;
      }
      if (wantName && nodeName === wantName && !byName) byName = id;
    }
    if (byName) log("searchFriendId:", query, "→", byName, "(exact name match)");
    else log("searchFriendId:", query, "→ no definite match among", edges.length, "result(s)");
    return byName;
  }

  // Remove a single friend by numeric id. Returns { ok, error }.
  async function unfriend(unfriendedUserId) {
    if (!state.boilerplate) {
      warn("unfriend aborted: no boilerplate captured (browse Facebook first)");
      return { ok: false, error: "no boilerplate captured" };
    }
    if (!state.actorId) {
      warn("unfriend aborted: no actor id (own user id missing from boilerplate)");
      return { ok: false, error: "no actor id" };
    }
    if (!unfriendedUserId) {
      warn("unfriend aborted: no target id");
      return { ok: false, error: "no target id" };
    }
    log("unfriend", unfriendedUserId, "as actor", state.actorId);
    try {
      const objects = await sendForged("user_unfriend", {
        input: {
          source: "bd_profile_button",
          unfriended_user_id: String(unfriendedUserId),
          actor_id: String(state.actorId),
          client_mutation_id: "1",
        },
        scale: 2,
      });
      // sendForged already threw on any CRITICAL error, so a response carrying a
      // data payload means the mutation ran. We require the payload so an
      // empty/blocked response isn't mistaken for a removal.
      if (objects.some((o) => o && o.data)) {
        log("unfriend", unfriendedUserId, "→ ok");
        return { ok: true };
      }
      // No data payload — dig out whatever error Facebook gave (any severity),
      // and log the raw first object so a stale doc_id / bad variable is visible.
      const errs = allErrors(objects);
      const reason = errs.length
        ? errs[0].message || errs[0].summary || errs[0].code || JSON.stringify(errs[0])
        : "no data in response (possible stale doc_id or blocked action)";
      warn("unfriend", unfriendedUserId, "→ failed:", reason, "| first object:", JSON.stringify(objects[0] || null).slice(0, 400));
      return { ok: false, error: reason };
    } catch (e) {
      warn("unfriend", unfriendedUserId, "→ threw:", (e && e.message) || e);
      return { ok: false, error: (e && e.message) || String(e) };
    }
  }

  // Resolve a vanity profile (e.g. https://www.facebook.com/john.doe) to the
  // owner's numeric id by fetching the profile page and reading an
  // owner-specific marker out of the HTML. Used to backfill ids the friend scan
  // didn't capture, so removal doesn't dead-end. Only owner-specific patterns
  // are trusted (never the viewer's __user id) — unfriending a wrong id would be
  // worse than failing — and it returns null rather than guess.
  // Pull the vanity username out of a profile URL (…/john.doe → "john.doe").
  function vanityFromUrl(url) {
    try {
      const u = new URL(url, "https://www.facebook.com");
      const seg = u.pathname.split("/").filter(Boolean)[0] || "";
      return /^[A-Za-z0-9.\-]+$/.test(seg) ? seg : null;
    } catch (e) {
      return null;
    }
  }

  const reEscape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  async function resolveProfileId(url, name) {
    if (!url) return null;
    let text = "";
    try {
      const res = await rawFetch(url);
      text = res.text || "";
      log("resolveProfileId: fetched", url, "HTTP", res.status, "(" + text.length + " bytes)");
    } catch (e) {
      warn("resolveProfileId: fetch failed for", url, "-", (e && e.message) || e);
      return null;
    }
    if (!text) return null;

    const vanity = vanityFromUrl(url);

    // Ordered by confidence. The owner's User node holds the numeric id right
    // next to the person's name, so name-anchoring is the most reliable — the
    // vanity alone shows up in route params with no id nearby. Facebook stores
    // Relay references as {"__ref":"<id>"} and slash-escapes URLs in its JSON.
    const patterns = [];
    if (name) {
      const nesc = reEscape(name);
      patterns.push(new RegExp('"id":"(\\d+)"[\\s\\S]{0,240}?"name":"' + nesc + '"', "i"));
      patterns.push(new RegExp('"name":"' + nesc + '"[\\s\\S]{0,240}?"id":"(\\d+)"', "i"));
      patterns.push(new RegExp('"short_name":"[^"]*"[\\s\\S]{0,80}?"id":"(\\d+)"[\\s\\S]{0,240}?"' + nesc + '"', "i"));
    }
    if (vanity) {
      const vesc = reEscape(vanity);
      patterns.push(new RegExp('"vanity":"' + vesc + '"[\\s\\S]{0,240}?"id":"(\\d+)"', "i"));
      patterns.push(new RegExp('"id":"(\\d+)"[\\s\\S]{0,240}?"vanity":"' + vesc + '"', "i"));
      // owner's canonical url in a User node: …facebook.com\/name" or "url":"\/name"
      patterns.push(new RegExp('"id":"(\\d+)"[\\s\\S]{0,240}?(?:facebook\\.com)?\\\\?/' + vesc + '(?:\\\\?["?])', "i"));
    }
    // Relay-reference and structural fallbacks (owner-specific).
    patterns.push(/"profile_owner":\{"__ref":"(\d+)"/);
    patterns.push(/"profile_owner":\{[\s\S]{0,160}?"id":"(\d+)"/);
    patterns.push(/"__isProfile":"User"[\s\S]{0,160}?"id":"(\d+)"/);
    patterns.push(/fb:\\?\/\\?\/profile\\?\/(\d+)/);

    const actorId = state.actorId ? String(state.actorId) : null;
    for (const re of patterns) {
      const m = text.match(re);
      if (m && m[1]) {
        // Never return the viewer's own id — a wrong match must fail, not
        // unfriend the wrong person.
        if (actorId && m[1] === actorId) {
          log("resolveProfileId:", url, "matched viewer id via", re.source.slice(0, 30), "— rejecting");
          continue;
        }
        log("resolveProfileId:", url, "→", m[1], "(via", re.source.slice(0, 34) + "…)");
        return m[1];
      }
    }

    // Diagnostics: show the markup around the name (best anchor) and vanity.
    if (name) {
      const at = text.indexOf('"name":"' + name + '"');
      if (at >= 0) warn("resolveProfileId: context near name:", text.slice(Math.max(0, at - 260), at + 60));
      else warn("resolveProfileId: exact name", JSON.stringify(name), "not found (may be unicode-escaped in JSON)");
    }
    warn("resolveProfileId: no owner id found in", url);
    return null;
  }

  // ---------------------------------------------------- engagement (posts)

  // Known-good variables for the timeline refetch query (from FriendFilter). Any
  // captured live template is layered on top so a newly-required variable is
  // supplied automatically; we always set id/count/cursor last.
  const POSTS_VARS = {
    UFI2CommentsProvider_commentsKey: "ProfileCometTimelineRoute",
    afterTime: null,
    beforeTime: null,
    displayCommentsContextEnableComment: null,
    displayCommentsContextIsAdPreview: null,
    displayCommentsContextIsAggregatedShare: null,
    displayCommentsContextIsStorySet: null,
    displayCommentsFeedbackContext: null,
    feedLocation: "TIMELINE",
    feedbackSource: 0,
    focusCommentID: null,
    memorializedSplitTimeFilter: null,
    omitPinnedPost: true,
    postedBy: null,
    privacy: null,
    privacySelectorRenderLocation: "COMET_STREAM",
    renderLocation: "timeline",
    scale: 1.5,
    should_show_profile_pinned_post: true,
    stream_count: 1,
    taggedInOnly: null,
    useDefaultActor: false,
  };
  function postsVariables(id, cursor, count) {
    const tmpl = templateFor("ProfileCometTimelineFeedRefetchQuery", /TimelineFeedRefetchQuery/);
    return { ...POSTS_VARS, ...tmpl, id, cursor, count };
  }

  // Reactions dialog query. Template (if captured) supplies any extra required
  // variables; the known per-request fields are always set.
  function reactionsVariables(feedbackId, cursor, count) {
    const tmpl = templateFor("CometUFIReactionsDialogTabContentRefetchQuery", /UFIReactions.*Query/);
    return {
      ...tmpl,
      count,
      cursor,
      feedbackTargetID: feedbackId,
      id: feedbackId,
      reactionType: "NONE",
      scale: 2,
    };
  }

  // Comments pagination query.
  function commentsVariables(feedbackId, cursor) {
    const tmpl = templateFor("CometUFICommentsProviderPaginationQuery", /UFIComments.*Query/);
    return {
      ...tmpl,
      feedbackID: feedbackId,
      after: cursor,
      before: null,
      first: null,
      last: null,
      includeHighlightedComments: false,
      includeNestedComments: true,
      isComet: true,
      isInitialFetch: false,
      isPaginating: true,
      topLevelViewOption: null,
      viewOption: null,
    };
  }

  // Collapse a (multi-part) timeline response into { edges, page_info }.
  // Mirrors FriendFilter's parse_user_posts_glued_response: the User node
  // carries the first units + page_info; deferred parts each stream one story.
  function parsePosts(objects) {
    const result = { edges: [] };
    for (const obj of objects) {
      const data = obj && obj.data;
      if (!data) continue;
      if (data.page_info) {
        result.page_info = data.page_info;
      } else if (data.node && data.node.__typename === "User") {
        const tl = data.node.timeline_list_feed_units;
        if (tl) {
          if (tl.page_info && !result.page_info) result.page_info = tl.page_info;
          for (const ed of tl.edges || []) if (ed && ed.node) result.edges.push(ed.node);
        }
      } else if (data.node) {
        result.edges.push(data.node);
      }
    }
    return result;
  }

  // Pull the post's feedback id (needed to fetch reactions/comments) and its
  // creation time out of a story node.
  function beautifyPost(node) {
    const feedbackId = bfsFind(node, (n, p) => {
      if (typeof n.id !== "undefined" && p[p.length - 1] === "feedback") return n.id;
    });
    const story = bfsFind(node, (n, p) => {
      if ("url" in n && "creation_time" in n && "id" in n && !p.includes("attached_story"))
        return { url: n.url, creationTime: n.creation_time };
    });
    if (!story) return null;
    return {
      feedbackId,
      url: story.url,
      // creation_time is unix seconds; convert to ms (null if absent).
      atMs: typeof story.creationTime === "number" ? story.creationTime * 1000 : null,
    };
  }

  function engagerFromNode(node) {
    if (!node) return null;
    const url = node.url || null;
    const profileId = node.id || null;
    if (!url && !profileId) return null;
    return { profileId, url, name: node.name || "" };
  }

  // Paginate one post's reactors. Returns [{ profileId, url, name }], capped.
  async function getReactions(feedbackId, max) {
    const out = [];
    let cursor = null;
    let page = 0;
    for (;;) {
      if (page > 0) await sleep(600 + Math.random() * 600);
      const objects = await sendForged("user_reactions", reactionsVariables(feedbackId, cursor, 50));
      const reactors = findNodeByParentKey(objects, "reactors");
      const edges = (reactors && reactors.edges) || [];
      for (const edge of edges) {
        const e = engagerFromNode(edge && edge.node);
        if (e) out.push(e);
        if (out.length >= max) return out;
      }
      const pi = (reactors && reactors.page_info) || {};
      const next = pi.end_cursor || null;
      page++;
      // Stop if there's no next page, the cursor didn't advance, or we've paged
      // an unreasonable number of times (guards against a stuck cursor).
      if (!pi.has_next_page || !next || next === cursor || page >= 60) break;
      cursor = next;
    }
    return out;
  }

  // Paginate one post's top-level commenters. Returns [{ profileId, url, name }].
  async function getComments(feedbackId, max) {
    const out = [];
    let cursor = null;
    let page = 0;
    for (;;) {
      if (page > 0) await sleep(600 + Math.random() * 600);
      const objects = await sendForged("user_comments", commentsVariables(feedbackId, cursor));
      const comments = findNodeByParentKey(objects, "display_comments");
      const edges = (comments && comments.edges) || [];
      for (const edge of edges) {
        const e = engagerFromNode(edge && edge.node && edge.node.author);
        if (e) out.push(e);
        if (out.length >= max) return out;
      }
      const pi = (comments && comments.page_info) || {};
      const next = pi.end_cursor || null;
      page++;
      if (!pi.has_next_page || !next || next === cursor || page >= 60) break;
      cursor = next;
    }
    return out;
  }

  // Walk the user's own timeline back through a time window, fetching each
  // post's reactors and commenters via the API. `onPost({ feedbackId, atMs,
  // reactions, comments, postsScanned })` is called per post. Returns
  // { ok, reason, postsScanned }.
  async function scanEngagement({
    actorId,
    cutoffMs,
    maxPosts = 400,
    reactionsPerPost = 500,
    commentsPerPost = 200,
    onPost,
  } = {}) {
    if (!state.boilerplate) return { ok: false, reason: "no-boilerplate" };
    const id = actorId || state.actorId;
    if (!id) return { ok: false, reason: "no-actor-id" };

    let cursor = null;
    let pages = 0;
    let postsScanned = 0;
    let oldStreak = 0;
    for (;;) {
      const objects = await sendForged("user_posts", postsVariables(id, cursor, 5));
      const { edges, page_info: pageInfo } = parsePosts(objects);

      for (const node of edges) {
        const post = beautifyPost(node);
        if (!post || !post.feedbackId) continue;

        // Older than the window? Stop after a few in a row (a pinned/old post
        // near the top shouldn't end the scan early).
        if (post.atMs !== null && post.atMs < cutoffMs) {
          if (++oldStreak >= 3) return { ok: true, postsScanned };
          continue;
        }
        if (post.atMs !== null) oldStreak = 0;

        const reactions = await getReactions(post.feedbackId, reactionsPerPost);
        await sleep(500 + Math.random() * 700);
        const comments = await getComments(post.feedbackId, commentsPerPost);

        postsScanned++;
        if (onPost)
          await onPost({
            feedbackId: post.feedbackId,
            atMs: post.atMs,
            reactions,
            comments,
            postsScanned,
          });
        if (postsScanned >= maxPosts) return { ok: true, postsScanned };
        await sleep(800 + Math.random() * 800);
      }

      pages++;
      cursor = (pageInfo && pageInfo.end_cursor) || null;
      if (!pageInfo || !pageInfo.has_next_page || !cursor || pages >= maxPosts) break;
    }
    return { ok: true, postsScanned };
  }

  window.FriendSweepGraph = {
    hasBoilerplate,
    waitForReady,
    getActorId: () => state.actorId,
    getCollectionToken: collectionToken,
    getFriendsToken: friendsToken,
    scanFriends,
    searchFriendId,
    unfriend,
    resolveProfileId,
    scanEngagement,
  };
})();
