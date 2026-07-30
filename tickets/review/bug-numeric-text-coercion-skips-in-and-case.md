description: Comparing a number against a quoted number now gives the same answer whichever way it is written (IN, CASE, subquery IN, etc.); this stage adds the regression tests that pin that contract, replacing the ones that used to pin the old wrong answers.
files:
  - packages/quereus/src/planner/building/coercion.ts                        # coerceComparisonSet — the fix, unchanged this stage
  - packages/quereus/src/planner/building/expression.ts                      # IN value-list + simple-CASE build arms — unchanged this stage
  - packages/quereus/src/planner/rules/subquery/rule-subquery-decorrelation.ts  # both IN decorrelation arms — unchanged this stage
  - packages/quereus/src/runtime/emit/subquery.ts                            # inMembershipKeys arm 1b — unchanged this stage
  - packages/quereus/test/logic/03.6.1-numeric-text-comparison-coercion.sqllogic  # NEW — the agreement-contract fixture
  - packages/quereus/test/plan/subquery-decorrelation.spec.ts                # NEW describe block — cross-type coercion in IN decorrelation
  - packages/quereus/test/plan/cast-seek-blocking.spec.ts                    # NEW describe block — IN value-list cast foldability
difficulty: easy
---

# Numeric ↔ textual coercion now agrees across every comparison form — tests added, ready for review

## What landed in `implement`

The fix itself was already applied to the working tree before this stage (see prior
commit `ticket(fix): bug-numeric-text-coercion-skips-in-and-case` and the ticket's own
"State of the work" section, preserved below). This stage's job was purely to add the
regression coverage the fix ticket flagged as missing. **No production code changed
in this pass** — only test files (one new `.sqllogic` fixture, two new `describe`
blocks in existing plan-shape specs).

### New test coverage

**`test/logic/03.6.1-numeric-text-comparison-coercion.sqllogic`** (new file, slotted
between `03.6-type-system` and `03.7-bigint-mixed-arithmetic`):

- Agreement matrix over an INTEGER column (`i=1`), a REAL column (`r=2.5`), and a
  TEXT column (`t='1'`) against the opposite-category literal, across `=`, `BETWEEN`,
  `IN` value list, `IN` subquery, simple `CASE`, `nullif`, `greatest` (and `least` as
  an unchanged control).
- The existing INTEGER-target truncation semantics of `=` (`i = '1.9'` is true for
  `i=1`) pinned across `=`, `IN`, and `CASE` — pre-existing behavior, not introduced
  by this fix, but now uniform across forms.
- Negative controls: a non-numeric textual value (`i in ('abc')` → false), `IN` with
  a NULL member (→ NULL, not false), `NOT IN`, and the mixed-WHEN simple `CASE`
  (`case i when 'abc' when '1'`, which takes the per-value path and works).
- **The one deliberately-left gap**, pinned rather than silently absent: a TEXTUAL
  probe against an `IN` list mixing numeric and textual values. Section 5 sets up
  `nc_mix(s text)` holding `'0'` and `'1'` and shows `s in (1, 'abc')` stays `false`
  for both stored rows, while `s = 1 or s = 'abc'` (the equivalent disjunction)
  agrees for `'0'` (both false) but disagrees for `'1'` (`true`, because the
  pairwise `=` reconciles the operand while `IN`'s hoisted-probe cast declines over
  the mixed list). The fixture's prose calls this out explicitly as a known,
  intentional divergence — not a typo — so nobody "fixes" it back to a wrong answer
  by making the two rows agree.

**`test/plan/subquery-decorrelation.spec.ts`** — new describe block `cross-type
coercion in IN decorrelation`:

- Uncorrelated INTEGER-vs-TEXT `IN` subquery: confirms the InNode is retained (no
  semi join), i.e. `coerceComparisonSet`'s cast wrapper fails
  `extractUncorrelatedIn`'s own equi-pair gate and the conjunct correctly falls back
  to the runtime set-probe path — and that the set probe gives the right answer.
- Correlated INTEGER-vs-TEXT `IN` subquery: confirms the correlated arm, unlike the
  uncorrelated one, still builds exactly one semi join (no gate to decline at this
  stage), with a `CAST(... AS INTEGER)` node surviving somewhere in the join's
  condition tree (the residual — it fails the equi-pair extraction so it can't be
  the hash/merge key, but it must still be evaluated) — and that the join produces
  the correct row.

**`test/plan/cast-seek-blocking.spec.ts`** — new describe block `IN value list`:

- Numeric probe (`INTEGER PRIMARY KEY`) against textual `IN`-list values
  (`x IN ('1','2')`): confirms the per-value casts are constant-foldable and the
  folder collapses them to plain literals *before* access-path selection runs, so
  the index seek survives (`INDEXSEEK` present, no residual `FILTER`).
- Textual probe (`TEXT PRIMARY KEY`) against numeric `IN`-list values
  (`x IN (1,2)`): confirms the hoisted probe cast blocks the seek, the same way
  `x = 1` already does in the sibling test right above it in the same file.

### Docs

Re-read `docs/types.md` § "Type Coercion in Comparisons", `docs/runtime.md`
(Comparison Context section), `docs/functions.md` (nullif/greatest/least
paragraph), and `docs/optimizer-rules.md` (`ruleSubqueryDecorrelation` entry)
against the final code. **All four already matched** — they were updated correctly
in the prior `implement` pass alongside the fix itself. No doc changes made in this
pass.

## Known gaps / things a reviewer should look at

- **No production code was touched this stage.** If the reviewer wants independent
  confirmation the fix itself (`coerceComparisonSet`, the two gates, the three call
  sites) is correct — not just that the new tests pass against the code as
  written — that reasoning lives in the fix ticket's "What the fix does" section
  (now folded into this ticket's history) and should be re-derived from
  `packages/quereus/src/planner/building/coercion.ts`'s own doc comments, which are
  fairly thorough.
- The correlated-arm decorrelation test only covers the INTEGER-vs-TEXT shape. The
  fix ticket's TODO also floated adding one for the reverse column arrangement (a
  child-side TEXT column against a parent-side INTEGER column) — not added here for
  time; the existing `08.1.1-uncorrelated-in-semijoin.sqllogic` "TEXT inner against
  INTEGER outer" case and this ticket's correlated test together give reasonable
  confidence, but a reviewer who wants belt-and-suspenders could add the mirror.
- `yarn test:store` was run once (per the fix ticket's suggestion) and passed
  (8077 passing, 22 pending, no failures) — the store-mode run logs several
  `[TransactionCoordinator] release/rollback-to savepoint … out of range` warnings,
  but these are pre-existing console noise unrelated to this change (no test
  failed, no assertion referenced them); not investigated further as out of scope
  for this ticket.
- `yarn test` (root, fans out to every workspace): 8086 passing in
  `packages/quereus` (up from the pre-existing 8081 baseline — the delta is this
  stage's new specs plus the new `.sqllogic` file's individual assertions), 0
  failing anywhere. `yarn workspace @quereus/quereus run lint` clean.

## Use cases for validation

A reviewer re-deriving confidence from scratch should exercise, at minimum:
- `select i in ('1') from nn` where `nn.i` is INTEGER — expect `true`.
- `select case i when '1' then 'hit' else 'miss' end from nn` — expect `'hit'`.
- `select id from t1 where int_col in (select text_col from t2)` (uncorrelated) —
  expect the plan to show a plain `In` node (no semi join), and the result to match
  what `int_col = text_col`-style row-by-row reasoning gives.
- `select s in (1, 'abc') from nc_mix where s = '1'` — expect `false` (the known
  gap), and confirm nobody has "fixed" this to `true` without also fixing the
  underlying `IN`-list key-space limitation described in `coerceComparisonSet`'s
  NOTE comment.

## Original fix ticket content (preserved for context)

<details>
<summary>Full text of the prior <code>implement</code> ticket</summary>

# Regression coverage for one comparison rule across every comparison form

## State of the work

The fix is **already applied in the working tree** and the whole workspace test
suite passes (`yarn test`: 8081 passing in `packages/quereus`, 0 failing across
all workspaces; `yarn workspace @quereus/quereus run lint` clean). What is NOT
done is dedicated regression coverage: the only test changes so far were to the
three existing fixtures that explicitly pinned the old, wrong answers and named
this ticket as the thing that would change them. Nothing yet pins the *new*
contract on purpose.

### What the fix does

Before: the planner inserted a cast when one side of a comparison was numeric and
the other textual, but only at the `=` and `BETWEEN` build sites. `IN` value
lists, simple `CASE`, `nullif`/`greatest`/`least`, the `IN`-subquery runtime path
and both `IN` decorrelation rewrites all skipped it, so the same comparison
answered differently depending on how it was spelled. Now every one of those
sites shares the `=` rule, through `coerceComparisonSet`
(`planner/building/coercion.ts`), `inMembershipKeys`
(`runtime/emit/subquery.ts`), and both arms of `rule-subquery-decorrelation.ts`.

### The one remaining gap, deliberately left

A **textual** probe against a value list mixing numeric and textual values —
`text_col in (1, 'abc')`, `case text_col when 1 when 'abc'` — is left uncoerced
and still disagrees with the `=` disjunction on the numeric member. Closing it
needs a per-value probe, which `IN` cannot express: its members live in one key
space. If it ever matters, the move is to desugar a mixed `IN` list into an `OR`
of `=` comparisons at build time, not to widen the hoist.

</details>
