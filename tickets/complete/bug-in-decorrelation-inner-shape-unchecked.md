description: A WHERE clause testing a column against a related subquery used to crash at runtime whenever that subquery selected a computed value or used DISTINCT, LIMIT, or UNION. The engine fix, its regression tests, and the docs are now all in place.
files:
  - packages/quereus/src/planner/rules/subquery/rule-subquery-decorrelation.ts   # the three inner-shape gates (fix stage) + one NOTE added in review
  - packages/quereus/test/plan/subquery-decorrelation.spec.ts                    # plan-shape decline/fire assertions
  - packages/quereus/test/logic/07.8.1-correlated-in-decorrelation-gates.sqllogic # result-correctness corpus (extended in review)
  - docs/optimizer-rules.md                                                      # ruleSubqueryDecorrelation bullet
difficulty: easy
---

# Correlated-`IN` decorrelation inner-shape gates — complete

## What shipped

A `where col in (select … from … where … = outer.col)` is rewritten by
`rule-subquery-decorrelation` into a semi join. Two assumptions in that rewrite
were unchecked, and each crashed at runtime with `No row context found for
column …`:

- the join condition was built from the subquery's **first output column**,
  while the join's right side came from wherever a Project/Alias descent
  landed — a mismatch for a computed projection (`select b.x + 0 …`), whose
  output column has no attribute the right side defines;
- the descent recognized only Project and Alias, so `DISTINCT` / `LIMIT` /
  set operations / `ORDER BY` sitting above the correlated filter were treated
  as if absent, leaving the correlation buried inside the right side.

Three gates now decline the rewrite for these shapes (fix stage, commit
`a1d5543`): a `LIMIT`/`OFFSET` reached by the descent declines; the chosen
right side must expose the comparison column's attribute id; and after the
right side is assembled, `collectExternalReferences` on it must be empty. A
decline is always safe — the `InNode` stays on the runtime set-probe path
(`emitIn`). The inner column reference also gained its own AST, so the join
condition renders as `a.x = x` rather than the nonsense `a.x = a.x`.

The implement stage (commit `14414ba`) added plan-shape assertions, the
`07.8.1` sqllogic corpus, and the `docs/optimizer-rules.md` bullet. The review
stage extended the corpus and added one code NOTE (below).

## Review findings

### Checked, nothing found

- **The three gates, read against the code rather than the handoff.** Descent
  order is correct (the LIMIT gate fires whether the `LimitOffset` is the root
  or under a Project); `innerKeyIndex` is computed against the same node that
  becomes the join's right side, so the condition can never reference a
  phantom attribute; `collectExternalReferences` is whole-subtree recursive
  (`planner/cache/correlation-detector.ts`), so it genuinely backstops every
  root the descent cannot step through.
- **The per-conjunct loop.** A gate declining mid-loop uses `continue` with no
  state already mutated, and the outer fixpoint in `ruleSubqueryDecorrelation`
  still terminates (every successful iteration removes one conjunct; a
  permanently declining conjunct simply never fires).
- **Every expected result in the `07.8.1` corpus, recomputed by hand** from
  three-valued `IN` semantics against the seed data. All agreed.
- **The rule-on vs rule-off sweep the implement stage skipped**, re-run here
  over 16 *additional* inner shapes not in the corpus (CTE body, window
  function, aggregate root, `GROUP BY` root, nested `IN`, scalar subquery in
  the inner projection, `EXCEPT`, `INTERSECT`, aliased and doubly-projected
  computed columns, `CASE`, four `EXISTS` shapes, `limit -1 offset 0`). Every
  shape agreed with `subquery-decorrelation` and
  `exists-in-select-decorrelation` disabled, and none crashed. This closes the
  implement stage's flagged "untested CTE inside a correlated IN" gap — it
  works, and is now pinned.
- **Sibling docs.** `docs/runtime-caching.md` § IN-subquery set probe already
  states that correlated sources stay off the set probe, so the correlated
  arm's new declines need no wording change there; the enumerated decline list
  in that section is about the *uncorrelated* arm's gates and remains accurate.
  `docs/optimizer-rule-families.md` and `docs/optimizer-joins.md` reference the
  rule only for shapes this change does not touch. `docs/optimizer-rules.md`'s
  new paragraph was verified gate-by-gate against the code.
- **`limit -1` returning zero rows** (surfaced by the sweep) is documented,
  intentional behavior pinned in `104-emit-mutation-kills.sqllogic` — not a
  defect and not related to this ticket.

### Minor — fixed in this pass

- **The `EXISTS` arm had no positive coverage of the gated shapes.** The new
  `collectExternalReferences` backstop sits on the arm shared by `EXISTS` and
  correlated `IN`, but the corpus only exercised `NOT EXISTS`. Added plain
  `EXISTS` cases over `DISTINCT`, a computed inner projection, and `UNION`.
- **Inner roots reachable only via the backstop were untested.** Added
  sqllogic cases for a CTE body, an aggregate root, a `GROUP BY` root, a
  window function in the inner projection, and `EXCEPT` / `INTERSECT` (the set
  ops beyond `UNION`). All values taken from the hand-computed semantics and
  confirmed against both rule-on and rule-off plans.

### Major — none

No hole was found in the gates, and no behavior in the diff was found to be
wrong. Nothing was escalated to a new `fix/` or `backlog/` ticket.

### Tripwire

- The Project/Alias descent is deliberately narrow: every other subquery root
  (`Distinct`, set operations, `Sort`, CTE bodies, aggregates) is caught only
  by the post-build external-reference backstop. Widening the descent later
  without keeping that backstop would re-bury the correlation. Parked as a
  `NOTE:` comment at the descent site in `rule-subquery-decorrelation.ts`.

## Validation

- `yarn workspace @quereus/quereus run lint` — clean.
- `yarn test` (all workspaces) — green: 8065 passing in `@quereus/quereus`
  (13 pending, pre-existing store-only skips), all other packages passing, 0
  failing. No pre-existing failures surfaced, so no
  `tickets/.pre-existing-error.md` was written.
