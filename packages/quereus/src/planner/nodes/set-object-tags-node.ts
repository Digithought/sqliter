import { PhysicalProperties, VoidNode } from './plan-node.js';
import { PlanNodeType } from './plan-node-type.js';
import type { Scope } from '../scopes/scope.js';
import type { SqlValue } from '../../common/types.js';

/** The tagged catalog object kinds addressable by `ALTER … {SET|ADD|DROP} TAGS`. */
export type SetObjectTagsKind = 'view' | 'materializedView' | 'index';

/**
 * The metadata-tag mutation an {@link SetObjectTagsNode} carries, mirroring the
 * ALTER TABLE primitives:
 *   - `replace` (SET TAGS): whole-set replacement; empty `tags` clears.
 *   - `merge` (ADD TAGS): per-key merge; empty `tags` is a no-op.
 *   - `drop` (DROP TAGS): per-key delete; atomic; empty `keys` is a no-op.
 */
export type SetObjectTagsMutation =
	| { op: 'replace' | 'merge'; tags: Record<string, SqlValue> }
	| { op: 'drop'; keys: readonly string[] };

/**
 * Plan node for `ALTER VIEW / MATERIALIZED VIEW / INDEX … {SET|ADD|DROP} TAGS` —
 * a catalog-only mutation of an object's metadata tags. No module / data
 * round-trip: the emitter dispatches on `objectKind × mutation.op` to the
 * matching SchemaManager setter, which swaps the in-memory schema object and
 * (for indexes) fires `table_modified` on the owning table.
 */
export class SetObjectTagsNode extends VoidNode {
	override readonly nodeType = PlanNodeType.SetObjectTags;

	constructor(
		scope: Scope,
		public readonly objectKind: SetObjectTagsKind,
		public readonly schemaName: string,
		public readonly name: string,
		public readonly mutation: SetObjectTagsMutation,
	) {
		super(scope, 1); // Low cost for DDL operations
	}

	override toString(): string {
		const objVerb = this.objectKind === 'materializedView' ? 'MATERIALIZED VIEW' : this.objectKind.toUpperCase();
		const tagVerb = this.mutation.op === 'merge' ? 'ADD TAGS' : this.mutation.op === 'drop' ? 'DROP TAGS' : 'SET TAGS';
		return `ALTER ${objVerb} ${this.schemaName}.${this.name} ${tagVerb}`;
	}

	override getLogicalAttributes(): Record<string, unknown> {
		return {
			objectKind: this.objectKind,
			schemaName: this.schemaName,
			name: this.name,
			op: this.mutation.op,
			...(this.mutation.op === 'drop' ? { keys: this.mutation.keys } : { tags: this.mutation.tags }),
		};
	}

	override computePhysical(_children: readonly PhysicalProperties[]): Partial<PhysicalProperties> {
		return { readonly: false };
	}
}
