description: In the command-line tool, a plugin installed from a web address that has no package description file cannot afterwards be turned off, turned on, reloaded, configured, or removed — every one of those commands looks the plugin up by a name it never got.
files:
  - packages/quoomb-cli/src/commands/dot-commands.ts (`installPluginCommand`, `listPluginsCommand`, `enablePluginCommand`, `disablePluginCommand`, `removePluginCommand`, `configPluginCommand`, `reloadPluginCommand`, `loadEnabledPlugins`, `reconcilePluginHash`)
difficulty: easy
----

## Root cause (confirmed)

`.plugin install <url>` calls `dynamicLoadModule`, which tries to fetch a
`package.json` beside the module (`tryLoadManifestFromUrl` in
`packages/plugin-loader/src/plugin-loader.ts:102`). Plenty of real hosting
layouts don't have one — a single `.mjs` on a static host, a raw file URL into
a build-output directory, a gist. When that fetch 404s, `dynamicLoadModule`
resolves `undefined` and the saved `PluginRecord` has no `manifest`.

Every other `.plugin` subcommand in `packages/quoomb-cli/src/commands/dot-commands.ts`
finds its target with the same pattern:

```ts
const plugin = plugins.find(p => p.manifest?.name === name);
```

(lines 536, 574, 620, 710, and `findIndex` at 600). With no manifest there is
no `name` to type, so `enable`/`disable`/`reload`/`config`/`remove` all report
`Plugin '<whatever>' not found`, and `listPluginsCommand` (line 517) prints the
record as `Unknown`. The record is stuck enabled-but-unmanageable (or, if a load
ever fails, `loadEnabledPlugins` at line 741 disables it and the failure hint at
line 772 can't name a working `enable` target either). The only way out today is
hand-editing `~/.quoomb/plugins.json`.

## Fix design

Give every plugin record a **display identifier** that's always addressable,
and make every lookup accept it (or the record's install URL). Concretely, add
to `dot-commands.ts` (near `loadPlugins`/`savePlugins`, ~line 405):

```ts
/**
 * Derives a display name from a plugin's URL for when no manifest was
 * available to name it (e.g. package.json 404s beside the module).
 * Falls back to the full URL if it cannot be parsed into segments.
 */
const deriveNameFromUrl = (url: string): string => {
  try {
    const { pathname, hostname } = new URL(url);
    const segments = pathname.split('/').filter(Boolean);
    const last = segments[segments.length - 1] || hostname;
    return last.replace(/\.m?js$/i, '');
  } catch {
    return url;
  }
};

/**
 * The identifier `.plugin list` prints and every other `.plugin` subcommand
 * accepts: the manifest name when one loaded, otherwise a name derived from
 * the URL so a manifest-less plugin is still addressable.
 */
const displayName = (plugin: PluginRecord): string => plugin.manifest?.name ?? deriveNameFromUrl(plugin.url);

/** Finds an installed plugin by display name or by its exact install URL. */
const findPlugin = (plugins: PluginRecord[], identifier: string): PluginRecord | undefined =>
  plugins.find(p => displayName(p) === identifier || p.url === identifier);
```

Then thread `displayName`/`findPlugin` through every call site so what
`.plugin list` prints is exactly what the other subcommands accept:

- `listPluginsCommand` (~line 517): `const name = plugin.manifest?.name || 'Unknown';` → `const name = displayName(plugin);`
- `enablePluginCommand` (~line 536): `plugins.find(p => p.manifest?.name === name)` → `findPlugin(plugins, name)`
- `disablePluginCommand` (~line 574): same swap
- `removePluginCommand` (~line 600, uses `findIndex`): `plugins.findIndex(p => p.manifest?.name === name)` → `plugins.findIndex(p => displayName(p) === name || p.url === name)`
- `configPluginCommand` (~line 620): same swap as enable/disable
- `reloadPluginCommand` (~line 710): same swap
- `installPluginCommand` success message (~line 521): `manifest?.name || 'Unknown'` → `displayName(pluginRecord)`
- `reconcilePluginHash`'s hash-changed hint (~line 441): `plugin.manifest?.name ?? '<name>'` → `displayName(plugin)`
- `loadEnabledPlugins` failure path (~lines 762, 771-773): the warning and the
  `.plugin enable <name>` retry hint currently fall back to `plugin.url` or
  drop the hint entirely when there's no cached manifest name — both should
  just call `displayName(plugin)` unconditionally, since it now always
  resolves to something typeable.

No changes needed in `packages/plugin-loader` — `tryLoadManifestFromUrl` legitimately
returns `undefined` on a 404 and should keep doing so; the CLI is the only layer
that needs a fallback identifier.

## Verification

- `yarn workspace @quereus/quoomb-cli typecheck` (or `yarn typecheck` from repo root)
- Manual smoke test: install a plugin module URL with no `package.json` beside
  it (any `https://` or `file://` `.mjs`/`.js` with nothing named `package.json`
  in the same directory), confirm `.plugin list` shows a non-"Unknown" name
  derived from the URL, and that `.plugin disable <that-name>`, `.plugin enable
  <that-name>`, `.plugin reload <that-name>`, `.plugin config <that-name>`, and
  `.plugin remove <that-name>` all find it. Also confirm the existing
  manifest-name path (a plugin whose `package.json` *does* resolve) still works
  unchanged.
- No existing automated tests cover `dot-commands.ts` plugin subcommands
  (`packages/quoomb-cli` has no `.test.ts` files yet — `vitest run
  --passWithNoTests`). Adding coverage isn't required to close this ticket, but
  if it's cheap to wire up (mock `fs/promises` for the `~/.quoomb/plugins.json`
  round-trip and mock `dynamicLoadModule` from `@quereus/plugin-loader`), a
  small test file exercising `handleDotCommand` for a manifest-less install +
  enable/disable/reload/config/remove round-trip would close the gap.

## TODO

- Add `deriveNameFromUrl`, `displayName`, `findPlugin` helpers to `dot-commands.ts`
- Swap the manifest-only lookups in `enablePluginCommand`, `disablePluginCommand`,
  `removePluginCommand`, `configPluginCommand`, `reloadPluginCommand` for `findPlugin`/`displayName`
- Fix the display fallbacks in `listPluginsCommand`, `installPluginCommand`,
  `reconcilePluginHash`, and `loadEnabledPlugins`'s failure hint
- Typecheck the package and manually verify the install → list → disable →
  enable → reload → config → remove round-trip for a manifest-less plugin
