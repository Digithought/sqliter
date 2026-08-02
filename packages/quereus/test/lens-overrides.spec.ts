/**
 * Lens explicit overrides + per-attribute merge (docs/lens.md, ticket
 * `lens-explicit-overrides-and-attribute-merge`).
 *
 * Covers the authoring half on top of the foundation: the
 * `declare lens for X over Y { view T as <select> }` surface, the
 * explicit-basis binding, the per-attribute sparse-override merger (covered ⊕
 * default-mapper gap-fill), the `quereus_effective_lens` introspection
 * TVF, and DDL round-trip. Read-correct only — write enforcement of attached
 * logical constraints is the prover ticket's concern.
 */

import { expect } from 'chai';
import { Database } from '../src/core/database.js';
import { Parser } from '../src/parser/parser.js';
import { astToString } from '../src/emit/ast-stringify.js';
import { computeSchemaHash } from '../src/schema/schema-hasher.js';
import type * as AST from '../src/parser/ast.js';

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

describe('lens overrides: rename', () => {
	it('binds maxSpeed -> CarCore.speed and surfaces the logical names', async () => {
		const db = new Database();
		try {
			await db.exec('declare schema y { table CarCore { id integer primary key, speed integer } }');
			await db.exec('apply schema y');
			await db.exec('insert into y.CarCore values (1, 120), (2, 90)');

			await db.exec('declare logical schema x { table Car { id integer primary key, maxSpeed integer } }');
			await db.exec('declare lens for x over y { view Car as select id, speed as maxSpeed from y.CarCore }');
			await db.exec('apply schema x');

			const body = astToString(db.schemaManager.getView('x', 'Car')!.selectAst).toLowerCase();
			expect(body).to.contain('speed as maxspeed');

			expect(await rows(db, 'select * from x.Car order by id')).to.deep.equal([
				{ id: 1, maxSpeed: 120 },
				{ id: 2, maxSpeed: 90 },
			]);
		} finally {
			await db.close();
		}
	});
});

describe('lens overrides: sparse rename + gap-fill', () => {
	it('gap-fills an uncovered column from the override source', async () => {
		const db = new Database();
		try {
			await db.exec('declare schema y { table CarCore { id integer primary key, speed integer, color text } }');
			await db.exec('apply schema y');
			await db.exec("insert into y.CarCore values (1, 120, 'red')");

			await db.exec('declare logical schema x { table Car { id integer primary key, maxSpeed integer, color text } }');
			// Override covers id, maxSpeed; color is gap-filled from CarCore.
			await db.exec('declare lens for x over y { view Car as select id, speed as maxSpeed from y.CarCore }');
			await db.exec('apply schema x');

			expect(await rows(db, 'select color from x.Car')).to.deep.equal([{ color: 'red' }]);
			expect(await rows(db, 'select * from x.Car')).to.deep.equal([{ id: 1, maxSpeed: 120, color: 'red' }]);
		} finally {
			await db.close();
		}
	});

	it('composes a later-added logical column without touching the override (rename + add)', async () => {
		const db = new Database();
		try {
			await db.exec('declare schema y { table CarCore { id integer primary key, speed integer, color text } }');
			await db.exec('apply schema y');
			await db.exec("insert into y.CarCore values (1, 120, 'red')");

			await db.exec('declare logical schema x { table Car { id integer primary key, maxSpeed integer } }');
			await db.exec('declare lens for x over y { view Car as select id, speed as maxSpeed from y.CarCore }');
			await db.exec('apply schema x');
			expect(await rows(db, 'select * from x.Car')).to.deep.equal([{ id: 1, maxSpeed: 120 }]);

			// Add a new logical column and re-apply; the stored override is untouched
			// and `color` appears as an uncovered attribute the mapper gap-fills.
			await db.exec('declare logical schema x { table Car { id integer primary key, maxSpeed integer, color text } }');
			await db.exec('apply schema x');
			expect(await rows(db, 'select * from x.Car')).to.deep.equal([{ id: 1, maxSpeed: 120, color: 'red' }]);
		} finally {
			await db.close();
		}
	});
});

describe('lens overrides: coverage', () => {
	it('an uncovered logical column the basis cannot back errors, naming it', async () => {
		const db = new Database();
		try {
			await db.exec('declare schema y { table CarCore { id integer primary key } }');
			await db.exec('apply schema y');

			await db.exec('declare logical schema x { table Car { id integer primary key, name text } }');
			await db.exec('declare lens for x over y { view Car as select id from y.CarCore }');
			await expectThrows(() => db.exec('apply schema x'), /uncovered.*'name'|'name'.*uncovered|column 'name'/i);
		} finally {
			await db.close();
		}
	});
});

describe('lens overrides: compute', () => {
	it('a computed column reads; writing it is rejected by view-updateability', async () => {
		const db = new Database();
		try {
			await db.exec('declare schema y { table U { id integer primary key, first text, last text } }');
			await db.exec('apply schema y');
			await db.exec("insert into y.U values (1, 'Ada', 'Lovelace')");

			await db.exec('declare logical schema x { table U { id integer primary key, full_name text } }');
			await db.exec("declare lens for x over y { view U as select id, first || ' ' || last as full_name from y.U }");
			await db.exec('apply schema x');

			expect(await rows(db, 'select full_name from x.U')).to.deep.equal([{ full_name: 'Ada Lovelace' }]);
			await expectThrows(() => db.exec("update x.U set full_name = 'x' where id = 1"));
		} finally {
			await db.close();
		}
	});
});

describe('lens overrides: filter', () => {
	it('a where filter restricts reads; star expands to logical columns', async () => {
		const db = new Database();
		try {
			await db.exec('declare schema y { table U { id integer primary key, active integer } }');
			await db.exec('apply schema y');
			await db.exec('insert into y.U values (1, 1), (2, 0), (3, 1)');

			await db.exec('declare logical schema x { table U { id integer primary key, active integer } }');
			await db.exec('declare lens for x over y { view U as select * from y.U where active = 1 }');
			await db.exec('apply schema x');

			expect(await rows(db, 'select id from x.U order by id')).to.deep.equal([{ id: 1 }, { id: 3 }]);
		} finally {
			await db.close();
		}
	});
});

describe('lens overrides: cross-basis join', () => {
	it('a fully-covered join is used verbatim (gap-fill no-op)', async () => {
		const db = new Database();
		try {
			await db.exec('declare schema y { table Core { id integer primary key, name text } table Contact { id integer primary key, email text } }');
			await db.exec('apply schema y');
			await db.exec("insert into y.Core values (1, 'Ada')");
			await db.exec("insert into y.Contact values (1, 'ada@x.io')");

			await db.exec('declare logical schema x { table Person { id integer primary key, name text, email text } }');
			await db.exec('declare lens for x over y { view Person as select c.id, c.name, k.email from y.Core c join y.Contact k using (id) }');
			await db.exec('apply schema x');

			expect(await rows(db, 'select * from x.Person')).to.deep.equal([{ id: 1, name: 'Ada', email: 'ada@x.io' }]);
		} finally {
			await db.close();
		}
	});

	it('a partial join with an unreachable gap errors with a clear message', async () => {
		const db = new Database();
		try {
			await db.exec('declare schema y { table Core { id integer primary key, name text } table Contact { id integer primary key, email text } }');
			await db.exec('apply schema y');

			await db.exec('declare logical schema x { table Person { id integer primary key, name text, email text, phone text } }');
			await db.exec('declare lens for x over y { view Person as select c.id, c.name, k.email from y.Core c join y.Contact k using (id) }');
			await expectThrows(() => db.exec('apply schema x'), /not reachable.*'phone'|'phone'.*not reachable|column 'phone'/i);
		} finally {
			await db.close();
		}
	});
});

describe('lens overrides: duplicate view rejection', () => {
	it('two `view T as` for the same logical table in one block is an error', async () => {
		const db = new Database();
		try {
			await db.exec('declare schema y { table Car { id integer primary key, speed integer } }');
			await db.exec('apply schema y');
			await db.exec('declare logical schema x { table Car { id integer primary key, speed integer } }');
			await expectThrows(
				() => db.exec('declare lens for x over y { view Car as select * from y.Car; view Car as select id from y.Car }'),
				/duplicate override.*Car/i,
			);
		} finally {
			await db.close();
		}
	});
});

describe('lens overrides: body-shape validation', () => {
	// Defect 1: a compound set-operation override body composes only its top leg,
	// so it is rejected at parse time rather than silently mis-mapped.
	it('rejects a compound (union all) override body at parse time', async () => {
		const db = new Database();
		try {
			await expectThrows(
				() => db.exec('declare lens for x over y { view Car as select id, speed from y.CarCore union all select id, speed from y.CarOther }'),
				/single SELECT|compound|union/i,
			);
		} finally {
			await db.close();
		}
	});

	// Defect 2: a `values (...)` body is not a SELECT — the existing guard rejects it.
	it('rejects a values override body at parse time', async () => {
		const db = new Database();
		try {
			await expectThrows(
				() => db.exec('declare lens for x over y { view Car as values (1, 2) }'),
				/must be a SELECT.*values|values/i,
			);
		} finally {
			await db.close();
		}
	});

	// Defect 3: an unaliased computed projection term maps to no logical column;
	// it would be silently dropped and the logical column wrongly gap-filled.
	it('errors on an unaliased computed projection term, naming it', async () => {
		const db = new Database();
		try {
			await db.exec('declare schema y { table CarCore { id integer primary key, speed integer } }');
			await db.exec('apply schema y');
			await db.exec('declare logical schema x { table Car { id integer primary key, speed integer } }');
			await db.exec('declare lens for x over y { view Car as select id, speed * 2 from y.CarCore }');
			await expectThrows(() => db.exec('apply schema x'), /computed projection term|no output name|add an alias/i);
		} finally {
			await db.close();
		}
	});

	// Defect 5: an override FROM source qualified with a different existing schema
	// silently re-anchors the lens off its declared `over Y` basis.
	it('errors on a FROM source outside the declared basis', async () => {
		const db = new Database();
		try {
			await db.exec('declare schema y { table CarCore { id integer primary key, speed integer } }');
			await db.exec('apply schema y');
			await db.exec('declare schema z { table CarCore { id integer primary key, speed integer } }');
			await db.exec('apply schema z');
			await db.exec('declare logical schema x { table Car { id integer primary key, speed integer } }');
			await db.exec('declare lens for x over y { view Car as select id, speed from z.CarCore }');
			await expectThrows(() => db.exec('apply schema x'), /outside the declared basis|references basis relation 'z/i);
		} finally {
			await db.close();
		}
	});

	// Defect 5, join arm: the FROM walk descends both legs, so a cross-basis leg
	// inside a join is rejected too (not only a single top-level table source).
	it('errors on a cross-basis leg inside a join', async () => {
		const db = new Database();
		try {
			await db.exec('declare schema y { table CarCore { id integer primary key, speed integer } }');
			await db.exec('apply schema y');
			await db.exec('declare schema z { table Extra { id integer primary key, note text } }');
			await db.exec('apply schema z');
			await db.exec('declare logical schema x { table Car { id integer primary key, speed integer } }');
			await db.exec('declare lens for x over y { view Car as select c.id, c.speed from y.CarCore c join z.Extra e on e.id = c.id }');
			await expectThrows(() => db.exec('apply schema x'), /outside the declared basis|references basis relation 'z/i);
		} finally {
			await db.close();
		}
	});

	// Defect 5, subquery-source arm: a full-coverage override whose FROM is a
	// subquery source naming a *different* existing schema leaves no gap-fill to
	// trip the basis-reachability error, so only the reflective whole-body walk
	// catches the silent re-anchor.
	it('errors on a cross-basis table inside a subquery source', async () => {
		const db = new Database();
		try {
			await db.exec('declare schema y { table CarCore { id integer primary key, speed integer } }');
			await db.exec('apply schema y');
			await db.exec('declare schema z { table CarCore { id integer primary key, speed integer } }');
			await db.exec('apply schema z');
			await db.exec('declare logical schema x { table Car { id integer primary key, speed integer } }');
			await db.exec('declare lens for x over y { view Car as select id, speed from (select * from z.CarCore) sub }');
			await expectThrows(() => db.exec('apply schema x'), /outside the declared basis|references basis relation 'z/i);
		} finally {
			await db.close();
		}
	});

	// Defect 5, nested-CTE arm: a cross-basis table buried in a CTE body inside a
	// subquery source is reached by the reflective walk (which descends `with`
	// CTE bodies), even though the CTE *reference* `c` is a bare, in-scope name.
	it('errors on a cross-basis table inside a nested CTE body', async () => {
		const db = new Database();
		try {
			await db.exec('declare schema y { table CarCore { id integer primary key, speed integer } }');
			await db.exec('apply schema y');
			await db.exec('declare schema z { table CarCore { id integer primary key, speed integer } }');
			await db.exec('apply schema z');
			await db.exec('declare logical schema x { table Car { id integer primary key, speed integer } }');
			await db.exec('declare lens for x over y { view Car as select id, speed from (with c as (select * from z.CarCore) select * from c) sub }');
			await expectThrows(() => db.exec('apply schema x'), /outside the declared basis|references basis relation 'z/i);
		} finally {
			await db.close();
		}
	});

	// Defect 5 guard must NOT over-reject: a subquery source over the *basis*
	// schema is a legitimate body shape and must still deploy. This pins that the
	// whole-body walk only rejects cross-basis tables, not nested subqueries per se.
	it('accepts a subquery source over the basis schema', async () => {
		const db = new Database();
		try {
			await db.exec('declare schema y { table CarCore { id integer primary key, speed integer } }');
			await db.exec('apply schema y');
			await db.exec('declare logical schema x { table Car { id integer primary key, speed integer } }');
			await db.exec('declare lens for x over y { view Car as select id, speed from (select * from y.CarCore) sub }');
			await db.exec('apply schema x');
			const cols = await rows(db, "select logical_column, source from quereus_effective_lens('x', 'Car') order by logical_column");
			expect(cols).to.deep.equal([
				{ logical_column: 'id', source: 'override' },
				{ logical_column: 'speed', source: 'override' },
			]);
		} finally {
			await db.close();
		}
	});

	// Defect 5, compound-leg arm: a compound (`union`) leg nested inside a subquery
	// source carries the cross-basis table on a type-less `{ op, select }` wrapper,
	// so only a walk that descends into *every* nested object (not just nodes with
	// a `type` discriminant) reaches it. A top-level compound body is rejected at
	// parse time, but nested in a subquery source it is a legal shape.
	it('errors on a cross-basis table inside a nested compound leg', async () => {
		const db = new Database();
		try {
			await db.exec('declare schema y { table CarCore { id integer primary key, speed integer } }');
			await db.exec('apply schema y');
			await db.exec('declare schema z { table CarCore { id integer primary key, speed integer } }');
			await db.exec('apply schema z');
			await db.exec('declare logical schema x { table Car { id integer primary key, speed integer } }');
			await db.exec('declare lens for x over y { view Car as select id, speed from (select id, speed from y.CarCore union all select id, speed from z.CarCore) sub }');
			await expectThrows(() => db.exec('apply schema x'), /outside the declared basis|references basis relation 'z/i);
		} finally {
			await db.close();
		}
	});

	// Defect 5 guard, CTE arm: a CTE over the *basis* deploys. The body references
	// the CTE by its bare name `c`; the whole-body walk must not mistake that bare
	// in-scope name for a cross-basis relation (the schema-qualified-only invariant
	// that lets the check skip CTE-name tracking).
	it('accepts a CTE over the basis schema (bare CTE ref not flagged)', async () => {
		const db = new Database();
		try {
			await db.exec('declare schema y { table CarCore { id integer primary key, speed integer } }');
			await db.exec('apply schema y');
			await db.exec('declare logical schema x { table Car { id integer primary key, speed integer } }');
			await db.exec('declare lens for x over y { view Car as select id, speed from (with c as (select * from y.CarCore) select * from c) sub }');
			await db.exec('apply schema x');
			const cols = await rows(db, "select logical_column, source from quereus_effective_lens('x', 'Car') order by logical_column");
			expect(cols).to.deep.equal([
				{ logical_column: 'id', source: 'override' },
				{ logical_column: 'speed', source: 'override' },
			]);
		} finally {
			await db.close();
		}
	});

	// Defect 5, non-FROM subquery arm: a cross-basis table in a `where … in
	// (subquery)` position is not a FROM source at all, so neither the top-level
	// FROM walk nor gap-fill would ever see it — only the reflective whole-body
	// walk reaches it. Pins that the check covers expression subqueries, not just
	// FROM/subquery-source positions.
	it('errors on a cross-basis table inside a where-in subquery', async () => {
		const db = new Database();
		try {
			await db.exec('declare schema y { table CarCore { id integer primary key, speed integer } }');
			await db.exec('apply schema y');
			await db.exec('declare schema z { table CarCore { id integer primary key, speed integer } }');
			await db.exec('apply schema z');
			await db.exec('declare logical schema x { table Car { id integer primary key, speed integer } }');
			await db.exec('declare lens for x over y { view Car as select id, speed from y.CarCore where id in (select id from z.CarCore) }');
			await expectThrows(() => db.exec('apply schema x'), /outside the declared basis|references basis relation 'z/i);
		} finally {
			await db.close();
		}
	});

	// Defect 3 guard must NOT over-reject: a computed projection term that *is*
	// aliased maps to a logical column, and an uncovered logical column is still
	// gap-filled from the basis. This pins the boundary so a future tightening of
	// the unaliased-term check cannot silently start rejecting valid bodies.
	it('accepts an aliased computed term alongside gap-fill', async () => {
		const db = new Database();
		try {
			await db.exec('declare schema y { table CarCore { id integer primary key, speed integer } }');
			await db.exec('apply schema y');
			await db.exec('declare logical schema x { table Car { id integer primary key, speed integer, fast integer } }');
			await db.exec('declare lens for x over y { view Car as select id, speed * 2 as fast from y.CarCore }');
			// `id`+`fast` covered by the override; `speed` gap-filled from y.CarCore.
			await db.exec('apply schema x');
			const cols = await rows(db, "select logical_column, source from quereus_effective_lens('x', 'Car') order by logical_column");
			expect(cols).to.deep.equal([
				{ logical_column: 'fast', source: 'override' },
				{ logical_column: 'id', source: 'override' },
				{ logical_column: 'speed', source: 'default' },
			]);
		} finally {
			await db.close();
		}
	});
});

describe('lens overrides: unqualified basis sources', () => {
	// An override may name its basis tables bare; the compiler pins them to the
	// basis schema so the *stored* body says which schema it meant. Before that,
	// every consumer re-resolved the bare name its own way and none knew the
	// basis: the read path plans under the logical schema's home path, and the
	// prover / `explain` round-trip the body through SQL text with no path at all.
	it('carries the basis qualifier into effective_sql and proves the same inverses as the qualified form', async () => {
		const db = new Database();
		try {
			await db.exec('declare schema y { table CarCore { id integer primary key, speed integer, color text } }');
			await db.exec('apply schema y');
			await db.exec("insert into y.CarCore values (1, 120, 'red')");

			await db.exec('declare logical schema x { table Car { id integer primary key, maxSpeed integer, color text } }');
			await db.exec('declare lens for x over y { view Car as select id, speed as maxSpeed from CarCore }');
			await db.exec('apply schema x');

			const sqlRows = await rows(db, "select distinct effective_sql from quereus_effective_lens('x', 'Car')");
			expect(sqlRows.length).to.equal(1);
			expect(String(sqlRows[0].effective_sql).toLowerCase()).to.contain('from y.carcore');

			// The prover plans the stored body by round-tripping it through SQL text
			// with no schema path, so an unqualified body used to fail to plan and
			// every column degraded to inverse 'none'. Match the qualified form.
			expect(await rows(db, "select logical_column, source, inverse from quereus_effective_lens('x', 'Car') order by logical_column"))
				.to.deep.equal([
					{ logical_column: 'color', source: 'default', inverse: 'inferred' },
					{ logical_column: 'id', source: 'override', inverse: 'inferred' },
					{ logical_column: 'maxSpeed', source: 'override', inverse: 'inferred' },
				]);

			expect(await rows(db, 'select * from x.Car')).to.deep.equal([{ id: 1, maxSpeed: 120, color: 'red' }]);
		} finally {
			await db.close();
		}
	});

	// The sharp edge: a same-named table on the default schema path used to win,
	// so the compiler validated coverage against the basis relation while the read
	// bound `main`'s — different tables, no error.
	it('binds the basis relation, not a same-named table in main', async () => {
		const db = new Database();
		try {
			await db.exec('declare schema y { table Widget { id integer primary key, label text } }');
			await db.exec('apply schema y');
			await db.exec("insert into y.Widget values (1, 'from-basis')");
			await db.exec('create table Widget (id integer primary key, label text)');
			await db.exec("insert into main.Widget values (2, 'from-main')");

			await db.exec('declare logical schema x { table Widget { id integer primary key, label text } }');
			await db.exec('declare lens for x over y { view Widget as select id, label from Widget }');
			await db.exec('apply schema x');

			expect(await rows(db, 'select * from x.Widget')).to.deep.equal([{ id: 1, label: 'from-basis' }]);
		} finally {
			await db.close();
		}
	});

	// The qualification must not touch a bare name a CTE declares — that name is
	// the CTE, and pinning it to the basis would silently swap the relation.
	it('leaves a CTE that shadows a basis table name binding the CTE', async () => {
		const db = new Database();
		try {
			await db.exec('declare schema y { table CarCore { id integer primary key, speed integer } }');
			await db.exec('apply schema y');
			await db.exec('insert into y.CarCore values (1, 120)');

			await db.exec('declare logical schema x { table Car { id integer primary key, maxSpeed integer } }');
			await db.exec('declare lens for x over y { view Car as with CarCore as (select 9 as id, 1 as speed) select id, speed as maxSpeed from CarCore }');
			await db.exec('apply schema x');

			expect(await rows(db, 'select * from x.Car')).to.deep.equal([{ id: 9, maxSpeed: 1 }]);
		} finally {
			await db.close();
		}
	});

	// A CTE shadow is not an introspectable basis source, so gap-fill may not draw
	// on the shadowed basis table. Previously it did: `color` was gap-filled from
	// y.CarCore, which the CTE does not expose, and the body deployed only to fail
	// at read with `Column not found: color`.
	it('errors at deploy when a CTE shadow leaves an uncovered column unreachable', async () => {
		const db = new Database();
		try {
			await db.exec('declare schema y { table CarCore { id integer primary key, speed integer, color text } }');
			await db.exec('apply schema y');

			await db.exec('declare logical schema x { table Car { id integer primary key, maxSpeed integer, color text } }');
			await db.exec('declare lens for x over y { view Car as with CarCore as (select 9 as id, 1 as speed) select id, speed as maxSpeed from CarCore }');
			await expectThrows(
				() => db.exec('apply schema x'),
				/not reachable.*'color'|'color'.*not reachable|column 'color'/i,
			);
		} finally {
			await db.close();
		}
	});

	// Qualification descends the whole body, not just top-level FROM sources.
	it('qualifies a bare basis table inside a subquery source', async () => {
		const db = new Database();
		try {
			await db.exec('declare schema y { table CarCore { id integer primary key, speed integer } }');
			await db.exec('apply schema y');
			await db.exec('insert into y.CarCore values (1, 120)');

			await db.exec('declare logical schema x { table Car { id integer primary key, speed integer } }');
			await db.exec('declare lens for x over y { view Car as select id, speed from (select * from CarCore) s }');
			await db.exec('apply schema x');

			expect(await rows(db, 'select * from x.Car')).to.deep.equal([{ id: 1, speed: 120 }]);
		} finally {
			await db.close();
		}
	});

	it('qualifies both legs of a bare two-table basis join', async () => {
		const db = new Database();
		try {
			await db.exec('declare schema y { table Core { id integer primary key, name text } table Contact { id integer primary key, email text } }');
			await db.exec('apply schema y');
			await db.exec("insert into y.Core values (1, 'Ada')");
			await db.exec("insert into y.Contact values (1, 'ada@x.io')");

			await db.exec('declare logical schema x { table Person { id integer primary key, name text, email text } }');
			await db.exec('declare lens for x over y { view Person as select c.id, c.name, k.email from Core c join Contact k using (id) }');
			await db.exec('apply schema x');

			expect(await rows(db, 'select * from x.Person')).to.deep.equal([{ id: 1, name: 'Ada', email: 'ada@x.io' }]);
		} finally {
			await db.close();
		}
	});

	// Qualification rewrites a copy: the authored `declare lens` AST the catalog
	// holds must still stringify exactly as written, or DDL round-trip and
	// declarative-equivalence output would drift.
	it('does not rewrite the authored declaration AST', async () => {
		const db = new Database();
		try {
			await db.exec('declare schema y { table CarCore { id integer primary key, speed integer } }');
			await db.exec('apply schema y');
			await db.exec('declare logical schema x { table Car { id integer primary key, maxSpeed integer } }');
			await db.exec('declare lens for x over y { view Car as select id, speed as maxSpeed from CarCore }');
			await db.exec('apply schema x');

			const declared = db.declaredSchemaManager.getLensDeclaration('x');
			expect(declared, 'declared lens should be retained').to.not.be.undefined;
			const authored = astToString(declared!.overrides[0].select).toLowerCase();
			expect(authored).to.contain('from carcore');
			expect(authored).to.not.contain('y.carcore');

			// …while the compiled body the engine reads *is* qualified.
			expect(astToString(db.schemaManager.getView('x', 'Car')!.selectAst).toLowerCase()).to.contain('from y.carcore');
		} finally {
			await db.close();
		}
	});
});

describe('lens overrides: quereus_effective_lens', () => {
	it('returns composed SQL + per-attribute source for a logical table', async () => {
		const db = new Database();
		try {
			await db.exec('declare schema y { table CarCore { id integer primary key, speed integer, color text } }');
			await db.exec('apply schema y');
			await db.exec("insert into y.CarCore values (1, 120, 'red')");

			await db.exec('declare logical schema x { table Car { id integer primary key, maxSpeed integer, color text } }');
			await db.exec('declare lens for x over y { view Car as select id, speed as maxSpeed from y.CarCore }');
			await db.exec('apply schema x');

			const provenance = await rows(db, "select logical_column, source from quereus_effective_lens('x', 'Car') order by logical_column");
			expect(provenance).to.deep.equal([
				{ logical_column: 'color', source: 'default' },   // gap-filled
				{ logical_column: 'id', source: 'override' },      // covered
				{ logical_column: 'maxSpeed', source: 'override' },// covered (renamed)
			]);

			const sqlRows = await rows(db, "select distinct effective_sql from quereus_effective_lens('x', 'Car')");
			expect(sqlRows.length).to.equal(1);
			expect(String(sqlRows[0].effective_sql).toLowerCase()).to.contain('speed as maxspeed');
		} finally {
			await db.close();
		}
	});

	it('errors on an unknown table or a non-logical schema', async () => {
		const db = new Database();
		try {
			await db.exec('create table t (id integer primary key)');
			await expectThrows(() => rows(db, "select * from quereus_effective_lens('main', 't')"), /not a logical schema/i);
		} finally {
			await db.close();
		}
	});
});

describe('lens overrides: DDL round-trip', () => {
	it('round-trips `declare lens` through stringify + reparse (equal AST + hash)', () => {
		const sql = "declare lens for x over y { view Car as select id, speed as maxSpeed from y.CarCore; view U as select * from y.U where active = 1 }";
		const ast1 = new Parser().parseAll(sql)[0] as AST.DeclareLensStmt;
		expect(ast1.type).to.equal('declareLens');
		expect(ast1.logicalSchema).to.equal('x');
		expect(ast1.basisSchema).to.equal('y');
		expect(ast1.overrides.length).to.equal(2);

		const emitted = astToString(ast1);
		expect(emitted.toLowerCase()).to.match(/declare\s+lens\s+for\s+x\s+over\s+y/);

		const ast2 = new Parser().parseAll(emitted)[0] as AST.DeclareLensStmt;
		expect(ast2.overrides.length).to.equal(2);
		expect(computeSchemaHash(ast2)).to.equal(computeSchemaHash(ast1));
	});

	it('the lens block participates in the hash (an override change changes it)', () => {
		const a = new Parser().parseAll('declare lens for x over y { view Car as select id from y.CarCore }')[0] as AST.DeclareLensStmt;
		const b = new Parser().parseAll('declare lens for x over y { view Car as select id, speed as maxSpeed from y.CarCore }')[0] as AST.DeclareLensStmt;
		expect(computeSchemaHash(a)).to.not.equal(computeSchemaHash(b));
	});
});
