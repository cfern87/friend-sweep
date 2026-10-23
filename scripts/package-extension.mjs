#!/usr/bin/env node
// Release step: rebuild the extension at its CURRENT version (no bump), then
// produce the Chrome Web Store upload zip at <repo>/dist/<name>-<version>.zip.
//
// Run `npm run build` first when you want a new version number; this step
// never bumps, so the filename always matches the manifest that actually went
// into the archive, and packaging twice doesn't burn a version.
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

// 1. Build at the current version.
console.log('  Building extension ...\n');
const { version, outDir: buildDir } = build({ bump: false });

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
console.log('\n  Upload it at https://chrome.google.com/webstore/devconsole');
console.log('  (Edge: https://partner.microsoft.com/dashboard/microsoftedge — same zip).');
console.log('  Local dev is unaffected — load build/ (or the repo folder) unpacked as before.\n');
