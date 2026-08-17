/**
 * `VirtualTableModule.normalizeCreateSchema` — the create-time schema rewrite a
 * backing module exposes so the engine can ask "what would this schema become?"
 * without creating anything, and the engine-side application of it
 * (`normalizeBackingShape`, applied inside `deriveBackingShape`).
 *
 * WHY IT EXISTS. A module may own per-column physical attributes the body's output
 * type cannot predict. The store module keys an *implicit*-collation text primary-key
 * column under its table-level key collation (NOCASE by default), so a persisted
 * backing reads `COLLATE NOCASE` while the re-derived shape says BINARY. Every shape
 * comparison then reported a difference that did not exist — the materialized view's
 * adopt gate refilled the whole backing on every reopen, and `refresh` misclassified
 * the no-op as an inexpressible re-key.
 *
 * The store lives in another package, so the module here is a `MemoryTableModule`
 * subclass carrying the SAME rewrite (implicit text PK → NOCASE) and routing its own
 * `create` through it, exactly as `StoreModule` does. That keeps this suite's subject
 * the ENGINE half — normalization, its purity guard, and the comparisons that consume
 * it — with no store dependency.
 */

import { expect } from 'chai';
import { Database } from '../src/core/database.js';
import { MemoryTableModule } from '../src/vtab/memory/module.js';
import { buildColumnIndexMap, type TableSchema } from '../src/schema/table.js';
import type { ColumnSchema } from '../src/schema/column.js';
import type { AnyVirtualTableModule } from '../src/vtab/module.js';
import {
	deriveBackingShape,
	backingShapeMatches,
} from '../src/runtime/emit/materialized-view-helpers.js';

/** The store's implicit-text-PK reconcile, reproduced over a memory module. */
function reconcileImplicitTextPk(tableSchema: TableSchema, keyCollation: string): TableSchema {
	const pkIndices = new Set(tableSchema.primaryKeyDefinition.map(def => def.index));
	let changed = false;
	const columns: ColumnSchema[] = tableSchema.columns.map((col, i) => {
		if (!pkIndices.has(i) || !col.logicalType.isTextual || col.collationExplicit) return col;
		if ((col.collation || 'BINARY').toUpperCase() === keyCollation) return col;
		changed = true;
		return { ...col, collation: keyCollation };
	});
	if (!changed) return tableSchema;
	return { ...tableSchema, columns, columnIndexMap: buildColumnIndexMap(columns) };
}

/** A backing-host module that normalizes on create — the store's shape, in memory. */
class NormalizingMemoryModule extends MemoryTableModule {
	normalizeCreateSchema(tableSchema: TableSchema): TableSchema {
		return reconcileImplicitTextPk(tableSchema, 'NOCASE');
	}

	override async create(db: Database, tableSchema: TableSchema) {
		// One owner for the rewrite, exactly as `StoreModule.create` does.
		return super.create(db, this.normalizeCreateSchema(tableSchema));
	}
}

/** A module whose hook violates the no-reshape contract (drops the last column). */
class ReshapingMemoryModule extends MemoryTableModule {
	normalizeCreateSchema(tableSchema: TableSchema): TableSchema {
		const columns = tableSchema.columns.slice(0, -1);
		return { ...tableSchema, columns, columnIndexMap: buildColumnIndexMap(columns) };
	}
}

/** A module whose hook renames a column — the other half of the contract guard. */
class RenamingMemoryModule extends MemoryTableModule {
	normalizeCreateSchema(tableSchema: TableSchema): TableSchema {
		const columns = tableSchema.columns.map((c, i) => i === 0 ? { ...c, name: `${c.name}_x` } : c);
		return { ...tableSchema, columns, columnIndexMap: buildColumnIndexMap(columns) };
	}
}

async function rows(db: Database, sql: string): Promise<Record<string, unknown>[]> {
	const out: Record<string, unknown>[] = [];
	for await (const r of db.eval(sql)) out.push(r as Record<string, unknown>);
	return out;
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

/** A database with the normalizing module registered as `norm`. */
function freshDb(): Database {
	const db = new Database();
	db.registerModule('norm', new NormalizingMemoryModule());
	return db;
}

/** Source whose text column `a` declares NO collation — the implicit-default case. */
async function seedSource(db: Database): Promise<void> {
	await db.exec('create table src (id integer primary key, a text not null, b integer)');
	await db.exec("insert into src values (1, 'x', 10), (2, 'y', 20)");
}

const collationOf = (db: Database, table: string, col: string): string | undefined =>
	db.schemaManager.getTable('main', table)!.columns.find(c => c.name === col)?.collation;

describe('mv backing shape: module create-time normalization', () => {
	it('a text-PK backing over a normalizing module derives the module-normalized collation', async () => {
		const db = freshDb();
		try {
			await seedSource(db);
			await db.exec('create materialized view mv using norm() as select a, count(*) as n from src group by a');

			// The persisted/registered backing keys `a` under the module's K…
			expect(collationOf(db, 'mv', 'a'), 'backing text PK keys under the module K').to.equal('NOCASE');
			const backing = db.schemaManager.getTable('main', 'mv')!;
			expect(backing.primaryKeyDefinition[0].collation, 'the physical key definition agrees').to.equal('NOCASE');

			// …and so does the SHAPE the engine re-derives from the body. Before the hook
			// the two disagreed (NOCASE vs BINARY) and every comparison saw a false diff.
			const shape = deriveBackingShape(db, 'main', 'select a, count(*) as n from src group by a', undefined,
				{ moduleName: 'norm' });
			expect(shape.columns[0].collation).to.equal('NOCASE');
			expect(backingShapeMatches(backing, shape), 'live backing matches the re-derived shape').to.equal(true);
		} finally {
			await db.close();
		}
	});

	it('a module WITHOUT the hook is an exact identity (memory backing unchanged)', async () => {
		const db = new Database();
		try {
			await seedSource(db);
			await db.exec('create materialized view mv as select a, count(*) as n from src group by a');
			expect(collationOf(db, 'mv', 'a'), 'memory keeps the engine BINARY default').to.equal('BINARY');

			const shape = deriveBackingShape(db, 'main', 'select a, count(*) as n from src group by a', undefined,
				{ moduleName: 'memory' });
			expect(shape.columns[0].collation, 'no hook ⇒ derived shape untouched').to.equal('BINARY');
			expect(backingShapeMatches(db.schemaManager.getTable('main', 'mv')!, shape)).to.equal(true);
		} finally {
			await db.close();
		}
	});

	it('an EXPLICIT body collation is left alone — a genuine divergence still fails the shape gate', async () => {
		// The property that keeps normalization from degenerating into "ignore collation
		// on primary-key columns". `collate binary` in the body publishes an EXPLICIT
		// output collation, which the module's reconcile must not overwrite — so it stays
		// BINARY and does NOT match a backing persisted under NOCASE.
		const db = freshDb();
		try {
			await seedSource(db);
			await db.exec('create materialized view mv using norm() as select a, count(*) as n from src group by a');
			const nocaseBacking = db.schemaManager.getTable('main', 'mv')!;

			const explicitShape = deriveBackingShape(
				db, 'main', 'select a collate binary as a, count(*) as n from src group by a', undefined,
				{ moduleName: 'norm' });
			expect(explicitShape.columns[0].collation, 'an explicit COLLATE survives normalization').to.equal('BINARY');
			expect(explicitShape.columns[0].collationExplicit).to.equal(true);
			expect(backingShapeMatches(nocaseBacking, explicitShape),
				'NOCASE backing vs explicit-BINARY body is a REAL shape change').to.equal(false);
		} finally {
			await db.close();
		}
	});

	it('a non-text primary key is an identity pass', async () => {
		const db = freshDb();
		try {
			await seedSource(db);
			await db.exec('create materialized view mv using norm() as select id, a from src');
			expect(collationOf(db, 'mv', 'id'), 'an integer key is never re-collated').to.equal('BINARY');
			const shape = deriveBackingShape(db, 'main', 'select id, a from src', undefined, { moduleName: 'norm' });
			expect(shape.columns[0].collation).to.equal('BINARY');
			expect(backingShapeMatches(db.schemaManager.getTable('main', 'mv')!, shape)).to.equal(true);
		} finally {
			await db.close();
		}
	});

	it('an ORDERING-seeded text key column is normalized too (the probe uses the PHYSICAL key)', async () => {
		// `order by` seeds the ordering columns into the backing's physical primary key
		// (computeBackingPrimaryKey), so a text ORDERING column is reconciled at create.
		// A probe built from `shape.primaryKey` instead would keep the bug for it.
		const db = freshDb();
		try {
			await seedSource(db);
			await db.exec('create materialized view mv using norm() as select id, a from src order by a');
			const backing = db.schemaManager.getTable('main', 'mv')!;
			expect(backing.primaryKeyDefinition[0].index, 'the ordering column leads the physical key').to.equal(1);
			expect(collationOf(db, 'mv', 'a')).to.equal('NOCASE');

			const shape = deriveBackingShape(db, 'main', 'select id, a from src order by a', undefined,
				{ moduleName: 'norm' });
			expect(shape.columns[1].collation).to.equal('NOCASE');
			expect(backingShapeMatches(backing, shape)).to.equal(true);
		} finally {
			await db.close();
		}
	});

	it('refresh over a text-keyed backing takes the data-only path (no spurious re-key)', async () => {
		// Pre-normalization the re-derived shape said BINARY while the backing said
		// NOCASE, so `refresh` classified a no-op as a physical-PK collation change —
		// an INEXPRESSIBLE reshape, which is an error, not a rebuild.
		const db = freshDb();
		try {
			await seedSource(db);
			await db.exec('create materialized view mv using norm() as select a, count(*) as n from src group by a');
			const before = db.schemaManager.getTable('main', 'mv')!;

			await db.exec('refresh materialized view mv');

			const after = db.schemaManager.getTable('main', 'mv')!;
			expect(after, 'fast path preserves the backing table identity').to.equal(before);
			expect(await rows(db, 'select a, n from mv order by a'))
				.to.deep.equal([{ a: 'x', n: 1 }, { a: 'y', n: 1 }]);
		} finally {
			await db.close();
		}
	});

	it('a source column rename propagates over a text-keyed backing (pure name shift)', async () => {
		// The rename propagation asserts a pure POSITIONAL name shift through the same
		// structural predicates; a false collation diff would fail that assertion and
		// leave the view stale instead of carrying the new name onto the backing.
		const db = freshDb();
		try {
			await seedSource(db);
			await db.exec('create materialized view mv using norm() as select a, count(*) as n from src group by a');
			await db.exec('alter table src rename column a to label');

			const mv = db.schemaManager.getMaintainedTable('main', 'mv')!;
			expect(mv.derivation.stale ?? false, 'the rename did not strand the view stale').to.equal(false);
			expect(db.schemaManager.getTable('main', 'mv')!.columns[0].name, 'the new name reached the backing')
				.to.equal('label');
			expect(collationOf(db, 'mv', 'label'), 'and the key collation is unchanged').to.equal('NOCASE');
			expect(await rows(db, 'select label, n from mv order by label'))
				.to.deep.equal([{ label: 'x', n: 1 }, { label: 'y', n: 1 }]);
		} finally {
			await db.close();
		}
	});

	describe('two-valued compatibility for an implicit collation', () => {
		// `ColumnSchema.collationExplicit` does not survive a catalog round-trip, so once a
		// table exists an implicit body collation is genuinely ambiguous between its own
		// declared value and the module's normalized one. Both are physically consistent
		// with the body, so the reading that agrees with the live table is the live one —
		// otherwise a table-form maintained table that opts OUT of the module's collation
		// (`collate binary`) would mismatch its own declaration forever.
		const BODY = 'select a, count(*) as n from src group by a';

		async function seedDeclared(db: Database): Promise<TableSchema> {
			await seedSource(db);
			await db.exec('create table mt (a text not null collate binary primary key, n integer not null) '
				+ `using norm maintained as ${BODY}`);
			return db.schemaManager.getTable('main', 'mt')!;
		}

		it('an explicitly-declared key collation survives create and is what the shape resolves to', async () => {
			const db = freshDb();
			try {
				const table = await seedDeclared(db);
				expect(table.columns[0].collation, 'the declaration wins over the module K').to.equal('BINARY');

				// Free normalization (create posture — nothing to be compatible with yet).
				expect(deriveBackingShape(db, 'main', BODY, undefined, { moduleName: 'norm' }).columns[0].collation)
					.to.equal('NOCASE');
				// Against the live table, the raw reading already agrees and is kept.
				const shape = deriveBackingShape(db, 'main', BODY, undefined, { moduleName: 'norm', against: table });
				expect(shape.columns[0].collation).to.equal('BINARY');
				expect(backingShapeMatches(table, shape), 'the declared shape still matches its body').to.equal(true);
			} finally {
				await db.close();
			}
		});

		it('refresh over such a table stays on the data-only path', async () => {
			const db = freshDb();
			try {
				const before = await seedDeclared(db);
				await db.exec('refresh materialized view mt');
				expect(db.schemaManager.getTable('main', 'mt'), 'no reshape, no re-key').to.equal(before);
				expect(await rows(db, 'select a, n from mt order by a'))
					.to.deep.equal([{ a: 'x', n: 1 }, { a: 'y', n: 1 }]);
			} finally {
				await db.close();
			}
		});

		it('a NOT NULL loosening on the source does not drag the key over to the module K', async () => {
			// The agreement test must weigh ONLY the attribute the hook rewrote. A source
			// `drop not null` makes the re-derived key column nullable while the backing
			// keeps it NOT NULL — a difference `describeBackingShapeMismatch` deliberately
			// MASKS for a physical-PK column. Weighing it here instead flipped the declared
			// `collate binary` key to the module's NOCASE, which is an inexpressible
			// physical re-key: the view went stale and `refresh` errored on a no-op.
			const db = freshDb();
			try {
				await seedDeclared(db);
				await db.exec('alter table src alter column a drop not null');

				const live = db.schemaManager.getTable('main', 'mt')!;
				const shape = deriveBackingShape(db, 'main', BODY, undefined, { moduleName: 'norm', against: live });
				expect(shape.columns[0].notNull, 'the body really did loosen').to.equal(false);
				expect(shape.columns[0].collation, 'the declared key collation survives the loosening').to.equal('BINARY');
				expect(db.schemaManager.getMaintainedTable('main', 'mt')!.derivation.stale ?? false,
					'the loosening did not strand the view stale').to.equal(false);

				await db.exec('refresh materialized view mt');
				expect(db.schemaManager.getTable('main', 'mt'), 'still the data-only path').to.equal(live);
				expect(await rows(db, 'select a, n from mt order by a'))
					.to.deep.equal([{ a: 'x', n: 1 }, { a: 'y', n: 1 }]);
			} finally {
				await db.close();
			}
		});

		it('a live collation matching NEITHER reading is still a mismatch', async () => {
			const db = freshDb();
			try {
				const table = await seedDeclared(db);
				// RTRIM is neither the body's own BINARY nor the module's NOCASE.
				const rtrimBacking: TableSchema = {
					...table,
					columns: [{ ...table.columns[0], collation: 'RTRIM' }, table.columns[1]],
					primaryKeyDefinition: [{ ...table.primaryKeyDefinition[0], collation: 'RTRIM' }],
				};
				const shape = deriveBackingShape(db, 'main', BODY, undefined,
					{ moduleName: 'norm', against: rtrimBacking });
				expect(shape.columns[0].collation, 'no reading agrees ⇒ the module answer stands').to.equal('NOCASE');
				expect(backingShapeMatches(rtrimBacking, shape)).to.equal(false);
			} finally {
				await db.close();
			}
		});
	});

	describe('purity contract', () => {
		it('a hook that drops a column is a loud INTERNAL error, not a shape difference', async () => {
			const db = new Database();
			try {
				db.registerModule('reshaper', new ReshapingMemoryModule() as unknown as AnyVirtualTableModule);
				await seedSource(db);
				await expectThrows(
					() => db.exec('create materialized view mv using reshaper() as select a, count(*) as n from src group by a'),
					/normalizeCreateSchema changed the column count .*may only adjust per-column attributes/i,
				);
				expect(db.schemaManager.getMaintainedTable('main', 'mv')).to.be.undefined;
			} finally {
				await db.close();
			}
		});

		it('a hook that renames a column is a loud INTERNAL error', async () => {
			const db = new Database();
			try {
				db.registerModule('renamer', new RenamingMemoryModule() as unknown as AnyVirtualTableModule);
				await seedSource(db);
				await expectThrows(
					() => db.exec('create materialized view mv using renamer() as select a, count(*) as n from src group by a'),
					/normalizeCreateSchema renamed or reordered column 0/i,
				);
				expect(db.schemaManager.getMaintainedTable('main', 'mv')).to.be.undefined;
			} finally {
				await db.close();
			}
		});
	});
});
