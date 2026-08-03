----
description: The command-line tool reacts to plugin problems by quietly destroying the user's plugin settings — a damaged plugin list is treated as an empty one and then overwritten, and a plugin that fails to load once is switched off for good.
files:
  - packages/quoomb-cli/src/commands/dot-commands.ts (`loadPlugins`, `savePlugins`, `loadEnabledPlugins`)
difficulty: easy
----

## Root cause

Both failures below live in the same file and are the same anti-pattern: **swallow a
load/parse error, then silently destroy the user's plugin configuration.** In one case the
destroyed thing is the whole plugin list; in the other it is one plugin's enabled flag.
Neither tells the user anything they can act on, and both run against the project rule that
exceptions are not to be swallowed silently. Fix them together — they are adjacent, both
easy, and a consistent answer to "what does the CLI do when a plugin problem occurs" is
better than two separate calls.

## Arm A — a damaged plugin list file is treated as no plugins, then overwritten

The CLI keeps installed plugins in `~/.quoomb/plugins.json`. `loadPlugins` reads and parses
that file inside a `try`, and on *any* failure returns an empty list with no message:

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

"File doesn't exist" is the normal first-run case and rightly silent. "File is invalid" is
not: a truncated write (power loss, full disk), a hand-edit with a trailing comma, or an
encoding mishap all land in the same branch. Then:

- startup loads no plugins and prints nothing, so the user's plugins simply stop working with
  no explanation;
- `.plugin list` reports `No plugins installed`;
- the next `.plugin install` starts from the empty list and `savePlugins` writes it back over
  the damaged file — the remaining records, their enabled flags, their recorded module hashes
  and all their configured settings are overwritten with the one new record.

So a recoverable problem (a file a user could have fixed by hand, or that still holds most of
its content) becomes unrecoverable, and nothing ever said so.

**Expected behavior**

- A missing file stays silent — that is a normal empty state.
- A file that exists but cannot be read or parsed is reported: say what path failed and why,
  in a message a user can act on.
- The CLI must not overwrite content it could not understand. Something like moving the
  unreadable file aside (`plugins.json.corrupt-<n>`) before writing a fresh one, or refusing
  plugin-mutating subcommands until the user resolves it, so the old content is still there
  to recover settings from.

Whichever way it goes, the user should be able to tell the difference between "no plugins
installed" and "your plugin list could not be read".

**Provenance:** found while reviewing `bug-cli-plugin-commands-unusable-without-manifest`,
which touched the same file's plugin lookup but not its load/save paths. Pre-existing
behavior, not introduced by that change.

## Arm B — one failed startup load disables the plugin permanently

At startup (`loadEnabledPlugins`) the CLI loads every plugin marked enabled. Any failure is
caught, a warning is printed, and the record is flipped to `enabled: false` and saved. The
next run therefore skips the plugin entirely, even if the failure was momentary.

Auto-disabling made sense when the only workable plugin sources were an installed npm package
and a `file://` URL: those fail deterministically, so a failure meant a genuinely broken
plugin. Now that plugins can be loaded from `https:` URLs, a failure is just as likely to be
transient and have nothing to do with the plugin:

- the machine was offline, or on a captive-portal network,
- DNS was slow enough to time out,
- the host returned a 5xx,
- a corporate proxy blocked the request.

Every one of those silently costs the user their plugin until they notice and turn it back on
by hand.

**Expected behavior**

A startup load failure that says nothing about the plugin's validity should not change the
saved configuration. The plugin stays enabled and the CLI warns again next time; a user who
wants it off says so with `.plugin disable`.

Whether *any* failure should still auto-disable is the open question. Options worth weighing:

- Never auto-disable; warn every start. Simplest, and puts the decision with the user.
  Downside: a permanently broken plugin nags forever.
- Auto-disable only for failures that clearly indict the plugin (the module parsed and threw,
  or has no default export) and never for fetch/transport failures. Needs the loader to
  distinguish the two rather than flattening everything into one `Failed to load plugin from
  …` string, which is the real work here.
- Count consecutive failures on the record and disable after N. Keeps the nagging bounded but
  adds state.

Note that the failure message now also tells the user the plugin was disabled and how to
re-enable it (that part landed with the https-plugin-loading work); it does not address the
policy itself.

**Interaction with plugin hash pinning.** `feat-cli-plugin-pinning` carves one specific
failure out of this catch block: when a load is refused because the module's bytes no longer
match the hash the user pinned, the record is *not* disabled (the hint would be wrong — the
plugin has to be re-trusted or unpinned, not merely re-enabled). That is a narrow exception,
deliberately not a general answer to the policy question above. Whoever settles Arm B should
fold that case into whatever general rule they land on rather than leaving two mechanisms.
The third option listed above — distinguish failures that indict the plugin from transport
failures — gets easier once that work lands, since `dynamicLoadModule` will preserve the
original error as `cause` instead of flattening everything into one string. Re-enabling by name is only possible when the plugin's manifest resolved —
that gap was closed by `bug-cli-plugin-commands-unusable-without-manifest`, which has since
completed.
