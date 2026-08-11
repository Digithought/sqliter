import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import { Database, MemoryTableModule, VirtualTable, AccessPlanBuilder, IndexConstraintOp, asyncIterableToArray, getModuleConcurrencyMode, getModuleReadCommittedSnapshot, installCommitStall, runCommittedReadConformance, QuereusError, StatusCode, primaryKeyDescriptor, ConflictResolution } from '@quereus/quereus';
import type { VtabConcurrencyMode, FilterInfo, VirtualTableModule, BaseModuleConfig, DatabaseInternal, Row, SqlValue, VirtualTableConnection, SchemaChangeInfo, TableSchema, BestAccessPlanRequest, BestAccessPlanResult, UpdateArgs, UpdateResult, IndexDescriptor, EffectiveRowSource } from '@quereus/quereus';
import { IsolationModule, IsolatedTable } from '../src/index.js';
import type { ConnectionOverlayState } from '../src/index.js';
import { makeFullScanFilterInfo } from '../src/filter-info.js';

/**
 * A memory table's LIVE schema, read through its canonical `getSchema()` — the schema the
 * table's manager mutates in place — NOT the per-instance `tableSchema` field, which is a
 * connect-time snapshot the module-level `alterTable` this layer drives never refreshes.
 * Reading that stale field makes an atomicity assertion vacuous: it reports the pre-ALTER
 * shape even when the underlying HAS been mutated, so it would pass against the pre-fix
 * mutate-then-validate ordering too.
 *
 * `getSchema()` is MemoryTable-specific (not on the base `VirtualTable`), so we narrow
 * structurally — sound because every suite using this pins its tables to the memory module,
 * as the isolation layer's underlying or as an overlay staging table.
 */
function liveSchema(table: VirtualTable): TableSchema {
	return (table as unknown as { getSchema(): TableSchema }).getSchema();
}

/** Live collation of `column` on a memory table — see {@link liveSchema}. */
function liveCollation(table: VirtualTable, column: string): string {
	return liveSchema(table).columns.find(c => c.name === column)?.collation ?? 'BINARY';
}

describe('IsolationModule', () => {
	let db: Database;

	beforeEach(() => {
		db = new Database();
	});

	describe('module creation', () => {
		it('creates isolation module wrapping memory module', () => {
			const memoryModule = new MemoryTableModule();
			const isolatedModule = new IsolationModule({
				underlying: memoryModule,
			});

			expect(isolatedModule).to.be.instanceOf(IsolationModule);
		});

		it('reports correct capabilities', () => {
			const memoryModule = new MemoryTableModule();
			const isolatedModule = new IsolationModule({
				underlying: memoryModule,
			});

			const caps = isolatedModule.getCapabilities();
			expect(caps.isolation).to.be.true;
			expect(caps.savepoints).to.be.true;
		});
	});

	describe('table creation', () => {
		it('creates isolated table via CREATE TABLE', async () => {
			const memoryModule = new MemoryTableModule();
			const isolatedModule = new IsolationModule({
				underlying: memoryModule,
			});

			db.registerModule('isolated', isolatedModule);

			await db.exec(`
				CREATE TABLE test (
					id INTEGER PRIMARY KEY,
					name TEXT
				) USING isolated
			`);

			// Table should exist - use schema() function to check
			const result = await db.get(`SELECT name FROM schema() WHERE type = 'table' AND name = 'test'`);
			expect(result?.name).to.equal('test');
		});

		it('creates isolated table with custom tombstone column', async () => {
			const memoryModule = new MemoryTableModule();
			const isolatedModule = new IsolationModule({
				underlying: memoryModule,
				tombstoneColumn: '_deleted',
			});

			db.registerModule('isolated', isolatedModule);

			await db.exec(`
				CREATE TABLE test (
					id INTEGER PRIMARY KEY,
					value TEXT
				) USING isolated
			`);

			// Table should exist - use schema() function to check
			const result = await db.get(`SELECT name FROM schema() WHERE type = 'table' AND name = 'test'`);
			expect(result?.name).to.equal('test');
		});
	});

	describe('transaction lifecycle', () => {
		let isolatedModule: IsolationModule;

		beforeEach(() => {
			const memoryModule = new MemoryTableModule();
			isolatedModule = new IsolationModule({
				underlying: memoryModule,
			});
			db.registerModule('isolated', isolatedModule);
		});

		it('supports begin/commit', async () => {
			await db.exec(`CREATE TABLE test (id INTEGER PRIMARY KEY) USING isolated`);

			await db.exec('BEGIN');
			await db.exec('INSERT INTO test VALUES (1)');
			await db.exec('COMMIT');

			const result = await db.get('SELECT * FROM test WHERE id = 1');
			expect(result?.id).to.equal(1);
		});

		it('supports read-your-own-writes within transaction', async () => {
			await db.exec(`CREATE TABLE test (id INTEGER PRIMARY KEY, name TEXT) USING isolated`);

			await db.exec('BEGIN');
			await db.exec(`INSERT INTO test VALUES (1, 'Alice')`);

			// Should see uncommitted write
			const result = await db.get('SELECT * FROM test WHERE id = 1');
			expect(result?.name).to.equal('Alice');

			await db.exec('COMMIT');
		});

		it('supports rollback', async () => {
			await db.exec(`CREATE TABLE test (id INTEGER PRIMARY KEY) USING isolated`);

			// Insert and commit one row
			await db.exec('INSERT INTO test VALUES (1)');

			// Start new transaction, insert another row, then rollback
			await db.exec('BEGIN');
			await db.exec('INSERT INTO test VALUES (2)');
			await db.exec('ROLLBACK');

			// Should only see the first row
			const all = await asyncIterableToArray(db.eval('SELECT * FROM test ORDER BY id'));
			expect(all.length).to.equal(1);
			expect(all[0].id).to.equal(1);
		});

		// Note: These tests verify the transaction lifecycle wiring is in place.
		// The underlying memory module already provides isolation, so these tests
		// pass through to it. Phase 4 will implement overlay-based isolation.

		// Note: Full transaction isolation tests will be added in Phase 4.
		// The current stub implementation delegates to the underlying module,
		// which already has its own isolation. These tests verify the wiring
		// is in place for transaction lifecycle methods.
	});

	describe('isolated table internals', () => {
		it('exposes underlying and overlay tables for testing', async () => {
			const memoryModule = new MemoryTableModule();
			const isolatedModule = new IsolationModule({
				underlying: memoryModule,
			});
			db.registerModule('isolated', isolatedModule);

			await db.exec(`CREATE TABLE test (id INTEGER PRIMARY KEY) USING isolated`);

			// Get the table instance
			const table = db.schemaManager.getTable('main', 'test');
			expect(table).to.exist;
		});
	});

	describe('basic operations pass through', () => {
		it('supports INSERT and SELECT', async () => {
			const memoryModule = new MemoryTableModule();
			const isolatedModule = new IsolationModule({
				underlying: memoryModule,
			});
			db.registerModule('isolated', isolatedModule);

			await db.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT) USING isolated`);
			await db.exec(`INSERT INTO users VALUES (1, 'Alice')`);
			await db.exec(`INSERT INTO users VALUES (2, 'Bob')`);

			const all = await asyncIterableToArray(db.eval('SELECT * FROM users ORDER BY id'));
			expect(all.length).to.equal(2);
			expect(all[0].name).to.equal('Alice');
			expect(all[1].name).to.equal('Bob');
		});

		it('supports UPDATE', async () => {
			const memoryModule = new MemoryTableModule();
			const isolatedModule = new IsolationModule({
				underlying: memoryModule,
			});
			db.registerModule('isolated', isolatedModule);

			await db.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT) USING isolated`);
			await db.exec(`INSERT INTO users VALUES (1, 'Alice')`);
			await db.exec(`UPDATE users SET name = 'Alicia' WHERE id = 1`);

			const result = await db.get('SELECT name FROM users WHERE id = 1');
			expect(result?.name).to.equal('Alicia');
		});

		it('supports DELETE', async () => {
			const memoryModule = new MemoryTableModule();
			const isolatedModule = new IsolationModule({
				underlying: memoryModule,
			});
			db.registerModule('isolated', isolatedModule);

			await db.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT) USING isolated`);
			await db.exec(`INSERT INTO users VALUES (1, 'Alice')`);
			await db.exec(`DELETE FROM users WHERE id = 1`);

			const result = await db.get('SELECT * FROM users WHERE id = 1');
			expect(result).to.be.undefined;
		});
	});

	describe('secondary index scans', () => {
		let isolatedModule: IsolationModule;

		beforeEach(() => {
			const memoryModule = new MemoryTableModule();
			isolatedModule = new IsolationModule({
				underlying: memoryModule,
			});
			db.registerModule('isolated', isolatedModule);
		});

		it('sees uncommitted inserts via secondary index query', async () => {
			await db.exec(`
				CREATE TABLE users (
					id INTEGER PRIMARY KEY,
					email TEXT,
					name TEXT
				) USING isolated
			`);
			await db.exec(`CREATE INDEX idx_email ON users(email)`);

			// Commit some initial data
			await db.exec(`INSERT INTO users VALUES (1, 'alice@example.com', 'Alice')`);

			// Start transaction and insert new row
			await db.exec('BEGIN');
			await db.exec(`INSERT INTO users VALUES (2, 'bob@example.com', 'Bob')`);

			// Query by secondary index should see uncommitted insert
			const result = await db.get(`SELECT * FROM users WHERE email = 'bob@example.com'`);
			expect(result?.name).to.equal('Bob');

			await db.exec('ROLLBACK');

			// After rollback, should not see the insert
			const afterRollback = await db.get(`SELECT * FROM users WHERE email = 'bob@example.com'`);
			expect(afterRollback).to.be.undefined;
		});

		it('filters out tombstoned rows via secondary index query', async () => {
			await db.exec(`
				CREATE TABLE users (
					id INTEGER PRIMARY KEY,
					email TEXT,
					name TEXT
				) USING isolated
			`);
			await db.exec(`CREATE INDEX idx_email ON users(email)`);

			// Commit initial data
			await db.exec(`INSERT INTO users VALUES (1, 'alice@example.com', 'Alice')`);
			await db.exec(`INSERT INTO users VALUES (2, 'bob@example.com', 'Bob')`);

			// Start transaction and delete via PK
			await db.exec('BEGIN');
			await db.exec(`DELETE FROM users WHERE id = 1`);

			// Query by secondary index should NOT see deleted row
			const aliceResult = await db.get(`SELECT * FROM users WHERE email = 'alice@example.com'`);
			expect(aliceResult).to.be.undefined;

			// Bob should still be visible
			const bobResult = await db.get(`SELECT * FROM users WHERE email = 'bob@example.com'`);
			expect(bobResult?.name).to.equal('Bob');

			await db.exec('ROLLBACK');

			// After rollback, Alice should be back
			const afterRollback = await db.get(`SELECT * FROM users WHERE email = 'alice@example.com'`);
			expect(afterRollback?.name).to.equal('Alice');
		});

		it('returns updated rows from overlay via secondary index query', async () => {
			await db.exec(`
				CREATE TABLE users (
					id INTEGER PRIMARY KEY,
					email TEXT,
					name TEXT
				) USING isolated
			`);
			await db.exec(`CREATE INDEX idx_email ON users(email)`);

			// Commit initial data
			await db.exec(`INSERT INTO users VALUES (1, 'alice@example.com', 'Alice')`);

			// Start transaction and update
			await db.exec('BEGIN');
			await db.exec(`UPDATE users SET name = 'Alicia' WHERE id = 1`);

			// Query by secondary index should see updated value
			const result = await db.get(`SELECT * FROM users WHERE email = 'alice@example.com'`);
			expect(result?.name).to.equal('Alicia');

			await db.exec('ROLLBACK');

			// After rollback, should see original value
			const afterRollback = await db.get(`SELECT * FROM users WHERE email = 'alice@example.com'`);
			expect(afterRollback?.name).to.equal('Alice');
		});

		it('handles multiple rows with same index key', async () => {
			await db.exec(`
				CREATE TABLE users (
					id INTEGER PRIMARY KEY,
					department TEXT,
					name TEXT
				) USING isolated
			`);
			await db.exec(`CREATE INDEX idx_dept ON users(department)`);

			// Commit initial data - multiple rows with same department
			await db.exec(`INSERT INTO users VALUES (1, 'engineering', 'Alice')`);
			await db.exec(`INSERT INTO users VALUES (2, 'engineering', 'Bob')`);
			await db.exec(`INSERT INTO users VALUES (3, 'sales', 'Charlie')`);

			// Start transaction
			await db.exec('BEGIN');

			// Insert another engineering row
			await db.exec(`INSERT INTO users VALUES (4, 'engineering', 'Diana')`);

			// Delete one existing engineering row
			await db.exec(`DELETE FROM users WHERE id = 1`);

			// Query by department should show correct rows
			const engineering = await asyncIterableToArray(
				db.eval(`SELECT * FROM users WHERE department = 'engineering' ORDER BY id`)
			);
			expect(engineering.length).to.equal(2);
			expect(engineering.map(r => r.name)).to.deep.equal(['Bob', 'Diana']);

			// Sales should be unaffected
			const sales = await asyncIterableToArray(
				db.eval(`SELECT * FROM users WHERE department = 'sales'`)
			);
			expect(sales.length).to.equal(1);
			expect(sales[0].name).to.equal('Charlie');

			await db.exec('ROLLBACK');

			// After rollback, original state restored
			const afterRollback = await asyncIterableToArray(
				db.eval(`SELECT * FROM users WHERE department = 'engineering' ORDER BY id`)
			);
			expect(afterRollback.length).to.equal(2);
			expect(afterRollback.map(r => r.name)).to.deep.equal(['Alice', 'Bob']);
		});

		it('handles range scans on secondary index with overlay changes', async () => {
			await db.exec(`
				CREATE TABLE products (
					id INTEGER PRIMARY KEY,
					price INTEGER,
					name TEXT
				) USING isolated
			`);
			await db.exec(`CREATE INDEX idx_price ON products(price)`);

			// Commit initial data
			await db.exec(`INSERT INTO products VALUES (1, 10, 'Cheap')`);
			await db.exec(`INSERT INTO products VALUES (2, 50, 'Medium')`);
			await db.exec(`INSERT INTO products VALUES (3, 100, 'Expensive')`);

			// Start transaction
			await db.exec('BEGIN');

			// Add a product in the range
			await db.exec(`INSERT INTO products VALUES (4, 30, 'Budget')`);

			// Update a product to be outside the range
			await db.exec(`UPDATE products SET price = 200 WHERE id = 2`);

			// Range query should reflect changes
			const affordable = await asyncIterableToArray(
				db.eval(`SELECT * FROM products WHERE price <= 50 ORDER BY price`)
			);

			// Should have: Cheap(10), Budget(30) - Medium(50) was updated to 200
			expect(affordable.length).to.equal(2);
			expect(affordable.map(r => r.name)).to.deep.equal(['Cheap', 'Budget']);

			await db.exec('ROLLBACK');
		});

		it('handles update that changes index key value', async () => {
			await db.exec(`
				CREATE TABLE users (
					id INTEGER PRIMARY KEY,
					email TEXT,
					name TEXT
				) USING isolated
			`);
			await db.exec(`CREATE INDEX idx_email ON users(email)`);

			// Commit initial data
			await db.exec(`INSERT INTO users VALUES (1, 'old@example.com', 'Alice')`);

			// Start transaction and update email
			await db.exec('BEGIN');
			await db.exec(`UPDATE users SET email = 'new@example.com' WHERE id = 1`);

			// Query with old email should find nothing
			const oldEmail = await db.get(`SELECT * FROM users WHERE email = 'old@example.com'`);
			expect(oldEmail).to.be.undefined;

			// Query with new email should find the row
			const newEmail = await db.get(`SELECT * FROM users WHERE email = 'new@example.com'`);
			expect(newEmail?.name).to.equal('Alice');

			await db.exec('COMMIT');

			// After commit, changes should be permanent
			const afterCommit = await db.get(`SELECT * FROM users WHERE email = 'new@example.com'`);
			expect(afterCommit?.name).to.equal('Alice');
		});
	});

	describe('merged secondary-index key encoding (bigint / collation)', () => {
		let isolatedModule: IsolationModule;

		beforeEach(() => {
			const memoryModule = new MemoryTableModule();
			isolatedModule = new IsolationModule({
				underlying: memoryModule,
			});
			db.registerModule('isolated', isolatedModule);
		});

		it('scans a secondary index while a bigint-PK table has pending overlay changes', async () => {
			await db.exec(`
				CREATE TABLE big (
					id INTEGER PRIMARY KEY,
					tag TEXT
				) USING isolated
			`);
			await db.exec(`CREATE INDEX idx_tag ON big(tag)`);

			// A committed small-int-PK row (seeded via SQL).
			await db.exec(`INSERT INTO big VALUES (1, 'alpha')`);

			// Stage a pending overlay INSERT at a bigint PK by injecting into the overlay
			// directly, rather than via a SQL INSERT inside BEGIN. A SQL INSERT of a bigint
			// PK trips a SEPARATE, pre-existing engine defect — the transaction change-log
			// key encoder (`TransactionManager.serializeKeyTuple`) also uses JSON.stringify
			// and throws on a bigint before the isolation merge path is ever reached. That
			// core bug is out of scope for the isolation layer under test here and is tracked
			// in fix/txn-changelog-bigint-key. Direct injection isolates the merge-path
			// bug so this spec fails ONLY on the isolation-layer defect it targets.
			const BIG = 9007199254740994n; // 2^53 + 2 — a JS bigint (beyond MAX_SAFE_INTEGER)
			const underlying = isolatedModule.getUnderlyingState('main', 'big')!.underlyingTable;
			const overlay = await isolatedModule.overlayModule.create(
				db, isolatedModule.createOverlaySchema(underlying.tableSchema!));
			// Overlay rows carry a trailing tombstone column (0 = live).
			await overlay.update({ operation: 'insert', values: [BIG, 'beta', 0] });
			isolatedModule.setConnectionOverlay(db, 'main', 'big', { overlayTable: overlay, hasChanges: true, db });

			// Secondary-index scan hitting the committed row. The merge builds a modified-PK
			// set over the overlay (which now holds a bigint PK); pre-fix that build throws
			// "Do not know how to serialize a BigInt" via JSON.stringify.
			const alpha = await asyncIterableToArray(db.eval(`SELECT * FROM big WHERE tag = 'alpha'`));
			expect(alpha.length).to.equal(1);
			expect(alpha[0].id).to.equal(1);

			// Secondary-index scan hitting the staged bigint-PK overlay row — confirms the
			// bigint PK round-trips through the merge intact.
			const beta = await asyncIterableToArray(db.eval(`SELECT * FROM big WHERE tag = 'beta'`));
			expect(beta.length).to.equal(1);
			expect(beta[0].id).to.equal(BIG);
		});

		it('does not duplicate a NOCASE-PK row whose key changes only in case', async () => {
			await db.exec(`
				CREATE TABLE items (
					id TEXT COLLATE NOCASE PRIMARY KEY,
					tag TEXT
				) USING isolated
			`);
			await db.exec(`CREATE INDEX idx_tag ON items(tag)`);

			// Seed + commit a lowercase-keyed row.
			await db.exec(`INSERT INTO items VALUES ('abc', 'shared')`);

			await db.exec('BEGIN');
			// Rewrite the PK to differ only in case — the SAME logical key under NOCASE,
			// so the overlay row shadows the underlying 'abc'. Pre-fix the JSON key encoding
			// ignores collation ('ABC' != 'abc'), so the underlying row is not excluded and
			// the scan yields BOTH.
			await db.exec(`UPDATE items SET id = 'ABC' WHERE id = 'abc'`);

			const rows = await asyncIterableToArray(
				db.eval(`SELECT * FROM items WHERE tag = 'shared'`)
			);
			expect(rows.length).to.equal(1);
			expect(rows[0].id).to.equal('ABC');

			await db.exec('ROLLBACK');
		});

		it('keeps case-distinct rows of an undecorated `any` PK separate (BINARY identity)', async () => {
			// An `any` PK with no COLLATE compares — and keys — under BINARY (the session
			// default never applies a non-BINARY collation to ANY), so 'A' and 'a' are
			// genuinely distinct rows and the modified-PK normalizer must not merge them.
			await db.exec(`
				CREATE TABLE t (
					k ANY PRIMARY KEY,
					v TEXT
				) USING isolated
			`);
			await db.exec(`CREATE INDEX idx_v ON t(v)`);

			await db.exec(`INSERT INTO t VALUES ('A', 'upper')`);
			await db.exec(`INSERT INTO t VALUES ('a', 'lower')`);

			await db.exec('BEGIN');
			// Modify one of the pair via a secondary-index-driven scan (idx_v), which builds
			// its modified-PK set through the collation-aware key normalizer. A normalizer
			// that wrongly keyed this shape NOCASE would treat 'A' and 'a' as the same PK
			// and exclude the untouched 'a' row from the merge.
			await db.exec(`UPDATE t SET v = 'changed' WHERE k = 'A'`);

			const changed = await asyncIterableToArray(db.eval(`SELECT k, v FROM t WHERE v = 'changed'`));
			expect(changed.length).to.equal(1);
			expect(changed[0].k).to.equal('A');

			const untouched = await asyncIterableToArray(db.eval(`SELECT k, v FROM t WHERE v = 'lower'`));
			expect(untouched.length).to.equal(1);
			expect(untouched[0].k).to.equal('a');

			await db.exec('ROLLBACK');
		});

		it('collapses case variants of an `any collate nocase` PK — one logical key, shadowed across case', async () => {
			// ANY_TYPE.compare honors the collation it is handed
			// (any-type-compare-honors-collation), so a declared NOCASE on an `any` PK is
			// a real identity: the case variant is a PK violation, and an in-transaction
			// case-only rewrite must shadow the underlying spelling — mirroring the TEXT
			// COLLATE NOCASE PK case above.
			await db.exec(`
				CREATE TABLE t (
					k ANY COLLATE NOCASE PRIMARY KEY,
					v TEXT
				) USING isolated
			`);
			await db.exec(`CREATE INDEX idx_v ON t(v)`);

			await db.exec(`INSERT INTO t VALUES ('abc', 'shared')`);
			let err: Error | null = null;
			try { await db.exec(`INSERT INTO t VALUES ('ABC', 'dup')`); } catch (e) { err = e as Error; }
			expect(err?.message ?? '', 'the case variant is the same NOCASE key').to.match(/constraint/i);

			await db.exec('BEGIN');
			// Case-only PK rewrite: the overlay row must shadow the underlying 'abc' —
			// a modified-PK normalizer keyed BINARY would miss it and the scan would
			// surface both spellings.
			await db.exec(`UPDATE t SET k = 'ABC' WHERE k = 'abc'`);
			const rows = await asyncIterableToArray(db.eval(`SELECT k FROM t WHERE v = 'shared'`));
			expect(rows.length).to.equal(1);
			expect(rows[0].k).to.equal('ABC');
			await db.exec('ROLLBACK');
		});

		it('enforces a non-PK UNIQUE when an insert revives a tombstoned PK in the same txn', async () => {
			await db.exec(`
				CREATE TABLE t (
					id INTEGER PRIMARY KEY,
					u TEXT UNIQUE
				) USING isolated
			`);

			// Seed + commit A (pk=1, u='x') and B (pk=2, u='y').
			await db.exec(`INSERT INTO t VALUES (1, 'x')`);
			await db.exec(`INSERT INTO t VALUES (2, 'y')`);

			await db.exec('BEGIN');
			// Tombstone A, then revive pk=1 with u='y' — collides with B on UNIQUE(u).
			// Pre-fix the revival branch early-returns without the merged UNIQUE check,
			// so the collision is missed here and later flushed with trustedWrite, yielding
			// an opaque INTERNAL error at commit instead of a clean constraint violation.
			await db.exec(`DELETE FROM t WHERE id = 1`);

			let err: unknown;
			try {
				await db.exec(`INSERT INTO t VALUES (1, 'y')`);
			} catch (e) {
				err = e;
			}
			expect(err, 'reviving a tombstoned PK into a UNIQUE collision must throw').to.be.instanceOf(QuereusError);
			expect((err as QuereusError).code).to.equal(StatusCode.CONSTRAINT);

			await db.exec('ROLLBACK');

			// B is intact after rollback.
			const b = await db.get(`SELECT * FROM t WHERE id = 2`);
			expect(b?.u).to.equal('y');
		});

		it('evicts the UNIQUE-colliding row when OR REPLACE revives a tombstoned PK in the same txn', async () => {
			await db.exec(`
				CREATE TABLE t (
					id INTEGER PRIMARY KEY,
					u TEXT UNIQUE
				) USING isolated
			`);

			// Seed + commit A (pk=1, u='x') and B (pk=2, u='y').
			await db.exec(`INSERT INTO t VALUES (1, 'x')`);
			await db.exec(`INSERT INTO t VALUES (2, 'y')`);

			await db.exec('BEGIN');
			// Tombstone A, then revive pk=1 with u='y' via OR REPLACE — collides with B
			// on UNIQUE(u). Unlike the ABORT case, REPLACE must resolve the collision by
			// evicting B (tombstoning its PK in the overlay) rather than throwing. This
			// exercises the tombstone-revival branch's merged UNIQUE check on its REPLACE
			// path (checkMergedUniqueConstraints -> insertTombstoneForPK + evicted).
			await db.exec(`DELETE FROM t WHERE id = 1`);
			await db.exec(`INSERT OR REPLACE INTO t VALUES (1, 'y')`);

			// Within the txn the merged view holds exactly the revived row; B is evicted.
			const rows = await asyncIterableToArray(db.eval(`SELECT * FROM t ORDER BY id`));
			expect(rows.length).to.equal(1);
			expect(rows[0].id).to.equal(1);
			expect(rows[0].u).to.equal('y');
			const gone = await db.get(`SELECT * FROM t WHERE id = 2`);
			expect(gone).to.equal(undefined);

			await db.exec('ROLLBACK');

			// After rollback the committed A and B are both intact.
			const a = await db.get(`SELECT * FROM t WHERE id = 1`);
			expect(a?.u).to.equal('x');
			const b = await db.get(`SELECT * FROM t WHERE id = 2`);
			expect(b?.u).to.equal('y');
		});
	});

	describe('per-connection isolation', () => {
		it('separate SQL statements share the same overlay within a transaction', async () => {
			// This test verifies the fix for the original architecture flaw where
			// each SQL statement got a fresh IsolatedTable instance via connect(),
			// and without per-connection overlay storage, the INSERT's overlay
			// wouldn't be visible to the subsequent SELECT.
			const memoryModule = new MemoryTableModule();
			const isolatedModule = new IsolationModule({
				underlying: memoryModule,
			});
			db.registerModule('isolated', isolatedModule);

			await db.exec(`CREATE TABLE test (id INTEGER PRIMARY KEY, name TEXT) USING isolated`);

			// Start a transaction
			await db.exec('BEGIN');

			// Each of these statements creates a new IsolatedTable via module.connect()
			// The overlay must be shared across all of them for read-your-own-writes to work
			await db.exec(`INSERT INTO test VALUES (1, 'First')`);  // Statement 1 - creates overlay
			await db.exec(`INSERT INTO test VALUES (2, 'Second')`); // Statement 2 - must use same overlay

			// Statement 3 - SELECT must see both inserts from the shared overlay
			const row1 = await db.get(`SELECT * FROM test WHERE id = 1`);
			const row2 = await db.get(`SELECT * FROM test WHERE id = 2`);

			expect(row1?.name).to.equal('First');
			expect(row2?.name).to.equal('Second');

			// Statement 4 - UPDATE must find the row in the shared overlay
			await db.exec(`UPDATE test SET name = 'Updated' WHERE id = 1`);

			// Statement 5 - SELECT must see the update from the shared overlay
			const updated = await db.get(`SELECT * FROM test WHERE id = 1`);
			expect(updated?.name).to.equal('Updated');

			// Statement 6 - DELETE must find the row in the shared overlay
			await db.exec(`DELETE FROM test WHERE id = 2`);

			// Statement 7 - SELECT must see the deletion (row gone)
			const deleted = await db.get(`SELECT * FROM test WHERE id = 2`);
			expect(deleted).to.be.undefined;

			// Verify final state before commit
			const all = await asyncIterableToArray(db.eval(`SELECT * FROM test ORDER BY id`));
			expect(all.length).to.equal(1);
			expect(all[0].name).to.equal('Updated');

			await db.exec('COMMIT');

			// After commit, changes should be in underlying
			const afterCommit = await asyncIterableToArray(db.eval(`SELECT * FROM test ORDER BY id`));
			expect(afterCommit.length).to.equal(1);
			expect(afterCommit[0].name).to.equal('Updated');
		});

		it('overlay is created lazily on first write', async () => {
			const memoryModule = new MemoryTableModule();
			const isolatedModule = new IsolationModule({
				underlying: memoryModule,
			});
			db.registerModule('isolated', isolatedModule);

			await db.exec(`CREATE TABLE test (id INTEGER PRIMARY KEY, name TEXT) USING isolated`);

			// Before any writes, overlay should not exist
			// (We can't easily test this directly, but we can verify reads work without overlay)
			const emptyResult = await asyncIterableToArray(db.eval(`SELECT * FROM test`));
			expect(emptyResult).to.deep.equal([]);

			// After write, overlay is created
			await db.exec('BEGIN');
			await db.exec(`INSERT INTO test VALUES (1, 'First')`);

			// Read should work and see uncommitted data
			const result = await db.get(`SELECT * FROM test WHERE id = 1`);
			expect(result?.name).to.equal('First');

			await db.exec('COMMIT');
		});

		it('overlay persists across multiple queries in same transaction', async () => {
			const memoryModule = new MemoryTableModule();
			const isolatedModule = new IsolationModule({
				underlying: memoryModule,
			});
			db.registerModule('isolated', isolatedModule);

			await db.exec(`CREATE TABLE test (id INTEGER PRIMARY KEY, value INTEGER) USING isolated`);

			await db.exec('BEGIN');

			// Multiple inserts
			await db.exec(`INSERT INTO test VALUES (1, 100)`);
			await db.exec(`INSERT INTO test VALUES (2, 200)`);
			await db.exec(`INSERT INTO test VALUES (3, 300)`);

			// Multiple reads should all see uncommitted data
			const r1 = await db.get(`SELECT * FROM test WHERE id = 1`);
			const r2 = await db.get(`SELECT * FROM test WHERE id = 2`);
			const r3 = await db.get(`SELECT * FROM test WHERE id = 3`);

			expect(r1?.value).to.equal(100);
			expect(r2?.value).to.equal(200);
			expect(r3?.value).to.equal(300);

			// Update should work on uncommitted data
			await db.exec(`UPDATE test SET value = 999 WHERE id = 2`);
			const r2Updated = await db.get(`SELECT * FROM test WHERE id = 2`);
			expect(r2Updated?.value).to.equal(999);

			await db.exec('COMMIT');

			// After commit, all changes should be permanent
			const all = await asyncIterableToArray(db.eval(`SELECT * FROM test ORDER BY id`));
			expect(all.length).to.equal(3);
			expect(all[1].value).to.equal(999);
		});

		it('overlay is cleared after rollback', async () => {
			const memoryModule = new MemoryTableModule();
			const isolatedModule = new IsolationModule({
				underlying: memoryModule,
			});
			db.registerModule('isolated', isolatedModule);

			await db.exec(`CREATE TABLE test (id INTEGER PRIMARY KEY) USING isolated`);

			// Commit some initial data
			await db.exec(`INSERT INTO test VALUES (1)`);

			// Start transaction and insert more
			await db.exec('BEGIN');
			await db.exec(`INSERT INTO test VALUES (2)`);
			await db.exec(`INSERT INTO test VALUES (3)`);

			// Should see all 3 rows
			const beforeRollback = await asyncIterableToArray(db.eval(`SELECT * FROM test ORDER BY id`));
			expect(beforeRollback.length).to.equal(3);

			// Rollback
			await db.exec('ROLLBACK');

			// Should only see committed row
			const afterRollback = await asyncIterableToArray(db.eval(`SELECT * FROM test ORDER BY id`));
			expect(afterRollback.length).to.equal(1);
			expect(afterRollback[0].id).to.equal(1);

			// Start a new transaction - overlay should be fresh
			await db.exec('BEGIN');
			await db.exec(`INSERT INTO test VALUES (4)`);

			const newTx = await asyncIterableToArray(db.eval(`SELECT * FROM test ORDER BY id`));
			expect(newTx.length).to.equal(2);
			expect(newTx.map((r: any) => r.id)).to.deep.equal([1, 4]);

			await db.exec('COMMIT');
		});

		it('overlay is cleared after commit', async () => {
			const memoryModule = new MemoryTableModule();
			const isolatedModule = new IsolationModule({
				underlying: memoryModule,
			});
			db.registerModule('isolated', isolatedModule);

			await db.exec(`CREATE TABLE test (id INTEGER PRIMARY KEY) USING isolated`);

			// First transaction
			await db.exec('BEGIN');
			await db.exec(`INSERT INTO test VALUES (1)`);
			await db.exec('COMMIT');

			// Second transaction - should start fresh
			await db.exec('BEGIN');
			await db.exec(`INSERT INTO test VALUES (2)`);

			// Should see both committed and uncommitted
			const duringTx = await asyncIterableToArray(db.eval(`SELECT * FROM test ORDER BY id`));
			expect(duringTx.length).to.equal(2);

			await db.exec('ROLLBACK');

			// After rollback, should only see first committed row
			const afterRollback = await asyncIterableToArray(db.eval(`SELECT * FROM test ORDER BY id`));
			expect(afterRollback.length).to.equal(1);
			expect(afterRollback[0].id).to.equal(1);
		});
	});

	describe('savepoints', () => {
		let isolatedModule: IsolationModule;

		beforeEach(() => {
			const memoryModule = new MemoryTableModule();
			isolatedModule = new IsolationModule({
				underlying: memoryModule,
			});
			db.registerModule('isolated', isolatedModule);
		});

		it('savepoint + release preserves changes', async () => {
			await db.exec(`CREATE TABLE test (id INTEGER PRIMARY KEY, name TEXT) USING isolated`);
			await db.exec('BEGIN');
			await db.exec(`INSERT INTO test VALUES (1, 'before')`);
			await db.exec('SAVEPOINT sp1');
			await db.exec(`INSERT INTO test VALUES (2, 'in savepoint')`);
			await db.exec('RELEASE SAVEPOINT sp1');

			// Both rows visible after release
			const rows = await asyncIterableToArray(db.eval('SELECT * FROM test ORDER BY id'));
			expect(rows.length).to.equal(2);
			expect(rows[0].name).to.equal('before');
			expect(rows[1].name).to.equal('in savepoint');

			await db.exec('COMMIT');

			// Both rows committed
			const committed = await asyncIterableToArray(db.eval('SELECT * FROM test ORDER BY id'));
			expect(committed.length).to.equal(2);
		});

		it('rollback to savepoint discards changes after savepoint', async () => {
			await db.exec(`CREATE TABLE test (id INTEGER PRIMARY KEY, name TEXT) USING isolated`);
			await db.exec('BEGIN');
			await db.exec(`INSERT INTO test VALUES (1, 'keeper')`);
			await db.exec('SAVEPOINT sp1');
			await db.exec(`INSERT INTO test VALUES (2, 'discard')`);
			await db.exec(`INSERT INTO test VALUES (3, 'also discard')`);
			await db.exec('ROLLBACK TO SAVEPOINT sp1');

			// Only the row before savepoint should remain
			const rows = await asyncIterableToArray(db.eval('SELECT * FROM test ORDER BY id'));
			expect(rows.length).to.equal(1);
			expect(rows[0].name).to.equal('keeper');

			await db.exec('COMMIT');

			const committed = await asyncIterableToArray(db.eval('SELECT * FROM test ORDER BY id'));
			expect(committed.length).to.equal(1);
			expect(committed[0].id).to.equal(1);
		});

		it('nested savepoints rollback independently', async () => {
			await db.exec(`CREATE TABLE test (id INTEGER PRIMARY KEY, value INTEGER) USING isolated`);
			await db.exec('BEGIN');
			await db.exec('INSERT INTO test VALUES (1, 100)');
			await db.exec('SAVEPOINT sp_outer');
			await db.exec('INSERT INTO test VALUES (2, 200)');
			await db.exec('SAVEPOINT sp_inner');
			await db.exec('INSERT INTO test VALUES (3, 300)');

			// All three visible
			let rows = await asyncIterableToArray(db.eval('SELECT * FROM test ORDER BY id'));
			expect(rows.length).to.equal(3);

			// Rollback inner savepoint - row 3 gone
			await db.exec('ROLLBACK TO SAVEPOINT sp_inner');
			rows = await asyncIterableToArray(db.eval('SELECT * FROM test ORDER BY id'));
			expect(rows.length).to.equal(2);
			expect(rows.map((r: any) => r.id)).to.deep.equal([1, 2]);

			// Rollback outer savepoint - row 2 also gone
			await db.exec('ROLLBACK TO SAVEPOINT sp_outer');
			rows = await asyncIterableToArray(db.eval('SELECT * FROM test ORDER BY id'));
			expect(rows.length).to.equal(1);
			expect(rows[0].id).to.equal(1);

			await db.exec('COMMIT');
			const committed = await asyncIterableToArray(db.eval('SELECT * FROM test ORDER BY id'));
			expect(committed.length).to.equal(1);
		});

		it('savepoint rollback then continue adding data', async () => {
			await db.exec(`CREATE TABLE test (id INTEGER PRIMARY KEY, name TEXT) USING isolated`);
			await db.exec('BEGIN');
			await db.exec(`INSERT INTO test VALUES (1, 'stays')`);
			await db.exec('SAVEPOINT sp1');
			await db.exec(`INSERT INTO test VALUES (2, 'gone')`);
			await db.exec('ROLLBACK TO SAVEPOINT sp1');

			// Can insert new data after rollback to savepoint
			await db.exec(`INSERT INTO test VALUES (3, 'new after rollback')`);

			const rows = await asyncIterableToArray(db.eval('SELECT * FROM test ORDER BY id'));
			expect(rows.length).to.equal(2);
			expect(rows.map((r: any) => r.id)).to.deep.equal([1, 3]);

			await db.exec('COMMIT');
			const committed = await asyncIterableToArray(db.eval('SELECT * FROM test ORDER BY id'));
			expect(committed.length).to.equal(2);
		});

		it('savepoint with update and delete operations', async () => {
			await db.exec(`CREATE TABLE test (id INTEGER PRIMARY KEY, name TEXT) USING isolated`);
			await db.exec(`INSERT INTO test VALUES (1, 'Alice')`);
			await db.exec(`INSERT INTO test VALUES (2, 'Bob')`);

			await db.exec('BEGIN');
			await db.exec('SAVEPOINT sp1');
			await db.exec(`UPDATE test SET name = 'ALICE' WHERE id = 1`);
			await db.exec(`DELETE FROM test WHERE id = 2`);

			// Verify changes visible
			let rows = await asyncIterableToArray(db.eval('SELECT * FROM test ORDER BY id'));
			expect(rows.length).to.equal(1);
			expect(rows[0].name).to.equal('ALICE');

			// Rollback savepoint restores original
			await db.exec('ROLLBACK TO SAVEPOINT sp1');
			rows = await asyncIterableToArray(db.eval('SELECT * FROM test ORDER BY id'));
			expect(rows.length).to.equal(2);
			expect(rows[0].name).to.equal('Alice');
			expect(rows[1].name).to.equal('Bob');

			await db.exec('COMMIT');
		});

		it('pre-overlay savepoint: rollback to savepoint created before first write clears overlay', async () => {
			// sp1 is created before any write in this transaction (so before the overlay exists).
			// After the INSERT creates the overlay, ROLLBACK TO sp1 must wipe the overlay entirely.
			await db.exec(`CREATE TABLE test (id INTEGER PRIMARY KEY, name TEXT) USING isolated`);
			await db.exec(`INSERT INTO test VALUES (1, 'committed')`);

			await db.exec('BEGIN');
			await db.exec('SAVEPOINT sp1');      // sp1 pre-dates the overlay
			await db.exec(`INSERT INTO test VALUES (2, 'will-vanish')`); // creates overlay
			await db.exec('ROLLBACK TO SAVEPOINT sp1');

			// Overlay should be wiped — only the pre-transaction committed row is visible
			const rows = await asyncIterableToArray(db.eval('SELECT * FROM test ORDER BY id'));
			expect(rows.length).to.equal(1);
			expect(rows[0].id).to.equal(1);

			await db.exec('ROLLBACK');

			// Underlying unchanged
			const afterRollback = await asyncIterableToArray(db.eval('SELECT * FROM test'));
			expect(afterRollback.length).to.equal(1);
			expect(afterRollback[0].id).to.equal(1);
		});

		it('savepoint before any access: rollback to savepoint undoes lazy-registered connection writes', async () => {
			// IsolatedConnection is registered lazily on first read/write. When
			// SAVEPOINT runs before any access to the table, the connection does
			// not yet exist, so the DB's savepoint broadcast skips it. The first
			// INSERT then registers the connection — which must inherit the
			// active savepoint stack so a subsequent ROLLBACK TO targets a real
			// entry, not an out-of-range index.
			await db.exec(`CREATE TABLE test (id INTEGER PRIMARY KEY, name TEXT) USING isolated`);

			await db.exec('BEGIN');
			await db.exec('SAVEPOINT sp');                                // no IsolatedConnection registered yet
			await db.exec(`INSERT INTO test VALUES (1, 'will-vanish')`); // registers connection NOW
			await db.exec('ROLLBACK TO SAVEPOINT sp');

			const rows = await asyncIterableToArray(db.eval('SELECT * FROM test'));
			expect(rows.length).to.equal(0);

			await db.exec('ROLLBACK');
		});

		it('mixed pre/post-overlay savepoints: rollback to post-overlay sp2 keeps first write, rollback to pre-overlay sp1 wipes all', async () => {
			// sp1 is pre-overlay, sp2 is post-overlay (created after first INSERT).
			// ROLLBACK TO sp2 should keep the INSERT before sp2.
			// ROLLBACK TO sp1 should then wipe everything from the transaction.
			await db.exec(`CREATE TABLE test (id INTEGER PRIMARY KEY, name TEXT) USING isolated`);
			await db.exec(`INSERT INTO test VALUES (1, 'committed')`);

			await db.exec('BEGIN');
			await db.exec('SAVEPOINT sp1');                               // sp1 pre-overlay
			await db.exec(`INSERT INTO test VALUES (2, 'after-sp1')`);   // creates overlay
			await db.exec('SAVEPOINT sp2');                               // sp2 post-overlay
			await db.exec(`INSERT INTO test VALUES (3, 'after-sp2')`);

			// ROLLBACK TO sp2: undo INSERT (3), keep INSERT (2)
			await db.exec('ROLLBACK TO SAVEPOINT sp2');
			let rows = await asyncIterableToArray(db.eval('SELECT * FROM test ORDER BY id'));
			expect(rows.map((r: any) => r.id)).to.deep.equal([1, 2]);

			// ROLLBACK TO sp1: wipe entire overlay (sp1 pre-dates the overlay)
			await db.exec('ROLLBACK TO SAVEPOINT sp1');
			rows = await asyncIterableToArray(db.eval('SELECT * FROM test ORDER BY id'));
			expect(rows.map((r: any) => r.id)).to.deep.equal([1]);

			await db.exec('COMMIT');

			// Only the pre-transaction row survives
			const afterCommit = await asyncIterableToArray(db.eval('SELECT * FROM test'));
			expect(afterCommit.length).to.equal(1);
			expect(afterCommit[0].id).to.equal(1);
		});

		/** Every live pre-overlay savepoint set, keyed `<dbId>:<schema>.<table>`. */
		function preOverlaySavepointEntries(): [string, Set<number>][] {
			const map = (isolatedModule as unknown as { preOverlaySavepoints: Map<string, Set<number>> }).preOverlaySavepoints;
			return [...map.entries()];
		}

		it('a mid-transaction RENAME TO leaves no pre-overlay savepoint depths behind after commit', async () => {
			await db.exec(`create table widget (id integer primary key, name text) using isolated`);
			await db.exec('begin');
			await db.exec('savepoint s1');
			await db.exec(`insert into widget values (1, 'a')`);
			await db.exec('alter table widget rename to gadget');
			await db.exec('commit');

			// Pre-fix, renameTable re-keyed the depth set onto `gadget`, where the old-name
			// IsolatedTable's commit callback could not clear it.
			for (const [key, depths] of preOverlaySavepointEntries()) {
				expect([...depths], `stranded savepoint depths under ${key}`).to.deep.equal([]);
			}
		});

		it('a stale pre-overlay depth from a renaming transaction does not wipe the next transaction\'s overlay', async () => {
			await db.exec(`create table widget (id integer primary key, name text) using isolated`);

			// Txn 1: two user savepoints before the first write, then rename. Pre-fix this
			// leaked depths {0, 1} under `gadget`. Depth 1 survives statement-level scrubbing.
			await db.exec('begin');
			await db.exec('savepoint a');
			await db.exec('savepoint b');
			await db.exec(`insert into widget values (1, 'a')`);
			await db.exec('alter table widget rename to gadget');
			await db.exec('commit');

			// Txn 2: row 2 is written before any savepoint, so it must survive the rollback.
			await db.exec('begin');
			await db.exec(`insert into gadget values (2, 'b')`);
			await db.exec('savepoint s1');
			await db.exec('savepoint s2');               // depth 1 — matched the stale entry
			await db.exec(`insert into gadget values (3, 'c')`);
			await db.exec('rollback to savepoint s2');   // pre-fix: discarded the whole overlay
			await db.exec('commit');

			const rows = await asyncIterableToArray(db.eval('select id from gadget order by id'));
			expect(rows.map((r: any) => r.id)).to.deep.equal([1, 2]);
		});

		it('a savepoint taken before the overlay still discards it after a RENAME TO', async () => {
			await db.exec(`create table widget (id integer primary key, name text) using isolated`);
			await db.exec('begin');
			await db.exec('savepoint s1');                    // pre-dates the overlay
			await db.exec('alter table widget rename to gadget');
			await db.exec(`insert into gadget values (1, 'a')`);
			await db.exec('rollback to savepoint s1');
			await db.exec('commit');

			// The post-rename IsolatedTable rebuilds its own pre-overlay depth set from
			// Database.registerConnection's savepoint replay, so nothing had to be carried
			// across the rename for the rollback to reach the overlay. The table is still
			// `gadget` afterwards: Quereus DDL is non-transactional, so `rollback to` does
			// not undo the rename — only the row staged after the savepoint.
			const rows = await asyncIterableToArray(db.eval('select id from gadget'));
			expect(rows.map((r: any) => r.id)).to.deep.equal([]);
		});

		it('two RENAME TO in one transaction strand no pre-overlay savepoint depths', async () => {
			await db.exec(`create table widget (id integer primary key, name text) using isolated`);
			await db.exec('begin');
			await db.exec('savepoint s1');
			await db.exec(`insert into widget values (1, 'a')`);
			await db.exec('alter table widget rename to gadget');
			await db.exec(`insert into gadget values (2, 'b')`);
			await db.exec('alter table gadget rename to doohickey');
			await db.exec('commit');

			for (const [key, depths] of preOverlaySavepointEntries()) {
				expect([...depths], `stranded savepoint depths under ${key}`).to.deep.equal([]);
			}
			const rows = await asyncIterableToArray(db.eval('select id from doohickey order by id'));
			expect(rows.map((r: any) => r.id)).to.deep.equal([1, 2]);
		});
	});

	describe('compound primary keys', () => {
		let isolatedModule: IsolationModule;

		beforeEach(() => {
			const memoryModule = new MemoryTableModule();
			isolatedModule = new IsolationModule({
				underlying: memoryModule,
			});
			db.registerModule('isolated', isolatedModule);
		});

		it('supports CRUD with composite primary keys', async () => {
			await db.exec(`
				CREATE TABLE orders (
					customer_id INTEGER,
					order_id INTEGER,
					amount REAL,
					PRIMARY KEY (customer_id, order_id)
				) USING isolated
			`);

			// Insert
			await db.exec(`INSERT INTO orders VALUES (1, 100, 9.99)`);
			await db.exec(`INSERT INTO orders VALUES (1, 101, 19.99)`);
			await db.exec(`INSERT INTO orders VALUES (2, 100, 5.00)`);

			// Read
			const all = await asyncIterableToArray(
				db.eval('SELECT * FROM orders ORDER BY customer_id, order_id')
			);
			expect(all.length).to.equal(3);

			// Update
			await db.exec('UPDATE orders SET amount = 14.99 WHERE customer_id = 1 AND order_id = 100');
			const updated = await db.get('SELECT amount FROM orders WHERE customer_id = 1 AND order_id = 100');
			expect(updated?.amount).to.equal(14.99);

			// Delete
			await db.exec('DELETE FROM orders WHERE customer_id = 2 AND order_id = 100');
			const afterDelete = await asyncIterableToArray(
				db.eval('SELECT * FROM orders ORDER BY customer_id, order_id')
			);
			expect(afterDelete.length).to.equal(2);
		});

		it('composite PK isolation within transaction', async () => {
			await db.exec(`
				CREATE TABLE kv (
					ns TEXT,
					key TEXT,
					value TEXT,
					PRIMARY KEY (ns, key)
				) USING isolated
			`);

			await db.exec(`INSERT INTO kv VALUES ('a', 'k1', 'original')`);

			await db.exec('BEGIN');
			await db.exec(`INSERT INTO kv VALUES ('a', 'k2', 'new')`);
			await db.exec(`UPDATE kv SET value = 'modified' WHERE ns = 'a' AND key = 'k1'`);

			// Read-your-own-writes
			const rows = await asyncIterableToArray(
				db.eval(`SELECT * FROM kv WHERE ns = 'a' ORDER BY key`)
			);
			expect(rows.length).to.equal(2);
			expect(rows[0].value).to.equal('modified');
			expect(rows[1].value).to.equal('new');

			await db.exec('ROLLBACK');

			// After rollback, only original data
			const afterRollback = await asyncIterableToArray(
				db.eval(`SELECT * FROM kv ORDER BY ns, key`)
			);
			expect(afterRollback.length).to.equal(1);
			expect(afterRollback[0].value).to.equal('original');
		});
	});

	describe('transaction edge cases', () => {
		let isolatedModule: IsolationModule;

		beforeEach(() => {
			const memoryModule = new MemoryTableModule();
			isolatedModule = new IsolationModule({
				underlying: memoryModule,
			});
			db.registerModule('isolated', isolatedModule);
		});

		it('empty transaction commits successfully', async () => {
			await db.exec(`CREATE TABLE test (id INTEGER PRIMARY KEY) USING isolated`);
			await db.exec('INSERT INTO test VALUES (1)');

			await db.exec('BEGIN');
			// No writes
			await db.exec('COMMIT');

			// Data unchanged
			const rows = await asyncIterableToArray(db.eval('SELECT * FROM test'));
			expect(rows.length).to.equal(1);
		});

		it('empty transaction rolls back successfully', async () => {
			await db.exec(`CREATE TABLE test (id INTEGER PRIMARY KEY) USING isolated`);
			await db.exec('INSERT INTO test VALUES (1)');

			await db.exec('BEGIN');
			// No writes
			await db.exec('ROLLBACK');

			// Data unchanged
			const rows = await asyncIterableToArray(db.eval('SELECT * FROM test'));
			expect(rows.length).to.equal(1);
		});

		it('sequential transactions see each other\'s committed data', async () => {
			await db.exec(`CREATE TABLE test (id INTEGER PRIMARY KEY, value TEXT) USING isolated`);

			// Transaction 1
			await db.exec('BEGIN');
			await db.exec(`INSERT INTO test VALUES (1, 'first')`);
			await db.exec('COMMIT');

			// Transaction 2 sees transaction 1's data
			await db.exec('BEGIN');
			const row = await db.get('SELECT * FROM test WHERE id = 1');
			expect(row?.value).to.equal('first');
			await db.exec(`INSERT INTO test VALUES (2, 'second')`);
			await db.exec('COMMIT');

			// Transaction 3 sees both
			await db.exec('BEGIN');
			const all = await asyncIterableToArray(db.eval('SELECT * FROM test ORDER BY id'));
			expect(all.length).to.equal(2);
			await db.exec('COMMIT');
		});

		it('autocommit statements commit individually', async () => {
			await db.exec(`CREATE TABLE test (id INTEGER PRIMARY KEY) USING isolated`);

			// Each statement is its own implicit transaction
			await db.exec('INSERT INTO test VALUES (1)');
			await db.exec('INSERT INTO test VALUES (2)');
			await db.exec('INSERT INTO test VALUES (3)');

			const rows = await asyncIterableToArray(db.eval('SELECT * FROM test ORDER BY id'));
			expect(rows.length).to.equal(3);
			expect(rows.map((r: any) => r.id)).to.deep.equal([1, 2, 3]);
		});

		it('read-only queries work without overlay', async () => {
			await db.exec(`CREATE TABLE test (id INTEGER PRIMARY KEY, name TEXT) USING isolated`);
			await db.exec(`INSERT INTO test VALUES (1, 'Alice')`);

			// Multiple reads without any writes in this "transaction"
			const r1 = await db.get('SELECT * FROM test WHERE id = 1');
			expect(r1?.name).to.equal('Alice');

			const count = await db.get('SELECT count(*) as c FROM test');
			expect(count?.c).to.equal(1);
		});

		it('delete-all then re-insert works', async () => {
			await db.exec(`CREATE TABLE test (id INTEGER PRIMARY KEY, name TEXT) USING isolated`);
			await db.exec(`INSERT INTO test VALUES (1, 'Alice')`);
			await db.exec(`INSERT INTO test VALUES (2, 'Bob')`);

			await db.exec('BEGIN');
			await db.exec('DELETE FROM test WHERE id = 1');
			await db.exec('DELETE FROM test WHERE id = 2');

			// Table empty
			let rows = await asyncIterableToArray(db.eval('SELECT * FROM test'));
			expect(rows.length).to.equal(0);

			// Re-insert with same PK
			await db.exec(`INSERT INTO test VALUES (1, 'Charlie')`);
			rows = await asyncIterableToArray(db.eval('SELECT * FROM test'));
			expect(rows.length).to.equal(1);
			expect(rows[0].name).to.equal('Charlie');

			await db.exec('COMMIT');

			const committed = await asyncIterableToArray(db.eval('SELECT * FROM test ORDER BY id'));
			expect(committed.length).to.equal(1);
			expect(committed[0].name).to.equal('Charlie');
		});

		it('update followed by delete of same row', async () => {
			await db.exec(`CREATE TABLE test (id INTEGER PRIMARY KEY, name TEXT) USING isolated`);
			await db.exec(`INSERT INTO test VALUES (1, 'Alice')`);

			await db.exec('BEGIN');
			await db.exec(`UPDATE test SET name = 'Updated' WHERE id = 1`);
			await db.exec(`DELETE FROM test WHERE id = 1`);

			const rows = await asyncIterableToArray(db.eval('SELECT * FROM test'));
			expect(rows.length).to.equal(0);

			await db.exec('COMMIT');

			const committed = await asyncIterableToArray(db.eval('SELECT * FROM test'));
			expect(committed.length).to.equal(0);
		});

		it('insert then update same row within transaction', async () => {
			await db.exec(`CREATE TABLE test (id INTEGER PRIMARY KEY, name TEXT) USING isolated`);

			await db.exec('BEGIN');
			await db.exec(`INSERT INTO test VALUES (1, 'original')`);
			await db.exec(`UPDATE test SET name = 'modified' WHERE id = 1`);

			const row = await db.get('SELECT * FROM test WHERE id = 1');
			expect(row?.name).to.equal('modified');

			await db.exec('COMMIT');

			const committed = await db.get('SELECT * FROM test WHERE id = 1');
			expect(committed?.name).to.equal('modified');
		});
	});

	describe('rename table', () => {
		let isolatedModule: IsolationModule;

		beforeEach(() => {
			const memoryModule = new MemoryTableModule();
			isolatedModule = new IsolationModule({
				underlying: memoryModule,
			});
			db.registerModule('isolated', isolatedModule);
		});

		it('preserves row data through ALTER TABLE RENAME TO', async () => {
			// Regression: IsolationModule did not forward renameTable to the
			// underlying module, so rows committed under the old name were lost
			// when subsequent queries hit a fresh underlying state for the new name.
			await db.exec(`CREATE TABLE t_rename (id INTEGER PRIMARY KEY, val TEXT) USING isolated`);
			await db.exec(`INSERT INTO t_rename VALUES (1, 'a'), (2, 'b')`);
			await db.exec(`ALTER TABLE t_rename RENAME TO t_renamed`);

			const rows = await asyncIterableToArray(db.eval(`SELECT * FROM t_renamed ORDER BY id`));
			expect(rows.length).to.equal(2);
			expect(rows.map((r: any) => [r.id, r.val])).to.deep.equal([[1, 'a'], [2, 'b']]);
		});

		it('allows writes against the renamed table', async () => {
			await db.exec(`CREATE TABLE t_rename (id INTEGER PRIMARY KEY, val TEXT) USING isolated`);
			await db.exec(`INSERT INTO t_rename VALUES (1, 'a')`);
			await db.exec(`ALTER TABLE t_rename RENAME TO t_renamed`);
			await db.exec(`INSERT INTO t_renamed VALUES (2, 'b')`);

			const rows = await asyncIterableToArray(db.eval(`SELECT * FROM t_renamed ORDER BY id`));
			expect(rows.map((r: any) => r.id)).to.deep.equal([1, 2]);
		});
	});

	/**
	 * Regressions for overlays orphaned by the table-lifecycle hooks.
	 *
	 * `commitConnectionOverlays` crosses from an overlay key (`<dbId>:<schema>.<table>`)
	 * to the `underlyingTables` entry with the same `<schema>.<table>` suffix. It used to
	 * `continue` past a miss, so a staged overlay whose underlying had been evicted by
	 * DROP TABLE or ALTER TABLE … RENAME TO had its rows silently discarded while COMMIT
	 * still reported success. `renameTable` now re-connects the underlying under the new
	 * name, `destroy` deliberately drops every connection's overlay for the dropped table,
	 * and a residual miss on a *staged* overlay is an INTERNAL error.
	 */
	describe('orphaned overlays across DROP TABLE / RENAME TO', () => {
		let iso: IsolationModule;

		beforeEach(() => {
			iso = new IsolationModule({ underlying: new MemoryTableModule() });
			db.registerModule('isolated', iso);
		});

		/**
		 * Rows actually present in the UNDERLYING storage, bypassing the merged read.
		 * The merged read is not a witness of a successful flush: a zombie overlay that
		 * survives its commit keeps merging into every subsequent read on this Database,
		 * so `select` returns the row even when nothing was persisted.
		 */
		async function underlyingRows(table: string): Promise<Row[]> {
			const underlying = iso.getUnderlyingState('main', table)!.underlyingTable;
			return await asyncIterableToArray(underlying.query!(makeFullScanFilterInfo()));
		}

		/** Live overlay keys (`<dbId>:<schema>.<table>`) across all connections. */
		function overlayKeys(): string[] {
			return [...(iso as unknown as { connectionOverlays: Map<string, unknown> }).connectionOverlays.keys()];
		}

		/** Live pre-overlay savepoint keys, keyed identically to the overlays. */
		function preOverlaySavepointKeys(): string[] {
			return [...(iso as unknown as { preOverlaySavepoints: Map<string, unknown> }).preOverlaySavepoints.keys()];
		}

		it('a mid-transaction RENAME TO still flushes the staged rows to underlying storage', async () => {
			await db.exec(`create table widget (id integer primary key, name text) using isolated`);
			await db.exec(`begin`);
			await db.exec(`insert into widget values (1, 'a')`);
			await db.exec(`alter table widget rename to gadget`);
			await db.exec(`commit`);

			// Pre-fix: the overlay was re-keyed onto `gadget` but no underlying existed under
			// that name, so the flush skipped it AND the clear-loop never removed it. Storage
			// stayed empty while the zombie overlay kept answering this connection's reads.
			expect(await underlyingRows('gadget'), 'row must be persisted in underlying storage')
				.to.deep.equal([[1, 'a']]);
			expect(overlayKeys(), 'no overlay may survive a successful commit').to.deep.equal([]);

			const merged = await asyncIterableToArray(db.eval(`select * from gadget`));
			expect(merged.map((r: any) => [r.id, r.name])).to.deep.equal([[1, 'a']]);
		});

		it('a mid-transaction RENAME TO preserves rows committed before the transaction', async () => {
			await db.exec(`create table widget (id integer primary key, name text) using isolated`);
			await db.exec(`insert into widget values (1, 'before')`);

			await db.exec(`begin`);
			await db.exec(`insert into widget values (2, 'staged')`);
			await db.exec(`alter table widget rename to gadget`);
			await db.exec(`commit`);

			// The re-connected underlying must be the SAME storage the pre-transaction row
			// lives in, not a fresh empty table: `underlying.renameTable` re-keys the storage
			// first, so `connect()` under the new name resolves the existing one.
			expect(await underlyingRows('gadget')).to.deep.equal([[1, 'before'], [2, 'staged']]);
			expect(overlayKeys()).to.deep.equal([]);
		});

		it('two RENAME TOs in one transaction still flush the staged rows', async () => {
			await db.exec(`create table widget (id integer primary key, name text) using isolated`);
			await db.exec(`begin`);
			await db.exec(`insert into widget values (1, 'a')`);
			await db.exec(`alter table widget rename to gadget`);
			await db.exec(`insert into gadget values (2, 'b')`);
			await db.exec(`alter table gadget rename to doohickey`);
			await db.exec(`commit`);

			// The second rename re-connects off the underlying the FIRST one registered, so the
			// chain has to survive an evict/re-connect at every hop.
			expect(await underlyingRows('doohickey')).to.deep.equal([[1, 'a'], [2, 'b']]);
			expect(overlayKeys()).to.deep.equal([]);
		});

		it('a mid-transaction RENAME TO of a table with no staged writes leaves storage intact', async () => {
			await db.exec(`create table widget (id integer primary key, name text) using isolated`);
			await db.exec(`insert into widget values (1, 'a')`);

			await db.exec(`begin`);
			await db.exec(`alter table widget rename to gadget`);
			await db.exec(`commit`);

			const merged = await asyncIterableToArray(db.eval(`select * from gadget`));
			expect(merged.map((r: any) => [r.id, r.name])).to.deep.equal([[1, 'a']]);
			expect(overlayKeys()).to.deep.equal([]);
		});

		it('DROP TABLE mid-transaction discards that table\'s overlay and commits the survivor', async () => {
			await db.exec(`create table a (id integer primary key, v text) using isolated`);
			await db.exec(`create table b (id integer primary key, v text) using isolated`);

			await db.exec(`begin`);
			await db.exec(`insert into a values (1, 'a1')`);
			await db.exec(`insert into b values (1, 'b1')`);
			await db.exec(`drop table b`);
			await db.exec(`commit`);

			// The surviving table's staged row lands; b's overlay was dropped by destroy(),
			// so the commit flush never sees an unresolvable staged overlay and never throws.
			expect(await underlyingRows('a')).to.deep.equal([[1, 'a1']]);
			expect(overlayKeys(), 'the dropped table leaves no overlay behind').to.deep.equal([]);
		});

		it('DROP TABLE mid-transaction of the only written table leaks no overlay or savepoint set', async () => {
			await db.exec(`create table widget (id integer primary key, name text) using isolated`);

			await db.exec(`begin`);
			await db.exec(`insert into widget values (1, 'a')`);
			expect(overlayKeys().length, 'the insert stages an overlay').to.equal(1);
			await db.exec(`drop table widget`);

			// Dropping the table disconnects it, so commitConnectionOverlays never runs for it.
			// Pre-fix the overlay (and its pre-overlay savepoint set) survived for the lifetime
			// of the Database; destroy() must clear both.
			expect(overlayKeys(), 'destroy() clears the overlay').to.deep.equal([]);
			expect(preOverlaySavepointKeys(), 'destroy() clears the savepoint set').to.deep.equal([]);

			await db.exec(`commit`);
			expect(overlayKeys()).to.deep.equal([]);
			expect(preOverlaySavepointKeys()).to.deep.equal([]);
		});

		/**
		 * Stages an overlay for `forDb` against `main.<table>` directly, exactly as the
		 * cross-connection ALTER suite does. What is under test is `destroy()`'s per-key
		 * decision across db ids, not how a foreign overlay came to exist.
		 *
		 * `dirty: true` inserts one live row so `hasChanges` is honest.
		 */
		async function stageOverlay(forDb: Database, dirty: boolean, table = 'shared'): Promise<ConnectionOverlayState> {
			const underlying = iso.getUnderlyingState('main', table)!.underlyingTable;
			const overlay = await iso.overlayModule.create(forDb, iso.createOverlaySchema(underlying.tableSchema!));
			if (dirty) await overlay.update({ operation: 'insert', values: [1, 'from-other', 0] });
			const state: ConnectionOverlayState = { overlayTable: overlay, hasChanges: dirty, db: forDb };
			iso.setConnectionOverlay(forDb, 'main', table, state);
			return state;
		}

		/**
		 * The `<dbId>:main.shared` key for `forDb`, recovered by state identity — `getDbId`
		 * is private, and the key must be captured while the overlay still exists.
		 */
		function overlayKeyFor(forDb: Database): string {
			const state = iso.getConnectionOverlay(forDb, 'main', 'shared')!;
			const map = (iso as unknown as { connectionOverlays: Map<string, ConnectionOverlayState> }).connectionOverlays;
			for (const [key, value] of map) {
				if (value === state) return key;
			}
			throw new Error('no overlay key found for the given database');
		}

		it('DROP TABLE poisons another connection\'s staged overlay instead of discarding it', async () => {
			await db.exec(`create table shared (id integer primary key, v text) using isolated`);

			// A second Database sharing the module gets its own dbId, hence its own overlay key.
			const other = new Database();
			const foreign = await stageOverlay(other, true);
			expect(overlayKeys().length, 'the foreign connection stages an overlay').to.equal(1);

			await db.exec(`drop table shared`);

			// Sweeping the overlay let `other` commit against an empty overlay set and report
			// success after its staged rows were thrown away. It must survive, poisoned, so the
			// poison check at the head of commitConnectionOverlays fires before the (now absent)
			// underlyingTables lookup.
			expect(overlayKeys().length, 'the foreign overlay survives the drop').to.equal(1);
			expect(foreign.poison, 'the foreign overlay is poisoned').to.not.be.undefined;
			expect(foreign.poison!.message).to.contain('main.shared');

			let caught: unknown;
			try {
				await iso.commitConnectionOverlays(other);
			} catch (e) {
				caught = e;
			}
			expect(caught, 'the foreign commit must fail, not silently succeed').to.be.instanceOf(QuereusError);
			expect((caught as QuereusError).code).to.equal(StatusCode.CONSTRAINT);
			expect((caught as QuereusError).message).to.contain('main.shared');

			await other.close();
		});

		it('DROP TABLE discards a foreign overlay that staged nothing', async () => {
			await db.exec(`create table shared (id integer primary key, v text) using isolated`);

			const other = new Database();
			await stageOverlay(other, false);
			expect(overlayKeys().length).to.equal(1);

			// hasChanges === false: nothing is lost, so there is nothing to report. Poisoning it
			// would fail a commit that has no staged rows to protect.
			await db.exec(`drop table shared`);
			expect(overlayKeys(), 'a clean foreign overlay is swept').to.deep.equal([]);

			await other.close();
		});

		it('DROP TABLE silently discards the dropping connection\'s own dirty overlay and savepoint set', async () => {
			await db.exec(`create table shared (id integer primary key, v text) using isolated`);

			const own = await stageOverlay(db, true);
			iso.getPreOverlaySavepoints(db, 'main', 'shared').add(0);
			expect(overlayKeys().length).to.equal(1);
			expect(preOverlaySavepointKeys().length).to.equal(1);

			// The dropping connection asked for the drop; there is nobody to notify.
			await db.exec(`drop table shared`);
			expect(overlayKeys(), 'own overlay is discarded').to.deep.equal([]);
			expect(own.poison, 'own overlay is never poisoned').to.be.undefined;
			expect(preOverlaySavepointKeys(), 'own savepoint set is reaped').to.deep.equal([]);
		});

		it('DROP TABLE keeps the savepoint set of a surviving poisoned overlay and reaps every other', async () => {
			await db.exec(`create table shared (id integer primary key, v text) using isolated`);

			const poisoned = new Database();
			const clean = new Database();
			await stageOverlay(poisoned, true);
			await stageOverlay(clean, false);
			const poisonedKey = overlayKeyFor(poisoned);
			iso.getPreOverlaySavepoints(poisoned, 'main', 'shared').add(0);
			iso.getPreOverlaySavepoints(clean, 'main', 'shared').add(0);
			iso.getPreOverlaySavepoints(db, 'main', 'shared').add(0);
			expect(preOverlaySavepointKeys().length).to.equal(3);

			await db.exec(`drop table shared`);

			// `ensureOverlay` padding still consults the surviving overlay's set, and the owning
			// connection's onConnectionRollback reaps it when its failed commit rolls back.
			expect(preOverlaySavepointKeys(), 'only the poisoned overlay keeps its set')
				.to.deep.equal([poisonedKey]);

			await poisoned.close();
			await clean.close();
		});

		it('DROP TABLE preserves an already-poisoned foreign overlay\'s original message', async () => {
			await db.exec(`create table shared (id integer primary key, v text) using isolated`);

			const other = new Database();
			const foreign = await stageOverlay(other, true);
			foreign.poison = { message: 'poisoned earlier by an ALTER' };

			await db.exec(`drop table shared`);

			// The first cause is the one worth reporting — the ALTER is why the rows are
			// unflushable in the first place. (Assert survival too: `foreign` is a live
			// reference, so a swept overlay would keep its message and pass vacuously.)
			expect(overlayKeys().length, 'the poisoned overlay survives').to.equal(1);
			expect(foreign.poison!.message).to.equal('poisoned earlier by an ALTER');
			await other.close();
		});

		it('the dropping connection escapes a poison it was already carrying for that table', async () => {
			await db.exec(`create table shared (id integer primary key, v text) using isolated`);

			// `db` was poisoned by some other connection's ALTER, then drops the table itself.
			// The own-overlay branch deletes the state, poison and all — correct, because the
			// rows it discards belong to a table this very connection asked to remove.
			const own = await stageOverlay(db, true);
			own.poison = { message: 'poisoned earlier by an ALTER' };

			await db.exec(`drop table shared`);

			expect(overlayKeys(), 'the dropping connection\'s poisoned overlay is discarded').to.deep.equal([]);
			await iso.commitConnectionOverlays(db); // no poisoned overlay left to abort on
		});

		it('a drop-poisoned connection errors at its merged read and its next write', async () => {
			await db.exec(`create table shared (id integer primary key, v text) using isolated`);

			// Connect BEFORE the drop: after it, `connect` can no longer resolve an underlying.
			// The IsolatedTable keeps its underlying handle, so only assertOverlayUsable stands
			// between the foreign connection and a destroyed table.
			const other = new Database();
			const tableOther = await iso.connect(other, undefined, 'isolated', 'main', 'shared', {} as BaseModuleConfig) as IsolatedTable;
			await stageOverlay(other, true);

			await db.exec(`drop table shared`);

			let readErr: unknown;
			try { await asyncIterableToArray(tableOther.query(makeFullScanFilterInfo())); } catch (e) { readErr = e; }
			expect(readErr, 'merged read on a drop-poisoned overlay must throw').to.be.instanceOf(QuereusError);
			expect((readErr as QuereusError).code).to.equal(StatusCode.CONSTRAINT);
			expect((readErr as QuereusError).message).to.contain('main.shared');

			let writeErr: unknown;
			try { await tableOther.update({ operation: 'insert', values: [2, 'more'] }); } catch (e) { writeErr = e; }
			expect(writeErr, 'write on a drop-poisoned overlay must throw before staging').to.be.instanceOf(QuereusError);
			expect((writeErr as QuereusError).code).to.equal(StatusCode.CONSTRAINT);

			await other.close();
		});

		it('a drop-poisoned overlay aborts the foreign multi-table commit before any table applies', async () => {
			await db.exec(`create table keep (id integer primary key, v text) using isolated`);
			await db.exec(`create table shared (id integer primary key, v text) using isolated`);

			// `keep` is staged FIRST, so commitConnectionOverlays walks it before it reaches the
			// poisoned `shared` entry. The poison check has to run over every overlay up front —
			// if it were folded into the apply loop, `keep` would already be committed.
			const other = new Database();
			await stageOverlay(other, true, 'keep');
			await stageOverlay(other, true, 'shared');

			await db.exec(`drop table shared`);

			let caught: unknown;
			try { await iso.commitConnectionOverlays(other); } catch (e) { caught = e; }
			expect(caught, 'the poisoned overlay aborts the whole commit').to.be.instanceOf(QuereusError);
			expect((caught as QuereusError).code).to.equal(StatusCode.CONSTRAINT);

			expect(await underlyingRows('keep'), 'no unrelated table may be left committed').to.deep.equal([]);
			expect(overlayKeys().length, 'both overlays survive for the ensuing rollback').to.equal(2);

			await other.close();
		});

		it('a failed underlying destroy leaves the overlay and underlying maps untouched', async () => {
			await db.exec(`create table widget (id integer primary key, name text) using isolated`);
			await db.exec(`begin`);
			await db.exec(`insert into widget values (1, 'a')`);
			expect(overlayKeys().length).to.equal(1);

			// The table still exists after a failed destroy, so its staged writes are still
			// flushable — discarding them (or evicting the underlying) before the underlying
			// module has agreed to the drop would lose them for good.
			const underlying = (iso as unknown as { underlying: MemoryTableModule }).underlying;
			const realDestroy = underlying.destroy.bind(underlying);
			underlying.destroy = async () => { throw new Error('storage refused the drop'); };
			let caught: unknown;
			try {
				await db.exec(`drop table widget`);
			} catch (e) {
				caught = e;
			} finally {
				underlying.destroy = realDestroy;
			}
			expect(caught, 'the failed drop propagates').to.not.be.undefined;

			expect(overlayKeys().length, 'staged overlay survives a failed drop').to.equal(1);
			expect(iso.getUnderlyingState('main', 'widget'), 'underlying handle survives a failed drop')
				.to.not.be.undefined;

			await db.exec(`commit`);
			expect(await underlyingRows('widget')).to.deep.equal([[1, 'a']]);
		});

		it('commitConnectionOverlays throws INTERNAL for a staged overlay with no underlying', async () => {
			await db.exec(`create table t (id integer primary key, v text) using isolated`);
			const underlying = iso.getUnderlyingState('main', 't')!.underlyingTable;

			// Hand-plant a staged overlay under a name that has no `underlyingTables` entry —
			// the state DROP TABLE / RENAME TO used to leave behind. Silently dropping these
			// rows and reporting a successful commit is the failure mode under test.
			const overlay = await iso.overlayModule.create(db, iso.createOverlaySchema(underlying.tableSchema!));
			await overlay.update({ operation: 'insert', values: [1, 'staged', 0] }); // trailing 0 = live
			iso.setConnectionOverlay(db, 'main', 'ghost', { overlayTable: overlay, hasChanges: true, db });

			let caught: unknown;
			try {
				await iso.commitConnectionOverlays(db);
			} catch (e) {
				caught = e;
			}
			expect(caught, 'an unresolvable staged overlay must not be silently dropped').to.be.instanceOf(QuereusError);
			expect((caught as QuereusError).code).to.equal(StatusCode.INTERNAL);
			expect((caught as QuereusError).message).to.contain('main.ghost');
		});

		it('commitConnectionOverlays clears — never throws on — a CLEAN overlay with no underlying', async () => {
			await db.exec(`create table t (id integer primary key, v text) using isolated`);
			const underlying = iso.getUnderlyingState('main', 't')!.underlyingTable;

			const overlay = await iso.overlayModule.create(db, iso.createOverlaySchema(underlying.tableSchema!));
			iso.setConnectionOverlay(db, 'main', 'ghost', { overlayTable: overlay, hasChanges: false, db });

			// Staged nothing, so nothing is lost. It also never reached the apply set, so the
			// clear-loop had to be taught about it explicitly or it would leak.
			await iso.commitConnectionOverlays(db);
			expect(iso.getConnectionOverlay(db, 'main', 'ghost'), 'clean orphan is cleared, not leaked')
				.to.be.undefined;
		});
	});

	describe('DROP INDEX forwards through the isolation layer', () => {
		// Regression: SchemaManager.dropIndex only invokes the registered module's
		// dropIndex hook. Without IsolationModule.dropIndex, the underlying
		// module never sees the drop and any synthesized UNIQUE constraint on
		// the IsolatedTable's cached schema keeps firing on subsequent inserts.
		let isolatedModule: IsolationModule;

		beforeEach(() => {
			isolatedModule = new IsolationModule({
				underlying: new MemoryTableModule(),
			});
			db.registerModule('isolated', isolatedModule);
		});

		it('clears the synthesized UNIQUE constraint after DROP UNIQUE INDEX', async () => {
			await db.exec(`CREATE TABLE iso_du (a INTEGER PRIMARY KEY, b INTEGER) USING isolated`);
			await db.exec(`CREATE UNIQUE INDEX iso_du_b ON iso_du (b)`);
			await db.exec(`INSERT INTO iso_du VALUES (1, 100)`);

			let threwBeforeDrop = false;
			try {
				await db.exec(`INSERT INTO iso_du VALUES (2, 100)`);
			} catch (e) {
				threwBeforeDrop = true;
				expect(String(e)).to.match(/unique/i);
			}
			expect(threwBeforeDrop, 'duplicate must violate UNIQUE while the index exists').to.equal(true);

			await db.exec(`DROP INDEX iso_du_b`);
			// After drop the duplicate is allowed — the synthesized UC is gone.
			await db.exec(`INSERT INTO iso_du VALUES (2, 100)`);

			const rows = await asyncIterableToArray(db.eval(`SELECT a, b FROM iso_du ORDER BY a`));
			expect(rows.map((r: any) => [r.a, r.b])).to.deep.equal([[1, 100], [2, 100]]);
		});

		it('clears the synthesized UNIQUE constraint after DROP INDEX inside an active transaction', async () => {
			// Regression: with an open overlay (a write inside BEGIN..COMMIT), the
			// overlay's MemoryTable holds a pending TransactionLayer whose
			// tableSchemaAtCreation captured the synthesized UC. A bare
			// overlay.dropIndex() forward refreshes the manager but not that frozen
			// per-layer schema, so the next overlay write still fires UNIQUE inside
			// MemoryTable.update against `_overlay_<table>_<id>`. `TransactionLayer.adoptSchema`
			// grew a removal branch, so the bare forward now reaches the open layer too.
			await db.exec(`CREATE TABLE iso_dut (a INTEGER PRIMARY KEY, b INTEGER) USING isolated`);
			await db.exec(`CREATE UNIQUE INDEX iso_dut_b ON iso_dut (b)`);

			await db.exec(`BEGIN`);
			await db.exec(`INSERT INTO iso_dut VALUES (1, 100)`);
			await db.exec(`DROP INDEX iso_dut_b`);
			// Should succeed now — the UC is gone from both the underlying schema
			// and the overlay's effective schema.
			await db.exec(`INSERT INTO iso_dut VALUES (2, 100)`);
			await db.exec(`COMMIT`);

			const rows = await asyncIterableToArray(db.eval(`SELECT a, b FROM iso_dut ORDER BY a`));
			expect(rows.map((r: any) => [r.a, r.b])).to.deep.equal([[1, 100], [2, 100]]);
		});

		it('preserves staged tombstones across DROP INDEX inside an active transaction', async () => {
			// Verifies the in-place adopt leaves tombstone rows alone, so a DELETE staged
			// before DROP INDEX still results in the row being removed at COMMIT.
			await db.exec(`CREATE TABLE iso_dtb (a INTEGER PRIMARY KEY, b INTEGER) USING isolated`);
			await db.exec(`INSERT INTO iso_dtb VALUES (1, 100), (2, 200)`);
			await db.exec(`CREATE UNIQUE INDEX iso_dtb_b ON iso_dtb (b)`);

			await db.exec(`BEGIN`);
			await db.exec(`DELETE FROM iso_dtb WHERE a = 1`);
			await db.exec(`DROP INDEX iso_dtb_b`);
			await db.exec(`COMMIT`);

			const rows = await asyncIterableToArray(db.eval(`SELECT a, b FROM iso_dtb ORDER BY a`));
			expect(rows.map((r: any) => [r.a, r.b])).to.deep.equal([[2, 200]]);
		});
	});

	describe('index DDL inside a transaction preserves the overlay savepoint chain', () => {
		// Regression (`bug-isolation-index-ddl-rebuild-drops-savepoint-writes`): CREATE/DROP
		// INDEX used to throw the overlay away and copy staged rows into a fresh MemoryTable.
		// That table's first write lazily registered its connection, and
		// `Database.registerConnection` replays begin() + the whole active savepoint stack
		// BEFORE the copy — so every copied row landed ABOVE the replayed savepoint and the
		// next `rollback to savepoint` discarded work done before the savepoint was taken.
		// The layer's index DDL now adopts in place, leaving the savepoint chain intact.
		let isolatedModule: IsolationModule;

		beforeEach(() => {
			isolatedModule = new IsolationModule({
				underlying: new MemoryTableModule(),
			});
			db.registerModule('isolated', isolatedModule);
		});

		it('DROP INDEX after a savepoint keeps rows staged before the savepoint', async () => {
			await db.exec(`CREATE TABLE iso_spa (id INTEGER PRIMARY KEY, v TEXT) USING isolated`);
			await db.exec(`CREATE UNIQUE INDEX iso_spa_v ON iso_spa (v)`);

			await db.exec(`BEGIN`);
			await db.exec(`INSERT INTO iso_spa VALUES (1, 'a')`);
			await db.exec(`SAVEPOINT s`);
			await db.exec(`DROP INDEX iso_spa_v`);
			await db.exec(`ROLLBACK TO SAVEPOINT s`);

			let rows = await asyncIterableToArray(db.eval(`SELECT id, v FROM iso_spa ORDER BY id`));
			expect(rows.map((r: any) => [r.id, r.v]), 'pre-savepoint row must survive').to.deep.equal([[1, 'a']]);

			await db.exec(`COMMIT`);
			rows = await asyncIterableToArray(db.eval(`SELECT id, v FROM iso_spa ORDER BY id`));
			expect(rows.map((r: any) => [r.id, r.v])).to.deep.equal([[1, 'a']]);
		});

		it('CREATE UNIQUE INDEX after a savepoint keeps rows staged before the savepoint', async () => {
			await db.exec(`CREATE TABLE iso_spb (id INTEGER PRIMARY KEY, v TEXT) USING isolated`);

			await db.exec(`BEGIN`);
			await db.exec(`INSERT INTO iso_spb VALUES (1, 'a')`);
			await db.exec(`SAVEPOINT s`);
			await db.exec(`CREATE UNIQUE INDEX iso_spb_v ON iso_spb (v)`);
			await db.exec(`ROLLBACK TO SAVEPOINT s`);

			let rows = await asyncIterableToArray(db.eval(`SELECT id, v FROM iso_spb ORDER BY id`));
			expect(rows.map((r: any) => [r.id, r.v]), 'pre-savepoint row must survive').to.deep.equal([[1, 'a']]);

			await db.exec(`COMMIT`);
			rows = await asyncIterableToArray(db.eval(`SELECT id, v FROM iso_spb ORDER BY id`));
			expect(rows.map((r: any) => [r.id, r.v])).to.deep.equal([[1, 'a']]);
		});

		it('rollback to savepoint keeps pre-savepoint rows and discards post-savepoint ones across a DROP INDEX', async () => {
			// Pins BOTH directions: the rebuild flattened the layer chain, so "staged before
			// the savepoint" and "staged after it" became indistinguishable.
			await db.exec(`CREATE TABLE iso_spc (id INTEGER PRIMARY KEY, v TEXT) USING isolated`);
			await db.exec(`CREATE UNIQUE INDEX iso_spc_v ON iso_spc (v)`);

			await db.exec(`BEGIN`);
			await db.exec(`INSERT INTO iso_spc VALUES (1, 'a')`);
			await db.exec(`SAVEPOINT s`);
			await db.exec(`INSERT INTO iso_spc VALUES (2, 'b')`);
			await db.exec(`DROP INDEX iso_spc_v`);
			await db.exec(`INSERT INTO iso_spc VALUES (3, 'c')`);
			await db.exec(`ROLLBACK TO SAVEPOINT s`);

			let rows = await asyncIterableToArray(db.eval(`SELECT id, v FROM iso_spc ORDER BY id`));
			expect(rows.map((r: any) => [r.id, r.v])).to.deep.equal([[1, 'a']]);

			await db.exec(`COMMIT`);
			rows = await asyncIterableToArray(db.eval(`SELECT id, v FROM iso_spc ORDER BY id`));
			expect(rows.map((r: any) => [r.id, r.v])).to.deep.equal([[1, 'a']]);
		});

		it('a staged tombstone survives DROP INDEX under a savepoint', async () => {
			// The in-place adopt must not disturb tombstone rows either: a DELETE staged
			// before the savepoint still lands at COMMIT.
			await db.exec(`CREATE TABLE iso_spd (id INTEGER PRIMARY KEY, v TEXT) USING isolated`);
			await db.exec(`INSERT INTO iso_spd VALUES (1, 'a'), (2, 'b')`);
			await db.exec(`CREATE UNIQUE INDEX iso_spd_v ON iso_spd (v)`);

			await db.exec(`BEGIN`);
			await db.exec(`DELETE FROM iso_spd WHERE id = 1`);
			await db.exec(`SAVEPOINT s`);
			await db.exec(`DROP INDEX iso_spd_v`);
			await db.exec(`ROLLBACK TO SAVEPOINT s`);
			await db.exec(`COMMIT`);

			const rows = await asyncIterableToArray(db.eval(`SELECT id, v FROM iso_spd ORDER BY id`));
			expect(rows.map((r: any) => [r.id, r.v])).to.deep.equal([[2, 'b']]);
		});
	});

	describe('index DDL adopted into an already-open overlay', () => {
		// The structural half of the in-place adopt: `createOverlayIndexSchema` must hand an
		// already-open overlay an index that is *structurally identical* to one the overlay would
		// have copied in at creation time — the predicate ANDed with `<tombstone> = 0` and its
		// self-qualifier rescoped from the base table's name onto the overlay's generated
		// `_overlay_<table>_<id>` name (a stale qualifier makes the memory module's
		// `compilePredicate` reject the index at build time). Only exercised indirectly, through
		// `createOverlaySchema`, before these.
		let isolatedModule: IsolationModule;

		beforeEach(() => {
			isolatedModule = new IsolationModule({ underlying: new MemoryTableModule() });
			db.registerModule('isolated', isolatedModule);
		});

		it('a SELF-QUALIFIED partial unique index created mid-transaction is rescoped onto the overlay', async () => {
			// `iso_pix.status` names the BASE table. Handed to the overlay unrescoped it would name
			// a table the overlay's MemoryIndex is not scoped to, and `compilePredicate` rejects a
			// foreign qualifier at index-build time — so a missing rescope fails this statement.
			await db.exec(`CREATE TABLE iso_pix (id INTEGER PRIMARY KEY, code TEXT, status TEXT) USING isolated`);

			await db.exec(`BEGIN`);
			// Two staged rows share `code`, but only one satisfies the predicate — so the index
			// must build (an un-narrowed one would reject) and see exactly that row.
			await db.exec(`INSERT INTO iso_pix VALUES (1, 'x', 'active'), (2, 'x', 'archived')`);
			await db.exec(`CREATE UNIQUE INDEX iso_pix_code ON iso_pix (code) WHERE iso_pix.status = 'active'`);
			// A further row outside the predicate is still accepted.
			await db.exec(`INSERT INTO iso_pix VALUES (3, 'x', 'archived')`);
			await db.exec(`COMMIT`);

			const rows = await asyncIterableToArray(db.eval(`SELECT id FROM iso_pix ORDER BY id`));
			expect(rows.map((r: any) => r.id)).to.deep.equal([1, 2, 3]);
		});

		it('a PARTIAL unique index created mid-transaction is enforced over the overlay\'s own staged rows', async () => {
			// The conflicting row is staged, not committed, so only the overlay's own copy of the
			// index can catch it — `IsolatedTable.findMergedUniqueConflict` scans the underlying.
			await db.exec(`CREATE TABLE iso_pix2 (id INTEGER PRIMARY KEY, code TEXT, status TEXT) USING isolated`);

			await db.exec(`BEGIN`);
			await db.exec(`INSERT INTO iso_pix2 VALUES (1, 'x', 'active')`);
			await db.exec(`CREATE UNIQUE INDEX iso_pix2_code ON iso_pix2 (code) WHERE status = 'active'`);

			let dupErr: unknown;
			try { await db.exec(`INSERT INTO iso_pix2 VALUES (2, 'x', 'active')`); } catch (e) { dupErr = e; }
			expect(dupErr, 'the adopted partial index must reject a staged duplicate').to.be.instanceOf(Error);
			expect((dupErr as Error).message.toLowerCase()).to.include('unique');

			await db.exec(`ROLLBACK`);
			const rows = await asyncIterableToArray(db.eval(`SELECT id FROM iso_pix2`));
			expect(rows.length, 'the rejected transaction staged nothing').to.equal(0);
		});

		it('DROP then CREATE an index of the same name mid-transaction lands the NEW definition', async () => {
			// `createOverlayIndex` skips an index the overlay already carries, keyed on name alone.
			// The preceding DROP must therefore really have removed it from the overlay, or this
			// re-create would silently no-op and the overlay would keep enforcing the OLD column.
			await db.exec(`CREATE TABLE iso_rix (id INTEGER PRIMARY KEY, v TEXT, w TEXT) USING isolated`);
			await db.exec(`CREATE UNIQUE INDEX iso_rix_ix ON iso_rix (v)`);

			await db.exec(`BEGIN`);
			await db.exec(`INSERT INTO iso_rix VALUES (1, 'a', 'p')`);
			await db.exec(`DROP INDEX iso_rix_ix`);
			await db.exec(`CREATE UNIQUE INDEX iso_rix_ix ON iso_rix (w)`);
			// v is no longer unique.
			await db.exec(`INSERT INTO iso_rix VALUES (2, 'a', 'q')`);
			// w now is — against a row staged in this same transaction.
			let dupErr: unknown;
			try { await db.exec(`INSERT INTO iso_rix VALUES (3, 'b', 'q')`); } catch (e) { dupErr = e; }
			expect(dupErr, 'the re-created index must enforce its NEW column').to.be.instanceOf(Error);
			expect((dupErr as Error).message.toLowerCase()).to.include('unique');

			await db.exec(`ROLLBACK`);
			const rows = await asyncIterableToArray(db.eval(`SELECT id FROM iso_rix`));
			expect(rows.length).to.equal(0);
		});
	});

	describe('column-shape ALTER inside a transaction preserves the overlay savepoint chain', () => {
		// Regression (`isolation-alter-forward-column-shape`): every ALTER TABLE used to
		// rebuild the overlay — copy staged rows into a fresh MemoryTable — with the same
		// savepoint-flattening mechanism the index-DDL suite above describes: the copy's
		// first write lazily registered a fresh connection, `Database.registerConnection`
		// replayed the active savepoint stack BEFORE the copy, and the next `rollback to
		// savepoint` discarded rows staged long before the savepoint was taken. ADD / DROP /
		// RENAME COLUMN now forward to the overlay in place, keeping its layer chain intact.
		// (DDL itself is not transactional: the rollback keeps the column change and only
		// unwinds row writes.)
		let isolatedModule: IsolationModule;

		beforeEach(() => {
			isolatedModule = new IsolationModule({ underlying: new MemoryTableModule() });
			db.registerModule('isolated', isolatedModule);
		});

		it('ADD COLUMN keeps pre-savepoint rows and discards post-savepoint ones', async () => {
			await db.exec(`CREATE TABLE asp_add (id INTEGER PRIMARY KEY, v TEXT) USING isolated`);

			await db.exec(`BEGIN`);
			await db.exec(`INSERT INTO asp_add VALUES (1, 'a')`);
			await db.exec(`SAVEPOINT s`);
			await db.exec(`INSERT INTO asp_add VALUES (2, 'b')`);
			await db.exec(`ALTER TABLE asp_add ADD COLUMN w TEXT DEFAULT 'z'`);
			await db.exec(`INSERT INTO asp_add VALUES (3, 'c', 'x')`);
			await db.exec(`ROLLBACK TO SAVEPOINT s`);

			let rows = await asyncIterableToArray(db.eval(`SELECT id, v, w FROM asp_add ORDER BY id`));
			expect(rows.map((r: any) => [r.id, r.v, r.w]), 'only the pre-savepoint row survives, backfilled').to.deep.equal([[1, 'a', 'z']]);

			await db.exec(`COMMIT`);
			rows = await asyncIterableToArray(db.eval(`SELECT id, v, w FROM asp_add ORDER BY id`));
			expect(rows.map((r: any) => [r.id, r.v, r.w])).to.deep.equal([[1, 'a', 'z']]);
		});

		it('ADD COLUMN with a per-row new.<col> DEFAULT backfills the surviving staged row', async () => {
			await db.exec(`CREATE TABLE asp_nc (id INTEGER PRIMARY KEY, v TEXT) USING isolated`);

			await db.exec(`BEGIN`);
			await db.exec(`INSERT INTO asp_nc VALUES (1, 'a')`);
			await db.exec(`SAVEPOINT s`);
			await db.exec(`INSERT INTO asp_nc VALUES (2, 'b')`);
			await db.exec(`ALTER TABLE asp_nc ADD COLUMN w TEXT DEFAULT (new.v)`);
			await db.exec(`ROLLBACK TO SAVEPOINT s`);
			await db.exec(`COMMIT`);

			const rows = await asyncIterableToArray(db.eval(`SELECT id, v, w FROM asp_nc ORDER BY id`));
			expect(rows.map((r: any) => [r.id, r.v, r.w]), "w backfilled from the staged row's own v").to.deep.equal([[1, 'a', 'a']]);
		});

		it('ADD COLUMN converts the literal DEFAULT for staged rows, before and after commit', async () => {
			// bug-add-column-default-not-coerced: the overlay writes its staged rows with
			// `preCoerced: true`, so it can never pick the declared-type conversion up
			// implicitly. Without the explicit fold+convert the staged row held the raw text
			// '7' where the committed store held the integer 7 — an overlay/store divergence.
			await db.exec(`CREATE TABLE asp_coerce (id INTEGER PRIMARY KEY, v TEXT) USING isolated`);
			await db.exec(`INSERT INTO asp_coerce VALUES (0, 'committed')`);

			await db.exec(`BEGIN`);
			await db.exec(`INSERT INTO asp_coerce VALUES (1, 'staged')`);
			await db.exec(`ALTER TABLE asp_coerce ADD COLUMN n INTEGER DEFAULT '7'`);

			// Read back through the overlay, before commit.
			let rows = await asyncIterableToArray(db.eval(`SELECT id, n, typeof(n) AS t FROM asp_coerce ORDER BY id`));
			expect(rows.map((r: any) => [r.id, r.n, r.t]), 'staged and committed rows agree on the CONVERTED value')
				.to.deep.equal([[0, 7, 'integer'], [1, 7, 'integer']]);

			await db.exec(`COMMIT`);
			rows = await asyncIterableToArray(db.eval(`SELECT id, n, typeof(n) AS t FROM asp_coerce ORDER BY id`));
			expect(rows.map((r: any) => [r.id, r.n, r.t]), 'and still agree once the overlay merged into the store')
				.to.deep.equal([[0, 7, 'integer'], [1, 7, 'integer']]);
		});

		it('SET NOT NULL converts the literal DEFAULT when backfilling a staged NULL', async () => {
			await db.exec(`CREATE TABLE asp_nn_coerce (id INTEGER PRIMARY KEY, n INTEGER NULL DEFAULT '5') USING isolated`);

			await db.exec(`BEGIN`);
			await db.exec(`INSERT INTO asp_nn_coerce VALUES (1, NULL)`);
			await db.exec(`ALTER TABLE asp_nn_coerce ALTER COLUMN n SET NOT NULL`);

			let rows = await asyncIterableToArray(db.eval(`SELECT id, n, typeof(n) AS t FROM asp_nn_coerce ORDER BY id`));
			expect(rows.map((r: any) => [r.id, r.n, r.t]), 'staged NULL filled with the CONVERTED default')
				.to.deep.equal([[1, 5, 'integer']]);

			await db.exec(`COMMIT`);
			rows = await asyncIterableToArray(db.eval(`SELECT id, n, typeof(n) AS t FROM asp_nn_coerce ORDER BY id`));
			expect(rows.map((r: any) => [r.id, r.n, r.t])).to.deep.equal([[1, 5, 'integer']]);
		});

		it('DROP COLUMN (middle) keeps pre-savepoint rows, discards post-savepoint ones, and realigns values', async () => {
			// The committed row also pins the underlying side: the forwarded BEGIN/SAVEPOINT
			// leave the underlying connection holding a LAZY savepoint marker (no own writes —
			// the staged rows live in the overlay), and that marker used to name the committed
			// layer the ALTER then drained and reshaped, so `rollback to savepoint` reinstated
			// the row in its pre-ALTER 3-wide shape.
			await db.exec(`CREATE TABLE asp_drop (id INTEGER PRIMARY KEY, v TEXT, x INTEGER) USING isolated`);
			await db.exec(`INSERT INTO asp_drop VALUES (0, 'base', 100)`);

			await db.exec(`BEGIN`);
			await db.exec(`INSERT INTO asp_drop VALUES (1, 'a', 10)`);
			await db.exec(`SAVEPOINT s`);
			await db.exec(`INSERT INTO asp_drop VALUES (2, 'b', 20)`);
			await db.exec(`ALTER TABLE asp_drop DROP COLUMN v`);
			await db.exec(`INSERT INTO asp_drop VALUES (3, 30)`);
			await db.exec(`ROLLBACK TO SAVEPOINT s`);

			let rows = await asyncIterableToArray(db.eval(`SELECT id, x FROM asp_drop ORDER BY id`));
			expect(rows.map((r: any) => [r.id, r.x]), 'staged x realigned after the middle column dropped').to.deep.equal([[0, 100], [1, 10]]);

			await db.exec(`COMMIT`);
			rows = await asyncIterableToArray(db.eval(`SELECT id, x FROM asp_drop ORDER BY id`));
			expect(rows.map((r: any) => [r.id, r.x])).to.deep.equal([[0, 100], [1, 10]]);
		});

		it('DROP COLUMN (last) keeps the pre-savepoint row', async () => {
			await db.exec(`CREATE TABLE asp_dl (id INTEGER PRIMARY KEY, v TEXT, x INTEGER) USING isolated`);

			await db.exec(`BEGIN`);
			await db.exec(`INSERT INTO asp_dl VALUES (1, 'a', 10)`);
			await db.exec(`SAVEPOINT s`);
			await db.exec(`ALTER TABLE asp_dl DROP COLUMN x`);
			await db.exec(`ROLLBACK TO SAVEPOINT s`);
			await db.exec(`COMMIT`);

			const rows = await asyncIterableToArray(db.eval(`SELECT id, v FROM asp_dl ORDER BY id`));
			expect(rows.map((r: any) => [r.id, r.v])).to.deep.equal([[1, 'a']]);
		});

		it('RENAME COLUMN keeps pre-savepoint rows and discards post-savepoint ones', async () => {
			await db.exec(`CREATE TABLE asp_rn (id INTEGER PRIMARY KEY, v TEXT) USING isolated`);

			await db.exec(`BEGIN`);
			await db.exec(`INSERT INTO asp_rn VALUES (1, 'a')`);
			await db.exec(`SAVEPOINT s`);
			await db.exec(`INSERT INTO asp_rn VALUES (2, 'b')`);
			await db.exec(`ALTER TABLE asp_rn RENAME COLUMN v TO vv`);
			await db.exec(`ROLLBACK TO SAVEPOINT s`);

			let rows = await asyncIterableToArray(db.eval(`SELECT id, vv FROM asp_rn ORDER BY id`));
			expect(rows.map((r: any) => [r.id, r.vv])).to.deep.equal([[1, 'a']]);

			await db.exec(`COMMIT`);
			rows = await asyncIterableToArray(db.eval(`SELECT id, vv FROM asp_rn ORDER BY id`));
			expect(rows.map((r: any) => [r.id, r.vv])).to.deep.equal([[1, 'a']]);
		});

		it('a staged tombstone survives an ADD COLUMN under a savepoint and applies at COMMIT', async () => {
			await db.exec(`CREATE TABLE asp_tb (id INTEGER PRIMARY KEY, v TEXT) USING isolated`);
			await db.exec(`INSERT INTO asp_tb VALUES (1, 'a'), (2, 'b')`);

			await db.exec(`BEGIN`);
			await db.exec(`DELETE FROM asp_tb WHERE id = 1`);
			await db.exec(`SAVEPOINT s`);
			await db.exec(`ALTER TABLE asp_tb ADD COLUMN w TEXT DEFAULT 'z'`);
			await db.exec(`ROLLBACK TO SAVEPOINT s`);
			await db.exec(`COMMIT`);

			// `w` is read too: the committed row's backfill has to survive the underlying
			// connection's `rollback to savepoint`, whose lazy marker pre-dates the ALTER.
			const rows = await asyncIterableToArray(db.eval(`SELECT id, v, w FROM asp_tb ORDER BY id`));
			expect(rows.map((r: any) => [r.id, r.v, r.w]), 'pre-savepoint DELETE still lands').to.deep.equal([[2, 'b', 'z']]);
		});

		// A base column named exactly like the overlay's private tombstone flag collides with
		// it. The forward would make the overlay module raise a duplicate-name ERROR — not a
		// data condition, so it rethrows — AFTER the underlying has irreversibly applied,
		// leaving the catalog a column behind the base. Both directions are rejected up front
		// instead (`assertColumnNameNotTombstone`).
		const expectTombstoneNameRejected = (err: unknown): void => {
			expect(err, 'the reserved overlay column name must be rejected').to.be.instanceOf(QuereusError);
			expect((err as QuereusError).code).to.equal(StatusCode.UNSUPPORTED);
			expect((err as QuereusError).message).to.contain('_tombstone');
		};

		it('ADD COLUMN named like the tombstone flag is rejected before the underlying mutates', async () => {
			await db.exec(`CREATE TABLE asp_res (id INTEGER PRIMARY KEY, v TEXT) USING isolated`);

			await db.exec(`BEGIN`);
			await db.exec(`INSERT INTO asp_res VALUES (1, 'a')`);
			let err: unknown;
			try { await db.exec(`ALTER TABLE asp_res ADD COLUMN _tombstone TEXT DEFAULT 'z'`); } catch (e) { err = e; }
			expectTombstoneNameRejected(err);

			// Atomic abort: base and catalog both still hold the pre-alter column set.
			const underlying = isolatedModule.getUnderlyingState('main', 'asp_res')!.underlyingTable;
			expect(underlying.tableSchema?.columns.map(c => c.name), 'underlying untouched').to.deep.equal(['id', 'v']);
			expect(db.schemaManager.getTable('main', 'asp_res')?.columns.map(c => c.name), 'catalog untouched').to.deep.equal(['id', 'v']);

			// ...and the transaction is still usable: its staged row commits under that layout.
			await db.exec(`INSERT INTO asp_res VALUES (2, 'b')`);
			await db.exec(`COMMIT`);
			const rows = await asyncIterableToArray(db.eval(`SELECT id, v FROM asp_res ORDER BY id`));
			expect(rows.map((r: any) => [r.id, r.v])).to.deep.equal([[1, 'a'], [2, 'b']]);
		});

		it('RENAME COLUMN onto the tombstone flag name is rejected, with no overlay open', async () => {
			// Unconditional: a table must not acquire the colliding name while idle either, or
			// the next BEGIN builds an overlay whose two columns share it.
			await db.exec(`CREATE TABLE asp_res2 (id INTEGER PRIMARY KEY, v TEXT) USING isolated`);
			await db.exec(`INSERT INTO asp_res2 VALUES (1, 'a')`);

			let err: unknown;
			try { await db.exec(`ALTER TABLE asp_res2 RENAME COLUMN v TO _tombstone`); } catch (e) { err = e; }
			expectTombstoneNameRejected(err);

			const underlying = isolatedModule.getUnderlyingState('main', 'asp_res2')!.underlyingTable;
			expect(underlying.tableSchema?.columns.map(c => c.name), 'underlying untouched').to.deep.equal(['id', 'v']);
			expect(db.schemaManager.getTable('main', 'asp_res2')?.columns.map(c => c.name), 'catalog untouched').to.deep.equal(['id', 'v']);
		});
	});

	describe('constraint & retype ALTER inside a transaction preserves the overlay savepoint chain', () => {
		// Second half of the same regression (`isolation-alter-forward-constraints-and-retype`):
		// ALTER COLUMN and the constraint change types used to REBUILD the overlay, flattening
		// its savepoint chain exactly as the column-shape suite above describes. They now
		// forward in place: `set data type` / `set collate` / `set default` through the
		// overlay's own `alterSchema`, `set not null` as a live-row backfill via ordinary
		// overlay writes, and `add constraint … unique` as a tombstone-narrowed unique index.
		//
		// The `set not null` / `set default` / `rename constraint` savepoint shapes are covered
		// cross-backend in 41.8-alter-savepoint-staged-rows.sqllogic too; these keep the
		// isolation-specific leg, where the staged rows live in the overlay rather than in the
		// memory module's own transaction layers.
		let isolatedModule: IsolationModule;

		beforeEach(() => {
			isolatedModule = new IsolationModule({ underlying: new MemoryTableModule() });
			db.registerModule('isolated', isolatedModule);
		});

		it('SET NOT NULL keeps pre-savepoint rows and discards post-savepoint ones', async () => {
			await db.exec(`CREATE TABLE csp_nn (id INTEGER PRIMARY KEY, v TEXT NULL) USING isolated`);

			await db.exec(`BEGIN`);
			await db.exec(`INSERT INTO csp_nn VALUES (1, 'a')`);
			await db.exec(`SAVEPOINT s`);
			await db.exec(`INSERT INTO csp_nn VALUES (2, 'b')`);
			await db.exec(`ALTER TABLE csp_nn ALTER COLUMN v SET NOT NULL`);
			await db.exec(`INSERT INTO csp_nn VALUES (3, 'c')`);
			await db.exec(`ROLLBACK TO SAVEPOINT s`);

			let rows = await asyncIterableToArray(db.eval(`SELECT id, v FROM csp_nn ORDER BY id`));
			expect(rows.map((r: any) => [r.id, r.v]), 'only the pre-savepoint row survives').to.deep.equal([[1, 'a']]);

			await db.exec(`COMMIT`);
			rows = await asyncIterableToArray(db.eval(`SELECT id, v FROM csp_nn ORDER BY id`));
			expect(rows.map((r: any) => [r.id, r.v])).to.deep.equal([[1, 'a']]);

			// The tightening (DDL, not transactional) survived the rollback.
			let err: unknown;
			try { await db.exec(`INSERT INTO csp_nn VALUES (4, NULL)`); } catch (e) { err = e; }
			expect(err, 'NOT NULL enforced after commit').to.be.instanceOf(QuereusError);
		});

		it('SET NOT NULL backfills a staged NULL and the fill survives a later savepoint rollback', async () => {
			await db.exec(`CREATE TABLE csp_bf (id INTEGER PRIMARY KEY, v TEXT NULL DEFAULT 'filled') USING isolated`);

			await db.exec(`BEGIN`);
			await db.exec(`INSERT INTO csp_bf VALUES (1, NULL)`);
			await db.exec(`ALTER TABLE csp_bf ALTER COLUMN v SET NOT NULL`);
			// The backfill wrote in the frame BELOW this savepoint, so the rollback keeps it.
			await db.exec(`SAVEPOINT s`);
			await db.exec(`INSERT INTO csp_bf VALUES (2, 'b')`);
			await db.exec(`ROLLBACK TO SAVEPOINT s`);
			await db.exec(`COMMIT`);

			const rows = await asyncIterableToArray(db.eval(`SELECT id, v FROM csp_bf ORDER BY id`));
			expect(rows.map((r: any) => [r.id, r.v]), 'staged NULL backfilled; post-savepoint row discarded').to.deep.equal([[1, 'filled']]);
		});

		it('SET DATA TYPE keeps the pre-savepoint row CONVERTED and discards post-savepoint ones', async () => {
			await db.exec(`CREATE TABLE csp_dt (id INTEGER PRIMARY KEY, v TEXT) USING isolated`);

			await db.exec(`BEGIN`);
			await db.exec(`INSERT INTO csp_dt VALUES (1, '10')`);
			await db.exec(`SAVEPOINT s`);
			await db.exec(`INSERT INTO csp_dt VALUES (2, '20')`);
			await db.exec(`ALTER TABLE csp_dt ALTER COLUMN v SET DATA TYPE INTEGER`);
			await db.exec(`INSERT INTO csp_dt VALUES (3, 30)`);
			await db.exec(`ROLLBACK TO SAVEPOINT s`);

			let rows = await asyncIterableToArray(db.eval(`SELECT id, v FROM csp_dt ORDER BY id`));
			expect(rows.map((r: any) => [r.id, r.v]), 'survivor converted (integer 10, not text)').to.deep.equal([[1, 10]]);

			await db.exec(`COMMIT`);
			rows = await asyncIterableToArray(db.eval(`SELECT id, v FROM csp_dt ORDER BY id`));
			expect(rows.map((r: any) => [r.id, r.v])).to.deep.equal([[1, 10]]);
		});

		it('SET DEFAULT keeps the savepoint ledger and applies the new DEFAULT after the rollback', async () => {
			await db.exec(`CREATE TABLE csp_df (id INTEGER PRIMARY KEY, v INTEGER NULL) USING isolated`);

			await db.exec(`BEGIN`);
			await db.exec(`INSERT INTO csp_df VALUES (1, 5)`);
			await db.exec(`SAVEPOINT s`);
			await db.exec(`INSERT INTO csp_df VALUES (2, 6)`);
			await db.exec(`ALTER TABLE csp_df ALTER COLUMN v SET DEFAULT 99`);
			await db.exec(`ROLLBACK TO SAVEPOINT s`);
			await db.exec(`INSERT INTO csp_df (id) VALUES (3)`);
			await db.exec(`COMMIT`);

			const rows = await asyncIterableToArray(db.eval(`SELECT id, v FROM csp_df ORDER BY id`));
			expect(rows.map((r: any) => [r.id, r.v]), 'pre-savepoint row kept; new DEFAULT effective').to.deep.equal([[1, 5], [3, 99]]);
		});

		it('ADD CONSTRAINT UNIQUE keeps pre-savepoint rows, discards post-savepoint ones, and enforces after', async () => {
			await db.exec(`CREATE TABLE csp_uc (id INTEGER PRIMARY KEY, v TEXT) USING isolated`);

			await db.exec(`BEGIN`);
			await db.exec(`INSERT INTO csp_uc VALUES (1, 'a')`);
			await db.exec(`SAVEPOINT s`);
			await db.exec(`INSERT INTO csp_uc VALUES (2, 'b')`);
			await db.exec(`ALTER TABLE csp_uc ADD CONSTRAINT u_v UNIQUE (v)`);
			await db.exec(`INSERT INTO csp_uc VALUES (3, 'c')`);
			await db.exec(`ROLLBACK TO SAVEPOINT s`);

			let rows = await asyncIterableToArray(db.eval(`SELECT id, v FROM csp_uc ORDER BY id`));
			expect(rows.map((r: any) => [r.id, r.v]), 'only the pre-savepoint row survives').to.deep.equal([[1, 'a']]);

			await db.exec(`COMMIT`);
			rows = await asyncIterableToArray(db.eval(`SELECT id, v FROM csp_uc ORDER BY id`));
			expect(rows.map((r: any) => [r.id, r.v])).to.deep.equal([[1, 'a']]);

			let err: unknown;
			try { await db.exec(`INSERT INTO csp_uc VALUES (4, 'a')`); } catch (e) { err = e; }
			expect(err, 'the constraint (DDL) survived the rollback and enforces').to.be.instanceOf(QuereusError);
			expect((err as QuereusError).code).to.equal(StatusCode.CONSTRAINT);
		});

		it('DROP CONSTRAINT keeps the pre-savepoint row and stays dropped past the rollback', async () => {
			await db.exec(`CREATE TABLE csp_dc (id INTEGER PRIMARY KEY, v TEXT, CONSTRAINT u_v UNIQUE (v)) USING isolated`);
			await db.exec(`INSERT INTO csp_dc VALUES (0, 'dup')`);

			await db.exec(`BEGIN`);
			await db.exec(`INSERT INTO csp_dc VALUES (1, 'a')`);
			await db.exec(`SAVEPOINT s`);
			await db.exec(`ALTER TABLE csp_dc DROP CONSTRAINT u_v`);
			await db.exec(`INSERT INTO csp_dc VALUES (2, 'dup')`); // legal once dropped
			await db.exec(`ROLLBACK TO SAVEPOINT s`);
			await db.exec(`COMMIT`);

			let rows = await asyncIterableToArray(db.eval(`SELECT id, v FROM csp_dc ORDER BY id`));
			expect(rows.map((r: any) => [r.id, r.v]), 'post-savepoint duplicate unwound; staged row kept').to.deep.equal([[0, 'dup'], [1, 'a']]);

			await db.exec(`INSERT INTO csp_dc VALUES (3, 'dup')`); // the drop survived the rollback
			rows = await asyncIterableToArray(db.eval(`SELECT count(*) AS c FROM csp_dc WHERE v = 'dup'`));
			expect((rows[0] as any).c).to.equal(2);
		});

		it('RENAME CONSTRAINT keeps the savepoint ledger and enforces under the new name', async () => {
			await db.exec(`CREATE TABLE csp_rc (id INTEGER PRIMARY KEY, v TEXT, CONSTRAINT u_old UNIQUE (v)) USING isolated`);

			await db.exec(`BEGIN`);
			await db.exec(`INSERT INTO csp_rc VALUES (1, 'a')`);
			await db.exec(`SAVEPOINT s`);
			await db.exec(`INSERT INTO csp_rc VALUES (2, 'b')`);
			await db.exec(`ALTER TABLE csp_rc RENAME CONSTRAINT u_old TO u_new`);
			await db.exec(`ROLLBACK TO SAVEPOINT s`);
			await db.exec(`COMMIT`);

			const rows = await asyncIterableToArray(db.eval(`SELECT id, v FROM csp_rc ORDER BY id`));
			expect(rows.map((r: any) => [r.id, r.v]), 'pre-savepoint row survives the rename').to.deep.equal([[1, 'a']]);

			const names = (await asyncIterableToArray(db.eval(`SELECT name FROM unique_constraint_info('csp_rc')`))).map((r: any) => String(r.name));
			expect(names, 'renamed in the catalog').to.include('u_new');

			let err: unknown;
			try { await db.exec(`INSERT INTO csp_rc VALUES (3, 'a')`); } catch (e) { err = e; }
			expect(err, 'still enforced under the new name').to.be.instanceOf(QuereusError);
			expect((err as QuereusError).code).to.equal(StatusCode.CONSTRAINT);
		});

		it('DROP NOT NULL takes effect for the rest of the transaction even though it never reaches the overlay', async () => {
			// The relaxing direction is withheld from the overlay along with the tightening one,
			// so the overlay's column keeps its stale NOT NULL flag. That is only safe while
			// nothing on the overlay path reads the flag — pin it by staging a NULL right after.
			await db.exec(`CREATE TABLE csp_dn (id INTEGER PRIMARY KEY, v TEXT NOT NULL) USING isolated`);

			await db.exec(`BEGIN`);
			await db.exec(`INSERT INTO csp_dn VALUES (1, 'a')`);
			await db.exec(`ALTER TABLE csp_dn ALTER COLUMN v DROP NOT NULL`);
			await db.exec(`INSERT INTO csp_dn VALUES (2, NULL)`);

			let rows = await asyncIterableToArray(db.eval(`SELECT id, v FROM csp_dn ORDER BY id`));
			expect(rows.map((r: any) => [r.id, r.v]), 'the staged NULL is visible in-transaction').to.deep.equal([[1, 'a'], [2, null]]);

			await db.exec(`COMMIT`);
			rows = await asyncIterableToArray(db.eval(`SELECT id, v FROM csp_dn ORDER BY id`));
			expect(rows.map((r: any) => [r.id, r.v]), 'and survives the flush').to.deep.equal([[1, 'a'], [2, null]]);
		});

		it('SET COLLATE forwards to the overlay and keeps the savepoint ledger', async () => {
			// The only route by which `set collate` reaches an open overlay is
			// `MemoryTable.alterSchema` → `manager.alterColumn`, which used to drop the
			// `setCollation` attribute on the way through. With every attribute dropped the
			// manager raises INTERNAL ('ALTER COLUMN requires an attribute to change'), so this
			// ALTER fails outright for any connection holding an overlay. Non-PK column: a
			// collation change on a PRIMARY KEY member inside a transaction is a separate,
			// still-open carve-out (`alter-collate-pk-in-transaction`).
			await db.exec(`CREATE TABLE csp_cl (id INTEGER PRIMARY KEY, v TEXT) USING isolated`);

			await db.exec(`BEGIN`);
			await db.exec(`INSERT INTO csp_cl VALUES (1, 'A')`);
			await db.exec(`SAVEPOINT s`);
			await db.exec(`INSERT INTO csp_cl VALUES (2, 'b')`);
			await db.exec(`ALTER TABLE csp_cl ALTER COLUMN v SET COLLATE NOCASE`);
			await db.exec(`ROLLBACK TO SAVEPOINT s`);
			await db.exec(`COMMIT`);

			const rows = await asyncIterableToArray(db.eval(`SELECT id, v FROM csp_cl ORDER BY id`));
			expect(rows.map((r: any) => [r.id, r.v]), 'only the pre-savepoint row survives').to.deep.equal([[1, 'A']]);

			const matched = await asyncIterableToArray(db.eval(`SELECT id FROM csp_cl WHERE v = 'a'`));
			expect(matched.map((r: any) => r.id), 'NOCASE is in effect after the ALTER').to.deep.equal([1]);
		});

		it('ADD CONSTRAINT CHECK forwards to the overlay, enforces in-transaction, and DROPs by name', async () => {
			// CHECK is the one constraint class forwarded verbatim (schema-only). Enforcement is
			// engine-side, so the assertion that matters here is that the forward neither
			// disturbs the staged rows nor leaves the overlay unable to resolve the constraint
			// by name when a later DROP arrives.
			await db.exec(`CREATE TABLE csp_ck (id INTEGER PRIMARY KEY, v TEXT) USING isolated`);

			await db.exec(`BEGIN`);
			await db.exec(`INSERT INTO csp_ck VALUES (1, 'ok')`);
			await db.exec(`SAVEPOINT s`);
			await db.exec(`INSERT INTO csp_ck VALUES (2, 'also-ok')`);
			await db.exec(`ALTER TABLE csp_ck ADD CONSTRAINT c_v CHECK (v <> 'bad')`);

			let err: unknown;
			try { await db.exec(`INSERT INTO csp_ck VALUES (3, 'bad')`); } catch (e) { err = e; }
			expect(err, 'the new CHECK enforces for the rest of the transaction').to.be.instanceOf(QuereusError);

			await db.exec(`ROLLBACK TO SAVEPOINT s`);
			await db.exec(`COMMIT`);

			let rows = await asyncIterableToArray(db.eval(`SELECT id, v FROM csp_ck ORDER BY id`));
			expect(rows.map((r: any) => [r.id, r.v]), 'only the pre-savepoint row survives').to.deep.equal([[1, 'ok']]);

			// The DROP resolves against the overlay's own copy of the constraint (a name the
			// overlay never carried would silently no-op instead — see the presence guard).
			await db.exec(`BEGIN`);
			await db.exec(`INSERT INTO csp_ck VALUES (4, 'ok4')`);
			await db.exec(`ALTER TABLE csp_ck DROP CONSTRAINT c_v`);
			await db.exec(`INSERT INTO csp_ck VALUES (5, 'bad')`);
			await db.exec(`COMMIT`);

			rows = await asyncIterableToArray(db.eval(`SELECT id, v FROM csp_ck ORDER BY id`));
			expect(rows.map((r: any) => [r.id, r.v]), 'the drop took effect; staged rows kept').to.deep.equal([[1, 'ok'], [4, 'ok4'], [5, 'bad']]);
		});

		it('ADD CONSTRAINT UNIQUE over a primary-key member ignores in-transaction deletion markers', async () => {
			// The spike's failing shape: two staged deletions share a = 1, and a naive UNIQUE
			// forward to the overlay saw the two tombstones as duplicates of each other
			// (`UNIQUE constraint failed: _overlay_…`). The tombstone-narrowed index must not.
			await db.exec(`CREATE TABLE csp_tb (a INTEGER, b INTEGER, PRIMARY KEY (a, b)) USING isolated`);
			await db.exec(`INSERT INTO csp_tb VALUES (1, 1), (1, 2), (2, 1)`);

			await db.exec(`BEGIN`);
			await db.exec(`DELETE FROM csp_tb WHERE a = 1`);
			await db.exec(`ALTER TABLE csp_tb ADD CONSTRAINT u_a UNIQUE (a)`);
			await db.exec(`COMMIT`);

			const rows = await asyncIterableToArray(db.eval(`SELECT a, b FROM csp_tb ORDER BY a, b`));
			expect(rows.map((r: any) => [r.a, r.b]), 'deletes applied; ALTER accepted').to.deep.equal([[2, 1]]);

			await db.exec(`INSERT INTO csp_tb VALUES (3, 1)`);
			let err: unknown;
			try { await db.exec(`INSERT INTO csp_tb VALUES (3, 2)`); } catch (e) { err = e; }
			expect(err, 'the new UNIQUE(a) enforces on live rows').to.be.instanceOf(QuereusError);
			expect((err as QuereusError).code).to.equal(StatusCode.CONSTRAINT);
		});
	});

	describe('SET COLLATE on a PRIMARY KEY column judges the transaction\'s effective rows', () => {
		// `alter column … set collate` on a PK member asks two questions (see
		// MemoryTableManager.validateRekeyedPrimaryKey): are the rows this transaction can SEE
		// collision-free under the new comparator (CONSTRAINT if not), and can the underlying's
		// committed trees — which must survive a rollback — physically carry the re-key (BUSY
		// if not). Under this wrapper the two sets genuinely differ: staged rows live only in
		// the overlay, rows the transaction deleted only in the underlying. Pre-fix the
		// underlying judged its own committed rows for both questions, so a deleted-only
		// collision produced a false CONSTRAINT ("your data is invalid") and two staged
		// colliders slipped past validation and surfaced as INTERNAL after the shared table
		// had already been re-keyed.
		let iso: IsolationModule;

		beforeEach(() => {
			iso = new IsolationModule({ underlying: new MemoryTableModule() });
			db.registerModule('isolated', iso);
		});

		/** Live collation of `main.<table>`'s column on the shared underlying. */
		function underlyingCollation(table: string, column: string): string {
			return liveCollation(iso.getUnderlyingState('main', table)!.underlyingTable, column);
		}

		async function expectAlterError(sql: string): Promise<QuereusError> {
			let err: unknown;
			try { await db.exec(sql); } catch (e) { err = e; }
			expect(err, `${sql} must throw`).to.be.instanceOf(QuereusError);
			// Class invariant for every refusal in this block, whichever layer raises it: the
			// message names the table the user wrote, never the internal `_overlay_<table>_<id>`
			// staging table (bug-overlay-table-name-leaks-into-rekey-error).
			expect((err as QuereusError).message, `${sql} must not leak the internal overlay staging table name`)
				.to.not.match(/_overlay_/);
			return err as QuereusError;
		}

		it('raises BUSY (not CONSTRAINT) when the only colliding rows are ones this transaction deleted', async () => {
			await db.exec(`CREATE TABLE ecp_del (k TEXT PRIMARY KEY, v TEXT) USING isolated`);
			await db.exec(`INSERT INTO ecp_del VALUES ('A', 'x'), ('a', 'y'), ('b', 'z')`);

			await db.exec(`BEGIN`);
			await db.exec(`DELETE FROM ecp_del WHERE k IN ('A', 'a')`);

			const err = await expectAlterError(`ALTER TABLE ecp_del ALTER COLUMN k SET COLLATE NOCASE`);
			expect(err.code, 'the data the transaction sees is valid — the refusal is retryable').to.equal(StatusCode.BUSY);
			expect(err.message).to.match(/commit\/rollback and retry/i);
			expect(underlyingCollation('ecp_del', 'k'), 'underlying untouched').to.equal('BINARY');

			await db.exec(`ROLLBACK`);
			const rows = await asyncIterableToArray(db.eval(`SELECT k FROM ecp_del ORDER BY k`));
			expect(rows.map((r: any) => r.k), 'rollback restores the colliding pair').to.deep.equal(['A', 'a', 'b']);
		});

		it('raises the same BUSY when only one of the two colliders is deleted', async () => {
			await db.exec(`CREATE TABLE ecp_one (k TEXT PRIMARY KEY, v TEXT) USING isolated`);
			await db.exec(`INSERT INTO ecp_one VALUES ('A', 'x'), ('a', 'y')`);

			await db.exec(`BEGIN`);
			await db.exec(`DELETE FROM ecp_one WHERE k = 'a'`);

			const err = await expectAlterError(`ALTER TABLE ecp_one ALTER COLUMN k SET COLLATE NOCASE`);
			expect(err.code).to.equal(StatusCode.BUSY);
			expect(err.message).to.match(/commit\/rollback and retry/i);
			expect(underlyingCollation('ecp_one', 'k'), 'underlying untouched').to.equal('BINARY');
			await db.exec(`ROLLBACK`);
		});

		it('refuses two staged live colliders with CONSTRAINT, naming the key, before anything is mutated', async () => {
			// Pre-fix shape: both rows staged in the overlay, the underlying's committed base
			// empty, so the PK pre-pass saw no collision — the ALTER "succeeded", re-keyed the
			// shared table, and the overlay migration then raised INTERNAL.
			await db.exec(`CREATE TABLE ecp_stg (k TEXT PRIMARY KEY, v TEXT) USING isolated`);

			await db.exec(`BEGIN`);
			await db.exec(`INSERT INTO ecp_stg VALUES ('A', 'x'), ('a', 'y')`);

			const err = await expectAlterError(`ALTER TABLE ecp_stg ALTER COLUMN k SET COLLATE NOCASE`);
			expect(err.code, 'two visible rows collide — the change is illegal').to.equal(StatusCode.CONSTRAINT);
			expect(err.message).to.match(/UNIQUE constraint failed/i);
			expect(err.message, 'names the colliding key').to.match(/key: '[Aa]'/);
			expect(underlyingCollation('ecp_stg', 'k'), 'refused before the shared table was re-keyed').to.equal('BINARY');

			// The transaction survives the rejection; both rows are distinct under BINARY.
			await db.exec(`COMMIT`);
			const rows = await asyncIterableToArray(db.eval(`SELECT k FROM ecp_stg ORDER BY k`));
			expect(rows.map((r: any) => r.k)).to.deep.equal(['A', 'a']);
		});

		it('still refuses committed colliders visible to the transaction with CONSTRAINT', async () => {
			// Passes pre-fix too — pinned so the two-pass rewrite cannot regress it. The staged
			// unrelated insert keeps the overlay active, forcing the wrapper to hand the
			// underlying its merged effective stream rather than no stream at all.
			await db.exec(`CREATE TABLE ecp_cmt (k TEXT PRIMARY KEY, v TEXT) USING isolated`);
			await db.exec(`INSERT INTO ecp_cmt VALUES ('A', 'x'), ('a', 'y')`);

			await db.exec(`BEGIN`);
			await db.exec(`INSERT INTO ecp_cmt VALUES ('c', 'z')`);

			const err = await expectAlterError(`ALTER TABLE ecp_cmt ALTER COLUMN k SET COLLATE NOCASE`);
			expect(err.code).to.equal(StatusCode.CONSTRAINT);
			expect(err.message).to.match(/UNIQUE constraint failed/i);
			expect(underlyingCollation('ecp_cmt', 'k'), 'underlying untouched').to.equal('BINARY');
			await db.exec(`ROLLBACK`);
		});

		it('names the user\'s table, not the internal overlay staging table, when the collision is confined to rows this transaction both inserted and deleted', async () => {
			// Unlike 'raises BUSY when the only colliding rows are ones this transaction
			// deleted' above (a committed pair, hidden from the transaction's own view but
			// physically present on the shared underlying), this pair never reaches the
			// underlying at all: both the insert and the delete are staged in THIS
			// connection's overlay. The BUSY refusal is then raised by the overlay's own
			// pre-flight `alterSchema(change, true)` dry run — regression coverage for
			// bug-overlay-table-name-leaks-into-rekey-error.
			await db.exec(`CREATE TABLE ecp_own (k TEXT PRIMARY KEY, v TEXT) USING isolated`);

			await db.exec(`BEGIN`);
			await db.exec(`INSERT INTO ecp_own VALUES ('A', 'x'), ('a', 'y')`);
			await db.exec(`DELETE FROM ecp_own WHERE k IN ('A', 'a')`);

			const err = await expectAlterError(`ALTER TABLE ecp_own ALTER COLUMN k SET COLLATE NOCASE`);
			expect(err.code).to.equal(StatusCode.BUSY);
			expect(err.message).to.match(/commit\/rollback and retry/i);
			// The no-`_overlay_` half of this assertion lives in expectAlterError, which applies it
			// to every refusal in this block; here we also pin the positive form.
			expect(err.message, 'names the real table').to.contain('table ecp_own:');

			await db.exec(`ROLLBACK`);
		});
	});

	describe('SET COLLATE on a PRIMARY KEY column collapses overlay deletion markers', () => {
		// A transaction that deletes a row and re-inserts a case-variant replacement stages a
		// deletion marker AND a live row that become ONE key under the new collation. The marker
		// is that row's before-image, not a second row: the migrate step discards it before the
		// re-key is forwarded (IsolationModule.dropCollapsedPkRekeyMarkers), so the ALTER
		// succeeds. Pre-fix the forward raised the issuer drift INTERNAL after the shared table
		// had already re-keyed, and a COMMIT afterwards silently lost the replacement row (the
		// flush deleted what it had just inserted). Two live rows on one key stay a real
		// duplicate — covered by the previous suite for the issuer, and by the foreign-overlay
		// poison test below.
		let iso: IsolationModule;

		beforeEach(() => {
			iso = new IsolationModule({ underlying: new MemoryTableModule() });
			db.registerModule('isolated', iso);
		});

		function overlayRows(table: string): Promise<Row[]> {
			const state = iso.getConnectionOverlay(db, 'main', table)!;
			return asyncIterableToArray(state.overlayTable.query!(makeFullScanFilterInfo()));
		}

		/** Live collation of `main.<table>`'s column on the shared underlying. */
		function underlyingCollation(table: string, column: string): string {
			return liveCollation(iso.getUnderlyingState('main', table)!.underlyingTable, column);
		}

		it('delete then re-insert at a case-colliding key survives the ALTER and the COMMIT', async () => {
			await db.exec(`CREATE TABLE mkc (k TEXT PRIMARY KEY, v TEXT) USING isolated`);
			await db.exec(`INSERT INTO mkc VALUES ('A', 'x')`);

			await db.exec(`BEGIN`);
			await db.exec(`DELETE FROM mkc WHERE k = 'A'`);
			await db.exec(`INSERT INTO mkc VALUES ('a', 'y')`);
			await db.exec(`ALTER TABLE mkc ALTER COLUMN k SET COLLATE NOCASE`);

			// The marker collapsed onto its replacement: the overlay holds exactly the live row.
			const staged = await overlayRows('mkc');
			expect(staged.map(r => [r[0], r[1], r[2]])).to.deep.equal([['a', 'y', 0]]);

			const inTxn = await asyncIterableToArray(db.eval(`SELECT k, v FROM mkc`));
			expect(inTxn.map((r: any) => [r.k, r.v])).to.deep.equal([['a', 'y']]);

			await db.exec(`COMMIT`);
			// Pre-fix shape of the loss: continuing past the INTERNAL and committing reported
			// success and left the table EMPTY.
			const rows = await asyncIterableToArray(db.eval(`SELECT k, v FROM mkc`));
			expect(rows.map((r: any) => [r.k, r.v]), 'the replacement row survives the commit').to.deep.equal([['a', 'y']]);
		});

		it('rollback to a savepoint taken between the delete and the insert restores the deletion marker', async () => {
			await db.exec(`CREATE TABLE mks (k TEXT PRIMARY KEY, v TEXT) USING isolated`);
			await db.exec(`INSERT INTO mks VALUES ('A', 'x')`);

			await db.exec(`BEGIN`);
			await db.exec(`DELETE FROM mks WHERE k = 'A'`);
			await db.exec(`SAVEPOINT s`);
			await db.exec(`INSERT INTO mks VALUES ('a', 'y')`);
			await db.exec(`ALTER TABLE mks ALTER COLUMN k SET COLLATE NOCASE`);
			await db.exec(`ROLLBACK TO SAVEPOINT s`);

			// The in-place migration kept the overlay's savepoint chain: unwinding past the
			// insert (and the marker drop that rode in the same frame) restores the marker.
			const staged = await overlayRows('mks');
			expect(staged.map(r => [r[0], r[2]]), 'the deletion marker is back').to.deep.equal([['A', 1]]);
			const inTxn = await asyncIterableToArray(db.eval(`SELECT k FROM mks`));
			expect(inTxn, "the table reads as 'A' deleted").to.deep.equal([]);

			await db.exec(`COMMIT`);
			const rows = await asyncIterableToArray(db.eval(`SELECT k FROM mks`));
			expect(rows).to.deep.equal([]);
		});

		it('a savepoint taken after the staged pair refuses the ALTER atomically with BUSY', async () => {
			// `ROLLBACK TO s` must restore BOTH the marker and its case-variant replacement —
			// two rows the re-keyed overlay cannot hold at one key. The overlay module's own
			// representability check (the same conservative BUSY the plain memory table raises
			// for restorable colliding rows) refuses the re-key; what this test pins is the
			// TIMING: the tier-2 pre-flight surfaces that refusal BEFORE the shared underlying
			// mutates, the marker drop is undone, and the transaction continues intact.
			await db.exec(`CREATE TABLE mkp (k TEXT PRIMARY KEY, v TEXT) USING isolated`);
			await db.exec(`INSERT INTO mkp VALUES ('A', 'x')`);

			await db.exec(`BEGIN`);
			await db.exec(`DELETE FROM mkp WHERE k = 'A'`);
			await db.exec(`INSERT INTO mkp VALUES ('a', 'y')`);
			await db.exec(`SAVEPOINT s`);

			let err: unknown;
			try { await db.exec(`ALTER TABLE mkp ALTER COLUMN k SET COLLATE NOCASE`); } catch (e) { err = e; }
			expect(err, 'the re-key must be refused').to.be.instanceOf(QuereusError);
			expect((err as QuereusError).code, 'refused as retryable, not as data-invalid').to.equal(StatusCode.BUSY);
			expect(underlyingCollation('mkp', 'k'), 'refused BEFORE the shared table was re-keyed').to.equal('BINARY');

			// The dropped marker was restored: the overlay still stages the delete + replacement.
			const staged = await overlayRows('mkp');
			expect(staged.map(r => [r[0], r[2]]).sort(), 'marker and replacement both intact').to.deep.equal([['A', 1], ['a', 0]]);

			// The transaction survives the refusal and commits its actual work.
			await db.exec(`COMMIT`);
			const rows = await asyncIterableToArray(db.eval(`SELECT k, v FROM mkp`));
			expect(rows.map((r: any) => [r.k, r.v])).to.deep.equal([['a', 'y']]);
		});

		it('two case-variant in-transaction deletions refuse the ALTER atomically with BUSY, matching plain memory', async () => {
			// Statement boundaries leave the overlay's pre-delete live pair {'A','a'} in an
			// immutable history layer, and the overlay module's representability check refuses
			// any chain that ever held a colliding pair — exactly as the PLAIN memory table
			// refuses this same statement sequence (its own history holds the same pair). What
			// this test pins: the refusal is surfaced by the tier-2 pre-flight BEFORE the shared
			// underlying re-keys, the transaction survives, and its deletes still commit.
			await db.exec(`CREATE TABLE mkd (k TEXT PRIMARY KEY, v TEXT) USING isolated`);

			await db.exec(`BEGIN`);
			await db.exec(`INSERT INTO mkd VALUES ('A', 'x'), ('a', 'y')`);
			await db.exec(`DELETE FROM mkd WHERE k IN ('A', 'a')`);

			let err: unknown;
			try { await db.exec(`ALTER TABLE mkd ALTER COLUMN k SET COLLATE NOCASE`); } catch (e) { err = e; }
			expect(err, 'the re-key must be refused').to.be.instanceOf(QuereusError);
			expect((err as QuereusError).code).to.equal(StatusCode.BUSY);
			expect((err as QuereusError).message).to.match(/commit\/rollback and retry/i);
			expect(underlyingCollation('mkd', 'k'), 'refused BEFORE the shared table was re-keyed').to.equal('BINARY');

			// Both markers are back, VERBATIM. This shape also exercises the marker/marker
			// collapse (one of the two is dropped for the pre-flight), and because these markers
			// were minted by deleting rows this transaction had already staged they carry the
			// deleted rows' values — a marker rebuilt from its primary key alone restores NULLs.
			const staged = (await overlayRows('mkd')).map(r => [r[0], r[1], r[2]]);
			expect(staged.sort(), 'both deletion markers restored unchanged')
				.to.deep.equal([['A', 'x', 1], ['a', 'y', 1]]);

			await db.exec(`COMMIT`);
			const rows = await asyncIterableToArray(db.eval(`SELECT k FROM mkd`));
			expect(rows, 'the transaction still deleted everything it inserted').to.deep.equal([]);

			// And with the transaction committed, the retry the BUSY suggested succeeds.
			await db.exec(`ALTER TABLE mkd ALTER COLUMN k SET COLLATE NOCASE`);
			expect(underlyingCollation('mkd', 'k')).to.equal('NOCASE');
		});

		describe('foreign overlays under a cross-connection PK re-key', () => {
			// White-box, following the poison-semantics suite: two Databases share one
			// IsolationModule, overlays are injected directly, and the ALTER is driven through
			// iso.alterTable(dbA, …). Here injected rows carry an explicit tombstone flag so a
			// staged deletion marker can be planted.
			let isoShared: IsolationModule;
			let dbA: Database; // the ALTER issuer
			let dbB: Database; // the foreign connection

			const setCollateNocase: SchemaChangeInfo = { type: 'alterColumn', columnName: 'k', setCollation: 'NOCASE' };

			beforeEach(async () => {
				isoShared = new IsolationModule({ underlying: new MemoryTableModule() });
				dbA = new Database();
				dbB = new Database();
				dbA.registerModule('isolated', isoShared);
				await dbA.exec(`create table ct (k text primary key, v text) using isolated`);
				await dbA.exec(`insert into ct values ('A', 'x')`); // committed row for the marker below
			});

			afterEach(async () => {
				await dbA.close();
				await dbB.close();
			});

			/** Injects a staged overlay for `forDb`; rows are FULL overlay rows `[k, v, tombstoneFlag]`. */
			async function injectOverlayRows(forDb: Database, rows: SqlValue[][]): Promise<void> {
				const underlying = isoShared.getUnderlyingState('main', 'ct')!.underlyingTable;
				const overlay = await isoShared.overlayModule.create(forDb, isoShared.createOverlaySchema(underlying.tableSchema!));
				for (const r of rows) {
					await overlay.update({ operation: 'insert', values: r });
				}
				isoShared.setConnectionOverlay(forDb, 'main', 'ct', { overlayTable: overlay, hasChanges: true, db: forDb });
			}

			/**
			 * Same as {@link injectOverlayRows}, but the rows are staged inside a REAL open
			 * transaction on the staging table and then frozen behind a savepoint.
			 *
			 * That distinction is the whole point: `injectOverlayRows`'s writes autocommit into
			 * the staging table's base layer, so its history is one layer deep and the staging
			 * module can always re-sort it. Here `begin()` opens an explicit transaction (which
			 * also registers the staging table's connection with `forDb`, so its own DDL pass can
			 * find it) and `savepoint(0)` turns the pending layer into an immutable snapshot a
			 * later `rollback to` could restore — the shape whose re-key the staging module
			 * refuses as retryable rather than as invalid data.
			 */
			async function injectOverlayRowsBehindSavepoint(forDb: Database, rows: SqlValue[][]): Promise<void> {
				const underlying = isoShared.getUnderlyingState('main', 'ct')!.underlyingTable;
				const overlay = await isoShared.overlayModule.create(forDb, isoShared.createOverlaySchema(underlying.tableSchema!));
				await overlay.begin!();
				for (const r of rows) {
					await overlay.update({ operation: 'insert', values: r });
				}
				await overlay.savepoint!(0);
				isoShared.setConnectionOverlay(forDb, 'main', 'ct', { overlayTable: overlay, hasChanges: true, db: forDb });
			}

			it('poisons a foreign overlay whose two staged live rows collide under the new collation', async () => {
				await injectOverlayRows(dbB, [['b', 'y', 0], ['B', 'z', 0]]);

				const updated = await isoShared.alterTable(dbA, 'main', 'ct', setCollateNocase);
				expect(updated.columns.find(c => c.name === 'k')!.collation, 'the ALTER applied for the issuer').to.equal('NOCASE');

				const bState = isoShared.getConnectionOverlay(dbB, 'main', 'ct')!;
				expect(bState.poison, 'a real staged duplicate must poison, not migrate').to.not.be.undefined;
				expect(bState.poison!.message).to.match(/collation/i);
				expect(bState.poison!.message).to.match(/roll back this transaction/i);

				// The rejection fired in the pre-validation pass: both staged rows are intact.
				const bRows = await asyncIterableToArray(bState.overlayTable.query!(makeFullScanFilterInfo()));
				expect(bRows.map(r => r[0]).sort(), 'no staged row was dropped').to.deep.equal(['B', 'b']);

				let commitErr: unknown;
				try { await isoShared.commitConnectionOverlays(dbB); } catch (e) { commitErr = e; }
				expect(commitErr, 'poisoned overlay must abort the commit').to.be.instanceOf(QuereusError);
				expect((commitErr as QuereusError).code).to.equal(StatusCode.CONSTRAINT);
			});

			it('migrates a foreign overlay whose marker/live pair collapses cleanly, in place', async () => {
				await injectOverlayRows(dbB, [['A', null, 1], ['a', 'y', 0]]);
				const before = isoShared.getConnectionOverlay(dbB, 'main', 'ct')!.overlayTable;

				await isoShared.alterTable(dbA, 'main', 'ct', setCollateNocase);

				const bState = isoShared.getConnectionOverlay(dbB, 'main', 'ct')!;
				expect(bState.poison, 'a collapsible pair must adopt the change, not poison').to.be.undefined;
				expect(bState.overlayTable, 'adopted IN PLACE — same staging table object').to.equal(before);

				const bRows = await asyncIterableToArray(bState.overlayTable.query!(makeFullScanFilterInfo()));
				expect(bRows.map(r => [r[0], r[1], r[2]]), 'the marker collapsed onto the live row').to.deep.equal([['a', 'y', 0]]);

				// And the foreign transaction commits its replacement over the committed 'A'.
				await isoShared.commitConnectionOverlays(dbB);
				const committed = await asyncIterableToArray(
					isoShared.getUnderlyingState('main', 'ct')!.underlyingTable.query!(makeFullScanFilterInfo()));
				expect(committed.map(r => [r[0], r[1]])).to.deep.equal([['a', 'y']]);
			});

			it('poisons a foreign overlay whose staging table refuses the re-key as RETRYABLE', async () => {
				// The second refusal kind. B's staged rows are individually fine — one deletion
				// marker for the committed 'A' plus its case-variant replacement 'a', the very
				// pair the previous test migrates cleanly — but here they sit behind a savepoint.
				// A `rollback to` that savepoint would have to restore BOTH, and a NOCASE-keyed
				// staging table cannot hold two rows on one key, so the staging module refuses
				// the re-sort with BUSY ("commit/rollback and retry") rather than CONSTRAINT.
				//
				// BUSY must route exactly like the duplicate: poison this one overlay, leave the
				// issuer's ALTER standing. It must NOT rethrow (that would abort A's ALTER after
				// the shared table had already re-keyed) and must NOT be swallowed as a silent
				// migration (B's rows would be left claiming a layout they never adopted).
				await injectOverlayRowsBehindSavepoint(dbB, [['A', null, 1], ['a', 'y', 0]]);
				const before = isoShared.getConnectionOverlay(dbB, 'main', 'ct')!.overlayTable;
				const underlying = isoShared.getUnderlyingState('main', 'ct')!.underlyingTable;

				const updated = await isoShared.alterTable(dbA, 'main', 'ct', setCollateNocase);

				// Not rethrown: the issuer's ALTER completed and the shared table is re-keyed.
				expect(updated.columns.find(c => c.name === 'k')!.collation, "the issuer's ALTER still applies").to.equal('NOCASE');
				expect(liveCollation(underlying, 'k'), 'the shared table re-keyed').to.equal('NOCASE');

				// Not silently migrated: B is poisoned, and its staging table never adopted the
				// re-key (the refusal fires in the staging module's pre-mutation pass).
				const bState = isoShared.getConnectionOverlay(dbB, 'main', 'ct')!;
				expect(bState.poison, 'a retryable refusal poisons rather than rethrowing').to.not.be.undefined;
				expect(bState.overlayTable, 'the overlay stays installed, not swapped').to.equal(before);
				expect(liveCollation(bState.overlayTable, 'k'), 'the staging table never adopted the re-key').to.equal('BINARY');

				// The poison message names the DDL and quotes the staging module's own retry
				// wording, so B's owner can tell a representability refusal from a real duplicate.
				expect(bState.poison!.message).to.match(/alter table \(alterColumn\)/i);
				expect(bState.poison!.message).to.match(/commit\/rollback and retry/i);
				expect(bState.poison!.message).to.match(/roll back this transaction/i);

				// Pinning what the poisoned overlay is LEFT holding: the collapsed 'A' marker was
				// dropped in preparation for the re-key and is NOT restored on this path (the
				// issuer's is, via reinsertPkRekeyMarkers). Harmless only because poison is
				// terminal — see the NOTE on the poison branch in IsolationModule
				// .applyInPlaceOverlayChange. If this assertion ever has to change, that NOTE is
				// the thing to re-read.
				const bRows = await asyncIterableToArray(bState.overlayTable.query!(makeFullScanFilterInfo()));
				expect(bRows.map(r => [r[0], r[2]]), 'the dropped marker is not restored under poison')
					.to.deep.equal([['a', 0]]);

				// And B is told at its commit, exactly as the duplicate case is.
				let commitErr: unknown;
				try { await isoShared.commitConnectionOverlays(dbB); } catch (e) { commitErr = e; }
				expect(commitErr, 'poisoned overlay must abort the commit').to.be.instanceOf(QuereusError);
				expect((commitErr as QuereusError).code).to.equal(StatusCode.CONSTRAINT);

				// A's committed row is untouched by B's failed adoption.
				const committed = await asyncIterableToArray(underlying.query!(makeFullScanFilterInfo()));
				expect(committed.map(r => [r[0], r[1]]), "the issuer's committed rows survive").to.deep.equal([['A', 'x']]);
			});
		});
	});

	describe('in-transaction column-shape ALTER keeps the overlay tombstone flag last', () => {
		// The overlay stages rows as [data columns..., tombstone flag] and every read/write
		// path assumes the flag is LAST. A bare addColumn forward to the overlay would append
		// the new column AFTER the flag, silently dropping every value written to it on read —
		// these pin the `insertAtIndex` overlay-flavouring (see buildOverlayAddColumnChange).
		let isolatedModule: IsolationModule;

		beforeEach(() => {
			isolatedModule = new IsolationModule({ underlying: new MemoryTableModule() });
			db.registerModule('isolated', isolatedModule);
		});

		it('a value written to the just-added column reads back in-transaction and after COMMIT', async () => {
			await db.exec(`CREATE TABLE lay_w (id INTEGER PRIMARY KEY, v TEXT) USING isolated`);

			await db.exec(`BEGIN`);
			await db.exec(`INSERT INTO lay_w VALUES (1, 'a')`);
			await db.exec(`ALTER TABLE lay_w ADD COLUMN w TEXT DEFAULT 'z'`);
			await db.exec(`INSERT INTO lay_w VALUES (2, 'b', 'fresh')`);

			let rows = await asyncIterableToArray(db.eval(`SELECT id, v, w FROM lay_w ORDER BY id`));
			expect(rows.map((r: any) => [r.id, r.v, r.w]), 'in-transaction read').to.deep.equal([[1, 'a', 'z'], [2, 'b', 'fresh']]);

			await db.exec(`COMMIT`);
			rows = await asyncIterableToArray(db.eval(`SELECT id, v, w FROM lay_w ORDER BY id`));
			expect(rows.map((r: any) => [r.id, r.v, r.w]), 'post-commit read').to.deep.equal([[1, 'a', 'z'], [2, 'b', 'fresh']]);
		});

		it('UPDATE of a staged row targets the just-added column correctly', async () => {
			await db.exec(`CREATE TABLE lay_u (id INTEGER PRIMARY KEY, v TEXT) USING isolated`);

			await db.exec(`BEGIN`);
			await db.exec(`INSERT INTO lay_u VALUES (1, 'a')`);
			await db.exec(`ALTER TABLE lay_u ADD COLUMN w TEXT DEFAULT 'z'`);
			await db.exec(`UPDATE lay_u SET w = 'updated' WHERE id = 1`);
			await db.exec(`COMMIT`);

			const rows = await asyncIterableToArray(db.eval(`SELECT id, v, w FROM lay_u ORDER BY id`));
			expect(rows.map((r: any) => [r.id, r.v, r.w])).to.deep.equal([[1, 'a', 'updated']]);
		});

		it('a committed row deleted in-transaction stays deleted across an ADD COLUMN', async () => {
			await db.exec(`CREATE TABLE lay_d (id INTEGER PRIMARY KEY, v TEXT) USING isolated`);
			await db.exec(`INSERT INTO lay_d VALUES (1, 'a'), (2, 'b')`);

			await db.exec(`BEGIN`);
			await db.exec(`DELETE FROM lay_d WHERE id = 1`);
			await db.exec(`ALTER TABLE lay_d ADD COLUMN w TEXT DEFAULT 'z'`);
			await db.exec(`COMMIT`);

			const rows = await asyncIterableToArray(db.eval(`SELECT id, v, w FROM lay_d ORDER BY id`));
			expect(rows.map((r: any) => [r.id, r.v, r.w])).to.deep.equal([[2, 'b', 'z']]);
		});

		it('DROP COLUMN (middle) realigns staged rows alongside committed ones at COMMIT', async () => {
			await db.exec(`CREATE TABLE lay_dc (id INTEGER PRIMARY KEY, v TEXT, x INTEGER) USING isolated`);
			await db.exec(`INSERT INTO lay_dc VALUES (0, 'base', 100)`);

			await db.exec(`BEGIN`);
			await db.exec(`INSERT INTO lay_dc VALUES (1, 'a', 10)`);
			await db.exec(`ALTER TABLE lay_dc DROP COLUMN v`);

			let rows = await asyncIterableToArray(db.eval(`SELECT id, x FROM lay_dc ORDER BY id`));
			expect(rows.map((r: any) => [r.id, r.x]), 'in-transaction merged read').to.deep.equal([[0, 100], [1, 10]]);

			await db.exec(`COMMIT`);
			rows = await asyncIterableToArray(db.eval(`SELECT id, x FROM lay_dc ORDER BY id`));
			expect(rows.map((r: any) => [r.id, r.x]), 'post-commit read').to.deep.equal([[0, 100], [1, 10]]);
		});
	});

	describe('ADD COLUMN at a caller-chosen position (isolation layer)', () => {
		// `buildOverlayAddColumnChange` honours a caller-named `insertAtIndex` and only falls
		// back to the tombstone flag's own index (append, ahead of the flag) when the caller
		// names none. SQL never names one; `PositionedIsolationModule` stands in for the
		// in-process module wrapper that can — mirroring `PositionedMemoryModule` in
		// `packages/quereus/test/alter-column-open-transaction-layer.spec.ts`. The sibling
		// block above ('in-transaction column-shape ALTER keeps the overlay tombstone flag
		// last') only drives the no-position arm; these pin the caller-named one.
		class PositionedIsolationModule extends IsolationModule {
			public insertAt: number | undefined;

			override async alterTable(
				db: Database,
				schemaName: string,
				tableName: string,
				change: SchemaChangeInfo,
				rows?: EffectiveRowSource,
			): Promise<TableSchema> {
				const positioned: SchemaChangeInfo = change.type === 'addColumn' && this.insertAt !== undefined
					? { ...change, insertAtIndex: this.insertAt }
					: change;
				return super.alterTable(db, schemaName, tableName, positioned, rows);
			}
		}

		let isolatedModule: PositionedIsolationModule;

		beforeEach(() => {
			isolatedModule = new PositionedIsolationModule({ underlying: new MemoryTableModule() });
			db.registerModule('isolated', isolatedModule);
		});

		function columnOrder(tableName: string): string[] {
			const table = db.schemaManager.getTable('main', tableName);
			expect(table, `table ${tableName} should exist`).to.exist;
			return table!.columns.map(c => c.name);
		}

		it('inserts at position 0 ahead of committed and staged rows alike', async () => {
			await db.exec(`CREATE TABLE pos_zero (id INTEGER PRIMARY KEY, v TEXT) USING isolated`);
			await db.exec(`INSERT INTO pos_zero VALUES (1, 'a')`);

			await db.exec(`BEGIN`);
			await db.exec(`INSERT INTO pos_zero VALUES (2, 'b')`);
			isolatedModule.insertAt = 0;
			await db.exec(`ALTER TABLE pos_zero ADD COLUMN w TEXT DEFAULT 'z'`);

			expect(columnOrder('pos_zero')).to.deep.equal(['w', 'id', 'v']);
			let rows = await asyncIterableToArray(db.eval(`SELECT * FROM pos_zero ORDER BY id`));
			expect(rows.map((r: any) => [r.w, r.id, r.v]), 'in-transaction read').to.deep.equal([['z', 1, 'a'], ['z', 2, 'b']]);

			await db.exec(`COMMIT`);
			rows = await asyncIterableToArray(db.eval(`SELECT * FROM pos_zero ORDER BY id`));
			expect(rows.map((r: any) => [r.w, r.id, r.v]), 'post-commit read').to.deep.equal([['z', 1, 'a'], ['z', 2, 'b']]);
		});

		it('a write after the reshape targets the new column by name, not by row position', async () => {
			// The case that would catch a row/schema layout disagreement: a value written to
			// the new column must read back under that column's name.
			await db.exec(`CREATE TABLE pos_writes (id INTEGER PRIMARY KEY, v TEXT) USING isolated`);
			await db.exec(`INSERT INTO pos_writes VALUES (1, 'a')`);

			await db.exec(`BEGIN`);
			await db.exec(`INSERT INTO pos_writes VALUES (2, 'b')`);
			isolatedModule.insertAt = 0;
			await db.exec(`ALTER TABLE pos_writes ADD COLUMN w TEXT DEFAULT 'z'`);

			await db.exec(`UPDATE pos_writes SET w = 'upd' WHERE id = 2`);
			await db.exec(`INSERT INTO pos_writes VALUES ('fresh', 3, 'c')`); // new layout: w, id, v
			await db.exec(`DELETE FROM pos_writes WHERE id = 1`);
			await db.exec(`COMMIT`);

			const rows = await asyncIterableToArray(db.eval(`SELECT * FROM pos_writes ORDER BY id`));
			expect(rows.map((r: any) => [r.w, r.id, r.v])).to.deep.equal([['upd', 2, 'b'], ['fresh', 3, 'c']]);
		});

		it('a staged deletion survives a positioned ALTER', async () => {
			await db.exec(`CREATE TABLE pos_del (id INTEGER PRIMARY KEY, v TEXT) USING isolated`);
			await db.exec(`INSERT INTO pos_del VALUES (1, 'a'), (2, 'b')`);

			await db.exec(`BEGIN`);
			await db.exec(`DELETE FROM pos_del WHERE id = 1`);
			await db.exec(`INSERT INTO pos_del VALUES (3, 'c')`);
			isolatedModule.insertAt = 1;
			await db.exec(`ALTER TABLE pos_del ADD COLUMN w TEXT DEFAULT 'z'`);

			expect(columnOrder('pos_del')).to.deep.equal(['id', 'w', 'v']);
			await db.exec(`COMMIT`);

			const rows = await asyncIterableToArray(db.eval(`SELECT * FROM pos_del ORDER BY id`));
			expect(rows.map((r: any) => [r.id, r.w, r.v]), 'the deleted row stays deleted').to.deep.equal([[2, 'z', 'b'], [3, 'z', 'c']]);
		});

		it('renumbers a multi-column primary key AND a secondary index the insert lands ahead of both', async () => {
			await db.exec(`CREATE TABLE pos_pk (k1 INTEGER, v TEXT, k2 INTEGER, PRIMARY KEY (k1, k2)) USING isolated`);
			await db.exec(`CREATE INDEX pos_pk_v ON pos_pk (v)`);
			await db.exec(`INSERT INTO pos_pk VALUES (1, 'p', 10)`);

			await db.exec(`BEGIN`);
			await db.exec(`INSERT INTO pos_pk VALUES (2, 'q', 20)`);
			isolatedModule.insertAt = 0;
			await db.exec(`ALTER TABLE pos_pk ADD COLUMN w TEXT DEFAULT 'z'`);

			expect(columnOrder('pos_pk')).to.deep.equal(['w', 'k1', 'v', 'k2']);
			let byPk = await asyncIterableToArray(db.eval(`SELECT v FROM pos_pk WHERE k1 = 2 AND k2 = 20`));
			let byIndex = await asyncIterableToArray(db.eval(`SELECT k1 FROM pos_pk WHERE v = 'q'`));
			expect(byPk.map((r: any) => r.v), 'in-transaction PK seek').to.deep.equal(['q']);
			expect(byIndex.map((r: any) => r.k1), 'in-transaction secondary index seek').to.deep.equal([2]);

			await db.exec(`COMMIT`);
			byPk = await asyncIterableToArray(db.eval(`SELECT v FROM pos_pk WHERE k1 = 2 AND k2 = 20`));
			byIndex = await asyncIterableToArray(db.eval(`SELECT k1 FROM pos_pk WHERE v = 'q'`));
			expect(byPk.map((r: any) => r.v), 'post-commit PK seek').to.deep.equal(['q']);
			expect(byIndex.map((r: any) => r.k1), 'post-commit secondary index seek').to.deep.equal([2]);
		});

		it("a position equal to the base's column count is indistinguishable from a plain append", async () => {
			await db.exec(`CREATE TABLE pos_end (id INTEGER PRIMARY KEY, v TEXT) USING isolated`);
			await db.exec(`INSERT INTO pos_end VALUES (1, 'a')`);

			await db.exec(`BEGIN`);
			await db.exec(`INSERT INTO pos_end VALUES (2, 'b')`);
			isolatedModule.insertAt = 2; // the base's own append slot
			await db.exec(`ALTER TABLE pos_end ADD COLUMN w TEXT DEFAULT 'z'`);

			expect(columnOrder('pos_end')).to.deep.equal(['id', 'v', 'w']);
			let rows = await asyncIterableToArray(db.eval(`SELECT * FROM pos_end ORDER BY id`));
			expect(rows.map((r: any) => [r.id, r.v, r.w])).to.deep.equal([[1, 'a', 'z'], [2, 'b', 'z']]);

			await db.exec(`COMMIT`);
			rows = await asyncIterableToArray(db.eval(`SELECT * FROM pos_end ORDER BY id`));
			expect(rows.map((r: any) => [r.id, r.v, r.w])).to.deep.equal([[1, 'a', 'z'], [2, 'b', 'z']]);
		});

		it("a change with no position still appends — the harness can't mask the default arm", async () => {
			await db.exec(`CREATE TABLE pos_default (id INTEGER PRIMARY KEY, v TEXT) USING isolated`);
			await db.exec(`INSERT INTO pos_default VALUES (1, 'a')`);

			await db.exec(`BEGIN`);
			await db.exec(`INSERT INTO pos_default VALUES (2, 'b')`);
			isolatedModule.insertAt = undefined;
			await db.exec(`ALTER TABLE pos_default ADD COLUMN w TEXT DEFAULT 'z'`);

			expect(columnOrder('pos_default')).to.deep.equal(['id', 'v', 'w']);
			await db.exec(`COMMIT`);
			const rows = await asyncIterableToArray(db.eval(`SELECT * FROM pos_default ORDER BY id`));
			expect(rows.map((r: any) => [r.id, r.v, r.w])).to.deep.equal([[1, 'a', 'z'], [2, 'b', 'z']]);
		});

		it('rejects an out-of-range position clean, before anything irreversible', async () => {
			await db.exec(`CREATE TABLE pos_oor (id INTEGER PRIMARY KEY, v TEXT) USING isolated`);
			await db.exec(`INSERT INTO pos_oor VALUES (1, 'a')`);

			await db.exec(`BEGIN`);
			await db.exec(`INSERT INTO pos_oor VALUES (2, 'b')`);
			isolatedModule.insertAt = 99;

			let error: unknown;
			try {
				await db.exec(`ALTER TABLE pos_oor ADD COLUMN w TEXT DEFAULT 'z'`);
			} catch (e) { error = e; }
			expect(error, 'out-of-range position should have been rejected').to.be.instanceOf(Error);
			expect(String(error)).to.match(/Cannot add column 'w' at position 99/);
			expect(String(error)).to.match(/expected an integer in \[0, 2\]/);

			expect(columnOrder('pos_oor'), 'catalog untouched').to.deep.equal(['id', 'v']);

			await db.exec(`COMMIT`);
			const rows = await asyncIterableToArray(db.eval(`SELECT * FROM pos_oor ORDER BY id`));
			expect(rows.map((r: any) => [r.id, r.v]), 'the open transaction still commits, rows unchanged').to.deep.equal([[1, 'a'], [2, 'b']]);
		});

		it('an expression DEFAULT still evaluates against the pre-insert row layout', async () => {
			// The evaluator arm, not a folded literal: `computeAddColumnValue` strips the
			// tombstone flag off an OLD-layout overlay row before running `new.<col>`, while
			// `insertAtIndex` describes the NEW layout. A caller-named slot must not shift
			// what the evaluator reads.
			await db.exec(`CREATE TABLE pos_expr (id INTEGER PRIMARY KEY, v INTEGER) USING isolated`);
			await db.exec(`INSERT INTO pos_expr VALUES (1, 10)`);

			await db.exec(`BEGIN`);
			await db.exec(`INSERT INTO pos_expr VALUES (2, 20)`);
			isolatedModule.insertAt = 0;
			await db.exec(`ALTER TABLE pos_expr ADD COLUMN w INTEGER DEFAULT (new.v * 2)`);

			expect(columnOrder('pos_expr')).to.deep.equal(['w', 'id', 'v']);
			let rows = await asyncIterableToArray(db.eval(`SELECT * FROM pos_expr ORDER BY id`));
			expect(rows.map((r: any) => [r.w, r.id, r.v]), 'in-transaction read').to.deep.equal([[20, 1, 10], [40, 2, 20]]);

			await db.exec(`COMMIT`);
			rows = await asyncIterableToArray(db.eval(`SELECT * FROM pos_expr ORDER BY id`));
			expect(rows.map((r: any) => [r.w, r.id, r.v]), 'post-commit read').to.deep.equal([[20, 1, 10], [40, 2, 20]]);
		});

		it('a NOT NULL expression DEFAULT at a position does not reject a staged deletion marker', async () => {
			// A marker carries placeholder NULL at every non-key column, so it must be
			// short-circuited (NULL, not evaluated, not NOT NULL-checked) even when the new
			// column lands at slot 0 — the slot the marker's own key does NOT occupy.
			await db.exec(`CREATE TABLE pos_nn (id INTEGER PRIMARY KEY, v INTEGER) USING isolated`);
			await db.exec(`INSERT INTO pos_nn VALUES (1, 10), (2, 20)`);

			await db.exec(`BEGIN`);
			await db.exec(`DELETE FROM pos_nn WHERE id = 1`);
			await db.exec(`INSERT INTO pos_nn VALUES (3, 30)`);
			isolatedModule.insertAt = 0;
			await db.exec(`ALTER TABLE pos_nn ADD COLUMN w INTEGER NOT NULL DEFAULT (new.v * 2)`);

			expect(columnOrder('pos_nn')).to.deep.equal(['w', 'id', 'v']);
			let rows = await asyncIterableToArray(db.eval(`SELECT * FROM pos_nn ORDER BY id`));
			expect(rows.map((r: any) => [r.w, r.id, r.v]), 'in-transaction read').to.deep.equal([[40, 2, 20], [60, 3, 30]]);

			await db.exec(`COMMIT`);
			rows = await asyncIterableToArray(db.eval(`SELECT * FROM pos_nn ORDER BY id`));
			expect(rows.map((r: any) => [r.w, r.id, r.v]), 'post-commit read').to.deep.equal([[40, 2, 20], [60, 3, 30]]);
		});

		it('re-derives the overlay tombstone slot on each of three ALTERs in one transaction', async () => {
			// The overlay's tombstone index is read off its own schema per ALTER, so a second
			// (and third) reshape must see the reshaped overlay, not the connect-time snapshot.
			await db.exec(`CREATE TABLE pos_twice (id INTEGER PRIMARY KEY, v TEXT) USING isolated`);
			await db.exec(`INSERT INTO pos_twice VALUES (1, 'a')`);

			await db.exec(`BEGIN`);
			await db.exec(`INSERT INTO pos_twice VALUES (2, 'b')`);
			isolatedModule.insertAt = 0;
			await db.exec(`ALTER TABLE pos_twice ADD COLUMN w TEXT DEFAULT 'z'`);
			isolatedModule.insertAt = 2;
			await db.exec(`ALTER TABLE pos_twice ADD COLUMN x TEXT DEFAULT 'y'`);
			isolatedModule.insertAt = undefined; // appends, still ahead of the flag
			await db.exec(`ALTER TABLE pos_twice ADD COLUMN u TEXT DEFAULT 'q'`);

			expect(columnOrder('pos_twice')).to.deep.equal(['w', 'id', 'x', 'v', 'u']);
			let rows = await asyncIterableToArray(db.eval(`SELECT * FROM pos_twice ORDER BY id`));
			expect(rows.map((r: any) => [r.w, r.id, r.x, r.v, r.u]), 'in-transaction read')
				.to.deep.equal([['z', 1, 'y', 'a', 'q'], ['z', 2, 'y', 'b', 'q']]);

			await db.exec(`COMMIT`);
			rows = await asyncIterableToArray(db.eval(`SELECT * FROM pos_twice ORDER BY id`));
			expect(rows.map((r: any) => [r.w, r.id, r.x, r.v, r.u]), 'post-commit read')
				.to.deep.equal([['z', 1, 'y', 'a', 'q'], ['z', 2, 'y', 'b', 'q']]);
		});

		it('keeps pre-savepoint rows at the new layout after a rollback to savepoint', async () => {
			await db.exec(`CREATE TABLE pos_sp (id INTEGER PRIMARY KEY, v TEXT) USING isolated`);

			await db.exec(`BEGIN`);
			await db.exec(`INSERT INTO pos_sp VALUES (1, 'a')`);
			await db.exec(`SAVEPOINT s`);
			await db.exec(`INSERT INTO pos_sp VALUES (2, 'b')`);
			isolatedModule.insertAt = 0;
			await db.exec(`ALTER TABLE pos_sp ADD COLUMN w TEXT DEFAULT 'z'`);
			await db.exec(`INSERT INTO pos_sp VALUES ('x', 3, 'c')`); // new layout: w, id, v
			await db.exec(`ROLLBACK TO SAVEPOINT s`);

			expect(columnOrder('pos_sp')).to.deep.equal(['w', 'id', 'v']);
			let rows = await asyncIterableToArray(db.eval(`SELECT * FROM pos_sp ORDER BY id`));
			expect(rows.map((r: any) => [r.w, r.id, r.v]), 'only the pre-savepoint row survives, at the new layout').to.deep.equal([['z', 1, 'a']]);

			await db.exec(`COMMIT`);
			rows = await asyncIterableToArray(db.eval(`SELECT * FROM pos_sp ORDER BY id`));
			expect(rows.map((r: any) => [r.w, r.id, r.v])).to.deep.equal([['z', 1, 'a']]);
		});

		it('a caller-named position on a cross-connection foreign overlay backfills at that slot, not the end', async () => {
			const iso = new IsolationModule({ underlying: new MemoryTableModule() });
			const dbA = new Database();
			const dbB = new Database();
			dbA.registerModule('isolated', iso);
			await dbA.exec('create table pos_cross (id integer primary key, x integer null) using isolated');

			const underlying = iso.getUnderlyingState('main', 'pos_cross')!.underlyingTable;
			const overlay = await iso.overlayModule.create(dbB, iso.createOverlaySchema(underlying.tableSchema!));
			await overlay.update({ operation: 'insert', values: [10, 7, 0] });    // live staged row
			await overlay.update({ operation: 'insert', values: [11, null, 1] }); // deletion marker
			iso.setConnectionOverlay(dbB, 'main', 'pos_cross', { overlayTable: overlay, hasChanges: true, db: dbB });

			const change: SchemaChangeInfo = {
				type: 'addColumn',
				columnDef: {
					name: 'c',
					dataType: 'INTEGER',
					constraints: [{ type: 'default', expr: { type: 'literal', value: 42 } }],
				},
				insertAtIndex: 0,
			};
			const updated = await iso.alterTable(dbA, 'main', 'pos_cross', change);

			expect(updated.columns.map(col => col.name), 'base gains c ahead of the existing columns').to.deep.equal(['c', 'id', 'x']);

			const bState = iso.getConnectionOverlay(dbB, 'main', 'pos_cross')!;
			expect(bState.poison, 'B must not be poisoned by a satisfiable caller-named position').to.be.undefined;
			expect(bState.overlayTable.tableSchema!.columns.map(col => col.name), "B's overlay mirrors the base layout ahead of the tombstone flag")
				.to.deep.equal(['c', 'id', 'x', '_tombstone']);

			const bRows = await asyncIterableToArray(bState.overlayTable.query!(makeFullScanFilterInfo()));
			expect(bRows, 'live row backfilled at slot 0; marker stays NULL there; flag stays last')
				.to.deep.equal([[42, 10, 7, 0], [null, 11, null, 1]]);

			await dbA.close();
			await dbB.close();
		});
	});

	describe('ALTER TABLE ADD COLUMN atomic pre-validation', () => {
		// The isolation layer dry-runs every affected overlay's backfill BEFORE mutating
		// the shared underlying, so a NOT NULL / tombstone rejection leaves the underlying
		// base AND the schema catalog untouched (no base/catalog divergence). The
		// underlying-column-count assertion is the white-box check that the irreversible
		// `underlying.alterTable` never ran: before the fix it would already have appended
		// the new column when the overlay migration later threw.
		let isolatedModule: IsolationModule;

		beforeEach(() => {
			isolatedModule = new IsolationModule({ underlying: new MemoryTableModule() });
			db.registerModule('isolated', isolatedModule);
		});

		/**
		 * Live underlying column count for `main.<table>` — the white-box check that the
		 * irreversible `underlying.alterTable` never ran (see {@link liveSchema} for why the
		 * instance `tableSchema` field would make it vacuous).
		 */
		function underlyingColumnCount(table: string): number {
			return liveSchema(isolatedModule.getUnderlyingState('main', table)!.underlyingTable).columns.length;
		}

		it('rejects atomically when a per-row NOT NULL backfill yields NULL for a staged row', async () => {
			// `x` is explicitly nullable so the staged row can carry NULL; the committed base
			// is empty (the INSERT is staged in the overlay), so the underlying's own backfill
			// would succeed — only the overlay row is un-backfillable. Pre-validation must
			// reject before the underlying is altered.
			await db.exec(`CREATE TABLE t_nn (id INTEGER PRIMARY KEY, x INTEGER NULL) USING isolated`);
			const before = underlyingColumnCount('t_nn'); // id, x

			await db.exec('BEGIN');
			await db.exec(`INSERT INTO t_nn VALUES (1, NULL)`); // stages an overlay row with x = NULL

			let err: Error | null = null;
			try {
				await db.exec(`ALTER TABLE t_nn ADD COLUMN c INTEGER NOT NULL DEFAULT (new.x)`);
			} catch (e) { err = e as Error; }
			expect(err, 'ALTER must throw for a NULL-yielding NOT NULL backfill').to.not.be.null;
			expect(err!.message.toLowerCase()).to.include('not null');

			// White-box: the shared underlying was never mutated (no phantom `c`).
			expect(underlyingColumnCount('t_nn'), 'underlying must be untouched after atomic rejection').to.equal(before);

			await db.exec('ROLLBACK');
		});

		it('succeeds when a staged tombstone would otherwise trip the NOT NULL backfill', async () => {
			// A staged DELETE leaves a tombstone row whose data columns are NULL placeholders.
			// The per-row evaluator must NOT run against it (it would spuriously trip NOT NULL);
			// a sibling staged insert with a satisfiable value confirms the ALTER still applies.
			await db.exec(`CREATE TABLE t_ts (id INTEGER PRIMARY KEY, name TEXT) USING isolated`);
			await db.exec(`INSERT INTO t_ts VALUES (1, 'Alice'), (2, 'Bob')`); // committed

			await db.exec('BEGIN');
			await db.exec(`DELETE FROM t_ts WHERE id = 1`);          // stages a tombstone for id=1
			await db.exec(`INSERT INTO t_ts VALUES (3, 'Carol')`);   // staged insert (new.id = 3, non-null)
			// new.id is non-null for every live row; the tombstone for id=1 must be skipped.
			await db.exec(`ALTER TABLE t_ts ADD COLUMN tag INTEGER NOT NULL DEFAULT (new.id)`);

			const inTxn = await asyncIterableToArray(db.eval('SELECT id, tag FROM t_ts ORDER BY id'));
			expect(inTxn.map((r: any) => [r.id, r.tag])).to.deep.equal([[2, 2], [3, 3]]);

			await db.exec('COMMIT');

			const afterCommit = await asyncIterableToArray(db.eval('SELECT id, tag FROM t_ts ORDER BY id'));
			expect(afterCommit.map((r: any) => [r.id, r.tag])).to.deep.equal([[2, 2], [3, 3]]);
		});

		it('rejects atomically under default_column_nullability=not_null with no explicit NOT NULL', async () => {
			// The added column carries no explicit `not null`, but the session option resolves
			// it NOT NULL. Pre-validation must derive nullability via columnDefToSchema + the
			// option (not from explicit constraints alone) and reject the un-backfillable
			// staged row, atomically.
			db.setOption('default_column_nullability', 'not_null');
			await db.exec(`CREATE TABLE t_opt (id INTEGER PRIMARY KEY, x INTEGER NULL) USING isolated`);
			const before = underlyingColumnCount('t_opt');

			await db.exec('BEGIN');
			await db.exec(`INSERT INTO t_opt VALUES (1, NULL)`);

			let err: Error | null = null;
			try {
				await db.exec(`ALTER TABLE t_opt ADD COLUMN c INTEGER DEFAULT (new.x)`); // implicitly NOT NULL
			} catch (e) { err = e as Error; }
			expect(err, 'ALTER must throw for an implicitly NOT NULL un-backfillable staged row').to.not.be.null;
			expect(err!.message.toLowerCase()).to.include('not null');
			expect(underlyingColumnCount('t_opt'), 'underlying must be untouched after atomic rejection').to.equal(before);

			await db.exec('ROLLBACK');
		});

		it('happy path: satisfiable per-row default backfills staged rows through commit', async () => {
			// Guards the deriveAddColumnBackfill refactor: a satisfiable per-row default over
			// staged inserts must still backfill each staged row from its own sibling value
			// and survive commit (read-your-writes).
			await db.exec(`CREATE TABLE t_hp (id INTEGER PRIMARY KEY, qty INTEGER) USING isolated`);

			await db.exec('BEGIN');
			await db.exec(`INSERT INTO t_hp VALUES (1, 10), (2, 25)`);
			await db.exec(`ALTER TABLE t_hp ADD COLUMN qty2 INTEGER DEFAULT (new.qty * 2)`);

			const inTxn = await asyncIterableToArray(db.eval('SELECT id, qty2 FROM t_hp ORDER BY id'));
			expect(inTxn.map((r: any) => [r.id, r.qty2])).to.deep.equal([[1, 20], [2, 50]]);

			await db.exec('COMMIT');

			const afterCommit = await asyncIterableToArray(db.eval('SELECT id, qty2 FROM t_hp ORDER BY id'));
			expect(afterCommit.map((r: any) => [r.id, r.qty2])).to.deep.equal([[1, 20], [2, 50]]);
		});
	});

	describe('row-validating DDL cross-connection poison semantics', () => {
		// The hybrid (B) blast radius: an ALTER no longer aborts because of ANOTHER
		// connection's uncommitted, un-backfillable overlay. The issuer's own
		// un-backfillable overlay still aborts atomically (unchanged); a foreign one is
		// POISONED — its owning connection errors on its next read/write/commit — while
		// the issuer's ALTER applies and every migratable overlay is carried forward.
		//
		// These are white-box tests: two+ Database instances share ONE IsolationModule so
		// each connection gets a distinct dbId (the module keys overlays by getDbId(db)).
		// Overlays are injected directly via setConnectionOverlay (deterministic connection
		// counts, following setupStagedOverlay) and the ALTER is driven straight through
		// iso.alterTable(dbA, ...) with a manually-built addColumn change.
		let iso: IsolationModule;
		let dbA: Database; // the ALTER issuer
		let dbB: Database; // a foreign connection (poison target)
		let dbC: Database; // a second foreign connection (migratable peer)

		beforeEach(async () => {
			iso = new IsolationModule({ underlying: new MemoryTableModule() });
			dbA = new Database();
			dbB = new Database();
			dbC = new Database();
			dbA.registerModule('isolated', iso);
			// Created through dbA → builds the shared underlying (columns: id, x).
			await dbA.exec('create table t (id integer primary key, x integer null) using isolated');
			// One committed baseline row whose own backfill always succeeds (x is non-null),
			// so the underlying's NOT NULL backfill never trips — only staged overlay rows do.
			await dbA.exec('insert into t values (5, 5)');
		});

		afterEach(async () => {
			await dbA.close();
			await dbB.close();
			await dbC.close();
		});

		/** Primary-key full-scan FilterInfo (idxStr === null). */
		function fullScan(): FilterInfo {
			return {
				idxNum: 0,
				idxStr: null,
				constraints: [],
				args: [],
				accessPath: { kind: 'fullScan' },
				indexInfoOutput: {
					nConstraint: 0,
					aConstraint: [],
					nOrderBy: 0,
					aOrderBy: [],
					colUsed: 0n,
					aConstraintUsage: [],
					idxNum: 0,
					idxStr: null,
					orderByConsumed: false,
					estimatedCost: 1000000,
					estimatedRows: 1000000n,
					idxFlags: 0,
				},
			};
		}

		/**
		 * An `addColumn` change for a NOT NULL column whose per-row backfill is the staged
		 * row's `x` value (column index 1). A staged row with x = NULL therefore yields NULL
		 * and is un-backfillable; a staged row with a non-null x backfills successfully.
		 *
		 * Mirrors the engine's real `ADD COLUMN c INTEGER NOT NULL DEFAULT (new.x)` shape:
		 * the columnDef carries the non-foldable `new.x` DEFAULT expression AND a matching
		 * `backfillEvaluator`. The DEFAULT expr is what lets the underlying's
		 * `addColumn` accept a NOT NULL column on a non-empty table (it backfills per row
		 * via the evaluator instead of demanding a literal default), while
		 * `deriveAddColumnBackfill` folds the same expr to `null` and drives the overlay
		 * backfill off the evaluator — yielding the CONSTRAINT that poisons a foreign overlay.
		 */
		function addNotNullCol(colName: string): SchemaChangeInfo {
			return {
				type: 'addColumn',
				columnDef: {
					name: colName,
					dataType: 'INTEGER',
					constraints: [
						{ type: 'notNull' },
						{ type: 'default', expr: { type: 'column', name: 'x', table: 'new' } },
					],
				},
				backfillEvaluator: (row: Row) => row[1],
			};
		}

		/**
		 * An `addColumn` change whose backfill ALWAYS succeeds: a literal DEFAULT (0). The
		 * folded literal satisfies the NOT NULL column for every staged row (no per-row
		 * evaluator path), and the literal lets the underlying accept the column on a
		 * non-empty table. Used to prove a migration would proceed (and thus could clear
		 * poison) were the poisoned overlay not skipped.
		 */
		function addBackfillableCol(colName: string): SchemaChangeInfo {
			return {
				type: 'addColumn',
				columnDef: {
					name: colName,
					dataType: 'INTEGER',
					constraints: [
						{ type: 'notNull' },
						{ type: 'default', expr: { type: 'literal', value: 0 } },
					],
				},
			};
		}

		/** Injects a staged-insert overlay (rows = [id, x][]) for `forDb`, hasChanges=true. */
		async function injectOverlay(forDb: Database, rows: SqlValue[][]): Promise<void> {
			const underlying = iso.getUnderlyingState('main', 't')!.underlyingTable;
			const overlay = await iso.overlayModule.create(forDb, iso.createOverlaySchema(underlying.tableSchema!));
			for (const r of rows) {
				await overlay.update({ operation: 'insert', values: [...r, 0] }); // trailing 0 = live (not tombstone)
			}
			iso.setConnectionOverlay(forDb, 'main', 't', { overlayTable: overlay, hasChanges: true, db: forDb });
		}

		function overlayState(forDb: Database): ConnectionOverlayState | undefined {
			return iso.getConnectionOverlay(forDb, 'main', 't');
		}

		/** Live underlying column count — see {@link liveSchema}. */
		function underlyingColumnCount(): number {
			return liveSchema(iso.getUnderlyingState('main', 't')!.underlyingTable).columns.length;
		}

		async function reader(forDb: Database, readCommitted = false): Promise<IsolatedTable> {
			const opts = (readCommitted ? { _readCommitted: true } : {}) as unknown as BaseModuleConfig;
			return await iso.connect(forDb, undefined, 'isolated', 'main', 't', opts) as IsolatedTable;
		}

		it('applies the ALTER and poisons a foreign overlay whose staged row cannot backfill', async () => {
			await injectOverlay(dbB, [[10, null]]); // B stages an un-backfillable row (x = NULL)
			const before = underlyingColumnCount();  // id, x = 2

			const updated = await iso.alterTable(dbA, 'main', 't', addNotNullCol('c'));

			// The ALTER applied: returned schema AND the live underlying both gained 'c'.
			expect(updated.columns.some(col => col.name === 'c'), 'returned schema has new column').to.equal(true);
			expect(underlyingColumnCount(), 'underlying gained the new column').to.equal(before + 1);

			// B's overlay is poisoned (left in the pre-alter layout, not migrated).
			const bState = overlayState(dbB)!;
			expect(bState.poison, 'B overlay must be poisoned').to.not.be.undefined;
			expect(bState.poison!.message).to.match(/cannot satisfy/i);

			// A (issuer, clean) is unaffected: its read shows the backfilled new column.
			const aRows = await asyncIterableToArray((await reader(dbA)).query(fullScan()));
			expect(aRows.length).to.equal(1);
			expect(aRows[0][2], 'committed row backfilled c = x = 5').to.equal(5);
		});

		// A mandatory column with NEITHER a DEFAULT NOR a backfillEvaluator: the appended
		// value for every staged row is the folded literal default, which here is `null`
		// (there is no DEFAULT at all). This is the OTHER source of a rejectable staged
		// NULL — the sibling test above covers an evaluator that PRODUCES NULL; this one
		// covers there being no value source to begin with. Only reachable while the
		// committed table is empty (any committed row makes the underlying's own
		// "NOT NULL column on non-empty table" check reject the ALTER first), so this uses
		// its own empty table rather than the shared 't' (which this beforeEach seeds with
		// one committed row).
		it('poisons a foreign overlay whose staged row has no DEFAULT to fill a newly added mandatory column', async () => {
			await dbA.exec('create table te (id integer primary key, x integer null) using isolated');
			const underlyingTe = iso.getUnderlyingState('main', 'te')!.underlyingTable;
			const overlayTe = await iso.overlayModule.create(dbB, iso.createOverlaySchema(underlyingTe.tableSchema!));
			await overlayTe.update({ operation: 'insert', values: [10, 5, 0] }); // live staged row; committed 'te' stays empty
			iso.setConnectionOverlay(dbB, 'main', 'te', { overlayTable: overlayTe, hasChanges: true, db: dbB });

			const noDefaultCol: SchemaChangeInfo = {
				type: 'addColumn',
				columnDef: { name: 'c', dataType: 'INTEGER', constraints: [{ type: 'notNull' }] },
			};
			const updated = await iso.alterTable(dbA, 'main', 'te', noDefaultCol);
			expect(updated.columns.some(col => col.name === 'c'), 'the ALTER applies for the issuer').to.equal(true);

			const bState = iso.getConnectionOverlay(dbB, 'main', 'te')!;
			expect(bState.poison, 'B overlay must be poisoned — nothing to fill the mandatory column with').to.not.be.undefined;
			expect(bState.poison!.message).to.match(/cannot satisfy/i);

			// A committed-snapshot reader confirms nothing was committed with a NULL. `reader()`
			// is hardcoded to table 't' (the shared fixture), so connect to 'te' directly.
			const teReader = await iso.connect(dbA, undefined, 'isolated', 'main', 'te', {} as BaseModuleConfig) as IsolatedTable;
			const teRows = await asyncIterableToArray(teReader.query(fullScan()));
			expect(teRows.length, "'te' has no committed rows").to.equal(0);
		});

		// The companion to the test above: the mandatory-column-with-no-DEFAULT rejection must
		// stay BELOW the tombstone short-circuit in `computeAddColumnValue`. Its condition is
		// row-independent (`newColNotNull && foldedDefault === null`), so hoisting it above the
		// per-row tombstone check reads as a harmless simplification and would silently poison
		// every connection holding nothing but staged DELETEs.
		//
		// Reachable for real: B deletes a committed row (staging a marker), A commits a delete of
		// that same row, leaving the committed table empty — so A's mandatory ADD COLUMN gets past
		// the underlying's "non-empty table" refusal while B's overlay holds only that marker. The
		// overlay is injected directly here for the same determinism reason as its siblings.
		it('does NOT poison a foreign overlay holding only a deletion marker when the new mandatory column has no DEFAULT', async () => {
			await dbA.exec('create table td (id integer primary key, x integer null) using isolated');
			const underlyingTd = iso.getUnderlyingState('main', 'td')!.underlyingTable;
			const overlayTd = await iso.overlayModule.create(dbB, iso.createOverlaySchema(underlyingTd.tableSchema!));
			await overlayTd.update({ operation: 'insert', values: [10, null, 1] }); // trailing 1 = deletion marker
			iso.setConnectionOverlay(dbB, 'main', 'td', { overlayTable: overlayTd, hasChanges: true, db: dbB });

			const noDefaultCol: SchemaChangeInfo = {
				type: 'addColumn',
				columnDef: { name: 'c', dataType: 'INTEGER', constraints: [{ type: 'notNull' }] },
			};
			await iso.alterTable(dbA, 'main', 'td', noDefaultCol);

			const bState = iso.getConnectionOverlay(dbB, 'main', 'td')!;
			expect(bState.poison, 'a marker carries no value to reject — B stays healthy').to.be.undefined;
			expect(bState.overlayTable, 'overlay adopted in place, not rebuilt').to.equal(overlayTd);
			const stagedRows = await asyncIterableToArray(bState.overlayTable.query!(fullScan()));
			// [id, x, c, _tombstone] — the new column lands AHEAD of the tombstone flag.
			expect(stagedRows.map(r => [r[0], r[2], r[3]]), 'marker carried forward with a NULL in the new column')
				.to.deep.equal([[10, null, 1]]);
		});

		it('errors a poisoned connection at read, write, and commit; committed reads still succeed', async () => {
			await injectOverlay(dbB, [[10, null]]);
			await iso.alterTable(dbA, 'main', 't', addNotNullCol('c'));
			expect(overlayState(dbB)!.poison).to.not.be.undefined;

			const tableB = await reader(dbB);

			// Merged read throws CONSTRAINT.
			let readErr: unknown;
			try { await asyncIterableToArray(tableB.query(fullScan())); } catch (e) { readErr = e; }
			expect(readErr, 'merged read on a poisoned overlay must throw').to.be.instanceOf(QuereusError);
			expect((readErr as QuereusError).code).to.equal(StatusCode.CONSTRAINT);

			// Write throws CONSTRAINT before staging anything.
			let writeErr: unknown;
			try { await tableB.update({ operation: 'insert', values: [11, 5] }); } catch (e) { writeErr = e; }
			expect(writeErr, 'write on a poisoned overlay must throw').to.be.instanceOf(QuereusError);
			expect((writeErr as QuereusError).code).to.equal(StatusCode.CONSTRAINT);

			// Commit flush throws — this is how a connection that never touches the table
			// again still fails its commit.
			let commitErr: unknown;
			try { await tableB.onConnectionCommit(); } catch (e) { commitErr = e; }
			expect(commitErr, 'commit flush on a poisoned overlay must throw').to.be.instanceOf(QuereusError);
			expect((commitErr as QuereusError).code).to.equal(StatusCode.CONSTRAINT);

			// A committed-snapshot reader bypasses the overlay entirely and succeeds,
			// returning the (backfilled) underlying rows.
			const tableBRC = await reader(dbB, true);
			const rc = await asyncIterableToArray(tableBRC.query(fullScan()));
			expect(rc.length, 'read-committed reader returns underlying rows without throwing').to.equal(1);
			expect(rc[0][2]).to.equal(5);
		});

		it('ADD COLUMN forwards a foreign overlay IN PLACE — same overlay object, rows realigned', async () => {
			await injectOverlay(dbB, [[10, 7]]);
			const before = overlayState(dbB)!.overlayTable;

			await iso.alterTable(dbA, 'main', 't', addBackfillableCol('c'));

			const bState = overlayState(dbB)!;
			expect(bState.poison, 'B stays healthy').to.be.undefined;
			expect(bState.overlayTable, 'overlay adopted in place, not rebuilt').to.equal(before);
			const rows = await asyncIterableToArray(bState.overlayTable.query!(fullScan()));
			expect(rows.length).to.equal(1);
			// [id, x, c, _tombstone] — the new column lands AHEAD of the tombstone flag.
			expect(rows[0][0]).to.equal(10);
			expect(rows[0][1]).to.equal(7);
			expect(rows[0][2], 'literal default backfilled').to.equal(0);
			expect(rows[0][3], 'tombstone flag stays last').to.equal(0);
		});

		it('DROP COLUMN forwards a foreign overlay IN PLACE and realigns staged values', async () => {
			await injectOverlay(dbB, [[10, 7]]);
			const before = overlayState(dbB)!.overlayTable;

			await iso.alterTable(dbA, 'main', 't', { type: 'dropColumn', columnName: 'x' });

			const bState = overlayState(dbB)!;
			expect(bState.poison).to.be.undefined;
			expect(bState.overlayTable, 'overlay adopted in place, not rebuilt').to.equal(before);
			const rows = await asyncIterableToArray(bState.overlayTable.query!(fullScan()));
			// [id, _tombstone]
			expect(rows.map(r => [r[0], r[1]])).to.deep.equal([[10, 0]]);
		});

		/**
		 * `CREATE UNIQUE INDEX` by one connection over rows another connection has staged.
		 *
		 * The issuer's own rows are judged before the index is built (see
		 * `IsolationModule.issuerEffectiveRows`), but a FOREIGN overlay is not — its rows are
		 * that connection's problem, exactly as a concurrent duplicate insert would be. What
		 * must not happen is B losing a staged row to the new index. `MemoryTableManager.createIndex`
		 * pre-validates the overlay's staged rows before mutating anything, so the CONSTRAINT it
		 * raises leaves B's overlay exactly as it was — and `applyInPlaceOverlayChange` poisons
		 * it, so B errors out rather than committing a transaction missing a row it believed it
		 * had written. (Historically the layer REBUILT the overlay here and the copy loop ignored
		 * `MemoryTable.update`'s `{status:'constraint'}` return, silently dropping that row.)
		 */
		it('poisons a foreign overlay whose staged rows violate a newly created UNIQUE index', async () => {
			await injectOverlay(dbB, [[10, 7], [11, 7]]); // B stages two rows that collide on x

			await iso.createIndex(dbA, 'main', 't', {
				name: 't_x_ux',
				columns: [{ index: 1 }],
				unique: true,
			});

			const bState = overlayState(dbB)!;
			expect(bState.poison, 'B overlay must be poisoned, not silently truncated').to.not.be.undefined;
			expect(bState.poison!.message).to.match(/UNIQUE constraint failed/);
			expect(bState.poison!.message).to.match(/roll back this transaction/i);
			// The quoted cause comes from the overlay module, which names its own staging table —
			// same class as bug-overlay-table-name-leaks-into-rekey-error, different site.
			expect(bState.poison!.message, 'names the user table, not the internal overlay staging table')
				.to.not.match(/_overlay_/);
			expect(bState.poison!.message, 'names the user table').to.contain('main.t');

			// The poisoned overlay keeps BOTH staged rows — the rejection fired in the
			// pre-validation pass, before the overlay's index map or layers were touched.
			const bRows = await asyncIterableToArray(bState.overlayTable.query!(fullScan()));
			expect(bRows.map(r => r[0]), 'no staged row was dropped').to.deep.equal([10, 11]);

			// And B's commit fails rather than reporting success over the lost row.
			let commitErr: unknown;
			try { await iso.commitConnectionOverlays(dbB); } catch (e) { commitErr = e; }
			expect(commitErr, 'poisoned overlay must abort the commit').to.be.instanceOf(QuereusError);
			expect((commitErr as QuereusError).code).to.equal(StatusCode.CONSTRAINT);
		});

		it("rejects atomically when the issuer's own overlay cannot backfill", async () => {
			await injectOverlay(dbA, [[1, null]]); // A itself stages the un-backfillable row
			const before = underlyingColumnCount();

			let err: unknown;
			try { await iso.alterTable(dbA, 'main', 't', addNotNullCol('c')); } catch (e) { err = e; }
			expect(err, 'issuer-own un-backfillable overlay must abort the ALTER').to.be.instanceOf(QuereusError);
			expect((err as QuereusError).code).to.equal(StatusCode.CONSTRAINT);
			expect((err as QuereusError).message.toLowerCase()).to.include('not null');

			// Atomic: the shared underlying is untouched (no phantom column).
			expect(underlyingColumnCount(), 'underlying untouched after atomic rejection').to.equal(before);

			// A's overlay is intact and NOT poisoned (it aborted up front).
			const aState = overlayState(dbA)!;
			expect(aState.poison, 'issuer-own overlay is rejected, never poisoned').to.be.undefined;
			expect(aState.hasChanges).to.equal(true);
		});

		it('aborts on the issuer-own overlay first, poisoning no foreign overlay', async () => {
			// Both the issuer's own AND a foreign overlay are un-backfillable. The issuer-own
			// check runs first and aborts before the underlying is mutated, so the foreign
			// overlay is never reached and stays un-poisoned (full atomicity).
			await injectOverlay(dbA, [[1, null]]);
			await injectOverlay(dbB, [[10, null]]);
			const before = underlyingColumnCount();

			let err: unknown;
			try { await iso.alterTable(dbA, 'main', 't', addNotNullCol('c')); } catch (e) { err = e; }
			expect(err).to.be.instanceOf(QuereusError);
			expect(underlyingColumnCount(), 'nothing mutated').to.equal(before);
			expect(overlayState(dbB)!.poison, 'no foreign overlay poisoned on atomic abort').to.be.undefined;
		});

		it('poisons only the un-backfillable foreign overlay and migrates a healthy peer', async () => {
			await injectOverlay(dbB, [[10, null]]); // un-backfillable (x = NULL)
			await injectOverlay(dbC, [[20, 99]]);   // backfillable (x = 99)

			const updated = await iso.alterTable(dbA, 'main', 't', addNotNullCol('c'));
			expect(updated.columns.some(col => col.name === 'c')).to.equal(true);

			// B poisoned; C carried forward in place (addColumn no longer rebuilds), no poison.
			expect(overlayState(dbB)!.poison, 'B poisoned').to.not.be.undefined;
			const cState = overlayState(dbC)!;
			expect(cState.poison, 'C must NOT be poisoned').to.be.undefined;

			// C's staged row survives under the new layout with c backfilled from x.
			const cRows = await asyncIterableToArray(cState.overlayTable.query!(fullScan()));
			expect(cRows.length).to.equal(1);
			expect(cRows[0][0], 'id preserved').to.equal(20);   // [id, x, c, _tombstone]
			expect(cRows[0][2], 'c backfilled = x = 99').to.equal(99);
		});

		it('skips an already-poisoned foreign overlay on a second ALTER, preserving its message', async () => {
			await injectOverlay(dbB, [[10, null]]);
			await iso.alterTable(dbA, 'main', 't', addNotNullCol('c'));
			const firstMsg = overlayState(dbB)!.poison!.message;
			expect(firstMsg).to.match(/'c'/); // names the FIRST added column

			// Second ALTER: B's overlay is already poisoned → skipped (not re-read / re-validated /
			// re-migrated). The ALTER still succeeds and B's poison message is unchanged.
			const updated2 = await iso.alterTable(dbA, 'main', 't', addNotNullCol('d'));
			expect(updated2.columns.some(col => col.name === 'd')).to.equal(true);
			expect(overlayState(dbB)!.poison!.message, 'poison message stays the original').to.equal(firstMsg);
		});

		it('full rollback on a poisoned connection clears the poison', async () => {
			await injectOverlay(dbB, [[10, null]]);
			await iso.alterTable(dbA, 'main', 't', addNotNullCol('c'));
			expect(overlayState(dbB)!.poison).to.not.be.undefined;

			// Full rollback discards the overlay (and its poison) entirely.
			await (await reader(dbB)).onConnectionRollback();
			expect(overlayState(dbB), 'full rollback drops the overlay state').to.be.undefined;

			// A subsequent read takes the no-overlay fast path and does not throw.
			const rows = await asyncIterableToArray((await reader(dbB)).query(fullScan()));
			expect(rows.length, 'committed underlying still readable').to.equal(1);
		});

		it('rollback to a post-overlay savepoint leaves the poison set', async () => {
			await injectOverlay(dbB, [[10, null]]);
			await iso.alterTable(dbA, 'main', 't', addNotNullCol('c'));
			expect(overlayState(dbB)!.poison).to.not.be.undefined;

			// Index 1 is NOT in savepointsBeforeOverlay (the overlay pre-exists this savepoint),
			// so this rollback does NOT replace the ConnectionOverlayState — its poison persists.
			// The schema change is permanent and the overlay rows stay in the pre-alter layout,
			// so the connection must remain poisoned until the transaction ends.
			await (await reader(dbB)).onConnectionRollbackToSavepoint(1);
			expect(overlayState(dbB)!.poison, 'post-overlay savepoint rollback keeps poison').to.not.be.undefined;
		});

		it("a poisoned connection's own later ALTER neither clears its poison nor migrates its stale overlay", async () => {
			await injectOverlay(dbB, [[10, null]]);
			await iso.alterTable(dbA, 'main', 't', addNotNullCol('c'));
			const poisonMsg = overlayState(dbB)!.poison!.message;
			const staleOverlay = overlayState(dbB)!.overlayTable;

			// B, already poisoned, issues its OWN ALTER on the same table (e.g. mid-transaction,
			// before rolling back). A literal-default column backfills cleanly, so WITHOUT the
			// poison skip B's stale overlay would pass validation and migrate — rebuilding a
			// layout-mismatched overlay (its rows are a column short of the now-altered base)
			// AND dropping the poison, silently un-poisoning a connection that must still roll back.
			const updated = await iso.alterTable(dbB, 'main', 't', addBackfillableCol('d'));
			expect(updated.columns.some(col => col.name === 'd'), "B's ALTER still applies to the shared base").to.equal(true);

			const bState = overlayState(dbB)!;
			expect(bState.poison, 'B stays poisoned across its own ALTER').to.not.be.undefined;
			expect(bState.poison!.message, 'poison message unchanged — overlay never rebuilt').to.equal(poisonMsg);
			expect(bState.overlayTable, 'overlay object left untouched, not migrated').to.equal(staleOverlay);
		});

		it('DROP INDEX on the table neither migrates nor un-poisons a poisoned overlay', async () => {
			await dbA.exec('create index t_idx on t(x)');
			await injectOverlay(dbB, [[10, null]]);
			await iso.alterTable(dbA, 'main', 't', addNotNullCol('c'));
			const poisonMsg = overlayState(dbB)!.poison!.message;
			const staleOverlay = overlayState(dbB)!.overlayTable;

			// dropIndex adopts the change into every non-poisoned overlay. A poisoned overlay holds
			// rows in the narrower pre-alter layout and its owner must roll back regardless, so it
			// is skipped entirely rather than mutated — and its poison message stays the original.
			await iso.dropIndex(dbA, 'main', 't', 't_idx');

			const bState = overlayState(dbB)!;
			expect(bState.poison, 'poison survives an unrelated DROP INDEX').to.not.be.undefined;
			expect(bState.poison!.message).to.equal(poisonMsg);
			expect(bState.overlayTable, 'poisoned overlay left untouched').to.equal(staleOverlay);
			expect(
				bState.overlayTable.tableSchema!.indexes?.some(i => i.name === 't_idx'),
				'the skipped overlay still carries the dropped index',
			).to.equal(true);
		});

		// ── ALTER COLUMN … SET NOT NULL over staged overlay rows. Same tier structure as the
		// addColumn NOT-NULL path: the issuer's own un-backfillable overlay aborts atomically,
		// a foreign one with no usable DEFAULT is poisoned, and one with a usable DEFAULT is
		// backfilled forward. The committed baseline row (5, 5) is non-null, so the underlying's
		// own scan always passes — only staged overlay NULLs drive the outcome.

		/** Tighten the (nullable) `x` column to NOT NULL. */
		function setNotNullX(): SchemaChangeInfo {
			return { type: 'alterColumn', columnName: 'x', setNotNull: true };
		}

		/** notNull flag of `x` on the live underlying manager schema — see {@link liveSchema}. */
		function underlyingXNotNull(): boolean {
			return liveSchema(iso.getUnderlyingState('main', 't')!.underlyingTable).columns.find(c => c.name === 'x')?.notNull ?? false;
		}

		it('SET NOT NULL applies and poisons a foreign overlay whose staged NULL cannot backfill', async () => {
			await injectOverlay(dbB, [[10, null]]); // B stages a NULL at x; no usable DEFAULT

			const updated = await iso.alterTable(dbA, 'main', 't', setNotNullX());

			// The ALTER applied: x is NOT NULL in the returned schema and on the live underlying.
			expect(updated.columns.find(c => c.name === 'x')?.notNull, 'returned schema tightened x').to.equal(true);
			expect(underlyingXNotNull(), 'underlying x tightened').to.equal(true);

			// B's overlay is poisoned (left in place, not migrated), with a self-explanatory message.
			const bState = overlayState(dbB)!;
			expect(bState.poison, 'B overlay must be poisoned').to.not.be.undefined;
			expect(bState.poison!.message).to.match(/NOT NULL/i);
			expect(bState.poison!.message).to.match(/roll back this transaction/i);
		});

		it('SET NOT NULL rejects atomically when the issuer-own overlay holds an un-backfillable NULL', async () => {
			await injectOverlay(dbA, [[1, null]]); // A itself stages the un-backfillable NULL

			let err: unknown;
			try { await iso.alterTable(dbA, 'main', 't', setNotNullX()); } catch (e) { err = e; }
			expect(err, 'issuer-own un-backfillable overlay must abort the ALTER').to.be.instanceOf(QuereusError);
			expect((err as QuereusError).code).to.equal(StatusCode.CONSTRAINT);

			// Atomic: the shared underlying is untouched (x still nullable), and A's overlay is
			// rejected up front, never poisoned.
			expect(underlyingXNotNull(), 'underlying untouched after atomic rejection').to.equal(false);
			const aState = overlayState(dbA)!;
			expect(aState.poison, 'issuer-own overlay is rejected, never poisoned').to.be.undefined;
			expect(aState.hasChanges).to.equal(true);
		});

		it('SET NOT NULL backfills a foreign overlay\'s staged NULL when a literal DEFAULT exists', async () => {
			// Give x a literal DEFAULT first, so the tightening backfills the staged NULL instead
			// of rejecting it. The overlay is injected AFTER, so its schema carries the DEFAULT.
			await iso.alterTable(dbA, 'main', 't', { type: 'alterColumn', columnName: 'x', setDefault: { type: 'literal', value: 0 } });
			await injectOverlay(dbB, [[10, null]]); // B stages a NULL at x

			const before = overlayState(dbB)!.overlayTable;
			const updated = await iso.alterTable(dbA, 'main', 't', setNotNullX());
			expect(updated.columns.find(c => c.name === 'x')?.notNull, 'x tightened').to.equal(true);

			// B's overlay is backfilled IN PLACE (NOT poisoned, not rebuilt).
			const bState = overlayState(dbB)!;
			expect(bState.poison, 'foreign overlay with a usable DEFAULT is backfilled, not poisoned').to.be.undefined;
			expect(bState.overlayTable, 'overlay adopted in place, not rebuilt').to.equal(before);
			const bRows = await asyncIterableToArray(bState.overlayTable.query!(fullScan()));
			expect(bRows.map(r => [r[0], r[1]]), 'staged NULL backfilled to the DEFAULT').to.deep.equal([[10, 0]]);
		});

		it('a backfilling SET NOT NULL leaves a tombstone\'s placeholder NULL alone', async () => {
			// A tombstone carries its primary key and NULL everywhere else — those NULLs are
			// placeholders, not values. Backfilling one from the DEFAULT (or rejecting it when
			// no DEFAULT exists) would corrupt a row that is not a row; only LIVE staged NULLs
			// are filled.
			await iso.alterTable(dbA, 'main', 't', { type: 'alterColumn', columnName: 'x', setDefault: { type: 'literal', value: 0 } });
			const underlying = iso.getUnderlyingState('main', 't')!.underlyingTable;
			const overlay = await iso.overlayModule.create(dbB, iso.createOverlaySchema(underlying.tableSchema!));
			await overlay.update({ operation: 'insert', values: [10, null, 0] }); // live staged NULL
			await overlay.update({ operation: 'insert', values: [11, null, 1] }); // tombstone of committed row 11
			iso.setConnectionOverlay(dbB, 'main', 't', { overlayTable: overlay, hasChanges: true, db: dbB });

			await iso.alterTable(dbA, 'main', 't', setNotNullX());

			const bState = overlayState(dbB)!;
			expect(bState.poison, 'tombstone NULL must not reject the tightening').to.be.undefined;
			const bRows = await asyncIterableToArray(bState.overlayTable.query!(fullScan()));
			const byId = new Map(bRows.map(r => [r[0], r]));
			expect(byId.get(10)![1], 'live staged NULL backfilled').to.equal(0);
			expect(byId.get(10)![2], 'live flag intact').to.equal(0);
			expect(byId.get(11)![1], 'tombstone keeps its placeholder NULL, not the DEFAULT').to.equal(null);
			expect(byId.get(11)![2], 'tombstone flag intact').to.equal(1);
		});

		// ── ADD CONSTRAINT … UNIQUE over staged overlay rows. The constraint lands on each
		// overlay as a tombstone-narrowed unique index (the AST constraint has no predicate
		// field, so a bare forward would judge deletion markers as rows).

		/** `alter table t add constraint u_x unique (x)`, as the module receives it. */
		function addUniqueX(): SchemaChangeInfo {
			return { type: 'addConstraint', constraint: { type: 'unique', name: 'u_x', columns: [{ name: 'x' }] } };
		}

		it('ADD CONSTRAINT UNIQUE forwards a foreign overlay IN PLACE as a tombstone-narrowed unique index', async () => {
			await injectOverlay(dbB, [[10, 7], [11, 8]]); // distinct on x — healthy
			const before = overlayState(dbB)!.overlayTable;

			const updated = await iso.alterTable(dbA, 'main', 't', addUniqueX());
			expect(updated.uniqueConstraints?.some(uc => uc.name === 'u_x'), 'underlying gained the constraint').to.equal(true);

			const bState = overlayState(dbB)!;
			expect(bState.poison, 'B stays healthy').to.be.undefined;
			expect(bState.overlayTable, 'overlay adopted in place, not rebuilt').to.equal(before);

			// The overlay carries the index AND the UNIQUE derived from it, both named u_x and
			// both narrowed to live rows — so drop/rename forwards resolve the same object.
			const overlaySchema = bState.overlayTable.tableSchema!;
			const idx = overlaySchema.indexes?.find(i => i.name === 'u_x');
			expect(idx, 'overlay carries the covering index').to.not.be.undefined;
			expect(idx!.predicate, 'index predicate narrowed (tombstone flag = 0)').to.not.be.undefined;
			const uc = overlaySchema.uniqueConstraints?.find(c => c.name === 'u_x');
			expect(uc, 'overlay carries the derived UNIQUE').to.not.be.undefined;
			expect(uc!.predicate, 'constraint predicate narrowed too').to.not.be.undefined;

			// And it ENFORCES for the rest of B's transaction: another x = 7 is rejected.
			const dup: UpdateResult = await bState.overlayTable.update({ operation: 'insert', values: [12, 7, 0], preCoerced: true });
			expect(dup.status, 'staged duplicate rejected by the overlay').to.equal('constraint');
		});

		it('ADD CONSTRAINT UNIQUE poisons a foreign overlay whose staged rows violate it', async () => {
			await injectOverlay(dbB, [[10, 7], [11, 7]]); // B stages two rows colliding on x

			const updated = await iso.alterTable(dbA, 'main', 't', addUniqueX());

			// The issuer's ALTER applied — a foreign connection's uncommitted rows must not abort it.
			expect(updated.uniqueConstraints?.some(uc => uc.name === 'u_x'), 'underlying gained the constraint').to.equal(true);

			const bState = overlayState(dbB)!;
			expect(bState.poison, 'B overlay must be poisoned').to.not.be.undefined;
			expect(bState.poison!.message).to.match(/roll back this transaction/i);
			// Both staged rows kept — nothing was silently truncated on the way to the poison.
			const bRows = await asyncIterableToArray(bState.overlayTable.query!(fullScan()));
			expect(bRows.map(r => r[0]), 'no staged row was dropped').to.deep.equal([10, 11]);
		});

		it('ADD CONSTRAINT UNIQUE over a primary-key member ignores a foreign overlay\'s tombstones', async () => {
			// Compound PK so a PK member can carry a duplicated value across two tombstones:
			// two staged deletions share a = 1, and each tombstone carries its full PK. A bare
			// UNIQUE(a) forward would see them as duplicates of each other.
			await dbA.exec('create table tc (a integer, b integer, primary key (a, b)) using isolated');
			const underlyingC = iso.getUnderlyingState('main', 'tc')!.underlyingTable;
			const overlayC = await iso.overlayModule.create(dbB, iso.createOverlaySchema(underlyingC.tableSchema!));
			await overlayC.update({ operation: 'insert', values: [1, 1, 1] }); // tombstone (a=1, b=1)
			await overlayC.update({ operation: 'insert', values: [1, 2, 1] }); // tombstone (a=1, b=2)
			iso.setConnectionOverlay(dbB, 'main', 'tc', { overlayTable: overlayC, hasChanges: true, db: dbB });
			const before = iso.getConnectionOverlay(dbB, 'main', 'tc')!.overlayTable;

			const updated = await iso.alterTable(dbA, 'main', 'tc', {
				type: 'addConstraint',
				constraint: { type: 'unique', name: 'u_a', columns: [{ name: 'a' }] },
			});
			expect(updated.uniqueConstraints?.some(uc => uc.name === 'u_a')).to.equal(true);

			const cState = iso.getConnectionOverlay(dbB, 'main', 'tc')!;
			expect(cState.poison, 'two deletion markers are not duplicates — no poison').to.be.undefined;
			expect(cState.overlayTable, 'overlay adopted in place').to.equal(before);
		});
	});

	describe('capability forwarding', () => {
		// IsolationModule is a transparent wrapper: optional capability hooks that
		// decomposition/lens (and the planner) consult must reach the underlying
		// module. A missing forward is a silent-degradation footgun — e.g. a dropped
		// getMappingAdvertisements silently disables tag-derived decomposition under
		// isolation. These tests pin the forwards so a future hook is not forgotten.

		it('forwards getMappingAdvertisements to the underlying module', () => {
			const sentinel = [{ decompositionId: 'quereus.lens.decomp.test' }] as any;
			let received: { db: unknown; basis: unknown } | undefined;
			const underlying = {
				...new MemoryTableModule(),
				getMappingAdvertisements(callDb: unknown, basisSchema: unknown) {
					received = { db: callDb, basis: basisSchema };
					return sentinel;
				},
			} as any;
			const isolatedModule = new IsolationModule({ underlying });

			const basis = { name: 'main' } as any;
			const result = isolatedModule.getMappingAdvertisements(db, basis);

			expect(result).to.equal(sentinel);
			expect(received?.db).to.equal(db);
			expect(received?.basis).to.equal(basis);
		});

		it('returns [] when the underlying module does not implement the hook', () => {
			// The optional-call fallback (`?. ... ?? []`) must yield an empty list
			// rather than undefined when the underlying module omits the hook.
			const underlying = { ...new MemoryTableModule(), getMappingAdvertisements: undefined } as any;
			const isolatedModule = new IsolationModule({ underlying });
			const result = isolatedModule.getMappingAdvertisements(db, { name: 'main' } as any);
			expect(result).to.deep.equal([]);
		});

		it('forwards beginSchemaBatch/endSchemaBatch to the underlying module', async () => {
			// APPLY SCHEMA fires these hooks on the registered module (the wrapper
			// when isolated). A batching-capable underlying must receive begin/end so
			// it can fold the migration into a single substrate commit. A missing
			// forward silently degrades to per-DDL commits.
			const beginCalls: { schemaName: string }[] = [];
			const endCalls: { schemaName: string; error?: unknown }[] = [];
			const underlying = {
				...new MemoryTableModule(),
				async beginSchemaBatch(_callDb: unknown, schemaName: string) {
					beginCalls.push({ schemaName });
				},
				async endSchemaBatch(_callDb: unknown, schemaName: string, error?: unknown) {
					endCalls.push({ schemaName, error });
				},
			} as any;
			const isolatedModule = new IsolationModule({ underlying });

			await isolatedModule.beginSchemaBatch(db, 'main');
			await isolatedModule.endSchemaBatch(db, 'main', undefined);

			expect(beginCalls).to.deep.equal([{ schemaName: 'main' }]);
			expect(endCalls).to.deep.equal([{ schemaName: 'main', error: undefined }]);
		});

		it('endSchemaBatch forwards the loop error to the underlying', async () => {
			const endCalls: { error?: unknown }[] = [];
			const sentinelError = new Error('migration failed');
			const underlying = {
				...new MemoryTableModule(),
				async endSchemaBatch(_callDb: unknown, _schemaName: string, error?: unknown) {
					endCalls.push({ error });
				},
			} as any;
			const isolatedModule = new IsolationModule({ underlying });

			await isolatedModule.endSchemaBatch(db, 'main', sentinelError);
			expect(endCalls).to.deep.equal([{ error: sentinelError }]);
		});

		it('no-ops when the underlying module does not implement the batch hooks', async () => {
			// The optional-call (`?.`) must not throw when the underlying omits the
			// hooks — APPLY SCHEMA's loop guard would otherwise never reach here, but
			// the wrapper must remain safe to invoke directly.
			const underlying = {
				...new MemoryTableModule(),
				beginSchemaBatch: undefined,
				endSchemaBatch: undefined,
			} as any;
			const isolatedModule = new IsolationModule({ underlying });

			await isolatedModule.beginSchemaBatch(db, 'main');
			await isolatedModule.endSchemaBatch(db, 'main');
			// reaching here without throwing is the assertion
		});

		it('forwards notifyLensDeployment to the underlying module', async () => {
			// A logical APPLY SCHEMA fires `notifyLensDeployment` on the registered
			// module (the wrapper when a basis is isolated). The deployed snapshot is
			// isolation-transparent, so it must reach the underlying — a missing
			// forward silently strands a basis-backing module's reconcile.
			const calls: { schemaName: string; snapshot: unknown }[] = [];
			const underlying = {
				...new MemoryTableModule(),
				async notifyLensDeployment(_callDb: unknown, schemaName: string, snapshot: unknown) {
					calls.push({ schemaName, snapshot });
				},
			} as any;
			const isolatedModule = new IsolationModule({ underlying });

			const sentinel = { basisSchemaName: 'y', basisHash: 'h', tables: new Map() } as any;
			await isolatedModule.notifyLensDeployment(db, 'x', sentinel);

			expect(calls).to.have.lengthOf(1);
			expect(calls[0].schemaName).to.equal('x');
			expect(calls[0].snapshot).to.equal(sentinel);
		});

		it('notifyLensDeployment no-ops when the underlying omits the hook', async () => {
			const underlying = { ...new MemoryTableModule(), notifyLensDeployment: undefined } as any;
			const isolatedModule = new IsolationModule({ underlying });
			const sentinel = { basisSchemaName: 'y', basisHash: 'h', tables: new Map() } as any;
			await isolatedModule.notifyLensDeployment(db, 'x', sentinel);
			// reaching here without throwing is the assertion
		});

		it('reaches the underlying through a real APPLY SCHEMA under isolation', async () => {
			// End-to-end floor: register the wrapper as a real module, run an actual
			// `apply schema`, and prove (a) APPLY SCHEMA's registered-module loop
			// reaches the IsolationModule wrapper, and (b) the underlying observes an
			// active batch when its `create` callbacks fire during the loop. The
			// direct-call unit tests above prove the forward in isolation; this proves
			// the wiring the forward exists for.
			let batchActive = false;
			const beginCalls: string[] = [];
			const endCalls: { schemaName: string; error?: unknown }[] = [];
			const createsDuringBatch: { table: string; active: boolean }[] = [];
			class RecordingModule extends MemoryTableModule {
				async beginSchemaBatch(_callDb: unknown, schemaName: string) {
					beginCalls.push(schemaName);
					batchActive = true;
				}
				async endSchemaBatch(_callDb: unknown, schemaName: string, error?: unknown) {
					endCalls.push({ schemaName, error });
					batchActive = false;
				}
				override async create(callDb: any, tableSchema: any) {
					createsDuringBatch.push({ table: tableSchema.name, active: batchActive });
					return super.create(callDb, tableSchema);
				}
			}
			const isolatedModule = new IsolationModule({ underlying: new RecordingModule() });
			db.registerModule('isolated', isolatedModule);
			db.setDefaultVtabName('isolated');

			await db.exec(`
				declare schema main {
					table t1 (
						id integer primary key
					)
					table t2 (
						id integer primary key
					)
				}
			`);
			await db.exec('apply schema main;');

			// Exactly one begin/end pair reached the underlying via the wrapper.
			expect(beginCalls).to.deep.equal(['main']);
			expect(endCalls).to.deep.equal([{ schemaName: 'main', error: undefined }]);
			// Both table creates ran while the batch was open (single-commit window).
			expect(createsDuringBatch).to.deep.equal([
				{ table: 't1', active: true },
				{ table: 't2', active: true },
			]);
			// Batch closed after the loop.
			expect(batchActive).to.be.false;
		});

		it('forwards getCapabilities while layering isolation guarantees', () => {
			const underlying = {
				...new MemoryTableModule(),
				getCapabilities() {
					return { supportsPushDown: true } as any;
				},
			} as any;
			const isolatedModule = new IsolationModule({ underlying });

			const caps = isolatedModule.getCapabilities() as any;
			expect(caps.supportsPushDown).to.be.true; // underlying capability preserved
			expect(caps.isolation).to.be.true; // isolation guarantee layered on
			expect(caps.savepoints).to.be.true;
		});

		it('mirrors createBacking presence — defined iff the underlying declares it', () => {
			// `SchemaManager.createBackingTable` does `createBacking?() ?? create()`,
			// so PRESENCE is the capability. The forward must be present iff the
			// underlying declares it — exactly like getBackingHost, with which it must
			// travel (one routes the MV backing into the durable store, the other
			// resolves its host).
			const withHook = new IsolationModule({ underlying: new (class extends MemoryTableModule {
				async createBacking(callDb: any, tableSchema: any) { return super.create(callDb, tableSchema); }
			})() });
			expect(withHook.createBacking, 'present when underlying declares it').to.be.a('function');

			const withoutHook = new IsolationModule({ underlying: { ...new MemoryTableModule(), createBacking: undefined } as any });
			expect(withoutHook.createBacking, 'absent when underlying omits it').to.be.undefined;
		});

		it('routes MV backing creation through the underlying createBacking under isolation', async () => {
			// End-to-end floor: register the wrapper as a real module and run an actual
			// CREATE MATERIALIZED VIEW. createBackingTable must prefer the (forwarded)
			// createBacking over create, and the (forwarded) getBackingHost must then
			// resolve a real host so the fill (replaceContents) succeeds. A missing
			// createBacking forward would silently fall back to the wrapper's generic
			// create — an ordinary table the forwarded getBackingHost can't back.
			const calls: string[] = [];
			class BackingModule extends MemoryTableModule {
				async createBacking(callDb: any, tableSchema: any) {
					calls.push('createBacking');
					return super.create(callDb, tableSchema);
				}
				override async create(callDb: any, tableSchema: any) {
					calls.push('create');
					return super.create(callDb, tableSchema);
				}
			}
			const isolatedModule = new IsolationModule({ underlying: new BackingModule() });
			db.registerModule('isolated', isolatedModule);

			await db.exec('create table src (id integer primary key, v text) using isolated');
			await db.exec("insert into src values (1, 'a')");
			calls.length = 0; // clear setup creates

			await db.exec('create materialized view mv using isolated as select id, v from src');

			expect(calls).to.include('createBacking');
			expect(calls).to.not.include('create');
		});
	});
});

// ===========================================================================
// concurrencyMode / expectedLatencyMs forwarding + ensureConnection reentrancy
//
// IsolationModule forwards the underlying module's plan-level hints so a host
// wrapping a reentrant module (e.g. Lamina over a Memory overlay) keeps the
// `concurrencySafe` / `expectedLatencyMs` it would get registering the
// underlying directly. The forward is safe because the one lazy-init race in
// the merged-overlay read path (`IsolatedTable.ensureConnection`) is hardened
// with an in-flight memo.
// ===========================================================================
describe('IsolationModule concurrency + latency forwarding', () => {
	/**
	 * Minimal module stub exposing only the two forwarded hints. The forwarding
	 * getters read just `concurrencyMode` / `expectedLatencyMs`; no create/connect
	 * is exercised for the getter-level assertions.
	 */
	function modeStub(concurrencyMode?: VtabConcurrencyMode, expectedLatencyMs?: number): VirtualTableModule<any, any> {
		const m: Record<string, unknown> = {};
		if (concurrencyMode !== undefined) m.concurrencyMode = concurrencyMode;
		if (expectedLatencyMs !== undefined) m.expectedLatencyMs = expectedLatencyMs;
		return m as unknown as VirtualTableModule<any, any>;
	}

	/** Functional memory module declaring a non-zero latency hint
	 *  (reentrant-reads inherited from MemoryTableModule). */
	class HighLatencyMemoryModule extends MemoryTableModule {
		readonly expectedLatencyMs = 25;
	}

	describe('forwarding (getter-level)', () => {
		it('serial underlying degrades the wrapper to serial', () => {
			const iso = new IsolationModule({ underlying: modeStub('serial'), overlay: modeStub('reentrant-reads') });
			expect(getModuleConcurrencyMode(iso)).to.equal('serial');
			expect(iso.concurrencyMode).to.equal('serial');
		});

		it('reentrant underlying + default Memory overlay → reentrant-reads', () => {
			// overlay omitted → defaults to MemoryTableModule (reentrant-reads).
			const iso = new IsolationModule({ underlying: modeStub('reentrant-reads') });
			expect(getModuleConcurrencyMode(iso)).to.equal('reentrant-reads');
		});

		it('reentrant underlying + serial custom overlay → serial (weakest-of)', () => {
			const iso = new IsolationModule({ underlying: modeStub('reentrant-reads'), overlay: modeStub('serial') });
			expect(getModuleConcurrencyMode(iso)).to.equal('serial');
		});

		it('fully-reentrant underlying + fully-reentrant overlay clamps to reentrant-reads', () => {
			const iso = new IsolationModule({ underlying: modeStub('fully-reentrant'), overlay: modeStub('fully-reentrant') });
			// IsolationModule's own write path is never reentrant → cap applies.
			expect(iso.concurrencyMode).to.equal('reentrant-reads');
		});

		it('absent concurrencyMode on both sides → serial', () => {
			const iso = new IsolationModule({ underlying: modeStub(undefined), overlay: modeStub(undefined) });
			expect(getModuleConcurrencyMode(iso)).to.equal('serial');
		});

		it('expectedLatencyMs absent on underlying → 0 (no hint)', () => {
			const iso = new IsolationModule({ underlying: modeStub('reentrant-reads') });
			expect(iso.expectedLatencyMs).to.equal(0);
		});

		it('expectedLatencyMs forwarded from underlying (25)', () => {
			const iso = new IsolationModule({ underlying: modeStub('reentrant-reads', 25) });
			expect(iso.expectedLatencyMs).to.equal(25);
		});

		it('expectedLatencyMs comes from the underlying, never the overlay', () => {
			const iso = new IsolationModule({ underlying: modeStub('reentrant-reads', 25), overlay: modeStub('reentrant-reads', 999) });
			expect(iso.expectedLatencyMs).to.equal(25);
		});
	});

	// `readCommittedSnapshot` is a module's promise that a `_readCommitted`
	// connection serves a stable committed snapshot for the life of the scan. The
	// wrapper MIRRORS the underlying: a `_readCommitted` connect opens its own
	// dedicated underlying handle (never the memoized writer handle) and the read
	// bypasses the overlay entirely, so the wrapper adds no tearing window of its
	// own. It still cannot promise more than the underlying delivers — an underlying
	// that ignores `_readCommitted` (the store stack) hands back a handle
	// indistinguishable from the writer's.
	describe('readCommittedSnapshot', () => {
		/** Module stub declaring (or omitting) only `readCommittedSnapshot`. */
		function snapshotStub(readCommittedSnapshot?: boolean): VirtualTableModule<any, any> {
			const m: Record<string, unknown> = {};
			if (readCommittedSnapshot !== undefined) m.readCommittedSnapshot = readCommittedSnapshot;
			return m as unknown as VirtualTableModule<any, any>;
		}

		/** Live connection count on the memory manager backing `<schema>.<table>`. */
		function managerConnectionCount(memory: MemoryTableModule, schemaName: string, tableName: string): number {
			const manager = memory.tables.get(`${schemaName}.${tableName}`.toLowerCase())!;
			return (manager as unknown as { connections: Map<number, unknown> }).connections.size;
		}

		it('mirrors a snapshot-safe underlying', () => {
			const iso = new IsolationModule({ underlying: new MemoryTableModule() });
			expect(iso.readCommittedSnapshot).to.equal(true);
			expect(getModuleReadCommittedSnapshot(iso)).to.equal(true);

			// The overlay does NOT enter the expression — committed reads bypass it — but a
			// snapshot-safe overlay must not change the answer either.
			const stubbed = new IsolationModule({ underlying: snapshotStub(true), overlay: snapshotStub(true) });
			expect(getModuleReadCommittedSnapshot(stubbed)).to.equal(true);
		});

		it('is false over an underlying that omits or declines the flag', () => {
			expect(getModuleReadCommittedSnapshot(new IsolationModule({ underlying: snapshotStub() }))).to.equal(false);
			expect(getModuleReadCommittedSnapshot(new IsolationModule({ underlying: snapshotStub(false) }))).to.equal(false);
		});

		// Regression guard for `bug-isolation-committed-read-shares-writer-handle`.
		// `commitConnectionOverlays` applies staged rows into the underlying (Phase 1:
		// begin + row-by-row) and only commits afterwards (Phase 2). A committed read
		// that delegated to that SAME memoized handle saw the batch half-applied (3
		// rows). With its own `_readCommitted` handle it sees the committed layer only.
		it('a committed read runs on its own handle, so a mid-flush read does not tear', async () => {
			const db = new Database();
			const mod = new IsolationModule({ underlying: new MemoryTableModule() });
			db.registerModule('iso_snap', mod);
			await db.exec('CREATE TABLE snap_tear (id INTEGER PRIMARY KEY, v TEXT) USING iso_snap');
			await db.exec(`INSERT INTO snap_tear VALUES (1, 'a'), (2, 'b')`);

			const reader = await mod.connect(db, undefined, 'iso_snap', 'main', 'snap_tear', { _readCommitted: true } as never);

			// Stand in for Phase 1 of an overlay flush: rows applied, not yet committed.
			const underlying = mod.getUnderlyingState('main', 'snap_tear')!.underlyingTable;
			await underlying.begin?.();
			await underlying.update!({ operation: 'insert', values: [3, 'mid-flush'] });

			const rows = await asyncIterableToArray(reader.query!(makeFullScanFilterInfo()));

			await underlying.rollback?.();
			await reader.disconnect();
			await db.close();

			expect(rows.length, 'the committed read sees the pre-flush committed row set').to.equal(2);
		});

		it('a committed connect neither returns nor installs the memoized writer handle', async () => {
			const db = new Database();
			const mod = new IsolationModule({ underlying: new MemoryTableModule() });
			db.registerModule('iso_handle', mod);
			await db.exec('CREATE TABLE h (id INTEGER PRIMARY KEY, v TEXT) USING iso_handle');
			await db.exec(`INSERT INTO h VALUES (1, 'a')`);

			const writerHandle = mod.getUnderlyingState('main', 'h')!.underlyingTable;
			const reader = await mod.connect(db, undefined, 'iso_handle', 'main', 'h', { _readCommitted: true } as never);

			expect((reader as unknown as { underlyingTable: VirtualTable }).underlyingTable,
				'committed read must not share the writer handle').to.not.equal(writerHandle);
			expect(mod.getUnderlyingState('main', 'h')!.underlyingTable,
				'the memo must be left pointing at the writer handle').to.equal(writerHandle);

			await reader.disconnect();
			await db.close();
		});

		// Arm 2 of the bug: a committed read arriving as the FIRST connect for a table used
		// to memoize a `_readCommitted` underlying, which every later reader AND writer then
		// got back — and a committed-snapshot memory table throws `Cannot modify
		// committed-state snapshot` on `update()`. The committed path no longer reads or
		// writes the memo, so the memo stays empty and the later write connects its own
		// writable handle. The rename round-trip is what evicts the memo installed by CREATE.
		it('a committed read as the first access leaves the memo empty and does not poison later writes', async () => {
			const db = new Database();
			const mod = new IsolationModule({ underlying: new MemoryTableModule() });
			db.registerModule('iso_first', mod);
			await db.exec('CREATE TABLE fa (id INTEGER PRIMARY KEY, v TEXT) USING iso_first');
			await db.exec(`INSERT INTO fa VALUES (1, 'a')`);

			await db.exec('ALTER TABLE fa RENAME TO fa2');
			await db.exec('ALTER TABLE fa2 RENAME TO fa');
			expect(mod.getUnderlyingState('main', 'fa'), 'rename must have evicted the memo').to.equal(undefined);

			const reader = await mod.connect(db, undefined, 'iso_first', 'main', 'fa', { _readCommitted: true } as never);
			expect(await asyncIterableToArray(reader.query!(makeFullScanFilterInfo()))).to.have.length(1);
			expect(mod.getUnderlyingState('main', 'fa'), 'a committed connect must not install a memo').to.equal(undefined);
			await reader.disconnect();

			// The write path must get a writable handle, not the committed snapshot.
			await db.exec(`INSERT INTO fa VALUES (2, 'b')`);
			const rows = await asyncIterableToArray(db.eval('select id from fa order by id'));
			expect(rows.map(r => r.id)).to.deep.equal([1, 2]);

			await db.close();
		});

		it('disconnect releases the committed handle back to the memory manager', async () => {
			const db = new Database();
			const memory = new MemoryTableModule();
			const mod = new IsolationModule({ underlying: memory });
			db.registerModule('iso_release', mod);
			await db.exec('CREATE TABLE rel (id INTEGER PRIMARY KEY, v TEXT) USING iso_release');
			await db.exec(`INSERT INTO rel VALUES (1, 'a')`);

			const before = managerConnectionCount(memory, 'main', 'rel');

			const reader = await mod.connect(db, undefined, 'iso_release', 'main', 'rel', { _readCommitted: true } as never);
			// The manager connection (and its pinned read layer) is created at the first pull.
			await asyncIterableToArray(reader.query!(makeFullScanFilterInfo()));
			expect(managerConnectionCount(memory, 'main', 'rel'),
				'the committed scan pins a manager connection').to.equal(before + 1);

			await reader.disconnect();
			expect(managerConnectionCount(memory, 'main', 'rel'),
				'disconnect must release the pinned layer').to.equal(before);

			await db.close();
		});

		// The other half of the disconnect rule, and the one nothing else pins: a WRITER
		// instance must leave the memoized handle alone. Every scan connects a fresh
		// IsolatedTable and the engine disconnects it at statement teardown, so a
		// disconnect that forgot to check `readCommitted` would release the shared handle
		// out from under every other connection on the table.
		it('a writer instance disconnect leaves the shared underlying handle alone', async () => {
			const db = new Database();
			const mod = new IsolationModule({ underlying: new MemoryTableModule() });
			db.registerModule('iso_keep', mod);
			await db.exec('CREATE TABLE keep (id INTEGER PRIMARY KEY, v TEXT) USING iso_keep');

			const shared = mod.getUnderlyingState('main', 'keep')!.underlyingTable;
			let sharedDisconnects = 0;
			const realDisconnect = shared.disconnect.bind(shared);
			(shared as { disconnect: () => Promise<void> }).disconnect = async () => {
				sharedDisconnects++;
				await realDisconnect();
			};

			const writer = await mod.connect(db, undefined, 'iso_keep', 'main', 'keep', {} as never);
			await writer.disconnect();
			expect(sharedDisconnects, 'a writer must not disconnect the shared handle').to.equal(0);

			// A committed reader disconnects its OWN handle — never this one.
			const reader = await mod.connect(db, undefined, 'iso_keep', 'main', 'keep', { _readCommitted: true } as never);
			await reader.disconnect();
			expect(sharedDisconnects, 'a committed read must not disconnect the shared handle either').to.equal(0);

			await db.close();
		});

		// Store-shaped underlying: `StoreModule.connect` re-serves ONE cached table per key
		// whatever the options, so the wrapper's "dedicated" committed handle is the writer's
		// object. Two things must hold in that shape — the mirror stays `false` (the wrapper
		// must not claim safety the underlying cannot deliver), and `disconnect` still lands
		// exactly once on that shared object, which is only safe because `VirtualTable.disconnect`
		// is contracted per-statement rather than as a teardown.
		it('over an underlying that re-serves one cached handle, the mirror stays false and disconnect lands once', async () => {
			const memory = new MemoryTableModule();
			const served = new Map<string, VirtualTable>();
			let disconnects = 0;
			const countDisconnects = (table: VirtualTable): VirtualTable => {
				const realDisconnect = table.disconnect.bind(table);
				(table as { disconnect: () => Promise<void> }).disconnect = async () => {
					disconnects++;
					await realDisconnect();
				};
				return table;
			};
			const shared = Object.create(memory) as MemoryTableModule;
			Object.defineProperty(shared, 'readCommittedSnapshot', { value: false });
			// `create` seeds the same per-key cache `connect` re-serves from — the store shape,
			// where CREATE TABLE is what first populates `StoreModule.tables`.
			Object.defineProperty(shared, 'create', {
				value: async (...args: Parameters<MemoryTableModule['create']>): Promise<VirtualTable> => {
					const table = countDisconnects(await memory.create(...args));
					served.set(`${args[1].schemaName}.${args[1].name}`.toLowerCase(), table);
					return table;
				},
			});
			Object.defineProperty(shared, 'connect', {
				value: async (...args: Parameters<MemoryTableModule['connect']>): Promise<VirtualTable> => {
					const key = `${args[3]}.${args[4]}`.toLowerCase();
					const existing = served.get(key);
					if (existing) return existing;
					const table = countDisconnects(await memory.connect(...args));
					served.set(key, table);
					return table;
				},
			});

			const db = new Database();
			const mod = new IsolationModule({ underlying: shared });
			db.registerModule('iso_shared', mod);
			await db.exec('CREATE TABLE sh (id INTEGER PRIMARY KEY, v TEXT) USING iso_shared');
			await db.exec(`INSERT INTO sh VALUES (1, 'a')`);

			expect(getModuleReadCommittedSnapshot(mod),
				'an underlying that cannot honour _readCommitted must not be mirrored as safe').to.equal(false);

			const writerHandle = mod.getUnderlyingState('main', 'sh')!.underlyingTable;
			const reader = await mod.connect(db, undefined, 'iso_shared', 'main', 'sh', { _readCommitted: true } as never);
			expect((reader as unknown as { underlyingTable: VirtualTable }).underlyingTable,
				'the store shape hands back the writer object — documented, not a defect').to.equal(writerHandle);
			expect(await asyncIterableToArray(reader.query!(makeFullScanFilterInfo()))).to.have.length(1);

			await reader.disconnect();
			expect(disconnects, 'one connect, one disconnect — never doubled').to.equal(1);

			// The shared handle is still usable afterwards: disconnect is per-statement.
			await db.exec(`INSERT INTO sh VALUES (2, 'b')`);
			const rows = await asyncIterableToArray(db.eval('select id from sh order by id'));
			expect(rows.map(r => r.id)).to.deep.equal([1, 2]);

			await db.close();
		});

		it('createConnection is refused on a committed-snapshot instance', async () => {
			const db = new Database();
			const mod = new IsolationModule({ underlying: new MemoryTableModule() });
			db.registerModule('iso_conn', mod);
			await db.exec('CREATE TABLE cc (id INTEGER PRIMARY KEY, v TEXT) USING iso_conn');

			const reader = await mod.connect(db, undefined, 'iso_conn', 'main', 'cc', { _readCommitted: true } as never);
			expect(() => reader.createConnection()).to.throw(QuereusError, /must not join the writer/);

			// The normal (writer) path is unaffected.
			const writer = await mod.connect(db, undefined, 'iso_conn', 'main', 'cc', {} as never);
			expect(() => writer.createConnection()).to.not.throw();

			await reader.disconnect();
			await db.close();
		});

		// NOTE: this case is NOT the regression guard for the shared-handle tear — the tear
		// test above is. `installCommitStall` parks a connection at the ENTRY to `commit()`,
		// which for the wrapper is before `commitConnectionOverlays` starts its Phase-1 apply,
		// so the reader never overlaps the wrapper's own publish window. Verified: with the
		// committed-handle branch disabled the harness still passes here. If the harness ever
		// needs to exercise a wrapper's multi-phase publish, it needs a gate that parks INSIDE
		// the module's commit, not ahead of it.
		it('the conformance harness passes against the wrapper', async () => {
			const db = new Database();
			const stall = installCommitStall(db);
			db.registerModule('iso_conf', new IsolationModule({ underlying: new MemoryTableModule() }));
			await db.exec('CREATE TABLE iso_conf_t (id INTEGER PRIMARY KEY, v TEXT) USING iso_conf');

			try {
				const result = await runCommittedReadConformance({
					db,
					table: 'iso_conf_t',
					keyColumn: 'id',
					valueColumn: 'v',
					rowCount: 20,
					stallCommit: () => stall.asStallCommit(),
				});
				expect(result.observedCommitOverlap).to.equal(true);
				expect(result.fullScanRows).to.equal(20);
			} finally {
				stall.release();
				await db.close();
			}
		});
	});

	describe('plan-level forwarding (physical properties)', () => {
		// PlanNode / PlanNodeType are not part of the published @quereus/quereus
		// surface, so we walk the optimized tree structurally and match the leaf
		// table reference by its node-type string ('TableReference').
		function findByType(root: any, nodeType: string): any[] {
			const out: any[] = [];
			const seen = new Set<string>();
			const stack: any[] = [root];
			while (stack.length > 0) {
				const n = stack.pop();
				if (!n || seen.has(n.id)) continue;
				seen.add(n.id);
				if (n.nodeType === nodeType) out.push(n);
				for (const c of n.getChildren()) stack.push(c);
			}
			return out;
		}

		it('reentrant + latency underlying surfaces concurrencySafe=true and the latency hint through the wrapper', async () => {
			const db = new Database();
			const iso = new IsolationModule({ underlying: new HighLatencyMemoryModule() });
			db.registerModule('isolated', iso);
			await db.exec('create table t (id integer primary key, v text) using isolated');

			const plan = db.getPlan('select * from t');
			const refs = findByType(plan, 'TableReference');
			expect(refs.length, 'expected a TableReference node in the plan').to.be.greaterThan(0);
			const phys = refs[0].physical;
			expect(phys.concurrencySafe).to.equal(true);
			expect(phys.expectedLatencyMs).to.equal(25);
			await db.close();
		});

		it('serial wrapper (serial overlay) yields concurrencySafe=false and no latency hint', async () => {
			const db = new Database();
			// Reentrant underlying, serial custom overlay → weakest-of → serial.
			// The overlay module is never instantiated during a read-only plan.
			const iso = new IsolationModule({ underlying: new MemoryTableModule(), overlay: modeStub('serial') });
			db.registerModule('isolated', iso);
			await db.exec('create table t (id integer primary key, v text) using isolated');

			const plan = db.getPlan('select * from t');
			const refs = findByType(plan, 'TableReference');
			expect(refs.length, 'expected a TableReference node in the plan').to.be.greaterThan(0);
			const phys = refs[0].physical;
			expect(phys.concurrencySafe).to.equal(false);
			expect(phys.expectedLatencyMs).to.equal(undefined);
			await db.close();
		});
	});

	describe('ensureConnection reentrancy + merged-read correctness', () => {
		let db: Database;

		beforeEach(() => {
			db = new Database();
		});

		afterEach(async () => {
			await db.close();
		});

		/** A primary-key full-scan FilterInfo. `idxStr` is left null (the wire form the
		 *  memory module reads for a PK scan); `accessPath` — the source of truth the
		 *  isolation layer's merge now reads — is `{ kind: 'fullScan' }`, which merges by
		 *  primary key. Mirrors `makeFullScanFilterInfo`. */
		function fullScanFilter(idxStr: string | null = null): FilterInfo {
			return {
				idxNum: 0,
				idxStr,
				constraints: [],
				args: [],
				accessPath: idxStr === null ? { kind: 'fullScan' } : undefined,
				indexInfoOutput: {
					nConstraint: 0,
					aConstraint: [],
					nOrderBy: 0,
					aOrderBy: [],
					colUsed: 0n,
					aConstraintUsage: [],
					idxNum: 0,
					idxStr,
					orderByConsumed: false,
					estimatedCost: 1000000,
					estimatedRows: 1000000n,
					idxFlags: 0,
				},
			};
		}

		/** A full scan over the secondary index on column `v`, as the planner would emit it:
		 *  the `idx=<name>(0);plan=2` wire string the memory module reads AND the typed
		 *  `accessPath` (a `role: 'secondary'` descriptor over `v`) the isolation layer's
		 *  merge reads to pick the `(indexKey, pk)` comparator. */
		function secondaryScanFilter(iso: IsolationModule): FilterInfo {
			const schema = iso.getUnderlyingState('main', 't')!.underlyingTable.tableSchema!;
			const vIdx = schema.columnIndexMap.get('v')!;
			const idx = schema.indexes!.find(i => i.columns.some(c => c.index === vIdx))!;
			return {
				...fullScanFilter(`idx=${idx.name}(0);plan=2`),
				accessPath: {
					kind: 'index',
					plan: 'eqSeek',
					index: {
						name: idx.name,
						role: 'secondary',
						keyColumns: idx.columns.map(c => ({ columnIndex: c.index, desc: c.desc === true })),
						unique: idx.unique === true,
					},
				},
			};
		}

		/** The merged ground truth for the staged overlay below, as [id, v]. */
		const EXPECTED: SqlValue[][] = [[1, 'a'], [3, 'C'], [4, 'd']];

		/** Normalises a merged result to sorted [id, v] tuples for multiset compare. */
		function sortRows(rows: readonly Row[]): SqlValue[][] {
			return rows.map(r => [r[0], r[1]] as SqlValue[]).sort((x, y) => Number(x[0]) - Number(y[0]));
		}

		const QUALIFIED = 'main.t';
		function dbi(): DatabaseInternal { return db as unknown as DatabaseInternal; }
		function conns(): VirtualTableConnection[] { return dbi().getConnectionsForTable(QUALIFIED); }
		function clearConns(): void { for (const c of conns()) dbi().unregisterConnection(c.connectionId); }

		async function connectReader(iso: IsolationModule, readCommitted = false): Promise<IsolatedTable> {
			const opts = (readCommitted ? { _readCommitted: true } : {}) as unknown as BaseModuleConfig;
			return await iso.connect(db, undefined, 'isolated', 'main', 't', opts) as IsolatedTable;
		}

		/**
		 * Creates `t (id, v)` over an isolation-wrapped memory module, seeds three
		 * committed rows, then injects an overlay holding a staged insert (id=4), a
		 * staged tombstone (id=2) and a staged update (id=3 → 'C') directly — no
		 * transaction. The merged view is {@link EXPECTED}.
		 *
		 * Direct overlay injection (rather than BEGIN + DML) keeps the registered-
		 * connection count deterministic: there is no open transaction to defer
		 * `unregisterConnection`, so the concurrent-read seam is exercised from a
		 * known-clean connection state.
		 */
		async function setupStagedOverlay(withSecondaryIndex: boolean): Promise<IsolationModule> {
			const iso = new IsolationModule({ underlying: new MemoryTableModule() });
			db.registerModule('isolated', iso);
			await db.exec('create table t (id integer primary key, v text) using isolated');
			if (withSecondaryIndex) await db.exec('create index t_by_v on t(v)');
			await db.exec("insert into t values (1,'a'),(2,'b'),(3,'c')");

			const underlying = iso.getUnderlyingState('main', 't')!.underlyingTable;
			const overlay = await iso.overlayModule.create(db, iso.createOverlaySchema(underlying.tableSchema!));
			// Overlay rows carry a trailing tombstone column (0 = live, 1 = tombstone).
			await overlay.update({ operation: 'insert', values: [4, 'd', 0] }); // staged insert
			await overlay.update({ operation: 'insert', values: [2, null, 1] }); // staged tombstone (id=2)
			await overlay.update({ operation: 'insert', values: [3, 'C', 0] }); // staged update (id=3)
			iso.setConnectionOverlay(db, 'main', 't', { overlayTable: overlay, hasChanges: true, db });
			return iso;
		}

		it('primary scan: concurrent first-reads on one instance register exactly one connection and match the serial baseline', async () => {
			const iso = await setupStagedOverlay(false);
			const filter = () => fullScanFilter(null);

			// Serial baseline through its own fresh instance.
			const baseline = await asyncIterableToArray((await connectReader(iso)).query(filter()));
			expect(sortRows(baseline)).to.deep.equal(EXPECTED);

			// Drop any covering connection so the concurrent pair hits the
			// no-existing-covering seam in ensureConnection.
			clearConns();
			expect(conns().length).to.equal(0);

			const inst = await connectReader(iso);
			const [a, b] = await Promise.all([
				asyncIterableToArray(inst.query(filter())),
				asyncIterableToArray(inst.query(filter())),
			]);

			expect(conns().length, 'memo must coalesce concurrent first-reads to one registration').to.equal(1);
			expect(sortRows(a)).to.deep.equal(EXPECTED);
			expect(sortRows(b)).to.deep.equal(EXPECTED);
		});

		it('secondary-index scan: concurrent first-reads register exactly one connection and match the serial baseline', async () => {
			const iso = await setupStagedOverlay(true);
			const filter = () => secondaryScanFilter(iso);

			const baseline = await asyncIterableToArray((await connectReader(iso)).query(filter()));
			expect(sortRows(baseline)).to.deep.equal(EXPECTED);

			clearConns();
			expect(conns().length).to.equal(0);

			const inst = await connectReader(iso);
			const [a, b] = await Promise.all([
				asyncIterableToArray(inst.query(filter())),
				asyncIterableToArray(inst.query(filter())),
			]);

			expect(conns().length, 'memo must coalesce concurrent first-reads to one registration').to.equal(1);
			expect(sortRows(a)).to.deep.equal(EXPECTED);
			expect(sortRows(b)).to.deep.equal(EXPECTED);
		});

		// --- Cross-instance coalescing -----------------------------------------
		// The runtime connects a FRESH IsolatedTable per scan, so two concurrent
		// merged-overlay scans of one table land on DISTINCT wrapper instances —
		// the path the same-instance tests above never exercise. A per-instance
		// memo cannot coalesce these; only the module-level memo
		// (IsolationModule.coalesceConnectionBuild, keyed per db+table) can. Without
		// it both instances register their own covering IsolatedConnection
		// (covering.length === 2), tripping DeferredConstraintQueue.findConnection's
		// "found multiple candidate connections" throw downstream.

		it('primary scan: concurrent first-reads across SEPARATE instances coalesce onto one covering connection', async () => {
			const iso = await setupStagedOverlay(false);
			const filter = () => fullScanFilter(null);

			// Start from a clean connection set so both fresh instances hit the
			// no-existing-covering seam in ensureConnection simultaneously.
			clearConns();
			expect(conns().length).to.equal(0);

			const instA = await connectReader(iso);
			const instB = await connectReader(iso);
			const [a, b] = await Promise.all([
				asyncIterableToArray(instA.query(filter())),
				asyncIterableToArray(instB.query(filter())),
			]);

			expect(conns().filter(c => c.isCovering).length,
				'module-level memo must coalesce cross-instance first-reads to one covering connection').to.equal(1);
			expect(sortRows(a)).to.deep.equal(EXPECTED);
			expect(sortRows(b)).to.deep.equal(EXPECTED);
		});

		it('secondary-index scan: concurrent first-reads across SEPARATE instances coalesce onto one covering connection', async () => {
			const iso = await setupStagedOverlay(true);
			const filter = () => secondaryScanFilter(iso);

			clearConns();
			expect(conns().length).to.equal(0);

			const instA = await connectReader(iso);
			const instB = await connectReader(iso);
			const [a, b] = await Promise.all([
				asyncIterableToArray(instA.query(filter())),
				asyncIterableToArray(instB.query(filter())),
			]);

			expect(conns().filter(c => c.isCovering).length,
				'module-level memo must coalesce cross-instance first-reads to one covering connection').to.equal(1);
			expect(sortRows(a)).to.deep.equal(EXPECTED);
			expect(sortRows(b)).to.deep.equal(EXPECTED);
		});

		it('reuses an existing covering connection under concurrency (no extra registration)', async () => {
			const iso = await setupStagedOverlay(false);
			// Register a covering connection via a serial first read.
			await asyncIterableToArray((await connectReader(iso)).query(fullScanFilter(null)));
			const before = conns().length;
			expect(before).to.be.greaterThan(0);

			const inst = await connectReader(iso);
			const [a, b] = await Promise.all([
				asyncIterableToArray(inst.query(fullScanFilter(null))),
				asyncIterableToArray(inst.query(fullScanFilter(null))),
			]);

			// The covering-reuse check inside the memoized body still fires — no growth.
			expect(conns().length).to.equal(before);
			expect(sortRows(a)).to.deep.equal(EXPECTED);
			expect(sortRows(b)).to.deep.equal(EXPECTED);
		});

		it('a failed connection build clears the in-flight memo so a later read retries', async () => {
			const iso = await setupStagedOverlay(false);
			clearConns();
			const inst = await connectReader(iso);

			const realRegister = dbi().registerConnection.bind(dbi());
			let calls = 0;
			(db as any).registerConnection = async (c: VirtualTableConnection) => {
				calls++;
				if (calls === 1) throw new Error('boom: simulated registration failure');
				return realRegister(c);
			};
			try {
				let threw = false;
				try {
					await asyncIterableToArray(inst.query(fullScanFilter(null)));
				} catch {
					threw = true;
				}
				expect(threw, 'first read must surface the build failure').to.equal(true);

				// Memo cleared on reject → the retry rebuilds and registers exactly once.
				const rows = await asyncIterableToArray(inst.query(fullScanFilter(null)));
				expect(sortRows(rows)).to.deep.equal(EXPECTED);
				expect(conns().length).to.equal(1);
			} finally {
				delete (db as any).registerConnection;
			}
		});

		it('read-committed scan over a reentrant underlying stays concurrency-safe and bypasses the overlay', async () => {
			const iso = await setupStagedOverlay(false);
			expect(getModuleConcurrencyMode(iso)).to.equal('reentrant-reads');
			clearConns();

			// readCommitted → fast path delegates straight to the underlying (no
			// overlay merge, no connection registration).
			const inst = await connectReader(iso, true);
			const [a, b] = await Promise.all([
				asyncIterableToArray(inst.query(fullScanFilter(null))),
				asyncIterableToArray(inst.query(fullScanFilter(null))),
			]);

			// Committed underlying only: staged insert/tombstone/update are invisible.
			const committed: SqlValue[][] = [[1, 'a'], [2, 'b'], [3, 'c']];
			expect(sortRows(a)).to.deep.equal(committed);
			expect(sortRows(b)).to.deep.equal(committed);
			expect(conns().length, 'read-committed fast path registers no connection').to.equal(0);
		});

		it('secondary-index scan emits (indexKey, pk) order across a tombstone revival with a changed index key', async () => {
			// committed (1,'a'),(2,'b'),(3,'c'); overlay stages +4 'd', tombstone id=2, update id=3 -> 'C'.
			const iso = await setupStagedOverlay(true);

			// Revive the tombstoned id=2 as a LIVE row at a new index key 'Z': its overlay
			// index key now differs from the underlying 'b' it shadows, so the merge must
			// place it by 'Z', not by the stale underlying value — the changed-index-key path.
			const overlay = iso.getConnectionOverlay(db, 'main', 't')!.overlayTable;
			await overlay.update({ operation: 'update', values: [2, 'Z', 0], oldKeyValues: [2] });

			// Merged secondary view in (v, pk) order. Overlay live rows: (3,'C'),(2,'Z'),(4,'d');
			// underlying surviving (id=1 unmodified): (1,'a'). BINARY order of v: 'C' < 'Z' < 'a' < 'd'.
			const rows = await asyncIterableToArray((await connectReader(iso)).query(secondaryScanFilter(iso)));
			expect(rows.map(r => [r[0], r[1]])).to.deep.equal([[3, 'C'], [2, 'Z'], [1, 'a'], [4, 'd']]);
		});

		it('FilterInfo without accessPath: clean read succeeds, dirty read throws INTERNAL', async () => {
			const iso = new IsolationModule({ underlying: new MemoryTableModule() });
			db.registerModule('isolated', iso);
			await db.exec('create table t (id integer primary key, v text) using isolated');
			await db.exec("insert into t values (1,'a'),(2,'b')");

			// A hand-built full scan that declares no access path — the shape a caller that
			// never went through the engine builders produces.
			const noAccessPath: FilterInfo = { ...fullScanFilter(null), accessPath: undefined };

			// No overlay → query() short-circuits to the underlying before resolveScanIndex,
			// so the missing accessPath is harmless on a clean read.
			const clean = await asyncIterableToArray((await connectReader(iso)).query(noAccessPath));
			expect(sortRows(clean)).to.deep.equal([[1, 'a'], [2, 'b']]);

			// Stage an overlay so the merged path runs; now the missing accessPath is fatal.
			const underlying = iso.getUnderlyingState('main', 't')!.underlyingTable;
			const overlay = await iso.overlayModule.create(db, iso.createOverlaySchema(underlying.tableSchema!));
			await overlay.update({ operation: 'insert', values: [3, 'c', 0] });
			iso.setConnectionOverlay(db, 'main', 't', { overlayTable: overlay, hasChanges: true, db });

			let err: unknown;
			try { await asyncIterableToArray((await connectReader(iso)).query(noAccessPath)); } catch (e) { err = e; }
			expect(err, 'dirty read with no accessPath must throw').to.be.instanceOf(QuereusError);
			expect((err as QuereusError).code).to.equal(StatusCode.INTERNAL);
			expect((err as QuereusError).message).to.match(/no accessPath/i);
		});

		it('empty-plan accessPath merges by primary key (overlay rows over an empty underlying stream)', async () => {
			// { kind: 'empty' } must resolve to a primary-key merge, not throw. idxStr stays null
			// so both streams scan by PK; the accessPath alone drives the comparator choice.
			const iso = await setupStagedOverlay(false);
			const emptyPlan: FilterInfo = { ...fullScanFilter(null), accessPath: { kind: 'empty' } };
			const rows = await asyncIterableToArray((await connectReader(iso)).query(emptyPlan));
			expect(sortRows(rows)).to.deep.equal(EXPECTED);
		});
	});

	describe('suffixed primary-key index name (underlying-advertised)', () => {
		// Regression: an underlying virtual table may advertise its PK access plan under a
		// per-plan unique name — lamina-quereus appends a monotonic counter so it can recover
		// the exact plan later (`_primary_` → `_primary_1`, `_primary_2`, …). With a live
		// overlay (any buffered write), a PK point lookup then carried idxStr
		// `idx=_primary_1(...)`, which the isolation layer misclassified as a secondary index
		// and routed to the overlay MemoryTable — which has no such secondary index, so it
		// threw `QuereusError: Secondary index '_primary_1' not found.`

		/**
		 * Rewrites a suffixed PK idxStr (`idx=_primary_<n>(...)`) back to the base
		 * `_primary_`. The MemoryTable underlying only resolves `_primary_`, so its own
		 * query recovers the PK scan here exactly as lamina's private plan registry does —
		 * this is the load-bearing underlying-side behavior the isolation fix must tolerate,
		 * NOT change.
		 */
		function recoverSuffixedPk(filterInfo: FilterInfo): FilterInfo {
			const re = /(^|;)idx=_primary_\d+\(/;
			const { idxStr } = filterInfo;
			if (!idxStr || !re.test(idxStr)) return filterInfo;
			const strip = (s: string): string => s.replace(re, '$1idx=_primary_(');
			const outIdxStr = filterInfo.indexInfoOutput.idxStr;
			return {
				...filterInfo,
				idxStr: strip(idxStr),
				indexInfoOutput: { ...filterInfo.indexInfoOutput, idxStr: outIdxStr ? strip(outIdxStr) : outIdxStr },
			};
		}

		type UnderlyingTable = Awaited<ReturnType<MemoryTableModule['create']>>;

		/** Wraps a MemoryTable so its `query` recovers a suffixed PK name before delegating.
		 *  Every other member is forwarded to the real table (bound to it, so private fields
		 *  resolve). */
		function wrapUnderlying(table: UnderlyingTable): UnderlyingTable {
			return new Proxy(table, {
				get(target, prop) {
					if (prop === 'query') {
						return (filterInfo: FilterInfo) => target.query!(recoverSuffixedPk(filterInfo));
					}
					const value = Reflect.get(target, prop, target);
					return typeof value === 'function' ? value.bind(target) : value;
				},
			});
		}

		/** Underlying module that advertises its PK plan under the suffixed name `_primary_1`,
		 *  mimicking how lamina-quereus mints per-plan unique keys. It ALSO supplies a matching
		 *  `indexDescriptor` (`role: 'primary'`, name `_primary_1`) — the contract a module owes
		 *  the engine when it aliases an index name, so an order-sensitive consumer (the isolation
		 *  merge) can still recognise the walk as a primary-key scan. Secondary index names are
		 *  advertised verbatim, so secondary routing is unaffected. */
		class SuffixedPkMemoryModule extends MemoryTableModule {
			override getBestAccessPlan(db: Database, tableInfo: TableSchema, request: BestAccessPlanRequest): BestAccessPlanResult {
				const plan = super.getBestAccessPlan(db, tableInfo, request);
				if (plan.indexName !== '_primary_') return plan;
				const pk = primaryKeyDescriptor(tableInfo)!;
				return { ...plan, indexName: '_primary_1', indexDescriptor: { ...pk, name: '_primary_1' } };
			}
			override async create(...args: Parameters<MemoryTableModule['create']>): Promise<UnderlyingTable> {
				return wrapUnderlying(await super.create(...args));
			}
			override async connect(...args: Parameters<MemoryTableModule['connect']>): Promise<UnderlyingTable> {
				return wrapUnderlying(await super.connect(...args));
			}
		}

		/** Same PK aliasing as {@link SuffixedPkMemoryModule} but WITHOUT supplying the
		 *  `indexDescriptor` — the contract violation. The engine records the plan as an
		 *  `unresolvedIndex`, and the isolation merge must refuse it rather than silently
		 *  merge by the wrong sort key. The underlying still recovers the suffixed name so a
		 *  clean (no-overlay) read, which bypasses the merge, keeps working. */
		class NoDescriptorAliasedPkModule extends MemoryTableModule {
			override getBestAccessPlan(db: Database, tableInfo: TableSchema, request: BestAccessPlanRequest): BestAccessPlanResult {
				const plan = super.getBestAccessPlan(db, tableInfo, request);
				return plan.indexName === '_primary_' ? { ...plan, indexName: '_primary_1' } : plan;
			}
			override async create(...args: Parameters<MemoryTableModule['create']>): Promise<UnderlyingTable> {
				return wrapUnderlying(await super.create(...args));
			}
			override async connect(...args: Parameters<MemoryTableModule['connect']>): Promise<UnderlyingTable> {
				return wrapUnderlying(await super.connect(...args));
			}
		}

		it('aliased PK without an indexDescriptor: clean read OK, dirty read throws INTERNAL naming the index', async () => {
			const ndb = new Database();
			ndb.registerModule('isolated', new IsolationModule({ underlying: new NoDescriptorAliasedPkModule() }));
			try {
				await ndb.exec(`CREATE TABLE Site (id INTEGER PRIMARY KEY, name TEXT) USING isolated`);
				await ndb.exec(`INSERT INTO Site (id, name) VALUES (1, 'Scene A')`);

				// Clean autocommit read — no overlay, so query() bypasses the merge and the
				// underlying recovers the suffixed name. No accessPath inspection, no throw.
				const clean = await ndb.get(`SELECT name FROM Site WHERE id = 1`);
				expect(clean?.name).to.equal('Scene A');

				await ndb.exec('BEGIN');
				await ndb.exec(`INSERT INTO Site (id, name) VALUES (2, 'Scene B')`); // creates the live overlay

				// Dirty read reaches the merge, which finds an unresolvedIndex access path and
				// must throw INTERNAL naming the offending index rather than mis-merge.
				let err: unknown;
				try { await ndb.get(`SELECT name FROM Site WHERE id = 1`); } catch (e) { err = e; }
				expect(err, 'dirty read over an unresolved aliased index must throw').to.be.instanceOf(QuereusError);
				expect((err as QuereusError).code).to.equal(StatusCode.INTERNAL);
				expect((err as QuereusError).message).to.match(/_primary_1/);

				await ndb.exec('ROLLBACK');
			} finally {
				await ndb.close();
			}
		});

		let sdb: Database;
		beforeEach(() => {
			sdb = new Database();
			sdb.registerModule('isolated', new IsolationModule({ underlying: new SuffixedPkMemoryModule() }));
		});

		it('PK point lookup resolves through a live overlay (the original repro)', async () => {
			await sdb.exec(`CREATE TABLE Site (id INTEGER PRIMARY KEY, name TEXT) USING isolated`);
			await sdb.exec(`INSERT INTO Site (id, name) VALUES (1, 'Scene A')`);

			await sdb.exec('BEGIN');
			// A buffered write creates the live overlay for this connection.
			await sdb.exec(`INSERT INTO Site (id, name) VALUES (2, 'Scene B')`);

			// Point lookup of the committed row: threw "Secondary index '_primary_1' not found"
			// before the fix.
			const existing = await sdb.get(`SELECT name FROM Site WHERE id = 1`);
			expect(existing?.name).to.equal('Scene A');

			// The overlay-buffered row is visible via the same suffixed-PK path.
			const buffered = await sdb.get(`SELECT name FROM Site WHERE id = 2`);
			expect(buffered?.name).to.equal('Scene B');

			await sdb.exec('COMMIT');

			const afterCommit = await asyncIterableToArray(sdb.eval(`SELECT id, name FROM Site ORDER BY id`));
			expect(afterCommit.map((r: any) => [r.id, r.name])).to.deep.equal([[1, 'Scene A'], [2, 'Scene B']]);
		});

		it('bare `_primary_` (no overlay-affecting suffix) still resolves — read without a live overlay', async () => {
			await sdb.exec(`CREATE TABLE Site (id INTEGER PRIMARY KEY, name TEXT) USING isolated`);
			await sdb.exec(`INSERT INTO Site (id, name) VALUES (1, 'Scene A')`);
			// Autocommit read — no overlay, delegates straight to the underlying.
			const row = await sdb.get(`SELECT name FROM Site WHERE id = 1`);
			expect(row?.name).to.equal('Scene A');
		});

		it('PK range scan resolves through a live overlay with a suffixed PK name', async () => {
			await sdb.exec(`CREATE TABLE Site (id INTEGER PRIMARY KEY, name TEXT) USING isolated`);
			await sdb.exec(`INSERT INTO Site (id, name) VALUES (1, 'A'), (2, 'B'), (3, 'C')`);

			await sdb.exec('BEGIN');
			await sdb.exec(`INSERT INTO Site (id, name) VALUES (4, 'D')`);   // creates overlay
			await sdb.exec(`UPDATE Site SET name = 'B2' WHERE id = 2`);

			const rows = await asyncIterableToArray(sdb.eval(`SELECT id, name FROM Site WHERE id >= 2 ORDER BY id`));
			expect(rows.map((r: any) => [r.id, r.name])).to.deep.equal([[2, 'B2'], [3, 'C'], [4, 'D']]);

			await sdb.exec('ROLLBACK');
		});

		it('genuine secondary index still routes to the overlay secondary scan under the suffixed module', async () => {
			// The PK-suffix rewrite must NOT disturb real secondary index names. Here the
			// underlying advertises the secondary index `idx_email` verbatim, so a lookup by
			// email with a live overlay must merge overlay + underlying secondary streams.
			await sdb.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT, name TEXT) USING isolated`);
			await sdb.exec(`CREATE INDEX idx_email ON users(email)`);
			await sdb.exec(`INSERT INTO users VALUES (1, 'alice@example.com', 'Alice')`);

			await sdb.exec('BEGIN');
			await sdb.exec(`INSERT INTO users VALUES (2, 'bob@example.com', 'Bob')`); // creates overlay

			const alice = await sdb.get(`SELECT name FROM users WHERE email = 'alice@example.com'`);
			expect(alice?.name).to.equal('Alice');
			const bob = await sdb.get(`SELECT name FROM users WHERE email = 'bob@example.com'`);
			expect(bob?.name).to.equal('Bob');

			await sdb.exec('ROLLBACK');
		});
	});

	describe('accessPath merge-order: index named like the primary key, analyze, multi-table commit', () => {
		let adb: Database;
		beforeEach(() => { adb = new Database(); });
		afterEach(async () => { await adb.close(); });

		it('an index literally named `_primary_extra` merges as a secondary index', async () => {
			// The old string parser classified any `_primary_`-prefixed name as the PK family via a
			// regex; the descriptor makes it structural. A genuine secondary index NAMED
			// `_primary_extra` resolves through the schema as role:'secondary' and must merge by
			// (indexKey, pk), not by PK.
			const iso = new IsolationModule({ underlying: new MemoryTableModule() });
			adb.registerModule('isolated', iso);
			await adb.exec('create table t (id integer primary key, v text) using isolated');
			await adb.exec('create index _primary_extra on t(v)');
			await adb.exec("insert into t values (1,'a'),(2,'b'),(3,'c')");

			// Stage an overlay directly: insert (4,'d'), tombstone id=2, update id=3 -> 'C'.
			const underlying = iso.getUnderlyingState('main', 't')!.underlyingTable;
			const overlay = await iso.overlayModule.create(adb, iso.createOverlaySchema(underlying.tableSchema!));
			await overlay.update({ operation: 'insert', values: [4, 'd', 0] });
			await overlay.update({ operation: 'insert', values: [2, null, 1] });
			await overlay.update({ operation: 'insert', values: [3, 'C', 0] });
			iso.setConnectionOverlay(adb, 'main', 't', { overlayTable: overlay, hasChanges: true, db: adb });

			// A secondary full-scan FilterInfo naming _primary_extra (role: secondary).
			const schema = underlying.tableSchema!;
			const vIdx = schema.columnIndexMap.get('v')!;
			const idxStr = 'idx=_primary_extra(0);plan=2';
			const base = makeFullScanFilterInfo();
			const filter: FilterInfo = {
				...base,
				idxStr,
				accessPath: {
					kind: 'index',
					plan: 'eqSeek',
					index: { name: '_primary_extra', role: 'secondary', keyColumns: [{ columnIndex: vIdx, desc: false }], unique: false },
				},
				indexInfoOutput: { ...base.indexInfoOutput, idxStr },
			};

			const table = await iso.connect(adb, undefined, 'isolated', 'main', 't', {} as unknown as BaseModuleConfig) as IsolatedTable;
			const rows = await asyncIterableToArray(table.query!(filter));
			// merged secondary view in (v, pk) order: 'C'(3) < 'a'(1) < 'd'(4).
			expect(rows.map(r => [r[0], r[1]])).to.deep.equal([[3, 'C'], [1, 'a'], [4, 'd']]);
		});

		it('ANALYZE on an isolated table inside an open transaction with a dirty overlay succeeds', async () => {
			const iso = new IsolationModule({ underlying: new MemoryTableModule() });
			adb.registerModule('isolated', iso);
			await adb.exec('create table t (id integer primary key, v text) using isolated');
			await adb.exec("insert into t values (1,'a'),(2,'b')");

			await adb.exec('begin');
			await adb.exec("insert into t values (3,'c')"); // dirty overlay

			// ANALYZE hand-builds a full-scan FilterInfo (makeFullScanFilterInfo, carries
			// accessPath) and scans the isolated table — which now merges the dirty overlay. It
			// must complete rather than throw the no-accessPath INTERNAL error.
			await adb.exec('analyze');

			// The collected row count is the assertion that the scan actually ran AND saw the
			// overlay: 2 committed rows + 1 uncommitted.
			expect(adb.schemaManager.findTable('t', 'main')?.statistics?.rowCount).to.equal(3);

			const rows = await asyncIterableToArray(adb.eval('select id, v from t order by id'));
			expect(rows.map((r: any) => [r.id, r.v])).to.deep.equal([[1, 'a'], [2, 'b'], [3, 'c']]);
			await adb.exec('rollback');
		});

		it('a two-table commit still flushes both overlays through the full-scan path', async () => {
			const iso = new IsolationModule({ underlying: new MemoryTableModule() });
			adb.registerModule('isolated', iso);
			await adb.exec('create table a (id integer primary key, v text) using isolated');
			await adb.exec('create table b (id integer primary key, v text) using isolated');

			await adb.exec('begin');
			await adb.exec("insert into a values (1,'a1')");
			await adb.exec("insert into b values (1,'b1')");
			await adb.exec('commit');

			const ra = await asyncIterableToArray(adb.eval('select id, v from a order by id'));
			const rb = await asyncIterableToArray(adb.eval('select id, v from b order by id'));
			expect(ra.map((r: any) => [r.id, r.v])).to.deep.equal([[1, 'a1']]);
			expect(rb.map((r: any) => [r.id, r.v])).to.deep.equal([[1, 'b1']]);
		});
	});

	describe('underlying-minted secondary index names (synthetic scan shapes)', () => {
		// An underlying module may drive a secondary scan under an index name it minted
		// itself (lamina mints `_column_<id>_`, `_compound_<name>_`, `_nd_<name>_`,
		// `_intersect_<ids>_` per plan) — a name no table schema declares, so the overlay's
		// private scratch table can never resolve it. The merged secondary read must
		// full-scan + window-filter + sort the overlay delta itself instead of re-issuing
		// the index-named FilterInfo against the overlay, which threw
		// "Secondary index '_compound_v_0' not found".
		const SYNTH = '_compound_v_0';

		/** Underlying table whose secondary scan shape is the synthetic index: emits rows
		 *  in `v` order (descending when the module says so) and applies pushed EQ
		 *  constraints, like a real module would. */
		class SynthUnderlyingTable extends VirtualTable {
			private readonly mod: SynthUnderlyingModule;
			private readonly key: string;

			constructor(db: Database, module: SynthUnderlyingModule, schema: TableSchema) {
				super(db, module, schema.schemaName, schema.name);
				this.tableSchema = schema;
				this.mod = module;
				this.key = `${schema.schemaName}.${schema.name}`.toLowerCase();
				if (!this.mod.store.has(this.key)) this.mod.store.set(this.key, []);
			}

			async disconnect(): Promise<void> { /* no-op */ }

			async update(args: UpdateArgs): Promise<UpdateResult> {
				if (args.operation === 'insert' && args.values) {
					const rows = this.mod.store.get(this.key)!;
					rows.push([...args.values] as Row);
					rows.sort((a, b) => Number(a[0]) - Number(b[0]));
					return { status: 'ok', row: args.values };
				}
				return { status: 'ok' };
			}

			async *query(filterInfo: FilterInfo): AsyncIterable<Row> {
				const rows = [...(this.mod.store.get(this.key) ?? [])];
				const dir = this.mod.desc ? -1 : 1;
				rows.sort((a, b) => dir * (String(a[1]) < String(b[1]) ? -1 : String(a[1]) > String(b[1]) ? 1 : 0));
				for (const row of rows) {
					const inWindow = filterInfo.constraints.every(({ constraint, argvIndex }) =>
						argvIndex <= 0
						|| constraint.op !== IndexConstraintOp.EQ
						|| row[constraint.iColumn] === filterInfo.args[argvIndex - 1]);
					if (inWindow) yield row as Row;
				}
			}
		}

		/** Module that advertises every plan under the synthetic secondary index name,
		 *  supplying the matching descriptor (the contract a module owes the engine when
		 *  it names an index the table schema cannot resolve). */
		class SynthUnderlyingModule implements VirtualTableModule<SynthUnderlyingTable, BaseModuleConfig> {
			readonly store = new Map<string, Row[]>();

			constructor(readonly desc = false) {}

			async create(cdb: Database, schema: TableSchema): Promise<SynthUnderlyingTable> {
				return new SynthUnderlyingTable(cdb, this, schema);
			}

			async connect(
				cdb: Database,
				_pAux: unknown,
				_moduleName: string,
				schemaName: string,
				tableName: string,
				_options: BaseModuleConfig,
				importedTableSchema?: TableSchema,
			): Promise<SynthUnderlyingTable> {
				if (!importedTableSchema) {
					throw new Error(`Table ${schemaName}.${tableName} connected without a schema`);
				}
				return new SynthUnderlyingTable(cdb, this, importedTableSchema);
			}

			async destroy(): Promise<void> { /* store is per-instance */ }

			getBestAccessPlan(_cdb: Database, tableInfo: TableSchema, request: BestAccessPlanRequest): BestAccessPlanResult {
				const vIdx = tableInfo.columnIndexMap.get('v')!;
				const descriptor: IndexDescriptor = {
					name: SYNTH,
					role: 'secondary',
					keyColumns: [{ columnIndex: vIdx, desc: this.desc }],
					unique: false,
				};
				return AccessPlanBuilder.fullScan(request.estimatedRows ?? 100)
					.setHandledFilters(new Array(request.filters.length).fill(false))
					.setIndexName(SYNTH)
					.setIndexDescriptor(descriptor)
					.setExplanation('SynthUnderlyingModule walk under a minted secondary index name')
					.build();
			}
		}

		/** FilterInfo shaped the way the engine builds one for a scan the underlying chose
		 *  to drive under the synthetic index: idxStr names SYNTH, accessPath carries the
		 *  module-supplied descriptor. */
		function synthFilter(vIdx: number, constraints: FilterInfo['constraints'] = [], args: SqlValue[] = [], desc = false): FilterInfo {
			const idxStr = `idx=${SYNTH}(0);plan=2`;
			const base = makeFullScanFilterInfo();
			return {
				...base,
				idxStr,
				constraints,
				args,
				accessPath: {
					kind: 'index',
					plan: 'eqSeek',
					index: { name: SYNTH, role: 'secondary', keyColumns: [{ columnIndex: vIdx, desc }], unique: false },
				},
				indexInfoOutput: { ...base.indexInfoOutput, idxStr },
			};
		}

		let ndb: Database | undefined;

		afterEach(async () => { await ndb?.close(); ndb = undefined; });

		/** Builds a fresh Database + IsolationModule over a synthetic-index underlying,
		 *  seeds committed rows, stages `overlayRows` (tombstone column included) into a
		 *  live dirty overlay, and returns the connected IsolatedTable plus the `v`
		 *  column index. */
		async function stage(committedInsert: string, overlayRows: Row[], desc = false, vType = 'text'): Promise<{ table: IsolatedTable; vIdx: number }> {
			ndb = new Database();
			const iso = new IsolationModule({ underlying: new SynthUnderlyingModule(desc) });
			ndb.registerModule('isolated', iso);
			await ndb.exec(`create table t (id integer primary key, v ${vType}) using isolated`);
			await ndb.exec(committedInsert); // autocommit → flushed to the underlying

			const underlying = iso.getUnderlyingState('main', 't')!.underlyingTable;
			const overlay = await iso.overlayModule.create(ndb, iso.createOverlaySchema(underlying.tableSchema!));
			for (const row of overlayRows) {
				await overlay.update({ operation: 'insert', values: row });
			}
			iso.setConnectionOverlay(ndb, 'main', 't', { overlayTable: overlay, hasChanges: true, db: ndb });

			const vIdx = underlying.tableSchema!.columnIndexMap.get('v')!;
			const table = await iso.connect(ndb, undefined, 'isolated', 'main', 't', {} as unknown as BaseModuleConfig) as IsolatedTable;
			return { table, vIdx };
		}

		it('merged read over the synthetic name yields the full row set in index order (was: Secondary index not found)', async () => {
			const { table, vIdx } = await stage(
				"insert into t values (1,'a'),(2,'b'),(3,'c'),(5,'e')",
				[
					[4, 'aa', 0],   // staged insert
					[2, null, 1],   // staged delete of id=2 (tombstone)
					[3, 'd', 0],    // staged update of id=3, moving its index key past 'c'
				],
			);

			const rows = await asyncIterableToArray(table.query!(synthFilter(vIdx)));

			// Merged view in (v, pk) order. The overlay's full scan emits PK order
			// (tombstone 2, then 3-'d', then 4-'aa'); only the isolation layer's explicit
			// sort interleaves 'aa'(4) before 'd'(3) between the underlying's 'a' and 'e'.
			expect(rows.map(r => [r[0], r[1]])).to.deep.equal([[1, 'a'], [4, 'aa'], [3, 'd'], [5, 'e']]);
		});

		it('equality window over the synthetic name: the isolation layer filters out-of-window overlay rows', async () => {
			const { table, vIdx } = await stage(
				"insert into t values (1,'a'),(2,'b'),(3,'c')",
				[
					[4, 'b', 0],  // staged insert inside the v='b' window
					[5, 'z', 0],  // staged insert outside it — must not surface
				],
			);

			const filter = synthFilter(
				vIdx,
				[{ constraint: { iColumn: vIdx, op: IndexConstraintOp.EQ, usable: true }, argvIndex: 1 }],
				['b'],
			);
			const rows = await asyncIterableToArray(table.query!(filter));

			// The underlying applies the EQ itself and contributes (2,'b'); the overlay's
			// (4,'b') joins it in (v, pk) order. (5,'z') is dropped by the isolation
			// layer's own window filter — this direct query() call has no residual Filter
			// node above it to catch it.
			expect(rows.map(r => [r[0], r[1]])).to.deep.equal([[2, 'b'], [4, 'b']]);
		});

		it('store-semantic-index-window-overlay: the window matcher ranks a TIMESPAN column by elapsed time', async () => {
			// The overlay's own window filter is the ONLY thing standing between a staged
			// row and the caller: the underlying claimed the range handled, so no residual
			// Filter survives above this merge. A plain text compare inverts a
			// semantic-ordering column in BOTH directions — 'PT1M' > 'PT1H' textually
			// (would leak a 1-minute row into a `> 1 hour` window) and 'PT180M' < 'PT1H'
			// textually (would drop a 3-hour row from it).
			const { table, vIdx } = await stage(
				"insert into t values (1,'PT2H')",
				[
					[3, 'PT90M', 0],   // 90 min — inside
					[4, 'PT1M', 0],    // 1 min — outside, but TEXTUALLY above 'PT1H'
					[5, 'PT180M', 0],  // 3 h — inside, but TEXTUALLY below 'PT1H'
				],
				false,
				'timespan',
			);

			const base = synthFilter(vIdx);
			const filter: FilterInfo = {
				...base,
				constraints: [{ constraint: { iColumn: vIdx, op: IndexConstraintOp.GT, usable: true }, argvIndex: 1 }],
				args: ['PT1H'],
				accessPath: {
					kind: 'index',
					plan: 'rangeSeek',
					index: { name: SYNTH, role: 'secondary', keyColumns: [{ columnIndex: vIdx, desc: false }], unique: false },
				},
			};
			const rows = await asyncIterableToArray(table.query!(filter));

			// Merged in elapsed-time order: 90 min, the committed 2 h, then 3 h. The
			// spellings are asserted too, so a future write-path normalization that
			// canonicalized them (making the inversions disappear) fails loudly rather
			// than quietly voiding this test.
			expect(rows.map(r => [r[0], r[1]])).to.deep.equal([[3, 'PT90M'], [1, 'PT2H'], [5, 'PT180M']]);
		});

		it('store-semantic-index-window-overlay: an EQ window matches a re-spelled staged TIMESPAN row', async () => {
			// The equality arm of the same matcher: 'PT1H' and 'PT60M' are ONE value under
			// the type's compare, and the underlying's byte/BTree key collapses them, so
			// dropping the staged row here would under-fetch with nothing above to notice.
			const { table, vIdx } = await stage(
				"insert into t values (1,'PT30M')",
				[[2, 'PT1H', 0]],
				false,
				'timespan',
			);

			const filter = synthFilter(
				vIdx,
				[{ constraint: { iColumn: vIdx, op: IndexConstraintOp.EQ, usable: true }, argvIndex: 1 }],
				['PT60M'],
			);
			const rows = await asyncIterableToArray(table.query!(filter));

			expect(rows.map(r => [r[0], r[1]])).to.deep.equal([[2, 'PT1H']]);
		});

		it('a synthetic index with a DESC key column merges in the underlying descending emission order', async () => {
			// The overlay cannot resolve the synthetic name, and the underlying exposes no
			// getIndexComparator for it either — the merge comparator must come from the
			// descriptor's key columns (desc: true here), or the overlay rows would be
			// interleaved ascending against a descending underlying stream.
			const { table, vIdx } = await stage(
				"insert into t values (1,'a'),(2,'b'),(3,'c'),(5,'e')",
				[
					[4, 'aa', 0],   // staged insert
					[2, null, 1],   // staged delete of id=2
					[3, 'd', 0],    // staged update of id=3
				],
				true,
			);

			const rows = await asyncIterableToArray(table.query!(synthFilter(vIdx, [], [], true)));

			// Descending (v) order: 'e'(5), 'd'(3), 'aa'(4), 'a'(1) — both overlay rows
			// interleave between the underlying's 'e' and 'a'.
			expect(rows.map(r => [r[0], r[1]])).to.deep.equal([[5, 'e'], [3, 'd'], [4, 'aa'], [1, 'a']]);
		});

		describe('compound (multi-column) synthetic index — IndexDescriptor.reverse', () => {
			// Twin of the single-column DESC case above, but the descriptor's `keyColumns`
			// carries TWO entries and the reversal is signalled via `IndexDescriptor.reverse`
			// (the bit `resolveScanIndex`/`buildMergeConfig` actually consult — the case above
			// exercises the older, unrelated `keyColumns[i].desc` per-column declared
			// direction). Pins bug-isolation-overlay-desc-order-secondary-read's fix
			// (`buildMergeConfig`'s `compareSortKey` negation) for a descriptor whose key is
			// more than one column wide: the whole (indexKey1, indexKey2, PK) tuple must
			// reverse together, not just the leading key column.
			const SYNTH2 = '_compound_v1_v2_0';

			class SynthCompoundTable extends VirtualTable {
				private readonly mod: SynthCompoundModule;
				private readonly key: string;

				constructor(db: Database, module: SynthCompoundModule, schema: TableSchema) {
					super(db, module, schema.schemaName, schema.name);
					this.tableSchema = schema;
					this.mod = module;
					this.key = `${schema.schemaName}.${schema.name}`.toLowerCase();
					if (!this.mod.store.has(this.key)) this.mod.store.set(this.key, []);
				}

				async disconnect(): Promise<void> { /* no-op */ }

				async update(args: UpdateArgs): Promise<UpdateResult> {
					if (args.operation === 'insert' && args.values) {
						const rows = this.mod.store.get(this.key)!;
						rows.push([...args.values] as Row);
						rows.sort((a, b) => Number(a[0]) - Number(b[0]));
						return { status: 'ok', row: args.values };
					}
					return { status: 'ok' };
				}

				async *query(filterInfo: FilterInfo): AsyncIterable<Row> {
					const rows = [...(this.mod.store.get(this.key) ?? [])];
					const dir = this.mod.reverse ? -1 : 1;
					// Sort by (v1, v2, id) — the FULL declared key plus the PK tie-break — then
					// flip the whole comparison when the module says the scan runs reversed,
					// exactly like a real reversed index walk would.
					rows.sort((a, b) => {
						const cmp = dir * (String(a[1]).localeCompare(String(b[1])) || String(a[2]).localeCompare(String(b[2])));
						if (cmp !== 0) return cmp;
						return dir * (Number(a[0]) - Number(b[0]));
					});
					for (const row of rows) {
						const inWindow = filterInfo.constraints.every(({ constraint, argvIndex }) =>
							argvIndex <= 0
							|| constraint.op !== IndexConstraintOp.EQ
							|| row[constraint.iColumn] === filterInfo.args[argvIndex - 1]);
						if (inWindow) yield row as Row;
					}
				}
			}

			class SynthCompoundModule implements VirtualTableModule<SynthCompoundTable, BaseModuleConfig> {
				readonly store = new Map<string, Row[]>();

				constructor(readonly reverse = false) {}

				async create(cdb: Database, schema: TableSchema): Promise<SynthCompoundTable> {
					return new SynthCompoundTable(cdb, this, schema);
				}

				async connect(
					cdb: Database,
					_pAux: unknown,
					_moduleName: string,
					schemaName: string,
					tableName: string,
					_options: BaseModuleConfig,
					importedTableSchema?: TableSchema,
				): Promise<SynthCompoundTable> {
					if (!importedTableSchema) {
						throw new Error(`Table ${schemaName}.${tableName} connected without a schema`);
					}
					return new SynthCompoundTable(cdb, this, importedTableSchema);
				}

				async destroy(): Promise<void> { /* store is per-instance */ }

				getBestAccessPlan(_cdb: Database, tableInfo: TableSchema, request: BestAccessPlanRequest): BestAccessPlanResult {
					const v1Idx = tableInfo.columnIndexMap.get('v1')!;
					const v2Idx = tableInfo.columnIndexMap.get('v2')!;
					const descriptor: IndexDescriptor = {
						name: SYNTH2,
						role: 'secondary',
						keyColumns: [
							{ columnIndex: v1Idx, desc: false },
							{ columnIndex: v2Idx, desc: false },
						],
						unique: false,
						reverse: this.reverse,
					};
					return AccessPlanBuilder.fullScan(request.estimatedRows ?? 100)
						.setHandledFilters(new Array(request.filters.length).fill(false))
						.setIndexName(SYNTH2)
						.setIndexDescriptor(descriptor)
						.setExplanation('SynthCompoundModule walk under a minted compound secondary index name')
						.build();
				}
			}

			function synthFilter2(v1Idx: number, v2Idx: number, reverse = false): FilterInfo {
				const idxStr = `idx=${SYNTH2}(0,1);plan=0`;
				const base = makeFullScanFilterInfo();
				return {
					...base,
					idxStr,
					accessPath: {
						kind: 'index',
						plan: 'scan',
						index: {
							name: SYNTH2,
							role: 'secondary',
							keyColumns: [
								{ columnIndex: v1Idx, desc: false },
								{ columnIndex: v2Idx, desc: false },
							],
							unique: false,
							reverse,
						},
					},
					indexInfoOutput: { ...base.indexInfoOutput, idxStr },
				};
			}

			let cdb: Database | undefined;

			afterEach(async () => { await cdb?.close(); cdb = undefined; });

			async function stageCompound(committedInsert: string, overlayRows: Row[], reverse = false): Promise<{ table: IsolatedTable; v1Idx: number; v2Idx: number }> {
				cdb = new Database();
				const iso = new IsolationModule({ underlying: new SynthCompoundModule(reverse) });
				cdb.registerModule('isolated', iso);
				await cdb.exec('create table t2 (id integer primary key, v1 text, v2 text) using isolated');
				await cdb.exec(committedInsert); // autocommit → flushed to the underlying

				const underlying = iso.getUnderlyingState('main', 't2')!.underlyingTable;
				const overlay = await iso.overlayModule.create(cdb, iso.createOverlaySchema(underlying.tableSchema!));
				for (const row of overlayRows) {
					await overlay.update({ operation: 'insert', values: row });
				}
				iso.setConnectionOverlay(cdb, 'main', 't2', { overlayTable: overlay, hasChanges: true, db: cdb });

				const v1Idx = underlying.tableSchema!.columnIndexMap.get('v1')!;
				const v2Idx = underlying.tableSchema!.columnIndexMap.get('v2')!;
				const table = await iso.connect(cdb, undefined, 'isolated', 'main', 't2', {} as unknown as BaseModuleConfig) as IsolatedTable;
				return { table, v1Idx, v2Idx };
			}

			it('reverse:true negates the WHOLE (v1, v2, PK) tuple, not just the leading key column', async () => {
				const { table, v1Idx, v2Idx } = await stageCompound(
					"insert into t2 values (1,'g','10'),(2,'g','20'),(3,'g','30')",
					[
						[4, 'g', '15', 0],   // staged insert
						[5, 'g', '25', 0],   // staged insert
						[3, 'g', '05', 0],   // staged update of id=3: v2 30 -> 05
					],
					true,
				);

				const rows = await asyncIterableToArray(table.query!(synthFilter2(v1Idx, v2Idx, true)));

				// Descending (v1, v2): every row shares v1='g', so this also pins the
				// trailing-key-column ordering, not merely the leading column.
				expect(rows.map(r => [r[0], r[2]])).to.deep.equal([
					['5', '25'], ['2', '20'], ['4', '15'], ['1', '10'], ['3', '05'],
				].map(([id, v2]) => [Number(id), v2]));
			});

			it('reverse:true reverses the PK tie-break within an equal-(v1,v2) group', async () => {
				const { table, v1Idx, v2Idx } = await stageCompound(
					"insert into t2 values (1,'g','same'),(2,'g','same'),(10,'g','zed')",
					[
						[3, 'g', 'same', 0],
						[4, 'g', 'same', 0],
					],
					true,
				);

				const rows = await asyncIterableToArray(table.query!(synthFilter2(v1Idx, v2Idx, true)));

				// desc by (v1, v2): 'zed' first, then every 'same' with PK descending
				// (staged 4, 3 interleaved above committed 2, 1) — a fix that only flipped
				// the leading key-column comparator (leaving the PK tail ascending) would
				// scramble this group.
				expect(rows.map(r => [r[0], r[2]])).to.deep.equal([
					[10, 'zed'], [4, 'same'], [3, 'same'], [2, 'same'], [1, 'same'],
				]);
			});
		});

		it('multi-range OR window over the synthetic name: overlay rows are filtered per range, not conjunctively', async () => {
			// buildMultiRangeWindowMatcher decodes the OR-of-ranges from the idxStr rangeOps
			// params (the constraint entries are positional GE placeholders for this plan).
			// A naive conjunctive read of those placeholders would drop EVERY valid row; this
			// pins the OR semantics for the one plan kind where getting it wrong loses data.
			const { table, vIdx } = await stage(
				"insert into t values (1,'a'),(2,'e')",   // both committed rows sit inside a range
				[
					[3, 'b', 0],   // staged insert inside range 1 ['a','b']
					[4, 'c', 0],   // staged insert BETWEEN the ranges — must be dropped
					[5, 'f', 0],   // staged insert inside range 2 ['e','f']
				],
			);

			// v in ['a','b'] OR v in ['e','f']. rangeOps encodes ge:le per range; args are
			// (lower, upper) per range in the planner's emission order.
			const base = makeFullScanFilterInfo();
			const idxStr = `idx=${SYNTH}(0);plan=6;rangeCount=2;rangeOps=ge:le,ge:le`;
			const args: SqlValue[] = ['a', 'b', 'e', 'f'];
			const filter: FilterInfo = {
				...base,
				idxStr,
				constraints: args.map((_v, i) => ({
					constraint: { iColumn: vIdx, op: IndexConstraintOp.GE, usable: true },
					argvIndex: i + 1,
				})),
				args,
				accessPath: {
					kind: 'index',
					plan: 'multiRangeSeek',
					index: { name: SYNTH, role: 'secondary', keyColumns: [{ columnIndex: vIdx, desc: false }], unique: false },
				},
				indexInfoOutput: { ...base.indexInfoOutput, idxStr },
			};

			const rows = await asyncIterableToArray(table.query!(filter));

			// (4,'c') dropped by the OR window; the rest merge in (v, pk) order. The
			// underlying does not itself range-filter here, so it is seeded only with
			// in-window committed rows.
			expect(rows.map(r => [r[0], r[1]])).to.deep.equal([[1, 'a'], [3, 'b'], [2, 'e'], [5, 'f']]);
		});
	});

	describe('schema-qualified tableName (underlying-advertised)', () => {
		// Regression: `VirtualTable.tableName` is contracted bare, but an underlying module may
		// report a schema-qualified name there (lamina-quereus does — it uses the field as a
		// catalogue/projector lookup key). IsolatedTable used to take its identity from the
		// underlying's self-reported names, so its overlay keyed as `<dbId>:main.main.widget`
		// while `underlyingTables` held `main.widget`. The commit flush looks the overlay key up
		// in `underlyingTables`, missed, hit the `continue`, and dropped every staged row — while
		// still reporting the commit as successful. Reads on the same connection still merged the
		// overlay, so the loss was invisible until something else read the storage.

		type UnderlyingTable = Awaited<ReturnType<MemoryTableModule['create']>>;

		/** Wraps a MemoryTable so it self-reports a schema-qualified `tableName`. Every other
		 *  member forwards to the real table (bound to it, so private fields resolve). */
		function qualify(table: UnderlyingTable): UnderlyingTable {
			return new Proxy(table, {
				get(target, prop) {
					if (prop === 'tableName') return `${target.schemaName}.${target.tableName}`;
					const value = Reflect.get(target, prop, target);
					return typeof value === 'function' ? value.bind(target) : value;
				},
			});
		}

		/** Underlying module whose tables report a qualified `tableName`. Keeps the RAW tables so
		 *  a test can read storage directly, bypassing the isolation layer's overlay merge. */
		class QualifiedNameMemoryModule extends MemoryTableModule {
			/** Raw (un-proxied) tables, keyed `<schema>.<table>`. Named `rawTables` because the
			 *  base class already owns `tables` (its manager registry). */
			readonly rawTables = new Map<string, UnderlyingTable>();

			private track(table: UnderlyingTable): UnderlyingTable {
				this.rawTables.set(`${table.schemaName}.${table.tableName}`.toLowerCase(), table);
				return qualify(table);
			}
			override async create(...args: Parameters<MemoryTableModule['create']>): Promise<UnderlyingTable> {
				return this.track(await super.create(...args));
			}
			override async connect(...args: Parameters<MemoryTableModule['connect']>): Promise<UnderlyingTable> {
				return this.track(await super.connect(...args));
			}
		}

		let qdb: Database;
		let underlyingModule: QualifiedNameMemoryModule;

		beforeEach(() => {
			qdb = new Database();
			underlyingModule = new QualifiedNameMemoryModule();
			qdb.registerModule('isolated', new IsolationModule({ underlying: underlyingModule }));
		});

		/** Reads the raw underlying storage, bypassing IsolatedTable entirely. */
		async function readUnderlying(qualifiedName: string): Promise<Row[]> {
			const table = underlyingModule.rawTables.get(qualifiedName);
			expect(table, `underlying table '${qualifiedName}' was created`).to.not.be.undefined;
			return await asyncIterableToArray(table!.query!(makeFullScanFilterInfo()));
		}

		it('an autocommitted insert reaches the underlying storage', async () => {
			await qdb.exec(`CREATE TABLE widget (id INTEGER PRIMARY KEY, name TEXT) USING isolated`);
			await qdb.exec(`INSERT INTO widget VALUES (1, 'a')`);

			// Through the isolation layer (overlay merge) — passed even before the fix.
			const viaIso = await asyncIterableToArray(qdb.eval(`SELECT id, name FROM widget`));
			expect(viaIso.map((r: any) => [r.id, r.name])).to.deep.equal([[1, 'a']]);

			// Through the underlying — where the row must actually be. 0 rows before the fix.
			expect(await readUnderlying('main.widget'), 'row reached the underlying storage')
				.to.deep.equal([[1, 'a']]);
		});

		it('an explicit COMMIT flushes inserts, updates and deletes to the underlying storage', async () => {
			await qdb.exec(`CREATE TABLE widget (id INTEGER PRIMARY KEY, name TEXT) USING isolated`);
			await qdb.exec(`INSERT INTO widget VALUES (1, 'a'), (2, 'b')`);

			await qdb.exec('BEGIN');
			await qdb.exec(`INSERT INTO widget VALUES (3, 'c')`);
			await qdb.exec(`UPDATE widget SET name = 'b2' WHERE id = 2`);
			await qdb.exec(`DELETE FROM widget WHERE id = 1`);
			await qdb.exec('COMMIT');

			expect(await readUnderlying('main.widget')).to.deep.equal([[2, 'b2'], [3, 'c']]);
		});

		it('a ROLLBACK still discards staged rows from the underlying storage', async () => {
			await qdb.exec(`CREATE TABLE widget (id INTEGER PRIMARY KEY, name TEXT) USING isolated`);

			await qdb.exec('BEGIN');
			await qdb.exec(`INSERT INTO widget VALUES (1, 'a')`);
			await qdb.exec('ROLLBACK');

			expect(await readUnderlying('main.widget')).to.deep.equal([]);
		});

		it('the isolated table exposes the bare connect-time tableName, not the underlying qualified one', async () => {
			await qdb.exec(`CREATE TABLE widget (id INTEGER PRIMARY KEY, name TEXT) USING isolated`);

			const isolationModule = new IsolationModule({ underlying: underlyingModule });
			const isolated = await isolationModule.connect(
				qdb, null, 'isolated', 'main', 'widget', {} as BaseModuleConfig,
			);
			expect(isolated).to.be.instanceOf(IsolatedTable);
			expect(isolated.schemaName).to.equal('main');
			expect(isolated.tableName).to.equal('widget');
		});

		it('createBacking keys the wrapper off the tableSchema, not the underlying qualified name', async () => {
			// The createBacking forward is the third IsolatedTable construction site. It only
			// exists when the underlying declares createBacking, which MemoryTableModule does
			// not — so give a qualifying underlying one, and assert the wrapper's identity
			// agrees with the `underlyingTables` key the same call registered.
			class BackingQualifiedModule extends QualifiedNameMemoryModule {
				async createBacking(callDb: Database, tableSchema: TableSchema): Promise<UnderlyingTable> {
					return this.create(callDb, tableSchema);
				}
			}
			const backingUnderlying = new BackingQualifiedModule();
			const isolationModule = new IsolationModule({ underlying: backingUnderlying });
			const backingDb = new Database();
			backingDb.registerModule('isolated', isolationModule);
			await backingDb.exec(`CREATE TABLE src (id INTEGER PRIMARY KEY, v TEXT) USING isolated`);

			const srcSchema = backingDb.schemaManager.getTable('main', 'src');
			expect(srcSchema, 'source schema resolved').to.exist;
			const backingSchema = { ...srcSchema!, name: 'src_backing' };

			const backing = await isolationModule.createBacking!(backingDb, backingSchema);
			expect(backing.schemaName).to.equal('main');
			expect(backing.tableName).to.equal('src_backing');
			// The same call registered the underlying under this pair — the two must agree,
			// or the commit flush cannot cross from an overlay key to its underlying.
			expect(isolationModule.getUnderlyingState('main', 'src_backing'), 'underlying keyed by the same pair')
				.to.not.be.undefined;
		});
	});

	describe('atomic multi-table commit (torn-commit fix)', () => {
		type UnderlyingTable = Awaited<ReturnType<MemoryTableModule['create']>>;

		// A memory module that injects a flush failure: when armed for a table, that
		// table's underlying `update` throws on the commit-flush path — marked by the
		// `trustedWrite` flag the isolation flush sets — while ordinary user DML (which
		// never sets `trustedWrite`) passes through untouched. This reproduces "a later
		// table's flush fails after an earlier table already committed" without needing
		// a real IO fault.
		class FaultyFlushModule extends MemoryTableModule {
			/** Underlying table name whose commit-flush write should throw (null = never). */
			failOnTable: string | null = null;

			override async create(...args: Parameters<MemoryTableModule['create']>): Promise<UnderlyingTable> {
				return this.wrap(await super.create(...args));
			}
			override async connect(...args: Parameters<MemoryTableModule['connect']>): Promise<UnderlyingTable> {
				return this.wrap(await super.connect(...args));
			}

			private wrap(table: UnderlyingTable): UnderlyingTable {
				// eslint-disable-next-line @typescript-eslint/no-this-alias
				const module = this;
				return new Proxy(table, {
					get(target, prop) {
						if (prop === 'update') {
							return (updateArgs: UpdateArgs) => {
								if (updateArgs.trustedWrite && module.failOnTable === target.tableName) {
									throw new QuereusError(`injected flush failure on '${target.tableName}'`, StatusCode.IOERR);
								}
								return target.update(updateArgs);
							};
						}
						const value = Reflect.get(target, prop, target);
						return typeof value === 'function' ? value.bind(target) : value;
					},
				});
			}
		}

		let underlying: FaultyFlushModule;
		let tdb: Database;

		beforeEach(async () => {
			underlying = new FaultyFlushModule();
			tdb = new Database();
			// The faulty memory module is the UNDERLYING; the isolation layer wraps it.
			tdb.registerModule('isolated', new IsolationModule({ underlying }));
			await tdb.exec(`CREATE TABLE a (id INTEGER PRIMARY KEY, v TEXT) USING isolated`);
			await tdb.exec(`CREATE TABLE b (id INTEGER PRIMARY KEY, v TEXT) USING isolated`);
		});

		async function rows(table: string): Promise<Array<[unknown, unknown]>> {
			const out = await asyncIterableToArray(tdb.eval(`SELECT id, v FROM ${table} ORDER BY id`));
			return out.map((r: any) => [r.id, r.v]);
		}

		async function expectCommitThrows(): Promise<void> {
			let threw = false;
			try {
				await tdb.exec('COMMIT');
			} catch {
				threw = true;
			}
			expect(threw, 'COMMIT should surface the injected flush failure').to.be.true;
		}

		it('happy path: a multi-table commit persists every table', async () => {
			await tdb.exec('BEGIN');
			await tdb.exec(`INSERT INTO a VALUES (1, 'a1')`);
			await tdb.exec(`INSERT INTO b VALUES (1, 'b1')`);
			await tdb.exec('COMMIT');

			expect(await rows('a')).to.deep.equal([[1, 'a1']]);
			expect(await rows('b')).to.deep.equal([[1, 'b1']]);
		});

		it('a failure flushing the SECOND table aborts the whole commit atomically', async () => {
			// The reproduced defect: table a flushed+committed before b's flush failed,
			// leaving a durably committed and the transaction torn. Both must be empty.
			underlying.failOnTable = 'b';
			await tdb.exec('BEGIN');
			await tdb.exec(`INSERT INTO a VALUES (1, 'a1')`);
			await tdb.exec(`INSERT INTO b VALUES (1, 'b1')`);

			await expectCommitThrows();

			expect(await rows('a'), 'table a must NOT be left committed').to.deep.equal([]);
			expect(await rows('b')).to.deep.equal([]);
		});

		it('a failure flushing the FIRST table aborts the whole commit atomically', async () => {
			// Order-independence: the failure firing on the first-applied table must also
			// abort cleanly, leaving the second table (never flushed) empty too.
			underlying.failOnTable = 'a';
			await tdb.exec('BEGIN');
			await tdb.exec(`INSERT INTO a VALUES (1, 'a1')`);
			await tdb.exec(`INSERT INTO b VALUES (1, 'b1')`);

			await expectCommitThrows();

			expect(await rows('a')).to.deep.equal([]);
			expect(await rows('b')).to.deep.equal([]);
		});

		it('an aborted multi-table commit leaves pre-existing committed rows intact', async () => {
			// Durable baseline (autocommit, before the fault is armed).
			await tdb.exec(`INSERT INTO a VALUES (1, 'a1')`);
			await tdb.exec(`INSERT INTO b VALUES (1, 'b1')`);
			underlying.failOnTable = 'b';

			await tdb.exec('BEGIN');
			await tdb.exec(`INSERT INTO a VALUES (2, 'a2')`);
			await tdb.exec(`UPDATE b SET v = 'b1-mod' WHERE id = 1`);

			await expectCommitThrows();

			// The transaction's staged changes are discarded; the pre-transaction state stands.
			expect(await rows('a'), 'table a keeps only its pre-transaction row').to.deep.equal([[1, 'a1']]);
			expect(await rows('b'), 'table b keeps its pre-transaction value').to.deep.equal([[1, 'b1']]);
		});

		it('a single-table commit still persists (degenerate one-overlay case unchanged)', async () => {
			await tdb.exec('BEGIN');
			await tdb.exec(`INSERT INTO a VALUES (1, 'a1'), (2, 'a2')`);
			await tdb.exec('COMMIT');

			expect(await rows('a')).to.deep.equal([[1, 'a1'], [2, 'a2']]);
			expect(await rows('b')).to.deep.equal([]);
		});
	});
	describe('DESC primary key (overlay/underlying merge ordering)', () => {
		// Regression: the merge aligns overlay and underlying entries by a PK comparator, so
		// that comparator must reproduce the underlying's NATIVE key order. A `primary key
		// (k desc)` table scans descending, but both the memory table's `comparePrimaryKey`
		// and the isolation layer's own fallback compared ascending — the merge never lined
		// the two streams up, so a staged UPDATE surfaced alongside the base row it replaces.

		type UnderlyingTable = Awaited<ReturnType<MemoryTableModule['create']>>;

		/** Hides `comparePrimaryKey` so `IsolatedTable` takes its fallback comparator — the
		 *  arm every store-backed underlying (which exposes none) takes. */
		function hideComparePk(table: UnderlyingTable): UnderlyingTable {
			return new Proxy(table, {
				get(target, prop) {
					if (prop === 'comparePrimaryKey') return undefined;
					const value = Reflect.get(target, prop, target);
					return typeof value === 'function' ? value.bind(target) : value;
				},
				has(target, prop) {
					return prop === 'comparePrimaryKey' ? false : Reflect.has(target, prop);
				},
			});
		}

		class NoComparatorMemoryModule extends MemoryTableModule {
			override async create(...args: Parameters<MemoryTableModule['create']>): Promise<UnderlyingTable> {
				return hideComparePk(await super.create(...args));
			}
			override async connect(...args: Parameters<MemoryTableModule['connect']>): Promise<UnderlyingTable> {
				return hideComparePk(await super.connect(...args));
			}
		}

		async function rowsOf(target: Database, sql: string): Promise<SqlValue[][]> {
			return (await asyncIterableToArray(target.eval(sql))).map(r => Object.values(r) as SqlValue[]);
		}

		/** Exercises the merge over a DESC PK for one underlying module. */
		function describeUnderlying(label: string, makeModule: () => MemoryTableModule): void {
			describe(label, () => {
				let ddb: Database;
				beforeEach(async () => {
					ddb = new Database();
					ddb.registerModule('isolated', new IsolationModule({ underlying: makeModule() }));
					await ddb.exec(`create table t (k integer, v text, primary key (k desc)) using isolated`);
					await ddb.exec(`insert into t values (1, 'a'), (2, 'b'), (3, 'c')`);
				});
				afterEach(async () => { await ddb.close(); });

				it('scans committed rows in descending key order', async () => {
					expect(await rowsOf(ddb, `select k, v from t`)).to.deep.equal([[3, 'c'], [2, 'b'], [1, 'a']]);
				});

				it('shadows the base row exactly once when a staged update rewrites a non-key column', async () => {
					await ddb.exec('begin');
					await ddb.exec(`update t set v = 'B' where k = 2`);
					expect(await rowsOf(ddb, `select k, v from t`)).to.deep.equal([[3, 'c'], [2, 'B'], [1, 'a']]);
					await ddb.exec('rollback');
					expect(await rowsOf(ddb, `select k, v from t`)).to.deep.equal([[3, 'c'], [2, 'b'], [1, 'a']]);
				});

				it('hides a deleted base row and orders a staged insert into place', async () => {
					await ddb.exec('begin');
					await ddb.exec(`delete from t where k = 3`);
					await ddb.exec(`insert into t values (4, 'd')`);
					expect(await rowsOf(ddb, `select k, v from t`)).to.deep.equal([[4, 'd'], [2, 'b'], [1, 'a']]);
					await ddb.exec('commit');
					expect(await rowsOf(ddb, `select k, v from t`)).to.deep.equal([[4, 'd'], [2, 'b'], [1, 'a']]);
				});
			});
		}

		// The underlying exposes `comparePrimaryKey`; the isolation layer adopts it.
		describeUnderlying('underlying supplies comparePrimaryKey (MemoryTable)', () => new MemoryTableModule());
		// The underlying exposes none; IsolatedTable's own fallback comparator must agree.
		describeUnderlying('underlying supplies no comparePrimaryKey (store-shaped)', () => new NoComparatorMemoryModule());

		it('orders a composite mixed-direction key by the declared directions', async () => {
			const mdb = new Database();
			mdb.registerModule('isolated', new IsolationModule({ underlying: new MemoryTableModule() }));
			await mdb.exec(`create table t (a integer, b integer, v text, primary key (a desc, b)) using isolated`);
			await mdb.exec(`insert into t values (1, 1, 'x'), (1, 2, 'y'), (2, 1, 'z')`);

			await mdb.exec('begin');
			await mdb.exec(`update t set v = 'Y' where a = 1 and b = 2`);
			expect(await rowsOf(mdb, `select a, b, v from t`)).to.deep.equal([[2, 1, 'z'], [1, 1, 'x'], [1, 2, 'Y']]);
			await mdb.exec('rollback');
			await mdb.close();
		});
	});

	describe('overlay indexes and UNIQUE constraints scoped to live rows', () => {
		// Regression: a tombstone (a deletion marker: the deleted row's PK, NULL in every
		// other column) was enforced by the overlay's own UNIQUE structures as if it were a
		// live row. Invisible whenever a UNIQUE structure covered a non-PK column (its
		// tombstone value is NULL, and SQL treats NULLs as distinct) — the fix narrows every
		// copied index/UNIQUE constraint in the overlay schema to `<tombstone> = 0` so it
		// only ever sees live rows.
		let db: Database;
		let isolatedModule: IsolationModule;

		beforeEach(() => {
			db = new Database();
			const memoryModule = new MemoryTableModule();
			isolatedModule = new IsolationModule({
				underlying: memoryModule,
			});
			db.registerModule('isolated', isolatedModule);
		});

		afterEach(async () => {
			await db.close();
		});

		it('delete-then-reinsert under a PK-covered UNIQUE index commits the reinserted row', async () => {
			await db.exec(`create table t (a integer, b integer, primary key (a, b)) using isolated`);
			await db.exec(`create unique index t_a_ux on t (a)`);
			await db.exec(`insert into t values (1, 1)`);

			await db.exec('begin');
			await db.exec('delete from t where a = 1 and b = 1');
			await db.exec('insert into t values (1, 2)');
			await db.exec('commit');

			const rows = await asyncIterableToArray(db.eval('select a, b from t'));
			expect(rows.map(r => [r.a, r.b])).to.deep.equal([[1, 2]]);
		});

		it('create unique index inside a transaction over a fully tombstoned table commits empty', async () => {
			await db.exec(`create table t (a integer, b integer, primary key (a, b)) using isolated`);
			await db.exec(`insert into t values (1, 1)`);
			await db.exec(`insert into t values (1, 2)`);

			await db.exec('begin');
			await db.exec('delete from t');
			// Pre-fix: rebuilding the overlay for the new index enforced uniqueness over the
			// two tombstones just staged (both carry a = 1) and raised INTERNAL.
			await db.exec('create unique index t_a_ux on t (a)');
			await db.exec('commit');

			const rows = await asyncIterableToArray(db.eval('select * from t'));
			expect(rows.length).to.equal(0);
		});

		it('pins the already-working non-PK UNIQUE column case (tombstone key is NULL)', async () => {
			await db.exec(`create table t (a integer primary key, b integer) using isolated`);
			await db.exec(`create unique index t_b_ux on t (b)`);
			await db.exec(`insert into t values (1, 1)`);

			await db.exec('begin');
			await db.exec('delete from t where a = 1');
			await db.exec('insert into t values (2, 1)');
			await db.exec('commit');

			const rows = await asyncIterableToArray(db.eval('select a, b from t'));
			expect(rows.map(r => [r.a, r.b])).to.deep.equal([[2, 1]]);
		});

		it('a pre-existing partial UNIQUE index still lets out-of-scope rows collide and still rejects in-scope duplicates', async () => {
			await db.exec(`create table t (id integer primary key, a integer, b integer) using isolated`);
			await db.exec(`create unique index t_a_ux on t (a) where b > 0`);

			// Both outside the predicate's scope (b <= 0) — the duplicate 'a' escapes enforcement.
			await db.exec(`insert into t values (1, 5, -1)`);
			await db.exec(`insert into t values (2, 5, -1)`);
			const outOfScope = await asyncIterableToArray(db.eval('select id from t where a = 5 order by id'));
			expect(outOfScope.map(r => r.id)).to.deep.equal([1, 2]);

			await db.exec('begin');
			await db.exec(`insert into t values (3, 7, 1)`);
			let err: unknown;
			try {
				await db.exec(`insert into t values (4, 7, 1)`);
			} catch (e) {
				err = e;
			}
			expect(err, 'an in-scope duplicate staged inside the transaction must still be rejected').to.be.instanceOf(QuereusError);
			expect((err as QuereusError).code).to.equal(StatusCode.CONSTRAINT);
			await db.exec('rollback');
		});

		it('a table-level UNIQUE(...) over PK columns commits a delete-then-reinsert of the same key', async () => {
			await db.exec(`create table t (a integer, b integer, primary key (a, b), unique (a, b)) using isolated`);
			await db.exec(`insert into t values (1, 1)`);

			await db.exec('begin');
			await db.exec('delete from t where a = 1 and b = 1');
			await db.exec('insert into t values (1, 2)');
			await db.exec('commit');

			const rows = await asyncIterableToArray(db.eval('select a, b from t'));
			expect(rows.map(r => [r.a, r.b])).to.deep.equal([[1, 2]]);
		});

		it('still rejects two live overlay rows colliding on a UNIQUE index', async () => {
			await db.exec(`create table t (id integer primary key, a integer) using isolated`);
			await db.exec(`create unique index t_a_ux on t (a)`);

			await db.exec('begin');
			await db.exec(`insert into t values (1, 5)`);
			let err: unknown;
			try {
				await db.exec(`insert into t values (2, 5)`);
			} catch (e) {
				err = e;
			}
			expect(err, 'narrowing to live rows must not disable enforcement within the overlay').to.be.instanceOf(QuereusError);
			expect((err as QuereusError).code).to.equal(StatusCode.CONSTRAINT);
			await db.exec('rollback');
		});

		it('still rejects two live overlay rows colliding on a table-level UNIQUE(...)', async () => {
			await db.exec(`create table t (id integer primary key, a integer, unique (a)) using isolated`);

			await db.exec('begin');
			await db.exec(`insert into t values (1, 5)`);
			let err: unknown;
			try {
				await db.exec(`insert into t values (2, 5)`);
			} catch (e) {
				err = e;
			}
			expect(err, 'narrowing to live rows must not disable enforcement within the overlay').to.be.instanceOf(QuereusError);
			expect((err as QuereusError).code).to.equal(StatusCode.CONSTRAINT);
			await db.exec('rollback');
		});

		it('reusing a tombstoned PK inside the transaction overwrites it rather than raising or resurrecting the old row', async () => {
			await db.exec(`create table t (id integer primary key, name text) using isolated`);
			await db.exec(`insert into t values (1, 'Alice')`);

			await db.exec('begin');
			await db.exec(`delete from t where id = 1`);
			await db.exec(`insert into t values (1, 'Bob')`);

			const midTxn = await asyncIterableToArray(db.eval('select id, name from t'));
			expect(midTxn.map(r => [r.id, r.name])).to.deep.equal([[1, 'Bob']]);

			await db.exec('commit');

			const committed = await asyncIterableToArray(db.eval('select id, name from t'));
			expect(committed.map(r => [r.id, r.name])).to.deep.equal([[1, 'Bob']]);
		});

		it('a merged secondary-index scan shows neither a staged delete nor a stale pre-update value', async () => {
			await db.exec(`create table t (id integer primary key, cat text, val text) using isolated`);
			await db.exec(`create index t_cat_ix on t (cat)`);
			await db.exec(`insert into t values (1, 'x', 'old1')`);
			await db.exec(`insert into t values (2, 'x', 'old2')`);
			await db.exec(`insert into t values (3, 'x', 'old3')`);

			await db.exec('begin');
			await db.exec(`delete from t where id = 1`);
			await db.exec(`update t set val = 'new2' where id = 2`);

			const rows = await asyncIterableToArray(
				db.eval(`select id, val from t where cat = 'x' order by id`)
			);
			expect(rows.map(r => [r.id, r.val])).to.deep.equal([[2, 'new2'], [3, 'old3']]);

			await db.exec('commit');
		});

		it('a live overlay row deleted in the same transaction releases its UNIQUE value', async () => {
			// The row never existed underneath, so the delete rewrites a LIVE overlay row into
			// a tombstone. The narrowed index must drop that row's entry on the transition,
			// otherwise the value stays claimed for the rest of the transaction.
			await db.exec(`create table t (id integer primary key, a integer) using isolated`);
			await db.exec(`create unique index t_a_ux on t (a)`);

			await db.exec('begin');
			await db.exec(`insert into t values (1, 5)`);
			await db.exec(`delete from t where id = 1`);
			await db.exec(`insert into t values (2, 5)`);
			await db.exec('commit');

			const rows = await asyncIterableToArray(db.eval('select id, a from t'));
			expect(rows.map(r => [r.id, r.a])).to.deep.equal([[2, 5]]);
		});

		it('a committed row deleted then its UNIQUE value reused at a new PK under a PK-covered index', async () => {
			// Tombstone (from a committed row) and a live overlay row share the PK-covered
			// UNIQUE column value `a = 1` simultaneously.
			await db.exec(`create table t (a integer, b integer, primary key (a, b)) using isolated`);
			await db.exec(`create unique index t_a_ux on t (a)`);
			await db.exec(`insert into t values (1, 1)`);
			await db.exec(`insert into t values (2, 1)`);

			await db.exec('begin');
			await db.exec('delete from t where a = 1');
			await db.exec('insert into t values (1, 9)');
			// The surviving live row (2, 1) still claims a = 2; a duplicate must be rejected.
			let err: unknown;
			try {
				await db.exec('insert into t values (2, 9)');
			} catch (e) {
				err = e;
			}
			expect(err, 'a live/live duplicate must still be rejected across the merged view').to.be.instanceOf(QuereusError);
			expect((err as QuereusError).code).to.equal(StatusCode.CONSTRAINT);
			await db.exec('rollback');

			const rows = await asyncIterableToArray(db.eval('select a, b from t order by a, b'));
			expect(rows.map(r => [r.a, r.b])).to.deep.equal([[1, 1], [2, 1]]);
		});

		it('an update that vacates a UNIQUE value inside a transaction frees it for a new row', async () => {
			await db.exec(`create table t (id integer primary key, a integer) using isolated`);
			await db.exec(`create unique index t_a_ux on t (a)`);
			await db.exec(`insert into t values (1, 5)`);

			await db.exec('begin');
			await db.exec(`update t set a = 6 where id = 1`);
			await db.exec(`insert into t values (2, 5)`);
			await db.exec('commit');

			const rows = await asyncIterableToArray(db.eval('select id, a from t order by id'));
			expect(rows.map(r => [r.id, r.a])).to.deep.equal([[1, 6], [2, 5]]);
		});
	});
});

// ===========================================================================
// Two-phase merged UNIQUE check (index seek).
//
// A non-PK UNIQUE check runs against the MERGED view — the underlying committed
// rows with this connection's uncommitted overlay superimposed. The check splits
// that view into two disjoint halves: Phase 1 scans the small in-memory overlay,
// Phase 2 seeks (or, when it may not seek, full-scans) the large underlying,
// skipping any PK the overlay already owns. Phase 2 seeks only an index-derived
// UNIQUE whose enforcement collation is BINARY (the store's index key bytes ignore
// the collation registry, so a NOCASE seek would miss committed case-variants).
// ===========================================================================
describe('IsolationModule — two-phase merged UNIQUE check (index seek)', () => {
	let db: Database;
	let iso: IsolationModule;

	beforeEach(() => {
		db = new Database();
		iso = new IsolationModule({ underlying: new MemoryTableModule() });
		db.registerModule('isolated', iso);
	});

	afterEach(async () => {
		await db.close();
	});

	async function expectConstraint(sql: string): Promise<void> {
		let err: unknown;
		try { await db.exec(sql); } catch (e) { err = e; }
		expect(err, `expected UNIQUE violation from: ${sql}`).to.be.instanceOf(QuereusError);
		expect((err as QuereusError).code).to.equal(StatusCode.CONSTRAINT);
	}

	async function connect(table: string): Promise<IsolatedTable> {
		return await iso.connect(db, undefined, 'isolated', 'main', table, {} as BaseModuleConfig) as IsolatedTable;
	}

	// Each merged-view scenario must hold identically whether the UNIQUE is a bare
	// table-level constraint (no backing index ⇒ Phase 2 full-scans) or index-derived
	// (Phase 2 seeks `ux`). Parameterise over both so the seek arm and the scan arm are
	// each proven correct on every scenario.
	const variants = [
		{
			label: 'table-level unique(email), no backing index (Phase 2 full-scans)',
			create: async () => {
				await db.exec(`create table t (id integer primary key, email text, unique(email)) using isolated`);
			},
		},
		{
			label: 'create unique index ux on t(email) (Phase 2 seeks)',
			create: async () => {
				await db.exec(`create table t (id integer primary key, email text) using isolated`);
				await db.exec(`create unique index ux on t(email)`);
			},
		},
	];

	for (const variant of variants) {
		describe(variant.label, () => {
			beforeEach(async () => { await variant.create(); });

			it('overlay-side conflict: a value staged onto #7 this txn still collides (Phase 1)', async () => {
				await db.exec(`insert into t values (7, 'a@x')`);          // committed
				await db.exec('begin');
				await db.exec(`update t set email = 'b@x' where id = 7`);   // overlay: #7 now 'b@x'
				// A naive seek of the UNDERLYING for 'b@x' finds nothing — it still holds 'a@x'
				// at #7. The merged view holds 'b@x' at #7, and Phase 1's overlay scan catches it.
				await expectConstraint(`insert into t values (8, 'b@x')`);
				await db.exec('rollback');
			});

			it('overlay-side resolution: a value the underlying still shows for #7 is free once #7 moved off it (Phase 2 skips overlaid PK)', async () => {
				await db.exec(`insert into t values (7, 'a@x')`);          // committed
				await db.exec('begin');
				await db.exec(`update t set email = 'z@x' where id = 7`);   // overlay: #7 now 'z@x'
				// Underlying still shows 'a@x' at #7, but #7 has an overlay entry, so Phase 2
				// skips it — 'a@x' is free in the merged view.
				await db.exec(`insert into t values (8, 'a@x')`);
				await db.exec('commit');
				const rows = await asyncIterableToArray(db.eval(`select id, email from t order by id`));
				expect(rows.map(r => [r.id, r.email])).to.deep.equal([[7, 'z@x'], [8, 'a@x']]);
			});

			it('tombstoned conflict: a deleted #7 releases its value (Phase 1 skips tombstone, Phase 2 skips overlaid PK)', async () => {
				await db.exec(`insert into t values (7, 'a@x')`);          // committed
				await db.exec('begin');
				await db.exec(`delete from t where id = 7`);                // overlay tombstone at #7
				await db.exec(`insert into t values (8, 'a@x')`);           // must NOT conflict
				await db.exec('commit');
				const rows = await asyncIterableToArray(db.eval(`select id, email from t order by id`));
				expect(rows.map(r => [r.id, r.email])).to.deep.equal([[8, 'a@x']]);
			});

			it('tombstone revival: reviving #7 into a committed value still collides (selfPks honored in both phases)', async () => {
				await db.exec(`insert into t values (7, 'a@x')`);          // committed
				await db.exec(`insert into t values (9, 'y@x')`);          // committed
				await db.exec('begin');
				await db.exec(`delete from t where id = 7`);                // tombstone #7
				// Revive #7 (selfPks = [[7]]) with the value committed at #9 → conflict with #9.
				// Phase 1 skips the #7 tombstone; Phase 2 finds #9 (not in selfPks, no overlay entry).
				await expectConstraint(`insert into t values (7, 'y@x')`);
				await db.exec('rollback');
			});
		});
	}

	it('collate nocase SEEKS and still catches a case-only committed collision', async () => {
		await db.exec(`create table t (id integer primary key, email text) using isolated`);
		await db.exec(`create unique index ux on t(email collate nocase)`);
		await db.exec(`insert into t values (1, 'b@x')`);   // committed
		await db.exec('begin');
		// 'B@X' == 'b@x' under NOCASE. The seek gate used to demand BINARY and full-scan
		// here, because the store's index bytes were keyed under a table-wide collation
		// that ignored the column's. Both backends now key `ux` under its own NOCASE, so
		// the seek window for 'B@X' contains the committed 'b@x' and the enforcement
		// comparator confirms it. Seeking is what must NOT lose the violation.
		await expectConstraint(`insert into t values (2, 'B@X')`);
		await db.exec('rollback');
	});

	it('an index INHERITING the column collation seeks under it, and still catches the collision', async () => {
		// The gate reads the ENFORCEMENT collation, which for an index with no explicit
		// COLLATE is the table column's declared one — so it admits the seek here exactly
		// as it does for `ux(email collate nocase)` above. That is only sound if the
		// backing index is really keyed NOCASE. It is, by construction and not by luck:
		// `buildIndexSchema` / `importIndex` resolve every IndexColumnSchema.collation to
		// the effective value at create time (explicit COLLATE → column collation →
		// BINARY), so `MemoryIndex`'s `specCol.collation ? resolver(…) : undefined`
		// never sees the unset case for a real index. Pin it: a BINARY-keyed `ux` would
		// miss the committed 'b@x' and admit the duplicate.
		await db.exec(`create table t (id integer primary key, email text collate nocase) using isolated`);
		await db.exec(`create unique index ux on t(email)`);
		await db.exec(`insert into t values (1, 'b@x')`);   // committed
		await db.exec('begin');
		await expectConstraint(`insert into t values (2, 'B@X')`);
		await db.exec('rollback');
	});

	it('an `any` column with a declared COLLATE seeks, and still catches the collision', async () => {
		// `any` keys under its declared NOCASE now (any-type-compare-honors-collation
		// made ANY_TYPE.compare honor the handed collation), which is also the collation
		// the merged check enforces under — so `canSeekForConstraint` admits the seek,
		// and the NOCASE seek window for 'B@X' must hold the committed 'b@x'.
		await db.exec(`create table t (id integer primary key, email any collate nocase) using isolated`);
		await db.exec(`create unique index ux on t(email)`);
		await db.exec(`insert into t values (1, 'b@x')`);   // committed
		await db.exec('begin');
		await expectConstraint(`insert into t values (2, 'B@X')`);
		await db.exec('rollback');
	});

	it('composite index-derived UNIQUE seeks with values in index-key order, not column order', async () => {
		await db.exec(`create table t (id integer primary key, a integer, b text) using isolated`);
		await db.exec(`create unique index ux on t(b, a)`);   // index key order (b, a)
		await db.exec(`insert into t values (1, 10, 'x')`);   // committed (a=10, b='x')
		await db.exec('begin');
		// Same (a, b) must conflict — the seek binds b='x' then a=10 in index-key order.
		await expectConstraint(`insert into t values (2, 10, 'x')`);
		// Differing in either composite column does not.
		await db.exec(`insert into t values (3, 10, 'y')`);
		await db.exec('commit');
		const rows = await asyncIterableToArray(db.eval(`select id from t order by id`));
		expect(rows.map(r => r.id)).to.deep.equal([1, 3]);
	});

	it('a NULL constrained value builds no seek and never conflicts (SQL NULLs are distinct)', async () => {
		await db.exec(`create table t (id integer primary key, email text null) using isolated`);
		await db.exec(`create unique index ux on t(email)`);
		await db.exec(`insert into t values (1, null)`);   // committed
		await db.exec('begin');
		// The outer guard skips the UNIQUE check when a constrained column is NULL, so no
		// seek is built for a NULL key — two NULL rows coexist.
		await db.exec(`insert into t values (2, null)`);
		await db.exec('commit');
		const rows = await asyncIterableToArray(db.eval(`select id from t order by id`));
		expect(rows.map(r => r.id)).to.deep.equal([1, 2]);
	});

	it('OR REPLACE eviction reports the same evictedRows shape for overlay-side and underlying-side conflicts', async () => {
		await db.exec(`create table u (id integer primary key, email text, unique(email)) using isolated`);
		await db.exec(`insert into u values (1, 'a@x')`);   // committed, lives only in underlying
		await db.exec(`create table o (id integer primary key, email text, unique(email)) using isolated`);
		await db.exec(`insert into o values (1, 'a@x')`);

		// Underlying-side: Phase 2 finds #1 in the underlying and REPLACE-evicts it.
		const tu = await connect('u');
		const uRes = await tu.update({ operation: 'insert', values: [2, 'a@x'], onConflict: ConflictResolution.REPLACE });

		// Overlay-side: move #1 onto 'c@x' in the overlay, then REPLACE-insert a colliding
		// 'c@x' — Phase 1 finds the overlay row and evicts it.
		const to = await connect('o');
		await to.update({ operation: 'update', values: [1, 'c@x'], oldKeyValues: [1] });
		const oRes = await to.update({ operation: 'insert', values: [2, 'c@x'], onConflict: ConflictResolution.REPLACE });

		expect(uRes.status).to.equal('ok');
		expect(oRes.status).to.equal('ok');
		const uEv = (uRes as { evictedRows?: Row[] }).evictedRows ?? [];
		const oEv = (oRes as { evictedRows?: Row[] }).evictedRows ?? [];
		// Each surfaces exactly one evicted row, in user-facing [id, email] schema shape
		// (length 2 — no stray trailing tombstone column) regardless of which phase found it.
		expect(uEv.map(r => [...r])).to.deep.equal([[1, 'a@x']]);
		expect(oEv.map(r => [...r])).to.deep.equal([[1, 'c@x']]);
		expect(uEv[0].length).to.equal(2);
		expect(oEv[0].length).to.equal(2);
	});

	it('OR REPLACE across two UNIQUE constraints: the first eviction tombstones a row the second must not re-report', async () => {
		await db.exec(`create table t (id integer primary key, a integer, b integer, unique(a), unique(b)) using isolated`);
		await db.exec(`insert into t values (1, 5, 5)`);   // collides with the new row on BOTH a and b

		const t1 = await connect('t');
		// unique(a) REPLACE-evicts #1 and tombstones it in the overlay. unique(b)'s Phase 1
		// then sees that tombstone and must skip it — #1 is evicted once, not once per constraint.
		const res = await t1.update({ operation: 'insert', values: [2, 5, 5], onConflict: ConflictResolution.REPLACE });
		expect(res.status).to.equal('ok');
		const ev = (res as { evictedRows?: Row[] }).evictedRows ?? [];
		expect(ev.map(r => [...r])).to.deep.equal([[1, 5, 5]]);
	});

	it('an index-derived UNIQUE seeks O(matches) underlying rows — collated or not; a table-level unique scans', async () => {
		type UnderlyingTable = Awaited<ReturnType<MemoryTableModule['create']>>;
		// Counts every row the underlying yields from query(). The overlay is served by a
		// SEPARATE (default) MemoryTableModule, so Phase 1's overlay scan is not counted —
		// only the underlying PK lookup and Phase 2's seek/scan are.
		class CountingMemoryModule extends MemoryTableModule {
			rowsYielded = 0;
			private wrap(table: UnderlyingTable): UnderlyingTable {
				const self = this;
				return new Proxy(table, {
					get(target, prop) {
						if (prop === 'query') {
							return async function* (filterInfo: FilterInfo) {
								for await (const row of target.query!(filterInfo)) {
									self.rowsYielded++;
									yield row;
								}
							};
						}
						const value = Reflect.get(target, prop, target);
						return typeof value === 'function' ? value.bind(target) : value;
					},
				});
			}
			override async create(...args: Parameters<MemoryTableModule['create']>): Promise<UnderlyingTable> {
				return this.wrap(await super.create(...args));
			}
			override async connect(...args: Parameters<MemoryTableModule['connect']>): Promise<UnderlyingTable> {
				return this.wrap(await super.connect(...args));
			}
		}

		const counting = new CountingMemoryModule();
		const cdb = new Database();
		const ciso = new IsolationModule({ underlying: counting });
		cdb.registerModule('isolated', ciso);
		try {
			// --- Seek arm: BINARY index-derived UNIQUE over 100 committed rows. ---
			await cdb.exec(`create table seek_t (id integer primary key, email text) using isolated`);
			await cdb.exec(`create unique index ux on seek_t(email)`);
			for (let i = 0; i < 100; i++) await cdb.exec(`insert into seek_t values (${i}, 'e${i}@x')`);

			const ts = await ciso.connect(cdb, undefined, 'isolated', 'main', 'seek_t', {} as BaseModuleConfig) as IsolatedTable;
			counting.rowsYielded = 0;
			await ts.update({ operation: 'insert', values: [1000, 'fresh@x'] });   // no collision
			const seekCount = counting.rowsYielded;
			expect(seekCount, `binary index seek must not walk the whole table (yielded ${seekCount} of 100)`).to.be.at.most(5);

			// --- Seek arm 2: a NOCASE index-derived UNIQUE seeks too. Index bytes key under
			// the index column's own collation, which for an index-derived UNIQUE IS the
			// enforcement collation, so the window is exactly the conflict set. Before
			// store-index-collation-guard-collapse this arm was the negative control.
			await cdb.exec(`create table nocase_t (id integer primary key, email text) using isolated`);
			await cdb.exec(`create unique index ux2 on nocase_t(email collate nocase)`);
			for (let i = 0; i < 100; i++) await cdb.exec(`insert into nocase_t values (${i}, 'f${i}@x')`);

			const tn = await ciso.connect(cdb, undefined, 'isolated', 'main', 'nocase_t', {} as BaseModuleConfig) as IsolatedTable;
			counting.rowsYielded = 0;
			await tn.update({ operation: 'insert', values: [1000, 'fresh2@x'] });   // no collision
			const nocaseCount = counting.rowsYielded;
			expect(nocaseCount, `a collated index-derived UNIQUE must seek too (yielded ${nocaseCount} of 100)`).to.be.at.most(5);

			// --- Scan arm: a table-level `unique(email)` has no index in the engine-facing
			// schema at all, so there is nothing to name in a seek and Phase 2 full-scans.
			// This is the negative control that proves the seek arm is what bounds the count.
			await cdb.exec(`create table scan_t (id integer primary key, email text, unique(email)) using isolated`);
			for (let i = 0; i < 100; i++) await cdb.exec(`insert into scan_t values (${i}, 'g${i}@x')`);

			const tc = await ciso.connect(cdb, undefined, 'isolated', 'main', 'scan_t', {} as BaseModuleConfig) as IsolatedTable;
			counting.rowsYielded = 0;
			await tc.update({ operation: 'insert', values: [1000, 'fresh3@x'] });   // no collision
			const scanCount = counting.rowsYielded;
			expect(scanCount, `a non-index-derived UNIQUE must decline the seek and full-scan (yielded ${scanCount})`).to.be.at.least(100);
		} finally {
			await cdb.close();
		}
	});
});

describe('IsolationModule — cross-connection isolation (read-your-own-writes; not snapshot isolation)', () => {
	// Multiple Database instances share ONE IsolationModule, so each connection gets a
	// distinct dbId while all share the same committed underlying (the MemoryTableModule
	// instance holds the base data). Only dbA carries the SQL schema; a foreign connection
	// (dbB) exists purely as a connection identity that owns its own per-connection overlay
	// and reads the shared base via iso.connect(dbB, ...). This is the white-box pattern the
	// row-validating-DDL poison suite establishes; here it is used to pin the plain
	// cross-connection READ contract and the write-write COMMIT resolution.
	//
	// The asserted contract is AGENTS.md's "read-your-own-writes; not snapshot isolation":
	//   - a connection sees its own uncommitted overlay;
	//   - a sibling connection does not, until commit;
	//   - two connections writing the same key resolve LAST-WRITER-WINS at commit time —
	//     the flush decides insert-vs-update by whether the PK already exists underlying, so
	//     the later committer overwrites the earlier one. There is no write-write conflict
	//     detection.
	//
	// NOTE: the IndexedDB plugin's settings help text advertises "snapshot isolation" — that
	// documented-vs-implemented divergence is tracked by the review's strategic rec #3. If it
	// resolves toward snapshot isolation, the write-write expectation here (last-writer-wins,
	// no abort) is exactly what would need to flip to first-committer-wins / abort. Until
	// then AGENTS.md is authoritative and these assert last-writer-wins.
	let iso: IsolationModule;
	let dbA: Database;
	let dbB: Database;

	beforeEach(async () => {
		iso = new IsolationModule({ underlying: new MemoryTableModule() });
		dbA = new Database();
		dbB = new Database();
		dbA.registerModule('isolated', iso);
		// Only dbA builds the shared underlying (columns: id, who) and seeds the committed base.
		await dbA.exec('create table t (id integer primary key, who text) using isolated');
		await dbA.exec("insert into t values (1, 'base')");
	});

	afterEach(async () => {
		await dbA.close();
		await dbB.close();
	});

	// Primary-key full-scan (idxStr === null ⇒ accessPath merges by PK). Use the engine's
	// shared builder so this scan can't drift from the real planner access path.
	const fullScan = makeFullScanFilterInfo;

	/** Stages live inserts (rows = [id, who][]) as `forDb`'s per-connection overlay. */
	async function stageInserts(forDb: Database, rows: SqlValue[][]): Promise<void> {
		const underlying = iso.getUnderlyingState('main', 't')!.underlyingTable;
		const overlay = await iso.overlayModule.create(forDb, iso.createOverlaySchema(underlying.tableSchema!));
		for (const r of rows) {
			await overlay.update({ operation: 'insert', values: [...r, 0] }); // trailing 0 = live (not tombstone)
		}
		iso.setConnectionOverlay(forDb, 'main', 't', { overlayTable: overlay, hasChanges: true, db: forDb });
	}

	async function reader(forDb: Database): Promise<IsolatedTable> {
		return await iso.connect(forDb, undefined, 'isolated', 'main', 't', {} as BaseModuleConfig) as IsolatedTable;
	}

	/** The connection's merged view as sorted [id, who] tuples. */
	async function readAll(forDb: Database): Promise<SqlValue[][]> {
		const rows = await asyncIterableToArray((await reader(forDb)).query(fullScan()));
		return rows.map(r => [r[0], r[1]] as SqlValue[]).sort((x, y) => Number(x[0]) - Number(y[0]));
	}

	it('a connection reads its own uncommitted writes; a sibling does not, until commit', async () => {
		await stageInserts(dbA, [[20, 'onlyA']]); // dbA stages an insert; dbB stages nothing.

		// Read-your-own-writes: dbA sees its staged row merged over the committed base.
		expect(await readAll(dbA)).to.deep.equal([[1, 'base'], [20, 'onlyA']]);
		// Isolation: dbB (a sibling connection) sees ONLY the committed base — not dbA's overlay.
		expect(await readAll(dbB)).to.deep.equal([[1, 'base']]);

		await iso.commitConnectionOverlays(dbA);

		// After commit dbA's write is durable, so the sibling now sees it.
		expect(await readAll(dbB)).to.deep.equal([[1, 'base'], [20, 'onlyA']]);
	});

	it('write-write on the same key resolves last-writer-wins at commit time', async () => {
		await stageInserts(dbA, [[10, 'A']]);
		await stageInserts(dbB, [[10, 'B']]);

		// In-flight, each connection reads its own staged value for the shared key.
		expect(await readAll(dbA)).to.deep.equal([[1, 'base'], [10, 'A']]);
		expect(await readAll(dbB)).to.deep.equal([[1, 'base'], [10, 'B']]);

		// dbA commits first: key 10 does not yet exist underlying ⇒ flushed as an insert (='A').
		await iso.commitConnectionOverlays(dbA);
		// dbB still reads its OWN staged 'B' over the now-committed 'A' (read-your-own-writes).
		expect(await readAll(dbB)).to.deep.equal([[1, 'base'], [10, 'B']]);

		// dbB commits second: key 10 now exists underlying ⇒ flushed as an update, overwriting
		// dbA's value. No conflict error — last writer wins.
		await iso.commitConnectionOverlays(dbB);
		expect(await readAll(dbA)).to.deep.equal([[1, 'base'], [10, 'B']]);
	});

	it('reverse commit order flips the winner, confirming order — not a fixed precedence — decides', async () => {
		await stageInserts(dbA, [[10, 'A']]);
		await stageInserts(dbB, [[10, 'B']]);

		// Same overlays, opposite commit order: dbB first, dbA second ⇒ dbA (last) wins.
		await iso.commitConnectionOverlays(dbB);
		await iso.commitConnectionOverlays(dbA);
		expect(await readAll(dbB)).to.deep.equal([[1, 'base'], [10, 'A']]);
	});

	it('a committed overlay is cleared and a redundant re-commit is a well-defined no-op', async () => {
		await stageInserts(dbA, [[30, 'x']]);
		expect(iso.getConnectionOverlay(dbA, 'main', 't')).to.exist;

		await iso.commitConnectionOverlays(dbA);
		// The overlay is discarded once flushed — no stale staged state can bleed forward.
		expect(iso.getConnectionOverlay(dbA, 'main', 't')).to.be.undefined;

		// A second commit finds nothing staged and must neither throw nor double-apply.
		await iso.commitConnectionOverlays(dbA);
		expect(await readAll(dbA)).to.deep.equal([[1, 'base'], [30, 'x']]);
	});
});

describe('IsolationModule — overlay staging tables are released (no leak)', () => {
	// Regression for bug-isolation-overlay-tables-never-released: every path that abandons a
	// per-connection overlay MUST free the overlay's staging table from the overlay module's
	// registry, or MemoryTableModule.tables grows one dead `_overlay_<table>_<id>` entry per
	// writing transaction (and one more per `alter primary key` overlay swap — the only DDL path
	// left that replaces an overlay rather than adopting in place), unbounded. The overlay module holds ONLY
	// overlays — the base table lives in the SEPARATE underlying module — so its table count
	// returns to a baseline of 0 after every completed cycle. That is the assertion that pins
	// the whole class of bug.
	let db: Database;
	let iso: IsolationModule;
	let overlayTables: Map<string, unknown>;

	beforeEach(async () => {
		db = new Database();
		iso = new IsolationModule({ underlying: new MemoryTableModule() });
		db.registerModule('isolated', iso);
		overlayTables = (iso.overlayModule as unknown as { tables: Map<string, unknown> }).tables;
		await db.exec('create table t (id integer primary key, v text) using isolated');
		expect(overlayTables.size, 'baseline: no overlays before any write').to.equal(0);
	});

	afterEach(async () => {
		await db.close();
	});

	it('write + commit releases the overlay', async () => {
		await db.exec('begin');
		await db.exec("insert into t values (1, 'a')");
		expect(overlayTables.size, 'overlay staged inside the transaction').to.equal(1);
		await db.exec('commit');
		expect(overlayTables.size, 'overlay freed after commit').to.equal(0);
	});

	it('write + rollback releases the overlay', async () => {
		await db.exec('begin');
		await db.exec("insert into t values (1, 'a')");
		expect(overlayTables.size).to.equal(1);
		await db.exec('rollback');
		expect(overlayTables.size, 'overlay freed after rollback').to.equal(0);
	});

	it('write + create index (in-place overlay adopt) + commit leaves no overlay', async () => {
		await db.exec('begin');
		await db.exec("insert into t values (1, 'a')");
		await db.exec('create index t_v on t(v)');
		expect(overlayTables.size, 'the index is adopted in place — no second staging table').to.equal(1);
		await db.exec('commit');
		expect(overlayTables.size).to.equal(0);
	});

	it('write + drop index (in-place overlay adopt) + commit leaves no overlay', async () => {
		await db.exec('create index t_v on t(v)');
		await db.exec('begin');
		await db.exec("insert into t values (1, 'a')");
		await db.exec('drop index t_v');
		expect(overlayTables.size).to.equal(1);
		await db.exec('commit');
		expect(overlayTables.size).to.equal(0);
	});

	it('write + alter table add column + commit leaves no overlay', async () => {
		await db.exec('begin');
		await db.exec("insert into t values (1, 'a')");
		await db.exec("alter table t add column w text default 'x'");
		expect(overlayTables.size).to.equal(1);
		await db.exec('commit');
		expect(overlayTables.size).to.equal(0);
	});

	it("write + drop table releases the dropping connection's overlay", async () => {
		await db.exec('begin');
		await db.exec("insert into t values (1, 'a')");
		expect(overlayTables.size).to.equal(1);
		await db.exec('drop table t');
		expect(overlayTables.size, "destroy frees the dropping connection's own overlay").to.equal(0);
		await db.exec('commit');
		expect(overlayTables.size).to.equal(0);
	});

	// The teardown-ordering corner the ticket flags: when a savepoint pre-dates the overlay,
	// ensureOverlay registers the overlay's OWN MemoryVirtualTableConnection directly with the
	// database. Freeing (destroying) the overlay at commit/rollback while that connection is
	// still registered must not throw when the db later tears the connection down — these two
	// cycles exercise that path AND assert the overlay is still freed.
	it('pre-overlay savepoint + commit tears down cleanly and frees the overlay', async () => {
		await db.exec('begin');
		await db.exec('select * from t');               // register the IsolatedConnection (no overlay yet)
		await db.exec('savepoint sp1');                 // savepoint pre-dates the overlay
		await db.exec("insert into t values (1, 'a')"); // ensureOverlay registers the overlay's own connection
		expect(overlayTables.size).to.equal(1);
		await db.exec('commit');
		expect(overlayTables.size, 'overlay freed after a savepoint-involving commit').to.equal(0);
	});

	it('pre-overlay savepoint + rollback tears down cleanly and frees the overlay', async () => {
		await db.exec('begin');
		await db.exec('select * from t');
		await db.exec('savepoint sp1');
		await db.exec("insert into t values (1, 'a')");
		expect(overlayTables.size).to.equal(1);
		await db.exec('rollback');
		expect(overlayTables.size, 'overlay freed after a savepoint-involving rollback').to.equal(0);
	});
});

describe('IsolationModule — a poisoned overlay is freed on rollback (no leak)', () => {
	// The DDL-FAILURE corner of the leak: when CREATE UNIQUE INDEX cannot be adopted by a FOREIGN
	// connection's overlay (its staged rows violate the new constraint), that overlay is kept
	// installed and poisoned — no fresh staging table is created for it, and nothing is freed
	// until its owner rolls back, at which point it is. Two Database instances share one
	// IsolationModule so each is a distinct connection (the module keys overlays by db id).
	let iso: IsolationModule;
	let overlayTables: Map<string, unknown>;
	let dbA: Database; // issues the UNIQUE index
	let dbB: Database; // foreign connection whose duplicate rows get poisoned

	beforeEach(async () => {
		iso = new IsolationModule({ underlying: new MemoryTableModule() });
		overlayTables = (iso.overlayModule as unknown as { tables: Map<string, unknown> }).tables;
		dbA = new Database();
		dbB = new Database();
		dbA.registerModule('isolated', iso);
		await dbA.exec('create table t (id integer primary key, x integer) using isolated');
		await dbA.exec('insert into t values (5, 5)'); // committed, unique-safe baseline
		expect(overlayTables.size, 'baseline').to.equal(0);
	});

	afterEach(async () => {
		await dbA.close();
		await dbB.close();
	});

	it('creates no second staging table on failure and frees the poisoned overlay on rollback', async () => {
		// dbB stages two rows sharing x = 7 — legal now, before any UNIQUE index on x exists.
		const underlying = iso.getUnderlyingState('main', 't')!.underlyingTable;
		const overlay = await iso.overlayModule.create(dbB, iso.createOverlaySchema(underlying.tableSchema!));
		await overlay.update({ operation: 'insert', values: [10, 7, 0] }); // trailing 0 = live
		await overlay.update({ operation: 'insert', values: [11, 7, 0] });
		iso.setConnectionOverlay(dbB, 'main', 't', { overlayTable: overlay, hasChanges: true, db: dbB });
		expect(overlayTables.size, 'dbB overlay staged').to.equal(1);

		// dbA declares UNIQUE(x). Adopting it into dbB's overlay hits the duplicate, so dbB's
		// overlay is kept as-is and poisoned. The count stays at 1 — a path that reached for a
		// fresh staging table and leaked it would make it 2.
		await dbA.exec('create unique index ux on t(x)');
		expect(overlayTables.size, 'the poisoned overlay is kept, and nothing extra allocated').to.equal(1);
		expect(iso.getConnectionOverlay(dbB, 'main', 't')!.poison, 'dbB overlay is poisoned').to.not.be.undefined;

		// dbB rolls back — routed through clearConnectionOverlay — freeing its poisoned overlay.
		await iso.clearConnectionOverlay(dbB, 'main', 't');
		expect(overlayTables.size, 'poisoned overlay freed on rollback').to.equal(0);
	});
});

describe('isolated table stored-row reporting', () => {
	// The DML executor reports `UpdateResult.row` — the row the substrate STORED —
	// to RETURNING and every other post-write consumer
	// (bug-dml-downstream-uses-uncoerced-row). The isolation layer coerces the
	// proposed row for conflict detection but writes the RAW row into the overlay,
	// leaving the overlay's own single coercion pass to produce the stored row,
	// which `stripTombstoneFromResult` then hands back at user-facing width. These
	// cases pin that round trip: RETURNING through the overlay must agree with a
	// following SELECT, value and type.
	let db: Database;

	beforeEach(async () => {
		db = new Database();
		db.registerModule('isolated', new IsolationModule({ underlying: new MemoryTableModule() }));
		await db.exec(`CREATE TABLE t (id INTEGER PRIMARY KEY, j JSON, n INTEGER) USING isolated`);
	});

	afterEach(async () => { await db.close(); });

	const parity = async (returning: string, where: string) => {
		const written = await asyncIterableToArray(db.eval(returning));
		const read = await asyncIterableToArray(db.eval(where));
		expect(written).to.deep.equal(read);
		return written;
	};

	it('INSERT ... RETURNING reports the coerced overlay row', async () => {
		const rows = await parity(
			`INSERT INTO t VALUES (1, '{"a":2}', '7') RETURNING j, typeof(j) AS jt, n, typeof(n) AS nt`,
			`SELECT j, typeof(j) AS jt, n, typeof(n) AS nt FROM t WHERE id = 1`,
		);
		expect(rows).to.deep.equal([{ j: { a: 2 }, jt: 'json', n: 7, nt: 'integer' }]);
	});

	it('UPDATE ... RETURNING reports the coerced overlay row', async () => {
		await db.exec(`INSERT INTO t VALUES (1, '{"a":1}', 1)`);
		const rows = await parity(
			`UPDATE t SET j = '{"a":2}', n = '7' WHERE id = 1 RETURNING j, typeof(j) AS jt, n, typeof(n) AS nt`,
			`SELECT j, typeof(j) AS jt, n, typeof(n) AS nt FROM t WHERE id = 1`,
		);
		expect(rows).to.deep.equal([{ j: { a: 2 }, jt: 'json', n: 7, nt: 'integer' }]);
	});

	it('a PK-moving UPDATE keeps RETURNING and SELECT in agreement', async () => {
		await db.exec(`INSERT INTO t VALUES (1, '{"a":1}', 1)`);
		const rows = await parity(
			`UPDATE t SET id = 5, j = '{"a":9}', n = '42' WHERE id = 1 RETURNING id, j, typeof(j) AS jt, n, typeof(n) AS nt`,
			`SELECT id, j, typeof(j) AS jt, n, typeof(n) AS nt FROM t`,
		);
		expect(rows).to.deep.equal([{ id: 5, j: { a: 9 }, jt: 'json', n: 42, nt: 'integer' }]);
	});

	it('DELETE still reports its row through the tombstone path', async () => {
		await db.exec(`INSERT INTO t VALUES (1, '{"a":1}', 1)`);
		// Committed row: the delete inserts a fresh tombstone and the overlay
		// reports a PK-only placeholder, whose mere presence is what tells the
		// executor a row really went away.
		const deleted = await asyncIterableToArray(db.eval(`DELETE FROM t WHERE id = 1 RETURNING id, j`));
		expect(deleted).to.deep.equal([{ id: 1, j: { a: 1 } }]);
		expect(await asyncIterableToArray(db.eval('SELECT * FROM t'))).to.deep.equal([]);

		// Deleting a key that was never there writes nothing and emits nothing.
		expect(await asyncIterableToArray(db.eval(`DELETE FROM t WHERE id = 99 RETURNING id`))).to.deep.equal([]);
	});
});

describe('IsolationModule — cross-connection SET DATA TYPE over staged overlay rows', () => {
	// `alter column … set data type` rewrites VALUES. The underlying converts only its own
	// committed rows, so the isolation layer must convert every staged overlay row itself —
	// including FOREIGN connections' (nobody else ever reads them). A foreign row that cannot
	// be converted poisons that one overlay (MISMATCH → poison) rather than aborting the
	// issuer's ALTER after the underlying has already been rewritten.
	//
	// White-box, like the poison suite above: several Databases share one IsolationModule so
	// each gets its own dbId, overlays are injected directly, and the ALTER is driven straight
	// through `iso.alterTable`.
	let iso: IsolationModule;
	let dbA: Database; // the ALTER issuer
	let dbB: Database; // a foreign connection

	/** `alter table t alter column v set data type integer`, as the module receives it. */
	const retypeVToInteger: SchemaChangeInfo = { type: 'alterColumn', columnName: 'v', setDataType: 'integer' };

	beforeEach(async () => {
		iso = new IsolationModule({ underlying: new MemoryTableModule() });
		dbA = new Database();
		dbB = new Database();
		dbA.registerModule('isolated', iso);
		await dbA.exec(`create table t (id integer primary key, v text null) using isolated`);
		// One committed baseline row that always converts, so the underlying's own pre-mutation
		// pass never rejects — only staged overlay rows decide the outcome.
		await dbA.exec(`insert into t values (5, '5')`);
	});

	afterEach(async () => {
		await dbA.close();
		await dbB.close();
	});

	/** Injects a staged-insert overlay (rows = [id, v][]) for `forDb`, hasChanges=true. */
	async function injectOverlay(forDb: Database, rows: SqlValue[][]): Promise<void> {
		const underlying = iso.getUnderlyingState('main', 't')!.underlyingTable;
		const overlay = await iso.overlayModule.create(forDb, iso.createOverlaySchema(underlying.tableSchema!));
		for (const r of rows) {
			await overlay.update({ operation: 'insert', values: [...r, 0] }); // trailing 0 = live (not tombstone)
		}
		iso.setConnectionOverlay(forDb, 'main', 't', { overlayTable: overlay, hasChanges: true, db: forDb });
	}

	function overlayState(forDb: Database): ConnectionOverlayState | undefined {
		return iso.getConnectionOverlay(forDb, 'main', 't');
	}

	/** Rows visible to `forDb` through a fresh IsolatedTable (merged overlay + underlying). */
	async function mergedRows(forDb: Database): Promise<Row[]> {
		const table = await iso.connect(forDb, undefined, 'isolated', 'main', 't', {} as BaseModuleConfig) as IsolatedTable;
		return await asyncIterableToArray(table.query(makeFullScanFilterInfo()));
	}

	it('converts a foreign connection\'s staged convertible row and flushes it with the new type', async () => {
		await injectOverlay(dbB, [[10, '20']]); // convertible text

		await iso.alterTable(dbA, 'main', 't', retypeVToInteger);

		// B's overlay migrated forward (not poisoned) with its staged value CONVERTED.
		const bState = overlayState(dbB)!;
		expect(bState.poison, 'a convertible foreign row is migrated, not poisoned').to.be.undefined;
		const bRows = await asyncIterableToArray(bState.overlayTable.query!(makeFullScanFilterInfo()));
		expect(bRows.map(r => [r[0], r[1]]), 'staged text converted to integer').to.deep.equal([[10, 20]]);

		// And it flushes that way: after B commits, the shared underlying holds the integer.
		await iso.commitConnectionOverlays(dbB);
		expect((await mergedRows(dbA)).map(r => [r[0], r[1]]), 'committed with the new type')
			.to.deep.equal([[5, 5], [10, 20]]);
	});

	it('poisons a foreign overlay whose staged value cannot be converted, while the issuer ALTER applies', async () => {
		await injectOverlay(dbB, [[10, 'abc']]); // unconvertible

		const updated = await iso.alterTable(dbA, 'main', 't', retypeVToInteger);

		// The issuer's ALTER applied — a foreign connection's uncommitted row must not abort it.
		expect(updated.columns.find(c => c.name === 'v')?.logicalType.name.toLowerCase(), 'v retyped')
			.to.contain('int');
		expect((await mergedRows(dbA)).map(r => [r[0], r[1]]), 'committed row converted')
			.to.deep.equal([[5, 5]]);

		// B's overlay is poisoned, with a message naming the retype (not the NOT NULL wording).
		const bState = overlayState(dbB)!;
		expect(bState.poison, 'B overlay must be poisoned').to.not.be.undefined;
		expect(bState.poison!.message).to.match(/data type/i);
		expect(bState.poison!.message).to.match(/roll back this transaction/i);
		expect(bState.poison!.message).to.contain('main.t');

		// B's commit fails rather than silently dropping or mis-typing its staged row.
		let caught: unknown;
		try { await iso.commitConnectionOverlays(dbB); } catch (e) { caught = e; }
		expect(caught, 'the foreign commit must fail, not silently succeed').to.be.instanceOf(QuereusError);
		expect((caught as QuereusError).code).to.equal(StatusCode.CONSTRAINT);
		expect((caught as QuereusError).message).to.contain('main.t');
	});

	it('poisons a foreign overlay whose staged rows collide only AFTER conversion', async () => {
		// Each value converts fine on its own, so `validateOverlayMigration` passes; the collision
		// surfaces only when the overlay adopts the retype — its converted-row UNIQUE
		// re-validation fires before mutating anything. That CONSTRAINT must poison B, not
		// escape as INTERNAL or abort A's ALTER.
		await dbA.exec(`create table u (id integer primary key, v text unique) using isolated`);
		const underlyingU = iso.getUnderlyingState('main', 'u')!.underlyingTable;
		const overlayU = await iso.overlayModule.create(dbB, iso.createOverlaySchema(underlyingU.tableSchema!));
		await overlayU.update({ operation: 'insert', values: [10, '1', 0] });  // distinct as text…
		await overlayU.update({ operation: 'insert', values: [11, '01', 0] }); // …identical as integers
		iso.setConnectionOverlay(dbB, 'main', 'u', { overlayTable: overlayU, hasChanges: true, db: dbB });

		const updated = await iso.alterTable(dbA, 'main', 'u', { type: 'alterColumn', columnName: 'v', setDataType: 'integer' });

		expect(updated.columns.find(c => c.name === 'v')?.logicalType.name.toLowerCase(), 'A\'s ALTER still applies')
			.to.contain('int');
		const bState = iso.getConnectionOverlay(dbB, 'main', 'u')!;
		expect(bState.poison, 'B overlay must be poisoned by the post-conversion collision').to.not.be.undefined;
		expect(bState.poison!.message).to.match(/roll back this transaction/i);
		expect(bState.poison!.message).to.contain('main.u');
	});

	it('converts a foreign overlay IN PLACE — same overlay object across the retype', async () => {
		await injectOverlay(dbB, [[10, '20']]);
		const before = overlayState(dbB)!.overlayTable;

		await iso.alterTable(dbA, 'main', 't', retypeVToInteger);

		const bState = overlayState(dbB)!;
		expect(bState.poison).to.be.undefined;
		expect(bState.overlayTable, 'overlay adopted in place, not rebuilt').to.equal(before);
	});
});

describe('IsolationModule — ALTER PRIMARY KEY over per-connection overlays', () => {
	// No overlay can follow a primary-key change: its staging BTrees are keyed by the OLD
	// primary key, a staged tombstone identifies the row it deletes BY that key, and the
	// (memory) overlay module rejects in-place PK alteration. So the isolation layer
	// rejects the ISSUER up front when it has staged rows, poisons a FOREIGN overlay with
	// staged rows after the underlying applies, and swaps a CLEAN overlay for a fresh
	// staging table under the new key.
	//
	// `PkAcceptingMemoryModule` answers alterPrimaryKey with the re-keyed schema and no
	// physical re-key — the overlay handling under test never reads the underlying's rows,
	// and the stub keeps these tests pinned to the wrapper's own behavior rather than the
	// memory module's in-place re-key (which it performs natively too).
	let iso: IsolationModule;
	let dbA: Database; // the ALTER issuer
	let dbB: Database; // a foreign connection

	class PkAcceptingMemoryModule extends MemoryTableModule {
		alterTableCalls = 0;
		async alterTable(db: Database, schemaName: string, tableName: string, change: SchemaChangeInfo, rows?: any): Promise<TableSchema> {
			this.alterTableCalls++;
			if (change.type === 'alterPrimaryKey') {
				const prior = iso.getUnderlyingState(schemaName, tableName)!.underlyingTable.tableSchema!;
				return Object.freeze({
					...prior,
					primaryKeyDefinition: Object.freeze(change.newPkColumns.map(pk => ({ index: pk.index, desc: pk.desc }))),
				});
			}
			return super.alterTable(db, schemaName, tableName, change, rows);
		}
	}
	let underlyingModule: PkAcceptingMemoryModule;

	/** `alter table t alter primary key (x)` — move the PK from id (index 0) to x (index 1). */
	const alterPkToX: SchemaChangeInfo = { type: 'alterPrimaryKey', newPkColumns: [{ index: 1, desc: false }] };

	beforeEach(async () => {
		underlyingModule = new PkAcceptingMemoryModule();
		iso = new IsolationModule({ underlying: underlyingModule });
		dbA = new Database();
		dbB = new Database();
		dbA.registerModule('isolated', iso);
		await dbA.exec('create table t (id integer primary key, x integer) using isolated');
	});

	afterEach(async () => {
		await dbA.close();
		await dbB.close();
	});

	async function injectOverlay(forDb: Database, rows: SqlValue[][], hasChanges = true): Promise<void> {
		const underlying = iso.getUnderlyingState('main', 't')!.underlyingTable;
		const overlay = await iso.overlayModule.create(forDb, iso.createOverlaySchema(underlying.tableSchema!));
		for (const r of rows) {
			await overlay.update({ operation: 'insert', values: [...r, 0] });
		}
		iso.setConnectionOverlay(forDb, 'main', 't', { overlayTable: overlay, hasChanges, db: forDb });
	}

	it('rejects the issuer up front when its transaction has staged rows, before the underlying mutates', async () => {
		await injectOverlay(dbA, [[1, 7]]);
		const callsBefore = underlyingModule.alterTableCalls;

		let err: unknown;
		try { await iso.alterTable(dbA, 'main', 't', alterPkToX); } catch (e) { err = e; }
		expect(err, 'issuer with staged rows must be rejected').to.be.instanceOf(QuereusError);
		expect((err as QuereusError).code).to.equal(StatusCode.BUSY);
		expect((err as QuereusError).message).to.match(/primary key/i);

		// Atomic: the underlying was never asked to mutate, and A's overlay is intact.
		expect(underlyingModule.alterTableCalls, 'underlying alterTable never reached').to.equal(callsBefore);
		const aState = iso.getConnectionOverlay(dbA, 'main', 't')!;
		expect(aState.poison, 'issuer overlay rejected, never poisoned').to.be.undefined;
		expect(aState.hasChanges).to.equal(true);
	});

	it('poisons a foreign overlay with staged rows while the issuer\'s ALTER applies', async () => {
		await injectOverlay(dbB, [[10, 7]]);

		const updated = await iso.alterTable(dbA, 'main', 't', alterPkToX);
		expect(updated.primaryKeyDefinition.map(d => d.index), 'PK moved to x').to.deep.equal([1]);

		const bState = iso.getConnectionOverlay(dbB, 'main', 't')!;
		expect(bState.poison, 'B overlay must be poisoned').to.not.be.undefined;
		expect(bState.poison!.message).to.match(/primary key/i);
		expect(bState.poison!.message).to.match(/roll back this transaction/i);
	});

	it('swaps a clean overlay for a fresh staging table keyed by the new primary key', async () => {
		await injectOverlay(dbB, [], false); // clean: exists, stages nothing
		const overlayTables = (iso.overlayModule as unknown as { tables: Map<string, unknown> }).tables;
		const before = iso.getConnectionOverlay(dbB, 'main', 't')!.overlayTable;
		expect(overlayTables.size, 'baseline: one staging table').to.equal(1);

		await iso.alterTable(dbA, 'main', 't', alterPkToX);

		const bState = iso.getConnectionOverlay(dbB, 'main', 't')!;
		expect(bState.poison, 'clean overlay is carried, not poisoned').to.be.undefined;
		expect(bState.hasChanges).to.equal(false);
		expect(bState.overlayTable, 'fresh staging table installed').to.not.equal(before);
		expect(bState.overlayTable.tableSchema!.primaryKeyDefinition.map(d => d.index), 'overlay keyed by the new PK')
			.to.deep.equal([1]);
		expect(overlayTables.size, 'old staging table released — no leak').to.equal(1);
	});

	it('an underlying\'s UNSUPPORTED propagates with every overlay untouched', async () => {
		// The memory module now re-keys in place, so a refusing underlying is stubbed here —
		// the contract under test is the wrapper's: it must not swallow the rejection.
		class PkRefusingMemoryModule extends MemoryTableModule {
			async alterTable(db: Database, schemaName: string, tableName: string, change: SchemaChangeInfo, rows?: any): Promise<TableSchema> {
				if (change.type === 'alterPrimaryKey') {
					throw new QuereusError('stub module does not support in-place primary key alteration', StatusCode.UNSUPPORTED);
				}
				return super.alterTable(db, schemaName, tableName, change, rows);
			}
		}
		const memIso = new IsolationModule({ underlying: new PkRefusingMemoryModule() });
		const dbM = new Database();
		dbM.registerModule('isolated', memIso);
		await dbM.exec('create table m (id integer primary key, x integer) using isolated');

		let err: unknown;
		try { await memIso.alterTable(dbM, 'main', 'm', alterPkToX); } catch (e) { err = e; }
		expect(err, 'the wrapper must not swallow the underlying rejection').to.be.instanceOf(QuereusError);
		expect((err as QuereusError).code).to.equal(StatusCode.UNSUPPORTED);
		await dbM.close();
	});

	it('a MEMORY underlying with a clean issuer overlay honors the ALTER natively end-to-end', async () => {
		// The counterpart of the stubbed tests above: real memory module, no stub. The
		// wrapper forwards to memory's in-place re-key and swaps its clean overlay.
		const memIso = new IsolationModule({ underlying: new MemoryTableModule() });
		const dbM = new Database();
		dbM.registerModule('isolated', memIso);
		await dbM.exec('create table m (id integer primary key, x integer not null) using isolated');
		await dbM.exec('insert into m values (1, 10), (2, 20)');

		const updated = await memIso.alterTable(dbM, 'main', 'm', alterPkToX);
		expect(updated.primaryKeyDefinition.map(d => d.index), 'PK moved to x').to.deep.equal([1]);

		const rows: unknown[] = [];
		for await (const row of dbM.eval('select * from m order by x')) rows.push(row);
		expect(rows, 'rows survive the native re-key').to.deep.equal([{ id: 1, x: 10 }, { id: 2, x: 20 }]);
		await dbM.close();
	});
});
