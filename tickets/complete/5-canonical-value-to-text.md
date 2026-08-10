description: The engine used to turn a value into text in several disagreeing ways, so binary data came out as decimal numbers in one place and hex digits in another, and a JSON document was silently destroyed. One conversion now exists and every place uses it.
files:
  - packages/quereus/src/util/value-text.ts                          # the one conversion
  - packages/quereus/src/types/builtin-types.ts                      # TEXT_TYPE.parse; BLOB_TYPE.parse number arm
  - packages/quereus/src/types/cast-semantics.ts                     # castFallback TEXT + BLOB arms
  - packages/quereus/src/util/affinity.ts                            # applyTextAffinity tail + dead-module NOTE
  - packages/quereus/src/func/builtins/aggregate.ts                  # group_concat value + separator
  - packages/quereus/src/func/builtins/string.ts                     # like()/glob() — fixed during review
  - packages/quereus/src/runtime/emit/binary.ts                      # emitConcatOp, emitLikeOp, constLikePattern
  - packages/quereus/test/util/value-text.spec.ts                    # per-type unit table + call-site agreement
  - packages/quereus/test/logic/03.6.2-value-to-text.sqllogic        # SQL-visible behaviour suite
  - packages/quereus/test/logic/05.2-cast-seek-correctness.sqllogic
  - packages/quereus/test/logic/06.8-json-path-operators.sqllogic
  - packages/quereus/test/fuzz.spec.ts                               # tripwire NOTE on the blob generator
  - docs/types.md, docs/functions.md, docs/sql-select.md
---

# One value-to-text conversion, used everywhere

## What shipped

`valueToText` (`packages/quereus/src/util/value-text.ts`) is the single answer to "what is
this value as text": a string is itself, a number/bigint/boolean is its plain spelling, a
BLOB is its UTF-8 decode, a JSON document is its own JSON text, NULL stays NULL. It never
throws for a value that inhabits `SqlValue`.

Every construct that renders a value as text now calls it: `TEXT_TYPE.parse` (and so
`cast(x as text)`, `text(x)`, writes into a TEXT column, the ALTER retype backfill, DEFAULT
folding), `castFallback`'s TEXT and BLOB arms, `||`, `group_concat`, TEXT affinity, the
`LIKE` operator, and — added in review — the `like()`/`glob()` functions.

User-visible changes are listed in the implement handoff (commit `86d078ae`); the ones with
teeth are that `cast(x'6162' as text)` is now `ab` rather than `6162`, that a JSON document
casts to its own text rather than `[object Object]`, and that inserting a BLOB into a TEXT
column **stores** the UTF-8 decode, which is lossy for bytes that are not valid UTF-8.

## Review findings

### Checked

Read the implement diff first, then the touched sites and the ones it should have touched:
every `String(` in `src/` (only `func/builtins/string.ts` is a real text-rendering site;
the rest are error messages and AST-to-SQL printers), the whole emit layer, `func/builtins`,
key/fingerprint paths (correctly left on `canonicalJsonString` — `valueToText` is not
injective and must not become a key), the three docs files, and the two `.sqllogic` files
whose expectations moved. Behaviour claims were verified by running the engine, not read off
the diff. `yarn build`, `yarn test` (8822 + workspace suites, 0 failing) and `yarn lint`
pass. `yarn test:store` was not re-run in review — the implementer ran it green and the
review changes do not touch the write path.

### Fixed in this pass (minor)

- **`like()` and `glob()` contradicted the `LIKE` operator.** `x'6162' like 'ab'` was true
  while `like('ab', x'6162')` was false — two spellings of one operation answering
  differently — and `docs/functions.md` had already been edited to claim `like()` used the
  one conversion. Both functions now call `valueToText`
  (`packages/quereus/src/func/builtins/string.ts`), and
  `test/logic/03.6.2-value-to-text.sqllogic` gained assertions tying the function to the
  operator, plus `like`/`glob` over a blob and over a JSON document.
- **`docs/types.md` overclaimed.** "Every construct … calls it and nothing else" was false
  while the rest of the string builtins coerce their own way. The section now names the
  exception and points at the ticket below; `docs/functions.md` § String Functions gained a
  paragraph stating what those functions actually do with a non-text argument.
- **The shared `TextDecoder` was constructed at module load.** `TextDecoder` is not a
  global everywhere the engine runs — the React Native plugin checks for it before opening a
  store — so an eager construction turned "cannot cast a blob to text on this platform" into
  "cannot import the engine on this platform". It is now built on first blob decode, which
  matches how `BLOB_TYPE.parse` reaches for `TextEncoder`, and keeps the shared-instance win.

### Filed (major)

- **`tickets/backlog/debt-string-builtins-coerce-three-different-ways.md`** — the remaining
  string builtins are the same class of defect this ticket set out to kill: `substr`, `trim`,
  `replace` and `instr` render a BLOB as `97,98` (JavaScript's array stringification), while
  `lower`, `upper`, `reverse`, `lpad` and `rpad` return NULL for the same argument. Filed at
  the seam rather than per function: the ask is an argument-coercion policy in
  `createScalarFunction` plus one property test asserting `f(x) = f(cast(x as text))` over
  every builtin that declares a text argument, so the divergence cannot come back. The
  implementer surfaced this and deliberately left the call to review; the call is: one debt
  ticket, not per-function bugs.

### Recorded as a tripwire, not a ticket

- The fuzz oracles in `test/fuzz.spec.ts` compare rows through `cast(col as text)`, which is
  now lossy for blobs. **Measured:** the blob generator emits exactly one constant value
  (`x'00'`), so nothing can collide today and no coverage was actually lost — the
  implementer's concern here was unmeasured and turns out to be nil. A `NOTE:` sits on the
  generator (`test/fuzz.spec.ts`, the `case 'blob'` arm) saying what breaks if blob
  generation ever widens.

### Considered and left alone

- **`util/affinity.ts` is dead code** — nothing in `src/` imports it. The implementer
  recorded that as a `NOTE:` at the module head with a stated revisit condition ("deleting
  this module is a safe call if a release needs to shrink the surface"). That is an accepted
  tradeoff already weighed; not re-filed.
- **`castFallback`'s TEXT arm is unreachable** now that `TEXT_TYPE.parse` is total, and
  `TEXT_FUNC`'s `try`/`catch` is likewise dead. Both are about the *target type* rather than
  today's type object — a plugin type registered under those names would need them — and
  both carry comments saying so. Left.
- **`castFallback(null, BLOB)` now returns `null`** instead of the UTF-8 of the string
  `'null'`. Unreachable (`lenientCast` guards NULL first) and the honest answer. Left.
- **`cast(cast(x'6162' as text) as blob)` no longer round-trips.** Deliberate, and owned by
  `blob-text-conversion-explicit`, which is the next ticket in the pipeline. No test pins the
  broken result.
- **Number spelling still diverges from SQLite** (`cast(1.0 as text)` is `1`, not `1.0`).
  Out of scope by the ticket, owned by `bug-real-to-text-formatting-differs-from-sqlite`, and
  pinned by the unit spec so the divergence is visible rather than accidental.

### Empty categories

No correctness defect was found in `valueToText` itself or in any converted call site — the
per-type table, the totality sweep, the NULL propagation and the three SQL-level agreement
assertions all hold, and the `ignoreBOM: true` and document-key-order decisions are both
correct and pinned by tests. No performance finding: the conversion adds one call on paths
that previously inlined `String(v)` and nothing here runs in a hot loop that was profiled
either before or after; nothing was measured, and nothing suggested measuring was needed.
