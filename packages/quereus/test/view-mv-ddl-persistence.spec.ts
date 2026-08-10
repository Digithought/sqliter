/**
 * Engine-side support for persisting (materialized) views in a store-backed catalog.
 *
 * Pins the three engine facts the store package consumes (sibling ticket
 * `store-view-mv-catalog-persistence`), exercised here without the store:
 *
 *   1. A plain `CREATE VIEW` / `DROP VIEW` fires `view_added` / `view_removed`
 *      from the runtime emitters (so a store catalog can persist incrementally),
 *      and the `IF [NOT] EXISTS` no-ops fire nothing. Internal `schema.addView`
 *      callers (lens bodies) are deliberately NOT covered — they never route
 *      through the emitter, so no event fires for them.
 *   2. `generateViewDDL` / `generateMaintainedTableDDL` emit fully-qualified,
 *      tag-carrying, re-parseable DDL (a parse→generate→parse fixed point) so a
 *      `view_modified` (SET TAGS, which leaves the stored `sql` stale) round-trips.
 *   3. `SchemaManager.importCatalog` silently registers a plain view from its DDL
 *      without planning the body (queryable, body validation deferred) and names
 *      it in the `.views` result. A materialized view imports through the same
 *      entry point by re-materializing (shared `materializeView` core): the
 *      backing is rebuilt and filled, row-time maintenance re-registers, the name
 *      lands in `.materializedViews` — and no `materialized_view_added` fires.
 */

import { expect } from 'chai';
import { Database } from '../src/core/database.js';
import { generateViewDDL, generateMaintainedTableDDL } from '../src/schema/ddl-generator.js';
import { parse } from '../src/parser/index.js';
import { bodyDefaults, computeBodyHash, normalizeBackingModule, type ViewSchema } from '../src/schema/view.js';
import { isMaintainedTable, type MaintainedTableSchema } from '../src/schema/derivation.js';
import { buildColumnIndexMap, columnDefToSchema, findPKDefinition, type TableSchema } from '../src/schema/table.js';
import { viewDefinitionToCanonicalString } from '../src/emit/ast-stringify.js';
import type { SchemaChangeEvent } from '../src/schema/change-events.js';
import { MemoryTableModule } from '../src/vtab/memory/module.js';

async function rows(db: Database, sql: string): Promise<Record<string, unknown>[]> {
	const out: Record<string, unknown>[] = [];
	for await (const r of db.eval(sql)) out.push(r as Record<string, unknown>);
	return out;
}

/** Narrow a table-typed event payload to the maintained-table shape the MV DDL generator reads. */
function asMaintained(t: TableSchema): MaintainedTableSchema {
	if (!isMaintainedTable(t)) throw new Error('expected a maintained table (derivation missing)');
	return t;
}

/** Collect every schema-change event a database fires while `fn` runs. */
async function captureEvents(db: Database, fn: () => Promise<void>): Promise<SchemaChangeEvent[]> {
	const events: SchemaChangeEvent[] = [];
	const off = db.schemaManager.getChangeNotifier().addListener(e => events.push(e));
	try {
		await fn();
	} finally {
		off();
	}
	return events;
}

describe('view persistence: view_added / view_removed lifecycle events', () => {
	it('CREATE VIEW fires a single view_added carrying the view schema', async () => {
		const db = new Database();
		try {
			const events = await captureEvents(db, () =>
				db.exec("create view v as select 1 as a with tags (purpose = 'test')"));
			const added = events.filter(e => e.type === 'view_added');
			expect(added, 'one view_added').to.have.length(1);
			expect(added[0].objectName).to.equal('v');
			expect(added[0].schemaName).to.equal('main');
			// The event carries the live ViewSchema (incl. tags) the store persists.
			const ev = added[0];
			if (ev.type === 'view_added') {
				expect(ev.newObject.name).to.equal('v');
				expect(ev.newObject.tags).to.deep.equal({ purpose: 'test' });
			}
		} finally {
			await db.close();
		}
	});

	it('DROP VIEW fires a single view_removed carrying the old schema', async () => {
		const db = new Database();
		try {
			await db.exec('create view v as select 1 as a');
			const events = await captureEvents(db, () => db.exec('drop view v'));
			const removed = events.filter(e => e.type === 'view_removed');
			expect(removed, 'one view_removed').to.have.length(1);
			expect(removed[0].objectName).to.equal('v');
			const ev = removed[0];
			if (ev.type === 'view_removed') {
				expect(ev.oldObject.name).to.equal('v');
			}
		} finally {
			await db.close();
		}
	});

	it('CREATE VIEW IF NOT EXISTS on an existing view fires no view_added (no-op)', async () => {
		const db = new Database();
		try {
			await db.exec('create view v as select 1 as a');
			const events = await captureEvents(db, () =>
				db.exec('create view if not exists v as select 2 as a'));
			expect(events.filter(e => e.type === 'view_added'), 'no event on the no-op').to.have.length(0);
		} finally {
			await db.close();
		}
	});

	it('DROP VIEW IF EXISTS on a missing view fires no view_removed (no-op)', async () => {
		const db = new Database();
		try {
			const events = await captureEvents(db, () => db.exec('drop view if exists nope'));
			expect(events.filter(e => e.type === 'view_removed'), 'no event on the no-op').to.have.length(0);
		} finally {
			await db.close();
		}
	});
});

describe('view persistence: importCatalog silent view registration', () => {
	it('registers a queryable view with tags, names it in .views, fires no event', async () => {
		const db = new Database();
		try {
			const events = await captureEvents(db, async () => {
				const result = await db.schemaManager.importCatalog([
					"create view v as select 1 as a, 2 as b with tags (purpose = 'test')",
				]);
				expect(result.views, 'view named in the result').to.deep.equal(['main.v']);
				expect(result.tables).to.deep.equal([]);
				expect(result.indexes).to.deep.equal([]);
			});
			// Silent — import must not re-emit a persistence event.
			expect(events.filter(e => e.type === 'view_added'), 'import is silent').to.have.length(0);

			// Registered with tags…
			const view = db.schemaManager.getView('main', 'v');
			expect(view?.tags).to.deep.equal({ purpose: 'test' });
			// …and queryable (the body planned lazily on first reference).
			expect(await rows(db, 'select a, b from v')).to.deep.equal([{ a: 1, b: 2 }]);
		} finally {
			await db.close();
		}
	});

	it('a view whose body references a not-yet-imported relation imports without throwing', async () => {
		const db = new Database();
		try {
			// `missing` does not exist — import must defer body validation to query time.
			const result = await db.schemaManager.importCatalog(['create view v as select * from missing']);
			expect(result.views).to.deep.equal(['main.v']);
			expect(db.schemaManager.getView('main', 'v'), 'view registered despite unresolved body').to.exist;
		} finally {
			await db.close();
		}
	});

	it('rehydrates the with defaults clause — write-through supplies the defaulted column', async () => {
		const db = new Database();
		try {
			await db.exec('create table t (id integer primary key, name text, created integer not null)');
			const result = await db.schemaManager.importCatalog([
				'create view v as select id, name from t with defaults (created = 999)',
			]);
			expect(result.views).to.deep.equal(['main.v']);
			const schema = db.schemaManager.getView('main', 'v');
			const defaults = schema ? bodyDefaults(schema.selectAst) : undefined;
			expect(defaults, 'clause survives rehydration').to.have.length(1);
			expect(defaults?.[0].column).to.equal('created');
			// The rehydrated clause drives write-through: the omitted not-null column fills.
			await db.exec("insert into v values (1, 'x')");
			expect(await rows(db, 'select id, name, created from t'))
				.to.deep.equal([{ id: 1, name: 'x', created: 999 }]);
		} finally {
			await db.close();
		}
	});

	it('a view over another (later-imported) view imports order-independently', async () => {
		const db = new Database();
		try {
			// v_outer references v_inner, but v_outer is imported FIRST.
			const result = await db.schemaManager.importCatalog([
				'create view v_outer as select a from v_inner',
				'create view v_inner as select 7 as a',
			]);
			expect(result.views).to.deep.equal(['main.v_outer', 'main.v_inner']);
			expect(await rows(db, 'select a from v_outer')).to.deep.equal([{ a: 7 }]);
		} finally {
			await db.close();
		}
	});

});

describe('view persistence: importCatalog materialized-view re-materialization', () => {
	it('rebuilds + fills the backing, keeps maintenance live, names it in .materializedViews, fires no event', async () => {
		const db = new Database();
		try {
			await db.exec('create table base (id integer primary key, v integer)');
			await db.exec('insert into base values (1, 10), (2, 20)');

			const events = await captureEvents(db, async () => {
				const result = await db.schemaManager.importCatalog([
					"create materialized view mv as select id, v from base with tags (purpose = 'test')",
				]);
				expect(result.materializedViews, 'MV named in the result').to.deep.equal(['main.mv']);
				expect(result.tables).to.deep.equal([]);
				expect(result.views).to.deep.equal([]);
			});
			// Silent — import must not re-emit a persistence event for the MV itself.
			expect(events.filter(e => e.type === 'materialized_view_added'), 'import is silent').to.have.length(0);

			// Registered with tags, and the maintained table was rebuilt and filled.
			const mv = db.schemaManager.getMaintainedTable('main', 'mv');
			expect(mv?.tags).to.deep.equal({ purpose: 'test' });
			expect(db.schemaManager.getTable('main', 'mv'), 'maintained table registered under the MV name').to.exist;
			expect(await rows(db, 'select id, v from mv order by id'))
				.to.deep.equal([{ id: 1, v: 10 }, { id: 2, v: 20 }]);

			// Row-time maintenance is live: a post-import source write maintains the backing.
			await db.exec('insert into base values (3, 30)');
			await db.exec('update base set v = 99 where id = 1');
			await db.exec('delete from base where id = 2');
			expect(await rows(db, 'select id, v from mv order by id'))
				.to.deep.equal([{ id: 1, v: 99 }, { id: 3, v: 30 }]);
		} finally {
			await db.close();
		}
	});

	it('rehydrates the with defaults clause — MV write-through supplies the defaulted source column', async () => {
		const db = new Database();
		try {
			await db.exec('create table t (id integer primary key, name text, created integer not null)');
			const result = await db.schemaManager.importCatalog([
				'create materialized view mv as select id, name from t with defaults (created = 777)',
			]);
			expect(result.materializedViews).to.deep.equal(['main.mv']);
			const schema = db.schemaManager.getMaintainedTable('main', 'mv');
			const defaults = schema ? bodyDefaults(schema.derivation.selectAst) : undefined;
			expect(defaults, 'clause survives re-materialization').to.have.length(1);
			expect(defaults?.[0].column).to.equal('created');
			await db.exec("insert into mv values (1, 'a')");
			expect(await rows(db, 'select id, name, created from t'))
				.to.deep.equal([{ id: 1, name: 'a', created: 777 }]);
			// Reads-own-writes: backing maintenance projected the defaulted source row.
			expect(await rows(db, 'select id, name from mv order by id'))
				.to.deep.equal([{ id: 1, name: 'a' }]);
		} finally {
			await db.close();
		}
	});

	it('an MV over another MV imports when its producer precedes it (rehydrate order contract)', async () => {
		const db = new Database();
		try {
			await db.exec('create table base (id integer primary key, v integer)');
			await db.exec('insert into base values (1, 10), (2, 20)');
			const result = await db.schemaManager.importCatalog([
				'create materialized view inner_mv as select id, v from base',
				'create materialized view outer_mv as select id, v from inner_mv',
			]);
			expect(result.materializedViews).to.deep.equal(['main.inner_mv', 'main.outer_mv']);
			expect(await rows(db, 'select id, v from outer_mv order by id'))
				.to.deep.equal([{ id: 1, v: 10 }, { id: 2, v: 20 }]);
			// Maintenance cascades up the imported chain.
			await db.exec('insert into base values (3, 30)');
			expect(await rows(db, 'select id, v from outer_mv order by id'))
				.to.deep.equal([{ id: 1, v: 10 }, { id: 2, v: 20 }, { id: 3, v: 30 }]);
		} finally {
			await db.close();
		}
	});

	it('an ineligible body (non-deterministic column) fails the import and rolls back cleanly', async () => {
		const db = new Database();
		try {
			await db.exec('create table base (id integer primary key, v integer)');
			await db.exec('insert into base values (1, 10)');
			let threw = false;
			try {
				// random() plans and fills fine but fails the row-time eligibility gate
				// in registerMaterializedView — un-creatable via SQL, but a catalog entry
				// could carry it; the store records the throw as a per-entry error.
				await db.schemaManager.importCatalog([
					'create materialized view mv as select id, random() as r from base',
				]);
			} catch (e) {
				threw = true;
				expect((e as Error).message).to.match(/non-deterministic/i);
			}
			expect(threw, 'eligibility gate fails the import').to.equal(true);
			// Rolled back: neither the MV record nor its half-built backing remain.
			expect(db.schemaManager.getMaintainedTable('main', 'mv')).to.be.undefined;
			expect(db.schemaManager.getTable('main', 'mv')).to.be.undefined;
		} finally {
			await db.close();
		}
	});

	it('a duplicate-producing body fails the fill with the "must be a set" diagnostic and rolls back', async () => {
		const db = new Database();
		try {
			await db.exec('create table base (id integer primary key, v integer)');
			await db.exec('insert into base values (1, 10), (2, 10)');
			let threw = false;
			try {
				// Projecting only the non-key column produces duplicate rows under the
				// all-columns fallback key — the fill's duplicate-key gate throws.
				await db.schemaManager.importCatalog(['create materialized view mv as select v from base']);
			} catch (e) {
				threw = true;
				expect((e as Error).message).to.match(/must be a set/i);
			}
			expect(threw, 'fill gate fails the import').to.equal(true);
			expect(db.schemaManager.getMaintainedTable('main', 'mv')).to.be.undefined;
			expect(db.schemaManager.getTable('main', 'mv')).to.be.undefined;
		} finally {
			await db.close();
		}
	});

	it('a DML body is rejected before materializing — the mutation never executes', async () => {
		const db = new Database();
		try {
			await db.exec('create table base (id integer primary key, v integer)');
			await db.exec('insert into base values (1, 10), (2, 20)');
			let threw = false;
			try {
				// Parses (the MV grammar accepts any QueryExpr with RETURNING) but is
				// un-creatable — planViewBody rejects it at build time. Import must
				// reject it too, BEFORE the fill would execute the delete.
				await db.schemaManager.importCatalog([
					'create materialized view mv as delete from base returning *',
				]);
			} catch (e) {
				threw = true;
				expect((e as Error).message).to.match(/cannot be used as a materialized view body/i);
			}
			expect(threw, 'DML body fails the import').to.equal(true);
			expect(db.schemaManager.getMaintainedTable('main', 'mv')).to.be.undefined;
			expect(db.schemaManager.getTable('main', 'mv')).to.be.undefined;
			// Crucially: the source rows were NOT deleted by the rejected import.
			expect(await rows(db, 'select id, v from base order by id'))
				.to.deep.equal([{ id: 1, v: 10 }, { id: 2, v: 20 }]);
		} finally {
			await db.close();
		}
	});

	it('a declared-column arity mismatch fails the import and rolls back', async () => {
		const db = new Database();
		try {
			await db.exec('create table base (id integer primary key, v integer)');
			let threw = false;
			try {
				// Un-creatable (the builder validates arity) but a corrupt catalog entry
				// could carry it; the derive-shape gate rejects it on import.
				await db.schemaManager.importCatalog([
					'create materialized view mv (a, b, c) as select id, v from base',
				]);
			} catch (e) {
				threw = true;
				expect((e as Error).message).to.match(/3 declared columns but body produces 2/i);
			}
			expect(threw, 'arity gate fails the import').to.equal(true);
			expect(db.schemaManager.getMaintainedTable('main', 'mv')).to.be.undefined;
			expect(db.schemaManager.getTable('main', 'mv')).to.be.undefined;
		} finally {
			await db.close();
		}
	});
});

describe('view persistence: importCatalog honors the MV backing-module clause', () => {
	it('`using mem2()` materializes the backing in mem2 with maintenance live', async () => {
		const db = new Database();
		const mem2 = new MemoryTableModule();
		db.registerModule('mem2', mem2);
		try {
			await db.exec('create table base (id integer primary key, v integer)');
			await db.exec('insert into base values (1, 10)');
			const result = await db.schemaManager.importCatalog([
				'create materialized view mv using mem2 as select id, v from base',
			]);
			expect(result.materializedViews).to.deep.equal(['main.mv']);

			const mv = db.schemaManager.getMaintainedTable('main', 'mv')!;
			expect(normalizeBackingModule(mv.vtabModuleName, mv.vtabArgs).storedModuleName, 'clause honored on the rehydrated record').to.equal('mem2');
			expect(db.schemaManager.getTable('main', 'mv')!.vtabModuleName).to.equal('mem2');
			expect(mem2.tables.has('main.mv'), 'backing in mem2').to.equal(true);
			expect(generateMaintainedTableDDL(mv), 'regenerated DDL keeps the clause').to.match(/using mem2/i);

			await db.exec('insert into base values (2, 20)');
			expect(await rows(db, 'select id, v from mv order by id'))
				.to.deep.equal([{ id: 1, v: 10 }, { id: 2, v: 20 }]);
		} finally {
			await db.close();
		}
	});

	it('an unknown-module entry fails per-entry, leaving sources untouched and no half-built backing', async () => {
		const db = new Database();
		try {
			await db.exec('create table base (id integer primary key, v integer)');
			await db.exec('insert into base values (1, 10)');
			let threw = false;
			try {
				await db.schemaManager.importCatalog([
					'create materialized view mv using nosuch() as select id, v from base',
				]);
			} catch (e) {
				threw = true;
				expect((e as Error).message).to.match(/no virtual table module named 'nosuch'/i);
			}
			expect(threw, 'unknown module fails the entry').to.equal(true);
			expect(db.schemaManager.getMaintainedTable('main', 'mv')).to.be.undefined;
			expect(db.schemaManager.getTable('main', 'mv')).to.be.undefined;
			expect(await rows(db, 'select id, v from base')).to.deep.equal([{ id: 1, v: 10 }]);
		} finally {
			await db.close();
		}
	});

	it('a pre-existing same-named table in the MV\'s OWN module is dropped and re-materialized', async () => {
		const db = new Database();
		const mem2 = new MemoryTableModule();
		db.registerModule('mem2', mem2);
		try {
			await db.exec('create table base (id integer primary key, v integer)');
			await db.exec('insert into base values (1, 10)');
			// Simulate a durable backing-host module that rehydrated the maintained
			// table itself (phase 1: a plain `create table mv` bundle) before the MV
			// catalog entry imports (phase 3), with stale contents the refill must replace.
			await db.exec('create table mv (id integer primary key, v integer) using mem2');
			await db.exec('insert into mv values (99, 99)');

			const result = await db.schemaManager.importCatalog([
				'create materialized view mv using mem2 as select id, v from base',
			]);
			expect(result.materializedViews).to.deep.equal(['main.mv']);
			// Refilled from the body — the stale rehydrated rows are gone.
			expect(await rows(db, 'select id, v from mv order by id')).to.deep.equal([{ id: 1, v: 10 }]);
			expect(db.schemaManager.getTable('main', 'mv')!.vtabModuleName).to.equal('mem2');
		} finally {
			await db.close();
		}
	});

	it('a pre-existing same-named table in a DIFFERENT module fails the entry without dropping it', async () => {
		const db = new Database();
		const mem2 = new MemoryTableModule();
		db.registerModule('mem2', mem2);
		try {
			await db.exec('create table base (id integer primary key, v integer)');
			// A user table that merely collides with the MV name, in the
			// DEFAULT memory module — not the MV's declared mem2 backing.
			await db.exec('create table mv (id integer primary key, v integer)');
			await db.exec('insert into mv values (7, 7)');

			let threw = false;
			try {
				await db.schemaManager.importCatalog([
					'create materialized view mv using mem2 as select id, v from base',
				]);
			} catch (e) {
				threw = true;
				expect((e as Error).message).to.match(/already exists in module 'memory', not the MV's backing module 'mem2'/i);
			}
			expect(threw, 'other-module collision fails the entry').to.equal(true);
			expect(db.schemaManager.getMaintainedTable('main', 'mv')).to.be.undefined;
			// The colliding table (and its data) is NOT ours to drop.
			expect(await rows(db, 'select id, v from mv')).to.deep.equal([{ id: 7, v: 7 }]);
		} finally {
			await db.close();
		}
	});

	it('an ineligible body rolls the half-built backing out of the NAMED module on import', async () => {
		const db = new Database();
		const mem2 = new MemoryTableModule();
		db.registerModule('mem2', mem2);
		try {
			await db.exec('create table base (id integer primary key, v integer)');
			await db.exec('insert into base values (1, 10)');
			let threw = false;
			try {
				// random() plans and fills fine (the mem2 backing is created) but fails
				// the row-time eligibility gate in registerMaterializedView — the
				// rollback must drop the backing from mem2, not the default module.
				await db.schemaManager.importCatalog([
					'create materialized view mv using mem2 as select id, random() as r from base',
				]);
			} catch (e) {
				threw = true;
				expect((e as Error).message).to.match(/non-deterministic/i);
			}
			expect(threw, 'eligibility gate fails the import').to.equal(true);
			expect(db.schemaManager.getMaintainedTable('main', 'mv')).to.be.undefined;
			expect(db.schemaManager.getTable('main', 'mv')).to.be.undefined;
			expect(mem2.tables.has('main.mv'),
				'no half-built backing left in mem2').to.equal(false);
		} finally {
			await db.close();
		}
	});

	it('a hand-written `using memory()` entry rehydrates to the clause-free canonical record', async () => {
		const db = new Database();
		try {
			await db.exec('create table base (id integer primary key, v integer)');
			const result = await db.schemaManager.importCatalog([
				'create materialized view mv using memory() as select id, v from base',
			]);
			expect(result.materializedViews).to.deep.equal(['main.mv']);
			const mv = db.schemaManager.getMaintainedTable('main', 'mv')!;
			expect(normalizeBackingModule(mv.vtabModuleName, mv.vtabArgs).storedModuleName, 'explicit default normalizes to absent').to.be.undefined;
			expect(generateMaintainedTableDDL(mv), 'canonical DDL renders clause-free').to.not.match(/using/i);
		} finally {
			await db.close();
		}
	});
});

// ============================================================================
// generateViewDDL / generateMaintainedTableDDL parse→generate→parse fixed point.
//
// The generators read the LIVE schema (tags included) and emit fully-qualified,
// re-parseable DDL. A `view_modified` / `materialized_view_modified` swaps the
// in-memory schema without rewriting the stored `sql`, so the generators — not the
// stale `sql` — are what a store regenerates and re-persists. The matrix covers the
// tag / column / body shapes that must survive that round-trip.
// ============================================================================

/** Lift a `create view` DDL string into the minimal ViewSchema the generator reads. */
function viewSchemaFromDDL(ddl: string): ViewSchema {
	const stmt = parse(ddl);
	if (stmt.type !== 'createView') throw new Error(`not a create view: ${stmt.type}`);
	return {
		name: stmt.view.name,
		schemaName: stmt.view.schema ?? 'main',
		sql: ddl,
		// Any `with defaults (…)` rides inside stmt.select (→ selectAst).
		selectAst: stmt.select,
		columns: stmt.columns ? [...stmt.columns] : undefined,
		tags: stmt.tags,
	};
}

/** Lift a maintained-table DDL — EITHER authoring form: the `create
 *  materialized view` sugar or the canonical `create table … maintained as`
 *  table form the generator emits — into the minimal maintained-table record
 *  (`TableSchema` + `derivation`) the generator reads. The sugar lift stubs
 *  the declared table columns (the generator renders whatever the TableSchema
 *  carries, so the empty stub round-trips as the singleton `PRIMARY KEY ()`
 *  form); the table-form lift carries its declared columns/PK faithfully via
 *  the shared schema helpers, so the generator's own output re-lifts to a
 *  fixed point. The backing module goes through the same
 *  `normalizeBackingModule` the create builder applies, so `using memory()`
 *  lifts to the clause-free record. */
function mvSchemaFromDDL(ddl: string): MaintainedTableSchema {
	const stmt = parse(ddl);
	if (stmt.type === 'createMaterializedView') {
		const backing = normalizeBackingModule(stmt.moduleName, stmt.moduleArgs);
		return {
			name: stmt.view.name,
			schemaName: stmt.view.schema ?? 'main',
			columns: [],
			columnIndexMap: new Map(),
			primaryKeyDefinition: [],
			checkConstraints: [],
			vtabModuleName: backing.moduleName,
			vtabArgs: backing.storedModuleArgs ? { ...backing.storedModuleArgs } : undefined,
			isView: false,
			tags: stmt.tags,
			derivation: {
				// Any `with defaults (…)` rides inside stmt.select (→ selectAst).
				selectAst: stmt.select,
				columns: stmt.columns ? [...stmt.columns] : undefined,
				bodyHash: '',
				logicalKey: [],
				sourceTables: [],
			},
		};
	}
	if (stmt.type === 'createTable' && stmt.maintained) {
		const backing = normalizeBackingModule(stmt.moduleName, stmt.moduleArgs);
		// Generated DDL always annotates nullability explicitly (no session
		// default), so the defaultNotNull parameter is never consulted here.
		const columns = stmt.columns.map(c => columnDefToSchema(c));
		const { pkDef } = findPKDefinition(columns, stmt.constraints);
		return {
			name: stmt.table.name,
			schemaName: stmt.table.schema ?? 'main',
			columns,
			columnIndexMap: buildColumnIndexMap(columns),
			primaryKeyDefinition: [...pkDef],
			checkConstraints: [],
			vtabModuleName: backing.moduleName,
			vtabArgs: backing.storedModuleArgs ? { ...backing.storedModuleArgs } : undefined,
			isView: false,
			tags: stmt.tags,
			derivation: {
				selectAst: stmt.maintained.select,
				// The rename list rides the `maintained [(columns)]` clause (lossless),
				// not the declared column list — its presence/absence distinguishes an
				// explicit rename from an implicit body across the round-trip.
				columns: stmt.maintained.columns && stmt.maintained.columns.length > 0
					? [...stmt.maintained.columns]
					: undefined,
				bodyHash: '',
				logicalKey: [],
				sourceTables: [],
			},
		};
	}
	throw new Error(`not a maintained-table DDL: ${stmt.type}`);
}

/** The tag / column / body matrix, parameterized by the CREATE keyword. */
function matrix(kind: 'view' | 'materialized view'): { name: string; ddl: string }[] {
	const k = `create ${kind} v`;
	return [
		{ name: 'no tags', ddl: `${k} as select 1 as a` },
		{ name: 'single tag', ddl: `${k} as select 1 as a with tags (k = 'v')` },
		{ name: 'multiple tags', ddl: `${k} as select 1 as a with tags (k1 = 'v1', k2 = 2, k3 = true)` },
		{ name: 'reserved quereus.update.* tag key (quoted)', ddl: `${k} as select 1 as a with tags ("quereus.update.deny" = true)` },
		{ name: 'explicit column list', ddl: `${k} (x, y) as select 1, 2` },
		{ name: 'compound-SELECT body', ddl: `${k} as select 1 as a union all select 2 as a` },
		{ name: 'VALUES body', ddl: `${k} as values (1, 2), (3, 4)` },
		{ name: 'with defaults clause', ddl: `${k} as select 1 as a with defaults (created = 42 + 1)` },
		{ name: 'with defaults clause + tags', ddl: `${k} as select 1 as a with defaults (c1 = 7, c2 = epoch_ms('now')) with tags (k = 'v')` },
	];
}

describe('view persistence: generateViewDDL fixed point', () => {
	const gen = (ddl: string) => generateViewDDL(viewSchemaFromDDL(ddl));

	it('always emits a fully-qualified (schema.name) view name', () => {
		// Qualification is unconditional; bare-valid names stay unquoted (main.v).
		expect(gen('create view v as select 1 as a')).to.match(/^create view main\.v /i);
	});

	for (const { name, ddl } of matrix('view')) {
		it(`re-parses and is a fixed point: ${name}`, () => {
			const once = gen(ddl);
			expect(parse(once).type, 'generated DDL re-parses to createView').to.equal('createView');
			expect(gen(once), 'generate is a fixed point over its own re-parse').to.equal(once);
		});
	}

	it('preserves tags, columns, and body shape through the round-trip', () => {
		const tagged = parse(gen("create view v as select 1 as a with tags (k1 = 'v1', \"quereus.update.deny\" = true)"));
		if (tagged.type === 'createView') {
			expect(tagged.tags).to.deep.equal({ k1: 'v1', 'quereus.update.deny': true });
		}
		const cols = parse(gen('create view v (x, y) as select 1, 2'));
		if (cols.type === 'createView') expect(cols.columns).to.deep.equal(['x', 'y']);
		const vals = parse(gen('create view v as values (1, 2)'));
		if (vals.type === 'createView') expect(vals.select.type).to.equal('values');
	});
});

describe('view persistence: generateMaintainedTableDDL fixed point', () => {
	const gen = (ddl: string) => generateMaintainedTableDDL(mvSchemaFromDDL(ddl));

	it('emits the canonical fully-qualified TABLE form; explicit-default USING normalizes away', () => {
		const ddl = gen('create materialized view v using memory as select 1 as a');
		// The one canonical form for every maintained table is
		// `create table … maintained as`, regardless of the authoring surface.
		expect(ddl).to.match(/^create table "main"\."v" /i);
		expect(ddl).to.match(/ maintained as select 1 as a$/i);
		expect(ddl, '`using memory()` ≡ omitted — the default backing stays clause-free').to.not.match(/using/i);
		expect(gen('create materialized view v using mem as select 1 as a'), '`mem` aliases to memory').to.not.match(/using/i);
	});

	it('emits the USING clause for a non-default backing module and is a fixed point', () => {
		const once = gen('create materialized view v using mem2 as select 1 as a');
		expect(once, 'non-default module round-trips the clause').to.match(/using mem2/i);
		const reparsed = parse(once);
		expect(reparsed.type).to.equal('createTable');
		expect(reparsed.type === 'createTable' && reparsed.maintained, 'carries the maintained clause').to.exist;
		expect(gen(once), 'fixed point over its own re-parse').to.equal(once);
	});

	it('emits USING with args (non-default module, and the explicit-memory-with-args corner)', () => {
		const withArgs = gen("create materialized view v using mem2 (k = 'x') as select 1 as a");
		expect(withArgs).to.match(/using mem2 \(k = /i);
		expect(gen(withArgs), 'fixed point with args').to.equal(withArgs);
		// Explicit memory WITH args is the one default-module case that keeps the clause.
		const memArgs = gen("create materialized view v using memory (k = 'x') as select 1 as a");
		expect(memArgs).to.match(/using memory \(k = /i);
		expect(gen(memArgs), 'fixed point for memory-with-args').to.equal(memArgs);
	});

	for (const { name, ddl } of matrix('materialized view')) {
		it(`re-parses and is a fixed point: ${name}`, () => {
			const once = gen(ddl);
			const reparsed = parse(once);
			expect(reparsed.type, 'generated DDL re-parses to the canonical table form').to.equal('createTable');
			expect(reparsed.type === 'createTable' && reparsed.maintained, 'carries the maintained clause').to.exist;
			expect(gen(once), 'generate is a fixed point over its own re-parse').to.equal(once);
		});
	}

	it('preserves tags and body shape through the round-trip', () => {
		const tagged = parse(gen("create materialized view v as select 1 as a with tags (k1 = 'v1')"));
		if (tagged.type === 'createTable') expect(tagged.tags).to.deep.equal({ k1: 'v1' });
		const vals = parse(gen('create materialized view v as values (1, 2), (3, 4)'));
		if (vals.type === 'createTable') expect(vals.maintained?.select.type).to.equal('values');
		// An explicit MV column list (renames) becomes the table's DECLARED column
		// names in the canonical form; the synthetic lift here stubs the declared
		// columns, so that leg is pinned against a LIVE schema instead — see
		// maintained-table-attach-detach.spec.ts ('MV sugar with an explicit
		// column list round-trips through the table form').
	});
});

// ============================================================================
// Table-form-AUTHORED rows: the canonical `create table … maintained [(columns)] as`
// input directly (not via the MV sugar). `mvSchemaFromDDL` lifts the declared
// columns/PK faithfully and reads `derivation.columns` from the `maintained
// [(columns)]` clause — present ⇒ explicit (the clause round-trips), absent ⇒
// implicit (the body reshapes its source on reopen, so the clause stays omitted).
// This pins the parser → generator fixed point of both authored channels.
// ============================================================================
describe('view persistence: generateMaintainedTableDDL fixed point — table-form authored', () => {
	const gen = (ddl: string) => generateMaintainedTableDDL(mvSchemaFromDDL(ddl));

	const tableForm = [
		{ name: 'implicit (no rename list)', ddl: 'create table v ("a" integer primary key) maintained as select 1 as a', list: false },
		{ name: 'explicit rename list', ddl: 'create table v ("a" integer primary key) maintained (a) as select 1 as a', list: true },
		{ name: 'explicit multi-column rename list', ddl: 'create table v ("key_id" integer primary key, "val" integer) maintained (key_id, val) as select id, v from src', list: true },
	];

	for (const { name, ddl, list } of tableForm) {
		it(`re-parses, is a fixed point, and ${list ? 'keeps' : 'omits'} the clause: ${name}`, () => {
			const once = gen(ddl);
			const reparsed = parse(once);
			expect(reparsed.type, 'generated DDL re-parses to the canonical table form').to.equal('createTable');
			expect(reparsed.type === 'createTable' && reparsed.maintained, 'carries the maintained clause').to.exist;
			expect(gen(once), 'generate is a fixed point over its own re-parse').to.equal(once);
			// The clause presence is the lossless implicit/explicit signal.
			if (list) {
				expect(once, 'explicit ⇒ the rename list rides the clause').to.match(/maintained \(/i);
			} else {
				expect(once, 'implicit ⇒ no rename list').to.not.match(/maintained \(/i);
				expect(once, 'implicit keeps the bare `maintained as`').to.match(/maintained as /i);
			}
		});
	}
});

// ============================================================================
// The matrix above feeds the generators parser-derived schemas. These two tests
// instead exercise them against a LIVE-created schema — the schema a store would
// actually regenerate. A live MV's `selectAst` is the raw parsed body (the create
// emitter stores `plan.selectStmt`, NOT the optimized form), so the generators see
// the same shape; this proves that end-to-end by regenerating DDL from the live
// schema and rehydrating it into a fresh database.
// ============================================================================

describe('view persistence: generators over LIVE-created schemas', () => {
	it('generateViewDDL on a live CREATE VIEW rehydrates faithfully into a fresh database', async () => {
		const src = new Database();
		const dst = new Database();
		try {
			await src.exec("create view v as select 1 as a, 2 as b with tags (purpose = 'live')");
			const view = src.schemaManager.getView('main', 'v');
			expect(view, 'live view registered').to.exist;
			const ddl = generateViewDDL(view!);
			expect(parse(ddl).type, 'generated DDL re-parses to createView').to.equal('createView');

			await dst.exec(ddl);
			const rehydrated = dst.schemaManager.getView('main', 'v');
			expect(rehydrated?.tags, 'tags survive generate→exec').to.deep.equal({ purpose: 'live' });
			expect(await rows(dst, 'select a, b from v')).to.deep.equal([{ a: 1, b: 2 }]);
		} finally {
			await src.close();
			await dst.close();
		}
	});

	it('generateMaintainedTableDDL on a live CREATE MATERIALIZED VIEW rehydrates faithfully', async () => {
		const src = new Database();
		const dst = new Database();
		try {
			// A row-time-maintainable body: passthrough projection of a single keyed source.
			await src.exec('create table base (id integer primary key, v integer)');
			await src.exec('insert into base values (1, 10), (2, 20)');
			await src.exec("create materialized view mv as select id, v from base with tags (purpose = 'live')");
			const mv = src.schemaManager.getMaintainedTable('main', 'mv');
			expect(mv, 'live MV registered').to.exist;
			const ddl = generateMaintainedTableDDL(mv!);
			const reparsed = parse(ddl);
			expect(reparsed.type, 'generated DDL re-parses to the canonical table form').to.equal('createTable');
			expect(reparsed.type === 'createTable' && reparsed.maintained, 'carries the maintained clause').to.exist;
			expect(ddl, 'USING omitted (backing rebuilds as memory)').to.not.match(/using/i);

			// The body references `base`, so the destination needs it before the MV DDL.
			await dst.exec('create table base (id integer primary key, v integer)');
			await dst.exec('insert into base values (1, 10), (2, 20)');
			await dst.exec(ddl);
			const rehydrated = dst.schemaManager.getMaintainedTable('main', 'mv');
			expect(rehydrated?.tags, 'tags survive generate→exec').to.deep.equal({ purpose: 'live' });
			expect(await rows(dst, 'select id, v from mv')).to.deep.equal([{ id: 1, v: 10 }, { id: 2, v: 20 }]);
		} finally {
			await src.close();
			await dst.close();
		}
	});
});

// ============================================================================
// ALTER TABLE/COLUMN RENAME rewrites a dependent plain view's body in place. The
// rewrite now fires `view_modified` so a store-backed catalog (which persists views
// from view_added/view_modified) re-persists the rewritten DDL — without that event
// the stored view DDL would drift after a rename. The `newObject` carries the live
// rewritten schema, so `generateViewDDL(newObject)` is the re-persistable DDL and
// must reference the NEW table/column name.
// ============================================================================

/** Pluck the `view_modified` events for a given view name out of a captured stream. */
function viewModifiedFor(events: SchemaChangeEvent[], name: string) {
	return events.filter(
		(e): e is SchemaChangeEvent & { type: 'view_modified' } =>
			e.type === 'view_modified' && e.objectName === name);
}

describe('view persistence: RENAME rewrites a view body and fires view_modified', () => {
	it('table rename fires one view_modified for the dependent view with rewritten DDL', async () => {
		const db = new Database();
		try {
			await db.exec('create table t (id integer primary key)');
			await db.exec('create view v as select id from t');
			const events = await captureEvents(db, () => db.exec('alter table t rename to t2'));

			const modified = viewModifiedFor(events, 'v');
			expect(modified, 'exactly one view_modified for v').to.have.length(1);
			expect(modified[0].schemaName).to.equal('main');
			const ddl = generateViewDDL(modified[0].newObject);
			expect(ddl, 'rewritten DDL references the new table name').to.match(/\bt2\b/);
			expect(ddl, 'rewritten DDL no longer references a bare `from t`').to.not.match(/\bfrom\s+t\b/i);
		} finally {
			await db.close();
		}
	});

	it('column rename fires one view_modified for the dependent view with rewritten DDL', async () => {
		const db = new Database();
		try {
			await db.exec('create table t (id integer primary key)');
			await db.exec('create view v as select id from t');
			const events = await captureEvents(db, () => db.exec('alter table t rename column id to ident'));

			const modified = viewModifiedFor(events, 'v');
			expect(modified, 'exactly one view_modified for v').to.have.length(1);
			const ddl = generateViewDDL(modified[0].newObject);
			expect(ddl, 'rewritten DDL references the new column name').to.match(/\bident\b/);
		} finally {
			await db.close();
		}
	});

	it('an unrelated view that does not name the renamed table fires no view_modified', async () => {
		const db = new Database();
		try {
			await db.exec('create table t (id integer primary key)');
			await db.exec('create view v as select id from t');
			await db.exec('create view w as select 1 as a');
			const events = await captureEvents(db, () => db.exec('alter table t rename to t2'));

			expect(viewModifiedFor(events, 'v'), 'v was rewritten').to.have.length(1);
			expect(viewModifiedFor(events, 'w'), 'w is untouched → no event').to.have.length(0);
		} finally {
			await db.close();
		}
	});

	it('clause-only column rename (defaulted column projected away) fires one view_modified with rewritten with defaults', async () => {
		const db = new Database();
		try {
			await db.exec('create table t (id integer primary key, name text, created integer not null)');
			await db.exec('create view v as select id, name from t with defaults (created = 99)');
			const events = await captureEvents(db, () => db.exec('alter table t rename column created to created_at'));

			// The body never names `created`, so this is a pure clause rewrite — it
			// must still fire exactly one view_modified for the store re-persist.
			const modified = viewModifiedFor(events, 'v');
			expect(modified, 'exactly one view_modified for v').to.have.length(1);
			const ddl = generateViewDDL(modified[0].newObject);
			expect(ddl, 'rewritten DDL names the new clause target').to.match(/with defaults \(created_at = 99\)/);
			expect(ddl, 'old clause target gone').to.not.match(/created\s*=/);
		} finally {
			await db.close();
		}
	});

	it('table rename inside an with defaults expr subquery fires one view_modified with rewritten DDL', async () => {
		const db = new Database();
		try {
			await db.exec('create table audit (c integer primary key)');
			await db.exec('create table t (id integer primary key, ts integer not null)');
			await db.exec('create view v as select id from t with defaults (ts = (select max(c) from audit))');
			const events = await captureEvents(db, () => db.exec('alter table audit rename to audit2'));

			const modified = viewModifiedFor(events, 'v');
			expect(modified, 'exactly one view_modified for v').to.have.length(1);
			const ddl = generateViewDDL(modified[0].newObject);
			expect(ddl, 'rewritten DDL references the new table inside the expr subquery').to.match(/\baudit2\b/);
			expect(ddl, 'old table name gone').to.not.match(/\baudit\b/);
		} finally {
			await db.close();
		}
	});

	it('two dependent views → two view_modified events, each with rewritten DDL', async () => {
		const db = new Database();
		try {
			await db.exec('create table t (id integer primary key)');
			await db.exec('create view v1 as select id from t');
			await db.exec('create view v2 as select id from t');
			const events = await captureEvents(db, () => db.exec('alter table t rename to t2'));

			const m1 = viewModifiedFor(events, 'v1');
			const m2 = viewModifiedFor(events, 'v2');
			expect(m1, 'one event for v1').to.have.length(1);
			expect(m2, 'one event for v2').to.have.length(1);
			expect(generateViewDDL(m1[0].newObject), 'v1 DDL rewritten').to.match(/\bt2\b/);
			expect(generateViewDDL(m2[0].newObject), 'v2 DDL rewritten').to.match(/\bt2\b/);
		} finally {
			await db.close();
		}
	});
});

// ============================================================================
// The MV mirror of the section above: ALTER TABLE/COLUMN RENAME rewrites a
// dependent materialized view's body in place and fires
// `materialized_view_modified` — the same event the store-backed catalog's
// `saveMaterializedViewDDL` listener persists from — carrying the live rewritten
// schema, so the regenerated DDL round-trips the NEW source name.
// ============================================================================

/** Pluck the `materialized_view_modified` events for a given MV name out of a captured stream. */
function mvModifiedFor(events: SchemaChangeEvent[], name: string) {
	return events.filter(
		(e): e is SchemaChangeEvent & { type: 'materialized_view_modified' } =>
			e.type === 'materialized_view_modified' && e.objectName === name);
}

describe('view persistence: RENAME rewrites an MV body and fires materialized_view_modified', () => {
	it('table rename fires one materialized_view_modified with DDL round-tripping the new source name', async () => {
		const db = new Database();
		try {
			await db.exec('create table t (id integer primary key, v integer)');
			await db.exec('create materialized view mv as select id, v from t');
			const events = await captureEvents(db, () => db.exec('alter table t rename to t2'));

			const modified = mvModifiedFor(events, 'mv');
			expect(modified, 'exactly one materialized_view_modified for mv').to.have.length(1);
			expect(modified[0].schemaName).to.equal('main');
			const ddl = generateMaintainedTableDDL(asMaintained(modified[0].newObject));
			expect(ddl, 'regenerated DDL references the new table name').to.match(/\bt2\b/);
			expect(ddl, 'regenerated DDL no longer references a bare `from t`').to.not.match(/\bfrom\s+t\b/i);
			expect(parse(ddl).type, 'regenerated DDL re-parses to the canonical table form').to.equal('createTable');
		} finally {
			await db.close();
		}
	});

	it('column rename fires one materialized_view_modified with DDL naming the new column', async () => {
		const db = new Database();
		try {
			await db.exec('create table t (id integer primary key, v integer)');
			await db.exec('create materialized view mv as select id, v from t');
			const events = await captureEvents(db, () => db.exec('alter table t rename column v to w'));

			const modified = mvModifiedFor(events, 'mv');
			expect(modified, 'exactly one materialized_view_modified for mv').to.have.length(1);
			const ddl = generateMaintainedTableDDL(asMaintained(modified[0].newObject));
			expect(ddl, 'regenerated DDL references the new column name').to.match(/\bw\b/);
		} finally {
			await db.close();
		}
	});

	it('clause-only column rename fires one materialized_view_modified; DDL and bodyHash carry the rewritten clause', async () => {
		const db = new Database();
		try {
			await db.exec('create table t (id integer primary key, name text, created integer not null)');
			await db.exec('create materialized view mv as select id, name from t with defaults (created = 55)');
			const events = await captureEvents(db, () => db.exec('alter table t rename column created to created_at'));

			// The body never names `created` — pre-fix the propagation `continue`d
			// here and the catalog/DDL kept the stale clause.
			const modified = mvModifiedFor(events, 'mv');
			expect(modified, 'exactly one materialized_view_modified for mv').to.have.length(1);
			const mv = asMaintained(modified[0].newObject);
			const ddl = generateMaintainedTableDDL(mv);
			expect(ddl, 'regenerated DDL names the new clause target').to.match(/with defaults \(created_at = 55\)/);
			expect(ddl, 'old clause target gone').to.not.match(/created\s*=/);
			// The hash must be computed from the POST-rename clause — exactly what
			// the differ recomputes from the post-rename declared form.
			expect(mv.derivation.bodyHash, 'bodyHash hashes the rewritten clause').to.equal(
				computeBodyHash(viewDefinitionToCanonicalString(mv.derivation.columns, mv.derivation.selectAst)));
			expect(mv.derivation.stale, 'MV stays live after a clause-only rewrite').to.not.be.true;
		} finally {
			await db.close();
		}
	});

	it('table rename inside an MV with defaults expr subquery fires one event with rewritten DDL', async () => {
		const db = new Database();
		try {
			await db.exec('create table audit (c integer primary key)');
			await db.exec('create table t (id integer primary key, ts integer not null)');
			await db.exec('create materialized view mv as select id from t with defaults (ts = (select max(c) from audit))');
			const events = await captureEvents(db, () => db.exec('alter table audit rename to audit2'));

			const modified = mvModifiedFor(events, 'mv');
			expect(modified, 'exactly one materialized_view_modified for mv').to.have.length(1);
			const ddl = generateMaintainedTableDDL(asMaintained(modified[0].newObject));
			expect(ddl, 'regenerated DDL references the new table inside the expr subquery').to.match(/\baudit2\b/);
			expect(ddl, 'old table name gone').to.not.match(/\baudit\b/);
		} finally {
			await db.close();
		}
	});

	it('an unrelated MV that does not read the renamed table fires no event', async () => {
		const db = new Database();
		try {
			await db.exec('create table t (id integer primary key, v integer)');
			await db.exec('create table u (id integer primary key, x integer)');
			await db.exec('create materialized view mv_t as select id, v from t');
			await db.exec('create materialized view mv_u as select id, x from u');
			const events = await captureEvents(db, () => db.exec('alter table t rename to t2'));

			expect(mvModifiedFor(events, 'mv_t'), 'mv_t was rewritten').to.have.length(1);
			expect(mvModifiedFor(events, 'mv_u'), 'mv_u is untouched → no event').to.have.length(0);
		} finally {
			await db.close();
		}
	});
});
