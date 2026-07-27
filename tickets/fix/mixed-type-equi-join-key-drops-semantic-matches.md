---
description: Joining a duration column to a plain text column silently returns no rows, even though the exact same comparison written as a WHERE clause matches — because the join algorithms match on raw text while the comparison operator matches on meaning.
files:
  - packages/quereus/src/planner/rules/join/equi-pair-extractor.ts   # admits the pair; gates on collation only
  - packages/quereus/src/runtime/emit/bloom-join.ts                  # hash build/probe key canonicalization
  - packages/quereus/src/runtime/emit/merge-join.ts                  # merge key comparators
  - packages/quereus/src/runtime/emit/asof-scan.ts                   # same shape, already carries a NOTE
  - packages/quereus/src/runtime/emit/join.ts                        # USING equality, same shape, already carries a NOTE
  - packages/quereus/src/runtime/emit/binary.ts                      # the `=` behavior the join must agree with
  - packages/quereus/src/util/comparison.ts                          # hasSemanticOrdering / semanticKeyTransform
  - packages/quereus/test/logic/15.1-semantic-ordering.sqllogic      # where the coverage belongs
difficulty: medium
---

# A join key that pairs a duration column with a text column drops matching rows

## Background

Some column types define their own notion of "same value" that is not byte-equality of
the stored text — `docs/types.md` § "Semantic ordering" is the reference. `TIMESPAN` is
the motivating case: `'PT1H'` and `'PT60M'` are two spellings of one hour, and the
engine's `=` operator treats them as equal. JSON is the other such type.

## What happens

The same predicate gives two different answers depending on whether it is written as a
join condition or as a filter:

```sql
create table a (id integer primary key, d timespan);
create table b (id integer primary key, s text);
insert into a values (1, 'PT1H');
insert into b values (1, 'PT60M');

select a.id from a cross join b where a.d = b.s;   -- 1 row  (correct)
select a.id from a join b on a.d = b.s;            -- 0 rows (wrong)
```

Verified at HEAD (2026-07-27). The plan for the second query is a `HashJoin`
(`algorithm: bloom`). The same 0-row answer comes back from the shapes that get
rewritten into a join — `where exists (select 1 from b where b.s = a.d)` and
`left join b on a.d = b.s where b.id is not null`.

When BOTH sides declare the same semantic-ordering type the join is correct today:
`a.d = c.d` with two `timespan` columns returns the row. The defect is specific to a
**mixed** pair — one side declares the semantic-ordering type and the other does not.

## Why

Three pieces disagree about what "equal" means for a mixed pair:

- The `=` **operator** (`emitComparisonOp`, generic path) runs a runtime duration check
  for any pair where either side is temporal, so it compares elapsed times.
- `extractEquiPairs` admits the pair. Its only soundness gate is that both columns
  resolve the same **collation** — it does not ask whether the two declared types order
  values the same way.
- The join **algorithms** then compare with no type context: `emitBloomJoin` serializes
  raw values into the hash key (canonicalizing only when both sides declare the *same*
  semantic-ordering type), and `emitMergeJoin` falls back to the storage-class +
  collation comparator.

Merge join is additionally unsound for such a pair on its own terms, independent of the
dropped-rows symptom: its inputs are sorted by whatever each side's `Sort`/index order
is — and `Sort` on a `timespan` key now ranks by elapsed time — while the merge advance
step compares by text. A merge over inputs that are not sorted in the comparator's order
can stop early and drop matches that a rescan would find.

## Expected behavior

`a.d = b.s` must return the same rows regardless of which physical join algorithm the
optimizer picks, and regardless of whether the predicate sits in `on` or in `where`.
Either the join algorithms learn the mixed-pair comparison the operator already
performs, or `extractEquiPairs` declines a pair whose two sides do not order values
identically (`comparisonSemanticsDiffer` in `util/comparison.ts` already answers that
question) so the pair falls to the nested-loop residual, which evaluates the operator.
Declining costs the hash/merge algorithm on a rare shape; the current behavior costs
rows.

Note that `IN` already solved the analogous problem in `emitIn`: when *either* side
declares a semantic-ordering type it normalizes both the probe and every candidate
through `semanticKeyTransform` before comparing — `a.d in (select s from b)` correctly
returns the row today. A hash join could canonicalize the same way. `TIMESPAN` supplies
the needed `groupKey`; JSON deliberately does not (its canonical text is already
identity-faithful), so a JSON/text mixed pair needs the plan-time `cast(… as json)` that
`insertCrossTypeCoercion` already applies elsewhere, or the decline path.

Two neighbours have the identical shape and already carry `NOTE:` comments explaining
they are not semantic-ordering-aware — `evaluateUsingCondition` in
`runtime/emit/join.ts` (a `USING` column) and `runtime/emit/asof-scan.ts` (the AS OF
match/partition columns). Whatever rule this ticket settles on should be applied to
those two at the same time, or their NOTEs updated to point at it.

## Coverage

`test/logic/15.1-semantic-ordering.sqllogic` covers the same-type equi-join across
spellings. Add the mixed-pair cases: `on` vs `where`, `exists`, `left join`, and the
`json`/`text` counterpart.
