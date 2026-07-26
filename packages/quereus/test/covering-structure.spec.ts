/**
 * Covering structures — coverage prover + constraint↔structure linkage +
 * introspection hiding (ticket `covering-structure-unique-enforcement`).
 *
 * The implicit-reframe regression floor (observation-equivalence of UNIQUE
 * enforcement) is guarded by the existing UNIQUE suites in test/logic/ and
 * quereus-store; this file owns the new analysis + bookkeeping surface.
 */

import { expect } from 'chai';
import { Database } from '../src/core/database.js';
import { collectSchemaCatalog } from '../src/schema/catalog.js';
import { computeSchemaDiff, generateMigrationDDL } from '../src/schema/schema-differ.js';
import { proveCoverage, proveEffectiveKeyUnique, type CoverageResult } from '../src/planner/analysis/coverage-prover.js';
import type { FunctionalDependency, PhysicalProperties, RelationalPlanNode } from '../src/planner/nodes/plan-node.js';
import type { ColRef, RelationType } from '../src/common/datatype.js';
import type { MaintainedTableSchema } from '../src/schema/derivation.js';
import { parseSelect } from '../src/parser/index.js';
import type * as AST from '../src/parser/ast.js';
import { INTEGER_TYPE } from '../src/types/builtin-types.js';
import type { ChangeScope, WatchEvent, DatabaseDataChangeEvent } from '../src/index.js';

async function freshDb(ddl: string[]): Promise<Database> {
	const db = new Database();
	for (const stmt of ddl) await db.exec(stmt);
	return db;
}

function bodyRoot(db: Database, bodySql: string): RelationalPlanNode {
	// The coverage prover analyzes the MV body over its SOURCE table. Suppress the
	// read-side query-rewrite rule (as the production caller
	// `linkCoveredUniqueConstraints` does) so a body matching a registered MV is not
	// re-pointed at that MV's backing before the prover sees it.
	const root = db.schemaManager.withSuppressedMaterializedViewRewrite(
		() => db.getPlan(bodySql).getRelations()[0],
	);
	expect(root, 'body produced a relation').to.not.be.undefined;
	return root as RelationalPlanNode;
}

/**
 * Runs the prover directly against the named UNIQUE constraint on the named base
 * table so per-reason outcomes are observable. Prefers the registered MV, falling
 * back to a parsed-body stub when the body is row-time-ineligible (joins, LIMIT, …)
 * and thus cannot back a real MV — the prover reads only `mv.derivation.selectAst`,
 * so the stub is faithful (cf. {@link proveUnmaterialized}).
 */
async function prove(
	db: Database,
	mvName: string,
	bodySql: string,
	tableName: string,
	ucIndex = 0,
): Promise<CoverageResult> {
	const mv = db.schemaManager.getMaintainedTable('main', mvName)
		?? ({ name: mvName, schemaName: 'main', derivation: { selectAst: parseSelect(bodySql) } } as unknown as MaintainedTableSchema);
	const table = db.schemaManager.getTable('main', tableName)!;
	const uc = table.uniqueConstraints![ucIndex];
	return proveCoverage(bodyRoot(db, bodySql), mv, uc, table);
}

/**
 * Runs the prover against a body that is *planned but not materialized*. The MV
 * materialization path (`collectBodyRows`) is out of scope here — `proveCoverage`
 * reads only `mv.derivation.selectAst`, so a stub carrying the parsed body suffices to
 * exercise the prover's `'right'`-join branch end to end in isolation. (RIGHT
 * JOIN itself now executes at runtime; this helper just keeps the coverage unit
 * test focused on the prover rather than on materialization.)
 */
function proveUnmaterialized(
	db: Database,
	bodySql: string,
	tableName: string,
	ucIndex = 0,
): CoverageResult {
	const table = db.schemaManager.getTable('main', tableName)!;
	const uc = table.uniqueConstraints![ucIndex];
	const mvStub = { name: 'ix', schemaName: 'main', derivation: { selectAst: parseSelect(bodySql) } } as unknown as MaintainedTableSchema;
	return proveCoverage(bodyRoot(db, bodySql), mvStub, uc, table);
}

describe('coverage prover — positive', () => {
	it('select uc-cols + pk ordered by uc-cols covers a composite UNIQUE', async () => {
		const db = await freshDb([
			'create table t (id integer primary key, x integer not null, y integer not null, unique (x, y))',
			'create materialized view ix as select x, y, id from t order by x, y',
		]);
		try {
			expect((await prove(db, 'ix', 'select x, y, id from t order by x, y', 't')).covers).to.be.true;
		} finally {
			await db.close();
		}
	});

	it('covers regardless of ORDER BY permutation of the uc columns', async () => {
		const db = await freshDb([
			'create table t (id integer primary key, x integer not null, y integer not null, unique (x, y))',
			'create materialized view ix as select x, y, id from t order by y, x',
		]);
		try {
			expect((await prove(db, 'ix', 'select x, y, id from t order by y, x', 't')).covers).to.be.true;
		} finally {
			await db.close();
		}
	});

	it('covers a nullable single-column UNIQUE when the body skips NULLs', async () => {
		const db = await freshDb([
			'create table t (id integer primary key, x integer null, unique (x))',
			'create materialized view ix as select x, id from t where x is not null order by x',
		]);
		try {
			expect((await prove(db, 'ix', 'select x, id from t where x is not null order by x', 't')).covers).to.be.true;
		} finally {
			await db.close();
		}
	});
});

describe('coverage prover — negative (one per reason)', () => {
	async function expectReason(
		ddl: string[],
		mvName: string,
		bodySql: string,
		tableName: string,
		reason: string,
	): Promise<void> {
		// Prove against the planned body (create-MV lines stripped): several of these
		// shapes are row-time-ineligible, so no real MV is created — `prove` falls back
		// to a parsed-body stub. The prover reads only the body, so results are identical.
		const db = await freshDb(ddl.filter(s => !/create\s+materialized\s+view/i.test(s)));
		try {
			const result = await prove(db, mvName, bodySql, tableName);
			expect(result.covers, `expected NotCovers(${reason})`).to.be.false;
			if (!result.covers) expect(result.reason).to.equal(reason);
		} finally {
			await db.close();
		}
	}

	it('missing-uc-column', async () => {
		await expectReason(
			[
				'create table t (id integer primary key, x integer not null, y integer not null, unique (x, y))',
				'create materialized view ix as select x, id from t order by x',
			],
			'ix', 'select x, id from t order by x', 't', 'missing-uc-column',
		);
	});

	it('missing-pk-column', async () => {
		await expectReason(
			[
				'create table t (id integer primary key, x integer not null, y integer not null, unique (x, y))',
				'create materialized view ix as select x, y from t order by x, y',
			],
			'ix', 'select x, y from t order by x, y', 't', 'missing-pk-column',
		);
	});

	it('ordering-mismatch (no ORDER BY)', async () => {
		await expectReason(
			[
				'create table t (id integer primary key, x integer not null, y integer not null, unique (x, y))',
				'create materialized view ix as select x, y, id from t',
			],
			'ix', 'select x, y, id from t', 't', 'ordering-mismatch',
		);
	});

	it('ordering-mismatch (partial ordering)', async () => {
		await expectReason(
			[
				'create table t (id integer primary key, x integer not null, y integer not null, unique (x, y))',
				'create materialized view ix as select x, y, id from t order by x',
			],
			'ix', 'select x, y, id from t order by x', 't', 'ordering-mismatch',
		);
	});

	it('predicate-entailment (body scope wider than partial-UNIQUE scope)', async () => {
		await expectReason(
			[
				'create table t (id integer primary key, x integer not null, y integer not null)',
				'create unique index uq on t (x, y) where x > 5',
				'create materialized view ix as select x, y, id from t where x > 0 order by x, y',
			],
			'ix', 'select x, y, id from t where x > 0 order by x, y', 't', 'predicate-entailment',
		);
	});

	it('predicate-entailment (full UNIQUE but body restricts rows)', async () => {
		await expectReason(
			[
				'create table t (id integer primary key, x integer not null, y integer not null, unique (x, y))',
				'create materialized view ix as select x, y, id from t where x > 0 order by x, y',
			],
			'ix', 'select x, y, id from t where x > 0 order by x, y', 't', 'predicate-entailment',
		);
	});

	it('missing-null-skip (nullable uc column, no NULL filter)', async () => {
		await expectReason(
			[
				'create table t (id integer primary key, x integer null, unique (x))',
				'create materialized view ix as select x, id from t order by x',
			],
			'ix', 'select x, id from t order by x', 't', 'missing-null-skip',
		);
	});

	it('shape (join body is not a single-table chain)', async () => {
		await expectReason(
			[
				'create table t (id integer primary key, x integer not null, y integer not null, unique (x, y))',
				'create table u (uid integer primary key, x integer not null)',
				'create materialized view ix as select t.x, t.y, t.id from t join u on t.x = u.x order by t.x, t.y',
			],
			'ix', 'select t.x, t.y, t.id from t join u on t.x = u.x order by t.x, t.y', 't', 'shape',
		);
	});

	it('shape (LIMIT materializes only a prefix — never covers)', async () => {
		await expectReason(
			[
				'create table t (id integer primary key, x integer not null, y integer not null, unique (x, y))',
				'create materialized view ix as select x, y, id from t order by x, y limit 100',
			],
			'ix', 'select x, y, id from t order by x, y limit 100', 't', 'shape',
		);
	});

	it('shape (OFFSET drops governed rows — never covers)', async () => {
		await expectReason(
			[
				'create table t (id integer primary key, x integer not null, y integer not null, unique (x, y))',
				'create materialized view ix as select x, y, id from t order by x, y limit 100 offset 10',
			],
			'ix', 'select x, y, id from t order by x, y limit 100 offset 10', 't', 'shape',
		);
	});
});

describe('eager prove-and-link', () => {
	it('populates coveringStructureName + covers on create, clears on drop', async () => {
		const db = await freshDb([
			'create table t (id integer primary key, x integer not null, y integer not null, unique (x, y))',
			'create materialized view ix_t_xy as select x, y, id from t order by x, y',
		]);
		try {
			const uc = () => db.schemaManager.getTable('main', 't')!.uniqueConstraints![0];
			expect(uc().coveringStructureName, 'forward pointer set').to.equal('ix_t_xy');

			const mv = db.schemaManager.getMaintainedTable('main', 'ix_t_xy')!;
			expect(mv.derivation.covers).to.deep.include({ schemaName: 'main', tableName: 't' });

			await db.exec('drop materialized view ix_t_xy');
			expect(uc().coveringStructureName, 'forward pointer cleared on drop').to.be.undefined;
		} finally {
			await db.close();
		}
	});

	it('does NOT link a non-covering MV', async () => {
		const db = await freshDb([
			'create table t (id integer primary key, x integer not null, y integer not null, unique (x, y))',
			// No ORDER BY ⇒ not a covering structure.
			'create materialized view ix as select x, y, id from t',
		]);
		try {
			expect(db.schemaManager.getTable('main', 't')!.uniqueConstraints![0].coveringStructureName).to.be.undefined;
			expect(db.schemaManager.getMaintainedTable('main', 'ix')!.derivation.covers).to.be.undefined;
		} finally {
			await db.close();
		}
	});
});

/**
 * Multi-source (join) bodies — the prover admits a join body as covering a
 * single-table UNIQUE constraint when `T` provably contributes exactly one MV
 * row per governed `T` row (no row loss + no fan-out). See the coverage-prover
 * module doc § "The 1:1 join decomposition".
 *
 * NOTE on join survival: none of these DDLs declare a foreign key, so
 * `rule-join-elimination` (which needs FK→PK alignment) never fires and the join
 * survives to the optimized plan — exercising the new multi-source walk rather
 * than collapsing to the v1 single-source path.
 */
describe('coverage prover — multi-source (join) bodies', () => {
	// orders(unique(customer_id, sku)) left-joined to a unique lookup key: 1:1.
	const ORDERS_CUSTOMERS = [
		'create table orders (id integer primary key, customer_id integer not null, sku text not null, unique (customer_id, sku))',
		'create table customers (id integer primary key, name text)',
	];

	it('positive: LEFT join to a unique lookup key (T on the preserving left side) covers', async () => {
		const body = 'select o.customer_id, o.sku, o.id from orders o left join customers c on o.customer_id = c.id order by o.customer_id, o.sku';
		const db = await freshDb([...ORDERS_CUSTOMERS]);
		try {
			expect((await prove(db, 'ix', body, 'orders')).covers, 'left-join to unique lookup is 1:1').to.be.true;
		} finally {
			await db.close();
		}
	});

	it('positive: RIGHT join with the lookup on the left (T on the preserving right side) covers', async () => {
		// Prove against the planned body directly (the prover's `'right'`-join branch),
		// keeping this unit test focused on coverage rather than MV materialization.
		const body = 'select o.customer_id, o.sku, o.id from customers c right join orders o on o.customer_id = c.id order by o.customer_id, o.sku';
		const db = await freshDb(ORDERS_CUSTOMERS);
		try {
			expect(proveUnmaterialized(db, body, 'orders').covers, 'symmetric right-join case').to.be.true;
		} finally {
			await db.close();
		}
	});

	it('negative fanout: LEFT join on a NON-unique lookup key multiplies T rows', async () => {
		// tags.val is not unique (PK is on a different column) ⇒ one orders row can
		// match many tags rows ⇒ the join fans out.
		const body = 'select o.customer_id, o.sku, o.id from orders o left join tags t on o.customer_id = t.val order by o.customer_id, o.sku';
		const db = await freshDb([
			'create table orders (id integer primary key, customer_id integer not null, sku text not null, unique (customer_id, sku))',
			'create table tags (id integer primary key, val integer not null, label text)',
		]);
		try {
			const result = await prove(db, 'ix', body, 'orders');
			expect(result.covers, 'a fanning lookup join must not cover').to.be.false;
			if (!result.covers) expect(result.reason).to.equal('fanout');
		} finally {
			await db.close();
		}
	});

	it('negative shape: the same body as an INNER join loses unmatched T rows', async () => {
		const body = 'select o.customer_id, o.sku, o.id from orders o inner join customers c on o.customer_id = c.id order by o.customer_id, o.sku';
		const db = await freshDb([...ORDERS_CUSTOMERS]);
		try {
			const result = await prove(db, 'ix', body, 'orders');
			expect(result.covers, 'inner join cannot prove no-row-loss').to.be.false;
			if (!result.covers) expect(result.reason).to.equal('shape');
		} finally {
			await db.close();
		}
	});

	it('negative shape: T on the dropping side of an outer join', async () => {
		// customers LEFT JOIN orders preserves customers; orders rows with no
		// matching customer are dropped ⇒ row loss for orders.
		const body = 'select o.customer_id, o.sku, o.id from customers c left join orders o on o.customer_id = c.id order by o.customer_id, o.sku';
		const db = await freshDb([...ORDERS_CUSTOMERS]);
		try {
			const result = await prove(db, 'ix', body, 'orders');
			expect(result.covers, 'T on the non-preserving side cannot cover').to.be.false;
			if (!result.covers) expect(result.reason).to.equal('shape');
		} finally {
			await db.close();
		}
	});

	it('negative shape: self-join of T to T is ambiguous', async () => {
		const body = 'select o1.customer_id, o1.sku, o1.id from orders o1 join orders o2 on o1.id = o2.id order by o1.customer_id, o1.sku';
		const db = await freshDb([
			'create table orders (id integer primary key, customer_id integer not null, sku text not null, unique (customer_id, sku))',
		]);
		try {
			const result = await prove(db, 'ix', body, 'orders');
			expect(result.covers, 'self-join puts T on both sides ⇒ ambiguous').to.be.false;
			if (!result.covers) expect(result.reason).to.equal('shape');
		} finally {
			await db.close();
		}
	});

	it('negative: WHERE referencing a lookup column cannot sneak through', async () => {
		const body = 'select o.customer_id, o.sku, o.id from orders o left join customers c on o.customer_id = c.id where c.name is not null order by o.customer_id, o.sku';
		const db = await freshDb([...ORDERS_CUSTOMERS]);
		try {
			const result = await prove(db, 'ix', body, 'orders');
			expect(result.covers, 'a non-T filter must not be accepted').to.be.false;
			// Either the optimizer null-rejected the LEFT join into an INNER join
			// (rejected by the structural side/type gate ⇒ 'shape') or it survived as
			// a LEFT join and the AST WHERE (on a non-T column) failed predicate
			// alignment ⇒ 'predicate-entailment'. Both are sound rejections.
			if (!result.covers) expect(['shape', 'predicate-entailment']).to.include(result.reason);
		} finally {
			await db.close();
		}
	});

	it('create-time gate: a 1:1 join body is now ACCEPTED (floor-maintained) but the deferred MV is NOT an enforcing covering structure', async () => {
		// The prover admits this join body as covering (the prove() tests above). Under the
		// cost-gated-with-floor model (ticket `mv-eligibility-floor-fallthrough`) no body is
		// rejected for its shape: this 1:1 outer join is ACCEPTED and maintained by the
		// full-rebuild floor (cf. 53-materialized-views-rowtime.sqllogic § 7, ok_join_outer).
		const body = 'select o.customer_id, o.sku, o.id from orders o left join customers c on o.customer_id = c.id order by o.customer_id, o.sku';
		const db = await freshDb(ORDERS_CUSTOMERS);
		try {
			await db.exec(`create materialized view ix as ${body}`); // accepted, no throw
			expect(db.schemaManager.getMaintainedTable('main', 'ix'), 'MV registered (no shape reject)').to.not.be.undefined;
			// Soundness: a full-rebuild MV's backing is reconciled only at the end-of-statement
			// flush, so it lags the source mid-statement and can NEVER answer a synchronous
			// per-row UNIQUE probe. Enforcement must not resolve it as a covering structure —
			// it falls back to the auto-index. (Guards the flip against stale-read enforcement;
			// see findRowTimeCoveringStructure's full-rebuild skip.)
			const uc = db.schemaManager.getTable('main', 'orders')!.uniqueConstraints![0];
			expect(db._findRowTimeCoveringStructure('main', 'orders', uc),
				'a deferred full-rebuild MV is not an enforcing covering structure').to.be.undefined;
		} finally {
			await db.close();
		}
	});

	// --- Nested joins: the topmost-join capture + per-join structural gate +
	//     composed join-frame FDs must hold for a chain of joins, not just one. ---

	it('positive: nested LEFT joins, both 1:1, cover', async () => {
		const body = 'select o.customer_id, o.sku, o.id from orders o left join customers c on o.customer_id = c.id left join addresses a on o.id = a.id order by o.customer_id, o.sku';
		const db = await freshDb([
			...ORDERS_CUSTOMERS,
			'create table addresses (id integer primary key, city text)',
		]);
		try {
			expect((await prove(db, 'ix', body, 'orders')).covers, 'a 1:1 chain of LEFT joins is still 1:1').to.be.true;
		} finally {
			await db.close();
		}
	});

	it('negative fanout: nested LEFT joins where the OUTER join fans out (deeper-than-top fan-out is caught at the join frame)', async () => {
		// orders LJ customers is 1:1, but the outer LJ tags (tags.val non-unique)
		// fans out. The fan-out gate checks isUnique(orders.pk) at the *topmost*
		// join frame, whose FDs do not let orders.pk reach the tags columns ⇒ fanout.
		const body = 'select o.customer_id, o.sku, o.id from orders o left join customers c on o.customer_id = c.id left join tags t on o.customer_id = t.val order by o.customer_id, o.sku';
		const db = await freshDb([
			...ORDERS_CUSTOMERS,
			'create table tags (id integer primary key, val integer not null, label text)',
		]);
		try {
			const result = await prove(db, 'ix', body, 'orders');
			expect(result.covers, 'a fan-out below the top join must still be caught').to.be.false;
			if (!result.covers) expect(result.reason).to.equal('fanout');
		} finally {
			await db.close();
		}
	});

	it('positive: a composite-PK table maps every PK attribute into the join frame', async () => {
		// line_items has a 2-column PK (oid, lineno); the covered UC is (oid, sku).
		// The fan-out gate must map BOTH pk attributes into the join frame for the
		// isUnique check, not just the first. The lookup is on region_id (a non-UC,
		// non-PK column) to a unique key, with no lookup-side name colliding with a
		// UC column — so the qualifier-aware resolver maps the ORDER BY cleanly to T.
		const body = 'select l.oid, l.sku, l.lineno from line_items l left join regions r on l.region_id = r.rid order by l.oid, l.sku';
		const db = await freshDb([
			'create table line_items (oid integer not null, lineno integer not null, sku text not null, region_id integer not null, primary key (oid, lineno), unique (oid, sku))',
			'create table regions (rid integer primary key, rname text)',
		]);
		try {
			expect((await prove(db, 'ix', body, 'line_items')).covers, 'composite-PK 1:1 lookup join covers').to.be.true;
		} finally {
			await db.close();
		}
	});

	// products.sku reuses the UC column name `sku`, but the prover's ORDER BY /
	// WHERE resolution is now qualifier-aware, so `l.sku` (T) and `p.sku` (lookup)
	// are kept distinct — no bare-name collision guard. The natural-key 1:1 lookup
	// join therefore covers.
	const LINE_ITEMS_PRODUCTS = [
		'create table line_items (oid integer not null, lineno integer not null, sku text not null, primary key (oid, lineno), unique (oid, sku))',
		'create table products (sku text primary key, name text)',
	];

	it('positive: a 1:1 join whose lookup key reuses a UC column name, sorted by the T-qualified column, covers', async () => {
		const body = 'select l.oid, l.sku, l.lineno from line_items l left join products p on l.sku = p.sku order by l.oid, l.sku';
		const db = await freshDb([...LINE_ITEMS_PRODUCTS]);
		try {
			expect((await prove(db, 'ix', body, 'line_items')).covers, 'a UC-named lookup key qualified to T still covers').to.be.true;
		} finally {
			await db.close();
		}
	});

	it('negative ordering-mismatch: the SAME UC-shared name qualified to the LOOKUP side is not a T ordering', async () => {
		// `order by l.oid, p.sku` sorts by the lookup-side `sku`, not T's — so it is
		// an ordering-mismatch, NOT a `shape` rejection (the old collision guard).
		const body = 'select l.oid, l.sku, l.lineno from line_items l left join products p on l.sku = p.sku order by l.oid, p.sku';
		const db = await freshDb([...LINE_ITEMS_PRODUCTS]);
		try {
			const result = await prove(db, 'ix', body, 'line_items');
			expect(result.covers, 'ordering on a lookup column cannot cover').to.be.false;
			if (!result.covers) expect(result.reason).to.equal('ordering-mismatch');
		} finally {
			await db.close();
		}
	});

	it('negative predicate-entailment: a WHERE on the UC-shared name qualified to the LOOKUP side is rejected for the right reason', async () => {
		// `where p.sku is null` filters on the lookup-side `sku` (the anti-join
		// pattern keeps the LEFT join), so it is a predicate-entailment failure —
		// NOT `shape` as the bare-name collision guard would have reported.
		const body = 'select l.oid, l.sku, l.lineno from line_items l left join products p on l.sku = p.sku where p.sku is null order by l.oid, l.sku';
		const db = await freshDb([...LINE_ITEMS_PRODUCTS]);
		try {
			const result = await prove(db, 'ix', body, 'line_items');
			expect(result.covers, 'a lookup-side WHERE cannot cover').to.be.false;
			if (!result.covers) expect(result.reason).to.equal('predicate-entailment');
		} finally {
			await db.close();
		}
	});

	// --- INNER / CROSS-equi joins admitted via enforced referential integrity:
	//     a NOT-NULL FK from T to the lookup PK makes the inner join 1:1, so no
	//     governed T row is dropped. The lookup column is projected in every
	//     positive case so `rule-join-elimination` does NOT collapse the join to
	//     the v1 single-source path — the inner-join multi-source walk is what is
	//     under test (confirmed: the body keeps a surviving HashJoin). ---

	it('positive: INNER join on a NOT-NULL FK to the lookup PK covers (RI ⇒ no row loss)', async () => {
		const body = 'select o.customer_id, o.sku, o.id, c.name from orders o inner join customers c on o.customer_id = c.id order by o.customer_id, o.sku';
		const db = await freshDb([
			'create table customers (id integer primary key, name text)',
			'create table orders (id integer primary key, customer_id integer not null, sku text not null, unique (customer_id, sku), foreign key (customer_id) references customers(id))',
		]);
		try {
			expect((await prove(db, 'ix', body, 'orders')).covers, 'NOT-NULL FK inner join is 1:1').to.be.true;
		} finally {
			await db.close();
		}
	});

	it('positive: INNER join on a composite NOT-NULL FK covers', async () => {
		const body = 'select c.pa, c.pb, c.sku, c.id, p.label from child c inner join parent p on c.pa = p.a and c.pb = p.b order by c.pa, c.pb, c.sku';
		const db = await freshDb([
			'create table parent (a integer not null, b integer not null, label text, primary key (a, b))',
			'create table child (id integer primary key, pa integer not null, pb integer not null, sku text not null, unique (pa, pb, sku), foreign key (pa, pb) references parent(a, b))',
		]);
		try {
			expect((await prove(db, 'ix', body, 'child')).covers, 'composite NOT-NULL FK inner join is 1:1').to.be.true;
		} finally {
			await db.close();
		}
	});

	it('negative shape: INNER join on a NULLABLE FK can drop T rows (NULL FK has no parent)', async () => {
		// region_id is explicitly `null` (Quereus columns are NOT NULL by default —
		// Third Manifesto), so orders rows with NULL region_id match no customer and
		// are dropped by the inner join ⇒ row loss ⇒ must not cover. The UC
		// (customer_id, sku) is NOT NULL so predicate alignment is satisfied; the
		// rejection is purely the no-row-loss gate.
		const body = 'select o.customer_id, o.sku, o.id, c.name from orders o inner join customers c on o.region_id = c.id order by o.customer_id, o.sku';
		const db = await freshDb([
			'create table customers (id integer primary key, name text)',
			'create table orders (id integer primary key, customer_id integer not null, sku text not null, region_id integer null, unique (customer_id, sku), foreign key (region_id) references customers(id))',
		]);
		try {
			const result = await prove(db, 'ix', body, 'orders');
			expect(result.covers, 'a nullable FK cannot prove no-row-loss').to.be.false;
			if (!result.covers) expect(result.reason).to.equal('shape');
		} finally {
			await db.close();
		}
	});

	it('negative shape: INNER join on a non-FK UNIQUE lookup key carries no inclusion guarantee', async () => {
		// c.code is UNIQUE (no fan-out) but there is NO foreign key from orders, so
		// an orders.customer_id with no matching c.code is dropped ⇒ row loss.
		const body = 'select o.customer_id, o.sku, o.id, c.name from orders o inner join customers c on o.customer_id = c.code order by o.customer_id, o.sku';
		const db = await freshDb([
			'create table customers (id integer primary key, code integer not null unique, name text)',
			'create table orders (id integer primary key, customer_id integer not null, sku text not null, unique (customer_id, sku))',
		]);
		try {
			const result = await prove(db, 'ix', body, 'orders');
			expect(result.covers, 'a non-FK equi-join to a unique key cannot prove no-row-loss').to.be.false;
			if (!result.covers) expect(result.reason).to.equal('shape');
		} finally {
			await db.close();
		}
	});

	it('negative shape: INNER join whose ON clause adds a same-side equality filter does not cover', async () => {
		// `c.grp1 = c.grp2` is a single-relation filter on the lookup side: orders
		// rows whose matched customer has grp1 != grp2 are dropped ⇒ row loss. It
		// passes the pure-column-equi shape but produces no cross-side equi-pair, so
		// the FK-alignment proof must reject it (whether the optimizer pushes it
		// below the join as a Filter or leaves it on the logical JoinNode).
		const body = 'select o.customer_id, o.sku, o.id, c.name from orders o inner join customers c on o.customer_id = c.id and c.grp1 = c.grp2 order by o.customer_id, o.sku';
		const db = await freshDb([
			'create table customers (id integer primary key, grp1 integer not null, grp2 integer not null, name text)',
			'create table orders (id integer primary key, customer_id integer not null, sku text not null, unique (customer_id, sku), foreign key (customer_id) references customers(id))',
		]);
		try {
			const result = await prove(db, 'ix', body, 'orders');
			expect(result.covers, 'a same-side equality filter in the ON clause drops T rows').to.be.false;
			if (!result.covers) expect(result.reason).to.equal('shape');
		} finally {
			await db.close();
		}
	});

});

/**
 * IND-derived no-row-loss (Wave 2, `coverage-prover-ind-derived-no-row-loss`).
 * The inner/cross no-row-loss obligation now consults the propagated
 * `PhysicalProperties.inds` surface first (`indDerivedNoRowLoss`), falling back to
 * the structural NOT-NULL-FK check (`lookupCoveringFK`). This is a pure
 * strengthening: identical verdicts on every existing single-FK shape (both paths
 * agree — the equivalence suite), and it newly proves no-row-loss for multi-hop FK
 * chains (`T → M → P`) whose threaded IND a single `lookupCoveringFK` call cannot
 * see. The `structuralOnly` option on `proveCoverage` is a verification seam that
 * disables the IND path so the equivalence assertion can compare the two
 * derivations directly.
 */
describe('coverage prover — IND-derived no-row-loss (Wave 2)', () => {
	/** Proves a planned (unmaterialized) join body, optionally structural-only. */
	function proveBody(db: Database, body: string, tableName: string, structuralOnly = false): CoverageResult {
		const table = db.schemaManager.getTable('main', tableName)!;
		const uc = table.uniqueConstraints![0];
		const mvStub = { name: 'ix', schemaName: 'main', derivation: { selectAst: parseSelect(body) } } as unknown as MaintainedTableSchema;
		return proveCoverage(bodyRoot(db, body), mvStub, uc, table, { structuralOnly });
	}

	// --- Equivalence (the heart): on every existing NOT-NULL FK→PK single-hop
	//     shape, the IND-derived path and the structural-only path return identical
	//     verdicts, and both match the pre-Wave-2 golden. Because the only behavioral
	//     difference between the two derivations is `innerJoinRetainsConstrainedTable`,
	//     a deep-equal here is the structural guarantee they cannot disagree on the
	//     single-FK corpus. ---
	describe('equivalence with structural-only on the single-FK corpus', () => {
		interface Case { name: string; ddl: string[]; body: string; table: string; expected: CoverageResult; }
		const CASES: Case[] = [
			{
				name: 'single NOT-NULL FK inner join covers',
				ddl: [
					'create table customers (id integer primary key, name text)',
					'create table orders (id integer primary key, customer_id integer not null, sku text not null, unique (customer_id, sku), foreign key (customer_id) references customers(id))',
				],
				body: 'select o.customer_id, o.sku, o.id, c.name from orders o inner join customers c on o.customer_id = c.id order by o.customer_id, o.sku',
				table: 'orders',
				expected: { covers: true },
			},
			{
				name: 'composite NOT-NULL FK inner join covers',
				ddl: [
					'create table parent (a integer not null, b integer not null, label text, primary key (a, b))',
					'create table child (id integer primary key, pa integer not null, pb integer not null, sku text not null, unique (pa, pb, sku), foreign key (pa, pb) references parent(a, b))',
				],
				body: 'select c.pa, c.pb, c.sku, c.id, p.label from child c inner join parent p on c.pa = p.a and c.pb = p.b order by c.pa, c.pb, c.sku',
				table: 'child',
				expected: { covers: true },
			},
			{
				name: 'nullable FK ⇒ shape',
				ddl: [
					'create table customers (id integer primary key, name text)',
					'create table orders (id integer primary key, customer_id integer not null, sku text not null, region_id integer null, unique (customer_id, sku), foreign key (region_id) references customers(id))',
				],
				body: 'select o.customer_id, o.sku, o.id, c.name from orders o inner join customers c on o.region_id = c.id order by o.customer_id, o.sku',
				table: 'orders',
				expected: { covers: false, reason: 'shape' },
			},
			{
				// A composite FK `(pa, pb) → (a, b)` guarantees the *positional* pairing
				// `pa → a, pb → b` only; a permuted ON `c.pa = p.b AND c.pb = p.a` is NOT
				// covered by the FK (it would match a different parent row). The structural
				// path rejects this via `lookupCoveringFK`'s positional alignment; the IND
				// path must reject it too — its set-equality `{pa:a, pb:b}` ≠ `{pa:b, pb:a}`
				// — keeping the two derivations in lockstep on the permutation edge.
				name: 'permuted composite FK ⇒ shape',
				ddl: [
					'create table parent (a integer not null, b integer not null, label text, primary key (a, b))',
					'create table child (id integer primary key, pa integer not null, pb integer not null, sku text not null, unique (pa, pb, sku), foreign key (pa, pb) references parent(a, b))',
				],
				body: 'select c.pa, c.pb, c.sku, c.id, p.label from child c inner join parent p on c.pa = p.b and c.pb = p.a order by c.pa, c.pb, c.sku',
				table: 'child',
				expected: { covers: false, reason: 'shape' },
			},
			{
				name: 'non-FK unique lookup key ⇒ shape',
				ddl: [
					'create table customers (id integer primary key, code integer not null unique, name text)',
					'create table orders (id integer primary key, customer_id integer not null, sku text not null, unique (customer_id, sku))',
				],
				body: 'select o.customer_id, o.sku, o.id, c.name from orders o inner join customers c on o.customer_id = c.code order by o.customer_id, o.sku',
				table: 'orders',
				expected: { covers: false, reason: 'shape' },
			},
			{
				name: 'same-side equality filter in ON ⇒ shape',
				ddl: [
					'create table customers (id integer primary key, grp1 integer not null, grp2 integer not null, name text)',
					'create table orders (id integer primary key, customer_id integer not null, sku text not null, unique (customer_id, sku), foreign key (customer_id) references customers(id))',
				],
				body: 'select o.customer_id, o.sku, o.id, c.name from orders o inner join customers c on o.customer_id = c.id and c.grp1 = c.grp2 order by o.customer_id, o.sku',
				table: 'orders',
				expected: { covers: false, reason: 'shape' },
			},
		];

		for (const c of CASES) {
			it(`both paths agree: ${c.name}`, async () => {
				const db = await freshDb(c.ddl);
				try {
					const withInd = proveBody(db, c.body, c.table, false);
					const structuralOnly = proveBody(db, c.body, c.table, true);
					expect(withInd, 'IND path matches the pre-Wave-2 golden').to.deep.equal(c.expected);
					expect(structuralOnly, 'IND-derived and structural-only verdicts are identical').to.deep.equal(withInd);
				} finally {
					await db.close();
				}
			});
		}
	});

	// --- Two-hop strengthening: `cc → mm → pp`, both hops NOT-NULL FK→PK, all
	//     full-scan lookups. The outer `⋈ pp` join equates `mm.p_id = pp.pid`, an
	//     mm-vs-pp condition that carries no T-side column, so a single
	//     `lookupCoveringFK(cc, pp, …)` call abstains. The threaded IND `mm.p_id ⊆
	//     pp.pid` (carried onto the `cc ⋈ mm` sub-frame by Wave-1 join propagation)
	//     discharges it — propagation alone, no transitive closure needed. ---
	const TWO_HOP_DDL = [
		'create table pp (pid integer primary key, pname text)',
		'create table mm (mid integer primary key, p_id integer not null, foreign key (p_id) references pp(pid))',
		'create table cc (id integer primary key, m_id integer not null, sku text not null, unique (m_id, sku), foreign key (m_id) references mm(mid))',
	];
	const TWO_HOP_BODY = 'select c.m_id, c.sku, c.id, p.pname from cc c join mm m on c.m_id = m.mid join pp p on m.p_id = p.pid order by c.m_id, c.sku';

	it('positive: a two-hop FK chain covers via the threaded IND where the structural single-call abstains', async () => {
		const db = await freshDb(TWO_HOP_DDL);
		try {
			expect(proveBody(db, TWO_HOP_BODY, 'cc', false).covers, 'composed IND proves no-row-loss across both hops').to.be.true;
			// Structural-only sees one hop at a time, so the outer mm→pp hop is invisible
			// to `lookupCoveringFK(cc, pp, …)` ⇒ the pre-Wave-2 result is NotCovers('shape').
			const structuralOnly = proveBody(db, TWO_HOP_BODY, 'cc', true);
			expect(structuralOnly.covers, 'structural-only abstains on the outer hop').to.be.false;
			if (!structuralOnly.covers) expect(structuralOnly.reason).to.equal('shape');
		} finally {
			await db.close();
		}
	});

	it('negative: a nullable mid→parent FK yields a nullRejecting threaded IND ⇒ no admit', async () => {
		// mm.p_id is nullable, so the seeded mm→pp IND is `nullRejecting` — a NULL
		// p_id has no parent, so the inner join could drop an (cc⋈mm) row. The IND
		// path skips nullRejecting INDs (the same reason the structural path requires
		// `!match.nullable`) ⇒ no admit.
		const db = await freshDb([
			'create table pp (pid integer primary key, pname text)',
			'create table mm (mid integer primary key, p_id integer null, foreign key (p_id) references pp(pid))',
			'create table cc (id integer primary key, m_id integer not null, sku text not null, unique (m_id, sku), foreign key (m_id) references mm(mid))',
		]);
		try {
			const r = proveBody(db, TWO_HOP_BODY, 'cc', false);
			expect(r.covers, 'a NULL-rejecting IND can drop rows ⇒ must not cover').to.be.false;
			if (!r.covers) expect(r.reason).to.equal('shape');
		} finally {
			await db.close();
		}
	});

	it('negative: the outer join on a non-FK mm column has no matching IND ⇒ no admit', async () => {
		// mm.q_id is NOT NULL but is not a foreign key, so no IND on the `cc ⋈ mm`
		// frame pairs `mm.q_id` to `pp.pid`. The IND pairing mismatches the join's
		// equi-pairs ⇒ the IND path abstains and the structural fallback also fails
		// (the join column is not a T column) ⇒ NotCovers.
		const db = await freshDb([
			'create table pp (pid integer primary key, pname text)',
			'create table mm (mid integer primary key, p_id integer not null, q_id integer not null, foreign key (p_id) references pp(pid))',
			'create table cc (id integer primary key, m_id integer not null, sku text not null, unique (m_id, sku), foreign key (m_id) references mm(mid))',
		]);
		const body = 'select c.m_id, c.sku, c.id, p.pname from cc c join mm m on c.m_id = m.mid join pp p on m.q_id = p.pid order by c.m_id, c.sku';
		try {
			const r = proveBody(db, body, 'cc', false);
			expect(r.covers, 'the join column is not the FK ⇒ the IND pairing mismatches').to.be.false;
			if (!r.covers) expect(r.reason).to.equal('shape');
		} finally {
			await db.close();
		}
	});

	it('negative: a row-reduced (seeked) lookup side cannot cover (shared full-row-set precondition)', async () => {
		// `p.pid > 5` range-seeks the pp lookup, so it no longer exposes the parent's
		// full row set. `innerJoinRetainsConstrainedTable` checks `resolveFullScanTableRef`
		// before the IND path even runs, so the IND derivation never fires; the
		// lookup-column WHERE additionally fails predicate alignment. Either sound
		// rejection is acceptable — the point is that a row-reduced lookup cannot cover.
		const db = await freshDb(TWO_HOP_DDL);
		const body = 'select c.m_id, c.sku, c.id, p.pname from cc c join mm m on c.m_id = m.mid join pp p on m.p_id = p.pid where p.pid > 5 order by c.m_id, c.sku';
		try {
			const r = proveBody(db, body, 'cc', false);
			expect(r.covers, 'a row-reduced lookup re-introduces row loss ⇒ must not cover').to.be.false;
			if (!r.covers) expect(['shape', 'predicate-entailment']).to.include(r.reason);
		} finally {
			await db.close();
		}
	});
});

/**
 * Cross-schema qualifier resolution — the prover's ORDER BY / WHERE qualifier
 * matching is (schema, table)-aware, so a `schema.table.col` term whose *table*
 * name collides with `T`'s but whose *schema* denotes a different schema does NOT
 * mis-map onto base `T`'s same-named column (which would be a false Covers). See
 * the coverage-prover module doc § cross-schema.
 *
 * This path is unreachable from SQL: the binder rejects every 3-part
 * `schema.table.column` reference in expression context before a plan (let alone
 * an MV) exists, so the 3-part ORDER BY term is **hand-built** and the prover is
 * exercised at its boundary only (`proveCoverage` reads `mv.derivation.selectAst`
 * directly, without re-binding). The two SQL-reachable orderings — bare `uc` and 2-part
 * `t.uc` (the `schema: undefined` case) — both correctly resolve to base `T`'s
 * column, so they are the regression floor.
 *
 * Fixture: base `main.t (id pk, uc not null, lkref not null, unique(uc))`
 * left-joined to lookup `s2.t (pkid pk, uc not null)`. Both tables are named `t`
 * and both carry a `uc` column, so a schema-blind qualifier match would collide.
 * The join is 1:1 (LEFT join with base on the preserving side; the lookup is keyed
 * on its own PK ⇒ no fan-out), so the body covers `unique(uc)` exactly when the
 * ORDER BY is a base-`T` `uc` ordering.
 */
describe('coverage prover — cross-schema qualifier resolution (defense-in-depth)', () => {
	const BODY = 'select t.uc, t.id from t left join s2.t on lkref = pkid order by uc';

	async function freshCrossSchema(): Promise<Database> {
		const db = await freshDb([
			'create table t (id integer primary key, uc integer not null, lkref integer not null, unique (uc))',
		]);
		db.schemaManager.addSchema('s2');
		await db.exec('create table s2.t (pkid integer primary key, uc integer not null)');
		return db;
	}

	/**
	 * Proves `BODY` against base `main.t`'s `unique(uc)` with a single hand-built
	 * ORDER BY term `{ type: 'column', name: 'uc', table: 't', schema }` — the
	 * 3-part form SQL cannot produce. `root` comes from the real (plannable) body;
	 * only the stub `selectAst`'s ORDER BY is replaced with the schema-qualified term.
	 */
	function proveWithOrderSchema(db: Database, schema: string | undefined): CoverageResult {
		const selectAst = parseSelect(BODY) as AST.SelectStmt;
		const orderExpr: AST.ColumnExpr = { type: 'column', name: 'uc', table: 't', schema };
		selectAst.orderBy = [{ expr: orderExpr, direction: 'asc' }];
		const mvStub = { name: 'ix', schemaName: 'main', derivation: { selectAst } } as unknown as MaintainedTableSchema;
		const table = db.schemaManager.getTable('main', 't')!;
		const uc = table.uniqueConstraints![0];
		return proveCoverage(bodyRoot(db, BODY), mvStub, uc, table);
	}

	it('lookup-schema-qualified (s2.t.uc) does NOT cover — ordering-mismatch (the fix)', async () => {
		const db = await freshCrossSchema();
		try {
			const result = proveWithOrderSchema(db, 's2');
			expect(result.covers, 'a lookup-schema-qualified ORDER BY must not mis-map onto base T').to.be.false;
			if (!result.covers) expect(result.reason).to.equal('ordering-mismatch');
		} finally {
			await db.close();
		}
	});

	it('base-schema-qualified (main.t.uc) still covers — positive cross-schema', async () => {
		const db = await freshCrossSchema();
		try {
			expect(proveWithOrderSchema(db, 'main').covers, 'a correctly base-qualified ORDER BY covers').to.be.true;
		} finally {
			await db.close();
		}
	});

	it('schema-absent (the reachable bare/2-part path) is unchanged — covers (regression floor)', async () => {
		const db = await freshCrossSchema();
		try {
			expect(proveWithOrderSchema(db, undefined).covers, 'a 2-part t.uc ordering still covers').to.be.true;
		} finally {
			await db.close();
		}
	});
});

describe('introspection hiding', () => {
	it('omits the implicit covering structure by default', async () => {
		const db = await freshDb([
			'create table t (id integer primary key, x integer not null, constraint uq unique (x))',
		]);
		try {
			const catalog = collectSchemaCatalog(db, 'main');
			expect(catalog.indexes.find(i => i.tableName === 't'), 'no implicit index surfaced').to.be.undefined;
		} finally {
			await db.close();
		}
	});

	it('surfaces it when the constraint carries quereus.expose_implicit_index = true', async () => {
		const db = await freshDb([
			'create table t (id integer primary key, x integer not null, constraint uq unique (x) with tags ("quereus.expose_implicit_index" = true))',
		]);
		try {
			const catalog = collectSchemaCatalog(db, 'main');
			const idx = catalog.indexes.find(i => i.tableName === 't' && i.name === 'uq');
			expect(idx, 'implicit index surfaced under the constraint name').to.not.be.undefined;
			// The surfaced entry carries the `implicit` marker so the differ excludes it
			// from its standalone-index buckets (see the idempotency suite below).
			expect(idx!.implicit, 'exposed implicit index marked for the differ to exclude').to.equal(true);
		} finally {
			await db.close();
		}
	});
});

/**
 * Declarative idempotency for an *exposed* implicit covering index — the secondary
 * BTree backing a UNIQUE constraint tagged `quereus.expose_implicit_index`. It is
 * surfaced in `collectSchemaCatalog().indexes` for introspection, but its lifecycle
 * belongs to the originating UNIQUE constraint (the named-constraint diff path), not
 * to `CREATE/DROP INDEX`. A converged schema must therefore diff EMPTY across the
 * index buckets — no phantom `DROP INDEX IF EXISTS <name>` (ticket
 * declarative-differ-spurious-drop-exposed-implicit-index). Guarded under both
 * `allow` and `require-hint`: pre-fix the spurious entry was a pure drop, which
 * `require-hint` silently executed (it only hard-errors when a create AND a drop
 * coincide), so the assertion is that the diff is empty, not that it throws.
 */
describe('declarative idempotency — exposed implicit covering index', () => {
	const DECL = `declare schema main {
		table ExpoTbl {
			id INTEGER PRIMARY KEY,
			vin TEXT,
			constraint uq_expo_vin unique (vin) with tags ("quereus.expose_implicit_index" = true)
		}
	}`;

	for (const policy of ['allow', 'require-hint'] as const) {
		it(`converged schema diffs empty under rename_policy = '${policy}' (no spurious DROP INDEX)`, async () => {
			const db = new Database();
			try {
				await db.exec(DECL);
				await db.exec('apply schema main');

				const catalog = collectSchemaCatalog(db, 'main');
				// Sanity: the exposed index IS surfaced (marker is additive, not a hide).
				const idx = catalog.indexes.find(i => i.tableName === 'ExpoTbl' && i.name === 'uq_expo_vin');
				expect(idx, 'exposed implicit index still surfaced for introspection').to.not.be.undefined;
				expect(idx!.implicit, 'and carries the implicit marker').to.equal(true);

				// The differ must ignore it: a converged schema diffs empty across the
				// index buckets, and the whole migration is a no-op.
				const declared = db.declaredSchemaManager.getDeclaredSchema('main')!;
				const diff = computeSchemaDiff(declared, catalog, policy);
				expect(diff.indexesToCreate, 'no index create').to.deep.equal([]);
				expect(diff.indexesToDrop, 'no spurious DROP INDEX for the exposed implicit index').to.deep.equal([]);
				expect(diff.indexTagsChanges, 'no spurious index tag change').to.deep.equal([]);
				expect(generateMigrationDDL(diff, 'main'), 'converged: no migration DDL').to.deep.equal([]);
			} finally {
				await db.close();
			}
		});
	}

	// Belt-and-suspenders: the create+drop *coincidence* shape. Pre-fix, an
	// exposed implicit index was scheduled for a spurious DROP; pairing it with a
	// genuine index CREATE produced a 1-create/1-drop diff that `require-hint`
	// hard-errors as an ambiguous unhinted rename (it only throws when creates>0
	// AND drops>0). The filter removes the implicit drop, leaving a clean
	// 1-create/0-drop that passes the guard — so `computeSchemaDiff` must NOT
	// throw and must not touch the exposed implicit index.
	it('a genuine index create alongside the exposed implicit index does not trip require-hint', async () => {
		const db = new Database();
		try {
			await db.exec(DECL);
			await db.exec('apply schema main');

			// Re-declare: converged table + a genuine standalone index. The exposed
			// implicit `uq_expo_vin` is still present in the actual catalog.
			await db.exec(`declare schema main {
				table ExpoTbl {
					id INTEGER PRIMARY KEY,
					vin TEXT,
					constraint uq_expo_vin unique (vin) with tags ("quereus.expose_implicit_index" = true)
				}
				index idx_expo_extra on ExpoTbl(vin)
			}`);

			const catalog = collectSchemaCatalog(db, 'main');
			const declared = db.declaredSchemaManager.getDeclaredSchema('main')!;

			// Must NOT throw under require-hint (pre-fix this raised an unhinted-rename
			// error), and the only index op is the genuine create.
			const diff = computeSchemaDiff(declared, catalog, 'require-hint');
			expect(diff.indexesToDrop, 'exposed implicit index not dropped').to.deep.equal([]);
			expect(diff.indexesToCreate.length, 'exactly the one genuine index create').to.equal(1);
			expect(diff.indexesToCreate[0], 'the genuine index, not the implicit one').to.contain('idx_expo_extra');
		} finally {
			await db.close();
		}
	});
});

/**
 * Effective-key ("body proves it") prover — proves the body's own *output*
 * relation is unique on the declared key columns via its effective key (FD
 * closure), the obligation primitive the lens prover's `obligation: proved`
 * class consumes. Distinct from base-table `proveCoverage` above (see the
 * module doc in coverage-prover.ts for why this is NOT folded into it).
 */
describe('coverage prover — effective-key (body proves it)', () => {
	it('group-by proves the composite key {x, y}', async () => {
		const db = await freshDb([
			'create table t (id integer primary key, x integer not null, y integer not null, z integer)',
		]);
		try {
			const root = bodyRoot(db, 'select x, y, sum(z) from t group by x, y');
			expect(proveEffectiveKeyUnique(root, [0, 1])).to.deep.equal({ proved: true });
		} finally {
			await db.close();
		}
	});

	it('group-by does NOT prove a strict subset of the group key', async () => {
		const db = await freshDb([
			'create table t (id integer primary key, x integer not null, y integer not null, z integer)',
		]);
		try {
			// Two distinct groups can share x ⇒ {x} is not a key on the output.
			const root = bodyRoot(db, 'select x, y, sum(z) from t group by x, y');
			expect(proveEffectiveKeyUnique(root, [0])).to.deep.equal({ proved: false, reason: 'not-a-key' });
		} finally {
			await db.close();
		}
	});

	it('group-by proves a superset of the group key (superkey semantics)', async () => {
		const db = await freshDb([
			'create table t (id integer primary key, x integer not null, y integer not null, z integer)',
		]);
		try {
			// [0,1,2] is a superset of the real key {0,1} ⇒ still unique.
			const root = bodyRoot(db, 'select x, y, sum(z) from t group by x, y');
			expect(proveEffectiveKeyUnique(root, [0, 1, 2])).to.deep.equal({ proved: true });
		} finally {
			await db.close();
		}
	});

	it('nullable group key still proves it (strict-unique ⟹ NULL-permissive unique)', async () => {
		const db = await freshDb([
			'create table t (id integer primary key, x integer null)',
		]);
		try {
			const root = bodyRoot(db, 'select x, count(*) from t group by x');
			expect(proveEffectiveKeyUnique(root, [0])).to.deep.equal({ proved: true });
		} finally {
			await db.close();
		}
	});

	it('non-aggregating body: PK FD flows through projection', async () => {
		const db = await freshDb([
			'create table t (id integer primary key, x integer)',
		]);
		try {
			const root = bodyRoot(db, 'select id, x from t');
			expect(proveEffectiveKeyUnique(root, [0]), 'id is a key').to.deep.equal({ proved: true });
			expect(proveEffectiveKeyUnique(root, [1]), 'x alone is not a key').to.deep.equal({ proved: false, reason: 'not-a-key' });
		} finally {
			await db.close();
		}
	});

	it('out-of-frame: a key index beyond the output columns', async () => {
		const db = await freshDb([
			'create table t (id integer primary key, x integer null)',
		]);
		try {
			const root = bodyRoot(db, 'select x, count(*) from t group by x');
			expect(proveEffectiveKeyUnique(root, [99])).to.deep.equal({ proved: false, reason: 'out-of-frame' });
		} finally {
			await db.close();
		}
	});
});

/**
 * Stub-based unit coverage for `proveEffectiveKeyUnique` — mirrors
 * test/optimizer/keysof-isunique.spec.ts: a lightweight `RelationType` +
 * `physical.fds` stub (no full plan tree) exercises the out-of-frame guard and
 * the delegation to `isUnique`.
 */
describe('coverage prover — effective-key (stub unit)', () => {
	function makeRoot(opts: {
		columnCount: number;
		isSet?: boolean;
		keys?: ColRef[][];
		fds?: FunctionalDependency[];
	}): RelationalPlanNode {
		const columns = Array.from({ length: opts.columnCount }, (_, i) => ({
			name: `c${i}`,
			type: { typeClass: 'scalar' as const, logicalType: INTEGER_TYPE, nullable: true, isReadOnly: true },
		}));
		const type: RelationType = {
			typeClass: 'relation',
			isReadOnly: true,
			isSet: opts.isSet ?? false,
			columns,
			keys: opts.keys ?? [],
			rowConstraints: [],
		} as RelationType;
		const physical = { fds: opts.fds } as PhysicalProperties;
		// Only getType()/physical are touched by proveEffectiveKeyUnique → isUnique.
		return { getType: () => type, physical } as unknown as RelationalPlanNode;
	}

	it('out-of-frame guard fires for indices below 0 or ≥ columnCount', () => {
		const root = makeRoot({ columnCount: 2, fds: [{ determinants: [0], dependents: [1], kind: 'unique' }] });
		expect(proveEffectiveKeyUnique(root, [2])).to.deep.equal({ proved: false, reason: 'out-of-frame' });
		expect(proveEffectiveKeyUnique(root, [-1])).to.deep.equal({ proved: false, reason: 'out-of-frame' });
		// A mix where one index is out of frame still reports out-of-frame.
		expect(proveEffectiveKeyUnique(root, [0, 5])).to.deep.equal({ proved: false, reason: 'out-of-frame' });
	});

	it('delegates to isUnique: FD-derived key proves, non-key does not', () => {
		const root = makeRoot({ columnCount: 2, fds: [{ determinants: [0], dependents: [1], kind: 'unique' }] });
		expect(proveEffectiveKeyUnique(root, [0])).to.deep.equal({ proved: true });
		expect(proveEffectiveKeyUnique(root, [1])).to.deep.equal({ proved: false, reason: 'not-a-key' });
	});

	it('empty key columns: proved only when the relation is ≤1 row', () => {
		// ∅ → all_cols ⇒ the empty key holds ⇒ [] is unique.
		const oneRow = makeRoot({ columnCount: 2, fds: [{ determinants: [], dependents: [0, 1], kind: 'unique' }] });
		expect(proveEffectiveKeyUnique(oneRow, [])).to.deep.equal({ proved: true });
		// A bag with no ≤1-row guarantee: [] is not a key.
		const bag = makeRoot({ columnCount: 2 });
		expect(proveEffectiveKeyUnique(bag, [])).to.deep.equal({ proved: false, reason: 'not-a-key' });
	});
});

/**
 * Row-time covering enforcement — a UNIQUE constraint whose conflict resolution
 * is answered by an explicit covering MV's backing table rather than the
 * auto-index (`covering-structure-mv-rowtime-enforcement`). The covering MV is
 * `select <uc-cols>, <pk> from T order by <uc-cols>`, so it is both *covering*
 * (the prover links it) and *row-time* (every MV is row-time maintained, so its
 * backing is consistent mid-statement). `findIndexForConstraint` then prefers it
 * over the auto-index, and the source PK is recovered from the MV projection so
 * IGNORE/ABORT/REPLACE resolve against the correct source row.
 */
describe('row-time covering enforcement', () => {
	let db: Database;
	afterEach(async () => { if (db) await db.close(); });

	async function selectAll(sql: string): Promise<Record<string, unknown>[]> {
		const rows: Record<string, unknown>[] = [];
		for await (const row of db.eval(sql)) rows.push(row);
		return rows;
	}

	async function expectThrows(fn: () => Promise<unknown>, substr: string): Promise<void> {
		let err: unknown;
		try { await fn(); } catch (e) { err = e; }
		expect(err, `expected an error containing "${substr}"`).to.not.be.undefined;
		expect(String((err as Error).message)).to.contain(substr);
	}

	/** t(id pk, x, y, unique(x,y)) covered by a row-time MV `ix`. */
	async function freshCovered(extra: string[] = []): Promise<void> {
		db = new Database();
		await db.exec('create table t (id integer primary key, x integer not null, y integer not null, unique (x, y))');
		await db.exec("create materialized view ix as select x, y, id from t order by x, y");
		for (const stmt of extra) await db.exec(stmt);
	}

	it('resolver: a row-time covering MV is enforcement-ready; a table without one is not', async () => {
		db = new Database();
		await db.exec('create table t (id integer primary key, x integer not null, y integer not null, unique (x, y))');
		await db.exec('create materialized view rt as select x, y, id from t order by x, y');
		const uc = () => db.schemaManager.getTable('main', 't')!.uniqueConstraints![0];
		expect(uc().coveringStructureName, 'forward pointer set').to.equal('rt');
		expect(db._findRowTimeCoveringStructure('main', 't', uc())?.name, 'row-time MV is enforcement-ready').to.equal('rt');

		// A UNIQUE constraint with no covering MV has no enforcement-ready structure
		// (the O(1) negative fast path: no row-time plan reads the source).
		await db.exec('create table u (id integer primary key, x integer not null, y integer not null, unique (x, y))');
		const ucu = db.schemaManager.getTable('main', 'u')!.uniqueConstraints![0];
		expect(ucu.coveringStructureName, 'no covering MV → no forward pointer').to.be.undefined;
		expect(db._findRowTimeCoveringStructure('main', 'u', ucu), 'no covering MV → not enforcement-ready').to.be.undefined;
	});

	it('INSERT conflict, default ABORT → UNIQUE constraint failed: t (x, y)', async () => {
		await freshCovered(['insert into t values (1, 5, 5)']);
		await expectThrows(() => db.exec('insert into t values (2, 5, 5)'), 'UNIQUE constraint failed: t (x, y)');
		expect(await selectAll('select * from t order by id')).to.deep.equal([{ id: 1, x: 5, y: 5 }]);
	});

	it('covering enforcement stays live across a compatible, unreferenced source ALTER', async () => {
		// A compatible `alter table … add column` of a column the MV body never reads
		// now KEEPS the covering MV live (mv-restore-unaffected-structural-alters):
		// its row-time plan is recompiled in place rather than detached, so
		// `findRowTimeCoveringStructure` keeps resolving to it with no REFRESH gap.
		// The `coveringStructureName` forward pointer survives the alter (the spread in
		// runAddColumn keeps it). (Refresh re-registering a DETACHED plan after a
		// body-relevant stale is covered by mv-structural-alter-restore.spec.ts.)
		await freshCovered(['insert into t values (1, 5, 5)']);
		const uc = () => db.schemaManager.getTable('main', 't')!.uniqueConstraints![0];
		expect(db._findRowTimeCoveringStructure('main', 't', uc())?.name, 'covering before alter').to.equal('ix');

		await db.exec('alter table t add column note text null');
		expect(uc().coveringStructureName, 'forward pointer survives compatible alter').to.equal('ix');
		// The MV never reads `note`, so it stays live and enforcement-ready — no stale gap.
		expect(db._findRowTimeCoveringStructure('main', 't', uc())?.name, 'live MV stays enforcement-ready').to.equal('ix');

		// REFRESH is an idempotent no-op re-attach here and keeps it ready.
		await db.exec('refresh materialized view ix');
		expect(db._findRowTimeCoveringStructure('main', 't', uc())?.name, 'refresh keeps the covering MV').to.equal('ix');

		// Enforcement is answered through the (still-registered) covering MV's backing table.
		await expectThrows(() => db.exec('insert into t (id, x, y) values (2, 5, 5)'), 'UNIQUE constraint failed: t (x, y)');
		expect(await selectAll('select count(*) as n from t')).to.deep.equal([{ n: 1 }]);
	});

	it('ABORT reports the prior source row recovered via the MV projection (ON CONFLICT upsert)', async () => {
		db = new Database();
		await db.exec('create table t (id integer primary key, x integer not null, y integer not null, n text, unique (x, y))');
		await db.exec("create materialized view ix as select x, y, id, n from t order by x, y");
		await db.exec("insert into t values (1, 5, 5, 'orig')");
		// The conflict must resolve against the prior source row (id=1) the MV recovers:
		// the upsert updates id=1 in place (id stays 1, n←'new') rather than inserting id=2,
		// proving the correct source row — not a backing-shaped projection — flowed through.
		await db.exec("insert into t values (2, 5, 5, 'new') on conflict (x, y) do update set n = excluded.n");
		expect(await selectAll('select * from t order by id')).to.deep.equal([{ id: 1, x: 5, y: 5, n: 'new' }]);
	});

	it('INSERT OR IGNORE → duplicate silently skipped, row count unchanged', async () => {
		await freshCovered(['insert into t values (1, 5, 5)']);
		await db.exec('insert or ignore into t values (2, 5, 5)');
		expect(await selectAll('select * from t order by id')).to.deep.equal([{ id: 1, x: 5, y: 5 }]);
	});

	it('INSERT OR REPLACE → prior source row evicted by recovered PK, new row present, no phantom backing', async () => {
		await freshCovered(['insert into t values (1, 5, 5)']);
		await db.exec('insert or replace into t values (10, 5, 5)');
		// Correct source PK (id=1) recovered + evicted; new row present.
		expect(await selectAll('select * from t order by id')).to.deep.equal([{ id: 10, x: 5, y: 5 }]);
		// Regression for the eviction-maintenance edge: the evicted row's backing
		// entry must be gone (the MV — which resolves to the backing — shows only id=10).
		expect(await selectAll('select * from ix order by x, y')).to.deep.equal([{ x: 5, y: 5, id: 10 }]);
	});

	it('multi-row INSERT with an intra-statement duplicate (reads-own-writes)', async () => {
		// ABORT: the second row conflicts with the first written mid-statement.
		await freshCovered();
		await expectThrows(() => db.exec('insert into t values (1, 5, 5), (2, 5, 5)'), 'UNIQUE constraint failed: t (x, y)');
		expect(await selectAll('select count(*) as n from t')).to.deep.equal([{ n: 0 }]);

		// OR IGNORE: the second (intra-statement) duplicate is skipped, the first lands.
		await db.exec('insert or ignore into t values (1, 5, 5), (2, 5, 5)');
		expect(await selectAll('select * from t order by id')).to.deep.equal([{ id: 1, x: 5, y: 5 }]);
	});

	it('UPDATE moving a row onto an existing UC value (no PK change), default ABORT', async () => {
		await freshCovered(['insert into t values (1, 5, 5), (2, 6, 6)']);
		// Moving id=1 onto (6,6) collides with id=2 (UPDATE OR <action> is unsupported,
		// so the constraint's ABORT default governs).
		await expectThrows(() => db.exec('update t set x = 6, y = 6 where id = 1'), 'UNIQUE constraint failed: t (x, y)');
		expect(await selectAll('select * from t order by id')).to.deep.equal([{ id: 1, x: 5, y: 5 }, { id: 2, x: 6, y: 6 }]);
	});

	it('UPDATE onto an existing UC value with a schema-level ON CONFLICT REPLACE default evicts + maintains', async () => {
		// Per-statement UPDATE OR REPLACE is unsupported; the constraint's
		// `on conflict replace` default drives REPLACE for the conflicting UPDATE.
		db = new Database();
		await db.exec('create table t (id integer primary key, x integer not null, y integer not null, unique (x, y) on conflict replace)');
		await db.exec("create materialized view ix as select x, y, id from t order by x, y");
		await db.exec('insert into t values (1, 5, 5), (2, 6, 6)');
		// id=1 moves onto (6,6): id=2 is evicted (recovered by PK) + its backing entry maintained.
		await db.exec('update t set x = 6, y = 6 where id = 1');
		expect(await selectAll('select * from t order by id')).to.deep.equal([{ id: 1, x: 6, y: 6 }]);
		expect(await selectAll('select * from ix order by x, y')).to.deep.equal([{ x: 6, y: 6, id: 1 }]);
	});

	it('UPDATE that changes the PK only (UC unchanged) is not a self-conflict', async () => {
		// The internal old-row delete bypasses the row-time hook, so the backing
		// transiently still carries id=1's (5,5) entry. The live-source validation
		// must skip that stale candidate rather than raise a phantom conflict.
		await freshCovered(['insert into t values (1, 5, 5)']);
		await db.exec('update t set id = 10 where id = 1');
		expect(await selectAll('select * from t order by id')).to.deep.equal([{ id: 10, x: 5, y: 5 }]);
		expect(await selectAll('select * from ix order by x, y')).to.deep.equal([{ x: 5, y: 5, id: 10 }]);
	});

	it('UPDATE that changes the PK and moves onto an existing UC value', async () => {
		await freshCovered(['insert into t values (1, 5, 5), (2, 6, 6)']);
		await expectThrows(() => db.exec('update t set id = 99, x = 6, y = 6 where id = 1'), 'UNIQUE constraint failed: t (x, y)');

		// With a schema-level REPLACE default the PK-changing move evicts id=2.
		db = new Database();
		await db.exec('create table t2 (id integer primary key, x integer not null, y integer not null, unique (x, y) on conflict replace)');
		await db.exec("create materialized view ix2 as select x, y, id from t2 order by x, y");
		await db.exec('insert into t2 values (1, 5, 5), (2, 6, 6)');
		await db.exec('update t2 set id = 99, x = 6, y = 6 where id = 1');
		expect(await selectAll('select * from t2 order by id')).to.deep.equal([{ id: 99, x: 6, y: 6 }]);
	});

	it('partial covering MV: out-of-scope rows are not checked', async () => {
		db = new Database();
		await db.exec('create table t (id integer primary key, x integer not null, y integer not null, active integer not null)');
		await db.exec('create unique index uq on t (x, y) where active = 1');
		await db.exec("create materialized view ix as select x, y, id from t where active = 1 order by x, y");
		const uc = db.schemaManager.getTable('main', 't')!.uniqueConstraints![0];
		expect(uc.coveringStructureName, 'partial covering MV linked').to.equal('ix');
		expect(db._findRowTimeCoveringStructure('main', 't', uc)?.name).to.equal('ix');

		await db.exec('insert into t values (1, 5, 5, 1)'); // in scope
		// An out-of-scope row sharing (x,y) does NOT conflict.
		await db.exec('insert into t values (2, 5, 5, 0)');
		// Two out-of-scope rows sharing (x,y) do NOT conflict.
		await db.exec('insert into t values (3, 7, 7, 0), (4, 7, 7, 0)');
		expect(await selectAll('select count(*) as n from t')).to.deep.equal([{ n: 4 }]);
		// A second in-scope row sharing (x,y) DOES conflict.
		await expectThrows(() => db.exec('insert into t values (5, 5, 5, 1)'), 'UNIQUE constraint failed: t (x, y)');
	});

	it('a bare-DDL covering MV is row-time and is used for enforcement', async () => {
		db = new Database();
		await db.exec('create table t (id integer primary key, x integer not null, y integer not null, unique (x, y))');
		// Every MV is row-time maintained, so a covering MV declared with bare DDL (the
		// only form now) links AND is enforcement-ready — used in preference to the auto-index.
		await db.exec('create materialized view man as select x, y, id from t order by x, y');
		const uc = db.schemaManager.getTable('main', 't')!.uniqueConstraints![0];
		expect(uc.coveringStructureName).to.equal('man');
		expect(db._findRowTimeCoveringStructure('main', 't', uc)?.name, 'row-time covering MV is enforcement-ready').to.equal('man');
		// Enforcement works (the auto-index would also catch it).
		await db.exec('insert into t values (1, 5, 5)');
		await expectThrows(() => db.exec('insert into t values (2, 5, 5)'), 'UNIQUE constraint failed: t (x, y)');
	});

	// ── Backing-PK prefix scan (covering-mv-enforcement-prefix-scan-and-preference) ──
	// `lookupCoveringConflicts` keys a prefix scan on the UC values rather than a full
	// backing scan. These exercise the early-termination, backing-PK column ordering,
	// collation fallback, and DESC seek. (The whole suite above also now runs through
	// the prefix scan — its composite `order by x, y` covers the ASC happy path.)

	it('prefix narrows correctly: a shared partial prefix is not a false conflict', async () => {
		// Rows sharing x=1 but differing in y must NOT collide — the prefix scan must
		// early-terminate within the x-block, not report the whole block as conflicts.
		await freshCovered(['insert into t values (1, 1, 1), (2, 1, 2), (3, 2, 1)']);
		// (1,3) shares x=1 with two backing rows but no (1,3) exists ⇒ succeeds.
		await db.exec('insert into t values (4, 1, 3)');
		expect(await selectAll('select count(*) as n from t')).to.deep.equal([{ n: 4 }]);
		// (1,2) duplicates id=2 ⇒ ABORT.
		await expectThrows(() => db.exec('insert into t values (5, 1, 2)'), 'UNIQUE constraint failed: t (x, y)');
	});

	it('prefix conflict recovers the correct source PK among rows sharing a prefix', async () => {
		// Of the rows sharing x=1, the (1,2) conflict must recover id=2 (not id=1).
		// REPLACE evicts exactly the recovered source row, leaving the others intact.
		await freshCovered(['insert into t values (1, 1, 1), (2, 1, 2), (3, 2, 1)']);
		await db.exec('insert or replace into t values (9, 1, 2)');
		expect(await selectAll('select * from t order by id')).to.deep.equal([
			{ id: 1, x: 1, y: 1 }, { id: 3, x: 2, y: 1 }, { id: 9, x: 1, y: 2 },
		]);
	});

	it('UC-permuted order-by: the prefix is built in backing-PK order, not uc.columns order', async () => {
		// `order by y, x` ⇒ the backing PK leads with (y, x). A prefix built in uc
		// (x, y) order would seek to the wrong block and miss the conflict. The (5,7)
		// duplicate must still be caught; a swapped (7,5) is a DISTINCT key.
		db = new Database();
		await db.exec('create table t (id integer primary key, x integer not null, y integer not null, unique (x, y))');
		await db.exec('create materialized view ix as select x, y, id from t order by y, x');
		await db.exec('insert into t values (1, 5, 7)');
		// (7,5) is a different (x,y) ⇒ no conflict.
		await db.exec('insert into t values (2, 7, 5)');
		expect(await selectAll('select count(*) as n from t')).to.deep.equal([{ n: 2 }]);
		// (5,7) duplicates id=1 ⇒ conflict (missed if the prefix used uc order).
		await expectThrows(() => db.exec('insert into t values (3, 5, 7)'), 'UNIQUE constraint failed: t (x, y)');
	});

	it('non-binary collation bypasses the prefix fast path: the candidate generator stays collation-correct', async () => {
		// A NOCASE leading column would make a binary prefix scan miss a collated-equal /
		// binary-different conflict ('Foo' vs 'foo'), so `tryBuildCoveringPrefix` bails and
		// `lookupCoveringConflicts` uses the full scan, which re-compares with the source
		// collation. We assert the *candidate generator* (`_lookupCoveringConflicts`, the
		// surface this ticket changes) still surfaces the conflicting source PK. NOTE: the
		// end-to-end UNIQUE *enforcement* now also honors the column collation at the
		// downstream validator (`checkUniqueViaMaterializedView` and the auto-index path),
		// fixed by `unique-constraint-honors-column-collation`; that end-to-end behavior is
		// covered by `test/logic/102.2-unique-collation.sqllogic`. This case checks the
		// generator only.
		db = new Database();
		await db.exec('create table t (id integer primary key, name text collate NOCASE, unique (name))');
		await db.exec('create materialized view ix as select name, id from t order by name');
		await db.exec("insert into t values (1, 'Foo')");
		const mv = db.schemaManager.getMaintainedTable('main', 'ix')!;
		const uc = db.schemaManager.getTable('main', 't')!.uniqueConstraints![0];
		// New row (id=2, name='foo') vs the backing ('Foo', id=1): a binary prefix scan
		// would early-terminate and return []; the collation-correct full scan returns id=1.
		const conflicts = await db._lookupCoveringConflicts(mv, uc, [2, 'foo'], [2]);
		expect(conflicts.map(c => c.pk)).to.deep.equal([[1]]);
	});

	// ── Semantic-ordering identity (covering-mv-conflict-candidates-semantic) ──
	// A TIMESPAN column calls 'PT1H' and 'PT60M' one value (`docs/types.md` § Semantic
	// ordering). The candidate generator must admit an equal-elapsed backing row even
	// though its stored text differs, or the re-validator never sees the conflict.

	it('generator: an equal-elapsed TIMESPAN probe surfaces the differently-spelled conflicting PK', async () => {
		// The direct analogue of the NOCASE generator case above: the backing holds
		// 'PT1H' and we probe with 'PT60M'. Before the fix the per-candidate filter
		// compared under the declared collation only (byte-different ⇒ dropped) and this
		// returned [].
		db = new Database();
		await db.exec('create table t (id integer primary key, d timespan, unique (d))');
		await db.exec('create materialized view ix as select d, id from t order by d');
		await db.exec("insert into t values (1, 'PT1H')");
		const mv = db.schemaManager.getMaintainedTable('main', 'ix')!;
		const uc = db.schemaManager.getTable('main', 't')!.uniqueConstraints![0];
		expect(db._findRowTimeCoveringStructure('main', 't', uc)?.name, 'MV is the covering structure').to.equal('ix');
		const conflicts = await db._lookupCoveringConflicts(mv, uc, [2, 'PT60M'], [2]);
		expect(conflicts.map(c => c.pk)).to.deep.equal([[1]]);
	});

	it('end-to-end: a re-spelled TIMESPAN duplicate is a UNIQUE violation through the covering MV', async () => {
		db = new Database();
		await db.exec('create table t (id integer primary key, d timespan, unique (d))');
		await db.exec('create materialized view ix as select d, id from t order by d');
		await db.exec("insert into t values (1, 'PT1H')");
		await expectThrows(() => db.exec("insert into t values (2, 'PT60M')"), 'UNIQUE constraint failed: t (d)');
		// Control: an identical spelling was already rejected before this fix.
		await expectThrows(() => db.exec("insert into t values (3, 'PT1H')"), 'UNIQUE constraint failed: t (d)');
		// A genuinely different elapsed time is admitted.
		await db.exec("insert into t values (4, 'PT30M')");
		expect(await selectAll('select id from t order by id')).to.deep.equal([{ id: 1 }, { id: 4 }]);
	});

	it('end-to-end: OR IGNORE skips and OR REPLACE evicts on a re-spelled TIMESPAN duplicate', async () => {
		db = new Database();
		await db.exec('create table t (id integer primary key, d timespan, unique (d))');
		await db.exec('create materialized view ix as select d, id from t order by d');
		await db.exec("insert into t values (1, 'PT1H')");

		await db.exec("insert or ignore into t values (2, 'PT60M')");
		expect(await selectAll('select count(*) as n from t')).to.deep.equal([{ n: 1 }]);

		// REPLACE recovers the conflicting source PK (id=1) and evicts it, backing included.
		await db.exec("insert or replace into t values (3, 'PT3600S')");
		expect(await selectAll('select id, d from t order by id')).to.deep.equal([{ id: 3, d: 'PT3600S' }]);
		expect(await selectAll('select id from ix')).to.deep.equal([{ id: 3 }]);
	});

	it('control: an integer covering MV keeps rejecting its duplicate', async () => {
		// Guards against the semantic branch swallowing the ordinary path.
		db = new Database();
		await db.exec('create table t (id integer primary key, n integer, unique (n))');
		await db.exec('create materialized view ix as select n, id from t order by n');
		await db.exec('insert into t values (1, 7)');
		await expectThrows(() => db.exec('insert into t values (2, 7)'), 'UNIQUE constraint failed: t (n)');
		await db.exec('insert into t values (3, 8)');
		expect(await selectAll('select count(*) as n from t')).to.deep.equal([{ n: 2 }]);
	});

	it('self-exclusion: an UPDATE re-spelling the constrained TIMESPAN on the same row succeeds', async () => {
		db = new Database();
		await db.exec('create table t (id integer primary key, d timespan, unique (d))');
		await db.exec('create materialized view ix as select d, id from t order by d');
		await db.exec("insert into t values (1, 'PT1H')");
		// The new value is semantically equal to the row's own backing entry, so the
		// candidate IS generated (that is the fix) and must then be excluded as self.
		await db.exec("update t set d = 'PT60M' where id = 1");
		expect(await selectAll('select id, d from t')).to.deep.equal([{ id: 1, d: 'PT60M' }]);
		// The sole entry still blocks a third equal-elapsed spelling.
		await expectThrows(() => db.exec("insert into t values (2, 'PT1H0S')"), 'UNIQUE constraint failed: t (d)');
	});

	it('generator self-exclusion honors a semantic-ordering PRIMARY KEY member', async () => {
		// The PK is TIMESPAN, so 'PT1H' and 'PT60M' name the SAME row. A candidate whose
		// recovered source PK is spelled differently from the writing row's must still be
		// excluded as self.
		//
		// Asserted at the generator, not end-to-end: both re-validators already re-check
		// self with a semantic-aware PK equality of their own (memory's
		// `comparePrimaryKeys`, the store's `keysEqual`), so an end-to-end UPDATE passes
		// either way and cannot distinguish the fix. This was the last copy of the
		// comparison that did not honor the type.
		db = new Database();
		await db.exec('create table t (d timespan primary key, v integer not null, unique (v))');
		await db.exec('create materialized view ix as select v, d from t order by v');
		await db.exec("insert into t values ('PT1H', 1)");
		const mv = db.schemaManager.getMaintainedTable('main', 'ix')!;
		const uc = db.schemaManager.getTable('main', 't')!.uniqueConstraints![0];
		// Source row order is (d, v). Re-spelling the PK on the same row ⇒ no conflict.
		expect(await db._lookupCoveringConflicts(mv, uc, ['PT60M', 1], ['PT60M'])).to.deep.equal([]);
		// A genuinely different row with the same `v` IS a conflict, recovering the
		// backing row's own spelling of the source PK.
		const other = await db._lookupCoveringConflicts(mv, uc, ['PT5M', 1], ['PT5M']);
		expect(other.map(c => c.pk)).to.deep.equal([['PT1H']]);

		// End-to-end sanity: the UPDATE succeeds and `v` stays enforced.
		await db.exec("update t set d = 'PT60M' where v = 1");
		expect(await selectAll('select d, v from t')).to.deep.equal([{ d: 'PT60M', v: 1 }]);
		await expectThrows(() => db.exec("insert into t values ('PT5M', 1)"), 'UNIQUE constraint failed: t (v)');
	});

	it('DESC-leading covering MV: the prefix seek still resolves conflicts', async () => {
		// `order by x desc` ⇒ the backing PK leads with x DESC. The equalityPrefix seek
		// must still land on the matching block under the descending physical order.
		db = new Database();
		await db.exec('create table t (id integer primary key, x integer not null, unique (x))');
		await db.exec('create materialized view ix as select x, id from t order by x desc');
		await db.exec('insert into t values (1, 5)');
		await db.exec('insert into t values (2, 6)'); // different x ⇒ ok
		await expectThrows(() => db.exec('insert into t values (3, 5)'), 'UNIQUE constraint failed: t (x)');
		expect(await selectAll('select * from t order by id')).to.deep.equal([{ id: 1, x: 5 }, { id: 2, x: 6 }]);
	});
});

/**
 * Collation eligibility gate for an index-derived UNIQUE answered by a covering MV
 * (`covering-mv-index-derived-unique-collation`). A covering MV generates its
 * conflict candidates under the SOURCE column's DECLARED collation but the
 * re-validators filter under the INDEX per-column collation, so the candidate set is
 * a sound superset only when the index collation is coarser-or-equal to the declared
 * collation per constrained column (BINARY-floor OR name-equal). The gate in
 * `findRowTimeCoveringStructure` declines a finer/incomparable MV so enforcement
 * falls back to the per-scan / auto-index path (already index-collation-correct).
 */
describe('row-time covering enforcement — index-derived collation gate', () => {
	let db: Database;
	afterEach(async () => { if (db) await db.close(); });

	async function selectAll(sql: string): Promise<Record<string, unknown>[]> {
		const rows: Record<string, unknown>[] = [];
		for await (const row of db.eval(sql)) rows.push(row);
		return rows;
	}

	async function expectThrows(fn: () => Promise<unknown>, substr: string): Promise<void> {
		let err: unknown;
		try { await fn(); } catch (e) { err = e; }
		expect(err, `expected an error containing "${substr}"`).to.not.be.undefined;
		expect(String((err as Error).message)).to.contain(substr);
	}

	/** Resolve the (first) UNIQUE constraint on `table` and the covering-structure verdict. */
	function coveringFor(table: string): MaintainedTableSchema | undefined {
		const uc = db.schemaManager.getTable('main', table)!.uniqueConstraints![0];
		return db._findRowTimeCoveringStructure('main', table, uc);
	}

	// ── Premise check (the gate is load-bearing, not mere defense-in-depth) ──
	// The covering-link prover's collation gate compares the OUTPUT column collation
	// against the DECLARED base-column collation, NOT the index collation, so it DOES
	// link a coarser-index covering MV. Without the eligibility gate that link would be
	// resolved and the declared-collation candidate set would silently miss conflicts.
	it('premise: a coarser-index covering MV IS linked (so the gate is load-bearing)', async () => {
		db = new Database();
		await db.exec('create table cbi (id integer primary key, b text)'); // b BINARY
		await db.exec('create unique index cbi_b on cbi (b collate NOCASE)'); // coarser index
		await db.exec('create materialized view cbi_mv as select b, id from cbi order by b');
		const uc = db.schemaManager.getTable('main', 'cbi')!.uniqueConstraints![0];
		expect(uc.derivedFromIndex, 'the UNIQUE is index-derived').to.equal('cbi_b');
		expect(uc.coveringStructureName, 'the prover links the coarser MV (premise of the silent miss)').to.equal('cbi_mv');
		// …but the gate declines it, so it is NOT enforcement-ready.
		expect(coveringFor('cbi'), 'the gate declines the coarser-index MV').to.be.undefined;
	});

	// ── Gate unit tests on _findRowTimeCoveringStructure ──

	it('eligible: FINER index (BINARY) over a NOCASE column → MV used', async () => {
		db = new Database();
		await db.exec('create table fai (id integer primary key, b text collate NOCASE)');
		await db.exec('create unique index fai_b on fai (b collate BINARY)'); // finer index
		await db.exec('create materialized view fai_mv as select b, id from fai order by b');
		expect(coveringFor('fai')?.name, 'I=BINARY floor ⇒ eligible').to.equal('fai_mv');
	});

	it('eligible: EQUAL index collation (NOCASE) over a NOCASE column → MV used', async () => {
		db = new Database();
		await db.exec('create table eqi (id integer primary key, b text collate NOCASE)');
		await db.exec('create unique index eqi_b on eqi (b collate NOCASE)'); // equal
		await db.exec('create materialized view eqi_mv as select b, id from eqi order by b');
		expect(coveringFor('eqi')?.name, 'I==D ⇒ eligible').to.equal('eqi_mv');
	});

	it('eligible: NON-derived UNIQUE over a NOCASE column → MV used', async () => {
		db = new Database();
		await db.exec('create table ndu (id integer primary key, b text collate NOCASE, unique (b))');
		await db.exec('create materialized view ndu_mv as select b, id from ndu order by b');
		const uc = db.schemaManager.getTable('main', 'ndu')!.uniqueConstraints![0];
		expect(uc.derivedFromIndex, 'non-derived UNIQUE').to.be.undefined;
		expect(coveringFor('ndu')?.name, 'non-derived ⇒ I==D ⇒ eligible').to.equal('ndu_mv');
	});

	it('declined: COARSER index (NOCASE) over a BINARY column → MV not used', async () => {
		db = new Database();
		await db.exec('create table cbi (id integer primary key, b text)'); // b BINARY
		await db.exec('create unique index cbi_b on cbi (b collate NOCASE)'); // coarser index
		await db.exec('create materialized view cbi_mv as select b, id from cbi order by b');
		expect(coveringFor('cbi'), 'I=NOCASE, D=BINARY, I≠BINARY & I≠D ⇒ declined').to.be.undefined;
	});

	it('declined: RTRIM index over a BINARY column → MV not used', async () => {
		db = new Database();
		await db.exec('create table rtb (id integer primary key, b text)'); // b BINARY
		await db.exec('create unique index rtb_b on rtb (b collate RTRIM)'); // coarser index
		await db.exec('create materialized view rtb_mv as select b, id from rtb order by b');
		expect(coveringFor('rtb'), 'I=RTRIM, D=BINARY ⇒ declined').to.be.undefined;
	});

	it('declined: composite UC whose one member is coarser → whole MV not used', async () => {
		db = new Database();
		// a: BINARY index over a NOCASE column (eligible); b: NOCASE index over a BINARY
		// column (ineligible). The AND-over-columns gate poisons the whole MV.
		await db.exec('create table comp (id integer primary key, a text collate NOCASE, b text)');
		await db.exec('create unique index comp_ab on comp (a collate BINARY, b collate NOCASE)');
		await db.exec('create materialized view comp_mv as select a, b, id from comp order by a, b');
		const uc = db.schemaManager.getTable('main', 'comp')!.uniqueConstraints![0];
		expect(uc.coveringStructureName, 'composite covering MV linked').to.equal('comp_mv');
		expect(coveringFor('comp'), 'one coarser member poisons the whole MV').to.be.undefined;
	});

	// ── End-to-end memory enforcement through the (declined or kept) covering path ──

	it('finer-index covering MV admits both case-variants (memory re-validates under BINARY)', async () => {
		// The memory-alignment assertion: pre-Phase-2 checkUniqueViaMaterializedView
		// re-validated under the declared NOCASE and over-rejected 'bob' after 'Bob'.
		// After alignment it re-validates under the index BINARY and admits both.
		db = new Database();
		await db.exec('create table fai (id integer primary key, b text collate NOCASE)');
		await db.exec('create unique index fai_b on fai (b collate BINARY)');
		await db.exec('create materialized view fai_mv as select b, id from fai order by b');
		expect(coveringFor('fai')?.name, 'finer-index MV stays eligible').to.equal('fai_mv');
		await db.exec("insert into fai values (1, 'Bob')");
		await db.exec("insert into fai values (2, 'bob')"); // BINARY-distinct ⇒ admitted via MV path
		expect(await selectAll('select id, b from fai order by id')).to.deep.equal([
			{ id: 1, b: 'Bob' }, { id: 2, b: 'bob' },
		]);
		// A genuine BINARY duplicate is still rejected (guard against under-matching).
		await expectThrows(() => db.exec("insert into fai values (3, 'bob')"), 'UNIQUE constraint failed');
		expect(await selectAll('select count(*) as n from fai')).to.deep.equal([{ n: 2 }]);
	});

	it('coarser-index covering MV rejects the NOCASE-equal dup via the declined-MV per-scan path', async () => {
		// The MV is declined (coarser), so enforcement routes to the auto-index
		// (checkUniqueViaIndex) under the index NOCASE: 'BOB' after 'Bob' collides.
		db = new Database();
		await db.exec('create table cbi (id integer primary key, b text)'); // b BINARY
		await db.exec('create unique index cbi_b on cbi (b collate NOCASE)');
		await db.exec('create materialized view cbi_mv as select b, id from cbi order by b');
		await db.exec("insert into cbi values (1, 'Bob')");
		await expectThrows(() => db.exec("insert into cbi values (2, 'BOB')"), 'UNIQUE constraint failed');
		expect(await selectAll('select count(*) as n from cbi')).to.deep.equal([{ n: 1 }]);
		// A genuinely different value still inserts.
		await db.exec("insert into cbi values (3, 'Carol')");
		expect(await selectAll('select id, b from cbi order by id')).to.deep.equal([
			{ id: 1, b: 'Bob' }, { id: 3, b: 'Carol' },
		]);
	});
});

/**
 * Internal-eviction reporting (`internal-eviction-reporting`) — a secondary-UNIQUE
 * REPLACE eviction (a new row collides on a NON-PK UNIQUE with an existing row at a
 * DIFFERENT primary key) is surfaced via `UpdateResult.evictedRows`, so the DML
 * executor runs the full delete pipeline for the evicted row: FK ON DELETE actions,
 * `Database.watch` / change-scope deltas, and data-change events. The non-covered
 * variants (plain UNIQUE auto-index, no covering MV) prove the FK/event fix
 * independently of the covering-MV path.
 */
describe('internal-eviction reporting (secondary-UNIQUE REPLACE)', () => {
	let db: Database;
	afterEach(async () => { if (db) await db.close(); });

	async function selectAll(sql: string): Promise<Record<string, unknown>[]> {
		const rows: Record<string, unknown>[] = [];
		for await (const row of db.eval(sql)) rows.push(row);
		return rows;
	}

	/** A `rows` change-scope watch on a single-column-PK row. */
	function rowsWatch(table: string, pk: number): ChangeScope {
		return {
			watches: [{
				table: { schema: 'main', table },
				columns: new Set(['id']),
				scope: { kind: 'rows', key: ['id'], values: [[pk]] },
			}],
			nonDeterministicSources: [],
			unboundParameters: [],
		};
	}

	it('non-covered: INSERT OR REPLACE eviction cascades FK ON DELETE CASCADE to the evictee children', async () => {
		db = new Database();
		await db.exec('create table p (id integer primary key, email text not null, unique (email))');
		await db.exec('create table c (cid integer primary key, pid integer not null, foreign key (pid) references p(id) on delete cascade)');
		await db.exec("insert into p values (1, 'a@x')");
		await db.exec('insert into c values (10, 1), (11, 1)');
		// new row (id=2, email='a@x') collides on UNIQUE(email) with id=1 (different PK):
		// id=1 is evicted and its children cascade away.
		await db.exec("insert or replace into p values (2, 'a@x')");
		expect(await selectAll('select id, email from p order by id')).to.deep.equal([{ id: 2, email: 'a@x' }]);
		expect(await selectAll('select cid from c order by cid')).to.deep.equal([]);
	});

	it('non-covered: ON DELETE SET NULL nulls the evictee children', async () => {
		db = new Database();
		await db.exec('create table p (id integer primary key, email text not null, unique (email))');
		await db.exec('create table c (cid integer primary key, pid integer null, foreign key (pid) references p(id) on delete set null)');
		await db.exec("insert into p values (1, 'a@x')");
		await db.exec('insert into c values (10, 1)');
		await db.exec("insert or replace into p values (2, 'a@x')");
		expect(await selectAll('select cid, pid from c order by cid')).to.deep.equal([{ cid: 10, pid: null }]);
	});

	it('non-covered: eviction records a change-scope watch delta and a delete event for the evicted PK', async () => {
		db = new Database();
		await db.exec('create table p (id integer primary key, email text not null, unique (email))');
		await db.exec("insert into p values (1, 'a@x')");

		const dataEvents: DatabaseDataChangeEvent[] = [];
		const unsub = db.onDataChange(e => dataEvents.push(e));
		const watchEvents: WatchEvent[] = [];
		const sub = db.watch(rowsWatch('p', 1), e => { watchEvents.push(e); });

		await db.exec("insert or replace into p values (2, 'a@x')");
		sub.unsubscribe();
		unsub();

		// (b) Database.watch / change-scope delta for the evicted PK (id=1).
		expect(watchEvents).to.have.length(1);
		expect(watchEvents[0].matched[0].hits).to.deep.equal([[1]]);
		// (c) a delete event for the evicted row.
		const deletes = dataEvents.filter(e => e.type === 'delete' && e.tableName === 'p');
		expect(deletes.map(d => d.key)).to.deep.equal([[1]]);
		expect(deletes[0].oldRow).to.deep.equal([1, 'a@x']);
	});

	it('covered: eviction cascades FK and keeps the covering MV backing consistent', async () => {
		db = new Database();
		await db.exec('create table p (id integer primary key, x integer not null, y integer not null, unique (x, y))');
		await db.exec('create materialized view p_ix as select x, y, id from p order by x, y');
		await db.exec('create table c (cid integer primary key, pid integer not null, foreign key (pid) references p(id) on delete cascade)');
		await db.exec('insert into p values (1, 5, 5)');
		await db.exec('insert into c values (10, 1)');

		await db.exec('insert or replace into p values (2, 5, 5)');
		expect(await selectAll('select id, x, y from p order by id')).to.deep.equal([{ id: 2, x: 5, y: 5 }]);
		// FK cascade fired for the evicted parent.
		expect(await selectAll('select cid from c order by cid')).to.deep.equal([]);
		// Covering MV backing reflects only the surviving row (the eviction's row-time
		// maintenance now flows through the executor pipeline).
		expect(await selectAll('select x, y, id from p_ix order by x, y')).to.deep.equal([{ x: 5, y: 5, id: 2 }]);
	});
});
