---
description: The nullif, greatest, and least functions now compare values the same way the rest of the engine does — honoring case-insensitive collations, duration columns, and JSON documents — instead of comparing raw bytes.
files:
  - packages/quereus/src/planner/building/coercion.ts          # shared plan-build coercion + coerceComparisonGroup
  - packages/quereus/src/planner/building/expression.ts        # re-pointed at coercion.ts
  - packages/quereus/src/planner/building/function-call.ts     # applies coerceComparisonGroup before inferReturnType
  - packages/quereus/src/schema/function.ts                    # BaseFunctionSchema.comparesArgs declaration
  - packages/quereus/src/func/registration.ts                  # comparesArgs passthrough
  - packages/quereus/src/planner/analysis/comparison-collation.ts  # resolveGroupCollation / effectiveGroupCollation
  - packages/quereus/src/runtime/emit/operand-comparator.ts    # makeGroupComparator (N-ary routing) + makeOperandComparator
  - packages/quereus/src/func/builtins/scalar.ts               # emitNullif + emitExtremum
  - packages/quereus/test/planner/comparison-collation.spec.ts
  - packages/quereus/test/logic/06.4.2-collation-extras.sqllogic
  - packages/quereus/test/logic/15.1-semantic-ordering.sqllogic
  - packages/quereus/test/logic/24-builtin-branches.sqllogic
  - docs/types.md, docs/functions.md, docs/sql-functions.md
---

# Complete: `nullif` / `greatest` / `least` comparison seam

## What shipped

Before this work, all three builtins compared with bare `compareSqlValues` —
storage class plus byte-for-byte BINARY text — so they disagreed with the `=`
operator on case-insensitive (`NOCASE`) and whitespace-trimming (`RTRIM`)
columns, on duration (`TIMESPAN`) columns, and on JSON columns compared against
a text literal. Now all three route through the engine's existing comparison
machinery:

- **A schema declaration names the comparison group.** `BaseFunctionSchema.comparesArgs`
  records which argument positions a function compares against one another —
  `[0, 1]` for `nullif`, `'all'` for `greatest`/`least`. At plan-build time
  `coerceComparisonGroup` applies the same JSON coercion `=`, `IN` and simple
  `CASE` apply, so `nullif(json_col, '<text>')` compares JSON against JSON.

- **One collation resolves per call site,** through the same provenance lattice
  `=` uses (explicit `COLLATE` beats a column's declared collation beats
  defaults beats BINARY). `resolveGroupCollation` is the N-operand entry point,
  built on the existing merge so it reduces exactly to the two-operand form.

- **One comparator binds per call site, never per row.** `makeGroupComparator`
  in `runtime/emit/operand-comparator.ts` is now the single home of the routing
  rule (same declared type with semantic ordering → that type's compare; all one
  category and nothing temporal → storage class + collation; otherwise a runtime
  duration check first). `makeOperandComparator` — what `=`, BETWEEN and simple
  CASE use — is its two-operand case, so none of these constructs can drift
  apart.

- **A shared coercion module.** The plan-build coercion helpers moved out of
  `planner/building/expression.ts` (where they were private) into
  `planner/building/coercion.ts`, and `=`, IN, BETWEEN and simple CASE now call
  the same copy.

New error surface: an explicit-`COLLATE` conflict inside one of these calls
(`nullif(a collate nocase, b collate rtrim)`), or two differently-collated
columns as operands, now raises the same error `=` raises for the same pair
instead of silently comparing under BINARY.

## Review findings

### Correctness — one defect found and fixed

**`greatest`/`least` ranked mixed-type groups by text, not by meaning.** The
implementation only engaged semantic ordering when *every* argument declared the
same type. A duration column compared against a plain text literal — the most
natural way anyone writes this — fell back to text ordering and returned the
wrong answer:

```sql
-- before the fix, with d = 'PT2H' (two hours):
select greatest(d, 'PT30M');  -- 'PT30M'   <- the SMALLER duration
select least(d, 'PT30M');     -- 'PT2H'
select nullif(d, 'PT120M');   -- correct: matches, because nullif compares pairwise
select d > 'PT30M';           -- correct: true
```

So the ticket's own goal — these builtins agreeing with `=` — was met for
`nullif` but not for `greatest`/`least`, and the two builtins disagreed with
each other on identical operands. Verified by running the queries against a
live database before and after.

Fixed by generalizing the routing rule rather than duplicating it: the pairwise
`makeOperandComparator` and the new N-ary `makeGroupComparator` are the same
function, so a future change cannot make the two-operand and N-operand paths
disagree. For two operands the behavior is byte-identical to before, which the
existing BETWEEN / `=` / simple-CASE suites confirm.

Side effect of the same change: a group of untyped/`ANY` operands now also takes
the generic path, matching what `=` already does for the same pair — a small
increase in agreement, not a behavior the tests previously pinned.

### Correctness — checked and clean

- **NULL through every new comparator route.** The claim that NULL handling is
  unchanged holds: the typed comparator, the storage-class comparator and the
  duration check each rank NULL first and never mis-parse it. Traced through all
  three routes and pinned with tests rather than taking it on faith.
- **The emitters skip the default emitter's `createValidatedInstruction`
  wrapper.** Read it — it is a pass-through that does nothing (validation was
  hoisted elsewhere), so nothing is lost.
- **The three retained BINARY `implementation` bodies are unreachable** — a
  custom emitter always replaces the default emitter, and `implementation` has
  no other caller in the repo. They are harmless documentation of the fallback,
  matching the pattern used by other custom-emitted builtins. Left as-is.
- **The in-place mutation contract of `coerceComparisonGroup`** (it replaces
  members of the caller's argument array) — the only caller passes a freshly
  built local array, so the mutation cannot escape.

### Major — one new ticket filed

**`tickets/backlog/bug-least-null-handling-order-dependent`.** `least`'s NULL
handling is order-dependent and disagrees with `greatest`: a NULL argument wipes
the running minimum, so `least(1, null, 3)` returns `3` and `least(3, null, 1)`
returns `1`, while `greatest` skips NULLs entirely. This is long-standing
behavior that the implementation deliberately preserved (correctly — it is a
behavioral decision, not part of the comparison work), but it is wrong under any
of the candidate semantics, so it needed a ticket rather than a shrug. The
current answers are now pinned by tests so any change is a deliberate edit.

### Test coverage — gaps found and filled

The implementation's tests covered the happy path well (collated columns,
explicit `COLLATE`, both conflict errors, TIMESPAN and JSON columns, negative
controls) but left three behaviors asserted only in prose:

- **Mixed-type `greatest`/`least` groups** — added, and they are what caught the
  defect above.
- **NULL arguments to all three builtins under the new comparators**, including
  the `least` order-dependence and `nullif(x, null)` in both orientations.
- **The flipped JSON orientation** `nullif('<text>', json_col)`, which returns
  the *parsed* document rather than the original text spelling. This is a real
  user-visible change the handoff flagged but never asserted; now pinned.

Also added `greatest`/`least` over a JSON group, which had no coverage at all.

### Documentation

Treated as stale until read. Findings:

- `docs/types.md` was correctly updated by the implementation; extended here for
  the mixed-group behavior and the `least` NULL wrinkle.
- `docs/functions.md` and `docs/sql-functions.md` — the two user-facing function
  references — still described these functions as plain "SQL comparison" with no
  hint that collation or type now applies, and said nothing about NULL handling.
  Both updated.
- While reading `docs/sql-functions.md`, found an unrelated pre-existing error:
  it documents `choose(index, ...)` as 0-based when the implementation and the
  other reference doc are 1-based. One-word fix, corrected in place rather than
  filed.

### Tripwires — conditional concerns parked, not filed

- **The collation-conflict error is raised at emit time, not plan-build time.**
  Fine today: every call, even a fully constant one, is emitted so the constant
  folder can evaluate it, so the error still surfaces from `db.prepare`. It only
  becomes a problem *if* an optimizer rule ever rewrites one of these calls away
  before emit. Recorded as a `NOTE:` comment on `emitNullif` in
  `func/builtins/scalar.ts`, pointing at the identical note already on simple
  CASE in `runtime/emit/case.ts`, with the remedy (move resolution into
  `generateType`).

### Code quality — checked, nothing to report

Read every changed file for the usual aspects. Functions are short and
single-purpose; the largest new file is 165 lines; no `any`, no swallowed
exceptions, no per-row allocation (comparators and collations resolve once at
emit). The one API-shape nit found was a doc comment on `comparesArgs` claiming
it drives the emit-time comparator binding — it does not; the emitters name
their own groups. Reworded so the next reader does not assume a coupling that
is not there.

### Deliberately unchanged

- **Numeric ↔ textual coercion still does not apply** at these sites
  (`nullif(int_col, '1')` remains a storage-class mismatch), matching IN and
  simple CASE. Out of scope here, tracked by
  `bug-numeric-text-coercion-skips-in-and-case`.
- **Which raw value `greatest`/`least` return for comparator-equal operands**
  ('a' vs 'A' under NOCASE, 'PT1H' vs 'PT60M') stays unspecified — the same
  latitude the min/max aggregate, DISTINCT and GROUP BY take. No test pins it.

## Validation

- `yarn workspace @quereus/quereus run test` — 7434 passing, 0 failing, 13
  pending.
- Root `yarn test` (all workspaces) — green.
- `yarn workspace @quereus/quereus run lint` — clean (eslint + test-file
  typecheck).
- The mixed-group defect and its fix were both confirmed by executing the
  queries against a live database, not only by reasoning about the code.
