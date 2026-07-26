import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import { Database, MemoryTableModule, VirtualTable, AccessPlanBuilder, IndexConstraintOp, asyncIterableToArray, getModuleConcurrencyMode, QuereusError, StatusCode, primaryKeyDescriptor, ConflictResolution } from '@quereus/quereus';
import type { VtabConcurrencyMode, FilterInfo, VirtualTableModule, BaseModuleConfig, DatabaseInternal, Row, SqlValue, VirtualTableConnection, SchemaChangeInfo, TableSchema, BestAccessPlanRequest, BestAccessPlanResult, UpdateArgs, UpdateResult, IndexDescriptor } from '@quereus/quereus';
import { IsolationModule, IsolatedTable } from '../src/index.js';
import type { ConnectionOverlayState } from '../src/index.js';
import { makeFullScanFilterInfo } from '../src/filter-info.js';

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

		it('keeps case-distinct `any`-typed PK rows separate under a declared (inert) NOCASE', async () => {
			await db.exec(`
				CREATE TABLE t (
					k ANY COLLATE NOCASE PRIMARY KEY,
					v TEXT
				) USING isolated
			`);
			await db.exec(`CREATE INDEX idx_v ON t(v)`);

			// Two committed rows whose PKs differ only in case — genuinely distinct under
			// ANY_TYPE.compare, which always compares BINARY regardless of the declared
			// (and inert) NOCASE collation.
			await db.exec(`INSERT INTO t VALUES ('A', 'upper')`);
			await db.exec(`INSERT INTO t VALUES ('a', 'lower')`);

			await db.exec('BEGIN');
			// Modify one of the pair via a secondary-index-driven scan (idx_v), which builds
			// its modified-PK set through the collation-aware key normalizer. Pre-fix, that
			// normalizer keys 'A' and 'a' under NOCASE and treats them as the same PK, so
			// the untouched 'a' row is wrongly excluded from the merge.
			await db.exec(`UPDATE t SET v = 'changed' WHERE k = 'A'`);

			const changed = await asyncIterableToArray(db.eval(`SELECT k, v FROM t WHERE v = 'changed'`));
			expect(changed.length).to.equal(1);
			expect(changed[0].k).to.equal('A');

			const untouched = await asyncIterableToArray(db.eval(`SELECT k, v FROM t WHERE v = 'lower'`));
			expect(untouched.length).to.equal(1);
			expect(untouched[0].k).to.equal('a');

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
			// MemoryTable.update against `_overlay_<table>_<id>`. The fix rebuilds
			// the overlay against the post-drop schema.
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
			// Verifies the overlay rebuild copies tombstone rows verbatim, so a
			// DELETE staged before DROP INDEX still results in the row being
			// removed at COMMIT.
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
		 * Live underlying column count for `main.<table>`. Read via the MemoryTable's
		 * `getSchema()` — the canonical schema the underlying manager mutates in place —
		 * NOT the `underlyingTable.tableSchema` field, which is a per-instance snapshot
		 * taken at connect time and is never refreshed by the module-level `alterTable`
		 * this layer drives. Reading the stale field would report the pre-ALTER count
		 * even when the underlying HAS been mutated, making the atomicity assertion
		 * vacuous (it would pass against the pre-fix mutate-then-validate ordering too).
		 * `getSchema()` is MemoryTable-specific (not on the base `VirtualTable`), so we
		 * narrow structurally — sound because this suite pins the underlying to memory.
		 */
		function underlyingColumnCount(table: string): number {
			const underlying = isolatedModule.getUnderlyingState('main', table)!.underlyingTable as unknown as {
				getSchema(): { columns: readonly unknown[] } | undefined;
			};
			return underlying.getSchema()!.columns.length;
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

		/**
		 * Live underlying column count via the MemoryTable's getSchema() — the canonical
		 * schema the manager mutates in place. The per-instance `.tableSchema` field is a
		 * connect-time snapshot the module-level alterTable never refreshes, so reading it
		 * would make the atomicity assertion vacuous (companion ticket's note).
		 */
		function underlyingColumnCount(): number {
			const underlying = iso.getUnderlyingState('main', 't')!.underlyingTable as unknown as {
				getSchema(): TableSchema | undefined;
			};
			return underlying.getSchema()!.columns.length;
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

		/**
		 * `CREATE UNIQUE INDEX` by one connection over rows another connection has staged.
		 *
		 * The issuer's own rows are judged before the index is built (see
		 * `IsolationModule.issuerEffectiveRows`), but a FOREIGN overlay is not — its rows are
		 * that connection's problem, exactly as a concurrent duplicate insert would be. What
		 * must not happen is the overlay rebuild quietly dropping the row it cannot re-insert:
		 * `MemoryTable.update` RETURNS `{status:'constraint'}` rather than throwing, and the
		 * rebuild loop used to ignore it. The foreign connection would then commit a
		 * transaction missing a row it believed it had written.
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

			// The poisoned overlay keeps BOTH staged rows — the rebuild that rejected the second
			// one was discarded whole, never installed with a row missing.
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

			// B poisoned; C migrated forward (new state object, no poison).
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

			// dropIndex rebuilds affected overlays under the post-drop schema. A poisoned overlay
			// holds rows in the narrower pre-alter layout — rebuilding would copy layout-mismatched
			// rows and drop the poison. It must be skipped, staying poisoned for its owner.
			await iso.dropIndex(dbA, 'main', 't', 't_idx');

			const bState = overlayState(dbB)!;
			expect(bState.poison, 'poison survives an unrelated DROP INDEX').to.not.be.undefined;
			expect(bState.poison!.message).to.equal(poisonMsg);
			expect(bState.overlayTable, 'poisoned overlay not rebuilt').to.equal(staleOverlay);
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

		/** notNull flag of `x` on the live underlying manager schema (not the stale instance field). */
		function underlyingXNotNull(): boolean {
			const underlying = iso.getUnderlyingState('main', 't')!.underlyingTable as unknown as {
				getSchema(): TableSchema | undefined;
			};
			return underlying.getSchema()!.columns.find(c => c.name === 'x')?.notNull ?? false;
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

			const updated = await iso.alterTable(dbA, 'main', 't', setNotNullX());
			expect(updated.columns.find(c => c.name === 'x')?.notNull, 'x tightened').to.equal(true);

			// B's overlay is migrated forward (NOT poisoned); its staged NULL is backfilled to 0.
			const bState = overlayState(dbB)!;
			expect(bState.poison, 'foreign overlay with a usable DEFAULT is backfilled, not poisoned').to.be.undefined;
			const bRows = await asyncIterableToArray(bState.overlayTable.query!(fullScan()));
			expect(bRows.map(r => [r[0], r[1]]), 'staged NULL backfilled to the DEFAULT').to.deep.equal([[10, 0]]);
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
		async function stage(committedInsert: string, overlayRows: Row[], desc = false): Promise<{ table: IsolatedTable; vIdx: number }> {
			ndb = new Database();
			const iso = new IsolationModule({ underlying: new SynthUnderlyingModule(desc) });
			ndb.registerModule('isolated', iso);
			await ndb.exec('create table t (id integer primary key, v text) using isolated');
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

	it('collate nocase declines the seek and still catches a case-only committed collision', async () => {
		await db.exec(`create table t (id integer primary key, email text) using isolated`);
		await db.exec(`create unique index ux on t(email collate nocase)`);
		await db.exec(`insert into t values (1, 'b@x')`);   // committed
		await db.exec('begin');
		// 'B@X' == 'b@x' under NOCASE. The BINARY-only seek gate declines to seek `ux`
		// (its enforcement collation is NOCASE), so Phase 2 full-scans and the NOCASE
		// comparator catches the committed 'b@x'. A NOCASE seek would physically miss it.
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

	it('the binary index seek visits O(matches) underlying rows; the nocase fallback scans the whole table', async () => {
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

			// --- Scan arm: identical shape but the index is NOCASE, so the seek is declined. ---
			await cdb.exec(`create table scan_t (id integer primary key, email text) using isolated`);
			await cdb.exec(`create unique index ux2 on scan_t(email collate nocase)`);
			for (let i = 0; i < 100; i++) await cdb.exec(`insert into scan_t values (${i}, 'f${i}@x')`);

			const tc = await ciso.connect(cdb, undefined, 'isolated', 'main', 'scan_t', {} as BaseModuleConfig) as IsolatedTable;
			counting.rowsYielded = 0;
			await tc.update({ operation: 'insert', values: [1000, 'fresh2@x'] });   // no collision
			const scanCount = counting.rowsYielded;
			expect(scanCount, `nocase constraint must decline the seek and full-scan (yielded ${scanCount})`).to.be.at.least(100);
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
	// writing transaction (and one more per rebuild), unbounded. The overlay module holds ONLY
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

	it('write + create index (overlay rebuild) + commit leaves no overlay', async () => {
		await db.exec('begin');
		await db.exec("insert into t values (1, 'a')");
		await db.exec('create index t_v on t(v)');
		expect(overlayTables.size, 'rebuild swaps a fresh overlay in and frees the old').to.equal(1);
		await db.exec('commit');
		expect(overlayTables.size).to.equal(0);
	});

	it('write + drop index (overlay rebuild) + commit leaves no overlay', async () => {
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

describe('IsolationModule — a rebuild-poisoned overlay is freed on rollback (no leak)', () => {
	// The rebuild-FAILURE corner of the leak: when CREATE UNIQUE INDEX rebuilds a FOREIGN
	// connection's overlay whose staged rows violate the new constraint, the half-built new
	// overlay must be freed (the builder's own catch) and the OLD overlay is kept, poisoned,
	// for its owner to roll back — at which point IT is freed too. Two Database instances share
	// one IsolationModule so each is a distinct connection (the module keys overlays by db id).
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

	it('frees the half-built rebuild overlay on failure and the poisoned overlay on rollback', async () => {
		// dbB stages two rows sharing x = 7 — legal now, before any UNIQUE index on x exists.
		const underlying = iso.getUnderlyingState('main', 't')!.underlyingTable;
		const overlay = await iso.overlayModule.create(dbB, iso.createOverlaySchema(underlying.tableSchema!));
		await overlay.update({ operation: 'insert', values: [10, 7, 0] }); // trailing 0 = live
		await overlay.update({ operation: 'insert', values: [11, 7, 0] });
		iso.setConnectionOverlay(dbB, 'main', 't', { overlayTable: overlay, hasChanges: true, db: dbB });
		expect(overlayTables.size, 'dbB overlay staged').to.equal(1);

		// dbA declares UNIQUE(x). Rebuilding dbB's overlay hits the duplicate: the half-built new
		// overlay is discarded and dbB's OLD overlay is poisoned (kept, unmigrated). A leaked
		// half-built table would make the count 2.
		await dbA.exec('create unique index ux on t(x)');
		expect(overlayTables.size, 'poisoned overlay kept; half-built rebuild freed').to.equal(1);
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
