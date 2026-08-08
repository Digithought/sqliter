import { expect } from 'chai';
import { Database } from '../src/index.js';

/**
 * `refresh materialized view` re-validation pins for the one derivation write
 * path that previously bypassed declared-constraint validation — a manual
 * refresh of a constraint-bearing **table-form** maintained table
 * (`maintained-table-refresh-revalidation`).
 *
 * The real-world trigger is a STALE table: a body-relevant source schema change
 * marks the maintained table stale and releases its row-time plan, so subsequent
 * source writes are NOT maintained into it (nor validated against its declared
 * CHECK/FK). A later `refresh` recomputes from that drifted source state and —
 * before this ticket — committed it unvalidated. Now the constraint-bearing
 * `rebuildBacking` branch lands the recomputed set in the connection's pending
 * layer, runs the same bulk anti-join / `not(<check>)` scan the attach core uses,
 * throws the maintained-table-attributed diagnostic on the first violator BEFORE
 * committing, and only commits a conforming set.
 *
 * Orchestration note: each "stale → drift" flow does
 *   (1) seed a clean row → (2) a body-relevant source ALTER (stale + plan
 *   released) → (3) drift a violator into the unmaintained source →
 *   (4) `refresh` and assert.
 * The stale trigger is `alter column g set collate nocase` on column `g`, which every
 * body reads only in its `where g <> 'skip'` predicate: a value-semantics (collation)
 * change to a READ column is content-relevant, so the in-place recompile declines and the
 * dependent is marked stale with its plan detached — while the body's projected output
 * shape is unchanged, so `refresh` recomputes through the ordinary (non-reshape) path.
 * (A structural ALTER the body provably does NOT read now keeps the dependent LIVE —
 * see 53.4-materialized-view-structural-alter-restore.sqllogic.)
 *
 * The two `reshape arm: …-sensitive CHECK` blocks below cover the case where the
 * source ALTER also shifts the maintained table's own column attributes, so the
 * refresh takes the RESHAPE arm and the column is retyped/recollated as part of the
 * refresh. The scan there resolves against the attributes the reshape is about to
 * land (`previewReshapedColumns`), not the ones it is replacing — so a CHECK whose
 * truth flips under the new type or collation is rejected before the commit, same as
 * on the non-reshape arm. The type/collation-INSENSITIVE controls in those blocks
 * pin that the fix did not disturb the ordinary path.
 */
describe('Maintained-table refresh re-validation', () => {
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
			expect((e as Error).message, `error message for '${sql}'`).to.contain(messagePart);
			return;
		}
		expect.fail(`expected '${sql}' to fail with: ${messagePart}`);
	}

	function isStale(name: string): boolean {
		return db.schemaManager.getMaintainedTable('main', name)!.derivation.stale === true;
	}

	describe('stale fast-path CHECK violation', () => {
		beforeEach(async () => {
			await db.exec(`
				create table src (id integer primary key, v text not null, g text not null default 'keep');
				create table mt (id integer primary key, v text not null, check (v <> 'poison'))
					maintained as select id, v from src where g <> 'skip';
				insert into src (id, v) values (1, 'clean');
			`);
			// Content-relevant source change: a collation change on `g` (read in the body's
			// WHERE) stales mt and detaches its row-time plan, so the drift below is NOT
			// maintained in. (Pre-feature this used `add column`, which now keeps the MV live.)
			await db.exec(`alter table src alter column g set collate nocase`);
			expect(isStale('mt'), 'source ALTER marked mt stale').to.equal(true);
		});

		it('a refresh that recomputes a CHECK-violating row throws the attribution and leaves the pre-refresh rows intact', async () => {
			// Drift a violator into the (now unmaintained) source.
			await db.exec(`insert into src (id, v) values (2, 'poison')`);
			expect(await readAll('select id, v from mt order by id'), 'drift not maintained in')
				.to.deep.equal([{ id: 1, v: 'clean' }]);

			await expectError('refresh materialized view mt',
				`row derived into maintained table 'main.mt'`);

			// The pre-refresh committed contents survive; mt stays stale so the next read
			// re-validates/serves the snapshot rather than the rejected set.
			expect(await readAll('select id, v from mt order by id')).to.deep.equal([{ id: 1, v: 'clean' }]);
			expect(isStale('mt'), 'mt stays stale after a rejected refresh').to.equal(true);
		});

		it('a refresh that recomputes only conforming rows succeeds and clears stale', async () => {
			await db.exec(`insert into src (id, v) values (2, 'fresh')`);
			await db.exec('refresh materialized view mt');
			expect(await readAll('select id, v from mt order by id'))
				.to.deep.equal([{ id: 1, v: 'clean' }, { id: 2, v: 'fresh' }]);
			expect(isStale('mt'), 'a conforming refresh clears stale').to.equal(false);
		});
	});

	describe('stale fast-path child-side FK orphan', () => {
		beforeEach(async () => {
			await db.exec(`
				create table parent (pid integer primary key);
				create table src (id integer primary key, ref integer null, g text not null default 'keep');
				create table mt (id integer primary key, ref integer null references parent(pid))
					maintained as select id, ref from src where g <> 'skip';
				insert into parent values (1);
				insert into src (id, ref) values (1, 1);
			`);
			expect(await readAll('select id, ref from mt')).to.deep.equal([{ id: 1, ref: 1 }]);
			await db.exec(`alter table src alter column g set collate nocase`);
			expect(isStale('mt'), 'source ALTER marked mt stale').to.equal(true);
		});

		it('a refresh that recomputes an orphan throws the FK attribution and leaves the pre-refresh rows intact', async () => {
			await db.exec(`insert into src (id, ref) values (2, 99)`); // parent 99 absent
			await expectError('refresh materialized view mt',
				`references a missing 'main.parent'`);
			expect(await readAll('select id, ref from mt order by id')).to.deep.equal([{ id: 1, ref: 1 }]);
			expect(isStale('mt')).to.equal(true);
		});

		it('a refresh whose orphan-drift has a matching parent succeeds and clears stale', async () => {
			await db.exec(`insert into parent values (2)`);
			await db.exec(`insert into src (id, ref) values (2, 2)`);
			await db.exec('refresh materialized view mt');
			expect(await readAll('select id, ref from mt order by id'))
				.to.deep.equal([{ id: 1, ref: 1 }, { id: 2, ref: 2 }]);
			expect(isStale('mt')).to.equal(false);
		});

		it('a NULL-ref drift passes (MATCH SIMPLE)', async () => {
			await db.exec(`insert into src (id, ref) values (2, null)`);
			await db.exec('refresh materialized view mt');
			expect(await readAll('select id, ref from mt order by id'))
				.to.deep.equal([{ id: 1, ref: 1 }, { id: 2, ref: null }]);
			expect(isStale('mt')).to.equal(false);
		});

		it('an empty recomputed set succeeds (the bulk scan over empty contents trivially passes)', async () => {
			await db.exec('delete from src'); // unmaintained while stale
			await db.exec('refresh materialized view mt');
			expect(await readAll('select count(*) as n from mt')).to.deep.equal([{ n: 0 }]);
			expect(isStale('mt')).to.equal(false);
		});
	});

	describe('constraint-clean fast path is byte-identical (no validation scan)', () => {
		/** Run `body` with `db.prepare` wrapped, returning every SQL string prepared
		 *  during it. A bulk constraint validation prepares a `where not (<check>)`
		 *  CHECK scan or a `not exists (…)` FK anti-join; a constraint-less refresh
		 *  prepares only its body SELECT. */
		async function capturePrepares(body: () => Promise<void>): Promise<string[]> {
			const seen: string[] = [];
			const orig = db.prepare.bind(db);
			db.prepare = ((sql: string) => { seen.push(sql); return orig(sql); }) as typeof db.prepare;
			try {
				await body();
			} finally {
				db.prepare = orig;
			}
			return seen;
		}

		const isValidationScan = (sql: string): boolean =>
			/where not \(/i.test(sql) || /not exists \(/i.test(sql);

		it('a constraint-less table-form maintained table refresh runs no validation scan', async () => {
			await db.exec(`
				create table src (id integer primary key, v text not null, g text not null default 'keep');
				create table mt (id integer primary key, v text not null) maintained as select id, v from src where g <> 'skip';
				insert into src (id, v) values (1, 'a');
			`);
			await db.exec(`alter table src alter column g set collate nocase`); // stale
			await db.exec(`insert into src (id, v) values (2, 'b')`);

			const prepares = await capturePrepares(async () => {
				await db.exec('refresh materialized view mt');
			});
			expect(prepares.some(isValidationScan), 'no validation scan on a constraint-less refresh').to.equal(false);
			expect(await readAll('select id, v from mt order by id'))
				.to.deep.equal([{ id: 1, v: 'a' }, { id: 2, v: 'b' }]);
		});

		it('an MV-sugar refresh runs no validation scan', async () => {
			await db.exec(`
				create table src (id integer primary key, v text not null, g text not null default 'keep');
				create materialized view mv as select id, v from src where g <> 'skip';
				insert into src (id, v) values (1, 'a');
			`);
			await db.exec(`alter table src alter column g set collate nocase`); // stale
			await db.exec(`insert into src (id, v) values (2, 'b')`);

			const prepares = await capturePrepares(async () => {
				await db.exec('refresh materialized view mv');
			});
			expect(prepares.some(isValidationScan), 'no validation scan on an MV-sugar refresh').to.equal(false);
			expect(await readAll('select id, v from mv order by id'))
				.to.deep.equal([{ id: 1, v: 'a' }, { id: 2, v: 'b' }]);
		});

		it('positive control: a constraint-bearing refresh DOES run a validation scan', async () => {
			await db.exec(`
				create table src (id integer primary key, v text not null, g text not null default 'keep');
				create table mt (id integer primary key, v text not null, check (v <> 'poison'))
					maintained as select id, v from src where g <> 'skip';
				insert into src (id, v) values (1, 'a');
			`);
			await db.exec(`alter table src alter column g set collate nocase`); // stale
			await db.exec(`insert into src (id, v) values (2, 'b')`);

			const prepares = await capturePrepares(async () => {
				await db.exec('refresh materialized view mt');
			});
			expect(prepares.some(isValidationScan), 'a constraint-bearing refresh runs the bulk scan').to.equal(true);
		});
	});

	describe('pragma foreign_keys = off keeps the fast path (no retro-validation)', () => {
		it('an FK-only maintained table refresh succeeds over an orphan drift when enforcement is off', async () => {
			await db.exec(`pragma foreign_keys = off`);
			await db.exec(`
				create table parent (pid integer primary key);
				create table src (id integer primary key, ref integer null, g text not null default 'keep');
				create table mt (id integer primary key, ref integer null references parent(pid))
					maintained as select id, ref from src where g <> 'skip';
				insert into parent values (1);
				insert into src (id, ref) values (1, 1);
			`);
			await db.exec(`alter table src alter column g set collate nocase`); // stale
			await db.exec(`insert into src (id, ref) values (2, 99)`); // orphan, unmaintained

			// FK enforcement off ⇒ the FK scan would no-op, so the table keeps the
			// validation-free fast path and the refresh admits the orphan (matching
			// ordinary tables — pragma flips do not retro-validate).
			await db.exec('refresh materialized view mt');
			expect(await readAll('select id, ref from mt order by id'))
				.to.deep.equal([{ id: 1, ref: 1 }, { id: 2, ref: 99 }]);
			expect(isStale('mt')).to.equal(false);
		});
	});

	describe('reshape arm + violation', () => {
		it('a stale reshape that recomputes a violator throws the attribution and is not left holding it', async () => {
			await db.exec(`
				create table src (id integer primary key, v text);
				create table mt (id integer primary key, v text, check (v <> 'poison'))
					maintained as select * from src;
				insert into src values (1, 'clean');
			`);
			// A trailing source add shifts the select* body's shape ⇒ refresh takes the
			// reshape arm; mt goes stale and its plan detaches.
			await db.exec(`alter table src add column w integer default 0`);
			expect(isStale('mt'), 'source ALTER marked mt stale').to.equal(true);
			await db.exec(`insert into src (id, v, w) values (2, 'poison', 0)`); // drift, unmaintained

			await expectError('refresh materialized view mt',
				`row derived into maintained table 'main.mt'`);

			// The reshape's pre-reconcile structural add ran (non-transactional), so the
			// table now has the w column — but the validation threw before the swap
			// committed, so the violating row never landed and mt stays stale.
			const rows = await readAll('select id, v from mt order by id');
			expect(rows.every(r => r.v !== 'poison'), 'no violating row committed').to.equal(true);
			expect(rows).to.deep.equal([{ id: 1, v: 'clean' }]);
			expect(isStale('mt'), 'mt stays stale after a rejected reshape refresh').to.equal(true);
		});
	});

	describe('reshape arm: collation-sensitive CHECK', () => {
		// The reshape arm evaluates a declared CHECK under the collation the reshape is
		// LANDING, not the one it is replacing. `reshapeBackingInPlace` still sequences:
		//   3. rebuildBacking → validateDeclaredConstraintsOverContents (validates + COMMITS)
		//   4. post-reconcile RECOLLATE (re-keys/re-validates, applies the NEW collation)
		// — the ordering is unchanged and commit-first parity is preserved — but step 3
		// is handed `previewReshapedColumns`, the column list carrying step 4's collation,
		// so a comparison resolves against the FINAL collation while still validating
		// before the commit. A CHECK whose truth flips under the recollate is therefore
		// rejected with nothing written. The attach reshape path passes the same preview,
		// so both arms reject identically. See docs/materialized-views.md § REFRESH
		// MATERIALIZED VIEW.

		/** The live backing collation of column `v` — BINARY before the reshape's
		 *  post-reconcile recollate runs, NOCASE after. The flip is the observable proof
		 *  the refresh took the RESHAPE arm with a `recollate` op (the fast path would
		 *  leave the collation untouched). Note the flip only happens on a SUCCESSFUL
		 *  refresh: a rejected one throws in step 3, so step 4 never runs and the catalog
		 *  keeps the OLD collation — which is why the reject tests below assert BINARY. */
		function vCollation(name: string): string {
			const col = db.schemaManager.getMaintainedTable('main', name)!.columns.find(c => c.name === 'v');
			return col!.collation ?? 'BINARY';
		}

		it('a recollate-during-reshape rejects a row that violates its CHECK under the FINAL collation', async () => {
			await db.exec(`
				create table src (id integer primary key, v text);
				create table mt (id integer primary key, v text, check (v <> 'abc'))
					maintained as select * from src;
				insert into src values (1, 'ABC');
			`);
			// Clean under BINARY: 'ABC' <> 'abc' is true, so create-fill admits the row.
			expect(vCollation('mt'), 'v starts BINARY').to.equal('BINARY');

			// A source RECOLLATE is body-relevant (the `select *` output collation shifts —
			// bodyRelevantColumnMatches compares collation) ⇒ mt goes stale and its row-time
			// plan detaches, so the row is not re-validated until refresh.
			await db.exec(`alter table src alter column v set collate nocase`);
			expect(isStale('mt'), 'set collate marked mt stale').to.equal(true);
			// The catalog still carries the OLD collation until the reshape's step-4 recollate.
			expect(vCollation('mt'), 'catalog v still BINARY pre-refresh').to.equal('BINARY');

			// Refresh takes the reshape arm. Step-3's scan resolves `v <> 'abc'` under the
			// PREVIEWED NOCASE collation — the one step 4 is about to land — where
			// 'ABC' = 'abc', so the row violates and the refresh is REJECTED before commit.
			await expectError('refresh materialized view mt',
				`row derived into maintained table 'main.mt'`);
			// Pre-refresh contents survive and mt stays stale: same guarantee the
			// non-reshape arm gives, because the scan sits at the same point in the sequence.
			expect(await readAll('select id, v from mt order by id'),
				'the rejected refresh committed nothing; pre-refresh contents intact')
				.to.deep.equal([{ id: 1, v: 'ABC' }]);
			expect(isStale('mt'), 'a rejected reshape refresh leaves mt stale').to.equal(true);
			// Step 4 never ran, so the catalog column keeps its OLD collation.
			expect(vCollation('mt'), 'rejected refresh leaves v BINARY (post-reconcile ops never ran)')
				.to.equal('BINARY');

			// Correct the offending source row and refresh again: NOW the reshape completes,
			// and the collation flip is the proof the recollate arm was the one being exercised.
			await db.exec(`update src set v = 'xyz' where id = 1`);
			await db.exec('refresh materialized view mt');
			expect(vCollation('mt'), 'v recollated to NOCASE ⇒ reshape arm + recollate ran').to.equal('NOCASE');
			expect(await readAll('select id, v from mt order by id')).to.deep.equal([{ id: 1, v: 'xyz' }]);
			expect(isStale('mt'), 'the successful reshape clears stale').to.equal(false);
		});

		it('control: a collation-INSENSITIVE CHECK over the same recollate reshape still rejects a genuine violator', async () => {
			// Same reshape (recollate v BINARY → NOCASE), but the CHECK is a value-domain
			// `id > 0` — its truth does NOT depend on any collation. The step-3 scan enforces
			// it correctly, so a drifted -1 row IS rejected. This scopes the limitation
			// strictly to collation-SENSITIVE comparisons (the validation path itself is sound).
			await db.exec(`
				create table src (id integer primary key, v text);
				create table mt (id integer primary key, v text, check (id > 0))
					maintained as select * from src;
				insert into src values (1, 'x');
			`);
			await db.exec(`alter table src alter column v set collate nocase`); // recollate reshape ⇒ stale
			expect(isStale('mt'), 'set collate marked mt stale').to.equal(true);
			await db.exec(`insert into src values (-1, 'y')`); // drift: violates id > 0, unmaintained

			await expectError('refresh materialized view mt',
				`row derived into maintained table 'main.mt'`);
			// Pre-refresh contents survive (the scan threw before commit); mt stays stale.
			expect(await readAll('select id from mt order by id')).to.deep.equal([{ id: 1 }]);
			expect(isStale('mt'), 'a rejected reshape refresh leaves mt stale').to.equal(true);
		});

		it('after a successful recollate reshape, row-time maintenance enforces the NEW collation', async () => {
			// The bulk scan (above) and the row-time derived-row validator (here) are two
			// distinct enforcement points; this pins that the second one also resolves under
			// the post-reshape collation, reached from a CLEAN successful refresh.
			await db.exec(`
				create table src (id integer primary key, v text);
				create table mt (id integer primary key, v text, check (v <> 'abc'))
					maintained as select * from src;
				insert into src values (1, 'xyz');
			`);
			await db.exec(`alter table src alter column v set collate nocase`);
			await db.exec('refresh materialized view mt');
			expect(vCollation('mt'), 'the reshape landed NOCASE').to.equal('NOCASE');
			expect(await readAll('select id, v from mt order by id'), 'conforming set committed')
				.to.deep.equal([{ id: 1, v: 'xyz' }]);
			expect(isStale('mt'), 'successful refresh clears stale').to.equal(false);

			// A value-identical source touch produces NO derived-row delta, so the maintenance
			// manager suppresses the backing op entirely — nothing to validate, nothing changes.
			await db.exec(`update src set v = v where id = 1`);
			expect(await readAll('select id, v from mt order by id'), 'no-delta touch is a no-op')
				.to.deep.equal([{ id: 1, v: 'xyz' }]);

			// A GENUINE delta deriving a value that is <> 'abc' under BINARY but = 'abc' under
			// NOCASE runs buildDerivedRowValidator under the NEW collation ⇒ REJECTED.
			await expectError(`update src set v = 'Abc' where id = 1`,
				`row derived into maintained table 'main.mt'`);
			// …and the rejected write rolls back, leaving the committed row unchanged.
			expect(await readAll('select id, v from mt order by id'), 'rejected update rolls back')
				.to.deep.equal([{ id: 1, v: 'xyz' }]);

			// A brand-new source row deriving the offending value is likewise rejected under NOCASE.
			await expectError(`insert into src values (2, 'ABC')`,
				`row derived into maintained table 'main.mt'`);
			expect(await readAll('select id, v from mt order by id'), 'fresh offending row rejected')
				.to.deep.equal([{ id: 1, v: 'xyz' }]);
		});
	});

	describe('reshape arm: type-sensitive CHECK', () => {
		// Sibling of the collation block above — the type-affinity analog, same fix.
		// `reshapeBackingInPlace` sequences:
		//   3. rebuildBacking → validateDeclaredConstraintsOverContents (validates + COMMITS)
		//   4. post-reconcile RETYPE (`set data type`, a `postReconcileOps` op — same batch
		//      the recollate above rides in)
		// A comparison resolves its **affinity** from the column's declared logical type, so
		// step 3 is handed `previewReshapedColumns` carrying step 4's type. A CHECK whose
		// truth flips under the affinity change is therefore evaluated under the FINAL type
		// and rejected before the commit, with the ordering (and commit-first parity) intact.
		// See docs/materialized-views.md § REFRESH MATERIALIZED VIEW.

		/** The live backing logical type of column `v` — TEXT before the reshape's
		 *  post-reconcile retype runs, INTEGER after. The flip is the observable proof the
		 *  refresh took the RESHAPE arm with a `retype` op (the fast path would leave the
		 *  type untouched). Paralleling `vCollation` in the recollate block above — and, as
		 *  there, the flip only follows a SUCCESSFUL refresh: a rejected one throws in step 3
		 *  so step 4 never runs and the catalog keeps TEXT. */
		function vType(name: string): string {
			const col = db.schemaManager.getMaintainedTable('main', name)!.columns.find(c => c.name === 'v');
			return col!.logicalType.name.toUpperCase();
		}

		it('a retype-during-reshape rejects a row that violates its CHECK under the FINAL type', async () => {
			await db.exec(`
				create table src (id integer primary key, v text);
				create table mt (id integer primary key, v text, check (v < '9'))
					maintained as select * from src;
				insert into src values (1, '10');
			`);
			// Clean under TEXT: lexicographic '10' < '9' is true ('1' < '9'), so create-fill admits it.
			expect(vType('mt'), 'v starts TEXT').to.equal('TEXT');

			// A source `set data type` is body-relevant (the `select *` output type shifts) ⇒ mt
			// goes stale and its row-time plan detaches, so the row is not re-validated until refresh.
			await db.exec(`alter table src alter column v set data type integer`);
			expect(isStale('mt'), 'set data type marked mt stale').to.equal(true);
			// The catalog still carries the OLD logical type until the reshape's post-reconcile retype.
			expect(vType('mt'), 'catalog v still TEXT pre-refresh').to.equal('TEXT');

			// Refresh takes the reshape arm. Step-3's scan resolves `v < '9'` under the
			// PREVIEWED INTEGER affinity — the one step 4 is about to land — where the
			// comparison is numeric 10 < 9 = false, so the row violates and the refresh is
			// REJECTED before commit.
			await expectError('refresh materialized view mt',
				`row derived into maintained table 'main.mt'`);
			// Pre-refresh contents survive, still in their pre-retype TEXT form, and mt stays stale.
			expect(await readAll('select id, v from mt order by id'),
				'the rejected refresh committed nothing; pre-refresh contents intact')
				.to.deep.equal([{ id: 1, v: '10' }]);
			expect(isStale('mt'), 'a rejected reshape refresh leaves mt stale').to.equal(true);
			// Step 4 never ran, so the catalog column keeps its OLD logical type.
			expect(vType('mt'), 'rejected refresh leaves v TEXT (post-reconcile ops never ran)')
				.to.equal('TEXT');

			// Correct the offending source row and refresh again: NOW the reshape completes,
			// and the type flip is the proof the retype arm was the one being exercised.
			await db.exec(`update src set v = 5 where id = 1`);
			await db.exec('refresh materialized view mt');
			expect(vType('mt'), 'v retyped to INTEGER ⇒ reshape arm + retype ran').to.equal('INTEGER');
			expect(await readAll(`select v, typeof(v) as t from mt`),
				'the retype landed the converted value')
				.to.deep.equal([{ v: 5, t: 'integer' }]);
			// Re-evaluated under the final INTEGER column, the committed row satisfies its CHECK.
			expect(await readAll(`select (v < '9') as lt from mt`),
				'the committed row is numeric-true under the final affinity')
				.to.deep.equal([{ lt: true }]);
			expect(isStale('mt'), 'the successful reshape clears stale').to.equal(false);
		});

		it('control: a type-INSENSITIVE CHECK over the same retype reshape still rejects a genuine violator', async () => {
			// Same reshape (retype v TEXT → INTEGER), but the CHECK is a value-domain `id > 0` —
			// its truth does NOT depend on any column's affinity. The step-3 scan enforces it
			// correctly, so a drifted -1 row IS rejected. This scopes the limitation strictly to
			// affinity-SENSITIVE comparisons (the validation path itself is sound), exactly
			// parallel to the collation-insensitive control above.
			await db.exec(`
				create table src (id integer primary key, v text);
				create table mt (id integer primary key, v text, check (id > 0))
					maintained as select * from src;
				insert into src values (1, '5');
			`);
			await db.exec(`alter table src alter column v set data type integer`); // retype reshape ⇒ stale
			expect(isStale('mt'), 'set data type marked mt stale').to.equal(true);
			await db.exec(`insert into src values (-1, '5')`); // drift: violates id > 0, unmaintained

			await expectError('refresh materialized view mt',
				`row derived into maintained table 'main.mt'`);
			// Pre-refresh contents survive (the scan threw before commit); mt stays stale.
			expect(await readAll('select id from mt order by id')).to.deep.equal([{ id: 1 }]);
			expect(isStale('mt'), 'a rejected reshape refresh leaves mt stale').to.equal(true);
		});

		it('after a successful retype reshape, row-time maintenance enforces the NEW type', async () => {
			// The affinity analog of the recollate block's row-time test: reached from a CLEAN
			// successful refresh, pinning that the row-time derived-row validator also resolves
			// under the post-reshape logical type.
			await db.exec(`
				create table src (id integer primary key, v text);
				create table mt (id integer primary key, v text, check (v < '9'))
					maintained as select * from src;
				insert into src values (1, '5');
			`);
			await db.exec(`alter table src alter column v set data type integer`);
			await db.exec('refresh materialized view mt');
			expect(vType('mt'), 'the reshape landed INTEGER').to.equal('INTEGER');
			expect(await readAll('select id, v from mt order by id'), 'conforming set committed')
				.to.deep.equal([{ id: 1, v: 5 }]);
			expect(isStale('mt'), 'successful refresh clears stale').to.equal(false);

			// A value-identical source touch produces NO derived-row delta, so the maintenance
			// manager suppresses the backing op entirely — nothing to validate, nothing changes.
			await db.exec(`update src set v = v where id = 1`);
			expect(await readAll('select id, v from mt order by id'), 'no-delta touch is a no-op')
				.to.deep.equal([{ id: 1, v: 5 }]);

			// A GENUINE delta deriving 11 — numeric-false against '9' under the NEW INTEGER
			// affinity — runs buildDerivedRowValidator under that type ⇒ REJECTED.
			await expectError(`update src set v = 11 where id = 1`,
				`row derived into maintained table 'main.mt'`);
			// …and the rejected write rolls back, leaving the committed row unchanged.
			expect(await readAll('select id, v from mt order by id'), 'rejected update rolls back')
				.to.deep.equal([{ id: 1, v: 5 }]);

			// A brand-new source row deriving an offending value is likewise rejected under INTEGER.
			await expectError(`insert into src values (2, 20)`,
				`row derived into maintained table 'main.mt'`);
			expect(await readAll('select id, v from mt order by id'), 'fresh offending row rejected')
				.to.deep.equal([{ id: 1, v: 5 }]);
		});
	});

	describe('duplicate-key reject parity', () => {
		// A backing whose physical PK keys a TEXT column under NOCASE while the source
		// keys it under BINARY: 'a' and 'A' are distinct source rows but collide on the
		// backing key. Seeded with only 'a' (so create-fill is a clean set); after the
		// table goes stale, the unmaintained 'A' drift makes the recomputed set collide,
		// which both refresh branches must reject with the IDENTICAL "must be a set"
		// diagnostic (`materializedViewNotASetError`).
		const DUP_MESSAGE = 'body produces duplicate rows';

		it('a constraint-less refresh rejects duplicate derived keys (replaceContents fast path)', async () => {
			await db.exec(`
				create table src (k text primary key, v text, g text not null default 'keep');
				create materialized view mv as select k collate nocase as k, v from src where g <> 'skip';
				insert into src (k, v) values ('a', 'x');
			`);
			await db.exec(`alter table src alter column g set collate nocase`); // stale
			await db.exec(`insert into src (k, v) values ('A', 'y')`); // collides under NOCASE

			await expectError('refresh materialized view mv', DUP_MESSAGE);
		});

		it('a constraint-bearing refresh rejects duplicate derived keys with the SAME diagnostic', async () => {
			await db.exec(`
				create table src (k text primary key, v text, g text not null default 'keep');
				create table mt (k text collate nocase primary key, v text, check (v <> 'zzz'))
					maintained as select k collate nocase as k, v from src where g <> 'skip';
				insert into src (k, v) values ('a', 'x');
			`);
			await db.exec(`alter table src alter column g set collate nocase`); // stale
			await db.exec(`insert into src (k, v) values ('A', 'y')`); // collides under NOCASE

			await expectError('refresh materialized view mt', DUP_MESSAGE);
		});
	});

	describe('CHECK and FK both declared (each validator runs independently)', () => {
		// The constraint-bearing branch runs both validators in sequence
		// (`validateDeclaredConstraintsOverContents` scans every applicable CHECK,
		// then every FK). Pin that a violation of EITHER is caught even when the
		// other passes — a CHECK-only or FK-only test could not distinguish a branch
		// that silently ran just one validator.
		beforeEach(async () => {
			await db.exec(`
				create table parent (pid integer primary key);
				create table src (id integer primary key, v text not null, ref integer null, g text not null default 'keep');
				create table mt (id integer primary key, v text not null,
					ref integer null references parent(pid), check (v <> 'poison'))
					maintained as select id, v, ref from src where g <> 'skip';
				insert into parent values (1);
				insert into src (id, v, ref) values (1, 'clean', 1);
			`);
			await db.exec(`alter table src alter column g set collate nocase`); // stale
		});

		it('a CHECK-clean but FK-orphan drift is caught by the FK validator', async () => {
			await db.exec(`insert into src (id, v, ref) values (2, 'clean', 99)`); // parent 99 absent
			await expectError('refresh materialized view mt', `references a missing 'main.parent'`);
			expect(await readAll('select id from mt order by id')).to.deep.equal([{ id: 1 }]);
			expect(isStale('mt')).to.equal(true);
		});

		it('an FK-clean but CHECK-violating drift is caught by the CHECK validator', async () => {
			await db.exec(`insert into src (id, v, ref) values (2, 'poison', 1)`); // ref ok, v bad
			await expectError('refresh materialized view mt', `row derived into maintained table 'main.mt'`);
			expect(await readAll('select id from mt order by id')).to.deep.equal([{ id: 1 }]);
			expect(isStale('mt')).to.equal(true);
		});

		it('a drift clean on both constraints passes and clears stale', async () => {
			await db.exec(`insert into parent values (2)`);
			await db.exec(`insert into src (id, v, ref) values (2, 'clean', 2)`);
			await db.exec('refresh materialized view mt');
			expect(await readAll('select id, v, ref from mt order by id'))
				.to.deep.equal([{ id: 1, v: 'clean', ref: 1 }, { id: 2, v: 'clean', ref: 2 }]);
			expect(isStale('mt')).to.equal(false);
		});
	});

	describe('commit-first parity (an enclosing rollback does not undo a refresh)', () => {
		// `replaceContents` swaps COMMITTED state, so a refresh is durable past an
		// enclosing `rollback` today. The constraint-bearing branch's explicit
		// `conn.commit()` must preserve that EXACT behavior rather than tying the swap
		// to the outer transaction — otherwise the two refresh branches would diverge
		// on transactional semantics. (Verified to match the constraint-less path.)
		it('a successful constraint-bearing refresh survives an enclosing rollback', async () => {
			await db.exec(`
				create table src (id integer primary key, v text not null, g text not null default 'keep');
				create table mt (id integer primary key, v text not null, check (v <> 'poison'))
					maintained as select id, v from src where g <> 'skip';
				insert into src (id, v) values (1, 'a');
			`);
			await db.exec(`alter table src alter column g set collate nocase`); // stale
			await db.exec(`insert into src (id, v) values (2, 'b')`);

			await db.exec('begin');
			await db.exec('refresh materialized view mt');
			await db.exec('rollback');

			// The backing swap committed independently of the outer transaction.
			expect(await readAll('select id, v from mt order by id'))
				.to.deep.equal([{ id: 1, v: 'a' }, { id: 2, v: 'b' }]);
			expect(isStale('mt'), 'a successful refresh clears stale even under an enclosing rollback')
				.to.equal(false);
		});
	});
});
