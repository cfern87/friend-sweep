#!/usr/bin/env node
// Build step: bump the version everywhere, then copy the extension's runtime
// files into <repo>/build/ — the folder to load unpacked, and the exact set of
// files `npm run package` zips for the Chrome Web Store.
//
// There is no bundler: the source files are what Chrome runs. "Building" is
// choosing which files ship, so docs, scripts, git metadata and anything else
// that isn't part of the extension never reach the store package.
//
//   npm run build                 bump patch, then build
//   BUMP=minor npm run build      see scripts/bump-version.mjs
//   node scripts/build.mjs --no-bump   rebuild at the current version
//                                      (used by package-extension.mjs)

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'fs';
import { dirname, join, relative, resolve } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { bumpVersion } from './bump-version.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'build');

// Everything the extension needs at runtime. Add new top-level files or
// folders here — the reference check below fails the build if the manifest
// points at something this list leaves out.
const SHIP = [
  'manifest.json',
  'background.js',
  'sync.js',
  'license.js',
  'content',
  'dashboard',
  'popup',
  'icons',
];

/** Every file the manifest points at, wherever it is nested. */
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

export function build({ bump = true } = {}) {
  const version = bump
    ? bumpVersion(root)
    : JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8')).version;

  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  for (const entry of SHIP) {
    const src = join(root, entry);
    if (!existsSync(src)) fail(`Missing ${entry} — listed in SHIP but not in the repo.`);
    cpSync(src, join(outDir, entry), { recursive: true });
  }

  // background.js pulls sync.js in with importScripts, which the manifest
  // can't see — so check it explicitly alongside the manifest's references.
  const manifest = JSON.parse(readFileSync(join(outDir, 'manifest.json'), 'utf8'));
  const needed = [...referencedPaths(manifest), 'sync.js'];
  const missing = needed.filter((p) => !existsSync(join(outDir, p)));
  if (missing.length) fail(`Manifest references files that are not in the build:\n    ${missing.join('\n    ')}`);

  console.log(`  Built v${version} -> ${relative(root, outDir).replace(/\\/g, '/')}/` +
              (bump ? '  (version bumped)' : ''));
  return { version, outDir };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  build({ bump: !process.argv.includes('--no-bump') });
}
