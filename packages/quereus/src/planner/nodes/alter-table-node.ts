import type { Scope } from '../scopes/scope.js';
import { VoidNode, type PhysicalProperties, type ScalarPlanNode, type RowDescriptor } from './plan-node.js';
import { PlanNodeType } from './plan-node-type.js';
import type { TableReferenceNode } from './reference.js';
import type * as AST from '../../parser/ast.js';
import type { SqlValue } from '../../common/types.js';
import type { LogicalType } from '../../types/logical-type.js';

/**
 * The per-row backfill of an ADD COLUMN that carries a per-row value source: a DEFAULT
 * that does not fold to a literal (e.g. `new.<col>`), or a GENERATED ALWAYS AS
 * expression. `node` is that expression compiled against the table's existing columns as
 * the "supplied" row; `rowDescriptor` maps those fresh attribute ids to existing-row
 * positions. The emitter installs a row slot over each existing row and evaluates `node`
 * to produce that row's value for the new column. A literal DEFAULT folds and is
 * bulk-written by the module instead, so it carries no backfill node; a generated column
 * always carries one, since it has no `defaultValue` for the module to write.
 */
export interface AddColumnBackfill {
	readonly node: ScalarPlanNode;
	readonly rowDescriptor: RowDescriptor;
	/**
	 * The new column's logical type, applied to each evaluated value so a backfilled cell
	 * matches what an INSERT under the same DEFAULT / GENERATED ALWAYS AS would store.
	 * Undefined when the expression's static type already IS that type — conversion is
	 * skipped there, exactly as
	 * {@link import('../../types/validation.js').buildRowCoercion} skips an identity match,
	 * because re-converting is destructive for some types: JSON's `parse` reads a plain JS
	 * string as JSON *source*, so re-parsing an already-stored JSON value either changes it
	 * (stored text `9` becomes the number 9) or throws (stored text `abc` is not valid JSON).
	 * `add column k json default (new.j)` over an existing `json` column is exactly that case.
	 */
	readonly coerceTo?: LogicalType;
}

/**
 * Per-row CHECK enforcement for an ADD COLUMN that backfills per row (a non-foldable
 * DEFAULT such as `new.<col>`, or a GENERATED ALWAYS AS expression). Each predicate is
 * compiled against a row scope covering the
 * existing columns plus the new column; `rowDescriptor` maps those attribute ids to
 * positions (existing columns at their index, the new column at `existingColumns.length`).
 * The emitter feeds each backfilled row's `[...existingRow, newValue]` into the scope and
 * throws on a violation, so a CHECK-violating backfilled row aborts the ALTER before any
 * tree/batch swap (mirrors the NOT NULL per-row path). `exprText` / `name` are for the
 * error message. A literal/folded default carries no `checks`; the post-backfill scan
 * (`validateBackfillAgainstChecks`) covers that path instead.
 */
export interface AddColumnCheck {
	readonly predicates: ReadonlyArray<{ readonly node: ScalarPlanNode; readonly name?: string; readonly exprText: string }>;
	readonly rowDescriptor: RowDescriptor;
}

/**
 * Discriminated union of ALTER TABLE actions handled by AlterTableNode.
 * addConstraint is handled separately by AddConstraintNode.
 */
export type AlterTableAction =
	| { type: 'renameTable'; newName: string }
	| { type: 'renameColumn'; oldName: string; newName: string }
	| { type: 'addColumn'; column: AST.ColumnDef; backfill?: AddColumnBackfill; checks?: AddColumnCheck }
	| { type: 'dropColumn'; name: string }
	| {
		/**
		 * DROP CONSTRAINT — remove a named table-level constraint (CHECK / UNIQUE /
		 * FOREIGN KEY). Schema-catalog operation routed through `module.alterTable`
		 * so persistent modules re-persist the DDL. Dropping a UNIQUE may also tear
		 * down its implicit covering index (see runtime emitter).
		 */
		type: 'dropConstraint';
		name: string;
	}
	| {
		/**
		 * RENAME CONSTRAINT — name-level rename of a named table-level constraint.
		 * Schema-catalog operation routed through `module.alterTable`.
		 */
		type: 'renameConstraint';
		oldName: string;
		newName: string;
	}
	| { type: 'alterPrimaryKey'; columns: Array<{ name: string; direction?: 'asc' | 'desc' }> }
	| {
		type: 'alterColumn';
		columnName: string;
		setNotNull?: boolean;
		setDataType?: string;
		setDefault?: AST.Expression | null;
		/**
		 * SET COLLATE <name> — change the column's collation. Routed through
		 * `module.alterTable` so a backing module re-keys / re-sorts any PK / UNIQUE
		 * / index that orders by the column and re-validates uniqueness under the new
		 * collation. Unlike tags, collation is real schema (moves the schema hash).
		 */
		setCollation?: string;
	}
	| {
		/**
		 * SET TAGS / ADD TAGS — catalog-only metadata-tag mutation on the table, a
		 * column, or a named table-level constraint. `mode` selects the semantics:
		 * `'replace'` (SET TAGS) swaps the whole set (`tags` empty = clear);
		 * `'merge'` (ADD TAGS) overlays the listed keys onto the current set
		 * (`tags` empty = no-op). No module round-trip (see runtime emitter).
		 */
		type: 'setTags';
		target:
			| { kind: 'table' }
			| { kind: 'column'; columnName: string }
			| { kind: 'constraint'; constraintName: string };
		mode: 'replace' | 'merge';
		tags: Record<string, SqlValue>;
	}
	| {
		/**
		 * DROP TAGS — catalog-only per-key deletion of metadata tags on the table, a
		 * column, or a named table-level constraint. `keys` is the bare list of keys
		 * to remove. Atomic: every listed key must be present, else NOTFOUND names the
		 * missing key(s) and nothing is dropped. Dropping the last key(s) leaves
		 * `tags IS NULL`; an empty list is a no-op. No value validation (a reserved
		 * key may be dropped). No module round-trip (see runtime emitter).
		 */
		type: 'dropTags';
		target:
			| { kind: 'table' }
			| { kind: 'column'; columnName: string }
			| { kind: 'constraint'; constraintName: string };
		keys: string[];
	}
	| {
		/**
		 * SET MAINTAINED [(cols)] AS <body> — attach a derivation to a plain table,
		 * or atomically replace the derivation of an already-maintained table. The
		 * optional `columns` rename list (present ⇒ explicit/positional) renames the
		 * body outputs positionally and reshapes (renames) the backing in place on a
		 * same-arity name drift; absent ⇒ the implicit form, where a body whose
		 * derived shape differs reshapes the backing to follow the body's natural
		 * names — now also over a prior-explicit record. The runtime helper then
		 * reconciles the table's current contents against the derived contents by
		 * keyed diff (derived content wins). See
		 * `runtime/emit/materialized-view-helpers.ts` attachMaintainedDerivation.
		 */
		type: 'setMaintained';
		columns?: ReadonlyArray<string>;
		/** Derivation body — any relation-producing QueryExpr; carries its own
		 *  trailing `with defaults (…)` clause ({@link AST.SelectStmt.defaults}). */
		select: AST.QueryExpr;
	}
	| {
		/**
		 * DROP MAINTAINED — detach the table's derivation. Catalog-only: the table
		 * keeps its rows, row-time maintenance stops, and the table becomes an
		 * ordinary user-writable table.
		 */
		type: 'dropMaintained';
	};

/**
 * Plan node for ALTER TABLE operations (rename table/column, add/drop column).
 * Constraint additions are handled by the separate AddConstraintNode.
 */
export class AlterTableNode extends VoidNode {
	override readonly nodeType = PlanNodeType.AlterTable;

	constructor(
		scope: Scope,
		public readonly table: TableReferenceNode,
		public readonly action: AlterTableAction,
		/**
		 * Canonical, fully-qualified SQL of the whole statement, rendered at plan-build
		 * time from the resolved table reference (see `buildAlterTableStmt`). The runtime
		 * arms thread it to `module.alterTable` / `module.renameTable` as
		 * `SchemaChangeInfo.ddl` and onto the public schema-change event, so the
		 * announcement carries the text a peer re-executes to reproduce the change.
		 */
		public readonly sql: string,
	) {
		super(scope);
	}

	override getRelations(): readonly [TableReferenceNode] {
		return [this.table];
	}

	override toString(): string {
		switch (this.action.type) {
			case 'renameTable':
				return `ALTER TABLE RENAME TO ${this.action.newName}`;
			case 'renameColumn':
				return `ALTER TABLE RENAME COLUMN ${this.action.oldName} TO ${this.action.newName}`;
			case 'addColumn':
				return `ALTER TABLE ADD COLUMN ${this.action.column.name}`;
			case 'dropColumn':
				return `ALTER TABLE DROP COLUMN ${this.action.name}`;
			case 'dropConstraint':
				return `ALTER TABLE DROP CONSTRAINT ${this.action.name}`;
			case 'renameConstraint':
				return `ALTER TABLE RENAME CONSTRAINT ${this.action.oldName} TO ${this.action.newName}`;
			case 'alterPrimaryKey':
				return `ALTER TABLE ALTER PRIMARY KEY (${this.action.columns.map(c => c.name).join(', ')})`;
			case 'alterColumn':
				return `ALTER TABLE ALTER COLUMN ${this.action.columnName}`;
			case 'setTags': {
				const target = this.action.target;
				const verb = this.action.mode === 'merge' ? 'ADD TAGS' : 'SET TAGS';
				if (target.kind === 'column') return `ALTER TABLE ALTER COLUMN ${target.columnName} ${verb}`;
				if (target.kind === 'constraint') return `ALTER TABLE ALTER CONSTRAINT ${target.constraintName} ${verb}`;
				return `ALTER TABLE ${verb}`;
			}
			case 'dropTags': {
				const target = this.action.target;
				if (target.kind === 'column') return `ALTER TABLE ALTER COLUMN ${target.columnName} DROP TAGS`;
				if (target.kind === 'constraint') return `ALTER TABLE ALTER CONSTRAINT ${target.constraintName} DROP TAGS`;
				return `ALTER TABLE DROP TAGS`;
			}
			case 'setMaintained':
				return this.action.columns?.length
					? `ALTER TABLE SET MAINTAINED (${this.action.columns.join(', ')})`
					: `ALTER TABLE SET MAINTAINED`;
			case 'dropMaintained':
				return `ALTER TABLE DROP MAINTAINED`;
		}
	}

	override getLogicalAttributes(): Record<string, unknown> {
		return {
			table: this.table.tableSchema.name,
			schema: this.table.tableSchema.schemaName,
			actionType: this.action.type,
			...this.action,
		};
	}

	override computePhysical(_children: readonly PhysicalProperties[]): Partial<PhysicalProperties> {
		return { readonly: false };
	}
}
