---
description: A handful of built-in SQL functions supply their own hand-written evaluation code and are therefore locked out of the engine's fast path for expressions; give them a way to opt in.
files:
  - packages/quereus/src/runtime/scalar-fusion.ts        # where the refusal happens
  - packages/quereus/src/schema/function.ts              # customEmitter hook (~line 183)
  - packages/quereus/src/func/builtins/scalar.ts         # nullif, greatest, least
  - packages/quereus/src/func/builtins/json.ts           # json_schema
  - packages/quereus/src/func/builtins/mutation.ts       # mutation_ordinal
tradeoffs: A second hook alongside `customEmitter` that every custom-emitter author must then learn and keep consistent with the first, to speed up five functions — a maintainer could reasonably say the fast path already covers the common cases and this is not worth a wider plugin contract.
---

# Let custom-emitter functions join the scalar fast path

## Background

The engine compiles pure, synchronous scalar expressions into a single direct closure
instead of running them step-by-step through the instruction scheduler (see
`docs/runtime.md` § the two-tier execution model). Deciding whether a node can be compiled
this way requires knowing how it evaluates.

A function may supply a `customEmitter` — its own function that builds the runtime
instruction — instead of using the default call path. The fast-path compiler cannot see
inside a custom emitter, so it refuses those functions outright, and refusal propagates:
any expression containing one falls back to the slow path entirely.

Affected built-ins today: `nullif`, `greatest`, `least` (`func/builtins/scalar.ts`),
`json_schema` (`func/builtins/json.ts`), `mutation_ordinal` (`func/builtins/mutation.ts`).
All five are pure and synchronous, so all five *could* take the fast path. Plugin-supplied
custom emitters have the same problem.

## What a solution needs to decide

- Whether custom emitters get a **second, optional hook** that returns a fast-path closure
  (an author who implements only the instruction hook keeps today's behavior), or whether
  the shape they already return can be inspected well enough to compile automatically.
- What a custom emitter must promise to be eligible: synchronous, no sub-programs, no
  lazily-invoked callbacks — and whether that promise is checked or trusted.
- Whether `mutation_ordinal` belongs at all: it reads per-row state off the runtime
  context, which is legal on the fast path but worth confirming against the mutation-context
  rules in `docs/runtime.md`.

## Why it is not urgent

`nullif`, `greatest` and `least` are far less common in hot predicates than `lower`,
`substr` or `abs`, which the fast path already covers once
`runtime-scalar-fusion-function-calls` lands. Nobody has measured what these five cost in a
real query — that measurement should come before the design.
