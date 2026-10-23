# Publishing notes: store listing, website, privacy policy, terms

> **v1.2 update — accounts and plans.** The extension is now Not Another Friend Sweeper and
> requires a notanotherfriendsweeper.com account. That changes several points below; the
> website's privacy policy and terms (notanotherfriendsweeper.com/privacy, /terms) already
> reflect it. For the store listing:
>
> - **What the developer now receives:** the account email, plan/subscription status, and a
>   monthly *count* of removals (never who). Friend and engagement data still never leaves the
>   browser. The "developer receives nothing" bullet below no longer applies.
> - **Network requests:** the background worker calls notanotherfriendsweeper.com
>   (`/api/public/entitlement`, `/api/public/removals`) and the auth service to refresh the
>   sign-in token. Both answer with CORS, so no new `host_permissions` were added.
> - **New manifest key:** `externally_connectable` (the site's `/extension-auth` page hands the
>   sign-in session to the extension). No new permissions.
> - **Data usage disclosure:** additionally tick *Authentication information* (sign-in tokens)
>   and *Personally identifiable information* (account email).
> - **Single purpose** is unchanged; sign-in only gates it.
> - **Free vs Pro:** Free = 40 removals per calendar month (UTC) and a 1-month engagement
>   look-back. Pro = unlimited removals, 1-year look-back, scheduled scans, CSV export.

These are the points to carry into the FriendSweep website (privacy policy, terms of use, landing page) and the Chrome Web Store / Edge Add-ons listing. They are written against what the extension actually does as of v1.1 — re-check them whenever a feature changes what data is read, stored or sent.

> **Have a lawyer review the privacy policy and terms before launch.** These notes are a checklist of what the documents must cover, not legal text. Disclaimers reduce liability; they don't eliminate it, and consumer-protection law in many places limits how far they can go.

## The one rule: every statement must be true of the product

Store reviewers compare the listing, the privacy policy and the code. A claim the code contradicts is grounds for rejection or removal under the Web Store's misrepresentation policy, and it also weakens the disclaimers themselves — a court reads a false statement in your own terms against you. So each bullet below is phrased to match current behaviour. If a feature changes, change the wording with it.

## User control (the core disclaimer)

The strongest *accurate* statement of how FriendSweep acts:

- **FriendSweep only acts when you tell it to.** Every scan and every removal is started by you — by clicking it, or, for scans only, by a schedule you switch on yourself.
- **Removals are never scheduled.** A removal only runs after you select the people, review the confirmation listing them, and confirm.
- **Everything is cancellable.** Any running scan or removal can be cancelled at any moment from the dashboard; a schedule can be switched off at any time; closing the Facebook tab stops the job.
- **Built-in limits you control:** a per-run removal cap (default 20) and a randomized delay between removals (default 30–60 s; the extension never goes under 30 s).
- **You review before you act.** Suggestions are informational. FriendSweep never removes anyone you didn't select, and protected friends are skipped even if selected.

Note on wording: an absolute claim like "nothing in FriendSweep ever runs without the user" is **not** accurate while the Scheduled scans feature exists — once switched on, those scans run unattended at the chosen interval. Either keep the wording above (which is true), or remove the Scheduled scans feature if you want the absolute claim.

## User responsibility and limited liability (terms of use)

- **Not affiliated with Meta.** "FriendSweep is an independent tool and is not affiliated with, endorsed by, or sponsored by Meta Platforms, Inc. Facebook is a trademark of Meta Platforms, Inc."
- **The user is responsible for how they use it.** The user decides who to remove and when, and is solely responsible for complying with Facebook's terms and community standards.
- **Facebook's terms restrict third-party tools that act on accounts.** Facebook may warn, limit, temporarily block or disable accounts, at its sole discretion. The user accepts that risk; we are not responsible for any action Facebook takes on their account.
- **Unfriending is permanent.** FriendSweep cannot undo a removal. Suggest exporting a CSV before removing anyone.
- **Scores are not judgments.** Engagement scores only count visible reactions and comments on the posts scanned; they say nothing about the strength of a friendship. Decisions made from them are the user's.
- **Provided "as is" and "as available"**, without warranties of any kind (merchantability, fitness for a purpose, accuracy, uninterrupted operation).
- **May stop working without notice.** It depends on how Facebook's site works today; Facebook changes can break features at any time, and there is no guarantee of fixes or continued availability.
- **Limitation of liability.** No liability for indirect, incidental or consequential damages — including account restrictions, lost connections, lost data or lost access — and total liability capped (for a free product, at the amount paid: $0; or a nominal fixed amount — lawyer's call).
- **Indemnification.** The user agrees to indemnify you against claims arising from their use of the extension or their breach of Facebook's terms.
- **Eligibility.** Users must be old enough to hold a Facebook account (13+, or older where local law requires).
- **Standard clauses:** governing law and venue, changes to the terms (with an effective date), termination, severability, contact address.

## Privacy policy

**What FriendSweep reads and stores (in the user's browser):**

- The user's friends: names, profile links, numeric profile ids, profile photo links, friendship dates and "recently added" order.
- Engagement on the user's **own** posts: which friends reacted or commented, the post ids and post dates. Not message content, not other people's posts.
- The user's own profile link (to tell their own activity apart from friends').
- Their settings, scan schedule, protected/removed status per friend.

**Third-party personal data:** most of this data is about the user's friends, not the user. Say plainly that it is processed only to show the user their own friends list and is never shared, sold or used for anything else.

**Where it goes:**

- Stored locally in the browser (`chrome.storage.local`).
- Synced between the user's own browsers through the browser's built-in sync (`chrome.storage.sync`): with Chrome, via the user's Google account; with Edge, via their Microsoft account, if extension sync is on. That sync is operated by Google/Microsoft under their privacy policies. Raw per-post engagement events and photos are not synced.
- **The developer receives nothing.** No servers, no analytics, no tracking, no ads, no selling or sharing of data, no use for advertising, credit or lending purposes.
- CSV export writes a file to the user's own computer only when they click Export.

**Facebook login and session:**

- FriendSweep never asks for, sees or stores the user's Facebook password.
- It works inside the user's existing logged-in Facebook tab, reusing the request parameters that tab already has, only to make requests to facebook.com. Those parameters stay in the tab's memory; they are never saved or sent anywhere else.

**Retention and deletion:**

- Data stays until the user deletes it. **Delete all data** (dashboard → Settings & safety) erases it from this browser and every synced browser.
- Uninstalling removes local data; recommend using Delete all data first so the synced copy is cleared too.

**Required Web Store language:** include a "Limited Use" statement — e.g. "FriendSweep's use of information is limited to providing its user-facing features, and complies with the Chrome Web Store User Data Policy, including the Limited Use requirements."

**Also include:** effective date, how changes are announced, a contact email, and that the product is not directed at children under 13.

**Update the policy before shipping any of these:** remote configuration fetched from your site (see "doc_id updates" below), crash reporting or analytics, accounts, payments.

## Chrome Web Store listing — form answers

- **Single purpose:** "Helps you review your Facebook friends list — see who engages with your posts — and remove friends you choose."
- **Permission justifications:**
  - `storage` — saves the user's friend list, scores and settings in their browser and syncs them between the user's own browsers.
  - `alarms` — spaces out removals the user confirmed, and runs scans on the schedule the user set.
  - Host access to `facebook.com` — reads the user's own friends list and the reactions/comments on the user's own posts, and performs removals the user selected and confirmed, inside the user's logged-in session.
- **Remote code:** No. All code ships in the package.
- **Data usage disclosure:** tick *Personally identifiable information* (names, profile ids) and *Website content* (reactions/comments on the user's posts). Certify: not sold, not used for unrelated purposes, not used for creditworthiness.
- **Assets:** 128×128 icon (`icons/icon128.png`, rendered from `design/icon.svg`), at least one 1280×800 screenshot, 440×280 promo tile.

## Website and listing — other things to get right

- **Facebook branding:** say "for Facebook" in descriptive text only. Don't use Facebook's logo, colours or "f" mark, and don't put "Facebook" in the product name.
- **No competitor names** in the listing or site copy.
- **Plain-language warning on the landing page and before install** that Facebook may restrict accounts, with the recommended limits (small batches, spread over days, stop if Facebook shows a warning).
- **Keep the site and listing consistent** with the privacy policy and with each other — reviewers read all three.
- **Privacy policy and terms must be public URLs** (no login), linked from the store listing and the site footer.
- **Support contact:** a monitored email or form; the store requires one.
- **Version/changelog page** helps users and reviewers understand updates.
- **Unlisted vs public:** an unlisted store item gets the same review but is only reachable by link — lower exposure while you gauge reception.
- **Plan for takedowns:** a listing can be removed after a complaint. Keep a direct-download fallback page only if you're comfortable supporting manual installs, and keep your users' data local so a takedown never strands it.

## doc_id updates (if you add them)

If you later publish current GraphQL `doc_id`s from your website so the extension can pick them up without a store release, that is a network request to your server: disclose it in the privacy policy (what is fetched, that nothing about the user is sent), add the domain to the manifest's `host_permissions` (or serve it with CORS), and keep it data-only — the Web Store forbids downloading code.
