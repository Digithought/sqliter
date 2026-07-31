---
description: One test file in the transaction-isolation package has grown to nearly 7,000 lines covering many unrelated behaviors, which makes it slow to navigate and easy to bury new tests in; split it into focused files.
files:
  - packages/quereus-isolation/test/isolation-layer.spec.ts   # 6860 lines (measured: wc -l), single top-level describe('IsolationModule')
difficulty: medium
---

# Split `isolation-layer.spec.ts` by concern

## What is wrong

`packages/quereus-isolation/test/isolation-layer.spec.ts` is 6860 lines (`wc -l`, at the time of
filing) — an order of magnitude larger than every sibling in the same folder
(`alter-table-conformance.spec.ts`, `merge-iterator.spec.ts`, `key-set-seek-merge.spec.ts`,
`flush-probe-ordering.spec.ts`, …, all a few hundred lines each). Everything lives under one
`describe('IsolationModule')` with dozens of nested blocks: table creation, reads/writes, savepoints,
commit/rollback, every ALTER arm, cross-connection overlay behavior, poisoning, concurrency modes.

Nothing is broken. The cost is navigational: finding whether a behavior is already covered means
scrolling or grepping a file no one can hold in their head, and each new ticket tends to append yet
another nested block rather than join the right one. Several near-duplicate local test modules
(subclasses of `IsolationModule` / fake `VirtualTableModule`s) already exist in the file because
their authors did not find the earlier one.

## What good looks like

Split into files grouped by the behavior under test, keeping the existing shared helpers in one
importable place rather than copied per file. A plausible cut:

- basic table lifecycle + reads/writes
- transactions, savepoints, commit/rollback
- ALTER TABLE (already the largest cluster; possibly its own two files — column-shape vs primary key)
- cross-connection overlays, migration, poisoning
- concurrency modes / capability reporting

No behavior change, no assertion change — a pure move, verified by the test count staying identical
before and after (367 in this file at the time of filing).

## Why backlog, not now

The split touches no product code and fixes no defect; it is worth doing when someone is already
working in this file with room to do it carefully, not as a drive-by.
