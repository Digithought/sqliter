description: When a query combines two SELECTs with UNION, the engine assumes both halves produce the same kind of value as the first half. When they don't, rows from the second half can be stored or compared in the wrong form — a date keeps its raw unnormalized text, two rows that mean the same thing fail to merge, or an insert fails with a confusing conversion error.
files:
  - packages/quereus/src/planner/nodes/set-operation-node.ts        # resolvedDataType — the left-arm-wins rule (the defect)
  - packages/quereus/src/planner/building/select-compound.ts        # where SetOperationNode is constructed (branch alignment site)
  - packages/quereus/src/planner/building/expression.ts             # insertCrossTypeCoercion / wrapInCast — the JSON-vs-other precedent to reuse
  - packages/quereus/src/types/builtin-types.ts                     # ANY_TYPE — the neutral marker for irreconcilable pairs
  - packages/quereus/src/types/validation.ts                        # buildRowCoercion — the static-type skip rule that trusts the advertised type
  - packages/quereus/src/runtime/emit/insert.ts                     # emitInsert reads the source attribute types
  - packages/quereus/src/runtime/emit/set-operation.ts              # dedup comparator, reads attr.type.logicalType from the node
  - packages/quereus/src/planner/nodes/async-gather-node.ts         # getAttributes/getType — already merges nullability across children (precedent)
  - packages/quereus/test/logic/06.9.1-json-coerce-once.sqllogic    # regression home for the JSON cases
  - packages/quereus/test/logic/28-set-ops-sort-edge-cases.sqllogic # existing set-op logic tests
  - packages/quereus/docs/types.md                                  # § "Where coercion happens" — document the merge rule here
difficulty: hard
---

# Set operations must report a type they actually produce

## The defect

`SetOperationNode.resolvedDataType` (`set-operation-node.ts:138`) builds each output
data column's type by taking the **left** operand's type as the base and overriding
only the collation. Its own comment admits it: *"cross-branch type merge stays out of
scope"*. So a `union` / `union all` whose two branches carry different logical types in
the same output column advertises the left branch's type for **both** branches' rows.

Everything downstream trusts that advertised type:

- the write path (`buildRowCoercion` in `types/validation.ts`) converts a cell only
  when the producing expression's static type differs from the target column's, so a
  branch whose real type differs from the advertised one is either skipped when it
  needed converting, or converted when it must not be;
- the set operation's own dedup comparator (`runtime/emit/set-operation.ts`) builds
  itself from `attr.type.logicalType`, so it compares values of one type using another
  type's comparison rules;
- predicate coercion (`insertCrossTypeCoercion` in `planner/building/expression.ts`)
  decides whether to wrap a comparison operand from the same advertised type.

The node also takes the left arm's `nullable` verbatim, which over-claims NOT NULL when
the right branch is nullable. `AsyncGatherNode` — the physical `union all` this plans
into — already ORs nullability across its children (`async-gather-node.ts`, `getType`),
so the logical node is the odd one out.

## Reproduced (verified at `254bed14`, memory backend)

All of the following were run against a live `Database`; every line is observed output,
not a prediction.

### 1. Write: silent corruption, no error (DATE)

```sql
create table dts  (id integer primary key, d date);
create table dts2 (id integer primary key, d date);
insert into dts values (1, '2024-06-05');

-- A single-arm insert normalizes the literal, as it must:
insert into dts2 select 2, '2024-01-02T00:00:00Z';
select id, d from dts2;          -- 2 -> '2024-01-02'     ✅

-- The same literal in the RIGHT arm of a union whose LEFT arm is a DATE column:
delete from dts2;
insert into dts2 select id, d from dts union all select 2, '2024-01-02T00:00:00Z';
select id, d from dts2 order by id;
-- 1 -> '2024-06-05'
-- 2 -> '2024-01-02T00:00:00Z'   ❌ raw, unnormalized text sitting in a DATE column
```

The union advertises DATE (left arm wins), so `buildRowCoercion` sees "source type IS
the column type" and skips every cell — including the TEXT literal that needed
normalizing. No error is raised. Swap the arms and it stores `'2024-01-02'` correctly,
because then the advertised type is TEXT and every cell converts.

This is the clearest statement of the contract being broken: **a branch must store what
it would have stored on its own.**

### 2. Write: bogus failure (JSON)

```sql
create table src (id integer primary key, j json);
create table dst (id integer primary key, j json);
insert into src values (1, '"abc"');

insert into dst select id, j from src union all select 3, '"9"';
select id, json_quote(j) from dst order by id;
-- 1 -> "abc"        ✅
-- 3 -> "\"9\""      ❌ the raw three-character text '"9"' stored as a JSON string,
--                      instead of the JSON string 9

delete from dst;
insert into dst select 3, '"9"' union all select id, j from src;
-- ERROR: Type conversion failed for column 'j':
--        Cannot convert 'abc' to JSON: invalid JSON syntax
```

Same root, both directions. In the first the JSON type is advertised so the TEXT literal
is trusted and stored unconverted; in the second TEXT is advertised so *every* cell
converts, and re-parsing the stored JSON string `abc` as JSON **source** throws. The CTE
form (`with u as (… union all …) insert into dst select … from u`) fails identically.

### 3. Read: the same defect, no DML involved

```sql
-- Both branches denote the JSON string abc, so UNION must collapse them to ONE row.
select j from src union select '"abc"';
-- returns TWO rows: the native JSON string, and the raw text '"abc"'   ❌
-- (and likewise with the branches swapped)

-- A predicate over the union output matches only the native row.
select json_quote(x) from (select j as x from src union all select '"abc"')
  where x = json('"abc"');
-- returns ONE row                                                       ❌
```

So this is not a DML bug that happens to surface through unions — the set operation
itself is unsound, and the DML symptoms are downstream of that. Fixing the node fixes
reads and writes together.

### 4. What already works, and must keep working

```sql
select 1 union all select 'a';      -- two rows, values unchanged
select 1 union all select 2.5;      -- two rows, values unchanged
insert into ints select 1, 5   union all select 2, '7';   -- both stored as 7 / 5
insert into ints select 1, '7' union all select 2, 5;     -- ditto
insert into dst  select id, j from src union all select 9, j from src;  -- JSON|JSON fine
```

INTEGER and TEXT survive today only by luck: their conversion is both **total** and
**idempotent**, so it does not matter whether a cell is converted once, twice, or not at
all. JSON is neither (`JSON_TYPE.parse` reads a JS string as JSON *source*, so a second
pass changes or rejects an already-parsed value). Temporal types are idempotent but
**normalizing**, which is why case 1 corrupts on the skip side but not on the convert
side.

## The fix

Two halves that must land together. Neither is safe alone: the merge rule alone turns
case 2's silent corruption into a hard error (the JSON branch would start being
re-converted), and branch alignment alone leaves the advertised type dishonest.

### Half A — a symmetric type-merge rule

Replace the left-arm-wins base in `resolvedDataType` with a merge over both operands'
column types, evaluated per data column. Order-independent, so swapping the arms cannot
change the result:

1. **Identical logical types** → that type. (The overwhelmingly common case; costs
   nothing and changes nothing.)
2. **Either side is `NULL_TYPE`** → the other side's type. A `select null` branch must
   not poison a well-typed union; NULL is a valid member of every type.
3. **Both `isNumeric`** → `REAL_TYPE` if either is REAL, else `INTEGER_TYPE`. Matches the
   promotion `BinaryOpNode.generateType` already applies to arithmetic and
   `findCommonType` applies to polymorphic functions (`func/builtins/scalar.ts`). This
   rule is why the CASE precedent (`CaseExprNode.generateType`, "arms differ ⇒ TEXT")
   must **not** be copied verbatim — it would turn `union` of INTEGER and REAL into TEXT.
4. **Exactly one side is object-physical** (`physicalType === PhysicalType.OBJECT`,
   i.e. JSON today) → the object side's type, and the other branch is converted to it
   (Half B). This is the identical rule and the identical direction
   `insertCrossTypeCoercion` already applies to comparisons, for the same reason spelled
   out in its comment: casting the JSON side to text would make equality depend on
   spelling and put it out of step with the index, which compares structurally.
5. **Otherwise** → `ANY_TYPE`. No branch is converted. This is the honest answer for a
   pair with no principled common type (DATE ∪ TEXT, BLOB ∪ TEXT, …): the node claims
   nothing, so no consumer trusts it.

`ANY_TYPE` is the right neutral marker and needs no new type: its `parse` is `(v) => v`
(pass-through, so nothing is mangled) and its `compare` is `compareSqlValuesFast` under
BINARY — exactly the cross-storage-class ordering a genuinely mixed column wants. At the
DML it is not identical to any declared column type, so `buildRowCoercion` converts every
cell — which is correct precisely because rule 5 only fires for pairs where no branch is
already guaranteed to be in the target form. Case 1 falls here and is fixed: both cells
convert, the raw `'2024-01-02T00:00:00Z'` normalizes, and the already-stored
`'2024-06-05'` survives re-conversion unchanged (temporal conversion is idempotent).

Merge `nullable` in the same pass: `left.nullable || right.nullable`. Keep the existing
collation resolution exactly as it is — it is already symmetric and correct, and its
conflict policy (throw for DISTINCT operators, swallow for `union all`) must not change.

### Half B — align the branches to the merged type

Where a branch's column type differs from the merged type **and the merge picked a
concrete type that requires conversion** (rule 4 only, as written above), wrap that
branch so it actually produces the merged type. Use the existing lenient `CastNode` —
the same node `wrapInCast` synthesises in `planner/building/expression.ts` — so a value
that does not parse falls back through `castFallback` rather than throwing, keeping
`select j from src union all select 'not json'` total instead of turning a read into an
error.

Once both branches produce the merged type, the top-level DML pass in `emitInsert` sees
"source type IS the column type" and correctly skips — and both of case 2's orderings
store what the branch would have stored alone. The dedup comparator and predicate
coercion become correct for free, because they read the same now-honest type.

**Where to put the wrapping.** A static factory on `SetOperationNode` (e.g.
`SetOperationNode.create(...)`) that aligns the operands and then constructs the node is
preferable to doing it at the call site, because `withChildren` must re-align after an
optimizer rebuild. The operation is naturally idempotent — after alignment the branch
types are equal, so rule 1 fires and nothing further is wrapped.

**Watch these while implementing:**

- **DIFF** expands to three `SetOperationNode`s in `select-compound.ts`
  (`(A except B) union (B except A)`). Align once, on the original operands, before the
  expansion — otherwise the two inner `except` nodes align independently and the outer
  `union` sees a third combination.
- **Attribute identity.** `SetOperationNode` publishes the **left** child's attribute ids
  as its own, and `createSetOperationScope` resolves ORDER BY and the enclosing view
  against them. `ProjectNode` mints a *fresh* id for a computed expression while
  preserving the id of a bare `ColumnReferenceNode` (`project-node.ts`), so wrapping the
  left branch's column in a cast changes that column's id. Rule 4 usually wraps only the
  right branch (the object side wins, and it is normally the stored column), but not
  always — `select '"9"' … union all select j from src` wraps the left. Verify ORDER BY
  over a set operation, a view over one, and a nested set operation all still resolve.
- **Flag columns.** Alignment applies to the first `dataColumnCount()` columns only.
  Membership flags (`<setop> exists <branch> as <name>`) are appended after the data
  columns at every depth and carry pre-minted stable ids; a branch that surfaces flags
  must have them projected through verbatim, ids intact, or `93.6-set-op-flagless-write`
  and the membership tests will fail.
- **`AsyncGatherNode`** takes its column types from `children[0]` while ORing nullability
  across all children. Its children are the aligned branches, so it inherits the fix —
  but confirm, and consider whether its type derivation should call the same merge helper.

Put the merge helper somewhere both the node and any future caller can reach it —
alongside `resolveSetOpColumnCollation` in `planner/analysis/comparison-collation.ts` is
the natural home, since that file already owns the *other* half of set-op column type
resolution.

## Scope note

Deliberately **not** in scope: making `validateAndParse` idempotent, or tagging values
with "already converted" provenance. The static-type contract is the engine's chosen
design (`docs/types.md` § "Where coercion happens"); this ticket makes one node honor it
rather than replacing it.

Related, same root shape, separate ticket: `failed-cast-stores-unconverted-value`.

## TODO

### Phase 1 — merge rule

- Add a symmetric per-column logical-type merge helper (rules 1–5 above) next to
  `resolveSetOpColumnCollation` in `planner/analysis/comparison-collation.ts`, or a
  sibling module if that file's collation focus makes it a poor fit.
- Unit-test the helper directly for order independence across every rule, including
  `NULL ∪ T`, `INTEGER ∪ REAL`, `JSON ∪ TEXT`, `DATE ∪ TEXT`, and `T ∪ T`.
- Rewrite `SetOperationNode.resolvedDataType` to use it for `logicalType`, keep the
  existing collation resolution untouched, and merge `nullable` as
  `left.nullable || right.nullable`.
- Update the `resolvedDataType` doc comment — it currently states the opposite of the new
  behavior ("cross-branch type merge stays out of scope").

### Phase 2 — branch alignment

- Add a `SetOperationNode` static factory that aligns operands to the merged type before
  construction, wrapping only the branches rule 4 requires, and route `withChildren`
  through it so an optimizer rebuild re-aligns.
- Project flag columns through verbatim (ids intact) when a wrapped branch surfaces them.
- Route `select-compound.ts` through the factory, aligning **before** the DIFF expansion.

### Phase 3 — coverage

- Extend `test/logic/06.9.1-json-coerce-once.sqllogic` with both orderings of the JSON
  insert (case 2), the CTE form, and the two read-side cases (case 3: `union` dedup
  collapsing to one row, and the `where x = json('"abc"')` predicate matching both rows).
- Add the DATE case (case 1) — both orderings plus the single-arm baseline they must
  agree with. It is the only symptom that reproduces with no error and no JSON, so it
  belongs in a set-op logic file (`28-set-ops-sort-edge-cases.sqllogic` or a new
  `28.x-set-op-branch-types.sqllogic`) rather than the JSON file.
- Pin the must-keep-working cases from § 4 above so the merge rule cannot regress them —
  especially `select 1 union all select 2.5` staying numeric rather than collapsing to
  TEXT.
- Add a nullability case: `union` of a NOT NULL column with a nullable one must not
  advertise NOT NULL.

### Phase 4 — validate and document

- `yarn build`, `yarn lint`, `yarn test`. Pay attention to `28-set-ops-sort-edge-cases`,
  `28.1-compound-limit-offset`, `09.1-set-op-cross-collation`, `93.6-set-op-flagless-write`,
  `13.3-cte-edge-cases`, `10.6-distinct-edge-cases`, `20-empty-single-row`, and the
  `test/planner/validation.spec.ts` set-op cases.
- `yarn test:store` for the storage-backend leg (the JSON and DATE logic files carry no
  `using memory`, so they run on both).
- Document the merge rule in `docs/types.md` § "Where coercion happens" — specifically
  that a set operation is a conversion site, and that `ANY_TYPE` on an output column
  means "no common type, every consumer converts".
