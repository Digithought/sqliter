description: Three design docs had grown past their size limits and turned the docs check red; they were trimmed back under the limits by removing changelog/future-work prose and de-duplicating repeated explanations, so the check is green again — no size limit was raised. Reviewed and confirmed faithful.
prereq:
files:
  - docs/sync.md (deleted "## Implementation Status"; added "## Current limitations" pointer)
  - docs/runtime.md (rewrote "## Debugging and Common Pitfalls" as a slim checklist)
  - docs/schema.md (de-duplicated store-tag-persistence prose; consolidated reserved-tag validation section)
  - docs/todo.md (added "## Sync Engine Remaining Work" — moved from sync.md)
  - docs/.doc-budget.json (ratchet entries lowered for the three docs)
  - scripts/check-docs.mjs (the gate — unchanged)
difficulty: medium
----

## What this was

`node scripts/check-docs.mjs` (first link in `yarn check`) was red: three docs exceeded
their recorded word-count ratchets (`docs/.doc-budget.json`). Brought under the **existing**
ratchets by honest trimming (delete history, move future-work to `docs/todo.md`, de-duplicate
normative prose — per `docs/doc-conventions.md`), then lowered the ratchet entries to the new
sizes. No `--force` raise. Gate now exits 0.

| doc | before | after | ratchet (lowered) |
| --- | --- | --- | --- |
| runtime.md | 13840 | 13265 | 13477 → 13265 |
| schema.md | 16029 | 15672 | 15690 → 15672 |
| sync.md | 14516 | 13511 | 14321 → 13511 |

Only prose + `docs/.doc-budget.json` changed. **No code touched.**

## Review findings

Adversarial pass over the implement diff (commit `9c7e72b3`). Read the full diff of all four
touched docs + the budget JSON before the handoff summary. Verdict: **implementation is
faithful; no defects; no inline fixes required; no new tickets filed.**

**Gate — PASS.** `node scripts/check-docs.mjs` → exit 0, "Docs OK: links resolve, invariants
well-formed, sizes within ratchet, tiers declared." Ratchet lowered correctly to match new
sizes; schema.md sits exactly at its ratchet (15672/15672 — see tripwire).

**Lint / tests — not run, with reason.** The diff touches only `*.md` and `.doc-budget.json`;
zero code delta. `yarn lint` / `yarn test` exercise nothing in this change. The relevant gate
for a docs-only diff is `check-docs.mjs`, which is green. This is a stated skip, not a silent
one.

**schema.md reserved-tag consolidation (the implementer's flagged highest risk) — VERIFIED
intact.** Diffed old 5-paragraph section against the new (para 1 + Constraint siting +
Declarative path + Build-time paths + DROP TAGS + Two deliberate blind spots). All load-bearing
rules survive:
- Five sites + object mappings (`physical-table`/`-column`/`-constraint`, `view-ddl`,
  `physical-index`) ✓
- Constraint siting: table-level named-or-not → `physical-constraint`; inline *named* →
  `physical-constraint`; inline *unnamed* → deferred to `physical-column` (no double-validate);
  rename keys off named only ✓
- `DROP TAGS` does no validation on any object ✓
- Both blind spots (`CREATE VIEW`/`MATERIALIZED VIEW … WITH TAGS` not eagerly validated;
  `quereus.sync.replicate` inert on direct create but validated on declarative path;
  import/load ungated by design) ✓
- Fires under `IF NOT EXISTS` and regardless of `nondeterministic_schema`; free-form tags
  skipped ✓
- Helper names `raiseStmtTagDiagnostics`, `raiseReservedTagDiagnostics`, `columnTagDiagnostics`
  all retained ✓
- The `logical-*`-only-key example changed from `quereus.lens.access.<col>` to
  `quereus.lens.writable` — **checked `src/schema/reserved-tags.ts`**: `quereus.lens.writable`
  is real and `logical-column`-sited (line 81 / 302–310), so it's an *accurate* (indeed more
  precise) example of a key that fails when mis-sited on a physical table.

**runtime.md trim — sound.** The one load-bearing piece (the per-row microtask-hop / branch-on-
`instanceof Promise` performance contract, undocumented elsewhere) is preserved verbatim. The
deleted material (context-helper API, `resolveAttribute` tiers, scope-resolution, tracing
env-vars) is genuine restatement of content canonical earlier in the same doc; the new checklist
cross-references those sections. All five new cross-reference anchors resolve to real headings
(`#row-context-management` L318, `#column-reference-resolution` L356, `#scheduler-execution-model`
L425, `#key-points-for-emitter-authors` L454, `#context-debugging-and-tracing` L570).

**sync.md migration — faithful.** `## Implementation Status` (per-phase `[x]` changelog + future
work) deleted; open `[ ]` items carried to `docs/todo.md § Sync Engine Remaining Work`; `[x]`
lines dropped as changelog (git + `tickets/complete/` hold that). Cross-checked every open item —
all present in todo.md. Two harmless *consolidations* (not losses): the two Store-isolation `[ ]`
items collapsed into one line, and the three example-transport `[ ]` items into one; both still
name the same work. The new `## Current limitations` pointer's three anchors all resolve
(`#transactional-integrity-during-sync` L421, `#store-isolation-store-phase-8---future` → heading
"Store Isolation (Store Phase 8 - Future)" L552, `todo.md#sync-engine-remaining-work` L423).

**No dangling links.** Grepped `docs/` and package READMEs for references to every deleted anchor
(`#implementation-status`, `#scheduler-centric-execution-model`, `#scope-resolution-debugging`,
`#context-helper-functions`, `#context-lifecycle-management`, `#debugging-techniques`,
`#reusable-sync-client`) — zero hits. Nothing linked into the removed sections.

**Protected normative content — confirmed untouched.** RENAME TABLE two-phase `finalizeRename`
protocol (schema.md, `grep finalizeRename` → 2 hits); inner-scan connection-reuse contract
(runtime.md, edits confined to trailing Debugging section); sync `protocolVersion` handshake
(sync.md, edits confined to trailing Implementation Status section).

### Categories checked
- **Correctness / content-preservation** — verified (above); no rule, contract, or open item
  dropped.
- **Link integrity** — verified; all new anchors resolve, no dangling references to deleted ones.
- **DRY** — the change *improves* DRY (removed ~4× restatement of store-tag persistence and
  runtime context-helper API).
- **Edge cases** — the highest-risk consolidation (reserved-tag rules) checked rule-by-rule.
- **Empty categories:** No **major** findings → no new tickets filed. No **minor** findings →
  no inline fixes made. This is a prose-only reconciliation; the categories are legitimately
  empty because the trim preserved all normative content and the gate confirms structural
  integrity.

### Tripwires (recorded, not filed)
1. **schema.md has ~zero ratchet headroom** (15672/15672). If any future edit adds a word to
   schema.md, it must either re-lower the ratchet (`--update-ratchet`) or offset with another
   trim, or the gate goes red. Not a code site; the mechanism is already explained in
   `docs/.doc-budget.json`'s `note` field and `docs/doc-conventions.md`, so no extra NOTE
   comment added — recording here is the index entry. runtime.md (+212) and sync.md (+810) have
   comfortable headroom.
2. **Docs remain over the 12,000-word readability cap** the project is paying down. This ticket
   reconciled the *ratchet*, not the *cap*. The megadoc-split track
   (`debt-docs-shrink-remaining-megadocs`) owns the cap; carried forward from the implementer's
   handoff so it stays visible.

## How to re-validate

```bash
node scripts/check-docs.mjs            # exit 0
git diff docs/schema.md                # reserved-tag section preserves all rules
grep -c finalizeRename docs/schema.md  # 2 — RENAME two-phase protocol intact
```
