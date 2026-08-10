import { expect } from 'chai';
import { Database } from '../../src/core/database.js';
import { MemoryTableModule } from '../../src/vtab/memory/module.js';
import type { TableSchema, IndexSchema } from '../../src/schema/table.js';
import type { MemoryTable } from '../../src/vtab/memory/table.js';
import type { MemoryTableConfig } from '../../src/vtab/memory/types.js';

/**
 * Pins the module-facing stored-name contract (see `SchemaManager.canonicalSchemaName`
 * and docs/module-authoring.md § "Identifier casing in module-facing calls"): every
 * SchemaManager → module hook receives the *stored* names of the object it acts on —
 * `schemaName` canonical (lowercase), object names in their stored display casing —
 * never the raw spelling of the triggering DDL statement. The one as-spelled exception
 * is a *new* object's own name (the index name handed to `createIndex`), which is the
 * future stored name.
 *
 * A `RecordingModule` (subclassing the memory module so the DDL really executes)
 * captures the exact args the engine hands `create` / `connect` / `createIndex` /
 * `dropIndex` / `destroy`, then mixed-case + unqualified DDL drives each frontier.
 */

interface NameArgs { schemaName: string; tableName: string; }
interface IndexArgs extends NameArgs { indexName: string; }

class RecordingModule extends MemoryTableModule {
	readonly creates: NameArgs[] = [];
	readonly connects: NameArgs[] = [];
	readonly createIndexes: IndexArgs[] = [];
	readonly dropIndexes: IndexArgs[] = [];
	readonly destroys: NameArgs[] = [];

	override async create(db: Database, tableSchema: TableSchema): Promise<MemoryTable> {
		this.creates.push({ schemaName: tableSchema.schemaName, tableName: tableSchema.name });
		return super.create(db, tableSchema);
	}

	override async connect(
		db: Database,
		pAux: unknown,
		moduleName: string,
		schemaName: string,
		tableName: string,
		options: MemoryTableConfig,
		tableSchema?: TableSchema,
	): Promise<MemoryTable> {
		this.connects.push({ schemaName, tableName });
		return super.connect(db, pAux, moduleName, schemaName, tableName, options, tableSchema);
	}

	override async createIndex(db: Database, schemaName: string, tableName: string, indexSchema: IndexSchema): Promise<void> {
		this.createIndexes.push({ schemaName, tableName, indexName: indexSchema.name });
		return super.createIndex(db, schemaName, tableName, indexSchema);
	}

	override async dropIndex(db: Database, schemaName: string, tableName: string, indexName: string): Promise<void> {
		this.dropIndexes.push({ schemaName, tableName, indexName });
		return super.dropIndex(db, schemaName, tableName, indexName);
	}

	override async destroy(db: Database, pAux: unknown, moduleName: string, schemaName: string, tableName: string): Promise<void> {
		this.destroys.push({ schemaName, tableName });
		return super.destroy(db, pAux, moduleName, schemaName, tableName);
	}
}

describe('Module-facing schema/object name canonicalization', () => {
	let db: Database;
	let rec: RecordingModule;

	beforeEach(() => {
		db = new Database();
		rec = new RecordingModule();
		db.registerModule('recording', rec);
	});
	afterEach(async () => { await db.close(); });

	it('createIndex receives the stored table name (not the raw `on T` spelling)', async () => {
		// Stored table name is `t` (the display casing as declared); the CREATE INDEX
		// references it as `T`. The module must see the stored `t` / canonical `main`,
		// while the *new* index name `IDX` is the future stored name → as-spelled.
		await db.exec(`create table MAIN.t (id integer primary key, x integer) using recording`);
		await db.exec(`create index IDX on T (x)`);

		expect(rec.createIndexes).to.have.length(1);
		const call = rec.createIndexes[0];
		expect(call.schemaName, 'canonical schema, not raw MAIN').to.equal('main');
		expect(call.tableName, 'stored table name, not the `on T` spelling').to.equal('t');
		expect(call.indexName, "a new index's own name is the future stored name → as-spelled").to.equal('IDX');
	});

	it('dropIndex receives the stored index name (not the raw DROP spelling)', async () => {
		// Created as `MyIdx` (stored display casing); dropped as `MYIDX`. A module
		// keying a cached handle by the stored name (e.g. the store's indexStores
		// cache) would leak it if handed the raw drop spelling.
		await db.exec(`create table t (id integer primary key, x integer) using recording`);
		await db.exec(`create index MyIdx on t (x)`);
		await db.exec(`drop index MYIDX`);

		expect(rec.dropIndexes).to.have.length(1);
		const call = rec.dropIndexes[0];
		expect(call.schemaName, 'canonical schema').to.equal('main');
		expect(call.tableName, 'stored table name').to.equal('t');
		expect(call.indexName, 'stored index name, not the raw MYIDX drop spelling').to.equal('MyIdx');
	});

	it('destroy receives the stored table name (not the raw DROP TABLE spelling)', async () => {
		// Created `MAIN.Tbl` (stored `Tbl` / canonical `main`); dropped as `tbl`.
		await db.exec(`create table MAIN.Tbl (id integer primary key) using recording`);
		await db.exec(`drop table tbl`);

		expect(rec.destroys).to.have.length(1);
		const call = rec.destroys[0];
		expect(call.schemaName, 'canonical schema, not raw MAIN').to.equal('main');
		expect(call.tableName, 'stored table name, not the raw `drop table tbl` spelling').to.equal('Tbl');
	});

	it('connect (catalog import / reopen) receives canonical names', async () => {
		// Real reopen calls module.connect via importTable. In-memory we mirror it:
		// establish the table, then importCatalog the persisted DDL — the memory
		// module's connect binds to the existing definition. A `MAIN.`-qualified DDL
		// must reach connect as canonical `main` / stored `t`.
		await db.exec(`create table MAIN.t (id integer primary key, x integer) using recording`);
		await db.schemaManager.importCatalog([
			`create table MAIN.t (id integer primary key, x integer) using recording`,
		]);

		expect(rec.connects).to.have.length(1);
		const call = rec.connects[0];
		expect(call.schemaName, 'canonical schema, not raw MAIN').to.equal('main');
		expect(call.tableName).to.equal('t');
	});

	it('create receives the canonical TableSchema (control — already canonical)', async () => {
		// create always gets the full TableSchema, whose schemaName is canonical by
		// construction. Pin it stays canonical under a case-divergent qualifier.
		await db.exec(`create table MAIN.t (id integer primary key) using recording`);
		expect(rec.creates).to.have.length(1);
		expect(rec.creates[0].schemaName, 'canonical schema').to.equal('main');
		expect(rec.creates[0].tableName).to.equal('t');
	});

	it('unqualified DDL under a non-main current schema canonicalizes to that schema', async () => {
		// createIndex / dropIndex / destroy must all receive the current schema
		// canonicalized (`aux`), matching getCurrentSchemaName resolution — so a
		// module keying by the arg addresses one consistent (schema, object) key.
		db.schemaManager.addSchema('aux');
		db.schemaManager.setCurrentSchema('aux');

		await db.exec(`create table t (id integer primary key, x integer) using recording`);
		await db.exec(`create index idx on t (x)`);
		await db.exec(`drop index idx`);
		await db.exec(`drop table t`);

		expect(rec.creates[0].schemaName, 'create under aux').to.equal('aux');
		expect(rec.createIndexes[0].schemaName, 'createIndex under aux').to.equal('aux');
		expect(rec.dropIndexes[0].schemaName, 'dropIndex under aux').to.equal('aux');
		expect(rec.destroys[0].schemaName, 'destroy under aux').to.equal('aux');
	});
});
