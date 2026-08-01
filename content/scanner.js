// FriendSweep content script.
// Runs on facebook.com. On load it asks the background worker whether a job
// is assigned to this tab, then executes it: scanning the friends list,
// scanning timeline engagement, or performing a single unfriend.
//
// Facebook's DOM is obfuscated and changes regularly, so every lookup here
// uses role/aria attributes and visible text (English UI) with fallbacks.

(() => {
  if (window.__friendSweepLoaded) return;
  window.__friendSweepLoaded = true;

  let aborted = false;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const jitter = (min, max) => min + Math.random() * (max - min);

  const DEBUG = window.__FRIENDSWEEP_DEBUG !== false;
  const log = (...a) => DEBUG && console.log("[FriendSweep/scan]", ...a);
  const warn = (...a) => console.warn("[FriendSweep/scan]", ...a);

  // ------------------------------------------------------------- HUD

  let hud = null;
  function showHud(text) {
    if (!hud) {
      hud = document.createElement("div");
      hud.className = "friendsweep-hud";
      document.documentElement.appendChild(hud);
    }
    hud.textContent = "FriendSweep — " + text;
  }
  function hideHud() {
    if (hud) hud.remove();
    hud = null;
  }

  // ------------------------------------------------------------- helpers

  const PROFILE_PATH_BLACKLIST = new Set([
    "friends", "photos", "photo", "videos", "watch", "groups", "gaming",
    "marketplace", "events", "pages", "stories", "story", "reel", "reels",
    "me", "messages", "notifications", "search", "settings", "bookmarks",
    "memories", "fundraisers", "saved", "help", "policies", "privacy",
    "business", "ads", "games", "live", "places", "media", "hashtag",
    "sharer.php", "dialog", "login", "recover", "checkpoint", "l.php",
    "people", "public", "directory", "pg", "profile.php",
  ]);

  // Normalize any facebook link into a canonical profile key, or null if it
  // isn't a profile link. Keys look like "id:123456" or "u:john.doe".
  function profileKeyFromHref(href) {
    let u;
    try {
      u = new URL(href, location.origin);
    } catch (e) {
      return null;
    }
    if (!/(^|\.)facebook\.com$/.test(u.hostname)) return null;

    if (u.pathname === "/profile.php") {
      const id = u.searchParams.get("id");
      return id ? { key: "id:" + id, url: "https://www.facebook.com/profile.php?id=" + id } : null;
    }
    const segs = u.pathname.split("/").filter(Boolean);
    if (segs.length !== 1) return null;
    const seg = segs[0];
    if (PROFILE_PATH_BLACKLIST.has(seg.toLowerCase())) return null;
    if (!/^[A-Za-z0-9.\-]+$/.test(seg)) return null;
    return { key: "u:" + seg.toLowerCase(), url: "https://www.facebook.com/" + seg };
  }

  function visibleText(el) {
    return (el.textContent || "").replace(/\s+/g, " ").trim();
  }

  // Find clickable elements by role + exact/regex text or aria-label.
  function findByText(root, roles, matcher) {
    const sel = roles.map((r) => `[role="${r}"]`).join(",");
    const test = (s) =>
      typeof matcher === "string"
        ? s.toLowerCase() === matcher.toLowerCase()
        : matcher.test(s);
    for (const el of root.querySelectorAll(sel)) {
      const label = el.getAttribute("aria-label") || "";
      const text = visibleText(el);
      if ((label && test(label)) || (text && text.length < 80 && test(text))) {
        return el;
      }
    }
    return null;
  }

  async function waitFor(fn, timeoutMs = 10000, pollMs = 300) {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      if (aborted) throw new Error("aborted");
      const v = fn();
      if (v) return v;
      await sleep(pollMs);
    }
    return null;
  }

  function realClick(el) {
    el.scrollIntoView({ block: "center" });
    for (const type of ["mousedown", "mouseup", "click"]) {
      el.dispatchEvent(
        new MouseEvent(type, { bubbles: true, cancelable: true, view: window })
      );
    }
  }

  function send(msg) {
    return chrome.runtime.sendMessage(msg).catch(() => null);
  }

  // ------------------------------------------------------------- friend scan

  // Anchor texts that point at a profile but are NOT the person's name:
  // the "N mutual friends" link, follower counts, action buttons, etc.
  const NAME_NOISE_RE =
    /^(\d[\d,.]*\s+mutual friends?|\d[\d,.]*\s+(followers?|friends|following)|mutual friends?|follow|following|add friend|message|friends|unfriend|see all|view profile)$/i;

  function isValidName(t) {
    return (
      !!t && t.length > 1 && t.length < 60 && !NAME_NOISE_RE.test(t.trim()) &&
      !/^\d[\d,.]*$/.test(t.trim()) // bare numbers are never names
    );
  }

  function extractFriends(selfUrl) {
    const root = document.querySelector('[role="main"]') || document.body;
    const byKey = new Map();
    for (const a of root.querySelectorAll("a[href]")) {
      const prof = profileKeyFromHref(a.href);
      if (!prof) continue;
      if (selfUrl && prof.url === selfUrl) continue;
      const entry = byKey.get(prof.key) || { ...prof, name: "", photo: "" };
      const img = a.querySelector("img");
      if (img) {
        if (!entry.photo) entry.photo = img.src || "";
        const alt = (img.alt || "").trim();
        if (!entry.name && isValidName(alt)) entry.name = alt;
      }
      // The name anchor is short plain text; the first valid candidate wins
      // (avatar alt is checked above, name link next, noise links rejected).
      const text = visibleText(a);
      if (!entry.name && isValidName(text)) entry.name = text;
      byKey.set(prof.key, entry);
    }
    // Drop obvious non-friend links that slipped through (no name at all).
    return [...byKey.values()].filter((f) => f.name);
  }

  // Map a GraphQL friend record ({ name, photo, url, profileId }) onto the same
  // canonical key the DOM scan uses, so records from either path merge cleanly.
  function keyForGraphFriend(rec) {
    if (rec.url) {
      const p = profileKeyFromHref(rec.url);
      if (p) return p;
    }
    if (rec.profileId) {
      return {
        key: "id:" + rec.profileId,
        url: "https://www.facebook.com/profile.php?id=" + rec.profileId,
      };
    }
    return null;
  }

  // Fast path: list the entire friends collection through Facebook's own
  // GraphQL API (cursor pagination, no scrolling). Returns true on success;
  // false hands control back to the DOM scroll-scan below with nothing lost.
  async function runFriendScanGraph(selfUrl) {
    const G = window.FriendSweepGraph;
    if (!G) {
      warn("friend scan: graph client not present — using DOM scan");
      return false;
    }

    showHud("scanning friends (fast API mode)… don't touch this tab");
    if (!(await G.waitForReady(12000))) {
      warn("friend scan: no boilerplate captured within 12s — using DOM scan");
      return false;
    }

    // The friends collection paginates from an opaque token that only
    // Facebook's own pagination request reveals. Nudge the page to fire one by
    // scrolling, then read the token the interceptor captured (any friends-list
    // pagination query variant).
    let token = G.getFriendsToken();
    for (let i = 0; i < 10 && !token; i++) {
      if (aborted) return false;
      window.scrollTo(0, document.body.scrollHeight);
      await sleep(jitter(900, 1600));
      token = G.getFriendsToken();
    }
    if (!token) {
      warn("friend scan: never captured the friends collection token — using DOM scan (this means removals won't get numeric ids from the API path)");
      return false;
    }
    log("friend scan: using API path with collection token");

    const byKey = new Map();
    const snapshot = () =>
      [...byKey.values()].filter((f) => f.name || f.profileId);

    let result;
    try {
      result = await G.scanFriends({
        token,
        onBatch: async (batch) => {
          if (aborted) throw new Error("aborted");
          // Collect only THIS page's entries to stream (not the whole cumulative
          // list each time — that is O(n²) for large friend lists). The
          // background upserts by key, so partial updates are safe.
          const pageEntries = [];
          for (const rec of batch) {
            const k = keyForGraphFriend(rec);
            if (!k) continue;
            if (selfUrl && k.url === selfUrl) continue;
            const entry = byKey.get(k.key) || { ...k, name: "", photo: "" };
            if (!entry.name && isValidName(rec.name)) entry.name = rec.name;
            if (!entry.photo && rec.photo) entry.photo = rec.photo;
            if (rec.profileId) entry.profileId = String(rec.profileId);
            byKey.set(k.key, entry);
            pageEntries.push(entry);
          }
          showHud(`scanning friends (fast API mode)… ${byKey.size} found`);
          if (pageEntries.length)
            await send({ cmd: "friendScanResult", friends: pageEntries, phase: "all", done: false });
        },
      });
    } catch (e) {
      if (e && e.message === "aborted") return true; // aborted: nothing more to do
      warn("friend scan: API pagination failed — using DOM scan:", (e && e.message) || e);
      return false; // any API failure → fall back to DOM
    }
    if (!result || !result.ok) return false;

    const friends = snapshot();
    if (!friends.length) return false; // empty API result is suspicious; use DOM
    const withId = friends.filter((f) => f.profileId).length;
    log("friend scan: captured", friends.length, "friends via API,", withId, "with numeric ids");
    await send({ cmd: "friendScanResult", friends, phase: "all", done: true });
    showHud(`${friends.length} friends captured via API — now capturing friend order…`);
    await sleep(3000);
    hideHud();
    return true;
  }

  async function runFriendScan(selfUrl, phase) {
    // The full-list phase can use the fast GraphQL path; the "recent order"
    // phase relies on the Recently-Added tab's DOM ordering, so it stays below.
    if (phase !== "recent") {
      try {
        if (await runFriendScanGraph(selfUrl)) return;
      } catch (e) {
        if (e && e.message === "aborted") return;
        // fall through to the DOM scan
      }
    }

    const what =
      phase === "recent" ? "capturing friend order (recently added)" : "scanning friends";
    showHud(`${what}… don't touch this tab`);
    let stableRounds = 0;
    let lastCount = 0;
    let lastHeight = 0;

    while (stableRounds < 6) {
      if (aborted) return;
      window.scrollTo(0, document.body.scrollHeight);
      await sleep(jitter(1200, 2200));

      const friends = extractFriends(selfUrl);
      if (friends.length !== lastCount) {
        await send({ cmd: "friendScanResult", friends, phase, done: false });
      }
      showHud(`${what}… ${friends.length} found`);

      const h = document.body.scrollHeight;
      if (friends.length === lastCount && h === lastHeight) stableRounds++;
      else stableRounds = 0;
      lastCount = friends.length;
      lastHeight = h;
    }

    const friends = extractFriends(selfUrl);
    await send({ cmd: "friendScanResult", friends, phase, done: true });
    if (phase === "recent") {
      showHud(`done — friend order captured for ${friends.length} friends. You can close this tab.`);
    } else {
      showHud(`${friends.length} friends captured — now capturing friend order…`);
    }
    await sleep(4000);
    hideHud();
  }

  // ------------------------------------------------------------- friend dates
  // Parses the Activity Log (category FRIENDS), which lists entries like
  // "Christopher Fern became friends with Fred Smith." grouped under date
  // headers ("July 22, 2026"). This yields real friendship dates.

  const DATE_HEADER_RE =
    /^(January|February|March|April|May|June|July|August|September|October|November|December) \d{1,2}, \d{4}$/;

  function collectDateHeaders(root) {
    const headers = [];
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    for (const el of root.querySelectorAll("h1,h2,h3,h4,span,div")) {
      if (el.firstElementChild) continue; // innermost text holders only
      const t = visibleText(el);
      if (!t || t.length > 40) continue;
      let ts = null;
      if (DATE_HEADER_RE.test(t)) {
        const d = new Date(t);
        if (!isNaN(d)) ts = d.getTime();
      } else if (/^today$/i.test(t)) {
        ts = today.getTime();
      } else if (/^yesterday$/i.test(t)) {
        ts = today.getTime() - 86400000;
      }
      if (ts !== null) headers.push({ el, ts });
    }
    return headers; // already in document order
  }

  function extractFriendDates(seenRows) {
    const root = document.querySelector('[role="main"]') || document.body;
    const headers = collectDateHeaders(root);
    const entries = [];

    for (const el of root.querySelectorAll("div,span,li")) {
      const text = el.textContent || "";
      if (!/became friends with/i.test(text)) continue;
      // Only the innermost element holding the sentence.
      let minimal = true;
      for (const c of el.children) {
        if (/became friends with/i.test(c.textContent || "")) {
          minimal = false;
          break;
        }
      }
      if (!minimal || seenRows.has(el)) continue;

      const m = visibleText(el).match(/became friends with (.+?)\.?$/i);
      if (!m) continue;
      const friendName = m[1].trim();
      if (!friendName || friendName.length > 80) continue;

      // Date = nearest header above this row.
      let ts = null;
      for (const h of headers) {
        if (h.el.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) ts = h.ts;
        else break;
      }
      if (ts === null) continue;

      // Try to resolve the friend's profile link: an anchor in the row (or
      // its enclosing card) whose text or avatar alt matches the name.
      let prof = null;
      const card = el.closest('div[role="article"]') || el.parentElement || el;
      for (const a of card.querySelectorAll("a[href]")) {
        const p = profileKeyFromHref(a.href);
        if (!p) continue;
        const label =
          visibleText(a) || (a.querySelector("img") && a.querySelector("img").alt) || "";
        if (label.trim() === friendName) {
          prof = p;
          break;
        }
      }

      seenRows.add(el);
      entries.push({
        key: prof ? prof.key : null,
        url: prof ? prof.url : null,
        name: friendName,
        friendedAt: ts,
      });
    }
    return entries;
  }

  async function runFriendDatesScan() {
    showHud("scanning friendship dates… don't touch this tab");
    const seenRows = new WeakSet();
    let total = 0;
    let stableRounds = 0;
    let lastHeight = 0;

    while (stableRounds < 6) {
      if (aborted) return;
      window.scrollTo(0, document.body.scrollHeight);
      await sleep(jitter(1400, 2400));

      const entries = extractFriendDates(seenRows);
      if (entries.length) {
        total += entries.length;
        await send({ cmd: "friendDatesResult", entries, done: false });
      }
      showHud(`scanning friendship dates… ${total} dated`);

      const h = document.body.scrollHeight;
      if (!entries.length && h === lastHeight) stableRounds++;
      else stableRounds = 0;
      lastHeight = h;
    }

    await send({ cmd: "friendDatesResult", entries: [], done: true });
    showHud(`done — ${total} friendship dates captured. You can close this tab.`);
    await sleep(4000);
    hideHud();
  }

  // ------------------------------------------------------------- engagement

  function getPostArticles() {
    // Top-level posts. Comments are also role="article" but carry an
    // aria-label starting with "Comment", so exclude those.
    let posts = [...document.querySelectorAll("div[aria-posinset]")];
    if (!posts.length) {
      posts = [...document.querySelectorAll('div[role="article"]')].filter((el) => {
        const label = el.getAttribute("aria-label") || "";
        if (/^comment/i.test(label)) return false;
        return !el.parentElement.closest('div[role="article"]');
      });
    }
    return posts;
  }

  function postIdOf(post) {
    for (const a of post.querySelectorAll("a[href]")) {
      const href = a.href;
      const m =
        href.match(/\/posts\/([\w:]+)/) ||
        href.match(/story_fbid=([\w:]+)/) ||
        href.match(/fbid=(\d+)/) ||
        href.match(/\/(?:videos|reel)\/(\d+)/);
      if (m) return m[1];
    }
    // Fallback: stable-ish hash of the post's text.
    const t = visibleText(post).slice(0, 200);
    let h = 0;
    for (let i = 0; i < t.length; i++) h = ((h << 5) - h + t.charCodeAt(i)) | 0;
    return "hash:" + (h >>> 0).toString(36);
  }

  // Parse Facebook's timestamp strings: "5m", "3h", "2d", "1w", "Yesterday",
  // "June 5", "June 5 at 4:30 PM", "May 12, 2025". Returns ms or null.
  function parseFbTimestamp(s) {
    if (!s) return null;
    s = s.replace(/ /g, " ").replace(/\s+/g, " ").trim();
    let m;
    if (/^just now$/i.test(s)) return Date.now();
    if ((m = s.match(/^(\d+)\s*(?:m|min|mins|minutes?)( ago)?$/i)))
      return Date.now() - m[1] * 60000;
    if ((m = s.match(/^(\d+)\s*(?:h|hrs?|hours?)( ago)?$/i)))
      return Date.now() - m[1] * 3600000;
    if ((m = s.match(/^(\d+)\s*(?:d|days?)( ago)?$/i)))
      return Date.now() - m[1] * 86400000;
    if ((m = s.match(/^(\d+)\s*(?:w|wks?|weeks?)( ago)?$/i)))
      return Date.now() - m[1] * 7 * 86400000;
    if ((m = s.match(/^(\d+)\s*(?:y|yrs?|years?)( ago)?$/i)))
      return Date.now() - m[1] * 365 * 86400000;
    if (/^yesterday\b/i.test(s)) return Date.now() - 86400000;

    // Absolute dates. Strip the "at 4:30 PM" part; day precision is enough.
    const cleaned = s.replace(/\s+at\s+.+$/i, "");
    if (!/^[A-Z][a-z]+ \d{1,2}(, \d{4})?$/.test(cleaned)) return null;
    const hasYear = /\d{4}/.test(cleaned);
    const d = new Date(hasYear ? cleaned : `${cleaned}, ${new Date().getFullYear()}`);
    if (isNaN(d)) return null;
    let ts = d.getTime();
    // "June 5" with no year that lands in the future means last year.
    if (!hasYear && ts > Date.now() + 86400000) {
      const prev = new Date(`${cleaned}, ${new Date().getFullYear() - 1}`);
      if (!isNaN(prev)) ts = prev.getTime();
    }
    return ts;
  }

  function postDateOf(post) {
    // The timestamp is the permalink anchor. Its aria-label is usually the
    // cleanest source; innerText skips the hidden junk spans Facebook
    // injects into timestamp text to deter scraping.
    const candidates = [];
    for (const a of post.querySelectorAll("a[href]")) {
      if (!/\/posts\/|story_fbid=|fbid=|\/videos\/|\/reel\//.test(a.href)) continue;
      const label = a.getAttribute("aria-label");
      if (label) candidates.push(label);
      const t = (a.innerText || "").trim();
      if (t && t.length < 40) candidates.push(t);
    }
    for (const c of candidates) {
      const ts = parseFbTimestamp(c);
      if (ts !== null) return ts;
    }
    return null;
  }

  function collectProfileKeys(root, selfUrl, out) {
    for (const a of root.querySelectorAll("a[href]")) {
      const prof = profileKeyFromHref(a.href);
      if (!prof || (selfUrl && prof.url === selfUrl)) continue;
      out.add(prof.key);
    }
  }

  // ------------------------------------------------------------- dialogs
  // Opening the reaction list is the flakiest step: a mis-aimed click can
  // land on Comment/Share and pop a composer instead, and Facebook sometimes
  // leaves a dialog mounted after we ask it to close. If a stray modal is
  // left open it overlays the feed, blocks scrolling, and the scan stalls a
  // few dozen posts in. These helpers make open/close explicit and verified.

  const openDialogs = () => [...document.querySelectorAll('div[role="dialog"]')];

  function pressEscape() {
    for (const target of [document.activeElement, document.body, document]) {
      if (!target) continue;
      target.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Escape",
          code: "Escape",
          keyCode: 27,
          which: 27,
          bubbles: true,
          cancelable: true,
        })
      );
    }
  }

  function closeDialogOnce(dialog) {
    const close =
      dialog.querySelector('div[aria-label="Close"][role="button"]') ||
      dialog.querySelector('[aria-label="Close"][role="button"]') ||
      findByText(dialog, ["button"], /^close$/i);
    if (close) realClick(close);
    else pressEscape();
  }

  // Close every open dialog and wait until the DOM is actually clear. If a
  // composer was opened by accident, closing it raises a "Discard post?"
  // confirm — accept that too so nothing is left hanging.
  async function dismissAnyDialog() {
    for (let attempt = 0; attempt < 5; attempt++) {
      const dialogs = openDialogs();
      if (!dialogs.length) return true;
      for (const d of dialogs) closeDialogOnce(d);
      await sleep(jitter(300, 600));
      const discard = findByText(
        document,
        ["button"],
        /^(discard|discard post|leave page|leave|delete)$/i
      );
      if (discard) {
        realClick(discard);
        await sleep(jitter(300, 600));
      }
    }
    return openDialogs().length === 0;
  }

  // The share/create-post composer carries an editable body and a
  // create/share-ish label; the reactions list and post permalink dialogs
  // do not. We must never scrape or get stuck on a composer.
  function isComposerDialog(dialog) {
    const label = (dialog.getAttribute("aria-label") || "").toLowerCase();
    if (!/create|share|write|say something|post to|new post/.test(label)) return false;
    return !!dialog.querySelector('[role="textbox"],[contenteditable="true"]');
  }

  // Pick the "see who reacted" control without ever grabbing the
  // Like/Comment/Share action bar (clicking those opens the wrong thing).
  const ACTION_LABEL_RE = /^(like|love|comment|share|send|reply|save)$/i;
  function findReactionButton(post) {
    const specific =
      post.querySelector('[aria-label*="reacted" i][role="button"]') ||
      post.querySelector('span[aria-label*="reacted" i]') ||
      findByText(post, ["button"], /see who reacted/i);
    if (specific) return specific;
    // Last resort: the reaction-count summary ("You and 5 others"). Reject it
    // if it's actually an action button so we don't trip a composer.
    const cand = findByText(
      post,
      ["button"],
      /^(you|[\d,.]+[km]?)( and [\d,.]+[km]? others?)?$/i
    );
    if (!cand) return null;
    const label = (cand.getAttribute("aria-label") || "").trim();
    if (ACTION_LABEL_RE.test(label) || ACTION_LABEL_RE.test(visibleText(cand))) return null;
    return cand;
  }

  async function collectReactions(post, selfUrl) {
    const keys = new Set();

    // Clear any modal a previous post may have left mounted before we open a
    // new one — otherwise the stale dialog gets scraped/scrolled instead.
    await dismissAnyDialog();

    const btn = findReactionButton(post);
    if (!btn) return keys;

    const before = openDialogs();
    realClick(btn);

    // Wait for a dialog that wasn't already present, so we never latch onto a
    // leftover modal.
    const dialog = await waitFor(() => {
      const fresh = openDialogs().filter((d) => !before.includes(d));
      return fresh[0] || null;
    }, 6000);
    if (!dialog) {
      await dismissAnyDialog();
      return keys;
    }

    // A mis-click opened the share/comment composer, not the reaction list —
    // back out cleanly and skip this post's reactions.
    if (isComposerDialog(dialog)) {
      await dismissAnyDialog();
      return keys;
    }

    // Scroll the reactions list a few times to load more names.
    for (let i = 0; i < 8; i++) {
      if (aborted) break;
      collectProfileKeys(dialog, selfUrl, keys);
      const scrollable = [...dialog.querySelectorAll("div")].find(
        (d) => d.scrollHeight > d.clientHeight + 50
      );
      if (!scrollable) break;
      const at = scrollable.scrollTop;
      scrollable.scrollTop = scrollable.scrollHeight;
      await sleep(jitter(700, 1200));
      if (scrollable.scrollTop === at) break;
    }
    collectProfileKeys(dialog, selfUrl, keys);

    // Verified close — don't move on until the modal is gone.
    await dismissAnyDialog();
    return keys;
  }

  async function collectCommenters(post, selfUrl) {
    const keys = new Set();
    // Expand a couple of "View more comments" rounds.
    for (let i = 0; i < 3; i++) {
      const more = findByText(
        post,
        ["button"],
        /view (\d[\d,]* )?(more |previous )?comments?/i
      );
      if (!more) break;
      realClick(more);
      await sleep(jitter(900, 1500));
    }
    const comments = post.querySelectorAll('div[role="article"][aria-label^="Comment" i]');
    for (const c of comments) {
      collectProfileKeys(c, selfUrl, keys);
    }
    return keys;
  }

  // Fast path: read timeline posts and each post's reactors/commenters through
  // Facebook's GraphQL API instead of opening reaction dialogs and expanding
  // comment threads in the DOM. Returns true on success; false falls back to
  // the DOM walk below. Emits the same engagementResult messages, so the
  // background handler and dashboard are unchanged — feedbackId serves as the
  // stable postId.
  async function runEngagementScanGraph(job, selfUrl) {
    const G = window.FriendSweepGraph;
    if (!G) return false;

    const days = job.days || 30;
    const cutoff = Date.now() - days * 86400000;
    showHud(`scanning engagement (last ${days} days, fast API mode)… don't touch this tab`);
    if (!(await G.waitForReady(12000))) return false;
    if (!G.getActorId()) return false;

    let totalEvents = 0;
    let result;
    try {
      result = await G.scanEngagement({
        cutoffMs: cutoff,
        maxPosts: job.maxPosts || 400,
        onPost: async ({ feedbackId, atMs, reactions, comments, postsScanned }) => {
          if (aborted) throw new Error("aborted");
          const at = atMs !== null ? atMs : Date.now();
          const events = [];
          const seenEvent = new Set();
          const add = (rec, type) => {
            const k = keyForGraphFriend({ url: rec.url, profileId: rec.profileId });
            if (!k) return;
            if (selfUrl && k.url === selfUrl) return;
            const dedup = k.key + "|" + type;
            if (seenEvent.has(dedup)) return;
            seenEvent.add(dedup);
            events.push({ postId: feedbackId, friendKey: k.key, type, at });
          };
          for (const r of reactions) add(r, "reaction");
          for (const c of comments) add(c, "comment");
          totalEvents += events.length;
          showHud(
            `scanning engagement (fast API mode)… ${postsScanned} posts, ${totalEvents} events (back to ${new Date(cutoff).toLocaleDateString()})`
          );
          await send({ cmd: "engagementResult", events, postsScanned, done: false });
        },
      });
    } catch (e) {
      if (e && e.message === "aborted") return true;
      return false; // any API failure → fall back to the DOM walk
    }
    if (!result || !result.ok) return false;

    await send({ cmd: "engagementResult", events: [], postsScanned: result.postsScanned, done: true });
    showHud(
      `done — scanned ${result.postsScanned} posts via API (${totalEvents} engagement events). You can close this tab.`
    );
    await sleep(4000);
    hideHud();
    return true;
  }

  async function runEngagementScan(job, selfUrl) {
    try {
      if (await runEngagementScanGraph(job, selfUrl)) return;
    } catch (e) {
      if (e && e.message === "aborted") return;
      // fall through to the DOM walk
    }

    const days = job.days || 30;
    const cutoff = Date.now() - days * 86400000;
    const maxPosts = job.maxPosts || 400; // safety cap only
    const seen = new Set();
    let postsScanned = 0;
    let idleRounds = 0;
    let oldStreak = 0; // consecutive posts older than the window
    let reachedEnd = false;

    showHud(`scanning engagement (last ${days} days)… don't touch this tab`);

    while (!reachedEnd && postsScanned < maxPosts && idleRounds < 6) {
      if (aborted) return;
      const posts = getPostArticles().filter((p) => !seen.has(p));
      if (!posts.length) {
        // A modal left open by the previous round would overlay the feed and
        // stop new posts from loading — make sure we're clear before scrolling.
        await dismissAnyDialog();
        window.scrollTo(0, document.body.scrollHeight);
        await sleep(jitter(1500, 2500));
        idleRounds++;
        continue;
      }
      idleRounds = 0;

      for (const post of posts) {
        if (aborted || postsScanned >= maxPosts) break;
        seen.add(post);
        post.scrollIntoView({ block: "center" });
        await sleep(jitter(600, 1100));

        const postDate = postDateOf(post);
        if (postDate !== null && postDate < cutoff) {
          // Older than the window. Pinned posts put old items at the top,
          // so only stop after a few old posts in a row.
          oldStreak++;
          if (oldStreak >= 3) {
            reachedEnd = true;
            break;
          }
          continue;
        }
        if (postDate !== null) oldStreak = 0;
        // Undated posts (unparseable timestamp) are scanned but don't
        // affect the stop condition.

        const postId = postIdOf(post);
        const at = postDate !== null ? postDate : Date.now();
        const events = [];
        try {
          const reactors = await collectReactions(post, selfUrl);
          for (const k of reactors) {
            events.push({ postId, friendKey: k, type: "reaction", at });
          }
        } catch (e) {
          if (e.message === "aborted") return;
        }
        try {
          const commenters = await collectCommenters(post, selfUrl);
          for (const k of commenters) {
            events.push({ postId, friendKey: k, type: "comment", at });
          }
        } catch (e) {
          if (e.message === "aborted") return;
        }

        postsScanned++;
        const when = postDate !== null ? new Date(postDate).toLocaleDateString() : "undated";
        showHud(`scanning engagement… ${postsScanned} posts (at ${when}, back to ${new Date(cutoff).toLocaleDateString()})`);
        await send({
          cmd: "engagementResult",
          events,
          postsScanned,
          done: false,
        });
        await sleep(jitter(800, 1500));
      }
    }

    await send({ cmd: "engagementResult", events: [], postsScanned, done: true });
    showHud(
      reachedEnd
        ? `done — covered the full ${days}-day window (${postsScanned} posts). You can close this tab.`
        : `done — scanned ${postsScanned} posts. You can close this tab.`
    );
    await sleep(4000);
    hideHud();
  }

  // ------------------------------------------------------------- unfriend

  // Recover a friend's numeric Facebook id for the GraphQL unfriend mutation.
  // Friends captured via the API carry profileId directly; older DOM-scanned
  // records still expose it through an "id:" key or a profile.php?id= URL.
  function friendNumericId(friend) {
    if (friend.profileId) return String(friend.profileId);
    if (friend.key && friend.key.indexOf("id:") === 0) return friend.key.slice(3);
    const m = (friend.url || "").match(/profile\.php\?id=(\d+)/);
    return m ? m[1] : null;
  }

  async function runUnfriend(friend) {
    showHud(`removing ${friend.name}…`);
    const fail = async (error) => {
      showHud(`could not remove ${friend.name}: ${error}`);
      await send({ cmd: "removalResult", friendKey: friend.key, ok: false, error });
      await sleep(2500);
      hideHud();
    };

    const main = await waitFor(() => document.querySelector('[role="main"]'), 15000);
    if (!main) return fail("profile did not load");
    await sleep(jitter(1500, 3000));

    // Already not a friend? (deactivated, previously removed, etc.)
    if (findByText(main, ["button"], /^add friend$/i)) {
      return send({
        cmd: "removalResult",
        friendKey: friend.key,
        ok: true,
        note: "was not a friend",
      });
    }

    // Fast path: a single GraphQL mutation — no menu-clicking, no confirm modal.
    // Falls through to the DOM flow below if the API isn't usable for this
    // friend (no boilerplate captured yet, or no numeric id available).
    const G = window.FriendSweepGraph;
    const targetId = friendNumericId(friend);
    if (G && targetId && (await G.waitForReady(10000))) {
      const res = await G.unfriend(targetId);
      if (res.ok) {
        showHud(`removed ${friend.name}`);
        await send({ cmd: "removalResult", friendKey: friend.key, ok: true });
        await sleep(1500);
        hideHud();
        return;
      }
      // Non-fatal: log nothing to the user and try the DOM flow instead.
    }

    const friendsBtn = findByText(main, ["button"], /^friends$/i);
    if (!friendsBtn) return fail("Friends button not found (page layout changed?)");
    realClick(friendsBtn);

    const unfriendItem = await waitFor(
      () => findByText(document, ["menuitem", "menuitemcheckbox", "button"], /^unfriend$/i),
      8000
    );
    if (!unfriendItem) return fail("Unfriend menu item not found");
    await sleep(jitter(400, 900));
    realClick(unfriendItem);

    // The confirm modal is NOT reliably the first role="dialog": clicking the
    // "Friends" button leaves its dropdown mounted (Facebook renders that menu
    // as a role="dialog" too), and it sits earlier in the DOM than the confirm
    // modal. So scan every open dialog, and within the right one fall back to
    // "the primary button that isn't Cancel" if the label wording changed.
    const confirmBtn = await waitFor(() => {
      for (const dialog of openDialogs()) {
        const explicit = findByText(
          dialog,
          ["button"],
          /^(confirm|unfriend|remove|ok|yes)$/i
        );
        if (explicit) return explicit;
        // Positional fallback: a confirm dialog holds just Cancel + the primary
        // action. Take the last button that isn't a cancel/close/back control.
        const buttons = [...dialog.querySelectorAll('[role="button"]')].filter(
          (b) => {
            const s = (b.getAttribute("aria-label") || visibleText(b)).trim();
            return s && s.length < 40 && !/^(cancel|close|back|not now)$/i.test(s);
          }
        );
        // Only trust the fallback for a small, confirm-shaped dialog so we don't
        // misfire on the menu (which has many items).
        if (buttons.length && buttons.length <= 3) return buttons[buttons.length - 1];
      }
      return null;
    }, 8000);
    if (!confirmBtn) return fail("confirmation dialog not found");
    await sleep(jitter(400, 900));
    realClick(confirmBtn);

    // Verify: the button should flip to "Add friend".
    const verified = await waitFor(
      () => findByText(document, ["button"], /^add friend$/i),
      10000
    );
    if (!verified) return fail("could not verify removal");

    showHud(`removed ${friend.name}`);
    await send({ cmd: "removalResult", friendKey: friend.key, ok: true });
    await sleep(2000);
    hideHud();
  }

  // Batch removal: remove the entire selected queue from this one tab via
  // GraphQL unfriend mutations — no per-friend profile navigation. Each friend
  // is one lightweight request; pacing between them is the safety valve. If the
  // API path isn't available, hand back to the background worker to run the
  // legacy per-profile flow.
  async function runRemovalBatch(friends, job) {
    const G = window.FriendSweepGraph;
    const delays = (job && job.delays) || { minSec: 20, maxSec: 45 };
    const total = friends.length;

    showHud(`removing ${total} friend${total === 1 ? "" : "s"} via API… don't touch this tab`);
    log("batch removal starting for", total, "friend(s)");

    const ready = G ? await G.waitForReady(12000) : false;
    const actorId = G ? G.getActorId() : null;
    if (!G || !ready || !actorId) {
      warn("API path unavailable — graph loaded:", !!G, "boilerplate ready:", ready, "actorId:", actorId, "→ falling back to per-profile DOM removal");
      await send({ cmd: "removalFallback" });
      showHud("API unavailable — switching to the standard removal method…");
      await sleep(2500);
      hideHud();
      return;
    }
    log("API path ready; actor id =", actorId);

    // We open removal on the friends page so the collection token is available
    // for the friends search API (used to backfill any missing numeric id).
    // Nudge the page to fire its pagination query so the token gets captured.
    let haveToken = !!G.getFriendsToken();
    for (let i = 0; i < 8 && !haveToken && !aborted; i++) {
      window.scrollTo(0, document.body.scrollHeight);
      await sleep(jitter(700, 1200));
      haveToken = !!G.getFriendsToken();
    }
    log("batch removal: friends collection token", haveToken ? "available" : "NOT available (search backfill disabled)");

    // Derive a vanity username from a "u:" key or profile URL, for search matching.
    const vanityOf = (friend) => {
      if (friend.key && friend.key.indexOf("u:") === 0) return friend.key.slice(2);
      const m = (friend.url || "").match(/facebook\.com\/([A-Za-z0-9.\-]+)\/?$/);
      return m && m[1] !== "profile.php" ? m[1] : null;
    };

    let done = 0;
    let failed = 0;
    for (let i = 0; i < friends.length; i++) {
      if (aborted) break;
      const friend = friends[i];
      if (!friend) continue;

      let targetId = friendNumericId(friend);
      let resolvedId = null;
      if (!targetId) {
        // 1. Backfill via the friends search API (reliable, ~1 KB).
        if (haveToken) {
          showHud(`looking up ${friend.name || "friend"} id…`);
          log("resolving numeric id for", friend.name || friend.key, "via friends search");
          resolvedId = await G.searchFriendId({ name: friend.name, vanity: vanityOf(friend) });
        }
        // 2. Last resort: scrape the profile page (fragile, ~1 MB).
        if (!resolvedId && friend.url) {
          log("resolving numeric id for", friend.name || friend.key, "from profile page", friend.url);
          resolvedId = await G.resolveProfileId(friend.url, friend.name);
        }
        if (resolvedId) targetId = resolvedId;
      }
      if (!targetId) {
        warn("skipping", friend.name || friend.key, "— could not obtain a numeric profile id (key:", friend.key + ", profileId:", friend.profileId + ", url:", friend.url + ")");
      }
      const res = targetId
        ? await G.unfriend(targetId)
        : { ok: false, error: "could not resolve a numeric profile id" };

      if (res.ok) {
        done++;
        log("removed", friend.name || friend.key);
      } else {
        failed++;
        warn("failed to remove", friend.name || friend.key, "—", res.error);
      }
      await send({
        cmd: "removalResult",
        friendKey: friend.key,
        ok: res.ok,
        error: res.error,
        // Persist a freshly-resolved id even on failure, so a retry skips lookup.
        profileId: resolvedId || undefined,
      });
      showHud(
        `removing friends via API… ${done} removed${failed ? `, ${failed} failed` : ""} (${i + 1}/${total})`
      );

      // Pace between removals (no wait after the last one). Randomized, from the
      // user's removal-delay settings, to stay human-ish and avoid soft blocks.
      if (i < friends.length - 1 && !aborted) {
        await sleep(jitter(delays.minSec * 1000, delays.maxSec * 1000));
      }
    }

    if (aborted) return; // cancel already cleared the job and hid the HUD

    await send({ cmd: "removalBatchComplete" });
    showHud(
      `done — removed ${done} friend${done === 1 ? "" : "s"}${failed ? `, ${failed} failed` : ""}. You can close this tab.`
    );
    await sleep(4000);
    hideHud();
  }

  // ------------------------------------------------------------- entry

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.cmd === "abort") {
      aborted = true;
      hideHud();
      sendResponse({ ok: true });
    }
    return false;
  });

  async function main() {
    // Give Facebook's SPA a moment to settle before asking for work.
    await sleep(2000);
    const resp = await send({ cmd: "getJob" });
    if (!resp || !resp.job) return;
    const { job } = resp;
    try {
      if (job.type === "friendScan") {
        await runFriendScan(resp.selfUrl, job.phase || "all");
      } else if (job.type === "friendDatesScan") {
        await runFriendDatesScan();
      } else if (job.type === "engagementScan") {
        await runEngagementScan(job, resp.selfUrl);
      } else if (job.type === "removal") {
        if (job.mode === "batch") {
          await runRemovalBatch(resp.friends || [], job);
        } else if (resp.friend) {
          await runUnfriend(resp.friend);
        }
      }
    } catch (e) {
      if (e.message !== "aborted") {
        await send({ cmd: "jobError", error: String(e) });
      }
      hideHud();
    }
  }

  main();
})();
