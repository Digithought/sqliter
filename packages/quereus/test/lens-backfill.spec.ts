/**
 * Engine-emitted backfill DDL for lens basis re-decompositions (ticket
 * `lens-re-decomposition-backfill-ddl`, docs/lens.md § The deployed basis
 * representation).
 *
 * Covers the persisted lens deployment snapshot (hash-coded, rotated), the
 * re-decomposition classifier, and the `quereus_basis_backfill(logical_schema)`
 * introspection TVF that yields per-new-basis-relation backfill rows tagged
 * engine-generated (`re-decomposition` / `partial`) vs app-supplied (`needs-data`).
 */

import { expect } from 'chai';
import { Database } from '../src/core/database.js';
import { computeSchemaHash } from '../src/schema/schema-hasher.js';

async function rows(db: Database, sql: string): Promise<Array<Record<string, unknown>>> {
	const out: Array<Record<string, unknown>> = [];
	for await (const r of db.eval(sql)) out.push(r as Record<string, unknown>);
	return out;
}

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

/** Lowercase the `schema.table` basis_relation for casing-insensitive assertions. */
function rel(r: Record<string, unknown>): string {
	return String(r.basis_relation).toLowerCase();
}

describe('lens backfill: merge re-decomposition', () => {
	it('emits one engine-generated re-decomposition backfill for the merged basis member', async () => {
		const db = new Database();
		try {
			// Basis: split into CarCore + CarPerf.
			await db.exec('declare schema y { table CarCore { id integer primary key, vin text } table CarPerf { id integer primary key, speed integer } }');
			await db.exec('apply schema y');
			await db.exec("insert into y.CarCore values (1, 'AAA'), (2, 'BBB')");
			await db.exec('insert into y.CarPerf values (1, 120), (2, 90)');

			// Logical X over the split basis, via a join override.
			await db.exec('declare logical schema x { table Car { id integer primary key, vin text, speed integer } }');
			await db.exec('declare lens for x over y { view Car as select c.id, c.vin, p.speed from y.CarCore c join y.CarPerf p using (id) }');
			await db.exec('apply schema x'); // snapshot 1 (prior basis = CarCore + CarPerf)

			const before = await rows(db, 'select * from x.Car order by id');
			expect(before).to.deep.equal([
				{ id: 1, vin: 'AAA', speed: 120 },
				{ id: 2, vin: 'BBB', speed: 90 },
			]);

			// Migrate the basis: add the merged Car table; RETAIN CarCore + CarPerf
			// (the backfill source). Then recompile the lens to single-source Car.
			await db.exec('declare schema y { table CarCore { id integer primary key, vin text } table CarPerf { id integer primary key, speed integer } table Car { id integer primary key, vin text, speed integer } }');
			await db.exec('apply schema y');
			await db.exec('declare lens for x over y { view Car as select id, vin, speed from y.Car }');
			await db.exec('apply schema x'); // snapshot 2 (new basis = Car)

			const bf = await rows(db, "select * from quereus_basis_backfill('x')");
			expect(bf.length).to.equal(1);
			expect(bf[0].logical_table).to.equal('Car');
			expect(rel(bf[0])).to.equal('y.car');
			expect(bf[0].category).to.equal('re-decomposition');
			expect(bf[0].missing_columns).to.equal('');
			expect(bf[0].backfill_sql).to.be.a('string');
			// The backfill reads the PRIOR get-body (the split join) as a subquery.
			expect(String(bf[0].backfill_sql).toLowerCase()).to.contain('carcore');
			expect(String(bf[0].backfill_sql).toLowerCase()).to.contain('carperf');

			// y.Car is empty until the backfill runs.
			expect(await rows(db, 'select * from x.Car')).to.deep.equal([]);
			await db.exec(String(bf[0].backfill_sql));
			expect(await rows(db, 'select * from x.Car order by id')).to.deep.equal(before);
		} finally {
			await db.close();
		}
	});
});

describe('lens backfill: split re-decomposition', () => {
	it('emits two engine-generated backfills (CarCore, CarPerf) that reproduce the logical relation', async () => {
		const db = new Database();
		try {
			// Basis: single merged Car. Logical X single-source (name-match).
			await db.exec('declare schema y { table Car { id integer primary key, vin text, speed integer } }');
			await db.exec('apply schema y');
			await db.exec("insert into y.Car values (1, 'AAA', 120), (2, 'BBB', 90)");

			await db.exec('declare logical schema x { table Car { id integer primary key, vin text, speed integer } }');
			await db.exec('apply schema x'); // snapshot 1 (prior basis = Car)

			const before = await rows(db, 'select * from x.Car order by id');

			// Migrate the basis: add CarCore + CarPerf; RETAIN Car. Recompile the
			// lens to the n-way join over the columnar split.
			await db.exec('declare schema y { table Car { id integer primary key, vin text, speed integer } table CarCore { id integer primary key, vin text } table CarPerf { id integer primary key, speed integer } }');
			await db.exec('apply schema y');
			await db.exec('declare lens for x over y { view Car as select c.id, c.vin, p.speed from y.CarCore c join y.CarPerf p using (id) }');
			await db.exec('apply schema x'); // snapshot 2 (new basis = CarCore + CarPerf)

			const bf = await rows(db, "select * from quereus_basis_backfill('x') order by basis_relation");
			expect(bf.map(rel)).to.deep.equal(['y.carcore', 'y.carperf']);
			expect(bf.every(r => r.category === 're-decomposition')).to.be.true;
			expect(bf.every(r => r.missing_columns === '')).to.be.true;

			for (const r of bf) await db.exec(String(r.backfill_sql));
			expect(await rows(db, 'select * from x.Car order by id')).to.deep.equal(before);
		} finally {
			await db.close();
		}
	});
});

describe('lens backfill: new column needs application data', () => {
	it('classifies a freshly-added column member as partial; never fabricates the new column', async () => {
		const db = new Database();
		try {
			await db.exec('declare schema y { table Src { id integer primary key, vin text, speed integer } }');
			await db.exec('apply schema y');
			await db.exec("insert into y.Src values (1, 'AAA', 120)");

			await db.exec('declare logical schema x { table Car { id integer primary key, vin text, speed integer } }');
			await db.exec('declare lens for x over y { view Car as select id, vin, speed from y.Src }');
			await db.exec('apply schema x'); // snapshot 1 (prior basis = Src)

			// Migrate: re-decompose into CarCore + CarPerf (pure) plus a NEW
			// CarColor member carrying a column the prior basis never held.
			await db.exec('declare schema y { table Src { id integer primary key, vin text, speed integer } table CarCore { id integer primary key, vin text } table CarPerf { id integer primary key, speed integer } table CarColor { id integer primary key, color text } }');
			await db.exec('apply schema y');
			await db.exec('declare logical schema x { table Car { id integer primary key, vin text, speed integer, color text } }');
			await db.exec('declare lens for x over y { view Car as select c.id, c.vin, p.speed, k.color from y.CarCore c join y.CarPerf p using (id) join y.CarColor k using (id) }');
			await db.exec('apply schema x'); // snapshot 2

			const bf = await rows(db, "select * from quereus_basis_backfill('x') order by basis_relation");
			const byRel = new Map(bf.map(r => [rel(r), r]));

			expect(byRel.get('y.carcore')!.category).to.equal('re-decomposition');
			expect(byRel.get('y.carperf')!.category).to.equal('re-decomposition');

			const color = byRel.get('y.carcolor')!;
			expect(color.category).to.equal('partial');
			expect(String(color.generated_columns)).to.equal('id');
			expect(String(color.missing_columns)).to.equal('color');
			// `color` is NOT NULL with no default, so a key-only skeleton would fail an
			// unguarded NOT NULL constraint — the SQL is nulled out (the app owns the
			// insert) while the partial classification + reconstructible record stand.
			// It never fabricates `color`. (The runnable skeleton + round-trip for the
			// nullable / defaulted variants are covered by the dedicated tests below.)
			expect(color.backfill_sql).to.be.null;
		} finally {
			await db.close();
		}
	});
});

describe('lens backfill: partial backfill runs end-to-end', () => {
	// The generated `partial` SQL inserts a key-only skeleton, leaving the new
	// column NULL for the app to UPDATE. That skeleton is only runnable when every
	// omitted column is nullable, defaulted, or generated — Quereus columns are NOT
	// NULL by default, so `color` is declared `null` here. This is the nullable
	// happy path the NOT-NULL classification fix must not regress; the NOT-NULL
	// no-default case (skeleton nulled out) is covered below.
	it('runs the engine skeleton insert, then the app supplies the new column; the relation round-trips', async () => {
		const db = new Database();
		try {
			await db.exec('declare schema y { table Src { id integer primary key, vin text, speed integer } }');
			await db.exec('apply schema y');
			await db.exec("insert into y.Src values (1, 'AAA', 120), (2, 'BBB', 90)");

			await db.exec('declare logical schema x { table Car { id integer primary key, vin text, speed integer } }');
			await db.exec('declare lens for x over y { view Car as select id, vin, speed from y.Src }');
			await db.exec('apply schema x'); // snapshot 1 (prior basis = Src)

			// Re-decompose into CarCore + CarPerf (pure) plus a NEW CarColor member
			// carrying `color` (nullable), which the prior basis never held.
			await db.exec('declare schema y { table Src { id integer primary key, vin text, speed integer } table CarCore { id integer primary key, vin text } table CarPerf { id integer primary key, speed integer } table CarColor { id integer primary key, color text null } }');
			await db.exec('apply schema y');
			await db.exec('declare logical schema x { table Car { id integer primary key, vin text, speed integer, color text null } }');
			await db.exec('declare lens for x over y { view Car as select c.id, c.vin, p.speed, k.color from y.CarCore c join y.CarPerf p using (id) join y.CarColor k using (id) }');
			await db.exec('apply schema x'); // snapshot 2

			const bf = await rows(db, "select * from quereus_basis_backfill('x') order by basis_relation");
			// Run every engine-generated backfill (re-decomposition + the partial skeleton).
			for (const r of bf) if (r.backfill_sql) await db.exec(String(r.backfill_sql));

			// The partial skeleton populated CarColor's key with NULL color — so the
			// inner join now yields a row per logical tuple, color left for the app.
			expect(await rows(db, 'select * from x.Car order by id')).to.deep.equal([
				{ id: 1, vin: 'AAA', speed: 120, color: null },
				{ id: 2, vin: 'BBB', speed: 90, color: null },
			]);

			// The application supplies the genuinely-new column.
			await db.exec("update y.CarColor set color = 'red' where id = 1");
			await db.exec("update y.CarColor set color = 'blue' where id = 2");
			expect(await rows(db, 'select * from x.Car order by id')).to.deep.equal([
				{ id: 1, vin: 'AAA', speed: 120, color: 'red' },
				{ id: 2, vin: 'BBB', speed: 90, color: 'blue' },
			]);
		} finally {
			await db.close();
		}
	});
});

describe('lens backfill: partial with a NOT-NULL no-default new column', () => {
	// The skeleton insert seeds only the reconstructible (key) columns and relies
	// on the basis to mint the rest from their declared defaults. When a missing
	// column is NOT NULL with no default, the basis cannot mint it — the skeleton
	// would fail an unguarded NOT NULL constraint — so the classifier nulls the SQL
	// out (the app owns the insert) while keeping the `partial` category + the
	// reconstructible-column record. `color text` is NOT NULL by default here.
	it('keeps category partial, nulls out backfill_sql, and names the NOT-NULL block', async () => {
		const db = new Database();
		try {
			await db.exec('declare schema y { table Src { id integer primary key, vin text, speed integer } }');
			await db.exec('apply schema y');
			await db.exec("insert into y.Src values (1, 'AAA', 120), (2, 'BBB', 90)");

			await db.exec('declare logical schema x { table Car { id integer primary key, vin text, speed integer } }');
			await db.exec('declare lens for x over y { view Car as select id, vin, speed from y.Src }');
			await db.exec('apply schema x'); // snapshot 1 (prior basis = Src)

			// Re-decompose into CarCore + CarPerf (pure) plus a NEW CarColor member
			// carrying `color` — NOT NULL by default, no default expression.
			await db.exec('declare schema y { table Src { id integer primary key, vin text, speed integer } table CarCore { id integer primary key, vin text } table CarPerf { id integer primary key, speed integer } table CarColor { id integer primary key, color text } }');
			await db.exec('apply schema y');
			await db.exec('declare logical schema x { table Car { id integer primary key, vin text, speed integer, color text } }');
			await db.exec('declare lens for x over y { view Car as select c.id, c.vin, p.speed, k.color from y.CarCore c join y.CarPerf p using (id) join y.CarColor k using (id) }');
			await db.exec('apply schema x'); // snapshot 2

			const bf = await rows(db, "select * from quereus_basis_backfill('x') order by basis_relation");
			const byRel = new Map(bf.map(r => [rel(r), r]));

			const color = byRel.get('y.carcolor')!;
			// Category + reconstructible record preserved; SQL nulled out.
			expect(color.category).to.equal('partial');
			expect(String(color.generated_columns)).to.equal('id');
			expect(String(color.missing_columns)).to.equal('color');
			expect(color.backfill_sql, 'skeleton omitting NOT-NULL no-default color must be nulled out').to.be.null;
			expect(String(color.reason).toLowerCase()).to.contain('not null');
			expect(String(color.reason).toLowerCase()).to.contain('color');

			// Every *emitted* backfill (the re-decomposition members) is runnable —
			// none throws a NOT NULL constraint. The app then owns the CarColor insert.
			for (const r of bf) if (r.backfill_sql) await db.exec(String(r.backfill_sql));
			await db.exec("insert into y.CarColor values (1, 'red'), (2, 'blue')");
			expect(await rows(db, 'select * from x.Car order by id')).to.deep.equal([
				{ id: 1, vin: 'AAA', speed: 120, color: 'red' },
				{ id: 2, vin: 'BBB', speed: 90, color: 'blue' },
			]);
		} finally {
			await db.close();
		}
	});
});

describe('lens backfill: partial with a defaulted new column', () => {
	// A missing column with a DEFAULT has a value source, so the skeleton may omit
	// it soundly — the basis default mints it. The skeleton must still be emitted.
	it('emits a runnable skeleton; the basis default mints the new column', async () => {
		const db = new Database();
		try {
			await db.exec('declare schema y { table Src { id integer primary key, vin text, speed integer } }');
			await db.exec('apply schema y');
			await db.exec("insert into y.Src values (1, 'AAA', 120), (2, 'BBB', 90)");

			await db.exec('declare logical schema x { table Car { id integer primary key, vin text, speed integer } }');
			await db.exec('declare lens for x over y { view Car as select id, vin, speed from y.Src }');
			await db.exec('apply schema x'); // snapshot 1

			// CarColor.color is NOT NULL but carries a deterministic default.
			await db.exec("declare schema y { table Src { id integer primary key, vin text, speed integer } table CarCore { id integer primary key, vin text } table CarPerf { id integer primary key, speed integer } table CarColor { id integer primary key, color text default ('?') } }");
			await db.exec('apply schema y');
			await db.exec('declare logical schema x { table Car { id integer primary key, vin text, speed integer, color text } }');
			await db.exec('declare lens for x over y { view Car as select c.id, c.vin, p.speed, k.color from y.CarCore c join y.CarPerf p using (id) join y.CarColor k using (id) }');
			await db.exec('apply schema x'); // snapshot 2

			const bf = await rows(db, "select * from quereus_basis_backfill('x') order by basis_relation");
			const color = new Map(bf.map(r => [rel(r), r])).get('y.carcolor')!;
			expect(color.category).to.equal('partial');
			expect(color.backfill_sql, 'defaulted column lets the skeleton emit').to.be.a('string');

			// Run every backfill; the default mints color, so the relation round-trips.
			for (const r of bf) if (r.backfill_sql) await db.exec(String(r.backfill_sql));
			expect(await rows(db, 'select * from x.Car order by id')).to.deep.equal([
				{ id: 1, vin: 'AAA', speed: 120, color: '?' },
				{ id: 2, vin: 'BBB', speed: 90, color: '?' },
			]);
		} finally {
			await db.close();
		}
	});
});

describe('lens backfill: rename re-decomposition', () => {
	it('emits an engine-generated backfill for a renamed single-source basis relation', async () => {
		const db = new Database();
		try {
			await db.exec('declare schema y { table Src { id integer primary key, vin text } }');
			await db.exec('apply schema y');
			await db.exec("insert into y.Src values (1, 'AAA'), (2, 'BBB')");

			await db.exec('declare logical schema x { table Car { id integer primary key, vin text } }');
			await db.exec('declare lens for x over y { view Car as select id, vin from y.Src }');
			await db.exec('apply schema x'); // snapshot 1 (prior basis = Src)
			const before = await rows(db, 'select * from x.Car order by id');

			// Rename: add Vehicle, RETAIN Src (the backfill source), re-point the lens.
			await db.exec('declare schema y { table Src { id integer primary key, vin text } table Vehicle { id integer primary key, vin text } }');
			await db.exec('apply schema y');
			await db.exec('declare lens for x over y { view Car as select id, vin from y.Vehicle }');
			await db.exec('apply schema x'); // snapshot 2 (new basis = Vehicle)

			const bf = await rows(db, "select * from quereus_basis_backfill('x')");
			expect(bf.length).to.equal(1);
			expect(rel(bf[0])).to.equal('y.vehicle');
			expect(bf[0].category).to.equal('re-decomposition');
			expect(String(bf[0].generated_columns)).to.equal('id, vin');
			expect(String(bf[0].backfill_sql).toLowerCase()).to.contain('src');

			expect(await rows(db, 'select * from x.Car')).to.deep.equal([]);
			await db.exec(String(bf[0].backfill_sql));
			expect(await rows(db, 'select * from x.Car order by id')).to.deep.equal(before);
		} finally {
			await db.close();
		}
	});
});

describe('lens backfill: argument guards', () => {
	it('errors on a non-logical (basis) schema, an unknown schema, and a non-string argument', async () => {
		const db = new Database();
		try {
			await db.exec('declare schema y { table Car { id integer primary key, vin text } }');
			await db.exec('apply schema y');
			await db.exec('declare logical schema x { table Car { id integer primary key, vin text } }');
			await db.exec('apply schema x');

			// `y` is a deployed basis schema — not logical.
			await expectThrows(() => rows(db, "select * from quereus_basis_backfill('y')"), /not a logical schema/i);
			// `main` exists but is not logical either.
			await expectThrows(() => rows(db, "select * from quereus_basis_backfill('main')"), /not a logical schema/i);
			// An unknown schema name.
			await expectThrows(() => rows(db, "select * from quereus_basis_backfill('nope')"), /not found/i);
			// A non-string argument.
			await expectThrows(() => rows(db, "select * from quereus_basis_backfill(42)"), /string argument/i);
		} finally {
			await db.close();
		}
	});
});

describe('lens backfill: nothing to do', () => {
	it('first deploy yields no backfill rows (no prior snapshot)', async () => {
		const db = new Database();
		try {
			await db.exec('declare schema y { table Car { id integer primary key, vin text } }');
			await db.exec('apply schema y');
			await db.exec('declare logical schema x { table Car { id integer primary key, vin text } }');
			await db.exec('apply schema x');
			expect(await rows(db, "select * from quereus_basis_backfill('x')")).to.deep.equal([]);
		} finally {
			await db.close();
		}
	});

	it('an unchanged re-apply yields no backfill rows (no new basis relations)', async () => {
		const db = new Database();
		try {
			await db.exec('declare schema y { table Car { id integer primary key, vin text } }');
			await db.exec('apply schema y');
			await db.exec('declare logical schema x { table Car { id integer primary key, vin text } }');
			await db.exec('apply schema x');
			await db.exec('apply schema x'); // identical re-apply rotates the snapshot
			expect(await rows(db, "select * from quereus_basis_backfill('x')")).to.deep.equal([]);
		} finally {
			await db.close();
		}
	});
});

describe('lens backfill: snapshot rotation + basis-hash drift', () => {
	it('rotates the prior get-body + basisHash and flags an out-of-band basis drift', async () => {
		const db = new Database();
		try {
			// A merge re-decomposition (two deploys), as above.
			await db.exec('declare schema y { table CarCore { id integer primary key, vin text } table CarPerf { id integer primary key, speed integer } }');
			await db.exec('apply schema y');
			await db.exec('declare logical schema x { table Car { id integer primary key, vin text, speed integer } }');
			await db.exec('declare lens for x over y { view Car as select c.id, c.vin, p.speed from y.CarCore c join y.CarPerf p using (id) }');
			await db.exec('apply schema x'); // snapshot 1

			await db.exec('declare schema y { table CarCore { id integer primary key, vin text } table CarPerf { id integer primary key, speed integer } table Car { id integer primary key, vin text, speed integer } }');
			await db.exec('apply schema y');
			await db.exec('declare lens for x over y { view Car as select id, vin, speed from y.Car }');
			await db.exec('apply schema x'); // snapshot 2

			// Snapshot internals: both present, distinct, hash captured.
			const snaps = db.declaredSchemaManager.getDeployedLensSnapshots('x');
			expect(snaps?.previous, 'previous snapshot').to.exist;
			expect(snaps?.current, 'current snapshot').to.exist;
			expect(snaps!.previous).to.not.equal(snaps!.current);
			expect(snaps!.previous!.basisHash).to.be.a('string').and.not.equal('');
			expect(snaps!.current!.basisHash).to.be.a('string').and.not.equal('');
			// The basis changed between the two deploys, so the recorded hashes differ.
			expect(snaps!.current!.basisHash).to.not.equal(snaps!.previous!.basisHash);
			// `previous` holds the prior split get-body (over CarCore + CarPerf).
			const priorTable = snaps!.previous!.tables.get('car')!;
			expect([...priorTable.logicalColumns].sort()).to.deep.equal(['id', 'speed', 'vin']);
			expect(Array.from(priorTable.relationBacking.keys()).sort()).to.deep.equal(['y.carcore', 'y.carperf']);

			// No drift yet — the live basis matches the recorded hash.
			let bf = await rows(db, "select * from quereus_basis_backfill('x')");
			expect(bf.length).to.equal(1);
			expect(/drift/i.test(String(bf[0].reason))).to.be.false;

			// Drift the basis out-of-band: re-declare Y (changing its hash) without
			// re-applying X, so the live basis no longer matches the deployed record.
			await db.exec('declare schema y { table CarCore { id integer primary key, vin text } table CarPerf { id integer primary key, speed integer } table Car { id integer primary key, vin text, speed integer, note text } }');
			const liveHash = computeSchemaHash(db.declaredSchemaManager.getDeclaredSchema('y')!);
			expect(liveHash).to.not.equal(snaps!.current!.basisHash);

			bf = await rows(db, "select * from quereus_basis_backfill('x')");
			expect(bf.length).to.equal(1);
			expect(/drift/i.test(String(bf[0].reason)), bf[0].reason as string).to.be.true;
		} finally {
			await db.close();
		}
	});
});

describe('lens backfill: re-decomposition blocked by an unmapped NOT-NULL no-default column', () => {
	// The relation-level runnability check walks the member's *full* schema, so a
	// NOT-NULL no-default basis column the lens maps to NO logical column — one that
	// never appears in the (basisColumn → logicalColumn) pairs — still blocks the
	// skeleton. Every *mapped* column (id, vin) is reconstructible, so the category
	// is re-decomposition and missing_columns is empty; but the skeleton would omit
	// the required unmapped column and fail an unguarded NOT NULL constraint, so
	// backfill_sql is nulled out and the app owns the insert. This is the edge a
	// per-pair form (one inspecting only the mapped columns) would have missed.
	it('nulls out backfill_sql when an unmapped member column is NOT NULL with no default', async () => {
		const db = new Database();
		try {
			await db.exec('declare schema y { table Src { id integer primary key, vin text } }');
			await db.exec('apply schema y');
			await db.exec("insert into y.Src values (1, 'AAA'), (2, 'BBB')");

			await db.exec('declare logical schema x { table Car { id integer primary key, vin text } }');
			await db.exec('declare lens for x over y { view Car as select id, vin from y.Src }');
			await db.exec('apply schema x'); // snapshot 1
			const before = await rows(db, 'select * from x.Car order by id');

			await db.exec('declare schema y { table Src { id integer primary key, vin text } table CarThing { id integer primary key, vin text, required_extra text } }');
			await db.exec('apply schema y');
			await db.exec('declare lens for x over y { view Car as select id, vin from y.CarThing }');
			await db.exec('apply schema x'); // snapshot 2

			const bf = await rows(db, "select * from quereus_basis_backfill('x')");
			expect(bf.length).to.equal(1);
			const r = bf[0];
			expect(rel(r)).to.equal('y.carthing');
			expect(r.category).to.equal('re-decomposition');
			expect(String(r.generated_columns)).to.equal('id, vin');
			expect(String(r.missing_columns)).to.equal('');
			expect(r.backfill_sql, 'skeleton omitting an unmapped NOT-NULL no-default column must be nulled out').to.be.null;
			expect(String(r.reason).toLowerCase()).to.contain('not null');
			expect(String(r.reason).toLowerCase()).to.contain('required_extra');

			await db.exec("insert into y.CarThing values (1, 'AAA', 'x'), (2, 'BBB', 'y')");
			expect(await rows(db, 'select * from x.Car order by id')).to.deep.equal(before);
		} finally {
			await db.close();
		}
	});
});

describe('lens backfill: surrogate omission (single relation)', () => {
	it('omits a basis surrogate-key default column from the projection; the relation round-trips', async () => {
		const db = new Database();
		try {
			await db.exec('declare schema y { table Src { id integer primary key, vin text } }');
			await db.exec('apply schema y');
			await db.exec("insert into y.Src values (1, 'AAA'), (2, 'BBB')");

			await db.exec('declare logical schema x { table Car { id integer primary key, vin text } }');
			await db.exec('declare lens for x over y { view Car as select id, vin from y.Src }');
			await db.exec('apply schema x'); // snapshot 1
			const before = await rows(db, 'select * from x.Car order by id');

			// Migrate to a new member carrying a surrogate-key default column `sk`
			// that is NOT part of the logical mapping. RETAIN Src. (A deterministic
			// sentinel default is used because the engine rejects non-deterministic
			// DEFAULT expressions at DDL time — it is enough to show the column is
			// omitted from the projection and minted by the basis default.)
			await db.exec('declare schema y { table Src { id integer primary key, vin text } table CarThing { sk integer default (-1), id integer primary key, vin text } }');
			await db.exec('apply schema y');
			await db.exec('declare lens for x over y { view Car as select id, vin from y.CarThing }');
			await db.exec('apply schema x'); // snapshot 2

			const bf = await rows(db, "select * from quereus_basis_backfill('x')");
			expect(bf.length).to.equal(1);
			expect(rel(bf[0])).to.equal('y.carthing');
			// id + vin are reconstructible; the surrogate `sk` is unmapped and omitted.
			expect(bf[0].category).to.equal('re-decomposition');
			expect(String(bf[0].generated_columns)).to.equal('id, vin');
			expect(String(bf[0].backfill_sql).toLowerCase()).to.not.contain('sk');

			await db.exec(String(bf[0].backfill_sql)); // sk minted by the basis default
			expect(await rows(db, 'select * from x.Car order by id')).to.deep.equal(before);
			// The surrogate was minted by the basis default, not the backfill.
			expect(await rows(db, 'select distinct sk from y.CarThing')).to.deep.equal([{ sk: -1 }]);
		} finally {
			await db.close();
		}
	});
});
