---
description: Storing the JSON text value "9" and then updating that row silently turns it into the number 9 — a JSON value that is a piece of text spelled like a number, or like true, or like a list, does not survive a write.
files:
  - packages/quereus/src/types/json-type.ts               # JSON_TYPE.parse — re-parses an already-native string value
  - packages/quereus/src/util/                            # coerceRowToSchema (the per-write coercion that calls parse again)
difficulty: medium
---

# A JSON text value that looks like JSON is re-parsed on every write

## Observed

Both backends (in-memory and disk-backed store) behave the same, so this is engine-level.

```sql
create table m (j json primary key, v int);
insert into m values ('"9"', 1), ('"9.0"', 2);

select json_quote(j), v from m;    -- "9":1 and "9.0":2   -- correct
update m set v = 99 where v = 1;
select json_quote(j), v from m;    -- 9:99   -- the key is now the NUMBER 9
```

The stored value started as the JSON string `"9"` and came back as the JSON number `9`.
The same happens for any JSON string whose text is itself valid JSON — `"true"` becomes
the boolean, `"[1,2]"` becomes an array, `"null"` becomes null.

## Why

`JSON_TYPE.parse` treats **any** JavaScript string handed to it as unparsed JSON text
and runs it through the JSON parser. That is right for the value arriving from SQL (the
literal `'"9"'` must become the string `9`), but wrong for a value that is *already* in
native form — a JSON string leaf. The per-write schema coercion calls `parse` again on
values that have already been parsed, so each write peels off another layer.

The conversion is not idempotent: `parse('"9"')` → the string `9`, and
`parse('9')` → the number `9`.

## Consequences

- A row's primary key changes underneath an `update` that never touched the key column.
- A JSON string scalar and the value it parses to are conflated, so two logically
  distinct rows can collapse.
- Any round trip through the engine (write, re-read, re-write) is lossy for this class
  of value.

## Expected behaviour

A JSON value that is already in native form must pass through unchanged, no matter how
many times it is coerced: storing `'"9"'` and then updating an unrelated column must
leave `json_quote(j)` reading `"9"`. Parsing should apply to text arriving from outside
the type, not to values the type already produced — the type needs a way to tell the
two apart (a distinct entry point for "already native", or a marker on parsed values).
