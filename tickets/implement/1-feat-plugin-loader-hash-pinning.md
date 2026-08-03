----
description: When a plugin is downloaded from a web address, add a way for the program loading it to say up front what the downloaded file should look like, and refuse to run it if it does not match.
files:
  - packages/plugin-loader/src/node-remote.ts (`createNodeRemoteResolver`, `NodeRemoteResolverOptions`, `writeModuleFile`)
  - packages/plugin-loader/src/plugin-loader.ts (`dynamicLoadModule`, `RemoteModuleFetch`)
  - packages/plugin-loader/src/index.ts (public exports)
  - packages/plugin-loader/test/remote-module.spec.ts
  - packages/plugin-loader/README.md ("Loading plugins over `https:` in Node")
  - docs/plugins.md (line ~951, the paragraph describing the post-load hash warning)
difficulty: medium
----

## Where things stand

Node cannot `import()` an `https:` URL, so a Node host installs a resolver
(`@quereus/plugin-loader/node`) that downloads the module to a temp file and
hands the loader that file's `file:` URL. The resolver already SHA-256s the bytes
it downloaded and reports the digest through an `onFetched` callback that is
awaited *before* the import.

What the resolver cannot do today is compare that digest against anything: it has
no idea what the host expected. The only comparison in the codebase lives in the
quoomb CLI and runs after `dynamicLoadModule` has returned — by which point the
module was imported and its registration function ran. It is a change notice, not
a gate.

This ticket adds the missing channel in `@quereus/plugin-loader` only. Wiring the
CLI's saved plugin records to it is a separate ticket
(`feat-cli-plugin-pinning`), and config-file-declared hashes another
(`feat-config-declared-plugin-hashes`).

## What to build

### 1. An expected-hash channel on the Node resolver

```ts
export interface NodeRemoteResolverOptions {
	/**
	 * The SHA-256 (hex) this URL's module bytes must hash to, or undefined when
	 * the host does not pin this URL. Consulted on every fetch; a mismatch
	 * aborts the load before the module is written to disk or imported.
	 */
	expectedHash?: (url: string) => string | undefined | Promise<string | undefined>;

	onFetched?: (info: RemoteModuleFetch) => void | Promise<void>;
	maxBytes?: number;
	fetchImpl?: typeof fetch;
}
```

Resolve `options.expectedHash` per call, not at construction — same reason
`fetchImpl` is resolved per call: a host installs the resolver at startup, before
it has read the state that tells it what to pin.

The callback receives the **normalized** `url.href` (what `new URL(x).href`
produces), because that is what the loader hands the resolver. A host whose own
key is the raw user-typed string must normalize on its side.

### 2. Verify before the module reaches disk

New order inside the resolver:

```
fetch → redirect check → size cap → sha256 → VERIFY → write temp file → onFetched → return file: URL
```

Verification currently has no place in that chain at all; note that it goes
*before* `writeModuleFile` and *before* `onFetched`. On a mismatch nothing is
written, `onFetched` never fires, and no import is attempted.

Verification rules:

- `expectedHash` returns `undefined`/`null` → not pinned, continue. This is the
  default and keeps every existing caller behaving exactly as it does today.
- Compare case-insensitively after trimming: a host that stores uppercase hex
  still matches.
- An expected value that is not 64 hex characters is a **host bug, and it fails
  closed** — throw a plain `Error` naming the URL and the offending value.
  Silently treating it as "no pin" would turn a typo into an unprotected load.
- A mismatch throws `PluginHashMismatchError` (below).
- If `expectedHash` itself throws, let it propagate. Do not swallow it into "not
  pinned".

### 3. A recognizable error type

```ts
/** Fetched plugin bytes did not match the SHA-256 the host pinned for that URL. */
export class PluginHashMismatchError extends Error {
	readonly url: string;
	/** Lowercase hex the host required. */
	readonly expected: string;
	/** Lowercase hex of what was actually served. */
	readonly actual: string;
}
```

Define it in `plugin-loader.ts` (not `node-remote.ts`) and export it from the
package index: it is a plain `Error` subclass with no `node:` imports, and a host
needs to `instanceof` it without reaching into the Node-only subpath.

Message shape — must name both hashes and the URL:

```
Plugin module at https://x.example/p.mjs does not match its pinned SHA-256.
Expected <64 hex>, got <64 hex>. Refusing to load it.
```

### 4. Preserve the cause through `dynamicLoadModule`

`dynamicLoadModule` currently flattens every failure:

```ts
throw new Error(`Failed to load plugin from ${url}: ${message}`);
```

which destroys the class, so no caller can tell a hash mismatch from a 404. Pass
the original through:

```ts
throw new Error(`Failed to load plugin from ${url}: ${message}`, { cause: error });
```

The wrapper text stays identical — existing specs assert on it. Callers then
check `error.cause instanceof PluginHashMismatchError`.

### 5. Hash a remote module without importing it

The CLI needs to answer "what does this URL serve right now?" so a user can adopt
a new version deliberately, without executing the new code to find out. Extract
the fetch/redirect/cap/hash chain the resolver already runs into a shared helper
and expose it:

```ts
/**
 * Fetches a remote plugin module and returns its digest — same transport checks
 * and size cap as the resolver, but nothing is written to disk and nothing is
 * imported.
 */
export function hashRemoteModule(
	url: URL,
	options?: Pick<NodeRemoteResolverOptions, 'maxBytes' | 'fetchImpl'>
): Promise<RemoteModuleFetch>;
```

Reuse the existing `RemoteModuleFetch` shape (`{ url, sha256, bytes }`) rather
than introducing a parallel type. Exported from the `./node` subpath, not the
package index — it fetches, but it is Node-side plumbing that sits beside the
resolver.

Callers must understand this is a *separate* fetch from the load that follows it:
the bytes can change in between, and then the pinned load fails. That fails
closed, which is the right direction, but say so in the doc comment.

## Edge cases & interactions

- **No `expectedHash` supplied** — every existing behavior unchanged. This is the
  regression that matters most; assert it explicitly rather than assuming.
- **Mismatch never evaluates the module.** A fixture whose module body increments
  a global counter must leave that counter at 0 after a rejected load. A test
  that only asserts on the thrown message would still pass if the import ran.
- **Mismatch does not call `onFetched`** and writes no temp file.
- **Uppercase / whitespace-padded expected hash** matches.
- **Malformed expected hash** (short, non-hex, empty string) is refused with a
  message naming the value — not treated as "no pin".
- **`expectedHash` throws** → the load fails with that error.
- **Ordering against the other guards**: an http: redirect or an over-cap body is
  rejected before hashing, so those messages still win. A pinned URL that 404s
  reports the HTTP failure, not a hash mismatch.
- **`file:` URLs never reach the resolver** (`resolveImportSpecifier` returns
  early), so a pin on one is inert. Document it; hosts must not present pinning
  as protecting local files.
- **Browser/worker path is unaffected** — no resolver is installed there, so
  `import('https://…')` still runs natively with no verification. Say so in the
  docs rather than leaving a reader to assume the guarantee is universal.
- **`hashRemoteModule` applies the same size cap and redirect check** as the
  resolver; a host must not be able to use it to slurp an unbounded body.
- **Empty-body response**: hashes to the SHA-256 of zero bytes and compares like
  any other. Not a special case; just don't let a falsy-length check short-circuit
  verification.

## TODO

- Add `PluginHashMismatchError` to `plugin-loader.ts` with `url` / `expected` /
  `actual` fields; export from `index.ts`.
- Add `{ cause: error }` to the `dynamicLoadModule` catch-and-rethrow, leaving the
  message text as-is.
- Add `expectedHash` to `NodeRemoteResolverOptions`, resolved per call.
- Extract the fetch → redirect check → size cap → sha256 chain out of
  `createNodeRemoteResolver` into a shared internal helper.
- Add the verification step between hashing and `writeModuleFile`; make the
  malformed-pin case throw rather than pass.
- Export `hashRemoteModule` from `node-remote.ts` on top of the shared helper.
- Extend `packages/plugin-loader/test/remote-module.spec.ts`:
  - matching pin loads and runs the plugin as usual
  - mismatching pin rejects; message contains the URL and both hashes
  - mismatching pin leaves the module-evaluation counter at 0 and `onFetched`
    uncalled
  - uppercase/padded pin matches
  - malformed pin refused, message quotes the bad value
  - absent pin behaves exactly as before (regression)
  - through `dynamicLoadModule`: message still starts `Failed to load plugin from
    <url>:` and `error.cause instanceof PluginHashMismatchError`
  - `hashRemoteModule` returns the same digest the resolver would, imports
    nothing (counter stays 0), and enforces `maxBytes`
- Update `packages/plugin-loader/README.md`'s https section: show `expectedHash`
  alongside `onFetched`, and state that verification is opt-in and that browsers
  do not get it.
- Update `docs/plugins.md` (~line 951): the paragraph currently ends "A host that
  wants to gate on the hash must compare inside `onFetched`…" — replace with the
  `expectedHash` channel, keeping the "no on-disk cache, re-downloads every start"
  point intact.
- `yarn workspace @quereus/plugin-loader test`, then `yarn build` and
  `yarn typecheck` from the root.
