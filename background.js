// FriendSweep background service worker.
// Orchestrates jobs (friend scan, engagement scan, removals) by driving a
// Facebook tab and messaging the content script. All job state lives in
// chrome.storage.local so the worker can be killed and revived safely.
// sync.js mirrors that data into chrome.storage.sync across browsers.

importScripts("sync.js");

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
  await withStoreLock(async () => {
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
  });
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

// Serializes read-modify-write of the shared records (friends, engagement,
// settings). Scan results, dashboard edits and incoming sync all rewrite the
// whole `friends` map, so without this one could silently drop another's
// change. Never call it from inside a locked function — it isn't reentrant.
let storeLock = Promise.resolve();
function withStoreLock(fn) {
  const run = storeLock.then(fn, fn);
  storeLock = run.catch(() => {});
  return run;
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
    await withStoreLock(async () => {
      const { friends = {} } = await getStore("friends");
      let friendsChanged = false;
      // Persist any numeric id the content script resolved live, so it's captured
      // once and reused (even if this removal itself failed).
      if (msg.profileId && friends[msg.friendKey] && !friends[msg.friendKey].profileId) {
        friends[msg.friendKey].profileId = String(msg.profileId);
        friendsChanged = true;
      }
      if (msg.ok && friends[msg.friendKey]) {
        friends[msg.friendKey].removedAt = Date.now();
        friendsChanged = true;
      }
      if (friendsChanged) await setStore({ friends });
    });
    if (msg.ok) {
      if (!job.done.includes(msg.friendKey)) {
        job.done.push(msg.friendKey);
        job.progress.done++;
      }
    } else {
      job.failed.push({ key: msg.friendKey, error: msg.error || "unknown" });
      job.progress.failed++;
    }
    await setJob(job);
    return;
  }

  if (job.current !== msg.friendKey) return;

  const { settings = {} } = await getStore("settings");
  if (msg.ok) {
    job.done.push(msg.friendKey);
    job.progress.done++;
    await withStoreLock(async () => {
      const { friends = {} } = await getStore("friends");
      if (friends[msg.friendKey]) {
        friends[msg.friendKey].removedAt = Date.now();
        await setStore({ friends });
      }
    });
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
  const friends = await withStoreLock(async () => {
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
    return friends;
  });

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
  const friends = await withStoreLock(async () => {
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
    return friends;
  });

  const job = await getJob();
  if (job && job.type === "friendDatesScan") {
    job.progress.dated = Object.values(friends).filter((f) => f.friendedAt).length;
    if (msg.done) await finishJob(job);
    else await setJob(job);
  }
}

async function handleEngagementResult(msg) {
  const now = Date.now();
  const added = await withStoreLock(async () => {
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
    return added;
  });

  const job = await getJob();
  if (job && job.type === "engagementScan") {
    job.progress.posts = msg.postsScanned;
    job.progress.events = (job.progress.events || 0) + added;
    if (msg.done) await finishJob(job);
    else await setJob(job);
  }
}

// ---------------------------------------------------------------- doc_ids

// Facebook's GraphQL persisted-query ids ("doc_ids") change when Facebook
// redeploys. The content script reports the ids it sees Facebook's own pages
// use, and ones Facebook rejects; they're kept here so every page (and, via
// sync.js, every browser) starts from the last id known to work.
//
//   docIds[friendlyName] = {
//     docId,          // last id Facebook was seen using; null once rejected
//     seenAt,         // when docId was set (ms) — newest wins across browsers
//     seed,           // the extension's built-in id when this was recorded
//     staleId, staleAt,               // last learned id Facebook rejected
//     seedRejected, seedRejectedAt,   // built-in id Facebook rejected
//   }
const DOC_ID_RE = /^\d{5,25}$/;
const DOC_NAME_RE = /^[A-Za-z0-9_]{3,120}$/;
const MAX_DOC_IDS = 20;
// A rejected id is skipped for this long before it's tried again — long enough
// not to send doomed requests on every page, short enough to recover from a
// misread error.
const REJECTED_TTL_MS = 24 * 3600000;

function validDocReport(msg) {
  return (
    msg &&
    typeof msg.friendlyName === "string" &&
    DOC_NAME_RE.test(msg.friendlyName) &&
    typeof msg.docId === "string" &&
    DOC_ID_RE.test(msg.docId) &&
    (msg.seed == null || (typeof msg.seed === "string" && DOC_ID_RE.test(msg.seed)))
  );
}

// Keep the map small: drop the least recently touched names beyond the cap.
function capDocIds(docIds) {
  const names = Object.keys(docIds);
  if (names.length <= MAX_DOC_IDS) return;
  const touched = (e) => Math.max(e.seenAt || 0, e.staleAt || 0, e.seedRejectedAt || 0);
  names.sort((a, b) => touched(docIds[a]) - touched(docIds[b]));
  for (const n of names.slice(0, names.length - MAX_DOC_IDS)) delete docIds[n];
}

async function recordObservedDocId(msg) {
  if (!validDocReport(msg)) return;
  await withStoreLock(async () => {
    const { docIds = {} } = await getStore("docIds");
    const cur = docIds[msg.friendlyName];
    if (cur && cur.docId === msg.docId && (cur.seed === msg.seed || !msg.seed)) return;
    const next = { ...(cur || {}), docId: msg.docId, seed: msg.seed || (cur && cur.seed) || null };
    // seenAt orders ids across browsers; an id we already hold keeps its stamp.
    if (!cur || cur.docId !== msg.docId) next.seenAt = Date.now();
    // Facebook using its own seed again clears an old rejection of it.
    if (next.seedRejected === msg.docId) {
      delete next.seedRejected;
      delete next.seedRejectedAt;
    }
    docIds[msg.friendlyName] = next;
    capDocIds(docIds);
    await setStore({ docIds });
  });
}

async function recordStaleDocId(msg) {
  if (!validDocReport(msg)) return;
  const now = Date.now();
  await withStoreLock(async () => {
    const { docIds = {} } = await getStore("docIds");
    const cur = docIds[msg.friendlyName] || { docId: null, seenAt: 0, seed: msg.seed || null };
    const next = { ...cur };
    if (cur.docId === msg.docId) {
      // A timestamped tombstone rather than a delete, so sync can't bring the
      // dead id back from another browser's older copy.
      next.docId = null;
      next.seenAt = now;
      next.staleId = msg.docId;
      next.staleAt = now;
    }
    if (msg.seed && msg.docId === msg.seed) {
      next.seed = msg.seed;
      next.seedRejected = msg.seed;
      next.seedRejectedAt = now;
    }
    if (JSON.stringify(next) === JSON.stringify(cur) && docIds[msg.friendlyName]) return;
    docIds[msg.friendlyName] = next;
    capDocIds(docIds);
    await setStore({ docIds });
  });
}

// What a page needs to pick its doc_ids: the live ones, and ids recently
// rejected (so it doesn't resend a request known to fail).
async function docIdsForPage() {
  const { docIds = {} } = await getStore("docIds");
  const now = Date.now();
  const active = {};
  const rejected = {};
  for (const [name, e] of Object.entries(docIds)) {
    if (!e) continue;
    if (e.docId) active[name] = e.docId;
    const bad = [];
    if (e.seedRejected && now - (e.seedRejectedAt || 0) < REJECTED_TTL_MS) bad.push(e.seedRejected);
    if (e.staleId && e.staleId !== e.docId && now - (e.staleAt || 0) < REJECTED_TTL_MS) bad.push(e.staleId);
    if (bad.length) rejected[name] = bad;
  }
  return { docIds: active, rejectedDocIds: rejected };
}

// Every doc_id for an operation failed: the content script has fallen back to
// its slower page path. Note it on the job so the user (and a support request)
// can see which Facebook request changed.
async function noteBrokenDocId(msg, sender) {
  const job = await getJob();
  if (!job || !sender.tab || sender.tab.id !== job.tabId) return;
  const text = String(msg.message || "").slice(0, 200);
  if (!text) return;
  const warnings = Array.isArray(job.warnings) ? job.warnings : [];
  if (warnings.includes(text)) return;
  job.warnings = warnings.concat(text);
  await setJob(job);
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
  configAt: 0, // when the user last changed the schedule — orders synced edits
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

// ---------------------------------------------------------------- sync

FriendSync.init({
  applySchedule,
  isJobRunning: async () => {
    const job = await getJob();
    return !!(job && job.status === "running");
  },
  // Another browser deleted everything: stop this one's scheduled scans too.
  afterWipe: () => chrome.alarms.clear(ALARM_AUTO),
});

// `force` is the dashboard's "Run now": it runs the configured sequence even
// when the repeating schedule is switched off, and leaves the timer alone.
async function runScheduledScan(force) {
  const sched = await getSchedule();
  if ((!sched.enabled && !force) || !sched.scans.length) return;

  // The schedule syncs, so every signed-in browser has the same alarm. Only
  // one should scan per interval: lastRunAt syncs too, and a run another
  // browser started this round means this tick has nothing to do.
  const period = sched.everyHours * 3600000;
  if (!force && sched.lastRunAt && Date.now() - sched.lastRunAt < period * 0.9) {
    if (sched.enabled) {
      sched.nextRunAt = Date.now() + period;
      await setStore({ schedule: sched });
    }
    return;
  }

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
        sendResponse({
          schedule: await applySchedule({ ...(msg.schedule || {}), configAt: Date.now() }),
        });
        break;
      case "setProtected": {
        // Stamped per friend so the newest protect/unprotect wins across
        // browsers, rather than whichever browser saved its whole list last.
        await withStoreLock(async () => {
          const { friends = {} } = await getStore("friends");
          const now = Date.now();
          for (const k of msg.keys || []) {
            if (!friends[k]) continue;
            friends[k].whitelisted = !!msg.value;
            friends[k].whitelistedAt = now;
          }
          await setStore({ friends });
        });
        sendResponse({ ok: true });
        break;
      }
      case "saveSettings": {
        // Field-level timestamps, so editing one setting here can't revert a
        // different one just changed in another browser.
        await withStoreLock(async () => {
          const { settings = {} } = await getStore("settings");
          const ts = { ...(settings._ts || {}) };
          const now = Date.now();
          for (const [k, v] of Object.entries(msg.patch || {})) {
            if (k === "_ts" || settings[k] === v) continue;
            settings[k] = v;
            ts[k] = now;
          }
          settings._ts = ts;
          await setStore({ settings });
        });
        sendResponse({ ok: true });
        break;
      }
      case "syncNow":
        FriendSync.syncSoon();
        sendResponse({ ok: true });
        break;
      case "wipeAll": {
        const job = await getJob();
        if (job && job.tabId != null) sendToTab(job.tabId, { cmd: "abort" });
        await chrome.alarms.clear(ALARM_AUTO);
        await chrome.alarms.clear(ALARM_REMOVAL);
        await chrome.alarms.clear(ALARM_CLEANUP);
        await chrome.alarms.clear(ALARM_CHAIN);
        await FriendSync.wipeEverywhere();
        sendResponse({ ok: true });
        break;
      }
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
        // Known doc_ids ride along either way, so any page starts from them.
        const ids = await docIdsForPage();
        const job = await getJob();
        if (!job || job.status !== "running" || !sender.tab || sender.tab.id !== job.tabId) {
          sendResponse({ job: null, ...ids });
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
            sendResponse({ job, friends: list, ...ids });
          } else {
            const f = friends[job.current];
            sendResponse({ job, friend: f || null, ...ids });
          }
        } else {
          const { selfUrl } = await getStore("selfUrl");
          sendResponse({ job, selfUrl: selfUrl || null, ...ids });
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
          // A batch can switch part-way (e.g. the unfriend doc_id went stale
          // after some removals), so only hand on friends not yet handled.
          const handled = new Set([...(job.done || []), ...(job.failed || []).map((f) => f.key)]);
          job.queue = job.queue.filter((k) => !handled.has(k));
          // Carried here as well as via docIdBroken: both rewrite the job at
          // about the same moment, and this write must not drop the note.
          const note = typeof msg.warning === "string" ? msg.warning.slice(0, 200) : "";
          const warnings = Array.isArray(job.warnings) ? job.warnings : [];
          if (note && !warnings.includes(note)) job.warnings = warnings.concat(note);
          await setJob(job);
          await removalNext();
        }
        sendResponse({ ok: true });
        break;
      }
      case "observedDocId":
        if (sender.tab) await recordObservedDocId(msg);
        sendResponse({ ok: true });
        break;
      case "staleDocId":
        if (sender.tab) await recordStaleDocId(msg);
        sendResponse({ ok: true });
        break;
      case "docIdBroken":
        await noteBrokenDocId(msg, sender);
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
