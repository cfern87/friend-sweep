#!/usr/bin/env node
// Upload a packaged zip to the Chrome Web Store and submit it for review, using
// the Chrome Web Store API v2 (https://developer.chrome.com/docs/webstore/using-api).
//
// Normally run for you at the end of `npm run deploy`. Standalone:
//
//   node scripts/publish-extension.mjs <zip>        upload + submit
//   node scripts/publish-extension.mjs <zip> --staged   submit, but hold for a manual
//                                                       "Publish" click after review
//   node scripts/publish-extension.mjs --status     read-only: check credentials and
//                                                   show what the store has now
//
// CREDENTIALS. Read from environment variables first, then from
// <repo>/.cws-credentials.json (gitignored), keyed by the same names:
//
//   CWS_CLIENT_ID        OAuth client (type "Web application") in a Cloud project
//   CWS_CLIENT_SECRET    with the Chrome Web Store API enabled
//   CWS_REFRESH_TOKEN    minted once in the OAuth Playground with scope
//                        https://www.googleapis.com/auth/chromewebstore, signed in
//                        as the account that owns the item
//   CWS_PUBLISHER_ID     Developer Dashboard → Publisher → Settings
//
// docs/chrome-web-store-publishing.md walks through getting each one.
//
// WHY a refresh token and not a service account: v2 accepts both, but a service
// account has to be added to the publisher in the dashboard first, and the
// refresh token route needs nothing beyond a Cloud project the item's owner
// already controls. Either way the secret never enters the repo.

import { readFileSync, existsSync } from 'fs';
import { join, dirname, resolve, basename } from 'path';
import { fileURLToPath } from 'url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// The Web Store item every release goes to (the 32-letter ID on the item's
// Package tab in the Developer Dashboard). package-extension.mjs imports it.
// Not a secret: it is in the item's public store URL.
export const PROD_EXTENSION_ID = 'kioflnflmmajcaeikcadphppaimoogpk';

/** Stop early, with the fix, while PROD_EXTENSION_ID is still unset. */
export function assertItemId() {
  if (!/^[a-p]{32}$/.test(PROD_EXTENSION_ID)) {
    throw new PublishError(
      "PROD_EXTENSION_ID in scripts/publish-extension.mjs is not set to the store item's\n" +
      '    32-letter ID (Developer Dashboard → the item → Package).',
    );
  }
}

const API = 'https://chromewebstore.googleapis.com';
const CREDENTIALS_FILE = join(root, '.cws-credentials.json');
const KEYS = ['CWS_CLIENT_ID', 'CWS_CLIENT_SECRET', 'CWS_REFRESH_TOKEN', 'CWS_PUBLISHER_ID'];

// Upload is async on the store side; a zip this size normally settles in
// seconds, so two minutes is a generous ceiling, not an expected wait.
const POLL_INTERVAL_MS = 3000;
const POLL_TIMEOUT_MS = 120_000;

export class PublishError extends Error {}

/** Credentials from env, then the gitignored file. Returns null if any are missing. */
export function loadCredentials() {
  let file = {};
  if (existsSync(CREDENTIALS_FILE)) {
    try {
      file = JSON.parse(readFileSync(CREDENTIALS_FILE, 'utf8'));
    } catch (e) {
      throw new PublishError(`${basename(CREDENTIALS_FILE)} is not valid JSON: ${e.message}`);
    }
  }
  const creds = {};
  for (const key of KEYS) creds[key] = (process.env[key] || file[key] || '').trim();
  const missing = KEYS.filter((k) => !creds[k]);
  return missing.length ? { missing } : { creds };
}

async function accessToken(creds) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: creds.CWS_CLIENT_ID,
      client_secret: creds.CWS_CLIENT_SECRET,
      refresh_token: creds.CWS_REFRESH_TOKEN,
      grant_type: 'refresh_token',
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) {
    // invalid_grant = the refresh token was revoked or expired. Refresh tokens
    // from a consent screen left in "Testing" mode expire after 7 days, which is
    // the usual cause — publishing the consent screen to "In production" fixes it.
    const hint = body.error === 'invalid_grant'
      ? '\n    The refresh token was rejected. If the OAuth consent screen is still in "Testing",\n' +
        '    tokens expire after 7 days — set it to "In production" and mint a new one.'
      : '';
    throw new PublishError(`Token refresh failed: ${body.error || res.status} ${body.error_description || ''}${hint}`);
  }
  return body.access_token;
}

/** Call the API; throw a readable PublishError on any non-2xx. */
async function call(token, method, url, { body, contentType } = {}) {
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(contentType ? { 'Content-Type': contentType } : {}),
    },
    body,
  });
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
  if (!res.ok) {
    const err = json.error || {};
    const details = (err.details || [])
      .map((d) => d.description || d.reason || d.detail || JSON.stringify(d))
      .filter(Boolean);
    throw new PublishError(
      `${method} ${url.replace(API, '')} -> ${res.status} ${err.status || ''}\n    ` +
      [err.message || json.raw || text, ...details].join('\n    '),
    );
  }
  return json;
}

function itemPath(creds, itemId) {
  return `publishers/${encodeURIComponent(creds.CWS_PUBLISHER_ID)}/items/${encodeURIComponent(itemId)}`;
}

export async function fetchStatus({ creds, itemId, token }) {
  token ||= await accessToken(creds);
  return call(token, 'GET', `${API}/v2/${itemPath(creds, itemId)}:fetchStatus`);
}

function describeRevision(label, rev) {
  if (!rev) return `  ${label.padEnd(10)} (none)`;
  const channels = (rev.distributionChannels || [])
    .map((c) => `v${c.crxVersion}${c.deployPercentage != null ? ` @ ${c.deployPercentage}%` : ''}`)
    .join(', ');
  return `  ${label.padEnd(10)} ${rev.state}${channels ? `  ${channels}` : ''}`;
}

export function printStatus(status) {
  console.log(describeRevision('Published', status.publishedItemRevisionStatus));
  console.log(describeRevision('Submitted', status.submittedItemRevisionStatus));
  if (status.takenDown) console.log('  ! Item is TAKEN DOWN');
  if (status.warned) console.log('  ! Item has a policy warning');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Upload `zipPath` to `itemId` and submit it.
 * Returns { version, state, warnings }. Throws PublishError on any failure.
 */
export async function publish({ creds, itemId, zipPath, expectedVersion, staged = false, log = console.log }) {
  const token = await accessToken(creds);
  const name = itemPath(creds, itemId);

  // The store holds one submission at a time. Catch a pending review before
  // uploading: the API would refuse anyway, but less clearly, and only after
  // the upload.
  const before = await fetchStatus({ creds, itemId, token });
  if (before.submittedItemRevisionStatus?.state === 'PENDING_REVIEW') {
    const pending = before.submittedItemRevisionStatus.distributionChannels?.[0]?.crxVersion;
    throw new PublishError(
      `v${pending || '?'} is still in review. The store allows one submission at a time —\n` +
      '    wait for it, or cancel it in the Developer Dashboard, then re-run.',
    );
  }

  log(`  Uploading ${basename(zipPath)} ...`);
  let upload = await call(token, 'POST', `${API}/upload/v2/${name}:upload`, {
    body: readFileSync(zipPath),
    contentType: 'application/zip',
  });

  // The docs disagree on whether the in-progress value is IN_PROGRESS or
  // UPLOAD_IN_PROGRESS, so match either.
  const inProgress = (s) => /IN_PROGRESS$/.test(s || '');
  const started = Date.now();
  let state = upload.uploadState;
  while (inProgress(state)) {
    if (Date.now() - started > POLL_TIMEOUT_MS) {
      throw new PublishError('Upload still processing after 2 minutes. Check the Developer Dashboard, then re-run with --status.');
    }
    await sleep(POLL_INTERVAL_MS);
    const status = await fetchStatus({ creds, itemId, token });
    state = status.lastAsyncUploadState;
  }
  if (state !== 'SUCCEEDED') {
    throw new PublishError(`Upload ended in state ${state || '(none)'}. The Developer Dashboard's Package tab shows why.`);
  }
  if (upload.crxVersion && expectedVersion && upload.crxVersion !== expectedVersion) {
    throw new PublishError(`Store read version ${upload.crxVersion} from the upload, expected ${expectedVersion}. Not submitting.`);
  }
  log(`  Uploaded${upload.crxVersion ? ` v${upload.crxVersion}` : ''}.`);

  log(`  Submitting for review${staged ? ' (staged: you click Publish after approval)' : ''} ...`);
  const result = await call(token, 'POST', `${API}/v2/${name}:publish`, {
    body: JSON.stringify({ publishType: staged ? 'STAGED_PUBLISH' : 'DEFAULT_PUBLISH' }),
    contentType: 'application/json',
  });
  return {
    version: upload.crxVersion || expectedVersion,
    state: result.state,
    warnings: result.warningInfo?.warnings || [],
  };
}

export function printSetupHelp(missing) {
  console.log(`  Not published: missing ${missing.join(', ')}.`);
  console.log('  Set them as environment variables or in .cws-credentials.json at the repo root');
  console.log('  (gitignored). Setup steps: docs/chrome-web-store-publishing.md');
}

// ── CLI ──────────────────────────────────────────────────────────────────────
const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2);
  const flags = new Set(args.filter((a) => a.startsWith('--')));
  const zip = args.find((a) => !a.startsWith('--'));
  try {
    const loaded = loadCredentials();
    if (loaded.missing) { printSetupHelp(loaded.missing); process.exit(1); }
    assertItemId();
    if (flags.has('--status')) {
      printStatus(await fetchStatus({ creds: loaded.creds, itemId: PROD_EXTENSION_ID }));
    } else {
      if (!zip || !existsSync(zip)) throw new PublishError('Usage: publish-extension.mjs <zip> [--staged] | --status');
      const r = await publish({ creds: loaded.creds, itemId: PROD_EXTENSION_ID, zipPath: zip, staged: flags.has('--staged') });
      console.log(`  Submitted v${r.version}: ${r.state}`);
      for (const w of r.warnings) console.log(`  ! ${w.reason}: ${w.description}`);
    }
  } catch (e) {
    console.error(`\n  x ${e instanceof PublishError ? e.message : e.stack}\n`);
    process.exit(1);
  }
}
