#!/usr/bin/env node

// Creates the GitHub release for the current version.
//
// Release notes source:
//   - If an untracked `.release-notes.pending.md` exists at the repo root, its
//     contents become the release body (curated notes accumulated during the
//     cycle), and the file is consumed (deleted) on success — the published
//     GitHub release becomes the canonical copy.
//   - Otherwise we fall back to GitHub's auto-generated notes (`--generate-notes`).
//
// The pending file is intentionally optional: a release with no curated notes
// still succeeds with generated notes.

const { execSync } = require('child_process');
const { existsSync, readFileSync, rmSync } = require('fs');
const { join } = require('path');

const rootDir = join(__dirname, '..');
const { version } = require(join(rootDir, 'package.json'));
const tag = `v${version}`;
const pendingPath = join(rootDir, '.release-notes.pending.md');

const usePending = existsSync(pendingPath) && readFileSync(pendingPath, 'utf8').trim().length > 0;

const notesFlag = usePending
	? `--notes-file "${pendingPath}"`
	: '--generate-notes';

if (usePending) {
	console.log(`Creating release ${tag} from .release-notes.pending.md`);
} else {
	console.log(`Creating release ${tag} with auto-generated notes (no .release-notes.pending.md)`);
}

try {
	execSync(`gh release create ${tag} --title ${tag} ${notesFlag}`, { stdio: 'inherit' });
} catch (error) {
	console.error(`Failed to create GitHub release ${tag}:`, error.message);
	process.exit(1);
}

if (usePending) {
	rmSync(pendingPath);
	console.log('Consumed .release-notes.pending.md (the GitHub release now holds the notes).');
}
