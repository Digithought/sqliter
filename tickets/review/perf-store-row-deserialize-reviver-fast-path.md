description: Reading a row back from a store-backed table now skips a per-cell JSON callback whenever the raw stored bytes prove that callback couldn't change anything, cutting the cost of turning stored bytes back into a row by roughly 85% in a throwaway benchmark.
files:
  - packages/quereus-store/src/common/serialization.ts
  - packages/quereus-store/test/serialization.spec.ts
difficulty: easy
----

# Review: skip the JSON reviver when a stored row cannot contain a marker

## What changed

`packages/quereus-store/src/common/serialization.ts`:

- Hoisted a module-level `decoder = new TextDecoder()`, replacing the `new TextDecoder()`
  allocated on every `deserializeRow`/`deserializeValue` call — mirrors the existing hoisted
  `textEncoder`, with a comment on why sharing it across concurrent scans is safe
  (non-streaming `decode()` is stateless per call).
- Added `hasMarkerSigil(json: string): boolean`, the single predicate (`json.includes('{"$')`)
  that decides whether the decoded text could contain a `$bigint`/`$blob`/`$json` marker
  object. Both `deserializeRow` and `deserializeValue` now pass `hasMarkerSigil(json) ? reviver
  : undefined` as `JSON.parse`'s second argument instead of always passing `reviver`.
- A `NOTE:` at the gate in `deserializeRow` records the declined write-time-flag-byte
  alternative (a persisted-format change was weighed and rejected — margin too small to
  justify a migration).
- `serializeRow`/`serializeValue`/`replacer`/`reviver`/`wrapJsonIfNeeded` are **untouched** —
  no stored-byte format change, no migration, read-side only.
- All five call sites (`store-table-scan.ts`, `store-table-base.ts`,
  `store-table-constraints.ts`, `backing-host.ts`, `store-module-index-build.ts`) were read,
  not assumed — every one calls `deserializeRow(entry.value)` in the plain single-argument
  form, so none needed edits.

## Why this is sound

`JSON.parse`'s reviver only ever transforms a marker object, and every marker the reviver
acts on is emitted by `replacer` as a single-key object, so it always serializes with the
literal `{"$` prefix (`{"$bigint":`, `{"$blob":`, `{"$json":`). A string *value* that merely
looks like a marker (`"$125 fee"`, or even the literal text `{"$bigint":"fake"}`) can never
produce that sequence unescaped in the JSON text, because `JSON.stringify` escapes the
enclosing quotes — the stored text reads `"{\"$bigint\":...}"`, which does not contain `{"$`.
So the gate has no false negatives (the only direction that could corrupt a value) and,
separately, skipping the reviver on a string is provably a no-op (the reviver only
transforms objects).

## Measured result

Throwaway benchmark (not committed, per the ticket's own instruction — no benchmark file
existed in this package to extend), 150,000 rows shaped like the ledger entry from the plan
ticket's own measurement (`text, text, text, real, text`), seeded PRNG, Node 24:

| variant | per row | vs old |
|---|---|---|
| old (`new TextDecoder()` + always reviver) | 3.106 µs | — |
| new (hoisted decoder, gated reviver) | 0.469 µs | **15.1%** (≈85% reduction) |

This exceeds the ~78% reduction measured in the plan ticket (their run, different row shape
and machine) — reported honestly as the number actually measured here, not restated as a
reproduction of the plan's figure.

## Use cases to validate

- **Property tests** (`describe('reviver fast-path gate (property)')`): two seeded-PRNG
  (mulberry32) round-trip loops, 300 iterations each, one over generated rows and one over
  generated single values, covering every `SqlValue` kind including safe/unsafe-range
  bigints, sigil-prefixed and marker-lookalike strings, blobs, plain JSON objects/arrays, and
  JSON objects/arrays with marker-colliding keys (`{ $bigint: 'not-a-bigint' }`,
  `{ $blob: 'fake' }` nested in an array, a marker nested two levels deep).
- **Edge cases** (`describe('reviver fast-path gate (edge cases)')`): empty row, all-null
  row, `TEXT` starting with `$`, `TEXT` containing the literal marker text, `TEXT` containing
  a bare `{"$` substring, a JSON column with a real `$bigint` key in both unwrapped and
  `$json`-wrapped form, a marker nested inside an array inside an object, and blob content
  with adversarial byte patterns.
- **Negative self-test** (`describe('reviver fast-path gate (negative self-test)')`): a
  locally-duplicated `deserializeRowNeverReviver` (never passes a reviver, mirroring what a
  regressed/always-false gate predicate would do) is run over a marker-bearing row and
  asserted to **not** round-trip — proving the property/edge-case tests above are actually
  sensitive to the reviver being skipped, not passing vacuously. This seam is test-local only;
  production `deserializeRow`/`deserializeValue` signatures are unchanged.

## Test results

- `yarn workspace @quereus/store run typecheck` — clean.
- `yarn workspace @quereus/store run lint` — "No lint configured" (expected; only
  `packages/quereus` has a real lint per `AGENTS.md`).
- `yarn workspace @quereus/store run test` — **1564 passing, 5 failing.** All 5 failures are
  pre-existing and unrelated to this change — see *Known gaps* below and
  `tickets/.pre-existing-error.md`.

## Known gaps — the reviewer should push here

**5 of the new tests fail, and they are left failing on purpose.** They surface a real,
pre-existing defect in `reviver`'s marker-collision handling that has nothing to do with the
gate this ticket adds — confirmed by reproducing the identical crash against the unmodified
`reviver`/`wrapJsonIfNeeded` pair directly, bypassing the new gate entirely. Root cause
(single site, `reviver` + `wrapJsonIfNeeded` in `serialization.ts`): `wrapJsonIfNeeded` only
wraps a value in `{"$json": ...}` when the value **itself** is a plain object with a
top-level `$bigint`/`$blob` key — it never wraps arrays, and never looks inside nested
objects. Separately, `JSON.parse`'s reviver walk is bottom-up, so for
`{"$json": {"$bigint": "not-a-bigint"}}` the reviver visits the inner
`{"$bigint": "not-a-bigint"}` object **before** it ever sees the outer `"$json"` key — the
inner object is misidentified as a real bigint marker and `BigInt("not-a-bigint")` throws.
The same ordering bug lets a `$blob`-shaped object nested inside a plain array silently
mis-decode as base64 into a wrong `Uint8Array` instead of throwing. Net effect: any JSON
`SqlValue` whose content happens to contain a key literally named `$bigint`, `$blob`, or
`$json` in single-key-object shape is either crashed on or silently corrupted on read-back,
at any nesting depth — the collision-proofing the module's own doc comment claims does not
actually hold. Per this repo's pre-existing-failure protocol, this is documented in
`tickets/.pre-existing-error.md` for the pipeline's triage step rather than fixed inline here
(out of scope for a read-side reviver-skip optimization, and a real fix likely needs to
either reorder/re-scope the reviver's marker checks or redesign the collision-escaping
scheme — not a one-line change). **Do not treat the 5 failing tests as something to skip,
loosen, or delete** — they are the most direct reproduction of this bug that exists in the
repo today.

**The property test is deterministically red, not flaky.** Both seeds (`0x5eed` for rows,
`0xbeef` for values) reliably draw a marker-collision value kind within 300 iterations (4 of
14 generated value kinds are collision-shaped), so the failure is 100% reproducible, not
intermittent.

**Benchmark numbers are throwaway, not committed.** Per the ticket's instruction, no
benchmark file existed in this package before, so none was added — the script used to
produce the table above was deleted after the run. Re-derive with the same row shape/PRNG
described above if the numbers need re-verification.

## Declined-alternative note left in code

`packages/quereus-store/src/common/serialization.ts`, at the `deserializeRow` gate: a
`NOTE: accepted tradeoff` records that a write-time marker flag byte was considered and
declined (small margin, would require a persisted-format version + migration) — see the
comment for the exact wording. Do not re-propose without new evidence per the note's stated
revisit condition (only worth reopening if the row codec is being changed anyway, e.g. to a
binary/columnar format).
