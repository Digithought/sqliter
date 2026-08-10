/**
 * Lens foundation + default mapper (docs/lens.md, ticket
 * `lens-foundation-and-default-mapper`).
 *
 * Covers the substrate this ticket lands: the `Schema.kind` discriminator, the
 * `declare logical schema X { ... }` surface, the per-logical-table lens slot,
 * and the default name-based aligner that compiles the inlined effective view
 * body. A logical table deploys against a name-equivalent basis with NO explicit
 * lens; the query processor then sees an ordinary view.
 *
 * Stateful scenarios (default-basis inference, multi-basis ambiguity,
 * rejection) get a fresh Database per case here rather than fighting the
 * single-DB sqllogic harness. The read happy-path is also exercised through the
 * full SQL pipeline in test/logic/51-lens-foundation.sqllogic.
 */

import { expect } from 'chai';
import { Database } from '../src/core/database.js';
import { Parser } from '../src/parser/parser.js';
import { astToString } from '../src/emit/ast-stringify.js';
import { computeSchemaDiff } from '../src/schema/schema-differ.js';
import { computeSchemaHash } from '../src/schema/schema-hasher.js';
import { collectSchemaCatalog } from '../src/schema/catalog.js';
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

describe('lens foundation: declaration + data model', () => {
	it('declares + applies a logical schema (kind, lens slot, no vtabModule on the spec)', async () => {
		const db = new Database();
		try {
			await db.exec('declare schema ybasis { table t { id integer primary key } }');
			await db.exec('apply schema ybasis');
			await db.exec('declare logical schema x { table t { id integer primary key } }');
			await db.exec('apply schema x');

			const schema = db.schemaManager.getSchema('x');
			expect(schema, 'logical schema x exists').to.not.be.undefined;
			expect(schema!.kind).to.equal('logical');

			const slot = schema!.getLensSlot('t');
			expect(slot, 'lens slot for t exists').to.not.be.undefined;
			expect(slot!.logicalTable.isLogical).to.equal(true);
			expect(slot!.logicalTable.vtabModule, 'logical spec carries no module').to.be.undefined;
			expect(slot!.defaultBasis.schemaName).to.equal('ybasis');
			// The compiled body is registered as an ordinary view.
			expect(db.schemaManager.getView('x', 't'), 'compiled body registered as a view').to.not.be.undefined;
		} finally {
			await db.close();
		}
	});
});

describe('lens foundation: default name-based aligner', () => {
	it('aligns an identically-shaped logical + basis and reads basis rows', async () => {
		const db = new Database();
		try {
			await db.exec('declare schema y { table t { id integer primary key, name text } }');
			await db.exec('apply schema y');
			await db.exec("insert into y.t values (1, 'alpha'), (2, 'beta')");

			await db.exec('declare logical schema x { table t { id integer primary key, name text } }');
			await db.exec('apply schema x');

			// Compiled body is `select id, name from y.t`.
			const view = db.schemaManager.getView('x', 't')!;
			const body = astToString(view.selectAst);
			expect(body.toLowerCase()).to.contain('select');
			expect(body.toLowerCase()).to.contain('from');
			expect(body.toLowerCase()).to.contain('y');

			const result = await rows(db, 'select * from x.t order by id');
			expect(result).to.deep.equal([
				{ id: 1, name: 'alpha' },
				{ id: 2, name: 'beta' },
			]);
		} finally {
			await db.close();
		}
	});

	it('projects exactly the logical columns when the basis has extra columns', async () => {
		const db = new Database();
		try {
			await db.exec('declare schema y { table t { id integer primary key, name text, secret text } }');
			await db.exec('apply schema y');
			await db.exec("insert into y.t values (1, 'alpha', 'hidden')");

			await db.exec('declare logical schema x { table t { id integer primary key, name text } }');
			await db.exec('apply schema x');

			const result = await rows(db, 'select * from x.t');
			expect(result).to.deep.equal([{ id: 1, name: 'alpha' }]);
		} finally {
			await db.close();
		}
	});

	it('errors naming a logical column with no basis backing', async () => {
		const db = new Database();
		try {
			await db.exec('declare schema y { table t { id integer primary key } }');
			await db.exec('apply schema y');
			await db.exec('declare logical schema x { table t { id integer primary key, name text } }');
			await expectThrows(() => db.exec('apply schema x'), /logical column 'x\.t\.name' has no basis backing/i);
		} finally {
			await db.close();
		}
	});

	it('errors naming a logical table with no basis backing', async () => {
		const db = new Database();
		try {
			await db.exec('declare schema y { table t { id integer primary key } }');
			await db.exec('apply schema y');
			await db.exec('declare logical schema x { table q { id integer primary key } }');
			await expectThrows(() => db.exec('apply schema x'), /logical table 'x\.q' has no basis backing/i);
		} finally {
			await db.close();
		}
	});

	it('handles the empty-key (singleton) case as an ordinary single-source projection', async () => {
		const db = new Database();
		try {
			// Basis singleton in main (the only populated physical schema).
			await db.exec('create table config (theme text, primary key ())');
			await db.exec("insert into config values ('dark')");

			await db.exec('declare logical schema x { table config { theme text, primary key () } }');
			await db.exec('apply schema x');

			const result = await rows(db, 'select * from x.config');
			expect(result).to.deep.equal([{ theme: 'dark' }]);
		} finally {
			await db.close();
		}
	});
});

describe('lens foundation: physical-construct rejection', () => {
	it('rejects a module association on a logical table', async () => {
		const db = new Database();
		try {
			await db.exec('declare schema y { table t { id integer primary key } }');
			await db.exec('apply schema y');
			await db.exec('declare logical schema x { table t using memory() { id integer primary key } }');
			await expectThrows(() => db.exec('apply schema x'), /module association.*not allowed in logical schema/i);
		} finally {
			await db.close();
		}
	});

	it('rejects a declared index in a logical schema', async () => {
		const db = new Database();
		try {
			await db.exec('declare schema y { table t { id integer primary key, name text } }');
			await db.exec('apply schema y');
			await db.exec('declare logical schema x { table t { id integer primary key, name text } index ix on t (name) }');
			await expectThrows(() => db.exec('apply schema x'), /index 'ix' is not allowed in logical schema/i);
		} finally {
			await db.close();
		}
	});

	it('rejects a declared unique index in a logical schema', async () => {
		const db = new Database();
		try {
			await db.exec('declare schema y { table t { id integer primary key, name text } }');
			await db.exec('apply schema y');
			await db.exec('declare logical schema x { table t { id integer primary key, name text } unique index ix on t (name) }');
			await expectThrows(() => db.exec('apply schema x'), /unique index 'ix' is not allowed in logical schema/i);
		} finally {
			await db.close();
		}
	});

	it('rejects a declared materialized view in a logical schema', async () => {
		const db = new Database();
		try {
			await db.exec('declare schema y { table t { id integer primary key } }');
			await db.exec('apply schema y');
			await db.exec('declare logical schema x { table t { id integer primary key } materialized view mv as select id from t }');
			await expectThrows(() => db.exec('apply schema x'), /materialized view 'mv' is not allowed in logical schema/i);
		} finally {
			await db.close();
		}
	});

	it('allows tags on a logical table (engine-facing metadata)', async () => {
		const db = new Database();
		try {
			await db.exec('declare schema y { table t { id integer primary key } }');
			await db.exec('apply schema y');
			await db.exec(`declare logical schema x { table t { id integer primary key } with tags (layer = 'design') }`);
			await db.exec('apply schema x');
			const slot = db.schemaManager.getSchema('x')!.getLensSlot('t')!;
			expect(slot.logicalTable.tags).to.deep.equal({ layer: 'design' });
		} finally {
			await db.close();
		}
	});
});

describe('lens foundation: default-basis inference', () => {
	it('auto-binds when exactly one populated physical schema is in scope (main)', async () => {
		const db = new Database();
		try {
			await db.exec('create table t (id integer primary key, name text)');
			await db.exec("insert into t values (1, 'a')");
			await db.exec('declare logical schema x { table t { id integer primary key, name text } }');
			await db.exec('apply schema x');
			const slot = db.schemaManager.getSchema('x')!.getLensSlot('t')!;
			expect(slot.defaultBasis.schemaName).to.equal('main');
			const result = await rows(db, 'select * from x.t');
			expect(result).to.deep.equal([{ id: 1, name: 'a' }]);
		} finally {
			await db.close();
		}
	});

	it('errors with the over-hint when no populated physical schema is in scope', async () => {
		const db = new Database();
		try {
			// y is declared but never applied → no tables → not a candidate.
			await db.exec('declare schema y { table t { id integer primary key } }');
			await db.exec('declare logical schema x { table t { id integer primary key } }');
			await expectThrows(() => db.exec('apply schema x'), /cannot infer a default basis.*declare lens for x over/i);
		} finally {
			await db.close();
		}
	});

	it('errors with the over-hint when multiple populated physical schemas are in scope', async () => {
		const db = new Database();
		try {
			await db.exec('declare schema y { table t { id integer primary key } }');
			await db.exec('apply schema y');
			await db.exec('declare schema z { table t { id integer primary key } }');
			await db.exec('apply schema z');
			await db.exec('declare logical schema x { table t { id integer primary key } }');
			await expectThrows(() => db.exec('apply schema x'), /found 2 candidates.*declare lens for x over/i);
		} finally {
			await db.close();
		}
	});

	it('an explicit `declare lens for x over y` resolves the multi-candidate ambiguity', async () => {
		const db = new Database();
		try {
			await db.exec('declare schema y { table t { id integer primary key, name text } }');
			await db.exec('apply schema y');
			await db.exec("insert into y.t values (1, 'from-y')");
			await db.exec('declare schema z { table t { id integer primary key, name text } }');
			await db.exec('apply schema z');
			await db.exec("insert into z.t values (1, 'from-z')");

			await db.exec('declare logical schema x { table t { id integer primary key, name text } }');
			// With two physical bases the foundation cannot infer; the explicit
			// `over y` binding picks the basis and the apply succeeds against y.
			await db.exec('declare lens for x over y { }');
			await db.exec('apply schema x');

			const slot = db.schemaManager.getSchema('x')!.getLensSlot('t')!;
			expect(slot.defaultBasis.schemaName).to.equal('y');
			expect(await rows(db, 'select * from x.t')).to.deep.equal([{ id: 1, name: 'from-y' }]);
		} finally {
			await db.close();
		}
	});
});

describe('lens foundation: DDL round-trip', () => {
	it('round-trips `declare logical schema` through stringify + reparse', () => {
		const sql = 'declare logical schema x { table t { id integer primary key, name text } }';
		const ast1 = new Parser().parseAll(sql)[0] as AST.DeclareSchemaStmt;
		expect(ast1.type).to.equal('declareSchema');
		expect(ast1.isLogical, 'parsed AST flags logical').to.equal(true);

		const emitted = astToString(ast1);
		expect(emitted.toLowerCase()).to.match(/declare\s+logical\s+schema/);

		const ast2 = new Parser().parseAll(emitted)[0] as AST.DeclareSchemaStmt;
		expect(ast2.isLogical, 'reparsed AST flags logical').to.equal(true);
		expect(computeSchemaHash(ast2)).to.equal(computeSchemaHash(ast1));
	});

	it('a physical schema does not emit the logical keyword and hashes differently', () => {
		const physical = new Parser().parseAll('declare schema x { table t { id integer primary key } }')[0] as AST.DeclareSchemaStmt;
		const logical = new Parser().parseAll('declare logical schema x { table t { id integer primary key } }')[0] as AST.DeclareSchemaStmt;
		expect(astToString(physical).toLowerCase()).to.not.contain('logical');
		expect(computeSchemaHash(physical), 'kind flip changes the hash').to.not.equal(computeSchemaHash(logical));
	});
});

describe('lens foundation: differ asymmetric removal', () => {
	it('a removed logical table detaches its lens and never drops basis (basis hash unchanged)', async () => {
		const db = new Database();
		try {
			await db.exec('declare schema y { table t1 { id integer primary key } table t2 { id integer primary key } }');
			await db.exec('apply schema y');
			const basisHashBefore = computeSchemaHash(db.declaredSchemaManager.getDeclaredSchema('y')!);

			await db.exec('declare logical schema x { table t1 { id integer primary key } table t2 { id integer primary key } }');
			await db.exec('apply schema x');
			expect(db.schemaManager.getView('x', 't1'), 'lens t1 attached').to.not.be.undefined;
			expect(db.schemaManager.getView('x', 't2'), 'lens t2 attached').to.not.be.undefined;

			// Re-declare X dropping t2.
			await db.exec('declare logical schema x { table t1 { id integer primary key } }');
			const declaredX = db.declaredSchemaManager.getDeclaredSchema('x')!;
			const diff = computeSchemaDiff(declaredX, collectSchemaCatalog(db, 'x'));

			expect(diff.lensToDetach, 'detaches t2').to.deep.equal(['t2']);
			expect(diff.lensToAttach, 'nothing new to attach').to.deep.equal([]);
			expect(diff.tablesToDrop, 'never a basis-table drop').to.deep.equal([]);

			// The basis schema y is untouched: its declared hash is unchanged.
			const basisHashAfter = computeSchemaHash(db.declaredSchemaManager.getDeclaredSchema('y')!);
			expect(basisHashAfter, 'basis hash unchanged by a logical removal').to.equal(basisHashBefore);

			// Applying X detaches t2's lens; basis y.t2 still exists.
			await db.exec('apply schema x');
			expect(db.schemaManager.getView('x', 't2'), 'lens t2 detached').to.be.undefined;
			expect(db.schemaManager.getView('x', 't1'), 'lens t1 retained').to.not.be.undefined;
			expect(db.schemaManager.getTable('y', 't2'), 'basis y.t2 retained').to.not.be.undefined;
		} finally {
			await db.close();
		}
	});

	it('re-applying an emptied logical schema detaches all lenses even when the basis is now ambiguous', async () => {
		const db = new Database();
		try {
			// Single basis at first deploy.
			await db.exec('declare schema y { table t { id integer primary key } }');
			await db.exec('apply schema y');
			await db.exec('declare logical schema x { table t { id integer primary key } }');
			await db.exec('apply schema x');
			expect(db.schemaManager.getView('x', 't'), 'lens t attached').to.not.be.undefined;

			// Add a second populated physical schema → the default basis is now
			// ambiguous. Removal must NOT depend on basis inference, so re-applying
			// an emptied X is a pure detach, never a "cannot infer basis" error.
			await db.exec('create table z (id integer primary key)');
			await db.exec('insert into z values (1)');
			await db.exec('declare logical schema x { }');
			await db.exec('apply schema x');
			expect(db.schemaManager.getView('x', 't'), 'lens t detached on empty re-apply').to.be.undefined;
		} finally {
			await db.close();
		}
	});
});

describe('lens foundation: write-through (rides view updateability)', () => {
	it('insert / update / delete through a logical lens table propagate to basis', async () => {
		const db = new Database();
		try {
			await db.exec('declare schema y { table t { id integer primary key, name text } }');
			await db.exec('apply schema y');
			await db.exec("insert into y.t values (1, 'alpha')");
			await db.exec('declare logical schema x { table t { id integer primary key, name text } }');
			await db.exec('apply schema x');

			// Insert through the lens lands in the basis.
			await db.exec("insert into x.t values (2, 'beta')");
			expect(await rows(db, 'select * from y.t order by id')).to.deep.equal([
				{ id: 1, name: 'alpha' },
				{ id: 2, name: 'beta' },
			]);

			// Update + delete through the lens mutate the basis.
			await db.exec("update x.t set name = 'BETA' where id = 2");
			await db.exec('delete from x.t where id = 1');
			expect(await rows(db, 'select * from y.t order by id')).to.deep.equal([{ id: 2, name: 'BETA' }]);
		} finally {
			await db.close();
		}
	});
});

describe('lens foundation: column-name contract', () => {
	it('output column names follow the LOGICAL declaration, not basis casing', async () => {
		const db = new Database();
		try {
			// Basis spells the columns ID / Name; the logical contract is id / name.
			await db.exec('declare schema y { table T { ID integer primary key, Name text } }');
			await db.exec('apply schema y');
			await db.exec("insert into y.t values (1, 'alpha')");
			await db.exec('declare logical schema x { table t { id integer primary key, name text } }');
			await db.exec('apply schema x');

			// `select *` surfaces the logical names (the consumer-facing contract),
			// pinned via the registered view's explicit column list — the basis
			// casing must not leak through.
			expect(await rows(db, 'select * from x.t')).to.deep.equal([{ id: 1, name: 'alpha' }]);

			const view = db.schemaManager.getView('x', 't')!;
			expect(view.columns, 'lens view carries the logical column names').to.deep.equal(['id', 'name']);
		} finally {
			await db.close();
		}
	});
});
