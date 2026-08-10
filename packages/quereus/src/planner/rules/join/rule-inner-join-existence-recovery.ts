/**
 * Rule: Inner-Join Existence-Flag Recovery (demand-SHAPE gated)
 *
 * The **fallback complement** of `rule-semijoin-existence-recovery`. The semi rule
 * recovers a semi/anti join from a probe-only `exists … as` flag, but abstains on
 * TWO shapes of a POSITIVE probe: (a) a right-side column is demanded above the
 * join (a semi join exposes left columns only, so it would drop the very right
 * columns the caller needs), or (b) R **fans out** — a left row matches >1 right
 * row — where a semi join would (unsoundly) collapse K→1, dropping the duplicate
 * rows. This rule handles BOTH abstention points: a **positive** probe
 * (`where flag` ⇒ `semi` polarity) where **a right column is demanded OR R fans
 * out** rewrites the flag-bearing `left join` to a plain **inner join** — dropping
 * the flag, keeping both sides, and (unlike a semi join) preserving every
 * fanned-out match. Together the two rules partition the ENTIRE positive-probe space.
 *
 *   -- (a) right column demanded → keep R
 *   select c.cc, p.pv
 *     from exc c left join exp p on p.pp = c.pr exists right as hasP
 *     where hasP;        -- ⇒ inner join (matched rows only; p.pv is needed → keep R)
 *
 *   -- (b) no right column, but R fans out (cc=1 matches 3 rows) → semi would lose dups
 *   select c.cc
 *     from fc c left join fp p on p.pp = c.cc exists right as h
 *     where h;           -- ⇒ inner join (all K fanned rows kept; semi abstains here)
 *
 * Like the sibling, this is a **pure optimization** — byte-identical rows to the
 * flag-bearing nested-loop baseline — that re-opens inner-join physical selection
 * (`join-physical-selection` → hash/merge join), non-nullable right-column typing,
 * and the FK/IND reasoning the live flag pinned shut (the five flag-guarded join
 * rules re-enable once `hasExistenceColumns` flips false).
 *
 * ## Why this is sound (and SIMPLER than the semi rule)
 *
 * `emitLoopJoin` drives a `left join … exists right as` exactly like a normal left
 * join with one appended flag bit (`runtime/emit/join.ts` `driveFromLeft`):
 *
 *  - a matched left row with **K** matching right rows → **K** output rows, each
 *    `flag = true`;
 *  - an unmatched left row → **1** null-extended row, `flag = false`.
 *
 * A positive probe `where flag` keeps exactly the K matched rows per left row and
 * drops the unmatched. An **inner join** on the same condition yields exactly K
 * rows per matched left row and drops the unmatched. **Identical, row-for-row, for
 * ANY condition.** Three consequences distinguish this rule from the semi rule:
 *
 *  - **No fan-out guard needed for soundness.** A semi join collapses K→1, so the
 *    semi rule needs `rightMatchesAtMostOne`; an inner join does not collapse, so K
 *    matches stay K and this conversion is sound under ANY fan-out. We DO import
 *    `rightMatchesAtMostOne`, but only to locate the abstention boundary — defer to
 *    the leaner semi join exactly where it is sound (unique R, no right col) — never
 *    as a precondition for our own correctness.
 *  - **No condition-shape restriction.** Unlike `join-elimination` (AND-of-
 *    equalities + FK→PK), the inner conversion replays the flag's exact per-pair
 *    match, so non-equi / residual ON conditions are fine — carry `join.condition`
 *    verbatim.
 *  - **No NOT-NULL FK requirement.** A `NULL` FK never satisfies `p.pp = c.pr`, so
 *    it is unmatched under both the flag (`false`, dropped by `where flag`) and the
 *    inner join (no match). No NULL-FK row leaks.
 *
 * ## Attribute-id / nullability preservation
 *
 * `buildJoinAttributes` emits `[left…, right…]` for both `left` and `inner`, taking
 * right attribute ids **verbatim** from `rightAttrs`; the only difference is that
 * `left` marks the right columns `nullable: true` while `inner` keeps their
 * declared nullability. So the consuming Project/Filter resolves right columns by
 * attribute id (key-based addressing) and finds them at the same ids — no rebinding
 * needed — and dropping the flag (appended *after* both sides) shifts nothing. The
 * inner join's non-nullable right typing is a sound **strengthening**: after
 * `where flag` only matched rows survive, on which the right side is fully present.
 * That is the property that re-enables downstream FD/key reasoning.
 *
 * ## Soundness of dropping the flag + stripping the probe
 *
 * The demand-SHAPE proof (reused verbatim from the sibling's `analyzeChain`)
 * guarantees the flag is referenced **only** in the single probe conjunct. After
 * `left → inner` the probe `where flag` is subsumed by the inner join (which keeps
 * only matched rows where the flag would be `true`), so the probe conjunct is
 * stripped via `rebuildChainStrippingProbe` (Filter omitted if it was the sole
 * conjunct). Any flag reference outside the probe lands in `demanded`, and the
 * `!demanded.has(flagId)` check abstains.
 *
 * ## Relationship to `semijoin-existence-recovery` (disjoint by construction)
 *
 *  | Probe                | Right col demanded? | R unique? | Fires                         | Result        |
 *  |----------------------|---------------------|-----------|-------------------------------|---------------|
 *  | `where flag` (semi)  | NO                  | **yes**   | `semijoin-existence-recovery` | `semi(L,R,c)` |
 *  | `where flag` (semi)  | NO                  | **no**    | **this rule** (fan-out)       | `inner join`  |
 *  | `where flag` (semi)  | **YES**             | any       | **this rule**                 | `inner join`  |
 *  | `where not f` (anti) | NO                  | any       | `semijoin-existence-recovery` | `anti(L,R,c)` |
 *  | `where not f` (anti) | YES                 | any       | *neither*                     | stays `left`  |
 *
 * On the positive-probe space (anti is excluded by `polarity === 'semi'`) the two
 * rules are DISJOINT independent of registration order, because both consult the
 * SAME `rightMatchesAtMostOne`:
 *
 *   - semi fires iff:  `!rightColDemanded && unique-R`
 *   - inner fires iff: `rightColDemanded || !unique-R`
 *   - intersection = `!rightColDemanded && unique-R && (rightColDemanded || !unique-R)` = ∅
 *
 * So correctness-of-optimization no longer leans on "registered after so semi wins"
 * — the gates are provably non-overlapping, and either registration order yields
 * the same fixpoint (semi then inner, their relative registration order, is now merely conventional).
 * The negative-probe + right-col case stays a `left` join: an anti row has the right
 * side all-NULL, so an inner join would be wrong (guarded by `polarity === 'semi'`).
 * Registered BEFORE `join-elimination` / the IND folders so the recovered inner join
 * threads into them in the same `applyRules` loop. Under the fallback's own domain
 * (no right col, NON-unique R) `join-elimination` cannot fire on the result anyway —
 * it requires an at-most-one unique FK→PK alignment, which the fan-out precondition
 * contradicts — so the win there is hash/merge join only.
 *
 * ## `sideEffectMode: 'aware'` + impure-R guard
 *
 * Registered `'aware'` with a `subtreeHasSideEffects(join.right)` refusal. Although
 * the *logical* inner join scans R the same number of times as the flag-bearing
 * left join (both full-scan R per left row in `driveFromLeft`, neither short-
 * circuits), dropping the flag **re-enables `join-physical-selection`**, which can
 * pick a hash join that scans R **once** total — changing an impure R's execution
 * count. Guarding at the recovery site (rather than trusting every re-enabled
 * downstream rule) mirrors the sibling's impure-R guard and
 * `subquery-decorrelation`'s impure-inner refusal. The write-half is otherwise
 * safe by construction: a flag writable through a view is always SELECTed by its
 * routing Project, so it lands in `demanded` and `!demanded.has(flagId)` abstains.
 *
 * **Termination.** The output is an inner join with no existence spec, so re-running
 * the rule sees `joinType !== 'left'` and no-ops. No rewrite loop.
 */

import { createLogger } from '../../../common/logger.js';
import type { PlanNode } from '../../nodes/plan-node.js';
import type { OptContext } from '../../framework/context.js';
import { ProjectNode } from '../../nodes/project-node.js';
import { JoinNode } from '../../nodes/join-node.js';
import { PlanNodeCharacteristics } from '../../framework/characteristics.js';
import { collectAttrIds, walkChain, rebuildProject } from './rule-join-elimination.js';
import { analyzeChain, rebuildChainStrippingProbe, rightMatchesAtMostOne } from './rule-semijoin-existence-recovery.js';

const log = createLogger('optimizer:rule:inner-join-existence-recovery');

export function ruleInnerJoinExistenceRecovery(node: PlanNode, _context: OptContext): PlanNode | null {
	if (!(node instanceof ProjectNode)) return null;

	// `walkChain` mutates its `demanded` set; we ignore it (a throwaway) and
	// recompute demand conjunct-by-conjunct in `analyzeChain` so the probe is
	// excluded — identical to the sibling rule.
	const walk = walkChain(node.source, new Set<number>());
	if (!walk) return null;

	const { join, chain } = walk;

	// Only the reachable flag-bearing shape: a `left join … exists right as` with
	// a SOLE existence spec. A mixed join cannot be converted (other flags would be
	// dropped); `join-existence-pruning` strips an undemanded sibling first.
	if (join.joinType !== 'left') return null;
	if (!join.hasExistenceColumns) return null;
	const existence = join.existence!;
	if (existence.length !== 1) return null;
	const spec = existence[0];
	if (spec.side !== 'right') return null;
	if (!join.condition) return null;
	const flagId = spec.attrId;

	// Demand-SHAPE analysis (shared with the semi rule): seed `demanded` from the
	// Project's projections, then `analyzeChain` folds in the chain's non-probe
	// conjuncts + sort keys and classifies the sole probe conjunct. The returned
	// `demanded` is the same set we passed in.
	const demanded = new Set<number>();
	for (const proj of node.projections) {
		collectAttrIds(proj.node, demanded);
	}
	const analysis = analyzeChain(demanded, chain, flagId);
	if (!analysis) return null;
	const { probe } = analysis;

	// POSITIVE probe only. A negative probe (`where not flag`, anti polarity) with a
	// right column demanded must stay a `left` join: an anti row has the right side
	// all-NULL, so an inner join would be wrong (it drops the very rows anti keeps).
	if (probe.polarity !== 'semi') return null;

	// The flag must not be demanded anywhere but the stripped probe (a flag that is
	// selected or sorted on lands in `demanded` via projections / sort keys).
	if (demanded.has(flagId)) return null;

	// The gate: fire on a positive probe whenever a right column is demanded OR R
	// fans out. Defer to `semijoin-existence-recovery` ONLY where it can actually
	// fire — no right column demanded AND R unique on the join column (≤1 match ⇒
	// the leaner semi join is sound and strictly better: collapses to L, folds via
	// the IND cascade). When R fans out (non-unique), the semi rule abstains on its
	// own fan-out guard and the sound inner join is the only win available here. The
	// two rules share `rightMatchesAtMostOne`, so they are provably disjoint
	// independent of registration order (see the header partition table).
	const rightAttrIds = join.right.getAttributes().map(a => a.id);
	const rightColDemanded = rightAttrIds.some(id => demanded.has(id));
	if (!rightColDemanded && rightMatchesAtMostOne(join)) return null;

	// Dropping the flag re-enables `join-physical-selection`, which can pick a hash
	// join that scans R once total — refuse to change an impure R's execution count.
	if (PlanNodeCharacteristics.subtreeHasSideEffects(join.right)) {
		log('Inner recovery skipped: right side has side effects');
		return null;
	}

	// Replay the flag's exact per-pair match as an inner join — full ON condition
	// carried verbatim (no condition-shape restriction; see the soundness note).
	const innerJoin = new JoinNode(
		join.scope,
		join.left,
		join.right,
		'inner',
		join.condition,
		// no usingColumns, no existence — the flag column disappears.
	);

	log('Recovered inner join from positive probe-only existence flag %s', spec.name);

	const newSource = rebuildChainStrippingProbe(chain, probe, innerJoin);
	return rebuildProject(node, newSource);
}
