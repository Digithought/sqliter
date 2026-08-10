description: The planner can now say how many rows a join will produce after a query is fully optimized, so the row estimates above a join — including the WHERE-clause estimate it had learned to compute but could not use — are real numbers instead of blanks.
files: packages/quereus/src/planner/util/row-estimates.ts, packages/quereus/src/planner/nodes/join-utils.ts, packages/quereus/src/planner/nodes/join-node.ts, packages/quereus/src/planner/nodes/bloom-join-node.ts, packages/quereus/src/planner/nodes/merge-join-node.ts, packages/quereus/src/planner/nodes/key-set-semi-join-node.ts, packages/quereus/src/planner/rules/cache/rule-cte-optimization.ts, packages/quereus/test/optimizer/join-row-estimates.spec.ts, docs/optimizer.md, docs/optimizer-joins.md
----

## What shipped

Every relational node carries two row counts: a **logical** one (the `estimatedRows` getter,
derived from the *logical* children) and a **physical** one (`physical.estimatedRows`, folded
bottom-up during the Physical pass). They diverge once the optimizer replaces a `Retrieve`
subtree with a physical access node — `SeqScanNode` / `IndexScanNode` / `IndexSeekNode` declare
no `estimatedRows` getter, so a logical read through one yields `undefined` while the physical
property holds the catalog-derived count.

- **`physicalSourceRows(childPhysical, source)`** (`planner/util/row-estimates.ts`) — physical
  count first, logical getter as fallback, `??` so a physical `0` is kept.
- **`joinPhysicalRows(joinType, coverageRows, leftRows, rightRows)`**
  (`planner/nodes/join-utils.ts`) — the proven key-coverage cap when `analyzeJoinKeyCoverage`
  produces one, else the `estimateJoinRows` heuristic over the same physical inputs, floored.
- **Call sites**: pure relays stamp `physicalSourceRows(...)` (`AliasNode`, `RetrieveNode`,
  `ProjectNode`, `SortNode`, `WindowNode`, `CacheNode`, `EagerPrefetchNode`, `AssertedKeysNode`,
  `LensAuxiliaryAccessNode`, `AsofScanNode`); formula nodes keep the formula in one private
  `rowsFrom(sourceRows)` shared by the getter and `computePhysical` (`DistinctNode`,
  `LimitOffsetNode`, `OrdinalSliceNode`, the three aggregates, `FanOutLookupJoinNode`); the three
  join classes go through `joinPhysicalRows`.

On the ticket's own example (100 orders over 10 regions, both `ANALYZE`d) the join reports 100 and
the filter above it 19, where both were previously blank.

Docs: `docs/optimizer.md` § "The number the selectivity multiplies", plus two corrected code
snippets. Golden plans regenerated (5 files, 18 added lines, no shape changes).

## Review findings

### Checked

Read the implement diff (`5252dcbf`) before the handoff summary. Covered: the two new helpers and
every converted call site; `analyzeJoinKeyCoverage`'s cap semantics; the `estimateJoinRows`
heuristics per join type; child-index alignment between `getChildren()` and `childrenPhysical`
(`FanOutLookupJoinNode` and `KeySetSemiJoinNode` both correct); flooring and 0-preservation;
whether any formula node can hand a fractional count to a join (none can — every formula floors);
the regenerated goldens; the new spec; every doc file the change touches and several it should
have; and — the part the handoff did not do — a sweep of the *consumers* that read
`physical.estimatedRows`, since the change makes those numbers reach places they never did.

Ran, all from the repo root: `yarn lint` (every workspace; eslint + `tsc --noEmit` over the specs)
— clean. `yarn test` (every workspace) — exit 0, no failures; quereus itself **8249 passing, 13
pending** against the implement handoff's 8244 (+5 = the tests added below). `yarn test:store` not
re-run: the review's only source change is comment text plus one behaviour-preserving inline, and
the implement stage ran it green.

### Found and fixed in this pass

- **Four stale comments that this change itself invalidated.** `rule-filter-selectivity.ts` still
  said the stamped selectivity "does NOT yet move `estimatedRows` above a join … tracked in backlog
  `debt-join-rows-from-physical-children`" — describing the ticket being reviewed as pending.
  `rule-nested-loop-right-cache.ts` and `rule-fanout-batched-outer.ts` both explained their
  subtree-descent as a workaround for pass-throughs (notably `AliasNode`) not relaying the physical
  estimate, which is now false; the descent is still needed, but for a different set of nodes, so
  each comment now names the real ones. `docs/optimizer-joins.md` carried the same claim as
  `rule-fanout-batched-outer.ts` verbatim.
- **Dead indirection in `KeySetSemiJoinNode`.** The conversion added a private `rowsFrom(target,
  keys)` whose whole body was `estimateJoinRows(target, keys, 'semi')`, and the logical getter did
  not route through it — so it was a one-line wrapper with a single caller, not the shared-formula
  pattern its doc comment claimed. Inlined.
- **The tripwire's central claim was wrong.** The handoff parked a `NOTE:` in `row-estimates.ts`
  saying a never-`ANALYZE`d table's 0 now travels much further, but that "no current consumer
  misbehaves on 0". One does — see below. The NOTE now says which kinds of consumer are safe
  (those that floor, those using a `>` test) and which are not, and points at the ticket.
- **`docs/optimizer.md`** gained the consumer-side half of the story: which nodes still do not
  relay, and that a 0 means unknown rather than empty.

### Found and filed

- **`backlog/bug-cte-cache-gate-reads-unknown-as-empty`** (new). `ruleCteOptimization` decides
  whether to buffer a `with` clause from `sourceSize > 0` — but a never-`ANALYZE`d table reports 0
  rows meaning *unknown*, so the decision turns on whether a maintenance command has been run. The
  rule also never consults the reference count, so once a real estimate exists it caches
  single-reference CTEs, which two existing specs assert should be inlined. Verified by running the
  same queries with and without `analyze`: a single-reference CTE gains a CACHE node purely from
  `analyze` having run. Filed rather than fixed because the fix is a design question, not a
  one-liner — the rule's own in-code NOTE says the multi-reference cache double-buffers against the
  `materialization-advisory` pass, so the right answer may be *fewer* caches, not more. The
  obvious one-line patch (`|| defaultRowEstimate`) was tried in this pass and fails both specs; the
  ticket records that so nobody repeats it, and the call site carries a `NOTE:` pointing at it.

  For the record on blast radius: this ticket's contribution is that the estimate now reaches the
  gate at all. Multi-reference CTEs over un-analyzed tables lost their CacheNode as a result. The
  analyzed-database half of the defect predates it.

- **Appended three arms to `backlog/debt-row-estimates-die-at-set-operations`** rather than filing
  separately, since they resolve at the same class of site that ticket already claims: `CTENode`
  and `CTEReferenceNode` declare no row estimate in either view (so the count dies at any named
  subquery — verified on a self-joined CTE, where the inner `Project` reports a number and the CTE
  reference and the join above it do not); `InsertNode` likewise; and `RemoteQueryNode`, which is a
  leaf and so needs a number chosen rather than relayed. The ticket also now carries the
  0-means-unknown caution, so whoever extends the relay checks consumers as well as producers.

### Found and left alone, with reasons

- **The `physical?.estimatedRows ?? node.estimatedRows` idiom now appears in three places** — the
  new `physicalSourceRows` plus pre-existing local helpers in `rule-fanout-lookup-join.ts` and
  `rule-fanout-batched-outer.ts`. Not unified: the helper is shaped for `computePhysical`, which
  receives a child-properties array and runs before the node's own `physical` exists, whereas the
  rules read a fully-computed node. Folding them together would mean calling
  `physicalSourceRows(node.physical, node)`, which reads worse than the two lines it replaces.
- **`TableReferenceNode` stamps no physical count** (its logical getter carries the catalog
  number). Cosmetic EXPLAIN asymmetry only, and stamping it would churn the golden corpus again.
- **The heuristics themselves** (`inner` = `left × right × 0.1` floored at 1, `left` = left's count
  regardless of fan-out, `semi` = half the left side) are crude, and they now decide more than they
  used to. Out of scope: they back the logical getters too, which feed cost comparisons this ticket
  has no business perturbing — the handoff's reasoning here is right.

### Tests

The implement spec's two end-to-end assertions were guarded by `if (alias)` / `if (sort)`, which
made them pass vacuously if the node were absent. Verified the alias *is* present and reports 100,
and tightened that assertion to require it (the `sort` guard is genuine — an `order by` on the PK
can be satisfied by the scan's ordering, so no Sort need exist). Added: unit coverage for
`physicalSourceRows`, which the implement pass tested only indirectly — physical-wins,
logical-fallback, physical-`0`-is-not-a-fallthrough, both-unknown; and an end-to-end `left join`
with no key coverage, closing part of the handoff's "outer joins are unit-tested only" gap by
exercising the heuristic fallback through a planned query rather than a direct call. `right`,
`full`, `semi`, `anti` and the merge-join path remain unit-only — reaching them end-to-end needs
the optimizer to choose those shapes, which is a fixture-design problem rather than a missing
assertion.

Total: 8244 → 8249 passing.

### Empty categories

No resource-cleanup, error-handling or type-safety findings: the change adds no I/O, no lifetimes
and no new failure modes — it is arithmetic over `number | undefined`, and `strict` plus the
`--noEmit` test pass cover the type surface. No source-hygiene findings: the new helper file is 45
lines, `join-utils.ts` is unchanged in size at 535, and the extracted `rowsFrom` methods are the
right shape (one formula, two callers) everywhere except the `KeySetSemiJoinNode` case fixed above.
No pre-existing failures observed; `tickets/.pre-existing-error.md` not written.
