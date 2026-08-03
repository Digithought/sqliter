----
description: A program loading a plugin from a web address can now say up front what the downloaded file should look like, and the loader refuses to run it if it does not match.
files:
  - packages/plugin-loader/src/plugin-loader.ts (`PluginHashMismatchError`, `dynamicLoadModule`)
  - packages/plugin-loader/src/node-remote.ts (`fetchModuleBytes`, `verifyExpectedHash`, `hashRemoteModule`, `discardBody`, `NodeRemoteResolverOptions`)
  - packages/plugin-loader/src/index.ts (exports `PluginHashMismatchError`)
  - packages/plugin-loader/test/remote-module.spec.ts
  - packages/plugin-loader/README.md
  - docs/plugins.md (~line 933, the `Behavior:` list under "Programmatic loading")
----

## What shipped

The Node remote resolver can be told, per URL, what SHA-256 the fetched module
bytes must have, and it aborts the load before the bytes reach disk, `onFetched`,
or the module registry when they do not match.

### Public surface

`@quereus/plugin-loader` (package index):

```ts
export class PluginHashMismatchError extends Error {
	readonly url: string;       // normalized `new URL(x).href`
	readonly expected: string;  // lowercase hex the host required
	readonly actual: string;    // lowercase hex of what was served
}
```

It lives in `plugin-loader.ts`, not `node-remote.ts`, so a host can `instanceof`
it without pulling in `node:fs`.

`@quereus/plugin-loader/node`:

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

### Resolver order

```
fetchModuleBytes(url, options)   # fetch → redirect check → media-type log → size cap → sha256
  → verifyExpectedHash(...)      # throws before anything is written
  → writeModuleFile(...)
  → await onFetched(...)
  → return file: URL
```

`fetchModuleBytes` is the shared transport half; `hashRemoteModule` is that same
call plus a shape conversion, so the two paths cannot drift on redirect policy or
the size cap.

### Verification rules

| `expectedHash` returns | Result |
| --- | --- |
| absent option, or `undefined` / `null` | not pinned — load proceeds unchanged |
| 64 hex chars (any case, trimmed) matching the digest | load proceeds |
| 64 hex chars not matching | `PluginHashMismatchError` |
| anything else — `''`, `deadbeef`, 65 chars, non-hex | plain `Error` quoting the value; **fails closed** |
| throws | that error propagates; not degraded to "unpinned" |

`dynamicLoadModule` rethrows with `{ cause: error }`. The wrapper text is
unchanged (`Failed to load plugin from <url>: <message>`), so existing assertions
still hold; callers reach the class through
`error.cause instanceof PluginHashMismatchError`.

### Scope limits (documented in README and docs/plugins.md)

- Browser/worker loads install no resolver and get no verification.
- `file:` URLs never reach the resolver, so a pin on one is inert.
- `hashRemoteModule` is a separate fetch from any load that follows it.
- The CLI's post-load hash warning is unchanged; `feat-cli-plugin-pinning` and
  `feat-config-declared-plugin-hashes` are the consumers.

## Review findings

### Checked

The implement diff (`2dcb0636`) read first, before the handoff summary: both
source files in full, the test file in full, both doc changes, the package index
and `package.json` exports, and every consumer of the resolver API outside the
package (`quoomb-cli/src/plugins/remote-resolver.ts`,
`quoomb-cli/src/commands/dot-commands.ts`, `quoomb-web/src/worker/quereus.worker.ts`).
Also checked the two downstream `implement/` tickets against the API as landed —
`expectedHash`, `hashRemoteModule` and the `error.cause` channel all match what
they were written to consume.

Validation: `yarn lint` clean; `yarn typecheck` clean;
`yarn workspace @quereus/plugin-loader test` 5 files / 117 tests; root `yarn test`
clean in 5m15s.

### Fixed in this pass

- **A rejected response's body was never cancelled.** On a non-`ok` status, an
  off-`https:` redirect, or a `content-length` over the cap, `fetchModuleBytes`
  threw while leaving `response.body` unread, holding its socket until the
  response was collected. Added `discardBody`, called from a `catch` around the
  post-fetch checks; it skips a stream that a reader already owns, so it does not
  collide with `readStreamCapped`'s own cancel-on-failure path. Pre-existing
  behavior, but the code moved in this diff and it is three lines. Covered by a
  new test using a never-closed stream (a closed stream's `cancel()` returns
  without reaching the underlying source, which would have made the assertion
  vacuous) — verified the test fails without the fix.
- **The test gap the implementer named**: added a case asserting `expectedHash` is
  not consulted at all when the fetch fails before producing bytes.

### Considered and deliberately left alone

- **`String(expected)` in `verifyExpectedHash`** — kept. It is redundant against
  the declared type but consistent with the `expected === null` check applied to
  the same value, and it is what turns a non-string from an untyped JS host into
  the quoted-value error instead of `TypeError: expected.trim is not a function`.
- **`PluginHashMismatchError` not re-exported from the `./node` subpath** — a
  single home is right; the README shows the correct import.
- **`maxBytes` moved from construction time into `fetchModuleBytes`** — now
  resolved per call, matching how `fetchImpl` already worked. Identical unless a
  host mutates its own options object after installing.
- **Non-constant-time digest comparison** — the digest is public; there is
  nothing to leak.
- **The spec's temp-directory discovery helper** — the implementer already parked
  an accurate `NOTE:` at the site.

### Tripwire recorded

`expectedHash` verifies bytes in memory, but the import reads them back off disk.
That is safe only because `ensureModuleDir` uses `mkdtemp`, so the path is private
to this user and process. If fetched modules ever move somewhere shared or
predictable — which is exactly what `feat-remote-plugin-disk-cache` proposes — the
pin would be guaranteeing bytes another writer could have replaced. Parked as a
`NOTE:` on `writeModuleFile` in `node-remote.ts`.

### New ticket filed

`backlog/feat-browser-plugin-hash-verification` — in a browser or worker there is
no resolver, so `import('https://…')` runs remote plugin code with no
verification of any kind; quoomb-web's `loadModule` does exactly this today. Not
a defect in this ticket's work (the limit is documented in three places), but the
gap is reachable now, not conditional, and no open ticket claimed the site.
`feat-cli-plugin-pinning` notes quoomb-web is untouched without owning it.

### Empty categories

- **No correctness defect in the pinning logic itself.** Guard ordering,
  fail-closed handling of malformed and throwing `expectedHash`, URL
  normalization, and survival of the error class through `dynamicLoadModule`'s
  wrapper were each read against the code and confirmed by the tests.
- **No doc drift.** README, `docs/plugins.md` and the option JSDoc all describe
  the code as it stands. The `### Security` section at `docs/plugins.md:893` is
  about authoring plugins, not loading them, so it correctly needed no change.
- **No `fix/` or `plan/` tickets.** The one gap worth a ticket is future
  capability, which belongs in `backlog/`.

### Pre-existing, not re-reported

`yarn docs:check` fails on `docs/schema.md` exceeding its word-count ratchet. It
is already listed in `tickets/.pre-existing-known.md` under
`debt-doc-size-ratchet-red-at-head`, and `docs/plugins.md` — the only doc this
ticket touched — is inside its ratchet. No `.pre-existing-error.md` written.
