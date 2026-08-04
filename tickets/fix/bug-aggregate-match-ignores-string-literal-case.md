---
description: When a query summarizes data two ways that differ only in the capitalization of a quoted text value, and then filters or sorts by one of them, the engine silently uses the wrong summary and returns wrong rows, with no error.
files:
  - packages/quereus/src/planner/building/function-call.ts       # findMatchingAggregate — the HAVING/ORDER BY/window match
  - packages/quereus/src/planner/building/select-aggregates.ts   # dedupeNewAggregates (~line 818/825) — same convention
  - packages/quereus/src/planner/building/select-projections.ts  # collectInnerAggregates (~line 112) — same convention
  - packages/quereus/src/emit/ast-stringify.ts                   # expressionToString — where the canonical text is produced
  - packages/quereus/test/logic/07.3-group-by-extras.sqllogic    # HAVING/ORDER BY aggregate-matching coverage lives here
difficulty: medium
repro: verified
---

# Aggregate identity is compared as lowercased SQL text, so quoted values lose their case

## What happens

The planner decides "is the aggregate written in HAVING / ORDER BY / a window
specification the same one the SELECT list already computed?" by rendering both
back to SQL text and comparing the two strings **after lowercasing the whole
string**. Lowercasing is meant to make identifiers case-insensitive (`sum(B)`
should match `sum(b)`, which is correct SQL). But it also lowercases the
contents of quoted string values, so two aggregates that differ *only* in the
capitalization of a literal are treated as one — and the clause silently reads
the other one's number.

Verified against the current tree (`db.eval`, scratch mocha spec):

```sql
create table t (id integer primary key, g integer, b text);
insert into t values (1,1,'A'),(2,1,'A'),(3,1,'a');

-- the two aggregates are genuinely different: c = 1, d = 2
select g, count(nullif(b,'A')) as c, count(nullif(b,'a')) as d from t group by g;
-- → [{"g":1,"c":1,"d":2}]

-- HAVING asks for the d one (2 > 1 → true), so the row should come back
select g, count(nullif(b,'A')) as c from t group by g having count(nullif(b,'a')) > 1;
-- actual:   []          ← HAVING read c (1) instead
-- expected: [{"g":1,"c":1}]
```

Same shape reaches ORDER BY and a window specification. Any literal with a
letter in it is exposed — `sum(case when b='X' then 1 else 0 end)`,
`count(nullif(b,'A'))`, `group_concat(b,'X')`.

This is the same class of silent wrong answer that
`bug-aggregate-reuse-matching-ignores-arguments` fixed (it replaced a shallow
argument peek with this text fingerprint); the literal-case residue was not
covered by that ticket and predates it — the old shallow peek got this case
wrong too, for a different reason.

## Root cause — one convention, copied to several sites

`expressionToString` renders identifiers with their authored case and string
literals verbatim. Every caller that wants an *identity* comparison then applies
`.toLowerCase()` to the whole rendered string, which is too blunt: it wants
identifier case-insensitivity, not literal case-insensitivity.

The sites that do this today:

- `findMatchingAggregate` — `function-call.ts` (the one with the visible wrong
  answer above)
- `dedupeNewAggregates` — `select-aggregates.ts`
- `collectInnerAggregates` — `select-projections.ts`

They all answer the same question and each open-codes the same two lines, so a
correct fix is one shared "canonical aggregate identity" helper the three call,
rather than three patched copies. Where that helper lives (a normalizing mode on
`expressionToString`, or a small function beside it) is the design call for this
ticket; note that `expressionToString`'s round-trip faithfulness is a documented
contract with a property test behind it, so the identity form should be a
*separate* rendering, not a change to the default one.

## Expected behavior

- Two aggregate spellings that differ only in identifier case (`sum(B)` /
  `sum(b)`, `SUM(b)` / `sum(b)`) still match.
- Two aggregate spellings that differ in a literal's case (`nullif(b,'A')` /
  `nullif(b,'a')`) do **not** match; each is computed as its own aggregate and
  the clause reads its own.
- The existing 07.3 / 07.5 aggregate-matching assertions keep passing.

## Not in scope

The qualifier narrowing (`sum(w.b)` does not match `sum(b)`) is a separate,
already-documented `NOTE:` at `findMatchingAggregate` — it is a missed match,
not a wrong answer, and lifting it needs attribute-id binding that is not
available at this point in the build.
