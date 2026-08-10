import { expect } from 'chai';
import { Database } from '../../src/core/database.js';

/**
 * Catalog-level reverse foreign-key index (`SchemaManager.getReferencingForeignKeys`).
 *
 * The index is a lazily-built, event-invalidated derived cache: referenced
 * `schema.table` → the FKs that reference it. The unit under test is the index
 * itself — its rebuild correctness across the full DDL lifecycle — plus the one
 * in-file consumer routed through it (`assertNoReferencingChildrenForDrop`).
 *
 * Key resolution mirrors every existing parent-side FK scan exactly:
 * `fk.referencedSchema ?? childTable.schemaName`. Because the engine stamps a
 * declared FK's `referencedSchema` with the CHILD's schema (FK parent resolution
 * is schema-local — see `constraint-builder.buildForeignKeyConstraintSchema`), an
 * FK declared on a child in schema S keys under `S.<parent>`. The tests reflect
 * that real behavior rather than an idealized cross-schema resolution.
 */
describe('SchemaManager reverse FK index', () => {
	let db: Database;

	beforeEach(() => {
		db = new Database();
	});

	afterEach(async () => {
		await db.close();
	});

	const refs = (schema: string, table: string) =>
		db.schemaManager.getReferencingForeignKeys(schema, table);

	it('returns the shared empty array for an unreferenced table (the O(1) gate)', async () => {
		await db.exec('create table P (id integer primary key)');
		expect(refs('main', 'P')).to.deep.equal([]);
		// A second miss returns the very same shared frozen array (no per-call alloc).
		expect(refs('main', 'P')).to.equal(refs('main', 'Q'));
	});

	it('a table referenced by one FK yields exactly that {childTable, fk}', async () => {
		await db.exec('create table P (id integer primary key)');
		await db.exec('create table C (id integer primary key, pid integer references P(id))');
		const found = refs('main', 'P');
		expect(found).to.have.length(1);
		expect(found[0].childTable.name).to.equal('C');
		expect(found[0].fk.referencedTable.toLowerCase()).to.equal('p');
	});

	it('is case-insensitive on both schema and table', async () => {
		await db.exec('create table P (id integer primary key)');
		await db.exec('create table C (id integer primary key, pid integer references P(id))');
		expect(refs('MAIN', 'p')).to.have.length(1);
		expect(refs('Main', 'P')).to.have.length(1);
	});

	it('rebuilds after `create table C references P` (table_added)', async () => {
		await db.exec('create table P (id integer primary key)');
		expect(refs('main', 'P')).to.have.length(0); // build #1: empty
		await db.exec('create table C (id integer primary key, pid integer references P(id))');
		expect(refs('main', 'P')).to.have.length(1); // rebuilt: gained C's FK
	});

	it('rebuilds after ALTER TABLE … ADD/DROP CONSTRAINT (table_modified)', async () => {
		await db.exec('create table P (id integer primary key)');
		await db.exec('create table C (id integer primary key, pid integer)');
		expect(refs('main', 'P')).to.have.length(0);

		await db.exec('alter table C add constraint fk_pid foreign key (pid) references P(id)');
		expect(refs('main', 'P'), 'ADD CONSTRAINT adds the entry').to.have.length(1);

		await db.exec('alter table C drop constraint fk_pid');
		expect(refs('main', 'P'), 'DROP CONSTRAINT removes the entry').to.have.length(0);
	});

	it('rebuilds after dropping the child, and after dropping then recreating the parent', async () => {
		await db.exec('create table P (id integer primary key)');
		await db.exec('create table C (id integer primary key, pid integer references P(id))');
		expect(refs('main', 'P')).to.have.length(1);

		await db.exec('drop table C'); // table_removed
		expect(refs('main', 'P'), 'stale child entry gone after drop').to.have.length(0);

		await db.exec('drop table P');
		await db.exec('create table P (id integer primary key)');
		expect(refs('main', 'P'), 'fresh parent has no referencers').to.have.length(0);

		await db.exec('create table C2 (id integer primary key, pid integer references P(id))');
		expect(refs('main', 'P'), 'fresh referencer present').to.have.length(1);
		expect(refs('main', 'P')[0].childTable.name).to.equal('C2');
	});

	it('resets on schema detach (removeSchema), which fires no change event', async () => {
		// Parent + child both live in the attached schema, so the FK keys under
		// `aux.p` (referencedSchema = the child's schema). Detaching aux must drop
		// the entry even though no table_* event fires — proven by the reset wired
		// directly into removeSchema.
		db.schemaManager.addSchema('aux');
		await db.exec('create table aux.P (id integer primary key)');
		await db.exec('create table aux.C (id integer primary key, pid integer references P(id))');
		expect(refs('aux', 'P'), 'attached-schema FK indexed').to.have.length(1);
		expect(refs('aux', 'P')[0].childTable.schemaName.toLowerCase()).to.equal('aux');

		db.schemaManager.removeSchema('aux');
		expect(refs('aux', 'P'), 'detach empties the bucket').to.have.length(0);
	});

	it('re-keys an FK when its parent is renamed (rename-propagation table_modified)', async () => {
		await db.exec('create table P (id integer primary key)');
		await db.exec('create table C (id integer primary key, pid integer references P(id))');
		expect(refs('main', 'P')).to.have.length(1);

		await db.exec('alter table P rename to P2');
		expect(refs('main', 'P'), 'old key empty after rename').to.have.length(0);
		const reKeyed = refs('main', 'P2');
		expect(reKeyed, 'entry re-keyed under the new parent name').to.have.length(1);
		expect(reKeyed[0].fk.referencedTable.toLowerCase()).to.equal('p2');
	});

	it('a self-referential FK keys under the table itself (the bucket includes the self-FK)', async () => {
		await db.exec('create table T (id integer primary key, parent integer references T(id))');
		const found = refs('main', 'T');
		expect(found).to.have.length(1);
		expect(found[0].childTable.name).to.equal('T');
	});

	it('multiple FKs from the same child to one parent all appear, in declaration order', async () => {
		await db.exec('create table P (a integer, b integer, primary key (a, b))');
		await db.exec(`create table C (
			id integer primary key,
			a1 integer, b1 integer,
			a2 integer, b2 integer,
			constraint fk1 foreign key (a1, b1) references P(a, b),
			constraint fk2 foreign key (a2, b2) references P(a, b)
		)`);
		const found = refs('main', 'P');
		expect(found.map(r => r.fk.name)).to.deep.equal(['fk1', 'fk2']);
	});

	it('preserves the schema → table → FK declaration iteration order across multiple children', async () => {
		await db.exec('create table P (id integer primary key)');
		await db.exec('create table A (id integer primary key, pid integer references P(id))');
		await db.exec('create table B (id integer primary key, pid integer references P(id))');
		expect(refs('main', 'P').map(r => r.childTable.name)).to.deep.equal(['A', 'B']);
	});

	it('returned `fk` is the same object reference held in the child schema (identity preserved)', async () => {
		await db.exec('create table P (id integer primary key)');
		await db.exec('create table C (id integer primary key, pid integer references P(id))');
		const cTable = db.schemaManager.getTable('main', 'C')!;
		expect(refs('main', 'P')[0].fk).to.equal(cTable.foreignKeys![0]);
	});

	it('invalidates when a silent catalog import adds an FK to an existing schema', async () => {
		// `importTable` (catalog rehydration) registers tables WITHOUT firing a
		// `table_added` event and through `getOrCreateSchema`, which resets the index
		// only when it CREATES a schema. Importing an FK-bearing child into an already
		// -existing schema therefore bypasses both the event- and schema-reset paths;
		// `importTable` must reset the index directly or it under-reports (the fatal
		// direction). Memory `connect` needs the storage to pre-exist, so C is created
		// FK-less first (establishing both its backing and an already-built, empty
		// index), then re-imported WITH the FK — the silent path under test.
		await db.exec('create table P (id integer primary key)');
		await db.exec('create table C (id integer primary key, pid integer)');
		expect(refs('main', 'P'), 'index built, no referencer yet').to.have.length(0);

		await db.schemaManager.importCatalog([
			'create table C (id integer primary key, pid integer references P(id))',
		]);
		expect(db.schemaManager.getTable('main', 'C')!.foreignKeys, 'import carried the FK').to.have.length(1);
		expect(refs('main', 'P'), 'silent import invalidated the stale index').to.have.length(1);
		expect(refs('main', 'P')[0].childTable.name).to.equal('C');
	});

	describe('behavioral regression: assertNoReferencingChildrenForDrop routes through the index', () => {
		it('still blocks DROP of a parent with a referencing child row (RESTRICT)', async () => {
			await db.exec('pragma foreign_keys = true');
			await db.exec('create table P (id integer primary key)');
			await db.exec('create table C (id integer primary key, pid integer references P(id))');
			await db.exec('insert into P values (1)');
			await db.exec('insert into C values (1, 1)');

			let threw: Error | undefined;
			try {
				await db.exec('drop table P');
			} catch (e) {
				threw = e as Error;
			}
			expect(threw, 'DROP P must be blocked').to.not.be.undefined;
			expect(threw!.message).to.match(/foreign key/i);
			expect(threw!.message).to.match(/cannot drop table 'P'/i);
		});

		it('allows DROP of a parent once the referencing rows are gone', async () => {
			await db.exec('pragma foreign_keys = true');
			await db.exec('create table P (id integer primary key)');
			await db.exec('create table C (id integer primary key, pid integer references P(id))');
			await db.exec('insert into P values (1)');
			await db.exec('insert into C values (1, 1)');
			await db.exec('delete from C');

			// No throw expected.
			await db.exec('drop table P');
			expect(db.schemaManager.getTable('main', 'P')).to.be.undefined;
		});

		it('does not block DROP for a self-referential FK (rows go away with the table)', async () => {
			// A non-null self-reference row would match the drop check's probe — the
			// self-skip is what keeps DROP from blocking on it. (FK columns are
			// auto-NOT-NULL here, so the row references itself: parent = id.)
			await db.exec('pragma foreign_keys = true');
			await db.exec('create table T (id integer primary key, parent integer references T(id))');
			await db.exec('insert into T values (1, 1)');

			await db.exec('drop table T');
			expect(db.schemaManager.getTable('main', 'T')).to.be.undefined;
		});
	});
});
