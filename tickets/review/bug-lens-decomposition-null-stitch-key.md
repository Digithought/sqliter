---
description: When a logical table is stored split across several physical tables and its shared key holds NULL in a row, that row's pieces now line up on read, update, and delete; previously reads showed the row incomplete, updates silently changed nothing, and deletes left orphans.
files:
  - packages/quereus/src/schema/lens-compiler.ts               # read side: buildKeyEquiJoin + buildEavSubquery now route through captureKeyEquality; columnNullable helper; eavAnchor carries keyNullable
  - packages/quereus/src/planner/mutation/decomposition.ts     # write side: new anchorKeyCorrelation beside anchorKeySubquery; memberUpdateOp / memberDeleteOp / buildEavAttrOp route through it
  - packages/quereus/src/planner/mutation/capture-correlation.ts  # doc comment widened to name the lens stitch-join uses (no behavior change)
  - packages/quereus/test/lens-put-fanout.spec.ts              # fixtures hoisted; 4 new suites at end of file; existing NULLABLE-anchor-key test now asserts logical read-through
  - docs/lens.md                                               # § Default Mapper, § put fan-out DELETE bullet, § Current Limitations
repro: verified
---

# NULL stitch-key rows round-trip through a decomposition lens — implemented

## What was wrong (one rule, four sites)

A decomposition lens stitches one logical row across an anchor table and member
tables via a shared key. NULL is a self-equal key value in this engine
(docs/schema.md § Primary-key nullability), but all four stitch-correlation sites
spelled plain SQL `=` / `IN`, which read UNKNOWN against NULL — so a NULL-keyed
logical row could be *inserted* but never read back whole, updated, or fully
deleted. Verified at HEAD (`c6d8e5301`) per the originating fix ticket's fixtures.

## What changed

Everything routes through the one existing NULL-safe per-column helper,
`captureKeyEquality` (`planner/mutation/capture-correlation.ts`), gated on **both**
sides of the pair being declared nullable — so any schema with a NOT NULL stitch
key on either side emits byte-identical AST to before (pinned by test, see below).

**Read side (`schema/lens-compiler.ts`):**
- `buildKeyEquiJoin` now takes the anchor and member `TableSchema`s and emits
  `captureKeyEquality` per positional key pair. Empty-key (`1 = 1`) branch untouched.
  Carries the accepted-tradeoff `NOTE:` about `pragma default_column_nullability =
  nullable` (see *Accepted tradeoff* below).
- `eavAnchor` (built in `compileDecompositionBody`) widened with `keyNullable`;
  `buildEavSubquery` gains a `pivotTable` param and emits the NULL-safe form for the
  entity conjunct when both entity column and anchor key are nullable. The attribute
  conjunct (non-null literal) stays plain `=`.
- New `columnNullable(table, name)` helper; unknown column (defensive) reads as
  nullable, matching `keyColumnInfo`'s convention.

**Write side (`planner/mutation/decomposition.ts`):**
- New `anchorKeyCorrelation(ctx, shape, member, memberCol, pred)` beside
  `anchorKeySubquery`: returns the legacy `<memberCol> in (select <anchorKey> …)`
  when the gate is off, or the NULL-safe correlated
  `exists (select 1 from <anchor> where [<pred> and] (<anchorKey> = __vm_self.<memberCol> or (both is null)))`
  plus `targetAlias: '__vm_self'` (`SELF_ALIAS`, reused from `single-source.ts`)
  when both stitch columns are nullable. The alias is stamped on the emitted
  UPDATE/DELETE only on the EXISTS branch (it resolves through the existing
  `stmt.alias` → `AliasedScope` mechanism in `building/update.ts` / `delete.ts`).
- Routed through it: `memberUpdateOp` (all UPDATE flavors — constant, self,
  captured — pass through here), `memberDeleteOp` (predicated fan-out delete; the
  no-predicate truncate is unchanged), and `buildEavAttrOp` (matched EAV triple
  UPDATE/DELETE, correlated on the pivot's entity column).

**Not changed (by design, per the fix ticket):** upsert conflict targets (PK
conflict detection already NULL-self-equal), the already-NULL-safe captured
read-back (`capturedValueSubquery` / `keyColumnInfo`), composite-key deferral,
non-anchor-predicate deferral, the absence of an `IS NOT DISTINCT FROM` operator.

## Extra defect fixed beyond the ticket's table

The **anchor's own value-column UPDATE** (`update x.N set a = a + 1`) also routes
through `memberUpdateOp` (the anchor is a mandatory member of its own fan-out), so
it too silently missed NULL-keyed rows at HEAD. Same fix covers it; the columnar
round-trip test asserts it.

## Accepted tradeoff (reviewer: record in findings, do not re-file)

The gate reads **declared** nullability. Under `pragma
default_column_nullability = nullable` every stitch key is declared nullable, so
every decomposition get body takes the disjunctive ON — no equi-pairs
(`equi-pair-extractor.ts`), nested-loop join, coverage proofs lost — on every
lens read. Accepted per the fix ticket's recommendation (reachable-nullability
analysis would be a much larger change): recorded as a `NOTE:` at
`buildKeyEquiJoin` and a bullet in docs/lens.md § Current Limitations, revisit
condition = lens reads under that pragma showing up in profiles.

## Validation performed

- `yarn workspace @quereus/quereus test`: **9644 passing, 0 failing, 25 pending**
  (lens-put-fanout.spec.ts alone: 125 passing, up from the 120 baseline).
- `yarn lint`: clean (eslint + tsc over test files included).
- New coverage in `test/lens-put-fanout.spec.ts` (end of file):
  - *NULL stitch-key round-trip (columnar split)* — insert through the lens →
    select whole → anchor-column update → keyed constant update → captured
    computed update → keyed delete (no orphan) → full delete (both members empty),
    with a non-NULL control row throughout.
  - *NULL stitch-key round-trip (EAV pivot)* — same generalized sequence over
    triples, including the captured (`p = coalesce(p, 0) + a`) EAV arm.
  - *NULL stitch key under a surrogate shared key* — distinctly-spelled nullable
    anchor/member key columns (`sid` / `meta_sid`): read pairing, matched update,
    materialize threading, keyed delete.
  - *stitch correlation: plan shape* — same advertisement deployed over NOT NULL
    vs nullable tables; asserts via `astToString` that NOT NULL keeps the plain
    `=` join ON and alias-free `in (select` (the byte-identical claim), and that
    nullable takes the `is null` disjunction and `exists (select` + `__vm_self`.
  - The pre-existing *captured read-back over a NULLABLE anchor key* test's
    pointer note to this ticket is retired; it now also asserts the logical
    read-through.

## Known gaps / reviewer starting points

- **Mixed nullability untested.** The gate's "NOT NULL on *either* side → plain
  IN/`=`" arm is only exercised with both sides NOT NULL. A schema with a nullable
  anchor key but NOT NULL member key (or vice versa) — where the plain form is
  intentionally kept because a NULL-keyed row on the nullable side is a genuine
  orphan — has no test.
- **All-null-assignment delete under a nullable key with a predicate**
  (`update x.N set c = null where id is null` → member DELETE branch) is not
  directly asserted; the keyed DELETE and full-truncate paths are.
- **`yarn test:store` not run** (agent default is the memory-backed suite); the
  lens substrate is storage-agnostic AST synthesis, but the store path was not
  exercised here.
- The plan-shape test pins substrings of the stringified AST, not literal
  whole-statement equality against a pre-fix golden string.
- `buildEavSubquery`'s `pivotTable`-absent fallback (reads entity as nullable) is
  defensively reachable only if a future caller builds an EAV subquery without
  threading member tables; today the sole call chain always threads it.
- Composite stitch keys remain deferred upstream (`singleKeyColumn`); the
  per-column `captureKeyEquality` shape is in place but degenerate at one column.
