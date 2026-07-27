description: The sync engine's test files are never type-checked, so a test can go stale against the code it tests and nobody finds out until it fails at runtime — or silently stops testing anything.
files:
  - packages/quereus-sync/tsconfig.json
  - packages/quereus-sync/package.json
  - packages/quereus-sync/test/sync/conflict-resolvers.spec.ts
  - packages/quereus-sync/test/sync/sync-manager.spec.ts
  - packages/quereus-sync/test/sync/sync-protocol-e2e.spec.ts
difficulty: easy
----

## What is wrong

`packages/quereus-sync/tsconfig.json` excludes `test/`, and the package's `typecheck`
script uses that same config. The tests are executed through a loader that strips
types without checking them, so nothing in the repository ever type-checks a
`quereus-sync` spec file. A spec that calls a function with the wrong arguments, or
that drifted when a signature changed, passes CI silently.

The project already treats this as the wrong default: `AGENTS.md` says a test-file
type pass belongs in `typecheck`, `packages/plugin-loader` has a `tsconfig.test.json`
that does exactly that, and `packages/quereus`'s lint step type-checks its tests for
the stated reason that it "catches signature drift in spec call sites too".

## Expected outcome

`yarn typecheck` type-checks `packages/quereus-sync/test/**` along with `src/`, using
the same strictness the package already applies to `src/`.

## What stands in the way

Measured during review of `1-sync-changelog-orphan-cleanup` by running a throwaway
`tsconfig.test.json` over the package: **the only failures are unused declarations**
(13 of them, `TS6133`, in three spec files) — no genuine type errors. So this is a
short mechanical cleanup plus a small config addition, not a refactor.

Two of the unused bindings look like they may be masking something rather than being
mere clutter — e.g. `sync-protocol-e2e.spec.ts` computes `changeLogAfterFirst` and
`deleteHlc` and never asserts on either. Worth a glance at whether an assertion went
missing, rather than deleting them reflexively.
