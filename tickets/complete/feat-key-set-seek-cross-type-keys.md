---
description: Two query optimisations that look rows up through an index used to give up whenever the two columns being matched were declared with different number types — whole numbers on one side, decimals on the other. They now handle that case, so those queries get the faster plan.
files:
  - packages/quereus/src/types/builtin-types.ts                          # sharesSeekKeySpace + isSeekKeySpaceNumeric
  - packages/quereus/src/types/index.ts                                  # re-export
  - packages/quereus/src/planner/rules/access/rule-key-set-seek.ts       # gate site 1 + NaN NOTE
  - packages/quereus/src/planner/rules/join/index-nested-loop.ts         # gate site 2
  - packages/quereus/src/planner/rules/access/rule-select-access-path.ts # NOTE only
  - packages/quereus/test/type-system.spec.ts
  - packages/quereus/test/optimizer/key-set-seek.spec.ts
  - packages/quereus/test/optimizer/index-nested-loop.spec.ts
  - packages/quereus/test/plan/cast-seek-blocking.spec.ts
  - packages/quereus/test/logic/08.4-key-set-semi-join.sqllogic
  - packages/quereus-store/test/key-set-seek-store.spec.ts
  - packages/quereus-isolation/test/key-set-seek-merge.spec.ts
  - docs/types.md, docs/optimizer.md, docs/optimizer-rules.md, docs/optimizer-joins.md
---

## What shipped

`ruleKeySetSeek` (`where col in (select …)` → `KeySetSemiJoinNode` multi-seek) and the
index-nested-loop candidate builder both carried a byte-identical gate refusing any
equi-pair whose two columns were declared with different logical types. Both now call one
shared predicate, `sharesSeekKeySpace(a, b)` in `src/types/builtin-types.ts`:

- identical types (compared by `name`, exactly as the replaced gate did) → true;
- any pair drawn from `INTEGER` / `REAL` / `NUMERIC` → true;
- everything else → false.

The numeric whitelist is object identity against the three registry singletons, not
`type.isNumeric` — a plugin-registered numeric type supplies its own `compare`, which is
what a memory-table BTree over such a column is ordered by, while the probe side keys by
storage class. `BOOLEAN` is excluded for the same reason.

The key value is never coerced. `INTEGER_TYPE.parse(1.5)` truncates to `1`, and on the
plan-time literal `IN` path the predicate is reported fully handled, so no residual would
survive to reject the resulting `i = 1` row. A `NOTE:` at that site
(`rule-select-access-path.ts`) records why.

Docs updated: `docs/types.md` gained a "numeric seek key space" section; the three
optimizer docs had their decline lists corrected.

## Review findings

### Verified as claimed

- **Build / lint / typecheck / tests.** `yarn build`, `yarn lint`, `yarn typecheck` all
  clean. `yarn test`: **8552 passing, 13 pending, 0 failing** in `packages/quereus`, all
  other workspaces green (up from 8551 — one test added below). `packages/quereus-isolation`
  372 passing (up from 371). No pre-existing failures surfaced, so no
  `.pre-existing-error.md` was written. `yarn test:store` was **not** re-run in this pass —
  the implement stage ran it green (8543 passing / 21 pending / 0 failing) and this pass
  touched no backend-specific code, only a comment plus two backend-independent tests.
- **The BOOLEAN exclusion rationale is real, not defensive hand-waving.**
  `BOOLEAN_TYPE.compare` (`builtin-types.ts:252`) is `a === b ? 0 : a ? 1 : -1`, so
  `compare(1, true)` and `compare(true, 1)` both return `1` — not merely a disagreeing
  order but an asymmetric one. Excluding BOOLEAN is required.
- **The gate's downstream consumers are safe with a cross-type pair.** `resolveSeekColumns`
  returns `targetType` / `keyType`, and the only later use is
  `effectiveCollationOfTypes(targetType, keyType)`; collation applies to TEXT only, so a
  numeric cross-type pair cannot reach a collation conflict.
- **Seek-key ordering agrees with index order across the type boundary.** The emitter sorts
  seek keys with `compareSqlValuesFast` (`emit/key-set-semi-join.ts:165`), which buckets
  `number`, `bigint` and `boolean` into one NUMERIC storage class and orders them by true
  magnitude — the same order `INTEGER_TYPE.compare` / `compareNumericWithNaN` give the
  memory BTrees and `encodeNumeric` gives the store's key bytes. This is what keeps the
  order-sensitive isolation primary-key merge correct, and it is now pinned (below).
- **No third gate site was missed.** The only other `logicalType.name` comparison in a
  planner rule is `isValueFaithfulPair` (`rule-scalar-agg-decorrelation.ts:643`), which
  answers a *different* question — whether substituting one column reference for another
  preserves rendered values. `10` and `10.0` are `=`-equal but render differently, so that
  gate correctly stays name-based and must not adopt `sharesSeekKeySpace`.

### Found and fixed in this pass

- **The acknowledged isolation PRIMARY-KEY merge gap is now covered.** Added
  `packages/quereus-isolation/test/key-set-seek-merge.spec.ts` §
  "merges staged rows against an out-of-order CROSS-TYPE key set": REAL keys emitted out of
  primary-key order against an `INTEGER` primary key, with a staged update and a staged
  delete, plus a non-integral key (`2.5`) that a coercion-based implementation would
  collapse onto pk 2. It asserts the underlying really served a `_primary_` `plan=5`
  multi-seek, so it cannot pass vacuously on a scan. Passes.
- **The identity whitelist depended on an untested registry invariant.**
  `isSeekKeySpaceNumeric` compares by object identity, so the feature reaches `bigint`,
  `double`, `decimal`, `int`, `float`, … columns only because `types/registry.ts` aliases
  every one of those spellings to the same three singletons. Nothing tested that. Give
  `DOUBLE` its own look-alike object and both rewrites silently stop firing for it, with no
  test failing. Added `type-system.spec.ts` §
  "holds for the numeric type ALIASES, which resolve to the same singletons" covering all
  8 aliases pairwise plus a TEXT decline.
- **The NaN NOTE overstated reachability.** It reasons at length about NaN seek keys without
  saying whether one can occur. Measured: `0.0/0.0`, `1e308*1e308`,
  `(1e308*1e308)-(1e308*1e308)`, `sqrt(-1)` and `cast(9e999 as real)` all evaluate to NULL;
  `cast('nan' as real)` yields `0`; and a JS `NaN` bound as a parameter is stored as NULL.
  Only a plugin type, custom module or UDF can mint one. Appended that measurement to the
  NOTE so the next reader can judge priority without re-deriving it.

### Examined and deliberately not filed

- **NaN seek key against an `INTEGER`-declared column** (the implementer asked for a second
  opinion on whether this is a `bug-`). It is not. `INTEGER_TYPE.compare` has no NaN arm, so
  `compareNumericValues(NaN, x)` returns `0` and the comparator ranks NaN equal to
  everything — but the correct answer for a NaN key is *zero rows* (`NaN = x` is false for
  all x, and `INTEGER_TYPE.validate` rejects NaN so no row can hold one), which makes an
  under-fetch impossible by construction: there is nothing to miss. Every extra row the
  inconsistent comparator surfaces is trimmed by the unconditional probe (key-set path) or
  the retained ON condition (index-NL path). Combined with the reachability measurement
  above, it is neither new nor reachable through SQL. Recorded as a tripwire in the existing
  `NOTE:` at `rule-key-set-seek.ts` `resolveSeekColumns`, not as a ticket.
- **Same-type arm compares `name`, not identity.** Carried forward verbatim from the gate it
  replaced, and already documented at the site. Reaching it requires a plugin overwriting a
  builtin type name in the global registry, which `registerType` warns about. Genuinely
  conditional — tripwire, already parked in the code comment on `sharesSeekKeySpace`.
- **Tests mutate the process-global type registry.** `db.registerType('KSSNUM')` /
  `'INLNUM'` land in `types/registry.ts`'s module-level `typeRegistry` with no unregister.
  Real, but pre-existing precedent in `type-system.spec.ts`, the names are collision-proof,
  and the underlying issue — a `Database`-instance method writing into a process-global
  registry — is a design question far wider than this diff. Not filed as part of this
  ticket; if it is ever worth a ticket, the root cause is `Database.registerType`
  delegating to a module singleton, not these two specs.
- **No test asserts the new decline log wording.** Correct call: log strings are not a
  contract, and the rules' declines are asserted on plan shape.
- **`where i in (1.5)` pins rows only, not plan shape.** A single-element `IN` takes the
  plain equality-seek arm rather than the multi-seek arm, so a plan-shape assertion there
  would pin the wrong thing. The multi-element cases in the same describe block cover the
  seek shape.

### Not found

- No correctness defect in the shipped predicate or either gate site.
- No source-hygiene problem: `builtin-types.ts` is 410 lines, `rule-key-set-seek.ts` 418,
  `index-nested-loop.ts` 360 — all well inside the repo's norms, and the added surface is
  two short functions whose bulk is documentation.
- No stale docs: every file the change touched, plus `docs/types.md` which it *should* have
  touched, was read and reflects the new behaviour.
