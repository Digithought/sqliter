----
description: Fixed a CLI bug where a plugin installed from a web address with no package description file could never afterwards be turned off, turned on, reloaded, configured, or removed.
files:
  - packages/quoomb-cli/src/commands/dot-commands.ts
  - packages/quoomb-cli/test/plugin-commands.spec.ts
  - packages/quoomb-cli/README.md
  - docs/plugins.md
----

## What was wrong

`.plugin install <url>` loads the module via `dynamicLoadModule`, which
optionally fetches a `package.json` beside it for a manifest (name, version,
description, settings). Plenty of real hosting layouts don't have one — a bare
`.mjs` on a static host, a raw file URL, a gist. When that fetch 404s the saved
`PluginRecord` has no `manifest`, and every other `.plugin` subcommand (`list`,
`enable`, `disable`, `remove`, `config`, `reload`) looked the record up by
`plugin.manifest?.name` — `undefined` for that record, so it could never be
found again by name. `list` printed it as `Unknown`. The only recovery was
hand-editing `~/.quoomb/plugins.json`.

## What shipped

In `packages/quoomb-cli/src/commands/dot-commands.ts`, near
`loadPlugins`/`savePlugins`:

- `deriveNameFromUrl(url)` — name from the URL's last path segment (stripping
  `.js`/`.mjs`), falling back to hostname, then the raw URL.
- `displayName(plugin)` — the manifest name when there is a usable one,
  otherwise the derived name. Single source of truth for what a plugin is
  called, everywhere it is printed. "Usable" excludes names containing
  whitespace, because subcommand arguments are whitespace-split: the loader
  names a `package.json` that has no `name` field `'Unknown Plugin'`, which no
  user could ever type as one argument.
- `resolvePlugin(plugins, identifier)` — resolves a display name or an exact
  install URL to one record, and owns the `not found` message plus a new
  ambiguity report (below) so all six subcommands word them identically.

Every subcommand that matched on `p.manifest?.name === name` now goes through
`resolvePlugin`/`displayName`: `enable`, `disable`, `remove` (was a duplicated
`findIndex` predicate), `config`, `reload`, `list`, `install`'s success message,
`reconcilePluginHash`'s "run `.plugin reload <name>`" hint, and
`loadEnabledPlugins`'s load-failure warning and retry hint. Confirmation
messages now echo the canonical `displayName` rather than the raw string the
user typed, so addressing a plugin by URL reports back the name `list` shows.

`.plugin` help text existed in two places that had already drifted apart
(`DotCommands.printHelp` and `handlePluginCommand`'s default branch); both now
render one `PLUGIN_HELP_LINES` array, updated to `<name|url>`, as are the
per-subcommand `Usage:` lines.

No changes in `packages/plugin-loader` — `tryLoadManifestFromUrl` legitimately
returns `undefined` on a 404 and should keep doing so; only the CLI needed a
fallback identifier.

Docs: `packages/quoomb-cli/README.md` gained a plugin-commands table and the
naming rule (its dot-command table also listed four commands the CLI does not
implement — `.indexes`, `.mode`, `.output`, `.read` — and omitted `.help`,
`.import`, `.export` and `.plugin`; corrected while there). `docs/plugins.md`
gained a short CLI subsection alongside its existing Web UI one, saying how a
manifest-less plugin gets addressed and why the web UI needs no equivalent
(it keys on the record `id`).

## Review findings

### Fixed in this pass (minor)

- **Ambiguous derived names silently acted on the wrong plugin.** The
  implementer flagged the collision (two manifest-less plugins whose URLs end
  in the same file name, e.g. `a.example/plugin.mjs` and `b.example/plugin.mjs`,
  both derive `plugin`) but left `find` returning the first match. For `remove`
  that is a silent destructive wrong-target. `resolvePlugin` now reports the
  ambiguity and lists the candidate URLs instead of guessing; the URLs it prints
  are accepted identifiers, so the report is also the fix. Test added.
- **A `package.json` without a `name` field still yielded an unusable
  identifier.** The loader substitutes `'Unknown Plugin'`, `displayName` took it
  verbatim, and `.plugin disable Unknown Plugin` cannot be typed —
  `handlePluginCommand` splits arguments on whitespace, so it would look up
  `Unknown`. Same dead end as the original bug via a different route.
  `displayName` now rejects whitespace-bearing manifest names and derives from
  the URL. Test added.
- **`removePluginCommand` re-implemented the lookup predicate** rather than
  reusing the helper, and the `not found` message was copy-pasted across five
  subcommands. Both collapsed into `resolvePlugin`.
- **Help text was duplicated and already inconsistent** between `.help` and
  bare `.plugin`. Deduplicated into `PLUGIN_HELP_LINES`; `<name|url>` now
  documented in both, and in each subcommand's `Usage:` line — the change added
  URL-as-identifier without telling users anywhere.
- **Docs were stale in both directions** (see above): `.plugin` was undocumented
  entirely and the README listed non-existent commands.

### Test coverage added

The implementer's two tests (manifest-less round-trip, manifest-name smoke
check) were a fair start but left every changed line outside `find` unasserted.
Now 7 tests in `packages/quoomb-cli/test/plugin-commands.spec.ts`; the fetch
stub became a route map so a test can serve its own module and manifest. New:

- URL as identifier, asserting the canonical name is echoed back and the record
  actually flipped on disk.
- Ambiguous derived name: reports, changes nothing, then disambiguates by URL.
- `package.json` with no `name`: asserts the record really does hold
  `'Unknown Plugin'` and that the derived name works anyway.
- `config <name> key=value`: asserts the typed value is parsed and persisted
  (`{depth: 5}`) and read back by a later `config` — the implementer named this
  as an untested gap.
- `loadEnabledPlugins` failure path: module host goes away after install,
  asserting the warning and the `.plugin enable <name>` hint both name the
  derived name, and that the record was disabled — the other named gap.

Assertions read `~/.quoomb/plugins.json` rather than trusting console output
alone. `reconcilePluginHash`'s "module changed" hint is still only covered
indirectly (it calls the same `displayName`); its own behavior is covered by
`remote-resolver.spec.ts`.

### Filed as a new ticket (major)

- `backlog/bug-cli-corrupt-plugins-file-silently-wipes-plugins` — `loadPlugins`
  swallows *every* error, including a JSON parse failure, and returns an empty
  list with no message; the next `savePlugins` then overwrites the damaged file,
  destroying the surviving records, enabled flags, hashes and settings.
  Pre-existing and outside this ticket's lookup change, but adjacent and a
  data-loss path, and it violates the project's no-silent-swallow rule.

### Recorded as a tripwire, not a ticket

- Every subcommand read-modify-writes the whole `plugins.json`, so two
  concurrent CLI sessions can have the later save drop the earlier one's change.
  Harmless for a single interactive user. `NOTE:` comment at `savePlugins`.

### Checked, nothing to do

- **Other hosts with the same shape.** `quoomb-web`'s `PluginsModal` addresses
  plugins by the record `id` for every mutation, so it has no equivalent lookup
  bug; its `'Unknown Plugin'` label is display-only, with the URL shown beneath.
  Cosmetic, no ticket. The VS Code extension has no plugin management surface.
- **`deriveNameFromUrl` edge cases.** Query strings are excluded by using
  `URL.pathname`; trailing slashes are dropped by `filter(Boolean)`; `file:`
  URLs (allowed by `validatePluginUrl`) produce the file name on both POSIX and
  Windows paths; an unparseable URL falls back to the raw string. No change.
- **`plugin-loader`.** Correctly returns `undefined` when no manifest is
  reachable; the fallback belongs in the host, where it now is.
- **`os.homedir()` uncached in `getPluginsFilePath`** (implementer's note) —
  called per load/save, which is what makes it spy-able per test. Not worth
  hoisting; no finding.

## Validation

- `yarn lint` — clean (exit 0; only `packages/quereus` has a real lint, the rest
  are the intentional no-ops).
- `yarn workspace @quereus/quoomb-cli run typecheck` — clean (covers `test/`).
- `yarn workspace @quereus/quoomb-cli run build` — clean.
- `yarn test` (whole repo) — exit 0; quoomb-cli 17 tests in 3 files, engine
  7981 passing / 13 pending, all other workspaces passing. No pre-existing
  failures encountered.
