---
description: A view can name the schemas its tables should be looked up in. When such a view combines two or more queries with `union` (or `intersect`/`except`), updating, deleting, or inserting through it now works no matter which of those queries needs that schema list — previously only the first one worked.
files:
  - packages/quereus/src/planner/mutation/set-op.ts               # `withDeclaredPath` (~line 628), `buildBranch` (~line 674), `analyzeSetOpView`/`analyzeSetOpBranches` (~line 562/597), `flaglessShape` (~line 1614)
  - packages/quereus/test/view-home-schema.spec.ts                 # 5 cases in the `with schema`/set-op describe block (~line 835 onward)
  - docs/view-updateability.md                                     # § Schema resolution during write-through (~line 123)
repro: verified
---

# What shipped

A trailing `with schema a, b` clause on a view definition binds to the whole compound
(`select … union select …`) but the parser attaches it only to the **leading** leg's statement
node. On write, each leg is lowered through its own synthetic branch view built from that leg's
own AST: the leading leg keeps the clause by accident of how that AST is spread, every other leg
does not. An unqualified table name that only the declared schema list reaches then failed on any
leg after the first, with a misleading "add 'temp' to your WITH SCHEMA clause" hint.

`withDeclaredPath(sel, declaredPath)` in `planner/mutation/set-op.ts` stamps the compound's
declared path onto a leg body that carries none of its own. It is the identity when the
definition declares no clause, and when the leg (or a nested sub-compound) carries its own —
so a leg's own clause still outranks the carried one. It is applied on both write routes:

- **membership route** (`… union exists left as f, exists right as g …`) — `buildBranch` takes the
  path and applies it right after the leg is unwrapped from its operand AST. Both call sites pass
  `sel.schemaPath`. Nesting works because `buildBranch` stamps a subtree operand's own compound
  node and `analyzeSetOpBranches` reads it back off that node when it splits the subtree.
- **flag-less route** (legs distinguished by a literal column, e.g. `'L' as src`) — `flaglessShape`
  carries a `declared` local through its chain walk, applying it to both the left leg and the
  right operand each iteration and re-seeding from a sub-compound's own path before descending.

This matches the read path, which applies the declared path to the whole compound through the
planning context (`building/select.ts` → `buildCompoundSelect`), so write and read now resolve
every leg's names against the same schemas.

## Review findings

**Diff read first, then the handoff.** Verified the fix against the read path independently:
`buildSelectStmt` puts `stmt.schemaPath` on the context *before* `buildCompoundSelect`, and that
one context builds both operands — so the read has always applied the declared path to every leg.
The write-side stamp restores parity rather than inventing a new rule. Precedence, no-clause
identity, and unwrap-then-stamp ordering (the unwrap of a `select * from (<compound>)` wrapper
drops the wrapper's path, so stamping must follow it) all check out.

**Gaps found and closed in this pass (minor, fixed inline):**

- *Nesting was untested.* The handoff flagged that a depth-2 leaf under a nested subtree operand
  was reasoned about but not pinned. Added `reaches a leaf inside a NESTED subtree operand of a
  membership set-op (depth 2)` — `A union exists…(B union C)` with the declared path needed by
  `C`'s sub-select. Confirmed it is a real regression guard: with `withDeclaredPath` neutered to
  the identity, it fails inside the second `fanBranchDataUpdate` recursion with
  `Table 'wt' not found in schema path: main`.
- *Flag-less chain past the first iteration was untested.* Added `reaches the THIRD leg of a
  flag-less chain that declares a path (depth 2)` — a 3-leg `union all` chain whose last leg needs
  the path. Also confirmed failing with the fix neutered.
- *DELETE on the flag-less route was untested* (the handoff called this out). The 3-leg test now
  covers `delete` as well as `update` — a separate builder (`buildFlaglessDelete`) off the same legs.
- *INSERT on the flag-less route was untested.* Added an insert to the existing binary flag-less
  case; it routes into the non-leading leg and lands the row there.

Test count went 8514 → 8516 passing (the two new cases; the other two additions extend existing
cases).

**Investigated and dismissed — no ticket filed:**

- *Does the stamp make a leg's own base table resolve differently from the read?* No — see the
  read-path parity note above. Stamping is the behaviour that makes them agree.
- *`single-source.ts:504` resolves a body's `from` source on `bodyCtx.schemaPath` (the home path),
  which never includes the declared path.* Probed it directly: a view declaring `with schema
  "temp", main` whose body names `pt2`, with `temp.pt2` a view over `main.pbase` and `main.pt2` a
  same-named table. The read binds `temp.pt2` and the update propagates correctly through it into
  `main.pbase`, leaving `main.pt2` untouched. The hypothesised mis-rewrite does not occur; the
  rewrite is driven by the planned body, not by that lookup. Probe removed after running.
- *`declared = rightEff.schemaPath ?? declared` in `flaglessShape` looks redundant* (after the
  stamp, `rightEff.schemaPath` is set whenever `declared` is). It is correct in both branches and
  reads as the intended precedence rule; left as-is.

**Checked, nothing found:** type safety (no `any`, the new parameter matches the AST's
`schemaPath?: string[]`); resource cleanup and error handling (the change is a pure AST spread on
the planning path, no new resources or catch sites); DRY (one helper, four call sites, no copy of
the precedence rule); comment clarity (the three new doc comments each say *why* the stamp
happens, not what the line does); AST identity (`withDeclaredPath` returns a fresh object, but
every caller already receives a spread copy from `leftBranchSelect` / `rightBranchSelect`, so no
node identity is lost that was not already lost).

**Docs:** `docs/view-updateability.md` § Schema resolution during write-through describes the
carry and had this slug removed from its "remaining open defects" list — verified the two
remaining slugs (`fix/bug-view-write-lineage-subquery-base-table-qualifier`,
`fix/bug-view-write-subquery-shadow-analysis-wrong-schema`) still sit in `tickets/fix/`. Added one
sentence stating that the carry reaches every leaf at every depth, now that the depth-2 behaviour
is pinned by tests rather than only reasoned about. No other doc describes set-op leg schema
resolution.

**Tripwires:** none recorded — nothing in this change is conditional on future scale or usage.

**Size note (measured, not filed):** `wc -l packages/quereus/src/planner/mutation/set-op.ts` →
2066 lines, of which this change added ~30. Its sibling `multi-source.ts` is 3311. Both are large
enough to be worth splitting eventually, but neither is a consequence of this change and choosing
the seams is a design call, so no size-debt ticket was opened here.

## Validation

- `yarn workspace @quereus/quereus run test` — 8516 passing, 13 pending, 0 failing.
- `yarn workspace @quereus/quereus run lint` — exit 0 (eslint + `tsc -p tsconfig.test.json
  --noEmit`, so the new spec cases are type-checked).
- `yarn docs:check` — fails on `docs/schema.md`'s word-count ratchet, which is already listed in
  `tickets/.pre-existing-known.md` against the in-flight `debt-doc-size-ratchet-red-at-head`.
  Unrelated to this change; `docs/view-updateability.md` stays inside its own ratchet.
