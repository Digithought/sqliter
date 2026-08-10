---
description: A table could be created with a computed-column formula that names something the formula never introduces, and every insert or update to that table then failed forever. CREATE TABLE now refuses the same declaration ALTER TABLE ADD COLUMN already refused, with the same message.
files:
  - packages/quereus/src/schema/generated-column-refs.ts   # classifyQualified — new 'unbound' RefBinding + originalQualifier
  - packages/quereus/src/schema/table.ts                   # unboundQualifierError (new, ~1464), both consumers (~1517, ~1574)
  - packages/quereus/test/logic/41-generated-column-errors.sqllogic  # § 4 rebuilt (6 sub-cases, was 1)
  - packages/quereus/test/logic/41-generated-column-scope.sqllogic   # § 8 third case updated — see "Found during implementation" below
  - docs/sql-ddl.md   # Generated Columns bullet list, ~line 372
difficulty: easy
---

# Review: an unbound-qualifier generated column is now rejected at declaration time

## What changed

`classifyQualified` in `generated-column-refs.ts` used to fold two different situations
into one label, `'foreign'`: "an inner `FROM` in the body exposes this qualifier" (fine)
and "nothing anywhere binds this qualifier" (dead on arrival — nothing at write time can
resolve it either). Both consumers in `table.ts` skipped `'foreign'` unconditionally, so
the second case sailed through `CREATE TABLE` and `ALTER TABLE ADD COLUMN`'s pre-flight
alike, then failed at every subsequent `INSERT`/`UPDATE`.

The fix, exactly as prototyped and specified in the source ticket:

- a new `RefBinding` value, `'unbound'`, returned only when a qualified reference's
  qualifier is bound by no frame on the walk **and** no opaque frame (subquery / function
  / CTE source, or a DML body) was crossed on the way out — if one was, the walk can't
  tell and still returns `'unknown'` (conservative, unchanged behavior for that case);
- `old.<col>` stops being special-cased to `'foreign'` — it now falls through the same
  path as any other qualifier that binds nothing, which is what it always meant;
- a new `originalQualifier` field on `GeneratedColumnRef` (e.g. `d` or `s.d`, as written)
  so the rejection message can name the actual offending reference;
- a shared `unboundQualifierError` helper in `table.ts`, thrown as the first check in
  both `extractGeneratedColumnDependencies` (the `CREATE TABLE` path, also re-run by the
  `ALTER` emitter) and `validateAddColumnGeneratedRefs` (the `ADD COLUMN` pre-flight) —
  so the two authoring surfaces raise the byte-identical message for the identical
  declaration, by construction rather than by two hand-synced strings.

## Verified behaviour

```sql
create table d (k integer primary key, v integer);
create table g (id integer primary key, a integer,
                x integer generated always as (d.v + 1) stored);
-- now: rejected at CREATE TABLE (previously: accepted, then every INSERT failed)
```

All three previously-tolerated spellings (`d.v`, `old.a`, and a subquery naming an
unbound qualifier like `(select z.v from d where d.k = a limit 1)`) are now rejected at
both `CREATE TABLE` and `ALTER TABLE ADD COLUMN`, with the same `... binds nothing: ...`
message. A body that legitimately selects from another table
(`(select d.v from d where d.k = a limit 1)`) is unaffected — still creates, inserts, and
reads back.

## Tests

`41-generated-column-errors.sqllogic` § 4 was rebuilt per the source ticket's spec into
six sub-cases (4a–4f):

- 4a/4b: `old.a` rejected at `CREATE TABLE` (table never created — proven by a following
  `drop table` raising "not found in schema") and at `ADD COLUMN` (existing rows
  untouched — proven by re-selecting them).
- 4c/4d: same two proofs for `d.v` (a real table, but no `FROM` in the body selects
  from it).
- 4e: the in-subquery variant — the subquery's `FROM` binds `d`, never `z`.
- 4f: regression guard — a body that legitimately selects from another table still
  works end to end (create, insert, select).

All sqllogic error assertions are substring matches (`binds nothing`, `not found in
schema`), not full-sentence pins, per the source ticket's guidance.

## Found during implementation — not anticipated by the source ticket

The source ticket's "measured blast radius" section said `yarn test` on the prototyped
patch showed exactly one failure (the § 4 file above). That measurement predated
`41-generated-column-scope.sqllogic` (added by the immediately-preceding ticket,
`generated-column-one-row-scope`, committed the same day). That file's § 8 had a third
case — a generated body qualified with a **different, non-owning schema**
(`"temp".sqm.a`) that happens to share its bare table/column names with the table being
defined — asserting that `CREATE TABLE` accepts it and a later `DROP COLUMN` is then
allowed (no false self-reference). Under the fix that qualifier is `'unbound'` (schema
doesn't match, nothing else binds it), so `CREATE TABLE` now rejects it up front and the
`DROP COLUMN` half of that case is moot. Updated in place — see the diff in
`41-generated-column-scope.sqllogic` § 8. Worth a second look since it wasn't in the
original ticket's file list.

## Validation run

- `yarn build` — clean.
- `yarn test` (from `packages/quereus`) — **9233 passing, 0 failing** (includes the
  rebuilt § 4 and the updated `41-generated-column-scope.sqllogic`).
- `yarn lint` — clean.
- `yarn typecheck` — clean.
- `yarn test:store` was **not** run — this change touches only schema-time reference
  classification, which is store-independent (same code path regardless of vtab module);
  the source ticket didn't call for it either.

## Known gaps

- Whether a `CHECK` body carrying an unbound qualifier behaves the same way was not
  tested and is out of scope — `CHECK` has no equivalent declaration-time reference
  analysis to extend (noted in the source ticket too).
- `tickets/plan/3-debt-schema-expression-scope-walker-duplicated.md` (if still open)
  plans to merge this file's traversal with `schema/rename/self-qualifier-strip.ts`;
  that refactor needs to carry the `'unbound'` variant forward.
- A sibling ticket, `bug-nondeterministic-generated-column-accepted-at-create-table`,
  covers the other half of the same CREATE-vs-ALTER disagreement (a non-deterministic
  generated body) and is sequenced after this one since it edits the same sqllogic file.
