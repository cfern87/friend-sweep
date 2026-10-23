// FriendSweep dashboard. Reads friends + engagement events from
// chrome.storage.local, computes per-friend scores, and drives jobs
// via the background worker. Edits to synced data (protection, settings,
// wipe) go through the worker too, which stamps them for cross-browser sync.

const $ = (id) => document.getElementById(id);

const SETTINGS_DEFAULTS = {
  maxRemovalsPerRun: 20,
  removeDelayMinSec: 30,
  removeDelayMaxSec: 60,
  // Protected friends are ones you've already decided to keep, so they're
  // noise in a clean-up list — hidden until you ask for them.
  hideProtected: true,
};

let friends = {};
let engagement = {};
let settings = {};
let schedule = null;
let job = null;
let syncState = null;
let docIds = {};
const selected = new Set();

// How long a finished job's result banner stays on screen before it clears
// itself. The background worker also sweeps finished jobs, so the banner still
// goes away if the dashboard isn't open.
const JOB_BANNER_MS = 10000;
let jobDismissTimer = null;

// Pagination state. `page` is 1-based; `lastPageRows`/`lastMatched` cache the
// current view so the select-all handlers can act without re-deriving it.
let page = 1;
let pageSize = 50;
let lastPageRows = [];
let lastMatched = 0;
// Keys of every selectable row the current filter matches — not just the
// visible page — so select-all/clear can act on the full set cheaply.
let lastMatchedKeys = [];

// ------------------------------------------------------------- data

async function load() {
  // Pull from other browsers now rather than waiting for the next change.
  chrome.runtime.sendMessage({ cmd: "syncNow" }).catch(() => {});
  const data = await chrome.storage.local.get([
    "friends", "engagement", "settings", "job", "schedule", "syncState", "docIds",
  ]);
  friends = data.friends || {};
  engagement = data.engagement || {};
  settings = Object.assign({}, SETTINGS_DEFAULTS, data.settings || {});
  job = data.job || null;
  syncState = data.syncState || null;
  docIds = data.docIds || {};
  renderSync();
  renderDocIdDiag();
  // Ask the worker rather than trusting storage, so an unsaved schedule still
  // shows the same defaults the worker would run with.
  const resp = await chrome.runtime.sendMessage({ cmd: "getSchedule" }).catch(() => null);
  schedule = (resp && resp.schedule) || data.schedule || null;
  pageSize = settings.pageSize || 50;
  $("pageSize").value = String(pageSize);
  $("fltHideProtected").checked = settings.hideProtected !== false;
  render();
  renderSettings();
  renderSchedule();
}

function aggregates() {
  // friendKey -> {reactions, comments, lastAt}
  const agg = {};
  for (const ev of Object.values(engagement)) {
    const a = (agg[ev.friendKey] ||= { reactions: 0, comments: 0, lastAt: 0 });
    if (ev.type === "reaction") a.reactions++;
    else if (ev.type === "comment") a.comments++;
    if (ev.at > a.lastAt) a.lastAt = ev.at;
  }
  // Tallies synced from engagement scans run in other browsers.
  for (const f of Object.values(friends)) {
    const s = f.syncEng;
    if (!s) continue;
    const a = (agg[f.key] ||= { reactions: 0, comments: 0, lastAt: 0 });
    a.reactions = Math.max(a.reactions, s[0]);
    a.comments = Math.max(a.comments, s[1]);
    a.lastAt = Math.max(a.lastAt, s[2]);
  }
  return agg;
}

function hasSyncedEngagement() {
  return Object.values(friends).some((f) => f.syncEng);
}

// Settings edits go through the worker, which timestamps each changed field.
function saveSettings(patch) {
  Object.assign(settings, patch);
  return chrome.runtime.sendMessage({ cmd: "saveSettings", patch });
}

// Protection likewise: the worker stamps each friend so the newest change
// wins across browsers. The local copy is updated now for a snappy UI.
function setProtected(keys, value) {
  for (const k of keys) if (friends[k]) friends[k].whitelisted = value;
  return chrome.runtime.sendMessage({ cmd: "setProtected", keys, value });
}

function renderSync() {
  const el = $("syncStatus");
  const s = syncState || {};
  el.classList.toggle("error", !!s.lastError);
  if (s.lastError) {
    el.textContent = "Sync paused — " + s.lastError;
    return;
  }
  if (!s.lastSyncAt) {
    el.textContent = "Connecting to browser sync…";
    return;
  }
  let text = "Synced across your browsers · " + fmtWhen(s.lastSyncAt);
  const notes = [];
  if (s.decTruncated) notes.push(`${s.decTruncated} protect/removed marks didn't fit in browser sync`);
  if (s.truncated) notes.push(`scan details for ${s.truncated} friends didn't fit — other browsers fill them in on their next scan`);
  if (notes.length) {
    text += " · " + notes.join(" · ");
    el.title = "Chrome sync storage is capped at 100 KB per extension.";
  } else {
    el.title = "";
  }
  el.textContent = text;
}

function scoreOf(a) {
  return a ? a.reactions + a.comments * 2 : 0;
}

// ------------------------------------------------------------- render

function fmtDate(ts) {
  return ts ? new Date(ts).toLocaleDateString() : "—";
}

function visibleRows() {
  const agg = aggregates();
  const q = $("search").value.trim().toLowerCase();
  const noEng = $("fltNoEngagement").checked;
  const hideRemoved = $("fltHideRemoved").checked;
  const hideProtected = $("fltHideProtected").checked;
  const sortBy = $("sortBy").value;

  // Fallback label for friends whose stored name was scrubbed (e.g. the old
  // "1 mutual friend" mis-reads): show their profile slug until a re-scan
  // recaptures the real name.
  const slugOf = (f) => {
    const m = (f.url || "").match(/profile\.php\?id=(\d+)/);
    if (m) return "profile " + m[1];
    const seg = (f.url || "").split("/").filter(Boolean).pop();
    return seg || f.key;
  };

  let rows = Object.values(friends).map((f) => {
    const a = agg[f.key];
    return {
      ...f,
      name: f.name || slugOf(f),
      nameIsFallback: !f.name,
      reactions: a ? a.reactions : 0,
      comments: a ? a.comments : 0,
      score: scoreOf(a),
      lastAt: a ? a.lastAt : 0,
      rank: typeof f.recentRank === "number" ? f.recentRank : null,
      friendedAt: f.friendedAt || null,
      whitelisted: !!f.whitelisted,
    };
  });

  if (q) rows = rows.filter((r) => r.name.toLowerCase().includes(q));
  if (noEng) rows = rows.filter((r) => r.score === 0);
  if (hideRemoved) rows = rows.filter((r) => !r.removedAt);
  if (hideProtected) rows = rows.filter((r) => !r.whitelisted);

  rows.sort((x, y) => {
    // Rows without a friend-order rank sort last in the friended-* modes.
    const noRank = (r) => (r.rank === null ? 1 : 0);
    switch (sortBy) {
      case "score-desc": return y.score - x.score || x.name.localeCompare(y.name);
      case "name": return x.name.localeCompare(y.name);
      case "recent": return y.lastAt - x.lastAt || x.name.localeCompare(y.name);
      case "stale": return x.lastAt - y.lastAt || x.name.localeCompare(y.name);
      case "friended-new": {
        // Real dates first (newest→oldest), then rank-only rows, then rest.
        if (x.friendedAt && y.friendedAt)
          return y.friendedAt - x.friendedAt || x.name.localeCompare(y.name);
        if (x.friendedAt || y.friendedAt) return x.friendedAt ? -1 : 1;
        return noRank(x) - noRank(y) || (x.rank ?? 0) - (y.rank ?? 0) ||
          x.name.localeCompare(y.name);
      }
      case "friended-old": {
        if (x.friendedAt && y.friendedAt)
          return x.friendedAt - y.friendedAt || x.name.localeCompare(y.name);
        if (x.friendedAt || y.friendedAt) return x.friendedAt ? -1 : 1;
        return noRank(x) - noRank(y) || (y.rank ?? 0) - (x.rank ?? 0) ||
          x.name.localeCompare(y.name);
      }
      default: return x.score - y.score || x.name.localeCompare(y.name); // score-asc
    }
  });
  return rows;
}

function render() {
  const allRows = visibleRows();
  const tbody = $("rows");
  tbody.innerHTML = "";

  const total = Object.keys(friends).length;
  const removed = Object.values(friends).filter((f) => f.removedAt).length;
  const protectedCount = Object.values(friends).filter((f) => f.whitelisted).length;
  const scannedEvents = Object.keys(engagement).length;
  $("stats").innerHTML =
    `<b>${total}</b> friends · <b>${scannedEvents}</b> engagement events · ` +
    `<b>${protectedCount}</b> protected · <b>${removed}</b> removed`;

  $("empty").classList.toggle("hidden", total > 0);
  // "No matches" only applies once there are friends but the filters hide them.
  $("noMatch").classList.toggle("hidden", total === 0 || allRows.length > 0);

  const hasEngagementData = scannedEvents > 0 || hasSyncedEngagement();

  // Clamp the page to the filtered result size, then show just that slice.
  const matched = allRows.length;
  const pages = Math.max(1, Math.ceil(matched / pageSize));
  page = Math.min(Math.max(1, page), pages);
  const start = (page - 1) * pageSize;
  const rows = allRows.slice(start, start + pageSize);
  lastPageRows = rows;
  lastMatched = matched;
  lastMatchedKeys = allRows.filter((r) => !r.removedAt).map((r) => r.key);

  for (const r of rows) {
    const tr = document.createElement("tr");
    if (r.removedAt) tr.className = "removed";

    const tdSel = document.createElement("td");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = selected.has(r.key);
    cb.disabled = !!r.removedAt;
    // Protected friends are still tickable — the selection drives bulk actions
    // generally, not just removal. Removal itself skips them (see btnRemove).
    if (r.whitelisted) cb.title = "Protected — selectable, but skipped by Remove selected";
    cb.addEventListener("change", () => {
      cb.checked ? selected.add(r.key) : selected.delete(r.key);
      updateActionButtons();
      updateSelAllState(); // keep the page checkbox in step with the rows
    });
    tdSel.appendChild(cb);

    const tdAv = document.createElement("td");
    tdAv.className = "avatar";
    if (r.photo) {
      const img = document.createElement("img");
      img.src = r.photo;
      img.loading = "lazy";
      tdAv.appendChild(img);
    } else {
      tdAv.innerHTML = '<span class="noimg"></span>';
    }

    const tdName = document.createElement("td");
    const a = document.createElement("a");
    a.className = "name" + (r.nameIsFallback ? " fallback" : "");
    a.href = r.url;
    a.target = "_blank";
    a.textContent = r.name;
    if (r.nameIsFallback) a.title = "Name not captured yet — re-run “Scan friends” to fill it in";
    tdName.appendChild(a);

    const tdR = document.createElement("td");
    tdR.textContent = r.reactions;
    const tdC = document.createElement("td");
    tdC.textContent = r.comments;

    const tdScore = document.createElement("td");
    tdScore.className = "score" + (r.score === 0 ? " zero" : "");
    tdScore.textContent = r.score;

    const tdLast = document.createElement("td");
    tdLast.textContent = fmtDate(r.lastAt);

    const tdRank = document.createElement("td");
    if (r.friendedAt) {
      tdRank.textContent = fmtDate(r.friendedAt);
      tdRank.title = "Date friended (from your Activity Log)";
    } else if (r.rank !== null) {
      tdRank.textContent = "#" + (r.rank + 1);
      tdRank.title = `${r.rank + 1} of your most recently added friends — run "Scan friend dates" for the exact date`;
    } else {
      tdRank.textContent = "—";
      tdRank.title = "No friend-date data — run the friend and friend-dates scans";
    }

    const tdStatus = document.createElement("td");
    if (r.removedAt) {
      tdStatus.innerHTML = '<span class="badge removed">removed</span>';
    } else if (r.whitelisted) {
      tdStatus.innerHTML = '<span class="badge protected">protected</span>';
    } else if (hasEngagementData && r.score === 0) {
      tdStatus.innerHTML = '<span class="badge suggest">suggested</span>';
    } else {
      tdStatus.innerHTML = '<span class="badge">friend</span>';
    }

    // Protect toggle: whitelisted friends are never suggested and can't be
    // selected for removal (enforced here and again in the background worker).
    const tdProtect = document.createElement("td");
    tdProtect.className = "protectcell";
    const star = document.createElement("button");
    star.className = "protect" + (r.whitelisted ? " on" : "");
    star.textContent = r.whitelisted ? "★" : "☆";
    star.title = r.whitelisted
      ? "Protected from removal — click to unprotect"
      : "Protect this friend from removal";
    star.disabled = !!r.removedAt;
    star.addEventListener("click", () => toggleWhitelist(r.key));
    tdProtect.appendChild(star);

    tr.append(tdSel, tdAv, tdName, tdR, tdC, tdScore, tdLast, tdRank, tdStatus, tdProtect);
    tbody.appendChild(tr);
  }

  renderPager(matched, start, rows.length, pages);
  renderJob();
  updateActionButtons();
  updateSelAllState();
}

function renderPager(matched, start, count, pages) {
  const pager = $("pager");
  if (Object.keys(friends).length === 0) {
    pager.classList.add("hidden");
    return;
  }
  pager.classList.remove("hidden");
  const from = matched === 0 ? 0 : start + 1;
  $("pageInfo").textContent = `Showing ${from}–${start + count} of ${matched} matching`;
  $("pageNum").textContent = `Page ${page} / ${pages}`;
  $("pgFirst").disabled = $("pgPrev").disabled = page <= 1;
  $("pgNext").disabled = $("pgLast").disabled = page >= pages;
}

// Rows on the current page that can actually be ticked. Only already-removed
// friends are off-limits; protected ones can be selected for bulk actions.
function pageSelectable() {
  return lastPageRows.filter((r) => !r.removedAt);
}

// Has the selection been widened to everything the current filter matches?
function allMatchingSelected() {
  return lastMatchedKeys.length > 0 && lastMatchedKeys.every((k) => selected.has(k));
}

// The "Select page" checkbox reflects this page only; when the whole page is
// already ticked and more rows match the filter, offer a one-click select-all.
function updateSelAllState() {
  const selectable = pageSelectable();
  const chosen = selectable.filter((r) => selected.has(r.key)).length;
  const pageAllSelected = selectable.length > 0 && chosen === selectable.length;

  const box = $("selAll");
  // With nothing tickable on the page the box would silently spring back to
  // unchecked on every click, which reads as "broken" — disable it instead.
  box.disabled = selectable.length === 0;
  box.title = selectable.length === 0
    ? "Nothing on this page can be selected — every row is already removed"
    : "";
  box.checked = pageAllSelected;
  box.indeterminate = chosen > 0 && !pageAllSelected;

  // Rows selected on other pages are invisible from here, so the link doubles
  // as the way to reach them: widen the selection to everything the filter
  // matches, or — once there's anything off-page — clear the lot.
  const link = $("selAllMatch");
  const offPage = selected.size - chosen;
  if (pageAllSelected && !allMatchingSelected() && lastMatched > lastPageRows.length) {
    link.textContent = `Select all ${lastMatched} matching`;
    link.dataset.action = "extend";
    link.classList.remove("hidden");
  } else if (offPage > 0) {
    link.textContent = `Clear selection (${selected.size})`;
    link.dataset.action = "clear";
    link.classList.remove("hidden");
  } else {
    link.classList.add("hidden");
  }
}

// The selection can hold a mix of protected and unprotected friends, so each
// action is labelled with the count it would actually affect.
function selectionSplit() {
  const live = [...selected].filter((k) => friends[k] && !friends[k].removedAt);
  // Unprotected + not removed is exactly the set that can be queued OR protected.
  return {
    open: live.filter((k) => !friends[k].whitelisted),
    unprotectable: live.filter((k) => friends[k].whitelisted),
  };
}

function updateActionButtons() {
  const { open, unprotectable } = selectionSplit();

  const btn = $("btnRemove");
  btn.textContent = `Remove selected (${open.length})`;
  btn.disabled = open.length === 0 || (job && job.status === "running");

  // Protect/unprotect are local storage changes, so they're fine mid-job.
  const pBtn = $("btnProtect");
  pBtn.textContent = `Protect selected (${open.length})`;
  pBtn.disabled = open.length === 0;

  const uBtn = $("btnUnprotect");
  uBtn.textContent = `Unprotect selected (${unprotectable.length})`;
  uBtn.disabled = unprotectable.length === 0;
}

function renderJob() {
  const bar = $("jobBar");
  const running = !!(job && job.status === "running");
  // Cancelling only means something while work is actually in flight.
  $("btnCancel").disabled = !running;
  $("btnCancel").title = running ? "" : "No job is running";

  if (!job) {
    if (jobDismissTimer) {
      clearTimeout(jobDismissTimer);
      jobDismissTimer = null;
    }
    bar.classList.add("hidden");
    bar.textContent = "";
    return;
  }
  bar.classList.remove("hidden", "error", "finished");
  bar.textContent = "";
  let text = "";
  const p = job.progress || {};
  if (job.type === "friendScan") {
    const phase = job.phase === "recent" ? " (capturing friend order)" : "";
    text = `Friend scan ${job.status}${phase} — ${p.found || 0} friends found`;
  } else if (job.type === "friendDatesScan") {
    text = `Friend-dates scan ${job.status} — ${p.dated || 0} friends dated`;
  } else if (job.type === "engagementScan") {
    const win = job.days ? ` (${job.days}d window)` : "";
    text = `Engagement scan ${job.status}${win} — ${p.posts || 0} posts, ${p.events || 0} new events`;
  } else if (job.type === "removal") {
    text = `Removal ${job.status} — ${p.done || 0}/${p.total || 0} removed` +
      (p.failed ? `, ${p.failed} failed` : "");
    if (job.status === "running" && job.nextStepAt && job.nextStepAt > Date.now()) {
      text += ` · next in ~${Math.round((job.nextStepAt - Date.now()) / 1000)}s`;
    }
  }
  if (job.auto) text = "Scheduled · " + text;
  if (Array.isArray(job.chain) && job.chain.length) {
    text += ` · ${job.chain.length} more scan${job.chain.length === 1 ? "" : "s"} queued`;
  }
  if (job.status === "error") {
    bar.classList.add("error");
    text += ` — ${job.error || ""}`;
  }
  // Notes from a job that finished by a slower fallback path (e.g. Facebook
  // retired a request id). Shown like an error and left up until dismissed.
  const warnings = Array.isArray(job.warnings) ? job.warnings : [];
  if (warnings.length) {
    bar.classList.add("error");
    text += ` — ${warnings.join("; ")}`;
  }
  if (job.status === "finished") bar.classList.add("finished");

  const label = document.createElement("span");
  label.textContent = text;
  bar.appendChild(label);

  if (!running) {
    // A job that has ended clears itself; the × is just for the impatient (and
    // for errors, which stay put until they've been read). Mid-chain it's also
    // the way to call off the scans still queued behind this one.
    const chained = Array.isArray(job.chain) && job.chain.length > 0;
    const x = document.createElement("button");
    x.className = "jobclose";
    x.textContent = "×";
    x.title = chained ? "Stop the remaining scans" : "Dismiss";
    x.addEventListener("click", dismissJob);
    bar.appendChild(x);
    // Auto-dismissing a chained job would clear the job the next scan is
    // waiting on, so leave it up until the chain moves on by itself.
    if (job.status === "finished" && !chained && !warnings.length) scheduleJobDismiss();
  }
}

function dismissJob() {
  if (jobDismissTimer) {
    clearTimeout(jobDismissTimer);
    jobDismissTimer = null;
  }
  chrome.runtime.sendMessage({ cmd: "dismissJob" });
}

// Retire the finished-job banner on its own, measured from when the job
// actually ended so a reopened dashboard doesn't restart the clock.
function scheduleJobDismiss() {
  if (jobDismissTimer) return;
  const elapsed = Date.now() - (job.finishedAt || Date.now());
  jobDismissTimer = setTimeout(() => {
    jobDismissTimer = null;
    if (job && job.status === "finished") dismissJob();
  }, Math.max(1000, JOB_BANNER_MS - elapsed));
}

function renderSettings() {
  $("setMaxRemovals").value = settings.maxRemovalsPerRun;
  $("setDelayMin").value = settings.removeDelayMinSec;
  $("setDelayMax").value = settings.removeDelayMaxSec;
  if (settings.scanDays) $("scanDays").value = String(settings.scanDays);
}

// ------------------------------------------------------------- diagnostics

// Facebook request ids ("doc_ids") per operation, for support requests: which
// ones run on the extension's built-in id and which on one learned from
// Facebook's own traffic. Friendly names mirror OPS in content/graph.js.
const DOC_ID_LABELS = [
  ["ProfileCometAppCollectionSelfFriendsListRendererPaginationQuery", "Friends list"],
  ["FriendingCometUnfriendMutation", "Unfriend"],
  ["ProfileCometTimelineFeedRefetchQuery", "Timeline"],
  ["CometUFIReactionsDialogTabContentRefetchQuery", "Reactions"],
  ["CometUFICommentsProviderPaginationQuery", "Comments"],
];

function docIdState(e) {
  if (!e) return { text: "built-in" };
  if (!e.docId && e.seedRejected && e.seedRejected === e.seed) {
    return { text: `needs update (Facebook rejected it ${fmtWhen(e.seedRejectedAt)})`, bad: true };
  }
  if (e.docId && e.docId === e.seed) return { text: `built-in, confirmed ${fmtWhen(e.seenAt)}` };
  if (e.docId) return { text: `learned ${fmtWhen(e.seenAt)}` };
  if (e.staleAt) return { text: `built-in (learned id rejected ${fmtWhen(e.staleAt)})` };
  return { text: "built-in" };
}

function renderDocIdDiag() {
  const el = $("docIdDiag");
  if (!el) return;
  el.textContent = "Facebook request ids: ";
  const detail = [];
  DOC_ID_LABELS.forEach(([name, label], i) => {
    const e = docIds[name];
    const st = docIdState(e);
    const span = document.createElement("span");
    span.textContent = `${label} — ${st.text}`;
    if (st.bad) span.className = "bad";
    if (i) el.appendChild(document.createTextNode(" · "));
    el.appendChild(span);
    const id = e && e.docId ? e.docId : "built-in" + (e && e.seed ? " " + e.seed : "");
    detail.push(name + ": " + id);
  });
  // Exact ids on hover, to paste into a support request.
  el.title = detail.join("\n");
}

// ------------------------------------------------------------- schedule

const SCAN_BOXES = {
  friendScan: "autoScanFriends",
  friendDatesScan: "autoScanDates",
  engagementScan: "autoScanEngagement",
};

function fmtWhen(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  const today = new Date().toDateString() === d.toDateString();
  return (today ? "today " : d.toLocaleDateString() + " ") +
    d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function renderSchedule() {
  const s = schedule || {};
  $("autoEnabled").checked = !!s.enabled;
  $("autoEvery").value = String(s.everyHours || 24);
  $("autoDays").value = String(s.days || 30);
  const chosen = s.scans || ["friendScan", "engagementScan"];
  for (const [type, id] of Object.entries(SCAN_BOXES)) {
    $(id).checked = chosen.includes(type);
  }
  // Every control below the switch only matters once it's on.
  for (const id of ["autoEvery", "autoDays", ...Object.values(SCAN_BOXES)]) {
    $(id).disabled = !s.enabled;
  }

  const parts = [];
  if (s.enabled && s.nextRunAt) parts.push(`Next run ${fmtWhen(s.nextRunAt)}`);
  else if (s.enabled) parts.push("Scheduling…");
  else parts.push("Off");
  if (s.lastRunAt) parts.push(`last run ${fmtWhen(s.lastRunAt)}`);
  $("autoNext").textContent = parts.join(" · ");
}

// Any change to the panel is applied immediately — there's no Save button here
// because a schedule you forgot to save is a schedule that never runs.
async function saveSchedule() {
  const scans = Object.entries(SCAN_BOXES)
    .filter(([, id]) => $(id).checked)
    .map(([type]) => type);
  const resp = await chrome.runtime.sendMessage({
    cmd: "setSchedule",
    schedule: {
      enabled: $("autoEnabled").checked,
      everyHours: parseInt($("autoEvery").value, 10) || 24,
      days: parseInt($("autoDays").value, 10) || 30,
      scans,
    },
  });
  schedule = (resp && resp.schedule) || schedule;
  renderSchedule();
}

for (const id of ["autoEnabled", "autoEvery", "autoDays", ...Object.values(SCAN_BOXES)]) {
  $(id).addEventListener("change", saveSchedule);
}

$("btnRunSchedule").addEventListener("click", async () => {
  const scans = Object.values(SCAN_BOXES).filter((id) => $(id).checked);
  if (!scans.length) {
    alert("Pick at least one scan to run.");
    return;
  }
  // "Run now" honours the panel's picks even when the schedule itself is off,
  // so it doubles as a one-click way to run the whole scan sequence.
  await saveSchedule();
  await chrome.runtime.sendMessage({ cmd: "runScheduleNow" });
});

// Whitelist a friend so they're never suggested or removed. The flag lives on
// the friend record and survives re-scans (scans spread the previous record).
async function toggleWhitelist(key) {
  const f = friends[key];
  if (!f) return;
  setProtected([key], !f.whitelisted);
  render();
}

// ------------------------------------------------------------- actions

$("btnScanFriends").addEventListener("click", () =>
  chrome.runtime.sendMessage({ cmd: "startFriendScan" })
);

$("btnScanDates").addEventListener("click", () =>
  chrome.runtime.sendMessage({ cmd: "startFriendDatesScan" })
);

$("btnScanEngagement").addEventListener("click", () =>
  chrome.runtime.sendMessage({
    cmd: "startEngagementScan",
    days: parseInt($("scanDays").value, 10) || 30,
  })
);

// Persist the chosen scan window across sessions.
$("scanDays").addEventListener("change", () => {
  saveSettings({ scanDays: parseInt($("scanDays").value, 10) || 30 });
});

$("btnRemove").addEventListener("click", () => {
  // Protected friends can sit in the selection, but protection still wins:
  // they're held back here and again in the background worker.
  const { open: queue, unprotectable } = selectionSplit();
  if (!queue.length) return;
  const skipped = unprotectable.length;

  const names = queue.map((k) => friends[k].name).filter(Boolean);
  const preview = names.slice(0, 8).join(", ") + (names.length > 8 ? "…" : "");
  const cap = settings.maxRemovalsPerRun;
  const capNote = queue.length > cap ? ` (capped at ${cap} this run)` : "";
  const skipNote = skipped
    ? `\n\n${skipped} protected ${skipped === 1 ? "friend" : "friends"} in the selection will be skipped — use "Unprotect selected" first if you meant to include them.`
    : "";
  if (!confirm(`Unfriend ${queue.length} people${capNote}?\n\n${preview}${skipNote}\n\nThis cannot be undone by the extension.`)) return;
  chrome.runtime.sendMessage({ cmd: "startRemoval", friendKeys: queue });
  selected.clear();
  updateActionButtons();
});

// Bulk-protect every selected friend (selection spans pages). The selection is
// left alone — protected friends stay tickable, so clearing it here would just
// undo work if the next action also targets them.
$("btnProtect").addEventListener("click", async () => {
  const { open } = selectionSplit();
  if (!open.length) return;
  setProtected(open, true);
  render();
});

// Bulk counterpart to the ☆ toggle — lifts protection from every protected
// friend in the selection so they can be queued for removal.
$("btnUnprotect").addEventListener("click", async () => {
  const { unprotectable } = selectionSplit();
  if (!unprotectable.length) return;
  if (!confirm(`Unprotect ${unprotectable.length} ${unprotectable.length === 1 ? "friend" : "friends"}?\n\nThey can be queued for removal again after this.`)) return;
  setProtected(unprotectable, false);
  render();
});

$("btnCancel").addEventListener("click", () =>
  chrome.runtime.sendMessage({ cmd: "cancelJob" })
);

$("btnExport").addEventListener("click", () => {
  const rows = visibleRows();
  const esc = (s) => '"' + String(s).replace(/"/g, '""') + '"';
  const csv = [
    "name,url,reactions,comments,score,last_engaged,date_friended,friend_order_rank,protected,first_seen,removed",
    ...rows.map((r) =>
      [esc(r.name), esc(r.url), r.reactions, r.comments, r.score,
       r.lastAt ? new Date(r.lastAt).toISOString() : "",
       r.friendedAt ? new Date(r.friendedAt).toISOString().slice(0, 10) : "",
       r.rank !== null ? r.rank + 1 : "",
       r.whitelisted ? "yes" : "",
       r.firstSeen ? new Date(r.firstSeen).toISOString() : "",
       r.removedAt ? new Date(r.removedAt).toISOString() : ""].join(",")
    ),
  ].join("\n");
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = "friendsweep.csv";
  a.click();
  URL.revokeObjectURL(url);
});

$("selAll").addEventListener("change", () => {
  // Read the intent from the page rather than from the box's own checked
  // state: on a partial selection the box is indeterminate, and the browser's
  // idea of what the click "means" doesn't match what the user wants — a
  // half-ticked page should fill up, not empty out.
  const selectable = pageSelectable();
  if (!selectable.length) return;

  if (!selectable.every((r) => selected.has(r.key))) {
    for (const r of selectable) selected.add(r.key);
  } else if (allMatchingSelected()) {
    // The selection was widened past this page (via "Select all N matching"),
    // so unticking has to undo that too — clearing only the page would strand
    // the off-page rows selected with nothing on screen to show for it.
    for (const k of lastMatchedKeys) selected.delete(k);
  } else {
    // Ordinary case: scope to the visible page, so a selection built up across
    // pages isn't wiped by one toggle.
    for (const r of lastPageRows) selected.delete(r.key);
  }
  render();
});

$("selAllMatch").addEventListener("click", (e) => {
  e.preventDefault();
  if (e.currentTarget.dataset.action === "clear") selected.clear();
  else for (const k of lastMatchedKeys) selected.add(k);
  render();
});

// Pager navigation. Infinity is clamped to the last page inside render().
$("pgFirst").addEventListener("click", () => { page = 1; render(); });
$("pgPrev").addEventListener("click", () => { page -= 1; render(); });
$("pgNext").addEventListener("click", () => { page += 1; render(); });
$("pgLast").addEventListener("click", () => { page = Infinity; render(); });

$("pageSize").addEventListener("change", async () => {
  pageSize = parseInt($("pageSize").value, 10) || 50;
  page = 1;
  saveSettings({ pageSize });
  render();
});

// Changing a filter, search, or sort resets to the first page.
for (const id of ["search", "fltNoEngagement", "fltHideRemoved", "fltHideProtected", "sortBy"]) {
  $(id).addEventListener("input", () => { page = 1; render(); });
}

// Protected friends are hidden by default; remember when that's overridden.
$("fltHideProtected").addEventListener("change", () => {
  saveSettings({ hideProtected: $("fltHideProtected").checked });
});

$("btnSaveSettings").addEventListener("click", async () => {
  const min = Math.max(20, parseInt($("setDelayMin").value, 10) || 30);
  await saveSettings({
    maxRemovalsPerRun: Math.max(1, parseInt($("setMaxRemovals").value, 10) || 20),
    removeDelayMinSec: min,
    removeDelayMaxSec: Math.max(min, parseInt($("setDelayMax").value, 10) || 60),
  });
  renderSettings();
});

$("btnWipe").addEventListener("click", async () => {
  if (!confirm("Delete all FriendSweep data (friend list, engagement history, settings)?\n\nThis also clears it from every other browser that syncs with this one.")) return;
  await chrome.runtime.sendMessage({ cmd: "wipeAll" });
  selected.clear();
  load();
});

// Live-refresh when scans — or another browser, via sync — write new data.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.syncState) {
    syncState = changes.syncState.newValue || null;
    renderSync();
  }
  if (changes.docIds) {
    docIds = changes.docIds.newValue || {};
    renderDocIdDiag();
  }
  if (changes.friends) friends = changes.friends.newValue || {};
  if (changes.engagement) engagement = changes.engagement.newValue || {};
  if (changes.job) job = changes.job.newValue || null;
  if (changes.settings) {
    settings = Object.assign({}, SETTINGS_DEFAULTS, changes.settings.newValue || {});
    if (settings.pageSize && settings.pageSize !== pageSize) {
      pageSize = settings.pageSize;
      $("pageSize").value = String(pageSize);
    }
    $("fltHideProtected").checked = settings.hideProtected !== false;
    renderSettings();
  }
  if (changes.schedule) {
    schedule = changes.schedule.newValue || null;
    renderSchedule();
  }
  if (changes.friends || changes.engagement || changes.job || changes.settings) render();
});

// Tick the "next removal in ~Ns" countdown.
setInterval(() => {
  if (job && job.type === "removal" && job.status === "running") renderJob();
}, 1000);

load();
