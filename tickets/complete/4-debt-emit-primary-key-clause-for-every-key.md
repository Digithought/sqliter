---
description: The engine used to leave a table's identity columns unwritten when the author never named them, which quietly lost a "what to do on a duplicate row" setting. It now always writes them out.
files:
  - packages/quereus/src/schema/ddl-generator.ts (both `!synthesizedKey &&` guards removed; `isSynthesizedAllColumnsKey` import gone)
  - packages/quereus/src/schema/table.ts (`isSynthesizedAllColumnsKey` deleted; `TableSchema.synthesizedPrimaryKey` doc rewritten, then extended in review; `findPKDefinition`'s closing comment rewritten)
  - packages/quereus/test/table-ddl-round-trip.spec.ts (18 shapes; `expectedConflictAfterRoundTrip` deleted, `expectedNullability` added, `expectedClauses` removed in review)
  - packages/quereus/test/no-pk-nullability.spec.ts (three DDL assertions flipped to positive)
  - packages/quereus/test/alter-primary-key-generated-ddl.spec.ts (all-columns case now emits a clause; `expectedClauses` removed in review)
  - packages/quereus-store/test/pk-conflict-action-reopen.spec.ts (two all-columns-key reopen cases added in review)
  - docs/schema.md (omission paragraph replaced; "two gaps" → one gap; fixed point now unconditional)
difficulty: medium
---

# Every primary key emits its `PRIMARY KEY` clause

## What shipped

Canonical `CREATE TABLE` DDL now names **every** primary key, with no exception —
including the all-columns key a table gets when it declares no `PRIMARY KEY`. Inline on
the column when the key is one column, table-level otherwise, exactly like a declared key.

The omission existed only because a declared `PRIMARY KEY` used to promote its columns to
`NOT NULL` while a synthesized one did not, so naming the key would have silently tightened
a nullable column on every persistence round-trip. `feat-relax-declared-primary-key-not-null`
removed that promotion, so the two spellings are one key and the omission had nothing left
to justify it.

**It also fixed a live bug.** The old guard bailed out only on a *table-level*
`primary key (...) on conflict X`. An action declared on a key *column* left the guard
matching, so these two shapes emitted no clause and their action had nowhere to ride:

```sql
create table t (a integer primary key on conflict replace);
create table t (a integer not null on conflict replace, b text, primary key (a, b));
```

Both came back `ABORT` after a reopen and started throwing on a duplicate-key write. The
loss was stable, so the round-trip harness's fixed-point assertion could not see it.

Deleted: `isSynthesizedAllColumnsKey` and both `!synthesizedKey &&` guards.
`TableSchema.synthesizedPrimaryKey` and `findPKDefinition`'s `synthesized` return member
stay — the sibling `../lamina` repo reads the flag and its retirement needs cross-repo
sequencing (`tickets/blocked/debt-retire-quereus-synthesized-primary-key-flag.md`).

## Validation

From repo root, after the review pass, all green:

| command | result |
|---|---|
| `yarn build` | clean |
| `yarn lint` | clean |
| `yarn typecheck` | clean |
| `yarn test` | all workspaces pass — quereus **9637 passing** / 25 pending, store **1804**, sync 725, plugin-loader 119, quoomb-cli 64, quoomb-web 68, others green |

`yarn test:store` was **not** re-run in review, deliberately. It re-runs the `.sqllogic`
logic tests against LevelDB; neither the implement pass nor this review changed a
`.sqllogic` file, and the specs that exercise this change are Mocha specs `test:store` does
not execute. The implement pass ran it green over the same source change.

## Review findings

### Checked and clean

- **The emitter itself.** Both guards are gone and no third branch was left conditional.
  The empty-key singleton (`PRIMARY KEY ()`) still has its own path; the composite branch
  is `length > 1`, so nothing can render an empty column list.
- **Maintained tables / materialized views** — the implement handoff listed this as an
  unasserted gap. Probed directly: an MV whose backing key spans all its columns
  (`group by v`, `select distinct v`) emits an inline `PRIMARY KEY`, re-parses to the same
  key, and its second emission is byte-identical. No defect; no ticket.
- **Other DDL-comparing consumers.** `quereus-store`'s catalog compare-write
  (`persistTableCatalogEntryIfChanged`) rewrites an old clause-free entry on the next
  change, which is a correct in-place upgrade. `quereus-sync`'s `decideSchemaChange`
  regenerates both sides from live schemas, so same-version peers agree; mixed-version
  peers would not, which is the project's stated no-backwards-compat position.
- **Stale references to the deleted predicate** — one leftover mention in a test comment
  (fixed below); nothing else in `src/`, `test/` or `docs/` names it.
- **Docs.** `docs/schema.md` reflects the new rule. `docs/sql-constraints.md:17` already
  said the synthesized key is exact syntactic sugar for the declared one, which is now
  literally true of the emitted text too. No other doc claimed the clause was omitted.

### Found and fixed in this pass (minor)

- **`TableSchema.synthesizedPrimaryKey` no longer survives a round-trip, and its doc did
  not say so.** Verified: `create table t (a integer, b text)` → flag `true`; emit canonical
  DDL, re-parse in a fresh database → flag `false`. That follows from the change (the DDL
  now names the key) and is the intended reading, but the doc block — rewritten by this very
  commit to call the flag "the ONLY sound answer" — left a reader to discover it. Added a
  paragraph stating it plainly.
- **Stale comment** in `test/table-ddl-round-trip.spec.ts` still cited the deleted
  `isSynthesizedAllColumnsKey` to explain the empty-key case. Rewritten to say what actually
  holds the case in place.
- **`expectedClauses` became a constant.** After the change every case in both
  `table-ddl-round-trip.spec.ts` (18) and `alter-primary-key-generated-ddl.spec.ts` (7)
  carried `expectedClauses: 1`. Removed the field from both and assert `1` unconditionally,
  with the "two would mean an inline plus a table-level clause" rationale moved to the
  assertion site.

### Found and fixed in this pass (test coverage)

- **The live bug had no coverage through the real persistence path.**
  `packages/quereus-store/test/pk-conflict-action-reopen.spec.ts` covered only *narrow* keys
  (`primary key (a)` on a two-column table) — neither of the two all-columns shapes that
  actually lost their action. The implement pass's regression test for them is an in-memory
  Mocha test, but the bug manifested for users through store catalog write → reopen →
  re-parse. Added both shapes there (the whole row is the key, so the colliding row is
  identical rather than merely sharing `a`).

### Found and filed (major)

- **`tickets/backlog/bug-shadow-rebuild-loses-table-definition.md`** — the engine has a
  *second*, hand-rolled DDL emitter, `buildShadowTableDdl` in
  `src/runtime/emit/alter-table.ts`, used when `ALTER PRIMARY KEY` falls back to rebuilding
  the table. It renders only columns, the key and `using`. Verified by running it: a rebuild
  silently drops the table's `CHECK`, `UNIQUE`, tags and the key's `ON CONFLICT`; and an
  empty new key emits **no** clause, which re-parses as the all-columns key — so
  `alter primary key ()` rebuilds with key `(a, b)` instead of `()`. This is the same class
  the ticket just retired in the canonical emitter, at the one site the change did not reach,
  so it is filed at the root cause (a second emitter that renders a subset) rather than as
  two symptoms. Unreachable on the shipped backends (memory and store both re-key in place);
  needs a third-party backend that declines in-place re-key. `repro: verified`.

### Recorded as tripwires

None. Every concern found was either fixed here or filed; nothing was of the "fine now, only
matters if X later" shape.

### Considered and declined

- **Pinning the `synthesizedPrimaryKey` flip with a test.** The flag has no in-repo reader
  and is queued for deletion; a test asserting the flip would cement behaviour nobody wants
  to keep. Documented at the field and appended to the blocked retirement ticket instead —
  the fact that the flag already stops being true on reopen is material to the human's
  cross-repo sequencing decision, and that ticket is where that decision gets made.
- **Legacy-catalog rehydration** (DDL written before this change, carrying no clause). Not
  given its own case: the import path for such text is the ordinary no-PK synthesis path,
  which every `create table t (a integer, b text)` shape in the harness already exercises.
