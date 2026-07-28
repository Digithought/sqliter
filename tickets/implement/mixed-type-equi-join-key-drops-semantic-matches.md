---
description: Joining a duration column to a plain text column silently returns no rows, even though the exact same comparison written as a WHERE clause matches. Make the join agree with the comparison operator.
files:
  - packages/quereus/src/util/comparison.ts                          # add the admissibility predicate here
  - packages/quereus/src/planner/rules/join/equi-pair-extractor.ts   # apply it to both extractors
  - packages/quereus/src/runtime/emit/join.ts                        # USING comparator (evaluateUsingCondition)
  - packages/quereus/src/runtime/emit/operand-comparator.ts          # makeOperandComparator — the shared routing rule to reuse
  - packages/quereus/src/runtime/emit/bloom-join.ts                  # comment only — record why a mixed pair never arrives
  - packages/quereus/src/runtime/emit/merge-join.ts                  # comment only — same
  - packages/quereus/src/runtime/emit/asof-scan.ts                   # NOTE only — repoint at the new rule
  - packages/quereus/test/logic/15.1-semantic-ordering.sqllogic      # coverage
  - packages/quereus/docs/types.md                                   # § Semantic ordering — document the join-key rule
difficulty: medium
---

# Make equi-join keys agree with `=` on semantic-ordering column types

## What is wrong (reproduced at HEAD, 2026-07-27)

Some column types define "same value" as something other than byte-equality of the
stored text — `docs/types.md` § "Semantic ordering" is the reference. `TIMESPAN` is the
motivating case: `'PT1H'` and `'PT60M'` are two spellings of one hour and `=` treats them
as equal.

```sql
create table a (id integer primary key, d timespan);
create table b (id integer primary key, s text);
insert into a values (1, 'PT1H');
insert into b values (1, 'PT60M');

select a.id from a cross join b where a.d = b.s;   -- 1 row  (correct)
select a.id from a join b on a.d = b.s;            -- 0 rows (wrong)
```

The `on` form plans to a `HashJoin (bloom)`. The same 0-row answer comes back from
`where exists (select 1 from b where b.s = a.d)` and from
`left join b on a.d = b.s where b.id is not null`.

The `USING` spelling of the same join is wrong too:

```sql
create table t  (id integer primary key, d timespan);
create table ut (d text, tag text, primary key (d, tag));
insert into t  values (1, 'PT1H');
insert into ut values ('PT60M', 'y');

select tag from t join ut using (d);               -- 0 rows (wrong)
```

When BOTH sides declare the same semantic-ordering type the joins are already correct —
the defect is specific to a **mixed** pair, one side declaring the type and the other not.

## Why

Three pieces disagree about what "equal" means for a mixed pair:

- The `=` **operator** (`emitComparisonOp`, generic path) runs a runtime duration check
  whenever either side is temporal, so it compares elapsed times.
- `extractEquiPairs` admits the pair — its only soundness gate is that both columns
  resolve the same collation.
- The join **algorithms** then compare with no type context: `emitBloomJoin` serializes
  raw values into the hash key (canonicalizing only when both sides declare the *same*
  semantic-ordering type) and `emitMergeJoin` falls back to storage-class + collation.

Merge join is additionally unsound for a mixed pair on its own terms: it needs both
inputs physically sorted in its comparator's order, but a `timespan` side is sorted by
elapsed time while a `text` side is sorted by text. No single comparator can merge those
two orders, so **canonicalizing the key is not a fix for merge join** — only declining is.

## The rule to land

> A physical equi-join key pair is admissible only when its two sides agree on
> semantic ordering: either neither side declares a semantic-ordering logical type, or
> both declare the **same** one. A pair that fails this demotes to the residual /
> falls to the generic join, where the `=` operator's own semantics apply.

Decline rather than canonicalize, deliberately:

- It is the only option that also fixes merge join's ordering unsoundness.
- Canonicalizing the hash key through `semanticKeyTransform` would only help
  `TIMESPAN` (JSON carries no `groupKey`), and it introduces a **false-positive**
  hazard: `TIMESPAN.groupKey('PT1H')` returns the *number* `3600`, so a
  `timespan`-vs-`integer` pair would hash-match values that `=` reports unequal.
  (`emitIn`'s `inMembershipKey` has that same latent shape — out of scope here, do not
  change it, but do not copy it either.)
- The cost is that a rare shape drops to nested-loop. Losing rows is worse.

## Validated prototype

A prototype of the change below was applied and reverted; it turned every failing query
above green and **all 7434 `yarn test` cases still passed**. Reproduce it as follows.

### Phase 1 — the admissibility predicate

Add to `packages/quereus/src/util/comparison.ts`, next to `comparisonSemanticsDiffer`:

```ts
export function semanticOrderingsAgree(
	a: LogicalType | undefined,
	b: LogicalType | undefined,
): boolean {
	const semA = hasSemanticOrdering(a);
	const semB = hasSemanticOrdering(b);
	if (!semA && !semB) return true;
	return semA && semB && a === b;
}
```

Write a real docstring for it: what it gates (physical equi-join key pairs), why the
"neither, or both-and-identical" shape, and why it is NOT `comparisonSemanticsDiffer`.
That distinction matters and must be recorded — `comparisonSemanticsDiffer` compares
`compare` function identity, and **every** builtin type carries its own `compare`, so
using it here would decline an ordinary `integer` ↔ `real` join key and cost a hash join
for no correctness gain.

Export it from `src/index.ts` alongside `hasSemanticOrdering` / `semanticKeyTransform`
only if a test needs it; otherwise leave it internal.

### Phase 2 — gate both equi-pair extractors

In `planner/rules/join/equi-pair-extractor.ts`:

- `extractEquiPairs` — add the predicate to the existing condition next to the collation
  check, reading `n.left.getType().logicalType` / `n.right.getType().logicalType`.
- `extractEquiPairsFromUsing` — widen the `leftAttrs`/`rightAttrs` parameter shape from
  `type?: { collationName?: string }` to also carry `logicalType?: LogicalType`, and
  decline (return `null`, as the collation mismatch already does) when the predicate
  fails. Both call sites pass real `Attribute`s, so no caller changes are needed.

Extend the extractor's existing "**Collation gate**" docstring into a second
"**Semantic-ordering gate**" paragraph, in the same voice: state the rule, state that
merge join's ordering precondition is the reason declining (not canonicalizing) is the
answer, and point at `docs/types.md`.

### Phase 3 — make USING equality agree with `=`

Gating alone does not fix USING: a declined USING pair falls to the generic nested-loop
join, whose `evaluateUsingCondition` (`runtime/emit/join.ts`) is equally
semantic-ordering-blind — it is the site the existing `NOTE:` there describes.

`runtime/emit/operand-comparator.ts` already holds THE shared routing rule
(`makeOperandComparator`), which selects exactly the path `emitComparisonOp` selects for
the equivalent binary comparison. Use it:

- Replace `ResolvedUsingColumn.collationFunc` with `compare: OperandComparator`, built at
  emit time as
  `makeOperandComparator(leftType?.logicalType ?? ANY_TYPE, rightType?.logicalType ?? ANY_TYPE, collationFunc)`
  where `collationFunc` stays the existing `effectiveCollationOfTypes` resolution.
- Call `compare(...) !== 0` in `evaluateUsingCondition`.
- **Do not** add a NULL short-circuit. `makeOperandComparator` returns 0 for a NULL/NULL
  pair on every branch, exactly as `compareSqlValuesFast` did, so behavior is unchanged.
  (Confirmed separately: `p join q using (k)` over two all-NULL `k` columns returns no
  rows at HEAD, and must keep returning none.)
- Replace the existing `NOTE:` above `evaluateUsingCondition` with a statement of the
  rule now in force.
- `compareSqlValuesFast` may become an unused import in `join.ts` — check.

### Phase 4 — comments on the neighbours

- `runtime/emit/bloom-join.ts` and `runtime/emit/merge-join.ts` both carry a
  `leftLogical === rightLogical` condition guarding their semantic-ordering handling.
  Add one line at each saying a mixed pair can no longer arrive, and naming the gate in
  `equi-pair-extractor.ts` that keeps it out — same style as the existing LOCKSTEP
  collation notes.
- `runtime/emit/asof-scan.ts` — the `NOTE:` above the match-column collation resolution
  describes this same gap for the AS OF match/partition columns. AS OF has no residual to
  demote into, so the gate does not apply there and this ticket does **not** fix it.
  Repoint the NOTE at the rule (and at backlog ticket
  `bug-asof-match-column-ignores-semantic-ordering`) instead of at "resolve typed
  comparators as emitMergeJoin does".

### Phase 5 — coverage in `test/logic/15.1-semantic-ordering.sqllogic`

The file already covers the same-type equi-join across spellings. Add, in the same
comment-first style, a mixed-pair section asserting `on` agrees with `where`:

- `timespan` ↔ `text`: `cross join … where`, `join … on`, `where exists (…)`,
  `left join … where … is not null`, and `join … using (d)`.
- A `timespan` ↔ `timespan` control alongside, so a future change that over-declines is
  caught.
- `json` ↔ `text` counterparts for `on`/`where` — these **already pass** at HEAD, because
  `insertCrossTypeCoercion` wraps the text side in `cast(… as json)`, which makes the
  operand a `CastNode` and so structurally not an equi-pair. Pin that with a comment so a
  later change to the coercion does not silently regress it.
  Do **not** add a `json` ↔ `text` `using` case expecting it to pass: USING skips
  cross-type coercion entirely and still returns 0 rows after this ticket. That is
  tracked separately as `bug-using-join-skips-cross-type-coercion`.

### Phase 6 — docs

`docs/types.md` § "Semantic ordering" lists the sites where a semantic-ordering type's
`compare` governs, join keys among them. Add the mixed-pair rule: a physical equi-join
key requires both sides to agree on semantic ordering, and a mixed pair is evaluated by
the `=` operator via the residual / generic join instead.

## TODO

- [ ] Add `semanticOrderingsAgree` to `util/comparison.ts` with a docstring covering why
      it is not `comparisonSemanticsDiffer`
- [ ] Gate `extractEquiPairs` on it; extend the extractor docstring with the
      semantic-ordering gate paragraph
- [ ] Gate `extractEquiPairsFromUsing` on it; widen its attribute parameter shape to
      carry `logicalType`
- [ ] Switch `evaluateUsingCondition` to `makeOperandComparator`; replace its `NOTE:`
- [ ] Add the "a mixed pair cannot arrive here" notes to `bloom-join.ts` / `merge-join.ts`
- [ ] Repoint the `asof-scan.ts` NOTE at the rule and at
      `bug-asof-match-column-ignores-semantic-ordering`
- [ ] Extend `test/logic/15.1-semantic-ordering.sqllogic` with the mixed-pair section
- [ ] Document the rule in `docs/types.md` § Semantic ordering
- [ ] `yarn workspace @quereus/quereus run test` and `yarn lint` green

## Out of scope — deliberately left alone

- **Fact extraction.** `planner/nodes/join-node.ts`'s `extractEquiPairsFromCondition`
  mints value-level facts (FDs, key coverage, join elimination) and gates only on
  collation, so it admits semantic-ordering pairs on the claim that matched rows are
  *value*-equal — which is false when `'PT1H'` matches `'PT60M'`. Probed for an
  observable over-claim at HEAD (join elimination against a `timespan` primary key,
  constant pinning, GROUP BY, DISTINCT over a UNION ALL): every probe returned the
  correct stored spelling, so there is nothing to fix today. Leave it; if a future change
  makes elimination or constant-pin substitution fire on such a pair, this is where it
  breaks.
- `emitIn`'s `inMembershipKey` — see the false-positive note above.
