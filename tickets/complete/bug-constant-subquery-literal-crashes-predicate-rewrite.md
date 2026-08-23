description: A query that compares a column to a constant subquery, such as `where v = (select 1)`, used to crash at plan time instead of running; the planner now treats such a value as unknown-until-runtime and runs the query as a normal filter.
files:
  - packages/quereus/src/planner/analysis/predicate-shape.ts                       # planTimeLiteralValue(node) — the shared "is this a plan-time constant" decision
  - packages/quereus/src/planner/analysis/constraint-extractor.ts                  # isLiteralConstant delegates to it (crash site 1)
  - packages/quereus/src/planner/rules/predicate/rule-sargable-range-rewrite.ts    # isLiteralConstant delegates to it (crash site 2)
  - packages/quereus/test/logic/96-subquery-edge-cases.sqllogic                    # 10 end-to-end cases
  - packages/quereus/test/optimizer/sargable-range-rewrite.spec.ts                 # 1 unit case pinning crash site 2 directly
  - docs/optimizer-const.md                                                        # §4/§7 corrected — the folding pass does NOT await
---

# Completed: promise-valued literal is not a plan-time constant

## What shipped

Constant folding runs as a synchronous optimizer pass, so a folded uncorrelated
constant scalar subquery (`(select 1)`) becomes a `LiteralNode` whose value is a
**still-pending Promise**; the emitter awaits it at runtime. Two planner call
sites each had a private `isLiteralConstant` / `getLiteralValue` pair that read
the value synchronously and threw `Literal value is a promise`:

- `planner/analysis/constraint-extractor.ts` — reached first by all four broken
  query shapes.
- `planner/rules/predicate/rule-sargable-range-rewrite.ts` — independently
  reachable behind it.

A shared decision helper `planTimeLiteralValue(node): SqlValue | undefined` was
added to `planner/analysis/predicate-shape.ts`, delegating the value test to the
existing AST-level `literalValue(expr)` (which already rejected a Promise). Both
sites now express `isLiteralConstant` in terms of it, each keeping its own,
deliberately different `unwrapCast`. `undefined` means "not a constant"; SQL
`NULL` still comes back as `null`, so both sites' null-specific branches are
unchanged.

With the promise-valued literal no longer classified as a constant, the conjunct
falls through to "no column-constant pattern" and survives as a residual
`FILTER` — the query runs and returns the right rows, matching what the
non-folded `(select max(...))` control already did. A `NOTE:` tripwire at
`isDynamicValue` records that this is conservative-but-correct, and what would
need validating (the seek-binding path for a promise-valued literal) before
making the shape seek-worthy.

## Review findings

Reviewed the implement diff (`8ae20582a`) before the handoff summary, then the
surrounding sites, the docs the change touches, and the sibling readers of the
same representation.

**Verified the implementation, no defects found in the diff itself.** All four
`getLiteralValue` call paths in the extractor and the one in the rewrite rule are
gated by `isLiteralConstant`, so the unguarded `getSyncLiteral` call is now
unreachable for a promise-valued literal. The mixed `IN` path declines correctly
(a promise literal is neither literal-constant nor dynamic, so `allUsable` is
false). The `node is LiteralNode` type predicate the extractor keeps stays sound.
The two `unwrapCast` helpers were correctly left un-unified, per the ticket.

**Major finding, filed as a new ticket — `bug-constant-subquery-literals-collide-in-cse`
(`tickets/fix/`, repro: verified).** The same root cause — a promise-valued
literal read as if it were a resolved value — exists at a third site outside this
diff, and produces silent **wrong results** rather than a crash:
`fingerprintLiteral` (`planner/analysis/expression-fingerprint.ts` ~line 109)
reads `expression.value` and dispatches on its JavaScript type; a Promise falls
into the "JSON document" branch and canonicalizes to the empty object, so every
promise-valued literal gets the *same* fingerprint. `rule-scalar-cse.ts` then
collapses expressions that differ only in which constant subquery they contain.
Reproduced on the current tree:

- `select x + (select 1) as a, x + (select 2) as b from t where id = 1` returns
  `[{a:11, b:11}]`; correct is `[{a:11, b:12}]`.
- `select id from t where x = (select 10) or x = (select 20) order by id` returns
  `[{id:1}]`; correct is `[{id:1},{id:2}]` — a qualifying row is silently dropped.

This is pre-existing and independent of this ticket's change (a projection
expression never reaches either patched call site), so it was filed rather than
folded in here: it needs its own regression coverage and an audit sweep, and it
is wrong-results rather than a crash. The ticket is filed at the class level
(route the raw readers through `planTimeLiteralValue`, prefer a general test)
rather than as a one-line point fix, and carries the two other raw readers found
in the same sweep as additional arms: `rule-monotonic-range-access.ts` ~76
(latent — currently unreachable now that the extractor declines these literals,
but wrong the moment that changes) and `schema/function.ts` ~360
(`evaluateLiteralOperand`, cost-estimate only). A site-claim grep over the open
board found no ticket already covering these sites.

**Docs were out of date and had actively invited the bug — fixed in this pass.**
`docs/optimizer-const.md` §4 showed the folding pass as `const val = out
instanceof Promise ? await out : out` and §7 claimed "Scheduler returns Promise;
folding awaits it". Neither is true: `const-pass.ts` `replaceBorderNodes` is
synchronous and casts the `MaybePromise` straight into the literal. Both sections
now state that a `LiteralNode` may hold a pending Promise, that it is therefore
not automatically a plan-time constant, and that planner code must go through
`planTimeLiteralValue` instead of reading `expression.value`.

**Test coverage was a starting point; extended in this pass.** The implementer's
five end-to-end cases covered `=` (integer and text), `BETWEEN`, `IN`, and the
aggregate control. Five more were added to the same section, covering the paths
the original set missed: range operators (`>`, and `>= AND <`), the folded
constant on the **left** of the comparison (the extractor's mirrored branch),
equality against the **PRIMARY KEY** column (where the constraint would otherwise
become a seek key — the shape closest to the deferred optimization), and
`NOT IN`. All pass.

**Test and source hygiene — fixed in this pass.** The new sqllogic section
created a table named `big`, breaking the file's `sq_`-prefixed convention and
colliding by name with tables in four other logic files; renamed to
`sq_const_t`. The new unit test called `ruleSargableRangeRewrite` twice (once
inside a `not.throw` assertion, once for the null check) — the second call alone
already fails the test on a throw, so it is now a single call with a comment
saying so. The `predicate-shape.ts` module header described the file as purely
AST-level shape recognizers for CHECK constraints and partial indexes; it now
notes `planTimeLiteralValue` as its one plan-node-level entry point.

**Implementer's stated gap, closed.** The handoff noted the two new test files
were never run in isolation. Both were: `96-subquery-edge-cases.sqllogic` passes
on its own (one mocha case per logic file, which is why the suite total does not
move when cases are added), and `sargable-range-rewrite.spec.ts` passes standalone
at 11 tests including the new one.

**Tripwires: none recorded beyond the one the implementer already placed** at
`isDynamicValue` in `constraint-extractor.ts` (a folded async subquery constant
falls back to a residual filter; revisit if the shape becomes seek-worthy). It is
correctly scoped and its revisit condition is stated, so it was left as-is.

**Considered-and-declined: none encountered.** No accepted-tradeoff `NOTE:`
markers exist at any of the sites touched or filed against.

## Validation

- `yarn workspace @quereus/quereus run lint` — clean (eslint plus the
  `tsc -p tsconfig.test.json --noEmit` pass).
- `yarn workspace @quereus/quereus run test` — 10174 passing, 25 pending, 0
  failing.
- `packages/quereus/test/logic.spec.ts --grep 96-subquery` — passes standalone.
- `packages/quereus/test/optimizer/sargable-range-rewrite.spec.ts` — 11 passing
  standalone.

No pre-existing failures surfaced.
