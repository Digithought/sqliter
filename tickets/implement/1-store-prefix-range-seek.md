---
description: On the persistent storage backend, a query that matches one indexed column exactly and compares the next indexed column against a range (for example "this account, all months before June") reads every row under the exact match and throws most of them away; make it read only the rows in the range.
files:
  - packages/quereus-store/src/common/store-module-access-plan.ts   # tryIndexAccessPlan — the arm that must claim the trailing range
  - packages/quereus-store/src/common/store-table-scan.ts           # analyzeIndexAccess / buildIndexRangeBounds — the byte window to widen to a prefix
  - packages/quereus-store/src/common/pk-key-resolution.ts          # indexLeadingRangeIsOrderSafe — the soundness gate to generalize to position k
  - packages/quereus-store/src/common/key-builder.ts                # buildIndexPrefixBounds — the encoder both sides call
  - packages/quereus/src/vtab/memory/module.ts                      # lines ~551-577: the reference advertisement, already shipped
  - packages/quereus/src/planner/rules/access/rule-select-access-path.ts  # lines 781-873: the engine side, already shipped
  - packages/quereus/src/vtab/idx-str.ts                            # plan=7 (`prefixRangeSeek`) encoding
  - packages/quereus-store/test/pushdown.spec.ts                    # where store access-path tests live
difficulty: medium
---

# Store: prefix-equality + trailing-range index seeks

## What happens today

Given a store-backed table with a two-column index and a query that pins the first
column with `=` and constrains the second with `<`, `>`, `<=`, `>=` or `between`, the
store seeks only the equality prefix and re-filters everything under it row by row:

```sql
create index idx_entry_ent_date on entry (entity_id, date);
select … from entry where entity_id = ? and date >= ? and date <= ?;
-- plan: IndexSeek entry USING (entity_id) | Filter date >= … and date <= …
```

A downstream project reported this reading **all 20 000 rows** under the `entity_id`
prefix (their database holds one entity, so the prefix is not selective at all) to
return **80** rows, taking **4499 ms**. The same rows reached by a plain equality on a
selective column take 7 ms. Numbers are theirs, measured on IndexedDB; we have not
reproduced them locally, but the plan shape they quote is exactly what the code below
produces.

Answers are correct throughout — the residual `Filter` is retained. This is speed only.

## Why the fix is small: everything above the module already exists

- The engine already plans this shape. `rule-select-access-path.ts` lines 781-873 build
  a **prefix-range seek** (`plan=7`, `prefixRangeSeek` in `idx-str.ts`): prefix equality
  keys, then the first lower bound and the first upper bound on the next seek column,
  all emitted positionally into `seekKeys`, with a `prefixLen` parameter in the idxStr.
  It fires when the module's access plan sets `seekColumnIndexes` longer than the
  equality prefix and claims the corresponding filters handled.
- The in-memory virtual table already advertises it (`memory/module.ts` lines 551-577):
  when the equality prefix is a strict, non-empty prefix of the index columns and the
  next index column carries a range, it returns `setSeekColumns([...eqCols, trailingCol])`
  with the equality and range filters both marked handled.
- The store already builds range byte windows — for the **leading** index column
  (`buildIndexRangeBounds`) and for the leading primary-key column (`buildPKRangeBounds`).

The store module is simply the one module that never advertises the composite shape.
`tryIndexAccessPlan` sets `seekCols = eqCols; isRange = false` the moment any equality
prefix exists (store-module-access-plan.ts lines 339-347), and the scan side mirrors it:
`analyzeIndexAccess` returns a prefix-only window and reaches its range arm only when the
equality prefix is empty (store-table-scan.ts lines 397-435).

Note for anyone reading the downstream report: its claim that the store cannot seek *any*
inequality is too broad. A range on the **leading** index column, and on the leading
primary-key column, both already seek. Every failing example they give is the composite
shape, and that is what this ticket covers.

## What to build

Two halves that must agree, in the two files that already state that contract.

**Plan half — `tryIndexAccessPlan`.** After the equality-prefix loop, when
`0 < eqCols.length < indexColIndexes.length`, look for a lower and/or upper bound filter
on `indexColIndexes[eqCols.length]`. If one exists, advertise
`setSeekColumns([...eqCols, trailingCol])` and claim, via the existing
`claimFirstPerRole`, the equality roles for the prefix plus `rangeRoles(trailingCol)` for
the bounds. Cost it as a range scan, in between the pure-equality and pure-range
estimates — the seek is more selective than a leading-column range and less than a full
prefix equality. State the chosen selectivity factor in a comment; today's numbers are
`0.1 × estimated` for equality and `0.3 × estimated` for a range.

The multi-value (`IN`) prefix must **not** take this arm. `rule-select-access-path` can
only seek a single-valued prefix key; the memory module's note at lines 551-559 records
the same restriction and the same reason. An `IN` in the prefix keeps today's behavior.

**Scan half — `analyzeIndexAccess`.** After the equality prefix is collected, if the
next index column carries range constraints, build one window: the prefix bytes plus the
trailing column's bound, i.e. `buildIndexPrefixBounds([...eqValues, boundValue], …)` for
each bound, mapped onto `gte`/`lt` with the same ASC/DESC swap table
`buildIndexRangeBounds` already documents, and with the equality-prefix bytes as the
fallback bounds when a bound is dropped. Generalize `buildIndexRangeBounds` to take a
fixed prefix rather than duplicating it. Return a `range`-typed `IndexAccessPattern`;
`scanIndex` needs no change beyond receiving the narrower bounds.

**Soundness gate.** `indexLeadingRangeIsOrderSafe` (pk-key-resolution.ts:498) hard-codes
position 0. Generalize it to an arbitrary column position (keep a thin leading-column
wrapper so existing call sites read the same), and call the **same** generalized
predicate from both halves — plan side before claiming the filters handled, scan side
before building the window. The prefix columns additionally need
`indexPrefixSeekIsCollationExact(…, eqCols.length)`, which both halves already call for
the equality-only arm. Over-claiming here is a wrong-answer bug, not a slow query: the
engine drops the residual `Filter` on the strength of `handledFilters`.

Prefer honoring the `prefixLen` parameter carried in the `plan=7` idxStr over
re-inferring the prefix length from the constraint list, so a plan/scan disagreement
fails loudly instead of silently returning a wrong window.

## Edge cases & interactions

- **DESC index columns.** Both the prefix and the trailing bound encode under their own
  per-column DESC direction; the lower/upper assignment swaps for a DESC trailing column
  exactly as the existing tables in `buildIndexRangeBounds` / `buildPKRangeBounds` state.
  A DESC *prefix* column does not swap anything — its bytes are inverted inside the
  prefix, which stays a fixed prefix.
- **Isolation overlay merge order.** The overlay merges an index scan with staged writes
  by `(indexKey, PK)` sort key. A prefix+range window is still one contiguous
  encoded-key range, so emission order is unchanged — but assert it under an open
  transaction with pending puts and deletes inside and outside the range.
- **Read-your-own-writes.** `iterateEffective` restricts the pending merge to the same
  bounds. A pending row that the *narrowed* window excludes but the old prefix window
  included must still be handled correctly (it is out of range, so it must not appear).
- **Semantic-ordering trailing column** (`timespan`, `json`). `buildIndexRangeBounds`
  widens rather than declines when a probe has no faithful byte position
  (`semanticProbeIsKeyFaithful`). Keep that behavior: a dropped bound widens to the
  equality-prefix window, which is the pre-existing behavior, and `matchesFilters`
  re-checks under the type's own compare.
- **Bound overflow.** An upper bound whose incremented byte prefix overflows to all-`0xff`
  leaves that side unbounded — a superset, already handled by the existing helpers. Keep
  the window a superset in every degraded path.
- **NULL / missing bound value.** Skipped, as today.
- **Redundant same-side bounds** (`date > a and date > b`). Only the FIRST per role may
  be claimed handled — `claimFirstPerRole` exists for exactly this and the reason is
  spelled out in its doc comment. A later duplicate must survive in the residual.
- **Literal NULL in a prefix equality.** The engine short-circuits to an empty result
  before reaching the module (rule lines 807-815). Confirm the module's claim does not
  change that.
- **Partial indexes** stay excluded (`if (index.predicate) return null`).
- **Cost competition.** `computeBestAccessPlan` returns from the leading-PK-range arm
  before the secondary-index loop runs, so a table whose primary key also carries a range
  never sees this new plan. That is the separate open ticket
  `bug-store-pk-range-preempts-cheaper-index` — do not fix it here, but pick a test table
  whose primary key is not part of the predicate so this ticket's tests actually exercise
  the new arm.
- **Ordering advertisement.** This arm advertises no ordering, matching the existing
  index arms. A query that also wants `order by` on the trailing column will keep its
  `Sort`. Acceptable; do not add an ordering claim in this ticket.

## Expected results

- `select … from t where a = ? and b between ? and ?` over `create index ix on t (a, b)`
  plans as a prefix-range seek and reads a number of store entries proportional to the
  matching rows, not to the `a = ?` group size.
- Row sets are byte-identical to the pre-change plan for every shape tested, including
  the degraded paths (collation decline, unfaithful semantic probe, `IN` prefix).

## TODO

- Generalize `indexLeadingRangeIsOrderSafe` to an arbitrary index-column position; keep a
  leading-column wrapper for the existing call sites.
- Teach `tryIndexAccessPlan` the prefix-equality + trailing-range arm: seek columns,
  handled filters via `claimFirstPerRole`, cost, explanation string, `IN`-prefix decline.
- Generalize `buildIndexRangeBounds` to encode a fixed equality prefix ahead of the bound.
- Teach `analyzeIndexAccess` to return the composite range window, honoring `prefixLen`
  from the `plan=7` idxStr.
- Add access-path tests in `packages/quereus-store/test/pushdown.spec.ts` asserting both
  the chosen plan and the returned rows: ASC and DESC trailing column, one-sided and
  two-sided bounds, redundant same-side bounds, `IN` prefix (must not take the arm),
  collation-declined trailing column (must fall back with the residual intact).
- Add a read-your-own-writes case under an open transaction with pending rows inside and
  outside the narrowed window.
- Run `yarn test` and `yarn test:store`; the store suite is the one that exercises this
  path end to end.
- Update `docs/` where the store's supported access paths are listed (check
  `docs/module-authoring.md` and the store section of the docs index; the pushdown
  coverage table, wherever it lives, must gain this shape).
