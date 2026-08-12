import type { SetObjectTagsNode } from '../../planner/nodes/set-object-tags-node.js';
import type { Instruction, RuntimeContext } from '../types.js';
import type { EmissionContext } from '../emission-context.js';
import { type SqlValue } from '../../common/types.js';
import { createLogger } from '../../common/logger.js';
import { withStatementScopedSchemaEvents } from './ddl-event-scope.js';

const log = createLogger('runtime:emit:set-object-tags');

/**
 * Emits `ALTER VIEW / MATERIALIZED VIEW / INDEX … {SET|ADD|DROP} TAGS`. Tags
 * touch no stored row and no physical layout, so this is a pure catalog
 * mutation: it dispatches on `objectKind × op` to the matching SchemaManager
 * setter — `replace` → `set*Tags`, `merge` → `merge*Tags`, `drop` → `drop*Tags`
 * — each of which re-registers the schema object (clearing tags on an empty set)
 * and fires the right `*_modified` event so optimizer / write-through caches
 * invalidate. Reserved-tag validation already ran at plan-build time (SET/ADD
 * only). NOTFOUND on a missing object — or a drop-of-absent key — surfaces from
 * the setter.
 *
 * NOTE: deliberately NOT covered by the `ddl_transaction_policy = 'strict'` gate
 * (see ddl-transaction-policy.ts), because it dispatches to no module — matching
 * the gate's stated scope ("module-dispatching DDL"; `create view` and friends
 * are out too). This does leave one asymmetry: `alter table t set tags` IS gated,
 * since the ALTER emitter gates every arm uniformly rather than per-arm. If a
 * module ever persists tags such that a tag edit survives rollback — or the gate's
 * scope is restated as "anything that escapes the transaction" — gate here too.
 */
export function emitSetObjectTags(plan: SetObjectTagsNode, _ctx: EmissionContext): Instruction {
	async function run(rctx: RuntimeContext): Promise<SqlValue> {
		// Ensure we're in a transaction before DDL (lazy/JIT transaction start).
		await rctx.db._ensureTransaction();

		// Statement-scoped schema-event scope. The tag arms raise nothing on the public
		// schema channel today, so the scope is a no-op — it is here so the invariant holds
		// by construction (see ddl-event-scope.ts): if
		// `backlog/feat-alter-table-tags-emit-no-schema-event` ever lands, a failed tag edit
		// still cannot announce.
		return withStatementScopedSchemaEvents(rctx, async () => {
			const sm = rctx.db.schemaManager;
			const m = plan.mutation;
			// Test `op === 'drop'` first: it uniquely identifies the keys-bearing union
			// member, so the `else` branches narrow cleanly to the tags-bearing member.
			switch (plan.objectKind) {
				case 'view':
					if (m.op === 'drop') sm.dropViewTags(plan.name, m.keys, plan.schemaName);
					else if (m.op === 'merge') sm.mergeViewTags(plan.name, m.tags, plan.schemaName);
					else sm.setViewTags(plan.name, m.tags, plan.schemaName);
					break;
				case 'materializedView':
					if (m.op === 'drop') sm.dropMaterializedViewTags(plan.name, m.keys, plan.schemaName);
					else if (m.op === 'merge') sm.mergeMaterializedViewTags(plan.name, m.tags, plan.schemaName);
					else sm.setMaterializedViewTags(plan.name, m.tags, plan.schemaName);
					break;
				case 'index':
					if (m.op === 'drop') sm.dropIndexTags(plan.name, m.keys, plan.schemaName);
					else if (m.op === 'merge') sm.mergeIndexTags(plan.name, m.tags, plan.schemaName);
					else sm.setIndexTags(plan.name, m.tags, plan.schemaName);
					break;
			}
			log('%s tags on %s %s.%s', m.op, plan.objectKind, plan.schemaName, plan.name);
			return null;
		});
	}

	return {
		params: [],
		run,
		note: `${plan.mutation.op}ObjectTags(${plan.objectKind} ${plan.schemaName}.${plan.name})`,
	};
}
