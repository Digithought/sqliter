---
description: The storage package creates a brand-new text encoder/decoder object every time it converts a key or value between bytes and text, instead of reusing one — a small but repeated cost on a path that runs once per column of every row scanned.
files:
  - packages/quereus-store/src/common/encoding.ts        # decodeText (~609), decodeObject (~629), encodeText (~404), encodeObject (~450)
  - packages/quereus-store/src/common/serialization.ts   # already hoists its own pair (textEncoder / decoder)
  - packages/quereus-store/src/common/key-builder.ts     # already hoists its own pair (encoder / decoder)
  - packages/quereus-store/src/common/json-key.ts        # already hoists its own encoder (utf8)
  - packages/quereus-store/src/common/store-module-catalog.ts  # per-call allocations, but cold path
difficulty: easy
tradeoffs: The per-call saving is tens of nanoseconds and the hot sites are key encode/decode rather than row decode, so a maintainer could reasonably call this noise next to the JSON parse it sits beside — and three files already hoist their own private pair, so the only thing a shared module buys is that the fourth file doesn't have to remember.
---

## What

`TextEncoder` and `TextDecoder` are stateless for non-streaming use, so one instance can
serve the whole process. The storage package half-knows this: `serialization.ts`,
`key-builder.ts`, and `json-key.ts` each hoist their *own* private instance, while
`encoding.ts` and `store-module-catalog.ts` still allocate a fresh one at every call site.
The knowledge lives in three separate comments instead of one place, so each new file
rediscovers it — or doesn't.

## Why it is worth doing

Measured on Node 24, decoding a 26-byte key:

| | per call |
|---|---|
| `new TextDecoder().decode(bytes)` | 87.6 ns |
| hoisted `decoder.decode(bytes)` | 51.3 ns |

So ~36 ns of pure allocation overhead, about 41% of the call. `decodeText` runs once per
text column of every key decoded, so it multiplies by columns × rows on scans that
reconstruct key values. The cold sites (`store-module-catalog.ts` — DDL rehydration,
schema persistence) are not worth chasing for speed, but sweeping them keeps one rule
instead of two.

The same hoist inside `serialization.ts` was part of a change measured at an ~84%
reduction in row-deserialize cost (the rest came from skipping the JSON reviver), which is
how this pattern surfaced.

## Expected shape

One small module — e.g. `packages/quereus-store/src/common/utf8.ts` — exporting a single
shared `utf8Encoder` / `utf8Decoder` pair, with the "stateless per non-streaming call" note
stated once there rather than repeated per file. Every in-package site that converts
between `Uint8Array` and `string` imports from it; the three files with private hoists drop
theirs.

Worth settling while doing it: whether a lint rule (or a comment in the module) is enough
to keep new code from re-introducing `new TextDecoder()` at a call site. `@quereus/store`
currently has no real lint configured, so an enforced rule would mean standing one up —
probably out of scope, in which case say so and rely on the shared module being the obvious
import.

Behavior must not change: this is allocation only, no encoding, ordering, or format change.
