# Not Another Friend Sweeper (formerly FriendSweep)

> **Accounts & plans (v1.2+).** The extension is locked until it is signed in to a
> notanotherfriendsweeper.com account. `license.js` holds the session (handed over by the
> site's `/extension-auth` page via `externally_connectable`), checks the plan at
> `/api/public/entitlement`, and reports completed removals to `/api/public/removals`.
> Free: 40 removals per calendar month (UTC), 1-month engagement look-back. Pro: unlimited
> removals, 1-year look-back, scheduled scans, CSV export. Friend data still never leaves the
> browser. When the site moves to a new domain, update `PLATFORM_URL`/`PLATFORM_ORIGINS` in
> `license.js` and `externally_connectable` in `manifest.json` together.

A browser extension that helps you understand and tidy up your Facebook friends list:

1. **Scan friends** — lists every friend (name, profile link, photo, numeric id) using the same requests the Facebook page itself makes, so a full list comes back in seconds. If that path is unavailable it falls back to reading the friends page as it loads. A second pass reads the **"Recently added"** tab to record each friend's friendship-recency rank (#1 = newest friend).
1b. **Scan friend dates** — reads your **Activity Log → Friends** category (`…/allactivity/?category_key=FRIENDS`), which lists every "became friends with …" event under a date header, and records the **real date you friended each person**.
2. **Scan engagement** — goes back through your timeline posts over a chosen time window (presets from 1 week to 1 year) and records which friends reacted or commented on each. It reads each post's reactions and comments through the same requests the page uses (paginated, no opening dialogs or expanding threads), falling back to reading the reaction list and comments from the page if that path is unavailable. Events are stamped with the post's real date, so "Last engaged" reflects when the interaction actually happened.
3. **Score & suggest** — every friend gets a score (`reactions + 2 × comments`). Friends with zero recorded engagement are flagged **suggested** for removal.
4. **Protect (whitelist)** — click the ☆ in the **Protect** column to mark a friend as protected. Protected friends are never flagged **suggested**, and removal skips them: they're held back both by the dashboard and by the background worker even if they were selected. They can still be ticked, so bulk actions reach them — tick them (or use **Select all on page**) and click **Protect selected** or **Unprotect selected**. The button labels show how many of your selection each action would actually affect, and the remove confirmation tells you how many protected people it's skipping. Protected friends are **hidden by default** (they're people you've already decided to keep, so they're noise in a clean-up list) — untick "Hide protected" to see them again, and the choice is remembered.
4b. **Scheduled scans** — the **Scheduled scans** panel at the bottom of the dashboard re-runs the scans you pick: choose how often (6 hours … 1 week), which scans to include, and the engagement look-back window. Each run opens a Facebook tab, runs the chosen scans back-to-back in it, and closes it again. Only the read-only scans can be scheduled — removals are never scheduled.
5. **Remove** — select friends in the dashboard, confirm, and the extension removes that selection from a **single** Facebook tab: one unfriend request per friend, with no per-profile page loads. Removals are paced with randomized delays and a per-run cap (Facebook limits bursts, and each friend is its own request), and you can cancel at any time. If the request path can't run, it falls back to the per-profile page flow.

All data lives in `chrome.storage.local` in your browser, and is mirrored through `chrome.storage.sync` to every browser signed into the same Chrome profile (or Edge profile, with extension sync on), so each computer shows the same friends, protections, removals and settings. Browser sync is capped at 100 KB, so for a large friend list (a few thousand friends) you can also **connect Google Drive** (dashboard → *Google Drive sync*): the whole list then syncs through a hidden app folder in your own Drive. Nothing goes anywhere else — no server of ours.

### Cross-browser sync

`sync.js` (in the background worker) pushes a change about 1.5 s after it happens and pulls another browser's change the moment Chrome delivers it; the dashboard header shows the sync status. Details:

- **What syncs:** protect/unprotect and removals (always, highest priority), settings, the scan schedule, and each friend's scan results — name, friend date/rank, and engagement *tallies*. Raw per-post engagement events and profile photos stay local; another browser shows the tallies and fills in photos on its own next scan.
- **Size:** Chrome gives an extension 100 KB of sync space. Records are hashed into 12 fixed, compressed items. If a very large friend list doesn't fit, scan details for removed and least-recently-seen friends are left out of the synced copy (never out of local data), and the header says how many. Connecting Google Drive removes the limit (below).
- **Conflicts:** merges are per field, never whole-list: the newest protect/unprotect wins, a removal anywhere is a removal everywhere, settings merge field by field, tallies only grow.
- **Scheduled scans** run on only one browser per interval: the last-run time syncs, and the others skip that round.
- **Delete all data** clears every synced browser. It's recorded as a wipe time, so a browser that was offline drops its old copy instead of pushing it back.

### Google Drive sync

`drive.js` is a port of the CRM extension's Drive code (`ee-chrome-crm/packages/extension/src/drive.ts`). Once a browser connects Drive:

- **Everything syncs, at any size.** `sync.js` writes one compressed file, `friend-sweep-sync.json`, to Drive's hidden `appDataFolder` (only this extension can see it; it's not in your Drive file list). Every friend's scan results and every protect/removed mark go in — no buckets, nothing left out. The merge rules are the same as above.
- **Nothing to refresh by hand.** Local changes upload about 10 s after they happen (at most once a minute while a scan is running). A one-minute alarm asks Drive for the file's version — a metadata call, no download — and pulls only when another browser wrote. Opening the dashboard also syncs straight away.
- **Sign-in renews itself.** On Chrome, `chrome.identity.getAuthToken` lets Chrome hold the Google grant and renew it with no popups, ever. On Edge (or a Chrome profile not signed into Chrome) it falls back to `launchWebAuthFlow`, renewed silently every hour from the same alarm while you're signed into Google in that browser.
- **Browser sync keeps running** for the small part — protect/removed marks, settings, schedule, doc_ids, the wipe time — so a browser that hasn't connected Drive still gets those. Scan results go to Drive only.
- **Connect Drive on each browser**, with the same Google account. Disconnecting leaves the Drive file in place for your other browsers. *Delete all data* clears the Drive file too.

#### One-time setup (developer)

The build ships with placeholder OAuth client ids, and the dashboard says Drive sync isn't set up until they're replaced. In [Google Cloud Console](https://console.cloud.google.com/) (one project for both clients — `appDataFolder` is per project, so that's what puts Chrome and Edge on the same file):

1. Enable the **Google Drive API**. On the OAuth consent screen, add the scopes `drive.appdata`, `openid` and `email`.
2. Create an OAuth client of type **Chrome Extension** with this extension's ID (the Web Store item ID). Put its client id in `manifest.json` → `oauth2.client_id`.
3. Create an OAuth client of type **Web application** with the authorized redirect URI `https://<extension-id>.chromiumapp.org/` (trailing slash included). Put its client id in `drive.js` → `WEB_APP_CLIENT_ID`. This is the Edge fallback; without it Drive sync works on Chrome only.
4. For unpacked development builds to have the same extension ID, add the Web Store item's public key to `manifest.json` as `"key"` (Developer Dashboard → Package → *Public key*).

New permission: `identity` (no install warning). Drive's API answers with CORS, so no Google host permission is needed.

## Development

There is no bundler and no dependencies — the source files are what the browser runs. Node 18+ is needed only for the build and package scripts.

### Build

```bash
npm run build
```

This bumps the version, then copies the extension's runtime files into `build/` (gitignored). The version lives in `manifest.json`; `scripts/bump-version.mjs` increments the patch number (`x.y.Z`) on every build and mirrors it into `package.json`, so every place that records a version moves together. For a bigger release, set `BUMP` for that one build:

```bash
BUMP=minor npm run build   # x.y.z -> x.(y+1).(z+1)
BUMP=major npm run build   # x.y.z -> (x+1).0.0
```

On Windows PowerShell: `$env:BUMP="minor"; npm run build; Remove-Item Env:BUMP`.

The files that ship are listed in `SHIP` in `scripts/build.mjs`. Add any new top-level file or folder there — the build fails if the manifest references something that isn't in `build/`.

### Load the extension

1. Open `chrome://extensions` (or `edge://extensions`)
2. Turn on **Developer mode**
3. Click **Load unpacked** and select the `build/` folder

During development you can also load the repo folder itself — it works the same, it just carries the docs and scripts along. Reload the extension after every build.

### Icons

The icons are drawn as SVG in `design/` and rendered to `icons/icon{16,32,48,128}.png`:

```bash
npm install      # once — installs the SVG renderer (dev only, never shipped)
npm run icons
```

`icon.svg` is the 128 px store icon (96 px artwork, 16 px transparent padding, as the Web Store asks); `icon-small.svg` (32/48 px) and `icon-16.svg` fill their square with bolder strokes so they stay legible in the toolbar. Commit the SVGs and the PNGs together.

### Package for the Chrome Web Store

```bash
npm run package
```

Rebuilds `build/` at the **current** version (no bump) and writes the upload zip to `dist/friend-sweep-<version>.zip`. Run `npm run build` first when you want a new version number — packaging never bumps, so the filename always matches the manifest inside it, and packaging twice doesn't burn a version. The script refuses to write a package whose manifest isn't at the archive root, that references a missing file, or that carries a `key` field. The same zip uploads to Edge Add-ons.

## Use

1. Log in to Facebook in the same browser profile.
2. Click the FriendSweep icon → **Open dashboard**.
3. **1 · Scan friends** — a Facebook tab opens and loads your friends list. Leave the tab alone until the overlay says it's done (a few minutes for large lists).
4. **2 · Scan friend dates** — the tab opens your Activity Log (Friends category) and reads back through your "became friends with …" history, recording the real date for each friend.
5. **3 · Scan engagement** — pick a window in the "scan back" dropdown (1 week … 1 year, default 1 month), then the tab opens your own timeline and works backward through every post in that window. This is the slow step. The scan reads each post's timestamp and stops once it hits three consecutive posts older than the window (three, so a pinned old post doesn't end it early); posts with unparseable timestamps are included but never stop the run, and there's a 400-post cap as a safety valve.
5. Review the table. Sort by "Least engaged first", filter to "No engagement only", tick the people you want gone, and click **Remove selected**. Large lists are paginated — use the **per page** selector (25–200) and the pager at the bottom. **Select all on page** ticks everyone on the current page — a half-ticked page fills up, a fully ticked one clears. When a page is fully ticked and more rows match, a **Select all N matching** link appears to tick the whole filtered set at once; once anything is selected off-screen the same link becomes **Clear selection (N)** so you can always see and drop what's held. Selections persist as you move between pages. Protected friends can be ticked (bulk protect/unprotect need it) but are always held back from removal.
6. Removals run in the background tab with ~30–60s randomized gaps. You can watch progress in the dashboard and cancel any time. When a job ends, its banner turns green, then clears itself — **Cancel job** is only live while something is actually running.

Re-run the engagement scan every week or two — events are deduplicated per post/person, so history accumulates and scores get more meaningful over time. The **Scheduled scans** panel can do this for you: tick *Re-scan on a schedule*, choose the interval and engagement window, and pick which scans to run. Scheduled runs only fire while the browser is running, are skipped if another job is in progress, and take focus while they run — **Run now** starts the same sequence on demand.

### Sorting when deciding who to remove

- **Last engaged (oldest first / newest first)** — "last engaged" is the date of the most recent post the friend interacted with (taken from the post's own timestamp, not the scan time). Scanning a full year back gives you a real 12-month engagement picture in one pass.
- **Newest/Oldest friends first** — uses the real friendship dates from the Activity Log scan (shown as a date in the Friended column). Friends the Activity Log scan didn't cover fall back to their "Recently added" rank (`#N`, `#1` = most recent), and sort after the dated ones. Notes on the Activity Log parse:
  - Entries whose name isn't a clickable profile link are matched to your scanned friend list by exact name; if two friends share the exact same name the entry is skipped rather than guessed.
  - The scan streams results as it goes, so you can cancel partway and keep everything captured so far — useful because a large, old friends list means a long activity log.
- Update the friend scan first (**1**), then run the dates scan (**2**), so name matching has the full friend list to work against.

## Important caveats

- **Facebook's terms restrict third-party tools that act on your account**, and Facebook may limit or block accounts that take many actions quickly. Built-in safeguards: randomized pacing between removals, a per-run removal cap (default 20), and everything runs in your own logged-in session at your request. Keep removal runs small and spread them over days. If Facebook shows an "action blocked" warning, stop for a few days.
- **English UI only.** Button detection looks for "Friends", "Unfriend", "Confirm", "View more comments", etc. Set Facebook's language to English while using it.
- **Facebook's page structure changes constantly.** Friend scanning, engagement scanning, and removal go through Facebook's own GraphQL requests (see below), which are far more stable than the page layout — but if that path can't run, the page-reading fallbacks in `content/scanner.js` take over, keyed off `role=` and `aria-label` attributes, each reporting a specific error ("Friends button not found", etc.) to point you at the broken lookup.
- **GraphQL `doc_id`s can drift.** Facebook refers to each request by a `doc_id` that changes when it redeploys. The ids in `content/graph.js` are seeds; any id the extension sees Facebook's own pages use is preferred, saved (`docIds` in local storage) and synced to your other browsers, so learned ids survive reloads. When Facebook rejects an id, it's dropped, the next candidate is tried once, then the page fallback runs and the job banner names the request that changed. **Settings & safety** shows which requests run on built-in vs learned ids (hover for the exact ids). The *unfriend* id is only learned when you unfriend someone yourself on Facebook, so if it changes, removals use the slower per-profile flow until the seed in `content/graph.js` is updated.
- **Numeric ids for removal.** The unfriend request needs a friend's numeric id. The friend scan captures it; for friends that only have a vanity URL (or were scanned before that existed), removal looks the id up from the profile page (`FriendSweepGraph.resolveProfileId`) and caches it. Everything is logged under `[FriendSweep/*]` in the working tab's console.
- **Engagement ≠ friendship.** Someone who never likes your posts may still be a close friend who reads quietly. The score only measures visible engagement with the posts scanned — review the suggestions before acting on them.
- **Unfriending is not reversible** by the extension. Export a CSV first if you want a record of who you removed.

## Layout

```
manifest.json          MV3 manifest (source of truth for the version)
package.json           npm scripts: build, package
background.js          Job orchestration (scans, removal queue, pacing via chrome.alarms)
sync.js                Cross-browser sync: merges chrome.storage.local with chrome.storage.sync
                       and, when connected, a file in Google Drive
drive.js               Google sign-in and Drive requests for sync.js (ported from the CRM)
content/fb-interceptor.js  Page context (MAIN world): picks up the request parameters
                           Facebook's own GraphQL calls carry and sends requests with them
content/graph.js       GraphQL client (isolated world): builds friend-list, unfriend, and
                       engagement (posts/reactions/comments) requests from those
                       parameters; keeps doc_ids current
content/scanner.js     Runs on facebook.com: GraphQL path + page-reading/unfriend fallback
content/scanner.css    On-page progress overlay
dashboard/             Main UI: table, filters, scores, removal, CSV export, settings
popup/                 Toolbar popup with quick stats
icons/                 Rendered icons (from design/ via `npm run icons`)
design/                Icon SVG sources
scripts/               build (version bump + build/), package (store zip), icons, zip writer
docs/                  Publishing notes (website, privacy policy, terms)
```

## How the GraphQL path works

Scanning and removal use the same internal GraphQL endpoint the Facebook page uses, rather than reading the page layout. The extension never assembles Facebook's auth tokens itself:

1. `content/fb-interceptor.js` runs in the page's **MAIN world** and wraps
   `fetch`/`XMLHttpRequest`. When Facebook makes any `POST /api/graphql`, it keeps
   the request body — the **"boilerplate"** — which already carries every parameter a
   GraphQL call needs (`fb_dtsg`, `lsd`, `jazoest`, `__user`, the `__spin_*`/`__rev`
   values, …). It passes that boilerplate to the isolated world.
2. `content/graph.js` (isolated world) copies the boilerplate and swaps only
   `doc_id` + `variables` for the operation it wants — list friends, unfriend,
   fetch timeline posts and each post's reactions/comments — then hands the body
   back to the MAIN world to POST in page context (correct origin/referer, the
   user's own cookies). Friend listing, reactions, and comments follow `end_cursor`
   pagination; unfriend is a single request. Multi-part (`@defer`) responses, which
   the timeline query streams, are reassembled before parsing. Retries, backoff, and
   rate-limit cooldown wrap every call.

The MAIN-world bridge only ever accepts a "send" command that passes a body to
`/api/graphql` — it can't be asked to touch page data or the DOM. If no boilerplate
is ever captured (transport change, blocked injection), every caller falls back to
the page-reading path with nothing lost.
