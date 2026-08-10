import type { TableSchema, UniqueConstraintSchema } from '../schema/table.js';
import type { ColumnSchema } from '../schema/column.js';
import { normalizeCollationName } from '../util/comparison.js';
import type { RelationType, ColumnDef, ScalarType, ColRef } from '../common/datatype.js';
import { StatusCode, type DeepReadonly, type SqlValue } from '../common/types.js';
import type { AstNode } from '../parser/ast.js';
import { QuereusError } from '../common/errors.js';
import { inferLogicalTypeFromValue } from '../common/type-inference.js';

/**
 * Converts a TableSchema (from src/schema/table.ts) to a RelationType (from src/common/datatype.ts).
 * This is used by PlanNodes that source data directly from a base table.
 */
export function relationTypeFromTableSchema(tableSchema: TableSchema): RelationType {
  const columnDefs: ColumnDef[] = tableSchema.columns.map((col: ColumnSchema) => columnSchemaToDef(col.name, col));

  // Populate keys from primaryKeyDefinition and unique constraints
  const keys: ColRef[][] = [];
  if (tableSchema.primaryKeyDefinition && tableSchema.primaryKeyDefinition.length > 0) {
    const primaryKey: ColRef[] = tableSchema.primaryKeyDefinition.map(pkCol => ({
      index: pkCol.index,
      desc: pkCol.desc,
    }));
    keys.push(primaryKey);
  }

  // Add unique constraints as additional keys, but only when all constrained
  // columns are NOT NULL. SQL UNIQUE allows multiple NULLs, so a nullable
  // UNIQUE column is not a true key for DISTINCT elimination purposes.
  // Partial UNIQUE constraints (those with a `predicate`, synthesized from
  // `CREATE UNIQUE INDEX ... WHERE ...`) only guarantee uniqueness within
  // the partial scope, so they cannot be promoted to relation-level keys —
  // doing so would let the FD layer derive `K → all-other-cols` over the
  // whole table and silently break DISTINCT/GROUP BY/ORDER BY/join-elimination
  // for rows outside the scope. Partial UCs are instead routed through
  // `planner/analysis/partial-unique-extraction.ts`, which emits *guarded* FDs
  // that Filter activation discharges when a surrounding predicate entails
  // the partial WHERE.
  if (tableSchema.uniqueConstraints) {
    for (const uc of tableSchema.uniqueConstraints) {
      if (uc.predicate !== undefined) continue;
      const allNotNull = uc.columns.every(idx => tableSchema.columns[idx]?.notNull);
      if (allNotNull && enforcementCollationCoversDeclared(tableSchema, uc)) {
        keys.push(uc.columns.map(idx => ({ index: idx })));
      }
    }
  }

  return {
    typeClass: 'relation',
    isReadOnly: !!(tableSchema.isView || tableSchema.isReadOnly),
    isSet: true, // Base tables are sets by definition (enforced by primary keys)
    columns: columnDefs,
    keys: keys,
    // TODO: Populate rowConstraints from tableSchema if/when RelationType supports them
    rowConstraints: [], // Placeholder
  };
}

/**
 * A unique constraint may only be promoted to a relation-level key when its
 * *enforcement* collation per column is at least as coarse as the column's
 * declared (output) collation. A relation key claims "no two rows agree on the
 * key tuple under the **output** collations" (consumers — DISTINCT
 * elimination, MV backing PKs — interpret it that way), while the constraint
 * only forbids rows that agree under the *enforcement* collation. The claim
 * follows iff output-equality implies enforcement-equality.
 *
 * Enforcement collation by constraint source:
 *  - table-level `UNIQUE (...)` / column `UNIQUE`: the declared column
 *    collation (the memory layer manager compares with
 *    `schema.columns[col].collation`) — always equal, no gate needed.
 *  - `derivedFromIndex` (CREATE UNIQUE INDEX): the index's per-column
 *    collation, which `(col COLLATE x)` can set FINER than the declared one —
 *    e.g. a BINARY unique index over a NOCASE column stores both 'Bob' and
 *    'bob', which are one key value under the NOCASE output collation. Such a
 *    constraint is real but is NOT a key for output-collation consumers, so
 *    it is skipped here (a sound under-claim).
 *
 * Decidable sound cases: enforcement equals declared, or declared is BINARY
 * (BINARY-equal rows are identical values, hence equal under any enforcement
 * collation). The PK needs no gate: `findPKDefinition` copies the declared
 * column collation into the PK definition, so PK enforcement is always the
 * declared collation. (Ticket `collation-blind-equality-fact-extraction`.)
 */
function enforcementCollationCoversDeclared(
  tableSchema: TableSchema,
  uc: UniqueConstraintSchema,
): boolean {
  if (!uc.derivedFromIndex) return true;
  const index = tableSchema.indexes?.find(i => i.name === uc.derivedFromIndex);
  if (!index) return true; // no index metadata survived — declared-collation enforcement
  return index.columns.every(ic => {
    const declared = normalizeCollationName(tableSchema.columns[ic.index]?.collation ?? 'BINARY');
    if (declared === 'BINARY') return true;
    return normalizeCollationName(ic.collation ?? declared) === declared;
  });
}

/**
 * Creates a ScalarType for a given SqlValue, typically for parameters.
 * @param value The SqlValue to determine the type for.
 * @returns A ScalarType representing the inferred type of the value.
 */
export function getParameterScalarType(value: SqlValue): ScalarType {
  const logicalType = inferLogicalTypeFromValue(value);

  return {
    typeClass: 'scalar',
    logicalType,
    nullable: true,	// No guarantees about the value, so it's nullable
    isReadOnly: true, // Parameters are read-only within the query execution context
  };
}

export function checkColumnsAssignable(source: DeepReadonly<ColumnDef[]>, target: DeepReadonly<ColumnDef[]>, astNode?: AstNode): void {
	if (source.length !== target.length) {
		throw new QuereusError(`Column count mismatch ${(astNode ? astNode.type + ' clause' : '')}.`, StatusCode.ERROR, undefined, astNode?.loc?.start.line, astNode?.loc?.start.column);
	}
}

export function checkRelationsAssignable(source: RelationType, target: RelationType, astNode?: AstNode): void {
	return checkColumnsAssignable(source.columns, target.columns, astNode);
}

/**
 * Builds a ScalarType from a ColumnSchema, always threading the column's
 * declared collation so expressions compiled over a table's row image
 * (CHECK scopes, defaults, RETURNING, mutation OLD/NEW attributes, view
 * write decomposition) resolve collations identically to a read-path query.
 *
 * `overrides.nullable` defaults to `!col.notNull`; pass `true` for row images
 * where every column may be NULL (e.g. OLD on INSERT, NEW on DELETE).
 * `overrides.isReadOnly` defaults to `false`.
 */
export function columnSchemaToScalarType(
	col: ColumnSchema,
	overrides?: { nullable?: boolean; isReadOnly?: boolean },
): ScalarType {
	return {
		typeClass: 'scalar',
		logicalType: col.logicalType,
		collationName: col.collation,
		// Provenance drives comparison-collation resolution: an explicit
		// `COLLATE` clause outranks a defaulted collation (session default,
		// store-module reconcile, engine BINARY).
		collationSource: col.collationExplicit ? 'declared' : 'default',
		nullable: overrides?.nullable ?? !col.notNull,
		isReadOnly: overrides?.isReadOnly ?? false,
	};
}

export function columnSchemaToDef(colName: string, colDef: ColumnSchema): ColumnDef {
	return {
		name: colName,
		type: columnSchemaToScalarType(colDef),
		generated: colDef.generated,
	};
}
