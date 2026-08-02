---
description: The file that compares a declared schema against the live database has grown to roughly 2,700 lines and is getting hard to navigate and change safely; split it into per-object-kind pieces.
files:
  - packages/quereus/src/schema/schema-differ.ts   # 2725 lines (wc -l, 2026-08-02)
  - packages/quereus/test/schema-differ.spec.ts    # 1057 lines — its unit suite, same split applies
difficulty: medium
---

# `schema-differ.ts` is oversized

Measured with `wc -l packages/quereus/src/schema/schema-differ.ts` on 2026-08-02:
**2725 lines** in one module (its unit spec is 1057). For comparison, the repo has
already filed size-debt tickets against smaller offenders
(`debt-store-table-update-method-too-large`, `debt-isolation-module-file-too-large`).

The module holds several genuinely separable responsibilities behind one entry
point (`computeSchemaDiff`) plus the DDL renderer (`generateMigrationDDL`):

- rename resolution (tables, views, indexes, columns, named constraints)
- per-object-kind diffing: tables & columns, named constraints, indexes, views &
  materialized views, assertions
- the logical/lens diff variant
- tag-drift detection
- migration-DDL emission and its statement ordering

Each kind's loop follows the same recognizable shape (name-match → body compare →
drop+recreate on drift), so the split is mechanical rather than a redesign: one
module per object kind exporting its bucket-filling function, a thin
`computeSchemaDiff` that sequences them, and the ordering-sensitive
`generateMigrationDDL` kept whole in its own file (its statement order is the
contract — see `docs/schema.md` § "Migration DDL generation").

No behavior change intended; the existing unit spec plus
`test/logic/50*.sqllogic` are the safety net, and they should split along the same
seams so a future reader can find the tests for one object kind without reading
1000 lines.

Noticed during the review of `bug-assertion-body-drift-invisible-to-diff`, which
added ~15 lines to the assertion loop — the change itself was small, but locating
the right loop and confirming its interaction with the ordering rules meant
reading across most of the file.
