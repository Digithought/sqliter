----
description: One file in the command-line tool holds every interactive dot command — CSV import and export, result formatting, and the whole plugin manager — and has grown large enough that unrelated features now collide in it; split it up by topic.
files:
  - packages/quoomb-cli/src/commands/dot-commands.ts   # 1189 lines (wc -l, 2026-08-03)
  - packages/quoomb-cli/test/plugin-commands.spec.ts   # its plugin-side suite, which would split the same way
difficulty: medium
----

# `dot-commands.ts` is a grab-bag

Measured with `wc -l packages/quoomb-cli/src/commands/dot-commands.ts` on 2026-08-03:
**1189 lines**, holding at least four unrelated responsibilities behind one
`handleDotCommand` / `DotCommands` pair:

- CSV import and export (papaparse, file I/O)
- result-table rendering and output-mode switches
- schema/introspection commands (`.tables`, `.schema`, …)
- the entire plugin manager: the `~/.quoomb/plugins.json` record store
  (`loadPlugins`/`savePlugins`), install/remove/enable/disable/reload/config, and
  the hash-pinning commands (`pin`, `unpin`, `trust`) with their reporting helpers

The plugin half alone is roughly half the file and is where all recent work has
landed — three consecutive tickets (`feat-plugin-loader-hash-pinning`,
`feat-cli-plugin-pinning`, `feat-config-declared-plugin-hashes`) each edited it,
and each had to read past the CSV and formatting code to find its site. A
separate open ticket, `bug-cli-corrupt-plugins-file-silently-wipes-plugins`,
targets the record store inside the same file.

## What good looks like

Topic-sized modules behind the existing dispatcher, so the entry point still
resolves `.foo` to a handler but each area is readable and testable on its own.
A plausible cut:

- the plugin record store (read/write/locate `~/.quoomb/plugins.json`)
- the plugin subcommands, split from that store so a corrupt-file fix has one
  place to live
- CSV import/export
- result formatting

The pin/trust reporting helpers added by `feat-config-declared-plugin-hashes`
(`reportPinState`, `reportConfigPinOverride`, `reportPinViolation`) belong with
the plugin subcommands, not with the record store — they are all output.

## Why it is not urgent

Nothing is broken and the file is still navigable by search. This is a
maintainability call: the plugin area has an active queue against it, so the
split pays off the next time one of those tickets is worked, and the seam is
obvious enough that the split is mechanical rather than a redesign.

## Related

- `bug-cli-corrupt-plugins-file-silently-wipes-plugins` — targets `loadPlugins`
  and `loadEnabledPlugins` in this same file. Whichever lands second should
  rebase onto the other rather than both moving the same code.
