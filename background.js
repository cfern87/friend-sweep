// FriendSweep background service worker.
// Orchestrates jobs (friend scan, engagement scan, removals) by driving a
// Facebook tab and messaging the content script. All job state lives in
// chrome.storage.local so the worker can be killed and revived safely.

const FB = "https://www.facebook.com";

// Alarm names. chrome.alarms survives service-worker shutdown, so every
// deferred step (pacing, cleanup, chaining, scheduling) hangs off one.
const ALARM_REMOVAL = "removal-step";
const ALARM_CLEANUP = "job-cleanup";
const ALARM_CHAIN = "job-chain";
const ALARM_AUTO = "auto-scan";

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
  await chrome.alarms.clear(ALARM_REMOVAL);
  await chrome.alarms.clear(ALARM_CLEANUP);
  await chrome.alarms.clear(ALARM_CHAIN);
}

// Mark a job complete. A finished job lingers just long enough for the
// dashboard to show its result, then ALARM_CLEANUP removes it — the user never
// has to press "Cancel job" to get rid of a banner for work that already ended.
// Jobs carrying a `chain` (scheduled multi-scan runs) start their next step
// instead of clearing.
async function finishJob(job) {
  job.status = "finished";
  job.finishedAt = Date.now();
  job.current = null;
  await setJob(job);
  await chrome.alarms.clear(ALARM_REMOVAL);
  if (Array.isArray(job.chain) && job.chain.length) {
    // Breathe between scans rather than hammering Facebook back-to-back.
    chrome.alarms.create(ALARM_CHAIN, { delayInMinutes: 0.5 });
    return;
  }
  // Nobody asked for the tab an unattended run opened, so close it behind us.
  if (job.auto && job.tabId != null) {
    chrome.tabs.remove(job.tabId).catch(() => {});
  }
  chrome.alarms.create(ALARM_CLEANUP, { delayInMinutes: 0.5 });
}

// Drop a job that has already ended. Errors are left in place so the user can
// read them; they're dismissed from the dashboard instead.
async function cleanupFinishedJob() {
  const job = await getJob();
  if (!job || job.status !== "finished") return;
  await clearJob();
}

// Run the next scan of a chained (scheduled) run.
async function runChainStep() {
  const job = await getJob();
  if (!job || !Array.isArray(job.chain) || !job.chain.length) return;
  const chain = job.chain.slice();
  const type = chain.shift();
  const opts = { chain, auto: job.auto, days: job.days, tabId: job.tabId };
  await clearJob();
  await startScanByType(type, opts);
}

// Fields every start* function copies onto its job so chained/scheduled runs
// keep their identity across steps.
function jobMeta(opts = {}) {
  const meta = {};
  if (opts.chain && opts.chain.length) meta.chain = opts.chain;
  if (opts.auto) meta.auto = true;
  return meta;
}

function startScanByType(type, opts) {
  if (type === "friendScan") return startFriendScan(opts);
  if (type === "friendDatesScan") return startFriendDatesScan(opts);
  if (type === "engagementScan") return startEngagementScan(opts);
  return Promise.resolve();
}

// ---------------------------------------------------------------- tabs

// Reuses the current job's tab when there is one. `preferTabId` carries a tab
// across a cleared job — chained scheduled scans hand their tab to the next
// step instead of piling up a new Facebook tab per scan.
async function openJobTab(url, preferTabId) {
  const job = await getJob();
  const wanted = preferTabId != null ? preferTabId : job && job.tabId;
  let tab = null;
  if (wanted != null) {
    try {
      tab = await chrome.tabs.get(wanted);
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

async function startFriendScan(opts) {
  const tabId = await openJobTab(FB + "/me/friends", opts && opts.tabId);
  await setJob({
    type: "friendScan",
    status: "running",
    phase: "all", // "all" = full list, then "recent" = recently-added order
    tabId,
    startedAt: Date.now(),
    progress: { found: 0 },
    ...jobMeta(opts),
  });
}

async function startFriendDatesScan(opts) {
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
  const tabId = await openJobTab(url, opts && opts.tabId);
  await setJob({
    type: "friendDatesScan",
    status: "running",
    tabId,
    startedAt: Date.now(),
    progress: { dated: 0 },
    ...jobMeta(opts),
  });
}

async function startEngagementScan(opts) {
  const tabId = await openJobTab(FB + "/me", opts && opts.tabId);
  await setJob({
    type: "engagementScan",
    status: "running",
    tabId,
    startedAt: Date.now(),
    days: (opts && opts.days) || 30,
    maxPosts: 400, // hard safety cap regardless of window
    progress: { posts: 0, events: 0 },
    ...jobMeta(opts),
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
    await finishJob(job);
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
    await finishJob(job);
    return;
  }

  // Randomized human-ish pacing between removals. chrome.alarms survives
  // service-worker shutdown; minimum granularity is ~30s which suits us.
  const minS = settings.removeDelayMinSec || 20;
  const maxS = settings.removeDelayMaxSec || 45;
  const delaySec = Math.max(30, minS + Math.random() * (maxS - minS));
  job.nextStepAt = Date.now() + delaySec * 1000;
  await setJob(job);
  chrome.alarms.create(ALARM_REMOVAL, { delayInMinutes: delaySec / 60 });
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_REMOVAL) removalNext();
  else if (alarm.name === ALARM_CLEANUP) cleanupFinishedJob();
  else if (alarm.name === ALARM_CHAIN) runChainStep();
  else if (alarm.name === ALARM_AUTO) runScheduledScan();
});

// A running job whose tab is gone can never report back, so it would otherwise
// sit "running" forever and keep the dashboard's actions disabled.
chrome.tabs.onRemoved.addListener(async (tabId) => {
  const job = await getJob();
  if (!job || job.status !== "running" || job.tabId !== tabId) return;
  job.status = "error";
  job.error = "the Facebook tab was closed before the job finished";
  await setJob(job);
  await chrome.alarms.clear(ALARM_REMOVAL);
  await chrome.alarms.clear(ALARM_CHAIN);
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
        await finishJob(job);
      }
      return;
    }
    await finishJob(job);
    return;
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
    if (msg.done) await finishJob(job);
    else await setJob(job);
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
    if (msg.done) await finishJob(job);
    else await setJob(job);
  }
}

// ---------------------------------------------------------------- schedule

// Unattended re-scans: every `everyHours`, run `scans` in order, with
// `days` as the engagement look-back window. Removals are never automated —
// only the read-only scans, so nothing destructive happens unsupervised.
const DEFAULT_SCHEDULE = {
  enabled: false,
  everyHours: 24,
  days: 30,
  scans: ["friendScan", "engagementScan"],
  lastRunAt: 0,
  nextRunAt: 0,
};

const SCAN_TYPES = ["friendScan", "friendDatesScan", "engagementScan"];

async function getSchedule() {
  const { schedule } = await getStore("schedule");
  return { ...DEFAULT_SCHEDULE, ...(schedule || {}) };
}

// Persist a schedule change and (re)arm the repeating alarm to match.
async function applySchedule(patch) {
  const sched = { ...(await getSchedule()), ...(patch || {}) };
  sched.everyHours = Math.max(1, Number(sched.everyHours) || 24);
  sched.days = Math.max(1, Number(sched.days) || 30);
  sched.scans = (sched.scans || []).filter((s) => SCAN_TYPES.includes(s));
  sched.enabled = !!sched.enabled && sched.scans.length > 0;

  await chrome.alarms.clear(ALARM_AUTO);
  if (sched.enabled) {
    const periodInMinutes = sched.everyHours * 60;
    sched.nextRunAt = Date.now() + periodInMinutes * 60000;
    chrome.alarms.create(ALARM_AUTO, { delayInMinutes: periodInMinutes, periodInMinutes });
  } else {
    sched.nextRunAt = 0;
  }
  await setStore({ schedule: sched });
  return sched;
}

// Alarms are cleared when the extension reloads/updates, so re-arm on wake.
async function ensureScheduleAlarm() {
  const sched = await getSchedule();
  if (!sched.enabled) return;
  const existing = await chrome.alarms.get(ALARM_AUTO);
  if (!existing) await applySchedule({});
}

chrome.runtime.onInstalled.addListener(ensureScheduleAlarm);
chrome.runtime.onStartup.addListener(ensureScheduleAlarm);

// `force` is the dashboard's "Run now": it runs the configured sequence even
// when the repeating schedule is switched off, and leaves the timer alone.
async function runScheduledScan(force) {
  const sched = await getSchedule();
  if ((!sched.enabled && !force) || !sched.scans.length) return;

  const job = await getJob();
  if (job && job.status === "running") {
    // Something is already driving a Facebook tab — a manual scan, or the
    // previous scheduled run still going. Skip this tick rather than fight it.
    if (sched.enabled) {
      sched.nextRunAt = Date.now() + sched.everyHours * 3600000;
      await setStore({ schedule: sched });
    }
    return;
  }
  await clearJob();

  const chain = sched.scans.filter((s) => SCAN_TYPES.includes(s));
  const first = chain.shift();
  sched.lastRunAt = Date.now();
  if (sched.enabled) sched.nextRunAt = Date.now() + sched.everyHours * 3600000;
  await setStore({ schedule: sched });
  await startScanByType(first, { chain, auto: true, days: sched.days });
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
      case "dismissJob": {
        // Clears the result banner for a job that already ended. Never touches
        // a running job — cancelling is a separate, explicit action.
        const job = await getJob();
        if (job && job.status !== "running") await clearJob();
        sendResponse({ ok: true });
        break;
      }
      case "getSchedule":
        sendResponse({ schedule: await getSchedule() });
        break;
      case "setSchedule":
        sendResponse({ schedule: await applySchedule(msg.schedule || {}) });
        break;
      case "runScheduleNow":
        await runScheduledScan(true);
        sendResponse({ ok: true });
        break;
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
        if (job && job.type === "removal" && job.mode === "batch") await finishJob(job);
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
