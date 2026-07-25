---
description: In-memory tables accept two different spellings of the same duration (like "PT1H" and "PT60M") in a UNIQUE column, even though the engine now defines them as equal values — the duplicate should be rejected.
files:
  - packages/quereus/src/vtab/memory/layer/manager.ts   # plain-UNIQUE enforcement path (checkUniqueConstraints / secondary-unique checks)
  - packages/quereus/src/util/comparison.ts             # hasSemanticOrdering / createTypedComparator / semanticKeyTransform (the tools to use)
  - packages/quereus-store/src/common/store-table.ts    # uniqueColumnComparators — the store-side fix to mirror
  - packages/quereus/test/logic/15.1-semantic-ordering.sqllogic
---

# Memory backend: plain UNIQUE does not collapse equal-elapsed TIMESPAN spellings

## Reproduction

```sql
create table m (id integer primary key, d timespan unique);
insert into m values (1, 'PT1H');
insert into m values (2, 'PT60M');  -- ACCEPTED — should be a UNIQUE violation
```

Both rows land. Under the semantic-ordering ruling (docs/types.md "Semantic ordering",
established by ticket `duration-json-semantic-ordering-engine`), `'PT1H'` and `'PT60M'`
are the SAME value (`TIMESPAN.compare` returns 0; `=`, DISTINCT, GROUP BY, and the
memory table's **primary key** all already collapse them). The plain-UNIQUE
(column/table-level `unique`) enforcement path in the memory backend still compares
under the column's collation instead of the type's `compare`, so the duplicate slips
through.

## Expected

The second insert raises the ordinary UNIQUE violation, and `on conflict ignore /
replace` behave accordingly — exactly what the persistent store now does (ticket
`duration-json-semantic-ordering-store` routed the store's unique-conflict finders
through `createTypedComparator` for semantic-ordering columns; see
`StoreTable.uniqueColumnComparators` for the pattern to mirror).

## Notes

- The memory PRIMARY KEY path is fine (typed BTree). Verify whether `CREATE UNIQUE
  INDEX` enforcement shares the broken path or the typed BTree one.
- Store-side coverage exists in
  `packages/quereus-store/test/timespan-semantic-key-identity.spec.ts` ("secondary
  UNIQUE identity") — it deliberately omits the memory oracle and references this slug;
  once fixed, add the memory table back as the oracle there and/or extend
  `15.1-semantic-ordering.sqllogic` with a UNIQUE-column block.
