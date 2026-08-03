----
description: Let a command-line user mark a plugin downloaded from the web as "only run this exact version", so the tool refuses to run it if the download changes, with commands to approve a new version deliberately.
prereq: feat-plugin-loader-hash-pinning
files:
  - packages/quereus/src/vtab/manifest.ts (`PluginRecord`)
  - packages/quoomb-cli/src/plugins/remote-resolver.ts
  - packages/quoomb-cli/src/commands/dot-commands.ts (`PLUGIN_HELP_LINES`, `handlePluginCommand`, `reconcilePluginHash`, `installPluginCommand`, `loadEnabledPlugins`)
  - packages/quoomb-cli/test/plugin-commands.spec.ts
  - packages/quoomb-cli/test/remote-resolver.spec.ts
  - packages/quoomb-cli/README.md
  - docs/plugins.md (~line 951)
difficulty: medium
----

## Where things stand

The CLI keeps installed plugins in `~/.quoomb/plugins.json` as `PluginRecord`s.
For a plugin installed from an `https:` URL it records the SHA-256 of the bytes
that were downloaded, and on later loads `reconcilePluginHash` compares that
against what was served this time and prints a warning when they differ. Every
call site runs after `dynamicLoadModule` returned, so the warning describes code
that has already been imported and registered.

`feat-plugin-loader-hash-pinning` gives the Node resolver an `expectedHash`
callback that is consulted before the module is written or imported, and a
`PluginHashMismatchError` that survives `dynamicLoadModule`'s error wrapping via
`cause`. This ticket wires the CLI to it.

**Warn-and-continue stays the default.** Nothing changes for a record that has not
opted in.

## What to build

### 1. `PluginRecord.pinned`

```ts
/**
 * When true, `sha256` is enforced *before* the module is imported: a host that
 * verifies remote plugins refuses the load on a mismatch instead of warning
 * after the code has already run. Absent or false keeps the warn-and-continue
 * default.
 *
 * Only meaningful for `https:` records in a host that installed the Node remote
 * resolver. Browsers import the URL directly with no verification step, and
 * `file:` URLs never reach the resolver at all.
 */
pinned?: boolean;
```

A pinned record with no `sha256` is not a violation — it is a first observation.
The next successful load records a hash and enforcement starts from there.

### 2. A pin registry in the CLI's resolver wiring

`packages/quoomb-cli/src/plugins/remote-resolver.ts` already installs the
resolver at startup and keeps a `lastFetchByUrl` map keyed by `normalizeUrlKey`.
Add a pin table beside it and feed it to the resolver:

```ts
/**
 * Expected hashes derived from ~/.quoomb/plugins.json. Re-synced whenever the
 * records change, so an unpin takes effect in the same session.
 *
 * A second source — hashes declared in quoomb.config.json — lands with
 * `feat-config-declared-plugin-hashes` and takes precedence over these.
 */
export function setRecordPinnedHashes(pins: Iterable<{ url: string; sha256: string }>): void;
```

- Replaces the record-derived table wholesale on each call (so removing or
  unpinning a plugin drops its pin).
- Keys on `normalizeUrlKey`, exactly like `lastFetchByUrl` — a record holds
  whatever the user typed; the resolver is handed the parsed href.
- `installRemotePluginResolver` passes
  `expectedHash: url => lookupPin(normalizeUrlKey(url))` into
  `installNodeRemoteModuleResolver`. Keep `lookupPin` private so the config
  source can slot in ahead of the record source later without changing callers.

### 3. Sync pins before every load path

Add a `syncPluginPins(plugins: PluginRecord[])` helper in `dot-commands.ts` and
call it at the top of every path that reaches `dynamicLoadModule`:
`installPluginCommand`, `enablePluginCommand`, `reloadPluginCommand`,
`configPluginCommand` (its reload branch), and `loadEnabledPlugins`. Also call it
after any mutation that changes pin state (`pin`, `unpin`, `trust`, `remove`), so
a later command in the same session sees the current table.

If two records hold the same URL and only one is pinned, the URL is pinned — take
the strictest entry. The pin table is per-URL and there is no honest way to apply
two different policies to one download.

### 4. New subcommands

```
  .plugin install <url> [--pin]   Install plugin from URL (--pin: verify before every load)
  .plugin pin <name|url>          Require the recorded hash before loading
  .plugin unpin <name|url>        Go back to warning after the fact
  .plugin trust <name|url> [hash] Record a new expected hash (fetches and hashes when omitted)
```

- **`install --pin`** sets `pinned: true` on the new record. Install already
  records `sha256` from the fetch it just did, so the pin is immediately
  meaningful. A flag rather than an interactive prompt: the `.plugin` commands
  never prompt today, and prompting would break piped/scripted input.
- **`pin`** refuses for a non-`https:` URL, saying pinning only applies to
  modules the tool downloads. With no recorded hash it still succeeds, and prints
  that the next successful load records one and enforcement begins there.
- **`unpin`** clears the flag and re-syncs.
- **`trust`** is how a user accepts a new version. With an explicit hash argument
  it validates 64 hex characters and records it without loading anything — the
  safest form, for a user who verified the bytes out of band. With no argument it
  calls `hashRemoteModule` (fetch and digest, **no import**), prints the old and
  new hashes, and records the new one. It does not load the plugin; it prints
  `run '.plugin reload <name>' to load it`. Refuse for a non-`https:` URL.

`trust`'s fetch is separate from the load that follows, so the bytes could change
in between and the pinned load then fails. That fails closed and is acceptable;
do not try to hand the trusted bytes forward.

### 5. A pin violation must not disable the plugin

`loadEnabledPlugins` catches every load failure, warns, and flips the record to
`enabled: false` with the hint `run '.plugin enable <name>' to try again`. For a
pin mismatch that hint is wrong — `.plugin enable` hits the same pin — and the
failure does not mean the plugin is broken, it means the code behind the URL
changed.

So: when `error.cause instanceof PluginHashMismatchError`, print the mismatch
(both hashes, the URL) and the two real remedies —

```
  Verify the new version, then '.plugin trust <name>' to accept it,
  or '.plugin unpin <name>' to go back to warning only.
```

— leave `enabled` alone, and save nothing. Every other failure keeps today's
behavior.

The general "should a failed startup load auto-disable at all" question is Arm B
of `bug-cli-corrupt-plugins-file-silently-wipes-plugins` in the backlog. Do not
try to settle it here; only carve out the pin case, which has a specific and
different right answer.

### 6. Leave `reconcilePluginHash` alone, but fix its comment

Its logic is already correct for both cases: a pinned mismatch throws before it
runs, and a pinned match hits the `fetched === plugin.sha256` early return. Only
its `NOTE:` needs rewriting — it currently states the comparison "cannot be turned
into a refusal where it stands", which stops being the whole story once pinning
exists. Point it at the pin path instead.

## Edge cases & interactions

- **Pinned record, unchanged bytes** → loads silently, exactly as an unpinned one
  does. Assert this; it is the regression that a too-strict comparison breaks.
- **Pinned record, changed bytes** → refused before the module body evaluates
  (assert with a fixture that sets a global on evaluation), plugin stays
  `enabled: true`, `plugins.json` unchanged, message names both hashes and both
  remedies.
- **Pinned record with no recorded hash** → loads, records the hash, no refusal.
- **Unpinned record, changed bytes** → today's post-load warning, byte for byte.
- **`.plugin unpin` then `.plugin reload` in the same session** → succeeds. If the
  pin table is only rebuilt at startup this fails; that is what makes the re-sync
  after mutations load-bearing.
- **`.plugin remove` of a pinned plugin** → its pin leaves the table, so a later
  fresh install of the same URL is not gated by a record that no longer exists.
- **URL spelling** — a record holding `https://Example.COM:443/p.mjs` must pin the
  fetch of `https://example.com/p.mjs`. `remote-resolver.spec.ts` already covers
  this shape for `lastFetchByUrl`; mirror it for pins.
- **`.plugin trust <bad-hash>`** (not 64 hex) → refused, record untouched.
- **`.plugin trust` when the URL now 404s** → reports the fetch failure, records
  nothing.
- **`.plugin pin` / `.plugin trust` on a `file:` plugin** → refused with the
  reason, rather than accepted and silently inert.
- **Autoload with several plugins, one pinned and violated** → the per-plugin
  `try` keeps the rest loading.
- **Re-installing an already-installed URL**: today `installPluginCommand` loads
  the module *before* checking whether the URL is already installed, so the code
  runs even though the command then bails with "already installed". Move the
  duplicate check ahead of the load — otherwise a pinned plugin can be made to
  execute unpinned bytes by typing `.plugin install <same url>`.
- **A record hand-edited to `pinned: true` with a malformed `sha256`** → the
  loader fails closed with the malformed-pin error from
  `feat-plugin-loader-hash-pinning`. Make sure the CLI surfaces that message
  rather than flattening it to "failed to load".
- **quoomb-web is untouched.** It keeps its own `PluginRecord` in
  `packages/quoomb-web/src/worker/types.ts` and imports `https:` natively, so
  `pinned` neither appears nor applies there. The field doc says so.

## TODO

- Add `pinned?: boolean` to `PluginRecord` in
  `packages/quereus/src/vtab/manifest.ts`, documented as above.
- Add the pin table and `setRecordPinnedHashes` to `remote-resolver.ts`; wire
  `expectedHash` into `installRemotePluginResolver`.
- Add `syncPluginPins` to `dot-commands.ts` and call it on every load path and
  after every pin-affecting mutation.
- Move `installPluginCommand`'s already-installed check ahead of the load; add
  `--pin`.
- Add `pinPluginCommand`, `unpinPluginCommand`, `trustPluginCommand`; register
  them in `handlePluginCommand` and `PLUGIN_HELP_LINES`.
- Special-case `PluginHashMismatchError` (via `error.cause`) in
  `loadEnabledPlugins`: report, do not disable, do not save.
- Rewrite the stale `NOTE:` on `reconcilePluginHash`.
- Extend `packages/quoomb-cli/test/plugin-commands.spec.ts` — the existing
  `routes` map lets a test re-serve a different body for the same URL, which is
  the "remote code changed" fixture:
  - install `--pin`, re-serve changed bytes, reload → refused, both hashes shown,
    record still enabled
  - same but unpinned → warns, loads, adopts
  - pinned, unchanged bytes → loads with no warning
  - pinned with `sha256` deleted from the record → loads, records
  - `trust` with an explicit hash → record updated, nothing fetched or imported
  - `trust` with no hash → fetches, records the new hash, does not load
  - `unpin` then `reload` in one session → succeeds
  - autoload with a violated pin → not disabled, remedies printed
  - `.plugin install` of an already-installed URL does not evaluate the module
- Extend `packages/quoomb-cli/test/remote-resolver.spec.ts` for pin lookup by the
  URL as typed vs. normalized, and for the strictest-entry rule.
- Update `packages/quoomb-cli/README.md` and `docs/plugins.md` (~line 951) with
  the new subcommands and the default-off stance.
- `yarn workspace @quereus/quoomb-cli test`, then root `yarn build` and
  `yarn typecheck`.
