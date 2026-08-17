---
description: When a writable view joins two tables and a row's identity columns hold no value, writing through the view either quietly does nothing, quietly duplicates a row, or reports no rows from a statement that did change data.
files:
  - packages/quereus/src/planner/mutation/multi-source.ts       # capture relation + all four correlation sites + both null-extension proxies
  - packages/quereus/src/planner/mutation/set-op.ts             # already has a local `nullSafeEqual` — fold into the shared helper
  - packages/quereus/src/planner/mutation/decomposition.ts      # four `capturedValueSubquery` call sites; same defect via the shared helper
  - packages/quereus/src/planner/nodes/join-node.ts             # ExistenceColumnSpec — the match-marker mechanism to reuse
  - packages/quereus/src/planner/nodes/join-utils.ts            # EXISTENCE_FLAG_TYPE, buildJoinAttributes
  - packages/quereus/src/planner/analysis/key-filter.ts         # the shipped per-column NULL-safe predicate shape to mirror
  - packages/quereus/test/logic/93.4-view-mutation.sqllogic     # where the join-view write cases live
  - packages/quereus/test/logic/43.3-nullable-primary-key.sqllogic  # the nullable-key corpus this shape is missing from
  - docs/view-updateability.md                                  # § Multi-Base-Table Mutations / § returning — carries the "Known hole" note to retire
  - docs/vu-operators.md                                        # § Outer Joins — documents the null-extension partition test
repro: verified
difficulty: hard
---

# Writing through a join view misidentifies rows whose key holds NULL

## Background

A primary key column may now hold NULL — key membership stopped implying `not null`
(`docs/schema.md` § Primary-key nullability). Key comparison treats NULL as a value equal to
itself, so a row keyed `(NULL)` is a perfectly ordinary, addressable row.

A **writable multi-source view** is a view whose body joins two or more base tables and that
is written through with `update` / `delete` / `insert`; the planner routes each write to the
individual base tables. To know *which* base rows a write is about to touch, it first builds a
**capture relation** (`__vmupd_keys`, `MS_UPDATE_KEYS_CTE`): before any base table is mutated,
it projects each join side's primary-key columns into a temporary relation, then correlates
every per-side base operation back to that relation. Two assumptions baked into that
correlation are no longer true:

- **Correlation is plain `=` on the captured key value.** SQL `=` yields UNKNOWN when either
  operand is NULL, so a captured key containing NULL matches nothing — the row the view
  displayed becomes unaddressable by the write.
- **"All of a side's captured key columns are NULL" is read as "that side had no join
  partner"** — the outer-join null-extension test. A real matched partner whose key holds NULL
  is indistinguishable from an absent one, so the write takes the *materialize a new partner*
  branch instead of the *update the existing partner* branch.

Both were sound by construction while every key column was NOT NULL. Neither is guarded now.
Reachability is new as of `feat-relax-declared-primary-key-not-null`.

## Observed behaviour

Five arms, all re-run against the tree at ticket time (`main` @ `acee3a540`). Arms 1, 2 and 4
come from the fix-stage ticket; arms 3 and 5 were found while reproducing it. Every arm is
`pragma foreign_keys = false;` plus one nullable key column and a writable join view — no
exotic schema.

**Arm 1 — inner join: the update silently does nothing.**

```sql
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

**Arm 2 — left outer join: the update duplicates the partner row.**

Same shape with `left join`, and the non-preserved side's key column carrying a DEFAULT so the
mistaken insert can mint a key:

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
select pp, jk, pv from nkp;          -- TWO rows: (null,7,10) and (1,7,99)
select cc, cv, pv from nkv;          -- the view now returns TWO rows for cc = 1
```

Without the DEFAULT the same misclassification surfaces as a spurious
`UNIQUE constraint failed: nkp PK.` on a statement that should have been an in-place update.

**Arm 3 — inner join: the delete half-fires.** Same schema as arm 1, `delete from dv where
cc = 1` — the child table's row is deleted, the parent row keyed `(null)` survives. A
`delete` through an inner-join view fans out to every side; the side whose captured key is
NULL is silently skipped, so the statement leaves the database in a state the view itself
could never produce.

**Arm 4 — composite key with NULL in only some members.** Parent keyed `primary key (a, b)`
holding `(1, null)`. `update cv2 set pv = 42 where cc = 1` reports success; `pv` stays 10.
This shape is neither fully matched nor "all NULL", so it exercises both broken assumptions at
once.

**Arm 5 — `update … returning` returns nothing for a write that did land.** Same schema as
arm 1, updating the *child* (whose key is NOT NULL):

```sql
update rv set cv = 55 where cc = 1 returning cc, cv, pv;  -- returns []
select cc, pr, cv from rc;                                -- cv IS 55 — the write happened
```

The RETURNING re-query ANDs an identity predicate across *all* sides, so the parent's NULL
captured key drops the row even though the parent was never touched.

## Root cause

Everything above resolves at one substrate: the capture relation in
`packages/quereus/src/planner/mutation/multi-source.ts` and its readers. Four sites spell out
the "is this the row I captured?" correlation by hand with plain `=`, and two sites read
NULLness as a proxy for "no join partner".

**Correlation sites (plain `=` on a captured key column):**

| Site | Consumers |
| --- | --- |
| `buildCapturedKeyPredicate` (~2082) | per-side UPDATE base op (~1839), existence-flip DELETE (~1872), DELETE fan-out (~2562) |
| `buildMultiSourceUpdateReturning` — the `exact` conjunction (~2347) | UPDATE … RETURNING re-query |
| `capturedValueSubquery` (~2885) | non-preserved matched read-back (~1688), cross-source SET reads (~2825), and **four `decomposition.ts` call sites** (~1346, ~1388, ~1811, ~1945) |
| `set-op.ts` `buildMemberExists` (~1402) | **already NULL-safe** via its local `nullSafeEqual` (~1429) — the precedent, and the DRY target |

**Null-extension-by-NULLness proxies:**

- `buildNullExtendedInsert`'s WHERE (~1953): "every captured PK column of the non-preserved
  side is null" ⇒ materialize a new partner.
- `buildMultiSourceUpdateReturning`'s `allNull` disjunct (~2357): the same test, used to
  re-key the re-query off the preserved side.
- Two comments (~1683, ~1867) additionally lean on `=` *never matching a NULL capture* to
  exclude null-extended rows from the matched branch — an implicit third reader of the same
  proxy.

`decomposition.ts` is affected transitively: its captures correlate through
`capturedValueSubquery` on an anchor/member key column, so a nullable anchor key produces the
same silent no-op. It has no correlation of its own to fix.

## Ordering constraint — read before planning the work

**The two invariants must land together, and the marker must come first.** Making correlation
NULL-safe *on its own* makes the outer-join path strictly worse: today a null-extended capture
row (non-preserved key columns all NULL) fails the `=` correlation and is therefore excluded
from the matched-update branch — that accidental exclusion is load-bearing (see the comments
at ~1683 and ~1867). Under a NULL-safe correlation that same capture row would match any real
partner row whose key holds NULL, and the matched UPDATE would write to an unrelated row.

So: introduce the explicit marker first, re-express every "no partner" test in terms of it,
and only then flip correlation to NULL-safe. Hence the two phases below — this is one ticket
because there is no safe intermediate commit that splits them.

## Design

### The explicit match marker

The engine already computes exactly the needed bit and never exposes it here. A `JoinNode`
carries optional `existence` specs (`ExistenceColumnSpec` in
`packages/quereus/src/planner/nodes/join-node.ts`): boolean columns appended after both sides,
typed `EXISTENCE_FLAG_TYPE` (`join-utils.ts` — boolean, genuinely NOT NULL), whose value the
nested-loop emitter sets from **the actual null-extension decision**, not from a
re-evaluation of the ON predicate (`runtime/emit/join.ts` ~44–60). That is precisely "did this
side have a partner", carried explicitly. It ships today for view-declared `exists … as`
columns over these same join bodies, and it needs **no runtime change** to reuse.

Plan: when `buildMultiSourceKeyCapture` (~2232) builds the capture over `analysis.joinNode`,
rebuild that join with one extra synthetic existence spec per **captured non-preserved side**
and project the flag into the capture as an extra key column (suggested name `m<sideIndex>`,
alongside the existing `k<side>_<j>`). Notes for the implementer:

- Only the *capture* needs the rebuilt join. The RETURNING re-query keeps reading
  `analysis.joinNode` unchanged and reads `k.m<np>` out of the capture like any other captured
  column.
- Attribute identity survives the rebuild: `buildJoinAttributes` copies the child nodes'
  attributes verbatim (only marking them nullable per join type) and appends the flags with
  pre-minted ids, so `analysis.joinScope` still resolves every pre-existing name against the
  rebuilt node. Build the flag's own reference directly from its attribute id — do not expect
  the scope to know it. `key-filter.ts` (`makeColumnRef`) shows the by-attribute
  `ColumnReferenceNode` shape.
- For an n-way body the non-preserved side may sit under a *nested* `JoinNode`; append the
  spec to the join that directly owns it and rebuild the ancestors with `withChildren` (which
  re-derives attributes from children and threads existing existence specs verbatim). A flag
  minted below an enclosing outer join can itself be null-extended to NULL — treat NULL as
  false at every read site rather than assuming the declared NOT NULL survives.
- Inner-join bodies have no non-preserved side, so they get no flags and the capture shape is
  unchanged — including the set-op join-leg path (`set-op.ts`), which only composes INNER legs
  (`isInnerJoinBody`).

### The NULL-safe correlation helper

One helper, called by every capture reader, mirroring the shape `key-filter.ts` already emits
per nullable key column:

```
   col = :p                                  -- key column declared NOT NULL
   (col is null and :p is null) or col = :p  -- key column declared nullable
```

Gating on the column's declared nullability (`ColumnSchema.notNull`) matters for more than
tidiness: a plain `=` on a NOT NULL column stays index-friendly, whereas a disjunction can
cost the engine a seek. Every key column here is reachable from its side's `TableSchema`, and
the decomposition call sites have their member/anchor `TableSchema` in hand at the call
(`resolveMemberTable(ctx, member).tableSchema`), so nullability can be threaded rather than
guessed.

Suggested shape — a small module (e.g. `planner/mutation/capture-correlation.ts`) exporting
the per-column equality builder, so `multi-source.ts` (already 3332 lines) does not grow
further and `set-op.ts` can retire its private `nullSafeEqual`. `capturedValueSubquery`'s
`owningPk: readonly string[]` parameter has to carry nullability too — either a
`{ name, nullable }[]` or a parallel boolean array; whichever, update all six call sites.

### Expected behaviour after the fix

Arm 1 sets the parent's `pv` to 42. Arm 2 updates the existing parent in place and mints
nothing. Arm 3 deletes both sides. Arm 4 behaves like arm 1. Arm 5 returns the updated row.
Genuine null-extension keeps working: an outer-join row with no partner still materializes one
(now because its marker says so, not because its key happened to be NULL).

## TODO

### Phase 1 — carry "had no join partner" explicitly

- Add a per-non-preserved-side match-flag column to `MultiSourceKeyCapture` (name it via a
  `matchFlagName(sideIndex)` helper next to `keyColumnName`, so readers and the projection
  cannot drift).
- In `buildMultiSourceKeyCapture`, rebuild the join under the capture with one synthetic
  `ExistenceColumnSpec` per captured non-preserved side, and project each flag as a capture
  column. Handle the nested-join case (append at the owning join, rebuild ancestors).
- Re-express `buildNullExtendedInsert`'s WHERE (~1953) as "the marker says no partner" instead
  of "every captured PK column is null". Read a NULL marker as false.
- Re-express `buildMultiSourceUpdateReturning`'s `allNull` disjunct (~2357) the same way.
- Add the marker as an explicit conjunct to the two matched-branch sites that currently rely
  on `=`-never-matching-NULL to exclude null-extended rows (the non-preserved matched UPDATE
  at ~1688/~1839, and the existence-flip DELETE at ~1872), and rewrite the comments there —
  they document the accidental exclusion as if it were the mechanism.

### Phase 2 — NULL-safe correlation

- Add the shared per-key-column equality helper (NULL-safe only for a column declared
  nullable; plain `=` otherwise). Give it one doc comment explaining why the nullability gate
  exists, and cross-reference `analysis/key-filter.ts` as the sibling implementation.
- Rewrite `buildCapturedKeyPredicate` (~2082) to use it.
- Rewrite `buildMultiSourceUpdateReturning`'s `exact` conjunction (~2347) to use it.
- Rewrite `capturedValueSubquery` (~2885) to use it; thread key-column nullability through its
  signature and update all call sites in `multi-source.ts` and `decomposition.ts`.
- Retire `set-op.ts`'s private `nullSafeEqual` (~1429) in favour of the shared helper.
- Grep for any remaining `table: 'k'` equality built by hand in `planner/mutation/` and route
  it through the helper or justify it in a comment.

### Tests

- Add the five arms above to `packages/quereus/test/logic/93.4-view-mutation.sqllogic` as one
  section, each asserting the post-write base-table state (not just that the statement
  succeeded — every arm currently "succeeds").
- Add the same shapes to `packages/quereus/test/logic/43.3-nullable-primary-key.sqllogic` from
  the nullable-key angle, so the corpus that owns this rule covers view writes.
- Cover `delete` and `update … returning` for both the inner-join and left-join shapes, and
  the composite-key-with-some-NULL-members shape for both.
- Cover the genuine null-extension path explicitly (a left-join row with truly no partner,
  under an update of a non-preserved column) — that is the regression Phase 1 is most likely
  to break, and no arm above exercises it.
- Add a decomposition case with a nullable anchor key (the `capturedValueSubquery` reader in
  `decomposition.ts`), so the shared-helper fix is pinned on that path too.

### Docs

- `docs/view-updateability.md` § `returning` (~line 204) carries an explicit **"Known hole"**
  paragraph naming this ticket — replace it with the shipped behaviour.
- `docs/vu-operators.md` § Outer Joins (~line 121) describes the null-extended partition as
  `where <np PK> is null` — restate it in terms of the match marker.
- `MS_UPDATE_KEYS_CTE`'s doc comment in `multi-source.ts` (~120) carries a `KNOWN HOLE:` block
  pointing at this ticket — remove it and describe the two invariants instead.

### Validation

- `yarn workspace @quereus/quereus test`
- `yarn lint` (the quereus package's lint also type-checks test files)
