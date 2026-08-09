description: Reading a row back from a store-backed table is about four times slower than it needs to be, because every row pays for a rarely-needed value-rewriting step during JSON parsing. Skip that step whenever the raw bytes prove it can't matter.
files:
  - packages/quereus-store/src/common/serialization.ts
  - packages/quereus-store/test/serialization.spec.ts
difficulty: easy
----

# Skip the JSON reviver when a stored row cannot contain a marker

Full design already settled in the plan ticket this implements
(`tickets/plan/perf-store-row-deserialize-reviver-fast-path.md` — read it for the
measurements and the rejected alternatives before touching code, especially the *Declined
alternative* section, since a write-time flag byte must NOT be (re)built as part of this
ticket). Summary of the chosen fix:

`deserializeRow`/`deserializeValue` in `packages/quereus-store/src/common/serialization.ts`
always pass a `reviver` callback to `JSON.parse`, which makes V8 call back into JS once per
parsed value to check for three marker shapes (`{"$bigint":...}`, `{"$blob":...}`,
`{"$json":...}`). Most rows contain none of these. Decode the bytes once, test the resulting
string for the literal marker-open sigil `{"$`, and only pass the reviver when that sigil is
present:

```ts
const decoder = new TextDecoder();

export function deserializeRow(buffer: Uint8Array): Row {
	const json = decoder.decode(buffer);
	return JSON.parse(json, json.includes('{"$') ? reviver : undefined) as Row;
}
```

Same pattern for `deserializeValue`. `serializeRow`/`serializeValue` are unchanged — this is
a read-side-only change, no stored byte format change, no migration.

**Must use `{"$`, not `"$`.** The looser sigil false-positives on any string value that
merely starts with `$` (e.g. a memo field `"$125.00 fee"`), which defeats the optimization
on realistic data. See the plan ticket's measured table for why.

## TODO

- Hoist a module-level `const decoder = new TextDecoder();` in `serialization.ts`, next to
  the existing hoisted `textEncoder`, and use it in `deserializeRow` and `deserializeValue`
  (replacing the per-call `new TextDecoder()`).
- Add one predicate, e.g. `hasMarkerSigil(json: string): boolean { return json.includes('{"$'); }`,
  used by both `deserializeRow` and `deserializeValue` — do not duplicate the literal
  `'{"$'` string at two call sites, so a future fourth marker type can't add a new marker
  shape while forgetting this gate. (There's only one marker-open shape today, since all
  three markers are single-key objects, but keep this centralized in case that ever
  changes.)
- Pass `hasMarkerSigil(json) ? reviver : undefined` as the second arg to both `JSON.parse`
  calls.
- Add a one-line comment at the module-level `decoder` stating it's safe to share across
  concurrent scans (non-streaming `TextDecoder.decode()` is stateless per call) — mirror the
  existing comment on `textEncoder`.
- Add a `NOTE:` comment at the gate recording the declined write-time-flag alternative,
  reusing the wording drafted in the plan ticket's *Declined alternative* section (adjust
  only if the measured numbers don't reproduce).
- Extend `packages/quereus-store/test/serialization.spec.ts`:
  - A deterministic round-trip property test over generated rows covering every `SqlValue`
    kind (`null`, `number`, `bigint` inside and outside the safe-integer range, `string`
    including sigil-bearing text like `$foo`, literal-marker-looking text like
    `{"$bigint":"fake"}`, `boolean`, `Uint8Array`, JSON objects/arrays including
    marker-colliding keys like `{ $bigint: 'not-a-bigint' }`) asserting
    `deserializeRow(serializeRow(row))` deep-equals `row`. Use a small seeded PRNG (e.g. a
    local `mulberry32`-style function seeded with a fixed constant) rather than
    `Math.random()`, so the suite is deterministic — this repo has no `fast-check` dependency
    and none should be added for this ticket. Check `packages/quereus-store/test/kv-conformance.spec.ts`,
    `paged-iterate.spec.ts`, `isolated-store.spec.ts`, `transaction.spec.ts`,
    `key-builder.spec.ts`, or `backing-host.spec.ts` for this repo's existing seeded-random
    idiom before inventing a new one.
  - Explicit cases for the edge list from the plan ticket's *Edge cases & interactions*
    section: empty row `[]`, all-null row, a `TEXT` cell starting with `$`, a `TEXT` cell
    containing the literal marker text, a bare `{"$"` text cell, a JSON column with a real
    `$bigint` key (both wrapped-`$json` and unwrapped forms), a marker nested inside an
    array inside an object (sigil present but not at top level), and blob content whose
    base64 happens to decode to text containing a sigil.
  - A negative self-test proving the property test would catch a wrongly-skipped reviver:
    temporarily force the gate predicate to always return `false` (e.g. via a small
    injectable/exported test seam, or by duplicating the gate logic inline in the test and
    asserting it — pick whichever is less invasive to production code) and assert the
    round-trip suite fails in that configuration. Don't leave this seam permanently wired
    into production `deserializeRow`/`deserializeValue` signatures — keep the production API
    unchanged.
- Run `yarn workspace @quereus/quereus-store run test` and confirm the full suite passes,
  not just the new/edited spec file.
- Re-run the micro-benchmark referenced in the plan ticket (or write an equivalent throwaway
  benchmark script — do not commit a benchmark file unless one already exists in this
  package) over ~50k–200k generated rows, comparing before/after `deserializeRow` timing.
  Record the achieved ratio in the review handoff; if it lands materially below the ~78%
  measured in the plan ticket, say so explicitly rather than restating the plan's numbers as
  if reproduced.

## Edge cases & interactions

(Carried from the plan ticket — the implementer must cover all of these, the reviewer will
check for them.)

- Empty and one-cell rows: `[]`, `[null]`, all-null rows.
- Sigil-lookalike text: `TEXT` starting with `$`, `TEXT` containing the literal marker
  object as a string, a bare `{"$` substring in text — all must round-trip unchanged
  regardless of which branch (reviver vs. no-reviver) they take.
- Marker-colliding JSON: a JSON column whose document has a real `$bigint` key — both the
  `$json`-wrapped and unwrapped forms.
- Nested depth: a marker inside an array inside a JSON object (sigil present but deep, not
  at top level of the parsed row).
- Blob content: base64 of arbitrary bytes, including bytes that themselves decode to text
  containing a sigil (should be irrelevant since blobs are base64-encoded before
  stringification, but is listed here because it's an easy case to get complacent about —
  confirm the base64 string itself never contains `{"$` in a way that matters, or explain
  why it can't).
- All `deserializeRow` call sites remain correct with no changes needed to them, since the
  gate lives inside `serialization.ts` itself: `store-table-scan.ts`, `store-table-base.ts`,
  `store-table-constraints.ts`, `backing-host.ts`, `store-module-index-build.ts`. Confirm by
  reading each call site, not just by assumption — none should need edits, but note in the
  review handoff that this was checked rather than assumed.
- `deserializeValue` gets the identical gate and soundness argument as `deserializeRow` —
  don't implement one and forget the other.
- Concurrency: the module-level `decoder` is shared across concurrent scans; state in a
  comment why that's safe (see TODO above).
