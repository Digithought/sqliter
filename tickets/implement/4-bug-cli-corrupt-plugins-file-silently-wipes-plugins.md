description: The command-line tool reacts to plugin problems by quietly destroying the user's plugin settings — a damaged plugin list is treated as an empty one and then overwritten, and a plugin that fails to load once is switched off for good.
files:
  - packages/quoomb-cli/src/commands/dot-commands.ts (`loadPlugins`, `savePlugins`, `loadEnabledPlugins`)
  - packages/quoomb-cli/test/plugin-commands.spec.ts (autoload-failure test around line 244; add a corrupt-file case)
difficulty: easy
----

## Background

Full research lives in the completed fix ticket this one replaces
(`tickets/fix/4-bug-cli-corrupt-plugins-file-silently-wipes-plugins.md`, now deleted — see
git history if the detail below isn't enough). Summary of both arms:

**Arm A.** `loadPlugins` (`dot-commands.ts` ~line 404) reads and parses
`~/.quoomb/plugins.json` inside one `try`; *any* failure — missing file, truncated write,
hand-edit typo, permission error — returns `[]` with no message. The next `.plugin install`
then calls `savePlugins` with that empty list plus the one new record, overwriting the
damaged file and destroying whatever the old one held (other plugins' enabled flags,
settings, recorded hashes).

**Arm B.** `loadEnabledPlugins` (`dot-commands.ts` ~line 1113) loads every enabled plugin at
startup. Any failure that isn't a `PluginHashMismatchError` (handled separately via
`reportPinViolation`, which deliberately leaves the record untouched — see the comment above
that function) falls into the generic catch, which sets `plugin.enabled = false`, saves, and
prints `Disabled it; run '.plugin enable <name>' to try again.`. Since plugins can now load
from `https:` URLs, a failure here is often transient (offline, DNS timeout, 5xx, proxy
block) and has nothing to do with the plugin itself — the user loses it silently until they
notice.

## Fix

### Arm A — don't destroy a plugins.json the CLI couldn't read

In `loadPlugins`:

- Keep the missing-file case silent (`ENOENT` → return `[]`, unchanged — this is the normal
  first-run state).
- For any other read or parse failure, print an actionable message naming the file path and
  the underlying error (`chalk` styling to match the rest of the plugin commands' `console.log`
  usage — note this area does **not** use `console.error`, see `installPluginCommand`'s catch
  for the existing convention).
- Before returning `[]`, move the unreadable file aside rather than leaving it in place to be
  overwritten: rename `plugins.json` → `plugins.json.corrupt-<n>`, picking the lowest `n` not
  already taken (so a second corruption in the same session doesn't clobber the first
  quarantine). This is the mechanism recommended in the original ticket's "Expected behavior"
  section — it means `savePlugins`'s next write creates a fresh file without touching the
  bytes that couldn't be understood, so a user can still recover settings from the quarantined
  copy by hand.
- If the rename itself fails (e.g. permissions), report that too rather than swallowing it.

This only needs one change point since every subcommand and `loadEnabledPlugins` already
goes through `loadPlugins`.

### Arm B — a transient autoload failure shouldn't disable the plugin

In `loadEnabledPlugins`'s generic catch (the branch that runs when `hashMismatchFrom(error)`
is `undefined` — leave that branch, and everything above it, alone):

- Drop `plugin.enabled = false` and the `savePlugins` call that follows it.
- Keep the `Warning: Failed to load plugin …` message.
- Replace the `Disabled it; run '.plugin enable …'` line with wording that matches the new
  behavior — the plugin stays enabled and will be retried next start; a user who wants it off
  says so explicitly with `.plugin disable <name>`.

This is "Option 1" from the original ticket's list (never auto-disable, warn every start) —
the simplest of the three, and it puts the decision back with the user rather than the CLI
guessing whether a failure indicts the plugin. It does not touch the pin-mismatch branch,
which already leaves the record alone for its own (documented) reasons.

### Tests

- `test/plugin-commands.spec.ts` already has `'names a manifest-less plugin in the autoload
  failure hint'` (~line 244), which currently asserts the record's `enabled` flips to `false`
  and checks for `.plugin enable plain` in the output. Update it for the new behavior: assert
  `enabled` stays `true`, and update the output assertion to whatever the new wording says
  instead.
- Add a case for Arm A: hand-write garbage (not valid JSON) to
  `join(homeDir, '.quoomb', 'plugins.json')` (see the `writeRecords` helper for the pattern,
  though this needs a raw write since it's intentionally not valid `PluginRecord[]` JSON), run
  `.plugin list`, and assert: the corruption is reported (path + reason in the output), the
  original file now exists at `plugins.json.corrupt-1`, and a subsequent
  `.plugin install <url>` produces a fresh `plugins.json` containing only the new record while
  the quarantined file's content is unchanged.

## TODO

Arm A
- Change `loadPlugins` to distinguish `ENOENT` (silent, unchanged) from other read/parse
  failures (report + quarantine).
- Add the quarantine helper (rename `plugins.json` → `plugins.json.corrupt-<n>`, lowest free
  `n`), used from `loadPlugins`.

Arm B
- Remove the auto-disable (`plugin.enabled = false` + save) from `loadEnabledPlugins`'s
  generic catch branch; update the printed hint to match.

Tests
- Update the existing autoload-failure-hint test's expectations for the no-longer-disabled
  record and new hint wording.
- Add a corrupt-`plugins.json` test covering report + quarantine + safe subsequent install.
- Run `yarn workspace @quereus/quoomb-cli test` (Vitest) and confirm the updated/added cases
  pass.
