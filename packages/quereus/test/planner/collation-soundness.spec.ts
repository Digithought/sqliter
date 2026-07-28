/**
 * Regression net for ticket `collation-blind-equality-fact-extraction`.
 *
 * Plan-time equality facts (constant pins, col=col mirrors/ECs, constant
 * bindings, guard-discharge facts, covered-key witnesses, join equi-pairs) are
 * VALUE-level claims, so they must be gated on the comparison's effective
 * collation being value-discriminating. These tests pin the reproduced
 * unsoundness shapes, the sound declared-collation controls that must keep
 * working, and the sound-by-accident invariants (CollateNode non-injectivity,
 * constraint-extractor's Cast-only unwrap).
 *
 * Shape 5 is from `bug-json-columns-classified-as-non-textual`: a `JSON`
 * operand can hold a text string at runtime, so it is not collation-exempt.
 */
import { expect } from 'chai';
import { Database } from '../../src/core/database.js';
import { keysOf, isAtMostOneRow, extractEqualityFds } from '../../src/planner/util/fd-utils.js';
import type { PlanNode, RelationalPlanNode, ScalarPlanNode } from '../../src/planner/nodes/plan-node.js';
import { PlanNodeType } from '../../src/planner/nodes/plan-node-type.js';
import { EmptyScope } from '../../src/planner/scopes/empty.js';
import { BinaryOpNode, CollateNode, LiteralNode } from '../../src/planner/nodes/scalar.js';
import { ColumnReferenceNode } from '../../src/planner/nodes/reference.js';
import { INTEGER_TYPE, TEXT_TYPE } from '../../src/types/builtin-types.js';
import { JSON_TYPE } from '../../src/types/json-type.js';
import { isValueDiscriminatingAstComparison } from '../../src/planner/analysis/comparison-collation.js';
import type * as AST from '../../src/parser/ast.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const scope = EmptyScope.instance as unknown as any;

function rootOf(db: Database, sql: string): RelationalPlanNode {
	const block = db.getPlan(sql) as unknown as PlanNode;
	const root = (block as unknown as { getRelations?: () => RelationalPlanNode[] }).getRelations?.()[0];
	expect(root, `no relational root for: ${sql}`).to.exist;
	return root!;
}

async function collect(db: Database, sql: string): Promise<Record<string, unknown>[]> {
	const rows: Record<string, unknown>[] = [];
	for await (const r of db.eval(sql)) rows.push(r as Record<string, unknown>);
	return rows;
}

describe('Collation soundness of plan-time equality facts', () => {
	let db: Database;

	beforeEach(() => {
		db = new Database();
	});

	afterEach(async () => {
		await db.close();
	});

	describe('repro shapes (must stay fixed)', () => {
		beforeEach(async () => {
			await db.exec('create table t4 (b text, x integer, y integer, primary key (b, x)) using memory');
		});

		it('1: NOCASE pin over a BINARY-keyed column makes no ≤1-row claim', async () => {
			await db.exec("insert into t4 values ('Bob',1,10), ('bob',1,20)");
			const q = "select * from t4 where b = 'bob' collate nocase and x = 1";
			const root = rootOf(db, q);
			const rows = await collect(db, q);
			expect(rows.length).to.equal(2);
			expect(isAtMostOneRow(root), 'false ≤1-row claim').to.equal(false);
			expect(keysOf(root).some(k => k.length === 0), 'empty key claimed').to.equal(false);
		});

		it('2: ORDER BY is not elided under a NOCASE pin', async () => {
			await db.exec("insert into t4 values ('Bob',1,10), ('bob',1,20)");
			const rows = await collect(db, "select y from t4 where b = 'bob' collate nocase and x = 1 order by y desc");
			expect(rows.map(r => r.y)).to.deep.equal([20, 10]);
		});

		it('3: DISTINCT is not eliminated under a NOCASE pin', async () => {
			await db.exec("insert into t4 values ('Bob',1,10), ('bob',1,10)");
			const rows = await collect(db, "select distinct y from t4 where b = 'bob' collate nocase and x = 1");
			expect(rows).to.deep.equal([{ y: 10 }]);
		});

		it('4: a NOCASE pin does not discharge a partial-unique guard out of scope', async () => {
			await db.exec('create table t10 (id integer primary key, x integer, b text) using memory');
			await db.exec("create unique index ui on t10 (x) where b = 'bob'");
			await db.exec("insert into t10 values (1,1,'bob'), (2,1,'Bob')");
			const q = "select x, id from t10 where b = 'bob' collate nocase";
			const root = rootOf(db, q);
			const rows = await collect(db, q);
			expect(rows.length).to.equal(2);
			// x (output column 0) repeats across the two rows — claiming key {x}
			// would be the out-of-scope discharge this ticket fixed.
			expect(keysOf(root).some(k => k.length === 1 && k[0] === 0), 'guard key {x} claimed out of scope').to.equal(false);
		});

		it('5: a NOCASE pin on a JSON column makes no ≤1-row claim', async () => {
			await db.exec('create table tj (j json, x integer, primary key (j, x)) using memory');
			await db.exec(`insert into tj values ('"Bob"',1), ('"bob"',1)`);
			const q = `select * from tj where j = cast('"bob"' as json) collate nocase and x = 1`;
			const root = rootOf(db, q);
			expect((await collect(db, q)).length).to.equal(2);
			expect(isAtMostOneRow(root), 'false ≤1-row claim on JSON column').to.equal(false);
			expect(keysOf(root).some(k => k.length === 0), 'empty key claimed').to.equal(false);
		});
	});

	describe('AST-level gate (isValueDiscriminatingAstComparison)', () => {
		const colExpr = (name: string): AST.Expression => ({ type: 'column', name } as AST.ColumnExpr);
		const map = new Map([['j', 0], ['b', 1], ['n', 2]]);

		it('a NOCASE-declared JSON column is not treated as collation-exempt', () => {
			// JSON's physical representation is OBJECT, but `JSON_TYPE.parse` passes a
			// JSON scalar string straight through, so a JSON value can be the string
			// 'Bob'. Claiming non-textuality here would mint value-level facts from a
			// NOCASE comparison that passes 'Bob' = 'bob'.
			const columns = [{ collation: 'NOCASE', logicalType: JSON_TYPE }];
			expect(isValueDiscriminatingAstComparison(colExpr('j'), colExpr('j'), map, columns)).to.equal(false);
		});

		it('a NOCASE-declared INTEGER column stays collation-exempt', () => {
			const columns = [{ collation: 'NOCASE', logicalType: JSON_TYPE }, { collation: 'NOCASE', logicalType: TEXT_TYPE }, { collation: 'NOCASE', logicalType: INTEGER_TYPE }];
			expect(isValueDiscriminatingAstComparison(colExpr('n'), colExpr('n'), map, columns)).to.equal(true);
			expect(isValueDiscriminatingAstComparison(colExpr('b'), colExpr('b'), map, columns)).to.equal(false);
		});
	});

	describe('sound controls (must keep working)', () => {
		it('declared-NOCASE PK covered by plain literal pins still proves ≤1 row', async () => {
			await db.exec('create table t5 (b text collate nocase, x integer, y integer, primary key (b, x)) using memory');
			const root = rootOf(db, "select * from t5 where b = 'bob' and x = 1");
			expect(isAtMostOneRow(root)).to.equal(true);
		});

		it('BINARY pins over a plain text PK still prove ≤1 row', async () => {
			await db.exec('create table t6 (b text, x integer, y integer, primary key (b, x)) using memory');
			const root = rootOf(db, "select * from t6 where b = 'bob' and x = 1");
			expect(isAtMostOneRow(root)).to.equal(true);
		});

		it('matching-collation guard discharge still works (plain pin on the guard column)', async () => {
			await db.exec('create table t11 (id integer primary key, x integer, b text) using memory');
			await db.exec("create unique index ui11 on t11 (x) where b = 'bob'");
			const q = "select x as gx, id from t11 where b = 'bob'";
			const root = rootOf(db, q);
			expect(keysOf(root).some(k => k.length === 1 && k[0] === 0), 'in-scope discharge lost').to.equal(true);
		});
	});

	describe('pinned sound-by-accident invariants', () => {
		it('a collate-wrapped equality never becomes a seek that drops case-variants (unwrapCast is Cast-only)', async () => {
			await db.exec('create table t7 (b text primary key, y integer) using memory');
			await db.exec("insert into t7 values ('Bob',1), ('bob',2)");
			const rows = await collect(db, "select y from t7 where b = 'bob' collate nocase order by y");
			expect(rows.map(r => r.y)).to.deep.equal([1, 2]);
		});

		it('CollateNode is not injective (no key passthrough for collated projections)', async () => {
			const colExpr: AST.ColumnExpr = { type: 'column', name: 'b' } as AST.ColumnExpr;
			const colType = { typeClass: 'scalar' as const, logicalType: TEXT_TYPE, nullable: false, isReadOnly: true };
			const col = new ColumnReferenceNode(scope, colExpr, colType, 1001, 0);
			const collateExpr: AST.CollateExpr = { type: 'collate', expr: colExpr, collation: 'NOCASE' } as AST.CollateExpr;
			const node = new CollateNode(scope, collateExpr, col);
			expect(node.isInjectiveIn(1001).injective).to.equal(false);
		});

		it('a collated projection drops the source key (DISTINCT above it survives and dedups NOCASE)', async () => {
			await db.exec('create table t12 (b text primary key) using memory');
			await db.exec("insert into t12 values ('Bob'), ('bob')");
			const q = 'select distinct b collate nocase as bn from t12';
			const rows = await collect(db, q);
			// Output collation is NOCASE: the two case-variants are one distinct value.
			expect(rows.length).to.equal(1);
		});

		it('a collate-wrapped join side is not an equi-pair (no preserved-key over-claim)', async () => {
			await db.exec('create table j3 (a integer primary key, k text) using memory');
			await db.exec('create table j4 (d text primary key, z integer) using memory');
			await db.exec("insert into j3 values (1,'BOB')");
			await db.exec("insert into j4 values ('Bob',1), ('bob',2)");
			const q = 'select j3.a as a, j4.z as z from j3 join j4 on j3.k = j4.d collate nocase';
			const root = rootOf(db, q);
			const rows = await collect(db, q);
			expect(rows.length).to.equal(2); // NOCASE comparison matches both case-variants
			expect(keysOf(root).some(k => k.length === 1 && k[0] === 0), 'key {a} over-claimed with duplicated a').to.equal(false);
		});
	});

	describe('collation-asymmetric shapes', () => {
		it('asymmetric-collation join columns mint no key claims and match the canonical comparison', async () => {
			await db.exec('create table j1 (a integer primary key, k text collate nocase) using memory');
			await db.exec('create table j2 (d text primary key, z integer) using memory');
			await db.exec("insert into j1 values (1,'BOB')");
			await db.exec("insert into j2 values ('Bob',1), ('bob',2)");
			const q = 'select j1.a as a, j2.z as z from j1 join j2 on j1.k = j2.d';
			const root = rootOf(db, q);
			const joinRows = await collect(db, q);
			// The same comparison spelled as a WHERE filter is the canonical
			// semantics (emitComparisonOp, symmetric provenance-lattice
			// resolution); the join must agree with it regardless of physical
			// algorithm.
			const filterRows = await collect(db, 'select j1.a as a, j2.z as z from j1 cross join j2 where j1.k = j2.d');
			expect(joinRows.length).to.equal(filterRows.length);
			// And no preserved-key over-claim either way.
			for (const key of keysOf(root)) {
				const seen = new Set<string>();
				for (const row of joinRows) {
					const sig = JSON.stringify(key.map(i => Object.values(row)[i]));
					expect(seen.has(sig), `key [${key}] not unique on join output`).to.equal(false);
					seen.add(sig);
				}
			}
		});

		it('USING over asymmetric declared collations mints no key claims (pair is hash-joinable but not value-discriminating)', async () => {
			await db.exec('create table j7 (a integer primary key, k text collate nocase) using memory');
			await db.exec('create table j8 (k text primary key, z integer) using memory');
			await db.exec("insert into j7 values (1,'BOB')");
			await db.exec("insert into j8 values ('Bob',1), ('bob',2)");
			// extractEquiPairsFromUsing now ADMITS the mismatched pair (tagged
			// collationsMatch=false / valueDiscriminating=false), so a hash join may
			// fire — but whichever algorithm runs, the pair mints no key coverage,
			// and the comparison resolves through the provenance lattice (declared
			// NOCASE beats the right side's defaulted BINARY), matching BOTH right
			// case-variants — duplicated `a` on the output.
			const q = 'select j7.a as a, j8.z as z from j7 join j8 using (k)';
			const root = rootOf(db, q);
			const rows = await collect(db, q);
			expect(rows.length).to.equal(2);
			expect(keysOf(root).some(k => k.length === 1 && k[0] === 0), 'key {a} over-claimed with duplicated a').to.equal(false);
		});

		it('a matched-NOCASE physical hash/merge join publishes no cross-side equivalence or determination FDs', async () => {
			// The physical join nodes must apply the same value-discrimination gate
			// the logical JoinNode's extractEquiPairsFromCondition applies: a NOCASE
			// pair matches rows like 'Bob'/'bob' that are NOT value-equal, so no
			// equivalence class or per-pair determination FD may couple the sides.
			// (Composite key FDs spanning both sides are fine — they claim
			// row-uniqueness of the combined key, not value equality of the pair.)
			await db.exec('create table m1 (a integer primary key, k text collate nocase) using memory');
			await db.exec('create table m2 (d text collate nocase primary key, z integer) using memory');
			await db.exec("insert into m1 values (1,'BOB'), (2,'bob'), (3,'x'), (4,'zz')");
			await db.exec("insert into m2 values ('Bob',1), ('X',2), ('Y',3)");
			const q = 'select m1.a as a, m2.z as z from m1 join m2 on m1.k = m2.d';
			const root = rootOf(db, q);

			const findPhysicalJoin = (node: PlanNode): PlanNode | undefined => {
				if (node.nodeType === PlanNodeType.HashJoin || node.nodeType === PlanNodeType.MergeJoin) return node;
				for (const child of node.getChildren()) {
					const found = findPhysicalJoin(child);
					if (found) return found;
				}
				return undefined;
			};
			const join = findPhysicalJoin(root as unknown as PlanNode);
			expect(join, 'expected a physical hash/merge join for the matched-NOCASE equi-join').to.exist;

			const leftCols = (join as unknown as { left: RelationalPlanNode }).left.getAttributes().length;
			const phys = (join as unknown as {
				physical?: {
					equivClasses?: ReadonlyArray<ReadonlyArray<number>>;
					fds?: ReadonlyArray<{ determinants: ReadonlyArray<number>; dependents: ReadonlyArray<number>; kind?: string }>;
				};
			}).physical;
			const crossSide = (indices: ReadonlyArray<number>) =>
				indices.some(i => i < leftCols) && indices.some(i => i >= leftCols);
			for (const ec of phys?.equivClasses ?? []) {
				expect(crossSide(ec), `equivalence class [${ec}] couples the two sides of a NOCASE join`).to.equal(false);
			}
			for (const fd of phys?.fds ?? []) {
				if (fd.kind !== 'determination') continue;
				expect(crossSide([...fd.determinants, ...fd.dependents]),
					`determination FD [${fd.determinants}]→[${fd.dependents}] couples the two sides of a NOCASE join`).to.equal(false);
			}

			// Behavior control: the join itself still matches case-insensitively.
			const rows = await collect(db, q + ' order by a');
			expect(rows).to.deep.equal([{ a: 1, z: 1 }, { a: 2, z: 1 }, { a: 3, z: 2 }]);
		});

		it('matched-collation (NOCASE=NOCASE) joins still match case-insensitively', async () => {
			await db.exec('create table j5 (a integer primary key, k text collate nocase) using memory');
			await db.exec('create table j6 (d text collate nocase primary key, z integer) using memory');
			await db.exec("insert into j5 values (1,'BOB')");
			await db.exec("insert into j6 values ('Bob',1)");
			const rows = await collect(db, 'select j5.a as a, j6.z as z from j5 join j6 on j5.k = j6.d');
			expect(rows).to.deep.equal([{ a: 1, z: 1 }]);
		});

		it('a unique index with a finer collation than the declared column is not promoted to a key', async () => {
			await db.exec('create table t9 (id integer primary key, b text collate nocase) using memory');
			await db.exec('create unique index uib on t9 (b collate binary)');
			// The BINARY-enforced index admits both case-variants…
			await db.exec("insert into t9 values (1,'Bob')");
			await db.exec("insert into t9 values (2,'bob')");
			// …which are ONE value under the NOCASE output collation, so {b} must
			// not be claimed as a key (a claimed key would eliminate the DISTINCT).
			const q = 'select distinct b from t9';
			const rows = await collect(db, q);
			expect(rows.length).to.equal(1);
			const scanRoot = rootOf(db, 'select b, id from t9');
			expect(keysOf(scanRoot).some(k => k.length === 1 && k[0] === 0), 'finer-enforced unique index promoted to key {b}').to.equal(false);
		});

		it('a matching-collation unique index is still promoted', async () => {
			await db.exec('create table t13 (id integer primary key, b text collate nocase not null) using memory');
			await db.exec('create unique index uib13 on t13 (b)');
			const root = rootOf(db, 'select b, id from t13');
			expect(keysOf(root).some(k => k.length === 1 && k[0] === 0), 'declared-collation unique index lost').to.equal(true);
		});
	});

	describe('CHECK extraction value-discrimination gate (check-extraction-collation-blind-fds)', () => {
		it('R1: collate-wrapped CHECK body mints no value FDs (no false ≤1-row / empty-key claim)', async () => {
			await db.exec('create table r1 (id integer primary key, b text unique, c text, check (b = c collate nocase)) using memory');
			await db.exec("insert into r1 values (1,'x','X'), (2,'X','X')");
			const q = "select * from r1 where c = 'X'";
			const root = rootOf(db, q);
			const rows = await collect(db, q);
			expect(rows.length).to.equal(2);
			expect(isAtMostOneRow(root), 'false ≤1-row claim').to.equal(false);
			expect(keysOf(root).some(k => k.length === 0), 'empty key claimed').to.equal(false);
		});

		it('R3: guarded twin (implication-form CHECK with wrapped body) mints no guarded value FDs', async () => {
			await db.exec("create table r3 (id integer primary key, status text, b text unique, c text, check (status <> 'active' or b = c collate nocase)) using memory");
			await db.exec("insert into r3 values (1,'active','x','X'), (2,'active','X','X')");
			const q = "select * from r3 where status = 'active' and c = 'X'";
			const root = rootOf(db, q);
			const rows = await collect(db, q);
			expect(rows.length).to.equal(2);
			expect(isAtMostOneRow(root), 'false ≤1-row claim').to.equal(false);
			expect(keysOf(root).some(k => k.length === 0), 'empty key claimed').to.equal(false);
		});

		it('R6: guard disjuncts are enforced under the declared collation (NOCASE guard catches case-variant rows)', async () => {
			await db.exec("create table g2 (id integer primary key, status text collate nocase, b text unique, c text, check (status <> 'active' or b = c)) using memory");
			// 'ACTIVE' is NOCASE-equal to 'active': the guard disjunct is FALSE, so
			// the body must hold — 'p' = 'X' fails. Pre-fix the BINARY guard
			// evaluation let this row through, breaking the discharge gate's
			// guard-scope assumption (the original false ≤1-row repro).
			let rejected = false;
			try {
				await db.exec("insert into g2 values (1,'ACTIVE','p','X')");
			} catch {
				rejected = true;
			}
			expect(rejected, 'NOCASE guard-scope row bypassed the CHECK body').to.equal(true);
		});

		it('R6 control: declared-NOCASE guard discharge works end-to-end where genuinely sound', async () => {
			await db.exec("create table g3 (id integer primary key, status text collate nocase, b text unique, c text, check (status <> 'active' or b = c)) using memory");
			await db.exec("insert into g3 values (1,'ACTIVE','p','p'), (2,'active','q','q'), (3,'done','r','X')");
			// Filter pins status='active' (effective NOCASE = declared, fact minted)
			// and c='p' (BINARY); discharge activates b=c, closure covers the unique
			// {b} — a TRUE ≤1-row claim.
			const q = "select * from g3 where status = 'active' and c = 'p'";
			const root = rootOf(db, q);
			const rows = await collect(db, q);
			expect(rows.length).to.equal(1);
			expect(isAtMostOneRow(root), 'sound guard discharge lost').to.equal(true);
		});

		it('assertion-hoist over a collate-wrapped comparison mints no value FDs', async () => {
			await db.exec('create table ah (id integer primary key, b text unique, c text) using memory');
			await db.exec('create assertion ah_chk check (not exists (select 1 from ah where not (b = c collate nocase)))');
			await db.exec("insert into ah values (1,'x','X'), (2,'X','X')");
			const q = "select * from ah where c = 'X'";
			const root = rootOf(db, q);
			const rows = await collect(db, q);
			expect(rows.length).to.equal(2);
			expect(isAtMostOneRow(root), 'false ≤1-row claim from hoisted assertion').to.equal(false);
			expect(keysOf(root).some(k => k.length === 0), 'empty key claimed').to.equal(false);
		});

		it('control: BINARY text columns keep CHECK-derived equality facts', async () => {
			await db.exec('create table sc1 (id integer primary key, b text unique, c text, check (b = c)) using memory');
			const root = rootOf(db, "select * from sc1 where c = 'x'");
			// Pin c (BINARY) → EC/FD adds b → unique {b} covered → ≤1 row.
			expect(isAtMostOneRow(root), 'sound CHECK FD lost').to.equal(true);
		});

		it('control: NOCASE-declared columns in the CHECK suppress the ≤1-row claim', async () => {
			await db.exec('create table sc2 (id integer primary key, b text unique, c text collate nocase, check (b = c)) using memory');
			// Post-enforcement-fix the CHECK comparison is NOCASE (c's declared
			// NOCASE outranks b's defaulted BINARY): 'x'/'X' pairs satisfy it
			// while b stays BINARY-distinct, so no value FD may be minted.
			await db.exec("insert into sc2 values (1,'x','X'), (2,'X','X')");
			const q = "select * from sc2 where b = c";
			const rows = await collect(db, q);
			expect(rows.length).to.equal(2);
			const root = rootOf(db, "select * from sc2 where c = 'X'");
			expect(isAtMostOneRow(root), 'false ≤1-row claim').to.equal(false);
		});
	});

	describe('OR→IN / OR_RANGE collapse collation gate (or-equality-collapse-collation-blind)', () => {
		it('keyed under-match: NOCASE disjuncts over a BINARY-keyed column match all case-variants', async () => {
			await db.exec('create table t20 (b text primary key, y integer) using memory');
			await db.exec("insert into t20 values ('Bob',1),('bob',2),('X',3),('x',4)");
			const rows = await collect(db, "select y from t20 where b = 'bob' collate nocase or b = 'x' collate nocase order by y");
			expect(rows.map(r => r.y)).to.deep.equal([1, 2, 3, 4]);
		});

		it('non-keyed spelling: the *evaluated* OR predicate is not rewritten into a BINARY IN', async () => {
			await db.exec('create table t21 (id integer primary key, b text, y integer) using memory');
			await db.exec("insert into t21 values (1,'Bob',1),(2,'bob',2),(3,'X',3),(4,'x',4)");
			const rows = await collect(db, "select y from t21 where b = 'bob' collate nocase or b = 'x' collate nocase order by y");
			expect(rows.map(r => r.y)).to.deep.equal([1, 2, 3, 4]);
		});

		it('over-match: BINARY disjuncts over a NOCASE-declared key match neither case-variant', async () => {
			await db.exec('create table t22 (b text collate nocase primary key, y integer) using memory');
			await db.exec("insert into t22 values ('Bob',1),('X',3)");
			const rows = await collect(db, "select y from t22 where b = 'bob' collate binary or b = 'x' collate binary order by y");
			expect(rows).to.deep.equal([]);
		});

		it('matched control: plain disjuncts over a plain column keep collapsing (BINARY semantics)', async () => {
			await db.exec('create table t23 (b text primary key, y integer) using memory');
			await db.exec("insert into t23 values ('Bob',1),('bob',2),('X',3),('x',4)");
			const rows = await collect(db, "select y from t23 where b = 'bob' or b = 'x' order by y");
			expect(rows.map(r => r.y)).to.deep.equal([2, 4]);
		});

		it('matched control: plain disjuncts over a NOCASE-declared column match case-insensitively', async () => {
			await db.exec('create table t24 (b text collate nocase primary key, y integer) using memory');
			await db.exec("insert into t24 values ('Bob',1),('X',3)");
			const rows = await collect(db, "select y from t24 where b = 'bob' or b = 'x' order by y");
			expect(rows.map(r => r.y)).to.deep.equal([1, 3]);
		});

		it('matched control: a single NOCASE disjunct still matches both case-variants', async () => {
			await db.exec('create table t25 (b text primary key, y integer) using memory');
			await db.exec("insert into t25 values ('Bob',1),('bob',2)");
			const rows = await collect(db, "select y from t25 where b = 'bob' collate nocase order by y");
			expect(rows.map(r => r.y)).to.deep.equal([1, 2]);
		});

		it('OR_RANGE shape: NOCASE equality + range disjunct keeps per-disjunct semantics', async () => {
			// Passes at HEAD only because no seek consumes the OR_RANGE constraint
			// and the residual OR still evaluates; pins that the gate (which now
			// keeps the OR residual at the source) does not change the result and
			// that no future seek consumption can.
			await db.exec('create table t26 (id integer primary key, b text, y integer) using memory');
			await db.exec("insert into t26 values (1,'Bob',1),(2,'bob',2),(3,'zz',3)");
			const rows = await collect(db, "select y from t26 where b = 'bob' collate nocase or b > 'z' order by y");
			expect(rows.map(r => r.y)).to.deep.equal([1, 2, 3]);
		});
	});

	describe('extractEqualityFds collation gate (unit)', () => {
		function colRef(attrId: number, index: number, opts: { textual?: boolean; collation?: string } = {}): ColumnReferenceNode {
			const expr: AST.ColumnExpr = { type: 'column', name: `c${attrId}` } as AST.ColumnExpr;
			const type = {
				typeClass: 'scalar' as const,
				logicalType: opts.textual === false ? INTEGER_TYPE : TEXT_TYPE,
				collationName: opts.collation,
				nullable: false,
				isReadOnly: false,
			};
			return new ColumnReferenceNode(scope, expr, type, attrId, index);
		}

		function lit(value: unknown): LiteralNode {
			return new LiteralNode(scope, { type: 'literal', value } as AST.LiteralExpr);
		}

		function eq(left: ScalarPlanNode, right: ScalarPlanNode): BinaryOpNode {
			const ast: AST.BinaryExpr = {
				type: 'binary', operator: '=',
				left: (left as unknown as { expression: AST.Expression }).expression,
				right: (right as unknown as { expression: AST.Expression }).expression,
			};
			return new BinaryOpNode(scope, ast, left, right);
		}

		function collate(operand: ScalarPlanNode, collation: string): CollateNode {
			const ast: AST.CollateExpr = {
				type: 'collate', collation,
				expr: (operand as unknown as { expression: AST.Expression }).expression,
			} as AST.CollateExpr;
			return new CollateNode(scope, ast, operand);
		}

		const attrMap = new Map([[1, 0], [2, 1]]);

		it('BINARY text pin extracts; NOCASE-declared pin does not', () => {
			const binary = extractEqualityFds(eq(colRef(1, 0, { collation: 'BINARY' }), lit('v')), attrMap);
			expect(binary.fds.length).to.equal(1);
			expect(binary.constantBindings.length).to.equal(1);

			const nocase = extractEqualityFds(eq(colRef(1, 0, { collation: 'NOCASE' }), lit('v')), attrMap);
			expect(nocase.fds.length).to.equal(0);
			expect(nocase.constantBindings.length).to.equal(0);
		});

		it('collate-wrapped literal pin does not extract', () => {
			const res = extractEqualityFds(eq(colRef(1, 0, { collation: 'BINARY' }), collate(lit('v'), 'NOCASE')), attrMap);
			expect(res.fds.length).to.equal(0);
			expect(res.constantBindings.length).to.equal(0);
		});

		it('non-textual operands are unaffected by the gate', () => {
			const res = extractEqualityFds(eq(colRef(1, 0, { textual: false, collation: 'BINARY' }), lit(5)), attrMap);
			expect(res.fds.length).to.equal(1);
		});

		it('col=col with a non-BINARY side contributes no mirror FDs or EC pair', () => {
			const mixed = extractEqualityFds(
				eq(colRef(1, 0, { collation: 'NOCASE' }), colRef(2, 1, { collation: 'BINARY' })), attrMap);
			expect(mixed.fds.length).to.equal(0);
			expect(mixed.equivPairs.length).to.equal(0);

			const both = extractEqualityFds(
				eq(colRef(1, 0, { collation: 'BINARY' }), colRef(2, 1, { collation: 'BINARY' })), attrMap);
			expect(both.fds.length).to.equal(2);
			expect(both.equivPairs.length).to.equal(1);
		});
	});
});
