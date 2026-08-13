/**
 * Tests for `apply schema`'s applied-state snapshot — the fast path that skips
 * `computeSchemaDiff` / `generateMigrationPlan` when neither the declaration nor
 * the live catalog has moved since the last successful, verified-no-op apply.
 *
 * Two kinds of test live here.
 *
 * **Behavioural** tests drive only public SQL/API surface: out-of-band drift must
 * still be reconciled, seeds must still run, hooks and events must stay silent.
 * These pin that the fast path is observationally indistinguishable from a full
 * apply whose diff came out empty.
 *
 * **White-box** tests need to prove the diff was actually SKIPPED, which by design
 * has no observable difference. They do it by planting a *lying* snapshot: drift
 * the catalog out of band, then record a snapshot asserting that drifted catalog
 * was the verified-equal one. A subsequent apply that repairs the drift did a full
 * diff; one that leaves it in place took the fast path. `plantSnapshot` is the only
 * place that lie is told — never do this outside a test.
 */

import { expect } from 'chai';
import { Database } from '../src/index.js';
import { MemoryTableModule } from '../src/vtab/memory/module.js';
import { collectSchemaCatalog } from '../src/schema/catalog.js';
import { renderCatalogForComparison } from '../src/schema/catalog-rendering.js';
import type { Database as DatabaseType } from '../src/core/database.js';
import type { TableSchema } from '../src/schema/table.js';
import type { MemoryTable } from '../src/vtab/memory/table.js';
import type { DatabaseSchemaChangeEvent } from '../src/core/database-events.js';
import type { SqlValue } from '../src/common/types.js';

/** Drains a statement's rows. */
async function rows(db: Database, sql: string): Promise<Array<Record<string, SqlValue>>> {
	const out: Array<Record<string, SqlValue>> = [];
	for await (const r of db.eval(sql)) out.push(r);
	return out;
}

/** A declaration exercising every catalog category the renderer covers. */
const DECLARATION = `
	declare schema main {
		table items {
			id integer primary key,
			name text not null,
			qty integer not null default 0,
			note text,
			constraint ck_qty check (qty >= 0)
		}

		table crates {
			id integer primary key,
			item_id integer,
			constraint fk_item foreign key (item_id) references items(id)
		}

		index items_name on items(name);

		view v_items as select id, name from items where qty > 0;

		assertion no_negative check (not exists (select 1 from items where qty < 0))
	}
`;

/**
 * Records a snapshot claiming the CURRENT (possibly drifted) catalog is the one a
 * real diff verified equal to the declaration. Lets a test tell a skipped diff
 * from an empty one — see the file header. Test-only.
 */
function plantSnapshot(db: Database, schemaName = 'main'): void {
	const declaredRendering = db.declaredSchemaManager.getDeclaredRendering(schemaName);
	expect(declaredRendering, 'declaration must exist to plant a snapshot').to.be.a('string');
	db.declaredSchemaManager.setAppliedSnapshot(schemaName, {
		declaredRendering: declaredRendering!,
		catalogRendering: renderCatalogForComparison(collectSchemaCatalog(db, schemaName)),
		defaultCollation: db.options.getStringOption('default_collation'),
	});
}

/** A database with the declaration applied twice, so a snapshot is recorded. */
async function settledDb(declaration = DECLARATION, schemaName = 'main'): Promise<Database> {
	const db = new Database();
	await db.exec(declaration);
	await db.exec(`apply schema ${schemaName}`);
	await db.exec(`apply schema ${schemaName}`);
	return db;
}

/** Records begin/end batch hooks and create calls, like schema-batch-hook.spec.ts. */
class RecordingMemoryModule extends MemoryTableModule {
	beginCalls = 0;
	endCalls = 0;
	createCalls: string[] = [];
	/** When set, the named table's create throws, simulating a mid-migration failure. */
	failOnCreateTable?: string;

	async beginSchemaBatch(_db: DatabaseType, _schemaName: string): Promise<void> {
		this.beginCalls++;
	}

	async endSchemaBatch(_db: DatabaseType, _schemaName: string, _error?: unknown): Promise<void> {
		this.endCalls++;
	}

	override async create(db: DatabaseType, tableSchema: TableSchema): Promise<MemoryTable> {
		this.createCalls.push(tableSchema.name);
		if (this.failOnCreateTable && tableSchema.name.toLowerCase() === this.failOnCreateTable.toLowerCase()) {
			throw new Error(`forced create failure for ${tableSchema.name}`);
		}
		return super.create(db, tableSchema);
	}
}

describe('APPLY SCHEMA unchanged fast path', () => {
	let db: Database;

	afterEach(async () => {
		if (db) await db.close();
	});

	describe('snapshot lifecycle', () => {
		it('the migrating first apply records nothing; the second records', async () => {
			db = new Database();
			await db.exec(DECLARATION);

			await db.exec('apply schema main');
			expect(db.declaredSchemaManager.getAppliedSnapshot('main'),
				'a migrating apply must not record — it never verified an empty diff').to.be.undefined;

			await db.exec('apply schema main');
			expect(db.declaredSchemaManager.getAppliedSnapshot('main'),
				'the second apply diffs, finds nothing, and records').to.exist;
		});

		it('a fast-pathed apply re-records the snapshot', async () => {
			db = await settledDb();
			const first = db.declaredSchemaManager.getAppliedSnapshot('main');
			await db.exec('apply schema main');
			const second = db.declaredSchemaManager.getAppliedSnapshot('main');
			expect(second).to.deep.equal(first);
		});

		it('a repair restores the catalog the surviving snapshot describes', async () => {
			// A snapshot is a claim about a PAIR of renderings — "these two were once
			// verified equal" — not about a moment in time, so a migrating apply neither
			// refreshes nor invalidates it. Drift makes the compare miss; repairing the
			// drift makes it match again, and the apply after the repair is fast.
			db = await settledDb();
			const before = db.declaredSchemaManager.getAppliedSnapshot('main');
			await db.exec('drop table crates');
			await db.exec('apply schema main'); // reconciles: recreates crates
			expect(db.declaredSchemaManager.getAppliedSnapshot('main')).to.deep.equal(before);
			expect(renderCatalogForComparison(collectSchemaCatalog(db, 'main')),
				'the recreated catalog renders back to what the snapshot recorded')
				.to.equal(before!.catalogRendering);
		});

		it('a failed apply records nothing', async () => {
			db = new Database();
			const recording = new RecordingMemoryModule();
			recording.failOnCreateTable = 'crates';
			db.registerModule('recording', recording);
			db.setDefaultVtabName('recording');
			await db.exec(DECLARATION);

			let caught: Error | undefined;
			try {
				await db.exec('apply schema main');
			} catch (e) {
				caught = e as Error;
			}
			expect(caught, 'the forced create failure must propagate').to.exist;
			expect(db.declaredSchemaManager.getAppliedSnapshot('main')).to.be.undefined;

			// The next apply must reconcile in full, not be told by a cache that all is well.
			recording.failOnCreateTable = undefined;
			await db.exec('apply schema main');
			expect(db.schemaManager.getTable('main', 'crates'), 'crates recreated by the retry').to.exist;
		});

		it('removeDeclaredSchema clears the snapshot', async () => {
			db = await settledDb();
			expect(db.declaredSchemaManager.getAppliedSnapshot('main')).to.exist;
			db.declaredSchemaManager.removeDeclaredSchema('main');
			expect(db.declaredSchemaManager.getAppliedSnapshot('main')).to.be.undefined;
			expect(db.declaredSchemaManager.getDeclaredRendering('main')).to.be.undefined;
		});
	});

	describe('the diff really is skipped', () => {
		it('a planted snapshot suppresses reconciliation of real drift', async () => {
			db = await settledDb();
			await db.exec('drop table crates');
			plantSnapshot(db);

			await db.exec('apply schema main');
			expect(db.schemaManager.getTable('main', 'crates'),
				'fast path fired, so the differ never saw the missing table').to.be.undefined;
		});

		it('negative control: the same drift IS reconciled without a planted snapshot', async () => {
			db = await settledDb();
			await db.exec('drop table crates');

			await db.exec('apply schema main');
			expect(db.schemaManager.getTable('main', 'crates'), 'crates recreated').to.exist;
		});

		it('re-declaring byte-identical text keeps the fast path', async () => {
			db = await settledDb();
			await db.exec('drop table crates');
			plantSnapshot(db);
			await db.exec(DECLARATION); // same text ⇒ same rendering

			await db.exec('apply schema main');
			expect(db.schemaManager.getTable('main', 'crates'),
				'an identical re-declaration renders the same, so the snapshot still matches').to.be.undefined;
		});

		it('a changed default_collation defeats the snapshot', async () => {
			db = await settledDb();
			await db.exec('drop table crates');
			plantSnapshot(db);
			db.setOption('default_collation', 'NOCASE');

			await db.exec('apply schema main');
			expect(db.schemaManager.getTable('main', 'crates'),
				'default_collation is a differ input outside both renderings').to.exist;
		});

		it('analyze does not move the rendering, so the fast path survives it', async () => {
			// `analyze` swaps the table schema to carry new statistics. Statistics are
			// not diffed, and they are not part of the catalog rendering either, so a
			// post-analyze apply is still fast. Pinned so the behaviour is deliberate
			// rather than accidental: if a future `analyze` DOES move the rendering the
			// cost is one extra full diff, and this test says so.
			db = await settledDb();
			await db.exec(`insert into items (id, name, qty, note) values (1, 'a', 1, 'x'), (2, 'b', 2, 'y')`);
			const before = renderCatalogForComparison(collectSchemaCatalog(db, 'main'));
			await db.exec('analyze');
			expect(renderCatalogForComparison(collectSchemaCatalog(db, 'main'))).to.equal(before);

			await db.exec('drop table crates');
			plantSnapshot(db);
			await db.exec('analyze');
			await db.exec('apply schema main');
			expect(db.schemaManager.getTable('main', 'crates'), 'still fast-pathed after analyze').to.be.undefined;
		});

		it('diff schema after a fast-pathed apply still reports the drift', async () => {
			db = await settledDb();
			await db.exec('drop table crates');
			plantSnapshot(db);
			await db.exec('apply schema main');

			const ddl = await rows(db, 'diff schema main');
			expect(ddl.length, 'diff schema is a preview and never reads the snapshot').to.be.greaterThan(0);
			expect(ddl.map(r => String(Object.values(r)[0])).join('\n')).to.match(/crates/i);
		});
	});

	describe('out-of-band drift is always reconciled', () => {
		// Statement → what to assert about the catalog after the next apply. Each
		// mutation must change the catalog rendering, so the fast path misses and the
		// declared shape is restored.
		const CASES: Array<{ what: string; sql: string; check: (db: Database) => void }> = [
			{
				what: 'drop table',
				sql: 'drop table crates',
				check: d => void expect(d.schemaManager.getTable('main', 'crates')).to.exist,
			},
			{
				what: 'drop view',
				sql: 'drop view v_items',
				check: d => void expect(d.schemaManager.getView('main', 'v_items')).to.exist,
			},
			{
				what: 'drop index',
				sql: 'drop index items_name',
				check: d => void expect(d.schemaManager.getTable('main', 'items')!.indexes
					?.some(i => i.name.toLowerCase() === 'items_name')).to.be.true,
			},
			{
				what: 'drop assertion',
				sql: 'drop assertion no_negative',
				check: d => void expect([...d.schemaManager.getSchema('main')!.getAllAssertions()]
					.some(a => a.name.toLowerCase() === 'no_negative')).to.be.true,
			},
			{
				what: 'add column',
				sql: 'alter table items add column extra text',
				check: d => void expect(d.schemaManager.getTable('main', 'items')!.columns
					.some(c => c.name === 'extra')).to.be.false,
			},
			{
				what: 'drop column',
				sql: 'alter table items drop column note',
				check: d => void expect(d.schemaManager.getTable('main', 'items')!.columns
					.some(c => c.name === 'note')).to.be.true,
			},
			{
				what: 'rename column',
				sql: 'alter table items rename column note to label',
				check: d => void expect(d.schemaManager.getTable('main', 'items')!.columns
					.some(c => c.name === 'note')).to.be.true,
			},
			{
				what: 'rename table',
				sql: 'alter table crates rename to boxes',
				check: d => void expect(d.schemaManager.getTable('main', 'crates')).to.exist,
			},
			{
				what: 'set tags',
				sql: `alter table items set tags ("app.owner" = 'ops')`,
				check: d => void expect(d.schemaManager.getTable('main', 'items')!.tags?.['app.owner']).to.be.undefined,
			},
		];

		for (const { what, sql, check } of CASES) {
			it(`${what} → full reconcile restores the declared shape`, async () => {
				db = await settledDb();
				await db.exec(sql);
				await db.exec('apply schema main');
				check(db);
			});
		}
	});

	describe('declared-side drift', () => {
		it('a tag-only re-declaration reconciles (the case a tag-stripped hash would miss)', async () => {
			db = await settledDb();

			await db.exec(`
				declare schema main {
					table items (
						id integer primary key,
						name text not null,
						qty integer not null default 0,
						note text,
						constraint ck_qty check (qty >= 0)
					) with tags ("app.owner" = 'ops')

					table crates {
						id integer primary key,
						item_id integer,
						constraint fk_item foreign key (item_id) references items(id)
					}

					index items_name on items(name);

					view v_items as select id, name from items where qty > 0;

					assertion no_negative check (not exists (select 1 from items where qty < 0))
				}
			`);
			await db.exec('apply schema main');

			expect(db.schemaManager.getTable('main', 'items')!.tags?.['app.owner'],
				'the differ diffs tags, so the reconciliation rendering must include them').to.equal('ops');
		});
	});

	describe('silence on the fast path', () => {
		it('fires no module batch hooks', async () => {
			db = new Database();
			const recording = new RecordingMemoryModule();
			db.registerModule('recording', recording);
			db.setDefaultVtabName('recording');
			await db.exec(DECLARATION);
			await db.exec('apply schema main');
			await db.exec('apply schema main');

			// A planted snapshot over real drift: a full reconcile here would create
			// the table and fire the hooks. The fast path must fire neither.
			await db.exec('drop table crates');
			plantSnapshot(db);
			const beginBefore = recording.beginCalls;
			const endBefore = recording.endCalls;
			const createsBefore = recording.createCalls.length;

			await db.exec('apply schema main');

			expect(recording.beginCalls).to.equal(beginBefore);
			expect(recording.endCalls).to.equal(endBefore);
			expect(recording.createCalls.length).to.equal(createsBefore);
		});

		it('emits no schema-change events', async () => {
			db = await settledDb();
			await db.exec('drop table crates');
			plantSnapshot(db);

			const events: DatabaseSchemaChangeEvent[] = [];
			const unsubscribe = db.onSchemaChange(e => { events.push(e); });
			try {
				await db.exec('apply schema main');
			} finally {
				unsubscribe();
			}
			expect(events, 'a fast-pathed apply mutates nothing, so it announces nothing').to.have.lengthOf(0);
		});
	});

	describe('apply options', () => {
		it('a stricter rename_policy on a fast-path-eligible apply is a no-op, not a failure', async () => {
			// `renamePolicy` is the one differ input outside the snapshot. It is inert
			// when there are no differences — no name-change pairs for a policy to
			// police — which is what makes skipping the diff safe under any policy.
			db = await settledDb();
			await db.exec(`apply schema main options (rename_policy = 'deny')`);
			expect(db.schemaManager.getTable('main', 'items')).to.exist;
		});

		it('allow_destructive is irrelevant when nothing changed', async () => {
			db = await settledDb();
			await db.exec(`apply schema main options (allow_destructive = true)`);
			expect(db.schemaManager.getTable('main', 'items')).to.exist;
		});
	});

	describe('with seed', () => {
		const SEEDED = `
			declare schema main {
				table roles {
					id integer primary key,
					name text not null
				}

				seed roles (
					(1, 'admin'),
					(2, 'viewer')
				)
			}
		`;

		it('seeds run on the fast path, restoring rows deleted since the last apply', async () => {
			db = new Database();
			await db.exec(SEEDED);
			await db.exec('apply schema main with seed');
			await db.exec('apply schema main with seed');
			expect(db.declaredSchemaManager.getAppliedSnapshot('main'), 'snapshot recorded').to.exist;

			await db.exec('delete from roles');
			expect((await rows(db, 'select count(*) as n from roles'))[0].n).to.equal(0);

			await db.exec('apply schema main with seed');
			expect((await rows(db, 'select count(*) as n from roles'))[0].n,
				'the fast path elides the diff, not the seed loop').to.equal(2);
		});
	});

	describe('maintained tables', () => {
		const MAINTAINED = `
			declare schema main {
				table items {
					id integer primary key,
					qty integer not null default 0
				}

				materialized view mv_totals as select id, qty * 2 as doubled from items
			}
		`;

		it('an unchanged maintained table takes the fast path', async () => {
			db = new Database();
			await db.exec(MAINTAINED);
			await db.exec('apply schema main');
			await db.exec('apply schema main');
			expect(db.declaredSchemaManager.getAppliedSnapshot('main'),
				'the maintained descriptor renders stably across applies').to.exist;
		});

		it('a changed derivation body reconciles', async () => {
			db = new Database();
			await db.exec(MAINTAINED);
			await db.exec('apply schema main');
			await db.exec('apply schema main');

			await db.exec(`
				declare schema main {
					table items {
						id integer primary key,
						qty integer not null default 0
					}

					materialized view mv_totals as select id, qty * 3 as doubled from items
				}
			`);
			await db.exec('apply schema main');
			await db.exec(`insert into items (id, qty) values (1, 5)`);
			expect((await rows(db, 'select doubled from mv_totals'))[0].doubled,
				'the body change must have been reconciled, not skipped').to.equal(15);
		});
	});

	describe('exposed implicit indexes', () => {
		// The secondary BTree behind a UNIQUE constraint tagged
		// `quereus.expose_implicit_index` reaches the catalog as a `CatalogIndex` with
		// `implicit: true` — a shape the differ excludes from its standalone-index
		// buckets. The renderer has an arm for it; these pin that the arm is reached.
		const EXPOSED = `
			declare schema main {
				table vehicles {
					id integer primary key,
					vin text not null,
					constraint uq_vin unique (vin) with tags ("quereus.expose_implicit_index" = true)
				}
			}
		`;

		it('renders the implicit marker', async () => {
			db = await settledDb(EXPOSED);
			const rendering = renderCatalogForComparison(collectSchemaCatalog(db, 'main'));
			expect(rendering, 'the exposed implicit index reaches the rendering')
				.to.match(/^index .* on vehicles implicit$/m);
		});

		it('takes the fast path — an implicit index is not spurious drift', async () => {
			db = await settledDb(EXPOSED);
			expect(db.declaredSchemaManager.getAppliedSnapshot('main'),
				'an index the differ never manages must not keep the plan non-empty').to.exist;

			await db.exec('drop table vehicles');
			plantSnapshot(db);
			await db.exec('apply schema main');
			expect(db.schemaManager.getTable('main', 'vehicles'),
				'the planted snapshot fired, so the diff was skipped').to.be.undefined;
		});
	});

	describe('logical schemas', () => {
		it('record no snapshot — the logical branch returns before catalog collection', async () => {
			db = new Database();
			await db.exec(`declare schema basis { table people { id integer primary key, name text not null } }`);
			await db.exec('apply schema basis');
			await db.exec('apply schema basis');
			await db.exec(`declare logical schema design { table person { id integer, name text } }`);
			await db.exec(`declare lens for design over basis { view person as select id, name from people }`);

			await db.exec('apply schema design');
			await db.exec('apply schema design');
			expect(db.declaredSchemaManager.getAppliedSnapshot('design'),
				'no physical catalog to snapshot; every apply re-deploys the lens').to.be.undefined;
		});
	});

	describe('per-schema keying', () => {
		it('is case-insensitive across applies', async () => {
			db = new Database();
			await db.exec(`declare schema MyApp { table t { id integer primary key } }`);
			await db.exec('apply schema MyApp');
			await db.exec('apply schema myapp');
			expect(db.declaredSchemaManager.getAppliedSnapshot('MYAPP'),
				'one entry, keyed on the lowercased name').to.exist;

			// The differently-cased apply must hit the same entry, not a fresh one.
			await db.exec('drop table MyApp.t');
			plantSnapshot(db, 'MYAPP');
			await db.exec('apply schema myapp');
			expect(db.schemaManager.getTable('myapp', 't'),
				'the lowercase apply read the entry planted under MYAPP').to.be.undefined;
		});

		it('two schemas keep independent entries', async () => {
			db = new Database();
			await db.exec(`declare schema one { table a { id integer primary key } }`);
			await db.exec(`declare schema two { table b { id integer primary key } }`);
			for (const s of ['one', 'two']) {
				await db.exec(`apply schema ${s}`);
				await db.exec(`apply schema ${s}`);
			}

			// Plant over drift in `one` only; `two` must still reconcile its own drift.
			await db.exec('drop table one.a');
			await db.exec('drop table two.b');
			plantSnapshot(db, 'one');

			await db.exec('apply schema one');
			await db.exec('apply schema two');
			expect(db.schemaManager.getTable('one', 'a'), 'one took its planted fast path').to.be.undefined;
			expect(db.schemaManager.getTable('two', 'b'), 'two reconciled independently').to.exist;
		});
	});
});
