import type * as AST from '../../parser/ast.js';
import { PhysicalProperties, VoidNode } from './plan-node.js';
import { PlanNodeType } from './plan-node-type.js';
import type { Scope } from '../scopes/scope.js';
import type { SqlValue } from '../../common/types.js';

/**
 * Plan node for CREATE MATERIALIZED VIEW. Materializes the body into a
 * maintained table (a `TableSchema` carrying a `TableDerivation`) under the
 * MV's own name. All heavy lifting (build + optimize body, derive PK, create
 * table, fill rows) happens in the emitter at runtime — this node just carries
 * the DDL. The canonical DDL text is rendered on demand from the unified
 * record, so the node carries no `sql`.
 */
export class CreateMaterializedViewNode extends VoidNode {
	readonly nodeType = PlanNodeType.CreateMaterializedView;

	constructor(
		scope: Scope,
		public readonly viewName: string,
		public readonly schemaName: string,
		public readonly ifNotExists: boolean,
		public readonly columns: string[] | undefined,
		/** Body AST — retained on the derivation for declarative emission + body-hash. */
		public readonly selectStmt: AST.QueryExpr,
		/** Canonical SQL of the body alone (re-planned at runtime to fill the backing table). */
		public readonly bodySql: string,
		public readonly tags?: Readonly<Record<string, SqlValue>>,
		/** Normalized backing-host module from `using <module>(...)`; undefined = memory default. */
		public readonly backingModuleName?: string,
		/** Backing-module args; recorded only when non-empty. */
		public readonly backingModuleArgs?: Readonly<Record<string, SqlValue>>,
	) {
		super(scope, 1); // Low cost for DDL operations
	}

	override toString(): string {
		const ifNotExistsClause = this.ifNotExists ? 'IF NOT EXISTS ' : '';
		const columnsClause = this.columns ? `(${this.columns.join(', ')})` : '';
		return `CREATE MATERIALIZED VIEW ${ifNotExistsClause}${this.schemaName}.${this.viewName}${columnsClause}`;
	}

	override getLogicalAttributes(): Record<string, unknown> {
		return {
			viewName: this.viewName,
			schemaName: this.schemaName,
			ifNotExists: this.ifNotExists,
			columns: this.columns,
			bodySql: this.bodySql,
			...(this.backingModuleName ? { backingModuleName: this.backingModuleName } : {}),
			...(this.backingModuleArgs ? { backingModuleArgs: this.backingModuleArgs } : {}),
		};
	}

	override computePhysical(_children: readonly PhysicalProperties[]): Partial<PhysicalProperties> {
		return { readonly: false };
	}
}

/**
 * Plan node for REFRESH MATERIALIZED VIEW. Re-runs the body and atomically
 * swaps the backing table's base layer.
 */
export class RefreshMaterializedViewNode extends VoidNode {
	readonly nodeType = PlanNodeType.RefreshMaterializedView;

	constructor(
		scope: Scope,
		public readonly viewName: string,
		public readonly schemaName: string
	) {
		super(scope, 1);
	}

	override toString(): string {
		return `REFRESH MATERIALIZED VIEW ${this.schemaName}.${this.viewName}`;
	}

	override getLogicalAttributes(): Record<string, unknown> {
		return { viewName: this.viewName, schemaName: this.schemaName };
	}

	override computePhysical(_children: readonly PhysicalProperties[]): Partial<PhysicalProperties> {
		return { readonly: false };
	}
}

/**
 * Plan node for DROP MATERIALIZED VIEW. Drops the backing table and removes the
 * MV from the catalog.
 */
export class DropMaterializedViewNode extends VoidNode {
	readonly nodeType = PlanNodeType.DropMaterializedView;

	constructor(
		scope: Scope,
		public readonly viewName: string,
		public readonly schemaName: string,
		public readonly ifExists: boolean
	) {
		super(scope, 1);
	}

	override toString(): string {
		const ifExistsClause = this.ifExists ? 'IF EXISTS ' : '';
		return `DROP MATERIALIZED VIEW ${ifExistsClause}${this.schemaName}.${this.viewName}`;
	}

	override getLogicalAttributes(): Record<string, unknown> {
		return { viewName: this.viewName, schemaName: this.schemaName, ifExists: this.ifExists };
	}

	override computePhysical(_children: readonly PhysicalProperties[]): Partial<PhysicalProperties> {
		return { readonly: false };
	}
}
