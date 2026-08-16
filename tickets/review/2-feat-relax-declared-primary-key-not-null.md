<!-- resume-note -->
RESUME: A prior agent run on this ticket did not complete.
  Prior run: 2026-08-16T21:49:21.713Z (agent: claude)
  Log file: C:\projects\quereus\tickets\.logs\2-feat-relax-declared-primary-key-not-null.review.2026-08-16T21-49-21-713Z.log
Read the log to see what was done. Resume where it left off.
If the prior run hit a timeout or repeated error, be cautious not to rush into the same situation.
<!-- /resume-note -->
---
description: A table that names its identity columns out loud is no longer forced to fill them in — declaring a primary key now means exactly what leaving it undeclared meant, so the two spellings accept the same values.
files:
  - packages/quereus/src/schema/manager.ts (`buildColumnSchemas` — promotion removed)
  - packages/quereus/src/schema/table.ts (`columnDefToSchema` promotion removed; `findPKDefinition` + `isSynthesizedAllColumnsKey` docs rewritten)
  - packages/quereus/src/schema/schema-differ.ts (`extractDeclaredNotNull` — PK early return removed)
  - packages/quereus/src/runtime/emit/alter-table.ts (DROP NOT NULL refusal removed; ALTER PRIMARY KEY nullable refusal removed; SET DATA TYPE refusal kept)
  - packages/quereus/src/vtab/memory/layer/manager.ts (`buildRekeyedPrimaryKeySchema` refusal removed)
  - packages/quereus/src/vtab/memory/layer/alter-column.ts (`planSetNotNull` refusal removed)
  - packages/quereus-store/src/common/store-module-alter-column.ts (`alterColumnSetNotNull` refusal removed)
  - packages/quereus/src/schema/lens-prover.ts (stale prose + tripwire NOTE)
  - packages/quereus/src/runtime/emit/materialized-view-helpers.ts (stale premise on the MV reshape mask + tripwire NOTE)
  - docs/schema.md, docs/sql-constraints.md, docs/sql-txn.md
  - packages/quereus/test/logic/43.3-nullable-primary-key.sqllogic (new, 12 sections)
  - packages/quereus/test/nullable-primary-key-round-trip.spec.ts (new)
  - packages/quereus-store/test/nullable-primary-key-persistence.spec.ts (new)
  - packages/quereus/test/logic/{10.2-column-features,41.1-alter-pk,41.2-alter-column,41.2.3-alter-column-set-not-null-pk-backfill}.sqllogic (changed)
  - packages/quereus/test/{no-pk-nullability,materialized-view-refresh-reshape}.spec.ts, packages/quereus/test/vtab/alter-column-plan.spec.ts (changed)
difficulty: medium
---

# Review: `PRIMARY KEY` no longer implies `NOT NULL`

## What changed, in one paragraph

`primary key` now names the row identity and nothing else. A key column keeps the
nullability it declared (`x integer null primary key`) or the one
`pragma default_column_nullability` gave it — the same rule that already governed the
all-columns key Quereus synthesizes for a table with no `PRIMARY KEY`. The two spellings
now produce byte-identical schemas, which was the point: an undeclared key is exact
syntactic sugar for the declared one. Under the shipped `not_null` default almost nothing
observable moves, because every column is NOT NULL unless it says otherwise.

## Answers to the three questions the ticket asked for explicitly

**Which refusals were removed, and which were kept.**

Removed — all five sites, three rules, exactly as scoped:

| Rule | Sites removed |
|---|---|
| `ALTER PRIMARY KEY (<nullable column>)` → "must be NOT NULL to participate in PRIMARY KEY" | `runtime/emit/alter-table.ts` `runAlterPrimaryKey`; `vtab/memory/layer/manager.ts` `buildRekeyedPrimaryKeySchema` |
| `ALTER COLUMN <pk col> DROP NOT NULL` → "Cannot DROP NOT NULL on PRIMARY KEY column" | `runtime/emit/alter-table.ts` `runAlterColumn`; `vtab/memory/layer/alter-column.ts` `planSetNotNull`; `quereus-store/src/common/store-module-alter-column.ts` `alterColumnSetNotNull` |

None turned out to be load-bearing. Every one was a pure pre-check that threw before any
mutation; nothing downstream read the invariant they enforced.

Kept, deliberately:

- **`Cannot SET DATA TYPE on PRIMARY KEY column`** (`runtime/emit/alter-table.ts`, and the
  store's mirrored carve-out). A different rule — a retype moves the key's *type* and
  comparator, not just its nullability. Explicitly out of scope per the ticket. Pinned by a
  new assertion in `41.2-alter-column.sqllogic` § 6 and `43.3` § 9 so it cannot rot away.
- **The materialized-view reshape's PK-column loosening mask**
  (`materialized-view-helpers.ts` `describeBackingShapeMismatch` /
  `isPhysicalPkColumn`). This is *not* one of the five; it lives in the MV backing, not in
  the ALTER path. It used to exist because the memory manager would have thrown on the
  `loosenNotNull` op it suppressed. That throw is gone, so the mask now does real work
  rather than dodging an error: it is what keeps an ordering-seeded backing key NOT NULL,
  which `assertNoNullInNotNullSeededPk` depends on. Behaviour unchanged and still pinned by
  `materialized-view-refresh-reshape.spec.ts`; only the rationale in the comments moved.
  **Worth a reviewer's eye** — see *Where I'd look hardest* below.

**Did any existing test change meaning rather than wording.** Yes, five, and each one
asserted the removed rule directly:

| Test | Old assertion | New assertion |
|---|---|---|
| `test/no-pk-nullability.spec.ts` (2 cases) | a declared table-level / column-level PK forces `notNull = true` despite `null` | it leaves the column nullable; plus a new case asserting the declared and synthesized spellings of one key produce identical `[name, notNull, primaryKey]` triples |
| `test/vtab/alter-column-plan.spec.ts` | `planSetNotNull(pk, false)` throws `CONSTRAINT` | it returns a metadata-only change with `rewrite: null`, `comparatorChanged: false` |
| `test/logic/41.1-alter-pk.sqllogic` § 5 | "Rekey to nullable column should fail" | the re-key succeeds, rows survive, the new key accepts NULL once and rejects a second |
| `test/logic/41.2-alter-column.sqllogic` § 6 | "Cannot drop NOT NULL on PK column" | the drop succeeds and is metadata-only (existing row untouched); `SET DATA TYPE` still refused in the same section |
| `test/logic/10.2-column-features.sqllogic` § 3c | "Primary key column is always NOT NULL" | kept verbatim as the *shipped-default* case (still fails), re-titled, plus a new explicit-`null` counterpart that now succeeds — per the ticket, the case was not deleted |

Comment-only updates (no assertion moved) in `41.2.3-alter-column-set-not-null-pk-backfill.sqllogic`
and `materialized-view-refresh-reshape.spec.ts`, where prose stated the old rule as design.

**The "existing databases do not retroactively loosen" check — result: confirmed, two ways.**

- `quereus-store/test/nullable-primary-key-persistence.spec.ts`, last case: creates
  `(x integer not null, y integer not null, primary key (x, y))` on a store-backed table,
  reads the **actual persisted catalog entry** out of the KV catalog store via
  `buildCatalogKey`, and asserts the DDL text spells `"x" … NOT NULL` and `"y" … NOT NULL`.
  Then closes, reopens through `rehydrateCatalog`, and asserts both columns come back
  `notnull = 1` and a NULL insert is still rejected.
- `test/nullable-primary-key-round-trip.spec.ts`, last case, does the same in-process for
  both the explicit `not null` spelling and the bare `id integer primary key` under the
  shipped default.

A catalog written before this change has the tightening baked into its DDL text, so the
re-parse keeps it. Nothing is loosened retroactively.

## Correction to the originating ticket — verified, as instructed

The plan ticket suspected `ALTER TABLE … ADD COLUMN` left a synthesized key at its old width
while a DDL round-trip re-synthesized it wider. It does not.
`nullable-primary-key-round-trip.spec.ts` § "a post-ADD COLUMN synthesized key round-trips at
its ORIGINAL width" pins it: after `add column c`, the key is still `[a, b]`, the emitter
renders an explicit `PRIMARY KEY (a, b)` clause, and the re-parse reads back the same narrow
key. What used to diverge was nullability (the re-parse read the clause as a declared key and
tightened `a`/`b`); that is what this change fixes. No separate key-width ticket filed.

## What to exercise

New corpus file `test/logic/43.3-nullable-primary-key.sqllogic`, 12 sections, runs under both
`yarn test` and `yarn test:store`:

1. shipped default unchanged (`id integer primary key` still rejects NULL) — the case that
   must *not* move
2. headline: `x integer null primary key` accepts NULL once, rejects the second
3. same via `pragma default_column_nullability = 'nullable'`; plus declared-vs-synthesized
   `table_info` equality
4. composite nullable key — `(null,null)`, `(null,1)`, `(1,null)` are three distinct keys,
   each colliding only with itself
5. NULL-in-key vs NULL-in-`UNIQUE` side by side, in one table
6. `insert or replace` / `or ignore` / `on conflict do update` all resolve against the
   existing NULL-keyed row
7. `update` moving a key column to NULL and back; collision on the way in
8. foreign keys: a parent key tuple containing NULL is unreferenceable — child rejected when
   its FK value is non-NULL, admitted when NULL, `restrict` does not fire for the NULL-keyed
   parent, `cascade` does not propagate from it
9. `ALTER COLUMN <pk col> DROP NOT NULL` succeeds, rewrites nothing, and `SET DATA TYPE`
   still refused
10. `SET NOT NULL` on a *declared* key column — metadata-only / backfill+re-key / collision,
    in lock-step with `41.2.3`
11. `ALTER PRIMARY KEY` onto a nullable column; and onto one already holding two NULLs
    (reported as a duplicate key, not silently merged)
12. a nullable declared key through an explicit transaction with a `unique` secondary
    structure — read-your-own-writes, staged collision, commit, rollback

Plus `test/nullable-primary-key-round-trip.spec.ts` (6 cases: DDL emit → re-parse for
single/composite/session-default/post-ADD-COLUMN/post-re-key shapes, `apply schema`
idempotence, non-loosening) and `quereus-store/test/nullable-primary-key-persistence.spec.ts`
(4 cases through a real close → `rehydrateCatalog` reopen).

## Where I'd look hardest

Ranked by how much I'd want a second pair of eyes, honestly:

1. **The MV reshape mask** (`materialized-view-helpers.ts`). Its guard used to be
   double-locked: the reshape masked the `loosenNotNull` op *and* the manager would have
   thrown if it slipped through. I removed the second lock. The mask still holds — both
   reshape specs pass, and I checked the mask is computed in `describeBackingShapeMismatch` /
   `classifyBackingReshape` independent of the manager — but a reviewer should confirm there
   is no *other* path that reaches a backing `alter column … drop not null` on a physical-PK
   column and now succeeds where it used to throw. I did not find one; I did not prove none
   exists. I updated the comments and left a `NOTE:` at `isPhysicalPkColumn` recording that
   the invariant is now MV-backing *policy*, not an engine constraint.
2. **`extractDeclaredNotNull` in `schema-differ.ts`.** The removed line was already
   inconsistent (it only inspected *column-level* constraints, so a table-level
   `primary key (x, y)` never got the promotion there even when the engine applied one).
   Removing it makes the two agree, and the `apply schema` idempotence test covers the
   headline case — but that test uses a table-level key on an **empty** table. A phantom
   `SET NOT NULL` against a *populated* nullable key column would surface as a backfill or a
   rejection, and I did not write that case. If you want one more test, that is the one.
3. **`43.3` § 8 (foreign keys) asserts against error *text*** (`CHECK constraint failed:
   _fk_…`, `violates RESTRICT from '…'`) because that is the shape the existing FK corpus
   uses. It is testing the right behaviour, but it is coupled to auto-constraint naming.
4. **`43.3` avoids TEXT key columns entirely** — the store defaults an undecorated TEXT
   primary-key column to NOCASE while memory uses BINARY (the `10.2.2` note in
   `logic.spec.ts`), which would have made the file diverge between backends for unrelated
   reasons. So nullable **text** keys are covered only incidentally. If NULL-vs-collation
   interaction in key position matters, it is untested here.

## Known gaps

- **No cross-package isolation-layer spec.** § 12 exercises a nullable declared key through
  a transaction, and it runs under `yarn test:store` (which goes through the isolation
  layer), so the path is covered — but there is no dedicated `quereus-isolation` unit test
  for a nullable *declared* key the way the prerequisite ticket has for the synthesized one.
- **`quereus-sync` was not exercised beyond its own suite.** Schema-change events carry the
  generated DDL text, which now carries `null` on key columns; the round-trip specs cover
  emit → re-parse, but not a sync peer applying it.
- **The `synthesizedPrimaryKey` / `isSynthesizedAllColumnsKey` pair still exists**, per the
  ticket's explicit scope. `ddl-generator.ts` untouched. Their doc comments were rewritten
  because they stated the now-removed promotion as their *reason for existing*; the
  behaviour is unchanged and `tickets/implement/4-debt-emit-primary-key-clause-for-every-key`
  is what retires them.
- **Line-count / perf claims: none made, none measured.** This change removes code paths; it
  adds none.

## Tripwires parked in code (not tickets)

- `packages/quereus/src/schema/lens-prover.ts` `proveKeyByBijectionTransport` — the NOT NULL
  gate is now blunter than it needs to be. A basis *primary* key is NULL-equal (unlike
  `UNIQUE`, which is NULL-skipping), so a nullable PK column is in fact unconditionally
  unique and could be proved; the gate rejects it anyway. That costs a missed shortcut (fall
  back to the commit-time scan), never soundness. `NOTE:` at the site says to split the gate
  on PK-vs-UNIQUE if a nullable-PK lens ever shows up as slow.
- `packages/quereus/src/runtime/emit/materialized-view-helpers.ts` `isPhysicalPkColumn` —
  the MV backing keeping its physical-PK columns NOT NULL is now a policy of the backing
  rather than an engine constraint. `NOTE:` at the site pairs it with
  `assertNoNullInNotNullSeededPk` and points at
  `debt-mv-ordering-seed-to-materialized-index` as what removes the need for both.
- `packages/quereus/src/schema/table.ts` `isSynthesizedAllColumnsKey` — the partial
  conflict-action guard's hazard ("re-parsing an emitted clause would tighten the columns")
  is gone, so widening it is now merely unfinished work rather than unsafe. Recorded in the
  existing `NOTE:` there, pointing at ticket 4.

## Validation run

- `yarn build` — clean
- `yarn test` — exit 0, every workspace green; `packages/quereus` 9633 passing / 25 pending /
  0 failing, `quereus-store` 1802 passing (includes the 4 new persistence cases)
- `yarn lint` — clean (quereus eslint + `tsconfig.test.json` type pass; every other package
  is the intentional no-op)
- `yarn typecheck` — clean
- `yarn test:store` — 9625 passing / 33 pending / 0 failing under the LevelDB store module;
  `43.3` runs there too

Getting there took five iterations, each fixing exactly one test that asserted the removed
rule (41.1 → 41.2 → 43.3's own FK error text → `no-pk-nullability` → `alter-column-plan`).
That list is the *whole* blast radius the suite found — worth knowing it was that small.

No pre-existing failures surfaced; `tickets/.pre-existing-error.md` not written.
