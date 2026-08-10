import { expect } from 'chai';
import type { SqlValue } from '../../src/common/types.js';
import {
	DeltaExecutor,
	type DeltaApplyInput,
	type DeltaExecutorContext,
	type DeltaSubscription,
} from '../../src/runtime/delta-executor.js';
import type { BindingMode } from '../../src/planner/analysis/binding-extractor.js';

/**
 * Minimal mock context for the DeltaExecutor — exercises the kernel in
 * isolation from the full TransactionManager / planner stack.
 */
class MockCtx implements DeltaExecutorContext {
	deltaPerRowFallbackRatio = 0.5;
	changed = new Map<string, SqlValue[][]>(); // base → projected tuples (already shape-matching the request)
	rowCounts = new Map<string, number>();

	setChanged(base: string, tuples: SqlValue[][]): void {
		this.changed.set(base.toLowerCase(), tuples);
	}

	getChangedBaseTables(): Set<string> {
		return new Set(this.changed.keys());
	}

	getChangedTuples(base: string, _columnIndices: readonly number[], _pkIndices: readonly number[]): SqlValue[][] {
		return this.changed.get(base.toLowerCase()) ?? [];
	}

	getRowCount(base: string): number | undefined {
		return this.rowCounts.get(base.toLowerCase());
	}

	globallyChanged = new Set<string>();
	isGloballyChanged(base: string): boolean {
		return this.globallyChanged.has(base.toLowerCase());
	}
}

interface RecordedCall {
	id: string;
	perRelation: Array<[string, SqlValue[][]]>;
	global: string[];
}

function makeSub(opts: {
	id: string;
	dependencies: string[];
	bindings: Array<[string /* relKey */, BindingMode]>;
	relationToBase: Array<[string, string]>;
	pkIndicesByBase: Array<[string, number[]]>;
	apply?: (input: DeltaApplyInput) => Promise<void>;
}): DeltaSubscription {
	return {
		id: opts.id,
		dependencies: new Set(opts.dependencies),
		bindings: new Map(opts.bindings),
		relationToBase: new Map(opts.relationToBase),
		pkIndicesByBase: new Map(opts.pkIndicesByBase),
		apply: opts.apply ?? (async () => {}),
		dispose: () => {},
	};
}

function record(calls: RecordedCall[], id: string): (input: DeltaApplyInput) => Promise<void> {
	return async (input: DeltaApplyInput) => {
		const perRelation: Array<[string, SqlValue[][]]> = [];
		for (const [k, tuples] of input.perRelationTuples) {
			perRelation.push([k, tuples.map(t => [...t])]);
		}
		calls.push({ id, perRelation, global: [...input.globalRelations] });
	};
}

describe('DeltaExecutor: dispatch semantics', () => {
	it("dispatches 'row' bindings with per-tuple batches", async () => {
		const ctx = new MockCtx();
		ctx.setChanged('main.t', [[1], [2], [3]]);
		const exec = new DeltaExecutor(ctx);
		const calls: RecordedCall[] = [];
		const sub = makeSub({
			id: 'sub1',
			dependencies: ['main.t'],
			bindings: [['main.t#1', { kind: 'row', keyColumns: [0] }]],
			relationToBase: [['main.t#1', 'main.t']],
			pkIndicesByBase: [['main.t', [0]]],
			apply: record(calls, 'sub1'),
		});
		exec.register(sub);
		await exec.runAll();
		expect(calls).to.have.length(1);
		expect(calls[0].perRelation).to.have.length(1);
		expect(calls[0].perRelation[0][0]).to.equal('main.t#1');
		expect(calls[0].perRelation[0][1]).to.deep.equal([[1], [2], [3]]);
		expect(calls[0].global).to.deep.equal([]);
	});

	it("demotes an empty-key 'row' binding to global re-evaluation", async () => {
		// A `{ kind: 'row', keyColumns: [] }` binding marks a provably ≤1-row
		// reference. There are no key columns to fetch per-tuple, so the executor
		// re-evaluates the relation globally (sound: scanning a ≤1-row table whole
		// equals seeking its single row). getChangedTuples is never consulted.
		const ctx = new MockCtx();
		ctx.setChanged('main.t', [[1], [2]]);
		let fetched = false;
		const origFetch = ctx.getChangedTuples.bind(ctx);
		ctx.getChangedTuples = (base, cols, pk) => { fetched = true; return origFetch(base, cols, pk); };
		const exec = new DeltaExecutor(ctx);
		const calls: RecordedCall[] = [];
		const sub = makeSub({
			id: 'sub1',
			dependencies: ['main.t'],
			bindings: [['main.t#1', { kind: 'row', keyColumns: [] }]],
			relationToBase: [['main.t#1', 'main.t']],
			pkIndicesByBase: [['main.t', [0]]],
			apply: record(calls, 'sub1'),
		});
		exec.register(sub);
		await exec.runAll();
		expect(calls).to.have.length(1);
		expect(calls[0].perRelation).to.deep.equal([]);
		expect(calls[0].global).to.deep.equal(['main.t#1']);
		expect(fetched).to.equal(false);
	});

	it("dispatches 'group' bindings with de-duplicated tuples", async () => {
		const ctx = new MockCtx();
		// Caller-shape tuples: getChangedTuples already de-dupes in the real
		// TransactionManager; here we pass duplicates and confirm the executor
		// forwards them verbatim (de-dup is the manager's job, kernel only
		// computes ratio against them).
		ctx.setChanged('main.t', [[10], [20], [10]]);
		const exec = new DeltaExecutor(ctx);
		const calls: RecordedCall[] = [];
		const sub = makeSub({
			id: 'sub1',
			dependencies: ['main.t'],
			bindings: [['main.t#1', { kind: 'group', groupColumns: [1] }]],
			relationToBase: [['main.t#1', 'main.t']],
			pkIndicesByBase: [['main.t', [0]]],
			apply: record(calls, 'sub1'),
		});
		exec.register(sub);
		await exec.runAll();
		expect(calls).to.have.length(1);
		expect(calls[0].perRelation[0][1]).to.deep.equal([[10], [20], [10]]);
	});

	it("dispatches 'global' bindings via globalRelations set", async () => {
		const ctx = new MockCtx();
		ctx.setChanged('main.t', [[1]]);
		const exec = new DeltaExecutor(ctx);
		const calls: RecordedCall[] = [];
		const sub = makeSub({
			id: 'sub1',
			dependencies: ['main.t'],
			bindings: [['main.t#1', { kind: 'global' }]],
			relationToBase: [['main.t#1', 'main.t']],
			pkIndicesByBase: [['main.t', [0]]],
			apply: record(calls, 'sub1'),
		});
		exec.register(sub);
		await exec.runAll();
		expect(calls).to.have.length(1);
		expect(calls[0].perRelation).to.deep.equal([]);
		expect(calls[0].global).to.deep.equal(['main.t#1']);
	});

	it('handles multiple relations with independent BindingModes', async () => {
		const ctx = new MockCtx();
		ctx.setChanged('main.p', [[1], [2]]);
		ctx.setChanged('main.c', [[5]]);
		const exec = new DeltaExecutor(ctx);
		const calls: RecordedCall[] = [];
		const sub = makeSub({
			id: 'sub1',
			dependencies: ['main.p', 'main.c'],
			bindings: [
				['main.p#1', { kind: 'row', keyColumns: [0] }],
				['main.c#2', { kind: 'global' }],
			],
			relationToBase: [['main.p#1', 'main.p'], ['main.c#2', 'main.c']],
			pkIndicesByBase: [['main.p', [0]], ['main.c', [0]]],
			apply: record(calls, 'sub1'),
		});
		exec.register(sub);
		await exec.runAll();
		expect(calls).to.have.length(1);
		expect(calls[0].perRelation.map(p => p[0])).to.deep.equal(['main.p#1']);
		expect(calls[0].global).to.deep.equal(['main.c#2']);
	});

	it('falls back to global when changed-tuples ratio exceeds threshold', async () => {
		const ctx = new MockCtx();
		// 60 changed of 100 → ratio 0.6 ≥ 0.5
		ctx.rowCounts.set('main.t', 100);
		ctx.setChanged('main.t', Array.from({ length: 60 }, (_, i) => [i]));
		const exec = new DeltaExecutor(ctx);
		const calls: RecordedCall[] = [];
		exec.register(makeSub({
			id: 'sub1',
			dependencies: ['main.t'],
			bindings: [['main.t#1', { kind: 'row', keyColumns: [0] }]],
			relationToBase: [['main.t#1', 'main.t']],
			pkIndicesByBase: [['main.t', [0]]],
			apply: record(calls, 'sub1'),
		}));
		await exec.runAll();
		expect(calls).to.have.length(1);
		expect(calls[0].global).to.deep.equal(['main.t#1']);
		expect(calls[0].perRelation).to.deep.equal([]);
	});

	it('does NOT fall back to global when below the ratio', async () => {
		const ctx = new MockCtx();
		ctx.rowCounts.set('main.t', 100);
		ctx.setChanged('main.t', Array.from({ length: 10 }, (_, i) => [i])); // 10/100 = 0.1
		const exec = new DeltaExecutor(ctx);
		const calls: RecordedCall[] = [];
		exec.register(makeSub({
			id: 'sub1',
			dependencies: ['main.t'],
			bindings: [['main.t#1', { kind: 'row', keyColumns: [0] }]],
			relationToBase: [['main.t#1', 'main.t']],
			pkIndicesByBase: [['main.t', [0]]],
			apply: record(calls, 'sub1'),
		}));
		await exec.runAll();
		expect(calls[0].global).to.deep.equal([]);
		expect(calls[0].perRelation[0][1]).to.have.length(10);
	});

	it('skips subscriptions whose dependencies did not change', async () => {
		const ctx = new MockCtx();
		ctx.setChanged('main.other', [[1]]);
		const exec = new DeltaExecutor(ctx);
		const calls: RecordedCall[] = [];
		exec.register(makeSub({
			id: 'sub1',
			dependencies: ['main.t'],
			bindings: [['main.t#1', { kind: 'row', keyColumns: [0] }]],
			relationToBase: [['main.t#1', 'main.t']],
			pkIndicesByBase: [['main.t', [0]]],
			apply: record(calls, 'sub1'),
		}));
		await exec.runAll();
		expect(calls).to.have.length(0);
	});

	it('propagates exceptions from apply (no swallowing)', async () => {
		const ctx = new MockCtx();
		ctx.setChanged('main.t', [[1]]);
		const exec = new DeltaExecutor(ctx);
		exec.register(makeSub({
			id: 'sub1',
			dependencies: ['main.t'],
			bindings: [['main.t#1', { kind: 'global' }]],
			relationToBase: [['main.t#1', 'main.t']],
			pkIndicesByBase: [['main.t', [0]]],
			apply: async () => { throw new Error('boom'); },
		}));
		let caught: Error | undefined;
		try {
			await exec.runAll();
		} catch (e) {
			caught = e as Error;
		}
		expect(caught?.message).to.equal('boom');
	});

	it('does not invoke apply when no relations are impacted (empty changes)', async () => {
		const ctx = new MockCtx();
		// Dependency table set up but no rows changed
		ctx.setChanged('main.t', []);
		const exec = new DeltaExecutor(ctx);
		const calls: RecordedCall[] = [];
		exec.register(makeSub({
			id: 'sub1',
			dependencies: ['main.t'],
			bindings: [['main.t#1', { kind: 'row', keyColumns: [0] }]],
			relationToBase: [['main.t#1', 'main.t']],
			pkIndicesByBase: [['main.t', [0]]],
			apply: record(calls, 'sub1'),
		}));
		// changed.set('main.t', []) still makes getChangedBaseTables include it;
		// but the inner getChangedTuples returns [] so no per-relation entry is
		// recorded — and no global entry either, so apply is not invoked.
		await exec.runAll();
		expect(calls).to.have.length(0);
	});

	it('dispose handle removes the subscription', async () => {
		const ctx = new MockCtx();
		ctx.setChanged('main.t', [[1]]);
		const exec = new DeltaExecutor(ctx);
		const calls: RecordedCall[] = [];
		const dispose = exec.register(makeSub({
			id: 'sub1',
			dependencies: ['main.t'],
			bindings: [['main.t#1', { kind: 'global' }]],
			relationToBase: [['main.t#1', 'main.t']],
			pkIndicesByBase: [['main.t', [0]]],
			apply: record(calls, 'sub1'),
		}));
		dispose();
		await exec.runAll();
		expect(calls).to.have.length(0);
	});
});

describe('DeltaExecutor: RunAllOptions + isGloballyChanged (cascading seams)', () => {
	it('dispatches subscriptions in the order returned by opts.order', async () => {
		const ctx = new MockCtx();
		ctx.setChanged('main.a', [[1]]);
		ctx.setChanged('main.b', [[2]]);
		const exec = new DeltaExecutor(ctx);
		const calls: RecordedCall[] = [];
		exec.register(makeSub({
			id: 'subA', dependencies: ['main.a'],
			bindings: [['main.a#1', { kind: 'row', keyColumns: [0] }]],
			relationToBase: [['main.a#1', 'main.a']], pkIndicesByBase: [['main.a', [0]]],
			apply: record(calls, 'subA'),
		}));
		exec.register(makeSub({
			id: 'subB', dependencies: ['main.b'],
			bindings: [['main.b#1', { kind: 'row', keyColumns: [0] }]],
			relationToBase: [['main.b#1', 'main.b']], pkIndicesByBase: [['main.b', [0]]],
			apply: record(calls, 'subB'),
		}));
		// Reverse insertion order via opts.order.
		await exec.runAll({ order: (subs) => [...subs].reverse() });
		expect(calls.map(c => c.id)).to.deep.equal(['subB', 'subA']);
	});

	it('rescanPerSubscription makes a base added by an earlier apply visible to a later one', async () => {
		const ctx = new MockCtx();
		ctx.setChanged('main.a', [[1]]);
		const exec = new DeltaExecutor(ctx);
		const calls: RecordedCall[] = [];
		// subA's apply grows the change source with main.b (mimics a producer MV
		// writing its backing table mid-pass).
		exec.register(makeSub({
			id: 'subA', dependencies: ['main.a'],
			bindings: [['main.a#1', { kind: 'row', keyColumns: [0] }]],
			relationToBase: [['main.a#1', 'main.a']], pkIndicesByBase: [['main.a', [0]]],
			apply: async () => { ctx.setChanged('main.b', [[9]]); },
		}));
		exec.register(makeSub({
			id: 'subB', dependencies: ['main.b'],
			bindings: [['main.b#1', { kind: 'row', keyColumns: [0] }]],
			relationToBase: [['main.b#1', 'main.b']], pkIndicesByBase: [['main.b', [0]]],
			apply: record(calls, 'subB'),
		}));
		const order = (subs: DeltaSubscription[]) => [...subs].sort((x, y) => x.id.localeCompare(y.id));

		// Without rescan: subB never sees main.b (snapshot taken before subA ran).
		await exec.runAll({ order });
		expect(calls).to.have.length(0);

		// With rescan: subB observes main.b that subA added.
		ctx.changed.delete('main.b');
		await exec.runAll({ order, rescanPerSubscription: true });
		expect(calls.map(c => c.id)).to.deep.equal(['subB']);
		expect(calls[0].perRelation[0][1]).to.deep.equal([[9]]);
	});

	it('isGloballyChanged forces a row relation to global without fetching tuples', async () => {
		const ctx = new MockCtx();
		ctx.setChanged('main.t', [[1], [2]]);
		ctx.globallyChanged.add('main.t');
		let fetched = false;
		const origFetch = ctx.getChangedTuples.bind(ctx);
		ctx.getChangedTuples = (base, cols, pk) => { fetched = true; return origFetch(base, cols, pk); };
		const exec = new DeltaExecutor(ctx);
		const calls: RecordedCall[] = [];
		exec.register(makeSub({
			id: 'sub1', dependencies: ['main.t'],
			bindings: [['main.t#1', { kind: 'row', keyColumns: [0] }]],
			relationToBase: [['main.t#1', 'main.t']], pkIndicesByBase: [['main.t', [0]]],
			apply: record(calls, 'sub1'),
		}));
		await exec.runAll();
		expect(calls).to.have.length(1);
		expect(calls[0].perRelation).to.deep.equal([]);
		expect(calls[0].global).to.deep.equal(['main.t#1']);
		expect(fetched).to.equal(false);
	});
});
