/**
 * Per-table hoist of "trivially universal" `create assertion` predicates into
 * FD / EC / constant-binding / domain-constraint contributions. Reuses ticket
 * #1's `extractCheckConstraints` walker via a synthetic `RowConstraintSchema`
 * whose `expr` is the negated inner predicate from the assertion's canonical
 * `not exists (select 1 from T [where P])` shape.
 *
 * Cached per (SchemaManager, TableSchema). Invalidated by schema-change
 * events: any `assertion_*` event bumps a generation counter; lookups whose
 * cached generation is stale recompute. Table-side invalidation rides on
 * `TableSchema` identity — ALTER TABLE swaps the schema instance, which is
 * the cache key.
 *
 * Soundness: hoisted facts add to the optimizer's premises; they NEVER
 * suppress commit-time assertion enforcement (that remains the source of
 * truth in `AssertionEvaluator`).
 */

import { createLogger } from '../../common/logger.js';
import type {
	ConstantBinding,
	ConstraintProvenance,
	DomainConstraint,
	FunctionalDependency,
} from '../nodes/plan-node.js';
import type { TableSchema, RowConstraintSchema } from '../../schema/table.js';
import { DEFAULT_ROWOP_MASK } from '../../schema/table.js';
import type { SchemaManager } from '../../schema/manager.js';
import type { SchemaChangeEvent } from '../../schema/change-events.js';
import { extractCheckConstraints } from './check-extraction.js';
import { classifyAssertionForHoisting, negateAst } from './assertion-classifier.js';

const log = createLogger('planner:analysis:assertion-hoist');

export interface HoistedConstraintsForTable {
	readonly fds: ReadonlyArray<FunctionalDependency>;
	readonly equivPairs: ReadonlyArray<readonly [number, number]>;
	readonly constantBindings: ReadonlyArray<ConstantBinding>;
	readonly domainConstraints: ReadonlyArray<DomainConstraint>;
}

const EMPTY: HoistedConstraintsForTable = {
	fds: [],
	equivPairs: [],
	constantBindings: [],
	domainConstraints: [],
};

interface CacheEntry {
	generation: number;
	value: HoistedConstraintsForTable;
}

interface PerManagerRegistry {
	generation: number;
	cache: WeakMap<TableSchema, CacheEntry>;
	unsubscribe: () => void;
}

const registries = new WeakMap<SchemaManager, PerManagerRegistry>();

function getRegistry(schemaManager: SchemaManager): PerManagerRegistry {
	let reg = registries.get(schemaManager);
	if (reg) return reg;

	const newReg: PerManagerRegistry = {
		generation: 0,
		cache: new WeakMap<TableSchema, CacheEntry>(),
		unsubscribe: () => undefined,
	};
	const notifier = schemaManager.getChangeNotifier();
	newReg.unsubscribe = notifier.addListener((event: SchemaChangeEvent) => {
		if (
			event.type === 'assertion_added' ||
			event.type === 'assertion_removed' ||
			event.type === 'assertion_modified'
		) {
			newReg.generation++;
		}
	});
	registries.set(schemaManager, newReg);
	reg = newReg;
	return reg;
}

const allDeterministic = (): boolean => true;

/**
 * Build (or look up) the hoisted constraint contributions for `table` derived
 * from every qualifying `create assertion` known to `schemaManager`. Safe to
 * call from `TableReferenceNode.computePhysical` — results are cached per
 * (manager, table-instance) and invalidated by assertion schema-change events.
 */
export function getAssertionHoistedConstraints(
	schemaManager: SchemaManager,
	table: TableSchema,
): HoistedConstraintsForTable {
	// Re-entrancy guard: when AssertionEvaluator is compiling an assertion's
	// own violation query, returning the hoisted facts would let the optimizer
	// fold the violation query to empty (the assertion's claim would prove
	// itself), defeating commit-time enforcement. Skip the cache entirely so
	// non-suppressed lookups continue to see fully-hoisted results.
	if (schemaManager.isAssertionHoistSuppressed()) {
		return EMPTY;
	}

	const reg = getRegistry(schemaManager);
	const cached = reg.cache.get(table);
	if (cached && cached.generation === reg.generation) {
		return cached.value;
	}

	const targetName = `${table.schemaName.toLowerCase()}.${table.name.toLowerCase()}`;
	const synthChecks: RowConstraintSchema[] = [];
	const provenanceByCheckIdx: ConstraintProvenance[] = [];

	for (const assertion of schemaManager.getAllAssertions()) {
		const candidate = classifyAssertionForHoisting(assertion, schemaManager);
		if (!candidate) continue;
		if (candidate.baseTableQualifiedName !== targetName) continue;
		if (!candidate.innerPredicate) continue;

		// Synthetic check on T: per-row `not P`. extractCheckConstraints' row-
		// invariant gate requires the mask to cover INSERT|UPDATE; an assertion
		// holds for every stored row regardless of how it got there, so the
		// default mask is the honest encoding (a 0 mask would be silently
		// dropped by the gate).
		synthChecks.push({
			name: `__assertion_${candidate.assertionName}`,
			expr: negateAst(candidate.innerPredicate),
			operations: DEFAULT_ROWOP_MASK,
		});
		// NOTE: provenance carries the BARE assertion name, which is only unique
		// per schema — two same-named assertions in different schemas hoisting
		// onto the same table are indistinguishable here. Harmless today because
		// provenance is informational (invariant OPT-052: no rule branches on it);
		// if a rule ever reads it, key on `schemaName.name` instead.
		provenanceByCheckIdx.push({ kind: 'assertion', name: candidate.assertionName });
		log('Hoisted assertion %s onto %s', candidate.assertionName, targetName);
	}

	let result: HoistedConstraintsForTable = EMPTY;
	if (synthChecks.length > 0) {
		// Run each synthetic check separately so we can tag provenance per
		// assertion. (extractCheckConstraints iterates checks but does not
		// surface which check produced which fact.)
		const fds: FunctionalDependency[] = [];
		const equivPairs: Array<readonly [number, number]> = [];
		const constantBindings: ConstantBinding[] = [];
		const domainConstraints: DomainConstraint[] = [];

		for (let i = 0; i < synthChecks.length; i++) {
			const prov = provenanceByCheckIdx[i];
			const ext = extractCheckConstraints(
				[synthChecks[i]],
				table.columnIndexMap,
				allDeterministic,
				table.columns,
			);
			for (const fd of ext.fds) fds.push({ ...fd, source: prov });
			for (const p of ext.equivPairs) equivPairs.push(p);
			for (const b of ext.constantBindings) constantBindings.push({ ...b, source: prov });
			for (const d of ext.domainConstraints) {
				domainConstraints.push({ ...d, source: prov });
			}
		}

		result = { fds, equivPairs, constantBindings, domainConstraints };
	}

	reg.cache.set(table, { generation: reg.generation, value: result });
	return result;
}
