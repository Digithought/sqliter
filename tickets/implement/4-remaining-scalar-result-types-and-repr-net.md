---
description: Finish making the data type the engine reports for each result column agree with the kind of value that column actually produces, then turn on a permanent check so the two can never drift apart again.
prereq: positional-param-type-hint-key, binary-op-result-types-match-runtime
files:
  - packages/quereus/src/planner/nodes/scalar.ts            # LiteralNode.getType (number ⇒ REAL), CaseExprNode type merge
  - packages/quereus/src/common/type-inference.ts           # inferLogicalTypeFromValue — the correct value⇒type mapping to reuse
  - packages/quereus/src/func/builtins/aggregate.ts         # sumFunc returnType REAL_RETURN
  - packages/quereus/src/planner/scopes/param.ts            # DEFAULT_PARAMETER_TYPE (TEXT)
  - packages/quereus/src/planner/analysis/set-op-type-merge.ts  # the merge rules to reuse for CASE / LAG / LEAD
  - packages/quereus/src/core/statement.ts                  # _iterateWithSignal — NO_DECLARED_TYPES, the seam to widen
  - packages/quereus/src/runtime/strict-representation.ts   # assertRowConforms — the checker
  - packages/quereus/test/planner/                          # window-function type tests
  - docs/types.md                                           # § Physical representation — the rule this makes enforceable
difficulty: hard
---

# Goal

A prepared statement announces a data type for every result column, reachable by an embedder
through `Statement.getColumnType()` / `getColumnDefs()`. For a plain column reference that
type is the column's declared type and is right. For a computed column it is a planning-time
inference, and in several places the inference names a type the column's values do not
inhabit — so a driver, UI grid, or serializer that switches on the announced type handles
those columns under the wrong branch.

This ticket closes the remaining inaccuracies and then installs the guard that keeps them
closed: widening the statement-egress representation check from rule R1 only to full R2.

Two sibling tickets carry the rest of the theme and land first:
`positional-param-type-hint-key` (an untyped `?` whose hint is computed and dropped) and
`binary-op-result-types-match-runtime` (comparison / `LIKE` / `XOR` / mixed-type arithmetic).
Assume both have landed.

# How the work list was measured

The statement-egress check in `Statement._iterateWithSignal` currently passes
`NO_DECLARED_TYPES`, which puts every cell on `assertRowConforms`'s untyped path — R1 only.
Temporarily passing `this.columnDefCache.value.map(col => col.type.logicalType)` instead and
running the suite with `QUEREUS_REPR_STRICT=1` and mocha's `--no-bail` turns every
announcement/value disagreement into a test failure:

```
QUEREUS_REPR_STRICT=1 node --import ./packages/quereus/register.mjs \
  node_modules/mocha/bin/mocha.js "packages/quereus/test/**/*.spec.ts" \
  --no-bail --timeout 20000 --reporter min 2>&1 | tee /tmp/repr.log
```

Measured at commit `61637588`: **9364 passing, 33 representation violations.** By reported
shape: 19 × `TEXT ← number`, 6 × `REAL ← bigint`, 4 × `TEXT ← boolean`, 2 × `INTEGER ←
boolean`, 1 × `TEXT ← array`, 1 × `BLOB ← boolean`. Re-run this after the two prereq tickets
land — they account for a large share — and work the residue.

Note the temporary widening must not read `process.env` inline: the cross-platform suite
(`test/cross-platform/`) asserts that every `process` access is `typeof`-guarded and will
fail loudly if you gate the measurement on an env var naively.

# Arms

Each is a distinct site. Verified announcements are marked; the rest were identified from the
measurement run and should be confirmed before being changed.

## A. An integer literal is announced REAL — *verified*

`LiteralNode.getType()` maps every JS `number` to `REAL_TYPE`. `select 1 as v` announces REAL
and yields the integer `1`.

This is not merely imprecise, it propagates: `BinaryOpNode.generateType`'s numeric promotion
reads "either side is REAL ⇒ REAL", so `select 9007199254740993 + 1` announces REAL (bigint
literal INTEGER + number literal REAL) while producing a `bigint`. Three of the six
`REAL ← bigint` violations are this. Fixing the literal makes it INTEGER + INTEGER ⇒ INTEGER,
which admits `bigint`.

`common/type-inference.ts` already has the correct mapping (`inferLogicalTypeFromValue`:
integer number ⇒ INTEGER, non-integer ⇒ REAL, `bigint` ⇒ INTEGER, boolean ⇒ BOOLEAN,
`Uint8Array` ⇒ BLOB, object ⇒ JSON). `LiteralNode.getType` open-codes a second, divergent copy
of the same mapping. Route the literal through the shared function and delete the copy.

Watch the DML write path: an integer literal into an INTEGER column becomes an identity match
and is skipped where it used to convert. That is correct (the value is already an integer) and
is additionally guarded by `dml-write-coercion-representation-guard`, but check it.

## B. `sum()` is announced REAL but can return a `bigint` — *verified*

`sumFunc` declares `returnType: REAL_RETURN`. `sum()` over integers past 2^53 returns a
`bigint`. REAL's value space is `number` only.

NUMERIC is the type whose value space is `number | bigint` — it shares REAL's `physicalType`
and is admitted a `bigint` by name (see the NOTE on `NUMERIC_TYPE` in `types/builtin-types.ts`
and `conformsToType` in `runtime/strict-representation.ts`). Announce NUMERIC.

Prefer an `inferReturnType` that narrows: `sum()` over a REAL argument really does return a
`number`, and announcing NUMERIC unconditionally loses that. Check what the exactness split in
`SumAccumulator` (`exact` vs `approx`) can actually promise from the argument's static type
before deciding. `avg()` and `total()` should get the same audit while you are here.

Three `REAL ← bigint` violations are this arm.

## C. CASE with differing arm types is announced TEXT — *verified*

`select case when 0 then 'x' else 300 end` announces TEXT and yields the number `300`. The
current rule appears to be "arms differ ⇒ TEXT" (referenced by the comment in
`planner/analysis/set-op-type-merge.ts`).

A CASE expression is exactly the same shape of problem a set operation's output column is —
one column carrying values from several branches, none of which will be converted — and
`mergeSetOpAdvertisedType` already encodes the answer: identical types keep theirs, NULL
yields to the other side, differing builtin numerics merge to NUMERIC, an irreconcilable pair
is ANY. Reuse it (folded across all arms including ELSE) rather than writing a third merge.

Four violations are this arm (`test/case-short-circuit.spec.ts` ×2,
`test/runtime/scalar-fusion.spec.ts` "CASE with a subquery branch",
`test/logic/21-null-edge-cases.sqllogic`).

## D. `LAG` / `LEAD` announce the value argument's type, ignoring the default

`test/planner/` has a test literally named "LAG/LEAD with a differing-type default types as
the value argument", and it produces a `number` from a TEXT-announced column when the default
fires. The same merge as arm C applies: fold the value argument's type with the default
argument's type. Confirm which node computes the window-function return type before editing —
the file list points at `planner/nodes/function.ts` as the likely site.

## E. An untyped `?` defaults to TEXT

`DEFAULT_PARAMETER_TYPE` in `planner/scopes/param.ts` is TEXT. After
`positional-param-type-hint-key` lands, a `?` that *was* bound gets a real hint; a `?` with no
binding at plan time still has no correct concrete answer by construction, and TEXT is an
arbitrary guess. `ANY` is the honest announcement — no R2 constraint, pass-through `parse`,
and never identical to a declared column type, so consumers convert.

Do this arm **after** the prereq lands and after re-measuring, so its effect can be seen in
isolation. It is the riskiest arm: an `ANY`-typed parameter changes comparison coercion,
collation resolution, and index-seek eligibility for every unbound-at-plan-time `?` in the
suite. If it turns out to cascade badly, land the rest of this ticket without it and hand the
remainder off with what you found — say so explicitly rather than leaving it silently
half-done.

## F. Table-valued function columns declare types their rows do not inhabit

`test/logic/03.5-tvf.sqllogic` and `test/logic/94-tvf-edge-cases.sqllogic` both report
`column 0 (key): declared type TEXT ... the value is a JS number (0)`. A TVF's column types
are *declared*, not inferred, so this is a declaration that does not match what the function
emits (a JSON-walking TVF's `key` is a string for object members and a number for array
indices). Either widen the declared type to `ANY` or make the emitted values conform. Find the
TVF first — it was not pinned during triage.

## G. Residue

One `BLOB ← boolean` in `test/logic/03.6.2-value-to-text.sqllogic` and one
`TEXT ← number` in `test/planner/` key-propagation ("eliminated ORDER BY / DISTINCT over
single-row VALUES", column `column_0`) were not traced to a site. The nearby statements
probed in isolation announce correctly, so the violating line is elsewhere in each file — find
it from the measurement run before assuming a cause.

## H. Install the net

Once the arms are clear, change `Statement._iterateWithSignal` to pass the plan's real output
types instead of `NO_DECLARED_TYPES`, so `QUEREUS_REPR_STRICT=1` enforces R2 at statement
egress permanently. Delete `NO_DECLARED_TYPES` if it has no other user, and rewrite the long
comment above the seam — it currently explains at length why R2 is *not* asserted there and
cites three examples (`select ? as v` inferring TEXT, a comparison inferring TEXT, `sum(v)`
inferring REAL) that this ticket removes.

That comment also points at `backlog/bug-inferred-scalar-type-disagrees-with-runtime-value`,
a path that no longer exists (the ticket moved to `fix/` and was split into this one and its
siblings). Fix or drop the reference.

# Not in scope — the one violation an announcement cannot fix

`select min(val)` over a TEXT column holding `'10'`, `'20'`, `'hello'` returns the JS
**number** `10`, not the string `'10'`. That is a wrong *value*, not a wrong announcement:
announcing TEXT there is correct and the runtime is what is broken. The cause is
`coerceAggregateValue` in `src/util/coercion.ts`, which converts a numeric-looking string
before every aggregate that is not `count` / `group_concat` / `json_*` — including `min` and
`max`.

Already tracked as `backlog/bug-text-coercion-in-arithmetic-and-aggregates` (arm B); the
evidence and the fact that it gates this ticket have been appended there. Do **not** "fix" it
by weakening `min`'s announced type. `test/logic/25-aggregate-edge-cases.sqllogic:64` will
keep reporting a representation violation once arm H widens the egress check, so that arm is
gated on the backlog ticket being promoted and landed. If it has not landed when you get
here, do everything else in this ticket, leave arm H undone, and say so explicitly in the
handoff rather than skipping or loosening the sqllogic assertion.

# TODO

## Phase 1 — re-measure

- [ ] Re-run the measurement above after the two prereq tickets have landed; record the
      surviving violation count and list.

## Phase 2 — arms

- [ ] A: route `LiteralNode.getType`'s value⇒type mapping through
      `inferLogicalTypeFromValue`; delete the divergent copy.
- [ ] B: give `sum()` (and audit `avg()` / `total()`) a return type whose value space admits
      what it can actually return.
- [ ] C: replace CASE's "arms differ ⇒ TEXT" rule with the set-op merge, folded across all
      arms and ELSE.
- [ ] D: fold the default argument's type into `LAG` / `LEAD`'s announced type.
- [ ] F: reconcile the TVF `key` column's declared type with the values it emits.
- [ ] G: trace the two unattributed violations and fix or document them.
- [ ] E (last, and only after re-measuring): change `DEFAULT_PARAMETER_TYPE` to `ANY`.

## Phase 3 — net and docs

- [ ] H: widen the statement-egress check to the plan's real output types; rewrite the
      obsolete comment and the stale ticket path.
- [ ] Add explicit announced-type assertions for each arm so a regression fails as a type
      assertion, not only under the strict flag.
- [ ] Update `docs/types.md` § Physical representation to state that a result column's
      announced type is now subject to R2, and what `ANY` means as an announcement.
- [ ] Run `yarn test`, `yarn test:store`, `yarn test:repr-strict`, `yarn lint`,
      `yarn typecheck`.
