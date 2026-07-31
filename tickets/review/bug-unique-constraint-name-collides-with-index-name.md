---
description: Giving a UNIQUE constraint the same name as an index that already exists on the same table used to be allowed and silently corrupted the table; it is now rejected up front on every path that can declare or rename such a constraint, on both storage backends.
prereq:
files:
  - packages/quereus/src/schema/catalog.ts                       # new guard: findIndexShadowedByUniqueConstraint / assertUniqueConstraintIndexNameFree ~396-467
  - packages/quereus/src/runtime/emit/add-constraint.ts          # ADD CONSTRAINT call site ~152
  - packages/quereus/src/runtime/emit/alter-table.ts             # ADD COLUMN call site ~535, RENAME CONSTRAINT call site ~1140
  - packages/quereus/src/schema/manager.ts                       # importIndex same-table warning ~3376
  - packages/quereus/test/logic/10.5.7-implicit-unique-index-lifecycle.sqllogic   # new sections 9 + 10 (dual-backend)
  - packages/quereus/test/alter-drop-rename-constraint.spec.ts   # two new memory-side tests
  - packages/quereus-store/test/index-persistence.spec.ts        # new reopen durability test (last test in file)
  - docs/sql-ddl.md                                              # §6.3 bullets
difficulty: medium
---

## What the bug was

A plain `UNIQUE` constraint is enforced through an automatically built secondary
index that the user never asked for and never sees. That hidden index is **named
after the constraint** — `foo`, or `_uc_<columns>` when the constraint is unnamed.
So a constraint named `foo` and a user index named `foo` on the same table want
one name.

The engine already refused that collision **from the index side**
(`SchemaManager.createIndex` rejects `create index foo on t (…)` when `t` carries
a `foo` UNIQUE constraint). There was no equivalent check **from the constraint
side**, so declaring the constraint second was accepted — and silently corrupted
the table: the user's index vanished from every read surface, the in-memory
backend ended up maintaining two different indexes both named `foo` (queries on
the indexed column returned wrong answers), and the persistent backend dropped the
`CREATE INDEX` line from the saved schema, after which the constraint's structure
adopted the orphaned storage and stopped catching duplicates. Full detail of the
measured damage is in the source ticket's git history (commit `f6b98892`).

## What changed

One guard, expressed once and called from three places, all **engine-side and
before the storage module is dispatched** — which is what makes a single arm cover
both backends and keeps a rejected statement from persisting anything.

`packages/quereus/src/schema/catalog.ts` gained, next to the existing
`implicitIndexName` / `isImplicitCoveringIndex` machinery:

- `implicitIndexNameForColumns(constraintName, columnNames)` — module-private. The
  `constraintName ?? '_uc_<cols>'` rule, now expressed over column *names* so
  declaration-time callers (whose column may not exist on the table yet) can use
  it. `implicitIndexName` delegates to it, so the package still has exactly one
  spelling of the rule.
- `findIndexShadowedByUniqueConstraint(tableSchema, constraintName, columnNames)` —
  the existing index whose name the prospective constraint's backing structure
  would claim, or undefined. Case-insensitive, name-only.
- `assertUniqueConstraintIndexNameFree(tableSchema, constraintName, columnNames, operation)` —
  throws `StatusCode.CONSTRAINT` with a message naming both objects. `operation`
  is the per-site phrase, so all three sites share one message tail.

Call sites:

| site | file |
| --- | --- |
| `ALTER TABLE … ADD CONSTRAINT` (UNIQUE arm) | `runtime/emit/add-constraint.ts`, beside the existing FK-collation pre-check |
| `ALTER TABLE … RENAME CONSTRAINT` | `runtime/emit/alter-table.ts`, beside the existing `namedConstraintExists` check |
| `ALTER TABLE … ADD COLUMN … unique` | `runtime/emit/alter-table.ts`, right after the inline constraints are extracted, before the column is materialized |

Plus `SchemaManager.importIndex` gained a `warnLog` (warn-and-proceed, never
reject) for an imported index whose name is held by that table's own UNIQUE
constraint — the same treatment its cross-table sibling already had. The stale
`NOTE` comment saying no warning existed was updated.

`docs/sql-ddl.md` §6.3 gained a bullet symmetric to the existing
"…but the name is taken on the constraint's own table", plus its three
sub-bullets (matching columns still rejected; UNIQUE only; `create unique index`
exempt), and the rehydration bullet now covers both collision shapes.

Error text, all three sites:

```
Cannot add constraint 'foo' to table 't': its backing index 'foo' would collide with
existing index 'foo' on the same table. Rename the constraint or the index.
```

## Deliberate design decisions (settled in the source ticket — please don't re-litigate)

- **Rejected even when the constraint's columns match the index's.** The two
  structures would coincide physically and nothing would break at runtime, but
  accepting it silently reclassifies the user's declared index as a hidden backing
  structure — it vanishes from `schema()`, from the persisted catalog, and stops
  being droppable. The legitimate reuse case matches on *columns*, not names, and
  is unaffected (`constraint bar unique (a)` reusing index `foo`).
- **Only UNIQUE.** CHECK and FOREIGN KEY build no backing index.
- **`create unique index` stays legal.** It synthesizes a UNIQUE constraint named
  after the index by design (`derivedFromIndex`); that path does not go through any
  of the three guarded sites, so the guard cannot fire on it.
- **No rehydration carve-out.** `importCatalog` → `importDDL` imports the
  `CREATE TABLE` (constraints included) *before* any `CREATE INDEX`, so at
  constraint-declaration time the table carries no indexes and the guard cannot
  fire on a reopen. Added unconditionally.
- **The RENAME guard is gated on `oldLower !== newLower`**, matching the existing
  constraint-name collision check right above it. Without that gate, a case-only
  rename on the memory backend would trip over the constraint's *own* materialized
  backing index, which sits in `tableSchema.indexes` under the old name. There is a
  passing sqllogic case for this (section 9c).

## What to exercise

Everything below is already asserted by the tests listed; they are a floor, not a
ceiling.

**Dual-backend behavior** — `test/logic/10.5.7-implicit-unique-index-lifecycle.sqllogic`,
new sections 9 and 10. Run memory then store:

```
node --import ./packages/quereus/register.mjs node_modules/mocha/bin/mocha.js \
  packages/quereus/test/logic.spec.ts --grep "10.5.7" --reporter spec

QUEREUS_TEST_STORE=true node --import ./packages/quereus/register.mjs \
  node_modules/mocha/bin/mocha.js packages/quereus/test/logic.spec.ts \
  --grep "10.5.7" --reporter spec
```

Covered there: all four authoring paths rejected (`ADD CONSTRAINT`; the unnamed
`_uc_<col>` auto-name; `RENAME CONSTRAINT`; `ADD COLUMN … unique`, both named and
unnamed); case-folded matching; same-columns still rejected; a differently-named
constraint over an already-indexed column still accepted and enforcing; the index
surviving each refusal intact (visible in `schema()`, one entry in `index_info()`,
still resolving rows by its own column); a free-name rename still working and a
case-only rename still a no-op; `create unique index` unaffected; and `apply
schema` reaching the same guard through the differ's emitted `ALTER TABLE … ADD
<constraint>` (section 10, which runs last against an otherwise-empty main schema).

**Memory-side array shape** — `test/alter-drop-rename-constraint.spec.ts`, two new
tests reading `db._findTable(t).indexes` directly (that array is the only place
the old duplicate-name corruption was visible; `index_info()` hid it). Asserts one
`foo` entry still keyed on the original column, rows still resolving by it, and no
constraint half-installed.

**Store durability** — `packages/quereus-store/test/index-persistence.spec.ts`,
last test. Asserts the persisted catalog bundle still declares the index, no
catalog write anywhere in the sequence dropped the `CREATE INDEX` line (it traces
every write, not just the final entry), the backing store keeps its entries, and
after close → reopen the index rehydrates with its rows readable.

```
node --import ./packages/quereus-store/register.mjs \
  node_modules/mocha/bin/mocha.js "packages/quereus-store/test/index-persistence.spec.ts" \
  --reporter spec
```

## Validation run

- `yarn build` — clean.
- `yarn test` — clean (full workspace).
- `yarn test:store` — 8142 passing, 21 pending, 0 failing.
- `yarn lint` — clean.
- `yarn typecheck` — clean.
- Neighbouring suites re-run individually and passing: `10.5.5-index-name-uniqueness`,
  `10.5.7-implicit-unique-index-lifecycle`, `41.6-alter-drop-rename-constraint`,
  `41.6.1-alter-drop-constraint-index-derived` (all dual-backend), plus
  `test/alter-drop-rename-constraint.spec.ts` and `test/schema-manager.spec.ts`.

No pre-existing failures were encountered.

## Known gaps — please probe these

- **The `importIndex` warning is untested.** Producing a collided catalog requires
  a database written before the guards existed; no fixture does that, and the
  ticket's decision was warn-and-proceed rather than reject, so there is no
  behavioral difference to assert beyond the log line. Verified by reading only.
- **Multi-column unnamed constraints are not exercised at the guard.** Every
  auto-name case in the tests is single-column (`_uc_a`), so the `_uc_a_b` joined
  form goes through the shared name function untested at these three sites.
- **A column declaring several inline `unique` constraints** is handled by a loop
  in the ADD COLUMN site but is not tested (SQL rarely produces it).
- **The RENAME site's column-name resolution is defensive.** It resolves the
  renamed constraint's columns for the auto-name, but a constraint reachable by
  `RENAME CONSTRAINT` always has a name, so the auto-name branch is unreachable
  there and the `uc?.columns ?? []` fallback is never exercised. Worth deciding
  whether that is worth simplifying.
- **The store durability test uses the in-memory persistent provider**, like every
  other test in that file — not real LevelDB. The physical-name reasoning it pins
  is provider-independent, but it is not an end-to-end disk test.
- **Only the memory backend's duplicate-index-entry corruption was reproduced
  before the fix.** The store backend's "constraint adopts the orphaned index
  store and silently stops enforcing" chain is quoted from the source ticket's
  measurements, not re-measured here — the guard makes it unreachable.

## Review findings from implementation

- **A fifth path to the same collision exists and is NOT fixed by this change.**
  Filed as `tickets/fix/bug-rename-column-shifts-unnamed-unique-index-name` with
  `repro: verified`. An unnamed UNIQUE constraint's backing-structure name is
  recomputed from live column names, so `alter table t rename column a to z` moves
  it from `_uc_a` onto `_uc_z` — and if an index `_uc_z` already exists, the same
  corruption follows. Measured on both backends: on memory the two objects swap
  visibility (the user's index becomes undroppable, the constraint's private
  structure becomes droppable and *was* dropped), and on the store backend the
  `CREATE INDEX` line is erased from the persisted catalog and `index_info()` is
  empty after reopen. It resolves at a different site (`runRenameColumn`), and the
  right shape is genuinely open (guard the rename vs. stop deriving the name from
  live columns), so it is its own ticket rather than an arm of this one.
