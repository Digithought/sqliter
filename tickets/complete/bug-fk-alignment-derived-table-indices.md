---
description: Fixed queries that join a sub-select against a table returning wrong answers or crashing, because the planner was matching columns by their position in the sub-select's result instead of their position in the underlying table.
files:
  - packages/quereus/src/planner/rules/join/rule-join-elimination.ts
  - packages/quereus/src/planner/rules/join/rule-fanout-lookup-join.ts
  - packages/quereus/src/planner/rules/join/rule-join-key-inference.ts
  - packages/quereus/src/planner/rules/subquery/rule-semi-join-fk-trivial.ts
  - packages/quereus/src/planner/rules/subquery/rule-anti-join-fk-empty.ts
  - packages/quereus/src/planner/util/key-utils.ts
  - packages/quereus/src/planner/util/ind-utils.ts
  - packages/quereus/src/planner/analysis/coverage-prover.ts
  - packages/quereus/test/optimizer/rule-join-elimination.spec.ts
  - packages/quereus/test/optimizer/parallel-fanout.spec.ts
  - docs/optimizer-joins.md
  - docs/optimizer-rule-families.md
  - docs/optimizer.md
difficulty: medium
---

# Complete: foreign-key alignment compares base-table column positions

## The defect

A foreign key is declared in the base table's own column order. A join condition
is expressed in each join input's output column order, and a sub-select in the
FROM list renames, reorders, and drops columns freely. `rule-join-elimination`
and `rule-fanout-lookup-join` compared the two numbering schemes without
translating, so an output position could collide with an unrelated table column
and the wrong column was accepted as the foreign-key (or primary-key) column —
dropping a row from an outer join, inventing one on an inner join, or throwing
`FanOutLookupJoin: branch 0 produced more than one row for outer row`.

## The fix

Every alignment caller now resolves its subtree with `resolveTableColumnMapping`
and translates its equi-columns through `mapColumnsToTable` before comparing —
the pattern the semi/anti-join folds already used. The mapping is built by
attribute identity, so a computed column has no base-table origin and the
translation declines.

- `rule-join-elimination` — declines the rewrite when translation fails (it has
  no sound weaker option). Shared by the Project and the Aggregate entrypoints.
- `rule-fanout-lookup-join` — degrades that branch to `cross` instead, which is
  the data-driven 1:n treatment and always sound; failing to *prove* at-most-one
  costs the proof, not the whole cluster.
- `rule-join-key-inference` — diagnostic-only, translated the same way so its log
  line stops naming joins that are not foreign-key joins.
- `checkFkPkAlignment` / `lookupCoveringFK` state the base-table-index contract
  on their parameters.
- `isRowPreservingPathToTable` lost its `throughProject` option; a `ProjectNode`
  is now always peeled. The option only existed to stop callers pairing raw
  output positions against a table schema, and no such caller remains.

## Review findings

### Checked

**The diff, before the handoff summary.** Read `aaccfd37` cold, then the ticket.

**The one soundness argument the handoff flagged as highest-leverage** —
`isRowPreservingPathToTable` peeling `ProjectNode` for two more rules.
Confirmed at the emitter, not just from the comment: `runtime/emit/project.ts`
is a bare `for await (…) { … yield outputRow }` with no branch, and
`ProjectNode.estimatedRows` returns its source's count verbatim. A projection
cannot drop a row.

**Whether swapping `extractTableSchema` → `resolveTableColumnMapping` widened
what subtrees are accepted, beyond the Project peel the ticket admits to.** It
did not: `walkToTableSchema` (permissive) and `findBaseTableReference` walk the
same shapes — any single-relation wrapper down to a `TableReference` or
`Retrieve`. The new resolution is in fact *stricter* where it matters, because
it fails closed: a recursive CTE seed or an aggregate output carries a fresh
attribute id, so `mapColumnsToTable` returns undefined and the rule declines,
where the old schema-only resolution would have handed back a table and paired
raw indices against it.

**Whether the same bug class survives elsewhere.** Three other sites reason about
FK/PK or key coverage; none has it. `combineJoinKeys` / `analyzeJoinKeyCoverage`
compare equi-pairs against `RelationType.keys`, which are output indices too —
consistent numbering, no translation needed. `CatalogStatsProvider.joinSelectivity`
matches by column origin, not index. `coverage-prover.ts`'s inner-join admit path
already resolves attribute ids against the base `TableReferenceNode`'s own
attributes — the same technique, arrived at independently. No further callers
exist: `checkFkPkAlignment` and `lookupCoveringFK` have five callers between
them, all translated.

**Migration completeness.** All four `isRowPreservingPathToTable` call sites take
the new single-argument form; no stale option-object caller remains (the compiler
would have caught one anyway).

**The confirmation the handoff asked for** — is "no branch is ever classified
`atMostOne-*`, plus execution equals the nested-loop baseline" the right contract
to pin for the fan-out case, rather than the original ticket's "must not form a
fan-out"? Yes. Whether a cluster forms at all is a function of the cross-branch
memory guards and therefore of row estimates; the at-most-one *claim* is the
thing the fix is about.

### Found and fixed in this pass

**Two test gaps the handoff named, both now closed and both verified to fail when
the translation is reverted.**

- Composite FK through a sub-select that swaps the parent's PK columns
  (`rule-join-elimination.spec.ts`, `derived-table column indices`). Two arms:
  the pairing that *looks* aligned by output position is the permuted one the FK
  does not cover (must keep the join; eliminating would return 2 rows where the
  truth is 0), and its mirror, which is the declared pairing arriving in the
  opposite output order (must still eliminate). Positional pairing is the whole
  safety argument for composite FKs, so both directions needed pinning.
- The Aggregate entrypoint over a sub-select (`aggregate-anchored elimination`).
  It shares `tryEliminate` and so was fixed by the same change, but nothing drove
  it through a sub-select. Worth its own case because the aggregate-LEFT path
  deliberately skips both guards the INNER path relies on, which leaves the
  alignment check as the only thing standing between a 1:n join and a wrong
  `count(*)` — 1 instead of 2 on the reverted build.

**Three stale doc claims about `extractTableSchema`.** The change left it with
zero production callers, but `docs/optimizer.md` and the `ind-utils.ts` header
both still said it serves FK/key analysis — pointing a future author at exactly
the helper that cannot answer the alignment question, which is the defect this
ticket exists to prevent. All three (plus its own doc comment) now say what it is
not for and name `resolveTableColumnMapping` instead. The function itself stays:
it is the permissive half of the pair `extractRowSourceTableSchema` is defined
against, and two unit tests pin that contrast. (The handoff's claim that it is
"still used elsewhere" was only true of those tests.)

**A stale comment in `coverage-prover.ts`.** It described
`isRowPreservingPathToTable`'s accepted shapes as "TableReference / Retrieve /
Alias / Sort" and listed `Project` among what disqualifies in both walks — true
before this change, wrong after. Rewritten to state the divergence and why it is
safe.

### Recorded as tripwires, not tickets

- `rule-fanout-lookup-join.ts` (`recognizeBranch`) — a lookup side reading zero or
  several tables still bails the whole cluster, while an untranslatable *column*
  only degrades that branch to `cross`. Sound but inconsistent, and it costs
  clusters. `NOTE:` at the site says to fall through to the cross path if
  multi-table lookup branches ever show up as a missed optimization.
- `coverage-prover.ts` (`resolveFullScanTableRef`) — stops at `Project` where the
  logical predicate now peels it. Under-claim-safe. `NOTE:` at the site says to
  peel it there too if that shape shows up as a lost cover, and records that the
  column pairing below would not be disturbed by it.

### Noted, left alone

- The fan-out branch-mode test is named "does NOT classify … as at-most-one" but
  asserts `deep.equal(['cross-left', 'cross-left', 'cross-left'])`, which also
  pins that the cluster forms at all — i.e. it is coupled to the row/product
  guards. Kept, because the exact modes document the degradation path
  `docs/optimizer-joins.md` promises; flagged here so a future estimate change
  reads the failure as "guards moved", not "alignment broke".
- `rule-join-key-inference`'s translated path has no observable behavior (it
  logs and returns null unconditionally). Read-only verification is proportionate;
  no test added.

### No findings

Error handling, resource cleanup and cross-platform concerns: nothing to report —
the diff adds no I/O, no allocation with a lifetime, and no platform-specific
code. It is pure planner analysis over in-memory plan nodes, and the failure mode
throughout is "return null / undefined and decline the rewrite". Source hygiene:
no file grew materially (`ind-utils.ts` 324 lines, `key-utils.ts` ~610) and the
new helpers are short and single-purpose.

## Validation

- `yarn workspace @quereus/quereus run test` — **8336 passing, 13 pending, 0
  failing** (8333 before this pass; the 3 new tests). No golden-plan churn.
- `yarn lint` — clean. `yarn typecheck` — clean.
- Regression proof: with the translation in `tryEliminate` reverted, all four
  join-elimination sub-select cases that touch it fail, including both new
  composite arms and the new aggregate case. Source restored, tree verified clean
  against `HEAD` before proceeding.
