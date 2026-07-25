description: Added unit tests for the package that loads Quereus plugins — URL validation, the security allowlist that decides where a plugin may load from, npm package-name parsing, CDN URL building, and config-file handling — plus fixes for defects the new tests exposed.
files:
  - packages/plugin-loader/src/plugin-loader.ts (3 helpers exported for tests; URL-vs-package routing fixed; one NOTE)
  - packages/plugin-loader/src/config-loader.ts (env-var interpolation fixes)
  - packages/plugin-loader/test/plugin-url.spec.ts (new)
  - packages/plugin-loader/test/npm-spec.spec.ts (new)
  - packages/plugin-loader/test/config-loader.spec.ts (new)
  - packages/plugin-loader/test/helpers/plugin-fixtures.ts (new, shared)
  - packages/plugin-loader/test/config-channel.spec.ts (refactored onto shared fixtures)
  - packages/plugin-loader/tsconfig.test.json (new), packages/plugin-loader/package.json
  - package.json (root `check` now runs `typecheck`), AGENTS.md
  - packages/plugin-loader/README.md, docs/plugins.md
difficulty: medium
----

## What landed

`@quereus/plugin-loader` went from 1 spec file / 3 tests to 4 spec files /
**74 tests**. Coverage now spans:

- **`validatePluginUrl`** — accepted schemes/extensions, and every rejection
  class (bad protocol, bad extension, non-URL strings).
- **`dynamicLoadModule`** — the protocol allowlist refuses `http:`, `data:`,
  `ftp:`, `blob:` *before* any import is attempted (so no test touches the
  network); `file://` loads deliver config to the plugin, return no manifest when
  none sits beside the module, and reject modules with a missing or non-function
  default export.
- **`parseNpmSpec` / `toCdnUrl` / `resolveEnvironment`** — scoped vs unscoped
  names, version pinning, subpath splitting, all three CDNs, environment
  auto-detection.
- **`loadPlugin` dispatch** — direct URL vs npm package vs browser+CDN refusal.
- **Config file handling** — `${VAR}` / `${VAR:-default}` interpolation,
  `validateConfig` accept/reject matrix, and `loadPluginsFromConfig`'s aggregate
  failure reporting and option forwarding.

Three internal helpers (`parseNpmSpec`, `toCdnUrl`, `resolveEnvironment`) are
exported from `src/plugin-loader.ts` for the specs. `src/index.ts` is unchanged
and the package's `exports` map has no subpath entry, so the published API
surface is identical — reviewed and kept.

Test-side infrastructure: `test/helpers/plugin-fixtures.ts` writes throwaway
`.mjs` modules to a temp dir and provides a "capture" plugin that records the
config it was handed; `tsconfig.test.json` type-checks `src` + `test` together
(vitest transpiles specs without checking them, so a signature change in `src`
would otherwise leave specs silently stale).

## Review findings

### Checked

Read the implement diff first, then the whole of `src/plugin-loader.ts` and
`src/config-loader.ts` — including every path the new specs *don't* reach — and
probed the untested behaviour directly against the built package. Also read
`packages/plugin-loader/README.md`, `docs/plugins.md` § Installation & loading,
and the `AGENTS.md` Build & Test section, and traced every caller of
`dynamicLoadModule` / `loadPlugin` across the monorepo (CLI, web worker,
`config-loader`).

Validation, all green: `yarn docs:check`, `yarn lint` (exit 0), root
`yarn typecheck` (exit 0, 15s), `@quereus/plugin-loader` tests 74 passing, root
`yarn test` (exit 0, ~4 min, no failures anywhere). No pre-existing failures
surfaced, so `tickets/.pre-existing-error.md` was not written.

### Fixed in this pass (minor)

- **`interpolateEnvVars` resolved inherited `Object.prototype` members as if
  they were environment variables.** `${constructor}` in a config file expanded
  to `function Object() { [native code] }`, `${__proto__}` to `[object Object]`.
  Now an own-property check gates the lookup, so unknown names fall through to
  their default or stay literal. Pinned by a test.
- **`${VAR:-default}` truncated any default containing `:-`.** `split(':-')`
  discarded everything past the second separator, so `${A:-a:-b}` yielded `a`.
  Split now happens at the first `:-` only, via a named `parsePlaceholder`
  helper. Pinned by a test.
- **A disallowed-but-parseable URL fell through to the npm branch.** The
  implementer parked this as a tripwire; it is not conditional — it fires today
  whenever a user pastes an `http://` URL, and the resulting "Failed to resolve
  plugin package 'http:'" hides the real reason. `isUrlLike` also duplicated the
  protocol allowlist rather than deferring to `ALLOWED_PLUGIN_PROTOCOLS`. It now
  routes every parseable URL except `npm:` to `dynamicLoadModule`, which names
  the offending protocol. The load was refused before and is refused now — only
  the message changed. Pinned by tests (including one that `npm:` specs still
  reach the package branch).
- **The new test-file type-check pass was inert.** It was added to the package's
  `typecheck` script, but root `yarn check` runs `docs:check`, `lint`, `build`,
  and the test suites — never `typecheck`. Root `check` now runs `yarn typecheck`
  *after* `yarn build` (it must follow the build: this package's test pass
  resolves `@quereus/quereus` through its built `dist` types, so putting it in
  `lint` — which runs before `build` — would break a clean checkout). `AGENTS.md`
  Build & Test documents the ordering rule.
- **`loadPluginsFromConfig` never verified it forwards loader options.** Added a
  test asserting `{ env: 'browser' }` reaches `loadPlugin`.
- **Docs claimed a capability that does not exist.** Both the package README and
  `docs/plugins.md` presented `dynamicLoadModule('https://…')` as working under
  Node. It does not (see below). Both now state that `https:` module loads are
  browser-only and show the `file://` form for Node, and `docs/plugins.md` spells
  out the allowlist and the exact Node error.

### Filed as new work (major)

- `tickets/fix/cli-https-plugin-load-fails.md` — **`.plugin install https://…`
  in the CLI is broken and always has been.** Node's ESM loader accepts only
  `file:` and `data:` URLs (network imports were experimental and have been
  removed; verified `ERR_UNSUPPORTED_ESM_URL_SCHEME` on Node v24.2.0), yet
  `validatePluginUrl` accepts https and the CLI's own usage text advertises it.
  The browser worker path is unaffected. The ticket lays out the two defensible
  outcomes (fetch-to-local-file, or refuse early with a clear message) without
  pre-deciding. This also explains the implementer's "no https load is tested"
  gap: under Node such a test *cannot* pass with the current code.

### Recorded as tripwires (not tickets)

- `src/plugin-loader.ts`, at the `file:`/localhost cache-buster — each reload
  imports a unique `?t=` specifier, so Node retains every prior version of the
  module. Fine for a CLI or dev session; only becomes work if a long-lived host
  starts reloading plugins in a loop, which would need a real unload story.
- The implementer's existing `isUrlLike` NOTE was **removed**, because the
  concern it described was fixed rather than deferred.

### Reviewed and deliberately left alone

- **Exporting three internals for tests.** The alternative — reaching them only
  through `loadPlugin` — ends in a live network import in every case. The
  `exports` map has no subpath entry, so the published surface is unchanged.
  Correct call; kept.
- **Dropping `--passWithNoTests` from this package only.** With four spec files
  present, the flag only serves to make a glob that stops matching report green.
  The inconsistency with other packages is deliberate and documented in the
  package's `//test` note. Kept.
- **`dynamicLoadModule` does not check the file extension, `validatePluginUrl`
  does.** This is correct as designed: the loader is the security choke point
  (protocol), the extension check is a pre-flight UI hint. Not a defect.
- **`loadFromNodePackage`'s success path and `tryLoadManifestFromPackage`
  remain untested.** Covering them needs an installed fixture package exporting
  `./plugin`, i.e. a new workspace package wired into this one's devDependencies.
  Judged not worth the coupling for the value; the failure path *is* covered, and
  the honest gap stays recorded here.
