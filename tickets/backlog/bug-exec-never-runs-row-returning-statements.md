---
description: The engine's fire-and-forget "just run this SQL" call quietly skips any statement that returns rows — a query passed to it is planned but never actually executed, so its work never happens and any error it would raise never surfaces.
files:
  - packages/quereus/src/core/database.ts        # exec / _executeSingleStatement (~line 669-778) — runs the scheduler, discards the block result
  - packages/quereus/src/runtime/emit/block.ts   # emitBlock — returns the last statement's value; nothing drains it
  - packages/quereus/src/planner/nodes/sink-node.ts  # the existing "consume a relation for its side effects" node
repro: verified
---

# `Database.exec` never runs a statement that returns rows

## What happens

`exec` is the fire-and-forget entry point: "run this SQL, I don't want the rows." For a
statement that produces rows, it does not run it at all — it plans and emits the query,
then throws away the un-consumed row stream.

Verified on `main` (memory backend). A `select` calling a user-defined scalar function
that throws:

```ts
db.createScalarFunction('boom', { numArgs: 1 }, () => { calls++; throw new Error('boom'); });

await db.exec('select boom(id) from t');   // returns normally; calls === 0
for await (const _ of db.eval('select boom(id) from t')) {}  // throws on the first row; calls === 1
```

Under `exec` the function is never called even once. Statements that do not return rows
(DDL, and DML — which is wrapped in a `SinkNode` that drains it) are unaffected.

## Why it is worth a decision

Twice now a statement has silently done nothing because of this, and each time it was
patched at the statement instead of at `exec`:

- the setter form of `PRAGMA` is wrapped in a `SinkNode` with the comment "wrap with
  SinkNode to ensure execution";
- `ANALYZE` collected no statistics at all under `exec` until
  `bug-analyze-via-exec-is-a-no-op` made it do its work eagerly.

Every future statement that returns rows *and* has an effect walks into the same trap, and
the failure mode is the worst kind — no error, no warning, just nothing happening.

For comparison, SQLite's `sqlite3_exec` does run a `select`; it invokes a per-row callback
and simply lets the caller pass none. Quereus diverges from that.

## The question for a human

Should `exec` drain the block's result relation?

Arguments for: it removes the whole class of bug, matches SQLite, and makes `exec('select
…')` mean what a caller plainly expects — including surfacing errors the query would
raise.

Arguments against: it is a behaviour change to a public API. Anything that today passes a
query to `exec` as a cheap "does this parse and plan" check would start paying for the
full scan, and anything that currently swallows a runtime error would start throwing. How
much code that is has not been surveyed.

The alternative is to leave `exec` alone and keep patching statements one at a time, in
which case the rule ("a statement-level node that returns rows must do its work eagerly or
be sunk") should at least be written down where a new statement author will meet it.

Not urgent — no known live defect depends on it now that `ANALYZE` is fixed. Filed so the
next occurrence is a known question rather than a fresh surprise.
