/**
 * A provider-declared first-row latency (`KVStoreProvider.expectedLatencyMs`) has to reach
 * the query planner.
 *
 * The engine has always had one number a storage module can use to say "I am slow to answer"
 * — `VirtualTableModule.expectedLatencyMs`, defined as FIRST-ROW latency: how long an
 * iterator opened over one of the module's tables takes to hand back its first row.
 * `StoreModule` never declared it and `KVStoreProvider` had no field a backend could declare
 * it THROUGH, so a provider over a network-backed key-value store — exactly the case the
 * planner's latency machinery exists for — could not tell the planner anything at all.
 *
 * Three properties are pinned here:
 *
 *  1. **A provider that declares nothing resolves to `0`,** which is observably identical to
 *     omitting the hint. Every other spec in this package runs on such a provider, so drift
 *     here would be a silent re-baseline rather than a finding.
 *  2. **A declared value reaches an actual PLANNER DECISION,** not merely the module field:
 *     the join below becomes the batched one-branch fan-out when the provider declares 30 ms
 *     and stays the serial index-nested-loop when it declares nothing. Asserting both
 *     directions is what makes this a regression guard rather than a snapshot.
 *  3. **A malformed third-party declaration degrades to `0`, loudly** — same discipline as
 *     `resolveCostProfile` (see `cost-profile.spec.ts`), with one deliberate difference:
 *     `0` is a VALID latency, so only negative and non-finite values are rejected.
 *
 * The 30 ms is frankly synthetic and no in-tree backend declares anything (see the store
 * README, § Backend cost profile). It is chosen to clear the planner's latency gates, all of
 * which sit at 25 ms — `tuning.parallel.batchedOuterThresholdMs` and neighbours. Fixing a
 * real backend's number is a separate question this test deliberately does not depend on.
 *
 * Plan shape is read through the package's public `serializePlanTree`, because the node
 * classes themselves (`FanOutLookupJoinNode`, `EagerPrefetchNode`) are engine-internal and
 * not exported — so an `instanceof` assertion like the engine's own
 * `test/optimizer/index-nested-loop-batched.spec.ts` uses is not available from here.
 */

import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import { Database, serializePlanTree } from '@quereus/quereus';
import { StoreModule, resolveExpectedLatencyMs, type KVStoreProvider } from '../src/index.js';
import { createInMemoryProvider } from '../src/testing/index.js';

/** Above every 25 ms latency gate in `optimizer-tuning.ts`, and nothing more than that. */
const HIGH_LATENCY_MS = 30;

/**
 * An in-memory provider declaring `expectedLatencyMs` (or nothing, when omitted).
 *
 * Spread rather than assigned, so the "declares nothing" provider has NO such property at
 * all — the shape a pre-latency third-party provider has, and the one `resolveExpectedLatencyMs`
 * routes down its default path.
 */
function providerDeclaring(latencyMs?: number): KVStoreProvider {
	const base = createInMemoryProvider();
	return { ...base, ...(latencyMs === undefined ? {} : { expectedLatencyMs: latencyMs }) };
}

/** One node of the tree `serializePlanTree` emits — only the fields these assertions read. */
interface PlanNodeInfo {
	readonly id: string;
	readonly nodeType: string;
	readonly properties: Record<string, unknown>;
	readonly children: PlanNodeInfo[];
	readonly relations: PlanNodeInfo[];
}

/**
 * Every DISTINCT node of `sql`'s optimized plan whose type is `nodeType`.
 *
 * Deduped by `id`: `serializePlanTree` lists a relational child under BOTH `children` and
 * `relations`, so a naive walk reports one fan-out several times over.
 */
function nodesOfType(db: Database, sql: string, nodeType: string): PlanNodeInfo[] {
	const root = JSON.parse(serializePlanTree(db.getPlan(sql))) as PlanNodeInfo;
	const found = new Map<string, PlanNodeInfo>();
	const seen = new Set<string>();
	const walk = (n: PlanNodeInfo): void => {
		if (seen.has(n.id)) return;
		seen.add(n.id);
		if (n.nodeType === nodeType) found.set(n.id, n);
		for (const c of [...(n.children ?? []), ...(n.relations ?? [])]) walk(c);
	};
	walk(root);
	return [...found.values()];
}

describe('provider-declared first-row latency', () => {
	describe('resolution', () => {
		it('takes a declared value through to the module', () => {
			expect(new StoreModule(providerDeclaring(HIGH_LATENCY_MS)).expectedLatencyMs).to.equal(HIGH_LATENCY_MS);
		});

		it('resolves an undeclared provider to 0', () => {
			expect(new StoreModule(providerDeclaring()).expectedLatencyMs).to.equal(0);
		});

		it('accepts a declared 0 — unlike a cost field, 0 is a valid latency', () => {
			expect(resolveExpectedLatencyMs(0)).to.equal(0);
		});

		it('degrades a negative or non-finite declaration to 0, with a warning', () => {
			const warnings: string[] = [];
			const realWarn = console.warn;
			console.warn = (...args: unknown[]) => { warnings.push(args.join(' ')); };
			try {
				expect(new StoreModule(providerDeclaring(-1)).expectedLatencyMs).to.equal(0);
				expect(new StoreModule(providerDeclaring(Number.NaN)).expectedLatencyMs).to.equal(0);
				expect(new StoreModule(providerDeclaring(Number.POSITIVE_INFINITY)).expectedLatencyMs).to.equal(0);
			} finally {
				console.warn = realWarn;
			}
			expect(warnings, 'each bad declaration warned once, at construction').to.have.lengthOf(3);
			for (const w of warnings) expect(w).to.contain('expectedLatencyMs');
		});
	});

	describe('reaching the planner', () => {
		/**
		 * Outer `s` (4 rows, one NULL key, one key matching nothing) on the memory module,
		 * joined to a `StoreModule` inner over `provider`. Mirrors the fixture in the
		 * engine's `test/optimizer/index-nested-loop-batched.spec.ts`, including its
		 * `batchedOuterMinRows: 0` — a four-row synthetic outer clears nothing at the 256-row
		 * default, and the cardinality gate is not what this file is testing.
		 */
		async function planJoinOver(provider: KVStoreProvider): Promise<Database> {
			const db = new Database();
			db.registerModule('store', new StoreModule(provider));
			const before = db.optimizer.tuning;
			db.optimizer.updateTuning({
				...before,
				parallel: { ...before.parallel, batchedOuterMinRows: 0 },
			});
			await db.exec('create table s (id integer primary key, k integer null)');
			await db.exec('insert into s values (1, 5), (2, 7), (3, 999), (4, null)');
			await db.exec('create table big (id integer primary key, w integer) using store');
			const rows: string[] = [];
			for (let i = 1; i <= 200; i++) rows.push(`(${i}, ${i % 10})`);
			await db.exec(`insert into big values ${rows.join(', ')}`);
			for await (const _ of db.eval('analyze')) { /* consume */ }
			return db;
		}

		const SQL = 'select s.id, big.w from s join big on big.id = s.k order by s.id';

		let db: Database | undefined;

		beforeEach(() => { db = undefined; });
		afterEach(async () => { if (db) await db.close(); });

		it('plans the join as a batched fan-out when the provider declares 30 ms', async () => {
			db = await planJoinOver(providerDeclaring(HIGH_LATENCY_MS));
			const fanouts = nodesOfType(db, SQL, 'FanOutLookupJoin');
			expect(fanouts, 'exactly one fan-out').to.have.lengthOf(1);
			expect(fanouts[0].properties.outerMode).to.equal('batched');
			expect(nodesOfType(db, SQL, 'EagerPrefetch'), 'batched implies a prefetched outer').to.have.lengthOf(1);
		});

		it('leaves the same join alone when the provider declares nothing', async () => {
			db = await planJoinOver(providerDeclaring());
			expect(nodesOfType(db, SQL, 'FanOutLookupJoin'), 'no fan-out at zero latency').to.have.lengthOf(0);
			expect(nodesOfType(db, SQL, 'EagerPrefetch')).to.have.lengthOf(0);
		});
	});
});
