description: The optimizer's misleading, unused rule "priority" numbers are gone; rule registration is now a readable ordered data table with a startup consistency check.
files: packages/quereus/src/planner/optimizer.ts, packages/quereus/src/planner/framework/registry.ts, packages/quereus/src/planner/framework/pass.ts, packages/quereus/test/optimizer/rule-manifest.spec.ts, packages/quereus/test/optimizer/side-effect-audit.spec.ts, docs/optimizer.md
difficulty: medium
----

## What shipped

1. **Deleted the dead `priority` field** from `RuleHandle` (`framework/registry.ts`). Nothing sorted by it (rule application iterates `pass.rules` in push order) and several numbers disagreed with real registration order. Every `(priority N)` doc-comment across the planner tree + docs rephrased to name the rule it orders against.

2. **Table-driven manifest.** The imperative `addRuleToPass(...)` wall in `optimizer.ts` became `RULE_MANIFEST` — an ordered `readonly RuleManifestEntry[]` — plus a registration loop that walks it in array order. **Array order = registration order = execution order** is now the single honest contract.

3. **Startup assertion** at optimizer construction: unknown target pass → `quereusError(INTERNAL)`; duplicate rule id within a pass → `quereusError(INTERNAL)` (hard-fail, vs the silent-skip `addRuleToPass` does for its other callers).

4. **OPT-003 side-effect static guard rewritten** (`side-effect-audit.spec.ts`) to parse `RULE_MANIFEST` entries instead of `addRuleToPass(...)` calls, since the manifest conversion collapsed registration to one loop.

## Review findings

Adversarial pass over commit `a412c97d`. Read the full implement diff first (optimizer.ts ±1809 lines, guard rewrite, doc sweep), then the handoff.

**Checked — correctness / order preservation (the load-bearing contract):**
- Full `yarn test` green: **6873 passing**, 0 failing (6867 pre-existing + 6 new manifest tests). No `test/plan/` or `test/optimizer/` golden drift ⇒ per-pass registration order byte-preserved. This is the real proof order held.
- `lateral-top1-asof` placement verified: it is a `PassId.Structural` entry sitting *after* the three `PassId.Physical` entries in manifest source order (optimizer.ts:733, after 692/704/715) ⇒ registers last in the Structural pass, matching its historical position.
- Fan-out ids verified: `PlanNodeType` is a string enum (`Filter = 'Filter'`…), so `${entry.id}-${nodeType}` mints the exact historical `grow-retrieve-Filter` / `monotonic-range-access-IndexScan` handles.
- Manifest arithmetic: 52 entries → 61 handles (50 scalar + grow-retrieve×8 + monotonic-range-access×3). 3 rule-bearing passes: Structural 35, PostOptimization 14, Physical 3. (Handoff prose said "4 rule-bearing passes" — harmless slip; actual is 3. Lived only in the now-deleted source ticket, no code impact.)

**Checked — priority removal completeness:**
- `grep priority` over `src/planner` and `docs`: zero rule-ordering references remain. Only unrelated survivors (SQL column names, `scopes/global.ts` "functions have priority over tables", roadmap prose) and `docs/review.html` (the archived review that spawned this ticket, intentionally untouched).

**Checked — guard rewrite:**
- `manifestRegion()` regex `/RULE_MANIFEST\b[^=]*=\s*(?:readonly\s+)?\[/` matches the real declaration `const RULE_MANIFEST: readonly RuleManifestEntry[] = [` (the `[^=]*` swallows the type annotation, anchors on the `[` after `=`). `extractRuleEntries()` innermost-brace scan + self-check (manifest-region-scoped `sideEffectMode:` count == parsed count) sound. Guard green (15/15), audits all 27 `'aware'` rules.

**Found + FIXED inline (minor — test coverage):** the new dup-id / unknown-pass startup assertion had **no direct test** (implementer's own flagged gap), and a non-obvious invariant was unpinned: the dedup Set is *per pass*, so the same id in two *different* passes must be allowed while a dup *within* a pass must hard-fail.
- Extracted the registration body into an exported `registerManifest(manifest, passManager)` (pure over its args, byte-identical logic; the private `registerRulesToPasses` now delegates). Zero behavior change on the success path — validate-and-register still happen in one manifest-order walk; full suite still green.
- Added `test/optimizer/rule-manifest.spec.ts` (6 tests): scalar order, fan-out `${id}-${nodeType}` order, unknown-pass hard-fail, within-pass dup hard-fail, fan-out-minted dup hard-fail, cross-pass same-id allowed.

**Found — latent design property (not a defect, recorded as tripwire):** `STANDARD_PASSES` are shared mutable singletons — a pass object's `.rules` array persists across `PassManager` instances. Production idempotency across multiple `Optimizer` constructions relies on `addRuleToPass`'s silent-skip of already-present ids; `registerManifest`'s own dup check uses a fresh per-call Set and does not see prior-construction rules. Pre-existing, unchanged by this ticket. Parked as a `NOTE:` on the new spec's `freshPm()` helper (which must use fresh passes to stay isolated). No ticket — conditional knowledge, not queued work.

**Tripwires (verified present, indexed here — analysis lives at the sites):**
- Guard flat-entry assumption — `NOTE:` at `extractRuleEntries` in `side-effect-audit.spec.ts`: fails loud (parse throw) if a manifest entry ever gains a nested `{...}`.
- Manifest-const rename — `manifestRegion` keys on `RULE_MANIFEST … = [`; on rename it falls back to whole-file scan and trips loudly on the `RuleManifestEntry` interface's `id:`.
- Shared-singleton passes — new `NOTE:` on `freshPm()` in `rule-manifest.spec.ts` (above).

**Major findings:** none. No new `fix/`/`plan/` tickets spawned.

**Lint / build:** `yarn workspace @quereus/quereus run lint` clean (eslint + `tsc -p tsconfig.test.json`, which type-checks the new spec). Build implied by green test run.

**Out of scope (already filed by implementer, left as-is):** `tickets/backlog/debt-optimizer-rule-order-constraints.md` — machine-checked cross-rule `after`/`before` ordering edges + topo-sort assertion (the guard that would encode the ordering *rationale* the comments hold as prose). This ticket's assertion is structural only (dup id / unknown pass). Appropriate deferral.
