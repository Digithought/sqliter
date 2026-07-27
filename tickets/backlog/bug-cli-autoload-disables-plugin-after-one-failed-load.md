----
description: If the command-line tool cannot load a saved plugin at startup — for example because the machine is offline and the plugin lives at a web address — it permanently switches that plugin off, so it stays off on the next run even once the problem is gone.
files:
  - packages/quoomb-cli/src/commands/dot-commands.ts (`loadEnabledPlugins`)
prereq: bug-cli-plugin-commands-unusable-without-manifest
difficulty: easy
----

## What happens

At startup the CLI loads every plugin marked enabled. Any failure is caught, a
warning is printed, and the record is flipped to `enabled: false` and saved. The
next run therefore skips the plugin entirely, even if the failure was momentary.

Auto-disabling made sense when the only workable plugin sources were an installed
npm package and a `file://` URL: those fail deterministically, so a failure meant
a genuinely broken plugin. Now that plugins can be loaded from `https:` URLs, a
failure is just as likely to be transient and have nothing to do with the plugin:

- the machine was offline, or on a captive-portal network,
- DNS was slow enough to time out,
- the host returned a 5xx,
- a corporate proxy blocked the request.

Every one of those silently costs the user their plugin until they notice and turn
it back on by hand.

## Expected behavior

A startup load failure that says nothing about the plugin's validity should not
change the saved configuration. The plugin stays enabled and the CLI warns again
next time; a user who wants it off says so with `.plugin disable`.

Whether *any* failure should still auto-disable is the open question. Options
worth weighing in the ticket work:

- Never auto-disable; warn every start. Simplest, and puts the decision with the
  user. Downside: a permanently broken plugin nags forever.
- Auto-disable only for failures that clearly indict the plugin (the module
  parsed and threw, or has no default export) and never for fetch/transport
  failures. Needs the loader to distinguish the two rather than flattening
  everything into one `Failed to load plugin from …` string, which is the real
  work here.
- Count consecutive failures on the record and disable after N. Keeps the nagging
  bounded but adds state.

Note that the failure message now also tells the user the plugin was disabled and
how to re-enable it (that part landed with the https-plugin-loading work); it does
not address the policy itself. Re-enabling by name is only possible when the
plugin's manifest resolved — see the prerequisite ticket.
