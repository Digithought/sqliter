description: A materialized view used to police a UNIQUE constraint now recognizes that two different spellings of the same duration (like "PT1H" and "PT60M") are the same value, so the duplicate is rejected instead of slipping through.
files:
  - packages/quereus/src/core/database-materialized-views.ts   # lookupCoveringConflicts (~1113 comparators, ~1139/~1150 use sites); tryBuildCoveringPrefix NOTE (~1210)
  - packages/quereus/src/schema/unique-enforcement.ts          # uniqueEnforcementComparators (unchanged — reused)
  - packages/quereus/test/covering-structure.spec.ts           # 6 new cases in `row-time covering enforcement`
  - packages/quereus-store/test/timespan-semantic-key-identity.spec.ts  # 1 new case in § secondary UNIQUE identity
  - docs/mv-constraints.md                                     # § Enforcement through a covering MV
difficulty: medium
----

# Covering-MV conflict candidates now honour semantic-ordering identity

## What was wrong

Some declared column types define their own notion of "same value" that differs from
comparing the stored text byte-for-byte (`docs/types.md` § "Semantic ordering").
`TIMESPAN` is the motivating case: `'PT1H'` and `'PT60M'` are two spellings of one hour
and `TIMESPAN.compare` returns 0 for them.

When a materialized view is linked as a table's *covering structure* for a UNIQUE
constraint, the engine answers the constraint by scanning the MV's backing table for rows
carrying the same constrained values; each hit is a *candidate* the writing backend then
re-validates against the live source row.
`MaterializedViewManager.lookupCoveringConflicts` is that shared candidate generator.

The backing seek already surfaced the equal-elapsed row, but the generator's
per-candidate filter compared under the source columns' **declared collations** only —
storage class + collation, no type involvement — so `'PT1H' ≠ 'PT60M'` and the candidate
was dropped before any re-validator saw it. Net effect: the duplicate was accepted.

## What changed

Three edits, all in `lookupCoveringConflicts` / `tryBuildCoveringPrefix`:

- Both per-candidate comparisons now go through `uniqueEnforcementComparators(columns,
  cols, collations)` (the helper the prerequisite ticket added), resolved once above the
  scan loop next to the existing collation resolution. That helper returns the declared
  type's `compare` for a semantic-ordering column and the previous
  `compareSqlValuesFast(…, collation)` for everything else, so non-semantic columns are
  bit-for-bit unchanged.
  - the **UC-column narrowing** — the actual bug;
  - the **self-PK exclusion** — the same blind spot per PK member. The PK is reached with
    the same helper (`pkDef.map(d => d.index)` + the already-resolved `pkCollationFns`)
    rather than a hand-rolled `hasSemanticOrdering` branch.
- The declared-vs-enforcement collation choice above the loop is **untouched**, and its
  long comment explaining why is intact. Added a paragraph saying why the type's
  `compare` is orthogonal to that (the two spellings are one value at every site, so the
  candidate set stays a superset either way).
- A `NOTE:` at `tryBuildCoveringPrefix`'s BINARY gate: a semantic-ordering column declares
  no collation, so it *passes* the gate, and that is correct — both backings key such a
  column through the type (memory `createTypedComparator` in `resolveScanComparators`,
  store `storeSemanticKeyTransform`'s `groupKey`), so equal-value rows are physically
  contiguous and the seek lands on the whole group. No gate logic changed.

`docs/mv-constraints.md` § "Enforcement through a covering MV" gained a paragraph on
semantic-ordering identity in candidate generation, plus a sentence in the fast-path
paragraph mirroring the code NOTE.

## Reproduction (now fixed)

```sql
create table t (id integer primary key, d timespan, unique (d));
create materialized view ix as select d, id from t order by d;   -- becomes t's covering structure
insert into t values (1, 'PT1H');
insert into t values (2, 'PT60M');   -- now: UNIQUE constraint failed: t (d)
```

## Use cases / what to exercise

`packages/quereus/test/covering-structure.spec.ts`, in `describe('row-time covering
enforcement')` (all new cases sit between the existing NOCASE generator case and the
DESC-leading case):

- **generator level** — `_lookupCoveringConflicts` on a TIMESPAN-covered constraint
  returns the conflicting source PK for an equal-elapsed probe (direct analogue of the
  NOCASE case already there). Also asserts the MV really is the covering structure, so the
  case can't silently go vacuous.
- **end-to-end (memory)** — the reproduction raises the UNIQUE violation; identical
  spelling still rejected; a genuinely different elapsed time still admitted.
- **`insert or ignore` / `insert or replace`** across spellings — IGNORE skips, REPLACE
  recovers + evicts the conflicting source PK and the backing follows.
- **integer control** — an `integer`-covered constraint still rejects its duplicate
  (guards against the semantic branch swallowing the ordinary path).
- **self-exclusion (UC column)** — `update t set d = 'PT60M' where id = 1` succeeds, and
  the surviving row still blocks a third equal-elapsed spelling.
- **self-exclusion (semantic-ordering PK member)** — asserted at the **generator**, see
  the honesty note below.

`packages/quereus-store/test/timespan-semantic-key-identity.spec.ts` §
"secondary UNIQUE identity": one new case, a `using store` table with a covering MV, so
`StoreTable.findUniqueConflictViaCoveringMv` is pinned too (ABORT / IGNORE / REPLACE +
self-exclusion on re-spelling).

## Honest notes / known gaps

- **The self-PK-exclusion half of the fix has no end-to-end symptom.** Both re-validators
  already re-check self with a semantic-aware PK equality of their own (memory's
  `comparePrimaryKeys`, the store's `keysEqual`), so a phantom self-conflict from the
  generator is masked downstream. I first wrote that test end-to-end and it passed
  *without* the fix — it is now a generator-level assertion
  (`_lookupCoveringConflicts(mv, uc, ['PT60M', 1], ['PT60M'])` must return `[]`) which
  does fail without it. So this half is a consistency fix (last copy of the comparison
  that ignored the type), not a reachable bug fix. If you disagree that it belongs in this
  ticket, it is a two-line revert.
- **Both new-behaviour tests were verified non-vacuous** by temporarily reverting each
  comparison and confirming the corresponding case fails (store MV case: "expected null
  not to be null"; generator PK case: "expected [ { pk: [ 'PT1H' ] } ] to deeply equal
  []"). Both were restored.
- **`JSON` is the other semantic-ordering type and is untested here.** `hasSemanticOrdering`
  admits it, so the same routing applies, but every new case uses TIMESPAN. A JSON-covered
  UNIQUE (reorder-equal objects) would be the natural extra case; I did not add one. Note
  the two types differ physically — TIMESPAN has an engine `groupKey`, JSON's store key
  transform is store-local (`jsonStructuralKey`) — so the fast-path NOTE's contiguity
  argument should be re-read against JSON before assuming it transfers.
- **`tryBuildCoveringPrefix`'s prefix values are passed raw** (`newRow[sourceCol]`, e.g.
  `'PT60M'`); each backing applies its own key transform when encoding the seek bounds
  (store: `encodePkPrefixBounds` threads `pkKeyTransforms`; memory: typed scan
  comparators). I read both paths and the store's own `backing-host.spec.ts` NOCASE
  analogue, but there is no test that pins the *fast path specifically* for a
  semantic-ordering column — the memory end-to-end cases do take it (single BINARY-passing
  leading column), so it is exercised, just not isolated from the full-scan fallback.
- **No isolation-layer case.** The isolation-wrapped store enforces UNIQUE via its own
  merged-view detection and does not route through the covering MV
  (`docs/mv-constraints.md` § Store-module parity), so there was nothing to pin there.
  Worth a reviewer's second opinion.

## Validation run

- `yarn build` — clean.
- `yarn lint` — clean (eslint + `tsconfig.test.json` type pass on the specs).
- `yarn test` — green, no failures (`packages/quereus` logic + all workspace suites).
- `yarn test:store` — `7194 passing, 19 pending`.
- Targeted: `packages/quereus/test/covering-structure.spec.ts` 98 passing;
  `packages/quereus-store/test/timespan-semantic-key-identity.spec.ts` 16 passing.

No pre-existing failures encountered.
