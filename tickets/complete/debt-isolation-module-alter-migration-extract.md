---
description: The half of the transaction-isolation module that carries each connection's uncommitted changes across an ALTER TABLE now lives in its own file, so both that file and the one it left are smaller. Reviewed; no behavior changed.
files:
  - packages/quereus-isolation/src/alter-migration.ts     # NEW — 1,078 lines
  - packages/quereus-isolation/src/isolation-module.ts    # 2,845 → 1,825 lines
  - packages/quereus-isolation/src/isolation-types.ts     # gained the shared state/predicate types
  - packages/quereus-isolation/src/index.ts               # re-export path moved (same public names)
  - packages/quereus-isolation/src/isolated-table.ts      # one import path
  - docs/design-isolation-layer.md                        # one paragraph naming the new file
  - tickets/backlog/debt-isolation-module-file-too-large.md  # rewritten — it still described this work as pending
---

# Complete: ALTER-migration machinery split out of `isolation-module.ts`

## What landed

`packages/quereus-isolation/src/alter-migration.ts` now owns one subject: carrying a
connection's open staging area (its "overlay") forward across an `ALTER TABLE`. It is free
functions over one overlay — per-change-type context derivation, the pre-mutation validation
dry run, the per-change-type forwards, the primary-key re-key marker handling, and the poison
message. `IsolationModule.alterTable` keeps the surrounding lifecycle: which overlays are in
scope, issuer-vs-foreign error routing, and the `alter primary key` overlay swap.

Three things were not pure relocation, and each was checked line by line against the pre-move
source (see below): the four context parameters collapsed into one `AlterMigrationPlan`
object, the per-change-type migrate switch moved into `migrateOverlayForward`, and
`backfillStagedNotNull` started calling the shared `requireTombstoneIndex` helper.

Two structural changes rode along: `IsolationModule.overlayPredicate` / `.schemaHasIndex`
went `private` → public so the class satisfies the new `AlterMigrationHost` callback
interface, and `UnderlyingTableState` / `ConnectionOverlayState` / the internal `Predicate`
alias moved to `isolation-types.ts` to avoid a module cycle. The package's public type
surface is unchanged — `index.ts` re-exports the same two names from the new location.

## Review findings

### How the move was verified

Not by reading the two files side by side. The whole diff's removed lines were normalized
(leading tab stripped, `this.` prefix stripped) and mechanically diffed against the new file.
That reduces ~1,080 moved lines to the handful of intentional deltas, and it confirmed the
move is otherwise **verbatim** — every function body, error message, status code, and doc
comment. The intentional deltas found were exactly the ones the handoff claimed, plus one it
did not mention (`probeOverlaySchema`, a new three-line helper that replaces the
`toMigrate.length === 0` / `tableSchema` probe repeated across three derive helpers —
behaviorally identical).

### Correctness — checked, nothing found

- **Atomic abort for the issuer.** The order in `alterTable` is unchanged from the pre-move
  source: partition overlays → reject a dirty issuer overlay under `alter primary key` →
  `assertColumnNameNotTombstone` → derive the plan → `validateOverlayMigration(issuer)` →
  marker drops + `alterSchema` validate-only pre-flight → `underlying.alterTable`. Confirmed
  by diffing the call sequence against the old file, not by reading the doc comment.
- **`validateOverlayMigration`'s early-return chain.** The arm order (addColumn → set-not-null
  without a default → set-data-type → pk-rekey) and every `return` placement survived the
  rewrite onto the plan object. The deliberate fall-through — `set not null` *with* a usable
  DEFAULT matches no arm and no-ops, leaving the backfill to the forward — is intact.
- **Poison vs rethrow, and marker reinsertion on refusal.** Both catch sites (`alterSchema`
  pre-flight refusal and `underlying.alterTable` refusal) still call `reinsertPkRekeyMarkers`
  with the saved rows; the foreign-overlay `CONSTRAINT`/`MISMATCH` → poison, else rethrow
  routing is byte-identical.
- **Derive ordering.** `deriveAlterMigrationPlan` calls the four helpers in the original
  order, and `derivePkRekey` — the only one that can throw — is still last.
- **The plan object's "at most one field populated" claim.** Verified at the source rather
  than trusted: `runAlterColumn` in `packages/quereus/src/runtime/emit/alter-table.ts` raises
  INTERNAL unless exactly one `ALTER COLUMN` attribute is populated, so the three
  `alterColumn` arms of the plan are genuinely mutually exclusive.
- **No module cycle.** `alter-migration.ts` imports only `isolation-types.js`,
  `filter-info.js` and `overlay-rows.js`; nothing outside the package imported the two
  relocated types from `isolation-module.js`.
- **Doc-comment links.** Every `{@link …}` in the new file resolves to a symbol in that file;
  cross-file references were retargeted to backtick-quoted `IsolationModule.foo` form.

### Fixed in this pass (minor)

- **`buildOverlayAddColumnChange` duplicated `requireTombstoneIndex`.** The handoff left the
  inline copy deliberately, reasoning that the helper needs a non-null schema while this site
  reads through an optional one. The two throws were in fact identical in message and status
  code, so the distinction bought nothing. `requireTombstoneIndex` now takes
  `TableSchema | undefined` and the duplicate four-line throw is gone. Behavior identical —
  a missing schema and a missing column raised, and still raise, the same INTERNAL error.
- **`tickets/backlog/debt-isolation-module-file-too-large.md` was stale.** That backlog ticket
  is the origin of this line of work and still described the ALTER-forwarding split as
  pending, with pre-split line counts. A human triaging the queue would have re-dispatched
  work already done. Rewritten to record what landed, correct the line counts, and name the
  remaining candidates (`isolated-table.ts` at 2,077 lines is now the package's largest file;
  `isolation-module.ts` at 1,825 is no longer urgent).

### Not fixed — deliberate

- **`overlayPredicate` and `schemaHasIndex` are now public on `IsolationModule`.** This does
  widen an exported class by two members. It could be avoided with a private host object
  built in the constructor, but the class already exposes comparable helpers
  (`createOverlaySchema`, `getUnderlyingState`, `coalesceConnectionBuild`), and `implements
  AlterMigrationHost` buys compile-time drift detection. Left alone; the churn is not worth it.
- **Four context interfaces are exported but imported nowhere** (`AddColumnBackfillContext`,
  `SetNotNullBackfillContext`, `SetDataTypeConvertContext`, `PkRekeyContext`). The file is
  package-internal — not re-exported from `index.ts` — so this widens nothing, and the
  exports document the shape of `AlterMigrationPlan`.

### Tests — no new ones, and why that is the right call here

The mechanical diff above is stronger evidence for a relocation than any test could be: it
proves the moved code is character-for-character the code that was already green. Writing
tests against the new module boundary would test the same paths the existing suite already
walks. The real coverage gap is the primary-key re-key arm — the newest and least-exercised
part of what moved — and it is already tracked by `debt-isolation-pk-rekey-edge-paths-untested`
sitting in `implement/`. Filing anything here would duplicate it.

### Tripwires

None recorded. The one conditional concern in the moved code (`collectPkRekeyGroups`
materializing one key plus one PK tuple per staged row) already carries its `NOTE:` comment at
the call site and moved with it.

## Validation

All run from the repo root after the two edits above:

- `yarn build` — clean.
- `yarn typecheck` (all workspaces) — clean.
- `yarn lint` (all workspaces) — clean.
- `yarn test` — **0 failures.** 7,698 quereus, 341 isolation, plus every other workspace
  package. (`packages/quereus-sync`'s log contains a `failingKv.iterate` stack trace; that is
  an injected failure inside a passing test, not a failure.)
- `npx tsc --noEmit --noUnusedLocals` in the isolation package — the same two pre-existing
  hits as before this change (`isolated-connection.ts:2`, `isolated-table.ts:640`), both
  outside the diff.

`yarn test:store` was **not** run, matching the implement stage's deferral: per AGENTS.md it
is for store-specific diagnosis or release prep, and the mechanical diff established that no
executable code changed on the store path.
