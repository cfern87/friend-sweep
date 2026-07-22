# FriendSweep

A free, local Chrome extension that does what FriendFilter charges for:

1. **Scan friends** — auto-scrolls your Facebook friends page and captures every friend (name, profile link, photo). A second pass walks the **"Recently added"** tab to record each friend's friendship-recency rank (#1 = newest friend).
1b. **Scan friend dates** — walks your **Activity Log → Friends** category (`…/allactivity/?category_key=FRIENDS`), which lists every "became friends with …" event under a date header, and records the **real date you friended each person**.
2. **Scan engagement** — walks your timeline posts back through a chosen time window (presets from 1 week to 1 year), opens each post's reaction list and comments, and records which friends reacted or commented. Events are stamped with the post's real date, so "Last engaged" reflects when the interaction actually happened.
3. **Score & suggest** — every friend gets a score (`reactions + 2 × comments`). Friends with zero recorded engagement are flagged **suggested** for removal.
4. **Remove** — select friends in the dashboard and the extension unfriends them one at a time with randomized delays and a per-run cap.

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
5. Review the table. Sort by "Least engaged first", filter to "No engagement only", tick the people you want gone, and click **Remove selected**.
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
- **Facebook's DOM changes constantly.** If a scan or removal stops working, the selectors in `content/scanner.js` are the place to fix — everything is keyed off `role=` and `aria-label` attributes with fallbacks, and each step reports a specific error ("Friends button not found", etc.) to point you at the broken lookup.
- **Engagement ≠ friendship.** Someone who never likes your posts may still be a close friend who lurks. The score only measures visible engagement with the posts scanned — review the suggestions, don't blind-fire.
- **Unfriending is not reversible** by the extension. Export a CSV first if you want a record of who you removed.

## Layout

```
manifest.json          MV3 manifest
background.js          Job orchestration (scans, removal queue, pacing via chrome.alarms)
content/scanner.js     Runs on facebook.com: scraping + unfriend automation
content/scanner.css    On-page progress HUD
dashboard/             Main UI: table, filters, scores, removal, CSV export, settings
popup/                 Toolbar popup with quick stats
icons/                 Generated placeholder icons
```
