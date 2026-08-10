---
description: A public helper in the storage package turns every whole number it reads back out of a key into the big-number JavaScript type, even for small values — which disagrees with the form the engine promises everywhere else.
files:
  - packages/quereus-store/src/common/encoding.ts   # decodeNumeric (~line 526) — the BigInt(primary) arm
  - packages/quereus-store/src/common/index.ts      # decodeValue / decodeCompositeKey are exported from here
  - packages/quereus/src/util/numeric-canonical.ts  # the canonical-form rule these should honor
tradeoffs: The affected decoders are exported but unused inside the repo, and returning a bigint uniformly may well be deliberate — it makes the residual-reconstruction arm and the exact arm return the same type — so a maintainer could reasonably say the engine's canonical-form rule simply does not reach key bytes.
---

## What

`decodeNumeric` in `@quereus/store`'s `common/encoding.ts` reconstructs a numeric key
value and returns `BigInt(primary)` for **any** integer-valued primary — so the key for
the value `5` decodes to `5n`, not `5`.

The engine's canonical numeric form (see `docs/types.md` § Physical representation, landed
by the `integer-canonical-representation` ticket) says a JS `bigint` only ever holds a
magnitude outside the safe-integer range. `decodeNumeric`'s output does not satisfy that.

## Why it is dormant rather than broken

`decodeValue` and `decodeCompositeKey` are exported from the package's public surface but
have no in-repo caller that reconstructs a row: rows are read back through `serializeRow` /
`deserializeRow`, which round-trip a `bigint` faithfully via a `$bigint` marker. So nothing
in the repo today observes the non-canonical output. A plugin or downstream consumer using
the exported decoders would.

The engine's debug-mode representation checker (`QUEREUS_REPR_STRICT`) will not catch this
either — it checks values at the engine's own seams, and these decoders sit outside them.

## Expected

`decodeValue` / `decodeCompositeKey` return values in the engine's canonical form: narrow
an integer result back to a `number` when it is inside the safe-integer range, keep the
`bigint` otherwise. Nothing about the *key bytes* or their ordering changes — this is
purely what the decoder hands back.

Worth settling while fixing: whether the fractional/non-finite arm and the residual arm
need any adjustment, or whether narrowing the exact arm is the whole change.
