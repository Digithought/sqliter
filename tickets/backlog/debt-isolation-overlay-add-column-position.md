---
description: The transaction-isolation layer passes a "put the new column here" request straight through to the storage underneath it, but its own private copy of the rows always puts the column at the end — so the two would end up disagreeing about which value is which.
files:
  - packages/quereus-isolation/src/isolation-module.ts   # alterTable forwards `change` verbatim (~1447); translateOverlayRow appends (~2018)
  - packages/quereus/src/vtab/module.ts                  # the insertAtIndex option on the addColumn change (~554)
  - packages/quereus/src/vtab/memory/layer/manager.ts    # the memory module's positioned add (~1836)
difficulty: medium
---

# Isolation layer forwards a column position it does not itself honor

## Background in plain terms

The transaction-isolation layer sits between the engine and a real storage module. Each open
connection gets a private side table — an "overlay" — holding the rows that connection has
written but not committed. The overlay has the same columns as the real table plus one extra
bookkeeping column at the end that marks a row as deleted.

`alter table … add column` normally puts the new column at the end. A recent change added an
option (`insertAtIndex` on the `addColumn` schema change) letting an in-process caller ask for
the column at a specific position instead. There is no SQL syntax for it — it is a
module-to-module option only. The memory module honors it; the store module rejects a position
it cannot honor.

## The problem

The isolation layer passes the schema change straight through to the storage module underneath
it, including the position. But when it rebuilds its own overlay rows for the new shape, it
unconditionally appends the new value just before the bookkeeping column. So the underlying
table would place the column at the requested position while the overlay places it at the end.

Two consequences, both silent:

- The overlay's *schema* is derived from the post-change underlying schema, so it would claim
  the new column sits at the requested position while the overlay's *rows* have it at the end.
  Every value from that position onward is then read under the wrong column's name.
- A caller has no way to tell: nothing rejects, nothing warns.

## Why this is not urgent

Nothing sets `insertAtIndex` today outside of tests, so no code path reaches this. It is filed
so that whoever *does* wire up a caller finds the problem already described rather than
debugging it from a wrong-column-values symptom.

## What "done" looks like

Either of these is acceptable; pick one deliberately:

- **Honor it.** Translate the requested position into the overlay's own layout (which is the
  underlying layout plus a trailing bookkeeping column, so a position that is valid for the
  underlying is valid for the overlay too) and splice the backfilled value in there instead of
  appending.
- **Reject it.** Throw `UNSUPPORTED` for any position, the way the store module does, until
  something needs it.

Honoring it is the more useful of the two, because the isolation overlay is the reason
`insertAtIndex` exists: the overlay's bookkeeping column must stay last, so an overlay that
mirrors an underlying `add column` needs to insert ahead of it rather than append. If that
mirroring is the work being picked up here, honoring the position is the whole point.

Either way, cover it with a test that drives an `add column` at a non-append position through
the isolation module with rows staged in an open overlay, and checks that a plain `select`
afterwards returns each value under the right column name.
