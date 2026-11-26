// After a successful Chrome Web Store submission: commit the version bump and
// the uploaded zip, then put an annotated tag `v<version>` on that commit.
// Called by package-extension.mjs (`npm run deploy`); never pushes.
//
// WHY: the tag is how you find the exact source of what's live in the store.
// Done by hand it was skipped or mistyped (v1.13.135, 1.2.97), so the script
// that did the deploy now records it.
//
// The commit names its paths explicitly (`git commit -- <paths>`), so anything
// else staged or modified in the tree is left alone — and reported, because
// the tag then marks source that differs from the working copy that was built.
// A failure here never fails the deploy: the submission has already happened.

import { execFileSync } from 'child_process';
import { existsSync } from 'fs';
import { relative } from 'path';

function git(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/**
 * @param {object} o
 * @param {string} o.root     repo root
 * @param {string} o.version  e.g. "1.3.138" — tagged as v1.3.138
 * @param {string[]} o.paths  absolute paths of the files the release changed
 */
export function commitAndTag({ root, version, paths }) {
  const tag = `v${version}`;
  try {
    git(root, ['rev-parse', '--git-dir']);
  } catch {
    console.log(`  ! Not a git checkout — ${tag} not tagged.\n`);
    return;
  }

  const rel = paths
    .filter((p) => existsSync(p))
    .map((p) => relative(root, p).replace(/\\/g, '/'));

  try {
    if (git(root, ['tag', '--list', tag])) {
      console.log(`  ! Tag ${tag} already exists — left as is. Tag the release commit by hand if it's wrong.\n`);
      return;
    }

    git(root, ['add', '--', ...rel]);
    const changed = git(root, ['diff', '--cached', '--name-only', '--', ...rel]);
    if (changed) {
      git(root, ['commit', '-m', `deploy ${tag}`, '--', ...rel]);
      console.log(`  Committed ${changed.split('\n').length} release file(s): "deploy ${tag}"`);
    } else {
      console.log('  Release files unchanged since the last commit — tagging HEAD.');
    }

    git(root, ['tag', '-a', tag, '-m', `Chrome Web Store release ${tag}`]);
    const sha = git(root, ['rev-parse', '--short', 'HEAD']);
    console.log(`  Tagged ${sha} as ${tag} (not pushed: git push origin ${tag})`);

    const dirty = git(root, ['status', '--porcelain']);
    if (dirty) {
      console.log('  ! The working tree has other uncommitted changes. If they went into this build,');
      console.log(`    ${tag} does not contain them — commit them and move the tag (git tag -f -a ${tag}).`);
    }
    console.log('');
  } catch (e) {
    const msg = (e.stderr || e.message || String(e)).toString().trim();
    console.log(`  ! Could not commit/tag ${tag}: ${msg}`);
    console.log(`    The deploy itself succeeded. Commit the release files and run: git tag -a ${tag}\n`);
  }
}
