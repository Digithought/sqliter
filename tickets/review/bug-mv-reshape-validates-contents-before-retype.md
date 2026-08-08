---
description: A maintained table rebuilt after one of its source columns changed type or text-sorting rule used to check the rebuilt rows against the table's OLD column definition, so a row breaking its own rule under the NEW definition was accepted and stored. The check now uses the final column definition, so such a row is rejected and nothing is written.
files:
  - packages/quereus/src/runtime/emit/materialized-view-helpers.ts   # previewReshapedColumns (new, ~2395); validateDeclaredConstraintsOverContents (~938); rebuildBacking (~1568); attachMaintainedDerivation call site (~1276); reshapeBackingInPlace (~2585)
  - packages/quereus/test/maintained-table-refresh-revalidation.spec.ts  # header comment + 2 rewritten describe blocks
  - docs/materialized-views.md                                       # § REFRESH MATERIALIZED VIEW, line 208
  - package.json                                                     # root; `//check-repr` note deleted, `check` chain now ends `&& yarn test:repr-strict`
repro: verified
difficulty: medium
---

# What changed

A **maintained table** derives its contents from a query over other tables. When a
source column changes its declared type (or its text-sorting rule, its *collation*),
the maintained table is **reshaped**: its own column takes the new attribute and its
contents are rebuilt from the query.

The rebuild validates the new contents against the table's declared `check (…)` and
foreign-key constraints. It used to do that while the table's catalog entry still
carried the **old** column attributes — and a SQL comparison takes its type affinity
and its collation from the column's *declared* attributes, so the constraint was
evaluated under the wrong rules. `check (v < '9')` on a column moving TEXT → INTEGER
compared lexicographically (`'10' < '9'` is true) instead of numerically (`10 < 9` is
false), and the offending row was committed and survived.

The fix does **not** reorder anything. The reshape's `retype` / `recollate` module ops
still run last (they convert *stored* rows; running them earlier would scan the
about-to-be-discarded contents and throw spuriously). Instead, the one validation scan
is handed a **preview** of the columns the reshape is about to land, so it resolves
comparisons under the final type and collation while running at exactly the same point
in the sequence — still before the commit.

## Shape of the change

New private helper `previewReshapedColumns(live, shape)`: maps the live (post-
structural-ops) columns onto the target shape **by name** and overrides only
`logicalType` and `collation`. Returns `undefined` when neither attribute shifts, so
every non-reshape path — and a reshape with no retype/recollate — is byte-identical to
before.

That result threads through as an optional `validationColumns` argument:

```
reshapeBackingInPlace ──┐
                        ├─→ rebuildBacking(db, mv, validationColumns?)
                        │        └─→ validateDeclaredConstraintsOverContents(db, mt, validationColumns?)
attachMaintainedDerivation ────────→ validateDeclaredConstraintsOverContents(db, live, preview)
```

`validateDeclaredConstraintsOverContents` already registers a constraint-stripped
clone of the live catalog record and restores it in a `finally`; the preview just
overrides that clone's `columns`. So there is **no new failure window and no new
catalog state to unwind**.

Both reshape call sites (refresh via `reshapeBackingInPlace`, and attach via
`attachMaintainedDerivation`) pass the preview, so the two paths reject identically.

Deliberately **not** previewed, each with a comment at the site:
- **`notNull`** — the tighten-NOT-NULL op stays a post-reconcile module op and keeps
  validating there. Declaring `notNull` early would let the optimizer fold a
  nullability-sensitive CHECK into a vacuous pass — the same unsound folding the
  constraint-stripped-clone swap exists to prevent.
- **`defaultValue` / generated-column attributes** — a reshape never moves them.
- Physical primary-key columns need no handling: `describePhysicalPkChange`
  (materialized-view-helpers.ts:2412) already refuses a reshape whose key column
  changes type or collation, so a previewed attribute cannot desynchronize the key
  encoding. Verified by reading that function, not assumed.

# New behaviour to exercise

For **both** the retype and the recollate reshape arms:

- A refresh whose recomputed set contains a row violating a declared CHECK **under the
  final column attributes** throws the maintained-table-attributed diagnostic
  (`… row derived into maintained table 'main.mt' violates its declared constraint`)
  and commits nothing.
- The pre-refresh committed contents survive and the table stays **stale** — same
  guarantee the non-reshape arm already gave.
- Because the post-reconcile ops never run on a rejected refresh, the catalog column
  keeps its **old** type / collation after the rejection. Correcting the offending
  source row and refreshing again completes the reshape, and *that* is where the
  attribute flip is asserted as proof the reshape arm ran.
- The attribute-**insensitive** controls (`check (id > 0)` over the same reshape) still
  reject a genuine violator, pinning that the ordinary validation path is undisturbed.

## Concrete cases to try by hand

```sql
-- retype arm: rejected
create table src (id integer primary key, v text);
create table mt (id integer primary key, v text, check (v < '9'))
  maintained as select * from src;
insert into src values (1, '10');            -- clean under TEXT ('1' < '9')
alter table src alter column v set data type integer;   -- mt goes stale
refresh materialized view mt;                -- REJECTED: 10 < 9 is false under INTEGER
select id, v from mt;                        -- still [1, '10'] — nothing committed

update src set v = 5 where id = 1;
refresh materialized view mt;                -- now succeeds; mt.v is INTEGER, value 5
```

```sql
-- recollate arm: rejected
create table src (id integer primary key, v text);
create table mt (id integer primary key, v text, check (v <> 'abc'))
  maintained as select * from src;
insert into src values (1, 'ABC');           -- clean under BINARY
alter table src alter column v set collate nocase;
refresh materialized view mt;                -- REJECTED: 'ABC' = 'abc' under NOCASE
```

Worth probing beyond what the spec covers: the **attach** arm
(`alter table … set maintained as <body>` over a table whose column type/collation
shifts) — it takes the same preview but is reached through a different call site with
its own commit-first ordering and its own `restoreReshaped` / `reconcileCommitted`
rollback branches. The spec exercises the refresh arm directly and the attach arm only
indirectly. See *Known gaps* below.

# Validation performed

All from repo root, all clean:

| command | result |
| --- | --- |
| `maintained-table-refresh-revalidation.spec.ts` under `QUEREUS_REPR_STRICT=1` | 23 passing, 0 failing |
| full quereus suite under `QUEREUS_REPR_STRICT=1`, `--no-bail` | **9087 passing, 0 failing**, 16 pending |
| `yarn test` (all workspaces) | pass (5m 39s) |
| `yarn test:store` (LevelDB backend) | 9070 passing, 33 pending, 0 failing |
| `yarn lint` | clean |
| `yarn build` | clean |
| `yarn typecheck` | clean |
| `yarn docs:check` | `Docs OK` |

The three `QUEREUS_REPR_STRICT` representation mismatches this ticket's root cause was
producing are gone, and the four tests that pinned the old (wrong) behaviour now pin
the rejection. `yarn test:repr-strict` is therefore clean and has been added to the
root `check` chain, replacing the `//check-repr` note that deferred it.

The `[TransactionCoordinator] release/rollback-to savepoint depth … out of range`
lines in the `test:store` output are pre-existing log noise on that backend, not
failures — the run reports 0 failing. Not introduced here and not investigated.

# Known gaps — where to push

Written honestly; treat the tests as a floor.

- **The attach reshape arm has no direct test for the new behaviour.** Both call sites
  pass the preview and the whole suite is green, but every test that *specifically*
  exercises an attribute-sensitive CHECK across a reshape goes through `refresh`, not
  through `alter table … set maintained as`. The attach path additionally commits the
  reconcile eagerly before its post-reconcile ops and has a `reconcileCommitted`
  branch in its catch that marks the view stale rather than restoring — worth checking
  a rejection there lands in the state the code comment claims.
- **FK constraints across a reshape are untested.** The preview affects the foreign-key
  scan exactly as it affects the CHECK scan (same stripped clone), and a collation
  change on a child-side FK column plausibly changes which parent rows match. Every
  reshape test here uses a CHECK.
- **Multi-column and mixed reshapes.** Tests cover one column shifting one attribute.
  A reshape whose plan mixes pre-reconcile ops (rename / add / drop) with a retype on
  a *different* column exercises the by-name mapping in `previewReshapedColumns` in a
  way nothing currently does. The mapping assumes names and order already agree at
  that point because the structural batch has run — true by construction, but only
  argued in a comment, not pinned by a test.
- **A retype that both narrows and would violate.** e.g. TEXT → INTEGER where the value
  is not convertible at all — the preview makes the CHECK scan see a declared INTEGER
  column holding a string. Under `QUEREUS_REPR_STRICT` that now surfaces as a
  representation error at the scan rather than at the later convert. Believed correct
  (it is a genuine defect surfacing earlier) but not deliberately exercised.
- **Two `NOTE:` tripwires were parked in the code, not filed as tickets** — see below.

# Tripwires parked (not tickets)

Both at `previewReshapedColumns` in
`packages/quereus/src/runtime/emit/materialized-view-helpers.ts`:

- The scan sees rebuilt values in their **pre-conversion** physical form but under the
  **post-conversion** declared type. These agree in practice — the target attribute is
  derived *from* the body's own output type, so the body already emits values of the
  new type. A retype whose conversion genuinely rewrites the value (a text → date
  canonicalization turning `'2024-06-05T00:00:00Z'` into `'2024-06-05'`) would have the
  CHECK see the un-normalized spelling. Trips only if a value-rewriting conversion is
  added to the reshape's op set.
- With the preview in place, a body emitting a value that does not conform to its own
  declared output type now trips the physical-representation checker
  (`QUEREUS_REPR_STRICT`) at this scan rather than sliding through. That is a genuine
  defect surfacing at the earliest honest point, not a regression.

# Review checklist

- The `previewReshapedColumns` by-name mapping assumes live and target column names
  agree at both call sites because the pre-reconcile structural batch has already
  applied every rename / add / drop. Confirm that holds on the attach arm too — its
  pre-reconcile batch runs inside a `try` with a different rollback shape.
- `Object.freeze` is applied to the preview array but not to the cloned column objects
  inside it. Elsewhere in this file columns are treated as immutable by convention;
  confirm nothing downstream of the stripped clone mutates a `ColumnSchema` in place.
- The undefined-when-unshifted return is what keeps every non-reshape path
  byte-identical. Confirm there is no reshape case where the attribute genuinely
  shifts but `backingTypeMatches` / `backingCollationMatches` report a match (both
  compare by interned name / normalized value, deliberately not by identity).
- `docs/materialized-views.md` line 208 replaced two "Known limitation" paragraphs with
  one describing the enforced behaviour. Confirm nothing else in `docs/` still asserts
  the corner is open (grepped: nothing does).
