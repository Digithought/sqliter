---
description: When a logical table is stored split across several physical tables and its shared key holds no value in a row, that row's pieces silently fail to line up — reads show the row incomplete, updates quietly change nothing, and deletes leave orphaned leftovers behind.
files:
  - packages/quereus/src/schema/lens-compiler.ts               # read side: buildKeyEquiJoin (~975, called ~807) and buildEavSubquery (~1065); eavAnchor built ~814
  - packages/quereus/src/planner/mutation/decomposition.ts     # write side: anchorKeySubquery (~2146) + memberUpdateOp (~1127), memberDeleteOp (~737), buildEavAttrOp (~1837); keyColumnInfo (~2192), singleKeyColumn (~2202)
  - packages/quereus/src/planner/mutation/capture-correlation.ts  # captureKeyEquality (~45) — the shared NULL-safe per-column helper all four sites must route through
  - packages/quereus/src/planner/mutation/single-source.ts     # SELF_ALIAS (~133) — the synthesized collision-proof target correlation name to reuse
  - packages/quereus/src/planner/building/update.ts            # ~152: stmt.alias → AliasedScope, the mechanism the EXISTS correlation depends on
  - packages/quereus/src/planner/building/delete.ts            # ~152: same
  - packages/quereus/test/lens-put-fanout.spec.ts              # § "captured read-back over a NULLABLE anchor key" (~2970-3026) — pointer note to retire, home for the new round-trip tests
  - docs/lens.md                                               # § The Default Mapper (~145 get-body synthesis), § The `put` fan-out (~151-157), § Current Limitations (~614)
repro: verified
difficulty: hard
---

# NULL stitch-key rows don't round-trip through a decomposition lens

## Background — the plain-language version

A **decomposition lens** lets one logical table be stored across several physical tables:
an *anchor* table holds the row's identity, and *member* tables hold extra columns (or, in
the EAV shape, one attribute-value triple per column). Every piece of a logical row carries
the same **stitch key** value — that is what lets the engine reassemble the row on read and
route writes to the right pieces.

A primary-key column in Quereus may be declared nullable, and NULL in key position is an
ordinary value that is equal to itself (`docs/schema.md` § Primary-key nullability — a key
column keeps whatever nullability it declared; `pragma default_column_nullability` can make
that the default). But the lens machinery lines the pieces up with plain SQL `=`, which
yields UNKNOWN — never true — when either operand is NULL. So a logical row whose stitch key
is NULL cannot find its own pieces.

The multi-source join-view analogue of this class was fixed by
`bug-multi-source-view-write-misreads-null-keys`, which introduced the shared NULL-safe
per-column helper `captureKeyEquality` (`planner/mutation/capture-correlation.ts`). That fix
covered `decomposition.ts`'s captured-value read-back, but the lens substrate itself — the
read-side join, the read-side EAV subquery, and the three write-side anchor correlations —
still uses plain `=`.

## Verified behaviour

Both fixtures below were run against HEAD (`c6d8e5301`) as a scratch Mocha spec; every
assertion listed as "actual" was observed. The scratch file has been removed.

### Columnar split fixture

```sql
create table Nc_core (id integer null primary key, a integer) using appmod;
create table Nc_c    (id integer null primary key, c integer null) using appmod;
-- advertised: anchor Nc_core (id, a) + optional member Nc_c (c), logical-tuple key on `id`
declare logical schema appn { table N { id integer null primary key, a integer, c integer null } };
insert into main.Nc_core values (null, 10), (1, 20);
insert into main.Nc_c    values (null, 77);   -- a PRESENT component on the NULL-keyed row
```

| Statement | Expected | Actual (HEAD) |
| --- | --- | --- |
| `insert into appn.N (id, a, c) values (null, 10, 77)` | both components written | **correct** — writes `Nc_core (null,10)` and `Nc_c (null,77)` |
| `select id, a, c from appn.N` | `{null, 10, 77}` | `{null, 10, null}` — the present component never joins |
| `update appn.N set c = coalesce(c, 0) + a` | `Nc_c` → `(null, 87)` | reports success; `Nc_c` unchanged at `(null, 77)` |
| `delete from appn.N where id is null` | `Nc_c` row gone | anchor row deleted, `Nc_c (null, 77)` survives as an **orphan** |

The INSERT row is the sharp end of it: a lens will happily *store* a NULL-keyed logical row
that it can then never read back, update, or fully delete.

### EAV pivot fixture

```sql
create table Ne_core (id integer null primary key, a integer) using eavmod;
create table Ne_eav  (eid integer null, attr text, val integer null, primary key (eid, attr)) using eavmod;
-- advertised: anchor Ne_core + attributePivot member Ne_eav (entity eid, attribute attr, value val)
declare logical schema appe { table NE { id integer null primary key, a integer, p integer null } };
insert into main.Ne_core values (null, 10), (1, 20);
insert into main.Ne_eav  values (null, 'p', 1000), (1, 'p', 2000);
```

| Statement | Expected | Actual (HEAD) |
| --- | --- | --- |
| `select id, a, p from appe.NE` | `{null,10,1000}`, `{1,20,2000}` | `{null,10,**null**}`, `{1,20,2000}` |
| `update appe.NE set p = 5` | both triples → `val = 5` | `(null,'p',**1000**)` unchanged, `(1,'p',5)` correct |

The EAV read hole (`buildEavSubquery`) was **not** in the originating fix ticket's site list;
it is the same rule violated at a fourth site.

## Root cause — one rule, four sites

> Stitch-key correlation must treat NULL as a self-equal key value, per column, exactly as
> `captureKeyEquality` already encodes for the multi-source path.

**Read side — `src/schema/lens-compiler.ts`:**

1. `buildKeyEquiJoin` (~975, called at ~807) emits the get body's `anchor ⋈ member` ON
   condition as a positional conjunction of `member.kᵢ = anchor.kᵢ`. Both `anchorTable` and
   `memberTable` (`TableSchema`) are already in scope at the call site, so declared
   nullability is available without new plumbing.
2. `buildEavSubquery` (~1065) emits `pivot.<entity> = anchor.<key>` inside the correlated
   scalar subquery that projects each EAV column. Its `eavAnchor` parameter is
   `{ alias, keyColumn }` and must widen to carry nullability; it is constructed at exactly
   one place (~814, in `compileDecompositionBody`) — the override path passes `undefined`.

Fixing the read side is not optional even for the write path: the captured-value snapshot
that drives an arbitrary-value optional-member UPDATE is materialized **over the planned get
body**. So even a fully NULL-safe write correlation would capture the *null-extended* image of
a row whose component actually exists. **The read fix and the write fix must land together**
or the update arm still writes a wrong value.

**Write side — `src/planner/mutation/decomposition.ts`:**

3. `anchorKeySubquery` (~2146) produces `select <anchorKey> from <anchor> [where <pred>]`, and
   three consumers wrap it as `<memberCol> in (select …)`:
   - `memberUpdateOp` (~1127) — matched member UPDATE (also the captured-value UPDATE at ~1345)
   - `memberDeleteOp` (~737) — member DELETE in the fan-out
   - `buildEavAttrOp` (~1837) — matched EAV triple UPDATE/DELETE, keyed on the entity column

   `NULL IN (…)` is UNKNOWN, so a NULL-keyed member row is unreachable by update and survives
   a fan-out delete as an orphan. On the update path the miss is then *masked*: the fallback
   materialize INSERT collides with the existing NULL-keyed row (NULL **is** self-equal for
   PK uniqueness) and its `on conflict do nothing` swallows the write — a silent no-op with a
   success report, on both the columnar and the EAV arm.

**Not affected:** the upsert-shaped paths (`on conflict (<memberKey>) do …`,
`on conflict (<entity>, <attr>) do …`) — PK conflict detection already treats NULL as
self-equal, which the verified INSERT row above demonstrates. The captured read-back
(`capturedValueSubquery` / `keyColumnInfo`) is already NULL-safe and needs no change.

## Design

### Route every stitch correlation through the one helper

`captureKeyEquality(left, right, nullable)` already emits exactly the required per-column
shape: plain `=` when the column is declared NOT NULL, and
`left = right or (left is null and right is null)` when it is nullable. All four sites should
call it rather than hand-spelling `=`. That is the representation-level point of the fix — after
it there is no site in the lens/decomposition substrate that spells a raw `=` between two key
columns, so the class cannot silently regrow.

`lens-compiler.ts` (in `src/schema/`) already imports from `src/planner/` (`fd-utils.js`,
`plan-node.js`), so importing `capture-correlation.js` introduces no new layering direction.
**Recommendation:** leave the function where it is and widen its doc comment to name both
uses (capture correlations *and* lens stitch joins) rather than moving/renaming the module —
a rename would churn four unrelated call sites in `multi-source.ts` / `set-op.ts` for no
behavioural gain. If the name reads badly at the lens site, add a same-module alias export;
do not fork the implementation.

### Nullability gate: both sides must be nullable

The disjunction is needed only when **both** correlated columns are declared nullable. If the
anchor key is NOT NULL, no anchor row is keyed NULL, so a member row keyed NULL is a genuine
orphan and plain `=` correctly matches nothing (and vice versa). Gating on both keeps the
emitted condition byte-identical for every schema that does not declare a nullable stitch key.

This matters because a disjunctive ON condition is **not** free on the read side. Measured by
reading the consumers, not by benchmark:

- `planner/rules/join/equi-pair-extractor.ts` extracts equi-pairs only from `=` conjuncts, so
  a disjunctive ON yields none — no hash join, no bloom join, no merge join; the join falls
  back to nested-loop.
- `planner/analysis/coverage-prover.ts` (`pureJoinEquiAttrPairs`, ~737) returns `undefined`
  when a conjunct produces no cross-side pair, so the join's no-row-loss / key-coverage proofs
  are lost.

The gate confines both regressions to schemas that actually declare a nullable stitch key.
Note the residual exposure, which the capture-correlation `NOTE:` at
`capture-correlation.ts:38-43` already flags for its own site: under
`pragma default_column_nullability = nullable` **every** key column is declared nullable, so
every decomposition lens get body would take the disjunction and lose its equi-join. That is
correct but potentially slow, and unlike the write-side capture correlation it is on the read
path of every `select`. Either narrow the gate to *reachable* nullability there (a key column
with a NOT NULL check, or one the body's predicate already excludes NULL on) or accept it and
record the tradeoff with a `NOTE:` at `buildKeyEquiJoin` naming the pragma and the revisit
condition. Prefer accept-and-`NOTE:` unless a measurement says otherwise — the reachable-
nullability analysis is a much larger change and belongs in its own ticket if wanted.

There is no `IS NOT DISTINCT FROM` operator in the engine (confirmed — `set-op.ts:101`,
`lens-enforcement.ts:1080` both say so explicitly), so the disjunction is the only available
spelling. Adding that operator, and teaching equi-pair extraction to accept it, would remove
the plan regression entirely — but that is a separate `feat-`/`debt-` ticket, not this fix.

### Write side: IN → correlated EXISTS

The `IN` shape cannot express NULL-safe matching. Rewrite it as the correlated EXISTS the
multi-source path already uses (`buildCapturedKeyPredicate`, `multi-source.ts:2132` — same
pattern, one place to copy the shape from):

```sql
-- current (misses a NULL member key)
update <member> set … where <memberKey> in (select <anchorKey> from <anchor> a [where <pred>])

-- NULL-safe form
update <member> as __vm_self set …
where exists (select 1 from <anchor> a
              where [<pred> and]
                    (a.<anchorKey> = __vm_self.<memberKey>
                     or (a.<anchorKey> is null and __vm_self.<memberKey> is null)))
```

The member operand **must** be qualified. Under a logical-tuple shared key the anchor and
member key columns are spelled identically (both `id` in the fixture), so a bare `id` inside
the subquery binds the anchor's column, not the outer target row. `AST.UpdateStmt.alias` /
`AST.DeleteStmt.alias` exist for exactly this: `building/update.ts:152` and
`building/delete.ts:152` both resolve `stmt.alias?.toLowerCase() ?? tableName` into an
`AliasedScope` over the target. Reuse `SELF_ALIAS` (`single-source.ts:133`, `'__vm_self'`)
rather than minting another name. Unqualified column references into the target still resolve
under an alias, so the existing bare-column SET values (`stripMemberQualifier`,
`rewriteAssignedValue`) and the unqualified member-key operand inside `capturedValueSubquery`
are unaffected.

**Emit the alias only on the NULL-safe branch.** When the gate is off, keep the existing
`IN (select …)` verbatim so NOT NULL schemas produce a byte-identical plan and the existing
plan-shape tests stay green.

The EAV arm (`buildEavAttrOp`) takes the same treatment, correlating the pivot's *entity*
column against the anchor key; its `attr = '<literal>'` conjunct is a value comparison against
a non-null literal and stays plain `=`.

### Shape of the shared helper

Rather than three near-copies, factor the correlation next to `anchorKeySubquery`, e.g.

```ts
/**
 * The identifying correlation a member op routes on: `<memberCol> in (select <anchorKey>
 * from <anchor> [where <pred>])` when the two key columns are declared NOT NULL, or the
 * NULL-safe correlated `exists (…)` (per-column {@link captureKeyEquality}) when both are
 * nullable. Returns the alias the caller must stamp on the emitted statement, or undefined
 * when the plain IN form was used.
 */
function anchorKeyCorrelation(
  ctx: PlanningContext,
  shape: DecompShape,
  member: DecompositionMember,
  memberCol: string,          // member stitch key, or the EAV entity column
  pred: AST.Expression | undefined,
): { where: AST.Expression; targetAlias?: string }
```

`ctx` is needed to reach both members' `TableSchema` via `resolveMemberTable` for the
nullability read; `keyColumnInfo` (~2192) already does that lookup and should be reused. Note
`anchorKeySubquery` currently takes no `ctx` and calls `singleKeyColumn(undefined, …)` — the
`undefined` is only so the deferral message can omit a table name, so threading `ctx` in is
mechanical. Composite stitch keys are already deferred by `singleKeyColumn` (v1 threads a
single-column key), so "per column" degenerates to one column here; still route through
`captureKeyEquality` so the shape stays shared when composite keys land.

## Scope boundaries

- **Not** in scope: composite stitch keys (already deferred with a diagnostic), the
  `IS NOT DISTINCT FROM` operator, reachable-vs-declared nullability analysis.
- Non-anchor-scoped predicates are already deferred by `assertAnchorScoped`, so the fix only
  needs to be right for anchor-resolvable predicates and the no-predicate case.
- Surrogate shared keys pair anchor/member key columns positionally under distinct spellings;
  the gate must read each side's own column nullability, not assume the anchor's.

## Docs

`docs/lens.md` is the home for this behaviour:

- § The Default Mapper (~145) — the get-body synthesis paragraph describes the equi-join and
  the EAV correlated subquery; state that both correlate NULL-safely per nullable key column.
- § The `put` fan-out (~151-157) — the UPDATE/DELETE paragraphs spell the
  `in (<anchor subquery>)` shape verbatim; update to the EXISTS form and its gate.
- § Current Limitations (~614) — if the pragma-wide plan regression is accepted rather than
  narrowed, that is the architectural home for the note (with a `NOTE:` at `buildKeyEquiJoin`
  as the code-site pointer).

## TODO

- Widen `captureKeyEquality`'s doc comment (`capture-correlation.ts`) to cover lens stitch
  joins alongside capture correlations; keep the name and location.
- `lens-compiler.ts`: thread anchor + member `TableSchema` nullability into
  `buildKeyEquiJoin` and emit `captureKeyEquality` per key-column pair, gated on **both**
  sides declared nullable. Leave the empty-key (`primary key ()`) `1 = 1` branch untouched.
- `lens-compiler.ts`: widen `eavAnchor` (built ~814, consumed by `resolveAdvertisedColumn`
  ~1029 and `buildEavSubquery` ~1065) to carry the anchor key column's nullability, and give
  the pivot entity column the same treatment inside `buildEavSubquery`.
- Add the `NOTE:` at `buildKeyEquiJoin` recording the `default_column_nullability = nullable`
  plan-regression tradeoff and its revisit condition (or narrow the gate, if measurement
  justifies the extra work — say which you did in the review handoff).
- `decomposition.ts`: add `anchorKeyCorrelation` beside `anchorKeySubquery`, emitting the
  plain `IN` form when the gate is off and the NULL-safe correlated `EXISTS` (per-column
  `captureKeyEquality`, member operand qualified with `SELF_ALIAS`) when it is on.
- `decomposition.ts`: route `memberUpdateOp` (~1127), `memberDeleteOp` (~737) and
  `buildEavAttrOp` (~1837) through it, stamping `alias: SELF_ALIAS` on the emitted
  UPDATE/DELETE only when the EXISTS form was returned.
- `test/lens-put-fanout.spec.ts` § "captured read-back over a NULLABLE anchor key": retire the
  comment at ~2976-2979 that points at this ticket, and assert the logical read-through.
- Add round-trip coverage for a NULL-keyed logical row over **both** decomposition shapes —
  columnar split and EAV pivot — as one generalized test per shape rather than four point
  tests: `insert` through the lens → `select` reads every column back → `update` writes the
  computed value → `delete` removes every component, leaving no orphan. Both fixtures above
  are ready to lift. Keep a non-NULL-keyed control row in each.
- Add a surrogate-key variant (distinctly-spelled anchor/member key columns, nullable) so the
  positional pairing is exercised under the gate — the existing surrogate suite at ~2241 is
  the model.
- Confirm a NOT NULL stitch key still emits the plain `=` / `IN` forms — assert on the
  generated AST via `astToString`, in the style of the existing plan-shape assertions in the
  same spec, so the byte-identical claim is pinned rather than assumed.
- Update `docs/lens.md` per the section above.
- Run `yarn workspace @quereus/quereus test` and `yarn lint`. Baseline at `c6d8e5301`:
  `lens-put-fanout.spec.ts` is 120 passing, 0 failing.
