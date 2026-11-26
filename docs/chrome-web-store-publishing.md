# Publishing to the Chrome Web Store

`npm run deploy` builds the extension, writes `dist/<name>-<version>.zip`, uploads
it to the Web Store item set in `PROD_EXTENSION_ID` (top of
`scripts/publish-extension.mjs`) and submits it for review, through the [Chrome Web Store API v2](https://developer.chrome.com/docs/webstore/using-api).

| Command | Does |
| --- | --- |
| `npm run deploy` | build, zip, upload, submit (goes live once approved) |
| `npm run deploy -- --staged` | same, but after approval it waits for you to click **Publish** in the dashboard |
| `npm run deploy -- --no-publish` | build and zip only (the old `npm run package`) |
| `node scripts/publish-extension.mjs --status` | read-only: checks credentials and shows the published / in-review versions |
| `node scripts/publish-extension.mjs <zip>` | upload and submit a zip you already have |

Without credentials, `deploy` still writes the zip, then stops with exit code 1
and lists what is missing.

## One-time setup

You need four values. Put them in `.cws-credentials.json` at the repo root
(gitignored), or set them as environment variables with the same names:

```json
{
  "CWS_CLIENT_ID": "....apps.googleusercontent.com",
  "CWS_CLIENT_SECRET": "...",
  "CWS_REFRESH_TOKEN": "...",
  "CWS_PUBLISHER_ID": "..."
}
```

1. **Enable the API.** In the Google Cloud Console project you already use for
   the Drive client (or any project), enable **Chrome Web Store API**.
2. **Consent screen.** Set it to External and add your own Google account as a
   test user. Then set its publishing status to **In production**. A consent
   screen left in Testing gives refresh tokens that expire after 7 days, and
   deploys then fail with `invalid_grant`.
3. **OAuth client.** Credentials → Create credentials → OAuth client ID, type
   **Web application**, with `https://developers.google.com/oauthplayground`
   as an authorized redirect URI. Its ID and secret are `CWS_CLIENT_ID` and
   `CWS_CLIENT_SECRET`. Use a new client for this. The Drive client in
   `manifest.json` is separate and must not be changed.
4. **Refresh token.** Open the [OAuth Playground](https://developers.google.com/oauthplayground).
   Under the gear icon, tick "Use your own OAuth credentials" and enter the
   client ID and secret. Authorize the scope
   `https://www.googleapis.com/auth/chromewebstore`, signed in as the account
   that owns the Web Store item (it needs 2-Step Verification), then click
   "Exchange authorization code for tokens". The refresh token is
   `CWS_REFRESH_TOKEN`.

   Google will show **"Google hasn't verified this app"**, because
   `chromewebstore` is a sensitive scope and the app is unverified. That is
   expected here: it is your own client and your own account, and you are the
   only person who will ever sign in to it. Click **Advanced → Go to … (unsafe)**
   and continue. You don't need to submit it for verification.
5. **Publisher ID.** Developer Dashboard → Publisher → Settings.
6. **Item ID.** Set `PROD_EXTENSION_ID` at the top of
   `scripts/publish-extension.mjs` to the item's 32-letter ID (Developer
   Dashboard → the item → Package). It isn't secret, so it lives in the repo.
7. Check it all with `node scripts/publish-extension.mjs --status`.

## Things the API won't do

- **One submission at a time.** If a version is still in review, `deploy` stops
  before uploading. Wait for the review, or cancel it in the dashboard.
- **Visibility changes.** If you changed visibility (public, unlisted, private)
  in the dashboard, the API refuses to publish until you have published once by
  hand with the new setting.
- **Listing text and screenshots** are edited in the dashboard only. The API
  uploads the package.
