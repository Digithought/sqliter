---
description: When a query combines a whole-number half and a decimal half with UNION, the whole numbers can be written into a decimal column without being converted first — they get stored in the wrong form, and if that column is the table's key the write fails outright with a JavaScript error.
files:
  - packages/quereus/src/planner/analysis/set-op-type-merge.ts     # rule 3 — numeric promotion, the merge that over-claims
  - packages/quereus/src/planner/nodes/set-operation-node.ts       # alignSetOpOperands / castColumns — where rule 4 does convert its branch
  - packages/quereus/src/types/validation.ts                       # buildRowCoercion — the identity skip rule that trusts the advertised type
  - packages/quereus/src/types/builtin-types.ts                    # INTEGER/REAL/NUMERIC value spaces and compare
  - packages/quereus/test/logic/28.2-set-op-branch-types.sqllogic  # where the regression test belongs
difficulty: medium
---

# Set operations promise REAL but hand back whole-number values unconverted

## What happens

Quereus stores whole numbers and decimals in two different internal forms. A
column declared `real` is supposed to hold the decimal form. When a value flows
into such a column, the engine converts it — *unless* the query it came from
already claims to produce the decimal form, in which case the conversion is
skipped as redundant.

A set operation (`union`, `union all`, `intersect`, `except`, `diff`) that mixes
a whole-number half with a decimal half claims to produce the decimal form for
the combined column. It does not: it passes both halves through untouched. So
the whole-number half reaches a `real` column with the conversion skipped, and is
stored in the wrong internal form.

## Reproduction

```sql
create table t (id integer primary key, v real);

-- Baseline — a direct insert converts correctly.
insert into t values (1, 9007199254740993);
select v from t;                    --> 9007199254740992 (converted, correct)

-- Through a set operation — no conversion happens.
delete from t;
insert into t (id, v) select 1, 9007199254740993 union all select 2, 2.5;
select v from t;                    --> the raw whole-number form, unconverted
```

With the same column declared as the table's key, the mis-stored value reaches
the key comparator and the statement fails outright:

```sql
create table k (v real primary key);
insert into k (v) select 9007199254740993 union all select 2.5;
--> Execution error: Cannot convert a BigInt value to a number
```

Both arm orders fail. Small whole numbers hide the bug (their two internal forms
happen to coincide); values past 2^53, or anything that reaches a `real`-declared
key, expose it.

## Why it is happening

`mergeSetOpColumnType` (rule 3, `planner/analysis/set-op-type-merge.ts`) merges a
whole-number branch and a decimal branch to the decimal type — a claim neither
branch is made to honor. The sibling rule for JSON-vs-text branches (rule 4)
handles the identical shape correctly: it marks the branch that must change and
`alignSetOpOperands` wraps that branch in a converting projection, so by the time
the set operation reports its type, both branches genuinely produce it. Rule 3
skips that step.

Downstream, `buildRowCoercion` (`types/validation.ts`) skips conversion whenever
the source's declared type is identical to the target column's — so the false
claim turns directly into an unconverted write.

Introduced by ticket `union-branch-value-not-converted-on-write`, which made the
merge symmetric; before it, the whole-number-on-the-left order converted
correctly (the decimal-on-the-left order was already broken).

## Expected behavior

A set operation over mixed numeric branches must either produce values that
genuinely inhabit the type it advertises, or advertise a type it genuinely
inhabits — the same standard the JSON/text rule already meets. Whichever route is
taken, after the fix:

- `insert into t(v real) select <big whole number> union all select 2.5` stores
  the same value a direct single-row insert of that number would store, in both
  arm orders.
- The `real primary key` form above completes instead of throwing.
- `select 1 union all select 2.5` still returns two numeric rows and does not
  collapse to text (the behavior `28.2-set-op-branch-types.sqllogic` pins today).

Two candidate routes, both worth weighing before implementing:

- **Convert the differing branch**, exactly as rule 4 does. Straightforward and
  symmetric with the existing machinery, but it changes read-side output: the
  whole-number arm of `select 1 union all select 2.5` would come back as `1.0`
  rather than `1`, diverging from SQLite, which preserves each row's own form.
- **Advertise a type that honestly covers both forms** (`NUMERIC` describes
  "whole number or decimal"). The read side is untouched — each row keeps its own
  form — and the write side converts, because the advertised type no longer
  matches the `real` column exactly. Needs a check that the numeric comparator
  used for dedup and ordering handles a stream containing both forms.

## Scope note

Only the numeric-vs-numeric merge is affected. The JSON/text, NULL, identical,
and no-common-type cases all convert correctly today and have automated coverage.
