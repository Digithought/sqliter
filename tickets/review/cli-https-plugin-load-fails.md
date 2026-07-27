description: Installing a plugin from a web address in the command-line tool used to always fail. It now downloads the plugin to a temporary file first and prints what it downloaded, so the install works and the user can see it.
files:
  - packages/plugin-loader/src/plugin-loader.ts (resolver seam, `resolveImportSpecifier`, `isNodeRuntime`)
  - packages/plugin-loader/src/node-remote.ts (NEW — Node fetch-to-temp-file resolver)
  - packages/plugin-loader/src/index.ts (exports the seam)
  - packages/plugin-loader/package.json (`./node` subpath export + `typesVersions`)
  - packages/plugin-loader/test/remote-module.spec.ts (NEW — 15 specs)
  - packages/quereus/src/vtab/manifest.ts (`PluginRecord.sha256`)
  - packages/quoomb-cli/src/plugins/remote-resolver.ts (NEW — CLI resolver install + fetched-hash registry)
  - packages/quoomb-cli/src/bin/quoomb.ts (installs the resolver at startup)
  - packages/quoomb-cli/src/commands/dot-commands.ts (`reconcilePluginHash` + call sites)
  - docs/plugins.md, packages/plugin-loader/README.md
difficulty: medium
----

## What was wrong

`dynamicLoadModule` loaded plugin modules with a bare `import()`. Node's ESM
loader accepts only `file:` and `data:` URLs, so every `https://` plugin load
under Node died with `ERR_UNSUPPORTED_ESM_URL_SCHEME`. The CLI validated the URL
first (`https:` + `.js` passes), so a user was told their address was fine and
then told the load failed for an unrelated reason. Browsers implement
`import('https://…')` natively, so the web UI was unaffected.

## What was built

**A resolver seam in the loader.** `plugin-loader` must stay importable in a
browser and React Native bundle, so it cannot import `node:fs`. Instead it
exposes `setRemoteModuleResolver(resolver | null)` plus the `RemoteModuleResolver`
and `RemoteModuleFetch` types; a host installs one at startup.
`dynamicLoadModule` now routes through `resolveImportSpecifier`:

- `file:` → the existing `?t=` cache-busting, unchanged.
- `https:` + a resolver installed → the resolver supplies the specifier.
- `https:` + Node + no resolver → an error naming the resolver to install,
  instead of `ERR_UNSUPPORTED_ESM_URL_SCHEME`.
- `https:` + browser/worker → direct native import, unchanged (localhost still
  cache-busts).

The manifest probe at the end now uses the **original** URL rather than the
mutated/resolved one — otherwise `new URL('package.json', …)` would resolve
against the temp directory.

**The Node resolver** (`src/node-remote.ts`, reachable only via the
`@quereus/plugin-loader/node` subpath) fetches the module, refuses a redirect
that leaves `https:`, enforces a 5 MiB default cap against both the declared
`content-length` and the bytes actually received, SHA-256s them, writes them to
`<tmpdir>/quereus-plugins-<pid>-<random>/<hash16>-<n>.mjs`, and returns that
file's `file:` URL. The `<n>` counter is load-bearing: a stable path would make a
second load a Node module-registry hit rather than a re-evaluation. Temp files
survive for the process lifetime (plugin stack traces stay resolvable); the
directory is removed on `process.on('exit')`.

**CLI wiring.** `bin/quoomb.ts` installs the resolver at module load, before any
database exists, so config autoload, saved-plugin autoload, and interactive
`.plugin` commands all get it. Each fetch prints one grey line:
`Fetched plugin <url> (83 B, sha256 <full hash>)`. `PluginRecord` gained an
optional `sha256`; `.plugin install` records it and later loads compare, warning
loudly (and continuing) when the code behind a stable URL has changed.

## Use cases to exercise

**The original bug.** With a real plugin URL:
`quoomb` → `.plugin install https://…/plugin.mjs`. Expect the fetch line, then
`Successfully installed plugin: …`. Before this change it always failed.

**Missing-resolver guidance.** Any Node host that has *not* installed the
resolver: `dynamicLoadModule('https://…')` should reject with "not supported by
Node's ESM loader … installNodeRemoteModuleResolver", never with
`ERR_UNSUPPORTED_ESM_URL_SCHEME`.

**Browser/worker path unchanged.** quoomb-web loads plugins from a Web Worker.
Install a plugin from the web UI's plugin modal — it must still work with no
resolver installed.

**Change detection.** Install from a URL, change what the URL serves, restart the
CLI. Expect the warning naming both hashes and suggesting `.plugin reload`; the
recorded hash stays put until the user installs/enables/reloads.

**Reload re-evaluates.** `.plugin reload <name>` twice must run the module body
twice, not serve it from Node's registry.

**Rejections.** Non-200 status, a redirect landing on `http:`, and a body over
`maxBytes` must each reject with a message naming the reason.

## Validation performed

All green: `yarn build`, `yarn test` (whole monorepo), `yarn typecheck`,
`yarn lint`. `packages/plugin-loader` is 88 tests / 5 files (15 new).

Beyond the automated suite, four things were driven by hand:

- **Real network fetch** — `createNodeRemoteResolver()` against
  `https://cdn.jsdelivr.net/npm/tslib@2.8.1/tslib.es6.mjs`: fetched 17,648 bytes,
  hashed, written to a temp file, and successfully `import()`ed.
- **Built artifacts + subpath export** — `@quereus/plugin-loader/node` imported
  from inside `packages/quoomb-cli` against `dist/`, then a full
  `dynamicLoadModule('https://…')` load. (The specs import `../src/`, so they do
  **not** cover the `exports` map.)
- **Full CLI flow** — `.plugin install` → `.plugin list` → autoload unchanged →
  autoload after the URL's content changed, with `USERPROFILE`/`HOME` pointed at
  a temp dir and `fetch` stubbed. Confirmed the record's `sha256`, the silent
  unchanged reload, the warning on change, and that the recorded hash is not
  overwritten by autoload. The throwaway script was deleted.
- **Worker branch** — simulated a DOM-less, `process`-shimmed runtime and
  confirmed the loader takes the direct-import path, not the guidance error.

## Known gaps and things to look hard at

- **The change warning fires *after* the changed code has already executed.**
  `reconcilePluginHash` runs after `dynamicLoadModule` returns — i.e. after the
  module was imported and its `register()` called. So it tells the user their
  plugin changed; it cannot stop the new code from running. The ticket
  deliberately chose warn-don't-block, but the *ordering* is a separate question
  the ticket did not settle. Moving the comparison earlier is possible: the
  resolver awaits `onFetched` **before** the import, so a host that told the
  resolver the expected hash could warn (or refuse) pre-execution. That would
  mean a second channel of per-URL expected-hash state alongside the plugin
  record, which is why it was not done here. Reviewer's call.
- **Deviation from the ticket's file list.** The ticket put the resolver install
  in `bin/quoomb.ts`. It landed in a new `packages/quoomb-cli/src/plugins/remote-resolver.ts`
  instead, because `dot-commands.ts` needs to read back the fetched hash and
  importing `bin/` from `commands/` would be a cycle. `bin/quoomb.ts` just calls
  `installRemotePluginResolver()`.
- **`typesVersions` was required, not just `exports`.** Consumers still compile
  with `moduleResolution: "node"` (node10), which ignores the `exports` map, so
  `@quereus/plugin-loader/node` would not typecheck from `exports` alone. Both
  are in `package.json`, with a `//typesVersions` note saying the shim can go
  once consumers move to node16/bundler resolution.
- **A design bug was caught mid-implementation and is worth re-checking.** The
  ticket's flow said "browser (`resolveEnvironment() === 'browser'`)". That helper
  detects a browser by the presence of `document` — but quoomb-web loads plugins
  from a **Web Worker**, which has no `document` and would therefore have been
  misrouted into the Node branch, breaking browser plugin loading entirely.
  Detection is now `isNodeRuntime()` (`globalThis.process?.versions?.node`), with
  a spec pinning it. Please sanity-check that reasoning; it is the riskiest part
  of the diff.
- **Not covered by automated tests:** the real-network fetch, the browser/worker
  native-import branch, and the CLI `.plugin` command flow — all three were
  verified manually (above) but nothing guards them in CI. The worker branch in
  particular has no test in `quoomb-web`.
- **Content type is logged at debug, never enforced.** Raw-file hosts serve
  JavaScript as `text/plain` often enough that hard-failing would be wrong, but
  it does mean the resolver will happily write and import whatever bytes it got.
- **No on-disk cache.** Every CLI start re-downloads *and re-executes* each saved
  remote plugin. That is intentional (hence the visible fetch line), but it is a
  per-start network round-trip and remote-code execution, so it is worth a
  conscious sign-off rather than passing unnoticed.
- **quoomb-web ignores `sha256`.** The field is optional on the shared
  `PluginRecord`, and the web UI neither sets nor checks it, so browser-side
  installs get no change detection. Not a defect — just an asymmetry.
- **Pre-existing, untouched:** `.plugin install` loads the plugin *before*
  checking whether that URL is already installed, so re-installing an existing
  plugin executes it and then reports "already installed".

## Tripwires recorded

- `packages/plugin-loader/src/node-remote.ts` (`ensureModuleDir`) — `NOTE:` the
  exit handler that removes the temp directory does not run on abrupt
  termination. Confirmed observationally: a vitest pool worker is terminated, so
  each test run leaves one `quereus-plugins-*` directory behind. The OS reclaims
  temp space, so this is not worth a cleanup daemon; if a long-lived host ever
  loads plugins often enough for it to matter, sweep stale directories at
  startup.
- `packages/plugin-loader/src/node-remote.ts` (`writeModuleFile`) and
  `plugin-loader.ts` (`withCacheBuster`) — `NOTE:` every reload leaves the prior
  module version in Node's registry. Fine for a CLI; a long-lived host reloading
  in a loop needs a real unload story.
