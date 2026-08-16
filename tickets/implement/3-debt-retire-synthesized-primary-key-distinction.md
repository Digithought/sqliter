---
description: Once a table's identity columns mean the same thing whether or not you spell them out, the engine no longer needs to remember which way they were written — remove that bookkeeping and start writing the identity columns explicitly when the engine saves a table's definition. Blocked until two other changes land; check before starting.
prereq: feat-relax-declared-primary-key-not-null
files:
  - packages/quereus/src/schema/ddl-generator.ts (~112-145 — the `synthesizedKey` branch and the `inlinePkIndex` guard)
  - packages/quereus/src/schema/table.ts (~44-67 `TableSchema.synthesizedPrimaryKey`; ~1255-1285 `isSynthesizedAllColumnsKey`; `findPKDefinition` ~1191 return shape)
  - packages/quereus/src/schema/manager.ts (~1710-1748 `buildColumnSchemas` return; ~1966 and ~2025 — the two `synthesizedPrimaryKey:` assignments)
  - packages/quereus/test/table-ddl-round-trip.spec.ts (the round-trip harness this change flips — read its header comment first)
  - packages/quereus/test/alter-primary-key-generated-ddl.spec.ts (`expectedClauses: 0` for the synthesized-key case)
  - docs/schema.md (~315 — the "synthesized all-columns key emits no PRIMARY KEY clause" paragraph)
  - ../lamina/packages/lamina-quereus/src/quereus-ast-translators.ts (~646) and .../module.ts (~3258) — read-only; the downstream consumer
difficulty: medium
---

# Retire the synthesized-vs-declared primary key distinction

## STOP — check the two blockers first

A prior implement run took this ticket, wrote the whole change, ran it, hit both blockers
below, and reverted. Neither is a guess; both were reproduced. **Check them before writing
any code — if either still holds, do not start.**

**Blocker 1 — the `PRIMARY KEY` ⇒ `NOT NULL` promotion must be gone.**

```bash
grep -n "isPkColumn && !synthesized" packages/quereus/src/schema/manager.ts
grep -n "if (schema.primaryKey) {" packages/quereus/src/schema/table.ts
```

Either hit ⇒ blocked. The prerequisite `feat-relax-declared-primary-key-not-null` removes
them; it is itself waiting on `bug-set-not-null-backfill-can-merge-two-primary-keys` in
`tickets/fix/`, so the chain is:

```
fix/bug-set-not-null-backfill-can-merge-two-primary-keys
  → implement/feat-relax-declared-primary-key-not-null
    → this ticket
      → ../lamina backlog/debt-retire-synthesized-primary-key-flag  (see blocker 2)
```

Note the runner has dispatched this ticket ahead of its prerequisite once already — the
prerequisite sits in the *same* stage, so the cross-stage prereq gate does not fire on it.
That is why the check above is written out rather than assumed.

What happens if you ignore it: emitting `PRIMARY KEY ("a", "b")` for a synthesized key
makes the re-parse read it as *declared*, which forces both columns `NOT NULL`. A nullable
column is silently tightened on every persistence round-trip. This is not theoretical — it
fails an existing test today:

```
packages/quereus/test/alter-primary-key-generated-ddl.spec.ts
  "round-trips an unaltered table's DDL byte-identically", shape:
  create table t (a integer null, b text null)
  → second emission reads NOT NULL where the first read NULL
```

**Blocker 2 — `TableSchema.synthesizedPrimaryKey` is NOT dead.** The original ticket said
nothing reads it. Nothing in *this repo* does. The sibling `../lamina` repo's
`lamina-quereus` adapter does, in two places:

- `packages/lamina-quereus/src/quereus-ast-translators.ts:646` reads
  `s.synthesizedPrimaryKey` and falls back to a *shape* test when the slot is absent;
- `packages/lamina-quereus/src/module.ts:3258` (`rejectSynthesizedKeyWidening`) gates the
  `ALTER TABLE … ADD COLUMN` key-widening refusal on `primaryKey.synthesized`.

lamina's own comment states the shape fallback cannot tell a declared all-columns PK from
the synthesized one, and that using it for the ADD COLUMN decision would "silently rewrite
a key its author wrote". So deleting the field here does **not** merely *unblock* lamina —
it breaks it until lamina's `tickets/backlog/debt-retire-synthesized-primary-key-flag.md`
lands. Those two deletions have to be coordinated: land lamina's side first, or land both
together. Confirm the current state of that lamina ticket before deleting the field.

## Why this is worth doing

`feat-relax-declared-primary-key-not-null` removes the one behavioural difference between a
key the author declared and the all-columns key the engine synthesizes for a table that
declares none: nullability. With that gone the two are the same key, which is the
maintainer's stated model — an undeclared all-columns key is syntactic sugar for the
declared one.

Three pieces of machinery exist only to keep them apart:

**1. The canonical-DDL emitter omits the clause.** `generateTableDDLInternal`
(`packages/quereus/src/schema/ddl-generator.ts`) emits *no* `PRIMARY KEY` clause — neither
inline nor table-level — for a synthesized all-columns key. The omission makes persisted
DDL *less* explicit than the generator's own stated policy for the no-`db` form
("persistence output must be unambiguous to any reader" — `docs/schema.md` ~309). Start
emitting the clause.

**2. `isSynthesizedAllColumnsKey`** (`schema/table.ts`) exists solely to gate that
omission. It has exactly one caller. Delete both.

**3. `TableSchema.synthesizedPrimaryKey`** — delete it, its `buildColumnSchemas` plumbing
(`synthesizedPk`), and the `synthesized` member of `findPKDefinition`'s return if no caller
remains. **Subject to blocker 2.** Note that `findPKDefinition`'s `synthesized` is read by
the promotion the prerequisite removes, so it only becomes deletable after that lands.

## What has already been done for you

A previous run landed the supporting work (see
`tickets/review/3-ddl-primary-key-conflict-action-persisted`):

- **`packages/quereus/test/table-ddl-round-trip.spec.ts` exists** — 16 cases asserting, for
  each primary-key shape, that emit → re-parse preserves the key and every column's
  `notNull`, and that emit → parse → emit is byte-identical. Its header comment names
  exactly which expectations flip. **This is your harness; read it first.** Most of the
  "Edge cases" list below is already a case in it.
- **A real bug found while building that harness is fixed**: the key's `ON CONFLICT` action
  was dropped from emitted DDL entirely. It now rides whichever clause carries the key,
  resolved through `resolvePkDefaultConflict` so a column-declared action reaches the
  table-level clause too. `packages/quereus-store/test/pk-conflict-action-reopen.spec.ts`
  pins the reopen behaviour end-to-end. One residue is left for *this* ticket to clear — see
  the second `ON CONFLICT` bullet below.
- `NOTE:` markers are in place at `TableSchema.synthesizedPrimaryKey` (recording the lamina
  consumer) and at `isSynthesizedAllColumnsKey` (recording this retirement).

## Edge cases & interactions

- **Single-column table with no declared PK.** Its synthesized key is one column, so it now
  takes the *inline* `PRIMARY KEY` branch (`inlinePkIndex` is currently forced to -1 by the
  `synthesizedKey` guard). Assert the emitted DDL has exactly one `PRIMARY KEY` occurrence,
  not two. *(Already a case in the harness — flip `expectedClauses` 0 → 1.)*
- **The empty-key singleton `primary key ()`.** A distinct shape with its own table-level
  emission path; must be untouched. `isSynthesizedAllColumnsKey` never matched it (its
  `pk.length !== n` test); make sure removing the function does not fold the singleton into
  the composite branch. *(Already a case.)*
- **Zero-column tables**, if the parser admits them — the old guard's `n === 0` early return
  disappears with it.
- **Re-parse equivalence and emit-twice stability** for every shape. *(The harness already
  asserts both; you are flipping expectations, not writing new assertions.)*
- **The nullable case the harness cannot assert today.** Under
  `pragma default_column_nullability = 'nullable'`, `create table t (a integer, b text)`
  must round-trip with both columns still nullable. This is the whole point of the change
  and the one case that fails before the prerequisite lands — **add it**.
- **`ON CONFLICT`.** `isSynthesizedAllColumnsKey` bails out when `primaryKeyDefaultConflict`
  is set, keeping `primary key (...) on conflict X` on the declared emission path. With the
  guard gone, an all-columns key *with* a conflict action must still render its
  `ON CONFLICT`. *(Already covered — three cases in the harness.)*
- **`ON CONFLICT` declared on a key COLUMN of an all-columns key — this change fixes a live
  bug, not just a cosmetic one.** The guard's bail-out only inspects the *table-level*
  `primaryKeyDefaultConflict`. An action declared on a key column instead — `create table t
  (a integer primary key on conflict replace)`, or `create table t (a integer not null on
  conflict replace, b text, primary key (a, b))` — leaves the guard matching, so no clause is
  emitted and the action has nowhere to ride. Both tables come back as `ABORT` after a
  reopen and start throwing on a duplicate-key write. The loss is *stable* (the second
  emission drops it identically), so the fixed-point assertion cannot see it; the harness
  pins it with an explicit `expectedConflictAfterRoundTrip: '(none)'`. **When you delete the
  omission, delete those two `expectedConflictAfterRoundTrip` entries too** — the round-trip
  then preserves the action and the field should stop being needed. Fixing this inside the
  guard instead was rejected: distinguishing a declared all-columns key from a synthesized
  one by shape is exactly what is impossible, so a shape-based bail-out would emit a clause
  for a genuinely synthesized key and reintroduce blocker 1's nullability regression.
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
  nothing emits that form any more. *(Already a case in the harness, using the literal
  legacy text; keep it.)*
- **`findPKDefinition`'s `warnLog`.** It logs "No PRIMARY KEY explicitly defined" on the
  synthesis path. After a round-trip the re-parsed DDL names the key, so the warning stops
  firing for a persisted table. That is an improvement, but if any test asserts on the log
  line it will need updating.

## TODO

- Re-run both blocker checks above. If either holds, stop and report rather than working
  around it.
- Delete the `synthesizedKey` branch in `generateTableDDLInternal` and the guard it puts on
  `inlinePkIndex`; delete `isSynthesizedAllColumnsKey`, its import, and its `NOTE:`.
- Delete `TableSchema.synthesizedPrimaryKey` (and its `NOTE:`), the `synthesizedPk` field on
  `buildColumnSchemas`' return, both `synthesizedPrimaryKey:` assignments in `manager.ts`,
  and `findPKDefinition`'s `synthesized` return member once nothing reads it — coordinated
  with lamina per blocker 2.
- Rewrite the doc comments that explain why the distinction exists — `findPKDefinition`'s
  `@returns` note, the block comment above its synthesized return, and
  `TableSchema.primaryKeyDefinition`'s neighbours — so none of them describes a rule that no
  longer exists.
- `docs/schema.md` ~315: replace the "emits no PRIMARY KEY clause" paragraph with a
  statement that every key emits its clause and a declared all-columns key and an omitted
  one round-trip identically. The neighbouring `ON CONFLICT` and fixed-point paragraphs stay.
- `packages/quereus/test/table-ddl-round-trip.spec.ts`: flip the `expectedClauses: 0` cases
  to `1`, rewrite the header comment's "what will change" section into a statement of the
  new rule, and add the nullable-key case it names.
- `packages/quereus/test/alter-primary-key-generated-ddl.spec.ts`: the synthesized-key case
  moves from `expectedClauses: 0` to `1`; update its explanatory comment (~40-46) too.
- Run `yarn build`, `yarn test`, `yarn lint`, `yarn test:store`. The store leg matters most
  here: it is the one that actually persists and re-parses the DDL this ticket changes.
