/**
 * Index-nested-loop candidate construction for `rule-join-physical-selection`.
 *
 * When a join's inner side bottoms out in a table-access leaf whose module can
 * answer an equality seek on the join key, the leaf is replaced by an
 * `IndexSeekNode` whose seek keys are column references into the OUTER row.
 * The node above stays the logical `JoinNode`, so the existing nested-loop
 * emitter drives it: for each outer row it installs the outer row slot and
 * re-opens the inner pipeline, and the seek-key expressions resolve through
 * the runtime context by attribute id — the same machinery correlated
 * subqueries already exercise.
 *
 *   Join(inner, s, SeqScan(big))          Join(inner, s, IndexSeek(big, keys=[s.k]))
 *     ON big.id = s.k              ──▶      ON big.id = s.k
 *   reads every row of big                 one seek per row of s
 *
 * Two admission arms for the inner leaf. A WALK leaf (plain full scan, or an
 * ordering-only index walk) enforces nothing, so its `FilterInfo` may be
 * replaced wholesale. A SEEK leaf (`IndexSeekNode`) already enforces the
 * predicates the module claimed — `status = 'x'` below is nowhere else in the
 * tree — so it is admitted by re-OFFERING those predicates to the module
 * alongside the join key and re-applying whatever the module declines:
 *
 *   Join(inner, s, IndexSeek(big, [status='x']))
 *     ON big.id = s.k
 *       ──▶  Join(inner, s, Filter[status='x'](IndexSeek(big, keys=[s.k])))
 *       or   Join(inner, s, IndexSeek(big, keys=[status='x', s.k]))   (composite index)
 *
 * The function takes `outer` / `inner` explicitly rather than reading a
 * JoinNode's `left` / `right`: the caller asks for BOTH orientations of an
 * inner join (seek the right driven by the left, and the mirror) and elects
 * the cheaper — see `ruleJoinPhysicalSelection`. Here "outer" always means the
 * side that will drive, and "inner" the side whose leaf becomes the seek,
 * whichever JoinNode slot each came from.
 *
 * This module only CONSTRUCTS the candidate (recognize the shape, probe the
 * module, cost it); the cost comparison and the join rebuild live in the
 * caller. Every gate below declines by returning null, which leaves the
 * nested-loop / hash / merge competition unchanged.
 *
 * NOTE: one extra pair of `getBestAccessPlan` probes runs per qualifying
 * equi-join on the walk arm, uncached (see `probeModule`); the seek arm runs
 * ONE probe — its baseline is the displaced seek's recorded cost, a field read
 * rather than a second probe. Cheap for both shipped modules; memoize by
 * (table, offered constraints) only if a third-party module with an expensive
 * planner shows up in optimization profiles — mirrors the rule-key-set-seek
 * tripwire.
 */

import { createLogger } from '../../../common/logger.js';
import type { RelationalPlanNode, ScalarPlanNode } from '../../nodes/plan-node.js';
import type { OptContext } from '../../framework/context.js';
import type { JoinType } from '../../nodes/join-node.js';
import type { EquiJoinPair } from '../../nodes/join-utils.js';
import { IndexScanNode, IndexSeekNode } from '../../nodes/table-access-nodes.js';
import { FilterNode } from '../../nodes/filter.js';
import { ColumnReferenceNode } from '../../nodes/reference.js';
import { BinaryOpNode } from '../../nodes/scalar.js';
import { PlanNodeCharacteristics } from '../../framework/characteristics.js';
import { hasSemanticOrdering } from '../../../util/comparison.js';
import { sharesSeekKeySpace } from '../../../types/builtin-types.js';
import { hasRelationalDescendant } from '../../analysis/scalar-subqueries.js';
import { extractConstraints, createTableInfoFromNode, type PredicateConstraint } from '../../analysis/constraint-extractor.js';
import {
	selectPhysicalNode,
	combineResidualExpressions,
	effectivePredicateCollation,
} from '../access/rule-select-access-path.js';
import {
	peelToSeekableAccessLeaf,
	rebuildChain,
	buildProbeRequest,
	type AccessLeafNode,
	type SeekableAccessLeafNode,
} from '../shared/access-leaf.js';
import { combineResidual } from './equi-pair-extractor.js';
import { indexNestedLoopJoinCost } from '../../cost/index.js';
import { validateAccessPlan, type BestAccessPlanResult } from '../../../vtab/best-access-plan.js';
import type { TableSchema } from '../../../schema/table.js';
import { uniqueEnforcementCollations } from '../../../schema/unique-enforcement.js';
import { normalizeCollationName } from '../../../util/comparison.js';

const log = createLogger('optimizer:rule:index-nested-loop');

export interface IndexNestedLoopCandidate {
	/**
	 * Rebuilt INNER subtree with the access leaf replaced by the correlated seek.
	 * Which JoinNode slot it belongs in is the caller's business — it is the
	 * `inner` argument's slot, which is the right one only in the un-mirrored case.
	 */
	readonly newInner: RelationalPlanNode;
	/** Engine-currency cost, comparable with nestedLoop/hash/merge in the caller. */
	readonly cost: number;
	/**
	 * The two inputs `cost` was derived from, so the caller can re-price the same
	 * seek under a different driver (`batchedIndexNestedLoopJoinCost`) without
	 * re-probing: the module's row estimate for one seek, and the inner
	 * subtree's first-row latency.
	 */
	readonly rowsPerSeek: number;
	readonly perSeekLatencyMs: number;
	/**
	 * True when the rebuilt inner PROVABLY yields at most one row per outer row —
	 * see {@link provesAtMostOne}. What lets the caller drive this candidate as a
	 * one-branch `FanOutLookupJoinNode` (`atMostOne-*` branch), whose runtime
	 * throws on a second row.
	 */
	readonly atMostOne: boolean;
}

/** One equi pair resolved to its leaf column index and outer attribute position. */
interface ResolvedPair {
	readonly innerCol: number;
	readonly outerIdx: number;
}

/** The admitted inner leaf, plus what its `FilterInfo` is the sole enforcer of. */
interface AdmittedLeaf {
	readonly leaf: SeekableAccessLeafNode;
	/**
	 * The planner-level constraints the displaced leaf enforces —
	 * `IndexSeekNode.pushedConstraints` for a seek leaf, empty for a walk leaf.
	 * Re-offered to the module alongside the join key; see {@link offerConstraints}.
	 */
	readonly pushed: readonly PredicateConstraint[];
}

/**
 * The constraint list offered to the module, with the boundary between its
 * two origins: positions `< joinKeyCount` are the synthesized join-key
 * equalities, the rest are the displaced leaf's pushed predicates. The module's
 * `handledFilters` is positional against `combined`, so every consumer of that
 * array reads it through this one layout.
 */
interface OfferedConstraints {
	readonly combined: readonly PredicateConstraint[];
	readonly joinKeyCount: number;
}

/**
 * Join keys FIRST. Both the module (`claimFirstPerRole` in the store,
 * `findEqualityMatches` in memory) and `selectPhysicalNode` pick the FIRST
 * role-filling constraint per column, so when a pushed predicate and a join key
 * land on the same column (`where b.id = 5` joined `on b.id = s.k`) this order
 * is what makes the correlated seek the one that wins the column — the whole
 * point of the candidate. Either leftover is then re-applied as a Filter.
 */
function offerConstraints(
	joinKeys: readonly PredicateConstraint[],
	pushed: readonly PredicateConstraint[],
): OfferedConstraints {
	return { combined: [...joinKeys, ...pushed], joinKeyCount: joinKeys.length };
}

/** Dispatch on the peeled leaf's kind; each arm owns its own gates. */
function admitLeaf(inner: RelationalPlanNode): AdmittedLeaf | null {
	const leaf = peelToSeekableAccessLeaf(inner);
	if (!leaf) {
		log('decline: inner does not peel to an access leaf through Alias/Project/Filter');
		return null;
	}
	return leaf instanceof IndexSeekNode ? admitSeekLeaf(leaf) : admitWalkLeaf(leaf);
}

/**
 * WALK arm: an unconstrained every-row walk whose `FilterInfo` may be replaced
 * wholesale — a plain full scan, or an ordering-only index walk (plan='scan').
 * A pushed limit / offset is a directive the seek would not honor.
 */
function admitWalkLeaf(leaf: AccessLeafNode): AdmittedLeaf | null {
	const fi = leaf.filterInfo;
	const isEveryRowWalk = fi.accessPath?.kind === 'fullScan'
		|| (fi.accessPath?.kind === 'index' && fi.accessPath.plan === 'scan');
	if (!isEveryRowWalk || fi.constraints.length !== 0
		|| fi.limit !== undefined || fi.offset !== undefined) {
		log('decline: leaf is not an unconstrained every-row walk');
		return null;
	}
	// A leaf whose emission order absorbed a SortNode is the only thing producing
	// the query's ORDER BY; a seek emits in seek-key order instead.
	if (leaf instanceof IndexScanNode && leaf.orderingLoadBearing) {
		log('decline: leaf emission order is load-bearing (absorbed a Sort)');
		return null;
	}
	return { leaf, pushed: [] };
}

/**
 * SEEK arm: a leaf whose `FilterInfo` already enforces the predicates recorded
 * in `pushedConstraints` (their residual Filter was dropped on the module's
 * promise). Admitted when that record is complete and re-offerable; the caller
 * re-offers it with the join key and re-applies whatever the module declines,
 * so no recorded predicate can be lost. Same five gates as
 * `rule-key-set-seek`'s `admitSeekLeaf`, for the same reasons.
 */
function admitSeekLeaf(leaf: IndexSeekNode): AdmittedLeaf | null {
	const fi = leaf.filterInfo;
	// Gate 1: a pushed limit / offset is a directive the re-planned seek would not
	// honour, and unlike a predicate it cannot be re-applied by a Filter without
	// changing which rows are dropped.
	if (fi.limit !== undefined || fi.offset !== undefined) {
		log('decline: seek leaf carries a pushed limit/offset');
		return null;
	}
	// Gate 2: a seek whose enforced predicate we cannot describe is a seek we
	// cannot safely re-plan.
	if (!leaf.pushedConstraints || leaf.pushedConstraints.length === 0) {
		log('decline: seek leaf records no pushed constraints');
		return null;
	}
	// Gate 3: the seek's emission order absorbed a Sort; a re-planned seek emits
	// in its own key order instead.
	if (leaf.orderingLoadBearing) {
		log('decline: seek leaf emission order is load-bearing (absorbed a Sort)');
		return null;
	}
	for (const c of leaf.pushedConstraints) {
		// Gate 4: a correlated pushed constraint means this leaf is already somebody
		// else's per-outer-row seek (a lateral seek keyed on an enclosing scope);
		// re-planning it would re-plan their correlation. (The caller's
		// sibling-reference guard already blocks this rule's OWN output.)
		//
		// NOTE: this reads the RECORDED constraint's flag, where rule-key-set-seek's
		// equivalent gate asks whether the leaf SUBTREE is correlated. The two agree
		// only because `stampSeekProvenance` is the sole producer of
		// `pushedConstraints` and records every constraint the seek consumed; a
		// future rule that mints a correlated seek without recording the correlated
		// constraint would slip past this gate. Switch to the subtree test if one
		// ever does.
		if (c.correlated === true) {
			log('decline: seek leaf carries a correlated pushed constraint');
			return null;
		}
		// Gate 5: this rule runs PostOptimization, so an expression re-applied here
		// gets no further pass — a relational subquery inside it would reach emit
		// unphysicalized, and would re-execute per outer row besides.
		if (hasRelationalDescendant(c.sourceExpression)) {
			log('decline: seek leaf pushed predicate contains a relational node');
			return null;
		}
	}
	return { leaf, pushed: leaf.pushedConstraints };
}

/**
 * Resolve each equi pair to (leaf column index, outer attribute position) and
 * apply the two type gates that keep a raw-value seek from under-fetching. The
 * seek key is passed through verbatim (no cast is applied to a dynamic value
 * expression), so a pair whose two types do not share one seek key space
 * (`sharesSeekKeySpace`), or a semantic-ordering key type ('PT1H' ≡ 'PT60M' but
 * byte-distinct), can miss rows `=` considers equal — and the ON condition
 * retained above the join cannot resurrect a row the seek never returned. Same
 * two gates as rule-key-set-seek's resolveSeekColumns.
 *
 * The gates are per pair; one non-conforming pair declines the whole candidate.
 * That is sound for a composite seek because key-space identity is per column and
 * the store's composite key is the concatenation of the per-column encodings, so
 * per-column key identity gives composite key identity.
 */
function resolvePairs(
	leaf: SeekableAccessLeafNode,
	outer: RelationalPlanNode,
	equiPairs: readonly EquiJoinPair[],
): ResolvedPair[] | null {
	const leafAttrIndex = leaf.getAttributeIndex();
	const leafAttrs = leaf.getAttributes();
	const outerAttrIndex = outer.getAttributeIndex();
	const outerAttrs = outer.getAttributes();

	const resolved: ResolvedPair[] = [];
	for (const pair of equiPairs) {
		// A TableAccessNode's attributes are the table reference's, positionally
		// 1:1 with tableSchema.columns — so this index IS the table column index.
		const innerCol = leafAttrIndex.get(pair.rightAttrId) ?? -1;
		if (innerCol === -1) {
			log('decline: join key attr %d is not a leaf column', pair.rightAttrId);
			return null;
		}
		const outerIdx = outerAttrIndex.get(pair.leftAttrId) ?? -1;
		if (outerIdx === -1) {
			log('decline: join key attr %d is not an outer column', pair.leftAttrId);
			return null;
		}

		const innerType = leafAttrs[innerCol].type;
		const outerType = outerAttrs[outerIdx].type;
		if (!sharesSeekKeySpace(innerType.logicalType, outerType.logicalType)) {
			log('decline: %s and %s do not share a seek key space',
				innerType.logicalType.name, outerType.logicalType.name);
			return null;
		}
		if (hasSemanticOrdering(innerType.logicalType) || hasSemanticOrdering(outerType.logicalType)) {
			log('decline: semantic-ordering key type %s', innerType.logicalType.name);
			return null;
		}
		resolved.push({ innerCol, outerIdx });
	}
	return resolved;
}

/**
 * Build the seek predicate: `leaf.col = outer.col` per pair, ANDed. Inner side
 * FIRST — the constraint extractor picks the first side it can map to the
 * probed table as "the column", so this ordering is what makes the extraction
 * come back oriented inner-column-seeks-on-outer-value (asserted by the
 * caller). Construction mirrors `createSortForEquiPairs`.
 */
function buildSeekPredicate(
	leaf: SeekableAccessLeafNode,
	outer: RelationalPlanNode,
	resolved: readonly ResolvedPair[],
): ScalarPlanNode {
	const leafAttrs = leaf.getAttributes();
	const outerAttrs = outer.getAttributes();
	const conjuncts = resolved.map(({ innerCol, outerIdx }) => {
		const innerAttr = leafAttrs[innerCol];
		const outerAttr = outerAttrs[outerIdx];
		const innerRef = new ColumnReferenceNode(
			leaf.scope,
			{ type: 'column', table: '', name: innerAttr.name, schema: '' },
			innerAttr.type,
			innerAttr.id,
			innerCol,
		);
		const outerRef = new ColumnReferenceNode(
			outer.scope,
			{ type: 'column', table: '', name: outerAttr.name, schema: '' },
			outerAttr.type,
			outerAttr.id,
			outerIdx,
		);
		return new BinaryOpNode(
			leaf.scope,
			{ type: 'binary', operator: '=', left: innerRef.expression, right: outerRef.expression },
			innerRef,
			outerRef,
		) as ScalarPlanNode;
	});
	// resolved is never empty (caller requires ≥1 equi pair), so combineResidual
	// always returns a node.
	return combineResidual(undefined, conjuncts)!;
}

/** Module-currency cost and row estimate of the plan the candidate would displace. */
interface DisplacedPlan {
	readonly cost: number;
	readonly rows: number | undefined;
}

/**
 * What the inner leaf costs TODAY, in the module's own currency. A seek leaf
 * already records the module's answer for its own seek — `filterInfo.
 * indexInfoOutput.estimatedCost` / `estimatedRows` are `accessPlan.cost` /
 * `accessPlan.rows` verbatim (`makeIndexFilterInfo` spreads a base seeded with
 * them and never overrides either) — while an unconstrained walk has to be
 * asked. Comparing the combined seek against a bare scan instead would let a
 * plan WORSE than the seek already in place win. Same baseline rule as
 * rule-key-set-seek's `probeModuleCosts`.
 *
 * NOTE: `estimatedRows` is `makeFullScanFilterInfo`'s `accessPlan.rows || 1000`,
 * so a module that answered its own seek with `rows: 0` (and did not claim every
 * filter, which would have folded the access to an EmptyResult instead) or with
 * no estimate at all reads back here as a 1000-row baseline the module never
 * stated — the seek arm would then admit a candidate the cost gate should have
 * declined. Both shipped modules always return a positive estimate for a seek,
 * so this is unreachable today; if a third-party module reports 0 or omits
 * `rows`, carry the module's own answer on the leaf instead of re-deriving it
 * from the FilterInfo.
 */
function displacedPlan(
	leaf: SeekableAccessLeafNode,
	ask: (filters: readonly PredicateConstraint[]) => BestAccessPlanResult,
): DisplacedPlan {
	if (leaf instanceof IndexSeekNode) {
		const out = leaf.filterInfo.indexInfoOutput;
		return { cost: out.estimatedCost, rows: Number(out.estimatedRows) };
	}
	const scan = ask([]);
	return { cost: scan.cost, rows: scan.rows };
}

/**
 * Probe the module with the offered constraints and admit the seek only when
 * the module's OWN answers say it beats the plan being displaced (`cost` no
 * higher, `rows` strictly smaller). Comparing module currency to module
 * currency keeps the engine's cost units out of the module's — the same
 * discipline as rule-key-set-seek's break-even.
 *
 * These requests are the ENGINE's, not the user's: a module that answers one
 * with a plan `validateAccessPlan` rejects gets logged and declined, never
 * thrown — the user's own query ran fine before this rule probed.
 */
function probeModule(
	context: OptContext,
	leaf: SeekableAccessLeafNode,
	offered: OfferedConstraints,
): BestAccessPlanResult | null {
	const tableSchema = leaf.tableSchema;
	const vtabModule = leaf.source.vtabModule;
	const getBestAccessPlan = vtabModule.getBestAccessPlan;
	if (typeof getBestAccessPlan !== 'function') {
		log('decline: module has no getBestAccessPlan');
		return null;
	}
	const tableRows = leaf.source.estimatedRows || undefined;
	const ask = (filters: readonly PredicateConstraint[]): BestAccessPlanResult => {
		const request = buildProbeRequest(tableSchema, tableRows, filters);
		const plan = getBestAccessPlan.call(vtabModule, context.db, tableSchema, request) as BestAccessPlanResult;
		validateAccessPlan(request, plan);
		return plan;
	};

	const { combined, joinKeyCount } = offered;
	let seekPlan: BestAccessPlanResult;
	let baseline: DisplacedPlan;
	try {
		seekPlan = ask(combined);
		baseline = displacedPlan(leaf, ask);
	} catch (e: unknown) {
		log('decline: module %s answered a synthesized probe on %s with an invalid plan: %s',
			tableSchema.vtabModuleName, tableSchema.name, e instanceof Error ? e.message : String(e));
		return null;
	}

	if (!seekPlan.indexName || !seekPlan.seekColumnIndexes || seekPlan.seekColumnIndexes.length === 0) {
		log('decline: module did not claim an index seek');
		return null;
	}
	// Every seek column must be one of the offered constraints — otherwise the
	// module answered a different question than the one we will emit.
	const offeredCols = new Set(combined.map(c => c.columnIndex));
	if (!seekPlan.seekColumnIndexes.every(col => offeredCols.has(col))) {
		log('decline: seek columns extend beyond the offered constraints');
		return null;
	}
	// At least one seek column must come from a JOIN KEY. Without this the
	// module can answer a seek leaf with the seek it already had: nothing is
	// correlated, nothing is gained, and the rule would rebuild an identical
	// leaf on every visit. (The rebuilt leaf's provenance is re-checked by
	// identity in `tryIndexNestedLoop` — this is the cheap early exit.)
	const joinKeyCols = new Set(combined.slice(0, joinKeyCount).map(c => c.columnIndex));
	if (!seekPlan.seekColumnIndexes.some(col => joinKeyCols.has(col))) {
		log('decline: the seek does not use the join key');
		return null;
	}
	// Every JOIN-KEY constraint on a seek column must be claimed handled — the
	// module must be promising to seek on the key we will emit. Pushed
	// constraints need no such claim: a handled one is re-promised by the new
	// seek or reattached by selectPhysicalNode, an unhandled one is re-applied
	// by `reapplyDeclinedPushed` — either answer is honoured.
	const seekCols = new Set(seekPlan.seekColumnIndexes);
	for (let i = 0; i < joinKeyCount; i++) {
		if (seekCols.has(combined[i].columnIndex) && seekPlan.handledFilters[i] !== true) {
			log('decline: module claimed a join-key seek column without handling its filter');
			return null;
		}
	}
	// A module-supplied JS residual has no place to run in this path.
	if (seekPlan.residualFilter) {
		log('decline: module attached a residualFilter');
		return null;
	}
	// The module's own statement that the combined seek beats what it displaces:
	// no dearer, and strictly fewer rows. Rows is the discriminator on purpose —
	// the memory module prices every single-key equality seek identically (cost
	// keyed to the seek-KEY count, not the rows matched), so a pushed
	// `status = 'x'` seek and the join-key seek that would replace it tie on
	// cost and differ only in rows; a strict cost test would leave the seek arm
	// dead on that module for its headline shape.
	if (seekPlan.rows === undefined || baseline.rows === undefined
		|| !(seekPlan.cost <= baseline.cost) || !(seekPlan.rows < baseline.rows)) {
		log('decline: module costs do not favor the seek (seek %s/%s vs displaced %s/%s)',
			seekPlan.cost, seekPlan.rows, baseline.cost, baseline.rows);
		return null;
	}
	return seekPlan;
}

/**
 * Re-apply the pushed constraints the module DECLINED (`handledFilters[i]
 * !== true`) as a Filter directly above the rebuilt leaf. `selectPhysicalNode`
 * re-promises the handled ones it consumed (recording them on the new seek's
 * `pushedConstraints`) and reattaches the handled-but-unconsumed ones itself,
 * but — exactly as for a user predicate, where `rule-grow-retrieve` owns the
 * residual — it never touches a constraint the module did not claim. This is
 * the third place, and with it every offered pushed constraint lands in
 * exactly one of: re-promised, reattached, or re-applied here. Join-key
 * leftovers need nothing: the ON condition retained above the join covers them.
 *
 * Folded into every Filter `selectPhysicalNode` may already have wrapped the
 * seek in — it can stack two (a `COARSER_SAFE` collation residual, then a
 * reattach above it) — so the seek carries one residual Filter rather than a
 * stack. `combineResidualExpressions` de-duplicates by identity, so a declined
 * BETWEEN comes back as its single `BetweenNode`.
 */
function reapplyDeclinedPushed(
	rebuilt: RelationalPlanNode,
	seekPlan: BestAccessPlanResult,
	offered: OfferedConstraints,
): RelationalPlanNode {
	const { combined, joinKeyCount } = offered;
	const declined = combined.filter((_c, i) => i >= joinKeyCount && seekPlan.handledFilters[i] !== true);
	if (declined.length === 0) return rebuilt;

	// Peel the whole Filter stack, outermost predicate first, so the result is one
	// Filter — the same peel `rebuiltSeek` uses to find the seek underneath.
	let below: RelationalPlanNode = rebuilt;
	const existing: ScalarPlanNode[] = [];
	while (below instanceof FilterNode) {
		existing.push(below.predicate);
		below = below.source;
	}
	// Non-empty input ⇒ defined result.
	const predicate = combineResidualExpressions([...existing, ...declined.map(c => c.sourceExpression)])!;
	log('re-applying %d module-declined pushed constraint(s) above the seek', declined.length);
	return new FilterNode(below.scope, below, predicate);
}

/** One key the inner table enforces uniqueness on, with the collation each column is enforced under. */
interface EnforcedKey {
	readonly columns: readonly number[];
	readonly collations: readonly (string | undefined)[];
}

/**
 * Every key the table enforces uniqueness on, each with the collation its
 * columns are enforced under: the primary key (a member's own collation, else
 * its column's — `ddl-generator` reads it the same way), every non-partial
 * UNIQUE constraint (`uniqueEnforcementCollations`: the backing index's
 * per-column COLLATE for an index-derived constraint, else the column's), and
 * every non-partial UNIQUE index (its own per-column collation, else the
 * column's — `appendIndexToTableSchema` normally mirrors these as derived
 * constraints already; listed so a host-authored schema carrying the index
 * alone is not missed). A partial key (`predicate` set) only constrains the
 * rows its WHERE admits and proves nothing about the rest.
 */
function enforcedKeys(tableSchema: TableSchema): EnforcedKey[] {
	const columnCollation = (idx: number): string | undefined => tableSchema.columns[idx]?.collation;
	const keys: EnforcedKey[] = [];
	const pk = tableSchema.primaryKeyDefinition;
	if (pk.length > 0) {
		keys.push({
			columns: pk.map(k => k.index),
			collations: pk.map(k => k.collation ?? columnCollation(k.index)),
		});
	}
	for (const uc of tableSchema.uniqueConstraints ?? []) {
		if (uc.predicate !== undefined || uc.columns.length === 0) continue;
		keys.push({ columns: uc.columns, collations: uniqueEnforcementCollations(tableSchema, uc) });
	}
	for (const ix of tableSchema.indexes ?? []) {
		if (!ix.unique || ix.predicate !== undefined || ix.columns.length === 0) continue;
		keys.push({
			columns: ix.columns.map(c => c.index),
			collations: ix.columns.map(c => c.collation ?? columnCollation(c.index)),
		});
	}
	return keys;
}

/**
 * True when an equality's comparison collation is at least as fine as the
 * key's enforcement collation — every pair of rows the equality treats as
 * equal, the key treats as equal too, so uniqueness forbids a second match.
 * Two name-only tests prove it without a collation lattice (collations are
 * opaque comparators): the predicate compares BINARY — byte identity, the
 * finest relation there is, so at most one row per class under ANY coarser key
 * collation — or the two normalize to the same name (identical classes). A
 * COARSER predicate fails both: a `NOCASE` join key over a `BINARY` unique
 * column admits `'a'` and `'A'`, two distinct stored rows that both match.
 * `NOCASE` / `RTRIM` are mutually incomparable and fail too. The same two
 * tests as `coveringMvHonorsIndexCollation`, applied in the other direction.
 */
function equalityRefinesKey(constraint: PredicateConstraint, keyCollation: string | undefined): boolean {
	const pred = normalizeCollationName(effectivePredicateCollation(constraint));
	const key = normalizeCollationName(keyCollation ?? 'BINARY');
	return pred === 'BINARY' || pred === key;
}

/**
 * An equality pins ONE value per outer row only when its value side is
 * deterministic. A constraint re-applied as a Filter is re-evaluated per inner
 * row, so `b.id = random()` admits a different id on every row and several can
 * pass — nothing upstream gates non-deterministic predicates out of pushdown
 * (`rule-select-access-path` has no such test), so the proof must. A literal
 * has no value expression and trivially qualifies; a correlated column
 * reference is deterministic for the duration of one outer row.
 */
function pinsOneValue(constraint: PredicateConstraint): boolean {
	const value = constraint.valueExpr;
	if (value === undefined) return true;
	if (Array.isArray(value)) return false; // an IN list never reaches here (op !== '='); be explicit
	return PlanNodeCharacteristics.isDeterministic(value);
}

/**
 * PROOF — not an estimate — that the inner rebuilt from `combined` yields at
 * most one row per outer row. `FanOutLookupJoinNode`'s `atMostOne-*` branch
 * modes throw `QuereusError(CONSTRAINT)` at runtime on a second row, so the
 * module's `rows: 1` estimate must not stand in: a module that estimates 1 and
 * returns 2 would turn a working query into an error.
 *
 * Premise: every constraint in `combined` is enforced somewhere inside the
 * rebuilt inner — the candidate's own correctness argument (re-promised by the
 * new seek, reattached by `selectPhysicalNode`, re-applied by
 * `reapplyDeclinedPushed`, or for a join-key leftover by the ON condition the
 * caller keeps above the seek). A Filter only removes rows, so a constraint
 * enforced by a filter rather than by the index counts just the same. Then: if
 * some enforced key has EVERY column pinned by an equality whose collation
 * refines the key's ({@link equalityRefinesKey}), any two surviving rows agree
 * on the whole key and uniqueness forbids the second. Ranges, IN and OR_RANGE
 * admit many values and never contribute. Over-fetch is harmless — a
 * `COARSER_SAFE` seek's residual Filter re-applies the exact comparison above
 * it — and the finer-index case (`MISMATCH_UNSAFE`) never reaches here: it
 * degrades to a scan in `selectPhysicalNode` and `rebuiltSeek` declines the
 * candidate first. NULL keys need no case: `col = NULL` matches nothing.
 *
 * Exported for direct unit coverage; it is the correctness core of the batched
 * candidate.
 */
export function provesAtMostOne(tableSchema: TableSchema, combined: readonly PredicateConstraint[]): boolean {
	const equalitiesByColumn = new Map<number, PredicateConstraint[]>();
	for (const c of combined) {
		if (c.op !== '=' || !pinsOneValue(c)) continue;
		const list = equalitiesByColumn.get(c.columnIndex);
		if (list) list.push(c); else equalitiesByColumn.set(c.columnIndex, [c]);
	}
	if (equalitiesByColumn.size === 0) return false;
	// A column pinned by several equalities (a pushed `b.id = 5` beside the join
	// key) is proved by ANY one of them: the surviving rows satisfy all of them,
	// so they are a subset of the rows the refining one admits.
	return enforcedKeys(tableSchema).some(key => key.columns.every((col, i) =>
		(equalitiesByColumn.get(col) ?? []).some(eq => equalityRefinesKey(eq, key.collations[i]))));
}

/**
 * The `IndexSeekNode` under `rebuilt`'s collation-residual Filter, or null when
 * `selectPhysicalNode` produced something else. It degrades to a SeqScan +
 * residual on a collation decline (MISMATCH_UNSAFE — the seek would
 * under-fetch) and to an EmptyResultNode on an "impossible" predicate; both
 * mean no index-nested-loop here. An EmptyResultNode in particular must NOT be
 * adopted — it would be sound only if the join key were provably literal
 * NULL, which a dynamic per-outer-row binding never is.
 */
function rebuiltSeek(rebuilt: RelationalPlanNode): IndexSeekNode | null {
	let probe: RelationalPlanNode = rebuilt;
	while (probe instanceof FilterNode) probe = probe.source;
	return probe instanceof IndexSeekNode ? probe : null;
}

/**
 * Try to build an index-nested-loop candidate: the `inner` subtree rebuilt with
 * its access leaf replaced by an `IndexSeekNode` correlated to `outer`, plus
 * its engine-currency cost. Returns null when any gate declines; the caller's
 * nested-loop / hash / merge competition is then unchanged.
 *
 * `joinType` is the type the REBUILT join will have with `outer` on the left
 * (so a mirrored inner join passes 'inner'). `equiPairs` must be non-empty and
 * oriented left=outer / right=inner — the caller flips them for the mirror.
 * `outerRows` is the outer side's row estimate, the same input hash and merge
 * selection use for that side.
 */
export function tryIndexNestedLoop(
	joinType: JoinType,
	outer: RelationalPlanNode,
	inner: RelationalPlanNode,
	equiPairs: readonly EquiJoinPair[],
	outerRows: number,
	context: OptContext,
): IndexNestedLoopCandidate | null {
	// Only the left-driven join types: the nested-loop emitter installs the left
	// row slot before re-opening the right pipeline (driveFromLeft), which is
	// what makes the correlated seek keys resolve. `right` / `full` drive from
	// the right with no left slot installed. `cross` never reaches here (no
	// condition ⇒ no equi pairs).
	if (joinType !== 'inner' && joinType !== 'left' && joinType !== 'semi' && joinType !== 'anti') return null;

	// Purity gate. Determinism is deliberately NOT gated: the nested loop
	// already re-executes the inner side once per outer row, so replacing a scan
	// with a seek does not change how often a non-deterministic inner runs.
	// (rule-key-set-seek gates determinism because it drains its key source
	// exactly once — a different execution-count contract.)
	if (PlanNodeCharacteristics.subtreeHasSideEffects(inner)) {
		log('decline: inner side has side effects');
		return null;
	}

	const admitted = admitLeaf(inner);
	if (!admitted) return null;
	const { leaf, pushed } = admitted;

	const resolved = resolvePairs(leaf, outer, equiPairs);
	if (!resolved || resolved.length === 0) return null;

	// Synthesize `leaf.col = outer.col` and run it through the same constraint
	// extraction a pushed user predicate gets.
	const predicate = buildSeekPredicate(leaf, outer, resolved);
	const tableSchema = leaf.tableSchema;
	const tInfo = createTableInfoFromNode(leaf.source, `${tableSchema.schemaName}.${tableSchema.name}`);
	const extraction = extractConstraints(predicate, [tInfo]);
	const joinKeys = extraction.constraintsByTable.get(tInfo.relationKey) ?? [];

	// Orientation assertion: every conjunct must have extracted as an equality
	// on an INNER column with a correlated (per-outer-row) binding, with nothing
	// left over. Inner-side-first construction makes this hold today; the check
	// is here so a future extractor change declines loudly instead of seeking on
	// the wrong column.
	if (joinKeys.length !== resolved.length || extraction.residualPredicate !== undefined
		|| !joinKeys.every(c => c.op === '=' && c.correlated === true
			&& tInfo.columnIndexMap.has(c.attributeId))) {
		log('decline: constraint extraction did not return %d oriented correlated equalities', resolved.length);
		return null;
	}

	const offered = offerConstraints(joinKeys, pushed);
	const seekPlan = probeModule(context, leaf, offered);
	if (!seekPlan) return null;

	// Reuse the full access-path machinery: collation cover (over the real
	// `innerCol = outerCol` source expressions, so the join key's RESOLVED
	// comparison collation is what gets checked), composite seeks, NULL
	// handling, and reattachUnconsumedConstraints all come from
	// selectPhysicalNode.
	const rebuiltLeaf = selectPhysicalNode(leaf.source, seekPlan, [...offered.combined]);
	const seek = rebuiltSeek(rebuiltLeaf);
	if (!seek) {
		log('decline: selectPhysicalNode did not produce an IndexSeek');
		return null;
	}
	// The new seek must really be keyed on the join — its recorded provenance
	// must include a join-key constraint by identity. Otherwise the module
	// re-minted the seek it already had (a pushed equality on the seek column
	// won the per-column pick) and nothing is correlated.
	if (!seek.pushedConstraints?.some(c => joinKeys.includes(c))) {
		log('decline: the rebuilt seek is not keyed on the join');
		return null;
	}

	const newLeaf = reapplyDeclinedPushed(rebuiltLeaf, seekPlan, offered);
	const newInner = rebuildChain(inner, leaf, newLeaf);
	const perSeekLatencyMs = inner.physical.expectedLatencyMs ?? 0;
	const rowsPerSeek = seekPlan.rows!;
	const cost = indexNestedLoopJoinCost(outerRows, rowsPerSeek, perSeekLatencyMs);
	const atMostOne = provesAtMostOne(tableSchema, offered.combined);
	log('candidate: seek %s.%s via %s (%s rows/seek, cost %s for %s outer rows; %d pushed constraint(s) re-offered; at-most-one %s)',
		tableSchema.name, seekPlan.seekColumnIndexes!.map(c => tableSchema.columns[c]?.name).join(','),
		seekPlan.indexName, seekPlan.rows, cost, outerRows, pushed.length, atMostOne ? 'proved' : 'unproved');
	return { newInner, cost, rowsPerSeek, perSeekLatencyMs, atMostOne };
}
