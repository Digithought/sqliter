----
description: The command-line tool can now mark a downloaded plugin as "only run this exact version", refuse to load it if the download changes, and accept a new version deliberately.
files:
  - packages/quereus/src/vtab/manifest.ts (`PluginRecord.pinned`)
  - packages/quoomb-cli/src/plugins/remote-resolver.ts (`setRecordPinnedHashes`, `lookupPin`, `fetchRemoteModuleHash`)
  - packages/quoomb-cli/src/commands/dot-commands.ts (`syncPluginPins`, `syncSavedPluginPins`, `pinPluginCommand`, `unpinPluginCommand`, `trustPluginCommand`, `reportPinViolation`, `installPluginCommand`, `loadEnabledPlugins`)
  - packages/quoomb-cli/src/repl.ts (~line 57)
  - packages/quoomb-cli/src/bin/quoomb.ts (~line 151)
  - packages/quoomb-cli/test/plugin-commands.spec.ts
  - packages/quoomb-cli/test/remote-resolver.spec.ts
  - packages/quoomb-cli/README.md
  - docs/plugins.md (~line 956–960)
difficulty: medium
----

## What shipped

Plugins the quoomb CLI installs from an `https:` URL are re-downloaded and
re-executed on every load. Until now the CLI recorded the SHA-256 of what it
downloaded and *warned*, after the fact, when that changed. A plugin record can
now opt into refusing instead.

**Default behaviour is unchanged.** A record without `pinned: true` warns exactly
as before, byte for byte.

### Wiring

- `PluginRecord.pinned?: boolean` (`packages/quereus/src/vtab/manifest.ts`).
  Documented as meaningful only for `https:` records in a host that installed the
  Node remote resolver; quoomb-web keeps its own record type and is untouched.
- `setRecordPinnedHashes(pins)` in `remote-resolver.ts` replaces a per-URL pin
  table wholesale; `installRemotePluginResolver` passes a private `lookupPin`
  through as the resolver's `expectedHash`, so a mismatch is refused *before* the
  module is written to disk or imported. Keys are normalized with the same
  `normalizeUrlKey` as `lastFetchByUrl`, so a record holding
  `https://Example.COM:443/p.mjs` pins the fetch of `https://example.com/p.mjs`.
- `fetchRemoteModuleHash(url)` wraps the loader's `hashRemoteModule` so the
  Node-only `@quereus/plugin-loader/node` subpath import stays in one file.
- `syncPluginPins(plugins)` in `dot-commands.ts` rebuilds that table from the
  records — called on every path that reaches `dynamicLoadModule` and after every
  mutation that changes pin state, which is what makes `.plugin unpin` take
  effect in the same session.

### Commands

```
  .plugin install <url> [--pin]   Install plugin from URL (--pin: verify before every load)
  .plugin pin <name|url>          Require the recorded hash before loading
  .plugin unpin <name|url>        Go back to warning after the fact
  .plugin trust <name|url> [hash] Record a new expected hash (fetches and hashes when omitted)
```

`.plugin list` now prints `pinned sha256 <hash>` under a pinned record.

### Behaviour changes beyond the new commands

- `installPluginCommand` does its already-installed check **before** loading.
  Previously it imported and registered the module and only then reported the
  duplicate, so `.plugin install <pinned url>` could run unpinned bytes.
- A load refused by a pin now reports through one helper (`reportPinViolation`)
  from autoload, `enable`, `reload` and `config`'s reload branch: both hashes,
  the URL, and the two remedies (`.plugin trust` / `.plugin unpin`).
- In `loadEnabledPlugins` a pin refusal **does not disable the plugin and saves
  nothing** — the plugin is not broken, and the usual `.plugin enable` hint would
  hit the same pin. Every other failure keeps today's auto-disable.

### Scope call I made beyond the ticket (please sanity-check)

The ticket listed the sync call sites as the record-load paths. Those leave a
hole: `loadPluginsFromConfig` never touches the records, and it runs *before*
`loadEnabledPlugins` in `repl.ts` — and is the *only* plugin load in one-shot
(`-c` / `-f`) mode. A URL pinned by a saved record but declared in
`quoomb.config.json` would therefore have loaded unverified. Added
`syncSavedPluginPins()` (exported from `dot-commands.ts`) and called it before
the config autoload in `repl.ts` (~line 57) and `bin/quoomb.ts` (~line 151).

This is deliberately the same two call sites `feat-config-declared-plugin-hashes`
(next ticket) wants for `setConfigPinnedHashes`, and it does not conflict: that
ticket's config source is meant to take precedence, which is why `lookupPin`
stays private inside `remote-resolver.ts`.

## How to exercise it

```
.plugin install https://host/dist/p.mjs --pin     # records sha256, pins it
# ...the bytes behind that URL change...
.plugin reload p                                  # refused; both hashes + remedies printed
.plugin trust p                                   # fetches + digests, does NOT load
.plugin reload p                                  # now loads
.plugin unpin p                                   # back to warn-after-the-fact
```

`.plugin trust <name> <sha256>` records a digest verified out of band, fetching
nothing. `.plugin pin` / `.plugin trust` refuse a `file:` plugin with the reason
(no download to verify).

## Tests

`packages/quoomb-cli/test/plugin-commands.spec.ts` — new `pinning` block (15
cases). The fixture that matters: the replacement module body sets a global as it
evaluates, so a test distinguishes "refused before the import" from "complained
after loading". Covered: pinned + changed bytes (refused, record untouched,
module never evaluated), unpinned + changed bytes (warns, loads, adopts), pinned
+ unchanged (silent), pinned with no recorded hash (loads, records), `trust` with
and without a hash, bad-hash and 404 `trust`, unpin-then-reload in one session,
autoload violation (stays enabled, remedies printed) and its per-plugin `try`
isolation, two records for one URL with only one pinned, a hand-edited malformed
`sha256`, `pin`/`trust` on a `file:` record, `.plugin install` of a
already-installed URL not evaluating anything, and `syncSavedPluginPins`.

`packages/quoomb-cli/test/remote-resolver.spec.ts` — new `pinning` block (7
cases): match loads, mismatch refuses and announces nothing, typed-vs-normalized
URL in both directions, first-entry-wins on a duplicate URL, a dropped pin
stopping immediately, and a malformed pin failing closed.

Ran: `yarn workspace @quereus/quoomb-cli test` (41 passing), root `yarn build`,
`yarn typecheck`, `yarn test` (all workspaces green, 0 failing), and
`yarn workspace @quereus/quereus run lint` (clean).

## Known gaps / where to push

- **No test drives `repl.ts` or `bin/quoomb.ts`.** `syncSavedPluginPins` is
  tested directly, but the two call sites I added are unexercised — there is no
  harness for either entry point in this package.
- **Two pinned records for one URL with different hashes**: first entry in
  `plugins.json` wins. Deterministic, documented, and only reachable by hand
  editing, but it is a pick, not a resolution. Tested at the
  `setRecordPinnedHashes` level, not end to end.
- **`.plugin trust`'s fetch is separate from the load that follows**, so bytes
  changing in between make the pinned load fail. That fails closed and is
  intended (the loader ticket says the same); no test forces that interleaving.
- **`reportPinViolation` is used by four call sites now**, one more than the
  ticket asked for (`enable`, `reload`, `config` reload as well as autoload).
  Worth a second opinion on whether the interactive paths should keep their
  plainer `Error reloading plugin: …` wording instead.
- **A hand-edited `pinned: true` with a malformed `sha256` still auto-disables**
  on autoload — only `PluginHashMismatchError` is carved out, and a malformed pin
  is a different error class. The message is surfaced intact (tested via
  `reload`), but the disable is arguably as wrong there as for a real mismatch.
  Left alone deliberately: the general auto-disable question is Arm B of
  `bug-cli-corrupt-plugins-file-silently-wipes-plugins` in the backlog.
- **`reconcilePluginHash` was not touched**, only its stale `NOTE:` rewritten —
  worth re-reading that the pinned-match early return really is the path it
  claims.
