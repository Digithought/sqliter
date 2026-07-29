----
description: In the command-line tool, a plugin installed from a web address that has no package description file cannot afterwards be turned off, turned on, reloaded, configured, or removed — every one of those commands looks the plugin up by a name it never got.
files:
  - packages/quoomb-cli/src/commands/dot-commands.ts (`enablePluginCommand`, `disablePluginCommand`, `uninstallPluginCommand`, `configPluginCommand`, `reloadPluginCommand`, `listPluginsCommand`)
  - packages/plugin-loader/src/plugin-loader.ts (`tryLoadManifestFromUrl`)
difficulty: easy
----

## What happens

`.plugin install <url>` succeeds and saves a record. The plugin's display name
comes from a `package.json` fetched from the same directory as the module
(`tryLoadManifestFromUrl`). Plenty of real hosting layouts have no such file
beside the module — a single `.mjs` published to a static host, a raw file URL
pointing at a build output directory, a gist. When that fetch 404s the record is
saved with no manifest at all.

Every `.plugin` subcommand except `install` and `list` then finds its target with
`plugins.find(p => p.manifest?.name === name)`. With no manifest there is no name
to pass, so:

- `.plugin list` shows the plugin as `Unknown` with its URL underneath.
- `.plugin enable`, `.plugin disable`, `.plugin reload`, `.plugin config`, and
  `.plugin uninstall` all report `Plugin '<whatever>' not found`.

The record is stuck: it keeps autoloading (or, if a load ever failed, keeps
sitting disabled) and the user has no command that can reach it. The only way out
is hand-editing `~/.quoomb/plugins.json`.

This is not new — the lookup has always been manifest-name-based — but it became
easy to hit now that `https:` plugin URLs work under Node at all, since a bare
module URL is the normal way to install one.

## Expected behavior

A user must be able to manage every installed plugin from the CLI, whether or not
its manifest resolved. Two directions worth considering (either or both):

- Let the subcommands accept the plugin's URL, or a unique prefix of it, in
  addition to the manifest name — `list` already shows the URL, so it is
  something the user can see and copy.
- Give every record a fallback display name derived from the URL (last path
  segment, say) when no manifest is available, so `list` shows something
  addressable and the existing name lookup keeps working.

Either way `.plugin list` should print the identifier the other subcommands
accept, so what the user sees is what they can type.
