description: A materialized view used to police a UNIQUE constraint now recognizes that two different spellings of the same duration (like "PT1H" and "PT60M") are the same value, so the duplicate is rejected instead of slipping through.
files:
  - packages/quereus/src/core/database-materialized-views.ts   # lookupCoveringConflicts comparators (~1116-1126); tryBuildCoveringPrefix gate + NOTE (~1180, ~1214)
  - packages/quereus/src/schema/unique-enforcement.ts          # uniqueEnforcementComparators (docstring widened in review)
  - packages/quereus/test/covering-structure.spec.ts           # 6 implement cases + 3 review cases in `row-time covering enforcement`
  - packages/quereus-store/test/timespan-semantic-key-identity.spec.ts  # 1 case in § secondary UNIQUE identity
  - docs/mv-constraints.md                                     # § Enforcement through a covering MV
  - docs/types.md                                              # § Semantic ordering — caller list
difficulty: medium
----

# Covering-MV conflict candidates honour semantic-ordering identity

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
per-candidate filter compared under the source columns' declared collations only —
storage class + collation, no type involvement — so `'PT1H' ≠ 'PT60M'` and the candidate
was dropped before any re-validator saw it. Net effect: the duplicate was accepted.

```sql
create table t (id integer primary key, d timespan, unique (d));
create materialized view ix as select d, id from t order by d;   -- becomes t's covering structure
insert into t values (1, 'PT1H');
insert into t values (2, 'PT60M');   -- now: UNIQUE constraint failed: t (d)
```

## What shipped

Both per-candidate comparisons in `lookupCoveringConflicts` now go through the shared
`uniqueEnforcementComparators(columns, cols, collations)` helper, resolved once above the
scan loop next to the existing collation resolution. The helper returns the declared
type's `compare` for a semantic-ordering column and the previous
`compareSqlValuesFast(…, collation)` for everything else, so non-semantic columns are
bit-for-bit unchanged. It covers:

- the **UC-column narrowing** — the actual bug;
- the **self-PK exclusion** — the same blind spot per primary-key member, reached with
  the same helper (`pkDef.map(d => d.index)` + the already-resolved `pkCollationFns`).

The declared-vs-enforcement collation choice above the loop is untouched, and its long
comment explaining why is intact; a paragraph now says why the type's `compare` is
orthogonal to that (the two spellings are one value at every site, so the candidate set
stays a superset either way).

`tryBuildCoveringPrefix`'s BINARY collation gate is unchanged. A `NOTE:` explains that a
semantic-ordering column declares no collation and therefore *passes* the gate, and that
this is correct: both backings key such a column through the type (memory
`createTypedComparator` in `resolveScanComparators`, store `storeSemanticKeyTransform` —
TIMESPAN's `groupKey`, JSON's structural byte encoder), so equal-value rows are
physically contiguous and the seek lands on the whole group.

Docs: `docs/mv-constraints.md` § "Enforcement through a covering MV" gained a paragraph
on semantic-ordering identity in candidate generation plus the fast-path clarification;
`docs/types.md` § "Semantic ordering" now lists the covering-MV candidate generator
among the callers of the shared comparator helper.

## Tests

`packages/quereus/test/covering-structure.spec.ts`, in `describe('row-time covering
enforcement')`:

- generator-level: `_lookupCoveringConflicts` on a TIMESPAN-covered constraint returns
  the conflicting source PK for an equal-elapsed probe (and asserts the MV really is the
  covering structure, so the case cannot go vacuous);
- end-to-end (memory): the reproduction raises the UNIQUE violation; identical spelling
  still rejected; a genuinely different elapsed time still admitted;
- `insert or ignore` / `insert or replace` across spellings;
- integer control (the semantic branch does not swallow the ordinary path);
- self-exclusion on the UC column (UPDATE re-spelling the same row) and on a
  semantic-ordering PRIMARY KEY member (asserted at the generator — see below);
- **added in review:** DESC-leading TIMESPAN covering MV, composite UC with a TIMESPAN
  member, and a JSON covering MV.

`packages/quereus-store/test/timespan-semantic-key-identity.spec.ts` § "secondary UNIQUE
identity": one `using store` case with a covering MV, pinning
`StoreTable.findUniqueConflictViaCoveringMv` (ABORT / IGNORE / REPLACE + self-exclusion
on re-spelling).

## Review findings

**Diff read first, from the implement commit `3b27c89b`, before the handoff summary.**
Angles covered: correctness of both changed comparisons, the fast-path seek's physical
contiguity claim on both backings, DRY against the other four callers of the shared
helper, comment/doc accuracy, test non-vacuity and coverage matrix, source hygiene.

### Fixed in this pass (minor)

- **`docs/types.md` § Semantic ordering had a stale caller list.** It enumerated the
  callers of `uniqueEnforcementComparators` as "the memory backend's three
  re-validators, the persistent store's finders, and the isolation overlay's merged-view
  search" — the covering-MV candidate generator this ticket added was missing, which is
  exactly the drift that list exists to prevent. Added, with a pointer to
  `mv-constraints.md`.
- **`uniqueEnforcementComparators`' own docstring had drifted.** It read "for one UNIQUE
  constraint, one entry per `ucColumns` position" and "the four call sites", but the new
  self-PK exclusion passes a PRIMARY KEY column list and there are now more than four
  sites. Widened to "one row-identity check", with an explicit sentence naming the PK use.
- **The BINARY-gate rationale contradicted the NOTE added directly below it.** The
  rationale (both in code and in `mv-constraints.md`) said the prefix seek and
  `planAppliesToKey` "compare with plain `compareSqlValues` (binary)", while the new NOTE
  depends on the seek using the *typed* comparator. Read `plan-filter.ts`:
  `resolveScanComparators` always builds `createTypedComparator(logicalType, collation)`;
  what falls to BINARY is only the *collation* argument, because the backing scan request
  carries no collation names. Both statements are true but the old phrasing reads as a
  contradiction. Reworded to "resolve their comparators at the BINARY floor" and made the
  NOTE say the floor applies to the collation only. No logic changed.
- **Three test gaps closed.** The implement pass covered the single-column ASC TIMESPAN
  shape only. Added: a DESC-leading TIMESPAN covering MV (the direction the existing DESC
  test only covers for integers), a composite `unique (g, d)` where the *second* prefix
  component is the semantic column, and a JSON covering MV. The first two were verified
  non-vacuous by temporarily restoring the old comparison — both fail
  (`UNIQUE constraint failed` not raised) and pass again once restored.

### Verified, no change needed

- **The JSON question the implementer left open.** They flagged JSON as untested and
  warned the contiguity argument might not transfer. It does, and there was never a
  behavioural difference to find: `StorageClass.OBJECT` already compares by
  `objectCanonicalString`, so `compareSqlValuesFast`'s *equality* verdict on two JSON
  values coincides with `JSON.compare`'s — only the ordering of unequal values differs
  (JSON declares no `groupKey` for exactly this reason). The new JSON test correspondingly
  passes with or without the fix; it is a regression pin, not a bug repro, and says so.
  Contiguity: memory keys JSON through the same typed comparator, the store through
  `jsonStructuralKey` whose memcmp order reproduces the structural compare. Comments and
  docs now name JSON alongside TIMESPAN so the next reader does not re-derive this.
- **The self-PK-exclusion half belongs in this ticket.** It has no end-to-end symptom
  (both re-validators re-check self with a semantic-aware PK equality of their own), but
  it was the last copy of the comparison that ignored the declared type, and the
  generator-level test does fail without it. Keeping a knowingly-divergent comparison in
  the one shared generator would be the drift the helper exists to prevent.
- **No isolation-layer gap.** Confirmed independently: `IsolatedTable`'s
  `findMergedUniqueConflict` builds its own comparators from the same shared helper and
  never calls `_lookupCoveringConflicts`, so the covering-MV route is genuinely not
  reachable there.
- **No missed comparison site.** Swept every remaining `compareSqlValuesFast` in
  `database-materialized-views.ts`: the only other one is
  `detectAndReportCoarseningCollisions`, observe-only telemetry about *collation*
  coarsening, where a semantic type does not participate and a false positive would cost
  an extra event, not correctness.
- **Source hygiene.** `lookupCoveringConflicts` is now ~110 lines, but ~45 of those are
  code; the density is the file's established style and the ticket added four statements.
  The two per-call comparator arrays are allocated once per constraint check, outside the
  async scan loop — negligible against the scan itself, so no caching NOTE was added.

### Filed as new tickets

None. Everything found was a comment/doc accuracy issue or a missing test case, all of
which were cheap enough to fix in this pass.

### Tripwires recorded

None. The one candidate considered — `coveringMvHonorsIndexCollation` still gating on
*collation names* for a column whose comparison is now type-driven — needs an explicit
`COLLATE` on a type that documents "Collations: None" to be reachable at all, and its
worst outcome is declining an MV that would have been eligible (a perf loss, never a
wrong answer). Too speculative to be worth a code comment.

## Validation

- `yarn build` — clean.
- `yarn lint` — clean (eslint + the `tsconfig.test.json` type pass over the specs).
- `yarn test` — green across all workspaces, no failures.
- Targeted: `packages/quereus/test/covering-structure.spec.ts` — 101 passing (98 at
  handoff + 3 added here).
- `yarn test:store` not re-run: everything added in this review pass is comments, docs,
  and memory-backend test cases, so the LevelDB re-run is unaffected. It was green at the
  implement commit (`7194 passing, 19 pending`).
- No pre-existing failures encountered.
