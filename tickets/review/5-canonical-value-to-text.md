description: The engine used to turn a value into text in several disagreeing ways, so binary data came out as decimal numbers in one place and hex digits in another, and a JSON document was silently destroyed. One conversion now exists and every place uses it; review the change.
files:
  - packages/quereus/src/util/value-text.ts                          # NEW — the one conversion
  - packages/quereus/src/types/builtin-types.ts                      # TEXT_TYPE.parse; BLOB_TYPE.parse number arm
  - packages/quereus/src/types/cast-semantics.ts                     # castFallback TEXT + BLOB arms, docstrings
  - packages/quereus/src/util/affinity.ts                            # applyTextAffinity tail + dead-module NOTE
  - packages/quereus/src/func/builtins/aggregate.ts                  # group_concat value + separator
  - packages/quereus/src/runtime/emit/binary.ts                      # emitConcatOp, emitLikeOp, constLikePattern
  - packages/quereus/test/util/value-text.spec.ts                    # NEW — per-type unit table + call-site agreement
  - packages/quereus/test/logic/03.6.2-value-to-text.sqllogic        # NEW — SQL-visible behaviour suite
  - packages/quereus/test/logic/05.2-cast-seek-correctness.sqllogic  # literals '31' → '1', comment
  - packages/quereus/test/logic/06.8-json-path-operators.sqllogic    # TWO assertions changed (see below)
  - docs/types.md                                                    # new "### Value to text" section
  - docs/functions.md                                                # text(), group_concat, like rows
  - docs/sql-select.md                                               # `||` operator entry
difficulty: medium
---

# One value-to-text conversion, used everywhere

## What landed

`packages/quereus/src/util/value-text.ts` exports `valueToText(value)` — the single
answer to "what is this value as text". Its docstring carries the per-type contract.
Every site that renders a value as text now calls it:

| site | was | now |
|---|---|---|
| `TEXT_TYPE.parse` | hex for blobs, threw for objects | `valueToText(v)`, total |
| `castFallback` TEXT arm | `String(value)` | `valueToText(value)` |
| `castFallback` BLOB arm | UTF-8 of `String(value)` | UTF-8 of `valueToText(value)` |
| `applyTextAffinity` tail | `String(value)` | `valueToText(value)` (blob passthrough kept) |
| `group_concat` value + separator | `String(...)` | `valueToText(...)` |
| `emitConcatOp` both operands | `String(...)` | `valueToText(...)` |
| `emitLikeOp` text + pattern | `String(...)` | `valueToText(...)` |
| `constLikePattern` | `String(value)` | `valueToText(value)` |

`BLOB_TYPE.parse`'s number/bigint/boolean arm also routes through `valueToText` — the
output is byte-identical to the `String(v)` it replaced, done for DRY, and its
object-rejection now carries a comment saying `castFallback` is what handles a JSON
document reaching `cast(<json> as blob)`.

## Behaviour that changed (user-visible)

| expression | before | after |
|---|---|---|
| `cast(x'6162' as text)`, `text(x'6162')` | `6162` | `ab` |
| `x'6162' \|\| ''` | `97,98` | `ab` |
| `group_concat(blob_col)` over `x'6162'`,`x'6163'` | `97,98,97,99` | `ab,ac` |
| `x'6162' like 'ab'` | false | true |
| `cast(json('{"a":1}') as text)` | `[object Object]` | `{"a":1}` |
| `cast(json('[1,2,3]') as text)` | `1,2,3` | `[1,2,3]` |
| `'{"a":{"x":1}}' ->> 'a'` | `[object Object]` | `{"x":1}` |
| `'{"a":[1,2]}' ->> 'a'` | `1,2` | `[1,2]` |
| `cast(<json> as blob)` | UTF-8 of `[object Object]` | UTF-8 of `{"a":1}` |
| `insert into t(text_col) values (x'6162')` | **stores** `6162` | **stores** `ab` |
| `alter table t alter column b set data type text` | backfills hex | backfills the UTF-8 decode |

The write-path rows are the ones with teeth: this changes *stored* values, not only
query output, and the decode is lossy for non-UTF-8 bytes. `TEXT_TYPE.parse` is reached
by `validateAndParse`, so ordinary INSERT, the ALTER retype backfill, and DEFAULT folding
all moved together. All three are covered in the new sqllogic file.

`text()` (the conversion function) also no longer throws on a JSON document, because it
is `TEXT_TYPE.parse`.

## What to test / poke at

Run: `yarn build`, `yarn test`, `yarn lint`. Store mode (`yarn test:store`) was also run
and is green — worth repeating if you touch the write path, since that is where the
memory and store coercion paths could diverge.

Behaviour suites:

- `test/logic/03.6.2-value-to-text.sqllogic` — the per-type table, the edge cases
  (empty blob → `''`; BOM → `length` 1; invalid UTF-8 → U+FFFD *and* the deliberate
  collision `cast(x'ff' as text) = cast(x'fe' as text)`; multi-byte; JSON string scalar
  renders bare; `json('null')` is SQL NULL), NULL propagation, the write path, the ALTER
  backfill, a TEXT-column DEFAULT written as a blob literal, and `->>`.
- The three **agreement** assertions there are the real invariant, and are the thing to
  break first if you want to check the suite bites:
  `cast(b as text) = (b || '')`, `group_concat(b) = group_concat(cast(b as text))`,
  and `b like cast(b as text)`.
- `test/util/value-text.spec.ts` — per-type unit table, totality sweep, plus explicit
  agreement checks between `valueToText` and `TEXT_TYPE.parse` / `lenientCast` /
  `castFallback` / `applyTextAffinity`.

Decisions worth a second opinion:

- **`ignoreBOM: true`** on the shared decoder. Without it the default *strips* a leading
  `EF BB BF`, so `cast(x'efbbbf' as text)` would silently be `''`. Pinned by a `length()`
  assertion.
- **JSON renders in the document's own key order** (`JSON.stringify`), not the sorted
  canonical form. Two documents that `JSON_TYPE.compare` calls equal therefore render
  different text. This is stated in the docstring, in `docs/types.md`, and asserted in the
  unit spec. Every key/fingerprint/statistics site was left on `canonicalJsonString`.
- **Totality.** `valueToText` never throws for a value inhabiting `SqlValue`;
  `castCanYieldNull` depends on that, and a `not null` lens column over `cast(x as text)`
  depends on `castCanYieldNull`. The only throw path is a cyclic object, which violates the
  `JsonSqlValue` contract and is deliberately left to propagate.
- **`castFallback`'s TEXT arm is now unreachable** (parse no longer throws). It stays, with
  a comment explaining why — it is about the TEXT *target*, not today's TEXT type object.
- **`castFallback(null, BLOB)`** now returns `null` rather than the UTF-8 of the string
  `'null'`. Unreachable today (`lenientCast` guards null before calling), and the honest
  answer; flagging it because it is a semantic change in an exported function.

## Known gaps — do not read the green run as full coverage

- **String builtins were not touched and now disagree with the one rule.**
  `src/func/builtins/string.ts` coerces a non-text argument with raw `String(x)`:
  `substr`, and by inspection the rest of that family. `substr(x'6162', 1, 1)` returns
  `9` (the first character of `97,98`) where `substr(cast(x'6162' as text), 1, 1)` returns
  `a`. That file was outside this ticket's enumerated scope and outside its "do not touch"
  list, so it was left alone rather than silently widened. **This is a real remaining
  inconsistency of the same class the ticket set out to kill** — the reviewer should decide
  whether it is a follow-up ticket (probably one `debt-` ticket covering the whole string
  builtin family, not per-function bugs). I did not file it, to avoid pre-empting that call.
- **`06.8-json-path-operators.sqllogic` needed a second change the ticket did not name.**
  Line 36 asserted `->>` over an array as `1,2`; it is now `[1,2]`. The ticket only named
  line 97 because a `.sqllogic` file aborts at its first failing statement, so line 36
  masked line 97 during the original investigation. Worth remembering as a general hazard:
  "the ticket names one assertion in a file" does not mean there is only one.
- **The blob→text→blob round-trip regressed, on purpose.**
  `cast(cast(x'6162' as text) as blob)` is now `cast('ab' as blob)`, and `BLOB_TYPE.parse`
  sniffs even-length all-hex strings as hex, so it yields `x'ab'` rather than `x'6162'`.
  Per the ticket this is `blob-text-conversion-explicit`'s to fix; no test pins the broken
  result, deliberately.
- **`util/affinity.ts` is dead code.** Nothing in `src/` imports it and it is not
  re-exported from the package index — my new spec is its only consumer. I fixed
  `applyTextAffinity` as the ticket asked and recorded the situation as a `NOTE:` at the
  module head rather than deleting the module or filing a ticket. If the reviewer wants it
  gone, that is a clean `debt-` ticket.
- **Number-to-text spelling is untouched and still diverges from SQLite** (`cast(1.0 as
  text)` → `1`, `Infinity` not `Inf`). Out of scope by the ticket; owned by
  `backlog/bug-real-to-text-formatting-differs-from-sqlite`. The unit spec pins today's
  behaviour so the divergence is visible rather than accidental.
- **Fuzz coverage weakened slightly, not broken.** `test/fuzz.spec.ts` compares tables via
  `cast(col as text)` and in one place `select distinct cast(col as text)`. Because the blob
  decode is lossy, distinct invalid-UTF-8 blobs can now collide onto one text value. That can
  only make the oracle *less* sensitive, never produce a false failure — but it is a real
  reduction in what those two assertions can catch, and nobody has measured how often the
  generator emits non-UTF-8 blobs.
- No performance work was done or measured. `valueToText` adds one function call on paths
  that previously inlined `String(v)`; the shared `TextDecoder` avoids per-call construction.
  Nothing was profiled.
