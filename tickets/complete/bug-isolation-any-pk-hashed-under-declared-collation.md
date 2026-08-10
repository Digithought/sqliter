description: When a table's primary key uses the flexible `any` type and is declared case-insensitive, the transaction layer treated two rows that differed only in letter case as the same row, so one could disappear from a query run inside that transaction — now fixed and reviewed.
files:
  - packages/quereus/src/planner/analysis/comparison-collation.ts   # pkKeyCollationName — shared decision
  - packages/quereus/src/index.ts                                   # re-exports pkKeyCollationName
  - packages/quereus-isolation/src/isolated-table.ts                # ~line 468 pkNormalizers
  - packages/quereus-isolation/src/overlay-rows.ts                  # ~line 74 makePkKeySerializer
  - packages/quereus-isolation/test/isolation-layer.spec.ts         # regression test ~line 506
  - packages/quereus-store/src/common/store-table.ts                # resolvePkKeyCollations delegates to helper
---

# Complete — reviewed and verified

Case-insensitive collation on an `any`-typed primary key is inert (`ANY_TYPE.compare`
always compares BINARY), but the isolation layer's PK-equality key normalizers keyed under
that declared collation, so `'A'` and `'a'` bucketed to one PK. Inside a transaction an
update to one of a case-distinct pair could drop the other from a secondary-index-driven
merge. Fix: single engine-level helper `pkKeyCollationName(column)` decides the normalizer
collation for a PK-equality key — `undefined` (never-text) / `'BINARY'` (text-capable but
not `isTextual`: `any`, `json`, temporal) / declared collation (`text`). Both isolation
call sites and `quereus-store`'s `resolvePkKeyCollations` now delegate to it, so the three
sites can't drift.

## Review findings

**Scope reviewed:** implement/fix diff (commit `fbfdfff2`) read fresh before the handoff;
new `pkKeyCollationName` helper + doc-comment; all three delegating call sites; the store's
adjacent `columnCanHoldText` guard sites; the new regression test; full build, lint, and
test runs.

**Correctness — no findings.** The helper centralizes the branch correctly.
`ColumnSchema.collation` is a non-optional `string`, always populated (implicit default
`'BINARY'` via `resolveDefaultCollation`, explicit clauses normalized through
`validateCollationForType`). So the `isTextual` branch never yields `undefined`, and the
store's rewrite (`name === undefined ? undefined : (name || fallback).toUpperCase()`) is
behavior-preserving against the old `(col.collation || fallback).toUpperCase()` — no
regression for a plain `text primary key`. `columnCanHoldText(col)` ≡
`logicalTypeCanHoldText(col?.logicalType)`, matching the helper's null/never-text guard
exactly.

**Handoff's speculative "two other store sites" concern — resolved, no ticket.** The
handoff flagged `validateUniqueOverExistingRows` / `indexDedupeNormalizers` as possibly
carrying a duplicate `canHoldText ? collation : undefined` ternary that might need the same
treatment. Verified by grep: **no such ternary exists** anywhere in `store-table.ts`. The
remaining `columnCanHoldText` uses (lines 195, 431, 2092) are boolean guards returning
`true`/exemption flags, not PK-key-collation derivation — nothing to route through
`pkKeyCollationName`. The UNIQUE-enforcement path derives its key collations through the
separate `resolveUniqueEnforcementCollations` / `uniqueEnforcementCollations`, which is
correct to keep distinct: UNIQUE dedupe honors a declared collation on an `any`/`json`
column at runtime where PK equality does not. Concern is moot; no follow-up work.

**Test coverage — adequate.** Regression test (`isolation-layer.spec.ts:506`) exercises the
exact defect: two committed case-distinct `any` PK rows, secondary index on `v`, in-txn
`UPDATE` of one via the indexed column, both rows asserted independently visible after. The
happy path (case-distinct rows stay distinct) and the specific broken interaction
(secondary-index merge inside a transaction) are both covered. `overlay-rows.ts`'s
`makePkKeySerializer` shares the identical helper call and the same underlying comparator
semantics, so the isolation-layer test transitively guards the fix's logic; no separate
overlay-rows unit test added (it would test the same one-line helper delegation).

**Docs — current.** No prose doc claims the old per-site ternary; `docs/schema.md`
§"Per-column PK key collation" describes the store's key-collation model, which this change
leaves semantically unchanged (still BINARY for non-`isTextual` text-capable PK members).
The helper's own doc-comment cross-references both other call sites and reads consistently
with `comparison-collation.ts`'s existing dense-annotation style. Nothing stale.

**Tripwires — none.** The three-site delegation is now the single source of truth; there is
no conditional-later concern to park.

## Validation performed

- `yarn build` — clean across all library packages + the 3 bundled apps.
- `yarn workspace @quereus/quereus lint` — exit 0 (eslint + test-file typecheck), no output.
- `yarn workspace @quereus/isolation test` — 231 passing (includes the new regression test).
- `yarn workspace @quereus/store test` — 916 passing (log noise is intentional
  negative-path test output, not failures).
- `yarn workspace @quereus/quereus test` — 6918 passing, 13 pending, 0 failing.

All counts match the implement/fix ticket's claimed numbers. No pre-existing failures
surfaced.
