---
description: The persistent store no longer consults a table-wide sorting rule when deciding whether it can use an index to answer a query; it now asks only whether the index's stored bytes agree with how those values get compared. That restores fast index lookups for the most ordinary kind of indexed text column, and lets duplicate checks use the index too.
files:
  - packages/quereus-store/src/common/pk-key-resolution.ts          # NEW indexPrefixSeekIsCollationExact + indexLeadingRangeIsOrderSafe; doc rewrites
  - packages/quereus-store/src/common/store-module-access-plan.ts   # eqSafeToHandle/rangeSafeToHandle deleted; tableKeyCollation dropped from tryIndexAccessPlan
  - packages/quereus-store/src/common/store-table-scan.ts           # indexRangeIsOrderSafe delegates; analyzeIndexAccess gains the EQ gate
  - packages/quereus-isolation/src/isolated-table.ts                # canSeekForConstraint widened past BINARY-only
  - packages/quereus-store/test/collation-order-preserving.spec.ts  # 6 new tests + 2 re-derived
  - packages/quereus-store/test/pushdown.spec.ts                    # 1 flipped, 1 strengthened
  - packages/quereus-store/test/key-set-seek-store.spec.ts          # negative control replaced, positive added
  - packages/quereus-store/test/runtime-key-set-plan.spec.ts        # negative control replaced, positive added
  - packages/quereus-store/test/isolated-store.spec.ts              # 2 new store-backed UNIQUE-seek tests
  - packages/quereus-isolation/test/isolation-layer.spec.ts         # nocase seek re-derived; row-count control replaced; ANY decline added
  - docs/store.md                                                   # § Order preservation + Built-in Collations footnote
  - docs/design-isolation-layer.md                                  # § When Phase 2 may seek + Trade-offs bullet
difficulty: medium
---

# Review: collapse the secondary-index collation guards

## What the change is, in plain terms

A store-backed table keeps its rows and its indexes as sorted byte strings. Text has to be
turned into bytes under *some* sorting rule (`BINARY`, `NOCASE`, or a custom one). Until
recently the store turned every indexed text value into bytes using one table-wide rule
`K`, while everything that *compared* those values used the rule declared on the column
itself. The prereq ticket (`store-index-key-column-collation`) fixed the encoding side.

This ticket removes the safety checks that only existed to cope with that old mismatch.
They were written in terms of "is `K` coarser than the column's rule?", and because they
were, an index on an ordinary undecorated `text` column of a default (`NOCASE`) table
could not be used for `where name > 'm'` — the query fell back to reading the whole table.

## What each arm now asks

**Store read path (two decision sites, one shared predicate each).**

- `indexPrefixSeekIsCollationExact` — the EQUALITY/prefix gate. Does the collation the
  index bytes are keyed under equal the collation the post-fetch filter re-compares under?
- `indexLeadingRangeIsOrderSafe` — the RANGE gate. The same question, plus the collation's
  `orderPreserving` assertion (via the pre-existing `keyOrderMatchesCollation`).

Both live in `pk-key-resolution.ts` and are called by BOTH `tryIndexAccessPlan`
(store-module-access-plan.ts, which marks filters handled) and `StoreTableScan`
(store-table-scan.ts, which builds the window). They cannot drift.

**Isolation layer (`canSeekForConstraint`).** Widened from "every enforcement collation is
BINARY" to a per-column test: never-text → seekable; BINARY → seekable; otherwise seekable
only when `pkKeyCollationName` says a key-encoding backend keys that column under that same
collation (true for `text`, false for `any` / `json` / temporal).

## Deviation from the ticket text — read this first

The ticket said to **delete `eqSafeToHandle` entirely** ("the EQ arm no longer needs a
collation gate") and to write the range gate as `keyOrderMatchesCollation(db, col, C, C)`
where `C` is the column's *effective comparison* collation.

**Both are wrong for one column kind, and I did not do that.** A column that can hold text
but is not declared `text` — `any`, `json`, and the temporal types — is keyed hard-`BINARY`
by `pkKeyCollationName` (the collation those types' `compare` actually uses), while the
scan residual still compares it under its *declared* `COLLATE`. So for `v any collate
nocase`:

- deleting the EQ gate makes `where v = 'BOB'` seek a BINARY-equal window and return
  **nothing**, while the same query without an index returns the row. I confirmed this by
  writing the ticket's version first — `pushdown.spec.ts`'s existing ANY test
  (`collation-unsafe index over an ANY column…`) failed exactly that way.
- `keyOrderMatchesCollation(db, col, C, C)` with `C` = the *comparison* collation would
  ADMIT the range seek for that column (NOCASE is order-preserving), when the bytes are
  BINARY.

So both gates take the **key** collation (from `resolveIndexKeyCollations`, the same
resolver the encoder uses) on one side and the **comparison** collation on the other. For a
plain `text` column the two are identical and it reduces to what the ticket intended —
which is why the headline restoration still happens. The ticket's own edge-case
expectation ("`any` / `json` / temporal … still no range seek") is only satisfied by this
version; its stated reason for that ("`keyOrderMatchesCollation` declines any
semantic-ordering type outright") is true for `json`/temporal but **not** for `any`, which
carries no semantic-ordering marker.

## Behavior changes to verify

| shape | before | after |
|---|---|---|
| `where name > 'm'`, `name text`, index, K = NOCASE | full scan | index range seek, filter handled |
| `where v = 'x'`, `v text collate nocase`, K = BINARY | full scan | index seek |
| `where v > 'z'`, `v text`, K = NOCASE | full scan | index range seek |
| same under a non-order-preserving custom collation | full scan | full scan (unchanged) |
| same under `{ orderPreserving: true }` | full scan | index range seek |
| `v any collate nocase`, EQ or range | full scan | full scan (unchanged) |
| TIMESPAN / JSON index column, range | full scan | full scan (unchanged) |
| isolation Phase-2 UNIQUE check over a `collate nocase` index | full underlying scan | index seek |
| isolation Phase-2 over `any collate nocase` or table-level `unique(...)` | full scan | full scan (unchanged) |

## Test coverage added, and how it was verified

New/re-derived tests, all with a memory-table oracle where one exists:

- `collation-order-preserving.spec.ts` — new `after the guard collapse` block: restored
  range seek on a plain text column; range declined but EQ kept under a
  non-order-preserving collation; range restored under `{ orderPreserving: true }`; BOTH
  arms declined on `any collate nocase`; TIMESPAN unchanged; DESC and partial-index smoke.
  Two existing `shapes the gate must leave alone` tests re-derived (their old rationale —
  "K is coarser, so its window is a superset" — is retired; one flipped from decline to
  seek).
- `pushdown.spec.ts` — the K=BINARY-over-NOCASE test flipped to assert the seek fires and
  the answer is still NOCASE-correct; the ANY test gained a plan-shape assertion.
- `key-set-seek-store.spec.ts` / `runtime-key-set-plan.spec.ts` — the "K finer than the
  column declines" negative controls were the retired rule; each replaced with an `any
  collate nocase` decline plus a positive test that the old shape now seeks.
- `isolated-store.spec.ts` — 2 new: a `collate nocase` index-derived UNIQUE catches a
  case-only committed collision *through the seek*; an `any collate nocase` one declines
  and catches it through the scan.
- `isolation-layer.spec.ts` — the `collate nocase` test re-derived (seeks now, still
  catches); new `any collate nocase` decline test; the row-count proof gained a collated
  seek arm and moved its negative control to a table-level `unique(email)` (which has no
  index in the engine-facing schema, so it genuinely cannot seek).

**Mutation checks run (all four confirmed the gate is live):**

1. `keyOrderMatchesCollation` → `return true` unconditionally: **11 store tests fail.**
2. `indexPrefixSeekIsCollationExact` → `return true`: **4 store tests fail.**
3. `canSeekForConstraint` → seek unconditionally: **1 isolation test fails** (the `any`
   decline; the widened gate loses a UNIQUE violation against the memory backend).
4. Same mutant against the **store** suite: **passes** — see the gap below.

## Known gaps — please probe these

- **`canSeekForConstraint`'s `any` guard is not independently observable on the store.**
  Mutation check 4 above: with the isolation gate forced open, the store still answers
  correctly, because `StoreTableScan.analyzeIndexAccess`'s own EQ gate declines the window
  and full-scans. That is defense in depth working, but it means the store-backed
  `isolated-store.spec.ts` ANY test would not catch a regression in the isolation gate
  alone. The memory-backed isolation test does. I did not try to build a store-side seam
  that would.
- **No store-mode row-count proof that the widened UNIQUE seek actually seeks.** The
  store yields rows through KVStore iteration, not a proxy-able `query()` generator, so
  there is no counting seam. `backlog/debt-iso-store-unique-seek-rowcount` exists for
  exactly this and I updated its negative control (it proposed "a `collate nocase` index
  must full-scan", which this ticket invalidates). The store-side tests here prove
  *correctness* of the seek arm, not that it is the arm taken.
- **Memory's `MemoryIndex` collation resolution was checked only end-to-end.** I confirmed
  empirically that a `text collate nocase` index seek finds a case variant on the memory
  backend (the widened isolation gate's tests pass and its mutant fails), but I did not
  read through `MemoryIndex.createSingleColumnKeyFunctions`' `specCol.collation ?
  resolver(...) : undefined` fallback to establish *why* an index with no explicit
  `COLLATE` over a declared-NOCASE column still keys NOCASE. A reviewer should satisfy
  themselves that is by construction rather than by luck.
- **The `costOnlyFallback` NOTE was KEPT, not retired** (the ticket asked me to say
  which). The arm is still reachable — a range under a collation without the
  `orderPreserving` assertion, an `any` column with a declared COLLATE, a semantic-ordering
  column, the multi-seek declines — so the "picks up a Sort it did not need" concern still
  holds. I corrected the NOTE's claim that the gate makes the arm fire *more* often; it now
  fires less.
- **No measurement.** The magnitude claim is a plan-shape change only (full scan +
  residual → bounded index seek with the filter handled). No timing was taken.
- **`docs/store.md` § Order preservation was rewritten wholesale.** Worth a read for
  accuracy rather than a diff skim.

## Defect found along the way — filed, not fixed

`tickets/fix/any-collate-index-changes-query-answer.md` (repro: verified). On an in-memory
table, `create index` on a column declared `any collate nocase` changes the answer to
`where v = 'BOB'` from `[1]` to `[]`. Root cause named: `ANY_TYPE.compare`
(`packages/quereus/src/types/builtin-types.ts:328`) hard-codes `BINARY_COLLATION` and
discards the collation argument `createTypedComparator` passes it, so `MemoryIndex`'s key
comparator partitions BINARY while the engine's `=` on the column applies the declared
collation. The store and the isolation layer both *decline* the index for this shape (that
is what this ticket's surviving guards do); memory has no equivalent decline. Which of the
two answers is correct is a real decision — the ticket lays out both directions and what
each drags along — so it went to `fix/` rather than being resolved inline. It was
discovered because a memory-oracle assertion I wrote for the `any` case failed; that test
now uses the store's own pre-index answer as the oracle and carries a comment pointing at
the ticket.

## Validation run

- `yarn build` — clean.
- `yarn lint` — clean.
- `yarn typecheck` — clean.
- `yarn test` — all workspaces green, 0 failing (engine 8277, store 1281, isolation 368,
  sync 643, plus the smaller packages).
- `yarn test:store` — 8269 passing, 21 pending, 0 failing (same counts as the prereq
  ticket's baseline).
