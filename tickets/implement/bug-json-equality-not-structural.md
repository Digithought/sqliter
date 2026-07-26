---
description: Searching a column that holds JSON documents with `=` never finds anything, even when the text matches exactly — and if that column is indexed, the same search crashes the query planner instead.
files:
  - packages/quereus/src/planner/building/expression.ts               # insertCrossTypeCoercion (~60) + binary/between/in build arms — the fix seam
  - packages/quereus/src/planner/rules/access/rule-select-access-path.ts # literalFromValue (~1176) / equalitySeekKey (~1202) — the crash
  - packages/quereus/src/planner/rules/predicate/rule-predicate-inference-equivalence.ts # ~203, same untyped-literal shape
  - packages/quereus/src/planner/nodes/scalar.ts                      # LiteralNode.getType (~381-437) — throws on a native object value
  - packages/quereus/src/runtime/emit/binary.ts                       # emitComparisonOp (~247) — the sharedSemanticType gate that already works
  - packages/quereus/src/runtime/emit/cast.ts                         # lenient CAST: parse throws -> castFallback returns the value unchanged
  - packages/quereus/src/types/json-type.ts                           # JSON_TYPE: PhysicalType.OBJECT, structural compare, no groupKey
  - packages/quereus/test/logic/41.7.4-alter-column-retype-semantic-memory.sqllogic # sections 9b/9c pin the current (wrong) behavior
  - packages/quereus/test/logic/06.9-json-canonical-key.sqllogic      # existing JSON identity coverage; new cases belong alongside
difficulty: medium
---

# `=` against a JSON column never matches, and crashes when the column is indexed

## What was reproduced (memory module, `main`, autocommit)

```sql
create table j (id integer primary key, v json);
insert into j values (1, '{"a":1}');

select id from j where v = '{ "a" : 1 }';   -- []   (differently spaced — the reported bug)
select id from j where v = '{"a":1}';       -- []   (byte-identical — WORSE than reported)
select id from j where v in ('{"a":1}');    -- []
select id from j where v between '{"a":0}' and '{"a":2}';  -- []
select id from j where v = ?;  -- bound '{"a":1}'  -->  []
```

Every comparison of a JSON column against text is unconditionally false. Only an operand
that is *already* JSON-typed at plan time works:

```sql
select id from j where v = json('{ "a" : 1 }');          -- [{"id":1}]  ✓
select id from j where v = cast('{ "a" : 1 }' as json);  -- [{"id":1}]  ✓
```

…until the column is indexed, at which point the working forms become a hard planner error:

```sql
create unique index j_v on j (v);
select id from j where v = json('{"a":1}');
-- QuereusError: Unknown literal type object   (StatusCode.INTERNAL)
```

So there are two defects, and the second blocks the fix for the first.

The ticket's original diagnosis — "`=` compares the stored canonical text against the literal
without canonicalizing it" and "the gate is the missing `groupKey`" — is **wrong on both counts**;
see *Why it happens* below. `GROUP BY`, `DISTINCT`, hash joins and column-to-column `=` are all
already structural today and need no change.

## Why it happens

### Defect A — no plan-time coercion of a text operand to JSON

`emitComparisonOp` (`runtime/emit/binary.ts:247`) routes an operator through the logical type's
own `compare` only when **both** operands carry the *same* logical type object and that type has
`semanticOrdering`. A JSON column versus a text literal is not that shape, so it falls to the
generic path, which ends in `compareSqlValuesFast(v1, v2, collation)`.

At that point `v1` is a **native JS object** (JSON's `physicalType` is `PhysicalType.OBJECT` —
the only type in the engine that uses it) and `v2` is a **string**. `compareSqlValuesFast`
short-circuits on the storage-class mismatch, so the result is never 0 — regardless of spacing.
Nothing ever canonicalizes, and nothing ever compares text to text.

The generic path does carry one escape hatch, `tryTemporalComparison`, which is exactly why
`timespan_col = 'PT60M'` finds a row stored as `'PT1H'`. There is no JSON equivalent — and
`groupKey` is not involved in either case.

The place the engine *does* reconcile mismatched operand types is plan-time, in
`insertCrossTypeCoercion` (`planner/building/expression.ts:60`), which today handles exactly one
pairing: numeric ↔ textual, wrapping the textual side in a synthetic `CastNode`. It is called
from the `binary` arm (line 156) and both `between` bounds (lines 303-304). JSON is not handled,
and the `in`-value-list arm (line 277) does not call it at all.

### Defect B — an object-valued seek key becomes an untyped `LiteralNode`

With an index on the JSON column, the predicate is extracted as a seek constraint. By then
constant folding (`analysis/const-pass.ts`) has already collapsed `json('{"a":1}')` into a
`LiteralNode` holding the native object `{a:1}` — correctly, because const-pass passes the
folded node's original `ScalarType` as `explicitType`.

But `equalitySeekKey` → `literalFromValue` (`rules/access/rule-select-access-path.ts:1176`)
rebuilds a **fresh `LiteralNode` with no `explicitType`** from the constraint's plain value.
`LiteralNode.getType()` (`nodes/scalar.ts:381`) then has to infer a type from the raw value, and
its ladder covers null / number / bigint / string / boolean / `Uint8Array` before falling off the
end into `quereusError('Unknown literal type object', StatusCode.INTERNAL)`. The throw surfaces
later, from `ReferenceGraphBuilder.getEstimatedRows`, during the materialization-advisory pass.

`rule-predicate-inference-equivalence.ts:203` builds an untyped `LiteralNode` the same way and is
reachable with the same object values.

This matters for Defect A because fixing A means synthesizing `cast(<text> as json)`, which
const-folds to precisely the object-valued literal that trips B.

## Expected behavior

A JSON column's `=`, `<`, `between`, `in`, its index and its UNIQUE constraint all agree on what
"the same document" means: canonical structure, with whitespace and object key order irrelevant
and array element order significant (that is already what `deepCompareJson` and the store's
`jsonStructuralKey` do).

```sql
select id from j where v = '{ "a" : 1 }';   -- [{"id":1}]
select id from j where v in ('{ "a" : 1 }');-- [{"id":1}]
select id from j where v = ?;  -- bound '{ "a" : 1 }'  -->  [{"id":1}]
```

…identically for a natively-declared `json` column and for a `text` column retyped to `json`,
indexed or not, in both the memory module and the store module.

Text that is not valid JSON must stay **false, not an error**: `where v = 'not json'` returns no
rows. This falls out for free — `emitCast` catches a `parse` throw and `castFallback` returns the
operand unchanged for a non-numeric/text/blob target, so the cast degrades to the raw string and
the object-vs-string comparison is simply unequal.

## Chosen approach and why

Take the ticket's **second** option — canonicalize the comparison operand at plan time. Do **not**
give `JSON_TYPE` a `groupKey`:

- `groupKey` was never the gate on `=`. The gate is operand-type equality in `emitComparisonOp`,
  which a `groupKey` does not change; adding one would fix nothing here.
- The identity sites `groupKey` *does* drive — `GROUP BY`, `DISTINCT`, `IN` membership, hash joins
  — are already structural for JSON (verified: `{"a":1,"b":2}` and `{"b":2,"a":1}` collapse to one
  group and one `distinct` row, and join on equality across that pair matches). The reasoning in
  `quereus-store/src/common/store-table.ts:155-189` still holds, and the store keeps its own
  `jsonStructuralKey` seam for byte order.

Gate the new coercion on the **physical representation**, not on `semanticOrdering`: one operand's
logical type has `physicalType === PhysicalType.OBJECT` and the other's does not. That is precise
today (JSON is the only `OBJECT` type) and deliberately leaves `DATE`/`TIME`/`DATETIME` and
`TIMESPAN` alone — they are physically text, their existing paths already work, and rerouting them
through a cast would be an unrelated behavior change.

Direction is always **text side → JSON**, never JSON → text: casting the JSON side to text would
re-introduce spelling-sensitive equality and put `=` back out of step with the index.

Parameters come along for free: an unhinted parameter's plan-time type is `TEXT_TYPE`
(`planner/scopes/param.ts:10`), so it is the non-OBJECT side and gets wrapped. `JSON_TYPE.parse`
passes a native object straight through, so binding an already-parsed object still works.

## Risks / things to check while implementing

- **Seek-key correctness.** The synthetic `CastNode` must reach the index seek as the *converted*
  value. `constraint-extractor.ts` deliberately does not strip converting casts (see the long
  comment at ~line 915 and ticket `bug-cast-stripped-from-seek-constraints`) — confirm a
  cast-wrapped literal arrives as `valueExpr` or as an object-valued literal, and that the seek
  returns the row rather than silently matching nothing. Same check for the store module, whose
  key bytes come from `jsonStructuralKey`.
- **`sat-checker.ts` and `coarsened-key.ts`** both consult `hasSemanticOrdering` and unwrap casts
  under their own rules; make sure an object-valued literal does not make either claim something
  false (a bogus `≤1 row` witness, or an unsatisfiable-predicate verdict).
- **`constantBindings` / `attributeDefaults`.** The `Filter` node currently records the raw *text*
  literal as the constant binding for a JSON attribute (visible in `query_plan` output). After the
  fix it should carry the JSON value. Confirm `select v from j where v = '{"a":1}'` returns the
  native document and not the literal's text.
- **`text_col = json_col`** (two columns, mixed types) now becomes structurally true where it was
  always false. That is the intended reading of "one side is JSON", but it is a behavior change —
  cover it with a test so the choice is explicit.
- **JSON string scalars.** A JSON column can hold the scalar string `"hello"`; the SQL text
  literal `'hello'` is not valid JSON, so it casts to the raw string `hello` and compares unequal,
  while `'"hello"'` parses to the JSON string `hello` and matches. Pin whichever way you decide;
  note the asymmetry in a comment at the coercion site.

## Out of scope (do not fix here)

`where int_col in ('1')` is likely broken the same way — the `in`-list arm has never applied the
numeric ↔ textual coercion either. If adding the `in` arm turns that up, keep this ticket to JSON
and file the numeric case separately rather than widening the blast radius.

## TODO

### Phase 1 — object-valued literals stop crashing the planner

- Add a failing test first: `create table j (id integer primary key, v json)` + `create unique
  index j_v on j (v)` + `select id from j where v = json('{"a":1}')` currently raises
  `Unknown literal type object`; it must return the row.
- Thread the constrained column's `ScalarType` into `literalFromValue`
  (`rule-select-access-path.ts:1176`) so the rebuilt seek-key literal carries an `explicitType`,
  mirroring what `rule-sargable-range-rewrite.ts:120` already does. `equalitySeekKey` has the
  constraint in hand; source the type from it rather than re-deriving.
- Do the same for the literal branch of `rule-predicate-inference-equivalence.ts:203` (it already
  has `attr.type` on hand).
- Add a backstop arm to `LiteralNode.getType()` (`nodes/scalar.ts`, before the `quereusError`):
  a non-null, non-`Uint8Array` object or array types as `JSON_TYPE`. Keep the `quereusError` for
  everything still genuinely unknown (functions, symbols) — this is a widening, not a removal.

### Phase 2 — coerce a text operand against a JSON operand

- Extend `insertCrossTypeCoercion` (`planner/building/expression.ts:60`) with an
  OBJECT-physical ↔ non-OBJECT arm that wraps the non-OBJECT side in a cast to the OBJECT side's
  type name. Order it so the existing numeric ↔ textual arm is unaffected. Document the gate
  (`physicalType === PhysicalType.OBJECT`, not `semanticOrdering`) and the cast direction in the
  function's doc comment.
- Call `insertCrossTypeCoercion` from the `in`-value-list arm (line ~277), pairing the left
  expression against each value expression. Keep it JSON-only if the numeric case regresses
  anything — see *Out of scope*.
- Verify `between` needs no change beyond inheriting the new arm (it already routes both bounds
  through the helper).

### Phase 3 — tests

- New logic cases alongside `06.9-json-canonical-key.sqllogic` (no `using memory`, so store mode
  exercises the persisted key path too): text-literal `=` matching both spelling-identical and
  differently-spaced/reordered documents; `in`-list; `between`; `<`/`>`; a non-JSON text operand
  returning no rows rather than erroring; the same set with a unique index present; and a
  `text_col = json_col` cross-column case.
- Add a mocha spec for the parameter form (`where v = ?` bound to a text string, and to a native
  object) — parameters are awkward to express in `.sqllogic`.
- Update `41.7.4-alter-column-retype-semantic-memory.sqllogic` sections 9b and 9c: both
  `select id from sem9b/sem9c where v = '{ "a" : 1 }'` now return `[{"id":1}]`. Delete the
  explanatory NOTE at lines 371-375 — it documents the old (wrong) diagnosis and points at this
  ticket.
- Run `yarn test` and `yarn lint`. Run `yarn test:store` too — the store's `jsonStructuralKey`
  path is on the critical path for the indexed cases and is not covered by `yarn test`.
