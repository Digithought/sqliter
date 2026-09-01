#!/usr/bin/env node

import { spawn } from 'child_process';
import { fileURLToPath, pathToFileURL } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const projectRoot = join(__dirname, '../..');
const registerPath = join(__dirname, 'register.mjs');

const mochaPath = fileURLToPath(await import.meta.resolve('mocha/bin/mocha.js'));
const testPattern = join('packages', 'quereus-babel-fish', 'test', '**', '*.spec.ts');

const args = process.argv.slice(2);
const hasReporterFlag = args.some((a) => a === '--reporter' || a === '-R');
const reporterArgs = hasReporterFlag ? [] : ['--reporter', 'min'];

const cmdArgs = [
	'--import', pathToFileURL(registerPath).href,
	mochaPath,
	testPattern,
	'--colors',
	...reporterArgs,
	...args,
];

const child = spawn('node', cmdArgs, {
	cwd: projectRoot,
	env: { ...process.env },
	stdio: 'inherit',
});

child.on('close', (code) => { process.exit(code || 0); });
child.on('error', (err) => {
	console.error('Failed to start test process:', err);
	process.exit(1);
});
