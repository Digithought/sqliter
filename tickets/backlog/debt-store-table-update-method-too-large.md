---
description: One method in the persistent-storage package handles inserts, updates and deletes in a single 300-line block, making every storage write change slow to read and risky to modify.
files:
  - packages/quereus-store/src/common/store-table.ts   # update(), lines ~252-565
difficulty: medium
---

# Decompose `StoreTable.update()`

`update()` is the single entry point the engine calls for every row write against a
store-backed table. It is one `switch (operation)` with three arms written inline:

| arm | approximate size |
|---|---|
| `case 'insert'` | ~125 lines |
| `case 'update'` | ~130 lines |
| `case 'delete'` | ~45 lines |
| **whole method** | **~315 lines** |

That is roughly half of the 645-line file it lives in, and the largest method in the
package. The project's guidance (`AGENTS.md`) asks for small single-purpose methods and
decomposed sub-functions in preference to long blocks separated by comments; this is the
clearest remaining violation in the store table.

## Background

This is pre-existing debt, not something introduced recently. The file it lives in was
recently reduced from ~3,400 lines to 645 by splitting `StoreTable` into a four-file
inheritance chain (`store-table-base.ts` → `store-table-scan.ts` →
`store-table-constraints.ts` → `store-table.ts`). That work was a pure move and
deliberately did not restructure any method body. With the surrounding noise gone,
`update()` is now the dominant blob in what remains.

## What the arms actually do

Each arm interleaves several distinct jobs, which is why they are long:

- coercing the incoming row to the table's schema,
- resolving the effective conflict resolution (statement-level `ON CONFLICT`, else the
  primary key's declared default, else `ABORT`),
- detecting a primary-key conflict and acting on it per that resolution,
- running UNIQUE checks, which may themselves evict a row under `REPLACE`,
- writing the row through the transaction coordinator,
- maintaining secondary indexes,
- tracking statistics and emitting data-change events.

Several of these steps are near-identical between the `insert` and `update` arms — the
conflict-resolution lookup, for instance, appears verbatim in both — so the decomposition
is also a de-duplication opportunity.

## Expectations

- No behavior change. This is a restructure, not a redesign.
- No edits to existing test assertions. `yarn build`, `yarn test`, `yarn test:store`,
  `yarn lint`, `yarn typecheck` all green.
- The public signature of `update()` is unchanged — it is part of the virtual-table
  contract every module implements.
- Extracted helpers stay `private`/`protected` on the class; the state they need
  (encoding options, coordinator, materialized schema) is already instance state, so
  they should not need new parameters threaded through.
- Watch for the shared logic between the `insert` and `update` arms: the goal is fewer
  total lines, not the same lines relocated into three private methods.

## Non-goals

- `applyExternalRowChanges()` (the external/replication write path, same file) is a
  separate method with its own contract — leave it alone.
- The other four files of the chain are already at a reasonable size; this ticket is
  scoped to `update()`.
