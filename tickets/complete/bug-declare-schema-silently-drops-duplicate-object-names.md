description: A declared schema that names the same table (or view, check rule, or seed block) twice used to quietly ignore all but the last one; it now rejects the repeat up front with a message naming the object.
prereq:
files:
  - packages/quereus/src/schema/schema-differ.ts (`findDuplicateDeclaredName` / `duplicateDeclaredNameError`; raise points on the logical and physical paths)
  - packages/quereus/src/runtime/emit/schema-declarative.ts (`findDuplicateSeedTable`; raise at the top of `emitDeclareSchema`)
  - packages/quereus/test/schema-differ.spec.ts (`duplicate declared object names (SCH-003)`)
  - packages/quereus/test/schema-manager.spec.ts (`View operations via SQL`)
  - packages/quereus/test/logic/50.3-declare-schema-duplicate-names.sqllogic
  - docs/sql-ddl.md § 2.0, § 6.3
  - docs/schema.md § Reserved tags (declarative path), § Seed Data
  - docs/invariants.md SCH-003
difficulty: medium
----

## What shipped

A `declare schema` block collects its declarations into one map per object kind,
keyed by lowercased name, so a second declaration of a name overwrote the first —
no error, no warning, the first declaration never reached the migration. `index`
was already guarded; `table`, `view`, `materialized view`, `assertion`, and
`seed` were not.

Three namespaces, matching what the engine already enforces imperatively:

- `table` / `view` / `materialized view` — **one shared namespace**. `Schema.addView`
  rejects a view whose name a table holds and `SchemaManager.createTable` rejects the
  mirror case, so a cross-kind declaration could never apply: the differ used to emit
  both CREATEs, run the table create, then fail deep in the migration loop and leave
  the table behind.
- `index` — its own namespace (SCH-001). Same-name duplicates were already rejected
  and the message is unchanged. An index sharing a *table's* name stays legal.
- `assertion` — its own namespace, same rule.
- `seed` — one block per target table.

`findDuplicateDeclaredName(items)` is a pure walk returning the first collision in
declaration order; `duplicateDeclaredNameError(dup, schemaName)` renders it. Being
pure, it is called from the physical path (immediately after the reserved-tag
diagnostics, so a tag typo still surfaces first) and from the top of the logical
branch (which returns before any tag validation and dedupes declared table names
into a `Set`). The now-unreachable table↔materialized-view throw in the MV
normalization loop was removed. The seed guard is a separate walk in
`schema-declarative.ts` — the differ ignores `seed` items entirely — raised before
`clearSeedData` / `setDeclaredSchema` so a rejected declaration stores nothing.

Diagnostics (all `StatusCode.ERROR`):

```
Table 't1' is declared more than once in schema 'main'
View 'v' is declared more than once in schema 'main'
Materialized view 'mv' is declared more than once in schema 'main'
Assertion 'ck' is declared more than once in schema 'main'
Index 'idx_note' is declared more than once in schema 'main' (on 't1' and 't2') — index names are unique per schema
'dual' is declared as both a table and a view in schema 'main'
Seed data for table 't1' is declared more than once in schema 'main'
```

## Review findings

### What was checked

- The implement diff was read first (source, tests, docs) before the handoff summary.
- **Namespace claims verified against the engine, not taken on faith.**
  `schema.ts:61` / `schema.ts:108` confirm table and view share one namespace;
  `runtime/emit/materialized-view.ts:80` confirms MV joins it; `Schema.addAssertion`
  (`schema.ts:158`) is a bare keyed `Map.set` with no cross-kind check, so
  `assertion` genuinely is its own namespace and the "an assertion may share a
  table's name" test is asserting real behaviour, not a differ-only permissiveness
  that would half-apply later.
- **Every consumer of a stored declaration audited** for an unguarded path:
  `diff schema`, `apply schema`, `explain schema`, `lens-compiler.ts:307`,
  `func/builtins/explain.ts:881`. Only diff/apply reach `computeSchemaDiff`; the
  other three only hash the AST, so no path can *act* on a duplicate-bearing
  declaration without passing the guard. `apply schema` computes the diff before
  generating or running any DDL, so the rejection is genuinely pre-migration.
- **The seed guard's premise verified:** `setSeedData`
  (`declared-schema-manager.ts:67-75`) is an overwrite by lowercased table name, and
  the guard sits above both `clearSeedData` and `setDeclaredSchema`.
- Ordering: a reserved-tag typo still raises ahead of a duplicate (covered by test).
- `yarn build`, `yarn lint`, `yarn typecheck`, `yarn test`, `yarn docs:check` — all
  green. `packages/quereus` 8008 passing, 13 pending, 0 failing; no failures anywhere
  in the fan-out. No pre-existing failures surfaced, so no
  `tickets/.pre-existing-error.md` was written. `yarn test:store` not run — nothing
  here touches the store path.

### Minor findings — fixed in this pass

- **Docs gap in `docs/schema.md`.** It is the reference for both the differ's
  declarative validation order (§ Reserved tags) and seed application (§ Seed Data),
  and neither reflected the new rules — `sql-ddl.md` and `invariants.md` alone left
  the engine-internals doc stale. Added a clause on the SCH-003 raise point relative
  to the tag diagnostics, and a one-block-per-table line under § Seed Data.
  `docs/schema.md` sits *exactly* at its size ratchet, so the words were paid for by
  tightening genuine redundancy in the same section (the PK-conflict rationale was
  stated twice, once in step 1 and again in the closing paragraph). Ratchet not
  raised.
- **The index diagnostic's owning-table pair was untested.** The refactor re-derives
  `(on 't1' and 't2')` from the new `DeclaredNameEntry.table` fields, but the
  existing assertion stopped at `in schema 'main'` — a swapped pair would have
  passed. The handoff called the wording "pinned"; it was pinned only in part.
  Widened to the full message.
- **Weak assertion in the rewritten mirror-case test.** It matched `/view/i`, which
  almost anything satisfies. Tightening it surfaced that the real message is
  `View main.dual_name_2 already exists`, *not* the `a VIEW with the same name
  already exists` text the handoff implied — that wordier message fires only under
  `IF NOT EXISTS` (`manager.ts:2653-2659`). Test now pins the actual string with a
  comment recording why. Behaviour is correct either way (the collision is rejected
  and the message names the colliding kind); only the handoff's characterisation was
  off.
- **Missing regression coverage for the seed guard's stated rationale.** The whole
  reason the guard is placed above `clearSeedData` is that a rejected declaration
  must not clobber a prior good one — nothing tested that. Added to
  `50.3-declare-schema-duplicate-names.sqllogic`: a good declaration is applied with
  seed, a second declaration for the same schema is rejected for a duplicate `seed`
  block, then `diff schema` still converges (`→ []`) and the table re-seeds from the
  *stored* rows after a `delete from`. Also added the case-insensitive seed case
  (`seed T` + `seed t`), which the object-name path covered but the seed path did not.
- **Small clean:** `targetSchemaName` was bound after the `isLogical` branch, so the
  logical raise point used `actualCatalog.schemaName` and the physical one used the
  alias for the same value. Hoisted the binding above the branch; both now read the
  same name.

### Tripwire (recorded, not ticketed)

- `declareIgnored` items (`domain` / `collation` / `import`) get no namespace check —
  the parser keeps them as an opaque snippet with no parsed name, so there is nothing
  to key on. Only becomes work *if* one of those becomes first-class, at which point
  it needs its own namespace decision. Parked as a `NOTE:` comment at the
  `findDuplicateDeclaredName` switch, where whoever adds that case will read it.

### Considered and deliberately not filed

- **Object duplicates raise at diff time, seed duplicates at declare time**, so a
  duplicate-bearing declaration *does* replace a previously good stored declaration —
  the exact clobber the seed guard was placed early to avoid. Left as designed: it is
  consistent with every other diff-time validation (a reserved-tag typo clobbers
  identically), and moving the check to declare time would invert the documented
  tag-typo-first ordering that the prior index ticket established. Seed is the
  outlier only because the differ never sees `seed` items.
- **`apply schema <new-schema>` creates the empty target schema before computing the
  diff**, so a rejected declaration can leave an empty schema behind. Pre-existing for
  every diff-time error, cosmetic, and untouched by this diff.
- `emitDeclareSchema` and `setSeedData` both log "Stored seed data" for each block —
  a duplicated log line, pre-existing, harmless.
- The handoff's own known gaps were re-examined and stand as accurate, non-defects:
  only the first collision is reported (matches the surrounding structural conflicts);
  the sqllogic file covers the physical path while the logical and mv+view cases are
  unit-covered; a `seed` block naming a table the schema never declares is still
  unvalidated (pre-existing hole in the same area, out of scope).

### Major findings

None. No new tickets filed. The guard is correctly placed on every path that can act
on a declaration, the namespace split matches what the engine enforces imperatively,
and no case of over-tightening was found (index-sharing-a-table-name and
assertion-sharing-a-table-name both remain legal and are tested).
