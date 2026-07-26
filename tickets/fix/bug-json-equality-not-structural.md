---
description: In a column holding JSON documents, two documents that differ only in spacing are treated as the same by a uniqueness rule but as different by an equality test — so inserting one is rejected as a duplicate while searching for it finds nothing.
files:
  - packages/quereus/src/types/json-type.ts                  # JSON_TYPE — has compare (structural), no groupKey
  - packages/quereus/src/util/comparison.ts                  # hasSemanticOrdering / semanticKeyTransform (~490) — the gate the query layer uses
  - packages/quereus/src/types/temporal-types.ts             # TIMESPAN (~330) — the type that gets this right, via groupKey
  - packages/quereus-store/src/common/store-table.ts         # ~174 explains why JSON was deliberately given no engine groupKey
  - packages/quereus/test/logic/41.7.4-alter-column-retype-semantic-memory.sqllogic  # section 9b/9c pin the current behavior
difficulty: medium
---

# A JSON column's `=` and its UNIQUE constraint disagree

## Reproduced on `main` (memory module, autocommit)

```sql
create table j (id integer primary key, v json);
create unique index j_v on j (v);
insert into j values (1, '{"a":1}');

insert into j values (2, '{ "a" : 1 }');
-- UNIQUE constraint failed: j (v)          <- the index says this document is already here

select id from j where v = '{ "a" : 1 }';
-- []                                       <- but `=` says it is not
```

The same document is simultaneously a duplicate on `INSERT` and absent on `SELECT`. Nothing
about `ALTER` is involved; a plain `create table … (v json)` is enough.

## Why it happens

An in-memory index builds its comparator from the column's logical type, so it uses JSON's own
`compare`, which ranks by canonical structure — whitespace and key order do not matter.

The query layer's `=` does not take that path. It is gated on a separate signal: a type
participates in semantic equality only if it also supplies a `groupKey`, the canonical
representative used for `GROUP BY`, `IN` and hash joins. `TIMESPAN` supplies one (total elapsed
seconds), which is why `where v = 'PT60M'` finds a row stored as `'PT1H'`. `JSON` deliberately
does not — the comment at `quereus-store/src/common/store-table.ts:174` records the reasoning:
canonical *text* identity was considered already correct for grouping, and a byte-array key
would have been a behavior change for no benefit.

The consequence was not followed through: with no `groupKey`, `=` falls back to comparing the
stored canonical text against the literal on the other side **without canonicalizing that
literal**, so any difference in spacing or key order makes them unequal.

## Expected behavior

A JSON column's `=`, its index, and its UNIQUE constraint must agree on what "the same document"
means. Two shapes of fix, and the choice is a real design decision:

- **Give `JSON` a `groupKey`** (its canonical serialization), so the query layer's existing
  semantic-equality path picks it up and `=`, `GROUP BY`, `IN` and hash joins all become
  structural. This is the small change, but the `store-table.ts` note argues against it —
  whoever picks this up should read that note and say why it no longer applies, or find the
  narrower seam.
- **Canonicalize the comparison operand** against the column's logical type at plan/emit time,
  leaving `groupKey` alone.

Either way the answer must hold for a natively-declared `json` column and for a `text` column
retyped to `json`, and memory and the store must agree.

## Scope note

Worth checking whether any other type carries a `compare` but no `groupKey` and therefore has
the same split. As of writing, `DATE`/`TIME`/`DATETIME` do — but their `compare` is plain
`BINARY` text comparison, so their `=` and their indexes already agree by accident. `JSON` is
the only type where the two genuinely differ today.
