---
description: Add an opt-in debug mode that checks, as a query runs, that every value really is in the JavaScript form its declared type promises — so a plugin or built-in that drifts is caught by a test instead of by a wrong answer months later.
prereq: integer-canonical-representation
files:
  - packages/quereus/src/runtime/strict-flags.ts        # where QUEREUS_FORK_STRICT / QUEREUS_CONTEXT_STRICT live; add the new flag here
  - packages/quereus/src/util/numeric-canonical.ts      # isCanonicalNumeric, from the prereq ticket
  - packages/quereus/src/runtime/strict-representation.ts  # NEW — the checker
  - packages/quereus/src/runtime/emit/dml-executor.ts   # write seam: rows about to reach vtab.update
  - packages/quereus/src/runtime/emit/scalar-function.ts # UDF return seam
  - packages/quereus/src/vtab/module.ts                 # module contract prose — what a query() row must contain
  - docs/types.md                                       # § Physical representation (written by the prereq) — add the enforcement subsection
  - packages/quereus/test/property.spec.ts              # fast-check round-trip property
difficulty: medium
---

# A debug-mode representation checker

The prereq ticket states the representation rules (R1, canonical numeric form; R2,
per-declared-type value space) and canonicalizes every point where the engine itself
*mints* a value. Two ingress boundaries are deliberately left uncoerced, because coercing
them means a per-row cost exactly where measurement says there is nothing to win:

- rows returned by a virtual-table module's `query()` — including third-party modules the
  engine cannot vet;
- values returned by user-defined functions.

For those the contract is *declared and checked*, not enforced: a module or UDF is
**obliged** to return values in canonical form, and an opt-in strict mode verifies it.
That is the same shape the engine already uses for parallel-fork immutability
(`QUEREUS_FORK_STRICT`) and stale row contexts (`QUEREUS_CONTEXT_STRICT`) — see
`runtime/strict-flags.ts` and `runtime/strict-fork.ts`.

**No capability flag.** A `representationFidelity` declaration on `VirtualTableModule`
(alongside `scanSnapshotIsolation`) was considered and rejected: nothing would *behave*
differently based on it. The engine tolerates both numeric forms everywhere today and will
continue to, so a module declaring "I am faithful" and a module declaring nothing would
take the identical code path — a config knob with no consumer, which rots. The obligation
goes in the module contract prose and the strict checker enforces it in tests.

## Shape

```ts
// runtime/strict-flags.ts
/** `QUEREUS_REPR_STRICT` — physical-representation assertions (see strict-representation.ts). */
export const REPR_STRICT = readFlag('QUEREUS_REPR_STRICT');

// runtime/strict-representation.ts
/** R1: no bigint may hold a safe-range integer. Needs no declared type. */
export function assertCanonicalValue(value: SqlValue, where: string): void;

/** R2: the value inhabits its declared logical type's JS value space (implies R1). */
export function assertConformsToType(value: SqlValue, type: LogicalType, where: string): void;

/** Row form of {@link assertConformsToType}; `types[i]` may be undefined (ANY/untyped → R1 only). */
export function assertRowConforms(
  row: Row, types: readonly (LogicalType | undefined)[], where: string): void;
```

A violation throws `QuereusError(StatusCode.INTERNAL)` whose message names the seam, the
column/argument, the declared type, the offending JS `typeof` and a safe rendering of the
value. It must be actionable by a plugin author who has never read this ticket.

Every call site is guarded by `if (REPR_STRICT)` read from the module-level const, so with
the flag off the check is a single already-false branch V8 folds away — no closure
allocation, no per-row work, nothing built at emit time.

## Seams

Four, chosen so that each catches drift at the layer that *caused* it rather than three
layers downstream:

1. **Virtual-table scan output** — rows leaving a `query()` cursor, checked against the
   table's declared column types. Catches a non-conforming module (in-tree or third-party)
   at its own boundary.
2. **DML write** — the row about to be handed to `vtab.update`, checked against the
   declared column types, *after* the DML pipeline's coercion pass. Catches a value that
   would otherwise be persisted non-canonically, which is the failure mode with the longest
   fuse.
3. **UDF return** — a scalar function's returned value, checked against its schema's
   declared return type when it declares one.
4. **Statement row egress** — rows yielded to the caller, checked against the plan's output
   attribute types. This is the backstop that catches an *expression* producing a
   non-canonical value (an arithmetic path that forgot to narrow), which none of the other
   three see.

Pick the narrowest existing choke point for each; do not add a new pipeline stage.

## Edge cases & interactions

- **Flag off costs nothing.** Verify by reading the emitted code path, not by benchmark:
  no allocation and no type lookup may happen at emit time on behalf of the checker. A
  regression here would be invisible in the flagged run and expensive in the normal one.
- **The checker must never `JSON.stringify` a value.** `JSON.stringify(5n)` throws "Do not
  know how to serialize a BigInt" — the exact class of bug the checker exists to find, and
  a spectacular way for the error path to fail. Render through `util/value-text.ts`
  (`valueToText`), which is total over `SqlValue`, and truncate long renderings.
- **`ANY` and untyped positions** get R1 only. `types[i] === undefined` is normal, not an
  error, and must not be reported as one.
- **Most temporals are physically TEXT, but TIMESTAMP is not.** A DATE value is a `string`;
  R2 must not demand a `Temporal` object. TIMESTAMP is the exception — it is an integer
  instant (`physicalType` INTEGER, value space `number | bigint` under R1), so it takes
  INTEGER's rule, not TEXT's. Likewise a JSON *string scalar* is physically a plain
  `string`, not an object — the JSON row of R2's table is the fiddly one, write its test
  first.
- **`null` is always admissible.** The checker does not police nullability; that is
  `notNull` constraint enforcement's job and lives elsewhere.
- **A failing check must not be caught and swallowed** by a surrounding `try`/`catch` that
  is there for conversion errors. Check the seams for enclosing catches before placing the
  call — particularly the DML seam.
- **Async and forked paths.** The scan seam sits inside an `AsyncIterable`; keep the check
  synchronous and inside the existing loop so it cannot introduce a microtask hop even when
  enabled (see docs/runtime.md on the synchronous fast path).
- **Turning the flag on across the existing suite will find things.** Expect in-tree
  violations — the memory module and `@quereus/store` are the first suspects, plus any
  builtin whose declared return type is narrower than what it returns. Each one is either a
  real fix in this ticket or, if it is a bigger change than this ticket can carry, a
  `fix/` ticket named in the handoff. **Do not loosen the checker to make the suite pass**,
  and do not skip a test to hide a violation. One such builtin was already found and fixed
  during the prereq's review — `random()` wrapped its (always safe-range) draw in
  `BigInt()`, so every call minted an R1 violation. Expect more of the same shape.
- **`@quereus/store`'s exported `decodeValue` / `decodeCompositeKey`** return `BigInt(...)`
  for every integer-valued key, which violates R1 for small integers. They are key decoders
  and are not used to reconstruct rows, so the strict checker will not see them — filed
  separately as `backlog/debt-store-key-decode-returns-noncanonical-integers`. Do not chase
  it here.

## Key tests

- A mocha spec that flips the flag on for a `Database` (the flag is read once at module
  load, so drive this by running a dedicated spec under the env var, mirroring however
  `QUEREUS_FORK_STRICT` is exercised today — check that harness before inventing a new one).
- A deliberately non-conforming test vtab module (return `5n` for an INTEGER column) →
  the scan seam throws, and the message names the module, the column and the type.
- A deliberately non-conforming registered UDF declaring an INTEGER return and returning
  `5n` → the UDF seam throws.
- A conforming run of the existing logic suite under the flag produces **zero** violations.
- fast-check property in `test/property.spec.ts`: values spanning types and the numeric
  boundary survive insert → select with both value and representation intact, with the
  flag on.

## TODO

- Add `REPR_STRICT` to `runtime/strict-flags.ts` with a doc comment matching its siblings.
- Write `runtime/strict-representation.ts` implementing R1/R2 over `LogicalType`
  (`physicalType` plus the INTEGER/NUMERIC canonical rule from `util/numeric-canonical.ts`).
- Wire the four seams, each behind `if (REPR_STRICT)`.
- State the module obligation in `vtab/module.ts`'s contract prose (near
  `scanSnapshotIsolation`, which is the tone to match) and the UDF obligation wherever UDF
  return types are documented.
- Add the enforcement subsection to `docs/types.md` § Physical representation: the flag
  name, what it checks, the four seams, and the explicit "no capability flag, and why".
- Run the full suite with `QUEREUS_REPR_STRICT=1` and resolve or escalate every violation.
- `yarn build && yarn test && yarn lint`; then the flagged run.
