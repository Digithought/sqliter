---
description: Checking whether a JSON document is one of the values a subquery returns never finds a match, even when the subquery plainly returns that document as text. Reproduced; two separate places in the engine drop the text-to-JSON conversion, and a validated fix for each is described below.
files:
  - packages/quereus/src/runtime/emit/subquery.ts                 # emitIn + inMembershipKey — fix site A (there is no emit/in.ts)
  - packages/quereus/src/planner/rules/subquery/rule-subquery-decorrelation.ts  # extractInCorrelation — fix site B
  - packages/quereus/src/planner/building/coercion.ts             # coerceObjectPhysicalSet / insertCrossTypeCoercion — reuse, don't reinvent
  - packages/quereus/src/types/cast-semantics.ts                  # castFallback — factor the lenient-cast body out of emitCast to here
  - packages/quereus/src/runtime/emit/cast.ts                     # emitCast — becomes a caller of the shared helper
  - packages/quereus/src/types/json-type.ts                       # JSON_TYPE.parse / compare — the semantics being matched
  - packages/quereus/src/planner/analysis/comparison-collation.ts # inRhsTypes — RHS type of an IN node
  - packages/quereus/test/logic/06.9.2-json-structural-equality.sqllogic  # add § 5.1 here
  - docs/types.md                                                 # line ~229 explicitly documents this gap; must be rewritten
difficulty: medium
---

# `json_col in (select text_col from …)` never matches

## What happens

Comparing a JSON column against SQL text works everywhere else. Against a row holding
the document `{"a":1,"b":2}`, all of these match:

```sql
select 1 where json_col =  '{ "b" : 2 , "a" : 1 }';
select 1 where json_col in ('{ "b" : 2 , "a" : 1 }');
select 1 where json_col =  (select s from t);
select 1 where json_col between '{"a":0}' and '{"a":9}';
case json_col when '{ "b" : 2 , "a" : 1 }' then …
```

The subquery form of `in` does not:

```sql
select 1 where json_col in (select s from t);       -- no rows
```

Reproduced. **All three** of these return no rows today, and each fails for its own
reason:

| Shape | Path taken | Why it misses |
| --- | --- | --- |
| `json_col in (select text_col from t)` | `emitIn` set-probe | membership compares a JS object against a JS string |
| `text_col in (select json_col from t)` | `emitIn` set-probe | same, mirrored |
| `json_col in (select text_col from t2 where t2.id = outer.id)` | decorrelated semi-join | the rule synthesizes `json_col = text_col` with no conversion |

## Why

A JSON value lives in memory as a native JavaScript object; a text value is a string.
The engine's generic value comparison ranks the two by storage class and never calls
them equal. Every working site above is fixed **at plan time** by wrapping the non-JSON
side in `cast(… as json)` — `insertCrossTypeCoercion` / `coerceObjectPhysicalSet` in
`planner/building/coercion.ts`, driven from the `'in'`, `'between'`, `'case'` and binary-op
arms of `planner/building/expression.ts`.

Two sites skip that.

**Site A — membership evaluation (`runtime/emit/subquery.ts`, `emitIn`).** The `in`
builder (`building/expression.ts` ~line 237) calls `coerceObjectPhysicalSet` for the
value-list arm only; the subquery arm builds the `InNode` with the condition untouched,
because there is no fixed operand list to wrap — the right-hand values arrive one row at
a time. So the conversion has to happen per row inside `emitIn`.

`emitIn` already has the hook for exactly this: `inMembershipKey(plan)` returns a
canonical-key transform applied to both sides of every comparison, and all three source
paths (impure drain, uncorrelated set-probe, correlated/streaming) route through it. It
returns a transform only for a logical type with `semanticOrdering` **and** a `groupKey`
hook — that is TIMESPAN and nothing else. JSON has `semanticOrdering` but no `groupKey`,
so the transform is identity and the object/string mismatch survives.

**Site B — IN decorrelation (`planner/rules/subquery/rule-subquery-decorrelation.ts`,
`extractInCorrelation`).** A *correlated* `col in (subquery)` in `where` position is
rewritten into a semi-join, and the rule synthesizes the membership comparison itself:

```ts
const equiCondition = new BinaryOpNode(
    outerColRef.scope,
    { type: 'binary', operator: '=', left: outerColRef.expression, right: innerColRef.expression },
    outerColRef,
    innerColRef
);
```

That `BinaryOpNode` is built directly, bypassing the coercion every hand-written `=`
gets. Site A's fix cannot reach it: by the time `emitIn` would run, there is no `InNode`
left. Verified with `--show-plan` — the plan is a `SEMI MERGE JOIN` keyed on the `id = id`
correlation, with `v = s` demoted to the join's residual and evaluated there, uncoerced.
The same helper also feeds the SELECT-list arm (`decorrelateExistsInProjection`, which
turns a correlated `in` in the select list into an existence-flag LEFT JOIN), so one fix
covers both.

Note the *uncorrelated* IN decorrelation arm (`extractUncorrelatedIn`) is already safe
without any change: its `extractEquiPairs` gate refuses a pair whose two sides disagree
on semantic ordering (`semanticOrderingsAgree` — JSON vs TEXT), so a mixed pair declines
decorrelation and stays on the `emitIn` set-probe path that site A fixes.

## Expected behavior

`json_col in (select …)` agrees with `json_col = <each value>`:

- whitespace and object key order irrelevant; array element order significant
- a non-JSON string simply does not match, rather than raising
- a value the JSON type rejects outright (a blob) is UNKNOWN, not false — so neither
  `in` nor `not in` yields a row for it
- three-valued logic on inner NULLs is unchanged
- the reverse direction (`text_col in (select json_col …)`) behaves the same way, since
  the established rule is "if either side is JSON, the other side is read as JSON"
- two spellings of the same document are ONE member of the set, matching `group by` and
  a unique index on a JSON column

## Validated fix

A throwaway prototype of both sites below was built and run: the repro cases in
"Coverage to add" all passed, and the full `yarn test` suite stayed green. The prototype
was then reverted — the tree is clean, this is the whole implementation.

### Site A — `runtime/emit/subquery.ts`

First, factor the lenient-cast body out of `emitCast` (`runtime/emit/cast.ts`) into
`types/cast-semantics.ts` so both callers share one definition of "coerce to this type
the way `CAST` does":

```ts
/** What `cast(<value> as type)` produces — `parse`, falling back to {@link castFallback}. */
export function lenientCast(value: SqlValue, type: LogicalType): SqlValue {
	if (value === null) return null;
	if (!type.parse) return value;
	try {
		return type.parse(value);
	} catch {
		return castFallback(value, type);
	}
}
```

Then split `inMembershipKey`'s single shared transform into an asymmetric pair — one
transform for the probe (the `condition`), one for each right-hand member:

```ts
interface InMembershipKeys {
	probe: (value: SqlValue) => SqlValue;
	member: (value: SqlValue) => SqlValue;
}
```

Resolution order:

1. **Exactly one side object-physical.** If the condition's logical type has
   `physicalType === PhysicalType.OBJECT` and no RHS type does (and at least one RHS type
   is not `NULL_TYPE`), then `member = v => lenientCast(v, conditionType)` and
   `probe = identity`. Mirrored when a RHS type is object-physical and the condition's is
   not (and the condition's is not `NULL_TYPE`).
2. **Otherwise** both are the existing `inMembershipKey` transform, unchanged.

The asymmetry is load-bearing, not tidiness: it is what `insertCrossTypeCoercion` already
does (it casts the *non*-object side only). Applying the JSON coercion to the object side
too would re-parse JSON **string scalars** — a JSON column holding the document
`"[1,2]"` is stored as the plain JS string `[1,2]`, and running it back through
`JSON_TYPE.parse` would turn it into the JSON *array* `[1,2]` and collide the two
documents.

Gate on `physicalType === OBJECT`, **not** `semanticOrdering` — same reasoning as the
comment on `insertCrossTypeCoercion`, and same scoping as `coerceObjectPhysicalSet`:
do **not** extend this to the numeric-vs-textual pairing. `int_col in ('1')` is false
today (tracked by `bug-numeric-text-coercion-skips-in-and-case`) and must stay false here,
or the subquery form would start disagreeing with the value-list form in the other
direction.

Then thread the pair through all three source arms plus the two value-list arms:
`probeKey(condition)` where the condition is keyed, `memberKey(rowValue)` where a
right-hand value is keyed. Two consequences to handle while doing it:

- **A coerced value can become NULL.** `lenientCast` of a blob to JSON yields NULL
  (`castFallback`'s default arm — the JSON type will not validate a `Uint8Array`). So the
  `=== null` checks must move to *after* the transform: a member that coerces to NULL sets
  `hasNull` instead of being inserted into the set, and a condition that coerces to NULL
  returns NULL. In the set-probe arm, keep that return *before* the set is built, so the
  existing "do not force the build" short-circuit still holds.
- **Rename the local `probeKey` symbol** in the set-probe arm (`Symbol('IN(set-probe)')`,
  the `rctx.inSetProbes` memo key) — the name now collides with the probe transform. The
  prototype used `probeSlot`.

No change is needed to the BTree comparator. `compareSqlValuesFast`'s OBJECT-class branch
compares canonical JSON strings, so once both sides are native objects, reorder-equal
documents already land on one key — which is what satisfies the "one member per document"
requirement.

Also update `inMembershipKey`'s doc comment: its closing sentence currently asserts that
JSON "takes no transform", which stops being the whole story.

### Site B — `planner/rules/subquery/rule-subquery-decorrelation.ts`

In `extractInCorrelation`, reconcile the two operands before building the `BinaryOpNode`,
using **`coerceObjectPhysicalSet`** (from `planner/building/coercion.ts`), not
`insertCrossTypeCoercion`:

```ts
const [coercedOuter, [coercedInner]] = coerceObjectPhysicalSet(outerColRef.scope, outerColRef, [innerColRef]);
const equiCondition = new BinaryOpNode(
	outerColRef.scope,
	{ type: 'binary', operator: '=', left: coercedOuter.expression, right: coercedInner.expression },
	coercedOuter,
	coercedInner
);
```

`coerceObjectPhysicalSet` is the IN-shaped, object-arm-only helper (it is what the `in`
value-list and simple-`case` builders call) and is documented as deliberately scoped that
way. `insertCrossTypeCoercion` would also apply its numeric-vs-textual arm, which would
make a correlated `int_col in (select text_col …)` start matching while the uncorrelated
form of the same query keeps missing — a new disagreement, in the direction this ticket
is trying to remove. (The prototype used `insertCrossTypeCoercion`; for a JSON/TEXT pair
the two helpers are identical, since `insertCrossTypeCoercion` checks the object arm
first and returns, so the validation above carries over unchanged.)

Two things that keep working, worth knowing before touching this:

- `extractEquiPairs` requires both sides of an `=` to be a bare `ColumnReferenceNode`, so
  the now-`CastNode`-wrapped side demotes the conjunct to the join residual. That is the
  correct destination — the residual is where `=`'s own semantics apply — and the join
  still keys on the genuine `id = id` correlation pair.
- `decorrelateExistsInProjection` collects the inner-side key columns by walking
  `correlationCondition` with `visitColumnRefs`, which descends scalar children. A
  `CastNode` exposes its operand as a scalar child, so the inner `ColumnReferenceNode` is
  still found and the existence-flag join still builds. Confirmed on the prototype — the
  plan renders `v = cast(s as json) AND t2.id = r_j.id`.

New import direction: nothing under `planner/rules/` currently imports from
`planner/building/`. `building/coercion.ts` depends only on `parser/ast`,
`planner/scopes`, `planner/nodes` and `types/`, so there is no cycle. If that direction is
still unwanted, move `coercion.ts` to `planner/analysis/` or `planner/util/` and update
its four existing importers rather than duplicating the logic.

## Coverage to add

Extend `test/logic/06.9.2-json-structural-equality.sqllogic` with a `§ 5.1 IN subquery`
section after the existing `§ 5. IN value list`. It already has `jse_t` (JSON column
`v`, rows `{"a":1,"b":2}` / `[1,2,3]` / `"hello"` / `42`) and `jse_txt` (TEXT column `s`,
rows `{ "b" : 2 , "a" : 1 }` / `not json`), so most cases need no new tables. The whole
set below passed against the prototype:

```sql
-- Uncorrelated (set-probe path): agrees with `=`, spelling irrelevant.
select id from jse_t where v in (select s from jse_txt);
→ [{"id":1}]

-- Reverse direction: a TEXT probe against a JSON subquery.
select t.id from jse_txt t where t.s in (select v from jse_t);
→ [{"id":1}]

-- Correlated (decorrelated to a semi join, coercion in the residual).
select j.id from jse_t j where j.v in (select t.s from jse_txt t where t.id = j.id);
→ [{"id":1}]

-- SELECT-list position (existence-flag LEFT JOIN arm).
select j.id, (j.v in (select t.s from jse_txt t where t.id = j.id)) as m from jse_t j order by j.id;

-- Array element order stays significant.
select id from jse_t where v in (select '[3,2,1]');
→ []

-- A non-JSON inner value is inert, not an error.
select count(*) as c from jse_t where v in (select s from jse_txt where id = 2);
→ [{"c":0}]

-- Both sides JSON keeps working (regression guard on the untouched arm).

-- Two spellings of one document are ONE member.
select count(*) as c from jse_t
where v in (select '{"a":1,"b":2}' as x union all select '{ "b":2, "a":1 }');
→ [{"c":1}]

-- A blob inner value is UNKNOWN, not false: neither IN nor NOT IN yields a row.
-- (needs a small blob table)
select count(*) as c from jse_t where v in (select b from jse_blob);
→ [{"c":0}]
select count(*) as c from jse_t where v not in (select b from jse_blob);
→ [{"c":0}]

-- Inner NULL keeps three-valued logic. (needs a nullable text table — note an
-- undeclared column in this engine is NOT NULL, so declare `s text null`)
select id from jse_t where v in (select s from jse_null);
→ [{"id":1}]
select id from jse_t where v not in (select s from jse_null);
→ []
```

Also add the numeric-direction guard, pinning that this fix did **not** widen the
numeric-vs-textual behavior — a correlated and an uncorrelated `int_col in (select
text_col …)` must both still miss, exactly as `int_col in ('1')` does today.

The file carries no `using memory`, so store mode exercises the persisted path too.

## Docs

`docs/types.md` line ~229 currently states this gap as current behavior and links the
ticket:

> One surface is **not** covered: `json_col in (select text_col from …)` compares per
> subquery row rather than against a fixed operand list, so it is still unconditionally
> false — see `tickets/backlog/bug-json-in-subquery-not-structural`.

Replace it with the closed behavior: the subquery form converts per row inside membership
evaluation rather than as a plan-time wrapper, the conversion is asymmetric (only the
non-JSON side, so JSON string scalars are not re-parsed), and a correlated form
decorrelated into a semi-join carries the same conversion in its synthesized `=`. Drop
the ticket link.

## TODO

- Add `lenientCast(value, type)` to `types/cast-semantics.ts` and make `emitCast`
  (`runtime/emit/cast.ts`) call it, keeping the existing `NOTE:` about parse-less types.
- Split `inMembershipKey` in `runtime/emit/subquery.ts` into a probe/member pair, with the
  object-physical arm resolved first (gate on `PhysicalType.OBJECT`, exclude `NULL_TYPE`,
  do not touch the numeric/textual pairing).
- Thread `probeKey`/`memberKey` through all five `emitIn` arms; move the `=== null` checks
  after the transform so a coerce-to-NULL member sets `hasNull` and a coerce-to-NULL
  condition returns NULL before the set is built.
- Rename the set-probe memo `Symbol` local away from `probeKey` to avoid the collision.
- Update `inMembershipKey`'s doc comment (JSON no longer "takes no transform").
- Reconcile the synthesized `=` in `extractInCorrelation`
  (`rule-subquery-decorrelation.ts`) with `coerceObjectPhysicalSet`, and comment why it is
  that helper and not `insertCrossTypeCoercion`.
- Add the `§ 5.1 IN subquery` block (plus the small blob / nullable-text tables and the
  numeric-direction guard) to `test/logic/06.9.2-json-structural-equality.sqllogic`.
- Rewrite the "One surface is **not** covered" sentence in `docs/types.md` (~line 229).
- Validate: `yarn test`, then `yarn lint` and `yarn build`. Run the single file while
  iterating with `cd packages/quereus && node test-runner.mjs --grep "06.9.2"`.
