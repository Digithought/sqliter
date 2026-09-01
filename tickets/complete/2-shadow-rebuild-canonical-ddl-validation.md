description: The engine's fallback rebuild for changing a table's primary key now keeps everything the table declared — checks, unique rules, foreign keys, tags and indexes — and no longer silently drops rows when the new key would collide.
files:
  - packages/quereus/src/runtime/emit/alter-table.ts        # buildShadowTableDdl → generateTableDDL; rebuildUserIndexes; `insert or abort` row copy; drop-guard suppression + NOTE; shadow-cleanup logging
  - packages/quereus/src/schema/manager.ts                  # assertNoReferencingChildrenForDrop early-returns under the suppressed scope (~1469)
  - packages/quereus/src/core/database.ts                   # _setFkRestrictSuppressed jsdoc
  - packages/quereus/test/runtime/shadow-ddl.spec.ts        # unit spec over the canonical shadow DDL (10 cases)
  - packages/quereus/test/alter-table-conformance.spec.ts   # 'shadow rebuild preserves the table definition' — 13 end-to-end arms
  - packages/quereus/test/no-alter-module.ts                # withCreateIndex flag
  - docs/sql-alter.md                                       # ALTER PRIMARY KEY § — preservation guarantee, third precondition, copy-collision semantics
  - docs/module-authoring-schema-changes.md                 # third refusal case for the fallback
  - docs/module-events.md                                   # suppressed-scope statement list

# Complete: ALTER PRIMARY KEY shadow rebuild renders through the canonical DDL writer

## What shipped

When a storage backend cannot change a table's primary key itself, the engine rebuilds the
table the long way: build a hidden copy with the new key, copy the rows, drop the original,
rename the copy over it. That hidden copy used to be described by a small hand-written
`CREATE TABLE` builder that knew only about column names, types, nullability, defaults and
collations — so the rebuilt table came back without its CHECK rules, UNIQUE rules, foreign
keys, generated columns, tags, the key's `ON CONFLICT` action, or its indexes, and stopped
enforcing all of them while reporting success.

The hidden copy is now rendered by the engine's one official table-definition writer
(`generateTableDDL`) over the real table schema with only the name and key substituted, and
the indexes — which are separate statements, not part of a `CREATE TABLE` — are re-created
after the rename. The statement is refused up front when the table has user indexes and the
backend cannot create indexes, because failing after the original is dropped would strand a
half-rebuilt table. The rebuild's internal `DROP TABLE` runs inside a scope that stands the
foreign-key drop guard down, so a self-referencing foreign key (or any other table's foreign
key with rows present) no longer wedges it.

Implementation landed in 7ea936d01; tests and docs in 761547bbd; this review pass fixed one
regression, one silent-catch, and two inaccurate comments (below).

## Review findings

### Checked

Read the implement diffs (7ea936d01, 761547bbd) before the handoff summary; read
`ddl-generator.ts` (what the canonical writer does and does not emit), `catalog.ts` (implicit
covering index naming and exposure), `manager.ts` (drop guard, per-schema index-name
uniqueness, constraint-name scoping), `drop-table.ts` and both drop guards,
`database-external-changes.ts` (the other caller of the suppression flag), and both new
specs. Probed the live engine with a scratch spec against the rebuild-path stub module for
seven behaviors the tests did not cover, then deleted it.

### Fixed in this pass

- **Silent row loss on a colliding re-key (regression from 7ea936d01).** Preserving the key's
  declared `ON CONFLICT` action on the hidden copy also handed that action to the engine's own
  row copy. A table declaring `primary key (a) on conflict replace`, re-keyed onto a
  non-unique column, had its colliding rows REPLACEd away — two rows in, one row out,
  statement reports success. Verified: 2 rows → 1 row, no error; the in-place re-key path
  refuses the same statement with `CONSTRAINT`, and the pre-change rebuild refused it too.
  Fixed by making the copy `insert or abort` (the statement-level clause outranks every
  declared default — `row-constraints.ts`: statement OR clause > per-constraint default >
  ABORT), with the reasoning at the site, a regression arm in the conformance spec, and a
  sentence in `docs/sql-alter.md`.
- **The shadow-cleanup `catch { /* ignore */ }`** in the rebuild's failure path swallowed its
  error entirely; a hidden table the engine could not clean up outlives the statement under a
  machine-generated name. Now logged through `warnLog` (still never masks the original
  failure).
- **Two comments that said something untrue.** The `NOTE:` beside the drop suppression called
  the remaining drop-refusal shape conditional and hypothetical ("nothing in the tree writes
  one"); two shapes are in fact reachable today and now have a ticket (below). And the
  suppression rationale in `assertNoReferencingChildrenForDrop` justified itself partly on the
  external-row apply path, which issues DML only and never reaches `dropTable` — the comment
  now says which caller the arm actually serves and that the other is inert.

### Filed as tickets

- `backlog/bug-rebuild-drop-refused-by-user-facing-guards` — **new.** The rebuild's internal
  `DROP TABLE` is exempted from the foreign-key guard but not from the other two guards on the
  drop path, so an assertion over the table, or another table's CHECK subquery naming it,
  refuses the whole re-key with `cannot drop table '<name>'` — a drop the user never asked
  for. Both verified against the stub backend; the table is left intact, so this costs a
  confusing refusal, not data. Filed at the seam (one scope every drop guard honors) rather
  than as two guard patches, and it carries the "collision error names the hidden table"
  wart, which resolves at the same seam.
- `backlog/debt-alter-pk-guard-blind-to-wrapper-modules` — **arm appended.** The new
  `createIndex` precondition is a second method-presence capability probe with the identical
  wrapper blind spot the ticket already describes, and its failure mode is worse than the
  `renameTable` arm's (the index creation fails *after* the original is dropped).
- `backlog/bug-non-key-column-conflict-action-dropped-from-ddl` — **arm appended.** The
  canonical writer drops a non-key column's own `on conflict` action; the rebuild is now a
  third consumer, so the loss happens in-session on any re-key, not only across a save and
  reload. Same root cause, no new ticket.
- `backlog/debt-oversized-source-files` — measurement refreshed: `alter-table.ts` is 2,733
  lines (`wc -l`, 2026-09-01), up from the 2,650 recorded on 2026-08-23.

### Recorded as tripwires, not tickets

- The corrected `NOTE:` at the internal DROP (`alter-table.ts`) now names both unhandled
  guard shapes and points at the new ticket.
- Pre-existing `NOTE:` in `rebuildUserIndexes` (an exposed implicit index's user tags do not
  survive a rebuild) re-read and left as is — still conditional, nothing exposes such an index.
- Pre-existing `NOTE:` on the event-suppression scope (a module deferring its own events past
  the scope could leak the copy's inserts) re-read and left as is.

### Checked and clean — no finding

- **Naming collisions while both tables exist.** Constraint names are per-table, so the hidden
  copy's `constraint u_email unique (…)` cannot collide with the original's. Index names are
  per-schema, but the user indexes are re-created only *after* the rename, and a UNIQUE
  constraint's implicit backing structure is not routed through the schema-wide check.
- **Whether the drop-guard widening leaks beyond this ticket.** It does not, today: the other
  caller of the flag (the external-row apply batch) issues DML only, and `dropTable` has no
  caller reachable from it — `emitDropTable` and `clearAll` are the only ones. Recorded in the
  comment rather than as a ticket.
- **Whether the drop could cascade-delete referencing rows.** It cannot: the guard is
  refuse-only for every FK action, so suppressing it skips a check and propagates nothing.
- **Maintained tables (materialized views).** Structural ALTERs are refused before this path,
  so the rebuild can never render a maintained table through the plain-table writer and lose
  its derivation.
- **UNIQUE constraints synthesized from a `CREATE UNIQUE INDEX`.** The writer skips them and
  the re-created `CREATE UNIQUE INDEX` re-synthesizes them — no double declaration, and the
  index-survival arm covers it.
- **Views over the rebuilt table.** Verified a view still reads correctly after a rebuild.
- **Generated columns.** Excluded from the copy projection, re-declared on the copy, and the
  subsumer arm confirms they recompute.

## Validation

| Command | Result |
| --- | --- |
| `yarn workspace @quereus/quereus run lint` | clean (eslint + `tsc -p tsconfig.test.json`) |
| `yarn docs:check` | clean (the implement run had not run it) |
| `yarn workspace @quereus/quereus test` | 10278 passing, 25 pending, 0 failing |
| `yarn test` (all workspaces) | all green, 6m33s |
| `yarn test:store` | 10270 passing, 33 pending, 0 failing — the gap the handoff flagged, now closed |

No pre-existing failures surfaced.
