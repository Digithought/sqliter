description: When a transaction changes the sorting rule of a primary-key column on a persistent table and the change is refused, the error message names an internal bookkeeping table instead of the table the user actually wrote.
files:
  - packages/quereus/src/vtab/memory/layer/manager.ts        # assertNoPrimaryKeyCollisionInLayer / assertNoPrimaryKeyCollisionInRows — both use `this._tableName`
  - packages/quereus-isolation/src/isolation-module.ts       # creates the staging overlay table under the `_overlay_<table>_<n>` name
difficulty: easy
----

# Re-key refusal names the internal staging table

On the persistent (store) backend, a transaction's uncommitted writes are held in a private
staging table owned by the isolation layer. That staging table is itself an in-memory table, and
it is named `_overlay_<user table>_<counter>` — an internal detail users never see anywhere else.

When `alter table … alter column <pk column> set collate …` is refused because rows the
transaction removed would still collide under the new sort rule, the refusal can come from the
staging table's own re-key check rather than from the store. Its message is built from that
table's own name, so the user sees:

```
Cannot re-key the primary key of table _overlay_t_rk2_3: rows this transaction has removed
still collide under the new key definition and must survive a rollback. Commit/rollback and retry.
```

Observed with:

```sql
create table t (k text collate binary primary key, v text) using store;
begin;
insert into t values ('A', 'x'), ('a', 'y');
delete from t where k in ('A', 'a');
alter table t alter column k set collate nocase;   -- error names `_overlay_t_3`
```

The refusal itself is correct and the transaction stays usable — only the name is wrong. The same
statement against a plain in-memory table names the table correctly, so this is specific to the
wrapped path.

Note that the message text is otherwise good and is matched on by
`packages/quereus/test/logic/41.7.5-alter-column-collate-pk-staged-delete-memory.sqllogic`; any fix
should keep the substring "still collide under the new key definition" intact.
