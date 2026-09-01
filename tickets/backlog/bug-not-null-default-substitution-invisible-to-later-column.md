----
description: When a write leaves two required columns empty and asks the database to fill them from their defaults, a default that copies from the other required column reads an empty value instead of the one just filled in, so the write fails with a "must not be empty" error even though both defaults could have satisfied it.
files:
  - packages/quereus/src/runtime/row-constraints.ts   # checkNotNullConstraints (~246-292) — the substitution loop; and evaluateRowConstraints (~194) which only re-shows the row after the loop finishes
  - packages/quereus/src/planner/building/insert.ts   # buildExpressionDefaultProjection — the INSERT-path rule this diverges from
  - packages/quereus/test/logic/03.4-defaults.sqllogic # the NOT NULL default section
repro: verified
severity: edge-case
likelihood: unusual
tradeoffs: The engine deliberately refuses to let one column's DEFAULT depend on another column's DEFAULT on the INSERT path (it rejects `new.<other>` at plan time to avoid an evaluation-order dependency), so a maintainer could reasonably rule that the substitution path is simply inheriting that rule and close this as working-as-intended — in which case the fix is a clearer error message, not a value change.
----

# A substituted NOT NULL default is not visible to the next column's default

## What happens

When a statement writes an explicit NULL into a `not null` column and asks for conflict
resolution `replace` (statement-level `insert or replace`, or the column's own
`on conflict replace` clause), the engine substitutes that column's `DEFAULT` instead of
failing. It walks the table's `not null` columns in declaration order, substituting each
in turn.

Each substituted value is written into a copy of the row, but the row the *next* column's
DEFAULT expression evaluates against is still the original one. So a DEFAULT that reads an
earlier column through `new.<column>` sees the NULL that was there before the substitution,
not the value that was just put in its place.

Verified against the current tree:

```sql
create table t (id integer primary key,
                a text not null default ('A'),
                b text not null default ('<' || new.a || '>'));

insert or replace into t values (1, null, null);
-- actual:   NOT NULL constraint failed: t.b
-- expected: row (1, 'A', '<A>')
```

`a` is substituted to `'A'`. `b`'s default then evaluates `'<' || new.a || '>'` against a
row where `a` is still NULL, producing NULL — and a DEFAULT that evaluates to NULL cannot
satisfy `not null`, so the whole write is rejected.

## Why it is worth deciding

It surfaces as a `NOT NULL constraint failed` naming a column that has a perfectly good
DEFAULT, which reads like an engine bug to whoever hits it. The value is never silently
wrong — the write always fails loudly — so this is a spurious rejection, not corruption.

## The tension a maintainer has to settle

The INSERT path already forbids this shape. When a column is *omitted*, its DEFAULT is
evaluated in a scope that deliberately does not register other omitted columns, so
`insert into t (id) values (1)` on the schema above fails at plan time with
`new.a isn't a column`. The comment at that site says the exclusion exists so that one
default cannot depend on another default's evaluation order.

The substitution path escapes that guard because `a` was *supplied* (as NULL), so
`new.a` resolves fine — it just resolves to the pre-substitution value. Two defensible
resolutions:

- **Make the substitution visible.** Evaluate each substituted DEFAULT against the row as
  substituted so far. Declaration order makes it deterministic, so there is no order race
  of the kind the INSERT-path guard was protecting against. `t` above then stores
  `(1, 'A', '<A>')`.
- **Rule it out, like INSERT does.** Keep the current value semantics and fix only the
  diagnosis: say that `b`'s DEFAULT read a column whose own default had not been applied,
  instead of reporting a bare NOT NULL violation.

Either way, whichever is chosen should be stated in `docs/types.md` § Where coercion
happens or alongside invariant RT-001 in `docs/invariants.md`, since RT-001 now asserts
that every write-path expression reads "the row being written" without saying what that
row holds mid-substitution.

## Not in scope

This is about *which row* a substituted DEFAULT reads, not about which *form* the values
in it are in. The conversion contract itself (RT-001) holds here: every value in the row,
substituted or not, is in its column's declared form.
