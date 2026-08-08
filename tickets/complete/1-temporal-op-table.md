---
description: Date and time arithmetic now has one shared rulebook — a single table saying which operand combinations are legal, what each produces, and what type the answer is — so the query planner and the evaluator can no longer disagree about it.
files:
  - packages/quereus/src/types/temporal-ops.ts                 # NEW — the table, the two classifiers, the shared wrapper
  - packages/quereus/src/runtime/emit/temporal-arithmetic.ts   # tryTemporalArithmetic rewritten as sniff → lookup → run
  - packages/quereus/src/planner/nodes/scalar.ts               # BinaryOpNode.generateType arithmetic arm (~line 205)
  - packages/quereus/test/types/temporal-ops.spec.ts           # NEW — unit spec over the table itself
  - packages/quereus/test/logic/107-temporal-arithmetic-mutation-kills.sqllogic
  - packages/quereus/test/runtime/scalar-op-spec.spec.ts
  - packages/quereus/test/runtime/temporal-arithmetic.spec.ts  # pre-existing behavior lock, unchanged, still green
  - docs/types.md                                              # § Temporal Types + § Implementation Files
difficulty: medium
---

# One table for temporal arithmetic — complete

## What shipped

`packages/quereus/src/types/temporal-ops.ts` (385 lines) holds the set of supported
temporal arithmetic operations as data rather than control flow: a `ReadonlyMap` keyed
`` `${operator}|${leftKind}|${rightKind}` `` over the five operand kinds
(`date`, `time`, `datetime`, `timespan`, `number`), with 20 entries, each carrying a
`resultType` and an `apply`.

Two callers read it and can no longer disagree:

- **`BinaryOpNode.generateType`** (`planner/nodes/scalar.ts`) classifies each operand by
  its *declared* logical type (`temporalKindOfType`, identity against the registered
  singletons) and announces the case's `resultType`.
- **`tryTemporalArithmetic`** (`runtime/emit/temporal-arithmetic.ts`, now ~15 lines,
  down from a ~200-line cascade) classifies each operand by the *runtime value's shape*
  (`temporalKindOfValue`) and runs the case's `apply` through `runTemporalCase`, the
  shared null-propagation / malformed-value-to-null / UNSUPPORTED-propagates envelope.

Supporting exports: `isTemporalKind`, `unsupportedTemporalOp` (the one home for the
`Unsupported temporal operation` throw), `temporalOpCaseKeys` (test-only), and the
`hasCalendarUnits` / `scaleDuration` / `divideDuration` helpers moved over from the
runtime file.

## Behavior changes

Three, all following from the announced result type finally matching the value produced.
Each is locked by a test.

1. **`select (2 * timespan('PT1H')) + 3` — was `null`, now raises `Unsupported temporal
   operation`.** The inner expression is announced TIMESPAN rather than INTEGER, so the
   outer `+` takes the temporal path and finds no TIMESPAN+INTEGER case. The old `null`
   was an artifact: the numeric fast path trusted the wrong INTEGER announcement,
   computed `'PT7200S' + 3` = `'PT7200S3'`, and failed the finite check.

2. **`select (timespan('PT2H') / timespan('PT1H')) + 1` — same answer (`3`), different
   route.** The ratio is announced REAL and takes the numeric fast path instead of
   falling through the temporal probes.

3. **Ordering sites over a *computed* difference switched from text order to semantic
   elapsed-time order.** Found during review, not in the implement handoff; see
   *Review findings* below.

## Preserved-as-found behavior, each with a `NOTE:` at its site

- **DATETIME − DATETIME drops the time of day** — `'P5D'`, not `'P5DT2H'`, because both
  sides collapse to a `PlainDate` first. `NOTE:` on `dateDifference`; already filed as
  `bug-datetime-difference-drops-time-of-day` in `tickets/backlog/`.
- **`bigint` on the number side is rejected** — `timespan('PT1H') * 9007199254740993`
  raises `Unsupported temporal operation`, because the cascade's match condition was
  literally `typeof v2 === 'number'`. `NOTE:` on `scaleTimespan`.
- **`divideDuration` truncates the sub-month remainder** — a month has no fixed day
  count, so it cannot cascade to days: `timespan('P1M') / 2` is `PT0S`. `NOTE:` on
  `divideDuration`.

## Out of scope, deliberately

- **`nullable` is still optimistic.** `timespan('PT1H') / 0` and
  `timespan('P1Y') / timespan('P1M')` both return null from non-nullable operands, so the
  announced `nullable: false` is wrong for them — exactly as `1 / 0` already is for plain
  numeric division. Excluded by the plan ticket; it is a real but pre-existing
  inaccuracy, tracked with the rest of the announcement gaps in
  `bug-inferred-scalar-type-disagrees-with-runtime-value`.
- **`emitTemporalArithmetic` is dead code and stays** — nothing calls it, and
  `tickets/implement/2-runtime-temporal-arithmetic-emit-specialization.md` names deleting
  it as part of its own work.
- **Constant folding can throw at plan time** for a statically-doomed constant expression
  (`select date('2024-01-15') + date('2024-01-16')` errors during folding rather than at
  row evaluation). Pre-existing — folding evaluates through the runtime — and unchanged
  here, but relevant to ticket 2's "why arm 2 throws at runtime, not at emit" reasoning.

## Review findings

Reviewed the implement diff (`0630634b`) before reading its handoff. Ran
`yarn docs:check`, `yarn lint` (all workspaces), `packages/quereus` `yarn lint`
(eslint + `tsc -p tsconfig.test.json --noEmit`), and root `yarn test` — **all green**
(quereus 9185 passing / 25 pending; full workspace run 8m13s, no failures).

### Checked and clean

- **Cascade-to-table equivalence.** Walked every one of the 20 cases plus the misses
  (`%` on any pair, `DATE + DATE`, `TIME − DATE`, `DATE − number`, `TIMESPAN + number`)
  against the deleted cascade. The `undefined` / throw / null-degrade outcomes match on
  every input class I could construct, including bigint operands, TEXT operands, and
  values that parse as no temporal shape.
- **Classifier probe order.** `temporalKindOfValue` reorders the four shape probes into
  an if-chain where the cascade computed all four independently. The four regexes are
  provably mutually exclusive (each is anchored, and the date/datetime/time/duration
  prefixes cannot co-match), so the reordering is unobservable. Confirmed by hand over
  each shape.
- **Commuted-case operand order.** `commuted(entry)` calls `entry.apply(v2, v1)`, so
  `TIMESPAN + DATE` parses the date before the duration where the cascade parsed the
  duration first. Only reachable when *both* values are malformed, and both orders are
  caught into `null` by the same envelope — unobservable. The implementer flagged this
  as the one place statement order was knowingly not preserved; it holds up.
- **Planner arm placement.** The new `break` exits the switch, so the collation
  resolution, `mergePropagatedCollation`, `nullable`, and `isReadOnly` computation that
  follow the switch all still run. `BOOLEAN_TYPE` is *not* `isNumeric`, so no boolean
  operand accidentally acquires the `number` kind; `TIMESTAMP_TYPE` is `isTemporal` so
  the numeric arm skips it, matching the documented exclusion.
- **Runtime dispatch reordering claim.** Confirmed in `runtime/emit/binary.ts`: the
  `temporal` / `numeric-fast` / generic split keys off `isTemporal` / `isNumeric` on the
  declared types, so changing what a temporal pair announces is exactly what re-routes
  the outer operator — the mechanism the two named behavior changes rely on.
- **Docs.** Read the whole new `docs/types.md` § Temporal Types block against the actual
  table contents; every row, every edge note, and the Implementation Files entry are
  accurate. `yarn docs:check` passes.

### Found and fixed in this pass

- **A third behavior change, undocumented and untested: semantic ordering now reaches
  computed differences.** Announcing TIMESPAN routes `date - date` to TIMESPAN's
  elapsed-time comparator at every ordering site, not just at `=`. Verified by running
  the same probe against the parent commit (`dad686e1`) in a throwaway git worktree:

  | query over `{P1D, P9D, P15D}` | before | after |
  |---|---|---|
  | `order by (a - b)` | `P15D, P1D, P9D` | `P1D, P9D, P15D` |
  | `min(a - b)` / `max(a - b)` | `P15D` / `P9D` | `P1D` / `P15D` |
  | `distinct` / `group by` output order | text order | elapsed-time order |
  | materialized view over `(a - b)`, ordered | text order | elapsed-time order |

  This is a real bug fix — `min` was returning the *longest* duration — and it was
  silently gained. The existing 107 sqllogic file locks all of this for a column
  *declared* TIMESPAN, which is why nothing caught the computed case either way. Added a
  matching section for the computed form (order by / min / max / distinct / comparison
  against a TIMESPAN literal / materialized view), plus a `docs/types.md` bullet. Each
  new expectation is a value the old announcement got wrong; verified the block actually
  asserts by flipping one expectation and watching it fail.

- **Dead branch in `divideDuration`.** `const monthRemainder = …; if (monthRemainder !==
  0) { /* comment only */ }` computed a value and did nothing with it — moved verbatim
  from the old file, and it reads as an unfinished arm rather than a decision. Replaced
  with the plain `Math.trunc` and a `NOTE:` stating the truncation and its revisit
  condition. The truncation itself had **no test coverage at all**; added two sqllogic
  locks (`timespan('P1Y2M') / 2` → `P7M`, `timespan('P1M') / 2` → `PT0S`, both values
  verified against the engine first).

- **Handoff board claim was wrong.** The implement ticket says
  `bug-datetime-difference-drops-time-of-day` "appears not to have been filed yet". It
  exists at `tickets/backlog/bug-datetime-difference-drops-time-of-day.md`, and its body
  already anticipates this refactor. No code change needed — the `NOTE:` and the
  `docs/types.md` reference were both already correct.

- **Theme ticket updated rather than a new ticket filed.**
  `tickets/backlog/bug-inferred-scalar-type-disagrees-with-runtime-value.md` owns the
  "announced type disagrees with the runtime value" class and explicitly reserved arm 3
  for this work. Marked arm 3 landed and recorded the two side effects a future worker
  needs to know (the `(2 * timespan) + 3` error, and the ordering switch above).

### Tripwires recorded (not tickets)

- `types/temporal-ops.ts`, on `key()` — the value-sniffed path allocates one key string
  per row where the cascade allocated nothing. Immaterial next to the
  `Temporal.Duration.from` parse on the same row, and ticket 2's emit specialization
  hoists the lookup out of the row loop; nest the table two levels deep only if temporal
  arithmetic shows up in a profile without that hoist.
- `types/temporal-ops.ts`, on `divideDuration` — the sub-month truncation above, with
  "revisit if a caller needs a reference-date-relative division" as the condition.
- `docs/types.md` is now **11750 words, 250 from the hard 12000-word cap** (`yarn
  docs:check`, which warns but passes). This change spent roughly 60% of the file's
  remaining headroom. Not filed: the doc-growth convention and the near-cap warning
  already exist and will fail the build before anything is lost — but the next section
  that lands in types.md should split it first.

### Considered and not acted on

- **`nullable` optimism** — out of scope by the plan ticket's instruction, and identical
  in kind to `1 / 0`'s existing inaccuracy. Already inside the scope of
  `bug-inferred-scalar-type-disagrees-with-runtime-value`; not re-filed.
- **`bigint` rejected on the `number` side** — carries an accepted-tradeoff `NOTE:` at
  `scaleTimespan` explaining it is preserved-as-found. The decision stands; not re-filed.
- **`emitTemporalArithmetic` left dead** — correct call; ticket 2 deletes it and removing
  it here would collide.
- **`isTemporalKind` returns `boolean` rather than a type predicate** — cosmetic, no
  behavior or safety value at either call site.
- **The aggregate-algebra 10s Mocha timeout** the implementer saw once under machine
  load: did not reproduce in either the 3m `packages/quereus` run or the 8m13s full
  workspace run. Nothing written to `.pre-existing-error.md`.

### No new tickets filed

Every finding either landed inline in this pass or is already claimed by an open ticket
(`bug-datetime-difference-drops-time-of-day`,
`bug-inferred-scalar-type-disagrees-with-runtime-value`,
`2-runtime-temporal-arithmetic-emit-specialization`). Nothing rose to the level of a new
`fix/`, `plan/`, or `backlog/` item.
