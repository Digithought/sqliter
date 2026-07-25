description: Added unit tests for the package that loads Quereus plugins — URL validation, the security allowlist that decides where a plugin may load from, npm package-name parsing, CDN URL building, and config-file handling.
files:
  - packages/plugin-loader/src/plugin-loader.ts (3 helpers newly exported for tests; one NOTE comment)
  - packages/plugin-loader/test/plugin-url.spec.ts (new)
  - packages/plugin-loader/test/npm-spec.spec.ts (new)
  - packages/plugin-loader/test/config-loader.spec.ts (new)
  - packages/plugin-loader/test/helpers/plugin-fixtures.ts (new, shared)
  - packages/plugin-loader/test/config-channel.spec.ts (refactored onto shared fixtures)
  - packages/plugin-loader/tsconfig.test.json (new)
  - packages/plugin-loader/package.json (typecheck + test scripts)
difficulty: medium
----

## What landed

`@quereus/plugin-loader` went from 1 spec file / 3 tests to 4 spec files /
69 tests. Full monorepo `yarn test` passes (exit 0) and
`npx tsc -b tsconfig.build.json` builds clean.

### Source changes (small, deliberate)

Three internal helpers in `src/plugin-loader.ts` are now `export`ed so specs can
call them directly: `parseNpmSpec`, `toCdnUrl`, `resolveEnvironment` (plus the
`NpmSpec` interface). Each carries an `@internal` doc comment saying it is
exported for tests only. **`src/index.ts` is unchanged**, so the package's
published API surface is identical — specs import these from
`../src/plugin-loader.js` rather than `../src/index.js`.

That is the one design call worth a second opinion: the alternative was to reach
them only through `loadPlugin`, but every such path ends in a real
`import()` of a CDN URL, i.e. a live network call in a unit test. Direct export
was chosen over network-dependent tests. If the reviewer prefers a different
seam, the specs are the only consumers.

One `NOTE:` tripwire added at `isUrlLike` (`src/plugin-loader.ts`): a spec with
a disallowed-but-parseable scheme (`http://host/p.js`) is not "URL-like", so
`loadPlugin` falls through to the npm branch and reports a *package resolution*
failure instead of a *protocol* failure. The load is still refused — only the
error message misleads. Left as-is; conditional on it showing up in user reports.

### Test scripts

- `typecheck` now runs a second pass over `tsconfig.test.json` (src + test).
  `tsconfig.json` includes `src/**` only, and vitest transpiles specs without
  type-checking them, so a signature change in `src/` would otherwise leave the
  specs silently stale. This mirrors what `packages/quereus` does in its `lint`.
  `lint` here stays the house-standard `echo 'No lint configured'` no-op.
- **Deviation to check:** `--passWithNoTests` was dropped from this package's
  `test` script. Rationale (recorded in the `//test` note): with 4 spec files
  present, the flag now only serves to make a glob that stops matching report
  green. Every *other* package in the repo still carries the flag, so this is
  intentionally inconsistent — revert it if the reviewer would rather keep the
  fleet uniform.

## What is actually covered

**`test/plugin-url.spec.ts`** — `validatePluginUrl` and `dynamicLoadModule`.

- Accepts: `https:`/`file:` + `.js`/`.mjs`, case-insensitive extension, query
  strings, ports, fragments.
- Rejects: `http:`, `ftp:`, `data:`, `blob:`, `javascript:`, `npm:`; `.ts`,
  `.json`, no extension, extension only in the query string; relative and
  non-URL strings.
- `dynamicLoadModule` refuses each disallowed protocol *before* attempting an
  import (so no network), with the protocol named in the message and the allowed
  set listed. The `data:` case is the interesting one — `import()` would happily
  load a `data:` URL, so this proves the allowlist is doing real work.
- `file://` loads: config reaches the plugin; no manifest is returned when no
  fetchable `package.json` sits beside the module; a module with no default
  export, or a non-function default, is rejected; an error thrown by the plugin
  itself surfaces tagged with the source.

**`test/npm-spec.spec.ts`** — `parseNpmSpec`, `toCdnUrl`, `resolveEnvironment`,
`loadPlugin` dispatch.

- Spec parsing: bare name, `npm:` prefix stripped, scoped names (the leading
  `@` is not read as a version), version pinning on both scoped and unscoped
  names, empty version treated as absent, subpath split at the *first* slash
  unscoped and the *second* slash scoped, version + subpath together, and an
  `@` inside a subpath not being mistaken for a version. Null for empty /
  whitespace-bearing input. One test documents current leniency: `@scope`
  alone parses (no npm name validation is attempted).
- CDN URLs: all three CDNs, default `/plugin` subpath, version segment present
  or omitted, leading slash stripped so no `//` appears, result always `https:`.
- Environment: explicit `node`/`browser` honoured; auto-detects `node` with no
  `document` global and `browser` when one is stubbed on `globalThis`.
- Dispatch: `file://` goes straight to the module loader; a non-URL non-package
  spec is rejected; a browser + npm spec without `allowCdn` is refused (and the
  offending spec is echoed); the Node path names the unresolvable package and
  states the expected export shape.

**`test/config-loader.spec.ts`** — `interpolateEnvVars`,
`interpolateConfigEnvVars`, `validateConfig`, `loadPluginsFromConfig` failures.

- Interpolation: plain `${VAR}`, embedded in text, `${VAR:-default}` fallback,
  empty default, variable-name whitespace trimmed, missing-and-no-default leaves
  the literal `${VAR}` text, non-strings pass through, recursion into nested
  objects and arrays, input not mutated. Two behaviours are pinned deliberately
  because they are easy to "fix" wrongly: an env var explicitly set to the empty
  string beats its default (it is a value, not an absence), and `${VAR:-}`
  yields `''`.
- `interpolateConfigEnvVars` with a supplied env, and falling back to
  `process.env` when none is given.
- `validateConfig`: accepts empty/minimal configs, well-formed entries, nested
  config objects, and `config: null`; rejects non-objects, non-array `plugins`,
  entries lacking a string `source`, `null` entries, string entries, non-plain-
  object `config` (string/array/number), non-boolean `autoload`, and a list
  where only one entry of several is malformed.
- `loadPluginsFromConfig`: no-op with no plugins; a good plugin still loads when
  a sibling entry fails; the aggregate error counts the failures and names each
  source with its reason.

**`test/helpers/plugin-fixtures.ts`** — temp-ESM-module writer (`.mjs`, so Node
treats it as ESM regardless of any enclosing package.json), cleanup, and the
"capture" plugin that records the config it was handed. `config-channel.spec.ts`
was refactored onto it rather than keeping its own copy; its assertions are
unchanged.

## Known gaps — please treat these as the floor, not the ceiling

- **Nothing exercises an `https://` module load.** That means
  `tryLoadManifestFromUrl` and `extractManifestFromPackageJson` are still
  entirely untested, as is the localhost cache-busting branch in
  `dynamicLoadModule` (the `file:` half of that condition is exercised, the
  `hostname === 'localhost'` half is not). Both need either a live network or a
  local HTTP server fixture; neither exists in this package today.
- **`loadFromNodePackage`'s success path is untested** — only the
  "package does not resolve" failure is. A real test needs an installed fixture
  package exporting `./plugin`; `resolveFirstModule`'s fallback from
  `<name>/plugin` to `<name>` is therefore unverified, as is
  `tryLoadManifestFromPackage`.
- **The browser + `allowCdn: true` path stops at URL construction.** `toCdnUrl`
  is tested directly; nothing verifies that `loadPlugin` actually hands that URL
  to `dynamicLoadModule`, because doing so would fetch from a real CDN.
- **`dynamicLoadModule` does not check the file extension** (only
  `validatePluginUrl` does). I could not assert that cleanly — loading a
  non-`.mjs` file under vitest/Node ESM is unreliable — so the asymmetry between
  the two functions is documented in prose but not pinned by a test.
- **`isBrowserEnv` is only reached through `resolveEnvironment`**, and the
  browser case stubs `globalThis.document = {}`, which is a shallow fake.
- `toCdnUrl`'s `default:` switch arm is reached via `'jsdelivr'`; no test passes
  an out-of-union CDN name (that would need a cast).
