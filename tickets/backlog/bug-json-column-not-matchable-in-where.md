---
description: There is no working way to find a row by the value of its JSON column — every obvious spelling of the where clause either returns nothing or fails with an internal error.
files:
  - packages/quereus/src/util/comparison.ts               # compareSqlValues — storage-class ranking used by the generic equality path
  - packages/quereus/src/types/json-type.ts               # JSON_TYPE.compare / parse
  - packages/quereus/src/func/builtins/json.ts            # json() / json_quote()
  - packages/quereus/src/planner/                         # "Unknown literal type object" originates in the cache layer's reference graph
difficulty: medium
---

# A JSON column cannot be addressed from a where clause

## Observed

With rows present in a `json` column, none of the three natural ways to select one
works. Both the in-memory backend and the disk-backed store behave identically, so this
is engine-level, not a storage bug.

```sql
create table t (j json primary key, v int);
insert into t values ('[2]', 1), ('{"a":1}', 2);

select * from t where j = '[2]';              -- 0 rows
select * from t where json_quote(j) = '[2]';  -- 0 rows
select * from t where j = json('[2]');        -- QuereusError: Unknown literal type object
```

## Why it matters

A JSON column — especially a JSON **primary key** — is currently write-only from SQL's
point of view: rows can be inserted and scanned, but not targeted. Tests that need to
address a specific JSON row have to carry a second, non-JSON column to select on, and
`update`/`delete` of a single JSON-keyed row is not expressible.

## What is (probably) going on — two separate faults

1. **`j = '<json text>'` and `json_quote(j) = '<text>'` match nothing.** The comparison
   lands in the generic equality path, which ranks values by storage class first. The
   column's value is a native object/array while the literal is text, so they are never
   equal regardless of content. Whether the fix is a type-directed comparison (parse the
   text side under the column's JSON type) or an explicit conversion requirement is a
   design decision — SQLite's answer is that `j = '[2]'` is genuinely false and users
   must write `j = json('[2]')`, which is fault 2 below.

2. **`json('[2]')` cannot be used as a comparison operand at all.** It raises
   `Unknown literal type object` from the planner's cache/reference-graph layer, which
   does not know how to represent a folded object-valued constant. This one is a plain
   defect regardless of how fault 1 is resolved: if `json(...)` is the sanctioned way to
   compare against a JSON value, it must survive planning.

Fixing fault 2 alone would already give users a working spelling.

## Expected behaviour

At minimum, one documented spelling must select the intended row, and `docs/types.md`'s
JSON section must state which. Decide and document what plain `j = '<text>'` does
(match after parsing, or reliably not match) rather than leaving it silently empty.
