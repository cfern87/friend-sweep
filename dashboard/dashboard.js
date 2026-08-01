// FriendSweep dashboard. Reads friends + engagement events from
// chrome.storage.local, computes per-friend scores, and drives jobs
// via the background worker.

const $ = (id) => document.getElementById(id);

let friends = {};
let engagement = {};
let settings = {};
let job = null;
const selected = new Set();

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
  const data = await chrome.storage.local.get(["friends", "engagement", "settings", "job"]);
  friends = data.friends || {};
  engagement = data.engagement || {};
  settings = Object.assign(
    { maxRemovalsPerRun: 20, removeDelayMinSec: 30, removeDelayMaxSec: 60 },
    data.settings || {}
  );
  job = data.job || null;
  pageSize = settings.pageSize || 50;
  $("pageSize").value = String(pageSize);
  render();
  renderSettings();
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
  return agg;
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

  const hasEngagementData = scannedEvents > 0;

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
  if (!job) {
    bar.classList.add("hidden");
    return;
  }
  bar.classList.remove("hidden", "error", "finished");
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
  if (job.status === "error") {
    bar.classList.add("error");
    text += ` — ${job.error || ""}`;
  }
  if (job.status === "finished") bar.classList.add("finished");
  bar.textContent = text;
}

function renderSettings() {
  $("setMaxRemovals").value = settings.maxRemovalsPerRun;
  $("setDelayMin").value = settings.removeDelayMinSec;
  $("setDelayMax").value = settings.removeDelayMaxSec;
  if (settings.scanDays) $("scanDays").value = String(settings.scanDays);
}

// Whitelist a friend so they're never suggested or removed. The flag lives on
// the friend record and survives re-scans (scans spread the previous record).
async function toggleWhitelist(key) {
  const f = friends[key];
  if (!f) return;
  f.whitelisted = !f.whitelisted;
  await chrome.storage.local.set({ friends });
  updateActionButtons();
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
$("scanDays").addEventListener("change", async () => {
  settings.scanDays = parseInt($("scanDays").value, 10) || 30;
  await chrome.storage.local.set({ settings });
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
  for (const k of open) friends[k].whitelisted = true;
  await chrome.storage.local.set({ friends });
  render();
});

// Bulk counterpart to the ☆ toggle — lifts protection from every protected
// friend in the selection so they can be queued for removal.
$("btnUnprotect").addEventListener("click", async () => {
  const { unprotectable } = selectionSplit();
  if (!unprotectable.length) return;
  if (!confirm(`Unprotect ${unprotectable.length} ${unprotectable.length === 1 ? "friend" : "friends"}?\n\nThey can be queued for removal again after this.`)) return;
  for (const k of unprotectable) friends[k].whitelisted = false;
  await chrome.storage.local.set({ friends });
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
  settings.pageSize = pageSize;
  await chrome.storage.local.set({ settings });
  render();
});

// Changing a filter, search, or sort resets to the first page.
for (const id of ["search", "fltNoEngagement", "fltHideRemoved", "fltHideProtected", "sortBy"]) {
  $(id).addEventListener("input", () => { page = 1; render(); });
}

$("btnSaveSettings").addEventListener("click", async () => {
  settings.maxRemovalsPerRun = Math.max(1, parseInt($("setMaxRemovals").value, 10) || 20);
  settings.removeDelayMinSec = Math.max(20, parseInt($("setDelayMin").value, 10) || 30);
  settings.removeDelayMaxSec = Math.max(
    settings.removeDelayMinSec,
    parseInt($("setDelayMax").value, 10) || 60
  );
  await chrome.storage.local.set({ settings });
  renderSettings();
});

$("btnWipe").addEventListener("click", async () => {
  if (!confirm("Delete all FriendSweep data (friend list, engagement history, settings)?")) return;
  await chrome.storage.local.clear();
  selected.clear();
  load();
});

// Live-refresh when scans write new data.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.friends) friends = changes.friends.newValue || {};
  if (changes.engagement) engagement = changes.engagement.newValue || {};
  if (changes.job) job = changes.job.newValue || null;
  if (changes.settings) settings = changes.settings.newValue || settings;
  render();
});

// Tick the "next removal in ~Ns" countdown.
setInterval(() => {
  if (job && job.type === "removal" && job.status === "running") renderJob();
}, 1000);

load();
