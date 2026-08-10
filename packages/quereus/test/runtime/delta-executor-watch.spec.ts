import { expect } from 'chai';
import {
	subscriptionFromChangeScope,
	type ChangeScopeTableInfo,
	type SubscriptionFromChangeScopeContext,
} from '../../src/runtime/delta-executor.js';
import type {
	ChangeScope,
	WatchEvent,
} from '../../src/planner/analysis/change-scope.js';
import type { SqlValue } from '../../src/common/types.js';

function makeTableInfo(cols: string[], pk: number[] = [0]): ChangeScopeTableInfo {
	const map = new Map<string, number>();
	cols.forEach((c, i) => map.set(c.toLowerCase(), i));
	return { columnIndexMap: map, pkIndices: pk };
}

function makeCtx(opts: {
	tables: Map<string, ChangeScopeTableInfo>;
	txnId?: string;
}): { ctx: SubscriptionFromChangeScopeContext; captures: Array<{ base: string; cols: number[] }> } {
	const captures: Array<{ base: string; cols: number[] }> = [];
	const ctx: SubscriptionFromChangeScopeContext = {
		resolveTable: (q) => opts.tables.get(`${q.schema}.${q.table}`),
		registerCaptureSpec: (base, spec) => {
			const e = { base, cols: [...spec.extraColumns] };
			captures.push(e);
			return () => {
				const i = captures.indexOf(e);
				if (i >= 0) captures.splice(i, 1);
			};
		},
		getCurrentTxnId: () => opts.txnId ?? 'txn:test',
	};
	return { ctx, captures };
}

describe('subscriptionFromChangeScope (unit)', () => {
	const tables = new Map<string, ChangeScopeTableInfo>([
		['main.t', makeTableInfo(['id', 'a', 'b', 'g'], [0])],
	]);

	it("translates 'full' scope to a global binding with no capture", () => {
		const { ctx, captures } = makeCtx({ tables });
		const scope: ChangeScope = {
			watches: [{ table: { schema: 'main', table: 't' }, columns: 'all', scope: { kind: 'full' } }],
			nonDeterministicSources: [],
			unboundParameters: [],
		};
		const { subscription } = subscriptionFromChangeScope(scope, () => { /* */ }, 'w1', ctx);
		const [relKey, mode] = [...subscription.bindings.entries()][0];
		expect(mode).to.deep.equal({ kind: 'global' });
		expect(subscription.relationToBase.get(relKey)).to.equal('main.t');
		expect(subscription.dependencies.has('main.t')).to.equal(true);
		expect(captures).to.be.empty;
	});

	it("translates 'full' + columns to global binding + capture spec for non-PK columns", () => {
		const { ctx, captures } = makeCtx({ tables });
		const scope: ChangeScope = {
			watches: [{
				table: { schema: 'main', table: 't' },
				columns: new Set(['a', 'b']),
				scope: { kind: 'full' },
			}],
			nonDeterministicSources: [],
			unboundParameters: [],
		};
		const { subscription, captureDisposers } = subscriptionFromChangeScope(scope, () => { /* */ }, 'w2', ctx);
		const mode = [...subscription.bindings.values()][0];
		expect(mode).to.deep.equal({ kind: 'global' });
		expect(captures).to.have.length(1);
		expect(captures[0].base).to.equal('main.t');
		expect([...captures[0].cols].sort()).to.deep.equal([1, 2]);
		expect(captureDisposers).to.have.length(1);
	});

	it("translates 'rows' scope to a 'row' binding with the right keyColumns", () => {
		const { ctx } = makeCtx({ tables });
		const scope: ChangeScope = {
			watches: [{
				table: { schema: 'main', table: 't' },
				columns: 'all',
				scope: { kind: 'rows', key: ['id'], values: [[7], [9]] },
			}],
			nonDeterministicSources: [],
			unboundParameters: [],
		};
		const { subscription } = subscriptionFromChangeScope(scope, () => { /* */ }, 'w3', ctx);
		const mode = [...subscription.bindings.values()][0];
		expect(mode).to.deep.equal({ kind: 'row', keyColumns: [0] });
	});

	it("translates 'groups' scope to a 'group' binding with the right groupColumns", () => {
		const { ctx, captures } = makeCtx({ tables });
		const scope: ChangeScope = {
			watches: [{
				table: { schema: 'main', table: 't' },
				columns: 'all',
				scope: { kind: 'groups', groupBy: ['g'] },
			}],
			nonDeterministicSources: [],
			unboundParameters: [],
		};
		const { subscription } = subscriptionFromChangeScope(scope, () => { /* */ }, 'w4', ctx);
		const mode = [...subscription.bindings.values()][0];
		expect(mode).to.deep.equal({ kind: 'group', groupColumns: [3] });
		// 'g' is non-PK, so capture spec should be registered for it.
		expect(captures).to.have.length(1);
		expect([...captures[0].cols]).to.deep.equal([3]);
	});

	it("translates 'rowsByGroup' to a 'group' binding (kernel-level)", () => {
		const { ctx } = makeCtx({ tables });
		const scope: ChangeScope = {
			watches: [{
				table: { schema: 'main', table: 't' },
				columns: 'all',
				scope: { kind: 'rowsByGroup', groupBy: ['g'], values: [['A'], ['B']] },
			}],
			nonDeterministicSources: [],
			unboundParameters: [],
		};
		const { subscription } = subscriptionFromChangeScope(scope, () => { /* */ }, 'w5', ctx);
		const mode = [...subscription.bindings.values()][0];
		expect(mode).to.deep.equal({ kind: 'group', groupColumns: [3] });
	});

	it("throws when a referenced table does not exist", () => {
		const { ctx } = makeCtx({ tables });
		const scope: ChangeScope = {
			watches: [{ table: { schema: 'main', table: 'missing' }, columns: 'all', scope: { kind: 'full' } }],
			nonDeterministicSources: [],
			unboundParameters: [],
		};
		expect(() => subscriptionFromChangeScope(scope, () => { /* */ }, 'wm', ctx))
			.to.throw(/main\.missing/);
	});

	it("throws when a referenced column does not exist", () => {
		const { ctx } = makeCtx({ tables });
		const scope: ChangeScope = {
			watches: [{
				table: { schema: 'main', table: 't' },
				columns: 'all',
				scope: { kind: 'rows', key: ['nope'], values: [[1]] },
			}],
			nonDeterministicSources: [],
			unboundParameters: [],
		};
		expect(() => subscriptionFromChangeScope(scope, () => { /* */ }, 'wc', ctx))
			.to.throw(/column 'nope'/);
	});

	it("apply: intersects kernel tuples against literal values for 'rows' watch", async () => {
		const { ctx } = makeCtx({ tables });
		const scope: ChangeScope = {
			watches: [{
				table: { schema: 'main', table: 't' },
				columns: 'all',
				scope: { kind: 'rows', key: ['id'], values: [[7], [9]] },
			}],
			nonDeterministicSources: [],
			unboundParameters: [],
		};
		const events: WatchEvent[] = [];
		const { subscription } = subscriptionFromChangeScope(
			scope,
			(e) => { events.push(e); },
			'w-intersect',
			ctx,
		);
		const relKey = [...subscription.relationToBase.keys()][0];
		await subscription.apply({
			perRelationTuples: new Map<string, readonly SqlValue[][]>([
				[relKey, [[7], [8]]],
			]),
			globalRelations: new Set(),
		});
		expect(events).to.have.length(1);
		expect(events[0].matched).to.have.length(1);
		expect(events[0].matched[0].hits).to.deep.equal([[7]]);
		expect(events[0].txnId).to.equal('txn:test');
	});

	it("apply: does not fire when intersection is empty", async () => {
		const { ctx } = makeCtx({ tables });
		const scope: ChangeScope = {
			watches: [{
				table: { schema: 'main', table: 't' },
				columns: 'all',
				scope: { kind: 'rows', key: ['id'], values: [[7]] },
			}],
			nonDeterministicSources: [],
			unboundParameters: [],
		};
		const events: WatchEvent[] = [];
		const { subscription } = subscriptionFromChangeScope(scope, e => { events.push(e); }, 'w-empty', ctx);
		const relKey = [...subscription.relationToBase.keys()][0];
		await subscription.apply({
			perRelationTuples: new Map<string, readonly SqlValue[][]>([
				[relKey, [[8], [9]]],
			]),
			globalRelations: new Set(),
		});
		expect(events).to.have.length(0);
	});

	it("apply: 'full' watch fires with empty hits when relKey is in globalRelations", async () => {
		const { ctx } = makeCtx({ tables });
		const scope: ChangeScope = {
			watches: [{ table: { schema: 'main', table: 't' }, columns: 'all', scope: { kind: 'full' } }],
			nonDeterministicSources: [],
			unboundParameters: [],
		};
		const events: WatchEvent[] = [];
		const { subscription } = subscriptionFromChangeScope(scope, e => { events.push(e); }, 'w-full', ctx);
		const relKey = [...subscription.relationToBase.keys()][0];
		await subscription.apply({
			perRelationTuples: new Map(),
			globalRelations: new Set([relKey]),
		});
		expect(events).to.have.length(1);
		expect(events[0].matched[0].hits).to.deep.equal([]);
	});

	it("apply: 'groups' watch fires with empty hits when relKey is in globalRelations", async () => {
		const { ctx } = makeCtx({ tables });
		const scope: ChangeScope = {
			watches: [{
				table: { schema: 'main', table: 't' },
				columns: 'all',
				scope: { kind: 'groups', groupBy: ['g'] },
			}],
			nonDeterministicSources: [],
			unboundParameters: [],
		};
		const events: WatchEvent[] = [];
		const { subscription } = subscriptionFromChangeScope(scope, e => { events.push(e); }, 'w-grp-global', ctx);
		const relKey = [...subscription.relationToBase.keys()][0];
		// A `groups` watch carries no literals; a global re-eval must still fire
		// (whole-relation changed → re-query) — mirrors the `full` global case.
		await subscription.apply({
			perRelationTuples: new Map(),
			globalRelations: new Set([relKey]),
		});
		expect(events).to.have.length(1);
		expect(events[0].matched[0].hits).to.deep.equal([]);
	});

	it("apply: 'groups' watch reports kernel tuples directly as hits", async () => {
		const { ctx } = makeCtx({ tables });
		const scope: ChangeScope = {
			watches: [{
				table: { schema: 'main', table: 't' },
				columns: 'all',
				scope: { kind: 'groups', groupBy: ['g'] },
			}],
			nonDeterministicSources: [],
			unboundParameters: [],
		};
		const events: WatchEvent[] = [];
		const { subscription } = subscriptionFromChangeScope(scope, e => { events.push(e); }, 'w-grp', ctx);
		const relKey = [...subscription.relationToBase.keys()][0];
		await subscription.apply({
			perRelationTuples: new Map<string, readonly SqlValue[][]>([
				[relKey, [['A'], ['B']]],
			]),
			globalRelations: new Set(),
		});
		expect(events).to.have.length(1);
		expect(events[0].matched[0].hits).to.deep.equal([['A'], ['B']]);
	});

	it("apply: handler errors are swallowed", async () => {
		const { ctx } = makeCtx({ tables });
		const scope: ChangeScope = {
			watches: [{ table: { schema: 'main', table: 't' }, columns: 'all', scope: { kind: 'full' } }],
			nonDeterministicSources: [],
			unboundParameters: [],
		};
		const { subscription } = subscriptionFromChangeScope(scope, () => { throw new Error('boom'); }, 'w-err', ctx);
		const relKey = [...subscription.relationToBase.keys()][0];
		// Should not reject.
		await subscription.apply({
			perRelationTuples: new Map(),
			globalRelations: new Set([relKey]),
		});
	});
});
