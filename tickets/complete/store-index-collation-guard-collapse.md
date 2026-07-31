---
description: The persistent store no longer consults a table-wide sorting rule when deciding whether it can use an index to answer a query; it now asks only whether the index's stored bytes agree with how those values get compared. That restores fast index lookups for the most ordinary kind of indexed text column, and lets duplicate checks use the index too.
files:
  - packages/quereus-store/src/common/pk-key-resolution.ts          # indexPrefixSeekIsCollationExact + indexLeadingRangeIsOrderSafe
  - packages/quereus-store/src/common/store-module-access-plan.ts   # eqSafeToHandle/rangeSafeToHandle deleted
  - packages/quereus-store/src/common/store-table-scan.ts           # EQ gate on the point AND multi-seek arms
  - packages/quereus-isolation/src/isolated-table.ts                # canSeekForConstraint widened past BINARY-only
  - packages/quereus-store/README.md                                # UNIQUE-seek collation bullet rewritten
  - docs/store.md                                                   # § Order preservation
  - docs/design-isolation-layer.md                                  # § When Phase 2 may seek
---

# Collapse the secondary-index collation guards

## What shipped

A store-backed table keeps its rows and indexes as sorted byte strings. Text becomes bytes
under *some* sorting rule (`BINARY`, `NOCASE`, or a custom one). The prereq ticket
(`store-index-key-column-collation`) made index bytes encode under the index column's own
collation instead of a single table-wide rule `K`. This ticket removed the safety checks
that only existed to cope with the old mismatch — checks phrased as "is `K` coarser than
the column's rule?", which cost an index on an ordinary undecorated `text` column of a
default (`NOCASE`) table its range seek.

Two shared predicates now decide, both in `pk-key-resolution.ts` and both called by BOTH
the access planner (`tryIndexAccessPlan`, which marks filters handled) and the scan
(`StoreTableScan`, which builds the byte window), so the two can never disagree:

- `indexPrefixSeekIsCollationExact` — equality/prefix. Does the collation the index bytes
  are keyed under equal the collation the post-fetch filter re-compares under?
- `indexLeadingRangeIsOrderSafe` — range. The same question plus the collation's
  `orderPreserving` assertion.

The isolation layer's `canSeekForConstraint` widened from "every enforcement collation is
BINARY" to the same per-column question, so a `collate nocase` index-derived UNIQUE now
answers through an O(log n) seek instead of an O(n) underlying scan.

The one shape that still declines everywhere is a column that can hold text but is not
declared `text` — `any`, `json`, the temporal types — carrying a declared `COLLATE`: those
key hard-`BINARY` (the collation their `compare` actually uses) while every comparison
against them uses the declared name.

## Review findings

**Deviation from the plan text, checked and upheld.** The implement ticket was told to
delete the equality gate outright and to write the range gate over the column's
*comparison* collation on both sides. The implementer refused both and kept a
key-vs-comparison test instead. That call is correct and I verified it rather than taking
it on faith: with the ticket's version, `where v = 'BOB'` over `v any collate nocase`
seeks a BINARY-equal window and returns nothing while the unindexed query returns the row,
and the range gate would admit a NOCASE-ordered window over BINARY bytes. Both are pinned
by tests now.

**Correctness of the two new predicates — checked, no defects found.** Traced
`indexResidualCollation` against what `matchesFilters` actually resolves
(`indexColumnCollations` → `resolveFilterCollations`): identical three-step fallback, so
the equality gate admits every `text` column and declines exactly the
text-capable-but-not-`text`-with-`COLLATE` shape, as documented. Checked the
planner/scan prefix-length agreement in both directions (the scan's prefix can be shorter
than the planner's, when a semantic-ordering column breaks it, and longer, when extra
constraints are pushed) — both directions degrade to a full scan whose residual re-applies
every pushed constraint, so neither loses a row.

**Fixed inline — a scan path the planner's gate was not backed on.**
`StoreTableScan.scanMultiSeek` re-checks the planner's semantic-ordering decline and
treats a violation as a malformed plan, but had no equivalent re-check for the collation
decline — the one arm where `analyzeIndexAccess`'s new defense-in-depth gate did not
reach. Added the same `indexPrefixSeekIsCollationExact` check there, raising the same
`INTERNAL` malformed-plan error as its siblings.

**Fixed inline — dead import.** `keyOrderMatchesCollation` became unused in
`store-table-scan.ts` when `indexRangeIsOrderSafe` started delegating; only `{@link}`
references remained. Removed.

**Fixed inline — a stale ticket pointer.** A test comment pointed at
`backlog/bug-memory-any-collate-index-under-fetch`, which does not exist; the defect was
filed as `fix/any-collate-index-changes-query-answer`.

**Fixed inline — documentation and test rationales left behind by the prereq.** These
describe the *write*-side UNIQUE seek, which the prereq ticket changed and its review did
not sweep. All of it still passed, which is exactly why it was worth finding: the
assertions were right and the explanations were lies.

- `packages/quereus-store/README.md` still stated that index-column bytes are encoded
  under the table key collation `K` and that a seek is admitted when `K` is coarser than
  the enforcement collation. Both false since the prereq. Rewritten to the actual rule,
  including why the guard is kept at all (the `_uc_*` name-collision path).
- `test/unique-constraints.spec.ts` § *collation guard*: five test titles named an arm
  that is no longer taken — "K = BINARY over C = NOCASE falls back to the full scan" now
  seeks, and so do the two RTRIM cases. Titles and rationales corrected; no assertion
  changed, because the outcome each asserts (dup rejected, non-dup admitted) must hold on
  either arm.
- `test/pushdown.spec.ts` and `test/key-set-seek-store.spec.ts` each carried a case-variant
  IN-list test whose whole premise was that `'a'` and `'A'` share ONE `K`-encoded window.
  They no longer do. Comments corrected. Noted in the pushdown one that the merged-window
  case it was written to guard is now **unreachable** for a text column — key collation and
  residual collation are always equal there, so two IN values can only share a window when
  they are also residual-equal. That is lost coverage with no reachable shape left to
  restore it against, not a gap to fill.
- `test/index-column-collation.spec.ts` justified a seek by "K coarser"; corrected.

**Fixed inline — the coverage gap the handoff flagged.** The handoff asked a reviewer to
establish whether the memory backend keys an index with no explicit `COLLATE`, over a
`collate nocase` column, under NOCASE "by construction rather than by luck". It is by
construction: `buildIndexSchema` (`schema/manager.ts:2453`) and `importIndex`
(`:3352`) both resolve every `IndexColumnSchema.collation` to its effective value at
create time (explicit index `COLLATE` → table column collation → BINARY, normalized), so
`MemoryIndex.createSingleColumnKeyFunctions`' `specCol.collation ? resolver(…) : undefined`
never sees the unset case for a real index. Every existing test of the widened isolation
gate used an *explicit* index `COLLATE`, so the inherited-collation shape — the more common
declaration — was untested on the very gate that just widened. Added a memory-backed test
for it in `isolation-layer.spec.ts` with the construction argument in the comment.

**Tripwire recorded, not filed.** `indexResidualCollation` duplicates
`resolveIndexKeyCollations`' textual branch step for step, which is precisely why both
gates admit every `text` column today. Change one fallback without the other and the gates
silently start declining — or admitting — shapes nobody intended. Parked as a `NOTE:` on
`indexResidualCollation` rather than a ticket: nothing is wrong now, and the hazard only
trips on a future edit to one of the two.

**Checked and found clean, with reasons.** No new ticket was filed and no `blocked/` entry
raised, because nothing surviving verification needed one:

- *Resource cleanup* — nothing added acquires a handle; the one cache
  (`indexKeyCollationsCache`) is a `WeakMap` keyed on the index schema and correctly
  invalidated on column-array replacement.
- *Error handling* — the new multi-seek gate raises the same `QuereusError(INTERNAL)` as
  its siblings rather than degrading silently; every other decline returns a cost-only
  plan or `null`, which routes to a full scan whose residual is authoritative.
- *Type safety* — no `any`, no assertions weakened; `yarn typecheck` clean across all
  workspaces.
- *Source hygiene* — `pk-key-resolution.ts` is 399 lines (`wc -l`), the two new functions
  are 13 and 15 lines respectively, single-purpose, and the planner shed 30 lines of
  inlined predicate. No file grew past its neighbours.
- *Docs* — read `docs/store.md` § Order preservation and § Built-in Collations,
  `docs/design-isolation-layer.md` § When Phase 2 may seek and § Trade-offs in full rather
  than skimming the diff. Both are accurate against the shipped code. `docs/store.md:613`
  and the `mv-constraints.md` / `optimizer-rules.md` coarser/finer discussions are about a
  *different* collation question (declared vs index collation for UNIQUE candidate
  generation and for the planner's own seek cover) and are untouched by this change.
- *Known gaps from the handoff, re-checked and accepted as-is*: the isolation gate's `any`
  branch is not independently observable through the store (the store's own equality gate
  declines first — defense in depth, and the memory-backed test does observe it); there is
  still no store-mode row-count proof that the widened UNIQUE seek is the arm taken, which
  is what `backlog/debt-iso-store-unique-seek-rowcount` exists for and which the implement
  pass correctly updated. Neither is a defect.

**Not measured.** The performance claim throughout is a plan-shape change — full scan plus
residual becomes a bounded index seek with the filter marked handled, and an O(n)
underlying scan becomes an O(log n) index seek. No timing was taken, on either the
implement pass or this one.

## Defect filed during implementation, still open

`tickets/fix/any-collate-index-changes-query-answer.md` (repro: verified). On an in-memory
table, creating an index on a column declared `any collate nocase` changes the answer to
`where v = 'BOB'` from `[1]` to `[]`. Root cause: `ANY_TYPE.compare`
(`packages/quereus/src/types/builtin-types.ts:328`) hard-codes `BINARY_COLLATION` and
discards the collation argument, so the memory index's key comparator partitions BINARY
while the engine's `=` applies the declared collation. The store and the isolation layer
both decline the index for this shape — that is what this ticket's surviving guards do —
and memory has no equivalent decline. Which of the two answers is correct is a real
decision, which is why it went to `fix/` rather than being resolved here.

## Validation

- `yarn build` — clean.
- `yarn lint` — clean.
- `yarn typecheck` — clean.
- `yarn test` — 0 failing. Engine 8277 passing / 13 pending, store 1281, isolation 369
  (368 + the one added here), sync 643, plus the smaller packages.
- `yarn test:store` — 8269 passing, 21 pending, 0 failing, matching the prereq's baseline.
