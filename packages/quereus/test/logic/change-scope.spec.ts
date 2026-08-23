import { expect } from 'chai';
import { Database } from '../../src/core/database.js';
import {
	deserializeChangeScope,
	serializeChangeScope,
	type ChangeScope,
	type WatchEvent,
	type WatchScope,
	type ParamScopeValue,
} from '../../src/planner/analysis/change-scope.js';

describe('Statement.getChangeScope (integration)', () => {
	let db: Database;
	beforeEach(() => { db = new Database(); });
	afterEach(async () => { await db.close(); });

	it('two prepared statements over equivalent SQL produce deepEqual scopes', async () => {
		await db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT) USING memory');
		const a = db.prepare('select * from t where id = ?').getChangeScope([5]);
		const b = db.prepare('select * from t where id = ?').getChangeScope([5]);
		expect(a.unboundParameters).to.deep.equal(b.unboundParameters);
		expect(a.watches.length).to.equal(b.watches.length);
		expect(a.watches[0].scope).to.deep.equal(b.watches[0].scope);
		expect(a.watches[0].table).to.deep.equal(b.watches[0].table);
	});

	it('serialized scope round-trips and matches the live one', async () => {
		await db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT) USING memory');
		const live = db.prepare('select v from t where id = ?').getChangeScope();
		const round = deserializeChangeScope(JSON.parse(JSON.stringify(serializeChangeScope(live))));
		expect(round.unboundParameters).to.deep.equal(live.unboundParameters);
		expect(round.watches[0].table).to.deep.equal(live.watches[0].table);
		expect(round.watches[0].scope).to.deep.equal(live.watches[0].scope);
	});

	it('parameter placeholders carry a portable type descriptor', async () => {
		await db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY) USING memory');
		const stmt = db.prepare('select * from t where id = ?');
		const scope = stmt.getChangeScope();
		const w = scope.watches[0];
		expect(w.scope.kind).to.equal('rows');
		const r = w.scope as Extract<WatchScope, { kind: 'rows' }>;
		const v = r.values[0][0] as ParamScopeValue;
		expect(v.kind).to.equal('param');
		expect(v.type).to.have.property('typeName').that.is.a('string');
		expect(v.type).to.have.property('nullable');
	});

	it('getChangeScope on Statement without prior bind returns scope with unbound params', async () => {
		await db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY) USING memory');
		const stmt = db.prepare('select * from t where id = ?');
		const scope = stmt.getChangeScope();
		expect(scope.unboundParameters).to.deep.equal([1]);
	});

	it('getChangeScope on prepared statement with bound params resolves placeholders', async () => {
		await db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY) USING memory');
		const stmt = db.prepare('select * from t where id = ?');
		stmt.bind(1, 99);
		const scope = stmt.getChangeScope();
		expect(scope.unboundParameters).to.deep.equal([]);
		const r = scope.watches[0].scope as Extract<WatchScope, { kind: 'rows' }>;
		expect(r.values).to.deep.equal([[99]]);
	});

	it('a materialized-view reference reports the SOURCE table, not the MV itself', async () => {
		// Every MV is row-time maintained: its table is written off the user change
		// log (synchronously at the DML boundary) and never appears in it — so a
		// watch on it would never fire. change-scope projects the reference onto the
		// source instead.
		await db.exec('CREATE TABLE src (id INTEGER PRIMARY KEY, v TEXT) USING memory');
		await db.exec("INSERT INTO src VALUES (1, 'a')");
		await db.exec('CREATE MATERIALIZED VIEW mvi AS SELECT id, v FROM src');

		const scope = db.prepare('select * from mvi').getChangeScope();
		const tables = scope.watches.map(w => `${w.table.schema}.${w.table.table}`);
		expect(tables).to.deep.equal(['main.src']);
		// The MV's own table is NOT reported — nothing user-writes it.
		expect(tables).to.not.include('main.mvi');
	});

	it('a query reading both an MV and its source reports the source once', async () => {
		// The projected source-union scope unions/dedups against a direct read of
		// the same source table — the source appears exactly once.
		await db.exec('CREATE TABLE src (id INTEGER PRIMARY KEY, v TEXT) USING memory');
		await db.exec("INSERT INTO src VALUES (1, 'a')");
		await db.exec("CREATE MATERIALIZED VIEW mvi AS SELECT id, v FROM src");

		const scope = db.prepare('select mvi.v from mvi join src on src.id = mvi.id').getChangeScope();
		const tables = scope.watches.map(w => `${w.table.schema}.${w.table.table}`);
		expect(tables).to.deep.equal(['main.src']);
	});

	it('the projected source watch is whole-table / all-columns (v1 conservative contract)', async () => {
		// v1 projects to a `{kind:'full'}`, columns:'all' watch per source even when
		// the MV body keys on a source PK — sound but coarse (see docs known-imprecisions).
		await db.exec('CREATE TABLE src (id INTEGER PRIMARY KEY, v TEXT) USING memory');
		await db.exec("CREATE MATERIALIZED VIEW mvi AS SELECT id, v FROM src");

		const scope = db.prepare('select v from mvi where id = 1').getChangeScope();
		expect(scope.watches).to.have.length(1);
		expect(scope.watches[0].table).to.deep.equal({ schema: 'main', table: 'src' });
		expect(scope.watches[0].columns).to.equal('all');
		expect(scope.watches[0].scope).to.deep.equal({ kind: 'full' });
	});

	it('a key pinned by a constant scalar subquery degrades to a full watch, never a bogus row value', async () => {
		// `k = (select 1)` const-folds to a literal holding a still-pending Promise. A
		// row-scope built from that value would serialize as `j:{}` for every such
		// subquery, so two distinct pinned keys would dedup to one and the watch would
		// miss changes to the other. The analysis must bail to `{kind:'full'}` instead.
		await db.exec('CREATE TABLE t (k INTEGER PRIMARY KEY, v INTEGER) USING memory');
		for (const sql of [
			'select * from t where k = (select 1)',
			'select * from t where k in ((select 1), (select 2))',
			'select * from t where k = cast((select 1) as integer)',
		]) {
			const scope = db.prepare(sql).getChangeScope();
			expect(scope.watches, sql).to.have.length(1);
			expect(scope.watches[0].scope, sql).to.deep.equal({ kind: 'full' });
		}
		// Control: an ordinary literal still pins the row.
		const pinned = db.prepare('select * from t where k = 1').getChangeScope();
		expect(pinned.watches[0].scope).to.deep.equal({ kind: 'rows', key: ['k'], values: [[1]] });
	});

	it('getChangeScope on an MV whose source was dropped throws cleanly (no dropped-table watch)', async () => {
		// Dropping a source marks the MV stale; re-planning `select * from mvi` for
		// analysis raises the same "stale; drop and recreate" error executing it does
		// — so the resolver never yields a watch on the now-missing source table.
		await db.exec('CREATE TABLE src (id INTEGER PRIMARY KEY, v TEXT) USING memory');
		await db.exec("CREATE MATERIALIZED VIEW mvi AS SELECT id, v FROM src");
		await db.exec('DROP TABLE src');

		expect(() => db.prepare('select * from mvi').getChangeScope()).to.throw(/stale/i);
	});

	it('a read through a view reports the BASE table in its change scope (not the view)', async () => {
		// View bodies inline to base table references, so change-scope reports the
		// base (not the view) for free — the analogue of an MV reference projecting
		// to its sources.
		await db.exec('CREATE TABLE base (id INTEGER PRIMARY KEY, v TEXT) USING memory');
		await db.exec('CREATE VIEW vw AS SELECT id, v FROM base WHERE v IS NOT NULL');

		const scope = db.prepare('select * from vw where id = ?').getChangeScope();
		const tables = scope.watches.map(w => `${w.table.schema}.${w.table.table}`);
		expect(tables).to.deep.equal(['main.base']);
		expect(tables).to.not.include('main.vw');
	});

	it('a view-mediated mutation has the same change scope as the equivalent base mutation', async () => {
		// View updateability rewrites the DML to target the base table, so a
		// view-mediated UPDATE is indistinguishable from the base UPDATE at the
		// change-scope level (no view-specific divergence). Both are no-RETURNING
		// DML, which by existing design surfaces via Database.watch rather than
		// getChangeScope watches.
		await db.exec('CREATE TABLE base (id INTEGER PRIMARY KEY, v TEXT) USING memory');
		await db.exec('CREATE VIEW vw AS SELECT id, v FROM base WHERE v IS NOT NULL');

		const viewScope = db.prepare('update vw set v = ? where id = ?').getChangeScope();
		const baseScope = db.prepare('update base set v = ? where id = ? and v is not null').getChangeScope();
		expect(viewScope.watches).to.deep.equal(baseScope.watches);
		expect(viewScope.unboundParameters).to.deep.equal(baseScope.unboundParameters);
	});
});

describe('Database.watch (integration)', () => {
	let db: Database;
	beforeEach(() => { db = new Database(); });
	afterEach(async () => { await db.close(); });

	const handBuiltRowsScope = (table: string, key: string, values: number[][]): ChangeScope => ({
		watches: [{
			table: { schema: 'main', table },
			columns: new Set([key]),
			scope: { kind: 'rows', key: [key], values },
		}],
		nonDeterministicSources: [],
		unboundParameters: [],
	});

	it('plan-independent: hand-built ChangeScope (no Statement) fires on matching row mutation', async () => {
		await db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT) USING memory');
		await db.exec('INSERT INTO t VALUES (7, \'seven\'), (8, \'eight\')');
		const events: WatchEvent[] = [];
		const scope = handBuiltRowsScope('t', 'id', [[7]]);
		const sub = db.watch(scope, e => { events.push(e); });
		expect(sub.id).to.match(/^watch:/);

		await db.exec('UPDATE t SET v = \'updated\' WHERE id = 7');
		expect(events).to.have.length(1);
		expect(events[0].matched).to.have.length(1);
		expect(events[0].matched[0].hits).to.deep.equal([[7]]);
		expect(events[0].txnId).to.be.a('string').and.not.empty;

		// Mutation of an unwatched row does not fire.
		await db.exec('UPDATE t SET v = \'also-updated\' WHERE id = 8');
		expect(events).to.have.length(1);

		sub.unsubscribe();
	});

	it("'groups' watch fires once per distinct group key touched", async () => {
		await db.exec('CREATE TABLE orders (id INTEGER PRIMARY KEY, customer_id INTEGER, total INTEGER) USING memory');
		await db.exec('INSERT INTO orders VALUES (1, 10, 100), (2, 10, 200), (3, 20, 300)');
		const events: WatchEvent[] = [];
		const scope: ChangeScope = {
			watches: [{
				table: { schema: 'main', table: 'orders' },
				columns: new Set(['customer_id']),
				scope: { kind: 'groups', groupBy: ['customer_id'] },
			}],
			nonDeterministicSources: [],
			unboundParameters: [],
		};
		const sub = db.watch(scope, e => { events.push(e); });

		await db.exec('UPDATE orders SET total = total + 1 WHERE customer_id = 10');
		expect(events).to.have.length(1);
		const hitGroups = events[0].matched[0].hits.map(h => h[0]);
		expect(hitGroups).to.include(10);
		expect(hitGroups).to.not.include(20);
		sub.unsubscribe();
	});

	it("'full' watch with columns:'all' fires on any row mutation with empty hits", async () => {
		await db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT) USING memory');
		await db.exec('INSERT INTO t VALUES (1, \'a\')');
		const events: WatchEvent[] = [];
		const scope: ChangeScope = {
			watches: [{ table: { schema: 'main', table: 't' }, columns: 'all', scope: { kind: 'full' } }],
			nonDeterministicSources: [],
			unboundParameters: [],
		};
		const sub = db.watch(scope, e => { events.push(e); });
		await db.exec('UPDATE t SET v = \'b\' WHERE id = 1');
		expect(events).to.have.length(1);
		expect(events[0].matched[0].hits).to.deep.equal([]);
		sub.unsubscribe();
	});

	it('unsubscribe stops further firings and is idempotent', async () => {
		await db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY) USING memory');
		const events: WatchEvent[] = [];
		const scope: ChangeScope = {
			watches: [{ table: { schema: 'main', table: 't' }, columns: 'all', scope: { kind: 'full' } }],
			nonDeterministicSources: [],
			unboundParameters: [],
		};
		const sub = db.watch(scope, e => { events.push(e); });
		await db.exec('INSERT INTO t VALUES (1)');
		expect(events).to.have.length(1);
		sub.unsubscribe();
		sub.unsubscribe(); // idempotent
		await db.exec('INSERT INTO t VALUES (2)');
		expect(events).to.have.length(1);
	});

	it('a watcher on a base table sees a view-mediated insert', async () => {
		// GreenMen / Bob: a watcher registered on the base table `Men` fires when
		// an insert routed through the view `GreenMen` lands the constant-FD row.
		await db.exec('CREATE TABLE Men (Name TEXT PRIMARY KEY, Color TEXT) USING memory');
		await db.exec("CREATE VIEW GreenMen AS SELECT * FROM Men WHERE Color = 'green'");
		const events: WatchEvent[] = [];
		const scope: ChangeScope = {
			watches: [{ table: { schema: 'main', table: 'Men' }, columns: 'all', scope: { kind: 'full' } }],
			nonDeterministicSources: [],
			unboundParameters: [],
		};
		const sub = db.watch(scope, e => { events.push(e); });
		await db.exec("INSERT INTO GreenMen (Name) VALUES ('Bob')");
		expect(events).to.have.length(1);
		sub.unsubscribe();
	});

	it('multi-table scope fires once per transaction with all matching watches', async () => {
		await db.exec('CREATE TABLE a (id INTEGER PRIMARY KEY) USING memory');
		await db.exec('CREATE TABLE b (id INTEGER PRIMARY KEY) USING memory');
		const events: WatchEvent[] = [];
		const scope: ChangeScope = {
			watches: [
				{ table: { schema: 'main', table: 'a' }, columns: 'all', scope: { kind: 'full' } },
				{ table: { schema: 'main', table: 'b' }, columns: 'all', scope: { kind: 'full' } },
			],
			nonDeterministicSources: [],
			unboundParameters: [],
		};
		const sub = db.watch(scope, e => { events.push(e); });

		await db.exec('BEGIN; INSERT INTO a VALUES (1); INSERT INTO b VALUES (1); COMMIT');
		expect(events).to.have.length(1);
		const matchedTables = events[0].matched.map(m => m.watch.table.table).sort();
		expect(matchedTables).to.deep.equal(['a', 'b']);
		sub.unsubscribe();
	});

	it('end-to-end: stmt.getChangeScope([id]) → db.watch fires for the prepared key', async () => {
		await db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT) USING memory');
		await db.exec('INSERT INTO t VALUES (42, \'old\')');
		const stmt = db.prepare('select v from t where id = ?');
		const scope = stmt.getChangeScope([42]);
		expect(scope.unboundParameters).to.deep.equal([]);
		const events: WatchEvent[] = [];
		const sub = db.watch(scope, e => { events.push(e); });
		await db.exec('UPDATE t SET v = \'new\' WHERE id = 42');
		expect(events).to.have.length(1);
		expect(events[0].matched[0].hits).to.deep.equal([[42]]);
		sub.unsubscribe();
		await stmt.finalize();
	});

	it('end-to-end: a watch on an MV fires on a SOURCE mutation', async () => {
		// The MV reference projects to its source, so the watch is registered on
		// `src` — a source mutation fires it (the MV's table is never directly
		// user-written; watching it would never fire).
		await db.exec('CREATE TABLE src (id INTEGER PRIMARY KEY, v TEXT) USING memory');
		await db.exec("INSERT INTO src VALUES (1, 'a')");
		await db.exec("CREATE MATERIALIZED VIEW mvi AS SELECT id, v FROM src");
		const stmt = db.prepare('select * from mvi');
		const scope = stmt.getChangeScope();
		expect(scope.watches.map(w => w.table.table)).to.deep.equal(['src']);
		const events: WatchEvent[] = [];
		const sub = db.watch(scope, e => { events.push(e); });
		await db.exec("INSERT INTO src VALUES (2, 'b')");
		expect(events).to.have.length(1);
		expect(events[0].matched.map(m => m.watch.table.table)).to.deep.equal(['src']);
		sub.unsubscribe();
		await stmt.finalize();
	});

	it('rejects scopes with unbound parameters', async () => {
		await db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY) USING memory');
		const stmt = db.prepare('select * from t where id = ?');
		const scope = stmt.getChangeScope();
		expect(scope.unboundParameters.length).to.be.greaterThan(0);
		expect(() => db.watch(scope, () => { /* */ })).to.throw(/bindParameters/);
		await stmt.finalize();
	});

	it('rejects scopes referencing a missing table', () => {
		const scope: ChangeScope = {
			watches: [{ table: { schema: 'main', table: 'absent' }, columns: 'all', scope: { kind: 'full' } }],
			nonDeterministicSources: [],
			unboundParameters: [],
		};
		expect(() => db.watch(scope, () => { /* */ })).to.throw(/main\.absent/);
	});

	it('accepts an empty / dead scope and never fires', async () => {
		await db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY) USING memory');
		const events: WatchEvent[] = [];
		const scope: ChangeScope = { watches: [], nonDeterministicSources: [], unboundParameters: [] };
		const sub = db.watch(scope, e => { events.push(e); });
		await db.exec('INSERT INTO t VALUES (1)');
		expect(events).to.have.length(0);
		sub.unsubscribe();
	});

	it('disposes subscription when its table is dropped (no fire on a re-created table)', async () => {
		await db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY) USING memory');
		const events: WatchEvent[] = [];
		const scope: ChangeScope = {
			watches: [{ table: { schema: 'main', table: 't' }, columns: 'all', scope: { kind: 'full' } }],
			nonDeterministicSources: [],
			unboundParameters: [],
		};
		const sub = db.watch(scope, e => { events.push(e); });
		await db.exec('INSERT INTO t VALUES (1)');
		expect(events).to.have.length(1);

		await db.exec('DROP TABLE t');
		await db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY) USING memory');
		await db.exec('INSERT INTO t VALUES (2)');
		// Subscription was invalidated by the table_removed event; no further fire.
		expect(events).to.have.length(1);

		// unsubscribe is still safe (idempotent) after auto-invalidation.
		sub.unsubscribe();
	});

	// Change tracking is fed the row the substrate STORED, not the raw values the
	// statement proposed (bug-dml-downstream-uses-uncoerced-row). Coercion happens
	// inside vtab.update(), so a watcher keyed on a coerced column only matches if
	// the executor records the post-coercion row.
	it("'rows' watch matches on the STORED key, not the raw proposed one", async () => {
		await db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT) USING memory');
		const events: WatchEvent[] = [];
		const sub = db.watch(handBuiltRowsScope('t', 'id', [[7]]), e => { events.push(e); });

		// TEXT '7' into an INTEGER-affinity PK stores as the number 7.
		await db.exec("INSERT INTO t VALUES ('7', 'seven')");
		expect(events).to.have.length(1);
		expect(events[0].matched[0].hits).to.deep.equal([[7]]);

		// The same coercion on the way out of an UPDATE that moves the key.
		await db.exec("UPDATE t SET id = '7' WHERE id = 7");
		expect(events).to.have.length(2);
		expect(events[1].matched[0].hits).to.deep.equal([[7]]);

		sub.unsubscribe();
	});

	it("'groups' watch reports the STORED group key for a coerced column", async () => {
		await db.exec('CREATE TABLE jw (id INTEGER PRIMARY KEY, j JSON) USING memory');
		const events: WatchEvent[] = [];
		const scope: ChangeScope = {
			watches: [{
				table: { schema: 'main', table: 'jw' },
				columns: new Set(['j']),
				scope: { kind: 'groups', groupBy: ['j'] },
			}],
			nonDeterministicSources: [],
			unboundParameters: [],
		};
		const sub = db.watch(scope, e => { events.push(e); });

		// The proposed value is TEXT; the stored value is a parsed JSON value, so
		// the group key a subscriber sees must not be the input string.
		await db.exec(`INSERT INTO jw VALUES (1, '{"a":1}')`);
		expect(events).to.have.length(1);
		const groupKey = events[0].matched[0].hits[0][0];
		expect(groupKey).to.not.equal('{"a":1}');
		expect(groupKey).to.deep.equal({ a: 1 });

		sub.unsubscribe();
	});

	it('accepts hand-built scope with non-lowercased schema/table names', async () => {
		// Hand-built scopes from external sources may not honor the lowercased
		// contract — the watcher must still resolve and fire.
		await db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY) USING memory');
		const events: WatchEvent[] = [];
		const scope: ChangeScope = {
			watches: [{ table: { schema: 'Main', table: 'T' }, columns: 'all', scope: { kind: 'full' } }],
			nonDeterministicSources: [],
			unboundParameters: [],
		};
		const sub = db.watch(scope, e => { events.push(e); });
		await db.exec('INSERT INTO t VALUES (1)');
		expect(events).to.have.length(1);
		sub.unsubscribe();
	});
});
