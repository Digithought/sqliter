import type { Expression } from '../parser/ast.js';
import type { LogicalType } from '../types/logical-type.js';
import type { SqlValue } from '../common/types.js';
import type { ConflictResolution } from '../common/constants.js';
import { TEXT_TYPE } from '../types/builtin-types.js';

/**
 * Represents the schema definition of a single column in a table.
 */
export interface ColumnSchema {
	/** Column name */
	name: string;
	/** Logical type definition */
	logicalType: LogicalType;
	/** Whether the column has a NOT NULL constraint */
	notNull: boolean;
	/** Whether the column is part of the primary key */
	primaryKey: boolean;
	/** Order within the primary key (1-based) or 0 if not PK */
	pkOrder: number;
	/** Default value expression */
	defaultValue: Expression | null;
	/** Declared collation sequence name (e.g., "BINARY", "NOCASE", "RTRIM") */
	collation: string;
	/**
	 * Whether `collation` is user-declared (true) rather than an implicit default
	 * (undefined). Set by a CREATE-time explicit `COLLATE` clause AND by
	 * `ALTER COLUMN ... SET COLLATE` (which carries the same standing as a declared
	 * clause, incl. `SET COLLATE binary`) — so the flag reflects the current catalog
	 * column, not its creation history. Lets a module distinguish a user-declared
	 * collation from the default — e.g. the store module keys an *explicit* per-column
	 * PK collation natively but applies its own table-level default collation to an
	 * *implicit*-default text PK column; the comparison lattice ranks an explicit
	 * collation (rank 2 'declared') above a defaulted one (rank 1 'default'). Purely
	 * informational; absent ⇒ implicit. NOT persisted as a distinct bit: persisted DDL
	 * is fully explicit (an explicit `COLLATE` for any non-BINARY collation, BINARY
	 * elided), so a defaulted non-BINARY collation reloads as `collationExplicit: true`
	 * and a defaulted/explicit BINARY both reload as implicit — see docs/types.md.
	 */
	collationExplicit?: boolean;
	/** Whether the column is generated (GENERATED ALWAYS AS) */
	generated: boolean;
	/** AST expression for generated columns */
	generatedExpr?: Expression;
	/** Whether the generated value is stored (true) or virtual/computed on read (false) */
	generatedStored?: boolean;
	/**
	 * Sort direction for primary key ('asc' | 'desc').
	 *
	 * NOTE: only ONE authoring form populates this — an inline `a integer primary key desc`
	 * column constraint. A table-level `primary key (a desc)` records the direction on
	 * `TableSchema.primaryKeyDefinition` and leaves this `undefined`, and
	 * `rekeySchemaPrimaryKey` (the shared ALTER PRIMARY KEY mutation) deliberately does not
	 * write it either. So for the table-level and post-ALTER shapes,
	 * `buildConstraintsFromColumn` (`runtime/emit/alter-table.ts`, the `RENAME COLUMN`
	 * AST rebuild) emits `direction: undefined` for a genuinely descending key. Harmless
	 * today because every consumer reads `primaryKeyDefinition.desc`; if a module is ever
	 * added that rebuilds its key from that reconstructed `ColumnDef`, a `desc` key would
	 * silently flip ascending.
	 */
	pkDirection?: 'asc' | 'desc';
	/**
	 * Default conflict resolution declared at the column level for this column's
	 * NOT NULL / PK constraint (e.g., `name TEXT NOT NULL ON CONFLICT IGNORE`).
	 * Statement-level OR clauses override this; if both are absent the action is ABORT.
	 */
	defaultConflict?: ConflictResolution;
	/** Arbitrary metadata tags (informational only, does not affect behavior or hashing) */
	tags?: Readonly<Record<string, SqlValue>>;
	/**
	 * Raw declared type token verbatim from the DDL (e.g. 'BIGINT', 'TIMESTAMP'), before
	 * {@link logicalType} flattening collapses it onto a shared logical type (e.g. both
	 * map to INTEGER). Informational only — not hashed, not compared, not read anywhere in
	 * Quereus; exists so an external host can recover the distinction the flattened
	 * `logicalType` erases. Absent when the column def had no declared type.
	 */
	declaredType?: string;
}

/**
 * Creates a default ColumnSchema with basic properties
 * Following Third Manifesto principles, columns default to NOT NULL unless explicitly specified otherwise
 *
 * @param name The name for the column
 * @param defaultNotNull Whether columns should be NOT NULL by default (defaults to true for Third Manifesto compliance)
 * @returns A new column schema with default values
 */
export function createDefaultColumnSchema(name: string, defaultNotNull: boolean = true): ColumnSchema {
	return {
		name: name,
		logicalType: TEXT_TYPE,
		notNull: defaultNotNull, // Third Manifesto: default to NOT NULL
		primaryKey: false,
		pkOrder: 0,
		defaultValue: null,
		collation: 'BINARY', // SQLite's default
		generated: false,
	};
}
