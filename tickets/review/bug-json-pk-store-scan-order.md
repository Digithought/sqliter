---
description: A disk-stored table with a JSON primary key showed a just-updated row twice (and a just-deleted row as still present) inside a transaction; fixed by storing JSON keys in a byte form that sorts the same way the database compares JSON. Review the new encoder and its wiring.
files:
  - packages/quereus-store/src/common/json-key.ts        # NEW — structural JSON key encoder + order argument
  - packages/quereus-store/src/common/store-table.ts     # storeSemanticKeyTransform, resolve*KeyTransforms, validateSemanticKeyTransforms (DDL guard), comment updates
  - packages/quereus-store/src/common/encoding.ts        # writeSortableDouble extracted; KeyValueTransform / encodeObject / decodeObject doc updates
  - packages/quereus-store/src/common/store-module.ts    # keyTransformChanged + assertNoDuplicateRows now use the store-local transform resolver
  - packages/quereus-store/src/common/index.ts           # exports storeSemanticKeyTransform, jsonStructuralKey
  - packages/quereus-store/test/json-key.spec.ts         # NEW — unit corpus sweep + identity/rejection edges
  - packages/quereus-store/test/json-semantic-key-order.spec.ts  # NEW — SQL-level order/identity + isolation repro
  - packages/quereus-store/test/lone-surrogate-keys.spec.ts      # new declared-json rejection cases
  - packages/quereus-store/test/any-json-pk-binary-key.spec.ts   # comment updates only (assertions unchanged)
  - docs/types.md                                        # "Semantic ordering" + JSON "Keys" bullet rewritten
  - tickets/backlog/feat-reopen-timespan-store-seeks.md  # JSON now re-openable on the same terms
---

# JSON primary key: structural store key bytes — review handoff

## What was wrong

The isolation layer merges a transaction's pending writes against committed rows as two
sorted streams, aligned by a primary-key comparator (the JSON type's structural
`compare`). The store scanned JSON keys in canonical-JSON-**text** byte order (`[10]`
before `[2]`), the overlay emitted them structurally, the merge lost alignment, and a
pending row stopped shadowing its committed image: an in-transaction UPDATE surfaced the
row twice, an in-transaction DELETE left it visible. Self-corrected at commit; every read
inside the transaction was wrong.

## What was built

- **`json-key.ts`** — `jsonStructuralKey`, a `KeyValueTransform` mapping a JSON value to
  a tagged, self-delimiting byte form whose memcmp order reproduces the structural
  deep-compare (tag rank null < boolean < number < string < array < object; sortable
  IEEE-754 doubles; escaped 0x00-terminated UTF-8 strings; terminator-below-every-tag
  length tiebreaks; objects as a marker-prefixed sorted key section then values). The
  module header carries the full order argument. It returns a `Uint8Array`, so
  `encodeValue` routes it down the existing BLOB path — order-preserving,
  DESC-inversion-safe, prefix-seek-safe; no key-production site changed.
- **`storeSemanticKeyTransform`** (store-table.ts) — the store-local seam the ticket
  called for: JSON → structural encoder, everything else → the engine's
  `semanticKeyTransform` (TIMESPAN's `groupKey`). `resolvePkKeyTransforms` /
  `resolveIndexKeyTransforms` now resolve through it, which covers every key site (data
  keys, index keys + PK suffixes, prefix bounds, rekey, streaming index build).
- **DDL guard** — `validateSemanticKeyTransforms` (called with `validateKeyCollations`
  at construct + `updateSchema`): a semantic-ordering PK/index member with neither a
  `groupKey` nor a store encoder now raises at CREATE TABLE instead of silently keying
  in the wrong order. It can only check a transform EXISTS, not that it is
  order-preserving — documented in its comment.
- **ALTER consistency** — `keyTransformChanged` (SET DATA TYPE re-key/rebuild trigger)
  and `assertNoDuplicateRows` (ALTER-time UNIQUE re-validation) switched from the
  engine's `semanticKeyTransform` to the store resolver, so a json↔other retype is
  treated as a key-byte change and both UNIQUE validators sign JSON identically.
- **Decode story**: documented asymmetry, no decoder — a structural key decodes as a
  `Uint8Array` blob. Chosen because `decodeCompositeKey` has no `src/` callers;
  commented at both `decodeObject` and the json-key.ts header.
- Docs: types.md "Semantic ordering" and the JSON "Keys" bullet now state the structural
  byte form; `feat-reopen-timespan-store-seeks` no longer claims the read-side declines
  "remain required for JSON" (they are conservative for both types now).

## Validation performed

- `yarn workspace @quereus/store test` — 1002 passing, 0 failing (978 pre-ticket + 24 new).
- `yarn test` — all workspaces green.
- `yarn test:store` — 7174 passing, 19 pending, 0 failing (matches the fix-stage spike).
- `yarn lint`, `yarn typecheck`, `yarn build` — clean.
- The exact repro (in-transaction UPDATE → 3 rows not 4; DELETE → 2 rows not 3; plain
  scan `[2],[3],[10]`) is pinned in `json-semantic-key-order.spec.ts`, plus: six-kind
  rank order, nested recursion, length tiebreaks, `{}` vs `{"":0}`, reorder-equal object
  PK/UNIQUE identity (memory table as oracle), DESC PK reverse iteration, composite
  `(int, json)` PK shadowing inside an equal-integer group, overlay rewrite with
  reordered key spelling. `json-key.spec.ts` sweeps a ~45-value corpus pairwise against
  `createTypedComparator(JSON_TYPE, BINARY_COLLATION)` — the comparator the isolation
  merge actually uses — and pins identity edges (2/2.0/2n/-0, reorder-equal objects,
  code-point key sort, `[Infinity]` ≠ `[null]`).

## Things the reviewer should know

- **On-disk format change.** JSON PK / index key members now encode structurally; an
  existing store holding JSON-keyed rows is not readable by the new code. Per AGENTS.md,
  backwards compatibility is explicitly not a concern yet.
- **Behavior change: lone surrogates in JSON keys are now rejected.** The canonical-text
  form was accidentally safe (JSON.stringify escapes them to ASCII); the structural form
  keys real UTF-8 and raises via `assertNoUnpairedSurrogate`, matching the documented
  text-key divergence. Pinned in `lone-surrogate-keys.spec.ts` (a declared-`json` key
  raises; an `any` key holding JSON still accepts; memory accepts).
- **JSON is matched by type NAME, not object identity.** `type === JSON_TYPE` failed
  under `yarn test:store`, where the engine runs from `src` (ts-node) while the store
  resolves `@quereus/quereus` to `dist` — two module instances, two JSON_TYPE
  singletons. The DDL guard caught this loudly (its exact purpose). The lookup now
  matches `hasSemanticOrdering(type) && type.name === 'JSON'`; a hostile/custom
  semantic-ordering type named 'JSON' would take the structural encoder.
- **Known gaps in test coverage** (honest floor, not a finish line):
  - The DDL guard's raise path is unreachable with today's types and has no unit test
    (would need a synthetic LogicalType with `semanticOrdering` and no `groupKey`).
  - The ALTER `keyTransformChanged` json path (retyping a UNIQUE/indexed column
    json↔text) has no direct test; the timespan ALTER tests cover the shared machinery.
  - `assertNoDuplicateRows`' switch fixes a fringe where ALTER-time UNIQUE
    re-validation signed `[1e400]` and `[null]` identically (JSON.stringify renders
    Infinity as `null`); untested.
- **Not addressed (pre-existing engine behavior, observed while testing):**
  - `where j = '<json text literal>'` matches nothing on EITHER backend (storage-class
    mismatch in the generic EQ path — JSON column vs TEXT probe). The new tests address
    rows through other columns. Also `where j = json('…')` trips an unrelated planner
    error ("Unknown literal type object" in the cache layer's reference graph) —
    reviewer may want a ticket for one or both.
  - Bare `JSON_TYPE.compare` with no collation argument re-parses JSON-parseable string
    leaves (`'9'` vs `'10'` compares 9 < 10 numerically, and cross-kind falls back to
    canonical-text compare, which is not even transitive). Every store-relevant path
    passes a collation, so byte order matches what the isolation merge and memory BTree
    actually do; NOTE recorded in the json-key.ts header.
- **Read-side declines untouched** (per ticket scope): `keyOrderMatchesCollation` still
  returns false for semantic-ordering members, so `order by j` runs a real Sort and
  point/range predicates full-scan + residual. Comments there and in
  `pkHasSemanticOrderingMember` now say "conservative", pointing at the backlog slug.

## Suggested review probes

- Attack the order argument in json-key.ts: any pair of JSON values whose byte order
  could diverge from `createTypedComparator(JSON_TYPE, BINARY_COLLATION)` — the corpus
  sweep is only as good as its corpus (deep nesting, empty containers inside containers,
  astral/combining-character keys, huge/denormal doubles).
- Confirm no key-production site bypasses the transform plumbing (search for
  `encodeCompositeKey` / `buildDataKey` / `buildIndexKey` callers that pass no
  transforms).
- Judge whether the two pre-existing engine quirks above deserve tickets.
