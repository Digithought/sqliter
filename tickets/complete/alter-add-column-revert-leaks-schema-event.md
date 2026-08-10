---
description: A failed ALTER TABLE used to still tell listeners (and synced peer devices) that the change happened. It now announces nothing, on every storage backend.
files:
  - packages/quereus/src/core/database-events.ts                   # seq stamp + beginSchemaEventScope/discardSchemaEventsSince
  - packages/quereus/src/runtime/emit/alter-schema-event.ts        # withStatementScopedSchemaEvents
  - packages/quereus/src/runtime/emit/alter-table.ts               # emitAlterTable.run() wraps the arm dispatch
  - packages/quereus/src/runtime/emit/add-constraint.ts            # module-routed arm wrapped at its call site
  - packages/quereus/test/alter-table-schema-events.spec.ts        # 6 cases (3 per describe)
  - packages/quereus/test/database-events.spec.ts                  # 9 emitter-level scope/retraction cases (review)
  - packages/quereus-store/test/alter-events.spec.ts               # 3 cases
  - docs/usage.md                                                  # § What each ALTER TABLE arm reports
  - docs/module-events.md                                          # § A failed ALTER announces nothing, even from a native emitter (review)
---

# A failed `ALTER TABLE` announces nothing, on every backend

## What was wrong

A storage backend that raises its own change events emits from **inside** `module.alterTable`.
That call is not the end of the statement: for `add column c integer default 5 unique` the
engine still has to install the inline constraint through further module calls, and a failure
there unwinds the column — by which point the announcement, carrying the statement's SQL, is
already in the transaction's batched-event list. On a syncing database another device executed
that SQL and really did add the column, so the two devices diverged. Backends without their own
emitter were already correct: the engine emits at each arm's tail, past any throw.

## What shipped

`DatabaseEventEmitter` stamps every batched schema event with a lifetime-monotonic sequence
number and exposes a mark/discard pair over it — `beginSchemaEventScope()` returns a watermark,
`discardSchemaEventsSince(watermark)` drops every batched schema event stamped at or after it,
walking the base batch and every open savepoint layer. Both push sites (module emitters and the
engine's own auto path) route through one private `pushSchemaEvent`, so no event enters
unstamped.

`withStatementScopedSchemaEvents` (in `runtime/emit/alter-schema-event.ts`, beside
`emitAlterSchemaEvent`, so both halves of "one event per statement, success path only" live
together) wraps the whole arm dispatch in `emitAlterTable`'s `run()` and the module-routed
`ALTER TABLE ADD CONSTRAINT` arm. Data events are deliberately NOT retracted: the store flushes
the transaction's earlier buffered writes into the batch during an ALTER, so retracting them
would swallow previous statements' committed work.

Docs: `docs/usage.md` lost its "one known exception" clause; `docs/module-events.md` gained the
module-author-facing rule.

## Review findings

Ran (all from repo root): `yarn build` clean · `yarn lint` clean (the real lint is
`packages/quereus`, which also type-checks the spec call sites) · `yarn test` — 8630 + 376 + 113
+ 63 + 17 + 28 + 1362 + 719 + 85 + 31 + 119 + 59 + 68 + 34 + 134 + 22 passing, **0 failing**, 13
pending · `yarn test:store` — 8622 passing, 0 failing, 21 pending · `yarn docs:check` — 2
failures, both pre-existing and already tracked (see below).

**Mechanism re-derived from the diff, independent of the handoff.** Confirmed the retraction is
sound where it matters: the store emits its schema event synchronously from inside `alterTable`
(`store-module-alter.ts:127`), so it is in the batch before the catch runs; `releaseSavepointLayer`
moves the event objects themselves between arrays, so the per-event stamp survives a mid-statement
savepoint release where a remembered array length would not; and `flushBatch` builds the
`onTransactionCommit` batch — the channel sync actually consumes — from the same arrays the
discard walks, so a retracted event is absent there too.

**Gaps the implementer flagged, now closed by tests.** Added a `DatabaseEventEmitter schema-event
scopes` describe (9 cases) to `packages/quereus/test/database-events.spec.ts` covering the
mechanics no SQL-level test can reach: events batched before the mark survive; data events are
untouched; the discard reaches an event batched into a savepoint layer opened after the mark, one
a RELEASE already merged into the base batch, and none that a ROLLBACK TO SAVEPOINT already
removed; nested scopes retract only the inner one; the no-batch case is a no-op; a module
emitter's event is retracted like the engine's own. **Verified non-vacuous** by neutering
`discardSchemaEventsSince` and re-running: 11 failures (8 of the 9 new emitter cases plus the 3
emitter-backed ALTER cases); restored and re-ran green.

**Found and filed — a leak of the same class outside ALTER (major).** `create table … maintained
as <select>` on an emitter-backed module creates the backing table (announcing it), fails while
filling it from the body, and announces the teardown drop — so a statement that never created
anything delivers a `create` and a `drop`, both carrying re-executable SQL. Verified by running
it, not inferred. The pair self-cancels on a well-behaved peer, which is why it is filed rather
than fixed here: the right fix is a design call about whether the statement-scoped wrapper should
move up to cover every DDL statement boundary. Filed as
`backlog/bug-failed-maintained-create-announces-create-and-drop` (`repro: verified`); a pointer
sits in `withStatementScopedSchemaEvents`'s doc comment. Probed alongside it: a plain `create
table` that fails does so before the module call and announces nothing.

**Corrected an inaccurate claim in the new code's own comment (minor, fixed inline).** The
`schemaEventSeq` doc said a never-reset counter means a stale watermark "can never match a later
transaction's events". Monotonicity gives the opposite: a stale (lower) watermark matches
*everything* after it, since the predicate is `seq >= watermark`. What the counter actually buys
is that an event batched *before* a scope can never be mistaken for one inside it. Reworded, and
the comment now says why the single caller spends its watermark inside one try/catch and never
stores it. No behaviour change — the property the code relies on holds either way.

**Simplification (minor, fixed inline).** `add-constraint.ts` had gained a wrapper function whose
only body was `withStatementScopedSchemaEvents(...)` around a twin with the same five-parameter
signature. Collapsed to one function wrapped at its call site, with the rationale comment there.
Also replaced the file's two inline `import('../../schema/schema.js').Schema` parameter types with
a top-level `import type` (AGENTS.md forbids inline `import()` outside dynamic loads) — those two
were pre-existing, in a file this change touched.

**Docs (minor, fixed inline).** The change had updated `docs/usage.md` only.
`docs/module-events.md` is the module-author-facing contract for this channel and still implied
the success-path-only rule was the auto path's alone; it now documents that the engine retracts an
ALTER's batched schema events on failure so a native emitter needs no logic of its own.

**Tripwires parked, not filed.** (a) The retraction reaches only events already handed to the
engine — a hypothetical module that queues its *schema* events until commit would be past the
scope; no such module exists (store and memory both emit synchronously), recorded as a paragraph
in `docs/module-events.md` since it has no single code site. (b) The implementer's two existing
`NOTE:`s stand and were checked: the per-event splice is O(N × batch size) and one ALTER batches a
handful; nothing nests the scopes today. (c) `runAddCheckEngineSide` is deliberately unscoped —
premise verified: it is reached only when the module has no `alterTable` hook at all, and such a
backend ships no emitter.

**Checked and clean, explicitly.** Success-path event shapes are unchanged (the existing per-arm
assertions on both backends still pass untouched — that was the acceptance criterion most likely
to break). `discardSchemaEventsSince` has no other call sites. No non-ALTER arm of the emit layer
reaches the schema channel outside a scope except the create path filed above. The pre-existing
`yarn docs:check` failures (`docs/schema.md`, `docs/sync.md` over their word ratchets) are listed
in `tickets/.pre-existing-known.md` against `debt-docs-size-ratchet-red-again` — not re-reported;
`docs/module-events.md`'s own ratchet has room and my addition stays inside it.

**Not fixed, deliberately.** `packages/quereus/src/runtime/emit/alter-table.ts` is 2,419 lines
(`wc -l`) — the arm-dispatch wrap added indentation, not concerns. The split is already claimed by
`backlog/debt-emit-source-files-too-large`; I re-measured both files it names and updated its stale
counts (2,155 → 2,419 and 3,093 → 3,107) rather than filing a duplicate. The store module's
divergent per-arm event shape stays out of scope under its own ticket,
`backlog/bug-store-schema-event-shape-diverges`; the new store tests assert zero events, so they
are indifferent to which shape wins.
