----
description: If the command-line tool's plugin list file gets damaged, the tool acts as though no plugins were ever installed and says nothing — and the next plugin command overwrites the damaged file, so the user's plugin list and settings are gone for good.
files:
  - packages/quoomb-cli/src/commands/dot-commands.ts (`loadPlugins`, `savePlugins`)
difficulty: easy
----

## What happens

The CLI keeps installed plugins in `~/.quoomb/plugins.json`. `loadPlugins`
reads and parses that file inside a `try`, and on *any* failure returns an
empty list with no message:

```ts
const loadPlugins = async (): Promise<PluginRecord[]> => {
  try {
    ...
    return JSON.parse(data);
  } catch (error) {
    // File doesn't exist or is invalid, return empty array
    return [];
  }
};
```

"File doesn't exist" is the normal first-run case and rightly silent. "File is
invalid" is not: a truncated write (power loss, full disk), a hand-edit with a
trailing comma, or an encoding mishap all land in the same branch. Then:

- startup loads no plugins and prints nothing, so the user's plugins simply
  stop working with no explanation;
- `.plugin list` reports `No plugins installed`;
- the next `.plugin install` starts from the empty list and `savePlugins`
  writes it back over the damaged file — the remaining records, their enabled
  flags, their recorded module hashes and all their configured settings are
  overwritten with the one new record.

So a recoverable problem (a file a user could have fixed by hand, or that still
holds most of its content) becomes unrecoverable, and nothing ever said so.
This also runs against the project rule that exceptions are not to be swallowed
silently.

## Expected behavior

- A missing file stays silent — that is a normal empty state.
- A file that exists but cannot be read or parsed is reported: say what path
  failed and why, in a message a user can act on.
- The CLI must not overwrite content it could not understand. Something like
  moving the unreadable file aside (`plugins.json.corrupt-<n>`) before writing a
  fresh one, or refusing plugin-mutating subcommands until the user resolves it,
  so the old content is still there to recover settings from.

Whichever way it goes, the user should be able to tell the difference between
"no plugins installed" and "your plugin list could not be read".

## Notes

Found while reviewing bug-cli-plugin-commands-unusable-without-manifest, which
touched the same file's plugin lookup but not its load/save paths. Pre-existing
behavior, not introduced by that change.
