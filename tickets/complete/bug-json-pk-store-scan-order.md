---
description: A disk-stored table with a JSON primary key showed a just-updated row twice (and a just-deleted row as still present) inside a transaction; fixed by storing JSON keys in a byte form that sorts the same way the database compares JSON. Reviewed and shipped.
files:
  - packages/quereus-store/src/common/json-key.ts        # structural JSON key encoder + order argument
  - packages/quereus-store/src/common/store-table.ts     # storeSemanticKeyTransform, resolve*KeyTransforms, validateSemanticKeyTransforms
  - packages/quereus-store/src/common/encoding.ts        # writeSortableDouble, KeyValueTransform docs
  - packages/quereus-store/src/common/key-builder.ts     # NOTE: prefix-bounds callers pass no transforms
  - packages/quereus-store/src/common/store-module.ts    # keyTransformChanged + assertNoDuplicateRows use the store resolver
  - packages/quereus-store/test/json-key.spec.ts         # corpus sweep + seeded differential sweep (added in review)
  - packages/quereus-store/test/json-semantic-key-order.spec.ts  # SQL-level order/identity + isolation repro
  - packages/quereus-store/test/lone-surrogate-keys.spec.ts      # declared-json rejection cases
  - docs/types.md                                        # "Semantic ordering" + JSON "Keys"
  - docs/store.md                                        # lone-surrogate guard, per-column key collation, file list (fixed in review)
---

# JSON primary key: structural store key bytes — completed

## What shipped

The persistent store now encodes a primary-key or index-key member whose column is
declared `json` into a **structural byte form** (`jsonStructuralKey`, json-key.ts): a
tagged, self-delimiting encoding whose memcmp order reproduces the JSON type's
structural deep-compare (rank `null < boolean < number < string < array < object`,
sortable IEEE-754 doubles, code-point-ordered UTF-8 strings, terminator-below-every-tag
length tiebreaks, objects as a sorted key section then values). Previously the store
keyed JSON as canonical JSON **text**, which scans `[10]` before `[2]`; the isolation
layer merges pending writes against committed rows as two sorted streams aligned by the
type's comparator, so the misordered stream lost alignment and a pending row stopped
shadowing its committed image — an in-transaction UPDATE surfaced the row twice, a
DELETE left it visible. Every read inside the transaction was wrong; commit
self-corrected.

Supporting pieces: a store-local transform resolver (`storeSemanticKeyTransform`) that
routes JSON to the structural encoder and everything else to the engine's `groupKey`,
threaded through every key-production site; a DDL-time guard that rejects a
semantic-ordering key member with no transform at all; `writeSortableDouble` extracted
from `encodeNumeric` and shared; and ALTER-path consistency (`keyTransformChanged`,
`assertNoDuplicateRows`).

Two deliberate consequences, both documented: the on-disk key format for JSON changed
(pre-existing JSON-keyed stores are unreadable — backwards compatibility is explicitly
not a concern yet per AGENTS.md), and a lone surrogate inside a declared-json key value
is now rejected at write time, matching the same divergence `encodeText` already
documents for text keys.

## Review findings

### Checked

- **Read the implement diff first**, then the handoff. Re-derived the order argument in
  json-key.ts against the engine's `deepCompareJson` (`packages/quereus/src/types/json-type.ts`)
  line by line — in particular that objects compare their **whole key sequence first**
  (with the length tiebreak) and only then their values, which is exactly what the
  encoder's "key section, terminator, value section" layout produces. A layout that
  interleaved key/value pairs would have been wrong; this one is right.
- **Attacked the corpus** as the handoff suggested. The hand-written corpus sweep only
  proves the shapes its author thought of, so a **seeded differential sweep** was added
  to `json-key.spec.ts`: a deterministic generator draws 400 values from every node kind
  to nesting depth 4 (including empty containers, astral and combining-character object
  keys, denormals, `1e-320`, ±huge, `Infinity`, prefix-colliding strings) and asserts
  memcmp order **and** byte identity against `createTypedComparator(JSON_TYPE, BINARY_COLLATION)`
  for all 160 000 ordered pairs. No divergence. A one-off run at 700 values × depth 5
  also found none (kept at 400/4 so the suite stays fast).
- **Key-production bypass hunt.** Every `encodeCompositeKey` caller goes through
  `key-builder.ts`; `buildDataKey`, `buildIndexKey` (both halves), `buildPkPrefixBounds`,
  rekey, and streaming index build all thread transforms.
- Ran `yarn build`, `yarn lint`, `yarn typecheck`, `yarn test` (all workspaces green),
  and `yarn test:store` (7174 passing, 19 pending, 0 failing). `@quereus/store` alone:
  1003 passing.

### Found and fixed in this pass (minor)

- **`docs/store.md` was stale** — it still claimed "Object/JSON keys need no such guard:
  their bytes come from `JSON.stringify`, which escapes a lone surrogate to ASCII." That
  is now true only for an `any` column holding an object; a declared-`json` member keys
  real UTF-8 and raises. Rewritten, plus a note that a declared-json member takes no
  collation at all (its `Uint8Array` goes down the BLOB path, so no normalizer runs), and
  `json-key.ts` added to the package file list. The implement stage updated
  `docs/types.md` but missed this file.
- **An inaccurate claim in json-key.ts's header** — "no store path invokes [the
  collation-less comparator] that way". Two do (see below). Corrected to name them and
  point at the new ticket.

### Found and filed as tickets (major)

- **`fix/bug-json-pk-equality-drops-collation`** — the store's `resolvePkSemanticEquality`
  and the isolation layer's `getPkSemanticComparators` build the primary-key equality
  comparator with **no collation**, and collation-less `JSON.compare` re-parses a JSON
  string leaf. So the two distinct JSON string scalars `'"9"'` and `'"9.0"'` answer "same
  row", and self-PK exclusion swallows a genuine UNIQUE violation: a store table accepts
  a second row under a `unique` column that the same table in memory correctly rejects.
  Verified with a direct repro. **Pre-dates this ticket** (canonical-text key bytes
  disagreed with these comparators the same way) and is not a regression, but it is the
  same class of defect this ticket fixed and is reachable today. A pointer comment now
  sits at the store-side call site.
- **`backlog/bug-json-column-not-matchable-in-where`** — the handoff flagged that
  `where j = '<json text>'` matches nothing and `where j = json('…')` raises
  "Unknown literal type object". Confirmed on **both** backends, and additionally that
  `where json_quote(j) = '<text>'` also returns nothing. Together these mean a JSON
  column has no working equality predicate at all, which is worth a ticket: the handoff
  asked for that judgement and the answer is yes.
- **`backlog/bug-json-text-scalar-reparsed-on-write`** — found while probing the above.
  `JSON_TYPE.parse` re-parses values that are already native, so a JSON string scalar
  whose text is itself valid JSON is not stable: insert `'"9"'`, update an unrelated
  column, and the primary key silently becomes the **number** 9. Reproduces on the
  memory backend too, so it is engine-level and outside this ticket's diff.

### Recorded as tripwires (conditional — no ticket)

- `analyzeIndexAccess` and `buildIndexRangeBounds` call `buildIndexPrefixBounds` with
  **no key transforms**. Sound today only because both arms decline semantic-ordering
  columns before reaching it. If `feat-reopen-timespan-store-seeks` re-opens either arm
  without threading transforms, the window addresses raw-value bytes while the index
  holds transformed ones — a silently under-fetching seek. Parked as a `NOTE:` on
  `buildIndexPrefixBounds` (key-builder.ts) and as a bullet in that backlog ticket.
- `jsonStructuralKey` accumulates into a `number[]` and copies once into a `Uint8Array`
  — irrelevant for normal key-sized values, worth revisiting only if large JSON keys
  become hot. Parked as a `NOTE:` at the function.

### Checked and found nothing

- **Prefix-seek / DESC-inversion safety** of the new BLOB-routed key bytes: the
  structural form is self-delimiting and terminator-suffixed, so the existing composite-key
  prefix property and per-column bit inversion both still hold. The DESC reverse-iteration
  test in `json-semantic-key-order.spec.ts` exercises it.
- **Recursion depth**: a 2000-level-deep nested JSON key inserts fine (no stack overflow
  in `pushJsonNode`), so no guard is warranted.
- **Source hygiene**: json-key.ts is 217 lines, ~95 of them the module header. That ratio
  is unusual, but the header *is* the memcmp-order-equals-`compare`-order argument, which
  is the only thing that makes the encoder auditable — and the surrounding package writes
  at the same density. Functions are short and single-purpose (`pushNumber`, `pushString`,
  `pushArray`, `pushObject`, `pushEscaped`); no restructuring warranted.
- **The handoff's declared coverage gaps** (unreachable DDL-guard raise path, untested
  ALTER json retype, untested `assertNoDuplicateRows` json path) were re-read and left as
  they are: the first is unreachable by construction, and the other two exercise shared
  machinery that the TIMESPAN equivalents already cover. Not worth a ticket.
