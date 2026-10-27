// FriendSweep cross-browser sync over chrome.storage.sync.
//
// chrome.storage.local stays the working copy that everything reads and
// writes; this file mirrors it into chrome.storage.sync so every browser signed
// into the same Chrome (or Edge) profile converges on the same data. Loaded
// into the background worker with importScripts, so only the worker ever
// touches the synced keys.
//
// The shape of this is dictated by the sync failures the CRM extension hit:
//  * Item and byte caps (512 items, 8 KB per item, 100 KB total). One item per
//    record ran out of items, so records are hashed into a FIXED set of 12
//    deflate-compressed items. If a bucket still won't fit, the least useful
//    records are left out of the synced copy only (never out of local data),
//    removed friends first, and the dashboard says how many.
//  * MAX_WRITE_OPERATIONS_PER_MINUTE rejections. Every push is ONE set() call
//    carrying only the items whose content changed, pushes are spaced at least
//    MIN_PUSH_GAP_MS apart, and scan-result churn is held back while a job runs.
//  * Whole-blob last-write-wins clobbering. Nothing is replaced wholesale:
//    every push first folds in what is already in sync, and merges are per
//    field — protection by its own timestamp, settings by per-field
//    timestamps, removal is terminal, engagement tallies only grow. Because
//    that merge is a join, a push that loses a race with another browser is
//    repaired as soon as the loser sees the winner's write and re-pushes.
//  * Deleted data resurrecting. No record is ever deleted from sync:
//    unprotecting is a timestamped value, and "Delete all data" is a wipe
//    epoch (wipedAt) every browser honours before it pushes anything.
//  * Cross-context races. The merge into local data runs under the worker's
//    store lock, the same one the scan handlers and dashboard edits use.
//
// GOOGLE DRIVE. 100 KB can't hold a large friend list (a few thousand friends
// overflow the scan-result buckets), so a browser can also connect Google
// Drive (drive.js). Drive then carries everything — one compressed file in the
// hidden app-data folder, no buckets, nothing left out — under exactly the
// same merge rules. chrome.storage.sync keeps carrying the small, important
// part (protect/removed marks, settings, schedule, doc_ids, the wipe epoch),
// so a browser that hasn't connected Drive still gets those. Drive has no
// change events, so a one-minute alarm checks the file's version (a metadata
// call, no download) and pulls only when another browser wrote.

const FriendSync = (() => {
  const FORMAT = 1;
  const CFG_KEY = "fs_cfg";
  // Facebook doc_ids learned from live traffic (see "doc_ids" in background.js).
  // Its own small item, not part of fs_cfg: an older FriendSweep would rebuild
  // fs_cfg without the field on every push and ping-pong with newer browsers,
  // whereas an unknown item is simply ignored by older versions.
  //   { v, d: { friendlyName: [docId or "" once rejected, seenAt s] } }
  const IDS_KEY = "fs_ids";
  const DEC_KEYS = ["fs_d0", "fs_d1", "fs_d2"]; // protect / removed decisions
  const SUM_KEYS = ["fs_s0", "fs_s1", "fs_s2", "fs_s3", "fs_s4", "fs_s5", "fs_s6", "fs_s7"]; // scan results
  // QUOTA_BYTES_PER_ITEM is 8192 counting the key and the JSON value. 11 full
  // buckets plus the config item stay under the 102400-byte total.
  const ITEM_LIMIT = 8000;
  const LOCAL_DEBOUNCE_MS = 1500;
  const MIN_PUSH_GAP_MS = 3000;
  const JOB_SUMMARY_GAP_MS = 20000;
  const RATE_RETRY_MS = 60000;
  const STATE_REFRESH_MS = 60000;
  const ALARM_SYNC = "sync-reconcile";
  const LOCAL_KEYS = ["friends", "engagement", "settings", "schedule", "docIds"];

  // Google Drive (see the note at the top).
  const DRIVE_FILE = "friend-sweep-sync.json";
  // Local record of this browser's Drive link and health:
  //   { enabled, fileId, version, hash, lastSyncAt, lastError }
  // version/hash describe the Drive file as of this browser's last read or
  // write, which is what lets a poll skip the download when nothing changed.
  const DRIVE_KEY = "fsDrive";
  const ALARM_DRIVE = "sync-drive-poll";
  const DRIVE_POLL_MINUTES = 1;
  const DRIVE_MIN_PUSH_GAP_MS = 10000;
  // While a scan runs, results land every few seconds; upload the whole file
  // at most once a minute meanwhile.
  const DRIVE_JOB_GAP_MS = 60000;

  // Synced records are positional arrays with trailing defaults trimmed off.
  //   decision: [protected 0|1, protectedAt s, removedAt s]
  //   summary:  [name, lastSeen s, firstSeen s, friendedAt s, recentRank,
  //              profileId, reactions, comments, lastEngaged s]
  const DEC_DEFAULTS = [0, 0, 0];
  const SUM_DEFAULTS = ["", 0, 0, 0, -1, "", 0, 0, 0];

  let hooks = {};
  let running = false;
  let again = false;
  let timer = null;
  let dueAt = 0;
  let lastPushAt = 0;
  let lastSummaryPushAt = 0;
  let lastDrivePushAt = 0;
  // What this worker last wrote per sync key, so its own writes echoing back
  // through onChanged don't trigger another round.
  const lastWritten = new Map();

  // Timestamps travel in whole seconds; comparisons are always made in
  // seconds so a value that has round-tripped compares equal to its source.
  const sec = (ms) => (ms ? Math.floor(ms / 1000) : 0);
  const toMs = (s) => (s ? s * 1000 : 0);

  function bucketOf(key, n) {
    let h = 0x811c9dc5; // FNV-1a — must stay identical across versions
    for (let i = 0; i < key.length; i++) {
      h ^= key.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0) % n;
  }

  // Key-sorted JSON, so equal content always produces an equal string.
  function stable(v) {
    if (Array.isArray(v)) return "[" + v.map(stable).join(",") + "]";
    if (v && typeof v === "object") {
      return "{" + Object.keys(v).sort()
        .filter((k) => v[k] !== undefined)
        .map((k) => JSON.stringify(k) + ":" + stable(v[k]))
        .join(",") + "}";
    }
    return v === undefined ? "null" : JSON.stringify(v);
  }

  function trim(arr, defs) {
    let n = arr.length;
    while (n > 0 && arr[n - 1] === defs[n - 1]) n--;
    return arr.slice(0, n);
  }

  function fields(arr, defs) {
    return defs.map((d, i) => (Array.isArray(arr) && arr[i] != null ? arr[i] : d));
  }

  async function deflate(str) {
    const stream = new Blob([str]).stream().pipeThrough(new CompressionStream("deflate-raw"));
    const buf = new Uint8Array(await new Response(stream).arrayBuffer());
    let bin = "";
    for (let i = 0; i < buf.length; i += 0x8000) {
      bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
    }
    return btoa(bin);
  }

  async function sha256(str) {
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
    return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
  }

  async function inflate(b64) {
    const bin = atob(b64);
    const buf = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
    const stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
    return new Response(stream).text();
  }

  function urlFromKey(key) {
    if (key.startsWith("id:")) return "https://www.facebook.com/profile.php?id=" + key.slice(3);
    if (key.startsWith("u:")) return "https://www.facebook.com/" + key.slice(2);
    return "";
  }

  // A friend this browser hasn't scanned yet, known only from sync.
  function stub(key, now) {
    return { key, name: "", url: urlFromKey(key), photo: "", firstSeen: now, lastSeen: 0 };
  }

  // ------------------------------------------------------------ read

  async function readRemote() {
    const all = await chrome.storage.sync.get(null);
    const remote = { cfg: null, ids: null, items: {}, newer: false };
    const cfg = all[CFG_KEY];
    if (cfg && typeof cfg === "object") {
      if ((cfg.v || 0) > FORMAT) remote.newer = true;
      remote.cfg = cfg;
    }
    const ids = all[IDS_KEY];
    if (ids && typeof ids === "object") {
      if ((ids.v || 0) > FORMAT) remote.newer = true;
      else remote.ids = ids;
    }
    for (const key of [...DEC_KEYS, ...SUM_KEYS]) {
      const item = all[key];
      if (!item || typeof item.z !== "string") continue;
      if ((item.v || 0) > FORMAT) {
        remote.newer = true;
        continue;
      }
      try {
        const json = await inflate(item.z);
        remote.items[key] = { json, data: JSON.parse(json) };
      } catch (e) {
        // A corrupt bucket reads as empty; this browser's next push rewrites it.
      }
    }
    return remote;
  }

  async function driveState() {
    const got = await chrome.storage.local.get(DRIVE_KEY);
    return got[DRIVE_KEY] || { enabled: false };
  }

  // Merge a patch into the Drive record. Skips the write when nothing a viewer
  // would notice changed (lastSyncAt alone refreshes at most once a minute).
  async function patchDrive(patch) {
    await withStoreLock(async () => {
      const cur = (await chrome.storage.local.get(DRIVE_KEY))[DRIVE_KEY] || { enabled: false };
      const next = { ...cur, ...patch };
      if (patch.lastSyncAt && cur.lastSyncAt && patch.lastSyncAt - cur.lastSyncAt < STATE_REFRESH_MS &&
          stable({ ...next, lastSyncAt: 0 }) === stable({ ...cur, lastSyncAt: 0 })) return;
      if (stable(next) === stable(cur)) return;
      await chrome.storage.local.set({ [DRIVE_KEY]: next });
    });
  }

  // Drive file: {v, z: deflate(stable JSON of {v, cfg, ids, d, s})}, where d
  // and s are the same decision and summary records as the sync buckets, for
  // every friend. Returns { unchanged } when the file's version is the one this
  // browser last read or wrote — the poll's whole cost is one metadata call.
  async function readDrive(st) {
    if (st.fileId && st.hash) {
      const m = await FriendDrive.getMeta(st.fileId);
      if (m && m.version && m.version === st.version) {
        return { unchanged: true, newer: false, primary: m, extras: [], docs: [], remoteHash: st.hash };
      }
    }
    // Changed (or first read): list rather than trust the cached id, so a
    // duplicate file from two browsers creating it at once is found and folded
    // back into the oldest.
    const files = await FriendDrive.listFiles(DRIVE_FILE);
    const out = { unchanged: false, newer: false, primary: files[0] || null, extras: files.slice(1), docs: [], remoteHash: "" };
    for (let i = 0; i < files.length; i++) {
      const text = await FriendDrive.download(files[i].id);
      if (text == null) continue;
      let doc;
      try {
        const wrap = JSON.parse(text);
        if ((wrap.v || 0) > FORMAT) {
          out.newer = true;
          continue;
        }
        doc = JSON.parse(await inflate(wrap.z));
        if ((doc.v || 0) > FORMAT) {
          out.newer = true;
          continue;
        }
      } catch (e) {
        continue; // a corrupt file reads as empty; this browser's push rewrites it
      }
      out.docs.push(doc);
      if (i === 0) out.remoteHash = await sha256(stable(doc));
    }
    return out;
  }

  // ------------------------------------------------------------ merge

  function mergeSummary(friends, data, now) {
    let changed = false;
    for (const [key, entry] of Object.entries(data || {})) {
      if (!Array.isArray(entry)) continue;
      const [name, ls, fs, fa, rank, pid, er, ec, el] = fields(entry, SUM_DEFAULTS);
      let f = friends[key];
      if (!f) {
        f = friends[key] = stub(key, now);
        changed = true;
      }
      // Name, rank and date come from whichever browser scanned this friend
      // most recently. On a tie the synced copy wins, so two browsers holding
      // different values settle on one instead of overwriting each other.
      if (ls && ls >= sec(f.lastSeen)) {
        if (ls > sec(f.lastSeen)) {
          f.lastSeen = toMs(ls);
          changed = true;
        }
        if (name && name !== f.name) {
          f.name = name;
          changed = true;
        }
        if (rank >= 0 && rank !== f.recentRank) {
          f.recentRank = rank;
          changed = true;
        }
        if (fa && fa !== sec(f.friendedAt)) {
          f.friendedAt = toMs(fa);
          changed = true;
        }
      }
      if (name && !f.name) {
        f.name = name;
        changed = true;
      }
      if (fs && (!f.firstSeen || fs < sec(f.firstSeen))) {
        f.firstSeen = toMs(fs);
        changed = true;
      }
      if (fa && !f.friendedAt) {
        f.friendedAt = toMs(fa);
        changed = true;
      }
      if (rank >= 0 && typeof f.recentRank !== "number") {
        f.recentRank = rank;
        changed = true;
      }
      if (pid && !f.profileId) {
        f.profileId = String(pid);
        changed = true;
      }
      // Tallies from other browsers' engagement scans. Both browsers scan the
      // same account, so the larger count is the better-informed one.
      if (er || ec || el) {
        const s = f.syncEng || [0, 0, 0];
        const m = [Math.max(s[0], er), Math.max(s[1], ec), Math.max(s[2], toMs(el))];
        if (m[0] !== s[0] || m[1] !== s[1] || m[2] !== s[2]) {
          f.syncEng = m;
          changed = true;
        }
      }
    }
    return changed;
  }

  function mergeDecisions(friends, data, now) {
    let changed = false;
    for (const [key, entry] of Object.entries(data || {})) {
      if (!Array.isArray(entry)) continue;
      const [w, wt, r] = fields(entry, DEC_DEFAULTS);
      let f = friends[key];
      if (!f) {
        f = friends[key] = stub(key, now);
        changed = true;
      }
      const lwt = sec(f.whitelistedAt);
      if (wt > lwt) {
        f.whitelisted = !!w;
        f.whitelistedAt = toMs(wt);
        changed = true;
      } else if (wt === lwt && w && !f.whitelisted) {
        // Same moment (or both pre-sync with no timestamp): protection wins,
        // so a tie can never cost anyone their protection.
        f.whitelisted = true;
        changed = true;
      }
      // Removal is terminal — once unfriended on any browser, removed on all.
      if (r && (!f.removedAt || r < sec(f.removedAt))) {
        f.removedAt = toMs(r);
        changed = true;
      }
    }
    return changed;
  }

  // Returns the merged settings object, or null when nothing changed. Newer
  // field wins; on a tie the synced value wins (see mergeSummary).
  function mergeSettings(settings, cfg) {
    const out = { ...(settings || {}) };
    const ts = { ...(out._ts || {}) };
    let changed = false;
    for (const [k, v] of Object.entries(cfg.s || {})) {
      const rts = (cfg.st && cfg.st[k]) || 0;
      if (rts >= sec(ts[k]) || out[k] === undefined) {
        if (stable(out[k]) !== stable(v)) {
          out[k] = v;
          changed = true;
        }
        if (rts && sec(ts[k]) !== rts) {
          ts[k] = toMs(rts);
          changed = true;
        }
      }
    }
    if (!changed) return null;
    out._ts = ts;
    return out;
  }

  // Returns the merged doc_id map, or null when nothing changed. Per name, the
  // newer seenAt wins (a rejection is a newer entry with no id, so a dead id
  // can't come back); on a tie the synced value wins (see mergeSummary).
  // Local-only diagnostics (seed, staleAt, …) are kept as they are.
  function mergeDocIds(docIds, data) {
    const out = { ...(docIds || {}) };
    let changed = false;
    for (const [name, entry] of Object.entries(data || {})) {
      if (!Array.isArray(entry) || !/^[A-Za-z0-9_]{3,120}$/.test(name)) continue;
      const id = typeof entry[0] === "string" && /^\d{5,25}$/.test(entry[0]) ? entry[0] : null;
      const s = Number(entry[1]) || 0;
      if (!s) continue;
      const cur = out[name];
      const ls = sec(cur && cur.seenAt);
      if (cur && (s < ls || (s === ls && (cur.docId || null) === id))) continue;
      out[name] = { ...(cur || {}), docId: id, seenAt: toMs(s) };
      changed = true;
    }
    return changed ? out : null;
  }

  function buildIds(docIds) {
    const d = {};
    for (const [name, e] of Object.entries(docIds || {})) {
      if (e && sec(e.seenAt)) d[name] = [e.docId || "", sec(e.seenAt)];
    }
    return Object.keys(d).length ? { v: FORMAT, d } : null;
  }

  function scheduleConfig(s) {
    return { enabled: !!s.enabled, everyHours: s.everyHours, days: s.days, scans: s.scans || [] };
  }

  // ------------------------------------------------------------ build

  function tallies(engagement, friends) {
    const t = {};
    for (const ev of Object.values(engagement || {})) {
      const a = (t[ev.friendKey] ||= [0, 0, 0]);
      if (ev.type === "reaction") a[0]++;
      else if (ev.type === "comment") a[1]++;
      if (ev.at > a[2]) a[2] = ev.at;
    }
    // Tallies that arrived from other browsers pass on too.
    for (const f of Object.values(friends)) {
      const s = f.syncEng;
      if (!s) continue;
      const a = (t[f.key] ||= [0, 0, 0]);
      a[0] = Math.max(a[0], s[0]);
      a[1] = Math.max(a[1], s[1]);
      a[2] = Math.max(a[2], s[2]);
    }
    return t;
  }

  // Each bucket is a list of [key, record, priority] — highest priority first,
  // so an overfull bucket keeps what matters most.
  function byPriority(a, b) {
    return b[2] - a[2] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
  }

  // [record, priority] for one friend, or null when there's nothing to sync.
  function decisionRecord(f) {
    if (!f.whitelisted && !f.whitelistedAt && !f.removedAt) return null;
    const rec = trim([f.whitelisted ? 1 : 0, sec(f.whitelistedAt), sec(f.removedAt)], DEC_DEFAULTS);
    // Active protection first, then removals, then unprotect markers.
    const prio = (f.whitelisted ? 2e10 : f.removedAt ? 1e10 : 0) + sec(f.whitelistedAt);
    return [rec, prio];
  }

  function summaryRecord(f, tally) {
    const t = tally[f.key] || [0, 0, 0];
    if (!f.name && !f.lastSeen && !t[0] && !t[1]) return null; // nothing to tell
    const pid = f.profileId && !f.key.startsWith("id:") ? String(f.profileId) : "";
    const rec = trim([
      f.name || "", sec(f.lastSeen), sec(f.firstSeen), sec(f.friendedAt),
      typeof f.recentRank === "number" ? f.recentRank : -1, pid,
      t[0], t[1], sec(t[2]),
    ], SUM_DEFAULTS);
    // Current friends before removed ones; engaged before silent; then the
    // most recently seen.
    const prio = (f.removedAt ? 0 : 2e10) + (t[0] || t[1] ? 1e10 : 0) + sec(f.lastSeen);
    return [rec, prio];
  }

  function buildDecisions(friends) {
    const buckets = DEC_KEYS.map(() => []);
    for (const f of Object.values(friends)) {
      const r = decisionRecord(f);
      if (r) buckets[bucketOf(f.key, DEC_KEYS.length)].push([f.key, r[0], r[1]]);
    }
    return buckets.map((b) => b.sort(byPriority));
  }

  function buildSummaries(friends, tally) {
    const buckets = SUM_KEYS.map(() => []);
    for (const f of Object.values(friends)) {
      const r = summaryRecord(f, tally);
      if (r) buckets[bucketOf(f.key, SUM_KEYS.length)].push([f.key, r[0], r[1]]);
    }
    return buckets.map((b) => b.sort(byPriority));
  }

  // The whole synced state in one object, for Drive — nothing left out.
  function buildDriveDoc(local) {
    const d = {};
    const s = {};
    const tally = tallies(local.engagement, local.friends);
    for (const f of Object.values(local.friends)) {
      const dr = decisionRecord(f);
      if (dr) d[f.key] = dr[0];
      const sr = summaryRecord(f, tally);
      if (sr) s[f.key] = sr[0];
    }
    const doc = { v: FORMAT, cfg: buildCfg(local.settings, local.schedule, local.state), d, s };
    const ids = buildIds(local.docIds);
    if (ids) doc.ids = ids;
    return doc;
  }

  async function encodeBucket(key, entries) {
    const make = async (n) => {
      const obj = {};
      for (let i = 0; i < n; i++) obj[entries[i][0]] = entries[i][1];
      const json = stable(obj);
      const item = { v: FORMAT, z: await deflate(json) };
      return { json, item, size: key.length + JSON.stringify(item).length };
    };
    const full = await make(entries.length);
    if (full.size <= ITEM_LIMIT) return { ...full, dropped: 0 };
    // Largest priority prefix that fits.
    let lo = 0;
    let hi = entries.length;
    let best = await make(0);
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      const c = await make(mid);
      if (c.size <= ITEM_LIMIT) {
        lo = mid;
        best = c;
      } else {
        hi = mid;
      }
    }
    return { ...best, dropped: entries.length - lo };
  }

  function buildCfg(settings, schedule, state) {
    const s = {};
    const st = {};
    const ts = (settings && settings._ts) || {};
    for (const [k, v] of Object.entries(settings || {})) {
      if (k === "_ts") continue;
      s[k] = v;
      if (ts[k]) st[k] = sec(ts[k]);
    }
    const cfg = { v: FORMAT, s, st };
    if (schedule) {
      cfg.sc = scheduleConfig(schedule);
      cfg.sct = sec(schedule.configAt);
      cfg.lr = sec(schedule.lastRunAt);
    }
    if (state.wipedAt) cfg.w = state.wipedAt;
    return cfg;
  }

  // ------------------------------------------------------------ reconcile

  function schedule(delay) {
    const at = Date.now() + delay;
    if (timer && dueAt <= at) return; // an earlier run is already due
    clearTimeout(timer);
    dueAt = at;
    timer = setTimeout(() => {
      timer = null;
      reconcile();
    }, Math.max(0, delay));
  }

  async function reconcile() {
    if (running) {
      again = true;
      return;
    }
    running = true;
    try {
      await reconcileOnce();
    } catch (e) {
      const msg = String((e && e.message) || e);
      // Quota-rate rejections are transient: the same write succeeds shortly.
      if (/MAX_WRITE_OPERATIONS/i.test(msg)) schedule(RATE_RETRY_MS);
      await noteState({ lastError: msg }).catch(() => {});
    } finally {
      running = false;
      if (again) {
        again = false;
        schedule(0);
      }
    }
  }

  async function wipeLocal(wipedAt) {
    await chrome.storage.local.set({ syncState: { wipedAt } });
    await chrome.storage.local.remove(["friends", "engagement", "settings", "schedule", "selfUrl", "docIds"]);
  }

  async function reconcileOnce() {
    const remote = await readRemote();
    if (remote.newer) {
      // Writing our older format would clobber what the newer one stored.
      await noteState({ lastError: "another browser runs a newer FriendSweep — update this one to resume syncing" });
      return;
    }

    // Drive, when this browser has connected it. A Drive failure (offline,
    // signed out of Google) never stops chrome.storage.sync from working.
    const dst = await driveState();
    let drive = null;
    let driveError = null;
    if (dst.enabled) {
      try {
        drive = await readDrive(dst);
        if (drive.newer) {
          driveError = "another browser runs a newer FriendSweep — update this one to resume Drive sync";
          drive = null;
        }
      } catch (e) {
        driveError = errText(e);
      }
    }

    // Every source, in one list per kind. The merges are joins, so the order
    // doesn't matter and folding the same data in twice is harmless.
    const cfgs = [remote.cfg];
    const idsList = [remote.ids && remote.ids.d];
    const sums = SUM_KEYS.map((k) => remote.items[k] && remote.items[k].data);
    const decs = DEC_KEYS.map((k) => remote.items[k] && remote.items[k].data);
    for (const doc of (drive && drive.docs) || []) {
      cfgs.push(doc.cfg);
      idsList.push(doc.ids && doc.ids.d);
      sums.push(doc.s);
      decs.push(doc.d);
    }
    const rcfgs = cfgs.filter((c) => c && typeof c === "object");
    const wipedAt = Math.max(0, ...rcfgs.map((c) => c.w || 0));
    const lastRun = Math.max(0, ...rcfgs.map((c) => c.lr || 0));
    // The schedule as most recently configured anywhere.
    const sched0 = rcfgs.filter((c) => c.sc).sort((a, b) => (b.sct || 0) - (a.sct || 0))[0] || null;
    const now = Date.now();

    // 1. Pull: fold sync into local data, under the store lock so a scan
    //    result or dashboard edit can't land between this read and write.
    const local = await withStoreLock(async () => {
      const got = await chrome.storage.local.get([...LOCAL_KEYS, "syncState"]);
      const state = got.syncState || {};
      if (wipedAt > (state.wipedAt || 0)) {
        // Another browser deleted everything after this one last synced.
        await wipeLocal(wipedAt);
        return null;
      }
      const friends = got.friends || {};
      let friendsChanged = false;
      for (const data of sums) if (data) friendsChanged = mergeSummary(friends, data, now) || friendsChanged;
      for (const data of decs) if (data) friendsChanged = mergeDecisions(friends, data, now) || friendsChanged;

      let settings = null;
      for (const c of rcfgs) {
        if (!c.s) continue;
        const m = mergeSettings(settings || got.settings, c);
        if (m) settings = m;
      }
      let docIds = null;
      for (const d of idsList) {
        if (!d) continue;
        const m = mergeDocIds(docIds || got.docIds, d);
        if (m) docIds = m;
      }

      let sched = got.schedule || null;
      let schedulePatch = null;
      if (sched0 && (!sched || (sched0.sct || 0) >= sec(sched.configAt))) {
        const mine = sched ? stable(scheduleConfig(sched)) + sec(sched.configAt) : "";
        if (mine !== stable(sched0.sc) + (sched0.sct || 0)) {
          schedulePatch = { ...sched0.sc, configAt: toMs(sched0.sct) };
        }
      }
      const write = {};
      if (lastRun && lastRun > sec(sched && sched.lastRunAt)) {
        // Another browser ran the scheduled scans; this one skips its turn.
        sched = { ...(sched || {}), lastRunAt: toMs(lastRun) };
        if (schedulePatch) schedulePatch.lastRunAt = sched.lastRunAt;
        else write.schedule = sched;
      }
      if (friendsChanged) write.friends = friends;
      if (settings) write.settings = settings;
      if (docIds) write.docIds = docIds;
      if (Object.keys(write).length) {
        state.lastPullAt = now;
        write.syncState = state; // marks the write as ours (see onChanged)
        await chrome.storage.local.set(write);
      }
      return {
        friends,
        engagement: got.engagement || {},
        settings: settings || got.settings || null,
        docIds: docIds || got.docIds || {},
        schedule: sched,
        schedulePatch,
        state,
      };
    });

    if (!local) {
      if (hooks.afterWipe) await hooks.afterWipe();
      return;
    }
    if (local.schedulePatch && hooks.applySchedule) {
      // Re-arms this browser's alarm to the schedule set elsewhere.
      local.schedule = await hooks.applySchedule(local.schedulePatch);
    }

    // 2. Push: write back whatever each store is missing.
    const jobRunning = hooks.isJobRunning ? await hooks.isJobRunning() : false;
    const driveOn = !!(dst.enabled && drive);
    // A chrome.storage.sync rejection (quota, write rate) mustn't stop the
    // Drive push; it's re-thrown afterwards for reconcile() to record.
    let syncErr = null;
    try {
      await pushSync(remote, local, jobRunning, dst.enabled);
    } catch (e) {
      syncErr = e;
    }
    if (driveOn) {
      try {
        await pushDrive(drive, local, jobRunning);
      } catch (e) {
        driveError = errText(e);
      }
    }
    if (dst.enabled) {
      if (driveError) await patchDrive({ lastError: driveError });
      else if (drive) await patchDrive({ lastError: null, lastSyncAt: Date.now() });
    }
    if (syncErr) throw syncErr;
  }

  function errText(e) {
    return String((e && e.message) || e);
  }

  async function pushSync(remote, local, jobRunning, driveOn) {
    const sinceLast = Date.now() - lastPushAt;
    if (sinceLast < MIN_PUSH_GAP_MS) {
      schedule(MIN_PUSH_GAP_MS - sinceLast);
      return;
    }
    // With Drive connected, scan results go to Drive only: they're what
    // overflows 100 KB. The rest stays here for browsers without Drive.
    const holdSummaries = driveOn || (jobRunning && Date.now() - lastSummaryPushAt < JOB_SUMMARY_GAP_MS);

    const writes = {};
    let decDropped = 0;
    let sumDropped = driveOn ? 0 : local.state.truncated || 0;
    let summariesPending = false;

    const dec = buildDecisions(local.friends);
    for (let i = 0; i < DEC_KEYS.length; i++) {
      if (!dec[i].length) continue;
      const enc = await encodeBucket(DEC_KEYS[i], dec[i]);
      decDropped += enc.dropped;
      const prev = remote.items[DEC_KEYS[i]];
      if (!prev || prev.json !== enc.json) writes[DEC_KEYS[i]] = enc.item;
    }

    if (holdSummaries) {
      // A scan rewrites results every few seconds; batch them up meanwhile.
      summariesPending = !driveOn;
    } else {
      sumDropped = 0;
      const sum = buildSummaries(local.friends, tallies(local.engagement, local.friends));
      for (let i = 0; i < SUM_KEYS.length; i++) {
        if (!sum[i].length) continue;
        const enc = await encodeBucket(SUM_KEYS[i], sum[i]);
        sumDropped += enc.dropped;
        const prev = remote.items[SUM_KEYS[i]];
        if (!prev || prev.json !== enc.json) writes[SUM_KEYS[i]] = enc.item;
      }
    }

    const cfg = buildCfg(local.settings, local.schedule, local.state);
    if (stable(cfg) !== stable(remote.cfg)) writes[CFG_KEY] = cfg;

    const ids = buildIds(local.docIds);
    if (ids && stable(ids) !== stable(remote.ids)) writes[IDS_KEY] = ids;

    const keys = Object.keys(writes);
    if (keys.length) {
      for (const k of keys) lastWritten.set(k, stable(writes[k]));
      await chrome.storage.sync.set(writes); // one write operation, however many items
      lastPushAt = Date.now();
      if (keys.some((k) => SUM_KEYS.includes(k))) lastSummaryPushAt = lastPushAt;
    }
    if (summariesPending) {
      schedule(Math.max(1000, JOB_SUMMARY_GAP_MS - (Date.now() - lastSummaryPushAt)));
    }
    // Drive carries everything, so nothing is really left out when it's on.
    await noteState({
      lastError: null,
      truncated: driveOn ? 0 : sumDropped,
      decTruncated: driveOn ? 0 : decDropped,
    }, keys.length > 0);
  }

  // Upload the whole state to Drive when it differs from the file there. One
  // PATCH of one file, however much changed.
  async function pushDrive(drive, local, jobRunning) {
    const doc = buildDriveDoc(local);
    const json = stable(doc);
    const hash = await sha256(json);
    if (hash === drive.remoteHash && !drive.extras.length) {
      if (drive.primary && !drive.unchanged) {
        // Just read and already identical: remember it so polls stay cheap.
        await patchDrive({ fileId: drive.primary.id, version: drive.primary.version, hash });
      }
      return;
    }
    const gap = Math.max(
      DRIVE_MIN_PUSH_GAP_MS - (Date.now() - lastDrivePushAt),
      jobRunning ? DRIVE_JOB_GAP_MS - (Date.now() - lastDrivePushAt) : 0
    );
    if (gap > 0) {
      schedule(gap);
      return;
    }
    const body = JSON.stringify({ v: FORMAT, z: await deflate(json) });
    let m = drive.primary ? await FriendDrive.update(drive.primary.id, body) : null;
    let created = false;
    if (!m) {
      m = await FriendDrive.create(DRIVE_FILE, body);
      created = true;
    }
    lastDrivePushAt = Date.now();
    // Duplicates were folded into this push; drop them.
    for (const x of drive.extras) await FriendDrive.remove(x.id).catch(() => {});
    // After a create, leave the hash empty so the next pass lists the folder
    // again: another browser may have created its own file at the same moment,
    // and that pass merges the two.
    await patchDrive({ fileId: m.id, version: m.version, hash: created ? "" : hash });
    if (created) schedule(DRIVE_MIN_PUSH_GAP_MS);
  }

  // Record sync health for the dashboard. Skips the write when nothing a
  // viewer would notice changed, so idle reconciles don't churn local storage.
  async function noteState(patch, synced = false) {
    await withStoreLock(async () => {
      const { syncState = {} } = await chrome.storage.local.get("syncState");
      const next = { ...syncState, ...patch };
      const now = Date.now();
      const stale = !syncState.lastSyncAt || now - syncState.lastSyncAt > STATE_REFRESH_MS;
      if (!patch.lastError && (synced || stale)) next.lastSyncAt = now;
      if (stable(next) === stable(syncState)) return;
      await chrome.storage.local.set({ syncState: next });
    });
  }

  // ------------------------------------------------------------ wipe

  // "Delete all data": the wipe epoch goes up first, so a browser that sees
  // the buckets vanish already knows not to push its old copy back.
  async function wipeEverywhere() {
    const wipedAt = Date.now();
    const dst = await driveState();
    await withStoreLock(async () => {
      // The account sign-in and the Drive connection aren't friend data: keep
      // them, so wiping data doesn't also sign this browser out (license.js
      // and drive.js own those keys).
      const keepKeys = [
        ...(typeof NAFS !== "undefined" ? NAFS.STORAGE_KEYS : []),
        ...FriendDrive.STORAGE_KEYS,
      ];
      const keep = await chrome.storage.local.get(keepKeys);
      await chrome.storage.local.clear();
      await chrome.storage.local.set({
        ...keep,
        syncState: { wipedAt },
        // Same file, but its content is about to be replaced.
        [DRIVE_KEY]: { enabled: !!dst.enabled, fileId: dst.fileId || "", version: "", hash: "" },
      });
    });
    const cfg = { v: FORMAT, s: {}, st: {}, w: wipedAt };
    lastWritten.set(CFG_KEY, stable(cfg));
    await chrome.storage.sync.set({ [CFG_KEY]: cfg });
    await chrome.storage.sync.remove([IDS_KEY, ...DEC_KEYS, ...SUM_KEYS]);
    if (dst.enabled) {
      try {
        const body = JSON.stringify({ v: FORMAT, z: await deflate(stable({ v: FORMAT, cfg, d: {}, s: {} })) });
        const files = await FriendDrive.listFiles(DRIVE_FILE);
        if (files.length) {
          await FriendDrive.update(files[0].id, body);
          for (const x of files.slice(1)) await FriendDrive.remove(x.id).catch(() => {});
        } else {
          await FriendDrive.create(DRIVE_FILE, body);
        }
      } catch (e) {
        // The next reconcile pushes the wipe epoch (it's in local state now).
        await patchDrive({ lastError: errText(e) });
      }
    }
  }

  // ------------------------------------------------------------ Drive connect

  async function ensureDrivePoll(enabled) {
    if (!enabled) {
      await chrome.alarms.clear(ALARM_DRIVE);
      return;
    }
    if (!(await chrome.alarms.get(ALARM_DRIVE))) {
      chrome.alarms.create(ALARM_DRIVE, { periodInMinutes: DRIVE_POLL_MINUTES });
    }
  }

  async function driveConnect() {
    const res = await FriendDrive.connect();
    if (!res.ok) return res;
    // Fresh link: forget any file state from an earlier connection.
    await patchDrive({ enabled: true, fileId: "", version: "", hash: "", lastError: null });
    await ensureDrivePoll(true);
    schedule(0);
    return res;
  }

  async function driveDisconnect() {
    await patchDrive({ enabled: false, lastError: null });
    await ensureDrivePoll(false);
    await FriendDrive.disconnect();
    return { ok: true };
  }

  async function driveStatus() {
    return { ...(await FriendDrive.authState()), ...(await driveState()) };
  }

  // ------------------------------------------------------------ wiring

  function onChanged(changes, area) {
    if (area === "sync") {
      // Another browser's write: pull it in right away. Echoes of our own
      // writes are recognised and skipped.
      const foreign = Object.entries(changes).some(
        ([k, c]) => k.startsWith("fs_") &&
          (c.newValue === undefined || lastWritten.get(k) !== stable(c.newValue))
      );
      if (foreign) schedule(0);
    } else if (area === "local") {
      if (changes.syncState) return; // written by this file
      if (LOCAL_KEYS.some((k) => changes[k])) schedule(LOCAL_DEBOUNCE_MS);
    }
  }

  async function kick() {
    if (!(await chrome.alarms.get(ALARM_SYNC))) {
      // Backstop for anything an event missed (e.g. the worker was stopped
      // between a change and its debounced push).
      chrome.alarms.create(ALARM_SYNC, { periodInMinutes: 5 });
    }
    // Alarms are cleared when the extension updates; re-arm the Drive poll.
    await ensureDrivePoll((await driveState()).enabled);
    schedule(0);
  }

  // Must run at the worker's top level so the listeners exist on every wake.
  function init(h) {
    hooks = h || {};
    chrome.storage.onChanged.addListener(onChanged);
    chrome.alarms.onAlarm.addListener((alarm) => {
      if (alarm.name === ALARM_SYNC) schedule(0);
      else if (alarm.name === ALARM_DRIVE) {
        // Renew the Google token on a schedule (matters on the hourly fallback
        // path), then check Drive for another browser's write.
        FriendDrive.ensureFreshToken().catch(() => {}).finally(() => schedule(0));
      }
    });
    chrome.runtime.onInstalled.addListener(kick);
    chrome.runtime.onStartup.addListener(kick);
  }

  return {
    init,
    wipeEverywhere,
    syncSoon: () => schedule(0),
    driveConnect,
    driveDisconnect,
    driveStatus,
  };
})();
