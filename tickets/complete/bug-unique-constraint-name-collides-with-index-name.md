---
description: Giving a UNIQUE constraint the same name as an index that already exists on the same table used to be allowed and silently corrupted the table; it is now rejected up front on every path that can declare or rename such a constraint, on both storage backends.
files:
  - packages/quereus/src/schema/catalog.ts                       # the shared guard ~396-470
  - packages/quereus/src/runtime/emit/add-constraint.ts          # ADD CONSTRAINT call site ~152
  - packages/quereus/src/runtime/emit/alter-table.ts             # ADD COLUMN call site ~535, RENAME CONSTRAINT call site ~1140
  - packages/quereus/src/schema/manager.ts                       # importIndex same-table warning ~3376
  - packages/quereus/test/logic/10.5.7-implicit-unique-index-lifecycle.sqllogic   # sections 9 + 10 (dual-backend)
  - packages/quereus/test/alter-drop-rename-constraint.spec.ts   # memory-side array-shape tests
  - packages/quereus/test/index-ddl-roundtrip.spec.ts            # importIndex warn-and-proceed test (review pass)
  - packages/quereus-store/test/index-persistence.spec.ts        # reopen durability test
  - docs/sql-ddl.md                                              # §6.3
  - docs/sql-alter.md                                            # ADD CONSTRAINT / RENAME CONSTRAINT / ADD COLUMN arms (review pass)
---

## What shipped

A plain `UNIQUE` constraint is enforced through an automatically built secondary
index that the user never asked for and never sees, **named after the
constraint** (or `_uc_<columns>` when the constraint is unnamed). So a constraint
named `foo` and a user index named `foo` on the same table want one name.

The engine already refused that collision from the *index* side. There was no
equivalent check from the *constraint* side, so declaring the constraint second
was accepted and silently corrupted the table: the user's index vanished from
every read surface, the in-memory backend maintained two different indexes both
named `foo` (queries on the indexed column returned wrong answers), and the
persistent backend dropped the `CREATE INDEX` line from the saved schema, after
which the constraint's structure adopted the orphaned storage and stopped
catching duplicates.

One guard now covers it — `assertUniqueConstraintIndexNameFree` in
`schema/catalog.ts`, expressed once beside the existing `implicitIndexName`
machinery and called from three sites, all **engine-side and before the storage
module is dispatched**, which is what makes a single arm cover both backends and
keeps a rejected statement from persisting anything:

| site | file |
| --- | --- |
| `ALTER TABLE … ADD CONSTRAINT` (UNIQUE arm) | `runtime/emit/add-constraint.ts` |
| `ALTER TABLE … RENAME CONSTRAINT` | `runtime/emit/alter-table.ts` |
| `ALTER TABLE … ADD COLUMN … unique` | `runtime/emit/alter-table.ts` |

`SchemaManager.importIndex` gained a warn-and-proceed for the same collision
arriving through rehydration (never rejects — that path must not brick an open).

Error text, all three sites:

```
Cannot add constraint 'foo' to table 't': its backing index 'foo' would collide with
existing index 'foo' on the same table. Rename the constraint or the index.
```

### Settled design decisions (re-verified against the code during review, not just read off the handoff)

- **Rejected even when the constraint's columns match the index's** — accepting
  it silently reclassifies the user's declared index as a hidden backing
  structure. Reuse of an existing index to back a constraint matches on
  *columns*, not names, and still works.
- **Only UNIQUE** — CHECK and FOREIGN KEY build no backing index. Confirmed at
  the type gate of both call sites.
- **`create unique index` stays legal** — it synthesizes its constraint by
  design and routes through none of the three guarded sites.
- **No rehydration carve-out** — `importDDL` imports the `CREATE TABLE`
  (constraints included) before any `CREATE INDEX`, so the table carries no
  indexes when its constraints are declared. Verified in the import ordering.

## Review findings

### Fixed in this pass (minor)

- **Dead code at the RENAME CONSTRAINT site.** It resolved the renamed
  constraint's column names to feed the `_uc_<cols>` auto-name, but the rename
  target is always a name, so that branch is unreachable and the columns were
  never read. Replaced the four-line resolution with `[]` and a comment saying
  why. (This is the "worth deciding whether to simplify" item the implement
  handoff flagged.)
- **`findIndexShadowedByUniqueConstraint` was exported with no consumer outside
  its own file.** Made module-private; documented that its `columnNames`
  argument is consulted only for the unnamed auto-name.
- **`docs/sql-alter.md` was stale.** It is the ALTER TABLE reference and
  documents all three arms the guard fires on, and mentioned none of the new
  refusal. Added it to the `ADD CONSTRAINT` bullet, the `RENAME CONSTRAINT`
  bullet ("nor an index on that table"), and the `ADD COLUMN` inline-UNIQUE
  bullet. `docs/sql-ddl.md` §6.3 was already correct; `docs/schema.md`,
  `docs/store.md` and `packages/quereus-store/README.md` describe the
  auto-naming mechanism rather than the collision rule and needed no change.
- **Two untested auto-name shapes, both flagged by the implement handoff, now
  covered dual-backend** in `10.5.7-implicit-unique-index-lifecycle.sqllogic`
  §9b/§9d: a multi-column unnamed constraint (`_uc_a_b`, plus a free
  multi-column auto-name that installs and enforces), and a column declaring
  several inline `unique` constraints. Both pass memory and store.
- **The `importIndex` warning was "verified by reading only".** Closed with a
  measured test in `test/index-ddl-roundtrip.spec.ts`, which found the damage is
  worse than the warning claimed: the table ends up with **two index entries
  under one name**, `index_info()` reports *neither*, `DROP INDEX` answers
  `no such index`, and a predicate over the imported index's column **stops
  filtering entirely** (`where b = 'q'` returns every row). The warning text and
  the code comment both said only "shadows the structure and DROP INDEX will
  refuse"; both corrected.

### Filed as a new ticket (major)

- **`ALTER TABLE … ADD CONSTRAINT` never checks for a duplicate constraint
  name** — `tickets/fix/bug-add-constraint-allows-duplicate-constraint-name.md`,
  `repro: verified`. `RENAME CONSTRAINT` enforces per-table name uniqueness;
  `ADD CONSTRAINT` does not, so the same collision is accepted when it arrives
  by addition. Measured on both backends and for both CHECK and UNIQUE: the
  table ends up with two constraints answering to one name, after which
  `DROP CONSTRAINT` removes one and leaves the other enforcing.

  It surfaced *through* this ticket's guard: on the memory backend, which
  materializes each UNIQUE constraint's hidden structure into the table's index
  list, a duplicate-named UNIQUE add trips the new guard against the *first*
  constraint's own private structure and reports a collision with an "existing
  index" the user never created. On the store backend, which keeps that
  structure internal, the guard sees nothing and the duplicate is accepted. Both
  behaviours resolve at one site (`runAddConstraintViaModule`, missing the
  `namedConstraintExists` check the rename arm already uses), so it is one
  ticket, and it is not an arm of this one.

### Recorded as tripwires (not tickets)

- **`declare schema` does not pre-check a constraint name against an index name
  on the same table.** Such a declaration is accepted at declare time and fails
  only at `apply schema` — from the constraint side if the index already exists,
  from the index side against a fresh schema. It is never appliable either way,
  so nothing slips through; it is only a diagnostics-timing wart. Parked as a
  sub-bullet in `docs/sql-ddl.md` §6.3 beside the rule it belongs to.
- **The `importIndex` legacy-catalog damage measured above.** No write path can
  produce such a catalog any more, so reaching it needs a database written
  before the guards (backwards compatibility is waived project-wide) or a
  hand-built `importCatalog` bundle. Parked as a `NOTE:` at the site in
  `schema/manager.ts`, next to the existing note on what to do instead of
  loosening the write-path guards.

### Checked and clean — with the reason, not "looks good"

- **A fifth authoring path** for the same collision was already found and filed
  by the implementer (`bug-rename-column-shifts-unnamed-unique-index-name`, in
  `tickets/fix/`); re-confirmed still open and still out of this guard's reach.
  Swept the remaining DDL surface for a sixth: `CREATE TABLE` (a fresh table
  carries no indexes), `RENAME TABLE` (indexes move with it, no new name),
  `DROP COLUMN`, `DROP CONSTRAINT`, and `apply schema` (covered — it emits
  `ALTER TABLE … ADD <constraint>` through the guarded arm, asserted in §10).
  None reach it.
- **The auto-name rule is spelled three times** — `schema/catalog.ts`,
  `quereus-store/src/common/implicit-unique-index.ts`, and the memory backend's
  `implicitIndexNameFor`. Read all three; they are behaviourally identical
  (`uc.name ?? '_uc_' + columnNames.join('_')`). Two of the three are in a
  different package, so they cannot share one function; `catalog.ts` already
  carries the comment requiring them to stay equal. Left as is.
- **The store durability test uses the in-memory persistent provider, not real
  LevelDB** (implement gap). Unchanged: every test in that file does the same,
  and the reasoning it pins — that the physical index-store name is a pure
  function of schema + table + index name — is provider-independent.
- **The store backend's pre-fix corruption chain was not re-measured** (implement
  gap). Not needed: the guard makes it unreachable, and the store test asserts
  the post-fix state directly against the persisted catalog bundle, tracing
  *every* write rather than only the final one.
- **Misleading error on an invalid statement:** `add unique (nope)` where `nope`
  is not a column reports the name collision rather than "no such column" — but
  only if an index named `_uc_nope` already exists, and the statement is invalid
  either way. Not worth a guard-ordering change.
- **Performance:** the guard is one linear scan of a table's index list per DDL
  statement, on a path that already dispatches to a storage module. Nothing to
  measure.
- **Source hygiene:** the touched files measure (`wc -l`) 701 / 192 / 2264 /
  3430 lines for `catalog.ts`, `add-constraint.ts`, `alter-table.ts`,
  `manager.ts`. The two large ones are pre-existing and this change added 34 and
  23 lines respectively without restructuring them, so no split is filed here.

## Validation

Run at the end of the review pass, with all of the above applied:

- `yarn build` — clean.
- `yarn lint` — clean.
- `yarn typecheck` — clean.
- `yarn test` — clean; `packages/quereus` 8151 passing, 13 pending, 0 failing.
- `yarn test:store` — 8143 passing, 21 pending, 0 failing.
- `10.5.7-implicit-unique-index-lifecycle` and `index-ddl-roundtrip.spec.ts` also
  run individually on both backends.

No pre-existing failures encountered, so `tickets/.pre-existing-error.md` was not
written.
