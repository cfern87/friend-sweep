# FriendSweep

A free, local Chrome extension that does what FriendFilter charges for:

1. **Scan friends** — lists every friend (name, profile link, photo, numeric id) through Facebook's own GraphQL API — the same requests the page makes — so a full list comes back in seconds without scrolling. If the API path is unavailable it automatically falls back to auto-scrolling the friends page. A second pass walks the **"Recently added"** tab to record each friend's friendship-recency rank (#1 = newest friend).
1b. **Scan friend dates** — walks your **Activity Log → Friends** category (`…/allactivity/?category_key=FRIENDS`), which lists every "became friends with …" event under a date header, and records the **real date you friended each person**.
2. **Scan engagement** — walks your timeline posts back through a chosen time window (presets from 1 week to 1 year) and records which friends reacted or commented on each. It reads each post's reactors and commenters straight from Facebook's GraphQL API (paginated, no opening dialogs or expanding threads), falling back to scraping the reaction list and comments in the DOM if the API path is unavailable. Events are stamped with the post's real date, so "Last engaged" reflects when the interaction actually happened.
3. **Score & suggest** — every friend gets a score (`reactions + 2 × comments`). Friends with zero recorded engagement are flagged **suggested** for removal.
4. **Protect (whitelist)** — click the ☆ in the **Protect** column to mark a friend as protected. Protected friends are never flagged **suggested**, and removal skips them: they're held back both by the dashboard and by the background worker even if they were selected. They can still be ticked, so bulk actions reach them — tick them (or use **Select all on page**) and click **Protect selected** or **Unprotect selected**. The button labels show how many of your selection each action would actually affect, and the remove confirmation tells you how many protected people it's skipping. Use the "Hide protected" filter to keep them out of the way while triaging.
5. **Remove** — select friends in the dashboard and the extension removes the whole selection from a **single** Facebook tab: one GraphQL unfriend mutation per friend, with no per-profile page loads and no menu-clicking. Removals are still paced with randomized delays and a per-run cap (Facebook soft-blocks bursts, and there is no bulk-unfriend endpoint — each friend is its own request). If the API path can't run, it falls back to the legacy per-profile DOM flow.

All data lives in `chrome.storage.local` in your browser. Nothing is uploaded anywhere.

## Install

1. Open Chrome → `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. Click **Load unpacked** and select this `friend-sweep` folder

## Use

1. Log in to Facebook in the same browser profile.
2. Click the FriendSweep icon → **Open dashboard**.
3. **1 · Scan friends** — a Facebook tab opens and scrolls your friends list. Leave the tab alone until the overlay says it's done (a few minutes for large lists).
4. **2 · Scan friend dates** — the tab opens your Activity Log (Friends category) and scrolls back through your "became friends with …" history, recording the real date for each friend.
5. **3 · Scan engagement** — pick a window in the "scan back" dropdown (1 week … 1 year, default 1 month), then the tab opens your own timeline and works backward through every post in that window. This is the slow step: it opens each post's reactions dialog and expands comments. The scan reads each post's timestamp and stops once it hits three consecutive posts older than the window (three, so a pinned old post doesn't end it early); posts with unparseable timestamps are scanned but never stop the run, and there's a 400-post hard cap as a safety valve.
5. Review the table. Sort by "Least engaged first", filter to "No engagement only", tick the people you want gone, and click **Remove selected**. Large lists are paginated — use the **per page** selector (25–200) and the pager at the bottom. **Select all on page** ticks everyone on the current page — a half-ticked page fills up, a fully ticked one clears. When a page is fully ticked and more rows match, a **Select all N matching** link appears to tick the whole filtered set at once; once anything is selected off-screen the same link becomes **Clear selection (N)** so you can always see and drop what's held. Selections persist as you move between pages. Protected friends can be ticked (bulk protect/unprotect need it) but are always held back from removal.
6. Removals run in the background tab with ~30–60s randomized gaps. You can watch progress in the dashboard and cancel any time.

Re-run the engagement scan every week or two — events are deduplicated per post/person, so history accumulates and scores get more meaningful over time.

### Sorting when deciding who to remove

- **Last engaged (oldest first / newest first)** — "last engaged" is the date of the most recent post the friend interacted with (taken from the post's own timestamp, not the scan time). Scanning a full year back gives you a real 12-month engagement picture in one pass.
- **Newest/Oldest friends first** — uses the real friendship dates from the Activity Log scan (shown as a date in the Friended column). Friends the Activity Log scan didn't cover fall back to their "Recently added" rank (`#N`, `#1` = most recent), and sort after the dated ones. Notes on the Activity Log parse:
  - Entries whose name isn't a clickable profile link are matched to your scanned friend list by exact name; if two friends share the exact same name the entry is skipped rather than guessed.
  - The scan streams results as it scrolls, so you can cancel partway and keep everything captured so far — useful because a large, old friends list means a long activity log.
- Update the friend scan first (**1**), then run the dates scan (**2**), so name matching has the full friend list to work against.

## Important caveats

- **Facebook's terms of service prohibit automated collection and actions.** This is the same risk FriendFilter and every similar tool carries. Mitigations built in: human-like randomized pacing, a per-run removal cap (default 20), and everything runs in your own logged-in session. Keep removal runs small and spread them over days. If Facebook shows an "action blocked" warning, stop for a few days.
- **English UI only.** Button detection looks for "Friends", "Unfriend", "Confirm", "View more comments", etc. Set Facebook's language to English while using it.
- **Facebook's DOM changes constantly.** Friend scanning, engagement scanning, and removal now go through Facebook's GraphQL API (see below), which is far more stable than scraping — but if that path can't run, the DOM fallbacks in `content/scanner.js` kick in, keyed off `role=` and `aria-label` attributes with fallbacks, each reporting a specific error ("Friends button not found", etc.) to point you at the broken lookup.
- **GraphQL `doc_id`s can drift.** The persisted-query ids in `content/graph.js` are seeds; the client prefers any id it sees Facebook use live for the same query, so it self-heals in most cases. If the API path stops working, refresh the seed `doc_id`s (or just rely on the DOM fallback). Note the *unfriend* `doc_id` can't self-heal — that mutation only fires when you manually unfriend, so passive browsing never re-captures it.
- **Numeric ids for removal.** The unfriend mutation needs a friend's numeric id. The GraphQL friend scan captures it; for friends that only have a vanity URL (or were scanned before that existed), removal resolves the id on the fly by fetching the profile page (`FriendSweepGraph.resolveProfileId`) and caches it. Everything is logged under `[FriendSweep/*]` in the working tab's console.
- **Engagement ≠ friendship.** Someone who never likes your posts may still be a close friend who lurks. The score only measures visible engagement with the posts scanned — review the suggestions, don't blind-fire.
- **Unfriending is not reversible** by the extension. Export a CSV first if you want a record of who you removed.

## Layout

```
manifest.json          MV3 manifest
background.js          Job orchestration (scans, removal queue, pacing via chrome.alarms)
content/fb-interceptor.js  Page-context (MAIN world): captures Facebook's GraphQL auth
                           "boilerplate" and relays/sends API requests
content/graph.js       GraphQL client (isolated world): forges friend-list, unfriend, and
                       engagement (posts/reactions/comments) requests by cloning the
                       captured boilerplate; self-heals doc_ids
content/scanner.js     Runs on facebook.com: GraphQL fast path + DOM scraping/unfriend fallback
content/scanner.css    On-page progress HUD
dashboard/             Main UI: table, filters, scores, removal, CSV export, settings
popup/                 Toolbar popup with quick stats
icons/                 Generated placeholder icons
```

## How the fast path works

Scanning and removal use Facebook's own internal GraphQL endpoint instead of the
DOM. The trick (borrowed from how commercial tools like FriendFilter operate) is
that we never assemble Facebook's auth tokens ourselves:

1. `content/fb-interceptor.js` runs in the page's **MAIN world** and monkeypatches
   `fetch`/`XMLHttpRequest`. When Facebook makes any `POST /api/graphql`, it keeps
   the request body — the **"boilerplate"** — which already carries every token a
   GraphQL call needs (`fb_dtsg`, `lsd`, `jazoest`, `__user`, the `__spin_*`/`__rev`
   machinery, …). It relays that boilerplate to the isolated world.
2. `content/graph.js` (isolated world) clones the boilerplate and swaps only
   `doc_id` + `variables` to perform the operation it wants — list friends, unfriend,
   fetch timeline posts and each post's reactors/commenters — then hands the body
   back to the MAIN world to POST in page context (correct origin/referer, real
   cookies). Friend listing, reactions, and comments follow `end_cursor` pagination;
   unfriend is a one-shot mutation. Multi-part (`@defer`) responses, which the
   timeline query streams, are reassembled before parsing. Retries, backoff, and
   rate-limit cooldown wrap every call.

The MAIN-world bridge only ever accepts a "send" command that relays a body to
`/api/graphql` — it can't be asked to touch page data or the DOM — so it does no
more than the user's own FriendSweep scanner already does. If no boilerplate is
ever captured (transport change, blocked injection), every caller falls back to the
original DOM path with nothing lost.
