---
description: Registering a function without a usable return type used to be accepted silently and then blow up with a confusing internal error mid-query; now bad declarations are rejected up front with a clear message, and the plugin docs show shapes the engine actually reads.
files:
  - packages/quereus/src/func/registration.ts                 # normalizeFunctionSchema — the contract; create* helpers route through it
  - packages/quereus/src/core/database.ts                     # registerFunction calls it and stores the normalized schema
  - packages/quereus/src/schema/function.ts                   # type guards answer false instead of throwing on an absent returnType
  - packages/quereus/src/index.ts                             # scalarReturn + *_RETURN constants + the ScalarType/RelationType/ColumnDef/ColRef shapes
  - packages/quereus/test/function-return-type.spec.ts        # the contract's spec
  - packages/quereus/test/documentation.spec.ts               # doc examples run; doc-rot guard
  - packages/quereus/test/boundary-validation.spec.ts         # stale returnType fixtures fixed
  - packages/sample-plugins/string-functions/index.ts         # now declares through the shared constants
  - packages/sample-plugins/comprehensive-demo/index.ts       # same
  - docs/plugins.md                                           # every function example rewritten; "Declaring return types" section
  - docs/types.md                                             # § Omitting the return type cross-references the contract
difficulty: medium
---

# One stated contract for a registered function's return type

## What shipped

`normalizeFunctionSchema(schema)` in `packages/quereus/src/func/registration.ts` is the
single place that answers what a registered function's `returnType` may look like:

- **absent** (or `null`) means "unknown" and becomes a nullable scalar of ANY — so a
  schema with an implementation and no declared return type is taken to be *scalar*;
- **present but malformed** throws `MisuseError` naming the function and the offending
  field (`Function 'f/1': …`) at registration, rather than surfacing as an internal
  `undefined` read at planning time;
- **present, well-formed but incomplete** is filled in for the fields with one obvious
  answer: a scalar's `nullable`, and a relation's `isReadOnly` / `isSet` / `keys` /
  `rowConstraints`. Only `columns` carries meaning the author must supply.

Both registration paths route through it — `Database.registerFunction` (what every plugin
reaches via `registerPlugin`) and all four `create*` helpers. The type guards in
`schema/function.ts` answer `false` for a schema with no `returnType` instead of throwing,
so anything that reaches the planner by another route degrades to a named error and
`function_info()` keeps enumerating.

Public surface: `scalarReturn`, the `*_RETURN` / `*_RETURN_NOT_NULL` constants,
`normalizeFunctionSchema`, and the `ScalarType` / `RelationType` / `ColumnDef` / `ColRef`
shapes are exported from the package index. `docs/plugins.md` gained a
§ *Declaring return types*; every function example there was rewritten onto the helpers.

Backwards compatibility is a deliberate break: an out-of-tree plugin that copied the old
documented `{ typeClass: 'scalar', sqlType: 'TEXT' }` shape, or typed relation columns
with type-name strings, registered successfully before and now throws at registration.
`docs/plugins.md` says so explicitly.

## Review findings

Read the implement diff (`8704b3dd`) before the handoff summary. Checked source hygiene,
DRY, error handling, type safety, resource cleanup (none involved — no handles or
listeners in this diff), test coverage, and every doc the change touched or should have
touched.

### Fixed in this pass (minor)

- **The ANY default was still duplicated.** The handoff said "one constant rather than
  three copies", but `UNKNOWN_SCALAR_RETURN` was a fourth hand-written copy of
  `ANY_RETURN` (`func/builtins/return-types.ts`) — same four fields, same values. It now
  aliases `ANY_RETURN`; the explanatory comment stays at the default site.
- **A scalar's `nullable` was not filled, though a relation's omittable fields were.**
  `ScalarType.nullable` is a required field, but `{ typeClass: 'scalar', logicalType:
  TEXT_TYPE }` — an easy hand-built shape — passed validation and was stored with
  `nullable: undefined`, i.e. a type that does not satisfy its own declared shape.
  Nothing reads it unsafely today (`filter.ts` and the materialized-view helpers both
  test `=== false`, so `undefined` lands on the nullable side), so this was hygiene, not
  a live bug. `normalizeScalarType` now fills it — for the return type itself and for
  every relation column — matching the relation-field fill the implementer already added.
- **A relation's `keys` were only checked for being an array.** `keysOf`
  (`planner/util/fd-utils.ts`) reads `ref.index` straight through into the plan's key set,
  so `keys: [['v']]` (column names where `{ index }` references belong) minted a key over
  column `undefined`, and an out-of-range index minted one over a column that does not
  exist — both surviving registration and then feeding DISTINCT elimination and
  join-cardinality reasoning. Same failure class as the string-typed column shape this
  ticket was written for, one field over. Now validated structurally: array of arrays of
  `{ index }` integers within the declared columns, with `[]` still meaning the empty key.
  Confirmed no in-tree schema declares a non-empty `returnType.keys` (the non-empty ones
  in `func/builtins/schema.ts` are `relationalAdvertisement.keys`, a different field).
- **The shapes the docs tell authors to write were not exported.** `scalarReturn` was
  exported but its return type `ScalarType` was not, and § Declaring return types tells
  plugin authors to hand-build a relation `returnType` whose `RelationType` / `ColumnDef`
  / `ColRef` types were likewise unnameable outside this repo. All four now export from
  the index, and the doc says so.
- **The sample plugins still hand-rolled their own scalar-type constants** while the docs
  taught `TEXT_RETURN` / `scalarReturn` — a divergence between what we ship as examples
  and what we tell people to write. `string-functions` and `comprehensive-demo` now
  declare through the shared constants; their local `*_SCALAR` literals are gone.
- **Dead `return schema` after an exhaustive switch** in `normalizeFunctionSchema`
  (both live cases return, the default throws). Removed.

Tests added to `function-return-type.spec.ts` for each: key shape / key-by-name /
out-of-range key index rejection, declared-key and empty-key acceptance, scalar and
column `nullable` fill, `returnType: null` treated as absent, and that registration does
not mutate the caller's schema object.

### Recorded as a tripwire, not a ticket

- `TVFAdvertisement.keys` (`relationalAdvertisement`) is the same shape feeding the same
  `keysOf` consumer and is still unvalidated. Nothing in-tree declares a bad one and it is
  a separate documented contract (docs/optimizer-retrieve.md), so it is a NOTE on
  `validateRelationKeys` in `func/registration.ts` rather than work.

### Checked and accepted as-is — no ticket

- **`Schema.addFunction` stays an ungated map insert.** The handoff asked for a second
  opinion; the tradeoff is right. It is where the ~116 built-ins land on every database
  open, those are compile-time-typed, and the loosened type guards already keep a
  hand-inserted bad schema from throwing an internal error. Gating it would revalidate
  every builtin on every open for no reachable benefit.
- **Structural, not exhaustive, validation.** A `logicalType` with `name` + `physicalType`
  that is not a registered type still passes. Deliberate per the ticket, and deeper
  validation would need the type registry at registration time.
- **Doc examples are transcribed into `documentation.spec.ts`, not extracted from the
  markdown.** Rot in a direction neither the transcription nor the fenced-code-block guard
  names is still possible; the cost of a real extractor is not worth it for three examples.
- **`Database.createScalarFunction` / `createAggregateFunction` still accept no
  `returnType` from the caller** — already `tickets/backlog/feat-udf-registration-surface-gaps.md`.

### Not found

No correctness defect in the shipped normalization itself, and no missing cleanup or
error-handling path — `normalizeFunctionSchema` allocates nothing that outlives the call
and every rejection is a `MisuseError` raised before the schema is stored. Registration
order (name / numArgs / implementation checks first, return type last) is correct and is
pinned by a test.

## Validation

`yarn build`, `yarn lint`, `yarn typecheck`, `yarn test` from the repo root — all exit 0,
no new warnings. `packages/quereus` is 8225 passing (8217 at the implement handoff, +8
tests added here); every other workspace green. `yarn test:store` not run — nothing in
this diff touches the store path.
