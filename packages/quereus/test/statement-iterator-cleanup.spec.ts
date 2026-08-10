import { expect } from 'chai';
import { Database, MisuseError, Statement } from '../src/index.js';

describe('Statement Iterator Cleanup', () => {
	let db: Database;

	beforeEach(async () => {
		db = new Database();
		// Create test table with data
		await db.exec('create table test_data (id integer primary key, value integer)');
		await db.exec('insert into test_data values (1, 100), (2, 200), (3, 300), (4, 400), (5, 500)');
	});

	afterEach(async () => {
		await db.close();
	});

	describe('Statement.all()', () => {
		it('should commit transaction on normal completion', async () => {
			const stmt = db.prepare('select * from test_data');
			const results: Record<string, unknown>[] = [];

			for await (const row of stmt.all()) {
				results.push(row);
			}

			expect(results).to.have.length(5);
			// Verify transaction was committed (no transaction should be active)
			expect(db._isImplicitTransaction()).to.be.false;
			await stmt.finalize();
		});

		it('should commit transaction on early exit', async () => {
			const stmt = db.prepare('select * from test_data');
			const results: Record<string, unknown>[] = [];

			for await (const row of stmt.all()) {
				results.push(row);
				if (results.length === 2) break; // Early exit
			}

			expect(results).to.have.length(2);
			// Verify transaction was committed despite early exit
			expect(db._isImplicitTransaction()).to.be.false;
			await stmt.finalize();
		});

		it('should rollback transaction on error during iteration', async () => {
			const stmt = db.prepare('select * from test_data');

			try {
				for await (const row of stmt.all()) {
					if (row.id === 3) {
						throw new Error('Test error');
					}
				}
				expect.fail('Should have thrown');
			} catch (err) {
				expect((err as Error).message).to.equal('Test error');
			}

			// Verify transaction was rolled back
			expect(db._isImplicitTransaction()).to.be.false;
			await stmt.finalize();
		});

		it('should allow concurrent statements after early exit releases mutex', async () => {
			const stmt1 = db.prepare('select * from test_data');
			const stmt2 = db.prepare('select count(*) as cnt from test_data');

			// Start iteration with stmt1 and exit early
			for await (const row of stmt1.all()) {
				if (row.id === 2) break;
			}

			// stmt2 should now be able to execute (mutex was released)
			const result = await stmt2.get();
			expect(result?.cnt).to.equal(5);

			await stmt1.finalize();
			await stmt2.finalize();
		});

		it('should handle multiple early exits without double-release', async () => {
			const stmt = db.prepare('select * from test_data');

			// First early exit
			for await (const row of stmt.all()) {
				if (row.id === 2) break;
			}

			await stmt.reset();

			// Second early exit
			for await (const row of stmt.all()) {
				if (row.id === 3) break;
			}

			// Should still work fine
			expect(db._isImplicitTransaction()).to.be.false;
			await stmt.finalize();
		});
	});

	describe('Statement.iterateRows()', () => {
		it('should commit transaction on normal completion', async () => {
			const stmt = db.prepare('select * from test_data');
			const results: unknown[] = [];

			for await (const row of stmt.iterateRows()) {
				results.push(row);
			}

			expect(results).to.have.length(5);
			expect(db._isImplicitTransaction()).to.be.false;
			await stmt.finalize();
		});

		it('should commit transaction on early exit', async () => {
			const stmt = db.prepare('select * from test_data');
			const results: unknown[] = [];

			for await (const row of stmt.iterateRows()) {
				results.push(row);
				if (results.length === 2) break;
			}

			expect(results).to.have.length(2);
			// Verify transaction was committed despite early exit
			expect(db._isImplicitTransaction()).to.be.false;
			await stmt.finalize();
		});

		it('should rollback transaction on error during iteration', async () => {
			const stmt = db.prepare('select * from test_data');
			let count = 0;

			try {
				for await (const row of stmt.iterateRows()) {
					count++;
					if (Array.isArray(row) && row[0] === 3) {
						throw new Error('Test error');
					}
				}
				expect.fail('Should have thrown');
			} catch (err) {
				expect((err as Error).message).to.equal('Test error');
			}

			expect(count).to.equal(3);
			expect(db._isImplicitTransaction()).to.be.false;
			await stmt.finalize();
		});
	});

	describe('Database.eval()', () => {
		it('should commit transaction on early exit', async () => {
			const results: Record<string, unknown>[] = [];

			for await (const row of db.eval('select * from test_data')) {
				results.push(row);
				if (results.length === 2) break;
			}

			expect(results).to.have.length(2);
			expect(db._isImplicitTransaction()).to.be.false;
		});

		it('should rollback transaction on error', async () => {
			try {
				for await (const row of db.eval('select * from test_data')) {
					if (row.id === 3) {
						throw new Error('Test error');
					}
				}
				expect.fail('Should have thrown');
			} catch (err) {
				expect((err as Error).message).to.equal('Test error');
			}

			expect(db._isImplicitTransaction()).to.be.false;
		});
	});

	describe('Transaction behavior with mutations', () => {
		it('should commit mutations on normal completion', async () => {
			const stmt = db.prepare('insert into test_data values (?, ?)');
			await stmt.run([10, 1000]);

			// Verify mutation was committed
			const result = await db.get('select count(*) as cnt from test_data');
			expect(result?.cnt).to.equal(6);
			await stmt.finalize();
		});

		it('should commit read-only query on early exit', async () => {
			// Verify that a SELECT query with early exit still commits
			// (important for implicit transactions started by reads)
			const stmt = db.prepare('select * from test_data');
			const results: Record<string, unknown>[] = [];

			for await (const row of stmt.all()) {
				results.push(row);
				if (results.length === 2) break;
			}

			expect(results).to.have.length(2);
			expect(db._isImplicitTransaction()).to.be.false;
			await stmt.finalize();
		});

		it('should rollback implicit transaction on error during iteration', async () => {
			const initialCount = await db.get('select count(*) as cnt from test_data');
			expect(initialCount?.cnt).to.equal(5);

			// Use eval() which handles transaction + mutex together
			// An error during iteration should rollback
			try {
				for await (const row of db.eval('select * from test_data')) {
					if (row.id === 3) {
						throw new Error('Test error');
					}
				}
				expect.fail('Should have thrown');
			} catch (err) {
				expect((err as Error).message).to.equal('Test error');
			}

			// Implicit transaction was rolled back, data should be unaffected
			expect(db._isImplicitTransaction()).to.be.false;
			const finalCount = await db.get('select count(*) as cnt from test_data');
			expect(finalCount?.cnt).to.equal(5);
		});
	});

	describe('Lifecycle soft spots', () => {
		// (a) iterateRows() must serialize through the exec mutex like all(), so two
		// concurrent public iterations can't interleave the implicit-transaction lifecycle.
		it('serializes concurrent iterateRows() through the exec mutex', async () => {
			const stmt1 = db.prepare('select * from test_data');
			const stmt2 = db.prepare('select * from test_data');

			const it1 = stmt1.iterateRows();
			const it2 = stmt2.iterateRows();

			// First pull on it1 acquires and holds the exec mutex.
			const first1 = await it1.next();
			expect(first1.done).to.be.false;

			// it2's first pull must wait for the mutex — it can't resolve while it1 holds it.
			let it2Resolved = false;
			const it2Next = it2.next().then(r => { it2Resolved = true; return r; });

			// Let the event loop drain; it2 should still be blocked on the mutex.
			await new Promise(resolve => setTimeout(resolve, 20));
			expect(it2Resolved, 'iterateRows() must not begin a second run while the first holds the mutex').to.be.false;

			// Draining it1 releases the mutex.
			await it1.return!();

			// Now it2 proceeds.
			const first2 = await it2Next;
			expect(first2.done).to.be.false;
			expect(it2Resolved).to.be.true;

			await it2.return!();
			await stmt1.finalize();
			await stmt2.finalize();
		});

		// (b) A recompile into a zero-dependency plan must still drop the previous
		// dependency listener, or one listener leaks per such recompile.
		it('does not leak schema-change listeners on a zero-dependency recompile', async () => {
			const notifier = db.schemaManager.getChangeNotifier();
			const baseline = notifier.getListenerCount();

			// Batch: first statement reads a table (has a dependency), second is a
			// constant (zero dependencies).
			const stmt = db.prepare('select * from test_data; select 1');

			stmt.compile();
			expect(notifier.getListenerCount(), 'table read registers one dependency listener')
				.to.equal(baseline + 1);

			// Advance to `select 1` and recompile into a zero-dependency plan.
			expect(stmt.nextStatement()).to.be.true;
			stmt.compile();

			// The first statement's listener must be gone even though the new plan
			// registers none.
			expect(notifier.getListenerCount(), 'zero-dependency recompile must drop the old listener')
				.to.equal(baseline);

			await stmt.finalize();
		});

		// (c) reset() must refuse mid-iteration, matching bind/bindAll/clearBindings —
		// clearing busy would let a second iteration slip past the busy guard.
		it('refuses reset() while an iteration is in flight', async () => {
			const stmt = db.prepare('select * from test_data');
			const it = stmt.iterateRows();

			// Pull one row → iteration in flight (busy = true).
			const first = await it.next();
			expect(first.done).to.be.false;

			let threw: unknown;
			try {
				await stmt.reset();
			} catch (e) {
				threw = e;
			}
			expect(threw, 'reset() must throw while busy').to.be.instanceOf(MisuseError);

			// Complete the iteration; the generator's finally clears busy.
			await it.return!();

			// reset() now succeeds.
			await stmt.reset();
			await stmt.finalize();
		});

		// (d) db.get() binds parameters once (in the constructor via prepare) and must
		// not rebind via bindAll during stmt.get().
		it('binds parameters exactly once in db.get()', async () => {
			const originalBindAll = Statement.prototype.bindAll;
			let bindAllCount = 0;
			Statement.prototype.bindAll = function (this: Statement, args: Parameters<typeof originalBindAll>[0]): Statement {
				bindAllCount++;
				return originalBindAll.call(this, args);
			};

			try {
				const row = await db.get('select * from test_data where id = ?', [2]);
				expect(row?.value).to.equal(200);
			} finally {
				Statement.prototype.bindAll = originalBindAll;
			}

			// prepare(sql, params) binds the initial values directly in the constructor
			// (not via bindAll); a bindAll call here would be the redundant second bind.
			expect(bindAllCount, 'db.get() must not rebind parameters').to.equal(0);
		});
	});

	describe('Edge cases', () => {
		it('should handle empty result set', async () => {
			const stmt = db.prepare('select * from test_data where id > 1000');
			const results: Record<string, unknown>[] = [];

			for await (const row of stmt.all()) {
				results.push(row);
			}

			expect(results).to.have.length(0);
			expect(db._isImplicitTransaction()).to.be.false;
			await stmt.finalize();
		});

		it('should handle immediate break', async () => {
			const stmt = db.prepare('select * from test_data');

			// Break immediately without consuming any rows
			for await (const _row of stmt.all()) {
				break;
			}

			expect(db._isImplicitTransaction()).to.be.false;
			await stmt.finalize();
		});

		it('should handle iterator return() directly', async () => {
			const stmt = db.prepare('select * from test_data');
			const iterator = stmt.all();

			// Consume one value
			const first = await iterator.next();
			expect(first.done).to.be.false;

			// Call return() explicitly
			const returnResult = await iterator.return!();
			expect(returnResult.done).to.be.true;

			// Transaction should be committed
			expect(db._isImplicitTransaction()).to.be.false;
			await stmt.finalize();
		});

		it('should handle iterator throw() directly', async () => {
			const stmt = db.prepare('select * from test_data');
			const iterator = stmt.all();

			// Consume one value
			const first = await iterator.next();
			expect(first.done).to.be.false;

			// Call throw() explicitly
			try {
				await iterator.throw!(new Error('Direct throw'));
				expect.fail('Should have thrown');
			} catch (err) {
				expect((err as Error).message).to.equal('Direct throw');
			}

			// Transaction should be rolled back
			expect(db._isImplicitTransaction()).to.be.false;
			await stmt.finalize();
		});
	});
});
