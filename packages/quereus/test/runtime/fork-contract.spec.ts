import { expect } from 'chai';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, posix, relative, sep } from 'node:path';
import { ParallelDriver } from '../../src/runtime/parallel-driver.js';
import { createRowSlot, resolveAttribute } from '../../src/runtime/context-helpers.js';
import { createStrictRowContextMap, wrapTableContextsStrict } from '../../src/runtime/strict-fork.js';
import type { RuntimeContext } from '../../src/runtime/types.js';
import type { RowDescriptor } from '../../src/planner/nodes/plan-node.js';
import type { Row } from '../../src/common/types.js';

// Project layout: this spec lives at packages/quereus/test/runtime/. Source we
// audit lives at packages/quereus/src/. Resolve via import.meta.url so the test
// is independent of process.cwd().
const __dirname = dirname(fileURLToPath(import.meta.url));
const QUEREUS_PKG_ROOT = join(__dirname, '..', '..');
const SRC_ROOT = join(QUEREUS_PKG_ROOT, 'src');

/**
 * Fork policy for each field of {@link RuntimeContext}. New fields force a
 * compile error here (via the `satisfies` clause) so the author must declare
 * a policy before the field can ship.
 *
 * Policies:
 *   - 'forked'             — `ParallelDriver.fork()` must produce an independent
 *                            per-branch view (snapshot of parent at fork time).
 *   - 'shared-frozen'      — shared by reference; treat as immutable for fork lifetime.
 *   - 'shared-sink'        — shared write-only instrumentation (tracer, planStack, etc).
 *   - 'shared-cooperative' — shared but mutation across branches is the caller's
 *                            responsibility (e.g. vtab `concurrencyMode`).
 */
type ForkPolicy = 'forked' | 'shared-frozen' | 'shared-sink' | 'shared-cooperative';

const EXPECTED_FORK_POLICY = {
	db: 'shared-frozen',
	stmt: 'shared-frozen',
	params: 'shared-frozen',
	context: 'forked',
	tableContexts: 'forked',
	tracer: 'shared-sink',
	activeConnection: 'shared-cooperative',
	enableMetrics: 'shared-frozen',
	// Per-row INSERT/envelope ordinal: set+restored synchronously by the sequential
	// insert path, never mutated inside a parallel fork — each child snapshots it.
	mutationOrdinal: 'shared-frozen',
	// Cooperative cancellation signal: shared by reference so every branch honors the
	// same abort; the runtime only ever reads it (never mutates), so it is frozen.
	signal: 'shared-frozen',
	contextTracker: 'shared-sink',
	planStack: 'shared-sink',
	// Once-per-execution memo for impure subqueries: shared by reference so the
	// run-once contract spans branches (matching the pre-cache single-closure memo).
	// Mutation across branches is the impure-subquery contract's responsibility.
	executionMemo: 'shared-cooperative',
	// Once-per-execution inner-scan connection cache: shared by reference so the
	// statement teardown disconnects every instance connected across branches exactly
	// once. Mutation across branches is the scan lifecycle's responsibility.
	scanConnections: 'shared-cooperative',
	// Once-per-execution CacheNode row-cache map: shared by reference so a cache
	// materialized in one branch is visible to a sibling branch re-driving the same
	// cache site within the same execution. Mutation across branches is the
	// CacheNode emitter's responsibility.
	cacheStates: 'shared-cooperative',
	// Once-per-execution shared CTE materialization buffer map: shared by reference
	// so a CTE buffered in one branch replays in a sibling branch instead of
	// re-driving the source. Mutation across branches is the emitCTE contract's
	// responsibility.
	cteMaterializations: 'shared-cooperative',
	// Once-per-execution uncorrelated IN-subquery lookup-set map: shared by reference
	// so a set materialized in one branch is visible to a sibling branch re-driving
	// the same IN site within the same execution. Mutation across branches is the
	// emitIn set-probe contract's responsibility.
	inSetProbes: 'shared-cooperative',
} as const satisfies Record<keyof RuntimeContext, ForkPolicy>;

/**
 * Files allowed to call `tableContexts.set(` / `tableContexts.delete(` on a
 * RuntimeContext. Any new site must be added here deliberately after reading
 * docs/runtime.md § Parallel runtime fork contract — parent mutation while
 * forks are alive is a contract violation.
 *
 * Excludes construction sites (`new Map()` / `new Map(rctx.tableContexts)`)
 * which the regex does not match.
 *
 * Paths are normalized to forward-slash relative-to-package-root for portability.
 */
const TABLE_CONTEXTS_MUTATION_ALLOWLIST = new Set<string>([
	'src/runtime/emit/recursive-cte.ts',
	// Multi-source view INSERT: stashes the shared-surrogate envelope rows under a
	// unique descriptor before driving the base ops, deletes it in `finally`. Same
	// working-table pattern as recursive-cte, and `tableContexts` is `forked` (each
	// fork owns its copy), so the unique-key add/remove never perturbs a sibling.
	'src/runtime/emit/view-mutation.ts',
]);

/**
 * Files allowed to call `context.set(` / `context.delete(` on a RuntimeContext.
 * Other consumers should use `createRowSlot` / `withRowContext` / `withAsyncRowContext`.
 * The aggregate/window emitters mutate directly for performance and predate the
 * helpers — see runtime.md § Parallel runtime fork contract.
 */
const ROW_CONTEXT_MUTATION_ALLOWLIST = new Set<string>([
	'src/runtime/context-helpers.ts',
	'src/runtime/emit/aggregate.ts',
	'src/runtime/emit/hash-aggregate.ts',
	'src/runtime/emit/window.ts',
]);

function toPosix(p: string): string {
	return p.split(sep).join(posix.sep);
}

function walkTsFiles(root: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(root)) {
		const full = join(root, entry);
		const st = statSync(full);
		if (st.isDirectory()) {
			out.push(...walkTsFiles(full));
		} else if (st.isFile() && entry.endsWith('.ts') && !entry.endsWith('.d.ts')) {
			out.push(full);
		}
	}
	return out;
}

function findMatchingFiles(pattern: RegExp): Set<string> {
	const matched = new Set<string>();
	for (const file of walkTsFiles(SRC_ROOT)) {
		const text = readFileSync(file, 'utf8');
		if (pattern.test(text)) {
			matched.add(toPosix(relative(QUEREUS_PKG_ROOT, file)));
		}
	}
	return matched;
}

function makeRuntimeContext(): RuntimeContext {
	// Use the strict-fork-aware factories so the parent matches what production
	// construction sites build. In non-strict mode these collapse to plain
	// `new RowContextMap()` / `new Map()`.
	return {
		db: undefined as unknown as RuntimeContext['db'],
		stmt: undefined,
		params: {},
		context: createStrictRowContextMap(),
		tableContexts: wrapTableContextsStrict(new Map()),
		enableMetrics: false,
		// Non-undefined sentinel so the 'shared-frozen' aliasing assertion is meaningful.
		mutationOrdinal: 0,
	};
}

describe('Fork contract (test harness)', () => {
	describe('pinned-keys drift', () => {
		it('every RuntimeContext field has a declared fork policy', () => {
			// Use a forked RuntimeContext as the source of truth — the driver explicitly
			// enumerates every field, so anything missing from the fork is also missing
			// from EXPECTED_FORK_POLICY.
			const driver = new ParallelDriver();
			const [fork] = driver.fork(makeRuntimeContext(), 1);
			const declared = new Set(Object.keys(EXPECTED_FORK_POLICY));
			const present = new Set(Object.keys(fork));

			const missing = [...present].filter(k => !declared.has(k));
			const extra = [...declared].filter(k => !present.has(k));

			expect(missing, `RuntimeContext fields without a declared fork policy: ${missing.join(', ')}. ` +
				`Add to EXPECTED_FORK_POLICY in test/runtime/fork-contract.spec.ts after reading ` +
				`docs/runtime.md § Parallel runtime fork contract.`).to.deep.equal([]);
			expect(extra, `EXPECTED_FORK_POLICY declares fields that no longer exist on RuntimeContext: ${extra.join(', ')}`)
				.to.deep.equal([]);
		});

		it('forked fields are independent across siblings and parent', () => {
			// Sanity check: every field declared 'forked' actually is.
			const driver = new ParallelDriver();
			const parent = makeRuntimeContext();
			const [a, b] = driver.fork(parent, 2);

			for (const [key, policy] of Object.entries(EXPECTED_FORK_POLICY)) {
				if (policy !== 'forked') continue;
				const k = key as keyof RuntimeContext;
				expect(a[k], `fork[0].${key} must differ from parent`).to.not.equal(parent[k]);
				expect(b[k], `fork[1].${key} must differ from parent`).to.not.equal(parent[k]);
				expect(a[k], `fork[0].${key} must differ from fork[1].${key}`).to.not.equal(b[k]);
			}
		});

		it('shared fields are aliased to parent', () => {
			const driver = new ParallelDriver();
			const parent = makeRuntimeContext();
			// Populate every shared field with a distinct, non-undefined sentinel so
			// the identity assertion below is non-trivial (undefined === undefined
			// passes vacuously and would mask a broken fork() copy).
			parent.db = {} as unknown as RuntimeContext['db'];
			parent.stmt = {} as unknown as RuntimeContext['stmt'];
			parent.params = { 1: 99 };
			parent.tracer = {} as unknown as RuntimeContext['tracer'];
			parent.activeConnection = {} as unknown as RuntimeContext['activeConnection'];
			parent.contextTracker = {} as unknown as RuntimeContext['contextTracker'];
			parent.planStack = [];
			parent.signal = new AbortController().signal;
			parent.executionMemo = new Map();
			parent.scanConnections = new Map();
			parent.cacheStates = new Map();
			parent.cteMaterializations = new Map();
			parent.inSetProbes = new Map();

			const [fork] = driver.fork(parent, 1);

			for (const [key, policy] of Object.entries(EXPECTED_FORK_POLICY)) {
				if (policy === 'forked') continue;
				const k = key as keyof RuntimeContext;
				expect(parent[k], `parent.${key} sentinel must be non-undefined for a meaningful identity check`).to.not.equal(undefined);
				expect(fork[k], `fork.${key} (${policy}) must alias parent`).to.equal(parent[k]);
			}
		});
	});

	describe('mutation-site allowlist', () => {
		it('tableContexts.set/delete/clear is only called from approved files', () => {
			// Match `<identifier>.tableContexts.set(` / `.delete(` / `.clear(`. The
			// leading identifier (rctx / ctx / runtimeCtx / etc) prevents false
			// positives on unrelated `tableContexts` symbols. `clear` is included
			// so a new `tableContexts.clear()` site can't slip past the static check.
			const pattern = /\b[A-Za-z_][\w$]*\.tableContexts\.(?:set|delete|clear)\(/;
			const found = findMatchingFiles(pattern);

			const unexpected = [...found].filter(f => !TABLE_CONTEXTS_MUTATION_ALLOWLIST.has(f));
			expect(unexpected,
				`Files mutating RuntimeContext.tableContexts outside the allowlist: ${unexpected.join(', ')}. ` +
				`If this is a legitimate emit site, add it to TABLE_CONTEXTS_MUTATION_ALLOWLIST ` +
				`after reading docs/runtime.md § Parallel runtime fork contract — mutating the ` +
				`parent map while forks are alive is a contract violation.`,
			).to.deep.equal([]);

			const dead = [...TABLE_CONTEXTS_MUTATION_ALLOWLIST].filter(f => !found.has(f));
			expect(dead, `Stale entries in TABLE_CONTEXTS_MUTATION_ALLOWLIST: ${dead.join(', ')}`).to.deep.equal([]);
		});

		it('RowContextMap.set/delete/clear on RuntimeContext is only called from approved files', () => {
			// Two-step match: file must reference RuntimeContext mutations of `.context.`
			// (not the unrelated planner OptimizationContext.context). Restricting to
			// `runtime/` directory is the practical scope filter — runtime-context
			// receivers there are universally named `rctx` or `ctx` (convention; if a
			// future contributor introduces a different receiver name, they must
			// extend this alternation or rename to one of the listed forms).
			// `clear` is included to keep parity with the strict-fork mode guard.
			const pattern = /\b(?:rctx|ctx|runtimeCtx|runtimeContext)\.context\.(?:set|delete|clear)\(/;
			const found = findMatchingFiles(pattern);

			// Filter to runtime sources only — the planner has its own Map<string,unknown>
			// also called `context`, accessed via `this.context` (a different shape and
			// concept). The receiver-name regex above already excludes `this.`, but
			// scoping reinforces the intent.
			const runtimeFound = new Set([...found].filter(f => f.startsWith('src/runtime/')));

			const unexpected = [...runtimeFound].filter(f => !ROW_CONTEXT_MUTATION_ALLOWLIST.has(f));
			expect(unexpected,
				`Files mutating RuntimeContext.context outside the allowlist: ${unexpected.join(', ')}. ` +
				`Prefer createRowSlot / withRowContext / withAsyncRowContext. If direct mutation ` +
				`is required, add to ROW_CONTEXT_MUTATION_ALLOWLIST after reading docs/runtime.md ` +
				`§ Parallel runtime fork contract.`,
			).to.deep.equal([]);

			const dead = [...ROW_CONTEXT_MUTATION_ALLOWLIST].filter(f => !runtimeFound.has(f));
			expect(dead, `Stale entries in ROW_CONTEXT_MUTATION_ALLOWLIST: ${dead.join(', ')}`).to.deep.equal([]);
		});
	});

	describe('strict-fork mode (QUEREUS_FORK_STRICT)', () => {
		const strictMode = process.env.QUEREUS_FORK_STRICT === '1' || process.env.QUEREUS_FORK_STRICT === 'true';

		it('throws when the parent mutates tableContexts while forks are active', function () {
			if (!strictMode) {
				this.skip();
				return;
			}

			const driver = new ParallelDriver();
			const parent = makeRuntimeContext();

			const factories: ReadonlyArray<(ctx: RuntimeContext) => AsyncIterable<Row>> = [
				async function* (_ctx) {
					// Yield once so the consumer can interleave a parent mutation.
					yield [0] as Row;
					yield [1] as Row;
				},
			];
			const forks = driver.fork(parent, 1);

			return (async () => {
				let caught: unknown = undefined;
				try {
					const iter = driver.drive(factories, forks);
					for await (const _ of iter) {
						// At this point fork is live; mutate the parent's tableContexts.
						// Strict mode should throw on the next mutation, propagating out
						// of the drive() generator.
						parent.tableContexts.set({} as never, () => undefined as never);
					}
				} catch (e) {
					caught = e;
				}
				expect(caught, 'strict-fork should reject parent mutation while forks are active').to.not.equal(undefined);
				expect(String((caught as Error)?.message ?? caught))
					.to.match(/strict-fork/i);
			})();
		});

		it('throws when the parent mutates context (RowContextMap) while forks are active', function () {
			if (!strictMode) {
				this.skip();
				return;
			}

			const driver = new ParallelDriver();
			const parent = makeRuntimeContext();

			const factories: ReadonlyArray<(ctx: RuntimeContext) => AsyncIterable<Row>> = [
				async function* (_ctx) {
					yield [0] as Row;
					yield [1] as Row;
				},
			];
			const forks = driver.fork(parent, 1);

			const attrId = 999;
			const descriptor: RowDescriptor = [];
			descriptor[attrId] = 0;

			return (async () => {
				let caught: unknown = undefined;
				try {
					const iter = driver.drive(factories, forks);
					for await (const _ of iter) {
						// Mutate the parent's row context while a fork is live.
						createRowSlot(parent, descriptor);
					}
				} catch (e) {
					caught = e;
				}
				expect(caught, 'strict-fork should reject parent context mutation while forks are active').to.not.equal(undefined);
				expect(String((caught as Error)?.message ?? caught))
					.to.match(/strict-fork/i);
			})();
		});

		it('allows mutation inside a fork (siblings unaffected)', function () {
			if (!strictMode) {
				this.skip();
				return;
			}

			const driver = new ParallelDriver();
			const parent = makeRuntimeContext();

			const attrId = 1001;
			const descriptor: RowDescriptor = [];
			descriptor[attrId] = 0;

			const factories: ReadonlyArray<(ctx: RuntimeContext) => AsyncIterable<Row>> = [
				async function* (ctx) {
					// Mutate within the fork — should not throw under strict mode.
					const slot = createRowSlot(ctx, descriptor);
					try {
						slot.set(['a'] as unknown as Row);
						yield [0] as Row;
					} finally {
						slot.close();
					}
				},
				async function* (ctx) {
					const slot = createRowSlot(ctx, descriptor);
					try {
						slot.set(['b'] as unknown as Row);
						yield [1] as Row;
					} finally {
						slot.close();
					}
				},
			];
			const forks = driver.fork(parent, 2);

			return (async () => {
				const out: number[] = [];
				for await (const item of driver.drive(factories, forks)) {
					out.push(item.branch);
				}
				expect(out.sort()).to.deep.equal([0, 1]);
			})();
		});

		it('allows mutation after all forks complete', function () {
			if (!strictMode) {
				this.skip();
				return;
			}

			const driver = new ParallelDriver();
			const parent = makeRuntimeContext();

			const factories: ReadonlyArray<(ctx: RuntimeContext) => AsyncIterable<Row>> = [
				async function* (_ctx) { yield [0] as Row; },
			];
			const forks = driver.fork(parent, 1);

			return (async () => {
				// Drain to completion before mutating.
				for await (const _ of driver.drive(factories, forks)) { /* drain */ }

				// activeForks should be 0 again; mutation should be allowed.
				expect(() => {
					parent.tableContexts.set({} as never, () => undefined as never);
				}).to.not.throw();
			})();
		});
	});

	describe('context-strict mode (QUEREUS_CONTEXT_STRICT)', () => {
		const contextStrict = process.env.QUEREUS_CONTEXT_STRICT === '1' || process.env.QUEREUS_CONTEXT_STRICT === 'true';
		const forkStrict = process.env.QUEREUS_FORK_STRICT === '1' || process.env.QUEREUS_FORK_STRICT === 'true';

		it('createStrictRowContextMap returns a plain RowContextMap (no shadow hooks) when both strict flags are off', function () {
			if (contextStrict || forkStrict) {
				this.skip();
				return;
			}
			const map = createStrictRowContextMap();
			expect(map.assertNoShadow, 'base map must not carry the shadow hook when flags are off').to.equal(undefined);
			expect(map.noteRowSet, 'base map must not carry noteRowSet when flags are off').to.equal(undefined);
		});

		it('throws context-strict on a deliberate stale-shadow (operator wins index, child sets a newer row)', function () {
			if (!contextStrict) {
				this.skip();
				return;
			}
			const rctx = makeRuntimeContext();
			const attrId = 700;
			// Two distinct descriptors over the SAME attribute id (operator + child both
			// project source attr 700 at column 0).
			const opDesc: RowDescriptor = [];
			opDesc[attrId] = 0;
			const childDesc: RowDescriptor = [];
			childDesc[attrId] = 0;

			const opSlot = createRowSlot(rctx, opDesc, 'operator');
			opSlot.set([111] as unknown as Row);
			const childSlot = createRowSlot(rctx, childDesc, 'child-scan');
			childSlot.set([222] as unknown as Row);

			// Operator re-wins the attribute index for its stale row (as if it re-set its
			// source-attr context) but then FORGETS to release it before the child advances.
			opSlot.reactivate();
			childSlot.set([333] as unknown as Row); // child's genuinely-newer row, index NOT reclaimed

			// A read here would silently resolve to the operator's stale 111 instead of 333.
			expect(() => resolveAttribute(rctx, attrId, 'x')).to.throw(/context-strict:/);
		});

		it('does NOT throw for correct tear-down (operator deletes its context before the child advances)', function () {
			if (!contextStrict) {
				this.skip();
				return;
			}
			const rctx = makeRuntimeContext();
			const attrId = 710;
			const opDesc: RowDescriptor = [];
			opDesc[attrId] = 0;
			const childDesc: RowDescriptor = [];
			childDesc[attrId] = 0;

			const opSlot = createRowSlot(rctx, opDesc, 'operator');
			opSlot.set([1] as unknown as Row);
			const childSlot = createRowSlot(rctx, childDesc, 'child-scan');
			childSlot.set([2] as unknown as Row);

			// Correct discipline: operator releases its source-attr context (tear-down)
			// BEFORE the child produces its next row. The index winner rebuilds to the child.
			opSlot.close();
			childSlot.set([3] as unknown as Row);

			expect(() => resolveAttribute(rctx, attrId, 'y')).to.not.throw();
			expect(resolveAttribute(rctx, attrId, 'y'), 'read resolves to the child current row').to.equal(3);
		});

		it('does NOT throw for correct reactivate (operator re-wins the index and stays newest)', function () {
			if (!contextStrict) {
				this.skip();
				return;
			}
			const rctx = makeRuntimeContext();
			const attrId = 720;
			const opDesc: RowDescriptor = [];
			opDesc[attrId] = 0;
			const childDesc: RowDescriptor = [];
			childDesc[attrId] = 0;

			const opSlot = createRowSlot(rctx, opDesc, 'operator');
			opSlot.set([10] as unknown as Row);
			const childSlot = createRowSlot(rctx, childDesc, 'child-scan');
			childSlot.set([20] as unknown as Row); // child's look-ahead cursor

			// Correct reactivate-before-yield: operator re-wins the index AND is now newest.
			opSlot.reactivate();

			expect(() => resolveAttribute(rctx, attrId, 'z')).to.not.throw();
			expect(resolveAttribute(rctx, attrId, 'z'), 'read resolves to the operator row').to.equal(10);
		});

		it('does NOT throw when two live descriptors share an attr but hold the SAME row object', function () {
			if (!contextStrict) {
				this.skip();
				return;
			}
			const rctx = makeRuntimeContext();
			const attrId = 730;
			const opDesc: RowDescriptor = [];
			opDesc[attrId] = 0;
			const childDesc: RowDescriptor = [];
			childDesc[attrId] = 0;

			const sharedRow = [42] as unknown as Row;
			const childSlot = createRowSlot(rctx, childDesc, 'child-scan');
			childSlot.set(sharedRow);
			const opSlot = createRowSlot(rctx, opDesc, 'operator');
			opSlot.set(sharedRow); // operator wins the index (set last), holds the same peeked row

			// Child re-touches the same object, bumping its epoch above the winner —
			// but the row object is identical (asof-style left slot mirroring the peek).
			childSlot.set(sharedRow);

			// No observable wrong-row: both descriptors resolve to the identical array.
			expect(() => resolveAttribute(rctx, attrId, 'w')).to.not.throw();
		});
	});
});
