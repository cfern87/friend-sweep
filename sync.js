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

  function buildDecisions(friends) {
    const buckets = DEC_KEYS.map(() => []);
    for (const f of Object.values(friends)) {
      if (!f.whitelisted && !f.whitelistedAt && !f.removedAt) continue;
      const rec = trim([f.whitelisted ? 1 : 0, sec(f.whitelistedAt), sec(f.removedAt)], DEC_DEFAULTS);
      // Active protection first, then removals, then unprotect markers.
      const prio = (f.whitelisted ? 2e10 : f.removedAt ? 1e10 : 0) + sec(f.whitelistedAt);
      buckets[bucketOf(f.key, DEC_KEYS.length)].push([f.key, rec, prio]);
    }
    return buckets.map((b) => b.sort(byPriority));
  }

  function buildSummaries(friends, tally) {
    const buckets = SUM_KEYS.map(() => []);
    for (const f of Object.values(friends)) {
      const t = tally[f.key] || [0, 0, 0];
      if (!f.name && !f.lastSeen && !t[0] && !t[1]) continue; // nothing to tell
      const pid = f.profileId && !f.key.startsWith("id:") ? String(f.profileId) : "";
      const rec = trim([
        f.name || "", sec(f.lastSeen), sec(f.firstSeen), sec(f.friendedAt),
        typeof f.recentRank === "number" ? f.recentRank : -1, pid,
        t[0], t[1], sec(t[2]),
      ], SUM_DEFAULTS);
      // Current friends before removed ones; engaged before silent; then the
      // most recently seen.
      const prio = (f.removedAt ? 0 : 2e10) + (t[0] || t[1] ? 1e10 : 0) + sec(f.lastSeen);
      buckets[bucketOf(f.key, SUM_KEYS.length)].push([f.key, rec, prio]);
    }
    return buckets.map((b) => b.sort(byPriority));
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
    const rcfg = remote.cfg || {};
    const now = Date.now();

    // 1. Pull: fold sync into local data, under the store lock so a scan
    //    result or dashboard edit can't land between this read and write.
    const local = await withStoreLock(async () => {
      const got = await chrome.storage.local.get([...LOCAL_KEYS, "syncState"]);
      const state = got.syncState || {};
      if ((rcfg.w || 0) > (state.wipedAt || 0)) {
        // Another browser deleted everything after this one last synced.
        await wipeLocal(rcfg.w);
        return null;
      }
      const friends = got.friends || {};
      let friendsChanged = false;
      for (const k of SUM_KEYS) {
        if (remote.items[k]) friendsChanged = mergeSummary(friends, remote.items[k].data, now) || friendsChanged;
      }
      for (const k of DEC_KEYS) {
        if (remote.items[k]) friendsChanged = mergeDecisions(friends, remote.items[k].data, now) || friendsChanged;
      }
      const settings = rcfg.s ? mergeSettings(got.settings, rcfg) : null;
      const docIds = remote.ids ? mergeDocIds(got.docIds, remote.ids.d) : null;

      let sched = got.schedule || null;
      let schedulePatch = null;
      if (rcfg.sc && (!sched || (rcfg.sct || 0) >= sec(sched.configAt))) {
        const mine = sched ? stable(scheduleConfig(sched)) + sec(sched.configAt) : "";
        if (mine !== stable(rcfg.sc) + (rcfg.sct || 0)) {
          schedulePatch = { ...rcfg.sc, configAt: toMs(rcfg.sct) };
        }
      }
      const write = {};
      if (rcfg.lr && rcfg.lr > sec(sched && sched.lastRunAt)) {
        // Another browser ran the scheduled scans; this one skips its turn.
        sched = { ...(sched || {}), lastRunAt: toMs(rcfg.lr) };
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

    // 2. Push: write back whatever sync is missing.
    const sinceLast = Date.now() - lastPushAt;
    if (sinceLast < MIN_PUSH_GAP_MS) {
      schedule(MIN_PUSH_GAP_MS - sinceLast);
      return;
    }
    const jobRunning = hooks.isJobRunning ? await hooks.isJobRunning() : false;
    const holdSummaries = jobRunning && Date.now() - lastSummaryPushAt < JOB_SUMMARY_GAP_MS;

    const writes = {};
    let decDropped = 0;
    let sumDropped = local.state.truncated || 0;
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
      summariesPending = true;
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
    await noteState({ lastError: null, truncated: sumDropped, decTruncated: decDropped }, keys.length > 0);
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
    await withStoreLock(async () => {
      // The account sign-in isn't friend data: keep it, so wiping data
      // doesn't also sign this browser out (license.js owns these keys).
      const keep = typeof NAFS !== "undefined" ? await chrome.storage.local.get(NAFS.STORAGE_KEYS) : {};
      await chrome.storage.local.clear();
      await chrome.storage.local.set({ ...keep, syncState: { wipedAt } });
    });
    const cfg = { v: FORMAT, s: {}, st: {}, w: wipedAt };
    lastWritten.set(CFG_KEY, stable(cfg));
    await chrome.storage.sync.set({ [CFG_KEY]: cfg });
    await chrome.storage.sync.remove([IDS_KEY, ...DEC_KEYS, ...SUM_KEYS]);
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
    schedule(0);
  }

  // Must run at the worker's top level so the listeners exist on every wake.
  function init(h) {
    hooks = h || {};
    chrome.storage.onChanged.addListener(onChanged);
    chrome.alarms.onAlarm.addListener((alarm) => {
      if (alarm.name === ALARM_SYNC) schedule(0);
    });
    chrome.runtime.onInstalled.addListener(kick);
    chrome.runtime.onStartup.addListener(kick);
  }

  return { init, wipeEverywhere, syncSoon: () => schedule(0) };
})();
