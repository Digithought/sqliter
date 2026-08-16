---
description: Once a table's identity columns mean the same thing whether or not you spell them out, the engine no longer needs to remember which way they were written — remove that bookkeeping and start writing the identity columns explicitly when the engine saves a table's definition.
prereq: feat-relax-declared-primary-key-not-null
files:
  - packages/quereus/src/schema/ddl-generator.ts (~111-131 — the `synthesizedKey` branch and the `inlinePkIndex` guard)
  - packages/quereus/src/schema/table.ts (~44-61 `TableSchema.synthesizedPrimaryKey`; ~1240-1268 `isSynthesizedAllColumnsKey`; `findPKDefinition` ~1191 return shape)
  - packages/quereus/src/schema/manager.ts (~1718-1748 `buildColumnSchemas` return; ~1966 and ~2025 — the two `synthesizedPrimaryKey:` assignments)
  - packages/quereus/test/alter-primary-key-generated-ddl.spec.ts (`expectedClauses: 0` for the synthesized-key case)
  - docs/schema.md (~315 — the "synthesized all-columns key emits no PRIMARY KEY clause" paragraph)
difficulty: medium
---

# Retire the synthesized-vs-declared primary key distinction

## Why this is now dead weight

`tickets/implement/feat-relax-declared-primary-key-not-null` removes the one behavioural
difference between a key the author declared and the all-columns key the engine synthesizes
for a table that declares none: nullability. With that gone the two are the same key, which
is exactly the maintainer's stated model — an undeclared all-columns key is syntactic sugar
for the declared one.

Three pieces of machinery exist only to keep them apart, and all three can go:

**1. The canonical-DDL emitter omits the clause.** `generateTableDDLInternal`
(`packages/quereus/src/schema/ddl-generator.ts` ~111-131) deliberately emits *no*
`PRIMARY KEY` clause — neither inline nor table-level — for a synthesized all-columns key.
The stated reason is that naming it would make a re-parse read it as declared, force its
columns NOT NULL, and silently drop a nullable declaration on a persistence round-trip. That
hazard no longer exists. The omission is now a special case that makes persisted DDL *less*
explicit than the generator's own stated policy for the no-`db` form ("persistence output
must be unambiguous to any reader" — `docs/schema.md` ~309). Start emitting the clause.

**2. `isSynthesizedAllColumnsKey`** (`schema/table.ts` ~1262) exists solely to gate that
omission. It has exactly one caller. Delete both.

**3. `TableSchema.synthesizedPrimaryKey`** (`schema/table.ts` ~61) is a persisted-shape flag
carrying "the real answer" for consumers that need to distinguish the two by more than
shape. Nothing in this repo reads it — it is assigned in `manager.ts` at ~1966 and ~2025 and
never consulted. After this change there is nothing left to distinguish, so it would be a
field that can only ever mislead. Delete it, its `buildColumnSchemas` plumbing
(`synthesizedPk`), and the `synthesized` member of `findPKDefinition`'s return if no caller
remains.

## The downstream this unblocks

The sibling storage engine at `../lamina` persists an equivalent flag,
`primaryKey.synthesized`, whose only job is the same distinction. Its own ticket to delete
it (`tickets/backlog/debt-retire-synthesized-primary-key-flag.md`, on that board) is waiting
on this engine agreeing the two keys are one thing. Do not edit that repo from this ticket —
just note in the review handoff that it is now unblocked.

## Edge cases & interactions

- **Single-column table with no declared PK.** Its synthesized key is one column, so it now
  takes the *inline* `PRIMARY KEY` branch (`inlinePkIndex` is currently forced to -1 by the
  `synthesizedKey` guard). Assert the emitted DDL has exactly one `PRIMARY KEY` occurrence,
  not two.
- **The empty-key singleton `primary key ()`.** A distinct shape that already has its own
  table-level emission path and must be untouched. `isSynthesizedAllColumnsKey` never
  matched it (its `pk.length !== n` test); make sure removing the function does not fold the
  singleton into the composite branch.
- **Zero-column tables**, if the parser admits them — the old guard's `n === 0` early return
  disappears with it.
- **Re-parse equivalence.** For each shape (no-PK single column, no-PK composite, declared
  all-columns PK, declared narrow PK, post-`ADD COLUMN` narrowed synthesized key): emit,
  re-parse in a fresh `Database`, and assert the resulting `primaryKeyDefinition` (index +
  desc + collation) and every column's `notNull` match the original. This is the whole point
  of the change and the one thing that must not regress.
- **Round-trip stability, twice.** Emit → parse → emit again must produce byte-identical
  DDL. Before this change the second emission differed in kind (the re-parsed schema had a
  declared key); afterwards there is only one form, so the fixed point must actually hold.
- **`ON CONFLICT`.** `isSynthesizedAllColumnsKey` bailed out when
  `primaryKeyDefaultConflict` was set, keeping `primary key (...) on conflict X` on the
  declared emission path. With the guard gone, an all-columns key *with* a conflict action
  must still render its `ON CONFLICT` clause — cover it.
- **`DESC` key components.** The old guard also required every component ascending. A
  descending all-columns key (reachable via `ALTER TABLE … ALTER PRIMARY KEY`, and used by
  ordering-seeded maintained-table backing keys) already emitted a clause; confirm it still
  does and still carries its `desc`.
- **Materialized-view / maintained-table backing DDL.** `generateMaintainedTableDDL` shares
  `generateTableDDLInternal`. A backing table with an all-columns physical key now emits a
  clause it previously omitted; check the maintained-view round-trip tests.
- **The declarative-schema differ.** `extractDeclaredPK` (`schema/schema-differ.ts` ~2763)
  already falls back to "all columns" when a declared table names no PK, so a stored table
  that now *does* carry an explicit clause must still compare equal to a declared side that
  omits it. Apply a no-PK schema twice and assert the second apply is a no-op — a churning
  `ALTER PRIMARY KEY` here is the most likely regression.
- **Store catalog rehydrate.** The store persists DDL text and re-parses it on reopen. Open
  a store database created *before* this change (persisted DDL with no `PRIMARY KEY` clause)
  and confirm it still rehydrates to the same key — the re-synthesis path must survive even
  though nothing emits that form any more.
- **`findPKDefinition`'s `warnLog`.** It logs "No PRIMARY KEY explicitly defined" on the
  synthesis path. After a round-trip the re-parsed DDL names the key, so the warning stops
  firing for a persisted table. That is an improvement, but if any test asserts on the log
  line it will need updating.

## TODO

- Delete the `synthesizedKey` branch in `generateTableDDLInternal` and the guard it puts on
  `inlinePkIndex`; delete `isSynthesizedAllColumnsKey` and its import.
- Delete `TableSchema.synthesizedPrimaryKey`, the `synthesizedPk` field on
  `buildColumnSchemas`' return, both `synthesizedPrimaryKey:` assignments in `manager.ts`,
  and `findPKDefinition`'s `synthesized` return member once nothing reads it.
- Rewrite the doc comments that explain why the distinction exists — `findPKDefinition`'s
  `@returns` note, the block comment above its synthesized return, and
  `TableSchema.primaryKeyDefinition`'s neighbours — so none of them describes a rule that no
  longer exists.
- `docs/schema.md` ~315: replace the "emits no PRIMARY KEY clause" paragraph with a
  statement that every key emits its clause and a declared all-columns key and an omitted
  one round-trip identically.
- `packages/quereus/test/alter-primary-key-generated-ddl.spec.ts`: the synthesized-key case
  moves from `expectedClauses: 0` to `1`; update its explanatory comment (~40-46) too.
- Add the re-parse-equivalence and emit-twice-stable assertions from the edge-case list.
- Check whether anything outside this repo imports `isSynthesizedAllColumnsKey` or reads
  `TableSchema.synthesizedPrimaryKey` — both are exported from the package's public surface,
  and `@quereus/store` re-exports the DDL generator. Search this monorepo; for `../lamina`,
  just report what you find in the handoff rather than editing it.
- Run `yarn build`, `yarn test`, `yarn lint`, `yarn test:store`. The store leg matters most
  here: it is the one that actually persists and re-parses the DDL this ticket changes.
