---
description: Text containing emoji used to sort one way in memory tables and another way in persistent-store tables, so store queries could return rows in the wrong order or silently drop them. The built-in string comparisons now order characters the same way the store's stored bytes do.
files:
  - packages/quereus/src/util/comparison.ts                        # compareCodePoints + bounded variant; BINARY/NOCASE/RTRIM + OBJECT branch route through it
  - packages/quereus/src/types/json-type.ts                        # deepCompareJson: string leaves, object keys, and the object-key sort
  - packages/quereus/src/util/json-canonical.ts                    # NOTE: key sort stays code-unit (deliberate)
  - packages/quereus/src/index.ts                                  # compareCodePoints exported (custom collations need it)
  - packages/quereus/src/core/database.ts                          # registration comment + rewritten NOTE on registerCollation
  - packages/quereus/test/collation-normalizer.spec.ts             # corpus now carries astral + surrogate-boundary characters
  - packages/quereus/test/compare-code-points.spec.ts              # NEW (review) — unit coverage for the primitive and both JSON paths
  - packages/quereus-store/test/astral-text-keys.spec.ts           # store-vs-memory oracle spec (12 tests)
  - packages/quereus-store/src/common/memory-store.ts              # NOTE tripwire on compareHex/localeCompare
  - docs/store.md                                                  # built-in collation table, order-preservation section, per-column PK key collation note
---

# Built-in collations now order by Unicode code point

## What was wrong

JavaScript's `<` / `>` on strings compares UTF-16 **code units**. The persistent store writes
each text key as UTF-8 bytes and physically orders rows by `memcmp` of those bytes, which is
**code-point** order. The two disagree above `U+FFFF`: an astral character (emoji, rarer CJK)
is stored in JS as a surrogate pair whose leading unit lies in `U+D800`–`U+DBFF`, so `<` sorts
it *below* everything in `U+E000`–`U+FFFF` (Private Use Area, CJK Compatibility Ideographs,
the Halfwidth/Fullwidth Forms), while its UTF-8 encoding (`F0…`) sorts *above* theirs (`EE…`,
`EF…`). All three built-in collations compared with `<` / `>` yet were stamped
`orderPreserving: true`, which the store trusts to (a) narrow a range predicate to a byte
window and *drop the residual filter*, and (b) advertise byte order so the planner elides the
`Sort`. Both were wrong for astral text: rows were silently dropped and `order by` emitted byte
order.

## What changed

**`compareCodePoints(a, b)`** (exported from `@quereus/quereus`) is the single primitive. It
fast-paths to V8's native string compare when neither operand contains a high surrogate (then
code-unit order *is* code-point order), and otherwise scans for the first differing code unit
and ranks it with high surrogates lifted above `U+FFFF` (`u + 0x2800`). No surrogate-pair
decoding is needed: at the first difference of two well-formed strings, either both units are
low surrogates or neither is.

Routed through it: `BINARY_COLLATION`, `NOCASE_COLLATION` (on the lowercased forms),
`RTRIM_COLLATION` (via a bounded variant that compares the untrimmed strings up to their
trimmed lengths), `compareSameType`'s `StorageClass.OBJECT` branch (two canonical JSON strings
— this is what an `any` primary key sorts under), and `deepCompareJson`'s string leaves and
object keys.

**Deliberately unchanged:** `canonicalJsonString`'s `Object.keys().sort()` stays on the default
code-unit sort. That order needs only determinism — both the byte encoder and the comparison
string run through the same canonicalizer — and changing it would rewrite the stored key bytes
of every persisted object whose keys contain astral characters. A `NOTE:` at the call site says
so.

**This changes the engine's observable sort order for astral text**, in memory tables too. That
is the point: `'Ａ'` (U+FF21) now sorts before `'😀'` (U+1F600), matching UTF-8 bytes and
matching what SQLite's `BINARY` produces. Nothing in the suite depended on the old order.

## How it is pinned

Three layers, each with teeth:

1. **`compare-code-points.spec.ts`** (added during review) — the primitive itself against
   `memcmp(utf8(·))` over a corpus that straddles every boundary the two orders can disagree
   across, plus the total-order properties `Array.prototype.sort` requires (tri-state result,
   antisymmetry, transitivity, `0` iff identical), plus the OBJECT branch against the canonical
   JSON string's bytes, plus `deepCompareJson`'s string leaves, object keys, and total-ordering
   over objects whose key sets mix astral and BMP keys.
2. **`collation-normalizer.spec.ts`** — for every ordered pair in `CORPUS`,
   `sign(comparator(a,b)) === sign(memcmp(utf8(normalizer(a)), utf8(normalizer(b))))`, for each
   of BINARY / NOCASE / RTRIM. Reverting any built-in to `<` / `>` fails it.
3. **`astral-text-keys.spec.ts`** — a store table and a memory table built from the same DDL and
   the same rows must return the same rows in the same order, AND the plan must still contain
   its `IndexSeek` / still elide its `Sort`. The plan assertions matter: a regression that fixed
   the rows by silently retracting the `orderPreserving` stamp would pass the row checks alone.

Validation run at review: `yarn lint` clean (`packages/quereus`'s lint runs eslint *and*
`tsc -p tsconfig.test.json --noEmit`, so the new spec typechecks); `yarn test` → 6799 passing /
9 pending in `@quereus/quereus`, 872 in `quereus-store`, all other packages green, **0 failing**.

## Review findings

### Checked

The implement-stage diff (`c712fc4e`) read before the handoff summary. The `compareCodePoints`
algebra verified by hand: the `+0x2800` lift maps `U+D800`–`U+DBFF` onto `0x10000`–`0x103FF`,
disjoint from the unlifted `0x0000`–`0xFFFF` range, so the ranking is injective; the
first-difference lemma (both units are low surrogates or neither is) holds for well-formed
operands, and for ill-formed ones the function still yields a lexicographic order on rank
sequences, so it is total and cannot corrupt a `sort()`. Every call site the primitive was
routed through was re-read, as were the sites it was deliberately *not* routed through
(`canonicalJsonString`). Docs (`docs/store.md`) read end to end against the code. Lint, the full
test suite, the two targeted specs, and `yarn bench` all run.

### Fixed in this pass (minor)

- **`packages/quereus/src/util/comparison.ts`** — the doc block on `objectCanonicalCache`
  claimed OBJECT-class "equality *and ordering*" agree with `deepCompareJson`. The ordering half
  is false, and was false before this change too: the OBJECT branch compares canonical JSON
  *syntax* (braces, quotes, commas), while `deepCompareJson` ranks by JSON type, then key list,
  then values. Scoped the claim to equality and named which of the two orders is load-bearing
  (the OBJECT branch's — it is what the store writes and sorts by).
- **`docs/store.md`** — the closing paragraph of § Order preservation still said `any` and
  `json` primary-key columns are keyed under the table key collation `K`, decline their range
  seeks and PK-order advertisement, and are "tracked by
  `fix/bug-store-any-json-pk-keyed-under-table-collation`". That ticket has landed and sits in
  `complete/`; the new `astral-text-keys.spec.ts` itself asserts the `Sort` *is* elided for an
  `any` primary key. Rewritten to state the current behaviour and point at schema.md.
- **`packages/quereus-store/test/astral-text-keys.spec.ts`** — `agreesWithMemory` derived the
  memory query by rewriting `\bt\b` → `m`. The handoff called this brittle; the sharper problem
  is that a query the pattern *fails* to match would have compared the store table against
  itself and passed silently. Narrowed to rewrite only the `from t` clause, and added an
  assertion that the rewrite actually fired.
- **`packages/quereus/test/compare-code-points.spec.ts`** (new, 14 tests) — closes two of the
  three coverage gaps the handoff listed: no direct unit test for `compareCodePoints`, and none
  for `deepCompareJson` with astral string leaves or object keys. The object-key test builds the
  exact key sets on which sorting by code unit and comparing by code point would break
  transitivity, so it fails if the key sort is ever reverted independently of the key
  comparison.

### Found, filed as a new ticket (major)

- **`yarn bench` has no text-comparison benchmark at all.** The handoff's stated gap was "no
  engine-level benchmark was run; a reviewer who wants a real-workload number should run it
  before/after." A reviewer ran it. It cannot produce that number: the execution suite's fixture
  is `bench_t (id integer primary key, val integer, label text)` and every benchmarked query
  orders or filters on `val` or `id`. `label` is never compared, so `BINARY_COLLATION` — the
  engine's hottest comparator — is not on any benchmarked path, and running the suite before and
  after this change yields identical numbers by construction. That is a hole in the benchmark
  suite, not in this change. Filed as `backlog/debt-bench-no-text-comparison-coverage`.

### Found, already tracked elsewhere (no new ticket)

- **`JSON_TYPE.compare` (`deepCompareJson`) and `compareSameType`'s OBJECT branch disagree on
  order.** Confirmed with a concrete pair: `{"a":9}` sorts *above* `{"a":1,"b":0}` under the
  OBJECT branch (canonical-string bytes diverge at `9` vs `1`) and *below* it under
  `deepCompareJson` (key list `["a"]` is a proper prefix of `["a","b"]`). They agree on equality,
  which is all the key-encoding paths need. `deepCompareJson`'s order is only reachable through
  `createTypedComparator`, i.e. the memory table's primary-key BTree — which is precisely the
  subject of `backlog/bug-memory-pk-btree-orders-by-logical-type-compare`. A probe confirmed
  that today's `order by` on a `json` primary key agrees between a store table and a memory
  table, because `ORDER BY` resolves its comparator through `compareSqlValuesFast`, not through
  the logical type. Nothing new to file.
- **Unpaired surrogates** have no UTF-8 encoding (`TextEncoder` folds each to `U+FFFD`), so no
  comparator can be order-preserving over them and the store's text keys are not injective.
  Owned by `implement/2-bug-store-lone-surrogate-key-collision`, which declares this ticket as
  its prerequisite. Both the corpus comment and the new spec's header say so.

### Tripwires parked (conditional; not tickets)

- **`packages/quereus/src/util/comparison.ts`** (new, this pass) — the `HAS_HIGH_SURROGATE`
  guard is an O(length) regex scan of *both* operands, not a constant cost. It was measured only
  on keys up to 40 characters, where V8's compiled-regex path keeps it around 15 ns. Parked as a
  `NOTE:` at the guard, naming the narrowing available if `BINARY` over long text columns ever
  shows up hot: the two orders can only disagree when one operand holds a high surrogate *and*
  the other holds a unit at or above `U+E000`.
- **`packages/quereus-store/src/common/memory-store.ts`** (implement pass) — `compareHex` orders
  the in-memory KV store's keys with `localeCompare` (ICU collation), which only coincides with
  `memcmp` of the key bytes because `keyToHex`'s alphabet is `[0-9a-f]`. Not a defect today, but
  it is the oracle the whole store test suite compares against. Parked as a `NOTE:`.
- **`packages/quereus/src/util/json-canonical.ts`** (implement pass) — the `Object.keys().sort()`
  that must stay on code-unit order, and why. Parked as a `NOTE:` at the call site.

### Checked and clean

Swept for other UTF-16-vs-UTF-8 comparisons that feed or read store bytes. `localeCompare` hits
in `planner/analysis/change-scope.ts`, `schema/lens-prover.ts`, `sync-coordinator`, and
`quoomb-web` all order names/identifiers for determinism or display, never key bytes.
`quereus-sync`'s `compareSiteIds` compares a `Uint8Array` (a site id is 16 raw bytes), not text,
so `compareHLC` and the change-log key bytes are unaffected. The memory table's PK `Map` key
encoder (`vtab/memory/utils/primary-key-encode.ts`) is an equality-only encoding, never ordered,
so it needs no change. No pre-existing test failures surfaced.
