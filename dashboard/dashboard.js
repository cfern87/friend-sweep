// Not Another Friend Sweeper dashboard. Reads friends + engagement events from
// chrome.storage.local, computes per-friend scores, and drives jobs
// via the background worker. Edits to synced data (protection, settings,
// wipe) go through the worker too, which stamps them for cross-browser sync.

const $ = (id) => document.getElementById(id);
try { $("navVersion").textContent = "v" + chrome.runtime.getManifest().version; } catch (e) { /* cosmetic */ }

const SETTINGS_DEFAULTS = {
  maxRemovalsPerRun: 20,
  removeDelayMinSec: 30,
  removeDelayMaxSec: 60,
  maxRemovalsPerDay: 40,
  // Seconds between pressing Remove and anything reaching Facebook (0 = off).
  undoDelaySec: 30,
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
// This browser's Google Drive link (sync.js `fsDrive`), and the auth details
// the worker reports for it (drive.js).
let drive = null;
let driveAuth = null;
let docIds = {};
// Plan + sign-in state from the background worker (license.js).
let account = null;
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
// { at, days } of the last finished engagement scan — for "why suggested".
let lastEngagementScan = null;

// ------------------------------------------------------------- account

async function loadAccount(force) {
  const resp = await chrome.runtime.sendMessage({ cmd: "getAccount", force: !!force }).catch(() => null);
  account = (resp && resp.entitlement) || { signedIn: false };
  renderAccount();
}

function renderAccount() {
  const a = account || { signedIn: false };
  $("lock").classList.toggle("hidden", !!a.signedIn);
  $("account").classList.toggle("hidden", !a.signedIn);
  if (!a.signedIn) return;

  const plan = $("acctPlan");
  plan.textContent = a.isPro ? "Pro" : "Free";
  plan.classList.toggle("pro", !!a.isPro);
  $("acctEmail").textContent = a.email || "";
  const usage = $("acctUsage");
  if (a.isPro) {
    usage.textContent = "Unlimited removals" + (a.stale ? " · offline, using your last plan check" : "");
    usage.classList.remove("out");
  } else {
    const left = a.removalsRemaining ?? 0;
    const reset = a.resetsAt ? " · resets " + new Date(a.resetsAt).toLocaleDateString() : "";
    usage.innerHTML = `<b>${left}</b> of ${a.removalsLimit ?? 40} free removals left this month${reset}`;
    usage.classList.toggle("out", left === 0);
  }
  $("acctUpgrade").classList.toggle("hidden", !!a.isPro);

  // Pro-only engagement windows.
  for (const id of ["scanDays", "autoDays"]) {
    for (const opt of $(id).options) {
      const locked = !a.isPro && parseInt(opt.value, 10) > (a.maxScanDays || 30);
      opt.disabled = locked;
      opt.textContent = opt.textContent.replace(/ \(Pro\)$/, "") + (locked ? " (Pro)" : "");
    }
    if ($(id).selectedOptions[0] && $(id).selectedOptions[0].disabled) $(id).value = "30";
  }
  $("btnExport").textContent = a.csvExport ? "Export CSV" : "Export CSV (Pro)";
  $("schedProTag").classList.toggle("hidden", !!a.scheduledScans);
  $("schedProNote").classList.toggle("hidden", !!a.scheduledScans);
  $("inboundProTag").classList.toggle("hidden", !!a.scheduledScans);
  $("inboundProNote").classList.toggle("hidden", !!a.scheduledScans);
  renderSchedule();
  renderInbound();
}

function upgradePrompt(message) {
  if (confirm(message + "\n\nOpen the upgrade page?")) chrome.runtime.sendMessage({ cmd: "openBilling" });
}

// Send a gated command and explain a refusal (signed out / Pro-only).
async function runCmd(msg) {
  const resp = await chrome.runtime.sendMessage(msg).catch((e) => ({ ok: false, error: String(e) }));
  if (resp && resp.ok === false && resp.error) {
    if (resp.signedOut) {
      await loadAccount();
    } else if (resp.upgrade) {
      upgradePrompt(resp.error);
    } else {
      alert(resp.error);
    }
  }
  if (msg.cmd === "startRemoval") loadAccount();
  return resp;
}

$("btnLockSignIn").addEventListener("click", () => chrome.runtime.sendMessage({ cmd: "signIn" }));
$("acctUpgrade").addEventListener("click", (e) => { e.preventDefault(); chrome.runtime.sendMessage({ cmd: "openBilling" }); });
$("acctBilling").addEventListener("click", (e) => { e.preventDefault(); chrome.runtime.sendMessage({ cmd: "openBilling" }); });
for (const id of ["acctAccount", "acctEmail"]) {
  $(id).addEventListener("click", (e) => { e.preventDefault(); chrome.runtime.sendMessage({ cmd: "openAccount" }); });
}
$("acctHelp").addEventListener("click", (e) => { e.preventDefault(); chrome.runtime.sendMessage({ cmd: "openSupport" }); });
$("schedUpgrade").addEventListener("click", (e) => { e.preventDefault(); chrome.runtime.sendMessage({ cmd: "openBilling" }); });
$("acctSignOut").addEventListener("click", async (e) => {
  e.preventDefault();
  if (!confirm("Sign out of Not Another Friend Sweeper in this browser?\n\nYour friend data stays here.")) return;
  await chrome.runtime.sendMessage({ cmd: "signOut" });
  loadAccount();
});
// Coming back from the sign-in or billing tab: re-check the plan.
window.addEventListener("focus", () => loadAccount(true));

// ------------------------------------------------------------- data

async function load() {
  // Pull from other browsers now rather than waiting for the next change.
  chrome.runtime.sendMessage({ cmd: "syncNow" }).catch(() => {});
  const data = await chrome.storage.local.get([
    "friends", "engagement", "settings", "job", "schedule", "syncState", "docIds", "fsDrive", "lastEngagementScan",
  ]);
  drive = data.fsDrive || null;
  loadDrive();
  friends = data.friends || {};
  engagement = data.engagement || {};
  settings = Object.assign({}, SETTINGS_DEFAULTS, data.settings || {});
  job = data.job || null;
  syncState = data.syncState || null;
  docIds = data.docIds || {};
  lastEngagementScan = data.lastEngagementScan || null;
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
  if (drive && drive.enabled) {
    // Drive carries the full friend list; browser sync's caps don't apply.
    el.title = "";
    el.classList.toggle("error", !!drive.lastError);
    if (drive.lastError) el.textContent = "Drive sync paused — " + drive.lastError;
    else if (!drive.lastSyncAt) el.textContent = "Connecting to Google Drive…";
    else el.textContent = "Synced via Google Drive · " + fmtWhen(drive.lastSyncAt);
    return;
  }
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
    text += " · " + notes.join(" · ") + " · connect Google Drive to sync everything";
    el.title = "Chrome sync storage is capped at 100 KB per extension. Google Drive sync (bottom of the page) has no such limit.";
  } else {
    el.title = "";
  }
  el.textContent = text;
}

// ------------------------------------------------------------- Google Drive

async function loadDrive() {
  const resp = await chrome.runtime.sendMessage({ cmd: "driveStatus" }).catch(() => null);
  driveAuth = (resp && resp.status) || null;
  renderDrive();
}

function renderDrive() {
  const a = driveAuth || {};
  const on = !!(drive && drive.enabled);
  const connect = $("btnDriveConnect");
  $("btnDriveDisconnect").classList.toggle("hidden", !on);
  connect.textContent = on ? "Reconnect" : "Connect Google Drive";
  connect.disabled = driveAuth ? !a.configured : false;

  let info;
  if (driveAuth && !a.configured) {
    info = "Google Drive sync isn't set up in this build of the extension.";
  } else if (on) {
    info = "Connected" + (a.email ? " as " + a.email : "") +
      ". Your whole friend list syncs through a hidden app folder in your Google Drive, " +
      "checked for changes every minute — nothing to refresh by hand. " +
      "Connect the same Google account on each of your browsers.";
    if (driveAuth && !a.silentRenewal) {
      info += " This browser renews Google access hourly through your Google sign-in; " +
        "sign into Chrome itself for fully hands-off renewal.";
    }
  } else {
    info = "Browser sync holds about 100 KB, which isn't enough for a large friend list. " +
      "Connect Google Drive to sync any size of list between your computers. " +
      "It only uses a hidden app folder this extension can see — not your files.";
  }
  $("driveInfo").textContent = info;

  const diag = [];
  if (on && drive.lastSyncAt) diag.push("Last Drive sync " + fmtWhen(drive.lastSyncAt));
  if (on && drive.lastError) diag.push("Last error: " + drive.lastError);
  $("driveDiag").textContent = diag.join(" · ");
}

$("btnDriveConnect").addEventListener("click", async () => {
  const btn = $("btnDriveConnect");
  btn.disabled = true;
  btn.textContent = "Waiting for Google…";
  const resp = await chrome.runtime.sendMessage({ cmd: "driveConnect" }).catch((e) => ({ ok: false, error: String(e) }));
  if (!resp || !resp.ok) alert("Couldn't connect Google Drive: " + ((resp && resp.error) || "no response"));
  await loadDrive();
});

$("btnDriveDisconnect").addEventListener("click", async () => {
  if (!confirm("Stop syncing this browser through Google Drive?\n\nYour data stays here and in Drive for your other browsers.")) return;
  await chrome.runtime.sendMessage({ cmd: "driveDisconnect" }).catch(() => {});
  await loadDrive();
});

function scoreOf(a) {
  return a ? a.reactions + a.comments * 2 : 0;
}

// ------------------------------------------------------------- render

function fmtDate(ts) {
  return ts ? new Date(ts).toLocaleDateString() : "—";
}

function visibleRows(opts = {}) {
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
      // Off the friends list without the extension's help (a scan stopped
      // finding them) — shown and filtered like a removal.
      gone: !f.removedAt && !!f.goneAt,
      removedAt: f.removedAt || f.goneAt || null,
      name: f.name || slugOf(f),
      nameIsFallback: !f.name,
      reactions: a ? a.reactions : 0,
      comments: a ? a.comments : 0,
      score: scoreOf(a),
      lastAt: a ? a.lastAt : 0,
      rank: typeof f.recentRank === "number" ? f.recentRank : null,
      friendedAt: f.friendedAt || null,
      whitelisted: !!f.whitelisted,
      // Still a friend after the extension tried and failed to remove them.
      removeFailed: !f.removedAt && !!f.removeFailedAt,
    };
  });

  if (!opts.ignoreFilters) {
    if (q) rows = rows.filter((r) => r.name.toLowerCase().includes(q));
    if ($("fltFailed").checked) rows = rows.filter((r) => r.removeFailed);
    if (noEng) rows = rows.filter((r) => r.score === 0);
    if (hideRemoved) rows = rows.filter((r) => !r.removedAt);
    if (hideProtected) rows = rows.filter((r) => !r.whitelisted);
  }

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
  const gone = Object.values(friends).filter((f) => !f.removedAt && f.goneAt).length;
  const current = total - removed - gone;
  const protectedCount = Object.values(friends).filter((f) => f.whitelisted && !f.removedAt && !f.goneAt).length;
  const scannedEvents = Object.keys(engagement).length;
  const failedCount = Object.values(friends).filter((f) => !f.removedAt && f.removeFailedAt).length;
  $("stats").innerHTML =
    `<b>${current}</b> friends · <b>${scannedEvents}</b> engagement events · ` +
    `<b>${protectedCount}</b> protected · <b>${removed}</b> removed` +
    (gone ? ` · <span title="No longer on your Facebook friends list — they unfriended you, left Facebook, or were removed outside Friend Sweep"><b>${gone}</b> no longer friends</span>` : "") +
    (failedCount ? ` · <a href="#" id="statFailed" class="statfailed"><b>${failedCount}</b> couldn't be removed</a>` : "");
  const statFailed = $("statFailed");
  if (statFailed) statFailed.addEventListener("click", (e) => { e.preventDefault(); showFailedRemovals(); });
  // The filter only appears while there's something for it to find.
  $("fltFailedWrap").classList.toggle("hidden", failedCount === 0);
  $("fltFailedCount").textContent = failedCount ? `(${failedCount})` : "";
  if (!failedCount) $("fltFailed").checked = false;

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
    else if (r.removeFailed) tr.className = "failed";

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
    // Flag recent friends who are suggested: a 0 may just mean "too soon to tell".
    if (hasEngagementData && r.score === 0 && !r.removedAt && !r.whitelisted && isNewFriend(r)) {
      const tag = document.createElement("span");
      tag.className = "badge newfriend";
      tag.textContent = "new friend";
      tag.title = "Added recently — may not have had a chance to react or comment yet";
      tdName.appendChild(tag);
    }

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
      tdRank.title = `${r.rank + 1} of your most recently added friends — Facebook didn't show an exact date for this one`;
    } else {
      tdRank.textContent = "—";
      tdRank.title = "No friend-date data yet — run Scan friends";
    }

    const tdStatus = document.createElement("td");
    if (r.gone) {
      tdStatus.innerHTML = '<span class="badge removed" title="Your last friend scan did not find them on your friends list">no longer friends</span>';
    } else if (r.removedAt) {
      tdStatus.innerHTML = r.removedManually
        ? '<span class="badge removed" title="You removed them on Facebook and marked it here">removed by hand</span>'
        : '<span class="badge removed">removed</span>';
    } else if (r.removeFailed) {
      tdStatus.appendChild(failedRemovalCell(r));
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
  renderChecklist();
  renderDailyMeter();
  const navCount = $("navFriendsCount");
  navCount.textContent = failedCount ? `${failedCount} to fix` : total ? String(current) : "";
  navCount.classList.toggle("alert", failedCount > 0);
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
  const live = [...selected].filter((k) => friends[k] && !friends[k].removedAt && !friends[k].goneAt);
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
  btn.disabled = open.length === 0 || jobIsActive();

  // Protect/unprotect are local storage changes, so they're fine mid-job.
  const pBtn = $("btnProtect");
  pBtn.textContent = `Protect selected (${open.length})`;
  pBtn.disabled = open.length === 0;

  const crm = $("btnToCrm");
  const live = open.length + unprotectable.length;
  crm.textContent = `Send to CRM (${live})`;
  crm.disabled = live === 0;

  const uBtn = $("btnUnprotect");
  uBtn.textContent = `Unprotect selected (${unprotectable.length})`;
  uBtn.disabled = unprotectable.length === 0;
}

// The status cell for a friend the extension couldn't remove: what went wrong,
// and the two ways out — do it by hand on Facebook, or decide to keep them.
// (Re-selecting them and pressing Remove selected retries automatically.)
function failedRemovalCell(r) {
  const wrap = document.createElement("div");
  wrap.className = "failcell";
  const badge = document.createElement("span");
  badge.className = "badge failed";
  badge.textContent = "removal failed";
  badge.title = (r.removeError ? "Facebook said: " + r.removeError + "\n" : "") +
    "Tried " + fmtWhen(r.removeFailedAt) + ". Select them and press Remove selected to retry, or remove them by hand.";
  wrap.appendChild(badge);

  const open = document.createElement("a");
  open.className = "failaction";
  open.href = r.url;
  open.target = "_blank";
  open.textContent = "Remove on Facebook ↗";
  open.title = "Opens their profile. Use Friends ▸ Unfriend there, then come back and press Mark removed.";
  wrap.appendChild(open);

  const mark = document.createElement("button");
  mark.className = "failaction primary small";
  mark.textContent = "Mark removed";
  mark.title = "You've unfriended them on Facebook yourself";
  mark.addEventListener("click", async () => {
    if (!confirm(`Mark ${r.name} as removed?\n\nOnly do this once you've unfriended them on Facebook — the extension can't check.`)) return;
    await runCmd({ cmd: "markRemoved", keys: [r.key] });
  });
  wrap.appendChild(mark);

  const keep = document.createElement("button");
  keep.className = "failaction ghost small";
  keep.textContent = "Keep";
  keep.title = "Stop flagging this person — you've decided to stay friends";
  keep.addEventListener("click", () => chrome.runtime.sendMessage({ cmd: "clearRemoveFailed", keys: [r.key] }));
  wrap.appendChild(keep);
  return wrap;
}

// Jump the list to just the people a removal couldn't get to.
function showFailedRemovals() {
  if (location.hash !== "#friends") location.hash = "#friends";
  $("fltFailed").checked = true;
  $("fltHideRemoved").checked = true;
  $("search").value = "";
  page = 1;
  render();
  $("rows").closest(".tablewrap").scrollIntoView({ behavior: "smooth", block: "start" });
}

const TRIGGER_LABELS = { manual: "", schedule: "Scheduled · ", webhook: "Webhook · " };

function jobHeadline(j) {
  const p = j.progress || {};
  if (j.type === "friendScan") {
    const step = { all: "1 of 3: friends list", recent: "2 of 3: friend order", dates: "3 of 3: friend dates" }[j.phase] || "";
    const counts = `${p.found || 0} friends found` + (p.dated ? `, ${p.dated} dated` : "") +
      (p.gone ? `, ${p.gone} no longer friends` : "");
    return j.status === "running"
      ? `Scanning friends — step ${step} — ${counts}`
      : `Friend scan ${j.status} — ${counts}`;
  }
  if (j.type === "friendDatesScan") return `Friend-dates scan ${j.status} — ${p.dated || 0} friends dated`;
  if (j.type === "engagementScan") {
    const win = j.days ? ` (${j.days}-day window)` : "";
    return `Engagement scan ${j.status}${win} — ${p.posts || 0} posts, ${p.events || 0} new events`;
  }
  if (j.type === "removal") {
    const verb = j.status === "running" ? "Removing friends" : `Removal ${j.status}`;
    return `${verb} — ${p.done || 0} of ${p.total || 0} removed` + (p.failed ? `, ${p.failed} failed` : "");
  }
  return "";
}

function renderJob() {
  const bar = $("jobBar");
  const running = !!(job && job.status === "running");

  if (!job) {
    if (jobDismissTimer) {
      clearTimeout(jobDismissTimer);
      jobDismissTimer = null;
    }
    bar.classList.add("hidden");
    bar.textContent = "";
    return;
  }
  bar.classList.remove("hidden", "error", "finished", "queued");
  bar.textContent = "";
  if (job.status === "queued") {
    renderQueuedRemoval(bar);
    return;
  }
  const p = job.progress || {};
  const trigger = job.trigger || (job.auto ? "schedule" : "manual");
  let text = (TRIGGER_LABELS[trigger] || "") + jobHeadline(job);
  if (job.inbound && job.inbound.label && trigger === "webhook") text = text.replace(/^Webhook · /, `Webhook (${job.inbound.label}) · `);
  if (job.type === "removal" && running && job.nextStepAt && job.nextStepAt > Date.now()) {
    text += ` · next in ~${Math.round((job.nextStepAt - Date.now()) / 1000)}s`;
  }
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
    // Notes on a running job (e.g. some held back for tomorrow) are information;
    // once it has ended, they're what to read first.
    if (!running) bar.classList.add("error");
    text += ` — ${warnings.join("; ")}`;
  }
  // A removal that left people behind isn't a green "all done".
  const leftBehind = job.type === "removal" && (p.failed || 0) > 0;
  if (job.status === "finished" && !leftBehind) bar.classList.add("finished");

  const body = document.createElement("div");
  body.className = "jobbody";
  const label = document.createElement("span");
  label.textContent = text;
  body.appendChild(label);

  // Removals are the slow, nervous operation: show how far along it is.
  if (job.type === "removal" && p.total) {
    const track = document.createElement("div");
    track.className = "jobprogress";
    const doneBar = document.createElement("span");
    doneBar.className = "ok";
    doneBar.style.width = `${(100 * (p.done || 0)) / p.total}%`;
    const failBar = document.createElement("span");
    failBar.className = "bad";
    failBar.style.width = `${(100 * (p.failed || 0)) / p.total}%`;
    track.append(doneBar, failBar);
    body.appendChild(track);
    if (running) {
      // Make the safety rules visible while they're working.
      const d = job.delays || {};
      const pace = document.createElement("div");
      pace.className = "jobpacing";
      const { today, cap } = dailyUsage();
      pace.textContent = `Paced ${d.minSec || 30}–${d.maxSec || 60}s apart, like a person would · ${today} of ${cap} removals today`;
      body.appendChild(pace);
    }
  }
  bar.appendChild(body);

  const actions = document.createElement("div");
  actions.className = "jobactions";
  bar.appendChild(actions);

  // A removal that left people behind points straight at them.
  const failedRemovals = job.type === "removal" && (p.failed || 0) > 0;
  if (failedRemovals && !running) {
    bar.classList.add("error");
    const show = document.createElement("button");
    show.className = "small";
    show.textContent = `Show the ${p.failed} still to remove`;
    show.addEventListener("click", showFailedRemovals);
    actions.appendChild(show);
  }

  if (running) {
    // Cancel lives with the job it cancels.
    const cancel = document.createElement("button");
    cancel.className = "ghost small jobcancel";
    cancel.textContent = job.type === "removal" ? "Stop removing" : "Cancel";
    cancel.title = job.type === "removal"
      ? "Stops after the current friend. Anyone already removed stays removed."
      : "Stops this scan. What it found so far is kept.";
    cancel.addEventListener("click", async () => {
      if (job.type === "removal" && !confirm("Stop removing friends?\n\nAnyone already removed stays removed.")) return;
      cancel.disabled = true;
      await chrome.runtime.sendMessage({ cmd: "cancelJob" });
    });
    actions.appendChild(cancel);
  } else {
    // A job that has ended clears itself; the × is just for the impatient (and
    // for errors, which stay put until they've been read). Mid-chain it's also
    // the way to call off the scans still queued behind this one.
    const chained = Array.isArray(job.chain) && job.chain.length > 0;
    const x = document.createElement("button");
    x.className = "jobclose";
    x.textContent = "×";
    x.title = chained ? "Stop the remaining scans" : "Dismiss";
    x.addEventListener("click", dismissJob);
    actions.appendChild(x);
    // Auto-dismissing a chained job would clear the job the next scan is
    // waiting on, so leave it up until the chain moves on by itself.
    if (job.status === "finished" && !chained && !warnings.length && !failedRemovals) scheduleJobDismiss();
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
  $("setMaxPerDay").value = settings.maxRemovalsPerDay;
  $("setDelayMin").value = settings.removeDelayMinSec;
  $("setDelayMax").value = settings.removeDelayMaxSec;
  $("setUndoSec").value = undoSec();
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
  // Every control below the switch only matters once it's on, and the whole
  // panel is Pro-only.
  const allowed = !!(account && account.scheduledScans);
  $("autoEnabled").disabled = !allowed;
  $("btnRunSchedule").disabled = !allowed;
  for (const id of ["autoEvery", "autoDays", ...Object.values(SCAN_BOXES)]) {
    $(id).disabled = !s.enabled || !allowed;
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
  const resp = await runCmd({
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
  await runCmd({ cmd: "runScheduleNow" });
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

$("btnScanFriends").addEventListener("click", () => runCmd({ cmd: "startFriendScan" }));

$("btnScanEngagement").addEventListener("click", () =>
  runCmd({
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
  if (confirmAndRemove(queue, unprotectable.length)) {
    selected.clear();
    updateActionButtons();
  }
});

// Confirm, then queue a removal. Shared by the table and review mode. Returns
// whether it went ahead.
function confirmAndRemove(queue, skipped = 0) {
  if (!queue.length) return false;
  if (jobIsActive()) {
    alert("Another job is running. Wait for it to finish, or cancel it from its banner.");
    return false;
  }
  const names = queue.map((k) => friends[k] && friends[k].name).filter(Boolean);
  const preview = names.slice(0, 8).join(", ") + (names.length > 8 ? "…" : "");
  const cap = settings.maxRemovalsPerRun;
  const capNote = queue.length > cap ? ` (capped at ${cap} this run)` : "";
  const a = account || {};
  if (!a.isPro && (a.removalsRemaining ?? 0) === 0) {
    upgradePrompt(`You've used all ${a.removalsLimit ?? 40} free removals this month.`);
    return false;
  }
  const { today, cap: dayCap } = dailyUsage();
  const leftToday = Math.max(0, dayCap - today);
  if (!leftToday) {
    alert(`You've reached today's limit of ${dayCap} removals. It resets at midnight — spreading removals over days keeps your account safe.`);
    return false;
  }
  const dayNote = leftToday < Math.min(queue.length, cap)
    ? `\n\nDaily limit: only ${leftToday} more today, so the rest wait for tomorrow.`
    : "";
  const allowanceNote =
    !a.isPro && a.removalsRemaining < Math.min(queue.length, cap)
      ? `\n\nFree plan: only ${a.removalsRemaining} more removals this month, so the rest of the selection will be held back.`
      : "";
  const skipNote = skipped
    ? `\n\n${skipped} protected ${skipped === 1 ? "friend" : "friends"} in the selection will be skipped — use "Unprotect selected" first if you meant to include them.`
    : "";
  if (!confirm(`Unfriend ${queue.length} people${capNote}?\n\n${preview}${skipNote}${dayNote}${allowanceNote}\n\n${undoNote()}`)) return false;
  runCmd({ cmd: "startRemoval", friendKeys: queue });
  return true;
}

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

$("btnExport").addEventListener("click", () => {
  if (!account || !account.csvExport) {
    upgradePrompt("CSV export is a Pro feature.");
    return;
  }
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
  a.download = "not-another-friend-sweeper.csv";
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
for (const id of ["search", "fltNoEngagement", "fltHideRemoved", "fltHideProtected", "fltFailed", "sortBy"]) {
  $(id).addEventListener("input", () => { page = 1; render(); });
}

// Protected friends are hidden by default; remember when that's overridden.
$("fltHideProtected").addEventListener("change", () => {
  saveSettings({ hideProtected: $("fltHideProtected").checked });
});

$("btnSaveSettings").addEventListener("click", async () => {
  const min = Math.max(30, parseInt($("setDelayMin").value, 10) || 30);
  await saveSettings({
    maxRemovalsPerRun: Math.max(1, parseInt($("setMaxRemovals").value, 10) || 20),
    maxRemovalsPerDay: Math.min(200, Math.max(1, parseInt($("setMaxPerDay").value, 10) || 40)),
    removeDelayMinSec: min,
    removeDelayMaxSec: Math.max(min, parseInt($("setDelayMax").value, 10) || 60),
    undoDelaySec: (() => {
      const n = parseInt($("setUndoSec").value, 10);
      return Number.isFinite(n) ? Math.min(300, Math.max(0, n)) : 30;
    })(),
  });
  renderSettings();
});

$("btnWipe").addEventListener("click", async () => {
  if (!confirm("Delete all Not Another Friend Sweeper data (friend list, engagement history, settings)?\n\nThis also clears it from every other browser that syncs with this one.")) return;
  await chrome.runtime.sendMessage({ cmd: "wipeAll" });
  selected.clear();
  load();
});

// ------------------------------------------------------------- incoming webhooks

let inbound = null; // { settings, status, endpointUrl, commands }
let inboundTokens = null; // null = not loaded; { error } or { list }

async function loadInbound() {
  const resp = await chrome.runtime.sendMessage({ cmd: "inboundInfo" }).catch(() => null);
  inbound = resp && resp.ok ? resp : null;
  renderInbound();
}

async function loadTokens() {
  const resp = await chrome.runtime.sendMessage({ cmd: "inboundTokens" }).catch(() => null);
  inboundTokens = resp && resp.ok ? { list: resp.tokens } : { error: (resp && resp.error) || "No response" };
  renderInbound();
}

function renderInbound() {
  if (!inbound) return;
  const allowed = !!(account && account.scheduledScans);
  const s = inbound.settings || {};
  $("inboundEnabled").checked = !!s.enabled;
  $("inboundEnabled").disabled = !allowed;
  $("btnInboundPoll").disabled = !allowed || !s.enabled;
  $("btnTokenCreate").disabled = !allowed;
  $("inboundEndpoint").textContent = inbound.endpointUrl;

  const box = $("inboundCommands");
  box.querySelectorAll("label").forEach((l) => l.remove());
  for (const [cmd, label] of Object.entries(inbound.commands || {})) {
    const l = document.createElement("label");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = (s.allowed || []).includes(cmd);
    cb.disabled = !allowed || !s.enabled;
    cb.addEventListener("change", () => {
      const next = new Set(s.allowed || []);
      cb.checked ? next.add(cmd) : next.delete(cmd);
      saveInbound({ allowed: [...next] });
    });
    const code = document.createElement("code");
    code.textContent = cmd;
    l.append(cb, " ", code, " — " + label);
    box.appendChild(l);
  }

  $("inboundExample").textContent =
    `curl -X POST ${inbound.endpointUrl} \\\n` +
    `  -H "Authorization: Bearer <your token>" \\\n` +
    `  -H "Content-Type: application/json" \\\n` +
    `  -d '{"command":"scan.engagement","payload":{"days":30}}'\n\n` +
    `# Replies 202 with an id. Check how it went:\n` +
    `curl "${inbound.endpointUrl}?id=<id>" -H "Authorization: Bearer <your token>"`;

  const st = inbound.status;
  const parts = [];
  if (!s.enabled) parts.push("Off in this browser");
  else if (!st) parts.push("Waiting for the first check…");
  else {
    if (st.ok === false) parts.push("Last check failed: " + st.error);
    else if (st.skipped === "busy") parts.push("A job is running — requests wait until it's done");
    else if (st.skipped === "signed-out") parts.push("Signed out");
    else if (st.skipped === "not-pro") parts.push("Needs Pro");
    else parts.push("Checked " + fmtWhen(st.at));
    if (st.last) parts.push(`last request: ${st.last.command} (${st.last.status === "pending" ? "running" : st.last.status}) ${fmtWhen(st.last.at)}`);
  }
  $("inboundStatus").textContent = parts.join(" · ");

  const list = $("tokenList");
  list.textContent = "";
  $("inboundSetup").textContent = "";
  if (inboundTokens && inboundTokens.error) {
    $("inboundSetup").textContent = inboundTokens.error;
  } else if (inboundTokens && inboundTokens.list) {
    const live = inboundTokens.list.filter((t) => !t.revoked_at);
    if (!live.length) {
      const li = document.createElement("li");
      li.className = "note";
      li.textContent = "No tokens yet. Create one for each tool you connect, so you can switch one off without breaking the rest.";
      list.appendChild(li);
    }
    for (const t of live) {
      const li = document.createElement("li");
      const name = document.createElement("span");
      name.innerHTML = `<b></b> <code></code> <span class="inline"></span>`;
      name.querySelector("b").textContent = t.label || "Untitled";
      name.querySelector("code").textContent = t.token_prefix + "…";
      name.querySelector(".inline").textContent =
        t.last_used_at ? "last used " + fmtWhen(Date.parse(t.last_used_at)) : "never used";
      const revoke = document.createElement("button");
      revoke.className = "ghost small danger-text";
      revoke.textContent = "Revoke";
      revoke.addEventListener("click", async () => {
        if (!confirm(`Revoke "${t.label || t.token_prefix}"?\n\nAnything still using it will get "invalid token" from now on.`)) return;
        await runCmd({ cmd: "inboundTokenRevoke", id: t.id });
        loadTokens();
      });
      li.append(name, revoke);
      list.appendChild(li);
    }
  }
}

async function saveInbound(patch) {
  const resp = await runCmd({ cmd: "inboundSetSettings", patch });
  if (resp && resp.ok) inbound.settings = resp.settings;
  renderInbound();
}

$("inboundEnabled").addEventListener("change", () => saveInbound({ enabled: $("inboundEnabled").checked }));
$("inboundUpgrade").addEventListener("click", (e) => { e.preventDefault(); chrome.runtime.sendMessage({ cmd: "openBilling" }); });
$("btnCopyEndpoint").addEventListener("click", async () => {
  await navigator.clipboard.writeText($("inboundEndpoint").textContent).catch(() => {});
  $("btnCopyEndpoint").textContent = "Copied";
  setTimeout(() => ($("btnCopyEndpoint").textContent = "Copy"), 1500);
});
$("btnInboundPoll").addEventListener("click", async () => {
  $("btnInboundPoll").disabled = true;
  await runCmd({ cmd: "inboundPollNow" });
  await loadInbound();
});
$("btnTokenCreate").addEventListener("click", async () => {
  const label = $("tokenLabel").value.trim() || "Webhook";
  const resp = await runCmd({ cmd: "inboundTokenCreate", label });
  if (!resp || !resp.ok) return;
  $("tokenLabel").value = "";
  // Shown once: only a hash is kept on the server.
  const box = $("tokenNew");
  box.classList.remove("hidden");
  box.innerHTML = `<b>Copy this token now — it won't be shown again.</b><code></code><button class="ghost small">Copy</button>`;
  box.querySelector("code").textContent = resp.token.token;
  box.querySelector("button").addEventListener("click", () => navigator.clipboard.writeText(resp.token.token).catch(() => {}));
  loadTokens();
});

// ------------------------------------------------------------- activity log

let activityLog = [];

const LOG_KIND = {
  friendScan: "Scan friends",
  friendDatesScan: "Scan friend dates",
  engagementScan: "Scan engagement",
  removal: "Remove friends",
  manualRemoval: "Marked removed",
  webhook: "Webhook request",
};

function renderLog() {
  const filter = $("logFilter").value;
  const rows = activityLog.filter((e) => {
    if (filter === "problems") return e.status === "error" || e.status === "cancelled" || (e.warnings && e.warnings.length) ||
      (e.detail && e.detail.failed && e.detail.failed.length);
    if (filter === "all") return true;
    return e.trigger === filter;
  });
  $("logCount").textContent = activityLog.length ? `(${activityLog.length})` : "";
  // Problems in the last week get a red count in the nav, so they're seen.
  const weekAgo = Date.now() - 7 * 86400000;
  const problems = activityLog.filter((e) => e.startedAt > weekAgo && e.status === "error").length;
  $("navActivityCount").textContent = problems ? `${problems} failed` : "";
  $("navActivityCount").classList.toggle("alert", problems > 0);
  $("logEmpty").classList.toggle("hidden", rows.length > 0);
  const tbody = $("logRows");
  tbody.textContent = "";
  for (const e of rows) {
    const tr = document.createElement("tr");
    tr.className = "st-" + e.status;
    const when = document.createElement("td");
    when.textContent = fmtWhen(e.startedAt);
    if (e.finishedAt && e.finishedAt - e.startedAt > 1000) {
      when.title = "Took " + Math.round((e.finishedAt - e.startedAt) / 60000 * 10) / 10 + " min";
    }
    const what = document.createElement("td");
    what.textContent = LOG_KIND[e.kind] || e.kind;
    const by = document.createElement("td");
    by.textContent = e.trigger === "webhook" ? "Webhook" + (e.source ? ` (${e.source})` : "")
      : e.trigger === "schedule" ? "Schedule" : "You";
    const result = document.createElement("td");
    const status = { running: "Running", done: "Done", error: "Failed", cancelled: "Cancelled" }[e.status] || e.status;
    result.innerHTML = `<span class="logstatus"></span> <span class="logsummary"></span>`;
    result.querySelector(".logstatus").textContent = status;
    result.querySelector(".logsummary").textContent = [e.summary, e.error].filter(Boolean).join(" — ");
    const notes = [...(e.warnings || [])];
    if (e.detail && e.detail.failed && e.detail.failed.length) {
      notes.push("Couldn't remove: " + e.detail.failed.map((f) => `${f.name} (${f.error})`).join(", "));
    }
    if (e.detail && e.detail.removed && e.detail.removed.length) {
      notes.push("Removed: " + e.detail.removed.join(", "));
    }
    if (notes.length) {
      const d = document.createElement("div");
      d.className = "lognotes";
      d.textContent = notes.join(" · ");
      result.appendChild(d);
    }
    tr.append(when, what, by, result);
    tbody.appendChild(tr);
  }
}

async function loadLog() {
  const resp = await chrome.runtime.sendMessage({ cmd: "getActivityLog" }).catch(() => null);
  activityLog = (resp && resp.log) || [];
  renderLog();
}

$("logFilter").addEventListener("change", renderLog);
$("btnLogClear").addEventListener("click", async () => {
  if (!confirm("Clear the activity log in this browser?")) return;
  await chrome.runtime.sendMessage({ cmd: "clearActivityLog" });
});

// ------------------------------------------------------------- views (left nav)

const VIEW_TITLES = { friends: "Friends", activity: "Activity", automations: "Automations", settings: "Settings" };

function showView(name) {
  if (!VIEW_TITLES[name]) name = "friends";
  document.querySelectorAll(".view").forEach((v) => v.classList.toggle("hidden", v.dataset.view !== name));
  document.querySelectorAll(".navitem").forEach((a) => a.classList.toggle("active", a.dataset.view === name));
  $("pageTitle").textContent = VIEW_TITLES[name];
  // Server-backed panels load when they're looked at, not on every open.
  if (name === "automations") { loadInbound(); loadTokens(); loadNotify(); }
  if (name === "activity") loadLog();
}
window.addEventListener("hashchange", () => showView(location.hash.slice(1)));

// ------------------------------------------------------------- jobs & safety

function jobIsActive() {
  return !!(job && (job.status === "running" || job.status === "queued"));
}

// Removals the extension made today — mirrors removedToday() in background.js.
function dailyUsage() {
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  const today = Object.values(friends).filter(
    (f) => f.removedAt && !f.removedManually && f.removedAt >= midnight.getTime()
  ).length;
  return { today, cap: settings.maxRemovalsPerDay || 40 };
}

function renderDailyMeter() {
  const { today, cap } = dailyUsage();
  const el = $("dailyMeter");
  el.classList.toggle("near", today >= cap * 0.75 && today < cap);
  el.classList.toggle("full", today >= cap);
  $("dailyText").textContent = today >= cap
    ? `Daily limit reached (${cap}) — back tomorrow`
    : `Today: ${today} of ${cap} removals`;
  $("dailyFill").style.width = `${Math.min(100, (100 * today) / cap)}%`;
}

function undoSec() {
  const n = Number(settings.undoDelaySec);
  return Number.isFinite(n) ? Math.max(0, n) : 30;
}

function undoNote() {
  const sec = undoSec();
  return sec
    ? `You'll have ${sec} seconds to undo before anything is sent to Facebook. After that it can't be undone by the extension.`
    : "Removals start right away (the undo window is turned off in Settings) and can't be undone by the extension.";
}

// The window between "Remove" and anything reaching Facebook.
function renderQueuedRemoval(bar) {
  bar.classList.add("queued");
  const left = Math.max(0, Math.ceil(((job.startsAt || Date.now()) - Date.now()) / 1000));
  const n = (job.queue || []).length;
  const body = document.createElement("div");
  body.className = "jobbody";
  const label = document.createElement("span");
  label.innerHTML = left
    ? `<b>Removing ${n} ${n === 1 ? "friend" : "friends"} in ${left}s</b> — nothing has been sent to Facebook yet.`
    : `<b>Starting…</b>`;
  body.appendChild(label);
  const track = document.createElement("div");
  track.className = "jobprogress countdown";
  const fill = document.createElement("span");
  fill.className = "ok";
  const windowSec = Math.max(1, ((job.startsAt || 0) - (job.queuedAt || 0)) / 1000);
  fill.style.width = `${Math.min(100, (100 * left) / windowSec)}%`;
  track.appendChild(fill);
  body.appendChild(track);
  const names = (job.queue || []).map((k) => friends[k] && friends[k].name).filter(Boolean);
  if (names.length) {
    const who = document.createElement("div");
    who.className = "jobpacing";
    who.textContent = names.slice(0, 6).join(", ") + (names.length > 6 ? ` and ${names.length - 6} more` : "");
    body.appendChild(who);
  }
  const warnings = Array.isArray(job.warnings) ? job.warnings : [];
  if (warnings.length) {
    const w = document.createElement("div");
    w.className = "jobpacing";
    w.textContent = warnings.join(" ");
    body.appendChild(w);
  }
  bar.appendChild(body);

  const actions = document.createElement("div");
  actions.className = "jobactions";
  const undo = document.createElement("button");
  undo.className = "undo";
  undo.textContent = "Undo";
  undo.addEventListener("click", async () => {
    undo.disabled = true;
    await chrome.runtime.sendMessage({ cmd: "cancelJob" });
  });
  actions.appendChild(undo);
  const now = document.createElement("button");
  now.textContent = "Run now";
  now.title = "Skip the rest of the wait and start removing";
  now.addEventListener("click", async () => {
    now.disabled = true;
    undo.disabled = true;
    await chrome.runtime.sendMessage({ cmd: "runQueuedNow" });
  });
  actions.appendChild(now);
  bar.appendChild(actions);
}

// ------------------------------------------------------------- why suggested

// Friended in the last 60 days (or, with no date, among the 20 newest).
function isNewFriend(r) {
  if (r.friendedAt) return Date.now() - r.friendedAt < 60 * 86400000;
  return r.rank !== null && r.rank < 20;
}

// ------------------------------------------------------------- first-run checklist

function checklistState() {
  const list = Object.values(friends);
  return {
    friends: list.length > 0,
    engagement: Object.keys(engagement).length > 0 || !!lastEngagementScan || hasSyncedEngagement(),
    review: !!settings.reviewedAt || list.some((f) => f.whitelisted || f.removedAt),
  };
}

function renderChecklist() {
  const st = checklistState();
  const allDone = st.friends && st.engagement && st.review;
  $("checklist").classList.toggle("hidden", allDone || !!settings.checklistHidden);
  $("ckFriends").classList.toggle("done", st.friends);
  $("ckEngagement").classList.toggle("done", st.engagement);
  $("ckReview").classList.toggle("done", st.review);
  // One step at a time: later buttons wait for the earlier steps.
  $("ckEngagementBtn").disabled = !st.friends;
  $("ckReviewBtn").disabled = !st.engagement;
}

$("btnChecklistHide").addEventListener("click", () => {
  saveSettings({ checklistHidden: true });
  renderChecklist();
});
$("ckFriendsBtn").addEventListener("click", () => $("btnScanFriends").click());
$("ckEngagementBtn").addEventListener("click", () => $("btnScanEngagement").click());
$("ckReviewBtn").addEventListener("click", () => openReview());

// ------------------------------------------------------------- review mode
//
// One person at a time: Keep (protect), Remove (add to the list), Skip.
// Keep is saved straight away; removals are collected and go through the
// usual confirm + 30-second undo when you finish.

let rv = null; // { keys, i, choice: { key: "keep"|"remove"|"skip" } }

function reviewRow(key) {
  return visibleRows({ ignoreFilters: true }).find((r) => r.key === key) || null;
}

function openReview() {
  if (jobIsActive() && job.type === "removal") {
    alert("A removal is in progress. Review again when it's finished.");
    return;
  }
  // Start from the table as filtered and sorted, minus anyone already decided.
  const keys = visibleRows().filter((r) => !r.removedAt && !r.whitelisted).map((r) => r.key);
  if (!keys.length) {
    alert("Nobody to review with the current filters. Clear a filter, or run the scans first.");
    return;
  }
  rv = { keys, i: 0, choice: {} };
  if (!settings.reviewedAt) saveSettings({ reviewedAt: Date.now() });
  $("review").classList.remove("hidden");
  renderReview();
}

function closeReview() {
  $("review").classList.add("hidden");
  render();
}

function renderReview() {
  const total = rv.keys.length;
  const done = rv.i >= total;
  const removes = rv.keys.filter((k) => rv.choice[k] === "remove");
  const keeps = rv.keys.filter((k) => rv.choice[k] === "keep").length;
  $("rvProgress").textContent = done ? `${total} reviewed` : `${rv.i + 1} of ${total}`;
  $("rvBarFill").style.width = `${(100 * Math.min(rv.i, total)) / total}%`;
  $("rvTally").textContent = `${keeps} kept · ${removes.length} to remove · ${rv.keys.filter((k) => rv.choice[k] === "skip").length} skipped`;
  $("rvFinish").textContent = `Remove ${removes.length}`;
  $("rvFinish").disabled = removes.length === 0;
  $("rvBody").classList.toggle("hidden", done);
  $("rvDone").classList.toggle("hidden", !done);
  if (done) {
    $("rvSummary").textContent = removes.length
      ? `You chose to remove ${removes.length}. Press "Remove ${removes.length}" to start${undoSec() ? ` — you'll still have ${undoSec()} seconds to undo` : ""}.`
      : "Nothing marked for removal. Everyone you kept is now protected.";
    return;
  }
  const r = reviewRow(rv.keys[rv.i]);
  if (!r) { rv.i++; renderReview(); return; }
  // No photo yet: a transparent pixel, so the grey placeholder circle shows.
  $("rvPhoto").src = r.photo || "data:image/gif;base64,R0lGODlhAQABAAAAACw=";
  $("rvName").textContent = r.name;
  $("rvName").href = r.url;
  $("rvWhy").textContent = isNewFriend(r) ? "New friend — may not have had a chance to react or comment yet" : "";
  $("rvReactions").textContent = r.reactions;
  $("rvComments").textContent = r.comments;
  $("rvLast").textContent = r.lastAt ? fmtDate(r.lastAt) : "never";
  $("rvSince").textContent = r.friendedAt ? fmtDate(r.friendedAt) : r.rank !== null ? `#${r.rank + 1} newest` : "—";
  const c = rv.choice[r.key];
  $("rvChoice").textContent = c ? { keep: "Kept", remove: "Marked to remove", skip: "Skipped" }[c] : "";
  $("rvChoice").className = "rvchoice " + (c || "");
  $("rvBack").disabled = rv.i === 0;
}

function reviewChoose(choice) {
  if (!rv || rv.i >= rv.keys.length) return;
  const key = rv.keys[rv.i];
  const prev = rv.choice[key];
  if (choice === "keep" && prev !== "keep") setProtected([key], true);
  if (prev === "keep" && choice !== "keep") setProtected([key], false);
  rv.choice[key] = choice;
  rv.i++;
  renderReview();
}

$("rvKeep").addEventListener("click", () => reviewChoose("keep"));
$("rvRemove").addEventListener("click", () => reviewChoose("remove"));
$("rvSkip").addEventListener("click", () => reviewChoose("skip"));
$("rvBack").addEventListener("click", () => { if (rv && rv.i > 0) { rv.i--; renderReview(); } });
$("rvClose").addEventListener("click", closeReview);
$("rvFinish").addEventListener("click", () => {
  const removes = rv.keys.filter((k) => rv.choice[k] === "remove" && friends[k] && !friends[k].whitelisted);
  if (confirmAndRemove(removes)) {
    rv = null;
    closeReview();
  }
});
$("btnReview").addEventListener("click", openReview);
document.addEventListener("keydown", (e) => {
  if ($("review").classList.contains("hidden") || e.ctrlKey || e.metaKey || e.altKey) return;
  const k = e.key.toLowerCase();
  if (k === "k") reviewChoose("keep");
  else if (k === "r") reviewChoose("remove");
  else if (k === "s" || e.key === "ArrowRight") reviewChoose("skip");
  else if (e.key === "ArrowLeft") $("rvBack").click();
  else if (e.key === "Escape") closeReview();
  else return;
  e.preventDefault();
});

// ------------------------------------------------------------- send to the CRM
//
// Instead of removing someone, hand them to Not Another Social CRM to
// reconnect with. The file uses the CRM's own import columns (csv.ts there):
// Full Name, Facebook Profile URL, Facebook User ID, Tags (";"-separated).

$("btnToCrm").addEventListener("click", () => {
  const { open, unprotectable } = selectionSplit();
  const keys = [...open, ...unprotectable];
  if (!keys.length) return;
  const tag = prompt(
    `Download ${keys.length} ${keys.length === 1 ? "friend" : "friends"} as a contacts file for Not Another Social CRM.\n\nTag them with:`,
    "Reconnect"
  );
  if (tag === null) return;
  const esc = (s) => '"' + String(s || "").replace(/"/g, '""') + '"';
  const tags = [tag.trim() || "Reconnect", "From Friend Sweeper"].join("; ");
  const csv = [
    "Full Name,Facebook Profile URL,Facebook User ID,Tags",
    ...keys.map((k) => {
      const f = friends[k];
      return [esc(f.name), esc(f.url), esc(f.profileId || ""), esc(tags)].join(",");
    }),
  ].join("\n");
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = `friend-sweeper-to-crm-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
  if (confirm("Saved. In Not Another Social CRM, use Import CSV and pick this file — the people are tagged so you can start a reconnect campaign.\n\nDon't have the CRM yet? Open its website?")) {
    window.open("https://notanothersocialcrm.com", "_blank", "noopener");
  }
});

// ------------------------------------------------------------- finish notifications

let notifyCfg = { desktop: false, webhookUrl: "", webhookOn: "all" };

async function loadNotify() {
  const resp = await chrome.runtime.sendMessage({ cmd: "getNotify" }).catch(() => null);
  if (resp && resp.ok) notifyCfg = resp.notify;
  renderNotify();
}

function renderNotify() {
  $("notifyDesktop").checked = !!notifyCfg.desktop;
  if (document.activeElement !== $("notifyUrl")) $("notifyUrl").value = notifyCfg.webhookUrl || "";
  $("notifyOn").value = notifyCfg.webhookOn || "all";
  $("btnNotifyTest").disabled = !notifyCfg.desktop && !notifyCfg.webhookUrl;
}

async function saveNotify(patch) {
  const resp = await chrome.runtime.sendMessage({ cmd: "setNotify", patch }).catch((e) => ({ ok: false, error: String(e) }));
  if (resp && resp.ok) notifyCfg = resp.notify;
  else if (resp && resp.error) alert(resp.error);
  renderNotify();
  return resp && resp.ok;
}

$("notifyDesktop").addEventListener("change", async () => {
  const on = $("notifyDesktop").checked;
  // Asked for only when switched on, so installing never needs the permission.
  if (on && chrome.permissions) {
    const granted = await chrome.permissions.request({ permissions: ["notifications"] }).catch(() => false);
    if (!granted) { $("notifyDesktop").checked = false; return; }
  }
  saveNotify({ desktop: on });
});

$("btnNotifySave").addEventListener("click", async () => {
  const url = $("notifyUrl").value.trim();
  if (url) {
    let origin;
    try { origin = new URL(url).origin; } catch (e) { alert("That isn't a web address."); return; }
    if (!url.startsWith("https://")) { alert("The address must start with https://"); return; }
    // The extension may only call sites the user has allowed — ask for this one.
    if (chrome.permissions) {
      const granted = await chrome.permissions.request({ origins: [origin + "/*"] }).catch(() => false);
      if (!granted) { $("notifyStatus").textContent = "Not saved — the extension needs permission to send to that site."; return; }
    }
  }
  if (await saveNotify({ webhookUrl: url, webhookOn: $("notifyOn").value })) {
    $("notifyStatus").textContent = url ? "Saved." : "Removed.";
  }
});
$("notifyOn").addEventListener("change", () => saveNotify({ webhookOn: $("notifyOn").value }));
$("btnNotifyTest").addEventListener("click", async () => {
  $("notifyStatus").textContent = "Sending…";
  const resp = await chrome.runtime.sendMessage({ cmd: "testNotify" }).catch(() => null);
  $("notifyStatus").textContent = (resp && resp.result) || "Sent.";
});

// Live-refresh when scans — or another browser, via sync — write new data.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.nafsAccount || changes.nafsEntitlement) loadAccount();
  if (changes.syncState) {
    syncState = changes.syncState.newValue || null;
    renderSync();
  }
  if (changes.fsDrive) {
    drive = changes.fsDrive.newValue || null;
    renderSync();
    renderDrive();
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
  if (changes.activityLog) {
    activityLog = changes.activityLog.newValue || [];
    renderLog();
  }
  if (changes.lastEngagementScan) lastEngagementScan = changes.lastEngagementScan.newValue || null;
  if (changes.notify) {
    notifyCfg = changes.notify.newValue || notifyCfg;
    renderNotify();
  }
  if (inbound && (changes.inboundStatus || changes.inboundSettings)) {
    if (changes.inboundStatus) inbound.status = changes.inboundStatus.newValue || null;
    if (changes.inboundSettings) inbound.settings = changes.inboundSettings.newValue || inbound.settings;
    renderInbound();
  }
  if (changes.friends || changes.engagement || changes.job || changes.settings || changes.lastEngagementScan) render();
});

// Tick the undo countdown and the "next removal in ~Ns" countdown.
setInterval(() => {
  if (job && (job.status === "queued" || (job.type === "removal" && job.status === "running"))) renderJob();
}, 1000);

loadAccount().then(load);
loadLog();
loadInbound();
loadNotify();
showView(location.hash.slice(1));
