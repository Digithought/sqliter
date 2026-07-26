---
description: After an insert or update, features that report or mirror the saved row hand back the text the user typed instead of the value actually stored — so a JSON column reads back as plain text in RETURNING, and a materialized view kept up to date row-by-row ends up disagreeing with the table it summarizes.
files:
  - packages/quereus/src/runtime/emit/dml-executor.ts            # processInsertRow / processUpdateRow — `newRow` and the yielded `flatRow` are raw
  - packages/quereus/src/vtab/memory/layer/manager.ts            # performInsert/performUpdate return the coerced row as `result.row`
  - packages/quereus/src/types/json-type.ts                      # JSON_TYPE.parse — not idempotent for a JSON string scalar
  - packages/quereus/src/types/validation.ts                     # coerceRowToSchema / validateAndParse
  - packages/quereus-isolation/src/isolated-table.ts             # ~line 1120 documents the same double-coercion hazard
  - packages/quereus/src/runtime/emit/constraint-check.ts        # coerceNewSection — the narrow precedent for a coerced view
difficulty: hard
---

# The row that flows out of an INSERT/UPDATE is the raw one, not the stored one

## Plain statement of the problem

When you write a row, the value you typed is not always the value the table
keeps. A column declared `json` given the text `'{"a":2}'` is stored as a real
JSON value; a column declared `integer` given the text `'7'` is stored as the
number 7. That conversion happens down in the storage layer.

Everything the engine reports *about* the write, however, is built from the row
as it was before conversion:

- `insert ... returning j` gives you back the raw text.
- Change tracking, auto-emitted data events, and row-time materialized-view
  maintenance are all fed the raw row.

So the same column has two different observable values depending on which door
you look through.

## Reproductions

Both were confirmed on the current tree (memory backend).

**RETURNING disagrees with a subsequent SELECT:**

```sql
create table r (id integer primary key, j json);
insert into r values (1, '{"a":2}') returning j, typeof(j);
--   j = '{"a":2}' (text),  typeof(j) = 'text'
select j, typeof(j) from r;
--   j = {"a":2}   (json),  typeof(j) = 'json'
update r set j = '{"a":3}' returning j, typeof(j);
--   same disagreement on the UPDATE path
```

**A materialized view maintained row-by-row disagrees with the same view built
from the table.** Two rows whose JSON is identical but whose text differs only in
whitespace:

```sql
create table m (id integer primary key, j json);

-- (A) view created FIRST, then maintained as rows arrive:
create materialized view mv as select j, count(*) as n from m group by j;
insert into m values (1, '{"a":1}'), (2, '{ "a" : 1 }');
select j, n from mv;
--   TWO rows: '{ "a" : 1 }' n=1  and  '{"a":1}' n=1   ← grouped by raw text

-- (B) same data, view created AFTER the inserts (built from stored rows):
select j, n from mv;
--   ONE row: {"a":1} n=2                                ← grouped structurally
```

(A) and (B) describe the same view over the same data and must not differ. Note
that in case (A) a plain `select j, count(*) from m group by j` also returns the
wrong two rows, because the planner answers it from the materialized view.

## Where it comes from

`packages/quereus/src/runtime/emit/dml-executor.ts`, `processInsertRow`:

- `newRow` is extracted from the raw flat row and passed to `vtab.update()`.
- `vtab.update()` returns `result.row` — the **coerced** row the table actually
  stored (`MemoryTableManager.performInsert` builds it via `coerceRowToSchema`).
- The code then ignores `result.row` and uses the raw `newRow` for
  `_recordInsert`, `maintainRowTimeStructures`, and `emitAutoDataEvent`, and
  returns the raw `flatRow`, which is what `RETURNING` projects.

`processUpdateRow` has the same shape.

## The trap that makes this harder than it looks

The tempting fix — coerce the row once, early, and let the coerced row flow
everywhere — does not work as written, because **`JSON_TYPE.parse` is not
idempotent for a JSON string scalar**. A `json` column holding `'"Bob"'` parses
to the bare JS string `Bob`; parsing `Bob` again throws
`Cannot convert 'Bob' to JSON: invalid JSON syntax`. Every storage layer coerces
unconditionally on write (`MemoryTableManager.performInsert`,
`StoreTable.coerceRow`, and the isolation overlay), so any row that is coerced
before it gets there is coerced twice and fails. This was prototyped during
`bug-json-compare-string-ambiguity` and immediately broke
`packages/quereus/test/collation-key-normalizer.spec.ts`. The hazard is already
called out in a comment at `packages/quereus-isolation/src/isolated-table.ts`
(~line 1120), which sidesteps it the same way.

## Two candidate directions

**(1) Use the row the vtab hands back.** `result.row` is already the canonical
stored row. Switch the post-write bookkeeping and the yielded row over to it.
This never coerces anything twice, so the idempotency trap is avoided entirely.
Open questions to settle while working the ticket: is `result.row` populated on
every substrate (memory, store, isolation overlay, lens-routed writes, the
UPSERT-update and REPLACE branches)? What should the yielded row be when the
substrate reports no row (IGNORE)? Does the flat OLD/NEW shape need rebuilding
around it for `RETURNING`, which can reference both `old.` and `new.`?

**(2) Make coercion idempotent and do it once, up front.** This is the deeper
fix and would also let `emit/insert.ts` / `emit/update.ts` coerce, retiring
`constraint-check.ts`'s separate coerced copy. It requires JSON to stop
representing a JSON string scalar as a bare JS string, or `parse` to be able to
recognise an already-parsed value — a type-system change with wide blast radius
(`validate`, the store's key encoding in
`packages/quereus-store/src/common/json-key.ts`, and the NOCASE-over-JSON
behaviour that `collation-key-normalizer.spec.ts` pins).

Direction (1) looks far cheaper and is the recommended starting point; (2) is
worth writing down as the eventual shape even if it is not taken now.

## Expected behavior

- `insert ... returning <col>` and `update ... returning <col>` report the same
  value and the same `typeof` as a subsequent `select` of that column.
- A materialized view maintained incrementally holds the same contents as the
  same view rebuilt from the base table.
- Change-tracking records and auto-emitted data events carry stored values, not
  raw input text.
- No row is coerced twice on the write path.

## Related

`bug-json-compare-string-ambiguity` fixed the sibling symptom for CHECK
constraints by giving constraint evaluation its own coerced copy of the row
while leaving the raw row flowing downstream. That fix is deliberately narrow and
does not address anything on this ticket.
