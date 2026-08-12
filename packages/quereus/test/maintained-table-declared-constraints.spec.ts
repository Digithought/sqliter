import { expect } from 'chai';
import { Database } from '../src/index.js';

/**
 * Declared-constraint pins for maintained-table derivation writes that
 * sqllogic cannot express (ticket
 * maintained-table-derivation-check-fk-validation; the SQL-level behaviors
 * live in test/logic/51.8-maintained-table-declared-constraints.sqllogic):
 *
 *  - zero-overhead gate: a steady-state source write covering a
 *    CONSTRAINT-LESS maintained table (and an MV-sugar table) performs no
 *    validation work — no statement prepare, no deferred-constraint enqueue;
 *  - deferral parity inside an explicit transaction: an orphan-producing
 *    source write is admitted mid-transaction and validates at COMMIT against
 *    final state (a parent arriving before commit satisfies it; an unresolved
 *    orphan fails the commit with the maintained-table attribution and rolls
 *    the whole transaction back);
 *  - cascade attribution: a two-level chain (base → mt1 → mt2) attributes a
 *    violation to the CONSUMER that declares the constraint, not the producer;
 *  - constraint-dependency DDL invalidation: rename/drop/re-create of an FK
 *    parent or subquery-CHECK target rebuilds the once-compiled validator. Two
 *    arms of that rebuild are no longer reachable from SQL at all (the drop is
 *    refused) and are driven through `SchemaManager.dropTable` directly — see
 *    the comment on `subquery-CHECK target dropped out of band` below.
 */
describe('Maintained-table declared-constraint validation', () => {
	let db: Database;
	beforeEach(() => { db = new Database(); });
	afterEach(async () => { await db.close(); });

	async function readAll(sql: string): Promise<Record<string, unknown>[]> {
		const rows: Record<string, unknown>[] = [];
		for await (const row of db.eval(sql)) rows.push({ ...row });
		return rows;
	}

	async function expectError(sql: string, messagePart: string): Promise<void> {
		try {
			await db.exec(sql);
		} catch (e) {
			expect((e as Error).message).to.contain(messagePart);
			return;
		}
		expect.fail(`expected '${sql}' to fail with: ${messagePart}`);
	}

	/** Runs `fn`, counting `db._queueDeferredConstraintRow` calls made during it — the
	 *  discriminator between a healthy auto-deferred CHECK (1 per written image) and a
	 *  poisoned validator's inline throw (0, it never reaches the deferred queue). */
	async function withDeferredCount(fn: () => Promise<void>): Promise<number> {
		let deferred = 0;
		const origQueue = db._queueDeferredConstraintRow.bind(db);
		db._queueDeferredConstraintRow = ((...args: Parameters<typeof origQueue>) => {
			deferred++;
			return origQueue(...args);
		}) as typeof db._queueDeferredConstraintRow;
		try {
			await fn();
		} finally {
			db._queueDeferredConstraintRow = origQueue;
		}
		return deferred;
	}

	describe('zero-overhead gate', () => {
		it('a source write to a constraint-less maintained table prepares nothing and defers nothing', async () => {
			await db.exec(`
				create table src (id integer primary key, v text not null);
				create table mt (id integer primary key, v text not null) maintained as select id, v from src;
			`);
			let prepares = 0;
			let deferred: number;
			const origPrepare = db.prepare.bind(db);
			db.prepare = ((sql: string) => { prepares++; return origPrepare(sql); }) as typeof db.prepare;
			try {
				deferred = await withDeferredCount(() => db.exec(`insert into src values (1, 'a')`));
			} finally {
				db.prepare = origPrepare;
			}
			expect(prepares, 'no validation prepare on the write path').to.equal(0);
			expect(deferred, 'no deferred-constraint enqueue').to.equal(0);
			expect(await readAll('select count(*) as n from mt')).to.deep.equal([{ n: 1 }]);
		});

		it('an MV-sugar table (empty constraint set by construction) likewise validates nothing', async () => {
			await db.exec(`
				create table src (id integer primary key, v text not null);
				create materialized view mv1 as select id, v from src;
			`);
			const deferred = await withDeferredCount(() => db.exec(`insert into src values (1, 'a')`));
			expect(deferred).to.equal(0);
			expect(await readAll('select count(*) as n from mv1')).to.deep.equal([{ n: 1 }]);
		});

		it('a declared child-side FK DOES enqueue a deferred check per written image', async () => {
			await db.exec(`
				create table parent (pid integer primary key);
				create table src (id integer primary key, ref integer null);
				create table mt (id integer primary key, ref integer null references parent(pid))
					maintained as select id, ref from src;
				insert into parent values (1);
			`);
			const deferred = await withDeferredCount(() => db.exec(`insert into src values (1, 1)`));
			expect(deferred, 'one FK existence check queued for the one derived image').to.equal(1);
		});
	});

	describe('deferred validation at commit (explicit transaction)', () => {
		beforeEach(async () => {
			await db.exec(`
				create table parent (pid integer primary key);
				create table src (id integer primary key, ref integer null);
				create table mt (id integer primary key, ref integer null references parent(pid))
					maintained as select id, ref from src;
			`);
		});

		it('an orphan admitted mid-transaction is satisfied by a parent arriving before commit', async () => {
			await db.exec('begin');
			await db.exec(`insert into src values (1, 42)`); // parent 42 does not exist yet
			await db.exec(`insert into parent values (42)`);
			await db.exec('commit');
			expect(await readAll('select * from mt')).to.deep.equal([{ id: 1, ref: 42 }]);
		});

		it('an unresolved orphan fails the COMMIT with maintained-table attribution and rolls back whole', async () => {
			await db.exec('begin');
			await db.exec(`insert into src values (2, 99)`);
			await expectError('commit', `row derived into maintained table 'main.mt' references a missing 'main.parent'`);
			expect(await readAll('select count(*) as n from src')).to.deep.equal([{ n: 0 }]);
			expect(await readAll('select count(*) as n from mt')).to.deep.equal([{ n: 0 }]);
		});

		it('a subquery-bearing CHECK defers to commit and carries the attribution', async () => {
			await db.exec(`
				create table quota (k integer primary key, lim integer not null);
				insert into quota values (1, 1);
				create table qsrc (id integer primary key, n integer not null);
				create table mq (id integer primary key, n integer not null
					check (n <= (select lim from quota where k = 1)))
					maintained as select id, n from qsrc;
			`);
			await db.exec('begin');
			await db.exec(`insert into qsrc values (1, 5)`); // violates against current quota
			await db.exec(`update quota set lim = 10 where k = 1`); // …but final state satisfies
			await db.exec('commit');
			expect(await readAll('select count(*) as n from mq')).to.deep.equal([{ n: 1 }]);

			await db.exec('begin');
			await db.exec(`insert into qsrc values (2, 50)`);
			await expectError('commit', `row derived into maintained table 'main.mq'`);
			expect(await readAll('select count(*) as n from qsrc')).to.deep.equal([{ n: 1 }]);
		});
	});

	describe('cascade attribution', () => {
		it('a two-level chain attributes the violation to the consumer that declares the constraint', async () => {
			await db.exec(`
				create table base (id integer primary key, v text not null);
				create table mt1 (id integer primary key, v text not null) maintained as select id, v from base;
				create table mt2 (id integer primary key, v text not null check (v <> 'poison'))
					maintained as select id, v from mt1;
			`);
			await expectError(
				`insert into base values (1, 'poison')`,
				`row derived into maintained table 'main.mt2'`,
			);
			// the producer level was rolled back with the statement
			expect(await readAll('select count(*) as n from mt1')).to.deep.equal([{ n: 0 }]);
		});
	});

	// A maintained table's derived-row validator is compiled ONCE at registration and
	// bakes in the live incarnations of its CONSTRAINT-ONLY dependencies (FK parent /
	// subquery-CHECK target — neither a derivation source, so the source-change path
	// never rebuilds them). A rename/drop/re-create of such a dependency must rebuild
	// the validator (ticket maintained-table-validator-stale-on-dependency-ddl); before
	// the fix a stale validator failed maintenance writes with an internal
	// "Module 'memory' connect failed … not found" error.
	describe('constraint-dependency DDL invalidation', () => {
		describe('FK parent rename', () => {
			beforeEach(async () => {
				await db.exec(`
					create table parent (pid integer primary key);
					create table src (id integer primary key, ref integer null);
					create table mt (id integer primary key, ref integer null references parent(pid))
						maintained as select id, ref from src;
					insert into parent values (10);
					alter table parent rename to parent2;
				`);
			});

			it('a valid source write referencing the renamed parent still maintains', async () => {
				await db.exec(`insert into src values (1, 10)`);
				expect(await readAll('select * from mt')).to.deep.equal([{ id: 1, ref: 10 }]);
			});

			it('an orphan write fails with the FK attribution against the RENAMED parent', async () => {
				await expectError(`insert into src values (2, 99)`,
					`row derived into maintained table 'main.mt' references a missing 'main.parent2'`);
				expect(await readAll('select count(*) as n from mt')).to.deep.equal([{ n: 0 }]);
			});
		});

		describe('FK parent drop', () => {
			beforeEach(async () => {
				// mt is empty at drop time (src empty), so the drop's referencing-children
				// guard passes; the rebuild then emits the absent-parent null-guards fallback.
				await db.exec(`
					create table parent (pid integer primary key);
					create table src (id integer primary key, ref integer null);
					create table mt (id integer primary key, ref integer null references parent(pid))
						maintained as select id, ref from src;
					drop table parent;
				`);
			});

			it('a non-NULL-ref write fails with the maintained-table FK CONSTRAINT error (not INTERNAL)', async () => {
				let message = '';
				try {
					await db.exec(`insert into src values (1, 5)`);
					expect.fail('expected the rebuilt absent-parent validator to reject the orphan');
				} catch (e) {
					message = (e as Error).message;
				}
				expect(message).to.contain(`row derived into maintained table 'main.mt' references a missing 'main.parent'`);
				// NOT the stale-validator internal module-connect failure
				expect(message).to.not.contain('connect failed');
				expect(message).to.not.contain('Cannot connect');
				expect(await readAll('select count(*) as n from mt')).to.deep.equal([{ n: 0 }]);
			});

			it('a NULL ref is admitted (MATCH SIMPLE)', async () => {
				await db.exec(`insert into src values (2, null)`);
				expect(await readAll('select * from mt')).to.deep.equal([{ id: 2, ref: null }]);
			});
		});

		// A maintained table's declared CHECK is a stored expression like any other, so
		// dropping the table its subquery reads is REFUSED, naming the maintained table and
		// the constraint (`runtime/emit/expression-drop-guard.ts`). The drop used to be
		// accepted and left the validator poisoned; the poisoned-validator fallback the
		// rebuild still carries is now defensive only, for internal drop paths (rollback,
		// catalog import) that no SQL statement can drive.
		describe('subquery-CHECK target drop', () => {
			beforeEach(async () => {
				await db.exec(`
					create table quota (k integer primary key, lim integer not null);
					insert into quota values (1, 100);
					create table qsrc (id integer primary key, n integer not null);
					create table mq (id integer primary key, n integer not null
						check (n <= (select lim from quota where k = 1)))
						maintained as select id, n from qsrc;
				`);
			});

			it('the drop is refused, naming the maintained table and its CHECK', async () => {
				await expectError(`drop table quota`,
					`it is referenced by CHECK constraint '_check_n' on table 'mq'`);
			});

			it('nothing is applied, so the CHECK keeps validating', async () => {
				await expectError(`drop table quota`, `it is referenced by CHECK constraint`);
				await db.exec(`insert into qsrc values (1, 5)`);
				expect(await readAll('select * from mq')).to.deep.equal([{ id: 1, n: 5 }]);
				await expectError(`insert into qsrc values (2, 500)`,
					`row derived into maintained table 'main.mq'`);
			});

			it('dropping the maintained table first releases the target', async () => {
				await db.exec(`drop table mq; drop table quota;`);
			});
		});

		// The two recovery arms `rebuildConstraintValidatorsFor` carries for a dropped
		// subquery-CHECK target — degrade to a poisoned validator, self-heal on re-create
		// (folded into `self-heal on dependency re-create` below) — can no longer be driven
		// from SQL: the drop above is refused. They are not dead code. The refusal
		// (`assertNoExpressionDependsOn`) is wired into the DROP emitters only, never into
		// `SchemaManager.dropTable`, and two internal callers reach the manager directly:
		// catalog import on store reopen drops a pre-existing colliding backing before
		// re-materializing it under the same name (`SchemaManager.importMaterializedView`),
		// and a half-built maintained table is dropped when its create/import fails partway
		// (`materializeView`). Either can remove a table some OTHER maintained table's CHECK
		// reads. So these tests drive the manager directly, bypassing the emitter exactly as
		// those callers do — do not "fix" them back to `drop table`, which only re-tests the
		// refusal and silently drops this coverage.
		// NOTE: this rests on the refusal staying at the emitter layer. If
		// `assertNoExpressionDependsOn` is ever moved into `SchemaManager.dropTable` itself,
		// these two arms become genuinely unreachable — retire the arms and this block
		// together rather than reaching past the guard to keep them green.
		describe('subquery-CHECK target dropped out of band (poisoned validator)', () => {
			beforeEach(async () => {
				await db.exec(`
					create table quota (k integer primary key, lim integer not null);
					insert into quota values (1, 100);
					create table qsrc (id integer primary key, n integer not null);
					create table mq (id integer primary key, n integer not null
						check (n <= (select lim from quota where k = 1)))
						maintained as select id, n from qsrc;
				`);
			});

			it('baseline: a healthy subquery-CHECK auto-defers, one enqueue per written image', async () => {
				const deferred = await withDeferredCount(() => db.exec(`insert into qsrc values (1, 5)`));
				expect(deferred).to.equal(1);
			});

			it('the out-of-band drop resolves without throwing, and an unrelated statement afterwards still succeeds', async () => {
				const removed = await db.schemaManager.dropTable('main', 'quota');
				expect(removed).to.equal(true);
				// the schema-change listener swallowed the rebuild failure rather than
				// propagating it into this unrelated statement
				await db.exec(`create table unrelated (id integer primary key); insert into unrelated values (1)`);
			});

			it('a conforming source write is rejected by the poisoned validator with the sited planning error', async () => {
				await db.schemaManager.dropTable('main', 'quota');
				let message = '';
				const deferred = await withDeferredCount(async () => {
					try {
						await db.exec(`insert into qsrc values (1, 5)`); // 5 <= 100 — conforming, if quota still existed
						expect.fail('expected the poisoned validator to reject the write');
					} catch (e) {
						message = (e as Error).message;
					}
				});
				expect(message).to.contain(`Table 'quota' not found in schema path: main`);
				// NOT the stale-validator internal module-connect failure
				expect(message).to.not.contain('connect failed');
				expect(message).to.not.contain('Cannot connect');
				expect(deferred, 'poisoned validator throws inline, before any deferred enqueue').to.equal(0);
				expect(await readAll('select count(*) as n from qsrc')).to.deep.equal([{ n: 0 }]);
				expect(await readAll('select count(*) as n from mq')).to.deep.equal([{ n: 0 }]);
			});

			it('a delete after poisoning still succeeds (no row image, so no CHECK is validated)', async () => {
				await db.exec(`insert into qsrc values (1, 5)`);
				await db.schemaManager.dropTable('main', 'quota');
				await db.exec(`delete from qsrc where id = 1`);
				expect(await readAll('select count(*) as n from qsrc')).to.deep.equal([{ n: 0 }]);
				expect(await readAll('select count(*) as n from mq')).to.deep.equal([{ n: 0 }]);
			});
		});

		describe('subquery-CHECK target rename', () => {
			beforeEach(async () => {
				await db.exec(`
					create table quota (k integer primary key, lim integer not null);
					insert into quota values (1, 100);
					create table qsrc (id integer primary key, n integer not null);
					create table mq (id integer primary key, n integer not null
						check (n <= (select lim from quota where k = 1)))
						maintained as select id, n from qsrc;
					alter table quota rename to quota2;
				`);
			});

			it('the CHECK still validates against the renamed target (conforming write flows)', async () => {
				await db.exec(`insert into qsrc values (1, 5)`);
				expect(await readAll('select * from mq')).to.deep.equal([{ id: 1, n: 5 }]);
			});

			it('a violating write fails the CHECK with maintained-table attribution', async () => {
				await expectError(`insert into qsrc values (2, 500)`,
					`row derived into maintained table 'main.mq'`);
				expect(await readAll('select count(*) as n from mq')).to.deep.equal([{ n: 0 }]);
			});
		});

		// The subquery-CHECK arm below drives the `table_added` rebuild the same way
		// `subquery-CHECK target dropped out of band` drives the poisoned-validator arm:
		// directly through `SchemaManager.dropTable`, since SQL can no longer produce the
		// drop half (see `subquery-CHECK target drop` above) and a maintained table cannot
		// be declared against an absent CHECK target either. The FK-parent arm needs no
		// such workaround — a parent drop with no referencing rows is allowed through SQL
		// and only rebuilds the validator.
		describe('self-heal on dependency re-create', () => {
			it('re-creating a dropped FK parent restores existence validation', async () => {
				await db.exec(`
					create table parent (pid integer primary key);
					create table src (id integer primary key, ref integer null);
					create table mt (id integer primary key, ref integer null references parent(pid))
						maintained as select id, ref from src;
					drop table parent;
					create table parent (pid integer primary key);
					insert into parent values (7);
				`);
				// validator self-healed: a ref present in the re-created parent is admitted…
				await db.exec(`insert into src values (1, 7)`);
				expect(await readAll('select * from mt')).to.deep.equal([{ id: 1, ref: 7 }]);
				// …and an orphan still fails against the re-created parent
				await expectError(`insert into src values (2, 99)`,
					`row derived into maintained table 'main.mt' references a missing 'main.parent'`);
			});

			it('re-creating a dropped subquery-CHECK target restores CHECK validation', async () => {
				await db.exec(`
					create table quota (k integer primary key, lim integer not null);
					insert into quota values (1, 100);
					create table qsrc (id integer primary key, n integer not null);
					create table mq (id integer primary key, n integer not null
						check (n <= (select lim from quota where k = 1)))
						maintained as select id, n from qsrc;
				`);
				await db.schemaManager.dropTable('main', 'quota');
				await db.exec(`
					create table quota (k integer primary key, lim integer not null);
					insert into quota values (1, 100);
				`);
				// validator self-healed: a conforming write flows into mq again, auto-deferring
				// exactly as a never-poisoned validator would…
				const deferred = await withDeferredCount(() => db.exec(`insert into qsrc values (1, 5)`));
				expect(await readAll('select * from mq')).to.deep.equal([{ id: 1, n: 5 }]);
				expect(deferred, 'healed validator auto-defers again').to.equal(1);
				// …and a violating write is rejected with the maintained-table attribution
				await expectError(`insert into qsrc values (2, 500)`,
					`row derived into maintained table 'main.mq'`);
			});
		});

		describe('shared dependency across plans', () => {
			// The rebuild scans every registered plan; the other cases only ever have a
			// single matching plan. Two maintained tables sharing one FK parent exercise
			// the multi-plan path — a single rename must rebuild BOTH validators.
			it('renaming an FK parent shared by two maintained tables rebuilds both validators', async () => {
				await db.exec(`
					create table parent (pid integer primary key);
					create table sa (id integer primary key, ref integer null);
					create table sb (id integer primary key, ref integer null);
					create table ma (id integer primary key, ref integer null references parent(pid))
						maintained as select id, ref from sa;
					create table mb (id integer primary key, ref integer null references parent(pid))
						maintained as select id, ref from sb;
					insert into parent values (10);
					alter table parent rename to parent2;
				`);
				// Both maintained tables re-resolve against the renamed parent: a valid
				// ref flows…
				await db.exec(`insert into sa values (1, 10)`);
				await db.exec(`insert into sb values (1, 10)`);
				expect(await readAll('select * from ma')).to.deep.equal([{ id: 1, ref: 10 }]);
				expect(await readAll('select * from mb')).to.deep.equal([{ id: 1, ref: 10 }]);
				// …and each rejects an orphan with attribution against the RENAMED parent.
				await expectError(`insert into sa values (2, 99)`,
					`row derived into maintained table 'main.ma' references a missing 'main.parent2'`);
				await expectError(`insert into sb values (2, 99)`,
					`row derived into maintained table 'main.mb' references a missing 'main.parent2'`);
			});
		});

		describe('rebuild preserves existing maintained rows', () => {
			// The rebuild swaps only the validator; the backing rows must be untouched.
			it('an FK-parent rename leaves pre-existing maintained rows intact and validates new writes', async () => {
				await db.exec(`
					create table parent (pid integer primary key);
					create table src (id integer primary key, ref integer null);
					create table mt (id integer primary key, ref integer null references parent(pid))
						maintained as select id, ref from src;
					insert into parent values (10);
					insert into src values (1, 10);
				`);
				// A row validated against the pre-rename parent is already in the backing.
				expect(await readAll('select * from mt order by id')).to.deep.equal([{ id: 1, ref: 10 }]);
				await db.exec(`alter table parent rename to parent2`);
				// The pre-existing row survives the rename untouched…
				expect(await readAll('select * from mt order by id')).to.deep.equal([{ id: 1, ref: 10 }]);
				// …a new conforming write still maintains against the renamed parent…
				await db.exec(`insert into src values (2, 10)`);
				expect(await readAll('select * from mt order by id'))
					.to.deep.equal([{ id: 1, ref: 10 }, { id: 2, ref: 10 }]);
				// …and an orphan is rejected against the renamed parent.
				await expectError(`insert into src values (3, 99)`,
					`row derived into maintained table 'main.mt' references a missing 'main.parent2'`);
			});
		});
	});
});
