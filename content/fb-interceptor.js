// FriendSweep page-context interceptor.
//
// This runs in the page's MAIN world (see manifest: world "MAIN",
// run_at document_start) so it can see and use Facebook's own network stack —
// something the isolated content script cannot do. Its two jobs:
//
//   1. Capture "boilerplate": watch Facebook's own POSTs to /api/graphql and
//      keep the most recent request body. That body already contains every
//      session/auth token GraphQL needs (fb_dtsg, lsd, jazoest, __user, the
//      __spin_*/__rev/__hs machinery, …). We never have to parse or assemble
//      those ourselves — we clone a known-good request and swap doc_id +
//      variables. This is the core technique borrowed from FriendFilter.
//
//   2. Send forged requests on behalf of the isolated world. The isolated
//      scanner builds a request body and posts it here; we run the actual
//      fetch in page context (correct origin/referer, real cookies) and post
//      the response back. Routing the send through the page context — rather
//      than fetching from the content script — matches how Facebook expects
//      these requests to originate and avoids any cookie/CORS ambiguity.
//
// Communication with the isolated world is via window.postMessage. We only
// ever accept 'send' commands (which just relay to /api/graphql with the
// page's own credentials) — never anything that could touch the page's data
// or DOM — so the channel can't be abused to do more than the user's own
// FriendSweep scanner already does.

(() => {
  if (window.__friendSweepInterceptorLoaded) return;
  window.__friendSweepInterceptorLoaded = true;

  const CHANNEL = "friendsweep";
  const GRAPHQL_PATH = "/api/graphql";
  // Marker we stamp onto our own forged requests so the capture patch below
  // ignores them (otherwise we'd re-capture our own traffic as boilerplate).
  const SELF_MARK = "__fs_self";

  // Friendly names whose `variables.id` is a collection/pagination token worth
  // remembering (the friends list and the activity-log seed their pagination
  // from an opaque token that only Facebook's own first request knows).
  // Facebook renames these periodically (e.g. the own-friends list moved from
  // ProfileCometAppCollectionListRendererPaginationQuery to
  // ProfileCometAppCollectionSelfFriendsListRendererPaginationQuery), so we also
  // match any "…AppCollection…PaginationQuery" name structurally. Over-capturing
  // is harmless — tokens are stored per friendly name and only friends-list
  // names are ever read back.
  const TOKEN_FRIENDLY_NAMES = new Set([
    "ProfileCometAppCollectionListRendererPaginationQuery",
    "ProfileCometAppCollectionSelfFriendsListRendererPaginationQuery",
    "CometActivityLogStoriesListPaginationQuery",
  ]);
  const isTokenQuery = (name) =>
    TOKEN_FRIENDLY_NAMES.has(name) || /AppCollection.*PaginationQuery/.test(name || "");

  // Additional queries whose full `variables` object we want to capture as a
  // template (but which carry no collection token): the engagement queries. As
  // with the friends query, reusing Facebook's own variables means we don't have
  // to know which ones a persisted query requires — it self-heals if Facebook
  // adds a new required variable. Matched structurally too, to survive renames.
  const VARIABLE_TEMPLATE_NAMES = new Set([
    "ProfileCometTimelineFeedRefetchQuery",
    "CometUFIReactionsDialogTabContentRefetchQuery",
    "CometUFICommentsProviderPaginationQuery",
  ]);
  const wantsVariables = (name) =>
    isTokenQuery(name) ||
    VARIABLE_TEMPLATE_NAMES.has(name) ||
    /TimelineFeedRefetchQuery|UFIReactions.*Query|UFIComments.*Query/.test(name || "");

  let lastBoilerplateAt = 0;

  // Buffered state for replay. The isolated world (graph.js) loads later than
  // this MAIN-world script, so anything captured before it attaches its message
  // listener would be lost — postMessage is not buffered. We keep the latest
  // boilerplate and per-query doc_id/token/variables and replay them when
  // graph.js says "hello".
  let bufferedBoilerplate = null;
  const bufferedObserved = Object.create(null); // friendlyName -> {docId, collectionToken, variables}

  const DEBUG = window.__FRIENDSWEEP_DEBUG !== false;
  const log = (...a) => DEBUG && console.log("[FriendSweep/page]", ...a);
  const warn = (...a) => console.warn("[FriendSweep/page]", ...a);

  function post(msg) {
    try {
      window.postMessage({ __source: CHANNEL, ...msg }, window.location.origin);
    } catch (e) {
      /* postMessage should never throw for plain data, but never break FB */
    }
  }

  // Pull the interesting fields out of a form-encoded GraphQL body without
  // disturbing it. Returns null if it isn't a usable GraphQL request.
  function inspect(bodyString) {
    if (typeof bodyString !== "string" || !bodyString) return null;
    if (bodyString.indexOf(SELF_MARK) !== -1) return null; // our own request
    let params;
    try {
      params = new URLSearchParams(bodyString);
    } catch (e) {
      return null;
    }
    const friendlyName = params.get("fb_api_req_friendly_name");
    const docId = params.get("doc_id");
    if (!friendlyName || !docId) return null;

    let variables = null;
    try {
      variables = JSON.parse(params.get("variables") || "null");
    } catch (e) {
      /* leave variables null */
    }
    return { friendlyName, docId, variables };
  }

  // Report a captured request to the isolated world. doc_id + friendly_name
  // mappings are always forwarded (tiny, and they let us self-heal stale
  // doc_ids). The full body is forwarded at most every 3s — it's larger, and
  // any recent capture is equally valid since the tokens are session-wide.
  function onCaptured(bodyString) {
    const info = inspect(bodyString);
    if (!info) return;

    const tokenQuery = isTokenQuery(info.friendlyName);
    const collectionToken = info.variables && tokenQuery ? info.variables.id : undefined;

    // Forward Facebook's OWN full variables object as a template for any query we
    // forge (friends + engagement). Reusing it means we never have to know which
    // variables a persisted query requires — the same reason we clone the auth
    // boilerplate rather than assembling it.
    const variables = wantsVariables(info.friendlyName) ? info.variables : undefined;

    // Buffer for replay — queries whose token/variables graph.js needs to seed
    // an operation, plus the latest boilerplate. Other queries' doc_ids self-heal
    // from live traffic and don't need replay.
    if (variables || collectionToken) {
      const prev = bufferedObserved[info.friendlyName] || {};
      bufferedObserved[info.friendlyName] = {
        docId: info.docId,
        collectionToken: collectionToken || prev.collectionToken,
        variables: variables || prev.variables,
      };
    }
    bufferedBoilerplate = bodyString;

    // Small, always-forwarded metadata message.
    post({
      kind: "observed",
      friendlyName: info.friendlyName,
      docId: info.docId,
      collectionToken,
      variables,
    });

    const now = Date.now();
    if (now - lastBoilerplateAt >= 3000) {
      lastBoilerplateAt = now;
      post({ kind: "boilerplate", body: bodyString });
    }
  }

  // Replay buffered state to the isolated world (on its "hello" handshake).
  function replayBuffered() {
    let tokens = 0;
    for (const name in bufferedObserved) {
      const o = bufferedObserved[name];
      post({
        kind: "observed",
        friendlyName: name,
        docId: o.docId,
        collectionToken: o.collectionToken,
        variables: o.variables,
      });
      if (o.collectionToken) tokens++;
    }
    if (bufferedBoilerplate) post({ kind: "boilerplate", body: bufferedBoilerplate });
    log("replayed buffered state on hello:", Object.keys(bufferedObserved).length, "queries,", tokens, "token(s), boilerplate:", !!bufferedBoilerplate);
  }

  // ---------------------------------------------------------- fetch patch
  const originalFetch = window.fetch;
  if (typeof originalFetch === "function") {
    window.fetch = function (input, init) {
      try {
        let method = (init && init.method) || "GET";
        let url;
        if (input && typeof input === "object" && typeof input.url === "string") {
          if (!(init && init.method)) method = input.method || "GET";
          url = input.url;
        } else {
          url = String(input);
        }
        const path = new URL(url, location.href).pathname;
        if (method.toUpperCase() === "POST" && path.indexOf(GRAPHQL_PATH) === 0) {
          let body = init && init.body != null ? init.body : null;
          if (typeof body === "string") onCaptured(body);
          else if (typeof URLSearchParams !== "undefined" && body instanceof URLSearchParams)
            onCaptured(body.toString());
        }
      } catch (e) {
        /* observation only — never break the page's fetch */
      }
      return originalFetch.apply(this, arguments);
    };
  }

  // ---------------------------------------------------------- XHR patch
  const proto = window.XMLHttpRequest && window.XMLHttpRequest.prototype;
  if (proto) {
    const origOpen = proto.open;
    const origSend = proto.send;
    proto.open = function (method, url) {
      this.__fsMeta = { method: method, url: url };
      return origOpen.apply(this, arguments);
    };
    proto.send = function (data) {
      try {
        const meta = this.__fsMeta || {};
        const path = meta.url ? new URL(meta.url, location.href).pathname : "";
        if (
          meta.method &&
          meta.method.toUpperCase() === "POST" &&
          path.indexOf(GRAPHQL_PATH) === 0 &&
          typeof data === "string"
        ) {
          onCaptured(data);
        }
      } catch (e) {
        /* observation only */
      }
      return origSend.apply(this, arguments);
    };
  }

  // ---------------------------------------------------- run-on-behalf
  // The isolated scanner asks us to run a request in page context (correct
  // origin/referer, real cookies) and post the response back, keyed by id:
  //   kind "send"      → POST a forged GraphQL body to /api/graphql/
  //   kind "fetchText" → GET an arbitrary same-origin URL (e.g. a profile page)
  window.addEventListener("message", (event) => {
    // Identify by the private marker + same origin, not an `event.source ===
    // window` identity check (unreliable across the isolated/MAIN boundary).
    if (event.origin !== window.location.origin) return;
    const data = event.data;
    if (!data || data.__source !== CHANNEL) return;
    if (data.kind === "hello") {
      replayBuffered();
      return;
    }
    if (data.kind !== "send" && data.kind !== "fetchText") return;

    const { id, body, url, kind } = data;

    (async () => {
      if (typeof originalFetch !== "function") {
        warn("cannot run", id, "— window.fetch was not a function at load time");
        post({ kind: "sendResult", id, ok: false, error: "no fetch available in page" });
        return;
      }
      try {
        let res;
        if (kind === "fetchText") {
          log("fetching", id, "→ GET", url);
          res = await originalFetch.call(window, url, { credentials: "include" });
        } else {
          log("sending forged request", id, "→ POST", GRAPHQL_PATH + "/");
          res = await originalFetch.call(window, GRAPHQL_PATH + "/", {
            method: "POST",
            credentials: "include",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body,
          });
        }
        const text = await res.text();
        log("request", id, "← HTTP", res.status, "(" + text.length + " bytes)");
        post({ kind: "sendResult", id, ok: true, status: res.status, text });
      } catch (e) {
        warn("request", id, "fetch threw:", (e && e.message) || e);
        post({
          kind: "sendResult",
          id,
          ok: false,
          error: (e && e.message) || String(e),
        });
      }
    })();
  });

  // Let the isolated world know the bridge is live (so it can distinguish
  // "MAIN world never loaded" from "loaded but Facebook fired nothing yet").
  log("page interceptor loaded (MAIN world); fetch patched =", typeof originalFetch === "function");
  post({ kind: "ready" });
})();
