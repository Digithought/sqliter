description: A window query that sorts its own rows used to tell the rest of the engine the rows still arrived in the source's original order, so a later join step trusted that false claim and silently dropped most of the answer. Fixed — the window now reports the order it actually emits.
files:
  - packages/quereus/src/planner/nodes/window-node.ts                          # the fix: computePhysical derives `ordering` alongside `monotonicOn`; private `windowSortKeys()`
  - packages/quereus/src/planner/framework/physical-utils.ts                   # extractOrderingFromSortKeys — reused; review added a NOTE about its all-or-nothing behaviour
  - packages/quereus/test/optimizer/window-ordering-advertisement.spec.ts      # plan-level assertions on the advertised ordering (8 cases)
  - packages/quereus/test/logic/07.5-window.sqllogic                           # pins at end of file (tables `wmj`, `wpo`)
  - docs/window-functions.md                                                   # § "What the WindowNode advertises as its emit order"
  - docs/optimizer-streaming.md                                                # § output invariant — now covers `ordering`, not just `monotonicOn`
difficulty: medium
----

# Window node advertises the order it actually emits

## What was wrong

`WindowNode.computePhysical` derived `monotonicOn` across four carefully
distinguished cases and then passed `ordering` straight through from the source
with no case analysis at all. `ordering` is the stronger of the two claims — an
exact `{ column, desc }[]` emit order. A window with `order by … desc` sorts its
rows and emits descending but told the optimizer they were still in the source's
ascending order; a merge join above it walked the descending stream as if
ascending and stopped matching after the first row. Three of four rows vanished,
no error raised.

## What shipped

One derivation, four cases, `ordering` and `monotonicOn` computed in the same
`if`/`else` chain so they cannot drift apart:

| case | emitter behaviour | `ordering` |
| --- | --- | --- |
| `streaming` config set | source order, row pass-through (`runStreaming`) | source's |
| buffered, no PARTITION BY, no ORDER BY | source order (`sortRows` returns rows unchanged) | source's |
| buffered, no PARTITION BY, ORDER BY present | sorted by window ORDER BY (`sortRows`) | `extractOrderingFromSortKeys` over the window ORDER BY keys |
| buffered, PARTITION BY present | partitions in first-seen order, sorted within each | `undefined` |

`monotonicOn` keeps its previous behaviour exactly. A private
`WindowNode.windowSortKeys()` adapts `orderByExpressions` +
`windowSpec.orderBy[i].direction` into the shape `extractOrderingFromSortKeys`
takes. Column indices need no shifting: the helper reports positions in the
source row, and the window only appends columns.

## Review findings

Read the implement diff (`ec00e450`) first, then the touched and adjacent source:
`runtime/emit/window.ts` (all four emitter paths, `sortRows` / `processPartition`
/ `groupByPartitions` emit order), `planner/framework/physical-utils.ts`,
`planner/nodes/sort.ts` (the mirror the fix follows), `rules/window/
rule-monotonic-window.ts`, `rules/join/equi-pair-extractor.ts`,
`runtime/emit/merge-join.ts`, `planner/building/select-window.ts`, and every
`ordering:` advertisement in `planner/nodes/*.ts`.

**Verified sound, no change needed:**

- Each of the four cases matches what the emitter does. `processPartition` yields
  `sortRows`'s output in sorted order; `sortRows` returns the array untouched
  when there is no ORDER BY; `groupByPartitions` is insertion-ordered.
- The `partitionExpressions` / `orderByExpressions` the derivation branches on
  cannot desync from the `windowSpec` arrays the emitter branches on: they are
  built 1:1 in `select-window.ts`, and `withChildren` reconstructs them by the
  same lengths. `WindowNode` is constructed in only those two places.
- The new descending claim is *consumed* correctly: merge join admission
  (`isOrderedOnEquiPairs`, `reorderEquiPairsForMerge`) rejects any `desc`
  ordering outright, which is precisely why the repro now returns four rows.
- Stacked windows: `rule-monotonic-window` reads the source's `physical.ordering`
  and now sees a truthful one. The implementer reasoned this through without a
  test; a test now exists (below).
- `monotonicOn` set while `ordering` is undefined (leading ORDER BY key is a
  plain column, a later key is not) is permitted by `plan-node.ts`'s stated
  contract and is what `SortNode` does. The implied claim is also true — rows
  sorted by `(a, f(b))` are ordered on `a`. Not a defect.
- NULLS FIRST/LAST is absent from `Ordering`, but every consumer today is
  null-placement-blind: merge join skips NULL keys wherever they sit in the run
  (`compareKeys` → `null` → advance), so no current consumer can be misled. The
  implementer's `NOTE:` tripwire at the derivation site is the right disposition;
  I tightened its wording to say *why* it is currently harmless.

**Fixed in this pass (minor):**

- The derivation's 30-line comment restated the same four-case table that
  `docs/window-functions.md` now carries. Trimmed to the invariant plus a pointer
  to the doc, with one short comment per branch; the partitioned case (which
  falls out of the chain assigning nothing) now says so explicitly instead of
  being silent.
- `docs/optimizer-streaming.md`'s "Output invariant" paragraph still described a
  streaming window as preserving only `monotonicOn`. Updated to cover `ordering`
  and to point at the buffered cases, which is where the bug lived.
- `window-ordering-advertisement.spec.ts`'s pass-through test was
  self-fulfilling: it scanned every plan node for the first ordering it could
  find and, if it found none, asserted the window advertised none — so it passed
  either way. It now locates the window's own child through `query_plan`'s
  `parent_id`, asserts that child really does advertise an ordering, and compares
  against it.
- Added the stacked-window test the implementer flagged as missing: a buffered
  `desc` window feeding a second window, asserting the inner window's descending
  order is what the outer one relays (column indices differ across the
  projection between them, so each is compared against its own child).

**Filed (major, out of scope for a fix here):**

- `tickets/backlog/debt-nothing-checks-advertised-row-order.md` — nothing
  verifies that an advertised `ordering` is one the node can actually emit;
  `plan-validator`'s `validateOrdering` only bounds-checks column indices. Filed
  at the invariant level rather than as a point bug because a second instance
  turned up during the review: `AggregateNode.computePhysical` relays its
  source's ordering unchanged even though its output row is
  `[GROUP BY..., aggregates...]` — a different column space — while its two
  physical counterparts both get it right. That one is dormant (the logical
  aggregate has no emitter and is always rewritten before any consumer reads it),
  so the ticket carries it as evidence, with what would make it reachable.

**Parked as tripwires, not filed:**

- `extractOrderingFromSortKeys` is all-or-nothing: `order by a, b * 2` yields no
  ordering at all, though the leading `a` prefix would be a sound weaker claim
  that merge join could use. `NOTE:` at the helper, since it is a missed
  optimization, not a defect, and relaxing it touches `SortNode` and
  `rule-grow-retrieve` too.

**Checked and empty:**

- No accepted-tradeoff `NOTE:` exists at any site the change touches, so nothing
  was re-filed against a prior human decision.
- No plan-shape expectation in the suite changed, before or after this review —
  the implementer's note that "we may have lost a plan we used to get" stayed
  untested because nothing in the corpus exercises a merge join or sort elision
  above a partitioned window. That remains an unmeasured direction; it is not a
  correctness risk (the change only *withholds* claims there), so no ticket.
- `yarn test:store` still not run; planner-only change, and the store leg of the
  new `.sqllogic` pins is untested. Unchanged from the implement handoff.

## Validation

- `yarn lint` — passes (includes `tsc -p tsconfig.test.json --noEmit`, so the
  edited spec is type-checked).
- `yarn test` — passes, 4m59s, no failures (25 pre-existing pending).
- `window-ordering-advertisement.spec.ts` — 8 passing.

Non-vacuity of the plan-level spec is provable by inspection: the desc case
asserts `[{column: 2, desc: true}]`, where the pre-fix code returned the source's
`[{column: 0, desc: false}]`. The implementer separately confirmed by reverting
the fix that the first `.sqllogic` pin fails with the ticket's exact symptom
(`Row count mismatch. Expected 4, got 1`).

## Adjacent defect, still open (expected)

The ticket's second repro is half-fixed, as predicted: the correlated-count
column is now right, while `row_number()` values remain wrong. That is the
independent defect tracked by
`bug-window-column-read-by-position-hits-wrong-row` (`tickets/implement/2-…`),
which lists this ticket as its prerequisite and should add the pin once it lands.
