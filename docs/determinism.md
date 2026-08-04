# Determinism Validation

> **Stability: Internal** — see [Stability Tiers](stability.md#tiers).

The real invariant Quereus needs in DEFAULT / CHECK / GENERATED clauses is not
"the source expression is deterministic" — it is "the captured artifact at the
`vtab.update()` frontier is fully resolved and replayable." That invariant is
satisfied by construction: defaults and stored generated columns are evaluated
per row before reaching the module, immediate row CHECKs fire at write time so
only passing rows reach `vtab.update()`, and deferred CHECKs evaluate once at
commit (their outcome decides commit-vs-rollback for the entire transaction,
so replay-via-module-layer cannot disagree with the commit outcome).

The prohibition on non-deterministic expressions in DDL is therefore a
**stricter-than-necessary proxy** for the replay contract, not a correctness
requirement. Quereus still defaults to strict rejection, with a single opt-in to
lift the gate.

> **Deterministic does not imply synchronous.** The validators below check
> `physical.deterministic` only. A scalar subquery over a table is deterministic
> within a statement, so it passes every gate — and its emitted evaluator returns
> a `Promise`. No runtime site may skip an `await` on the strength of having
> validated determinism; doing so writes the Promise object itself into the row.
> (This was a live defect in the UPDATE generated-column recompute; regression
> coverage lives in `test/logic/41-generated-column-extras.sqllogic` § 6–7.)

## The `nondeterministic_schema` option

| Option | Type | Default | Aliases |
| --- | --- | --- | --- |
| `nondeterministic_schema` | boolean | `false` | `allow_nondeterministic_schema_expressions` |

Set programmatically or via PRAGMA:

```sql
pragma nondeterministic_schema = true;
pragma nondeterministic_schema;
-- → [{"name":"nondeterministic_schema","value":true}]
```

```typescript
db.setOption('nondeterministic_schema', true);
```

When `true`, Quereus permits non-deterministic expressions in DEFAULT, CHECK,
and `GENERATED ALWAYS AS` clauses. Capture still happens at the resolved-row
frontier: the row stored in the table (and the literal SQL produced by
`buildInsertStatement` / `buildUpdateStatement` / `buildDeleteStatement` in
`util/mutation-statement.ts`) contains the concrete value the engine
evaluated for that row.

The option is not baked into any persisted schema; toggling it affects
validation of *subsequent* DDL/DML only — already-created tables keep
whatever expressions they were created with.

## Strict-mode behaviour (default)

**Rejected in Constraints and Defaults:**
- `random()`, `randomblob()` - Random value generation
- `date('now')`, `time('now')`, `datetime('now')`, `julianday('now')` - Current time functions
- User-defined functions marked as non-deterministic
- Any expression containing non-deterministic sub-expressions
- DML in expression position (`(insert/update/delete … returning …)` inside
  a CHECK / DEFAULT / assertion expression). DML is non-deterministic via
  the side-effect axis — the `DmlExecutorNode` sets `deterministic: false`,
  which propagates through the AND-of-children physical-properties chain
  and is rejected by the determinism enforcer.

**Allowed in Constraints and Defaults:**
- Constant literals: `42`, `'hello'`, `true`
- Deterministic built-in functions: `upper()`, `lower()`, `abs()`, `round()`
- Column references: `NEW.price`, `OLD.quantity`
- Mutation context variables: `context.timestamp`, `context.user_id`
- User-defined functions marked as deterministic (default)

## Using Mutation Context for Non-Deterministic Values

Pass the value in via mutation context instead of calling the function directly:

```sql
-- ❌ REJECTED: Non-deterministic default
create table orders (
    id integer primary key,
    created_at text default datetime('now')  -- ERROR
);

-- ✅ ACCEPTED: Use mutation context
create table orders (
    id integer primary key,
    created_at text default timestamp
) with context (
    timestamp text
);

-- Pass the timestamp when inserting
insert into orders (id)
with context timestamp = datetime('now')
values (1);
```

## Physical Properties System

Determinism is tracked through the `PhysicalProperties` system:

```typescript
interface PhysicalProperties {
    deterministic: boolean;  // Same inputs → same outputs
    readonly: boolean;       // No side effects
    idempotent: boolean;     // Safe to call multiple times
    constant: boolean;       // Directly produces constant result
}
```

**Propagation Rules:**
- A function node marks `deterministic: false` unless the registry sets
  `FunctionFlags.DETERMINISTIC`
- Properties propagate bottom-up through the expression tree
- Parent nodes inherit the most restrictive properties from children

**User-Defined Functions:**
```typescript
// Non-deterministic UDF
db.createScalarFunction("my_random",
    { numArgs: 0, deterministic: false },
    () => Math.random()
);

// Deterministic UDF (default)
db.createScalarFunction("my_upper",
    { numArgs: 1, deterministic: true },  // or omit (defaults to true)
    (text) => String(text).toUpperCase()
);
```

## Validation Timing

All determinism rejection sites described below are skipped when
`nondeterministic_schema = true`. The bind-parameter / column-reference
pre-walks remain active in both modes (those are scope checks, not
determinism checks).

**CREATE TABLE:**
- DEFAULT expressions are rejected if they reference bind parameters
  (`?`, `:name`) or a **bare** table column; both are detected via an AST
  pre-walk before expression building. A `new.<column>` reference is the
  exception — it explicitly reads a sibling value the INSERT supplies, so it
  passes the pre-walk and its build/determinism check is deferred to INSERT
  time (no row scope at CREATE TABLE), alongside the deferrals for
  mutation-context identifiers and self-referencing subqueries.
- DEFAULT expressions are then built and rejected if their physical
  `deterministic` property is false (e.g. `random()`).
- CHECK constraints are walked at DDL time: any function call is rejected
  unless the registry marks it `DETERMINISTIC`, and bind parameters
  (`?`, `:name`) are rejected too. Column references inside CHECK predicates
  are validated at INSERT/UPDATE time, when the row scope exists.

`ALTER TABLE … ALTER COLUMN … SET DEFAULT` routes the new default through the
**same** validator (`SchemaManager.validateAlterColumnDefault`): bind
parameters / bare columns / non-determinism are rejected at `ALTER` time, and a
`new.<column>` default is accepted with the build/determinism check deferred to
INSERT time. `ALTER TABLE ADD COLUMN` routes its default through the same shared
validator (`SchemaManager.validateAddColumnDefault`, at plan-build time), so a
non-foldable but deterministic default (including `new.<column>`) is accepted.
A literal / NULL default is bulk-written to every existing row by the module's
`addColumn` (the fast path). A non-foldable default is **backfilled per existing
row**: the planner compiles it against the table's *existing* columns as the
"supplied" row (the same `buildRowDefaultScope` the single-source INSERT and
view-write key default use) and hangs the scalar on the `AlterTableNode`; the
emitter installs a row slot over each existing row and passes a per-row evaluator
to `module.alterTable`, so `new.<column>` resolves to the existing row's sibling.
Each module applies the evaluator while appending the column, staging locally
(memory builds a new tree, the store accumulates a batch) and publishing only after
every row migrates, and enforces the column's NOT NULL on the produced value before
commit.

`ALTER TABLE ADD COLUMN … GENERATED ALWAYS AS (…)` takes that **same** per-row route:
`buildAddColumnBackfill` sources its scalar from the `generated` clause when there is
one, so a generated column added to a populated table is computed for the existing
rows. Three differences from the DEFAULT arm, all of them forced by a generated column
having no stored `defaultValue`:

- It is **never** folded to a bulk-written literal — even `generated always as (2)` is
  evaluated per row, since there is no `defaultValue` for the module to write.
- Determinism is checked with `validateDeterministicGenerated` (message: *GENERATED
  ALWAYS AS for column …*) rather than the DEFAULT validator, and the shared
  `validateAddColumnDefault` pre-check is skipped — it rejects bare column references,
  which a generated expression is written with by definition.
- Unresolvable and self-referencing names are pre-flighted by
  `validateAddColumnGeneratedRefs` (`schema/table.ts`) before the compile, so they get
  the same two messages `CREATE TABLE` gives (*Column 'x' referenced by generated column
  …*, *Cyclic dependency in generated columns …*) instead of a generic `Column not
  found`. The emitter's own `withGeneratedColumnGraph` rebuild still runs, so the
  pre-flight only moves those rejections earlier.

An evaluator's presence — not the kind of DEFAULT written — is what each module's "NOT
NULL needs a value source" gate keys on, so a mandatory generated column is accepted on
a non-empty table and filled per row.

CHECK enforcement splits by value-source kind:

- **Literal / NULL default** — new CHECK constraints are validated against the
  backfilled rows by a post-`alterTable` scan, reverting the column add on a
  violation.
- **Per-row source (non-foldable default or `GENERATED ALWAYS AS`)** — each column-level CHECK is compiled at
  plan-build time (against the existing columns plus the new column) and evaluated
  *inside the per-row backfill hook* against `[...existingRow, backfilledValue]`,
  mirroring the per-row NOT NULL path. A violating row throws mid-loop, so the
  module's staged tree/batch is discarded before publication and the catalog is
  never mutated — no separate revert needed. The post-scan is skipped here (it
  would read a stale pre-backfill snapshot). Truthiness matches write-time CHECK
  semantics (fails on `false`/`0`, passes on truthy/NULL), and the new column's
  declared collation is carried into the predicate so comparisons resolve the same
  collation as at write time.

**Where the inline constraints end up.** All three kinds declarable inline on the
added column — UNIQUE, CHECK, FOREIGN KEY — are synthesized into the equivalent
*table-level* `AST.TableConstraint` over the new column (the three
`extractColumnLevel*` helpers in `schema/constraint-builder.ts`) and handed to
`module.alterTable({ type: 'addConstraint', constraint })`, one call each, in the
order UNIQUE → CHECK → FK. That is the **same** path `ALTER TABLE ADD CONSTRAINT`
takes, so the *module* owns the constraint exactly as it owns one written in `CREATE
TABLE`. Ownership is what makes it durable: every later structural ALTER (`DROP
COLUMN`, `RENAME COLUMN`, …) asks the module for the new table schema and installs
that answer in the catalog verbatim, so a constraint merged only into the engine's
catalog copy is dropped on the floor by the next one — silently, with bad data
accepted afterwards. Consequences of routing through the module:

- Existing-row validation is the module's (`addConstraint` re-validates for UNIQUE
  and FK; CHECK is a schema-only append there, which is why the engine keeps the
  literal-default CHECK scan above). The memory and store modules both call the
  shared `validateForeignKeyOverExistingRows`, so the ADD COLUMN and ADD CONSTRAINT
  paths cannot drift. FK validation is MATCH SIMPLE (a fully-non-NULL backfilled
  value with no matching parent aborts; NULL satisfies) and pragma-gated (`pragma
  foreign_keys = false` skips the scan and defers enforcement to later writes). It is
  correct for a self-referential FK and for the parent-absent case, both of which
  make every fully-non-NULL backfilled row an orphan.
- The engine still rejects a **conflicting child/parent collation** on the FK itself,
  before the module call, mirroring `runAddConstraintViaModule` — a pure schema check,
  so a rejected ALTER never reaches the module's persistence side effects.
- An unnamed constraint is auto-named by the **same** convention the `CREATE TABLE`
  spelling uses: `_check_<column>`, `_fk_<table>_<column>`. (The CHECK name is set by
  the extractor, because the module's table-level `ADD CONSTRAINT` convention would
  otherwise name it `check_<n>`.)
- Any failure from the materialization onward goes through `revertAddColumn`: each
  CHECK / FK the module already accepted is handed back via `dropConstraint` (newest
  first), then the column is dropped, the batched events are un-remapped, and the
  original catalog entry is restored — so a violation leaves the table exactly as it
  was. An inline UNIQUE needs no explicit hand-back; both modules prune a UNIQUE over
  a dropped column.

> **Why validation runs against a column-only schema.** The optimizer trusts a
> DECLARED constraint as a proven invariant, which makes each existing-row validator
> fold away its own work if the new constraint is already live during the pass:
> - The FK validator issues a `NOT EXISTS` correlated subquery (the same form `ADD
>   CONSTRAINT` uses). The decorrelator may materialize it as an anti-join, which
>   `ruleAntiJoinFkEmpty` folds to `EmptyRelation` under the inclusion dependency
>   `child.fk ⊆ parent.pk`.
> - The literal-default CHECK scan issues `select 1 from <t> where not (<check>)`. A
>   declared CHECK `<p>` seeds a domain constraint on the scan, so `ruleFilterContradiction`
>   folds `where not (<p>)` to `EmptyRelation` (the domain `<p>` and predicate `not <p>`
>   are jointly unsatisfiable).
>
> Either fold makes validation trust the very invariant it is checking and silently admit
> a violating row. So ADD COLUMN registers the new **column with only the pre-existing
> (already-proven) constraints** — a `columnOnlySchema` omitting every new constraint —
> live for the whole validation window; each module holds its new constraint in its own
> cached schema until that constraint's validation passes, and the catalog learns of them
> only from the final schema published after the last one lands. The live schema the
> planner reads during validation therefore declares nothing new to fold against, so the
> validators read the freshly-backfilled column directly and surface real violations.
> This mirrors `ADD CONSTRAINT`, which likewise validates before swapping the constraint
> into the live schema.

**INSERT/UPDATE:**
- DEFAULT expressions validated when building row expansion
- CHECK constraints validated when building constraint checks (full
  column-scope resolution happens here)
- `GENERATED ALWAYS AS` expressions validated when building the generated
  column projection (INSERT), assignment chain (UPDATE), or ADD COLUMN backfill
  (`ALTER TABLE ADD COLUMN`, at plan-build — see above)

**ALTER TABLE ADD CONSTRAINT:**
- Validation deferred to first INSERT/UPDATE (constraints may reference NEW/OLD)

## See Also

- [Runtime Documentation](runtime.md) - Execution model and context system
- [Module Authoring Guide](module-authoring.md) - Module-side mutation contract
- [Transactions](sql-txn.md) - Commit, rollback, and the replay contract
