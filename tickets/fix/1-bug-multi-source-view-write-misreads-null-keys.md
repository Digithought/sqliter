---
description: When a writable view joins two tables and a row's identity columns hold no value, writing through the view either quietly does nothing or quietly duplicates a row instead of updating the one that is already there.
files:
  - packages/quereus/src/planner/mutation/multi-source.ts   # the capture relation and every reader of it
  - packages/quereus/test/logic/93.4-view-mutation.sqllogic  # where the join-view write cases live
  - packages/quereus/test/logic/43.3-nullable-primary-key.sqllogic  # the nullable-key corpus this shape is missing from
  - docs/view-updateability.md                              # states the identification contract
repro: verified
difficulty: hard
---

# Writing through a join view misidentifies rows whose key holds NULL

## Background

A primary key column may now hold NULL — key membership stopped implying `not null`
(`docs/schema.md` § Primary-key nullability). Key comparison treats NULL as a value equal
to itself, so a row keyed `(NULL)` is a perfectly ordinary, addressable row.

Writable multi-source views (a view whose body joins two or more base tables — `UPDATE` /
`DELETE` / `INSERT` routed per side) identify the rows they are about to touch through a
**capture relation**: before mutating, the planner projects each side's primary-key columns
into a temporary relation, then correlates each per-side base operation back to it. Two
assumptions in that substrate are no longer true:

- **Correlation is plain `=` on the captured key value.** SQL `=` yields UNKNOWN when either
  side is NULL, so a captured key containing NULL matches nothing — the row the view
  displayed becomes unaddressable by the write.
- **"All of a side's captured key columns are NULL" means "that side had no join partner"**
  (the outer-join null-extension test). A real matched partner whose key holds NULL is
  indistinguishable from an absent one, so the write takes the *materialize a new partner*
  branch instead of the *update the existing partner* branch.

Both were sound by construction while every key column was NOT NULL. Neither is guarded now.

## Observed behaviour (both reproduced on the tree at review time)

**Arm 1 — inner join: the write silently does nothing.**

```sql
pragma foreign_keys = false;
create table ip (pp integer null primary key, jk integer null, pv integer null);
create table ic (cc integer primary key, pr integer null, cv integer null);
create view iv as select c.cc as cc, c.cv as cv, p.pv as pv
                    from ic c join ip p on p.jk = c.pr;
insert into ip values (null, 7, 10);
insert into ic values (1, 7, 100);

select cc, cv, pv from iv;          -- [{cc:1, cv:100, pv:10}] — the row is visible
update iv set pv = 42 where cc = 1; -- reports success
select pp, jk, pv from ip;          -- [{pp:null, jk:7, pv:10}] — pv NEVER CHANGED
```

**Arm 2 — left outer join: the write duplicates the partner row.**

Same shape with `left join`, and the non-preserved side's key column carrying a DEFAULT so
the mistaken insert can mint a key:

```sql
create table nkp (pp integer null primary key
                    default (coalesce((select max(pp) from nkp), 0) + 1),
                  jk integer null, pv integer null);
create table nkc (cc integer primary key, pr integer null, cv integer null);
create view nkv as select c.cc as cc, c.cv as cv, p.pv as pv
                     from nkc c left join nkp p on p.jk = c.pr;
insert into nkp (pp, jk, pv) values (null, 7, 10);
insert into nkc values (1, 7, 100);

select cc, cv, pv from nkv;          -- one row: pv = 10 (MATCHED, not null-extended)
update nkv set pv = 99 where cc = 1; -- reports success
select pp, jk, pv from nkp;          -- TWO parent rows: (null,7,10) and (1,7,99)
select cc, cv, pv from nkv;          -- the view now returns TWO rows for cc = 1
```

Without the DEFAULT the same misclassification surfaces as a spurious
`UNIQUE constraint failed: nkp PK.` on a statement that should have been an in-place update.

Neither arm needs an exotic schema: one nullable key column (explicit `null`, or any column
under `pragma default_column_nullability = 'nullable'`) plus a writable join view.

## What a fix has to establish

The goal is the invariant, not the two symptoms — every reader of the capture relation
currently re-derives "is this the row I captured?" from key values that can no longer answer
it. Two things must become impossible to get wrong:

- **A captured row must correlate back to exactly the row it came from, NULL key values
  included.** A NULL-safe correlation is the obvious shape (the engine already builds one —
  `packages/quereus/src/planner/analysis/key-filter.ts` emits
  `(col is null and :p is null) or col = :p` per nullable key column, and gates it on the
  column's declared nullability so a NOT NULL column keeps the plain, index-friendly `=`).
  Whatever form it takes, it should live in ONE helper the capture readers all call, rather
  than being spelled out at each of the four correlation sites.
- **"Had no join partner" must be carried explicitly, not inferred from NULLness.** A marker
  the capture projects from the non-preserved side (a literal that is NULL only under
  null-extension) answers the question directly and stops being a proxy for anything.

Expected behaviour after the fix: arm 1 updates the parent's `pv` to 42; arm 2 updates the
existing parent in place and mints nothing; and the same shapes work for `DELETE`, for
`UPDATE … RETURNING` (whose re-query uses the same matched-or-null disjunction), and for
cross-source SET reads (`capturedValueSubquery`, which correlates the same way).

Cover a composite key with NULL in only *some* members too — that shape is neither fully
matched nor "all NULL", so it exercises both assumptions at once.

## Notes

- The four correlation sites and the two null-extension branches are all in
  `multi-source.ts`; `MS_UPDATE_KEYS_CTE`'s doc comment carries a `KNOWN HOLE:` note
  pointing here.
- Single-source writable views are unaffected — they route to the base table without a
  capture relation.
- Reachability is new as of `feat-relax-declared-primary-key-not-null`: before it, a
  *declared* key column could not be nullable, and the only nullable keys (the synthesized
  all-columns key of a table with no `PRIMARY KEY`) are all-NULL only when the entire row is
  NULL, which no equi-join can match.
