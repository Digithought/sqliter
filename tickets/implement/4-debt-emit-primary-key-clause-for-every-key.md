---
description: When the engine writes out a table's definition it currently leaves the identity columns unwritten for tables that never named them, which quietly loses a "what to do on a duplicate row" setting. Always write the identity columns out.
prereq: feat-relax-declared-primary-key-not-null, bug-set-not-null-backfill-can-merge-two-primary-keys
files:
  - packages/quereus/src/schema/ddl-generator.ts (~112-155 — the `synthesizedKey` const, the `inlinePkIndex` guard, the table-level `!synthesizedKey &&` guard, and the `isSynthesizedAllColumnsKey` import at ~23)
  - packages/quereus/src/schema/table.ts (~1257-1305 — `isSynthesizedAllColumnsKey` and its doc block; ~44-67 — the `{@link isSynthesizedAllColumnsKey}` reference inside `TableSchema.synthesizedPrimaryKey`'s doc)
  - packages/quereus/test/table-ddl-round-trip.spec.ts (the round-trip harness this change flips — read its header comment first)
  - packages/quereus/test/alter-primary-key-generated-ddl.spec.ts (~40-46 comment and the `expectedClauses: 0` case)
  - docs/schema.md (~315 the omission paragraph; ~321 the fixed-point paragraph's "Aside from the synthesized-key omission" opener)
difficulty: medium
---

# Every primary key emits its `PRIMARY KEY` clause

## STOP — check the blocker first

This ticket was dispatched twice before its prerequisite landed. A prior run wrote the
whole change, ran it, hit the blocker, and reverted. **Check before writing any code.**

```bash
grep -n "isPkColumn && !synthesized" packages/quereus/src/schema/manager.ts
grep -n "if (schema.primaryKey) {" packages/quereus/src/schema/table.ts
```

Either hit ⇒ the `PRIMARY KEY` ⇒ `NOT NULL` promotion is still in the tree, and this
change is not safe to make. `feat-relax-declared-primary-key-not-null` (same stage,
sequence 2) removes both sites; it in turn waits on
`bug-set-not-null-backfill-can-merge-two-primary-keys` in `tickets/fix/`. Both are listed
in `prereq:` above precisely so the runner's cross-stage gate fires while the `fix/` one is
pending — the `implement/` one is in the same stage as this ticket, so no gate fires on it.
If the greps still hit, stop and say so rather than working around it.

What happens if you ignore it: emitting `PRIMARY KEY ("a", "b")` for a key nobody declared
makes the re-parse read it as *declared*, which forces both columns `NOT NULL`. A nullable
column is silently tightened on every persistence round-trip. Reproduced, not theoretical —
it fails `packages/quereus/test/alter-primary-key-generated-ddl.spec.ts`, case
"round-trips an unaltered table's DDL byte-identically", shape
`create table t (a integer null, b text null)`: the second emission reads `NOT NULL` where
the first read `NULL`.

## Background

A table that declares no `PRIMARY KEY` gets an all-columns key synthesized for it
(`findPKDefinition`, `schema/table.ts`). Today the canonical-DDL emitter deliberately
writes **no** `PRIMARY KEY` clause for such a key — neither inline nor table-level — so the
re-parse re-synthesizes it. The omission exists for exactly one reason: a *declared*
`PRIMARY KEY` promotes its columns to `NOT NULL` while a synthesized one does not, so
naming the key would tighten a nullable column on every round-trip.

`feat-relax-declared-primary-key-not-null` removes that promotion. With it gone, a declared
all-columns key and a synthesized one are the same key — the maintainer's stated model,
"an undeclared all-columns key is syntactic sugar for the declared one". The omission then
has no justification left, and it makes persisted DDL *less* explicit than the generator's
own stated policy for the no-`db` form ("persistence output must be unambiguous to any
reader", `docs/schema.md` ~309).

## This is a live bug fix, not only a cleanup

`isSynthesizedAllColumnsKey` bails out (⇒ clause *is* emitted) when the table-level
`primaryKeyDefaultConflict` is set. It does **not** look at an `ON CONFLICT` action declared
on a key *column*. So both of these emit no clause, and the action has nowhere to ride:

```sql
create table t (a integer primary key on conflict replace);
create table t (a integer not null on conflict replace, b text, primary key (a, b));
```

Both come back as `ABORT` after a reopen and start throwing on a duplicate-key write.
The loss is *stable* (the second emission drops it identically), so the round-trip harness's
fixed-point assertion cannot see it; it is pinned instead by explicit
`expectedConflictAfterRoundTrip: '(none)'` entries in `test/table-ddl-round-trip.spec.ts`.
Deleting the omission fixes it.

Fixing it *inside* the guard was considered and rejected: widening the bail-out to
`resolvePkDefaultConflict` would emit a clause for a genuinely synthesized key whose column
carries `not null on conflict X`, reintroducing the nullability regression above.
Distinguishing a declared all-columns key from a synthesized one *by shape* is exactly what
is impossible, which is why the fix has to be "emit the clause for everything".

## Scope boundary

`TableSchema.synthesizedPrimaryKey` (the stored flag) and `findPKDefinition`'s `synthesized`
return member stay. They are read by the sibling `../lamina` repo's `lamina-quereus`
adapter and their removal needs cross-repo sequencing — split out to
`tickets/blocked/debt-retire-quereus-synthesized-primary-key-flag.md`. Do **not** touch them
here beyond fixing the one dangling doc reference noted below.

## What already exists

`packages/quereus/test/table-ddl-round-trip.spec.ts` is the harness for this change — 16
cases asserting, per primary-key shape, that emit → re-parse preserves the key and every
column's `notNull`, and that emit → parse → emit is byte-identical. Its header comment names
exactly which expectations flip. **Read it first.** Most edge cases below are already a case
in it; you are flipping expectations, not writing new assertions.

## Edge cases & interactions

- **Single-column table with no declared PK.** Its key is one column, so it now takes the
  *inline* `PRIMARY KEY` branch (`inlinePkIndex` is currently forced to -1 by the
  `synthesizedKey` guard). Assert exactly one `PRIMARY KEY` occurrence, not two. *(Already a
  case — flip `expectedClauses` 0 → 1.)*
- **The empty-key singleton `primary key ()`.** Distinct shape, its own table-level emission
  path, must be untouched. `isSynthesizedAllColumnsKey` never matched it (its `pk.length !== n`
  test); make sure removing the function does not fold the singleton into the composite
  branch and render an empty column list. *(Already a case.)*
- **Zero-column tables**, if the parser admits them — the old guard's `n === 0` early return
  disappears with it.
- **The nullable case the harness cannot assert today.** Under
  `pragma default_column_nullability = 'nullable'`, `create table t (a integer, b text)`
  must round-trip with both columns still nullable. This is the whole point of the change and
  the one case that fails before the prerequisite lands — **add it.**
- **`ON CONFLICT`, table-level.** An all-columns key *with* `on conflict X` must still render
  it. *(Already covered — three cases.)*
- **`ON CONFLICT`, column-declared.** See the live-bug section — **delete the two
  `expectedConflictAfterRoundTrip` entries**; the round-trip now preserves the action and the
  field should stop being needed.
- **`DESC` key components.** The old guard also required every component ascending. A
  descending all-columns key (reachable via `ALTER TABLE … ALTER PRIMARY KEY`, and used by
  ordering-seeded maintained-table backing keys) already emitted a clause; confirm it still
  does and still carries its `desc`. *(Already a case.)*
- **Materialized-view / maintained-table backing DDL.** `generateMaintainedTableDDL` shares
  `generateTableDDLInternal`. A backing table with an all-columns physical key now emits a
  clause it previously omitted; check the maintained-view round-trip tests.
- **The declarative-schema differ.** `extractDeclaredPK` (`schema/schema-differ.ts` ~2763)
  already falls back to "all columns" when a declared table names no PK, so a stored table
  that now *does* carry an explicit clause must still compare equal to a declared side that
  omits it. Apply a no-PK schema twice and assert the second apply is a no-op — a churning
  `ALTER PRIMARY KEY` here is the most likely regression.
- **Store catalog rehydrate.** The store persists DDL text and re-parses it on reopen. A
  database created *before* this change has persisted DDL with no `PRIMARY KEY` clause and
  must still rehydrate to the same key — the re-synthesis path has to survive even though
  nothing emits that form any more. *(Already a case, using the literal legacy text; keep it.)*
- **`findPKDefinition`'s `warnLog`.** It logs "No PRIMARY KEY explicitly defined" on the
  synthesis path. After a round-trip the re-parsed DDL names the key, so the warning stops
  firing for a persisted table. That is an improvement, but if any test asserts on the log
  line it needs updating.

## TODO

- Re-run the blocker greps above. If either hits, stop and report.
- `ddl-generator.ts`: delete the `synthesizedKey` const and its explanatory comment, the
  `!synthesizedKey &&` term on `inlinePkIndex`, the `!synthesizedKey &&` term on the
  table-level composite branch, and the `isSynthesizedAllColumnsKey` import. Update the two
  neighbouring comments that say a synthesized key emits no clause.
- `table.ts`: delete `isSynthesizedAllColumnsKey` and its whole doc block (including its
  `NOTE:` about this retirement).
- `table.ts`: `TableSchema.synthesizedPrimaryKey`'s doc has a `{@link isSynthesizedAllColumnsKey}`
  reference that dangles once the function is gone. Rewrite that paragraph to describe the
  flag on its own terms (it is still the real answer for a consumer that changes behaviour on
  it) without citing the deleted predicate. Keep the field and its lamina `NOTE:`.
- `docs/schema.md` ~315: replace the omission paragraph with a statement that every key emits
  its clause and that a declared all-columns key and an omitted one round-trip identically.
  ~321: drop the "Aside from the synthesized-key omission," opener — the fixed point is now
  unconditional. The neighbouring `ON CONFLICT` paragraph stays.
- `test/table-ddl-round-trip.spec.ts`: flip the `expectedClauses: 0` cases to `1`, rewrite the
  header comment's "The one non-uniform case, and what will change" section into a plain
  statement of the new rule, delete the two `expectedConflictAfterRoundTrip` entries (and the
  field itself if nothing else uses it), and add the nullable-key case the header names.
- `test/alter-primary-key-generated-ddl.spec.ts`: the synthesized-key case moves from
  `expectedClauses: 0` to `1`; update the `expectedClauses` doc comment at ~40-46 too.
- Run `yarn build`, `yarn test`, `yarn lint`, `yarn test:store`. The store leg matters most:
  it is the one that actually persists and re-parses the DDL this ticket changes.
