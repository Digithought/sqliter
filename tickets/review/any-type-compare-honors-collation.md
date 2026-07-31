---
description: A column that can hold any kind of value and is declared case-insensitive was case-insensitive in ordinary queries but case-sensitive inside indexes and primary keys, so adding an index changed query answers and duplicate checks missed duplicates. The two now agree; review the fix.
files:
  - packages/quereus/src/types/builtin-types.ts                        # ANY_TYPE.compare now applies its collation arg; collationAware set on TEXT/ANY
  - packages/quereus/src/types/logical-type.ts                         # new LogicalType.collationAware flag
  - packages/quereus/src/util/comparison.ts                            # new isCollationAware(); stale doc comments re-derived
  - packages/quereus/src/planner/analysis/comparison-collation.ts      # pkKeyCollationName now branches on collationAware (was isTextual); NOTE tripwire
  - packages/quereus/src/schema/unique-enforcement.ts                  # stale rationale comment re-derived
  - packages/quereus-store/src/common/pk-key-resolution.ts             # five doc passages re-derived; stale NOTE in pkOrderPreservingPrefixLength deleted
  - packages/quereus-store/src/common/store-module-schema-rewrite.ts   # reconcilePkCollations keeps its isTextual gate, now with rationale comment
  - packages/quereus-store/src/common/store-module-access-plan.ts      # stale collation-safety comment re-derived
  - packages/quereus-isolation/src/isolated-table.ts                   # canSeekForConstraint + overlay-normalizer comments re-derived
  - packages/quereus-sync/src/metadata/pk-identity.ts                  # doc mirror of the keying rule re-derived
  - packages/quereus/test/logic/06.4.5-any-collate-declared-keys.sqllogic  # NEW: repro cases 1-4, runs under memory AND store backends
  - packages/quereus/test/util/pk-identity.spec.ts                     # ANY keying pin flipped to NOCASE; JSON added as the collation-blind arm
  - packages/quereus-store/test/collation-order-preserving.spec.ts     # "declines BOTH arms" flipped to "admits BOTH arms"
  - packages/quereus-store/test/pushdown.spec.ts                       # ANY index seek now claimed
  - packages/quereus-store/test/index-column-collation.spec.ts         # unit expectation [undefined,'BINARY'] → [undefined,'NOCASE']
  - packages/quereus-store/test/unique-constraints.spec.ts             # ANY arm now seeks; JSON arm unchanged
  - packages/quereus-store/test/isolated-store.spec.ts                 # ANY UNIQUE check now seeks, still catches
  - packages/quereus-store/test/key-set-seek-store.spec.ts             # ANY key-set semi-join now fires
  - packages/quereus-store/test/runtime-key-set-plan.spec.ts           # ANY runtime-set multi-seek now claimed
  - packages/quereus-store/test/any-json-pk-binary-key.spec.ts         # ALTER SET COLLATE on any PK is now a real re-key (see gaps)
  - packages/quereus-store/test/custom-collation-key.spec.ts           # comment re-derived (undecorated any keys BINARY)
  - packages/quereus-store/test/astral-text-keys.spec.ts               # comment re-derived
  - packages/quereus-isolation/test/isolation-layer.spec.ts            # one test re-derived to undecorated any + NEW nocase-collapse test; seek test flipped
  - docs/types.md                                                      # collationAware documented; two stale passages re-derived
  - docs/store.md                                                      # §Per-column PK key collation rewritten; index-seek collation section; PK note
  - docs/design-isolation-layer.md                                     # canSeekForConstraint mirror re-derived
---

# Review: `ANY_TYPE.compare` now honors the collation it is handed

## What changed and why

`ANY_TYPE.compare` declared only two parameters, so the collation
`createTypedComparator` passed as the third argument was silently dropped and every
declared-key structure over an `any` column (memory PK BTree, memory secondary index,
the store's key bytes, the isolation overlay's shadow keys) compared BINARY — while
`=`, ranges, `order by`, `group by`, `distinct`, and `in` all honored a declared
COLLATE. Consequence: creating an index changed query answers, and PK/UNIQUE admitted
duplicates that DISTINCT collapsed.

The fix is the one-line signature change plus a new explicit marker:

- `LogicalType.collationAware?: boolean` — set on `TEXT_TYPE` and `ANY_TYPE`; a
  by-flag test (`isCollationAware` in `util/comparison.ts`), not object identity,
  following the JSON_TYPE two-module-instances lesson.
- `ANY_TYPE.compare: (a, b, collation) => compareSqlValuesFast(a, b, collation ?? BINARY_COLLATION)`.
- `pkKeyCollationName` branches on the new flag instead of `isTextual`, so an
  `any collate nocase` key column resolves to `'NOCASE'` everywhere key collations are
  derived (store `resolvePkKeyCollations` / `resolveIndexKeyCollations`, isolation
  overlay normalizers, sync pk-identity) — all transitively, no per-backend edits.

Everything downstream (memory comparators, store order-safety gates, isolation
`canSeekForConstraint`) followed automatically; the work beyond the two code sites was
verifying each gate's new answer and re-deriving the comments/tests/docs that had
memorialized the old behavior.

## Confirmed invariants (use these as the review checklist)

- **Creating an index never changes an answer.** New sqllogic
  `06.4.5-any-collate-declared-keys.sqllogic` pins repro cases 1–4 from the fix
  ticket (equality + range before/after index, ORDER BY via index, index COLLATE on
  undecorated `any`, PK + table-level UNIQUE duplicate rejection, DISTINCT
  agreement). Deliberately NOT pinned to the memory module, so `yarn test` runs it
  against memory and `yarn test:store` against LevelDB — backend parity is part of
  the assertion.
- **Undecorated `any` does not move.** `resolveDefaultCollation` gates the session
  `default_collation` on `supportedCollations`, which ANY does not declare, so an
  undecorated `any` column's declared collation stays `'BINARY'` and its key bytes
  are unchanged. Confirmed by code-reading `columnDefToSchema` +
  `resolveDefaultCollation` and pinned indirectly by
  `custom-collation-key.spec.ts` ("unaffected by a table key collation K") and
  `collation-order-preserving.spec.ts` (undecorated `any` PK range seek). Only an
  explicit non-BINARY COLLATE re-keys.
- **Store gates now admit the shape.** `indexPrefixSeekIsCollationExact`,
  `indexLeadingRangeIsOrderSafe`, `pkOrderPreservingPrefixLength` all admit
  `any collate nocase` (key collation == residual collation; NOCASE carries
  `orderPreserving`). Verified by the flipped plan-shape assertions in
  `collation-order-preserving.spec.ts`, `pushdown.spec.ts`,
  `key-set-seek-store.spec.ts`, `runtime-key-set-plan.spec.ts`. Answer assertions in
  all of those were kept, not rewritten.
- **The remaining decline shape is real and still tested.** A collation-blind column
  (`json`, temporals) under an *index-level* explicit non-BINARY COLLATE still keys
  hard-BINARY while the residual compares under the declared name — index DDL does
  not type-gate the way column DDL does. `unique-constraints.spec.ts` "a JSON column
  with an index COLLATE falls back to the full scan" pins it, unchanged.
- **`validateKeyCollations` admits NOCASE on an `any` key column** — it collects the
  resolved names and requires a registered normalizer; NOCASE has one. Exercised by
  every new seek test.
- **`reconcilePkCollations` stays `isTextual`-gated** (undecorated `any` PK must not
  silently inherit the store's K default), with a rationale comment at the site.

## Behavior changes a reviewer should weigh

- **On-disk key bytes changed** for `any` columns carrying an explicit non-BINARY
  COLLATE (PK members and index columns). Backwards compatibility is explicitly not
  a concern yet per AGENTS.md, but a database written before this change with that
  column shape would read wrong through the new code. Stated, not mitigated.
- **`alter table … alter column <any pk> set collate nocase` is now a real physical
  re-key** (was effectively a byte no-op). Colliding rows ('A'/'a') now refuse with
  CONSTRAINT before any mutation, matching the text-PK rule.
  `any-json-pk-binary-key.spec.ts` was re-derived to assert both the refusal and the
  successful re-key + subsequent NOCASE enforcement.
- **Isolation PK semantics for `any collate nocase primary key` inverted** (by
  design): the case variant is now a PK violation and case-only rewrites shadow
  across spellings. The old isolation test asserting case-distinct rows under a
  declared NOCASE was re-derived to undecorated `any` (preserving its actual
  regression intent — the modified-PK normalizer must not over-merge), and a new
  test pins the NOCASE-collapse behavior.

## Known gaps / honest notes

- The undecorated-`any`-under-session-default fact is verified by code reading and
  indirect pins, not by a dedicated unit test asserting
  `resolveDefaultCollation(ANY_TYPE, 'NOCASE') === 'BINARY'`. Cheap to add if the
  reviewer wants a direct pin.
- `pkKeyCollationName` returns `column.collation` verbatim for collation-aware
  types; a schema-stub caller handing an `any` column with `collation` unset would
  fall into the store's K-fallback (text semantics). Unreachable from a real
  `ColumnSchema` (columnDefToSchema always resolves a collation). Recorded as a
  `NOTE:` tripwire at the site in `comparison-collation.ts`, not a ticket.
- The fix ticket asserted `reconcilePkCollations` rewriting `any` to K "would
  re-open the key-vs-compare mismatch"; that is imprecise — the reconciled schema is
  registered engine-side, so comparisons would follow. The accurate rationale (the
  gate preserves session-default policy parity with the engine and memory/store
  agreement for undecorated `any`) is what the site comment now says.
- `comparisonSemanticsDiffer` still conservatively reports `text ↔ any` as "may
  re-order" (distinct `compare` identities) although over all-text data the two now
  order identically under the same collation — harmless O(rows) re-sort on retype,
  noted in its doc block.

## Validation run

- `yarn build` — clean.
- `yarn test` (full workspace) — engine 8279 passing / 13 pending, store 1281,
  isolation 370, sync 643, all other packages green; 0 failing.
- `yarn test:store` — 8271 passing / 21 pending, 0 failing (exercises the changed
  on-disk key bytes, which the memory-backed default suite cannot).
- `yarn lint`, `yarn typecheck` — clean.
