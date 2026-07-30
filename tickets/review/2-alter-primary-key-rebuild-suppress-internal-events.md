---
description: The engine sometimes has to rebuild a table behind the scenes to change its primary key; it used to tell watching applications that every existing row was freshly inserted and that the table had been dropped and replaced by a differently-named one. It now stays silent during that rebuild, because none of those things happened.
files:
  - packages/quereus/src/core/database-events.ts            # suppression counter + withPublicEventsSuppressed (~313, ~465-560)
  - packages/quereus/src/runtime/emit/alter-table.ts        # rebuildViaShadowTable suppression scope (~1770); rekeyBatchedDataEvents re-comment (~1551)
  - packages/quereus/test/database-events.spec.ts           # new describe: DatabaseEventEmitter.withPublicEventsSuppressed (end of file)
  - packages/quereus/test/alter-table-events.spec.ts        # new top-level describe: rebuild is notification-silent (end of file)
  - docs/sql-ddl.md                                        # § ALTER PRIMARY KEY — "The rebuild is notification-silent" paragraph
  - docs/usage.md                                          # § Subscribing to Data Changes + § Subscribing to Schema Changes
difficulty: medium
---

# What was wrong

`alter table … alter primary key` normally asks the table's storage backend to re-key itself.
A backend that cannot do that gets the engine's generic fallback in
`rebuildViaShadowTable` (`runtime/emit/alter-table.ts`), which runs four ordinary SQL
statements: create a shadow table with the new key, copy every row into it, drop the original,
rename the shadow over it.

Because they were ordinary statements, they raised ordinary change notifications describing
the engine's own scaffolding:

- an `insert` event for every row the copy moved — reported under the *real* table name,
  because the trailing rename relabels the batched events before they flush. A re-key changes
  no row, so a listener replicating or caching rows concluded a row had been created.
- a `create` of a machine-named `t__rekey_<ms>` plus a `drop` of the real table. Worse than the
  first: a catalog mirror (persisted-catalog writer, schema replicator, UI table list) recorded
  a table under a timestamped name that is not even stable across runs, and forgot the real one.

# What changed

One cause, one fix: the whole four-statement rebuild now runs with the **public** notification
channels suppressed.

**`DatabaseEventEmitter.withPublicEventsSuppressed(fn)`** (`core/database-events.ts`) — an
async scope backed by a nesting **counter** (not a flag), `try`/`finally` so a throwing body
restores it. While open:

- `needsDataEvents()` / `needsSchemaEvents()` both report `false`, so the engine's own
  producers (the three DML-executor gates, the schema manager's `emitAutoSchemaEventIfNeeded`)
  never build an event at all;
- any event that arrives anyway is **dropped with a `log()` line** at all four record
  chokepoints — `handleModuleDataEvent`, `handleModuleSchemaEvent`, `emitAutoDataEvent`,
  `emitAutoSchemaEvent`. The two `handleModule*` ones matter: a backend with its own event
  emitter reaches them without consulting a gate.

Suppressing the gates also takes `onTransactionCommit` grouping down with it, which is
correct — the copy is not part of any batch an application should see.

**Deliberately NOT suppressed:** the internal catalog change notifier
(`db.schemaManager.getChangeNotifier().notifyChange`), which invalidates the optimizer's and
the write path's cached schemas. That is engine plumbing; the shadow table's create/drop/rename
must keep firing it or those caches go stale mid-statement. The maintenance-collision channel
(`queueCollision`) is untouched too — nothing in a suppressed scope writes through
materialized-view maintenance.

**`rebuildViaShadowTable`** wraps its entire body — all four statements plus the existing
failure-cleanup `catch` that drops the shadow table — in the scope. Suppressing only the copy
would still have leaked the create/drop pair, and a shadow table nobody was told about must not
announce its own drop either.

**`rekeyBatchedDataEvents` after the rebuild** (`alter-table.ts` ~1551) is **kept**, and its
comment now says what it actually is on this path: a defensive no-op. Nothing can be in the
batch for the table by then (the rebuild's events are suppressed, the ALTER writes no rows of
its own, and the sibling ticket's guard refuses the rebuild inside an explicit transaction). It
is cheap, and it is the correct call the moment that transaction guard is loosened.

**Docs:** `docs/sql-ddl.md` § ALTER PRIMARY KEY gains a "The rebuild is notification-silent"
paragraph, stating plainly that a subscriber gets *no* notification that the primary key
changed on this path, and cross-referencing the missing positive `alter` event (every
`ALTER TABLE` arm lacks one on the engine's own path — tracked as
`fix/bug-alter-table-emits-no-schema-event-without-native-module-emitter`). `docs/usage.md`
says the same in both its data-change and schema-change subscription sections.

# Verification and use cases

The backend shape needed to reach the rebuild is `makeNoAlterModule({ withRenameTable: true })`
(`packages/quereus/test/no-alter-module.ts`, already shared): no `alterTable` hook (so it cannot
re-key in place), `renameTable` present (the rebuild's closing rename requires it). Plain
autocommit — the sibling ticket refuses the explicit-transaction case.

**Both original reproductions were confirmed against these tests.** Neutering the counter
increment made the data-events test fail with exactly the ticket's reported event
(`insert` on `t`, `key: [5, 5]`, `newRow: [5, 5, 'pre']`, `moduleName: 'noalter'`); restored and
re-run green.

`packages/quereus/test/alter-table-events.spec.ts`, new top-level describe **"ALTER PRIMARY KEY
via shadow-table rebuild: the rebuild is notification-silent"** (5 tests) — seed
`t (a, b, v) primary key (a)` with one committed row, then `alter primary key (a, b)`:

- zero data-change events;
- zero schema-change events, and nothing naming `__rekey_`;
- nothing on `onTransactionCommit`;
- the work still happened: PK is `(a, b)`, the seeded row is reachable by a point lookup on the
  new key (which is also the proof the internal notifier was left alone — a stale cached schema
  would still plan against the retired key), row count unchanged. Runs with **both** channels
  subscribed, i.e. the state that opens the gates the scope closes;
- a write *after* the rebuild is reported normally, under the new key — the scope does not leak
  past its statement.

`packages/quereus/test/database-events.spec.ts`, new top-level describe
**"DatabaseEventEmitter.withPublicEventsSuppressed"** (9 tests) — the counter's own mechanics:
gates closed inside / reopened after; events arriving anyway are dropped and delivered again
once closed; dropped rather than batched (a `flushBatch` after the scope emits nothing); nesting
(inner exit does not reopen); restoration after a throw, including a throw in a nested scope
with the outer intact; body return value passed through; `onTransactionCommit` groups nothing;
and — the case the gates cannot cover — events forwarded from a hooked module emitter
(`DefaultVTableEventEmitter` + `hookModuleEmitter`) are dropped too.

Pre-existing coverage that still passes and is worth re-reading during review:
`alter-table-conformance.spec.ts` ~614 (`alterPrimaryKey → honored via engine-side shadow
rebuild, flags consistent`) exercises the same rebuild with *no* listener subscribed;
`alter-primary-key-in-transaction.spec.ts` covers the sibling ticket's two refusals;
`packages/quereus-store/test/alter-events.spec.ts` remains the primary home for ALTER PRIMARY
KEY event coverage (the store re-keys in place and never reaches the rebuild).

Commands run: `yarn build` (clean), `yarn test` (full workspace sweep, green, 3m52s),
`yarn lint` (clean). `yarn test:store` deliberately skipped — the store re-keys natively and
never enters this path.

# Known gaps / things to look at

- **Deferred module-emitter residue (recorded as a `NOTE:`, not a ticket).** A backend whose
  *own* emitter defers delivery to its own commit — rather than emitting during the write — can
  still leak the copy's inserts, because its events arrive after the suppression scope has
  closed. No backend that reaches this rebuild behaves that way today (memory and the store both
  re-key in place and never enter it), so this is conditional. Parked as a `NOTE:` at the
  suppression site in `rebuildViaShadowTable`, naming the two possible fixes (name-keyed
  suppression covering the shadow name, or dropping the events out of the batch after the fact).
- **Suppression is global, not table-scoped.** While the scope is open, an event on *any* table
  from *any* source is dropped. Harmless as used — the scope spans only the four synchronous
  internal statements and nothing else runs concurrently in a single-threaded engine — but a
  future caller that holds the scope across genuinely user-visible work would silently swallow
  the user's own events. Worth an opinion on whether the helper should refuse to be held across
  anything but engine-internal SQL, or whether the doc comment ("For engine-internal
  scaffolding the application never issued. Sole caller today: …") is warning enough.
- **No positive event replaces what was suppressed.** By design (see the ticket's *Consequence
  to state in the docs*): a subscriber now learns nothing about a re-key on this path. Documented
  in both docs files rather than fixed here, because the positive `alter` event is missing from
  every `ALTER TABLE` arm, not just this one.
- **The kept `rekeyBatchedDataEvents` call is now untested-by-construction** on the rebuild
  path: with the batch provably empty, no test can distinguish keeping it from deleting it. It
  is retained for the guard-loosening case and commented as such. If a reviewer prefers dead
  code deleted over defensive code kept, that is the call to make.
- **Only `alterPrimaryKey`'s rebuild is suppressed.** `rebuildTableWithNewShape` /
  `buildShadowTableDdl` accept a `survivingColumns` projection, so the same machinery could in
  principle serve other rebuild-style ALTERs; nothing else calls it today, and the suppression
  sits at `rebuildViaShadowTable`, so any future caller inherits it.
