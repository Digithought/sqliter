description: The plugin loader decided whether it was running in a browser by checking for a browser-page-only object, so code running in a background browser thread (a Web Worker) was mistaken for a server; that's now fixed so both loader entry points agree.
files:
  - packages/plugin-loader/src/plugin-loader.ts (`resolveEnvironment`, `isNodeRuntime`, `loadPlugin`, `loadFromNodePackage`)
  - packages/plugin-loader/test/npm-spec.spec.ts (`resolveEnvironment` describe block, `loadPlugin dispatch` describe block)
  - packages/quoomb-web/src/worker/quereus.worker.ts (confirmed unaffected — see below)
difficulty: easy
----

## What changed

`resolveEnvironment()` (in `packages/plugin-loader/src/plugin-loader.ts`) used
to auto-detect via `isBrowserEnv()`, which tested "does `globalThis.document`
exist". A Web Worker has no `document`, so that answered `'node'` for a
worker — wrong, since a worker natively supports `import('https://…')` and
cannot `import()` an npm package the way Node can.

`resolveEnvironment` now auto-detects with `isNodeRuntime()` (does
`globalThis.process.versions.node` exist) — the same test
`resolveImportSpecifier` already used for the `dynamicLoadModule` path since
an earlier fix. Both of the loader's entry points now agree on environment
detection. `isBrowserEnv()` is deleted (no remaining callers, not
re-exported).

## Why it was safe (dormant bug, not live)

Nothing in quoomb-web calls `loadPlugin` — the worker
(`packages/quoomb-web/src/worker/quereus.worker.ts:540`) only calls
`dynamicLoadModule` directly with a URL, which was already fixed. Confirmed by
grep — no other change needed there. This ticket only touches the loader
package itself.

## Test coverage for review/verification

`packages/plugin-loader/test/npm-spec.spec.ts`:

- `resolveEnvironment` describe block: rewrote the two tests that stubbed
  `document` (that scenario no longer reflects how detection works) into
  tests that stub `globalThis.process` instead (mirroring the pattern already
  used in `remote-module.spec.ts`'s `isNodeRuntime` tests). Added a new test,
  `'treats a DOM-less Web Worker as a browser, not Node'`, that stubs both
  `document` (undefined) and `process` (non-Node shape) simultaneously — the
  actual worker shape — and asserts `resolveEnvironment('auto')` returns
  `'browser'`.
- `loadPlugin dispatch` describe block: added
  `'asks for allowCdn on an npm spec auto-detected in a DOM-less, non-Node
  runtime (e.g. a Web Worker), instead of attempting a package import'` — the
  ticket's explicit ask. Stubs the worker-shaped globals, calls `loadPlugin`
  with an npm-style spec and no `env` override (forcing auto-detection), and
  asserts it throws the `allowCdn=true` message rather than
  `loadFromNodePackage`'s "Failed to resolve plugin package" message.

Ran `yarn workspace @quereus/plugin-loader run typecheck` (covers test files
too, via that package's `tsconfig.test.json`) and
`yarn workspace @quereus/plugin-loader run vitest run` — both clean, 96/96
tests pass (up from 94 with the two new tests, net of the two rewritten
ones). Lint is a no-op for this package per `AGENTS.md`. Also ran the
top-level `tsc -b tsconfig.build.json` project-reference build to confirm no
downstream package (quoomb-web included) broke — clean.

## Known gaps for the reviewer

- No test exercises the *actual* Web Worker global scope (`self`,
  `WorkerGlobalScope`) — the existing test suite (and this addition) all run
  under Node with `vi.stubGlobal`, stubbing `process` to a non-Node shape and
  `document` to `undefined` to approximate a worker. This matches the
  existing pattern in `remote-module.spec.ts` for `isNodeRuntime`, so
  consistent with prior art, but it's an approximation, not a real worker
  environment — nothing in the repo runs vitest specs inside an actual
  Worker.
- Did not add an integration-level test that routes a real `loadPlugin` call
  through quoomb-web's worker, since (per Background) nothing currently calls
  `loadPlugin` from there — this ticket fixes the latent trap for whenever
  that first happens, per the ticket's own framing ("the first browser host
  that does").
