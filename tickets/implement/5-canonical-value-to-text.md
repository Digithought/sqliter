description: The engine turns a value into text in several different, disagreeing ways, so binary data comes out as decimal numbers in one place and as hex digits in another, and a JSON document is silently destroyed. Define one conversion and make every place use it.
files:
  - packages/quereus/src/util/value-text.ts            # NEW — the one conversion
  - packages/quereus/src/types/cast-semantics.ts       # castFallback TEXT arm (line 38) + BLOB arm (line 40)
  - packages/quereus/src/types/builtin-types.ts        # TEXT_TYPE.parse (lines 148-161) — today's hex answer
  - packages/quereus/src/util/affinity.ts              # applyTextAffinity tail (line 142)
  - packages/quereus/src/func/builtins/aggregate.ts    # group_concat step (lines 264, 271)
  - packages/quereus/src/runtime/emit/binary.ts        # emitConcatOp (331-332), emitLikeOp (478, 494-495), constLikePattern (462)
  - packages/quereus/src/types/validation.ts           # validateAndParse — the write path that reaches TEXT_TYPE.parse
  - packages/quereus/test/logic/05.2-cast-seek-correctness.sqllogic   # lines 108-121 assert the hex spelling — must be updated
  - packages/quereus/test/logic/06.8-json-path-operators.sqllogic     # line 97 asserts "[object Object]" — must be updated
  - packages/quereus/test/logic/03.6.2-value-to-text.sqllogic         # NEW — the behaviour suite
  - packages/quereus/test/util/value-text.spec.ts      # NEW — per-type unit table (mirror test/util/json-canonical.spec.ts)
  - docs/types.md                                      # CAST section (~line 729) names `String(v)` as the rule
difficulty: medium
---

# One value-to-text conversion, used everywhere

## What is wrong today

There is no single answer to "what is this value as text". Eight sites each answer for
themselves, using raw JavaScript `String(value)`, and one more (`TEXT_TYPE.parse`) answers
differently again. For binary data the engine currently gives **three** different answers,
and for a JSON document it gives the placeholder `[object Object]`, which loses the document
irrecoverably and silently.

| expression | today | after this ticket |
|---|---|---|
| `cast(x'6162' as text)` | `6162` (hex) | `ab` |
| `x'6162' \|\| ''` | `97,98` (decimal bytes) | `ab` |
| `group_concat(blob_col)` over `x'6162'`,`x'6163'` | `97,98,97,99` | `ab,ac` |
| `x'6162' like 'ab'` | false | true |
| `cast(json('{"a":1}') as text)` | `[object Object]` | `{"a":1}` |
| `cast(json('[1,2,3]') as text)` | `1,2,3` | `[1,2,3]` |
| `'{"a":{"x":1}}' ->> 'a'` | `[object Object]` | `{"x":1}` |
| `cast(<json> as blob)` | UTF-8 of `[object Object]` | UTF-8 of `{"a":1}` |

## The conversion

Add `packages/quereus/src/util/value-text.ts`:

```ts
/**
 * THE SQL value-to-text conversion. Every site that has to render a value as text —
 * CAST/parse to TEXT, `||`, LIKE operand coercion, group_concat, TEXT affinity — calls
 * this and nothing else. Total over well-typed SqlValue: it never throws, which is what
 * keeps `castCanYieldNull(TEXT_TYPE)` false.
 */
export function valueToText(value: SqlValue): string | null;
```

Rule per source type — this table is the contract, and belongs in the docstring:

| source | text | notes |
|---|---|---|
| `null` | `null` | SQL NULL propagates; callers keep their own null handling |
| `string` | itself | including every temporal value (DATE/TIME/DATETIME/TIMESPAN are physically text) |
| `number` | `String(v)` | JS shortest round-trip spelling — see *Deliberately out of scope* |
| `bigint` | `v.toString()` | exact decimal digits, no rounding |
| `boolean` | `'true'` / `'false'` | |
| `Uint8Array` | UTF-8 decode | reinterpret the bytes as text, matching SQLite |
| JSON object / array | `JSON.stringify(v)` | key order as the document has it |

**Binary decode.** One module-level `const utf8Decoder = new TextDecoder('utf-8', { ignoreBOM: true })`.
`ignoreBOM: true` is required, not cosmetic: the default **strips** a leading `EF BB BF`, so
`cast(x'efbbbf' as text)` would silently produce the empty string instead of one U+FEFF
character. Decoding stays non-fatal — malformed bytes become U+FFFD rather than raising —
because the conversion has to be total (below). It is therefore **lossy**: `x'ff'` and
`x'fe'` both render as U+FFFD. Say so in the docstring and in `docs/types.md`.

**JSON text form.** Plain `JSON.stringify`, i.e. the document's own key order, **not**
`canonicalJsonString` (`util/json-canonical.ts`). That function exists to make grouping keys
and expression fingerprints deterministic across reorder-equal documents; a user-visible
conversion should show the document as it is. The consequence is real and should be
documented rather than designed away: `JSON_TYPE.compare` is a structural deep-compare, so
two documents differing only in key order are **equal** yet render **different** text. Leave
every key/fingerprint/statistics site on `canonicalJsonString` — see *Do not touch* below.

**Totality.** `valueToText` must not throw for any value that satisfies the `SqlValue` type.
The only way `JSON.stringify` throws here is a cyclic object, which violates the
`JsonSqlValue` contract — let that propagate rather than catching it; it is a programming
error, not a data case. Totality is load-bearing: `castCanYieldNull` (`types/cast-semantics.ts`)
declares TEXT and BLOB total over non-null operands, and a `not null` lens column over
`cast(x as text)` deploys on the strength of that claim.

## The sites

All of these must end up calling `valueToText` — the point of the ticket is that none of
them keeps its own answer:

- `types/builtin-types.ts` — `TEXT_TYPE.parse` becomes `valueToText(v)`. It loses its hex
  arm and stops throwing for objects. **No documented divergence remains** — one rule.
- `types/cast-semantics.ts` — `castFallback`'s TEXT arm returns `valueToText(value)`; the
  BLOB arm encodes `valueToText(value)`. The TEXT arm becomes unreachable in practice (parse
  no longer throws) but stays, and its comment should say why it stays.
- `util/affinity.ts` — `applyTextAffinity`'s tail (`String(value)` for boolean and JSON).
  **Keep the `Uint8Array` early return that leaves a blob unchanged**: SQLite TEXT affinity
  does not convert blobs, and that is a different question from "render this as text". Do not
  unify it away.
- `func/builtins/aggregate.ts` — `group_concat`'s value push, and the separator argument on
  line 264.
- `runtime/emit/binary.ts` — `emitConcatOp`'s two operands; `emitLikeOp`'s `String(text)` and
  `String(pattern)`; and `constLikePattern`, whose docstring promises "the exact string the
  per-row path would derive". Those three move together or the constant-pattern fast path
  starts disagreeing with the dynamic path.

## Do not touch

These use `String()` or `canonicalJsonString` for a different job and are correct as they
are. Changing them is out of scope and will be flagged in review:

- `util/key-serializer.ts`, `util/key-tuple-codec.ts`, `util/comparison.ts`
  (`objectCanonicalString`), `planner/analysis/expression-fingerprint.ts` — grouping and
  fingerprint keys, deliberately canonical.
- `planner/stats/histogram.ts` (line 100) and `planner/stats/analyze.ts` — cost statistics,
  carrying an existing `NOTE:` that records the tradeoff.
- `func/builtins/json.ts` `json_quote` — produces JSON *source* text (quotes strings, returns
  null for blobs). A different function with a different contract.
- `planner/nodes/scalar.ts` `LiteralNode.toString()` — plan debug output.

## Edge cases & interactions

- **Empty blob.** `cast(x'' as text)` → `''` (not null).
- **BOM.** `length(cast(x'efbbbf' as text))` → 1. Guards the `ignoreBOM: true` decode.
- **Invalid UTF-8.** `cast(x'ff' as text)` → U+FFFD; distinct invalid blobs can collide onto
  the same text. Assert the lossy result explicitly so nobody "fixes" it later by accident.
- **Multi-byte.** `cast(x'e4b8ad' as text)` → `中`.
- **JSON string scalar.** A JSON column holding the string `hello` is physically a JS string,
  so it renders `hello`, not `"hello"`. The conversion dispatches on the runtime value and
  cannot see the declared type. Document it; do not try to special-case it.
- **JSON null vs SQL NULL.** `cast(json('null') as text)` — settle and test which one it is
  (`JSON_TYPE.parse('null')` yields SQL null today, so this is null, not the text `null`).
- **Bigint.** The existing large-integer assertions in
  `test/logic/03.6-type-system.sqllogic` (lines 361-474) go through `cast(v as text)` and
  must stay green — exact digits, no `Number()` round-trip.
- **NULL propagation.** `null || 'x'` stays NULL; `group_concat` still skips nulls;
  `applyTextAffinity(null)` stays null; `lenientCast(null, TEXT)` stays null.
- **Write path.** `TEXT_TYPE.parse` is reached by `validateAndParse` (`types/validation.ts`),
  so inserting a BLOB into a TEXT column now **stores** the UTF-8 decode instead of hex —
  including `alter table … alter column … set data type text` backfill
  (`vtab/memory/layer/row-convert.ts`) and DEFAULT folding. This changes stored values, not
  only query output, and it is lossy for non-UTF-8 bytes. Cover it with a test that inserts a
  blob into a TEXT column and reads it back.
- **Seek correctness.** `test/logic/05.2-cast-seek-correctness.sqllogic` asserts that
  `cast(blob_pk as text)` must not be folded into an index seek key. Still true — the cast
  value is still not the stored blob — but the literals change from `'31'` to `'1'` and the
  comment above them ("hex-encodes the bytes") is now wrong. Update both.
- **`->>` comes along for free.** The parser desugars `a ->> b` to
  `cast(json_extract(a, b) as text)` (`parser/parser.ts`, `jsonPath()`), so fixing CAST fixes
  the operator. `test/logic/06.8-json-path-operators.sqllogic:97` currently asserts
  `[object Object]` and must become `{"x":1}`.
- **Blob→text→blob round-trip regresses, and that is expected here.**
  `cast(cast(x'6162' as text) as blob)` becomes `cast('ab' as blob)`, and `BLOB_TYPE.parse`
  sniffs even-length all-hex strings as hex, so it yields `x'ab'`. The follow-on ticket
  `blob-text-conversion-explicit` owns that. **Do not work around it in this ticket, and do
  not add a test that pins the broken result.**
- **Aggregate DISTINCT is unaffected.** `count(distinct blob_col)` keys on the raw value, not
  on text; the existing assertions in `07-aggregates.sqllogic` and
  `92-hash-aggregate-edge-cases.sqllogic` must stay green unchanged.

## Deliberately out of scope

Number-to-text spelling stays `String(v)`: `cast(1.0 as text)` gives `1` where SQLite gives
`1.0`, and non-finite values give `Infinity`/`NaN` where SQLite gives `Inf`. That is a
separate divergence with its own blast radius, filed as
`backlog/bug-real-to-text-formatting-differs-from-sqlite`. Do not change it here.

## TODO

Phase 1 — the conversion

- Add `packages/quereus/src/util/value-text.ts` with `valueToText` and the per-type table as
  its docstring, including the `ignoreBOM: true` rationale, the lossy-decode note, the
  canonical-vs-document key-order decision, and the totality requirement.
- Add `test/util/value-text.spec.ts` covering every row of the table plus the boundary blobs
  (empty, BOM, invalid UTF-8, multi-byte) and a JSON object, array, and nested document.

Phase 2 — point every site at it

- `TEXT_TYPE.parse` → `valueToText`; drop the hex arm and the object throw.
- `castFallback` TEXT and BLOB arms; refresh the module docstring, which currently names
  `String(v)` as the rule.
- `applyTextAffinity` tail only; keep the blob passthrough and say why in a comment.
- `group_concat` value and separator.
- `emitConcatOp`; `emitLikeOp` text and pattern; `constLikePattern`.
- Grep for any remaining `String(` in `src/types`, `src/util/affinity.ts`,
  `src/func/builtins/aggregate.ts` and `src/runtime/emit/binary.ts` and account for each hit.

Phase 3 — tests

- New `test/logic/03.6.2-value-to-text.sqllogic` covering the whole table at the top of this
  ticket, the edge cases above, and two agreement assertions that are the real invariant:
  - `select cast(b as text) = (b || '') as r from bt;` → true for every row
  - the same value through `group_concat` of a single row agrees with `cast(… as text)`
- Update `test/logic/05.2-cast-seek-correctness.sqllogic` (literals + comment) and
  `test/logic/06.8-json-path-operators.sqllogic:97`.
- Add the blob-into-TEXT-column write/read-back case.

Phase 4 — docs and validation

- `docs/types.md`: replace the `String(v)` mention in the CAST section with a pointer to the
  new conversion, and add the per-type table plus the lossy-binary-decode and JSON-key-order
  notes. Check `docs/sql.md` / `docs/sql-functions.md` for anything describing `||`,
  `group_concat` or LIKE operand conversion and update it.
- `yarn build`, then `yarn test 2>&1 | tee /tmp/vt-test.log; tail -n 80 /tmp/vt-test.log`,
  then `yarn lint`.
- Hand off to `review/` naming every behaviour that changed, and the round-trip regression
  that `blob-text-conversion-explicit` picks up.
