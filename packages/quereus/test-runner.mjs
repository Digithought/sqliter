#!/usr/bin/env node

import { spawn } from 'child_process';
import { fileURLToPath, pathToFileURL } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Parse command line arguments
const args = process.argv.slice(2);
const env = { ...process.env };
const testArgs = [];

// Handle test-specific arguments
let i = 0;
while (i < args.length) {
	const arg = args[i];

	switch (arg) {
		case '--trace-plan-stack':
			env.QUEREUS_TEST_TRACE_PLAN_STACK = 'true';
			break;
		case '--store':
			env.QUEREUS_TEST_STORE = 'true';
			break;
		case '--fork-strict':
			env.QUEREUS_FORK_STRICT = '1';
			break;
		case '--context-strict':
			env.QUEREUS_CONTEXT_STRICT = '1';
			break;
		case '--repr-strict':
			env.QUEREUS_REPR_STRICT = '1';
			break;
		case '--show-plan':
			env.QUEREUS_TEST_SHOW_PLAN = 'true';
			break;
		case '--plan-full-detail':
			env.QUEREUS_TEST_SHOW_PLAN = 'true';
			testArgs.push(arg);
			break;
		case '--plan-summary':
			testArgs.push(arg);
			break;
		case '--expand-nodes':
			testArgs.push(arg);
			if (i + 1 < args.length && !args[i + 1].startsWith('--')) {
				testArgs.push(args[i + 1]);
				i++; // Skip next argument
			}
			break;
		case '--max-plan-depth':
			testArgs.push(arg);
			if (i + 1 < args.length && !args[i + 1].startsWith('--')) {
				testArgs.push(args[i + 1]);
				i++; // Skip next argument
			}
			break;
		case '--show-program':
			env.QUEREUS_TEST_SHOW_PROGRAM = 'true';
			break;
		case '--show-stack':
			env.QUEREUS_TEST_SHOW_STACK = 'true';
			break;
		case '--show-trace':
			env.QUEREUS_TEST_SHOW_TRACE = 'true';
			break;
		case '--verbose':
			env.QUEREUS_TEST_VERBOSE = 'true';
			testArgs.push('--reporter', 'spec');
			break;
		default:
			// Pass through other arguments (like test file patterns)
			testArgs.push(arg);
			break;
	}
	i++;
}

// Set up paths
const projectRoot = join(__dirname, '../..');
const registerPath = join(__dirname, 'register.mjs');

// Resolve mocha path using Yarn PnP
const mochaPath = fileURLToPath(await import.meta.resolve('mocha/bin/mocha.js'));
const testPattern = join('packages', 'quereus', 'test', '**', '*.spec.ts');

// Use 'min' reporter by default for concise output (full failure details preserved).
// Override with --reporter <name> on the command line.
const hasReporterFlag = testArgs.some((a, i) => a === '--reporter' || a === '-R');
const reporterArgs = hasReporterFlag ? [] : ['--reporter', 'min'];

// Default to a generous per-test timeout: the property-based suites (fast-check)
// nominally run in well under 1s but can be starved past Mocha's 2s default when
// the machine is under concurrent load (e.g. a background ticket runner). 10s
// keeps real hangs detectable while absorbing contention. Overridable via --timeout.
const hasTimeoutFlag = testArgs.some((a) => a === '--timeout' || a === '-t');
const timeoutArgs = hasTimeoutFlag ? [] : ['--timeout', '10000'];

// Build command arguments
const cmdArgs = [
	'--import', pathToFileURL(registerPath).href,
	mochaPath,
	testPattern,
	'--colors',
	'--bail',
	...timeoutArgs,
	...reporterArgs,
	...testArgs
];

// Spawn the test process
const child = spawn('node', cmdArgs, {
	cwd: projectRoot,
	env: env,
	stdio: 'inherit'
});

// Handle process events
child.on('close', (code) => {
	process.exit(code || 0);
});

child.on('error', (err) => {
	console.error('Failed to start test process:', err);
	process.exit(1);
});
