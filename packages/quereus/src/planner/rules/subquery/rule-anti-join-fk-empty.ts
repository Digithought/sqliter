/**
 * Rule: Anti-Join FK → Empty
 *
 * Inclusion-dependency folding for `NOT EXISTS` patterns after
 * `rule-subquery-decorrelation` has materialized them as anti-joins.
 *
 * Pattern:
 *   AntiJoin(L, R, p)
 *     where p is an AND-of-column-equalities,
 *     L's equi columns form a declared FK referencing R's PK (via the equi
 *     pairs in some permutation),
 *     every FK child column is NOT NULL, and
 *     R is a row-preserving path to its base table (no filter / limit / distinct
 *     between the anti-join and the parent table).
 *
 * Rewrite:
 *   EmptyRelationNode(L's attributes, L's RelationType)
 *
 * Why correct: under the FK inclusion `L.fk ⊆ R.pk`, every non-null FK row in L
 * has a matching parent in R, so the anti-join contains no rows. With nullable
 * FKs, NULL FK rows survive (the equality is UNKNOWN, never matched), so the
 * rule conservatively requires all FK columns NOT NULL. Row-preserving R is
 * required because the IND only guarantees the parent row exists in the table
 * — a filter on the R side could remove it.
 *
 * The output schema of an anti-join is its left side (SEMI/ANTI take left
 * columns only — see `buildJoinAttributes`), so we hand `EmptyRelationNode`
 * L's attribute IDs and RelationType directly. The const-fold pass
 * (in the Structural pass, alongside the empty-relation folds) then cascades that emptiness up through Filter /
 * Project / Sort / LimitOffset / Distinct / inner-or-cross-or-semi joins.
 */

import { createLogger } from '../../../common/logger.js';
import type { PlanNode } from '../../nodes/plan-node.js';
import type { OptContext } from '../../framework/context.js';
import { JoinNode, extractEquiPairsFromCondition } from '../../nodes/join-node.js';
import { EmptyRelationNode } from '../../nodes/empty-relation-node.js';
import { normalizePredicate } from '../../analysis/predicate-normalizer.js';
import { lookupCoveringFK, isRowPreservingPathToTable, resolveTableColumnMapping, mapColumnsToTable } from '../../util/ind-utils.js';
import { isAndOfColumnEqualities } from '../join/rule-join-elimination.js';
import { PlanNodeCharacteristics } from '../../framework/characteristics.js';

const log = createLogger('optimizer:rule:anti-join-fk-empty');

export function ruleAntiJoinFkEmpty(node: PlanNode, _context: OptContext): PlanNode | null {
	if (!(node instanceof JoinNode)) return null;
	if (node.joinType !== 'anti') return null;
	if (!node.condition) return null;

	const normalized = normalizePredicate(node.condition);
	if (!isAndOfColumnEqualities(normalized)) return null;

	const leftAttrs = node.left.getAttributes();
	const rightAttrs = node.right.getAttributes();
	const pairs = extractEquiPairsFromCondition(node.condition, leftAttrs, rightAttrs);
	if (pairs.length === 0) return null;

	// Equi-pairs index each side's OUTPUT columns; the FK lookup speaks base-table
	// column indices. Translate before comparing — a projection on either side can
	// rename, reorder, or drop columns, and a derived column has no table origin
	// at all (mapColumnsToTable then declines).
	const leftMapping = resolveTableColumnMapping(node.left);
	const rightMapping = resolveTableColumnMapping(node.right);
	if (!leftMapping || !rightMapping) return null;

	const childEquiCols = mapColumnsToTable(pairs.map(p => p.left), leftMapping);
	const parentEquiCols = mapColumnsToTable(pairs.map(p => p.right), rightMapping);
	if (!childEquiCols || !parentEquiCols) return null;

	const leftSchema = leftMapping.schema;
	const rightSchema = rightMapping.schema;
	const match = lookupCoveringFK(leftSchema, rightSchema, childEquiCols, parentEquiCols);
	if (!match) return null;

	// Nullable FK leaks NULL rows through the anti-join (NULL = X is UNKNOWN,
	// never matched), so we can only fold when every FK column is NOT NULL.
	if (match.nullable) return null;

	// The parent side must expose the full base-table row set — otherwise the
	// IND `L.fk ⊆ R.pk` doesn't guarantee a match in the filtered relation. A
	// projection is peeled (it never drops rows); its column renaming is already
	// accounted for by the mapping above.
	if (!isRowPreservingPathToTable(node.right, { throughProject: true })) return null;

	// Refuse to fold to Empty when either participating subtree carries a write —
	// the anti-join collapses to EmptyRelation(L's attrs), dropping both sides.
	if (PlanNodeCharacteristics.subtreeHasSideEffects(node.left)
		|| PlanNodeCharacteristics.subtreeHasSideEffects(node.right)) {
		log('Anti-join FK→Empty skipped: a participating subtree has side effects');
		return null;
	}

	log('Folding anti-join over FK %s.%s → %s to empty',
		leftSchema.name,
		match.fk.columns.map(c => leftSchema.columns[c]?.name ?? c).join(','),
		rightSchema.name,
	);

	return new EmptyRelationNode(node.scope, node.left.getAttributes(), node.left.getType());
}
