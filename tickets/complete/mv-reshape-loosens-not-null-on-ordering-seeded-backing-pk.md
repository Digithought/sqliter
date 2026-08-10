---
description: |
  Refreshing a materialized view used to crash ("Cannot DROP NOT NULL on PRIMARY KEY column") when the
  view's hidden backing table keyed on a column the user later made nullable; the refresh now knows a
  primary-key column is never-null and stops trying to drop NOT NULL on it. Reviewed and completed.
prereq:
files:
  - packages/quereus/src/runtime/emit/materialized-view-helpers.ts   # isPhysicalPkColumn + both fix sites
  - packages/quereus/test/materialized-view-refresh-reshape.spec.ts   # regression + touch-point-#2 coverage
difficulty: medium
---

# Complete: MV reshape must not drop NOT NULL on an ordering-seeded backing PK column

## What shipped

A materialized view's hidden backing table can key on a column that the body's `order by` seeds into the
physical primary key (`computeBackingPrimaryKey` leads the key with the ordering columns). After a source
`alter … drop not null`, the re-derived body shape reports that column nullable while the backing keeps it
NOT NULL (a physical-PK member the memory manager refuses to loosen). The old refresh saw that skew as a
shape difference and emitted a `loosenNotNull` op, which `MemoryTableManager.alterColumn` rejects on a PK
column — crashing the refresh with `Cannot DROP NOT NULL on PRIMARY KEY column 'x'`.

Fix (all in `materialized-view-helpers.ts`), encoding the invariant *a physical-PK column is NOT NULL by
definition, so the backing never drops NOT NULL on it and a to-nullable shift on it is not a shape
difference*:

1. **`isPhysicalPkColumn(table, columnNameLower)`** — shared helper over `primaryKeyDefinition` +
   `columns[def.index].name`.
2. **`describeBackingShapeMismatch`** — a NOT-NULL→nullable *loosening* of a current physical-PK column is
   no longer a mismatch, so refresh keeps the data-only `rebuildBacking` fast path.
3. **`classifyBackingReshape.recordAttrShift`** — skips the `loosenNotNull` op for a physical-PK column when
   reshape is entered anyway (a genuine shape change coexisting with a PK-column loosening).

The mask is asymmetric on purpose: only *suppress loosening* of an already-NOT-NULL PK column, never *add*
NOT NULL to an already-nullable one.

## Review findings

**Checked:** the implement diff first (both fix sites + the regression test), then the surrounding
`materialized-view-helpers.ts` shape/reshape machinery. Confirmed correctness (soundness of the fast-path
mask, PK-membership guard, asymmetry), regression + edge coverage, the reshape fast/slow paths, convergence
(no re-reshape loop), lint, and the targeted spec.

**Correctness — confirmed sound.** `computeBackingPrimaryKey` seeds the ordering column into the physical
PK *regardless of nullability*, so after a `drop not null` the derived shape's PK stays `[x, id]` and the
end-of-function PK comparison in `describeBackingShapeMismatch` still matches — the mask does not
accidentally turn a real PK change into a fast-path match. The mask fires only for a current physical-PK
column on a NOT-NULL→nullable transition; a *tighten*, or any non-PK column, stays a real diff (the
existing "non-PK attribute shift" and "NOT NULL trailing add" cases stay live and pass). The touch-point-#2
guard matches by pre-rename name against `current.primaryKeyDefinition` — correct for the rename case.

**MINOR — fixed inline (test coverage).** Touch point #2 (the `loosenNotNull` skip in
`classifyBackingReshape.recordAttrShift`) had **no test** — the regression case only exercises the
site-#1 fast-path mask, which returns before reshape is ever entered. Added spec case *"a PK-column DROP
NOT NULL coexisting with a genuine reshape skips the loosen op (classifyBackingReshape guard)"*: a
trailing `select *` column add (genuine reshape) plus a `drop not null` on the seeded PK column in the same
refresh — the reshape lands (column `b` added), the loosen op is skipped, and backing `x` stays NOT NULL
with the `[x, id]` PK intact. Reshape spec now 15 passing (372ms); `yarn workspace @quereus/quereus run
lint` exit 0.

**MAJOR — filed as `fix/mv-refresh-materializes-null-into-notnull-seeded-pk`.** The implement handoff
parked the "nullable ordering column seeded into the PK" hazard as a *tripwire*, predicting the rebuild
"would try to store NULL into a NOT-NULL PK column and **fail**." Empirically it does **not** fail — it
**silently succeeds**. Reproduced: `create mv par_ix as select id, x from par order by x; alter par alter
column x drop not null; insert (2, null); refresh par_ix;` returns no error and materializes `x = NULL`
into a backing column still declared NOT NULL and part of the physical PK. The backing schema then lies
(says NOT NULL, holds NULL) and a NULL sits in a declared-NOT-NULL PK — a silent data-integrity violation,
reachable via plain SQL, that this fix newly exposes (before it, the sequence crashed at the loosen op and
the NULL never landed). This is not a conditional tripwire; it is a reachable-now defect, so it is a ticket,
not a `// NOTE:`. The root cause is the same ordering-seeding the covering rework is meant to remove; the
fix ticket also records that the referenced "covering ticket" is not actually filed anywhere in `tickets/`.

**MINOR — noted, not fixed.** The `// NOTE:` comments (new one at ~line 1609 and the pre-existing one at
~line 237) reference "the covering ticket that replaces ordering-seeding with a materialized index," but no
such ticket exists in the tree. Left as-is (the intended slug is unknown and it is pre-existing wording);
the new `fix/` ticket documents the dangling reference so the future rework can reconcile it.

**Tripwire — none newly recorded.** The one the implementer recorded (nullable-ordering-column-in-PK) was
promoted to the `fix/` ticket above because it is reachable-now silent corruption, not a conditional
concern.

**Cross-backend (no action).** The handoff's prediction that `53-materialized-views-rowtime.sqllogic` §16e
goes green on the lamina backend once this lands is out of scope for the memory-backed suite run here; left
for the lamina package's own validation, as the handoff stated.
