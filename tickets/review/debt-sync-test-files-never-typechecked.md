description: Test files in several packages (sync, sync-client, sync-coordinator, and the shared "store" package) were never actually type-checked by any command, because of both a missing wiring step and a config bug that made the wiring silently check nothing even where it had already been added.
files:
  - packages/quereus-sync/{package.json,tsconfig.test.json}
  - packages/quereus-sync-client/{package.json,tsconfig.test.json}
  - packages/sync-coordinator/{package.json,tsconfig.test.json}
  - packages/quereus-store/tsconfig.test.json
  - packages/quereus-plugin-react-native-leveldb/package.json
  - packages/quereus-plugin-nativescript-sqlite/package.json
  - packages/quereus-store/test/{json-key.spec.ts,stream-index-build.spec.ts,unique-constraints.spec.ts}
  - packages/quereus-sync/test/sync/{conflict-resolvers.spec.ts,sync-manager.spec.ts,sync-protocol-e2e.spec.ts}
  - packages/quereus-sync-client/test/sync-client.spec.ts
  - packages/quereus-plugin-react-native-leveldb/test/plugin.spec.ts
---

# Sync test files are now type-checked — plus a second, bigger bug found along the way

## What the ticket asked for

`packages/quereus-sync` ships a `tsconfig.test.json` that includes `test/**/*`,
but its `typecheck` script was plain `tsc --noEmit`, which only resolves the
base `tsconfig.json` (which excludes `test`). No command ever type-checked a
sync spec. The ticket asked to wire `tsc -p tsconfig.test.json --noEmit` into
`typecheck` for `quereus-sync`, and flagged the same gap likely existed in
`quereus-isolation`, `quereus-store`, `quereus-sync-client`, `sync-coordinator`,
and the four storage plugins — "worth one sweep."

## What was actually found: a second bug hiding under the first

Before wiring anything in, I ran `npx tsc -p tsconfig.test.json --noEmit`
directly in each package to see what would surface. For `quereus-sync` this
reported **zero errors** — but `--listFiles` showed **zero test files were
even being compiled**. The cause: `tsconfig.test.json` `extends` the base
`tsconfig.json`, whose `exclude` list contains `"test"`. TypeScript inherits
`exclude` from the base config when the child doesn't specify its own — and
`quereus-sync`'s `tsconfig.test.json` didn't override it. So `include:
["test/**/*", ...]` was being silently filtered back out by the inherited
`exclude`. The "no errors" result the ticket used as its green-change signal
was actually "no files checked at all."

**This same bug already existed in a package whose `typecheck` script had
already been wired** (presumably by an earlier ticket): `quereus-store`'s
`package.json` already ran `tsc --noEmit && tsc -p tsconfig.test.json
--noEmit`, and that second pass was — and had been — silently checking zero
test files for the same inherited-`exclude` reason. So the "already wired"
column in the original ticket's notes was aspirational, not actual, for at
least this one package.

I checked every package with a `tsconfig.test.json` for both bugs (missing
wiring, and this exclude-inheritance no-op) rather than trusting the ticket's
inventory:

| package | had the exclude bug? | typecheck wired before? | now |
|---|---|---|---|
| quereus | no (overrides exclude correctly) | yes, via `lint` | unchanged |
| quereus-isolation | no (overrides exclude correctly) | yes | unchanged |
| plugin-loader | no (base doesn't exclude test) | yes | unchanged |
| quereus-plugin-leveldb | no (base doesn't exclude test) | yes | unchanged |
| quereus-plugin-indexeddb | no (base doesn't exclude test) | yes | unchanged |
| **quereus-store** | **yes** | yes (but no-op) | **fixed exclude; real errors surfaced and fixed** |
| **quereus-sync** | **yes** | no | **fixed exclude; wired; real errors surfaced and fixed** |
| **quereus-sync-client** | **yes** | no | **fixed exclude; wired; real error surfaced and fixed** |
| **sync-coordinator** | **yes** | no | **fixed exclude; wired (clean, no errors)** |
| quereus-plugin-react-native-leveldb | no (base doesn't exclude test) | no | wired; 1 dead var removed |
| quereus-plugin-nativescript-sqlite | no (base doesn't exclude test) | no | wired (clean, no errors) |

Fix for the exclude bug is the same one-liner everywhere: add
`"exclude": ["node_modules", "dist"]` to the `tsconfig.test.json` (matching
the pattern `quereus-isolation` and `quereus`'s own `tsconfig.test.json`
already used correctly).

## Real errors that surfaced once test files were actually being checked

Once the exclude bug was fixed, these packages had genuine (if mostly minor)
type errors in spec files — none in `sync-coordinator`, which came up clean:

**`quereus-sync`** (10 `TS6133` unused-declaration errors):
- `conflict-resolvers.spec.ts`: unused `DataChangeToApply`/`SchemaChangeToApply`
  type imports — deleted. Unused `ctx` resolver param — prefixed `_ctx`. Unused
  `result` local — this one **was a dropped assertion**: the surrounding
  comment already said "applied=0 for the column changes since they're
  blocked by tombstone" but no `expect` enforced it. Added
  `expect(result.applied).to.equal(0)`, which passes.
- `sync-manager.spec.ts`: three `const manager = await SyncManagerImpl.create(...)`
  calls only needed for their constructor side effect (subscribing to the
  shared event source) — dropped the unused binding, kept the `await` call.
  One `origIterate` capture was truly dead (never called, no restore) —
  deleted.
- `sync-protocol-e2e.spec.ts`: two suspects flagged in the original ticket as
  "may be masking a dropped assertion":
  - `changeLogAfterFirst` (idempotency test) — **was** a dropped assertion.
    Added `expect(guest.dataStore.changeLog.length).to.equal(changeLogAfterFirst)`
    after the second (no-op) apply, which passes and is exactly what the test's
    name ("should produce identical state when applying the same ChangeSet
    twice") promises but didn't check.
  - `deleteHlc` (tombstone-blocking test) — checked every other use of the
    variable; found none. The value is discarded and only the *second* tick
    (`laterDeleteHlc`) is ever used as the delete's HLC. This one really does
    look like inert scaffolding, not a missing assertion — kept the
    `remoteHLC.tick()` call for its clock-advancing side effect but dropped
    the unused binding.

**`quereus-store`**:
- `json-key.spec.ts`: two `TS2322` errors — the differential-fuzz `generate()`
  helper was annotated to return `SqlValue`, but `SqlValue` also admits
  `bigint`/`Uint8Array`, which are not valid *nested* JSON container elements.
  TS couldn't verify `Array.from(...)`/`Record<string, SqlValue>` built from
  recursive `generate()` calls were safe to widen back into `SqlValue`'s
  `JsonSqlValue` arm, even though no `bigint`/`Uint8Array` ever appears at
  runtime. Introduced a local recursive `JsonScalar`/`JsonGenerated` type
  (string|number|boolean|null, recursively) scoped to that one `describe`
  block and retyped `SCALARS`/`generate()` against it — no `src/` change, pure
  test-file fix, no behavior change.
- `stream-index-build.spec.ts`: unused `beforeEach` import (no
  `beforeEach(...)` call anywhere in the file) — deleted from the import list.
- `unique-constraints.spec.ts`: `TS2322` — `db.watch(scope, e =>
  watchEvents.push(e))`; `Array.prototype.push` returns `number`, and
  `WatchHandler`'s return type is the *union* `void | Promise<void>`, which
  (unlike a bare `void` return type) does not get TypeScript's usual "ignore
  whatever a void-typed callback returns" treatment. Wrapped the arrow body in
  braces so it returns `undefined`. Behavior-preserving.

**`quereus-sync-client`**:
- `sync-client.spec.ts`: `FakeSyncEngine.getSnapshot()`'s mock `Snapshot`
  literal was missing `snapshotFormat` — a field a prior ticket
  (`2-sync-snapshot-receiver-derives-row-identity`, now in `complete/`) added
  to the real `Snapshot` interface. This is precisely the "signature drift at
  spec call sites" class of bug the whole ticket exists to catch — a mock
  fell out of sync with a real interface and nothing noticed. Added
  `snapshotFormat: SNAPSHOT_WIRE_FORMAT_VERSION` to the mock, importing the
  constant from `@quereus/sync`.

**`quereus-plugin-react-native-leveldb`** (surfaced when I checked it before
wiring, since it had no exclude bug but was also unwired): `plugin.spec.ts`
had an `asyncIteratorWasDeleted` local set in `afterEach` but never read
anywhere — deleted, confirmed no assertion depended on it.

## Use cases for testing / validation

- `cd packages/<pkg> && npx tsc -p tsconfig.test.json --noEmit` should exit 0
  for all 11 packages listed in the table above.
- `cd packages/<pkg> && npx tsc -p tsconfig.test.json --noEmit --listFiles |
  grep -i "<pkg>/test"` should list the package's actual spec files — this is
  the regression check for the exclude-inheritance bug specifically; a config
  that silently matches zero files will pass the plain `--noEmit` check with
  no output and look identical to a genuinely clean run.
- `yarn typecheck` (root, fans out to all workspaces) — ran clean, exit 0.
- `yarn build` — ran clean (full `tsc -b tsconfig.build.json` plus the 3
  bundled apps).
- `yarn test` (root, all workspaces, default in-memory vtab path) — ran clean:
  quereus 1176 passing, quereus-sync 594 passing, quereus-sync-client 52
  passing, sync-coordinator 134 passing, quoomb-cli/quoomb-web vitest suites
  passing, plus the smaller isolation/leveldb/indexeddb/nativescript suites.
  Full log tail available if needed; nothing failed or was skipped.

## Known gaps for the reviewer

- **`yarn test:store` (LevelDB-backed store path) was not run.** Only the
  default `yarn test` (in-memory vtab) ran. Three `quereus-store` spec files
  were touched directly (`json-key.spec.ts`, `stream-index-build.spec.ts`,
  `unique-constraints.spec.ts`) — all three edits are type-level-only or
  behavior-preserving (see above), so risk is low, but they weren't verified
  against the LevelDB path. Worth a `yarn test:store` pass before this ticket
  is closed out, or at least before touching `quereus-store` again.
- The exclude-bug fix and the extra wiring (react-native-leveldb,
  nativescript-sqlite) go beyond the ticket's literal ask (which only named
  `quereus-sync`), but the ticket's own notes explicitly asked for "one sweep
  rather than a per-package fix," and the exclude bug meant three of the
  "already wired" or "should be easy to wire" packages were actually
  no-ops or would have been no-ops if wired without the fix. Flagging in case
  the reviewer wants to scope this back down.
- No tripwires identified beyond what's already commented in code
  (`json-key.spec.ts`'s `JsonGenerated` type has an inline note explaining
  why it exists).
