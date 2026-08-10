---
description: A table can be created with a computed-column formula that names something the formula never introduces, and then every insert or update to that table fails forever. Adding the same column to an existing table is correctly refused up front, so the two ways of declaring it disagree.
files:
  - packages/quereus/src/schema/generated-column-refs.ts   # classifyQualified — the one decision point
  - packages/quereus/src/schema/table.ts                   # extractGeneratedColumnDependencies (~1497), validateAddColumnGeneratedRefs (~1553) — the two consumers
  - packages/quereus/test/logic/41-generated-column-errors.sqllogic  # § 4 pins the old create-then-fail behavior
  - docs/sql-ddl.md                                        # ~line 372 documents the divergence as current behavior
difficulty: easy
repro: verified
---

# A generated expression may name a qualifier nothing binds, and only `ALTER` says so

## What goes wrong

A `generated always as (...)` body may write a column reference with a qualifier —
`d.v`, `old.a`, `z.v`. The declaration-time analysis asks one question: does anything
inside the expression bind that qualifier? If an inner `FROM` binds it, the reference
belongs to that source and is fine. If **nothing** binds it, the analysis still labels
the reference "someone else's problem" and lets the declaration through. At write time
there is nothing for it to resolve against, so it fails — every time, for the life of
the table.

`CREATE TABLE` therefore produces a table the engine created without complaint that no
`INSERT`, `UPDATE`, or upsert can ever touch. `ALTER TABLE ... ADD COLUMN` rejects the
identical declaration at declaration time and leaves the table alone — not because it
runs a stricter reference analysis (it runs the same one), but because it goes on to
*compile* the body against the row scope, and that compile fails. So the two authoring
surfaces disagree about whether the same column definition is legal.

## Reproduction (verified — run against the engine, output quoted)

```sql
create table d (k integer primary key, v integer);

create table g (id integer primary key, a integer,
                x integer generated always as (d.v + 1) stored);
-- accepted, no complaint

insert into g (id, a) values (1, 3);
-- ERR: d.v isn't a column
```

Three spellings behave the same way — accepted by `CREATE TABLE`, fatal at every write:

| body | why nothing binds it |
| --- | --- |
| `(d.v + 1)` | `d` is a real table, but the body has no `FROM` selecting from it |
| `(old.a + 1)` | a generated value is computed from the row being *written*; there is no old row |
| `((select z.v from d where d.k = a limit 1))` | the subquery binds `d`, never `z` |

And the same three, spelled as `alter table h add column x integer generated always as (...)`,
are each rejected at declaration time with `d.v isn't a column` / `old.a isn't a column`,
leaving the table untouched.

A body that *does* bind its qualifier keeps working and must continue to:

```sql
create table ok (id integer primary key, a integer,
                 x integer generated always as ((select d.v from d where d.k = a limit 1)) stored);
insert into ok (id, a) values (1, 1);   -- fine
```

## Root cause

One decision point: `classifyQualified` in `schema/generated-column-refs.ts`. It labels
each reference in a generated body `'own'` (binds the owning table's row), `'foreign'`
(binds something else), or `'unknown'` (an opaque subquery / function / CTE source
intervenes, so the walk cannot decide). Both consumers in `schema/table.ts` skip
`'foreign'` outright — no existence check, no error.

`'foreign'` is doing two jobs it cannot distinguish between:

- *an inner `FROM` exposes this name* — resolvable, fine;
- *nothing at all binds this qualifier* — resolvable by nothing, fatal.

While those share one label, no consumer can reject the second without also rejecting
the first. The fix is to make the fatal case its own label, so the type forces both
consumers to decide about it.

## The fix (prototyped and validated, then reverted — tree is clean)

Add a fourth `RefBinding` variant, `'unbound'`, returned only for a *qualified*
reference whose qualifier no frame binds and which is not one of the accepted own-row
spellings. Unqualified names can never be `'unbound'` — they fall through to the seed
frame and reach `'own'`.

Conservatism is preserved by tracking opacity while walking the frame stack: if an
opaque frame (subquery / function / CTE source, or a DML body) was crossed before
running out of frames, the answer stays `'unknown'` rather than becoming `'unbound'`.
That matters because DML bodies reachable through a subquery bind their target table's
name in ways this walk does not model, and today those references land in `'foreign'`
and are ignored. Without the opacity guard they would become new false rejections.

`old.` stops being special-cased to `'foreign'` and simply falls through to `'unbound'`,
which is what it always meant.

### Exact patch that was validated

```diff
--- a/packages/quereus/src/schema/generated-column-refs.ts
+++ b/packages/quereus/src/schema/generated-column-refs.ts
@@ export type RefBinding =
 	| 'foreign'
+	/** Qualified, and NOTHING binds the qualifier. */
+	| 'unbound'
 	| 'unknown';

@@ export interface GeneratedColumnRef {
 	readonly originalName: string;
+	/** Qualifier as written (original casing), when the reference carried one. */
+	readonly originalQualifier?: string;

@@ function classifyQualified(state: CollectState, col: AST.ColumnExpr): RefBinding {
 	const qualifier = col.table!.toLowerCase();
+	let opaque = false;
 	for (let i = state.stack.length - 1; i >= 1; i--) {
 		if (state.stack[i].bound.has(qualifier)) return 'foreign';
+		if (state.stack[i].hasOpaque) opaque = true;
 	}
 	if (col.schema === undefined) {
 		if (qualifier === 'new') return 'own';
-		if (qualifier === 'old') return 'foreign';
-		return qualifier === state.tableName ? 'own' : 'foreign';
+		if (qualifier === state.tableName) return 'own';
+	} else if (qualifier === state.tableName && eq(col.schema, state.schemaName)) {
+		return 'own';
 	}
-	return qualifier === state.tableName && eq(col.schema, state.schemaName) ? 'own' : 'foreign';
+	return opaque ? 'unknown' : 'unbound';
 }

@@ function recordColumnRef(col: AST.ColumnExpr, state: CollectState): void {
-	state.refs.push({ name: nameLower, originalName: col.name, shape: 'column', binding });
+	state.refs.push({
+		name: nameLower,
+		originalName: col.name,
+		originalQualifier: col.schema !== undefined ? `${col.schema}.${col.table}` : col.table,
+		shape: 'column',
+		binding,
+	});
 }
```

Both consumers in `schema/table.ts` then reject `'unbound'` through one shared error
helper, so the two authoring surfaces cannot report it differently:

```ts
function unboundQualifierError(
	ref: GeneratedColumnRef,
	generatedColumnName: string,
	tableName: string,
): QuereusError {
	return new QuereusError(
		`'${ref.originalQualifier}.${ref.originalName}' referenced by generated column '${generatedColumnName}' in table '${tableName}' binds nothing: a generated expression computes from the row being written, so it may only name this table's own columns (bare, '${tableName}.', or 'new.') or columns of a source it selects from`,
		StatusCode.ERROR,
	);
}
```

added as the first line of each `for (const ref of collectGeneratedColumnRefs(...))`
loop, ahead of the existing `if (ref.binding === 'foreign') continue;`:

- `extractGeneratedColumnDependencies` (~line 1497) — the `CREATE TABLE` path, also
  re-run by the emitter after `ALTER`;
- `validateAddColumnGeneratedRefs` (~line 1553) — the `ALTER ... ADD COLUMN` pre-flight.

Put the throw **before** the `'foreign'` skip and after nothing else; the existing
self-cycle check in `validateAddColumnGeneratedRefs` stays where it is (a cycle
diagnosis must still win over a qualifier diagnosis when both apply to the same name).

The message wording above is a proposal, not a requirement. The requirement is that
**both surfaces raise the identical message** for the identical declaration, which the
shared helper guarantees.

### What this buys

With the patch applied, all three fatal spellings are rejected at `CREATE TABLE` and at
`ALTER TABLE ADD COLUMN`, with the same message, and `ok` above still works. Verified by
running the reproduction above against the patched engine.

## Measured blast radius

`yarn test` on the patched tree: **2979 passing, 1 failing** — the single failure is
`41-generated-column-errors.sqllogic` § 4, which pins the old
`old.a isn't a column`-at-INSERT behavior and is exactly what this ticket changes.
Nothing else in the suite depends on an unbound qualifier being tolerated.

## Test coverage to write

`41-generated-column-errors.sqllogic` § 4 currently creates `t_old` with
`generated always as (old.a + 1)`, then pins the failure at each of the four write
sites (INSERT, upsert recompute, UPDATE, ADD COLUMN backfill). Once `CREATE TABLE`
rejects the declaration those write sites are unreachable, so the section has to be
rebuilt rather than tweaked. It should end up pinning, for both `old.<col>` and
`<other table>.<col>` with no binding `FROM`:

- `create table ... generated always as (...)` is rejected, and the table is not created
  (a following `select` or `drop` proves it);
- `alter table ... add column ... generated always as (...)` is rejected with the **same**
  message, and the existing rows are untouched (the existing `select id, a from
  t_old_alter order by id` check already does this — keep it);
- the in-subquery variant (`(select z.v from d where d.k = a limit 1)`) is rejected too;
- a body that legitimately selects from another table
  (`(select d.v from d where d.k = a limit 1)`) still creates, inserts and reads back —
  this is the regression guard for the `'foreign'` half and must not be dropped.

The sqllogic error assertions are substring matches, so pin a distinctive fragment
(e.g. `binds nothing`) plus the offending reference, not the whole sentence.

## Docs to update

`docs/sql-ddl.md`, the *Generated Columns* bullet list (~line 372) — the paragraph
beginning **"When the rejection happens differs by statement"** documents the divergence
as intended current behavior. It becomes: an unbindable qualified reference is rejected
at declaration time by `CREATE TABLE` and `ALTER TABLE ... ADD COLUMN` alike, and the
table is left uncreated / unchanged. The spelling table just above it (`old.<column>` →
**no**, `any other qualifier` → no) stays accurate as written; only the "when" paragraph
is wrong after this change.

## Notes for the implementer

- A qualifier that happens to name a mutation-context variable (`context.foo`) inside a
  generated body will now be rejected. That is correct and intended:
  `buildGeneratedColumnExpr` deliberately does not register context variables for
  generated bodies (see its header comment and `docs/sql-ddl.md` §2.6.2), so such a
  reference resolves to nothing at every write site today. No test in the suite exercises
  it.
- `tickets/plan/3-debt-schema-expression-scope-walker-duplicated.md` plans to merge this
  file's traversal with `schema/rename/self-qualifier-strip.ts`. That is a structural
  refactor; this is a semantic change to the classifier only. Landing this first is
  intended — the refactor must carry the `'unbound'` variant forward.
- A separate implement ticket
  (`bug-nondeterministic-generated-column-accepted-at-create-table`) covers the other
  half of the same `CREATE`-vs-`ALTER` disagreement: a non-deterministic generated body.
  It is sequenced after this one because it edits the same sqllogic file.
- Whether a `CHECK` body carrying an unbound qualifier behaves the same way was **not**
  tested and is out of scope. `CHECK` has no equivalent declaration-time reference
  analysis to extend.

## TODO

- Add the `'unbound'` variant and `originalQualifier` to `schema/generated-column-refs.ts`;
  rewrite `classifyQualified` per the patch above, including the opacity guard.
- Update the `classifyQualified` doc comment: it currently explains why `old` returns
  `'foreign'`, which stops being true.
- Update the `RefBinding` / consumer contract comment block at the top of
  `generated-column-refs.ts` and the consumer doc comment on
  `extractGeneratedColumnDependencies` (~line 1464), which enumerates what each binding
  means to the consumers and currently says `'foreign'` is "ignored entirely".
- Add `unboundQualifierError` to `schema/table.ts` and throw it from both consumers.
- Rebuild `41-generated-column-errors.sqllogic` § 4 per *Test coverage to write*.
- Update the "When the rejection happens differs by statement" paragraph in
  `docs/sql-ddl.md`.
- `yarn test` green; `yarn lint` and `yarn typecheck` clean.
