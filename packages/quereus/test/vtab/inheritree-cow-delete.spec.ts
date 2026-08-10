import { expect } from 'chai';
import { BTree } from 'inheritree';

/**
 * Dependency-level regression for the `inheritree` copy-on-write DELETE bug that
 * surfaced in Quereus as a silent under-delete on `delete ... where id > k`
 * (see delete-range-predicate-under-deletes).
 *
 * The memory-vtab MVCC model relies on the invariant that a `TransactionLayer`'s
 * `primaryModifications` is a COW child BTree — `new BTree(keyFn, cmp, base)` — that
 * inherits an immutable base tree and absorbs writes copy-on-write. The bug lived in
 * `inheritree`'s rebalance path: deleting a key that triggers a *sibling borrow or
 * merge* (i.e. any non-front-anchored delete set) orphaned the freshly-cloned sibling
 * leaf, so the parent kept pointing at the original base node. The result was both lost
 * deletions and phantom-repeated keys on iteration.
 *
 * Deleting the leftmost leaf only ever borrows/merges with a *right* sibling, which
 * dodges the bug — hence a front-anchored `id <= k` delete passes even when the tree is
 * broken. These cases therefore use only NON-front-anchored delete sets (tail, gap,
 * interleaved, random) so a regression actually fails here.
 *
 * This guards the dependency directly (no Quereus engine involved), so it survives a
 * future `yarn install` that might drop an un-committed patch — the SQL-level
 * `.sqllogic` regression would then fail too, but this pins the blame on inheritree.
 *
 * NodeCapacity is 64, so n must comfortably exceed it to force a multi-level tree whose
 * deletes provoke real structural rebalancing; n = 200 yields several leaves.
 */
describe('inheritree COW BTree — non-front-anchored delete', () => {
	const cmp = (a: number, b: number): number => a - b;
	const idFn = (e: number): number => e;

	function range(lo: number, hi: number): number[] {
		const out: number[] = [];
		for (let i = lo; i <= hi; i++) out.push(i);
		return out;
	}

	/** A base tree filled 1..n and a COW child inheriting it (the TransactionLayer shape). */
	function makeCow(n: number): { base: BTree<number, number>; cow: BTree<number, number> } {
		const base = new BTree<number, number>(idFn, cmp);
		for (let i = 1; i <= n; i++) {
			expect(base.insert(i).on, `base insert ${i}`).to.equal(true);
		}
		const cow = new BTree<number, number>(idFn, cmp, { base });
		return { base, cow };
	}

	/** Collect entries in ascending order, asserting the iteration is strictly sorted
	 *  and duplicate-free (the phantom-repeated-key corruption shows up here). */
	function collectSortedUnique(tree: BTree<number, number>): number[] {
		const out: number[] = [];
		const path = tree.first();
		while (path.on) {
			const entry = tree.at(path);
			expect(entry, 'entry on a live path').to.not.equal(undefined);
			if (out.length > 0) {
				expect(entry!, `strictly ascending after ${out[out.length - 1]}`).to.be.greaterThan(out[out.length - 1]);
			}
			out.push(entry!);
			tree.moveNext(path);
		}
		return out;
	}

	/** Issue a delete on the COW tree for every key in [1..n] matching `pred`.
	 *  Every matched key must be present and report a successful delete. */
	function deleteWhere(cow: BTree<number, number>, n: number, pred: (k: number) => boolean): number {
		let deleted = 0;
		for (let i = 1; i <= n; i++) {
			if (!pred(i)) continue;
			const path = cow.find(i);
			expect(path.on, `key ${i} present before delete`).to.equal(true);
			expect(cow.deleteAt(path), `deleteAt ${i}`).to.equal(true);
			deleted++;
		}
		return deleted;
	}

	/** Run one predicate against a fresh COW tree and assert matched == deleted,
	 *  the surviving set is exactly the complement, and the base is untouched. */
	function checkPredicate(n: number, pred: (k: number) => boolean): void {
		const { base, cow } = makeCow(n);
		const expected = range(1, n).filter(k => !pred(k));
		const matched = range(1, n).filter(pred).length;

		const deleted = deleteWhere(cow, n, pred);
		expect(deleted, 'matched == deleted').to.equal(matched);

		const remaining = collectSortedUnique(cow);
		expect(remaining.length, 'remaining count == n - deleted').to.equal(n - deleted);
		expect(remaining, 'surviving set is exactly the complement').to.deep.equal(expected);

		// Random spot-check via get(): deleted keys gone, survivors intact.
		for (let i = 1; i <= n; i++) {
			expect(cow.get(i), `cow.get(${i})`).to.equal(pred(i) ? undefined : i);
		}

		// The inherited base tree must be unmodified by the COW child's deletes.
		expect(collectSortedUnique(base), 'base tree unaffected by COW deletes').to.deep.equal(range(1, n));
	}

	it('tail predicate (id > 100) deletes every matching key', () => {
		checkPredicate(200, k => k > 100);
	});

	it('between predicate (51..150) deletes an interior band', () => {
		checkPredicate(200, k => k >= 51 && k <= 150);
	});

	it('interleaved predicate (id % 2 == 0) deletes every other key', () => {
		checkPredicate(200, k => k % 2 === 0);
	});

	it('sparse interleaved predicate (id % 3 == 0) over a larger tree', () => {
		checkPredicate(400, k => k % 3 === 0);
	});

	it('a pseudo-random non-contiguous key set', () => {
		// Deterministic LCG so the set is reproducible but scattered across leaves.
		let seed = 12345;
		const drop = new Set<number>();
		for (let i = 0; i < 70; i++) {
			seed = (seed * 1103515245 + 12345) & 0x7fffffff;
			drop.add((seed % 200) + 1);
		}
		checkPredicate(200, k => drop.has(k));
	});

	it('a high-edge tail (only the last leaf-ish slice)', () => {
		checkPredicate(200, k => k > 190);
	});

	it('control: front-anchored prefix (id <= 100) still deletes correctly', () => {
		// The bug-dodging shape — included so the suite documents that front-anchored
		// deletes were never the failing case and remain correct after the fix.
		checkPredicate(200, k => k <= 100);
	});

	it('control: empty predicate is a no-op leaving all rows', () => {
		checkPredicate(200, () => false);
	});
});
