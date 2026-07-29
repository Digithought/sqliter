description: When two open connections share the same table and one of them changes the table's shape (say, adds a column), the other connection never hears about it and keeps reading the table with the old column list, so its results come back mislabelled.
files:
  - packages/quereus-isolation/src/isolation-module.ts   # alterTable — updates the issuer's catalog only
  - packages/quereus/src/schema/manager.ts               # per-Database catalog; SchemaChangeNotifier lives here
  - packages/quereus-isolation/test/isolation-layer.spec.ts
difficulty: medium
---

# What was observed

Each `Database` object keeps its own catalog — its own record of what tables exist and what
columns they have. Two `Database` objects can share one storage module, and therefore one
physical table. When one of them runs a statement that changes the table's shape, only that
one's catalog is updated. The other keeps the shape it last knew.

Seen directly while reproducing an unrelated bug. Connection A added a column named `c`;
connection B, reading the same table straight afterwards, got the new value back under the
placeholder name `col_2` instead of `c`, because B's catalog still listed only the original
two columns and the third value had no name to bind to.

```
A: alter table t add column c integer
B: select * from t   →   { id: 1, x: 1, col_2: <value> }     (expected: c: <value>)
```

A dropped or renamed column would be worse than a mislabelled one: B would be reading values
positionally against a column list that no longer matches the data.

# Why it is filed rather than fixed

Nothing in the engine currently claims to do this. There is a `SchemaChangeNotifier` inside a
single `Database`'s catalog, but nothing carries a change *between* `Database` objects, and no
test asserts that it should. So this is a gap in what the design covers, not a regression, and
deciding what it should do is a design question rather than a repair:

- Should a second connection see another's committed shape change automatically, or only after
  it re-opens / re-reads the table?
- What happens to a connection that is *mid-transaction* when the shape changes underneath it?
  The isolation layer already has an answer for its staged rows — it makes that connection fail
  and demand a rollback when the rows can no longer be carried forward — but a connection whose
  rows migrate cleanly currently carries on with a stale column list.
- Does this matter outside a single process? Two connections sharing one in-memory module is
  mostly a test and embedding shape; separate processes over a persistent store re-read the
  schema from the store and would not hit it the same way. Worth confirming which real
  deployments are exposed before sizing the work.

# How to see it

Two `Database` instances registered against one `IsolationModule`. Only the first creates the
table; the second is given the same catalog entry so it can resolve the name:

```ts
dbB.registerModule('isolated', iso);
dbB.schemaManager.getMainSchema().addTable(dbA.schemaManager.getTable('main', 't')!);
```

Then `alter table t add column c integer default 0` on A (a DEFAULT so B's rows migrate
cleanly and B is not made to fail), and `select * from t` on B.

# Expected behaviour

To be decided — see the questions above. At minimum, a connection must never silently return
rows read against a stale column list. Failing loudly and telling the connection to re-read the
schema is an acceptable answer; returning mislabelled or positionally-shifted values is not.
