---
description: Asking for a range of JSON documents (less-than, greater-than, BETWEEN) returns a different set of rows depending on whether the column happens to be indexed — one of the two answers is wrong.
files:
  - packages/quereus/src/types/json-type.ts                # deepCompareJson — the ordering `<`/`>` evaluate under
  - packages/quereus/src/util/comparison.ts                # objectCanonicalString / OBJECT storage class — the ordering the index walks (see the NOTE at ~line 231)
  - packages/quereus/src/runtime/emit/binary.ts            # emitComparisonOp ~247 — routes JSON `<`/`>` through deepCompareJson
  - packages/quereus/src/planner/rules/access/rule-select-access-path.ts # where a range constraint becomes an IndexSeek
  - packages/quereus/src/vtab/memory/                      # the module that reproduces the divergence
difficulty: medium
---

# JSON range comparisons disagree with the JSON index's own order

## What happens

A JSON column can be sorted two different ways, and the engine uses both:

- **Comparisons** (`<`, `>`, `<=`, `>=`, `BETWEEN`, `order by`) sort by *what the document
  is*: JSON nulls first, then booleans, then numbers, then strings, then arrays, then
  objects (`deepCompareJson` in `types/json-type.ts`).
- **Indexes** sort by *how the document is spelled* once written out in a canonical form —
  the raw text bytes of `{"a":1}`, `[1]`, `"z"`, `true`, `5`
  (`objectCanonicalString` in `util/comparison.ts`, and the store's `jsonStructuralKey`).

Those two orders are not the same. As long as a query does a full scan and evaluates the
comparison row by row, you get the first order. The moment the planner turns the same
comparison into an index range seek, you get the second — and a different set of rows.

## Reproduction (memory module, `main`)

```sql
create table j (id integer primary key, v json);
create index j_v on j (v);
insert into j values
  (1, '{"a":1}'), (2, '{"a":10}'), (3, '{"a":2}'),
  (4, '[1]'), (5, '"z"'), (6, '5'), (7, 'true');

select id from j where v > json('5') order by id;
```

- Without the index: `[1, 2, 3, 4, 5]` — every document that outranks the number 5.
- With the index: `[1, 2, 3, 5]` — the array `[1]` (id 4) is silently dropped.

Two more from the same table, same shape:

```sql
select id from j where v < json('[1]') order by id;
-- no index: [5, 6, 7]        with index: [4, 5, 6, 7]   <- includes [1] itself
select id from j where v >= json('[1]') and v <= json('{"a":10}') order by id;
-- no index: [1, 2, 3, 4]     with index: [1, 2, 3]
```

The unindexed answers are the correct ones — they match `order by v`.

## Scope

- **Pre-existing and independent of the JSON-equality fix.** Reproduced above with
  `json(...)` operands on both sides, which never touch the plan-time text→JSON coercion
  added by `bug-json-equality-not-structural`. That ticket does, however, make this much
  easier to hit: after it, a plain text literal (`where v > '5'`) reaches the same path,
  where before it was unconditionally false.
- **Equality is NOT affected.** The two orders agree on *equality* — reorder-equal
  documents are equal under both — so `=`, `IN`, `UNIQUE`, `GROUP BY`, `DISTINCT` and
  index point-seeks are all sound. Only range/ordering queries diverge.
- **Memory module only, as observed.** The same probe run against the store module
  (`QUEREUS_TEST_STORE=true`) returns the correct 5 rows, so the store either declines the
  range seek or bounds it differently. Worth confirming why before choosing a fix — if the
  store is correct by accident rather than by design, it can regress.

## Expected behavior

For any JSON column, indexed or not, in any module: `where v <op> <doc>` returns exactly
the rows that `order by v` places on the correct side of `<doc>`. Which of the two orders
becomes *the* order is the decision this ticket needs; both options are viable and they
trade off differently:

- **Make the index order match `deepCompareJson`.** Comparisons and `order by` keep their
  current, type-aware semantics (numbers before strings before containers), and the index
  becomes a usable range structure. Cost: the on-disk/in-memory key encoding for JSON has
  to change to a type-tagged form that sorts correctly as bytes, which is a persisted-format
  change for the store.
- **Make `deepCompareJson` match canonical-text order.** No storage change, and the index
  is immediately correct for ranges. Cost: `order by json_col` and `<`/`>` change meaning —
  documents would sort by their punctuation (`"` < digits < `[` < `t` < `{`), which is hard
  to explain to a user and would reorder existing query results.
- **Refuse range seeks on JSON columns.** Smallest, safest change: the planner keeps the
  index for equality only and falls back to a scan + filter for ranges, so answers are
  always correct. Cost: JSON range queries stay O(n). Reasonable as an immediate
  stop-the-bleeding step even if one of the above lands later.

A regression test belongs alongside `06.9.2-json-structural-equality.sqllogic` and must run
in both memory and store modes (no `using memory`), asserting that the indexed and
unindexed row sets are identical for a table containing documents of several JSON types.
