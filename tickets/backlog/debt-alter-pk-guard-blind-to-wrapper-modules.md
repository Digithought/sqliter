---
description: A safety check that stops the engine from rebuilding a table when the storage backend cannot handle a table rename can be fooled by a wrapper backend — the wrapper always looks capable even when the backend it wraps is not, so the unsafe rebuild still runs and rows can end up stranded under a temporary table name.
files:
  - packages/quereus/src/runtime/emit/alter-table.ts        # runAlterPrimaryKey, `if (!module.renameTable)` guard (~1524)
  - packages/quereus-isolation/src/isolation-module.ts      # alterTable (~1284), renameTable (~1506) — both always defined, delegate conditionally
  - packages/quereus/src/vtab/module.ts                     # AnyVirtualTableModule: optional hooks (~415 alterTable, ~434 renameTable)
  - packages/quereus/src/vtab/capabilities.ts               # getCapabilities() — where a declared capability would live
difficulty: medium
---

# What is wrong

`alter table … alter primary key` asks the backend to re-key itself. A backend that cannot
raises `UNSUPPORTED`, and the engine falls back to rebuilding the table: create a shadow table,
copy the rows, drop the original, rename the shadow over it. That last rename is the problem —
a backend that never hears about it keeps its rows filed under the shadow table's name while
the catalog says otherwise, and the rebuilt table cannot be opened at all.

The engine guards against this by checking whether the backend implements a `renameTable`
hook, and refusing the statement when it does not. The check is "does this object have the
method", which is right for a plain backend but wrong for a **wrapper** backend — one that sits
in front of another and forwards to it. `@quereus/isolation` is the wrapper in this repo: it
always defines `renameTable` as a method and only forwards to the wrapped backend *if that one
has the hook*. So a backend with no rename support, wrapped in isolation, presents as capable,
the guard passes, the rebuild runs, and the rows are stranded exactly as the guard was meant to
prevent.

The same shape applies to the wrapper's `alterTable`: it always exists and raises `UNSUPPORTED`
when the wrapped backend has no hook, which is what routes the statement into the rebuild in the
first place. So the wrapper both opens the door and hides the lock.

# Why it is filed rather than fixed

Nothing in this repo hits it: the two built-in backends (memory, store) both implement
`renameTable`, so the wrapper's forward always lands. It needs a third-party backend without
rename support, used behind the isolation wrapper. The failure is then the original defect — a
table that reports a successful ALTER and cannot be read back.

# Expected behavior

A wrapper must not be able to claim a capability its wrapped backend lacks. Whatever the engine
asks — a declared capability flag, a delegating predicate, or something else — a wrapper's
answer should be the wrapped backend's answer, and the primary-key guard should refuse in the
wrapped-and-incapable case exactly as it does in the plain-and-incapable case.

Worth deciding once for the whole surface rather than only for `renameTable`: method-presence is
used as a capability probe in several places, and every one of them has this blind spot behind a
wrapper. A fix that only patches the primary-key guard leaves the pattern in place.

# Coverage to add

A test with a stub backend that implements neither `alterTable` nor `renameTable`, wrapped in
the isolation module, issuing `alter table … alter primary key (…)` in autocommit: it must be
refused with `UNSUPPORTED`, and the table must still be readable under its original key.
`packages/quereus/test/no-alter-module.ts` already builds the unwrapped stub.
