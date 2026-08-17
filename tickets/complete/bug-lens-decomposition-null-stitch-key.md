----
description: When a logical table is stored split across several physical tables and its shared key holds no value in a row, that row's pieces now line up on read, update and delete, and the rules the schema declares about that row are still enforced; previously reads showed the row incomplete, updates silently changed nothing, and deletes left orphans.
files:
  - packages/quereus/src/schema/lens-compiler.ts                  # read side: buildKeyEquiJoin + EavContext/buildEavSubquery route through captureKeyEquality
  - packages/quereus/src/planner/mutation/decomposition.ts        # write side: anchorKeyCorrelation feeds memberUpdateOp / memberDeleteOp / buildEavAttrOp
  - packages/quereus/src/planner/mutation/capture-correlation.ts  # the one NULL-safe equality helper + the one declared-nullability lookup (keyColumnInfo)
  - packages/quereus/src/planner/mutation/lens-enforcement.ts     # review fix: buildLogicalRowAddressPredicate — the deferred CHECK re-read's row address
  - packages/quereus/test/lens-put-fanout.spec.ts                 # round-trip, mixed-nullability, plan-shape, upsert and CHECK suites
  - docs/lens.md                                                  # § Default Mapper, § put fan-out, § Constraint Attachment, § Current Limitations
repro: verified
----

# NULL stitch-key rows round-trip through a decomposition lens — complete

## What shipped

A decomposition lens stitches one logical row across an anchor table and member tables via a
shared key. NULL is a self-equal key value in this engine (docs/schema.md § Primary-key
nullability), but the stitch correlations spelled plain SQL `=` / `IN`, which read UNKNOWN against
NULL — so a NULL-keyed logical row could be inserted but never read back whole, updated, or fully
deleted.

Every stitch correlation now routes through the single NULL-safe helper
`captureKeyEquality`, gated on **both** sides of the pair being declared nullable, so any schema
with a NOT NULL stitch key emits byte-identical AST to before (pinned by a plan-shape test):

- **read** — the get body's per-member join ON pairs and the EAV subquery's entity conjunct
  (`schema/lens-compiler.ts`);
- **write** — every member UPDATE, the predicated fan-out DELETE, and the matched EAV triple
  UPDATE/DELETE, via `anchorKeyCorrelation`, which swaps the uncorrelated `in (select …)` for a
  correlated `exists (…)` with the target aliased `__vm_self` on the nullable branch
  (`planner/mutation/decomposition.ts`);
- **constraint enforcement** — the deferred logical-row re-read that evaluates a logical CHECK at
  commit (`planner/mutation/lens-enforcement.ts`; found and fixed in this review pass, below).

The anchor's own value-column UPDATE routes through the same member path, so it was fixed too.
Left unchanged by design: upsert conflict targets (verified NULL-self-equal in this pass), the
already-NULL-safe captured read-back, composite stitch keys, non-anchor-predicate deferral.

## Review findings

**Read the implement diff (`2c6b97213`) plus the uncommitted work of the interrupted prior review
run before the handoff.** Lint clean; `yarn test` green across the workspace; the quereus package
alone: **9652 passing, 25 pending, 0 failing** (9644 at implement handoff, +8 tests added across
the two review passes).

### Major — found and fixed in this pass

- **A NULL-keyed row escaped every row-local CHECK the logical schema declares.**
  `buildLogicalRowAddressPredicate` (`planner/mutation/lens-enforcement.ts:686`) addressed the
  written row for the deferred commit-time re-read with a plain `=` against `NEW`/`OLD`, so for a
  NULL key the address matched no row, `min(verdict)` over the empty group read NULL, and every
  rule silently passed. The **fifth** site of this ticket's own class, in a file the implement diff
  never touched — and this ticket is what made it reachable: before it, the write to a NULL-keyed
  row silently did nothing, so there was no unchecked write. Repro verified (a `check (c < 100)` on
  a nullable-keyed decomposition let `update x.N set c = 500 where id is null` through while the
  same schema with a NOT NULL key aborted). Fixed at the site by routing all three legs (shared-key
  address, member-hop inner and outer) through `captureKeyEquality`, gated per **logical** key
  column's declared nullability — one question ("can this key value be NULL?"), NOT NULL keys keep
  the byte-identical plain `=`. Three tests added (NOT NULL control, NULL-keyed row on the
  `NEW`-correlated UPDATE arm, NULL-keyed row on the `OLD`-correlated member-DELETE arm);
  docs/lens.md § Constraint Attachment states the NULL-safe address.

### Filed as a new ticket

- **`backlog/bug-logical-primary-key-allows-two-null-keyed-rows`** — the commit-time set-level
  uniqueness scan (`synthesizeUniqueCountExpr`) counts with a plain `=`, so two rows with an
  entirely absent logical PRIMARY KEY are both accepted. Correct for `unique` (SQL NULL-distinct,
  and the site says so deliberately), wrong for a primary key under the engine's own
  absent-equals-absent key rule. `repro: static` — reaching it needs a logical PK mapping to no
  key on the underlying table, otherwise the underlying key rejects the duplicate first. Same
  class, different arm, different site → own ticket rather than an arm on this one.

### Verified, no defect

- **Anchor-resolvable upsert under a NULL key.** The handoff asserted, without a test, that
  `on conflict` detection is already NULL-self-equal, so the collapsed
  `insert … on conflict (<memberKey>) do update` path needed no change. True — pinned now with two
  tests (absent component materializes; present component updates rather than double-inserting).
- **`memberTables.get(pivot)!`** in the prior run's new `eavContext` — the non-null assertion is
  sound: `memberTables` is populated from `storage.members` and throws on an unresolvable member
  before that point, and pivots come from the same list. The removed defensive fallback was dead.
- **Override gap-fill path** (`compileOverrideBody`) passes no EAV context, exactly as before the
  refactor — no behavior change.
- **Self-correlation on the anchor's own UPDATE** is not a new hazard: the shared key cannot be
  assigned (`routeAssignment` rejects it), so the correlation predicate cannot be rewritten
  underneath the statement; the pre-existing `IN` form self-referenced identically.
- **Docs.** `docs/lens.md` carries the whole story (get body, put fan-out, constraint attachment,
  limitations); `docs/view-updateability.md` defers the decomposition correlation shape to it and
  needed no edit.

### Accepted tradeoffs — left alone deliberately

- **The nullability gate reads *declared* nullability.** Under
  `pragma default_column_nullability = nullable` every stitch key is declared nullable, so every
  lens read takes the disjunctive join ON, which yields no equi-pairs and falls back to
  nested-loop. Already recorded as a `NOTE:` at `buildKeyEquiJoin` and a bullet in
  docs/lens.md § Current Limitations, with the revisit condition (lens reads under that pragma
  showing up in profiles). Not re-filed — the stated condition has not tripped.
- **Commit-time `unique` is NULL-distinct.** Deliberate and documented at the site; only the
  primary-key arm is questioned, in the ticket above.

### Tripwires parked (not tickets)

- **The nullable branch's correlated EXISTS cannot be evaluated once per statement** the way the
  uncorrelated `IN` subquery could, and the anchor's own UPDATE self-correlates against the table
  it writes where the delete side sidesteps the shape with a bare predicate. Not measured. Parked
  as a `NOTE:` on `anchorKeyCorrelation` (`planner/mutation/decomposition.ts`) naming the cheaper
  shape to reach for if a nullable-stitch-key lens write ever shows up in profiles.

### Also landed in this review (from the interrupted prior pass, verified here)

- `keyColumnInfo` de-duplicated: one declared-nullability lookup in `capture-correlation.ts`,
  replacing the two divergent copies in `decomposition.ts` and `lens-compiler.ts`, so the read and
  write sides cannot drift on the gate.
- `lens-compiler.ts`'s half-supplied EAV parameters collapsed into one `EavContext` resolved by
  `eavContext`, making the no-pivot / two-pivot / no-key combinations unrepresentable.
- Tests for the gate's other arm — **mixed** nullability (nullable anchor over NOT NULL member and
  the reverse) keeps the plain `=`/`IN` forms, with the NOT NULL member's materialize failing loudly
  rather than silently dropping the write — plus the all-null-assignment member-DELETE branch under
  a nullable key. The mixed-nullability materialize boundary is documented in
  docs/lens.md § Current Limitations.

### Gaps left open (stated, not fixed)

- **`yarn test:store` not run** (agent default is the memory-backed suite). The lens substrate is
  storage-agnostic AST synthesis and the store path was not exercised for this change.
- The plan-shape test pins substrings of the stringified AST, not whole-statement equality against
  a pre-fix golden string — it proves the shape, not literal byte-identity.
- Composite stitch keys remain deferred upstream (`singleKeyColumn`); the per-column
  `captureKeyEquality` shape is in place but degenerate at one column.
- The member-hop legs of the now-NULL-safe row address are exercised only through the shared-key
  arm; a hidden **surrogate** key declared nullable (contrived — surrogates carry defaults) has no
  test.
