---
description: Reading a row back from a store-backed table now skips a per-cell JSON callback whenever the raw stored bytes prove that callback couldn't change anything, cutting the cost of turning stored bytes back into a row by roughly 84%.
files:
  - packages/quereus-store/src/common/serialization.ts
  - packages/quereus-store/test/serialization.spec.ts
  - docs/store.md
---

# Complete: skip the JSON reviver when a stored row cannot contain a marker

## What shipped

`packages/quereus-store/src/common/serialization.ts` (read side only — no stored-byte
format change, no migration):

- One module-level `TextDecoder`, replacing the instance allocated per
  `deserializeRow` / `deserializeValue` / `deserializeStats` call, mirroring the existing
  hoisted `TextEncoder`.
- `needsReviver(json)` — the single predicate deciding whether `JSON.parse` needs its
  reviver at all. A cheap `"$` scan rules out the common case in one pass; the narrower
  `{"$` (marker object) and `"$$` (escaped colliding key) checks run only for text that
  already contains a quoted `$`. Both deserializers pass
  `needsReviver(json) ? reviver : undefined`.
- A `NOTE: accepted tradeoff` at the `deserializeRow` gate records that a write-time flag
  byte was weighed and declined (margin too small to justify a persisted-format version
  and migration).

The implement stage's five failing tests exposed a genuine pre-existing defect in the
marker-collision scheme, which the pipeline's triage step then fixed in commit `86d3ddcf`:
the old `$json` *wrapper* could never work, because `JSON.parse` runs its reviver
bottom-up and so decoded (or threw on) the inner value before the wrapper was ever
visited. Wrapping was replaced with per-key **escaping** — a user key colliding with a
marker name gets one extra `$` on write (`$bigint` → `$$bigint`) and loses it on read, at
any depth, via `replacer`'s top-down walk. `docs/store.md` § row storage was updated to
state this. The legacy `$json` unwrap branch remains on the read side only.

## Measured result

Throwaway benchmark, 150,000 rows shaped `text, text, text, real, text`, seeded PRNG,
Node 24, re-run at review time against the post-triage code:

| variant | per row | vs old |
|---|---|---|
| old (`new TextDecoder()` + always reviver) | 2.945 µs | — |
| new (hoisted decoder, gated reviver) | 0.476 µs | **16.2%** (≈84% reduction) |

Worst case — every row carrying a bigint column, so the gate always falls through to the
reviver and the extra scans are pure overhead — measured 95%, 99%, 109% of baseline over
three runs: noise-dominated, no detectable regression. Benchmark scripts were not
committed (no benchmark harness exists in this package); the row shape and PRNG above are
enough to re-derive them.

## Review findings

### Verified sound

- **Gate has no false negatives.** Every transformation the reviver performs is reachable
  only from text containing `{"$` (marker objects and the legacy `$json` wrapper are all
  single-key, so always open with that sequence) or `"$$` (escaped keys carry ≥2 dollars
  and always sit behind a quote). The `"$` pre-filter is a strict superset of both, so it
  can never short-circuit a case the narrower checks would have caught. String *values*
  that look like markers can't produce an unescaped `{"` in the JSON text — confirmed by
  the existing lookalike tests.
- **Legacy data is not newly broken.** The only rows the old writer emitted with a `$json`
  wrapper were exactly the rows the bottom-up reviver already mis-decoded or crashed on, so
  the wrapper's replacement costs no previously-working data. The read-side unwrap branch
  is kept regardless.
- **All five call sites** (`store-table-scan.ts`, `store-table-base.ts`,
  `store-table-constraints.ts`, `backing-host.ts`, `store-module-index-build.ts`) call
  `deserializeRow(entry.value)` in the plain single-argument form; the signature is
  unchanged, so none needed edits. Re-checked, not taken on the handoff's word.
- **No duplicate serializer** elsewhere in the monorepo — `$bigint` appears in exactly one
  source file, so there is no second copy of this gate to keep in sync.

### Found and fixed in this pass

- **Prototype-setter data loss in the new key escaping (correctness, real, reproduced).**
  `escapeMarkerKeys` / `unescapeMarkerKeys` rebuilt their object with `copy[key] = value`.
  A JSON value may carry an own `__proto__` key (`JSON.parse('{"__proto__":1}')` creates
  one), and plain assignment invokes the prototype setter instead: the key is silently
  dropped and the object's prototype is replaced. Reachable whenever a JSON column holds
  both an own `__proto__` key and a marker-colliding key. Verified directly in Node before
  fixing. Both functions now share one `rekey` helper built on `Object.fromEntries`, which
  defines own properties. Two regression tests added.
- **`deserializeStats` still allocated a `TextDecoder` per call**, in the same file whose
  hoist rationale sits ten lines above it. Switched to the shared instance.
- **`needsReviver` was named `hasMarkerSigil`**, which understated it — it also detects
  escaped keys, which are not markers. Renamed.
- **Stale test comment** referenced `wrapJsonIfNeeded` and "serializeRow decides whether to
  wrap", both of which the triage commit removed. Rewritten to describe escaping.

### Filed as a new ticket

- `tickets/backlog/debt-store-share-utf8-codecs.md` — the hoist this ticket did in one file
  is the fourth private copy of the same idea in `quereus-store`, while `encoding.ts`
  (`decodeText`, `decodeObject`, on the per-column key-decode path) and
  `store-module-catalog.ts` still allocate per call. Measured 87.6 → 51.3 ns per decode of
  a 26-byte key, so ~36 ns of pure allocation, ~41% of the call. Filed at the shared-module
  rung rather than as a point fix per site. Site-claim grep on `encoding.ts` found only
  `debt-store-key-decode-returns-noncanonical-integers`, a different root cause (numeric
  canonical form), so this is a fresh ticket, not an arm on that one.

### Parked as a tripwire, not a ticket

- A row that *does* contain a marker is scanned up to three times before its reviver runs.
  Measured neutral today (see the worst-case table above). Recorded as a `NOTE:` on
  `needsReviver` in `serialization.ts`, with the condition — very wide rows or large blobs
  showing these scans in a profile — and the remedy (one hand-rolled character scan).

### Checked, nothing found

- **Escaping round-trip completeness.** Traced every reachable key shape: `$bigint`,
  `$$bigint`, `$$$bigint`, `$ref`, `$bigintish`, bare `$`, colliding key in non-first
  position, marker nested in an array, marker nested two levels deep. Escape and unescape
  are exact inverses on all of them, and the existing tests already cover each. No double
  escaping: `replacer` never re-visits an object it produced.
- **Accepted-tradeoff notes.** The `NOTE:` at the `deserializeRow` gate declines the
  write-time flag byte; its stated revisit condition (the row codec being opened anyway)
  has not tripped, so it was left alone.
- **Source hygiene.** `serialization.ts` 267 lines, `serialization.spec.ts` 373 lines
  (`wc -l`); every function short and single-purpose. No split warranted.
- **Docs.** `docs/store.md` § row storage was read in full and correctly describes the
  escaping scheme; the module header comment agrees with it. Nothing else in `docs/`
  describes the serializer's internals, so nothing else needed updating.

## Validation

- `yarn workspace @quereus/store run typecheck` — clean.
- `yarn lint` (whole repo) — clean, exit 0.
- `yarn test` (whole repo) — all suites green, including 1575 passing in
  `@quereus/store`. No skipped, loosened, or deleted tests. `tickets/.pre-existing-error.md`
  was consumed by the triage step and no longer exists; no pre-existing failures remain.
