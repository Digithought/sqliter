---
description: The command-line tool used to react to plugin problems by quietly destroying the user's plugin settings — a damaged plugin list was treated as empty and overwritten, and a plugin that failed to load once was switched off for good. Both are fixed, saves can no longer damage the file in the first place, and a plugin list that is valid JSON of the wrong shape is now caught too.
files:
  - packages/quoomb-cli/src/commands/dot-commands.ts (`loadPlugins`, `isPluginRecordList`, `reportAndQuarantine`, `quarantineCorruptPluginsFile`, `savePlugins`, `loadEnabledPlugins`)
  - packages/quoomb-cli/test/plugin-commands.spec.ts
  - packages/quoomb-cli/README.md
  - docs/plugins.md
repro: verified
---

# Complete: CLI no longer destroys plugin settings on a bad `plugins.json` or a transient load failure

## What shipped

**Arm A — quarantine instead of overwrite.** `loadPlugins` used to catch every read/parse
failure and return `[]`, so the next `.plugin install` overwrote the damaged file. Now only
`ENOENT` (normal first run) returns `[]` silently; anything else prints the file path and the
underlying error, then renames `plugins.json` to `plugins.json.corrupt-<n>` — lowest free `n`,
so repeated corruption in one session does not clobber the previous copy. The settings stay
recoverable by hand.

**Arm B — no auto-disable on a load failure.** `loadEnabledPlugins`'s generic failure branch no
longer sets `enabled = false` and saves. A plugin loaded from an `https:` URL fails for reasons
that have nothing to do with the plugin (host offline, DNS, a 5xx), so it stays enabled, is
retried next start, and the message names `.plugin disable <name>` for the case where the plugin
really is at fault. The pin-mismatch branch (`reportPinViolation`) was already carved out and is
unchanged.

**Arm C (added in review) — shape validation and atomic saves.** See findings below.

## Review findings

### Checked

Read the implement diff (`84d73569`) before the handoff summary. Traced every `loadPlugins`
caller (12 sites), `savePlugins`, the two startup call sites in `repl.ts`, `remote-resolver.ts`'s
references to the file, and the `PluginRecord` interface in
`packages/quereus/src/vtab/manifest.ts`. Reviewed for source hygiene, error handling, resource
cleanup, type safety, DRY, and cross-platform behavior. Read `packages/quoomb-cli/README.md` and
`docs/plugins.md` in full for statements the change invalidated.

### Major — fixed in this pass (root cause at the same site, no ticket filed)

**Well-formed JSON of the wrong shape bypassed the whole fix.** `loadPlugins` did
`return JSON.parse(data)` — an unchecked cast to `PluginRecord[]`. A hand-edit that wraps the
array in an object (`{"plugins": [...]}`), a stray `null`, or an array of non-records parses
fine, so it never reached the quarantine path; it was handed to callers as a record list and
threw in whichever subcommand touched it first. Verified by temporarily disabling the new guard
and running the new test: `TypeError: plugins is not iterable` at
`listPluginsCommand (dot-commands.ts:793)`, propagating to `repl.ts`'s catch. The user got an
error with no mention of the file and no way out but editing it by hand — exactly the failure
mode the ticket set out to remove, for the one input class it did not cover.

Fixed at the boundary rather than per-caller: a new `isPluginRecordList` type guard (array of
non-null objects with a string `url` — the one field every consumer reads) gates the return, and
a failure goes through the same `reportAndQuarantine` path as a syntax error. `loadPlugins` now
genuinely returns what its signature claims instead of asserting it.

**Saves could produce the corruption the quarantine recovers from.** `savePlugins` used
`fs.writeFile`, which truncates before writing — a save interrupted by Ctrl-C, a crash, or power
loss leaves a half-written `plugins.json`. The implement ticket handled recovery but left the
producer intact. Now it writes `plugins.json.tmp-<pid>` and renames it into place, so the real
path only ever holds a whole document; the pid in the temp name keeps two concurrent CLI
sessions off each other's partial file. (The pre-existing lost-update `NOTE:` above `savePlugins`
still stands and is untouched — atomicity is not concurrency.) The swallowed `mkdir` try/catch in
the same function was removed: `recursive: true` does not throw on an existing directory, so the
catch only hid real failures, against `AGENTS.md`'s "don't eat exceptions silent".

### Minor — fixed in this pass

- **Test gaps the implementer flagged, now closed.** Added: a second corruption in the same
  session lands at `.corrupt-2` with `.corrupt-1` intact; a read failure that is not `ENOENT`
  (a directory where the file should be) is reported and quarantined — this exercises the
  read-failure arm, which the handoff correctly noted was untested; a completed save leaves
  nothing in `~/.quoomb` but `plugins.json`. Plus the wrong-shape case above. 60 → 64 tests.
- **Docs were stale.** `docs/plugins.md` said "a pin that a startup load refuses does *not*
  disable the plugin", whose contrast implied the generic failure path still did — false after
  Arm B. Reworded, and the CLI section now states the retry-not-disable rule and the quarantine
  rule. `packages/quoomb-cli/README.md` documented neither; both are now under the plugin
  section. The spec file's header comment now names the corruption group.
- **Message wording.** "Error reading plugin file <path>" read as if a plugin module were at
  fault; now "plugins file".

### Recorded as a tripwire, not a ticket

- `quarantineCorruptPluginsFile` restarts its free-suffix search at 1 on every call, so it stats
  once per quarantined copy already on disk. Fine while corruption is rare and copies get cleaned
  up; `NOTE:` at the function in `dot-commands.ts` says to remember the last `n` if they ever
  pile up.

### Checked and left alone

- **The rename-failure branch in `reportAndQuarantine` is still untested.** Provoking a rename
  failure portably (this repo runs CI on Windows) needs a permissions trick that would be flaky;
  the branch is four lines and reports rather than swallows. The read-failure test added above
  covers the neighbouring path, which was the more valuable of the two gaps.
- **Arm B's repeated startup warnings.** A permanently-broken plugin now warns at every start
  instead of disabling itself once. That is the intended trade — the alternative silently drops
  plugins over transient network faults — and the message names the fix.
- **`reportAndQuarantine` shared by the read and parse paths.** DRY per `AGENTS.md`; both arms
  now have their own test, so the shared helper is no longer single-path-tested.
- **The lost-update `NOTE:` above `savePlugins`** — a pre-existing accepted tradeoff about two
  concurrent sessions, unrelated to atomicity and unchanged by this work.

## Validation

- `yarn test` (full workspace) — all suites pass, no failures anywhere in the log.
- `yarn workspace @quereus/quoomb-cli test` — 64 passed (was 60).
- `yarn workspace @quereus/quoomb-cli run typecheck` — clean.
- `yarn lint` (full workspace) — clean; quoomb-cli has the intentional `No lint configured`
  no-op, only `packages/quereus` has a real lint and it is untouched by this change.
