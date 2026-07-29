import type { Expression } from '../../../parser/ast.js';
import type { ColumnSchema } from '../../../schema/column.js';
import { buildColumnIndexMap, validateCollationForType, type TableSchema } from '../../../schema/table.js';
import { StatusCode, type SqlValue } from '../../../common/types.js';
import { QuereusError } from '../../../common/errors.js';
import { tryFoldLiteral } from '../../../parser/utils.js';
import { inferType } from '../../../types/registry.js';
import { validateAndParse } from '../../../types/validation.js';
import { comparisonSemanticsDiffer } from '../../../util/comparison.js';
import type { Row } from '../../../common/types.js';

/**
 * The decide-and-validate half of `MemoryTableManager.alterColumn`.
 *
 * Everything here is a function of the PRE-change {@link TableSchema} plus the DDL
 * transaction's effective rows. It may THROW — that is how an illegal ALTER is rejected —
 * but it never mutates the manager, the base layer, or any open transaction layer. That
 * split is the "validate before any mutation" guarantee the ALTER paths depend on: the
 * manager runs every function in this file (plus its own re-keyed UNIQUE / primary-key
 * probes) before its first write, so a rejection leaves the table exactly as it was.
 *
 * The apply half — base rebuild, open-layer propagation, rollback — stays on the manager,
 * which owns that state.
 */

/** The single-attribute change one `alter column` statement asks for. */
export interface AlterColumnChange {
	columnName: string;
	setNotNull?: boolean;
	setDataType?: string;
	setDefault?: Expression | null;
	setCollation?: string;
}

/**
 * A physical rewrite of every stored value in the altered column: `set data type` (every
 * non-alias retype — values normalize to the new type's canonical spelling even when the
 * storage class is unchanged) and the `set not null` null → DEFAULT backfill.
 *
 * The manager applies it by REPLACING the base primary tree with a freshly-built one (never
 * an in-place mutation, which inheritree forbids while the open transaction's layers derive
 * from it) and converting the transaction's own-written rows in every open layer.
 */
export interface ValueRewrite {
	readonly convert: (v: SqlValue) => SqlValue;
	/**
	 * Route NULLs through `convert` too. Set by the `set not null` backfill (null → DEFAULT);
	 * `set data type` leaves nulls untouched.
	 */
	readonly convertNulls: boolean;
}

/** What one attribute handler decided: the column schema it produces, plus its consequences. */
export interface ColumnAttributeChange {
	readonly newCol: ColumnSchema;
	/**
	 * The collation NAME moved, which re-keys any PK / UNIQUE / index that orders by this
	 * column — so the structures need the re-sort + uniqueness re-validation. False for a
	 * metadata-only `set collate` that merely marks an already-matching collation explicit.
	 */
	readonly collationChanged: boolean;
	/**
	 * A `set data type` moved to a type that ORDERS values differently
	 * ({@link comparisonSemanticsDiffer}). Same consequence as a collation change — every
	 * structure keyed by the column has to be re-sorted and its uniqueness re-judged — but a
	 * separate flag, because the index-column collation propagation and the primary-tree
	 * re-key belong to `set collate` alone. Usually coincides with {@link rewrite} (every
	 * non-alias retype sets that), whose full-rebuild path subsumes the comparator-only re-sort.
	 */
	readonly comparatorChanged: boolean;
	/** Set when the stored values themselves must be rewritten; null for a schema-only change. */
	readonly rewrite: ValueRewrite | null;
}

/** {@link ColumnAttributeChange} resolved against the table: post-change schema + rebuild consequences. */
export interface AlterColumnPlan {
	readonly colIndex: number;
	readonly newSchema: TableSchema;
	readonly rewrite: ValueRewrite | null;
	/**
	 * The comparators the structures are keyed by moved: `set collate` (values untouched) or a
	 * retype into a differently-ordering type (which, unless it is an alias retype, ALSO sets
	 * {@link rewrite}, whose full-rebuild path subsumes the comparator-only re-sort).
	 */
	readonly structuresRekeyed: boolean;
	/** `set collate` moved a PRIMARY KEY member's collation — the primary tree itself re-keys. */
	readonly pkColumnRekeyed: boolean;
}

/**
 * The DDL transaction's EFFECTIVE rows: committed rows overlaid with its own pending writes. A
 * value the transaction can SEE rejects the ALTER; one only in a row it has DELETED does not block
 * it. Re-callable — each scan gets a fresh stream.
 *
 * Either flavour: the manager's own layered walk is synchronous, a wrapper module's overlay (the
 * isolation layer) is an `EffectiveRowSource` and therefore async. {@link scanEffectiveRows} keeps
 * the sync one sync.
 */
export type EffectiveRows = () => Iterable<Row> | AsyncIterable<Row>;

/** Everything the attribute handlers read beyond the change itself. */
export interface AlterColumnContext {
	readonly schema: TableSchema;
	readonly tableName: string;
	/** The column name as the statement spelled it — error messages echo it verbatim. */
	readonly columnName: string;
	readonly colIndex: number;
	readonly effectiveRows: EffectiveRows;
	readonly isCollationRegistered: (name: string) => boolean;
}

/**
 * Visit the effective rows until `visit` returns true — which stops the scan and is the result.
 * `visit` may also THROW to reject the ALTER outright.
 *
 * Branches on the source's flavour rather than routing everything through `for await`: the
 * manager's own layered walk is synchronous, and awaiting it per row would open a microtask gap
 * mid-scan into which a concurrent autocommit write on another connection could land, since the
 * schema-change latch serializes DDL only. An overlay supplied by a wrapper module is genuinely
 * async and has no such atomicity to lose.
 */
async function scanEffectiveRows(ctx: AlterColumnContext, visit: (row: Row) => boolean): Promise<boolean> {
	const source = ctx.effectiveRows();
	if (Symbol.asyncIterator in source) {
		for await (const row of source) {
			if (visit(row)) return true;
		}
	} else {
		for (const row of source) {
			if (visit(row)) return true;
		}
	}
	return false;
}

/** A change that rewrites no stored value and re-keys no structure — schema metadata only. */
function metadataOnly(newCol: ColumnSchema): ColumnAttributeChange {
	return { newCol, collationChanged: false, comparatorChanged: false, rewrite: null };
}

const isPrimaryKeyColumn = (ctx: AlterColumnContext): boolean =>
	ctx.schema.primaryKeyDefinition.some(def => def.index === ctx.colIndex);

/**
 * Resolve the one populated attribute in `change`. Returns null when the column is already in
 * the requested state — a no-op ALTER the manager returns from without touching anything.
 */
export async function planColumnAttributeChange(
	ctx: AlterColumnContext,
	change: AlterColumnChange,
): Promise<ColumnAttributeChange | null> {
	if (change.setCollation !== undefined) return planSetCollation(ctx, change.setCollation);
	if (change.setNotNull !== undefined) return planSetNotNull(ctx, change.setNotNull);
	if (change.setDataType !== undefined) return planSetDataType(ctx, change.setDataType);
	if (change.setDefault !== undefined) return metadataOnly({ ...ctx.schema.columns[ctx.colIndex], defaultValue: change.setDefault });
	throw new QuereusError('ALTER COLUMN requires an attribute to change', StatusCode.INTERNAL);
}

/**
 * `set collate`. A user declaration with the same standing as a CREATE-time COLLATE clause, so
 * the collation is marked explicit (rank 2 in the comparison lattice) regardless of the column's
 * creation history — including `set collate binary`. When only the name matches but the column
 * was not yet explicit (a defaulted collation, or one inherited from session default_collation),
 * flipping the flag is METADATA-ONLY: the collation bytes are unchanged, so the physical re-sort
 * / re-key / UNIQUE re-validation are skipped. A different name takes the full path.
 */
export function planSetCollation(ctx: AlterColumnContext, requested: string): ColumnAttributeChange | null {
	const oldCol = ctx.schema.columns[ctx.colIndex];
	const normalized = validateCollationForType(requested, oldCol.logicalType, ctx.columnName, ctx.isCollationRegistered);
	const nameMatches = normalized === (oldCol.collation || 'BINARY');
	if (nameMatches && oldCol.collationExplicit) return null; // already explicit in the desired collation

	const newCol: ColumnSchema = { ...oldCol, collation: normalized, collationExplicit: true };
	return { newCol, collationChanged: !nameMatches, comparatorChanged: false, rewrite: null };
}

/** `set not null` / `drop not null`. */
export async function planSetNotNull(ctx: AlterColumnContext, setNotNull: boolean): Promise<ColumnAttributeChange | null> {
	const oldCol = ctx.schema.columns[ctx.colIndex];
	if (setNotNull && !oldCol.notNull) return planTightenNotNull(ctx, oldCol);
	if (!setNotNull && oldCol.notNull) {
		if (isPrimaryKeyColumn(ctx)) {
			throw new QuereusError(
				`Cannot DROP NOT NULL on PRIMARY KEY column '${ctx.columnName}'`,
				StatusCode.CONSTRAINT,
			);
		}
		return metadataOnly({ ...oldCol, notNull: false });
	}
	return null; // already in the desired state
}

/**
 * `set not null` on a nullable column: scan the effective rows for NULLs, and when one is
 * visible, either reject or backfill from the column's DEFAULT.
 *
 * The backfill maps null → the folded DEFAULT literal, routed through the SAME base-replacement
 * + open-layer conversion machinery `set data type` uses — no logical-type change, no PK re-key,
 * no in-place base mutation. (An in-place `tree.upsert` backfill could not fill the transaction's
 * pending rows — they live in the pending layer, not the base — and mutated a base the open
 * layers derive from.)
 */
async function planTightenNotNull(ctx: AlterColumnContext, oldCol: ColumnSchema): Promise<ColumnAttributeChange> {
	const newCol: ColumnSchema = { ...oldCol, notNull: true };
	if (!await hasNullValue(ctx)) return metadataOnly(newCol);

	const defaultLiteral = oldCol.defaultValue ? tryFoldLiteral(oldCol.defaultValue) : undefined;
	if (defaultLiteral === undefined || defaultLiteral === null) {
		throw new QuereusError(`column ${ctx.columnName} contains NULL values`, StatusCode.CONSTRAINT);
	}

	const literal = defaultLiteral;
	return {
		newCol,
		collationChanged: false,
		comparatorChanged: false,
		rewrite: { convert: (v: SqlValue) => (v === null ? literal : v), convertNulls: true },
	};
}

/** True when any effective row holds NULL in the altered column. */
function hasNullValue(ctx: AlterColumnContext): Promise<boolean> {
	return scanEffectiveRows(ctx, row => row[ctx.colIndex] === null);
}

/**
 * `set data type`.
 *
 * Gates on logical-type IDENTITY, not the physical storage class: `inferType` flattens aliases to
 * the shared type object (`varchar(50)` IS `TEXT_TYPE`, `bigint` IS `INTEGER_TYPE`), so an alias
 * retype is schema-only — no scan, no rewrite, no re-key. Every OTHER retype validates AND
 * normalizes every value, whether or not the storage class changes: a same-class move (text →
 * date) must reject values the new type refuses ('hello') and rewrite the rest to the new type's
 * canonical spelling ('2024-06-05T00:00:00Z' → '2024-06-05'), or the column holds values no
 * INSERT could have produced — unfindable by equality (DATE compares BINARY over the stored text)
 * and invisible to UNIQUE.
 *
 * NOTE: the rewrite is unconditional once the types differ, even when every converted value comes
 * back byte-identical (already-canonical ISO durations on a text → timespan). That costs a full
 * base-tree + secondary-index rebuild, and a physical rewrite of every row on the store leg. If
 * ALTER on large tables ever shows up as slow, have the convert pre-pass record whether any value
 * actually moved and, when none did, fall through to the comparator-only re-key.
 */
export async function planSetDataType(ctx: AlterColumnContext, dataType: string): Promise<ColumnAttributeChange> {
	const oldCol = ctx.schema.columns[ctx.colIndex];
	const newLogicalType = inferType(dataType);
	const newCol: ColumnSchema = { ...oldCol, logicalType: newLogicalType };
	if (newLogicalType === oldCol.logicalType) return metadataOnly(newCol);

	// Retyping a PRIMARY KEY column moves the key bytes (a class change), the tree's ordering (a
	// comparator move), or at minimum the key values' canonical spelling — and neither the base
	// rewrite nor the transaction-layer conversion re-keys the primary tree. The engine already
	// refuses SET DATA TYPE on any PK column (runtime/emit/alter-table.ts); this guards direct
	// module calls. Reject rather than corrupt — the type-change analogue of the SET COLLATE
	// primary-key carve-out (`alter-collate-pk-in-transaction`).
	if (isPrimaryKeyColumn(ctx)) {
		throw new QuereusError(
			`Cannot change the data type of primary key column '${ctx.columnName}' of table '${ctx.tableName}'.`,
			StatusCode.CONSTRAINT,
		);
	}

	// Every MemoryIndex builds its comparator from the column's LOGICAL type
	// (`createTypedComparator(columnSchema.logicalType, …)` in vtab/memory/index.ts), so a move to
	// a differently-ordering type (text ↔ timespan: 'PT1H' ≡ 'PT60M'; text ↔ date/time/datetime:
	// binary, ignoring the column's collation) re-sorts every structure keyed by the column.
	// Tracked separately from the value rewrite because SET COLLATE shares the re-key machinery
	// without rewriting values.
	const comparatorChanged = comparisonSemanticsDiffer(oldCol.logicalType, newLogicalType);

	const convert = (v: SqlValue): SqlValue => {
		try {
			return validateAndParse(v, newLogicalType, ctx.columnName) as SqlValue;
		} catch {
			throw new QuereusError(
				`Cannot convert value in '${ctx.columnName}' to ${dataType}`,
				StatusCode.MISMATCH,
			);
		}
	};

	await assertEveryValueConverts(ctx, convert);

	return { newCol, collationChanged: false, comparatorChanged, rewrite: { convert, convertNulls: false } };
}

/**
 * Rejects the retype when any effective row holds an unconvertible value. Runs before anything is
 * mutated, so a throw leaves the schema, the base and the transaction untouched.
 */
async function assertEveryValueConverts(ctx: AlterColumnContext, convert: (v: SqlValue) => SqlValue): Promise<void> {
	await scanEffectiveRows(ctx, row => {
		const val = row[ctx.colIndex];
		if (val !== null) convert(val as SqlValue); // throws MISMATCH to reject the retype
		return false; // every row must convert — never stop early
	});
}

/**
 * Build the post-change {@link TableSchema} and the flags the apply half keys off.
 *
 * Every re-keying change REBUILDS the IndexSchema objects, because their identity is the
 * discriminator `TransactionLayer.adoptSchema` uses to decide an open layer's MemoryIndex must be
 * replaced rather than kept (an index it holds under an object the new schema still carries is
 * left alone). SET COLLATE has a field to write — the index column's own collation. A
 * comparator-only retype has none: an index column carries no logical type, it reads the column's
 * from `newSchema.columns`, so the fresh object IS the whole signal. Without it the base rebuilt
 * its trees under the new comparator while the DDL transaction's own layers went on comparing the
 * old way — and shadowed the base's rebuilt trees once the pending layer became the committed head.
 */
export function buildAlterColumnPlan(
	schema: TableSchema,
	colIndex: number,
	change: ColumnAttributeChange,
): AlterColumnPlan {
	const updatedCols = schema.columns.map((c, i) => i === colIndex ? change.newCol : c);
	const structuresRekeyed = change.collationChanged || change.comparatorChanged;

	// Propagate a collation change into every PK-definition entry and index column that orders by
	// this column, so their comparators re-key under it.
	const updatedPkDef = change.collationChanged
		? schema.primaryKeyDefinition.map(def =>
			def.index === colIndex ? { ...def, collation: change.newCol.collation } : def)
		: schema.primaryKeyDefinition;
	const updatedIndexes = (structuresRekeyed && schema.indexes)
		? schema.indexes.map(idx => ({
			...idx,
			columns: idx.columns.map(ic =>
				(ic.index === colIndex && change.collationChanged) ? { ...ic, collation: change.newCol.collation } : ic),
		}))
		: schema.indexes;

	const newSchema: TableSchema = Object.freeze({
		...schema,
		columns: Object.freeze(updatedCols),
		columnIndexMap: buildColumnIndexMap(updatedCols),
		primaryKeyDefinition: Object.freeze(updatedPkDef),
		indexes: updatedIndexes ? Object.freeze(updatedIndexes) : updatedIndexes,
	});

	return {
		colIndex,
		newSchema,
		rewrite: change.rewrite,
		structuresRekeyed,
		pkColumnRekeyed: change.collationChanged && updatedPkDef.some(def => def.index === colIndex),
	};
}
