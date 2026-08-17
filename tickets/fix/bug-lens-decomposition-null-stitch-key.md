---
description: When a logical table is stored split across several physical tables and its shared key holds no value in a row, that row's pieces silently fail to line up — reads show the row incomplete, and writes to it quietly change nothing.
files:
  - packages/quereus/src/schema/lens-compiler.ts               # buildKeyEquiJoin (~975) — GET-body stitch join uses plain `=`
  - packages/quereus/src/planner/mutation/decomposition.ts     # anchorKeySubquery + its `in (select …)` consumers (memberUpdateOp ~1120, memberDeleteOp ~723, EAV entity-IN ~1840)
  - packages/quereus/src/planner/mutation/capture-correlation.ts  # captureKeyEquality — the shared NULL-safe per-column helper to reuse
  - packages/quereus/test/lens-put-fanout.spec.ts              # § "captured read-back over a NULLABLE anchor key" — carries the pointer note to retire
repro: verified
---

# NULL stitch-key rows don't round-trip through a decomposition lens

## Background

A primary key column may hold NULL, and key comparison treats NULL as a value equal to
itself (`docs/schema.md` § Primary-key nullability). A **decomposition lens** stores one
logical table split across an anchor table plus member tables, all sharing a stitch key
(the logical primary key). Both the read and the write paths line the pieces up by
comparing stitch-key values — and several of those comparisons still use plain SQL `=`,
which never matches NULL. The multi-source join-view analog of this class was fixed by
`bug-multi-source-view-write-misreads-null-keys` (NULL-safe correlation via the shared
`captureKeyEquality` helper); the captured-value read-back inside `decomposition.ts` was
fixed with it, but the lens substrate has its own remaining comparison sites.

## Observed behaviour (both verified on a scratch run at ticket time)

Fixture: anchor `Nc_core (id integer null primary key, a integer)` + optional member
`Nc_c (id integer null primary key, c integer null)` advertised as a columnar split on
`id`; one logical row keyed NULL with a present member component `(null, 77)`.

- **Read:** `select id, a, c from appn.N` returns `c = null` — the present `(null, 77)`
  component never joins its anchor, so the row reads as if the component were absent.
- **Write:** `update appn.N set c = coalesce(c, 0) + a` reports success and leaves
  `Nc_c` unchanged at `(null, 77)`. The matched member UPDATE's
  `where id in (select id from Nc_core …)` never matches the NULL member key
  (`NULL IN (…)` is UNKNOWN), and the fallback materialize INSERT then hits the existing
  NULL-keyed row's primary key (NULL is self-equal for PK uniqueness) and its
  `on conflict do nothing` swallows the write — a silent no-op either way.

## Root cause

One rule violated at several sites: stitch-key correlation must treat NULL as a
self-equal key value, per column, exactly as `captureKeyEquality`
(`planner/mutation/capture-correlation.ts`) now encodes for the multi-source path.

- `buildKeyEquiJoin` (`src/schema/lens-compiler.ts` ~975) emits the GET body's
  anchor⋈member ON condition with plain `=` — the read-side site, and also the substrate
  the write path's captured-value snapshot reads through (so even a NULL-safe write
  correlation captures the null-extended image of a row whose component exists).
- `decomposition.ts` correlates member ops to the anchor with
  `<memberKey> in (select <anchorKey> from <anchor> where <pred>)`
  (`anchorKeySubquery`, consumed by `memberUpdateOp`, `memberDeleteOp`, and the EAV
  entity-column IN) — `NULL IN (…)` is never true, so a NULL-keyed member row is
  unreachable by update and survives a fan-out delete as an orphan.

The upsert-shaped paths (`on conflict (<memberKey>) do …`) are NOT affected — PK
conflict detection already treats NULL as self-equal.

## Notes for the fix

- The IN-shape likely wants rewriting as a correlated EXISTS with per-column
  `captureKeyEquality` conjuncts (the multi-source path's shape), gated on the key
  column's declared nullability so NOT NULL keys keep the index-friendly plain form.
- The GET-body join needs the same per-column NULL-safe condition in
  `buildKeyEquiJoin`; watch equi-pair extraction — a disjunctive ON condition no longer
  yields equi-pairs, which may cost the synthesized join its key-coverage facts. Measure
  before accepting; gating on declared nullability confines any plan regression to
  schemas that actually declare a nullable stitch key.
- `test/lens-put-fanout.spec.ts` § "captured read-back over a NULLABLE anchor key"
  documents this hole in a comment naming this ticket — retire the note and assert the
  logical read-through once fixed.
- Expected behaviour after the fix, for the fixture above: the read returns
  `{id: null, a: 10, c: 77}`; the update stores `c = 87` on the existing member row.
