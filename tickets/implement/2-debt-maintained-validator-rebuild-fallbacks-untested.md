---
description: Two recovery behaviors for auto-maintained tables — degrading with a clear error when a rule they depend on breaks, and healing again when it comes back — have no test covering them, because the only way a test could trigger them from SQL is now correctly refused. Add tests that drive them directly.
files:
  - packages/quereus/test/maintained-table-declared-constraints.spec.ts   # add the new arms here (existing `constraint-dependency DDL invalidation` block)
  - packages/quereus/src/core/database-materialized-views.ts              # rebuildConstraintValidatorsFor (~226) — the catch that installs the poisoned validator; `table_added` self-heal branch (~188)
  - packages/quereus/src/core/derived-row-validator.ts                    # makePoisonedDerivedRowValidator (~342)
  - packages/quereus/src/schema/manager.ts                                # dropTable (~1508) — the guard-free drop the test drives
  - packages/quereus/src/runtime/emit/expression-drop-guard.ts            # why SQL can no longer reach the behavior
  - docs/mv-constraints.md                                                # line 27 documents both arms; add the reachability sentence
difficulty: easy
---

# What this is

A `create table … maintained as <query>` table (a materialized view) may declare its own
CHECK constraint, and that CHECK may contain a subquery reading some *other* table. The
engine compiles one validator per maintained table and rebuilds it whenever the catalog
changes under it (`MaterializedViewManager.rebuildConstraintValidatorsFor`). Two recovery
behaviors hang off that rebuild:

- **Degrade cleanly.** If the rebuild fails because the CHECK's subquery target is gone,
  the failure is caught and a *poisoned* validator is installed
  (`makePoisonedDerivedRowValidator`). The next write into the maintained table's source
  re-throws the clear, sited planning error rather than the stale validator's opaque
  module-connect failure — and the catch stops the exception escaping into whatever
  statement fired the schema-change event.
- **Heal again.** When the missing table is re-created, the `table_added` branch rebuilds
  any validator that named it, and validation returns to normal.

Both arms lost their coverage when `drop table <check target>` correctly became a refusal
(ticket `drop-guards-see-dependent-expressions-in-other-tables`). The code is not dead —
internal paths still drop a table without going through the DROP emitter that carries the
refusal, notably transaction rollback and catalog import on store reopen — but no
`.sqllogic` file can drive them.

# Reproduction (already done — this is the shape the tests should take)

`assertNoExpressionDependsOn` is called from the DROP *emitters* only, never from
`SchemaManager.dropTable` (see the "Called from the user-facing DDL emitters only" comment
in `expression-drop-guard.ts`). So a unit test can call `db.schemaManager.dropTable` directly
and land exactly where the internal paths land. Driving that against the existing spec's
`quota` / `qsrc` / `mq` fixture was verified to produce, in order:

- `await db.schemaManager.dropTable('main', 'quota')` → resolves `true`; the listener does
  not throw, and an unrelated `create table … ; insert …` afterwards still succeeds;
- `insert into qsrc values (1, 5)` (a **conforming** value, 5 ≤ 100) → rejected with
  `Table 'quota' not found in schema path: main`, and neither `qsrc` nor `mq` gains a row;
- after `create table quota (…); insert into quota values (1, 100);` → `insert into qsrc
  values (3, 5)` flows and lands in `mq`, while `insert into qsrc values (4, 500)` is
  rejected with `row derived into maintained table 'main.mq' violates its declared constraint`.

**Use the deferred-enqueue count as the discriminator.** A healthy subquery-bearing CHECK
auto-defers, so it queues exactly one deferred-constraint row per written image; the
poisoned validator holds a single *inline* check, so it queues zero and throws immediately.
Counting `db._queueDeferredConstraintRow` calls (the spy pattern the spec's "zero-overhead
gate" block already uses) therefore distinguishes "poisoned validator fired" from "a stale
validator happened to fail at evaluation time" without reaching into the private
`MaterializedViewManager`. Measured: healthy `1`, poisoned `0`, healed back to `1`.

Rejecting a *conforming* write is the second, independent discriminator — a merely stale
validator would have admitted `n = 5`.

# Where the tests belong

`test/maintained-table-declared-constraints.spec.ts`, inside the existing
`constraint-dependency DDL invalidation` describe. Two new nested describes, placed next to
the `subquery-CHECK target drop` block whose comment already points at this gap:

- one for the poisoned-validator arm (drop bypassing the emitter);
- one folded into `self-heal on dependency re-create`, restoring the CHECK-target arm that
  was deleted there — its comment currently explains why it is absent and should be replaced
  with the new test.

Both blocks need a short comment saying *why* they call `SchemaManager.dropTable` instead of
`drop table`: SQL refuses the drop, and the behavior under test belongs to the internal
drop paths (rollback, catalog import). Without it the next reader will "fix" the test into
using SQL and silently lose the coverage again.

`db.schemaManager.dropTable(…)` from a spec is established practice — `test/schema-manager.spec.ts`
drives the manager directly throughout.

# Notes

- The FK-parent arm of the same rebuild is untouched and already covered (a parent drop with
  no referencing rows is allowed and only rebuilds the validator) — the `FK parent drop` and
  `self-heal on dependency re-create` blocks are the working model for shaping the new ones.
- A `delete` after poisoning still succeeds: a delete writes no row image, so no CHECK is
  validated (documented behavior — `derived-row-validator.ts` § op-mask collapse). Worth one
  assertion so the poison's blast radius is pinned rather than assumed.
- Baseline: the spec file is 19 passing before this work.

# TODO

## Phase 1 — tests

- Add a `subquery-CHECK target dropped out of band` describe to
  `test/maintained-table-declared-constraints.spec.ts`, using the existing `quota`/`qsrc`/`mq`
  fixture and `await db.schemaManager.dropTable('main', 'quota')`.
- Assert the drop resolves and an unrelated statement afterwards still succeeds (the listener
  swallowed the rebuild failure rather than propagating it into the triggering statement).
- Assert a conforming source write is rejected with the sited `Table 'quota' not found` error,
  does not contain `connect failed` / `Cannot connect`, and leaves both `qsrc` and `mq` unchanged.
- Assert zero deferred-constraint enqueues on that poisoned write, against a healthy-baseline
  write that enqueues one.
- Assert a `delete from qsrc` after poisoning still succeeds (no row image → no CHECK).
- Restore the CHECK-target arm in `self-heal on dependency re-create`: after the out-of-band
  drop, re-create `quota`, then assert a conforming write flows into `mq`, a violating write is
  rejected with the `row derived into maintained table 'main.mq'` attribution, and the deferred
  enqueue count is back to one.
- Replace the "No subquery-CHECK arm here any more" comment above `self-heal on dependency
  re-create` with one explaining the out-of-band drive instead.

## Phase 2 — docs + validation

- `docs/mv-constraints.md` line 27: after "a **dropped subquery-CHECK target** cannot
  recompile, so a *poisoned* validator is installed…", add that a SQL `drop table` of a CHECK
  target is refused outright (`expression-drop-guard.ts`), so this arm is reached only by the
  internal drop paths — rollback and catalog import — which is why its coverage is unit-level.
- `yarn workspace @quereus/quereus run lint` (eslint + the test-file type pass).
- `yarn test` from the repo root.
