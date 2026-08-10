# Set-Operation Membership

> **Stability: Beta** — see [Stability Tiers](stability.md#tiers).

The `<setop> exists <branch> as <name>` clause manifests set-operation **branch membership** as a first-class boolean column, and lets a write route to a chosen branch. A satellite of [View Updateability](view-updateability.md) — the vertical analogue of the outer-join [existence columns](vu-operators.md#existence-columns-on-outer-joins).

## Set-operation membership columns

The vertical (row) analogue of the outer-join existence column: the
`<setop> exists <branch> as <name>` clause manifests a set operation's **branch
membership** as a first-class boolean column — reading it tells you which immediate
operand of the binary combinator the result tuple came from. See
[`sql.md` § Set-operation membership columns](sql-select.md#set-operation-membership-columns)
for the grammar. The same two soundness properties as the join existence column hold:

- **Derived at the combinator, not stored.** The flag is computed at the
  `SetOperationNode` by a **per-branch semijoin probe** over the operand *data*
  relations (`inA ≡ tuple ∈ A`, `inB ≡ tuple ∈ B`; `runtime/emit/set-operation.ts`),
  **never** a constant column stored inside a branch. A stored `inA` would re-enter the
  union's schema and **dedup**, perturbing set identity (the vertical analogue of the
  join's null-extended `{true, NULL}` symptom). The probe runs *after* the set
  operation, so dedup still operates on data columns only and the result is a clean
  `{true,false}` **NOT NULL** column. The derivation is uniform across all four
  operators: `union` / `union all` may be in either branch (both probes informative);
  `except` (`A except B`) yields `inLeft = true, inRight = false` by construction;
  `intersect` yields all flags `true`. For `union all` the probe is against a **set**,
  so the flag is the boolean "present ≥ once" (bag multiplicity collapses — a documented
  limit; a count variant is deferred).
- **FD ramifications (Invariants 1–2).** A **distinct** `union` / `intersect` / `except`
  is keyed on its all-columns (data) combination, so the forward FD walk emits
  `key → flag` (the flag is functionally determined by the data tuple it probes), and the
  flag is **never** claimed as part of a key. A `union all` (a **bag**) makes **no
  `key → flag` claim** — there is no data-column key to determine the flag from.
  `except` / `intersect` additionally carry the trivially-determined flags as constant
  bindings (`inRight = false`, all-true).

The flag is modelled as an extra output **attribute of the `SetOperationNode`** (not a
`ProjectNode` expression — that could only see set-op *outputs*, never the per-branch
data relations the probe needs), carrying an `existence` `UpdateSite` whose
`RelationalComponentRef` is a `set-op-branch` (the owning node + the immediate operand).
**Writable through an effect** (`resolveBaseSite` resolves a `set-op-branch` component
`writable: true` with no base column, `column_info` reports `is_updatable = 'YES'` / null
base, and a write drives a per-branch insert/delete — see § Set-operation membership
writes). The routing is **component-generic** (the same `existence` site the join
existence column uses), so the write half extends it without forking. An **unused** flag
is a semijoin probe and is *in principle* dead-column-eliminable — it ought not force a
branch to be retained or probed when no other column needs it. The analogous **join**
existence-flag pruning (`prune-unused-existence-flag`, the `join-existence-pruning` rule)
has landed, but the set-op membership analogue does not yet exist: the membership runner is
selected whenever the node carries any flag, so an unused flag on a `union all` currently
forces the buffering runner instead of the streaming one (correctness is unaffected; the
set-op sibling prune is deferred).

**Nestable flagged set-ops (read half).** An operand of a `SetOperationNode` may itself be
a (flagged) `SetOperationNode` — `A union[inA,inSub] (B union[inB,inC] C)`. Alignment, the
union schema, dedup, and set identity are all on **data columns only**: the outer arity
check compares each operand's recursive *data arity* (the left-most non-set-op leaf's column
count — flags are always appended after data at every depth), so an inner operand's surfaced
flags never inflate the check, and an inner flag never enters the outer's data-column set /
dedup / claimed keys (Key-Soundness Inv. 1–2 hold at every depth). An inner operand's flag
columns are **surfaced** as readable columns of the outer view under the defined projection
rule

```
[ data columns ] ++ [ L's flag attrs ] ++ [ R's flag attrs ] ++ [ M's own flag attrs ]
```

— data taken verbatim from the left child (ids preserved), each operand's flag attributes
threaded with their inner spec ids, then this node's own appended flags. A node surfaces
flags when it has its own membership flags **or** either operand does (so a flag-less outer
over a flagged operand — `A union (B∪[inB,inC] C)` — still surfaces `inB,inC`). The runtime
read half buffers each operand's full row and emits each output row under the same rule: a
surfaced inner flag reads as `tuple ∈ <that operand's data relation>` row-by-row at every
depth, defaulting **false** when the output row is absent from the operand (sound — an output
row not present in an operand is in none of that operand's nested branches, so every such
flag probe is false; verified for all four outer operators). The **write** half landed as
`nestable-flagged-set-ops`: a **union / union all** subtree operand is recursively writable for
data-column UPDATE / DELETE / `set <subtreeFlag> = false` fan-out, and the ambiguous subtree
inserts are deferred to `set-op-membership-nested` (see § Set-operation membership writes →
Nested / subtree operands). A **flagged `except` / `intersect` subtree operand** is now writable
for the same fan-out via a **membership gate** (`set-op-membership-nested-except`): the fan AND-s
the captured subtree-membership boundary flag into each leaf member-exists, so it reaches only
genuine subtree members; a **flag-less** non-union boundary stays deferred. The static surfaces
agree — they report a nested union or flagged-except/intersect body `is_updatable` /
`is_deletable` = `YES`, `is_insertable_into` = `NO`, a surfaced inner flag non-updatable, and a
view with a flag-less `except` / `intersect` subtree operand all-`NO`.

**Parenthesized LEFT-compound operand (read/plan, `set-op-leftwrap-arity`).** A `SetOperationNode`
operand on the **left** is, in SQL, a parenthesized compound — `(A∪B) union[…] (C∪D)` — which the
parser lifts into a `select * from (A∪B) as values_N` passthrough wrapper so the SELECT-level
`compound` slot can host the outer operator. The build path (`planner/building/select-compound.ts`)
**unwraps** that pure wrapper (`unwrapPassthroughSubquery`, shared with the write path) so the
operand plan **is** the inner compound — a first-class subtree operand the recursive `dataArity` /
`flagCount` machinery above already handles. Without the unwrap, building the wrapper as a `select *`
`ProjectNode` over the inner `SetOperationNode` would count the inner's surfaced flag columns as
**data** columns, and the outer arity check (`leftData !== rightData`) would throw `SET operation
column count mismatch` — so a flagged **parallel-sibling** view (flagged compounds on *both* sides)
could not even be planned. With the unwrap, such a view plans and reads under the same sum layout
`[data] ++ [L flags] ++ [R flags] ++ [own flags]`, where the two siblings contribute distinct flag
columns (e.g. `(A∪[inA,inB]B) union[inLsub,inRsub] (C∪[inC,inD]D)` reads `id, x, inA, inB, inC, inD,
inLsub, inRsub`). The unwrap is recursive (it peels every pure-passthrough layer of a deeper left
nest) and **shape-guarded** — only an exact `select *` over a single unaliased subquery source with
no `where` / `group by` / `having` / `distinct` / `order by` / `limit` / `offset` / own `compound` is
unwrapped; a projecting or filtering derived table (`select x from (A∪B) v`) stays an opaque
relation. This is the **sum** surface (distinct flag names → distinct columns). Two siblings that
**reuse** the same flag names (the **product** model — reused names merging into shared coordinate
columns) are out of scope and currently rejected at create (the duplicate names collide in the set-op
output scope); that merge — reused flag names valued `tuple ∈ <union of like-named leaves>` — is **not
built** as a bespoke surface: the product *use case* (addressing a discriminator grid) is served instead by
**multiple projected-constant discriminator columns** (§ Set Operations → Product-coordinate addressing via
projected-constant discriminators). A projected attribute records a row's *origin* (the sum model), not the
probe semantic a stored value cannot express, so the sum model is the honest scope. The only genuinely
out-of-scope residue is **writable boolean membership over a non-literal σ-guard** (a range / correlated /
function predicate the FD framework cannot fold to a constant and whose co-satisfiability the sat-checker
returns `unknown` on) — no use case has required it; reopen only if one does. Writes through the left
wrapper landed as `set-op-leftwrap-write` (see § Set-operation membership writes → Parenthesized LEFT
subtree operand): the write path unwraps the same pure wrapper, so the LEFT subtree fans out for the
unambiguous operations exactly as the right subtree does.

## Set-operation membership writes

The first set-op view writability in the engine (`planner/mutation/set-op.ts`). A
membership column **is** the branch presence, so *writing* it drives the branch's
existence — the explicit, per-row control surface that replaces the never-built
`quereus.update.*` routing-tag dispatch for set-ops (`union-branch` / `delete_via`,
removed by `remove-update-routing-tag-surface`). Scope is `union` / `union all` /
`except` / `intersect` membership writes, with data-column UPDATE fan-out, DELETE fan-out,
and `set <subtreeFlag> = false` recursing through a **nested / subtree operand** at any
depth (`nestable-flagged-set-ops`) — on **either** side, including a parenthesized LEFT
compound operand (`set-op-leftwrap-write`). A **union / union all** subtree fans freely; a **flagged
`except` / `intersect`** subtree fans **membership-gated** on its captured boundary flag
(`set-op-membership-nested-except`), and only a **flag-less** non-union boundary stays deferred.
The genuinely ambiguous inserts into a multi-leaf
subtree — `set <subtreeFlag> = true`, a surfaced-inner-flag write, and insert-through
routing into a subtree side — have no single deterministic target leaf (product-coordinate
addressing) and are deferred to `set-op-membership-nested`.

A set-op view body is **not** routed through the single-source/join spines — `propagate`
rejects a `SetOperationNode` body. Instead `building/view-mutation-builder.ts` intercepts a
membership body (`buildSetOpMutation`) and decomposes it into per-branch base ops over an
**up-front, Halloween-safe capture**: the affected view rows — their data columns **and**
their membership-probe flags — are materialized **once** (`Project(Filter_{userWhere}
(SetOperationNode))`) into the same context-backed `__vmupd_keys` relation the multi-source
path uses, *before* any branch op fires. Each branch op then reads that immutable capture,
so a branch insert/delete can never perturb the affected set out from under a sibling op
(the DML executor drains its source lazily, so referencing the view directly would be
Halloween-unsafe). The capture rides the existing `ViewMutationNode.identityCapture` side
input + void/drain runtime path — no new runtime substrate.

**A branch is itself a view body.** Each **single-source** operand (`select … from B`) has its
per-branch op lowered to an AST `BaseOp`
against a **synthetic branch view-like** and run back through `propagate` — reusing the
spines verbatim (the branch's own σ predicate, column renames, and base routing are honored
by its own spine; `no-default` / computed-column rejections fall out of the recursion).

**A multi-source (INNER join) branch/leg composes via a chained inner capture**
(`set-op-write-multisource-leg-compose`). A branch whose FROM is an inner equi-join
(`isInnerJoinBody`) does NOT route through plain `propagate` (which builds no capture and would
collide the multi-source spine's own `__vmupd_keys` identity capture with the outer set-op
capture — the internal `k.k0_0 isn't a column` error). Instead the fan builds the join branch
itself, mirroring `buildViewMutation`'s mini-orchestration: it analyses the branch join body
(`analyzeJoinView`), decomposes the base ops (`decomposeUpdate` / `decomposeDelete`) against a
**fresh per-branch capture name** `__vmupd_keys$N` (minted monotonically, so two join branches in
one statement never collide), and builds that **inner per-branch base-PK capture**
(`buildMultiSourceKeyCapture`) over the branch join body, filtered by the **same `buildMemberExists`
predicate** the single-source fan uses (the NULL-safe data-tuple match against the OUTER set-op
capture, plus any `except` / `intersect` gate flags). The inner capture is built under a context
with the outer `__vmupd_keys` injected, so its `memberExists` filter scans the outer capture; it is
bubbled up on `SetOpWritePlan.nestedCaptures` and rides `ViewMutationNode.nestedCaptures` —
materialized **outer-first, then each inner**, before the branch base ops, so the inner capture
freezes the branch's affected rows before any base op mutates (Halloween-safe and order-independent
across the branch's own base ops, including a both-sides write). The chain is:

```
outer set-op capture  __vmupd_keys      = π_{view cols + flags}( σ_{userWhere}( setOpRoot ) )        [primary capture]
inner branch capture  __vmupd_keys$N    = π_{k<side>_<j>}( σ_{memberExists}( branchJoinNode ) )      [nested, scans the outer]
branch base ops       update/delete t_side … where exists(select 1 from __vmupd_keys$N k where k.k<side>_<j> = t_side.<pk_j>)
```

A composite-PK / self-join branch flows through unchanged (the inner capture projects one column
per PK column per side; self-joins route by alias). **INSERT** into a join branch — a membership
`set <flag> = true`, a flag-less consistent-leg insert, or VALUES insert-through — needs the
plan-level shared-surrogate envelope the AST `BaseOp[]` fan does not produce, and is now **shipped**
(`set-op-write-multisource-leg-insert`): each active join leg's insert is routed to
`buildMultiSourceInsert` (the standalone inner-join insert envelope) and the resulting
envelope-backed `ViewMutationNode` is **spliced as a nested child** of the outer set-op write node's
`baseOps`. The emitter drives each child as its own self-contained sub-program (`emitCallFromPlan`),
so two join legs active in one statement (the `TWO` shape) carry distinct identity descriptors and
never collide, and a membership `set <flag>=true` flip's nested envelope source (`from __vmupd_keys k
where not k.<flag>`) reads the OUTER set-op capture — materialized first as the outer node's
`identityCapture`, shared via `rctx` (so the flip is Halloween-safe by construction). The static
`is_insertable_into` surface reports `YES` for a body whose join legs are **all** insertable —
re-derived dynamically by `setOpJoinLegsInsertable`, which probes each `isMultiSource` leg with
`analyzeMultiSourceInsert` and reports `NO` for a leg that rejects: a **composite-PK** shared key
(`unsupported-decomposition-key`), a **non-equi** ON (`unsupported-join`), a shared key that is
**neither supplied nor defaulted** (`no-default` — e.g. a self-join whose anchor key has no default),
or an **uncovered NOT NULL** base column on the non-key side; a subtree operand stays `NO` too
(`setOpHasSubtreeOperand`). UPDATE / DELETE through the same body's join branches remain `YES`. An
**OUTER (left/right/full) / cross** join leg is still deferred for the set-op write — rejected
cleanly at branch classification (`isInnerJoinBody` is false). A
**non-equi (theta) inner** join leg, by contrast, is admitted by `isInnerJoinBody` (which keys only
on `joinType`) and composes here **exactly as the standalone join-view path admits it** — so a
membership body's non-equi inner-join branch is writable, not deferred. The flag-less set-op path
admits non-equi inner legs identically: `isWritableLeafLeg` (which gates `flaglessShape`) also keys
only on `joinType`, so all three paths (standalone, membership, flag-less) accept a non-equi inner
join leg for UPDATE / DELETE.
A branch that bottoms out in a base table emits one base op; a branch that is itself a
`SetOperationNode` (a **subtree operand**) **recurses here** for the
unambiguous fan-out — a data-column UPDATE, a DELETE, and a `set <subtreeFlag> = false` drop
fan out to every member leaf, sharing the ONE up-front capture (the recursion rebuilds the same
frozen-data-tuple correlation against each inner branch, never a second capture; see § Nested /
subtree operands). A **union** subtree fans freely; a **flagged `except` / `intersect`** subtree
fans gated on its captured boundary flag (`set-op-membership-nested-except`), a flag-less one is
deferred. Inserting into a subtree is `set-op-membership-nested`.

**Per-operator membership-write semantics** (uniform across operators because the probe
flags already encode each operator's branch truth):

- **`union` / `union all`** — `inA` / `inB` independent. `set inA = true` ⇒ insert into A,
  `= false` ⇒ delete from A; symmetrically for B. **Both false** ⇒ the row leaves the view
  (deleted from every branch it was in).
- **`except`** (`A except B`) — a visible row is `inLeft = true, inRight = false`.
  `set inRight = true` ⇒ insert into B, pushing the row **out** of the view (the explicit
  form of the removed `delete_via = 'right_insert'`); `set inLeft = false` ⇒ delete from A
  (the row leaves the view).
- **`intersect`** — reads are trivially all-true, so membership columns are **write-useful
  only**: `set inB = false` ⇒ delete from B, dropping the row from the intersect.

**The probe makes a redundant flip a clean no-op.** A `set <flag> = true` inserts only the
captured rows **absent** from that branch (`where not k.<flag>`), so writing `true` over a
row already present is a no-op — and the per-operator semantics fold in for free (`except`'s
always-false right flag inserts every visible row; `intersect`'s always-true flags insert
none). A `set <flag> = false` deletes the matching branch row only for captured rows
present there (a NULL-safe full-data-tuple `exists` correlation against `__vmupd_keys`; set
operations treat `NULL = NULL` as equal, and the engine has no `IS NOT DISTINCT FROM`).

**Data-column writes & deletes fan out via the probe.** `update U set <dataCol> = v where
…` fans an update to **every branch the row is a member of** (the full-tuple `exists`
correlation restricts each branch update to its resident rows — a non-member branch matches
none, so no explicit flag gate is needed, and a branch need not even declare a flag for
fan-out). `delete from U where …` fans a delete to every member branch the same way.

**Composition & rejection.** A same-statement data assignment folds into a `true` flip's
inserted projection (`set x = 5, inB = true` over an A-only row inserts B with `x = 5` and
aligns A). `set x = 5, inB = false` is **rejected** (`conflicting-assignment`) — a write
cannot both delete a branch and write a column that fans out to it. A membership value must
be a **boolean literal** (`true`/`false`, or the `1`/`0` spellings); a non-literal per-row
branch is deferred. **Insert-through** (`insert into U (id, x, inA, inB) values (…, true,
false)`) routes by the supplied flags — a true flag activates its branch, a false flag omits
it — over a VALUES source (the flags are a uniform per-statement routing directive). A
flag-less ambiguous multi-branch insert is rejected. RETURNING through a set-op membership
write is not yet recoverable (rejected).

**Nested / subtree operands** (`nestable-flagged-set-ops`). An operand of an outer set-op
may itself be a (possibly flagged) `SetOperationNode` — `A union[inA,inSub] (B union[inB,inC]
C)`. Such a **subtree operand** is recursively writable for the unambiguous fan-out
operations: a data-column UPDATE fan-out, a DELETE fan-out, and `set <subtreeFlag> = false`
(a delete fan-out into the subtree's leaves) all recurse through the subtree to its member
leaves, **sharing the single up-front capture**. The recursion is sound because nesting
preserves the data columns at every depth (the `SetOperationNode` arity check is data-only),
so "touch the leaf rows whose data tuple ∈ `__vmupd_keys`" is the same frozen-capture
correlation rebuilt against each inner branch. For a **union / union all** subtree a
leaf's rows ⊆ the subtree's, so the capture selects exactly the resident leaf rows to touch,
no second capture is introduced, and Halloween-safety is preserved at depth. A **flag-less
union subtree operand** (`A union[inA,inSub] (B union C)`) is writable through the same recursion
(it need not declare inner flags to fan out).

**Membership-gated `except` / `intersect` subtree fan-out** (`set-op-membership-nested-except`).
For an `except` / `intersect` subtree a leaf is NOT a subset of the subtree (a row in both `B`
and `C` is absent from `B except C`), so a blind fan-out would touch leaf rows the subtree
excludes — rows whose `inSub` probe reads false — silently corrupting base rows the view never
exposed as subtree members. The fix **gates** the fan on the captured **subtree-membership
boundary flag**: the `exists <branch> as <flag>` the OUTER compound declares for the subtree's
side (`inSub`) is a view output column, so it sits in the capture, and AND-ing `k.<flag>` into
each leaf's member-exists restricts the fan to genuine members. This restores the proven binary
behavior at depth — for a binary `B except C` the capture holds only members (B\C), so fanning
to both leaves is sound (C gets harmless no-ops); gating the nested fan on `k.inSub` makes it
behave identically. The gate **accumulates one conjunct per non-union boundary descended**: in
`A union[inA,inS1] (B except[inB,inS2] (C intersect[inC,inD] D))` a member of `B except (C∩D)`
that is in C-only (not D) has `inS1=true` but `inS2=false`; gating only on `inS1` would wrongly
touch C, while gating on `inS1 AND inS2` correctly skips C/D. A **union** boundary contributes
nothing (a union leaf ⊆ its subtree, so leaf-presence already implies membership). The lone
remaining deferral is a **flag-less non-union boundary** (`A union[inA] (B except C)` — no
`inSub`): it surfaces no boundary probe to gate on, so the dynamic write and the static surfaces
both reject it (`set-op-membership-nested-except`); synthesizing the probe from leaf flags
(`inB AND NOT inC`) is a possible future enhancement.

The genuinely ambiguous inserts into a subtree
are **deferred** to `set-op-membership-nested` (product-coordinate "which leaf?" addressing)
with clean diagnostics: `set <subtreeFlag> = true` (insert into a multi-leaf subtree), a
**surfaced-inner-flag** write (`set inB = …` through the outer view — addressing a branch
*inside* the operand), and **insert-through** whose active routing flag is a subtree side.
Each diagnostic names `set-op-membership-nested` and is neither the misleading
`SetOperation … not updateable` message nor `unknown-view-column` (a surfaced inner flag IS a
view column).

**Parenthesized LEFT subtree operand** (`set-op-leftwrap-write`). A subtree operand can sit on the
**left**, where SQL spells it as a parenthesized compound — `(A∪B) union[…] (C∪D)`, the
*parallel-sibling* shape — which the parser lifts into a `select * from (A∪B) as values_N`
passthrough wrapper so the SELECT-level `compound` slot can host the outer operator (§ Parenthesized
LEFT-compound operand). The write path **unwraps** that pure wrapper (`buildBranch` →
`unwrapPassthroughSubquery`, the same predicate the read/plan path uses) so the wrapped left operand
is a first-class subtree operand — its data-column names, `isNested`, and fan-out recursion all derive
from the inner compound, exactly as the (always-direct) right compound operand. The result is full
symmetry: the unambiguous fan-out (data UPDATE / DELETE / `set <subtreeFlag> = false`) reaches the
LEFT subtree's leaves at any depth — a `delete from P1 where id = 2` over `(A∪B) union[inL,inR] (C∪D)`
fans into A and B, and `set inL = false` drops the row from the left subtree's resident leaves only
(the right subtree keeps it). A union LEFT subtree fans freely; a flagged `except` / `intersect` LEFT
subtree fans **membership-gated** on the boundary flag the outer compound declares for the left side
(`set-op-membership-nested-except`), a flag-less non-union one stays deferred. The branch's data-column
names come from its **left-most leaf** (a left-spine nest's own left leg is itself wrapped, so a single
projection read would see the wrapper's `*`; the write path descends to the real leaf). The ambiguous
inserts into the LEFT subtree (`set <subtreeFlag> = true`, a surfaced left-subtree inner-flag write,
insert-through routing into the left subtree side) stay deferred to `set-op-membership-nested`, and the
static surfaces walk **both** operands so `is_insertable_into` reports `NO` and the surfaced left-inner
flags report `is_updatable = NO`. The orthogonal **product** model (two siblings *reusing* flag names,
merging into shared coordinate columns) is **not built** as a bespoke surface: its *use case* — addressing
a discriminator grid — is served by **multiple projected-constant discriminator columns** (see
Product-coordinate addressing via projected-constant discriminators, below). Projected attributes express
the **sum** model (origin tags), not the **merge** (`tuple ∈ <union of like-named leaves>`); the only
genuinely out-of-scope residue is **writable boolean membership over a non-literal σ-guard** (which the
sat-checker decides `unknown` on anyway). No use case has required it — reopen only if one does.

**Flag-less predicate-honest writes (the preferred surface, `set-op-flagless-predicate-honest-writes`).**
A flag-less set-op body whose legs carry *regular projected columns* — plain base columns plus literal
**discriminators** (`'red' as kind`, `'A' as src`) — is writable WITHOUT any `exists … as <flag>` membership
column. It is the **preferred** write surface over the `exists`-membership path above (the two coexist; no
unification this pass), reusing the SAME substrate verbatim: the up-front Halloween-safe capture, the
per-branch recursive `propagate` lowering, the member-exists correlation, and the data/delete fan helpers
(shared through `buildSetOpMutation`, parameterized by the per-shape write builder). The ONE difference is
the **per-leg branch oracle**: instead of a runtime membership-probe flag, a leg's eligibility is decided at
PLAN time by `checkSatisfiability` (`analysis/sat-checker.ts`) over the leg's σ-derived constant facts ∧ its
literal-discriminator bindings ∧ the mutation's predicate — `unsat ⇒ skip the leg`, `sat`/`unknown ⇒ include
it` (honest fan-out over silent suppression; the checker never emits a false `unsat`, so a real target leg is
never dropped). INSERT routes a VALUES row to every consistent leg (a literal-discriminator design routes to
exactly one); DELETE / data-UPDATE fan to every consistent leg; `intersect` fans inserts/deletes to every leg
and `except` writes the left operand only. The literal discriminators are **read-only** — a `set kind = …`
surfaces `no-inverse` (a projected literal has no base inverse).

The discriminator routing does **not** "fall out of the FD framework for free": a pure-literal projection
(`'red' as kind`) emits **no constant FD** today — `ProjectNode.computePhysical` only *forwards* the child's
existing bindings through the source→output column map, and a literal has no source attribute to forward. So
the oracle closes the gap with the localized **Option B**: it reads each leg's literal projections directly
from the leg AST (peeling Cast/Collate) and synthesizes the discriminator `ConstantBinding`s itself, feeding
them to the checker alongside the leg's *planned* physical bindings — which DO carry the σ-on-projected
constant (`where color='red'` forwarded to a `color`-projecting output column). That σ-derived half — and the
omitted-base-column insert recovery it drives — IS pre-existing (the same single-source `where`-constant
insert-defaulting the GreenMen view uses); only the routing discriminator needed the localized synthesis. No
hot-path (`ProjectNode.computePhysical`) change was made; the optimizer-wide projected-literal-constant-FD
enhancement (Option A) is a separate deferred concern. **v1 limitations:** VALUES-source inserts only (a
SELECT/DML source's per-row routing is deferred); RETURNING is rejected; a `union all` view with duplicate /
overlapping data tuples fans a delete/data-update to all copies (bag identity); a leg discriminating purely
by a non-literal σ (`where f(color)`) routes by include-on-unknown but cannot recover its omitted base
columns on insert; a deep / mixed `intersect`/`except` chain is not flattened (it stays on the existing
reject); an INSERT that **omits a discriminator** is consistent with every leg that discriminator would have
excluded, so it routes to all of them — when two such legs share a base table this surfaces as a clean PK
conflict (a leg discriminating by a non-`=` range σ on a *projected* column is now **honored by the
oracle** — its σ conjuncts (`where x < 5`, `between`, …) are fed to `checkSatisfiability` alongside the
mutation predicate, so an INSERT whose supplied value provably violates the range makes that leg `unsat`
⇒ skipped, with no phantom base row, `set-op-flagless-range-sigma-oracle`; a σ on a **non-projected**
column (`where f(color)`) still resolves to no in-scope accumulator and routes include-on-unknown);
a leg whose body is a **multi-source (INNER join) body** is now **composed** through the chained inner
per-leg capture (`isWritableLeafLeg` admits an inner-join leg; the fan builds an `__vmupd_keys$N`
capture off the outer set-op capture — see § Set Operations above), so UPDATE / data-UPDATE and DELETE
fan to it and the static surfaces report `is_updatable` / `is_deletable` = YES. INSERT through a join leg
is now **shipped** too (`set-op-write-multisource-leg-insert`): each active join leg's consistent-leg
insert is built via `buildMultiSourceInsert` and spliced as a nested envelope-backed `ViewMutationNode`
child of the outer set-op write node (a mixed body — one join leg + one plain leg both consistent with
a discriminator-omitting INSERT — lands both: the plain leg's base op plus the join leg's nested
envelope, in fan order). The static `is_insertable_into` is `YES` for a body whose join legs are **all**
insertable, re-derived by `setOpJoinLegsInsertable` (NO for a composite-key / non-equi / no-default /
uncovered-NOT-NULL join leg). An OUTER / cross join leg stays deferred (the body drops out of the
flag-less route, static surface all-`NO`), so neither path hits the internal `k.k0_0 isn't a column`
error the un-composed nested capture used to (`set-op-write-multisource-leg-compose`).

**v1 limitations (documented).** Identification is by the full data tuple, so a `union all`
view with **duplicate data tuples** in a branch fans a delete/data-write to *all* copies of
that tuple (the count variant is deferred). A data-fan-out value that *references* a data
column requires the operand legs to use matching column names (a leg rename of a
referenced column is not yet remapped); literal values are unaffected. A branch leg must
be a plain (optionally renamed) base-column projection — a `select *` or computed leg
column in a writable branch is rejected. **Static-surface partial on a subtree flag:** an own
subtree flag (`inSub`) carries an `existence` site, so `column_info` reports it
`is_updatable = YES` — accurate for its `= false` delete (which works) but optimistic for the
deferred `= true` insert; the dynamic write still rejects the latter cleanly.

**Product-coordinate addressing via projected-constant discriminators (the recommended product surface,
`set-op-projected-constant-product-coordinate`).** A flag-less body with **multiple** literal discriminator
columns forms a **discriminator grid** — e.g. `kind ∈ {red, large}` × `src ∈ {A, B}` is the two-axis
`{inX,inY} × {inA,inB}` product grid the shelved product model targeted. A write **addresses a coordinate**
by filtering on those (read-only) discriminator columns, and the per-leg branch oracle does the routing:

| Addressing | Filter | Result |
|---|---|---|
| pin one leg (fully-specified coordinate) | both axes (`where kind='red' and src='A'`) | writes the single co-satisfiable leg |
| fan to a sub-grid (partially-specified) | one axis (`where kind='red'`) | fans to every consistent leg (`red+A`, `red+B`) |
| contradictory / off-grid | same axis twice (`where kind='red' and kind='large'`) or an unknown value (`where kind='zzz'`) | matches no leg ⇒ clean **no-op** |

This serves the product *use case*: the addressing the shelved `set-op-product-coordinate-model` wanted
falls out of filtering read-only discriminator columns, with no bespoke writable-membership build. The
contradiction case is *more* natural here than in the product model — discriminators are read-only and
addressed by `where`, so a contradictory filter simply selects nothing; there is no incoherent
"write two mutually-exclusive memberships" request to reject, hence **no `predicate-contradiction` gate**.

**Zero-leg DELETE / data-UPDATE is a clean no-op.** When a DELETE / data-UPDATE predicate is provably
`unsat` for **every** leg (a same-axis contradiction, an off-grid discriminator value, or any predicate
inconsistent with each leg's σ), the fan narrows to zero legs and the write affects **0 rows** — standard
SQL for a no-match DELETE/UPDATE. (Implemented at the shared `buildSetOpMutation` boundary: an empty
decomposition for a non-insert op lowers to a void `SinkNode` instead of constructing an empty
`ViewMutationNode`, whose constructor rejects a zero-base-op list.) This is the delete/update dual of — and
deliberately contrasts with — the **INSERT** empty-route, which stays a genuine **`consistent with no
writable leg`** diagnostic: a row that routes to no branch would be invisible through every branch, so it
is an error, not a silent no-op.

**Static surfaces gate on branch writability.** `view_info` / `column_info` for a
membership body now mirror the **non-decomposable join shape gate**: they confirm the
membership shape *and* that both operands are themselves branch-writable before reporting
writable, via an AST-only probe (`isSetOpBranchWritable`) that is the static shadow of the
dynamic write's pre-write rejections — an outer `LIMIT`/`OFFSET` (the body is not
decomposable, a write would escape the window), a non-SELECT right operand, a `select *`
leg, a computed leg, or legs whose plain-column counts disagree. A body that fails the probe
reports the conservative shape (`view_info` all-`NO`, every `column_info` row
`is_updatable = 'NO'` with null base), agreeing with the dynamic write's reject instead of
over-claiming writable from the membership flag's presence alone. The probe is now
**recursive** (`nestable-flagged-set-ops`): an operand is branch-writable iff it is a
plain-column leaf OR a (recursively) branch-writable set-op body, so a
nested union view reports `is_updatable` / `is_deletable` = `YES` (data + delete fan-out
genuinely recurse through the subtree). A **flagged `except` / `intersect` subtree operand is
branch-writable** (`set-op-membership-nested-except`): the probe threads each operand's
**boundary-flag presence** (the `exists <branch> as <flag>` the parent compound declares for
that side) and admits a non-union subtree IFF its side carries a boundary flag to gate the fan
on — so a flagged except/intersect view reports `is_updatable` / `is_deletable` = `YES`, while a
**flag-less** non-union boundary stays non-writable (the conservative all-`NO` shape), agreeing
with the dynamic reject. The probe **unwraps a parenthesized LEFT compound operand** before
classifying it (`set-op-leftwrap-write`), so a parallel-sibling view reports its left subtree's
writability identically to the right. `is_insertable_into` is gated **off** to `NO` whenever **either**
operand is a subtree (`setOpHasSubtreeOperand`, which now walks the unwrapped left too) — inserting
into a multi-leaf subtree is deferred to `set-op-membership-nested` — AND requires every multi-source
(INNER join) branch be insertable, re-derived dynamically by `setOpJoinLegsInsertable` (a throwaway
`db._buildProbeContext()` probes each `isMultiSource` branch with `analyzeMultiSourceInsert`; a
composite-PK / non-equi / no-default / uncovered-NOT-NULL leg ⇒ `NO`). A join-leg INSERT is now
shipped via the nested shared-surrogate envelope splice (`set-op-write-multisource-leg-insert`), so a
body whose join branches are all insertable reports `YES` and the dynamic insert lands. Per-column, a
**surfaced inner flag** reports `is_updatable = 'NO'` (writing it is deferred),
while data columns and own flags report `YES`. The surfaced-inner enumeration
(`surfacedInnerFlagNames`) mirrors the plan's recursive `[L flags] ++ [R flags] ++ [own flags]`
attribute layout across **BOTH legs** of every subtree operand (unwrapping each left-compound
`select * from (compound)` wrapper) — descending left, then right, then appending the node's own
flags. So `column_info` reports every surfaced inner flag `is_updatable = NO` in agreement with the
dynamic `set-op-membership-nested` reject, for a flag declared on **either leg** of a left- OR
right-side subtree operand **at any depth** (`set-op-subtree-leftleg-flag-surface`) — not just a
subtree's own / right-leg flags. The enumeration lands element-for-element on the plan-derived
`analysis.surfacedInnerFlagNames` (the `viewColNames` slice between the data columns and this body's
own flags), so the static surface never drifts from the dynamic write.

> **Implemented surface vs. the design below.** Binary set-op write-through is realized
> through the **membership columns** above (`set-op-membership-write`): the explicit
> per-row branch control surface. The predicate-honest fan-out + `quereus.update.*`
> routing-tag dispatch once described in the four subsections that follow (`delete_via`,
> `target`, `right_insert`, branch-consistency inference) was the **original aspirational
> design** — it was never built (no parser syntax, no consumer), and the routing-tag
> surface has been **removed** (`remove-update-routing-tag-surface`). The runtime
> membership probe is the branch oracle in its place; for set-ops without membership
> columns, write-through still rejects (`unsupported-set-op`). The subsections are kept for
> the per-operator semantic intent, which the membership-write rules above realize — read
> any `delete_via` / `target` mention there as its membership-column equivalent.
