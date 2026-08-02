----
description: Editing the rule inside a declared integrity check and re-applying the schema silently does nothing — the comparison only looks at the check's name, so the old rule stays in force while the declaration claims the new one.
files:
  - packages/quereus/src/schema/schema-differ.ts    # computeSchemaDiff assertion block (~842-855) — presence-only comparison
  - packages/quereus/src/schema/catalog.ts          # assertionSchemaToCatalog — the actual side's rendered DDL, a candidate comparison basis
  - packages/quereus/test/logic/50-declarative-schema.sqllogic  # declarative assertion sections to extend
repro: verified
----

# A declared assertion's body change is invisible to `diff schema`

## What was reproduced

```sql
declare schema main { table t (x integer, primary key (x));
                      assertion a1 check (not exists (select 1 from t where x < 0)) }
apply schema main;
declare schema main { table t (x integer, primary key (x));
                      assertion a1 check (not exists (select 1 from t where x < 100)) }
diff schema main;
→ []
```

The second declaration changes the assertion's rule (`< 0` → `< 100`). The diff
is empty, `apply schema` does nothing, and the database keeps enforcing the old
rule — while the declared-schema hash *does* change (assertions participate in
the hash as of `bug-declared-assertion-ignores-target-schema`), so the version
says "changed" and the diff says "converged". Ran it; saw the empty diff.

## Root cause

`computeSchemaDiff`'s assertion block compares declared vs actual **by name
presence only**: create when the name is missing from the catalog, drop when the
name is missing from the declaration. There is no definition comparison, unlike
tables, views, and indexes, which all compare canonical definitions and emit
drop+recreate on a body change.

## Expected behavior

- A declared assertion whose CHECK body differs from the live assertion of the
  same name produces a drop + recreate pair in the diff (assertions have no
  alter primitive and no rename support — recreate is the correct unit).
- An unchanged assertion continues to produce no diff entries, byte-for-byte
  formatting differences notwithstanding — compare on a canonical rendering,
  not raw source text.
- The actual side's `CatalogAssertion.ddl` is already a faithful re-parseable
  `CREATE ASSERTION … CHECK (…)` rendered from the stored CHECK expression, and
  the declared side renders through the same `createAssertionToString` — those
  two canonical strings (name-qualification normalized) are the natural
  comparison basis.
