---
description: Once the persistent store stores each indexed text value under its own column's sorting rule, three safety checks that exist only to cope with the old mismatch become obsolete — they currently force common queries into a full table scan. Replace them with the one check that still matters and restore the fast index lookup.
prereq: store-index-key-column-collation
files:
  - packages/quereus-store/src/common/store-module-access-plan.ts   # tryIndexAccessPlan — eqSafeToHandle / rangeSafeToHandle
  - packages/quereus-store/src/common/store-table-scan.ts           # analyzeIndexAccess, indexRangeIsOrderSafe
  - packages/quereus-store/src/common/pk-key-resolution.ts          # keyOrderMatchesCollation — doc comment, index-side caller
  - packages/quereus-store/test/collation-order-preserving.spec.ts  # the `shapes the gate must leave alone` block
  - packages/quereus-store/test/pushdown.spec.ts                    # plan-shape assertions
  - packages/quereus-isolation/src/isolated-table.ts                # canSeekForConstraint — the BINARY-only gate (second arm)
  - docs/store.md                                                   # § Order preservation, Built-in Collations table + footnote
  - docs/design-isolation-layer.md                                  # § When Phase 2 may seek
difficulty: medium
---

# Collapse the secondary-index collation guards to an order-preservation test

## What this depends on

`store-index-key-column-collation` changes the store so a secondary index's text columns
are keyed under the **index column's effective collation `C`** (its own `COLLATE`, else the
table column's declared collation, else `BINARY`) rather than the table key collation `K`.
Assume that has landed; this ticket is the cleanup it enables.

## What is left over

Two read-side decisions still reason about `K` vs `C`, in
`tryIndexAccessPlan` (store-module-access-plan.ts):

```ts
// EQUALITY: safe to mark handled iff K is coarser-or-equal to C
const eqSafeToHandle = (colIdx) => {
	if (!columnCanHoldText(col)) return true;
	const C = effectiveCollation(colIdx);
	if (C === K) return true;
	if (K === 'NOCASE' && C === 'BINARY') return true;   // K strictly coarser
	return false;
};

// RANGE: byte order must BE comparator order
const rangeSafeToHandle = (colIdx) =>
	keyOrderMatchesCollation(db, col, K, effectiveCollation(colIdx));
```

and their mirror in `StoreTableScan` — `analyzeIndexAccess`' EQ arm (implicitly, by relying
on the module's check) and `indexRangeIsOrderSafe`, which passes `K` as the key collation.

With index bytes now encoded under `C`, both are asking about a mismatch that no longer
exists. Concretely:

- **Equality.** The window is `C`-normalized bytes and `matchesFilters` re-checks under `C`,
  so the window is *exactly* the qualifying set. There is nothing left to check —
  `eqSafeToHandle` becomes unconditionally `true` and should be deleted, not simplified.
- **Range.** A byte window still equates memcmp of `C`-normalized bytes with `C`'s
  comparator order. That equation needs `C`'s normalizer to be **order-preserving**, which
  `db.registerCollation` promises only when the caller asserts `{ orderPreserving: true }`
  (see the completed `store-range-seek-order-preserving-gate`). So the range arm keeps a
  check — but it becomes a single-collation question, `keyOrderMatchesCollation(db, col, C,
  C)`, with the `K` argument gone.

## Second arm: the isolation layer's duplicate-check seek

Added by the review of `store-index-key-column-collation` — same root cause, different
file, so it belongs here rather than in a ticket of its own.

`IsolatedTable.canSeekForConstraint` (packages/quereus-isolation/src/isolated-table.ts)
decides whether a UNIQUE duplicate check may look its answer up through the backing index
instead of reading the whole underlying table. It allows the seek only when **every**
constrained column enforces under `BINARY`. That gate was written when the store's index
key bytes were encoded under `K` and ignored the connection's collation registry: seeking
a `NOCASE` index for `'B@X'` would physically miss a committed `'b@x'`, turning a
performance win into a lost UNIQUE violation.

Both premises are now gone. Index bytes encode under the index column's own effective
collation, which for an index-derived UNIQUE is exactly the enforcement collation the
merged check compares under — so the seek window is precisely the conflict set, and the
`BINARY`-only gate is now pure conservatism (a collated UNIQUE full-scans the underlying
on every insert).

What to establish before widening it:

- The seek is served the same way by **both** backends the isolation layer wraps (the
  store's `analyzeIndexAccess` window, the memory table's index) for a collated index.
- Only `derivedFromIndex` constraints are seekable — a plain `unique(email)` has no index
  in the engine-facing schema (the store's `_uc_*` is enforcement-only), so it must keep
  full-scanning.
- A custom equality-only collation is fine for an equality seek (order is not involved),
  but confirm the seek path is equality-only end to end.

Interaction to honor: `backlog/debt-iso-store-unique-seek-rowcount` proposes a
row-count test whose **negative control** is "a `collate nocase` index must full-scan".
Widening this gate invalidates that control; whichever lands second must update the other.

## Why this matters

`store-range-seek-order-preserving-gate` tightened the range arm to require `C === K`
outright, and named the cost: **an index range seek on a plain `BINARY` text column of a
default-`K` (`NOCASE`) store table falls back to a full scan.** That is the most ordinary
shape there is — `create table t (id integer primary key, name text) using store` plus
`create index ix on t (name)`, then `where name > 'm'`.

With index bytes under `C = BINARY` and `BINARY` stamped order-preserving, that seek comes
back. Same for `where name = 'x'` under any `K`.

The magnitude is a plan-shape change, not a measured speedup: the query moves from a
full-table scan with a retained residual filter to a bounded index range seek with the
filter handled. Do not put a factor on it without measuring one.

## The change

**`tryIndexAccessPlan`:**

- Delete `eqSafeToHandle` and the `K`-coarseness reasoning entirely. The EQ arm no longer
  needs a collation gate.
- Rewrite `rangeSafeToHandle` as `keyOrderMatchesCollation(db, col, C, C)` where
  `C = effectiveCollation(colIdx)`. Consider passing `C` once rather than deriving it twice.
- `tableKeyCollation` may become unused in this function; if so, drop the parameter and its
  plumbing from `computeBestAccessPlan` — but check it is not still needed by the PK arm
  (`pkOrderPreservingPrefixLength` genuinely still takes `K`, because
  `resolvePkKeyCollations` still falls back to `K` for an undecorated text PK member).
- Update the long doc comment above `tryIndexAccessPlan`. Its entire "collation-safety guard
  against under-fetch / K-window must be a superset" argument is obsolete; replace it with
  the one-line statement that index bytes and the residual now use the same collation, and
  that the range arm's remaining question is order preservation.

**`StoreTableScan`:**

- `indexRangeIsOrderSafe(index, leadingCol)` resolves `C` already (`indexCol?.collation ??
  col?.collation ?? 'BINARY'`); pass it as *both* the key and comparison collation. Drop the
  `K` read.
- Update `analyzeIndexAccess`' doc comment for the same reason.

**`keyOrderMatchesCollation` (pk-key-resolution.ts):** the function itself is unchanged —
it is still the shared predicate the module and the table both consult, and the PK path
still uses it with genuinely distinct key/comparison collations. Only its doc comment needs
a note that the secondary-index callers now pass the same collation on both sides, so for
them it reduces to the `orderPreserving` assertion.

The two decision sites must continue to agree — the module marks a filter handled only when
the predicate passes, and `StoreTable` builds a window only under the same predicate. Keep
them sharing `keyOrderMatchesCollation`; do not inline either.

## Edge cases & interactions

- **Non-order-preserving custom collation on an index column.** Register a collation whose
  normalizer preserves equality but not order (the probe pair in
  `collation-order-preserving.spec.ts` orders shorter strings first), declare a column under
  it, index it. The range arm must still decline: full scan, residual retained, correct rows.
  The EQ seek must still fire — equality never depended on order.
- **Order-preserving custom collation.** The same pair registered with
  `{ orderPreserving: true }` must get the range seek back.
- **The `shapes the gate must leave alone` block** in `collation-order-preserving.spec.ts`
  pins "coarser-`K` equality index seek" as a shape that must not regress. That test is
  still valid as a *behavior* assertion (the seek fires) but its stated rationale is now
  wrong. Re-derive the assertion rather than deleting it, and correct the comment.
- **The behavior note in `store-range-seek-order-preserving-gate`'s complete/ ticket** —
  "index range seek on a plain BINARY text column of a default-`K` table loses its seek" —
  is exactly what this ticket reverses. Add the positive test for it: the range seek is now
  present in the plan for that shape, with the filter handled.
- **`any` / `json` / temporal index columns** key `BINARY` after the prereq, but
  `keyOrderMatchesCollation` declines any semantic-ordering type outright before it reaches
  the collation branch (`feat-reopen-timespan-store-seeks` tracks re-opening that). Confirm
  no change: still no range seek, still no multi-seek, still correct rows.
- **Never-text index columns** are exempt in `keyOrderMatchesCollation` and unaffected.
- **The cost-only fallback tripwire.** `store-range-seek-order-preserving-gate` left a
  `NOTE:` at the `costOnlyFallback` return in the access-plan module: a cost-only index plan
  carries no PK-order advertisement, so `… where v > 'x' order by <pk>` picks up a Sort it
  did not need, and the range gate made that arm fire more often. This ticket makes it fire
  *less* often. Re-read that NOTE and either keep it (still true, just rarer) or retire it if
  the arm is now unreachable for the shape it describes — say which in the handoff.
- **DESC index columns** and **partial indexes** are orthogonal to the guards but sit on the
  same code path; a smoke assertion that neither regressed is cheap.
- **Multi-seek (`plan=5`).** Its own declines (the `MAX_MULTI_SEEK_KEYS` cap, the
  semantic-ordering refusal) are independent of the collation guards and must survive
  untouched.

## Tests

Extend `packages/quereus-store/test/collation-order-preserving.spec.ts` (it already owns the
probe collations and the plan-shape helpers) rather than starting a new file; add plan-shape
assertions to `pushdown.spec.ts` where that file already asserts index selection.

Expected outputs:

| shape | before this ticket | after |
|---|---|---|
| `where name > 'm'`, `name text`, index, `K = NOCASE` | full scan, residual retained | index range seek, filter handled |
| `where name = 'x'`, same table | index seek (already) | index seek, unchanged |
| same, column under a non-order-preserving custom collation | full scan | full scan, unchanged |
| same, custom collation with `{ orderPreserving: true }` | full scan | index range seek |

Every row-level assertion should be checked against a memory-table oracle so a plan change
cannot quietly change the answer.

**Mutation-check:** force `keyOrderMatchesCollation` to return `true` unconditionally and
confirm the non-order-preserving tests fail. The prereq ticket removed the only *other*
reason those tests could fail, so this is the pass that proves the remaining gate is live.

## TODO

- Delete `eqSafeToHandle`; simplify `rangeSafeToHandle` to a single-collation
  `keyOrderMatchesCollation(db, col, C, C)`.
- Drop `tableKeyCollation` from `tryIndexAccessPlan` and its plumbing **only if** genuinely
  unused there; the PK arm still needs `K`.
- Simplify `StoreTableScan.indexRangeIsOrderSafe` the same way.
- Rewrite the three obsolete doc comments (`tryIndexAccessPlan`, `analyzeIndexAccess`,
  `keyOrderMatchesCollation`'s index-caller note).
- Re-derive the rationale on the `shapes the gate must leave alone` assertions; add the
  restored-range-seek tests and the custom-collation pair tests.
- Resolve the `costOnlyFallback` NOTE (keep or retire) and say which in the handoff.
- `docs/store.md`: § *Order preservation* and the Built-in Collations table's range-support
  footnote both describe the `K`-vs-`C` regime; update them to the single-collation rule.
- Second arm: widen `IsolatedTable.canSeekForConstraint` past BINARY-only (or record why
  not), and update `docs/design-isolation-layer.md` § *When Phase 2 may seek*, which now
  points here.
- `yarn build`, `yarn lint`, `yarn test` green; run `yarn test:store` (stream with `tee`).
