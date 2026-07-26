description: Inserting the result of a UNION into a table can store one branch's values in the wrong internal form — a JSON column ends up holding raw text instead of a parsed value — or, with the branches written in the other order, the insert fails with a bogus conversion error.
files:
  - packages/quereus/src/planner/nodes/set-operation-node.ts   # resolvedDataType — the left-arm-wins rule
  - packages/quereus/src/runtime/emit/insert.ts                # emitInsert reads the source attribute types
  - packages/quereus/src/types/validation.ts                   # buildRowCoercion — the static-type skip rule
  - packages/quereus/src/planner/nodes/scalar.ts               # CaseExprNode.generateType — the "arms differ ⇒ TEXT" precedent
  - packages/quereus/test/logic/06.9.1-json-coerce-once.sqllogic  # where a regression test belongs
difficulty: medium
---

# UNION branch values reach the table without being converted

## What happens

A write's values are converted to their declared column types once, in the DML
emitters, and a cell is converted only when the *static type* of the expression
that produced it differs from the column's declared type (`buildRowCoercion` in
`types/validation.ts`; see docs/types.md § "Where coercion happens"). That rule
assumes every expression reports a type it actually produces.

A set operation does not. `SetOperationNode.resolvedDataType` takes the LEFT
operand's column type as the base and overrides only the collation — its own
comment says "cross-branch type merge stays out of scope". So a `union` /
`union all` whose two branches have different logical types in the same output
column advertises the left branch's type for both.

Both orderings misbehave (verified against `c4749ca0`):

```sql
create table src (id integer primary key, j json);
insert into src values (1, '"abc"');

create table dst (id integer primary key, j json);

-- Left branch JSON, right branch a TEXT literal.
insert into dst select id, j from src union all select 3, '"9"';
select id, json_quote(j) from dst order by id;
-- id 1 -> "abc"      (correct: the JSON string abc)
-- id 3 -> "\"9\""    (WRONG: the raw three-character text ' " 9 " ' stored as a
--                     JSON string scalar, instead of the JSON string 9)

-- Same statement with the branches swapped: now the whole insert fails.
insert into dst select 3, '"9"' union all select id, j from src;
-- Error: Type conversion failed for column 'j': Cannot convert 'abc' to JSON:
--        invalid JSON syntax
```

In the first case the static type says JSON, so the TEXT literal is trusted and
stored unconverted. In the second the static type says TEXT, so *every* cell is
converted — including the branch whose values already came out of storage in
JSON form, and re-parsing the stored JSON string `abc` as JSON source throws.

The same happens through a view or a CTE over the union, and it is not specific
to JSON: any pair of types where conversion changes or rejects a value (temporal
types, numeric affinity) has the same exposure. JSON is simply where it is
visible, because JSON conversion is neither idempotent nor total.

## Expected behavior

`insert into <t> select ... union all select ...` must store the same value each
branch would store on its own, and must not fail on a branch whose values are
already in the target column's form.

## Notes for whoever picks this up

- The conversion decision is per output cell of the whole source relation, so
  "convert the row once at the top" cannot express "branch A yes, branch B no".
  Either each branch is made to produce the merged type (per-arm conversion
  inserted by the planner), or the set operation reports a merged type honest
  enough that the single top-level pass is correct for both branches.
- `CaseExprNode.generateType` already faces the identical question and answers
  it crudely — differing branch types collapse to TEXT. Copying that verbatim
  into set operations would turn `union` of INTEGER and REAL into TEXT, which is
  worse than the current behavior for the common numeric case, so it is not a
  drop-in.
- Regression coverage belongs next to the existing cases in
  `test/logic/06.9.1-json-coerce-once.sqllogic` (which runs on both the memory
  and store backends).
- Related, same root shape, separate ticket: `failed-cast-stores-unconverted-value`.
