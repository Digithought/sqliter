---
description: The command-line tool used to react to plugin problems by quietly destroying the user's plugin settings — a damaged plugin list was treated as empty and overwritten, and a plugin that failed to load once was switched off for good. Both are now fixed.
files:
  - packages/quoomb-cli/src/commands/dot-commands.ts (`loadPlugins`, `reportAndQuarantine`, `quarantineCorruptPluginsFile`, `savePlugins`, `loadEnabledPlugins`)
  - packages/quoomb-cli/test/plugin-commands.spec.ts (autoload-failure test, new corrupt-file test)
repro: verified
---

# Review: CLI no longer destroys plugin settings on a bad `plugins.json` or a transient autoload failure

## What was built

Two independent arms, both from the implement ticket (`tickets/implement/4-bug-cli-corrupt-plugins-file-silently-wipes-plugins.md`, now deleted — see git history for full prior research).

**Arm A — quarantine instead of overwrite.** `loadPlugins` (`dot-commands.ts`) used to catch *any* read/parse failure — missing file, truncated write, hand-edit typo, permission error — and silently return `[]`. The next `.plugin install` would then call `savePlugins` with that empty list plus one new record, overwriting whatever the damaged file held. Now:
- `ENOENT` (file genuinely doesn't exist — normal first run) still returns `[]` silently, unchanged.
- Any other read failure, or a JSON parse failure, goes through the new `reportAndQuarantine(filePath, reason, error)` helper: prints the file path and underlying error via `console.log(chalk.red(...))` (matching this file's existing convention — no `console.error` used anywhere in the plugin commands), then calls `quarantineCorruptPluginsFile(filePath)`.
- `quarantineCorruptPluginsFile` renames `plugins.json` → `plugins.json.corrupt-<n>`, picking the lowest `n` not already on disk (checked via `fs.access`), so repeated corruption in one session quarantines each occurrence separately instead of clobbering the previous one. If the rename itself fails, that's reported too rather than swallowed.
- Only after the file is moved aside does `loadPlugins` return `[]` — so the next `savePlugins` writes a fresh file without touching bytes the CLI couldn't parse, and the user can recover settings from the quarantined copy by hand.
- Single change point: every `.plugin` subcommand and `loadEnabledPlugins` already route through `loadPlugins`.

**Arm B — don't auto-disable on a transient autoload failure.** `loadEnabledPlugins`'s generic catch branch (the one that runs when the error is *not* a `PluginHashMismatchError` — that branch, `reportPinViolation`, is untouched and still deliberately leaves the record alone) used to set `plugin.enabled = false`, save, and tell the user to `.plugin enable <name>` to retry. Since plugins can load from `https:` URLs, a load failure here is often transient (host offline, DNS hiccup, a 5xx, a proxy block) and has nothing to do with the plugin itself. Now the catch:
- Still prints `Warning: Failed to load plugin <name>: <error>`.
- No longer touches `plugin.enabled` or calls `savePlugins`.
- Prints `It stays enabled and will be retried next start; run '.plugin disable <name>' to turn it off.` instead of the old disable-and-retry hint.
- The doc comment on `reportPinViolation` referenced the old auto-disable behavior ("that matters most in loadEnabledPlugins, which disables a plugin that fails to load") and a "tracked separately" note about whether auto-disable should happen at all; both were stale after this change and have been rewritten to describe current behavior.

## Validation performed

- `yarn workspace @quereus/quoomb-cli test` (Vitest) — all 60 tests pass, including the two touched/added here.
- `yarn workspace @quereus/quoomb-cli run typecheck` — clean.
- `yarn workspace @quereus/quoomb-cli run lint` — no-op for this package (`echo 'No lint configured'`, by design — only `packages/quereus` has a real lint per `AGENTS.md`).
- `test/plugin-commands.spec.ts`:
  - Existing `'names a manifest-less plugin in the autoload failure hint'` renamed to `'... without disabling it'` and updated: asserts `enabled` stays `true` and the output now contains `.plugin disable plain` (was asserting `enabled === false` and `.plugin enable plain`).
  - New `'quarantines an unreadable plugins.json instead of overwriting it, and installs cleanly afterward'`: hand-writes invalid JSON to `plugins.json`, runs `.plugin list`, asserts the output names the file path and an error, asserts `plugins.json.corrupt-1` now holds the original garbage bytes unchanged, then runs `.plugin install <url>` and asserts the fresh `plugins.json` contains only the new record while the quarantined file is still untouched.

## Known gaps and honest notes for the reviewer

- **No test for the second-corruption-in-one-session case.** The `quarantineCorruptPluginsFile` lowest-free-`n` search (`.corrupt-1`, `.corrupt-2`, ...) is implemented and manually reasoned through, but no test drives `loadPlugins` into a corrupt file twice in the same process to confirm `.corrupt-2` is picked rather than overwriting `.corrupt-1`. Low risk (the loop logic is a few lines and structurally simple) but unverified.
- **No test for a rename failure on the quarantine path** (the "if the rename itself fails, report that too" branch in `reportAndQuarantine`'s catch). Would need a permissions trick that's awkward to set up portably (this repo runs CI on Windows too); left unverified rather than adding a flaky/platform-specific test.
- **Arm A read-failure vs parse-failure share one helper and one message shape** (`reportAndQuarantine(filePath, reason, error)` with `reason` = `'reading'` or `'parsing'`) — intentional DRY per `AGENTS.md`'s "stay DRY", flagged here only so the reviewer knows both paths were exercised by one code path, not two independently-tested ones. The new test only exercises the parse-failure path (invalid JSON); the read-failure path (e.g. a permissions error mid-read after the file exists) shares the same helper but isn't separately tested.
- **No corruption-scenario test in `loadEnabledPlugins`/startup specifically** — the new corrupt-file test drives `loadPlugins` via `.plugin list`; it doesn't separately confirm the quarantine-then-fresh-install flow when the corruption is hit via the startup `loadEnabledPlugins` path instead of a subcommand. Both call the same `loadPlugins`, so this is believed to be redundant coverage rather than a gap, but noted for completeness.
