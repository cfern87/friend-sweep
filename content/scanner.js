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

  async function runFriendScan(selfUrl, phase) {
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

  async function collectReactions(post, selfUrl) {
    const keys = new Set();
    // The "see who reacted" affordance has shifted between a toolbar, a
    // labelled span, and a bare count button over the years. Try each.
    const btn =
      findByText(post, ["button"], /see who reacted/i) ||
      post.querySelector('[aria-label*="reacted" i][role="button"]') ||
      post.querySelector('span[aria-label*="reacted" i]') ||
      findByText(post, ["button"], /^(you|[\d,.]+[km]?)( and [\d,.]+[km]? others?)?$/i);
    if (!btn) return keys;

    realClick(btn);
    const dialog = await waitFor(() => document.querySelector('div[role="dialog"]'), 6000);
    if (!dialog) return keys;

    // Scroll the reactions list a few times to load more names.
    for (let i = 0; i < 8; i++) {
      if (aborted) break;
      collectProfileKeys(dialog, selfUrl, keys);
      const scrollable = [...dialog.querySelectorAll("div")].find(
        (d) => d.scrollHeight > d.clientHeight + 50
      );
      if (!scrollable) break;
      const before = scrollable.scrollTop;
      scrollable.scrollTop = scrollable.scrollHeight;
      await sleep(jitter(700, 1200));
      if (scrollable.scrollTop === before) break;
    }
    collectProfileKeys(dialog, selfUrl, keys);

    const close =
      dialog.querySelector('div[aria-label="Close"][role="button"]') ||
      findByText(dialog, ["button"], /^close$/i);
    if (close) realClick(close);
    else document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await sleep(jitter(500, 900));
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

  async function runEngagementScan(job, selfUrl) {
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

    const confirmBtn = await waitFor(() => {
      const dialog = document.querySelector('div[role="dialog"]');
      if (!dialog) return null;
      return findByText(dialog, ["button"], /^(confirm|unfriend)$/i);
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
      } else if (job.type === "removal" && resp.friend) {
        await runUnfriend(resp.friend);
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
