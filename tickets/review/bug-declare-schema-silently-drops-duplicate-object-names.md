description: A declared schema that names the same table (or view, check rule, or seed block) twice used to quietly ignore all but the last one; it now rejects the repeat up front with a message naming the object. Needs a review pass.
prereq:
files:
  - packages/quereus/src/schema/schema-differ.ts (new `findDuplicateDeclaredName` / `duplicateDeclaredNameError` ~214-320; logical-path raise ~330-337; physical raise point ~467-474; MV normalization loop ~476-487)
  - packages/quereus/src/runtime/emit/schema-declarative.ts (new `findDuplicateSeedTable` ~68-89; raise in `emitDeclareSchema` ~98-107)
  - packages/quereus/test/schema-differ.spec.ts (`describe('duplicate declared object names (SCH-003)')`)
  - packages/quereus/test/schema-manager.spec.ts (`View operations via SQL` — two rewritten cases)
  - packages/quereus/test/logic/50.3-declare-schema-duplicate-names.sqllogic (new)
  - docs/sql-ddl.md (§ 2.0 Declaration Syntax — new "Each declared name appears once" bullet block; § 6.3 index bullet now points at it)
  - docs/invariants.md (new SCH-003)
difficulty: medium
----

## What changed

A `declare schema` block collects its declarations into one map per object kind,
keyed by lowercased name. A second declaration of the same name overwrote the
first — no error, no warning, the first declaration never reached the migration.
`index` was already guarded; `table`, `view`, `materialized view`, `assertion`,
and (outside the differ) `seed` were not.

**Namespaces.** Three, matching what the engine already enforces imperatively:

- `table` / `view` / `materialized view` — **one shared namespace**. `Schema.addView`
  rejects a view whose name a table holds and `SchemaManager.createTable` rejects
  the mirror case, so a cross-kind declaration could never apply: the differ used
  to emit both CREATEs, run the table create, then fail deep in the migration loop
  with a low-level message and leave the table behind. Now rejected up front.
- `index` — its own namespace. Same-name duplicates were already rejected; the
  message is byte-identical to before. An index sharing a *table's* name is still
  legal and was deliberately left legal.
- `assertion` — its own namespace, same rule.
- `seed` — one block per target table; a second block for the same table is
  rejected.

**Implementation.** The old `let duplicateDeclaredIndex` capture inside the
collection `switch` is gone. In its place, `findDuplicateDeclaredName(items)` is a
pure walk over the declared items returning the first collision in declaration
order (or undefined), and `duplicateDeclaredNameError(dup, schemaName)` renders it.
Being pure, it is called from two places:

- the physical path, immediately after `raiseReservedTagDiagnostics` — so a
  reserved-tag typo still surfaces first (the deterministic order the prior index
  ticket established);
- the logical path, at the top of the `isLogical` branch — that branch returns
  before any tag validation and `computeLogicalSchemaDiff` dedupes declared table
  names into a `Set`, so a duplicate silently collapsed into one lens attach.

The redundant table↔materialized-view throw in the MV normalization loop is now
unreachable and was removed, replaced by a pointer comment at the
`declaredTables.set`.

The seed guard is a separate walk (`findDuplicateSeedTable`) in
`schema-declarative.ts`, because the differ ignores `seed` items entirely. It
raises at the very top of `emitDeclareSchema`'s `run`, **before** `clearSeedData`
and `setDeclaredSchema`, so a rejected declaration stores nothing and does not
clobber a prior good declaration.

## Diagnostics (all `StatusCode.ERROR`)

```
Table 't1' is declared more than once in schema 'main'
View 'v' is declared more than once in schema 'main'
Materialized view 'mv' is declared more than once in schema 'main'
Assertion 'ck' is declared more than once in schema 'main'
Index 'idx_note' is declared more than once in schema 'main' (on 't1' and 't2') — index names are unique per schema
'dual' is declared as both a table and a view in schema 'main'
Seed data for table 't1' is declared more than once in schema 'main'
```

The index wording is unchanged (pinned by `schema-differ.spec.ts` and documented
in `docs/sql-ddl.md` § 6.3). The cross-kind wording adds ` in schema '<name>'` to
the old table↔materialized-view text; nothing pinned the old string. Cross-kind
names the two kinds **in declaration order** (`table and a view` vs
`view and a table`).

## Use cases to exercise when reviewing

Verifying the fix:

- `declare schema` naming the same table twice, then `diff schema` — errors,
  naming the table. `apply schema` errors the same way, with no DDL run.
- Same for two `view`, two `materialized view`, two `assertion`.
- `table dual` + `view dual` in one block — errors instead of half-applying and
  leaving `dual` behind in the catalog.
- Case divergence: `table T1` + `table t1` collide.
- Two `seed t` blocks — errors at `declare schema` itself, and the declaration is
  not stored (`diff schema` then reports "No declared schema found").

Verifying nothing was over-tightened:

- `index t1 on t1 (note)` alongside `table t1` — still accepted.
- `assertion t1 check (…)` alongside `table t1` — still accepted.
- A schema with a bogus `quereus.*` tag *and* a duplicate name raises the **tag**
  diagnostic, not the duplicate one.
- Existing 50.x declarative sqllogic files and `declarative-equivalence.spec.ts`
  still pass — no existing corpus contained a duplicate.

## Test-authoring trap you will hit

A `materialized view` item written directly after an item whose body ends at a
FROM source is **misparsed**: `materialized` is not a reserved word, so it is
taken as a table alias and the following `view <name> as …` parses as a *plain*
view. Filed separately as
`tickets/fix/bug-declare-schema-materialized-swallowed-as-table-alias.md` — not
fixed here. Every MV test in this work sidesteps it with a FROM-less first body
(`as select 1 as one`) and **asserts the parsed item types**, so a parser
regression cannot quietly turn an MV test into a view test.

The same trap bites `seed` (and presumably any non-reserved leading keyword): a
`view v as select id as x from t1` followed by `seed t1 (…)` inside one block
fails to parse until the view is terminated with `;`.

## Validation run

- `yarn build` — green.
- `yarn lint` — green (eslint + `tsc -p tsconfig.test.json --noEmit`).
- `yarn typecheck` — green.
- `yarn test` (all workspaces) — green; `packages/quereus` 8008 passing, no
  failures anywhere in the fan-out.
- `yarn docs:check` — green (links, invariant format, size ratchet).

`yarn test:store` was **not** run — nothing here touches the store path, and it is
the slow suite.

## Known gaps / where to push

- **Only the first collision is reported.** Deliberate (matches the surrounding
  structural conflicts and the prior index ticket's review decision), but it means
  a schema with three duplicates takes three edit-and-rerun cycles. If that reads
  as wrong, the helper returns a single value and would need to accumulate.
- **The sqllogic file covers the physical path only.** The logical-schema
  duplicate and the mv+view cross-kind case are covered in `schema-differ.spec.ts`
  but not end-to-end. A logical schema cannot target `main`, and the sqllogic
  positive control had to drop its `view` item because a view in a **non-main**
  declared schema cannot resolve unqualified table references at apply time (that
  is `tickets/fix/bug-declared-materialized-view-non-main-schema.md` territory,
  pre-existing, untouched).
- **`DeclareIgnoredItem` (`domain` / `collation` / `import`) names are not
  checked.** The parser keeps them as an opaque text snippet with no parsed name,
  so there is nothing to key on. If those items ever become first-class, they need
  their own namespace decision.
- **A `seed` block naming a table the schema never declares is still unvalidated.**
  Pre-existing; out of scope here, but it is the obvious next hole in the same area.
- **`packages/quereus/test/schema-manager.spec.ts`** had a test named "views should
  shadow tables of the same name in getSchemaItem" that created two *different*
  names and therefore tested nothing. Rather than delete it, it was rewritten into
  two cases asserting the real law (a view cannot take a table's name, and the
  mirror) — the imperative half of SCH-003. Check that the rewrite is what you
  want rather than a plain rename.
- **Apply-time rollback is untouched.** A migration DDL failure part-way through
  still leaves earlier statements applied. The guard makes that moot for *this*
  input class, but it is a real open question and was deliberately not chased.

## Review findings

<!-- reviewer fills this in -->
