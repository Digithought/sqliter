description: A table CHECK rule that looks up values in another table is checked against out-of-date data, so a transaction can be rejected for a value that is actually there, or accepted for one that was removed.
prereq:
files:
  - packages/quereus/src/planner/building/constraint-builder.ts   # needsDeferred = containsSubquery(...)
  - packages/quereus/src/runtime/deferred-constraint-queue.ts     # runDeferredRows / findConnection
  - packages/quereus/src/runtime/emit/subquery.ts                 # suspected: IN probe set frozen at row-write time
  - packages/quereus/src/runtime/types.ts                         # RuntimeContext.inSetProbes
  - packages/quereus/test/logic/41.11-deferred-fk-with-rename.sqllogic  # case 10 NOTE points here
difficulty: medium
----

# A deferred CHECK with a subquery evaluates against pre-transaction data

## What happens

Quereus lets a `CHECK` constraint contain a subquery, e.g.

```sql
create table lookup (code text primary key);
create table t (id integer primary key, code text,
    check (code in (select code from lookup)));
```

Because the expression reads another table, the engine cannot decide it at the moment the row
is written — it postpones the check to `COMMIT`
(`planner/building/constraint-builder.ts`, `needsDeferred = containsSubquery(expression) || …`).
Postponing is the whole point: by commit the transaction has finished, so the check should see
everything the transaction did.

It does not. The check sees the data as it stood *before* the transaction started.

## Reproduction

Both of these are wrong, and both reproduce on the memory backend at HEAD. Neither involves
`ALTER TABLE`; the failure has nothing to do with renames.

**A false violation — the value IS there by commit time:**

```sql
create table zl (code text primary key);
create table zt (id integer primary key, code text,
    constraint zt_ck check (code in (select code from zl)));

begin;
insert into zt values (1, 'a');
insert into zl values ('a');   -- supplies the value the check needs
commit;
-- observed: ConstraintError: CHECK constraint failed: zt_ck (code in (select code from zl))
-- expected: commit succeeds
```

**A false pass — the value is GONE by commit time:**

```sql
create table zl2 (code text primary key);
insert into zl2 values ('a');
create table zt2 (id integer primary key, code text,
    constraint zt2_ck check (code in (select code from zl2)));

begin;
insert into zt2 values (1, 'a');
delete from zl2 where code = 'a';   -- removes the value the check needs
commit;
-- observed: commit succeeds, leaving a row that violates its own CHECK
-- expected: ConstraintError
```

The false-pass direction is the serious one: it leaves committed data that the constraint
forbids, and the violation is invisible until something re-validates the table.

## Why this is expected to work

The deferred *foreign key* path — the same queue, the same commit-time evaluation — does read
the transaction's own writes correctly. `41-foreign-keys` and `41.11-deferred-fk-with-rename`
both rely on a parent row inserted after the child, and a parent deleted after the child is
correctly caught. So the queue machinery can see in-transaction state; the subquery-CHECK shape
is the one that does not.

## Where the investigation stopped

Not root-caused. The evidence points at the `IN` subquery's probe set being built once, when the
row is written, and reused verbatim by the frozen evaluator at commit — rather than the check
re-reading the table. That would explain both directions at once (a later insert is not in the
frozen set; a later delete is still in it). A read-only detail that supports this: the check does
NOT go through a table scan at commit, since disabling
`DeferredConstraintQueue.notifyTableRename` — which is what lets a parked check survive an
`ALTER TABLE ... RENAME TO` — changes nothing for this shape, while it breaks every deferred FK
case immediately.

`readCommitted` is not the explanation: that flag is opt-in via the `committed.` schema prefix in
the SQL text and is false for a plain `select … from lookup`.

## Expected behavior

A deferred CHECK containing a subquery must evaluate at `COMMIT` against the state the
transaction will actually commit — the same read-your-own-writes view a `select` issued just
before the `commit` would see. Both reproductions above should then behave as marked "expected".

## Scope note

Found during review of `deferred-foreign-key-breaks-when-table-renamed-in-same-transaction`.
It is independent of that work and reproduces without any `ALTER TABLE` involved. Case 10 of
`packages/quereus/test/logic/41.11-deferred-fk-with-rename.sqllogic` carries a `NOTE` pointing at
this slug; when this lands, revisit whether that case can be strengthened into a real guard.
