----
description: A project's checked-in settings file can now state the exact expected contents of each plugin it downloads, so everyone who runs the tool from that project gets the same verified code. Implemented, reviewed, and shipped.
files:
  - packages/plugin-loader/src/config-loader.ts (`PluginConfig.sha256`, `isValidPluginEntry`)
  - packages/plugin-loader/test/config-loader.spec.ts
  - packages/quoomb-cli/src/plugins/remote-resolver.ts (`seedConfigPluginPins`, `getConfigPinnedHash`, `lookupPin`, `isRemoteUrl`, `SHA256_HEX`)
  - packages/quoomb-cli/src/commands/dot-commands.ts (`reportConfigPinOverride`, `reportPinState`, `reportPinViolation`, `trustPluginCommand`, `unpinPluginCommand`)
  - packages/quoomb-cli/src/bin/quoomb.ts (`executeCommand`), packages/quoomb-cli/src/repl.ts (`REPL.start`)
  - packages/quoomb-web/src/stores/session/plugins.ts (`loadEnabledPlugins`)
  - packages/quoomb-cli/test/plugin-commands.spec.ts
  - docs/plugins.md
----

## What shipped

A `quoomb.config.json` plugin entry can declare the SHA-256 its module must hash to:

```json
{ "plugins": [{ "source": "https://example.com/plugin.js", "sha256": "<64 hex chars>" }] }
```

- `PluginConfig.sha256?: string`; `validateConfig` checks only its *type* — the
  business rules (https-only, 64 hex characters) are the host's, enforced at seed time.
- The CLI keeps a second pin table beside the one derived from
  `~/.quoomb/plugins.json`. `lookupPin` reads config first, so a config-declared
  hash outranks a saved record's for the same URL, and the resolver refuses a
  mismatch before the module is imported.
- `seedConfigPluginPins(config)` validates and seeds it, wired into both CLI
  entry points after `syncSavedPluginPins()` and before `loadPluginsFromConfig`
  (`bin/quoomb.ts` one-shot mode, `repl.ts` interactive). Both sites already
  downgrade a throw to a warning and skip that plugin-loading step.

## Review findings

Read the implement diff (`ff9a4686`) before the handoff summary. Everything below
was found in review; all of it was fixed in this pass except the two filed
tickets. `yarn build`, `yarn typecheck`, `yarn lint` and a full `yarn test` are
green (quoomb-cli 59 tests, up from 51 at implement time); no pre-existing
failures surfaced.

### Fixed in this pass

- **An empty `"sha256": ""` was silently treated as "no pin".** The seed loop
  skipped on falsiness, so an entry that plainly means to pin loaded unverified —
  the exact failure mode the rest of the feature is built to prevent (a
  whitespace-only value, by contrast, did error, so the two were inconsistent).
  Now only an absent key skips; an empty string is reported as not-64-hex.
- **The first bad entry hid the rest, and threw away the pins that were fine.**
  Seeding now checks every entry, reports all the problems in one error, and
  seeds the pins that *did* validate before throwing. That last part matters:
  the caller abandons the config's plugin load either way, but the same URL is
  reachable from the saved-record autoload, where the config's statement about it
  still applies.
- **One URL declared twice with two different hashes silently took the last one.**
  Only one hash can gate one download, so this is now reported like any other
  unusable entry. (Declaring it twice with the *same* hash is fine.)
- **`.plugin pin` / `unpin` / `trust` reported a hash no load would check.** A
  config pin outranks the record, so these commands were confirming record
  changes that had no effect on enforcement — and `.plugin trust`'s "already
  trusts that hash" branch was the same lie. They now say when the config file
  outranks what they just changed (`reportConfigPinOverride`). The implement
  handoff raised this as "warns only at seed time"; the sharper problem was that
  the commands actively reported success.
- **A refusal caused by a config hash pointed the user at the wrong remedy.**
  `reportPinViolation` named `.plugin trust` / `.plugin unpin`, neither of which
  can lift a config pin. It now names the config file when the enforced hash came
  from there.
- **`setConfigPinnedHashes` was exported, bypassing validation.** Made private;
  `seedConfigPluginPins` is the only way in. Tests reset with
  `seedConfigPluginPins({ plugins: [] })`.
- **DRY:** the implement diff added `isHttpsUrl` and `SHA256_HEX` to
  `remote-resolver.ts`, both byte-identical to `isRemoteUrl` / `SHA256_HEX`
  already in `dot-commands.ts` in the same package. One copy each now, exported
  from `remote-resolver.ts` (import direction was already that way, so no cycle).
- **quoomb-web silently ignored the field.** The browser has no resolver to
  verify against — correct per the ticket — but it loads the *same config file*,
  so a user pinning there got no enforcement and no notice. Added a startup
  warning naming the unenforced entries, and appended the situation to the
  existing `feat-browser-plugin-hash-verification` backlog ticket rather than
  filing a new one.

### Tests added

Beyond the implementer's five: empty `sha256` rejected (and not silently
downgraded to an unpinned load), all problems reported together, valid pins still
seeded when a sibling fails, duplicate-URL conflict rejected, duplicate-URL
agreement accepted, the config-vs-record conflict warning fires exactly once with
both hashes, `.plugin pin`/`trust` surfacing the override (and going quiet once
record and config agree), and a config-caused refusal pointing at the config file
instead of `.plugin trust`.

### Checked, nothing to change

- `interpolateConfigEnvVars` walks all strings generically, so `${VAR}` in
  `sha256` works and is validated post-substitution — covered by the
  implementer's test.
- `validateConfig` doing type-shape only, with the rules at seed time: correct
  split, since `validateConfig` is shared with hosts that cannot enforce anything.
- Hash-case handling: `verifyExpectedHash` lowercases and re-validates whatever
  the host returns, and the seed lowercases too, so an uppercase config hash
  matches.
- Ordering at both call sites: pins are seeded before `loadPluginsFromConfig` and
  before `loadEnabledPlugins`, so neither load path can outrun the pin table.
- No JSON schema file for `quoomb.config.json` exists in the repo, and the VS Code
  extension does not consume `QuoombConfig.plugins` — nothing else to update.
- `docs/plugins.md` rewritten for the new rules (empty hash, duplicate URLs,
  all-problems-at-once, the command-level override notices, the config-file
  remedy).
- Blast radius of one bad entry skipping the whole config's plugin load: kept.
  It fails closed, matches how an invalid config file is already handled, and the
  improvements above remove the sting (all problems at once, valid pins still
  seeded).

### Tripwire recorded

- Config pins are seeded once per process, like the rest of the config. If a
  command that re-reads `quoomb.config.json` mid-session is ever added, it must
  re-seed or the session keeps enforcing the file's startup contents. Parked as a
  `NOTE:` on `seedConfigPluginPins` in `remote-resolver.ts` — no ticket, since
  nothing today re-reads the config.

### Filed

- `backlog/debt-cli-dot-commands-file-too-large` — `dot-commands.ts` is 1189
  lines (`wc -l`, 2026-08-03) mixing CSV import/export, result formatting, schema
  commands and the whole plugin manager. Pre-existing, not caused here, but three
  consecutive pinning tickets have now edited it and an open bug ticket targets
  the record store inside it.
- Appended an arm to `backlog/feat-browser-plugin-hash-verification` covering
  config-declared hashes in the browser (see above).
