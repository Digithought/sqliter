---
description: When a query filters a big table by a set of values coming from a subquery, the engine now collects that set first and looks up just those rows in the index, instead of reading the whole table.
prereq: feat-runtime-key-set-protocol
files:
  - packages/quereus/src/planner/nodes/key-set-semi-join-node.ts      # NEW — node + KeySetPushdown + RUNTIME_SET_MAX_KEYS
  - packages/quereus/src/planner/rules/access/rule-key-set-seek.ts    # NEW — the rewrite + all gates
  - packages/quereus/src/runtime/emit/key-set-semi-join.ts            # NEW — drain/decide/probe + stampMultiSeek
  - packages/quereus/src/runtime/emit/join-key-extractor.ts           # NEW — key extraction shared with bloom-join
  - packages/quereus/src/runtime/emit/bloom-join.ts                   # re-pointed at the shared extractor
  - packages/quereus/src/planner/nodes/plan-node-type.ts              # KeySetSemiJoin
  - packages/quereus/src/planner/optimizer.ts                         # registration after monotonic-limit-pushdown
  - packages/quereus/src/runtime/register.ts                          # emitter registration
  - packages/quereus/src/planner/nodes/table-access-nodes.ts          # IndexScanNode.orderingLoadBearing (NEW field)
  - packages/quereus/src/planner/rules/shared/index-style-context.ts  # orderingLoadBearing breadcrumb
  - packages/quereus/src/planner/rules/retrieve/rule-grow-retrieve.ts # sort-absorb sets / re-grow preserves the breadcrumb
  - packages/quereus/src/planner/rules/access/rule-select-access-path.ts # threads breadcrumb; classifyConstraintCover exported
  - packages/quereus/src/planner/rules/access/rule-monotonic-range-access.ts # carries the new field through rebuilds
  - packages/quereus/test/optimizer/key-set-seek.spec.ts              # plan shape + stampMultiSeek equivalence
  - packages/quereus/test/vtab/key-set-semi-join-runtime.spec.ts      # runtime behaviour incl. break-even boundary
  - packages/quereus/test/logic/08.4-key-set-semi-join.sqllogic       # NEW behaviour file (runs on memory AND store)
  - packages/quereus/test/logic/08.1-semi-anti-join.sqllogic          # one plan assertion made backend-agnostic
  - docs/optimizer-rules.md
  - docs/optimizer.md
difficulty: hard
---

# Key-set semi join: materialize the set, then seek the target — review handoff

## What shipped

`where col in (select …)` (and the correlated-EXISTS shapes that decorrelate to the
same join) over a column with a usable index now plans as:

```
KeySetSemiJoin  on target.col  (via <index>, breakEven=N, maxKeys=1000)
├─ target:    the access leaf, verbatim
└─ keySource: the inner relation, drained once
```

At runtime the node drains the key source into a set, **always** probes every target
row against it (identical to the hash semi join it replaced), and — when the distinct
key count is ≤ min(1000, the module-cost break-even) — rewrites the leaf's
`FilterInfo` into an ordinary single-column `plan=5` multi-seek, byte-identical in
shape to a literal `in (1,2,3)`, via `emitSeqScan`'s existing `FilterInfoOverride`
hook. No module runtime changed; no new runtime protocol exists. A seek can only
over-fetch (the probe trims it); every plan-time gate exists to make an under-fetch
impossible.

Validation state: `yarn lint`, `yarn build`, `yarn docs:check`, the full workspace
`yarn test` (7608 quereus + all other packages) **and** `yarn test:store` (7601,
LevelDB + isolation stack, includes the new sqllogic file) are all green.
`test/logic/07.7-in-subquery-caching.sqllogic` passes **unmodified**, as required.
No golden plans needed regeneration.

## Deviations from the ticket — read these first

1. **The prereq `feat-uncorrelated-in-semijoin` has not landed** (its implement run
   died on an API error before touching the tree; the ticket is still in
   `implement/`). Empirically this did not block the feature: uncorrelated
   filter-position `IN` **already** decorrelates to a semi join on current main (the
   decorrelation rule admits it today), so every IN-shaped test in this ticket runs
   against the real pipeline. When that ticket lands its own gates and tests, re-run
   this ticket's three suites; the rewrite composes with whatever semi joins reach
   PostOptimization and needs no change.

2. **The leaf gate admits ordering-only `IndexScan` leaves, not just `SeqScan`.**
   The ticket demanded `SeqScanNode` + `accessPath.kind === 'fullScan'` — but on the
   memory vtab every bare table scan physicalizes as an ordering-only
   `IndexScan` (`plan=0`, module always advertises PK ordering), so the rule as
   specified would have been dead code on the default backend. An ordering-only walk
   reads every row exactly like a full scan; the gate now accepts either, still
   requiring zero constraints and no limit/offset.

3. **A new correctness gate the ticket did not anticipate: `orderingLoadBearing`.**
   The ticket argued nothing above the hash join could depend on the leaf's order
   because `BloomJoinNode` propagates no ordering. That argument misses **sort
   absorption**: `rule-grow-retrieve` can drop a `SortNode` into the leaf *before
   decorrelation builds the join* (e.g. `… where v in (select …) order by pk` — the
   ORDER BY is absorbed by the primary-key walk), leaving no plan-level trace; the
   elision then rests on the runtime fact that a hash semi join streams its probe
   side in order. A pushed multi-seek emits in seek-key order and would break that
   ORDER BY (reproduced before the fix). Fix: sort absorption now stamps
   `orderingLoadBearing` on the index-style context; re-grows preserve it;
   `rule-select-access-path` lifts it onto `IndexScanNode`; the rule declines on it.
   Consequence: ORDER-BY-satisfied-by-the-leaf queries keep the hash join (correct,
   conservative). Reviewer: this breadcrumb is the most load-bearing new mechanism —
   hunt for OTHER invisible order dependencies (I found only sort absorption; the
   ordering-elision, merge-join, and stream-aggregate paths all read
   `physical.ordering`, which neither BloomJoin nor the new node claims).

4. **PK-keyed `IN` (the ticket's flagship `delete from big where id in …`) is NOT
   rewritten on the memory/store backends** — both sides are monotonic on the key,
   so it becomes a **merge** semi join before the rule (HashJoin anchor, per ticket)
   can see it. The rewrite fires on the secondary-index and non-walk-order-key
   shapes, which is where a seek beats the alternatives most. Filed
   `backlog/feat-key-set-seek-merge-semi-join` with the ordering-soundness analysis
   an extension needs. The perf sentinel is unaffected (its shape stays merge).

5. `stampMultiSeek` sets `indexInfoOutput.orderByConsumed: false` (the ticket's
   sketch spread the base). The base can carry a vacuous `true` from an
   ordering-only leaf; `false` matches the literal-IN arm's shape, which the
   equivalence test pins.

6. The 08.1 sqllogic plan assertion for correlated EXISTS now checks `joinType`
   only: under the memory vtab the plan is (legitimately) `KeySetSemiJoin`, under
   the store it stays `HashJoin` (the store declines runtime sets on its PK arm —
   `backlog/feat-store-pk-in-list-multiseek`). The assertion's intent — "a semi
   join exists" — is preserved for both backends.

## How to see it work

```sql
create table big (pk integer primary key, v integer null);
create index idx_v on big(v);
create table small (id integer primary key);
-- plans as KeySetSemiJoin via idx_v; at runtime the module's query() receives
-- idx=idx_v(0);plan=5;inCount=K when K ≤ breakEven, else the plan-time walk:
select pk from big where v in (select id from small);
delete from big where v in (select id from small);
```

`test/vtab/key-set-semi-join-runtime.spec.ts` observes exactly this via an
idxStr-capturing memory module.

## Test coverage (floor, not ceiling)

- **Plan shape** (`test/optimizer/key-set-seek.spec.ts`, 15 tests): fires on
  select/delete/update; declines on no-index, pushed-constraint leaf, anti/NOT IN,
  correlated, cross-type (INTEGER vs REAL), TIMESPAN, NOCASE-join-over-BINARY-index;
  peels through a residual Filter; the three ORDER BY interactions; and the
  `stampMultiSeek` ≡ literal-IN `FilterInfo` field-for-field test.
- **Runtime** (`test/vtab/key-set-semi-join-runtime.spec.ts`, 12 tests): plan=5
  delivery + row-pull counts; duplicate collapse (`inCount` = distinct); NULL
  skipping; empty/all-NULL inner never opens the target; >1000 keys scans; LIMIT
  stops early; prepared-statement re-drain with changed data; self-referencing
  DELETE snapshot; COARSER_SAFE over-fetch trimmed (proved seeked via idxStr); and
  the doctored-cost break-even boundary (7 keys seeks, 8 scans, identical rows).
- **sqllogic** (`08.4-key-set-semi-join.sqllogic`): behaviour-only cases run on both
  memory and store backends — membership, duplicates, NULLs, ORDER BY, NOCASE and
  BINARY collation, TIMESPAN semantic equality, DELETE/UPDATE, self-reference,
  multi-row DELETE in an explicit transaction.

## Known gaps for the reviewer

- **No abort/timeout test** for the drain loop (`throwIfAborted` is in place per
  row, untested), and no direct test of the missing-state INTERNAL guard in the
  override (hard to trigger without a scheduler fault).
- **Break-even interpolation math** is pinned end-to-end at one point (slope 10,
  breakEven 7) via the doctored module; the `slope <= 0` and `breakEven < 1` arms
  are code-read only.
- **Store/isolation depth** is deliberately thin here: `yarn test:store` is green
  (including the new sqllogic file), but the targeted store + isolation coverage
  (encoded seek windows, overlay merge with uncommitted rows, the merge-order
  assumption) belongs to `implement/feat-key-set-seek-store-isolation`, which
  already exists and names this ticket as its prereq.
- `validateAccessPlan` failures on the synthesized probes **throw** (per ticket:
  module bugs surface at plan time) — a misbehaving third-party module now fails the
  query instead of silently keeping the hash join. Reviewer may want an opinion on
  catch-and-decline instead.
- The three-probe `getBestAccessPlan` calls run on every qualifying hash semi join
  optimization; no caching. Cheap for both shipped modules; a slow third-party
  planner would feel it (tripwire, noted in the rule).

## Tripwires parked (index — analysis lives at the sites)

- `runtime/emit/key-set-semi-join.ts` (drain loop `NOTE:`): an NLJ-inner rescan
  re-drains the key source each pass — correct but wasteful; only matters if this
  shape ever appears under a nested-loop inner.
- `rule-key-set-seek.ts` (header): `orderingLoadBearing` declines are conservative —
  a future enhancement could re-sort the pushed output by the leaf's advertised
  order, or push when seek index = walk index (see the merge-join backlog ticket).
