#!/usr/bin/env node

// Local pre-release confirmation gate.
//
// This project has no CI server by explicit product decision: the only safety
// net before publishing is a human running `yarn check` (lint + build +
// test:full + fork-strict) locally. `yarn release` runs this guard first so
// nobody can publish on autopilot without acknowledging that check passed.
//
// It is intentionally a *local* reminder — no network, no external gate. It
// blocks on an interactive prompt and requires the operator to type `yes`
// (anything else aborts). The old guard just printed a message and paused 5s;
// a distracted developer blew straight past it. This one cannot be blown past
// without a deliberate keystroke.

const readline = require('readline');

const BANNER = `
================================================================================
  RELEASE GUARD

  There is no CI for this repo. The ONLY pre-publish safety net is you.

  Before continuing you must have run, on THIS commit, and seen it pass:

      yarn check     (lint + build + test:full + test:fork-strict)

  Publishing broken code cannot be undone once it hits the registry.
================================================================================
`;

function ask(question) {
	const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
	return new Promise((resolve) => {
		rl.question(question, (answer) => {
			rl.close();
			resolve(answer);
		});
	});
}

async function main() {
	process.stdout.write(BANNER);

	// If stdin is not a TTY we cannot get a genuine human confirmation, so refuse
	// rather than silently proceeding (which would defeat the whole guard).
	if (!process.stdin.isTTY) {
		console.error('\nRelease aborted: no interactive terminal to confirm `yarn check` was run.');
		console.error('Run `yarn release` from an interactive shell.\n');
		process.exit(1);
	}

	const answer = await ask("Did `yarn check` pass on this commit? Type 'yes' to publish: ");

	if (answer.trim().toLowerCase() !== 'yes') {
		console.error('\nRelease aborted. Run `yarn check`, then `yarn release` again.\n');
		process.exit(1);
	}

	console.log('\nConfirmed. Proceeding with release.\n');
}

main().catch((error) => {
	console.error('Release guard failed:', error);
	process.exit(1);
});
