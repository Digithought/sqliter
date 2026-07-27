---
description: The sync package's test files are never type-checked by any build or CI command, so a type error in a test only shows up as red squiggles in an editor — the checked-in config that would catch it is not wired to any script.
prereq:
files:
  - packages/quereus-sync/package.json (the `typecheck` script, ~line 45)
  - packages/quereus-sync/tsconfig.test.json (exists, includes `test/**/*`, run by nothing)
  - AGENTS.md (§ Build & Test — "Put a test-file type pass in `typecheck`, not `lint`")
difficulty: easy
---

# Sync test files are type-checked by nothing

`packages/quereus-sync` ships a `tsconfig.test.json` that includes `test/**/*`,
but the package's `typecheck` script is plain `tsc --noEmit`, which resolves the
base `tsconfig.json` — and that config explicitly excludes `test`. The test
runner (mocha via a `register.mjs` loader) strips types at run time rather than
checking them. Net effect: no command in `yarn build`, `yarn typecheck`,
`yarn lint`, `yarn test`, or `yarn check` ever type-checks a sync spec.

Consequence: a spec can call a changed signature with the wrong argument shape,
or silently pick up an implicit `any`, and every gate stays green. The engine
package (`packages/quereus`) already guards against exactly this — its `lint`
script runs `tsc -p tsconfig.test.json --noEmit` over its test files precisely to
catch signature drift at spec call sites.

Running `npx tsc -p tsconfig.test.json --noEmit` inside `packages/quereus-sync`
today reports **no errors**, so wiring it in is a green change, not a cleanup
project.

## Expected behavior

A type error in a sync spec fails a normal local/CI gate.

## Notes for whoever picks this up

- Per `AGENTS.md`, the test-file pass belongs in `typecheck` (not `lint`),
  because `yarn typecheck` runs after `yarn build` and so can resolve workspace
  dependencies through their built `dist` types.
- The same gap exists in every other package that ships a `tsconfig.test.json`
  but whose `typecheck` is bare `tsc --noEmit`: `quereus-isolation`,
  `quereus-store`, `quereus-sync-client`, `sync-coordinator`, and the four
  storage plugins. Only `plugin-loader` (in `typecheck`) and `quereus` (in
  `lint`) actually run theirs. Worth one sweep rather than a per-package fix —
  but check each package passes before wiring it in; one with pre-existing spec
  type errors needs those fixed first and may deserve its own ticket.
