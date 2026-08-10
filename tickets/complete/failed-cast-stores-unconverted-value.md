---
description: A conversion that cannot succeed used to quietly keep the original value, so the word "junk" could end up stored in a date column; it now produces an empty value instead.
files:
  - packages/quereus/src/types/cast-semantics.ts                          # new — castFallback + castCanYieldNull
  - packages/quereus/src/runtime/emit/cast.ts                             # reads the node's resolved type; imports castFallback
  - packages/quereus/src/planner/nodes/scalar.ts                          # CastNode.generateType
  - packages/quereus/src/planner/analysis/expression-fingerprint.ts       # tripwire NOTE
  - packages/quereus/src/planner/building/expression.ts                   # stale comment
  - packages/quereus/test/cast-static-type.spec.ts
  - packages/quereus/test/lens-prover.spec.ts
  - packages/quereus/test/plan/cast-seek-blocking.spec.ts
  - packages/quereus/test/logic/99.1-cast-syntax-extras.sqllogic
  - packages/quereus/test/logic/06.9.2-json-structural-equality.sqllogic
  - docs/types.md
---

# A failed CAST yields NULL instead of the unconverted operand

## Final behavior

`CAST` stays lenient — it never throws — but it never produces a value outside
the type it advertises either.

- Numeric / text / binary targets keep SQLite's fallbacks (`0`, `0.0`,
  `String(v)`, UTF-8 bytes). Each is a valid member of its own type.
- Every other target keeps the operand only when the target type's own
  `validate` accepts it, and yields NULL otherwise. So `cast('junk' as date)`,
  `cast('junk' as boolean)` and `cast(x'0102' as json)` are NULL, while
  `cast('abc' as json)` still returns `'abc'` (a bare string is a legitimate
  JSON string scalar even though it is not valid JSON *source text*).
- Writing an unconvertible value into a nullable column stores NULL; into a
  `not null` column (Quereus's default) it raises `NOT NULL constraint failed`
  rather than silently storing garbage.

Static typing follows: `CastNode.getType()` reports `nullable` for a cast that
changes the logical type — **except** to TEXT or BLOB, which convert every
non-null operand and so cannot introduce a NULL. The emitter reads the resolved
target type back off the node instead of re-resolving the type name, so plan and
runtime cannot disagree.

## Review findings

### Checked and clean

- **Every `castFallback` arm against its own type's `validate`** — INTEGER `0`,
  REAL `0.0`, NUMERIC `0`, TEXT `String(v)`, BLOB UTF-8 bytes all pass. Now
  asserted mechanically at the SQL level by a `typeof(...)` row in
  `99.1-cast-syntax-extras.sqllogic`, closing the implementer's "checked by
  reading, not by asserting" gap.
- **Reference identity of resolved types** — `typeRegistry.inferType` returns
  registry singletons, so the `logicalType !== operandType.logicalType`
  comparison in `CastNode.generateType` is sound (it is not comparing freshly
  built objects).
- **The `parse`-less type path in `emitCast`** — still returns the operand
  unchanged, which is the exact shape `castFallback` exists to prevent. It is
  unreachable today (NULL is the only builtin without `parse`, and the parser
  rejects it as a CAST target) and already carries a `NOTE:` saying so.
- **Store-mode write path** — `yarn test:store` (LevelDB backend) was the
  implementer's largest flagged gap. Run: **7398 passing / 19 pending / 0
  failing**. The NULL-reaching-storage claim holds off the memory vtab too.
- **Other consumers of `ScalarType.nullable`** — join/FD/decorrelation rules,
  `key-filter`, `coverage-prover`, `statement.ts` parameter binding. All of them
  gate optimizations *off* when a type is nullable, so a widened `nullable`
  costs at most a missed optimization. Only two consumers turn it into a hard
  rejection, and one of those was a real regression (below).
- **Docs** — `docs/types.md` was the only file describing CAST leniency; its
  "known cases" list and JSON-comparison paragraph both now describe the settled
  rule. `docs/lens.md`'s type/nullability conformance row is stated generally
  and remains accurate.

### Found and fixed in this pass

- **Nullability was over-widened, and it broke a sound lens deploy.** Reporting
  *every* type-changing cast as nullable made
  `declare lens … select cast(n as text) as n …` fail
  `lens.nullability-mismatch` against a `not null` logical column, even though
  TEXT converts every non-null operand and cannot produce NULL. Reproduced
  against the committed code, then narrowed: a new `castCanYieldNull` exempts
  TEXT and BLOB. Regression tests added to `lens-prover.spec.ts` (the TEXT case
  deploys clean; the DATE case still blocks, because a temporal target genuinely
  can yield NULL) and to `cast-static-type.spec.ts`.
- **The target type name was resolved twice** — once in `CastNode.generateType`,
  once in `emitCast`. The implement pass fixed the *symptom* (both now call
  `inferType`) but left the duplication, so the two could drift apart again.
  `emitCast` now reads `plan.getType().logicalType`; the node is the single
  resolution site.
- **`castFallback` lived in the runtime emitter but encodes knowledge the
  planner also needs.** Moved to a new `src/types/cast-semantics.ts` alongside
  `castCanYieldNull` — the two functions encode the same table (which targets
  are total, which can reach NULL) and would be a silent-drift hazard apart.
- **A stale comment** in `planner/building/expression.ts` claimed the synthetic
  `CastExpr`'s `targetType` was read "by the emitter"; the emitter no longer
  reads it.

### Found and filed as a ticket (by the earlier, interrupted review pass)

- `backlog/bug-cast-json-to-text-loses-document` — `cast(<json> as text)` yields
  the literal `[object Object]`, destroying the document. It satisfies this
  ticket's rule (it *is* a string) so the fix here cannot address it; it
  predates this work.

### Recorded as tripwires, not tickets

- `types/cast-semantics.ts`, on `castFallback` — `validate` is optional on
  `LogicalType`, so a custom registered type that omits it NULLs on every parse
  failure. All builtins define one; the fix if a plugin type ever needs the
  operand preserved is to give that type a `validate`.
- `types/cast-semantics.ts`, on `castCanYieldNull` — identity comparison against
  the TEXT/BLOB singletons, so a plugin type registered under a TEXT-ish alias
  is treated as nullable-producing. Safe direction: over-reporting costs an
  optimization, under-reporting would let a NULL reach a `not null` column.
- `planner/analysis/expression-fingerprint.ts` — cast fingerprints key off the
  *written* target name, so `cast(x as varchar)` and `cast(x as text)` never
  share a CSE slot despite resolving identically. Under-merge only, never an
  over-merge; the one-line switch is noted at the site.

### Deliberately not pursued

- **No new ticket for the `parse`-less emitter path.** It is unreachable through
  the parser today and the site documents what to do if a plugin makes it
  reachable — a conditional concern, not a latent defect.
- **`union-branch-value-not-converted-on-write`** is the same root shape (a node
  advertising a logical type it does not produce) and was already landed as its
  own ticket (`ba38293a`); nothing here duplicates it.

## Validation

Run from a clean tree after all review edits:

- `yarn workspace @quereus/quereus run lint` — clean (eslint + `tsconfig.test.json` type pass).
- `yarn test` — **7404 passing / 13 pending / 0 failing** across all workspaces.
- `yarn test:store` — **7398 passing / 19 pending / 0 failing**.
- `yarn build` — clean.

Note on reading the counts: the sqllogic harness registers **one mocha `it()`
per `.sqllogic` file**, not per assertion, so assertions added inside an existing
file do not move the total.

## Prior-run note

An earlier review run of this ticket was interrupted after making edits but
before writing this file. Its work was swept into the next ticket's commit
(`d477ff2c`, `ticket(fix): fk-update-actions-fire-when-key-unchanged`): it added
`test/cast-static-type.spec.ts`, the affinity-alias seek case in
`test/plan/cast-seek-blocking.spec.ts`, the `typeof` fallback-arm and blob-JSON
UNKNOWN assertions, the `parse`-less `NOTE:` in the emitter, and the
`bug-cast-json-to-text-loses-document` backlog ticket. That work is included in
the findings above and was re-verified here.
