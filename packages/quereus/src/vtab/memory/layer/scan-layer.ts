import type { ScanPlan } from './scan-plan.js';
import type { Layer } from './interface.js';
import { keyParts, leadingKeyPart, type BTreeKey, type BTreeKeyForPrimary, type BTreeKeyForIndex, type MemoryIndexEntry } from '../types.js';
import { IndexConstraintOp } from '../../../common/constants.js';
import { StatusCode, type Row } from '../../../common/types.js';
import { safeIterate } from './safe-iterate.js';
import { QuereusError } from '../../../common/errors.js';
import { planAppliesToKey, resolveScanComparators, type ResolvedScanComparators } from './plan-filter.js';

/**
 * True if a multi-seek key is SQL NULL (scalar) or contains any NULL component
 * (composite tuple). Such a key contributes no match: `x IN (…, NULL)` is TRUE on
 * a non-null equal element else NULL, so the WHERE excludes the row; for a tuple
 * seek, a NULL in any component makes the row-value comparison NULL ⇒ no match.
 *
 * `keyIsTuple` comes from the scanned structure's arity (see the {@link BTreeKey}
 * invariant) — sniffing it would read the JSON document `[null]` as a NULL-bearing
 * tuple and silently drop the equality seek that should match it.
 */
function seekKeyHasNull(key: BTreeKey, keyIsTuple: boolean): boolean {
	return keyParts(key, keyIsTuple).some(v => v === null);
}

/**
 * A multi-seek's keys arrive in seek-argument order (the order the `IN` list appears in
 * the SQL text), which need not match the scanned structure's own key order. `quereus-isolation`
 * merges this scan with a staged-row stream assuming both arrive in structure order (see
 * merge-iterator.ts), so sort them under that structure's own comparator — the same contract
 * the store backend already honors (see store-table-scan.ts). Reversed for a descending walk,
 * which emits the structure's keys backwards too. Both comparators already fold each key
 * column's logical type, collation and `DESC` direction, so this is the tree's physical order.
 *
 * Keys pass through untouched for an index name the layer's schema does not know; the scan
 * body reports that with a better message than a sort could.
 */
function orderSeekKeys(
	keys: readonly BTreeKey[],
	plan: ScanPlan,
	layer: Layer,
	primaryKeyComparator: (a: BTreeKey, b: BTreeKey) => number,
): readonly BTreeKey[] {
	const compare = plan.indexName === 'primary'
		? primaryKeyComparator
		: layer.getSecondaryIndex(plan.indexName)?.compareKeys;
	if (!compare) return keys;
	return plan.descending
		? [...keys].sort((a, b) => -compare(a, b))
		: [...keys].sort(compare);
}

/**
 * Scans a layer (base or transaction) according to a ScanPlan, yielding matching rows.
 * Operates on the Layer interface — the inherited BTrees handle data inheritance transparently.
 *
 * The plan's collation names and the scanned index's column types are resolved into
 * per-column comparators exactly once here; {@link scanLayerResolved} does the work and
 * passes the functions down its own recursion, so a multi-seek or multi-range plan
 * never re-resolves per sub-scan or per row. The comparators mirror the tree's own key
 * comparator (typed — see plan-filter.ts), so bound filtering and early termination
 * agree with the physical BTree order.
 */
export function* scanLayer(
	layer: Layer,
	plan: ScanPlan
): Iterable<Row> {
	yield* scanLayerResolved(layer, plan, resolveScanComparators(plan, layer.getSchema(), layer.collationResolver));
}

/**
 * The scan body. `comparators` holds the plan's already-resolved bound/prefix
 * comparators; narrowing a plan (multi-seek → single key, multi-range → single range)
 * never changes which columns the prefix/bound comparators describe, so the same
 * functions are reused down the recursion.
 */
function* scanLayerResolved(
	layer: Layer,
	plan: ScanPlan,
	comparators: ResolvedScanComparators,
): Iterable<Row> {
	// Multi-seek: iterate over multiple equality keys (e.g. `col IN (v1, v2, …)`).
	// This is set-membership, not a bag, so two faults must be avoided:
	//  - A duplicate seek key (`IN (5, 5)`, or two case-variant literals that hit the
	//    same NOCASE index entry) must not re-yield its row. We dedup the *yielded
	//    rows by primary key* — keying on physical row identity is collation-agnostic.
	//  - A NULL (or NULL-containing) seek key contributes no match and must be skipped;
	//    leaving it in would also fall through to the unbounded full-index walk below
	//    (the point-seek branches gate on `equalityKey != null`).
	if (plan.equalityKeys && plan.equalityKeys.length > 0) {
		const seekSchema = layer.getSchema();
		// Dedup by encoded primary key. Membership is all we need (ordered iteration
		// of the seen-set is not), so a Set of the lossless, type-aware PK encoding
		// (collation-independent — see utils/primary-key-encode.ts) is lighter than a
		// full BTree and keys on the same value-identity the PK comparator would.
		const { primaryKeyExtractorFromRow, primaryKeyEncoder: encodePk, primaryKeyComparator } =
			layer.getPkExtractorsAndComparators(seekSchema);
		const seen = new Set<string>();
		for (const key of orderSeekKeys(plan.equalityKeys, plan, layer, primaryKeyComparator)) {
			if (seekKeyHasNull(key, comparators.keyIsTuple)) continue;
			const singlePlan: ScanPlan = { ...plan, equalityKey: key, equalityKeys: undefined };
			for (const row of scanLayerResolved(layer, singlePlan, comparators)) {
				const encoded = encodePk(primaryKeyExtractorFromRow(row));
				// A key already in `seen` means this row was yielded by an earlier seek.
				if (seen.has(encoded)) continue;
				seen.add(encoded);
				yield row;
			}
		}
		return;
	}

	// Multi-range: iterate over multiple range specs
	if (plan.ranges && plan.ranges.length > 0) {
		for (const range of plan.ranges) {
			const singlePlan: ScanPlan = {
				...plan,
				ranges: undefined,
				lowerBound: range.lowerBound,
				upperBound: range.upperBound,
			};
			yield* scanLayerResolved(layer, singlePlan, comparators);
		}
		return;
	}

	const schema = layer.getSchema();
	const { primaryKeyExtractorFromRow, primaryKeyComparator } = layer.getPkExtractorsAndComparators(schema);

	if (plan.indexName === 'primary') {
		const tree = layer.getModificationTree('primary');
		if (!tree) return;

		if (plan.equalityKey !== undefined) {
			// A NULL (or NULL-containing) equality key is UNKNOWN under SQL three-valued
			// logic ⇒ no row matches. Short-circuit before `tree.get`: a literal `null`
			// could otherwise match a stored NULL index entry for a composite key. Only
			// `undefined` (no equality key) falls through to the full/range walk below.
			if (seekKeyHasNull(plan.equalityKey, comparators.keyIsTuple)) return;
			const value = tree.get(plan.equalityKey as BTreeKeyForPrimary);
			if (value) {
				yield value as Row;
			}
			return;
		}

		const isAscending = !plan.descending;
		// When the leading PK column is DESC the BTree is physically ordered with
		// that column descending. The synthesized all-columns fallback definition
		// carries no `desc`, so the `?.` chain yields false there, which is correct.
		const isDescFirstColumn = schema.primaryKeyDefinition?.[0]?.desc === true;
		// NOTE: `> 1`, whereas the key-shape flag `comparators.keyIsTuple` uses `!== 1`.
		// They differ only for the zero-column singleton PK, which stores `[]`: neither
		// branch below can reach it (an `equalityPrefix` needs a PK column, and there is
		// no column for a bound to constrain), so the seek key is never built for it. If a
		// zero-arity plan ever does reach here, switch this to `keyIsTuple`.
		const isComposite = (schema.primaryKeyDefinition?.length ?? schema.columns.length) > 1;

		// Seek-start selection must depend on the *physical* walk direction, not just
		// the key's declared direction. The four {isAscending}×{isDescFirstColumn}
		// combinations each seek from one bound and terminate at the other:
		//   ascending  + ASC-leading  → seek from lower, terminate at upper
		//   ascending  + DESC-leading → seek from upper, terminate at lower
		//   descending + ASC-leading  → seek from upper, terminate at lower
		//   descending + DESC-leading → seek from lower, terminate at upper
		// i.e. seek from the upper bound exactly when isAscending === isDescFirstColumn
		// (and terminate at the complement). Absent the chosen bound we fall back to
		// the tree end `safeIterate` picks for the direction.
		const seekFromUpper = isAscending === isDescFirstColumn;

		// Determine start key for range scans
		let startKey: { value: BTreeKeyForPrimary } | undefined;
		if (plan.equalityPrefix) {
			const compositeStart = [...plan.equalityPrefix];
			if (plan.lowerBound) compositeStart.push(plan.lowerBound.value);
			// A non-composite PK stores SCALAR keys: an array-shaped seek key would
			// position PAST the scalar match (the comparator orders the wrapped form
			// after its scalar), silently skipping the row a full-PK-length prefix
			// (the delta-aggregate point read) targets. Unwrap the single-element
			// prefix to the scalar; composite trees keep the array form.
			startKey = {
				value: (!isComposite && compositeStart.length === 1
					? compositeStart[0]
					: compositeStart) as BTreeKeyForPrimary,
			};
		} else {
			// Composite PKs store array-shaped keys; wrap the scalar leading-column
			// bound in a single-element array so the comparator's prefix handling
			// positions the seek before all full keys sharing that prefix.
			const seekBound = seekFromUpper ? plan.upperBound : plan.lowerBound;
			if (seekBound) {
				const seekValue = isComposite ? [seekBound.value] : seekBound.value;
				startKey = { value: seekValue as BTreeKeyForPrimary };
			}
		}

		for (const value of safeIterate(tree, isAscending, startKey, primaryKeyExtractorFromRow)) {
			const row = value as Row;
			const primaryKey = primaryKeyExtractorFromRow(row);
			if (!planAppliesToKey(plan, primaryKey, primaryKeyComparator, comparators)) {
				// Early termination for prefix-range: break when prefix no longer matches
				if (plan.equalityPrefix) {
					const keyArr = keyParts(primaryKey, comparators.keyIsTuple);
					let prefixMismatch = false;
					for (let i = 0; i < plan.equalityPrefix.length; i++) {
						if (comparators.equalityPrefix[i](keyArr[i], plan.equalityPrefix[i]) !== 0) {
							prefixMismatch = true;
							break;
						}
					}
					if (prefixMismatch) break;
				} else {
					// Past the bound we terminate at — early exit. We seek from one end
					// and terminate at the other, so this is the complement of
					// seekFromUpper and holds for both physical walk directions. The
					// terminating compare uses the bound column's typed comparator (same
					// construction as the tree's key comparator) so the walk terminates
					// at the boundary of the tree's own order.
					const keyForComparison = leadingKeyPart(primaryKey, comparators.keyIsTuple);
					if (!seekFromUpper && plan.upperBound) {
						const cmp = comparators.bound(keyForComparison, plan.upperBound.value);
						if (cmp > 0 || (cmp === 0 && plan.upperBound.op === IndexConstraintOp.LT)) {
							break;
						}
					} else if (seekFromUpper && plan.lowerBound) {
						const cmp = comparators.bound(keyForComparison, plan.lowerBound.value);
						if (cmp < 0 || (cmp === 0 && plan.lowerBound.op === IndexConstraintOp.GT)) {
							break;
						}
					}
				}
				continue;
			}
			yield row;
		}
	} else {
		// Secondary Index Scan
		const indexTree = layer.getSecondaryIndexTree(plan.indexName);
		if (!indexTree) throw new QuereusError(`Secondary index '${plan.indexName}' not found.`, StatusCode.INTERNAL);

		const primaryTree = layer.getModificationTree('primary');

		// PK-within-index-key order is observable and depended upon: `quereus-isolation`
		// merges the overlay scan with this scan using sort key `[indexKeyParts…, pkParts…]`
		// and assumes both streams share that order. The entry's `primaryKeys` Map is in
		// insertion order, so fetch the PK-comparator-sorted view from the MemoryIndex
		// (memoized there). The inline sort is a defensive fallback for an index name the
		// layer's schema does not know (`primaryKeyComparator` is already in scope).
		// This view is ASCENDING by PK for both walk directions, whereas the overlay merge
		// reverses the WHOLE sort key (PK tie-break included) for a reversed scan. Nothing
		// asks this backend for a reversed secondary-index scan today — no engine path emits
		// `ordCons=DESC` and `scanEffective` only ever walks the primary tree — so the
		// mismatch is unreachable; see backlog/debt-memory-reverse-secondary-pk-order.
		const secondaryIndex = layer.getSecondaryIndex(plan.indexName);
		const sortedPrimaryKeys = (indexEntry: MemoryIndexEntry): readonly BTreeKeyForPrimary[] =>
			secondaryIndex
				? secondaryIndex.getSortedPrimaryKeys(indexEntry)
				: [...indexEntry.primaryKeys.values()].sort(primaryKeyComparator);

		if (plan.equalityKey !== undefined) {
			// NULL equality is UNKNOWN ⇒ no rows (see the primary branch above). Only
			// `undefined` falls through to the ordered walk.
			if (seekKeyHasNull(plan.equalityKey, comparators.keyIsTuple)) return;
			const indexEntry = indexTree.get(plan.equalityKey as BTreeKeyForIndex);
			if (indexEntry && primaryTree) {
				for (const pk of sortedPrimaryKeys(indexEntry)) {
					const value = primaryTree.get(pk);
					if (value) {
						yield value as Row;
					}
				}
			}
			return;
		}

		const isAscending = !plan.descending;
		const indexDef = schema.indexes?.find(idx => idx.name === plan.indexName);
		const isDescFirstColumn = indexDef?.columns[0]?.desc === true;

		// Seek-from end depends on the physical walk direction (see the primary
		// branch for the full rationale): seek from the upper bound exactly when
		// isAscending === isDescFirstColumn, terminate at the complement. Composite
		// secondary indexes store array-shaped keys, so wrap the scalar
		// leading-column bound so the comparator's prefix handling positions the
		// seek correctly (mirrors the primary branch).
		const isComposite = (indexDef?.columns.length ?? 1) > 1;
		const seekFromUpper = isAscending === isDescFirstColumn;

		// Determine start key
		let startKey: { value: BTreeKeyForIndex } | undefined;
		if (plan.equalityPrefix) {
			const compositeStart = [...plan.equalityPrefix];
			if (plan.lowerBound) compositeStart.push(plan.lowerBound.value);
			// Mirror the primary branch: a non-composite index stores SCALAR keys, so
			// a single-element prefix must seek with the scalar (see above).
			// NOTE: latent mirror — no consumer today emits a single-column secondary-index
			// equalityPrefix seek (single-column equality goes through `equalityKey`), so
			// this branch has no direct test. If one ever does, add a targeted prefix-scan
			// test; the primary branch is exercised by every delta-aggregate flush.
			startKey = {
				value: (!isComposite && compositeStart.length === 1
					? compositeStart[0]
					: compositeStart) as BTreeKeyForIndex,
			};
		} else {
			const seekBound = seekFromUpper ? plan.upperBound : plan.lowerBound;
			if (seekBound) {
				const seekValue = isComposite ? [seekBound.value] : seekBound.value;
				startKey = { value: seekValue as BTreeKeyForIndex };
			}
		}

		for (const indexEntry of safeIterate(indexTree, isAscending, startKey, entry => entry.indexKey)) {
			if (!planAppliesToKey(plan, indexEntry.indexKey, primaryKeyComparator, comparators)) {
				// Early termination for prefix-range: break when prefix no longer matches
				if (plan.equalityPrefix) {
					const keyArr = keyParts(indexEntry.indexKey, comparators.keyIsTuple);
					let prefixMismatch = false;
					for (let i = 0; i < plan.equalityPrefix.length; i++) {
						if (comparators.equalityPrefix[i](keyArr[i], plan.equalityPrefix[i]) !== 0) {
							prefixMismatch = true;
							break;
						}
					}
					if (prefixMismatch) break;
					continue;
				}
				// Early termination: break once the leading column passes the bound we
				// terminate at (the complement of seekFromUpper; holds for both
				// physical walk directions). Uses the bound column's typed comparator
				// (same construction as the index tree's key comparator) so the walk
				// terminates at the boundary of the tree's own order.
				const keyForComparison = leadingKeyPart(indexEntry.indexKey, comparators.keyIsTuple);
				if (!seekFromUpper && plan.upperBound) {
					const cmp = comparators.bound(keyForComparison, plan.upperBound.value);
					if (cmp > 0 || (cmp === 0 && plan.upperBound.op === IndexConstraintOp.LT)) {
						break;
					}
				} else if (seekFromUpper && plan.lowerBound) {
					const cmp = comparators.bound(keyForComparison, plan.lowerBound.value);
					if (cmp < 0 || (cmp === 0 && plan.lowerBound.op === IndexConstraintOp.GT)) {
						break;
					}
				}
				continue;
			}
			if (!primaryTree) continue;
			for (const pk of sortedPrimaryKeys(indexEntry)) {
				const value = primaryTree.get(pk);
				if (value) {
					yield value as Row;
				}
			}
		}
	}
}
