// FriendSweep background service worker.
// Orchestrates jobs (friend scan, engagement scan, removals) by driving a
// Facebook tab and messaging the content script. All job state lives in
// chrome.storage.local so the worker can be killed and revived safely.

const FB = "https://www.facebook.com";

// Texts that earlier versions could mistakenly capture as a person's name
// (the "N mutual friends" link on friend cards, action buttons, counts).
// Kept in sync with NAME_NOISE_RE in content/scanner.js.
const NAME_NOISE_RE =
  /^(\d[\d,.]*\s+mutual friends?|\d[\d,.]*\s+(followers?|friends|following)|mutual friends?|follow|following|add friend|message|friends|unfriend|see all|view profile|\d[\d,.]*)$/i;

function cleanName(name) {
  const t = (name || "").trim();
  return NAME_NOISE_RE.test(t) ? "" : t;
}

// One-time scrub of records logged with a noise "name" by earlier versions.
// The real name is refilled by the next friend scan.
async function scrubNoiseNames() {
  const { friends } = await chrome.storage.local.get("friends");
  if (!friends) return;
  let changed = false;
  for (const f of Object.values(friends)) {
    const cleaned = cleanName(f.name);
    if (cleaned !== f.name) {
      f.name = cleaned;
      changed = true;
    }
  }
  if (changed) await chrome.storage.local.set({ friends });
}

chrome.runtime.onInstalled.addListener(scrubNoiseNames);
chrome.runtime.onStartup.addListener(scrubNoiseNames);

// ---------------------------------------------------------------- storage

async function getStore(keys) {
  return chrome.storage.local.get(keys);
}

async function setStore(obj) {
  return chrome.storage.local.set(obj);
}

async function getJob() {
  const { job } = await getStore("job");
  return job || null;
}

async function setJob(job) {
  await setStore({ job });
}

async function clearJob() {
  await chrome.storage.local.remove("job");
  await chrome.alarms.clear("removal-step");
}

// ---------------------------------------------------------------- tabs

async function openJobTab(url) {
  const job = await getJob();
  let tab = null;
  if (job && job.tabId != null) {
    try {
      tab = await chrome.tabs.get(job.tabId);
    } catch (e) {
      tab = null;
    }
  }
  if (tab) {
    await chrome.tabs.update(tab.id, { url, active: true });
    return tab.id;
  }
  tab = await chrome.tabs.create({ url, active: true });
  return tab.id;
}

function sendToTab(tabId, msg) {
  return chrome.tabs.sendMessage(tabId, msg).catch(() => null);
}

// ---------------------------------------------------------------- jobs

async function startFriendScan() {
  const tabId = await openJobTab(FB + "/me/friends");
  await setJob({
    type: "friendScan",
    status: "running",
    phase: "all", // "all" = full list, then "recent" = recently-added order
    tabId,
    startedAt: Date.now(),
    progress: { found: 0 },
  });
}

async function startFriendDatesScan() {
  // The activity log lives under the user's own profile path. Prefer the
  // concrete profile URL captured during earlier scans; /me works too.
  const { selfUrl } = await getStore("selfUrl");
  let base = FB + "/me";
  if (selfUrl) {
    const m = selfUrl.match(/profile\.php\?id=(\d+)/);
    base = m ? FB + "/" + m[1] : selfUrl;
  }
  const url =
    base +
    "/allactivity/?category_key=FRIENDS&filter_hidden=ALL&filter_privacy=NONE&manage_mode=false";
  const tabId = await openJobTab(url);
  await setJob({
    type: "friendDatesScan",
    status: "running",
    tabId,
    startedAt: Date.now(),
    progress: { dated: 0 },
  });
}

async function startEngagementScan(opts) {
  const tabId = await openJobTab(FB + "/me");
  await setJob({
    type: "engagementScan",
    status: "running",
    tabId,
    startedAt: Date.now(),
    days: (opts && opts.days) || 30,
    maxPosts: 400, // hard safety cap regardless of window
    progress: { posts: 0, events: 0 },
  });
}

async function startRemoval(friendKeys) {
  const { friends = {}, settings = {} } = await getStore(["friends", "settings"]);
  const cap = settings.maxRemovalsPerRun || 20;
  const queue = friendKeys
    .filter((k) => friends[k] && !friends[k].removedAt && !friends[k].whitelisted)
    .slice(0, cap);
  if (!queue.length) return;
  // Batch mode: open the friends page and remove the whole selection from it via
  // GraphQL unfriend mutations — no per-friend profile navigation. The friends
  // page is used (rather than the home feed) so the friends-collection token is
  // available, letting us resolve any missing numeric id via the friends search
  // API. The content script picks the batch up through its getJob handshake, and
  // falls back to the legacy per-profile flow if the API path can't run.
  const tabId = await openJobTab(FB + "/me/friends");
  await setJob({
    type: "removal",
    mode: "batch",
    status: "running",
    tabId,
    startedAt: Date.now(),
    queue,
    done: [],
    failed: [],
    current: null,
    progress: { total: queue.length, done: 0, failed: 0 },
    delays: {
      minSec: settings.removeDelayMinSec || 20,
      maxSec: settings.removeDelayMaxSec || 45,
    },
  });
}

async function removalNext() {
  const job = await getJob();
  if (!job || job.type !== "removal" || job.status !== "running") return;
  const next = job.queue.shift();
  if (!next) {
    job.status = "finished";
    job.finishedAt = Date.now();
    await setJob(job);
    return;
  }
  const { friends = {} } = await getStore("friends");
  const friend = friends[next];
  if (!friend) {
    await setJob(job);
    return removalNext();
  }
  job.current = next;
  const tabId = await openJobTab(friend.url);
  job.tabId = tabId;
  await setJob(job);
  // The content script picks the job up when the profile page loads
  // (via its "getJob" handshake), so nothing else to do here.
}

async function handleRemovalResult(msg) {
  const job = await getJob();
  if (!job || job.type !== "removal") return;

  // Batch mode: the content script drives the loop and pacing, sending one
  // result per friend. We just record each outcome; completion arrives as a
  // separate "removalBatchComplete" message.
  if (job.mode === "batch") {
    const { friends = {} } = await getStore("friends");
    let friendsChanged = false;
    // Persist any numeric id the content script resolved live, so it's captured
    // once and reused (even if this removal itself failed).
    if (msg.profileId && friends[msg.friendKey] && !friends[msg.friendKey].profileId) {
      friends[msg.friendKey].profileId = String(msg.profileId);
      friendsChanged = true;
    }
    if (msg.ok) {
      if (!job.done.includes(msg.friendKey)) {
        job.done.push(msg.friendKey);
        job.progress.done++;
      }
      if (friends[msg.friendKey]) {
        friends[msg.friendKey].removedAt = Date.now();
        friendsChanged = true;
      }
    } else {
      job.failed.push({ key: msg.friendKey, error: msg.error || "unknown" });
      job.progress.failed++;
    }
    if (friendsChanged) await setStore({ friends });
    await setJob(job);
    return;
  }

  if (job.current !== msg.friendKey) return;

  const { friends = {}, settings = {} } = await getStore(["friends", "settings"]);
  if (msg.ok) {
    job.done.push(msg.friendKey);
    job.progress.done++;
    if (friends[msg.friendKey]) {
      friends[msg.friendKey].removedAt = Date.now();
      await setStore({ friends });
    }
  } else {
    job.failed.push({ key: msg.friendKey, error: msg.error || "unknown" });
    job.progress.failed++;
  }
  job.current = null;

  if (!job.queue.length) {
    job.status = "finished";
    job.finishedAt = Date.now();
    await setJob(job);
    return;
  }

  // Randomized human-ish pacing between removals. chrome.alarms survives
  // service-worker shutdown; minimum granularity is ~30s which suits us.
  const minS = settings.removeDelayMinSec || 20;
  const maxS = settings.removeDelayMaxSec || 45;
  const delaySec = Math.max(30, minS + Math.random() * (maxS - minS));
  job.nextStepAt = Date.now() + delaySec * 1000;
  await setJob(job);
  chrome.alarms.create("removal-step", { delayInMinutes: delaySec / 60 });
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "removal-step") removalNext();
});

// ---------------------------------------------------------------- results

async function handleFriendScanResult(msg) {
  const now = Date.now();
  const { friends = {} } = await getStore("friends");
  msg.friends.forEach((f, i) => {
    const prev = friends[f.key];
    friends[f.key] = {
      ...prev,
      key: f.key,
      name: cleanName(f.name) || cleanName(prev && prev.name) || "",
      url: f.url,
      photo: f.photo || (prev && prev.photo) || "",
      firstSeen: (prev && prev.firstSeen) || now,
      lastSeen: now,
      // Numeric FB id (from the GraphQL scan) — enables one-shot removal later.
      ...(f.profileId ? { profileId: f.profileId } : {}),
      // The "Recently added" tab lists friends newest-first, so the DOM
      // index is a friendship-recency rank (0 = most recently added).
      ...(msg.phase === "recent" ? { recentRank: i } : {}),
    };
  });
  await setStore({ friends });

  const job = await getJob();
  if (!job || job.type !== "friendScan") return;
  job.progress.found = Object.keys(friends).length;
  if (msg.done) {
    if (job.phase === "all") {
      // Phase 2: walk the "Recently added" tab to capture friend order.
      job.phase = "recent";
      await setJob(job);
      try {
        await chrome.tabs.update(job.tabId, { url: FB + "/me/friends_recent" });
      } catch (e) {
        job.status = "finished";
        job.finishedAt = now;
        await setJob(job);
      }
      return;
    }
    job.status = "finished";
    job.finishedAt = now;
  }
  await setJob(job);
}

async function handleFriendDatesResult(msg) {
  const now = Date.now();
  const { friends = {} } = await getStore("friends");

  // Entries whose name link couldn't be resolved to a profile URL are
  // matched by exact name — but only when the name is unambiguous.
  const byName = new Map();
  for (const f of Object.values(friends)) {
    const n = (f.name || "").toLowerCase();
    if (!n) continue;
    if (!byName.has(n)) byName.set(n, []);
    byName.get(n).push(f.key);
  }

  for (const e of msg.entries) {
    let key = e.key;
    if (!key && e.name) {
      const candidates = byName.get(e.name.toLowerCase()) || [];
      if (candidates.length === 1) key = candidates[0];
    }
    if (!key) continue;
    if (!friends[key]) {
      friends[key] = {
        key,
        name: cleanName(e.name),
        url: e.url || "",
        photo: "",
        firstSeen: now,
        lastSeen: now,
      };
    }
    friends[key].friendedAt = e.friendedAt;
  }
  await setStore({ friends });

  const job = await getJob();
  if (job && job.type === "friendDatesScan") {
    job.progress.dated = Object.values(friends).filter((f) => f.friendedAt).length;
    if (msg.done) {
      job.status = "finished";
      job.finishedAt = now;
    }
    await setJob(job);
  }
}

async function handleEngagementResult(msg) {
  const now = Date.now();
  const { engagement = {} } = await getStore("engagement");
  let added = 0;
  for (const ev of msg.events) {
    const key = `${ev.postId}|${ev.friendKey}|${ev.type}`;
    if (!engagement[key]) {
      engagement[key] = { ...ev, recordedAt: now };
      added++;
    }
  }
  await setStore({ engagement });

  const job = await getJob();
  if (job && job.type === "engagementScan") {
    job.progress.posts = msg.postsScanned;
    job.progress.events = (job.progress.events || 0) + added;
    if (msg.done) {
      job.status = "finished";
      job.finishedAt = now;
    }
    await setJob(job);
  }
}

// ---------------------------------------------------------------- messages

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    switch (msg.cmd) {
      // ---- from the dashboard / popup
      case "startFriendScan":
        await startFriendScan();
        sendResponse({ ok: true });
        break;
      case "startEngagementScan":
        await startEngagementScan(msg);
        sendResponse({ ok: true });
        break;
      case "startFriendDatesScan":
        await startFriendDatesScan();
        sendResponse({ ok: true });
        break;
      case "startRemoval":
        await startRemoval(msg.friendKeys || []);
        sendResponse({ ok: true });
        break;
      case "cancelJob": {
        const job = await getJob();
        if (job && job.tabId != null) sendToTab(job.tabId, { cmd: "abort" });
        await clearJob();
        sendResponse({ ok: true });
        break;
      }
      case "openDashboard":
        chrome.tabs.create({ url: chrome.runtime.getURL("dashboard/dashboard.html") });
        sendResponse({ ok: true });
        break;

      // ---- from the content script
      case "getJob": {
        // Content script asks on every page load whether it has work to do.
        const job = await getJob();
        if (!job || job.status !== "running" || !sender.tab || sender.tab.id !== job.tabId) {
          sendResponse({ job: null });
          break;
        }
        // Remember the user's own profile URL (facebook.com/me redirects to it)
        // so scans can exclude self-engagement.
        if (
          sender.tab.url &&
          (job.type === "engagementScan" || job.type === "friendScan")
        ) {
          const m = sender.tab.url.match(
            /^https:\/\/(?:www|web)\.facebook\.com\/([^/?#]+)/
          );
          if (m && m[1] !== "me" && m[1] !== "profile.php") {
            await setStore({ selfUrl: "https://www.facebook.com/" + m[1] });
          } else if (m && m[1] === "profile.php") {
            const id = new URL(sender.tab.url).searchParams.get("id");
            if (id) {
              await setStore({
                selfUrl: "https://www.facebook.com/profile.php?id=" + id,
              });
            }
          }
        }
        if (job.type === "removal") {
          const { friends = {} } = await getStore("friends");
          if (job.mode === "batch") {
            // Hand the content script the whole queue's friend records so it can
            // remove them all from this one tab.
            const list = job.queue.map((k) => friends[k]).filter(Boolean);
            sendResponse({ job, friends: list });
          } else {
            const f = friends[job.current];
            sendResponse({ job, friend: f || null });
          }
        } else {
          const { selfUrl } = await getStore("selfUrl");
          sendResponse({ job, selfUrl: selfUrl || null });
        }
        break;
      }
      case "friendScanResult":
        await handleFriendScanResult(msg);
        sendResponse({ ok: true });
        break;
      case "friendDatesResult":
        await handleFriendDatesResult(msg);
        sendResponse({ ok: true });
        break;
      case "engagementResult":
        await handleEngagementResult(msg);
        sendResponse({ ok: true });
        break;
      case "removalResult":
        await handleRemovalResult(msg);
        sendResponse({ ok: true });
        break;
      case "removalBatchComplete": {
        const job = await getJob();
        if (job && job.type === "removal" && job.mode === "batch") {
          job.status = "finished";
          job.finishedAt = Date.now();
          job.current = null;
          await setJob(job);
        }
        sendResponse({ ok: true });
        break;
      }
      case "removalFallback": {
        // The content script couldn't run the API batch (no boilerplate/actor
        // id). Switch to the legacy per-profile navigation flow for this job.
        const job = await getJob();
        if (job && job.type === "removal" && job.mode === "batch") {
          job.mode = "legacy";
          await setJob(job);
          await removalNext();
        }
        sendResponse({ ok: true });
        break;
      }
      case "jobError": {
        const job = await getJob();
        if (job) {
          job.status = "error";
          job.error = msg.error;
          await setJob(job);
        }
        sendResponse({ ok: true });
        break;
      }
      default:
        sendResponse({ ok: false, error: "unknown cmd" });
    }
  })();
  return true; // keep the message channel open for the async response
});
