---
description: Date and time arithmetic re-discovers what kind of values it has on every row — running several pattern matches per value — even though the query compiler already knows the types; decide the operation once when the query is compiled.
prereq: temporal-op-table
files:
  - packages/quereus/src/runtime/emit/binary.ts                # buildNumericOpSpec — the temporal branch to specialize (~line 156)
  - packages/quereus/src/types/temporal-ops.ts                 # the case table from the prereq ticket — read it, don't restate it
  - packages/quereus/src/runtime/emit/temporal-arithmetic.ts   # tryTemporalArithmetic (fallback) + dead emitTemporalArithmetic to delete
  - packages/quereus/test/logic/107-temporal-arithmetic-mutation-kills.sqllogic
  - packages/quereus/test/runtime/scalar-op-spec.spec.ts       # emit-note assertions
  - packages/quereus/bench/suites/execution.bench.mjs          # add the temporal-arithmetic scan benchmark
  - docs/runtime.md                                            # § emit-time specializations (~line 263)
difficulty: medium
---

# Pick the temporal case at emit time

After the prereq ticket, `(operator, left kind, right kind) → TemporalOpCase` lives in one
table (`src/types/temporal-ops.ts`) and the declared result type of temporal arithmetic is
accurate. Two things follow.

`buildNumericOpSpec` (`runtime/emit/binary.ts:156`) already knows both operands' logical
types when it chooses the temporal path — it selects that path *because* one of them is
temporal. So the case can be looked up once at emit and captured in the closure. Today the
run function instead calls `tryTemporalArithmetic` per row, which re-derives both operand
kinds from the values (four shape probes each) before it can do the table lookup. For a
`select dt + timespan('P10D') from t` over a scan, that is eight regex/prefix probes per row
computing something the plan settled once.

## Design

Replace the body of the `leftLogical.isTemporal || rightLogical.isTemporal` branch with a
three-way emit-time decision. The generic branch below it (`(numeric)`) is untouched — it is
reached when neither operand is temporal.

```ts
const lk = temporalKindOfType(leftLogical);
const rk = temporalKindOfType(rightLogical);

if (lk && rk) {
	const entry = temporalOpCase(plan.expression.operator, lk, rk);
	if (entry) {
		// (1) Specialized: the case is fixed; the per-row path is one wrapper call.
		run = function runTemporalCased(_ctx, v1, v2) { return runTemporalCase(entry, v1, v2); };
		note = `${plan.expression.operator}(temporal-${lk}-${rk})`;
	} else {
		// (2) Statically unsupported: no combination of runtime values can succeed.
		run = function runTemporalUnsupported(_ctx, v1, v2) {
			if (v1 === null || v2 === null) return null;
			unsupportedTemporalOp();
		};
		note = `${plan.expression.operator}(temporal-unsupported)`;
	}
} else {
	// (3) Fallback: at least one operand is TEXT / ANY / TIMESTAMP / a plugin type.
	//     Runtime sniffing IS the defined semantics there — keep today's body verbatim.
	run = /* the existing runTemporalArithmetic closure, unchanged */;
	note = `${plan.expression.operator}(temporal)`;
}
```

`runTemporalCase` (from the prereq) does the null check, the `apply`, and the
`catch → null` for a malformed value. Using it — rather than inlining `entry.apply` — is
what keeps the specialized path and the sniffing fallback from ever disagreeing about null
handling or about what a bad value does.

### Why arm 2 throws at runtime, not at emit

A combination with no case (DATE + DATE, DATE \* NUMBER, TIME − DATE, anything with `%`)
is statically doomed, so throwing at **plan or emit time** is tempting. Don't. Today the
error is raised only when a row is actually evaluated, so

```sql
select case when 0 then date_a + date_b else 1 end from t;
select date_a + date_b from t where 1 = 0;
select date_a + date_b from empty_table;
```

all succeed. Moving the throw to emit turns each of those into a hard failure — a real
behavior change with no benefit, since the constant-throw closure costs nothing per row on
the paths that do not run it. The null-first check inside arm 2 is load-bearing: today
`date_a + date_b` with a NULL operand returns null rather than erroring, and it must keep
doing so.

### Why the comparison twin is left alone

`tryTemporalComparison` / `tryTemporalCompare` (`runtime/emit/temporal-arithmetic.ts:378+`)
have the same shape but are not worth the same treatment:

- They already cost one `startsWith` per operand, not four regexes — TIMESPAN is the only
  temporal type whose text order differs from its semantic order, so it is the only one
  they check.
- `buildComparisonOpSpec` already bypasses them entirely for the hot case: two operands of
  the same semantic-ordering type take the `sharedSemanticType` path
  (`=(compare-typed)`) and never reach the generic comparison run.
- What is left is the mixed TIMESPAN-vs-TEXT/ANY shape, where runtime sniffing is the
  defined semantics and cannot be resolved from declared types anyway.

Record this in a comment above `tryTemporalComparison` so the next reader does not re-open
the question.

### Dead code

`emitTemporalArithmetic` (`runtime/emit/temporal-arithmetic.ts:345`) is exported and
referenced nowhere — not registered as an emitter, not called from `binary.ts`. Delete it
along with its now-unused `Instruction` / `EmissionContext` / `emitPlanNode` imports.

## Edge cases & interactions

- **Fallback scoping is the correctness boundary.** Specialize only when **both**
  `temporalKindOfType` calls resolve. `text_col - date_col`, `date_col + ?` (an untyped
  parameter announces TEXT), `ts_col + 1` (TIMESTAMP), and any plugin-registered temporal
  type all land in arm 3 with today's behavior byte for byte. Lock each with a test —
  `'not-a-date' - date('2024-01-15')` errors, `timespan('PT1H') + 'PT1H'` → `'PT2H'`.
- **A declared type that lies about its runtime value.** Arm 1 trusts the declaration: a
  DATE-typed operand holding `'garbage'` now returns null (the `catch` in `runTemporalCase`)
  where the sniffing path raised `Unsupported temporal operation`. That is the intended
  trade and it only reaches values a misbehaving virtual table produced — write-side
  coercion enforces declared logical types on every normal path. State it in a comment at
  arm 1 and add a test through a vtab or a cast that can produce such a value, if one can be
  produced at all; if it cannot, say so in the handoff rather than inventing a harness.
- **`bigint` on the numeric side of `*` / `/`.** `timespan('PT1H') * 9007199254740993`
  resolves to the (timespan, number) case at emit, and `apply`'s `typeof v === 'number'`
  guard then raises `Unsupported temporal operation` — the same error as today, by a
  different route. This is the one place the guard is reachable, so it must not be dropped.
- **NULL literals.** `date(...) + null` / `timespan(...) * null` must stay null. Which arm
  they take depends on `NULL_TYPE`'s flags; both arm 1 and arm 2 null-check first, and arm 3
  does too, so all three agree. Test all three shapes.
- **Fusion.** `buildNumericOpSpec` returns a `ScalarOpSpec`, so the scalar-fusion compiler
  composes the new bodies exactly as it composes today's. All three arms are synchronous
  `SqlValue` bodies with two operands, so `assertSpecArity` is satisfied. Add a fusion test
  that a fused temporal expression produces the same value as the unfused one.
- **Note strings are asserted by tests.** `test/runtime/scalar-op-spec.spec.ts` asserts emit
  notes. The new `+(temporal-date-timespan)` shape replaces `+(temporal)` for specialized
  pairs; `+(temporal)` survives only on the fallback arm. Update the existing assertions and
  add one per arm.
- **Deep chains.** `date_col + ts_col - ts_col2 + ts_col3` specializes at every level once
  the prereq lands. Add one as an end-to-end test — it is the expression shape that would
  break loudest if a result type were still wrong.
- **`%` on temporal operands** has no case → arm 2 → same runtime error as today.
- **Predicate position.** `where dt + timespan('P10D') > date('2024-01-25')` already exists
  in `107-temporal-arithmetic-mutation-kills.sqllogic`; it exercises the specialized run
  inside a filter and must keep its result.

## Measurement

Add a benchmark to `packages/quereus/bench/suites/execution.bench.mjs` following the shape
of `full-scan-10k`: a 10K-row table with a `DATE` column and a `TIMESPAN` column, and

```sql
select d + s as a from bench_temporal_t
```

as the timed statement — a per-row temporal add over a full scan, so the win is the probe
elimination and not scan overhead. Name it `temporal-arith-scan-10k`. Do **not** add a
`ratioGuards` entry; those bound a pathological-plan regression, not a constant factor.

Record before/after medians in the handoff: run `yarn bench` on the commit before the change
(`--baseline` against the stored result file), then after. If the numbers land inside
run-to-run noise, say so plainly — the refactor still stands on making one table the single
source of truth, and an honest null result is worth more than a flattering one.

## TODO

- Rewrite the temporal branch of `buildNumericOpSpec` as the three arms above; keep arm 3's
  closure byte-identical to today's.
- Comment arm 1 with the declared-type-trust boundary; comment arm 2 with why the throw
  stays at runtime.
- Add the "left alone, and why" comment above `tryTemporalComparison`.
- Delete `emitTemporalArithmetic` and its orphaned imports.
- Tests — `test/logic/107-temporal-arithmetic-mutation-kills.sqllogic`: all 20 cases keep
  their values; the fallback shapes above; `bigint` multiplier; NULL on each arm; the deep
  chain; the existing WHERE-clause cases unchanged.
- Tests — `test/runtime/scalar-op-spec.spec.ts`: one note assertion per arm
  (`+(temporal-date-timespan)`, `+(temporal-unsupported)`, `-(temporal)` for the TEXT
  fallback); update any assertion that expected the old `(temporal)` note on a now-specialized
  pair.
- Test — fused vs unfused agreement on a temporal expression (`test/runtime/scalar-fusion.spec.ts`).
- Bench — add `temporal-arith-scan-10k`; capture before/after medians.
- Docs — `docs/runtime.md` § emit-time specializations: add the temporal arm to the list of
  specialization pairs alongside `+(numeric-fast)` / `=(compare-typed)`.
- Run `yarn lint` and `yarn test`.
