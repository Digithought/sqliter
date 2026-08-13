/**
 * Declarative-schema semantic equivalence harness.
 *
 * Guards the implicit contract that
 *
 *   direct  = freshDb(); direct.exec(canonicalDDL(S))
 *   applied = freshDb(); applied.exec(declarative_form(S))
 *
 *   ⇒  direct.schema ≡ applied.schema
 *      AND  ∀ probe ∈ S: run(probe, direct) ≡ run(probe, applied)
 *
 * Each test case is a `{ name, directDDL, declarativeBody, probes }`
 * tuple. The driver builds two `Database`s — one populated with the
 * canonical DDL, the other built via `declare schema main { ... }
 * apply schema main` — then asserts catalog equivalence per table /
 * view / assertion and iterates the probes through
 * `assertProbeEquivalent` (which also checks the test author's
 * expectation, so a regression that lands in both paths still fails).
 *
 * Harness location: Mocha + chai .spec.ts (not sqllogic). The sqllogic
 * runner assumes one database per file; carrying two parallel DBs
 * through a single block-comparison case is alien to it. Owning the
 * dual-DB plumbing in TypeScript keeps the Case shape readable and
 * lets each row drive both halves of the equivalence in one place.
 */

import { expect } from 'chai';
import { Database } from '../src/core/database.js';
import { StatusCode, type SqlValue } from '../src/common/types.js';
import { computeSchemaHash } from '../src/schema/schema-hasher.js';
import { computeSchemaDiff, generateMigrationDDL } from '../src/schema/schema-differ.js';
import { collectSchemaCatalog } from '../src/schema/catalog.js';
import { MemoryTableModule } from '../src/vtab/memory/module.js';
import {
	assertTableSchemaEqual,
	assertViewSchemaEqual,
	assertMaterializedViewSchemaEqual,
	assertAssertionSchemaEqual,
	assertProbeEquivalent,
	type Probe,
} from './util/schema-equivalence.js';

interface Case {
	name: string;
	/**
	 * Direct DDL — one statement per array entry. Run sequentially via
	 * `db.exec(stmt)`. Use lowercase keywords per project convention.
	 */
	directDDL: string[];
	/**
	 * Declarative body — content placed inside `declare schema main { ... }`.
	 * The driver wraps + appends `apply schema main`.
	 */
	declarativeBody: string;
	/** Names to compare across both DBs after schema apply. */
	expectTables?: string[];
	expectViews?: string[];
	expectMaterializedViews?: string[];
	expectAssertions?: string[];
	/** Probes to run against both DBs after schema apply. */
	probes: Probe[];
	/**
	 * Post-schema setup run against BOTH DBs after the schema is applied
	 * but before probes. Use this for INSERTs into tables that exist in
	 * the direct path's DDL but need to be populated symmetrically in the
	 * declarative path (where `apply schema main` skips `seed` blocks).
	 *
	 * Note: a `preamble` field is deliberately absent — `apply schema main`
	 * drops tables not present in the declarative body, so any table
	 * needed by the case must appear in BOTH `directDDL` and
	 * `declarativeBody`. Data loads belong in `postSetup`.
	 */
	postSetup?: string[];
	/**
	 * Mark the case as expected-to-fail until a referenced fix lands.
	 * Set to a short ticket reference (slug). When set, the case is
	 * `.skip`-ped; remove on fix landing to re-enable.
	 */
	skipUntil?: string;
}

async function buildDirect(c: Case): Promise<Database> {
	const db = new Database();
	for (const stmt of c.directDDL) await db.exec(stmt);
	for (const stmt of c.postSetup ?? []) await db.exec(stmt);
	return db;
}

async function buildApplied(c: Case): Promise<Database> {
	const db = new Database();
	await db.exec(`declare schema main {\n${c.declarativeBody}\n}`);
	await db.exec('apply schema main');
	for (const stmt of c.postSetup ?? []) await db.exec(stmt);
	return db;
}

async function runCase(c: Case): Promise<void> {
	let direct!: Database;
	let applied!: Database;
	try {
		direct = await buildDirect(c);
		applied = await buildApplied(c);

		// Schema-level equivalence
		for (const tableName of c.expectTables ?? []) {
			const d = direct.schemaManager.getTable('main', tableName);
			const a = applied.schemaManager.getTable('main', tableName);
			expect(d, `direct missing table ${tableName}`).to.not.be.undefined;
			expect(a, `applied missing table ${tableName}`).to.not.be.undefined;
			assertTableSchemaEqual(d!, a!, tableName);
		}
		for (const viewName of c.expectViews ?? []) {
			const d = direct.schemaManager.getView('main', viewName);
			const a = applied.schemaManager.getView('main', viewName);
			expect(d, `direct missing view ${viewName}`).to.not.be.undefined;
			expect(a, `applied missing view ${viewName}`).to.not.be.undefined;
			assertViewSchemaEqual(d!, a!, viewName);
		}
		for (const mvName of c.expectMaterializedViews ?? []) {
			const d = direct.schemaManager.getMaintainedTable('main', mvName);
			const a = applied.schemaManager.getMaintainedTable('main', mvName);
			expect(d, `direct missing materialized view ${mvName}`).to.not.be.undefined;
			expect(a, `applied missing materialized view ${mvName}`).to.not.be.undefined;
			assertMaterializedViewSchemaEqual(d!, a!, mvName);
		}
		for (const aName of c.expectAssertions ?? []) {
			const dSchema = direct.schemaManager.getSchema('main');
			const aSchema = applied.schemaManager.getSchema('main');
			const d = dSchema?.getAssertion(aName);
			const a = aSchema?.getAssertion(aName);
			expect(d, `direct missing assertion ${aName}`).to.not.be.undefined;
			expect(a, `applied missing assertion ${aName}`).to.not.be.undefined;
			assertAssertionSchemaEqual(d!, a!, aName);
		}

		// Probe equivalence
		for (const probe of c.probes) {
			await assertProbeEquivalent(direct, applied, probe, probe.sql);
		}
	} finally {
		if (direct) await direct.close();
		if (applied) await applied.close();
	}
}

// ============================================================================
// Self-tests for the harness — two trivially identical, two trivially divergent.
// ============================================================================

describe('declarative-equivalence harness: self-tests', () => {
	it('passes for a trivially identical schema', async () => {
		await runCase({
			name: 'sanity-identical',
			directDDL: ['create table t (id integer primary key, name text not null)'],
			declarativeBody: `table t {
				id INTEGER PRIMARY KEY,
				name TEXT NOT NULL
			}`,
			expectTables: ['t'],
			probes: [
				{ sql: 'select count(*) as n from t', expect: { rows: [{ n: 0 }] } },
			],
		});
	});

	it('detects a NOT NULL diff between direct and declarative bodies', async () => {
		let threw = false;
		try {
			await runCase({
				name: 'sanity-divergent-notnull',
				directDDL: ['create table t (id integer primary key, name text not null)'],
				// Declarative body omits NOT NULL on `name` → catalog diverges.
				declarativeBody: `table t {
					id INTEGER PRIMARY KEY,
					name TEXT null
				}`,
				expectTables: ['t'],
				probes: [],
			});
		} catch (e) {
			threw = true;
			const msg = e instanceof Error ? e.message : String(e);
			expect(msg).to.match(/notNull|columns\[1\]/i);
		}
		expect(threw, 'expected the harness to fail on a NOT NULL divergence').to.be.true;
	});

	it('detects a probe expectation mismatch even when the two DBs agree', async () => {
		let threw = false;
		try {
			await runCase({
				name: 'sanity-divergent-expectation',
				directDDL: ['create table t (id integer primary key)'],
				declarativeBody: `table t { id INTEGER PRIMARY KEY }`,
				expectTables: ['t'],
				probes: [
					// Both DBs will return [{n: 0}], but expectation is wrong.
					{ sql: 'select count(*) as n from t', expect: { rows: [{ n: 99 }] } },
				],
			});
		} catch (e) {
			threw = true;
			const msg = e instanceof Error ? e.message : String(e);
			expect(msg).to.match(/expected/i);
		}
		expect(threw, 'expected the harness to fail on a wrong author expectation').to.be.true;
	});

	it('detects a row-vs-error outcome class divergence', async () => {
		let threw = false;
		try {
			await runCase({
				name: 'sanity-divergent-outcome',
				directDDL: ['create table t (id integer primary key)'],
				declarativeBody: `table t { id INTEGER PRIMARY KEY }`,
				expectTables: ['t'],
				probes: [
					// Probe expects rows, but the SQL is invalid → both DBs will error.
					{ sql: 'select * from nonexistent_table', expect: { rows: [] } },
				],
			});
		} catch (e) {
			threw = true;
			const msg = e instanceof Error ? e.message : String(e);
			expect(msg).to.match(/expected rows but both DBs threw/i);
		}
		expect(threw, 'expected outcome-class mismatch to fail').to.be.true;
	});
});

// ============================================================================
// CHECK constraints
// ============================================================================

describe('declarative-equivalence: CHECK constraints', () => {
	it('row-only inline CHECK matches across paths', async function () {
		await runCase({
			name: 'check-row-only',
			directDDL: [
				'create table t (id integer primary key, age integer check (age >= 0))',
			],
			declarativeBody: `table t {
				id INTEGER PRIMARY KEY,
				age INTEGER CHECK (age >= 0)
			}`,
			expectTables: ['t'],
			probes: [
				{ sql: "insert into t values (1, 5)", expect: { rows: [] } },
				{ sql: 'select age from t where id = 1', expect: { rows: [{ age: 5 }] } },
				{
					sql: 'insert into t values (2, -1)',
					expect: { error: { status: StatusCode.CONSTRAINT } },
				},
			],
		});
	});

	it('CHECK with on insert,update operations mask', async function () {
		await runCase({
			name: 'check-ops-iu',
			directDDL: [
				'create table t (id integer primary key, v integer, check on insert,update (v > 0))',
			],
			declarativeBody: `table t {
				id INTEGER PRIMARY KEY,
				v INTEGER,
				check on insert, update (v > 0)
			}`,
			expectTables: ['t'],
			probes: [
				{ sql: 'insert into t values (1, 10)', expect: { rows: [] } },
				{
					sql: 'insert into t values (2, 0)',
					expect: { error: { status: StatusCode.CONSTRAINT } },
				},
				// UPDATE path is also constrained
				{
					sql: 'update t set v = -5 where id = 1',
					expect: { error: { status: StatusCode.CONSTRAINT } },
				},
			],
		});
	});

	it('CHECK with on delete mask preserves DELETE-firing behaviour (issue #23 surface)', async function () {
		await runCase({
			name: 'check-ops-delete',
			directDDL: [
				'create table t (id integer primary key, v integer)',
				// CHECK that always evaluates true on DELETE — purpose is to exercise the
				// mask round-trip: if the `on delete` is dropped during declarative apply,
				// the catalog will show a different `operations` mask.
				'alter table t add constraint c1 check on delete (v <> -999)',
			],
			declarativeBody: `table t {
				id INTEGER PRIMARY KEY,
				v INTEGER,
				constraint c1 check on delete (v <> -999)
			}`,
			expectTables: ['t'],
			probes: [
				{ sql: 'insert into t values (1, 1)', expect: { rows: [] } },
				{ sql: 'delete from t where id = 1', expect: { rows: [] } },
				{ sql: 'select count(*) as n from t', expect: { rows: [{ n: 0 }] } },
			],
		});
	});

	it('CHECK with on update-only mask leaves INSERT path unconstrained', async function () {
		await runCase({
			name: 'check-ops-update-only',
			directDDL: [
				'create table t (id integer primary key, v integer, check on update (v >= 0))',
			],
			declarativeBody: `table t {
				id INTEGER PRIMARY KEY,
				v INTEGER,
				check on update (v >= 0)
			}`,
			expectTables: ['t'],
			probes: [
				// INSERT with violating value MUST succeed (UPDATE-only mask).
				{ sql: 'insert into t values (1, -5)', expect: { rows: [] } },
				// UPDATE that keeps it negative violates.
				{
					sql: 'update t set v = -10 where id = 1',
					expect: { error: { status: StatusCode.CONSTRAINT } },
				},
				// UPDATE that fixes it succeeds.
				{ sql: 'update t set v = 7 where id = 1', expect: { rows: [] } },
			],
		});
	});

	it('CHECK with on insert-only mask leaves UPDATE path unconstrained', async function () {
		await runCase({
			name: 'check-ops-insert-only',
			directDDL: [
				'create table t (id integer primary key, v integer, check on insert (v >= 0))',
			],
			declarativeBody: `table t {
				id INTEGER PRIMARY KEY,
				v INTEGER,
				check on insert (v >= 0)
			}`,
			expectTables: ['t'],
			probes: [
				{ sql: 'insert into t values (1, 1)', expect: { rows: [] } },
				{
					sql: 'insert into t values (2, -1)',
					expect: { error: { status: StatusCode.CONSTRAINT } },
				},
				// UPDATE may make it negative (mask excludes UPDATE).
				{ sql: 'update t set v = -1 where id = 1', expect: { rows: [] } },
			],
		});
	});

	it('table-level named CHECK with subquery (issue #22 surface)', async function () {
		await runCase({
			name: 'check-not-in-subquery',
			directDDL: [
				'create table forbidden (id integer primary key, code integer not null)',
				'create table t (id integer primary key, code integer not null, constraint c_code check (code not in (select code from forbidden)))',
			],
			declarativeBody: `table forbidden {
				id INTEGER PRIMARY KEY,
				code INTEGER NOT NULL
			}

			table t {
				id INTEGER PRIMARY KEY,
				code INTEGER NOT NULL,
				constraint c_code check (code not in (select code from forbidden))
			}`,
			expectTables: ['t', 'forbidden'],
			postSetup: [
				'insert into forbidden values (1, 99)',
			],
			probes: [
				{ sql: 'insert into t values (1, 1)', expect: { rows: [] } },
				{
					sql: 'insert into t values (2, 99)',
					expect: { error: { status: StatusCode.CONSTRAINT } },
				},
			],
		});
	});
});

// ============================================================================
// Defaults
// ============================================================================

describe('declarative-equivalence: defaults', () => {
	it('literal default round-trips', async function () {
		await runCase({
			name: 'default-literal',
			directDDL: [
				"create table t (id integer primary key, status text default 'pending' not null)",
			],
			declarativeBody: `table t {
				id INTEGER PRIMARY KEY,
				status TEXT NOT NULL DEFAULT 'pending'
			}`,
			expectTables: ['t'],
			probes: [
				{ sql: 'insert into t (id) values (1)', expect: { rows: [] } },
				{ sql: 'select status from t where id = 1', expect: { rows: [{ status: 'pending' }] } },
			],
		});
	});

	it('expression default round-trips', async function () {
		await runCase({
			name: 'default-expression',
			directDDL: [
				'create table t (id integer primary key, total integer not null default (1 + 2))',
			],
			declarativeBody: `table t {
				id INTEGER PRIMARY KEY,
				total INTEGER NOT NULL DEFAULT (1 + 2)
			}`,
			expectTables: ['t'],
			probes: [
				{ sql: 'insert into t (id) values (1)', expect: { rows: [] } },
				{ sql: 'select total from t where id = 1', expect: { rows: [{ total: 3 }] } },
			],
		});
	});

	it('new.<column> default survives the declarative round-trip', async function () {
		// The deferred `new.` default must re-emit and re-apply identically — a
		// dropped qualifier would silently corrupt the schema under apply.
		await runCase({
			name: 'default-new-ref',
			directDDL: [
				'create table t (id integer primary key, base integer, doubled integer default (new.base * 2))',
			],
			declarativeBody: `table t {
				id INTEGER PRIMARY KEY,
				base INTEGER,
				doubled INTEGER DEFAULT (new.base * 2)
			}`,
			expectTables: ['t'],
			probes: [
				{ sql: 'insert into t (id, base) values (1, 21)', expect: { rows: [] } },
				{ sql: 'select doubled from t where id = 1', expect: { rows: [{ doubled: 42 }] } },
			],
		});
	});
});

// ============================================================================
// Generated columns
// ============================================================================

describe('declarative-equivalence: generated columns', () => {
	it('virtual generated column', async function () {
		await runCase({
			name: 'gen-virtual',
			directDDL: [
				'create table t (id integer primary key, x integer not null, y integer not null, sum integer generated always as (x + y) virtual)',
			],
			declarativeBody: `table t {
				id INTEGER PRIMARY KEY,
				x INTEGER NOT NULL,
				y INTEGER NOT NULL,
				sum INTEGER GENERATED ALWAYS AS (x + y) VIRTUAL
			}`,
			expectTables: ['t'],
			probes: [
				{ sql: 'insert into t (id, x, y) values (1, 3, 4)', expect: { rows: [] } },
				{ sql: 'select sum from t where id = 1', expect: { rows: [{ sum: 7 }] } },
			],
		});
	});

	it('stored generated column', async function () {
		await runCase({
			name: 'gen-stored',
			directDDL: [
				'create table t (id integer primary key, x integer not null, y integer not null, p integer generated always as (x * y) stored)',
			],
			declarativeBody: `table t {
				id INTEGER PRIMARY KEY,
				x INTEGER NOT NULL,
				y INTEGER NOT NULL,
				p INTEGER GENERATED ALWAYS AS (x * y) STORED
			}`,
			expectTables: ['t'],
			probes: [
				{ sql: 'insert into t (id, x, y) values (1, 6, 7)', expect: { rows: [] } },
				{ sql: 'select p from t where id = 1', expect: { rows: [{ p: 42 }] } },
			],
		});
	});
});

// ============================================================================
// Foreign keys
// ============================================================================

describe('declarative-equivalence: foreign keys', () => {
	it('FK on delete cascade fires through both paths', async function () {
		await runCase({
			name: 'fk-on-delete-cascade',
			directDDL: [
				'create table parent (id integer primary key, label text)',
				'create table child (id integer primary key, parent_id integer not null, constraint fk_parent foreign key (parent_id) references parent(id) on delete cascade)',
			],
			declarativeBody: `table parent {
				id INTEGER PRIMARY KEY,
				label TEXT
			}

			table child {
				id INTEGER PRIMARY KEY,
				parent_id INTEGER NOT NULL,
				constraint fk_parent foreign key (parent_id) references parent(id) on delete cascade
			}`,
			expectTables: ['parent', 'child'],
			postSetup: [
				"insert into parent values (1, 'a'), (2, 'b')",
				'insert into child values (10, 1), (11, 1), (12, 2)',
			],
			probes: [
				{ sql: 'delete from parent where id = 1', expect: { rows: [] } },
				{ sql: 'select count(*) as n from child', expect: { rows: [{ n: 1 }] } },
				{ sql: 'select id from child order by id', expect: { rows: [{ id: 12 }] } },
			],
		});
	});

	it('FK restrict blocks delete', async function () {
		await runCase({
			name: 'fk-on-delete-restrict',
			directDDL: [
				'create table parent2 (id integer primary key)',
				'create table child2 (id integer primary key, parent_id integer not null, constraint fk_parent2 foreign key (parent_id) references parent2(id) on delete restrict)',
			],
			declarativeBody: `table parent2 {
				id INTEGER PRIMARY KEY
			}

			table child2 {
				id INTEGER PRIMARY KEY,
				parent_id INTEGER NOT NULL,
				constraint fk_parent2 foreign key (parent_id) references parent2(id) on delete restrict
			}`,
			expectTables: ['parent2', 'child2'],
			postSetup: [
				'insert into parent2 values (1)',
				'insert into child2 values (10, 1)',
			],
			probes: [
				{
					sql: 'delete from parent2 where id = 1',
					expect: { error: { status: StatusCode.CONSTRAINT } },
				},
			],
		});
	});
});

// ============================================================================
// Indexes
// ============================================================================

describe('declarative-equivalence: indexes', () => {
	it('plain index round-trips', async function () {
		await runCase({
			name: 'index-plain',
			directDDL: [
				'create table t (id integer primary key, name text)',
				'create index t_name_idx on t (name)',
			],
			declarativeBody: `table t {
				id INTEGER PRIMARY KEY,
				name TEXT
			}

			index t_name_idx on t (name)`,
			expectTables: ['t'],
			probes: [
				{ sql: "insert into t values (1, 'alice'), (2, 'bob')", expect: { rows: [] } },
				{ sql: "select id from t where name = 'alice'", expect: { rows: [{ id: 1 }] } },
			],
		});
	});

	it('unique index round-trips and enforces uniqueness', async function () {
		await runCase({
			name: 'index-unique',
			directDDL: [
				'create table t (id integer primary key, email text)',
				'create unique index t_email_uniq on t (email)',
			],
			declarativeBody: `table t {
				id INTEGER PRIMARY KEY,
				email TEXT
			}

			unique index t_email_uniq on t (email)`,
			expectTables: ['t'],
			probes: [
				{ sql: "insert into t values (1, 'a@x'), (2, 'b@x')", expect: { rows: [] } },
				{
					sql: "insert into t values (3, 'a@x')",
					expect: { error: { status: StatusCode.CONSTRAINT } },
				},
			],
		});
	});

	it('partial index round-trips its WHERE predicate through declarative apply', async function () {
		// Exercises the `declare schema` index WHERE-clause grammar end-to-end: the
		// declared partial index must parse, apply, and land a `predicate` matching
		// the direct `create index ... where` form. assertTableSchemaEqual compares
		// the index predicate (eqExpr), so a dropped/garbled WHERE fails the case.
		await runCase({
			name: 'index-partial',
			directDDL: [
				'create table t (id integer primary key, active integer, name text)',
				'create index ix_active on t (name) where active = 1',
			],
			declarativeBody: `table t {
				id INTEGER PRIMARY KEY,
				active INTEGER,
				name TEXT
			}

			index ix_active on t (name) where active = 1`,
			expectTables: ['t'],
			probes: [
				{ sql: "insert into t values (1, 1, 'alice'), (2, 0, 'bob')", expect: { rows: [] } },
				{ sql: "select id from t where name = 'alice'", expect: { rows: [{ id: 1 }] } },
			],
		});
	});

	it('unique partial index round-trips and enforces uniqueness within its predicate', async function () {
		// `unique index ... where ...` must thread BOTH isUnique and the predicate
		// through the declarative path. The probes prove the index is genuinely
		// PARTIAL, not just unique: in-scope duplicates are rejected, but a
		// duplicate name OUTSIDE the predicate scope (active = 0) is allowed — the
		// behaviour that distinguishes a partial unique index from a full one and
		// would be lost if the WHERE were dropped on either path.
		await runCase({
			name: 'index-unique-partial',
			directDDL: [
				'create table t (id integer primary key, active integer, name text)',
				'create unique index uq_active_name on t (name) where active = 1',
			],
			declarativeBody: `table t {
				id INTEGER PRIMARY KEY,
				active INTEGER,
				name TEXT
			}

			unique index uq_active_name on t (name) where active = 1`,
			expectTables: ['t'],
			probes: [
				{ sql: "insert into t values (1, 1, 'dup')", expect: { rows: [] } },
				// Second in-scope (active = 1) duplicate is rejected by both paths.
				{
					sql: "insert into t values (2, 1, 'dup')",
					expect: { error: { status: StatusCode.CONSTRAINT } },
				},
				// A same-name row OUTSIDE the predicate (active = 0) is admitted —
				// proof the predicate actually narrows enforcement (a full unique
				// index would reject this).
				{ sql: "insert into t values (3, 0, 'dup')", expect: { rows: [] } },
				// And a second out-of-scope duplicate is likewise admitted.
				{ sql: "insert into t values (4, 0, 'dup')", expect: { rows: [] } },
				// The original in-scope key is still enforced afterward — the index
				// was not silently disabled by the out-of-scope inserts.
				{
					sql: "insert into t values (5, 1, 'dup')",
					expect: { error: { status: StatusCode.CONSTRAINT } },
				},
			],
		});
	});
});

// ============================================================================
// Views — body shapes that round-trip through compound selects (issue #21)
// ============================================================================

describe('declarative-equivalence: views', () => {
	it('view body with union all preserves all legs (issue #21 surface)', async function () {
		await runCase({
			name: 'view-union-all',
			directDDL: [
				'create table base_a (id integer primary key, v integer)',
				'create table base_b (id integer primary key, v integer)',
				'create table base_c (id integer primary key, v integer)',
				'create view v_all as select v from base_a union all select v from base_b union all select v from base_c',
			],
			declarativeBody: `table base_a { id INTEGER PRIMARY KEY, v INTEGER }
			table base_b { id INTEGER PRIMARY KEY, v INTEGER }
			table base_c { id INTEGER PRIMARY KEY, v INTEGER }

			view v_all as
				select v from base_a
				union all
				select v from base_b
				union all
				select v from base_c`,
			expectTables: ['base_a', 'base_b', 'base_c'],
			expectViews: ['v_all'],
			postSetup: [
				'insert into base_a values (1, 10), (2, 20)',
				'insert into base_b values (3, 30), (4, 40)',
				'insert into base_c values (5, 50), (6, 60)',
			],
			probes: [
				{ sql: 'select count(*) as n from v_all', expect: { rows: [{ n: 6 }] } },
				{
					sql: 'select v from v_all order by v',
					expect: { rows: [{ v: 10 }, { v: 20 }, { v: 30 }, { v: 40 }, { v: 50 }, { v: 60 }] },
				},
			],
		});
	});

	it('view body with explicit column list', async function () {
		await runCase({
			name: 'view-explicit-cols',
			directDDL: [
				'create table src (id integer primary key, name text not null)',
				'create view v_renamed (vid, vname) as select id, name from src',
			],
			declarativeBody: `table src { id INTEGER PRIMARY KEY, name TEXT NOT NULL }

			view v_renamed (vid, vname) as
				select id, name from src`,
			expectTables: ['src'],
			expectViews: ['v_renamed'],
			postSetup: [
				"insert into src values (1, 'alpha'), (2, 'beta')",
			],
			probes: [
				{
					sql: 'select vid, vname from v_renamed order by vid',
					expect: { rows: [{ vid: 1, vname: 'alpha' }, { vid: 2, vname: 'beta' }] },
				},
			],
		});
	});

	it('view with with defaults clause — schema field and write-through agree on both paths', async function () {
		await runCase({
			name: 'view-insert-defaults',
			directDDL: [
				'create table dfl (id integer primary key, name text, created integer not null)',
				'create view dfl_v as select id, name from dfl with defaults (created = 424242)',
			],
			declarativeBody: `table dfl { id INTEGER PRIMARY KEY, name TEXT, created INTEGER NOT NULL }

			view dfl_v as
				select id, name from dfl with defaults (created = 424242)`,
			expectTables: ['dfl'],
			expectViews: ['dfl_v'],
			// Write THROUGH the view on both paths — the clause must supply the
			// omitted not-null `created` on the direct and the applied DB alike.
			postSetup: [
				"insert into dfl_v values (1, 'alpha')",
			],
			probes: [
				{
					sql: 'select id, name, created from dfl order by id',
					expect: { rows: [{ id: 1, name: 'alpha', created: 424242 }] },
				},
			],
		});
	});
});

// ============================================================================
// Cross-shape probe — view inside CHECK
// ============================================================================

describe('declarative-equivalence: cross-shape (view + CHECK)', () => {
	it('CHECK against a compound-select view body matches both paths', async function () {
		await runCase({
			name: 'check-against-compound-view',
			directDDL: [
				'create table allow_a (code integer primary key)',
				'create table allow_b (code integer primary key)',
				'create view all_allowed as select code from allow_a union all select code from allow_b',
				'create table t (id integer primary key, code integer check (code in (select code from all_allowed)))',
			],
			declarativeBody: `table allow_a { code INTEGER PRIMARY KEY }
			table allow_b { code INTEGER PRIMARY KEY }

			view all_allowed as
				select code from allow_a
				union all
				select code from allow_b

			table t {
				id INTEGER PRIMARY KEY,
				code INTEGER CHECK (code in (select code from all_allowed))
			}`,
			expectTables: ['t', 'allow_a', 'allow_b'],
			expectViews: ['all_allowed'],
			postSetup: [
				'insert into allow_a values (1), (2)',
				'insert into allow_b values (3), (4)',
			],
			probes: [
				{ sql: 'insert into t values (1, 1)', expect: { rows: [] } },
				{ sql: 'insert into t values (2, 4)', expect: { rows: [] } },
				{
					sql: 'insert into t values (3, 99)',
					expect: { error: { status: StatusCode.CONSTRAINT } },
				},
			],
		});
	});
});

// ============================================================================
// Assertions
// ============================================================================

describe('declarative-equivalence: assertions', () => {
	it('assertion fires on violating INSERT through both paths', async function () {
		await runCase({
			name: 'assertion-positive-balance',
			directDDL: [
				'create table accounts (id integer primary key, balance integer not null)',
				'create assertion positive_balance check (not exists (select 1 from accounts where balance < 0))',
			],
			declarativeBody: `table accounts {
				id INTEGER PRIMARY KEY,
				balance INTEGER NOT NULL
			}

			assertion positive_balance check (not exists (select 1 from accounts where balance < 0))`,
			expectTables: ['accounts'],
			expectAssertions: ['positive_balance'],
			probes: [
				{ sql: 'insert into accounts values (1, 100)', expect: { rows: [] } },
				{
					sql: 'insert into accounts values (2, -10)',
					expect: { error: {} },
				},
			],
		});
	});
});

// ============================================================================
// Decorations — tags at table / column / constraint level
// ============================================================================

describe('declarative-equivalence: decorations (tags)', () => {
	it('table-level tags round-trip', async function () {
		await runCase({
			name: 'tags-table-level',
			directDDL: [
				`create table t (id integer primary key) with tags (owner = 'team-a', layer = 'core')`,
			],
			declarativeBody: `table t {
				id INTEGER PRIMARY KEY
			} with tags (owner = 'team-a', layer = 'core')`,
			expectTables: ['t'],
			probes: [
				{ sql: 'select count(*) as n from t', expect: { rows: [{ n: 0 }] } },
			],
		});
	});

	it('apply schema converges drifted table/column/constraint tags, and re-apply is idempotent', async function () {
		const db = new Database();
		try {
			// Apply an initial schema with one set of tags at each site.
			await db.exec(`declare schema main {
				table t {
					id INTEGER PRIMARY KEY,
					name TEXT NOT NULL with tags (searchable = true),
					constraint uq_name unique (name) with tags (msg = 'orig')
				} with tags (owner = 'team-a')
			}`);
			await db.exec('apply schema main');

			// Re-declare with changed tags at all three sites (structure unchanged).
			await db.exec(`declare schema main {
				table t {
					id INTEGER PRIMARY KEY,
					name TEXT NOT NULL with tags (searchable = false, indexed = true),
					constraint uq_name unique (name) with tags (msg = 'updated')
				} with tags (owner = 'team-b', layer = 'core')
			}`);

			// The diff detects tag drift at all three sites (and nothing structural).
			const declared = db.declaredSchemaManager.getDeclaredSchema('main')!;
			const diff = computeSchemaDiff(declared, collectSchemaCatalog(db, 'main'));
			expect(diff.tablesToAlter.length, 'tag drift should produce exactly one alter').to.equal(1);
			const alter = diff.tablesToAlter[0];
			expect(alter.columnsToAdd, 'no structural column adds').to.deep.equal([]);
			expect(alter.columnsToDrop, 'no structural column drops').to.deep.equal([]);
			expect(alter.primaryKeyChange, 'no PK change').to.be.undefined;
			expect(alter.tableTagsChange).to.deep.equal({ owner: 'team-b', layer: 'core' });
			const colChange = alter.columnsToAlter.find(c => c.columnName.toLowerCase() === 'name');
			expect(colChange?.tags).to.deep.equal({ searchable: false, indexed: true });
			expect(colChange?.dataType, 'no type drift').to.be.undefined;
			expect(colChange?.notNull, 'no nullability drift').to.be.undefined;
			expect(alter.constraintTagsChanges).to.deep.equal([{ constraintName: 'uq_name', tags: { msg: 'updated' } }]);

			await db.exec('apply schema main');

			// The live catalog converged at all three sites.
			const t = db.schemaManager.getTable('main', 't')!;
			expect(t.tags).to.deep.equal({ owner: 'team-b', layer: 'core' });
			const nameCol = t.columns.find(c => c.name.toLowerCase() === 'name')!;
			expect(nameCol.tags).to.deep.equal({ searchable: false, indexed: true });
			const uq = t.uniqueConstraints!.find(c => c.name === 'uq_name')!;
			expect(uq.tags).to.deep.equal({ msg: 'updated' });

			// Re-applying the same declaration is a no-op — no tag drift remains.
			const diff2 = computeSchemaDiff(
				db.declaredSchemaManager.getDeclaredSchema('main')!,
				collectSchemaCatalog(db, 'main'),
			);
			expect(diff2.tablesToAlter, 'idempotent re-apply produces no alter').to.deep.equal([]);
		} finally {
			await db.close();
		}
	});

	it('a tag-only declaration change does not perturb the structural schema hash', async function () {
		const a = new Database();
		const b = new Database();
		try {
			await a.exec(`declare schema main {
				table t { id INTEGER PRIMARY KEY, name TEXT NOT NULL } with tags (owner = 'team-a')
			}`);
			await b.exec(`declare schema main {
				table t { id INTEGER PRIMARY KEY, name TEXT NOT NULL } with tags (owner = 'team-b')
			}`);
			const ha = computeSchemaHash(a.declaredSchemaManager.getDeclaredSchema('main')!);
			const hb = computeSchemaHash(b.declaredSchemaManager.getDeclaredSchema('main')!);
			expect(ha, 'tag value must not change the schema hash').to.equal(hb);
		} finally {
			await a.close();
			await b.close();
		}
	});

	it('a SET TAGS carrying only a rename hint does not churn after the rename completes', async function () {
		const db = new Database();
		try {
			// Apply a table; then re-declare it renamed via a previous_name hint plus a
			// real tag. After the rename lands, re-declaring with the SAME hint must not
			// produce a tag drift (hints are excluded from the drift comparison).
			await db.exec(`declare schema main {
				table orders { id INTEGER PRIMARY KEY } with tags (owner = 'team-a')
			}`);
			await db.exec('apply schema main');

			await db.exec(`declare schema main {
				table sales_orders { id INTEGER PRIMARY KEY } with tags (owner = 'team-a', "quereus.previous_name" = 'orders')
			}`);
			await db.exec('apply schema main');

			// The table is renamed and carries the real tag.
			expect(db.schemaManager.getTable('main', 'orders'), 'old name gone').to.be.undefined;
			const renamed = db.schemaManager.getTable('main', 'sales_orders')!;
			expect(renamed.tags?.owner).to.equal('team-a');

			// Re-diff with the same declaration: the previous_name hint must not register
			// as a tag drift now that the rename has completed.
			const diff = computeSchemaDiff(
				db.declaredSchemaManager.getDeclaredSchema('main')!,
				collectSchemaCatalog(db, 'main'),
			);
			expect(diff.renames, 'no further rename').to.deep.equal([]);
			expect(diff.tablesToAlter, 'hint-only difference must not churn a SET TAGS').to.deep.equal([]);
		} finally {
			await db.close();
		}
	});
});

// ============================================================================
// Column collation drift — declarative detection + in-place SET COLLATE.
// Unlike tags (non-behavioral, hash-stable), collation is real schema: it
// changes `=` / ORDER BY semantics and so MUST move the schema hash. These tests
// are the inverse of the tag-hash-stable assertions above.
// ============================================================================

describe('declarative-equivalence: column collation drift', () => {
	it('apply schema converges a drifted column collation via SET COLLATE, changes semantics, and is idempotent', async function () {
		const db = new Database();
		try {
			// Apply an initial schema with a BINARY (default-collation) text column.
			await db.exec(`declare schema main {
				table t { id INTEGER PRIMARY KEY, name TEXT }
			}`);
			await db.exec('apply schema main');
			await db.exec(`insert into t values (1, 'abc'), (2, 'ABC'), (3, 'abd')`);

			// Under BINARY only the exact-case match counts.
			const countMatches = async (): Promise<number> => {
				const out: Array<Record<string, unknown>> = [];
				for await (const r of db.eval(`select count(*) as n from t where name = 'ABC'`)) out.push(r as Record<string, unknown>);
				return Number(out[0].n);
			};
			expect(await countMatches(), 'BINARY: only exact-case match').to.equal(1);

			// Re-declare the column with COLLATE NOCASE (no other structural change).
			await db.exec(`declare schema main {
				table t { id INTEGER PRIMARY KEY, name TEXT COLLATE NOCASE }
			}`);

			// The differ detects the collation drift — and nothing structural.
			const declared = db.declaredSchemaManager.getDeclaredSchema('main')!;
			const diff = computeSchemaDiff(declared, collectSchemaCatalog(db, 'main'));
			expect(diff.tablesToAlter.length, 'collation drift produces exactly one alter').to.equal(1);
			const alter = diff.tablesToAlter[0];
			expect(alter.columnsToAdd, 'no column adds').to.deep.equal([]);
			expect(alter.columnsToDrop, 'no column drops').to.deep.equal([]);
			const colChange = alter.columnsToAlter.find(c => c.columnName.toLowerCase() === 'name');
			expect(colChange?.collation, 'declared NOCASE is the desired collation').to.equal('NOCASE');
			expect(colChange?.dataType, 'no type drift').to.be.undefined;
			expect(colChange?.notNull, 'no nullability drift').to.be.undefined;

			// The emitted migration carries the SET COLLATE verb.
			const ddl = generateMigrationDDL(diff, 'main');
			expect(ddl.some(s => /alter column .*name.* set collate nocase/i.test(s)), `expected SET COLLATE in: ${ddl.join(' | ')}`).to.be.true;

			await db.exec('apply schema main');

			// The live catalog converged: the column collation is now NOCASE…
			const nameCol = db.schemaManager.getTable('main', 't')!.columns.find(c => c.name.toLowerCase() === 'name')!;
			expect(nameCol.collation, 'column collation converged to NOCASE').to.equal('NOCASE');

			// …and the `=` semantics changed accordingly (case-insensitive now).
			expect(await countMatches(), 'NOCASE: case-insensitive match').to.equal(2);

			// Re-applying the same declaration is a no-op — no collation drift remains.
			const diff2 = computeSchemaDiff(
				db.declaredSchemaManager.getDeclaredSchema('main')!,
				collectSchemaCatalog(db, 'main'),
			);
			expect(diff2.tablesToAlter, 'idempotent re-apply produces no alter').to.deep.equal([]);
		} finally {
			await db.close();
		}
	});

	it('absent COLLATE and an explicit COLLATE BINARY are equal — no spurious diff', async function () {
		const db = new Database();
		try {
			// Apply with no COLLATE (defaults to BINARY).
			await db.exec(`declare schema main {
				table t { id INTEGER PRIMARY KEY, name TEXT }
			}`);
			await db.exec('apply schema main');

			// Re-declare with an explicit COLLATE BINARY — semantically identical, so
			// the differ must NOT churn a SET COLLATE.
			await db.exec(`declare schema main {
				table t { id INTEGER PRIMARY KEY, name TEXT COLLATE BINARY }
			}`);
			const diff = computeSchemaDiff(
				db.declaredSchemaManager.getDeclaredSchema('main')!,
				collectSchemaCatalog(db, 'main'),
			);
			expect(diff.tablesToAlter, 'BINARY == absent: no spurious collation alter').to.deep.equal([]);
		} finally {
			await db.close();
		}
	});

	it('a column collation change DOES move the schema hash (unlike a tag change)', async function () {
		const a = new Database();
		const b = new Database();
		try {
			await a.exec(`declare schema main {
				table t { id INTEGER PRIMARY KEY, name TEXT }
			}`);
			await b.exec(`declare schema main {
				table t { id INTEGER PRIMARY KEY, name TEXT COLLATE NOCASE }
			}`);
			const ha = computeSchemaHash(a.declaredSchemaManager.getDeclaredSchema('main')!);
			const hb = computeSchemaHash(b.declaredSchemaManager.getDeclaredSchema('main')!);
			expect(ha, 'collation is real schema — the hash must move').to.not.equal(hb);
		} finally {
			await a.close();
			await b.close();
		}
	});

	it('detects and converges a PRIMARY KEY column collation drift (re-keys the primary structure)', async function () {
		const db = new Database();
		try {
			// A text PRIMARY KEY column, declared BINARY (default).
			await db.exec(`declare schema main {
				table t { k TEXT PRIMARY KEY }
			}`);
			await db.exec('apply schema main');
			// Values distinct under BOTH collations so the PK re-key cannot collide.
			await db.exec(`insert into t values ('alpha'), ('Beta')`);

			// Re-declare the PK column with COLLATE NOCASE.
			await db.exec(`declare schema main {
				table t { k TEXT PRIMARY KEY COLLATE NOCASE }
			}`);

			// The differ detects the PK-column collation drift (membership-agnostic).
			const diff = computeSchemaDiff(
				db.declaredSchemaManager.getDeclaredSchema('main')!,
				collectSchemaCatalog(db, 'main'),
			);
			expect(diff.tablesToAlter.length, 'PK collation drift produces one alter').to.equal(1);
			const colChange = diff.tablesToAlter[0].columnsToAlter.find(c => c.columnName.toLowerCase() === 'k');
			expect(colChange?.collation, 'declared NOCASE is the desired PK collation').to.equal('NOCASE');

			await db.exec('apply schema main');

			// The live PK column converged…
			const kCol = db.schemaManager.getTable('main', 't')!.columns.find(c => c.name.toLowerCase() === 'k')!;
			expect(kCol.collation, 'PK column collation converged to NOCASE').to.equal('NOCASE');

			// …and the primary structure re-keyed: a case-only duplicate now collides.
			let collided = false;
			try {
				await db.exec(`insert into t values ('ALPHA')`);
			} catch {
				collided = true;
			}
			expect(collided, 'NOCASE PK rejects a case-only duplicate of an existing key').to.be.true;

			// Re-applying the same declaration is a no-op.
			const diff2 = computeSchemaDiff(
				db.declaredSchemaManager.getDeclaredSchema('main')!,
				collectSchemaCatalog(db, 'main'),
			);
			expect(diff2.tablesToAlter, 'idempotent re-apply produces no alter').to.deep.equal([]);
		} finally {
			await db.close();
		}
	});
});

// ============================================================================
// Materialized views — declarative round-trip, body-change rebuild, hash
// ============================================================================

describe('declarative-equivalence: materialized views', () => {
	it('MV body round-trips through declarative apply (create + refresh)', async function () {
		await runCase({
			name: 'mv-roundtrip-basic',
			directDDL: [
				'create table t (id integer primary key, x integer not null)',
				'create materialized view mv as select id, x from t',
			],
			declarativeBody: `table t { id INTEGER PRIMARY KEY, x INTEGER NOT NULL }

			materialized view mv as select id, x from t`,
			expectTables: ['t'],
			expectMaterializedViews: ['mv'],
			// MV is materialized empty at create time (t is empty); both paths
			// then INSERT + REFRESH symmetrically so the backing tables agree.
			postSetup: [
				'insert into t values (1, 10), (2, 20)',
				'refresh materialized view mv',
			],
			probes: [
				{ sql: 'select count(*) as n from mv', expect: { rows: [{ n: 2 }] } },
				{
					sql: 'select id, x from mv order by id',
					expect: { rows: [{ id: 1, x: 10 }, { id: 2, x: 20 }] },
				},
			],
		});
	});

	it('explicit column-list MV round-trips and renames the body columns', async function () {
		await runCase({
			name: 'mv-roundtrip-collist',
			directDDL: [
				'create table t (id integer primary key, x integer not null)',
				'create materialized view mv (a, b) as select id, x from t',
			],
			declarativeBody: `table t { id INTEGER PRIMARY KEY, x INTEGER NOT NULL }

			materialized view mv (a, b) as select id, x from t`,
			expectTables: ['t'],
			expectMaterializedViews: ['mv'],
			postSetup: [
				'insert into t values (1, 10), (2, 20)',
				'refresh materialized view mv',
			],
			probes: [
				{
					sql: 'select a, b from mv order by a',
					expect: { rows: [{ a: 1, b: 10 }, { a: 2, b: 20 }] },
				},
			],
		});
	});

	it('tagged MV round-trips and the schema hash is tag-invariant', async function () {
		await runCase({
			name: 'mv-roundtrip-tagged',
			directDDL: [
				'create table t (id integer primary key, x integer not null)',
				`create materialized view mv as select id, x from t with tags (owner = 'analytics')`,
			],
			declarativeBody: `table t { id INTEGER PRIMARY KEY, x INTEGER NOT NULL }

			materialized view mv as select id, x from t with tags (owner = 'analytics')`,
			expectTables: ['t'],
			// assertMaterializedViewSchemaEqual compares tags, so a dropped/garbled
			// tag would fail the round-trip here.
			expectMaterializedViews: ['mv'],
			probes: [
				{ sql: 'select count(*) as n from mv', expect: { rows: [{ n: 0 }] } },
			],
		});

		// Tags are non-behavioral metadata: a tagged MV and an otherwise-identical
		// untagged MV must hash the same, and re-applying the tagged schema is a no-op.
		const tagged = new Database();
		const untagged = new Database();
		try {
			await tagged.exec(`declare schema main {
				table t { id INTEGER PRIMARY KEY, x INTEGER NOT NULL }
				materialized view mv as select id, x from t with tags (owner = 'analytics')
			}`);
			await tagged.exec('apply schema main');
			await untagged.exec(`declare schema main {
				table t { id INTEGER PRIMARY KEY, x INTEGER NOT NULL }
				materialized view mv as select id, x from t
			}`);
			const hTagged = computeSchemaHash(tagged.declaredSchemaManager.getDeclaredSchema('main')!);
			const hUntagged = computeSchemaHash(untagged.declaredSchemaManager.getDeclaredSchema('main')!);
			expect(hTagged, 'tags must not perturb the schema hash').to.equal(hUntagged);

			const diff = computeSchemaDiff(
				tagged.declaredSchemaManager.getDeclaredSchema('main')!,
				collectSchemaCatalog(tagged, 'main'),
			);
			// A maintained table is a table now: an unchanged tagged MV produces no
			// re-attach (`set maintained as`) and no drop.
			expect(diff.tablesToAlter.find(a => a.tableName === 'mv')?.setMaintained, 'tagged unchanged MV should not re-attach').to.be.undefined;
			expect(diff.tablesToDrop, 'tagged unchanged MV should not drop').to.deep.equal([]);
		} finally {
			await tagged.close();
			await untagged.close();
		}
	});

	it('a sugar MV re-attached via the verb (same body) records the IMPLICIT form, so the unchanged declaration does not churn', async function () {
		// Regression (ticket maintained-reattach-columns-parity): the re-attach verb
		// used to record the EXPLICIT table column names, flipping a sugar MV's recorded
		// `derivation.columns` from implicit→explicit and diverging its bodyHash from the
		// (implicit) declared form. The differ papered over that with a dual-hash
		// tolerance (`maintainedBodyMatches` also tried the live column names); both are
		// now gone — the verb records the implicit form, matching create-sugar, so a
		// single as-authored hash stays idempotent.
		const db = new Database();
		try {
			await db.exec(`declare schema main {
				table t { id INTEGER PRIMARY KEY, x INTEGER NOT NULL }
				materialized view mv as select id, x from t
			}`);
			await db.exec('apply schema main');
			const createHash = db.schemaManager.getMaintainedTable('main', 'mv')!.derivation.bodyHash;

			// Force a re-attach through the verb with the SAME body. The verb now records
			// the implicit form (no rename list), so the recorded bodyHash is unchanged —
			// before the fix it recorded the explicit (id, x) names and the hash diverged.
			await db.exec('alter table mv set maintained as select id, x from t');
			const reattachHash = db.schemaManager.getMaintainedTable('main', 'mv')!.derivation.bodyHash;
			expect(reattachHash, 'verb re-attach records implicit ⇒ bodyHash unchanged').to.equal(createHash);

			// Diffing the UNCHANGED sugar-MV declaration against the re-attached catalog
			// must yield no re-attach and no drop — proving the differ no longer churns
			// now that the verb's record matches the declared implicit form.
			const diff = computeSchemaDiff(
				db.declaredSchemaManager.getDeclaredSchema('main')!,
				collectSchemaCatalog(db, 'main'),
			);
			expect(diff.tablesToAlter.find(a => a.tableName === 'mv')?.setMaintained, 'unchanged declaration ⇒ no re-attach after a verb re-attach').to.be.undefined;
			expect(diff.tablesToDrop, 'unchanged declaration ⇒ no drop').to.deep.equal([]);
		} finally {
			await db.close();
		}
	});

	it('changing the MV body triggers a re-attach refresh on re-apply (not a recreate)', async function () {
		const db = new Database();
		try {
			await db.exec(`declare schema main {
				table t { id INTEGER PRIMARY KEY, x INTEGER NOT NULL, y INTEGER NOT NULL }
				materialized view mv as select id, x from t
			}`);
			await db.exec('apply schema main');
			await db.exec('insert into t values (1, 10, 100)');
			await db.exec('refresh materialized view mv');

			// Body A exposes column x.
			const beforeRows: Array<Record<string, unknown>> = [];
			for await (const r of db.eval('select id, x from mv')) beforeRows.push(r);
			expect(beforeRows).to.deep.equal([{ id: 1, x: 10 }]);
			const beforeHash = db.schemaManager.getMaintainedTable('main', 'mv')!.derivation.bodyHash;

			// Re-declare with a content-changing body that PRESERVES the output shape
			// (column still named `x`, now fed by y). A shape-preserving body change is
			// a single re-attach (`set maintained as`) — a content refresh, NOT a
			// drop+recreate. (An output-column RENAME instead changes the shape; the
			// plan-free differ can't detect that on a sugar MV, so the verb-side
			// reshape-on-attach handles it — see the sibling test below.)
			await db.exec(`declare schema main {
				table t { id INTEGER PRIMARY KEY, x INTEGER NOT NULL, y INTEGER NOT NULL }
				materialized view mv as select id, y as x from t
			}`);
			const reattachDiff = computeSchemaDiff(
				db.declaredSchemaManager.getDeclaredSchema('main')!,
				collectSchemaCatalog(db, 'main'),
			);
			const mvAlter = reattachDiff.tablesToAlter.find(a => a.tableName === 'mv');
			expect(mvAlter?.setMaintained, 'body change ⇒ re-attach').to.not.be.undefined;
			expect(mvAlter?.dropMaintained, 'shape preserved ⇒ no detach leg').to.be.undefined;
			expect(reattachDiff.tablesToDrop, 'no drop of the maintained table').to.deep.equal([]);
			await db.exec('apply schema main');

			// Refresh happened: column `x` now carries y's value (content re-derived
			// from current t); the table incarnation survived.
			const afterRows: Array<Record<string, unknown>> = [];
			for await (const r of db.eval('select id, x from mv')) afterRows.push(r);
			expect(afterRows).to.deep.equal([{ id: 1, x: 100 }]);

			const afterHash = db.schemaManager.getMaintainedTable('main', 'mv')!.derivation.bodyHash;
			expect(afterHash, 'bodyHash should change when the body changes').to.not.equal(beforeHash);

			// Idempotent: re-diffing the just-applied schema wants no further re-attach.
			const converged = computeSchemaDiff(
				db.declaredSchemaManager.getDeclaredSchema('main')!,
				collectSchemaCatalog(db, 'main'),
			);
			expect(converged.tablesToAlter.find(a => a.tableName === 'mv'), 'converged ⇒ no re-attach').to.be.undefined;
		} finally {
			await db.close();
		}
	});

	it('changing only the MV insert-defaults clause triggers a re-attach on re-apply', async function () {
		// Regression (ticket view-insert-defaults-declarative-drift-undetected):
		// the body hash used to cover `astToString(select)` only, so a clause-only
		// change diffed empty and write-through kept supplying the OLD default.
		const db = new Database();
		try {
			await db.exec(`declare schema main {
				table t { id INTEGER PRIMARY KEY, x INTEGER NOT NULL, created INTEGER NOT NULL }
				materialized view mv as select id, x from t with defaults (created = 111)
			}`);
			await db.exec('apply schema main');
			await db.exec('insert into mv values (1, 10)');
			const before: Array<Record<string, unknown>> = [];
			for await (const r of db.eval('select created from t where id = 1')) before.push(r);
			expect(before).to.deep.equal([{ created: 111 }]);
			const beforeHash = db.schemaManager.getMaintainedTable('main', 'mv')!.derivation.bodyHash;

			// Same body, clause 111 → 222: must surface as a re-attach (`set maintained as`).
			await db.exec(`declare schema main {
				table t { id INTEGER PRIMARY KEY, x INTEGER NOT NULL, created INTEGER NOT NULL }
				materialized view mv as select id, x from t with defaults (created = 222)
			}`);
			const diff = computeSchemaDiff(
				db.declaredSchemaManager.getDeclaredSchema('main')!,
				collectSchemaCatalog(db, 'main'),
			);
			const mvAlter = diff.tablesToAlter.find(a => a.tableName === 'mv');
			expect(mvAlter?.setMaintained, 'clause-only change ⇒ re-attach').to.not.be.undefined;
			expect(mvAlter?.dropMaintained, 'same shape ⇒ no detach leg').to.be.undefined;
			expect(diff.tablesToDrop, 'no drop of the maintained table').to.deep.equal([]);

			await db.exec('apply schema main');
			await db.exec('insert into mv values (2, 20)');
			const after: Array<Record<string, unknown>> = [];
			for await (const r of db.eval('select created from t where id = 2')) after.push(r);
			expect(after, 'write-through must use the NEW default').to.deep.equal([{ created: 222 }]);

			const afterHash = db.schemaManager.getMaintainedTable('main', 'mv')!.derivation.bodyHash;
			expect(afterHash, 'bodyHash should change when the clause changes').to.not.equal(beforeHash);

			// Converged: re-diff yields no create and no drop.
			const diff2 = computeSchemaDiff(
				db.declaredSchemaManager.getDeclaredSchema('main')!,
				collectSchemaCatalog(db, 'main'),
			);
			expect(diff2.tablesToAlter.find(a => a.tableName === 'mv'), 'converged ⇒ no re-attach').to.be.undefined;
			expect(diff2.tablesToDrop).to.deep.equal([]);
		} finally {
			await db.close();
		}
	});

	it('an explicit rename-list change on a sugar MV applies via the carried (cols) re-attach and converges', async function () {
		// The explicit rename list (`mv (a, b)`) is part of the canonical definition
		// the body hash covers, so changing it (b → c) drifts the hash and the differ
		// emits a re-attach. The differ now carries the DECLARED rename list onto the
		// emitted `set maintained` op (ticket
		// maintained-reattach-explicit-rename-list-reshape), so `generateMigrationDDL`
		// renders `set maintained (a, c) as …`. The verb (prereq
		// maintained-set-maintained-rename-list-verb) positionally relabels the body to
		// (a, c) and renames the backing `b → c` IN PLACE — so a single `apply schema`
		// CONVERGES (no drop+recreate, no detach leg) where it previously could only
		// reshape to the body's natural names (going implicit) and never converge.
		const db = new Database();
		try {
			await db.exec(`declare schema main {
				table t { id INTEGER PRIMARY KEY, x INTEGER NOT NULL }
				materialized view mv (a, b) as select id, x from t
			}`);
			await db.exec('apply schema main');
			await db.exec('insert into t values (1, 10), (2, 20)');

			await db.exec(`declare schema main {
				table t { id INTEGER PRIMARY KEY, x INTEGER NOT NULL }
				materialized view mv (a, c) as select id, x from t
			}`);
			const diff = computeSchemaDiff(
				db.declaredSchemaManager.getDeclaredSchema('main')!,
				collectSchemaCatalog(db, 'main'),
			);
			// The differ recognizes the rename-list change as an in-place re-attach that
			// CARRIES the declared list — no detach leg, no drop+recreate.
			const mvAlter = diff.tablesToAlter.find(a => a.tableName === 'mv');
			expect(mvAlter?.setMaintained?.columns, 'carries the declared rename list').to.deep.equal(['a', 'c']);
			expect(mvAlter?.dropMaintained, 'in-place reshape ⇒ no detach leg').to.be.undefined;
			expect(diff.tablesToDrop, 'no drop of the maintained table').to.deep.equal([]);
			expect(diff.tablesToCreate, 'no recreate of the maintained table').to.deep.equal([]);

			// One apply relabels the backing `b → c` in place and re-records the list.
			await db.exec('apply schema main');
			const mv = db.schemaManager.getMaintainedTable('main', 'mv')!;
			expect(mv.columns.map(c => c.name), 'backing relabeled to (a, c)').to.deep.equal(['a', 'c']);
			expect(mv.derivation.columns, 'records the authored list (a, c)').to.deep.equal(['a', 'c']);

			// Rows survive the relabel with their values intact (a rename, not a rebuild).
			const rows: Array<Record<string, unknown>> = [];
			for await (const r of db.eval('select a, c from mv order by a')) rows.push(r);
			expect(rows, 'rows preserved through the relabel').to.deep.equal([
				{ a: 1, c: 10 }, { a: 2, c: 20 },
			]);

			// Maintenance is live on the relabeled backing.
			await db.exec('insert into t values (3, 30)');
			const after: Array<Record<string, unknown>> = [];
			for await (const r of db.eval('select c from mv where a = 3')) after.push(r);
			expect(after).to.deep.equal([{ c: 30 }]);

			// Converged: re-diffing the just-applied schema wants no further re-attach.
			const converged = computeSchemaDiff(
				db.declaredSchemaManager.getDeclaredSchema('main')!,
				collectSchemaCatalog(db, 'main'),
			);
			expect(converged.tablesToAlter.find(a => a.tableName === 'mv'), 'converged ⇒ no further re-attach').to.be.undefined;
			expect(converged.tablesToDrop).to.deep.equal([]);
		} finally {
			await db.close();
		}
	});

	it('an output-column RENAME on a sugar (implicit) MV applies via reshape-on-attach and converges', async function () {
		// The implicit sibling of the explicit rename-list limitation above (ticket
		// maintained-reattach-implicit-reshape): a sugar MV normalizes with
		// `columns: []` (the body owns the shape), so the plan-free differ cannot
		// see that the renamed output column needs a reshape — it compares only
		// bodyHash and emits a plain `set maintained as`. The verb's
		// reshape-on-attach now reshapes the backing to follow the body (rename
		// x → renamed, values preserved) where it previously errored at the strict
		// attach shape check.
		const db = new Database();
		try {
			await db.exec(`declare schema main {
				table t { id INTEGER PRIMARY KEY, x INTEGER NOT NULL }
				materialized view mv as select id, x from t
			}`);
			await db.exec('apply schema main');
			await db.exec('insert into t values (1, 10), (2, 20)');

			// Re-declare with the output column RENAMED. The differ sees a bodyHash
			// drift and emits a single re-attach — no detach leg, no drop.
			await db.exec(`declare schema main {
				table t { id INTEGER PRIMARY KEY, x INTEGER NOT NULL }
				materialized view mv as select id, x as renamed from t
			}`);
			const diff = computeSchemaDiff(
				db.declaredSchemaManager.getDeclaredSchema('main')!,
				collectSchemaCatalog(db, 'main'),
			);
			const mvAlter = diff.tablesToAlter.find(a => a.tableName === 'mv');
			expect(mvAlter?.setMaintained, 'output-column rename ⇒ re-attach').to.not.be.undefined;
			expect(mvAlter?.dropMaintained, 'no detach leg').to.be.undefined;
			expect(diff.tablesToDrop, 'no drop of the maintained table').to.deep.equal([]);

			// Applies cleanly (errored before reshape-on-attach landed).
			await db.exec('apply schema main');

			const mv = db.schemaManager.getMaintainedTable('main', 'mv')!;
			expect(mv.columns.map(c => c.name), 'backing reshaped to the renamed output').to.deep.equal(['id', 'renamed']);
			expect(mv.derivation.columns, 'still recorded implicit').to.be.undefined;
			const rows: Array<Record<string, unknown>> = [];
			for await (const r of db.eval('select id, renamed from mv order by id')) rows.push(r);
			expect(rows, 'values preserved through the relabel').to.deep.equal([
				{ id: 1, renamed: 10 }, { id: 2, renamed: 20 },
			]);

			// Maintenance is live on the reshaped backing.
			await db.exec('insert into t values (3, 30)');
			const after: Array<Record<string, unknown>> = [];
			for await (const r of db.eval('select renamed from mv where id = 3')) after.push(r);
			expect(after).to.deep.equal([{ renamed: 30 }]);

			// Converged: re-diffing the just-applied schema wants nothing further.
			const converged = computeSchemaDiff(
				db.declaredSchemaManager.getDeclaredSchema('main')!,
				collectSchemaCatalog(db, 'main'),
			);
			expect(converged.tablesToAlter.find(a => a.tableName === 'mv'), 'converged ⇒ no further alter').to.be.undefined;
			expect(converged.tablesToDrop).to.deep.equal([]);
		} finally {
			await db.close();
		}
	});

	it('re-applying an unchanged MV is a no-op and the schema hash is stable', async function () {
		const db = new Database();
		try {
			const declSql = `declare schema main {
				table t { id INTEGER PRIMARY KEY, x INTEGER NOT NULL }
				materialized view mv as select id, x from t
			}`;
			await db.exec(declSql);
			await db.exec('apply schema main');

			const declared = db.declaredSchemaManager.getDeclaredSchema('main')!;
			const hash1 = computeSchemaHash(declared);

			// Diff the declared schema against the freshly-applied catalog: an
			// unchanged MV body yields no create and no drop.
			const catalog = collectSchemaCatalog(db, 'main');
			const diff = computeSchemaDiff(declared, catalog);
			expect(diff.tablesToAlter.find(a => a.tableName === 'mv'), 'unchanged MV should not re-attach').to.be.undefined;
			expect(diff.tablesToDrop, 'unchanged MV should not be dropped').to.deep.equal([]);

			// Re-declaring the identical schema yields an identical hash.
			await db.exec(declSql);
			const hash2 = computeSchemaHash(db.declaredSchemaManager.getDeclaredSchema('main')!);
			expect(hash2, 'schema hash should be stable across re-emit of an unchanged MV').to.equal(hash1);

			// A changed MV body changes the hash.
			await db.exec(`declare schema main {
				table t { id INTEGER PRIMARY KEY, x INTEGER NOT NULL }
				materialized view mv as select id, x + 1 from t
			}`);
			const hash3 = computeSchemaHash(db.declaredSchemaManager.getDeclaredSchema('main')!);
			expect(hash3, 'changing the MV body should change the schema hash').to.not.equal(hash1);
		} finally {
			await db.close();
		}
	});

	it('a backing-module change on a maintained table schedules a destructive drop+recreate', async function () {
		// A maintained table is a TABLE now, but the catalog DOES carry its normalized
		// backing module (CatalogTable.maintained.backingModuleName/Args). A both-
		// maintained name-match whose declared module moves is an incarnation-minting
		// relocation with no in-place primitive, so the differ schedules a destructive
		// drop+recreate (gated at apply on allow_destructive) — NOT a body re-attach.
		const db = new Database();
		db.registerModule('mem2', new MemoryTableModule());
		try {
			await db.exec(`declare schema main {
				table t { id INTEGER PRIMARY KEY, x INTEGER NOT NULL }
				materialized view mv as select id, x from t
			}`);
			await db.exec('apply schema main');

			// Same body, new backing module: detected as a destructive move.
			await db.exec(`declare schema main {
				table t { id INTEGER PRIMARY KEY, x INTEGER NOT NULL }
				materialized view mv using mem2() as select id, x from t
			}`);
			const diff = computeSchemaDiff(
				db.declaredSchemaManager.getDeclaredSchema('main')!,
				collectSchemaCatalog(db, 'main'),
			);
			expect(diff.tablesToAlter.find(a => a.tableName === 'mv'), 'no alter — the recreate subsumes it').to.be.undefined;
			expect(diff.tablesToDrop, 'mv dropped for the recreate').to.deep.equal(['mv']);
			expect(diff.tablesToCreate.map(c => c.sql).some(s => /create\s+materialized\s+view\s+mv\b/i.test(s) && /mem2/i.test(s)), 'mv recreated using mem2').to.be.true;
			expect(diff.maintainedModuleMigrations, 'one module migration recorded').to.deep.equal([
				{ name: 'mv', fromModule: 'memory', toModule: 'mem2' },
			]);
		} finally {
			await db.close();
		}
	});

	it('declaring `using memory()` / `using mem()` against a default-backed MV is no-drift', async function () {
		const db = new Database();
		try {
			await db.exec(`declare schema main {
				table t { id INTEGER PRIMARY KEY, x INTEGER NOT NULL }
				materialized view mv as select id, x from t
			}`);
			await db.exec('apply schema main');

			for (const spelling of ['using memory()', 'using mem()', 'using memory', '']) {
				await db.exec(`declare schema main {
					table t { id INTEGER PRIMARY KEY, x INTEGER NOT NULL }
					materialized view mv ${spelling} as select id, x from t
				}`);
				const diff = computeSchemaDiff(
					db.declaredSchemaManager.getDeclaredSchema('main')!,
					collectSchemaCatalog(db, 'main'),
				);
				expect(diff.tablesToAlter.find(a => a.tableName === 'mv'), `'${spelling}' must not re-attach`).to.be.undefined;
				expect(diff.tablesToDrop, `'${spelling}' must not drop`).to.deep.equal([]);
			}
		} finally {
			await db.close();
		}
	});

	it('a backing-module ARGS change on a maintained table schedules a destructive drop+recreate', async function () {
		// Companion to the module-name move: the args half drifts alone (name
		// unchanged). canonicalBackingModuleArgs renders k='a' vs k='b' distinctly, so
		// it is detected and migrated just like a name change.
		const db = new Database();
		db.registerModule('mem2', new MemoryTableModule());
		try {
			await db.exec(`declare schema main {
				table t { id INTEGER PRIMARY KEY, x INTEGER NOT NULL }
				materialized view mv using mem2 (k = 'a') as select id, x from t
			}`);
			await db.exec('apply schema main');

			// Changed arg value ⇒ destructive move (name unchanged, args drift).
			await db.exec(`declare schema main {
				table t { id INTEGER PRIMARY KEY, x INTEGER NOT NULL }
				materialized view mv using mem2 (k = 'b') as select id, x from t
			}`);
			const diff = computeSchemaDiff(
				db.declaredSchemaManager.getDeclaredSchema('main')!,
				collectSchemaCatalog(db, 'main'),
			);
			expect(diff.tablesToAlter.find(a => a.tableName === 'mv'), 'no alter — recreate subsumes it').to.be.undefined;
			expect(diff.tablesToDrop, 'mv dropped for the recreate').to.deep.equal(['mv']);
			expect(diff.tablesToCreate.map(c => c.sql).some(s => /create\s+materialized\s+view\s+mv\b/i.test(s) && /mem2/i.test(s)), 'mv recreated using mem2').to.be.true;
			expect(diff.maintainedModuleMigrations, 'one args-only module migration recorded').to.deep.equal([
				{ name: 'mv', fromModule: `mem2(k="a")`, toModule: `mem2(k="b")` },
			]);
		} finally {
			await db.close();
		}
	});

	it('apply WITHOUT allow_destructive refuses a backing-module move and leaves the backing unchanged', async function () {
		const db = new Database();
		db.registerModule('mem2', new MemoryTableModule());
		try {
			await db.exec(`declare schema main {
				table t { id INTEGER PRIMARY KEY, x INTEGER NOT NULL }
				materialized view mv as select id, x from t
			}`);
			await db.exec('apply schema main');
			await db.exec('insert into t values (1, 10), (2, 20)');

			// Re-declare with a moved backing module, then apply without the ack.
			await db.exec(`declare schema main {
				table t { id INTEGER PRIMARY KEY, x INTEGER NOT NULL }
				materialized view mv using mem2() as select id, x from t
			}`);

			let threw: Error | undefined;
			try {
				await db.exec('apply schema main');
			} catch (e) {
				threw = e as Error;
			}
			expect(threw, 'apply should throw without allow_destructive').to.not.be.undefined;
			expect(threw!.message, 'sited error mentions allow_destructive').to.match(/allow_destructive/i);
			expect(threw!.message, 'names the maintained table').to.match(/\bmv\b/);

			// No partial migration: the live backing is still the memory default.
			const live = collectSchemaCatalog(db, 'main').tables.find(t => t.name === 'mv');
			expect(live?.maintained, 'mv is still maintained').to.not.be.undefined;
			expect(live!.maintained!.backingModuleName, 'still on the memory default backing').to.be.undefined;
		} finally {
			await db.close();
		}
	});

	it('apply WITH allow_destructive migrates the backing (new incarnation, rows re-materialized, idempotent re-diff)', async function () {
		const db = new Database();
		db.registerModule('mem2', new MemoryTableModule());
		try {
			await db.exec(`declare schema main {
				table t { id INTEGER PRIMARY KEY, x INTEGER NOT NULL }
				materialized view mv as select id, x from t
			}`);
			await db.exec('apply schema main');
			await db.exec('insert into t values (1, 10), (2, 20)');

			// Capture the MV lifecycle events that prove a new incarnation.
			const events: string[] = [];
			const unsub = db.schemaManager.getChangeNotifier().addListener(ev => {
				if (ev.type === 'materialized_view_removed' || ev.type === 'materialized_view_added') {
					if (ev.objectName.toLowerCase() === 'mv') events.push(ev.type);
				}
			});

			await db.exec(`declare schema main {
				table t { id INTEGER PRIMARY KEY, x INTEGER NOT NULL }
				materialized view mv using mem2() as select id, x from t
			}`);
			await db.exec('apply schema main options (allow_destructive = true)');
			unsub();

			// New incarnation: removed then re-added, in that order.
			expect(events, 'fires materialized_view_removed then _added').to.deep.equal([
				'materialized_view_removed', 'materialized_view_added',
			]);

			// Live backing is now mem2.
			const live = collectSchemaCatalog(db, 'main').tables.find(t => t.name === 'mv');
			expect(live!.maintained!.backingModuleName, 'mv now backed by mem2').to.equal('mem2');

			// Rows re-materialized from current sources.
			const rows: Array<Record<string, unknown>> = [];
			for await (const r of db.eval('select id, x from mv order by id')) rows.push(r);
			expect(rows, 'rows re-derived into the new backing').to.deep.equal([{ id: 1, x: 10 }, { id: 2, x: 20 }]);

			// Idempotent: re-diffing the same declaration now matches the live mem2 backing.
			const diff2 = computeSchemaDiff(
				db.declaredSchemaManager.getDeclaredSchema('main')!,
				collectSchemaCatalog(db, 'main'),
			);
			expect(diff2.maintainedModuleMigrations, 'no second migration').to.deep.equal([]);
			expect(diff2.tablesToDrop, 'no second drop').to.deep.equal([]);
			expect(diff2.tablesToCreate, 'no second create').to.deep.equal([]);
		} finally {
			await db.close();
		}
	});

	it('a maintained-table RENAME + backing-module move in one apply cooperate (rename retargets, recreate-in-place under new name)', async function () {
		// Regression: a maintained table that is BOTH renamed (via a
		// `quereus.previous_name` hint) AND has its backing module moved in the same
		// apply previously emitted conflicting DDL — the table RENAME landed first, so
		// the module-move's `DROP mv` no-op'd and `CREATE mv2` collided ("already
		// exists"). The fix keeps the RENAME op (dependents retarget) but drops the NEW
		// declared name `mv2` so the recreate lands in-place. A dependent plain view `v`
		// over the renamed+moved table pins the retargeting.
		const db = new Database();
		db.registerModule('mem2', new MemoryTableModule());
		try {
			await db.exec(`declare schema main {
				table t { id INTEGER PRIMARY KEY, x INTEGER NOT NULL }
				materialized view mv as select id, x from t
				view v as select id, x from mv
			}`);
			await db.exec('apply schema main');
			await db.exec('insert into t values (1, 10), (2, 20)');

			// Same body, renamed (mv→mv2 via previous_name hint) AND moved backing module,
			// with the dependent view retargeted to the new name.
			await db.exec(`declare schema main {
				table t { id INTEGER PRIMARY KEY, x INTEGER NOT NULL }
				materialized view mv2 using mem2() as select id, x from t
					with tags ("quereus.previous_name" = 'mv')
				view v as select id, x from mv2
			}`);
			const diff = computeSchemaDiff(
				db.declaredSchemaManager.getDeclaredSchema('main')!,
				collectSchemaCatalog(db, 'main'),
			);
			// The table RENAME op survives (dependents retarget via ALTER … RENAME).
			expect(
				diff.renames.some(r => r.kind === 'table' && r.oldName.toLowerCase() === 'mv' && r.newName.toLowerCase() === 'mv2'),
				'mv→mv2 table rename preserved',
			).to.be.true;
			// The drop targets the NEW name (the just-renamed live incarnation), not the old.
			expect(diff.tablesToDrop, 'drop targets the new declared name mv2').to.deep.equal(['mv2']);
			expect(
				diff.tablesToCreate.map(c => c.sql).some(s => /create\s+materialized\s+view\s+mv2\b/i.test(s) && /mem2/i.test(s)),
				'mv2 recreated using mem2',
			).to.be.true;
			expect(diff.maintainedModuleMigrations, 'one module migration recorded under the new name').to.deep.equal([
				{ name: 'mv2', fromModule: 'memory', toModule: 'mem2' },
			]);

			// End-to-end: the destructive apply renames-then-recreates-in-place, the rows
			// re-materialize under mv2, and the dependent view stays intact (retargeted).
			await db.exec('apply schema main options (allow_destructive = true)');

			const live = collectSchemaCatalog(db, 'main').tables.find(t => t.name === 'mv2');
			expect(live!.maintained!.backingModuleName, 'mv2 now backed by mem2').to.equal('mem2');

			const mvRows: Array<Record<string, unknown>> = [];
			for await (const r of db.eval('select id, x from mv2 order by id')) mvRows.push(r);
			expect(mvRows, 'mv2 rows re-derived into the new backing').to.deep.equal([{ id: 1, x: 10 }, { id: 2, x: 20 }]);

			const vRows: Array<Record<string, unknown>> = [];
			for await (const r of db.eval('select id, x from v order by id')) vRows.push(r);
			expect(vRows, 'dependent view v retargeted to mv2 and still correct').to.deep.equal([{ id: 1, x: 10 }, { id: 2, x: 20 }]);
		} finally {
			await db.close();
		}
	});

	it('a backing-module move AND a body change together take ONE drop+recreate (no separate re-attach)', async function () {
		const db = new Database();
		db.registerModule('mem2', new MemoryTableModule());
		try {
			await db.exec(`declare schema main {
				table t { id INTEGER PRIMARY KEY, x INTEGER NOT NULL }
				materialized view mv as select id, x from t
			}`);
			await db.exec('apply schema main');

			// Both the backing module AND the body change in one re-declaration.
			await db.exec(`declare schema main {
				table t { id INTEGER PRIMARY KEY, x INTEGER NOT NULL }
				materialized view mv using mem2() as select id, x + 1 from t
			}`);
			const diff = computeSchemaDiff(
				db.declaredSchemaManager.getDeclaredSchema('main')!,
				collectSchemaCatalog(db, 'main'),
			);
			// The recreate (new module + new body) subsumes the body re-attach: exactly
			// one migration, the drop+recreate, and NO `set maintained as` alter for mv.
			expect(diff.maintainedModuleMigrations.length, 'one migration only').to.equal(1);
			expect(diff.tablesToDrop, 'mv dropped once').to.deep.equal(['mv']);
			expect(diff.tablesToCreate.map(c => c.sql).some(s => /create\s+materialized\s+view\s+mv\b/i.test(s) && /mem2/i.test(s)), 'recreate carries new module').to.be.true;
			expect(diff.tablesToAlter.find(a => a.tableName === 'mv'), 'no separate re-attach alter for mv').to.be.undefined;
		} finally {
			await db.close();
		}
	});

	it('a backing-module move on a DECLARED-SHAPE maintained table migrates (recreate via create table … maintained as)', async function () {
		// The MV-sugar form is covered above; this exercises the other maintained
		// surface — `table … using <mod> (columns) maintained as <body>` (the declare-
		// schema grammar puts `using` before the column list) — which sets the same
		// module signal before the MV-sugar branch split and routes through
		// `createTableToString` (not the `materialized view` sugar) for its recreate.
		const db = new Database();
		db.registerModule('mem2', new MemoryTableModule());
		try {
			await db.exec(`declare schema main {
				table t { id INTEGER PRIMARY KEY, x INTEGER NOT NULL }
				table mvt (id INTEGER PRIMARY KEY, x INTEGER NOT NULL) maintained as select id, x from t
			}`);
			await db.exec('apply schema main');
			await db.exec('insert into t values (1, 10), (2, 20)');

			// Same shape + body, moved backing module.
			await db.exec(`declare schema main {
				table t { id INTEGER PRIMARY KEY, x INTEGER NOT NULL }
				table mvt using mem2() (id INTEGER PRIMARY KEY, x INTEGER NOT NULL) maintained as select id, x from t
			}`);
			const diff = computeSchemaDiff(
				db.declaredSchemaManager.getDeclaredSchema('main')!,
				collectSchemaCatalog(db, 'main'),
			);
			expect(diff.maintainedModuleMigrations, 'one migration recorded for the declared-shape table').to.deep.equal([
				{ name: 'mvt', fromModule: 'memory', toModule: 'mem2' },
			]);
			expect(diff.tablesToDrop, 'mvt dropped for the recreate').to.deep.equal(['mvt']);
			// Recreate renders the declared-shape `create table … maintained as` form
			// (NOT the MV-sugar) and carries the moved module.
			expect(diff.tablesToCreate.map(c => c.sql).some(s => /create\s+table\s+(?:"mvt"|mvt)\b/i.test(s) && /maintained\s+as/i.test(s) && /mem2/i.test(s)),
				'recreate is a create-table-maintained-as carrying mem2').to.be.true;
			expect(diff.tablesToAlter.find(a => a.tableName === 'mvt'), 'no orphaned alter for mvt').to.be.undefined;

			// End-to-end gate-on apply migrates and re-materializes the rows.
			await db.exec('apply schema main options (allow_destructive = true)');
			const live = collectSchemaCatalog(db, 'main').tables.find(t => t.name === 'mvt');
			expect(live!.maintained!.backingModuleName, 'mvt now backed by mem2').to.equal('mem2');
			const rows: Array<Record<string, unknown>> = [];
			for await (const r of db.eval('select id, x from mvt order by id')) rows.push(r);
			expect(rows, 'rows re-derived into the new backing').to.deep.equal([{ id: 1, x: 10 }, { id: 2, x: 20 }]);
		} finally {
			await db.close();
		}
	});

	it('a DECLARED-SHAPE maintained-table RENAME + backing-module move in one apply cooperate', async function () {
		// Shape-agnostic counterpart to the MV-sugar cooperate test: the rename-
		// coincident drop-the-new-name fix only touches the dropped NAME, not the
		// recreate render, so the declared-shape surface (`create table … maintained
		// as`) must behave identically when renamed + moved together.
		const db = new Database();
		db.registerModule('mem2', new MemoryTableModule());
		try {
			await db.exec(`declare schema main {
				table t { id INTEGER PRIMARY KEY, x INTEGER NOT NULL }
				table mvt (id INTEGER PRIMARY KEY, x INTEGER NOT NULL) maintained as select id, x from t
			}`);
			await db.exec('apply schema main');
			await db.exec('insert into t values (1, 10), (2, 20)');

			await db.exec(`declare schema main {
				table t { id INTEGER PRIMARY KEY, x INTEGER NOT NULL }
				table mvt2 using mem2() (id INTEGER PRIMARY KEY, x INTEGER NOT NULL) maintained as select id, x from t
					with tags ("quereus.previous_name" = 'mvt')
			}`);
			const diff = computeSchemaDiff(
				db.declaredSchemaManager.getDeclaredSchema('main')!,
				collectSchemaCatalog(db, 'main'),
			);
			expect(
				diff.renames.some(r => r.kind === 'table' && r.oldName.toLowerCase() === 'mvt' && r.newName.toLowerCase() === 'mvt2'),
				'mvt→mvt2 table rename preserved',
			).to.be.true;
			expect(diff.tablesToDrop, 'drop targets the new declared name mvt2').to.deep.equal(['mvt2']);
			expect(
				diff.tablesToCreate.map(c => c.sql).some(s => /create\s+table\s+(?:"mvt2"|mvt2)\b/i.test(s) && /maintained\s+as/i.test(s) && /mem2/i.test(s)),
				'recreate is a create-table-maintained-as carrying mem2 under the new name',
			).to.be.true;
			expect(diff.maintainedModuleMigrations, 'one module migration recorded under the new name').to.deep.equal([
				{ name: 'mvt2', fromModule: 'memory', toModule: 'mem2' },
			]);

			await db.exec('apply schema main options (allow_destructive = true)');
			const live = collectSchemaCatalog(db, 'main').tables.find(t => t.name === 'mvt2');
			expect(live!.maintained!.backingModuleName, 'mvt2 now backed by mem2').to.equal('mem2');
			const rows: Array<Record<string, unknown>> = [];
			for await (const r of db.eval('select id, x from mvt2 order by id')) rows.push(r);
			expect(rows, 'rows re-derived into the new backing under the new name').to.deep.equal([{ id: 1, x: 10 }, { id: 2, x: 20 }]);
		} finally {
			await db.close();
		}
	});

	it('a dependent MATERIALIZED VIEW over a renamed+moved maintained table retargets and stays correct', async function () {
		// The MV-sugar cooperate test pins a dependent PLAIN view; this pins a dependent
		// MATERIALIZED view (mvdep over mv) across the same rename+module-move so the
		// retarget machinery is exercised for a maintained dependent, not just a data-less
		// plain view.
		const db = new Database();
		db.registerModule('mem2', new MemoryTableModule());
		try {
			await db.exec(`declare schema main {
				table t { id INTEGER PRIMARY KEY, x INTEGER NOT NULL }
				materialized view mv as select id, x from t
				materialized view mvdep as select id, x from mv
			}`);
			await db.exec('apply schema main');
			await db.exec('insert into t values (1, 10), (2, 20)');

			await db.exec(`declare schema main {
				table t { id INTEGER PRIMARY KEY, x INTEGER NOT NULL }
				materialized view mv2 using mem2() as select id, x from t
					with tags ("quereus.previous_name" = 'mv')
				materialized view mvdep as select id, x from mv2
			}`);
			await db.exec('apply schema main options (allow_destructive = true)');

			const live = collectSchemaCatalog(db, 'main').tables.find(t => t.name === 'mv2');
			expect(live!.maintained!.backingModuleName, 'mv2 now backed by mem2').to.equal('mem2');

			const depRows: Array<Record<string, unknown>> = [];
			for await (const r of db.eval('select id, x from mvdep order by id')) depRows.push(r);
			expect(depRows, 'dependent MV retargeted to mv2 and still correct').to.deep.equal([{ id: 1, x: 10 }, { id: 2, x: 20 }]);
		} finally {
			await db.close();
		}
	});
});

// ============================================================================
// In-place tag changes on views / materialized views / indexes (declarative)
// ============================================================================

describe('declarative-equivalence: in-place view / MV / index tag drift', () => {
	function indexTags(db: Database, name: string): Record<string, unknown> | undefined {
		return collectSchemaCatalog(db, 'main').indexes.find(i => i.name.toLowerCase() === name.toLowerCase())?.tags as
			| Record<string, unknown>
			| undefined;
	}

	it('view tag drift converges via in-place SET TAGS (no drop+recreate), idempotent on re-apply', async function () {
		const db = new Database();
		try {
			await db.exec(`declare schema main {
				table t { id INTEGER PRIMARY KEY, name TEXT NOT NULL }
				view v as select id, name from t with tags (cacheable = true, owner = 'team-a')
			}`);
			await db.exec('apply schema main');

			await db.exec(`declare schema main {
				table t { id INTEGER PRIMARY KEY, name TEXT NOT NULL }
				view v as select id, name from t with tags (cacheable = false, layer = 'core')
			}`);
			const diff = computeSchemaDiff(
				db.declaredSchemaManager.getDeclaredSchema('main')!,
				collectSchemaCatalog(db, 'main'),
			);
			// Drift takes the in-place primitive — never a drop+recreate of the view.
			expect(diff.viewsToCreate, 'no view recreate on tag-only drift').to.deep.equal([]);
			expect(diff.viewsToDrop, 'no view drop on tag-only drift').to.deep.equal([]);
			expect(diff.viewTagsChanges).to.deep.equal([{ name: 'v', tags: { cacheable: false, layer: 'core' } }]);

			await db.exec('apply schema main');
			expect(db.schemaManager.getView('main', 'v')!.tags).to.deep.equal({ cacheable: false, layer: 'core' });

			const diff2 = computeSchemaDiff(
				db.declaredSchemaManager.getDeclaredSchema('main')!,
				collectSchemaCatalog(db, 'main'),
			);
			expect(diff2.viewTagsChanges, 'idempotent re-apply produces no view tag change').to.deep.equal([]);
		} finally {
			await db.close();
		}
	});

	it('index tag drift converges via in-place SET TAGS (no drop+recreate), idempotent on re-apply', async function () {
		const db = new Database();
		try {
			await db.exec(`declare schema main {
				table t { id INTEGER PRIMARY KEY, name TEXT }
				index t_name_idx on t (name) with tags (purpose = 'search')
			}`);
			await db.exec('apply schema main');

			await db.exec(`declare schema main {
				table t { id INTEGER PRIMARY KEY, name TEXT }
				index t_name_idx on t (name) with tags (purpose = 'fulltext', owner = 'search-team')
			}`);
			const diff = computeSchemaDiff(
				db.declaredSchemaManager.getDeclaredSchema('main')!,
				collectSchemaCatalog(db, 'main'),
			);
			expect(diff.indexesToCreate, 'no index recreate on tag-only drift').to.deep.equal([]);
			expect(diff.indexesToDrop, 'no index drop on tag-only drift').to.deep.equal([]);
			expect(diff.indexTagsChanges).to.deep.equal([{ name: 't_name_idx', tags: { purpose: 'fulltext', owner: 'search-team' } }]);

			await db.exec('apply schema main');
			expect(indexTags(db, 't_name_idx')).to.deep.equal({ purpose: 'fulltext', owner: 'search-team' });

			const diff2 = computeSchemaDiff(
				db.declaredSchemaManager.getDeclaredSchema('main')!,
				collectSchemaCatalog(db, 'main'),
			);
			expect(diff2.indexTagsChanges, 'idempotent re-apply produces no index tag change').to.deep.equal([]);
		} finally {
			await db.close();
		}
	});

	it('MV tag-only drift converges via in-place SET TAGS without a rebuild, idempotent on re-apply', async function () {
		const db = new Database();
		try {
			await db.exec(`declare schema main {
				table t { id INTEGER PRIMARY KEY, x INTEGER NOT NULL }
				materialized view mv as select id, x from t with tags (owner = 'analytics')
			}`);
			await db.exec('apply schema main');
			await db.exec('insert into t values (1, 10)');
			await db.exec('refresh materialized view mv');
			const bodyHashBefore = db.schemaManager.getMaintainedTable('main', 'mv')!.derivation.bodyHash;

			await db.exec(`declare schema main {
				table t { id INTEGER PRIMARY KEY, x INTEGER NOT NULL }
				materialized view mv as select id, x from t with tags (owner = 'platform', tier = 'gold')
			}`);
			const diff = computeSchemaDiff(
				db.declaredSchemaManager.getDeclaredSchema('main')!,
				collectSchemaCatalog(db, 'main'),
			);
			// Body unchanged → no re-attach; a maintained table's tag-only change is an
			// `alter table … set tags` (it rides the table-alter channel now, not a
			// separate MV tag bucket).
			const mvAlter = diff.tablesToAlter.find(a => a.tableName === 'mv');
			expect(mvAlter?.setMaintained, 'tag-only MV drift must not re-attach').to.be.undefined;
			expect(mvAlter?.tableTagsChange).to.deep.equal({ owner: 'platform', tier: 'gold' });
			expect(diff.tablesToDrop, 'tag-only MV drift must not drop').to.deep.equal([]);

			await db.exec('apply schema main');
			const mvAfter = db.schemaManager.getMaintainedTable('main', 'mv')!;
			expect(mvAfter.tags).to.deep.equal({ owner: 'platform', tier: 'gold' });
			// No re-materialization: the body hash is unchanged and the row survives.
			expect(mvAfter.derivation.bodyHash, 'tag change must not perturb the body hash').to.equal(bodyHashBefore);
			const rows: Array<Record<string, unknown>> = [];
			for await (const r of db.eval('select id, x from mv')) rows.push(r);
			expect(rows).to.deep.equal([{ id: 1, x: 10 }]);

			const diff2 = computeSchemaDiff(
				db.declaredSchemaManager.getDeclaredSchema('main')!,
				collectSchemaCatalog(db, 'main'),
			);
			expect(diff2.tablesToAlter.find(a => a.tableName === 'mv'), 'idempotent re-apply produces no MV tag change').to.be.undefined;
		} finally {
			await db.close();
		}
	});

	it('an MV whose body AND tags both changed re-attaches and sets tags (same alter, no recreate)', async function () {
		const db = new Database();
		try {
			await db.exec(`declare schema main {
				table t { id INTEGER PRIMARY KEY, x INTEGER NOT NULL, y INTEGER NOT NULL }
				materialized view mv as select id, x from t with tags (owner = 'analytics')
			}`);
			await db.exec('apply schema main');

			// Change both the body (shape-preserving: column still `x`, now fed by y)
			// and the tags in the same re-declaration.
			await db.exec(`declare schema main {
				table t { id INTEGER PRIMARY KEY, x INTEGER NOT NULL, y INTEGER NOT NULL }
				materialized view mv as select id, y as x from t with tags (owner = 'platform')
			}`);
			const diff = computeSchemaDiff(
				db.declaredSchemaManager.getDeclaredSchema('main')!,
				collectSchemaCatalog(db, 'main'),
			);
			// New model: a body change is a re-attach (`set maintained as`) and the tag
			// change rides the table-alter channel as ALTER MATERIALIZED VIEW SET TAGS —
			// both ops on the SAME table alter (no recreate; the incarnation survives).
			const mvAlter = diff.tablesToAlter.find(a => a.tableName === 'mv');
			expect(mvAlter?.setMaintained, 'body change ⇒ re-attach').to.not.be.undefined;
			expect(mvAlter?.tableTagsChange, 'tag change ⇒ set tags').to.deep.equal({ owner: 'platform' });
			expect(mvAlter?.maintainedTags, 'maintained tag edit routes via ALTER MATERIALIZED VIEW').to.equal(true);
			expect(diff.tablesToDrop, 'no drop of the maintained table').to.deep.equal([]);

			await db.exec('apply schema main');
			// The re-attach refreshed content and the SET TAGS carried the new tags.
			expect(db.schemaManager.getMaintainedTable('main', 'mv')!.tags).to.deep.equal({ owner: 'platform' });
		} finally {
			await db.close();
		}
	});

	it('a tag-value-only change does not perturb the schema hash for view / MV / index', async function () {
		const a = new Database();
		const b = new Database();
		try {
			const decl = (owner: string) => `declare schema main {
				table t { id INTEGER PRIMARY KEY, name TEXT NOT NULL }
				view v as select id, name from t with tags (owner = '${owner}')
				index t_name_idx on t (name) with tags (owner = '${owner}')
				materialized view mv as select id, name from t with tags (owner = '${owner}')
			}`;
			await a.exec(decl('team-a'));
			await b.exec(decl('team-b'));
			const ha = computeSchemaHash(a.declaredSchemaManager.getDeclaredSchema('main')!);
			const hb = computeSchemaHash(b.declaredSchemaManager.getDeclaredSchema('main')!);
			expect(ha, 'view / index / MV tag values must not change the schema hash').to.equal(hb);
		} finally {
			await a.close();
			await b.close();
		}
	});
});

// ============================================================================
// Named-constraint lifecycle — declarative add / drop / rename by name
// ============================================================================

describe('declarative-equivalence: named-constraint lifecycle', () => {
	function diffOf(db: Database) {
		return computeSchemaDiff(
			db.declaredSchemaManager.getDeclaredSchema('main')!,
			collectSchemaCatalog(db, 'main'),
		);
	}

	it('a declared named-CHECK add converges via ADD CONSTRAINT and is idempotent', async function () {
		const db = new Database();
		try {
			await db.exec(`declare schema main {
				table t { id INTEGER PRIMARY KEY, qty INTEGER }
			}`);
			await db.exec('apply schema main');

			// Re-declare adding a named CHECK.
			await db.exec(`declare schema main {
				table t {
					id INTEGER PRIMARY KEY,
					qty INTEGER,
					constraint chk_qty check (qty > 0)
				}
			}`);
			const diff = diffOf(db);
			expect(diff.tablesToAlter.length, 'one alter for the added constraint').to.equal(1);
			expect(diff.tablesToAlter[0].constraintsToAdd?.length, 'one add').to.equal(1);
			expect(diff.tablesToAlter[0].constraintsToDrop ?? [], 'no drop').to.deep.equal([]);

			await db.exec('apply schema main');

			// The CHECK now enforces.
			const cc = db.schemaManager.getTable('main', 't')!.checkConstraints.find(c => c.name === 'chk_qty');
			expect(cc, 'chk_qty present after apply').to.not.be.undefined;
			let rejected = false;
			try { await db.exec('insert into t values (1, -1)'); } catch { rejected = true; }
			expect(rejected, 'negative qty rejected by added CHECK').to.be.true;
			await db.exec('insert into t values (2, 5)');

			// Idempotent: re-diff produces no constraint churn.
			const diff2 = diffOf(db);
			expect(diff2.tablesToAlter, 'idempotent re-apply produces no alter').to.deep.equal([]);
		} finally {
			await db.close();
		}
	});

	it('a declared named-UNIQUE add converges via ADD CONSTRAINT over populated data and is idempotent', async function () {
		const db = new Database();
		try {
			await db.exec(`declare schema main {
				table t { id INTEGER PRIMARY KEY, email TEXT }
			}`);
			await db.exec('apply schema main');
			await db.exec("insert into t values (1, 'a@x'), (2, 'b@x')");

			// Re-declare adding a named UNIQUE.
			await db.exec(`declare schema main {
				table t {
					id INTEGER PRIMARY KEY,
					email TEXT,
					constraint uq_email unique (email)
				}
			}`);
			const diff = diffOf(db);
			expect(diff.tablesToAlter.length, 'one alter for the added constraint').to.equal(1);
			expect(diff.tablesToAlter[0].constraintsToAdd?.length, 'one add').to.equal(1);

			await db.exec('apply schema main');

			// Enforces going forward and converges (gap #1 closed — 10.2 could not assert this).
			const uq = db.schemaManager.getTable('main', 't')!.uniqueConstraints?.find(c => c.name === 'uq_email');
			expect(uq, 'uq_email present after apply').to.not.be.undefined;
			let rejected = false;
			try { await db.exec("insert into t values (3, 'a@x')"); } catch { rejected = true; }
			expect(rejected, 'duplicate rejected by added UNIQUE').to.be.true;

			// Idempotent: a second apply is a no-op.
			expect(diffOf(db).tablesToAlter, 'idempotent re-apply produces no alter').to.deep.equal([]);
		} finally {
			await db.close();
		}
	});

	it('a declared named-UNIQUE add over violating data fails atomically (schema unchanged)', async function () {
		const db = new Database();
		try {
			await db.exec(`declare schema main {
				table t { id INTEGER PRIMARY KEY, email TEXT }
			}`);
			await db.exec('apply schema main');
			await db.exec("insert into t values (1, 'a@x'), (2, 'a@x')"); // duplicate

			await db.exec(`declare schema main {
				table t {
					id INTEGER PRIMARY KEY,
					email TEXT,
					constraint uq_email unique (email)
				}
			}`);

			// The migration batch rolls back atomically: apply throws, schema unchanged.
			let threw = false;
			try { await db.exec('apply schema main'); } catch { threw = true; }
			expect(threw, 'apply over duplicated data must fail').to.be.true;
			const uq = db.schemaManager.getTable('main', 't')!.uniqueConstraints?.find(c => c.name === 'uq_email');
			expect(uq, 'uq_email must be absent after the failed apply').to.be.undefined;
		} finally {
			await db.close();
		}
	});

	it('a declared named-FK add converges via ADD CONSTRAINT over populated data and is idempotent', async function () {
		const db = new Database();
		try {
			await db.exec('pragma foreign_keys = true');
			await db.exec(`declare schema main {
				table parent { pid INTEGER PRIMARY KEY }
				table child { id INTEGER PRIMARY KEY, pa INTEGER }
			}`);
			await db.exec('apply schema main');
			await db.exec('insert into parent values (1), (2)');
			await db.exec('insert into child values (1, 1), (2, 2)');

			// Re-declare adding a named FK on child.
			await db.exec(`declare schema main {
				table parent { pid INTEGER PRIMARY KEY }
				table child {
					id INTEGER PRIMARY KEY,
					pa INTEGER,
					constraint fk_pa foreign key (pa) references parent(pid)
				}
			}`);
			const diff = diffOf(db);
			const childAlter = diff.tablesToAlter.find(a => a.tableName.toLowerCase() === 'child');
			expect(childAlter?.constraintsToAdd?.length, 'one FK add on child').to.equal(1);

			await db.exec('apply schema main');

			const fk = db.schemaManager.getTable('main', 'child')!.foreignKeys?.find(c => c.name === 'fk_pa');
			expect(fk, 'fk_pa present after apply').to.not.be.undefined;
			let rejected = false;
			try { await db.exec('insert into child values (3, 99)'); } catch { rejected = true; }
			expect(rejected, 'orphan rejected by added FK').to.be.true;

			expect(diffOf(db).tablesToAlter, 'idempotent re-apply produces no alter').to.deep.equal([]);
		} finally {
			await db.close();
		}
	});

	it('a declared named-FK add over orphaned data fails atomically (schema unchanged)', async function () {
		const db = new Database();
		try {
			await db.exec('pragma foreign_keys = true');
			await db.exec(`declare schema main {
				table parent { pid INTEGER PRIMARY KEY }
				table child { id INTEGER PRIMARY KEY, pa INTEGER }
			}`);
			await db.exec('apply schema main');
			await db.exec('insert into parent values (1)');
			await db.exec('insert into child values (1, 1), (2, 99)'); // 99 is an orphan

			await db.exec(`declare schema main {
				table parent { pid INTEGER PRIMARY KEY }
				table child {
					id INTEGER PRIMARY KEY,
					pa INTEGER,
					constraint fk_pa foreign key (pa) references parent(pid)
				}
			}`);

			let threw = false;
			try { await db.exec('apply schema main'); } catch { threw = true; }
			expect(threw, 'apply over orphaned data must fail').to.be.true;
			const fk = db.schemaManager.getTable('main', 'child')!.foreignKeys?.find(c => c.name === 'fk_pa');
			expect(fk, 'fk_pa must be absent after the failed apply').to.be.undefined;
		} finally {
			await db.close();
		}
	});

	it('a declared named-CHECK drop converges via DROP CONSTRAINT and is idempotent', async function () {
		const db = new Database();
		try {
			await db.exec(`declare schema main {
				table t {
					id INTEGER PRIMARY KEY,
					qty INTEGER,
					constraint chk_qty check (qty > 0)
				}
			}`);
			await db.exec('apply schema main');

			// Re-declare WITHOUT the named CHECK → drop.
			await db.exec(`declare schema main {
				table t { id INTEGER PRIMARY KEY, qty INTEGER }
			}`);
			const diff = diffOf(db);
			expect(diff.tablesToAlter.length, 'one alter for the dropped constraint').to.equal(1);
			expect(diff.tablesToAlter[0].constraintsToDrop, 'drops chk_qty').to.deep.equal(['chk_qty']);
			expect(diff.tablesToAlter[0].constraintsToAdd ?? [], 'no add').to.deep.equal([]);

			await db.exec('apply schema main');

			// Enforcement gone.
			const cc = db.schemaManager.getTable('main', 't')!.checkConstraints.find(c => c.name === 'chk_qty');
			expect(cc, 'chk_qty gone after apply').to.be.undefined;
			await db.exec('insert into t values (1, -1)'); // would have violated

			const diff2 = diffOf(db);
			expect(diff2.tablesToAlter, 'idempotent re-apply produces no alter').to.deep.equal([]);
		} finally {
			await db.close();
		}
	});

	it('REGRESSION: a hinted named-constraint rename emits RENAME CONSTRAINT and converges (was a silent no-op)', async function () {
		// Before this ticket, computeTableAlterDiff populated `constraintsToRename`
		// but generateMigrationDDL never read it — a declared constraint rename was
		// silently dropped on the floor. Guard the wiring end-to-end.
		const db = new Database();
		try {
			await db.exec(`declare schema main {
				table t {
					id INTEGER PRIMARY KEY,
					qty INTEGER,
					constraint chk_old check (qty > 0)
				}
			}`);
			await db.exec('apply schema main');

			// Re-declare with the constraint renamed via a previous_name hint.
			await db.exec(`declare schema main {
				table t {
					id INTEGER PRIMARY KEY,
					qty INTEGER,
					constraint chk_new check (qty > 0) with tags ("quereus.previous_name" = 'chk_old')
				}
			}`);
			const diff = diffOf(db);
			expect(diff.tablesToAlter.length, 'one alter for the rename').to.equal(1);
			const alter = diff.tablesToAlter[0];
			expect(alter.constraintsToRename, 'rename op detected').to.deep.equal([{ oldName: 'chk_old', newName: 'chk_new' }]);
			// A rename is neither an add nor a drop.
			expect(alter.constraintsToAdd ?? [], 'rename is not an add').to.deep.equal([]);
			expect(alter.constraintsToDrop ?? [], 'rename is not a drop').to.deep.equal([]);

			// The dead-code bug: the RENAME CONSTRAINT statement must actually be emitted.
			const ddl = generateMigrationDDL(diff, 'main');
			expect(
				ddl.some(s => /RENAME CONSTRAINT .*chk_old.* TO .*chk_new/i.test(s)),
				`expected a RENAME CONSTRAINT statement, got:\n${ddl.join('\n')}`,
			).to.be.true;

			await db.exec('apply schema main');

			// The constraint is renamed in the live catalog and still enforces.
			const checks = db.schemaManager.getTable('main', 't')!.checkConstraints;
			expect(checks.some(c => c.name === 'chk_old'), 'old name gone').to.be.false;
			expect(checks.some(c => c.name === 'chk_new'), 'new name present').to.be.true;
			let rejected = false;
			try { await db.exec('insert into t values (1, -1)'); } catch { rejected = true; }
			expect(rejected, 'renamed CHECK still enforces').to.be.true;

			// Idempotent: the previous_name hint must not re-trigger after the rename.
			const diff2 = diffOf(db);
			expect(diff2.renames, 'no further rename').to.deep.equal([]);
			expect(diff2.tablesToAlter, 'idempotent re-apply produces no alter').to.deep.equal([]);
		} finally {
			await db.close();
		}
	});

	it('a column-level named CHECK is gathered for lifecycle (add detected and converges)', async function () {
		const db = new Database();
		try {
			await db.exec(`declare schema main {
				table t { id INTEGER PRIMARY KEY, qty INTEGER }
			}`);
			await db.exec('apply schema main');

			// Re-declare adding a COLUMN-LEVEL named CHECK.
			await db.exec(`declare schema main {
				table t {
					id INTEGER PRIMARY KEY,
					qty INTEGER constraint chk_qty check (qty > 0)
				}
			}`);
			const diff = diffOf(db);
			expect(diff.tablesToAlter[0]?.constraintsToAdd?.length, 'column-level named CHECK detected as an add').to.equal(1);

			await db.exec('apply schema main');
			expect(
				db.schemaManager.getTable('main', 't')!.checkConstraints.some(c => c.name === 'chk_qty'),
				'chk_qty present after apply',
			).to.be.true;

			// Idempotent — the column-level constraint matches by name on re-diff.
			expect(diffOf(db).tablesToAlter, 'idempotent').to.deep.equal([]);
		} finally {
			await db.close();
		}
	});

	it('IDEMPOTENCY: an UNNAMED column CHECK does not churn add/drop (auto-name excluded)', async function () {
		// The extractor auto-names an unnamed column CHECK `_check_<col>`; that name
		// is engine-synthesized and must NOT participate in lifecycle diffing, or a
		// declaration that only carries explicit names would spuriously drop it.
		const db = new Database();
		try {
			await db.exec(`declare schema main {
				table t {
					id INTEGER PRIMARY KEY,
					qty INTEGER check (qty > 0)
				}
			}`);
			await db.exec('apply schema main');

			const diff = diffOf(db);
			expect(diff.tablesToAlter, 'unnamed column CHECK must not churn a drop/add').to.deep.equal([]);
		} finally {
			await db.close();
		}
	});

	it('IDEMPOTENCY: a CREATE UNIQUE INDEX-derived constraint does not churn a DROP CONSTRAINT', async function () {
		// A UNIQUE constraint synthesized from a unique index is excluded from the
		// catalog's user-addressable named constraints (it is managed via the index),
		// so re-applying a schema that declares the index must not drop the constraint.
		const db = new Database();
		try {
			await db.exec(`declare schema main {
				table t { id INTEGER PRIMARY KEY, email TEXT }
				unique index uq_email on t (email)
			}`);
			await db.exec('apply schema main');

			const diff = diffOf(db);
			expect(diff.tablesToAlter, 'index-derived UNIQUE must not churn a constraint drop').to.deep.equal([]);
			expect(diff.indexesToDrop, 'index itself stable').to.deep.equal([]);
			expect(diff.indexesToCreate, 'index itself stable').to.deep.equal([]);
		} finally {
			await db.close();
		}
	});
});

// ============================================================================
// Named-constraint BODY change — drop+recreate (ticket 10.3)
// ============================================================================

describe('declarative-equivalence: named-constraint body change (drop+recreate)', () => {
	function diffOf(db: Database) {
		return computeSchemaDiff(
			db.declaredSchemaManager.getDeclaredSchema('main')!,
			collectSchemaCatalog(db, 'main'),
		);
	}

	it('a CHECK body change converges via drop+add, is idempotent, and enforces the new predicate', async function () {
		// NOTE: CHECK `ADD CONSTRAINT` applies in place and does NOT re-validate
		// existing rows (a pre-existing limitation of the CHECK add path — UNIQUE / FK
		// re-validate, CHECK does not). So a CHECK body change is forward-enforcing
		// only; existing rows that violate the new predicate are not re-checked.
		const db = new Database();
		try {
			await db.exec(`declare schema main {
				table t { id INTEGER PRIMARY KEY, qty INTEGER, constraint chk_qty check (qty > 0) }
			}`);
			await db.exec('apply schema main');
			await db.exec('insert into t values (1, 5)');

			// Edit the CHECK body (qty > 0 → qty >= 0), name unchanged.
			await db.exec(`declare schema main {
				table t { id INTEGER PRIMARY KEY, qty INTEGER, constraint chk_qty check (qty >= 0) }
			}`);
			const diff = diffOf(db);
			expect(diff.tablesToAlter.length, 'one alter').to.equal(1);
			const alter = diff.tablesToAlter[0];
			expect(alter.constraintsToDrop, 'drops old chk_qty').to.deep.equal(['chk_qty']);
			expect(alter.constraintsToAdd?.length, 'adds new chk_qty').to.equal(1);
			expect(alter.constraintsToRename ?? [], 'not a rename').to.deep.equal([]);
			expect(alter.constraintTagsChanges ?? [], 'not a tag change').to.deep.equal([]);

			await db.exec('apply schema main');

			// New predicate enforced: qty = 0 now allowed (was rejected under qty > 0).
			await db.exec('insert into t values (2, 0)');
			// qty < 0 still rejected by the new predicate.
			let rejected = false;
			try { await db.exec('insert into t values (3, -1)'); } catch { rejected = true; }
			expect(rejected, 'qty < 0 rejected by new CHECK').to.be.true;

			// Existing data preserved across the drop+recreate.
			const rows: Array<Record<string, unknown>> = [];
			for await (const r of db.eval('select id, qty from t order by id')) rows.push(r);
			expect(rows).to.deep.equal([{ id: 1, qty: 5 }, { id: 2, qty: 0 }]);

			// Idempotent: re-diff produces no constraint churn (canonical fragments match).
			expect(diffOf(db).tablesToAlter, 'idempotent re-apply produces no alter').to.deep.equal([]);
		} finally {
			await db.close();
		}
	});

	it('a UNIQUE body change converges via drop+add over satisfying data and is idempotent', async function () {
		const db = new Database();
		try {
			await db.exec(`declare schema main {
				table t { id INTEGER PRIMARY KEY, a INTEGER, b INTEGER, constraint uq unique (a) }
			}`);
			await db.exec('apply schema main');
			await db.exec('insert into t values (1, 10, 100)');

			// Widen the UNIQUE column set (a) → (a, b).
			await db.exec(`declare schema main {
				table t { id INTEGER PRIMARY KEY, a INTEGER, b INTEGER, constraint uq unique (a, b) }
			}`);
			const alter = diffOf(db).tablesToAlter[0];
			expect(alter.constraintsToDrop, 'drops old uq').to.deep.equal(['uq']);
			expect(alter.constraintsToAdd?.length, 'adds new uq').to.equal(1);

			await db.exec('apply schema main');

			// Under unique(a,b): a duplicate `a` with distinct `b` is now allowed
			// (was rejected by unique(a)); a full (a,b) duplicate is still rejected.
			await db.exec('insert into t values (2, 10, 200)');
			let rejected = false;
			try { await db.exec('insert into t values (3, 10, 100)'); } catch { rejected = true; }
			expect(rejected, 'full (a,b) duplicate rejected by new UNIQUE').to.be.true;

			expect(diffOf(db).tablesToAlter, 'idempotent re-apply produces no alter').to.deep.equal([]);
		} finally {
			await db.close();
		}
	});

	it('a UNIQUE body change the existing data violates is rejected by the re-add (apply fails)', async function () {
		// The re-add re-validates existing rows and aborts the apply when they
		// violate the new body. NOTE: a body change is two statements (DROP + ADD),
		// and a multi-statement migration is NOT atomic for schema mutations on the
		// memory backend — the DROP commits immediately, so a failed re-ADD leaves
		// the OLD constraint dropped (it is not restored). We therefore assert only
		// that the apply fails (a row that satisfies the OLD body is no longer
		// guarded), not that the schema is unchanged. See the handoff "known gaps".
		const db = new Database();
		try {
			await db.exec(`declare schema main {
				table t { id INTEGER PRIMARY KEY, a INTEGER, b INTEGER, constraint uq unique (a, b) }
			}`);
			await db.exec('apply schema main');
			// Distinct on (a,b), but duplicated on `a` alone.
			await db.exec('insert into t values (1, 10, 100), (2, 10, 200)');

			// Narrow the UNIQUE to (a): existing data has a=10 twice → re-validation fails.
			await db.exec(`declare schema main {
				table t { id INTEGER PRIMARY KEY, a INTEGER, b INTEGER, constraint uq unique (a) }
			}`);
			let threw = false;
			try { await db.exec('apply schema main'); } catch { threw = true; }
			expect(threw, 'apply over UNIQUE-violating data must fail on the re-add').to.be.true;
		} finally {
			await db.close();
		}
	});

	it('an FK body change (ON DELETE action) converges via drop+add and changes behavior', async function () {
		const db = new Database();
		try {
			await db.exec('pragma foreign_keys = true');
			await db.exec(`declare schema main {
				table parent { pid INTEGER PRIMARY KEY }
				table child { id INTEGER PRIMARY KEY, pa INTEGER, constraint fk_pa foreign key (pa) references parent(pid) on delete restrict }
			}`);
			await db.exec('apply schema main');
			await db.exec('insert into parent values (1)');
			await db.exec('insert into child values (10, 1)');

			// Change ON DELETE restrict → cascade (a body change of the FK).
			await db.exec(`declare schema main {
				table parent { pid INTEGER PRIMARY KEY }
				table child { id INTEGER PRIMARY KEY, pa INTEGER, constraint fk_pa foreign key (pa) references parent(pid) on delete cascade }
			}`);
			const childAlter = diffOf(db).tablesToAlter.find(a => a.tableName.toLowerCase() === 'child')!;
			expect(childAlter.constraintsToDrop, 'drops old fk_pa').to.deep.equal(['fk_pa']);
			expect(childAlter.constraintsToAdd?.length, 'adds new fk_pa').to.equal(1);

			await db.exec('apply schema main');

			// New behavior: deleting the parent now cascades (was restricted before).
			await db.exec('delete from parent where pid = 1');
			const rows: Array<Record<string, unknown>> = [];
			for await (const r of db.eval('select count(*) as n from child')) rows.push(r);
			expect(rows, 'child rows cascade-deleted under the new ON DELETE CASCADE').to.deep.equal([{ n: 0 }]);

			expect(diffOf(db).tablesToAlter, 'idempotent re-apply produces no alter').to.deep.equal([]);
		} finally {
			await db.close();
		}
	});

	// --- Disambiguation: tag-only vs body-only vs both ---

	it('a tag-only constraint change takes ALTER CONSTRAINT SET TAGS, not a drop+recreate', async function () {
		const db = new Database();
		try {
			await db.exec(`declare schema main {
				table t { id INTEGER PRIMARY KEY, a INTEGER, constraint uq_a unique (a) with tags (msg = 'orig') }
			}`);
			await db.exec('apply schema main');
			await db.exec(`declare schema main {
				table t { id INTEGER PRIMARY KEY, a INTEGER, constraint uq_a unique (a) with tags (msg = 'updated') }
			}`);
			const alter = diffOf(db).tablesToAlter[0];
			expect(alter.constraintsToDrop ?? [], 'no drop on a tag-only change').to.deep.equal([]);
			expect(alter.constraintsToAdd ?? [], 'no add on a tag-only change').to.deep.equal([]);
			expect(alter.constraintTagsChanges).to.deep.equal([{ constraintName: 'uq_a', tags: { msg: 'updated' } }]);

			await db.exec('apply schema main');
			expect(diffOf(db).tablesToAlter, 'idempotent').to.deep.equal([]);
		} finally {
			await db.close();
		}
	});

	it('a simultaneous body+tag change does drop+add carrying the declared tags (no separate SET TAGS)', async function () {
		const db = new Database();
		try {
			await db.exec(`declare schema main {
				table t { id INTEGER PRIMARY KEY, a INTEGER, b INTEGER, constraint uq unique (a) with tags (msg = 'orig') }
			}`);
			await db.exec('apply schema main');
			// Change BOTH the body (a → a,b) and the tag value in the same re-declaration.
			await db.exec(`declare schema main {
				table t { id INTEGER PRIMARY KEY, a INTEGER, b INTEGER, constraint uq unique (a, b) with tags (msg = 'updated') }
			}`);
			const alter = diffOf(db).tablesToAlter[0];
			expect(alter.constraintsToDrop, 'drops old uq').to.deep.equal(['uq']);
			expect(alter.constraintsToAdd?.length, 'adds new uq').to.equal(1);
			// Body change wins: the recreate carries the declared tags; no separate SET TAGS.
			expect(alter.constraintTagsChanges ?? [], 'no SET TAGS when the body recreates').to.deep.equal([]);
			expect(alter.constraintsToAdd![0], 'recreate fragment carries the declared tags').to.match(/with tags \(msg = 'updated'\)/i);

			await db.exec('apply schema main');
			const uq = db.schemaManager.getTable('main', 't')!.uniqueConstraints!.find(c => c.name === 'uq')!;
			expect(uq.tags, 'recreate applied the new tags').to.deep.equal({ msg: 'updated' });
			expect(diffOf(db).tablesToAlter, 'idempotent').to.deep.equal([]);
		} finally {
			await db.close();
		}
	});

	// --- Rename + body precedence ---

	it('a hinted constraint rename whose body ALSO changed suppresses the RENAME and does drop+add', async function () {
		const db = new Database();
		try {
			await db.exec(`declare schema main {
				table t { id INTEGER PRIMARY KEY, qty INTEGER, constraint chk_old check (qty > 0) }
			}`);
			await db.exec('apply schema main');

			// Rename chk_old → chk_new AND change the body in one re-declaration.
			await db.exec(`declare schema main {
				table t {
					id INTEGER PRIMARY KEY,
					qty INTEGER,
					constraint chk_new check (qty >= 0) with tags ("quereus.previous_name" = 'chk_old')
				}
			}`);
			const diff = diffOf(db);
			const alter = diff.tablesToAlter[0];
			expect(alter.constraintsToRename ?? [], 'RENAME suppressed by the body change').to.deep.equal([]);
			expect(alter.constraintsToDrop, 'old name dropped').to.deep.equal(['chk_old']);
			expect(alter.constraintsToAdd?.length, 'declared constraint added').to.equal(1);

			const ddl = generateMigrationDDL(diff, 'main');
			expect(ddl.some(s => /RENAME CONSTRAINT/i.test(s)), `no RENAME CONSTRAINT emitted, got:\n${ddl.join('\n')}`).to.be.false;
			expect(ddl.some(s => /DROP CONSTRAINT .*chk_old/i.test(s)), 'DROP old emitted').to.be.true;

			await db.exec('apply schema main');
			const checks = db.schemaManager.getTable('main', 't')!.checkConstraints;
			expect(checks.some(c => c.name === 'chk_old'), 'old name gone').to.be.false;
			expect(checks.some(c => c.name === 'chk_new'), 'new name present').to.be.true;
			// New body enforced (qty >= 0 allows 0).
			await db.exec('insert into t values (1, 0)');

			// Idempotent: the previous_name hint must not re-trigger after the recreate.
			const diff2 = diffOf(db);
			expect(diff2.renames, 'no further rename').to.deep.equal([]);
			expect(diff2.tablesToAlter, 'idempotent re-apply produces no alter').to.deep.equal([]);
		} finally {
			await db.close();
		}
	});

	// --- Canonicalization fidelity: default-elided forms must not churn ---

	it('default-form constraint bodies (default mask / ABORT / RESTRICT) do not churn a drop+recreate', async function () {
		const db = new Database();
		try {
			await db.exec('pragma foreign_keys = true');
			await db.exec(`declare schema main {
				table parent { pid INTEGER PRIMARY KEY }
				table t {
					id INTEGER PRIMARY KEY,
					qty INTEGER,
					pa INTEGER,
					constraint chk check on insert, update (qty > 0),
					constraint uq unique (qty) on conflict abort,
					constraint fk foreign key (pa) references parent(pid) on delete restrict
				}
			}`);
			await db.exec('apply schema main');
			// The declared default-form clauses canonicalize to the same fragments the
			// catalog stores, so re-diffing the identical schema yields zero churn.
			expect(diffOf(db).tablesToAlter, 'default-form bodies must not churn drop+recreate').to.deep.equal([]);
		} finally {
			await db.close();
		}
	});

	// --- Column-name case folding: a reference whose case diverges from the column
	// definition must not churn. The actual side lifts the column DEFINITION case
	// (tableSchema.columns[i].name) while the declared side carries the as-written
	// reference case; the canonical body folds both (matching case-insensitive column
	// resolution), so a case-only divergence renders identically. ---

	it('a UNIQUE constraint referencing a column in a different case than its definition does not churn', async function () {
		const db = new Database();
		try {
			// Column declared `Email`; UNIQUE references `email`. Actual lifts `Email`,
			// declared body uses `email` — equal only after case folding.
			await db.exec(`declare schema main {
				table t { id INTEGER PRIMARY KEY, Email TEXT, constraint uq unique (email) }
			}`);
			await db.exec('apply schema main');
			const alter = diffOf(db).tablesToAlter;
			expect(alter, 'no constraint churn from a UNIQUE column-case divergence').to.deep.equal([]);
		} finally {
			await db.close();
		}
	});

	it('an FK whose LOCAL column case differs from the column definition does not churn', async function () {
		const db = new Database();
		try {
			await db.exec('pragma foreign_keys = true');
			// Child column declared `PA`; FK local list references `pa`. Actual lifts the
			// child definition case `PA`; declared body uses `pa`.
			await db.exec(`declare schema main {
				table parent { pid INTEGER PRIMARY KEY }
				table child { id INTEGER PRIMARY KEY, PA INTEGER, constraint fk foreign key (pa) references parent(pid) }
			}`);
			await db.exec('apply schema main');
			const childAlter = diffOf(db).tablesToAlter.find(a => a.tableName.toLowerCase() === 'child');
			expect(childAlter, 'no constraint churn from an FK local column-case divergence').to.be.undefined;
		} finally {
			await db.close();
		}
	});

	it('an FK whose REFERENCED (parent) column case changes across re-declares does not churn', async function () {
		const db = new Database();
		try {
			await db.exec('pragma foreign_keys = true');
			// The FK's referenced column names are stored AS WRITTEN (not resolved to the
			// parent definition case), so the referenced-column divergence is a BETWEEN-
			// VERSIONS case: apply with `references parent(PID)`, re-declare with the same
			// referenced column in a different case. The actual catalog renders `PID`; the
			// new declaration renders `pid` — equal only after case folding the canonical
			// FK referenced-column list (which renders via foreignKeyClauseTail).
			await db.exec(`declare schema main {
				table parent { pid INTEGER PRIMARY KEY }
				table child { id INTEGER PRIMARY KEY, pa INTEGER, constraint fk foreign key (pa) references parent(PID) }
			}`);
			await db.exec('apply schema main');
			await db.exec(`declare schema main {
				table parent { pid INTEGER PRIMARY KEY }
				table child { id INTEGER PRIMARY KEY, pa INTEGER, constraint fk foreign key (pa) references parent(pid) }
			}`);
			const childAlter = diffOf(db).tablesToAlter.find(a => a.tableName.toLowerCase() === 'child');
			expect(childAlter, 'no constraint churn from an FK referenced column-case change').to.be.undefined;
		} finally {
			await db.close();
		}
	});

	it('a mixed-case UNIQUE applies once and converges — no spurious migration DDL executes', async function () {
		// End-to-end (not just the diff decision): the first apply realizes the UNIQUE,
		// and a re-declare with the SAME column in the SAME case must produce neither a
		// diff nor any migration DDL — proving the no-churn decision also means no DDL runs.
		const db = new Database();
		try {
			await db.exec(`declare schema main {
				table t { id INTEGER PRIMARY KEY, Email TEXT, constraint uq unique (email) }
			}`);
			await db.exec('apply schema main');
			await db.exec("insert into t values (1, 'a@x')");

			const diff = diffOf(db);
			expect(diff.tablesToAlter, 'converged: no alter on re-diff').to.deep.equal([]);
			expect(generateMigrationDDL(diff, 'main'), 'converged: no migration DDL').to.deep.equal([]);

			// The constraint really enforces (it was actually applied, not silently skipped).
			let rejected = false;
			try { await db.exec("insert into t values (2, 'a@x')"); } catch { rejected = true; }
			expect(rejected, 'duplicate rejected by the applied UNIQUE').to.be.true;
		} finally {
			await db.close();
		}
	});

	// --- Identifier-case folding BEYOND column lists: column refs inside CHECK
	// expressions / partial-index WHERE predicates, and the FK referenced-table name.
	// Unlike UNIQUE/PK/FK column lists (where the actual side lifts the column
	// DEFINITION case), the CHECK expr and FK referenced-table are stored AS WRITTEN,
	// so the fold-exercising divergence is a BETWEEN-VERSIONS case change. ---

	it('a CHECK whose embedded column-ref case changes across re-declares does not churn', async function () {
		const db = new Database();
		try {
			// Stored CHECK expr keeps the as-written ref case (`QTY`); re-declare references
			// it as `qty`. Equal only after folding the column ref in the canonical CHECK body.
			await db.exec(`declare schema main {
				table t { id INTEGER PRIMARY KEY, qty INTEGER, constraint chk check (QTY > 0) }
			}`);
			await db.exec('apply schema main');
			await db.exec(`declare schema main {
				table t { id INTEGER PRIMARY KEY, qty INTEGER, constraint chk check (qty > 0) }
			}`);
			const alter = diffOf(db).tablesToAlter.find(a => a.tableName.toLowerCase() === 't');
			expect(alter, 'no constraint churn from a CHECK column-ref case change').to.be.undefined;
		} finally {
			await db.close();
		}
	});

	it('a CHECK column-ref divergent from its definition, re-declared verbatim, does not churn', async function () {
		const db = new Database();
		try {
			// Column declared `Qty`; CHECK references `qty`. A verbatim re-declare must not
			// churn (sanity probe — both sides carry the same as-written expr regardless of fold).
			await db.exec(`declare schema main {
				table t { id INTEGER PRIMARY KEY, Qty INTEGER, constraint chk check (qty > 0) }
			}`);
			await db.exec('apply schema main');
			const alter = diffOf(db).tablesToAlter.find(a => a.tableName.toLowerCase() === 't');
			expect(alter, 'no constraint churn from a verbatim re-declare').to.be.undefined;
		} finally {
			await db.close();
		}
	});

	it('a CHECK string literal is compared byte-exact — verbatim no-churn, but a literal-value edit recreates', async function () {
		const db = new Database();
		try {
			await db.exec(`declare schema main {
				table t { id INTEGER PRIMARY KEY, status TEXT, constraint chk check (status = 'Active') }
			}`);
			await db.exec('apply schema main');

			// Verbatim re-declare: the literal is preserved, so no churn.
			const alter0 = diffOf(db).tablesToAlter.find(a => a.tableName.toLowerCase() === 't');
			expect(alter0, 'verbatim CHECK re-declare does not churn (literal preserved)').to.be.undefined;

			// Genuine literal-VALUE edit ('Active' → 'active'): this IS a body change — the fold
			// collapses identifier case only, never a literal value — so it drops+recreates.
			await db.exec(`declare schema main {
				table t { id INTEGER PRIMARY KEY, status TEXT, constraint chk check (status = 'active') }
			}`);
			const alter1 = diffOf(db).tablesToAlter.find(a => a.tableName.toLowerCase() === 't');
			expect(alter1?.constraintsToDrop ?? [], 'literal-value edit drops old CHECK').to.deep.equal(['chk']);
			expect(alter1?.constraintsToAdd?.length ?? 0, 'literal-value edit adds new CHECK').to.equal(1);
		} finally {
			await db.close();
		}
	});

	it('a reserved-word column ref in a CHECK re-quotes identically and does not churn on a case change', async function () {
		const db = new Database();
		try {
			// `"Order"` is a reserved word; folded → `order` → quoteIdentifier → `"order"` on
			// both sides. A between-versions case change of the ref must not churn.
			await db.exec(`declare schema main {
				table t { id INTEGER PRIMARY KEY, "Order" INTEGER, constraint chk check ("Order" > 0) }
			}`);
			await db.exec('apply schema main');
			await db.exec(`declare schema main {
				table t { id INTEGER PRIMARY KEY, "Order" INTEGER, constraint chk check ("order" > 0) }
			}`);
			const alter = diffOf(db).tablesToAlter.find(a => a.tableName.toLowerCase() === 't');
			expect(alter, 'no churn from a reserved-word CHECK ref case change').to.be.undefined;
		} finally {
			await db.close();
		}
	});

	it('a TABLE-qualified CHECK ref case change (t.QTY → t.qty) folds the qualifier too and does not churn', async function () {
		const db = new Database();
		try {
			// The qualifier (`t`) and column (`QTY`) are BOTH folded; a between-versions case
			// change of either must not churn. (Qualified CHECK refs are unusual but reachable.)
			await db.exec(`declare schema main {
				table t { id INTEGER PRIMARY KEY, qty INTEGER, constraint chk check (T.QTY > 0) }
			}`);
			await db.exec('apply schema main');
			await db.exec(`declare schema main {
				table t { id INTEGER PRIMARY KEY, qty INTEGER, constraint chk check (t.qty > 0) }
			}`);
			const alter = diffOf(db).tablesToAlter.find(a => a.tableName.toLowerCase() === 't');
			expect(alter, 'no churn from a qualified CHECK ref case change').to.be.undefined;
		} finally {
			await db.close();
		}
	});

	it('a CHECK with column refs nested in a function + CASE folds through the recursion and does not churn', async function () {
		const db = new Database();
		try {
			// Exercises the fold's `function` / `case` / `binary` recursion branches via the
			// apply path (the other CHECK tests only reach `binary`). The literal `'x'` stays
			// byte-exact; only the column-ref case (`Qty` / `Status`) diverges across versions.
			await db.exec(`declare schema main {
				table t { id INTEGER PRIMARY KEY, qty INTEGER, status TEXT,
					constraint chk check (length(case when Status = 'x' then Qty else 0 end) >= 0) }
			}`);
			await db.exec('apply schema main');
			await db.exec(`declare schema main {
				table t { id INTEGER PRIMARY KEY, qty INTEGER, status TEXT,
					constraint chk check (length(case when status = 'x' then qty else 0 end) >= 0) }
			}`);
			const alter = diffOf(db).tablesToAlter.find(a => a.tableName.toLowerCase() === 't');
			expect(alter, 'no churn from a nested-expression CHECK ref case change').to.be.undefined;
		} finally {
			await db.close();
		}
	});

	it('an FK whose REFERENCED (parent) TABLE case changes across re-declares does not churn', async function () {
		const db = new Database();
		try {
			await db.exec('pragma foreign_keys = true');
			// referencedTable is stored AS WRITTEN; apply with `references Parent`, re-declare
			// with `references parent`. The actual renders `Parent`, the new declaration `parent`
			// — equal only after folding the FK referenced-table name in the canonical FK body.
			await db.exec(`declare schema main {
				table parent { pid INTEGER PRIMARY KEY }
				table child { id INTEGER PRIMARY KEY, pa INTEGER, constraint fk foreign key (pa) references Parent(pid) }
			}`);
			await db.exec('apply schema main');
			await db.exec(`declare schema main {
				table parent { pid INTEGER PRIMARY KEY }
				table child { id INTEGER PRIMARY KEY, pa INTEGER, constraint fk foreign key (pa) references parent(pid) }
			}`);
			const childAlter = diffOf(db).tablesToAlter.find(a => a.tableName.toLowerCase() === 'child');
			expect(childAlter?.constraintsToDrop ?? [], 'no spurious FK drop from a referenced-table case change').to.deep.equal([]);
			expect(childAlter?.constraintsToAdd ?? [], 'no spurious FK add from a referenced-table case change').to.deep.equal([]);
		} finally {
			await db.close();
		}
	});

	it('an FK retargeted to a genuinely different parent table still drops+recreates', async function () {
		const db = new Database();
		try {
			await db.exec('pragma foreign_keys = true');
			await db.exec(`declare schema main {
				table parent { pid INTEGER PRIMARY KEY }
				table other { oid INTEGER PRIMARY KEY }
				table child { id INTEGER PRIMARY KEY, pa INTEGER, constraint fk foreign key (pa) references parent(pid) }
			}`);
			await db.exec('apply schema main');
			// Retarget the FK parent: parent → other (a real different table, not just case).
			await db.exec(`declare schema main {
				table parent { pid INTEGER PRIMARY KEY }
				table other { oid INTEGER PRIMARY KEY }
				table child { id INTEGER PRIMARY KEY, pa INTEGER, constraint fk foreign key (pa) references other(oid) }
			}`);
			const childAlter = diffOf(db).tablesToAlter.find(a => a.tableName.toLowerCase() === 'child');
			expect(childAlter?.constraintsToDrop ?? [], 'retarget drops old FK').to.deep.equal(['fk']);
			expect(childAlter?.constraintsToAdd?.length ?? 0, 'retarget adds new FK').to.equal(1);
		} finally {
			await db.close();
		}
	});

	it('a CHECK with a case-divergent column ref applies once, enforces, and converges with no migration DDL', async function () {
		const db = new Database();
		try {
			// Column `Qty`; CHECK references `qty`. Apply, then a verbatim re-declare must
			// yield neither a diff nor any migration DDL — and the CHECK must really enforce.
			await db.exec(`declare schema main {
				table t { id INTEGER PRIMARY KEY, Qty INTEGER, constraint chk check (qty > 0) }
			}`);
			await db.exec('apply schema main');

			const diff = diffOf(db);
			expect(diff.tablesToAlter, 'converged: no alter on re-diff').to.deep.equal([]);
			expect(generateMigrationDDL(diff, 'main'), 'converged: no migration DDL').to.deep.equal([]);

			// The CHECK genuinely enforces (it was applied, not silently skipped).
			await db.exec('insert into t values (1, 5)');
			let rejected = false;
			try { await db.exec('insert into t values (2, -1)'); } catch { rejected = true; }
			expect(rejected, 'CHECK enforces under the case-divergent ref').to.be.true;
		} finally {
			await db.close();
		}
	});
});

// ============================================================================
// Rename without constraint churn — a named constraint whose body is unchanged
// except for a renamed identifier (handled by the rename pass in the SAME diff)
// must emit ONLY the rename, not a redundant DROP+ADD (ticket
// constraint-body-change-rename-churn).
// ============================================================================

describe('declarative-equivalence: rename without constraint churn', () => {
	function diffOf(db: Database) {
		return computeSchemaDiff(
			db.declaredSchemaManager.getDeclaredSchema('main')!,
			collectSchemaCatalog(db, 'main'),
		);
	}

	it('a CHECK over a renamed column emits ONLY the column rename (no constraint drop+recreate)', async function () {
		const db = new Database();
		try {
			await db.exec(`declare schema main {
				table t { id INTEGER PRIMARY KEY, qty INTEGER, constraint chk check (qty > 0) }
			}`);
			await db.exec('apply schema main');

			// Rename qty → quantity (column previous_name hint); CHECK body semantically
			// unchanged — it just references the renamed column.
			await db.exec(`declare schema main {
				table t {
					id INTEGER PRIMARY KEY,
					quantity INTEGER with tags ("quereus.previous_name" = 'qty'),
					constraint chk check (quantity > 0)
				}
			}`);
			const diff = diffOf(db);
			expect(diff.tablesToAlter.length, 'one alter for the column rename').to.equal(1);
			const alter = diff.tablesToAlter[0];
			expect(alter.columnsToRename, 'column rename detected').to.deep.equal([{ oldName: 'qty', newName: 'quantity' }]);
			expect(alter.constraintsToDrop ?? [], 'no spurious constraint drop').to.deep.equal([]);
			expect(alter.constraintsToAdd ?? [], 'no spurious constraint add').to.deep.equal([]);

			// The migration DDL must carry the RENAME COLUMN and NO constraint drop/add.
			const ddl = generateMigrationDDL(diff, 'main');
			expect(ddl.some(s => /RENAME COLUMN .*qty.* TO .*quantity/i.test(s)), `expected RENAME COLUMN, got:\n${ddl.join('\n')}`).to.be.true;
			expect(ddl.some(s => /DROP CONSTRAINT/i.test(s)), `no DROP CONSTRAINT, got:\n${ddl.join('\n')}`).to.be.false;
			expect(ddl.some(s => /ADD .*constraint/i.test(s)), `no ADD constraint, got:\n${ddl.join('\n')}`).to.be.false;

			await db.exec('apply schema main');

			// The CHECK still enforces under the new column name (the rename rewrote it).
			await db.exec('insert into t values (1, 5)');
			let rejected = false;
			try { await db.exec('insert into t values (2, -1)'); } catch { rejected = true; }
			expect(rejected, 'CHECK still enforces under quantity').to.be.true;

			// Idempotent: the previous_name hint must not re-trigger after the rename lands.
			expect(diffOf(db).tablesToAlter, 'idempotent re-apply produces no alter').to.deep.equal([]);
		} finally {
			await db.close();
		}
	});

	it('a UNIQUE over a renamed column emits ONLY the column rename (no re-add / re-scan)', async function () {
		const db = new Database();
		try {
			await db.exec(`declare schema main {
				table t { id INTEGER PRIMARY KEY, email TEXT, constraint uq unique (email) }
			}`);
			await db.exec('apply schema main');
			await db.exec("insert into t values (1, 'a@x'), (2, 'b@x')");

			// Rename email → addr; UNIQUE body unchanged except the renamed column.
			await db.exec(`declare schema main {
				table t {
					id INTEGER PRIMARY KEY,
					addr TEXT with tags ("quereus.previous_name" = 'email'),
					constraint uq unique (addr)
				}
			}`);
			const diff = diffOf(db);
			expect(diff.tablesToAlter.length, 'one alter for the column rename').to.equal(1);
			const alter = diff.tablesToAlter[0];
			expect(alter.columnsToRename, 'column rename detected').to.deep.equal([{ oldName: 'email', newName: 'addr' }]);
			// No drop+add ⇒ the metadata-only rename never re-validates (no full-table scan).
			expect(alter.constraintsToDrop ?? [], 'no spurious constraint drop').to.deep.equal([]);
			expect(alter.constraintsToAdd ?? [], 'no spurious constraint add').to.deep.equal([]);

			await db.exec('apply schema main');

			// UNIQUE still enforces under the new column name.
			let rejected = false;
			try { await db.exec("insert into t values (3, 'a@x')"); } catch { rejected = true; }
			expect(rejected, 'UNIQUE still enforces under addr').to.be.true;

			expect(diffOf(db).tablesToAlter, 'idempotent re-apply produces no alter').to.deep.equal([]);
		} finally {
			await db.close();
		}
	});

	it('an FK whose PARENT TABLE is renamed emits ONLY the table rename on the child (no constraint drop+recreate)', async function () {
		const db = new Database();
		try {
			await db.exec('pragma foreign_keys = true');
			await db.exec(`declare schema main {
				table parent { pid INTEGER PRIMARY KEY }
				table child { id INTEGER PRIMARY KEY, pa INTEGER, constraint fk foreign key (pa) references parent(pid) }
			}`);
			await db.exec('apply schema main');
			await db.exec('insert into parent values (1), (2)');
			await db.exec('insert into child values (10, 1)');

			// Rename the parent table parent → p2 (table previous_name hint). The child FK
			// now references p2; its body is otherwise unchanged.
			await db.exec(`declare schema main {
				table p2 { pid INTEGER PRIMARY KEY } with tags ("quereus.previous_name" = 'parent')
				table child { id INTEGER PRIMARY KEY, pa INTEGER, constraint fk foreign key (pa) references p2(pid) }
			}`);
			const diff = diffOf(db);
			// The table rename rides the top-level renames bucket.
			expect(diff.renames, 'table rename detected at top level').to.deep.include({ kind: 'table', oldName: 'parent', newName: 'p2' });
			// The child alter (if any) must NOT churn the FK.
			const childAlter = diff.tablesToAlter.find(a => a.tableName.toLowerCase() === 'child');
			expect(childAlter?.constraintsToDrop ?? [], 'no spurious FK drop on child').to.deep.equal([]);
			expect(childAlter?.constraintsToAdd ?? [], 'no spurious FK add on child').to.deep.equal([]);

			await db.exec('apply schema main');

			// The FK still enforces against the renamed parent.
			expect(db.schemaManager.getTable('main', 'parent'), 'old parent name gone').to.be.undefined;
			expect(db.schemaManager.getTable('main', 'p2'), 'renamed parent present').to.not.be.undefined;
			await db.exec('insert into child values (11, 2)'); // valid reference
			let rejected = false;
			try { await db.exec('insert into child values (12, 99)'); } catch { rejected = true; }
			expect(rejected, 'orphan rejected by FK against renamed parent').to.be.true;

			expect(diffOf(db).tablesToAlter, 'idempotent re-apply produces no alter').to.deep.equal([]);
			expect(diffOf(db).renames, 'idempotent re-apply produces no further rename').to.deep.equal([]);
		} finally {
			await db.close();
		}
	});

	it('an FK whose LOCAL (child) column is renamed emits ONLY the column rename (no FK drop+recreate)', async function () {
		// Exercises the foreignKey-case child-column reconciliation
		// (inverseRenameConstraintColumns on clone.columns), distinct from the
		// parent-table-rename path above.
		const db = new Database();
		try {
			await db.exec('pragma foreign_keys = true');
			await db.exec(`declare schema main {
				table parent { pid INTEGER PRIMARY KEY }
				table child { id INTEGER PRIMARY KEY, pa INTEGER, constraint fk foreign key (pa) references parent(pid) }
			}`);
			await db.exec('apply schema main');
			await db.exec('insert into parent values (1), (2)');
			await db.exec('insert into child values (10, 1)');

			// Rename the child's local FK column pa → parent_id; the FK body is
			// otherwise unchanged (still references parent(pid)).
			await db.exec(`declare schema main {
				table parent { pid INTEGER PRIMARY KEY }
				table child {
					id INTEGER PRIMARY KEY,
					parent_id INTEGER with tags ("quereus.previous_name" = 'pa'),
					constraint fk foreign key (parent_id) references parent(pid)
				}
			}`);
			const diff = diffOf(db);
			const childAlter = diff.tablesToAlter.find(a => a.tableName.toLowerCase() === 'child');
			expect(childAlter?.columnsToRename, 'child column rename detected').to.deep.equal([{ oldName: 'pa', newName: 'parent_id' }]);
			expect(childAlter?.constraintsToDrop ?? [], 'no spurious FK drop on child').to.deep.equal([]);
			expect(childAlter?.constraintsToAdd ?? [], 'no spurious FK add on child').to.deep.equal([]);

			await db.exec('apply schema main');

			// The FK still enforces under the renamed local column.
			await db.exec('insert into child values (11, 2)'); // valid reference
			let rejected = false;
			try { await db.exec('insert into child values (12, 99)'); } catch { rejected = true; }
			expect(rejected, 'orphan rejected by FK under the renamed local column').to.be.true;

			expect(diffOf(db).tablesToAlter, 'idempotent re-apply produces no alter').to.deep.equal([]);
		} finally {
			await db.close();
		}
	});

	it('REGRESSION: a genuine body edit layered on a column rename still drops+recreates', async function () {
		// Precedence guard: reconciliation must NOT mask a real body change that
		// happens to coincide with a rename.
		const db = new Database();
		try {
			await db.exec(`declare schema main {
				table t { id INTEGER PRIMARY KEY, qty INTEGER, constraint chk check (qty > 0) }
			}`);
			await db.exec('apply schema main');

			// Rename qty → quantity AND tighten the predicate (> 0 → >= 0) at once.
			await db.exec(`declare schema main {
				table t {
					id INTEGER PRIMARY KEY,
					quantity INTEGER with tags ("quereus.previous_name" = 'qty'),
					constraint chk check (quantity >= 0)
				}
			}`);
			const diff = diffOf(db);
			const alter = diff.tablesToAlter[0];
			expect(alter.columnsToRename, 'column rename still detected').to.deep.equal([{ oldName: 'qty', newName: 'quantity' }]);
			expect(alter.constraintsToDrop, 'genuine body edit drops old chk').to.deep.equal(['chk']);
			expect(alter.constraintsToAdd?.length, 'genuine body edit adds new chk').to.equal(1);

			await db.exec('apply schema main');

			// New predicate enforced: quantity = 0 now allowed (was rejected under > 0).
			await db.exec('insert into t values (1, 0)');
			let rejected = false;
			try { await db.exec('insert into t values (2, -1)'); } catch { rejected = true; }
			expect(rejected, 'quantity < 0 rejected by the new predicate').to.be.true;

			expect(diffOf(db).tablesToAlter, 'idempotent re-apply produces no alter').to.deep.equal([]);
		} finally {
			await db.close();
		}
	});

	it('an FK whose referenced PARENT column is renamed does not drop+recreate the child FK', async function () {
		// The subject of this ticket: a parent-table column rename must reconcile the
		// child FK's *referenced parent column* cross-table, so the child FK is not
		// churned. (Renaming the parent's PK column `pid` is now reconciled by the PK
		// pass too — see ticket pk-column-rename-reconciliation — so the parent emits
		// ONLY a RENAME COLUMN and no `primaryKeyChange`. This case asserts the FK
		// churn is gone; the parent PK reconciliation has its own dedicated tests.)
		const db = new Database();
		try {
			await db.exec('pragma foreign_keys = true');
			await db.exec(`declare schema main {
				table parent { pid INTEGER PRIMARY KEY }
				table child { id INTEGER PRIMARY KEY, pa INTEGER, constraint fk foreign key (pa) references parent(pid) }
			}`);
			await db.exec('apply schema main');
			await db.exec('insert into parent values (1), (2)');
			await db.exec('insert into child values (10, 1)');

			// Rename the parent's referenced column pid → key (column previous_name hint).
			// The child FK now references parent(key); its body is otherwise unchanged.
			await db.exec(`declare schema main {
				table parent { key INTEGER PRIMARY KEY with tags ("quereus.previous_name" = 'pid') }
				table child { id INTEGER PRIMARY KEY, pa INTEGER, constraint fk foreign key (pa) references parent(key) }
			}`);
			const diff = diffOf(db);

			// The child FK must NOT churn — the referenced-parent-column rename reconciled.
			const childAlter = diff.tablesToAlter.find(a => a.tableName.toLowerCase() === 'child');
			expect(childAlter?.constraintsToDrop ?? [], 'no spurious FK drop on child').to.deep.equal([]);
			expect(childAlter?.constraintsToAdd ?? [], 'no spurious FK add on child').to.deep.equal([]);

			// The parent alter carries the column rename.
			const parentAlter = diff.tablesToAlter.find(a => a.tableName.toLowerCase() === 'parent');
			expect(parentAlter?.columnsToRename, 'parent column rename detected').to.deep.equal([{ oldName: 'pid', newName: 'key' }]);

			// DDL carries the parent RENAME COLUMN and NO FK drop/add on the child.
			const ddl = generateMigrationDDL(diff, 'main');
			expect(ddl.some(s => /RENAME COLUMN .*pid.* TO .*key/i.test(s)), `expected parent RENAME COLUMN, got:\n${ddl.join('\n')}`).to.be.true;
			expect(ddl.some(s => /DROP CONSTRAINT/i.test(s)), `no DROP CONSTRAINT, got:\n${ddl.join('\n')}`).to.be.false;
			expect(ddl.some(s => /ADD .*constraint/i.test(s)), `no ADD constraint, got:\n${ddl.join('\n')}`).to.be.false;

			await db.exec('apply schema main');

			// The FK still enforces against the renamed parent column.
			await db.exec('insert into child values (11, 2)'); // valid reference
			let rejected = false;
			try { await db.exec('insert into child values (12, 99)'); } catch { rejected = true; }
			expect(rejected, 'orphan rejected by FK against the renamed parent column').to.be.true;

			expect(diffOf(db).tablesToAlter, 'idempotent re-apply produces no alter').to.deep.equal([]);
			expect(diffOf(db).renames, 'idempotent re-apply produces no further rename').to.deep.equal([]);
		} finally {
			await db.close();
		}
	});

	it('an FK whose parent TABLE and referenced PARENT column are renamed together does not churn the child FK', async function () {
		// Exercises both inverse-rewrites on one clone: look up the parent's column
		// rename by the NEW parent name, then rewrite the table name back to OLD.
		const db = new Database();
		try {
			await db.exec('pragma foreign_keys = true');
			await db.exec(`declare schema main {
				table parent { pid INTEGER PRIMARY KEY }
				table child { id INTEGER PRIMARY KEY, pa INTEGER, constraint fk foreign key (pa) references parent(pid) }
			}`);
			await db.exec('apply schema main');
			await db.exec('insert into parent values (1), (2)');
			await db.exec('insert into child values (10, 1)');

			// Rename the parent table parent → p2 AND its column pid → key at once; the
			// child FK references the doubly-renamed parent under both new names.
			await db.exec(`declare schema main {
				table p2 { key INTEGER PRIMARY KEY with tags ("quereus.previous_name" = 'pid') } with tags ("quereus.previous_name" = 'parent')
				table child { id INTEGER PRIMARY KEY, pa INTEGER, constraint fk foreign key (pa) references p2(key) }
			}`);
			const diff = diffOf(db);

			// The table rename rides the top-level renames bucket.
			expect(diff.renames, 'table rename detected at top level').to.deep.include({ kind: 'table', oldName: 'parent', newName: 'p2' });
			// The renamed parent alter carries the column rename.
			const parentAlter = diff.tablesToAlter.find(a => a.tableName.toLowerCase() === 'p2');
			expect(parentAlter?.columnsToRename, 'parent column rename detected').to.deep.equal([{ oldName: 'pid', newName: 'key' }]);
			// The child FK must NOT churn.
			const childAlter = diff.tablesToAlter.find(a => a.tableName.toLowerCase() === 'child');
			expect(childAlter?.constraintsToDrop ?? [], 'no spurious FK drop on child').to.deep.equal([]);
			expect(childAlter?.constraintsToAdd ?? [], 'no spurious FK add on child').to.deep.equal([]);

			await db.exec('apply schema main');

			// The FK still enforces against the doubly-renamed parent.
			expect(db.schemaManager.getTable('main', 'parent'), 'old parent name gone').to.be.undefined;
			expect(db.schemaManager.getTable('main', 'p2'), 'renamed parent present').to.not.be.undefined;
			await db.exec('insert into child values (11, 2)'); // valid reference
			let rejected = false;
			try { await db.exec('insert into child values (12, 99)'); } catch { rejected = true; }
			expect(rejected, 'orphan rejected by FK against renamed parent+column').to.be.true;

			expect(diffOf(db).tablesToAlter, 'idempotent re-apply produces no alter').to.deep.equal([]);
			expect(diffOf(db).renames, 'idempotent re-apply produces no further rename').to.deep.equal([]);
		} finally {
			await db.close();
		}
	});

	it('a self-referential FK whose referenced column is renamed does not churn the FK', async function () {
		// The parent IS the current table, so the FK referenced-column reconcile uses
		// the current table's own entry in the cross-table rename map. The referenced
		// column is a non-PK UNIQUE column (not the PK) on purpose: it exercises the
		// UNIQUE + self-FK reconciliation cleanly. (Renaming the PK column instead is
		// now reconciled by the PK pass too — ticket pk-column-rename-reconciliation —
		// so it emits ONLY a RENAME COLUMN with no `primaryKeyChange`; that path has its
		// own dedicated tests. The orthogonal end-to-end ALTER PRIMARY KEY + deferred
		// self-FK case is guarded by the sibling REGRESSION case below.)
		const db = new Database();
		try {
			await db.exec('pragma foreign_keys = true');
			await db.exec(`declare schema main {
				table node {
					id INTEGER PRIMARY KEY,
					code TEXT,
					parent_code TEXT null,
					constraint uq unique (code),
					constraint fk foreign key (parent_code) references node(code)
				}
			}`);
			await db.exec('apply schema main');
			await db.exec("insert into node values (1, 'a', null), (2, 'b', 'a')");

			// Rename the referenced (self) column code → ucode; the FK references node(ucode).
			await db.exec(`declare schema main {
				table node {
					id INTEGER PRIMARY KEY,
					ucode TEXT with tags ("quereus.previous_name" = 'code'),
					parent_code TEXT null,
					constraint uq unique (ucode),
					constraint fk foreign key (parent_code) references node(ucode)
				}
			}`);
			const diff = diffOf(db);
			const nodeAlter = diff.tablesToAlter.find(a => a.tableName.toLowerCase() === 'node');
			expect(nodeAlter?.columnsToRename, 'self column rename detected').to.deep.equal([{ oldName: 'code', newName: 'ucode' }]);
			// Neither the self-FK nor the UNIQUE over the renamed column churns.
			expect(nodeAlter?.constraintsToDrop ?? [], 'no spurious self-FK / UNIQUE drop').to.deep.equal([]);
			expect(nodeAlter?.constraintsToAdd ?? [], 'no spurious self-FK / UNIQUE add').to.deep.equal([]);
			expect(nodeAlter?.primaryKeyChange, 'no PK change (referenced column is non-PK)').to.be.undefined;

			await db.exec('apply schema main');

			// The self-FK still enforces under the renamed referenced column.
			await db.exec("insert into node values (3, 'c', 'b')"); // valid self reference
			let rejected = false;
			try { await db.exec("insert into node values (4, 'd', 'zzz')"); } catch { rejected = true; }
			expect(rejected, 'orphan rejected by self-FK against the renamed column').to.be.true;

			expect(diffOf(db).tablesToAlter, 'idempotent re-apply produces no alter').to.deep.equal([]);
		} finally {
			await db.close();
		}
	});

	it('a CHECK with a QUALIFIED self-reference under a pure table rename emits ONLY the rename (no constraint churn)', async function () {
		// A table-qualified self-ref (`t.qty`) embeds the table name in the CHECK body;
		// the differ inverse-rewrites the qualifier NEW→OLD (the exact inverse of the
		// forward rewriter the rename migration runs) so a pure table rename matches the
		// actual (pre-rename) body — only the rename op is emitted.
		const db = new Database();
		try {
			await db.exec(`declare schema main {
				table t { id INTEGER PRIMARY KEY, qty INTEGER, constraint chk check (t.qty > 0) }
			}`);
			await db.exec('apply schema main');

			// Rename t → t2; the CHECK self-qualifier follows the new name.
			await db.exec(`declare schema main {
				table t2 { id INTEGER PRIMARY KEY, qty INTEGER, constraint chk check (t2.qty > 0) } with tags ("quereus.previous_name" = 't')
			}`);
			const diff = diffOf(db);
			expect(diff.renames, 'table rename detected').to.deep.include({ kind: 'table', oldName: 't', newName: 't2' });
			const alter = diff.tablesToAlter.find(a => a.tableName.toLowerCase() === 't2');
			expect(alter?.constraintsToDrop ?? [], 'no spurious CHECK drop').to.deep.equal([]);
			expect(alter?.constraintsToAdd ?? [], 'no spurious CHECK add').to.deep.equal([]);

			await db.exec('apply schema main');

			// The forward propagation rewrote the STORED qualifier (t.qty → t2.qty).
			const chk = collectSchemaCatalog(db, 'main').tables
				.find(t => t.name.toLowerCase() === 't2')!.namedConstraints
				.find(c => c.name.toLowerCase() === 'chk')!;
			expect(chk.definition, 'stored CHECK qualifier follows the rename').to.match(/t2\.qty > 0/i);

			// And the rewritten qualified self-ref still ENFORCES under the new name
			// (the constraint planner folds the qualifier at plan time).
			await db.exec('insert into t2 values (1, 5)');
			let rejected = false;
			try { await db.exec('insert into t2 values (2, -1)'); } catch { rejected = true; }
			expect(rejected, 'negative qty rejected by the renamed qualified CHECK').to.be.true;

			// Idempotent: re-diff is empty (relies on the forward qualifier propagation).
			expect(diffOf(db).tablesToAlter, 'idempotent re-apply produces no alter').to.deep.equal([]);
			expect(diffOf(db).renames, 'idempotent re-apply produces no further rename').to.deep.equal([]);
		} finally {
			await db.close();
		}
	});

	it('a CHECK with a qualified ref under a table rename PLUS a column rename does not churn (seed alignment)', async function () {
		// Covers the rewriter-seed bug: the declared qualifier carries the NEW table
		// name (`t2.amount`) while the column rewrite is seeded with the OLD name — the
		// qualifier-first inverse pass normalizes the qualifier to OLD so the OLD-seeded
		// column reconcile applies too. Without it, neither dimension reconciled and the
		// CHECK churned a drop+recreate.
		const db = new Database();
		try {
			await db.exec(`declare schema main {
				table t { id INTEGER PRIMARY KEY, qty INTEGER, constraint chk check (t.qty > 0) }
			}`);
			await db.exec('apply schema main');

			// Rename t → t2 AND qty → amount at once; the CHECK references both new names.
			await db.exec(`declare schema main {
				table t2 {
					id INTEGER PRIMARY KEY,
					amount INTEGER with tags ("quereus.previous_name" = 'qty'),
					constraint chk check (t2.amount > 0)
				} with tags ("quereus.previous_name" = 't')
			}`);
			const diff = diffOf(db);
			expect(diff.renames, 'table rename detected').to.deep.include({ kind: 'table', oldName: 't', newName: 't2' });
			const alter = diff.tablesToAlter.find(a => a.tableName.toLowerCase() === 't2');
			expect(alter?.columnsToRename, 'column rename detected').to.deep.equal([{ oldName: 'qty', newName: 'amount' }]);
			expect(alter?.constraintsToDrop ?? [], 'no spurious CHECK drop').to.deep.equal([]);
			expect(alter?.constraintsToAdd ?? [], 'no spurious CHECK add').to.deep.equal([]);

			await db.exec('apply schema main');

			// The forward propagation rewrote BOTH stored names: ALTER TABLE RENAME
			// rewrote the qualifier (t → t2), then RENAME COLUMN rewrote the column
			// under the new seed (qty → amount).
			const chk = collectSchemaCatalog(db, 'main').tables
				.find(t => t.name.toLowerCase() === 't2')!.namedConstraints
				.find(c => c.name.toLowerCase() === 'chk')!;
			expect(chk.definition, 'stored CHECK follows both renames').to.match(/t2\.amount > 0/i);

			// And it still ENFORCES under both new names.
			await db.exec('insert into t2 values (1, 5)');
			let rejected = false;
			try { await db.exec('insert into t2 values (2, -1)'); } catch { rejected = true; }
			expect(rejected, 'negative amount rejected by the doubly-renamed qualified CHECK').to.be.true;

			expect(diffOf(db).tablesToAlter, 'idempotent re-apply produces no alter').to.deep.equal([]);
			expect(diffOf(db).renames, 'idempotent re-apply produces no further rename').to.deep.equal([]);
		} finally {
			await db.close();
		}
	});

	it('REGRESSION: a genuine CHECK edit layered on a table rename still drops+recreates', async function () {
		// Precedence guard for the qualifier reconcile: a real body edit (> 0 → >= 0)
		// coinciding with the table rename survives the inverse-rewrite → drop+recreate.
		const db = new Database();
		try {
			await db.exec(`declare schema main {
				table t { id INTEGER PRIMARY KEY, qty INTEGER, constraint chk check (t.qty > 0) }
			}`);
			await db.exec('apply schema main');

			// Rename t → t2 AND loosen the predicate (> 0 → >= 0) at once.
			await db.exec(`declare schema main {
				table t2 { id INTEGER PRIMARY KEY, qty INTEGER, constraint chk check (t2.qty >= 0) } with tags ("quereus.previous_name" = 't')
			}`);
			const diff = diffOf(db);
			const alter = diff.tablesToAlter.find(a => a.tableName.toLowerCase() === 't2');
			expect(alter?.constraintsToDrop, 'genuine body edit drops old chk').to.deep.equal(['chk']);
			expect(alter?.constraintsToAdd?.length, 'genuine body edit adds new chk').to.equal(1);

			await db.exec('apply schema main');

			// The recreate installed the NEW predicate under the NEW qualifier.
			const chk = collectSchemaCatalog(db, 'main').tables
				.find(t => t.name.toLowerCase() === 't2')!.namedConstraints
				.find(c => c.name.toLowerCase() === 'chk')!;
			expect(chk.definition, 'recreated CHECK carries the edited predicate').to.match(/t2\.qty >= 0/i);

			// And the EDITED boundary enforces: 0 now passes (>= 0), -1 still rejects.
			await db.exec('insert into t2 values (1, 0)');
			let rejected = false;
			try { await db.exec('insert into t2 values (2, -1)'); } catch { rejected = true; }
			expect(rejected, 'negative qty rejected by the recreated qualified CHECK').to.be.true;

			expect(diffOf(db).tablesToAlter, 'idempotent re-apply produces no alter').to.deep.equal([]);
		} finally {
			await db.close();
		}
	});

	it('a CHECK with an UNQUALIFIED ref under a pure table rename does not churn (regression guard)', async function () {
		// An unqualified ref carries no table name, so the body is invariant under a
		// table rename — the qualifier pass must not disturb it.
		const db = new Database();
		try {
			await db.exec(`declare schema main {
				table t { id INTEGER PRIMARY KEY, qty INTEGER, constraint chk check (qty > 0) }
			}`);
			await db.exec('apply schema main');

			await db.exec(`declare schema main {
				table t2 { id INTEGER PRIMARY KEY, qty INTEGER, constraint chk check (qty > 0) } with tags ("quereus.previous_name" = 't')
			}`);
			const diff = diffOf(db);
			expect(diff.renames, 'table rename detected').to.deep.include({ kind: 'table', oldName: 't', newName: 't2' });
			const alter = diff.tablesToAlter.find(a => a.tableName.toLowerCase() === 't2');
			expect(alter?.constraintsToDrop ?? [], 'no spurious CHECK drop').to.deep.equal([]);
			expect(alter?.constraintsToAdd ?? [], 'no spurious CHECK add').to.deep.equal([]);
		} finally {
			await db.close();
		}
	});

	it('a CHECK whose subquery references ANOTHER renamed table emits ONLY the rename (no constraint churn)', async function () {
		// Cross-table reconcile: the CHECK body on `a` embeds a DIFFERENT table's name
		// inside a subquery (`select max(cap) from lim`). Renaming lim → lim2 must not
		// churn a's CHECK — the differ inverse-rewrites ALL in-diff table renames
		// (mirroring the forward rewriter, which walks every table's CHECKs), not just
		// the owning table's own rename.
		const db = new Database();
		try {
			await db.exec(`declare schema main {
				table lim { id INTEGER PRIMARY KEY, cap INTEGER }
				table a { id INTEGER PRIMARY KEY, qty INTEGER,
					constraint chk check (qty <= (select max(cap) from lim)) }
			}`);
			await db.exec('apply schema main');
			await db.exec('insert into lim values (1, 10)');

			// Rename lim → lim2; a's CHECK subquery follows the new name.
			await db.exec(`declare schema main {
				table lim2 { id INTEGER PRIMARY KEY, cap INTEGER } with tags ("quereus.previous_name" = 'lim')
				table a { id INTEGER PRIMARY KEY, qty INTEGER,
					constraint chk check (qty <= (select max(cap) from lim2)) }
			}`);
			const diff = diffOf(db);
			expect(diff.renames, 'table rename detected').to.deep.include({ kind: 'table', oldName: 'lim', newName: 'lim2' });
			const alter = diff.tablesToAlter.find(a => a.tableName.toLowerCase() === 'a');
			expect(alter?.constraintsToDrop ?? [], 'no spurious cross-table CHECK drop').to.deep.equal([]);
			expect(alter?.constraintsToAdd ?? [], 'no spurious cross-table CHECK add').to.deep.equal([]);

			await db.exec('apply schema main');

			// The forward propagation rewrote the STORED subquery reference (lim → lim2).
			const chk = collectSchemaCatalog(db, 'main').tables
				.find(t => t.name.toLowerCase() === 'a')!.namedConstraints
				.find(c => c.name.toLowerCase() === 'chk')!;
			expect(chk.definition, 'stored CHECK subquery follows the rename').to.match(/from lim2/i);

			// And the rewritten subquery still ENFORCES against the renamed table.
			await db.exec('insert into a values (1, 5)');
			let rejected = false;
			try { await db.exec('insert into a values (2, 99)'); } catch { rejected = true; }
			expect(rejected, 'over-cap qty rejected by the CHECK over the renamed table').to.be.true;

			expect(diffOf(db).tablesToAlter, 'idempotent re-apply produces no alter').to.deep.equal([]);
			expect(diffOf(db).renames, 'idempotent re-apply produces no further rename').to.deep.equal([]);
		} finally {
			await db.close();
		}
	});

	it('a CHECK referencing the OWNING and ANOTHER table, both renamed in one diff, does not churn', async function () {
		// Both halves at once: the owning table's qualified self-reference AND the
		// cross-table subquery reference each follow their table's rename. The all-
		// renames inverse loop reconciles both in one pass (each rename's inverse is
		// independent — resolveRenames makes chains/swaps unrepresentable).
		const db = new Database();
		try {
			await db.exec(`declare schema main {
				table lim { id INTEGER PRIMARY KEY, cap INTEGER }
				table a { id INTEGER PRIMARY KEY, qty INTEGER,
					constraint chk check (a.qty <= (select max(cap) from lim)) }
			}`);
			await db.exec('apply schema main');
			await db.exec('insert into lim values (1, 10)');

			// Rename BOTH tables; the CHECK references both new names.
			await db.exec(`declare schema main {
				table lim2 { id INTEGER PRIMARY KEY, cap INTEGER } with tags ("quereus.previous_name" = 'lim')
				table a2 { id INTEGER PRIMARY KEY, qty INTEGER,
					constraint chk check (a2.qty <= (select max(cap) from lim2)) } with tags ("quereus.previous_name" = 'a')
			}`);
			const diff = diffOf(db);
			expect(diff.renames, 'lim rename detected').to.deep.include({ kind: 'table', oldName: 'lim', newName: 'lim2' });
			expect(diff.renames, 'a rename detected').to.deep.include({ kind: 'table', oldName: 'a', newName: 'a2' });
			const alter = diff.tablesToAlter.find(a => a.tableName.toLowerCase() === 'a2');
			expect(alter?.constraintsToDrop ?? [], 'no spurious CHECK drop').to.deep.equal([]);
			expect(alter?.constraintsToAdd ?? [], 'no spurious CHECK add').to.deep.equal([]);

			await db.exec('apply schema main');

			// Both stored references follow their renames.
			const chk = collectSchemaCatalog(db, 'main').tables
				.find(t => t.name.toLowerCase() === 'a2')!.namedConstraints
				.find(c => c.name.toLowerCase() === 'chk')!;
			expect(chk.definition, 'stored self-qualifier follows the rename').to.match(/a2\.qty/i);
			expect(chk.definition, 'stored subquery reference follows the rename').to.match(/from lim2/i);

			// And the doubly-rewritten CHECK still ENFORCES.
			await db.exec('insert into a2 values (1, 5)');
			let rejected = false;
			try { await db.exec('insert into a2 values (2, 99)'); } catch { rejected = true; }
			expect(rejected, 'over-cap qty rejected after both renames').to.be.true;

			expect(diffOf(db).tablesToAlter, 'idempotent re-apply produces no alter').to.deep.equal([]);
			expect(diffOf(db).renames, 'idempotent re-apply produces no further rename').to.deep.equal([]);
		} finally {
			await db.close();
		}
	});

	it('REGRESSION: a genuine CHECK edit layered on a CROSS-table rename still drops+recreates', async function () {
		// Precedence guard for the cross-table reconcile: a real body edit (max → min)
		// coinciding with the referenced table's rename survives the inverse-rewrite
		// → drop+recreate, alongside the rename.
		const db = new Database();
		try {
			await db.exec(`declare schema main {
				table lim { id INTEGER PRIMARY KEY, cap INTEGER }
				table a { id INTEGER PRIMARY KEY, qty INTEGER,
					constraint chk check (qty <= (select max(cap) from lim)) }
			}`);
			await db.exec('apply schema main');
			await db.exec('insert into lim values (1, 10), (2, 3)');

			// Rename lim → lim2 AND tighten the predicate (max → min) at once.
			await db.exec(`declare schema main {
				table lim2 { id INTEGER PRIMARY KEY, cap INTEGER } with tags ("quereus.previous_name" = 'lim')
				table a { id INTEGER PRIMARY KEY, qty INTEGER,
					constraint chk check (qty <= (select min(cap) from lim2)) }
			}`);
			const diff = diffOf(db);
			const alter = diff.tablesToAlter.find(a => a.tableName.toLowerCase() === 'a');
			expect(alter?.constraintsToDrop, 'genuine body edit drops old chk').to.deep.equal(['chk']);
			expect(alter?.constraintsToAdd?.length, 'genuine body edit adds new chk').to.equal(1);

			await db.exec('apply schema main');

			// The recreate installed the EDITED predicate against the renamed table.
			const chk = collectSchemaCatalog(db, 'main').tables
				.find(t => t.name.toLowerCase() === 'a')!.namedConstraints
				.find(c => c.name.toLowerCase() === 'chk')!;
			expect(chk.definition, 'recreated CHECK carries the edited predicate').to.match(/min\(cap\)/i);
			expect(chk.definition, 'recreated CHECK references the renamed table').to.match(/from lim2/i);

			// And the EDITED boundary enforces: min(cap) = 3, so 3 passes and 5 rejects.
			await db.exec('insert into a values (1, 3)');
			let rejected = false;
			try { await db.exec('insert into a values (2, 5)'); } catch { rejected = true; }
			expect(rejected, 'qty above min(cap) rejected by the recreated CHECK').to.be.true;

			expect(diffOf(db).tablesToAlter, 'idempotent re-apply produces no alter').to.deep.equal([]);
		} finally {
			await db.close();
		}
	});

	it('a CHECK whose subquery references ANOTHER table\'s renamed COLUMN emits ONLY the rename (no constraint churn)', async function () {
		// Cross-table COLUMN reconcile: a's CHECK subquery references lim.cap; renaming
		// lim.cap → capacity must not churn a's CHECK — the differ inverse-rewrites
		// EVERY in-diff table's column renames (the cross-table loop, mirroring the
		// forward propagation which walks all tables' CHECKs), not just the owning
		// table's own renames.
		const db = new Database();
		try {
			await db.exec(`declare schema main {
				table lim { id INTEGER PRIMARY KEY, cap INTEGER }
				table a { id INTEGER PRIMARY KEY, qty INTEGER,
					constraint chk check (qty <= (select max(cap) from lim)) }
			}`);
			await db.exec('apply schema main');
			await db.exec('insert into lim values (1, 10)');

			// Rename lim.cap → capacity (column previous_name hint); a's CHECK subquery
			// follows the new column name.
			await db.exec(`declare schema main {
				table lim { id INTEGER PRIMARY KEY, capacity INTEGER with tags ("quereus.previous_name" = 'cap') }
				table a { id INTEGER PRIMARY KEY, qty INTEGER,
					constraint chk check (qty <= (select max(capacity) from lim)) }
			}`);
			const diff = diffOf(db);
			const limAlter = diff.tablesToAlter.find(t => t.tableName.toLowerCase() === 'lim');
			expect(limAlter?.columnsToRename, 'column rename detected on lim').to.deep.equal([{ oldName: 'cap', newName: 'capacity' }]);
			const aAlter = diff.tablesToAlter.find(t => t.tableName.toLowerCase() === 'a');
			expect(aAlter?.constraintsToDrop ?? [], 'no spurious cross-table CHECK drop').to.deep.equal([]);
			expect(aAlter?.constraintsToAdd ?? [], 'no spurious cross-table CHECK add').to.deep.equal([]);

			await db.exec('apply schema main');

			// The forward propagation rewrote the STORED subquery reference (cap → capacity).
			const chk = collectSchemaCatalog(db, 'main').tables
				.find(t => t.name.toLowerCase() === 'a')!.namedConstraints
				.find(c => c.name.toLowerCase() === 'chk')!;
			expect(chk.definition, 'stored CHECK subquery follows the column rename').to.match(/max\(capacity\)/i);

			// And the rewritten subquery still ENFORCES against the renamed column.
			await db.exec('insert into a values (1, 5)');
			let rejected = false;
			try { await db.exec('insert into a values (2, 99)'); } catch { rejected = true; }
			expect(rejected, 'over-cap qty rejected by the CHECK over the renamed column').to.be.true;

			expect(diffOf(db).tablesToAlter, 'idempotent re-apply produces no alter').to.deep.equal([]);
		} finally {
			await db.close();
		}
	});

	it('a referenced table renamed AND column-renamed in one diff does not churn the referencing CHECK', async function () {
		// Compound on the REFERENCED table: lim → lim2 and cap → capacity at once.
		// The CHECK reconcile inverse-applies the table rename (qualifier pass), then
		// looks up the column renames under the DECLARED (new) table name and maps the
		// walk's seed back to the OLD name — both halves must compose.
		const db = new Database();
		try {
			await db.exec(`declare schema main {
				table lim { id INTEGER PRIMARY KEY, cap INTEGER }
				table a { id INTEGER PRIMARY KEY, qty INTEGER,
					constraint chk check (qty <= (select max(cap) from lim)) }
			}`);
			await db.exec('apply schema main');
			await db.exec('insert into lim values (1, 10)');

			await db.exec(`declare schema main {
				table lim2 { id INTEGER PRIMARY KEY, capacity INTEGER with tags ("quereus.previous_name" = 'cap') } with tags ("quereus.previous_name" = 'lim')
				table a { id INTEGER PRIMARY KEY, qty INTEGER,
					constraint chk check (qty <= (select max(capacity) from lim2)) }
			}`);
			const diff = diffOf(db);
			expect(diff.renames, 'table rename detected').to.deep.include({ kind: 'table', oldName: 'lim', newName: 'lim2' });
			const limAlter = diff.tablesToAlter.find(t => t.tableName.toLowerCase() === 'lim2');
			expect(limAlter?.columnsToRename, 'column rename detected on lim2').to.deep.equal([{ oldName: 'cap', newName: 'capacity' }]);
			const aAlter = diff.tablesToAlter.find(t => t.tableName.toLowerCase() === 'a');
			expect(aAlter?.constraintsToDrop ?? [], 'no spurious CHECK drop').to.deep.equal([]);
			expect(aAlter?.constraintsToAdd ?? [], 'no spurious CHECK add').to.deep.equal([]);

			await db.exec('apply schema main');

			// Both stored references follow their renames.
			const chk = collectSchemaCatalog(db, 'main').tables
				.find(t => t.name.toLowerCase() === 'a')!.namedConstraints
				.find(c => c.name.toLowerCase() === 'chk')!;
			expect(chk.definition, 'stored subquery table reference follows the rename').to.match(/from lim2/i);
			expect(chk.definition, 'stored subquery column reference follows the rename').to.match(/max\(capacity\)/i);

			await db.exec('insert into a values (1, 5)');
			let rejected = false;
			try { await db.exec('insert into a values (2, 99)'); } catch { rejected = true; }
			expect(rejected, 'over-cap qty rejected after both renames').to.be.true;

			expect(diffOf(db).tablesToAlter, 'idempotent re-apply produces no alter').to.deep.equal([]);
			expect(diffOf(db).renames, 'idempotent re-apply produces no further rename').to.deep.equal([]);
		} finally {
			await db.close();
		}
	});

	it('a cross-table column rename only reconciles the SUBQUERY ref when the owning table has a like-named column', async function () {
		// Scope guard for the cross-table loop: a's CHECK uses `cap` twice — the outer
		// ref binds to a's OWN cap column (unrenamed), the inner to lim.cap (renamed).
		// The inverse walk for lim's rename is the plain scope-aware `renameColumnInAst`
		// (forward parity): an unqualified ref only rewrites inside a FROM frame that
		// binds lim, so ONLY the inner ref reconciles.
		const db = new Database();
		try {
			await db.exec(`declare schema main {
				table lim { id INTEGER PRIMARY KEY, cap INTEGER }
				table a { id INTEGER PRIMARY KEY, cap INTEGER,
					constraint chk check (cap <= (select max(cap) from lim)) }
			}`);
			await db.exec('apply schema main');
			await db.exec('insert into lim values (1, 10)');

			// Rename lim.cap → capacity; a's own cap column keeps its name, so only the
			// declared subquery ref changes spelling.
			await db.exec(`declare schema main {
				table lim { id INTEGER PRIMARY KEY, capacity INTEGER with tags ("quereus.previous_name" = 'cap') }
				table a { id INTEGER PRIMARY KEY, cap INTEGER,
					constraint chk check (cap <= (select max(capacity) from lim)) }
			}`);
			const diff = diffOf(db);
			const limAlter = diff.tablesToAlter.find(t => t.tableName.toLowerCase() === 'lim');
			expect(limAlter?.columnsToRename, 'column rename detected on lim').to.deep.equal([{ oldName: 'cap', newName: 'capacity' }]);
			const aAlter = diff.tablesToAlter.find(t => t.tableName.toLowerCase() === 'a');
			expect(aAlter?.constraintsToDrop ?? [], 'no spurious CHECK drop').to.deep.equal([]);
			expect(aAlter?.constraintsToAdd ?? [], 'no spurious CHECK add').to.deep.equal([]);

			await db.exec('apply schema main');

			// Only the inner ref followed the rename; the outer still names a.cap.
			const chk = collectSchemaCatalog(db, 'main').tables
				.find(t => t.name.toLowerCase() === 'a')!.namedConstraints
				.find(c => c.name.toLowerCase() === 'chk')!;
			expect(chk.definition, 'inner subquery ref follows the rename').to.match(/max\(capacity\)/i);
			expect(chk.definition, 'outer ref keeps the owning column name').to.match(/cap <=/i);
			expect(chk.definition, 'outer ref not falsely renamed').to.not.match(/capacity <=/i);

			await db.exec('insert into a values (1, 5)');
			let rejected = false;
			try { await db.exec('insert into a values (2, 99)'); } catch { rejected = true; }
			expect(rejected, 'over-cap value rejected by the CHECK').to.be.true;

			expect(diffOf(db).tablesToAlter, 'idempotent re-apply produces no alter').to.deep.equal([]);
		} finally {
			await db.close();
		}
	});

	it('an owning-column rename whose NEW name matches the referenced table\'s column does not churn (scope resolver)', async function () {
		// Gap-B guard: rename a.qty → cap where the referenced table lim ALSO has a
		// column cap. The owning-table inverse (cap → qty, seeded on a) must NOT
		// capture the inner unqualified `cap` — the declared-side scope resolver sees
		// lim (the subquery's FROM source) exposing `cap`, so the inner ref binds
		// there, exactly as the forward seeded rewrite with the live resolver decides.
		const db = new Database();
		try {
			await db.exec(`declare schema main {
				table lim { id INTEGER PRIMARY KEY, cap INTEGER }
				table a { id INTEGER PRIMARY KEY, qty INTEGER,
					constraint chk check (qty <= (select max(cap) from lim)) }
			}`);
			await db.exec('apply schema main');
			await db.exec('insert into lim values (1, 10)');

			// Rename a.qty → cap; the inner subquery ref legitimately keeps naming lim.cap.
			await db.exec(`declare schema main {
				table lim { id INTEGER PRIMARY KEY, cap INTEGER }
				table a { id INTEGER PRIMARY KEY, cap INTEGER with tags ("quereus.previous_name" = 'qty'),
					constraint chk check (cap <= (select max(cap) from lim)) }
			}`);
			const diff = diffOf(db);
			const aAlter = diff.tablesToAlter.find(t => t.tableName.toLowerCase() === 'a');
			expect(aAlter?.columnsToRename, 'column rename detected on a').to.deep.equal([{ oldName: 'qty', newName: 'cap' }]);
			expect(aAlter?.constraintsToDrop ?? [], 'no spurious CHECK drop').to.deep.equal([]);
			expect(aAlter?.constraintsToAdd ?? [], 'no spurious CHECK add').to.deep.equal([]);

			await db.exec('apply schema main');

			// The stored body renamed the outer ref and left the inner lim.cap ref alone.
			const chk = collectSchemaCatalog(db, 'main').tables
				.find(t => t.name.toLowerCase() === 'a')!.namedConstraints
				.find(c => c.name.toLowerCase() === 'chk')!;
			expect(chk.definition, 'outer ref follows the owning rename').to.match(/cap <=/i);
			expect(chk.definition, 'inner ref still names lim.cap').to.match(/max\(cap\)/i);

			await db.exec('insert into a values (1, 5)');
			let rejected = false;
			try { await db.exec('insert into a values (2, 99)'); } catch { rejected = true; }
			expect(rejected, 'over-cap value rejected under the renamed column').to.be.true;

			expect(diffOf(db).tablesToAlter, 'idempotent re-apply produces no alter').to.deep.equal([]);
		} finally {
			await db.close();
		}
	});

	it('an owning rename AND a referenced-table column rename in ONE CHECK reconcile together (ordering)', async function () {
		// Compound ordering guard: a.qty → cap and lim.cap → capacity in one diff,
		// both referenced by a's CHECK. The owning-table inverse must run FIRST: it
		// turns the outer `cap` back to qty while the inner ref still spells
		// `capacity` (no false match); the cross-table loop then maps the inner ref
		// capacity → cap. Run cross-first and the inner ref becomes `cap` in time for
		// the owning inverse to falsely capture it.
		const db = new Database();
		try {
			await db.exec(`declare schema main {
				table lim { id INTEGER PRIMARY KEY, cap INTEGER }
				table a { id INTEGER PRIMARY KEY, qty INTEGER,
					constraint chk check (qty <= (select max(cap) from lim)) }
			}`);
			await db.exec('apply schema main');
			await db.exec('insert into lim values (1, 10)');

			await db.exec(`declare schema main {
				table lim { id INTEGER PRIMARY KEY, capacity INTEGER with tags ("quereus.previous_name" = 'cap') }
				table a { id INTEGER PRIMARY KEY, cap INTEGER with tags ("quereus.previous_name" = 'qty'),
					constraint chk check (cap <= (select max(capacity) from lim)) }
			}`);
			const diff = diffOf(db);
			const limAlter = diff.tablesToAlter.find(t => t.tableName.toLowerCase() === 'lim');
			expect(limAlter?.columnsToRename, 'column rename detected on lim').to.deep.equal([{ oldName: 'cap', newName: 'capacity' }]);
			const aAlter = diff.tablesToAlter.find(t => t.tableName.toLowerCase() === 'a');
			expect(aAlter?.columnsToRename, 'column rename detected on a').to.deep.equal([{ oldName: 'qty', newName: 'cap' }]);
			expect(aAlter?.constraintsToDrop ?? [], 'no spurious CHECK drop').to.deep.equal([]);
			expect(aAlter?.constraintsToAdd ?? [], 'no spurious CHECK add').to.deep.equal([]);

			await db.exec('apply schema main');

			// Both stored refs follow their respective renames.
			const chk = collectSchemaCatalog(db, 'main').tables
				.find(t => t.name.toLowerCase() === 'a')!.namedConstraints
				.find(c => c.name.toLowerCase() === 'chk')!;
			expect(chk.definition, 'outer ref follows the owning rename').to.match(/cap <=/i);
			expect(chk.definition, 'inner ref follows the cross-table rename').to.match(/max\(capacity\)/i);

			await db.exec('insert into a values (1, 5)');
			let rejected = false;
			try { await db.exec('insert into a values (2, 99)'); } catch { rejected = true; }
			expect(rejected, 'over-cap value rejected after both renames').to.be.true;

			expect(diffOf(db).tablesToAlter, 'idempotent re-apply produces no alter').to.deep.equal([]);
		} finally {
			await db.close();
		}
	});

	it('REGRESSION: a genuine CHECK edit layered on a CROSS-table COLUMN rename still drops+recreates', async function () {
		// Precedence guard for the cross-table column reconcile: a real body edit
		// (max → min) coinciding with the referenced column's rename survives the
		// inverse-rewrite → drop+recreate, alongside the rename.
		const db = new Database();
		try {
			await db.exec(`declare schema main {
				table lim { id INTEGER PRIMARY KEY, cap INTEGER }
				table a { id INTEGER PRIMARY KEY, qty INTEGER,
					constraint chk check (qty <= (select max(cap) from lim)) }
			}`);
			await db.exec('apply schema main');
			await db.exec('insert into lim values (1, 10), (2, 3)');

			// Rename lim.cap → capacity AND tighten the predicate (max → min) at once.
			await db.exec(`declare schema main {
				table lim { id INTEGER PRIMARY KEY, capacity INTEGER with tags ("quereus.previous_name" = 'cap') }
				table a { id INTEGER PRIMARY KEY, qty INTEGER,
					constraint chk check (qty <= (select min(capacity) from lim)) }
			}`);
			const diff = diffOf(db);
			const aAlter = diff.tablesToAlter.find(t => t.tableName.toLowerCase() === 'a');
			expect(aAlter?.constraintsToDrop, 'genuine body edit drops old chk').to.deep.equal(['chk']);
			expect(aAlter?.constraintsToAdd?.length, 'genuine body edit adds new chk').to.equal(1);

			await db.exec('apply schema main');

			// The recreate installed the EDITED predicate against the renamed column.
			const chk = collectSchemaCatalog(db, 'main').tables
				.find(t => t.name.toLowerCase() === 'a')!.namedConstraints
				.find(c => c.name.toLowerCase() === 'chk')!;
			expect(chk.definition, 'recreated CHECK carries the edited predicate').to.match(/min\(capacity\)/i);

			// And the EDITED boundary enforces: min(capacity) = 3, so 3 passes and 5 rejects.
			await db.exec('insert into a values (1, 3)');
			let rejected = false;
			try { await db.exec('insert into a values (2, 5)'); } catch { rejected = true; }
			expect(rejected, 'qty above min(capacity) rejected by the recreated CHECK').to.be.true;

			expect(diffOf(db).tablesToAlter, 'idempotent re-apply produces no alter').to.deep.equal([]);
		} finally {
			await db.close();
		}
	});

	it('an owning rename colliding with a TABLE-renamed referenced table\'s column does not churn (resolver old→new mapping)', async function () {
		// The declared-side resolver's table-name mapping branch: the qualifier pass
		// pre-normalizes the subquery's FROM to the OLD name (lim2 → lim), so the
		// resolver must map that seed back to the DECLARED name (lim2) before the
		// declared column lookup. Renaming a.qty → cap while lim → lim2 keeps its
		// `cap` column: the inner unqualified `cap` binds to lim2's own column and
		// must not be falsely inverse-captured by the owning seed.
		const db = new Database();
		try {
			await db.exec(`declare schema main {
				table lim { id INTEGER PRIMARY KEY, cap INTEGER }
				table a { id INTEGER PRIMARY KEY, qty INTEGER,
					constraint chk check (qty <= (select max(cap) from lim)) }
			}`);
			await db.exec('apply schema main');
			await db.exec('insert into lim values (1, 10)');

			// Rename the TABLE lim → lim2 (column cap kept) AND a.qty → cap in one diff.
			await db.exec(`declare schema main {
				table lim2 { id INTEGER PRIMARY KEY, cap INTEGER } with tags ("quereus.previous_name" = 'lim')
				table a { id INTEGER PRIMARY KEY, cap INTEGER with tags ("quereus.previous_name" = 'qty'),
					constraint chk check (cap <= (select max(cap) from lim2)) }
			}`);
			const diff = diffOf(db);
			expect(diff.renames, 'table rename detected').to.deep.include({ kind: 'table', oldName: 'lim', newName: 'lim2' });
			const aAlter = diff.tablesToAlter.find(t => t.tableName.toLowerCase() === 'a');
			expect(aAlter?.columnsToRename, 'column rename detected on a').to.deep.equal([{ oldName: 'qty', newName: 'cap' }]);
			expect(aAlter?.constraintsToDrop ?? [], 'no spurious CHECK drop').to.deep.equal([]);
			expect(aAlter?.constraintsToAdd ?? [], 'no spurious CHECK add').to.deep.equal([]);

			await db.exec('apply schema main');

			// Outer ref follows the owning rename; the inner ref still names lim2's own cap.
			const chk = collectSchemaCatalog(db, 'main').tables
				.find(t => t.name.toLowerCase() === 'a')!.namedConstraints
				.find(c => c.name.toLowerCase() === 'chk')!;
			expect(chk.definition, 'outer ref follows the owning rename').to.match(/cap <=/i);
			expect(chk.definition, 'inner ref keeps the referenced column').to.match(/max\(cap\)/i);
			expect(chk.definition, 'subquery table reference follows the table rename').to.match(/from lim2/i);

			await db.exec('insert into a values (1, 5)');
			let rejected = false;
			try { await db.exec('insert into a values (2, 99)'); } catch { rejected = true; }
			expect(rejected, 'over-cap value rejected after both renames').to.be.true;

			expect(diffOf(db).tablesToAlter, 'idempotent re-apply produces no alter').to.deep.equal([]);
			expect(diffOf(db).renames, 'idempotent re-apply produces no further rename').to.deep.equal([]);
		} finally {
			await db.close();
		}
	});

	it('REGRESSION: a genuine ALTER PRIMARY KEY on a self-referential-FK table commits with the deferred self-FK enforced', async function () {
		// A genuine PK change — here flipping the key to descending — emits an ALTER
		// PRIMARY KEY, isolated from any column rename. This case guarded an engine fix
		// to the memory-table REBUILD path, which orphaned the old manager while leaving
		// its VirtualTableConnection registered; the next insert then registered a second
		// connection under the same name, tripping DeferredConstraintQueue.findConnection
		// ("multiple candidate connections") when the deferred self-FK fired at commit.
		// The memory module now re-keys in place and keeps its manager, so the whole
		// stale-connection shape is structurally unreachable — this stays as the
		// end-to-end guard that a genuine PK change commits with the self-FK enforced.
		//
		// This case formerly drove the ALTER PRIMARY KEY via a *pure PK-column rename*;
		// ticket pk-column-rename-reconciliation now reconciles such a rename to emit ONLY
		// a RENAME COLUMN (no ALTER PRIMARY KEY), so a genuine PK change is used here to
		// keep exercising the ALTER PRIMARY KEY path.
		const db = new Database();
		try {
			await db.exec('pragma foreign_keys = true');
			await db.exec(`declare schema main {
				table node {
					code INTEGER PRIMARY KEY,
					parent_code INTEGER null,
					constraint fk foreign key (parent_code) references node(code)
				}
			}`);
			await db.exec('apply schema main');
			await db.exec('insert into node values (1, null), (2, 1)');

			// Genuine PK change: flip the key to descending. Emits an ALTER PRIMARY KEY
			// that re-keys the memory table; the self-FK still references node(code).
			await db.exec(`declare schema main {
				table node {
					code INTEGER PRIMARY KEY desc,
					parent_code INTEGER null,
					constraint fk foreign key (parent_code) references node(code)
				}
			}`);

			// Confirm this is a genuine PK change — it must reach ALTER PRIMARY KEY, not
			// silently no-op.
			const pkDiff = diffOf(db);
			const nodeAlter = pkDiff.tablesToAlter.find(a => a.tableName.toLowerCase() === 'node');
			expect(nodeAlter?.primaryKeyChange, 'genuine PK change emits ALTER PRIMARY KEY').to.not.be.undefined;
			expect(nodeAlter?.columnsToRename ?? [], 'no column rename in this case').to.deep.equal([]);

			await db.exec('apply schema main');

			// Valid self reference commits (this is the insert that previously threw at commit).
			await db.exec('insert into node values (3, 2)');

			// An orphaned parent reference is still rejected by the deferred self-FK at commit.
			let rejected = false;
			try { await db.exec('insert into node values (4, 999)'); } catch { rejected = true; }
			expect(rejected, 'orphan rejected by self-FK after the PK rebuild').to.be.true;
		} finally {
			await db.close();
		}
	});

	it('REGRESSION: a genuine FK body edit layered on a parent-column rename still drops+recreates', async function () {
		// Precedence guard: reconciling the referenced-parent-column rename must NOT
		// mask a real FK body change (here, adding ON DELETE CASCADE) that coincides
		// with it.
		const db = new Database();
		try {
			await db.exec('pragma foreign_keys = true');
			await db.exec(`declare schema main {
				table parent { pid INTEGER PRIMARY KEY }
				table child { id INTEGER PRIMARY KEY, pa INTEGER, constraint fk foreign key (pa) references parent(pid) }
			}`);
			await db.exec('apply schema main');
			await db.exec('insert into parent values (1), (2)');
			await db.exec('insert into child values (10, 1)');

			// Rename parent.pid → key AND add ON DELETE CASCADE to the child FK at once.
			await db.exec(`declare schema main {
				table parent { key INTEGER PRIMARY KEY with tags ("quereus.previous_name" = 'pid') }
				table child { id INTEGER PRIMARY KEY, pa INTEGER, constraint fk foreign key (pa) references parent(key) on delete cascade }
			}`);
			const diff = diffOf(db);
			const childAlter = diff.tablesToAlter.find(a => a.tableName.toLowerCase() === 'child');
			expect(childAlter?.constraintsToDrop, 'genuine FK body edit drops old fk').to.deep.equal(['fk']);
			expect(childAlter?.constraintsToAdd?.length, 'genuine FK body edit adds new fk').to.equal(1);

			await db.exec('apply schema main');

			// ON DELETE CASCADE now installed: deleting the parent row cascades to the child.
			await db.exec('delete from parent where key = 1');
			const survivors: Array<Record<string, unknown>> = [];
			for await (const r of db.eval('select count(*) as n from child where pa = 1')) survivors.push(r);
			expect(survivors[0].n, 'child rows cascaded away with the parent').to.equal(0);

			expect(diffOf(db).tablesToAlter, 'idempotent re-apply produces no alter').to.deep.equal([]);
		} finally {
			await db.close();
		}
	});

	it('an FK with an ELIDED referenced-column list does not churn when the parent PK column is renamed', async function () {
		// `references parent` (no column list) resolves to the parent PK at enforcement
		// time but the canonical body keeps the list elided on both sides, so a parent
		// PK-column rename never touches the FK body — the undefined reconcile path is a
		// genuine no-op and must NOT synthesize a column list. (The parent still emits a
		// benign PK change; orthogonal — see review handoff Gap #1.)
		const db = new Database();
		try {
			await db.exec('pragma foreign_keys = true');
			await db.exec(`declare schema main {
				table parent { pid INTEGER PRIMARY KEY }
				table child { id INTEGER PRIMARY KEY, pa INTEGER, constraint fk foreign key (pa) references parent }
			}`);
			await db.exec('apply schema main');
			await db.exec('insert into parent values (1), (2)');
			await db.exec('insert into child values (10, 1)');

			await db.exec(`declare schema main {
				table parent { key INTEGER PRIMARY KEY with tags ("quereus.previous_name" = 'pid') }
				table child { id INTEGER PRIMARY KEY, pa INTEGER, constraint fk foreign key (pa) references parent }
			}`);
			const diff = diffOf(db);
			const childAlter = diff.tablesToAlter.find(a => a.tableName.toLowerCase() === 'child');
			expect(childAlter?.constraintsToDrop ?? [], 'no spurious FK drop on child (elided list)').to.deep.equal([]);
			expect(childAlter?.constraintsToAdd ?? [], 'no spurious FK add on child (elided list)').to.deep.equal([]);

			await db.exec('apply schema main');
			await db.exec('insert into child values (11, 2)');
			let rejected = false;
			try { await db.exec('insert into child values (12, 99)'); } catch { rejected = true; }
			expect(rejected, 'orphan rejected by FK against the elided (PK) reference').to.be.true;
			expect(diffOf(db).tablesToAlter, 'idempotent re-apply produces no alter').to.deep.equal([]);
		} finally {
			await db.close();
		}
	});

	it('a multi-column FK churns nothing when only ONE referenced parent column is renamed', async function () {
		// Per-entry inverse rename: only the renamed referenced column is rewritten; the
		// unchanged sibling is left alone, and the reconciled body still matches actual.
		const db = new Database();
		try {
			await db.exec('pragma foreign_keys = true');
			await db.exec(`declare schema main {
				table parent { a INTEGER, b INTEGER, primary key (a, b) }
				table child { id INTEGER PRIMARY KEY, ca INTEGER, cb INTEGER, constraint fk foreign key (ca, cb) references parent(a, b) }
			}`);
			await db.exec('apply schema main');
			await db.exec('insert into parent values (1, 2), (3, 4)');
			await db.exec('insert into child values (10, 1, 2)');

			// Rename ONLY parent.b → bb; the FK now references parent(a, bb).
			await db.exec(`declare schema main {
				table parent { a INTEGER, bb INTEGER with tags ("quereus.previous_name" = 'b'), primary key (a, bb) }
				table child { id INTEGER PRIMARY KEY, ca INTEGER, cb INTEGER, constraint fk foreign key (ca, cb) references parent(a, bb) }
			}`);
			const diff = diffOf(db);
			const parentAlter = diff.tablesToAlter.find(a => a.tableName.toLowerCase() === 'parent');
			expect(parentAlter?.columnsToRename, 'only b → bb renamed').to.deep.equal([{ oldName: 'b', newName: 'bb' }]);
			const childAlter = diff.tablesToAlter.find(a => a.tableName.toLowerCase() === 'child');
			expect(childAlter?.constraintsToDrop ?? [], 'no spurious FK drop on child (partial multi-col)').to.deep.equal([]);
			expect(childAlter?.constraintsToAdd ?? [], 'no spurious FK add on child (partial multi-col)').to.deep.equal([]);

			await db.exec('apply schema main');
			await db.exec('insert into child values (11, 3, 4)');
			let rejected = false;
			try { await db.exec('insert into child values (12, 9, 9)'); } catch { rejected = true; }
			expect(rejected, 'orphan rejected by multi-col FK against renamed referenced column').to.be.true;
			expect(diffOf(db).tablesToAlter, 'idempotent re-apply produces no alter').to.deep.equal([]);
		} finally {
			await db.close();
		}
	});

	it('a pure parent-column rename does not churn the child FK even under the require-hint policy', async function () {
		// The reconcile suppresses the child FK drop+recreate, so its add/drop buckets
		// stay empty and the `require-hint` ambiguous-rename guard has nothing to trip on
		// (the rename itself is hinted via previous_name).
		const db = new Database();
		try {
			await db.exec('pragma foreign_keys = true');
			await db.exec(`declare schema main {
				table parent { pid INTEGER PRIMARY KEY }
				table child { id INTEGER PRIMARY KEY, pa INTEGER, constraint fk foreign key (pa) references parent(pid) }
			}`);
			await db.exec('apply schema main');

			await db.exec(`declare schema main {
				table parent { key INTEGER PRIMARY KEY with tags ("quereus.previous_name" = 'pid') }
				table child { id INTEGER PRIMARY KEY, pa INTEGER, constraint fk foreign key (pa) references parent(key) }
			}`);
			// Diff under require-hint must not throw and must not churn the child FK.
			const diff = computeSchemaDiff(
				db.declaredSchemaManager.getDeclaredSchema('main')!,
				collectSchemaCatalog(db, 'main'),
				'require-hint',
			);
			const childAlter = diff.tablesToAlter.find(a => a.tableName.toLowerCase() === 'child');
			expect(childAlter?.constraintsToDrop ?? [], 'no spurious FK drop on child (require-hint)').to.deep.equal([]);
			expect(childAlter?.constraintsToAdd ?? [], 'no spurious FK add on child (require-hint)').to.deep.equal([]);
		} finally {
			await db.close();
		}
	});

	it('a pure PK-column rename emits ONLY the RENAME COLUMN (no ALTER PRIMARY KEY)', async function () {
		// The subject of ticket pk-column-rename-reconciliation: renaming a PK column
		// must reconcile the declared PK sequence against the in-diff column rename, so
		// only the RENAME COLUMN is emitted — no spurious `primaryKeyChange`. Mirrors the
		// constraint-body reconciliation (reconciledDeclaredBody).
		const db = new Database();
		try {
			await db.exec(`declare schema main {
				table t { id INTEGER PRIMARY KEY }
			}`);
			await db.exec('apply schema main');
			await db.exec('insert into t values (1), (2)');

			// Rename the PK column id → pk; the PK is otherwise unchanged.
			await db.exec(`declare schema main {
				table t { pk INTEGER PRIMARY KEY with tags ("quereus.previous_name" = 'id') }
			}`);
			const diff = diffOf(db);
			expect(diff.tablesToAlter.length, 'one alter for the column rename').to.equal(1);
			const alter = diff.tablesToAlter[0];
			expect(alter.columnsToRename, 'PK column rename detected').to.deep.equal([{ oldName: 'id', newName: 'pk' }]);
			expect(alter.primaryKeyChange, 'no spurious PK change for a pure PK-column rename').to.be.undefined;

			// The migration DDL must carry the RENAME COLUMN and NO ALTER PRIMARY KEY.
			const ddl = generateMigrationDDL(diff, 'main');
			expect(ddl.some(s => /RENAME COLUMN .*id.* TO .*pk/i.test(s)), `expected RENAME COLUMN, got:\n${ddl.join('\n')}`).to.be.true;
			expect(ddl.some(s => /ALTER PRIMARY KEY/i.test(s)), `no ALTER PRIMARY KEY, got:\n${ddl.join('\n')}`).to.be.false;

			await db.exec('apply schema main');

			// The PK still enforces under the renamed column (duplicate rejected).
			let rejected = false;
			try { await db.exec('insert into t values (1)'); } catch { rejected = true; }
			expect(rejected, 'PK uniqueness still enforces under pk').to.be.true;

			// Idempotent: the rename has landed, no further alter.
			expect(diffOf(db).tablesToAlter, 'idempotent re-apply produces no alter').to.deep.equal([]);
		} finally {
			await db.close();
		}
	});

	it('a composite PK with one renamed member emits no ALTER PRIMARY KEY', async function () {
		// One member of a composite PK is renamed; the reconciled PK sequence still
		// matches the actual (pre-rename) key, so no `primaryKeyChange` is emitted.
		const db = new Database();
		try {
			await db.exec(`declare schema main {
				table t { a INTEGER, b INTEGER, constraint pk primary key (a, b) }
			}`);
			await db.exec('apply schema main');
			await db.exec('insert into t values (1, 2), (3, 4)');

			// Rename a → a2; the composite PK is otherwise unchanged (a2, b).
			await db.exec(`declare schema main {
				table t {
					a2 INTEGER with tags ("quereus.previous_name" = 'a'),
					b INTEGER,
					constraint pk primary key (a2, b)
				}
			}`);
			const diff = diffOf(db);
			const alter = diff.tablesToAlter[0];
			expect(alter.columnsToRename, 'composite PK member rename detected').to.deep.equal([{ oldName: 'a', newName: 'a2' }]);
			expect(alter.primaryKeyChange, 'no spurious PK change for a composite PK member rename').to.be.undefined;

			await db.exec('apply schema main');

			// The composite PK still enforces (duplicate (a2, b) rejected).
			let rejected = false;
			try { await db.exec('insert into t values (1, 2)'); } catch { rejected = true; }
			expect(rejected, 'composite PK uniqueness still enforces under a2').to.be.true;

			expect(diffOf(db).tablesToAlter, 'idempotent re-apply produces no alter').to.deep.equal([]);
		} finally {
			await db.close();
		}
	});

	it('a default-PK table (no explicit PRIMARY KEY) renaming a column emits no ALTER PRIMARY KEY', async function () {
		// A table with no explicit PRIMARY KEY defaults to all columns being the key
		// (key-based addressing, no rowids), so renaming any column would — without the
		// PK reconciliation — churn a spurious `primaryKeyChange`. The reconcile fixes it.
		const db = new Database();
		try {
			await db.exec(`declare schema main {
				table t { a INTEGER, b INTEGER }
			}`);
			await db.exec('apply schema main');
			await db.exec('insert into t values (1, 2), (3, 4)');

			// Rename a → a2; the (implicit, all-columns) PK is otherwise unchanged.
			await db.exec(`declare schema main {
				table t { a2 INTEGER with tags ("quereus.previous_name" = 'a'), b INTEGER }
			}`);
			const diff = diffOf(db);
			const alter = diff.tablesToAlter[0];
			expect(alter.columnsToRename, 'column rename detected').to.deep.equal([{ oldName: 'a', newName: 'a2' }]);
			expect(alter.primaryKeyChange, 'no spurious PK change on a default-PK table').to.be.undefined;

			const ddl = generateMigrationDDL(diff, 'main');
			expect(ddl.some(s => /ALTER PRIMARY KEY/i.test(s)), `no ALTER PRIMARY KEY, got:\n${ddl.join('\n')}`).to.be.false;

			await db.exec('apply schema main');
			expect(diffOf(db).tablesToAlter, 'idempotent re-apply produces no alter').to.deep.equal([]);
		} finally {
			await db.close();
		}
	});

	it('REGRESSION: a genuine PK membership change still emits primaryKeyChange', async function () {
		// Guard: reconciliation must NOT mask a real PK membership change. Here the PK
		// moves from (a) to (b) with no rename hint, so the reconciled sequence differs
		// from actual and `primaryKeyChange` is emitted with the new column.
		const db = new Database();
		try {
			await db.exec(`declare schema main {
				table t { a INTEGER PRIMARY KEY, b INTEGER }
			}`);
			await db.exec('apply schema main');
			await db.exec('insert into t values (1, 10), (2, 20)');

			// Move the PK from a to b (genuine membership change, no rename hint).
			await db.exec(`declare schema main {
				table t { a INTEGER, b INTEGER, constraint pk primary key (b) }
			}`);
			const diff = diffOf(db);
			const alter = diff.tablesToAlter[0];
			expect(alter.columnsToRename, 'no column rename for a genuine PK change').to.deep.equal([]);
			expect(alter.primaryKeyChange?.oldPkColumns, 'old PK was a').to.deep.equal(['a']);
			expect(alter.primaryKeyChange?.newPkColumns, 'new PK is b').to.deep.equal([{ name: 'b', direction: undefined }]);

			const ddl = generateMigrationDDL(diff, 'main');
			expect(ddl.some(s => /ALTER PRIMARY KEY \("?b"?\)/i.test(s)), `expected ALTER PRIMARY KEY (b), got:\n${ddl.join('\n')}`).to.be.true;

			await db.exec('apply schema main');
			expect(diffOf(db).tablesToAlter, 'idempotent re-apply produces no alter').to.deep.equal([]);
		} finally {
			await db.close();
		}
	});

	it('REGRESSION: a PK-column rename layered on a genuine membership change keeps the NEW names', async function () {
		// A rename AND a genuine membership change in the same diff: reconcile (a2, c)
		// back to (a, c), compare against actual (a, b) → differs → `primaryKeyChange`
		// emitted. The emitted `newPkColumns` must carry the NEW (declared) names so the
		// ALTER PRIMARY KEY DDL targets the post-rename columns.
		const db = new Database();
		try {
			await db.exec(`declare schema main {
				table t { a INTEGER, b INTEGER, c INTEGER, constraint pk primary key (a, b) }
			}`);
			await db.exec('apply schema main');
			await db.exec('insert into t values (1, 2, 3), (4, 5, 6)');

			// Rename a → a2 AND swap the PK's second member b → c at once.
			await db.exec(`declare schema main {
				table t {
					a2 INTEGER with tags ("quereus.previous_name" = 'a'),
					b INTEGER,
					c INTEGER,
					constraint pk primary key (a2, c)
				}
			}`);
			const diff = diffOf(db);
			const alter = diff.tablesToAlter[0];
			expect(alter.columnsToRename, 'column rename still detected').to.deep.equal([{ oldName: 'a', newName: 'a2' }]);
			expect(alter.primaryKeyChange?.oldPkColumns, 'old PK was (a, b)').to.deep.equal(['a', 'b']);
			expect(alter.primaryKeyChange?.newPkColumns, 'new PK carries the post-rename names (a2, c)')
				.to.deep.equal([{ name: 'a2', direction: undefined }, { name: 'c', direction: undefined }]);

			await db.exec('apply schema main');
			expect(diffOf(db).tablesToAlter, 'idempotent re-apply produces no alter').to.deep.equal([]);
		} finally {
			await db.close();
		}
	});

	it('REGRESSION: a direction change layered on a renamed PK column still emits primaryKeyChange', async function () {
		// A rename AND a genuine direction (asc → desc) change on the SAME PK column in
		// one diff. The reconcile rewrites names only — `pkSequencesEqual` still compares
		// direction — so the reconciled sequence (a desc) differs from actual (a asc) and
		// `primaryKeyChange` is emitted, carrying the post-rename name with desc.
		const db = new Database();
		try {
			await db.exec(`declare schema main {
				table t { id INTEGER PRIMARY KEY }
			}`);
			await db.exec('apply schema main');
			await db.exec('insert into t values (1), (2)');

			// Rename id → pk AND flip the key to descending in the same diff.
			await db.exec(`declare schema main {
				table t { pk INTEGER PRIMARY KEY desc with tags ("quereus.previous_name" = 'id') }
			}`);
			const diff = diffOf(db);
			const alter = diff.tablesToAlter[0];
			expect(alter.columnsToRename, 'PK column rename detected').to.deep.equal([{ oldName: 'id', newName: 'pk' }]);
			expect(alter.primaryKeyChange?.oldPkColumns, 'old PK was id').to.deep.equal(['id']);
			expect(alter.primaryKeyChange?.newPkColumns, 'new PK carries the post-rename name + desc')
				.to.deep.equal([{ name: 'pk', direction: 'desc' }]);

			// The DDL must RENAME COLUMN first, then ALTER PRIMARY KEY (pk desc).
			const ddl = generateMigrationDDL(diff, 'main');
			expect(ddl.some(s => /RENAME COLUMN .*id.* TO .*pk/i.test(s)), `expected RENAME COLUMN, got:\n${ddl.join('\n')}`).to.be.true;
			expect(ddl.some(s => /ALTER PRIMARY KEY \("?pk"? desc\)/i.test(s)), `expected ALTER PRIMARY KEY (pk desc), got:\n${ddl.join('\n')}`).to.be.true;

			await db.exec('apply schema main');
			expect(diffOf(db).tablesToAlter, 'idempotent re-apply produces no alter').to.deep.equal([]);
		} finally {
			await db.close();
		}
	});
});

describe('declarative-equivalence: cross-schema foreign keys', () => {
	// The declarative differ canonicalizes the FK parent-schema qualifier symmetrically
	// on both sides: an explicit qualifier equal to the CHILD schema elides, a genuine
	// cross-schema parent survives (see canonicalForeignKeyClause). So an unchanged
	// cross-schema FK — and an explicit own-schema qualifier — must NOT churn a spurious
	// drop+recreate, while a real parent-schema change MUST surface as a body change.
	function diffOf(db: Database, schemaName: string) {
		return computeSchemaDiff(
			db.declaredSchemaManager.getDeclaredSchema(schemaName)!,
			collectSchemaCatalog(db, schemaName),
		);
	}

	it('re-declaring an unchanged cross-schema FK produces no diff op', async function () {
		const db = new Database();
		try {
			await db.exec('pragma foreign_keys = true');
			// Parent m in main; child in s2 referencing main.m (genuine cross-schema).
			await db.exec(`declare schema main {
				table m { id INTEGER PRIMARY KEY, label TEXT }
			}`);
			await db.exec('apply schema main');
			await db.exec(`declare schema s2 {
				table child {
					id INTEGER PRIMARY KEY,
					m_id INTEGER,
					constraint fk_m foreign key (m_id) references main.m(id) on delete restrict
				}
			}`);
			await db.exec('apply schema s2');

			// Re-declare s2 byte-identically — the cross-schema qualifier 'main' survives on
			// BOTH the declared and actual sides, so the canonical bodies match: no churn.
			await db.exec(`declare schema s2 {
				table child {
					id INTEGER PRIMARY KEY,
					m_id INTEGER,
					constraint fk_m foreign key (m_id) references main.m(id) on delete restrict
				}
			}`);
			expect(diffOf(db, 's2').tablesToAlter, 'no spurious churn on unchanged cross-schema FK').to.deep.equal([]);

			// Apply is a no-op and the cross-schema FK still enforces end to end.
			await db.exec('apply schema s2');
			await db.exec("insert into main.m values (1, 'one')");
			await db.exec('insert into s2.child values (1, 1)');
			let rejected = false;
			try { await db.exec('insert into s2.child values (2, 99)'); } catch { rejected = true; }
			expect(rejected, 'cross-schema FK still enforces after idempotent re-apply').to.be.true;
		} finally {
			await db.close();
		}
	});

	it('an explicit own-schema qualifier is equivalent to the unqualified form (no churn)', async function () {
		const db = new Database();
		try {
			await db.exec('pragma foreign_keys = true');
			// Live catalog built from the UNQUALIFIED form (`references t`), child in main.
			await db.exec(`declare schema main {
				table t { id INTEGER PRIMARY KEY }
				table child {
					id INTEGER PRIMARY KEY,
					t_id INTEGER,
					constraint fk_t foreign key (t_id) references t(id)
				}
			}`);
			await db.exec('apply schema main');

			// Re-declare the SAME FK with an EXPLICIT own-schema qualifier `main.t`. The
			// qualifier equals the child schema (main), so it elides to the same canonical
			// body as the unqualified actual → no drop+recreate.
			await db.exec(`declare schema main {
				table t { id INTEGER PRIMARY KEY }
				table child {
					id INTEGER PRIMARY KEY,
					t_id INTEGER,
					constraint fk_t foreign key (t_id) references main.t(id)
				}
			}`);
			const diff = diffOf(db, 'main');
			const childAlter = diff.tablesToAlter.find(a => a.tableName.toLowerCase() === 'child');
			expect(childAlter?.constraintsToDrop ?? [], 'no FK drop for an own-schema qualifier').to.deep.equal([]);
			expect(childAlter?.constraintsToAdd ?? [], 'no FK add for an own-schema qualifier').to.deep.equal([]);
			expect(diff.tablesToAlter, 'no alter at all for the own-schema-qualifier equivalence').to.deep.equal([]);
		} finally {
			await db.close();
		}
	});

	it('changing the declared parent schema is detected as a body change (drop+recreate)', async function () {
		const db = new Database();
		try {
			await db.exec('pragma foreign_keys = true');
			// A like-named parent `m` exists in BOTH main and s2.
			await db.exec(`declare schema main {
				table m { id INTEGER PRIMARY KEY }
			}`);
			await db.exec('apply schema main');
			// Child in s2 initially references s2.m (own schema → qualifier elides canonically).
			await db.exec(`declare schema s2 {
				table m { id INTEGER PRIMARY KEY }
				table child {
					id INTEGER PRIMARY KEY,
					m_id INTEGER,
					constraint fk_m foreign key (m_id) references s2.m(id)
				}
			}`);
			await db.exec('apply schema s2');

			// Re-declare: SAME parent table name `m`, DIFFERENT parent schema (main). The
			// qualifier now differs from the child schema (s2) → it survives canonicalization
			// → the bodies diverge → drop+recreate (the "must differ" half of the symmetry).
			await db.exec(`declare schema s2 {
				table m { id INTEGER PRIMARY KEY }
				table child {
					id INTEGER PRIMARY KEY,
					m_id INTEGER,
					constraint fk_m foreign key (m_id) references main.m(id)
				}
			}`);
			const diff = diffOf(db, 's2');
			const childAlter = diff.tablesToAlter.find(a => a.tableName.toLowerCase() === 'child');
			expect(childAlter, 'child alter present for the parent-schema change').to.not.be.undefined;
			expect(childAlter!.constraintsToDrop ?? [], 'old FK dropped').to.deep.equal(['fk_m']);
			expect((childAlter!.constraintsToAdd ?? []).length, 'new FK added (drop+recreate)').to.equal(1);
			expect(((childAlter!.constraintsToAdd ?? [])[0] ?? '').toLowerCase(), 'recreated FK carries the cross-schema qualifier').to.include('main.m');
		} finally {
			await db.close();
		}
	});

	it('REGRESSION: an unchanged same-schema FK still produces no diff op', async function () {
		const db = new Database();
		try {
			await db.exec('pragma foreign_keys = true');
			await db.exec(`declare schema main {
				table parent { id INTEGER PRIMARY KEY }
				table child {
					id INTEGER PRIMARY KEY,
					parent_id INTEGER,
					constraint fk_p foreign key (parent_id) references parent(id) on delete cascade
				}
			}`);
			await db.exec('apply schema main');
			// Re-declare identically — the common same-schema case stays churn-free.
			await db.exec(`declare schema main {
				table parent { id INTEGER PRIMARY KEY }
				table child {
					id INTEGER PRIMARY KEY,
					parent_id INTEGER,
					constraint fk_p foreign key (parent_id) references parent(id) on delete cascade
				}
			}`);
			expect(diffOf(db, 'main').tablesToAlter, 'same-schema FK unchanged → no churn').to.deep.equal([]);
		} finally {
			await db.close();
		}
	});

	it('changing one cross-schema parent to ANOTHER cross-schema parent is a body change', async function () {
		const db = new Database();
		try {
			await db.exec('pragma foreign_keys = true');
			// Like-named parent `m` in TWO non-child schemas (s2 and main); child lives in s3.
			// Both qualifiers genuinely differ from the child schema (s3), so neither elides —
			// this isolates the qualifier as a compared *value* (s2 vs main), not present/absent.
			await db.exec(`declare schema main {
				table m { id INTEGER PRIMARY KEY }
			}`);
			await db.exec('apply schema main');
			await db.exec(`declare schema s2 {
				table m { id INTEGER PRIMARY KEY }
			}`);
			await db.exec('apply schema s2');
			await db.exec(`declare schema s3 {
				table child {
					id INTEGER PRIMARY KEY,
					m_id INTEGER,
					constraint fk_m foreign key (m_id) references s2.m(id)
				}
			}`);
			await db.exec('apply schema s3');
			expect(diffOf(db, 's3').tablesToAlter, 'unchanged cross→cross FK → no churn').to.deep.equal([]);

			// Re-declare: SAME parent table name `m`, SAME present-ness of qualifier, but a
			// DIFFERENT cross-schema parent (s2 → main). Two surviving-but-distinct qualifiers
			// must compare unequal → drop+recreate.
			await db.exec(`declare schema s3 {
				table child {
					id INTEGER PRIMARY KEY,
					m_id INTEGER,
					constraint fk_m foreign key (m_id) references main.m(id)
				}
			}`);
			const diff = diffOf(db, 's3');
			const childAlter = diff.tablesToAlter.find(a => a.tableName.toLowerCase() === 'child');
			expect(childAlter, 'child alter present for the cross→cross parent-schema change').to.not.be.undefined;
			expect(childAlter!.constraintsToDrop ?? [], 'old FK dropped').to.deep.equal(['fk_m']);
			expect((childAlter!.constraintsToAdd ?? []).length, 'new FK added (drop+recreate)').to.equal(1);
			expect(((childAlter!.constraintsToAdd ?? [])[0] ?? '').toLowerCase(), 'recreated FK carries the NEW cross-schema qualifier').to.include('main.m');
		} finally {
			await db.close();
		}
	});
});

describe('declarative-equivalence: default_collation', () => {
	// Diff threading the live session default_collation, mirroring the runtime emitters.
	function diffOf(db: Database) {
		return computeSchemaDiff(
			db.declaredSchemaManager.getDeclaredSchema('main')!,
			collectSchemaCatalog(db, 'main'),
			'allow',
			db.options.getStringOption('default_collation'),
		);
	}

	it('direct CREATE and declarative apply agree on an omitted-COLLATE column under nocase', async () => {
		const direct = new Database();
		const applied = new Database();
		try {
			direct.setOption('default_collation', 'nocase');
			await direct.exec('create table t (id integer primary key, name text)');

			applied.setOption('default_collation', 'nocase');
			await applied.exec('declare schema main { table t { id INTEGER PRIMARY KEY, name TEXT } }');
			await applied.exec('apply schema main');

			const d = direct.schemaManager.getTable('main', 't')!;
			const a = applied.schemaManager.getTable('main', 't')!;
			assertTableSchemaEqual(d, a, 't');
			// Both resolve the omitted COLLATE to NOCASE (the session default).
			expect(d.columns.find(c => c.name === 'name')!.collation).to.equal('NOCASE');
			expect(a.columns.find(c => c.name === 'name')!.collation).to.equal('NOCASE');
			// INTEGER falls back to BINARY (does not support NOCASE).
			expect(a.columns.find(c => c.name === 'id')!.collation).to.equal('BINARY');
		} finally {
			await direct.close();
			await applied.close();
		}
	});

	it('a second apply under nocase is idempotent — no spurious SET COLLATE', async () => {
		const db = new Database();
		try {
			db.setOption('default_collation', 'nocase');
			await db.exec('declare schema main { table t { id INTEGER PRIMARY KEY, name TEXT } }');
			await db.exec('apply schema main');

			// The live catalog column is NOCASE; the declared side must resolve the omitted
			// COLLATE to NOCASE too (via the threaded default), so the diff is empty.
			const diff = diffOf(db);
			expect(diff.tablesToAlter, 'idempotent re-diff produces no alter under nocase').to.deep.equal([]);
		} finally {
			await db.close();
		}
	});

	it('an inherited-collation index is idempotent under nocase — no index churn', async () => {
		// Guards the differ's index-path threading (declaredIndexCanonicalBody →
		// declaredColumnCollation): an index column with no explicit COLLATE inherits
		// the table column's NOCASE (default-resolved) collation. The actual catalog
		// index is built from that same NOCASE table column, so a re-diff must NOT
		// drop+recreate the index.
		const db = new Database();
		try {
			db.setOption('default_collation', 'nocase');
			await db.exec('declare schema main { table t { id INTEGER PRIMARY KEY, name TEXT } index ix_name on t (name) }');
			await db.exec('apply schema main');

			const diff = diffOf(db);
			expect(diff.indexesToDrop, 'no index drop').to.deep.equal([]);
			expect(diff.indexesToCreate, 'no index recreate').to.deep.equal([]);
			expect(diff.tablesToAlter, 'no table alter').to.deep.equal([]);
		} finally {
			await db.close();
		}
	});

	it('an apply that ADDs a text column under nocase lands NOCASE and re-diffs empty', async () => {
		// The original bug: ADD COLUMN ignored the default, creating `extra` as BINARY
		// while the declared side resolved to NOCASE — so every re-apply emitted a
		// spurious SET COLLATE. Approach A (differ emits explicit COLLATE) + Approach B
		// (execution layer honors the default) both close it; the catalog column lands
		// NOCASE and the re-diff is empty.
		const db = new Database();
		try {
			db.setOption('default_collation', 'nocase');
			await db.exec('create table t (id integer primary key, name text)');
			await db.exec('declare schema main { table t { id INTEGER PRIMARY KEY, name TEXT, extra TEXT } }');
			await db.exec('apply schema main'); // adds column `extra`

			const t = db.schemaManager.getTable('main', 't')!;
			expect(t.columns.find(c => c.name === 'extra')!.collation, 'ADD COLUMN honors default_collation').to.equal('NOCASE');

			expect(diffOf(db).tablesToAlter, 'idempotent re-diff after ADD COLUMN — no spurious SET COLLATE').to.deep.equal([]);
		} finally {
			await db.close();
		}
	});

	it('an apply that ADDs a non-text column under nocase lands BINARY and re-diffs empty', async () => {
		// resolveDefaultCollation's type-gate: INTEGER does not support NOCASE, so an
		// ADD-COLUMN-ed integer falls back to BINARY under a nocase default. The differ
		// emits no explicit COLLATE for it (Approach A's BINARY short-circuit) and the
		// re-diff stays empty.
		const db = new Database();
		try {
			db.setOption('default_collation', 'nocase');
			await db.exec('create table t (id integer primary key, name text)');
			await db.exec('declare schema main { table t { id INTEGER PRIMARY KEY, name TEXT, extra INTEGER } }');
			await db.exec('apply schema main'); // adds column `extra`

			const t = db.schemaManager.getTable('main', 't')!;
			expect(t.columns.find(c => c.name === 'extra')!.collation, 'non-text ADD COLUMN falls back to BINARY').to.equal('BINARY');

			expect(diffOf(db).tablesToAlter, 'idempotent re-diff after non-text ADD COLUMN').to.deep.equal([]);
		} finally {
			await db.close();
		}
	});

	it('RENAME COLUMN preserves a BINARY column and an explicit NOCASE column under nocase', async () => {
		// Regression guard for the deliberate carve-out: RENAME COLUMN is a derived-DDL
		// path (its AST is reconstructed from the live schema via buildConstraintsFromColumn,
		// which appends an explicit COLLATE only for non-BINARY columns). It must NOT pick
		// up the session default — a renamed BINARY column stays BINARY (threading the
		// default here would silently flip it to NOCASE), and a renamed explicit-NOCASE
		// column stays NOCASE (its reconstructed AST carries the COLLATE).
		const db = new Database();
		try {
			db.setOption('default_collation', 'nocase');
			await db.exec('create table t (id integer primary key, b text collate binary, c text collate nocase)');

			const before = db.schemaManager.getTable('main', 't')!;
			expect(before.columns.find(c => c.name === 'b')!.collation).to.equal('BINARY');
			expect(before.columns.find(c => c.name === 'c')!.collation).to.equal('NOCASE');

			await db.exec('alter table t rename column b to b2');
			await db.exec('alter table t rename column c to c2');

			const after = db.schemaManager.getTable('main', 't')!;
			expect(after.columns.find(c => c.name === 'b2')!.collation, 'renamed BINARY column must not pick up the nocase default').to.equal('BINARY');
			expect(after.columns.find(c => c.name === 'c2')!.collation, 'renamed explicit-NOCASE column stays NOCASE').to.equal('NOCASE');
		} finally {
			await db.close();
		}
	});

	it('an ADD COLUMN migration emitted under nocase lands NOCASE when replayed under a BINARY session (cross-session portability)', async () => {
		// Front A's payoff: the differ emits an EXPLICIT resolved COLLATE on added columns,
		// so a migration authored under `default_collation = nocase` is self-contained — it
		// carries `COLLATE NOCASE` in the DDL and lands NOCASE even when the executing session
		// uses the out-of-box BINARY default (the explicit COLLATE wins in columnDefToSchema, so
		// the session default is never consulted for that column). This is the structural
		// guarantee the implementer flagged as asserted-but-untested; assert it directly.
		const author = new Database();
		let ddl: string[];
		try {
			author.setOption('default_collation', 'nocase');
			await author.exec('create table t (id integer primary key, name text)');
			await author.exec('declare schema main { table t { id INTEGER PRIMARY KEY, name TEXT, extra TEXT } }');
			const diff = computeSchemaDiff(
				author.declaredSchemaManager.getDeclaredSchema('main')!,
				collectSchemaCatalog(author, 'main'),
				'allow',
				author.options.getStringOption('default_collation'),
			);
			ddl = generateMigrationDDL(diff, 'main');
			expect(ddl.some(s => /add column.*extra.*collate\s+nocase/i.test(s)),
				`emitted ADD COLUMN must carry an explicit COLLATE NOCASE, got:\n${ddl.join('\n')}`).to.be.true;
		} finally {
			await author.close();
		}

		const replay = new Database(); // out-of-box BINARY default — must NOT re-resolve the explicit COLLATE
		try {
			await replay.exec('create table t (id integer primary key, name text)');
			for (const stmt of ddl) await replay.exec(stmt);
			const t = replay.schemaManager.getTable('main', 't')!;
			expect(t.columns.find(c => c.name === 'extra')!.collation,
				'explicit COLLATE NOCASE survives a BINARY-session replay').to.equal('NOCASE');
		} finally {
			await replay.close();
		}
	});
});

/**
 * `apply schema` executes the migration plan's statement ASTs directly rather than
 * re-parsing the DDL it just rendered (see `generateMigrationPlan`). These guard the
 * three hazards that swap introduces: the executed AST is now SHARED with the stored
 * declaration (a `main`-schema apply hands the executor the very node
 * `DeclaredSchemaManager` holds), schema qualification must ride the AST and not just
 * the text, and the whole thing must still converge on a re-apply.
 */
describe('declarative-equivalence: apply executes the plan AST', () => {
	const FULL_SCHEMA = `
		table t { id INTEGER PRIMARY KEY, name TEXT COLLATE NOCASE, qty INTEGER default 0 }
		table src { id INTEGER PRIMARY KEY, qty INTEGER }
		view v as select id, name from t where qty > 0
		materialized view mv as select id, qty from src
		index idx_t_name on t (name)
		assertion a_qty check (not exists (select 1 from t where qty < 0))
	`;

	it('does not mutate the stored declaration', async function () {
		const db = new Database();
		try {
			await db.exec(`declare schema main {${FULL_SCHEMA}}`);
			// Clone BEFORE the apply. Today's text round-trip handed the executor a fresh
			// parse every time; executing the stored AST would expose any planner/builder
			// mutation of statement nodes as declaration drift.
			const before = structuredClone(db.declaredSchemaManager.getDeclaredSchema('main')!);
			await db.exec('apply schema main');
			expect(db.declaredSchemaManager.getDeclaredSchema('main'), 'apply left the stored declaration untouched')
				.to.deep.equal(before);
		} finally {
			await db.close();
		}
	});

	it('converges: a second apply produces an empty migration', async function () {
		const db = new Database();
		try {
			await db.exec(`declare schema main {${FULL_SCHEMA}}`);
			await db.exec('apply schema main');
			const diff2 = computeSchemaDiff(
				db.declaredSchemaManager.getDeclaredSchema('main')!,
				collectSchemaCatalog(db, 'main'),
			);
			expect(generateMigrationDDL(diff2, 'main'), 're-diff after apply is empty').to.deep.equal([]);
			// And the re-apply itself is a clean no-op.
			await db.exec('apply schema main');
		} finally {
			await db.close();
		}
	});

	it('lands every object in a non-main target schema', async function () {
		const db = new Database();
		try {
			await db.exec(`declare schema analytics {${FULL_SCHEMA}}`);
			await db.exec('apply schema analytics');

			const catalog = collectSchemaCatalog(db, 'analytics');
			expect(catalog.tables.map(x => x.name).sort(), 'tables + maintained table in analytics')
				.to.deep.equal(['mv', 'src', 't']);
			expect(catalog.views.map(x => x.name), 'view in analytics').to.deep.equal(['v']);
			expect(catalog.indexes.map(x => x.name), 'index in analytics').to.include('idx_t_name');
			expect(catalog.assertions.map(x => x.name), 'assertion in analytics').to.deep.equal(['a_qty']);

			// Nothing leaked into main.
			const mainCatalog = collectSchemaCatalog(db, 'main');
			expect(mainCatalog.tables, 'no tables leaked into main').to.deep.equal([]);
			expect(mainCatalog.views, 'no views leaked into main').to.deep.equal([]);

			// The objects are usable where they landed.
			await db.exec("insert into analytics.t values (1, 'a', 5)");
			const names: SqlValue[] = [];
			for await (const row of db.eval('select name from analytics.v')) names.push(row.name);
			expect(names, 'the landed view queries the landed table').to.deep.equal(['a']);

			// Converges on re-apply too.
			const diff2 = computeSchemaDiff(
				db.declaredSchemaManager.getDeclaredSchema('analytics')!,
				collectSchemaCatalog(db, 'analytics'),
			);
			expect(generateMigrationDDL(diff2, 'analytics'), 're-diff of a non-main schema is empty').to.deep.equal([]);
		} finally {
			await db.close();
		}
	});
});
