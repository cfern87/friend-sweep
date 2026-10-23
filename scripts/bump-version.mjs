// Bumps the patch/revision version (x.y.Z -> x.y.(Z+1)) in manifest.json, which
// is the file Chrome reads to determine the installed version, and carries that
// number to every other place the version is recorded.
//
// Run by `npm run build`. The revision (Z) is a running count of builds that a
// minor release keeps counting; only a major release starts it over. Set BUMP
// for that one build:
//   BUMP=minor npm run build   x.y.z -> x.(y+1).(z+1)
//   BUMP=major npm run build   x.y.z -> (x+1).0.0
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

/** Rewrite one JSON file's `version` field, leaving the rest of it untouched. */
function setVersion(file, version) {
  const json = JSON.parse(readFileSync(file, 'utf8'));
  if (json.version === version) return;
  json.version = version;
  writeFileSync(file, JSON.stringify(json, null, 2) + '\n');
}

/** Bump the version in every place it lives; returns the new version. */
export function bumpVersion(root) {
  const manifestPath = join(root, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const [major, minor, patch] = manifest.version.split('.').map(Number);

  const bump = (process.env.BUMP || 'patch').toLowerCase();
  if (!['patch', 'minor', 'major'].includes(bump)) {
    throw new Error(`BUMP must be patch, minor or major (got "${process.env.BUMP}")`);
  }
  const next =
    bump === 'major' ? `${major + 1}.0.0`
    : bump === 'minor' ? `${major}.${minor + 1}.${patch + 1}`
    : `${major}.${minor}.${patch + 1}`;

  setVersion(manifestPath, next);
  // Nothing reads package.json's version, but leaving it frozen makes "the
  // version" ambiguous depending on which file you open.
  setVersion(join(root, 'package.json'), next);
  return next;
}
