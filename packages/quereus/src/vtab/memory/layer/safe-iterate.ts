import type { BTree, Path } from 'inheritree';

/**
 * A mutation-safe iterator for BTree that automatically handles tree mutations
 * by storing the current key and reopening the path when needed.
 */
export function* safeIterate<TKey, TValue>(tree: BTree<TKey, TValue>, isAscending: boolean, startKey: { value: TKey } | undefined, keyFromEntry: (entry: TValue) => TKey): Iterable<TValue> {
	let currentKey: TKey | undefined;

	// Start iteration
	let path = startKey ? tree.find(startKey.value) : isAscending ? tree.first() : tree.last();
	moveNearest(tree, isAscending, path);

	while (path.on) {
		const entry = tree.at(path);
		// Store the current key for potential path recovery
		currentKey = keyFromEntry(entry!);
		yield entry!;

		// Check if path is still valid before advancing
		if (!tree.isValid(path)) {
			path = tree.find(currentKey);
			// Don't move nearest; the following moveNext/movePrior will move us off of the "nearest crack" if we failed to find the exact key
		}

		// Try to advance to the next position
		if (isAscending) {
			tree.moveNext(path);
		} else {
			tree.movePrior(path);
		}
	}
}

/* Attempts to move the path to the nearest valid position if not found - preferring the direction of the iteration */
function moveNearest<TKey, TValue>(tree: BTree<TKey, TValue>, isAscending: boolean, path: Path<TKey, TValue>): void {
	if (!path.on) {
		// If not found, the path will point to the closest "crack".  All we need to do is move off of it in the correct direction
		if (isAscending) {
			tree.moveNext(path);
			// In case we're at the end, move prior
			if (!path.on) tree.movePrior(path);
		} else {
			tree.movePrior(path);
			// In case we're at the beginning, move next
			if (!path.on) tree.moveNext(path);
		}
	}
}
