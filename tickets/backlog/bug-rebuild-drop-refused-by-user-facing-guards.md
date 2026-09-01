description: Changing a table's primary key on a storage backend that cannot do it itself fails outright — with an error about dropping a table the user never asked to drop — whenever any integrity rule elsewhere in the database mentions that table.
files:
  - packages/quereus/src/runtime/emit/alter-table.ts        # rebuildViaShadowTable — the internal DROP and its NOTE (~2260); the FK-guard suppression scope
  - packages/quereus/src/runtime/emit/drop-table.ts         # emitDropTable — runs assertNoAssertionDependsOn + assertNoExpressionDependsOn before every DROP TABLE
  - packages/quereus/src/runtime/emit/assertion-drop-guard.ts
  - packages/quereus/src/runtime/emit/expression-drop-guard.ts
  - packages/quereus/src/schema/manager.ts                  # assertNoReferencingChildrenForDrop — the one guard that already honors a suppressed scope (~1469)
  - packages/quereus/src/core/database.ts                   # _setFkRestrictSuppressed — the ad-hoc flag the FK guard reads (~2610)
  - packages/quereus/test/alter-table-conformance.spec.ts   # 'ALTER PRIMARY KEY — shadow rebuild preserves the table definition' — where the coverage belongs
  - packages/quereus/test/no-alter-module.ts                # the stub backend that forces the rebuild path
repro: verified
severity: edge-case
likelihood: unusual
tradeoffs: Only third-party backends that cannot re-key in place reach this path (both built-in backends re-key directly and never do), the statement fails cleanly with no data at risk, and the workaround — drop the rule, re-key, re-declare it — always works; a maintainer may reasonably wait for a real backend to hit it.

# What goes wrong

When a storage backend cannot change a table's primary key itself, the engine does it the long
way: it builds a hidden copy of the table with the new key, copies the rows across, **drops the
original**, and renames the copy over it. That drop is engine scaffolding — the table is back
under its own name a moment later — but it runs as an ordinary `DROP TABLE`, so every guard that
protects a user-issued drop fires on it.

Three such guards exist. One (the foreign-key one, which refuses to drop a table other rows still
point at) was taught to stand down for this scaffolding drop. The other two were not:

- **an assertion that mentions the table** — a database-wide rule such as
  `create assertion a check (not exists (select 1 from t where code < 0))`;
- **another table's CHECK / DEFAULT / generated-column expression whose subquery mentions the
  table** — the exact shape the expression guard's own documentation uses as its motivating
  example.

With either present, `alter table t alter primary key (…)` on a rebuild-path backend fails with

```
cannot drop table 'main.t': assertion 'a' still refers to it — drop or redefine the assertion first
```

The user asked to re-key a table and is told they cannot drop it. Nothing was dropped: the hidden
copy is cleaned up and the table keeps its old key and all its rows, so this costs a confusing
refusal and a capability that quietly does not work, not data.

Verified 2026-09-01 against a stub backend with no `alterTable` (`test/no-alter-module.ts`); both
shapes reproduce, both leave the table intact.

# Why the current shape invites it

Each of the three guards decides on its own whether a drop is allowed, and the one exemption that
exists is an ad-hoc boolean on `Database` (`_setFkRestrictSuppressed`) that only the foreign-key
guard reads. Nothing tells the other two that a drop is internal, so the next guard added to
`DROP TABLE` will have the same hole and no one will notice until a rebuild fails.

# Expected behavior

Re-keying a table must not be blocked by rules that will still hold once the rebuild finishes —
which is all of them, since the table comes back with the same name, the same rows, and the same
declared shape. The rebuild's internal drop should be recognizable **as internal** by every guard
on the drop path, through one shared scope rather than one flag per guard, so a guard added later
is covered by construction. The engine's own scaffolding drop and a user's `DROP TABLE` are
different operations and should not be indistinguishable at the guard.

A related wart resolves at the same seam and is worth fixing with it: when the row copy itself
fails (rows that collide under the new key), the error names the machine-generated hidden table —
`UNIQUE constraint failed: t__rekey_1788250255831 PK` — an object the user has never heard of and
cannot look up. Every error surfacing from inside the rebuild should be sited on the statement the
user issued and the table they named.

# Coverage to add

Rebuild-path arms, alongside the existing preservation arms, for: a table covered by an assertion;
a table named by another table's CHECK subquery; a table named by its own CHECK subquery (the
self-reference case the code NOTE describes). Each must complete the re-key with the rule still in
force afterwards — the assertion still rejecting a violating write, the CHECK still rejecting one.
Plus one arm pinning that a collision during the copy reports the user's table name, not the
hidden one.
