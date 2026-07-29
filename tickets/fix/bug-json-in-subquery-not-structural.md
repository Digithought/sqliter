---
description: Checking whether a JSON document is one of the values a subquery returns never finds a match, even when the subquery plainly returns that document as text.
files:
  - packages/quereus/src/planner/building/expression.ts   # 'in' case — the subquery arm builds InNode with no operand reconciliation
  - packages/quereus/src/planner/nodes/scalar.ts          # InNode
  - packages/quereus/src/runtime/emit/in.ts               # how membership is evaluated
  - packages/quereus/test/logic/06.9.2-json-structural-equality.sqllogic  # where coverage belongs
difficulty: medium
---

# `json_col in (select text_col from …)` never matches

## What happens

Comparing a JSON column against SQL text works everywhere else. These all match a row
holding the document `{"a":1}`:

```sql
select 1 where json_col =  '{ "a" : 1 }';                 -- matches
select 1 where json_col in ('{ "a" : 1 }');               -- matches
select 1 where json_col =  (select s from t);             -- matches
select 1 where json_col between '{"a":0}' and '{"a":2}';  -- matches
case json_col when '{ "a" : 1 }' then …                   -- matches
```

This one does not:

```sql
select 1 where json_col in (select s from t);             -- always no rows
```

…even when `t.s` holds the string `{ "a" : 1 }`.

## Why

JSON values live in memory as native JavaScript objects. A text value is a string, and the
engine's comparison never treats an object and a string as equal. Every other site above is
fixed at planning time by converting the text side to JSON once, before the query runs
(`insertCrossTypeCoercion` / `coerceObjectPhysicalSet` in `planner/building/expression.ts`).

The subquery form has no single operand to convert — the values arrive one row at a time
from the subquery, so the conversion has to happen per row, inside membership evaluation,
rather than as a plan-time wrapper. That is why it was left out when the rest of the
contract landed under `bug-json-equality-not-structural`.

## Expected behavior

`json_col in (select …)` should agree with `json_col = <each value>`: whitespace and object
key order irrelevant, array element order significant, a non-JSON string simply not
matching rather than raising an error. The reverse direction (`text_col in (select
json_col …)`) should behave the same way, since the established rule is "if either side is
JSON, the other side is read as JSON".

Symmetry to preserve while fixing: whatever membership set the subquery form builds must
treat two spellings of the same document as one member, exactly as `group by` and a unique
index on a JSON column already do.
