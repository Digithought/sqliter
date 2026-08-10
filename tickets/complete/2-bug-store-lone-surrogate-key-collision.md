---
description: A persistent table used to merge two different text values onto one storage key when they contained a broken half-character; it now refuses the value outright with a clear error instead of corrupting or wrongly rejecting rows.
files:
  - packages/quereus-store/src/common/encoding.ts             # the fix: findUnpairedSurrogate / assertEncodableText, called from encodeText
  - packages/quereus-store/src/common/key-builder.ts          # NOTE: at buildCatalogKey — identifiers are NOT guarded (backlog ticket)
  - packages/quereus-store/test/lone-surrogate-keys.spec.ts   # store-vs-memory spec
  - packages/quereus-store/test/encoding.spec.ts              # `unpaired surrogates` describe block
  - packages/quereus-store/test/astral-text-keys.spec.ts      # header comment updated
  - packages/quereus/src/util/comparison.ts                   # compareCodePoints doc comment
  - packages/quereus/src/core/database.ts                     # registerCollation NOTE (updated during review)
  - docs/store.md                                             # collation/orderPreserving section (updated during review)
difficulty: medium
---

# Store text keys are injective: unpaired surrogates are refused, not folded

## What shipped

A JavaScript string is a sequence of 16-bit code units. Characters above `U+FFFF` occupy two
of them — a *surrogate pair*. A string can also hold a **lone** (unpaired) surrogate: one
half with no partner. That is a legal JavaScript string and a legal Quereus `text` value, but
it is not valid Unicode, and no UTF-8 byte sequence encodes it.

The persistent store keys text rows by their UTF-8 bytes, and `TextEncoder` silently replaces
every unpaired surrogate with `U+FFFD` (bytes `EF BF BD`). All 2048 of them produced the same
key, so two distinct values landed on one row — a spurious `UNIQUE constraint failed` on the
second insert, or, worse, an upsert that silently overwrote an unrelated row.

`encodeText` now **rejects** a text value containing an unpaired surrogate, naming the code
unit and offset. WTF-8 was considered and not implemented: it would have required making
`compareCodePoints` pairing-aware and dropping `TextDecoder` from `decodeText`, all to persist
values that are not valid Unicode.

The deliberate consequence: **a memory table accepts a lone-surrogate text key; a store-backed
table raises.** That is the one behavioural divergence, and it is what makes the built-in
collations' `orderPreserving` stamp true for every value a store-backed table can hold.

Row *values* are unaffected — they serialize through `JSON.stringify`, which is well-formed
(ES2019) and escapes a lone surrogate to the seven ASCII characters `\ud800`. Same for
object/JSON keys via `canonicalJsonString`, so `encodeObject` needs no guard and has a `NOTE:`
saying why.

## Review findings

### Checked and clean

- **`findUnpairedSurrogate` correctness.** Re-derived the scan by hand. Handles the three
  shapes the guard exists for: lone high (no low after), lone low (no high before), and
  low-then-high (not a pair). Well-formed pairs consume both units. The end-of-string case is
  correct specifically *because* it uses `i + 1 < value.length ? charCodeAt(i + 1) : 0` — a
  bare `charCodeAt` past the end returns `NaN`, and both `NaN < 0xDC00` and `NaN > 0xDFFF` are
  false, so a trailing high surrogate would have slipped through. The implementer avoided that.
- **`HAS_SURROGATE` pre-test.** No `g` flag, so no `lastIndex` statefulness across `.test`
  calls. Correct.
- **Guard placement.** It runs on the *normalized* string, i.e. the one actually encoded, so a
  custom key normalizer that slices through a surrogate pair cannot smuggle a lone half in.
  Tested.
- **`encodeObject`'s missing guard.** Verified `canonicalJsonString` in
  `packages/quereus/src/util/json-canonical.ts` is `JSON.stringify(canonicalize(value))` — the
  escaping the `NOTE:` relies on is real.
- **Row serialization.** `serializeRow` / `serializeValue` in `store/src/common/serialization.ts`
  encode `JSON.stringify` output. Lone surrogates in non-key columns round-trip intact, as the
  handoff claims.
- **`quereus-sync`'s `TextEncoder` paths** (the handoff's open question). Audited
  `metadata/keys.ts`, `tombstones.ts`, `column-version.ts`, `basis-lifecycle.ts`,
  `quarantine.ts`, `snapshot-stream.ts`. Every payload is `JSON.stringify` output; the
  `{pk_json}` component of a metadata key likewise. Row-value collisions there are not
  reachable. *Identifier* components of those keys are a different story — see below.
- **Lint and tests.** `yarn lint` clean. `yarn test` green: 6799 (quereus) + 898 (store, up one
  from the added delete test) + all other workspaces, zero failing. No pre-existing failures
  surfaced, so no `.pre-existing-error.md` was written.

### Fixed in this review

- **Stale docs.** Two sites still described the bug as open and pointed at this ticket as
  unresolved. Both now describe the shipped behaviour: `docs/store.md` (the collation /
  `orderPreserving` section — it also now names the still-unguarded identifier path), and the
  `registerCollation` NOTE in `packages/quereus/src/core/database.ts`. The handoff listed the
  doc-comment updates it made but missed these two.
- **No delete-path test.** The spec covered insert, update, upsert, index and seek, but not
  `delete from s where k = '<lone surrogate>'` — the same seek-bound encode, and unguarded it
  would have deleted the row held by a *different* lone surrogate. Test added; it passes.

### Filed as tickets

Two further collision sites, both confirmed during this review, folded into the existing
`backlog/bug-store-catalog-key-lone-surrogate-identifier-collision` (same file, same root
cause, same one-line fix) rather than split into new tickets:

- **DDL text is mangled, not just the catalog key.** `saveTableDDL` persists the reconstructed
  `create table …` text through raw `TextEncoder`. A lone surrogate inside a quoted identifier,
  a `default '…'` literal, or a `check` string constant is folded to `U+FFFD` on write and
  comes back as a *different schema*. Silent corruption with no `UNIQUE`-shaped symptom.
- **`quereus-sync` metadata keys have the same identifier hole.** `cv:{schema}.{table}:{pk_json}:{column}`
  runs schema/table/column names through `TextEncoder`; two columns whose names differ only in
  a lone surrogate share one metadata key.

Also **answered the open question that gated that ticket's priority**: the parser *does* accept
a raw lone surrogate. `doubleQuotedIdentifier` and `string` in
`packages/quereus/src/parser/lexer.ts` both take the characters between the quotes as a raw
`source.substring(...)` slice. Reachable from ordinary SQL, not only from the programmatic
schema APIs. Ticket updated to say so.

### Recorded as tripwires, not tickets

- **Pre-guard store data.** A store written before this fix may hold rows whose text key was
  already folded to `U+FFFD`. They still scan (decoding to `'�'`), but no lone-surrogate
  literal can address them any more, because the encode raises first. Conditional on ever
  opening a pre-guard store, which the project's "backwards compat: don't worry yet" stance
  says is not a concern today. Parked as a `NOTE:` on `assertEncodableText` in
  `encoding.ts`, where anyone writing a migration will meet it.

### Accepted as-is

- **Error offset is into the normalized string.** For BINARY (identity) that is the caller's
  own offset; under NOCASE it can shift where a character's lowercase form differs in code-unit
  count. Making it always an input offset would mean scanning twice on every text key encode.
  The doc comment states the limitation. Not worth the cost.
- **`proves the collision the guard exists to prevent` asserts on `TextEncoder`, not on our
  code.** Deliberate, and the implementer flagged it. It pins the platform behaviour the whole
  fix rests on; it is the one test in that block that would survive deleting the guard, and the
  others would not. Keeping it.
- **Store spec files are not typechecked.** `packages/quereus-store/tsconfig.json` has
  `exclude: ["test"]` and the mocha runner uses Node type-stripping. Pre-existing, package-wide,
  outside this diff. Not this ticket's to fix and not worth a ticket of its own without a
  broader decision about the store package's test tooling.
- **Performance claim is reasoned, not measured.** One compiled-regex test per text key encode;
  the O(n) pairing loop only runs on strings that actually contain a surrogate code unit. No
  benchmark run. Fine — the pre-test is the same shape as the already-measured
  `HAS_HIGH_SURROGATE` guard in `compareCodePoints`.
- **`HAS_SURROGATE` in the store duplicates the shape of `HAS_HIGH_SURROGATE` in the engine.**
  Different packages, different predicates (any surrogate vs. high surrogate), no shared
  home that both could reach without a new export. Not worth the coupling.

## Validation

- `yarn test` — all workspace suites pass, zero failing.
- `yarn lint` — clean.
