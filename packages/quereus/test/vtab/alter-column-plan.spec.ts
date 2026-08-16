import { expect } from 'chai';
import {
	buildAlterColumnPlan,
	planColumnAttributeChange,
	planSetCollation,
	planSetDataType,
	planSetNotNull,
	type AlterColumnContext,
	type ColumnAttributeChange,
} from '../../src/vtab/memory/layer/alter-column.js';
import { createDefaultColumnSchema } from '../../src/schema/column.js';
import type { ColumnSchema } from '../../src/schema/column.js';
import type { IndexSchema, PrimaryKeyColumnDefinition, TableSchema } from '../../src/schema/table.js';
import { INTEGER_TYPE, TEXT_TYPE } from '../../src/types/builtin-types.js';
import type { LiteralExpr } from '../../src/parser/ast.js';
import { StatusCode, type Row, type SqlValue } from '../../src/common/types.js';
import { QuereusError } from '../../src/common/errors.js';

/**
 * Unit coverage for `vtab/memory/layer/alter-column.ts` — the decide-and-validate half of
 * `MemoryTableManager.alterColumn`. Everything here is a pure function of a pre-change
 * TableSchema plus a row iterable, so it is exercised directly, without a database: the
 * `.sqllogic` suites cover the end-to-end ALTER, this covers the branches they reach only
 * incidentally (the no-op returns, the handler dispatch order, and the synchronous-scan
 * atomicity the module's own doc comment relies on).
 */

const TEXT_COL = (name: string, over: Partial<ColumnSchema> = {}): ColumnSchema =>
	({ ...createDefaultColumnSchema(name, false), ...over });

function makeSchema(
	columns: ColumnSchema[],
	over: { primaryKeyDefinition?: PrimaryKeyColumnDefinition[]; indexes?: IndexSchema[] } = {},
): TableSchema {
	return {
		name: 't',
		schemaName: 'main',
		columns,
		columnIndexMap: new Map(columns.map((c, i) => [c.name.toLowerCase(), i])),
		primaryKeyDefinition: over.primaryKeyDefinition ?? [],
		indexes: over.indexes,
		checkConstraints: [],
		vtabModuleName: 'memory',
		isView: false,
	};
}

/** An {@link AlterColumnContext} over column 0 of `schema`, scanning `rows` synchronously. */
function makeCtx(schema: TableSchema, rows: Row[] = [], colIndex = 0): AlterColumnContext {
	return {
		schema,
		tableName: 't',
		columnName: schema.columns[colIndex].name,
		colIndex,
		effectiveRows: () => rows,
		isCollationRegistered: () => false,
	};
}

/** The same context, but handing back an async stream — a wrapper module's overlay. */
function withAsyncRows(ctx: AlterColumnContext, rows: Row[]): AlterColumnContext {
	async function* stream(): AsyncIterable<Row> {
		for (const row of rows) yield row;
	}
	return { ...ctx, effectiveRows: stream };
}

const literal = (value: SqlValue): LiteralExpr => ({ type: 'literal', value });

/** Asserts `fn` rejects with a QuereusError carrying `code`, and returns the error. */
async function expectStatus(fn: () => Promise<unknown>, code: StatusCode): Promise<QuereusError> {
	try {
		await fn();
	} catch (e) {
		expect(e).to.be.instanceOf(QuereusError);
		expect((e as QuereusError).code).to.equal(code);
		return e as QuereusError;
	}
	throw new Error('expected a QuereusError, none thrown');
}

describe('alter column: planSetCollation', () => {
	it('returns null when the column already holds the collation explicitly', () => {
		const schema = makeSchema([TEXT_COL('a', { collation: 'NOCASE', collationExplicit: true })]);
		expect(planSetCollation(makeCtx(schema), 'nocase')).to.equal(null);
	});

	it('marks a matching-but-implicit collation explicit WITHOUT re-keying', () => {
		const schema = makeSchema([TEXT_COL('a', { collation: 'NOCASE' })]);
		const change = planSetCollation(makeCtx(schema), 'NOCASE');
		expect(change).to.not.equal(null);
		expect(change!.newCol.collationExplicit).to.equal(true);
		expect(change!.collationChanged).to.equal(false);
		expect(change!.rewrite).to.equal(null);
	});

	it('re-keys when the collation NAME moves', () => {
		const change = planSetCollation(makeCtx(makeSchema([TEXT_COL('a')])), 'nocase');
		expect(change!.newCol.collation).to.equal('NOCASE');
		expect(change!.collationChanged).to.equal(true);
		expect(change!.rewrite).to.equal(null);
	});

	it('treats an implicit BINARY column as needing only the explicit flag', () => {
		const change = planSetCollation(makeCtx(makeSchema([TEXT_COL('a')])), 'binary');
		expect(change!.collationChanged).to.equal(false);
		expect(change!.newCol.collationExplicit).to.equal(true);
	});

	it('rejects a collation neither the type nor the registry knows', () => {
		expect(() => planSetCollation(makeCtx(makeSchema([TEXT_COL('a')])), 'no_such_collation'))
			.to.throw(QuereusError);
	});
});

describe('alter column: planSetNotNull', () => {
	it('returns null when the column is already in the requested state', async () => {
		const notNull = makeSchema([TEXT_COL('a', { notNull: true })]);
		expect(await planSetNotNull(makeCtx(notNull), true)).to.equal(null);
		const nullable = makeSchema([TEXT_COL('a')]);
		expect(await planSetNotNull(makeCtx(nullable), false)).to.equal(null);
	});

	it('drops NOT NULL on a primary key column as metadata only', async () => {
		// Key membership does not imply NOT NULL (docs/schema.md § "Primary-key
		// nullability"), and loosening rewrites no value — so no key moves.
		const schema = makeSchema([TEXT_COL('a', { notNull: true })], { primaryKeyDefinition: [{ index: 0 }] });
		const change = await planSetNotNull(makeCtx(schema), false);
		expect(change!.newCol.notNull).to.equal(false);
		expect(change!.rewrite).to.equal(null);
		expect(change!.comparatorChanged, 'a pure loosening moves no key').to.equal(false);
	});

	it('drops NOT NULL on a non-key column as metadata only', async () => {
		const schema = makeSchema([TEXT_COL('a', { notNull: true })]);
		const change = await planSetNotNull(makeCtx(schema), false);
		expect(change!.newCol.notNull).to.equal(false);
		expect(change!.rewrite).to.equal(null);
	});

	it('tightens without a rewrite when no effective row holds NULL', async () => {
		const schema = makeSchema([TEXT_COL('a')]);
		const change = await planSetNotNull(makeCtx(schema, [['x'], ['y']]), true);
		expect(change!.newCol.notNull).to.equal(true);
		expect(change!.rewrite).to.equal(null);
	});

	it('rejects a visible NULL when the column has no literal DEFAULT', async () => {
		const schema = makeSchema([TEXT_COL('a')]);
		const err = await expectStatus(
			() => planSetNotNull(makeCtx(schema, [['x'], [null]]), true),
			StatusCode.CONSTRAINT,
		);
		expect(err.message).to.contain('contains NULL values');
	});

	it('backfills a visible NULL from the literal DEFAULT', async () => {
		const schema = makeSchema([TEXT_COL('a', { defaultValue: literal('d') })]);
		const change = await planSetNotNull(makeCtx(schema, [[null]]), true);
		expect(change!.rewrite).to.not.equal(null);
		expect(change!.rewrite!.convertNulls).to.equal(true);
		expect(change!.rewrite!.convert(null)).to.equal('d');
		expect(change!.rewrite!.convert('kept')).to.equal('kept');
		expect(change!.collationChanged).to.equal(false);
		expect(change!.comparatorChanged).to.equal(false);
	});

	it('scans an async effective-row source the same way', async () => {
		const schema = makeSchema([TEXT_COL('a')]);
		const ctx = withAsyncRows(makeCtx(schema), [['x'], [null]]);
		await expectStatus(() => planSetNotNull(ctx, true), StatusCode.CONSTRAINT);
	});
});

describe('alter column: planSetDataType', () => {
	it('treats an alias retype as schema-only', async () => {
		const schema = makeSchema([TEXT_COL('a')]);
		// `varchar(50)` flattens to the same shared TEXT_TYPE object as the column already holds.
		const change = await planSetDataType(makeCtx(schema, [['x']]), 'varchar(50)');
		expect(change.newCol.logicalType).to.equal(TEXT_TYPE);
		expect(change.rewrite).to.equal(null);
		expect(change.comparatorChanged).to.equal(false);
	});

	it('rejects a retype of a primary key column', async () => {
		const schema = makeSchema([TEXT_COL('a')], { primaryKeyDefinition: [{ index: 0 }] });
		const err = await expectStatus(() => planSetDataType(makeCtx(schema), 'integer'), StatusCode.CONSTRAINT);
		expect(err.message).to.contain("primary key column 'a'");
	});

	it('rejects a value the new type refuses', async () => {
		const schema = makeSchema([TEXT_COL('a')]);
		const err = await expectStatus(
			() => planSetDataType(makeCtx(schema, [['1'], ['hello']]), 'integer'),
			StatusCode.MISMATCH,
		);
		expect(err.message).to.contain("Cannot convert value in 'a' to integer");
	});

	it('rewrites values and re-keys when the comparator moves', async () => {
		const schema = makeSchema([TEXT_COL('a')]);
		const change = await planSetDataType(makeCtx(schema, [['1'], ['2']]), 'integer');
		expect(change.newCol.logicalType).to.equal(INTEGER_TYPE);
		expect(change.comparatorChanged).to.equal(true);
		expect(change.collationChanged).to.equal(false);
		expect(change.rewrite!.convertNulls).to.equal(false);
		expect(Number(change.rewrite!.convert('01'))).to.equal(1);
	});

	it('lets NULL rows through the convertibility scan, and leaves them unrewritten', async () => {
		const schema = makeSchema([TEXT_COL('a')]);
		const change = await planSetDataType(makeCtx(schema, [[null], ['7']]), 'integer');
		expect(change.rewrite).to.not.equal(null);
		expect(change.rewrite!.convertNulls).to.equal(false);
	});
});

describe('alter column: planColumnAttributeChange dispatch', () => {
	const schema = makeSchema([TEXT_COL('a')]);

	it('sets a DEFAULT as metadata only', async () => {
		const change = await planColumnAttributeChange(makeCtx(schema), { columnName: 'a', setDefault: literal(7) });
		expect(change!.newCol.defaultValue).to.not.equal(null);
		expect(change!.rewrite).to.equal(null);
		expect(change!.collationChanged).to.equal(false);
	});

	it('treats DROP DEFAULT (an explicit null) as a change, not an absent attribute', async () => {
		const withDefault = makeSchema([TEXT_COL('a', { defaultValue: literal(7) })]);
		const change = await planColumnAttributeChange(makeCtx(withDefault), { columnName: 'a', setDefault: null });
		expect(change!.newCol.defaultValue).to.equal(null);
	});

	it('rejects a change with no attribute populated', async () => {
		await expectStatus(
			() => planColumnAttributeChange(makeCtx(schema), { columnName: 'a' }),
			StatusCode.INTERNAL,
		);
	});

	it('resolves COLLATE ahead of the other attributes', async () => {
		// The runtime guarantees exactly one attribute per statement; the order is still fixed so a
		// direct module call cannot silently apply a different one than it asked for.
		const change = await planColumnAttributeChange(
			makeCtx(schema), { columnName: 'a', setCollation: 'nocase', setNotNull: true },
		);
		expect(change!.newCol.collation).to.equal('NOCASE');
		expect(change!.newCol.notNull).to.equal(false);
	});
});

describe('alter column: effective-row scan atomicity', () => {
	/** Rows that record each element as the consumer pulls it. */
	function* tracked(rows: Row[], visited: SqlValue[]): Iterable<Row> {
		for (const row of rows) {
			visited.push(row[0]);
			yield row;
		}
	}

	it('walks a SYNC row source to completion before yielding to the microtask queue', async () => {
		// The manager's own layered view is a sync iterable, and `scanEffectiveRows` keeps it that
		// way on purpose: an awaited row would open a gap into which a concurrent autocommit write
		// on another connection could land mid-scan (the schema-change latch serializes DDL only).
		const visited: SqlValue[] = [];
		const schema = makeSchema([TEXT_COL('a')]);
		const ctx: AlterColumnContext = {
			...makeCtx(schema),
			effectiveRows: () => tracked([['1'], ['2'], ['3']], visited),
		};

		const pending = planSetDataType(ctx, 'integer');
		expect(visited).to.deep.equal(['1', '2', '3']); // every row already walked, before any await
		await pending;
	});

	it('does NOT claim the same of an async row source', async () => {
		// The contrast that makes the guarantee above meaningful: an async source suspends part-way
		// through the walk (the generator body runs eagerly up to its first `yield`, then parks), so
		// the scan is interleavable. Wrapper modules supplying one have no base-tree atomicity to lose.
		const visited: SqlValue[] = [];
		const schema = makeSchema([TEXT_COL('a')]);
		async function* stream(): AsyncIterable<Row> {
			for (const row of [['1'], ['2'], ['3']] as Row[]) {
				visited.push(row[0]);
				yield row;
			}
		}
		const pending = planSetDataType({ ...makeCtx(schema), effectiveRows: stream }, 'integer');
		expect(visited).to.deep.equal(['1']); // parked at the first yield, two rows still unwalked
		await pending;
		expect(visited).to.deep.equal(['1', '2', '3']);
	});
});

describe('alter column: buildAlterColumnPlan', () => {
	const changeOf = (newCol: ColumnSchema, over: Partial<ColumnAttributeChange> = {}): ColumnAttributeChange =>
		({ newCol, collationChanged: false, comparatorChanged: false, rewrite: null, ...over });

	it('freezes the post-change schema and rebuilds the column index map', () => {
		const schema = makeSchema([TEXT_COL('a'), TEXT_COL('b')]);
		const plan = buildAlterColumnPlan(schema, 1, changeOf(TEXT_COL('b', { notNull: true })));
		expect(Object.isFrozen(plan.newSchema)).to.equal(true);
		expect(Object.isFrozen(plan.newSchema.columns)).to.equal(true);
		expect(plan.newSchema.columns[1].notNull).to.equal(true);
		expect(plan.newSchema.columns[0]).to.equal(schema.columns[0]); // untouched columns keep identity
		expect(plan.newSchema.columnIndexMap.get('b')).to.equal(1);
		expect(plan.structuresRekeyed).to.equal(false);
		expect(plan.pkColumnRekeyed).to.equal(false);
		expect(plan.newSchema.indexes).to.equal(schema.indexes);
	});

	it('propagates a collation change into the PK definition and index columns', () => {
		const schema = makeSchema([TEXT_COL('a'), TEXT_COL('b')], {
			primaryKeyDefinition: [{ index: 0, collation: 'BINARY' }],
			indexes: [{ name: 'ix', columns: [{ index: 0, collation: 'BINARY' }, { index: 1 }] }],
		});
		const newCol = TEXT_COL('a', { collation: 'NOCASE', collationExplicit: true });
		const plan = buildAlterColumnPlan(schema, 0, changeOf(newCol, { collationChanged: true }));

		expect(plan.structuresRekeyed).to.equal(true);
		expect(plan.pkColumnRekeyed).to.equal(true);
		expect(plan.newSchema.primaryKeyDefinition[0].collation).to.equal('NOCASE');
		expect(plan.newSchema.indexes![0].columns[0].collation).to.equal('NOCASE');
		expect(plan.newSchema.indexes![0].columns[1].collation).to.equal(undefined);
		// Fresh IndexSchema objects are the discriminator `TransactionLayer.adoptSchema` keys off.
		expect(plan.newSchema.indexes![0]).to.not.equal(schema.indexes![0]);
	});

	it('re-keys the structures for a comparator move without touching collations or the primary tree', () => {
		const schema = makeSchema([TEXT_COL('a')], {
			primaryKeyDefinition: [{ index: 0 }],
			indexes: [{ name: 'ix', columns: [{ index: 0 }] }],
		});
		const newCol = TEXT_COL('a', { logicalType: INTEGER_TYPE });
		const plan = buildAlterColumnPlan(schema, 0, changeOf(newCol, { comparatorChanged: true }));

		expect(plan.structuresRekeyed).to.equal(true);
		expect(plan.pkColumnRekeyed).to.equal(false); // primary-tree re-key belongs to SET COLLATE alone
		expect(plan.newSchema.primaryKeyDefinition).to.equal(schema.primaryKeyDefinition);
		expect(plan.newSchema.indexes![0]).to.not.equal(schema.indexes![0]);
	});

	it('leaves pkColumnRekeyed false when the re-keyed column is not a key member', () => {
		const schema = makeSchema([TEXT_COL('a'), TEXT_COL('b')], { primaryKeyDefinition: [{ index: 1 }] });
		const newCol = TEXT_COL('a', { collation: 'NOCASE', collationExplicit: true });
		const plan = buildAlterColumnPlan(schema, 0, changeOf(newCol, { collationChanged: true }));
		expect(plan.structuresRekeyed).to.equal(true);
		expect(plan.pkColumnRekeyed).to.equal(false);
	});

	it('carries the rewrite through to the plan', () => {
		const schema = makeSchema([TEXT_COL('a')]);
		const rewrite = { convert: (v: SqlValue) => v, convertNulls: true };
		const plan = buildAlterColumnPlan(schema, 0, changeOf(TEXT_COL('a'), { rewrite }));
		expect(plan.rewrite).to.equal(rewrite);
		expect(plan.colIndex).to.equal(0);
	});
});
