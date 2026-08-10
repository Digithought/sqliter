import { expect } from 'chai';
import { Database } from '../../src/core/database.js';
import { EmptyScope } from '../../src/planner/scopes/empty.js';
import { BinaryOpNode, LiteralNode, UnaryOpNode } from '../../src/planner/nodes/scalar.js';
import { ColumnReferenceNode } from '../../src/planner/nodes/reference.js';
import { combineJoinKeys, deriveProjectionColumnMap } from '../../src/planner/util/key-utils.js';
import type { ColRef } from '../../src/common/datatype.js';
import type { Attribute, ScalarPlanNode } from '../../src/planner/nodes/plan-node.js';
import type * as AST from '../../src/parser/ast.js';
import { INTEGER_TYPE, TEXT_TYPE } from '../../src/types/builtin-types.js';

describe('Key propagation and estimatedRows reduction', () => {
	let db: Database;

	beforeEach(() => {
		db = new Database();
	});

	afterEach(async () => {
		await db.close();
	});

	async function setup(): Promise<void> {
		await db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT) USING memory");
		await db.exec("INSERT INTO t VALUES (1,'a'),(2,'b'),(3,'c')");
	}

	it('Project preserves PK-based uniqueness', async () => {
		await setup();
		// Estimated rows should be 1 for full-PK equality seek
		const rows: Array<Record<string, unknown>> = [];
		for await (const r of db.eval(
			"SELECT count(*) AS c FROM query_plan('SELECT id FROM t WHERE id = 2') WHERE properties LIKE '%\"estimatedRows\":1%'"
		)) rows.push(r as Record<string, unknown>);
		expect(rows[0].c).to.be.greaterThan(0);
	});

	async function physicalFor(sql: string, op: string): Promise<{ fds?: Array<{ determinants: number[]; dependents: number[] }>; estimatedRows?: number } | undefined> {
		const rows: Array<{ op: string; physical: string | null }> = [];
		for await (const r of db.eval('SELECT op, physical FROM query_plan(?)', [sql])) {
			rows.push(r as unknown as { op: string; physical: string | null });
		}
		const row = rows.find(r => r.op === op);
		if (!row?.physical) return undefined;
		return JSON.parse(row.physical);
	}

	/**
	 * The relation has at least one declared key. After the uniqueKeys collapse
	 * the canonical signal is an FD whose determinant set is a strict subset of
	 * all columns and whose closure covers them — i.e. some `key → other-cols`
	 * FD. This helper does the closure-free structural check, which is what the
	 * producers above emit directly.
	 */
	function hasKeyFd(fds: Array<{ determinants: number[]; dependents: number[] }> | undefined, totalCols: number): boolean {
		if (!fds) return false;
		return fds.some(fd => fd.determinants.length < totalCols && fd.determinants.length + fd.dependents.length >= totalCols);
	}

	it('Join combines keys for inner join (conservative)', async () => {
		await setup();
		await db.exec("CREATE TABLE u (uid INTEGER PRIMARY KEY, t_id INTEGER) USING memory");
		await db.exec("INSERT INTO u VALUES (10,1),(11,2)");
		// Each side has a PK, and an inner join unions both sides' keys when
		// covered. The physical join should carry at least one key-encoding FD.
		const phys = (await physicalFor('SELECT * FROM t INNER JOIN u ON t.id = u.t_id', 'HASHJOIN'))
			?? (await physicalFor('SELECT * FROM t INNER JOIN u ON t.id = u.t_id', 'JOIN'));
		expect(phys, 'expected join physical').to.not.equal(undefined);
		expect(hasKeyFd(phys!.fds, 4), 'expected a key-encoding FD').to.equal(true);
	});

	it('Composite PK join preserves left keys when right PK covered', async () => {
		await db.exec("CREATE TABLE p (a INTEGER, b INTEGER, PRIMARY KEY (a,b)) USING memory");
		await db.exec("INSERT INTO p VALUES (1,10),(2,20)");
		await db.exec("CREATE TABLE c (x INTEGER, y INTEGER) USING memory");
		await db.exec("INSERT INTO c VALUES (1,10),(1,99),(2,20)");
		const sql = 'SELECT * FROM c INNER JOIN p ON c.x = p.a AND c.y = p.b';
		const phys = (await physicalFor(sql, 'HASHJOIN'))
			?? (await physicalFor(sql, 'MERGEJOIN'))
			?? (await physicalFor(sql, 'JOIN'));
		expect(phys, 'expected join physical').to.not.equal(undefined);
		// The 4-col output should carry at least one key-encoding FD (p's PK survives).
		expect(hasKeyFd(phys!.fds, 4)).to.equal(true);
	});

	it('GROUP BY declares group key', async () => {
		await db.exec("CREATE TABLE g (id INTEGER, v INTEGER) USING memory");
		await db.exec("INSERT INTO g VALUES (1,1),(1,2),(2,3)");
		// The aggregate's GROUP BY columns are the key on its output. Encoded as
		// the FD `{0} → {1}` (group col → aggregate col).
		const phys =
			(await physicalFor('SELECT id, COUNT(*) FROM g GROUP BY id', 'STREAMAGGREGATE'))
			?? (await physicalFor('SELECT id, COUNT(*) FROM g GROUP BY id', 'HASHAGGREGATE'))
			?? (await physicalFor('SELECT id, COUNT(*) FROM g GROUP BY id', 'AGGREGATE'));
		expect(phys, 'expected aggregate physical').to.not.equal(undefined);
		expect(phys!.fds, 'expected fds').to.be.an('array');
		expect(phys!.fds!.some(fd => fd.determinants.length === 1 && fd.determinants[0] === 0 && fd.dependents.includes(1))).to.equal(true);
	});

	it('Physical hash join node propagates left PK when right PK covered', async () => {
		await setup();
		await db.exec("CREATE TABLE u2 (uid INTEGER PRIMARY KEY, t_id INTEGER) USING memory");
		await db.exec("INSERT INTO u2 VALUES (10,1),(11,2),(12,3)");
		// When joining u2.t_id = t.id, t.id is a PK so right key is covered. The
		// left's PK (u2.uid, output col 0) survives as a key-encoding FD.
		const sql = 'SELECT * FROM u2 INNER JOIN t ON u2.t_id = t.id';
		const phys = (await physicalFor(sql, 'HASHJOIN'))
			?? (await physicalFor(sql, 'MERGEJOIN'))
			?? (await physicalFor(sql, 'JOIN'));
		expect(phys, 'expected join physical').to.not.equal(undefined);
		expect(hasKeyFd(phys!.fds, 4)).to.equal(true);
	});

	it('Unique constraint columns create additional keys in RelationType', async () => {
		await db.exec("CREATE TABLE uc (id INTEGER PRIMARY KEY, email TEXT UNIQUE, name TEXT) USING memory");
		await db.exec("INSERT INTO uc VALUES (1,'a@b.c','alice'),(2,'d@e.f','bob')");
		// Join on unique column should preserve keys
		await db.exec("CREATE TABLE refs (r_email TEXT) USING memory");
		await db.exec("INSERT INTO refs VALUES ('a@b.c'),('d@e.f')");
		const phys = (await physicalFor('SELECT * FROM refs INNER JOIN uc ON refs.r_email = uc.email', 'HASHJOIN'))
			?? (await physicalFor('SELECT * FROM refs INNER JOIN uc ON refs.r_email = uc.email', 'JOIN'));
		expect(phys, 'expected join physical').to.not.equal(undefined);
		// refs has no key but uc has two (PK on id, UNIQUE on email). The unique
		// email is covered by the equi-pair so the left (refs) keys would survive
		// — but refs has no key. The join should still carry at least one FD.
		expect(phys!.fds, 'expected fds').to.be.an('array');
	});

	it('DISTINCT elimination when source has unique keys', async () => {
		await setup();
		// SELECT DISTINCT id FROM t — id is the PK so DISTINCT is redundant
		const rows: Array<Record<string, unknown>> = [];
		for await (const r of db.eval("SELECT json_group_array(node_type) AS types FROM query_plan('SELECT DISTINCT id FROM t')")) rows.push(r as Record<string, unknown>);
		const types = String(rows[0].types as unknown as string);
		// Distinct node should be eliminated — should NOT appear in plan
		expect(types).to.not.include('Distinct');
	});

	describe('Keyed product (cross/inner) composite key', () => {
		type Fd = { determinants: number[]; dependents: number[] };

		async function joinPhysicalAny(sql: string): Promise<{ fds?: Fd[] } | undefined> {
			const rows: Array<{ op: string; physical: string | null }> = [];
			for await (const r of db.eval('SELECT op, physical FROM query_plan(?)', [sql])) {
				rows.push(r as unknown as { op: string; physical: string | null });
			}
			const row = rows.find(r => r.op.includes('JOIN'));
			if (!row?.physical) return undefined;
			return JSON.parse(row.physical);
		}

		/** True iff some FD encodes a key (determinant a strict subset whose closure spans all cols). */
		function hasKeyFd(fds: Fd[] | undefined, totalCols: number): boolean {
			if (!fds) return false;
			return fds.some(fd => fd.determinants.length < totalCols && fd.determinants.length + fd.dependents.length >= totalCols);
		}

		async function nodeTypesOf(sql: string): Promise<string> {
			const rows: Array<Record<string, unknown>> = [];
			for await (const r of db.eval('SELECT json_group_array(node_type) AS types FROM query_plan(?)', [sql])) {
				rows.push(r as Record<string, unknown>);
			}
			return String(rows[0].types as unknown as string);
		}

		it('CROSS JOIN of two keyed tables carries a composite key-encoding FD', async () => {
			await db.exec("CREATE TABLE a (aid INTEGER PRIMARY KEY, av TEXT) USING memory");
			await db.exec("INSERT INTO a VALUES (1,'x'),(2,'y')");
			await db.exec("CREATE TABLE b (bid INTEGER PRIMARY KEY, bv TEXT) USING memory");
			await db.exec("INSERT INTO b VALUES (10,'p'),(20,'q')");
			// Neither side covered (no predicate), both keyed ⇒ the product is keyed
			// by the composite (a.aid ∪ b.bid). On the 4-col output that is a key FD
			// whose determinant is a strict subset of all columns, spanning both sides.
			const phys = await joinPhysicalAny('SELECT * FROM a CROSS JOIN b');
			expect(phys, 'expected join physical').to.not.equal(undefined);
			expect(hasKeyFd(phys!.fds, 4), 'expected composite key-encoding FD').to.equal(true);
		});

		it('DISTINCT eliminated over a keyed CROSS JOIN (composite key ⇒ already a set)', async () => {
			await db.exec("CREATE TABLE a (aid INTEGER PRIMARY KEY, av TEXT) USING memory");
			await db.exec("INSERT INTO a VALUES (1,'x'),(2,'y')");
			await db.exec("CREATE TABLE b (bid INTEGER PRIMARY KEY, bv TEXT) USING memory");
			await db.exec("INSERT INTO b VALUES (10,'p'),(20,'q')");
			const types = await nodeTypesOf('SELECT DISTINCT * FROM a CROSS JOIN b');
			expect(types, 'DISTINCT over a keyed cross product must be eliminated').to.not.include('Distinct');
		});

		it('DISTINCT retained over a CROSS JOIN with a keyless (bag) side (negative control)', async () => {
			await db.exec("CREATE TABLE a (aid INTEGER PRIMARY KEY, av TEXT) USING memory");
			await db.exec("INSERT INTO a VALUES (1,'x'),(2,'y')");
			// A base table always carries an implicit (all-columns) key, so to get a
			// genuinely keyless side we project away the PK over a column that repeats:
			// `(SELECT bv FROM bk)` is a bag (bv = 'p' twice). The product can then
			// contain duplicate full rows, so it is NOT a set and DISTINCT must remain.
			await db.exec("CREATE TABLE bk (bid INTEGER PRIMARY KEY, bv TEXT) USING memory");
			await db.exec("INSERT INTO bk VALUES (1,'p'),(2,'p')");
			const types = await nodeTypesOf('SELECT DISTINCT * FROM a CROSS JOIN (SELECT bv FROM bk) bag');
			expect(types, 'DISTINCT over a product with a keyless (bag) side must be retained').to.include('Distinct');
		});
	});

	describe('Outer-join key propagation', () => {
		interface PlanRow { op: string; node_type: string; properties: string | null; physical: string | null; est_rows: number | null }

		async function planRows(sql: string): Promise<PlanRow[]> {
			const rows: PlanRow[] = [];
			for await (const r of db.eval('SELECT node_type, op, properties, physical, est_rows FROM query_plan(?)', [sql])) {
				rows.push(r as unknown as PlanRow);
			}
			return rows;
		}

		function joinPhysical(rows: readonly PlanRow[]): { fds?: Array<{ determinants: number[]; dependents: number[] }>; estimatedRows?: number } | undefined {
			const row = rows.find(r => r.op === 'HASHJOIN' || r.op === 'MERGEJOIN' || r.op === 'JOIN');
			if (!row?.physical) return undefined;
			return JSON.parse(row.physical);
		}

		/** True iff some FD encodes a key on column index `col` (i.e. `{col} → ...`). */
		function fdsHaveSingleColKey(fds: Array<{ determinants: number[]; dependents: number[] }> | undefined, col: number): boolean {
			if (!fds) return false;
			return fds.some(fd => fd.determinants.length === 1 && fd.determinants[0] === col);
		}

		/** True iff the FD set encodes any non-trivial key on a relation with `totalCols` columns. */
		function fdsHaveAnyKey(fds: Array<{ determinants: number[]; dependents: number[] }> | undefined, totalCols: number): boolean {
			if (!fds) return false;
			return fds.some(fd => fd.determinants.length < totalCols && fd.determinants.length + fd.dependents.length >= totalCols);
		}

		it('LEFT JOIN preserves left PK when right PK covered', async () => {
			await db.exec('CREATE TABLE lp (id INTEGER PRIMARY KEY, v INTEGER) USING memory');
			await db.exec('CREATE TABLE lq (tid INTEGER PRIMARY KEY, w INTEGER) USING memory');
			const rows = await planRows('SELECT * FROM lp LEFT JOIN lq ON lp.id = lq.tid');
			const phys = joinPhysical(rows);
			expect(phys, 'expected join physical props').to.not.equal(undefined);
			// Left PK on column 0 should survive (encoded as the FD `{0} → others`).
			expect(fdsHaveSingleColKey(phys!.fds, 0), 'expected `{0} → others` FD encoding left PK').to.equal(true);
		});

		it('LEFT JOIN drops keys when right PK not covered', async () => {
			await db.exec('CREATE TABLE lr (id INTEGER PRIMARY KEY, v INTEGER) USING memory');
			await db.exec('CREATE TABLE ls (sid INTEGER PRIMARY KEY, w INTEGER) USING memory');
			// Join on lr.v = ls.w: ls.w is not unique, so right key is NOT covered
			const rows = await planRows('SELECT * FROM lr LEFT JOIN ls ON lr.v = ls.w');
			const phys = joinPhysical(rows);
			expect(phys, 'expected join physical props').to.not.equal(undefined);
			// No key-encoding FD should be present at the join output: the left PK
			// doesn't survive because the right key wasn't covered.
			expect(fdsHaveAnyKey(phys!.fds, 4), 'no key-encoding FD should propagate').to.equal(false);
		});

		it('LEFT JOIN with right PK covered: estimatedRows is bounded by left cardinality', async () => {
			// When right key is covered, each left row matches ≤ 1 right row, so
			// the join's estimated rows must not exceed left's estimated rows.
			await db.exec('CREATE TABLE lc (id INTEGER PRIMARY KEY, v INTEGER) USING memory');
			await db.exec("INSERT INTO lc VALUES (1, 10), (2, 20), (3, 30), (4, 40)");
			await db.exec('CREATE TABLE ld (did INTEGER PRIMARY KEY, w INTEGER) USING memory');
			await db.exec("INSERT INTO ld VALUES (1, 100), (2, 200)");
			const rows = await planRows('SELECT * FROM lc LEFT JOIN ld ON lc.id = ld.did');
			const joinRow = rows.find(r => r.op === 'HASHJOIN' || r.op === 'MERGEJOIN' || r.op === 'JOIN');
			expect(joinRow, 'expected join row').to.not.equal(undefined);
			const phys = joinRow!.physical ? JSON.parse(joinRow!.physical) as { estimatedRows?: number } : {};
			// If estimatedRows is set, it must not exceed lc's est_rows in the plan.
			if (phys.estimatedRows !== undefined) {
				const leftScanRow = rows.find(r =>
					r.op === 'TABLEREFERENCE' && (r.properties?.includes('"table":"lc"') ?? false),
				) ?? rows.find(r => r.op === 'TABLEREFERENCE');
				const leftRows = leftScanRow?.est_rows ?? undefined;
				if (typeof leftRows === 'number') {
					expect(phys.estimatedRows).to.be.at.most(leftRows);
				}
			}
		});

		it('DISTINCT eliminated above LEFT JOIN when right PK is covered', async () => {
			await db.exec('CREATE TABLE dl (id INTEGER PRIMARY KEY, v INTEGER) USING memory');
			await db.exec('CREATE TABLE dr (rid INTEGER PRIMARY KEY, w INTEGER) USING memory');
			const rows = await planRows('SELECT DISTINCT dl.id FROM dl LEFT JOIN dr ON dl.id = dr.rid');
			// DISTINCT should be eliminated because the LEFT JOIN preserves dl's PK
			expect(rows.some(r => r.op === 'DISTINCT')).to.equal(false);
		});

		it('FULL OUTER JOIN drops both sides keys (combineJoinKeys)', () => {
			const leftKeys: ColRef[][] = [[{ index: 0 }]];
			const rightKeys: ColRef[][] = [[{ index: 0 }]];
			const out = combineJoinKeys(leftKeys, rightKeys, 'full', 2, [{ left: 0, right: 0 }]);
			expect(out).to.deep.equal([]);
		});

		describe('combineJoinKeys unit tests', () => {
			function indices(out: ColRef[][]): number[][] {
				return out.map(k => k.map(c => c.index));
			}

			it('LEFT + equiPairs covering right key → returns left keys', () => {
				const leftKeys: ColRef[][] = [[{ index: 0 }]];
				const rightKeys: ColRef[][] = [[{ index: 0 }]];
				const out = combineJoinKeys(leftKeys, rightKeys, 'left', 2, [{ left: 0, right: 0 }]);
				expect(indices(out)).to.deep.equal([[0]]);
			});

			it('LEFT + equiPairs NOT covering right key → returns []', () => {
				const leftKeys: ColRef[][] = [[{ index: 0 }]];
				// right's key is on column 0, but the pair binds right column 1
				const rightKeys: ColRef[][] = [[{ index: 0 }]];
				const out = combineJoinKeys(leftKeys, rightKeys, 'left', 2, [{ left: 0, right: 1 }]);
				expect(out).to.deep.equal([]);
			});

			it('LEFT without equiPairs → returns [] (back-compat)', () => {
				const leftKeys: ColRef[][] = [[{ index: 0 }]];
				const rightKeys: ColRef[][] = [[{ index: 0 }]];
				const out = combineJoinKeys(leftKeys, rightKeys, 'left', 2);
				expect(out).to.deep.equal([]);
			});

			it('RIGHT + equiPairs covering left key → returns right keys shifted', () => {
				const leftKeys: ColRef[][] = [[{ index: 0 }]];
				const rightKeys: ColRef[][] = [[{ index: 0 }]];
				const out = combineJoinKeys(leftKeys, rightKeys, 'right', 2, [{ left: 0, right: 0 }]);
				expect(indices(out)).to.deep.equal([[2]]);
			});

			it('INNER key=key join (equi-pair covers both keys) → both sides survive', () => {
				const leftKeys: ColRef[][] = [[{ index: 0 }]];
				const rightKeys: ColRef[][] = [[{ index: 0 }]];
				// Equi-pair {0,0} covers both the left key {0} and the right key {0},
				// so each side matches ≤ 1 row on the other — both keys survive.
				const out = combineJoinKeys(leftKeys, rightKeys, 'inner', 2, [{ left: 0, right: 0 }]);
				expect(indices(out)).to.deep.equal([[0], [2]]);
			});

			it('INNER covering only ONE side → survivor key only, NO composite (gate)', () => {
				// Equi-pair {1,0} covers the RIGHT key {0} (so left's key survives) but
				// NOT the left key {0} (right's key does not survive). Exactly one side
				// is covered, so the product-key gate (`!leftSurvive && !rightSurvive`)
				// stays OFF — emitting a composite here would double-count the fan-out
				// the covered side already accounts for. Result is the survivor alone.
				const leftKeys: ColRef[][] = [[{ index: 0 }]];
				const rightKeys: ColRef[][] = [[{ index: 0 }]];
				const out = combineJoinKeys(leftKeys, rightKeys, 'inner', 2, [{ left: 1, right: 0 }]);
				expect(indices(out)).to.deep.equal([[0]]);
			});

			it('INNER without coverage (equi-pair on a non-key column) → composite product key', () => {
				// Equi-pair binds left col 1 = right col 1, neither of which is the
				// key (col 0). Neither side's key is covered, so neither survives on
				// its own — but the inner predicate only *removes* (leftRow, rightRow)
				// pairs (it never duplicates one), so the pair (leftKey, rightKey)
				// stays unique and the composite product key (left {0} ∪ right {0}
				// shifted by 2) is sound.
				const leftKeys: ColRef[][] = [[{ index: 0 }]];
				const rightKeys: ColRef[][] = [[{ index: 0 }]];
				const out = combineJoinKeys(leftKeys, rightKeys, 'inner', 2, [{ left: 1, right: 1 }]);
				expect(indices(out)).to.deep.equal([[0, 2]]);
			});

			it('CROSS join (no equi-pairs, both keyed) → composite product key [[0, leftColumnCount]]', () => {
				// A bare cross join covers neither side's key, but both sides are
				// keyed, so the product is keyed by the pair (leftKey, rightKey):
				// the lex-min from each side, with right shifted by leftColumnCount
				// (2). Full-row set-ness is *additionally* carried by RelationType.isSet.
				const leftKeys: ColRef[][] = [[{ index: 0 }]];
				const rightKeys: ColRef[][] = [[{ index: 0 }]];
				const out = combineJoinKeys(leftKeys, rightKeys, 'cross', 2);
				expect(indices(out)).to.deep.equal([[0, 2]]);
			});

			it('composite-PK left side, single-col right → picks the only keys, right shifted', () => {
				// left composite PK {0,1}, right PK {0}, cross, leftColumnCount=3 ⇒
				// the only key on each side is picked; right's col 0 shifts to 3.
				const leftKeys: ColRef[][] = [[{ index: 0 }, { index: 1 }]];
				const rightKeys: ColRef[][] = [[{ index: 0 }]];
				const out = combineJoinKeys(leftKeys, rightKeys, 'cross', 3);
				expect(indices(out)).to.deep.equal([[0, 1, 3]]);
			});

			it('lex-min tie-break: two single-col keys → lowest first-col index wins', () => {
				// left carries {1} and {0} (both length 1) ⇒ tie broken by lowest
				// first-column index ⇒ picks {0}; right {0} shifts to 2.
				const leftKeys: ColRef[][] = [[{ index: 1 }], [{ index: 0 }]];
				const rightKeys: ColRef[][] = [[{ index: 0 }]];
				const out = combineJoinKeys(leftKeys, rightKeys, 'cross', 2);
				expect(indices(out)).to.deep.equal([[0, 2]]);
			});

			it('lex-min picks the shorter key when lengths differ', () => {
				// left carries {0,1} and {2} ⇒ the shorter {2} is picked; right {0}
				// shifts to 3.
				const leftKeys: ColRef[][] = [[{ index: 0 }, { index: 1 }], [{ index: 2 }]];
				const rightKeys: ColRef[][] = [[{ index: 0 }]];
				const out = combineJoinKeys(leftKeys, rightKeys, 'cross', 3);
				expect(indices(out)).to.deep.equal([[2, 3]]);
			});

			it('≤1-row guard: empty key on one side → no product key (survivor branch fires)', () => {
				// right is ≤1-row (empty key), so left's key survives on its own and
				// NO composite product key is emitted — the result equals the existing
				// survivor-branch output ([[0]]), not a composite.
				const leftKeys: ColRef[][] = [[{ index: 0 }]];
				const rightKeys: ColRef[][] = [[]];
				const out = combineJoinKeys(leftKeys, rightKeys, 'cross', 2);
				expect(indices(out)).to.deep.equal([[0]]);
			});

			it('SEMI returns left keys unchanged', () => {
				const leftKeys: ColRef[][] = [[{ index: 0 }]];
				const out = combineJoinKeys(leftKeys, [], 'semi', 2, [{ left: 0, right: 0 }]);
				expect(indices(out)).to.deep.equal([[0]]);
			});

			it('FULL always returns []', () => {
				const leftKeys: ColRef[][] = [[{ index: 0 }]];
				const rightKeys: ColRef[][] = [[{ index: 0 }]];
				const out = combineJoinKeys(leftKeys, rightKeys, 'full', 2, [{ left: 0, right: 0 }]);
				expect(out).to.deep.equal([]);
			});

			describe('empty-key (≤1-row) coverage', () => {
				const emptyKey: ColRef[] = [];

				it('INNER with ≤1-row left (empty key) and no equiPairs → right keys survive (shifted)', () => {
					// left is ≤1-row, so it caps the right side at one matching row per
					// left row; right's key survives even without equi-pairs.
					const out = combineJoinKeys([emptyKey], [[{ index: 0 }]], 'inner', 1);
					expect(indices(out)).to.deep.equal([[1]]);
				});

				it('CROSS with ≤1-row right (empty key) and no equiPairs → left keys survive', () => {
					const out = combineJoinKeys([[{ index: 0 }]], [emptyKey], 'cross', 2);
					expect(indices(out)).to.deep.equal([[0]]);
				});

				it('INNER both ≤1-row → output advertises the empty key (deduped)', () => {
					const out = combineJoinKeys([emptyKey], [emptyKey], 'inner', 1);
					expect(indices(out)).to.deep.equal([[]]);
				});

				it('LEFT with ≤1-row right (empty key) and no equiPairs → left keys survive', () => {
					// The early-return-on-empty-equiPairs guard is gone: a ≤1-row right
					// covers regardless of equi-pairs.
					const out = combineJoinKeys([[{ index: 0 }]], [emptyKey], 'left', 2);
					expect(indices(out)).to.deep.equal([[0]]);
				});

				it('LEFT both ≤1-row → output advertises the empty key', () => {
					const out = combineJoinKeys([emptyKey], [emptyKey], 'left', 1);
					expect(indices(out)).to.deep.equal([[]]);
				});

				it('RIGHT with ≤1-row left (empty key) and no equiPairs → right keys survive (shifted)', () => {
					const out = combineJoinKeys([emptyKey], [[{ index: 0 }]], 'right', 2);
					expect(indices(out)).to.deep.equal([[2]]);
				});

				it('SEMI with ≤1-row left → empty key passes through', () => {
					const out = combineJoinKeys([emptyKey], [], 'semi', 1, [{ left: 0, right: 0 }]);
					expect(indices(out)).to.deep.equal([[]]);
				});

				it('FULL both ≤1-row → still [] (two non-matching ≤1-row sides → two rows)', () => {
					const out = combineJoinKeys([emptyKey], [emptyKey], 'full', 1, [{ left: 0, right: 0 }]);
					expect(out).to.deep.equal([]);
				});
			});
		});
	});

	describe('Empty-key (≤1-row) join coverage', () => {
		type Fd = { determinants: number[]; dependents: number[] };

		async function joinPhysicalAny(sql: string): Promise<{ fds?: Fd[]; estimatedRows?: number } | undefined> {
			const rows: Array<{ op: string; physical: string | null }> = [];
			for await (const r of db.eval('SELECT op, physical FROM query_plan(?)', [sql])) {
				rows.push(r as unknown as { op: string; physical: string | null });
			}
			const row = rows.find(r => r.op.includes('JOIN'));
			if (!row?.physical) return undefined;
			return JSON.parse(row.physical);
		}

		/** True iff some FD is the singleton `∅ → all_cols` (the ≤1-row marker). */
		function hasSingletonFd(fds: Fd[] | undefined, totalCols: number): boolean {
			if (!fds) return false;
			return fds.some(fd => fd.determinants.length === 0 && fd.dependents.length >= totalCols);
		}

		async function nodeTypesOf(sql: string): Promise<string> {
			const rows: Array<Record<string, unknown>> = [];
			for await (const r of db.eval('SELECT json_group_array(node_type) AS types FROM query_plan(?)', [sql])) {
				rows.push(r as Record<string, unknown>);
			}
			return String(rows[0].types as unknown as string);
		}

		it('CROSS JOIN with a ≤1-row scalar-aggregate side preserves the other side keys', async () => {
			await setup();
			// (select count(*) ...) is ≤1-row (scalar aggregate, no GROUP BY ⇒ ∅→all FD).
			// t's PK survives on the 3-col join output as a key-encoding FD.
			const phys = await joinPhysicalAny('SELECT * FROM t CROSS JOIN (SELECT count(*) AS c FROM t) agg');
			expect(phys, 'expected join physical').to.not.equal(undefined);
			expect(hasKeyFd(phys!.fds, 3), 't PK should survive as a key-encoding FD').to.equal(true);
		});

		it('CROSS JOIN with a PK-constant-bound ≤1-row side preserves the other side keys', async () => {
			await setup();
			await db.exec("CREATE TABLE w (wid INTEGER PRIMARY KEY, n TEXT) USING memory");
			await db.exec("INSERT INTO w VALUES (1,'x'),(2,'y')");
			// (select * from w where wid = 1) is ≤1-row (full-PK equality ⇒ ∅→all closure).
			const phys = await joinPhysicalAny('SELECT * FROM t CROSS JOIN (SELECT * FROM w WHERE wid = 1) s');
			expect(phys, 'expected join physical').to.not.equal(undefined);
			expect(hasKeyFd(phys!.fds, 4), 't PK should survive as a key-encoding FD').to.equal(true);
		});

		it('JOIN of two ≤1-row sides reports the empty key (singleton ∅→all FD)', async () => {
			await setup();
			const phys = await joinPhysicalAny(
				'SELECT * FROM (SELECT count(*) AS a FROM t) x CROSS JOIN (SELECT count(*) AS b FROM t) y',
			);
			expect(phys, 'expected join physical').to.not.equal(undefined);
			expect(hasSingletonFd(phys!.fds, 2), 'expected singleton ∅→all FD on a ≤1-row join').to.equal(true);
		});

		it('DISTINCT eliminated over a join of two ≤1-row sides', async () => {
			await setup();
			const types = await nodeTypesOf(
				'SELECT DISTINCT * FROM (SELECT count(*) AS a FROM t) x CROSS JOIN (SELECT count(*) AS b FROM t) y',
			);
			expect(types, 'DISTINCT over a ≤1-row join must be eliminated').to.not.include('Distinct');
		});

		it('DISTINCT-eliminated ≤1-row join returns the same rows as the un-eliminated query', async () => {
			// Behavioral soundness guard: eliminating DISTINCT (driven by the
			// empty-key/singleton-FD propagated onto the join) must not change the
			// result set. DISTINCT is a no-op over a ≤1-row source, so both queries
			// must agree row-for-row — and, since the scalar-agg-subquery `*`-naming
			// defect is fixed, both must expose the exact {a, b} shape.
			await setup();
			const distinctSql = 'SELECT DISTINCT * FROM (SELECT count(*) AS a FROM t) x CROSS JOIN (SELECT count(*) AS b FROM t) y';
			const plainSql = 'SELECT * FROM (SELECT count(*) AS a FROM t) x CROSS JOIN (SELECT count(*) AS b FROM t) y';
			const distinctRows: Array<Record<string, unknown>> = [];
			for await (const r of db.eval(distinctSql)) distinctRows.push(r as Record<string, unknown>);
			const plainRows: Array<Record<string, unknown>> = [];
			for await (const r of db.eval(plainSql)) plainRows.push(r as Record<string, unknown>);
			expect(distinctRows).to.deep.equal([{ a: 3, b: 3 }]);
			expect(distinctRows).to.deep.equal(plainRows);
		});

		it('LIMIT 1 emits the singleton ∅→all FD on the LIMITOFFSET physical', async () => {
			await setup();
			// t is (id, v) ⇒ 2 cols. A constant LIMIT 1 is provably ≤1-row.
			const phys = await physicalFor('SELECT * FROM t LIMIT 1', 'LIMITOFFSET');
			expect(phys, 'expected LIMITOFFSET physical').to.not.equal(undefined);
			expect(hasSingletonFd(phys!.fds, 2), 'expected singleton ∅→all FD for LIMIT 1').to.equal(true);
		});

		it('OFFSET k LIMIT 1 still emits the singleton (offset only removes rows)', async () => {
			await setup();
			const phys = await physicalFor('SELECT * FROM t LIMIT 1 OFFSET 1', 'LIMITOFFSET');
			expect(phys, 'expected LIMITOFFSET physical').to.not.equal(undefined);
			expect(hasSingletonFd(phys!.fds, 2), 'expected singleton ∅→all FD for LIMIT 1 OFFSET 1').to.equal(true);
		});

		it('DISTINCT eliminated when its source is a ≤1-row LIMIT', async () => {
			await setup();
			// `select v from t` drops the PK ⇒ a bag. Wrapping it in LIMIT 1 makes the
			// subquery ≤1-row, so the singleton ∅→all FD lets the outer DISTINCT drop.
			// The DISTINCT must sit *above* the LIMIT for the FD to drive elimination
			// (`select distinct * from t limit 1` puts Distinct *below* Limit, where the
			// FD is irrelevant — and there it's eliminated only because t has a PK).
			const withLimit = await nodeTypesOf('SELECT DISTINCT * FROM (SELECT v FROM t LIMIT 1) s');
			expect(withLimit, 'DISTINCT over a ≤1-row LIMIT subquery must be eliminated').to.not.include('Distinct');
			// Control: without the LIMIT the subquery is a bag, so DISTINCT must remain —
			// proving the singleton FD (not some unrelated rewrite) caused the drop above.
			const noLimit = await nodeTypesOf('SELECT DISTINCT * FROM (SELECT v FROM t) s');
			expect(noLimit, 'DISTINCT over a non-singleton bag must be retained').to.include('Distinct');
		});

		it('CROSS JOIN with a LIMIT 1 side preserves the other side keys', async () => {
			await setup();
			// (select * from t limit 1) is ≤1-row, so t's PK survives on the 4-col join.
			const phys = await joinPhysicalAny('SELECT * FROM t CROSS JOIN (SELECT * FROM t LIMIT 1) s');
			expect(phys, 'expected join physical').to.not.equal(undefined);
			expect(hasKeyFd(phys!.fds, 4), 't PK should survive as a key-encoding FD').to.equal(true);
		});

		it('parameterized LIMIT ? does NOT emit the singleton (not constant at plan time)', async () => {
			await setup();
			const phys = await physicalFor('SELECT * FROM t LIMIT ?', 'LIMITOFFSET');
			// A LIMITOFFSET node should exist but carry no ≤1-row singleton FD.
			if (phys !== undefined) {
				expect(hasSingletonFd(phys.fds, 2), 'parameterized LIMIT must not emit the singleton').to.equal(false);
			}
		});

		it('correlated LATERAL with LIMIT 1 is not commuted (singleton FD must not reorder a correlated right)', async () => {
			// The LIMIT 1 right side now advertises the ∅→all singleton FD, which marks
			// it as a ≤1-row "preferred driver" for join-greedy-commute. But it is
			// correlated against the left (t2.id = t.id), so commuting it to the outer
			// position would evaluate `t.id` before t is in scope. The commute rule must
			// skip correlated inputs; the query must still return one row per t row.
			await setup();
			const sql = 'SELECT t.id, x.v FROM t CROSS JOIN LATERAL (SELECT v FROM t t2 WHERE t2.id = t.id LIMIT 1) x ORDER BY t.id';
			const rows: Array<Record<string, unknown>> = [];
			for await (const r of db.eval(sql)) rows.push(r as Record<string, unknown>);
			expect(rows).to.deep.equal([
				{ id: 1, v: 'a' },
				{ id: 2, v: 'b' },
				{ id: 3, v: 'c' },
			]);
		});

		it('≤1-row CROSS JOIN preserving the other side keys returns correct rows', async () => {
			// The key-preserving plan from the scalar-aggregate case must still
			// emit one output row per t row (3), each carrying the aggregate value.
			await setup();
			const sql = 'SELECT t.id, t.v, agg.c FROM t CROSS JOIN (SELECT count(*) AS c FROM t) agg ORDER BY t.id';
			const rows: Array<Record<string, unknown>> = [];
			for await (const r of db.eval(sql)) rows.push(r as Record<string, unknown>);
			expect(rows).to.deep.equal([
				{ id: 1, v: 'a', c: 3 },
				{ id: 2, v: 'b', c: 3 },
				{ id: 3, v: 'c', c: 3 },
			]);
		});

		it('scalar-aggregate subquery cross join exposes both aggregate columns by name (SELECT *)', async () => {
			// Regression: physical aggregates once advertised extra source columns
			// they never emitted (the optimizer appended the source attribute list).
			// A scalar-aggregate subquery used as a join source (no Project to trim
			// it) then leaked the inner table's first column name (`id`) in place of
			// the second subquery's aggregate alias (`b`), yielding {a:3, id:3}.
			await setup();
			const rows: Array<Record<string, unknown>> = [];
			for await (const r of db.eval(
				'SELECT * FROM (SELECT count(*) AS a FROM t) x CROSS JOIN (SELECT count(*) AS b FROM t) y',
			)) rows.push(r as Record<string, unknown>);
			expect(rows).to.deep.equal([{ a: 3, b: 3 }]);
		});

		it('scalar-aggregate subquery cross join over different tables exposes both aliases', async () => {
			// Proves the fix is not `*`-expansion-only: an explicit `x.a, y.b` over
			// two different tables must resolve to the right aggregate columns/values.
			await setup();
			await db.exec("CREATE TABLE t2 (id INTEGER PRIMARY KEY, v TEXT) USING memory");
			await db.exec("INSERT INTO t2 VALUES (1,'a'),(2,'b')");
			const rows: Array<Record<string, unknown>> = [];
			for await (const r of db.eval(
				'SELECT x.a, y.b FROM (SELECT count(*) AS a FROM t) x CROSS JOIN (SELECT count(*) AS b FROM t2) y',
			)) rows.push(r as Record<string, unknown>);
			expect(rows).to.deep.equal([{ a: 3, b: 2 }]);
		});

		async function valuesPhysical(sql: string): Promise<{ fds?: Fd[]; estimatedRows?: number } | undefined> {
			const rows: Array<{ op: string; physical: string | null }> = [];
			for await (const r of db.eval('SELECT op, physical FROM query_plan(?)', [sql])) {
				rows.push(r as unknown as { op: string; physical: string | null });
			}
			const row = rows.find(r => r.op.toUpperCase().includes('VALUES'));
			if (!row?.physical) return undefined;
			return JSON.parse(row.physical);
		}

		// All-literal VALUES is const-folded to a TableLiteral before the physical
		// pass runs, so to actually exercise `ValuesNode.computePhysical` we need a
		// VALUES the const-folder cannot evaluate. Parameter references (`?`) are
		// non-const at plan time, so they keep the node as a `Values` in the
		// physical plan.

		it('single-row VALUES emits the singleton ∅→all FD on the Values physical', async () => {
			const phys = await valuesPhysical('SELECT * FROM (VALUES (?, ?)) AS v(a, b)');
			expect(phys, 'expected VALUES physical').to.not.equal(undefined);
			expect(hasSingletonFd(phys!.fds, 2), 'expected singleton ∅→all FD for single-row VALUES').to.equal(true);
		});

		it('multi-row VALUES does NOT emit the singleton FD', async () => {
			const phys = await valuesPhysical('SELECT * FROM (VALUES (?, ?), (?, ?)) AS v(a, b)');
			expect(phys, 'expected VALUES physical').to.not.equal(undefined);
			expect(hasSingletonFd(phys!.fds, 2), 'multi-row VALUES must not emit the singleton').to.equal(false);
		});

		it('ORDER BY whole-Sort eliminated over a single-row VALUES', async () => {
			const types = await nodeTypesOf('SELECT * FROM (VALUES (?, ?)) AS v(a, b) ORDER BY a');
			expect(types, 'whole-Sort must be eliminated over a single-row VALUES').to.not.include('Sort');
			// Negative control: 2-row VALUES still requires a Sort.
			const multiTypes = await nodeTypesOf('SELECT * FROM (VALUES (?, ?), (?, ?)) AS v(a, b) ORDER BY a');
			expect(multiTypes, 'multi-row VALUES must retain its Sort').to.include('Sort');
		});

		it('DISTINCT eliminated over a single-row VALUES', async () => {
			const types = await nodeTypesOf('SELECT DISTINCT * FROM (VALUES (?, ?)) AS v(a, b)');
			expect(types, 'DISTINCT must be eliminated over a single-row VALUES').to.not.include('Distinct');
			// Negative control: 2-row VALUES retains DISTINCT.
			const multiTypes = await nodeTypesOf('SELECT DISTINCT * FROM (VALUES (?, ?), (?, ?)) AS v(a, b)');
			expect(multiTypes, 'multi-row VALUES must retain DISTINCT').to.include('Distinct');
		});

		it('eliminated ORDER BY / DISTINCT over single-row VALUES still returns the right rows', async () => {
			// Behavioral soundness guard: dropping the Sort / Distinct (driven by the
			// singleton FD this ticket adds) must not change the result set. Column
			// names from `AS v(a, b)` are not always reflected when projecting `*`
			// over a parameterized VALUES, so compare row values rather than aliases.
			const valuesOf = (r: Record<string, unknown>) => Object.values(r);
			const orderRows: Array<Record<string, unknown>> = [];
			for await (const r of db.eval('SELECT * FROM (VALUES (?, ?)) AS v(a, b) ORDER BY a', [1, 2])) orderRows.push(r as Record<string, unknown>);
			expect(orderRows).to.have.length(1);
			expect(valuesOf(orderRows[0])).to.deep.equal([1, 2]);
			const distinctRows: Array<Record<string, unknown>> = [];
			for await (const r of db.eval('SELECT DISTINCT * FROM (VALUES (?, ?)) AS v(a, b)', [1, 2])) distinctRows.push(r as Record<string, unknown>);
			expect(distinctRows).to.have.length(1);
			expect(valuesOf(distinctRows[0])).to.deep.equal([1, 2]);
		});
	});

	describe('Projection isSet soundness', () => {
		async function nodeTypes(sql: string): Promise<string> {
			const rows: Array<Record<string, unknown>> = [];
			for await (const r of db.eval('SELECT json_group_array(node_type) AS types FROM query_plan(?)', [sql])) {
				rows.push(r as Record<string, unknown>);
			}
			return String(rows[0].types as unknown as string);
		}

		it('DISTINCT is NOT eliminated when a projection drops the key (bag output)', async () => {
			// dup_t has a PK `id` but `cat` repeats. `select cat` projects away the
			// key, so the projection is a bag — DISTINCT must survive, and must
			// actually deduplicate.
			await db.exec('CREATE TABLE dup_t (id INTEGER PRIMARY KEY, cat TEXT) USING memory');
			await db.exec("INSERT INTO dup_t VALUES (1,'a'),(2,'a'),(3,'b')");

			const types = await nodeTypes('SELECT DISTINCT cat FROM dup_t');
			expect(types, 'DISTINCT over a key-dropping projection must NOT be eliminated').to.include('Distinct');

			const cats: string[] = [];
			for await (const r of db.eval('SELECT cat FROM dup_t GROUP BY cat')) cats.push((r as { cat: string }).cat);
			const distinctCats: string[] = [];
			for await (const r of db.eval('SELECT DISTINCT cat FROM dup_t')) distinctCats.push((r as { cat: string }).cat);
			expect(distinctCats.sort()).to.deep.equal(cats.sort());
			expect(distinctCats).to.have.length(2);
		});

		it('outer DISTINCT eliminated over an inner DISTINCT (set preserved through all-column projection)', async () => {
			await db.exec('CREATE TABLE dd (id INTEGER PRIMARY KEY, x INTEGER, y INTEGER) USING memory');
			await db.exec('INSERT INTO dd VALUES (1,1,1),(2,1,1),(3,2,3)');
			// Inner `select distinct x, y` is a set on (x,y). The outer projection
			// keeps both columns, so the set survives and the outer DISTINCT is a
			// no-op — it should be eliminated.
			const types = await nodeTypes('SELECT DISTINCT x, y FROM (SELECT DISTINCT x, y FROM dd)');
			const distinctCount = (types.match(/Distinct/g) ?? []).length;
			expect(distinctCount, 'only the inner DISTINCT should remain').to.equal(1);
		});
	});

	describe('Injective-projection key propagation', () => {
		type Fd = { determinants: number[]; dependents: number[] };

		async function projectFds(sql: string): Promise<Fd[] | undefined> {
			const rows: Array<{ op: string; physical: string | null }> = [];
			for await (const r of db.eval('SELECT op, physical FROM query_plan(?)', [sql])) rows.push(r as unknown as { op: string; physical: string | null });
			const projectRow = rows.find(r => r.op === 'PROJECT');
			if (!projectRow?.physical) return undefined;
			const phys = JSON.parse(projectRow.physical) as { fds?: Fd[] };
			return phys.fds;
		}

		/** True iff the projection's FDs encode a single-column key at `col`. */
		function hasSingleColKey(fds: Fd[] | undefined, col: number): boolean {
			if (!fds) return false;
			return fds.some(fd => fd.determinants.length === 1 && fd.determinants[0] === col);
		}

		/**
		 * The Project's logical `RelationType.keys` (also exposed in its
		 * `getLogicalAttributes().uniqueKeys`) should reflect that the
		 * single output column is a unique key. For single-column projections
		 * where the key spans all output columns, the FD set can't encode the
		 * key (the all-cols-superkey case is tautological), so the logical
		 * surface is the source of truth.
		 */
		async function assertHasUniqueKey(sql: string): Promise<void> {
			const rows: Array<Record<string, unknown>> = [];
			for await (const r of db.eval('SELECT json_group_array(properties) AS props FROM query_plan(?)', [sql])) rows.push(r as Record<string, unknown>);
			const props = JSON.stringify(rows[0].props);
			expect(props, sql).to.match(/"uniqueKeys":\[\[/);
		}

		it('SELECT id + 1 FROM t — derived column carries the PK', async () => {
			await setup();
			await assertHasUniqueKey('SELECT id + 1 FROM t');
		});

		it('SELECT -id FROM t — unary minus preserves the PK', async () => {
			await setup();
			await assertHasUniqueKey('SELECT -id FROM t');
		});

		it('SELECT 5 - id FROM t — literal minus column preserves the PK', async () => {
			await setup();
			await assertHasUniqueKey('SELECT 5 - id FROM t');
		});

		// Note: a parameter (`?`) at SQL level defaults to TEXT type, so
		// `id + ?` is not recognized as numeric arithmetic and therefore not
		// injective. The parameter-as-constant case for arithmetic is covered
		// directly in expression-properties.spec.ts (where the parameter is
		// constructed with INTEGER_TYPE) and via the unit test below.

		it('SELECT id, id + 1 FROM t — both output columns are keys', async () => {
			await setup();
			const fds = await projectFds('SELECT id, id + 1 FROM t');
			expect(fds, 'expected Project FDs').to.be.an('array');
			// Both `{0}` (id) and `{1}` (id+1) should appear as single-column keys.
			expect(hasSingleColKey(fds, 0), '{0} should be a key').to.equal(true);
			expect(hasSingleColKey(fds, 1), '{1} should be a key').to.equal(true);
		});

		it('SELECT id + v FROM t — references two source attrs; no derived key', async () => {
			await setup();
			const fds = await projectFds('SELECT id + v FROM t');
			// One output column derived from two source attrs — no source key survives,
			// so no single-column key-encoding FD should be present on column 0.
			expect(hasSingleColKey(fds, 0)).to.equal(false);
		});

		it('SELECT id * v FROM t — `*` not injective; no derived key', async () => {
			await setup();
			const fds = await projectFds('SELECT id * v FROM t');
			expect(hasSingleColKey(fds, 0)).to.equal(false);
		});

		it('DISTINCT eliminated for SELECT DISTINCT id + 1 FROM t', async () => {
			await setup();
			const rows: Array<Record<string, unknown>> = [];
			for await (const r of db.eval("SELECT json_group_array(node_type) AS types FROM query_plan('SELECT DISTINCT id + 1 FROM t')")) rows.push(r as Record<string, unknown>);
			const types = String(rows[0].types as unknown as string);
			expect(types).to.not.include('Distinct');
		});
	});
});

// ---------------------------------------------------------------------------
// Unit tests for deriveProjectionColumnMap
// ---------------------------------------------------------------------------

describe('deriveProjectionColumnMap', () => {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const scope = EmptyScope.instance as unknown as any;

	function attr(id: number, name = 'c'): Attribute {
		return {
			id,
			name,
			type: { typeClass: 'scalar', logicalType: INTEGER_TYPE, nullable: false, isReadOnly: false },
		};
	}

	function colRef(attrId: number, index = 0, numeric = true): ColumnReferenceNode {
		const expr = { type: 'column', name: `c${attrId}` } as unknown as AST.ColumnExpr;
		const columnType = {
			typeClass: 'scalar' as const,
			logicalType: numeric ? INTEGER_TYPE : TEXT_TYPE,
			nullable: false,
			isReadOnly: false,
		};
		return new ColumnReferenceNode(scope, expr, columnType, attrId, index);
	}

	function lit(value: number): LiteralNode {
		const expr = { type: 'literal', value } as unknown as AST.LiteralExpr;
		return new LiteralNode(scope, expr);
	}

	function binOp(op: string, left: ScalarPlanNode, right: ScalarPlanNode): BinaryOpNode {
		const ast = {
			type: 'binary',
			operator: op,
			left: (left as unknown as { expression: AST.Expression }).expression,
			right: (right as unknown as { expression: AST.Expression }).expression,
		} as AST.BinaryExpr;
		return new BinaryOpNode(scope, ast, left, right);
	}

	function unaryOp(op: string, operand: ScalarPlanNode): UnaryOpNode {
		const ast = {
			type: 'unary',
			operator: op,
			expr: (operand as unknown as { expression: AST.Expression }).expression,
		} as AST.UnaryExpr;
		return new UnaryOpNode(scope, ast, operand);
	}

	it('bare column projections map to their output index', () => {
		const sourceAttrs = [attr(100, 'id'), attr(101, 'v')];
		const projections = [
			{ expr: colRef(100, 0), outIndex: 0 },
			{ expr: colRef(101, 1), outIndex: 1 },
		];
		const { map, injectivePairs } = deriveProjectionColumnMap(sourceAttrs, projections);
		expect(map.get(0)).to.equal(0);
		expect(map.get(1)).to.equal(1);
		expect(injectivePairs).to.have.length(0);
	});

	it('injective expression (col + 1) adds the source→output entry and an injective pair', () => {
		const sourceAttrs = [attr(100, 'id')];
		const expr = binOp('+', colRef(100, 0), lit(1));
		const { map, injectivePairs } = deriveProjectionColumnMap(sourceAttrs, [{ expr, outIndex: 0 }]);
		expect(map.get(0)).to.equal(0);
		expect(injectivePairs).to.deep.equal([[0, 0]]);
	});

	it('bare-column projection wins when both forms appear (SELECT id, id+1)', () => {
		const sourceAttrs = [attr(100, 'id')];
		const projections = [
			{ expr: colRef(100, 0), outIndex: 0 },
			{ expr: binOp('+', colRef(100, 0), lit(1)), outIndex: 1 },
		];
		const { map, injectivePairs } = deriveProjectionColumnMap(sourceAttrs, projections);
		expect(map.get(0)).to.equal(0);
		expect(injectivePairs).to.deep.equal([[0, 1]]);
	});

	it('two source attrs in one expression: not added (no single-source synonym)', () => {
		const sourceAttrs = [attr(100, 'id'), attr(101, 'v')];
		const expr = binOp('+', colRef(100, 0), colRef(101, 1));
		const { map, injectivePairs } = deriveProjectionColumnMap(sourceAttrs, [{ expr, outIndex: 0 }]);
		expect(map.size).to.equal(0);
		expect(injectivePairs).to.have.length(0);
	});

	it('non-injective expression (col * 2) drops out', () => {
		const sourceAttrs = [attr(100, 'id')];
		const expr = binOp('*', colRef(100, 0), lit(2));
		const { map, injectivePairs } = deriveProjectionColumnMap(sourceAttrs, [{ expr, outIndex: 0 }]);
		expect(map.size).to.equal(0);
		expect(injectivePairs).to.have.length(0);
	});

	it('unary minus on a numeric col is injective', () => {
		const sourceAttrs = [attr(100, 'id')];
		const expr = unaryOp('-', colRef(100, 0));
		const { map, injectivePairs } = deriveProjectionColumnMap(sourceAttrs, [{ expr, outIndex: 0 }]);
		expect(map.get(0)).to.equal(0);
		expect(injectivePairs).to.deep.equal([[0, 0]]);
	});
});
