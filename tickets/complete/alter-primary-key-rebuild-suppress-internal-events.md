---
description: The engine sometimes has to rebuild a table behind the scenes to change its primary key. It used to tell watching applications that every existing row was freshly inserted and that the table had been dropped and replaced by a differently-named one; it now stays silent during that rebuild, because none of those things happened.
files:
  - packages/quereus/src/core/database-events.ts            # suppression counter + withPublicEventsSuppressed (~280, ~477-560)
  - packages/quereus/src/runtime/emit/alter-table.ts        # rebuildViaShadowTable suppression scope (~1770); rekeyBatchedDataEvents comment (~1551)
  - packages/quereus/test/alter-table-events.spec.ts        # final describe: rebuild is notification-silent (6 tests)
  - packages/quereus/test/database-events.spec.ts           # final describe: DatabaseEventEmitter.withPublicEventsSuppressed (9 tests)
  - packages/quereus/test/no-alter-module.ts                # shared backend shape that reaches the rebuild
  - docs/sql-ddl.md                                        # § ALTER PRIMARY KEY — "The rebuild is notification-silent"
  - docs/usage.md                                          # § Subscribing to Data Changes + § Subscribing to Schema Changes
  - docs/module-events.md                                  # § Engine-Internal Scaffolding Is Silent (added in review)
---

# What shipped

`alter table … alter primary key` asks the table's storage backend to re-key itself. A backend
that cannot do that gets the engine's generic fallback in `rebuildViaShadowTable`
(`runtime/emit/alter-table.ts`): create a shadow table with the new key, copy every row into it,
drop the original, rename the shadow over it. Because those are ordinary SQL statements, they
used to raise ordinary change notifications describing the engine's own scaffolding — an
`insert` for every row the copy moved (reported under the *real* table name, because the
trailing rename relabels batched events before they flush), plus a `create` of a machine-named
`t__rekey_<ms>` and a `drop` of the real table. A re-key changes no row and replaces no table,
so all of it was wrong.

One cause, one fix: the whole four-statement rebuild runs with the **public** notification
channels suppressed.

**`DatabaseEventEmitter.withPublicEventsSuppressed(fn)`** — an async scope backed by a nesting
counter (not a flag), `try`/`finally` so a throwing body restores it. While open:

- `needsDataEvents()` / `needsSchemaEvents()` both report `false`, so the engine's own producers
  (the three DML-executor gates, the schema manager's `emitAutoSchemaEventIfNeeded`) never build
  an event at all;
- any event that arrives anyway is **dropped with a `log()` line** at all four record
  chokepoints — `handleModuleDataEvent`, `handleModuleSchemaEvent`, `emitAutoDataEvent`,
  `emitAutoSchemaEvent`. The two `handleModule*` ones matter: a backend with its own event
  emitter reaches them without consulting a gate.

Suppressing the gates takes `onTransactionCommit` grouping down with it, which is correct — the
copy is not part of any batch an application should see.

**Deliberately NOT suppressed:** the internal catalog change notifier
(`db.schemaManager.getChangeNotifier().notifyChange`), which invalidates the optimizer's and the
write path's cached schemas — engine plumbing that must keep firing or those caches go stale
mid-statement. Nor the maintenance-collision channel (`queueCollision`), nor the transaction
layer's change capture (`_recordInsert` and friends).

**Docs:** `docs/sql-ddl.md` § ALTER PRIMARY KEY, `docs/usage.md` (both subscription sections),
and `docs/module-events.md` § Engine-Internal Scaffolding Is Silent all state plainly that a
subscriber gets *no* notification that the primary key changed on this path, and cross-reference
the missing positive `alter` event (every `ALTER TABLE` arm lacks one on the engine's own path —
tracked as `fix/bug-alter-table-emits-no-schema-event-without-native-module-emitter`).

# Review findings

## Checked

- **The implement diff, read first and in full** — source, tests, and docs, before the handoff
  summary.
- **Suppression coverage is complete.** Enumerated every path that reaches `dataListeners` /
  `schemaListeners`: the four write chokepoints (all gated) plus `flushBatch`. `flushBatch` is
  correctly *not* gated — it must still deliver events queued before the scope opened.
- **Closing the gates cannot skip anything but events.** Audited every caller of
  `needsDataEvents` / `needsSchemaEvents` (three sites in `runtime/emit/dml-executor.ts`, two in
  `schema/manager.ts`): all are pure event gates. No write, constraint check, materialized-view
  maintenance, or change capture hangs off them, so suppression cannot silently change what the
  rebuild actually does.
- **Change capture is deliberately outside the scope, and inert here.** The row copy still calls
  `_recordInsert`, keyed `main.t__rekey_<ms>`. No subscription exists for that name, so nothing
  matches it, and the transaction commits cleanly (whole suite green). Correct as-is: capture is
  the isolation/lens substrate, not an application-facing channel.
- **The "defensive no-op" claim about the retained `rekeyBatchedDataEvents` call holds.**
  `Database.exec` gives each statement its own implicit-transaction boundary
  (`_executeStatementBatch` → `_executeSingleStatement`), so even in a multi-statement
  `exec("insert …; alter … alter primary key …")` the insert commits and flushes before the
  ALTER runs. The batch really is provably empty; the comment is accurate and the call is kept.
- **Docs claim "both built-in modules re-key in place" is true.** The memory module implements
  `alterPrimaryKey` (`vtab/memory/layer/manager.ts:2348`, reached via `module.ts:973`); the
  store re-keys natively. Neither reaches the rebuild.
- **New test mutation-checked.** Neutering the suppression counter and re-running confirmed the
  added failure-path test discriminates.
- **Gates: `yarn lint` clean, `tsc -b tsconfig.build.json` clean, `yarn test` green (full
  workspace sweep, 7948 passing in `packages/quereus` plus every other package). `yarn docs:check`
  fails on a pre-existing breach unrelated to this ticket — see *Pre-existing failure* below.
  `yarn test:store` skipped: the store re-keys natively and never enters this path.**

## Found and fixed in this pass (minor)

- **`docs/module-events.md` was never updated, and one of its statements had become false.**
  It is the canonical event-system doc, and its § Event Semantics read *"Completeness: all
  successful mutations generate events (either native or auto)"* — the rebuild's row copy is now
  a successful mutation that generates none. Amended that bullet and added
  § Engine-Internal Scaffolding Is Silent, which is also the right home for the
  deferred-emitter guidance below (module authors read this file, not `runtime/emit/alter-table.ts`).
- **The four suppression checks disagreed on their predicate.** The gates tested
  `publicEventSuppressionDepth > 0`; the two drop helpers tested `=== 0`. An unbalanced
  increment/decrement would drive the depth negative, at which point the two read the state
  *oppositely* — gates open, every event dropped, permanently and silently. (Not hypothetical:
  this is exactly the pathology that surfaced while mutation-testing.) All four now go through
  `isPublicEventsSuppressed()`, which also gives that method a production caller instead of only
  test ones.
- **`origin: string`** on the two drop helpers narrowed to `type EventOrigin = 'module' | 'auto'`.
- **`withPublicEventsSuppressed`'s doc comment now says why global suppression is safe** — the
  handoff explicitly asked for an opinion here. Verdict: no runtime guard. Suppression being
  global rather than table-scoped is safe because `Database` serializes statements behind its
  execution mutex (`_withMutex`; `eval` holds it across the whole iteration), so a scope opened
  mid-statement cannot swallow a concurrent statement's events. A guard would have to distinguish
  engine-internal SQL from user SQL, which the emitter cannot see. The constraint on future
  callers — do engine-internal work only, never await user-visible work inside `fn` — is now
  stated at the definition.
- **Missing end-to-end failure-path coverage.** Added *"a rebuild that fails mid-copy stays
  silent and reopens the channels"*: seed a duplicate `b`, then `alter primary key (b)` so the
  copy raises partway through and the cleanup `drop table if exists` runs. Asserts silence on
  both channels, the original table and key untouched (statements 3 and 4 never ran), and — the
  real teeth — that a write afterwards is reported again, i.e. the scope's `finally` released on
  the throwing path.
- **Stale header comment** in `test/no-alter-module.ts` (listed two consuming specs; now three).

## Tripwires (recorded, not ticketed)

- **A backend whose own emitter defers delivery to its own commit can still leak the copy's
  inserts**, because its events arrive after the scope has closed. Genuinely conditional — no
  backend that reaches this rebuild behaves that way (memory and the store both re-key in place).
  Parked by the implementer as a `NOTE:` at the suppression site in `rebuildViaShadowTable`,
  naming the two possible fixes; the review added the module-author-facing half of it to
  `docs/module-events.md` § Engine-Internal Scaffolding Is Silent ("emit during the write, not
  at your own commit").
- **The failure path's silence comes from transaction rollback, not from suppression.** A failed
  rebuild's implicit transaction rolls back and `discardBatch` drops the partial copy's events
  regardless. Suppression is still correct there (cheaper, and independent of the rollback), but
  no test can distinguish the two — noted in the new test's comment so a future reader is not
  misled about what it pins.

## Found, already tracked elsewhere — no new ticket

- **No positive "the primary key changed" event replaces what was suppressed.** By design: the
  positive `alter` event is missing from *every* `ALTER TABLE` arm on the engine's own path, not
  just this one. Tracked as `fix/bug-alter-table-emits-no-schema-event-without-native-module-emitter`
  and documented in all three docs files rather than papered over with a one-off synthetic event.
- **`runtime/emit/alter-table.ts` is 2,155 lines.** Already tracked, by name and line count, in
  `backlog/debt-emit-source-files-too-large`.

## Explicitly empty

- **No major findings, so no new `fix/` or `plan/` tickets were filed.** The design is
  single-cause and the fix sits at the one chokepoint set that covers both reported symptoms;
  nothing surfaced that needed more than an inline correction.
- **No `blocked/` items.** Nothing here needed a human decision or an out-of-repo dependency.
- **No source-size finding beyond the tracked one.** `core/database-events.ts` grew to 1,279
  lines — below the ~1,800-line mark at which this project has previously filed a split ticket,
  and the file is still one coherent job (event aggregation, batching, savepoint layering).

## Pre-existing failure (not this ticket's)

`yarn docs:check` fails: `docs/schema.md` is 15,825 words against its ratchet of 15,679. That
doc is untouched by this ticket and unmodified in the tree; it was grown by
`af39b5b5 ticket(implement): bug-alter-primary-key-generated-ddl-keeps-old-key`, three commits
earlier, without the ratchet being reconciled. Recorded in `tickets/.pre-existing-error.md` for
the triage pass; not skipped, not worked around, and the ratchet was **not** silently raised
(`scripts/check-docs.mjs` refuses that without `--force`, correctly).
