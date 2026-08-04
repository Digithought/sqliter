---
description: Retired a materialized-view rewrite guard that used to skip an optimization for certain grouped queries only because of a since-fixed bug in the normal (non-view) query path.
files:
  - packages/quereus/src/planner/analysis/query-rewrite-matcher.ts  # guard block, `'group-key-pinned'` reason, and `clausePinsOrEquatesGroupCol` all removed
  - packages/quereus/test/query-rewrite-aggregate.spec.ts           # forgo test replaced with a base-vs-view agreement test (~line 306)
  - docs/optimizer-rule-families.md                                 # § Aggregate-rollup arm — guard bullet removed
  - docs/materialized-views.md                                      # § Aggregate rollup — "Forgo guard" block removed
difficulty: easy
---

# Complete (pending review): retire the `group-key-pinned` forgo guard

## What was wrong

The materialized-view (MV) query-rewrite matcher had a guard,
`group-key-pinned`, that refused to answer a grouped query from a covering MV
whenever the query grouped on ≥2 columns and its `WHERE` pinned (`g = 1`) or
equated (`g1 = g2`) one of them. The guard existed only to dodge a bug in the
normal (base-table) query path: `rule-groupby-fd-simplification` used to drop
a functionally-determined grouping column and re-emit it at a shifted output
position, so the base path and the MV-rewrite path disagreed on column order
for that shape.

`bug-grouped-key-reorder-survives-to-output` (already landed, see
`tickets/complete/1-bug-grouped-key-reorder-survives-to-output.md`) fixed the
base path: the rule now caps a permuting rewrite with an order-restoring
`Project`, so the base and the MV-rewrite paths agree on column order by
construction. The guard therefore only cost coverage — real queries of this
shape were falling back to a base-table scan when the MV could have served
them directly.

## What shipped

- Removed the guard block in `matchAggregateFragmentToMv`
  (`query-rewrite-matcher.ts`, was ~line 716–727), the `'group-key-pinned'`
  member of `RewriteFailureReason`, and `clausePinsOrEquatesGroupCol` (its
  only caller was the removed guard — confirmed via `find_references` before
  deleting).
- Replaced the old forgo-assertion test in `query-rewrite-aggregate.spec.ts`
  with an agreement test: `select d, r, sum(amt) from sales where d = 1 group
  by d, r` against MV `byregion` (grouped on `d, r`).
  - Asserts the matcher now returns a match (exact-key: query group key ==
    MV group key).
  - Runs the query twice through `db.prepare(...)` — once with the default
    tuning (rewrite enabled) and once with `materialized-view-rewrite-
    aggregate` disabled (base recompute) — and asserts `getColumnNames()`
    is identical between the two AND the row values agree as a multiset
    (JSON-stringified rows, sorted, compared with `deep.equal`).
  - Verified the test fails correctly (with the exact pre-fix message,
    `group-key-pinned`) *before* removing the guard, then passes after.
- Updated `docs/optimizer-rule-families.md` § Aggregate-rollup arm and
  `docs/materialized-views.md` § Aggregate rollup ("Forgo guard" block) to
  drop the retired guard; both already pointed at this ticket's slug from the
  prior ticket's review pass, so this closes that forward reference.

## Validation

From the repo root: `yarn build` clean, `yarn workspace @quereus/quereus run
lint` clean (silent success — eslint + the test-file `tsc` pass both no-op on
success), `yarn test` **0 failing** (8660 in `packages/quereus`, 2865 across
the other workspaces — same totals as the prereq ticket's last clean run).
`yarn docs:check` reports the same two pre-existing, already-tracked ratchet
overages (`docs/schema.md`, `docs/sync.md` — `debt-docs-size-ratchet-red-
again`); neither doc I touched (`docs/materialized-views.md`,
`docs/optimizer-rule-families.md`) is in that list, and both only shrank.

## Use cases for review / further testing

- **The new agreement test is the only test added.** It covers exactly one
  shape: a 2-key exact-match rollup with a single pinning `WHERE` on one of
  the two keys. It does NOT add coverage for:
  - A **rollup (query key ⊊ MV key)** combined with a pin — e.g. an MV grouped
    on `(d, r, extra)` with a query `group by d, r where d = 1` (rollup to
    `{d,r}`, pinning `d`). The removed guard applied to rollup matches too
    (it read `queryGroupSet`, not an MV-key-specific set), so this shape is
    now reachable but untested here.
  - A **3+-key group** with a pin on a non-first key, or **multiple pins**
    (`where d = 1 and r = 2`).
  - The **`eq-column` (g1 = g2)** equate shape specifically — the added test
    only exercises `eq-literal` (pin). The matcher-level unit tests elsewhere
    in the file don't cover `eq-column` either; worth a reviewer's judgment
    call on whether that's a gap worth closing here or leaving to the general
    equivalence-harness property tests (`query-rewrite-equivalence.spec.ts`),
    which run fuzzed data across many shapes but don't specifically target
    the group-key-pinned shape.
  - The general aggregate-rollup **equivalence harness**
    (`query-rewrite-equivalence.spec.ts`) was NOT extended with a pinned-key
    query. Its `AGG_QUERIES` corpus has no `where k = <literal> group by k,
    j` or similar pin shape today, so the property-based fuzz coverage does
    not specifically exercise what this ticket unblocked. Reviewer may want
    to add one query to that corpus for defense-in-depth, since it runs many
    random data sets rather than one hand-picked fixture.
- **No new negative/`group-key-mismatch`-style test was needed** — the guard
  removal has no interaction with the other failure reasons (verified by
  reading the surrounding code: the guard sat after all other checks, right
  before the exact-key output-map assembly, so removing it only *admits* more
  matches, never changes any other `fail(...)` path).

## Review findings

None filed as separate tickets — this ticket's scope (delete a guard whose
justification is gone, add the evidence test the ticket demanded) is fully
closed by the above. The coverage gaps listed under "Use cases for review"
are handed to the reviewer as known gaps, not filed as tickets, since they
are optional hardening rather than defects.
