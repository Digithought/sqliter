description: Let a project's checked-in settings file state the exact expected contents of each plugin it downloads, so everyone who runs the tool from that project gets the same verified code. Implementation is done and tested; ready for review.
files:
  - packages/plugin-loader/src/config-loader.ts (`PluginConfig.sha256`, `isValidPluginEntry`)
  - packages/plugin-loader/test/config-loader.spec.ts
  - packages/quoomb-cli/src/plugins/remote-resolver.ts (`setConfigPinnedHashes`, `seedConfigPluginPins`, `lookupPin`)
  - packages/quoomb-cli/src/bin/quoomb.ts (`executeCommand`, one-shot config autoload)
  - packages/quoomb-cli/src/repl.ts (`REPL.start`, interactive config autoload)
  - packages/quoomb-cli/test/plugin-commands.spec.ts
  - docs/plugins.md
----

## What changed

`quoomb.config.json` plugin entries can now declare an expected hash:

```json
{ "plugins": [{ "source": "https://example.com/plugin.js", "sha256": "<64 hex chars>" }] }
```

- `PluginConfig` gained an optional `sha256?: string`. `isValidPluginEntry` accepts a string there and rejects any other type (mirrors how `config` is validated) — this is shape validation only; business rules (https-only, 64-hex) are enforced later, at CLI seed time, not by `validateConfig`.
- `packages/quoomb-cli/src/plugins/remote-resolver.ts` gained a second pin table, `configPinnedHashByUrl`, alongside the existing record-derived `pinnedHashByUrl`. The private `lookupPin(url)` now checks config first, falling back to records — so a config-declared hash always wins over whatever `~/.quoomb/plugins.json` says for the same URL.
  - `setConfigPinnedHashes(pins)` replaces the config pin table wholesale and warns once (`console.warn`, not thrown) if the new table disagrees with the current record table for the same URL.
  - `seedConfigPluginPins(config: QuoombConfig)` is the new validating entry point: walks `config.plugins`, and for every entry that declares `sha256`, hard-throws if the source is not an `https:` URL (`npm:` spec, bare package name, `file:` all included) or if the hash is not 64 hex characters. Only on a fully valid set does it call `setConfigPinnedHashes`.
- Wired `seedConfigPluginPins` into both CLI entry points, called after `syncSavedPluginPins()` (so the record table is already populated for the conflict-warning check) and before `loadPluginsFromConfig`:
  - `bin/quoomb.ts` → `executeCommand` (one-shot `-c`/`-f` mode).
  - `repl.ts` → `REPL.start()` (interactive mode).
  Both sites already wrap this whole block in a try/catch that downgrades any error to a `console.warn` and skips that one plugin-loading step — consistent with how an invalid config file is already handled, and it does not touch `loadEnabledPlugins` (the saved-record autoload), which runs separately.
- `docs/plugins.md`: added a paragraph to the existing "Hash pinning gates the load, and is opt-in" bullet (there was no pre-existing dedicated "config file format" section to extend, so this was the closest home) documenting the field, the https-only rule, and the config-wins-on-conflict rule.

## Testing performed

- `packages/plugin-loader/test/config-loader.spec.ts`: `validateConfig` accepts a string `sha256`, rejects number/object/null; `interpolateConfigEnvVars` round-trips a `${VAR}` placeholder inside `sha256`.
- `packages/quoomb-cli/test/plugin-commands.spec.ts`, new `config-declared pins` block nested under the existing `pinning` describe (reuses its `install`/`serveChangedBytes`/`v2Evaluated` fixtures):
  - a matching config hash loads without complaint (`dynamicLoadModule` resolves),
  - a mismatching config hash is refused before import (`v2Evaluated()` stays `false`),
  - a config hash beats a disagreeing pinned *record* hash — the record alone would refuse the load, but with the config's (correct) hash seeded, the load succeeds,
  - a `sha256` on a non-`https:` source throws at `seedConfigPluginPins` time, before any fetch,
  - a malformed `sha256` throws at `seedConfigPluginPins` time.
- Ran, all green: `yarn workspace @quereus/plugin-loader test`, `yarn workspace @quereus/quoomb-cli test`, root `yarn build`, `yarn typecheck`, `yarn lint`, and a full `yarn test` (648+52+31+51+68+34+134+22 passing across every workspace, no failures).

## Gaps / things worth a reviewer's eyes

- **One bad hash fails the whole config's autoload, not just that plugin.** `seedConfigPluginPins` throws on the first invalid entry, and both call sites treat that throw the same as "invalid config file" — the entire `config.plugins` array is skipped for that run (saved-record plugins still load separately). This matches the ticket's "hard errors... before any plugin loads," but it means one typo'd `sha256` blocks every other plugin in the same config file, including ones with no `sha256` at all. Flagging in case the intended blast radius was narrower (refuse only the offending entry).
- **Conflict warning fires only at seed time**, not re-checked afterward. In the interactive REPL, if a user runs `.plugin pin`/`.plugin trust` *after* config autoload already ran (a config pin was already seeded that session), the record table changes but `setConfigPinnedHashes` is not re-invoked, so no new conflict warning fires for that later change — config still wins silently (correct precedence, just no repeated warning). This is the documented behavior ("warn once at seed time"), not a bug, but worth confirming that's the intended interactive-session semantics.
- **No test drives `bin/quoomb.ts` or `repl.ts` as an actual CLI process** for either the "hash matches" or "hash cannot be enforced → startup warning" paths — coverage is at the `seedConfigPluginPins`/`dynamicLoadModule` unit level, consistent with the rest of this test file (nothing else here spawns the real CLI binary either), but the two specific wiring sites the ticket calls out (`bin/quoomb.ts` ~line 151-ish, `repl.ts` ~line 57-ish) are exercised only by inspection + typecheck, not an end-to-end test.
- `quoomb-web`'s config-driven plugin loading does not consult `sha256` at all — by design, per the ticket ("enforcement is the host's"); the web app has no Node remote resolver to enforce against. Restating here so it isn't mistaken for an oversight.
