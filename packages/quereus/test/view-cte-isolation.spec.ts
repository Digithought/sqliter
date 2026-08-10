/**
 * A stored view body's naming environment includes the common-table-expression
 * (CTE) namespace, not only the schema search path (see
 * `view-home-schema.spec.ts` for the latter). Before the fix for
 * `bug-caller-cte-shadows-view-body`, a caller `with` clause whose name
 * matched a source the view's body read would silently shadow it — three
 * independent leak channels (the explicit `cteNodes` argument passed into the
 * body plan, `select-context.ts`'s fallback to `ctx.cteNodes` when that
 * argument was empty, and the shared, in-place-mutated `cteReferenceCache`).
 * `storedBodyContext` (`src/planner/stored-body-context.ts`) closes all three
 * by clearing both on the context a stored body plans under.
 */

import { expect } from 'chai';
import { Database } from '../src/core/database.js';

async function all(db: Database, sql: string): Promise<Record<string, unknown>[]> {
	const out: Record<string, unknown>[] = [];
	for await (const row of db.eval(sql)) out.push(row);
	return out;
}

describe('CTE namespace isolation for stored view bodies', () => {
	let db: Database;

	beforeEach(() => {
		db = new Database();
	});

	afterEach(async () => {
		await db.close();
	});

	it("does not let a caller `with` clause shadow a view's base table on read", async () => {
		await db.exec('create table main.lt (id integer primary key, x integer)');
		await db.exec('insert into main.lt values (1, 10)');
		await db.exec('create view main.lv as select id, x from lt');

		expect(await all(db, 'with lt as (select 1 as id, 999 as x) select * from lv'))
			.to.deep.equal([{ id: 1, x: 10 }]);
	});

	it("does not let a caller `with` clause shadow a view's base table on update", async () => {
		await db.exec('create table main.lt (id integer primary key, x integer)');
		await db.exec('insert into main.lt values (1, 10)');
		await db.exec('create view main.lv as select id, x from lt');

		await db.exec('with lt as (select 1 as id, 999 as x) update lv set x = 5 where id = 1');
		expect(await all(db, 'select id, x from main.lt')).to.deep.equal([{ id: 1, x: 5 }]);
	});

	it("does not let a caller `with` clause shadow a view's base table on delete", async () => {
		await db.exec('create table main.lt (id integer primary key, x integer)');
		await db.exec('insert into main.lt values (1, 10)');
		await db.exec('create view main.lv as select id, x from lt');

		await db.exec('with lt as (select 1 as id, 999 as x) delete from lv where id = 1');
		expect(await all(db, 'select id, x from main.lt')).to.deep.equal([]);
	});

	it('isolates a nested caller CTE that itself reads the view', async () => {
		await db.exec('create table main.lt (id integer primary key, x integer)');
		await db.exec('insert into main.lt values (1, 10)');
		await db.exec('create view main.lv as select id, x from lt');

		expect(await all(db, 'with lt as (select 1 as id, 999 as x), q as (select * from lv) select * from q'))
			.to.deep.equal([{ id: 1, x: 10 }]);
	});

	it("isolates the view's OWN body-local CTE from a same-named caller CTE referenced in the caller's own FROM", async () => {
		// This is the third, independently-discovered leak channel: the shared
		// `cteReferenceCache` is keyed by bare `cteName:alias`, so a caller CTE `c`
		// and the view body's own CTE `c` collided on the same cache entry even
		// after the `cteNodes` map itself was isolated.
		await db.exec('create table main.ct (id integer primary key, x integer)');
		await db.exec('insert into main.ct values (1, 10)');
		await db.exec('create view main.cv as with c as (select id, x from ct) select id, x from c');

		expect(await all(db,
			'with c as (select 1 as id, 777 as x) select c.id, c.x, (select x from cv) as vx from c'))
			.to.deep.equal([{ id: 1, x: 777, vx: 10 }]);
	});

	it("still resolves a view's own body-local `with` clause", async () => {
		await db.exec('create table main.bt (id integer primary key, x integer)');
		await db.exec('insert into main.bt values (1, 10)');
		await db.exec('create view main.bv as with c as (select id, x from bt) select id, x from c');

		expect(await all(db, 'select * from bv')).to.deep.equal([{ id: 1, x: 10 }]);
	});

	it("keeps an ephemeral CTE-name write target reading the caller's own CTE", async () => {
		await db.exec('create table main.et (id integer primary key, x integer)');
		await db.exec('insert into main.et values (1, 1)');
		await db.exec('with c as (select id, x from et) update c set x = 99 where id = 1');
		expect(await all(db, 'select id, x from main.et')).to.deep.equal([{ id: 1, x: 99 }]);
	});

	it("keeps the caller's own WHERE subquery seeing the caller's CTEs when writing through a view", async () => {
		await db.exec('create table main.lt (id integer primary key, x integer)');
		await db.exec('insert into main.lt values (1, 10), (2, 20)');
		await db.exec('create view main.lv as select id, x from lt');

		await db.exec('with k as (select 1 as id) update lv set x = 0 where id in (select id from k)');
		expect(await all(db, 'select id, x from main.lt order by id'))
			.to.deep.equal([{ id: 1, x: 0 }, { id: 2, x: 20 }]);
	});

	it('leaves an insert … returning through a view unaffected by an unrelated caller `with` clause', async () => {
		await db.exec('create table main.rt (id integer primary key, x integer)');
		await db.exec('create view main.rv as select id, x from rt');

		expect(await all(db, 'with dummy as (select 1 as id) insert into rv (id, x) values (2, 20) returning id, x'))
			.to.deep.equal([{ id: 2, x: 20 }]);
	});

	it('isolates the body of a view read through a second view', async () => {
		// Both bodies read `nt`; the caller shadows it. Every nesting level plans
		// under its own `storedBodyContext`, so neither body sees the caller CTE.
		await db.exec('create table main.nt (id integer primary key, x integer)');
		await db.exec('insert into main.nt values (1, 10)');
		await db.exec('create view main.inner_v as select id, x from nt');
		await db.exec('create view main.outer_v as select v.id, v.x + (select x from nt where id = 1) as x from inner_v v');

		expect(await all(db, 'with nt as (select 1 as id, 999 as x) select * from outer_v'))
			.to.deep.equal([{ id: 1, x: 20 }]);
	});

	it('does not let a caller `with` clause mask a stale materialized view', async () => {
		// The stale-MV re-validation in `select.ts` re-plans the derivation to decide
		// whether the staleness is recoverable. A caller CTE that resolves the name the
		// body can no longer resolve would make an unplannable body look healthy and
		// serve the stale rows instead of raising.
		await db.exec('create table main.st (id integer primary key, x integer)');
		await db.exec('insert into main.st values (1, 10)');
		await db.exec('create materialized view main.smv as select id, x from st');
		await db.exec('drop table main.st');

		let message = '';
		try {
			await all(db, 'with st as (select 1 as id, 999 as x) select * from smv');
		} catch (e) {
			message = e instanceof Error ? e.message : String(e);
		}
		expect(message).to.match(/stale/i);
	});

	// --- sub-selects copied out of the body by the write-through lowering ---
	//
	// `bug-view-write-subquery-in-body-uses-caller-schema`, arm 3. The lowering copies the
	// view's own `where` into a base statement planned on the CALLER's context, so a
	// sub-select inside it used to see the caller's `with` clause — with no schema setup at
	// all. `main.ls` holds id 1 and the caller CTE holds id 2, so a leak makes the lowered
	// UPDATE / DELETE match nothing and silently report success.

	async function seedBodySubqueryView(db: Database): Promise<void> {
		await db.exec('create table main.lt (id integer primary key, x integer)');
		await db.exec('create table main.ls (id integer primary key)');
		await db.exec('insert into main.lt values (1, 10)');
		await db.exec('insert into main.ls values (1)');
		await db.exec('create view main.lv as select id, x from lt where id in (select id from ls)');
	}

	it("does not let a caller `with` clause bind a sub-select in the view's body on update", async () => {
		await seedBodySubqueryView(db);

		await db.exec('with ls as (select 2 as id) update lv set x = 99 where id = 1');
		expect(await all(db, 'select id, x from main.lt')).to.deep.equal([{ id: 1, x: 99 }]);
	});

	it("does not let a caller `with` clause bind a sub-select in the view's body on delete", async () => {
		await seedBodySubqueryView(db);

		await db.exec('with ls as (select 2 as id) delete from lv where id = 1');
		expect(await all(db, 'select id, x from main.lt')).to.deep.equal([]);
	});

	it("still binds a caller CTE the user's OWN predicate sub-select reads, in the same statement", async () => {
		// The negative control for the two above: one statement, one caller `with` clause
		// holding BOTH a name the body reads (`ls` — must not bind) and a name only the
		// user's predicate reads (`k` — must bind).
		await seedBodySubqueryView(db);
		await db.exec('insert into main.lt values (2, 20)');
		await db.exec('insert into main.ls values (2)');

		await db.exec('with ls as (select 99 as id), k as (select 1 as id) '
			+ 'update lv set x = 0 where id in (select id from k)');
		expect(await all(db, 'select id, x from main.lt order by id'))
			.to.deep.equal([{ id: 1, x: 0 }, { id: 2, x: 20 }]);
	});

	it('leaves a materialized-view read unaffected by a caller `with` clause shadowing its source', async () => {
		await db.exec('create table main.mt (id integer primary key, x integer)');
		await db.exec('insert into main.mt values (1, 10)');
		await db.exec('create materialized view main.mv as select id, x from mt');

		expect(await all(db, 'with mt as (select 1 as id, 999 as x) select * from mv'))
			.to.deep.equal([{ id: 1, x: 10 }]);
	});
});

/**
 * The other half of the same seam (`bug-view-write-body-cte-not-carried-into-lowering`).
 * Re-entering the body's home naming environment clears the CALLER's CTE namespace — the
 * fix above — but the body's OWN `with` clause was not carried along, so a fragment the
 * lowering copies out of the body (its `where`, a column's defining expression, a
 * `with inverse` put, a `with defaults` value) that read a body-local block had nothing to
 * bind to. Two failure modes: `Table 'c' not found` when no such object exists, and — the
 * severe one — a silent no-op write when a REAL table of that name does exist, so the read
 * and the write of one view disagreed about which relation `c` names.
 *
 * The body's `with` clause now rides the same stamp as the home schema
 * (`AST.StoredBodyEnv.withClause`, on `AST.SelectStmt.storedBodyEnv`), and
 * `buildSelectStmt` builds those definitions on the home context as the fragment's parent
 * CTE namespace (`buildStoredBodyCTEs`, `building/select-context.ts`).
 */
describe('a stored view body carries its own `with` clause into write-through lowering', () => {
	let db: Database;

	beforeEach(async () => {
		db = new Database();
		await db.exec('create table main.a (id integer primary key, x integer)');
		await db.exec('create table main.b (id integer primary key)');
		await db.exec('insert into main.a values (1, 10)');
		await db.exec('insert into main.b values (1)');
	});

	afterEach(async () => {
		await db.close();
	});

	// --- one case per channel that copies a fragment out of the body ---

	it("resolves a body-local block read by the body's own `where`, on update", async () => {
		await db.exec('create view main.vc as with c as (select id from b) select id, x from a where id in (select id from c)');

		expect(await all(db, 'select * from main.vc')).to.deep.equal([{ id: 1, x: 10 }]);
		await db.exec('update main.vc set x = 99 where id = 1');
		expect(await all(db, 'select id, x from main.a')).to.deep.equal([{ id: 1, x: 99 }]);
	});

	it("resolves a body-local block read by the body's own `where`, on delete", async () => {
		await db.exec('create view main.vc as with c as (select id from b) select id, x from a where id in (select id from c)');

		await db.exec('delete from main.vc where id = 1');
		expect(await all(db, 'select id, x from main.a')).to.deep.equal([]);
	});

	it("resolves a body-local block read by a view column's defining expression", async () => {
		// The user `where` names `n`, so the lowering pulls that column's defining
		// expression — which reads `c` — into the base UPDATE.
		await db.exec('create view main.vn as with c as (select id from b) select id, x, (select count(*) from c) as n from a');

		await db.exec('update main.vn set x = 55 where n = 1');
		expect(await all(db, 'select id, x from main.a')).to.deep.equal([{ id: 1, x: 55 }]);
	});

	it('resolves a body-local block read by an authored `with inverse` put expression', async () => {
		await db.exec('create view main.vi as with c as (select 5 as k from b) '
			+ 'select id, x + (select max(k) from c) as y with inverse (x = new.y - (select max(k) from c)) from a');

		await db.exec('update main.vi set y = 20 where id = 1');
		expect(await all(db, 'select id, x from main.a')).to.deep.equal([{ id: 1, x: 15 }]);
	});

	it('resolves a body-local block read by a `with defaults` value on insert', async () => {
		await db.exec('create view main.vdf as with c as (select 7 as k from b) '
			+ 'select id, x from a with defaults (x = (select max(k) from c))');

		await db.exec('insert into main.vdf (id) values (3)');
		expect(await all(db, 'select id, x from main.a order by id'))
			.to.deep.equal([{ id: 1, x: 10 }, { id: 3, x: 7 }]);
	});

	it('resolves a body-local block on a write through a materialized view', async () => {
		await db.exec('create materialized view main.mv as with c as (select id from b) '
			+ 'select id, x from a where id in (select id from c)');

		await db.exec('update main.mv set x = 88 where id = 1');
		expect(await all(db, 'select id, x from main.a')).to.deep.equal([{ id: 1, x: 88 }]);
	});

	it('resolves a RECURSIVE body-local block', async () => {
		await db.exec('create view main.vr as with recursive r(n) as '
			+ '(select 1 union all select n + 1 from r where n < 3) '
			+ 'select id, x from a where id in (select n from r)');

		await db.exec('update main.vr set x = 33 where id = 1');
		expect(await all(db, 'select id, x from main.a')).to.deep.equal([{ id: 1, x: 33 }]);
	});

	it('resolves a body-local block that references an earlier sibling block', async () => {
		await db.exec('create view main.vs2 as with c1 as (select id from b), c2 as (select id from c1) '
			+ 'select id, x from a where id in (select id from c2)');

		await db.exec('update main.vs2 set x = 44 where id = 1');
		expect(await all(db, 'select id, x from main.a')).to.deep.equal([{ id: 1, x: 44 }]);
	});

	// --- arm 2: the silent no-op, where a REAL table shadows the body-local name ---

	describe('a body-local block wins over a same-named real table (as it does on read)', () => {
		beforeEach(async () => {
			// A real `main.c` holding a DIFFERENT id than the body-local block does. Before
			// the carry the lowered statement bound THIS table, so the write matched no row
			// and reported success while the read of the same view returned the row.
			await db.exec('create table main.c (id integer primary key)');
			await db.exec('insert into main.c values (2)');
			await db.exec('create view main.vs as with c as (select id from b) select id, x from a where id in (select id from c)');
		});

		it('reads the row through the body-local block', async () => {
			expect(await all(db, 'select * from main.vs')).to.deep.equal([{ id: 1, x: 10 }]);
		});

		it('updates the row rather than silently writing nothing', async () => {
			await db.exec('update main.vs set x = 42 where id = 1');
			expect(await all(db, 'select id, x from main.a')).to.deep.equal([{ id: 1, x: 42 }]);
		});

		it('deletes the row rather than silently writing nothing', async () => {
			await db.exec('delete from main.vs where id = 1');
			expect(await all(db, 'select id, x from main.a')).to.deep.equal([]);
		});
	});

	// --- precedence: what the carried namespace beats, and what beats it ---

	it("does not let a CALLER `with` clause of the same name displace the body's block", async () => {
		// The other half of the sibling fix (`bug-caller-cte-shadows-view-body`) meeting this
		// one: the caller's namespace is REPLACED by the body's, not merged with it, so a
		// caller `c` holding a different id must not steer the lowered statement.
		await db.exec('create view main.vc as with c as (select id from b) select id, x from a where id in (select id from c)');

		await db.exec('with c as (select 999 as id) update main.vc set x = 51 where id = 1');
		expect(await all(db, 'select id, x from main.a')).to.deep.equal([{ id: 1, x: 51 }]);
	});

	it("lets a copied fragment's OWN `with` clause shadow a same-named body-local block", async () => {
		// The carried definitions are the fragment's PARENT namespace, so `buildWithContext`
		// merges the fragment's own clause on top. Both `c`s select id 1 here, so the write
		// succeeds either way — the pin is that the fragment-local definition binds at all
		// rather than colliding with the carried one.
		await db.exec('create view main.vo as with c as (select id from b) '
			+ 'select id, x from a where id in (with c as (select 1 as id) select id from c)');

		await db.exec('update main.vo set x = 52 where id = 1');
		expect(await all(db, 'select id, x from main.a')).to.deep.equal([{ id: 1, x: 52 }]);
	});

	it('resolves a body-local block inside a SET-OPERATION body branch', async () => {
		// The per-branch synthetic view-likes a set-op spine builds inherit the stamp from the
		// one `mapNestedSelects` call, so a branch predicate reading a body-local block resolves
		// through the same carry. Only the left branch reads `c`.
		await db.exec('create table main.a2 (id integer primary key, x integer)');
		await db.exec('insert into main.a2 values (2, 20)');
		await db.exec('create view main.vso as with c as (select id from b) '
			+ "select id, x, 'l' as kind from a where id in (select id from c) "
			+ "union all select id, x, 'r' as kind from a2");

		await db.exec("update main.vso set x = 53 where kind = 'l' and id = 1");
		expect(await all(db, 'select id, x from main.a')).to.deep.equal([{ id: 1, x: 53 }]);
		expect(await all(db, 'select id, x from main.a2')).to.deep.equal([{ id: 2, x: 20 }]);
	});

	// --- sharing: two fragments referencing one block get ONE plan node ---

	it('evaluates a block referenced by two fragments once, not once per fragment', async () => {
		// `bump()` is non-deterministic (the `createScalarFunction` default), so the engine
		// cannot hoist or fold it: every evaluation is a distinct call. Both the body's own
		// `where` and the `n` column's defining expression read `c`, and the user `where`
		// names `n`, so the lowering copies BOTH fragments. One shared `CTENode` (the
		// per-lowering memo) ⇒ the multi-reference advisory materializes it ⇒ one call.
		// Per-fragment building would give two independently-evaluated copies.
		let calls = 0;
		db.createScalarFunction('bump', { numArgs: 0 }, () => { calls++; return 1; });
		await db.exec('create view main.vb as with c as (select bump() as k from b) '
			+ 'select id, x, (select max(k) from c) as n from a where (select max(k) from c) > 0');

		calls = 0;
		await db.exec('update main.vb set x = 77 where n > 0');
		expect(calls, 'the shared body-local block must be evaluated once per statement').to.equal(1);
		expect(await all(db, 'select id, x from main.a')).to.deep.equal([{ id: 1, x: 77 }]);
	});

	// --- regression pins for the two shapes that were already correct ---

	it('still rejects a body whose FROM source IS a body-local block', async () => {
		await db.exec('create view main.vf as with c as (select id, 1 as x from b) select id, x from c');

		let message = '';
		try {
			await db.exec('update main.vf set x = 5 where id = 1');
		} catch (e) {
			message = e instanceof Error ? e.message : String(e);
		}
		expect(message).to.match(/CTEReference/);
	});

	it('still writes through a view whose body-local block no fragment references', async () => {
		await db.exec('create view main.vu as with c as (select id from b) select id, x from a where x > 0');

		await db.exec('update main.vu set x = 66 where id = 1');
		expect(await all(db, 'select id, x from main.a')).to.deep.equal([{ id: 1, x: 66 }]);
	});

	// --- guard: a data-modifying body-local block is rejected, and advertised as such ---

	describe('a data-modifying body-local block', () => {
		beforeEach(async () => {
			// Reading such a view already executes the insert once per read; carrying the
			// definitions would make a WRITE execute it too, and the shared plan node makes a
			// two-fragment reference fail inside the runtime. Rejected up front instead.
			await db.exec('create table main.logt (k integer primary key)');
			// `create view` no longer accepts this body — `buildWithClause` rejects a
			// data-modifying member outside a statement's own leading clause (see the
			// definition-time test below). The shape can still reach the catalog from a
			// definition persisted by an older build, which is what `importCatalog` models
			// here: import does not plan a plain view's body. The write-through guard and
			// `view_info` predicate below are that path's backstop, so they stay pinned.
			await db.schemaManager.importCatalog([
				'create view main.vm as with m as (insert into logt (k) values (1) returning k) '
				+ 'select id, x from a where id in (select k from m)',
			]);
		});

		it('is rejected at definition time by CREATE VIEW', async () => {
			let message = '';
			try {
				await db.exec('create view main.vdml as with m as (insert into logt (k) values (9) returning k) '
					+ 'select id, x from a where id in (select k from m)');
			} catch (e) {
				message = e instanceof Error ? e.message : String(e);
			}
			expect(message).to.match(/only allowed in a statement's own leading WITH clause/);
			// The rejection happens while planning the body, so nothing was written.
			expect(await all(db, 'select count(*) as n from main.logt')).to.deep.equal([{ n: 0 }]);
		});

		it('rejects a write through it with a structured diagnostic', async () => {
			let message = '';
			try {
				await db.exec('update main.vm set x = 1 where id = 1');
			} catch (e) {
				message = e instanceof Error ? e.message : String(e);
			}
			expect(message).to.match(/cannot write through view 'vm'/);
			expect(message).to.match(/data-modifying statement \(insert\)/);
		});

		it('is reported non-writable by view_info()', async () => {
			expect(await all(db, "select is_insertable_into, is_updatable, is_deletable from view_info() where name = 'vm'"))
				.to.deep.equal([{ is_insertable_into: 'NO', is_updatable: 'NO', is_deletable: 'NO' }]);
		});

		it('is rejected even when no copied fragment references it', async () => {
			// A deliberate narrowing, pinned so it is a decision and not a drift: the guard keys
			// on the shape of the body, not on whether the lowering actually copies a fragment
			// that reads the block. Writing through this view used to succeed. `view_info`
			// answers from the same predicate, so the advertised writability agrees.
			// Imported rather than created, for the same reason as `vm` above.
			await db.schemaManager.importCatalog([
				'create view main.vmu as with m as (insert into logt (k) values (2) returning k) '
				+ 'select id, x from a where x > 0',
			]);

			let message = '';
			try {
				await db.exec('update main.vmu set x = 1 where id = 1');
			} catch (e) {
				message = e instanceof Error ? e.message : String(e);
			}
			expect(message).to.match(/cannot write through view 'vmu'/);
			expect(await all(db, "select is_updatable from view_info() where name = 'vmu'"))
				.to.deep.equal([{ is_updatable: 'NO' }]);
		});
	});
});
