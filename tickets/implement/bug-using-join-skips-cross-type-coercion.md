---
description: Joining two tables with the shorter `using (col)` syntax returns no rows where writing the same join out longhand as `on left.col = right.col` returns the expected rows, whenever the two columns hold different kinds of data. Fix by making the short form build the same comparison the long form builds, instead of comparing the columns through its own separate code.
files:
  - packages/quereus/src/planner/building/select.ts                          # buildJoin — where the desugar goes; validateUsingCollations becomes redundant
  - packages/quereus/src/planner/building/coercion.ts                        # insertCrossTypeCoercion — the step USING never reaches
  - packages/quereus/src/runtime/emit/join.ts                                # usingResolved + evaluateUsingCondition — the parallel comparator, becomes dead
  - packages/quereus/src/planner/rules/join/equi-pair-extractor.ts           # extractEquiPairsFromUsing — the parallel key extractor, becomes dead
  - packages/quereus/src/planner/rules/join/rule-join-physical-selection.ts  # line ~92, the `else if (node.usingColumns)` branch
  - packages/quereus/src/planner/rules/join/rule-monotonic-merge-join.ts     # line ~58, same branch
  - packages/quereus/src/planner/nodes/join-node.ts                          # toString/getLogicalAttributes — keep USING visible in EXPLAIN
  - packages/quereus/test/logic/11.1-join-using.sqllogic                     # existing USING corpus; cross-type cases go here
  - packages/quereus/test/optimizer/parallel-async-gather-zip-by-key.spec.ts # line ~403, the "does NOT fold a USING(k) full join" test — flips to folding
  - packages/quereus/test/planner/equi-pair-semantic-gate.spec.ts            # `extractEquiPairsFromUsing` unit block
  - packages/quereus/test/planner/collation-soundness.spec.ts                # line ~218 comment references extractEquiPairsFromUsing
  - docs/optimizer-joins.md                                                  # lines 76, 86 — "or USING columns", "USING has no residual"
  - docs/optimizer-parallel.md                                               # line 63 — USING full joins declared out of scope
  - docs/optimizer-fd.md                                                     # line 96 — isValueDiscriminatingTypePair "(the USING join extractor)"
  - docs/types.md                                                            # lines ~339, ~936 — USING comparator description
difficulty: medium
repro: verified
---

# `using (c)` builds its own comparison instead of reusing `on l.c = r.c`

## Root cause

`buildJoin` (`planner/building/select.ts`) stores a `using (c)` join's column names on
the `JoinNode` and builds **no** condition expression. Because there is no `=`
expression, none of the machinery that hangs off building one runs — in particular
`insertCrossTypeCoercion`, which is what makes `=` compare a JSON document against a
text document structurally, and an integer against a numeric string numerically.

Three separate consumers then re-implement the comparison from the bare column names:

- `runtime/emit/join.ts` — `usingResolved` / `evaluateUsingCondition` (nested loop)
- `planner/rules/join/equi-pair-extractor.ts` — `extractEquiPairsFromUsing` (hash / merge keys)
- `planner/building/select.ts` — `validateUsingCollations` (collation-conflict check)

Each has been patched independently over time to re-align with `=` (collation lattice,
semantic ordering). Cross-type coercion is the arm that was never mirrored. **One code
site is responsible: the missing desugar in `buildJoin`.** Fixing it retires all three
parallel implementations rather than adding a fourth patch to them.

## Reproduced at HEAD (2026-07-31)

```sql
create table ja (id integer primary key, j json);
create table jb (id integer primary key, s text);
insert into ja values (1, '{"a":1,"b":2}');
insert into jb values (1, '{"b":2,"a":1}');

select ja.id from ja join jb on ja.j = jb.s;                       -- 1 row (correct)
select 1 from (select j as k from ja) x
        join (select s as k from jb) y using (k);                  -- 0 rows (wrong)
```

The numeric ↔ textual arm of the same function is skipped identically:

```sql
create table na (id integer primary key, n integer);
create table nb (id integer primary key, t text);
insert into na values (1, 5);
insert into nb values (1, '5');

select na.id from na join nb on na.n = nb.t;                       -- 1 row (correct)
select 1 from (select n as k from na) x
        join (select t as k from nb) y using (k);                  -- 0 rows (wrong)
```

## The fix: desugar at build time

In `buildJoin`, when `joinClause.columns` is present, synthesize the equivalent `on`
condition and set it as the join's `condition`:

```
for each USING column name c:
    leftAttr  = first left attribute whose name matches c  (case-insensitive)
    rightAttr = first right attribute whose name matches c
    left  = ColumnReferenceNode(scope, {type:'column', name}, leftAttr.type,  leftAttr.id,  leftIndex)
    right = ColumnReferenceNode(scope, {type:'column', name}, rightAttr.type, rightAttr.id, rightIndex)
    [left, right] = insertCrossTypeCoercion(scope, left, right)
    conjunct = BinaryOpNode(scope, {type:'binary', operator:'=', …}, left, right)
    conjunct.getType()      // force the lazily-cached collation-lattice validation
AND-combine the conjuncts
```

Column references must be built **from attributes**, not by synthesizing a qualified
`AST.ColumnExpr` and resolving it through the scope: a USING column can be ambiguous by
name within one side (`a join b using (k) join c using (k)` — the left side of the
second join has two `k` columns). Matching by `findIndex`-first on each side's
attributes is exactly what the current emitter and `extractEquiPairsFromUsing` do, so
this preserves today's pairing.

### The `using`-merges-columns caveat in the source ticket does not apply

The source ticket flagged that a desugar must preserve `using`'s output-column merging.
**Quereus does not implement that merging today** — verified at HEAD and pinned by
`test/logic/11.1-join-using.sqllogic`: `select * from a join b using (k)` emits `k` and
`k:1`, and bare `select k from a join b using (k)` raises `ambiguous column name: k`.
The join's output columns come from `buildJoinAttributes`, which the desugar does not
touch, so there is nothing to preserve. (Implementing merging is separate, unrelated
work — do not take it on here.)

### Spike result

The desugar was prototyped and the full suite run against it: **4263 passing, 1
failing** — `test/optimizer/parallel-async-gather-zip-by-key.spec.ts:403`, "does NOT
fold a USING(k) full join (no synthesized ON condition; out of scope)". That test
asserts the *absence* of a capability that only the missing desugar caused. With the
desugar, a `full outer join … using (k)` now folds into the parallel async-gather
zip-by-key plan and returns the same rows the test already expects. Flip the assertion
and rewrite its comment; this is a capability gain, not a regression.

Also verified in the spike:

- `select * from a join b using (k)` still selects a MERGEJOIN over two indexed
  integer keys — the desugared `ColumnReference = ColumnReference` is recognized by
  `extractEquiPairs` exactly as a spelled-out ON is, so no USING join loses its
  physical-algorithm choice.
- Both cross-type repros above return the correct row.
- Every case in `11.1-join-using.sqllogic` still passes, including the collation-conflict
  cases — `BinaryOpNode.getType()` raises the same `ambiguous collation` error that
  `validateUsingCollations` raises today.
- Deleting the emitter's USING path outright (below) introduced no further failures.

## Retire the parallel implementations

Once the desugar lands, `JoinNode.condition` is always set for a USING join, so every
`usingColumns` fallback is unreachable — both physical-selection rules check
`node.condition` first, and `emitLoopJoin`'s `conditionMet` checks the condition
sub-program first. Delete rather than leave dead:

- `evaluateUsingCondition` and the `usingResolved` block in `runtime/emit/join.ts`.
- `extractEquiPairsFromUsing` in `equi-pair-extractor.ts`, plus its two call sites.
  Its `UsingAttr` type and the `isValueDiscriminatingTypePair` / `normalizeCollationName`
  imports go with it if nothing else uses them. Check whether
  `isValueDiscriminatingTypePair` retains another caller before removing it.
- `validateUsingCollations` in `select.ts` — subsumed by the forced `getType()` on each
  synthesized conjunct. Move its explanatory comment onto the desugar (it documents *why*
  USING must resolve collation through the same lattice, which is still worth stating).

Keep the `usingColumns` field on `JoinNode`: it is part of the `JoinCapable` interface
and is the only record of how the join was written. Make `toString()` prefer the
`USING(...)` spelling over `ON condition` when both are present so EXPLAIN output stays
faithful, and document in the field's comment that **the condition is authoritative and
`usingColumns` is presentational**.

## Second arm: a USING column absent from one side is silently ignored

At HEAD, `select * from ua join ub using (zzz)` returns zero rows and raises nothing —
`evaluateUsingCondition` returns `false` for an unresolved index, and
`validateUsingCollations`'s comment ("a name-resolution error surfaced elsewhere") is
mistaken; nothing surfaces it. Deleting the emitter path forces the decision, so resolve
it here: raise a `QuereusError` from the desugar naming the column. Verified in the
spike that no existing test depends on the silent-empty behavior.

## Known consequence (intended, matches the ON form)

A coerced pair is wrapped in a `CastNode`, and `extractEquiPairs` only recognizes
`ColumnReferenceNode = ColumnReferenceNode`. So a cross-type USING join gets no hash or
merge key and runs as a nested loop — which is precisely what the spelled-out
`on l.c = r.c` already does for the same column pair. Making the two agree is the point
of the ticket; do not add a special case to recover the hash key.

## TODO

Phase 1 — desugar

- Add a `buildUsingCondition` helper to `planner/building/select.ts` following the shape
  above; call it from `buildJoin` and assign the result to `condition`.
- Raise a `QuereusError` naming the column when a USING column is absent from either side.
- Reorder `JoinNode.toString()` so a USING join still prints `USING(...)`; note in the
  `usingColumns` field comment that `condition` is authoritative.

Phase 2 — retire the parallel paths

- Delete `evaluateUsingCondition` / `usingResolved` from `runtime/emit/join.ts`, including
  the `ResolvedUsingColumn` type and any imports left unused (`makeOperandComparator`,
  `effectiveCollationOfTypes`, `BINARY_COLLATION`, `ANY_TYPE` — check each).
- Delete `extractEquiPairsFromUsing` and its `UsingAttr` type; drop the
  `else if (node.usingColumns)` branch in `rule-join-physical-selection.ts` and the
  ternary's USING arm in `rule-monotonic-merge-join.ts`.
- Delete `validateUsingCollations`; relocate its rationale comment onto the desugar.

Phase 3 — tests

- Add cross-type USING cases to `test/logic/11.1-join-using.sqllogic`: a `json` column
  against a `text` column, and an `integer` column against a `text` column, each paired
  with the spelled-out ON form asserting the identical row set. Add the absent-column
  case with its `-- error:` expectation.
- Update `test/optimizer/parallel-async-gather-zip-by-key.spec.ts:403` to assert the
  USING full join now folds; rewrite the test name and comment.
- Rework the `extractEquiPairsFromUsing` describe block in
  `test/planner/equi-pair-semantic-gate.spec.ts`. The behaviors it pins (semantic-ordering
  gate, collation tagging, conflict decline) all survive through `extractEquiPairs` on the
  desugared condition — re-point the coverage there rather than dropping it, and confirm
  the timespan-vs-text USING case in `test/logic/15.1-semantic-ordering.sqllogic` still
  passes.
- Fix the stale comment at `test/planner/collation-soundness.spec.ts:218` and the header
  comment in `11.1-join-using.sqllogic` that says "USING pairs never become BinaryOpNodes".
- Add a three-way `a join b using (k) join c using (k)` case pinning that the
  first-match-per-side pairing is unchanged.

Phase 4 — docs

- `docs/optimizer-joins.md` lines 76 and 86: drop "or USING columns" and the "for USING
  (which has no residual), sinks the whole extraction" clause — USING now has a residual
  like any ON join.
- `docs/optimizer-parallel.md` line 63: USING/NATURAL full joins are no longer out of
  scope for the zip-by-key fold.
- `docs/optimizer-fd.md` line 96: `isValueDiscriminatingTypePair` no longer has a USING
  join extractor as its caller (adjust or remove the parenthetical per what survives).
- `docs/types.md` around lines 339 and 936: USING no longer has its own comparator; it
  builds the same `=` node as the ON form.
- Run `yarn lint` (it type-checks test files too) and `yarn test`.

## Tripwire

The nested-loop USING path previously used a per-column comparator resolved once at emit
time; after the desugar it evaluates a condition sub-program per row pair, like every ON
join. Only USING joins that fall back to nested loop (cross-type pairs, existence-flag
joins) pay this. Not measured — if a USING-heavy workload ever shows up slower in a
profile, the fix belongs in the shared ON-condition evaluation path, not in a restored
USING special case. Record this as a `NOTE:` comment at the desugar site.
