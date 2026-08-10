import { expect } from 'chai';
import { Database } from '../src/index.js';
import { isMaintainedTable } from '../src/schema/derivation.js';
import { computeSchemaDiff } from '../src/schema/schema-differ.js';
import { collectSchemaCatalog } from '../src/schema/catalog.js';

/**
 * Review-stage coverage for ticket 6.3 (maintained-table-differ-transitions) —
 * interaction paths the implement-stage specs left unexercised:
 *
 *  1. The declared-shape **table form** (`table X { cols } maintained as …`) end
 *     to end through `declare/apply schema` — the migration-capstone uses only the
 *     `materialized view` sugar, yet docs promise both forms apply identically.
 *  2. **Form parity**: the table form and the sugar form normalize to the same
 *     declared record, so re-declaring the OTHER form over a live maintained table
 *     is an empty diff (closes the dropped "sugar vs table-form compare equal"
 *     matrix case noted in the handoff).
 *  3. **Orphan maintained table + its source dropped in one apply** — undeclared
 *     MVs used to drop EARLY (before source tables); an orphan maintained table
 *     now drops via `tablesToDrop` (FK-ordered only). Confirm apply tolerates it.
 */
describe('Maintained-table differ — review coverage', () => {
	let db: Database;
	beforeEach(() => { db = new Database(); });
	afterEach(async () => { await db.close(); });

	async function rows(sql: string): Promise<Record<string, unknown>[]> {
		const out: Record<string, unknown>[] = [];
		for await (const r of db.eval(sql)) out.push({ ...r });
		return out;
	}

	it('fresh-creates a maintained table from the declared-shape table form', async () => {
		await db.exec(`create table src (id integer primary key, v integer) using memory`);
		await db.exec(`insert into src values (1, 10), (2, 20)`);
		await db.exec(`declare schema main {
			table src { id integer primary key, v integer }
			table m { id integer primary key, v integer } maintained as select id, v from src
		}`);
		await db.exec('apply schema main');

		const m = db.schemaManager.getTable('main', 'm');
		expect(m, 'm exists').to.not.be.undefined;
		expect(isMaintainedTable(m!), 'm is maintained').to.be.true;
		expect(await rows('select id, v from m order by id')).to.deep.equal([{ id: 1, v: 10 }, { id: 2, v: 20 }]);

		// Converged: re-applying the same table-form declaration is a no-op.
		const diff = computeSchemaDiff(
			db.declaredSchemaManager.getDeclaredSchema('main')!,
			collectSchemaCatalog(db, 'main'),
		);
		expect(diff.tablesToAlter.find(a => a.tableName === 'm'), 'table form converges').to.be.undefined;
	});

	it('the table form and the MV sugar compare equal against the same live maintained table', async () => {
		await db.exec(`create table src (id integer primary key, v integer) using memory`);
		// Create via the sugar…
		await db.exec(`declare schema main {
			table src { id integer primary key, v integer }
			materialized view m as select id, v from src
		}`);
		await db.exec('apply schema main');
		// …then re-declare the identical derivation via the table form.
		await db.exec(`declare schema main {
			table src { id integer primary key, v integer }
			table m { id integer primary key, v integer } maintained as select id, v from src
		}`);
		const diff = computeSchemaDiff(
			db.declaredSchemaManager.getDeclaredSchema('main')!,
			collectSchemaCatalog(db, 'main'),
		);
		const mAlter = diff.tablesToAlter.find(a => a.tableName === 'm');
		expect(mAlter?.setMaintained, 'table-form == sugar ⇒ no re-attach').to.be.undefined;
		expect(mAlter?.dropMaintained, 'no detach').to.be.undefined;
		expect(diff.tablesToDrop, 'no drop').to.deep.equal([]);
	});

	it('drops an orphan maintained table and its source in the same apply', async () => {
		await db.exec(`create table s (id integer primary key, v integer) using memory`);
		await db.exec(`insert into s values (1, 10)`);
		await db.exec(`declare schema main {
			table s { id integer primary key, v integer }
			materialized view m as select id, v from s
		}`);
		await db.exec('apply schema main');

		// Empty schema: both m (orphan maintained) and s drop. The orphan maintained
		// table no longer drops EARLY (it is a table now), so this verifies dropping
		// the source out from under it in the same migration is tolerated.
		await db.exec(`declare schema main {}`);
		await db.exec('apply schema main');
		expect(db.schemaManager.getTable('main', 'm'), 'orphan maintained dropped').to.be.undefined;
		expect(db.schemaManager.getTable('main', 's'), 'source dropped').to.be.undefined;
	});

	it('detaches a maintained table while dropping its former source in one apply', async () => {
		await db.exec(`create table s (id integer primary key, v integer) using memory`);
		await db.exec(`insert into s values (1, 10)`);
		await db.exec(`declare schema main {
			table s { id integer primary key, v integer }
			materialized view m as select id, v from s
		}`);
		await db.exec('apply schema main');

		// m becomes plain (detach), s is dropped. Detach runs EARLY, so it precedes
		// the source drop; m keeps its rows and becomes writable.
		await db.exec(`declare schema main {
			table m { id integer primary key, v integer }
		}`);
		await db.exec('apply schema main');
		expect(db.schemaManager.getTable('main', 's'), 'source dropped').to.be.undefined;
		const m = db.schemaManager.getTable('main', 'm');
		expect(m, 'm survives as plain table').to.not.be.undefined;
		expect(isMaintainedTable(m!), 'm is no longer maintained').to.be.false;
		expect(await rows('select id, v from m')).to.deep.equal([{ id: 1, v: 10 }]);
	});

	/**
	 * The differ carries the DECLARED rename list (`maintained.columns`) onto every
	 * `setMaintained` re-attach op (ticket maintained-reattach-explicit-rename-list-reshape),
	 * so `generateMigrationDDL` renders `set maintained (cols) as …` and the verb
	 * relabels the backing IN PLACE. These cover the variants the headline
	 * declarative-equivalence test (the sugar `(a, b)` → `(a, c)` rename) does not:
	 * body-only, the explicit⇄implicit transitions, the arity contract, the declared-
	 * shape table form, and re-diff idempotency after each apply.
	 *
	 * NOTE (deliberately uncovered here): a declared-SHAPE table form whose authored
	 * NAME list changes (`table mv (a, b) maintained (a, b) as …` → `… (a, c) …`) also
	 * drifts the table's OWN declared column set (b → c), which the differ resolves as
	 * an independent column drop+add — the pre-existing detach→reshape→re-attach path,
	 * orthogonal to this ticket's carried-columns surface. The literal column-less
	 * table form (`create table mv maintained (a, b) as …`) is not a thing the grammar
	 * accepts (a `table` item requires a column block), so the canonical explicit
	 * surface is the MV sugar; the table-form coverage below therefore exercises a
	 * body-only re-attach (rename list stable), which routes cleanly through the
	 * declared-shape branch carrying the explicit list.
	 */
	describe('explicit rename-list carried through the re-attach', () => {
		async function declareApply(decl: string): Promise<void> {
			await db.exec(`declare schema main {
				table t { id integer primary key, x integer not null }
				${decl}
			}`);
			await db.exec('apply schema main');
		}
		function diffMv() {
			const diff = computeSchemaDiff(
				db.declaredSchemaManager.getDeclaredSchema('main')!,
				collectSchemaCatalog(db, 'main'),
			);
			return { diff, mv: diff.tablesToAlter.find(a => a.tableName === 'mv') };
		}

		it('a body-only change on an EXPLICIT sugar MV carries the list and converges', async () => {
			await declareApply('materialized view mv (a, b) as select id, x from t');
			await db.exec('insert into t values (1, 10)');
			// Same rename list, body gains a predicate (type-preserving) → body-hash drift.
			await db.exec(`declare schema main {
				table t { id integer primary key, x integer not null }
				materialized view mv (a, b) as select id, x from t where id > 0
			}`);
			const before = diffMv();
			expect(before.mv?.setMaintained?.columns, 'carries the unchanged list (a, b)').to.deep.equal(['a', 'b']);
			expect(before.mv?.dropMaintained, 'no detach leg').to.be.undefined;
			await db.exec('apply schema main');
			const mv = db.schemaManager.getMaintainedTable('main', 'mv')!;
			expect(mv.derivation.columns, 'still explicit (a, b)').to.deep.equal(['a', 'b']);
			expect(await rows('select a, b from mv')).to.deep.equal([{ a: 1, b: 10 }]);
			expect(diffMv().mv, 'converged').to.be.undefined;
		});

		it('an EXPLICIT → IMPLICIT re-attach drops the list and converges to an implicit record', async () => {
			await declareApply('materialized view mv (a, b) as select id, x from t');
			await db.exec(`declare schema main {
				table t { id integer primary key, x integer not null }
				materialized view mv as select id, x from t
			}`);
			const before = diffMv();
			expect(before.mv?.setMaintained, 'a re-attach is scheduled').to.not.be.undefined;
			expect(before.mv?.setMaintained?.columns, 'no declared list ⇒ implicit re-attach').to.be.undefined;
			await db.exec('apply schema main');
			const mv = db.schemaManager.getMaintainedTable('main', 'mv')!;
			expect(mv.columns.map(c => c.name), 'backing follows the body names').to.deep.equal(['id', 'x']);
			expect(mv.derivation.columns, 'recorded implicit').to.be.undefined;
			expect(diffMv().mv, 'converged').to.be.undefined;
		});

		it('an IMPLICIT → EXPLICIT re-attach records the declared list and converges', async () => {
			await declareApply('materialized view mv as select id, x from t');
			await db.exec(`declare schema main {
				table t { id integer primary key, x integer not null }
				materialized view mv (a, b) as select id, x from t
			}`);
			const before = diffMv();
			expect(before.mv?.setMaintained?.columns, 'carries the now-declared list (a, b)').to.deep.equal(['a', 'b']);
			await db.exec('apply schema main');
			const mv = db.schemaManager.getMaintainedTable('main', 'mv')!;
			expect(mv.columns.map(c => c.name), 'backing relabeled to (a, b)').to.deep.equal(['a', 'b']);
			expect(mv.derivation.columns, 'recorded explicit (a, b)').to.deep.equal(['a', 'b']);
			expect(diffMv().mv, 'converged').to.be.undefined;
		});

		it('an arity change on an EXPLICIT MV is a sited error, not a silent widen', async () => {
			await declareApply('materialized view mv (a, b) as select id, x from t');
			// List widens to 3 and the body widens to 3 outputs: the differ carries the
			// 3-name list verbatim; the verb's strict count check rejects it at apply.
			await db.exec(`declare schema main {
				table t { id integer primary key, x integer not null }
				materialized view mv (a, b, d) as select id, x, x from t
			}`);
			const before = diffMv();
			expect(before.mv?.setMaintained?.columns, 'carries the widened list verbatim').to.deep.equal(['a', 'b', 'd']);
			let message = '';
			try { await db.exec('apply schema main'); } catch (e) { message = (e as Error).message; }
			expect(message, 'arity is a sited error').to.match(/body produces 3 columns but the table declares 2/i);
			// The live MV is unchanged — no silent widen/narrow.
			const mv = db.schemaManager.getMaintainedTable('main', 'mv')!;
			expect(mv.columns.map(c => c.name), 'live shape unchanged').to.deep.equal(['a', 'b']);
			expect(mv.derivation.columns, 'live record unchanged').to.deep.equal(['a', 'b']);
		});

		it('a concurrent tag change + rename-list change coexist on one diff and the rename lands', async () => {
			await declareApply(`materialized view mv (a, b) as select id, x from t with tags ("team.owner" = 'old')`);
			await db.exec('insert into t values (1, 10)');
			// Both the rename list (b → c) AND the table tags drift in the same diff.
			await db.exec(`declare schema main {
				table t { id integer primary key, x integer not null }
				materialized view mv (a, c) as select id, x from t with tags ("team.owner" = 'new')
			}`);
			const before = diffMv();
			// In scope here: the carried columns and the maintained-tag routing
			// (markMaintainedTagRoute) coexist on the same alter diff — the carry does not
			// disturb the SET TAGS routing.
			expect(before.mv?.setMaintained?.columns, 'carries the list (a, c)').to.deep.equal(['a', 'c']);
			expect(before.mv?.tableTagsChange, 'tag drift recorded').to.deep.equal({ 'team.owner': 'new' });
			expect(before.mv?.maintainedTags, 'tag edit routed through ALTER MATERIALIZED VIEW').to.equal(true);
			await db.exec('apply schema main');
			const mv = db.schemaManager.getMaintainedTable('main', 'mv')!;
			expect(mv.derivation.columns, 'rename-list landed (a, c)').to.deep.equal(['a', 'c']);
			expect(await rows('select a, c from mv')).to.deep.equal([{ a: 1, c: 10 }]);
			// A *reshaping* re-attach rebuilds `live` from the backing module's post-ALTER
			// schema (derivation-less AND tag-less); the rebuild now grafts the catalog's
			// table tags back, so the concurrent SET TAGS riding the same diff lands too
			// (fix ticket maintained-reshape-reattach-drops-concurrent-tags).
			expect(mv.tags?.['team.owner'], 'concurrent SET TAGS landed through the reshape').to.equal('new');
			// Both legs converged: the rename-list reshape AND the tag change.
			const tagDiff = diffMv();
			expect(tagDiff.mv?.setMaintained, 'rename-list converged ⇒ no further re-attach').to.be.undefined;
			expect(tagDiff.mv?.tableTagsChange, 'tag change converged ⇒ no further SET TAGS').to.be.undefined;
		});

		it('a rename-list change under require-hint is an alter, not an unhinted create+drop', async () => {
			await declareApply('materialized view mv (a, b) as select id, x from t');
			await db.exec(`declare schema main {
				table t { id integer primary key, x integer not null }
				materialized view mv (a, c) as select id, x from t
			}`);
			// A re-attach is an ALTER (set maintained), not a create+drop pair, so it does
			// not trip the unhinted-rename guard — diffing under require-hint must not throw.
			const diff = computeSchemaDiff(
				db.declaredSchemaManager.getDeclaredSchema('main')!,
				collectSchemaCatalog(db, 'main'),
				'require-hint',
			);
			const mv = diff.tablesToAlter.find(a => a.tableName === 'mv');
			expect(mv?.setMaintained?.columns, 'carries the list under require-hint').to.deep.equal(['a', 'c']);
			expect(diff.tablesToCreate, 'no create').to.deep.equal([]);
			expect(diff.tablesToDrop, 'no drop').to.deep.equal([]);
		});

		it('the declared-shape table form carries the explicit list on a body-only re-attach', async () => {
			await declareApply('table mv (a integer primary key, b integer) maintained (a, b) as select id, x from t');
			await db.exec('insert into t values (1, 10)');
			// Rename list AND declared columns unchanged; only the body drifts (WHERE).
			await db.exec(`declare schema main {
				table t { id integer primary key, x integer not null }
				table mv (a integer primary key, b integer) maintained (a, b) as select id, x from t where id > 0
			}`);
			const before = diffMv();
			expect(before.mv?.setMaintained?.columns, 'declared-shape branch carries (a, b)').to.deep.equal(['a', 'b']);
			expect(before.mv?.dropMaintained, 'body-only ⇒ no detach leg').to.be.undefined;
			expect(before.mv?.columnsToAdd, 'no column drift').to.deep.equal([]);
			expect(before.mv?.columnsToDrop, 'no column drift').to.deep.equal([]);
			await db.exec('apply schema main');
			const mv = db.schemaManager.getMaintainedTable('main', 'mv')!;
			expect(mv.derivation.columns, 'still explicit (a, b)').to.deep.equal(['a', 'b']);
			expect(await rows('select a, b from mv')).to.deep.equal([{ a: 1, b: 10 }]);
			expect(diffMv().mv, 'converged').to.be.undefined;
		});

		it('a FRESH attach over a plain table carries the declared list (records explicit)', async () => {
			// The carry rides the fresh-attach branch too (declared maintained, live
			// plain) — not only the re-attach. `mv` pre-exists as a plain table; declaring
			// it as an explicit MV attaches and must record derivation.columns from the
			// carried list, not infer it from the body's natural names.
			await db.exec(`declare schema main {
				table t { id integer primary key, x integer not null }
			}`);
			await db.exec('apply schema main');
			await db.exec('create table mv (a integer primary key, b integer not null)');
			await db.exec('insert into t values (1, 10)');
			await db.exec(`declare schema main {
				table t { id integer primary key, x integer not null }
				materialized view mv (a, b) as select id, x from t
			}`);
			const before = diffMv();
			expect(before.mv?.setMaintained?.columns, 'fresh-attach carries the declared list (a, b)').to.deep.equal(['a', 'b']);
			expect(before.mv?.dropMaintained, 'attach ⇒ no detach leg').to.be.undefined;
			await db.exec('apply schema main');
			const mv = db.schemaManager.getMaintainedTable('main', 'mv')!;
			expect(mv.derivation.columns, 'recorded explicit (a, b) from the carry').to.deep.equal(['a', 'b']);
			expect(await rows('select a, b from mv')).to.deep.equal([{ a: 1, b: 10 }]);
			expect(diffMv().mv, 'converged').to.be.undefined;
		});
	});
});
