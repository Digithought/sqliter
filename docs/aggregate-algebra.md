# Aggregate Function Algebra

> **Stability: Beta** — see [Stability Tiers](stability.md#tiers).

`AggregateFunctionSchema.algebra` (optional) declares the algebraic structure of an aggregate's accumulator — the single place the engine learns how an aggregate's values combine (`merge`), reverse (`negate`), reconstruct from a stored value (`decode`), and rewrite onto sibling partials (`decompose`). It is pure metadata: it never affects function resolution or the `schema()` / `function_info()` listings. An aggregate that declares nothing (the default) is simply maintained by full recompute (the residual/rebuild floor for materialized views) — nothing forces a UDAF to declare algebra.

```ts
interface AggregateAlgebra {
	/** Commutative, associative combine of two accumulators; a clone of
	 *  initialValue is the identity (a commutative monoid). Enables partial
	 *  aggregation / rollup. */
	merge: (a: AggValue, b: AggValue) => AggValue;
	/** Group inverse: merge(a, negate(a)) ≡ identity. Enables retraction.
	 *  Absent ⇒ tighten-only (inserts can be folded in; deletes force recompute). */
	negate?: (a: AggValue) => AggValue;
	/** Reconstruct a working accumulator from the STORED (finalized) output value.
	 *  Omit when impossible (avg — the quotient forgets the count). */
	decode?: (stored: SqlValue) => AggValue;
	/** True when decode is a FULL inverse of finalize (decode(finalize(a)) ≡ a for
	 *  every reachable accumulator), so a decoded accumulator stays observational
	 *  under RETRACTIONS too (law 4b). Absent ⇒ decode is only an
	 *  insert-observational witness; the write-side delta arm then applies a
	 *  retraction through it only when it can otherwise prove the true contribution
	 *  count stays positive (see the maintenance docs). */
	decodeExact?: boolean;
	/** This aggregate is a scalar expression over sibling partial aggregates —
	 *  e.g. avg(x) ≡ sum(x)/count(x). */
	decompose?: AggregateDecomposition;
}

interface AggregateDecomposition {
	/** Sibling partials, by function name + argument shape.
	 *  'same-arg' → f(thisArg); 'star' → count(*)-shaped (no argument).
	 *  One level deep: each partial must itself be directly algebra-complete. */
	partials: ReadonlyArray<{ func: string; arg: 'same-arg' | 'star' }>;
	/** Build the composed *finalized* value from the partials' finalized values,
	 *  in partials order. Must reproduce this aggregate's finalize exactly,
	 *  including the empty-group case (avg: count 0/NULL ⇒ NULL). */
	combine: (partialValues: readonly SqlValue[]) => SqlValue;
}
```

Declare via `createAggregateFunction({ ..., algebra: { ... } }, step, finalize)`.

### The author contract (laws)

Algebra functions are peers of `stepFunction`: same accumulator representation, same comparison/collation context, and pure (no mutation of inputs). Absent field = property not held (never "unknown"). The laws, where **equivalence is finalize-then-byte-compare** (two accumulators are equal iff they finalize to the same stored value, under the storage-class-tolerant BINARY comparison — bigint `5n` ≡ number `5`):

1. `merge` is associative and commutative; a clone of `initialValue` is its identity.
2. Step/merge coherence: `step(a, x) ≡ merge(a, step(identity, x))` — including `x = NULL` (a NULL contribution is merge-identity for NULL-ignoring aggregates).
3. `merge(a, negate(a)) ≡ identity` — retract∘insert of the same rows is a no-op. Retracting one source row `x` is `merge(acc, negate(step(identity, x)))`.
4. Decode is observational, not bijective: `finalize(merge(decode(finalize(a)), b)) ≡ finalize(merge(a, b))` for `b` built from *inserted* rows. A stored value must round-trip to an accumulator that *behaves* identically under further merges; it need not reconstruct the original accumulator. Decode of a stored SQL NULL must yield the *empty* accumulator, never a wrapped NULL.
   - **4b (only when `decodeExact` is declared):** the same identity holds for `b` containing retractions (`negate`d contributions) — decode fully reconstructs the accumulator. `count`'s decode is exact (the stored int *is* the accumulator); `sum`'s is not (the stored sum forgets how many non-NULL rows contributed), which is exactly why sum must not declare the flag.
5. Decompose: `finalize(a) ≡ combine([finalize(p) …])` over the partial accumulators induced by the same input rows.

Law 3 has a subtle consequence: an accumulator must be able to *observationally return* to the empty state. A bare running sum cannot — insert 5 then retract 5 leaves `{sum: 0}`, which finalizes to `0`, while the empty group finalizes to `NULL`. The builtin `sum` therefore tracks a contribution count alongside the running sum and finalizes `count === 0` as `NULL`; a UDAF with a NULL-on-empty finalize and a `negate` needs the same pattern.

A non-exact decode's count witness must additionally be **absorbing**: `sum.decode(stored)` reconstructs `{sum: stored, count: Infinity}` — non-zero (the group is non-empty) and unable to reach zero under any finite retraction. A finite witness (e.g. `1`) would collapse to `0` on the first retraction and finalize a spurious `NULL` while contributions remain. The write-side delta arm pairs this with its own proof obligations (a NOT NULL argument column plus the count(*) multiplicity witness) before retracting through a non-exact decode — see [Materialized-View Maintenance § delta fast path](mv-maintenance.md#residual-recompute-single-source-aggregate-shape).

Validate a declaration with the `fast-check` law harness on the test surface (`test/util/aggregate-algebra-laws.ts`):

```ts
assertAggregateAlgebraLaws(mySchema, valueArb /* legal argument values, incl. NULL */);
```

It property-checks laws 1–5 for whichever fields are present and throws naming the violated law. Pick a `valueArb` matching the value-domain the declaration is exact for (integers for sum — float sums drift, which is a value-domain property the write side gates on, not something the declaration can express).

### Call-site binding (`bindArgs`)

An aggregate whose result depends on how its arguments *compare* cannot be declared once for all call sites: `min(x)` must rank by elapsed time when `x` is a `timespan`, structurally when it is `json`, and under the declared collation when it is collated text — the same ordering [`ORDER BY` uses](types-ordering.md#semantic-ordering). A schema may therefore declare an optional `bindArgs(args)` hook, called **once per call site** at emit / materialized-view plan-build time — never per row — with one `{ logicalType?, collation? }` per declared argument. It returns replacement `stepFunction` / `finalizeFunction` / `algebra` closures, or `undefined` to keep the declared defaults. Apply it with `bindAggregateSchema(schema, args)` (`func/registration.ts`), which is idempotent — a bound schema keeps the hook, so no call site has to track whether it already bound.

Two obligations beyond the laws above:

- **The bound `algebra` must compare the same way the bound `stepFunction` does.** A `merge` that ranks differently from the step makes materialized-view maintenance disagree with direct evaluation. Deriving both from one comparator (as the builtin min/max factory does) makes this structural rather than a review item.
- **The bound `algebra` must declare the same FIELDS as the unbound declaration.** Delta-maintenance and rollup eligibility are decided from field presence on the *unbound* schema; a binding that dropped `decode` would be gated in and then fail.

Bound and unbound schemas are both worth law-checking — `test/incremental/aggregate-algebra.spec.ts` runs the harness over `bindAggregateSchema(minFunc, [{ logicalType: TIMESPAN_TYPE }])` as well as the registered default, since a step/merge comparator mismatch only shows up in the bound pair.

One consequence to keep in mind when consuming *stored* results: an aggregate's result type carries its argument's logical type but **not** the argument's collation, so anything re-ranking stored partials must take the collation from the argument rather than from the column the partials landed in (see `MergeReagg.argCollation`).

### Builtin declarations

| aggregate | merge | negate | decode | decodeExact | decompose |
|---|---|---|---|---|---|
| `count(*)`, `count(x)` | `a+b` | `-a` | stored int (finalize is identity) | yes | — |
| `sum(x)` | add (bigint-promoting) | yes | stored v → non-empty accumulator with an absorbing (Infinity) count witness; NULL → empty | — (witness) | — |
| `min(x)` / `max(x)` | keeps whichever value the call site's comparator ranks first/last (the same comparator as step — see [Call-site binding](#call-site-binding-bindargs)) | — (tighten-only) | stored v → accumulator; NULL → empty | — | — |
| `avg(x)` | sum+count pairwise | yes | — (quotient forgets the count) | — | `sum(x)`, `count(x)` → real division; count 0/NULL ⇒ NULL |
| `total`, `group_concat`, `var_*`, `stddev_*` | — | — | — | — | — (deliberately residual-only; e.g. total's float running sum drifts under retraction) |
