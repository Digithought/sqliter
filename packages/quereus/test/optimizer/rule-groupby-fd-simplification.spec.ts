import { expect } from 'chai';
import { Database } from '../../src/core/database.js';

interface PlanRow {
	id: number;
	parent_id: number | null;
	node_type: string;
	op: string;
	detail: string;
	properties: string | null;
	physical: string | null;
}

async function planRows(db: Database, sql: string): Promise<PlanRow[]> {
	const rows: PlanRow[] = [];
	for await (const r of db.eval(
		'SELECT id, parent_id, node_type, op, detail, properties, physical FROM query_plan(?)',
		[sql],
	)) {
		rows.push(r as unknown as PlanRow);
	}
	return rows;
}

interface AggLogicalProps {
	groupBy?: string[];
	aggregates?: Array<{ expression: string; alias: string }>;
}

function aggregateRow(rows: readonly PlanRow[]): PlanRow | undefined {
	return rows.find(
		(r) =>
			r.op === 'STREAMAGGREGATE' ||
			r.op === 'HASHAGGREGATE' ||
			r.op === 'AGGREGATE',
	);
}

function aggregateProps(rows: readonly PlanRow[]): AggLogicalProps | undefined {
	const row = aggregateRow(rows);
	if (!row || !row.properties) return undefined;
	return JSON.parse(row.properties) as AggLogicalProps;
}

describe('ruleGroupByFdSimplification', () => {
	let db: Database;

	beforeEach(() => {
		db = new Database();
	});

	afterEach(async () => {
		await db.close();
	});

	it('PK-driven: drops name & email when id is in GROUP BY', async () => {
		await db.exec(
			"CREATE TABLE c (id INTEGER PRIMARY KEY, name TEXT, email TEXT) USING memory",
		);
		const rows = await planRows(
			db,
			'SELECT id, name, email FROM c GROUP BY id, name, email',
		);
		const props = aggregateProps(rows);
		expect(props, 'expected aggregate node').to.not.equal(undefined);
		expect(props!.groupBy, 'GROUP BY should collapse to one column').to.have.length(1);
		// The two dropped columns are re-emitted as picker MIN aggregates plus the
		// (zero) original aggregates from the SELECT list. Since the SELECT list
		// here has no user aggregates, exactly two pickers remain.
		expect(props!.aggregates, 'two picker aggregates expected').to.have.length(2);
		expect(props!.aggregates!.every((a) => /min\(/i.test(a.expression))).to.equal(true);
	});

	it('EC-driven: drops one of two equated columns', async () => {
		await db.exec("CREATE TABLE e (a INTEGER, b INTEGER) USING memory");
		const rows = await planRows(db, 'SELECT a, b FROM e WHERE a = b GROUP BY a, b');
		const props = aggregateProps(rows);
		expect(props).to.not.equal(undefined);
		expect(props!.groupBy, 'one GROUP BY column should remain').to.have.length(1);
		expect(props!.aggregates, 'one picker aggregate expected').to.have.length(1);
		expect(/min\(/i.test(props!.aggregates![0].expression)).to.equal(true);
	});

	it('Negative: independent columns are not simplified', async () => {
		await db.exec("CREATE TABLE n (a INTEGER, b INTEGER) USING memory");
		const rows = await planRows(db, 'SELECT a, b FROM n GROUP BY a, b');
		const props = aggregateProps(rows);
		expect(props).to.not.equal(undefined);
		expect(props!.groupBy, 'rule should not fire on independent cols').to.have.length(2);
	});

	it('Negative: expression GROUP BYs are untouched', async () => {
		await db.exec(
			"CREATE TABLE x (a INTEGER PRIMARY KEY, b INTEGER) USING memory",
		);
		// `a + 1` is not a bare column, so it is never in the candidate set; the
		// rule must not collapse it.
		const rows = await planRows(db, 'SELECT a + 1, b FROM x GROUP BY a + 1, b');
		const props = aggregateProps(rows);
		expect(props).to.not.equal(undefined);
		expect(props!.groupBy).to.have.length(2);
	});

	it('Negative: single GROUP BY column is untouched', async () => {
		await db.exec("CREATE TABLE s (id INTEGER PRIMARY KEY, v TEXT) USING memory");
		const rows = await planRows(db, 'SELECT id FROM s GROUP BY id');
		const props = aggregateProps(rows);
		expect(props).to.not.equal(undefined);
		expect(props!.groupBy).to.have.length(1);
	});

	it('Preserves attribute IDs through the rewrite (downstream binding survives)', async () => {
		// Result attribute IDs at the aggregate output must survive the rewrite so
		// the outer Project's ColumnReferenceNodes still resolve.
		await db.exec(
			"CREATE TABLE p (id INTEGER PRIMARY KEY, name TEXT, email TEXT) USING memory",
		);
		await db.exec("INSERT INTO p VALUES (1,'a','a@x'),(2,'b','b@x')");
		// If attribute IDs weren't preserved the outer Project would fail to bind.
		const out: { id: number; name: string; email: string }[] = [];
		for await (const r of db.eval(
			'SELECT id, name, email FROM p GROUP BY id, name, email ORDER BY id',
		)) {
			out.push(r as unknown as { id: number; name: string; email: string });
		}
		expect(out).to.deep.equal([
			{ id: 1, name: 'a', email: 'a@x' },
			{ id: 2, name: 'b', email: 'b@x' },
		]);
	});

	it('Smaller GROUP BY still selects a physical aggregate operator', async () => {
		await db.exec(
			"CREATE TABLE z (id INTEGER PRIMARY KEY, name TEXT, email TEXT) USING memory",
		);
		const rows = await planRows(
			db,
			'SELECT id, name, email FROM z GROUP BY id, name, email',
		);
		const row = aggregateRow(rows);
		expect(row, 'expected a physical aggregate row').to.not.equal(undefined);
		expect(['STREAMAGGREGATE', 'HASHAGGREGATE']).to.include(row!.op);
	});

	it('HAVING on a dropped column still binds after simplification', async () => {
		// HAVING references the aggregate's output by attribute ID. Since the
		// rule preserves IDs, the HAVING predicate must still resolve.
		await db.exec(
			"CREATE TABLE h (id INTEGER PRIMARY KEY, name TEXT) USING memory",
		);
		await db.exec("INSERT INTO h VALUES (1,'a'),(2,'b'),(3,'c')");
		const out: { id: number; name: string }[] = [];
		for await (const r of db.eval(
			"SELECT id, name FROM h GROUP BY id, name HAVING name > 'a' ORDER BY id",
		)) {
			out.push(r as unknown as { id: number; name: string });
		}
		expect(out).to.deep.equal([
			{ id: 2, name: 'b' },
			{ id: 3, name: 'c' },
		]);
	});

	// An AggregateNode's layout is fixed — grouping keys first, then aggregate
	// results — so a dropped key necessarily leaves its key slot for the aggregate
	// block. When that moves it *past* a surviving column the output order changes,
	// and the rule caps the new aggregate with an order-restoring Project.
	//
	// Both select lists below already match the pre-rewrite aggregate output column
	// for column (keys in GROUP BY order, then the aggregate), so the builder forces
	// no select-list projection of its own — every PROJECT in these plans is the
	// rule's cap.
	describe('order-restoring cap', () => {
		beforeEach(async () => {
			await db.exec("CREATE TABLE cap (id INTEGER PRIMARY KEY, name TEXT) USING memory");
		});

		it('caps the rewrite with a Project when the drop permutes the output', async () => {
			// `id` is the PK, so `name` is dropped — out of slot 0, down behind `id`.
			const rows = await planRows(db, 'SELECT name, id, count(*) AS c FROM cap GROUP BY name, id');
			const projects = rows.filter(r => r.op === 'PROJECT');
			expect(projects, 'the permuting rewrite should be capped by exactly one Project')
				.to.have.length(1);
			const agg = aggregateRow(rows);
			expect(agg, 'expected an aggregate node').to.not.equal(undefined);
			expect(agg!.parent_id, 'the cap should sit directly above the aggregate')
				.to.equal(projects[0].id);
			expect(projects[0].detail, 'the cap re-emits the original column order')
				.to.match(/name.*\bid\b/);
		});

		it('adds no Project when the dropped keys were already a suffix', async () => {
			// `name` is dropped from the tail, so the picker `min(name)` lands back at
			// its own index — the output order never changes and the cap is skipped.
			const rows = await planRows(db, 'SELECT id, name, count(*) AS c FROM cap GROUP BY id, name');
			const props = aggregateProps(rows);
			expect(props, 'expected aggregate node').to.not.equal(undefined);
			expect(props!.groupBy, 'the rule should still have fired').to.have.length(1);
			expect(rows.filter(r => r.op === 'PROJECT'), 'an order-preserving drop needs no cap')
				.to.be.empty;
		});
	});

	it('a user-defined aggregate that shadows the builtin min', async () => {
		// `Schema.addFunction` overwrites by name/numArgs, so after this registration
		// BOTH the planner's resolution and `db._findFunction('min', 1)` return the
		// shadow — comparing the two would only prove they agree with each other. The
		// gate is schema identity against the builtin registration
		// (`db._isBuiltinFunction`, via `_findBuiltinFunction`) for exactly this reason:
		// picking the shadow would return its row count instead of the true value.
		await db.exec(
			"CREATE TABLE pk (id INTEGER PRIMARY KEY, v INTEGER NOT NULL) USING memory",
		);
		await db.exec('INSERT INTO pk VALUES (1, 100), (2, 200)');
		db.createAggregateFunction('min', { numArgs: 1, initialState: 0 },
			(acc: unknown) => (acc as number) + 1,
			(acc: unknown) => acc as number);

		const rows = await planRows(db, 'SELECT id, v FROM pk GROUP BY id, v');
		const props = aggregateProps(rows);
		expect(props, 'expected aggregate node').to.not.equal(undefined);
		expect(props!.groupBy, 'a shadowed min must decline the rewrite; both columns stay grouped')
			.to.have.length(2);

		const out: { id: number; v: number }[] = [];
		for await (const r of db.eval('SELECT id, v FROM pk GROUP BY id, v ORDER BY id')) {
			out.push(r as unknown as { id: number; v: number });
		}
		expect(out, 'the true values must come back, not the shadow aggregate\'s row count').to.deep.equal([
			{ id: 1, v: 100 },
			{ id: 2, v: 200 },
		]);
	});

	it('control: the same query still collapses GROUP BY when min is un-shadowed', async () => {
		await db.exec(
			"CREATE TABLE pk2 (id INTEGER PRIMARY KEY, v INTEGER NOT NULL) USING memory",
		);
		await db.exec('INSERT INTO pk2 VALUES (1, 100), (2, 200)');

		const rows = await planRows(db, 'SELECT id, v FROM pk2 GROUP BY id, v');
		const props = aggregateProps(rows);
		expect(props, 'expected aggregate node').to.not.equal(undefined);
		expect(props!.groupBy, 'GROUP BY should collapse to one column').to.have.length(1);

		const out: { id: number; v: number }[] = [];
		for await (const r of db.eval('SELECT id, v FROM pk2 GROUP BY id, v ORDER BY id')) {
			out.push(r as unknown as { id: number; v: number });
		}
		expect(out).to.deep.equal([
			{ id: 1, v: 100 },
			{ id: 2, v: 200 },
		]);
	});

	it('Result rows match the un-simplified semantics under EC-driven drop', async () => {
		await db.exec("CREATE TABLE eq (id INTEGER PRIMARY KEY, a INTEGER, b INTEGER) USING memory");
		await db.exec("INSERT INTO eq VALUES (1,1,1),(2,2,2),(3,3,3),(4,1,1)");
		const out: { a: number; b: number }[] = [];
		for await (const r of db.eval(
			'SELECT a, b FROM eq WHERE a = b GROUP BY a, b ORDER BY a',
		)) {
			out.push(r as unknown as { a: number; b: number });
		}
		expect(out).to.deep.equal([
			{ a: 1, b: 1 },
			{ a: 2, b: 2 },
			{ a: 3, b: 3 },
		]);
	});
});
