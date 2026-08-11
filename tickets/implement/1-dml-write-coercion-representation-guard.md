---
description: When a value is written into a table column, the engine sometimes skips converting it because it trusts a type label that turns out to be wrong — so a column declared as text can end up holding a raw number, and a column declared as a floating-point number can end up holding a big integer. Make the write path check the value itself, not just the label.
prereq:
files:
  - packages/quereus/src/types/validation.ts                   # buildRowCoercion — the identity skip that is unsound alone
  - packages/quereus/src/runtime/strict-representation.ts      # conformsToType — the "does this value inhabit this type" predicate to share
  - packages/quereus/src/runtime/emit/insert.ts                # caller 1
  - packages/quereus/src/runtime/emit/update.ts                # caller 2 (two phases)
  - packages/quereus/src/planner/building/alter-table.ts       # ARM 2 — the same identity skip, open-coded for ADD COLUMN backfill
  - packages/quereus/src/planner/nodes/alter-table-node.ts     # AddColumnBackfill.coerceTo — documents that skip
  - packages/quereus/test/types/                               # unit home for buildRowCoercion tests
  - docs/types.md                                              # § Physical representation, § Where coercion happens
difficulty: medium
repro: verified
---

# Problem

Every DML write converts each cell to its target column's declared logical type at the top
of the pipeline (`buildRowCoercion`, called from `emitInsert` and `emitUpdate`). The storage
layer is then told `preCoerced` and does not convert again.

`buildRowCoercion` decides *statically*: it compares the producing expression's announced
`LogicalType` against the column's declared `LogicalType` by object identity, and **skips**
any cell whose announced type already IS the column's type. The skip is deliberate and has
a real reason — re-converting is destructive for some types. JSON's `parse` reads a plain JS
string as JSON *source*, so re-parsing a value already read out of a JSON column either
changes it (stored text `9` becomes the number 9) or throws (`abc` is not valid JSON source).
`insert into b select j from a` for a JSON column is exactly that case.

The flaw is that the skip trusts a static type the engine does not otherwise enforce. When
the announced type is wrong, the skip lets a value that does not inhabit the column's
declared value space reach storage.

Two verified instances, both with `QUEREUS_REPR_STRICT` **off** and `MemoryTable` as the
backend:

```sql
create table s (id integer primary key, v integer);
insert into s values (1, 9007199254740993), (2, 9007199254740993);
create table t (id integer primary key, r real);
insert into t values (1, (select sum(v) from s));
select r from t;   -- comes back as the JS bigint 18014398509481986n
```

`sum()` announces REAL; the runtime value is a `bigint` past 2^53. REAL-into-REAL is an
identity match, so the cell is skipped and a REAL column ends up holding a `bigint`.

```js
await db.exec(`create table t (id integer primary key, v text)`);
const s = db.prepare(`insert into t values (?, ?)`);
await s.run([1, 9]);
// stored: the JS number 9, in a TEXT-declared column
```

An untyped positional `?` announces TEXT (the planner's fallback when no hint is available).
TEXT-into-TEXT is an identity match, so the cell is skipped and a TEXT column ends up holding
a number. Binding a `Uint8Array`, a boolean, or a `bigint` past 2^53 does the same. Verified
matrix — every other write shape into the same TEXT column coerces correctly today:

| write | stored in a `text` column |
|---|---|
| `values (1, ?)` + `run([9])` | **number 9** — skipped |
| `values (1, ?)` + `run([new Uint8Array([1,2,3])])` | **Uint8Array** — skipped |
| `values (1, ?)` + `run([true])` | **boolean true** — skipped |
| `values (1, ?)` + `run([9007199254740993n])` | **bigint** — skipped |
| `values (1, :v)` + `run({v: 9})` | `'9'` — coerced |
| `values (1, 9)` (literal) | `'9'` — coerced |
| `prepare(sql, [9])` then `run()` | `'9'` — coerced |

Both are violations of rule R2 in `docs/types.md` § Physical representation — the rule about
*stored* data under a *declared* type, which is exactly the rule the write path exists to
uphold.

# Why fix it here rather than at the announcement

The announced types are separately inaccurate in many places, and that work is tracked by
its own tickets (`binary-op-result-types-match-runtime`,
`remaining-scalar-result-types-and-repr-net`). Fixing every announcement would close these
two instances, but it would leave the *class* open: the write path would still be one
inference bug away from storing a non-conforming value, forever. Some announcements have no
correct answer at plan time by construction (an untyped `?` genuinely is unknown until it is
bound), so "make every announcement exact" is not a reachable end state.

The durable fix is to stop making storage conformance depend on a static claim at all: keep
the static skip as the fast path, and add a cheap runtime guard that catches the case where
the claim is contradicted by the value in hand.

# Design

`runtime/strict-representation.ts` already contains exactly the needed predicate:
`conformsToType(value, type)` — "does this non-null value inhabit this declared type's JS
value space", keyed on `physicalType` so plugin-registered types are covered, with the two
special cases (NUMERIC admits `bigint`; OBJECT/JSON admits a bare string/number/boolean
because a JSON scalar is physically one) already correct. It is currently module-private and
lives under `runtime/`, which the `types/` layer should not import from.

Move that predicate down a layer — e.g. a new `src/types/representation.ts` exporting
`conformsToType` (and, if it helps the caller, a `buildConformanceCheck(type)` that
pre-selects the per-`physicalType` arm once at emit time). `runtime/strict-representation.ts`
imports it from there rather than defining it, so the checker and the write path can never
come to disagree about what "conforms" means.

Then change `buildRowCoercion` so a statically-skipped cell is not skipped unconditionally,
but guarded:

- **Convert unconditionally** (as today) when the announced type differs from the column's
  type, or is `undefined` (unknown provenance).
- **Guard** when the announced type IS the column's type: at run time, if the value conforms
  to the column's type, pass it through untouched; otherwise run `validateAndParse`.

The JSON case that motivated the skip stays safe: a value read out of a JSON column — a
native object/array, or a JSON scalar such as the string `abc` or the number 9 — conforms to
JSON's OBJECT physical type, so the guard passes it through and `parse` is never re-applied.
Both instances above are caught: a `bigint` does not conform to REAL (whose name is not
`NUMERIC`), and a number/`Uint8Array`/boolean/`bigint` does not conform to TEXT.

Note the guard is a *conjunction*, not a replacement. A representation-only rule would be
wrong on its own: a TEXT-announced expression feeding a DATE column produces a string, which
conforms to DATE's TEXT physical type, yet still needs converting so the spelling is
canonicalized. Keeping the static difference check as the primary trigger preserves that.

`buildRowCoercion` should keep returning `undefined` when there is genuinely nothing to do —
but with the guard, "nothing to do" now means "no column needs converting **and** no column
needs guarding". Columns whose `physicalType` imposes no constraint (`ANY` / NULL) need no
guard, so an all-`ANY` row still allocates nothing.

## Cost

The guard adds one predicate call per *skipped* cell per row, where today there is zero work.
Pre-select the arm at emit time (one closure per guarded column) so the per-row cost is a
`typeof` or `instanceof` rather than a switch. This has not been measured; if it ever shows
up in `test/performance-sentinels.spec.ts`, note it there rather than reverting the guard.

## Arm 2 — the ADD COLUMN backfill mirrors the same skip

`planner/building/alter-table.ts` open-codes the identical rule for a per-row ADD COLUMN
backfill:

```ts
const coerceTo = node.getType().logicalType === newColumnType ? undefined : newColumnType;
```

and `AddColumnBackfill.coerceTo` (in `planner/nodes/alter-table-node.ts`) documents it by
pointing at `buildRowCoercion`. It is the same claim about the same kind of value, so it must
get the same guard — otherwise the two sites drift and a future reader trusts the wrong one.
No instance of the ADD COLUMN case has been reproduced; it is included because the rule must
be single-sourced, not because a failure is known. Prefer factoring the decision into one
shared helper over copying the guard.

# Acceptance

- The two repros above store conforming values: the REAL column holds the JS number
  `18014398509481986`, the TEXT column holds `'9'`.
- `QUEREUS_REPR_STRICT=1` stays quiet at the DML write seam across the whole suite.
- `insert into b select j from a` for a JSON column still does not re-parse — including when
  the stored JSON value is the string `abc` (which `parse` would throw on) and the string
  `9` (which `parse` would silently turn into the number 9).
- `yarn test`, `yarn test:store`, `yarn test:repr-strict`, `yarn lint`, `yarn typecheck` pass.

# Downstream

lamina excludes `packages/lamina-quereus-test/src/retype-insert-equivalence.test.ts` from its
`QUEREUS_REPR_STRICT=1` lane over the positional-`?` case above — thirteen grid cells bind a
stored non-string into a `text` column as a positional parameter. That exclusion can lift once
this lands. lamina's own plugin-side coercion
(`packages/lamina-quereus/src/affinity-coercion.ts`) masks the defect for lamina-backed tables
today, which is why it surfaced there as a strict-mode failure rather than a wrong stored
value; `MemoryTable` has no such backstop.

# TODO

- [ ] Move `conformsToType` from `runtime/strict-representation.ts` into a new
      `src/types/representation.ts`; re-export/import it from the strict checker so there is
      one definition. Keep the existing doc comment (the NUMERIC-by-name and OBJECT-admits-
      scalars notes are load-bearing) with it.
- [ ] Add an emit-time `buildConformanceCheck(type)` returning a per-`physicalType` predicate
      closure (or `undefined` for `ANY`/NULL, which need no guard).
- [ ] Rework `buildRowCoercion` to emit two per-column dispositions — *always convert* and
      *convert only if non-conforming* — and return `undefined` only when neither applies to
      any column. Update its doc comment: the identity skip is now conditional, and the
      reason (an announced type is an inference the engine does not enforce) belongs in prose
      at that site.
- [ ] Apply the same rule to the ADD COLUMN backfill decision in
      `planner/building/alter-table.ts`, sharing the helper rather than copying it; update
      `AddColumnBackfill.coerceTo`'s doc comment in `planner/nodes/alter-table-node.ts`.
- [ ] Unit tests for `buildRowCoercion` covering: identity + conforming (skips), identity +
      non-conforming (converts), differing types (converts), `undefined` source type
      (converts), JSON identity with a native object / a bare string / a bare number (all
      skip), `ANY` column (no guard).
- [ ] Engine-level regression tests for both repros in this ticket, plus the `Uint8Array`,
      boolean and `bigint` variants of the positional-`?` case, and the four already-correct
      rows of the table above (named param, literal, `prepare(sql, params)`, non-TEXT column)
      to pin that they keep their current results.
- [ ] Update `docs/types.md` § Where coercion happens to state the write-path rule as it now
      is: convert unless the source type matches the column type *and* the value already
      inhabits it.
- [ ] Run `yarn test`, `yarn test:store`, `yarn test:repr-strict`, `yarn lint`,
      `yarn typecheck`.
