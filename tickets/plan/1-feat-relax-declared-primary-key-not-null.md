---
description: A table that declares no primary key gets one built from all its columns, and that key is allowed to contain empty (NULL) values — but the moment a user writes the very same key out by hand, the engine silently forbids empty values in it. Decide one rule for whether a key may contain an empty value, apply it to both spellings, and write it down.
files:
  - packages/quereus/src/schema/manager.ts (`buildColumnSchemas` ~1731-1746 — `notNull: (isPkColumn && !synthesized) ? true : col.notNull`)
  - packages/quereus/src/schema/table.ts (`columnDefToSchema` ~543-545 — `if (schema.primaryKey) schema.notNull = true;`; `findPKDefinition` ~1191; `isSynthesizedAllColumnsKey` ~1244)
  - packages/quereus/src/schema/ddl-generator.ts (~315 in docs/schema.md — the PRIMARY KEY clause omission for a synthesized key)
  - docs/schema.md (§ "Primary-key nullability" ~42; the DDL round-trip note ~315)
difficulty: medium
repro: static
tradeoffs: |
  Diverges from the SQL standard and from every mainstream engine, where PRIMARY KEY implies NOT
  NULL. DDL ported from Postgres or SQLite would get a weaker constraint than its author wrote,
  with no error — the most likely way this bites someone. Weighed against that: the divergence
  already exists for synthesized keys, and the alternative (making synthesized keys promote
  nullability instead) breaks the no-PK table shape that exists so a whole row can be its own
  identity.
---

# A declared primary key and a synthesized one disagree about whether a key may contain NULL

## Filed from the lamina board

Lamina (the sibling storage engine at `../lamina`) carries a persisted schema flag,
`primaryKey.synthesized`, whose only purpose is to keep a synthesized all-columns key apart from an
identical declared one. Its maintainer has decided the two should be the same thing — an undeclared
all-columns key is syntactic sugar for the declared one, not a different kind of key — and that
decision cannot be implemented while this engine gives the two different nullability. The lamina
side is parked in `tickets/backlog/debt-retire-synthesized-primary-key-flag.md` there, blocked on
this.

## What the engine does today

`docs/schema.md` § "Primary-key nullability" states the split accurately, so this is documented
behaviour, not an accident:

- A table with **no** `PRIMARY KEY` gets an all-columns key synthesized (`findPKDefinition`). That
  key **does not** promote its columns to NOT NULL — each keeps its declared nullability.
- A table with a **declared** PK, column-level or table-level, forces every key column NOT NULL
  (`manager.ts` `buildColumnSchemas` and `table.ts` `columnDefToSchema`).

So these two tables have keys of identical shape and different constraints:

```sql
pragma default_column_nullability = 'nullable';

create table a (x integer, y integer);                     -- key (x, y), both nullable
create table b (x integer, y integer, primary key (x, y)); -- key (x, y), both forced NOT NULL
```

The split is load-bearing in one more place: `generateTableDDL` deliberately **omits** the
`PRIMARY KEY` clause when emitting a synthesized key, because naming it would make a re-parse read
it as declared, force NOT NULL, and drop a nullable declaration on a persistence round-trip
(`docs/schema.md` ~315). The engine is, in effect, hiding a key from its own DDL emitter to work
around its own rule.

## Why the nullable side is the coherent one

Both storage backends already treat NULL as an ordinary, self-equal value in key position — this is
not a hypothetical:

- memory backend: `NULL == NULL` compares equal and orders NULL first;
- store key codec: `TYPE_NULL` is encoded as an ordinary type tag, sorting first.

That is what makes a nullable synthesized key work at all: two fully-identical all-NULL rows collide
as a duplicate key rather than both being admitted. The engine has therefore already picked
NULL-as-a-value for key comparison and shipped it. The declared-PK NOT NULL promotion is the only
place that contradicts it.

Note this does **not** conflict with the SQL UNIQUE NULL-distinct rule, which the engine also
implements (`planner/mutation/lens-enforcement.ts` ~1275) and which lamina implements on its side
too. Key comparison and UNIQUE enforcement answering NULL differently is the state that already
ships today; relaxing the PK rule widens where an existing rule applies rather than introducing a
new one. It is still worth stating explicitly rather than leaving a reader to discover it.

## Maintainer direction (recorded 2026-08-15)

The maintainer — who owns both this repo and lamina — has stated the decision that motivates this
ticket: **an undeclared all-columns key is syntactic sugar for the declared one**, not a different
kind of key. That is Option A below. Plan against A; do not re-litigate A vs B, and do not treat the
lamina side's preference as an outside opinion — it is the same person's call on both boards.

Backwards compatibility is **not** a constraint on this change. The only downstream consumer is
SiteCAD, which is unreleased. Where a choice below is weighed against "existing databases would have
to migrate", resolve it in favour of the correct end state.

Two things still need a human answer and are **not** settled by the above; surface them from the plan
rather than deciding them silently:

1. What an FK referencing a parent key that contains NULL means (the MATCH SIMPLE question below).
2. Whether `create table … (x integer null, primary key (x))` should emit an advisory.

## What to decide

Pick one and apply it to both spellings:

**Option A — relax (the direction the filing lamina maintainer favours).** Stop promoting NOT NULL
on a declared PK. `primary key` then means "these columns are the row identity", full stop;
nullability stays whatever the column declared or the session default gave it. Consequences:

- The two spellings become genuinely equivalent, which is what makes the sugar model true and lets
  lamina delete its flag.
- `generateTableDDL` can stop omitting the clause for synthesized keys — the round-trip hazard that
  omission exists to dodge disappears with the promotion.
- `isSynthesizedAllColumnsKey`'s doc comment about why re-parse must re-synthesize needs rewriting.
- A user porting Postgres/SQLite DDL gets a weaker constraint than they wrote, silently. If Option A
  is chosen, consider whether `create table … (x integer null, primary key (x))` should at least be
  *loud* — an advisory, not an error — so the weakening is visible where it is written.

**Option B — tighten.** Make a synthesized key promote NOT NULL too. Consistent, standard-conforming,
and it deletes the DDL-emitter special case as well. But it removes the ability to declare a table
whose rows are their own identity and whose columns may be empty, which is the entire point of the
no-PK shape, and it would reject data that is legal today on reopen of an existing database. This is
almost certainly the wrong direction, listed for completeness.

## On Third Manifesto

The project's NOT NULL-by-default posture cites Third Manifesto, so it is worth being precise: the
Manifesto's position is that NULL should not exist, not that NULL should be permitted everywhere
except keys. Given NULL exists in this engine, "NULL is a distinguishable value that compares equal
to itself" is the internally coherent reading, and it is the one the backends already implement.
Option A is a smaller departure from that posture than the current split is from itself.

## Scope of the change for Option A

- `manager.ts` `buildColumnSchemas`: the `(isPkColumn && !synthesized)` term collapses to
  `col.notNull`, and `synthesized` stops being needed there.
- `table.ts` `columnDefToSchema`: delete the `if (schema.primaryKey) schema.notNull = true;` block.
- `ddl-generator.ts`: reconsider the synthesized-key clause omission (it becomes unnecessary; whether
  to also start emitting the clause is a separate readability call).
- `docs/schema.md`: rewrite § "Primary-key nullability" and the round-trip note ~315 in place — they
  currently describe the split as intended behaviour, so leaving them is worse than the code change.
- Foreign keys are the one place worth thinking twice about, and should be settled before merge, not
  after: standard SQL's MATCH SIMPLE rule says a child FK with any NULL member is not checked, and
  that rule assumes the *parent* key cannot be NULL. Decide and document what an FK referencing a
  parent key that contains NULL means. `tickets/backlog/bug-self-fk-null-rule-diverges-from-match-simple.md`
  on this board is adjacent and may want reading alongside.
- Existing databases: a schema persisted with a declared PK already has `notNull: true` baked into
  its column schemas, so relaxation does not retroactively loosen anything on reopen. Confirm that
  rather than assuming it.

## Also worth verifying while in here

`runtime/emit/alter-table.ts` `runAddColumn` never touches `primaryKeyDefinition`, so a live
`ALTER TABLE … ADD COLUMN` leaves a synthesized key at its old width — while a DDL round-trip
(emit, re-parse) re-synthesizes it *wider*, now including the new column. The same table therefore
has two different keys depending on whether it went through persistence. That inconsistency is
independent of the nullability question and survives either option; it may deserve its own ticket.
