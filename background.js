// FriendSweep background service worker.
// Orchestrates jobs (friend scan, engagement scan, removals) by driving a
// Facebook tab and messaging the content script. All job state lives in
// chrome.storage.local so the worker can be killed and revived safely.

const FB = "https://www.facebook.com";

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
    .filter((k) => friends[k] && !friends[k].removedAt)
    .slice(0, cap);
  if (!queue.length) return;
  await setJob({
    type: "removal",
    status: "running",
    tabId: null,
    startedAt: Date.now(),
    queue,
    done: [],
    failed: [],
    current: null,
    progress: { total: queue.length, done: 0, failed: 0 },
  });
  await removalNext();
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
  if (!job || job.type !== "removal" || job.current !== msg.friendKey) return;

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
      name: f.name || (prev && prev.name) || "",
      url: f.url,
      photo: f.photo || (prev && prev.photo) || "",
      firstSeen: (prev && prev.firstSeen) || now,
      lastSeen: now,
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
        name: e.name || "",
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
          const f = friends[job.current];
          sendResponse({ job, friend: f || null });
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
