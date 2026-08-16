description: Fixed a bug where, inside a database transaction, reading a table through a secondary index could silently hide unrelated committed rows whenever the table's row-identity columns allowed empty (NULL) values.
files:
  - packages/quereus-isolation/src/isolated-table.ts (`pkShadowKey`, ~553-570)
  - packages/quereus-isolation/test/null-pk-shadow-key.spec.ts (new regression tests)
  - packages/quereus/src/util/key-serializer.ts (unchanged — `serializeKey` vs `serializeKeyNullGrouping`, both pre-existing and already exported)
difficulty: easy
---

# Fix landed: NULL primary-key components no longer collapse the isolation layer's shadow key

## What changed

`packages/quereus-isolation/src/isolated-table.ts`, function `mergedSecondaryIndexQuery`,
local `pkShadowKey`:

- Swapped `serializeKey(...)!` for `serializeKeyNullGrouping(...)` (no more `!` assertion —
  the function's return type is now plain `string`, matching what it always does).
- Both come from `@quereus/quereus`'s `packages/quereus/src/util/key-serializer.ts`, already
  exported from the package's public `index.ts` — no changes needed there.
- Rewrote the comment above the call: it used to assert "PK columns are NOT NULL, so
  `serializeKey` never returns null" (false for a no-`PRIMARY KEY` table's synthesized
  all-columns key, which does not force NOT NULL on its members). It now explains why a
  NULL key component is a legitimate value that must be tagged, not treated as absence of a
  key.

## Why this mattered

`pkShadowKey` builds the string used to decide "has this row's primary key already been
touched in the transaction's overlay?" for a merged secondary-index read. The old
`serializeKey` returns actual `null` (not a distinct string) the instant ANY key component
is NULL — every row with a NULL anywhere in its key collapsed to that same one `null`
bucket. So touching (inserting, updating, or deleting) just ONE row with a NULL key
component in a transaction would make the merge wrongly hide EVERY OTHER row — committed,
untouched — that also had a NULL key component, from a query running inside that same
transaction. `serializeKeyNullGrouping` tags a NULL component with a positional `N:` marker
instead, so it still contributes to a per-row-distinct key.

This is reachable today on any table declared with no explicit `PRIMARY KEY` (Quereus
synthesizes an all-columns key for those, and does not promote its columns to NOT NULL) that
has at least one nullable column. `tickets/implement/feat-relax-declared-primary-key-not-null`
(not yet implemented) will widen the same exposure to explicitly-declared primary keys too —
this fix was a documented prerequisite for that ticket and should already be in place.

## Test coverage — what's proven, and how

New file `packages/quereus-isolation/test/null-pk-shadow-key.spec.ts`, three tests, each
driving a real `db.exec`/`db.eval` sequence through a `create index` + secondary-index read
(NOT a full scan/primary-key merge — verified via the underlying memory module's captured
`idxStr`, since a full scan doesn't call `pkShadowKey` at all and would pass vacuously):

1. **Headline case** — a no-PK table `t (id integer null, tag text not null)`; three
   committed rows all with `id = NULL`; inside a transaction, insert one new NULL-`id` row
   and delete another; read the rest through `ix_tag`. Asserts the untouched NULL-`id` row
   still surfaces. **Verified failing pre-fix** (confirmed via `git stash` on just the
   source file + rerun): only the freshly-inserted row came back, the untouched committed
   ones vanished — exactly the bug.
2. **Differing NULL position** — a 3-column no-PK table where one committed row is NULL in
   its first key column and another is NULL in its second; an unrelated third row (also
   NULL in the first column) is deleted in the transaction. Asserts both surviving rows come
   back unaffected by each other or by the deleted row. **Also verified failing pre-fix**
   (both rows vanished, not just one — the old bug is component-blind, not just
   position-blind, so this doubles as an extra angle on the headline case).
3. **NULL vs the literal string `'N:'`** — two committed rows sharing an indexed column,
   one with `val = NULL`, the other with `val = 'N:'` (the literal text of the NULL-grouping
   marker); deletes the NULL row, asserts the `'N:'`-valued row is not wrongly shadowed.
   This one passes both before and after the fix (the old bug only bites when a row's key
   contains an actual NULL, not the string `'N:'`) — it's a forward-guard against a
   hypothetical future regression in the encoder's type-tagging (e.g. if a NULL marker and a
   literal string value were ever encoded without a type prefix), not a repro of today's bug.

All three pass against the fixed code. Isolation package's own full suite:
`yarn workspace @quereus/isolation test` → **413 passing**, no regressions.
`yarn workspace @quereus/isolation run typecheck` → clean.

## Sweep for other unsafe call sites (per ticket TODO)

Searched every `serializeKey(` call site in the monorepo. Two others exist, both already
safe by design (not PK identity, no `!` assertion, `null` handled deliberately):

- `packages/quereus-store/src/common/store-module-index-build.ts`, `dedupeRowSignature` —
  returns `string | null` on purpose; a `null` there means "at least one UNIQUE-constrained
  column is NULL," and SQL's own rule is that UNIQUE allows multiple NULL rows, so `null`
  correctly means "never conflicts."
- `packages/quereus/src/runtime/emit/join-key-extractor.ts`, the hash-join key extractor —
  also returns `string | null` on purpose; SQL join equality never matches NULL to NULL, so
  a `null` key correctly means "this row can never match on this key."

No other PK-identity caller was found asserting non-null. (The ticket's own planning pass
had already found the same: `database-transaction.ts` uses the NULL-safe `encodeKeyTuple`.)

## Validation run for this handoff

- `yarn workspace @quereus/isolation test` — 413 passing (isolation package's own suite,
  includes the 3 new tests).
- `yarn workspace @quereus/isolation run typecheck` — clean.
- Pre-fix repro confirmed via `git stash` on just `isolated-table.ts` + rerun (2 of 3 new
  tests fail exactly as described above; restored via `git stash pop` before continuing).
- Full monorepo `yarn test` (all workspaces) — **all passing, 0 failures**, exit code 0
  (~20 min wall clock; every package's tally came back green: quereus core 9601 passing,
  quereus-isolation 413, quereus-store 1794, quereus-sync 725, sync-coordinator 85,
  quereus-sync-client 31, plugin-loader 119, quoomb-cli 64, quoomb-web 68, quereus-vscode
  34, plugin packages 134 total, sample-plugins 22 — no `failing` reported anywhere in the
  run).
- `yarn lint` (all workspaces) — clean. `packages/quereus` is the only package with a real
  lint (eslint + a `tsc -p tsconfig.test.json --noEmit` pass over test files); it produced no
  output, which for eslint means no findings. Every other package's lint script is an
  intentional no-op and echoed as such. `packages/quereus` itself was not modified by this
  ticket (only its already-exported `serializeKeyNullGrouping` was consumed), so this lint
  pass is a sanity check, not new-code coverage.

## Known gaps for the reviewer

- No changes were made outside `packages/quereus-isolation`. The fix is a 2-line swap plus a
  comment rewrite; the bulk of the diff is the new test file.
- I did not add coverage through the persistent store backend (`quereus-store`) for this
  same scenario — the ticket's own edge-case list flagged this as optional ("confirm through
  the store leg if the harness there reaches it"). The bug lives entirely in
  `quereus-isolation`'s in-memory overlay-merge logic (`pkShadowKey` is isolation-layer-only
  code, not store code), so a store-backed repro would be testing the same isolation-layer
  function through an extra layer of indirection, not new logic. I judged it not worth the
  added complexity, but a reviewer who wants extra confidence on the store leg specifically
  could add one.
- I did not update `docs/schema.md`'s "Primary-key nullability" section — it already
  documents the synthesized-key nullability behavior this fix now correctly honors; nothing
  about that section was wrong or needed changing.
