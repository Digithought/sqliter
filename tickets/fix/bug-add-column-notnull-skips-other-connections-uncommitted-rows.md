description: When several connections share an isolated table, adding a mandatory column checks only the rows the connection running the change can see, so another connection's uncommitted rows can end up blank in a column that forbids blanks.
files:
  - packages/quereus/src/runtime/emit/alter-table.ts                # validateNotNullBackfill ~line 847 — the "are there rows?" probe, run on the issuing connection only
  - packages/quereus-isolation/src/alter-migration.ts               # computeAddColumnValue ~line 587-605 — the non-evaluator branch that appends the folded default unchecked
  - packages/quereus-isolation/test/isolation-layer.spec.ts         # ~line 3071 onward — the existing cross-connection "poison" tests, the nearest coverage
difficulty: medium
---

# What is wrong

`alter table … add column` refuses to add a column that forbids NULL when the table already
holds rows it cannot fill. The check is a probe on the connection issuing the statement:
"does `select 1 from t limit 1` return anything?" Under the isolation layer, that probe sees
the committed rows plus *the issuing connection's own* uncommitted rows — it cannot see rows
another connection has written but not yet committed.

So when the committed table is empty and a different connection is holding uncommitted rows,
the probe reports "no rows", the statement is accepted, and the isolation layer then carries
that other connection's rows forward by appending the column's default — NULL — into a column
that is not allowed to be NULL. The other connection is left holding rows that violate the
column it now has.

`packages/quereus-isolation/src/alter-migration.ts` is explicit that it is relying on the
engine to have already ruled this out: `computeAddColumnValue` enforces NOT NULL only on the
per-row-evaluator branch, and its comment says "a literal/NULL default's nullability is gated
up-front by the engine". That gating is the probe above, and the probe does not cover other
connections.

# Why it is filed separately

This is **not** caused by `bug-add-column-default-null-notnull-hole` (the ticket during whose
review it was noticed) and is not made worse by it. That ticket changed *which columns count
as mandatory*; this is about *which rows get counted*, and it behaves identically before and
after. It was already reachable with an explicit `not null` in the statement.

It is also **not** the cross-connection "poison" behaviour the isolation layer already
implements deliberately (`isolation-layer.spec.ts`, "row-validating DDL cross-connection
poison semantics"). Poisoning fires when a foreign connection's rows *fail* validation. Here
nothing fails — no validation runs against those rows at all.

# What to establish first

This was found by reading, not by running. Reproduce before designing a fix:

- Two `Database` connections sharing one `IsolationModule`, driven through ordinary SQL (the
  existing cross-connection tests inject overlays directly and call `iso.alterTable` by hand,
  which bypasses the engine probe entirely — that harness will not show this).
- Committed table empty. Connection B opens a transaction and inserts a row. Connection A
  runs `alter table t add column c integer` (mandatory under the shipped
  `default_column_nullability = 'not_null'`; an explicit `not null` should behave the same).
- Then ask what B sees, and what happens when B commits. If B's commit is rejected with a
  NOT NULL error, the damage is contained and this may be acceptable-as-designed — say so and
  close it. If B reads or commits a NULL in a NOT NULL column, it is a real hole.

# Expected behaviour

Adding a mandatory column must not leave any connection — including one whose rows the issuer
cannot see — holding NULL in that column. Whichever way it is resolved (refuse the statement,
poison the affected connection the way a failing backfill already does, or reject at that
connection's commit), the outcome should be stated in `docs/design-isolation-layer.md`
alongside the existing poison semantics, since "what happens to other connections' in-flight
rows" is exactly what that section exists to answer.
