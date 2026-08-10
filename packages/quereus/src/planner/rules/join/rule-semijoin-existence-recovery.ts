/**
 * Rule: Semi/Anti-Join Existence-Flag Recovery (demand-SHAPE gated)
 *
 * The complement of `join-existence-pruning`. That rule drops an `exists … as`
 * flag only when **nothing** demands its attr id (a demand-PRESENCE prune). This
 * rule handles the opposite shape: the flag **is** demanded, but **only** as a
 * pure boolean existence probe at the top level
 * (`where <flag>` / `where not <flag>`). That is exactly a semi / anti-join, and
 * rewriting it as one re-opens the access-path choice the live flag forfeits
 * (`join-physical-selection`) and threads into the IND-folding cascade
 * (`semi-join-fk-trivial` / `anti-join-fk-empty`).
 *
 *   select c.* from child c left join parent p on p.pk = c.fk exists right as h
 *     where h;        -- ⇒ SemiJoin(child, parent, p.pk = c.fk)   (rows WITH a match)
 *     where not h;    -- ⇒ AntiJoin(child, parent, p.pk = c.fk)   (rows with NO match)
 *
 * This is a **pure optimization**: the nested-loop+flag plan is already correct,
 * just slower than the semi/anti shape. The deliverable is byte-identical rows
 * plus a re-enabled physical/IND cascade.
 *
 * ## Two entrypoints (mirrors `join-existence-pruning` / `…UnderAggregate`)
 *
 * The rule has two anchors sharing ALL of the probe-detection + chain-rewrite
 * machinery below. `ruleSemijoinExistenceRecovery` fires on a `ProjectNode` (the
 * common `select … where flag` shape). `ruleSemijoinExistenceRecoveryUnderAggregate`
 * fires on an `AggregateNode` for the bare `count(*) … where flag` / `group by`
 * shape that plans with **no enclosing Project** — the probe Filter and the
 * flag-bearing join sit *under* the Aggregate, so the Project entrypoint walks
 * right past them. The two differ only in the demand-seed prologue (projections
 * vs group-by + aggregate expressions — each anchor's only scalar children) and
 * the rebuild epilogue (`rebuildProject` vs reconstructing the `AggregateNode`
 * with `preserveAttributeIds`); the sole-spec / `left` / `side==='right'` gates,
 * the demand-SHAPE proof (`analyzeChain`, which takes a *pre-seeded* demand set),
 * the fan-out guard (semi only), the impure-R guard, and the probe-strip rebuild
 * are identical. NOTE: the Aggregate anchor has **no** inner-join fallback — a
 * right-column-demanded or fan-out *positive* probe under an aggregate stays a
 * flag-bearing `left` join (sound, just unoptimized), unlike the Project anchor
 * which hands those off to `rule-inner-join-existence-recovery`.
 *
 * ## Q1 — Anchor: `ProjectNode`, not `FilterNode`
 *
 * A `FilterNode` anchor (mirroring `ruleSubqueryDecorrelation`) would be UNSOUND
 * here. Decorrelation is output-preserving at the Filter level
 * (`Filter[EXISTS](outer)` and `SemiJoin(outer,inner)` both expose *outer*'s
 * columns), so it never has to look above the Filter. Our probe Filter sits above
 * a `left join` whose output is `[left…, right…, flag]` and passes all of it
 * through; rewriting the join to semi changes the Filter's output to `[left…]` —
 * dropping the right columns and the flag. Soundness therefore REQUIRES proving
 * that nothing above the Filter references a right-side column or the flag (except
 * the probe we strip), and a rule only sees its own subtree. `ProjectNode` is the
 * correct anchor for the same reason `join-existence-pruning` uses it: a Project's
 * output is exactly one attribute per projection, so collecting demand from the
 * projections bounds everything any ancestor can reference. The probe Filter is
 * reached via the same whitelisted pass-through chain (`walkChain`) and rewritten
 * in place during chain reconstruction.
 *
 * ## Q2 — Demand-SHAPE proof ("used ONLY as a boolean probe")
 *
 * Let `J` be the flag-bearing `JoinNode` reached by the chain walk, with sole
 * existence spec `f` (`flagId = f.attrId`). The rewrite is legal iff:
 *
 *  1. **Sole probe conjunct.** Across all chain `FilterNode`s, split each
 *     predicate with `splitConjuncts`. Exactly **one** conjunct references
 *     `flagId`, and it is in an accepted probe normal form (below). Any other
 *     reference to `flagId` anywhere disqualifies.
 *  2. **Flag absent from the residual demand set.** `demanded` is built from the
 *     anchor Project's projections, every chain Filter's **non-probe** conjuncts,
 *     and every chain Sort's keys (Limit/Distinct/Alias contribute nothing).
 *     Require `!demanded.has(flagId)` — this catches a flag selected or sorted on.
 *  3. **No right-side column demanded.** The semi/anti output is left columns
 *     only, so `demanded ∩ {J.right attr ids} === ∅`. `select c.*, p.col … where
 *     f` lands here and abstains — `rule-inner-join-existence-recovery` then picks
 *     it up and rewrites to an inner join (NOT a semi-join shape). Unqualified
 *     `select * … where f` is different: `*` expands the join-appended flag too, so
 *     the flag itself is demanded — this rule abstains on (2), and the inner rule
 *     abstains on `!demanded.has(flagId)`; the flag is correctly retained (the
 *     caller selected it).
 *
 * **Accepted probe normal forms** (each conjunct normalized with
 * `normalizePredicate` first — collapses `not not f`, pushes NOT down):
 *
 *  | Form              | Node shape after normalize                          | Polarity |
 *  |-------------------|-----------------------------------------------------|----------|
 *  | `f`               | `ColumnReferenceNode`, `attributeId === flagId`     | semi     |
 *  | `not f`           | `UnaryOpNode` NOT over that colref                  | anti     |
 *  | `f = true`        | `BinaryOpNode` `=`, flag colref vs boolean `true`   | semi     |
 *  | `f = false`       | `BinaryOpNode` `=`, flag colref vs boolean `false`  | anti     |
 *  | `f is true`       | `UnaryOpNode` `IS TRUE` over that colref            | semi     |
 *  | `f is not false`  | `UnaryOpNode` `IS NOT FALSE` over that colref       | semi     |
 *  | `f is false`      | `UnaryOpNode` `IS FALSE` over that colref           | anti     |
 *  | `f is not true`   | `UnaryOpNode` `IS NOT TRUE` over that colref        | anti     |
 *
 * The `is not false` / `is not true` collapses (≡ `= true` / `= false`) are exact
 * only because the flag is provably non-null (`EXISTENCE_FLAG_TYPE.nullable ===
 * false`): with no NULL row there is no third bucket for `is not` to admit. For the
 * same reason `f is [not] null` is NOT a probe over the non-null flag (`is not null`
 * is a constant `true`, `is null` a constant `false`) and the matcher abstains.
 * `case`-wrapped probes are out of scope (file a fresh backlog ticket if a real
 * workload ever produces them).
 *
 * ## Q3 — left/right/inner → semi/anti mapping
 *
 * The parser (`resolveExistenceSide`) rejects `exists … as` on inner/cross joins.
 * RIGHT/FULL flag-bearing joins now execute (`emitLoopJoin` drives them directly),
 * but this rule deliberately handles only the `left join … exists right as` shape,
 * giving the complete table:
 *
 *  | Join type | spec.side | probe         | rewrite               | rows kept           |
 *  |-----------|-----------|---------------|-----------------------|---------------------|
 *  | `left`    | `right`   | `where f`     | `semi(L, R, cond)`    | L rows WITH a match |
 *  | `left`    | `right`   | `where not f` | `anti(L, R, cond)`    | L rows with NO match |
 *
 * The rule is guarded by `joinType === 'left' && spec.side === 'right'`; a RIGHT /
 * FULL origin keeps its nested-loop join (abstaining is always sound — it merely
 * forgoes the semi/anti rewrite), and inner flags are unreachable. Both are
 * explicitly out of scope.
 * The semi/anti node takes the LEFT side's attributes only (the flag column
 * disappears), which the Q2 checks guarantee the consuming Project tolerates.
 *
 * ## Q4 — Multi-flag joins: only fire when the probe is the SOLE existence spec
 *
 * A semi/anti join collapses the right side and cannot also emit other flags, so a
 * mixed join (one probe flag + other selected flags) cannot be split. We require
 * `J.existence.length === 1`. When other flags are merely *undemanded*, the base
 * `join-existence-pruning` rule (runs first) drops them, leaving a sole flag this
 * rule then recovers in a later `applyRules` iteration. The genuinely-mixed case
 * (≥2 demanded flags) is left unoptimized.
 *
 * ## Q5 — Fan-out guard (SEMI only) + residual ON-condition
 *
 * **A plain `left join … exists right as` does NOT collapse to one row per left
 * row.** `emitLoopJoin` yields one output row per MATCHING right row, each
 * carrying flag=true (it is a normal left join with an extra computed bit, not an
 * existence-semantics join). So `where f` keeps **K rows** for a left row with K
 * matches, while `semi(L,R,cond)` keeps exactly **one**. The two are row-equal
 * iff every left row matches AT MOST ONE right row. We therefore gate the SEMI
 * rewrite on `rightMatchesAtMostOne(J)` — the equi-join columns of `J.condition`
 * must cover a unique key of R (`isUnique`), which holds for FK→PK joins (R's PK
 * covered) and ≤1-row R (the empty key). A non-equi / non-unique condition (where
 * a left row can match several R rows) makes the SEMI shape unsound and the rule
 * abstains. **`rule-inner-join-existence-recovery` now picks up that abstention
 * point:** a positive no-right-col probe over a fan-out (non-unique) R is recovered
 * to a fan-out-safe **inner** join (which does NOT collapse K→1) — so the two rules
 * partition the entire positive-probe space (unique-R → semi here; fan-out → inner
 * fallback), both consulting the SAME `rightMatchesAtMostOne` so the boundary never
 * drifts. The condition is otherwise carried `J.condition` UNCHANGED: a residual
 * conjunct on top of a covered unique key only narrows the ≤1 match further (still
 * ≤1), so the downstream IND folders may abstain on the residual and leave a plain
 * semi join — still a win.
 *
 * The **ANTI** path needs no such guard (and `rightMatchesAtMostOne` is not
 * consulted for it): see Q6.
 *
 * ## Q6 — Outer-side preservation / NULL semantics + anti fan-out immunity
 *
 * The flag is `{true,false}` and never NULL (`EXISTENCE_FLAG_TYPE.nullable ===
 * false`; `emitLoopJoin` pre-computes matched=`true` / unmatched=`false` for an
 * `exists right as` spec). For the ANTI rewrite this makes the split exact under
 * arbitrary fan-out: an UNMATCHED left row yields exactly one null-extended row
 * (flag=false) — one per left row, never K — and every MATCHED row carries
 * flag=true and is dropped by `where not f`. So `where not f` keeps exactly the
 * unmatched left rows, one each = `anti(L,R,cond)` for any `cond`, no fan-out
 * hazard. (The SEMI side keeps matched rows, where the K-vs-1 divergence lives —
 * hence the Q5 guard.)
 *
 * ## Q7 — Write-half safety (excluded by construction) + impure-R guard
 *
 * A flag writable through a view is always SELECTed by that view's routing
 * Project, so it lands in `demanded` and Q2's "flag absent from demanded" check
 * abstains — the write path can never reach this rewrite. (Mirrors
 * `join-existence-pruning`'s by-construction argument.) Separately, a semi join
 * short-circuits the R scan at the first match, changing R's *execution count*, so
 * we guard impure R with `subtreeHasSideEffects(J.right)` and register the rule
 * `sideEffectMode: 'aware'` (mirroring `subquery-decorrelation`, which likewise
 * refuses an impure inner). The flag-drop itself is read-only; the guard is purely
 * about R's iteration count.
 *
 * **Termination.** The output is a semi/anti join with no existence spec, so
 * re-running the rule no-ops (the anchor requires a flag-bearing `left` join
 * below). No rewrite loop.
 */

import { createLogger } from '../../../common/logger.js';
import type { PlanNode, RelationalPlanNode, ScalarPlanNode } from '../../nodes/plan-node.js';
import { isRelationalNode } from '../../nodes/plan-node.js';
import type { OptContext } from '../../framework/context.js';
import { ProjectNode } from '../../nodes/project-node.js';
import { AggregateNode } from '../../nodes/aggregate-node.js';
import { FilterNode } from '../../nodes/filter.js';
import { JoinNode, type JoinType, extractEquiPairsFromCondition } from '../../nodes/join-node.js';
import { ColumnReferenceNode } from '../../nodes/reference.js';
import { UnaryOpNode, BinaryOpNode, LiteralNode } from '../../nodes/scalar.js';
import { normalizePredicate } from '../../analysis/predicate-normalizer.js';
import { splitConjuncts, combineConjuncts } from '../../analysis/predicate-conjuncts.js';
import { PlanNodeCharacteristics } from '../../framework/characteristics.js';
import { isUnique, type KeyRel } from '../../util/fd-utils.js';
import {
	collectAttrIds,
	walkChain,
	rebuildChain,
	rebuildProject,
	type ChainEntry,
} from './rule-join-elimination.js';

const log = createLogger('optimizer:rule:semijoin-existence-recovery');

/**
 * The single probe conjunct located across the chain's FilterNodes.
 *
 * Exported (with `analyzeChain` / `classifyProbe` / `rebuildChainStrippingProbe`)
 * for reuse by the sibling `rule-inner-join-existence-recovery`, which shares the
 * exact same probe machinery — it merely keeps the `'semi'` (positive) polarity
 * and the right-column-demanded half of the partition this rule abstains on.
 */
export interface ProbeMatch {
	/** Index into `chain` of the FilterNode that holds the probe conjunct. */
	chainIndex: number;
	/** That filter. */
	filter: FilterNode;
	/** The filter's NON-probe conjuncts (already folded into `demanded`). */
	residualConjuncts: ScalarPlanNode[];
	/** `semi` for a `where f` probe, `anti` for `where not f`. */
	polarity: 'semi' | 'anti';
}

export function ruleSemijoinExistenceRecovery(node: PlanNode, _context: OptContext): PlanNode | null {
	if (!(node instanceof ProjectNode)) return null;

	// `walkChain` mutates its `demanded` set; we ignore it (a throwaway here) and
	// recompute demand conjunct-by-conjunct below so the probe can be excluded.
	const walk = walkChain(node.source, new Set<number>());
	if (!walk) return null;

	const { join, chain } = walk;

	// Only the reachable flag-bearing shape: a `left join … exists right as` with
	// a SOLE existence spec (Q3 / Q4). A mixed join cannot be split into a semi.
	if (join.joinType !== 'left') return null;
	if (!join.hasExistenceColumns) return null;
	const existence = join.existence!;
	if (existence.length !== 1) return null;
	const spec = existence[0];
	if (spec.side !== 'right') return null;
	if (!join.condition) return null;
	const flagId = spec.attrId;

	// Demand-SHAPE analysis: seed `demanded` from the Project's projections (the
	// anchor's only scalar children that an ancestor can reference), then
	// `analyzeChain` folds in the chain's non-probe conjuncts + sort keys and
	// locates/classifies the sole probe conjunct (Q2). The returned `demanded` is
	// the same set we passed in.
	const demanded = new Set<number>();
	for (const proj of node.projections) {
		collectAttrIds(proj.node, demanded);
	}
	const analysis = analyzeChain(demanded, chain, flagId);
	if (!analysis) return null;
	const { probe } = analysis;

	// The flag must not be demanded anywhere but the stripped probe (a flag that is
	// selected or sorted on lands in `demanded` via projections / sort keys).
	if (demanded.has(flagId)) return null;

	// The semi/anti output is left columns only — abstain if any right column is
	// demanded (that is the deferred outer→inner conversion, not a semi-join).
	const rightAttrIds = join.right.getAttributes().map(a => a.id);
	for (const id of rightAttrIds) {
		if (demanded.has(id)) return null;
	}

	// SOUNDNESS — fan-out guard (SEMI only). A plain `left join … exists right as`
	// does NOT collapse to one row per left row: the nested-loop emitter yields one
	// output row per MATCHING right row, each carrying flag=true (see
	// `emitLoopJoin`). So `where flag` keeps K rows for a left row with K matches,
	// whereas a semi join keeps exactly one — the two diverge whenever a left row
	// can match more than one right row. They agree iff every left row matches AT
	// MOST ONE right row, i.e. the equi-join columns cover a unique key of the right
	// side. The ANTI path is immune: an unmatched left row yields exactly one
	// null-extension regardless of fan-out, and matched rows are filtered out, so
	// `anti(L,R,cond)` equals `left join … where not flag` for arbitrary `cond`.
	if (probe.polarity === 'semi' && !rightMatchesAtMostOne(join)) {
		log('Semi recovery skipped: right side may match >1 row per left row (fan-out)');
		return null;
	}

	// A semi join short-circuits the R scan at the first match — refuse to change
	// R's execution count when R carries a write (Q7).
	if (PlanNodeCharacteristics.subtreeHasSideEffects(join.right)) {
		log('Recovery skipped: right side has side effects');
		return null;
	}

	const newJoinType: JoinType = probe.polarity;
	const semiAnti = new JoinNode(
		join.scope,
		join.left,
		join.right,
		newJoinType,
		join.condition, // carry the full ON condition verbatim (Q5)
		// no usingColumns, no existence — the flag column disappears.
	);

	log('Recovered %s join from probe-only existence flag %s', newJoinType, spec.name);

	const newSource = rebuildChainStrippingProbe(chain, probe, semiAnti);
	return rebuildProject(node, newSource);
}

/**
 * Aggregate counterpart of `ruleSemijoinExistenceRecovery` (see the "Two
 * entrypoints" note in the file header). When the flag-bearing `left join … exists
 * right as` sits under a bare aggregate (`select count(*) from … where flag`,
 * `select flag, count(*) … group by flag`) with **no enclosing Project**, the probe
 * Filter and the join sit *under* the AggregateNode, so the Project entrypoint never
 * fires. This anchor walks down from the Aggregate's source through the SAME
 * whitelisted pass-through chain to the flag-bearing join, runs the SAME demand-SHAPE
 * proof, fan-out guard (semi only), and impure-R guard, and rebuilds the SAME
 * probe-stripped chain — differing from the Project entrypoint in only two places:
 *
 *  - **Demand-seed prologue.** Seed `demanded` from the Aggregate's group-by
 *    expressions + every aggregate expression (its only scalar children) instead of
 *    a Project's projections. A flag *grouped on* (`group by flag`) lands in
 *    `demanded` and abstains; an aggregate over a right column (`count(p.pv)`) lands
 *    a right attr id in `demanded` and abstains.
 *  - **Rebuild epilogue.** Reconstruct the `AggregateNode` with `preserveAttributeIds`
 *    so its output ids stay stable (mirrors `ruleJoinExistencePruningUnderAggregate`
 *    / `ruleJoinEliminationUnderAggregate`).
 *
 * Unlike the Project anchor there is **no inner-join fallback**: a positive probe
 * with a right column demanded, or over a fan-out (non-unique) R, simply stays a
 * flag-bearing `left` join (sound, just unoptimized) — the `count(*) … where flag`
 * shape is the target, and the inner-only cardinality cascade is out of scope here.
 *
 * HAVING does not block: `having count(*) > 0` is a `FilterNode` *above* the
 * Aggregate that can only reference the Aggregate's outputs (group keys / aggregate
 * results), never the raw flag — so it never appears in `walkChain` and needs no
 * handling (mirrors the HAVING note in `ruleJoinExistencePruningUnderAggregate`).
 */
export function ruleSemijoinExistenceRecoveryUnderAggregate(node: PlanNode, _context: OptContext): PlanNode | null {
	if (!(node instanceof AggregateNode)) return null;

	// `walkChain` mutates its `demanded` set; we ignore it (a throwaway) and seed
	// demand from the Aggregate's scalar children below, so the probe can be excluded.
	const walk = walkChain(node.source, new Set<number>());
	if (!walk) return null;

	const { join, chain } = walk;

	// Same reachable flag-bearing shape as the Project entrypoint: a `left join …
	// exists right as` with a SOLE existence spec. A mixed join cannot be split;
	// `join-existence-pruning-aggregate` strips an undemanded sibling first.
	if (join.joinType !== 'left') return null;
	if (!join.hasExistenceColumns) return null;
	const existence = join.existence!;
	if (existence.length !== 1) return null;
	const spec = existence[0];
	if (spec.side !== 'right') return null;
	if (!join.condition) return null;
	const flagId = spec.attrId;

	// Demand-seed prologue — the ONLY divergence from the Project rule's demand
	// half. The Aggregate's group-by + aggregate expressions are its only scalar
	// children, so they bound everything any ancestor can reference.
	const demanded = new Set<number>();
	for (const groupExpr of node.groupBy) {
		collectAttrIds(groupExpr, demanded);
	}
	for (const agg of node.aggregates) {
		collectAttrIds(agg.expression, demanded);
	}

	const analysis = analyzeChain(demanded, chain, flagId);
	if (!analysis) return null;
	const { probe } = analysis;

	// The flag must not be demanded anywhere but the stripped probe (a flag that is
	// grouped on lands in `demanded` via groupBy and abstains).
	if (demanded.has(flagId)) return null;

	// The semi/anti output is left columns only — abstain if any right column is
	// demanded (an aggregate over a right column, e.g. `count(p.pv)`, lands here).
	// There is no aggregate inner fallback in scope, so the join stays `left`.
	const rightAttrIds = join.right.getAttributes().map(a => a.id);
	for (const id of rightAttrIds) {
		if (demanded.has(id)) return null;
	}

	// Fan-out guard (SEMI only), identical to the Project rule (Q5): a plain
	// `left join … exists right as` yields K rows per matched left row, whereas a
	// semi join keeps one — sound only when every left row matches ≤1 right row.
	// The ANTI path is immune (one null-extension per unmatched row, any fan-out).
	if (probe.polarity === 'semi' && !rightMatchesAtMostOne(join)) {
		log('Aggregate semi recovery skipped: right side may match >1 row per left row (fan-out)');
		return null;
	}

	// A semi join short-circuits the R scan at the first match — refuse to change
	// R's execution count when R carries a write (Q7).
	if (PlanNodeCharacteristics.subtreeHasSideEffects(join.right)) {
		log('Aggregate recovery skipped: right side has side effects');
		return null;
	}

	const newJoinType: JoinType = probe.polarity;
	const semiAnti = new JoinNode(
		join.scope,
		join.left,
		join.right,
		newJoinType,
		join.condition, // carry the full ON condition verbatim (Q5)
		// no usingColumns, no existence — the flag column disappears.
	);

	log('Recovered %s join under Aggregate from probe-only existence flag %s', newJoinType, spec.name);

	const newSource = rebuildChainStrippingProbe(chain, probe, semiAnti);
	if (!isRelationalNode(newSource)) {
		throw new Error('rule-semijoin-existence-recovery-aggregate: rebuilt source must be relational');
	}
	return new AggregateNode(
		node.scope,
		newSource,
		node.groupBy,
		node.aggregates,
		undefined,             // estimatedCostOverride
		node.getAttributes(),  // preserveAttributeIds — keep the Aggregate's output ids stable
	);
}

/**
 * Fold the chain's residual demand into the caller-supplied `demanded` set and
 * locate the sole probe conjunct. `demanded` is **pre-seeded by the caller** from
 * its anchor's scalar children (a Project's projections, or an Aggregate's
 * group-by + aggregate expressions); this routine adds every chain Filter's
 * NON-probe conjuncts and every chain Sort's keys (Limit/Distinct/Alias add
 * nothing). The set is mutated in place and also returned for the caller's
 * convenience. After the call, `demanded` is everything any ancestor of the
 * anchor can reference EXCEPT the single stripped probe conjunct.
 *
 * Returns null when the demand SHAPE disqualifies the rewrite: no probe found,
 * the flag referenced in more than one conjunct, or the flag inside a non-probe
 * conjunct shape (`f or x`, `f(x)`, …).
 */
export function analyzeChain(
	demanded: Set<number>,
	chain: ReadonlyArray<ChainEntry>,
	flagId: number,
): { demanded: Set<number>; probe: ProbeMatch } | null {
	let probe: ProbeMatch | null = null;

	for (let i = 0; i < chain.length; i++) {
		const entry = chain[i];
		switch (entry.kind) {
			case 'filter': {
				const conjuncts = splitConjuncts(entry.node.predicate);
				const flagConjuncts: ScalarPlanNode[] = [];
				const nonFlagConjuncts: ScalarPlanNode[] = [];
				for (const conj of conjuncts) {
					if (referencesAttr(conj, flagId)) {
						flagConjuncts.push(conj);
					} else {
						nonFlagConjuncts.push(conj);
						collectAttrIds(conj, demanded);
					}
				}
				if (flagConjuncts.length > 0) {
					// More than one flag reference (here or already seen) ⇒ not a sole probe.
					if (flagConjuncts.length > 1 || probe !== null) return null;
					const polarity = classifyProbe(flagConjuncts[0], flagId);
					if (!polarity) return null; // flag in a non-probe conjunct shape
					probe = {
						chainIndex: i,
						filter: entry.node,
						residualConjuncts: nonFlagConjuncts,
						polarity,
					};
				}
				break;
			}
			case 'sort': {
				for (const k of entry.node.sortKeys) {
					collectAttrIds(k.expression, demanded);
				}
				break;
			}
			// LimitOffset / Distinct / Alias demand nothing.
		}
	}

	if (!probe) return null;
	return { demanded, probe };
}

/**
 * True iff every left row matches AT MOST ONE right row under `join.condition` —
 * the precondition for a sound SEMI rewrite (see the fan-out guard at the call
 * site). Holds when the equi-join columns cover a unique key of the right side
 * (`isUnique`), which subsumes both the FK→PK case (right PK covered) and a
 * ≤1-row right relation (the empty key, when there are no equi-pairs). Reads the
 * right side's full uniqueness surface — declared keys plus FD-derived keys via
 * `physical` — exactly as `JoinNode.computePhysical` does.
 *
 * Exported for `rule-inner-join-existence-recovery`, which consults the SAME
 * predicate to decide its abstention boundary: it defers to this (semi) rule only
 * where R is unique (≤1 match ⇒ the leaner semi join is sound and strictly
 * better), and fires the fan-out-safe inner fallback where R is NOT unique (semi
 * abstains here). Sharing one function makes the two rules agree on the
 * unique/fan-out boundary by construction — no drift.
 */
export function rightMatchesAtMostOne(join: JoinNode): boolean {
	const leftAttrs = join.left.getAttributes();
	const rightAttrs = join.right.getAttributes();
	const pairs = extractEquiPairsFromCondition(join.condition, leftAttrs, rightAttrs);
	const rightRel: KeyRel = { getType: () => join.right.getType(), physical: join.right.physical };
	return isUnique(pairs.map(p => p.right), rightRel);
}

/**
 * Classify a flag-referencing conjunct as a probe normal form (Q2). The conjunct
 * is normalized first so `not not f` collapses and NOT pushes down. Returns the
 * resulting join polarity, or null when the shape is not a pure probe.
 */
export function classifyProbe(conj: ScalarPlanNode, flagId: number): 'semi' | 'anti' | null {
	const n = normalizePredicate(conj);

	// `f` — bare boolean colref.
	if (n instanceof ColumnReferenceNode) {
		return n.attributeId === flagId ? 'semi' : null;
	}

	// `not f` — NOT over the flag colref.
	if (n instanceof UnaryOpNode && n.expression.operator === 'NOT') {
		if (n.operand instanceof ColumnReferenceNode && n.operand.attributeId === flagId) {
			return 'anti';
		}
		return null;
	}

	// `f is true` / `f is not false` (semi) and `f is false` / `f is not true`
	// (anti). The `is not …` collapses are EXACT only because the flag is provably
	// non-null (`EXISTENCE_FLAG_TYPE.nullable === false`): `f is not false` ≡ `f =
	// true` and `f is not true` ≡ `f = false` solely because no NULL row exists to
	// land in the `is not` bucket. `is [not] null` is deliberately NOT listed — over
	// the non-null flag it is a constant (`is not null` ≡ true, `is null` ≡ false),
	// not a probe — so it falls through to `return null` and the rule abstains.
	if (n instanceof UnaryOpNode && isFlagColRef(n.operand, flagId)) {
		switch (n.expression.operator) {
			case 'IS TRUE':
			case 'IS NOT FALSE': return 'semi';
			case 'IS FALSE':
			case 'IS NOT TRUE': return 'anti';
		}
	}

	// `f = true` / `true = f` (semi) and `f = false` / `false = f` (anti).
	if (n instanceof BinaryOpNode && n.expression.operator === '=') {
		const flagSide = isFlagColRef(n.left, flagId) ? n.left
			: isFlagColRef(n.right, flagId) ? n.right
			: null;
		if (!flagSide) return null;
		const other = flagSide === n.left ? n.right : n.left;
		const bool = booleanLiteralValue(other);
		if (bool === true) return 'semi';
		if (bool === false) return 'anti';
	}

	return null;
}

function isFlagColRef(node: ScalarPlanNode, flagId: number): boolean {
	return node instanceof ColumnReferenceNode && node.attributeId === flagId;
}

/** The boolean value of a boolean `LiteralNode`, or undefined for anything else. */
function booleanLiteralValue(node: ScalarPlanNode): boolean | undefined {
	if (node instanceof LiteralNode && typeof node.expression.value === 'boolean') {
		return node.expression.value;
	}
	return undefined;
}

/** True iff `attrId` is referenced by any `ColumnReferenceNode` in the subtree. */
function referencesAttr(node: PlanNode, attrId: number): boolean {
	if (node instanceof ColumnReferenceNode) {
		return node.attributeId === attrId;
	}
	for (const child of node.getChildren()) {
		if (referencesAttr(child, attrId)) return true;
	}
	return false;
}

/**
 * Rebuild the pass-through chain on top of the recovered join (`recovered` — a
 * semi/anti join here, an inner join in the sibling rule), stripping the sole
 * probe conjunct from its FilterNode (omitting the Filter entirely when no
 * residual conjunct remains). Reuses `rebuildChain` for the entries below and
 * above the probe filter; only the probe filter itself is special-cased.
 */
export function rebuildChainStrippingProbe(
	chain: ReadonlyArray<ChainEntry>,
	probe: ProbeMatch,
	recovered: RelationalPlanNode,
): RelationalPlanNode {
	// Chain is collected top→bottom; entries AFTER the probe are closer to the join.
	const below = chain.slice(probe.chainIndex + 1);
	const above = chain.slice(0, probe.chainIndex);

	let current = rebuildChain(below, recovered);

	const residualPred = combineConjuncts(probe.residualConjuncts);
	if (residualPred !== null) {
		current = new FilterNode(probe.filter.scope, current, residualPred);
	}
	// else: the probe was the filter's only conjunct — omit the Filter.

	return rebuildChain(above, current);
}
