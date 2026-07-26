---
description: Writing "insert ... on conflict (column) do update" against a duration column fails with a uniqueness error instead of updating the existing row, when the new value spells the same duration a different way.
files:
  - packages/quereus/src/runtime/emit/dml-executor.ts        # conflictTargetValuesMatch + findMatchingUpsertClause
  - packages/quereus/src/planner/building/insert.ts          # resolveConflictTargetEnforcement (resolves collations only)
  - packages/quereus/src/schema/unique-enforcement.ts        # uniqueEnforcementComparators — the rule to reuse
  - packages/quereus/test/logic/15.1-semantic-ordering.sqllogic  # where the coverage belongs
difficulty: medium
---

# UPSERT with an explicit conflict target misses a semantic-ordering conflict

## What happens

Some declared column types define their own notion of "same value" that is not
byte-equality of the stored text — `docs/types.md` § "Semantic ordering" is the
reference. `TIMESPAN` is the motivating case: `'PT1H'` and `'PT60M'` are two spellings
of one hour, and everything else in the engine — `=`, `DISTINCT`, `GROUP BY`, primary
keys, and (as of `memory-unique-semantic-compare`) UNIQUE enforcement on every
backend — treats them as one value.

`insert ... on conflict (<column>) do update` does not. Naming the column in the
conflict target makes the statement fail:

```sql
create table u (id integer primary key, d timespan unique, n integer);
insert into u values (1, 'PT1H', 10);

insert into u values (2, 'PT60M', 20) on conflict (d) do update set n = 99;
-- actual:   UNIQUE constraint failed: u (d)
-- expected: row 1 updated to n = 99

insert into u values (4, 'PT60M', 40) on conflict (d) do nothing;
-- actual:   UNIQUE constraint failed: u (d)
-- expected: statement is a silent no-op
```

Reproduced on **both** backends (memory and `using store`) at commit `28620d00`. The
same statements against a `text unique` column work correctly, as does the untargeted
form `on conflict do update` (which matches any constraint and never compares values).

## Why

The virtual table reports the conflict correctly and hands back the existing row. The
DML executor then has to decide *which* `on conflict` clause the violation belongs to,
by checking whether the proposed row and the existing row agree on the clause's target
columns. That check (`conflictTargetValuesMatch` in `runtime/emit/dml-executor.ts`)
compares with storage class + collation only. Under that comparison `'PT1H'` and
`'PT60M'` differ, no clause matches, and the executor falls through to re-raising the
UNIQUE error.

The collations it uses are pre-resolved at plan time by
`resolveConflictTargetEnforcement` (`planner/building/insert.ts`), which resolves
collations but no per-column comparison rule.

This is the same defect the UNIQUE re-validators had, in a different layer: the engine
now has one shared builder for the correct per-column comparison,
`uniqueEnforcementComparators` (`schema/unique-enforcement.ts`), which returns the
declared type's `compare` for a semantic-ordering column and the collation comparison
otherwise. The conflict-target match should be built the same way rather than growing a
fifth private copy of the rule. Note the shape difference: the existing helper is keyed
on a `UniqueConstraintSchema`'s column list, while the conflict target is a bare list of
column indices, so either the helper or the call site needs a small adaptation.

## Expected behavior

- `on conflict (<col>) do update` / `do nothing` routes to its clause whenever the
  conflict is on those columns *as the constraint enforces them* — i.e. under the same
  identity UNIQUE enforcement uses.
- Semantically-equal-but-differently-spelled values (TIMESPAN spellings; JSON that
  differs only in object key order) count as a match.
- No change for every other column type: collation-equal (NOCASE case-variant, RTRIM
  trailing-space) and affinity-coerced conflicts keep routing exactly as they do today.
- Memory and store agree case-for-case.

## Notes for whoever picks this up

- JSON is unlikely to be visibly affected: JSON values are coerced to native objects
  before they reach the executor, so both sides already arrive canonical. Confirm rather
  than assume.
- The multi-constraint-coincidence corner documented in `findMatchingUpsertClause`'s
  comment is a separate, acknowledged limitation — out of scope here.
- Coverage belongs next to the existing UNIQUE identity block in
  `test/logic/15.1-semantic-ordering.sqllogic`, which already runs under both `yarn test`
  (memory) and `yarn test:store`.
