/**
 * Lens access-shape form matcher (ticket `lens-access-shape-path-selection`, D1/D5).
 *
 * Given the outer query's `WHERE` predicate over an inlined lens view and the
 * routable auxiliary-access structures collected on a
 * {@link LensAuxiliaryAccessNode}, decide which predicate fragments an
 * auxiliary's advertised {@link AccessForm}s answer. Two sub-channels:
 *
 * - **comparison forms** (`equality`, `range`) — matched directly against a
 *   `column op value` conjunct whose column is an advertised access column. (v1
 *   uses a focused conjunct check rather than the full `extractConstraintsForTable`
 *   surface, which needs a fully-built plan + relation keys; the shape recognized
 *   is exactly the single-conjunct constraint that extractor would yield.)
 * - **function-predicate forms** (`prefix`, `contains`, `intersects`, `knn`, and
 *   any open `string & {}`) — matched by an **extensible recognizer registry**
 *   keyed by form name. A built-in recognizer per built-in form matches a scalar
 *   function call whose name equals the form name over an advertised access
 *   column; modules register additional recognizers (e.g. `nd_contains` → the
 *   `contains` form) via {@link registerAccessFormRecognizer}.
 *
 * An advertised form with **no registered recognizer** (and not a comparison
 * form) yields **no match** — the graceful-degrade contract (D5) that lets
 * vector-similarity / full-text forms land later with zero engine change.
 */

import type { ScalarPlanNode } from '../../nodes/plan-node.js';
import { ColumnReferenceNode } from '../../nodes/reference.js';
import { ScalarFunctionCallNode } from '../../nodes/function.js';
import { BinaryOpNode } from '../../nodes/scalar.js';
import { splitConjuncts } from '../../analysis/predicate-conjuncts.js';
import type { AccessForm } from '../../../vtab/mapping-advertisement.js';
import type { AuxAccessColumn, RoutableAuxiliary } from '../../nodes/lens-auxiliary-access-node.js';

/** Whether a matched form rides the comparison or function-predicate channel. */
export type AccessFormKind = 'comparison' | 'function-predicate';

/** One advertised served entry (columns + the forms served over them). */
export type ServedEntry = { readonly columns: readonly string[]; readonly forms: readonly AccessForm[] };

/** A predicate fragment an auxiliary's advertised form answers. */
export interface MatchedAuxiliaryPath {
	readonly routable: RoutableAuxiliary;
	readonly servedEntry: ServedEntry;
	readonly form: AccessForm;
	readonly kind: AccessFormKind;
	/** The advertised access column the fragment constrains. */
	readonly accessColumn: AuxAccessColumn;
	/** The single conjunct (from the filter predicate) this match consumes. */
	readonly predicateFragment: ScalarPlanNode;
}

/**
 * A function-predicate recognizer for one form. Given a conjunct and the set of
 * logical output-attribute ids that name an advertised access column, returns the
 * matched access-column attribute id when the conjunct is a predicate of the
 * form's shape over one of those columns, else `null`.
 */
export type AccessFormRecognizer = (
	conjunct: ScalarPlanNode,
	accessColumnAttrIds: ReadonlySet<number>,
) => { readonly accessColumnAttrId: number } | null;

/** form name (lowercased) → recognizers. Multiple recognizers per form are tried in order. */
const recognizers = new Map<string, AccessFormRecognizer[]>();

/** The comparison forms ride the dedicated channel below, never the recognizer registry. */
const COMPARISON_FORMS: ReadonlySet<string> = new Set(['equality', 'range']);

/** Register a recognizer for a function-predicate form (additive — coexists with built-ins). */
export function registerAccessFormRecognizer(form: string, recognizer: AccessFormRecognizer): void {
	const key = form.toLowerCase();
	const list = recognizers.get(key);
	if (list) list.push(recognizer);
	else recognizers.set(key, [recognizer]);
}

/** Walk a scalar subtree for the first ColumnReferenceNode whose attr is in `attrIds`. */
function findAccessColumnAttr(node: ScalarPlanNode, attrIds: ReadonlySet<number>): number | null {
	const stack: ScalarPlanNode[] = [node];
	while (stack.length) {
		const n = stack.pop()!;
		if (n instanceof ColumnReferenceNode && attrIds.has(n.attributeId)) {
			return n.attributeId;
		}
		for (const c of n.getChildren()) stack.push(c as ScalarPlanNode);
	}
	return null;
}

/**
 * A recognizer matching a scalar function call by name (case-insensitive) with
 * an operand referencing an advertised access column. The built-in form
 * recognizers are this factory bound to the form name; modules bind it (or a
 * bespoke recognizer) to their own function names.
 */
export function functionNameRecognizer(...functionNames: string[]): AccessFormRecognizer {
	const names = new Set(functionNames.map(n => n.toLowerCase()));
	return (conjunct, accessColumnAttrIds) => {
		if (!(conjunct instanceof ScalarFunctionCallNode)) return null;
		if (!names.has(conjunct.expression.name.toLowerCase())) return null;
		const attrId = findAccessColumnAttr(conjunct, accessColumnAttrIds);
		return attrId === null ? null : { accessColumnAttrId: attrId };
	};
}

// Built-in function-predicate recognizers: each matches a call named exactly the
// form it serves. `equality`/`range` are NOT here — they ride the comparison channel.
for (const form of ['prefix', 'contains', 'intersects', 'knn']) {
	registerAccessFormRecognizer(form, functionNameRecognizer(form));
}

/** Match a `column op value` comparison conjunct on an advertised access column. */
function matchComparison(
	form: AccessForm,
	conjunct: ScalarPlanNode,
	accessColumnAttrIds: ReadonlySet<number>,
): { accessColumnAttrId: number } | null {
	if (!(conjunct instanceof BinaryOpNode)) return null;
	const op = conjunct.expression.operator;
	const isEq = op === '=';
	const isRange = op === '<' || op === '<=' || op === '>' || op === '>=';
	if (form === 'equality' && !isEq) return null;
	if (form === 'range' && !isRange) return null;

	// One side a bare column reference to an advertised access column, the other
	// not a column reference to the same table (a value/parameter/literal). The
	// matcher only needs the column side to route — value validity is the
	// auxiliary module's concern once the predicate is pushed.
	const left = conjunct.left;
	const right = conjunct.right;
	const colSide =
		left instanceof ColumnReferenceNode && accessColumnAttrIds.has(left.attributeId) ? left :
		right instanceof ColumnReferenceNode && accessColumnAttrIds.has(right.attributeId) ? right :
		null;
	if (!colSide) return null;
	return { accessColumnAttrId: colSide.attributeId };
}

/**
 * Match the filter predicate against the routable auxiliaries' advertised forms.
 * Returns one entry per (auxiliary, served-entry, form, conjunct) that matches —
 * the caller (`rule-lens-auxiliary-access`) selects deterministically among them.
 */
export function matchAccessForms(
	predicate: ScalarPlanNode,
	routables: readonly RoutableAuxiliary[],
): MatchedAuxiliaryPath[] {
	const conjuncts = splitConjuncts(predicate);
	const matches: MatchedAuxiliaryPath[] = [];

	for (const routable of routables) {
		// logical access-column attr id → its AuxAccessColumn descriptor.
		const byLogicalAttr = new Map<number, AuxAccessColumn>();
		for (const ac of routable.accessColumns) byLogicalAttr.set(ac.logicalAttrId, ac);

		for (const servedEntry of routable.served) {
			// Restrict to the access columns this served entry names AND that are
			// locatable on both the logical body and the auxiliary scan.
			const entryColumns = new Set(servedEntry.columns.map(c => c.toLowerCase()));
			const entryAccessColumns = routable.accessColumns.filter(ac => entryColumns.has(ac.logicalColumn.toLowerCase()));
			if (entryAccessColumns.length === 0) continue;
			const entryAttrIds = new Set(entryAccessColumns.map(ac => ac.logicalAttrId));

			for (const form of servedEntry.forms) {
				const formKey = String(form).toLowerCase();
				const isComparison = COMPARISON_FORMS.has(formKey);

				for (const conjunct of conjuncts) {
					let hit: { accessColumnAttrId: number } | null = null;
					if (isComparison) {
						hit = matchComparison(form, conjunct, entryAttrIds);
					} else {
						for (const rec of recognizers.get(formKey) ?? []) {
							hit = rec(conjunct, entryAttrIds);
							if (hit) break;
						}
					}
					if (!hit) continue;
					const accessColumn = byLogicalAttr.get(hit.accessColumnAttrId);
					if (!accessColumn) continue;
					matches.push({
						routable,
						servedEntry,
						form,
						kind: isComparison ? 'comparison' : 'function-predicate',
						accessColumn,
						predicateFragment: conjunct,
					});
				}
			}
		}
	}

	return matches;
}
