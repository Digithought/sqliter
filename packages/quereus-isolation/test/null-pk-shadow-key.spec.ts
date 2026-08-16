/**
 * fix/bug-isolation-null-pk-shadow-key
 *
 * `IsolatedTable.mergedSecondaryIndexQuery` shadows a committed row whenever its
 * primary key equals one already touched in the overlay — it keys that comparison
 * with `pkShadowKey`, built from `serializeKey` (isolated-table.ts, `pkShadowKey`).
 * `serializeKey` returns `null` — not a distinct per-row string — the moment ANY
 * primary-key component is NULL. A no-PK table's synthesized all-columns key does
 * NOT force its columns NOT NULL (each keeps its declared nullability), so any table
 * with a nullable, non-explicit-PK column can produce rows whose primary key is
 * NULL in some component. Every such row — committed or staged — collapsed to the
 * SAME shadow key (`null`), so touching ONE of them in a transaction wrongly hid
 * EVERY OTHER one from a merged secondary-index read.
 *
 * The fix swaps `serializeKey` for `serializeKeyNullGrouping`, which tags a NULL
 * component with a distinct `N:` marker instead of bailing the whole key to `null`.
 *
 * Each test below drives the read through a genuine secondary-index scan (verified
 * via the underlying's captured `idxStr`, `plan=5` multi-seek) — `pkShadowKey` is
 * only reachable from `mergedSecondaryIndexQuery`; a query that fell back to a
 * primary-key full scan would never exercise it and the test would pass vacuously.
 */

import { describe, it, beforeEach } from 'mocha';
import { expect } from 'chai';
import { Database, MemoryTableModule, asyncIterableToArray } from '@quereus/quereus';
import type { BaseModuleConfig, FilterInfo, Row, SqlValue, TableSchema } from '@quereus/quereus';
import { IsolationModule } from '../src/index.js';

/** Memory module that records the `idxStr` of every read its tables serve — see
 *  the identical helper in key-set-seek-merge.spec.ts. */
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

/**
 * Confirms the read was actually served as a secondary-index scan on `indexName` —
 * NOT a full scan (which stamps the `fullscan` sentinel, never `idx=`). The exact
 * plan code (eqSeek vs multiSeek) is an optimizer detail this test doesn't pin;
 * what matters is that `mergedSecondaryIndexQuery` (the only caller of the buggy
 * `pkShadowKey`) was actually reached rather than the primary-key full-scan merge,
 * which doesn't use `pkShadowKey` at all and would pass vacuously.
 */
function expectSecondarySeek(mem: IdxStrCapturingMemoryModule, tableName: string, indexName: string): void {
	expect(mem.seen(tableName)[0], `${tableName} served a secondary-index read on ${indexName}`)
		.to.match(new RegExp(`^idx=${indexName}\\(0\\);plan=\\d+`));
}

describe('null primary-key components through the merged secondary-index read (fix/bug-isolation-null-pk-shadow-key)', () => {
	let db: Database;
	let mem: IdxStrCapturingMemoryModule;

	beforeEach(() => {
		db = new Database();
		mem = new IdxStrCapturingMemoryModule();
		db.registerModule('isolated', new IsolationModule({ underlying: mem }));
	});

	const rowsBy = async (q: string, sortKey: string): Promise<Record<string, SqlValue>[]> =>
		(await asyncIterableToArray(db.eval(q)))
			.sort((a, b) => String(a[sortKey]).localeCompare(String(b[sortKey]))) as Record<string, SqlValue>[];

	it('does not hide an unmodified committed row that shares a NULL key component with a staged one', async () => {
		// No PRIMARY KEY declared -> both columns are synthesized into the primary key,
		// and `id` keeps its explicit nullable declaration (session default is NOT NULL).
		await db.exec(`create table t (id integer null, tag text not null) using isolated`);
		await db.exec(`create index ix_tag on t (tag)`);
		await db.exec(`insert into t values (null, 'a'), (null, 'b'), (null, 'c')`);

		await db.exec(`begin`);
		// Both staged ops carry a NULL `id` -> under the bug, EVERY committed row whose
		// `id` is also NULL (b and c) collapses to the same bogus shadow key and vanishes.
		await db.exec(`insert into t values (null, 'd')`);
		await db.exec(`delete from t where tag = 'a'`);
		mem.reset();

		expect(await rowsBy(`select id, tag from t where tag in ('b', 'c', 'd')`, 'tag')).to.deep.equal([
			{ id: null, tag: 'b' },
			{ id: null, tag: 'c' },
			{ id: null, tag: 'd' },
		]);
		expectSecondarySeek(mem, 't', 'ix_tag');
		await db.exec(`rollback`);
	});

	it('shadows only the row a staged UPDATE rewrote, not every other NULL-keyed row', async () => {
		// On a no-PK table every column is part of the synthesized key, so this UPDATE
		// relocates the row: the overlay holds both a tombstone at the old key and the
		// rewritten row at the new one, and BOTH carry a NULL `id`.
		await db.exec(`create table tu (id integer null, tag text not null) using isolated`);
		await db.exec(`create index ix_tag on tu (tag)`);
		await db.exec(`insert into tu values (null, 'a'), (null, 'b'), (null, 'c')`);

		await db.exec(`begin`);
		await db.exec(`update tu set tag = 'a2' where tag = 'a'`);
		mem.reset();

		expect(await rowsBy(`select id, tag from tu where tag in ('a', 'a2', 'b', 'c')`, 'tag')).to.deep.equal([
			{ id: null, tag: 'a2' },
			{ id: null, tag: 'b' },
			{ id: null, tag: 'c' },
		]);
		expectSecondarySeek(mem, 'tu', 'ix_tag');
		await db.exec(`rollback`);
	});

	it('keys rows differing only in WHICH column is NULL distinctly, not by "has a null somewhere"', async () => {
		await db.exec(`create table t3 (id1 integer null, id2 integer null, tag text not null) using isolated`);
		await db.exec(`create index ix_tag on t3 (tag)`);
		// 'x' is NULL in id1; 'y' is NULL in id2 (the other position); 'poison' is NULL in
		// id1 like 'x', so a position-blind (or component-blind) shadow key would confuse it.
		await db.exec(`insert into t3 values (null, 5, 'x'), (5, null, 'y'), (null, 9, 'poison')`);

		await db.exec(`begin`);
		await db.exec(`delete from t3 where tag = 'poison'`);
		mem.reset();

		expect(await rowsBy(`select id1, id2, tag from t3 where tag in ('x', 'y')`, 'tag')).to.deep.equal([
			{ id1: null, id2: 5, tag: 'x' },
			{ id1: 5, id2: null, tag: 'y' },
		]);
		expectSecondarySeek(mem, 't3', 'ix_tag');
		await db.exec(`rollback`);
	});

	it('does not confuse a NULL key component with a text value literally equal to "N:"', async () => {
		await db.exec(`create table t5 (tag text not null, val text null) using isolated`);
		await db.exec(`create index ix_tag on t5 (tag)`);
		// Both rows share tag='p' (a non-unique secondary index still multi-seeks); one has
		// a NULL val, the other the literal string 'N:' -- the NULL-grouping marker itself.
		await db.exec(`insert into t5 values ('p', null), ('p', 'N:')`);

		await db.exec(`begin`);
		// Deletes the NULL-val row; if its marker collided with the literal 'N:' string,
		// this would wrongly shadow the surviving row too.
		await db.exec(`delete from t5 where tag = 'p' and val is null`);
		mem.reset();

		expect(await rowsBy(`select tag, val from t5 where tag in ('p')`, 'val')).to.deep.equal([
			{ tag: 'p', val: 'N:' },
		]);
		expectSecondarySeek(mem, 't5', 'ix_tag');
		await db.exec(`rollback`);
	});
});
