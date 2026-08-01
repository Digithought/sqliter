import { expect } from 'chai';
import { Database } from '../../src/core/database.js';

interface PlanRow {
	id: number;
	parent_id: number | null;
	node_type: string;
	op: string;
	detail: string;
	object_name: string | null;
	physical: string | null;
}

async function planRows(db: Database, sql: string): Promise<PlanRow[]> {
	const rows: PlanRow[] = [];
	for await (const r of db.eval(
		'SELECT id, parent_id, node_type, op, detail, object_name, physical FROM query_plan(?)',
		[sql],
	)) {
		rows.push(r as unknown as PlanRow);
	}
	return rows;
}

function filtersByDetail(rows: readonly PlanRow[]): string[] {
	return rows.filter(r => r.op === 'FILTER').map(r => r.detail);
}

function retrieveOps(rows: readonly PlanRow[]): PlanRow[] {
	return rows.filter(r =>
		r.op === 'RETRIEVE' || r.op === 'INDEXSEEK' || r.op === 'INDEXSCAN' || r.op === 'SEQSCAN'
	);
}

describe('rulePredicateInferenceEquivalence', () => {
	let db: Database;

	beforeEach(() => {
		db = new Database();
	});

	afterEach(async () => {
		await db.close();
	});

	it('Single-hop equi-join with constant filter: inferred predicate appears on u-side branch', async () => {
		// Use non-PK columns for the equi-join so the equality isn't subsumed by
		// an index seek — keeps the inferred filter visible above the leaf.
		await db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, k INTEGER, v INTEGER) USING memory');
		await db.exec('CREATE TABLE u (id INTEGER PRIMARY KEY, k INTEGER, v INTEGER) USING memory');
		const sql = 'SELECT t.v, u.v FROM t JOIN u ON t.k = u.k WHERE t.k = 5';

		const rows = await planRows(db, sql);
		const filters = filtersByDetail(rows);

		// Expect at least one FILTER node whose detail mentions u.k = 5 — i.e.
		// the inferred predicate landed somewhere visible in the plan.
		const hasInferredOnU = filters.some(d => /u\.k\s*=\s*5/.test(d));
		expect(hasInferredOnU, `expected an inferred filter on u.k=5; got filters: ${JSON.stringify(filters)}`).to.equal(true);
	});

	it('LEFT JOIN: no inference reaches the null-extended (u) side', async () => {
		await db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, k INTEGER) USING memory');
		await db.exec('CREATE TABLE u (id INTEGER PRIMARY KEY, k INTEGER) USING memory');
		const sql = 'SELECT t.k, u.k FROM t LEFT JOIN u ON t.k = u.k WHERE t.k = 5';

		const rows = await planRows(db, sql);
		const filters = filtersByDetail(rows);

		// LEFT JOIN drops right-side bindings/ECs in propagateJoinFds, so the
		// outer Filter's source has no EC visible from the right side. The rule
		// must NOT emit `u.k = 5` at all — and `join-predicate-pushdown` would
		// refuse to carry it to the null-extended branch even if it did.
		const hasUk5 = filters.some(d => /u\.k\s*=\s*5/.test(d));
		expect(hasUk5, 'right-branch inference must be suppressed for LEFT JOIN').to.equal(false);
	});

	it('Parameter binding: inferred predicate references the same parameter slot', async () => {
		await db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, k INTEGER) USING memory');
		await db.exec('CREATE TABLE u (id INTEGER PRIMARY KEY, k INTEGER) USING memory');
		// Use a named parameter to make the inferred reference unambiguous.
		const sql = 'SELECT t.k, u.k FROM t JOIN u ON t.k = u.k WHERE t.k = :p';

		const rows = await planRows(db, sql);
		const filters = filtersByDetail(rows);

		// The inferred conjunct should also reference :p (not a literal).
		const inferred = filters.find(d => /u\.k\s*=\s*:p/.test(d));
		expect(inferred, `expected u.k = :p inferred; filters were: ${JSON.stringify(filters)}`).to.not.equal(undefined);
	});

	it('No-op when no EC crosses the filter (no equi-join in source)', async () => {
		await db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v INTEGER) USING memory');
		const sql = 'SELECT * FROM t WHERE v = 5';

		const rows = await planRows(db, sql);
		const filters = filtersByDetail(rows);

		// At most one filter, and its detail must not contain duplicated `v = 5`.
		const eqCount = filters.reduce((acc, d) => acc + (d.match(/v\s*=\s*5/g) ?? []).length, 0);
		expect(eqCount, 'inference rule should not duplicate the v = 5 conjunct').to.be.lessThan(2);
	});

	it('No-op when join has no constant binding', async () => {
		await db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, k INTEGER) USING memory');
		await db.exec('CREATE TABLE u (id INTEGER PRIMARY KEY, k INTEGER) USING memory');
		const sql = 'SELECT t.k, u.k FROM t JOIN u ON t.k = u.k';

		const rows = await planRows(db, sql);
		const filters = filtersByDetail(rows);

		// No constant binding → no inference. There may legitimately be no
		// filter at all (everything in the ON clause).
		const inferred = filters.find(d => /=\s*\d+/.test(d));
		expect(inferred, `no constant on either side, so no inferred eq should appear: ${JSON.stringify(filters)}`).to.equal(undefined);
	});

	it('Idempotence: rule does not re-fire on its own output (no triple-materialised inferred conjuncts)', async () => {
		await db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, k INTEGER, x INTEGER) USING memory');
		await db.exec('CREATE TABLE u (id INTEGER PRIMARY KEY, k INTEGER, y INTEGER) USING memory');
		const sql = 'SELECT * FROM t JOIN u ON t.k = u.k WHERE t.k = 5';

		const rows = await planRows(db, sql);
		const filters = filtersByDetail(rows);

		// The rule materialises `u.k = 5` once, into the Filter above the join;
		// `join-predicate-pushdown` then MOVES it onto the u branch, so it is
		// still visible exactly once. What MUST NOT happen is a repeat occurrence
		// (which would indicate the rule re-fired on its own output, breaking the
		// fixpoint guarantee).
		const occurrences = filters.reduce((acc, d) => acc + (d.match(/u\.k\s*=\s*5/g) ?? []).length, 0);
		expect(occurrences, `u.k = 5 must appear at most twice; saw ${occurrences} across ${JSON.stringify(filters)}`)
			.to.be.at.most(2);
		// And the corresponding outer-Filter conjunct should be present.
		expect(occurrences, `u.k = 5 must appear at least once; saw ${occurrences}`).to.be.at.least(1);
	});

	it('Mixed predicate: inferred eq does not drag along the t-only conjunct', async () => {
		await db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, k INTEGER, x INTEGER) USING memory');
		await db.exec('CREATE TABLE u (id INTEGER PRIMARY KEY, k INTEGER) USING memory');
		const sql = 'SELECT * FROM t JOIN u ON t.k = u.k WHERE t.x > 0 AND t.k = 5';

		const rows = await planRows(db, sql);
		const filters = filtersByDetail(rows);

		// The branch-specific filter is the one that mentions u.k = 5 but does NOT
		// mention t.x or t.k: inference augments the predicate above the join, and
		// `join-predicate-pushdown` then splits it by side, so only u-side conjuncts
		// land on the u branch.
		const branchFilter = filters.find(d => /u\.k\s*=\s*5/.test(d) && !/t\.x/.test(d) && !/t\.k/.test(d));
		expect(branchFilter, `expected a u-branch filter scoped to u columns only; got: ${JSON.stringify(filters)}`).to.not.equal(undefined);
	});

	it('Behavioral correctness (literal): inference preserves result rows', async () => {
		await db.exec('CREATE TABLE t (k INTEGER PRIMARY KEY, v TEXT) USING memory');
		await db.exec('CREATE TABLE u (k INTEGER PRIMARY KEY, v TEXT) USING memory');
		await db.exec("INSERT INTO t VALUES (1,'a'),(5,'e'),(10,'j')");
		await db.exec("INSERT INTO u VALUES (5,'E'),(7,'G'),(10,'J')");

		const rows: Array<{ tv: string; uv: string }> = [];
		for await (const r of db.eval('SELECT t.v AS tv, u.v AS uv FROM t JOIN u ON t.k = u.k WHERE t.k = 5')) {
			rows.push(r as unknown as { tv: string; uv: string });
		}
		expect(rows).to.deep.equal([{ tv: 'e', uv: 'E' }]);
	});

	it('Behavioral correctness (parameter): inference preserves result rows', async () => {
		await db.exec('CREATE TABLE t (k INTEGER PRIMARY KEY, v TEXT) USING memory');
		await db.exec('CREATE TABLE u (k INTEGER PRIMARY KEY, v TEXT) USING memory');
		await db.exec("INSERT INTO t VALUES (1,'a'),(5,'e'),(10,'j')");
		await db.exec("INSERT INTO u VALUES (5,'E'),(7,'G'),(10,'J')");

		const rows: Array<{ tv: string; uv: string }> = [];
		for await (const r of db.eval(
			'SELECT t.v AS tv, u.v AS uv FROM t JOIN u ON t.k = u.k WHERE t.k = ?',
			[10],
		)) {
			rows.push(r as unknown as { tv: string; uv: string });
		}
		expect(rows).to.deep.equal([{ tv: 'j', uv: 'J' }]);
	});

	it('Multi-hop chain: a JOIN b ON a.x=b.x JOIN c ON b.x=c.x WHERE a.x=7 propagates inference', async () => {
		await db.exec('CREATE TABLE ta (id INTEGER PRIMARY KEY, x INTEGER) USING memory');
		await db.exec('CREATE TABLE tb (id INTEGER PRIMARY KEY, x INTEGER) USING memory');
		await db.exec('CREATE TABLE tc (id INTEGER PRIMARY KEY, x INTEGER) USING memory');

		const sql = 'SELECT ta.x, tb.x, tc.x FROM ta JOIN tb ON ta.x = tb.x JOIN tc ON tb.x = tc.x WHERE ta.x = 7';
		const rows = await planRows(db, sql);
		const filters = filtersByDetail(rows);

		// All three columns should end up bound: ta.x = 7 (original), tb.x = 7 (inferred),
		// tc.x = 7 (inferred via the second join's EC).
		const hasTb = filters.some(d => /tb\.x\s*=\s*7/.test(d));
		const hasTc = filters.some(d => /tc\.x\s*=\s*7/.test(d));
		expect(hasTb, `expected tb.x = 7 inferred; filters: ${JSON.stringify(filters)}`).to.equal(true);
		expect(hasTc, `expected tc.x = 7 inferred; filters: ${JSON.stringify(filters)}`).to.equal(true);
	});

	it('Inferred predicate is pushed to the vtab access leaf when supported', async () => {
		// PK on the joined column means inference produces an equality on a PK,
		// which the memory module exposes as an INDEXSEEK. With the rule disabled
		// only the original `t.k = 5` reaches a branch (via join-predicate-pushdown),
		// so exactly one seek fires; with it enabled the inferred `u.k = 5` adds the
		// second. Asserting the delta keeps this pinned to inference alone.
		await db.exec('CREATE TABLE t (k INTEGER PRIMARY KEY, v INTEGER) USING memory');
		await db.exec('CREATE TABLE u (k INTEGER PRIMARY KEY, v INTEGER) USING memory');
		const sqlWith = 'SELECT t.v, u.v FROM t JOIN u ON t.k = u.k WHERE t.k = 5';
		const rowsWith = await planRows(db, sqlWith);
		const seeksWith = retrieveOps(rowsWith).filter(r => r.op === 'INDEXSEEK').length;

		const baseTuning = db.optimizer.tuning;
		db.optimizer.updateTuning({
			...baseTuning,
			disabledRules: new Set([
				...(baseTuning.disabledRules ?? []),
				'predicate-inference-equivalence',
			]),
		});
		let seeksWithout: number;
		try {
			const rowsWithout = await planRows(db, sqlWith);
			seeksWithout = retrieveOps(rowsWithout).filter(r => r.op === 'INDEXSEEK').length;
		} finally {
			db.optimizer.updateTuning(baseTuning);
		}

		// Disabling the rule should drop at least one INDEXSEEK (the inferred
		// one on the u-side); enabling it adds it back.
		expect(seeksWith,
			`expected more INDEXSEEKs with rule enabled (with=${seeksWith}, without=${seeksWithout})`,
		).to.be.greaterThan(seeksWithout);
	});
});
