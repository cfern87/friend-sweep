// FriendSweep dashboard. Reads friends + engagement events from
// chrome.storage.local, computes per-friend scores, and drives jobs
// via the background worker.

const $ = (id) => document.getElementById(id);

let friends = {};
let engagement = {};
let settings = {};
let job = null;
const selected = new Set();

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
    };
  });

  if (q) rows = rows.filter((r) => r.name.toLowerCase().includes(q));
  if (noEng) rows = rows.filter((r) => r.score === 0);
  if (hideRemoved) rows = rows.filter((r) => !r.removedAt);

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
  const rows = visibleRows();
  const tbody = $("rows");
  tbody.innerHTML = "";

  const total = Object.keys(friends).length;
  const removed = Object.values(friends).filter((f) => f.removedAt).length;
  const scannedEvents = Object.keys(engagement).length;
  $("stats").innerHTML =
    `<b>${total}</b> friends · <b>${scannedEvents}</b> engagement events · <b>${removed}</b> removed`;

  $("empty").classList.toggle("hidden", total > 0);

  const hasEngagementData = scannedEvents > 0;

  for (const r of rows) {
    const tr = document.createElement("tr");
    if (r.removedAt) tr.className = "removed";

    const tdSel = document.createElement("td");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = selected.has(r.key);
    cb.disabled = !!r.removedAt;
    cb.addEventListener("change", () => {
      cb.checked ? selected.add(r.key) : selected.delete(r.key);
      updateRemoveButton();
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
    } else if (hasEngagementData && r.score === 0) {
      tdStatus.innerHTML = '<span class="badge suggest">suggested</span>';
    } else {
      tdStatus.innerHTML = '<span class="badge">friend</span>';
    }

    tr.append(tdSel, tdAv, tdName, tdR, tdC, tdScore, tdLast, tdRank, tdStatus);
    tbody.appendChild(tr);
  }

  renderJob();
  updateRemoveButton();
}

function updateRemoveButton() {
  const btn = $("btnRemove");
  btn.textContent = `Remove selected (${selected.size})`;
  btn.disabled = selected.size === 0 || (job && job.status === "running");
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
  const names = [...selected]
    .map((k) => friends[k] && friends[k].name)
    .filter(Boolean);
  const preview = names.slice(0, 8).join(", ") + (names.length > 8 ? "…" : "");
  const cap = settings.maxRemovalsPerRun;
  const capNote = names.length > cap ? ` (capped at ${cap} this run)` : "";
  if (!confirm(`Unfriend ${names.length} people${capNote}?\n\n${preview}\n\nThis cannot be undone by the extension.`)) return;
  chrome.runtime.sendMessage({ cmd: "startRemoval", friendKeys: [...selected] });
  selected.clear();
  updateRemoveButton();
});

$("btnCancel").addEventListener("click", () =>
  chrome.runtime.sendMessage({ cmd: "cancelJob" })
);

$("btnExport").addEventListener("click", () => {
  const rows = visibleRows();
  const esc = (s) => '"' + String(s).replace(/"/g, '""') + '"';
  const csv = [
    "name,url,reactions,comments,score,last_engaged,date_friended,friend_order_rank,first_seen,removed",
    ...rows.map((r) =>
      [esc(r.name), esc(r.url), r.reactions, r.comments, r.score,
       r.lastAt ? new Date(r.lastAt).toISOString() : "",
       r.friendedAt ? new Date(r.friendedAt).toISOString().slice(0, 10) : "",
       r.rank !== null ? r.rank + 1 : "",
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

$("selAll").addEventListener("change", (e) => {
  if (e.target.checked) {
    for (const r of visibleRows()) if (!r.removedAt) selected.add(r.key);
  } else {
    selected.clear();
  }
  render();
});

for (const id of ["search", "fltNoEngagement", "fltHideRemoved", "sortBy"]) {
  $(id).addEventListener("input", render);
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
