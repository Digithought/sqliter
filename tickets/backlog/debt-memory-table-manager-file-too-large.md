---
description: The single file holding the in-memory table engine has grown to roughly 3,600 lines covering a dozen unrelated jobs; split it so each file covers one job and can be read on its own.
prereq:
files:
  - packages/quereus/src/vtab/memory/layer/manager.ts   # 3,589 lines — the file to split
  - packages/quereus/src/vtab/memory/module.ts          # 988 lines — the module that drives it, for reference
difficulty: medium
---

# Split the memory table manager

`MemoryTableManager` is the in-memory storage backend's central class: it owns the table's
committed data, the stack of per-transaction layers written on top of it, every secondary
index, and every `ALTER TABLE` arm that reshapes any of the above.

Measured with `(Get-Content packages/quereus/src/vtab/memory/layer/manager.ts | Measure-Object -Line).Lines`
→ **3,589 lines**, in one class. For scale, the engine's emitter folder got its own splitting
ticket (`debt-emit-source-files-too-large`) at 2,155 and 3,093 lines, and the isolation package
got one (`debt-isolation-module-file-too-large`) at ~1,800.

## Why it is worth doing

The concerns inside are already separable and barely interact:

- transaction/savepoint layer lifecycle (open, collapse, commit, rollback)
- primary and secondary index structures, and re-keying them
- the `ALTER TABLE` arms — add / drop / rename column, alter column, primary key,
  add / drop / rename constraint — each a self-contained schema rewrite plus a row migration
- constraint enforcement over existing rows (UNIQUE / CHECK)
- connection registry bookkeeping

A change to one arm means loading the whole file, and the arms have accumulated near-identical
prologue/epilogue blocks (snapshot the old schema, mutate, adopt the new schema onto open
layers, restore on failure) that are hard to see as duplicates at this size.

## Shape of the outcome

Not prescribed here — but the natural seam is one file per concern above, with the ALTER arms
grouped the way the store module already groups its own (`store-module-alter.ts`,
`store-module-alter-column.ts`, `store-module-rename.ts`), so the two backends read alike.
Behavior must not change: this is a pure move, verified by the existing memory-backed suites
(`yarn test`) plus the store-backed re-run (`yarn test:store`).
