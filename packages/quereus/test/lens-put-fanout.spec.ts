/**
 * Decomposition **put** fan-out (docs/lens.md § The Default Mapper, ticket
 * `lens-multi-source-put-fanout`).
 *
 * A logical table backed by a `primary-storage` decomposition advertisement is
 * registered as a view whose body is the synthesized `anchor ⋈ members` join;
 * `propagate()` routes its writes to the advertisement-driven fan-out
 * (`planner/mutation/decomposition.ts`) instead of the generic two-table join
 * path. Shipped fan-out:
 *
 * - DELETE across every member (anchor-last, anchor-resolvable predicate — an anchor
 *   identity column or a computed mapping whose basis lives on the anchor).
 * - UPDATE routed to the member backing each column: a mandatory, non-EAV member takes
 *   one base UPDATE; an **optional** columnar member's write is a per-row materialization
 *   transition routed by the assigned **value shape** — a **constant** (matched → base
 *   UPDATE, absent → `on conflict do nothing` materialize INSERT, all value columns null →
 *   base DELETE); an **anchor-resolvable** value (`set c = a + 1`) collapsing both branches
 *   into one `on conflict do update set c = excluded.c` upsert; a **self-reference**
 *   (`set c = c + 1`, `set c = coalesce(c, 0) + 1`) keeping the matched UPDATE for present rows
 *   and adding a null-substituted, non-empty-filtered materialize INSERT for absent rows (a
 *   null-propagating expression materializes nothing; one that maps null → non-null does). An **EAV pivot**
 *   member's write is the per-attribute triple analogue (null → delete, anchor-resolvable →
 *   `do update` upsert, constant → matched UPDATE + `do nothing` materialize INSERT).
 * - INSERT one per member (anchor first) off the shared-surrogate envelope
 *   (`view-mutation-shared-surrogate-insert`): a surrogate sourced from the anchor key
 *   column's declared `default` (evaluated once per row, with `mutation_ordinal()` in
 *   scope) and threaded via the EC, or a logical-tuple PK threaded straight through;
 *   optional members gated per-row on a supplied value; EAV pivots emit one triple per
 *   supplied attribute; singleton over the empty key.
 *
 * An **arbitrary** value written to an *optional columnar* member (a subquery, a cross-member
 * column, or a value mixing anchor + self leaves) is admitted via the **single-identity
 * (anchor-key) per-row capture**: it is materialized once over the planned get body (which
 * null-extends an absent optional member, so the captured value already encodes per-row presence)
 * into the multi-source `__vmupd_keys` substrate, the matched UPDATE reads it back by the member
 * key and a filtered materialize INSERT by the anchor key, gated on a runtime non-null. Capturing
 * pre-mutation is what makes a both-sides write (`set c = b + 1, b = b + 100`) read `c` from the
 * pre-mutation `b`. The two self-contained non-constant shapes — anchor-resolvable and member
 * self-reference — keep their tighter single-op / self-materialize lowering.
 *
 * An **arbitrary value written to an EAV member** (a subquery, cross-member, anchor+self mix, or any
 * EAV self-reference — which lowers to a subquery, since an EAV value column projects as a correlated
 * subquery) rides the **same** capture, per attribute: the captured value substitutes the get-body
 * projection over the anchor scan, the matched UPDATE reads it back by the entity column, and a
 * non-null-filtered materialize INSERT reads it back by the anchor key (`on conflict (entity, attr)
 * do nothing`). A captured null on a matched triple writes `val = null` (reads identically to absent
 * through `x.E`); a captured null on an absent entity materializes no phantom triple.
 *
 * Still deferred onto absent substrate (asserted to raise a precise diagnostic): a
 * non-anchor-predicate DELETE/UPDATE (snapshot-consistent multi-member execution), a
 * shared-key (identity) UPDATE, and a composite/absent shared key.
 */

import { expect } from 'chai';
import { Database } from '../src/index.js';
import { MemoryTableModule } from '../src/vtab/memory/module.js';
import type { Database as DatabaseType } from '../src/core/database.js';
import type { Schema } from '../src/schema/schema.js';
import type { MappingAdvertisement, LogicalColumnMapping } from '../src/vtab/mapping-advertisement.js';
import type * as AST from '../src/parser/ast.js';
import { astToString } from '../src/emit/ast-stringify.js';
import { collectLensRowLocalConstraints } from '../src/planner/mutation/lens-enforcement.js';
import { BuildTimeDependencyTracker, type PlanningContext } from '../src/planner/planning-context.js';
import { GlobalScope } from '../src/planner/scopes/global.js';
import { ParameterScope } from '../src/planner/scopes/param.js';
import type { LensSlot } from '../src/schema/lens.js';

/**
 * A minimal {@link PlanningContext} for the direct `collectLensRowLocalConstraints`
 * unit calls in the subquery-CHECK rewrite tests — the scope-aware rewrite needs a
 * context to resolve subquery FROM column names.
 */
function makeCtx(db: Database): PlanningContext {
	return {
		db,
		schemaManager: db.schemaManager,
		parameters: {},
		scope: new ParameterScope(new GlobalScope(db.schemaManager)),
		cteNodes: new Map(),
		schemaDependencies: new BuildTimeDependencyTracker(),
		schemaCache: new Map(),
		cteReferenceCache: new Map(),
		outputScopes: new Map(),
	};
}

/** The lens slot for logical table `x.<table>` (asserts it exists). */
function slotX(db: Database, table: string): LensSlot {
	const s = db.schemaManager.getSchema('x')!.getLensSlot(table);
	expect(s, `lens slot for x.${table}`).to.not.be.undefined;
	return s!;
}

async function rows(db: Database, sql: string): Promise<Array<Record<string, unknown>>> {
	const out: Array<Record<string, unknown>> = [];
	for await (const r of db.eval(sql)) out.push(r as Record<string, unknown>);
	return out;
}

async function expectThrows(fn: () => Promise<unknown>, matcher: RegExp): Promise<void> {
	let threw = false;
	try {
		await fn();
	} catch (e) {
		threw = true;
		const msg = e instanceof Error ? e.message : String(e);
		expect(msg, `error message should match ${matcher}`).to.match(matcher);
	}
	expect(threw, 'expected the operation to throw').to.be.true;
}

/** A memory module that advertises whatever decomposition a test assigns. */
class AdvertisingModule extends MemoryTableModule {
	ads: MappingAdvertisement[] = [];
	override getMappingAdvertisements(_db: DatabaseType, _basis: Schema): readonly MappingAdvertisement[] {
		return this.ads;
	}
}

function colMap(logicalColumn: string, basisCol: string): LogicalColumnMapping {
	return { logicalColumn, basisExpr: { type: 'column', name: basisCol } };
}

function keyMap(...entries: Array<[string, readonly string[]]>): ReadonlyMap<string, readonly string[]> {
	return new Map<string, readonly string[]>(entries);
}

/**
 * Columnar split over main.T_core (anchor: id,a), main.T_b (mandatory: b),
 * main.T_c (optional: c), keyed by the logical PK `id`.
 */
function split(): MappingAdvertisement {
	return {
		id: 'T_core',
		logicalTable: 'T',
		role: 'primary-storage',
		storage: {
			anchorRelationId: 'T_core',
			members: [
				{ relationId: 'T_core', relation: { schema: 'main', table: 'T_core' }, presence: 'mandatory', columns: [colMap('id', 'id'), colMap('a', 'a')] },
				{ relationId: 'T_b', relation: { schema: 'main', table: 'T_b' }, presence: 'mandatory', columns: [colMap('b', 'b')] },
				{ relationId: 'T_c', relation: { schema: 'main', table: 'T_c' }, presence: 'optional', columns: [colMap('c', 'c')] },
			],
			sharedKey: { kind: 'logical-tuple', keyColumnsByRelation: keyMap(['T_core', ['id']], ['T_b', ['id']], ['T_c', ['id']]) },
		},
	};
}

/** Deploys the split lens + seeds two logical rows (row 2 has no optional T_c). */
async function setup(db: Database): Promise<void> {
	const mod = new AdvertisingModule();
	mod.ads = [split()];
	db.registerModule('admod', mod);
	await db.exec('create table T_core (id integer primary key, a integer) using admod');
	await db.exec('create table T_b (id integer primary key, b integer) using admod');
	await db.exec('create table T_c (id integer primary key, c integer) using admod');
	await db.exec('declare logical schema x { table T { id integer primary key, a integer, b integer, c integer null } }');
	await db.exec('apply schema x');

	await db.exec('insert into main.T_core values (1, 10), (2, 20)');
	await db.exec('insert into main.T_b values (1, 100), (2, 200)');
	await db.exec('insert into main.T_c values (1, 1000)');
}

describe('lens decomposition put: read-through baseline', () => {
	it('reads the synthesized join (optional member null when absent)', async () => {
		const db = new Database();
		try {
			await setup(db);
			expect(await rows(db, 'select * from x.T order by id')).to.deep.equal([
				{ id: 1, a: 10, b: 100, c: 1000 },
				{ id: 2, a: 20, b: 200, c: null },
			]);
		} finally {
			await db.close();
		}
	});
});

describe('lens decomposition put: DELETE fan-out', () => {
	it('delete by key reaches every member', async () => {
		const db = new Database();
		try {
			await setup(db);
			await db.exec('delete from x.T where id = 1');
			expect(await rows(db, 'select id from main.T_core order by id')).to.deep.equal([{ id: 2 }]);
			expect(await rows(db, 'select id from main.T_b order by id')).to.deep.equal([{ id: 2 }]);
			expect(await rows(db, 'select id from main.T_c order by id')).to.deep.equal([]);
			expect(await rows(db, 'select * from x.T order by id')).to.deep.equal([{ id: 2, a: 20, b: 200, c: null }]);
		} finally {
			await db.close();
		}
	});

	it('delete by an anchor column reaches every member', async () => {
		const db = new Database();
		try {
			await setup(db);
			await db.exec('delete from x.T where a = 20');
			expect(await rows(db, 'select id from main.T_core order by id')).to.deep.equal([{ id: 1 }]);
			expect(await rows(db, 'select id from main.T_b order by id')).to.deep.equal([{ id: 1 }]);
			expect(await rows(db, 'select id from main.T_c order by id')).to.deep.equal([{ id: 1 }]);
		} finally {
			await db.close();
		}
	});

	it('delete with no WHERE truncates every member', async () => {
		const db = new Database();
		try {
			await setup(db);
			await db.exec('delete from x.T');
			expect(await rows(db, 'select id from main.T_core')).to.deep.equal([]);
			expect(await rows(db, 'select id from main.T_b')).to.deep.equal([]);
			expect(await rows(db, 'select id from main.T_c')).to.deep.equal([]);
		} finally {
			await db.close();
		}
	});

	it('delete filtered on a non-anchor member is deferred (snapshot-consistent execution)', async () => {
		const db = new Database();
		try {
			await setup(db);
			await expectThrows(() => db.exec('delete from x.T where b = 100'), /non-anchor decomposition member/i);
			// Atomic: nothing deleted.
			expect(await rows(db, 'select id from main.T_b order by id')).to.deep.equal([{ id: 1 }, { id: 2 }]);
		} finally {
			await db.close();
		}
	});

	it('rejects a WHERE on an unknown column as an encapsulation leak (not a non-anchor member)', async () => {
		// A name the logical table does not expose is a user error (typo / projected-away
		// base column), guarded the same way the single-source / multi-source paths guard
		// it — `unknown-view-column`, NOT the "non-anchor decomposition member" deferral.
		const db = new Database();
		try {
			await setup(db);
			await expectThrows(() => db.exec('delete from x.T where notacol = 1'), /not a column of the logical table/i);
			// Atomic: nothing deleted.
			expect(await rows(db, 'select id from main.T_core order by id')).to.deep.equal([{ id: 1 }, { id: 2 }]);
		} finally {
			await db.close();
		}
	});
});

describe('lens decomposition put: UPDATE fan-out', () => {
	it('updates the anchor-backed column', async () => {
		const db = new Database();
		try {
			await setup(db);
			await db.exec('update x.T set a = 99 where id = 2');
			expect(await rows(db, 'select id, a from main.T_core order by id')).to.deep.equal([{ id: 1, a: 10 }, { id: 2, a: 99 }]);
			expect(await rows(db, 'select a from x.T where id = 2')).to.deep.equal([{ a: 99 }]);
		} finally {
			await db.close();
		}
	});

	it('routes an update to a mandatory non-anchor member', async () => {
		const db = new Database();
		try {
			await setup(db);
			await db.exec('update x.T set b = 999 where id = 1');
			expect(await rows(db, 'select id, b from main.T_b order by id')).to.deep.equal([{ id: 1, b: 999 }, { id: 2, b: 200 }]);
		} finally {
			await db.close();
		}
	});

	it('updates several members in one statement', async () => {
		const db = new Database();
		try {
			await setup(db);
			await db.exec('update x.T set a = 11, b = 111 where id = 1');
			expect(await rows(db, 'select * from x.T where id = 1')).to.deep.equal([{ id: 1, a: 11, b: 111, c: 1000 }]);
		} finally {
			await db.close();
		}
	});

	it('allows a self-member value reference but rejects a cross-member one', async () => {
		// A SET value may read the column's own member (rewritten + alias-stripped to
		// a bare reference on the per-member UPDATE), but a reference to a *different*
		// member is a cross-source assignment a single-table SET cannot express.
		const db = new Database();
		try {
			await setup(db);
			await db.exec('update x.T set b = b + 1 where id = 1');           // self-member: T_b.b
			expect(await rows(db, 'select b from main.T_b where id = 1')).to.deep.equal([{ b: 101 }]);
			await db.exec('update x.T set a = a * 2 where id = 2');           // self-member: T_core.a
			expect(await rows(db, 'select a from main.T_core where id = 2')).to.deep.equal([{ a: 40 }]);
			await expectThrows(() => db.exec('update x.T set a = b + 1 where id = 1'), /cross-member assignment/i); // anchor <- non-anchor
			await expectThrows(() => db.exec('update x.T set b = a + 1 where id = 1'), /cross-member assignment/i); // non-anchor <- anchor
		} finally {
			await db.close();
		}
	});

	it('materializes / updates / deletes an optional member per row', async () => {
		const db = new Database();
		try {
			await setup(db);
			// matched (row 1 has a T_c row) → base UPDATE.
			await db.exec('update x.T set c = 5 where id = 1');
			expect(await rows(db, 'select c from main.T_c where id = 1')).to.deep.equal([{ c: 5 }]);
			// absent (row 2 has no T_c) → null-extended materialization INSERT (anchor key
			// threads the member key).
			await db.exec('update x.T set c = 7 where id = 2');
			expect(await rows(db, 'select id, c from main.T_c order by id')).to.deep.equal([{ id: 1, c: 5 }, { id: 2, c: 7 }]);
			expect(await rows(db, 'select c from x.T where id = 2')).to.deep.equal([{ c: 7 }]);
			// all value columns null (T_c's only value column is c) → DELETE the component
			// row; the view still reads null for an absent optional member.
			await db.exec('update x.T set c = null where id = 1');
			expect(await rows(db, 'select id from main.T_c order by id')).to.deep.equal([{ id: 2 }]);
			expect(await rows(db, 'select c from x.T where id = 1')).to.deep.equal([{ c: null }]);
			// null write to an already-absent component is a clean no-op (id=1 just deleted).
			await db.exec('update x.T set c = null where id = 1');
			expect(await rows(db, 'select id from main.T_c order by id')).to.deep.equal([{ id: 2 }]);
		} finally {
			await db.close();
		}
	});

	it('writes an anchor-resolvable optional-member value via the upsert (present updates, absent materializes)', async () => {
		// `set c = a + 1` lowers to `T_core.a + 1` — every leaf is an anchor base column, so the
		// value is computed once over the anchor scan and the matched-update and materialize-insert
		// branches collapse into one `on conflict (id) do update set c = excluded.c` upsert. A
		// present row updates; an absent row materializes the anchor-computed value.
		const db = new Database();
		try {
			await setup(db);
			// present (row 1 has a T_c row, a = 10) → c = a + 1 = 11.
			await db.exec('update x.T set c = a + 1 where id = 1');
			expect(await rows(db, 'select c from main.T_c where id = 1')).to.deep.equal([{ c: 11 }]);
			// absent (row 2 has no T_c, a = 20) → materialize c = a + 1 = 21.
			await db.exec('update x.T set c = a + 1 where id = 2');
			expect(await rows(db, 'select id, c from main.T_c order by id')).to.deep.equal([{ id: 1, c: 11 }, { id: 2, c: 21 }]);
			expect(await rows(db, 'select c from x.T where id = 2')).to.deep.equal([{ c: 21 }]);
		} finally {
			await db.close();
		}
	});

	it('writes a null-propagating member self-reference (present increments, absent stays absent — the filtered materialize creates no row)', async () => {
		// `set c = c + 1` lowers to `T_c.c + 1` — the owning member's own column. Present rows take the
		// matched UPDATE; for absent rows the null-substituted non-empty filter is `(null + 1) is not
		// null` → constant-false, so the materialize INSERT is skipped at plan time (no row springs
		// into being either way). The owner qualifier is stripped so the matched UPDATE targets T_c
		// directly.
		const db = new Database();
		try {
			await setup(db);
			await db.exec('update x.T set c = c + 1 where id = 1');   // present (c = 1000) → 1001
			expect(await rows(db, 'select c from main.T_c where id = 1')).to.deep.equal([{ c: 1001 }]);
			await db.exec('update x.T set c = c + 1 where id = 2');   // absent → filtered out, no row materializes
			expect(await rows(db, 'select id from main.T_c order by id')).to.deep.equal([{ id: 1 }]);
			expect(await rows(db, 'select c from x.T where id = 2')).to.deep.equal([{ c: null }]);
		} finally {
			await db.close();
		}
	});

	it('materializes a non-null-propagating self-reference on an absent row (coalesce maps null → non-null)', async () => {
		// `set c = coalesce(c, 0) + 1` is a self-reference whose image on an absent row is non-null
		// (coalesce(null, 0) + 1 = 1), so — unlike the null-propagating `c + 1` — it MUST materialize
		// the absent row. Present rows still take the matched UPDATE over their real prior c (no
		// double-apply: the matched UPDATE runs first, and the `do nothing` materialize cedes the
		// present row on conflict). (T_c.c is NOT NULL here, which the materialized value satisfies; the
		// present-but-null matched arm rides the nullable M_opt fixture below.)
		const db = new Database();
		try {
			await setup(db);
			// absent (row 2 has no T_c) → materialize c = coalesce(null, 0) + 1 = 1.
			await db.exec('update x.T set c = coalesce(c, 0) + 1 where id = 2');
			expect(await rows(db, 'select id, c from main.T_c order by id')).to.deep.equal([{ id: 1, c: 1000 }, { id: 2, c: 1 }]);
			expect(await rows(db, 'select c from x.T where id = 2')).to.deep.equal([{ c: 1 }]);
			// present (row 1, c = 1000) → matched UPDATE to 1001 (the materialize does not double-apply).
			await db.exec('update x.T set c = coalesce(c, 0) + 1 where id = 1');
			expect(await rows(db, 'select c from main.T_c where id = 1')).to.deep.equal([{ c: 1001 }]);
		} finally {
			await db.close();
		}
	});

	it('materializes an iif / case else-non-null self-reference on an absent row', async () => {
		// `iif(c is null, 0, c) + 1` and `case when c is null then 0 else c end + 1` are self-references
		// whose null-substituted image is non-null (0 + 1 = 1), so an absent row materializes — exactly
		// like coalesce. (`ifnull` is not a registered function in this engine; coalesce/iif/case are.)
		const db = new Database();
		try {
			await setup(db);
			await db.exec('update x.T set c = iif(c is null, 0, c) + 1 where id = 2');   // absent → 1
			expect(await rows(db, 'select c from x.T where id = 2')).to.deep.equal([{ c: 1 }]);
			await db.exec('delete from main.T_c where id = 2');                          // back to absent
			await db.exec('update x.T set c = case when c is null then 0 else c end + 1 where id = 2'); // absent → 1
			expect(await rows(db, 'select c from x.T where id = 2')).to.deep.equal([{ c: 1 }]);
		} finally {
			await db.close();
		}
	});

	it('writes a cross-member optional value via the single-identity capture (present + absent)', async () => {
		// `set c = b + 1` lowers to `T_b.b + 1` — a column on a *different* member (mandatory T_b)
		// than the optional T_c it assigns. The value is materialized once over the planned body
		// (which null-extends an absent T_c) into __vmupd_keys; the matched UPDATE reads it back by
		// the member key, the materialize INSERT by the anchor key (gated on a runtime non-null).
		const db = new Database();
		try {
			await setup(db);
			// present (row 1 has a T_c row, b = 100) → c = b + 1 = 101.
			await db.exec('update x.T set c = b + 1 where id = 1');
			expect(await rows(db, 'select c from main.T_c where id = 1')).to.deep.equal([{ c: 101 }]);
			// absent (row 2 has no T_c, b = 200) → materialize c = b + 1 = 201.
			await db.exec('update x.T set c = b + 1 where id = 2');
			expect(await rows(db, 'select id, c from main.T_c order by id')).to.deep.equal([{ id: 1, c: 101 }, { id: 2, c: 201 }]);
			expect(await rows(db, 'select c from x.T where id = 2')).to.deep.equal([{ c: 201 }]);
		} finally {
			await db.close();
		}
	});

	it('writes a subquery optional value via the capture (present + absent)', async () => {
		// `set c = (select max(a) from main.T_core)` is an embedded subquery — neither anchor-resolvable
		// nor a member self-reference — so it rides the capture: max(a) over T_core = 20, materialized
		// once and read back in both branches.
		const db = new Database();
		try {
			await setup(db);
			await db.exec('update x.T set c = (select max(a) from main.T_core) where id = 1');   // present → 20
			expect(await rows(db, 'select c from main.T_c where id = 1')).to.deep.equal([{ c: 20 }]);
			await db.exec('update x.T set c = (select max(a) from main.T_core) where id = 2');   // absent → materialize 20
			expect(await rows(db, 'select id, c from main.T_c order by id')).to.deep.equal([{ id: 1, c: 20 }, { id: 2, c: 20 }]);
			expect(await rows(db, 'select c from x.T where id = 2')).to.deep.equal([{ c: 20 }]);
		} finally {
			await db.close();
		}
	});

	it('writes a mixed self + anchor optional value via the capture (present updates, absent stays absent on null)', async () => {
		// `set c = c + a` mixes the owning member's own column (T_c.c, self) and an anchor column
		// (T_core.a) in one value — neither pure-anchor nor pure-self, so it rides the capture (this
		// subsumes the retired same-statement anchor+self reject). The capture over the body null-extends
		// an absent T_c, so an absent row captures `null + a` = null and materializes nothing.
		const db = new Database();
		try {
			await setup(db);
			await db.exec('update x.T set c = c + a where id = 1');   // present (c=1000, a=10) → 1010
			expect(await rows(db, 'select c from main.T_c where id = 1')).to.deep.equal([{ c: 1010 }]);
			await db.exec('update x.T set c = c + a where id = 2');   // absent → null + 20 = null → no materialize
			expect(await rows(db, 'select id from main.T_c order by id')).to.deep.equal([{ id: 1 }]);
			expect(await rows(db, 'select c from x.T where id = 2')).to.deep.equal([{ c: null }]);
		} finally {
			await db.close();
		}
	});

	it('a both-sides write reads the captured optional value from the pre-mutation sibling', async () => {
		// `set c = b + 1, b = b + 100`: c (optional T_c) is captured reading T_b.b; b (mandatory T_b)
		// is rewritten in place. The capture materializes `b + 1` BEFORE the b base op fires, so c reads
		// the pre-mutation b (100), not the rewritten 200 — the ticket's headline ordering guarantee.
		const db = new Database();
		try {
			await setup(db);
			await db.exec('update x.T set c = b + 1, b = b + 100 where id = 1');
			expect(await rows(db, 'select b from main.T_b where id = 1')).to.deep.equal([{ b: 200 }]);
			expect(await rows(db, 'select c from main.T_c where id = 1')).to.deep.equal([{ c: 101 }]);
			// PutGet through the logical table holds row-for-row.
			expect(await rows(db, 'select c, b from x.T where id = 1')).to.deep.equal([{ c: 101, b: 200 }]);
		} finally {
			await db.close();
		}
	});

	it('still gates a non-anchor WHERE on a captured value write (predicate reject, not value)', async () => {
		// `set c = b + 1 where b = 100`: the value is now captured-admissible, but the WHERE references a
		// non-anchor member (T_b), which still defers — the predicate gate fires before any op (atomic).
		const db = new Database();
		try {
			await setup(db);
			await expectThrows(() => db.exec('update x.T set c = b + 1 where b = 100'), /non-anchor decomposition member/i);
			// Atomic: the optional component is untouched.
			expect(await rows(db, 'select c from main.T_c where id = 1')).to.deep.equal([{ c: 1000 }]);
		} finally {
			await db.close();
		}
	});

	it('captured read-back over an INVISIBLE logical row fails safely and atomically (documented boundary)', async () => {
		// Malformed base state: an anchor row (T_core 3) whose MANDATORY member T_b is missing, so the
		// row is dropped by the body's inner join and never surfaces through the view — but it carries a
		// (also-malformed) present T_c. The capture is built over the body (inner-joins T_b), so row 3 is
		// absent from `__vmupd_keys`; the matched UPDATE / materialize filter off the ANCHOR subquery,
		// which includes it. So the captured read-back MISSES (returns null), unlike the constant / anchor
		// / self paths, which write the value straight to row 3's component. Here T_c.c is NOT NULL, so the
		// null write raises a base constraint error — caught ATOMICALLY (row 3's T_c is untouched), never a
		// silent corruption. (For a *nullable* optional column the read-back would instead write null and
		// the row would stay invisible — no widen; that branch needs a fixture with both a mandatory
		// non-anchor member and a nullable optional, which neither fixture has.) docs/lens.md
		// § Current Limitations documents the divergence; it is confined to malformed states.
		const db = new Database();
		try {
			await setup(db);
			await db.exec('insert into main.T_core values (3, 30)');   // anchor present, T_b MISSING → invisible
			await db.exec('insert into main.T_c values (3, 9999)');    // (malformed) present optional component
			expect(await rows(db, 'select id from x.T where id = 3')).to.deep.equal([]);   // invisible through the view
			// captured read-back misses → matched UPDATE proposes c := null → NOT NULL base reject (atomic).
			await expectThrows(() => db.exec('update x.T set c = b + 1 where id = 3'), /not null/i);
			expect(await rows(db, 'select c from main.T_c where id = 3')).to.deep.equal([{ c: 9999 }]);   // untouched
		} finally {
			await db.close();
		}
	});

	it('rejects an update of the shared key', async () => {
		const db = new Database();
		try {
			await setup(db);
			await expectThrows(() => db.exec('update x.T set id = 9 where id = 1'), /shared key/i);
		} finally {
			await db.close();
		}
	});
});

/**
 * Optional members backing **more than one** value column — the partial-null and
 * default-widen branches the single-value-column split above cannot exercise. `M_opt`
 * (c1, c2 both nullable) drives the partial cases; `M_def` (e2 carries a base default)
 * drives the conservative reject that would otherwise silently widen the view.
 */
describe('lens decomposition put: UPDATE of a multi-value-column optional member', () => {
	function multiSplit(): MappingAdvertisement {
		return {
			id: 'M_core',
			logicalTable: 'M',
			role: 'primary-storage',
			storage: {
				anchorRelationId: 'M_core',
				members: [
					{ relationId: 'M_core', relation: { schema: 'main', table: 'M_core' }, presence: 'mandatory', columns: [colMap('id', 'id'), colMap('a', 'a')] },
					{ relationId: 'M_opt', relation: { schema: 'main', table: 'M_opt' }, presence: 'optional', columns: [colMap('c1', 'c1'), colMap('c2', 'c2')] },
					{ relationId: 'M_def', relation: { schema: 'main', table: 'M_def' }, presence: 'optional', columns: [colMap('e1', 'e1'), colMap('e2', 'e2')] },
				],
				sharedKey: { kind: 'logical-tuple', keyColumnsByRelation: keyMap(['M_core', ['id']], ['M_opt', ['id']], ['M_def', ['id']]) },
			},
		};
	}

	async function setupMulti(db: Database): Promise<void> {
		const mod = new AdvertisingModule();
		mod.ads = [multiSplit()];
		db.registerModule('mmod', mod);
		await db.exec('create table M_core (id integer primary key, a integer null) using mmod');
		await db.exec('create table M_opt (id integer primary key, c1 integer null, c2 integer null) using mmod');
		await db.exec('create table M_def (id integer primary key, e1 integer null, e2 integer null default 7) using mmod');
		await db.exec('declare logical schema x { table M { id integer primary key, a integer null, c1 integer null, c2 integer null, e1 integer null, e2 integer null } }');
		await db.exec('apply schema x');
		await db.exec('insert into main.M_core values (1, 10), (2, 20)');
		await db.exec('insert into main.M_opt values (1, 100, 200)');     // id 1 present, id 2 absent
		await db.exec('insert into main.M_def values (1, 1, 1)');
	}

	it('partial non-null write updates a present row and materializes an absent one with the other value null', async () => {
		const db = new Database();
		try {
			await setupMulti(db);
			await db.exec('update x.M set c1 = 5 where id = 1');   // present → UPDATE, c2 untouched
			expect(await rows(db, 'select id, c1, c2 from main.M_opt order by id')).to.deep.equal([{ id: 1, c1: 5, c2: 200 }]);
			await db.exec('update x.M set c1 = 9 where id = 2');   // absent → materialize, c2 lands null
			expect(await rows(db, 'select id, c1, c2 from main.M_opt order by id')).to.deep.equal([{ id: 1, c1: 5, c2: 200 }, { id: 2, c1: 9, c2: null }]);
		} finally {
			await db.close();
		}
	});

	it('a partial all-null write updates (does not delete) — the other value column may still be non-null', async () => {
		const db = new Database();
		try {
			await setupMulti(db);
			await db.exec('update x.M set c1 = null where id = 1');   // only c1 assigned → UPDATE, row survives
			expect(await rows(db, 'select id, c1, c2 from main.M_opt order by id')).to.deep.equal([{ id: 1, c1: null, c2: 200 }]);
		} finally {
			await db.close();
		}
	});

	it('a full all-null write (every value column) deletes the component row', async () => {
		const db = new Database();
		try {
			await setupMulti(db);
			await db.exec('update x.M set c1 = null, c2 = null where id = 1');
			expect(await rows(db, 'select count(*) as n from main.M_opt where id = 1')).to.deep.equal([{ n: 0 }]);
			expect(await rows(db, 'select c1, c2 from x.M where id = 1')).to.deep.equal([{ c1: null, c2: null }]);
		} finally {
			await db.close();
		}
	});

	it('rejects a partial write that would materialize an unassigned value column to a non-null base default', async () => {
		const db = new Database();
		try {
			await setupMulti(db);
			// e2 carries `default 7`; materializing an absent row with only e1 assigned would
			// set e2 = 7, silently widening the absent row's image — rejected at plan time.
			await expectThrows(() => db.exec('update x.M set e1 = 5 where id = 2'), /silently widening|base default/i);
		} finally {
			await db.close();
		}
	});

	it('an anchor-resolvable partial write upserts the assigned value column, landing the other null on an absent row', async () => {
		// `set c1 = a + 1` is anchor-resolvable → one `on conflict (id) do update set c1 = excluded.c1`
		// upsert. A present row updates c1 (c2 untouched); an absent row materializes c1 = a + 1 with
		// the unassigned c2 landing null (the same view-soundness the constant path guarantees).
		const db = new Database();
		try {
			await setupMulti(db);
			await db.exec('update x.M set c1 = a + 1 where id = 1');   // present (a=10) → c1=11, c2 untouched
			expect(await rows(db, 'select id, c1, c2 from main.M_opt order by id')).to.deep.equal([{ id: 1, c1: 11, c2: 200 }]);
			await db.exec('update x.M set c1 = a + 1 where id = 2');   // absent (a=20) → materialize c1=21, c2=null
			expect(await rows(db, 'select id, c1, c2 from main.M_opt order by id')).to.deep.equal([{ id: 1, c1: 11, c2: 200 }, { id: 2, c1: 21, c2: null }]);
		} finally {
			await db.close();
		}
	});

	it('the unassigned-value-column non-null-default gate still fires on the anchor upsert path', async () => {
		// The upsert path reuses the same soundness gate as the constant materialize: e2 carries
		// `default 7`, so a `set e1 = a + 1` (anchor) upsert that leaves e2 to its non-null default
		// would silently widen the absent row's image — rejected at plan time, exactly as the
		// constant `set e1 = 5` is.
		const db = new Database();
		try {
			await setupMulti(db);
			await expectThrows(() => db.exec('update x.M set e1 = a + 1 where id = 2'), /silently widening|base default/i);
		} finally {
			await db.close();
		}
	});

	it('an anchor cell with a null-literal sibling upserts both (not the all-null DELETE path)', async () => {
		// `set c1 = a + 1, c2 = null`: the group has a non-null anchor cell, so it is the anchor
		// upsert (projecting null for c2, `do update set c2 = excluded.c2`), NOT the all-null DELETE
		// (which fires only for a pure-constant group whose every assigned value is null).
		const db = new Database();
		try {
			await setupMulti(db);
			await db.exec('update x.M set c1 = a + 1, c2 = null where id = 1');   // present → c1=11, c2=null (row survives)
			expect(await rows(db, 'select id, c1, c2 from main.M_opt order by id')).to.deep.equal([{ id: 1, c1: 11, c2: null }]);
			await db.exec('update x.M set c1 = a + 1, c2 = null where id = 2');   // absent → materialize (2, 21, null)
			expect(await rows(db, 'select id, c1, c2 from main.M_opt order by id')).to.deep.equal([{ id: 1, c1: 11, c2: null }, { id: 2, c1: 21, c2: null }]);
		} finally {
			await db.close();
		}
	});

	it('admits a value mixing an anchor cell and a self-reference cell in one member via the capture', async () => {
		// `set c1 = a + 1` (anchor) + `set c2 = c2 + 1` (self) on the same optional member: the mixed
		// group rides the single-identity capture (subsuming the retired same-statement reject). Each
		// cell is captured over the body; the matched UPDATE reads both back by the member key, the
		// materialize INSERT by the anchor key (gated on a runtime non-null — c1's anchor value keeps
		// the absent row live while c2's self value captures null).
		const db = new Database();
		try {
			await setupMulti(db);
			await db.exec('update x.M set c1 = a + 1, c2 = c2 + 1 where id = 1');   // present (a=10, c2=200)
			expect(await rows(db, 'select id, c1, c2 from main.M_opt order by id')).to.deep.equal([{ id: 1, c1: 11, c2: 201 }]);
			await db.exec('update x.M set c1 = a + 1, c2 = c2 + 1 where id = 2');   // absent (a=20): c1=21, c2=null+1=null
			expect(await rows(db, 'select id, c1, c2 from main.M_opt order by id')).to.deep.equal([
				{ id: 1, c1: 11, c2: 201 }, { id: 2, c1: 21, c2: null },
			]);
		} finally {
			await db.close();
		}
	});

	it('a captured value that evaluates null on a matched row writes the column null (read-back, not just base row)', async () => {
		// `set c1 = (select max(c1) from main.M_opt where c1 > 100000)` evaluates null (no such row). On
		// the matched (present) row 1 the unfiltered matched UPDATE writes c1 = null — the component row
		// survives (c2 = 200 keeps it; this is not the all-null DELETE fast-lane), and the logical table
		// reads it back null. M_opt.c1 is `integer null`, so it can hold the captured null. Asserts the
		// read-back, not just the base row (the materialize INSERT is filtered out — null read-back).
		const db = new Database();
		try {
			await setupMulti(db);
			await db.exec('update x.M set c1 = (select max(c1) from main.M_opt where c1 > 100000) where id = 1');
			expect(await rows(db, 'select id, c1, c2 from main.M_opt order by id')).to.deep.equal([{ id: 1, c1: null, c2: 200 }]);
			expect(await rows(db, 'select c1 from x.M where id = 1')).to.deep.equal([{ c1: null }]);
		} finally {
			await db.close();
		}
	});

	it('a self cell with a non-null-constant sibling materializes the absent row (self lands null, constant lands its value)', async () => {
		// `set c1 = c1 + 1, c2 = 5`: c1 is a null-propagating self cell, c2 a non-null constant. The
		// group is `hasSelf`, so on an absent row the materialized image is (c1 = null + 1 = null, c2 = 5)
		// — non-empty because the constant c2 is non-null — so the row materializes (the constant cell is
		// no longer dropped when a self cell is present). On a present row the matched UPDATE applies both.
		const db = new Database();
		try {
			await setupMulti(db);
			await db.exec('update x.M set c1 = c1 + 1, c2 = 5 where id = 2');   // absent → materialize (c1=null, c2=5)
			expect(await rows(db, 'select id, c1, c2 from main.M_opt order by id')).to.deep.equal([
				{ id: 1, c1: 100, c2: 200 }, { id: 2, c1: null, c2: 5 },
			]);
			await db.exec('update x.M set c1 = c1 + 1, c2 = 5 where id = 1');   // present → c1 = 101, c2 = 5
			expect(await rows(db, 'select id, c1, c2 from main.M_opt order by id')).to.deep.equal([
				{ id: 1, c1: 101, c2: 5 }, { id: 2, c1: null, c2: 5 },
			]);
		} finally {
			await db.close();
		}
	});

	it('two self cells with mixed null-propagation materialize per-cell (one stays null, one lands non-null)', async () => {
		// `set c1 = c1 + 1, c2 = coalesce(c2, 0) + 1`: both cells are self-references, but c1 is
		// null-propagating and c2 is not. On an absent row the materialized image is (c1 = null + 1 = null,
		// c2 = coalesce(null, 0) + 1 = 1) — non-empty because c2 is non-null — so the row materializes with
		// the per-cell null-substituted values. On a present row the matched UPDATE applies both transforms.
		const db = new Database();
		try {
			await setupMulti(db);
			await db.exec('update x.M set c1 = c1 + 1, c2 = coalesce(c2, 0) + 1 where id = 2');   // absent → (null, 1)
			expect(await rows(db, 'select id, c1, c2 from main.M_opt order by id')).to.deep.equal([
				{ id: 1, c1: 100, c2: 200 }, { id: 2, c1: null, c2: 1 },
			]);
			await db.exec('update x.M set c1 = c1 + 1, c2 = coalesce(c2, 0) + 1 where id = 1');   // present → (101, 201)
			expect(await rows(db, 'select id, c1, c2 from main.M_opt order by id')).to.deep.equal([
				{ id: 1, c1: 101, c2: 201 }, { id: 2, c1: null, c2: 1 },
			]);
		} finally {
			await db.close();
		}
	});

	it('a coalesce self-reference updates a present-but-null row to a non-null value', async () => {
		// The matched UPDATE branch over a present row whose member value is null: `set c1 = coalesce(c1, 0)
		// + 1` on a present M_opt row with c1 = null → coalesce(null, 0) + 1 = 1 (the materialize cedes the
		// present row on conflict). M_opt.c1 is `integer null`, so it can actually hold the null prior value.
		const db = new Database();
		try {
			await setupMulti(db);
			await db.exec('update x.M set c1 = null where id = 1');   // present row, c1 now null (c2 = 200 keeps the row)
			expect(await rows(db, 'select id, c1, c2 from main.M_opt order by id')).to.deep.equal([{ id: 1, c1: null, c2: 200 }]);
			await db.exec('update x.M set c1 = coalesce(c1, 0) + 1 where id = 1');   // present-but-null → 1
			expect(await rows(db, 'select id, c1, c2 from main.M_opt order by id')).to.deep.equal([{ id: 1, c1: 1, c2: 200 }]);
			// absent row 2 → materialize (c1 = coalesce(null, 0) + 1 = 1, c2 left null).
			await db.exec('update x.M set c1 = coalesce(c1, 0) + 1 where id = 2');
			expect(await rows(db, 'select id, c1, c2 from main.M_opt order by id')).to.deep.equal([{ id: 1, c1: 1, c2: 200 }, { id: 2, c1: 1, c2: null }]);
		} finally {
			await db.close();
		}
	});

	it('a null-propagating partial self-update materializes nothing (present rows only), leaving a non-null-defaulted sibling unwidened', async () => {
		// `set e1 = e1 + 1` on M_def (e2 carries `default 7`) is a null-propagating self-reference. Its
		// null-substituted non-empty filter `((null + 1) is not null)` folds **constant-false** at plan
		// time — no absent row can ever materialize — so the materialize INSERT is skipped, and with it
		// (the gates live inside the builder) the unassigned-value-column widen gate. The group degrades
		// to a present-rows-only matched UPDATE. The present row (id=1) updates e1 and keeps e2; the
		// absent row (id=2) materializes nothing, so e2's default never widens it. This recovers the
		// pre-materialize self-path behavior the unconditional gate had regressed into a reject.
		const db = new Database();
		try {
			await setupMulti(db);
			await db.exec('update x.M set e1 = e1 + 1 where id = 1');   // present (e1=1) → e1=2, e2 untouched
			expect(await rows(db, 'select id, e1, e2 from main.M_def order by id')).to.deep.equal([{ id: 1, e1: 2, e2: 1 }]);
			await db.exec('update x.M set e1 = e1 + 1 where id = 2');   // absent → materializes nothing (no widen)
			expect(await rows(db, 'select count(*) as n from main.M_def where id = 2')).to.deep.equal([{ n: 0 }]);
			// The present row is untouched by the absent-row attempt; e2 was never widened to a default.
			expect(await rows(db, 'select id, e1, e2 from main.M_def order by id')).to.deep.equal([{ id: 1, e1: 2, e2: 1 }]);
		} finally {
			await db.close();
		}
	});

	it('rejects a genuinely-materializing partial self-update that leaves a non-null-defaulted sibling unassigned', async () => {
		// `set e1 = coalesce(e1, 0) + 1` on M_def is a null→non-null self-reference: its filter
		// `((coalesce(null, 0) + 1) is not null)` folds **constant-true**, so an absent row WOULD
		// materialize. The materialize INSERT is therefore emitted and its widen gate fires — e2
		// (`default 7`) is unassigned, so materializing would silently widen the absent row's image.
		// Rejected at plan time. (Contrast the dead `e1 + 1` case above, now accepted: only a
		// statically-live materialize trips the gate.)
		const db = new Database();
		try {
			await setupMulti(db);
			await expectThrows(() => db.exec('update x.M set e1 = coalesce(e1, 0) + 1 where id = 2'), /silently widening|base default/i);
			// Atomic: nothing materialized.
			expect(await rows(db, 'select count(*) as n from main.M_def where id = 2')).to.deep.equal([{ n: 0 }]);
		} finally {
			await db.close();
		}
	});

	it('a non-foldable (parameterized) self value stays on the emit path and materializes (not silently skipped)', async () => {
		// `set c1 = coalesce(c1, :x)` over M_opt (c1, c2 both nullable): a self-reference whose null-
		// substituted filter `((coalesce(null, :x)) is not null)` cannot be folded at plan time — the
		// parameter is unbound during plan-time folding (the evaluator uses an empty param map), so it
		// throws and foldsConstantFalse stays conservative (`false`). The materialize INSERT is emitted
		// (its widen gate passes: c2 is nullable-no-default). At runtime (:x = 5) the absent row (id=2)
		// materializes coalesce(null, 5) = 5 with c2 landing null — proving the non-foldable path is
		// **not** silently skipped (a skip would have left id=2 absent).
		const db = new Database();
		try {
			await setupMulti(db);
			await db.exec('update x.M set c1 = coalesce(c1, :x) where id = 2', { x: 5 });
			expect(await rows(db, 'select id, c1, c2 from main.M_opt order by id')).to.deep.equal([
				{ id: 1, c1: 100, c2: 200 }, { id: 2, c1: 5, c2: null },
			]);
		} finally {
			await db.close();
		}
	});

	it('a non-deterministic self value stays on the emit path (the volatile gate blocks a plan-time dead-fold)', async () => {
		// `set c1 = coalesce(c1, vol9())` over M_opt where `vol9` is a registry-**non-deterministic**
		// scalar UDF. `foldsConstantFalse` must NOT fold a volatile to a static dead-materialize: a
		// single plan-time evaluation is an unsound proxy for the per-row runtime filter (a nullable
		// volatile could read null at plan time yet non-null per row). The determinism gate
		// (`containsNonDeterministicCall`) short-circuits before the fold, so the materialize is emitted
		// and the absent row (id=2) materializes coalesce(null, vol9()) = 9 — exercising a volatile self
		// value the deterministic and parameterized arms above don't cover. (This also realigns the
		// ticket's `set c = c + random()` edge-case onto the emit path.)
		const db = new Database();
		db.createScalarFunction('vol9', { numArgs: 0, deterministic: false }, () => 9);
		try {
			await setupMulti(db);
			await db.exec('update x.M set c1 = coalesce(c1, vol9()) where id = 2');   // absent → materialize c1 = 9
			expect(await rows(db, 'select id, c1, c2 from main.M_opt order by id')).to.deep.equal([
				{ id: 1, c1: 100, c2: 200 }, { id: 2, c1: 9, c2: null },
			]);
		} finally {
			await db.close();
		}
	});
});

/**
 * Captured arbitrary values on a **two-value-column** optional member (P_c: c1, c2) with a
 * mandatory cross-member (P_b: b) — the shape neither the single-value T fixture nor the b-less M
 * fixture exercises: multiple arbitrary cells that materialize NON-NULL on an absent row (b is
 * mandatory, so it is always present in the capture over the planned body, even for the absent-c
 * row). Drives the multi-srcN read-back and the multi-cell both-sides pre-mutation ordering.
 */
describe('lens decomposition put: UPDATE optional member with captured arbitrary values', () => {
	function pairSplit(): MappingAdvertisement {
		return {
			id: 'P_core', logicalTable: 'P', role: 'primary-storage',
			storage: {
				anchorRelationId: 'P_core',
				members: [
					{ relationId: 'P_core', relation: { schema: 'main', table: 'P_core' }, presence: 'mandatory', columns: [colMap('id', 'id'), colMap('a', 'a')] },
					{ relationId: 'P_b', relation: { schema: 'main', table: 'P_b' }, presence: 'mandatory', columns: [colMap('b', 'b')] },
					{ relationId: 'P_c', relation: { schema: 'main', table: 'P_c' }, presence: 'optional', columns: [colMap('c1', 'c1'), colMap('c2', 'c2')] },
				],
				sharedKey: { kind: 'logical-tuple', keyColumnsByRelation: keyMap(['P_core', ['id']], ['P_b', ['id']], ['P_c', ['id']]) },
			},
		};
	}

	async function setupPair(db: Database): Promise<void> {
		const mod = new AdvertisingModule();
		mod.ads = [pairSplit()];
		db.registerModule('pmod', mod);
		await db.exec('create table P_core (id integer primary key, a integer) using pmod');
		await db.exec('create table P_b (id integer primary key, b integer) using pmod');
		await db.exec('create table P_c (id integer primary key, c1 integer null, c2 integer null) using pmod');
		await db.exec('declare logical schema x { table P { id integer primary key, a integer, b integer, c1 integer null, c2 integer null } }');
		await db.exec('apply schema x');
		await db.exec('insert into main.P_core values (1, 10), (2, 20)');
		await db.exec('insert into main.P_b values (1, 100), (2, 200)');
		await db.exec('insert into main.P_c values (1, 1000, 2000)');   // id 1 present, id 2 absent
	}

	it('materializes multiple arbitrary cells (each its own srcN) on present + absent rows', async () => {
		// `set c1 = b + 1, c2 = a + b`: two arbitrary (cross-member) cells, each registered as its own
		// srcN. b is mandatory (present even for the absent-c row), so the absent row materializes
		// non-null. Present row 1: c1 = 101, c2 = 110; absent row 2: materialize c1 = 201, c2 = 220.
		const db = new Database();
		try {
			await setupPair(db);
			await db.exec('update x.P set c1 = b + 1, c2 = a + b where id = 1');
			expect(await rows(db, 'select id, c1, c2 from main.P_c order by id')).to.deep.equal([{ id: 1, c1: 101, c2: 110 }]);
			await db.exec('update x.P set c1 = b + 1, c2 = a + b where id = 2');
			expect(await rows(db, 'select id, c1, c2 from main.P_c order by id')).to.deep.equal([
				{ id: 1, c1: 101, c2: 110 }, { id: 2, c1: 201, c2: 220 },
			]);
			expect(await rows(db, 'select * from x.P order by id')).to.deep.equal([
				{ id: 1, a: 10, b: 100, c1: 101, c2: 110 }, { id: 2, a: 20, b: 200, c1: 201, c2: 220 },
			]);
		} finally {
			await db.close();
		}
	});

	it('a multi-cell both-sides write reads the captured values from the pre-mutation sibling', async () => {
		// `set c1 = b + 1, c2 = a + b, b = b + 100`: c1/c2 capture b BEFORE the b base op rewrites it,
		// so they read the pre-mutation b = 100 (c1 = 101, c2 = 110) while b lands 200.
		const db = new Database();
		try {
			await setupPair(db);
			await db.exec('update x.P set c1 = b + 1, c2 = a + b, b = b + 100 where id = 1');
			expect(await rows(db, 'select b from main.P_b where id = 1')).to.deep.equal([{ b: 200 }]);
			expect(await rows(db, 'select id, c1, c2 from main.P_c order by id')).to.deep.equal([{ id: 1, c1: 101, c2: 110 }]);
			expect(await rows(db, 'select c1, c2, b from x.P where id = 1')).to.deep.equal([{ c1: 101, c2: 110, b: 200 }]);
		} finally {
			await db.close();
		}
	});

	it('a captured value over an absent sibling materializes nothing (multi-cell, all-null image)', async () => {
		// `set c1 = b + 1, c2 = a + b where id = 2` already materialized above (b present). Here drop the
		// absent row's value cells to null via a self+anchor mix whose image is entirely null on the
		// absent row: `set c1 = c1 + a, c2 = c2 + a where id = 2` → both null + 20 = null → no row.
		const db = new Database();
		try {
			await setupPair(db);
			await db.exec('update x.P set c1 = c1 + a, c2 = c2 + a where id = 2');
			expect(await rows(db, 'select count(*) as n from main.P_c where id = 2')).to.deep.equal([{ n: 0 }]);
			expect(await rows(db, 'select c1, c2 from x.P where id = 2')).to.deep.equal([{ c1: null, c2: null }]);
		} finally {
			await db.close();
		}
	});
});

/**
 * Anchor-resolvable optional-member value that is itself a **computed anchor mapping**
 * (`bumped = a + 1` logical column, `set c = bumped + 1`). `substituteViewColumns` lowers
 * `bumped` to its anchor-qualified basis (`K_core.a + 1`), so `bumped + 1` is `(K_core.a + 1)
 * + 1` — every leaf anchor-qualified → the anchor upsert branch. The single-value optional
 * member `K_c(c)` round-trips it (present updates, absent materializes).
 */
describe('lens decomposition put: UPDATE optional member with a computed-anchor value', () => {
	function computedAnchorAd(): MappingAdvertisement {
		return {
			id: 'K_core', logicalTable: 'K', role: 'primary-storage',
			storage: {
				anchorRelationId: 'K_core',
				members: [
					{
						relationId: 'K_core', relation: { schema: 'main', table: 'K_core' }, presence: 'mandatory',
						columns: [
							colMap('id', 'id'), colMap('a', 'a'),
							{ logicalColumn: 'bumped', basisExpr: { type: 'binary', operator: '+', left: { type: 'column', name: 'a' }, right: { type: 'literal', value: 1 } } },
						],
					},
					{ relationId: 'K_c', relation: { schema: 'main', table: 'K_c' }, presence: 'optional', columns: [colMap('c', 'c')] },
				],
				sharedKey: { kind: 'logical-tuple', keyColumnsByRelation: keyMap(['K_core', ['id']], ['K_c', ['id']]) },
			},
		};
	}

	async function setupComputedAnchor(db: Database): Promise<void> {
		const mod = new AdvertisingModule();
		mod.ads = [computedAnchorAd()];
		db.registerModule('kmod', mod);
		await db.exec('create table K_core (id integer primary key, a integer) using kmod');
		await db.exec('create table K_c (id integer primary key, c integer null) using kmod');
		await db.exec('declare logical schema x { table K { id integer primary key, a integer, bumped integer, c integer null } }');
		await db.exec('apply schema x');
		await db.exec('insert into main.K_core values (1, 10), (2, 20)');
		await db.exec('insert into main.K_c values (1, 1000)');   // id 1 present, id 2 absent
	}

	it('set c = bumped + 1 lowers to an anchor-qualified value and upserts (present + absent)', async () => {
		const db = new Database();
		try {
			await setupComputedAnchor(db);
			// present (id 1, a = 10) → bumped + 1 = (10 + 1) + 1 = 12.
			await db.exec('update x.K set c = bumped + 1 where id = 1');
			expect(await rows(db, 'select c from main.K_c where id = 1')).to.deep.equal([{ c: 12 }]);
			// absent (id 2, a = 20) → materialize bumped + 1 = (20 + 1) + 1 = 22.
			await db.exec('update x.K set c = bumped + 1 where id = 2');
			expect(await rows(db, 'select id, c from main.K_c order by id')).to.deep.equal([{ id: 1, c: 12 }, { id: 2, c: 22 }]);
			expect(await rows(db, 'select c from x.K where id = 2')).to.deep.equal([{ c: 22 }]);
		} finally {
			await db.close();
		}
	});
});

/** EAV decomposition: anchor main.E_core (id) + a triple store main.E_eav (eid, attr, val). */
function eavSplit(): MappingAdvertisement {
	return {
		id: 'E_core',
		logicalTable: 'E',
		role: 'primary-storage',
		storage: {
			anchorRelationId: 'E_core',
			members: [
				{ relationId: 'E_core', relation: { schema: 'main', table: 'E_core' }, presence: 'mandatory', columns: [colMap('id', 'id')] },
				{
					relationId: 'E_eav', relation: { schema: 'main', table: 'E_eav' }, presence: 'optional', columns: [],
					attributePivot: { entityColumn: 'eid', attributeColumn: 'attr', valueColumn: 'val' },
				},
			],
			sharedKey: { kind: 'logical-tuple', keyColumnsByRelation: keyMap(['E_core', ['id']], ['E_eav', ['eid']]) },
		},
	};
}

describe('lens decomposition put: EAV DELETE fan-out', () => {
	async function setupEav(db: Database): Promise<void> {
		const mod = new AdvertisingModule();
		mod.ads = [eavSplit()];
		db.registerModule('eavmod', mod);
		await db.exec('create table E_core (id integer primary key) using eavmod');
		await db.exec('create table E_eav (eid integer, attr text, val integer null, primary key (eid, attr)) using eavmod');
		await db.exec('declare logical schema x { table E { id integer primary key, p integer null, q integer null } }');
		await db.exec('apply schema x');
		await db.exec('insert into main.E_core values (1), (2)');
		await db.exec("insert into main.E_eav values (1, 'p', 11), (1, 'q', 12), (2, 'p', 21)");
	}

	it('delete by key removes the anchor row and every triple for the entity', async () => {
		const db = new Database();
		try {
			await setupEav(db);
			await db.exec('delete from x.E where id = 1');
			expect(await rows(db, 'select id from main.E_core order by id')).to.deep.equal([{ id: 2 }]);
			expect(await rows(db, 'select eid, attr from main.E_eav order by eid, attr')).to.deep.equal([{ eid: 2, attr: 'p' }]);
		} finally {
			await db.close();
		}
	});

	it('upserts a non-null EAV-served column and deletes it on null', async () => {
		// An EAV column is projected by the get body as a correlated subquery, never a
		// member `columns` entry. A non-null write upserts its triple (matched UPDATE of
		// the value + materialize INSERT for entities lacking it); a null write deletes it.
		const db = new Database();
		try {
			await setupEav(db);
			// matched (entity 1 has a 'p' triple) → UPDATE the value.
			await db.exec('update x.E set p = 99 where id = 1');
			expect(await rows(db, "select val from main.E_eav where eid = 1 and attr = 'p'")).to.deep.equal([{ val: 99 }]);
			// absent (entity 2 has no 'q' triple) → materialize the (2, 'q', 88) triple.
			await db.exec('update x.E set q = 88 where id = 2');
			expect(await rows(db, "select val from main.E_eav where eid = 2 and attr = 'q'")).to.deep.equal([{ val: 88 }]);
			// null write → delete the matched entity's 'p' triple; the view reads null.
			await db.exec('update x.E set p = null where id = 1');
			expect(await rows(db, "select count(*) as n from main.E_eav where eid = 1 and attr = 'p'")).to.deep.equal([{ n: 0 }]);
			expect(await rows(db, 'select p from x.E where id = 1')).to.deep.equal([{ p: null }]);
			// An unbacked column is still a plain no-inverse (not an EAV route).
			await expectThrows(() => db.exec('update x.E set notacol = 1 where id = 1'), /not backed by any decomposition member/i);
		} finally {
			await db.close();
		}
	});

	it('upserts an anchor-resolvable EAV value via do-update (set p = id * 2, present + absent)', async () => {
		// `set p = id * 2` lowers to `E_core.id * 2` — anchor-qualified, so the matched UPDATE and
		// the materialize INSERT collapse into one `on conflict (eid, attr) do update set val =
		// excluded.val` triple upsert (the value computed once over the anchor scan).
		const db = new Database();
		try {
			await setupEav(db);
			// matched (entity 1 has a 'p' triple, id = 1) → val = id * 2 = 2.
			await db.exec('update x.E set p = id * 2 where id = 1');
			expect(await rows(db, "select val from main.E_eav where eid = 1 and attr = 'p'")).to.deep.equal([{ val: 2 }]);
			// absent (entity 2 has no 'q' triple, id = 2) → materialize (2, 'q', 4).
			await db.exec('update x.E set q = id * 2 where id = 2');
			expect(await rows(db, "select val from main.E_eav where eid = 2 and attr = 'q'")).to.deep.equal([{ val: 4 }]);
			expect(await rows(db, 'select q from x.E where id = 2')).to.deep.equal([{ q: 4 }]);
		} finally {
			await db.close();
		}
	});

	it('captures an EAV self-reference (set p = p + 1) on a matched triple', async () => {
		// An EAV value column is projected by the get body as a correlated subquery, so a
		// self-reference `set p = p + 1` lowers to `(select val …) + 1` — a subquery value, which
		// lands `captured` and rides the single-identity capture: the matched 'p' triple of entity
		// 1 reads its pre-mutation value (11) back, increments to 12.
		const db = new Database();
		try {
			await setupEav(db);
			await db.exec('update x.E set p = p + 1 where id = 1');
			expect(await rows(db, "select val from main.E_eav where eid = 1 and attr = 'p'")).to.deep.equal([{ val: 12 }]);
			expect(await rows(db, 'select p from x.E where id = 1')).to.deep.equal([{ p: 12 }]);
			// Entity 1's other triple ('q') and entity 2's 'p' are untouched.
			expect(await rows(db, 'select eid, attr, val from main.E_eav order by eid, attr')).to.deep.equal([
				{ eid: 1, attr: 'p', val: 12 }, { eid: 1, attr: 'q', val: 12 }, { eid: 2, attr: 'p', val: 21 },
			]);
		} finally {
			await db.close();
		}
	});

	it('an EAV self-reference materializes nothing on an absent attribute (set q = q + 1, entity 2 lacks q)', async () => {
		// Entity 2 has no 'q' triple, so the captured `q + 1` is `null + 1` = null → the non-null
		// materialize filter suppresses it: no `(2, 'q', …)` triple springs, and `x.E.q` stays null.
		const db = new Database();
		try {
			await setupEav(db);
			await db.exec('update x.E set q = q + 1 where id = 2');
			expect(await rows(db, "select count(*) as n from main.E_eav where eid = 2 and attr = 'q'")).to.deep.equal([{ n: 0 }]);
			expect(await rows(db, 'select q from x.E where id = 2')).to.deep.equal([{ q: null }]);
		} finally {
			await db.close();
		}
	});

	it('captures an anchor-mixed EAV self-reference (set p = p + id * 10) over present + absent', async () => {
		// `set p = p + id * 10` mixes the attribute self-reference (a subquery) with the anchor id —
		// a value that previously hit `arbitrary`/reject. Entity 1 (has 'p' = 11) → 11 + 10 = 21;
		// entity 2's absent 'q' would be null, but here we drive 'p' which entity 2 HAS (= 21) →
		// 21 + 20 = 41 (materializes nothing new; both are matched triples).
		const db = new Database();
		try {
			await setupEav(db);
			await db.exec('update x.E set p = p + id * 10');
			expect(await rows(db, "select eid, val from main.E_eav where attr = 'p' order by eid")).to.deep.equal([
				{ eid: 1, val: 21 }, { eid: 2, val: 41 },
			]);
			expect(await rows(db, 'select id, p from x.E order by id')).to.deep.equal([{ id: 1, p: 21 }, { id: 2, p: 41 }]);
		} finally {
			await db.close();
		}
	});

	it('materializes a captured EAV value on an absent attribute via an anchor-mixed self (set q = coalesce(q, 0) + id)', async () => {
		// Entity 1 has 'q' = 12 → coalesce(12, 0) + 1 = 13 (matched UPDATE). Entity 2 lacks 'q' →
		// coalesce(null, 0) + 2 = 2 (non-null → materialize the (2, 'q', 2) triple).
		const db = new Database();
		try {
			await setupEav(db);
			await db.exec('update x.E set q = coalesce(q, 0) + id');
			expect(await rows(db, "select eid, val from main.E_eav where attr = 'q' order by eid")).to.deep.equal([
				{ eid: 1, val: 13 }, { eid: 2, val: 2 },
			]);
			expect(await rows(db, 'select id, q from x.E order by id')).to.deep.equal([{ id: 1, q: 13 }, { id: 2, q: 2 }]);
		} finally {
			await db.close();
		}
	});

	it('a captured-null matched triple reads null through x.E, then set p = 5 re-upserts it', async () => {
		// Entity 2 HAS a 'p' triple (=21) but LACKS 'q', so `set p = q + 1` captures `null + 1` = null
		// on its matched 'p' triple. The matched UPDATE is unfiltered, so it writes val = null (a benign
		// physical divergence from the explicit `set p = null` delete — the triple stays, reading null
		// through x.E). A subsequent constant `set p = 5` then re-upserts a real value into that triple.
		const db = new Database();
		try {
			await setupEav(db);
			await db.exec('update x.E set p = q + 1 where id = 2');
			// The matched 'p' triple for entity 2 is now val = null (a benign physical divergence from delete).
			expect(await rows(db, "select val from main.E_eav where eid = 2 and attr = 'p'")).to.deep.equal([{ val: null }]);
			expect(await rows(db, 'select p from x.E where id = 2')).to.deep.equal([{ p: null }]);
			// A subsequent constant write re-upserts a real value into the same triple.
			await db.exec('update x.E set p = 5 where id = 2');
			expect(await rows(db, "select val from main.E_eav where eid = 2 and attr = 'p'")).to.deep.equal([{ val: 5 }]);
			expect(await rows(db, 'select p from x.E where id = 2')).to.deep.equal([{ p: 5 }]);
		} finally {
			await db.close();
		}
	});

	it('mixes a captured p (self-reference) and a constant q in one statement', async () => {
		// `set p = p + 1, q = 99 where id = 1`: p routes captured (per-attribute, its own srcN), q routes
		// the constant matched-UPDATE path — both coexist (independent triples). Entity 1: p 11→12, q 12→99.
		const db = new Database();
		try {
			await setupEav(db);
			await db.exec('update x.E set p = p + 1, q = 99 where id = 1');
			expect(await rows(db, 'select attr, val from main.E_eav where eid = 1 order by attr')).to.deep.equal([
				{ attr: 'p', val: 12 }, { attr: 'q', val: 99 },
			]);
			expect(await rows(db, 'select p, q from x.E where id = 1')).to.deep.equal([{ p: 12, q: 99 }]);
		} finally {
			await db.close();
		}
	});

	it('captures cross-attribute both-sides PRE-mutation (set p = q + 1, q = p + 1)', async () => {
		// Both values are captured once over the pre-mutation body before any base op fires, so
		// each reads the OTHER attribute's pre-mutation value: p := q(12) + 1 = 13, q := p(11) + 1 = 12.
		// A sequential (read-after-write) lowering would leak the freshly written p into q — pinning
		// the capture-pre-mutation invariant for the EAV path (the columnar both-sides analogue).
		const db = new Database();
		try {
			await setupEav(db);
			await db.exec('update x.E set p = q + 1, q = p + 1 where id = 1');
			expect(await rows(db, 'select attr, val from main.E_eav where eid = 1 order by attr')).to.deep.equal([
				{ attr: 'p', val: 13 }, { attr: 'q', val: 12 },
			]);
			expect(await rows(db, 'select p, q from x.E where id = 1')).to.deep.equal([{ p: 13, q: 12 }]);
		} finally {
			await db.close();
		}
	});

	it('captures an embedded subquery EAV value (set p = (select max(val) from main.E_eav))', async () => {
		// A genuinely arbitrary (non-self) value — an embedded subquery over the pivot — rides the
		// same capture: max(val) over {11,12,21} = 21, materialized once, written back to entity 1's 'p'.
		const db = new Database();
		try {
			await setupEav(db);
			await db.exec('update x.E set p = (select max(val) from main.E_eav) where id = 1');
			expect(await rows(db, "select val from main.E_eav where eid = 1 and attr = 'p'")).to.deep.equal([{ val: 21 }]);
		} finally {
			await db.close();
		}
	});

	it('a captured null on a matched triple over a NOT-NULL pivot value column raises atomically', async () => {
		// The matched UPDATE is unfiltered, so a captured null (entity 2 has 'p', lacks 'q', so
		// `set p = q + 1` captures null) writes `val = null`. With a NULLABLE value column that is a
		// benign physical divergence (covered above); with a **NOT NULL** value column it instead
		// hits the base NOT NULL constraint and raises atomically — reject-don't-widen, the EAV
		// analogue of the columnar invisible-row NOT-NULL boundary (docs/lens.md § Current limitations).
		const db = new Database();
		try {
			const mod = new AdvertisingModule();
			mod.ads = [eavSplit()];
			db.registerModule('eavmod', mod);
			await db.exec('create table E_core (id integer primary key) using eavmod');
			await db.exec('create table E_eav (eid integer, attr text, val integer not null, primary key (eid, attr)) using eavmod');
			await db.exec('declare logical schema x { table E { id integer primary key, p integer null, q integer null } }');
			await db.exec('apply schema x');
			await db.exec('insert into main.E_core values (1), (2)');
			await db.exec("insert into main.E_eav values (1, 'p', 11), (1, 'q', 12), (2, 'p', 21)");
			await expectThrows(() => db.exec('update x.E set p = q + 1 where id = 2'), /not null/i);
			// Atomic: entity 2's 'p' triple keeps its prior value.
			expect(await rows(db, "select val from main.E_eav where eid = 2 and attr = 'p'")).to.deep.equal([{ val: 21 }]);
		} finally {
			await db.close();
		}
	});

	it('captures a columnar member and an EAV member in one statement (no carrier collision)', async () => {
		// One decomposition with BOTH an optional columnar member (c) and an EAV pivot (p). A single
		// __vmupd_keys carrier holds both members' srcN — columnar keyed `cap:<rel>:<col>`, EAV
		// `cap:<rel>:attr:<attr>` — so they never collide. `set c = c + 1, p = p + a` captures both
		// over the pre-mutation body: c 100→101, p 1000 + a(10) = 1010.
		const db = new Database();
		try {
			const mod = new AdvertisingModule();
			mod.ads = [{
				id: 'M_core', logicalTable: 'M', role: 'primary-storage',
				storage: {
					anchorRelationId: 'M_core',
					members: [
						{ relationId: 'M_core', relation: { schema: 'main', table: 'M_core' }, presence: 'mandatory', columns: [colMap('id', 'id'), colMap('a', 'a')] },
						{ relationId: 'M_c', relation: { schema: 'main', table: 'M_c' }, presence: 'optional', columns: [colMap('c', 'c')] },
						{
							relationId: 'M_eav', relation: { schema: 'main', table: 'M_eav' }, presence: 'optional', columns: [],
							attributePivot: { entityColumn: 'eid', attributeColumn: 'attr', valueColumn: 'val' },
						},
					],
					sharedKey: { kind: 'logical-tuple', keyColumnsByRelation: keyMap(['M_core', ['id']], ['M_c', ['id']], ['M_eav', ['eid']]) },
				},
			}];
			db.registerModule('mmod', mod);
			await db.exec('create table M_core (id integer primary key, a integer) using mmod');
			await db.exec('create table M_c (id integer primary key, c integer null) using mmod');
			await db.exec('create table M_eav (eid integer, attr text, val integer null, primary key (eid, attr)) using mmod');
			await db.exec('declare logical schema y { table M { id integer primary key, a integer, c integer null, p integer null } }');
			await db.exec('apply schema y');
			await db.exec('insert into main.M_core values (1, 10)');
			await db.exec('insert into main.M_c values (1, 100)');
			await db.exec("insert into main.M_eav values (1, 'p', 1000)");
			await db.exec('update y.M set c = c + 1, p = p + a where id = 1');
			expect(await rows(db, 'select c from main.M_c where id = 1')).to.deep.equal([{ c: 101 }]);
			expect(await rows(db, "select val from main.M_eav where eid = 1 and attr = 'p'")).to.deep.equal([{ val: 1010 }]);
			expect(await rows(db, 'select c, p from y.M where id = 1')).to.deep.equal([{ c: 101, p: 1010 }]);
		} finally {
			await db.close();
		}
	});

	it('defers a DELETE filtered on an EAV-served column with the EAV-pivot diagnostic', async () => {
		// A WHERE on an EAV column (projected by the get body as a correlated subquery, never
		// a member `columns` entry) defers with the EAV-pivot message — distinct from the
		// genuine non-anchor-member message, so the misattribution the support fix removed is
		// not reintroduced through the WHERE gate.
		const db = new Database();
		try {
			await setupEav(db);
			await expectThrows(() => db.exec('delete from x.E where p = 11'), /EAV pivot member/i);
			// Atomic: every triple intact.
			expect(await rows(db, 'select eid, attr from main.E_eav order by eid, attr')).to.deep.equal([
				{ eid: 1, attr: 'p' }, { eid: 1, attr: 'q' }, { eid: 2, attr: 'p' },
			]);
		} finally {
			await db.close();
		}
	});

	it('insert materializes the anchor row plus one triple per supplied non-null attribute', async () => {
		const db = new Database();
		try {
			await setupEav(db);
			await db.exec('insert into x.E (id, p, q) values (3, 33, 34)');
			expect(await rows(db, 'select id from main.E_core order by id')).to.deep.equal([{ id: 1 }, { id: 2 }, { id: 3 }]);
			expect(await rows(db, 'select eid, attr, val from main.E_eav where eid = 3 order by attr')).to.deep.equal([
				{ eid: 3, attr: 'p', val: 33 }, { eid: 3, attr: 'q', val: 34 },
			]);
			expect(await rows(db, 'select * from x.E order by id')).to.deep.equal([
				{ id: 1, p: 11, q: 12 }, { id: 2, p: 21, q: null }, { id: 3, p: 33, q: 34 },
			]);
		} finally {
			await db.close();
		}
	});

	it('insert writes no triple for a null attribute value (the read yields null)', async () => {
		const db = new Database();
		try {
			await setupEav(db);
			await db.exec('insert into x.E (id, p, q) values (4, 44, null)');
			expect(await rows(db, 'select eid, attr, val from main.E_eav where eid = 4 order by attr')).to.deep.equal([
				{ eid: 4, attr: 'p', val: 44 }, // no 'q' triple
			]);
			expect(await rows(db, 'select * from x.E order by id')).to.deep.equal([
				{ id: 1, p: 11, q: 12 }, { id: 2, p: 21, q: null }, { id: 4, p: 44, q: null },
			]);
		} finally {
			await db.close();
		}
	});
});

describe('lens decomposition put: INSERT fan-out (logical-tuple)', () => {
	it('fans an insert out to every member, threading the logical PK', async () => {
		const db = new Database();
		try {
			await setup(db);
			await db.exec('insert into x.T (id, a, b, c) values (3, 30, 300, 3000)');
			expect(await rows(db, 'select * from main.T_core where id = 3')).to.deep.equal([{ id: 3, a: 30 }]);
			expect(await rows(db, 'select * from main.T_b where id = 3')).to.deep.equal([{ id: 3, b: 300 }]);
			expect(await rows(db, 'select * from main.T_c where id = 3')).to.deep.equal([{ id: 3, c: 3000 }]);
			expect(await rows(db, 'select * from x.T where id = 3')).to.deep.equal([{ id: 3, a: 30, b: 300, c: 3000 }]);
		} finally {
			await db.close();
		}
	});

	it('omitting the optional component materializes no optional member row', async () => {
		const db = new Database();
		try {
			await setup(db);
			await db.exec('insert into x.T (id, a, b) values (4, 40, 400)'); // no c
			expect(await rows(db, 'select id from main.T_c order by id')).to.deep.equal([{ id: 1 }]); // only the seeded c
			expect(await rows(db, 'select * from x.T where id = 4')).to.deep.equal([{ id: 4, a: 40, b: 400, c: null }]);
		} finally {
			await db.close();
		}
	});

	it('per-row presence gate: an explicit-null optional value materializes no member row, a non-null one does', async () => {
		const db = new Database();
		try {
			await setup(db);
			await db.exec('insert into x.T (id, a, b, c) values (5, 50, 500, null), (6, 60, 600, 6000)');
			expect(await rows(db, 'select id, c from main.T_c order by id')).to.deep.equal([
				{ id: 1, c: 1000 }, { id: 6, c: 6000 }, // row 5 (null c) is absent
			]);
			expect(await rows(db, 'select * from x.T where id in (5, 6) order by id')).to.deep.equal([
				{ id: 5, a: 50, b: 500, c: null }, { id: 6, a: 60, b: 600, c: 6000 },
			]);
		} finally {
			await db.close();
		}
	});

	it('inserting an unbacked logical column raises a precise diagnostic', async () => {
		const db = new Database();
		try {
			await setup(db);
			await expectThrows(() => db.exec('insert into x.T (id, nope) values (9, 1)'), /not backed by any decomposition member/i);
		} finally {
			await db.close();
		}
	});

	it('omitting the logical-tuple shared key is rejected (it threads the supplied value)', async () => {
		const db = new Database();
		try {
			await setup(db);
			await expectThrows(() => db.exec('insert into x.T (a, b) values (70, 700)'), /shared key.*is not supplied|must be provided/i);
		} finally {
			await db.close();
		}
	});

	it('insert or replace composes across every member op', async () => {
		const db = new Database();
		try {
			await setup(db);
			// id=1 exists on all three members; replace fans out to each.
			await db.exec('insert or replace into x.T (id, a, b, c) values (1, 999, 9990, 99900)');
			expect(await rows(db, 'select * from x.T where id = 1')).to.deep.equal([{ id: 1, a: 999, b: 9990, c: 99900 }]);
		} finally {
			await db.close();
		}
	});
});

/**
 * Surrogate decomposition: anchor Doc_core(sid pk, doc_key, title) + Doc_body
 * (doc_sid pk, body), joined on a surrogate spelled `sid`/`doc_sid`. The surrogate's
 * value is sourced from the anchor (Doc_core.sid) declared `default` — the engine
 * mints nothing of its own. The logical key `docKey` is an ordinary value column.
 */
function surrogateAd(): MappingAdvertisement {
	return {
		id: 'Doc_core',
		logicalTable: 'Doc',
		role: 'primary-storage',
		storage: {
			anchorRelationId: 'Doc_core',
			members: [
				{ relationId: 'Doc_core', relation: { schema: 'main', table: 'Doc_core' }, presence: 'mandatory', columns: [colMap('docKey', 'doc_key'), colMap('title', 'title')] },
				{ relationId: 'Doc_body', relation: { schema: 'main', table: 'Doc_body' }, presence: 'mandatory', columns: [colMap('body', 'body')] },
			],
			sharedKey: {
				kind: 'surrogate',
				keyColumnsByRelation: keyMap(['Doc_core', ['sid']], ['Doc_body', ['doc_sid']]),
			},
		},
	};
}

/**
 * @param anchorDefault when true, Doc_core.sid declares a high-water-mark allocator
 *   default (the surrogate's value source); when false, it declares no default (the
 *   deploy-time rejection case — the engine no longer invents one).
 */
async function setupSurrogate(db: Database, anchorDefault = true): Promise<void> {
	const mod = new AdvertisingModule();
	mod.ads = [surrogateAd()];
	db.registerModule('docmod', mod);
	const sidDef = anchorDefault
		? 'sid integer primary key default (coalesce((select max(sid) from Doc_core), 0) + mutation_ordinal())'
		: 'sid integer primary key';
	await db.exec(`create table Doc_core (${sidDef}, doc_key text, title text) using docmod`);
	await db.exec('create table Doc_body (doc_sid integer primary key, body text) using docmod');
	await db.exec('declare logical schema x { table Doc { docKey text primary key, title text, body text } }');
	await db.exec('apply schema x');
	await db.exec("insert into main.Doc_core (sid, doc_key, title) values (100, 'k1', 'First'), (101, 'k2', 'Second')");
	await db.exec("insert into main.Doc_body values (100, 'b1'), (101, 'b2')");
}

describe('lens decomposition put: INSERT fan-out (surrogate)', () => {
	it('sources the surrogate from the anchor default once per row, threaded across members, distinct per row', async () => {
		const db = new Database();
		try {
			await setupSurrogate(db);
			await db.exec("insert into x.Doc (docKey, title, body) values ('k3', 'T3', 'B3'), ('k4', 'T4', 'B4')");
			// anchor default = coalesce(max(sid),0)+mutation_ordinal() → 102, 103 (distinct per row).
			expect(await rows(db, 'select sid, doc_key from main.Doc_core order by sid')).to.deep.equal([
				{ sid: 100, doc_key: 'k1' }, { sid: 101, doc_key: 'k2' }, { sid: 102, doc_key: 'k3' }, { sid: 103, doc_key: 'k4' },
			]);
			// Each evaluated sid is identical on the Doc_body side (one evaluation, threaded via the EC).
			expect(await rows(db, 'select doc_sid, body from main.Doc_body order by doc_sid')).to.deep.equal([
				{ doc_sid: 100, body: 'b1' }, { doc_sid: 101, body: 'b2' }, { doc_sid: 102, body: 'B3' }, { doc_sid: 103, body: 'B4' },
			]);
			expect(await rows(db, 'select * from x.Doc order by docKey')).to.deep.equal([
				{ docKey: 'k1', title: 'First', body: 'b1' }, { docKey: 'k2', title: 'Second', body: 'b2' },
				{ docKey: 'k3', title: 'T3', body: 'B3' }, { docKey: 'k4', title: 'T4', body: 'B4' },
			]);
		} finally {
			await db.close();
		}
	});

	it('a single-row insert sources one key from the anchor default, threaded across members', async () => {
		const db = new Database();
		try {
			await setupSurrogate(db);
			await db.exec("insert into x.Doc (docKey, title, body) values ('k3', 'T3', 'B3')");
			expect(await rows(db, 'select sid, doc_key from main.Doc_core where sid >= 102')).to.deep.equal([{ sid: 102, doc_key: 'k3' }]);
			expect(await rows(db, 'select doc_sid, body from main.Doc_body where doc_sid >= 102')).to.deep.equal([{ doc_sid: 102, body: 'B3' }]);
			expect(await rows(db, "select * from x.Doc where docKey = 'k3'")).to.deep.equal([{ docKey: 'k3', title: 'T3', body: 'B3' }]);
		} finally {
			await db.close();
		}
	});

	it('a surrogate whose anchor key column declares no DEFAULT is rejected at deploy time', async () => {
		const db = new Database();
		try {
			await expectThrows(() => setupSurrogate(db, false), /declares no DEFAULT|surrogate/i);
		} finally {
			await db.close();
		}
	});
});

/**
 * Singleton (`primary key ()`): two value-carrying members joined on `1 = 1`, no
 * key to thread. Inserts are unconditional over the empty key.
 */
function singletonAd(): MappingAdvertisement {
	return {
		id: 'Cfg_a',
		logicalTable: 'Cfg',
		role: 'primary-storage',
		storage: {
			anchorRelationId: 'Cfg_a',
			members: [
				{ relationId: 'Cfg_a', relation: { schema: 'main', table: 'Cfg_a' }, presence: 'mandatory', columns: [colMap('theme', 'theme')] },
				{ relationId: 'Cfg_b', relation: { schema: 'main', table: 'Cfg_b' }, presence: 'mandatory', columns: [colMap('lang', 'lang')] },
			],
			sharedKey: { kind: 'logical-tuple', keyColumnsByRelation: keyMap(['Cfg_a', []], ['Cfg_b', []]) },
		},
	};
}

describe('lens decomposition put: INSERT fan-out (singleton)', () => {
	it('writes each member unconditionally over the empty key', async () => {
		const db = new Database();
		try {
			const mod = new AdvertisingModule();
			mod.ads = [singletonAd()];
			db.registerModule('cfgmod', mod);
			await db.exec('create table Cfg_a (theme text, primary key ()) using cfgmod');
			await db.exec('create table Cfg_b (lang text, primary key ()) using cfgmod');
			await db.exec('declare logical schema x { table Cfg { theme text, lang text, primary key () } }');
			await db.exec('apply schema x');

			await db.exec("insert into x.Cfg (theme, lang) values ('dark', 'en')");
			expect(await rows(db, 'select theme from main.Cfg_a')).to.deep.equal([{ theme: 'dark' }]);
			expect(await rows(db, 'select lang from main.Cfg_b')).to.deep.equal([{ lang: 'en' }]);
			expect(await rows(db, 'select * from x.Cfg')).to.deep.equal([{ theme: 'dark', lang: 'en' }]);
		} finally {
			await db.close();
		}
	});
});

/**
 * Review-pass regression coverage for shapes the implement pass flagged as
 * untested boundaries (treat the implementer's tests as a floor).
 */
describe('lens decomposition put: INSERT fan-out (edge cases)', () => {
	// EAV with a MIXED-CASE logical attribute column — the write must store the
	// attribute spelled as the column is declared (the read matches the literal by
	// exact value, no case-fold), so a round-trip recovers it.
	function eavMixedAd(): MappingAdvertisement {
		return {
			id: 'M_core', logicalTable: 'M', role: 'primary-storage',
			storage: {
				anchorRelationId: 'M_core',
				members: [
					{ relationId: 'M_core', relation: { schema: 'main', table: 'M_core' }, presence: 'mandatory', columns: [colMap('id', 'id')] },
					{ relationId: 'M_eav', relation: { schema: 'main', table: 'M_eav' }, presence: 'optional', columns: [],
						attributePivot: { entityColumn: 'eid', attributeColumn: 'attr', valueColumn: 'val' } },
				],
				sharedKey: { kind: 'logical-tuple', keyColumnsByRelation: keyMap(['M_core', ['id']], ['M_eav', ['eid']]) },
			},
		};
	}

	it('an EAV write stores the declared (mixed) case attribute and reads it back', async () => {
		const db = new Database();
		try {
			const mod = new AdvertisingModule();
			mod.ads = [eavMixedAd()];
			db.registerModule('mmod', mod);
			await db.exec('create table M_core (id integer primary key) using mmod');
			await db.exec('create table M_eav (eid integer, attr text, val integer, primary key (eid, attr)) using mmod');
			await db.exec('declare logical schema x { table M { id integer primary key, City integer } }');
			await db.exec('apply schema x');

			await db.exec('insert into x.M (id, City) values (1, 555)');
			// The attribute literal preserves the declared case (not lowercased).
			expect(await rows(db, 'select eid, attr, val from main.M_eav')).to.deep.equal([{ eid: 1, attr: 'City', val: 555 }]);
			expect(await rows(db, 'select * from x.M order by id')).to.deep.equal([{ id: 1, City: 555 }]);
		} finally {
			await db.close();
		}
	});

	it('a mid-fan-out member failure rolls the whole statement back (atomic, anchor included)', async () => {
		const db = new Database();
		try {
			const mod = new AdvertisingModule();
			mod.ads = [split()];
			db.registerModule('atomicmod', mod);
			await db.exec('create table T_core (id integer primary key, a integer) using atomicmod');
			await db.exec('create table T_b (id integer primary key, b integer) using atomicmod');
			await db.exec('create table T_c (id integer primary key, c integer) using atomicmod');
			await db.exec('declare logical schema x { table T { id integer primary key, a integer, b integer, c integer null } }');
			await db.exec('apply schema x');
			// Pre-seed ONLY T_b at id=7, so the anchor (T_core) insert succeeds but the
			// second member (T_b) insert collides on its PK mid-fan-out.
			await db.exec('insert into main.T_b values (7, 700)');

			await expectThrows(() => db.exec('insert into x.T (id, a, b, c) values (7, 70, 777, 7000)'), /constraint|unique|primary/i);
			// Nothing persists: the anchor row that inserted first is rolled back too.
			expect(await rows(db, 'select * from main.T_core where id = 7')).to.deep.equal([]);
			expect(await rows(db, 'select * from main.T_c where id = 7')).to.deep.equal([]);
		} finally {
			await db.close();
		}
	});

	it('omitting a mandatory member NOT NULL column is rejected with no partial write', async () => {
		const db = new Database();
		try {
			const mod = new AdvertisingModule();
			mod.ads = [split()];
			db.registerModule('nnmod', mod);
			await db.exec('create table T_core (id integer primary key, a integer) using nnmod');
			await db.exec('create table T_b (id integer primary key, b integer not null) using nnmod');
			await db.exec('create table T_c (id integer primary key, c integer) using nnmod');
			await db.exec('declare logical schema x { table T { id integer primary key, a integer, b integer, c integer null } }');
			await db.exec('apply schema x');
			// `b` (mandatory member T_b, NOT NULL, no default) is omitted — caught at
			// analysis time, before any base op fires.
			await expectThrows(() => db.exec('insert into x.T (id, a) values (5, 50)'), /NOT NULL with no default|no value reaches it/i);
			expect(await rows(db, 'select * from main.T_core')).to.deep.equal([]);
		} finally {
			await db.close();
		}
	});
});

/**
 * Non-identity / non-invertible columnar mappings
 * (`decomposition-non-identity-columnar-mapping-coverage`).
 *
 * Every other fixture advertises identity `colMap('a','a')` mappings, so the
 * lineage-driven `classifyColumn` only ever exercises its identity-`member` branch.
 * Here a member's `LogicalColumnMapping.basisExpr` is a non-column expression —
 *   - `bumped` = `a + 1`   → an invertible *transform*: the lineage resolves a
 *     `base` site WITH an `inverse`, so it fails `classifyColumn`'s identity gate
 *     (`inverse === undefined`) and routes to `computed-mapping`;
 *   - `combined` = `a || b` → a non-invertible *composite*: the lineage resolves a
 *     `computed` site (no single base column), which also routes to `computed-mapping`.
 * Both are the lineage-driven replacement for the retired
 * `mapping.basisExpr.type !== 'column'` AST check, and both must be read-only on the
 * put path while the identity sibling `a` on the same member stays writable. Locks
 * the writable/read-only boundary the lineage classification now owns.
 */
describe('lens decomposition put: non-identity columnar mappings (computed-mapping route)', () => {
	const col = (name: string): AST.ColumnExpr => ({ type: 'column', name });
	const lit = (value: number): AST.LiteralExpr => ({ type: 'literal', value });
	const bin = (operator: string, left: AST.Expression, right: AST.Expression): AST.BinaryExpr =>
		({ type: 'binary', operator, left, right });

	/**
	 * Single-member columnar split over main.N_core whose anchor maps two logical
	 * columns through non-column basis expressions (`bumped` = a+1, `combined` = a||b)
	 * alongside the identity columns `id` + `a`. Basis column `b` backs only the
	 * composite (no logical column of its own).
	 */
	function nonIdentityAd(): MappingAdvertisement {
		return {
			id: 'N_core',
			logicalTable: 'N',
			role: 'primary-storage',
			storage: {
				anchorRelationId: 'N_core',
				members: [
					{
						relationId: 'N_core', relation: { schema: 'main', table: 'N_core' }, presence: 'mandatory',
						columns: [
							colMap('id', 'id'),
							colMap('a', 'a'),                                  // identity sibling — stays writable
							{ logicalColumn: 'bumped', basisExpr: bin('+', col('a'), lit(1)) },     // invertible transform
							{ logicalColumn: 'combined', basisExpr: bin('||', col('a'), col('b')) }, // non-invertible composite
						],
					},
				],
				sharedKey: { kind: 'logical-tuple', keyColumnsByRelation: keyMap(['N_core', ['id']]) },
			},
		};
	}

	async function setupNonIdentity(db: Database): Promise<void> {
		const mod = new AdvertisingModule();
		mod.ads = [nonIdentityAd()];
		db.registerModule('nimod', mod);
		// `b` nullable: it backs only the composite (no insertable logical column of its
		// own), so a row inserted through the logical table leaves it null.
		await db.exec('create table N_core (id integer primary key, a integer, b integer null) using nimod');
		// `combined` is nullable: `a||b` is nullable because `b` is (concat with null → null).
		await db.exec('declare logical schema x { table N { id integer primary key, a integer, bumped integer, combined text null } }');
		await db.exec('apply schema x');
		await db.exec('insert into main.N_core values (1, 10, 20)');
	}

	it('the forward transform reads back through the get body (a+1, a||b)', async () => {
		const db = new Database();
		try {
			await setupNonIdentity(db);
			expect(await rows(db, 'select * from x.N order by id')).to.deep.equal([
				{ id: 1, a: 10, bumped: 11, combined: '1020' },
			]);
		} finally {
			await db.close();
		}
	});

	it('an UPDATE of an invertible-transform column (a+1) is rejected as computed (non-invertible)', async () => {
		const db = new Database();
		try {
			await setupNonIdentity(db);
			await expectThrows(() => db.exec('update x.N set bumped = 99 where id = 1'), /computed \(non-invertible\).*read-only/i);
			// Atomic: the backing base value is untouched.
			expect(await rows(db, 'select a from main.N_core where id = 1')).to.deep.equal([{ a: 10 }]);
		} finally {
			await db.close();
		}
	});

	it('an UPDATE of a non-invertible composite column (a||b) is rejected as computed (non-invertible)', async () => {
		const db = new Database();
		try {
			await setupNonIdentity(db);
			await expectThrows(() => db.exec("update x.N set combined = 'x' where id = 1"), /computed \(non-invertible\).*read-only/i);
			expect(await rows(db, 'select a, b from main.N_core where id = 1')).to.deep.equal([{ a: 10, b: 20 }]);
		} finally {
			await db.close();
		}
	});

	it('an INSERT into a non-identity column is rejected (cannot receive an inserted value)', async () => {
		const db = new Database();
		try {
			await setupNonIdentity(db);
			await expectThrows(
				() => db.exec('insert into x.N (id, bumped) values (2, 5)'),
				/computed \(non-invertible\).*cannot receive an inserted value/i,
			);
			await expectThrows(
				() => db.exec("insert into x.N (id, combined) values (2, 'z')"),
				/computed \(non-invertible\).*cannot receive an inserted value/i,
			);
			// Atomic: no anchor row materialized for the rejected inserts.
			expect(await rows(db, 'select id from main.N_core order by id')).to.deep.equal([{ id: 1 }]);
		} finally {
			await db.close();
		}
	});

	it('the identity sibling (a) on the same member stays writable — no collateral read-only', async () => {
		const db = new Database();
		try {
			await setupNonIdentity(db);
			// UPDATE of the identity column routes to the member and writes through.
			await db.exec('update x.N set a = 42 where id = 1');
			expect(await rows(db, 'select a from main.N_core where id = 1')).to.deep.equal([{ a: 42 }]);
			// And the computed columns recompute off the new base value on read-back.
			expect(await rows(db, 'select * from x.N order by id')).to.deep.equal([
				{ id: 1, a: 42, bumped: 43, combined: '4220' },
			]);
			// INSERT supplying only identity columns materializes the row.
			await db.exec('insert into x.N (id, a) values (2, 100)');
			expect(await rows(db, 'select id, a, b from main.N_core order by id')).to.deep.equal([
				{ id: 1, a: 42, b: 20 }, { id: 2, a: 100, b: null },
			]);
		} finally {
			await db.close();
		}
	});

	// A WHERE on a computed mapping whose basis lives on the ANCHOR is supported, not
	// deferred: `substituteViewColumns` rewrites it into a predicate over the anchor's own
	// base columns (`bumped = 11` → `a + 1 = 11`, `combined = '1020'` → `a || b = '1020'`),
	// which the anchor key subquery already evaluates — no snapshot-consistent multi-member
	// substrate needed. (Contrast the genuine non-anchor-member deferral on the `split()`
	// fixture at the top of the file, which filters on a *different* member's column.)
	it('a DELETE filtered on an invertible-transform anchor column (bumped = a+1) is supported', async () => {
		const db = new Database();
		try {
			await setupNonIdentity(db);
			// Non-matching value deletes nothing (the seeded row has bumped = a+1 = 11).
			await db.exec('delete from x.N where bumped = 999');
			expect(await rows(db, 'select id from main.N_core order by id')).to.deep.equal([{ id: 1 }]);
			// The matched value (11) deletes the row, emptying the anchor table.
			await db.exec('delete from x.N where bumped = 11');
			expect(await rows(db, 'select id from main.N_core order by id')).to.deep.equal([]);
		} finally {
			await db.close();
		}
	});

	it('a DELETE filtered on a non-invertible composite anchor column (a||b) is supported', async () => {
		const db = new Database();
		try {
			await setupNonIdentity(db);
			// Second row → combined = '9920', which the predicate must NOT match.
			await db.exec('insert into main.N_core values (2, 99, 20)');
			await db.exec("delete from x.N where combined = '1020'");
			// Only the matched row (id=1, combined='1020') is removed.
			expect(await rows(db, 'select id from main.N_core order by id')).to.deep.equal([{ id: 2 }]);
		} finally {
			await db.close();
		}
	});

	it('an UPDATE with a WHERE on a computed anchor column (a||b) targets only the matched row', async () => {
		const db = new Database();
		try {
			await setupNonIdentity(db);
			// Second row → combined = '9920'.
			await db.exec('insert into main.N_core values (2, 99, 20)');
			// The SET target `a` is the writable identity sibling; the point of the case is
			// the WHERE on the computed anchor column `combined`, which resolves to the
			// anchor-scoped predicate `a || b = '1020'` and so matches only id=1.
			await db.exec("update x.N set a = 0 where combined = '1020'");
			expect(await rows(db, 'select id, a, b from main.N_core order by id')).to.deep.equal([
				{ id: 1, a: 0, b: 20 }, { id: 2, a: 99, b: 20 },
			]);
		} finally {
			await db.close();
		}
	});

	// A subquery defers regardless of which (anchor-resolvable) column it also names — its
	// multi-member fan-out still needs the snapshot-consistent substrate. The diagnostic is
	// subquery-specific (`embeds a subquery`), not a misattributed "non-anchor member".
	it('a DELETE whose WHERE embeds a subquery is deferred with the subquery-specific diagnostic', async () => {
		const db = new Database();
		try {
			await setupNonIdentity(db);
			await expectThrows(
				() => db.exec('delete from x.N where bumped = (select max(a) from main.N_core)'),
				/embeds a subquery/i,
			);
			// Atomic: the seeded row is untouched.
			expect(await rows(db, 'select id from main.N_core order by id')).to.deep.equal([{ id: 1 }]);
		} finally {
			await db.close();
		}
	});

	/**
	 * Multi-member columnar split whose ANCHOR carries a computed mapping (`bumped = a+1`)
	 * alongside a *mandatory non-anchor* member (M_b). Exercises the interaction the
	 * single-member `nonIdentityAd` fixture cannot: a DELETE filtered on the computed anchor
	 * column must still fan out to the other member. The substituted predicate (`a + 1 = 11`)
	 * is anchor-scoped, so each member reads its identifying set from
	 * `select <anchorKey> from <anchor> where <pred>` — the fan-out is unaffected.
	 */
	function multiMemberComputedAnchorAd(): MappingAdvertisement {
		return {
			id: 'M_core',
			logicalTable: 'M',
			role: 'primary-storage',
			storage: {
				anchorRelationId: 'M_core',
				members: [
					{
						relationId: 'M_core', relation: { schema: 'main', table: 'M_core' }, presence: 'mandatory',
						columns: [colMap('id', 'id'), colMap('a', 'a'), { logicalColumn: 'bumped', basisExpr: bin('+', col('a'), lit(1)) }],
					},
					{ relationId: 'M_b', relation: { schema: 'main', table: 'M_b' }, presence: 'mandatory', columns: [colMap('b', 'b')] },
				],
				sharedKey: { kind: 'logical-tuple', keyColumnsByRelation: keyMap(['M_core', ['id']], ['M_b', ['id']]) },
			},
		};
	}

	async function setupMultiMemberComputedAnchor(db: Database): Promise<void> {
		const mod = new AdvertisingModule();
		mod.ads = [multiMemberComputedAnchorAd()];
		db.registerModule('mmmod', mod);
		await db.exec('create table M_core (id integer primary key, a integer) using mmmod');
		await db.exec('create table M_b (id integer primary key, b integer) using mmmod');
		await db.exec('declare logical schema x { table M { id integer primary key, a integer, bumped integer, b integer } }');
		await db.exec('apply schema x');
		await db.exec('insert into main.M_core values (1, 10), (2, 50)');
		await db.exec('insert into main.M_b values (1, 100), (2, 200)');
	}

	it('a DELETE filtered on a computed anchor column fans out to a non-anchor member (multi-member)', async () => {
		const db = new Database();
		try {
			await setupMultiMemberComputedAnchor(db);
			// Row id=1 has bumped = a+1 = 11. The computed-anchor predicate substitutes to
			// `a + 1 = 11` (anchor-scoped), so the delete reaches BOTH members for id=1 only.
			await db.exec('delete from x.M where bumped = 11');
			expect(await rows(db, 'select id from main.M_core order by id')).to.deep.equal([{ id: 2 }]);
			expect(await rows(db, 'select id from main.M_b order by id')).to.deep.equal([{ id: 2 }]);
		} finally {
			await db.close();
		}
	});
});

/**
 * Lineage-routing robustness (`decomposition-column-classification-robustness`).
 *
 * `classifyColumn` routes a logical column off the threaded `updateLineage` plus the
 * advertisement. Two of its assumptions were unguarded; both classify silently in
 * states unreachable through shipped shapes, so each is hardened with a defensive
 * reject + a test that *constructs* the unreachable state (the constructions are the
 * point — they prove the guard fires before a future change can silently regress it).
 *
 * (a) An **identity** mapping whose lineage fully resolves a base column but whose
 *     base relation is not in `memberByTableId` (a schema/name miss in the build
 *     loop) must NOT fall through to the name-only `member.columns` match and degrade
 *     to a read-only `computed-mapping`; it must surface a `no-base-lineage`
 *     diagnostic. Vehicle: members declared with an EMPTY `relation.schema`.
 *     `resolveBasisRelation` resolves it (empty → basis 'main'), so the body compiles
 *     and reads, but `analyzeDecomposition` matches a planned `TableReferenceNode` to a
 *     member by EXACT `(schema, table)` — '' !== 'main' — so every member misses the
 *     map while each identity column's plan-level lineage still resolves.
 *
 * (b) Two members over the **same** physical base relation (a self-decomposition)
 *     both claim each body `TableReferenceNode`, so `memberByTableId` resolution is
 *     ambiguous. The generic multi-source path rejects self-joins upstream, but that
 *     guard is external; the fan-out must reject locally with a precise diagnostic.
 */
describe('lens decomposition put: column-classification robustness', () => {
	// (a) Empty-schema vehicle: a single-member decomposition whose member declares
	// `relation.schema: ''`. Reads fine (resolved against 'main'); every identity
	// column misses `memberByTableId`.
	function emptySchemaAd(): MappingAdvertisement {
		return {
			id: 'G_core',
			logicalTable: 'G',
			role: 'primary-storage',
			storage: {
				anchorRelationId: 'G_core',
				members: [
					{ relationId: 'G_core', relation: { schema: '', table: 'G_core' }, presence: 'mandatory', columns: [colMap('id', 'id'), colMap('a', 'a')] },
				],
				sharedKey: { kind: 'logical-tuple', keyColumnsByRelation: keyMap(['G_core', ['id']]) },
			},
		};
	}

	async function setupEmptySchema(db: Database): Promise<void> {
		const mod = new AdvertisingModule();
		mod.ads = [emptySchemaAd()];
		db.registerModule('gmod', mod);
		await db.exec('create table G_core (id integer primary key, a integer) using gmod');
		await db.exec('declare logical schema x { table G { id integer primary key, a integer } }');
		await db.exec('apply schema x');
		await db.exec('insert into main.G_core values (1, 10)');
	}

	it('(a) reads through the body even when the member declares an empty schema', async () => {
		const db = new Database();
		try {
			await setupEmptySchema(db);
			// The compiled body resolves the empty schema to the basis ('main'), so the
			// read is unaffected — the miss lives only in the put-side memberByTableId map.
			expect(await rows(db, 'select * from x.G order by id')).to.deep.equal([{ id: 1, a: 10 }]);
		} finally {
			await db.close();
		}
	});

	it('(a) an identity column whose lineage misses memberByTableId surfaces no-base-lineage, not silent read-only', async () => {
		const db = new Database();
		try {
			await setupEmptySchema(db);
			// Updating the identity column `a` must NOT be silently rejected as a
			// "computed (non-invertible) ... read-only" mapping (the pre-hardening
			// fall-through); it surfaces the lineage-resolution miss instead.
			let msg = '';
			try {
				await db.exec('update x.G set a = 99');
			} catch (e) {
				msg = e instanceof Error ? e.message : String(e);
			}
			expect(msg, 'expected a lineage-resolution-miss diagnostic').to.match(/lineage-resolution miss/i);
			expect(msg, 'must not masquerade as a computed/non-invertible mapping').to.not.match(/computed \(non-invertible\)/i);
			// Atomic: the backing base value is untouched.
			expect(await rows(db, 'select a from main.G_core where id = 1')).to.deep.equal([{ a: 10 }]);
		} finally {
			await db.close();
		}
	});

	// (b) Self-decomposition vehicle: two members ('S_a', 'S_b') over the SAME base
	// table main.S, joined on the shared key — a self-join the read tolerates but the
	// put fan-out cannot route unambiguously.
	function selfDecompositionAd(): MappingAdvertisement {
		return {
			id: 'S_a',
			logicalTable: 'S',
			role: 'primary-storage',
			storage: {
				anchorRelationId: 'S_a',
				members: [
					{ relationId: 'S_a', relation: { schema: 'main', table: 'S' }, presence: 'mandatory', columns: [colMap('id', 'id'), colMap('x', 'x')] },
					{ relationId: 'S_b', relation: { schema: 'main', table: 'S' }, presence: 'mandatory', columns: [colMap('y', 'y')] },
				],
				sharedKey: { kind: 'logical-tuple', keyColumnsByRelation: keyMap(['S_a', ['id']], ['S_b', ['id']]) },
			},
		};
	}

	async function setupSelfDecomposition(db: Database): Promise<void> {
		const mod = new AdvertisingModule();
		mod.ads = [selfDecompositionAd()];
		db.registerModule('smod', mod);
		await db.exec('create table S (id integer primary key, x integer, y integer) using smod');
		await db.exec('declare logical schema x { table S { id integer primary key, x integer, y integer } }');
		await db.exec('apply schema x');
		await db.exec('insert into main.S values (1, 10, 100)');
	}

	it('(b) reads through the synthesized self-join', async () => {
		const db = new Database();
		try {
			await setupSelfDecomposition(db);
			// The self-join over the shared key (id) is 1:1 on the PK, so the read is sound.
			expect(await rows(db, 'select * from x.S order by id')).to.deep.equal([{ id: 1, x: 10, y: 100 }]);
		} finally {
			await db.close();
		}
	});

	it('(b) a write rejects the ambiguous self-decomposition (two members, one base relation)', async () => {
		const db = new Database();
		try {
			await setupSelfDecomposition(db);
			await expectThrows(() => db.exec('update x.S set x = 99 where id = 1'), /self-decomposition|both resolve to the same base relation/i);
			// Atomic: the rejected write left the base table untouched.
			expect(await rows(db, 'select id, x, y from main.S order by id')).to.deep.equal([{ id: 1, x: 10, y: 100 }]);
		} finally {
			await db.close();
		}
	});
});

/**
 * Stitch-key / EAV-conflict-target uniqueness guard
 * (`view-write-decomp-stitch-key-unique-guard`, docs/lens.md
 * § The `put` fan-out).
 *
 * The put fan-out cedes the matched rows to the matched UPDATE only through the
 * materialize INSERT's `on conflict (<target>) do nothing`, which the runtime fires
 * solely on a declared PK / UNIQUE violation; the get side is sound only when that same
 * target is 1:1. `validatePrimaryAdvertisement` enforces this at deploy time: every
 * columnar member's stitch key and every EAV pivot's `(entity, attribute)` must equal a
 * declared PRIMARY KEY / non-partial UNIQUE on its basis. These cases pin the boundary —
 * a non-unique target is rejected at `apply schema`; a UNIQUE (not PK) target deploys and
 * round-trips; the empty-stitch singleton is skipped, not rejected.
 *
 * (The self-decomposition and empty-schema shapes already deploy through the existing
 * `column-classification robustness` describe's `reads through …` tests — their `apply
 * schema` would throw here if the guard wrongly rejected them, so they need no separate
 * deploy smoke.)
 */
describe('lens decomposition put: stitch-key uniqueness guard', () => {
	// Columnar optional member whose stitch key (`id`) is a plain non-unique column —
	// the basis PK is a *different* column (`rid`), so `id` backs no declared unique.
	function nonUniqueColumnarAd(): MappingAdvertisement {
		return {
			id: 'U_core', logicalTable: 'U', role: 'primary-storage',
			storage: {
				anchorRelationId: 'U_core',
				members: [
					{ relationId: 'U_core', relation: { schema: 'main', table: 'U_core' }, presence: 'mandatory', columns: [colMap('id', 'id'), colMap('a', 'a')] },
					{ relationId: 'U_c', relation: { schema: 'main', table: 'U_c' }, presence: 'optional', columns: [colMap('c', 'c')] },
				],
				sharedKey: { kind: 'logical-tuple', keyColumnsByRelation: keyMap(['U_core', ['id']], ['U_c', ['id']]) },
			},
		};
	}

	it('reject: a columnar optional member with a non-unique stitch key fails to deploy', async () => {
		const db = new Database();
		try {
			const mod = new AdvertisingModule();
			mod.ads = [nonUniqueColumnarAd()];
			db.registerModule('umod', mod);
			await db.exec('create table U_core (id integer primary key, a integer) using umod');
			// `id` is a plain non-unique column; the PK is the unrelated `rid`.
			await db.exec('create table U_c (rid integer primary key, id integer, c integer) using umod');
			await db.exec('declare logical schema x { table U { id integer primary key, a integer, c integer } }');
			await expectThrows(() => db.exec('apply schema x'), /stitch key.*not a declared|1:1 stitch/i);
		} finally {
			await db.close();
		}
	});

	// EAV member whose conflict target `(eid, attr)` backs no declared unique — the PK is
	// the unrelated `rid`. The stitch key (`eid` alone) being one-to-many is fine; the
	// guard must check `(entity, attribute)`, not the stitch key.
	function nonUniqueEavAd(): MappingAdvertisement {
		return {
			id: 'Ev_core', logicalTable: 'Ev', role: 'primary-storage',
			storage: {
				anchorRelationId: 'Ev_core',
				members: [
					{ relationId: 'Ev_core', relation: { schema: 'main', table: 'Ev_core' }, presence: 'mandatory', columns: [colMap('id', 'id')] },
					{ relationId: 'Ev_eav', relation: { schema: 'main', table: 'Ev_eav' }, presence: 'optional', columns: [],
						attributePivot: { entityColumn: 'eid', attributeColumn: 'attr', valueColumn: 'val' } },
				],
				sharedKey: { kind: 'logical-tuple', keyColumnsByRelation: keyMap(['Ev_core', ['id']], ['Ev_eav', ['eid']]) },
			},
		};
	}

	it('reject: an EAV member whose (entity, attribute) is not unique fails to deploy', async () => {
		const db = new Database();
		try {
			const mod = new AdvertisingModule();
			mod.ads = [nonUniqueEavAd()];
			db.registerModule('evmod', mod);
			await db.exec('create table Ev_core (id integer primary key) using evmod');
			// (eid, attr) has no PK/UNIQUE — the PK is the unrelated `rid`.
			await db.exec('create table Ev_eav (rid integer primary key, eid integer, attr text, val integer) using evmod');
			await db.exec('declare logical schema x { table Ev { id integer primary key, p integer, q integer } }');
			await expectThrows(() => db.exec('apply schema x'), /EAV pivot.*conflict target.*not a declared/i);
		} finally {
			await db.close();
		}
	});

	// UNIQUE (not PK) stitch key: `id` is `unique` while the basis PK is a separate
	// surrogate `rid`. `rid` carries a high-water-mark default (PK columns are NOT NULL
	// with no auto-rowid in Quereus) so the materialize INSERT — which inserts only
	// (stitchKey, value) — can fill it. The guard must accept the UNIQUE, and the runtime
	// `on conflict (id) do nothing` must resolve against it.
	function uniqueStitchAd(): MappingAdvertisement {
		return {
			id: 'W_core', logicalTable: 'W', role: 'primary-storage',
			storage: {
				anchorRelationId: 'W_core',
				members: [
					{ relationId: 'W_core', relation: { schema: 'main', table: 'W_core' }, presence: 'mandatory', columns: [colMap('id', 'id'), colMap('a', 'a')] },
					{ relationId: 'W_c', relation: { schema: 'main', table: 'W_c' }, presence: 'optional', columns: [colMap('c', 'c')] },
				],
				sharedKey: { kind: 'logical-tuple', keyColumnsByRelation: keyMap(['W_core', ['id']], ['W_c', ['id']]) },
			},
		};
	}

	it('accept: a UNIQUE (not PK) stitch key deploys and round-trips through the materialize INSERT', async () => {
		const db = new Database();
		try {
			const mod = new AdvertisingModule();
			mod.ads = [uniqueStitchAd()];
			db.registerModule('wmod', mod);
			await db.exec('create table W_core (id integer primary key, a integer) using wmod');
			await db.exec('create table W_c (rid integer primary key default (coalesce((select max(rid) from W_c), 0) + mutation_ordinal()), id integer unique, c integer) using wmod');
			await db.exec('declare logical schema x { table W { id integer primary key, a integer, c integer null } }');
			await db.exec('apply schema x'); // deploys: stitch key `id` is a declared UNIQUE
			await db.exec('insert into main.W_core values (1, 10), (2, 20)');
			await db.exec('insert into main.W_c (rid, id, c) values (100, 1, 1000)'); // only id 1 present

			// Matched (row 1 present) → base UPDATE; the materialize INSERT collides on the
			// UNIQUE(id) and is ceded via `on conflict (id) do nothing`. A non-unique `id`
			// would double-insert and trip the UNIQUE at write time instead of ceding.
			await db.exec('update x.W set c = 5 where id = 1');
			expect(await rows(db, 'select id, c from main.W_c order by id')).to.deep.equal([{ id: 1, c: 5 }]);

			// Absent (row 2 has no W_c row) → materialize via `on conflict (id) do nothing`;
			// the surrogate PK `rid` auto-fills from its default.
			await db.exec('update x.W set c = 7 where id = 2');
			expect(await rows(db, 'select c from x.W where id = 2')).to.deep.equal([{ c: 7 }]);
			expect(await rows(db, 'select count(*) as n from main.W_c')).to.deep.equal([{ n: 2 }]); // no double-insert
		} finally {
			await db.close();
		}
	});

	it('accept: a singleton (empty stitch key) deploys — no stitch to validate, no materialize path', async () => {
		const db = new Database();
		try {
			const mod = new AdvertisingModule();
			mod.ads = [singletonAd()];
			db.registerModule('cfgmod', mod);
			await db.exec('create table Cfg_a (theme text, primary key ()) using cfgmod');
			await db.exec('create table Cfg_b (lang text, primary key ()) using cfgmod');
			await db.exec('declare logical schema x { table Cfg { theme text, lang text, primary key () } }');
			let threw = false;
			try {
				await db.exec('apply schema x');
			} catch {
				threw = true;
			}
			expect(threw, 'a singleton (empty stitch key) must deploy, not be rejected by the uniqueness guard').to.be.false;
		} finally {
			await db.close();
		}
	});

	it('reject: a partial UNIQUE on the stitch column does not satisfy the guard', async () => {
		// `id` carries only a *partial* unique (`create unique index … where`), whose
		// `predicate !== undefined` — it guarantees uniqueness only within its scope and
		// cannot back an unqualified `on conflict (id)`. `columnsFormDeclaredKey` skips
		// it, so the stitch key still resolves to no whole-table key → rejected. (Reuses
		// the columnar shape: stitch `id` on U_c, whose PK is the unrelated `rid`.)
		const db = new Database();
		try {
			const mod = new AdvertisingModule();
			mod.ads = [nonUniqueColumnarAd()];
			db.registerModule('umod', mod);
			await db.exec('create table U_core (id integer primary key, a integer) using umod');
			await db.exec('create table U_c (rid integer primary key, id integer, c integer) using umod');
			await db.exec('create unique index ix_uc_id on U_c (id) where id > 0'); // partial — does not qualify
			await db.exec('declare logical schema x { table U { id integer primary key, a integer, c integer } }');
			await expectThrows(() => db.exec('apply schema x'), /stitch key.*not a declared|1:1 stitch/i);
		} finally {
			await db.close();
		}
	});

	// Anchor whose own stitch key (`id`) is a plain non-unique column — the basis PK is
	// the unrelated `rid`. The guard validates the anchor like any other member, so a
	// non-unique anchor identity must be rejected (the logical-PK identity is not 1:1).
	function nonUniqueAnchorAd(): MappingAdvertisement {
		return {
			id: 'An_core', logicalTable: 'An', role: 'primary-storage',
			storage: {
				anchorRelationId: 'An_core',
				members: [
					{ relationId: 'An_core', relation: { schema: 'main', table: 'An_core' }, presence: 'mandatory', columns: [colMap('id', 'id'), colMap('a', 'a')] },
				],
				sharedKey: { kind: 'logical-tuple', keyColumnsByRelation: keyMap(['An_core', ['id']]) },
			},
		};
	}

	it('reject: a non-unique anchor stitch key fails to deploy', async () => {
		const db = new Database();
		try {
			const mod = new AdvertisingModule();
			mod.ads = [nonUniqueAnchorAd()];
			db.registerModule('anmod', mod);
			// `id` is a plain non-unique column; the PK is the unrelated `rid`.
			await db.exec('create table An_core (rid integer primary key, id integer, a integer) using anmod');
			await db.exec('declare logical schema x { table An { id integer primary key, a integer } }');
			await expectThrows(() => db.exec('apply schema x'), /stitch key.*not a declared|1:1 stitch/i);
		} finally {
			await db.close();
		}
	});
});

/**
 * Surrogate-keyed OPTIONAL-member UPDATE materialization
 * (`view-write-decomp-update-test-coverage`, corner #2).
 *
 * The optional-member UPDATE/materialize/delete path has only ever been exercised under a
 * **logical-tuple** key, where the anchor's stitch column and the member's stitch column
 * are spelled IDENTICALLY. Under a **surrogate** shared key they are spelled DISTINCTLY
 * (`sid` on the anchor, `meta_sid` on the optional member). `buildOptionalMaterializeInsert`
 * threads `singleKeyColumn(anchor)` into the materialize INSERT's projection
 * (`select <anchor>.sid …`) and `singleKeyColumn(member)` as the INSERT target key
 * (`insert into Doc_meta (meta_sid, …)`). For an optional member of an EXISTING logical row
 * it reads the existing anchor key — it does NOT re-evaluate the surrogate default (that
 * fires only for a brand-new logical row at INSERT). These tests pin that the existing
 * anchor surrogate threads correctly into the distinctly-spelled member key.
 */
describe('lens decomposition put: surrogate-keyed optional-member UPDATE', () => {
	function surrogateOptionalAd(): MappingAdvertisement {
		return {
			id: 'Doc_core',
			logicalTable: 'Doc',
			role: 'primary-storage',
			storage: {
				anchorRelationId: 'Doc_core',
				members: [
					{ relationId: 'Doc_core', relation: { schema: 'main', table: 'Doc_core' }, presence: 'mandatory', columns: [colMap('docKey', 'doc_key'), colMap('title', 'title')] },
					{ relationId: 'Doc_body', relation: { schema: 'main', table: 'Doc_body' }, presence: 'mandatory', columns: [colMap('body', 'body')] },
					{ relationId: 'Doc_meta', relation: { schema: 'main', table: 'Doc_meta' }, presence: 'optional', columns: [colMap('note', 'note')] },
				],
				sharedKey: {
					kind: 'surrogate',
					keyColumnsByRelation: keyMap(['Doc_core', ['sid']], ['Doc_body', ['doc_sid']], ['Doc_meta', ['meta_sid']]),
				},
			},
		};
	}

	// Seed: k1 (sid 100) carries the optional Doc_meta component; k2 (sid 101) does not.
	// The anchor `sid` declares the high-water-mark allocator default (the surrogate's value
	// source for a brand-new logical INSERT), but the UPDATE-materialize path here must reuse
	// the EXISTING anchor surrogate — which the meta_sid assertions pin.
	async function setupSurrogateOptional(db: Database): Promise<void> {
		const mod = new AdvertisingModule();
		mod.ads = [surrogateOptionalAd()];
		db.registerModule('docmetamod', mod);
		// `doc_key` carries NO basis UNIQUE: the logical PK `docKey` (the user-facing
		// natural key; the surrogate `sid` is the internal stitch) has no basis covering
		// structure, so its uniqueness obligation is `enforced-set-level` / commit-time —
		// the lens synthesizes a deferred `NEW.doc_key`-referencing count CHECK. The
		// per-op resolvability gate (view-mutation-builder) threads that CHECK only onto
		// the fan-out op whose target carries `doc_key` (the Doc_core anchor). A member-
		// only UPDATE like `set note=…` fans out to Doc_meta ops alone (no doc_key), so the
		// CHECK rides no op and is dropped — correct, a key-unchanged UPDATE can't dup the
		// key — and the Doc_meta member UPDATE / materialize-INSERT build cleanly. An
		// `update … set docKey=…` routes the CHECK onto the Doc_core anchor (pinned by the
		// `commit-time uniqueness CHECK` regression below).
		await db.exec('create table Doc_core (sid integer primary key default (coalesce((select max(sid) from Doc_core), 0) + mutation_ordinal()), doc_key text, title text) using docmetamod');
		await db.exec('create table Doc_body (doc_sid integer primary key, body text) using docmetamod');
		await db.exec('create table Doc_meta (meta_sid integer primary key, note text) using docmetamod');
		await db.exec('declare logical schema x { table Doc { docKey text primary key, title text, body text, note text null } }');
		await db.exec('apply schema x');
		await db.exec("insert into main.Doc_core (sid, doc_key, title) values (100, 'k1', 'First'), (101, 'k2', 'Second')");
		await db.exec("insert into main.Doc_body values (100, 'b1'), (101, 'b2')");
		await db.exec("insert into main.Doc_meta values (100, 'm1')");   // only k1 has the optional component
	}

	it('matched UPDATE writes the existing optional component through the surrogate stitch', async () => {
		const db = new Database();
		try {
			await setupSurrogateOptional(db);
			// k1 (sid 100) has a Doc_meta row → matched base UPDATE; no new row materializes.
			await db.exec("update x.Doc set note = 'm1b' where docKey = 'k1'");
			expect(await rows(db, 'select meta_sid, note from main.Doc_meta order by meta_sid')).to.deep.equal([{ meta_sid: 100, note: 'm1b' }]);
			expect(await rows(db, "select note from x.Doc where docKey = 'k1'")).to.deep.equal([{ note: 'm1b' }]);
		} finally {
			await db.close();
		}
	});

	it('absent → materialize INSERT threads the existing anchor surrogate into the distinctly-spelled member key', async () => {
		const db = new Database();
		try {
			await setupSurrogateOptional(db);
			// k2 (sid 101) lacks a Doc_meta row. The materialize INSERT reads the EXISTING
			// anchor key (`select Doc_core.sid …` = 101) — NOT a freshly minted surrogate — and
			// threads it into the distinctly-spelled member key `meta_sid`.
			await db.exec("update x.Doc set note = 'm2' where docKey = 'k2'");
			// The headline thread-through: meta_sid = 101 (the existing anchor sid for k2).
			expect(await rows(db, "select meta_sid, note from main.Doc_meta where note = 'm2'")).to.deep.equal([{ meta_sid: 101, note: 'm2' }]);
			// k1's component is untouched; the view surfaces the new note for k2.
			expect(await rows(db, 'select meta_sid, note from main.Doc_meta order by meta_sid')).to.deep.equal([
				{ meta_sid: 100, note: 'm1' }, { meta_sid: 101, note: 'm2' },
			]);
			expect(await rows(db, "select note from x.Doc where docKey = 'k2'")).to.deep.equal([{ note: 'm2' }]);
		} finally {
			await db.close();
		}
	});

	it("all-null UPDATE deletes the optional component (note is the member's only value column)", async () => {
		const db = new Database();
		try {
			await setupSurrogateOptional(db);
			// `note` is Doc_meta's only value column → setting it null empties (deletes) the row.
			await db.exec("update x.Doc set note = null where docKey = 'k1'");
			expect(await rows(db, 'select meta_sid from main.Doc_meta order by meta_sid')).to.deep.equal([]);
			expect(await rows(db, "select note from x.Doc where docKey = 'k1'")).to.deep.equal([{ note: null }]);
		} finally {
			await db.close();
		}
	});

	it('a null write to an already-absent optional component is a no-op (no materialize INSERT)', async () => {
		const db = new Database();
		try {
			await setupSurrogateOptional(db);
			// k2 already lacks a Doc_meta component. An all-null write emits no materialize
			// INSERT (the fan-out adds one only when some assigned value is non-null), so the
			// absent component stays absent and k1's present component is left untouched.
			await db.exec("update x.Doc set note = null where docKey = 'k2'");
			expect(await rows(db, 'select meta_sid, note from main.Doc_meta order by meta_sid')).to.deep.equal([{ meta_sid: 100, note: 'm1' }]);
			expect(await rows(db, 'select count(*) as n from main.Doc_meta where meta_sid = 101')).to.deep.equal([{ n: 0 }]);
		} finally {
			await db.close();
		}
	});

	// The per-op resolvability gate's other arm: with NO basis uniqueness on `doc_key`, the
	// logical-PK uniqueness obligation is `enforced-set-level` / commit-time, so the lens
	// synthesizes a `NEW.doc_key`-referencing count CHECK. The member-only tests above pin
	// that it rides NO op (dropped) on a `set note=…` fan-out (Doc_meta members lack
	// doc_key). This test pins the dual: a `set docKey=…` fans out to the Doc_core anchor
	// (which owns doc_key), so the CHECK rides THAT op and still fires — a unique re-key
	// builds and runs, a duplicate re-key ABORTs at commit (count ≥ 2). Together they prove
	// the gate routes the CHECK precisely onto the op that owns the key, never onto a member
	// that cannot resolve it.
	it('a docKey re-key routes the commit-time uniqueness CHECK onto the Doc_core anchor op', async () => {
		const db = new Database();
		try {
			await setupSurrogateOptional(db);
			// Re-key k1 to a fresh, unique docKey → the count CHECK sees count 1 and passes;
			// it must build (the CHECK rides the Doc_core anchor UPDATE, which owns doc_key).
			await db.exec("update x.Doc set docKey = 'k3' where docKey = 'k1'");
			expect(await rows(db, 'select sid, doc_key from main.Doc_core order by sid')).to.deep.equal([
				{ sid: 100, doc_key: 'k3' }, { sid: 101, doc_key: 'k2' },
			]);
			// Re-key k3 onto k2's existing docKey → a duplicate logical PK ⇒ the commit-time
			// count CHECK sees count 2 ⇒ ABORT. Proves the CHECK still fires on the key-owning op.
			await expectThrows(() => db.exec("update x.Doc set docKey = 'k2' where docKey = 'k3'"), /primary|unique|constraint/i);
			// The aborted re-key rolled back: k3 survives, no duplicate landed.
			expect(await rows(db, 'select sid, doc_key from main.Doc_core order by sid')).to.deep.equal([
				{ sid: 100, doc_key: 'k3' }, { sid: 101, doc_key: 'k2' },
			]);
		} finally {
			await db.close();
		}
	});

	// The CHECK arm of the per-op resolvability gate (`constraintsForOp` /
	// view-mutation-builder.ts). The gate threads each lens-synthesized row-local CHECK onto
	// the member fan-out ops whose target table resolves EVERY write-row column the CHECK
	// references. Pinned here against the same surrogate decomposition (`title` on Doc_core,
	// `note` on Doc_meta — a genuine cross-member pair):
	//  - a CHECK spanning columns on MORE THAN ONE member (`title <> note`, write-row
	//    {title, note}) resolves on no single member op ⇒ rides none ⇒ silently DEFERRED
	//    (matching the decomposition INSERT path, which runs the same per-op gate and so
	//    likewise defers only cross-member checks while enforcing single-member ones);
	//  - a SINGLE-member-resolvable CHECK (`length(title) < 5`, write-row {title}) rides the
	//    Doc_core member op and still FIRES (ABORTs on violation).
	// This is the documented (docs/lens.md § Enforcement by constraint class) but otherwise
	// test-unpinned arm of the gate (the set-level key-routing arm is pinned by the docKey
	// re-key test above). The cross-member deferral is a deliberately weaker contract — these
	// assertions nail the boundary in place so a future change to the gate cannot silently
	// flip which side a CHECK lands on.
	async function setupSurrogateWithChecks(db: Database): Promise<void> {
		const mod = new AdvertisingModule();
		mod.ads = [surrogateOptionalAd()];
		db.registerModule('docchkmod', mod);
		await db.exec('create table Doc_core (sid integer primary key default (coalesce((select max(sid) from Doc_core), 0) + mutation_ordinal()), doc_key text, title text) using docchkmod');
		await db.exec('create table Doc_body (doc_sid integer primary key, body text) using docchkmod');
		await db.exec('create table Doc_meta (meta_sid integer primary key, note text) using docchkmod');
		// `title <> note` spans Doc_core (title) + Doc_meta (note) ⇒ write-row {title, note},
		// resolvable on no single member op ⇒ deferred. `length(title) < 5` references only
		// title (Doc_core) ⇒ write-row {title} ⇒ rides the Doc_core member op ⇒ fires.
		await db.exec('declare logical schema x { table Doc { docKey text primary key, title text, body text, note text null, constraint xmember check (title <> note), constraint titlelen check (length(title) < 5) } }');
		await db.exec('apply schema x');
		// Seed satisfies both CHECKs (titles len 3 < 5; title <> note): k1 carries the optional
		// Doc_meta note, k2 does not. Direct basis inserts bypass the lens, so the seed itself
		// is not gated by the logical CHECKs.
		await db.exec("insert into main.Doc_core (sid, doc_key, title) values (100, 'k1', 'aaa'), (101, 'k2', 'bbb')");
		await db.exec("insert into main.Doc_body values (100, 'b1'), (101, 'b2')");
		await db.exec("insert into main.Doc_meta values (100, 'm1')");
	}

	it('defers a cross-member CHECK (title <> note): a violating UPDATE passes and persists the violation', async () => {
		const db = new Database();
		try {
			await setupSurrogateWithChecks(db);
			// Assign BOTH title (→ Doc_core) and note (→ Doc_meta) to the same value so the
			// violation genuinely spans the two members — the fan-out emits a Doc_core op AND a
			// Doc_meta op, yet the `title <> note` CHECK's write-row {title, note} resolves on
			// NEITHER (each op carries only one of the pair) ⇒ it rides no op ⇒ deferred. The
			// sibling `length(title) < 5` CHECK rides Doc_core and passes ('z' is short), so the
			// UPDATE succeeds despite the cross-member violation.
			await db.exec("update x.Doc set title = 'z', note = 'z' where docKey = 'k1'");
			// The violating row is persisted across both members and surfaced by the view —
			// documenting the (deliberate) non-enforcement of the cross-member CHECK.
			expect(await rows(db, 'select title from main.Doc_core where sid = 100')).to.deep.equal([{ title: 'z' }]);
			expect(await rows(db, 'select note from main.Doc_meta where meta_sid = 100')).to.deep.equal([{ note: 'z' }]);
			expect(await rows(db, "select title, note from x.Doc where docKey = 'k1'")).to.deep.equal([{ title: 'z', note: 'z' }]);
		} finally {
			await db.close();
		}
	});

	it('enforces a single-member CHECK (length(title) < N): a violating UPDATE ABORTs and leaves the row unmutated', async () => {
		const db = new Database();
		try {
			await setupSurrogateWithChecks(db);
			// `length(title) < 5` references only title ⇒ write-row {title} resolves on the
			// Doc_core member op ⇒ it rides that op and fires. A too-long title ABORTs (the dual
			// of the deferral above: a single-member CHECK is enforced, a cross-member one is not).
			await expectThrows(() => db.exec("update x.Doc set title = 'toolong' where docKey = 'k1'"), /check|constraint|titlelen/i);
			// The aborted UPDATE rolled back: the Doc_core title is unchanged at both layers.
			expect(await rows(db, 'select title from main.Doc_core where sid = 100')).to.deep.equal([{ title: 'aaa' }]);
			expect(await rows(db, "select title from x.Doc where docKey = 'k1'")).to.deep.equal([{ title: 'aaa' }]);
		} finally {
			await db.close();
		}
	});

	it('decomposition INSERT parity: the cross-member CHECK is deferred on INSERT too', async () => {
		const db = new Database();
		try {
			await setupSurrogateWithChecks(db);
			// A decomposition INSERT fans out one op per member off the shared envelope; the
			// cross-member `title <> note` CHECK rides none ⇒ deferred, exactly as on the UPDATE.
			// A brand-new logical row with title == note persists — anchoring the UPDATE deferral
			// against the established INSERT baseline. (`length(title)` passes; 'q' is short.)
			await db.exec("insert into x.Doc (docKey, title, body, note) values ('k9', 'q', 'b9', 'q')");
			expect(await rows(db, "select title, note from x.Doc where docKey = 'k9'")).to.deep.equal([{ title: 'q', note: 'q' }]);
		} finally {
			await db.close();
		}
	});

	it('enforces a single-member CHECK on INSERT: a violating INSERT ABORTs and persists nothing (atomic)', async () => {
		const db = new Database();
		try {
			await setupSurrogateWithChecks(db);
			// The regression this ticket pins. `length(title) < 5` references only title (→ Doc_core),
			// so its write-row {title} resolves on the anchor member insert ⇒ it rides that op and
			// fires on INSERT, exactly as on UPDATE. A too-long title ABORTs the whole fan-out.
			await expectThrows(
				() => db.exec("insert into x.Doc (docKey, title, body) values ('kX', 'toolong', 'bX')"),
				/check|constraint|titlelen/i);
			// Atomic: the anchor member insert fires first, but the aborted statement rolls the whole
			// fan-out back — no partial Doc_core (or Doc_body) row survives for the new key.
			expect(await rows(db, "select doc_key from main.Doc_core where doc_key = 'kX'")).to.deep.equal([]);
			expect(await rows(db, "select docKey from x.Doc where docKey = 'kX'")).to.deep.equal([]);
		} finally {
			await db.close();
		}
	});

	it('passes a valid single-member-CHECK INSERT: a short-title row inserts and round-trips', async () => {
		const db = new Database();
		try {
			await setupSurrogateWithChecks(db);
			// The dual of the ABORT above — guards against over-deferral / a false ABORT. A short
			// title satisfies `length(title) < 5`, and `title <> note` holds (no note supplied), so
			// the INSERT succeeds and the logical row round-trips through the view.
			await db.exec("insert into x.Doc (docKey, title, body) values ('kok', 'ok', 'bok')");
			expect(await rows(db, "select docKey, title, body from x.Doc where docKey = 'kok'"))
				.to.deep.equal([{ docKey: 'kok', title: 'ok', body: 'bok' }]);
			expect(await rows(db, "select doc_key, title from main.Doc_core where doc_key = 'kok'"))
				.to.deep.equal([{ doc_key: 'kok', title: 'ok' }]);
		} finally {
			await db.close();
		}
	});

	it('INSERT boundary: a single-member CHECK ABORTs even while the cross-member CHECK is deferred', async () => {
		const db = new Database();
		try {
			await setupSurrogateWithChecks(db);
			// The precise gate boundary on INSERT: supplying a too-long title that ALSO equals note
			// violates BOTH `length(title) < 5` (single-member, write-row {title} ⇒ rides Doc_core)
			// and `title <> note` (cross-member, write-row {title, note} ⇒ rides nothing ⇒ deferred).
			// The single-member CHECK still ABORTs the INSERT — the cross-member deferral does not
			// suppress the enforced one.
			await expectThrows(
				() => db.exec("insert into x.Doc (docKey, title, body, note) values ('kB', 'toolong', 'bB', 'toolong')"),
				/check|constraint|titlelen/i);
			expect(await rows(db, "select doc_key from main.Doc_core where doc_key = 'kB'")).to.deep.equal([]);
		} finally {
			await db.close();
		}
	});

	it('enforces the commit-time set-level key on INSERT: a duplicate logical key ABORTs at commit', async () => {
		const db = new Database();
		try {
			await setupSurrogateWithChecks(db);
			// The fixture's logical PK `docKey` has no basis UNIQUE (Doc_core's PK is the surrogate
			// `sid`), so it enforces via the commit-time count CHECK over `NEW.doc_key` — which rides
			// the anchor (Doc_core) member insert and auto-defers to commit. The seed already holds
			// 'k1' (inserted directly into the basis), so a fresh INSERT of 'k1' through the lens mints
			// a new surrogate sid (the anchor insert itself succeeds), then at commit the count sees
			// two rows with doc_key='k1' ⇒ ABORT. (A short title keeps the row-local CHECK happy.)
			await expectThrows(
				() => db.exec("insert into x.Doc (docKey, title, body) values ('k1', 'dup', 'bd')"),
				/check|constraint|unique|primary/i);
			// Atomic at commit: the speculative anchor row is rolled back, leaving the single seed row.
			expect(await rows(db, "select count(*) as n from main.Doc_core where doc_key = 'k1'"))
				.to.deep.equal([{ n: 1 }]);
		} finally {
			await db.close();
		}
	});

	it('rejects insert-or-replace on a commit-time set-level decomposition up front (not a silent commit ABORT)', async () => {
		const db = new Database();
		try {
			await setupSurrogateWithChecks(db);
			// The decomposition INSERT path threads the commit-time set-level count CHECK now, so its
			// `rejectLensSetLevelConflictResolution` gate must fire here too (it sits below the
			// decomposition early-return in `buildViewMutation`, so `buildDecompositionInsert` runs it
			// itself). `docKey` has no basis covering structure ⇒ commit-time only ⇒ `or replace`
			// cannot be honored row-time, so it is rejected at plan time rather than silently ABORTing
			// at commit.
			await expectThrows(
				() => db.exec("insert or replace into x.Doc (docKey, title, body) values ('k1', 'dup', 'bd')"),
				/replace|conflict|covering structure|commit-time/i);
		} finally {
			await db.close();
		}
	});

	// Subquery-bearing row-local CHECK gating (`lens-decomp-row-local-subquery-metadata-gate`).
	// A logical row-local CHECK may contain a subquery (Quereus supports it — auto-deferred to
	// commit), e.g. `check (exists (select 1 from Allowed where Allowed.name = title))`. Its
	// correlated write-row column (`title`) appears ONLY inside the subquery, so the AST walker
	// (`writeRowColumns`) under-collects it (it assumes a bare subquery-internal ref resolves
	// against the subquery's own FROM). On a decomposition that under-collection let the per-op
	// gate thread the CHECK onto a member op whose target lacks `title`, where the build crashed
	// with `title isn't a column`. The fix carries the write-row dependency as prover-supplied
	// `referencedWriteRowColumns` metadata (the source CHECK's referenced logical columns mapped
	// to basis columns); `constraintsForOp` prefers it over the walk for the row-local class, so
	// the CHECK gates onto the member that owns the column (single-member ⇒ enforced) or rides no
	// member (cross-member ⇒ deferred) — never onto a member it cannot build.
	async function setupSubqueryCheck(db: Database, checkSql: string): Promise<void> {
		const mod = new AdvertisingModule();
		mod.ads = [surrogateOptionalAd()];
		db.registerModule('docsubqmod', mod);
		await db.exec('create table Doc_core (sid integer primary key default (coalesce((select max(sid) from Doc_core), 0) + mutation_ordinal()), doc_key text, title text) using docsubqmod');
		await db.exec('create table Doc_body (doc_sid integer primary key, body text) using docsubqmod');
		await db.exec('create table Doc_meta (meta_sid integer primary key, note text) using docsubqmod');
		// The allow-list the subquery CHECK probes — a plain basis table the correlated
		// write-row column is matched against (`title` / `note` share their logical and basis
		// spellings, so the un-descended `rewriteToBasisTerms` leaves the correlated ref intact).
		await db.exec('create table Allowed (name text, kind text) using docsubqmod');
		await db.exec(`declare logical schema x { table Doc { docKey text primary key, title text, body text, note text null, ${checkSql} } }`);
		await db.exec('apply schema x');
		// Direct basis inserts bypass the lens, so the seed is not gated by the logical CHECK.
		await db.exec("insert into main.Allowed (name, kind) values ('ok', 'g'), ('aaa', 'g'), ('bbb', 'g')");
		await db.exec("insert into main.Doc_core (sid, doc_key, title) values (100, 'k1', 'aaa'), (101, 'k2', 'bbb')");
		await db.exec("insert into main.Doc_body values (100, 'b1'), (101, 'b2')");
		await db.exec("insert into main.Doc_meta values (100, 'm1')");   // only k1 has the optional component
	}

	it('single-member subquery CHECK: an UPDATE touching another member builds and runs (no "isn\'t a column" crash)', async () => {
		const db = new Database();
		try {
			// `title` is the only referenced write-row column (it lives on Doc_core); `Allowed.name`
			// is a foreign ref excluded from the metadata. The UPDATE assigns title (→ Doc_core) AND
			// note (→ Doc_meta), so the fan-out emits a Doc_meta op too. Pre-fix the walker under-
			// collected `title` ⇒ the CHECK (empty write-row set) rode EVERY op ⇒ it was threaded onto
			// the Doc_meta op, which lacks `title`, and the build crashed. Post-fix the metadata
			// {title} gates it onto Doc_core only ⇒ it builds, runs, and passes ('ok' is allowed).
			await setupSubqueryCheck(db, 'constraint titleallow check (exists (select 1 from Allowed where Allowed.name = title))');
			await db.exec("update x.Doc set title = 'ok', note = 'n1' where docKey = 'k1'");
			expect(await rows(db, 'select title from main.Doc_core where sid = 100')).to.deep.equal([{ title: 'ok' }]);
			expect(await rows(db, 'select note from main.Doc_meta where meta_sid = 100')).to.deep.equal([{ note: 'n1' }]);
			expect(await rows(db, "select title, note from x.Doc where docKey = 'k1'")).to.deep.equal([{ title: 'ok', note: 'n1' }]);
		} finally {
			await db.close();
		}
	});

	it('single-member subquery CHECK rides the column-owning member and ABORTs a violating UPDATE', async () => {
		const db = new Database();
		try {
			// The dual of the build-and-pass case: the metadata gates the CHECK onto Doc_core (which
			// owns title), so a title NOT in the allow-list makes the deferred subquery CHECK ABORT at
			// commit — the CHECK is genuinely ENFORCED, not merely build-safe.
			await setupSubqueryCheck(db, 'constraint titleallow check (exists (select 1 from Allowed where Allowed.name = title))');
			await expectThrows(() => db.exec("update x.Doc set title = 'nope', note = 'n2' where docKey = 'k1'"), /check|constraint|titleallow/i);
			// The aborted UPDATE rolled back across both members: title and note are unchanged.
			expect(await rows(db, 'select title from main.Doc_core where sid = 100')).to.deep.equal([{ title: 'aaa' }]);
			expect(await rows(db, 'select note from main.Doc_meta where meta_sid = 100')).to.deep.equal([{ note: 'm1' }]);
		} finally {
			await db.close();
		}
	});

	it('cross-member subquery CHECK resolves on no single member op ⇒ deferred (no crash, violation persists)', async () => {
		const db = new Database();
		try {
			// The subquery correlates BOTH `title` (Doc_core) and `note` (Doc_meta) — a genuine
			// cross-member pair. Metadata {title, note} resolves on neither member op, so the CHECK
			// rides none and is deferred (matching the decomposition INSERT path). Pre-fix the empty
			// write-row set would have ridden every op and crashed on the member lacking the other
			// column; post-fix it builds cleanly and the cross-member violation persists unenforced.
			await setupSubqueryCheck(db, 'constraint xallow check (exists (select 1 from Allowed where Allowed.name = title and Allowed.kind = note))');
			await db.exec("update x.Doc set title = 'zzz', note = 'zzz' where docKey = 'k1'");
			expect(await rows(db, 'select title from main.Doc_core where sid = 100')).to.deep.equal([{ title: 'zzz' }]);
			expect(await rows(db, 'select note from main.Doc_meta where meta_sid = 100')).to.deep.equal([{ note: 'zzz' }]);
			expect(await rows(db, "select title, note from x.Doc where docKey = 'k1'")).to.deep.equal([{ title: 'zzz', note: 'zzz' }]);
		} finally {
			await db.close();
		}
	});

	// The rename twist (`lens-rowlocal-subquery-correlated-rename-rewrite`): the prior gate fix
	// used same-named `title`/`note` correlations, where the un-descended `rewriteToBasisTerms`
	// left the bare subquery-internal ref intact and it happened to still resolve (logical ==
	// basis). When the correlated write-row column is RENAMED (`docKey` logical → `doc_key`
	// basis), the un-descended rewrite left `docKey` verbatim and the built constraint crashed
	// with `Column not found: docKey`. The scope-aware rewrite spells the correlated ref `doc_key`
	// while leaving the foreign `Allowed.name` ref and any subquery-LOCAL ref untouched.
	it('decomposition: a subquery CHECK correlating the renamed key column (docKey→doc_key) builds and enforces', async () => {
		const db = new Database();
		try {
			// `docKey` (logical PK) maps to basis `doc_key` on the Doc_core anchor and appears
			// ONLY inside the subquery. Pre-fix the un-descended rewrite left it verbatim ⇒ build
			// crash; post-fix it spells `doc_key`, gates onto Doc_core (which owns doc_key), and
			// fires at commit.
			await setupSubqueryCheck(db, 'constraint keyallow check (exists (select 1 from Allowed where Allowed.name = docKey))');
			// Admit only k1 on the doc-key allow-list (k2 stays unlisted). A title-only UPDATE
			// leaves docKey unchanged, so NEW.doc_key is the row's key.
			await db.exec("insert into main.Allowed (name, kind) values ('k1', 'g')");

			// k1 IS allow-listed ⇒ the deferred subquery CHECK passes; the title-only fan-out
			// (Doc_core only) builds with `doc_key` resolvable and commits.
			await db.exec("update x.Doc set title = 'ok' where docKey = 'k1'");
			expect(await rows(db, 'select title from main.Doc_core where sid = 100')).to.deep.equal([{ title: 'ok' }]);

			// k2 is NOT allow-listed ⇒ the same CHECK ABORTs at commit; the row rolls back.
			await expectThrows(() => db.exec("update x.Doc set title = 'nope' where docKey = 'k2'"), /check|constraint|keyallow/i);
			expect(await rows(db, 'select title from main.Doc_core where sid = 101')).to.deep.equal([{ title: 'bbb' }]);
		} finally {
			await db.close();
		}
	});

	it('decomposition rename: the rewrite spells the correlated key in basis terms, the foreign ref intact, metadata consistent', async () => {
		const db = new Database();
		try {
			await setupSubqueryCheck(db, 'constraint keyallow check (exists (select 1 from Allowed where Allowed.name = docKey))');
			const constraints = collectLensRowLocalConstraints(makeCtx(db), slotX(db, 'Doc'));
			const c = constraints.find(rc => rc.name === 'lens:keyallow');
			expect(c, 'the routed subquery CHECK is present').to.not.be.undefined;
			const exprSql = astToString(c!.expr);
			// The correlated write-row ref `docKey` is rewritten to the basis `doc_key`...
			expect(exprSql, 'correlated docKey rewritten to basis doc_key').to.match(/doc_key/);
			expect(exprSql, 'no leftover logical docKey spelling').to.not.match(/docKey/);
			// ...while the foreign subquery ref `Allowed.name` (qualifier ≠ logical table) is left
			// untouched (it resolves against the subquery FROM, not the write row).
			expect(exprSql, 'foreign Allowed ref left intact').to.match(/allowed/i);
			// The gate metadata over-collects the source CHECK's mapped logical columns: only the
			// write-row `docKey`→`doc_key` (the foreign `Allowed.name` is not a logical column).
			expect(c!.referencedWriteRowColumns, 'metadata stays consistent with the rewrite').to.deep.equal(['doc_key']);
		} finally {
			await db.close();
		}
	});

	it('decomposition rename: a subquery-LOCAL ref sharing a logical name is NOT rewritten (the shadow guard)', async () => {
		const db = new Database();
		try {
			// The subquery FROM aliases a source column to `docKey`, so a *bare* `docKey` inside
			// the subquery is subquery-local (shadowed) — it resolves against `src`, NOT the write
			// row. The scope-aware rewrite must leave it spelled `docKey`; only a genuinely
			// correlated ref would be rewritten to `doc_key`. A naive deep rewrite (no shadow
			// tracking) would over-rewrite it to `doc_key` and break the subquery's own binding.
			await setupSubqueryCheck(db, "constraint shadowok check (exists (select 1 from (select name as docKey from Allowed) src where docKey = 'k1'))");
			const constraints = collectLensRowLocalConstraints(makeCtx(db), slotX(db, 'Doc'));
			const exprSql = astToString(constraints.find(rc => rc.name === 'lens:shadowok')!.expr);
			// The shadowed (subquery-local) `docKey` is preserved; nothing is rewritten to basis
			// terms (there is no genuine correlated write-row ref in this CHECK).
			expect(exprSql, 'subquery-local docKey preserved').to.match(/docKey/);
			expect(exprSql, 'no spurious basis rewrite of the shadowed ref').to.not.match(/doc_key/);
		} finally {
			await db.close();
		}
	});

	it('decomposition rename: a tainted (select *) subquery correlating a write-row column is rejected, not mis-rewritten', async () => {
		const db = new Database();
		try {
			// The subquery FROM is a `select *` source, so its columns are not statically
			// resolvable ⇒ the scope is TAINTED: a bare `docKey` inside cannot be proven
			// subquery-local-vs-correlated. Rather than mis-rewrite it (or fall through to a
			// cryptic build crash), the rewrite rejects with a clear `unsupported-subquery-
			// correlation` diagnostic — mirroring the single-source view-column descent's policy.
			await setupSubqueryCheck(db, 'constraint taintchk check (exists (select 1 from (select * from Allowed) sub where docKey = sub.name))');
			expect(() => collectLensRowLocalConstraints(makeCtx(db), slotX(db, 'Doc')))
				.to.throw(/correlat|statically resolvable|select \*/i);
		} finally {
			await db.close();
		}
	});
});

/**
 * Per-op gate routes a lens-synthesized constraint by its **owning basis relation**, not
 * by bare column name (`lens-update-deferred-pk-check-per-op-gate-relation-identity`).
 *
 * A name-match per-column decomposition: each logical column lives in its own `(rowId, val)`
 * member joined on a SURROGATE `rowId`, and — the load-bearing twist — BOTH members spell
 * their value column `val`. The logical PK `id` is a value column (basis `w_id.val`) with no
 * basis covering structure ⇒ commit-time `enforced-set-level` ⇒ the lens synthesizes the
 * deferred `lens:pk` count CHECK whose write-row side is `NEW.val` (`w_id.val`).
 *
 * The bug: the per-op gate decided which member op carries that CHECK by matching the bare
 * basis-column name `val`. A non-key UPDATE (`set name='B'`) fans out to the `w_name` op
 * ALONE; `w_name` ALSO has a column named `val` (its own value), so the bare-name gate
 * wrongly threaded the id-uniqueness CHECK onto the name-only op. At commit the deferred
 * CHECK re-evaluated with the `w_name` row context active, its count subquery's get-join hit
 * the *other* member's surrogate-key reference with no populated row context, and threw
 * `No row context found for column rowId` — losing the update.
 *
 * Matching by owning relation (`id`'s `val` lives on `w_id`, not `w_name`) routes the CHECK
 * onto NO op of a name-only fan-out — correct, a name change cannot introduce an id
 * duplicate — so the UPDATE commits cleanly, while a key-changing UPDATE still routes the
 * CHECK onto the `w_id` op and enforces it (unique re-key commits, duplicate ABORTs). The
 * distinct-value-name variants in the originating ticket already passed; the colliding-name
 * fixture here is the one that exposed the gate bug.
 */
describe('lens decomposition put: per-op gate routes by owning basis relation (colliding value-column names)', () => {
	function perColumnAd(): MappingAdvertisement {
		return {
			id: 'w_id',
			logicalTable: 'W',
			role: 'primary-storage',
			storage: {
				anchorRelationId: 'w_id',
				members: [
					// Both members back their logical column with a basis column NAMED `val` — the
					// collision the bare-name gate could not disambiguate.
					{ relationId: 'w_id', relation: { schema: 'main', table: 'w_id' }, presence: 'mandatory', columns: [colMap('id', 'val')] },
					{ relationId: 'w_name', relation: { schema: 'main', table: 'w_name' }, presence: 'mandatory', columns: [colMap('name', 'val')] },
				],
				// Surrogate key, spelled IDENTICALLY (`rowId`) across members — the headline repro.
				sharedKey: { kind: 'surrogate', keyColumnsByRelation: keyMap(['w_id', ['rowId']], ['w_name', ['rowId']]) },
			},
		};
	}

	// Seed three logical rows {1:'a', 2:'b', 3:'c'}; the anchor `w_id` carries the
	// high-water-mark surrogate allocator default (the per-column INSERT value source).
	async function setupPerColumn(db: Database, extraLogical = ''): Promise<void> {
		const mod = new AdvertisingModule();
		mod.ads = [perColumnAd()];
		db.registerModule('widgetmod', mod);
		await db.exec('create table w_id (rowId integer primary key default (coalesce((select max(rowId) from w_id), 0) + mutation_ordinal()), val integer) using widgetmod');
		await db.exec('create table w_name (rowId integer primary key, val text) using widgetmod');
		await db.exec(`declare logical schema x { table W { id integer primary key, name text${extraLogical} } }`);
		await db.exec('apply schema x');
		await db.exec('insert into main.w_id (rowId, val) values (1, 1), (2, 2), (3, 3)');
		await db.exec("insert into main.w_name (rowId, val) values (1, 'a'), (2, 'b'), (3, 'c')");
	}

	it('a non-key UPDATE (set name) commits and round-trips — no "No row context" throw, no lost update', async () => {
		const db = new Database();
		try {
			await setupPerColumn(db);
			// The repro: `set name='B'` fans out to the w_name op alone. Pre-fix the lens:pk CHECK
			// (NEW.val on w_id) mis-routed onto it (w_name also has `val`) and threw at commit.
			await db.exec("update x.W set name = 'B' where id = 2");
			// The basis member persisted the write...
			expect(await rows(db, 'select val from main.w_name order by val')).to.deep.equal([{ val: 'B' }, { val: 'a' }, { val: 'c' }]);
			// ...and it round-trips through the lens view (no lost update).
			expect(await rows(db, 'select id, name from x.W order by id')).to.deep.equal([
				{ id: 1, name: 'a' }, { id: 2, name: 'B' }, { id: 3, name: 'c' },
			]);
		} finally {
			await db.close();
		}
	});

	it('a non-key UPDATE commits through an explicit transaction (begin; update; commit)', async () => {
		const db = new Database();
		try {
			await setupPerColumn(db);
			await db.exec('begin');
			await db.exec("update x.W set name = 'B' where id = 2");
			await db.exec('commit');
			expect(await rows(db, 'select id, name from x.W order by id')).to.deep.equal([
				{ id: 1, name: 'a' }, { id: 2, name: 'B' }, { id: 3, name: 'c' },
			]);
		} finally {
			await db.close();
		}
	});

	it('a unique key-changing UPDATE (set id) commits — the CHECK rides the w_id op and passes', async () => {
		const db = new Database();
		try {
			await setupPerColumn(db);
			// `set id=22` writes w_id.val; the lens:pk CHECK rides the w_id op (relation match) and
			// sees count 1 ⇒ passes. (Pre-fix this op-routing already worked — the key arm was never
			// the bug; pinned here so the fix does not over-correct and drop a needed enforcement.)
			await db.exec('update x.W set id = 22 where id = 2');
			expect(await rows(db, 'select val from main.w_id order by val')).to.deep.equal([{ val: 1 }, { val: 3 }, { val: 22 }]);
			expect(await rows(db, 'select id, name from x.W order by id')).to.deep.equal([
				{ id: 1, name: 'a' }, { id: 3, name: 'c' }, { id: 22, name: 'b' },
			]);
		} finally {
			await db.close();
		}
	});

	it('a duplicate key-changing UPDATE (set id to an existing id) ABORTs at commit (lens:pk)', async () => {
		const db = new Database();
		try {
			await setupPerColumn(db);
			// `set id=1 where id=2` makes two logical rows with id=1 ⇒ the deferred count CHECK sees
			// count 2 ⇒ ABORT. The CHECK genuinely fires on the key-owning w_id op.
			await expectThrows(() => db.exec('update x.W set id = 1 where id = 2'), /lens:pk|primary|unique|constraint/i);
			// Rolled back atomically: id 2 survives, no duplicate landed.
			expect(await rows(db, 'select id, name from x.W order by id')).to.deep.equal([
				{ id: 1, name: 'a' }, { id: 2, name: 'b' }, { id: 3, name: 'c' },
			]);
		} finally {
			await db.close();
		}
	});

	it('DELETE by key reaches both members (unaffected by the gate fix)', async () => {
		const db = new Database();
		try {
			await setupPerColumn(db);
			await db.exec('delete from x.W where id = 3');
			expect(await rows(db, 'select val from main.w_id order by val')).to.deep.equal([{ val: 1 }, { val: 2 }]);
			expect(await rows(db, 'select val from main.w_name order by val')).to.deep.equal([{ val: 'a' }, { val: 'b' }]);
			expect(await rows(db, 'select id, name from x.W order by id')).to.deep.equal([
				{ id: 1, name: 'a' }, { id: 2, name: 'b' },
			]);
		} finally {
			await db.close();
		}
	});

	it('INSERT fans out across both members; the commit-time key still ABORTs a duplicate', async () => {
		const db = new Database();
		try {
			await setupPerColumn(db);
			// A fresh logical row inserts across both members off the shared-surrogate envelope.
			await db.exec("insert into x.W (id, name) values (4, 'd')");
			expect(await rows(db, 'select id, name from x.W order by id')).to.deep.equal([
				{ id: 1, name: 'a' }, { id: 2, name: 'b' }, { id: 3, name: 'c' }, { id: 4, name: 'd' },
			]);
			// Inserting a duplicate logical id (1 already exists) ABORTs at commit (count ≥ 2): the
			// lens:pk CHECK rides the w_id anchor insert op (relation match), not the colliding w_name.
			await expectThrows(() => db.exec("insert into x.W (id, name) values (1, 'z')"), /lens:pk|primary|unique|constraint/i);
			// Atomic: no duplicate id=1 row landed in either member.
			expect(await rows(db, 'select count(*) as n from main.w_id where val = 1')).to.deep.equal([{ n: 1 }]);
			expect(await rows(db, "select count(*) as n from main.w_name where val = 'z'")).to.deep.equal([{ n: 0 }]);
		} finally {
			await db.close();
		}
	});

	it('a single-member row-local CHECK rides only its owning member (general gate, not just set-level)', async () => {
		const db = new Database();
		try {
			// `length(name) < 5` references logical `name` → basis `w_name.val`. The colliding sibling
			// `w_id` ALSO has a `val` column (backing id), but relation identity keeps the CHECK off
			// the w_id op. A too-long name ABORTs on the w_name op; a key-only UPDATE (set id) fans out
			// to w_id alone and must NOT carry the name CHECK (no spurious enforcement, no mis-route).
			await setupPerColumn(db, ', constraint namelen check (length(name) < 5)');
			await expectThrows(() => db.exec("update x.W set name = 'toolong' where id = 2"), /check|constraint|namelen/i);
			expect(await rows(db, 'select val from main.w_name order by val')).to.deep.equal([{ val: 'a' }, { val: 'b' }, { val: 'c' }]); // rolled back
			// A valid name update commits (rides w_name, passes).
			await db.exec("update x.W set name = 'ok' where id = 2");
			expect(await rows(db, 'select name from x.W where id = 2')).to.deep.equal([{ name: 'ok' }]);
			// A key-only UPDATE fans out to w_id alone — the name CHECK is not routed there, so it
			// commits cleanly (pre-fix the bare-name gate would have mis-routed it onto w_id's `val`).
			await db.exec('update x.W set id = 22 where id = 2');
			expect(await rows(db, 'select id, name from x.W order by id')).to.deep.equal([
				{ id: 1, name: 'a' }, { id: 3, name: 'c' }, { id: 22, name: 'ok' },
			]);
		} finally {
			await db.close();
		}
	});

	it('a cross-member row-local CHECK rewrites to relation-distinct write-row terms (no NEW.val collapse)', async () => {
		const db = new Database();
		try {
			// `id <> length(name)` references BOTH logical columns: `id` → basis `w_id.val`,
			// `name` → basis `w_name.val`. They share the bare basis NAME `val`, so a bare
			// `NEW`-qualified rewrite would collapse both write-row terms to a single `NEW.val`
			// — silently confusing the two members (the `name` ref becoming `w_id`'s `val`). The
			// relation-qualified rewrite keeps them distinct, each carrying its owning member's
			// synthetic write-row correlation. (This CHECK spans two members ⇒ the per-op gate
			// defers it on a decomposition write, so the rewrite is never evaluated today — this
			// unit asserts it would be CORRECT, not collapsed, if a future change ever routed it.)
			await setupPerColumn(db, ', constraint xmember check (id <> length(name))');
			const constraints = collectLensRowLocalConstraints(makeCtx(db), slotX(db, 'W'));
			expect(constraints.length, 'one routed row-local check').to.equal(1);
			const exprSql = astToString(constraints[0].expr).toLowerCase();
			// The two write-row terms are relation-qualified and DISTINCT — the `id` term on the
			// w_id member, the `name` term on the w_name member — not both collapsed to `new.val`.
			expect(exprSql, 'id term carries the w_id member correlation').to.contain('__lens_new__main__w_id.val');
			expect(exprSql, 'name term carries the w_name member correlation').to.contain('__lens_new__main__w_name.val');
			expect(exprSql, 'not collapsed onto the bare NEW write-row correlation').to.not.contain('new.val');
		} finally {
			await db.close();
		}
	});
});
