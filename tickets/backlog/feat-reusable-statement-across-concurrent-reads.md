description: Two reads that share the same pre-compiled query now collide and one of them fails, so callers wanting concurrent reads must build a separate copy of the query per caller.
files: packages/quereus/src/core/statement.ts, packages/quereus/src/core/database.ts, packages/quereus/test/core/concurrent-committed-reads.spec.ts
difficulty: hard
tradeoffs: The workaround - one statement per concurrent caller - is documented and works, and separating per-execution state from the compiled plan changes the Statement contract that every existing caller depends on.
----

# Let one prepared statement serve several concurrent reads

A `Statement` is the reusable, already-parsed-and-compiled form of a query. The
natural way to use one is to prepare it once at startup and run it many times.

With the new opt-in concurrent read path (`readConcurrency: 'committed'`), two
overlapping executions of the *same* `Statement` object now collide: the second
one throws `MisuseError: Statement busy, another iteration may be in progress or
reset needed.` Before that opt-in existed, every execution queued behind the
database's execution mutex, so two executions could never overlap and the guard
was unreachable.

Nothing is corrupted — the guard fires and one caller gets a clear error — but it
is the wrong shape for the feature. A caller opting into concurrent reads is
usually doing so precisely because it has several readers in flight, and the
statement it most wants to share is the hot one it prepared once.

The workaround today (documented in the usage guide) is to give each concurrent
caller its own statement; `db.get` and `db.eval` prepare per call and are
therefore already safe.

## What would need to change

`Statement` keeps state that belongs to a single execution rather than to the
compiled query: the bound argument values and the busy flag. The compiled plan,
the emitted instruction tree, and the scheduler are genuinely reusable — those
are already cached and shared across executions deliberately.

Separating the two — an immutable compiled statement plus a per-execution handle
carrying its own arguments — would let N reads run against one prepared query at
once. That is a real interface change with knock-on effects on the parameter
binding API (`stmt.bindAll`, `stmt.reset`) and on every existing caller, which is
why this is filed rather than fixed in place.

## Expected behaviour

```ts
const stmt = db.prepare('select id from t where kind = ?');
const [a, b] = await Promise.all([
  collect(stmt.all(['x'], { readConcurrency: 'committed' })),
  collect(stmt.all(['y'], { readConcurrency: 'committed' })),
]);
```

Both complete, each seeing only its own bound argument.

## Current behaviour is pinned by a test

`test/core/concurrent-committed-reads.spec.ts` — "two overlapping reads on the
SAME prepared statement still hit the busy guard". Update that test when this
lands; it exists so the limitation cannot change silently.
