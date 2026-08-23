description: The query planner writes down "how many rows do I expect here" as a plain number, with no way to say "I have no idea" — so a table nobody has gathered statistics for reports zero, and different parts of the planner read that zero as "empty", as "unknown", or as proof that a read can be deleted entirely.
files:
  - packages/quereus/src/planner/util/row-estimates.ts                     # physicalSourceRows — the shared helper; where a richer estimate type would live
  - packages/quereus/src/planner/rules/cache/rule-cte-optimization.ts      # `sourceSize > 0` — reads unknown as empty
  - packages/quereus/src/planner/cache/materialization-advisory.ts
  - packages/quereus/src/planner/rules/access/rule-select-access-path.ts   # selectPhysicalNode — the fold that deletes a read on a zero estimate
  - packages/quereus/src/planner/rules/access/rule-key-set-seek.ts         # arm 4 — merge-arm gate 2 reads a zero key-source estimate as "tiny"
  - packages/quereus/src/vtab/best-access-plan.ts                          # the `rows` field's documented meaning
  - packages/quereus/src/vtab/memory/module.ts                             # the one shipped module that makes the zero claim; also reads `request.estimatedRows || 1000`
  - packages/quereus/src/planner/nodes/set-operation-node.ts               # no estimatedRows getter at all, and computePhysical never stamps one
  - packages/quereus/src/planner/rules/join/rule-join-greedy-commute.ts    # arm 5 — reads the logical getter; its row-count swap test never fires
  - packages/quereus/src/planner/rules/join/rule-quickpick-enumeration.ts  # arm 5 — same read; sorts its greedy tours by a 1e9 sentinel
  - packages/quereus/src/planner/nodes/async-gather-node.ts
  - packages/quereus/src/planner/nodes/cte-node.ts
  - packages/quereus/src/planner/nodes/cte-reference-node.ts
  - packages/quereus/src/planner/nodes/delete-node.ts
  - packages/quereus/src/planner/nodes/dml-executor-node.ts
  - packages/quereus/src/planner/nodes/returning-node.ts
  - packages/quereus/src/planner/nodes/insert-node.ts
  - packages/quereus/src/planner/nodes/remote-query-node.ts
  - packages/quereus/src/schema/manager.ts                                 # hardcodes TableSchema.estimatedRows = 0 at table creation
  - packages/quereus/test/optimizer/plan-shape-decisions.spec.ts           # "CTE referenced once is inlined (no CACHE node)"
  - packages/quereus/test/plan/cte-materialization.spec.ts                 # "does not produce a CACHE node for single-use CTE"
  - docs/module-authoring.md                                               # the contract, currently stated in prose only
repro: verified
severity: wrong-result
likelihood: normal-use
tradeoffs: Changing the estimate representation touches every plan node and every storage module that answers an access-plan request — a wide, mechanical, backwards-incompatible change whose payoff is mostly better plans rather than fixed answers, so a maintainer may prefer to patch the two consumers that misread zero today.
----

# One number is asked to mean three different things

`estimatedRows` is a plain number on every plan node and on every access-plan answer a
storage module returns. It is currently used to express three distinct claims:

| claim | how it is spelled today |
|---|---|
| "I estimate about N rows" | `N` |
| "I have no idea" | `0` (a table that has never been `ANALYZE`d) |
| "I have proven nothing can match" | `0` (a module answering an access-plan request) |

`SchemaManager` hardcodes `TableSchema.estimatedRows` to 0 when a table is created, and
`vtab/memory/module.ts` reads the same field back as `request.estimatedRows || 1000`
*precisely because* 0 means unknown there. So both readings are live in the codebase at
once, and a fourth site treats 0 as a proof strong enough to delete a table read.

## The invariant that retires the class

Make the three claims separately representable, so a consumer cannot silently pick the
wrong one — e.g. a `RowEstimate` that is `{kind: 'unknown'} | {kind: 'estimate', rows}`
plus a distinct `provablyEmpty` flag on the access-plan answer, with the "no statistics"
default spelled `unknown` rather than `0`. Every consumer then has to say what it does
with `unknown`, and the compiler makes it say so.

Once that lands, the three arms below stop being defects and become two-line decisions.

## Arm 1 — the CTE caching gate reads "unknown" as "empty" (verified)

`ruleCteOptimization` decides whether to keep a `with …` result in memory from a row
estimate alone:

```ts
const sourceSize = PlanNodeCharacteristics.estimatesRows(source);
const shouldCache = (
    cteNode.materializationHint === 'materialized' ||
    (sourceSize > 0 && sourceSize < context.tuning.cte.maxSizeForCaching)
) && !isAlreadyCached;
```

`sourceSize > 0` is false for every un-analyzed database, so **whether the engine
caches a CTE depends on whether a maintenance command has been run**, not on anything
about the query.

The gate also never looks at how many times the CTE name is used. Once a real estimate
does arrive, it passes for *every* CTE in range, including single-use ones — which two
existing specs say should be inlined (`plan-shape-decisions.spec.ts` "CTE referenced
once is inlined (no CACHE node)" and `cte-materialization.spec.ts` "does not produce a
CACHE node for single-use CTE"). Those specs pass today **only because the estimate
happens to be 0**, so fixing the unknown-vs-zero reading without also adding a
reference count turns them red.

## Arm 2 — a zero estimate is read as proof of emptiness (static)

When the planner asks a storage backend how it would read a table, a **zero** row count
makes the planner conclude the read can produce nothing and replaces it with a static
empty result — no storage access, ever. That conclusion is a *proof*, but the field it
is read out of is documented as an *estimate*. A backend that rounds a very selective
estimate down to zero, or that reports how big the table is right now, makes the strong
claim without meaning to.

The worst arm is already closed: the fold used to fire on a plan with **no filters at
all**, because the guard restricting it to the proven-impossible case
(`handledFilters.every(...)`) is vacuously true over an empty list — so a backend
reporting an honest live size of zero for a plain full scan had its table read deleted,
and planning precedes execution, so "empty now" was not "empty later". What remains is
the representation problem: the interface still has no way to distinguish the two claims.

## Arm 3 — estimates stop existing at set operations

`SetOperationNode` has no `estimatedRows` getter at all and its `computePhysical` never
stamps one, so a query whose results are combined with `union` / `union all` /
`intersect` / `except` reports **no row count from the combine point upward**, in either
the logical or the physical view. Everything above it — sorts, enclosing joins, cache
sizing — falls back to a fixed default. `union all` is common, so this is the largest of
the gaps.

Three smaller groups have the same hole: `AsyncGatherNode` (has a logical getter that
composes its branches, but no physical one — and a PostOptimization rule substitutes it
for `union all` on high-latency plans), the CTE nodes (`cte-node.ts`,
`cte-reference-node.ts`), and the DML family (`delete-node.ts`,
`dml-executor-node.ts`, `returning-node.ts`, `insert-node.ts`, `remote-query-node.ts`).

`debt-join-rows-from-physical-children` already moved the single-source operators and
the join family onto `physicalSourceRows`; these four groups were left out.

## Arm 4 — a key-set rewrite's "is this key source too big?" gate reads unknown as tiny (verified)

`rule-key-set-seek`'s merge arm declines the rewrite when the key source's estimated row
count exceeds the number of keys the runtime would actually seek with — the point being
not to trade a streaming merge join for materializing an unbounded key set. The gate reads
`node.right.physical.estimatedRows` and proceeds when it is `undefined`.

It never fires. On both shipped backends a freshly-populated table's *physical* estimate
reads `0`, not `undefined`, so `0 > threshold` is false and every key source looks tiny.
Measured on the persistent store (`packages/quereus-store`) with 7 committed rows in the
key-source table: the leaf and the `Project` above it both report `estimatedRows: 0`, and
the rewrite fires. The rule's own comment already said this of the memory backend; the
store behaves the same way.

Cost is performance only — the rewritten node returns identical rows — so this is
evidence for the representation change, not a defect to patch in place. Once "unknown" is
spellable, this gate becomes a two-line decision like the others (its current
absent-estimate posture, proceed, is the one it should keep for `unknown`).

Running `analyze` first does not rescue the gate, so it cannot be covered by a test today.
Measured on the store while reviewing `feat-store-pk-key-set-seek-coverage`: with a
30-row key source, `analyze` makes the optimizer abandon the semi join altogether and pick
an index-nested-loop join instead (the target is walked, `idx=_primary_;plan=0`, and the
key source is seeked per outer row), so `rule-key-set-seek` never runs and its gate is
never consulted. Before `analyze` the rewrite fires with the estimate still reading 0.
Any test that tries to exercise this gate therefore pins an unrelated plan choice — which
is why the review recorded the measurement here rather than adding one.

## Arm 5 — the two join-ordering rules read a row estimate that is never there (verified)

Both rules that could reorder a join read the **logical** `estimatedRows` getter on their
inputs. Neither `AliasNode` nor `RetrieveNode` defines that getter — both stamp a row count
only into `computePhysical`, via `physicalSourceRows` — so for any table-backed input the
read is `undefined`, and each rule falls back to a sentinel that makes its comparison
meaningless.

- `rule-join-greedy-commute` (`planner/rules/join/rule-join-greedy-commute.ts`) substitutes
  `Number.POSITIVE_INFINITY`, so its swap test `rightRows < leftRows` is `Infinity <
  Infinity` — always false. **The rule's row-count arm never fires for table-backed
  inputs.** Its singleton-functional-dependency arm still works, so the rule is not dead,
  just not doing the thing its own comment advertises ("prefer the smaller input on the
  left").
- `rule-quickpick-enumeration` (`planner/rules/join/rule-quickpick-enumeration.ts`)
  substitutes `1e9` for every relation, so the `baseOrder` it sorts its greedy tours by is
  arbitrary. This one runs in the Physical pass, *after* access-path selection, so the real
  counts are sitting on `physical.estimatedRows` one node down and are simply not read.

Verified in-process on the memory module: two tables of 2,000 and 4,000 rows, joined and
then `analyze`d, written `from entry e join txn t` (4,000-row side named first). The
commute rule leaves the order untouched, and the resulting hash join reads all 4,000 rows.
Naming the tables in the other order produces a plan roughly 20x cheaper by the rule's own
cost model. Nothing between the two spellings differs except the order the tables were
written in.

Same root cause as Arm 3 — a producer/consumer mismatch around `physicalSourceRows` — and
the same one-line-per-site shape once "unknown" is spellable: `debt-join-rows-from-physical-children`
moved the single-source operators and the join family onto `physicalSourceRows` and left
these two join-*ordering* rules behind. Cost is performance only; both rules return correct
rows either way.

Two-table joins have a separate, narrower remedy landing independently
(`feat-index-nested-loop-seek-side-election` elects the seek side inside
`rule-join-physical-selection`, which does read `physicalSourceRows`), so the user-visible
sting of the greedy-commute arm is reduced but not removed — three-way and larger joins
still depend on QuickPick's arbitrary base order.

## Notes for whoever picks this up

- Arm 3 is a *producer* gap and arms 1–2 are *consumer* gaps. Filling arm 3 without
  fixing arm 1 makes the CTE caching behaviour change for every user at once — the
  producer work should not land first.
- `docs/module-authoring.md` states the access-plan `rows` contract in prose only; a
  representation change is the chance to make it checkable.

## Arm 4 (evidence) — the unknown sentinel picks the wrong join algorithm and the wrong access path

Two performance reports from a user running the IndexedDB store backend both traced to this
representation, not to the rules they appeared to be about. Recorded here as evidence for the
representation change rather than as separate tickets.

**Wrong join algorithm.** `rule-join-physical-selection` reads each side's row estimate as
`physicalSourceRows(...) || 100`, so a never-analyzed table — which reports `0` — is costed at
100 rows. Both sides of a join collapse to 100, and hash join wins arithmetically:
`min(100,100)*0.8 + 100*0.4 = 120` against an index-nested-loop at `100*(1.0+0.5+0.3) = 180`.
With real counts the same comparison is 4080 against 180 and the index-nested-loop wins.

Measured, store backend, 10,000-row and 20,000-row tables, one selective filter, result is one
row — the only variable is whether `analyze` ran:

| | plan | time |
|---|---|---|
| no `analyze` | `HashJoin` over a full scan of the 10,000-row side | 47.3 ms |
| `analyze` | `Join` with a correlated `IndexSeek` on the primary key | 17.8 ms |

The user read the first plan as the index-nested-loop rule failing to fire and asked whether
`feat-index-nested-loop-coverage-gaps` covered their shape. It does not — the rule is working
from a fabricated 100.

**Wrong access path.** The store's seek-versus-scan veto discriminates per query only when the
access arm's row estimate is statistics-backed; an arm still priced by a shape constant is
judged at the parity cost profile instead, which for the range arm never vetoes
(reasoning at `packages/quereus-store/src/common/store-module-access-plan.ts`, top of file).
Measured with the in-memory provider wrapped to declare the IndexedDB cost profile
(`pointRead: 3.0`), 20,000 rows, a range matching 55% of them:

| | plan | time |
|---|---|---|
| no `analyze` | `IndexSeek` — seeks, then resolves 11,000 scattered rows | 96.7 ms |
| `analyze` | `IndexScan` + `Filter` — one batched scan | 43.8 ms |

A 10% range correctly keeps the seek in both cases, so the machinery is right; it is starved.

**Why this belongs here.** In both cases the planner is not choosing badly from real numbers —
it is choosing from `0` spelled as a magnitude. A backend that knows its own size cannot help:
the store maintains a live row count and uses it for its *own* access-plan sizing
(`sizeRequestFromLiveCount`), but the engine's join costing reads
`table.statistics?.rowCount ?? table.estimatedRows`, which `SchemaManager` pins at `0` until
someone runs `analyze`. An "unknown" that consumers must handle explicitly would have forced
both sites to ask the backend or to declare their fallback, instead of silently costing a
20,000-row table as 100 rows.

Related: `bug-index-seek-row-estimate-capped-at-100` (fix stage) is the neighbouring defect on
the same cost path — an index seek reports a constant 100 rows regardless of the module's own
answer. The two compound.
