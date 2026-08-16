---
description: A table that says what to do when two rows collide on their identity columns was forgetting that instruction whenever the database was saved and reopened; it is now written down, survives a real save-and-reopen, and is covered by tests that prove the behaviour rather than just the text.
files:
  - packages/quereus/src/schema/ddl-generator.ts (`pkConflictClause`; `generateTableDDLInternal`; `formatColumnDef`)
  - packages/quereus/test/table-ddl-round-trip.spec.ts (22 cases)
  - packages/quereus-store/test/pk-conflict-action-reopen.spec.ts (new — persist → reopen → duplicate write)
  - packages/quereus/src/schema/table.ts (`NOTE:` comments only — no behaviour change)
  - docs/schema.md (~315-321)
---

# What landed

The primary key's `ON CONFLICT` action is now emitted with the key in canonical
`CREATE TABLE` DDL, so it survives the save-and-reopen cycle `@quereus/store` performs
(regenerate the `CREATE TABLE` text into the catalog, re-parse it on reopen).

Before: `create table t (a integer, b text, primary key (a, b) on conflict replace)` emitted
`PRIMARY KEY ("a", "b")` with no action, so after a reopen a duplicate-key write raised
`UNIQUE constraint failed` instead of replacing the row.

## The implement stage

- `pkConflictClause` renders the ` ON CONFLICT <action>` tail; it is appended to whichever
  clause carries the key (inline column clause for a single-column key, table-level clause
  otherwise). `ABORT` is never emitted — every consumer resolves
  `statement OR ?? per-constraint ?? ABORT`, so a declared ABORT and an absent clause behave
  identically and emitting it would make two equivalent tables render differently.
- `packages/quereus/test/table-ddl-round-trip.spec.ts` — a fixed-point harness over the
  primary-key shapes: emit → re-parse → emit must reproduce the key, the per-column
  nullability, and byte-identical text.
- `docs/schema.md` and `NOTE:` markers on `TableSchema.synthesizedPrimaryKey` (read by the
  sibling `../lamina` repo — not dead code) and `isSynthesizedAllColumnsKey`.

The ticket's *original* scope (retiring the synthesized-vs-declared primary-key
distinction) did not land; it stays in `tickets/implement/` behind its prerequisite chain.
The `ON CONFLICT` bug was found while building its test harness.

## The review stage

- **Fixed:** the emitter resolved the action from the raw `TableSchema.primaryKeyDefaultConflict`
  field, so an action declared on a key *column* never reached the table-level clause.
  It now resolves through `resolvePkDefaultConflict` (the in-package source of truth), which
  also made the inline branch's hand-written fallback redundant — one resolution site
  instead of two divergent ones.
- **Added:** `packages/quereus-store/test/pk-conflict-action-reopen.spec.ts` — the
  end-to-end proof the implement stage flagged as missing.
- **Added:** the round-trip harness now asserts the *conflict action* across the round-trip,
  in both directions (live and post-round-trip), plus behaviour cases that actually write a
  colliding row.

# Review findings

## Checked and clean

- **Fixed-point property.** Every shape in the harness emits → re-parses → re-emits
  byte-identically, including the shapes the review added. No shape converges after N
  reopens rather than one.
- **`PRIMARY KEY ()` singleton with an action.** `PRIMARY KEY () ON CONFLICT REPLACE`
  parses and round-trips; verified, and pinned as a harness case (it was previously
  untested — the emitter appends the tail on that branch too).
- **Casing.** The new clause emits uppercase while the constraint fragment on the same line
  emits lowercase. Nothing compares generated DDL case-sensitively: the only text-equality
  consumers compare *two generated strings*, and generation is deterministic, so both sides
  agree. Not a defect; left as is.
- **Maintained-table / materialized-view backing DDL.** Shares `generateTableDDLInternal`;
  the full suite and the store leg pass.
- **The handoff's "no `.sqllogic` coverage" gap is not real.**
  `packages/quereus/test/logic/29.1-column-level-conflict-clause.sqllogic` and
  `29.2-table-level-pk-conflict-clause.sqllogic` already cover `on conflict` behaviour on a
  primary key. What sqllogic cannot do is *reopen* a database, which is exactly the leg the
  new store spec adds. No sqllogic case was written.

## Fixed in this pass

- **A key column's `ON CONFLICT` never reached the table-level clause.**
  `create table t (a integer not null on conflict replace, b text, c text, primary key (a, b))`
  has an effective PK action of REPLACE (`resolvePkDefaultConflict` reads a key column's own
  action when no table-level one is set), but the emitter read only
  `primaryKeyDefaultConflict` — so the table came back as ABORT after a reopen, the same
  defect the ticket set out to fix, one spelling over. The emitter now resolves through
  `resolvePkDefaultConflict`, and the inline branch's separate column fallback is deleted
  (it was a second, narrower copy of the same precedence rule). The loss was **stable** —
  identical on the second emission — which is why the fixed-point assertion could not see
  it; the harness now asserts the action explicitly.

- **Test coverage: the schema was asserted, the behaviour was not.**
  `packages/quereus-store/test/pk-conflict-action-reopen.spec.ts` persists a REPLACE-keyed
  table through a real `StoreModule` catalog write, reopens over the same provider with a
  fresh `Database`, and writes a colliding row. Both declaration spellings are covered.
  Verified as a genuine regression guard: with the `ON CONFLICT` emission disabled and the
  package rebuilt, both cases fail with `ConstraintError: UNIQUE constraint failed: pk_oc PK`.
  The round-trip harness gained the same behaviour check for the memory backend, plus a
  `conflictSpelling` assertion leg on every shape.

## Filed / carried forward

- **An all-columns key with a column-declared action still loses it.**
  `create table t (a integer primary key on conflict replace)` and
  `create table t (a integer not null on conflict replace, b text, primary key (a, b))` emit
  no `PRIMARY KEY` clause at all (the synthesized-key omission), so the action has nowhere
  to ride and reverts to ABORT on reopen. **Not filed as a new ticket** — it resolves at the
  site `tickets/implement/3-debt-retire-synthesized-primary-key-distinction` already owns, so
  it was appended there as an arm (with the reason a narrow guard fix is *wrong*: widening
  the shape guard would emit a clause for a genuinely synthesized key and reintroduce that
  ticket's blocker-1 nullability regression). Pinned in the meantime by two
  `expectedConflictAfterRoundTrip: '(none)'` harness cases and a `NOTE:` at
  `isSynthesizedAllColumnsKey`, whose doc comment previously overclaimed that the guard kept
  *all* `on conflict` keys on the declared path.

- **`tickets/backlog/bug-non-key-column-conflict-action-dropped-from-ddl` corrected.** It
  asserted that a *key* column's action now always has somewhere to ride; the carve-out
  above makes that false. Amended in place rather than re-filed.

- **`packages/quereus/src/schema/table.ts` is 1,751 lines** (`wc -l`, 2026-08-16). Appended
  as an arm to the existing `tickets/backlog/debt-oversized-source-files` theme ticket
  rather than filed fresh, per the site-claim rule.

## Tripwires (recorded in code, not filed)

- **`ALTER TABLE … ALTER PRIMARY KEY` moves a table-level action onto the new key but drops
  a column-declared one.** A table-level action lives on `TableSchema`, so it survives the
  re-key and now governs a key the author never attached it to; a column-declared action
  lives on the old key column, which stops being part of the key. `ALTER PRIMARY KEY` has no
  `ON CONFLICT` clause of its own, so neither can be restated at ALTER time. Emitted DDL is
  faithful to whichever the schema ends up holding — so this is an ALTER-semantics question,
  not a DDL one, and it is not obviously wrong either way. Parked as a `NOTE:` on
  `rekeySchemaPrimaryKey` (`packages/quereus/src/schema/table.ts`) with the revisit
  condition: `ALTER PRIMARY KEY` gains its own conflict clause, or the two spellings are
  expected to be interchangeable across an ALTER.

## Considered and declined

- None encountered — no accepted-tradeoff `NOTE:` sits at any site this change touches.

# Verification

```
yarn build      # clean
yarn lint       # clean
yarn typecheck  # clean
yarn test       # all workspaces pass
yarn test:store # 9615 passing / 33 pending (was 9609 / 33)
```

No pre-existing failures surfaced; `tickets/.pre-existing-error.md` was not written.
