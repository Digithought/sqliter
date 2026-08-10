/**
 * `refresh materialized view` reconciles the maintained table's *shape*
 * (columns/types/PK/ordering) to the re-planned body when a source `alter` has
 * shifted it — **identity-preservingly**. An expressible delta (trailing column
 * adds, drops, positional renames, per-column attribute shifts, with the
 * surviving columns' relative order and the physical PK preserved) is applied
 * **in place** via the host module's `alterTable` plus a data reconcile, keeping
 * the same table incarnation: no `table_removed`/`table_added`, so a replicated
 * basis table's row metadata survives and a consumer MV is NOT incarnation-
 * cascaded (it goes stale via `table_modified` and recovers by its own refresh).
 *
 * An **inexpressible** delta — an interleaving column reorder (a `select *` body
 * whose new source column lands mid-output) or a physical-PK definition change —
 * is a **sited error**: the table and its rows are left untouched and the
 * derivation stays stale, recoverable by detach→alter→attach or drop+recreate.
 *
 * A refresh with no shape change keeps the data-only fast path (TableSchema
 * identity + warm caches preserved). The explicit-column count-shift error and
 * row-time maintenance against the reshaped table are covered too.
 *
 * See `mv-refresh-rebuilds-backing-schema` (the prior drop+recreate this replaces)
 * and `6.5-maintained-table-identity-preserving-reshape`.
 */

import { expect } from 'chai';
import { Database } from '../src/core/database.js';
import { StatusCode } from '../src/common/types.js';
import type { SchemaChangeEvent } from '../src/schema/change-events.js';

/** Each result row as a JSON object string (keys = column names, in column order;
 *  bigints normalized), sorted — so a wrong value-under-label surfaces as a
 *  key/value mismatch, not just a reordering. */
async function readObjectsSorted(db: Database, sql: string): Promise<string[]> {
	const rows: string[] = [];
	for await (const row of db.eval(sql)) {
		rows.push(JSON.stringify(row, (_k, v) => (typeof v === 'bigint' ? `${v}n` : v)));
	}
	return rows.sort();
}

/** Captures schema-change events naming `objectName` (case-insensitive) for the
 *  duration of `body`, returning their types in fire order. Used to assert the
 *  in-place reshape fires `table_modified` and NOT `table_removed`/`table_added`. */
async function captureEventsFor(db: Database, objectName: string, body: () => Promise<void>): Promise<string[]> {
	const seen: string[] = [];
	const target = objectName.toLowerCase();
	const off = db.schemaManager.getChangeNotifier().addListener((e: SchemaChangeEvent) => {
		if (e.objectName.toLowerCase() === target) seen.push(e.type);
	});
	try {
		await body();
	} finally {
		off();
	}
	return seen;
}

/** customers (parent, PK id) ⋈ orders (child, NOT-NULL FK customer_id → id). The
 *  `select *` join body collides the two `id` columns, so the second surfaces as
 *  `id:1`. Adding a column to `orders` makes it land *between* the orders columns
 *  and the customers columns — the canonical interleaving (inexpressible) reshape. */
const JOIN_SCHEMA = [
	'create table customers (id integer primary key, name text not null)',
	'create table orders (id integer primary key, customer_id integer not null '
		+ 'references customers(id), amt integer not null)',
	'create materialized view v as select * from orders o join customers c on o.customer_id = c.id',
	"insert into customers values (1,'alice')",
	'insert into orders values (10,1,100)',
];

describe('materialized view refresh — identity-preserving reshape', () => {
	describe('expressible in place', () => {
		it('a trailing source-column add reaches a select* body and reshapes in place (no incarnation events)', async () => {
			const db = new Database();
			try {
				await db.exec('create table t (id integer primary key, a integer)');
				await db.exec('insert into t values (1, 10)');
				await db.exec('create materialized view mv as select * from t');

				expect(await readObjectsSorted(db, 'select * from mv')).to.deep.equal(['{"id":1,"a":10}']);

				await db.exec('alter table t add column b integer default 5');
				const events = await captureEventsFor(db, 'mv', async () => {
					await db.exec('refresh materialized view mv');
				});

				// The reshape reconciles in place: only table_modified (cached-plan +
				// consumer invalidation), never a drop+recreate's table_removed/table_added.
				expect(events, 'in-place reshape fires table_modified, not drop+recreate events')
					.to.not.include.members(['table_removed', 'table_added']);
				expect(events).to.include('table_modified');

				// The appended column lands trailing and the reconcile fills it.
				expect(await readObjectsSorted(db, 'select * from mv')).to.deep.equal(['{"id":1,"a":10,"b":5}']);
				expect(db.schemaManager.getTable('main', 'mv')!.columns.map(c => c.name))
					.to.deep.equal(['id', 'a', 'b']);
			} finally {
				await db.close();
			}
		});

		it('an in-place reshape preserves the MV table tags (module schema is tag-less)', async () => {
			const db = new Database();
			try {
				await db.exec('create table t (id integer primary key, a integer)');
				await db.exec('insert into t values (1, 10)');
				await db.exec(`create materialized view mv as select * from t with tags ("team.owner" = 'sre')`);
				expect(db.schemaManager.getTable('main', 'mv')!.tags?.['team.owner'], 'tag set at create')
					.to.equal('sre');

				// A trailing source-column add drives an in-place reshape. The reshape
				// rebuilds the catalog record from the module's post-ALTER schema, which
				// carries no catalog tags — the rebuild must graft them back.
				await db.exec('alter table t add column b integer default 5');
				await db.exec('refresh materialized view mv');

				const reshaped = db.schemaManager.getTable('main', 'mv')!;
				expect(reshaped.columns.map(c => c.name), 'reshaped in place').to.deep.equal(['id', 'a', 'b']);
				expect(reshaped.tags?.['team.owner'], 'tags survive the reshape').to.equal('sre');
			} finally {
				await db.close();
			}
		});

		it('a NOT NULL trailing add reshapes in place (added nullable, tightened after the reconcile)', async () => {
			const db = new Database();
			try {
				await db.exec('create table t (id integer primary key, a integer)');
				await db.exec('insert into t values (1, 10)');
				await db.exec('create materialized view mv as select * from t');

				// A NOT NULL source add: the backing is non-empty, so the column is added
				// NULLABLE, the reconcile fills it, then NOT NULL is asserted post-reconcile.
				await db.exec('alter table t add column b integer not null default 0');
				await db.exec('refresh materialized view mv');

				const reshaped = db.schemaManager.getTable('main', 'mv')!;
				expect(reshaped.columns.map(c => c.name)).to.deep.equal(['id', 'a', 'b']);
				expect(reshaped.columns[2].notNull, 'added column is NOT NULL after the tighten').to.equal(true);
				expect(await readObjectsSorted(db, 'select * from mv')).to.deep.equal(['{"id":1,"a":10,"b":0}']);

				// The reshape converged: a second refresh sees no further shape change (fast path).
				const before = db.schemaManager.getTable('main', 'mv');
				await db.exec('refresh materialized view mv');
				expect(db.schemaManager.getTable('main', 'mv'), 'converged: no re-reshape loop').to.equal(before);
			} finally {
				await db.close();
			}
		});

		it('an output column dropped (source drop column) reshapes in place', async () => {
			const db = new Database();
			try {
				await db.exec('create table t (id integer primary key, a integer, b integer)');
				await db.exec('insert into t values (1, 10, 99)');
				await db.exec('create materialized view mv as select * from t');
				expect(await readObjectsSorted(db, 'select * from mv')).to.deep.equal(['{"id":1,"a":10,"b":99}']);

				await db.exec('alter table t drop column b');
				const events = await captureEventsFor(db, 'mv', async () => {
					await db.exec('refresh materialized view mv');
				});

				expect(events).to.not.include.members(['table_removed', 'table_added']);
				expect(await readObjectsSorted(db, 'select * from mv')).to.deep.equal(['{"id":1,"a":10}']);
				expect(db.schemaManager.getTable('main', 'mv')!.columns.map(c => c.name)).to.deep.equal(['id', 'a']);
			} finally {
				await db.close();
			}
		});

		it('a non-PK attribute shift (source set collate) reshapes in place', async () => {
			const db = new Database();
			try {
				await db.exec('create table t (id integer primary key, name text)');
				await db.exec("insert into t values (1, 'Bob')");
				await db.exec('create materialized view mv as select id, name from t');
				expect(db.schemaManager.getTable('main', 'mv')!.columns[1].collation).to.equal('BINARY');

				await db.exec('alter table t alter column name set collate nocase');
				const events = await captureEventsFor(db, 'mv', async () => {
					await db.exec('refresh materialized view mv');
				});

				expect(events).to.not.include.members(['table_removed', 'table_added']);
				// The non-key collation follows the source through the passthrough projection.
				expect(db.schemaManager.getTable('main', 'mv')!.columns[1].collation).to.equal('NOCASE');
				expect(await readObjectsSorted(db, 'select id, name from mv')).to.deep.equal(['{"id":1,"name":"Bob"}']);
			} finally {
				await db.close();
			}
		});

		it('a narrowing retype validates the reconciled body, not the discarded stale backing (no spurious MISMATCH; no col_2 divergence)', async () => {
			// Regression for `maintained-table-reshape-narrowing-attr-on-stale-data`.
			// The backing goes STALE on an unrelated source add, so a subsequent source
			// data-fix is NOT maintained in — the backing keeps the pre-narrowing value
			// while the re-derived body is clean. The narrowing retype must validate the
			// reconciled body (clean), not the discarded backing (dirty).
			const db = new Database();
			try {
				await db.exec('create table t (id integer primary key, v text)');
				await db.exec("insert into t values (1, 'abc')");
				await db.exec('create materialized view mv as select * from t');
				expect(await readObjectsSorted(db, 'select * from mv')).to.deep.equal(['{"id":1,"v":"abc"}']);

				// (1) An unrelated source add marks the MV stale → its row-time plan detaches,
				// so the data-fix below is NOT maintained into the backing (it keeps 'abc').
				await db.exec('alter table t add column w integer default 0');
				expect(db.schemaManager.getMaintainedTable('main', 'mv')!.derivation.stale).to.equal(true);

				// (2) Clean the source so v narrows; the write is unmaintained (MV stale).
				await db.exec("update t set v = '5' where id = 1");
				// (3) Narrow t.v to integer — the source is clean ('5'→5), so the source
				// alter succeeds; the stale backing still holds the un-convertible 'abc'.
				await db.exec('alter table t alter column v set data type integer');

				// The OLD code retyped v BEFORE the reconcile, validating the discarded
				// 'abc' → spurious MISMATCH, and on a partial throw left the catalog (2-col)
				// diverged from the module (3-col), surfacing a phantom `col_2`. The fix
				// defers the retype past the reconcile.
				const events = await captureEventsFor(db, 'mv', async () => {
					await db.exec('refresh materialized view mv');
				});
				expect(events).to.not.include.members(['table_removed', 'table_added']);
				expect(events).to.include('table_modified');

				const reshaped = db.schemaManager.getTable('main', 'mv')!;
				// Exactly [id, v, w] — no phantom `col_2` from a catalog/module divergence
				// (the divergence the OLD mid-loop throw left behind).
				expect(reshaped.columns.map(c => c.name)).to.deep.equal(['id', 'v', 'w']);
				// The deferred retype applied to the schema (v narrowed to INTEGER). NOTE:
				// `set data type` physically converts the stored value to the new logical type
				// (source `t.v` itself is likewise a genuine integer 5, not text '5', after its
				// own `set data type`). The point here is it reconciled the FRESH body, not the
				// discarded 'abc'.
				expect(reshaped.columns[1].logicalType.name.toUpperCase(), 'v retyped to INTEGER').to.equal('INTEGER');
				// read(MV) == evaluate(body): the maintained snapshot matches a fresh body
				// eval (so the value is the re-derived '5', never the stale 'abc').
				expect(await readObjectsSorted(db, 'select * from mv'))
					.to.deep.equal(await readObjectsSorted(db, 'select * from t'));

				// Convergence: with the snapshot now coherent, a second refresh (no further
				// source change) takes the data-only fast path — same TableSchema identity.
				const before = db.schemaManager.getTable('main', 'mv');
				await db.exec('refresh materialized view mv');
				expect(db.schemaManager.getTable('main', 'mv'), 'converged: no re-reshape loop').to.equal(before);
			} finally {
				await db.close();
			}
		});

		it('row-time maintenance after an in-place reshape maintains the reshaped backing', async () => {
			const db = new Database();
			try {
				await db.exec('create table t (id integer primary key, a integer)');
				await db.exec('insert into t values (1, 10)');
				await db.exec('create materialized view mv as select * from t');

				await db.exec('alter table t add column b integer default 5');
				await db.exec('refresh materialized view mv');

				// A source insert AFTER the reshape must maintain the reshaped 3-col backing,
				// including the new `b` column (maintenance re-registered against the new shape).
				await db.exec('insert into t values (2, 20, 7)');

				expect(await readObjectsSorted(db, 'select * from mv'))
					.to.deep.equal(['{"id":1,"a":10,"b":5}', '{"id":2,"a":20,"b":7}']);
				// read(MV) == evaluate(body): the maintained table matches a fresh body eval.
				expect(await readObjectsSorted(db, 'select * from mv'))
					.to.deep.equal(await readObjectsSorted(db, 'select * from t'));
			} finally {
				await db.close();
			}
		});

		it('a source DROP NOT NULL on an ordering-seeded backing PK column refreshes without dropping the backing PK NOT NULL', async () => {
			// Regression for `mv-reshape-loosens-not-null-on-ordering-seeded-backing-pk`.
			// `order by x` seeds x into the physical PK ([x, id]); x starts NOT NULL (source
			// x is NOT NULL). A source DROP NOT NULL loosens the DERIVED x to nullable, but a
			// physical-PK column stays NOT NULL in the backing — the old code emitted a
			// `loosenNotNull` op, which the memory manager refuses on a PK column
			// ("Cannot DROP NOT NULL on PRIMARY KEY column 'x'"). The fix masks that PK-column
			// loosening so refresh takes the data-only rebuild path and keeps x NOT NULL.
			const db = new Database();
			try {
				await db.exec('create table par (id integer primary key, x integer not null)');
				await db.exec('insert into par values (1, 5)');
				await db.exec('create materialized view par_ix as select id, x from par order by x');

				// Physical PK seeded from `order by x`: [x (index 1), id (index 0)], x NOT NULL.
				const pkBefore = db.schemaManager.getTable('main', 'par_ix')!;
				expect(pkBefore.primaryKeyDefinition.map(d => d.index)).to.deep.equal([1, 0]);
				expect(pkBefore.columns[1].notNull, 'backing x starts NOT NULL').to.equal(true);

				// Source x → nullable. The backing's x is a physical-PK column, so the memory
				// manager could not have dropped its NOT NULL (the alter would have thrown);
				// the backing keeps x NOT NULL while the RE-DERIVED body shape now reports x
				// nullable — the exact skew that makes the next refresh want to loosen a PK col.
				await db.exec('alter table par alter column x drop not null');
				expect(db.schemaManager.getTable('main', 'par_ix')!.columns[1].notNull,
					'backing x still NOT NULL after the source drop-not-null').to.equal(true);

				// A further source insert; refresh must end with both rows either way.
				await db.exec('insert into par (id, x) values (2, 8)');

				// The OLD code threw "Cannot DROP NOT NULL on PRIMARY KEY column 'x'" here.
				await db.exec('refresh materialized view par_ix');

				const after = db.schemaManager.getTable('main', 'par_ix')!;
				// Backing keeps x NOT NULL and the seeded [x, id] PK (a PK column cannot hold NULL).
				expect(after.columns[1].notNull, 'backing x stays NOT NULL (physical PK)').to.equal(true);
				expect(after.primaryKeyDefinition.map(d => d.index)).to.deep.equal([1, 0]);
				// The re-derived body (both rows) is materialized.
				expect(await readObjectsSorted(db, 'select id, x from par_ix'))
					.to.deep.equal(['{"id":1,"x":5}', '{"id":2,"x":8}']);

				// Row-time maintenance re-attached against the refreshed backing: a post-refresh
				// insert is still maintained in.
				await db.exec('insert into par (id, x) values (3, 12)');
				expect(await readObjectsSorted(db, 'select id, x from par_ix'))
					.to.deep.equal(['{"id":1,"x":5}', '{"id":2,"x":8}', '{"id":3,"x":12}']);
			} finally {
				await db.close();
			}
		});

		it('a PK-column DROP NOT NULL coexisting with a genuine reshape skips the loosen op (classifyBackingReshape guard)', async () => {
			// Exercises the SECOND fix site (classifyBackingReshape.recordAttrShift): reshape
			// is entered for a genuine shape change (a trailing column appears in the select*
			// output) while, in the same refresh, the ordering-seeded PK column x also loosens.
			// The guard must skip the doomed `loosenNotNull` on x while still applying the real
			// reshape (add b) — the loosening-only fast-path mask (site #1) does NOT fire here.
			const db = new Database();
			try {
				await db.exec('create table par (id integer primary key, x integer not null)');
				await db.exec('insert into par values (1, 5)');
				await db.exec('create materialized view par_ix as select * from par order by x');

				const before = db.schemaManager.getTable('main', 'par_ix')!;
				expect(before.columns.map(c => c.name)).to.deep.equal(['id', 'x']);
				expect(before.primaryKeyDefinition.map(d => d.index)).to.deep.equal([1, 0]);

				// Two source alters before the refresh: a genuine reshape (trailing add reaches
				// the select* body) AND a DROP NOT NULL on the seeded-PK column x.
				await db.exec('alter table par add column b integer default 0');
				await db.exec('alter table par alter column x drop not null');
				await db.exec('insert into par (id, x, b) values (2, 8, 7)');

				// OLD code: reshape emitted `loosenNotNull` on x → "Cannot DROP NOT NULL on
				// PRIMARY KEY column 'x'". The guard skips it, so the reshape (add b) lands.
				await db.exec('refresh materialized view par_ix');

				const after = db.schemaManager.getTable('main', 'par_ix')!;
				expect(after.columns.map(c => c.name)).to.deep.equal(['id', 'x', 'b']);
				expect(after.columns[1].notNull, 'backing x stays NOT NULL (physical PK)').to.equal(true);
				expect(after.primaryKeyDefinition.map(d => d.index)).to.deep.equal([1, 0]);
				expect(await readObjectsSorted(db, 'select id, x, b from par_ix'))
					.to.deep.equal(['{"id":1,"x":5,"b":0}', '{"id":2,"x":8,"b":7}']);
			} finally {
				await db.close();
			}
		});
	});

	describe('inexpressible → sited error', () => {
		it('an interleaving select* reorder errors at refresh; the table and rows are untouched', async () => {
			const db = new Database();
			try {
				for (const stmt of JOIN_SCHEMA) await db.exec(stmt);

				const before = ['{"id":10,"customer_id":1,"amt":100,"id:1":1,"name":"alice"}'];
				expect(await readObjectsSorted(db, 'select * from v')).to.deep.equal(before);

				// Adding `extra` to orders interleaves it BEFORE the customers columns — an
				// append-only reshape cannot place it, so refresh errors.
				await db.exec("alter table orders add column extra text default 'x'");

				let err: Error | undefined;
				const events = await captureEventsFor(db, 'v', async () => {
					try { await db.exec('refresh materialized view v'); } catch (e) { err = e as Error; }
				});
				expect(err, 'refresh errors on the interleaving reshape').to.not.be.undefined;
				expect(err!.message).to.match(/changed incompatibly|interleaving|lands mid-table/);

				// The table is untouched: no reshape event, still 5 columns, MV still stale,
				// and the stored snapshot still reads correctly.
				expect(events).to.not.include.members(['table_removed', 'table_added', 'table_modified']);
				expect(db.schemaManager.getTable('main', 'v')!.columns.length, 'shape untouched').to.equal(5);
				expect(db.schemaManager.getMaintainedTable('main', 'v')!.derivation.stale).to.equal(true);
				expect(await readObjectsSorted(db, 'select * from v')).to.deep.equal(before);
			} finally {
				await db.close();
			}
		});

		it('a physical-PK collation change errors at refresh (re-keying the row identity is not in-place)', async () => {
			const db = new Database();
			try {
				await db.exec('create table t (name text primary key, v integer)');
				await db.exec("insert into t values ('bob', 1)");
				await db.exec('create materialized view mv as select name, v from t');
				expect(db.schemaManager.getTable('main', 'mv')!.primaryKeyDefinition.length).to.equal(1);

				// Collating the source PK column re-keys the MV's *physical row identity* —
				// the one reshape we refuse to apply silently.
				await db.exec('alter table t alter column name set collate nocase');

				let err: Error | undefined;
				try { await db.exec('refresh materialized view mv'); } catch (e) { err = e as Error; }
				expect(err, 'refresh errors on the PK-definition change').to.not.be.undefined;
				expect(err!.message).to.match(/changed incompatibly|primary-key/);
				expect(db.schemaManager.getMaintainedTable('main', 'mv')!.derivation.stale).to.equal(true);
			} finally {
				await db.close();
			}
		});

		it('a physical-PK column type change errors at refresh (re-keying row identity in place is refused)', async () => {
			const db = new Database();
			try {
				// `order by v` seeds the backing's physical PK with the NON-PK source column
				// `v` (text), leading; the logical key `k` is appended as a tiebreaker. So the
				// physical PK is [v(text), k(integer)] — a key over a column whose source type
				// IS retypeable (`alter column <non-pk> set data type` is permitted; only a
				// *source PK* column's retype is blocked). This makes the PK-column-type-change
				// reshape genuinely reachable as black-box SQL.
				await db.exec('create table t (k integer primary key, v text)');
				// Sort-order-diverging values: as text '10' < '9'; as integer 10 > 9. A
				// regression that *applied* the reshape (re-keying under the stale text
				// comparator) would visibly mis-order the rows.
				await db.exec("insert into t values (1, '10'), (2, '9')");
				await db.exec('create materialized view mv as select v, k from t order by v');

				// Precondition (empirical): the physical PK leads with `v`, and `v` is text.
				// If the optimizer ever stops carrying the body `order by` into the backing
				// shape, this assertion catches it — the scenario would no longer be reachable.
				const mvBefore = db.schemaManager.getTable('main', 'mv')!;
				const pkLead = mvBefore.columns[mvBefore.primaryKeyDefinition[0].index];
				expect(pkLead.name, 'physical PK leads with the order-by column v').to.equal('v');
				expect(pkLead.logicalType.name.toUpperCase(), 'PK lead column v is text').to.equal('TEXT');
				expect(mvBefore.primaryKeyDefinition.length, 'multi-component PK: [v, k]').to.equal(2);

				// Retyping the NON-PK source column `v` text→integer is permitted at the source
				// and re-derives a body whose PK column `v` is integer — a PK-column type change
				// against the live backing's text-keyed identity.
				await db.exec('alter table t alter column v set data type integer');
				expect(db.schemaManager.getMaintainedTable('main', 'mv')!.derivation.stale).to.equal(true);

				let err: Error | undefined;
				const events = await captureEventsFor(db, 'mv', async () => {
					try { await db.exec('refresh materialized view mv'); } catch (e) { err = e as Error; }
				});
				expect(err, 'refresh errors on the PK-column type change').to.not.be.undefined;
				expect(err!.message).to.match(/changed incompatibly|primary-key/);
				// The reason must name the seed column `v` (PK component 0), not the tiebreaker `k`.
				expect(err!.message).to.match(/'v'|column 0/);

				// The table is left coherent: no incarnation/modify events, column count
				// unchanged, derivation still stale, and the stored snapshot still reads under
				// the original text key (un-reshaped, so the text sort order is preserved).
				expect(events).to.not.include.members(['table_removed', 'table_added', 'table_modified']);
				expect(db.schemaManager.getTable('main', 'mv')!.columns.length, 'shape untouched').to.equal(2);
				expect(db.schemaManager.getMaintainedTable('main', 'mv')!.derivation.stale).to.equal(true);
				expect(await readObjectsSorted(db, 'select * from mv'))
					.to.deep.equal(['{"v":"10","k":1}', '{"v":"9","k":2}']);
			} finally {
				await db.close();
			}
		});

		it('an explicit-column MV whose body output count shifts errors at refresh (declared interface)', async () => {
			const db = new Database();
			try {
				await db.exec('create table t (x integer primary key, y text)');
				await db.exec("insert into t values (1,'a')");
				await db.exec('create materialized view mv(a, b) as select * from t'); // 2 declared, body 2

				await db.exec('alter table t add column z integer null'); // body now 3 → marks mv stale
				expect(db.schemaManager.getMaintainedTable('main', 'mv')!.derivation.stale).to.equal(true);

				let err: Error | undefined;
				try { await db.exec('refresh materialized view mv'); } catch (e) { err = e as Error; }
				expect(err, 'refresh errors on the explicit-column count shift').to.not.be.undefined;
				expect(err!.message).to.match(/declared with 2 columns but its body now produces 3/);

				// The MV stays stale (coherent) rather than silently widening the declared list.
				expect(db.schemaManager.getMaintainedTable('main', 'mv')!.derivation.stale).to.equal(true);
			} finally {
				await db.close();
			}
		});
	});

	describe('NOT-NULL ordering-seeded PK guard (refresh must not store a NULL there)', () => {
		// `order by <col>` seeds <col> into the backing's PHYSICAL primary key
		// (computeBackingPrimaryKey), which pins that column NOT NULL even after its
		// source column drops NOT NULL — a physical-PK column cannot lose NOT NULL, and
		// the refresh reshape masks the doomed loosen. Once the source column becomes
		// nullable and produces a NULL row, storing it would leave the backing schema
		// declaring NOT NULL while holding a NULL. BOTH maintenance vectors now guard
		// against that with the same `nullInNotNullSeededPkError`:
		//  - the REFRESH rebuild (`rebuildBacking` → assertNoNullInNotNullSeededPk),
		//    covered by the reshape-arm test below;
		//  - the ROW-TIME write-through (the PRIMARY vector — a plain projection MV is NOT
		//    marked stale by `alter … drop not null`, so its row-time plan stays attached and
		//    a NULL source insert reaches the backing FIRST, before any refresh). That vector
		//    is guarded by `assertNoNullInNotNullSeededPkRowTime`
		//    (database-materialized-views-apply.ts) and covered by the `row-time maintenance`
		//    describe below (fix/bug-mv-rowtime-null-into-notnull-seeded-pk).
		//
		// Because row-time now rejects the NULL at the source INSERT, a non-stale MV's
		// backing can no longer reach a NULL-in-seeded-PK state via DML — the refresh
		// fast-path guard is retained as defense-in-depth (catalog import / future bypass)
		// but is unreachable through the insert-then-refresh recipe; the reshape-arm test
		// exercises the shared rebuild guard instead.

		it('the primary (row-time) vector rejects the NULL at the source INSERT, and a subsequent refresh over the clean backing succeeds', async () => {
			const db = new Database();
			try {
				await db.exec('create table par (id integer primary key, x integer not null)');
				await db.exec('insert into par values (1, 5)');
				await db.exec('create materialized view par_ix as select id, x from par order by x');
				// Physical PK seeded from `order by x`: [x (index 1), id (index 0)], x NOT NULL.
				expect(db.schemaManager.getTable('main', 'par_ix')!.primaryKeyDefinition.map(d => d.index))
					.to.deep.equal([1, 0]);

				await db.exec('alter table par alter column x drop not null');
				// par_ix is NOT stale after the drop-not-null (the projection body recompiles
				// live), so this NULL insert would be maintained straight into the backing's
				// NOT-NULL PK column — the row-time guard rejects it here instead.
				let err: Error | undefined;
				try { await db.exec('insert into par (id, x) values (2, null)'); } catch (e) { err = e as Error; }
				expect(err, 'the maintained NULL insert must throw').to.not.be.undefined;
				expect((err as { code?: number }).code, 'CONSTRAINT status').to.equal(StatusCode.CONSTRAINT);
				expect(err!.message).to.match(/would store NULL in column 'x'/);
				// The backing still declares x NOT NULL and holds only the pre-insert row.
				expect(db.schemaManager.getTable('main', 'par_ix')!.columns[1].notNull).to.equal(true);
				expect(await readObjectsSorted(db, 'select id, x from par_ix')).to.deep.equal(['{"id":1,"x":5}']);

				// The backing never reached a NULL state, so a refresh does NOT falsely reject:
				// the fast-path guard has nothing to catch.
				await db.exec('refresh materialized view par_ix');
				expect(await readObjectsSorted(db, 'select id, x from par_ix')).to.deep.equal(['{"id":1,"x":5}']);
			} finally {
				await db.close();
			}
		});

		it('a stale MV whose reshape-arm refresh would store a NULL in the seeded PK column throws, leaving the pre-refresh contents intact', async () => {
			const db = new Database();
			try {
				await db.exec('create table par (id integer primary key, x integer not null)');
				await db.exec('insert into par values (1, 5)');
				await db.exec('create materialized view par_ix as select * from par order by x');

				// A trailing source add shifts the `select *` output shape → marks par_ix
				// STALE (its row-time plan detaches). The refresh will take the RESHAPE arm.
				await db.exec('alter table par add column b integer default 0');
				expect(db.schemaManager.getMaintainedTable('main', 'par_ix')!.derivation.stale).to.equal(true);

				// Source x → nullable, then a NULL row. par_ix is stale, so this is NOT
				// maintained into the backing — the backing cleanly still holds only {1,5}.
				await db.exec('alter table par alter column x drop not null');
				await db.exec('insert into par (id, x, b) values (2, null, 7)');
				expect(await readObjectsSorted(db, 'select id, x from par_ix')).to.deep.equal(['{"id":1,"x":5}']);

				let err: Error | undefined;
				const events = await captureEventsFor(db, 'par_ix', async () => {
					try { await db.exec('refresh materialized view par_ix'); } catch (e) { err = e as Error; }
				});
				expect(err, 'reshape-arm refresh must throw on the NULL seeded PK value').to.not.be.undefined;
				expect((err as { code?: number }).code, 'CONSTRAINT status').to.equal(StatusCode.CONSTRAINT);
				expect(err!.message).to.match(/would store NULL in column 'x'/);
				// The guard fired before any content swap: the NULL row never materialized,
				// the pre-refresh contents survive, and the MV stays stale (recoverable).
				expect(await readObjectsSorted(db, 'select id, x from par_ix')).to.deep.equal(['{"id":1,"x":5}']);
				expect(db.schemaManager.getMaintainedTable('main', 'par_ix')!.derivation.stale).to.equal(true);
				expect(events).to.not.include.members(['table_removed', 'table_added']);
			} finally {
				await db.close();
			}
		});

		it('the permitted nullable-declared seeded PK column is NOT rejected (create + refresh over a NULL-holding nullable source succeed)', async () => {
			// The guard is tight: it fires ONLY for a column declared NOT NULL. A view whose
			// ordering column is nullable at the source seeds a NULLABLE PK column that
			// self-consistently stores NULL — the permitted case. Neither create nor refresh
			// may reject it.
			const db = new Database();
			try {
				await db.exec('create table par (id integer primary key, x integer null)');
				await db.exec('insert into par values (1, 5), (2, null)');
				await db.exec('create materialized view par_ix as select id, x from par order by x');

				const backing = db.schemaManager.getTable('main', 'par_ix')!;
				expect(backing.primaryKeyDefinition.map(d => d.index), 'x seeded into the PK').to.deep.equal([1, 0]);
				expect(backing.columns[1].notNull, 'backing x is declared nullable (permitted)').to.equal(false);
				expect(await readObjectsSorted(db, 'select id, x from par_ix'))
					.to.deep.equal(['{"id":1,"x":5}', '{"id":2,"x":null}']);

				// A refresh over the NULL-holding nullable source must succeed unchanged.
				await db.exec('refresh materialized view par_ix');
				expect(await readObjectsSorted(db, 'select id, x from par_ix'))
					.to.deep.equal(['{"id":1,"x":5}', '{"id":2,"x":null}']);
			} finally {
				await db.close();
			}
		});

		// Row-time maintenance is the PRIMARY vector: `alter … drop not null` recompiles the
		// projection body live (does NOT mark the MV stale), so the very next source INSERT is
		// write-through-maintained into the backing — BEFORE any refresh. These pin that the
		// row-time path now rejects the NULL loudly (matching the refresh guard) instead of
		// silently storing it. Tracked in fix/bug-mv-rowtime-null-into-notnull-seeded-pk.
		describe('row-time maintenance (the primary vector — fires at the source INSERT)', () => {
			it('a maintained NULL insert into a NOT-NULL ordering-seeded PK column throws CONSTRAINT and leaves the backing intact', async () => {
				const db = new Database();
				try {
					await db.exec('create table par (id integer primary key, x integer not null)');
					await db.exec('insert into par values (1, 5)');
					await db.exec('create materialized view par_ix as select id, x from par order by x');
					// Physical PK seeded from `order by x`: [x (index 1), id (index 0)], x NOT NULL.
					expect(db.schemaManager.getTable('main', 'par_ix')!.primaryKeyDefinition.map(d => d.index))
						.to.deep.equal([1, 0]);

					// Source x → nullable; par_ix is NOT marked stale (the body recompiles live),
					// so its row-time plan stays attached and the next NULL insert would maintain
					// {2, NULL} straight into the backing's NOT-NULL PK column.
					await db.exec('alter table par alter column x drop not null');

					let err: Error | undefined;
					try {
						await db.exec('insert into par (id, x) values (2, null)');
					} catch (e) { err = e as Error; }
					expect(err, 'the maintained NULL insert must throw').to.not.be.undefined;
					expect((err as { code?: number }).code, 'CONSTRAINT status').to.equal(StatusCode.CONSTRAINT);
					expect(err!.message, 'names column x and the MV').to.match(/would store NULL in column 'x'/);
					expect(err!.message).to.match(/par_ix/);
					// Nothing committed: par_ix still holds only {1,5}, and the source insert rolled back.
					expect(await readObjectsSorted(db, 'select id, x from par_ix')).to.deep.equal(['{"id":1,"x":5}']);
					expect(await readObjectsSorted(db, 'select id, x from par')).to.deep.equal(['{"id":1,"x":5}']);
				} finally {
					await db.close();
				}
			});

			it('after DROP NOT NULL, a non-NULL maintained insert still succeeds (the guard fires only on an actual NULL)', async () => {
				const db = new Database();
				try {
					await db.exec('create table par (id integer primary key, x integer not null)');
					await db.exec('insert into par values (1, 5)');
					await db.exec('create materialized view par_ix as select id, x from par order by x');
					await db.exec('alter table par alter column x drop not null');

					// A non-NULL value in the loosened column maintains through cleanly.
					await db.exec('insert into par (id, x) values (2, 7)');
					expect(await readObjectsSorted(db, 'select id, x from par_ix'))
						.to.deep.equal(['{"id":1,"x":5}', '{"id":2,"x":7}']);
				} finally {
					await db.close();
				}
			});

			it('a maintained UPDATE that sets the seeded PK column to NULL throws CONSTRAINT and leaves the backing intact', async () => {
				const db = new Database();
				try {
					await db.exec('create table par (id integer primary key, x integer not null)');
					await db.exec('insert into par values (1, 5)');
					await db.exec('create materialized view par_ix as select id, x from par order by x');
					await db.exec('alter table par alter column x drop not null');

					// The UPDATE re-keys the backing row (x is the leading PK member), so the guard
					// sees an insert-image with x = NULL — the same rejection as the INSERT vector.
					let err: Error | undefined;
					try {
						await db.exec('update par set x = null where id = 1');
					} catch (e) { err = e as Error; }
					expect(err, 'the maintained NULL update must throw').to.not.be.undefined;
					expect((err as { code?: number }).code, 'CONSTRAINT status').to.equal(StatusCode.CONSTRAINT);
					expect(err!.message).to.match(/would store NULL in column 'x'/);
					// Nothing committed: both backing and source still hold {1,5}.
					expect(await readObjectsSorted(db, 'select id, x from par_ix')).to.deep.equal(['{"id":1,"x":5}']);
					expect(await readObjectsSorted(db, 'select id, x from par')).to.deep.equal(['{"id":1,"x":5}']);
				} finally {
					await db.close();
				}
			});

			it('a full-rebuild-floor MV guards the same skew at the deferred-flush boundary', async () => {
				const db = new Database();
				try {
					await db.exec('create table par (id integer primary key, x integer not null)');
					await db.exec('insert into par values (1, 5)');
					// A `union` body falls to the full-rebuild floor (no bounded-delta shape), so its
					// row-time maintenance is DEFERRED and drained by `flushDeferredRebuilds` — a
					// distinct guard call site from the per-row `maintainRowTime` arm the tests above
					// exercise. `order by x` still seeds x into the physical PK.
					await db.exec('create materialized view par_ix as select id, x from par union select id, x from par order by x');
					expect(db.schemaManager.getTable('main', 'par_ix')!.primaryKeyDefinition.map(d => d.index))
						.to.deep.equal([1, 0]);
					await db.exec('alter table par alter column x drop not null');

					let err: Error | undefined;
					try {
						await db.exec('insert into par (id, x) values (2, null)');
					} catch (e) { err = e as Error; }
					expect(err, 'the deferred-flush rebuild must throw on the NULL').to.not.be.undefined;
					expect((err as { code?: number }).code, 'CONSTRAINT status').to.equal(StatusCode.CONSTRAINT);
					expect(err!.message).to.match(/would store NULL in column 'x'/);
					// Nothing committed on either side.
					expect(await readObjectsSorted(db, 'select id, x from par_ix')).to.deep.equal(['{"id":1,"x":5}']);
					expect(await readObjectsSorted(db, 'select id, x from par')).to.deep.equal(['{"id":1,"x":5}']);
				} finally {
					await db.close();
				}
			});

			it('a nullable-at-create ordering-seeded PK column keeps accepting NULL maintained inserts (not over-rejected)', async () => {
				const db = new Database();
				try {
					// x is nullable at create time (explicit `null` — a bare `integer` is NOT NULL
					// in Quereus) → the seeded PK column is declared nullable (notNull !== true),
					// so it is never guarded: it self-consistently stores NULL.
					await db.exec('create table par (id integer primary key, x integer null)');
					await db.exec('insert into par values (1, 5)');
					await db.exec('create materialized view par_ix as select id, x from par order by x');
					expect(db.schemaManager.getTable('main', 'par_ix')!.columns[1].notNull, 'backing x nullable')
						.to.equal(false);

					// A NULL maintained insert must succeed — the guard's notNull===true gate excludes it.
					await db.exec('insert into par (id, x) values (2, null)');
					expect(await readObjectsSorted(db, 'select id, x from par_ix'))
						.to.deep.equal(['{"id":1,"x":5}', '{"id":2,"x":null}']);
				} finally {
					await db.close();
				}
			});
		});
	});

	it('fast path: a refresh with no source change preserves the MV TableSchema identity', async () => {
		const db = new Database();
		try {
			await db.exec('create table t (x integer primary key, y text)');
			await db.exec("insert into t values (1,'a'),(2,'b')");
			await db.exec('create materialized view mv as select x, y from t');

			const before = db.schemaManager.getTable('main', 'mv');
			await db.exec('refresh materialized view mv');
			const after = db.schemaManager.getTable('main', 'mv');

			// Same object ⇒ the conditional took the data-only fast path (no reshape),
			// so cached prepared plans and the MV body-root cache stay warm.
			expect(after, 'fast-path keeps the same TableSchema object').to.equal(before);
			expect(await readObjectsSorted(db, 'select * from mv')).to.deep.equal([
				'{"x":1,"y":"a"}', '{"x":2,"y":"b"}',
			]);
		} finally {
			await db.close();
		}
	});

	it('a producer in-place reshape cascades staleness to a consumer via table_modified (no incarnation cascade)', async () => {
		// MV-over-MV: the producer `p` reshapes IN PLACE (trailing add), firing
		// table_modified — NOT table_removed/table_added — on `p`. The manager's
		// source-tracking listener (the consumer's sourceTables include `main.p`)
		// marks the consumer stale and detaches its row-time plan. Refreshing the
		// consumer re-derives its shape over the now-3-col producer and reshapes in
		// place too. The consumer recovers by refresh exactly as docs describe for
		// any source alter — it is not torn down and rebuilt.
		const db = new Database();
		try {
			await db.exec('create table t (id integer primary key, a integer not null)');
			await db.exec('insert into t values (1,10)');
			await db.exec('create materialized view p as select * from t');
			await db.exec('create materialized view c as select * from p');

			expect(await readObjectsSorted(db, 'select * from c')).to.deep.equal(['{"id":1,"a":10}']);

			await db.exec('alter table t add column b integer default 5');
			const events = await captureEventsFor(db, 'p', async () => {
				await db.exec('refresh materialized view p'); // reshapes the table `p` in place
			});

			// In-place: only table_modified on `p`, never a drop+recreate.
			expect(events).to.not.include.members(['table_removed', 'table_added']);
			expect(events).to.include('table_modified');
			// The producer's table_modified cascaded staleness to the consumer.
			expect(db.schemaManager.getMaintainedTable('main', 'c')!.derivation.stale, 'consumer marked stale by cascade').to.equal(true);

			// Refreshing the consumer realigns it to the reshaped producer (gains `b`).
			await db.exec('refresh materialized view c');
			expect(db.schemaManager.getMaintainedTable('main', 'c')!.derivation.stale).to.not.equal(true);
			expect(await readObjectsSorted(db, 'select * from c')).to.deep.equal(['{"id":1,"a":10,"b":5}']);
		} finally {
			await db.close();
		}
	});
});
