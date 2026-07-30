/**
 * Merged reads under a key-set semi join (`where col in (select …)`,
 * feat-key-set-semi-join).
 *
 * The engine rewrites the target's `FilterInfo` at runtime into an ordinary
 * single-column `plan=5` multi-seek — one EQ constraint per seek key, on one column,
 * indistinguishable from what a literal `in (1,2,3)` produces. The isolation layer
 * interprets that structurally, so two of its behaviours are on the hook:
 *
 * - `IsolatedTable.buildConstraintMatcher` must decompose the K same-column EQ
 *   constraints back into an IN SET. If it ANDed them instead, no staged row could
 *   ever match (the values are mutually exclusive) and every uncommitted row would
 *   silently vanish from the answer.
 * - The merge must pair each staged row with the stored row it shadows. The
 *   primary-key merge (`mergeStreams`) requires both streams in ascending key order;
 *   the secondary-index merge sorts the overlay itself and tolerates more.
 *
 * The rewrite SORTS its seek keys before stamping them, so the underlying stream
 * arrives in index-key order whatever order the key source emitted. The literal-list
 * form (`WHERE pk IN (3, 1, 2)`) used to hit the same ordering hazard a different way —
 * the memory backend visited a multi-seek's keys in seek-argument order instead of the
 * scanned index's own key order (fix/bug-isolation-multiseek-merge-order). Both forms
 * are now covered: the literal-list regressions live in the "literal IN-list" describe
 * block below.
 *
 * The underlying is a plain memory module here, instrumented so each test can prove
 * the read really was served as a multi-seek rather than passing vacuously on a
 * full scan.
 */

import { describe, it, beforeEach } from 'mocha';
import { expect } from 'chai';
import { Database, MemoryTableModule, asyncIterableToArray } from '@quereus/quereus';
import type { BaseModuleConfig, FilterInfo, Row, SqlValue, TableSchema } from '@quereus/quereus';
import { IsolationModule } from '../src/index.js';

/** Memory module that records the `idxStr` of every read its tables serve. */
class IdxStrCapturingMemoryModule extends MemoryTableModule {
	readonly idxStrs = new Map<string, string[]>();
	private readonly wrapped = new WeakSet<object>();

	private capture<T extends { tableName: string; query: (fi: FilterInfo) => AsyncIterable<Row> }>(table: T): T {
		if (this.wrapped.has(table)) return table;
		this.wrapped.add(table);
		const key = table.tableName.toLowerCase();
		const strs = this.idxStrs;
		const original = table.query.bind(table);
		table.query = (filterInfo: FilterInfo): AsyncIterable<Row> => {
			const list = strs.get(key) ?? [];
			list.push(filterInfo.idxStr ?? '');
			strs.set(key, list);
			return original(filterInfo);
		};
		return table;
	}

	override async create(db: Database, tableSchema: TableSchema) {
		return this.capture(await super.create(db, tableSchema));
	}

	override async connect(
		db: Database,
		pAux: unknown,
		moduleName: string,
		schemaName: string,
		tableName: string,
		options: BaseModuleConfig,
		tableSchema?: TableSchema,
	) {
		return this.capture(
			await super.connect(db, pAux, moduleName, schemaName, tableName, options as never, tableSchema));
	}

	reset(): void {
		this.idxStrs.clear();
	}

	seen(tableName: string): string[] {
		return this.idxStrs.get(tableName.toLowerCase()) ?? [];
	}
}

function multiSeekRe(indexName: string): RegExp {
	return new RegExp(`^idx=${indexName}\\(0\\);plan=5;inCount=(\\d+)$`);
}

describe('key-set semi join through the isolation layer (feat-key-set-seek-store-isolation)', () => {
	let db: Database;
	let mem: IdxStrCapturingMemoryModule;

	beforeEach(() => {
		db = new Database();
		mem = new IdxStrCapturingMemoryModule();
		db.registerModule('isolated', new IsolationModule({ underlying: mem }));
	});

	/**
	 * Rows of `q`, sorted in JS by `pk`.
	 *
	 * Deliberately no `order by`: the target leaf's own walk order would be absorbed
	 * from an `order by pk`, which marks the leaf's emission order load-bearing and
	 * makes `rule-key-set-seek` decline — the tests would then pass vacuously on the
	 * hash semi join they are meant to replace.
	 */
	const rowsOf = async (q: string): Promise<Record<string, SqlValue>[]> =>
		(await asyncIterableToArray(db.eval(q)))
			.sort((a, b) => (a.pk as number) - (b.pk as number)) as Record<string, SqlValue>[];

	describe('secondary-index merge (mergedSecondaryIndexQuery)', () => {
		const KEY_SET_QUERY = `select pk, v, tag from t where v in (select k from ksrc)`;

		beforeEach(async () => {
			await db.exec(`create table t (pk integer primary key, v integer, tag text) using isolated`);
			await db.exec(`create index ix_v on t (v)`);
			await db.exec(`create table ksrc (id integer primary key, k integer) using isolated`);
			await db.exec(`insert into t values (1, 10, 'a'), (2, 20, 'b'), (3, 30, 'c'), (4, 40, 'd')`);
			await db.exec(`insert into ksrc values (1, 20), (2, 30), (3, 50)`);
		});

		/** Assert the underlying really served the read as a multi-seek on `ix_v`. */
		function expectSeeked(): void {
			expect(mem.seen('t')[0], 'the underlying served a multi-seek').to.match(multiSeekRe('ix_v'));
		}

		it('surfaces a staged insert whose key is in the set', async () => {
			await db.exec(`begin`);
			await db.exec(`insert into t values (5, 50, 'e')`);
			mem.reset();
			expect(await rowsOf(KEY_SET_QUERY)).to.deep.equal([
				{ pk: 2, v: 20, tag: 'b' },
				{ pk: 3, v: 30, tag: 'c' },
				{ pk: 5, v: 50, tag: 'e' },
			]);
			expectSeeked();
			await db.exec(`rollback`);
		});

		it('excludes staged rows that fall outside the seek window', async () => {
			// The overlay is FULL-scanned on a merged secondary read, so every staged row
			// reaches `buildConstraintMatcher`; only the reconstructed IN set keeps the
			// out-of-window one out. An AND-of-equalities reading would drop BOTH.
			await db.exec(`begin`);
			await db.exec(`insert into t values (6, 60, 'out'), (7, 20, 'in')`);
			mem.reset();
			expect(await rowsOf(KEY_SET_QUERY)).to.deep.equal([
				{ pk: 2, v: 20, tag: 'b' },
				{ pk: 3, v: 30, tag: 'c' },
				{ pk: 7, v: 20, tag: 'in' },
			]);
			expectSeeked();
			await db.exec(`rollback`);
		});

		it('shows a row moved INTO the set, and hides one moved OUT of it', async () => {
			await db.exec(`begin`);
			await db.exec(`update t set v = 50, tag = 'moved-in' where pk = 1`);
			await db.exec(`update t set v = 999 where pk = 2`);
			mem.reset();
			expect(await rowsOf(KEY_SET_QUERY)).to.deep.equal([
				{ pk: 1, v: 50, tag: 'moved-in' },
				{ pk: 3, v: 30, tag: 'c' },
			]);
			expectSeeked();
			await db.exec(`rollback`);
		});

		it('emits an in-place staged update exactly once, in its new form', async () => {
			// The shadowing case: committed row and staged row both fall inside the seek
			// window, so both streams carry it and a merge slip would emit it twice.
			await db.exec(`begin`);
			await db.exec(`update t set tag = 'rewritten' where pk = 3`);
			mem.reset();
			expect(await rowsOf(KEY_SET_QUERY)).to.deep.equal([
				{ pk: 2, v: 20, tag: 'b' },
				{ pk: 3, v: 30, tag: 'rewritten' },
			]);
			expectSeeked();
			await db.exec(`rollback`);
		});

		it('does not resurrect a staged delete of an in-set row', async () => {
			await db.exec(`begin`);
			await db.exec(`delete from t where pk = 2`);
			mem.reset();
			expect(await rowsOf(KEY_SET_QUERY)).to.deep.equal([
				{ pk: 3, v: 30, tag: 'c' },
			]);
			expectSeeked();
			await db.exec(`rollback`);
		});

		it('interleaves several staged rows across the seek windows, each exactly once', async () => {
			await db.exec(`begin`);
			await db.exec(`insert into ksrc values (4, 10), (5, 40)`);
			await db.exec(`insert into t values (8, 40, 'x'), (9, 10, 'y')`);
			await db.exec(`update t set tag = 'z' where pk = 4`);
			mem.reset();
			expect(await rowsOf(KEY_SET_QUERY)).to.deep.equal([
				{ pk: 1, v: 10, tag: 'a' },
				{ pk: 2, v: 20, tag: 'b' },
				{ pk: 3, v: 30, tag: 'c' },
				{ pk: 4, v: 40, tag: 'z' },
				{ pk: 8, v: 40, tag: 'x' },
				{ pk: 9, v: 10, tag: 'y' },
			]);
			expectSeeked();
			await db.exec(`rollback`);
		});
	});

	describe('DESC leading key column', () => {
		// The `seekDescending` arm of the same sort: for a DESC key column the seek keys
		// are sorted descending, because THAT is index-key order there. Both merge paths
		// derive their comparator from the index descriptor's key columns, so an ascending
		// sort would pit an ascending overlay against a descending underlying stream.

		it('merges staged rows against a DESC secondary index', async () => {
			await db.exec(`create table t (pk integer primary key, v integer, tag text) using isolated`);
			await db.exec(`create index ix_v on t (v desc)`);
			await db.exec(`create table ksrc (id integer primary key, k integer) using isolated`);
			await db.exec(`insert into t values (1, 10, 'a'), (2, 20, 'b'), (3, 30, 'c'), (4, 40, 'd')`);
			await db.exec(`insert into ksrc values (1, 20), (2, 30), (3, 50)`);
			await db.exec(`begin`);
			await db.exec(`insert into t values (5, 50, 'e')`);
			await db.exec(`update t set tag = 'rewritten' where pk = 3`);
			mem.reset();
			expect(await rowsOf(`select pk, v, tag from t where v in (select k from ksrc)`)).to.deep.equal([
				{ pk: 2, v: 20, tag: 'b' },
				{ pk: 3, v: 30, tag: 'rewritten' },
				{ pk: 5, v: 50, tag: 'e' },
			]);
			expect(mem.seen('t')[0], 'the DESC index was seeked').to.match(multiSeekRe('ix_v'));
			await db.exec(`rollback`);
		});

		it('merges staged rows against a DESC primary key', async () => {
			// The order-sensitive path AND the descending sort at once: `mergeStreams` walks
			// a `primary key (pk desc)` table in descending key order, so the stamped seek
			// keys must descend too.
			await db.exec(`create table t (pk integer, v text, primary key (pk desc)) using isolated`);
			await db.exec(`create table ksrc (id integer primary key, k integer) using isolated`);
			await db.exec(`insert into t values (1, 'one'), (2, 'two'), (3, 'three'), (4, 'four')`);
			await db.exec(`insert into ksrc values (1, 3), (2, 1), (3, 2)`);
			await db.exec(`begin`);
			await db.exec(`update t set v = 'new' where pk = 1`);
			mem.reset();
			expect(await rowsOf(`select pk, v from t where pk in (select k from ksrc)`),
				'no stale duplicate of pk 1').to.deep.equal([
				{ pk: 1, v: 'new' },
				{ pk: 2, v: 'two' },
				{ pk: 3, v: 'three' },
			]);
			expect(mem.seen('t')[0]).to.match(multiSeekRe('_primary_'));
			await db.exec(`rollback`);
		});
	});

	describe('primary-key merge (mergeStreams)', () => {
		// The memory backend DOES serve a runtime key set on the primary key as a
		// `_primary_` `plan=5` multi-seek, so the order-sensitive primary merge is
		// reachable through this feature (the persistent store is not — its primary-key
		// arm claims `=` only, see backlog/feat-store-pk-in-list-multiseek).
		//
		// `mergeStreams` requires both streams in ascending primary-key order. The
		// literal form of the same plan (`where pk in (3, 1, 2)`) used to visit windows
		// in list order and mis-pair the staged rows — fix/bug-isolation-multiseek-merge-order,
		// covered by the "literal IN-list" describe block below, which pins the fix
		// against exactly this out-of-order `ksrc` shape.
		//
		// The key-set path here is additionally immune on its own terms because
		// `emitKeySetSemiJoin` SORTS the seek keys under the index's leading-key
		// collation before stamping them. These tests exist to keep that sort
		// load-bearing: drop it and they fail the same way the (now-fixed) literal
		// list used to.
		//
		// NOTE: this package's mocha run resolves `@quereus/quereus` to its built `dist`,
		// not its `src`. Editing the engine and re-running only this file therefore tests
		// the PREVIOUS build — `yarn build` first, or the check above passes vacuously.
		const KEY_SET_QUERY = `select pk, v from t where pk in (select k from ksrc)`;

		beforeEach(async () => {
			await db.exec(`create table t (pk integer primary key, v text) using isolated`);
			await db.exec(`create table ksrc (id integer primary key, k integer) using isolated`);
			await db.exec(`insert into t values (1, 'one'), (2, 'two'), (3, 'three'), (4, 'four')`);
			// Scanned in ksrc's own pk order, so the keys arrive 3, 1, 2 — out of target-key
			// order, and only sorted if something sorts them.
			await db.exec(`insert into ksrc values (1, 3), (2, 1), (3, 2)`);
		});

		function expectPrimarySeeked(): void {
			expect(mem.seen('t')[0], 'the underlying served a primary-key multi-seek')
				.to.match(multiSeekRe('_primary_'));
		}

		it('emits a staged update once, in its new form, from an out-of-order key source', async () => {
			await db.exec(`begin`);
			await db.exec(`update t set v = 'new' where pk = 1`);
			mem.reset();
			expect(await rowsOf(KEY_SET_QUERY), 'no stale duplicate of pk 1').to.deep.equal([
				{ pk: 1, v: 'new' },
				{ pk: 2, v: 'two' },
				{ pk: 3, v: 'three' },
			]);
			expectPrimarySeeked();
			await db.exec(`rollback`);
		});

		it('keeps a staged delete deleted from an out-of-order key source', async () => {
			await db.exec(`begin`);
			await db.exec(`delete from t where pk = 1`);
			mem.reset();
			expect(await rowsOf(KEY_SET_QUERY), 'the deleted row does not reappear').to.deep.equal([
				{ pk: 2, v: 'two' },
				{ pk: 3, v: 'three' },
			]);
			expectPrimarySeeked();
			await db.exec(`rollback`);
		});

		it('surfaces a staged insert at a key in the set', async () => {
			await db.exec(`begin`);
			await db.exec(`delete from t where pk = 2`);
			await db.exec(`insert into t values (2, 'reinserted')`);
			mem.reset();
			expect(await rowsOf(KEY_SET_QUERY)).to.deep.equal([
				{ pk: 1, v: 'one' },
				{ pk: 2, v: 'reinserted' },
				{ pk: 3, v: 'three' },
			]);
			expectPrimarySeeked();
			await db.exec(`rollback`);
		});
	});

	describe('literal IN-list multi-seek (fix/bug-isolation-multiseek-merge-order)', () => {
		// A literal `where pk in (3, 1, 2)` stamps its seek keys in SQL-text order and
		// does NOT go through `emitKeySetSemiJoin`'s sort (that rewrite only fires for
		// `pk in (select …)`). Before the fix, the memory backend visited a multi-seek's
		// keys in that seek-argument order instead of the scanned structure's own key
		// order, so `mergeStreams` (which requires ascending key order on both streams)
		// mis-paired the staged row against the wrong stored row. Each list below is
		// deliberately out of ascending order.

		it('emits a staged update once, in its new form, from an out-of-order literal list', async () => {
			await db.exec(`create table t (pk integer primary key, v text) using isolated`);
			await db.exec(`insert into t values (1, 'one'), (2, 'two'), (3, 'three')`);
			await db.exec(`begin`);
			await db.exec(`update t set v = 'new' where pk = 1`);
			mem.reset();
			expect(await rowsOf(`select pk, v from t where pk in (3, 1, 2)`),
				'no stale duplicate of pk 1').to.deep.equal([
				{ pk: 1, v: 'new' },
				{ pk: 2, v: 'two' },
				{ pk: 3, v: 'three' },
			]);
			expect(mem.seen('t')[0]).to.match(multiSeekRe('_primary_'));
			await db.exec(`rollback`);
		});

		it('keeps a staged delete deleted, from an out-of-order literal list', async () => {
			await db.exec(`create table t (pk integer primary key, v text) using isolated`);
			await db.exec(`insert into t values (1, 'one'), (2, 'two'), (3, 'three')`);
			await db.exec(`begin`);
			await db.exec(`delete from t where pk = 1`);
			mem.reset();
			expect(await rowsOf(`select pk, v from t where pk in (3, 1, 2)`),
				'the deleted row does not reappear').to.deep.equal([
				{ pk: 2, v: 'two' },
				{ pk: 3, v: 'three' },
			]);
			expect(mem.seen('t')[0]).to.match(multiSeekRe('_primary_'));
			await db.exec(`rollback`);
		});

		it('merges a staged update against a DESC primary key, from an out-of-order literal list', async () => {
			// Canonical (comparator) key order here is descending: 3, 2, 1. The staged
			// key (3) must rank ahead of the list's FIRST literal (1) for the pre-fix
			// bug to bite — the merge sees overlay-3 "before" underlying-1, emits the
			// staged row, exhausts the (single-entry) overlay, and then drains the rest
			// of the misordered underlying stream verbatim — including the stale
			// original row for key 3, which the bad list order (1, 3, 2) has not
			// reached yet.
			await db.exec(`create table t (pk integer, v text, primary key (pk desc)) using isolated`);
			await db.exec(`insert into t values (1, 'one'), (2, 'two'), (3, 'three')`);
			await db.exec(`begin`);
			await db.exec(`update t set v = 'new' where pk = 3`);
			mem.reset();
			expect(await rowsOf(`select pk, v from t where pk in (1, 3, 2)`),
				'no stale duplicate of pk 3').to.deep.equal([
				{ pk: 1, v: 'one' },
				{ pk: 2, v: 'two' },
				{ pk: 3, v: 'new' },
			]);
			expect(mem.seen('t')[0]).to.match(multiSeekRe('_primary_'));
			await db.exec(`rollback`);
		});

		it('merges a staged update against a composite primary key (cross-product multi-seek)', async () => {
			// `a in (…)` with `b = 1` on a two-column PK builds the cross-product
			// multi-seek (seekWidth=2), the composite analogue of the scalar case above.
			await db.exec(`create table t (a integer, b integer, v text, primary key (a, b)) using isolated`);
			await db.exec(`insert into t values (1, 1, 'one'), (2, 1, 'two'), (3, 1, 'three')`);
			await db.exec(`begin`);
			await db.exec(`update t set v = 'new' where a = 1 and b = 1`);
			mem.reset();
			const rows = (await asyncIterableToArray(
				db.eval(`select a, b, v from t where a in (3, 1, 2) and b = 1`)))
				.sort((x, y) => (x.a as number) - (y.a as number)) as Record<string, SqlValue>[];
			expect(rows, 'no stale duplicate of (1, 1)').to.deep.equal([
				{ a: 1, b: 1, v: 'new' },
				{ a: 2, b: 1, v: 'two' },
				{ a: 3, b: 1, v: 'three' },
			]);
			expect(mem.seen('t')[0]).to.match(/^idx=_primary_\(0\);plan=5;/);
			await db.exec(`rollback`);
		});

		it('tolerates an out-of-order literal list on a secondary-index multi-seek with staged rows', async () => {
			// The secondary-index merge already sorted its overlay and tolerated an
			// unordered underlying stream before this fix (see the module doc comment
			// above). The memory backend's new sort is not NEEDED on this path, but must
			// not BREAK it either.
			await db.exec(`create table t (pk integer primary key, v integer, tag text) using isolated`);
			await db.exec(`create index ix_v on t (v)`);
			await db.exec(`insert into t values (1, 10, 'a'), (2, 20, 'b'), (3, 30, 'c')`);
			await db.exec(`begin`);
			await db.exec(`update t set tag = 'rewritten' where pk = 2`);
			mem.reset();
			expect(await rowsOf(`select pk, v, tag from t where v in (30, 10, 20)`)).to.deep.equal([
				{ pk: 1, v: 10, tag: 'a' },
				{ pk: 2, v: 20, tag: 'rewritten' },
				{ pk: 3, v: 30, tag: 'c' },
			]);
			expect(mem.seen('t')[0]).to.match(multiSeekRe('ix_v'));
			await db.exec(`rollback`);
		});
	});
});
