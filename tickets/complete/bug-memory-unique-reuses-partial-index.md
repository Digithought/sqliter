description: On in-memory tables, a uniqueness rule declared on a column that already had a filtered index quietly stopped working for most rows — duplicates were accepted even though the rule said they should not be. Fixed at all three places that pick the structure enforcing a uniqueness rule, with regression tests on both storage backends.
files:
  - packages/quereus/src/vtab/memory/layer/manager.ts                  # three fix sites
  - packages/quereus-store/src/common/implicit-unique-index.ts         # findReusableIndexForUnique — reference predicate (store never affected)
  - packages/quereus/test/logic/10.5.7-implicit-unique-index-lifecycle.sqllogic  # §10e, §10e-bis
  - docs/memory-table.md                                               # new "Which structure enforces a declared UNIQUE" section
repro: verified
---

## What was wrong

A declared `UNIQUE` is enforced through a secondary BTree. Rather than always building
one, the in-memory backend may adopt an existing index over the same columns. A
**filtered** index (`create index … where …`, also called partial) physically holds only
the rows its predicate admits — and the write path *skips the uniqueness check entirely*
for a row outside the covering index's predicate. So adopting a filtered index for an
unfiltered `UNIQUE` narrowed enforcement to the filter's scope, and duplicates outside it
were accepted.

The persistent-store backend was never affected; `findReusableIndexForUnique`
(`packages/quereus-store/src/common/implicit-unique-index.ts:95`) already excluded
filtered indexes. The fixes mirror it.

## What changed

Three sites in `packages/quereus/src/vtab/memory/layer/manager.ts` choose the structure
that enforces a constraint. All three now apply the same admissibility rule.

**Sites 1 and 2 (landed in the implement stage).** The two *creation-time* reuse
searches — `ensureUniqueConstraintIndexes` (`CREATE TABLE`-declared `UNIQUE`) and
`addUniqueConstraint` (`ALTER TABLE … ADD UNIQUE`). Both now skip the search when the
constraint is itself filtered, and require `!idx.predicate` on the candidate.

**Site 3 (found and fixed in this review).** `findIndexForConstraint`'s column-set
fallback — see *Review findings*.

## Review findings

### Checked and clean

- **Both implement-stage fix sites re-derived from the diff before reading the handoff.**
  Correct, and each is a genuine improvement beyond the reported symptom: with two
  filtered unique indexes over one column, the old unguarded search could hand a
  constraint derived from the *second* index the *first* index as its backing structure.
- **No regression for filtered constraints.** A constraint synthesized from
  `create unique index … where …` always carries `name` set to the index name
  (`appendIndexToTableSchema`, `packages/quereus/src/schema/table.ts:539`), so skipping
  the reuse search for `uc.predicate` still resolves it to its own index through the
  name-claim arm rather than pushing a duplicate structure. Verified by running the
  scenario, not only by reading.
- **Both backends.** Lint clean; memory **8166 passing / 0 failing / 13 pending**; store
  **8158 passing / 0 failing / 21 pending**. No pre-existing failures surfaced, so
  `tickets/.pre-existing-error.md` was not written.
- **New assertions verified to actually execute** by deliberately breaking one and
  confirming the run went red, then reverting — a `.sqllogic` section that is silently
  skipped would otherwise look identical to a passing one.

### Major — found, fixed in this pass

**The third site was reachable, and reproduced the original bug.** The handoff flagged
`findIndexForConstraint`'s column-set fallback as same-shape but judged it unreachable
("by-name resolution should always succeed"), and proposed a tripwire comment. That
judgement was wrong, so it was fixed rather than parked.

The fallback runs whenever the by-name lookup misses, and that happens for two ordinary
reasons, both confirmed by instrumenting the branch and running real SQL:

- An **unnamed** constraint that reused an existing index has its structure recorded under
  *the reused index's* name, while the reader derives the key `_uc_<columns>` from the
  constraint. The keys differ, so the lookup misses on every write.
- A reused index that is later **dropped** leaves the recorded name unresolvable, which
  makes the lookup miss for named constraints too.

Reproduced end to end on the pre-fix tree — the second insert was accepted and the table
held two rows where it should have held one:

```sql
create table x (id integer primary key, c integer, s text);
create unique index xp on x (c) where s = 'pos';   -- filtered
create unique index xu on x (c);                   -- unfiltered
alter table x add unique (c);                      -- adopts xu
drop index xu;                                     -- constraint loses its structure
insert into x values (1, 5, 'a');
insert into x values (2, 5, 'b');                  -- accepted; must be rejected
```

The fallback now skips filtered indexes, skips the scan entirely for a filtered
constraint, and additionally requires per-column collation equivalence — the neighbouring
comment already named collation as the reason to prefer by-name resolution, but the
fallback itself never checked it. It also now continues scanning instead of returning
`undefined` on the first column-set match whose index fails to resolve. Returning
`undefined` is always safe: enforcement falls back to a full scan that applies the
constraint's own predicate and collations, so the guards can only trade speed for
exactness, never the reverse. Verified: the case above now rejects the duplicate.

Covered by a new regression section **§10e-bis** in
`10.5.7-implicit-unique-index-lifecycle.sqllogic`, which runs on both backends and also
asserts the filtered index keeps enforcing its own narrower rule alongside.

### Minor — fixed in this pass

- **Duplicated auto-name spelling.** `implicitIndexNameOver`'s own doc comment says it must
  be the only spelling of the `_uc_<cols>` rule in the file, but two sites open-coded
  `` `_uc_${colNames.join('_')}` `` — one of them inside `addUniqueConstraint`, a fix site
  here. Both now call the helper, each keeping its original column source (the layer's
  schema at one site, the table schema at the other). A now-unused local was removed.
- **Stale comment.** The by-name resolution block described the fallback as purely
  "defensive"; the reachability finding above contradicts that, so the wording was
  corrected and the real triggers documented at the fallback itself.

### Docs

Treated as out of date until read. `docs/memory-table.md` documented the covering
structure only in passing (`RENAME COLUMN`, `ALTER COLUMN` validation) and stated no rule
about which index may enforce a constraint — so the rule this bug turns on was written
down nowhere. Added a **"Which structure enforces a declared UNIQUE"** section stating the
two admissibility conditions, why each matters, the three sites bound by them, and that
finding no structure is the safe outcome. `docs/invariants.md` was checked and carries no
claim this change contradicts.

### Filed elsewhere

No new ticket was created. The covering-structure **key mismatch** described above is a
real remaining cost — after this fix it is no longer a correctness problem, but the reuse
path re-derives the structure on every write, and once the reused index is dropped
uniqueness is enforced by a full table scan for the life of the table. Per *Before you
file a ticket*, the board was searched first: `backlog/debt-memory-unique-index-reuse-after-create-index`
already owns this site and this lifecycle question (its "dropping that index should
restore the auto-built index" bullet covers half of it), so the detail was **appended as a
second arm** to that ticket rather than filed as a duplicate.

### Tripwires

None recorded. The one candidate the handoff proposed — the `findIndexForConstraint`
fallback — turned out to be a live, reproducible defect rather than a conditional concern,
so per the stage rules it was fixed rather than demoted to a comment.
