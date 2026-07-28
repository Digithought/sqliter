/* eslint-disable @typescript-eslint/no-explicit-any */
import { expect, config } from 'chai';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { Database } from '../src/core/database.js';
import { QuereusError } from '../src/common/errors.js';
import { safeJsonStringify } from '../src/util/serialization.js';
import { CollectingInstructionTracer } from '../src/runtime/types.js';
import { formatPlanTree, formatPlanSummary, type PlanDisplayOptions } from '../src/planner/debug.js';
import {
	parseRequiredCapabilities,
	missingCapability,
	MEMORY_BACKEND_CAPABILITIES,
	STORE_BACKEND_CAPABILITIES,
	type SqllogicCapability,
} from './logic-capabilities.js';

config.truncateThreshold = 1000;
config.includeStack = true;

/** Normalize BigInt values to Number for comparison with JSON-parsed expected results.
 *  JSON has no BigInt representation, so engine BigInt results must be compared as Numbers. */
function normalizeBigInts(obj: any): any {
	if (typeof obj === 'bigint') return Number(obj);
	if (Array.isArray(obj)) return obj.map(normalizeBigInts);
	if (obj !== null && typeof obj === 'object') {
		const result: Record<string, any> = {};
		for (const [key, value] of Object.entries(obj)) {
			result[key] = normalizeBigInts(value);
		}
		return result;
	}
	return obj;
}

// ESM equivalent for __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Store mode configuration
const USE_STORE_MODULE = process.env.QUEREUS_TEST_STORE === 'true' || process.env.QUEREUS_TEST_STORE === '1';

// What this backend accepts, for the `-- requires-capability:` directive in .sqllogic files
// (see logic-capabilities.ts and test/README.md).
const BACKEND_CAPABILITIES = USE_STORE_MODULE ? STORE_BACKEND_CAPABILITIES : MEMORY_BACKEND_CAPABILITIES;

// Files that are explicitly memory-module-specific and should be skipped in store mode.
//
// Split rule vs the capability directive: capability-shaped divergence — the store deliberately
// does not accept some whole class of SQL statement — belongs in a `-- requires-capability:`
// line in the file itself, so every consumer of the shared corpus honours it. This set is for
// everything else: memory-engine quirks, cost-model choices, harness-config assertions,
// white-box internals, and tracked store bugs. None of the entries below is capability-shaped.
const MEMORY_ONLY_FILES = new Set([
  '05-vtab_memory.sqllogic',  // Explicitly tests memory table indexing behavior
  // '10.1.3.1-ddl-drop-savepoint-memory.sqllogic' was folded into 10.1.3-ddl-drop-in-transaction.sqllogic § 4. It was memory-only because the STORE leg diverged: store mode runs behind the isolation layer, which used to rebuild its staging overlay on index DDL and so lost rows staged before the savepoint. With that adopt now in place (bug-isolation-index-ddl-rebuild-drops-savepoint-writes) the store leg matches plain memory on the whole sequence — pre-savepoint rows kept, and the DROP not undone by `rollback to savepoint`
  '10.2.2-default-collation-memory.sqllogic',  // Asserts the memory-side BINARY default for an undecorated text PK; the store applies NOCASE (see docs/schema.md §"Per-column PK key collation")
  // '40-constraints.sqllogic' was excluded here; now fixed by IsolatedConnection.isCovering tiebreak
  // '41-foreign-keys.sqllogic' was excluded here; now fixed by IsolatedTable surfacing replacedRow for OR REPLACE store-side displacements
  // '41.7.1-alter-column-collate-unique.sqllogic' is now cross-module: the store keys the PK per-column (store-pk-collate-physical-rekey), so an explicit `collate binary` PK holds the 'a'/'A' pair and re-keys it under SET COLLATE just like memory
  // '41.7.3-alter-column-retype-unique.sqllogic' is now cross-module: the store defers the ALTER COLUMN value rewrite until after the UNIQUE re-validation over converted values (bug-retype-unique-revalidation-store)
  '41.2.1-alter-column-retype-deleted-row-memory.sqllogic',  // A retype whose only unconvertible value sits in a row the transaction has DELETED: memory accepts (effective-row rule), but the store's convert pre-pass scans its OWN effective rows and cannot see the wrapper overlay's tombstone (NOTE in StoreModule.alterColumnSetDataType), so the store leg rejects
  '41.7.5-alter-column-collate-pk-staged-delete-memory.sqllogic',  // SET COLLATE on a PK member after delete-then-case-variant-reinsert. Diverges on store at the very first INSERT: the store defaults an undecorated text PK to NOCASE (see 10.2.2 above), so the case-variant replacement collides before any ALTER runs — and even with an explicit `collate binary` PK the store's re-key judges its own committed rows, falsely rejecting the deleted row's collision (backlog/bug-store-pk-collate-rejects-deleted-row-collision)
  // '41.7.3.1-alter-column-retype-staged-rows-memory.sqllogic' is now cross-module: the isolation overlay the store runs behind converts the transaction's staged rows on an accepted retype (bug-isolation-retype-leaves-staged-rows-unconverted)
  // '41.7.4-alter-column-retype-semantic-memory.sqllogic' is now cross-module: the store gates its value rewrite on logical-type identity too (bug-retype-same-class-skips-value-validation), so the DATE/TIME/DATETIME half re-validates and rebuilds there as well — it no longer depends on the key-transform guard that covered only TIMESPAN/JSON  // Pins the memory module's same-storage-class retype contract (text ↔ timespan / json / date). The store covers the TIMESPAN and JSON halves via its own key-transform guard, but not the date half, which turns on comparator identity rather than a key transform
  '83-merge-join.sqllogic',  // Asserts planner picks MergeJoin for PK equi-join; store's cost model can validly prefer HashJoin
  // '101-transaction-edge-cases.sqllogic',  // ROLLBACK TO SAVEPOINT through overlay memory connection hits undefined schema in TransactionLayer
  '103-database-options-edge-cases.sqllogic',  // Asserts default_vtab_module='memory'; store-mode harness sets it to 'store'
  '105-vtab-memory-mutation-kills.sqllogic',  // White-box mutation tests targeting src/vtab/memory/ internals
]);

// Determine project root - if we're in dist/test, go up two levels, otherwise just one
const isInDist = __dirname.includes(path.join('dist', 'test'));
const projectRoot = isInDist ? path.resolve(__dirname, '..', '..') : path.resolve(__dirname, '..');
const logicTestDir = path.join(projectRoot, 'test', 'logic');

/**
 * Parse command line arguments for test diagnostics
 */
interface TestOptions {
	showPlan: boolean;
	showProgram: boolean;
	showStack: boolean;
	showTrace: boolean;
	verbose: boolean;
	planSummary: boolean;
	expandNodes: string[];
	planFullDetail: boolean;
	maxPlanDepth?: number;
	tracePlanStack: boolean;
}

function parseTestOptions(): TestOptions {
	const args = process.argv;
	const options: TestOptions = {
		showPlan: false,
		showProgram: false,
		showStack: false,
		showTrace: false,
		verbose: false,
		planSummary: false,
		expandNodes: [],
		planFullDetail: false,
		maxPlanDepth: undefined,
		tracePlanStack: false
	};

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];

		switch (arg) {
			case '--show-plan':
				options.showPlan = true;
				break;
			case '--show-program':
				options.showProgram = true;
				break;
			case '--show-stack':
				options.showStack = true;
				break;
			case '--show-trace':
				options.showTrace = true;
				break;
			case '--verbose':
				options.verbose = true;
				break;
			case '--plan-summary':
				options.planSummary = true;
				break;
			case '--plan-full-detail':
				options.planFullDetail = true;
				options.showPlan = true; // Implies show-plan
				break;
			case '--trace-plan-stack':
				options.tracePlanStack = true;
				break;
			case '--expand-nodes':
				if (i + 1 < args.length) {
					const nodeList = args[i + 1];
					if (!nodeList.startsWith('--')) {
						options.expandNodes = nodeList.split(',').map(s => s.trim());
						options.showPlan = true; // Implies show-plan
						i++; // Skip next argument since we consumed it
					}
				}
				break;
			case '--max-plan-depth':
				if (i + 1 < args.length) {
					const depth = parseInt(args[i + 1], 10);
					if (!isNaN(depth) && depth > 0) {
						options.maxPlanDepth = depth;
						i++; // Skip next argument since we consumed it
					}
				}
				break;
		}
	}

	// Fall back to environment variables for backward compatibility
	if (!hasAnyArgument(args)) {
		options.showPlan = process.env.QUEREUS_TEST_SHOW_PLAN === 'true';
		options.showProgram = process.env.QUEREUS_TEST_SHOW_PROGRAM === 'true';
		options.showStack = process.env.QUEREUS_TEST_SHOW_STACK === 'true';
		options.showTrace = process.env.QUEREUS_TEST_SHOW_TRACE === 'true';
		options.verbose = process.env.QUEREUS_TEST_VERBOSE === 'true';
		options.tracePlanStack = process.env.QUEREUS_TEST_TRACE_PLAN_STACK === 'true';
	}

	return options;
}

function hasAnyArgument(args: string[]): boolean {
	const testFlags = [
		'--show-plan', '--show-program', '--show-stack', '--show-trace',
		'--verbose', '--plan-summary', '--plan-full-detail', '--expand-nodes', '--max-plan-depth',
		'--trace-plan-stack'
	];
	return args.some(arg => testFlags.includes(arg));
}

// Parse test options from command line
const TEST_OPTIONS = parseTestOptions();

// Debug: check if verbose flag is working
if (TEST_OPTIONS.verbose) {
	console.log('VERBOSE MODE ENABLED via command line arguments');
}

/**
 * Formats location information from QuereusError for display
 * Recursively unravels the cause chain to show all error details
 */
function formatLocationInfo(error: any, sqlContext: string): string | null {
	const locationInfoParts: string[] = [];
	let currentError = error;
	let depth = 0;
	const maxDepth = 10; // Prevent infinite loops

	// Recursively walk through the cause chain
	while (currentError && depth < maxDepth) {
		if (currentError instanceof QuereusError && currentError.line !== undefined) {
			const location = { line: currentError.line, column: currentError.column };
			const lines = sqlContext.split('\n');
			const prefix = depth === 0 ? '' : `  Caused by (depth ${depth}): `;

			locationInfoParts.push(`${prefix}Line ${location.line}, Column ${location.column || 'unknown'}`);
			locationInfoParts.push(`${prefix}Error: ${currentError.message}`);

			// Show the problematic line with a caret indicator
			if (location.line > 0 && location.line <= lines.length) {
				const lineContent = lines[location.line - 1];
				locationInfoParts.push(`${prefix}${lineContent}`);

				// Add caret pointer if column is valid
				if (location.column !== undefined && location.column > 0 && location.column <= lineContent.length) {
					const pointer = ' '.repeat(location.column - 1) + '^';
					locationInfoParts.push(`${prefix}${pointer}`);
				}
			}

			if (depth > 0) {
				locationInfoParts.push(''); // Add spacing between cause levels
			}
		}

		// Move to the next error in the cause chain
		currentError = currentError?.cause;
		depth++;
	}

	if (depth >= maxDepth && currentError) {
		locationInfoParts.push(`  ... (max depth ${maxDepth} reached, additional causes not shown)`);
	}

	return locationInfoParts.length > 0 ? '\n' + locationInfoParts.join('\n') : null;
}

/**
 * Generates configurable diagnostic information for failed tests.
 *
 * Command line arguments to control output:
 * - --verbose                     : Show execution progress during tests
 * - --show-plan                   : Include concise query plan in diagnostics
 * - --plan-full-detail            : Include full detailed query plan
 * - --plan-summary                : Show one-line execution path summary
 * - --expand-nodes node1,node2... : Expand specific nodes in concise plan
 * - --max-plan-depth N            : Limit plan display to N levels deep
 * - --show-program                : Include instruction program in diagnostics
 * - --show-stack                  : Include full stack trace in diagnostics
 * - --show-trace                  : Include execution trace in diagnostics
 * - --trace-plan-stack            : Enable plan stack tracing in runtime
 *
 * Environment variables (for backward compatibility):
 * - QUEREUS_TEST_VERBOSE=true       : Show execution progress during tests
 * - QUEREUS_TEST_SHOW_PLAN=true     : Include query plan in diagnostics
 * - QUEREUS_TEST_SHOW_PROGRAM=true  : Include instruction program in diagnostics
 * - QUEREUS_TEST_SHOW_STACK=true    : Include full stack trace in diagnostics
 * - QUEREUS_TEST_SHOW_TRACE=true    : Include execution trace in diagnostics
 * - QUEREUS_TEST_TRACE_PLAN_STACK=true : Enable plan stack tracing in runtime
 */
function generateDiagnostics(db: Database, sqlBlock: string, error: Error): string {
	const diagnostics = ['\n=== FAILURE DIAGNOSTICS ==='];

	// Always show location information if available
	const locationInfo = formatLocationInfo(error, sqlBlock);
	if (locationInfo) {
		diagnostics.push(locationInfo);
	}

	// Show configuration hint if no diagnostics are enabled
	const anyDiagEnabled = TEST_OPTIONS.showPlan || TEST_OPTIONS.showProgram || TEST_OPTIONS.showStack || TEST_OPTIONS.showTrace || TEST_OPTIONS.planSummary;
	if (!anyDiagEnabled) {
		diagnostics.push('\nFor more detailed diagnostics, use command line arguments:');
		diagnostics.push('  --verbose                     - Show execution progress');
		diagnostics.push('  --show-plan                   - Show concise query plan');
		diagnostics.push('  --plan-full-detail            - Show full detailed query plan');
		diagnostics.push('  --plan-summary                - Show one-line execution path');
		diagnostics.push('  --expand-nodes node1,node2... - Expand specific nodes in plan');
		diagnostics.push('  --max-plan-depth N            - Limit plan depth to N levels');
		diagnostics.push('  --show-program                - Show instruction program');
		diagnostics.push('  --show-stack                  - Show full stack trace');
		diagnostics.push('  --show-trace                  - Show execution trace');
		diagnostics.push('  --trace-plan-stack            - Enable plan stack tracing');
	}

	try {
		const statements = sqlBlock.split(';').map(s => s.trim()).filter(s => s.length > 0);
		const lastStatement = statements[statements.length - 1];

		if (lastStatement && (TEST_OPTIONS.showPlan || TEST_OPTIONS.planSummary)) {
			try {
				const plan = db.getPlan(lastStatement);

				if (TEST_OPTIONS.planSummary) {
					diagnostics.push('\nQUERY PLAN SUMMARY:');
					diagnostics.push(formatPlanSummary(plan));
				}

				if (TEST_OPTIONS.showPlan) {
					diagnostics.push('\nQUERY PLAN:');
					const planOptions: PlanDisplayOptions = {
						concise: !TEST_OPTIONS.planFullDetail,
						expandNodes: TEST_OPTIONS.expandNodes,
						maxDepth: TEST_OPTIONS.maxPlanDepth,
						showPhysical: true
					};
					const formattedPlan = formatPlanTree(plan, planOptions);
					diagnostics.push(formattedPlan);
				}
			} catch (planError: any) {
				diagnostics.push(`Plan generation failed: ${planError.message || planError}`);
			}
		}

		if (lastStatement && TEST_OPTIONS.showProgram) {
			diagnostics.push('\nINSTRUCTION PROGRAM:');
			try {
				const stmt = db.prepare(lastStatement);
				const program = stmt.getDebugProgram();
				diagnostics.push(program);
				stmt.finalize().catch(() => {}); // Silent cleanup
			} catch (programError: any) {
				diagnostics.push(`Program generation failed: ${programError.message || programError}`);
			}
		}

		if (TEST_OPTIONS.showStack && error.stack) {
			diagnostics.push('\nSTACK TRACE:');
			diagnostics.push(error.stack);
		}

	} catch (diagError: any) {
		diagnostics.push(`\nDiagnostic generation failed: ${diagError.message || diagError}`);
	}

	diagnostics.push('=== END DIAGNOSTICS ===\n');
	return diagnostics.join('\n');
}

/**
 * Executes a query with tracing and returns results plus trace information
 */
async function executeWithTracing(db: Database, sql: string, params?: any[]): Promise<{
	results: any[],
	traceEvents: any[]
}> {
	const tracer = new CollectingInstructionTracer();
	const results: any[] = [];

	try {
		// Set the tracer on the database
		db.setInstructionTracer(tracer);

		const stmt = db.prepare(sql);
		if (params) {
			stmt.bindAll(params);
		}

		for await (const row of stmt.iterateRows()) {
			// Convert row array to object using column names
			const columnNames = stmt.getColumnNames();

			// For single-column results, check if it's a simple expression that should use array format
			if (columnNames.length === 1) {
				const columnName = columnNames[0].toLowerCase();

				// Simple expressions that use array format [value]:
				// 1. IS NOT NULL / IS NULL expressions (standalone, not part of complex expressions)
				// 2. Simple arithmetic (contains - but not complex boolean operators)
				// 3. Specific function calls that use simple format (JSON, date/time functions)
				const isSimpleExpression =
					// Standalone IS NULL expressions (not part of XOR, AND, OR expressions)
					(columnName.endsWith(' is not null') || columnName.endsWith(' is null')) &&
					!columnName.includes(' xor ') && !columnName.includes(' and ') && !columnName.includes(' or ') ||
					// Simple arithmetic like "julianday('2024-01-01') - julianday('2023-01-01')"
					(columnName.includes(' - ') && !columnName.includes(' and ') && !columnName.includes(' or ') && !columnName.includes(' xor ')) ||
					// Specific function calls that use simple format (JSON and date/time functions mainly)
					(/^(json_extract|json_array_length|json_array|json_object|json_insert|json_replace|json_set|json_remove|strftime|julianday|date|time|datetime|epoch_s|epoch_ms|epoch_s_frac)\(.+\)$/.test(columnName));

				if (isSimpleExpression) {
					// Simple value format for simple expressions
					results.push(row[0]);
				} else {
					// Object format for complex expressions, column references, etc.
					const rowObject = row.reduce((obj: Record<string, any>, val: any, idx: number) => {
						obj[columnNames[idx] || `col_${idx}`] = val;
						return obj;
					}, {} as Record<string, any>);
					results.push(rowObject);
				}
			} else {
				// Multi-column results always use object format
				const rowObject = row.reduce((obj: Record<string, any>, val: any, idx: number) => {
					obj[columnNames[idx] || `col_${idx}`] = val;
					return obj;
				}, {} as Record<string, any>);
				results.push(rowObject);
			}
		}

		await stmt.finalize();
	} catch (error: any) {
		// Re-throw with optional trace and location information (including cause chain)
		let errorMsg = error.message || String(error);

		// Add location information if available (recursively through cause chain)
		const locationInfo = formatLocationInfo(error, sql);
		if (locationInfo) {
			errorMsg += locationInfo;
		}

		if (TEST_OPTIONS.showTrace) {
			errorMsg += `\n\nEXECUTION TRACE:\n${formatTraceEvents(tracer.getTraceEvents())}`;
		}

		const enhancedError = new Error(errorMsg);
		enhancedError.stack = error.stack;
		throw enhancedError;
	} finally {
		// Clean up the tracer to avoid affecting other tests
		db.setInstructionTracer(undefined);
	}

	return {
		results,
		traceEvents: tracer.getTraceEvents()
	};
}

/**
 * Formats trace events for readable output
 */
function formatTraceEvents(events: any[]): string {
	if (events.length === 0) return 'No trace events captured.';

	const lines = ['Instruction Execution Trace:'];
	for (const event of events) {
		const note = event.note ? ` (${event.note})` : '';
		const timestamp = new Date(event.timestamp).toISOString();

		if (event.type === 'input') {
			lines.push(`[${event.instructionIndex}] INPUT${note} at ${timestamp}: ${safeJsonStringify(event.args)}`);
		} else if (event.type === 'output') {
			lines.push(`[${event.instructionIndex}] OUTPUT${note} at ${timestamp}: ${safeJsonStringify(event.result)}`);
		} else if (event.type === 'row') {
			lines.push(`[${event.instructionIndex}] ROW #${event.rowIndex ?? 'unknown'}${note} at ${timestamp}: ${safeJsonStringify(event.row)}`);
		} else if (event.type === 'error') {
			lines.push(`[${event.instructionIndex}] ERROR${note} at ${timestamp}: ${event.error}`);
		}
	}
	return lines.join('\n');
}

// Dynamically import store module only when needed (to avoid requiring LevelDB in memory-only tests)
let createIsolatedStoreModule: any = null;
let createLevelDBProvider: any = null;

async function loadStoreModules() {
	if (!createIsolatedStoreModule) {
		const storePlugin = await import('@quereus/store');
		createIsolatedStoreModule = storePlugin.createIsolatedStoreModule;
		const leveldbPlugin = await import('@quereus/plugin-leveldb');
		createLevelDBProvider = leveldbPlugin.createLevelDBProvider;
	}
}

function createStoreTestDir(): string {
	const dir = path.join(os.tmpdir(), `quereus-logic-store-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	fs.mkdirSync(dir, { recursive: true });
	return dir;
}

function cleanupStoreTestDir(dir: string) {
	try {
		fs.rmSync(dir, { recursive: true, force: true });
	} catch {
		// Ignore cleanup errors
	}
}

describe('SQL Logic Tests' + (USE_STORE_MODULE ? ' (Store Mode)' : ''), () => {
	const files = fs.readdirSync(logicTestDir)
		.filter(file => file.endsWith('.sqllogic'));

	// Setup/teardown for store mode at suite level
	before(async function() {
		if (USE_STORE_MODULE) {
			this.timeout(10000);
			// Pre-load the store modules
			await loadStoreModules();
			console.log('\n📦 Running logic tests in STORE MODE (LevelDB backend)\n');
		}
	});

	for (const file of files) {
		const filePath = path.join(logicTestDir, file);
		const content = fs.readFileSync(filePath, 'utf-8');

		// A malformed directive must fail exactly one file, not abort suite registration.
		let required: ReadonlySet<SqllogicCapability>;
		try {
			required = parseRequiredCapabilities(file, content);
		} catch (parseError: unknown) {
			const error = parseError instanceof Error ? parseError : new Error(String(parseError));
			describe(`File: ${file}`, () => {
				it('should declare valid capability directives', () => { throw error; });
			});
			continue;
		}

		// Capability skip is evaluated before MEMORY_ONLY_FILES so its more specific message wins.
		const missing = missingCapability(required, BACKEND_CAPABILITIES);
		if (missing) {
			describe(`File: ${file}`, () => {
				it.skip(`skipped: backend lacks capability "${missing}"`, () => {});
			});
			continue;
		}

		// Skip memory-only files in store mode
		if (USE_STORE_MODULE && MEMORY_ONLY_FILES.has(file)) {
			describe(`File: ${file}`, () => {
				it.skip('skipped in store mode (memory-only test)', () => {});
			});
			continue;
		}

		describe(`File: ${file}`, () => {
			let db: Database;
			let testStorePath: string | null = null;
			let leveldbModule: any = null;

			beforeEach(async function() {
				if (USE_STORE_MODULE) {
					this.timeout(10000);
				}

				db = new Database();

				// Set trace_plan_stack option if enabled
				if (TEST_OPTIONS.tracePlanStack) {
					db.setOption('trace_plan_stack', true);
				}

				// Configure the default vtab module
				if (USE_STORE_MODULE) {
					// Create LevelDB provider and an isolated store module (StoreModule wrapped
					// with the isolation layer for read-your-own-writes, rollback, and savepoints).
					testStorePath = createStoreTestDir();
					const provider = createLevelDBProvider({ basePath: testStorePath.replace(/\\/g, '/') });
					leveldbModule = createIsolatedStoreModule({ provider });
					db.registerModule('store', leveldbModule);
					db.setOption('default_vtab_module', 'store');
				} else {
					// Memory is already registered by default, just ensure it's set
					db.setOption('default_vtab_module', 'memory');
				}
			});

			afterEach(async function() {
				if (USE_STORE_MODULE) {
					this.timeout(10000);
				}

				await db.close();

				// Close store module and cleanup. Ignore teardown errors (e.g. LevelDB
				// lock contention during cleanup) — the test directory is removed below.
				if (leveldbModule) {
					try {
						await leveldbModule.closeAll();
					} catch {
						/* ignore teardown errors */
					}
				}
				if (testStorePath) {
					cleanupStoreTestDir(testStorePath);
					testStorePath = null;
				}
			});

			it('should execute statements and match results or expected errors', async function() {
				// Each .sqllogic file runs as a single test that executes the whole file
				// (potentially thousands of statements), so mocha's 2000ms default is
				// structurally too tight — the larger files sit right at the boundary and
				// flake under full-suite GC/load. Give memory mode a generous explicit
				// timeout; store mode is slower still.
				this.timeout(USE_STORE_MODULE ? 30000 : 15000);

				const lines = content.split(/\r?\n/);
				let currentSql = '';
				let expectedResultJson: string | null = null;
				let expectedErrorSubstring: string | null = null;
				let currentParams: any[] | null = null;
				let lineNumber = 0;

				/**
				 * Resets the current state for the next SQL block
				 */
				const resetState = () => {
					currentSql = '';
					expectedResultJson = null;
					expectedErrorSubstring = null;
					currentParams = null;
				};

				/**
				 * Executes SQL expecting an error with the given substring
				 */
				const executeExpectingError = async (sqlBlock: string, errorSubstring: string, lineNum: number) => {
					if (TEST_OPTIONS.verbose) {
						console.log(`Executing block (expect error "${errorSubstring}"):\n${sqlBlock}`);
					}

					// Split into setup statements and final query so that SELECT-iteration
					// errors (e.g. row-generator throws) are actually surfaced. db.exec on a
					// SELECT does not consume the result iterator, so errors thrown inside
					// the generator body would otherwise stay latent. Setup statements run
					// in a single db.exec so multi-statement DML batches retain atomicity.
					const statements = sqlBlock.split(';').map(s => s.trim()).filter(s => s.length > 0);
					const setupStatements = statements.slice(0, -1);
					const finalStatement = statements[statements.length - 1] ?? '';

					let actualError: Error | undefined;
					try {
						if (setupStatements.length > 0) {
							await db.exec(setupStatements.join(';\n') + ';');
						}
						if (finalStatement) {
							const prepared = db.prepare(finalStatement);
							try {
								// Drain rows so iteration-time errors are raised
								for await (const _row of prepared.iterateRows()) { /* drain */ }
							} finally {
								await prepared.finalize();
							}
						}
					} catch (e: any) {
						actualError = e instanceof Error ? e : new Error(String(e));
					}

					if (actualError === undefined) {
						const baseError = new Error(`[${file}:${lineNum}] Expected error matching "${errorSubstring}" but SQL block executed successfully.\nBlock: ${sqlBlock}`);
						const diagnostics = generateDiagnostics(db, sqlBlock, baseError);
						throw new Error(`${baseError.message}${diagnostics}`);
					}

					expect(actualError.message.toLowerCase()).to.include(errorSubstring.toLowerCase(),
						`[${file}:${lineNum}] Block: ${sqlBlock}\nExpected error containing: "${errorSubstring}"\nActual error: "${actualError.message}"`
					);

					const locationInfo = formatLocationInfo(actualError, sqlBlock);
					if (TEST_OPTIONS.verbose && locationInfo) {
						console.log(`   -> Error location: ${locationInfo}`);
					}
					if (TEST_OPTIONS.verbose) {
						console.log(`   -> Caught expected error: ${actualError.message}`);
					}
				};

				/**
				 * Executes SQL expecting specific results
				 */
				const executeExpectingResults = async (sqlBlock: string, expectedJson: string, lineNum: number, params?: any[] | null) => {
					if (TEST_OPTIONS.verbose) {
						console.log(`Executing block (expect results):\n${sqlBlock}`);
					}

					// Split into setup statements and final query
					const statements = sqlBlock.split(';').map(s => s.trim()).filter(s => s.length > 0);

					// Execute all but the last statement as setup
					if (statements.length > 1) {
						for (let i = 0; i < statements.length - 1; i++) {
							const statement = statements[i].trim();
							if (statement.length > 0) {
								if (TEST_OPTIONS.verbose) {
									console.log(`  -> Executing setup statement: ${statement}`);
								}
								await db.exec(statement);
							}
						}
					}

					// Execute the final statement with tracing
					const lastStatement = statements[statements.length - 1];
					if (TEST_OPTIONS.verbose) {
						console.log(`  -> Executing final statement (with tracing): ${lastStatement}`);
					}

					let executionResult: { results: Record<string, any>[], traceEvents: any[] };
					if (lastStatement) {
						executionResult = await executeWithTracing(db, lastStatement, params ?? undefined);
					} else {
						executionResult = { results: [], traceEvents: [] };
					}

					const actualResult = executionResult.results;

					// Parse expected results
					let expectedResult: any;
					try {
						expectedResult = JSON.parse(expectedJson);
					} catch (jsonError: any) {
						throw new Error(`[${file}:${lineNum}] Invalid expected JSON: ${jsonError.message} - JSON: ${expectedJson}`);
					}

					// Compare row counts
					if (actualResult.length !== expectedResult.length) {
						const baseError = new Error(`[${file}:${lineNum}] Row count mismatch. Expected ${expectedResult.length}, got ${actualResult.length}\nBlock:\n${sqlBlock}`);
						const diagnostics = generateDiagnostics(db, sqlBlock, baseError);
						const traceInfo = TEST_OPTIONS.showTrace ? `\nEXECUTION TRACE:\n${formatTraceEvents(executionResult.traceEvents)}` : '';
						throw new Error(`${baseError.message}${diagnostics}${traceInfo}`);
					}

					// Compare each row
					for (let i = 0; i < actualResult.length; i++) {
						try {
							expect(normalizeBigInts(actualResult[i])).to.deep.equal(expectedResult[i], `[${file}:${lineNum}] row ${i} mismatch.\nActual: ${safeJsonStringify(actualResult[i])}\nExpected: ${safeJsonStringify(expectedResult[i])}\nBlock:\n${sqlBlock}`);
						} catch (matchError: any) {
							const error = matchError instanceof Error ? matchError : new Error(String(matchError));
							const diagnostics = generateDiagnostics(db, sqlBlock, error);
							const traceInfo = TEST_OPTIONS.showTrace ? `\nEXECUTION TRACE:\n${formatTraceEvents(executionResult.traceEvents)}` : '';
							throw new Error(`${error.message}${diagnostics}${traceInfo}`);
						}
					}

					if (TEST_OPTIONS.verbose) {
						console.log("   -> Results match!");
					}
				};

				/**
				 * Executes SQL without expecting specific results or errors (for setup)
				 */
				const executeSetup = async (sqlBlock: string, lineNum: number) => {
					if (TEST_OPTIONS.verbose) {
						console.log(`Executing setup block:\n${sqlBlock}`);
					}

					try {
						await db.exec(sqlBlock);
						if (TEST_OPTIONS.verbose) {
							console.log("   -> Setup completed successfully");
						}
					} catch (error: any) {
						let errorMessage = `[${file}:${lineNum}] Failed executing setup SQL: ${sqlBlock} - Error: ${error.message}`;

						// Add location information if available
						const locationInfo = formatLocationInfo(error, sqlBlock);
						if (locationInfo) {
							errorMessage += locationInfo;
						}

						const baseError = new Error(errorMessage);
						const diagnostics = generateDiagnostics(db, sqlBlock, error);
						throw new Error(`${baseError.message}${diagnostics}`);
					}
				};

				for (const line of lines) {
					lineNumber++;
					const trimmedLine = line.trim();

					if (trimmedLine === '') continue; // Skip empty lines

					// Handle comment lines
					if (trimmedLine.startsWith('--')) {
						if (trimmedLine.toLowerCase().startsWith('-- error:')) {
							// Set error expectation and execute immediately
							expectedErrorSubstring = trimmedLine.substring(9).trim();

							if (currentSql.trim()) {
								await executeExpectingError(currentSql.trim(), expectedErrorSubstring, lineNumber);
								resetState();
							}
						} else if (trimmedLine.toLowerCase().startsWith('-- params:')) {
							// Set bind parameters for the next query
							const paramsJson = trimmedLine.substring(10).trim();
							try {
								currentParams = JSON.parse(paramsJson);
							} catch (jsonError: any) {
								throw new Error(`[${file}:${lineNumber}] Invalid params JSON: ${jsonError.message} - JSON: ${paramsJson}`);
							}
						} else if (trimmedLine.toLowerCase() === '-- run') {
							// Run accumulated SQL as setup immediately
							if (currentSql.trim()) {
								await executeSetup(currentSql.trim(), lineNumber);
								resetState();
							}
						}
						continue; // Skip all comment lines
					}

					// Handle result marker
					if (trimmedLine.startsWith('→')) {
						expectedResultJson = trimmedLine.substring(1).trim();

						// Execute immediately with result expectation
						if (currentSql.trim()) {
							await executeExpectingResults(currentSql.trim(), expectedResultJson, lineNumber, currentParams);
							resetState();
						}
						continue; // Don't add to SQL
					}

					// Process SQL line
					let sqlPart = line;

					// Strip trailing comment from the SQL part
					const commentIndex = sqlPart.indexOf('--');
					if (commentIndex !== -1) {
						sqlPart = sqlPart.substring(0, commentIndex);
					}

					// Accumulate SQL
					if (sqlPart.trim() !== '') {
						currentSql += sqlPart + '\n';
					}
				}

				// Process any remaining SQL at the end of the file (treat as setup)
				if (currentSql.trim()) {
					await executeSetup(currentSql.trim(), lineNumber);
				}
			});
		});
	}
});
