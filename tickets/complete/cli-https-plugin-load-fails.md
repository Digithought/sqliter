----
description: Installing a plugin from a web address in the command-line tool used to always fail. It now downloads the plugin to a temporary file first and prints what it downloaded, so the install works and the user can see it.
files:
  - packages/plugin-loader/src/plugin-loader.ts (resolver seam, `resolveImportSpecifier`, `isNodeRuntime`)
  - packages/plugin-loader/src/node-remote.ts (Node fetch-to-temp-file resolver)
  - packages/plugin-loader/src/index.ts (exports the seam)
  - packages/plugin-loader/package.json (`./node` subpath export + `typesVersions`)
  - packages/plugin-loader/test/remote-module.spec.ts
  - packages/quereus/src/vtab/manifest.ts (`PluginRecord.sha256`)
  - packages/quoomb-cli/src/plugins/remote-resolver.ts (CLI resolver install + fetched-hash registry)
  - packages/quoomb-cli/src/bin/quoomb.ts, src/index.ts (install the resolver at startup)
  - packages/quoomb-cli/src/commands/dot-commands.ts (`reconcilePluginHash` + call sites)
  - packages/quoomb-cli/test/remote-resolver.spec.ts, tsconfig.test.json
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

## What shipped

**A resolver seam in the loader.** `plugin-loader` must stay importable in a
browser and React Native bundle, so it cannot import `node:fs`. It exposes
`setRemoteModuleResolver(resolver | null)` plus the `RemoteModuleResolver` and
`RemoteModuleFetch` types; a host installs one at startup. `dynamicLoadModule`
routes through `resolveImportSpecifier`:

- `file:` → the existing `?t=` cache-busting, unchanged.
- `https:` + a resolver installed → the resolver supplies the specifier.
- `https:` + Node + no resolver → an error naming the resolver to install,
  instead of `ERR_UNSUPPORTED_ESM_URL_SCHEME`.
- `https:` + browser/worker → direct native import, unchanged (localhost still
  cache-busts).

Runtime detection is `isNodeRuntime()` (`globalThis.process?.versions?.node`),
*not* the DOM-presence check `resolveEnvironment()` uses — quoomb-web loads
plugins from a Web Worker, which has no `document` but imports `https:` natively.
The manifest probe uses the **original** URL, not the resolved temp file.

**The Node resolver** (`src/node-remote.ts`, behind the
`@quereus/plugin-loader/node` subpath) fetches the module, refuses a redirect
that leaves `https:`, enforces a 5 MiB default cap against both the declared
`content-length` and the bytes actually received, SHA-256s them, writes them to
`<tmpdir>/quereus-plugins-<pid>-<random>/<hash16>-<n>.mjs`, and returns that
file's `file:` URL. The `<n>` counter keeps a reload from becoming a Node
module-registry hit. Temp files survive for the process lifetime; the directory is
removed on `process.on('exit')`.

**CLI wiring.** `installRemotePluginResolver()` runs from both entry points
(`bin/quoomb.ts` and the package index) before any database exists, so config
autoload, saved-plugin autoload, and interactive `.plugin` commands all get it.
Each fetch prints one grey line: `Fetched plugin <url> (83 B, sha256 <hash>)`.
`PluginRecord` gained an optional `sha256`; `.plugin install` records it and later
loads compare, warning loudly (and continuing) when the code behind a stable URL
has changed.

## Review findings

**Checked:** the full implement diff read before the handoff summary; the resolver
seam's four routing branches; `isNodeRuntime()` versus the pre-existing
`resolveEnvironment()`; every `reconcilePluginHash` call site and its save
semantics; the byte-cap, redirect, and media-type paths in `node-remote.ts`; temp
file and module-registry lifetime; the `./node` subpath export and `typesVersions`
shim; who else in the monorepo loads plugins under Node (only quoomb-cli — the
VS Code extension does not load plugins); every doc the change touches plus
`quoomb-cli/README.md` and `docs/store.md` for stale "browser only" claims (none
left); `yarn build`, `yarn test` (whole monorepo), `yarn typecheck`, `yarn lint`
— all green, 94 plugin-loader specs and 10 quoomb-cli specs.

**Confirmed sound.** The riskiest judgment call in the diff — detecting Node by
`process.versions.node` rather than the absence of `document` — is correct.
quoomb-web's plugin loads all originate in `packages/quoomb-web/src/worker/quereus.worker.ts`,
which has no `document`; the DOM check would have routed it into the Node branch
and broken browser plugin loading outright. A bundler's `process` shim declares no
`versions.node`, so it does not trip the check either. Both halves are pinned by
specs.

**Fixed in this pass (minor):**

- *Hash lookup missed when the user's URL was not already canonical.* The fetched-hash
  registry was keyed on `URL.href` (what the loader hands the resolver) but read
  with the raw string a plugin record holds. `https://Example.test:443/p.mjs`
  installs, and change detection is then silently dead for that record. Both sides
  now normalize through `new URL(url).href`.
  (`packages/quoomb-cli/src/plugins/remote-resolver.ts`)
- *Resolver not installed for an embedder.* The install call was only in
  `bin/quoomb.ts`, so anything importing `REPL`/`DotCommands` from
  `@quereus/quoomb-cli` — the package's own public entry — got the
  "install a resolver" error. `src/index.ts` now installs it too;
  `installRemotePluginResolver()` is idempotent.
- *`fetch` captured too early.* `createNodeRemoteResolver` resolved
  `globalThis.fetch` at construction, so a host installing the resolver at startup
  and a `fetch` polyfill afterwards would use the wrong one. Now resolved per call.
- *Startup auto-disable said nothing.* `loadEnabledPlugins` flips a plugin to
  `enabled: false` on any load failure but printed only "Failed to load". The
  message now says it was disabled and (when a manifest name exists) how to
  re-enable. The disable *policy* itself is a separate ticket, below.
- *Test gaps closed.* The browser/worker native-import branch had no test — it
  cannot be reached through `dynamicLoadModule` under Node, so
  `resolveImportSpecifier` is now `@internal`-exported and five specs pin the
  routing (native https, localhost cache-bust, `file:` never consulting the
  resolver, resolver-wins-outside-Node, caller's URL not mutated). Added a spec for
  the unparseable-redirect-target branch. New `packages/quoomb-cli/test/remote-resolver.spec.ts`
  covers the CLI wiring end to end with `fetch` stubbed — an https load that bare
  `import()` cannot do, the announcement line, the recorded hash, and the
  normalization fix — and, by importing `@quereus/plugin-loader/node`, is the first
  automated coverage of that subpath export (previously verified only by hand).
- *quoomb-cli test files were never type-checked.* The package had no `typecheck`
  script at all, so `tsconfig.json`'s `src/`-only include left `test/` unchecked
  and vitest transpiles without checking. Added `tsconfig.test.json` +
  `typecheck` script, matching `plugin-loader`'s arrangement per AGENTS.md.

**Filed as tickets (major / out of scope here):**

- `backlog/feat-remote-plugin-verify-before-execute` — the change warning fires
  after the changed code has already been imported and registered, so it can
  notify but never gate. The implementer flagged this and left the call to review.
  Warn-don't-block stays the default; opt-in pre-execution verification (comparing
  inside the awaited `onFetched`) is a real capability with a real design cost
  (per-URL expected-hash state at fetch time), so it gets its own ticket rather
  than a rushed inline change.
- `backlog/bug-cli-autoload-disables-plugin-after-one-failed-load` — startup
  auto-disable was harmless when plugins could only come from an npm package or a
  `file:` URL, both of which fail deterministically. With remote plugins, one
  offline start permanently disables the plugin. Choosing between never-disable,
  disable-only-on-plugin-fault, and disable-after-N is a policy decision worth its
  own ticket.
- `backlog/bug-cli-plugin-commands-unusable-without-manifest` — pre-existing, but
  newly easy to hit: every `.plugin` subcommand except `install`/`list` looks
  records up by `manifest?.name`, and a module URL with no sibling `package.json`
  yields no manifest. Such a plugin cannot be enabled, disabled, reloaded,
  configured, or uninstalled from the CLI at all.
- `backlog/debt-plugin-loader-worker-environment-detection` — the same
  worker-misdetection bug the implementer fixed for `dynamicLoadModule` still
  exists in `resolveEnvironment()`/`isBrowserEnv()`, which `loadPlugin` uses for
  npm specs. Dormant (nothing calls `loadPlugin` from a worker today) but wrong the
  moment that path runs, so it is a ticket rather than a tripwire.

**Recorded as tripwires, not tickets** (all `NOTE:` comments at the site):

- Post-load ordering of the hash comparison — `reconcilePluginHash`'s doc comment
  in `dot-commands.ts` now states that every call site runs after the import, and
  where the check would have to move to become a gate. Indexes the feature ticket
  above.
- Temp-directory cleanup does not run on abrupt termination (`ensureModuleDir` in
  `node-remote.ts`) — carried over from implement; confirmed observationally, since
  each vitest run leaves one `quereus-plugins-*` directory behind. OS temp
  reclamation covers it.
- Every reload leaves the prior module version in Node's registry (`writeModuleFile`
  and `withCacheBuster`) — carried over from implement. Fine for a CLI; a
  long-lived host reloading in a loop needs a real unload story.

**Accepted as-is, deliberately:**

- *No on-disk cache; every CLI start re-downloads and re-executes each saved remote
  plugin.* Signed off. It is the reason the fetch line is printed rather than
  silent, and installing a plugin from a URL is already an act of trusting that
  URL. `docs/plugins.md` states it plainly. The narrower "trustworthy when
  installed, not anymore" case is what the feature ticket covers.
- *Content type logged at debug, never enforced.* Raw-file hosts serve JavaScript
  as `text/plain` often enough that hard-failing would be wrong.
- *quoomb-web neither sets nor checks `PluginRecord.sha256`.* An asymmetry, not a
  defect — the field is optional and browser installs get no change detection.
- *`typesVersions` alongside `exports`.* Required, not redundant: consumers still
  compile with `moduleResolution: "node"` (node10), which ignores `exports`. The
  `//typesVersions` note says the shim can go once consumers move to node16/bundler
  resolution.
- *Resolver as a module-level singleton rather than a `dynamicLoadModule` option.*
  Reviewed and agreed: the loader has call sites across the CLI and the web worker,
  and the specs reset it in `afterEach`, so the global state is contained.

**Docs.** `docs/plugins.md` and `packages/plugin-loader/README.md` were updated by
the implement pass and are accurate; this pass verified no other file still claims
`https:` loads are browser-only, and added one clause to `docs/plugins.md` making
the after-the-fact nature of the change warning explicit rather than implied.

**Nothing found in:** resource cleanup beyond the two recorded tripwires; the
byte-cap logic (both the declared-`content-length` and actual-bytes paths are
correct and now both tested); error handling (no swallowed exceptions — the one
`catch` that logs-and-continues is the reader-cancel path, which rethrows); type
safety (no `any`, no unsafe casts beyond the two documented `globalThis` probes);
source hygiene (both new files are single-purpose, functions are short, comments
explain *why*).

## Validation

`yarn build`, `yarn test` (whole monorepo — 7338 + all workspace suites passing,
no failures), `yarn typecheck`, `yarn lint`: all green after the review changes.
`packages/plugin-loader` is 94 tests / 5 files; `packages/quoomb-cli` is 10 tests /
2 files.

Still not covered by automated tests, and unchanged from implement: a real network
fetch, and the browser-side load path inside an actual worker. Both were verified
by hand during implement. The worker branch is now pinned at the specifier-routing
level (`resolveImportSpecifier` with a non-Node `process`), which is as close as a
Node test runner can get.
