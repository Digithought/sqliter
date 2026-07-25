---
description: A table stored on disk whose primary key is a JSON value returns the same row twice inside a transaction after you update it, and a row you deleted inside a transaction is still visible; fix by storing JSON keys in a byte form that sorts the same way the database compares JSON.
files:
  - packages/quereus-store/src/common/json-key.ts        # NEW — structural JSON key encoder
  - packages/quereus-store/src/common/store-table.ts     # resolvePkKeyTransforms / resolveIndexKeyTransforms; keyOrderMatchesCollation comment
  - packages/quereus-store/src/common/encoding.ts        # encodeObject / KeyValueTransform docs
  - packages/quereus/src/types/json-type.ts              # deepCompareJson — the order to reproduce
  - packages/quereus/src/util/comparison.ts              # compareCodePoints (exported from @quereus/quereus); OBJECT-class compare (unchanged)
  - packages/quereus-store/test/any-json-pk-binary-key.spec.ts  # existing JSON-PK ordering assertions
  - packages/quereus-store/test/timespan-semantic-key-identity.spec.ts  # shape to mirror for the new JSON spec
  - docs/types.md                                        # "Semantic ordering" — currently points at this ticket
  - tickets/backlog/feat-reopen-timespan-store-seeks.md  # says the read-side declines "remain required for JSON" — no longer true after this
difficulty: hard
---

# JSON primary key: give the store key bytes that sort structurally

## Reproduced

Confirmed live against the in-memory KV provider (not a LevelDB quirk):

```sql
create table t (j json primary key, v int) using istore;
insert into t values ('[2]', 1), ('[10]', 2), ('[3]', 3);
```

- Plain scan emits `[10], [2], [3]` — canonical-JSON-**text** byte order.
- `order by j` emits `[2], [3], [10]` — structural order (a real Sort runs, so this is
  already right).
- `begin; update t set v = 99 where v = 1; select j, v from t;` → **4 rows**: the
  updated row appears in both its new and its committed form.
- `begin; delete from t where v = 1; select j, v from t;` → **3 rows**: the deleted row
  is still visible.

Both self-correct after `commit`, so nothing is corrupted on disk — but every read
inside the transaction is wrong.

## Why

The isolation layer merges the pending-writes overlay against the committed rows as two
**sorted** streams and uses a primary-key comparator to decide which pending row shadows
which committed row (`IsolatedTable.mergedQuery` → `mergeStreams`). `StoreTable` exposes
no `comparePrimaryKey`, so the isolation layer falls back to comparing by the column's
declared logical type — `JSON_TYPE.compare`, which is structural. The store's stream
arrives in canonical-text byte order. The two orders disagree, the merge loses alignment,
and a pending row stops shadowing the committed row it replaces.

## Decision: make the store's JSON key bytes order-preserving

Of the four options the fix ticket listed, take the first — encode a JSON key member in a
tagged, length-aware **structural** byte form whose memcmp order reproduces
`deepCompareJson` exactly.

Rationale:

- It fixes the defect at its source rather than papering over the merge. Once the store's
  byte order *is* the type's order, the isolation layer needs no change at all, and any
  future consumer that assumes "the store scans in primary-key order" (that assumption is
  a documented contract on underlying modules — see `docs/design-isolation-layer.md`)
  stays correct.
- It matches the shape of the fix this project already chose for TIMESPAN in
  `duration-json-semantic-ordering-store`: encode the key so byte order *is* semantic
  order, then reopen the read-side optimizations separately.
- It removes, rather than entrenches, the JSON-shaped exception in
  `keyOrderMatchesCollation` / `pkOrderPreservingPrefixLength`.

Options **not** taken:

- *Have `StoreTable` publish a `comparePrimaryKey` matching its byte order* — the overlay
  is a memory table that emits structurally, so both streams still disagree.
- *Have the isolation layer stop assuming a shared order for semantic-ordering key
  columns* — cheapest, but leaves the store's scan order permanently divergent from the
  memory backend and keeps the read-side declines permanent.
- *Reject JSON primary keys in the store* — a real regression in capability; the memory
  backend supports them.

### Verified by spike

A rough prototype of exactly this design was built and thrown away during the fix stage.
With it in place:

- the repro above emits 3 rows for the update case and 2 for the delete case, and the
  plain scan emits `[2], [3], [10]`;
- `packages/quereus-store` unit tests: **978 passing, 0 failing**;
- `yarn test:store` (quereus logic tests against the LevelDB backend): **7174 passing, 19
  pending, 0 failing**.

So the design is sound and the blast radius is small. The work below is about landing it
properly (naming, decode symmetry, guards, docs, tests) rather than discovering whether it
works.

## The encoding

Reproduce `deepCompareJson` (packages/quereus/src/types/json-type.ts): type rank
`null < boolean < number < string < array < object`, then element-wise recursion with a
length tiebreak; string leaves and object keys order by Unicode **code point**.

Tag bytes (note `0x00` is reserved as a terminator, so no value tag may be `0x00`):

| tag    | node    | body                                                         |
|--------|---------|--------------------------------------------------------------|
| `0x01` | null    | (none)                                                        |
| `0x02` | boolean | one byte, `0x00` false / `0x01` true                          |
| `0x03` | number  | 8-byte sortable IEEE-754 double (the existing `encodeNumeric` primary transform: big-endian, all bits flipped when negative, sign bit only otherwise; `-0` normalized to `+0`) |
| `0x04` | string  | UTF-8, escaped and `0x00`-terminated (reuse encoding.ts's escape scheme: `0x00`→`0x01 0x01`, `0x01`→`0x01 0x02`) |
| `0x05` | array   | each element's own self-delimiting encoding concatenated, then `0x00` |
| `0x06` | object  | key section, then value section (see below)                   |

Object body: for each key in code-point-sorted order emit `0x01` + escaped UTF-8 key +
`0x00`; then `0x00` to end the key section; then each value's encoding in that same key
order. The per-key `0x01` marker is required — without it an object whose first key is the
empty string is indistinguishable from an object with no keys at that byte position.

Why the order is right:

- Different node kinds differ at the tag byte, and tag order is JSON rank order.
- Same-kind nodes have structurally identical, self-delimiting bodies, so the first
  differing byte is always a meaningful comparison (the standard order-preserving
  composite-key argument; the fixed-width 8-byte double body can contain `0x00` safely for
  exactly this reason).
- Array/key-section prefix cases: the terminator `0x00` is below every tag/marker
  (`>= 0x01`), so a proper prefix sorts first — matching `deepCompareJson`'s length
  tiebreak.
- UTF-8 byte order equals code-point order, and the escape map is monotonic, so string
  leaves and object keys order as `compareCodePoints` does.

Identity is preserved or improved versus today's canonical text: object keys are sorted,
`2` and `2.0` are the same double, and `1e400` (which `JSON.stringify` renders as the
string `null`, colliding with a genuine JSON `null`) becomes a distinct `+Infinity` double.

### How it plugs in

Ship it as a store-local `KeyValueTransform` that returns a `Uint8Array`. Two consequences
make this the right seam:

- `encodeValue` already routes a `Uint8Array` down the BLOB path (tag + escape +
  terminator), which is order-preserving, DESC-inversion-safe, and prefix-seek-safe. No
  change to `encodeValue` itself.
- The transform mechanism (`resolvePkKeyTransforms` / `resolveIndexKeyTransforms`) is
  already threaded through **every** key-producing site: data keys, secondary-index keys
  and their PK suffixes, PK-prefix bounds, `rekeyRows`, and the streaming index build. One
  registry entry covers them all.

`resolvePkKeyTransforms` today just delegates to the engine's `semanticKeyTransform`
(`logicalType.groupKey`). JSON has no `groupKey` and should not get one — `groupKey` also
drives GROUP BY / `IN` / hash-join identity in the engine, where a `Uint8Array` key would
be a behaviour change for no benefit (canonical-text identity is already correct there).
So add a **store-local** lookup that returns the structural encoder for the JSON logical
type and otherwise falls through to `semanticKeyTransform`.

### Do NOT change

`encodeValue`'s generic object branch (`encodeObject`, canonical JSON text under
`TYPE_OBJECT`) must stay as-is. It serves `any`-typed columns holding JSON objects, whose
ordering oracle is `compareSqlValues`' OBJECT-class branch — which compares by canonical
string, by code point (packages/quereus/src/util/comparison.ts, `StorageClass.OBJECT`).
Changing it would break `any` columns and `any-json-pk-binary-key.spec.ts`. Only columns
whose **declared logical type** is JSON take the structural transform.

## Scope notes

- **On-disk format changes** for JSON PK / index key members. Per AGENTS.md backwards
  compatibility is not a concern yet; an existing LevelDB store holding JSON-keyed rows
  would not be readable by the new code. Say so in the review handoff.
- **Read-side declines stay.** `keyOrderMatchesCollation` returns false for every
  semantic-ordering member; leave that. After this lands the decline is merely
  conservative for JSON (costing a seek/sort-elision, never a row) exactly as it already
  is for TIMESPAN — so update the comments there and amend
  `tickets/backlog/feat-reopen-timespan-store-seeks.md`, which currently asserts the
  declines "remain required for JSON". Do not widen the seeks in this ticket.
- **Decoding.** `decodeCompositeKey` / `decodeValue` have no `src/` callers (only tests
  and the barrel re-export), so a structural key decodes as a `Uint8Array` blob rather
  than back to a JSON value. Either add a matching decoder or state the asymmetry in a
  code comment; do not leave it undocumented.
- **Lone surrogates.** `TextEncoder` folds every unpaired surrogate to U+FFFD, which would
  merge distinct string leaves onto one key. Today `encodeObject` is safe from this only
  because `JSON.stringify` escapes lone surrogates into ASCII; a structural encoder loses
  that. Raise via `assertNoUnpairedSurrogate` on each string leaf and object key, matching
  the deliberate divergence `encodeText` already documents, and cover it in
  `lone-surrogate-keys.spec.ts`.
- **Sort object keys with `compareCodePoints`** (exported from `@quereus/quereus`), not
  the default `Array.prototype.sort` — `deepCompareJson` sorts with `compareCodePoints`,
  and the two differ for astral keys. The spike used the naive comparator; don't copy it.

## Expected behavior once fixed

- A pending update to a JSON-keyed row replaces the committed row in every read inside the
  transaction — never both.
- A pending delete of a JSON-keyed row hides it for the rest of the transaction.
- A plain `select` of a JSON-keyed store table agrees with the in-memory backend on which
  rows exist, and now also on their order.
- `order by j` is unchanged (a real Sort still runs).

## TODO

### Phase 1 — encoder

- Add `packages/quereus-store/src/common/json-key.ts` with the structural encoder above.
  Keep it small and decomposed (per-node-kind push helpers), document the order argument
  in the module header, and cross-reference `deepCompareJson`.
- Guard string leaves and object keys with `assertNoUnpairedSurrogate`.
- Sort object keys with the engine's `compareCodePoints`.
- Decide and implement the decode story (matching decoder, or an explicit comment on the
  asymmetry at both `decodeObject` and the new module).

### Phase 2 — wire into key production

- Add the store-local transform lookup used by `resolvePkKeyTransforms` and
  `resolveIndexKeyTransforms`: JSON logical type → structural encoder, else
  `semanticKeyTransform`.
- Add a guard so a future semantic-ordering logical type cannot silently land here with
  neither an order-preserving `groupKey` nor a registry entry — this defect existed
  because that gap was undetectable. A DDL-time raise (alongside `validateKeyCollations`)
  is the natural home.
- Update the `resolvePkKeyTransforms` doc comment: it currently names this ticket as an
  open defect and states JSON has no transform.

### Phase 3 — tests

- New `packages/quereus-store/test/json-semantic-key-order.spec.ts`, modelled on
  `timespan-semantic-key-identity.spec.ts`, with a memory table as the oracle. Cover:
  arrays `[2] < [3] < [10]`; cross-rank ordering across all six JSON kinds in one column;
  nested arrays and objects; the array/object length tiebreak; object key-order
  independence (`{"a":1,"b":2}` is the same key as `{"b":2,"a":1}`); an object with an
  empty-string key beside one with no keys.
- Isolation cases: in-transaction update surfaces one row, in-transaction delete hides the
  row, and a JSON-keyed row rewritten in the overlay shadows its committed image — the
  exact repro above, plus a composite `(int, json)` primary key where the divergence only
  shows inside an equal-integer group.
- Unit-level round trip / order assertions on the encoder in `encoding.spec.ts` (or a
  sibling), including a `primary key (j desc)` table so the DESC bit-inversion path is
  exercised.
- Lone-surrogate rejection case in `lone-surrogate-keys.spec.ts`.
- Confirm `any-json-pk-binary-key.spec.ts` still passes untouched apart from any comment
  that asserts the old text order; an `any` column holding objects must be unaffected.

### Phase 4 — docs and cross-references

- `docs/types.md` "Semantic ordering": replace the paragraph pointing at this ticket with
  a statement that store JSON key members encode structurally and therefore scan in
  `compare` order.
- `packages/quereus-store/src/common/encoding.ts`: update the `KeyValueTransform` and
  `encodeObject` doc comments — say which columns take the structural transform and why
  the generic OBJECT path stays canonical text.
- `keyOrderMatchesCollation` comment in `store-table.ts`: the JSON decline is now
  conservative, not required.
- `tickets/backlog/feat-reopen-timespan-store-seeks.md`: drop the "remain required for
  JSON" claim and note JSON is now re-openable on the same terms.

### Phase 5 — validate

- `yarn workspace @quereus/store test`
- `yarn test`
- `yarn test:store` (this is the suite that exercises the real store path; it ran clean
  against the spike)
- `yarn lint` / `yarn typecheck`
