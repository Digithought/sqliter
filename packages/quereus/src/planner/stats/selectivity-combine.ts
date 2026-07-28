/**
 * Selectivity combinators.
 *
 * Pure numeric helpers that fold a list of per-conjunct / per-disjunct
 * selectivities into a single factor. No plan-node knowledge lives here — the
 * caller ({@link CatalogStatsProvider}) walks the boolean structure and hands
 * these functions plain numbers.
 *
 * ## Why exponential backoff rather than plain independence
 *
 * The textbook conjunction model assumes independent predicates and multiplies:
 * `Πsᵢ`. That collapses fast — five conditions at 0.1 each give 1e-5, i.e. "no
 * rows" for any realistic table. Real-world predicates are correlated far more
 * often than not (`city = 'Seattle' and state = 'WA'`), so the plain product
 * systematically *under*-estimates surviving rows and pushes the optimizer into
 * pathological plans (nested loops over what is actually a large intermediate).
 *
 * Instead we sort ascending (most selective first) and damp each subsequent
 * factor by taking successive square roots:
 *
 * ```
 * s₁ · s₂^(1/2) · s₃^(1/4) · s₄^(1/8)
 * ```
 *
 * This is the model SQL Server has used by default since 2014. It needs no
 * correlation statistics, degrades gracefully as conjunct count grows, and is
 * identical to plain independence for a single conjunct. Conjuncts past
 * {@link BACKOFF_CONJUNCT_LIMIT} are dropped rather than multiplied in: they are
 * the *least* selective ones, so their damped exponent would contribute almost
 * nothing anyway.
 *
 * Disjunction uses straight independence (`1 - Π(1 - sᵢ)`), which errs toward
 * over-estimating rows — the safe direction for plan choice.
 */

/** How many conjuncts participate in the damped product; the rest are dropped. */
export const BACKOFF_CONJUNCT_LIMIT = 4;

/** Clamp a selectivity into the valid [0, 1] range. */
function clamp(selectivity: number): number {
	return Math.min(1, Math.max(0, selectivity));
}

/**
 * Combine AND-ed selectivities using exponential backoff (see file doc-comment).
 *
 * Inputs and result are clamped to [0, 1]; input order does not matter. An empty
 * list is not expected — callers gate on a non-empty list — and returns 1 (the
 * conjunctive identity: no reduction claimed).
 */
export function combineConjunctive(selectivities: readonly number[]): number {
	if (selectivities.length === 0) return 1;

	const sorted = selectivities.map(clamp).sort((a, b) => a - b);
	const participating = sorted.slice(0, BACKOFF_CONJUNCT_LIMIT);

	let result = 1;
	for (let i = 0; i < participating.length; i++) {
		result *= Math.pow(participating[i], 1 / Math.pow(2, i));
	}
	return clamp(result);
}

/**
 * Combine OR-ed selectivities assuming independence: `1 - Π(1 - sᵢ)`.
 *
 * Inputs and result are clamped to [0, 1]. An empty list is not expected —
 * callers gate on a non-empty list — and returns 0 (the disjunctive identity:
 * nothing survives).
 */
export function combineDisjunctive(selectivities: readonly number[]): number {
	if (selectivities.length === 0) return 0;

	let complement = 1;
	for (const s of selectivities) {
		complement *= 1 - clamp(s);
	}
	return clamp(1 - complement);
}
