---
description: |
  When a transaction is open, the isolation layer checks whether a row already exists by asking the
  underlying table for that one key and believing the first row it gets back. Some tables legitimately
  answer that request with a whole-table scan, so the layer sees an unrelated row and reports a
  duplicate-key error for a key that is not in the table at all.
files:
  - packages/quereus-isolation/src/isolated-table.ts   # getUnderlyingRow (~1577), keysEqual (~1557) — the unused check that fixes it
  - packages/quereus-isolation/src/flush.ts            # rowExistsInUnderlying (~111) — same trust, same fix
  - packages/quereus-isolation/src/filter-info.ts      # makePkPointLookupFilter — the hand-built FilterInfo that asserts omit:true
difficulty: medium
repro: verified
---

# The isolation layer's underlying point lookup believes an unfiltered scan

## What is wrong

`IsolatedTable.getUnderlyingRow(pk)` resolves "does the underlying table already hold this primary
key?" like this:

```ts
for await (const row of this.underlyingTable.query(this.buildPKPointLookupFilter(pk))) {
	return row;
}
return undefined;
```

It returns the **first row the module yields**, without checking that the row's primary key is
actually `pk`. `checkMergedPKConflict` then treats any returned row as a live conflict and raises
`UNIQUE constraint failed: <table> PK.`

The `FilterInfo` that `makePkPointLookupFilter` builds carries `aConstraintUsage: [{ argvIndex, omit:
true }]` — it asserts, on the module's behalf, that the module consumes the equalities. But the
FilterInfo is hand-built; it never went through the module's own `getBestAccessPlan`, so the module
was never given the chance to decline. A module that legitimately cannot seek on that column has no
way to say so, and there is no residual filter above this call to catch the difference.

`flush.ts`'s `rowExistsInUnderlying` is the same code with the same trust, so a commit flush can also
conclude a key exists when it does not.

`keysEqual(a, b)` already sits twenty lines above `getUnderlyingRow` in the same class, and already
compares under each PK column's declared collation *and* through a semantic-ordering type's own
comparator. It is not called here.

## Why a module would answer with a scan

A column whose logical type carries `semanticOrdering: true` — `TIMESPAN`, `JSON` — orders by what the
value *means*, not by the bytes the store keys it under. `'PT120M'` and `'PT2H'` are one value but two
different stored strings; `{"a":2}` and `{"a":10}` order one way as text and the other way as a deep
compare. A store-backed module therefore **must** decline to seek such a column and let the engine
reapply the equality above the scan under the type's comparator — that is the documented, correct
behaviour, and it is what the Lamina module does (`lamina-quereus/src/planner.ts`
`classifyConstraint`: "Refuse to consume such filters here so Quereus reapplies them above the
scan"; `query-dispatch.ts`: "Decline to the caller's full scan, where Quereus's retained residual
re-applies the equalities under the type's comparator").

Down this path there is no engine above the scan to reapply anything. The module full-scans, the
isolation layer takes row #1, and a distinct key reads as a duplicate.

## Reproduction

Verified 2026-08-15 against the lamina repo's checkout of this repo, with `LaminaModule` wrapped in
`IsolationModule` (`packages/lamina-quereus-test/src/json-pk-isolation-overlay-merge.test.ts` in the
lamina repo, whose two blocked arms are skipped pending this ticket).

```sql
create table t (j json primary key, v text not null);
insert into t values ('{"a":2}', 'two');
insert into t values ('{"a":3}', 'three');   -- UNIQUE constraint failed: t PK.
```

- Same failure inside `begin` / `commit` and in autocommit — the overlay exists either way.
- Same failure for `create table t (d timespan primary key, …)` with `'PT2H'` then `'PT3H'`, which is
  what makes this a class rather than a JSON quirk.
- Same failure for an `update` that relocates a JSON primary key to a fresh document.
- An `integer` or `text` primary key is unaffected (the module seeks those), and an **empty**
  underlying table is unaffected (there is no stray row to return).
- The bare module, registered without the `IsolationModule` wrap, handles all of these correctly —
  the engine's residual filter does its job there.

## What "fixed" would mean

An underlying-row lookup reports a conflict only when the row it found really carries the key it asked
for, for every module — whether or not that module honoured the equality constraints in the
hand-built `FilterInfo`. Both call sites (`getUnderlyingRow`, `rowExistsInUnderlying`) resolve at the
same point, and `keysEqual` already spells the comparison this needs, including the semantic-ordering
and collation arms.

Worth settling as part of this: whether `query(filterInfo)` obliges a module to apply unconsumed
equality constraints as a residual filter. If it does, `makePkPointLookupFilter`'s `omit: true` is
sound and the modules are wrong; if it does not, `omit: true` is asserting something the caller cannot
know and the assertion should go too. Either way the verification above is cheap and should stand, so
that a module which scans is slow here rather than wrong.

Filed from the lamina board while reviewing `bug-json-documents-compare-as-object-object`; tracked
there as `bug-json-and-timespan-pk-false-unique-under-isolation-wrap`.
