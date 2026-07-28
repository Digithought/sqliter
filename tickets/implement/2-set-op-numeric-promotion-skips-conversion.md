---
description: When a query combines a whole-number half and a decimal half with UNION, the whole numbers can be written into a decimal column without being converted first — they get stored in the wrong form, and if that column is the table's key the write fails outright with a JavaScript error.
prereq: numeric-comparator-rejects-bigint
files:
  - packages/quereus/src/planner/analysis/set-op-type-merge.ts     # rule 3 — the merge to change (plus the KNOWN DEFECT comment to remove)
  - packages/quereus/src/planner/nodes/set-operation-node.ts       # resolveDataColumns / alignSetOpOperands doc comments mentioning "INTEGER ∪ REAL → REAL"
  - packages/quereus/src/types/validation.ts                       # buildRowCoercion — the identity skip rule that trusts the advertised type
  - packages/quereus/src/types/builtin-types.ts                    # NUMERIC / REAL / INTEGER value spaces
  - packages/quereus/test/planner/set-op-type-merge.spec.ts        # lines 41, 65, 115, 116 pin the old REAL answer
  - packages/quereus/test/logic/28.2-set-op-branch-types.sqllogic  # where the SQL-level regression test belongs
  - docs/types.md                                                  # §"set operation is a conversion site", rule 3 (lines ~513-520) carries the defect note
difficulty: medium
---

# Set operations promise REAL but hand back whole-number values unconverted

## What happens

Quereus stores whole numbers and decimals in two different internal forms
(JavaScript `bigint` and `number`). A column declared `real` is supposed to hold
the decimal form. When a value flows into such a column, the engine converts it —
*unless* the query producing it already claims to produce the decimal form, in
which case `buildRowCoercion` (`src/types/validation.ts`) skips the conversion as
redundant.

A set operation (`union`, `union all`, `intersect`, `except`, `diff`) that mixes
a whole-number branch with a decimal branch advertises `REAL` for the combined
column. It does not produce `REAL`: it passes both branches through untouched. So
a `bigint` from the whole-number branch reaches a `real` column with the
conversion skipped, and is stored in the wrong internal form.

## Reproduction (verified on `main`, memory module)

```sql
create table t (id integer primary key, v real);

-- Baseline: a direct insert converts correctly.
insert into t values (1, 9007199254740993);
select cast(v as text) from t;      --> '9007199254740992'   (converted to a number)

-- Through a set operation: no conversion happens.
delete from t;
insert into t (id, v) select 1, 9007199254740993 union all select 2, 2.5;
select cast(v as text) from t;      --> '9007199254740993'   (raw bigint, unconverted)
```

With the same column as the table's key, the mis-stored value reaches the key
comparator and the statement fails outright:

```sql
create table k (v real primary key);
insert into k (v) select 9007199254740993 union all select 2.5;
--> Execution error: Cannot convert a BigInt value to a number
```

Both arm orders fail. Small whole numbers hide the bug (their two internal forms
coincide); values past 2^53 — and anything reaching a `real`-declared key —
expose it.

Confirmed throw site: `REAL_TYPE.compare` does `isNaN(a as number)`, and `isNaN`
on a `bigint` throws. Stack: `isNaN` → `builtin-types.ts:102` →
`comparison.ts:746` (`createTypedComparator`) → `primary-key.ts:78` →
`MemoryTableManager.performInsert`.

## Root cause

`mergeSetOpColumnType` rule 3 (`planner/analysis/set-op-type-merge.ts`) merges an
`INTEGER` branch and a `REAL` branch to `REAL` — a claim neither branch is made to
honor. The sibling rule 4 (JSON vs TEXT) handles the identical shape correctly: it
returns a `convert` marker, and `alignSetOpOperands` wraps that branch in a
converting projection, so by the time the node reports its type both branches
genuinely produce it. Rule 3 sets no marker and converts nothing.

Downstream, `buildRowCoercion` compares the producing expression's logical type
to the target column's **by object identity** and skips conversion on a match — so
the false `REAL` claim turns directly into an unconverted write.

Introduced by ticket `union-branch-value-not-converted-on-write`, which made the
merge symmetric; before it, the whole-number-on-the-left order converted correctly
(the decimal-on-the-left order was already broken).

## Chosen fix: advertise `NUMERIC`, not `REAL`

Rule 3 should return `NUMERIC_TYPE` for **every** builtin numeric pair, dropping
the `INTEGER ∪ REAL → REAL` special case. `NUMERIC`'s `validate` accepts both
`number` and `bigint`, so it is a type the unconverted mixed stream genuinely
inhabits — no branch conversion is needed, and the claim stops being a lie.

The one-line prototype (`return { logicalType: NUMERIC_TYPE }` in place of the
`NUMERIC`/`REAL` split) was built and exercised against the full suite. Verified
outcomes:

| case | before | after |
| --- | --- | --- |
| `insert into t(v real) select <2^53+1> union all select 2.5` | stored as `bigint` | stored as `number` `9007199254740992` — identical to a direct insert |
| same, arms swapped | stored as `bigint` | same, converted |
| `insert into k(v real primary key) select <2^53+1> union all select 2.5` | throws `Cannot convert a BigInt value to a number` | succeeds |
| `select 1 union all select 2.5` | two numeric rows | unchanged — two numeric rows |
| `select <2^53+1> union all select 2.5` | `bigint`, `2.5` | unchanged — each row keeps its own form (matches SQLite) |
| dedup (`union`) and `order by` over a mixed stream | fine | unchanged |
| target column declared `integer` | converts | converts (`NUMERIC ≠ INTEGER`) |
| target column declared `numeric` | skips conversion | skips conversion — legitimate, `NUMERIC` honestly holds both forms |

`yarn test` on the prototype: **5408 passing, 1 failing** — and the single failure
is the unit assertion that pins the old answer
(`test/planner/set-op-type-merge.spec.ts:41`, `INTEGER ∪ REAL` expected `REAL`).
No behavioral regression anywhere else in the suite.

### Why not the other route

Converting the `INTEGER` branch with a `CAST` (mirroring rule 4) was the
alternative. It fixes the write but damages the read: `REAL_TYPE.parse` on a
`bigint` is `Number(v)`, so `select 9007199254740993 union all select 2.5` would
start returning `9007199254740992` — silent precision loss on a plain SELECT, and
a divergence from SQLite, which preserves each row's own storage class through a
compound select. Advertising `NUMERIC` leaves the read side completely untouched.

### Read-side dedup and ordering are unaffected

The set-op dedup comparator and an enclosing `ORDER BY` both route through
`hasSemanticOrdering` (`src/util/comparison.ts`), which is `false` for `INTEGER`,
`REAL` and `NUMERIC` alike — none of them sets `semanticOrdering`. So those sites
use the generic storage-class comparator (`compareSqlValuesFast`) both before and
after this change; `NUMERIC_TYPE.compare` is not reached from them. Verified in
the prototype run.

`NUMERIC_TYPE.compare` **is** reached when a `numeric`-declared **key column** is
fed from such a set operation, and it throws on `bigint` today — that is the
prereq ticket `numeric-comparator-rejects-bigint`, an independent pre-existing
defect (reproducible with no set operation at all). Assume it has landed; the
regression test below covers the combined path.

### Note on the doc comment

Rule 3's comment currently justifies itself by pointing at
`BinaryOpNode.generateType` and `findCommonType`, which promote `INTEGER + REAL`
to `REAL`. After this change the set-op rule deliberately diverges from those,
and the comment must say why: arithmetic yields **one** value in **one** form, so
`REAL` describes it exactly; a set operation yields a **stream mixing both**
forms, which only `NUMERIC` describes. Do not "restore consistency" by changing
the arithmetic rules — they are correct as they stand.

## Testing notes for the implementer

The logic-test harness normalizes BigInt results to Number before comparing
(`normalizeBigInts` in `test/logic.spec.ts`), so a bare `→ [{"v":9007199254740993}]`
row assertion **cannot** tell the broken value from the fixed one — both compare
equal. Two discriminators that do work, both verified:

- `select cast(v as text) from t` → `'9007199254740993'` (broken) vs
  `'9007199254740992'` (fixed). This is the assertion to use for the stored-value
  cases.
- the `real primary key` insert, which throws before the fix and succeeds after.

`typeof(v)` does **not** discriminate: `getSqlDataTypeName` reports `'integer'`
for both a `bigint` and an integral `number`.

## TODO

- In `src/planner/analysis/set-op-type-merge.ts`, make rule 3 return
  `NUMERIC_TYPE` for every builtin-numeric pair (drop the `INTEGER ∪ REAL → REAL`
  branch). Remove the now-stale `KNOWN DEFECT` block and rewrite the rule-3
  comment per "Note on the doc comment" above. `REAL_TYPE` may become an unused
  import — check.
- Update `test/planner/set-op-type-merge.spec.ts`: line 41
  (`expectMerge(INTEGER_TYPE, REAL_TYPE, …)`), line 65
  (`mergeSetOpAdvertisedType(INTEGER_TYPE, REAL_TYPE)`), and lines 115–116
  (`outputType` both arm orders) now expect `NUMERIC_TYPE`.
- Refresh the "INTEGER ∪ REAL → REAL" wording in
  `src/planner/nodes/set-operation-node.ts` (`resolveDataColumns` doc comment,
  ~line 116) and in the class-level comment if it repeats the claim.
- Add SQL-level regression coverage to
  `test/logic/28.2-set-op-branch-types.sqllogic`, using the discriminators above:
  - `real` column fed by a mixed set operation, **both arm orders**, asserted via
    `cast(v as text)` against the direct-insert baseline;
  - `real primary key` fed by a mixed set operation — completes, rows readable;
  - `numeric primary key` fed by the same (covers the prereq's path too);
  - keep/extend the existing `select 1 union all select 2.5` assertion so the pair
    still comes back as two numeric rows and does not collapse to text;
  - a read-side assertion that a large whole number survives a `union all` with a
    decimal *unconverted* on the read path (`cast(v as text)` →
    `'9007199254740993'`) — pinning that this fix does **not** start rounding
    SELECT output.
- Update `docs/types.md` § "A set operation is a conversion site", rule 3
  (~lines 513–520): state the `NUMERIC` outcome, delete the "Known defect"
  paragraph, and record why the set-op rule differs from arithmetic promotion.
- Run `yarn test` and `yarn lint` from the repo root.
