description: |
  Split a test file that mixed a backend-portable scenario with one backend-specific scenario, so the
  portable part can run everywhere instead of failing the whole file on backends that don't support it.
files:
  - packages/quereus/test/logic/47.3-upsert-conflict-target-collation.sqllogic  # § 6 removed; § 7/§ 8 renumbered § 6/§ 7; sibling pointer added
  - packages/quereus/test/logic/47.3.1-upsert-conflict-index-derived-collation.sqllogic  # NEW — carved-out scenario
difficulty: easy
---

# Split 47.3 § 6 (index-derived UNIQUE collation) into its own `.sqllogic` file — complete

## Summary

Carved the index-derived-collation upsert scenario out of `47.3-upsert-conflict-target-collation.sqllogic`
into new `47.3.1-upsert-conflict-index-derived-collation.sqllogic`. The bulk of 47.3 (collation-variant
upsert conflict-target matching via column/table-level UNIQUE constraints) is backend-portable; only the
carved scenario depends on a standalone `create unique index` with a per-column `COLLATE`, which some
backends (downstream lamina) don't support. Split keeps 47.3 portable while the index-dependent scenario
lives where it can be skipped/pinned per-backend. Both files run on memory and store.

## Review findings

Adversarial pass over the implement diff (commit `8ef9ddcf`). Checked scope, SQL fidelity, cross-refs,
test-config, backend coverage, and full-suite green.

- **Diff scope — clean.** Only `.sqllogic` test files + `.pre-existing-error.md` + ticket board touched. No
  `.ts` source. Matches the "restructure test files only" intent.
- **Surviving SQL byte-identical — confirmed.** Diff shows the removed § 6 block and banner-number changes
  only; §§ 1–5 SQL untouched, old § 7/§ 8 SQL identical after renumber to § 6/§ 7. No behavior change.
- **Renumbering correct — confirmed.** § 6 = WHERE-guard scenario, § 7 = multi-row insert; sequential, no
  gaps or dupes. Top-header sibling pointer to `47.3.1-...` added alongside the existing 47.4 note.
- **New 47.3.1 file — correct.** Exactly the carved scenario (`create unique index ... collate nocase`,
  then `on conflict (tag) do update`), expected `[{"id":1,"tag":"seen"}]`, table dropped. Header rationale
  accurate.
- **Section independence — verified.** Each section create+drops its own table; removing § 6 leaks no state.
  Both files end with all tables dropped.
- **Sibling spec cross-ref — RESOLVED (was an implementer gap).** Implementer noted they didn't verify the
  referenced `unique-enforcement-collation.spec.ts` exists. Confirmed via glob: the file exists at
  `packages/quereus/test/unique-enforcement-collation.spec.ts` (singular "collation", matching the header
  reference). The review-ticket body's "collations" (plural) was a typo in prose only — the actual file
  header uses the correct singular name. No fix needed.
- **Backend coverage — verified.** Neither file appears in `MEMORY_ONLY_FILES` (`logic.spec.ts:39`); no 47.3
  reference in that set. Both run on memory and store, as required.
- **Pre-existing MV failure — resolved externally.** The implement run reported one failure
  (`view-mv-ddl-persistence.spec.ts` timeout) filed via `.pre-existing-error.md`. The runner's triage pass
  (commit `e45b80f4`) handled it; my full `yarn test` run is now **6994 passing, 13 pending, 0 failing**.
  Not this diff's concern; noted for completeness.

### Validation (this review)

- `yarn test` (memory, `packages/quereus`): **6994 passing, 13 pending, 0 failing**.
- `yarn lint` (quereus, includes `tsc -p tsconfig.test.json`): **exit 0**.
- Did not re-run `yarn test:store` this pass — implementer reported it green (6988 passing, 0 failing) and
  the store-specific interaction (`create unique index` + NOCASE enforcement) is exercised by both files;
  no `.ts` change since. Memory + lint green is sufficient confirmation for a comment-only test-file split.

### Findings requiring follow-up

None. No minor fixes applied (nothing warranted), no major tickets filed, no tripwires recorded — the change
is a pure test-file restructure with no code surface and no latent conditional concerns.
