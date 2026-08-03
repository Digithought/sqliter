description: A program loading a plugin from a web address can now say up front what the downloaded file should look like, and the loader refuses to run it if it does not match.
files:
  - packages/plugin-loader/src/plugin-loader.ts (`PluginHashMismatchError`, `dynamicLoadModule`)
  - packages/plugin-loader/src/node-remote.ts (`fetchModuleBytes`, `verifyExpectedHash`, `hashRemoteModule`, `NodeRemoteResolverOptions`)
  - packages/plugin-loader/src/index.ts (exports `PluginHashMismatchError`)
  - packages/plugin-loader/test/remote-module.spec.ts
  - packages/plugin-loader/README.md
  - docs/plugins.md (~line 933, the `Behavior:` list under "Programmatic loading")
difficulty: medium
----

## What landed

The Node remote resolver can now be told, per URL, what SHA-256 the fetched
module bytes must have, and it aborts the load before the bytes reach disk or the
module registry when they do not match.

### New public surface

`packages/plugin-loader/src/plugin-loader.ts`:

```ts
export class PluginHashMismatchError extends Error {
	readonly url: string;       // normalized `new URL(x).href`
	readonly expected: string;  // lowercase hex the host required
	readonly actual: string;    // lowercase hex of what was served
}
```

Message: `Plugin module at <url> does not match its pinned SHA-256. Expected <64
hex>, got <64 hex>. Refusing to load it.` — one line, not the two-line block the
implement ticket sketched. Exported from the package index (not the `./node`
subpath) so a host can `instanceof` it without pulling in `node:fs`.

`packages/plugin-loader/src/node-remote.ts`:

```ts
export interface NodeRemoteResolverOptions {
	expectedHash?: (url: string) => string | undefined | Promise<string | undefined>;
	onFetched?: (info: RemoteModuleFetch) => void | Promise<void>;
	maxBytes?: number;
	fetchImpl?: typeof fetch;
}

export async function hashRemoteModule(
	url: URL,
	options?: Pick<NodeRemoteResolverOptions, 'maxBytes' | 'fetchImpl'>
): Promise<RemoteModuleFetch>;
```

`hashRemoteModule` is exported from the `./node` subpath only.

### New order inside the resolver

```
fetchModuleBytes(url, options)          # fetch → redirect check → media-type log → size cap → sha256
  → verifyExpectedHash(...)             # NEW; throws before anything is written
  → writeModuleFile(...)
  → await onFetched(...)
  → return file: URL
```

`fetchModuleBytes` is the extracted transport half; `hashRemoteModule` is that
same call plus a shape conversion, so the two paths cannot drift on redirect
policy or the size cap.

### Verification rules as implemented

| `expectedHash` returns | Result |
| --- | --- |
| absent option, or `undefined` / `null` | not pinned — load proceeds unchanged |
| 64 hex chars (any case, surrounding whitespace trimmed) matching the digest | load proceeds |
| 64 hex chars not matching | `PluginHashMismatchError` |
| anything else — `''`, `deadbeef`, 65 chars, non-hex | plain `Error`, message quotes the offending value; **fails closed**, not read as "unpinned" |
| throws | that error propagates; not degraded to "unpinned" |

`dynamicLoadModule` now rethrows with `{ cause: error }`. Wrapper text is
byte-identical to before (`Failed to load plugin from <url>: <message>`), so
existing assertions on it still hold; callers reach the class through
`error.cause instanceof PluginHashMismatchError`.

## How to exercise it

```ts
import { installNodeRemoteModuleResolver, hashRemoteModule } from '@quereus/plugin-loader/node';
import { dynamicLoadModule, PluginHashMismatchError } from '@quereus/plugin-loader';

installNodeRemoteModuleResolver({
	expectedHash: url => records.get(url)?.sha256,   // undefined ⇒ unpinned
});

try {
	await dynamicLoadModule('https://example.test/plugin.mjs', db);
} catch (e) {
	if ((e as Error).cause instanceof PluginHashMismatchError) { /* pin failed; nothing ran */ }
}

// "what does this URL serve right now?" — fetches, never imports
const { sha256 } = await hashRemoteModule(new URL('https://example.test/plugin.mjs'));
```

## Validation run

- `yarn workspace @quereus/plugin-loader test` — 5 files, 115 tests, all pass.
- `yarn build` — clean.
- `yarn typecheck` (root, all workspaces) — clean.
- `yarn test` (root, all workspaces) — clean, ~5m18s. No pre-existing failures
  surfaced, so `tickets/.pre-existing-error.md` was not written.

## Test coverage added (`test/remote-module.spec.ts`)

Two new describes — `expectedHash pinning` and `hashRemoteModule` — plus one
`cause` case appended to `resolver rejections`:

- matching pin loads and the plugin's `register()` receives its config
- uppercase + whitespace-padded pin matches
- `expectedHash` is consulted **per call** (asked twice for two loads) and is
  asked with the **normalized** href (fed `https://Plugins.Example.Test/…`,
  observed `https://plugins.example.test/…`)
- mismatch: `instanceof PluginHashMismatchError`, `url`/`expected`/`actual`
  fields correct, message contains the URL and both digests
- mismatch leaves the module-evaluation counter at **0**, calls `onFetched`
  **zero** times, and adds **no file** to the resolver's temp directory
- mismatch through `dynamicLoadModule`: message still contains
  `Failed to load plugin from <url>:` **and** `cause instanceof PluginHashMismatchError`
- malformed pins (`deadbeef`, 64 non-hex chars, `''`, 66 hex chars) each rejected
  with the bad value quoted
- `expectedHash` that throws propagates, counter stays 0
- empty body: pinned to the zero-byte digest it loads, mispinned it throws — so
  no falsy-length short-circuit
- guard ordering: HTTP 404, an http: redirect, and an over-cap body each win over
  a (wrong) pin
- regression: an unpinned load, and an `expectedHash` returning `undefined`, both
  behave exactly as before including `onFetched` firing with the right digest
- `hashRemoteModule`: same digest and byte count the resolver produces (and that
  digest then satisfies a real pinned load), counter stays 0, writes no temp
  file, enforces `maxBytes`, refuses an http: redirect

## Known gaps / things worth a reviewer's attention

- **Nothing is wired to this yet.** The CLI still does its post-load hash
  comparison and still only warns. Tickets `feat-cli-plugin-pinning` and
  `feat-config-declared-plugin-hashes` are the consumers; this ticket
  deliberately changed no CLI code.
- **`String(expected)` coercion in `verifyExpectedHash`** is deliberate defence
  against an untyped JS host returning a non-string (a number would otherwise
  throw `TypeError: expected.trim is not a function` instead of the quoted-value
  message). It is redundant against the declared type — a reviewer may reasonably
  want it gone.
- **No test asserts that `expectedHash` is *not* invoked** when the fetch fails
  earlier (404, http: redirect, over-cap). The ordering tests prove the transport
  error wins, not that the callback stayed untouched. Cheap to add if wanted.
- **The "wrote no temp file" assertions** discover the resolver's temp directory
  by doing one successful fetch and taking `dirname` of the returned path — the
  directory is a module-private singleton with no accessor. Parked as a `NOTE:`
  on the `moduleTempDir` helper in the spec: if the resolver ever writes
  somewhere other than the directory of the path it returns, those assertions
  compare an unrelated directory and pass vacuously.
- **Browser/worker path is untested here** (no DOM in this runner) and by design
  gets no verification at all — no resolver is installed there, so
  `import('https://…')` runs natively unchecked. Stated in both README and
  `docs/plugins.md` so a host does not sell pinning as universal.
- **`file:` URLs never reach the resolver**, so a pin on one is inert. Also
  documented in both places; there is no code guard against a host trying it,
  because the resolver simply is not consulted.
- **`hashRemoteModule` is a second, separate fetch** from any load that follows.
  Documented on the function and in the docs. Bytes changing in between make the
  subsequent pinned load fail, which is fail-closed — but a host that presents
  the digest as a promise about the next load is wrong.

## Docs updated

- `packages/plugin-loader/README.md` — the `https:` section now shows
  `expectedHash` beside `onFetched`, states that verification is opt-in and
  Node-only, shows the `error.cause` check, and describes `hashRemoteModule`.
- `docs/plugins.md` — the resolver bullet mentions the verify step; a new
  **Hash pinning gates the load, and is opt-in** bullet covers the rules, the
  `cause` channel, and the scope limits. The "no on-disk cache, re-downloads
  every start" point was kept and moved back under the resolver bullet where it
  belongs; the CLI paragraph now says the CLI warning is still post-load and
  names `expectedHash` as what would turn it into a gate.
