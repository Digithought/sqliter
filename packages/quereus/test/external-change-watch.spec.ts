/**
 * Database.notifyExternalChange — externally-originated (out-of-band) change →
 * watch invalidation (ticket `external-change-watch-feature-untracked-provenance`).
 *
 * Watchers normally fire only from the post-commit path, driven by the local
 * transaction's change log. A row written by a remote peer to an
 * optimystic-backed table never touches this `Database`'s change log, so its
 * watchers would never fire. `notifyExternalChange` injects a coarse,
 * table-granular invalidation: every active watcher whose scope includes the
 * named table fires as if the whole table changed, without a local commit.
 */

import { expect } from 'chai';
import { Database } from '../src/core/database.js';
import type { ChangeScope, WatchEvent } from '../src/index.js';

describe('Database.notifyExternalChange (external/remote change → watch)', () => {
	let db: Database;
	beforeEach(() => { db = new Database(); });
	afterEach(async () => { if (db) await db.close(); });

	/** A hand-built `rows` change-scope watch on a single-column-PK table. */
	function rowsWatch(table: string, key: string, value: unknown): ChangeScope {
		return {
			watches: [{
				table: { schema: 'main', table },
				columns: new Set([key]),
				scope: { kind: 'rows', key: [key], values: [[value as never]] },
			}],
			nonDeterministicSources: [],
			unboundParameters: [],
		};
	}

	/** A hand-built `groups` change-scope watch on a single group column. */
	function groupsWatch(table: string, groupCol: string): ChangeScope {
		return {
			watches: [{
				table: { schema: 'main', table },
				columns: new Set([groupCol]),
				scope: { kind: 'groups', groupBy: [groupCol] },
			}],
			nonDeterministicSources: [],
			unboundParameters: [],
		};
	}

	/** A hand-built `rowsByGroup` change-scope watch with a literal group value. */
	function rowsByGroupWatch(table: string, groupCol: string, value: unknown): ChangeScope {
		return {
			watches: [{
				table: { schema: 'main', table },
				columns: new Set([groupCol]),
				scope: { kind: 'rowsByGroup', groupBy: [groupCol], values: [[value as never]] },
			}],
			nonDeterministicSources: [],
			unboundParameters: [],
		};
	}

	it('a `full` watch fires once with empty hits and a set txnId', async () => {
		await db.exec('create table t (id text primary key, v text) using memory');
		const scope = db.prepare('select * from t').getChangeScope();

		const events: WatchEvent[] = [];
		const sub = db.watch(scope, e => { events.push(e); });

		await db.notifyExternalChange('t');
		sub.unsubscribe();

		expect(events).to.have.length(1);
		expect(events[0].matched).to.have.length(1);
		// `matched` covers `t`.
		expect(events[0].matched[0].watch.table.table).to.equal('t');
		// `full` watch fires with empty hits.
		expect(events[0].matched[0].hits).to.deep.equal([]);
		// txnId is set (non-empty).
		expect(events[0].txnId).to.be.a('string').and.match(/^txn:/);
	});

	it('a `rows` watch surfaces its registered literal value in hits', async () => {
		await db.exec('create table t (id text primary key, v text) using memory');

		const events: WatchEvent[] = [];
		const sub = db.watch(rowsWatch('t', 'id', 'x'), e => { events.push(e); });

		await db.notifyExternalChange('t');
		sub.unsubscribe();

		expect(events).to.have.length(1);
		expect(events[0].matched).to.have.length(1);
		expect(events[0].matched[0].hits).to.deep.equal([['x']]);
	});

	it('a watch on a different table does NOT fire', async () => {
		await db.exec('create table t (id text primary key, v text) using memory');
		await db.exec('create table u (id text primary key, v text) using memory');

		const events: WatchEvent[] = [];
		const sub = db.watch(db.prepare('select * from u').getChangeScope(), e => { events.push(e); });

		await db.notifyExternalChange('t');
		sub.unsubscribe();

		expect(events).to.have.length(0);
	});

	it('is a no-op (no throw) when no watchers are registered', async () => {
		await db.exec('create table t (id text primary key, v text) using memory');
		// Should resolve without throwing even though nothing is subscribed.
		await db.notifyExternalChange('t');
	});

	it('is a no-op (no throw) when no table by that name is watched', async () => {
		await db.exec('create table t (id text primary key, v text) using memory');
		const sub = db.watch(db.prepare('select * from t').getChangeScope(), () => { /* */ });
		// A name that exists in no subscription must not throw.
		await db.notifyExternalChange('does_not_exist');
		sub.unsubscribe();
	});

	it('isolates a throwing handler — the returned promise does not reject', async () => {
		await db.exec('create table t (id text primary key, v text) using memory');
		const sub = db.watch(db.prepare('select * from t').getChangeScope(), () => {
			throw new Error('boom');
		});

		// Must not reject — watcher errors never propagate into the caller.
		await db.notifyExternalChange('t');
		sub.unsubscribe();
	});

	it('isolates a rejecting async handler and still fires the other watchers', async () => {
		await db.exec('create table t (id text primary key, v text) using memory');

		const okEvents: WatchEvent[] = [];
		const bad = db.watch(db.prepare('select * from t').getChangeScope(), async () => {
			await Promise.resolve();
			throw new Error('async boom');
		});
		const good = db.watch(rowsWatch('t', 'id', 'y'), e => { okEvents.push(e); });

		await db.notifyExternalChange('t');
		bad.unsubscribe();
		good.unsubscribe();

		// The healthy subscription still fired despite the peer rejecting.
		expect(okEvents).to.have.length(1);
		expect(okEvents[0].matched[0].hits).to.deep.equal([['y']]);
	});

	it('explicit schema name matches a watch registered against the current schema', async () => {
		await db.exec('create table t (id text primary key, v text) using memory');
		const events: WatchEvent[] = [];
		const sub = db.watch(db.prepare('select * from t').getChangeScope(), e => { events.push(e); });

		// `t` resolves to `main.t`; passing 'main' explicitly must still match.
		await db.notifyExternalChange('t', 'main');
		sub.unsubscribe();

		expect(events).to.have.length(1);
		expect(events[0].matched[0].watch.table.table).to.equal('t');
	});

	it('table-name matching is case-insensitive', async () => {
		await db.exec('create table t (id text primary key, v text) using memory');
		const events: WatchEvent[] = [];
		const sub = db.watch(db.prepare('select * from t').getChangeScope(), e => { events.push(e); });

		await db.notifyExternalChange('T', 'MAIN');
		sub.unsubscribe();

		expect(events).to.have.length(1);
	});

	it('fires every matching watcher on the same table in one call', async () => {
		await db.exec('create table t (id text primary key, v text) using memory');

		const a: WatchEvent[] = [];
		const b: WatchEvent[] = [];
		const subA = db.watch(db.prepare('select * from t').getChangeScope(), e => { a.push(e); });
		const subB = db.watch(rowsWatch('t', 'id', 'z'), e => { b.push(e); });

		await db.notifyExternalChange('t');
		subA.unsubscribe();
		subB.unsubscribe();

		expect(a).to.have.length(1);
		expect(b).to.have.length(1);
		expect(b[0].matched[0].hits).to.deep.equal([['z']]);
	});

	it('a `groups` watch fires once with empty hits (whole-table → re-query)', async () => {
		await db.exec('create table t (id text primary key, g text, v text) using memory');

		const events: WatchEvent[] = [];
		const sub = db.watch(groupsWatch('t', 'g'), e => { events.push(e); });

		await db.notifyExternalChange('t');
		sub.unsubscribe();

		expect(events).to.have.length(1);
		expect(events[0].matched).to.have.length(1);
		// A `groups` watch carries no literals, so a global change surfaces empty hits.
		expect(events[0].matched[0].hits).to.deep.equal([]);
	});

	it('a `rowsByGroup` watch surfaces its registered group literal in hits', async () => {
		await db.exec('create table t (id text primary key, g text, v text) using memory');

		const events: WatchEvent[] = [];
		const sub = db.watch(rowsByGroupWatch('t', 'g', 'gx'), e => { events.push(e); });

		await db.notifyExternalChange('t');
		sub.unsubscribe();

		expect(events).to.have.length(1);
		expect(events[0].matched[0].hits).to.deep.equal([['gx']]);
	});

	it('fires only the named table within a subscription that watches two tables', async () => {
		await db.exec('create table t (id text primary key, v text) using memory');
		await db.exec('create table u (id text primary key, v text) using memory');

		// One subscription, two watches on distinct tables. An external change on
		// `t` must surface ONLY `t`'s watch in `matched` — the other relation is
		// untouched and must not over-fire.
		const scope: ChangeScope = {
			watches: [
				{ table: { schema: 'main', table: 't' }, columns: 'all', scope: { kind: 'full' } },
				{ table: { schema: 'main', table: 'u' }, columns: 'all', scope: { kind: 'full' } },
			],
			nonDeterministicSources: [],
			unboundParameters: [],
		};

		const events: WatchEvent[] = [];
		const sub = db.watch(scope, e => { events.push(e); });

		await db.notifyExternalChange('t');
		sub.unsubscribe();

		expect(events).to.have.length(1);
		expect(events[0].matched).to.have.length(1);
		expect(events[0].matched[0].watch.table.table).to.equal('t');
	});
});
