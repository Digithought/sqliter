/**
 * Lens constraint enforcement — live per-write firing of the prover's
 * `enforced-row-local` obligations (docs/lens.md § Constraint Attachment; ticket
 * `lens-constraint-enforcement-wiring`).
 *
 * The prover (`lens-prover-and-attachment`) classifies a scalar logical `check`
 * over non-computed columns as `enforced-row-local`. This suite asserts that such
 * a check actually fires *at the lens write boundary* — on inserts and updates
 * through the logical table — even when the basis table carries no such check, and
 * that the logical→basis column rewrite holds under a rename override.
 *
 * Each scenario gets a fresh Database and deploys through the full `apply schema`
 * pipeline, so enforcement runs exactly as in production.
 */

import { expect } from 'chai';
import { Database } from '../src/core/database.js';
import { astToString } from '../src/emit/ast-stringify.js';
import {
	collectLensRowLocalConstraints,
	collectLensForeignKeyConstraints,
	collectLensParentSideForeignKeyConstraints,
	collectLensSetLevelConstraints,
	hasCommitTimeSetLevelObligation,
	LENS_BOUNDARY_ATTACHED_TAG,
} from '../src/planner/mutation/lens-enforcement.js';
import { RowOpFlag } from '../src/schema/table.js';
import {
	findLogicalParentFkRefs,
	basisChildCarriesEquivalentFk,
	matchingBasisFksForLensRef,
	basisFksOverriddenByDivergentLensFk,
} from '../src/schema/lens-fk-discovery.js';
import { resolveSlotBasisSource } from '../src/schema/lens-prover.js';
import type { LensSlot } from '../src/schema/lens.js';
import { Parser } from '../src/parser/parser.js';
import { BuildTimeDependencyTracker, type PlanningContext } from '../src/planner/planning-context.js';
import { GlobalScope } from '../src/planner/scopes/global.js';
import { ParameterScope } from '../src/planner/scopes/param.js';
import { buildDeleteStmt } from '../src/planner/building/delete.js';
import { PlanNodeType } from '../src/planner/nodes/plan-node-type.js';
import type { DmlExecutorNode } from '../src/planner/nodes/dml-executor-node.js';
import { isRelationalNode, type PlanNode } from '../src/planner/nodes/plan-node.js';
import type * as AST from '../src/parser/ast.js';

async function expectThrows(fn: () => Promise<unknown>, matcher?: RegExp): Promise<void> {
	let threw = false;
	try {
		await fn();
	} catch (e) {
		threw = true;
		if (matcher) {
			const msg = e instanceof Error ? e.message : String(e);
			expect(msg, `error message should match ${matcher}`).to.match(matcher);
		}
	}
	expect(threw, 'expected the operation to throw').to.be.true;
}

function slot(db: Database, table: string): LensSlot {
	const s = db.schemaManager.getSchema('x')!.getLensSlot(table);
	expect(s, `lens slot for x.${table}`).to.not.be.undefined;
	return s!;
}

/**
 * A minimal {@link PlanningContext} for the direct `collectLensRowLocalConstraints`
 * unit calls below — the scope-aware rewrite needs a context to resolve subquery FROM
 * column names (`collectFromColumnNames`). Mirrors the fuller ctx built at the
 * plan-node regression near the end of this file.
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
		cteDescriptors: new Map(),
		outputScopes: new Map(),
	};
}

/**
 * The `mode` of every `enforced-set-level` obligation on a slot. Lets a test pin
 * the prover's *classification* — `row-time` vs `commit-time` — rather than only
 * the collector's output, which is `[]` for `row-time`, `proved`, AND `vacuous`
 * keys alike and so cannot, on its own, distinguish a genuine row-time key from a
 * key the body already proves.
 */
function setLevelModes(s: LensSlot): string[] {
	return (s.obligations ?? []).flatMap(o => (o.kind === 'enforced-set-level' ? [o.mode] : []));
}

async function rows(db: Database, sql: string): Promise<unknown[]> {
	const out: unknown[] = [];
	for await (const r of db.eval(sql)) out.push(r);
	return out;
}

describe('lens enforcement: row-local CHECK at the write boundary', () => {
	it('a logical check fires on insert/update through the lens, though the basis has none', async () => {
		const db = new Database();
		try {
			await db.exec('declare schema y { table t (id integer primary key, val integer) }');
			await db.exec('apply schema y');
			await db.exec('declare logical schema x { table t (id integer primary key, val integer, constraint nonneg check (val >= 0)) }');
			await db.exec('apply schema x');

			// The basis carries no such check — a violating value goes straight in.
			await db.exec('insert into y.t values (100, -99)');

			// Through the lens, the logical check fires on insert...
			await expectThrows(() => db.exec('insert into x.t (id, val) values (1, -5)'), /nonneg|constraint/i);
			// ...and a satisfying insert succeeds.
			await db.exec('insert into x.t (id, val) values (2, 5)');
			expect(await rows(db, 'select id, val from x.t where id = 2')).to.deep.equal([{ id: 2, val: 5 }]);

			// ...and on update.
			await expectThrows(() => db.exec('update x.t set val = -1 where id = 2'), /nonneg|constraint/i);
			await db.exec('update x.t set val = 10 where id = 2');
			expect(await rows(db, 'select val from x.t where id = 2')).to.deep.equal([{ val: 10 }]);

			// The violating basis row inserted directly is untouched (enforcement is
			// at the lens, not retroactive against the basis).
			expect(await rows(db, 'select val from x.t where id = 100')).to.deep.equal([{ val: -99 }]);
		} finally {
			await db.close();
		}
	});

	it('enforces the logical check in basis terms under a rename override', async () => {
		const db = new Database();
		try {
			await db.exec('declare schema y { table t (id integer primary key, speed integer) }');
			await db.exec('apply schema y');
			await db.exec('declare logical schema x { table t (id integer primary key, maxSpeed integer, constraint pos check (maxSpeed >= 0)) }');
			await db.exec('declare lens for x over y { view t as select id, speed as maxSpeed from y.t }');
			await db.exec('apply schema x');

			// The check is declared over the logical column `maxSpeed`; the lens
			// rewrites it to the basis column `speed`, so it still fires on a write.
			await expectThrows(() => db.exec('insert into x.t (id, maxSpeed) values (1, -5)'), /pos|constraint/i);
			await db.exec('insert into x.t (id, maxSpeed) values (2, 5)');
			expect(await rows(db, 'select id, maxSpeed from x.t where id = 2')).to.deep.equal([{ id: 2, maxSpeed: 5 }]);

			// The rewrite is visible on the synthesized basis-term constraint.
			const basisConstraints = collectLensRowLocalConstraints(makeCtx(db), slot(db, 't'));
			expect(basisConstraints.length, 'one routed row-local check').to.equal(1);
			const exprSql = astToString(basisConstraints[0].expr);
			expect(exprSql, 'rewritten to the basis column').to.match(/\bspeed\b/i);
			expect(exprSql, 'no longer references the logical column').to.not.match(/maxspeed/i);
		} finally {
			await db.close();
		}
	});

	it('enforces a subquery CHECK correlating a renamed logical column on a single-source lens', async () => {
		const db = new Database();
		try {
			// A single-source (non-decomposition) lens with a rename (`speed as maxSpeed`) and a
			// row-local CHECK whose subquery *correlates* the renamed write-row column `maxSpeed`.
			// `maxSpeed` appears ONLY inside the subquery, so pre-fix the un-descended rewrite left
			// it verbatim and the constraint crashed at build (`Column not found: maxSpeed`). The
			// scope-aware rewrite spells the correlated ref `speed` while leaving the foreign
			// `y.Allowed.cap` ref alone. Proves the fix is independent of decomposition.
			await db.exec('declare schema y { table t (id integer primary key, speed integer); table Allowed (cap integer) }');
			await db.exec('apply schema y');
			await db.exec('declare logical schema x { table t (id integer primary key, maxSpeed integer, constraint capok check (exists (select 1 from y.Allowed where Allowed.cap = maxSpeed))) }');
			await db.exec('declare lens for x over y { view t as select id, speed as maxSpeed from y.t }');
			await db.exec('apply schema x');

			// The allow-list (basis-direct seed, bypassing the lens): 5 and 10 are admitted.
			await db.exec('insert into y.Allowed (cap) values (5), (10)');

			// An allow-listed value inserts (the deferred subquery CHECK passes at commit)...
			await db.exec('insert into x.t (id, maxSpeed) values (1, 5)');
			expect(await rows(db, 'select id, maxSpeed from x.t where id = 1')).to.deep.equal([{ id: 1, maxSpeed: 5 }]);
			// ...and a non-listed one ABORTs — the CHECK is genuinely enforced, not merely build-safe.
			await expectThrows(() => db.exec('insert into x.t (id, maxSpeed) values (2, 7)'), /capok|constraint|check/i);
			expect(await rows(db, 'select count(*) as n from x.t where id = 2')).to.deep.equal([{ n: 0 }]);

			// The rewrite spelled the correlated ref in basis terms; the foreign ref is untouched.
			const constraints = collectLensRowLocalConstraints(makeCtx(db), slot(db, 't'));
			expect(constraints.length, 'one routed row-local check').to.equal(1);
			const exprSql = astToString(constraints[0].expr);
			expect(exprSql, 'correlated maxSpeed rewritten to basis speed').to.match(/\bspeed\b/i);
			expect(exprSql, 'no leftover logical spelling').to.not.match(/maxspeed/i);
			expect(exprSql, 'foreign Allowed ref left intact').to.match(/allowed/i);
		} finally {
			await db.close();
		}
	});

	it('a correlated ref whose basis name collides with a subquery-FROM column binds the write row (NEW-qualified), not the subquery source', async () => {
		const db = new Database();
		try {
			// The collision corner the `NEW.` qualifier guards: logical `maxSpeed` renames to basis
			// `speed`, and the CHECK subquery's FROM (`y.Allowed`) ALSO has a `speed` column. A *bare*
			// rewrite would spell the correlated ref `speed`, which then re-binds to `Allowed.speed`
			// (innermost SQL scoping) — turning the CHECK into "does any Allowed row have cap = speed?",
			// independent of the write value. The `NEW.speed` qualifier makes it correlate to the write
			// row. The two regimes give DIFFERENT verdicts, so this distinguishes the fix behaviorally.
			await db.exec('declare schema y { table t (id integer primary key, speed integer); table Allowed (cap integer, speed integer) }');
			await db.exec('apply schema y');
			await db.exec('declare logical schema x { table t (id integer primary key, maxSpeed integer, constraint capok check (exists (select 1 from y.Allowed where Allowed.cap = maxSpeed))) }');
			await db.exec('declare lens for x over y { view t as select id, speed as maxSpeed from y.t }');
			await db.exec('apply schema x');

			// Row (99, 99) has cap == speed, so the BUGGY `Allowed.cap = Allowed.speed` reading would be
			// satisfied for EVERY write. The allow-list of `cap` values is {5, 99}.
			await db.exec('insert into y.Allowed (cap, speed) values (5, 7), (99, 99)');

			// maxSpeed = 5 is on the cap allow-list ⇒ passes under the correct (NEW) reading.
			await db.exec('insert into x.t (id, maxSpeed) values (1, 5)');
			expect(await rows(db, 'select maxSpeed from x.t where id = 1')).to.deep.equal([{ maxSpeed: 5 }]);
			// maxSpeed = 8 is NOT a cap ⇒ must ABORT under the correct reading. The buggy bare reading
			// would WRONGLY admit it (some Allowed row has cap == speed), so this assertion fails pre-fix.
			await expectThrows(() => db.exec('insert into x.t (id, maxSpeed) values (2, 8)'), /capok|constraint|check/i);
			expect(await rows(db, 'select count(*) as n from x.t where id = 2')).to.deep.equal([{ n: 0 }]);

			// The correlated ref is NEW-qualified; the foreign `Allowed.cap` ref is untouched.
			const exprSql = astToString(collectLensRowLocalConstraints(makeCtx(db), slot(db, 't'))[0].expr);
			expect(exprSql, 'correlated write-row ref qualified NEW.speed').to.match(/new\.speed/i);
		} finally {
			await db.close();
		}
	});

	it('stamps the boundary-attached marker on each routed constraint', async () => {
		const db = new Database();
		try {
			await db.exec('declare schema y { table t (id integer primary key, val integer) }');
			await db.exec('apply schema y');
			await db.exec('declare logical schema x { table t (id integer primary key, val integer, constraint nonneg check (val >= 0)) }');
			await db.exec('apply schema x');

			const routed = collectLensRowLocalConstraints(makeCtx(db), slot(db, 't'));
			expect(routed.length).to.equal(1);
			expect(routed[0].tags?.[LENS_BOUNDARY_ATTACHED_TAG], 'marker present').to.equal(true);
			expect(routed[0].name).to.equal('lens:nonneg');
		} finally {
			await db.close();
		}
	});

	it('a check-free / non-lens write routes no extra constraints', async () => {
		const db = new Database();
		try {
			// Logical table with no check constraint ⇒ no row-local obligations.
			await db.exec('declare schema y { table t (id integer primary key, val integer) }');
			await db.exec('apply schema y');
			await db.exec('declare logical schema x { table t (id integer primary key, val integer) }');
			await db.exec('apply schema x');

			expect(collectLensRowLocalConstraints(makeCtx(db), slot(db, 't'))).to.deep.equal([]);

			// And a plain physical table's write is unaffected: a normal insert works.
			await db.exec('insert into x.t (id, val) values (1, -5)');
			expect(await rows(db, 'select val from x.t where id = 1')).to.deep.equal([{ val: -5 }]);
		} finally {
			await db.close();
		}
	});

	it('does not enforce a row-local check on delete (no NEW row to guard)', async () => {
		const db = new Database();
		try {
			await db.exec('declare schema y { table t (id integer primary key, val integer) }');
			await db.exec('apply schema y');
			await db.exec('declare logical schema x { table t (id integer primary key, val integer, constraint nonneg check (val >= 0)) }');
			await db.exec('apply schema x');

			// Seed a satisfying row through the lens, then delete it — the check must
			// not spuriously block the delete.
			await db.exec('insert into x.t (id, val) values (1, 5)');
			await db.exec('delete from x.t where id = 1');
			expect(await rows(db, 'select count(*) as n from x.t')).to.deep.equal([{ n: 0 }]);
		} finally {
			await db.close();
		}
	});
});

describe('lens enforcement: row-local CHECK — multi-column / aliasing / conflict resolution', () => {
	it('a check over two renamed logical columns rewrites both to their basis terms', async () => {
		const db = new Database();
		try {
			await db.exec('declare schema y { table t (id integer primary key, lo integer, hi integer) }');
			await db.exec('apply schema y');
			await db.exec('declare logical schema x { table t (id integer primary key, a integer, b integer, constraint ord check (a <= b)) }');
			await db.exec('declare lens for x over y { view t as select id, lo as a, hi as b from y.t }');
			await db.exec('apply schema x');

			await expectThrows(() => db.exec('insert into x.t (id, a, b) values (1, 5, 2)'), /ord|constraint/i);
			await db.exec('insert into x.t (id, a, b) values (2, 2, 5)');
			expect(await rows(db, 'select a, b from x.t where id = 2')).to.deep.equal([{ a: 2, b: 5 }]);
			// The rewrite landed in basis terms (lo/hi), so the basis row reflects the mapping.
			expect(await rows(db, 'select lo, hi from y.t where id = 2')).to.deep.equal([{ lo: 2, hi: 5 }]);
		} finally {
			await db.close();
		}
	});

	it('a column-swapping override rewrites each logical column independently (no double-substitution)', async () => {
		const db = new Database();
		try {
			await db.exec('declare schema y { table t (id integer primary key, p integer, q integer) }');
			await db.exec('apply schema y');
			// logical a ← basis q, logical b ← basis p (a swap); the check `a > b` must
			// rewrite to `q > p`, NOT collapse under re-substitution.
			await db.exec('declare logical schema x { table t (id integer primary key, a integer, b integer, constraint gt check (a > b)) }');
			await db.exec('declare lens for x over y { view t as select id, q as a, p as b from y.t }');
			await db.exec('apply schema x');

			await db.exec('insert into x.t (id, a, b) values (1, 10, 1)');
			expect(await rows(db, 'select p, q from y.t where id = 1')).to.deep.equal([{ p: 1, q: 10 }]);
			await expectThrows(() => db.exec('insert into x.t (id, a, b) values (2, 1, 10)'), /gt|constraint/i);
		} finally {
			await db.close();
		}
	});

	it('OR IGNORE skips a row that violates the lens row-local check (no throw, not inserted)', async () => {
		const db = new Database();
		try {
			await db.exec('declare schema y { table t (id integer primary key, val integer) }');
			await db.exec('apply schema y');
			await db.exec('declare logical schema x { table t (id integer primary key, val integer, constraint nonneg check (val >= 0)) }');
			await db.exec('apply schema x');

			// The synthetic constraint inherits statement-level conflict handling via the
			// basis ConstraintCheckNode: OR IGNORE silently drops the offending row.
			await db.exec('insert or ignore into x.t (id, val) values (1, -5)');
			expect(await rows(db, 'select count(*) as n from x.t')).to.deep.equal([{ n: 0 }]);
			// A satisfying row in the same shape still lands.
			await db.exec('insert or ignore into x.t (id, val) values (2, 5)');
			expect(await rows(db, 'select val from x.t where id = 2')).to.deep.equal([{ val: 5 }]);
		} finally {
			await db.close();
		}
	});

	it('OR REPLACE still aborts on a lens row-local CHECK violation (REPLACE resolves uniqueness/NOT NULL, not CHECK)', async () => {
		const db = new Database();
		try {
			await db.exec('declare schema y { table t (id integer primary key, val integer) }');
			await db.exec('apply schema y');
			await db.exec('declare logical schema x { table t (id integer primary key, val integer, constraint nonneg check (val >= 0)) }');
			await db.exec('apply schema x');

			await expectThrows(() => db.exec('insert or replace into x.t (id, val) values (1, -5)'), /nonneg|constraint/i);
			expect(await rows(db, 'select count(*) as n from x.t')).to.deep.equal([{ n: 0 }]);
		} finally {
			await db.close();
		}
	});
});

describe('lens enforcement: child-side FK existence at the write boundary', () => {
	/**
	 * Deploys a basis schema with **no** FK and a logical schema declaring the FK,
	 * over an optional override body. The basis tables hold the data; the logical FK
	 * exists only at the lens boundary, so it is the lens — not the basis — that must
	 * enforce it. `foreign_keys` defaults on.
	 */
	async function deployFkLens(db: Database, opts?: { override?: string; childBasis?: string }): Promise<void> {
		// `default_column_nullability` is `not_null` (Third Manifesto), so the FK
		// column is declared explicitly nullable to exercise MATCH SIMPLE.
		await db.exec(`declare schema y { table parent (id integer primary key, name text); table child (id integer primary key, ${opts?.childBasis ?? 'pid integer null'}) }`);
		await db.exec('apply schema y');
		await db.exec('declare logical schema x { table parent (id integer primary key, name text); table child (id integer primary key, pid integer null, constraint fk_pid foreign key (pid) references parent(id)) }');
		if (opts?.override) await db.exec(opts.override);
		await db.exec('apply schema x');
	}

	it('the core gap — a dangling FK insert ABORTs through the lens though the basis has no FK', async () => {
		const db = new Database();
		try {
			await deployFkLens(db);
			// Basis accepts a dangling reference directly (no basis FK).
			await db.exec('insert into y.child values (500, 999)');
			// Through the lens, the logical FK fires: no parent id=99 ⇒ ABORT.
			await expectThrows(() => db.exec('insert into x.child (id, pid) values (10, 99)'), /fk_pid|constraint|foreign/i);
			expect(await rows(db, 'select count(*) as n from x.child where id = 10')).to.deep.equal([{ n: 0 }]);
		} finally {
			await db.close();
		}
	});

	it('a satisfying insert succeeds once the parent exists', async () => {
		const db = new Database();
		try {
			await deployFkLens(db);
			await db.exec(`insert into x.parent (id, name) values (1, 'a')`);
			await db.exec('insert into x.child (id, pid) values (10, 1)');
			expect(await rows(db, 'select id, pid from x.child where id = 10')).to.deep.equal([{ id: 10, pid: 1 }]);
		} finally {
			await db.close();
		}
	});

	it('a NULL FK column is allowed (MATCH SIMPLE) with no parent lookup', async () => {
		const db = new Database();
		try {
			await deployFkLens(db);
			await db.exec('insert into x.child (id, pid) values (10, null)');
			expect(await rows(db, 'select id, pid from x.child where id = 10')).to.deep.equal([{ id: 10, pid: null }]);
		} finally {
			await db.close();
		}
	});

	it('the foreign_keys pragma gates it — off ⇒ dangling insert accepted', async () => {
		const db = new Database();
		try {
			await deployFkLens(db);
			await db.exec('pragma foreign_keys = false');
			// No synthesized check ⇒ the dangling reference is accepted, matching the
			// physical child-side FK gate.
			await db.exec('insert into x.child (id, pid) values (10, 99)');
			expect(await rows(db, 'select pid from x.child where id = 10')).to.deep.equal([{ pid: 99 }]);
		} finally {
			await db.close();
		}
	});

	it('an UPDATE to a dangling FK value ABORTs; to a valid value succeeds', async () => {
		const db = new Database();
		try {
			await deployFkLens(db);
			await db.exec(`insert into x.parent (id, name) values (1, 'a'), (2, 'b')`);
			await db.exec('insert into x.child (id, pid) values (10, 1)');
			await expectThrows(() => db.exec('update x.child set pid = 99 where id = 10'), /fk_pid|constraint|foreign/i);
			expect(await rows(db, 'select pid from x.child where id = 10')).to.deep.equal([{ pid: 1 }]);
			await db.exec('update x.child set pid = 2 where id = 10');
			expect(await rows(db, 'select pid from x.child where id = 10')).to.deep.equal([{ pid: 2 }]);
		} finally {
			await db.close();
		}
	});

	it('a rename override rewrites the child FK column to basis terms (still ABORTs dangling)', async () => {
		const db = new Database();
		try {
			await deployFkLens(db, {
				childBasis: 'basis_pid integer',
				override: 'declare lens for x over y { view child as select id, basis_pid as pid from y.child }',
			});

			await db.exec(`insert into x.parent (id, name) values (1, 'a')`);
			await expectThrows(() => db.exec('insert into x.child (id, pid) values (10, 99)'), /fk_pid|constraint|foreign/i);
			await db.exec('insert into x.child (id, pid) values (11, 1)');
			expect(await rows(db, 'select basis_pid from y.child where id = 11')).to.deep.equal([{ basis_pid: 1 }]);

			// The synthesized constraint references the BASIS child column, not the logical one.
			const routed = collectLensForeignKeyConstraints(slot(db, 'child'), db.schemaManager);
			expect(routed.length, 'one routed FK check').to.equal(1);
			const exprSql = astToString(routed[0].expr);
			expect(exprSql, 'rewritten to basis child column').to.match(/basis_pid/i);
			expect(exprSql, 'no standalone logical pid reference').to.not.match(/\bpid\b/i);
		} finally {
			await db.close();
		}
	});

	it('no FK obligation ⇒ no routed FK constraint, no behavior change', async () => {
		const db = new Database();
		try {
			await db.exec('declare schema y { table t (id integer primary key, val integer) }');
			await db.exec('apply schema y');
			await db.exec('declare logical schema x { table t (id integer primary key, val integer) }');
			await db.exec('apply schema x');

			expect(collectLensForeignKeyConstraints(slot(db, 't'), db.schemaManager)).to.deep.equal([]);
			await db.exec('insert into x.t (id, val) values (1, 7)');
			expect(await rows(db, 'select val from x.t where id = 1')).to.deep.equal([{ val: 7 }]);
		} finally {
			await db.close();
		}
	});

	it('composes with a row-local check — both classes fire on the same write', async () => {
		const db = new Database();
		try {
			await db.exec('declare schema y { table parent (id integer primary key); table child (id integer primary key, pid integer, val integer) }');
			await db.exec('apply schema y');
			await db.exec('declare logical schema x { table parent (id integer primary key); table child (id integer primary key, pid integer, val integer, constraint nonneg check (val >= 0), constraint fk_pid foreign key (pid) references parent(id)) }');
			await db.exec('apply schema x');
			await db.exec('insert into x.parent (id) values (1)');

			// Row-local check violation ABORTs (check).
			await expectThrows(() => db.exec('insert into x.child (id, pid, val) values (10, 1, -1)'), /nonneg|constraint/i);
			// Dangling FK ABORTs (FK).
			await expectThrows(() => db.exec('insert into x.child (id, pid, val) values (11, 99, 1)'), /fk_pid|constraint|foreign/i);
			// Both satisfied ⇒ ok.
			await db.exec('insert into x.child (id, pid, val) values (12, 1, 5)');
			expect(await rows(db, 'select id, pid, val from x.child where id = 12')).to.deep.equal([{ id: 12, pid: 1, val: 5 }]);
		} finally {
			await db.close();
		}
	});

	it('deferred semantics — child inserted before its parent in one transaction commits', async () => {
		const db = new Database();
		try {
			await deployFkLens(db);
			// The synthesized EXISTS check auto-defers to commit (it contains a subquery),
			// so a child may precede its parent within a transaction.
			await db.exec('begin');
			await db.exec('insert into x.child (id, pid) values (10, 1)'); // dangling at this point
			await db.exec(`insert into x.parent (id, name) values (1, 'a')`); // satisfied before commit
			await db.exec('commit');
			expect(await rows(db, 'select id, pid from x.child where id = 10')).to.deep.equal([{ id: 10, pid: 1 }]);
		} finally {
			await db.close();
		}
	});

	it('a composite (multi-column) FK enforces all components under MATCH SIMPLE', async () => {
		const db = new Database();
		try {
			await db.exec('declare schema y { table parent (px integer, py integer, name text, primary key (px, py)); table child (id integer primary key, a integer null, b integer null) }');
			await db.exec('apply schema y');
			await db.exec('declare logical schema x { table parent (px integer, py integer, name text, primary key (px, py)); table child (id integer primary key, a integer null, b integer null, constraint fk_ab foreign key (a, b) references parent(px, py)) }');
			await db.exec('apply schema x');
			await db.exec(`insert into x.parent (px, py, name) values (1, 2, 'a')`);

			// Dangling composite reference ABORTs.
			await expectThrows(() => db.exec('insert into x.child (id, a, b) values (10, 1, 9)'), /fk_ab|constraint|foreign/i);
			// Matching composite reference succeeds.
			await db.exec('insert into x.child (id, a, b) values (11, 1, 2)');
			expect(await rows(db, 'select a, b from x.child where id = 11')).to.deep.equal([{ a: 1, b: 2 }]);
			// Any-NULL component is allowed under MATCH SIMPLE.
			await db.exec('insert into x.child (id, a, b) values (12, null, 5)');
			expect(await rows(db, 'select a, b from x.child where id = 12')).to.deep.equal([{ a: null, b: 5 }]);
		} finally {
			await db.close();
		}
	});

	it('a bare `references parent` (no column list) falls back to the parent PK', async () => {
		// The common FK idiom omits the parent column list, so the parser leaves
		// `referencedColumnNames` empty and the collector must resolve the parent
		// logical table's PK (`id`) via the fallback path. Distinct PK/non-PK column
		// names on the parent ensure the fallback picks the PK, not a positional guess.
		const db = new Database();
		try {
			await db.exec('declare schema y { table parent (pk_id integer primary key, name text); table child (id integer primary key, pid integer null) }');
			await db.exec('apply schema y');
			await db.exec('declare logical schema x { table parent (pk_id integer primary key, name text); table child (id integer primary key, pid integer null, constraint fk_pid foreign key (pid) references parent) }');
			await db.exec('apply schema x');

			// The fallback resolves the parent column to its PK name `pk_id`.
			const routed = collectLensForeignKeyConstraints(slot(db, 'child'), db.schemaManager);
			expect(routed.length, 'one routed FK check').to.equal(1);
			expect(astToString(routed[0].expr), 'parent side filters on the PK column').to.match(/pk_id/i);

			// And it actually enforces: dangling aborts, satisfied succeeds.
			await expectThrows(() => db.exec('insert into x.child (id, pid) values (10, 99)'), /fk_pid|constraint|foreign/i);
			await db.exec(`insert into x.parent (pk_id, name) values (1, 'a')`);
			await db.exec('insert into x.child (id, pid) values (11, 1)');
			expect(await rows(db, 'select pid from x.child where id = 11')).to.deep.equal([{ pid: 1 }]);
		} finally {
			await db.close();
		}
	});

	it('unit: the collector returns one boundary-tagged EXISTS over the qualified logical parent', async () => {
		const db = new Database();
		try {
			await deployFkLens(db);
			const routed = collectLensForeignKeyConstraints(slot(db, 'child'), db.schemaManager);
			expect(routed.length).to.equal(1);
			expect(routed[0].tags?.[LENS_BOUNDARY_ATTACHED_TAG], 'boundary marker present').to.equal(true);
			expect(routed[0].name).to.equal('lens:fk:fk_pid');
			const exprSql = astToString(routed[0].expr);
			expect(exprSql, 'an EXISTS existence check').to.match(/exists/i);
			expect(exprSql, 'over the qualified logical parent').to.match(/parent/i);
			expect(exprSql, 'references the basis child column NEW.pid').to.match(/\bpid\b/i);
		} finally {
			await db.close();
		}
	});
});

describe('lens enforcement: child-side FK basis-redundancy elision', () => {
	it('elides the lens FK when the basis carries the equivalent FK over a faithful default parent (no correctness change)', async () => {
		const db = new Database();
		try {
			// Basis declares the SAME FK (child.pid → parent.id); the logical bodies are
			// the faithful default projection ⇒ the basis write's own child-side FK check
			// subsumes the lens-level one, so the collector elides it.
			await db.exec('declare schema y { table parent (id integer primary key, name text); table child (id integer primary key, pid integer null, constraint fk foreign key (pid) references parent(id)) }');
			await db.exec('apply schema y');
			await db.exec('declare logical schema x { table parent (id integer primary key, name text); table child (id integer primary key, pid integer null, constraint fk_pid foreign key (pid) references parent(id)) }');
			await db.exec('apply schema x');

			expect(collectLensForeignKeyConstraints(slot(db, 'child'), db.schemaManager), 'redundant lens FK elided').to.deep.equal([]);

			// No correctness change: a dangling insert still ABORTs — now via the basis FK
			// the re-planned basis write enforces.
			await db.exec(`insert into x.parent (id, name) values (1, 'a')`);
			await expectThrows(() => db.exec('insert into x.child (id, pid) values (10, 99)'), /fk|constraint|foreign/i);
			expect(await rows(db, 'select count(*) as n from x.child where id = 10')).to.deep.equal([{ n: 0 }]);
			// A satisfying insert and a NULL FK both still behave correctly.
			await db.exec('insert into x.child (id, pid) values (11, 1)');
			await db.exec('insert into x.child (id, pid) values (12, null)');
			expect(await rows(db, 'select id, pid from x.child where id in (11, 12) order by id')).to.deep.equal([{ id: 11, pid: 1 }, { id: 12, pid: null }]);
		} finally {
			await db.close();
		}
	});

	it('a composite FK elides when the basis carries the equivalent composite FK (same pair-set)', async () => {
		const db = new Database();
		try {
			await db.exec('declare schema y { table parent (px integer, py integer, name text, primary key (px, py)); table child (id integer primary key, a integer null, b integer null, constraint fk_ab foreign key (a, b) references parent(px, py)) }');
			await db.exec('apply schema y');
			await db.exec('declare logical schema x { table parent (px integer, py integer, name text, primary key (px, py)); table child (id integer primary key, a integer null, b integer null, constraint fk_ab foreign key (a, b) references parent(px, py)) }');
			await db.exec('apply schema x');

			expect(collectLensForeignKeyConstraints(slot(db, 'child'), db.schemaManager), 'equivalent composite basis FK elides').to.deep.equal([]);
		} finally {
			await db.close();
		}
	});

	it('a permuted basis composite FK (references parent(py, px)) does NOT elide — double-enforces', async () => {
		const db = new Database();
		try {
			// Basis FK pairs (a→py, b→px); the logical FK pairs (a→px, b→py). The pair-sets
			// differ ⇒ the basis FK is NOT equivalent ⇒ the lens-level check is retained.
			await db.exec('declare schema y { table parent (px integer, py integer, name text, primary key (px, py)); table child (id integer primary key, a integer null, b integer null, constraint fk_perm foreign key (a, b) references parent(py, px)) }');
			await db.exec('apply schema y');
			await db.exec('declare logical schema x { table parent (px integer, py integer, name text, primary key (px, py)); table child (id integer primary key, a integer null, b integer null, constraint fk_ab foreign key (a, b) references parent(px, py)) }');
			await db.exec('apply schema x');

			expect(collectLensForeignKeyConstraints(slot(db, 'child'), db.schemaManager).length, 'permuted basis FK ⇒ retained').to.equal(1);
		} finally {
			await db.close();
		}
	});

	it('no basis FK ⇒ enforce (does not over-elide)', async () => {
		const db = new Database();
		try {
			// Basis has NO FK ⇒ the basis write enforces nothing ⇒ the lens-level check
			// must be retained, and a dangling insert must still ABORT.
			await db.exec('declare schema y { table parent (id integer primary key, name text); table child (id integer primary key, pid integer null) }');
			await db.exec('apply schema y');
			await db.exec('declare logical schema x { table parent (id integer primary key, name text); table child (id integer primary key, pid integer null, constraint fk_pid foreign key (pid) references parent(id)) }');
			await db.exec('apply schema x');

			expect(collectLensForeignKeyConstraints(slot(db, 'child'), db.schemaManager).length, 'no basis FK ⇒ lens check retained').to.equal(1);
			await db.exec('insert into y.child values (500, 999)'); // basis accepts dangling (no basis FK)
			await expectThrows(() => db.exec('insert into x.child (id, pid) values (10, 99)'), /fk_pid|constraint|foreign/i);
		} finally {
			await db.close();
		}
	});

	it('a parent override with a `where` ⇒ does NOT elide (row-set-equivalence fails); a basis-only value still ABORTs', async () => {
		const db = new Database();
		try {
			// The basis carries the equivalent FK, but the logical parent is a strict
			// subset of the basis parent (filtered `where id > 0`), so the basis check does
			// NOT imply the lens check — the lens-level check MUST be retained. This is the
			// soundness-critical case.
			await db.exec('declare schema y { table parent (id integer primary key, name text); table child (id integer primary key, pid integer null, constraint fk foreign key (pid) references parent(id)) }');
			await db.exec('apply schema y');
			await db.exec('declare logical schema x { table parent (id integer primary key, name text); table child (id integer primary key, pid integer null, constraint fk_pid foreign key (pid) references parent(id)) }');
			await db.exec('declare lens for x over y { view parent as select id, name from y.parent where id > 0 }');
			await db.exec('apply schema x');

			expect(collectLensForeignKeyConstraints(slot(db, 'child'), db.schemaManager).length, 'filtered parent ⇒ lens check retained').to.equal(1);

			// A value that exists in the BASIS parent but is filtered OUT of the logical
			// parent (id = -5) passes the basis FK yet must ABORT at the lens (no logical
			// parent row id = -5).
			await db.exec(`insert into y.parent (id, name) values (-5, 'neg'), (1, 'pos')`);
			await expectThrows(() => db.exec('insert into x.child (id, pid) values (10, -5)'), /fk_pid|constraint|foreign/i);
			expect(await rows(db, 'select count(*) as n from x.child where id = 10')).to.deep.equal([{ n: 0 }]);
			// A value present in the logical parent (id = 1) succeeds.
			await db.exec('insert into x.child (id, pid) values (11, 1)');
			expect(await rows(db, 'select pid from x.child where id = 11')).to.deep.equal([{ pid: 1 }]);
		} finally {
			await db.close();
		}
	});

	it('a rename override on the child still elides when the basis FK is on the basis column', async () => {
		const db = new Database();
		try {
			// Child maps logical `pid` → basis `basis_pid`; the basis FK is on `basis_pid`.
			// Condition (1) holds (plain rename), so the mapped pair-set equals the basis
			// FK's ⇒ elide. The parent is the faithful default projection.
			await db.exec('declare schema y { table parent (id integer primary key, name text); table child (id integer primary key, basis_pid integer null, constraint fk foreign key (basis_pid) references parent(id)) }');
			await db.exec('apply schema y');
			await db.exec('declare logical schema x { table parent (id integer primary key, name text); table child (id integer primary key, pid integer null, constraint fk_pid foreign key (pid) references parent(id)) }');
			await db.exec('declare lens for x over y { view child as select id, basis_pid as pid from y.child }');
			await db.exec('apply schema x');

			expect(collectLensForeignKeyConstraints(slot(db, 'child'), db.schemaManager), 'rename-over-basis-FK elides').to.deep.equal([]);

			// Still enforces via the basis FK: dangling ABORTs, satisfied succeeds.
			await db.exec(`insert into x.parent (id, name) values (1, 'a')`);
			await expectThrows(() => db.exec('insert into x.child (id, pid) values (10, 99)'), /fk|constraint|foreign/i);
			await db.exec('insert into x.child (id, pid) values (11, 1)');
			expect(await rows(db, 'select basis_pid from y.child where id = 11')).to.deep.equal([{ basis_pid: 1 }]);
		} finally {
			await db.close();
		}
	});

	it('an UPDATE through an elided FK still ABORTs a dangling value (the basis FK fires on update too)', async () => {
		const db = new Database();
		try {
			// Same elide setup as the first case. The elision drops the lens-level check
			// for INSERT *and* UPDATE alike (the collector runs once per write-plan, the
			// returned `[]` covers both ops). Pin that re-keying a child to a dangling FK
			// value is still rejected — by the basis FK the re-planned basis update enforces.
			await db.exec('declare schema y { table parent (id integer primary key, name text); table child (id integer primary key, pid integer null, constraint fk foreign key (pid) references parent(id)) }');
			await db.exec('apply schema y');
			await db.exec('declare logical schema x { table parent (id integer primary key, name text); table child (id integer primary key, pid integer null, constraint fk_pid foreign key (pid) references parent(id)) }');
			await db.exec('apply schema x');

			expect(collectLensForeignKeyConstraints(slot(db, 'child'), db.schemaManager), 'redundant lens FK elided').to.deep.equal([]);

			await db.exec(`insert into x.parent (id, name) values (1, 'a'), (2, 'b')`);
			await db.exec('insert into x.child (id, pid) values (10, 1)');
			// UPDATE to a dangling parent (no row id = 99) must ABORT via the basis FK.
			await expectThrows(() => db.exec('update x.child set pid = 99 where id = 10'), /fk|constraint|foreign/i);
			expect(await rows(db, 'select pid from x.child where id = 10'), 'failed update rolled back').to.deep.equal([{ pid: 1 }]);
			// UPDATE to another valid parent (id = 2) succeeds; updating to NULL succeeds.
			await db.exec('update x.child set pid = 2 where id = 10');
			expect(await rows(db, 'select pid from x.child where id = 10')).to.deep.equal([{ pid: 2 }]);
			await db.exec('update x.child set pid = null where id = 10');
			expect(await rows(db, 'select pid from x.child where id = 10')).to.deep.equal([{ pid: null }]);
		} finally {
			await db.close();
		}
	});
});

describe('lens enforcement: set-level (unique / PK) commit-time at the write boundary', () => {
	it('a logical unique with no covering structure ABORTs a duplicate at commit (NULL-distinct)', async () => {
		const db = new Database();
		try {
			await db.exec('declare schema y { table u (id integer primary key, email text null) }');
			await db.exec('apply schema y');
			await db.exec('declare logical schema x { table u (id integer primary key, email text null, unique (email)) }');
			await db.exec('apply schema x');

			// Two distinct emails ⇒ ok.
			await db.exec(`insert into x.u (id, email) values (1, 'a@x'), (2, 'b@x')`);
			// A second insert that duplicates an existing email ⇒ ABORT at commit.
			await expectThrows(() => db.exec(`insert into x.u (id, email) values (3, 'a@x')`), /unique|constraint/i);
			// The original survives — the duplicating insert rolled back.
			expect(await rows(db, `select id from x.u where email = 'a@x'`)).to.deep.equal([{ id: 1 }]);
			// Two NULL emails are both accepted (SQL UNIQUE is NULL-distinct).
			await db.exec('insert into x.u (id, email) values (4, null)');
			await db.exec('insert into x.u (id, email) values (5, null)');
			expect(await rows(db, 'select count(*) as n from x.u where email is null')).to.deep.equal([{ n: 2 }]);
		} finally {
			await db.close();
		}
	});

	it('a re-keyed PK (commit-time set-level) ABORTs a duplicate logical key', async () => {
		const db = new Database();
		try {
			// Basis keys on `id`; the logical table re-keys on `code` — reconstructible but
			// not basis-proved ⇒ the PK routes to a commit-time set-level scan.
			await db.exec('declare schema y { table t (id integer primary key, code text) }');
			await db.exec('apply schema y');
			await db.exec('declare logical schema x { table t (code text primary key, id integer) }');
			await db.exec('apply schema x');

			await db.exec(`insert into x.t (code, id) values ('A', 1)`);
			await db.exec(`insert into x.t (code, id) values ('B', 2)`); // distinct code ⇒ ok
			// Duplicate code (distinct basis id, so the basis PK does not catch it) ⇒ ABORT.
			await expectThrows(() => db.exec(`insert into x.t (code, id) values ('A', 3)`), /primary|unique|constraint/i);
			expect(await rows(db, `select id from x.t where code = 'A'`)).to.deep.equal([{ id: 1 }]);
		} finally {
			await db.close();
		}
	});

	it('the synthesized count check references the basis column on NEW and the logical column inside the subquery (rename override)', async () => {
		const db = new Database();
		try {
			await db.exec('declare schema y { table u (id integer primary key, mail text null) }');
			await db.exec('apply schema y');
			await db.exec('declare logical schema x { table u (id integer primary key, email text null, unique (email)) }');
			await db.exec('declare lens for x over y { view u as select id, mail as email from y.u }');
			await db.exec('apply schema x');

			const routed = collectLensSetLevelConstraints(slot(db, 'u'));
			expect(routed.length, 'one routed set-level check').to.equal(1);
			expect(routed[0].tags?.[LENS_BOUNDARY_ATTACHED_TAG], 'boundary marker present').to.equal(true);
			expect(routed[0].name, 'anonymous unique ⇒ lens:unique').to.equal('lens:unique');
			const exprSql = astToString(routed[0].expr);
			expect(exprSql, 'a count(*) existence-count check').to.match(/count\(\*\)/i);
			expect(exprSql, 'compared <= 1').to.match(/<=\s*1/);
			expect(exprSql, 'NEW side uses the basis column `mail`').to.match(/\bmail\b/i);
			expect(exprSql, 'subquery side keeps the logical column `email`').to.match(/\bemail\b/i);

			// And it enforces in basis terms: a duplicate email aborts; the basis stores `mail`.
			await db.exec(`insert into x.u (id, email) values (1, 'a@x')`);
			await expectThrows(() => db.exec(`insert into x.u (id, email) values (2, 'a@x')`), /unique|constraint/i);
			expect(await rows(db, 'select mail from y.u where id = 1')).to.deep.equal([{ mail: 'a@x' }]);
		} finally {
			await db.close();
		}
	});

	it('a composite unique key: all-/any-NULL tuples allowed, a fully-non-NULL duplicate ABORTs', async () => {
		const db = new Database();
		try {
			await db.exec('declare schema y { table t (id integer primary key, a integer null, b integer null) }');
			await db.exec('apply schema y');
			await db.exec('declare logical schema x { table t (id integer primary key, a integer null, b integer null, unique (a, b)) }');
			await db.exec('apply schema x');

			// (1, NULL) twice ⇒ both allowed (the b=NULL term makes the equality NULL, never counted).
			await db.exec('insert into x.t (id, a, b) values (1, 1, null)');
			await db.exec('insert into x.t (id, a, b) values (2, 1, null)');
			expect(await rows(db, 'select count(*) as n from x.t where a = 1 and b is null')).to.deep.equal([{ n: 2 }]);
			// (1, 2) twice ⇒ the second ABORTs.
			await db.exec('insert into x.t (id, a, b) values (3, 1, 2)');
			await expectThrows(() => db.exec('insert into x.t (id, a, b) values (4, 1, 2)'), /unique|constraint/i);
			expect(await rows(db, 'select count(*) as n from x.t where a = 1 and b = 2')).to.deep.equal([{ n: 1 }]);
		} finally {
			await db.close();
		}
	});

	it('an UPDATE that creates a duplicate ABORTs; one that keeps the key unique succeeds', async () => {
		const db = new Database();
		try {
			await db.exec('declare schema y { table u (id integer primary key, email text null) }');
			await db.exec('apply schema y');
			await db.exec('declare logical schema x { table u (id integer primary key, email text null, unique (email)) }');
			await db.exec('apply schema x');

			await db.exec(`insert into x.u (id, email) values (1, 'a@x'), (2, 'b@x')`);
			// Update row 2's key to collide with row 1 ⇒ ABORT (row 2 unchanged).
			await expectThrows(() => db.exec(`update x.u set email = 'a@x' where id = 2`), /unique|constraint/i);
			expect(await rows(db, 'select email from x.u where id = 2')).to.deep.equal([{ email: 'b@x' }]);
			// Update to a still-unique key ⇒ ok.
			await db.exec(`update x.u set email = 'c@x' where id = 2`);
			expect(await rows(db, 'select email from x.u where id = 2')).to.deep.equal([{ email: 'c@x' }]);
		} finally {
			await db.close();
		}
	});

	it('an intra-statement duplicate (two new rows sharing the key) ABORTs the whole statement', async () => {
		const db = new Database();
		try {
			await db.exec('declare schema y { table u (id integer primary key, email text null) }');
			await db.exec('apply schema y');
			await db.exec('declare logical schema x { table u (id integer primary key, email text null, unique (email)) }');
			await db.exec('apply schema x');

			await expectThrows(() => db.exec(`insert into x.u (id, email) values (1, 'dup'), (2, 'dup')`), /unique|constraint/i);
			expect(await rows(db, 'select count(*) as n from x.u')).to.deep.equal([{ n: 0 }]);
		} finally {
			await db.close();
		}
	});

	it('deferred timing — a transient duplicate resolved before commit commits cleanly; still-duplicate ABORTs', async () => {
		const db = new Database();
		try {
			await db.exec('declare schema y { table u (id integer primary key, email text null) }');
			await db.exec('apply schema y');
			await db.exec('declare logical schema x { table u (id integer primary key, email text null, unique (email)) }');
			await db.exec('apply schema x');

			await db.exec(`insert into x.u (id, email) values (1, 'a@x')`);

			// Transiently duplicate, then resolved by deleting the original before commit.
			await db.exec('begin');
			await db.exec(`insert into x.u (id, email) values (2, 'a@x')`); // dup at this point
			await db.exec('delete from x.u where id = 1'); // resolves it
			await db.exec('commit');
			expect(await rows(db, `select id from x.u where email = 'a@x'`)).to.deep.equal([{ id: 2 }]);

			// A state still duplicate at commit ABORTs.
			await expectThrows(async () => {
				await db.exec('begin');
				await db.exec(`insert into x.u (id, email) values (3, 'a@x')`); // collides with id=2
				await db.exec('commit');
			}, /unique|constraint/i);
			// id=2's row is the only 'a@x' (the failed txn rolled back).
			expect(await rows(db, `select id from x.u where email = 'a@x'`)).to.deep.equal([{ id: 2 }]);
		} finally {
			await db.close();
		}
	});

	it('rejects `or replace` / `or ignore` / upsert against a commit-time set-level key; `or abort` / plain insert pass', async () => {
		const db = new Database();
		try {
			await db.exec('declare schema y { table u (id integer primary key, email text null) }');
			await db.exec('apply schema y');
			await db.exec('declare logical schema x { table u (id integer primary key, email text null, unique (email)) }');
			await db.exec('apply schema x');

			await expectThrows(() => db.exec(`insert or ignore into x.u (id, email) values (1, 'a@x')`), /covering|commit-time scan|conflict/i);
			await expectThrows(() => db.exec(`insert or replace into x.u (id, email) values (1, 'a@x')`), /covering|commit-time scan|conflict/i);
			await expectThrows(() => db.exec(`insert into x.u (id, email) values (1, 'a@x') on conflict (email) do nothing`), /covering|commit-time scan|conflict/i);

			// `or abort` and a plain insert are NOT rejected (still subject to the duplicate check).
			await db.exec(`insert or abort into x.u (id, email) values (1, 'a@x')`);
			await db.exec(`insert into x.u (id, email) values (2, 'b@x')`);
			expect(await rows(db, 'select count(*) as n from x.u')).to.deep.equal([{ n: 2 }]);
			// The duplicate check still bites under `or abort`.
			await expectThrows(() => db.exec(`insert or abort into x.u (id, email) values (3, 'a@x')`), /unique|constraint/i);
		} finally {
			await db.close();
		}
	});

	it('a proved key (faithful projection of the basis PK) ⇒ collector returns [], write unaffected', async () => {
		const db = new Database();
		try {
			await db.exec('declare schema y { table t (id integer primary key, val integer) }');
			await db.exec('apply schema y');
			await db.exec('declare logical schema x { table t (id integer primary key, val integer) }');
			await db.exec('apply schema x');
			expect(collectLensSetLevelConstraints(slot(db, 't')), 'proved PK ⇒ []').to.deep.equal([]);
			await db.exec('insert into x.t (id, val) values (1, 7)');
			expect(await rows(db, 'select val from x.t where id = 1')).to.deep.equal([{ val: 7 }]);
		} finally {
			await db.close();
		}
	});

	it('a row-time key (a non-stale basis covering MV answers it) ⇒ collector returns [] (only commit-time emits)', async () => {
		const db = new Database();
		try {
			await db.exec('declare schema y { table u (id integer primary key, email text null, unique (email)) }');
			await db.exec('apply schema y');
			// Explicit basis covering MV over the UNIQUE columns ⇒ the unique classifies row-time.
			await db.exec('create materialized view y.ix_u_email as select email, id from y.u where email is not null order by email');
			await db.exec('declare logical schema x { table u (id integer primary key, email text null, unique (email)) }');
			await db.exec('apply schema x');
			expect(collectLensSetLevelConstraints(slot(db, 'u')), 'row-time unique ⇒ []').to.deep.equal([]);
		} finally {
			await db.close();
		}
	});
});

describe('lens enforcement: logical UNIQUE over a bijective authored inverse', () => {
	// A logical UNIQUE over a proven-bijective `with inverse` column is realizable
	// (ticket `authored-bijection-unique-realizable`): the bijection transports
	// uniqueness to/from the put target. Pin the two backing shapes — `proved` when
	// the put target is a declared basis key, `commit-time` otherwise — mirroring the
	// PK transport pins. Integer +10 affine bijection (backend-agnostic). The logical
	// UNIQUE column is NOT NULL because the bijection-transport proof requires it (a
	// nullable key defers to commit-time per the prereq's transport guard).
	const BIJECTIVE_LENS = 'declare lens for x over y { view t as select id, code + 10 as grp with inverse (code = new.grp - 10) from y.t }';

	it('proved via a basis UNIQUE over the put target ⇒ no set-level obligation, collector []', async () => {
		const db = new Database();
		try {
			await db.exec('declare schema y { table t (id integer primary key, code integer not null unique check (code in (1, 2, 3))) }');
			await db.exec('apply schema y');
			await db.exec('declare logical schema x { table t (id integer primary key, grp integer not null check (grp in (11, 12, 13)), unique (grp)) }');
			await db.exec(BIJECTIVE_LENS);
			await db.exec('apply schema x');

			// The basis UNIQUE over the put target makes the logical UNIQUE intrinsically
			// unique under the bijection ⇒ `proved`, never `enforced-set-level`.
			expect(setLevelModes(slot(db, 't')), 'proved bijective UNIQUE ⇒ no set-level obligation').to.deep.equal([]);
			expect(
				(slot(db, 't').obligations ?? []).some(o => o.kind === 'proved' && o.constraint.kind === 'unique'),
				'the UNIQUE is classified proved',
			).to.be.true;
			expect(collectLensSetLevelConstraints(slot(db, 't')), 'proved UNIQUE ⇒ []').to.deep.equal([]);
			expect(hasCommitTimeSetLevelObligation(slot(db, 't')), 'no commit-time obligation').to.be.false;
		} finally {
			await db.close();
		}
	});

	it('no basis key over the put target ⇒ commit-time obligation + count-scan collector', async () => {
		const db = new Database();
		try {
			// Same bijective authored UNIQUE, but `code` carries only CHECK + NOT NULL (no
			// basis UNIQUE/PK), so the transport proof fails and the authored projection
			// has no bare basis column for a covering structure ⇒ commit-time scan.
			await db.exec('declare schema y { table t (id integer primary key, code integer not null check (code in (1, 2, 3))) }');
			await db.exec('apply schema y');
			await db.exec('declare logical schema x { table t (id integer primary key, grp integer not null check (grp in (11, 12, 13)), unique (grp)) }');
			await db.exec(BIJECTIVE_LENS);
			await db.exec('apply schema x');

			expect(setLevelModes(slot(db, 't')), 'bijective UNIQUE with no basis key ⇒ commit-time').to.deep.equal(['commit-time']);
			expect(hasCommitTimeSetLevelObligation(slot(db, 't')), 'commit-time obligation present').to.be.true;
			expect(collectLensSetLevelConstraints(slot(db, 't')).length, 'one count-scan set-level constraint').to.equal(1);

			// And it enforces: a logical-key duplicate (grp 11 → code 1) ABORTs via the
			// commit-time count scan over the forward image (the basis has no UNIQUE).
			await db.exec('insert into x.t (id, grp) values (1, 11)');
			await expectThrows(() => db.exec('insert into x.t (id, grp) values (2, 11)'), /unique|constraint/i);
			expect(await rows(db, 'select code from y.t order by code')).to.deep.equal([{ code: 1 }]);
		} finally {
			await db.close();
		}
	});
});

describe('lens enforcement: conflict action on a transport-proved key', () => {
	// A `proved` key is enforced for free by whatever declared basis key stands behind
	// the proof — never the logical key — so a logical `on conflict replace`/`ignore`
	// that governing key does not itself carry is silently dropped, and the prover
	// rejects it at deploy with `lens.unenforceable-conflict-action` (tickets
	// `lens-proved-transport-key-conflict-action-drop` +
	// `lens-proved-superkey-basis-key-conflict-action-drop`). The governing basis key is
	// identified by a SUBSET search over the mapped basis columns, so the check is
	// decoupled from the transport proof's exact-match/single-source gate: it fires
	// whether the key is proved by the body (a faithful projection of a basis key, or a
	// strict superkey of a smaller basis key) or by bijection transport (an authored
	// bijection the body cannot prove). A *matching* basis-key action deploys clean (the
	// basis key honors it for free — the documented remediation); a genuinely
	// basis-keyless proof (a GROUP BY aggregate with no basis UC over the key) governs
	// no basis key, so its `on conflict` is vacuous and deploys clean. A multi-source
	// body cannot pin the governing key, so it rejects conservatively.
	const BIJECTIVE_LENS = 'declare lens for x over y { view t as select id, code + 10 as grp with inverse (code = new.grp - 10) from y.t }';
	const BARE_RENAME_LENS = 'declare lens for x over y { view t as select id, code as grp from y.t }';

	it('authored-bijective UNIQUE with a MISMATCHED `on conflict replace` (basis ABORT) blocks the deploy', async () => {
		const db = new Database();
		try {
			await db.exec('declare schema y { table t (id integer primary key, code integer not null unique check (code in (1, 2, 3))) }');
			await db.exec('apply schema y');
			await db.exec('declare logical schema x { table t (id integer primary key, grp integer not null check (grp in (11, 12, 13)), unique (grp) on conflict replace) }');
			await db.exec(BIJECTIVE_LENS);
			await expectThrows(() => db.exec('apply schema x'), /unenforceable-conflict-action/);
		} finally {
			await db.close();
		}
	});

	it('bare-rename UNIQUE proved by the BODY (basis NOT-NULL UNIQUE is a relation key) with a MISMATCHED action also blocks', async () => {
		// The headline repro: `code as grp` is a faithful projection, so the body proves
		// the key via the basis NOT-NULL UNIQUE → relation key, never reaching the
		// transport classification. The basis UNIQUE still governs the write, so the
		// dropped REPLACE must red on the body-proved path too (not only on transport).
		const db = new Database();
		try {
			await db.exec('declare schema y { table t (id integer primary key, code integer not null unique check (code in (1, 2, 3))) }');
			await db.exec('apply schema y');
			await db.exec('declare logical schema x { table t (id integer primary key, grp integer not null check (grp in (1, 2, 3)), unique (grp) on conflict replace) }');
			await db.exec(BARE_RENAME_LENS);
			await expectThrows(() => db.exec('apply schema x'), /unenforceable-conflict-action/);
		} finally {
			await db.close();
		}
	});

	it('a transport-proved PK with a MISMATCHED action (basis PK ABORT) blocks the deploy', async () => {
		const db = new Database();
		try {
			await db.exec('declare schema y { table t (k integer primary key check (k in (1, 2, 3))) }');
			await db.exec('apply schema y');
			await db.exec('declare logical schema x { table t (n integer primary key on conflict replace check (n in (11, 12, 13))) }');
			await db.exec('declare lens for x over y { view t as select k + 10 as n with inverse (k = new.n - 10) from y.t }');
			await expectThrows(() => db.exec('apply schema x'), /unenforceable-conflict-action/);
		} finally {
			await db.close();
		}
	});

	it('a MATCHING basis-UNIQUE action keeps the key `proved` and deploys clean', async () => {
		const db = new Database();
		try {
			await db.exec('declare schema y { table t (id integer primary key, code integer not null unique on conflict replace check (code in (1, 2, 3))) }');
			await db.exec('apply schema y');
			await db.exec('declare logical schema x { table t (id integer primary key, grp integer not null check (grp in (11, 12, 13)), unique (grp) on conflict replace) }');
			await db.exec(BIJECTIVE_LENS);
			await db.exec('apply schema x'); // no throw — the basis UNIQUE honors REPLACE for free

			expect(
				(slot(db, 't').obligations ?? []).some(o => o.kind === 'proved' && o.constraint.kind === 'unique'),
				'matching action ⇒ still classified proved',
			).to.be.true;
			expect(collectLensSetLevelConstraints(slot(db, 't')), 'proved ⇒ no set-level obligation').to.deep.equal([]);
		} finally {
			await db.close();
		}
	});

	// ── Superkey governance: the body proves a strict superkey of a smaller basis key.
	// The smaller basis key (a subset of the logical key's mapped basis columns) governs
	// every write-through duplicate, yet transport's exact-match `findDeclaredKey` misses
	// it. The subset governance search (`findGoverningBasisKeys`) catches it.
	// (ticket `lens-proved-superkey-basis-key-conflict-action-drop`).
	const SUPERKEY_BARE_LENS = 'declare lens for x over y { view t as select id, a, b from y.t }';

	it('superkey UNIQUE (basis NOT-NULL unique(a) ⊊ logical unique(a,b)) with MISMATCHED REPLACE blocks (the confirmed repro)', async () => {
		// The body proves `unique(a,b)` because basis NOT-NULL `unique(a)` → relation key
		// `{a}` ⊆ `{a,b}`. The basis `unique(a)` (ABORT) governs any write-through `(a,b)`
		// duplicate (it is also a duplicate `a`), so the logical REPLACE is never consulted.
		const db = new Database();
		try {
			await db.exec('declare schema y { table t (id integer primary key, a integer not null unique check (a in (1, 2, 3)), b integer not null) }');
			await db.exec('apply schema y');
			await db.exec('declare logical schema x { table t (id integer primary key, a integer not null check (a in (1, 2, 3)), b integer not null, unique (a, b) on conflict replace) }');
			await db.exec(SUPERKEY_BARE_LENS);
			await expectThrows(() => db.exec('apply schema x'), /unenforceable-conflict-action/);
		} finally {
			await db.close();
		}
	});

	it('superkey UNIQUE with MISMATCHED IGNORE blocks (IGNORE arm of the basis-governed rejecter)', async () => {
		const db = new Database();
		try {
			await db.exec('declare schema y { table t (id integer primary key, a integer not null unique check (a in (1, 2, 3)), b integer not null) }');
			await db.exec('apply schema y');
			await db.exec('declare logical schema x { table t (id integer primary key, a integer not null check (a in (1, 2, 3)), b integer not null, unique (a, b) on conflict ignore) }');
			await db.exec(SUPERKEY_BARE_LENS);
			await expectThrows(() => db.exec('apply schema x'), /unenforceable-conflict-action/);
		} finally {
			await db.close();
		}
	});

	it('superkey PK (logical primary key (a,b) ⊋ basis unique(a)) with MISMATCHED REPLACE blocks (PK action via resolvePkDefaultConflict)', async () => {
		// The logical PK `(a,b)` is a strict superkey of the basis NOT-NULL `unique(a)`.
		// The PK's REPLACE is resolved through `resolvePkDefaultConflict`; the basis
		// `unique(a)` (ABORT) governs the duplicate, so it must red.
		const db = new Database();
		try {
			await db.exec('declare schema y { table t (id integer primary key, a integer not null unique check (a in (1, 2, 3)), b integer not null) }');
			await db.exec('apply schema y');
			await db.exec('declare logical schema x { table t (id integer not null, a integer not null check (a in (1, 2, 3)), b integer not null, primary key (a, b) on conflict replace) }');
			await db.exec(SUPERKEY_BARE_LENS);
			await expectThrows(() => db.exec('apply schema x'), /unenforceable-conflict-action/);
		} finally {
			await db.close();
		}
	});

	it('superkey UNIQUE whose governing basis key carries the MATCHING action deploys clean (honored for free)', async () => {
		// Basis `unique(a) on conflict replace` ⊆ logical `unique(a,b) on conflict replace`:
		// the governing key already resolves the declared action, so nothing to reject.
		const db = new Database();
		try {
			await db.exec('declare schema y { table t (id integer primary key, a integer not null unique on conflict replace check (a in (1, 2, 3)), b integer not null) }');
			await db.exec('apply schema y');
			await db.exec('declare logical schema x { table t (id integer primary key, a integer not null check (a in (1, 2, 3)), b integer not null, unique (a, b) on conflict replace) }');
			await db.exec(SUPERKEY_BARE_LENS);
			await db.exec('apply schema x'); // no throw — the basis unique(a) honors REPLACE for free

			expect(
				(slot(db, 't').obligations ?? []).some(o => o.kind === 'proved' && o.constraint.kind === 'unique'),
				'matching governing action ⇒ still classified proved',
			).to.be.true;
			expect(collectLensSetLevelConstraints(slot(db, 't')), 'proved ⇒ no set-level obligation').to.deep.equal([]);
		} finally {
			await db.close();
		}
	});

	it('multi-source proved key with a MISMATCHED REPLACE blocks conservatively (governing key not pinnable)', async () => {
		// A 1:1 join body is multi-source — `ctx.basisSource` is undefined, so the 1:1
		// logical→basis column mapping the subset search needs does not exist and the
		// superkey soundness argument does not transfer across the decomposition.
		// Governance cannot be pinned, so the declared REPLACE rejects conservatively.
		const db = new Database();
		try {
			await db.exec('declare schema y { table Core { id integer primary key, name text } table Contact { id integer primary key, email text } }');
			await db.exec('apply schema y');
			await db.exec('declare logical schema x { table Person { id integer primary key on conflict replace, name text, email text } }');
			await db.exec('declare lens for x over y { view Person as select c.id, c.name, k.email from y.Core c join y.Contact k using (id) }');
			await expectThrows(() => db.exec('apply schema x'), /unenforceable-conflict-action/);
		} finally {
			await db.close();
		}
	});

	it('genuinely basis-keyless proof (DISTINCT, no basis UC over the key) with `on conflict replace` deploys clean (no false positive)', async () => {
		// `select distinct a, b from y.t` proves `primary key (a, b)` (DISTINCT makes the
		// full output a key) yet stays writable, but no declared basis key is a subset of
		// `{a, b}` (the basis PK is `{id}`), so the proof is genuinely basis-keyless. The
		// governance subset search finds no governing basis key ⇒ the `on conflict replace`
		// is vacuous ⇒ deploy clean. This exercises the "no governing key → clean" branch.
		// (A `group by a, b` body — no aggregate — would instead classify enforced-set-level
		// commit-time here and be rejected by the pre-existing commit-time block, so DISTINCT
		// is the shape that actually reaches `proved`.)
		const db = new Database();
		try {
			await db.exec('declare schema y { table t (id integer primary key, a integer not null, b integer not null) }');
			await db.exec('apply schema y');
			await db.exec('declare logical schema x { table v (a integer not null, b integer not null, primary key (a, b) on conflict replace) }');
			await db.exec('declare lens for x over y { view v as select distinct a, b from y.t }');
			await db.exec('apply schema x'); // no throw — no governing basis key, so the action is vacuous

			expect(
				(slot(db, 'v').obligations ?? []).some(o => o.kind === 'proved' && o.constraint.kind === 'primaryKey'),
				'distinct proves the key',
			).to.be.true;
			expect(collectLensSetLevelConstraints(slot(db, 'v')), 'proved ⇒ no set-level obligation').to.deep.equal([]);
		} finally {
			await db.close();
		}
	});

	it('a smaller disagreeing subset basis key supersedes an exact transport match and blocks', async () => {
		// The basis has BOTH an exact `unique(a, b) on conflict replace` (which transport's
		// `findDeclaredKey` matches) AND a smaller `unique(a)` defaulting to ABORT. The
		// logical `unique(a, b) on conflict replace` matches the exact basis key — under the
		// OLD transport-coupled rejecter it deployed clean. But `unique(a)` ⊆ `{a, b}` also
		// governs every `(a, b)` duplicate, and if it fires first the REPLACE is dropped, so
		// the decoupled subset governance correctly reds, naming the smaller key. This pins
		// the soundness gain of decoupling governance from the exact transport match.
		const db = new Database();
		try {
			await db.exec('declare schema y { table t (id integer primary key, a integer not null, b integer not null, unique (a, b) on conflict replace, unique (a)) }');
			await db.exec('apply schema y');
			await db.exec('declare logical schema x { table t (id integer primary key, a integer not null, b integer not null, unique (a, b) on conflict replace) }');
			await db.exec(SUPERKEY_BARE_LENS);
			await expectThrows(() => db.exec('apply schema x'), /unenforceable-conflict-action[\s\S]*basis unique \(a\)/);
		} finally {
			await db.close();
		}
	});
});

describe('lens enforcement: set-level (unique / PK) row-time at the write boundary', () => {
	/**
	 * Deploys a row-time set-level lens: a basis `unique(email)` plus an explicit
	 * covering materialized view `order by email` (so the logical `unique(email)`
	 * classifies `enforced-set-level` `row-time`, backed by the basis UC's physical
	 * covering-MV enforcement path). No new lens enforcement code carries this — the
	 * single-source re-plan reaches the basis UC, whose `checkUniqueViaMaterializedView`
	 * does the O(log n) existence lookup and honors ABORT/IGNORE/REPLACE.
	 */
	async function deployRowTimeUniqueLens(db: Database): Promise<void> {
		await db.exec('declare schema y { table u (id integer primary key, email text null, unique (email)) }');
		await db.exec('apply schema y');
		await db.exec('create materialized view y.ix_u_email as select email, id from y.u where email is not null order by email');
		await db.exec('declare logical schema x { table u (id integer primary key, email text null, unique (email)) }');
		await db.exec('apply schema x');
	}

	it('row-time unique ⇒ the commit-time collector emits nothing (separate covering-MV path)', async () => {
		const db = new Database();
		try {
			await deployRowTimeUniqueLens(db);
			// Pin the classification itself, not just the collector: the unique(email)
			// must be `enforced-set-level` `row-time` (the covering MV answers it). A
			// `proved` key would also pass the two assertions below, so without this
			// the suite could silently exercise a proved key instead of a row-time one.
			expect(setLevelModes(slot(db, 'u')), 'unique classifies row-time').to.deep.equal(['row-time']);
			// The commit-time count-subquery collector is the wrong class for a row-time
			// key: detection + resolution ride the basis UC's covering-MV path, not this.
			expect(collectLensSetLevelConstraints(slot(db, 'u')), 'row-time unique ⇒ []').to.deep.equal([]);
			expect(hasCommitTimeSetLevelObligation(slot(db, 'u')), 'no commit-time obligation').to.be.false;
		} finally {
			await db.close();
		}
	});

	it('detection aborts a duplicate; the original survives', async () => {
		const db = new Database();
		try {
			await deployRowTimeUniqueLens(db);
			await db.exec(`insert into x.u (id, email) values (1, 'a@x'), (2, 'b@x')`);
			// A third row duplicating an existing key ABORTs (basis UC via covering MV).
			await expectThrows(() => db.exec(`insert into x.u (id, email) values (3, 'a@x')`), /unique|constraint/i);
			// The original survives — the duplicating insert rolled back.
			expect(await rows(db, `select id from x.u where email = 'a@x'`)).to.deep.equal([{ id: 1 }]);
			expect(await rows(db, 'select count(*) as n from x.u')).to.deep.equal([{ n: 2 }]);
		} finally {
			await db.close();
		}
	});

	it('`insert or replace` resolves through the lens — evicts the prior row, lands the new one', async () => {
		const db = new Database();
		try {
			await deployRowTimeUniqueLens(db);
			await db.exec(`insert into x.u (id, email) values (1, 'a@x')`);
			// REPLACE on the unique(email) conflict evicts id=1 and lands id=5.
			await db.exec(`insert or replace into x.u (id, email) values (5, 'a@x')`);
			// Only the new id remains for that key — asserted by both logical and basis reads.
			expect(await rows(db, `select id from x.u where email = 'a@x'`)).to.deep.equal([{ id: 5 }]);
			expect(await rows(db, `select id from y.u where email = 'a@x'`)).to.deep.equal([{ id: 5 }]);
			expect(await rows(db, 'select count(*) as n from x.u')).to.deep.equal([{ n: 1 }]);
		} finally {
			await db.close();
		}
	});

	it('`insert or ignore` resolves through the lens — skips the duplicate, leaves the original; a fresh key still lands', async () => {
		const db = new Database();
		try {
			await deployRowTimeUniqueLens(db);
			await db.exec(`insert into x.u (id, email) values (1, 'a@x')`);
			// IGNORE silently drops the duplicate; the original is untouched.
			await db.exec(`insert or ignore into x.u (id, email) values (5, 'a@x')`);
			expect(await rows(db, `select id from x.u where email = 'a@x'`)).to.deep.equal([{ id: 1 }]);
			// A fresh-key `or ignore` still lands.
			await db.exec(`insert or ignore into x.u (id, email) values (6, 'b@x')`);
			expect(await rows(db, `select id from x.u where email = 'b@x'`)).to.deep.equal([{ id: 6 }]);
		} finally {
			await db.close();
		}
	});

	it('explicit `or abort` ABORTs on a duplicate (consistent with a plain insert)', async () => {
		const db = new Database();
		try {
			await deployRowTimeUniqueLens(db);
			await db.exec(`insert into x.u (id, email) values (1, 'a@x')`);
			await expectThrows(() => db.exec(`insert or abort into x.u (id, email) values (2, 'a@x')`), /unique|constraint/i);
			expect(await rows(db, `select id from x.u where email = 'a@x'`)).to.deep.equal([{ id: 1 }]);
		} finally {
			await db.close();
		}
	});

	it('conflict resolution is NOT rejected — `or replace` / `or ignore` / upsert plan against a row-time key', async () => {
		const db = new Database();
		try {
			await deployRowTimeUniqueLens(db);
			// The negative of the commit-time rejection test: a row-time key has no
			// `enforced-set-level` `commit-time` obligation, so the conflict-resolution
			// gate (`rejectLensSetLevelConflictResolution`) declines to reject — the
			// covering MV resolves at row-time. None of these raise the
			// `lens-set-level-conflict-resolution` diagnostic.
			await db.exec(`insert or replace into x.u (id, email) values (1, 'a@x')`);
			await db.exec(`insert or ignore into x.u (id, email) values (2, 'b@x')`);
			await db.exec(`insert into x.u (id, email) values (3, 'c@x') on conflict (email) do nothing`);
			expect(await rows(db, 'select count(*) as n from x.u')).to.deep.equal([{ n: 3 }]);
		} finally {
			await db.close();
		}
	});

	it('an UPDATE that creates a duplicate ABORTs; one that keeps the key unique succeeds', async () => {
		const db = new Database();
		try {
			await deployRowTimeUniqueLens(db);
			await db.exec(`insert into x.u (id, email) values (1, 'a@x'), (2, 'b@x')`);
			// Re-key row 2 onto row 1's key ⇒ ABORT (row 2 unchanged).
			await expectThrows(() => db.exec(`update x.u set email = 'a@x' where id = 2`), /unique|constraint/i);
			expect(await rows(db, 'select email from x.u where id = 2')).to.deep.equal([{ email: 'b@x' }]);
			// Re-key to a still-unique value ⇒ ok.
			await db.exec(`update x.u set email = 'c@x' where id = 2`);
			expect(await rows(db, 'select email from x.u where id = 2')).to.deep.equal([{ email: 'c@x' }]);
		} finally {
			await db.close();
		}
	});

	it('NULL-distinct holds — multiple NULL-key rows are all accepted', async () => {
		const db = new Database();
		try {
			await deployRowTimeUniqueLens(db);
			// The basis UC skips NULL columns and the covering MV is `where email is not
			// null`, so SQL UNIQUE's NULL-distinct semantics hold through the lens.
			await db.exec('insert into x.u (id, email) values (1, null)');
			await db.exec('insert into x.u (id, email) values (2, null)');
			expect(await rows(db, 'select count(*) as n from x.u where email is null')).to.deep.equal([{ n: 2 }]);
		} finally {
			await db.close();
		}
	});

	it('rename override — detection + replace fire in basis terms (covering MV over `mail`)', async () => {
		const db = new Database();
		try {
			await db.exec('declare schema y { table u (id integer primary key, mail text null, unique (mail)) }');
			await db.exec('apply schema y');
			await db.exec('create materialized view y.ix_u_mail as select mail, id from y.u where mail is not null order by mail');
			await db.exec('declare logical schema x { table u (id integer primary key, email text null, unique (email)) }');
			await db.exec('declare lens for x over y { view u as select id, mail as email from y.u }');
			await db.exec('apply schema x');

			// No commit-time obligation — the row-time covering MV over `mail` answers it.
			expect(setLevelModes(slot(db, 'u')), 'rename classifies row-time').to.deep.equal(['row-time']);
			expect(collectLensSetLevelConstraints(slot(db, 'u')), 'rename row-time ⇒ []').to.deep.equal([]);

			await db.exec(`insert into x.u (id, email) values (1, 'a@x')`);
			// Detection fires in basis terms; the single-source re-plan maps email→mail.
			await expectThrows(() => db.exec(`insert into x.u (id, email) values (2, 'a@x')`), /unique|constraint/i);
			// Replace resolves through the lens, evicting id=1.
			await db.exec(`insert or replace into x.u (id, email) values (5, 'a@x')`);
			expect(await rows(db, `select id from x.u where email = 'a@x'`)).to.deep.equal([{ id: 5 }]);
			expect(await rows(db, `select mail from y.u where id = 5`)).to.deep.equal([{ mail: 'a@x' }]);
		} finally {
			await db.close();
		}
	});

	it('re-keyed PK over a basis `unique(code)` is PROVED (not row-time) yet still resolves detection + replace through the basis key', async () => {
		const db = new Database();
		try {
			// A logical PK is NOT NULL, so when the basis carries a matching NOT-NULL
			// `unique(code)` the body *proves* the key outright ⇒ obligation `proved`,
			// never `enforced-set-level`. A row-time PK is therefore unreachable for a
			// faithful single-source projection: a basis UNIQUE+NOT-NULL proves it, and
			// with no basis UNIQUE it falls to a `commit-time` scan (covered in the
			// commit-time suite's re-keyed-PK case). The covering MV here is incidental.
			// What this still pins: a re-keyed PK backed by a basis key resolves detection
			// AND `or replace` end-to-end through that basis key (no lens code, as for the
			// row-time class — both ride the basis structure).
			await db.exec('declare schema y { table t (id integer primary key, code text, unique (code)) }');
			await db.exec('apply schema y');
			await db.exec('create materialized view y.ix_t_code as select code, id from y.t order by code');
			await db.exec('declare logical schema x { table t (code text primary key, id integer) }');
			await db.exec('apply schema x');

			// The body proves the key ⇒ no set-level obligation at all (not row-time).
			expect(setLevelModes(slot(db, 't')), 're-keyed PK over basis unique ⇒ proved, no set-level obligation').to.deep.equal([]);
			expect(
				(slot(db, 't').obligations ?? []).some(o => o.kind === 'proved' && o.constraint.kind === 'primaryKey'),
				'the PK is classified proved',
			).to.be.true;
			expect(collectLensSetLevelConstraints(slot(db, 't')), 'proved PK ⇒ []').to.deep.equal([]);

			await db.exec(`insert into x.t (code, id) values ('A', 1)`);
			await db.exec(`insert into x.t (code, id) values ('B', 2)`);
			await expectThrows(() => db.exec(`insert into x.t (code, id) values ('A', 3)`), /primary|unique|constraint/i);
			// Replace evicts the old code='A' row and lands the new one.
			await db.exec(`insert or replace into x.t (code, id) values ('A', 9)`);
			expect(await rows(db, `select id from x.t where code = 'A'`)).to.deep.equal([{ id: 9 }]);
		} finally {
			await db.close();
		}
	});

	it('composite row-time key — detection ABORTs a duplicate tuple, `or replace` resolves it (NULL-distinct holds)', async () => {
		const db = new Database();
		try {
			// A two-column unique answered by a covering MV over both columns classifies
			// row-time, so the basis UC's covering-MV path enforces the composite key with
			// no lens code (the corner the source ticket flagged as untested).
			await db.exec('declare schema y { table t (id integer primary key, a integer null, b integer null, unique (a, b)) }');
			await db.exec('apply schema y');
			await db.exec('create materialized view y.ix_t_ab as select a, b, id from y.t where a is not null and b is not null order by a, b');
			await db.exec('declare logical schema x { table t (id integer primary key, a integer null, b integer null, unique (a, b)) }');
			await db.exec('apply schema x');

			expect(setLevelModes(slot(db, 't')), 'composite key classifies row-time').to.deep.equal(['row-time']);

			await db.exec('insert into x.t (id, a, b) values (1, 1, 2)');
			// A duplicate composite tuple ABORTs.
			await expectThrows(() => db.exec('insert into x.t (id, a, b) values (2, 1, 2)'), /unique|constraint/i);
			// REPLACE on the composite conflict evicts the prior row and lands the new one.
			await db.exec('insert or replace into x.t (id, a, b) values (9, 1, 2)');
			expect(await rows(db, 'select id from x.t where a = 1 and b = 2')).to.deep.equal([{ id: 9 }]);
			// Any-NULL component ⇒ NULL-distinct, both accepted.
			await db.exec('insert into x.t (id, a, b) values (10, 1, null)');
			await db.exec('insert into x.t (id, a, b) values (11, 1, null)');
			expect(await rows(db, 'select count(*) as n from x.t where a = 1 and b is null')).to.deep.equal([{ n: 2 }]);
		} finally {
			await db.close();
		}
	});

	it('`on conflict (key) do update` upsert resolves through a row-time key — updates the existing row, no new row', async () => {
		const db = new Database();
		try {
			// An upsert with a DO UPDATE action (vs. the DO NOTHING covered above) against a
			// row-time key: the basis UC's covering-MV resolution applies the update to the
			// conflicting row rather than inserting a duplicate. The other untested corner
			// the source ticket called out.
			await db.exec('declare schema y { table u (id integer primary key, email text null, n integer null, unique (email)) }');
			await db.exec('apply schema y');
			await db.exec('create materialized view y.ix_u_email as select email, id from y.u where email is not null order by email');
			await db.exec('declare logical schema x { table u (id integer primary key, email text null, n integer null, unique (email)) }');
			await db.exec('apply schema x');

			expect(setLevelModes(slot(db, 'u')), 'upsert target classifies row-time').to.deep.equal(['row-time']);

			await db.exec(`insert into x.u (id, email, n) values (1, 'a@x', 10)`);
			// The conflicting key triggers DO UPDATE on the existing row (id stays 1, n→77);
			// no second row is inserted.
			await db.exec(`insert into x.u (id, email, n) values (2, 'a@x', 99) on conflict (email) do update set n = 77`);
			expect(await rows(db, 'select id, email, n from x.u order by id')).to.deep.equal([{ id: 1, email: 'a@x', n: 77 }]);
		} finally {
			await db.close();
		}
	});

	it('composes with a row-local check — the check ABORTs a bad row, the row-time key ABORTs a duplicate, a clean row lands', async () => {
		const db = new Database();
		try {
			await db.exec('declare schema y { table u (id integer primary key, email text null, val integer, unique (email)) }');
			await db.exec('apply schema y');
			await db.exec('create materialized view y.ix_u_email as select email, id from y.u where email is not null order by email');
			await db.exec('declare logical schema x { table u (id integer primary key, email text null, val integer, constraint nonneg check (val >= 0), unique (email)) }');
			await db.exec('apply schema x');

			expect(setLevelModes(slot(db, 'u')), 'the unique classifies row-time').to.deep.equal(['row-time']);

			await db.exec(`insert into x.u (id, email, val) values (1, 'a@x', 5)`);
			// Row-local check ABORTs a bad row.
			await expectThrows(() => db.exec(`insert into x.u (id, email, val) values (2, 'b@x', -1)`), /nonneg|constraint/i);
			// Row-time unique ABORTs a duplicate.
			await expectThrows(() => db.exec(`insert into x.u (id, email, val) values (3, 'a@x', 5)`), /unique|constraint/i);
			// Both satisfied ⇒ lands.
			await db.exec(`insert into x.u (id, email, val) values (4, 'd@x', 7)`);
			expect(await rows(db, 'select id, email, val from x.u where id = 4')).to.deep.equal([{ id: 4, email: 'd@x', val: 7 }]);
		} finally {
			await db.close();
		}
	});

	it('composition caveat — a slot carrying both a commit-time and a row-time key still rejects `or replace` (the commit-time key cannot replace-resolve)', async () => {
		const db = new Database();
		try {
			// Basis proves `email` unique (covering MV ⇒ row-time) but NOT `code` (no
			// covering structure ⇒ commit-time). The slot then carries both classes.
			await db.exec('declare schema y { table u (id integer primary key, email text null, code text null, unique (email)) }');
			await db.exec('apply schema y');
			await db.exec('create materialized view y.ix_u_email as select email, id from y.u where email is not null order by email');
			await db.exec('declare logical schema x { table u (id integer primary key, email text null, code text null, unique (email), unique (code)) }');
			await db.exec('apply schema x');

			// The commit-time `code` key keeps the slot's commit-time obligation set non-empty,
			// so `rejectLensSetLevelConflictResolution` fires on ANY conflict-resolution write —
			// this is the intended conservative behavior (the commit-time key genuinely cannot
			// replace-resolve), even though `email` alone is row-time-capable.
			expect(hasCommitTimeSetLevelObligation(slot(db, 'u')), 'commit-time obligation present').to.be.true;
			// Both classes genuinely co-exist on the slot (email row-time, code commit-time).
			expect(setLevelModes(slot(db, 'u')).slice().sort(), 'one row-time + one commit-time key').to.deep.equal(['commit-time', 'row-time']);
			await expectThrows(() => db.exec(`insert or replace into x.u (id, email, code) values (1, 'a@x', 'A')`), /covering|commit-time scan|conflict/i);
		} finally {
			await db.close();
		}
	});

	it('a matching basis-UC `on conflict replace` honors REPLACE on a plain duplicate insert (the verified remediation)', async () => {
		const db = new Database();
		try {
			// The remediation for the dropped-action gap (`lens-set-level-rowtime-logical-
			// conflict-action-not-honored`): declare the matching REPLACE on the *basis* UC.
			// The row-time re-plan then resolves REPLACE from the basis UC's `defaultConflict`
			// (`statement-OR ?? uc.defaultConflict ?? ABORT`), so a plain (no statement-OR)
			// duplicate insert REPLACEs through the lens. (The deploy-time prover requires
			// this matching action — a logical `on conflict replace` over a no-action basis UC
			// is rejected; see lens-prover.spec.ts's row-time conflict-action suite.)
			await db.exec('declare schema y { table u (id integer primary key, email text null, unique (email) on conflict replace) }');
			await db.exec('apply schema y');
			await db.exec('create materialized view y.ix_u_email as select email, id from y.u where email is not null order by email');
			await db.exec('declare logical schema x { table u (id integer primary key, email text null, unique (email) on conflict replace) }');
			await db.exec('apply schema x');

			expect(setLevelModes(slot(db, 'u')), 'classifies row-time').to.deep.equal(['row-time']);

			await db.exec(`insert into x.u (id, email) values (1, 'a@x')`);
			// A plain duplicate insert (no statement-level OR) REPLACEs via the basis UC's
			// declared REPLACE — evicts id=1, lands id=2.
			await db.exec(`insert into x.u (id, email) values (2, 'a@x')`);
			expect(await rows(db, `select id from x.u where email = 'a@x'`)).to.deep.equal([{ id: 2 }]);
			expect(await rows(db, `select id from y.u where email = 'a@x'`)).to.deep.equal([{ id: 2 }]);
			expect(await rows(db, 'select count(*) as n from x.u')).to.deep.equal([{ n: 1 }]);
		} finally {
			await db.close();
		}
	});

	it('a matching basis-UC `on conflict ignore` honors IGNORE on a plain duplicate insert (keeps the original)', async () => {
		const db = new Database();
		try {
			// IGNORE travels a different row-time branch than REPLACE: the duplicate is
			// silently dropped and the *original* row is kept (no eviction). Mirror the
			// matching-REPLACE remediation but with IGNORE on both the basis and logical UC.
			await db.exec('declare schema y { table u (id integer primary key, email text null, unique (email) on conflict ignore) }');
			await db.exec('apply schema y');
			await db.exec('create materialized view y.ix_u_email as select email, id from y.u where email is not null order by email');
			await db.exec('declare logical schema x { table u (id integer primary key, email text null, unique (email) on conflict ignore) }');
			await db.exec('apply schema x');

			expect(setLevelModes(slot(db, 'u')), 'classifies row-time').to.deep.equal(['row-time']);

			await db.exec(`insert into x.u (id, email) values (1, 'a@x')`);
			// A plain duplicate insert (no statement-level OR) is IGNOREd via the basis UC's
			// declared IGNORE — the original id=1 is kept, id=2 is dropped.
			await db.exec(`insert into x.u (id, email) values (2, 'a@x')`);
			expect(await rows(db, `select id from x.u where email = 'a@x'`)).to.deep.equal([{ id: 1 }]);
			expect(await rows(db, `select id from y.u where email = 'a@x'`)).to.deep.equal([{ id: 1 }]);
			expect(await rows(db, 'select count(*) as n from x.u')).to.deep.equal([{ n: 1 }]);
		} finally {
			await db.close();
		}
	});
});

describe('lens enforcement: parent-side FK RESTRICT at the write boundary', () => {
	/**
	 * Deploys a basis schema with **no** FK and a logical schema declaring the FK on
	 * the *child* referencing the *parent*. The basis holds the data; the logical FK
	 * exists only at the lens boundary, so it is the lens — not the basis — that must
	 * enforce the **parent side**: a delete/update of a logical parent runs the
	 * RESTRICT existence check against the logical child. `foreign_keys` defaults on.
	 */
	async function deployParentFkLens(db: Database): Promise<void> {
		await db.exec('declare schema y { table parent (id integer primary key, name text); table child (id integer primary key, pid integer null) }');
		await db.exec('apply schema y');
		await db.exec('declare logical schema x { table parent (id integer primary key, name text); table child (id integer primary key, pid integer null, constraint fk_pid foreign key (pid) references parent(id)) }');
		await db.exec('apply schema x');
	}

	it('the core gap — deleting a referenced logical parent ABORTs through the lens though the basis has no FK; an unreferenced parent deletes', async () => {
		const db = new Database();
		try {
			await deployParentFkLens(db);
			await db.exec(`insert into x.parent (id, name) values (1, 'a'), (2, 'b')`);
			await db.exec('insert into x.child (id, pid) values (10, 1)'); // child references parent 1
			// Deleting the referenced parent (id=1) would orphan child 10 ⇒ ABORT at commit.
			await expectThrows(() => db.exec('delete from x.parent where id = 1'), /constraint|foreign|fk_/i);
			expect(await rows(db, 'select count(*) as n from x.parent where id = 1'), 'referenced parent survives').to.deep.equal([{ n: 1 }]);
			// Deleting an unreferenced parent (id=2) succeeds.
			await db.exec('delete from x.parent where id = 2');
			expect(await rows(db, 'select count(*) as n from x.parent where id = 2')).to.deep.equal([{ n: 0 }]);
		} finally {
			await db.close();
		}
	});

	it('an UPDATE of the referenced key that orphans a child ABORTs', async () => {
		const db = new Database();
		try {
			await deployParentFkLens(db);
			await db.exec(`insert into x.parent (id, name) values (1, 'a')`);
			await db.exec('insert into x.child (id, pid) values (10, 1)');
			// Re-key the referenced parent 1→99 ⇒ child 10 dangles ⇒ ABORT (guard false ⇒ NOT EXISTS runs).
			await expectThrows(() => db.exec('update x.parent set id = 99 where id = 1'), /constraint|foreign|fk_/i);
			expect(await rows(db, 'select id from x.parent'), 'key change rolled back').to.deep.equal([{ id: 1 }]);
		} finally {
			await db.close();
		}
	});

	it('an UPDATE of a non-referenced parent column succeeds even while a child references it (the short-circuit guard)', async () => {
		const db = new Database();
		try {
			await deployParentFkLens(db);
			await db.exec(`insert into x.parent (id, name) values (1, 'a')`);
			await db.exec('insert into x.child (id, pid) values (10, 1)');
			// The referenced key (id) is unchanged ⇒ the `OLD.id = NEW.id` guard is true ⇒ the
			// NOT EXISTS is skipped ⇒ a benign rename of `name` is allowed (correctness, not perf:
			// a plain NOT EXISTS over OLD would wrongly reject this).
			await db.exec(`update x.parent set name = 'renamed' where id = 1`);
			expect(await rows(db, 'select name from x.parent where id = 1')).to.deep.equal([{ name: 'renamed' }]);
		} finally {
			await db.close();
		}
	});

	/**
	 * Deploys a lens whose logical FK references a **nullable** unique parent column
	 * (`parent.email`, not the PK). This is the narrow case the null-safe guard exists
	 * for: a value→NULL update of the referenced key *does* change it (orphaning a
	 * child) but plain `OLD.email = NEW.email` evaluates NULL, not false, so without the
	 * `is null and is null` arm the orphaning update would wrongly short-circuit-pass.
	 */
	async function deployNullableRefKeyLens(db: Database): Promise<void> {
		await db.exec('declare schema y { table parent (id integer primary key, email text null, unique (email)); table child (id integer primary key, pemail text null) }');
		await db.exec('apply schema y');
		await db.exec('declare logical schema x { table parent (id integer primary key, email text null, unique (email)); table child (id integer primary key, pemail text null, constraint fk_pe foreign key (pemail) references parent(email)) }');
		await db.exec('apply schema x');
	}

	it('value→NULL on a nullable referenced key while a child references the old value ABORTs (null-safe guard parity with physical RESTRICT)', async () => {
		const db = new Database();
		try {
			await deployNullableRefKeyLens(db);
			await db.exec(`insert into x.parent (id, email) values (1, 'a@x')`);
			await db.exec(`insert into x.child (id, pemail) values (10, 'a@x')`);
			// Nulling the referenced key changes it (orphaning child 10) ⇒ the `OLD.email =
			// NEW.email` arm is NULL and the `is null and is null` arm is false, so the guard
			// falls through to the NOT EXISTS, which finds the child ⇒ ABORT.
			await expectThrows(() => db.exec('update x.parent set email = null where id = 1'), /constraint|foreign|fk_/i);
			expect(await rows(db, 'select email from x.parent where id = 1'), 'orphaning update rolled back').to.deep.equal([{ email: 'a@x' }]);
		} finally {
			await db.close();
		}
	});

	it('NULL→NULL on a referenced row short-circuits true (benign no-op update succeeds)', async () => {
		const db = new Database();
		try {
			await deployNullableRefKeyLens(db);
			// A parent row whose referenced key is already NULL; a child referencing NULL is
			// allowed under MATCH SIMPLE (never enforced), but the parent-side guard must still
			// short-circuit a NULL→NULL no-op via the `is null and is null` arm.
			await db.exec(`insert into x.parent (id, email) values (2, null)`);
			await db.exec(`insert into x.child (id, pemail) values (20, null)`);
			await db.exec(`update x.parent set email = null where id = 2`);
			expect(await rows(db, 'select email from x.parent where id = 2')).to.deep.equal([{ email: null }]);
			// And a non-key column update on a value-keyed referenced row still short-circuits
			// (value→value unchanged) — the existing benign-update behavior is preserved.
			await db.exec(`insert into x.parent (id, email) values (3, 'b@x')`);
			await db.exec(`insert into x.child (id, pemail) values (30, 'b@x')`);
			await db.exec(`update x.parent set id = id where id = 3`); // referenced key unchanged
			expect(await rows(db, `select count(*) as n from x.parent where email = 'b@x'`)).to.deep.equal([{ n: 1 }]);
		} finally {
			await db.close();
		}
	});

	it('unit: the UPDATE guard is null-safe — `OLD.k = NEW.k or (OLD.k is null and NEW.k is null)`', async () => {
		const db = new Database();
		try {
			await deployNullableRefKeyLens(db);
			const upd = collectLensParentSideForeignKeyConstraints(slot(db, 'parent'), db.schemaManager, RowOpFlag.UPDATE);
			expect(upd.length).to.equal(1);
			const updSql = astToString(upd[0].expr).toLowerCase();
			expect(updSql, 'plain equality arm retained').to.match(/old\.email\s*=\s*new\.email/);
			expect(updSql, 'both-null arm added').to.match(/old\.email is null and new\.email is null/);
			// DELETE form gets no guard, so no NEW reference / both-null arm.
			const del = collectLensParentSideForeignKeyConstraints(slot(db, 'parent'), db.schemaManager, RowOpFlag.DELETE);
			expect(astToString(del[0].expr).toLowerCase(), 'no guard on DELETE').to.not.match(/new\.email/);
		} finally {
			await db.close();
		}
	});

	it('value→NULL on ONE component of a composite nullable referenced key ABORTs (per-column null-safe arm under the AND-reduction)', async () => {
		const db = new Database();
		try {
			// Composite nullable referenced key (ka, kb) — the null-safe equality is built
			// per-column and AND-reduced, so nulling a single component must collapse the
			// whole guard to false (that component's arm is false, the unchanged component's
			// arm is true, AND ⇒ false) and fall through to the NOT EXISTS ⇒ ABORT. Guards the
			// composite path the value→NULL single-column test exercises only for n=1.
			await db.exec('declare schema y { table parent (id integer primary key, ka integer null, kb integer null, unique (ka, kb)); table child (id integer primary key, ca integer null, cb integer null) }');
			await db.exec('apply schema y');
			await db.exec('declare logical schema x { table parent (id integer primary key, ka integer null, kb integer null, unique (ka, kb)); table child (id integer primary key, ca integer null, cb integer null, constraint fk_cab foreign key (ca, cb) references parent(ka, kb)) }');
			await db.exec('apply schema x');
			await db.exec('insert into x.parent (id, ka, kb) values (1, 10, 20)');
			await db.exec('insert into x.child (id, ca, cb) values (100, 10, 20)'); // references (10, 20)
			// Nulling only ka changes the key (10,20)→(null,20), orphaning child 100 ⇒ ABORT.
			await expectThrows(() => db.exec('update x.parent set ka = null where id = 1'), /constraint|foreign|fk_/i);
			expect(await rows(db, 'select ka, kb from x.parent where id = 1'), 'orphaning composite update rolled back').to.deep.equal([{ ka: 10, kb: 20 }]);
			// Re-asserting the same composite value (no change) still short-circuits true.
			await db.exec('update x.parent set ka = 10 where id = 1');
			expect(await rows(db, 'select count(*) as n from x.child where ca = 10 and cb = 20')).to.deep.equal([{ n: 1 }]);
		} finally {
			await db.close();
		}
	});

	it('a composite FK enforces the parent side — delete/update of the referenced composite key ABORTs; an unreferenced one succeeds', async () => {
		const db = new Database();
		try {
			await db.exec('declare schema y { table parent (px integer, py integer, name text, primary key (px, py)); table child (id integer primary key, a integer null, b integer null) }');
			await db.exec('apply schema y');
			await db.exec('declare logical schema x { table parent (px integer, py integer, name text, primary key (px, py)); table child (id integer primary key, a integer null, b integer null, constraint fk_ab foreign key (a, b) references parent(px, py)) }');
			await db.exec('apply schema x');
			await db.exec(`insert into x.parent (px, py, name) values (1, 2, 'a'), (3, 4, 'b')`);
			await db.exec('insert into x.child (id, a, b) values (10, 1, 2)'); // references (1,2)

			// Deleting the referenced composite key ⇒ ABORT.
			await expectThrows(() => db.exec('delete from x.parent where px = 1 and py = 2'), /constraint|foreign|fk_/i);
			// Re-keying the referenced composite key ⇒ ABORT.
			await expectThrows(() => db.exec('update x.parent set px = 9 where px = 1 and py = 2'), /constraint|foreign|fk_/i);
			// Deleting an unreferenced composite parent ⇒ succeeds.
			await db.exec('delete from x.parent where px = 3 and py = 4');
			expect(await rows(db, 'select count(*) as n from x.parent where px = 3')).to.deep.equal([{ n: 0 }]);
		} finally {
			await db.close();
		}
	});

	it('a rename override on the parent rewrites OLD to basis terms and still enforces', async () => {
		const db = new Database();
		try {
			// Logical parent column `id` ← basis `parent_id`; the OLD.<basis> rewrite must
			// resolve against the parent's basis write row.
			await db.exec('declare schema y { table parent (parent_id integer primary key, name text); table child (id integer primary key, pid integer null) }');
			await db.exec('apply schema y');
			await db.exec('declare logical schema x { table parent (id integer primary key, name text); table child (id integer primary key, pid integer null, constraint fk_pid foreign key (pid) references parent(id)) }');
			await db.exec('declare lens for x over y { view parent as select parent_id as id, name from y.parent }');
			await db.exec('apply schema x');
			await db.exec(`insert into x.parent (id, name) values (1, 'a')`);
			await db.exec('insert into x.child (id, pid) values (10, 1)');

			await expectThrows(() => db.exec('delete from x.parent where id = 1'), /constraint|foreign|fk_/i);
			expect(await rows(db, 'select count(*) as n from x.parent where id = 1')).to.deep.equal([{ n: 1 }]);

			// The synthesized constraint correlates on the BASIS parent column.
			const routed = collectLensParentSideForeignKeyConstraints(slot(db, 'parent'), db.schemaManager, RowOpFlag.DELETE);
			expect(routed.length, 'one routed parent-side check').to.equal(1);
			const exprSql = astToString(routed[0].expr);
			expect(exprSql, 'OLD side uses the basis parent column `parent_id`').to.match(/parent_id/i);
		} finally {
			await db.close();
		}
	});

	it('the foreign_keys pragma gates the parent side — off ⇒ deleting a referenced parent is accepted', async () => {
		const db = new Database();
		try {
			await deployParentFkLens(db);
			await db.exec(`insert into x.parent (id, name) values (1, 'a')`);
			await db.exec('insert into x.child (id, pid) values (10, 1)');
			await db.exec('pragma foreign_keys = false');
			// No synthesized parent-side check ⇒ the referenced parent deletes (orphaning the
			// child), matching the physical parent-side FK gate.
			await db.exec('delete from x.parent where id = 1');
			expect(await rows(db, 'select count(*) as n from x.parent where id = 1')).to.deep.equal([{ n: 0 }]);
		} finally {
			await db.close();
		}
	});

	it('a multi-source parent is a documented no-op — the collector emits nothing and a delete/update does not throw a planner error', async () => {
		const db = new Database();
		try {
			// `parent` maps to a two-table inner join (basis FK pb→pa makes the join delete
			// unambiguous). Its OLD.* is not one basis row, so the parent-side collector emits
			// nothing — the documented single-source-spine boundary.
			await db.exec('declare schema y { table pa (id integer primary key, a text); table pb (id integer primary key references pa(id), b text); table child (id integer primary key, pid integer null) }');
			await db.exec('apply schema y');
			await db.exec('declare logical schema x { table parent (id integer primary key, a text, b text); table child (id integer primary key, pid integer null, constraint fk_pid foreign key (pid) references parent(id)) }');
			await db.exec('declare lens for x over y { view parent as select pa.id, pa.a, pb.b from y.pa join y.pb on pa.id = pb.id }');
			await db.exec('apply schema x');

			// The cross-slot collector finds the child FK referencing `parent`, but the
			// multi-source parent has no single basis spine ⇒ [] for both ops.
			expect(collectLensParentSideForeignKeyConstraints(slot(db, 'parent'), db.schemaManager, RowOpFlag.DELETE), 'multi-source parent ⇒ no DELETE constraint').to.deep.equal([]);
			expect(collectLensParentSideForeignKeyConstraints(slot(db, 'parent'), db.schemaManager, RowOpFlag.UPDATE), 'multi-source parent ⇒ no UPDATE constraint').to.deep.equal([]);

			// Seed the basis directly, reference it from a child, and assert delete/update
			// through the multi-source parent does not throw a planner error.
			await db.exec(`insert into y.pa (id, a) values (1, 'a1'), (2, 'a2')`);
			await db.exec(`insert into y.pb (id, b) values (1, 'b1'), (2, 'b2')`);
			await db.exec('insert into x.child (id, pid) values (10, 1)');
			await db.exec(`update x.parent set a = 'A1' where id = 1`); // does not throw
			await db.exec('delete from x.parent where id = 2'); // does not throw
		} finally {
			await db.close();
		}
	});

	it('unit: the collector returns one boundary-tagged NOT EXISTS over the qualified logical child (DELETE vs UPDATE forms)', async () => {
		const db = new Database();
		try {
			await deployParentFkLens(db);

			// DELETE form: a plain NOT EXISTS over the schema-qualified logical child,
			// OLD-correlated on the basis parent column, masked to DELETE.
			const del = collectLensParentSideForeignKeyConstraints(slot(db, 'parent'), db.schemaManager, RowOpFlag.DELETE);
			expect(del.length).to.equal(1);
			expect(del[0].tags?.[LENS_BOUNDARY_ATTACHED_TAG], 'boundary marker present').to.equal(true);
			expect(del[0].operations, 'DELETE mask').to.equal(RowOpFlag.DELETE);
			expect(del[0].name).to.equal('lens:fk:parent:fk_pid');
			const delSql = astToString(del[0].expr);
			expect(delSql, 'a NOT EXISTS non-existence check').to.match(/not exists/i);
			expect(delSql, 'over the qualified logical child').to.match(/child/i);
			expect(delSql, 'OLD-correlated on the basis parent column').to.match(/old\b/i);
			expect(delSql, 'no UPDATE short-circuit guard on DELETE').to.not.match(/new\b/i);

			// UPDATE form: same NOT EXISTS wrapped in the `(OLD.p = NEW.p …) or …` short-circuit, masked to UPDATE.
			const upd = collectLensParentSideForeignKeyConstraints(slot(db, 'parent'), db.schemaManager, RowOpFlag.UPDATE);
			expect(upd.length).to.equal(1);
			expect(upd[0].operations, 'UPDATE mask').to.equal(RowOpFlag.UPDATE);
			const updSql = astToString(upd[0].expr);
			expect(updSql, 'NOT EXISTS retained').to.match(/not exists/i);
			expect(updSql, 'OLD = NEW short-circuit guard').to.match(/old\.\w+\s*=\s*new\.\w+/i);
			expect(updSql, 'disjoined with `or`').to.match(/\bor\b/i);
		} finally {
			await db.close();
		}
	});

	it('a non-referenced parent returns [] for both ops', async () => {
		const db = new Database();
		try {
			await db.exec('declare schema y { table solo (id integer primary key, v integer) }');
			await db.exec('apply schema y');
			await db.exec('declare logical schema x { table solo (id integer primary key, v integer) }');
			await db.exec('apply schema x');
			expect(collectLensParentSideForeignKeyConstraints(slot(db, 'solo'), db.schemaManager, RowOpFlag.DELETE)).to.deep.equal([]);
			expect(collectLensParentSideForeignKeyConstraints(slot(db, 'solo'), db.schemaManager, RowOpFlag.UPDATE)).to.deep.equal([]);
		} finally {
			await db.close();
		}
	});

	it('composes with the child side — both directions enforce on the same schema', async () => {
		const db = new Database();
		try {
			await deployParentFkLens(db);
			await db.exec(`insert into x.parent (id, name) values (1, 'a')`);
			// Child side: a dangling insert ABORTs.
			await expectThrows(() => db.exec('insert into x.child (id, pid) values (10, 99)'), /constraint|foreign|fk_/i);
			// A satisfying child lands.
			await db.exec('insert into x.child (id, pid) values (11, 1)');
			// Parent side: deleting the now-referenced parent ABORTs.
			await expectThrows(() => db.exec('delete from x.parent where id = 1'), /constraint|foreign|fk_/i);
			expect(await rows(db, 'select count(*) as n from x.parent where id = 1')).to.deep.equal([{ n: 1 }]);
		} finally {
			await db.close();
		}
	});
});

describe('lens enforcement: parent-side FK basis-redundancy elision', () => {
	/**
	 * The inverse of `deployParentFkLens`: the **basis** child *does* carry the FK
	 * (so the re-planned basis parent write's own `buildParentSideFKChecks` fires),
	 * and the **logical** child re-declares it. When the basis FK is RESTRICT and the
	 * lenses are faithful single-source projections, the lens-level parent-side check
	 * is provably subsumed by the basis parent-side check ⇒ elided. `basisFkTail`
	 * tunes the basis FK's referential actions to exercise the action-match gate.
	 */
	async function deployParentFkBasisEquivLens(
		db: Database,
		opts?: { basisFkTail?: string; childOverride?: string },
	): Promise<void> {
		const tail = opts?.basisFkTail ?? 'on delete restrict on update restrict';
		await db.exec(`declare schema y { table parent (id integer primary key, name text); table child (id integer primary key, pid integer null, constraint fk foreign key (pid) references parent(id) ${tail}) }`);
		await db.exec('apply schema y');
		// The logical FK is bare ⇒ RESTRICT for both ops (the lens RESTRICT under test).
		await db.exec('declare logical schema x { table parent (id integer primary key, name text); table child (id integer primary key, pid integer null, constraint fk_pid foreign key (pid) references parent(id)) }');
		if (opts?.childOverride) await db.exec(opts.childOverride);
		await db.exec('apply schema x');
	}

	it('elides both ops when the basis carries the equivalent restrict FK over faithful default lenses (no correctness change)', async () => {
		const db = new Database();
		try {
			await deployParentFkBasisEquivLens(db);
			expect(collectLensParentSideForeignKeyConstraints(slot(db, 'parent'), db.schemaManager, RowOpFlag.DELETE), 'DELETE elided').to.deep.equal([]);
			expect(collectLensParentSideForeignKeyConstraints(slot(db, 'parent'), db.schemaManager, RowOpFlag.UPDATE), 'UPDATE elided').to.deep.equal([]);

			// No correctness change: deleting a referenced parent still ABORTs — now via the
			// basis parent-side RESTRICT the re-planned basis write enforces — and the child
			// survives; an unreferenced parent deletes.
			await db.exec(`insert into x.parent (id, name) values (1, 'a'), (2, 'b')`);
			await db.exec('insert into x.child (id, pid) values (10, 1)');
			await expectThrows(() => db.exec('delete from x.parent where id = 1'), /constraint|foreign|fk/i);
			expect(await rows(db, 'select count(*) as n from x.parent where id = 1'), 'referenced parent survives').to.deep.equal([{ n: 1 }]);
			expect(await rows(db, 'select count(*) as n from x.child where id = 10'), 'child not orphaned').to.deep.equal([{ n: 1 }]);
			await db.exec('delete from x.parent where id = 2');
			expect(await rows(db, 'select count(*) as n from x.parent where id = 2')).to.deep.equal([{ n: 0 }]);
		} finally {
			await db.close();
		}
	});

	it('does NOT elide when the basis FK is CASCADE — the lens RESTRICT is retained (the headline caveat)', async () => {
		const db = new Database();
		try {
			// A CASCADE basis FK would cascade-delete / null the children rather than reject,
			// so `buildParentSideFKChecks` synthesizes no parent-side check for it — eliding
			// the lens RESTRICT would silently drop enforcement. The collector must keep it.
			// (The runtime interleaving of a basis cascade vs. the retained lens check is
			// pre-existing behavior unchanged by this ticket; the load-bearing assertion is
			// that the collector decision is "retain".)
			await deployParentFkBasisEquivLens(db, { basisFkTail: 'on delete cascade on update cascade' });
			expect(collectLensParentSideForeignKeyConstraints(slot(db, 'parent'), db.schemaManager, RowOpFlag.DELETE).length, 'DELETE retained (basis cascade ≠ restrict)').to.equal(1);
			expect(collectLensParentSideForeignKeyConstraints(slot(db, 'parent'), db.schemaManager, RowOpFlag.UPDATE).length, 'UPDATE retained (basis cascade ≠ restrict)').to.equal(1);
		} finally {
			await db.close();
		}
	});

	it('reads the op-appropriate basis action — basis delete-restrict/update-cascade elides DELETE but retains UPDATE', async () => {
		const db = new Database();
		try {
			await deployParentFkBasisEquivLens(db, { basisFkTail: 'on delete restrict on update cascade' });
			expect(collectLensParentSideForeignKeyConstraints(slot(db, 'parent'), db.schemaManager, RowOpFlag.DELETE), 'DELETE elided (basis on delete restrict)').to.deep.equal([]);
			expect(collectLensParentSideForeignKeyConstraints(slot(db, 'parent'), db.schemaManager, RowOpFlag.UPDATE).length, 'UPDATE retained (basis on update cascade)').to.equal(1);
		} finally {
			await db.close();
		}
	});

	it('does NOT elide when the basis FK is SET NULL — only restrict subsumes a lens RESTRICT', async () => {
		const db = new Database();
		try {
			await deployParentFkBasisEquivLens(db, { basisFkTail: 'on delete set null on update set null' });
			expect(collectLensParentSideForeignKeyConstraints(slot(db, 'parent'), db.schemaManager, RowOpFlag.DELETE).length, 'DELETE retained (basis set null ≠ restrict)').to.equal(1);
			expect(collectLensParentSideForeignKeyConstraints(slot(db, 'parent'), db.schemaManager, RowOpFlag.UPDATE).length, 'UPDATE retained (basis set null ≠ restrict)').to.equal(1);
		} finally {
			await db.close();
		}
	});

	it('does not over-elide — no basis FK ⇒ the lens parent-side check is retained', async () => {
		const db = new Database();
		try {
			// The `deployParentFkLens` shape: the basis carries NO FK, so the basis parent
			// write enforces nothing and the lens-level check must be retained.
			await db.exec('declare schema y { table parent (id integer primary key, name text); table child (id integer primary key, pid integer null) }');
			await db.exec('apply schema y');
			await db.exec('declare logical schema x { table parent (id integer primary key, name text); table child (id integer primary key, pid integer null, constraint fk_pid foreign key (pid) references parent(id)) }');
			await db.exec('apply schema x');
			expect(collectLensParentSideForeignKeyConstraints(slot(db, 'parent'), db.schemaManager, RowOpFlag.DELETE).length, 'no basis FK ⇒ retained').to.equal(1);
			expect(collectLensParentSideForeignKeyConstraints(slot(db, 'parent'), db.schemaManager, RowOpFlag.UPDATE).length, 'no basis FK ⇒ retained').to.equal(1);
		} finally {
			await db.close();
		}
	});

	it('does NOT elide a permuted basis composite FK (pair-set mismatch)', async () => {
		const db = new Database();
		try {
			// Basis FK pairs (a→py, b→px); the logical FK pairs (a→px, b→py). The pair-sets
			// differ ⇒ the basis FK is NOT equivalent ⇒ the lens RESTRICT is retained.
			await db.exec('declare schema y { table parent (px integer, py integer, name text, primary key (px, py)); table child (id integer primary key, a integer null, b integer null, constraint fk_perm foreign key (a, b) references parent(py, px) on delete restrict on update restrict) }');
			await db.exec('apply schema y');
			await db.exec('declare logical schema x { table parent (px integer, py integer, name text, primary key (px, py)); table child (id integer primary key, a integer null, b integer null, constraint fk_ab foreign key (a, b) references parent(px, py)) }');
			await db.exec('apply schema x');
			expect(collectLensParentSideForeignKeyConstraints(slot(db, 'parent'), db.schemaManager, RowOpFlag.DELETE).length, 'permuted basis FK ⇒ retained').to.equal(1);
		} finally {
			await db.close();
		}
	});

	it('does NOT elide when the logical child body is row-reducing (conservative parity gate)', async () => {
		const db = new Database();
		try {
			// The child lens body filters rows (`where id > 0`); the basis carries the
			// equivalent restrict FK. Condition (3) (non-row-reducing CHILD projection) fails,
			// so the collector double-enforces — mirroring the child-side detector exactly.
			await deployParentFkBasisEquivLens(db, {
				childOverride: 'declare lens for x over y { view child as select id, pid from y.child where id > 0 }',
			});
			expect(collectLensParentSideForeignKeyConstraints(slot(db, 'parent'), db.schemaManager, RowOpFlag.DELETE).length, 'row-reducing child ⇒ retained').to.equal(1);
		} finally {
			await db.close();
		}
	});

	it('elides under a child rename override when the basis FK is over the basis column', async () => {
		const db = new Database();
		try {
			// Child maps logical `pid` ← basis `basis_pid`; the basis restrict FK is on
			// `basis_pid`. The mapped pair-set equals the basis FK's ⇒ elide. The parent is
			// the faithful default projection.
			await db.exec('declare schema y { table parent (id integer primary key, name text); table child (id integer primary key, basis_pid integer null, constraint fk foreign key (basis_pid) references parent(id) on delete restrict on update restrict) }');
			await db.exec('apply schema y');
			await db.exec('declare logical schema x { table parent (id integer primary key, name text); table child (id integer primary key, pid integer null, constraint fk_pid foreign key (pid) references parent(id)) }');
			await db.exec('declare lens for x over y { view child as select id, basis_pid as pid from y.child }');
			await db.exec('apply schema x');
			expect(collectLensParentSideForeignKeyConstraints(slot(db, 'parent'), db.schemaManager, RowOpFlag.DELETE), 'rename-over-basis-FK elides DELETE').to.deep.equal([]);
			expect(collectLensParentSideForeignKeyConstraints(slot(db, 'parent'), db.schemaManager, RowOpFlag.UPDATE), 'rename-over-basis-FK elides UPDATE').to.deep.equal([]);

			// Still enforces via the basis FK: deleting a referenced parent ABORTs.
			await db.exec(`insert into x.parent (id, name) values (1, 'a')`);
			await db.exec('insert into x.child (id, pid) values (10, 1)');
			await expectThrows(() => db.exec('delete from x.parent where id = 1'), /constraint|foreign|fk/i);
			expect(await rows(db, 'select count(*) as n from x.parent where id = 1')).to.deep.equal([{ n: 1 }]);
		} finally {
			await db.close();
		}
	});

	it('elides under a PARENT rename override when the basis FK references the renamed basis parent column', async () => {
		const db = new Database();
		try {
			// Parent maps logical `id` ← basis `basis_id`; the basis restrict FK references
			// `basis_id`. The redundancy detector maps the parent referenced column
			// logical→basis through the parent slot's projection, so the mapped pair-set
			// equals the basis FK's ⇒ elide. (The child-rename case tests the child half of
			// `mappedFkBasisPairs`; this exercises the parent half under a non-identity
			// projection — the path every identity-projection case leaves untested.)
			await db.exec('declare schema y { table parent (basis_id integer primary key, name text); table child (id integer primary key, pid integer null, constraint fk foreign key (pid) references parent(basis_id) on delete restrict on update restrict) }');
			await db.exec('apply schema y');
			await db.exec('declare logical schema x { table parent (id integer primary key, name text); table child (id integer primary key, pid integer null, constraint fk_pid foreign key (pid) references parent(id)) }');
			await db.exec('declare lens for x over y { view parent as select basis_id as id, name from y.parent }');
			await db.exec('apply schema x');
			expect(collectLensParentSideForeignKeyConstraints(slot(db, 'parent'), db.schemaManager, RowOpFlag.DELETE), 'parent-rename elides DELETE').to.deep.equal([]);
			expect(collectLensParentSideForeignKeyConstraints(slot(db, 'parent'), db.schemaManager, RowOpFlag.UPDATE), 'parent-rename elides UPDATE').to.deep.equal([]);

			// Still enforces via the basis FK: deleting a referenced parent ABORTs.
			await db.exec(`insert into x.parent (id, name) values (1, 'a')`);
			await db.exec('insert into x.child (id, pid) values (10, 1)');
			await expectThrows(() => db.exec('delete from x.parent where id = 1'), /constraint|foreign|fk/i);
			expect(await rows(db, 'select count(*) as n from x.parent where id = 1')).to.deep.equal([{ n: 1 }]);
		} finally {
			await db.close();
		}
	});

	it('elides a composite FK when the basis carries the equivalent composite restrict FK (DELETE + UPDATE)', async () => {
		const db = new Database();
		try {
			await db.exec('declare schema y { table parent (px integer, py integer, name text, primary key (px, py)); table child (id integer primary key, a integer null, b integer null, constraint fk_ab foreign key (a, b) references parent(px, py) on delete restrict on update restrict) }');
			await db.exec('apply schema y');
			await db.exec('declare logical schema x { table parent (px integer, py integer, name text, primary key (px, py)); table child (id integer primary key, a integer null, b integer null, constraint fk_ab foreign key (a, b) references parent(px, py)) }');
			await db.exec('apply schema x');
			expect(collectLensParentSideForeignKeyConstraints(slot(db, 'parent'), db.schemaManager, RowOpFlag.DELETE), 'composite restrict elides DELETE').to.deep.equal([]);
			expect(collectLensParentSideForeignKeyConstraints(slot(db, 'parent'), db.schemaManager, RowOpFlag.UPDATE), 'composite restrict elides UPDATE').to.deep.equal([]);

			// Deleting / re-keying a referenced composite key still ABORTs via the basis FK.
			await db.exec(`insert into x.parent (px, py, name) values (1, 2, 'a')`);
			await db.exec('insert into x.child (id, a, b) values (10, 1, 2)');
			await expectThrows(() => db.exec('delete from x.parent where px = 1 and py = 2'), /constraint|foreign|fk/i);
			await expectThrows(() => db.exec('update x.parent set px = 9 where px = 1 and py = 2'), /constraint|foreign|fk/i);
			expect(await rows(db, 'select count(*) as n from x.parent where px = 1 and py = 2')).to.deep.equal([{ n: 1 }]);
		} finally {
			await db.close();
		}
	});
});

describe('lens enforcement: parent-side FK CASCADE / SET NULL / SET DEFAULT actions', () => {
	/**
	 * Deploys the canonical cascade shape: the basis carries **no** FK, so the
	 * referential action lives only on the *logical* FK. A delete/update of the
	 * lens-backed logical parent must propagate the action to the referencing logical
	 * child via the runtime cascade walker (`executeLensForeignKeyActions`, the logical
	 * dual of `executeForeignKeyActions`) — issued against the logical child *view*, so
	 * each cascade re-enters the lens write path. `foreign_keys` defaults on. `fkTail`
	 * tunes the logical FK's referential actions; `childPid` tunes the child FK column
	 * declaration (e.g. a default for SET DEFAULT); `childExtra` adds a further logical
	 * child constraint.
	 */
	async function deployCascadeLens(
		db: Database,
		opts?: { fkTail?: string; childPid?: string; childExtra?: string },
	): Promise<void> {
		const fkTail = opts?.fkTail ?? 'on delete cascade on update cascade';
		const childPid = opts?.childPid ?? 'pid integer null';
		const childExtra = opts?.childExtra ? `, ${opts.childExtra}` : '';
		await db.exec('declare schema y { table parent (id integer primary key, name text); table child (id integer primary key, pid integer null) }');
		await db.exec('apply schema y');
		await db.exec(`declare logical schema x { table parent (id integer primary key, name text); table child (id integer primary key, ${childPid}, constraint fk_pid foreign key (pid) references parent(id) ${fkTail}${childExtra}) }`);
		await db.exec('apply schema x');
	}

	/** The single logical FK constraint on a child slot (for the unit-style predicate calls). */
	function childFk(s: LensSlot) {
		return s.obligations!.flatMap(o =>
			o.kind === 'enforced-fk' && o.constraint.kind === 'foreignKey' ? [o.constraint.constraint] : [])[0];
	}

	it('CASCADE DELETE — deleting a referenced logical parent deletes the referencing children (basis has no FK)', async () => {
		const db = new Database();
		try {
			await deployCascadeLens(db, { fkTail: 'on delete cascade' });
			await db.exec(`insert into x.parent (id, name) values (1, 'a'), (2, 'b')`);
			await db.exec('insert into x.child (id, pid) values (10, 1), (11, 1)');
			// Deleting parent 1 cascades — both referencing children gone.
			await db.exec('delete from x.parent where id = 1');
			expect(await rows(db, 'select count(*) as n from x.child'), 'children cascade-deleted').to.deep.equal([{ n: 0 }]);
			expect(await rows(db, 'select count(*) as n from x.parent where id = 1'), 'parent gone').to.deep.equal([{ n: 0 }]);
			// The basis reflects the cascade too (the lens cascade re-plans to the basis child write).
			expect(await rows(db, 'select count(*) as n from y.child')).to.deep.equal([{ n: 0 }]);
			// An unreferenced parent is untouched.
			expect(await rows(db, 'select count(*) as n from x.parent where id = 2')).to.deep.equal([{ n: 1 }]);
		} finally {
			await db.close();
		}
	});

	it('CASCADE UPDATE — re-keying a referenced logical parent rewrites the child FK column (child row preserved)', async () => {
		const db = new Database();
		try {
			await deployCascadeLens(db, { fkTail: 'on update cascade' });
			await db.exec(`insert into x.parent (id, name) values (1, 'a')`);
			await db.exec('insert into x.child (id, pid) values (10, 1)');
			// Re-key parent 1 → 9 cascades the child's pid 1 → 9; the child row survives.
			await db.exec('update x.parent set id = 9 where id = 1');
			expect(await rows(db, 'select id, pid from x.child where id = 10'), 'child FK rewritten').to.deep.equal([{ id: 10, pid: 9 }]);
			expect(await rows(db, 'select id from x.parent'), 'parent re-keyed').to.deep.equal([{ id: 9 }]);
		} finally {
			await db.close();
		}
	});

	it('SET NULL — on delete set null nulls the child FK column (child row preserved)', async () => {
		const db = new Database();
		try {
			await deployCascadeLens(db, { fkTail: 'on delete set null' });
			await db.exec(`insert into x.parent (id, name) values (1, 'a')`);
			await db.exec('insert into x.child (id, pid) values (10, 1)');
			await db.exec('delete from x.parent where id = 1');
			expect(await rows(db, 'select id, pid from x.child where id = 10'), 'child FK nulled, row kept').to.deep.equal([{ id: 10, pid: null }]);
		} finally {
			await db.close();
		}
	});

	it('SET NULL (update analogue) — on update set null nulls the child FK column when the parent key changes', async () => {
		const db = new Database();
		try {
			await deployCascadeLens(db, { fkTail: 'on update set null' });
			await db.exec(`insert into x.parent (id, name) values (1, 'a')`);
			await db.exec('insert into x.child (id, pid) values (10, 1)');
			await db.exec('update x.parent set id = 9 where id = 1');
			expect(await rows(db, 'select id, pid from x.child where id = 10'), 'child FK nulled on parent re-key').to.deep.equal([{ id: 10, pid: null }]);
		} finally {
			await db.close();
		}
	});

	it('SET DEFAULT — on delete set default sets the child FK column to the logical default (which references a valid parent)', async () => {
		const db = new Database();
		try {
			// The child FK column declares `default 0`; seed a parent id=0 so the
			// re-defaulted child still satisfies its (deferred) child-side FK at commit.
			await deployCascadeLens(db, { fkTail: 'on delete set default', childPid: 'pid integer default 0' });
			await db.exec(`insert into x.parent (id, name) values (0, 'def'), (1, 'a')`);
			await db.exec('insert into x.child (id, pid) values (10, 1)');
			await db.exec('delete from x.parent where id = 1');
			expect(await rows(db, 'select id, pid from x.child where id = 10'), 'child FK set to default 0').to.deep.equal([{ id: 10, pid: 0 }]);
			expect(await rows(db, 'select count(*) as n from x.parent where id = 0'), 'default parent intact').to.deep.equal([{ n: 1 }]);
		} finally {
			await db.close();
		}
	});

	it('MATCH SIMPLE — a NULL parent referenced value cascades nothing (no children match)', async () => {
		const db = new Database();
		try {
			// A composite FK so the parent referenced key can carry a NULL component.
			await db.exec('declare schema y { table parent (px integer, py integer null, name text, primary key (px)); table child (id integer primary key, a integer null, b integer null) }');
			await db.exec('apply schema y');
			await db.exec('declare logical schema x { table parent (px integer, py integer null, name text, primary key (px)); table child (id integer primary key, a integer null, b integer null, constraint fk_ab foreign key (a, b) references parent(px, py) on delete cascade) }');
			await db.exec('apply schema x');
			// Parent (1, NULL): its referenced tuple has a NULL component, so MATCH SIMPLE
			// means no child can reference it — deleting it cascades nothing, and a child
			// carrying (1, NULL) is NOT deleted.
			await db.exec(`insert into x.parent (px, py, name) values (1, null, 'a')`);
			await db.exec('insert into x.child (id, a, b) values (10, 1, null)');
			await db.exec('delete from x.parent where px = 1');
			expect(await rows(db, 'select count(*) as n from x.child where id = 10'), 'NULL-keyed parent cascades nothing').to.deep.equal([{ n: 1 }]);
		} finally {
			await db.close();
		}
	});

	it('UPDATE short-circuit — updating a non-referenced parent column cascades nothing (child untouched)', async () => {
		const db = new Database();
		try {
			await deployCascadeLens(db, { fkTail: 'on update cascade' });
			await db.exec(`insert into x.parent (id, name) values (1, 'a')`);
			await db.exec('insert into x.child (id, pid) values (10, 1)');
			// Only `name` changes — the referenced key `id` is unchanged ⇒ no cascade.
			await db.exec(`update x.parent set name = 'renamed' where id = 1`);
			expect(await rows(db, 'select id, pid from x.child where id = 10'), 'child untouched').to.deep.equal([{ id: 10, pid: 1 }]);
			expect(await rows(db, 'select name from x.parent where id = 1')).to.deep.equal([{ name: 'renamed' }]);
		} finally {
			await db.close();
		}
	});

	it('transitive — parent → child → grandchild all cascade-delete', async () => {
		const db = new Database();
		try {
			await db.exec('declare schema y { table parent (id integer primary key); table child (id integer primary key, pid integer null); table grandchild (id integer primary key, cid integer null) }');
			await db.exec('apply schema y');
			await db.exec('declare logical schema x { table parent (id integer primary key); table child (id integer primary key, pid integer null, constraint fk_c foreign key (pid) references parent(id) on delete cascade); table grandchild (id integer primary key, cid integer null, constraint fk_g foreign key (cid) references child(id) on delete cascade) }');
			await db.exec('apply schema x');
			await db.exec('insert into x.parent (id) values (1)');
			await db.exec('insert into x.child (id, pid) values (10, 1)');
			await db.exec('insert into x.grandchild (id, cid) values (100, 10)');
			// Deleting the root cascades all the way down: each cascade re-enters the lens
			// write path, whose own FK cascade fires the next level.
			await db.exec('delete from x.parent where id = 1');
			expect(await rows(db, 'select count(*) as n from x.parent')).to.deep.equal([{ n: 0 }]);
			expect(await rows(db, 'select count(*) as n from x.child')).to.deep.equal([{ n: 0 }]);
			expect(await rows(db, 'select count(*) as n from x.grandchild'), 'grandchild cascade-deleted transitively').to.deep.equal([{ n: 0 }]);
		} finally {
			await db.close();
		}
	});

	it('re-enters the lens write path — a cascade-update that violates the logical child row-local check ABORTs', async () => {
		const db = new Database();
		try {
			// The logical child carries a row-local check the basis does NOT — proving the
			// cascade-update rides the lens write path, not a basis-direct write.
			await deployCascadeLens(db, { fkTail: 'on update cascade', childExtra: 'constraint nonneg check (pid >= 0)' });
			await db.exec(`insert into x.parent (id, name) values (1, 'a')`);
			await db.exec('insert into x.child (id, pid) values (10, 1)');
			// Re-key parent 1 → -5 ⇒ cascade-update child pid → -5 ⇒ violates `pid >= 0` ⇒ ABORT.
			await expectThrows(() => db.exec('update x.parent set id = -5 where id = 1'), /nonneg|constraint|check/i);
			// The whole statement rolled back: parent key and child FK both unchanged.
			expect(await rows(db, 'select id from x.parent'), 'parent re-key rolled back').to.deep.equal([{ id: 1 }]);
			expect(await rows(db, 'select pid from x.child where id = 10'), 'child unchanged').to.deep.equal([{ pid: 1 }]);
		} finally {
			await db.close();
		}
	});

	it('elision / no double-cascade — basis also carries the equivalent CASCADE FK ⇒ children removed exactly once, end state correct', async () => {
		const db = new Database();
		try {
			// Basis declares the SAME cascade FK; the physical walker propagates over the
			// basis and the lens cascade is elided (the basis governs).
			await db.exec('declare schema y { table parent (id integer primary key, name text); table child (id integer primary key, pid integer null, constraint fk foreign key (pid) references parent(id) on delete cascade) }');
			await db.exec('apply schema y');
			await db.exec('declare logical schema x { table parent (id integer primary key, name text); table child (id integer primary key, pid integer null, constraint fk_pid foreign key (pid) references parent(id) on delete cascade) }');
			await db.exec('apply schema x');

			// The lens cascade is elided exactly because the basis child carries the equivalent FK.
			expect(basisChildCarriesEquivalentFk(
				slot(db, 'child'),
				childFk(slot(db, 'child')),
				slot(db, 'parent'),
				['id'],
				resolveSlotBasisSource(slot(db, 'parent'), db.schemaManager)!,
				db.schemaManager,
			), 'basis carries equivalent FK ⇒ lens cascade elided').to.be.true;

			await db.exec(`insert into x.parent (id, name) values (1, 'a')`);
			await db.exec('insert into x.child (id, pid) values (10, 1), (11, 1)');
			// Deleting the parent removes the children exactly once (no error, exact count).
			await db.exec('delete from x.parent where id = 1');
			expect(await rows(db, 'select count(*) as n from x.child'), 'children removed once').to.deep.equal([{ n: 0 }]);
			expect(await rows(db, 'select count(*) as n from x.parent where id = 1')).to.deep.equal([{ n: 0 }]);
		} finally {
			await db.close();
		}
	});

	it('pragma gate — foreign_keys = false ⇒ no lens cascade (child orphaned, not deleted)', async () => {
		const db = new Database();
		try {
			await deployCascadeLens(db, { fkTail: 'on delete cascade' });
			await db.exec(`insert into x.parent (id, name) values (1, 'a')`);
			await db.exec('insert into x.child (id, pid) values (10, 1)');
			await db.exec('pragma foreign_keys = false');
			// No cascade fires — the parent deletes and the child is left orphaned.
			await db.exec('delete from x.parent where id = 1');
			expect(await rows(db, 'select id, pid from x.child where id = 10'), 'child survives (no cascade)').to.deep.equal([{ id: 10, pid: 1 }]);
		} finally {
			await db.close();
		}
	});

	it('multi-source parent — a delete/update of a multi-source logical parent fires no lens cascade and does not throw', async () => {
		const db = new Database();
		try {
			await db.exec('declare schema y { table pa (id integer primary key, a text); table pb (id integer primary key references pa(id), b text); table child (id integer primary key, pid integer null) }');
			await db.exec('apply schema y');
			await db.exec('declare logical schema x { table parent (id integer primary key, a text, b text); table child (id integer primary key, pid integer null, constraint fk_pid foreign key (pid) references parent(id) on delete cascade on update cascade) }');
			await db.exec('declare lens for x over y { view parent as select pa.id, pa.a, pb.b from y.pa join y.pb on pa.id = pb.id }');
			await db.exec('apply schema x');

			await db.exec(`insert into y.pa (id, a) values (1, 'a1'), (2, 'a2')`);
			await db.exec(`insert into y.pb (id, b) values (1, 'b1'), (2, 'b2')`);
			await db.exec('insert into x.child (id, pid) values (10, 1)');
			// The multi-source parent has no single basis spine ⇒ the cascade walker's
			// reverse-map finds no matching slot ⇒ no cascade, no planner error.
			await db.exec(`update x.parent set a = 'A1' where id = 1`); // does not throw
			await db.exec('delete from x.parent where id = 2'); // does not throw
			// The child of the still-present parent 1 is NOT cascaded (documented no-op).
			expect(await rows(db, 'select count(*) as n from x.child where id = 10')).to.deep.equal([{ n: 1 }]);
		} finally {
			await db.close();
		}
	});

	it('composite CASCADE DELETE — a multi-column logical FK cascades over the multi-column WHERE (all components non-null)', async () => {
		const db = new Database();
		try {
			// Composite FK (a, b) -> parent(px, py), every referenced value non-null so the
			// cascade fires the multi-column WHERE built by the .map(...).join(...) path.
			await db.exec('declare schema y { table parent (px integer, py integer, name text, primary key (px, py)); table child (id integer primary key, a integer null, b integer null) }');
			await db.exec('apply schema y');
			await db.exec('declare logical schema x { table parent (px integer, py integer, name text, primary key (px, py)); table child (id integer primary key, a integer null, b integer null, constraint fk_ab foreign key (a, b) references parent(px, py) on delete cascade on update cascade) }');
			await db.exec('apply schema x');
			await db.exec(`insert into x.parent (px, py, name) values (1, 2, 'p'), (3, 4, 'q')`);
			await db.exec('insert into x.child (id, a, b) values (10, 1, 2), (11, 1, 2), (12, 3, 4)');
			await db.exec('delete from x.parent where px = 1 and py = 2');
			// Only the children matching the full composite key (1,2) are cascade-deleted.
			expect(await rows(db, 'select id from x.child order by id'), 'only (1,2) children removed').to.deep.equal([{ id: 12 }]);
		} finally {
			await db.close();
		}
	});

	it('composite CASCADE UPDATE — re-keying a composite parent rewrites both child FK columns', async () => {
		const db = new Database();
		try {
			await db.exec('declare schema y { table parent (px integer, py integer, name text, primary key (px, py)); table child (id integer primary key, a integer null, b integer null) }');
			await db.exec('apply schema y');
			await db.exec('declare logical schema x { table parent (px integer, py integer, name text, primary key (px, py)); table child (id integer primary key, a integer null, b integer null, constraint fk_ab foreign key (a, b) references parent(px, py) on update cascade) }');
			await db.exec('apply schema x');
			await db.exec(`insert into x.parent (px, py, name) values (1, 2, 'p')`);
			await db.exec('insert into x.child (id, a, b) values (10, 1, 2)');
			// Re-key (1,2) -> (7,8): both child FK columns must follow.
			await db.exec('update x.parent set px = 7, py = 8 where px = 1 and py = 2');
			expect(await rows(db, 'select id, a, b from x.child where id = 10'), 'both FK columns rewritten').to.deep.equal([{ id: 10, a: 7, b: 8 }]);
		} finally {
			await db.close();
		}
	});

	it('insert-or-replace on a lens parent cascades the displaced row\'s children (the replacedRow wiring site)', async () => {
		const db = new Database();
		try {
			// REPLACE on the parent PK is a delete-then-insert; the displaced old row fires
			// the lens cascade via the `replacedRow` delete site in processInsertRow. Standard
			// SQLite REPLACE semantics: the ON DELETE CASCADE children of the displaced row
			// are removed even though a new row reoccupies the same PK.
			await deployCascadeLens(db, { fkTail: 'on delete cascade' });
			await db.exec(`insert into x.parent (id, name) values (1, 'a')`);
			await db.exec('insert into x.child (id, pid) values (10, 1)');
			await db.exec(`insert or replace into x.parent (id, name) values (1, 'b')`);
			// The displaced parent's child was cascade-deleted by the replacedRow site...
			expect(await rows(db, 'select count(*) as n from x.child'), 'displaced row children cascade-deleted').to.deep.equal([{ n: 0 }]);
			// ...and the new parent row reoccupies the PK.
			expect(await rows(db, 'select id, name from x.parent where id = 1')).to.deep.equal([{ id: 1, name: 'b' }]);
		} finally {
			await db.close();
		}
	});

	// --- Basis-FK gate short-circuit (ticket: reverse-fk-index-lens-coverage) ---
	// The O(1) `SchemaManager.basisTableBacksLogicalParentFk` gate decides whether the
	// three basis-keyed lens FK paths (executeLensForeignKeyActions /
	// assertLensRestrictsForParentMutation / basisFksOverriddenByDivergentLensFk) run
	// their reverse-map slot scan at all. These pin: a gate MISS short-circuits, a gate
	// HIT preserves existing enforcement, and the gate is invalidated (never stale → the
	// fatal under-report) on lens deploy/redeploy.
	describe('lens enforcement: basis-FK gate short-circuit', () => {
		it('gate miss — a basis table backing no logical-FK parent slot short-circuits the three paths', async () => {
			const db = new Database();
			try {
				// Cascade shape: only `y.parent` is referenced by a logical FK, so only it
				// backs a logical-FK parent slot. `y.child` (referenced by nothing) and an
				// unknown table are gate misses.
				await deployCascadeLens(db, { fkTail: 'on delete cascade' });
				const sm = db.schemaManager;
				expect(sm.basisTableBacksLogicalParentFk('y', 'parent'), 'parent backs a logical-FK slot ⇒ hit').to.be.true;
				expect(sm.basisTableBacksLogicalParentFk('y', 'child'), 'child backs no logical-FK slot ⇒ miss').to.be.false;
				expect(sm.basisTableBacksLogicalParentFk('main', 'unrelated'), 'unknown table ⇒ miss').to.be.false;
				// Case-insensitive, mirroring the reverse-FK index.
				expect(sm.basisTableBacksLogicalParentFk('Y', 'PARENT'), 'gate is case-insensitive').to.be.true;
				// The divergent-suppression set short-circuits to empty on a gate miss, without
				// scanning the slots (mirrors the `maintained-parent-fk` throughput-gate style).
				const childBasis = sm.getTable('y', 'child')!;
				expect(basisFksOverriddenByDivergentLensFk(childBasis, 'delete', sm).size, 'gate miss ⇒ empty set').to.equal(0);
				expect(basisFksOverriddenByDivergentLensFk(childBasis, 'update', sm).size, 'gate miss ⇒ empty set').to.equal(0);
			} finally {
				await db.close();
			}
		});

		it('gate miss — a lens with no logical FK at all leaves every basis table a miss', async () => {
			const db = new Database();
			try {
				// A lens-bearing DB whose logical schema declares NO FK: the parent slot is
				// backed by `y.parent` but referenced by nothing, so the gate is empty.
				await db.exec('declare schema y { table parent (id integer primary key, name text); table child (id integer primary key, pid integer null) }');
				await db.exec('apply schema y');
				await db.exec('declare logical schema x { table parent (id integer primary key, name text); table child (id integer primary key, pid integer null) }');
				await db.exec('apply schema x');
				const sm = db.schemaManager;
				expect(sm.basisTableBacksLogicalParentFk('y', 'parent'), 'no logical FK ⇒ parent is a miss').to.be.false;
				expect(sm.basisTableBacksLogicalParentFk('y', 'child'), 'no logical FK ⇒ child is a miss').to.be.false;
			} finally {
				await db.close();
			}
		});

		it('gate hit — a basis-backed logical cascade still fires (behavior unchanged)', async () => {
			const db = new Database();
			try {
				await deployCascadeLens(db, { fkTail: 'on delete cascade' });
				expect(db.schemaManager.basisTableBacksLogicalParentFk('y', 'parent'), 'gate hit').to.be.true;
				await db.exec(`insert into x.parent (id, name) values (1, 'a')`);
				await db.exec('insert into x.child (id, pid) values (10, 1), (11, 1)');
				await db.exec('delete from x.parent where id = 1');
				expect(await rows(db, 'select count(*) as n from x.child'), 'children cascade-deleted on a gate hit').to.deep.equal([{ n: 0 }]);
			} finally {
				await db.close();
			}
		});

		it('gate hit — action-agnostic: a RESTRICT-only logical FK is a hit and the RESTRICT pre-check still aborts', async () => {
			const db = new Database();
			try {
				// The gate is keyed on *any* referencing logical FK, regardless of action — so a
				// slot referenced only by a RESTRICT logical FK is a hit for all three paths
				// (the cascade walker then no-ops after its own action filter; the RESTRICT
				// pre-check fires). Pins the "action-agnostic over-report is correct, not a miss"
				// claim for the RESTRICT path, which the cascade-hit test above does not exercise.
				await deployCascadeLens(db, { fkTail: 'on delete restrict' });
				expect(db.schemaManager.basisTableBacksLogicalParentFk('y', 'parent'), 'RESTRICT logical FK ⇒ gate hit (action-agnostic)').to.be.true;
				await db.exec(`insert into x.parent (id, name) values (1, 'a'), (2, 'b')`);
				await db.exec('insert into x.child (id, pid) values (10, 1)');
				// Deleting the referenced parent must abort (the logical RESTRICT pre-check runs
				// on the gate hit) — behavior unchanged from the non-gated path.
				await expectThrows(() => db.exec('delete from x.parent where id = 1'), /constraint|foreign|fk/i);
				expect(await rows(db, 'select count(*) as n from x.parent where id = 1'), 'referenced parent survives the RESTRICT').to.deep.equal([{ n: 1 }]);
				// An unreferenced parent still deletes.
				await db.exec('delete from x.parent where id = 2');
				expect(await rows(db, 'select count(*) as n from x.parent where id = 2'), 'unreferenced parent deletes').to.deep.equal([{ n: 0 }]);
			} finally {
				await db.close();
			}
		});

		it('under-report regression — a gate built before the logical FK is deployed is invalidated on deploy', async () => {
			const db = new Database();
			try {
				// Basis only — no lens slots yet.
				await db.exec('declare schema y { table parent (id integer primary key, name text); table child (id integer primary key, pid integer null) }');
				await db.exec('apply schema y');
				const sm = db.schemaManager;
				// Force-build the gate NOW, while no logical FK exists ⇒ it caches as empty.
				expect(sm.basisTableBacksLogicalParentFk('y', 'parent'), 'no logical FK yet ⇒ miss (builds an empty gate)').to.be.false;
				// Deploy the logical cascade FK. deployLogicalSchema MUST invalidate the gate;
				// otherwise the stale empty gate would under-report and the cascade below would
				// silently NOT fire (the fatal direction this guards — the assertion would fail
				// on `n: 2` if the invalidateLensFkGate() call in deployLogicalSchema were removed).
				await db.exec('declare logical schema x { table parent (id integer primary key, name text); table child (id integer primary key, pid integer null, constraint fk_pid foreign key (pid) references parent(id) on delete cascade) }');
				await db.exec('apply schema x');
				expect(sm.basisTableBacksLogicalParentFk('y', 'parent'), 'gate rebuilt after deploy ⇒ hit').to.be.true;
				await db.exec(`insert into x.parent (id, name) values (1, 'a')`);
				await db.exec('insert into x.child (id, pid) values (10, 1), (11, 1)');
				await db.exec('delete from x.parent where id = 1');
				expect(await rows(db, 'select count(*) as n from x.child'), 'cascade fires despite the pre-deploy gate build').to.deep.equal([{ n: 0 }]);
			} finally {
				await db.close();
			}
		});

		it('invalidation on redeploy — dropping the logical FK flips the gate to a miss', async () => {
			const db = new Database();
			try {
				await deployCascadeLens(db, { fkTail: 'on delete cascade' });
				const sm = db.schemaManager;
				expect(sm.basisTableBacksLogicalParentFk('y', 'parent'), 'initially a hit').to.be.true;
				// Re-declare X without the FK (clear-and-rebuild redeploy) ⇒ parent backs no
				// logical-FK slot now. The redeploy invalidates, and the rebuild reflects it.
				await db.exec('declare logical schema x { table parent (id integer primary key, name text); table child (id integer primary key, pid integer null) }');
				await db.exec('apply schema x');
				expect(sm.basisTableBacksLogicalParentFk('y', 'parent'), 'gate reflects the dropped FK ⇒ miss').to.be.false;
			} finally {
				await db.close();
			}
		});
	});
});

describe('lens enforcement: parent-side FK cascade — mixed logical/basis cycle', () => {
	it('terminates by data exhaustion and does not double-delete', async () => {
		const db = new Database();
		try {
			// `a` (basis FK a.bid → b.id ON DELETE CASCADE) and `b` (logical-only FK
			// b.aid → a.id ON DELETE CASCADE). a[1].bid = 10 → b[10]; b[10].aid = 1 → a[1].
			await db.exec('declare schema y { table a (id integer primary key, bid integer null, foreign key (bid) references b(id) on delete cascade); table b (id integer primary key, aid integer null) }');
			await db.exec('apply schema y');
			await db.exec('declare logical schema x { table a (id integer primary key, bid integer null); table b (id integer primary key, aid integer null, constraint fk_b_a foreign key (aid) references a(id) on delete cascade) }');
			await db.exec('apply schema x');

			// Seed the mutual references inside one transaction (the child-side checks defer to commit).
			await db.exec('begin');
			await db.exec('insert into x.b (id, aid) values (10, 1)');
			await db.exec('insert into x.a (id, bid) values (1, 10)');
			await db.exec('commit');

			// Deleting a[1]: lens cascade deletes b[10]; b[10]'s basis cascade tries to delete
			// a rows with bid=10 — a[1] already gone ⇒ data exhausted ⇒ terminates. Each row
			// is deleted exactly once; no infinite loop, no error.
			await db.exec('delete from x.a where id = 1');
			expect(await rows(db, 'select count(*) as n from x.a'), 'a emptied').to.deep.equal([{ n: 0 }]);
			expect(await rows(db, 'select count(*) as n from x.b'), 'b emptied via lens cascade').to.deep.equal([{ n: 0 }]);
		} finally {
			await db.close();
		}
	});
});

describe('lens FK discovery: findLogicalParentFkRefs + cascade elision predicate (unit)', () => {
	it('findLogicalParentFkRefs returns the referencing child ref for a referenced parent slot, and [] for a non-referenced one', async () => {
		const db = new Database();
		try {
			await db.exec('declare schema y { table parent (id integer primary key, name text); table child (id integer primary key, pid integer null); table solo (id integer primary key, v integer) }');
			await db.exec('apply schema y');
			await db.exec('declare logical schema x { table parent (id integer primary key, name text); table child (id integer primary key, pid integer null, constraint fk_pid foreign key (pid) references parent(id) on delete cascade); table solo (id integer primary key, v integer) }');
			await db.exec('apply schema x');

			const parentRefs = findLogicalParentFkRefs(slot(db, 'parent'), db.schemaManager);
			expect(parentRefs.length, 'one child references parent').to.equal(1);
			expect(parentRefs[0].childSlot.logicalTable.name).to.equal('child');
			expect(parentRefs[0].childLogicalColumns).to.deep.equal(['pid']);
			expect(parentRefs[0].parentLogicalColumns).to.deep.equal(['id']);

			// `solo` is referenced by nothing, and `child` is not a referenced parent.
			expect(findLogicalParentFkRefs(slot(db, 'solo'), db.schemaManager), 'solo unreferenced').to.deep.equal([]);
			expect(findLogicalParentFkRefs(slot(db, 'child'), db.schemaManager), 'child is not a parent').to.deep.equal([]);
		} finally {
			await db.close();
		}
	});

	it('basisChildCarriesEquivalentFk fires iff the basis child carries an equivalent FK referencing the basis parent', async () => {
		// With a basis FK on the child referencing the basis parent ⇒ true (elide the lens cascade).
		const withBasisFk = new Database();
		try {
			await withBasisFk.exec('declare schema y { table parent (id integer primary key, name text); table child (id integer primary key, pid integer null, constraint fk foreign key (pid) references parent(id) on delete cascade) }');
			await withBasisFk.exec('apply schema y');
			await withBasisFk.exec('declare logical schema x { table parent (id integer primary key, name text); table child (id integer primary key, pid integer null, constraint fk_pid foreign key (pid) references parent(id) on delete cascade) }');
			await withBasisFk.exec('apply schema x');
			const cSlot = withBasisFk.schemaManager.getSchema('x')!.getLensSlot('child')!;
			const pSlot = withBasisFk.schemaManager.getSchema('x')!.getLensSlot('parent')!;
			const fk = cSlot.obligations!.flatMap(o => o.kind === 'enforced-fk' && o.constraint.kind === 'foreignKey' ? [o.constraint.constraint] : [])[0];
			expect(basisChildCarriesEquivalentFk(
				cSlot, fk, pSlot, ['id'], resolveSlotBasisSource(pSlot, withBasisFk.schemaManager)!, withBasisFk.schemaManager,
			), 'basis FK present ⇒ true').to.be.true;
		} finally {
			await withBasisFk.close();
		}

		// With NO basis FK (the canonical lens shape) ⇒ false (fire the lens cascade).
		const noBasisFk = new Database();
		try {
			await noBasisFk.exec('declare schema y { table parent (id integer primary key, name text); table child (id integer primary key, pid integer null) }');
			await noBasisFk.exec('apply schema y');
			await noBasisFk.exec('declare logical schema x { table parent (id integer primary key, name text); table child (id integer primary key, pid integer null, constraint fk_pid foreign key (pid) references parent(id) on delete cascade) }');
			await noBasisFk.exec('apply schema x');
			const cSlot = noBasisFk.schemaManager.getSchema('x')!.getLensSlot('child')!;
			const pSlot = noBasisFk.schemaManager.getSchema('x')!.getLensSlot('parent')!;
			const fk = cSlot.obligations!.flatMap(o => o.kind === 'enforced-fk' && o.constraint.kind === 'foreignKey' ? [o.constraint.constraint] : [])[0];
			expect(basisChildCarriesEquivalentFk(
				cSlot, fk, pSlot, ['id'], resolveSlotBasisSource(pSlot, noBasisFk.schemaManager)!, noBasisFk.schemaManager,
			), 'no basis FK ⇒ false').to.be.false;
		} finally {
			await noBasisFk.close();
		}
	});
});

describe('lens enforcement: parent-side FK divergent basis action', () => {
	/**
	 * Deploys a **basis-with-FK + logical-with-divergent-FK** shape: the basis child
	 * carries the FK with action `B`, and the logical child re-declares the same FK
	 * over the same column (`pid → parent(id)`) with a divergent action `L ≠ B`. When
	 * the two actions diverge, the **logical action wins** — the lens walker fires the
	 * logical action and the basis action / RESTRICT check is suppressed at every
	 * enforcement site (`basisFksOverriddenByDivergentLensFk`). `foreign_keys` defaults
	 * on. `childPid` tunes the logical child FK-column declaration (e.g. `default 0`).
	 */
	async function deployDivergentFkLens(
		db: Database,
		opts: { basisFkTail: string; logicalFkTail: string; childPid?: string },
	): Promise<void> {
		const childPid = opts.childPid ?? 'pid integer null';
		await db.exec(`declare schema y { table parent (id integer primary key, name text); table child (id integer primary key, pid integer null, constraint fk foreign key (pid) references parent(id) ${opts.basisFkTail}) }`);
		await db.exec('apply schema y');
		await db.exec(`declare logical schema x { table parent (id integer primary key, name text); table child (id integer primary key, ${childPid}, constraint fk_pid foreign key (pid) references parent(id) ${opts.logicalFkTail}) }`);
		await db.exec('apply schema x');
	}

	it('DELETE — logical SET NULL over basis CASCADE nulls the children (not deletes), basis children nulled too', async () => {
		const db = new Database();
		try {
			await deployDivergentFkLens(db, {
				basisFkTail: 'on delete cascade on update cascade',
				logicalFkTail: 'on delete set null on update set null',
			});
			await db.exec(`insert into x.parent (id, name) values (1, 'a')`);
			await db.exec('insert into x.child (id, pid) values (10, 1), (11, 1)');
			// The logical SET NULL wins over the basis CASCADE: deleting the parent nulls
			// the children's FK rather than cascade-deleting them.
			await db.exec('delete from x.parent where id = 1');
			expect(await rows(db, 'select count(*) as n from x.child'), 'children survive (not cascade-deleted)').to.deep.equal([{ n: 2 }]);
			expect(await rows(db, 'select id, pid from x.child order by id'), 'children FK nulled').to.deep.equal([{ id: 10, pid: null }, { id: 11, pid: null }]);
			// The basis reflects the SET NULL (the lens update re-plans to the basis child), not a delete.
			expect(await rows(db, 'select count(*) as n from y.child where pid is null'), 'basis children nulled, not deleted').to.deep.equal([{ n: 2 }]);
		} finally {
			await db.close();
		}
	});

	it('DELETE — logical CASCADE over basis RESTRICT succeeds (not aborted) and cascade-deletes the children', async () => {
		const db = new Database();
		try {
			// The basis RESTRICT would (plan-time immediate + runtime pre-check) abort the
			// parent delete; the divergent logical CASCADE overrides it ⇒ the delete proceeds
			// and the children cascade-delete. This is the case the basis RESTRICT previously aborted.
			await deployDivergentFkLens(db, {
				basisFkTail: 'on delete restrict on update restrict',
				logicalFkTail: 'on delete cascade on update cascade',
			});
			await db.exec(`insert into x.parent (id, name) values (1, 'a'), (2, 'b')`);
			await db.exec('insert into x.child (id, pid) values (10, 1), (11, 1)');
			await db.exec('delete from x.parent where id = 1');
			expect(await rows(db, 'select count(*) as n from x.parent where id = 1'), 'parent deleted (not aborted by basis RESTRICT)').to.deep.equal([{ n: 0 }]);
			expect(await rows(db, 'select count(*) as n from x.child'), 'children cascade-deleted').to.deep.equal([{ n: 0 }]);
			expect(await rows(db, 'select count(*) as n from y.child'), 'basis children cascade-deleted too').to.deep.equal([{ n: 0 }]);
			// An unreferenced parent still deletes cleanly.
			await db.exec('delete from x.parent where id = 2');
			expect(await rows(db, 'select count(*) as n from x.parent')).to.deep.equal([{ n: 0 }]);
		} finally {
			await db.close();
		}
	});

	it('DELETE — logical SET DEFAULT over basis CASCADE sets the child FK to the logical default (not deletes)', async () => {
		const db = new Database();
		try {
			// The logical child FK column declares `default 0`; seed a parent id=0 so the
			// re-defaulted child satisfies its (deferred) child-side FK at commit.
			await deployDivergentFkLens(db, {
				basisFkTail: 'on delete cascade on update cascade',
				logicalFkTail: 'on delete set default on update set default',
				childPid: 'pid integer default 0',
			});
			await db.exec(`insert into x.parent (id, name) values (0, 'def'), (1, 'a')`);
			await db.exec('insert into x.child (id, pid) values (10, 1)');
			await db.exec('delete from x.parent where id = 1');
			expect(await rows(db, 'select id, pid from x.child where id = 10'), 'child FK set to default 0, row kept').to.deep.equal([{ id: 10, pid: 0 }]);
			expect(await rows(db, 'select count(*) as n from x.parent where id = 0'), 'default parent intact').to.deep.equal([{ n: 1 }]);
		} finally {
			await db.close();
		}
	});

	it('UPDATE of the referenced key — logical SET NULL over basis CASCADE nulls (not re-keys); benign non-key UPDATE short-circuits', async () => {
		const db = new Database();
		try {
			await deployDivergentFkLens(db, {
				basisFkTail: 'on delete cascade on update cascade',
				logicalFkTail: 'on delete set null on update set null',
			});
			await db.exec(`insert into x.parent (id, name) values (1, 'a')`);
			await db.exec('insert into x.child (id, pid) values (10, 1)');
			// Re-keying the referenced parent nulls the child FK (logical SET NULL wins),
			// it is NOT cascade-re-keyed to 9.
			await db.exec('update x.parent set id = 9 where id = 1');
			expect(await rows(db, 'select id, pid from x.child where id = 10'), 'child FK nulled, not re-keyed').to.deep.equal([{ id: 10, pid: null }]);
			expect(await rows(db, 'select id from x.parent'), 'parent re-keyed').to.deep.equal([{ id: 9 }]);

			// A benign non-key UPDATE (the referenced key unchanged) cascades nothing.
			await db.exec('insert into x.child (id, pid) values (20, 9)');
			await db.exec(`update x.parent set name = 'renamed' where id = 9`);
			expect(await rows(db, 'select id, pid from x.child where id = 20'), 'benign update short-circuits — child untouched').to.deep.equal([{ id: 20, pid: 9 }]);
		} finally {
			await db.close();
		}
	});

	it('agreeing-action control — logical CASCADE over basis CASCADE is unchanged (single cascade, no double-mutation)', async () => {
		const db = new Database();
		try {
			// Same action on both sides ⇒ the walker still elides and the basis governs.
			await deployDivergentFkLens(db, {
				basisFkTail: 'on delete cascade on update cascade',
				logicalFkTail: 'on delete cascade on update cascade',
			});
			await db.exec(`insert into x.parent (id, name) values (1, 'a')`);
			await db.exec('insert into x.child (id, pid) values (10, 1), (11, 1)');
			await db.exec('delete from x.parent where id = 1');
			expect(await rows(db, 'select count(*) as n from x.child'), 'children removed exactly once').to.deep.equal([{ n: 0 }]);
			expect(await rows(db, 'select count(*) as n from x.parent where id = 1')).to.deep.equal([{ n: 0 }]);
		} finally {
			await db.close();
		}
	});

	it('no-equivalent-basis-FK control — the basis-FK-free cascade lens still fires the logical action', async () => {
		const db = new Database();
		try {
			// The canonical cascade shape: the basis carries NO FK, so there is nothing to
			// suppress and no match ⇒ the lens walker fires the logical CASCADE. Regression
			// pin for the action-aware-elision refactor.
			await db.exec('declare schema y { table parent (id integer primary key, name text); table child (id integer primary key, pid integer null) }');
			await db.exec('apply schema y');
			await db.exec('declare logical schema x { table parent (id integer primary key, name text); table child (id integer primary key, pid integer null, constraint fk_pid foreign key (pid) references parent(id) on delete cascade) }');
			await db.exec('apply schema x');
			await db.exec(`insert into x.parent (id, name) values (1, 'a')`);
			await db.exec('insert into x.child (id, pid) values (10, 1), (11, 1)');
			await db.exec('delete from x.parent where id = 1');
			expect(await rows(db, 'select count(*) as n from x.child'), 'children cascade-deleted by the logical action').to.deep.equal([{ n: 0 }]);
		} finally {
			await db.close();
		}
	});

	it('unit: matchingBasisFksForLensRef returns the equivalent basis FK; basisFksOverriddenByDivergentLensFk contains it iff divergent non-RESTRICT', async () => {
		const db = new Database();
		try {
			// basis CASCADE, logical SET NULL ⇒ divergent non-RESTRICT.
			await deployDivergentFkLens(db, {
				basisFkTail: 'on delete cascade on update cascade',
				logicalFkTail: 'on delete set null on update set null',
			});
			const parentSlot = slot(db, 'parent');
			const basisParent = resolveSlotBasisSource(parentSlot, db.schemaManager)!;
			const refs = findLogicalParentFkRefs(parentSlot, db.schemaManager);
			expect(refs.length, 'one logical FK references parent').to.equal(1);

			// The match core finds the structurally-equivalent basis FK (action-agnostic).
			const matches = matchingBasisFksForLensRef(refs[0], parentSlot, basisParent, db.schemaManager);
			expect(matches.length, 'one equivalent basis FK').to.equal(1);
			const basisFk = matches[0];

			// Divergent non-RESTRICT ⇒ the basis FK is overridden (suppressed) for both ops,
			// and by identity (same object the enforcement sites iterate).
			const delOverridden = basisFksOverriddenByDivergentLensFk(basisParent, 'delete', db.schemaManager);
			const updOverridden = basisFksOverriddenByDivergentLensFk(basisParent, 'update', db.schemaManager);
			expect(delOverridden.has(basisFk), 'basis FK overridden on delete').to.be.true;
			expect(updOverridden.has(basisFk), 'basis FK overridden on update').to.be.true;
		} finally {
			await db.close();
		}
	});

	it('unit: basisFksOverriddenByDivergentLensFk is empty when actions agree or the logical action is RESTRICT', async () => {
		// Agreeing actions (cascade/cascade) ⇒ nothing overridden (the basis governs).
		const agree = new Database();
		try {
			await deployDivergentFkLens(agree, {
				basisFkTail: 'on delete cascade on update cascade',
				logicalFkTail: 'on delete cascade on update cascade',
			});
			const basisParent = resolveSlotBasisSource(slot(agree, 'parent'), agree.schemaManager)!;
			expect(basisFksOverriddenByDivergentLensFk(basisParent, 'delete', agree.schemaManager).size, 'agree ⇒ empty').to.equal(0);
			expect(basisFksOverriddenByDivergentLensFk(basisParent, 'update', agree.schemaManager).size, 'agree ⇒ empty').to.equal(0);
		} finally {
			await agree.close();
		}

		// Logical RESTRICT over a divergent basis action ⇒ NOT overridden here (a logical
		// RESTRICT is the prereq's lens-RESTRICT pre-check domain, not this predicate's).
		const logicalRestrict = new Database();
		try {
			await deployDivergentFkLens(logicalRestrict, {
				basisFkTail: 'on delete cascade on update cascade',
				logicalFkTail: 'on delete restrict on update restrict',
			});
			const basisParent = resolveSlotBasisSource(slot(logicalRestrict, 'parent'), logicalRestrict.schemaManager)!;
			expect(basisFksOverriddenByDivergentLensFk(basisParent, 'delete', logicalRestrict.schemaManager).size, 'logical RESTRICT ⇒ empty').to.equal(0);
		} finally {
			await logicalRestrict.close();
		}
	});

	// --- Coverage extensions (ticket: lens-parent-side-fk-divergent-coverage-extensions) ---
	// The mechanism is column-set-based and arity-uniform; these pin the previously-unexercised
	// composite arity, the remaining divergent (basis × logical) action pairs, the
	// multi-equivalent-basis-FK residual, and transitive (multi-level) divergence.

	it('composite divergent — logical SET NULL over basis CASCADE nulls both FK columns (not deletes)', async () => {
		const db = new Database();
		try {
			// Two-column FK (a, b) → parent(px, py): basis CASCADE, logical SET NULL. The logical
			// action wins ⇒ both child FK columns are nulled rather than the rows cascade-deleted.
			await db.exec('declare schema y { table parent (px integer, py integer, name text, primary key (px, py)); table child (id integer primary key, a integer null, b integer null, constraint fk foreign key (a, b) references parent(px, py) on delete cascade on update cascade) }');
			await db.exec('apply schema y');
			await db.exec('declare logical schema x { table parent (px integer, py integer, name text, primary key (px, py)); table child (id integer primary key, a integer null, b integer null, constraint fk_ab foreign key (a, b) references parent(px, py) on delete set null on update set null) }');
			await db.exec('apply schema x');
			await db.exec(`insert into x.parent (px, py, name) values (1, 2, 'a')`);
			await db.exec('insert into x.child (id, a, b) values (10, 1, 2), (11, 1, 2)');
			await db.exec('delete from x.parent where px = 1 and py = 2');
			expect(await rows(db, 'select count(*) as n from x.child'), 'children survive (logical set null wins)').to.deep.equal([{ n: 2 }]);
			expect(await rows(db, 'select id, a, b from x.child order by id'), 'both FK columns nulled').to.deep.equal([{ id: 10, a: null, b: null }, { id: 11, a: null, b: null }]);
		} finally {
			await db.close();
		}
	});

	it('composite divergent UPDATE — logical CASCADE over basis SET NULL re-keys both FK columns', async () => {
		const db = new Database();
		try {
			// Re-keying the referenced composite key cascades through the multi-column WHERE/SET
			// the logical action builds: a → px (1→9), b → py (2, unchanged).
			await db.exec('declare schema y { table parent (px integer, py integer, name text, primary key (px, py)); table child (id integer primary key, a integer null, b integer null, constraint fk foreign key (a, b) references parent(px, py) on delete set null on update set null) }');
			await db.exec('apply schema y');
			await db.exec('declare logical schema x { table parent (px integer, py integer, name text, primary key (px, py)); table child (id integer primary key, a integer null, b integer null, constraint fk_ab foreign key (a, b) references parent(px, py) on delete cascade on update cascade) }');
			await db.exec('apply schema x');
			await db.exec(`insert into x.parent (px, py, name) values (1, 2, 'a')`);
			await db.exec('insert into x.child (id, a, b) values (10, 1, 2)');
			await db.exec('update x.parent set px = 9 where px = 1 and py = 2');
			expect(await rows(db, 'select id, a, b from x.child where id = 10'), 'both FK columns cascade re-keyed').to.deep.equal([{ id: 10, a: 9, b: 2 }]);
		} finally {
			await db.close();
		}
	});

	it('unit: a permuted basis composite FK does NOT match ⇒ not suppressed (the pair-set differs)', async () => {
		const db = new Database();
		try {
			// Basis FK pairs (a→py, b→px); logical FK pairs (a→px, b→py). The unordered
			// (childCol → parentCol) pair-sets differ ⇒ no structural match ⇒ the basis FK is
			// NOT in the overridden set (a negative case for the order-independent pair-set match).
			await db.exec('declare schema y { table parent (px integer, py integer, name text, primary key (px, py)); table child (id integer primary key, a integer null, b integer null, constraint fk_perm foreign key (a, b) references parent(py, px) on delete cascade on update cascade) }');
			await db.exec('apply schema y');
			await db.exec('declare logical schema x { table parent (px integer, py integer, name text, primary key (px, py)); table child (id integer primary key, a integer null, b integer null, constraint fk_ab foreign key (a, b) references parent(px, py) on delete set null on update set null) }');
			await db.exec('apply schema x');
			const parentSlot = slot(db, 'parent');
			const basisParent = resolveSlotBasisSource(parentSlot, db.schemaManager)!;
			const refs = findLogicalParentFkRefs(parentSlot, db.schemaManager);
			expect(refs.length, 'one logical FK references parent').to.equal(1);
			expect(matchingBasisFksForLensRef(refs[0], parentSlot, basisParent, db.schemaManager).length, 'permuted basis FK ⇒ no structural match').to.equal(0);
			expect(basisFksOverriddenByDivergentLensFk(basisParent, 'delete', db.schemaManager).size, 'permuted ⇒ nothing suppressed').to.equal(0);
			expect(basisFksOverriddenByDivergentLensFk(basisParent, 'update', db.schemaManager).size, 'permuted ⇒ nothing suppressed').to.equal(0);
		} finally {
			await db.close();
		}
	});

	it('DELETE — logical CASCADE over basis SET NULL cascade-deletes the children', async () => {
		const db = new Database();
		try {
			await deployDivergentFkLens(db, {
				basisFkTail: 'on delete set null on update set null',
				logicalFkTail: 'on delete cascade on update cascade',
			});
			await db.exec(`insert into x.parent (id, name) values (1, 'a')`);
			await db.exec('insert into x.child (id, pid) values (10, 1), (11, 1)');
			await db.exec('delete from x.parent where id = 1');
			expect(await rows(db, 'select count(*) as n from x.child'), 'children cascade-deleted (logical wins over basis set null)').to.deep.equal([{ n: 0 }]);
			expect(await rows(db, 'select count(*) as n from y.child'), 'basis children deleted too').to.deep.equal([{ n: 0 }]);
		} finally {
			await db.close();
		}
	});

	it('DELETE — logical SET DEFAULT over basis SET NULL sets the child FK to the logical default', async () => {
		const db = new Database();
		try {
			await deployDivergentFkLens(db, {
				basisFkTail: 'on delete set null on update set null',
				logicalFkTail: 'on delete set default on update set default',
				childPid: 'pid integer default 0',
			});
			await db.exec(`insert into x.parent (id, name) values (0, 'def'), (1, 'a')`);
			await db.exec('insert into x.child (id, pid) values (10, 1)');
			await db.exec('delete from x.parent where id = 1');
			expect(await rows(db, 'select id, pid from x.child where id = 10'), 'child FK set to the logical default 0').to.deep.equal([{ id: 10, pid: 0 }]);
		} finally {
			await db.close();
		}
	});

	it('DELETE — logical SET NULL over basis SET DEFAULT nulls the child FK', async () => {
		const db = new Database();
		try {
			await deployDivergentFkLens(db, {
				basisFkTail: 'on delete set default on update set default',
				logicalFkTail: 'on delete set null on update set null',
			});
			await db.exec(`insert into x.parent (id, name) values (1, 'a')`);
			await db.exec('insert into x.child (id, pid) values (10, 1)');
			await db.exec('delete from x.parent where id = 1');
			expect(await rows(db, 'select id, pid from x.child where id = 10'), 'child FK nulled (logical wins over basis set default)').to.deep.equal([{ id: 10, pid: null }]);
		} finally {
			await db.close();
		}
	});

	it('UPDATE — logical CASCADE over basis SET NULL re-keys the child FK', async () => {
		const db = new Database();
		try {
			await deployDivergentFkLens(db, {
				basisFkTail: 'on delete set null on update set null',
				logicalFkTail: 'on delete cascade on update cascade',
			});
			await db.exec(`insert into x.parent (id, name) values (1, 'a')`);
			await db.exec('insert into x.child (id, pid) values (10, 1)');
			await db.exec('update x.parent set id = 9 where id = 1');
			expect(await rows(db, 'select id, pid from x.child where id = 10'), 'child FK cascade re-keyed to 9').to.deep.equal([{ id: 10, pid: 9 }]);
		} finally {
			await db.close();
		}
	});

	it('UPDATE — logical SET DEFAULT over basis SET NULL sets the child FK to the logical default', async () => {
		const db = new Database();
		try {
			await deployDivergentFkLens(db, {
				basisFkTail: 'on delete set null on update set null',
				logicalFkTail: 'on delete set default on update set default',
				childPid: 'pid integer default 0',
			});
			await db.exec(`insert into x.parent (id, name) values (0, 'def'), (1, 'a')`);
			await db.exec('insert into x.child (id, pid) values (10, 1)');
			await db.exec('update x.parent set id = 9 where id = 1');
			expect(await rows(db, 'select id, pid from x.child where id = 10'), 'child FK set to the logical default 0').to.deep.equal([{ id: 10, pid: 0 }]);
		} finally {
			await db.close();
		}
	});

	it('UPDATE — logical SET NULL over basis SET DEFAULT nulls the child FK', async () => {
		const db = new Database();
		try {
			await deployDivergentFkLens(db, {
				basisFkTail: 'on delete set default on update set default',
				logicalFkTail: 'on delete set null on update set null',
			});
			await db.exec(`insert into x.parent (id, name) values (1, 'a')`);
			await db.exec('insert into x.child (id, pid) values (10, 1)');
			await db.exec('update x.parent set id = 9 where id = 1');
			expect(await rows(db, 'select id, pid from x.child where id = 10'), 'child FK nulled').to.deep.equal([{ id: 10, pid: null }]);
		} finally {
			await db.close();
		}
	});

	it('unit: pathological multi-match — only the divergent same-column basis FK is suppressed', async () => {
		const db = new Database();
		try {
			// Two basis FKs over the IDENTICAL column with mixed actions: CASCADE (agrees with the
			// logical CASCADE) and SET NULL (diverges). The walker fires when *any* match diverges
			// and only the *divergent* matches are suppressed — so the agreeing CASCADE basis FK is
			// NOT overridden (it co-runs; documented sound-but-non-minimal, never a dropped action).
			await db.exec('declare schema y { table parent (id integer primary key, name text); table child (id integer primary key, pid integer null, constraint fk_c foreign key (pid) references parent(id) on delete cascade on update cascade, constraint fk_n foreign key (pid) references parent(id) on delete set null on update set null) }');
			await db.exec('apply schema y');
			await db.exec('declare logical schema x { table parent (id integer primary key, name text); table child (id integer primary key, pid integer null, constraint fk_pid foreign key (pid) references parent(id) on delete cascade on update cascade) }');
			await db.exec('apply schema x');
			const parentSlot = slot(db, 'parent');
			const basisParent = resolveSlotBasisSource(parentSlot, db.schemaManager)!;
			const basisChild = resolveSlotBasisSource(slot(db, 'child'), db.schemaManager)!;
			const fkCascade = basisChild.foreignKeys!.find(f => f.onDelete === 'cascade')!;
			const fkSetNull = basisChild.foreignKeys!.find(f => f.onDelete === 'setNull')!;
			const overridden = basisFksOverriddenByDivergentLensFk(basisParent, 'delete', db.schemaManager);
			expect(overridden.has(fkSetNull), 'divergent SET NULL basis FK suppressed').to.be.true;
			expect(overridden.has(fkCascade), 'agreeing CASCADE basis FK NOT suppressed').to.be.false;
		} finally {
			await db.close();
		}
	});

	it('transitive — step-2 suppression: a suppressed basis cascade is not followed (no spurious grandchild-RESTRICT abort)', async () => {
		const db = new Database();
		try {
			// parent → child diverges (basis CASCADE, logical SET NULL); child → grandchild is a
			// logical RESTRICT (bare FK, no basis FK). The basis cascade WOULD delete the child and
			// thereby trip the grandchild RESTRICT; the logical SET NULL does NOT delete the child.
			// The step-2 suppression in assertTransitiveRestrictsForParentMutation must skip the
			// suppressed basis cascade so the pre-walk does NOT spuriously abort — the delete
			// succeeds, the child is nulled, and the grandchild survives.
			await db.exec('declare schema y { table parent (id integer primary key); table child (id integer primary key, pid integer null, constraint fk_c foreign key (pid) references parent(id) on delete cascade on update cascade); table grandchild (id integer primary key, cid integer null) }');
			await db.exec('apply schema y');
			await db.exec('declare logical schema x { table parent (id integer primary key); table child (id integer primary key, pid integer null, constraint fk_c foreign key (pid) references parent(id) on delete set null on update set null); table grandchild (id integer primary key, cid integer null, constraint fk_g foreign key (cid) references child(id)) }');
			await db.exec('apply schema x');
			await db.exec('insert into x.parent (id) values (1)');
			await db.exec('insert into x.child (id, pid) values (10, 1)');
			await db.exec('insert into x.grandchild (id, cid) values (100, 10)');

			await db.exec('delete from x.parent where id = 1');
			expect(await rows(db, 'select count(*) as n from x.parent'), 'parent deleted (not spuriously aborted)').to.deep.equal([{ n: 0 }]);
			expect(await rows(db, 'select id, pid from x.child where id = 10'), 'child survives, FK nulled (logical set null)').to.deep.equal([{ id: 10, pid: null }]);
			expect(await rows(db, 'select count(*) as n from x.grandchild where id = 100'), 'grandchild survives (its RESTRICT never tripped)').to.deep.equal([{ n: 1 }]);
		} finally {
			await db.close();
		}
	});

	it('transitive — the logical CASCADE\'s child-view re-entry enforces the grandchild RESTRICT', async () => {
		const db = new Database();
		try {
			// parent → child diverges (basis SET NULL, logical CASCADE); child → grandchild is a
			// logical RESTRICT. Deleting the parent fires the logical CASCADE, whose child-view
			// DELETE re-enters the lens write path and re-fires the transitive walk at the child
			// level — finding the grandchild still referencing the child ⇒ ABORT. Confirms the
			// logical action's transitivity is enforced at re-entry (the step-2 suppression's
			// complement: the suppressed basis SET NULL is replaced by the logical cascade, which
			// itself carries the downstream RESTRICT).
			await db.exec('declare schema y { table parent (id integer primary key); table child (id integer primary key, pid integer null, constraint fk_c foreign key (pid) references parent(id) on delete set null on update set null); table grandchild (id integer primary key, cid integer null) }');
			await db.exec('apply schema y');
			await db.exec('declare logical schema x { table parent (id integer primary key); table child (id integer primary key, pid integer null, constraint fk_c foreign key (pid) references parent(id) on delete cascade on update cascade); table grandchild (id integer primary key, cid integer null, constraint fk_g foreign key (cid) references child(id)) }');
			await db.exec('apply schema x');
			await db.exec('insert into x.parent (id) values (1)');
			await db.exec('insert into x.child (id, pid) values (10, 1)');
			await db.exec('insert into x.grandchild (id, cid) values (100, 10)');

			await expectThrows(() => db.exec('delete from x.parent where id = 1'), /constraint|foreign|fk/i);
			// Atomic abort: every level still reads its pre-mutation values.
			expect(await rows(db, 'select count(*) as n from x.parent where id = 1'), 'parent survives').to.deep.equal([{ n: 1 }]);
			expect(await rows(db, 'select id, pid from x.child where id = 10'), 'child survives (cascade rolled back)').to.deep.equal([{ id: 10, pid: 1 }]);
			expect(await rows(db, 'select count(*) as n from x.grandchild where id = 100'), 'grandchild survives (the RESTRICT that bit)').to.deep.equal([{ n: 1 }]);

			// Once the blocking grandchild is gone, the delete cascades cleanly through the child.
			await db.exec('delete from x.grandchild where id = 100');
			await db.exec('delete from x.parent where id = 1');
			expect(await rows(db, 'select count(*) as n from x.parent'), 'parent deleted').to.deep.equal([{ n: 0 }]);
			expect(await rows(db, 'select count(*) as n from x.child'), 'child cascade-deleted by the logical action').to.deep.equal([{ n: 0 }]);
		} finally {
			await db.close();
		}
	});
});

describe('lens enforcement: parent-side FK RESTRICT over a non-restrict basis (runtime pre-check)', () => {
	/**
	 * Deploys a **basis-with-non-restrict-FK + logical-with-RESTRICT-FK** shape: the basis
	 * child carries the FK with a non-RESTRICT action `B` (cascade / set null / set default),
	 * and the logical child re-declares the same FK over the same column **bare** ⇒ RESTRICT.
	 * The lens RESTRICT must win: a delete/update of the logical parent ABORTs (the children
	 * are neither cascade-deleted nor nulled/defaulted), enforced by the runtime pre-check
	 * fired BEFORE the basis op so it observes the pre-cascade child state. The deferred
	 * plan-time `NOT EXISTS` the collector retains for this case races the same-statement
	 * basis action and is structurally unable to enforce it — the pre-check is what bites.
	 * `foreign_keys` defaults on. `childPid` tunes both child FK-column declarations.
	 */
	async function deployLensRestrictOverBasis(
		db: Database,
		opts: { basisFkTail: string; childPid?: string },
	): Promise<void> {
		const childPid = opts.childPid ?? 'pid integer null';
		await db.exec(`declare schema y { table parent (id integer primary key, name text); table child (id integer primary key, ${childPid}, constraint fk foreign key (pid) references parent(id) ${opts.basisFkTail}) }`);
		await db.exec('apply schema y');
		// The logical FK is bare ⇒ RESTRICT for both ops (the lens RESTRICT under test).
		await db.exec(`declare logical schema x { table parent (id integer primary key, name text); table child (id integer primary key, ${childPid}, constraint fk_pid foreign key (pid) references parent(id)) }`);
		await db.exec('apply schema x');
	}

	it('DELETE — lens RESTRICT over basis CASCADE ABORTs; parent and child both survive (the repro)', async () => {
		const db = new Database();
		try {
			await deployLensRestrictOverBasis(db, { basisFkTail: 'on delete cascade on update cascade' });
			await db.exec(`insert into x.parent (id, name) values (1, 'a'), (2, 'b')`);
			await db.exec('insert into x.child (id, pid) values (10, 1)');
			// The basis CASCADE would delete child 10 mid-statement; the lens RESTRICT pre-check
			// fires first (pre-cascade) and rejects the parent delete.
			await expectThrows(() => db.exec('delete from x.parent where id = 1'), /constraint|foreign|fk/i);
			expect(await rows(db, 'select count(*) as n from x.parent where id = 1'), 'parent survives').to.deep.equal([{ n: 1 }]);
			expect(await rows(db, 'select id, pid from x.child where id = 10'), 'child survives, not cascade-deleted').to.deep.equal([{ id: 10, pid: 1 }]);
			expect(await rows(db, 'select count(*) as n from y.child where id = 10'), 'basis child survives too').to.deep.equal([{ n: 1 }]);
			// An unreferenced parent still deletes cleanly.
			await db.exec('delete from x.parent where id = 2');
			expect(await rows(db, 'select count(*) as n from x.parent where id = 2')).to.deep.equal([{ n: 0 }]);
		} finally {
			await db.close();
		}
	});

	it('DELETE — lens RESTRICT over basis SET NULL ABORTs; child retains its FK value (not nulled)', async () => {
		const db = new Database();
		try {
			await deployLensRestrictOverBasis(db, { basisFkTail: 'on delete set null on update set null' });
			await db.exec(`insert into x.parent (id, name) values (1, 'a')`);
			await db.exec('insert into x.child (id, pid) values (10, 1)');
			await expectThrows(() => db.exec('delete from x.parent where id = 1'), /constraint|foreign|fk/i);
			expect(await rows(db, 'select count(*) as n from x.parent where id = 1'), 'parent survives').to.deep.equal([{ n: 1 }]);
			expect(await rows(db, 'select id, pid from x.child where id = 10'), 'child FK not nulled').to.deep.equal([{ id: 10, pid: 1 }]);
		} finally {
			await db.close();
		}
	});

	it('DELETE — lens RESTRICT over basis SET DEFAULT ABORTs; child retains its FK value (not defaulted)', async () => {
		const db = new Database();
		try {
			await deployLensRestrictOverBasis(db, { basisFkTail: 'on delete set default on update set default', childPid: 'pid integer default 0' });
			await db.exec(`insert into x.parent (id, name) values (0, 'def'), (1, 'a')`);
			await db.exec('insert into x.child (id, pid) values (10, 1)');
			await expectThrows(() => db.exec('delete from x.parent where id = 1'), /constraint|foreign|fk/i);
			expect(await rows(db, 'select count(*) as n from x.parent where id = 1'), 'parent survives').to.deep.equal([{ n: 1 }]);
			expect(await rows(db, 'select id, pid from x.child where id = 10'), 'child FK not set to default').to.deep.equal([{ id: 10, pid: 1 }]);
		} finally {
			await db.close();
		}
	});

	it('UPDATE of the referenced key — lens RESTRICT over basis CASCADE ABORTs; benign non-key UPDATE succeeds (short-circuit)', async () => {
		const db = new Database();
		try {
			await deployLensRestrictOverBasis(db, { basisFkTail: 'on delete cascade on update cascade' });
			await db.exec(`insert into x.parent (id, name) values (1, 'a')`);
			await db.exec('insert into x.child (id, pid) values (10, 1)');
			// Re-keying the referenced parent would basis-CASCADE the child's pid; the lens
			// RESTRICT pre-check fires first and rejects it.
			await expectThrows(() => db.exec('update x.parent set id = 9 where id = 1'), /constraint|foreign|fk/i);
			expect(await rows(db, 'select id from x.parent'), 'key change rolled back').to.deep.equal([{ id: 1 }]);
			expect(await rows(db, 'select id, pid from x.child where id = 10'), 'child unchanged').to.deep.equal([{ id: 10, pid: 1 }]);
			// A benign UPDATE that does not touch the referenced key short-circuits ⇒ succeeds.
			await db.exec(`update x.parent set name = 'renamed' where id = 1`);
			expect(await rows(db, 'select name from x.parent where id = 1')).to.deep.equal([{ name: 'renamed' }]);
		} finally {
			await db.close();
		}
	});

	it('UPDATE rewriting the referenced key with a differently-spelled equivalent value does NOT trip the lens RESTRICT pre-check (regression for bug-fk-restrict-change-detection-uncoerced)', async () => {
		const db = new Database();
		try {
			await deployLensRestrictOverBasis(db, { basisFkTail: 'on delete cascade on update cascade' });
			await db.exec(`insert into x.parent (id, name) values (1, 'a')`);
			await db.exec('insert into x.child (id, pid) values (10, 1)');
			// The integer key rewritten as the text '1' stores the same value. The referenced-
			// column-change short-circuit (resolveLensFkParentReferencedValues) must re-coerce the
			// raw NEW value through the column's logical type before comparing — otherwise this
			// reads as a change and the lens RESTRICT pre-check wrongly ABORTs a no-op rewrite.
			await db.exec(`update x.parent set id = '1' where id = 1`);
			expect(await rows(db, 'select id from x.parent'), 'key unchanged, no abort').to.deep.equal([{ id: 1 }]);
			expect(await rows(db, 'select id, pid from x.child where id = 10'), 'child unaffected').to.deep.equal([{ id: 10, pid: 1 }]);
		} finally {
			await db.close();
		}
	});

	it('UPDATE of the referenced key — lens RESTRICT over basis SET NULL ABORTs (rows unchanged)', async () => {
		const db = new Database();
		try {
			await deployLensRestrictOverBasis(db, { basisFkTail: 'on delete set null on update set null' });
			await db.exec(`insert into x.parent (id, name) values (1, 'a')`);
			await db.exec('insert into x.child (id, pid) values (10, 1)');
			await expectThrows(() => db.exec('update x.parent set id = 9 where id = 1'), /constraint|foreign|fk/i);
			expect(await rows(db, 'select id from x.parent'), 'key change rolled back').to.deep.equal([{ id: 1 }]);
			expect(await rows(db, 'select id, pid from x.child where id = 10'), 'child unchanged').to.deep.equal([{ id: 10, pid: 1 }]);
		} finally {
			await db.close();
		}
	});

	it('UPDATE of the referenced key — lens RESTRICT over basis SET DEFAULT ABORTs (rows unchanged)', async () => {
		const db = new Database();
		try {
			await deployLensRestrictOverBasis(db, { basisFkTail: 'on delete set default on update set default', childPid: 'pid integer default 0' });
			await db.exec(`insert into x.parent (id, name) values (0, 'def'), (1, 'a')`);
			await db.exec('insert into x.child (id, pid) values (10, 1)');
			await expectThrows(() => db.exec('update x.parent set id = 9 where id = 1'), /constraint|foreign|fk/i);
			expect(await rows(db, 'select id from x.parent order by id'), 'key change rolled back').to.deep.equal([{ id: 0 }, { id: 1 }]);
			expect(await rows(db, 'select id, pid from x.child where id = 10'), 'child unchanged').to.deep.equal([{ id: 10, pid: 1 }]);
		} finally {
			await db.close();
		}
	});

	it('composite key — lens RESTRICT over basis CASCADE ABORTs a delete/update of the referenced composite key', async () => {
		const db = new Database();
		try {
			await db.exec('declare schema y { table parent (px integer, py integer, name text, primary key (px, py)); table child (id integer primary key, a integer null, b integer null, constraint fk foreign key (a, b) references parent(px, py) on delete cascade on update cascade) }');
			await db.exec('apply schema y');
			await db.exec('declare logical schema x { table parent (px integer, py integer, name text, primary key (px, py)); table child (id integer primary key, a integer null, b integer null, constraint fk_ab foreign key (a, b) references parent(px, py)) }');
			await db.exec('apply schema x');
			await db.exec(`insert into x.parent (px, py, name) values (1, 2, 'a'), (3, 4, 'b')`);
			await db.exec('insert into x.child (id, a, b) values (10, 1, 2)'); // references (1,2)

			await expectThrows(() => db.exec('delete from x.parent where px = 1 and py = 2'), /constraint|foreign|fk/i);
			await expectThrows(() => db.exec('update x.parent set px = 9 where px = 1 and py = 2'), /constraint|foreign|fk/i);
			expect(await rows(db, 'select id, a, b from x.child where id = 10'), 'child unchanged').to.deep.equal([{ id: 10, a: 1, b: 2 }]);
			// An unreferenced composite parent still deletes cleanly.
			await db.exec('delete from x.parent where px = 3 and py = 4');
			expect(await rows(db, 'select count(*) as n from x.parent where px = 3')).to.deep.equal([{ n: 0 }]);
		} finally {
			await db.close();
		}
	});

	it('pragma gate — foreign_keys = false ⇒ no lens RESTRICT pre-check (no FK enforcement, child orphaned)', async () => {
		const db = new Database();
		try {
			await deployLensRestrictOverBasis(db, { basisFkTail: 'on delete cascade on update cascade' });
			await db.exec(`insert into x.parent (id, name) values (1, 'a')`);
			await db.exec('insert into x.child (id, pid) values (10, 1)');
			await db.exec('pragma foreign_keys = false');
			// With FKs off, neither the lens pre-check nor the basis action fires — the parent
			// deletes and the child is orphaned (matching the physical parent-side gate).
			await db.exec('delete from x.parent where id = 1');
			expect(await rows(db, 'select count(*) as n from x.parent where id = 1')).to.deep.equal([{ n: 0 }]);
			expect(await rows(db, 'select id, pid from x.child where id = 10'), 'child orphaned (no enforcement)').to.deep.equal([{ id: 10, pid: 1 }]);
		} finally {
			await db.close();
		}
	});

	it('transitive — a lens RESTRICT two hops down (through a basis cascade) ABORTs the top-level parent delete', async () => {
		// parent → mid (basis+logical cascade, agreeing) → leaf (basis cascade, but logical bare ⇒ RESTRICT).
		// Deleting parent would basis-cascade mid, then basis-cascade leaf. The lens RESTRICT on
		// leaf→mid must win two hops down: the transitive pre-walk recurses through the mid basis
		// cascade and re-fires the lens RESTRICT pre-check at the mid level, finding leaf still
		// referencing mid ⇒ ABORT before any row is mutated. Pins the implementer's claim that
		// transitivity through basis cascades rides the enclosing transitive walk.
		const db = new Database();
		try {
			await db.exec('declare schema y { table parent (id integer primary key); table mid (id integer primary key, pid integer null, constraint fk_mp foreign key (pid) references parent(id) on delete cascade on update cascade); table leaf (id integer primary key, mid_id integer null, constraint fk_lm foreign key (mid_id) references mid(id) on delete cascade on update cascade) }');
			await db.exec('apply schema y');
			// mid→parent logical cascade AGREES with basis (elided); leaf→mid logical is bare ⇒ RESTRICT.
			await db.exec('declare logical schema x { table parent (id integer primary key); table mid (id integer primary key, pid integer null, constraint fk_mp foreign key (pid) references parent(id) on delete cascade on update cascade); table leaf (id integer primary key, mid_id integer null, constraint fk_lm foreign key (mid_id) references mid(id)) }');
			await db.exec('apply schema x');
			await db.exec('insert into x.parent (id) values (1)');
			await db.exec('insert into x.mid (id, pid) values (10, 1)');
			await db.exec('insert into x.leaf (id, mid_id) values (100, 10)');

			await expectThrows(() => db.exec('delete from x.parent where id = 1'), /constraint|foreign|fk/i);

			// Atomic abort: every level still reads its pre-mutation values.
			expect(await rows(db, 'select count(*) as n from x.parent where id = 1'), 'parent survives').to.deep.equal([{ n: 1 }]);
			expect(await rows(db, 'select count(*) as n from x.mid where id = 10'), 'mid survives (not cascade-deleted)').to.deep.equal([{ n: 1 }]);
			expect(await rows(db, 'select count(*) as n from x.leaf where id = 100'), 'leaf survives (the RESTRICT that bit)').to.deep.equal([{ n: 1 }]);

			// Once the blocking leaf is gone, the top-level delete cascades cleanly through mid.
			await db.exec('delete from x.leaf where id = 100');
			await db.exec('delete from x.parent where id = 1');
			expect(await rows(db, 'select count(*) as n from x.parent'), 'parent deleted').to.deep.equal([{ n: 0 }]);
			expect(await rows(db, 'select count(*) as n from x.mid'), 'mid cascade-deleted').to.deep.equal([{ n: 0 }]);
		} finally {
			await db.close();
		}
	});
});

describe('lens enforcement: parent-side FK is lens-routed-only (basis-direct DML bears only basis FKs)', () => {
	// The runtime parent-side *logical* FK machinery (the cascade walker, the lens RESTRICT
	// pre-check, and the divergent-basis-FK suppression) is keyed off a plan-time `lensRouted`
	// marker, so it fires ONLY for a write routed through the lens view — never for a write
	// straight to the basis table. This makes the runtime side consistent with the plan-time
	// lens RESTRICT collector and logical CHECK, which already attach at the lens boundary only.

	/** Canonical cascade shape: the basis carries NO FK; the action lives only on the logical FK. */
	async function deployCascadeLens(db: Database, fkTail: string): Promise<void> {
		await db.exec('declare schema y { table parent (id integer primary key, name text); table child (id integer primary key, pid integer null) }');
		await db.exec('apply schema y');
		await db.exec(`declare logical schema x { table parent (id integer primary key, name text); table child (id integer primary key, pid integer null, constraint fk_pid foreign key (pid) references parent(id) ${fkTail}) }`);
		await db.exec('apply schema x');
	}

	/** Divergent shape: basis child carries action `B`, logical child re-declares it with `L ≠ B`. */
	async function deployDivergentLens(db: Database, basisFkTail: string, logicalFkTail: string): Promise<void> {
		await db.exec(`declare schema y { table parent (id integer primary key, name text); table child (id integer primary key, pid integer null, constraint fk foreign key (pid) references parent(id) ${basisFkTail}) }`);
		await db.exec('apply schema y');
		await db.exec(`declare logical schema x { table parent (id integer primary key, name text); table child (id integer primary key, pid integer null, constraint fk_pid foreign key (pid) references parent(id) ${logicalFkTail}) }`);
		await db.exec('apply schema x');
	}

	/** RESTRICT-over-non-restrict-basis shape: basis non-restrict FK, logical FK bare ⇒ RESTRICT. */
	async function deployRestrictOverBasis(db: Database, basisFkTail: string): Promise<void> {
		await db.exec(`declare schema y { table parent (id integer primary key, name text); table child (id integer primary key, pid integer null, constraint fk foreign key (pid) references parent(id) ${basisFkTail}) }`);
		await db.exec('apply schema y');
		await db.exec('declare logical schema x { table parent (id integer primary key, name text); table child (id integer primary key, pid integer null, constraint fk_pid foreign key (pid) references parent(id)) }');
		await db.exec('apply schema x');
	}

	/** Depth-first search for the first DmlExecutorNode in a plan subtree. */
	function findDmlExecutor(node: PlanNode): DmlExecutorNode | undefined {
		if (node.nodeType === PlanNodeType.UpdateExecutor) return node as DmlExecutorNode;
		for (const child of node.getChildren()) {
			const found = findDmlExecutor(child);
			if (found) return found;
		}
		return undefined;
	}

	it('CASCADE does NOT fire on a basis-direct delete (the headline gap); the same delete through the lens cascades', async () => {
		const db = new Database();
		try {
			await deployCascadeLens(db, 'on delete cascade');
			await db.exec(`insert into x.parent (id, name) values (1, 'a'), (2, 'b')`);
			await db.exec('insert into x.child (id, pid) values (10, 1), (20, 2)');

			// Basis-direct: delete y.parent(1). The basis has no FK and the logical cascade is
			// gated off ⇒ the child survives (orphaned), NOT cascade-deleted.
			await db.exec('delete from y.parent where id = 1');
			expect(await rows(db, 'select count(*) as n from y.child where id = 10'), 'basis child survives a basis-direct parent delete').to.deep.equal([{ n: 1 }]);
			expect(await rows(db, 'select count(*) as n from x.child where id = 10'), 'lens view reflects the surviving basis child').to.deep.equal([{ n: 1 }]);

			// Contrast — the same delete through the lens DOES cascade.
			await db.exec('delete from x.parent where id = 2');
			expect(await rows(db, 'select count(*) as n from x.child where id = 20'), 'lens-routed delete cascades the child away').to.deep.equal([{ n: 0 }]);
			expect(await rows(db, 'select count(*) as n from y.child where id = 20'), 'basis child cascade-deleted too').to.deep.equal([{ n: 0 }]);
		} finally {
			await db.close();
		}
	});

	it('CASCADE still fires through the lens (unchanged-path regression guard)', async () => {
		const db = new Database();
		try {
			await deployCascadeLens(db, 'on delete cascade');
			await db.exec(`insert into x.parent (id, name) values (1, 'a')`);
			await db.exec('insert into x.child (id, pid) values (10, 1), (11, 1)');
			await db.exec('delete from x.parent where id = 1');
			expect(await rows(db, 'select count(*) as n from x.child'), 'lens cascade still removes the children').to.deep.equal([{ n: 0 }]);
		} finally {
			await db.close();
		}
	});

	it('runtime lens RESTRICT does NOT fire on a basis-direct delete (the basis action governs instead)', async () => {
		const db = new Database();
		try {
			// Logical RESTRICT over a basis `on delete cascade`.
			await deployRestrictOverBasis(db, 'on delete cascade on update cascade');
			await db.exec(`insert into x.parent (id, name) values (1, 'a')`);
			await db.exec('insert into x.child (id, pid) values (10, 1)');

			// Through the lens, the RESTRICT pre-check ABORTs the referenced parent delete.
			await expectThrows(() => db.exec('delete from x.parent where id = 1'), /constraint|foreign|fk/i);
			expect(await rows(db, 'select count(*) as n from x.parent where id = 1'), 'parent survives the lens RESTRICT').to.deep.equal([{ n: 1 }]);
			expect(await rows(db, 'select count(*) as n from x.child where id = 10'), 'child survives the lens RESTRICT').to.deep.equal([{ n: 1 }]);

			// Basis-direct: the lens RESTRICT pre-check is gated off, so the parent delete
			// succeeds and the *basis* CASCADE fires per the basis action.
			await db.exec('delete from y.parent where id = 1');
			expect(await rows(db, 'select count(*) as n from y.parent where id = 1'), 'basis-direct delete succeeds (no lens RESTRICT)').to.deep.equal([{ n: 0 }]);
			expect(await rows(db, 'select count(*) as n from y.child where id = 10'), 'basis CASCADE removed the child').to.deep.equal([{ n: 0 }]);
		} finally {
			await db.close();
		}
	});

	it('divergent-suppression soundness — a basis-direct delete applies the basis action (not suppressed into a no-op)', async () => {
		const db = new Database();
		try {
			// Logical SET NULL over basis CASCADE: through the lens the logical action wins
			// (suppressing the basis CASCADE), but a basis-direct write must NOT be suppressed.
			await deployDivergentLens(db, 'on delete cascade on update cascade', 'on delete set null on update set null');
			await db.exec(`insert into x.parent (id, name) values (1, 'a'), (2, 'b')`);
			await db.exec('insert into x.child (id, pid) values (10, 1), (20, 2)');

			// Through the lens: logical SET NULL wins ⇒ child 10 nulled, not deleted.
			await db.exec('delete from x.parent where id = 1');
			expect(await rows(db, 'select id, pid from x.child where id = 10'), 'lens-routed delete: logical SET NULL wins').to.deep.equal([{ id: 10, pid: null }]);

			// Basis-direct: the divergent suppression is gated off ⇒ the basis CASCADE applies
			// and deletes the child. This is the soundness hole the lensRouted gate closes:
			// without it, the basis FK would be suppressed yet the lens walker also gated off,
			// leaving NO action at all (an orphaned survivor).
			await db.exec('delete from y.parent where id = 2');
			expect(await rows(db, 'select count(*) as n from x.child where id = 20'), 'basis-direct delete applies the basis CASCADE (physical FK no longer suppressed)').to.deep.equal([{ n: 0 }]);
			expect(await rows(db, 'select count(*) as n from y.child where id = 20')).to.deep.equal([{ n: 0 }]);
		} finally {
			await db.close();
		}
	});

	it('UPDATE — cascade lens: a basis-direct re-key does not cascade; the same re-key through the lens does', async () => {
		const db = new Database();
		try {
			await deployCascadeLens(db, 'on update cascade');
			await db.exec(`insert into x.parent (id, name) values (1, 'a'), (2, 'b')`);
			await db.exec('insert into x.child (id, pid) values (10, 1), (20, 2)');

			// Lens-routed re-key cascades the child FK.
			await db.exec('update x.parent set id = 9 where id = 2');
			expect(await rows(db, 'select id, pid from x.child where id = 20'), 'lens-routed re-key cascades the child FK').to.deep.equal([{ id: 20, pid: 9 }]);

			// Basis-direct re-key: no FK on the basis and the lens cascade gated off ⇒ the child
			// FK is left untouched (now dangling).
			await db.exec('update y.parent set id = 7 where id = 1');
			expect(await rows(db, 'select id, pid from x.child where id = 10'), 'basis-direct re-key does not cascade the child').to.deep.equal([{ id: 10, pid: 1 }]);
		} finally {
			await db.close();
		}
	});

	it('UPDATE — divergent lens: a basis-direct re-key applies the basis CASCADE; the same re-key through the lens applies the logical SET NULL', async () => {
		const db = new Database();
		try {
			await deployDivergentLens(db, 'on delete cascade on update cascade', 'on delete set null on update set null');
			await db.exec(`insert into x.parent (id, name) values (1, 'a'), (2, 'b')`);
			await db.exec('insert into x.child (id, pid) values (10, 1), (20, 2)');

			// Lens-routed re-key: logical SET NULL wins ⇒ child 10 nulled (not re-keyed).
			await db.exec('update x.parent set id = 8 where id = 1');
			expect(await rows(db, 'select id, pid from x.child where id = 10'), 'lens-routed re-key: logical SET NULL wins').to.deep.equal([{ id: 10, pid: null }]);

			// Basis-direct re-key: the divergent suppression is gated off ⇒ the basis CASCADE
			// re-keys the child FK.
			await db.exec('update y.parent set id = 9 where id = 2');
			expect(await rows(db, 'select id, pid from x.child where id = 20'), 'basis-direct re-key applies the basis CASCADE (not suppressed)').to.deep.equal([{ id: 20, pid: 9 }]);
		} finally {
			await db.close();
		}
	});

	it('transitive — a lens-routed parent delete cascades through a logical grandchild; a basis-direct one does not', async () => {
		const db = new Database();
		try {
			await db.exec('declare schema y { table parent (id integer primary key); table child (id integer primary key, pid integer null); table grandchild (id integer primary key, cid integer null) }');
			await db.exec('apply schema y');
			await db.exec('declare logical schema x { table parent (id integer primary key); table child (id integer primary key, pid integer null, constraint fk_c foreign key (pid) references parent(id) on delete cascade); table grandchild (id integer primary key, cid integer null, constraint fk_g foreign key (cid) references child(id) on delete cascade) }');
			await db.exec('apply schema x');
			await db.exec('insert into x.parent (id) values (1), (2)');
			await db.exec('insert into x.child (id, pid) values (10, 1), (20, 2)');
			await db.exec('insert into x.grandchild (id, cid) values (100, 10), (200, 20)');

			// Lens-routed: the re-entry path fires the next level's logical cascade, all the way down.
			await db.exec('delete from x.parent where id = 1');
			expect(await rows(db, 'select count(*) as n from x.child where id = 10'), 'child cascade-deleted').to.deep.equal([{ n: 0 }]);
			expect(await rows(db, 'select count(*) as n from x.grandchild where id = 100'), 'grandchild cascade-deleted transitively').to.deep.equal([{ n: 0 }]);

			// Basis-direct: no logical-only FK fires at any level ⇒ child and grandchild survive.
			await db.exec('delete from y.parent where id = 2');
			expect(await rows(db, 'select count(*) as n from y.child where id = 20'), 'child survives a basis-direct parent delete').to.deep.equal([{ n: 1 }]);
			expect(await rows(db, 'select count(*) as n from y.grandchild where id = 200'), 'grandchild untouched (logical-only FK does not fire basis-direct)').to.deep.equal([{ n: 1 }]);
		} finally {
			await db.close();
		}
	});

	it('plan-node regression: a lens-routed delete sets lensRouted, and DmlExecutorNode.withChildren preserves it', async () => {
		const db = new Database();
		try {
			await deployCascadeLens(db, 'on delete cascade');

			// Plan a delete through the lens parent (without executing) and locate the basis-spine
			// DmlExecutorNode — it must carry the plan-time lensRouted marker.
			const ctx: PlanningContext = {
				db,
				schemaManager: db.schemaManager,
				parameters: {},
				scope: new ParameterScope(new GlobalScope(db.schemaManager)),
				cteNodes: new Map(),
				schemaDependencies: new BuildTimeDependencyTracker(),
				schemaCache: new Map(),
				cteReferenceCache: new Map(),
				cteDescriptors: new Map(),
				outputScopes: new Map(),
			};
			const ast = new Parser().parseAll('delete from x.parent where id = 1')[0] as AST.DeleteStmt;
			const exec = findDmlExecutor(buildDeleteStmt(ctx, ast));
			expect(exec, 'a DmlExecutorNode is present in the lens-routed plan').to.not.equal(undefined);
			expect(exec!.lensRouted, 'lens-routed basis delete carries the marker').to.equal(true);
			expect(exec!.getLogicalAttributes().lensRouted, 'marker surfaced for debug visibility').to.equal(true);

			// withChildren rebuild (a distinct relational child) must carry the marker forward —
			// else the optimizer would drop the lens-routed FK semantics on any node rebuild.
			const innerChild = exec!.source.getChildren()[0];
			expect(isRelationalNode(innerChild), 'inner child is relational').to.equal(true);
			const rebuilt = exec!.withChildren([innerChild]) as DmlExecutorNode;
			expect(rebuilt, 'withChildren produced a new instance').to.not.equal(exec);
			expect(rebuilt.lensRouted, 'lensRouted survives a withChildren rebuild').to.equal(true);
		} finally {
			await db.close();
		}
	});
});
