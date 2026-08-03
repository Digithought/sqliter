---
description: A view whose definition uses a named sub-query block (a "with" clause) can now be updated and deleted through — before, such a write either failed with a confusing "table not found" error or silently changed nothing. Reviewed and validated.
files:
  - packages/quereus/src/parser/ast.ts                                # SelectStmt.storedBodyCTEs — the lowering-only marker
  - packages/quereus/src/parser/utils.ts                              # firstDataModifyingCte — the shared shape predicate (added in review)
  - packages/quereus/src/planner/planning-context.ts                  # PlanningContext.storedBodyCTECache — the per-lowering memo
  - packages/quereus/src/planner/building/view-mutation-builder.ts    # buildViewMutation (the stamp + memo) + rejectDataModifyingBodyCTE
  - packages/quereus/src/planner/building/select-context.ts           # buildStoredBodyCTEs — builds + memoizes the carried definitions
  - packages/quereus/src/planner/building/select.ts                   # buildSelectStmt (~98-115) — consumes the marker
  - packages/quereus/src/planner/mutation/scope-transform.ts          # mapNestedSelects doc note
  - packages/quereus/src/planner/mutation/mutation-diagnostic.ts      # reason code `unsupported-body-cte-dml`
  - packages/quereus/src/func/builtins/schema.ts                      # hasDataModifyingBodyCte + the deriveViewInfo gate
  - packages/quereus/test/view-cte-isolation.spec.ts                  # 20 cases in the second describe block
  - docs/view-updateability.md                                        # § Schema resolution during write-through, § Diagnostics
difficulty: medium
---

# A stored view body carries its own `with` clause into write-through lowering

## What was wrong

Writing through a view is **lowered** into a plain INSERT / UPDATE / DELETE against the
base table, and pieces of the view definition are copied into that lowered statement (the
definition's own `where`, each view column's defining expression, an authored
`with inverse` put expression, a `with defaults` value). A prior ticket made each copied
piece re-enter the view's own naming environment, which clears the *caller's* named-block
namespace — but nothing put the definition's **own** named blocks in its place. So a
sub-select inside a copied piece that read a block defined by the definition's `with`
clause had nothing to bind to. Two failure modes:

- no object of that name exists → `QuereusError: Table 'c' not found in schema path: main`;
- a **real table** of that name exists → the lowered statement silently bound that table,
  so the write reported success and changed nothing while a read of the same view
  returned the row.

## What landed

- `AST.SelectStmt.storedBodyCTEs` — a lowering-only field, the sibling of the existing
  `storedHomeSchema` marker. Never set by the parser; inert everywhere else.
- `buildViewMutation` stamps it on the same clones, in the same `mapNestedSelects` call.
- `buildSelectStmt` hands those definitions in as the copied fragment's parent namespace
  (`buildStoredBodyCTEs`) instead of the empty map it used before. The fragment's own
  `with` clause still merges on top and shadows a same-named definition block.
- `PlanningContext.storedBodyCTECache` — a memo created once per lowering, keyed on the
  `with` clause AST object, so all fragments of one lowering share **one** plan node per
  block. The multi-reference advisory then marks it `materialize`, so the block evaluates
  once per statement (matching the read).
- Two guards: a write through a view whose definition contains a **data-modifying** block
  is rejected with the structured reason `unsupported-body-cte-dml`, and `view_info()`
  reports the conservative all-`NO` row for that same shape.

## Review findings

Reviewed the implement diff (`f7ef939d`) against the source first, then the handoff.
Probed each open question with a scratch spec rather than reasoning about it; the scratch
file was deleted after the probes.

### Fixed in this pass (minor)

- **The data-modifying-block predicate was written twice**, once as a loop in
  `rejectDataModifyingBodyCTE` (`view-mutation-builder.ts`) and once as a `.some(…)` in
  `hasDataModifyingBodyCte` (`func/builtins/schema.ts`), with the doc comment on each
  asserting the other mirrors it. Two copies that must agree is a drift waiting to happen.
  Extracted to one exported `firstDataModifyingCte(withClause)` in `parser/utils.ts` — an
  existing dependency-light AST-helper module both sites can import without a cycle — and
  both now call it. Returning the offending member (rather than a boolean) also lets the
  rejection site name it without re-scanning.
- **`view_info` planned the whole view body before discarding the result.** The
  data-modifying-block gate sat *after* `db._buildPlan(…)` and `collectBodyNodes(…)`, but
  answers from the AST alone. Moved to the top of `deriveViewInfo`, so the conservative
  shape short-circuits without a body re-plan (`deriveViewInfo` re-plans on every call).

### Filed as a new ticket (major)

- **`fix/bug-view-write-body-schema-path-not-carried`** — a view definition may end with
  its own `with schema a, b` clause naming where its unqualified table names live. Reading
  such a view honours it; writing through it does not, for any sub-query the lowering
  copies out of the definition. Verified on the current tree: a view whose `where`
  sub-query reads `temp.t` under `with schema "temp", main` reads fine and fails the write
  with `Table 't' not found in schema path: main`. **Pre-existing, not caused by this
  change** — the first reproduction has no `with` clause at all, so it predates the carry
  and dates to the fragment-tagging ticket. It resolves at the same stamp site this ticket
  touched (the marker carries the home *schema name*, never the declared *path*), which is
  why it is one ticket and not an arm on this one — the work has not landed here. Recorded
  in `docs/view-updateability.md` alongside the two other open siblings.

### Parked as a tripwire, not a ticket

- The memoized block plan node is built under the **first** fragment that reaches it, so
  it captures that fragment's scope and is then reused by fragments with a different one
  (a `with inverse` put fragment has `new.*` registered; the definition's own `where` does
  not). Exact today because a definition's `with` clause resolved at CREATE time under a
  scope with no row registrations, so no member can bind outward. Parked as a `NOTE:` at
  the site in `buildStoredBodyCTEs` (`planner/building/select-context.ts`), pointing at the
  two ways out if a stored body ever gains an outward-resolving name.

### Test gaps closed (4 new cases, 35 in the file)

The handoff's own list of untested claims, plus two precedence claims the docs asserted
but nothing pinned. All four passed on first run — they document behaviour rather than
catch a regression, which is the point of pinning them:

- a **caller** `with c as (…)` must not displace the definition's `c` on write (the carried
  namespace *replaces* the caller's, it does not merge);
- a copied fragment's **own** `with` clause shadows a same-named definition block;
- a definition block referenced from inside a **set-operation** branch (the handoff flagged
  this as expected-to-work but unexercised);
- the deliberate behaviour change: a data-modifying block that **no fragment references**
  is now rejected too, where it used to write fine, and `view_info` agrees. Pinned so the
  narrowing reads as a decision rather than drift.

### Checked and found correct — no action

- **The data-modifying test is not over-broad.** `QueryExpr` is exactly
  `select | values | insert | update | delete`, so `type !== 'select' && type !== 'values'`
  cannot misfire on a compound `union` body (that is a `select` carrying `compound`).
- **The memo key is stable.** The stamp puts the *original* `withClause` object (not a
  clone) on every fragment, so object identity holds across all fragments of one lowering;
  a second lowering in the same statement builds its own memo, so two views' definitions
  cannot collide.
- **Ephemeral write targets are untouched** — probed: a `with c as (…) update c …` still
  reads the caller's own block.
- **Resource cleanup:** the memo is a plain `Map` on a context object created per plan
  build and dropped with it — nothing is registered on the `Database` and nothing needs
  releasing.
- **Docs are current.** `docs/view-updateability.md` is the only place the mutation reason
  codes are listed, and the implement pass updated it; `docs/schema.md` § Schema Path
  points at it rather than restating the rule, so it stays accurate.
- **File sizes:** `view-mutation-builder.ts` 1366 lines and `func/builtins/schema.ts` 1417
  lines (measured with `wc -l`) are the two large touched files, but this change adds a net
  ~10 lines to each and neither is a size-debt introduced here — not filed.

### Not investigated

- **No performance measurement**, matching the handoff. The memo adds one `Map` per view-
  write plan build and the stamp reuses the existing `mapNestedSelects` walk, so no new
  tree traversal exists to measure; there was no plausible regression to benchmark against.
- **The lens / decomposition-backed body with a definition-local block** stayed unexercised.
  It flows through the same single funnel as the set-operation case now pinned, and no
  cheap way to construct one presented itself; the set-op pin is the closer stand-in.

## Validation

- `yarn lint` — clean (eslint + the test-file `tsc` pass in `packages/quereus`; every other
  package is the intentional no-op).
- `yarn test` (repo-wide) — **8488 passing, 0 failing, 13 pending** in `packages/quereus`.
  The implement handoff recorded 8484; this pass adds exactly 4 cases. No other workspace
  suite failed.
- `tsc --noEmit` on `packages/quereus` — clean.
- `yarn docs:check` — the only failure is `docs/schema.md` over its word-count ratchet,
  already listed in `tickets/.pre-existing-known.md` against `debt-doc-size-ratchet-red-at-head`
  and untouched by this change. Not re-reported.

## Related open work

- `fix/bug-view-write-body-schema-path-not-carried` — filed by this review (above).
- `fix/bug-dml-cte-executes-once-per-reference` — filed during implement; a plain read
  query with a data-modifying block referenced twice runs the write twice. No view
  involved; it is the underlying reason the guard above exists.
- `fix/bug-view-write-lineage-subquery-base-table-qualifier` and
  `fix/bug-view-write-subquery-shadow-analysis-wrong-schema` — the same family of
  write-through fragment-resolution defects at different code sites.
