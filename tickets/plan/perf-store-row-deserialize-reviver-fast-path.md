description: Reading a row back from a store-backed table is about four times slower than it needs to be, because every row pays for a rarely-needed value-rewriting step during JSON parsing.
files:
  - packages/quereus-store/src/common/serialization.ts
  - packages/quereus-store/src/common/store-table-scan.ts
  - packages/quereus-store/src/common/store-table-base.ts
  - packages/quereus-store/src/common/backing-host.ts
  - packages/quereus-store/src/common/store-module-index-build.ts
  - packages/quereus/src/types/logical-type.ts
  - packages/quereus/src/types/validation.ts
difficulty: easy
----

# Skip the JSON reviver when a stored row cannot contain a marker

## What is slow

`deserializeRow` (`quereus-store/src/common/serialization.ts`) turns a stored byte array
back into a row:

```ts
export function deserializeRow(buffer: Uint8Array): Row {
	const json = new TextDecoder().decode(buffer);
	return JSON.parse(json, reviver) as Row;
}
```

The `reviver` argument is what costs. A reviver makes `JSON.parse` call back into
JavaScript once per parsed value — every cell, and every member of every nested JSON
object — instead of building the result entirely inside the engine. It exists only to
restore three things the extended-JSON format encodes as marker objects: a `bigint`
(`{"$bigint": "..."}`), a `Uint8Array` (`{"$blob": "..."}`), and a JSON document whose own
keys would collide with those markers (`{"$json": {...}}`).

Most stored rows contain none of those. They still pay for the callback on every cell.

## Measured

Micro-benchmark, 200,000 rows shaped like a ledger entry (`text, text, text, real, text`),
Node 24, one machine — ratios are the signal:

| variant | per row | vs current |
|---|---|---|
| current (`new TextDecoder()` + reviver) | 4.74 µs | — |
| hoisted decoder, reviver kept | 4.10 µs | −13% |
| hoisted decoder, **no** reviver | 0.72 µs | −85% |
| hoisted decoder, marker-scan then reviver only on hit | 1.05 µs | −78% |

(A second run on a different row shape measured 3.17 / 0.60 / 0.49 µs for
always-reviver / tight-sigil / never-reviver. Absolute numbers move with row width and
machine; the ~5× ratio between running the reviver and not is the stable signal.)

So the fresh `TextDecoder` per call is real but minor; the reviver is roughly four times
the rest of the work combined.

Context for sizing: on a full scan of a 20,000-row table, engine + store + deserialization
together measure ~170 ms in-process, of which deserialization is roughly 95 ms. This change
is worth ~75 ms of that. It is not the dominant cost of a slow browser query — the
IndexedDB plugin's per-row cursor reads are — but it is cheap, local, and backend-independent.

## The design question: where does the decision belong?

Three seams can decide "does this row need the reviver?". They differ in how much they
know and what they cost.

### Schema time (per table) — sound, but too coarse to help

The values that can produce a marker are fully determined by each column's declared type,
and writes are coerced to that type (`coerceRowToSchema` → `validateAndParse`) before
`serializeRow` ever sees them. So a table could compute one `needsReviver` flag when its
schema is attached, by looking at each column's `logicalType.physicalType`
(`quereus/src/types/logical-type.ts`):

- `INTEGER` — can hold a `bigint` (values past 2^53 widen; see `canonicalizeInteger`)
- `BLOB` — holds a `Uint8Array`
- `OBJECT` — a JSON document, which may collide with a marker key
- anything typed `ANY` — all of the above

`TEXT`, `REAL`, `BOOLEAN`, `NULL` cannot produce a marker.

The problem: `INTEGER` is in the unsafe set, and almost every real table has an integer
primary key. The accounting schema that motivated this ticket
(`entry(id integer, txn_id integer, account_id integer, amount real, memo text)`) would be
classified "needs reviver" and gain nothing — even though not one stored row actually
contains a bigint. A static per-table gate is sound but wins only on tables of pure
text/real columns, which is not the common shape.

### Plan time (per query) — adds nothing

A query plan knows no more than the schema does about which value kinds a row holds, and
`deserializeRow` reconstructs the whole row regardless of which columns the query
projects. There is nothing for the planner to contribute here that the table schema does
not already know, so this seam is not worth building.

### Write time (per row) — perfect information

`serializeRow` is the only place that *knows*, rather than infers, whether a marker was
emitted: `replacer` either fired or it did not. A one-byte prefix recording that fact would
let the reader dispatch with certainty and no scan. **Weighed and declined** — see
*Declined alternative* below; the margin over the read-side scan does not pay for a
persisted-format change.

### Chosen for this ticket: read-side marker scan

Decode the bytes once, test the resulting string for the marker sigil, and pass the reviver
only when it could matter:

```ts
const decoder = new TextDecoder();

export function deserializeRow(buffer: Uint8Array): Row {
	const json = decoder.decode(buffer);
	return JSON.parse(json, json.includes('{"$') ? reviver : undefined) as Row;
}
```

One file, no stored-byte change, no migration.

**Use `{"$`, not `"$`.** The three markers are only ever emitted as single-key objects, so
they always serialize as `{"$bigint":`, `{"$blob":` or `{"$json":`. The looser `"$` also
matches any *text* value that begins with a dollar sign — which on the accounting data that
motivated this ticket is a third of all rows (`"$125.00 consulting fee"`), and each one
falls back to the full reviver. Measured on rows where 1 in 3 memos starts with `$`:

| predicate | false positives | per row |
|---|---|---|
| always reviver (today) | — | 3.17 µs |
| loose `"$` | 33.3% | 1.52 µs |
| tight `{"$` | 0.0% | 0.60 µs |

**Why the scan is sound.** A marker the reviver would act on always emits the literal
`{"$` — verified against every shape, including a marker nested inside a JSON object and
inside an array. So there are no false negatives, which is the only direction that could
corrupt a value.

A *string* whose content looks like a marker cannot cause one either. JSON escapes its
quotes, so the stored text reads `"{\"$bigint\":\"fake\"}"` and never contains `{"$` — and
skipping the reviver there is not merely safe but correct, since the reviver only
transforms objects and would have returned that string unchanged regardless.

### Declined alternative: a write-time marker flag

Recorded here so it is not re-derived and re-filed. The measured gap between the tight
sigil (0.60 µs/row) and never running the reviver at all (0.49 µs/row) is **0.11 µs/row** —
about 4 ms on a full scan of a 35,000-row table. Buying that requires a version marker in
the stored bytes, a legacy-read path, a migration decision for existing databases, and an
audit that every writer goes through `serializeRow`. That is a persisted-format change on
live user data for single-digit milliseconds, so it is declined.

The implementer must leave this decision at the code site as a greppable `NOTE:`, e.g.:

```ts
// NOTE: accepted tradeoff — the reviver gate infers from the decoded text rather than a
// write-time flag byte. A flag would save ~0.11 µs/row over this scan (measured) but needs
// a stored-format version + migration; not worth it on its own. Revisit only if the row
// codec is being opened anyway — a binary/columnar format subsumes this entirely.
```

A binary or columnar row codec is the real ceiling here and would make the whole question
moot; that is the change worth reopening this for, not the flag byte by itself.

## Requirements

- `deserializeRow` and `deserializeValue` return byte-identical results to today for every
  input, including every marker combination and nested/marker-colliding JSON.
- The decoder instance is hoisted, matching the already-hoisted `textEncoder`.
- No stored byte format change.
- The marker test is centralized (one predicate, one set of marker strings) so it cannot
  drift from `replacer`/`reviver` — adding a fourth marker must not silently leave the
  fast path returning wrong values.

## Edge cases & interactions

- **Empty and one-cell rows** — `[]`, `[null]`, and a row of all nulls.
- **Sigil-lookalike text** — a `TEXT` cell that *starts* with `$` (`$125.00 fee`), one
  containing the literal marker object as text (`{"$bigint":"fake"}`), and one containing a
  bare `{"$`. All must round-trip unchanged, whichever branch they take.
- **Marker-colliding JSON** — a JSON column whose document has a real `$bigint` key, which
  is exactly what the `$json` wrapper exists for; both the wrapped and unwrapped forms.
- **Nested depth** — a marker inside an array inside a JSON object, i.e. not at top level,
  where the sigil is present but deep.
- **Blob content** — base64 of arbitrary bytes, including one that itself decodes to text
  containing a sigil.
- **All `deserializeRow` call sites**, not just the scan hot path: `store-table-scan.ts`,
  `store-table-base.ts`, `store-table-constraints.ts`, `backing-host.ts`,
  `store-module-index-build.ts`. Any of them may see marker rows.
- **`deserializeValue`** — the single-value form used for index keys and stats, same gate,
  same soundness argument.
- **Concurrency** — a module-level `TextDecoder` is shared across concurrent scans.
  `decode()` on a non-streaming decoder is stateless per call, so this is safe; state that
  explicitly in a comment, since the hoisted-encoder comment already sets the precedent.

## Testing notes

- Round-trip property test over generated rows drawn from every `SqlValue` kind
  (`null`, `number`, `bigint` both inside and outside the safe-integer range, `string`
  including sigil-bearing text, `boolean`, `Uint8Array`, JSON objects/arrays including
  marker-colliding keys): `deserializeRow(serializeRow(row))` deep-equals `row`. This is
  the generalized net — it catches this class of bug for any future codec change too, so
  prefer it over a handful of hand-written cases.
- A negative self-test proving the property test reds if the reviver is wrongly skipped
  (e.g. force the predicate to `false` and assert the suite fails).
- Re-run the micro-benchmark and record the achieved ratio in the review handoff; if it
  lands materially below the ~78% measured here, say so rather than reporting the
  benchmark from this ticket.
