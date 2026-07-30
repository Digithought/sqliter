description: Fixed a CLI bug where a plugin installed from a web address with no package description file could never afterwards be turned off, turned on, reloaded, configured, or removed.
files:
  - packages/quoomb-cli/src/commands/dot-commands.ts
  - packages/quoomb-cli/test/plugin-commands.spec.ts
----

## What was wrong

`.plugin install <url>` loads the module via `dynamicLoadModule`, which
optionally fetches a `package.json` beside it for a manifest (name, version,
description, settings). Plenty of real hosting layouts don't have one — a
bare `.mjs` on a static host, a raw file URL, a gist. When that fetch 404s,
the saved `PluginRecord` has no `manifest`, and every other `.plugin`
subcommand (`list`, `enable`, `disable`, `remove`, `config`, `reload`) looked
the record up by `plugin.manifest?.name` — `undefined` for that record, so it
could never be found again by name. `list` printed it as `Unknown`. The only
recovery was hand-editing `~/.quoomb/plugins.json`.

## What changed

Added to `packages/quoomb-cli/src/commands/dot-commands.ts` (near
`loadPlugins`/`savePlugins`):

- `deriveNameFromUrl(url)` — derives a name from the URL's last path segment
  (stripping `.js`/`.mjs`), falling back to the hostname or the raw URL if
  parsing fails.
- `displayName(plugin)` — `plugin.manifest?.name ?? deriveNameFromUrl(plugin.url)`.
  This is now the single source of truth for what a plugin is called
  everywhere it's printed.
- `findPlugin(plugins, identifier)` — matches by `displayName(p) === identifier`
  or `p.url === identifier`, so a manifest-less plugin's derived name (or its
  install URL) both work as lookup keys.

Every subcommand that used to match on `p.manifest?.name === name` now calls
`findPlugin`/`displayName` instead: `enablePluginCommand`,
`disablePluginCommand`, `removePluginCommand` (was `findIndex`),
`configPluginCommand`, `reloadPluginCommand`, `listPluginsCommand`,
`installPluginCommand`'s success message, `reconcilePluginHash`'s
"module changed, run `.plugin reload <name>`" hint, and
`loadEnabledPlugins`'s load-failure warning + `.plugin enable <name>` retry
hint (previously fell back to the raw URL or dropped the hint entirely when
there was no cached manifest name — now always names something typeable).

No changes in `packages/plugin-loader` — `tryLoadManifestFromUrl` legitimately
returns `undefined` on a 404 and should keep doing so; only the CLI needed a
fallback identifier.

## Testing performed

- `yarn workspace @quereus/quoomb-cli run typecheck` — clean (covers
  `test/` via `tsconfig.test.json`).
- `yarn workspace @quereus/quoomb-cli run build` — clean.
- `yarn workspace @quereus/quoomb-cli run test` — 3 files, 12 tests, all pass.
- Added `packages/quoomb-cli/test/plugin-commands.spec.ts` (new file, this
  package previously had zero coverage of `.plugin` subcommands), exercising
  `handleDotCommand` end-to-end against a temp `~/.quoomb` (via a
  `os.homedir()` spy) and a stubbed `fetch` (via the same pattern
  `test/remote-resolver.spec.ts` already uses):
  - **Manifest-less round-trip** (the bug): install a module whose
    `package.json` fetch 404s → asserts the install/list output shows the
    derived name (`plain`, from `.../dist/plain.mjs`) and never `Unknown` →
    then `disable`/`enable`/`reload`/`config`/`remove` by that derived name,
    asserting none of them hit the `not found` path → final `list` confirms
    empty.
  - **Manifest-name path unchanged**: a second module whose `package.json`
    resolves with `{name: 'named-plugin', ...}` still installs/disables/enables
    by that manifest name, confirming the fix didn't disturb the working case.

## Known gaps for the reviewer

- Test coverage is new and narrow: it covers `install`/`list`/`disable`/
  `enable`/`reload`/`config`/`remove` for the manifest-less case and a smoke
  check of `disable`/`enable` for the manifest-name case, but doesn't cover
  `config <name> key=value` (setting a value), the `reconcilePluginHash`
  "module changed" warning/hint, or `loadEnabledPlugins`'s failure-path retry
  hint — all touched by this change but not directly asserted. Worth a look
  if the reviewer wants tighter coverage, though the shared `displayName`/
  `findPlugin` helpers mean those paths exercise the same two functions the
  new tests do cover.
- `deriveNameFromUrl` can collide: two different plugins whose URLs share a
  final path segment (e.g. `https://a.example/plugin.mjs` and
  `https://b.example/plugin.mjs`, both installed without a manifest) would
  both derive the display name `plugin`, and `findPlugin` returns the first
  match — `enable`/`disable`/etc. by that name would silently operate on
  whichever installed first. Not exercised by the new tests. `install` itself
  still dedupes correctly since it keys on exact URL equality, not display
  name, so this is a lookup-ambiguity gap, not a duplicate-install bug.
- Pre-existing, not introduced here: `os.homedir()` is called fresh in
  `getPluginsFilePath()` on every load/save (no caching), which is what makes
  it mockable per-test — not a concern for this ticket, just a note in case a
  future ticket goes looking for why that call isn't hoisted.
