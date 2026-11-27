// Not Another Friend Sweeper background service worker.
// Orchestrates jobs (friend scan, engagement scan, removals) by driving a
// Facebook tab and messaging the content script. All job state lives in
// chrome.storage.local so the worker can be killed and revived safely.
// sync.js mirrors that data into chrome.storage.sync across browsers, and into
// Google Drive (drive.js) on browsers that connected it.

importScripts("drive.js", "sync.js", "license.js", "inbound.js");

const FB = "https://www.facebook.com";

// Alarm names. chrome.alarms survives service-worker shutdown, so every
// deferred step (pacing, cleanup, chaining, scheduling) hangs off one.
const ALARM_REMOVAL = "removal-step";
const ALARM_CLEANUP = "job-cleanup";
const ALARM_CHAIN = "job-chain";
// One-minute heartbeat, as in Not Another Social CRM: each tick runs the
// schedule if it's due and polls the incoming-webhook inbox if it's on.
// Checking "is it due?" every minute (rather than one long repeating alarm)
// survives extension reloads and lets a run that was blocked by a busy tab go
// as soon as the tab is free.
const ALARM_TICK = "tick";
const TICK_MINUTES = 1;
// Earlier versions armed one repeating alarm per schedule; cleared on wake.
const LEGACY_ALARM_AUTO = "auto-scan";

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
  await chrome.alarms.clear(ALARM_REMOVAL_START);
}

// Running, or a removal waiting out its undo window: either way the job owns
// the Facebook tab, and nothing else may start.
function jobActive(job) {
  return !!(job && (job.status === "running" || job.status === "queued"));
}

// ---------------------------------------------------------------- activity log
//
// Every job — whoever started it (you, the schedule, a webhook) — gets one
// entry, written when it starts and updated when it ends. Webhook requests
// that were refused before any job started are logged too, so "why didn't my
// Zap do anything?" has an answer on the dashboard. Local to this browser,
// like the CRM's run records: what ran here is a fact about this machine.

const LOG_KEY = "activityLog";
const LOG_MAX = 200;

let logLock = Promise.resolve();
function logPut(entry) {
  const run = logLock.then(async () => {
    const { [LOG_KEY]: log = [] } = await getStore(LOG_KEY);
    const i = log.findIndex((e) => e.id === entry.id);
    if (i >= 0) log[i] = { ...log[i], ...entry };
    else log.unshift(entry);
    await setStore({ [LOG_KEY]: log.slice(0, LOG_MAX) });
  });
  logLock = run.catch(() => {});
  return run;
}

function newId() {
  return crypto.randomUUID();
}

const JOB_LABELS = {
  friendScan: "Scan friends",
  engagementScan: "Scan engagement",
  removal: "Remove friends",
};

// One line describing what a job did, for the log and webhook results.
function describeJob(job) {
  const p = job.progress || {};
  if (job.type === "friendScan") {
    return `${p.found || 0} friends found` + (p.dated ? `, ${p.dated} with friend dates` : "") +
      (p.gone ? `, ${p.gone} no longer on your friends list` : "");
  }
  if (job.type === "engagementScan") {
    return `${p.posts || 0} posts checked, ${p.events || 0} new reactions/comments` +
      (job.days ? ` (${job.days}-day window)` : "");
  }
  if (job.type === "removal") {
    return `${p.done || 0} of ${p.total || 0} removed` + (p.failed ? `, ${p.failed} failed` : "");
  }
  return "";
}

// Record a job's start. Every start* function goes through here.
async function beginJob(job, opts = {}) {
  job.logId = newId();
  job.trigger = opts.inbound ? "webhook" : opts.auto ? "schedule" : "manual";
  if (opts.chain && opts.chain.length) job.chain = opts.chain;
  if (opts.auto) job.auto = true;
  if (opts.inbound) job.inbound = opts.inbound;
  await setJob(job);
  await logPut({
    id: job.logId,
    kind: job.type,
    trigger: job.trigger,
    source: opts.inbound ? opts.inbound.label : null,
    startedAt: job.startedAt,
    status: "running",
    summary: describeJob(job),
  });
}

// Record a job's end, and answer the webhook that started it once its last
// step is over. status: "done" | "error" | "cancelled".
async function endJob(job, status, error) {
  if (job.logId) {
    const entry = {
      id: job.logId,
      status,
      finishedAt: Date.now(),
      summary: describeJob(job),
      error: error || null,
      warnings: Array.isArray(job.warnings) && job.warnings.length ? job.warnings : null,
    };
    if (job.type === "removal") entry.detail = await removalDetail(job);
    await logPut(entry);
  }
  if (job.type === "engagementScan" && status === "done") {
    await setStore({ lastEngagementScan: { at: Date.now(), days: job.days || 30 } });
  }
  const chainGoesOn = status === "done" && Array.isArray(job.chain) && job.chain.length;
  if (!chainGoesOn) await announceJobEnd(job, status, error);
  if (!job.inbound) return;
  const step = { scan: job.type, status, summary: describeJob(job), progress: job.progress || {} };
  if (error) step.error = error;
  if (job.warnings && job.warnings.length) step.warnings = job.warnings;
  job.inbound.steps = (job.inbound.steps || []).concat(step);
  const more = status === "done" && Array.isArray(job.chain) && job.chain.length;
  if (more) return; // the next step carries the request on (see runChainStep)
  await FriendInbound.complete(job.inbound.id, {
    status: status === "done" ? "done" : "failed",
    result: { command: job.inbound.command, steps: job.inbound.steps },
    ...(status === "done" ? {} : { error: error || (status === "cancelled" ? "Cancelled from the dashboard." : "Failed.") }),
  });
  job.inbound = null;
}

// ---------------------------------------------------------------- notifications
//
// Tell the user (and their tools) when something finished — mostly for the
// runs nobody was watching: scheduled and webhook ones. Both are opt-in and
// configured per browser in `notify` (chrome.storage.local):
//   { desktop: bool, webhookUrl: string, webhookOn: "all" | "unattended" }
// Desktop notifications use the optional "notifications" permission and the
// webhook the optional host permission for its site, both asked for when the
// user switches them on.

const NOTIFY_KEY = "notify";
const SUGGESTION_LIMIT = 100;

// Friends with no engagement who aren't protected or removed — the same rule
// as the dashboard's "suggested" badge.
async function currentSuggestions() {
  const { friends = {}, engagement = {} } = await getStore(["friends", "engagement"]);
  const engaged = new Set(Object.values(engagement).map((e) => e.friendKey));
  for (const f of Object.values(friends)) if (f.syncEng && (f.syncEng[0] || f.syncEng[1])) engaged.add(f.key);
  return Object.values(friends)
    .filter((f) => !f.removedAt && !f.goneAt && !f.whitelisted && !engaged.has(f.key))
    .map((f) => ({ name: f.name || "", url: f.url || "", friendedAt: f.friendedAt ? new Date(f.friendedAt).toISOString().slice(0, 10) : null }));
}

async function announceJobEnd(job, status, error) {
  const { [NOTIFY_KEY]: cfg } = await getStore(NOTIFY_KEY);
  if (!cfg) return;
  const label = JOB_LABELS[job.type] || "Job";
  const outcome = { done: "finished", error: "failed", cancelled: "was cancelled" }[status] || status;
  const summary = describeJob(job);

  if (cfg.desktop && chrome.notifications) {
    try {
      chrome.notifications.create("nafs-" + (job.logId || newId()), {
        type: "basic",
        iconUrl: chrome.runtime.getURL("icons/icon128.png"),
        title: `${label} ${outcome}`,
        message: [summary, error].filter(Boolean).join(" — ").slice(0, 250),
        priority: status === "done" ? 0 : 1,
      });
    } catch (e) {
      /* permission withdrawn — nothing to do */
    }
  }

  const url = typeof cfg.webhookUrl === "string" ? cfg.webhookUrl.trim() : "";
  const unattended = job.trigger === "schedule" || job.trigger === "webhook";
  if (!/^https:\/\//.test(url) || (cfg.webhookOn === "unattended" && !unattended && !job.test)) return;
  const payload = {
    event: "job." + (status === "done" ? "finished" : status === "error" ? "failed" : "cancelled"),
    product: "not-another-friend-sweeper",
    ...(job.test ? { test: true } : {}),
    job: {
      type: job.type,
      label,
      trigger: job.trigger || "manual",
      source: job.inbound ? job.inbound.label : null,
      status,
      summary,
      error: error || null,
      warnings: job.warnings || [],
      progress: job.progress || {},
      startedAt: new Date(job.startedAt || Date.now()).toISOString(),
      finishedAt: new Date().toISOString(),
    },
  };
  if (job.type === "removal") payload.job.detail = await removalDetail(job);
  if (job.type === "engagementScan" && status === "done") {
    const all = await currentSuggestions();
    payload.suggestions = { total: all.length, friends: all.slice(0, SUGGESTION_LIMIT) };
  }
  let result;
  try {
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    result = res.ok ? "sent" : `failed (HTTP ${res.status})`;
  } catch (e) {
    result = "failed (" + String((e && e.message) || e).slice(0, 80) + ")";
  }
  if (job.logId) await logPut({ id: job.logId, notified: "Result webhook " + result });
  return "Result webhook " + result;
}

// Names, not just counts, for a removal's log entry.
async function removalDetail(job) {
  const { friends = {} } = await getStore("friends");
  const name = (k) => (friends[k] && friends[k].name) || k;
  return {
    removed: (job.done || []).map(name),
    failed: (job.failed || []).map((f) => ({ name: name(f.key), error: f.error })),
  };
}

// A running job stopped before it finished: the tab closed, the content
// script hit an error, or the user pressed Cancel.
async function failJob(job, error) {
  job.status = "error";
  job.error = error;
  await setJob(job);
  await chrome.alarms.clear(ALARM_REMOVAL);
  await chrome.alarms.clear(ALARM_CHAIN);
  await endJob(job, "error", error);
  await setJob(job);
}

// Mark a job complete. A finished job lingers just long enough for the
// dashboard to show its result, then ALARM_CLEANUP removes it — the user never
// has to dismiss a banner for work that already ended.
// Jobs carrying a `chain` (scheduled multi-scan runs) start their next step
// instead of clearing.
async function finishJob(job) {
  job.status = "finished";
  job.finishedAt = Date.now();
  job.current = null;
  await endJob(job, "done");
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
  const opts = {
    chain,
    auto: job.auto,
    days: job.chainDays || job.days,
    tabId: job.tabId,
    inbound: job.inbound || null,
  };
  await clearJob();
  await startScanByType(type, opts);
}

function startScanByType(type, opts) {
  // "friendDatesScan" was its own step before it became part of Scan friends;
  // old schedules and synced settings may still name it.
  if (type === "friendScan" || type === "friendDatesScan") return startFriendScan(opts);
  if (type === "engagementScan") return startEngagementScan(opts);
  return Promise.resolve();
}

// Start the scans a webhook asked for (inbound.js). Never while another job is
// running — the poller already checks, this is the backstop.
async function startScansForWebhook(command, { days, inbound }) {
  const job = await getJob();
  if (jobActive(job)) return { ok: false, error: "Another job is running." };
  await clearJob();
  const chain = {
    "scan.friends": ["friendScan"],
    "scan.engagement": ["engagementScan"],
    "scan.all": ["friendScan", "engagementScan"],
  }[command];
  if (!chain) return { ok: false, error: "Unknown scan." };
  const { settings = {} } = await getStore("settings");
  const first = chain.shift();
  const d = days || settings.scanDays || 30;
  await startScanByType(first, { chain, inbound, days: d, chainDays: d });
  return { ok: true };
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

// "Scan friends" is one operation in three phases, each on its own page:
//   "all"    — the full friends list (/me/friends)
//   "recent" — the Recently-added tab, for friend order
//   "dates"  — the Activity Log's Friends category, for the date you became
//              friends. Best effort: if Facebook won't show it, the list and
//              order are still saved and the job ends with a note.
async function startFriendScan(opts = {}) {
  const tabId = await openJobTab(FB + "/me/friends", opts.tabId);
  await beginJob({
    type: "friendScan",
    status: "running",
    phase: "all",
    tabId,
    startedAt: Date.now(),
    progress: { found: 0, dated: 0 },
    // The engagement window for a later step in the chain (this scan has none).
    ...(opts.chainDays || opts.days ? { chainDays: opts.chainDays || opts.days } : {}),
  }, opts);
}

// The activity log lives under the user's own profile path. Prefer the
// concrete profile URL captured during earlier scans; /me works too.
async function friendDatesUrl() {
  const { selfUrl } = await getStore("selfUrl");
  let base = FB + "/me";
  if (selfUrl) {
    const m = selfUrl.match(/profile\.php\?id=(\d+)/);
    base = m ? FB + "/" + m[1] : selfUrl;
  }
  return base +
    "/allactivity/?category_key=FRIENDS&filter_hidden=ALL&filter_privacy=NONE&manage_mode=false";
}

async function startEngagementScan(opts = {}) {
  // The look-back window is a plan feature: clamp it to what the plan allows
  // (scheduled and webhook runs get here too, not just the dashboard button).
  const ent = await NAFS.getEntitlement();
  const days = Math.min(opts.days || 30, ent.maxScanDays || NAFS.FREE_MAX_SCAN_DAYS);
  const tabId = await openJobTab(FB + "/me", opts.tabId);
  await beginJob({
    type: "engagementScan",
    status: "running",
    tabId,
    startedAt: Date.now(),
    days,
    maxPosts: 400, // hard safety cap regardless of window
    progress: { posts: 0, events: 0 },
  }, opts);
}

// Removals wait this long before anything is sent, so "Undo" in the banner
// can call them off. Adjustable in Settings (undoDelaySec, 0 = start at once).
const DEFAULT_UNDO_SEC = 30;
const MAX_UNDO_SEC = 300;
function undoMsFrom(settings) {
  const sec = Number(settings && settings.undoDelaySec);
  if (!Number.isFinite(sec)) return DEFAULT_UNDO_SEC * 1000;
  return Math.round(Math.min(MAX_UNDO_SEC, Math.max(0, sec))) * 1000;
}
const ALARM_REMOVAL_START = "removal-start";
const DEFAULT_DAILY_CAP = 75;

// Removals the extension made today (local time) — the number the daily cap
// and the dashboard's meter count. Hand-marked removals aren't ours.
function removedToday(friends) {
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  return Object.values(friends).filter(
    (f) => f.removedAt && !f.removedManually && f.removedAt >= midnight.getTime()
  ).length;
}

async function startRemoval(friendKeys) {
  const { friends = {}, settings = {} } = await getStore(["friends", "settings"]);
  const cap = settings.maxRemovalsPerRun || 20;
  let queue = friendKeys
    .filter((k) => friends[k] && !friends[k].removedAt && !friends[k].goneAt && !friends[k].whitelisted)
    .slice(0, cap);
  if (!queue.length) return { ok: false, error: "Nobody in the selection can be removed." };

  // Daily cap: a fast day of unfriending is what gets accounts action-blocked.
  const dailyCap = settings.maxRemovalsPerDay || DEFAULT_DAILY_CAP;
  const leftToday = Math.max(0, dailyCap - removedToday(friends));
  if (!leftToday) {
    return {
      ok: false,
      error: `You've hit your daily safety limit of ${dailyCap} removals. It resets at midnight, and you can change it in Settings. This isn't a plan limit: it spaces removals out so Facebook doesn't action-block your account.`,
    };
  }
  const warnings = [];
  if (queue.length > leftToday) {
    warnings.push(`Daily safety limit: ${queue.length - leftToday} of your selection were held back for tomorrow (${dailyCap} a day, changeable in Settings).`);
    queue = queue.slice(0, leftToday);
  }

  // Free accounts have a monthly removal allowance, counted on the server.
  const allowance = await NAFS.allowRemovals(queue.length);
  if (!allowance.allowed) {
    return { ok: false, error: allowance.error, upgrade: !!allowance.upgrade };
  }
  const trimmed = queue.length - allowance.allowed;
  queue = queue.slice(0, allowance.allowed);
  if (trimmed) {
    warnings.push(`Free plan: ${trimmed} of your selection were held back — that's all of this month's free removals. Upgrade to Pro for unlimited removals.`);
  }

  // Same defaults and ~30s floor the dashboard shows and the legacy flow uses.
  const minSec = Math.max(30, settings.removeDelayMinSec || 30);
  const maxSec = Math.max(minSec, settings.removeDelayMaxSec || 60);
  // Queued, not started: nothing touches Facebook until the undo window ends.
  const undoMs = undoMsFrom(settings);
  const queuedAt = Date.now();
  const startsAt = queuedAt + undoMs;
  await setJob({
    type: "removal",
    mode: "batch",
    status: "queued",
    queuedAt,
    startsAt,
    queue,
    done: [],
    failed: [],
    current: null,
    progress: { total: queue.length, done: 0, failed: 0 },
    delays: { minSec, maxSec },
    ...(warnings.length ? { warnings } : {}),
  });
  if (!undoMs) {
    await startQueuedRemoval();
  } else {
    // Chrome won't fire an alarm sooner than 30s, so a shorter window is timed
    // in the worker; the alarm stays as a backup in case the worker is
    // suspended first (startQueuedRemoval only runs a job that's still queued).
    if (undoMs < 30000) setTimeout(startQueuedRemoval, undoMs);
    chrome.alarms.create(ALARM_REMOVAL_START, { when: startsAt });
  }
  return { ok: true, trimmed, queued: queue.length, startsAt };
}

// "Run now" in the banner: skip the rest of the undo window.
async function runQueuedRemovalNow() {
  const job = await getJob();
  if (!job || job.type !== "removal" || job.status !== "queued") return;
  job.startsAt = Date.now();
  await setJob(job);
  await chrome.alarms.clear(ALARM_REMOVAL_START);
  await startQueuedRemoval();
}

// The undo window is over: open Facebook and start removing. The timer, the
// backup alarm and "Run now" can all land here, so only the first one starts it.
let removalStarting = false;
async function startQueuedRemoval() {
  if (removalStarting) return;
  removalStarting = true;
  try {
    await startQueuedRemovalOnce();
  } finally {
    removalStarting = false;
  }
}

async function startQueuedRemovalOnce() {
  const job = await getJob();
  if (!job || job.type !== "removal" || job.status !== "queued") return;
  if (Date.now() < job.startsAt - 1000) {
    chrome.alarms.create(ALARM_REMOVAL_START, { when: job.startsAt });
    return;
  }
  // Batch mode: open the friends page and remove the whole selection from it via
  // GraphQL unfriend mutations — no per-friend profile navigation. The friends
  // page is used (rather than the home feed) so the friends-collection token is
  // available, letting us resolve any missing numeric id via the friends search
  // API. The content script picks the batch up through its getJob handshake, and
  // falls back to the legacy per-profile flow if the API path can't run.
  const tabId = await openJobTab(FB + "/me/friends");
  job.status = "running";
  job.tabId = tabId;
  job.startedAt = Date.now();
  await beginJob(job);
}

// Remember how each removal went on the friend record itself, so the list can
// show who is still a friend after a failed attempt. Call inside the store lock.
function recordRemovalOutcome(friends, key, ok, error) {
  const f = friends[key];
  if (!f) return false;
  if (ok) {
    f.removedAt = Date.now();
    delete f.removeFailedAt;
    delete f.removeError;
  } else {
    f.removeFailedAt = Date.now();
    f.removeError = String(error || "unknown").slice(0, 200);
  }
  return true;
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
      if (recordRemovalOutcome(friends, msg.friendKey, msg.ok, msg.error)) friendsChanged = true;
      if (friendsChanged) await setStore({ friends });
    });
    if (msg.ok) {
      if (!job.done.includes(msg.friendKey)) {
        job.done.push(msg.friendKey);
        job.progress.done++;
        NAFS.recordRemoval();
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
  await withStoreLock(async () => {
    const { friends = {} } = await getStore("friends");
    if (recordRemovalOutcome(friends, msg.friendKey, msg.ok, msg.error)) await setStore({ friends });
  });
  if (msg.ok) {
    job.done.push(msg.friendKey);
    job.progress.done++;
    NAFS.recordRemoval();
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
  const minS = settings.removeDelayMinSec || 30;
  const maxS = settings.removeDelayMaxSec || 60;
  const delaySec = Math.max(30, minS + Math.random() * (maxS - minS));
  job.nextStepAt = Date.now() + delaySec * 1000;
  await setJob(job);
  chrome.alarms.create(ALARM_REMOVAL, { delayInMinutes: delaySec / 60 });
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_REMOVAL) removalNext();
  else if (alarm.name === ALARM_CLEANUP) cleanupFinishedJob();
  else if (alarm.name === ALARM_CHAIN) runChainStep();
  else if (alarm.name === ALARM_REMOVAL_START) startQueuedRemoval();
  else if (alarm.name === ALARM_TICK) onTick();
  else if (alarm.name === LEGACY_ALARM_AUTO) chrome.alarms.clear(LEGACY_ALARM_AUTO);
  else if (alarm.name === NAFS.ALARM) NAFS.refreshEntitlement().catch(() => {});
});

let ticking = null;
function onTick() {
  if (!ticking) {
    ticking = (async () => {
      await runDueSchedule().catch((e) => console.warn("[NAFS] schedule tick:", e));
      await FriendInbound.poll();
    })().finally(() => (ticking = null));
  }
  return ticking;
}

function ensureTickAlarm() {
  chrome.alarms.clear(LEGACY_ALARM_AUTO);
  chrome.alarms.get(ALARM_TICK, (existing) => {
    if (!existing) chrome.alarms.create(ALARM_TICK, { delayInMinutes: TICK_MINUTES, periodInMinutes: TICK_MINUTES });
  });
}

// A running job whose tab is gone can never report back, so it would otherwise
// sit "running" forever and keep the dashboard's actions disabled.
chrome.tabs.onRemoved.addListener(async (tabId) => {
  const job = await getJob();
  if (!job || job.status !== "running" || job.tabId !== tabId) return;
  await failJob(job, "the Facebook tab was closed before the job finished");
});

// ---------------------------------------------------------------- results

// A DOM scroll-scan that stops early (Facebook stalls loading) looks just like
// a finished one. Unless the API said the list was whole, only trust a pass
// that saw at least this share of the friends we already knew.
const PRUNE_MIN_SHARE = 0.9;

// After a full pass of the friends list, anyone on record who wasn't in it has
// left the list outside the extension (unfriended on Facebook, deactivated,
// changed their profile URL). Mark them `goneAt` rather than deleting them, so
// protection and history survive if they come back; the next scan that sees
// them clears it. Returns a warning when the pass looked too short to trust.
function pruneUnseenFriends(friends, scanStartedAt, complete, now) {
  const known = Object.values(friends).filter((f) => !f.removedAt && !f.goneAt);
  const seen = known.filter((f) => (f.lastSeen || 0) >= scanStartedAt);
  const unseen = known.filter((f) => (f.lastSeen || 0) < scanStartedAt);
  if (!unseen.length) return { gone: 0 };
  if (!seen.length || (!complete && seen.length < known.length * PRUNE_MIN_SHARE)) {
    return {
      gone: 0,
      warning: `The scan saw ${seen.length} of the ${known.length} friends on record, which looks incomplete, ` +
        "so nobody was marked as no longer a friend. Run Scan friends again to update the count.",
    };
  }
  // A changed profile URL shows up as a new key with the same numeric id:
  // carry protection over so it isn't lost with the old record.
  const byId = new Map(seen.filter((f) => f.profileId).map((f) => [f.profileId, f]));
  for (const f of unseen) {
    f.goneAt = now;
    const twin = f.profileId && byId.get(f.profileId);
    if (twin && f.whitelisted && !twin.whitelisted) {
      twin.whitelisted = true;
      twin.whitelistedAt = now;
    }
  }
  return { gone: unseen.length };
}

async function handleFriendScanResult(msg) {
  const now = Date.now();
  const job = await getJob();
  const ownJob = job && job.type === "friendScan" && job.status === "running";
  // The full-list phase finished: prune whoever it didn't see.
  const prune = ownJob && msg.done && msg.phase === "all" && job.phase === "all";
  let pruned = { gone: 0 };
  const friends = await withStoreLock(async () => {
    const { friends = {} } = await getStore("friends");
    msg.friends.forEach((f, i) => {
      const prev = friends[f.key];
      const next = friends[f.key] = {
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
      // On the list again (re-friended, or a short scan misjudged them).
      delete next.goneAt;
    });
    if (prune) pruned = pruneUnseenFriends(friends, job.startedAt, !!msg.complete, now);
    await setStore({ friends });
    return friends;
  });

  if (!job || job.type !== "friendScan") return;
  // Friends seen by this scan, not every record ever stored.
  job.progress.found = Object.values(friends)
    .filter((f) => !f.removedAt && (f.lastSeen || 0) >= job.startedAt).length;
  if (pruned.gone) job.progress.gone = pruned.gone;
  if (pruned.warning) {
    const warnings = Array.isArray(job.warnings) ? job.warnings : [];
    if (!warnings.includes(pruned.warning)) job.warnings = warnings.concat(pruned.warning);
  }
  // A stray "done" from a page the job has already moved past changes nothing.
  if (msg.done && msg.phase && msg.phase !== job.phase) return;
  if (msg.done) {
    const next = job.phase === "all" ? "recent" : job.phase === "recent" ? "dates" : null;
    if (next) {
      // Phase 2 walks "Recently added" for friend order; phase 3 the Activity
      // Log for friend dates.
      job.phase = next;
      await setJob(job);
      try {
        const url = next === "recent" ? FB + "/me/friends_recent" : await friendDatesUrl();
        await chrome.tabs.update(job.tabId, { url });
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

// The dates phase is a bonus on top of the friend list. If Facebook won't show
// the Activity Log, keep what the first two phases found and say so.
async function endFriendDatesEarly(job, error) {
  const note = `Friend dates couldn't be read from your Activity Log (${String(error).slice(0, 120)}). ` +
    "Your friend list and friend order were still saved.";
  const warnings = Array.isArray(job.warnings) ? job.warnings : [];
  if (!warnings.includes(note)) job.warnings = warnings.concat(note);
  await finishJob(job);
}

async function handleFriendDatesResult(msg) {
  const friends = await withStoreLock(async () => {
    const { friends = {} } = await getStore("friends");

    // Entries whose name link couldn't be resolved to a profile URL are
    // matched by exact name — but only when the name is unambiguous.
    const byName = new Map();
    for (const f of Object.values(friends)) {
      if (f.goneAt) continue;
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
      // The Activity Log also lists people you've since unfriended, so it only
      // dates friends the list scan found; it never adds anyone.
      if (!key || !friends[key] || friends[key].goneAt) continue;
      friends[key].friendedAt = e.friendedAt;
    }
    await setStore({ friends });
    return friends;
  });

  const job = await getJob();
  if (job && job.status === "running" &&
      (job.type === "friendDatesScan" || (job.type === "friendScan" && job.phase === "dates"))) {
    job.progress.dated = Object.values(friends).filter((f) => f.friendedAt && !f.goneAt).length;
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
//
// Same model as Not Another Social CRM's automations: nothing is armed per
// schedule. The one-minute tick asks "is it due?" (lastRunAt + period, with a
// minute of slack), so a reload can't lose the timer and a run that found the
// tab busy simply goes on the next free tick.
const DEFAULT_SCHEDULE = {
  enabled: false,
  everyHours: 24,
  days: 30,
  scans: ["friendScan", "engagementScan"],
  lastRunAt: 0,
  nextRunAt: 0,
  configAt: 0, // when the user last changed the schedule — orders synced edits
};

const SCAN_TYPES = ["friendScan", "engagementScan"];
const DUE_SLACK_MS = 60000;

// Friend dates used to be a scan of their own; they're part of friendScan now.
function normalizeScans(scans) {
  const list = Array.isArray(scans) ? scans : [];
  const mapped = list.map((s) => (s === "friendDatesScan" ? "friendScan" : s));
  return SCAN_TYPES.filter((t) => mapped.includes(t));
}

async function getSchedule() {
  const { schedule } = await getStore("schedule");
  const s = { ...DEFAULT_SCHEDULE, ...(schedule || {}) };
  s.scans = normalizeScans(s.scans);
  return s;
}

// Persist a schedule change and work out when it next runs.
async function applySchedule(patch) {
  const prev = await getSchedule();
  const sched = { ...prev, ...(patch || {}) };
  sched.everyHours = Math.max(1, Number(sched.everyHours) || 24);
  sched.days = Math.max(1, Number(sched.days) || 30);
  sched.scans = normalizeScans(sched.scans);
  sched.enabled = !!sched.enabled && sched.scans.length > 0;

  const period = sched.everyHours * 3600000;
  if (!sched.enabled) sched.nextRunAt = 0;
  else if (sched.lastRunAt) sched.nextRunAt = sched.lastRunAt + period;
  // Never run yet: the first run is one period after switching on.
  else if (prev.enabled && prev.nextRunAt) sched.nextRunAt = Math.min(prev.nextRunAt, Date.now() + period);
  else sched.nextRunAt = Date.now() + period;

  await setStore({ schedule: sched });
  return sched;
}

async function runDueSchedule() {
  const sched = await getSchedule();
  if (!sched.enabled || !sched.nextRunAt) return;
  if (Date.now() < sched.nextRunAt - DUE_SLACK_MS) return;
  await runScheduledScan(false);
}

chrome.runtime.onInstalled.addListener(ensureTickAlarm);
chrome.runtime.onStartup.addListener(ensureTickAlarm);
chrome.runtime.onInstalled.addListener(NAFS.ensureAlarm);
chrome.runtime.onStartup.addListener(NAFS.ensureAlarm);

// ---------------------------------------------------------------- sync

FriendSync.init({
  applySchedule,
  isJobRunning: async () => jobActive(await getJob()),
  // Another browser deleted everything; the wiped schedule reads as "off", so
  // the tick has nothing left to run. Nothing to clear here any more.
  // The activity log names people, so it goes with the rest of the data.
  afterWipe: () => chrome.storage.local.remove(LOG_KEY),
});

FriendInbound.init({
  isBusy: async () => jobActive(await getJob()),
  deviceId,
  startScans: startScansForWebhook,
  logRequest: ({ command, label, status, error }) =>
    logPut({
      id: newId(),
      kind: "webhook",
      trigger: "webhook",
      source: label,
      startedAt: Date.now(),
      finishedAt: Date.now(),
      status,
      summary: `Request "${command}"` + (status === "done" ? " answered" : " refused"),
      error: error || null,
    }),
});

// A random id for this browser, so a webhook result says which one ran it.
async function deviceId() {
  const { deviceId: id } = await getStore("deviceId");
  if (id) return id;
  const next = "browser-" + newId().slice(0, 8);
  await setStore({ deviceId: next });
  return next;
}

// Make sure the tick is running whenever the worker wakes, not only on
// install/startup events (a worker revived by a message counts too).
ensureTickAlarm();

// `force` is the dashboard's "Run now": it runs the configured sequence even
// when the repeating schedule is switched off, and leaves the timer alone.
async function runScheduledScan(force) {
  const sched = await getSchedule();
  if ((!sched.enabled && !force) || !sched.scans.length) return;

  // Scheduled scans are a Pro feature. A lapsed plan switches the timer off
  // rather than leaving it to fire into a locked feature.
  const ent = await NAFS.getEntitlement();
  if (!ent.scheduledScans) {
    if (sched.enabled && !ent.stale) await applySchedule({ enabled: false, configAt: Date.now() });
    return;
  }

  // The schedule syncs, so every signed-in browser has the same alarm. Only
  // one should scan per interval: lastRunAt syncs too, and a run another
  // browser started this round means this tick has nothing to do.
  const period = sched.everyHours * 3600000;
  if (!force && sched.lastRunAt && Date.now() - sched.lastRunAt < period * 0.9) {
    if (sched.enabled) {
      sched.nextRunAt = sched.lastRunAt + period;
      await setStore({ schedule: sched });
    }
    return;
  }

  const job = await getJob();
  if (jobActive(job)) {
    // Something is already driving a Facebook tab — a manual scan, a webhook,
    // or the previous scheduled run still going. Don't fight it: the run stays
    // due and the next tick after the job ends starts it.
    return;
  }
  await clearJob();

  const chain = sched.scans.slice();
  const first = chain.shift();
  sched.lastRunAt = Date.now();
  if (sched.enabled) sched.nextRunAt = Date.now() + period;
  await setStore({ schedule: sched });
  await startScanByType(first, { chain, auto: true, days: sched.days, chainDays: sched.days });
}

// ---------------------------------------------------------------- messages

// Commands from the dashboard that need a signed-in account, and the plan
// feature (if any) each one needs on top of that.
const GATED_CMDS = {
  startFriendScan: null,
  startEngagementScan: "maxScanDays",
  startRemoval: null,
  markRemoved: null,
  setSchedule: "scheduledScans",
  runScheduleNow: "scheduledScans",
  // Webhooks are an automation feature, like the schedule.
  inboundSetSettings: "scheduledScans",
  inboundTokenCreate: "scheduledScans",
  inboundTokens: null,
  inboundTokenRevoke: null,
  inboundRecent: null,
  inboundPollNow: "scheduledScans",
};

async function gate(msg, sender) {
  // Content scripts never send these; only extension pages do.
  if (sender.tab && !sender.url?.startsWith(chrome.runtime.getURL(""))) return null;
  if (!(msg.cmd in GATED_CMDS)) return null;
  const ent = await NAFS.getEntitlement();
  if (!ent.signedIn) {
    return { ok: false, signedOut: true, error: "Sign in to your Not Another Friend Sweeper account to use the extension." };
  }
  const need = GATED_CMDS[msg.cmd];
  if (need === "scheduledScans" && !ent.scheduledScans) {
    // Switching the schedule off is always allowed.
    if (msg.cmd === "setSchedule" && !(msg.schedule && msg.schedule.enabled)) return null;
    if (msg.cmd === "inboundSetSettings" && !(msg.patch && msg.patch.enabled)) return null;
    return {
      ok: false,
      upgrade: true,
      error: msg.cmd.startsWith("inbound")
        ? "Incoming webhooks are a Pro feature."
        : "Scheduled scans are a Pro feature.",
    };
  }
  if (need === "maxScanDays" && (msg.days || 30) > ent.maxScanDays) {
    return {
      ok: false,
      upgrade: true,
      error: `Free accounts can scan back ${ent.maxScanDays} days. Upgrade to Pro to scan back up to a year.`,
    };
  }
  return null;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    const blocked = await gate(msg, sender);
    if (blocked) {
      sendResponse(blocked);
      return;
    }
    switch (msg.cmd) {
      // ---- account
      case "getAccount":
        sendResponse({ entitlement: await NAFS.getEntitlement(!!msg.force), platformUrl: NAFS.PLATFORM_URL });
        break;
      case "signIn":
        NAFS.openWebSignIn();
        sendResponse({ ok: true });
        break;
      case "signOut":
        await NAFS.signOut();
        sendResponse({ ok: true });
        break;
      case "openBilling":
        chrome.tabs.create({ url: NAFS.billingUrl() });
        sendResponse({ ok: true });
        break;
      case "openSupport":
        chrome.tabs.create({ url: NAFS.supportUrl() });
        sendResponse({ ok: true });
        break;
      case "openAccount":
        chrome.tabs.create({ url: NAFS.accountUrl() });
        sendResponse({ ok: true });
        break;

      // ---- from the dashboard / popup
      case "startFriendScan":
        if (jobActive(await getJob())) {
          sendResponse({ ok: false, error: "Another job is running. Wait for it to finish, or cancel it from its banner." });
          break;
        }
        await startFriendScan();
        sendResponse({ ok: true });
        break;
      case "startEngagementScan":
        if (jobActive(await getJob())) {
          sendResponse({ ok: false, error: "Another job is running. Wait for it to finish, or cancel it from its banner." });
          break;
        }
        await startEngagementScan({ days: msg.days });
        sendResponse({ ok: true });
        break;
      case "startRemoval":
        if (jobActive(await getJob())) {
          sendResponse({ ok: false, error: "Another job is running. Wait for it to finish, or cancel it from its banner." });
          break;
        }
        sendResponse(await startRemoval(msg.friendKeys || []));
        break;
      case "runQueuedNow":
        await runQueuedRemovalNow();
        sendResponse({ ok: true });
        break;
      case "cancelJob": {
        const job = await getJob();
        if (job && job.tabId != null) sendToTab(job.tabId, { cmd: "abort" });
        if (job && job.status === "running") {
          job.status = "cancelled";
          await endJob(job, "cancelled", "Cancelled");
        } else if (job && job.status === "queued") {
          // Undone inside the window: nothing was sent to Facebook.
          await logPut({
            id: newId(), kind: "removal", trigger: "manual",
            startedAt: job.queuedAt || Date.now(), finishedAt: Date.now(), status: "cancelled",
            summary: `Undone before it started — ${job.queue.length} ${job.queue.length === 1 ? "friend" : "friends"} kept`,
          });
        }
        await clearJob();
        sendResponse({ ok: true });
        break;
      }
      case "markRemoved": {
        // The person was unfriended by hand on Facebook after the extension
        // couldn't do it. Not counted against the free allowance: the extension
        // didn't remove them.
        const names = [];
        await withStoreLock(async () => {
          const { friends = {} } = await getStore("friends");
          const now = Date.now();
          for (const k of msg.keys || []) {
            const f = friends[k];
            if (!f || f.removedAt) continue;
            f.removedAt = now;
            f.removedManually = true;
            delete f.removeFailedAt;
            delete f.removeError;
            names.push(f.name || k);
          }
          await setStore({ friends });
        });
        if (names.length) {
          await logPut({
            id: newId(), kind: "manualRemoval", trigger: "manual",
            startedAt: Date.now(), finishedAt: Date.now(), status: "done",
            summary: `Marked ${names.length} as removed by hand`, detail: { removed: names },
          });
        }
        sendResponse({ ok: true, marked: names.length });
        break;
      }
      case "clearRemoveFailed": {
        // "Keep them" — the user decided not to retry.
        await withStoreLock(async () => {
          const { friends = {} } = await getStore("friends");
          for (const k of msg.keys || []) {
            if (!friends[k]) continue;
            delete friends[k].removeFailedAt;
            delete friends[k].removeError;
          }
          await setStore({ friends });
        });
        sendResponse({ ok: true });
        break;
      }
      case "getActivityLog": {
        const { [LOG_KEY]: log = [] } = await getStore(LOG_KEY);
        sendResponse({ ok: true, log });
        break;
      }
      case "clearActivityLog":
        await chrome.storage.local.remove(LOG_KEY);
        sendResponse({ ok: true });
        break;

      // ---- finish notifications (desktop + result webhook)
      case "getNotify": {
        const { [NOTIFY_KEY]: cfg } = await getStore(NOTIFY_KEY);
        sendResponse({ ok: true, notify: { desktop: false, webhookUrl: "", webhookOn: "all", ...(cfg || {}) } });
        break;
      }
      case "setNotify": {
        const { [NOTIFY_KEY]: cur } = await getStore(NOTIFY_KEY);
        const next = { desktop: false, webhookUrl: "", webhookOn: "all", ...(cur || {}), ...(msg.patch || {}) };
        next.desktop = !!next.desktop;
        next.webhookUrl = String(next.webhookUrl || "").trim().slice(0, 500);
        next.webhookOn = next.webhookOn === "unattended" ? "unattended" : "all";
        if (next.webhookUrl && !/^https:\/\//.test(next.webhookUrl)) {
          sendResponse({ ok: false, error: "The result webhook address must start with https://" });
          break;
        }
        await setStore({ [NOTIFY_KEY]: next });
        sendResponse({ ok: true, notify: next });
        break;
      }
      case "testNotify": {
        // A sample "finished" event, so a Zap can be built before a real run.
        const sent = await announceJobEnd({
          type: "engagementScan", trigger: "manual", startedAt: Date.now() - 60000, days: 30,
          progress: { posts: 12, events: 34 }, logId: null, test: true,
        }, "done", null);
        sendResponse({ ok: true, result: sent ? sent + "." : "Desktop notification shown." });
        break;
      }

      // ---- incoming webhooks (inbound.js)
      case "inboundInfo":
        sendResponse({
          ok: true,
          settings: await FriendInbound.getSettings(),
          status: await FriendInbound.getStatus(),
          endpointUrl: await FriendInbound.endpointUrl(),
          commands: FriendInbound.COMMANDS,
        });
        break;
      case "inboundSetSettings":
        sendResponse({ ok: true, settings: await FriendInbound.setSettings(msg.patch || {}) });
        break;
      case "inboundTokens":
        sendResponse(await FriendInbound.listTokens());
        break;
      case "inboundTokenCreate":
        sendResponse(await FriendInbound.createToken(msg.label));
        break;
      case "inboundTokenRevoke":
        sendResponse(await FriendInbound.revokeToken(String(msg.id || "")));
        break;
      case "inboundRecent":
        sendResponse(await FriendInbound.listRecent(20));
        break;
      case "inboundPollNow":
        sendResponse({ ok: true, status: await FriendInbound.poll() });
        break;
      case "dismissJob": {
        // Clears the result banner for a job that already ended. Never touches
        // a running job — cancelling is a separate, explicit action.
        const job = await getJob();
        if (job && !jobActive(job)) await clearJob();
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
      // Google Drive sync (drive.js / sync.js). Connect opens Google's consent
      // the first time; after that tokens renew without the user.
      case "driveConnect":
        sendResponse(await FriendSync.driveConnect());
        break;
      case "driveDisconnect":
        sendResponse(await FriendSync.driveDisconnect());
        break;
      case "driveStatus":
        sendResponse({ ok: true, status: await FriendSync.driveStatus() });
        break;
      case "wipeAll": {
        const job = await getJob();
        if (job && job.tabId != null) sendToTab(job.tabId, { cmd: "abort" });
        if (job && job.status === "running") await endJob(job, "cancelled", "All data was deleted");
        await chrome.alarms.clear(ALARM_REMOVAL);
        await chrome.alarms.clear(ALARM_CLEANUP);
        await chrome.alarms.clear(ALARM_CHAIN);
        await FriendSync.wipeEverywhere();
        await chrome.storage.local.remove(LOG_KEY);
        sendResponse({ ok: true });
        break;
      }
      case "runScheduleNow": {
        const job = await getJob();
        if (jobActive(job)) {
          sendResponse({ ok: false, error: "A job is already running. Wait for it to finish, or cancel it from its banner." });
          break;
        }
        await runScheduledScan(true);
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
        if (job && job.status === "running") {
          if (job.type === "friendScan" && job.phase === "dates") await endFriendDatesEarly(job, msg.error);
          else await failJob(job, msg.error);
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

// ---------------------------------------------------------------- sign-in handoff
//
// The website's /extension-auth page posts the signed-in session here after
// the person signs in there (Google or email). Only origins listed in the
// manifest's externally_connectable can reach this, and license.js checks the
// sender origin again before accepting anything.
chrome.runtime.onMessageExternal.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== "object") return;
  if (msg.type === "NAFS_PING") {
    sendResponse({ ok: true, version: chrome.runtime.getManifest().version });
    return;
  }
  if (msg.type !== "NAFS_EXTENSION_SESSION") return;
  NAFS.adoptExternalSession(msg.payload, sender.origin).then(sendResponse);
  return true;
});
