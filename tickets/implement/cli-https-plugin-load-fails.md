description: Installing a plugin from a web address in the command-line tool always fails. Make it work by downloading the plugin to a local file first, and show the user what was downloaded.
files:
  - packages/plugin-loader/src/plugin-loader.ts (`dynamicLoadModule`, `validatePluginUrl`, `ALLOWED_PLUGIN_PROTOCOLS`, `resolveEnvironment`)
  - packages/plugin-loader/src/node-remote.ts (NEW — Node fetch-to-temp-file resolver)
  - packages/plugin-loader/src/index.ts (export the seam types/setter)
  - packages/plugin-loader/src/manifest.ts (`PluginRecord` — add recorded hash)
  - packages/plugin-loader/package.json (add `./node` subpath export; refresh the `//test` gap note)
  - packages/plugin-loader/test/remote-module.spec.ts (NEW)
  - packages/plugin-loader/test/helpers/plugin-fixtures.ts (reuse `capturePluginSource`, `writeTempModule`)
  - packages/quoomb-cli/src/bin/quoomb.ts (install the resolver at startup)
  - packages/quoomb-cli/src/commands/dot-commands.ts (`installPluginCommand`, `loadEnabledPlugins`, `reloadPluginCommand`)
  - packages/quoomb-web/src/worker/quereus.worker.ts (browser caller — must keep working, no change expected)
  - docs/plugins.md (§ Installation & loading)
  - packages/plugin-loader/README.md
difficulty: medium
----

## Reproduced

Node v24.2.0, repo root:

```
$ node -e "import('https://example.com/plugin.js').catch(e=>console.log(e.code,'|',e.message))"
ERR_UNSUPPORTED_ESM_URL_SCHEME | Only URLs with a scheme in: file and data are supported by the default ESM loader. Received protocol 'https:'
```

That is the whole bug. `dynamicLoadModule` (`plugin-loader.ts:119`) loads with a
bare `import()`. Node's ESM loader accepts only `file:` and `data:`; network
imports were behind `--experimental-network-imports` and have been removed. The
CLI's `.plugin install` (`dot-commands.ts:414-423`) validates the URL — `https:`
+ `.js` passes — then hands it straight to that `import()`, so the user is told
their address is fine and immediately told the load failed for an unrelated
reason. Browsers implement `import('https://…')` natively, so
`quereus.worker.ts:540` is unaffected.

## Decision: support it

Of the two options the fix ticket left open, **support it**. Reasons:

- The CLI already advertises `https://` in its own error text and its
  `.plugin install <url>` usage line; the web UI does it for real. Removing the
  capability from Node leaves the two front ends gratuitously different.
- Typing `.plugin install <url>` *is* the consent to fetch and run that code —
  the fix is to make the fetch visible and identifiable, not to forbid it.
- The loader already performs a network `fetch` under Node today
  (`tryLoadManifestFromUrl`), so "the loader does not touch the network in Node"
  is not an invariant we would be breaking.

`validatePluginUrl` therefore stays exactly as it is — `https:` remains valid in
both environments, and no environment parameter is needed.

## Design

### The seam

`plugin-loader` must stay importable in a browser bundle and in React Native, so
it cannot import `node:fs`. Introduce an injectable resolver instead, set once by
the host.

```ts
// plugin-loader.ts

/** Metadata about a module fetched from the network, for display/recording. */
export interface RemoteModuleFetch {
	/** The URL requested (before redirects). */
	url: string;
	/** SHA-256 of the fetched bytes, lowercase hex. */
	sha256: string;
	/** Size of the fetched module in bytes. */
	bytes: number;
}

/**
 * Turns an `https:` module URL into a URL this runtime's `import()` can load.
 * Node hosts install one (see `@quereus/plugin-loader/node`); browsers need
 * none, because `import('https://…')` works natively there.
 */
export type RemoteModuleResolver = (url: URL) => Promise<string>;

export function setRemoteModuleResolver(resolver: RemoteModuleResolver | null): void;
```

Module-level singleton, deliberately: `dynamicLoadModule` has nine call sites in
the CLI alone, and threading an option through all of them buys nothing.

### `dynamicLoadModule` flow

Order of operations inside the existing try block:

1. Parse URL, enforce `ALLOWED_PLUGIN_PROTOCOLS` (unchanged).
2. Keep the *original* URL aside — the manifest fetch at the end must use it,
   not the resolved local path, or `new URL('package.json', …)` resolves against
   the temp directory. This is a real behaviour change to guard: today
   `tryLoadManifestFromUrl` is handed the mutated `moduleUrl`.
3. Decide the import specifier:
   - `file:` → existing cache-busting `?t=` behaviour, unchanged.
   - `https:` + browser (`resolveEnvironment() === 'browser'`) → import directly,
     unchanged (localhost cache-busting stays).
   - `https:` + node + resolver installed → `await resolver(moduleUrl)`.
   - `https:` + node + no resolver → throw a message that says why and what to
     do, e.g.:

     > Loading a plugin over https:// is not supported by Node's ESM loader.
     > Install the Node resolver (`installNodeRemoteModuleResolver()` from
     > `@quereus/plugin-loader/node`), or load the plugin from an installed npm
     > package or a `file://` URL.

4. `import()` the resolved specifier; validate; register; then
   `tryLoadManifestFromUrl(originalUrl)`.

### The Node resolver (`src/node-remote.ts`)

New file, reachable only through the new `./node` subpath export, so no browser
bundle ever pulls in `node:fs`.

```ts
export interface NodeRemoteResolverOptions {
	/** Called after each successful fetch — hosts use it to print/record the hash. */
	onFetched?: (info: RemoteModuleFetch) => void | Promise<void>;
	/** Reject modules larger than this. Default 5 MiB. */
	maxBytes?: number;
	/** Injected for tests; defaults to global fetch. */
	fetchImpl?: typeof fetch;
}

export function createNodeRemoteResolver(options?: NodeRemoteResolverOptions): RemoteModuleResolver;

/** Convenience: creates a resolver and installs it via setRemoteModuleResolver. */
export function installNodeRemoteModuleResolver(options?: NodeRemoteResolverOptions): void;
```

Behaviour, in order:

- `fetch(url)`; non-`ok` → throw naming the status and the URL.
- Re-check `response.url` after redirects — if the final URL is not `https:`,
  refuse. `fetch` follows cross-protocol redirects, so an https→http downgrade
  is otherwise silent.
- Read the body with a size cap (`maxBytes`, default 5 MiB); check
  `content-length` when present *and* the actual byte count, so a lying or
  absent header cannot bypass it.
- Content type: log at debug if it is not JavaScript-ish; do **not** hard-fail —
  plenty of raw-file hosts serve `text/plain`.
- SHA-256 the bytes (`node:crypto`), hex.
- Write to `<os.tmpdir()>/quereus-plugins-<pid>/<sha256 first 16>-<n>.mjs`, where
  `<n>` is a per-process counter. The counter matters: without it a second load
  of an unchanged URL produces the same specifier and Node serves the module from
  its registry instead of re-evaluating, which is exactly what the existing
  `?t=` cache-buster exists to avoid.
- Register one `process.once('exit', …)` that `rmSync`s the directory. Do not
  unlink immediately after import — keeping the file for the process lifetime
  keeps plugin stack traces resolvable.
- Await `onFetched` before returning.
- Carry the same NOTE as the existing cache-buster: every reload leaves the prior
  module version in Node's registry. Fine for a CLI; a long-lived host that
  reloads in a loop needs a real unload story.

### CLI wiring

- `bin/quoomb.ts`: call `installNodeRemoteModuleResolver({ onFetched })` once,
  before any database is created — it must be in place for
  `loadPluginsFromConfig` (`config-loader.ts:131`), `loadEnabledPlugins`, and the
  interactive `.plugin` commands alike.
- `onFetched` prints one visible line per remote fetch, e.g.
  `Fetched plugin https://… (12.4 KB, sha256 a1b2c3…)`. This is the point: a
  saved plugin re-downloads and re-executes remote code on *every* CLI start via
  `loadEnabledPlugins`, and that should never be silent.
- Add `sha256?: string` to `PluginRecord` (`manifest.ts`). `installPluginCommand`
  records the hash of what it installed; later loads compare and, on a mismatch,
  print a loud warning naming both hashes. Warn and continue — do not block.
  Pinning/refusal is a bigger policy call than this ticket should make.
- Leave the `.plugin install <url>` usage text and the
  `Must be https:// or file:// URL…` message as they are — they are now accurate.

## Test plan

New `packages/plugin-loader/test/remote-module.spec.ts`, using `fetchImpl`
injection so nothing touches the network. This closes the "no test covers an
`https:` module load" gap the fix ticket flagged.

- Resolver returns a `file:` URL, and `dynamicLoadModule('https://…')` with it
  installed loads the module and passes config through (reuse
  `capturePluginSource` from `test/helpers/plugin-fixtures.ts`).
- Two successive loads of the same URL both evaluate the module (distinct
  specifiers) — guards the counter.
- The reported `sha256` matches the fetched bytes; `onFetched` is awaited.
- Non-`ok` status rejects with the status in the message.
- A response whose final `url` is `http:` rejects.
- A body over `maxBytes` rejects.
- With no resolver installed, `dynamicLoadModule('https://…')` under Node rejects
  with the guidance message (not `ERR_UNSUPPORTED_ESM_URL_SCHEME`).
- `afterEach` must `setRemoteModuleResolver(null)` — the singleton leaks across
  specs otherwise.

Existing `plugin-url.spec.ts` should keep passing untouched.

## TODO

Phase 1 — loader seam
- Add `RemoteModuleResolver`, `RemoteModuleFetch`, `setRemoteModuleResolver` to `plugin-loader.ts`; export from `index.ts`
- Rework `dynamicLoadModule`'s specifier selection per the flow above
- Fix the manifest fetch to use the original URL, not the resolved/mutated one

Phase 2 — Node resolver
- Add `src/node-remote.ts` with `createNodeRemoteResolver` / `installNodeRemoteModuleResolver`
- Add the `./node` subpath (`types` + `import`) to `packages/plugin-loader/package.json` exports; confirm `tsc` emits `dist/src/node-remote.js`

Phase 3 — CLI wiring
- Install the resolver in `bin/quoomb.ts` with a printing `onFetched`
- Add `sha256?: string` to `PluginRecord`; record on install, compare + warn on later loads

Phase 4 — tests
- Write `test/remote-module.spec.ts`
- `yarn workspace @quereus/plugin-loader test` and `yarn workspace @quereus/plugin-loader typecheck`
- `yarn build` (project references — the new subpath must resolve for quoomb-cli)

Phase 5 — docs
- `docs/plugins.md` § Installation & loading: replace the "**`https:` module loads work in the browser only**" bullet (currently line ~896) and the "Browser only" annotation on example 2a with the new Node behaviour, including the fetch-to-temp-file mechanism and the visible-hash line
- `packages/plugin-loader/README.md`: same correction
- `packages/plugin-loader/package.json`: update the `//test` note — https loads are now covered; the remaining gaps are the real-network manifest fetch and the browser+CDN path
- Note in both docs that any other Node host wanting remote plugins installs the same resolver
