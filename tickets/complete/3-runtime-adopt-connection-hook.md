description: The query runtime no longer special-cases the built-in in-memory table type when handing an existing shared connection to a freshly-connected table; instead it offers the connection through a neutral hook any storage plugin can implement, so third-party tables get the same connection reuse.
prereq:
files: packages/quereus/src/runtime/utils.ts, packages/quereus/src/vtab/table.ts, packages/quereus/src/vtab/memory/table.ts, packages/quereus/test/vtab/adopt-connection.spec.ts, docs/module-authoring.md
difficulty: medium
----

## What shipped

Replaced the `vtabModuleName === 'memory'` branch in `getVTable` (`runtime/utils.ts`)
with a module-neutral optional hook on `VirtualTable`:

```typescript
adoptConnection?(connection: VirtualTableConnection): MaybePromise<void>;
```

The runtime offers an already-registered connection (`existingConnections[0]`) to a
freshly-connected instance; the module owns the accept/reject decision (subtype +
backing-state match), ownership is not transferred, and the hook must be idempotent.
Memory implements it in `MemoryTable.adoptConnection`, reproducing the old runtime guard
exactly (`instanceof MemoryVirtualTableConnection` + `tableManager === this.manager` →
`setConnection`). Docs updated in `module-authoring.md` § Connection Registration.

Review added a focused unit spec (see findings) — otherwise the implementation landed
as described in the implement handoff.

## Review findings

**Checked** — read the full implement diff (`5d456ce4`) with fresh eyes before the
handoff, plus the surrounding files (`runtime/utils.ts` full, `memory/table.ts` incl.
`ensureConnection`/`setConnection`/`getConnection`, `memory/module.ts` connect path,
`memory/connection.ts`, `vtab/table.ts`). Angles: behavior parity, type safety, resource
cleanup/ownership, error handling, docs currency, dead-reference sweep, test coverage.

- **Behavior parity — CONFIRMED.** New memory `adoptConnection` runs the identical guard
  the old runtime branch did (`getMemoryConnection()` + `tableManager === manager` →
  `setConnection`, else skip+log). The `instanceof` guard is strictly stronger than the
  old duck-typed truthy checks. Removing the `=== 'memory'` string gate does not change
  the affected table set: only memory implements the hook, so non-memory tables hit the
  optional-chain no-op — exactly the old "branch never fired" behavior.
- **`readCommitted` parity — CONFIRMED.** `getVTable` can build a committed-snapshot
  instance (`module.connect` → `_readCommitted`), and `adoptConnection` fires on it
  unconditionally — but the *old* branch also called `setConnection` unconditionally on
  memory instances. No new `readCommitted` guard was needed or added; parity kept.
  `test/logic/42-committed-snapshot.sqllogic` stays green.
- **Type safety / async — CONFIRMED clean.** `MaybePromise<void>` return, runtime
  `await`s the optional chain (`await undefined` when absent is safe). `MaybePromise`
  already imported in `table.ts`. Build + lint (incl. `tsc -p tsconfig.test.json`) clean.
- **Ownership / cleanup — CONFIRMED.** Adopt does not transfer ownership; connection stays
  in the DB registry. Idempotency holds — `setConnection` is a plain field assignment,
  `getConnection` rebuilds its cached wrapper when the underlying connection changes.
- **Docs — CONFIRMED current.** `module-authoring.md` gained the `adoptConnection`
  subsection (push-vs-pull, contract, ownership, idempotency). Grep for stale
  memory-injection references: only `docs/review.html:232` mentions the old
  `=== 'memory'` special-case — that is the historical review *report* that proposed this
  very fix (a snapshot artifact, not living docs), left untouched by design.

**Found + fixed inline (minor):**

- **Missing focused unit coverage** for `adoptConnection` — the implement handoff flagged
  this as a known gap (coverage was only transitive through the logic suite). Added
  `packages/quereus/test/vtab/adopt-connection.spec.ts` (3 cases) asserting the three
  contract points directly: (a) foreign non-memory connection rejected as a no-op,
  (b) manager-mismatch connection skipped, (c) matching connection adopted idempotently
  (adopt twice → same underlying memory connection, no throw). The idempotency assertion
  is the property the future `runtime-prepared-statement-overhead` (NLJ inner-loop reuse)
  work will lean on.

**Major (new tickets):** none.

**Tripwires (parked, not tickets):**

- Multiple registered connections at the adopt call site — `getVTable` adopts
  `existingConnections[0]`. Parked by the implementer as a `// NOTE:` at
  `runtime/utils.ts:139-141` (prefer the covering connection if covering-connection
  semantics ever matter). Confirmed still accurate; fine now — no in-tree path registers
  multiple connections under one qualified name where `[0]` is the wrong pick.

**Left as-is (pre-existing, outside this diff):**

- `runtime/utils.ts` `disconnectVTable(ctx, …)` `ctx` unused, and `memory/table.ts`
  `rename` `await` on `manager.renameTable` — both hint-level, pre-date this ticket, pass
  build+lint. Not this ticket's scope; noted for a future cleanup if desired.
- **Store path not run under this ticket** (`yarn test:store` is the slower LevelDB pass).
  `quereus-store` tables do not implement `adoptConnection`, so they fall to the runtime
  no-op — parity by construction with the old branch, which never fired for non-memory
  modules. Unexercised here but unaffected by the change.

## Validation

- `yarn build` (quereus) — EXIT=0.
- `yarn lint` (quereus: eslint + `tsc -p tsconfig.test.json`) — EXIT=0, incl. new spec.
- `yarn test` (quereus, memory-backed) — **6882 passing, 9 pending, 0 failing**
  (6879 pre-existing + 3 new `adoptConnection` cases). New spec run in isolation: 3
  passing. Other monorepo packages' stderr noise during the run is intentional
  error-injection test fixtures ("boom", "batch write failed (test)"), all reporting
  passing — not failures, outside this diff's subsystem.
