description: The plugin loader decided whether it was running in a browser by checking for a browser-page-only object, so code running in a background browser thread (a Web Worker) was mistaken for a server; that's now fixed so both loader entry points agree.
files:
  - packages/plugin-loader/src/plugin-loader.ts (`resolveEnvironment`, `isNodeRuntime`)
  - packages/plugin-loader/test/npm-spec.spec.ts (`resolveEnvironment`, `loadPlugin dispatch`)
----

## What landed

`resolveEnvironment()` no longer auto-detects the environment by asking "does
`globalThis.document` exist". A Web Worker has no `document`, so that answered
`'node'` for a worker — wrong, since a worker can `import('https://…')`
natively but cannot import an npm package the way Node can.

Detection now runs through `isNodeRuntime()` (does
`globalThis.process.versions.node` exist), the same check the
`resolveImportSpecifier` / `dynamicLoadModule` path already used. Both loader
entry points now agree. The old `isBrowserEnv()` helper is deleted.

The bug was dormant: nothing in quoomb-web calls `loadPlugin` — its worker
calls `dynamicLoadModule` with a URL directly, which was already correct.

## Review findings

**Correctness of the fix — confirmed.** The `document` → `process.versions.node`
swap is the right inversion, and it is the only detection helper left, so the
two entry points can't drift apart again. No remaining callers of the deleted
`isBrowserEnv`; it was never re-exported, so no public API change. Verified by
searching the whole repo for `loadPlugin` / `resolveEnvironment` / `isBrowserEnv`
callers: only `config-loader.ts` (passes options straight through) and tests.

**Minor — fixed in this pass.** The test named `'auto-detects Node from the
runtime, not from a DOM global'` did not actually stub a DOM global; it only
asserted the default Node result, so its name overstated what it covered. It
now also stubs `document` while the real Node `process` is present and asserts
`'node'` — the jsdom / Electron-renderer-with-node-integration shape, and the
one case whose answer this change *flipped* (it used to say `'browser'`).
Saying `'node'` is correct there: `import('some-package')` resolves in that
runtime, so routing it to the CDN path would be wrong.

**Docs — checked, nothing stale.** Read every doc that mentions the loader:
`docs/plugins.md` (§ programmatic loading) and
`packages/plugin-loader/README.md`. Neither ever described *how* the
environment is auto-detected — they only document the `env` / `allowCdn`
options, which are unchanged. So no doc edit was warranted; this is an
explicit "nothing to update", not an unchecked box.

**Tripwire — recorded, not ticketed.** Auto-detection is binary: anything that
is not Node is now `'browser'`, so React Native / NativeScript get the CDN
refusal ("requires allowCdn=true") instead of the previous attempt at a package
import. Neither path works on those runtimes today — the README already says
they must register plugins statically — so nothing regresses, but if one ever
gains a real dynamic-loading story it needs a third environment rather than a
wider condition. Parked as a `NOTE:` comment directly above
`resolveEnvironment` in `packages/plugin-loader/src/plugin-loader.ts`.

**Known gap accepted, no ticket.** No test runs inside a real Web Worker global
scope; the worker case is approximated with `vi.stubGlobal` (`document`
undefined + a non-Node `process`), matching the existing pattern in
`remote-module.spec.ts`. Nothing in the repo runs vitest specs inside a Worker,
so building that harness for one boolean is disproportionate — the detection
under test reads only `globalThis.process`, which the stub reproduces exactly.

**Not found.** No resource-cleanup, error-handling, type-safety, or file-size
concerns: the diff is a five-line function body plus tests, all `afterEach`
hooks call `vi.unstubAllGlobals()`, and no `any` was introduced.

## Validation

- `yarn workspace @quereus/plugin-loader run typecheck` — clean (covers test
  files via `tsconfig.test.json`).
- `yarn workspace @quereus/plugin-loader run vitest run` — 96/96 pass.
- `yarn lint` (all packages) — clean.
- `yarn test` (all workspaces) — all green, no failures; no pre-existing
  failures surfaced.
