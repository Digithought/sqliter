description: The package that loads plugins into the Quereus SQL engine has only one small test file, so most of its logic — parsing plugin URLs/package names and building a security allowlist for where plugins can load from — could break silently.
files:
  - packages/plugin-loader/src/plugin-loader.ts
  - packages/plugin-loader/src/config-loader.ts
  - packages/plugin-loader/test/config-channel.spec.ts (existing coverage)
difficulty: medium
----

## Background

`@quereus/plugin-loader` (`packages/plugin-loader`) is how Quereus loads
third-party plugins — from a local file, an `https://` URL, or an npm package
name — and registers them with a `Database`. It is infrastructure other
packages depend on (quoomb-cli, quoomb-web), not glue code, so gaps here are a
real coverage risk rather than something to wave off with a "no tests needed"
note.

There is currently one spec file, `test/config-channel.spec.ts`, which covers
`toPluginSqlConfig` and the `loadPluginsFromConfig` happy path (confirming a
structured config object like `{ cache: {...} }` reaches the plugin as an
object, not a flattened JSON string). That guards a real regression but leaves
most of the module's logic unexercised.

## Untested surface (in `src/plugin-loader.ts`)

- **`validatePluginUrl`** — must accept only `https://`/`file://` URLs ending
  in `.js`/`.mjs` and reject everything else (wrong protocol, wrong
  extension, malformed URL). This is the pre-flight check installs go through
  before attempting a load.
- **`dynamicLoadModule`'s protocol allowlist** — the actual enforcement point
  (`ALLOWED_PLUGIN_PROTOCOLS`). No test currently exercises the *rejection*
  path (e.g. an `http://` or `data:` URL should throw, not load).
- **npm spec parsing** — `parseNpmSpec` / `splitSubpath` / `splitVersion`,
  the string-parsing logic that turns a spec like `npm:@scope/name@1.2.3/sub`
  or a bare package name into `{ name, version, subpath }`. Scoped packages,
  version pinning, and subpaths each have their own edge cases (e.g. the
  second `/` after an `@scope/name` is where the subpath starts, not the
  first).
- **CDN URL building** — `toCdnUrl` for `jsdelivr` (default), `unpkg`, and
  `esm.sh`, including how it handles a missing version or subpath.
- **Environment/loading branch selection** — `resolveEnvironment` /
  `isBrowserEnv`, and the `loadPlugin` dispatch across: direct URL, npm spec
  in Node (`loadFromNodePackage`), and npm spec in a browser (requires
  `allowCdn: true` or throws).

## Untested surface (in `src/config-loader.ts`)

- **`interpolateEnvVars`** — `${VAR_NAME}` and `${VAR_NAME:-default}`
  substitution, including nested objects/arrays and the case where the env
  var is absent and there is no default (currently leaves the placeholder
  text as-is).
- **`validateConfig`** — the structural checks in `isValidPluginEntry`
  (rejecting a plugin entry with no `source` string, or a non-object
  `config`), and the `autoload` type check.

## Expectations for whoever picks this up

A `vitest` unit-test pass over the above, in the existing `test/` directory
(mirroring `config-channel.spec.ts`'s style — plain `describe`/`it`, real
temp files via `node:fs/promises` where a module needs to be loaded from
disk, no mocking of the module under test). Aim for the branches listed
above, not 100% line coverage for its own sake. `dynamicLoadModule`'s
node-package and CDN-URL branches can be tested at the "constructs the right
URL / rejects the right input" level without needing a live network call.
