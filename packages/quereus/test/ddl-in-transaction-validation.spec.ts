/**
 * Row-validating / row-rewriting DDL (`create unique index`, `alter table … add constraint …
 * unique`, `alter table … alter column … set collate`, `… set data type`, `… set not null`) must
 * see the rows the issuing transaction wrote but has not yet committed, and the rule it declares
 * must stay enforced for the rest of that transaction — and after it commits.
 *
 * Memory-only: the store backend reaches the same rules by a different route. Its isolation overlay
 * originally did NOT honor them; the UNIQUE analogue is closed by
 * `isolation-ddl-validation-ignores-overlay-rows`, and `set not null` (reject + DEFAULT backfill,
 * issuer + foreign overlay) by `bug-set-not-null-ignores-uncommitted-rows`. The store + isolation
 * paths for those are covered by their own specs (see packages/quereus-isolation/test).
 * `set data type` behind the isolation overlay remains an open gap (deferred).
 *
 * See docs/memory-table.md § DDL and transactions.
 */
import { expect } from 'chai';
import { Database } from '../src/core/database.js';
import { StatusCode, type SqlValue } from '../src/common/types.js';
import { QuereusError } from '../src/common/errors.js';
import type { MemoryTableModule } from '../src/vtab/memory/module.js';
import type { MemoryTableManager } from '../src/vtab/memory/layer/manager.js';

function getManager(db: Database, tableName: string): MemoryTableManager {
	const mod = db._getVtabModule('memory')?.module as MemoryTableModule | undefined;
	if (!mod) throw new Error('memory module not registered');
	const manager = mod.tables.get(`main.${tableName}`.toLowerCase());
	if (!manager) throw new Error(`no memory manager for table '${tableName}'`);
	return manager;
}

/** First column of the first row, or undefined when the query returns nothing. */
async function scalar(db: Database, sql: string): Promise<SqlValue | undefined> {
	for await (const row of db.eval(sql)) {
		return Object.values(row)[0];
	}
	return undefined;
}

const rowCount = (db: Database, table: string): Promise<SqlValue | undefined> =>
	scalar(db, `select count(*) as c from ${table}`);

async function expectError(fn: () => Promise<unknown>, code: StatusCode, match: RegExp): Promise<void> {
	let caught: unknown;
	try {
		await fn();
	} catch (e) {
		caught = e;
	}
	expect(caught, 'expected an error to be thrown').to.be.instanceOf(QuereusError);
	const err = caught as QuereusError;
	expect(err.code, `expected code ${code}, got ${err.code}: ${err.message}`).to.equal(code);
	expect(err.message).to.match(match);
}

describe('row-validating DDL inside an open transaction (memory backend)', () => {
	let db: Database;

	beforeEach(() => {
		db = new Database();
	});

	afterEach(async () => {
		await db.close();
	});

	describe('validation sees the transaction\'s own uncommitted rows', () => {
		it('create unique index rejects a duplicate that only exists in the pending layer', async () => {
			await db.exec(`create table t (id integer primary key, v text)`);
			await db.exec(`begin`);
			await db.exec(`insert into t values (1, 'a'), (2, 'a')`);

			await expectError(
				() => db.exec(`create unique index ix on t (v)`),
				StatusCode.CONSTRAINT,
				/UNIQUE constraint failed/i,
			);

			await db.exec(`rollback`);
			expect(await rowCount(db, 't')).to.equal(0);
		});

		it('create unique index rejects a committed row colliding with a pending row', async () => {
			await db.exec(`create table t (id integer primary key, v text)`);
			await db.exec(`insert into t values (1, 'a')`);
			await db.exec(`begin`);
			await db.exec(`insert into t values (2, 'a')`);

			await expectError(
				() => db.exec(`create unique index ix on t (v)`),
				StatusCode.CONSTRAINT,
				/UNIQUE constraint failed/i,
			);

			await db.exec(`rollback`);
		});

		it('add constraint … unique rejects a duplicate that only exists in the pending layer', async () => {
			await db.exec(`create table t2 (id integer primary key, v text)`);
			await db.exec(`begin`);
			await db.exec(`insert into t2 values (1, 'a'), (2, 'a')`);

			await expectError(
				() => db.exec(`alter table t2 add constraint u2 unique (v)`),
				StatusCode.CONSTRAINT,
				/UNIQUE constraint failed/i,
			);

			await db.exec(`rollback`);
		});

		it('honors NULL semantics — multiple NULLs in the pending layer are not duplicates', async () => {
			await db.exec(`create table t (id integer primary key, v text null)`);
			await db.exec(`begin`);
			await db.exec(`insert into t values (1, null), (2, null)`);
			await db.exec(`create unique index ix on t (v)`);
			await db.exec(`commit`);

			expect(await rowCount(db, 't')).to.equal(2);
		});

		it('honors a partial index predicate over pending rows', async () => {
			await db.exec(`create table t (id integer primary key, v text, active integer)`);
			await db.exec(`begin`);
			// Only the two active rows are in scope; they do not collide.
			await db.exec(`insert into t values (1, 'a', 1), (2, 'b', 1), (3, 'a', 0)`);
			await db.exec(`create unique index ix on t (v) where active = 1`);
			await db.exec(`commit`);

			expect(await rowCount(db, 't')).to.equal(3);
		});

		it('honors a partial index predicate that DOES collide over pending rows', async () => {
			await db.exec(`create table t (id integer primary key, v text, active integer)`);
			await db.exec(`begin`);
			await db.exec(`insert into t values (1, 'a', 1), (2, 'a', 1), (3, 'b', 0)`);

			await expectError(
				() => db.exec(`create unique index ix on t (v) where active = 1`),
				StatusCode.CONSTRAINT,
				/UNIQUE constraint failed/i,
			);
			await db.exec(`rollback`);
		});

		it('detects a duplicate that only collides under the index collation', async () => {
			await db.exec(`create table t (id integer primary key, v text)`);
			await db.exec(`begin`);
			await db.exec(`insert into t values (1, 'a'), (2, 'A')`);

			await expectError(
				() => db.exec(`create unique index ix on t (v collate nocase)`),
				StatusCode.CONSTRAINT,
				/UNIQUE constraint failed/i,
			);
			await db.exec(`rollback`);
		});

		it('sees a pending DELETE — a committed duplicate removed in-transaction does not block the build', async () => {
			await db.exec(`create table t (id integer primary key, v text)`);
			await db.exec(`insert into t values (1, 'a'), (2, 'a')`);
			await db.exec(`begin`);
			await db.exec(`delete from t where id = 2`);
			await db.exec(`create unique index ix on t (v)`);
			await db.exec(`commit`);

			expect(await rowCount(db, 't')).to.equal(1);
		});

		it('a failed create unique index leaves the schema and the table untouched', async () => {
			await db.exec(`create table t (id integer primary key, v text)`);
			await db.exec(`begin`);
			await db.exec(`insert into t values (1, 'a'), (2, 'a')`);
			await expectError(
				() => db.exec(`create unique index ix on t (v)`),
				StatusCode.CONSTRAINT,
				/UNIQUE constraint failed/i,
			);

			// The transaction is still usable and the index never appeared.
			await db.exec(`insert into t values (3, 'b')`);
			expect(await rowCount(db, 't')).to.equal(3);
			await db.exec(`commit`);

			const manager = getManager(db, 't');
			expect(manager.tableSchema.indexes?.some(i => i.name === 'ix') ?? false).to.equal(false);
			expect(manager.tableSchema.uniqueConstraints ?? []).to.have.length(0);
			expect(await rowCount(db, 't')).to.equal(3);
		});
	});

	describe('the new constraint is enforced for the rest of the transaction', () => {
		it('create unique index rejects a later colliding insert in the same transaction', async () => {
			await db.exec(`create table t (id integer primary key, v text)`);
			await db.exec(`begin`);
			await db.exec(`insert into t values (1, 'a')`);
			await db.exec(`create unique index ix on t (v)`);

			await expectError(
				() => db.exec(`insert into t values (2, 'a')`),
				StatusCode.CONSTRAINT,
				/UNIQUE constraint failed/i,
			);

			await db.exec(`insert into t values (3, 'b')`);
			await db.exec(`commit`);
			expect(await rowCount(db, 't')).to.equal(2);
		});

		it('create unique index rejects a later insert colliding with a COMMITTED row', async () => {
			await db.exec(`create table t (id integer primary key, v text)`);
			await db.exec(`insert into t values (1, 'a')`);
			await db.exec(`begin`);
			await db.exec(`create unique index ix on t (v)`);

			await expectError(
				() => db.exec(`insert into t values (2, 'a')`),
				StatusCode.CONSTRAINT,
				/UNIQUE constraint failed/i,
			);
			await db.exec(`rollback`);
		});

		it('add constraint … unique rejects a later colliding insert in the same transaction', async () => {
			await db.exec(`create table t2 (id integer primary key, v text)`);
			await db.exec(`begin`);
			await db.exec(`insert into t2 values (1, 'a')`);
			await db.exec(`alter table t2 add constraint u2 unique (v)`);

			await expectError(
				() => db.exec(`insert into t2 values (2, 'a')`),
				StatusCode.CONSTRAINT,
				/UNIQUE constraint failed/i,
			);
			await db.exec(`commit`);
			expect(await rowCount(db, 't2')).to.equal(1);
		});

		it('add constraint … unique that REUSES an existing unique index still enforces afterwards', async () => {
			await db.exec(`create table t2 (id integer primary key, v text)`);
			await db.exec(`create unique index ix on t2 (v)`);
			await db.exec(`begin`);
			await db.exec(`insert into t2 values (1, 'a')`);
			// Reuse path: the existing unique index already covers (v).
			await db.exec(`alter table t2 add constraint u2 unique (v)`);

			await expectError(
				() => db.exec(`insert into t2 values (2, 'a')`),
				StatusCode.CONSTRAINT,
				/UNIQUE constraint failed/i,
			);
			await db.exec(`commit`);

			const manager = getManager(db, 't2');
			expect((manager.tableSchema.uniqueConstraints ?? []).some(uc => uc.name === 'u2')).to.equal(true);
			expect(await rowCount(db, 't2')).to.equal(1);
		});

		it('a non-unique create index in a transaction leaves later inserts unconstrained', async () => {
			await db.exec(`create table t (id integer primary key, v text)`);
			await db.exec(`begin`);
			await db.exec(`insert into t values (1, 'a')`);
			await db.exec(`create index ix on t (v)`);
			await db.exec(`insert into t values (2, 'a')`);
			await db.exec(`commit`);
			expect(await rowCount(db, 't')).to.equal(2);
			// The index must still resolve every row.
			expect(await scalar(db, `select count(*) as c from t where v = 'a'`)).to.equal(2);
		});

		it('a pending UPDATE onto the new index key is rejected', async () => {
			await db.exec(`create table t (id integer primary key, v text)`);
			await db.exec(`begin`);
			await db.exec(`insert into t values (1, 'a'), (2, 'b')`);
			await db.exec(`create unique index ix on t (v)`);

			await expectError(
				() => db.exec(`update t set v = 'a' where id = 2`),
				StatusCode.CONSTRAINT,
				/UNIQUE constraint failed/i,
			);
			await db.exec(`rollback`);
		});
	});

	describe('rollback', () => {
		it('discards the pending rows; the committed base index holds exactly the committed rows', async () => {
			await db.exec(`create table t (id integer primary key, v text)`);
			await db.exec(`insert into t values (1, 'x')`);
			await db.exec(`begin`);
			await db.exec(`insert into t values (2, 'a')`);
			await db.exec(`create unique index ix on t (v)`);
			await db.exec(`rollback`);

			expect(await rowCount(db, 't')).to.equal(1);
			// The previously-pending value is free again, and the surviving index accepts it.
			await db.exec(`insert into t values (3, 'a')`);
			expect(await rowCount(db, 't')).to.equal(2);
			// …but the index it left behind still enforces uniqueness.
			await expectError(
				() => db.exec(`insert into t values (4, 'a')`),
				StatusCode.CONSTRAINT,
				/UNIQUE constraint failed/i,
			);
		});
	});

	describe('savepoints', () => {
		it('create unique index sees rows written after a savepoint', async () => {
			await db.exec(`create table t (id integer primary key, v text)`);
			await db.exec(`begin`);
			await db.exec(`savepoint s`);
			await db.exec(`insert into t values (1, 'a'), (2, 'a')`);

			await expectError(
				() => db.exec(`create unique index ix on t (v)`),
				StatusCode.CONSTRAINT,
				/UNIQUE constraint failed/i,
			);
			await db.exec(`rollback`);
		});

		it('create unique index sees rows written before AND after a savepoint', async () => {
			await db.exec(`create table t (id integer primary key, v text)`);
			await db.exec(`begin`);
			await db.exec(`insert into t values (1, 'a')`);
			await db.exec(`savepoint s`);
			await db.exec(`insert into t values (2, 'a')`);

			await expectError(
				() => db.exec(`create unique index ix on t (v)`),
				StatusCode.CONSTRAINT,
				/UNIQUE constraint failed/i,
			);
			await db.exec(`rollback`);
		});

		it('DDL after an eager savepoint does not lose the pre-savepoint rows on commit', async () => {
			// `savepoint` with a pending layer swaps that layer into `readLayer` and clears
			// `pendingTransactionLayer`. The schema change must leave that read view alone —
			// re-pointing it at the base would silently drop row 1 at commit.
			await db.exec(`create table t (id integer primary key, v text)`);
			await db.exec(`begin`);
			await db.exec(`insert into t values (1, 'a')`);
			await db.exec(`savepoint s`);
			await db.exec(`create unique index ix on t (v)`);
			await db.exec(`commit`);

			expect(await rowCount(db, 't')).to.equal(1);
			await expectError(
				() => db.exec(`insert into t values (2, 'a')`),
				StatusCode.CONSTRAINT,
				/UNIQUE constraint failed/i,
			);
		});

		it('create unique index rejects a duplicate held only in an eager savepoint snapshot', async () => {
			await db.exec(`create table t (id integer primary key, v text)`);
			await db.exec(`begin`);
			await db.exec(`insert into t values (1, 'a'), (2, 'a')`);
			await db.exec(`savepoint s`);

			await expectError(
				() => db.exec(`create unique index ix on t (v)`),
				StatusCode.CONSTRAINT,
				/UNIQUE constraint failed/i,
			);
			await db.exec(`rollback`);
			expect(await rowCount(db, 't')).to.equal(0);
		});

		it('DDL after a RELEASED eager savepoint does not lose the pre-savepoint rows', async () => {
			// `release` pops the savepoint entry but leaves its snapshot installed as
			// `readLayer`, still holding uncommitted rows. `hasOpenWork` must keep reporting
			// them, or the schema change re-points the read view at the base and drops row 1.
			await db.exec(`create table t (id integer primary key, v text)`);
			await db.exec(`begin`);
			await db.exec(`insert into t values (1, 'a')`);
			await db.exec(`savepoint s`);
			await db.exec(`release s`);
			await db.exec(`create index ix on t (v)`);
			await db.exec(`commit`);

			expect(await rowCount(db, 't')).to.equal(1);
		});

		it('create unique index sees a duplicate held only in a RELEASED savepoint snapshot', async () => {
			await db.exec(`create table t (id integer primary key, v text)`);
			await db.exec(`begin`);
			await db.exec(`insert into t values (1, 'a'), (2, 'a')`);
			await db.exec(`savepoint s`);
			await db.exec(`release s`);

			await expectError(
				() => db.exec(`create unique index ix on t (v)`),
				StatusCode.CONSTRAINT,
				/UNIQUE constraint failed/i,
			);
			await db.exec(`rollback`);
			expect(await rowCount(db, 't')).to.equal(0);
		});

		it('after rollback to savepoint the adopted schema still enforces the new constraint', async () => {
			await db.exec(`create table t (id integer primary key, v text)`);
			await db.exec(`begin`);
			await db.exec(`insert into t values (1, 'a')`);
			await db.exec(`savepoint s`);
			await db.exec(`insert into t values (2, 'b')`);
			await db.exec(`create unique index ix on t (v)`);
			await db.exec(`rollback to s`);

			// Row 2 is gone; row 1 survives; the constraint declared after the savepoint
			// must still be enforced against row 1.
			expect(await rowCount(db, 't')).to.equal(1);
			await expectError(
				() => db.exec(`insert into t values (3, 'a')`),
				StatusCode.CONSTRAINT,
				/UNIQUE constraint failed/i,
			);
			await db.exec(`insert into t values (4, 'b')`);
			await db.exec(`commit`);
			expect(await rowCount(db, 't')).to.equal(2);
		});
	});

	describe('alter column … set collate re-keys over the transaction\'s own rows', () => {
		/** `create table t (id, v)` + a unique index on `v`, populated with `committed`. */
		async function seed(committed: Array<[number, string | null]> = []): Promise<void> {
			await db.exec(`create table t (id integer primary key, v text null)`);
			await db.exec(`create unique index ix on t (v)`);
			for (const [id, v] of committed) {
				await db.exec(`insert into t values (${id}, ${v === null ? 'null' : `'${v}'`})`);
			}
		}

		const collationOf = (table: string, column: string): string =>
			getManager(db, table).tableSchema.columns.find(c => c.name === column)?.collation ?? 'BINARY';

		it('rejects a duplicate that only exists in the pending layer', async () => {
			await seed();
			await db.exec(`begin`);
			await db.exec(`insert into t values (1, 'a')`);
			await db.exec(`insert into t values (2, 'A')`);

			await expectError(
				() => db.exec(`alter table t alter column v set collate nocase`),
				StatusCode.CONSTRAINT,
				/UNIQUE constraint failed/i,
			);

			// The rejection mutated nothing: the column is still BINARY, and the transaction
			// is usable and still comparing under BINARY ('b' and 'B' stay distinct).
			expect(collationOf('t', 'v')).to.equal('BINARY');
			await db.exec(`insert into t values (3, 'b')`);
			await db.exec(`insert into t values (4, 'B')`);
			await db.exec(`commit`);
			expect(await rowCount(db, 't')).to.equal(4);
		});

		it('rejects a committed row colliding with a pending row under the new collation', async () => {
			await seed([[1, 'a']]);
			await db.exec(`begin`);
			await db.exec(`insert into t values (2, 'A')`);

			await expectError(
				() => db.exec(`alter table t alter column v set collate nocase`),
				StatusCode.CONSTRAINT,
				/UNIQUE constraint failed/i,
			);
			await db.exec(`rollback`);
			expect(collationOf('t', 'v')).to.equal('BINARY');
		});

		it('sees a pending DELETE — a committed duplicate removed in-transaction does not block the change', async () => {
			await seed([[1, 'a'], [2, 'A']]);
			await db.exec(`begin`);
			await db.exec(`delete from t where id = 2`);
			await db.exec(`alter table t alter column v set collate nocase`);
			await db.exec(`commit`);

			expect(await rowCount(db, 't')).to.equal(1);
			expect(collationOf('t', 'v')).to.equal('NOCASE');
			// The accepted change survived the commit: 'A' now collides with the surviving 'a'.
			await expectError(
				() => db.exec(`insert into t values (3, 'A')`),
				StatusCode.CONSTRAINT,
				/UNIQUE constraint failed/i,
			);
		});

		it('governs the rest of the transaction — a later colliding insert is rejected', async () => {
			await seed();
			await db.exec(`begin`);
			await db.exec(`insert into t values (1, 'a')`);
			await db.exec(`alter table t alter column v set collate nocase`);

			await expectError(
				() => db.exec(`insert into t values (2, 'A')`),
				StatusCode.CONSTRAINT,
				/UNIQUE constraint failed/i,
			);

			await db.exec(`insert into t values (3, 'b')`);
			await db.exec(`commit`);
			expect(await rowCount(db, 't')).to.equal(2);
		});

		it('governs a later colliding UPDATE in the same transaction', async () => {
			await seed();
			await db.exec(`begin`);
			await db.exec(`insert into t values (1, 'a'), (2, 'b')`);
			await db.exec(`alter table t alter column v set collate nocase`);

			await expectError(
				() => db.exec(`update t set v = 'A' where id = 2`),
				StatusCode.CONSTRAINT,
				/UNIQUE constraint failed/i,
			);
			await db.exec(`rollback`);
		});

		it('survives commit — a colliding insert after commit is rejected', async () => {
			await seed();
			await db.exec(`begin`);
			await db.exec(`insert into t values (1, 'a')`);
			await db.exec(`alter table t alter column v set collate nocase`);
			await db.exec(`commit`);

			await expectError(
				() => db.exec(`insert into t values (2, 'A')`),
				StatusCode.CONSTRAINT,
				/UNIQUE constraint failed/i,
			);
			expect(await rowCount(db, 't')).to.equal(1);
			// …and the re-keyed index still resolves the committed row under the new collation.
			expect(await scalar(db, `select count(*) as c from t where v = 'a'`)).to.equal(1);
		});

		it('honors NULL semantics — multiple pending NULLs do not collide', async () => {
			await seed();
			await db.exec(`begin`);
			await db.exec(`insert into t values (1, null), (2, null), (3, 'a')`);
			await db.exec(`alter table t alter column v set collate nocase`);
			await db.exec(`commit`);

			expect(await rowCount(db, 't')).to.equal(3);
			expect(collationOf('t', 'v')).to.equal('NOCASE');
		});

		it('validates a table-level UNIQUE constraint (auto-index) over pending rows', async () => {
			// No `create unique index` here: the covering structure is the auto-built `_uc_*`
			// index, which carries no `unique: true` flag.
			await db.exec(`create table u (id integer primary key, v text, unique (v))`);
			await db.exec(`begin`);
			await db.exec(`insert into u values (1, 'a'), (2, 'A')`);

			await expectError(
				() => db.exec(`alter table u alter column v set collate nocase`),
				StatusCode.CONSTRAINT,
				/UNIQUE constraint failed/i,
			);
			await db.exec(`rollback`);
		});

		it('leaves a NON-unique index alone — a pending case-collision does not block the change', async () => {
			await db.exec(`create table n (id integer primary key, v text)`);
			await db.exec(`create index nx on n (v)`);
			await db.exec(`begin`);
			await db.exec(`insert into n values (1, 'a'), (2, 'A')`);
			await db.exec(`alter table n alter column v set collate nocase`);
			await db.exec(`commit`);

			expect(await rowCount(db, 'n')).to.equal(2);
			// The re-keyed index resolves both rows under NOCASE.
			expect(await scalar(db, `select count(*) as c from n where v = 'a'`)).to.equal(2);
		});

		it('sees a duplicate held only in an eager savepoint snapshot', async () => {
			await seed();
			await db.exec(`begin`);
			await db.exec(`insert into t values (1, 'a'), (2, 'A')`);
			await db.exec(`savepoint s`);

			await expectError(
				() => db.exec(`alter table t alter column v set collate nocase`),
				StatusCode.CONSTRAINT,
				/UNIQUE constraint failed/i,
			);
			await db.exec(`rollback`);
			expect(await rowCount(db, 't')).to.equal(0);
		});

		it('after rollback to savepoint the new collation is still enforced', async () => {
			await seed();
			await db.exec(`begin`);
			await db.exec(`insert into t values (1, 'a')`);
			await db.exec(`savepoint s`);
			await db.exec(`insert into t values (2, 'b')`);
			await db.exec(`alter table t alter column v set collate nocase`);
			await db.exec(`rollback to s`);

			// Row 2 is gone; row 1 survives; the collation change declared after the savepoint
			// must still govern the restored snapshot.
			expect(await rowCount(db, 't')).to.equal(1);
			await expectError(
				() => db.exec(`insert into t values (3, 'A')`),
				StatusCode.CONSTRAINT,
				/UNIQUE constraint failed/i,
			);
			await db.exec(`insert into t values (4, 'b')`);
			await db.exec(`commit`);
			expect(await rowCount(db, 't')).to.equal(2);
		});

		it('raises BUSY when a sibling connection holds uncommitted writes', async () => {
			await seed();
			const manager = getManager(db, 't');

			const sibling = manager.connect();
			sibling.begin();
			await manager.performMutation(sibling, 'insert', [9, 'z']);

			await expectError(
				() => db.exec(`alter table t alter column v set collate nocase`),
				StatusCode.BUSY,
				/uncommitted|transaction/i,
			);

			sibling.rollback();
			await db.exec(`alter table t alter column v set collate nocase`);
			expect(collationOf('t', 'v')).to.equal('NOCASE');
		});

		it('a metadata-only set collate binary on an already-binary column is a no-op', async () => {
			await seed();
			await db.exec(`begin`);
			await db.exec(`insert into t values (1, 'a')`);
			// Same collation, not yet explicit: flips `collationExplicit` only — no re-key, no
			// re-validation, no layer adoption.
			await db.exec(`alter table t alter column v set collate binary`);
			await db.exec(`insert into t values (2, 'A')`);
			await db.exec(`commit`);

			expect(await rowCount(db, 't')).to.equal(2);
			expect(collationOf('t', 'v')).to.equal('BINARY');
			expect(getManager(db, 't').tableSchema.columns[1].collationExplicit).to.equal(true);
		});

		it('governs a table with no secondary indexes at all', async () => {
			// `adoptSchema` returns early when the schema carries no indexes; the schema swap
			// itself is what makes the rest of the transaction — and the committed head —
			// compare under the new collation.
			await db.exec(`create table p (id integer primary key, v text)`);
			await db.exec(`begin`);
			await db.exec(`insert into p values (1, 'a')`);
			await db.exec(`alter table p alter column v set collate nocase`);

			expect(await scalar(db, `select count(*) as c from p where v = 'A'`)).to.equal(1);
			await db.exec(`commit`);
			expect(await scalar(db, `select count(*) as c from p where v = 'A'`)).to.equal(1);
		});

		it('re-keys an index that does not mention the altered column without breaking it', async () => {
			// Every index gets a fresh MemoryIndex and BTree, including ones the collation
			// change cannot affect — a layer that kept its old one would inherit an orphaned tree.
			await db.exec(`create table m (id integer primary key, v text, w text)`);
			await db.exec(`create unique index mv on m (v)`);
			await db.exec(`create unique index mw on m (w)`);
			await db.exec(`begin`);
			await db.exec(`insert into m values (1, 'a', 'x')`);
			await db.exec(`alter table m alter column v set collate nocase`);

			// `mw` still enforces and still resolves, inside the transaction and after commit.
			await expectError(
				() => db.exec(`insert into m values (2, 'b', 'x')`),
				StatusCode.CONSTRAINT,
				/UNIQUE constraint failed/i,
			);
			expect(await scalar(db, `select count(*) as c from m where w = 'x'`)).to.equal(1);
			await db.exec(`insert into m values (3, 'b', 'y')`);
			await db.exec(`commit`);

			expect(await rowCount(db, 'm')).to.equal(2);
			expect(await scalar(db, `select count(*) as c from m where w = 'y'`)).to.equal(1);
			await expectError(
				() => db.exec(`insert into m values (4, 'c', 'x')`),
				StatusCode.CONSTRAINT,
				/UNIQUE constraint failed/i,
			);
		});
	});

	/**
	 * The primary tree is a map, not a multi-map: it cannot hold two rows whose keys collapse
	 * under the new comparator, and `rollback` / `rollback to savepoint` must be able to restore
	 * every row any layer of the chain physically holds. So the contract for a PK-column
	 * collation change inside a transaction is stricter than for a secondary index:
	 *
	 *  - the transaction's effective rows collide  → `CONSTRAINT`
	 *  - a layer beneath them collides             → `BUSY` ("commit/rollback and retry")
	 *  - otherwise the new collation is genuinely in force for the rest of the transaction,
	 *    and after it commits.
	 */
	describe('alter column … set collate on a PRIMARY KEY column', () => {
		const collationOf = (table: string, column: string): string =>
			getManager(db, table).tableSchema.columns.find(c => c.name === column)?.collation ?? 'BINARY';

		/** First column of every row, in query order. */
		const values = async (sql: string): Promise<SqlValue[]> => {
			const out: SqlValue[] = [];
			for await (const row of db.eval(sql)) out.push(Object.values(row)[0]);
			return out;
		};

		it('governs the rest of the transaction — a later colliding insert is rejected', async () => {
			await db.exec(`create table t (v text primary key)`);
			await db.exec(`begin`);
			await db.exec(`insert into t values ('a')`);
			await db.exec(`alter table t alter column v set collate nocase`);

			await expectError(
				() => db.exec(`insert into t values ('A')`),
				StatusCode.CONSTRAINT,
				/UNIQUE constraint failed/i,
			);
			await db.exec(`commit`);
			expect(await values(`select v from t`)).to.deep.equal(['a']);
		});

		it('survives commit — a colliding insert after commit is rejected', async () => {
			await db.exec(`create table t (v text primary key)`);
			await db.exec(`begin`);
			await db.exec(`insert into t values ('a')`);
			await db.exec(`alter table t alter column v set collate nocase`);
			await db.exec(`commit`);

			await expectError(
				() => db.exec(`insert into t values ('A')`),
				StatusCode.CONSTRAINT,
				/UNIQUE constraint failed/i,
			);
			expect(await rowCount(db, 't')).to.equal(1);
		});

		it('rejects a duplicate that only exists in the pending layer', async () => {
			await db.exec(`create table t (v text primary key)`);
			await db.exec(`begin`);
			await db.exec(`insert into t values ('a')`);
			await db.exec(`insert into t values ('A')`);

			await expectError(
				() => db.exec(`alter table t alter column v set collate nocase`),
				StatusCode.CONSTRAINT,
				/UNIQUE constraint failed/i,
			);

			// The rejection mutated nothing: still BINARY, still comparing under it.
			expect(collationOf('t', 'v')).to.equal('BINARY');
			await db.exec(`commit`);
			expect(await values(`select v from t order by v`)).to.deep.equal(['A', 'a']);
		});

		it('names the colliding key, joining the parts of a composite primary key', async () => {
			// The CONSTRAINT message renders the key through `keyParts(key, arity !== 1)`; a
			// composite PK is the arm where that flag matters, and a scalar key mis-flagged as a
			// tuple (or the reverse) renders garbage rather than the value the user must fix.
			await db.exec(`create table c (a text, b text, primary key (a, b))`);
			await db.exec(`begin`);
			await db.exec(`insert into c values ('x', 'q'), ('x', 'Q')`);

			await expectError(
				() => db.exec(`alter table c alter column b set collate nocase`),
				StatusCode.CONSTRAINT,
				/key: 'x', '[Qq]'/,
			);
			await db.exec(`rollback`);
		});

		it('raises BUSY for a committed duplicate the transaction has deleted', async () => {
			// The effective rows are collision-free, so the change is not illegal — but the base
			// tree still physically holds both rows, and a rollback has to restore them.
			await db.exec(`create table t (v text primary key)`);
			await db.exec(`insert into t values ('a'), ('A')`);
			await db.exec(`begin`);
			await db.exec(`delete from t where v = 'A'`);

			await expectError(
				() => db.exec(`alter table t alter column v set collate nocase`),
				StatusCode.BUSY,
				/primary key column.*Commit\/rollback and retry/is,
			);

			// Rollback restores both rows, still under the original collation.
			await db.exec(`rollback`);
			expect(collationOf('t', 'v')).to.equal('BINARY');
			expect(await values(`select v from t order by v`)).to.deep.equal(['A', 'a']);
		});

		it('raises BUSY for a collision held only at an earlier statement boundary', async () => {
			// Net effect is collision-free ('A' alone), but the layer left behind by the second
			// insert holds both rows and is the copy-on-write base the view reads through.
			await db.exec(`create table t (v text primary key)`);
			await db.exec(`begin`);
			await db.exec(`insert into t values ('a')`);
			await db.exec(`insert into t values ('A')`);
			await db.exec(`delete from t where v = 'a'`);

			await expectError(
				() => db.exec(`alter table t alter column v set collate nocase`),
				StatusCode.BUSY,
				/primary key column/i,
			);

			// The transaction survives the rejection and still compares under BINARY.
			await db.exec(`insert into t values ('a')`);
			await db.exec(`commit`);
			expect(await values(`select v from t order by v`)).to.deep.equal(['A', 'a']);
		});

		it('raises BUSY for a duplicate held only in an eager savepoint snapshot', async () => {
			await db.exec(`create table t (v text primary key)`);
			await db.exec(`begin`);
			await db.exec(`insert into t values ('a'), ('A')`);
			await db.exec(`savepoint s`);
			await db.exec(`delete from t where v = 'A'`);

			await expectError(
				() => db.exec(`alter table t alter column v set collate nocase`),
				StatusCode.BUSY,
				/primary key column/i,
			);
			await db.exec(`rollback`);
			expect(await rowCount(db, 't')).to.equal(0);
		});

		it('after rollback to savepoint the new collation is still enforced', async () => {
			await db.exec(`create table t (v text primary key)`);
			await db.exec(`begin`);
			await db.exec(`insert into t values ('a')`);
			await db.exec(`savepoint s`);
			await db.exec(`insert into t values ('b')`);
			await db.exec(`alter table t alter column v set collate nocase`);
			await db.exec(`rollback to s`);

			// The restored snapshot was re-keyed too: row 'a' survives, under NOCASE.
			expect(await values(`select v from t`)).to.deep.equal(['a']);
			await expectError(
				() => db.exec(`insert into t values ('A')`),
				StatusCode.CONSTRAINT,
				/UNIQUE constraint failed/i,
			);
			await db.exec(`insert into t values ('B')`);
			await db.exec(`commit`);
			expect(await rowCount(db, 't')).to.equal(2);
		});

		it('rollback restores the pre-transaction rows; the surviving collation still enforces', async () => {
			await db.exec(`create table t (v text primary key)`);
			await db.exec(`insert into t values ('a'), ('b')`);
			await db.exec(`begin`);
			await db.exec(`insert into t values ('c')`);
			await db.exec(`alter table t alter column v set collate nocase`);
			await db.exec(`rollback`);

			expect(await values(`select v from t order by v`)).to.deep.equal(['a', 'b']);
			// DDL is not undone by ROLLBACK (see feat-ddl-transaction-capability), so the
			// re-keyed committed base must still enforce NOCASE.
			expect(collationOf('t', 'v')).to.equal('NOCASE');
			await expectError(
				() => db.exec(`insert into t values ('A')`),
				StatusCode.CONSTRAINT,
				/UNIQUE constraint failed/i,
			);
		});

		it('re-keys a row the transaction moved onto the colliding key', async () => {
			// `update t set v='A' where v='a'` deletes the old PK and upserts the new one in one
			// layer; under NOCASE those two keys collapse, so the re-key replay must apply the
			// deletion before the upsert or the surviving row is lost.
			await db.exec(`create table t (v text primary key, w text)`);
			await db.exec(`insert into t values ('a', 'x')`);
			await db.exec(`begin`);
			await db.exec(`update t set v = 'A' where v = 'a'`);
			await db.exec(`alter table t alter column v set collate nocase`);

			expect(await values(`select w from t`)).to.deep.equal(['x']);
			await db.exec(`commit`);
			expect(await values(`select v from t`)).to.deep.equal(['A']);
			expect(await values(`select w from t where v = 'a'`)).to.deep.equal(['x']);
		});

		it('does not double-index a row whose old and new primary keys collapse', async () => {
			// One layer, two own-writes: `update` records a delete of PK 'a' and an upsert of PK
			// 'A', and moves the row's index key from 'x' to 'y'. Under NOCASE the two PKs are
			// one key, so reading each touched key back out of the layer's own tree resolves the
			// DELETED key to the SURVIVING row and files it in the index under both primary keys
			// — the row then comes back twice from an index scan. `rekeyPrimaryKey` collapses the
			// write log to its net effect (dropping the subsumed deletion) before re-indexing.
			await db.exec(`create table t (v text primary key, w text)`);
			await db.exec(`create index tw on t (w)`);
			await db.exec(`insert into t values ('a', 'x')`);
			await db.exec(`begin`);
			await db.exec(`update t set v = 'A', w = 'y' where v = 'a'`);
			await db.exec(`alter table t alter column v set collate nocase`);

			expect(await values(`select v from t where w = 'y'`)).to.deep.equal(['A']);
			await db.exec(`commit`);
			expect(await values(`select v from t where w = 'y'`)).to.deep.equal(['A']);
			expect(await values(`select v from t where w = 'x'`)).to.deep.equal([]);
		});

		it('re-keys the inherited secondary indexes of every open layer', async () => {
			// Each index derives its primaryKeyComparator/encode from the PK definition, so all
			// of them are rebuilt — including `tw`, which the altered column does not appear in.
			await db.exec(`create table t (v text primary key, w text)`);
			await db.exec(`create unique index tw on t (w)`);
			await db.exec(`insert into t values ('a', 'x')`);
			await db.exec(`begin`);
			await db.exec(`insert into t values ('b', 'y')`);
			await db.exec(`alter table t alter column v set collate nocase`);

			await expectError(
				() => db.exec(`insert into t values ('c', 'y')`),
				StatusCode.CONSTRAINT,
				/UNIQUE constraint failed/i,
			);
			expect(await values(`select v from t where w = 'y'`)).to.deep.equal(['b']);
			await db.exec(`commit`);
			expect(await values(`select v from t where w = 'x'`)).to.deep.equal(['a']);
			await expectError(
				() => db.exec(`insert into t values ('A', 'z')`),
				StatusCode.CONSTRAINT,
				/UNIQUE constraint failed/i,
			);
		});

		it('re-keys a composite primary key on its second column', async () => {
			await db.exec(`create table t (a integer, v text, primary key (a, v))`);
			await db.exec(`begin`);
			await db.exec(`insert into t values (1, 'x')`);
			await db.exec(`alter table t alter column v set collate nocase`);

			await expectError(
				() => db.exec(`insert into t values (1, 'X')`),
				StatusCode.CONSTRAINT,
				/UNIQUE constraint failed/i,
			);
			await db.exec(`insert into t values (2, 'X')`);
			await db.exec(`commit`);
			expect(await values(`select a from t order by a`)).to.deep.equal([1, 2]);
		});

		it('a create index later in the same transaction does not double-index a re-keyed row', async () => {
			// `create index` re-indexes each open layer from its own-write log. That log named PK
			// 'a' (deleted) and PK 'A' (upserted), which the re-key collapsed into one key — so
			// unless the re-key rewrote the log to its net effect, the new index files the
			// surviving row under both keys and an index scan returns it twice.
			await db.exec(`create table t (v text primary key, w text)`);
			await db.exec(`insert into t values ('a', 'x')`);
			await db.exec(`begin`);
			await db.exec(`update t set v = 'A' where v = 'a'`);
			await db.exec(`alter table t alter column v set collate nocase`);
			await db.exec(`create index tw on t (w)`);

			expect(await values(`select v from t where w = 'x'`)).to.deep.equal(['A']);
			await db.exec(`commit`);
			expect(await values(`select v from t where w = 'x'`)).to.deep.equal(['A']);
		});

		it('re-keys a descending primary key without losing its direction', async () => {
			// `createPrimaryKeyFunctions` folds `desc` into the comparator; the re-key rebuilds
			// the comparator from the new schema, so the direction must survive alongside the
			// new collation.
			await db.exec(`create table t (v text, primary key (v desc))`);
			await db.exec(`insert into t values ('b')`);
			await db.exec(`begin`);
			await db.exec(`insert into t values ('c')`);
			await db.exec(`alter table t alter column v set collate nocase`);

			await expectError(
				() => db.exec(`insert into t values ('C')`),
				StatusCode.CONSTRAINT,
				/UNIQUE constraint failed/i,
			);
			await db.exec(`insert into t values ('a')`);
			// A bare scan follows the primary tree, which orders descending.
			expect(await values(`select v from t`)).to.deep.equal(['c', 'b', 'a']);
			await db.exec(`commit`);
			expect(await values(`select v from t`)).to.deep.equal(['c', 'b', 'a']);
		});

		it('honors a partial index predicate while re-keying the primary key', async () => {
			// `reindexOwnWrites` re-files only the rows the layer wrote, and only those the
			// predicate admits: the row that leaves the index must lose its entry, the row that
			// enters it must gain one, and the row that never qualified must stay out.
			await db.exec(`create table t (v text primary key, w text)`);
			await db.exec(`create index tw on t (w) where w <> 'skip'`);
			await db.exec(`insert into t values ('a', 'x'), ('b', 'skip')`);
			await db.exec(`begin`);
			await db.exec(`update t set w = 'skip' where v = 'a'`);   // leaves the index
			await db.exec(`update t set w = 'y' where v = 'b'`);      // enters the index
			await db.exec(`insert into t values ('c', 'skip')`);      // never qualifies
			await db.exec(`alter table t alter column v set collate nocase`);

			expect(await values(`select v from t where w = 'x'`)).to.deep.equal([]);
			expect(await values(`select v from t where w = 'y'`)).to.deep.equal(['b']);
			expect(await values(`select v from t where w = 'skip' order by v`)).to.deep.equal(['a', 'c']);
			await db.exec(`commit`);
			expect(await values(`select v from t where w = 'y'`)).to.deep.equal(['b']);
			expect(await values(`select v from t where w = 'x'`)).to.deep.equal([]);
			expect(await values(`select v from t where w = 'skip' order by v`)).to.deep.equal(['a', 'c']);
		});
	});

	describe('alter column … set data type converts the transaction\'s own rows', () => {
		/** First column of every row, in query order. */
		const values = async (sql: string): Promise<SqlValue[]> => {
			const out: SqlValue[] = [];
			for await (const row of db.eval(sql)) out.push(Object.values(row)[0]);
			return out;
		};

		it('rejects an unconvertible value the transaction inserted, leaving it usable', async () => {
			await db.exec(`create table t (id integer primary key, v text)`);
			await db.exec(`begin`);
			await db.exec(`insert into t values (1, 'notanumber')`);

			await expectError(
				() => db.exec(`alter table t alter column v set data type integer`),
				StatusCode.MISMATCH,
				/Cannot convert value/i,
			);

			// The rejection mutated nothing: the value is still text and the transaction is usable.
			expect(await scalar(db, `select typeof(v) from t where id = 1`)).to.equal('text');
			await db.exec(`insert into t values (2, 'x')`);
			expect(await rowCount(db, 't')).to.equal(2);
			await db.exec(`rollback`);
			expect(await rowCount(db, 't')).to.equal(0);
		});

		it('a pending unconvertible value rejects even when every committed row converts', async () => {
			await db.exec(`create table t (id integer primary key, v text)`);
			await db.exec(`insert into t values (1, '42')`);
			await db.exec(`begin`);
			await db.exec(`insert into t values (2, 'notanumber')`);

			await expectError(
				() => db.exec(`alter table t alter column v set data type integer`),
				StatusCode.MISMATCH,
				/Cannot convert value/i,
			);

			// Nothing was converted — the committed row is still text, before and after rollback.
			expect(await scalar(db, `select typeof(v) from t where id = 1`)).to.equal('text');
			await db.exec(`rollback`);
			expect(await scalar(db, `select typeof(v) from t where id = 1`)).to.equal('text');
		});

		it('converts committed and pending rows, in the transaction and after commit', async () => {
			await db.exec(`create table t (id integer primary key, v text)`);
			await db.exec(`insert into t values (1, '42')`);
			await db.exec(`begin`);
			await db.exec(`insert into t values (2, '7')`);
			await db.exec(`alter table t alter column v set data type integer`);

			// Both the committed and the pending row read back converted inside the transaction.
			expect(await values(`select typeof(v) from t order by id`)).to.deep.equal(['integer', 'integer']);
			expect(await values(`select v from t order by id`)).to.deep.equal([42, 7]);
			await db.exec(`commit`);
			// …and survive the commit.
			expect(await values(`select typeof(v) from t order by id`)).to.deep.equal(['integer', 'integer']);
			expect(await values(`select v from t order by id`)).to.deep.equal([42, 7]);
		});

		it('accepts the change when the only unconvertible value is in a pending-deleted row', async () => {
			await db.exec(`create table t (id integer primary key, v text)`);
			await db.exec(`insert into t values (1, 'notanumber'), (2, '5')`);
			await db.exec(`begin`);
			await db.exec(`delete from t where id = 1`);
			// Effective view holds only '5'; the deleted 'notanumber' must not block the change.
			await db.exec(`alter table t alter column v set data type integer`);

			expect(await values(`select v from t`)).to.deep.equal([5]);
			expect(await scalar(db, `select typeof(v) from t where id = 2`)).to.equal('integer');
			await db.exec(`commit`);
			expect(await values(`select v from t`)).to.deep.equal([5]);
			expect(await rowCount(db, 't')).to.equal(1);
		});

		it('coerces a later insert in the same transaction to the new type', async () => {
			await db.exec(`create table t (id integer primary key, v text)`);
			await db.exec(`begin`);
			await db.exec(`insert into t values (1, '1')`);
			await db.exec(`alter table t alter column v set data type integer`);
			// The rest of the transaction sees the new type — a text literal is coerced to integer.
			await db.exec(`insert into t values (2, '2')`);

			expect(await values(`select typeof(v) from t order by id`)).to.deep.equal(['integer', 'integer']);
			await db.exec(`commit`);
			expect(await values(`select typeof(v) from t order by id`)).to.deep.equal(['integer', 'integer']);
		});

		it('a secondary index on the column resolves rows by the converted value after commit', async () => {
			await db.exec(`create table t (id integer primary key, v text)`);
			await db.exec(`create index tv on t (v)`);
			await db.exec(`insert into t values (1, '10')`);
			await db.exec(`begin`);
			await db.exec(`insert into t values (2, '9')`);
			await db.exec(`alter table t alter column v set data type integer`);

			// The index finds both the committed and the pending row under their NUMERIC keys —
			// text '9' would sort after '10', integer 9 before 10.
			expect(await values(`select id from t where v = 9`)).to.deep.equal([2]);
			expect(await values(`select id from t where v = 10`)).to.deep.equal([1]);
			await db.exec(`commit`);
			expect(await values(`select id from t where v = 9`)).to.deep.equal([2]);
			expect(await values(`select id from t where v = 10`)).to.deep.equal([1]);
		});

		it('converts own rows written before AND after a savepoint', async () => {
			await db.exec(`create table t (id integer primary key, v text)`);
			await db.exec(`begin`);
			await db.exec(`insert into t values (1, '1')`);
			await db.exec(`savepoint s`);
			await db.exec(`insert into t values (2, '2')`);
			await db.exec(`alter table t alter column v set data type integer`);

			// Rows sit in two different transaction layers; both are converted oldest-first.
			expect(await values(`select v from t order by id`)).to.deep.equal([1, 2]);
			expect(await values(`select typeof(v) from t order by id`)).to.deep.equal(['integer', 'integer']);
			await db.exec(`commit`);
			expect(await values(`select v from t order by id`)).to.deep.equal([1, 2]);
			expect(await values(`select typeof(v) from t order by id`)).to.deep.equal(['integer', 'integer']);
		});

		it('after rollback the converted committed rows keep the new type (DDL is not undone)', async () => {
			await db.exec(`create table t (id integer primary key, v text)`);
			await db.exec(`insert into t values (1, '10')`);
			await db.exec(`begin`);
			await db.exec(`insert into t values (2, '20')`);
			await db.exec(`alter table t alter column v set data type integer`);
			await db.exec(`rollback`);

			// The pending row is gone; the committed row stays, converted; the type survives —
			// DDL is not undone by ROLLBACK (see feat-ddl-transaction-capability).
			expect(await rowCount(db, 't')).to.equal(1);
			expect(await scalar(db, `select typeof(v) from t where id = 1`)).to.equal('integer');
			expect(await values(`select v from t`)).to.deep.equal([10]);
		});

		it('rejects retyping a primary key column inside a transaction', async () => {
			await db.exec(`create table t (id integer primary key, v text)`);
			await db.exec(`insert into t values (1, 'a')`);
			await db.exec(`begin`);
			await db.exec(`insert into t values (2, 'b')`);

			await expectError(
				() => db.exec(`alter table t alter column id set data type text`),
				StatusCode.CONSTRAINT,
				/primary key column/i,
			);
			await db.exec(`rollback`);
		});

		it('rejects retyping a primary key column in autocommit too', async () => {
			await db.exec(`create table t (id integer primary key, v text)`);
			await db.exec(`insert into t values (1, 'a')`);

			await expectError(
				() => db.exec(`alter table t alter column id set data type text`),
				StatusCode.CONSTRAINT,
				/primary key column/i,
			);
			// The table is untouched and usable.
			expect(await scalar(db, `select typeof(id) from t where id = 1`)).to.equal('integer');
		});

		it('set default in a transaction is honored by in-transaction and post-commit inserts (verified non-bug)', async () => {
			await db.exec(`create table t (id integer primary key, v text)`);
			await db.exec(`begin`);
			await db.exec(`alter table t alter column v set default 'new'`);
			await db.exec(`insert into t (id) values (1)`);
			expect(await scalar(db, `select v from t where id = 1`)).to.equal('new');
			await db.exec(`commit`);
			await db.exec(`insert into t (id) values (2)`);
			expect(await scalar(db, `select v from t where id = 2`)).to.equal('new');
		});
	});

	describe('alter column … set not null sees the transaction\'s own rows', () => {
		/** First column of every row, in query order. */
		const values = async (sql: string): Promise<SqlValue[]> => {
			const out: SqlValue[] = [];
			for await (const row of db.eval(sql)) out.push(Object.values(row)[0]);
			return out;
		};

		const notNullOf = (table: string, column: string): boolean =>
			getManager(db, table).tableSchema.columns.find(c => c.name === column)?.notNull ?? false;

		it('rejects a NULL that only exists in the pending layer', async () => {
			await db.exec(`create table t (id integer primary key, v text null)`);
			await db.exec(`begin`);
			await db.exec(`insert into t values (1, null)`);

			await expectError(
				() => db.exec(`alter table t alter column v set not null`),
				StatusCode.CONSTRAINT,
				/contains NULL/i,
			);

			// The rejection mutated nothing: still nullable, transaction still usable.
			expect(notNullOf('t', 'v')).to.equal(false);
			await db.exec(`insert into t values (2, 'x')`);
			expect(await rowCount(db, 't')).to.equal(2);
			await db.exec(`rollback`);
			expect(await rowCount(db, 't')).to.equal(0);
		});

		it('a pending NULL rejects even when every committed row is non-null', async () => {
			await db.exec(`create table t (id integer primary key, v text null)`);
			await db.exec(`insert into t values (1, 'a')`);
			await db.exec(`begin`);
			await db.exec(`insert into t values (2, null)`);

			await expectError(
				() => db.exec(`alter table t alter column v set not null`),
				StatusCode.CONSTRAINT,
				/contains NULL/i,
			);
			await db.exec(`rollback`);
			expect(notNullOf('t', 'v')).to.equal(false);
		});

		it('accepts the change when the only NULL is in a pending-deleted row', async () => {
			await db.exec(`create table t (id integer primary key, v text null)`);
			await db.exec(`insert into t values (1, null), (2, 'a')`);
			await db.exec(`begin`);
			await db.exec(`delete from t where id = 1`);
			// Effective view holds only 'a'; the deleted NULL must not block the change.
			await db.exec(`alter table t alter column v set not null`);
			await db.exec(`commit`);

			expect(notNullOf('t', 'v')).to.equal(true);
			expect(await rowCount(db, 't')).to.equal(1);
		});

		it('rejects when a pending UPDATE turns a committed non-null into NULL', async () => {
			await db.exec(`create table t (id integer primary key, v text null)`);
			await db.exec(`insert into t values (1, 'a')`);
			await db.exec(`begin`);
			// Not an insert or a delete — an in-place overwrite of a committed value to NULL. The
			// effective view must reflect the pending NULL, not the committed 'a'.
			await db.exec(`update t set v = null where id = 1`);

			await expectError(
				() => db.exec(`alter table t alter column v set not null`),
				StatusCode.CONSTRAINT,
				/contains NULL/i,
			);
			await db.exec(`rollback`);
			expect(notNullOf('t', 'v')).to.equal(false);
		});

		it('accepts when a pending UPDATE clears the only committed NULL', async () => {
			await db.exec(`create table t (id integer primary key, v text null)`);
			await db.exec(`insert into t values (1, null)`);
			await db.exec(`begin`);
			// The committed NULL is overwritten to a value before the tighten — the effective view
			// holds no NULL, so the ALTER must be accepted.
			await db.exec(`update t set v = 'a' where id = 1`);
			await db.exec(`alter table t alter column v set not null`);
			await db.exec(`commit`);

			expect(notNullOf('t', 'v')).to.equal(true);
			expect(await values(`select v from t`)).to.deep.equal(['a']);
		});

		it('backfills a pending NULL from a literal DEFAULT, leaving non-null rows untouched', async () => {
			await db.exec(`create table t (id integer primary key, v text null default 'filled')`);
			await db.exec(`begin`);
			await db.exec(`insert into t values (1, null), (2, 'keep')`);
			await db.exec(`alter table t alter column v set not null`);

			// The pending NULL is backfilled; the non-null pending row is untouched — inside the
			// transaction and after commit.
			expect(await values(`select v from t order by id`)).to.deep.equal(['filled', 'keep']);
			await db.exec(`commit`);
			expect(await values(`select v from t order by id`)).to.deep.equal(['filled', 'keep']);
			expect(notNullOf('t', 'v')).to.equal(true);
		});

		it('backfills committed AND pending NULLs from a literal DEFAULT', async () => {
			await db.exec(`create table t (id integer primary key, v text null default 'filled')`);
			await db.exec(`insert into t values (1, null)`);
			await db.exec(`begin`);
			await db.exec(`insert into t values (2, null)`);
			await db.exec(`alter table t alter column v set not null`);

			expect(await values(`select v from t order by id`)).to.deep.equal(['filled', 'filled']);
			await db.exec(`commit`);
			expect(await values(`select v from t order by id`)).to.deep.equal(['filled', 'filled']);
		});

		it('governs the rest of the transaction — a later NULL insert is rejected', async () => {
			await db.exec(`create table t (id integer primary key, v text null)`);
			await db.exec(`begin`);
			await db.exec(`insert into t values (1, 'a')`);
			await db.exec(`alter table t alter column v set not null`);

			await expectError(
				() => db.exec(`insert into t values (2, null)`),
				StatusCode.CONSTRAINT,
				/NOT NULL constraint failed/i,
			);
			await db.exec(`insert into t values (3, 'b')`);
			await db.exec(`commit`);
			expect(await rowCount(db, 't')).to.equal(2);
		});

		it('backfills own rows written before AND after a savepoint', async () => {
			await db.exec(`create table t (id integer primary key, v text null default 'filled')`);
			await db.exec(`begin`);
			await db.exec(`insert into t values (1, null)`);
			await db.exec(`savepoint s`);
			await db.exec(`insert into t values (2, null)`);
			await db.exec(`alter table t alter column v set not null`);

			// Rows sit in two different transaction layers; both are backfilled oldest-first.
			expect(await values(`select v from t order by id`)).to.deep.equal(['filled', 'filled']);
			await db.exec(`commit`);
			expect(await values(`select v from t order by id`)).to.deep.equal(['filled', 'filled']);
		});

		it('rejects a NULL held only in an eager savepoint snapshot (no usable default)', async () => {
			await db.exec(`create table t (id integer primary key, v text null)`);
			await db.exec(`begin`);
			await db.exec(`insert into t values (1, null)`);
			await db.exec(`savepoint s`);

			await expectError(
				() => db.exec(`alter table t alter column v set not null`),
				StatusCode.CONSTRAINT,
				/contains NULL/i,
			);
			await db.exec(`rollback`);
			expect(await rowCount(db, 't')).to.equal(0);
		});

		it('rejects a committed NULL in autocommit, leaving the table usable', async () => {
			await db.exec(`create table t (id integer primary key, v text null)`);
			await db.exec(`insert into t values (1, null)`);

			await expectError(
				() => db.exec(`alter table t alter column v set not null`),
				StatusCode.CONSTRAINT,
				/contains NULL/i,
			);
			expect(notNullOf('t', 'v')).to.equal(false);
			expect(await rowCount(db, 't')).to.equal(1);
		});

		it('backfills a committed NULL in autocommit from a literal DEFAULT', async () => {
			await db.exec(`create table t (id integer primary key, v text null default 'filled')`);
			await db.exec(`insert into t values (1, null)`);
			await db.exec(`alter table t alter column v set not null`);

			expect(await values(`select v from t`)).to.deep.equal(['filled']);
			expect(notNullOf('t', 'v')).to.equal(true);
		});

		it('a secondary index on the column resolves the backfilled value after commit', async () => {
			await db.exec(`create table t (id integer primary key, v text null default 'filled')`);
			await db.exec(`create index tv on t (v)`);
			await db.exec(`insert into t values (1, null)`);
			await db.exec(`begin`);
			await db.exec(`insert into t values (2, null)`);
			await db.exec(`alter table t alter column v set not null`);

			// The rewritten base + open-layer rows must be re-indexed under the backfilled value.
			expect(await values(`select id from t where v = 'filled' order by id`)).to.deep.equal([1, 2]);
			await db.exec(`commit`);
			expect(await values(`select id from t where v = 'filled' order by id`)).to.deep.equal([1, 2]);
		});
	});

	describe('other connections', () => {
		it('raises BUSY when a sibling connection holds uncommitted writes', async () => {
			await db.exec(`create table t (id integer primary key, v text)`);
			const manager = getManager(db, 't');

			// A second connection to the same manager with its own pending layer. Its rows
			// are invisible to the DDL's transaction, so the schema change cannot be
			// validated against them and its layer cannot be re-pointed at the new schema.
			const sibling = manager.connect();
			sibling.begin();
			await manager.performMutation(sibling, 'insert', [9, 'z']);

			await expectError(
				() => db.exec(`create unique index ix on t (v)`),
				StatusCode.BUSY,
				/uncommitted|transaction/i,
			);

			sibling.rollback();
			// Once the sibling is done, the DDL proceeds.
			await db.exec(`create unique index ix on t (v)`);
			expect(manager.tableSchema.indexes?.some(i => i.name === 'ix') ?? false).to.equal(true);
		});
	});
});
