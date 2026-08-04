---
description: A database-wide integrity rule written against a materialized view is silently never checked — violating rows commit without error, even though the same rule written against a plain view is enforced correctly.
files:
  - packages/quereus/src/core/database-assertions.ts   # AssertionEvaluator — baseTablesInPlan (~line 334) and the dependency-overlap dispatch in runGlobalAssertions (~line 248)
  - packages/quereus/src/core/database-transaction.ts  # getChangedBaseTables (~line 624) — what the dispatch intersects against
  - packages/quereus/src/runtime/delta-executor.ts     # the kernel that walks live subscriptions on overlap
  - packages/quereus/test/logic/95-assertions.sqllogic # assertion coverage; the MV cases here only exercise the DROP guard
  - docs/sql-ddl.md                                    # § 2.6.1 — states assertions are enforced at COMMIT, no MV carve-out
repro: verified
---

# An assertion whose body names a materialized view never runs

## What happens

Assertions are checked at COMMIT. An assertion that reads a materialized view is
accepted at create time, is treated as a real dependency everywhere else (dropping
the materialized view is refused while the assertion names it), and then never
fires — no matter what is written, to the source table or to the materialized view
itself.

Verified in-process at HEAD, memory module:

```sql
create table w (x integer primary key);
create materialized view mv as select x from w;
create assertion m1 check (not exists (select 1 from mv where x < 0));

insert into w values (-1);        -- commits, no error
select count(*) from mv where x < 0;
-- 1                              -- the rule is broken and nothing said so

insert into w values (2);         -- a later commit does not catch it either
insert into mv values (-3);       -- writing the MV directly does not either
```

Control — the identical rule over a **plain** view is enforced:

```sql
create view v as select x from w;
create assertion m2 check (not exists (select 1 from v where x < 0));
insert into w values (-1);
-- Integrity assertion failed: m2
```

## Why the two differ

The evaluator only runs an assertion when the tables its compiled plan reads
overlap the set of base tables the transaction changed.

- A **plain view** is expanded during planning, so the assertion's plan reads
  `main.w` — the same table the write changed. Overlap, so it runs.
- A **materialized view is a table**, so the plan reads `main.mv`, and
  maintenance of `mv` from the write to `w` is not recorded in the transaction's
  changed-table set (observed: after `insert into w values (-1)` inside an
  explicit transaction, the changed set is `main.w` alone). No overlap, so the
  assertion is never dispatched. The evaluator's only other path — run
  unconditionally — applies solely to assertions that read no table at all.

So this is one decision made in two places that disagree: what counts as
"changed" when a maintained table is refreshed inside the transaction.

## What a fix has to settle

Not obvious which side should move, which is why this is filed rather than fixed
inline:

- **Record maintenance writes as changes.** Truthful, and would let the existing
  row-specific/global classification do useful work on the materialized view's own
  rows. But it widens the changed set for every delta-driven consumer (watches,
  the lens layer), not just assertions — the blast radius needs measuring, not
  assuming.
- **Expand a maintained table to its sources when computing an assertion's
  dependency set.** Narrower — touches only the evaluator. But it makes the
  assertion re-run on any source write even when maintenance produced no change to
  the materialized view, and it needs the source set of a derivation chain
  (a materialized view over a materialized view).

Whichever way, the enforcement path is the *whole* rule body re-run: correctness
first, then decide whether the per-key optimization can apply.

## Scope notes

- Also covers a **maintained table** (`create table … maintained as …`) — the same
  catalog record, the same dispatch.
- Not a regression from the rename propagation work: the control above reproduces
  with no `ALTER TABLE` anywhere in it.
- The `DROP TABLE` / `DROP MATERIALIZED VIEW` refusal that already treats these
  assertions as live dependencies stays correct either way — it is guarding a rule
  that *should* be enforced.
- Docs (`sql-ddl.md` § 2.6.1) promise COMMIT-time enforcement with no exception for
  materialized views, so no doc change is wanted here — the code should meet the
  doc.
