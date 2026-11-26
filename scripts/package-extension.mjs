#!/usr/bin/env node
// Release step: build the extension, produce the Chrome Web Store upload zip at
// <repo>/dist/<name>-<version>.zip, then upload it and submit it for review
// (scripts/publish-extension.mjs). `npm run deploy`.
//
//   --no-publish   build and zip only (what `npm run package` used to do)
//   --staged       after approval, hold the release until you click Publish
//
// Run it deliberately before a submission — NOT from a git hook. Every build
// bumps the version, so building here, on demand, means the filename always
// reflects the manifest that actually went into the archive.
//
// Things this script exists to get right, all easy to botch by hand and
// invisible until the Web Store rejects the upload:
//
//   1. manifest.json must sit at the ARCHIVE ROOT. Zipping the build folder
//      itself nests everything one level down and CWS reports the manifest as
//      missing or unreadable.
//   2. Entry paths must use forward slashes (see zip.mjs) or icons silently
//      go missing.
//   3. A `key` field must not ship — the Web Store assigns the item's identity
//      and rejects an upload whose key doesn't match it.
//   4. Every file the manifest points at must be in the archive.

import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, existsSync } from 'fs';
import { join, dirname, resolve, relative } from 'path';
import { fileURLToPath } from 'url';
import { build } from './build.mjs';
import { createZip } from './zip.mjs';
import {
  PROD_EXTENSION_ID, assertItemId, loadCredentials, publish, printSetupHelp, PublishError,
} from './publish-extension.mjs';

const args = new Set(process.argv.slice(2));
const shouldPublish = !args.has('--no-publish');

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'dist');

/** Every file under `dir`, as forward-slash paths relative to it, sorted. */
function walk(dir, prefix = '') {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry);
    const rel = prefix ? `${prefix}/${entry}` : entry;
    if (statSync(abs).isDirectory()) out.push(...walk(abs, rel));
    else out.push(rel);
  }
  return out.sort();
}

/** Collect every asset path the manifest points at, wherever it is nested. */
function referencedPaths(node, found = new Set()) {
  if (typeof node === 'string') {
    if (/\.(js|css|html|png|json)$/.test(node)) found.add(node);
  } else if (node && typeof node === 'object') {
    for (const value of Object.values(node)) referencedPaths(value, found);
  }
  return found;
}

function fail(message) {
  console.error(`\n  x ${message}\n`);
  process.exit(1);
}

// 1. Build — which bumps the version, like every build (SKIP_VERSION_BUMP=1 to
//    re-package the current version).
console.log('  Building extension ...\n');
const { version, outDir: buildDir } = build({ bump: !process.env.SKIP_VERSION_BUMP });

// 2. Read the built manifest and strip `key` for the packaged copy only.
const manifest = JSON.parse(readFileSync(join(buildDir, 'manifest.json'), 'utf8'));
if (!manifest.version) fail('Built manifest has no version field.');
const hadKey = 'key' in manifest;
delete manifest.key;
const packagedManifest = Buffer.from(JSON.stringify(manifest, null, 2) + '\n', 'utf8');

// 3. Gather entries, substituting the stripped manifest.
const names = walk(buildDir);
const files = names.map((name) => ({
  name,
  data: name === 'manifest.json' ? packagedManifest : readFileSync(join(buildDir, name)),
}));

// 4. Refuse to ship a broken package.
if (!names.includes('manifest.json')) fail('manifest.json is not at the archive root.');
const missing = [...referencedPaths(manifest), 'sync.js'].filter((p) => !names.includes(p));
if (missing.length) {
  fail(`Manifest references files that are not in the build:\n    ${missing.join('\n    ')}`);
}
// Assert against the bytes that actually go into the zip.
if ('key' in JSON.parse(packagedManifest.toString('utf8'))) fail('`key` survived into the packaged manifest.');

// 5. Write the archive.
mkdirSync(outDir, { recursive: true });
const pkgName = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).name;
const outFile = join(outDir, `${pkgName}-${version}.zip`);
const replaced = existsSync(outFile);
writeFileSync(outFile, createZip(files));

const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
console.log(`\n  Packaged ${files.length} files -> ${relative(root, outFile).replace(/\\/g, '/')}` +
            `  (${kb(statSync(outFile).size)})${replaced ? '  [replaced]' : ''}`);
console.log(`  v${version}` + (hadKey ? '  ·  `key` stripped for upload' : ''));
console.log(`\n  Web Store item ${PROD_EXTENSION_ID || '(PROD_EXTENSION_ID not set)'}`);
console.log('  (Edge: https://partner.microsoft.com/dashboard/microsoftedge — same zip, by hand).');
console.log('  Local dev is unaffected — load build/ (or the repo folder) unpacked as before.\n');

// 6. Upload and submit. A machine with no credentials still gets its zip, with
//    a note on what's missing, but exits non-zero: `deploy` didn't deploy.
if (shouldPublish) {
  const outRel = relative(root, outFile).replace(/\\/g, '/');
  const loaded = loadCredentials();
  if (loaded.missing) {
    printSetupHelp(loaded.missing);
    console.log(`  The zip is ready to upload by hand: ${outRel}\n`);
    process.exit(1);
  }
  try {
    assertItemId();
    const r = await publish({
      creds: loaded.creds,
      itemId: PROD_EXTENSION_ID,
      zipPath: outFile,
      expectedVersion: version,
      staged: args.has('--staged'),
    });
    console.log(`  Submitted v${r.version} to the Chrome Web Store: ${r.state}`);
    for (const w of r.warnings) console.log(`  ! ${w.reason}: ${w.description}`);
    console.log('');
  } catch (e) {
    console.error(`\n  x Publish failed: ${e instanceof PublishError ? e.message : e.stack}`);
    console.error(`    The zip is still at ${outRel}\n`);
    process.exit(1);
  }
}
