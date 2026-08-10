/**
 * `USING <module>(...)` on CREATE MATERIALIZED VIEW — backing-module
 * pluggability (ticket `mv-backing-using-module`, on top of the BackingHost
 * capability from `mv-backing-host-capability`).
 *
 * A second `MemoryTableModule` instance registered as `mem2` is a genuine
 * non-default backing-host module with full semantics, so every MV behavior
 * (row-time maintenance, reads-own-writes, commit/rollback lockstep,
 * MV-over-MV cascade, covering-UNIQUE enforcement, refresh, rename
 * propagation, drop, create-rollback) is asserted against a backing that
 * verifiably lives in the NAMED module's table map — not in the default
 * memory module.
 *
 * Round-trip (DDL generator / importCatalog) and differ coverage live in
 * `view-mv-ddl-persistence.spec.ts` and `declarative-equivalence.spec.ts`.
 */

import { expect } from 'chai';
import { Database } from '../src/core/database.js';
import { MemoryTableModule } from '../src/vtab/memory/module.js';
import type { AnyVirtualTableModule } from '../src/vtab/module.js';
import { computeBodyHash, normalizeBackingModule } from '../src/schema/view.js';
import { viewDefinitionToCanonicalString } from '../src/emit/ast-stringify.js';
import { generateMaintainedTableDDL } from '../src/schema/ddl-generator.js';

// The maintained table IS the backing — one TableSchema under the MV's own name.
const BACKING = 'mv';
const BACKING_KEY = `main.${BACKING}`;

async function rows(db: Database, sql: string): Promise<Record<string, unknown>[]> {
	const out: Record<string, unknown>[] = [];
	for await (const r of db.eval(sql)) out.push(r as Record<string, unknown>);
	return out;
}

/** Fresh database with a second MemoryTableModule registered as `mem2`. */
function freshDb(): { db: Database; mem2: MemoryTableModule; mem: MemoryTableModule } {
	const db = new Database();
	const mem2 = new MemoryTableModule();
	db.registerModule('mem2', mem2);
	const mem = db.schemaManager.getModule('memory')!.module as MemoryTableModule;
	return { db, mem2, mem };
}

async function expectThrows(fn: () => Promise<unknown>, pattern: RegExp): Promise<void> {
	let threw = false;
	try {
		await fn();
	} catch (e) {
		threw = true;
		expect((e as Error).message).to.match(pattern);
	}
	expect(threw, `expected a throw matching ${pattern}`).to.equal(true);
}

describe('mv backing module: create gate diagnostics', () => {
	it('an unknown module is rejected with a clear diagnostic', async () => {
		const { db } = freshDb();
		try {
			await db.exec('create table base (id integer primary key, v integer)');
			await expectThrows(
				() => db.exec('create materialized view mv using nosuch() as select id, v from base'),
				/no virtual table module named 'nosuch'/i,
			);
			expect(db.schemaManager.getMaintainedTable('main', 'mv')).to.be.undefined;
		} finally {
			await db.close();
		}
	});

	it('a module without the backing-host capability is rejected (UNSUPPORTED)', async () => {
		const { db } = freshDb();
		try {
			// Minimal vtab module passing registerModule's shape checks but
			// deliberately lacking getBackingHost — the capability IS the method.
			const noCap = {
				create: () => { throw new Error('unreachable in this test'); },
				connect: () => { throw new Error('unreachable in this test'); },
				destroy: async () => { /* no-op */ },
			} as unknown as AnyVirtualTableModule;
			db.registerModule('nocap', noCap);
			await db.exec('create table base (id integer primary key, v integer)');
			await expectThrows(
				() => db.exec('create materialized view mv using nocap() as select id, v from base'),
				/module 'nocap' cannot host a materialized-view backing table/i,
			);
			expect(db.schemaManager.getMaintainedTable('main', 'mv')).to.be.undefined;
		} finally {
			await db.close();
		}
	});

	it('`using memory()` and `using mem()` normalize to the omitted-clause record', async () => {
		const { db, mem } = freshDb();
		try {
			await db.exec('create table base (id integer primary key, v integer)');
			await db.exec('create materialized view mv_a as select id, v from base');
			await db.exec('create materialized view mv_b using memory() as select id, v from base');
			await db.exec('create materialized view mv_c using mem as select id, v from base');
			for (const name of ['mv_a', 'mv_b', 'mv_c']) {
				const mv = db.schemaManager.getMaintainedTable('main', name)!;
				const stored = normalizeBackingModule(mv.vtabModuleName, mv.vtabArgs);
				expect(stored.storedModuleName, `${name} records no module (memory default)`).to.be.undefined;
				expect(stored.storedModuleArgs, `${name} records no args`).to.be.undefined;
				expect(generateMaintainedTableDDL(mv), `${name} generated DDL is clause-free`).to.not.match(/using/i);
				expect(mem.tables.has(`main.${name}`.toLowerCase()),
					`${name} backing lives in the default memory module`).to.equal(true);
			}
			// Identical body ⇒ identical bodyHash across all three spellings.
			const hashes = ['mv_a', 'mv_b', 'mv_c'].map(n => db.schemaManager.getMaintainedTable('main', n)!.derivation.bodyHash);
			expect(new Set(hashes).size).to.equal(1);
		} finally {
			await db.close();
		}
	});

	it('explicit `using memory(...)` with non-empty args records and round-trips the clause', async () => {
		const { db } = freshDb();
		try {
			await db.exec('create table base (id integer primary key, v integer)');
			await db.exec("create materialized view mv using memory (hint = 'x') as select id, v from base");
			const mv = db.schemaManager.getMaintainedTable('main', 'mv')!;
			const stored = normalizeBackingModule(mv.vtabModuleName, mv.vtabArgs);
			expect(stored.storedModuleName).to.equal('memory');
			expect(stored.storedModuleArgs).to.deep.equal({ hint: 'x' });
			expect(generateMaintainedTableDDL(mv)).to.match(/using memory \(hint = /i);
		} finally {
			await db.close();
		}
	});
});

describe('mv backing module: full semantics with a mem2 backing', () => {
	it('create places the backing in mem2; maintenance, refresh, and drop all stay there', async () => {
		const { db, mem2, mem } = freshDb();
		try {
			await db.exec('create table base (id integer primary key, v integer)');
			await db.exec('insert into base values (1, 10), (2, 20)');
			await db.exec('create materialized view mv using mem2() as select id, v from base');

			// The backing verifiably lives in mem2's table map, not the default module's.
			expect(mem2.tables.has(BACKING_KEY), 'backing in mem2').to.equal(true);
			expect(mem.tables.has(BACKING_KEY), 'backing NOT in default memory').to.equal(false);
			const backing = db.schemaManager.getTable('main', BACKING)!;
			expect(backing.vtabModuleName).to.equal('mem2');

			const mv = db.schemaManager.getMaintainedTable('main', 'mv')!;
			expect(normalizeBackingModule(mv.vtabModuleName, mv.vtabArgs).storedModuleName).to.equal('mem2');
			expect(generateMaintainedTableDDL(mv), 'canonical DDL carries the clause').to.match(/using mem2/i);

			expect(await rows(db, 'select id, v from mv order by id'))
				.to.deep.equal([{ id: 1, v: 10 }, { id: 2, v: 20 }]);

			// Row-time maintenance is live against the mem2 backing.
			await db.exec('insert into base values (3, 30)');
			await db.exec('update base set v = 99 where id = 1');
			await db.exec('delete from base where id = 2');
			expect(await rows(db, 'select id, v from mv order by id'))
				.to.deep.equal([{ id: 1, v: 99 }, { id: 3, v: 30 }]);

			// Data-only refresh preserves the module.
			await db.exec('refresh materialized view mv');
			expect(db.schemaManager.getTable('main', BACKING)!.vtabModuleName).to.equal('mem2');
			expect(await rows(db, 'select id, v from mv order by id'))
				.to.deep.equal([{ id: 1, v: 99 }, { id: 3, v: 30 }]);

			// Drop destroys the backing in the NAMED module.
			await db.exec('drop materialized view mv');
			expect(mem2.tables.has(BACKING_KEY), 'mem2 backing destroyed on drop').to.equal(false);
			expect(db.schemaManager.getTable('main', BACKING)).to.be.undefined;
		} finally {
			await db.close();
		}
	});

	it('bodyHash is module-independent (same formula as a default-backed MV)', async () => {
		const { db } = freshDb();
		try {
			await db.exec('create table base (id integer primary key, v integer)');
			await db.exec('create materialized view mv_mem2 using mem2() as select id, v from base');
			await db.exec('create materialized view mv_def as select id, v from base');
			const a = db.schemaManager.getMaintainedTable('main', 'mv_mem2')!;
			const b = db.schemaManager.getMaintainedTable('main', 'mv_def')!;
			// The module is deliberately NOT folded into the hash — already-persisted
			// memory-backed MVs must not see a formula drift from this ticket.
			expect(a.derivation.bodyHash).to.equal(b.derivation.bodyHash);
			expect(a.derivation.bodyHash).to.equal(
				computeBodyHash(viewDefinitionToCanonicalString(a.derivation.columns, a.derivation.selectAst)));
		} finally {
			await db.close();
		}
	});

	it('a transaction rollback reverts the mem2 backing in lockstep with the source', async () => {
		const { db } = freshDb();
		try {
			await db.exec('create table base (id integer primary key, v integer)');
			await db.exec('insert into base values (1, 10)');
			await db.exec('create materialized view mv using mem2() as select id, v from base');

			await db.exec('begin');
			await db.exec('insert into base values (2, 20)');
			// Reads-own-writes: the uncommitted source write is visible through the MV.
			expect(await rows(db, 'select id, v from mv order by id'))
				.to.deep.equal([{ id: 1, v: 10 }, { id: 2, v: 20 }]);
			await db.exec('rollback');
			expect(await rows(db, 'select id, v from mv order by id'))
				.to.deep.equal([{ id: 1, v: 10 }]);
		} finally {
			await db.close();
		}
	});

	it('refresh in-place reshape preserves the module (no silent migration to memory)', async () => {
		const { db, mem2, mem } = freshDb();
		try {
			await db.exec('create table base (id integer primary key, v integer)');
			await db.exec('insert into base values (1, 10)');
			await db.exec('create materialized view mv using mem2() as select * from base');

			// A trailing source-column add shifts the `select *` body's shape → refresh
			// reshapes the maintained table IN PLACE (via the mem2 module's alterTable),
			// preserving the incarnation in the MV's OWN module.
			await db.exec('alter table base add column w integer default 7');
			await db.exec('refresh materialized view mv');

			expect(db.schemaManager.getTable('main', BACKING)!.vtabModuleName, 'rebuilt backing module').to.equal('mem2');
			expect(mem2.tables.has(BACKING_KEY), 'rebuilt backing in mem2').to.equal(true);
			expect(mem.tables.has(BACKING_KEY), 'no stray copy in default memory').to.equal(false);
			const mv = db.schemaManager.getMaintainedTable('main', 'mv')!;
			expect(normalizeBackingModule(mv.vtabModuleName, mv.vtabArgs).storedModuleName, 'module identity survives the rebuild').to.equal('mem2');
			expect(await rows(db, 'select id, v, w from mv'))
				.to.deep.equal([{ id: 1, v: 10, w: 7 }]);
		} finally {
			await db.close();
		}
	});

	it('source column rename propagates onto the mem2 backing without perturbing the module', async () => {
		const { db, mem2 } = freshDb();
		try {
			await db.exec('create table base (id integer primary key, v integer)');
			await db.exec('insert into base values (1, 10)');
			await db.exec('create materialized view mv using mem2() as select id, v from base');

			await db.exec('alter table base rename column v to w');
			const mv = db.schemaManager.getMaintainedTable('main', 'mv')!;
			expect(mv.derivation.stale, 'MV stays live through the rename').to.not.equal(true);
			expect(normalizeBackingModule(mv.vtabModuleName, mv.vtabArgs).storedModuleName, 'module identity untouched by the rewrite clone').to.equal('mem2');
			expect(generateMaintainedTableDDL(mv)).to.match(/using mem2/i);
			expect(mem2.tables.has(BACKING_KEY)).to.equal(true);
			expect(await rows(db, 'select id, w from mv')).to.deep.equal([{ id: 1, w: 10 }]);
		} finally {
			await db.close();
		}
	});

	it('create-fill failure rolls the half-built backing out of the NAMED module', async () => {
		const { db, mem2 } = freshDb();
		try {
			await db.exec('create table base (id integer primary key, v integer)');
			await db.exec('insert into base values (1, 10), (2, 10)');
			// Projecting only the non-key column duplicates rows → the fill's
			// "must be a set" gate throws after the mem2 backing was created.
			await expectThrows(
				() => db.exec('create materialized view mv using mem2() as select v from base'),
				/must be a set/i,
			);
			expect(db.schemaManager.getMaintainedTable('main', 'mv')).to.be.undefined;
			expect(db.schemaManager.getTable('main', BACKING)).to.be.undefined;
			expect(mem2.tables.has(BACKING_KEY), 'no half-built backing left in mem2').to.equal(false);
		} finally {
			await db.close();
		}
	});
});

describe('mv backing module: covering-UNIQUE enforcement in mem2', () => {
	it('REPLACE eviction and same-statement reads-own-writes hold with the backing in mem2', async () => {
		const { db, mem2 } = freshDb();
		try {
			await db.exec('create table t (id integer primary key, x integer not null, y integer not null, unique (x, y))');
			// Covering shape: uc-cols + pk, ordered by the uc columns (prefix-scan path).
			await db.exec('create materialized view ix using mem2() as select x, y, id from t order by x, y');
			expect(mem2.tables.has('main.ix')).to.equal(true);
			const t = db.schemaManager.getTable('main', 't')!;
			expect(t.uniqueConstraints![0].coveringStructureName, 'covering link established').to.equal('ix');

			await db.exec('insert into t values (1, 7, 8)');
			// Plain duplicate → constraint error answered through the mem2 backing.
			await expectThrows(() => db.exec('insert into t values (9, 7, 8)'), /unique/i);

			// REPLACE evicts the conflicting source row; the eviction pipeline keeps
			// the mem2 backing consistent within the same statement.
			await db.exec('insert or replace into t values (2, 7, 8)');
			expect(await rows(db, 'select id, x, y from t order by id')).to.deep.equal([{ id: 2, x: 7, y: 8 }]);
			expect(await rows(db, 'select x, y, id from ix order by x, y')).to.deep.equal([{ x: 7, y: 8, id: 2 }]);

			// Same-statement reads-own-writes: the second row conflicts with the
			// first row of the SAME statement and must evict it via the pending state.
			await db.exec('insert or replace into t values (3, 9, 9), (4, 9, 9)');
			expect(await rows(db, 'select id from t where x = 9 and y = 9')).to.deep.equal([{ id: 4 }]);
			expect(await rows(db, 'select id from ix where x = 9 and y = 9')).to.deep.equal([{ id: 4 }]);
		} finally {
			await db.close();
		}
	});
});

describe('mv backing module: MV-over-MV across modules', () => {
	it('a source write cascades through a mem2 producer into a memory consumer in one transaction', async () => {
		const { db, mem2, mem } = freshDb();
		try {
			await db.exec('create table base (id integer primary key, v integer)');
			await db.exec('insert into base values (1, 10)');
			await db.exec('create materialized view mv1 using mem2() as select id, v from base');
			await db.exec('create materialized view mv2 as select id, v from mv1');
			expect(mem2.tables.has('main.mv1'), 'mv1 in mem2').to.equal(true);
			expect(mem.tables.has('main.mv2'), 'mv2 in memory').to.equal(true);

			// One write flows through both backings.
			await db.exec('insert into base values (2, 20)');
			expect(await rows(db, 'select id, v from mv1 order by id'))
				.to.deep.equal([{ id: 1, v: 10 }, { id: 2, v: 20 }]);
			expect(await rows(db, 'select id, v from mv2 order by id'))
				.to.deep.equal([{ id: 1, v: 10 }, { id: 2, v: 20 }]);

			// A failing statement (second row PK-conflicts) rolls back BOTH backings
			// in lockstep — the first row's cascade writes must not survive.
			await expectThrows(() => db.exec('insert into base values (3, 30), (1, 99)'), /unique|constraint|primary/i);
			expect(await rows(db, 'select id, v from mv1 order by id'))
				.to.deep.equal([{ id: 1, v: 10 }, { id: 2, v: 20 }]);
			expect(await rows(db, 'select id, v from mv2 order by id'))
				.to.deep.equal([{ id: 1, v: 10 }, { id: 2, v: 20 }]);
		} finally {
			await db.close();
		}
	});

	it('a memory producer feeding a mem2 consumer works in the reverse direction too', async () => {
		const { db } = freshDb();
		try {
			await db.exec('create table base (id integer primary key, v integer)');
			await db.exec('insert into base values (1, 10)');
			await db.exec('create materialized view mv1 as select id, v from base');
			await db.exec('create materialized view mv2 using mem2() as select id, v from mv1');
			await db.exec('insert into base values (2, 20)');
			expect(await rows(db, 'select id, v from mv2 order by id'))
				.to.deep.equal([{ id: 1, v: 10 }, { id: 2, v: 20 }]);
		} finally {
			await db.close();
		}
	});
});
