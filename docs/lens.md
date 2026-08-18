# Lenses and Layered Schemas

> **Stability: Experimental** — see [Stability Tiers](stability.md#tiers).

## Overview

A database has two faces that rarely match. There is the design you want to *think* in — clean tables with the columns, types, and rules your application cares about — and the storage you actually *run on*, which may split one designed table across several physical tables, fold it into key-value triples, or spread it across more than one storage module. A **lens** is the two-way mapping between them: it lets you read and write your designed tables normally while the engine translates, in both directions, to and from however the data is really stored.

Concretely. Suppose you want to work with a `Car` table:

```sql
-- The design — how you want to think about it. No storage decisions here.
declare logical schema App {
  table Car (
    id       int primary key,
    make     text,
    topSpeed int
  );
}
```

…but your storage keeps each car's identity and its performance numbers in separate physical tables:

```sql
-- The storage — ordinary module-backed tables. Quereus calls this the "basis".
declare schema Store {
  table CarCore  (id int primary key, make text)    using mem();
  table CarSpeed (id int primary key, topSpeed int) using mem();
}
```

A lens binds the design to the storage. This one is a single line — it tells the engine how the two storage tables join. Because the column names already line up, nothing else needs saying; each `Car` column maps itself:

```sql
declare lens for App over Store {
  view Car as
    select id, make, topSpeed
    from CarCore join CarSpeed using (id);
}
apply schema App;
```

Now `App.Car` behaves like an ordinary table **in both directions**:

```sql
select id, make, topSpeed from App.Car where id = 7;
--   → reads CarCore joined to CarSpeed, transparently

insert into App.Car (id, make, topSpeed) values (7, 'Civic', 180);
--   → writes (id, make) to CarCore and (id, topSpeed) to CarSpeed, in one statement

update App.Car set topSpeed = 200 where id = 7;
--   → updates only CarSpeed
```

That is the whole idea. You design `Car` once; the storage underneath can be a single table, a column split like this, a key-value layout, or several modules at once — and `App.Car` reads and writes the same way regardless. Swapping storage strategies becomes a change to the lens, never to the design or the application. This is the decisive property: **the design carries no commitment to how it is stored.**

The rest of this document is the precise machinery behind that picture — how the mapping is generated when you don't write it, how writes reach the right storage tables, how the rules you declared on the design are still enforced, and how the engine *proves* the mapping is faithful before it deploys.

### Key terms

A few terms recur throughout; no background in database research is assumed.

- **Logical** — the design layer: the tables, columns, types, and rules (primary key, `unique`, `check`, foreign key, `not null`) you reason about. No storage.
- **Basis** — the storage layer seen *as relations*: ordinary `using module(...)` tables, possibly several per logical table, possibly across several modules.
- **Lens** — the mapping between one logical table and the basis, in two directions. **`get`** is the *read* — an ordinary `select` that produces the logical table from basis. **`put`** is the *write* — how an `insert` / `update` / `delete` on the logical table is pushed back down to basis. "Bidirectional" just means a lens has both.
- **Decomposition** — a logical table whose data is split across more than one basis table (the `Car` example splits across two). When the engine generates such a mapping itself, one basis table acts as the **anchor** — the one that decides whether a row exists — and the others attach their columns to it.
- **Surrogate key** — an internal join key (often auto-generated) that basis tables share, distinct from the logical primary key.
- **Functional dependency (FD)** — shorthand for "these columns determine those" (a primary key determines the rest of its row). Quereus tracks FDs all through the query plan; the lens layer reuses that tracking to decide what is writable and to prove keys hold. You will see the names **GetPut** and **PutGet** later — they are the two correctness laws a lens must satisfy, defined where they are used.

### The three layers

Stated precisely, a database separates into three layers of relations (Quereus expresses all three with its own virtual, key-addressed tables — there are no row-ids):

- **Logical** — the relations a developer designs and reasons about, free of any storage commitment. A logical schema declares tables with columns, types, and *logical* constraints (primary key, unique, check, foreign key, not null) and nothing physical: no module association, no indexes, no storage hints. It is a pure design.
- **Basis** — the relations that modules actually back. Basis tables are ordinary `using module(...)` tables and may be spread across many modules (a single logical table can map to a columnar decomposition over several basis tables). Basis is still *relational* — it is the lowest layer a developer reasons about as relations. Covering structures (secondary indexes, unique-enforcement structures) live here as materialized views.
- **Mapping (the lens)** — for each logical table, the bidirectional `get` / `put` pair that realizes it over basis relations. The lens is *not* a schema; it is a per-logical-table **slot**, populated either by an explicit `declare lens` block or generated for you when absent.

Below basis sits the **physical** layer — module storage layout and the on-disk/in-memory realization of covering structures. The lens never sees physical concerns; it composes over basis relations, and modules handle storage beneath.

## Topic documents

This document is the **hub**: the layer model, the default mapper, sparse overrides, constraint attachment, deployment, and the syntax surface. The subsystems large enough to read on their own live in the topic documents below.

| Document | Covers |
| --- | --- |
| [The Lens Prover](lens-prover.md) | What `proveLens` checks at deploy: the proof-obligation / enforced-constraint split, the coverage checklist, every `lens.*` diagnostic code, and advisory acknowledgment and escalation. |

## What a Lens Is

A lens reuses machinery Quereus already has, rather than inventing a new sublanguage. The **`get`** direction is an ordinary `select`. The **`put`** direction is the engine's existing ability to push a change through a view down to its base tables (see [view updateability](view-updateability.md)) — an `insert` / `update` / `delete` on the view becomes the equivalent writes on the tables underneath. So **the only operator set, in both directions, is ordinary relational algebra** (the operations behind `select`). Two consequences follow:

- **Any view can serve as the read mapping.** If you can write it as a `select`, you can use it as a `get` — a lens body *is* a view body.
- **A write goes through only when the mapping can be run in reverse.** Not every expression has a sound inverse — `lower(name)` cannot be undone, for instance. Where the engine can infer the inverse it does; where it cannot, the write is refused with a clear diagnostic naming the column. Invertibility is made explicit rather than silently narrowing what you can write.

To the query processor, then, a logical table is simply a view that is "out there, ready to go." Selecting from `Logical.T` resolves to the lens-compiled body over basis; mutating it propagates through that body via the standard view-update machinery. All lens-specific work happens at compile time: **validate, generate, and attach semantics** — there is no lens-specific code at query runtime.

## Schema Kinds

`Schema` carries a `kind`:

- **`physical`** — module-backed schema. Tables declare `using module(...)`, may carry indexes (as index declarations or materialized views), storage tags, and the full physical surface.
- **`logical`** — declarative-only. Tables declare columns, types, logical constraints, and `with tags`. Module association, indexes, and any physical storage construct are rejected at build time. Tags *are* allowed — they are engine-facing metadata, not a physical commitment, and they survive into the compiled view.

There is no `lens` schema kind. The mapping for a logical table lives in that table's lens slot.

## The Lens Slot

Every logical table has one **lens slot** holding:

- the mapping body (a relational expression over basis), and
- the attachment of the logical spec's constraints and tags onto that body.

The slot is populated by one of two paths:

1. **Explicit** — a `declare lens` block supplies an override body for some logical tables (and may cover only some columns of a table).
2. **Generated** — when no override exists, or for columns an override does not cover, the default mapper generates the body.

At any deployment a logical table has exactly **one** active lens (its inlined body). Portability across embodiments is a *source-level* property — the same logical schema can be written against different lens+basis pairs for different targets — not a simultaneous-catalog property.

## The Default Mapper

**The gist:** when you don't write a lens, the engine writes one — it matches each logical column to a basis column by name (plus any hints a storage module advertises) and assembles the join, exactly as in the `Car` example above. The rest of this section is what keeps that generated mapping correct when the match is *not* a clean one-to-one: split tables, optional columns, generated keys, and storage that doesn't expose your column names at all.

When a lens body is not authored, it is generated. The generator is **module-specific and customizable**: the strategy of a standard row-store is the default, but modules can advertise their own logical→basis mapping so that exotic storage strategies (columnar decomposition, EAV, column-family) are accommodated without the developer authoring the join.

The default mapper is an **aligner over two independently-authored models**. Given a logical schema and a basis schema, it matches logical relations and columns to basis by name, type, and structure — and by module advertisements (e.g. "these five basis tables are a columnar decomposition sharing key `id`," from which the mapper generates the n-way join). A developer's overrides are *corrections to the alignment* plus intentional transforms; a rename is simply an alignment the developer overrode on purpose.

Four properties of the generated join are load-bearing for correctness:

- **Advertisements can be primary, not supplementary.** Name/type/structure matching works only when the basis surfaces logical column names. When a decomposition does not — generic value-columns, EAV triples, column-family layouts — the module advertisement is the *sole* alignment source and must carry enough to map each basis relation to the logical column(s) it backs. The advertisement also informs the **`put`** direction, not only `get`: it tells propagation the fan-out shape and the shared key, so an insert through the generated lens reaches every member of the decomposition.
- **Optional components are outer-joined.** A logical row may lack a value for a column that lives in a separate basis relation. The generated body must preserve such a row, so the mapper outer-joins optional components onto the relation that establishes row identity (the preserved side) and inner-joins only mandatory (`not null`) components. Inner-joining everywhere would silently drop rows missing an optional component. The existence soundness of a mandatory inner-join rides the propagated [inclusion-dependency](optimizer-fd.md#inclusion-dependency-tracking) surface: the lens compiler injects one inclusion dependency per mandatory component onto the existence anchor, so the prover proves every logical row matches the mandatory side against a threaded existence fact rather than a separate scan (see *The existence-anchor inclusion-dependency contract* below).
- **The shared key need not be a logical key.** A module may join its basis relations on a **surrogate** key and carry the logical key as an ordinary value column. This is a deliberate choice with a consequence: when the shared key is a surrogate, evolution of the logical key (rename, retype, reshape) is a mapping-level edit, because the basis already treats the logical key as a value; when the shared key *is* the logical key, the same evolution is basis-invasive. A surrogate is supplied at insert by the **declared `default` on the anchor's key column** — the engine no longer fabricates one, so the basis author **must** declare it (validated at deploy time). The load-bearing requirement is **evaluate-once-and-thread**: the engine evaluates that default once per logical row at the envelope and reuses the value across every branch of the decomposition's fan-out via the equivalence class, so all members of the n-way insert agree on identity. The default may be a **non-deterministic generator** (`uuid7()`, `nanoid()`, …) where the local DML policy permits non-determinism — the [change-capture layer](incremental-maintenance.md) records the *resolved* row, so reactive consumers, assertions, and replay see concrete values rather than the expression. The canonical monotonic-integer recipe is `default (coalesce((select max(<key>) from <anchor>), 0) + mutation_ordinal())`, where [`mutation_ordinal()`](vu-mutation-context.md#mutation-context) is the per-row ordinal primitive that reaches column-default position. The [mutation-context envelope](vu-mutation-context.md#mutation-context) remains available where binding a seed at the statement level is preferred (e.g. to share it across several computed columns).
- **The empty key (singleton) is the degenerate case, not a special path.** A logical table with `primary key ()` holds 0-or-1 rows. The primary key always decomposes to an existence relation whose arity equals the PK's arity, so a zero-arity PK yields a zero-column, 0-or-1-row existence relation — a basis singleton. The key-equi-join that stitches columns onto the anchor is a conjunction of per-key-column equalities; over a zero-column key that conjunction is empty, hence vacuously `true`, so the generated join reduces to `on true`:

  ```sql
  -- normal table: key = (id)            singleton: key = ()
  from   b_pk      x                     from   b_config__exists x   -- 0-or-1 row, no key, no value
  left join b_col1 c1 on c1.id = x.id    left join b_config_theme  t on true
  left join b_col2 c2 on c2.id = x.id    left join b_config_locale l on true;
  ```

  `left join … on true` is a left Cartesian product; with the anchor 0-or-1 row and each column relation 0-or-1 row, the result is 0-or-1 row — the singleton's cardinality. There is no surrogate to generate (with at most one row there is nothing to distinguish), and the existence anchor still matters for the same reason the multi-row PK store does: it lets the singleton exist with every column null, rather than collapsing "row exists" into "some column is set." The mandatory-column elision applies identically — a `not null` column's relation can serve as the anchor, dropping the separate existence relation.

### The module mapping advertisement

A module advertises how a set of *its* basis relations jointly back one logical table by returning `MappingAdvertisement` descriptors from the optional `VirtualTableModule.getMappingAdvertisements(db, basisSchema)` hook. The method is **module-level given the basis schema** — a module spans many tables and a decomposition spans many relations, so it returns every decomposition it recognizes and the lens compiler's resolver indexes them. Omitting the method means name-match only. A *dedicated* module (columnar / EAV / nd-tree) synthesizes advertisements from its own knowledge; a *generic* module (memory / store) delegates to a shared builder, which assembles them from `quereus.lens.decomp.*` reserved tags on the basis tables.

**Storage and access are separate facets and need not be symmetric.** *Storage shape* (`StorageShape`) drives `put` and the `get` join skeleton; *access shape* (`AccessShape`) drives `get` read-path planning. An nd-tree carries an `access` facet (spatial predicate forms over a coordinate tuple) with a `storage` facet identical in shape to the column stores beside it. The access vocabulary (`AccessForm`) is string-typed with built-in constants (`equality` / `range` / `prefix` / `contains` / `intersects` / `knn`), open by design so vector-similarity / full-text / time-series forms can land without re-litigating the type. A **surrogate vs logical-tuple** shared key is first-class (`SharedKey.kind`) — a coverage fact (is the shared-key column also a logical column?), not a generation policy: a surrogate's value is sourced from the **anchor key column's declared `default`** and engages the per-row evaluate-once-and-thread path, while a logical-tuple key threads the supplied logical PK with no default. One member is the **existence anchor**, named explicitly (`StorageShape.anchorRelationId`) — never reverse-engineered from outer-join structure. A logical table may have at most one `primary-storage` advertisement (which drives write fan-out); the rest are `auxiliary-access` (read-path-only structures the planner chooses among — see *Auxiliary-access read-path routing*).

**Resolution and validation happen at lens-compile time**, before body compilation. The resolver collects advertisements from every module owning a basis table, filters to the logical table, selects the single primary, and validates structural coherence — the anchor is a member; every member relation, mapped basis column, pivot column, and shared-key column exists; a surrogate key's anchor column declares a `default` (the engine generates nothing of its own) and all members share its arity, while a logical-tuple key's per-member arity matches the logical PK; every logical column is backed by exactly one member, an EAV pivot, or a name-match. A malformed advertisement aborts the deploy **atomically**, before any catalog mutation.

The default mapper then **consumes** the resolved primary to synthesize the n-way **`get`** body: a left-deep equi-join rooted at the existence anchor (anchor first), mandatory members inner-joined, optional members outer-joined, and EAV pivot members projected as correlated scalar subqueries rather than joined. Every stitch-key correlation — each join ON pair and the EAV subquery's entity conjunct — is **NULL-safe per key column** when *both* sides declare the column nullable (`member.k = anchor.k or (member.k is null and anchor.k is null)`; NULL is a self-equal key value, [schema.md § Primary-key nullability](schema.md)), and stays a plain `=` otherwise, so a NOT NULL stitch key keeps the equi-join shape the optimizer extracts pairs from. An EAV column's subquery matches the pivot's attribute column against the **logical column name as a literal**, compared by value equality — so the basis triples must spell the attribute exactly as the logical column is declared, including case; the protocol does not case-fold attribute literals.

#### The existence-anchor inclusion-dependency contract

The `id` a module (or the tag builder) mints **is** the existence anchor's `relationId`, and it must be stable and unique within the basis schema. That id is the `relationId` the lens compiler passes to `InclusionDependency` (`IndTarget.kind: 'relation'`) when it injects one inclusion dependency per mandatory member onto the anchor, recorded on the slot for the prover. The fact is threaded **via the slot**, not seeded at the member scan: the prover plans the compiled body *before* the slot is committed (atomic compile-first deploy), so a scan-time seed would never reach it, and the surrogate join carries no declared SQL FK to recognize. Only **mandatory** members are injected (direction `anchor.key ⊆ member.key`, `nullRejecting: false`, total existence); optional members (outer-joined, their absence preserved), EAV pivots (never inner-joined), and the empty-key singleton inject nothing, since any of those would over-claim.

#### The `put` fan-out

A decomposition body routes off the generic two-table join path to an advertisement-driven member fan-out — the generic path would be unsound for a decomposition (it picks a single delete side, caps at two members, and rejects the outer joins optional members ride). The fan-out's **backward decisions** — column→member routing and the anchor-resolvable predicate gate — are derived from the threaded plan-node update lineage, read through the **shared backward-walk consumer** that plans the synthesized `get` body once and routes each output column to its owning base relation. Single-source, multi-source join, and decomposition share this one consumer. The advertisement supplies the member-presence, shared-key, and EAV-pivot metadata that disambiguates the deferred shapes and drives the insert envelope.

- **DELETE** fans out to every member (mandatory, optional, EAV pivot). Members are ordered **anchor-last**, and each non-anchor member's identifying set is read from the **anchor alone** (`… where memberKey in (select anchorKey from anchor where <pred>)`), never the full join — so an earlier member's delete can never shrink a later member's identifying set. When **both** stitch columns are declared nullable, that identifying correlation is instead the NULL-safe correlated `exists (select 1 from <anchor> where [<pred> and] (<anchorKey> = __vm_self.<memberKey> or (<anchorKey> is null and __vm_self.<memberKey> is null)))` with the emitted statement's target aliased `__vm_self` — `NULL in (…)` is UNKNOWN, so the IN shape would strand a NULL-keyed component as an orphan (and let a NULL-keyed member UPDATE silently miss); a stitch key NOT NULL on either side keeps the byte-identical IN form. The same gate governs every member UPDATE's identifying correlation and the EAV entity correlation. A no-`WHERE` delete is an unconditional `delete from <member>` per member (also the sound singleton path). An EAV pivot's delete removes every triple for the matched entity.
- **UPDATE** routes each assignment to the member backing it, keyed off the anchor the same anchor-last way. A **mandatory, non-EAV** member takes one base UPDATE. An **optional** columnar member's write is a per-row materialization transition realized as ordinary anchor-keyed base ops: **matched** rows (the component exists) take the base UPDATE; **absent** rows take a null-extended INSERT (`insert into <member> (<memberKey>, <cols…>) select <anchorKey>, <values…> from <anchor> where <pred> on conflict (<memberKey>) do nothing` — the anchor key threads the member key, the `do nothing` cedes the matched rows to the UPDATE); and when **every** value column of the member is assigned null the component row is emptied → a base DELETE instead (a partial null leaves a row, an update not a delete) — a lens row-local CHECK still fires on this lowering: the deferred logical-row re-read rides the member DELETE `OLD`-correlated, so "empty the cell" cannot slip past a rule the logical schema declares about it (see *Constraint Attachment*). An **EAV pivot** member's write is the per-attribute triple analogue: a non-null value upserts the `(entity, attr, value)` triple, a null deletes that attribute's triple. The assigned **value shape** decides how the matched and materialize branches are realized, with three self-contained shapes admitted (no new runtime substrate): a **constant** (or null) value takes the matched UPDATE + `do nothing` materialize INSERT (EAV: same, keyed on `(entity, attr)`); an **anchor-resolvable** value — every leaf lowers to an anchor base column (`set c = a + 1`, or a computed-anchor mapping `set c = bumped + 1` → `(a + 1) + 1`) — *collapses both branches into one* `… on conflict (<memberKey>) do update set c = excluded.c` upsert (EAV: `on conflict (<entity>, <attr>) do update set <val> = excluded.<val>`), so the value is computed once over the anchor scan and the matched rows read the identical proposed-insert value via `excluded.<col>` (the round-trip oracle holds by construction); a **member self-reference** (`set c = c + 1`, `set c = coalesce(c, 0) + 1`, columnar only) keeps the matched UPDATE for present rows (their real prior value, owner qualifier stripped) **and** adds a materialize INSERT for absent rows that projects the self-expression with the owner's own columns substituted to NULL — an absent row's prior value is null — gated by a runtime non-empty filter (`… where <pred> and (<v1> is not null or …)`) so a **null-propagating** expression (`c + 1` → null) materializes no phantom row while one that maps null → non-null (`coalesce(c, 0) + 1`) does. The two materialize **soundness gates** (an unassigned non-null/defaulted value column would widen the absent row's image; a NOT-NULL-no-default base column no value covers cannot be created) fire **only when the materialize is statically live**: when that null-substituted non-empty filter folds **constant-false** at plan time (a null-propagating self with no non-null constant sibling — `set c = c + 1`), no absent row can ever materialize, so the materialize INSERT *and both its gates* are skipped entirely — the update degrades to present-rows-only and never trips the widen gate (recovering the pre-materialize self-path; a null→non-null self, or a non-foldable / parameterized / **non-deterministic** value the planner cannot prove dead, still emits the INSERT and runs the gates — a volatile leaf such as `random()` or a non-deterministic UDF short-circuits the dead-check to "live", since a single plan-time fold is an unsound proxy for the per-row runtime filter). The two ops stay distinct (they *cannot* collapse into an upsert: the matched value is computed over the member scan, the materialize value over the null-substituted anchor scan — they disagree row-for-row by construction), with the matched UPDATE running first and `on conflict (<memberKey>) do nothing` ceding present rows to it. An **arbitrary** optional-**columnar** value — anything else: a subquery, a cross-member column, or a value mixing anchor and self leaves (`set c = b + 1`, `set c = c + a`, `set c = (select max(v) from …)`) — rides the **single-identity (anchor-key) per-row capture**, the decomposition dual of the multi-source cross-source `set a.x = b.y` path. Every affected row's value is materialized **once** before any base op fires, as plan nodes over the **already-planned get body** (`Project_{k0_0, srcN…}(Filter_{anchorPred}(anchor ⋈ members))`), into the shared `__vmupd_keys` substrate: one identity column `k0_0` (the anchor key — a decomposition's identity is a single column, every member keyed 1:1 to it by the stitch key) plus one `srcN` per captured value. Because the body **null-extends** an absent optional member, the captured value already encodes per-row presence (`c = b + 1` captures `b + 1` for an absent row, `c = c + a` captures `null + a` = null). The matched UPDATE reads each value back correlated by the **member** key (`set c = (select srcN from __vmupd_keys k where k.k0_0 = <memberKey>)`), the filtered materialize INSERT by the **anchor** key, gated on a **runtime** non-null OR-chain (`… and (<srcN-by-anchorKey> is not null or …)`) — not the `self` path's plan-time fold, since a captured value is data-dependent — so an absent row whose captured value is null springs no phantom row. The two ops cannot collapse into an upsert (the filter must suppress the absent branch without suppressing the matched write), and `on conflict (<memberKey>) do nothing` cedes matched rows to the UPDATE (emitted first). Capturing pre-mutation is what makes a **both-sides** write correct (`set c = b + 1, b = b + 100` reads `c` from the pre-mutation `b`, materialized before the `b` base op rewrites it) and turns a volatile (`set c = random()`) into one value per row shared by both branches. A mixed anchor+self group rides this path too (subsuming the retired same-statement reject). An **arbitrary EAV** value (a subquery, a cross-member column, an anchor+self mix, or any EAV self-reference — an EAV value column projects as a correlated subquery, so a self-reference lowers to a subquery) rides the **same** single-identity capture, per attribute: the captured value substitutes the get-body projection over the anchor scan, the matched UPDATE reads it back by the **entity** column (`update <pivot> set <val> = (select srcN from __vmupd_keys k where k.k0_0 = <entity>) where <attr> = '…' and <entity> in (<anchor subquery>)`) and a non-null-filtered materialize INSERT reads it back by the **anchor** key with `on conflict (<entity>, <attr>) do nothing`. The matched UPDATE is **unfiltered**, so a captured null on a matched triple writes `val = null` (which reads identically to an absent triple through the get-side subquery — a benign physical divergence from the explicit `set p = null` DELETE); the materialize INSERT's runtime non-null filter means a captured null on an absent entity (incrementing an attribute it lacks) materializes no phantom triple. A **shared-key** (identity) write stays rejected.
- **INSERT** fans out one insert per member, **anchor first** (FK-order root), off a shared-surrogate mutation envelope: the user source is materialized once and read back per member, so the shared key is resolved **once per produced row** and threaded into every member's key column(s) via the equivalence class — the evaluate-once-and-thread invariant. A **surrogate** key's value comes from the **anchor key column's declared `default`**, evaluated once per row at the envelope (with [`mutation_ordinal()`](vu-mutation-context.md#mutation-context) in scope, and any `max()` subquery observing pre-mutation state); the engine fabricates nothing. A **logical-tuple** key threads the supplied logical PK straight through, with no default. **Optional** members materialize a row only for the rows that supply ≥1 of their columns (a per-row presence filter — the outer-join absence the read preserves); an **EAV pivot** emits one triple insert per supplied attribute (the attribute literal spelled as the logical column is declared), gated on a non-null value; a **singleton** (`primary key ()`) inserts each member unconditionally over the empty key. `on conflict` composes across the member ops; the statement is atomic (a mid-fan-out failure rolls back). A lens row-local CHECK is evaluated once per produced logical row **at the envelope** (before any member op, seeing every supplied column — so an omitted / explicit-NULL column cannot slip past it by suppressing its member write; see *Constraint Attachment*).

A DELETE/UPDATE `WHERE` is admitted whenever it is **anchor-resolvable** — every logical column it names is either an anchor identity base column *or* a computed mapping whose basis lives on the anchor (`bumped = a + 1` → `a + 1 = 11`; `combined = a || b` → `a || b = '1020'`). Both substitute into a predicate over the anchor's own base columns, which the anchor key subquery already evaluates, so no new substrate is needed. A `WHERE` that references a genuine non-anchor member is deferred (see [Current limitations](#current-limitations)).

**Stitch-key / EAV-conflict-target uniqueness is a deploy-time invariant.** Every columnar member's stitch key, and every EAV pivot's `(entity, attribute)`, must equal a declared PRIMARY KEY or **non-partial** UNIQUE on its basis relation — validated at `apply schema` by `validatePrimaryAdvertisement` (a partial `unique … where` does not qualify: it guarantees uniqueness only within its scope and cannot back an unqualified `on conflict`). This one fact underwrites **both** directions of the lens. On the **get** side it keeps the stitch 1:1 — the columnar equi-join cannot multiply rows and the EAV `(entity, attr)` correlated subquery stays single-valued. On the **put** side it is what makes the materialize partition sound: the matched UPDATE and the `on conflict (<target>) do nothing` materialize INSERT split the affected rows only because the runtime cedes a matched row to the UPDATE on a declared PK/UNIQUE violation — against a non-unique target the INSERT would double-insert the matched rows instead. The anchor's own stitch key is validated too (the logical-PK / surrogate identity must itself be 1:1). A singleton (`primary key ()`) has an empty stitch key — no stitch to validate and no materialize path — so it is skipped, not rejected. Because a non-unique target can no longer deploy, the plan-time materialize builders rely on the invariant rather than re-checking it.

#### Override composition with an advertisement

An explicit `declare lens` override composes with an advertised mapping:

- An override **corrects** an advertised column mapping the same way it corrects a name-match — a covered column wins, a rename caps the boundary; the corrected column's provenance still records the advertised member.
- An uncovered logical column gap-fills from the advertisement's per-column mapping when one is present (richer than name-match), re-qualified to that member's alias in the override's `FROM`, falling back to the FROM name-match when the advertisement does not back it. An uncovered column whose backing member is absent from the override's `FROM` errors precisely (naming the column and the member it would need).
- An override may **not** silently re-anchor or change the shared key: a *sparse* override (one that relies on gap-fill) whose FROM references a basis relation outside the advertised decomposition errors, naming the offending relation and the advertised anchor. The developer must instead author a *full* hand-authored body (covering every column), which then bypasses the advertisement entirely.

#### Auxiliary-access read-path routing

When an outer query's `WHERE` over an inlined lens view matches a form an `auxiliary-access` advertisement serves over an advertised column, the planner routes the read through that structure — an **auxiliary seek ⋈ primary decomposition on the logical key** — instead of scanning the full decomposition and applying the predicate as a residual filter. A zero-cost pass-through marker (`LensAuxiliaryAccessNode`) carries the table's routable auxiliaries to the optimizer rule, which is registered *before* predicate-pushdown so the predicate is still directly above the marker. On a match the rule rewrites the matched predicate's access column from the logical column to the auxiliary's **backing basis column**, pushes it onto a scan of the auxiliary's member relation (so the auxiliary's own module serves it through the existing `supports()` / `getBestAccessPlan` surface — no new module execution path), and **semi-joins** that seek back to the decomposition body on the logical primary key. The semi-join preserves the body's output shape and **consumes** the matched predicate (an advertised form is treated as *exact* — the auxiliary fully answers it).

Two channels feed the form-matcher: **comparison forms** (`equality` / `range`) match a `column op value` conjunct; **function-predicate forms** (`prefix` / `contains` / `intersects` / `knn`, and any open form) match through an **extensible recognizer registry** keyed by form name. That registry is the extensibility contract — a vector-similarity or full-text module lands later by advertising a new form and registering a recognizer with **zero engine change**, and until a recognizer exists the query simply scans (graceful degrade). Every step that cannot proceed emits no rewrite and leaves the scan in place: an unrecognized form, a predicate that does not match a recognizer's shape, an access column that is not a logical output, a matched fragment that references any logical column **other than** its access column (it would dangle once pushed below the semi-join onto the aux scan), or an auxiliary lacking a logical-PK-aligned `storage` shape.

The optimization is **non-regressing by construction**: the pre-existing path was a correct residual-filter scan, and the marker is built only for a logical table with a routable auxiliary, so non-lens and non-routable-lens views are untouched. On a match the auxiliary path is selected (it replaces residual-filter-over-full-scan, so it is beneficial whenever it matches); more than one matching auxiliary resolves deterministically by advertisement `id`. The rule routes one **function-predicate** match per query and defers comparison forms to the primary body's own predicate-pushdown, which already answers them — the auxiliary is load-bearing only for exotic forms a scan-plus-residual-filter cannot push.

## Sparse Overrides

The authoring goal is **override without takeover**: a developer renaming one column of a logical table that maps to an n-way join over columnar basis tables must not be forced to write the join. Two mechanisms make this work.

### The baseline is never authored text

The generated mapping is never written into source. The authored artifact contains **only deviations**, so the source is all signal and no noise — which is precisely why full code-generation fails (it buries the intentional, abnormal mappings in generated noise). The full effective mapping is inspectable on demand ("show effective mapping"), but it is not the thing the developer edits.

### Overrides are merged per-attribute

An override authored as ordinary SQL is consumed as a **sparse patch keyed by attribute**, not as opaque text. At compile time, for each logical table:

1. The override `select` (if any) is parsed to a relational expression.
2. Its output **coverage** is read — which logical columns it covers, and from which basis expressions.
3. For every logical column the override does not cover, the default mapper generates the mapping and composes it in.

So renaming a column and later adding a column compose cleanly: the rename override is untouched, and the new column appears as an uncovered attribute the mapper fills. The result is one effective `select` whose projection is exactly the logical columns, in declaration order.

Most overrides cap the generated body at the boundary (rename = projection-with-alias, compute = extend, filter = restrict) and never touch the join interior. A change that *must* reach inside the join (a column now originating from a different basis table) is genuinely structural, cannot reduce to a boundary cap, and therefore correctly costs more authoring and surfaces as signal.

#### Coverage is name-based and re-read from source

The eventual mechanism addresses coverage by **stable attribute ID** on the plan tree (riding the existing [attribute-provenance](optimizer.md#attribute-provenance) system), which is what the prover needs anyway. Today the merger composes at the AST level and reconciles the same two properties more cheaply:

- **Coverage is read by name.** A logical column is *covered* when the override's output column name (the `as` alias, e.g. `speed as maxSpeed`, or a bare column name, or a `*`-expansion of a FROM source) matches the logical column name (case-insensitive). Everything else is gap-filled.
- **Survival across baseline regeneration comes from re-reading the override AST from source on every deploy.** The stored override is never rewritten, so the *rename-then-add* example composes: the rename override is untouched and the freshly-added logical column is simply uncovered → gap-filled. This re-read-from-source is the load-bearing assumption of the merger; it stands in for the attribute-ID property.

#### What "covered" means

An override projection is a **sparse patch, not an exhaustive column list.** Writing `select id, who` does not say "the view has only these two columns" — it says "`id` and `who` are *covered* by this override; every other logical column is gap-filled." **Omission is not exclusion:** an unmentioned logical column is gap-filled, not dropped — and if the basis cannot back it, that is a coverage error (every logical column must map to basis). Coverage is decided **entirely by a projection term's output name**, never by what the term computes:

```sql
-- The design. `label` is derived; `id`, `who`, `ip` are ordinary columns.
declare logical schema X {
  table Audit (id int primary key, who text, ip text, label text);
}

declare lens for X over Y {           -- basis Y.AuditLog has columns id, who, ip
  view Audit as
    select
      id,                   -- covered, identity  → writable
      who,                  -- covered, identity  → writable
      upper(who) as label   -- covered, computed  → read-only
    from Y.AuditLog;
  -- `ip` is unmentioned → gap-filled from Y.AuditLog.ip by name (it is NOT dropped)
}
```

Here every logical column is either *covered* (`id`, `who`, `label`) or *gap-filled* (`ip`). The points:

- **The alias is the coverage key — the expression's shape is invisible.** `upper(who) as label` covers logical column `label` exactly as a bare `label` would; the merger never looks inside the term to decide coverage, however deeply nested it is. (A computed term therefore *must* be aliased — an unaliased `upper(who)` maps to no logical column and is rejected; see [Body-shape restrictions](#body-shape-restrictions).)
- **Omission is not exclusion — this is the one that surprises.** Leaving `ip` out of the `select` does *not* drop it. `ip` is a logical column the projection does not cover, so the default mapper name-matches it to `Y.AuditLog.ip` and gap-fills it straight back in. Every logical column must end up mapped: if the basis cannot back an omitted column, the compile fails with a coverage error rather than silently dropping it (see [Gap-fill fidelity boundary](#gap-fill-fidelity-boundary)).
- **A computed mapping is always authored, never gap-filled.** Gap-fill only name-matches (or follows a module advertisement); it never synthesizes an expression. So `label`'s `upper(who)` mapping has to be written out — the mapper cannot guess it — which is why a computed column is "signal" rather than something generated. (A *derived* column like `label` is still a legitimate part of the design: consumers read it, it simply isn't stored.)
- **Writability of a covered column follows scalar-invertibility, composed over the nest.** A bare/renamed column, or an invertible expression composed of invertible steps (`(speed + 1) - 2 as adjusted` — each `±k` step inverts, so the nest does), stays writable — a write runs the inverse — while any opaque step (`upper`, `substr`, a hash, or `* 2` — the registry inverts only `±k`, not `*`) makes the column read-only and a write raises `no-inverse` (see [Computed and Generated Columns](#computed-and-generated-columns)). So `label` is read-only.

`quereus_effective_lens('x', 'Audit')` reports the resolved disposition of every logical column — `override` or `default` — so the covered-vs-gap-filled split is inspectable without guessing.

#### Body-shape restrictions

The merger composes one effective body by replacing **only the top SELECT's projection** with the composed logical-column list (covered ⊕ gap-fill). Body shapes that this single-projection rewrite cannot soundly compose are rejected at deploy/parse time rather than silently mis-mapped:

- **The body must be a single `SELECT`.** Compound set-operations (`union` / `union all` / `intersect` / `except`) and `values (...)` bodies are rejected at parse time — the merger would compose only the top leg and keep the rest verbatim.
- **A computed projection term must be aliased.** An unaliased non-column term (e.g. `select id, speed * 2 from …`) maps to no logical column; it is rejected (naming the term) rather than dropped and gap-filled.
- **Every `FROM` source must name the declared basis, or a CTE of the same body.** Two ways an override could escape its `over Y` basis, both rejected at deploy naming the relation:
  - *Qualified with another schema* — `from Z.Foo` would bind in `Z`, re-anchoring the body off its basis.
  - *Bare and absent from the basis* — nothing pins it, so it would fall through to the **default schema path** at read time and bind `main`'s same-named relation: the same re-anchor, minus the qualifier that would have made it visible.

  Fine: a bare basis relation, one qualified with the basis name, a CTE reference, and cross-table joins *within* the basis. A basis **view** counts as a basis relation here (it is still not introspectable — see the gap-fill boundary below). Function (TVF) sources resolve through the function registry, not the schema path, so they are out of scope. The check walks the **whole body** reflectively, so an escaping source buried in a subquery source, a `with` CTE body, a compound leg, a function-source argument, or a scalar/`where`/`in`/`exists` subquery is rejected too — not only top-level sources.
- **The compiled body stores the basis qualifier the compiler resolved.** "Unqualified defaults to the basis" is a rule about the *authored* text: the effective body the engine stores rewrites each bare basis source to `<basis>.<relation>` explicitly — the same fully-qualified form the synthesized default-mapper and decomposition bodies emit. Otherwise nothing in the stored body would record which schema a bare name meant, and each consumer would re-resolve it its own way (the read path plans under the *logical* schema's home path; the prover and `explain` round-trip through SQL text with no schema path at all), so a bare source over a non-`main` basis would fail to resolve or bind a same-named default-path table. Qualifying once at compile time makes every consumer agree by construction — including `resolveSlotBasisSource`, which therefore reads the stored qualifier and never re-defaults a bare name. Visible consequence: `quereus_effective_lens`'s `effective_sql` shows the basis qualifier even where the author wrote a bare name. The authored `declare lens` text is untouched and still round-trips as written.
- **A CTE shadows a same-named basis relation, everywhere in the body.** A name a `with` CTE declares is the CTE: it is neither basis-qualified nor collected as a basis source, so `*` expansion and gap-fill cannot draw columns from the shadowed basis table. An uncovered logical column only that table could have backed is an uncovered-column error at deploy, rather than a body that deploys and fails at read. The shadow set is *flat over the whole body*, not per-scope — a name used as a CTE anywhere disables basis resolution for it in every scope of that body. That over-shadows a body meaning the basis relation in one scope and a CTE in another: such a source is left bare and exempted from the basis check above, so it reports the ordinary unresolved-relation error at read time rather than binding the wrong relation.

#### Gap-fill fidelity boundary

Gap-fill resolves an uncovered logical column against the basis tables in the override's `FROM`. When it cannot, it errors rather than guess:

- **Single-source override, basis lacks the column** — the compile errors naming the column. Every logical column must map to basis, so an uncovered column the basis cannot back is a hard error: cover it explicitly, or it should not be a logical column of this design.
- **Partial cross-basis join, the gap needs another source** — a full-coverage cross-basis join is fine (gap-fill is a no-op and the body is used verbatim), but a join that covers only *some* columns where an uncovered column is *not reachable from the override's `FROM`* errors rather than emit an unsound body. Reaching a column that lives in a different basis source the single-source mapper cannot join in is genuinely structural — it is the decomposition's concern.

### `quereus_effective_lens(schema, table)`

The composed effective mapping is inspectable on demand (not editable text — see [the baseline is never authored text](#the-baseline-is-never-authored-text)). The integrated TVF resolves the lens slot for a logical `(schema, table)` and yields one row per logical column, in declaration order:

| column | meaning |
|---|---|
| `logical_column` | logical column name |
| `source` | `'override'` (covered by the override) · `'default'` (gap-filled by the default mapper) |
| `inverse` | `'authored'` (a `with inverse` clause supplies the put) · `'inferred'` (registry invertibility / identity / passthrough) · `'none'` (computed, read-only) |
| `advertised_member` | when a resolved primary-storage advertisement backs this column, the member `relationId` that backs it (the existence anchor for an EAV pivot); `NULL` for name-match / override-only provenance |
| `advertisement_anchor` | the resolved decomposition's existence-anchor `relationId` (= advertisement id), or `NULL` when no advertisement backs this logical table |
| `effective_sql` | the composed effective body SQL (repeated on every row) |

## Constraint Attachment

**The gist:** the rules you declared on the logical table — `not null`, `check`, `unique`, foreign keys — are real, and the lens is what enforces them when you write through it. A plain view can't do this: its `where` filters what you *read* but constrains nothing on write. So the lens carries each declared rule down to the storage write and enforces it there. Each rule is classified at deploy into *how* it is enforced (cheaply per-row, or by a lookup, or at commit), detailed below.

A view predicate is a read-time filter, not a write-time invariant ([view-updateability § Interaction with Constraints](view-updateability.md#interaction-with-constraints)). The lens layer is therefore where the logical spec's constraints become **real constraints on the compiled view**, attached explicitly from the logical declaration rather than inferred from the body.

The governing principle: **a constraint is a logical claim, and the structure that enforces it is an optional physical optimization.** A logical `unique(x, y)` contributes a key/FD to the optimizer and an enforced boundary constraint — but it does **not** auto-create an index (a deliberate departure from the legacy behavior where `unique(...)` eagerly built a secondary BTree at declaration time). In the layered model the two are separated: the constraint is logical; any covering index is an explicit, independent **basis-layer** materialized view. With no such structure the constraint is still correct — enforced by a commit-time scan — just not O(log n). Whether to add the covering index is a physical-tuning decision made against the basis, never a side effect of the logical declaration.

### Enforcement by constraint class

Enforcement splits by class, with each constraint classified at deploy into an enforcement obligation recorded on the lens slot:

- **Row-local (`not null`, `check`)** — evaluable on the projected row being written, so a non-materialized lens enforces them for free at the write boundary. A logical `check` is rewritten from logical→basis column terms and merged into the basis write's per-row constraint check, so it fires on every insert/update through the lens even when the basis carries no such check. An undefaulted `not null` is collected as its own obligation, realized on the same seams as a synthesized `<col> is not null` but reported as `NOT NULL constraint failed: <table>.<col>`; a non-nullable derived output classifies it `proved` (the basis write already rejects), so only a nullable-derived (grandfathered-basis) column pays enforcement, and a computed-lineage column with no inverse reds `lens.unrealizable-constraint` like the CHECK class. An obligation kind the rewrite does not recognize refuses the write loudly, never skips. The rewrite is **scope-aware** (`rewriteToBasisTerms`): a top-level write-row column *and* a write-row column **correlated from inside a subquery** are both rewritten to their basis spelling, qualified `NEW.<basis>` (so a CHECK like `exists (select 1 from Allowed where Allowed.name = docKey)`, `docKey`→`doc_key`, builds as `… = NEW.doc_key` instead of crashing on a column the basis row lacks), while a **subquery-local** ref (one a nested FROM introduces) and a **foreign** ref (`Allowed.name`) are left untouched. The `NEW.` qualifier is load-bearing inside a subquery: a bare basis column there could be captured by a same-named subquery-FROM column (innermost SQL scoping), silently changing the CHECK's meaning when a renamed column's basis spelling collides with a subquery source. On a **multi-member decomposition** the write-row qualifier is not bare `NEW` but a **per-member synthetic correlation** (`__lens_new__<schema>__<table>`, the decomposition analogue of `NEW`) keyed by the basis member that owns each referenced column — so two members backing *different* logical columns with the *same* basis-column name (`id`, `name` → `val` on `w_id`, `w_name`) rewrite to **distinct** terms instead of collapsing to one ambiguous `NEW.val`. The per-op constraint scope registers `<corr>.<col>` for the op's own member relation, so a single-member CHECK resolves on its owning op while a cross-member term fails to resolve (a loud `Column not found`, never a silent wrong answer); the synthetic prefix is collision-proof for the same reason `NEW` is — it cannot be shadow-captured by a subquery FROM, which is why the bare basis table name could **not** be used here. A CHECK referencing an [authored-inverse](#computed-and-generated-columns) column stays row-local too: the rewrite substitutes the column's **forward `get` expression** (`NEW.`-qualified basis terms) for the ref, so the CHECK evaluates over the written basis row's logical image — accepted at deploy exactly when that substitution is possible (a subquery-free forward on a **single-source** body; a multi-source forward may read a column of a different member than the put writes, where the substituted ref would evaluate NULL on the write row and the CHECK would pass vacuously instead of enforcing — so it reds `lens.unrealizable-constraint` rather than deploying un-enforced), keeping the prover's realizability verdict and the write-time rewrite in lockstep. This is the common case; most mappings need nothing extra.

  **The seam is spine-dependent.** The routed basis-term form above is the **single-source** seam, and the multi-source join seam on UPDATE/DELETE: those base ops always carry every basis column of their write row, so an explicit-NULL or omitted-column write still produces the row and the check sees the NULL. (Multi-source INSERT carries nothing at all — `buildMultiSourceInsert` passes an empty extra-constraint list; pre-existing, tracked as `bug-join-backed-logical-table-enforces-no-rules-on-insert` on the lamina board.) A **decomposition** write cannot use it: a member op may legitimately not happen for a NULL value (a presence gate suppresses the optional member's insert, an all-null assignment lowers to a member DELETE, an omitted column plans no op), so a member-riding check was skipped exactly when the value was empty. Decomposition writes evaluate a row-local CHECK **once per logical row, on the logical row image** (`view-mutation-builder.ts` / `lens-enforcement.ts`, pinned by `test/lens-row-local-null-write.spec.ts`), on one of two seams:

  - **INSERT, subquery-free check** — at the shared mutation envelope, which *is* the produced logical row (an unsupplied column reads as its declared logical default, else NULL). Row time, before any member op, honoring the statement's conflict clause (`or ignore` skips the whole logical row).
  - **UPDATE, and the subquery-bearing INSERT checks** (which ride the always-planned anchor op) — a **deferred logical-row re-read**, ONE grouped probe per distinct `(target relation, op shape)` of the fan-out covering EVERY row-local rule: `(select min(case when not (<rule 1 over _lr.*>) then '<rule 1 message>' … else null end) from <logicalView> as _lr where <row address>)`, with the op-appropriate correlation (`NEW` on insert/update-shaped ops, `OLD` on the member DELETE the all-null lowering emits), evaluated at commit against the post-write image. The constraint is **message-valued** (`RowConstraintSchema.messageValued`): it evaluates to NULL when every rule holds and to a violated rule's verbatim message otherwise — the runtime fails iff the value is non-NULL and reports the value as-is, so one planned subquery decides all the rules while keeping exact per-rule attribution (`CHECK constraint failed: lens:<name>` for an authored check, `NOT NULL constraint failed: <table>.<col>` for a synthesized not-null rule). Per-rule NULL semantics are preserved: a NULL rule leaves its `when not (<rule>)` branch untaken and passes, per SQL's NULL-passes-a-CHECK convention. The read is **aggregated (`min`), not a bare scalar read**: the row address is a logical-key equality, and a key-changing write can transiently address more than one logical row — exactly the duplicate the commit-time set-level scan (`lens:pk` / `lens:unique`) exists to reject. A bare read of that selection would error `Scalar subquery returned more than one row` and preempt the uniqueness rejection with a cardinality message; `min` collapses the group while keeping the verdict's semantics (NULLs skipped, so a passing row never masks a violating one; NULL for the empty group, the address-matched-nothing pass). Plan-construction cost is therefore proportional to the member relations the write touches and **independent of the rule count** — the collapse that fixed the measured one-probe-per-rule-per-relation cost on tables where every undefaulted `not null` column contributes a rule.

  The **row address** is the shared key when it is a logical column, else a **member-hop** reconstructing each logical PK column through the single-key mandatory member owning it (`_lr.<pk> = (select __lra.<pkBasis> from <member> __lra where __lra.<key> = <CORR>.<memberKey>)`) for a hidden surrogate. Every leg of the address is **NULL-safe** (`… or (both is null)`) when the logical key column it addresses by is declared nullable, and a plain `=` otherwise: NULL is a self-equal key value, so a plain `=` would address no row for a NULL-keyed write and the `min` over the empty group would read NULL — silently passing every row-local rule on exactly that row. The member-hop covers a compound PK spread across per-column member stores; an optional-member PK column refuses (its hop could be legitimately empty and would pass vacuously). A decomposition offering neither **refuses the write loudly** (`lens-row-local-unenforceable`) rather than skipping the check — as does an INSERT combining the deferred seam with a non-ABORT conflict clause, since `runtime/row-constraints.ts` then forces the constraint to row time, where the logical image does not yet contain the written row and the re-read would trivially pass (the posture `rejectLensSetLevelConflictResolution` takes for the other commit-time class). A check rides exactly one seam per write path, so nothing double-fires. Deliberate boundary: an UPDATE row no fan-out op touches (an absent optional member assigned NULL — already NULL, image unchanged) is not re-checked; the write introduced no new violation, matching the read-side grandfathering contract.

- **Set-level (`unique`, primary key)** — enforced by an existence lookup: "does a row with this key already exist?" Two regimes:
  - **Row-time** when a basis covering structure (a materialized index) answers the key: the lookup is O(log n), consistent at the moment of write, and conflict-resolution-capable (`insert or replace` / `or ignore`). This is *not* a new lens code path. The prover classifies the key row-time **only when** a matching basis `UNIQUE` plus a non-stale covering materialized view exists; the single-source re-plan reaches that basis UC in basis terms, and the basis UC's [physical enforcement-through-covering-MV path](mv-constraints.md#enforcement-through-a-covering-mv) does the lookup and honors the conflict action — statement-level `OR` first, else the basis UC's own declared action, else `ABORT`. The classification **inherits the covering-MV [collation eligibility gate](mv-constraints.md#enforcement-through-a-covering-mv)**: `findBasisCovering` consults the same `_findRowTimeCoveringStructure` resolver, so a finer/incomparable **index-derived** basis UC (e.g. a coarser NOCASE index over a BINARY column) whose covering MV is declined classifies **commit-time**, not row-time. Correctness is unaffected — the basis UC's own physical per-scan enforcement still fires under the index collation; only the O(log n) row-time fast path is forgone for that exotic shape.
  - **Commit-time, detection-only** when no covering structure answers the key: the lens routes a deferred `(select count(*) from <logicalView> as _u where _u.lk = NEW.bk …) <= 1` CHECK. The contained scalar subquery auto-defers it to commit, where the logical view reflects the post-mutation basis, so the new row sees count `1` (unique) or `≥ 2` (duplicate ⇒ ABORT). NULL-distinct falls out for free — `_u.lk = NEW.bk` is `NULL`, never counted, when either side is NULL. Because a commit-time scan can only ABORT, `insert or replace` / `or ignore` / upsert against a commit-time key is rejected up front with a clear diagnostic rather than silently ABORTing at commit.

  A set-level key short-circuits to **`proved`** (zero runtime enforcement, contributing the unconditional `key → others` FD) when it is intrinsically unique — either the body's effective key already guarantees it (`proveEffectiveKeyUnique`), or **bijection transport** applies: every key column is a NOT-NULL bare invertible projection or a proven-bijective [authored inverse](#computed-and-generated-columns) whose single put-target basis column, together with the others, exactly forms a declared basis key (the basis PK or a non-partial basis UNIQUE). A bijection is injective, so distinct logical keys map to distinct basis keys the basis key forbids colliding — the logical key is unique with no covering MV required (this subsumes the basis-UNIQUE case). Absent a declared basis key over the put targets, or for a nullable / non-injective key, it falls to the row-time/commit-time regimes above.

  A logical key's own constraint-level conflict action is honored on **none** of the key paths whenever a *basis key* stands behind the logical key — the only thing that resolves a duplicate. This is the rule across all three: the **row-time** path resolves the action from the basis UC; the **commit-time** scan can only ABORT; and a **`proved`** key (transport, *or* a body proof that rests on a basis key) is enforced by a *governing* basis key, whose own action governs the write-through. In every case the logical key's `defaultConflict` is never consulted, so a key declaring `on conflict replace` / `ignore` a governing basis key does not itself carry is rejected at `apply schema` with `lens.unenforceable-conflict-action`, steering the developer to either declare the matching action on the basis UNIQUE/PK (which then honors it for free) or drop the logical conflict action. (`on conflict abort` / `fail` / `rollback`, and no declared action, are always fine — they ABORT.)

    For a `proved` key the **governing** basis key is identified independently of the transport proof's exact-match/single-source gate (`rejectBasisGovernedConflictActionForProvedKey`), since a body proof can rest on a basis key the bijection-transport proof cannot recognize. **Single-source:** the governing keys are every declared basis key whose column set is a **subset** of the logical key's mapped basis columns (`findGoverningBasisKeys`). Subset, not equality, is the correct test — a logical key whose columns ⊇ a smaller basis key K is, for any two rows equal on the full logical key, also equal on K, so K fires on *every* logical-key write-through duplicate. This covers the case the exact-match transport proof misses: a logical key that is a strict **superkey** of a smaller basis key (e.g. logical `unique(a, b)` over a basis NOT-NULL `unique(a)`) is body-proved but has no exact transport match, yet the basis `unique(a)` still governs every `(a, b)` duplicate. The check rejects the moment *any* governing key carries a different action (when several subset keys disagree, the basis enforcement order that decides which fires first is not soundly pinnable at deploy, so it rejects conservatively); when all governing keys carry the matching action, it deploys clean. A `proved` key whose mapped columns subsume **no** declared basis key is genuinely basis-keyless (a `select distinct` projection, an FD-closure key, etc.) — its `on conflict` is vacuous and deploys clean. **Multi-source:** the body has no single basis source, so the 1:1 logical→basis column mapping the subset search needs does not exist and the superkey argument does not transfer across the decomposition; governance cannot be pinned, so a multi-source `proved` key declaring `replace` / `ignore` is rejected conservatively (over-rejecting the niche genuinely-basis-keyless multi-source shape, with the same remediation). The strictly-more-restrictive-basis superkey shape (logical `unique(a, b)` over basis NOT-NULL `unique(a)`) is *over*-enforced, not unenforceable — a separate **over-enforcement** concern surfaced from the same `proved` branch as the acknowledgeable warning **`lens.over-restrictive-basis-key`** (`warnOverRestrictiveBasisKey`), not this conflict-action error. The logical key body-proves unique and deploys cleanly, but the basis enforces uniqueness on a *subset* of its columns, so it rejects two rows differing only in `b` that the logical schema advertises as valid. It fires when a governing basis key is a **strict** subset of the logical key's mapped basis columns (the exact-match case is fully realizable and never warns); it is a warning, not an error, because the schema is sound — every logical invariant still holds, the basis is merely stricter than declared (widen the basis key to match, or narrow the logical key, to make the contract faithful). This needs a NOT-NULL basis sub-key to reach the `proved` branch at all — a nullable basis `unique(a)` is NULL-skipping, contributes only a guarded FD, and so classifies row-time/commit-time rather than `proved`, never reaching this check (a documented gap, as is the multi-source case where no 1:1 basis-column mapping exists). See the [coverage checklist](lens-prover.md#coverage-checklist).

- **Foreign key** — a cross-relation existence invariant, enforced on both sides:
  - **Child-side.** Each logical FK is realized as a deferred synthesized `EXISTS` existence check against the referenced *logical* relation (child columns rewritten to basis terms, parent side in logical terms), gated by the `foreign_keys` pragma and auto-deferred to commit by the contained `EXISTS` — matching physical child-side FK gating and timing by construction. A covering structure is optional: the optimizer pushes the equality predicate into a basis index seek when one answers it and degrades to an O(n) scan otherwise.
  - **Parent-side RESTRICT / NO ACTION** (on DELETE and UPDATE) is the cross-slot dual: a deferred synthesized `NOT EXISTS` over the schema-qualified logical child. The UPDATE form carries a null-safe short-circuit guard (`(OLD.key ≡ NEW.key …) or NOT EXISTS`) so a benign update that does not touch the referenced key is not rejected, while a value→NULL update of a *nullable* referenced key (which orphans a child) falls through to the reject, matching physical RESTRICT.
  - **Parent-side CASCADE / SET NULL / SET DEFAULT** is *write propagation* rather than a plan-time check. A runtime cascade walker — the logical dual of the physical one, fired from the DML executor after each basis row delete/update — reverse-maps the basis parent to the logical parent slot it backs, discovers the referencing logical FKs, and issues the propagating DML against the logical *child view* (`delete from x.child …` / `update x.child set <fkcol> = …`). Issuing against the *view* re-enters the full lens write path, so the child's own checks and any nested logical cascades fire for free. `SET DEFAULT` uses the **logical** child column's default. MATCH SIMPLE (skip a NULL parent value) and the UPDATE short-circuit mirror the physical walker; recursion terminates by data exhaustion, as for the physical SQL-issuing path.

**Parent-side FK** obligations are enforced **single-source-spine only** — a multi-source or decomposition parent (whose `OLD.*` is not one basis row) routes nothing; on INSERT they are not even collected (an insert cannot orphan a child). The **child-side FK / set-level** obligations route through the same `extraConstraints` seam and so reach a decomposition fan-out — both UPDATE *and* INSERT — too, but each is **gated per base op** at the threading site (`buildViewMutation` for the single-source spine and the UPDATE/DELETE fan-out; `buildDecompositionInsert` for the INSERT fan-out — both in `view-mutation-builder.ts`, sharing the one `constraintsForOp` gate): a synthesized constraint rides a base op iff every **write-row** column it references is **owned by that op's target relation** (schema + table, matched case-insensitively) — *relation identity*, not bare column name. So a member insert/update that lacks a referenced basis column is not handed a constraint it cannot build, and — the sharper requirement — a constraint over one member's column is never mis-routed onto a *sibling* member that merely spells a column the same way (two members both naming their value column `val`). The bare-name gate this replaces did exactly that on a name-match per-column decomposition: a deferred set-level `lens:pk` CHECK over the anchor's `val` rode a name-only sibling UPDATE whose own value column was also `val`, and at commit the mis-gated CHECK's count-subquery get-join evaluated against the wrong member's row context and threw `No row context found`, silently losing the update. Relation matching routes it onto the column-owning member alone (or onto none — deferred — when its columns span more than one member). The obligation lands exactly on the member(s) that *can* introduce a violation. Each constraint carries its write-row dependency as **relation-qualified metadata** (`referencedWriteRowRelations`: each basis column tagged with the member relation that owns it), sourced per class from the slot's decomposition advertisement members (or its single basis source for a non-decomposition lens):

- **Row-local CHECK on the decomposition paths** does **not** go through this per-member gate — see the row-local bullet above for the logical-row seam that replaced it. The deferred re-read's only write-row dependency is the riding op's own shared-key column, carried through the same `referencedWriteRowRelations` metadata, so `constraintsForOp` still threads each variant onto exactly the ops targeting its relation. On the single-source spine `collectLensRowLocalConstraints` is unchanged: each referenced logical column is attributed to its owning relation, with the bare `referencedWriteRowColumns` kept for introspection.
- **Child-side FK / set-level** (`collectLensForeignKeyConstraints` / `collectLensSetLevelConstraints`) attribute each `NEW.*` / `OLD.*` child / key write-row column to its owning member relation the same way; **parent-side FK** attributes its `OLD/NEW` referenced columns to the single basis parent (it runs single-source-only). The legacy `writeRowColumns` AST walk survives only as a **fallback** for a constraint whose owning relation could not be resolved (an EAV-pivot / opaque slot) — its bare-name match is ambiguous across same-named sibling columns, but it is reached only when relation attribution is unavailable.

Two consequences follow: a set-level uniqueness CHECK rides only the fan-out op that owns (and can change) the key — a key-unchanged member UPDATE drops it, which is sound since such an update cannot create a duplicate; and a child-FK spanning columns on **more than one** member resolves on no single member op and is therefore **deferred** on a decomposition write, while a single-member-resolvable FK still rides its member and fires. A dropped constraint is traced via a debug `log`. A **row-local CHECK spanning more than one member** — which this gate used to defer the same way — is now **enforced** on the decomposition paths: the logical-row seam (envelope / deferred re-read) sees the whole row image, so the cross-member row-local deferral is closed (pinned by the `lens:xmember` / `lens:xallow` cases in `test/lens-put-fanout.spec.ts`). What was previously documented here as "a timing/perf choice rather than a correctness necessity" is moot for the row-local class — there is no longer a member-riding form to defer.

### The lens boundary is the only place logical constraints apply

A write through the logical view `x.t` bears its full logical FK + CHECK semantics; a write straight to a basis table `y.t` bears **only** the physical (basis-declared) FK + CHECK semantics, even when a logical FK over the same columns exists on the lens. This one rule holds across all three enforced-boundary classes, on whichever write path each uses — the row-local check rides the basis write's per-row pipeline attached only on a lens-routed write; the parent-side RESTRICT `NOT EXISTS` and runtime pre-check are lens-path-scoped; the cascade walker and divergent-action suppression are gated by a `lensRouted` marker on the write. A basis-direct write is therefore never subject to the lens cascade walker, the lens RESTRICT pre-check, or the divergent-action suppression.

### Double-enforcement and redundancy elision

By default the lens **double-enforces** — the lens-level check is synthesized even when the basis carries the equivalent constraint. This is always sound: the re-planned basis write's own check fires too. The redundant lens check is **elided when provably redundant**, and any uncertainty defaults to double-enforce.

Child-side FK elision requires all three of: (1) a single-source, value-preserving child mapping — every logical FK child column maps with no transform to a plain basis child column; (2) the basis child carries an FK whose **unordered** `(child col → parent col)` index pair-set equals the mapped one and references the same basis parent; and (3) the referenced logical parent's lens slot is a faithful, **non-row-reducing** projection of that basis parent (a single `from` with none of `where` / `group by` / `having` / `distinct` / `limit` / `offset` / compound / CTE; `order by` is row-preserving and ignored). Parent-side elision shares this structural core read from the child direction, **plus** an action-match gate the child side does not need: the basis parent-side check only fires for a `restrict` basis FK, so the basis write subsumes the lens RESTRICT only when **every** matching basis FK is `restrict` for the op. Redundancy is decided against the *current* basis FK set at write-plan time, so the elision is exactly as sound as the physical check it defers to.

### Divergent basis-vs-lens actions: the logical action wins

When a basis FK and a logical FK over the same equivalent columns declare **different** parent-side actions (e.g. a basis `on delete cascade` under a logical `on delete set null`), the **logical action wins**. The cascade walker elides only on an *agreeing* basis action; a divergent non-RESTRICT logical action suppresses the basis FK's physical action / RESTRICT check at three sites — the cascade walker, the runtime RESTRICT pre-checks, and the plan-time parent-side check builder — so the logical action runs exactly once.

A retained lens RESTRICT over a *non-restrict* basis FK is the mirror case: it cannot be enforced by the deferred commit-time `NOT EXISTS` (which would observe the **post-cascade** child state, after the basis action already mutated the children, and so always pass). It is enforced instead by a runtime **pre-check** fired BEFORE the basis op, so it observes the **pre-cascade** child state and ABORTs the parent delete / key-update. The pre-check rides the same transitive-RESTRICT walk the physical scan uses, so a basis cascade landing on a deeper basis-backed logical parent is covered within one transitive walk.

### FD contribution to the optimizer

A declared logical key (PK / `unique`) that holds at the lens boundary is also a *fact the optimizer can use* on the **read** path — for DISTINCT elimination, join elimination, and ORDER-BY trailing-key pruning. FDs intrinsic to the compiled body already flow through ordinary view-inlining and per-node FD propagation; what does **not** flow is the declared key the body alone cannot prove — the one that holds only because the lens *enforces* it (row-time, via a covering structure), or a `proved` / `vacuous` key whose guarantee per-node propagation loses in the inlining context.

The soundly-contributable obligations are turned into physical FDs that a unary pass-through marker — `AssertedKeysNode`, wired around the inlined view's projection — merges onto the boundary's FD set. The node carries no rows: it preserves column shape and attribute IDs and emits its source directly (zero runtime cost, like `AliasNode`).

Soundness is gated by the obligation **kind** — a false key FD is a *correctness* defect (it can make DISTINCT / join-elimination / order-by-pruning drop real rows), so the gate under-claims like every other FD-propagation rule:

| Obligation | Contributed FD | Why sound |
|---|---|---|
| `proved` | unconditional `key → others` | The body intrinsically guarantees it (redundant-but-harmless when local propagation already surfaces it, load-bearing when the inlining context loses it). |
| `vacuous` | `∅ → all_cols` (≤1-row) | The empty (singleton) key trivially holds. |
| `enforced-set-level` row-time | **guarded** `key → others [guard: key IS NOT NULL]` | A covering structure enforces uniqueness per row-write — but only over the **non-null** tuples a plain (NULL-skipping) `unique` governs, so the key is *conditionally* unique. The guard activates only under a surrounding predicate that entails it, the same shape a partial `UNIQUE` emits. (A NOT-NULL key answered by a basis UC would have classified `proved`, so a row-time obligation is always over a nullable key.) |
| `enforced-set-level` commit-time | **none** | Detection-only at commit; a duplicate can transiently exist mid-statement (reads-own-writes / Halloween), so assuming the FD mid-statement is unsound. |
| `enforced-row-local` / `enforced-fk` | **none** | Not uniqueness facts. |

A `row-time` obligation is a deploy-time snapshot of "a non-stale covering MV answers this key." The basis is a *physical* schema whose DDL (e.g. `drop materialized view`) does not re-run the lens prover, so a covering MV can be dropped or go stale out-of-band. The row-time contribution is therefore **re-validated at plan time** against the current catalog: the FD is contributed only when a non-stale row-time covering MV still answers the backing basis UC and that UC is non-partial; otherwise it conservatively downgrades to no FD. `proved` / `vacuous` need no currency check — they are structural facts of the immutable compiled body.

Only a logical schema's lens slot yields any FD; a plain view / MV has none, so the boundary node is inlined only when ≥1 FD is contributed. The contribution is **read-side only** — the write path walks the compiled body over basis tables, where the boundary node never appears.

## Computed and Generated Columns

A logical column need not map to stored basis data — it can be **computed** by the lens `get`. Such a column has `computed` lineage ([view-updateability § The Update Site Model](view-updateability.md#the-update-site-model)): reads evaluate the expression, writes are rejected. This is how a generated/derived column is expressed — there is no separate `generated as` construct at the logical layer; a column is generated precisely when its lens body computes it and no `put` inverse exists. A computed column with an invertible body remains writable, by the ordinary scalar-invertibility rules; "generated" is just the non-invertible end of that spectrum.

**Writable intent (`quereus.lens.writable`).** A computed column is read-only *by default*, and the prover admits it as such — it cannot tell a column the author *meant* to be derived from one the author *meant* to be writable but whose body happens to be non-invertible (an authoring mistake silently accepted as read-only). The reserved per-logical-column tag `quereus.lens.writable` supplies the missing intent: `= true` declares the column **must** have a faithful write path, so an opaque/non-invertible body carrying it becomes a deploy error (`lens.non-invertible`) rather than a silent read-only column; `= false` (explicit read-only intent, documentation only) and *absent* both keep the conservative admit. The signal lives on the logical column's `with tags (...)` and survives schema export/round-trip. An invertible composed body (e.g. `(speed + 1) - 2`) tagged writable deploys writable with no error — the intent is satisfied. (Completeness gap: a writable-intent column whose body is *out of* the single-source projection-and-filter fragment degrades to safe and does **not** deploy-block; it still reds at mutation time — see the [round-trip detection](lens-prover.md#coverage-checklist) callout.)

**Authored inverses (`with inverse`).** When the registry cannot infer an inverse but the author has a chosen one — the canonical case is a non-injective mapping (twenty legacy codes collapsed to three) where a write should store a representative — the inverse is authored inline on the lens body's result column via the core-select [`with inverse (col = expr, …)` clause](vu-inverses.md#authored-inverses-with-inverse). The column upgrades from `computed` (read-only) to writable-with-supplied-put; because the clause is per-result-column, it rides the sparse-override merger like any covered term (gap-filled columns are identity mappings and never need one). An authored inverse satisfies the `quereus.lens.writable = true` intent the same way an inferred one does. PutGet is checked by composition at deploy; GetPut is intentionally surrendered for a non-injective forward (a write-through normalizes) and surfaces as the acknowledgeable `lens.getput-lossy` advisory rather than an error — see the [coverage checklist](lens-prover.md#coverage-checklist).

Two timings look alike but land in different layers, and conflating them is a common error:

- **Standing computed column** — re-evaluated on every read, never stored, tracks its inputs forever. It lives in the lens `get`. `full_name = first || ' ' || last` is standing.
- **One-shot derivation** — evaluated once, at deploy, to populate stored basis data, then maintained as ordinary storage that can diverge from whatever produced it. This is a **backfill** (see [Deployment](#deployment-is-a-compile-step)), not a lens compute. Promoting a standing computed column to stored basis — to index it, or to let it diverge — is exactly a one-shot derivation.

The distinction is the same one that separates a view expression from a materialized derivation: one is recomputed, the other is computed once and stored. The lens `get` expresses the first; the deploy/backfill step expresses the second.

## Deployment Is a Compile Step

Quereus is a query-processing engine, not a deployment system, but it exposes the ingredients an application needs to assemble a complete deployment story. (For the multi-peer dimension — evolving a schema across synced replicas that upgrade at different times — see [Schema Migration in a Synced Database](migration.md), which builds on the deployment ingredients here.) Deploying a logical schema against a basis is a **compile**:

1. **Generate / diff the basis.** The basis is a generated-then-frozen artifact. On each deploy it is diffed against the deployed representation by the declarative-schema differ. Logical evolution produces *additive* basis diffs (new column / table). A column removed from the logical schema does **not** cascade to a basis drop: the mapping detaches and the basis column is retained for later garbage collection. This asymmetry — logical removals never drop basis storage — is what keeps the basis append-mostly and migrations safe.
2. **Compile the lens.** For each logical table, merge the override (if any) with generated gaps into an effective view body over basis.
3. **Register inline.** `Logical.X.T` resolves to that effective body; the query processor sees an ordinary view. The logical spec's constraints are attached at the lens boundary.

The authored source stays sparse (signal only). The *compiled* effective mapping is the inspectable, generated-on-demand artifact (the noise). Because the basis is frozen and the effective lens is recomputed at compile from frozen inputs, the result is deterministic, not a moving target.

### The deployed basis representation

Migrations require a stable record of *what is deployed*, so augmentations can be generated against it and basis invariants verified to be intact. The deployed basis is therefore persisted and **hash-coded** (reusing the schema hasher). A deploy compares the freshly generated basis against the deployed hash, computes the additive diff, and — for data-effecting changes (column adds with backfill, decomposition changes) — emits DDL the application can run with custom backfills, exactly as the declarative-schema pipeline already supports. Schema-only changes (rename) are metadata; data-effecting changes (split / merge / pivot) carry a backfill obligation.

A useful subset of that backfill obligation is **engine-expressible rather than fully delegated**. When the new basis can be populated by running the new lens `get` over the prior basis — a pure re-decomposition such as a split or merge that introduces no information the prior basis lacks — the differ can emit the backfill as generated DDL, the same shape as a one-shot derivation. Only backfills that need data the prior basis does not contain remain the application's to supply. The obligation thus splits cleanly: re-decompositions the engine generates from the lens itself, genuinely new information the application provides.

#### The lens deployment snapshot

The deployed representation is persisted per logical schema as a **lens deployment snapshot** (`LensDeploymentSnapshot`), captured on each successful `apply schema X` and **rotated** (`previous ← current`), so the prior deploy survives exactly one re-apply. The snapshot is the **source of truth** the backfill differ diffs — robust to the lens already pointing at the new basis, because it records the *prior* compiled `get` rather than re-deriving from live catalog timing. Per logical table it holds:

- `getBody` — the compiled `get` body deployed for the table (`prior_lens.get(prior_basis)`), wrapped as the backfill's `from (<prior get>)` subquery;
- `logicalColumns` — the logical columns (declaration order), used to test reconstructibility;
- `relationBacking` — per basis relation, the `(basisColumn → logicalColumn)` pairs it backs, derived from the body's projection **plus shared join-key threading** (a columnar split joins its members on a shared key but projects it once; the other members carry the key column and must be backfilled with it);
- `basisHash` — the schema hash of the basis declared schema at deploy time. This is the migration-safety record: a later deploy or introspection confirms the basis still matches the one last deployed against, and a mismatch is surfaced (not silently proceeded past) as a basis-drifted-out-of-band warning.

A first deploy leaves `previous` undefined ⇒ no backfill rows; an unchanged re-apply introduces no new basis relations ⇒ no backfill rows.

#### Module deployment notification

The snapshot is also the payload of a **module-facing notification**. A `VirtualTableModule` may implement the optional hook

```ts
notifyLensDeployment?(
  db: Database,
  logicalSchemaName: string,
  snapshot: LensDeploymentSnapshot,
): void | Promise<void>;
```

which the engine fires once per **successful** logical `apply schema X`, after the lens views + slots are registered and the snapshot is rotated. This is the hook a host adapter backing the basis uses to realise / reconcile its backing relations against the freshly deployed lens, rather than mirroring the snapshot shape by hand. The firing contract:

- **Once per successful apply.** Fires only when the deploy returns without throwing — the deploy is atomic, so a blocked deploy (prover error, malformed advertisement, …) aborts before the notification. A **physical** `apply schema` deploys no lens and never fires it.
- **After deploy, outside any migration batch.** The logical-apply path runs no migration-DDL loop (that is the basis/physical path); the notification fires once the lens catalog mutation + snapshot rotation are complete.
- **Snapshot scoped to the affected schema, no second derivation.** The engine re-reads the just-rotated `current` snapshot and passes that exact object, so the notification and `quereus_basis_backfill` see one source of truth. An **empty deploy** (every logical table removed) still fires, carrying an empty snapshot, so a consumer observes the detach.
- **Every registered module, registration order.** A module that backs none of the basis relations should no-op. A module under the [isolation wrapper](../packages/quereus-isolation/README.md) receives the notification through a straight delegate (the deployed shape is isolation-transparent).
- **Errors propagate.** The lens is already deployed when the hook fires; a notification that throws aborts `apply schema X` with that error so the caller learns the module's reconcile failed. The deployed lens is **not** rolled back — a subsequent re-apply re-fires the notification.

#### Classification — re-decomposition vs needs-data

For each **new** basis relation `R` (one the prior lens did not back) the differ classifies each of `R`'s columns:

- **reconstructible** — its logical column was produced by the prior get-body (`∈ previous.logicalColumns`); the engine generates its backfill.
- **new** — absent from the prior deploy; the prior basis has no data, so the **application supplies it**.
- A basis column that maps to **no** logical column (e.g. a surrogate-key default) is naturally absent from `relationBacking` and so is **omitted** from the projection — the basis default mints it.

The per-relation category is then `re-decomposition` (every column reconstructible → fully engine-generated), `partial` (some reconstructible → engine generates those, lists the rest as `missing`), or `needs-data` (none → entirely the application's). Threading one *surrogate* shared key across the members of a multi-relation split is part of the `put` fan-out; a multi-member surrogate split emits a `needs-data` deferred-note row rather than an unsound insert.

**The NOT-NULL rule.** A `partial` row's generated `backfill_sql` is a key-only skeleton `insert` that seeds only the reconstructible columns and relies on the basis to mint each omitted column from its declared default. That is sound **only when every omitted basis column is nullable, defaulted, or generated**. Because Quereus columns are **NOT NULL by default**, an omitted column that is NOT NULL with no default has *no* value source: running the skeleton would fail an unguarded NOT NULL constraint. In that case the classifier emits **`backfill_sql = null`** (the application owns the whole insert) while keeping the `partial` category and the reconstructible-columns record, so the app still learns which columns are reconstructible. The runnability test is at the relation level — every NOT-NULL, no-default, non-generated basis column of the member must be among the reconstructible columns — so it also covers a required member column the lens maps to no logical column. **Any emitted `backfill_sql` therefore never fails an unguarded NOT NULL constraint.**

#### `quereus_basis_backfill(logical_schema)`

The classified rows are introspected by the integrated TVF, mirroring `quereus_effective_lens`: it requires a logical schema, loads the rotated snapshot pair (yielding nothing with no `previous`), and yields one row per new basis relation, ordered by logical table then basis relation:

| column | meaning |
|---|---|
| `logical_table` | the logical table the basis relation backs |
| `basis_relation` | `schema.table` of the new basis member |
| `category` | `re-decomposition` · `partial` · `needs-data` |
| `backfill_sql` | the generated `insert … select … from (<prior get>)` for the reconstructible columns; `NULL` when `needs-data`, or when a `partial` skeleton would violate NOT NULL (the application must own the insert) |
| `generated_columns` | comma-joined basis columns the engine backfills |
| `missing_columns` | comma-joined basis columns the application must supply (empty for `re-decomposition`) |
| `reason` | human note: classification rationale, surrogate omissions, basis-hash-drift warning |

Consistent with the **ingredient model** (the engine generates and classifies the backfill DDL; it does not auto-run a coordinated migration), the application fetches the rows, runs the engine-generated ones, and supplies its own for the rest — the same shape as the `diff schema X` → app-runs-the-DDL flow.

#### Sequencing contract

The generated `backfill_sql` reads the **prior** get-body over the **prior** basis tables, which must still hold data when the app runs it. The required order for a re-decomposition deploy:

1. `apply schema Y` — migrate the basis (new member tables created; **prior members retained**, not dropped — they are the backfill source).
2. `apply schema X` — recompile the lens over the new basis (rotates the snapshot; `previous` now holds the prior get-body).
3. `select * from quereus_basis_backfill('x')` — fetch rows; run every non-`NULL` `backfill_sql`; supply app data for `missing_columns`, `needs-data` rows, and any `partial` row whose `backfill_sql` is `NULL`.
4. GC the now-detached prior basis members when convenient.

Because the backfill reads the persisted prior get-body (not the live `X.T` view), step 3 is robust to the lens already pointing at the new basis — the snapshot, not catalog timing, is the source of truth.

## Relationship to Materialized Views

Indexes are a basis-layer concern, expressed as **materialized views**: a materialized view with an `order by` describes a clustered/ordered structure — an index. A unique *constraint* is a logical claim (it lives in the logical schema); the *index* that covers it is a basis-layer materialized view. The two legitimately sit at opposite ends of the stack, and the lens carries the constraint down to a level where it is enforceable while the index attaches at basis. This realizes the principle that **a constraint is a logical claim, and the structure that enforces it is an optional physical optimization.**

Unique enforcement is a key existence lookup against that covering materialized view when present (row-time, conflict-resolution-capable), falling back to a commit-time scan when absent. The unified covering-structure surface this layer consumes — the `CoveringStructure` discriminated union (`memory-index` | `materialized-view`), the eager constraint↔structure linking, and the coverage prover that recognizes a covering `order by` MV — is described in [Derived-Row Constraints § Covering structures](mv-constraints.md#covering-structures).

The write-through prerequisite is satisfied for the covering-index shape: a materialized view keeps its backing table consistent synchronously with each source row-write, within the transaction (the single row-time materialization model — [Materialized-View Maintenance](mv-maintenance.md#maintenance-row-time-per-statement)), so a covering MV is *kept current at write time*, which is what a row-time existence lookup requires. Routing `unique` enforcement through that backing table for conflict resolution is described in [Derived-Row Constraints § Enforcement through a covering MV](mv-constraints.md#enforcement-through-a-covering-mv). In the logical-schema world — where the auto-index is retired and an explicit covering MV becomes the *sole* enforcement structure — that path is load-bearing. Where no covering structure answers a constraint, the commit-time scan governs the gap (the `lens.no-answering-structure` advisory).

## Syntax

```sql
-- Logical: design only. Constraints and tags allowed; no module, no indexes.
declare logical schema X {
  table Car (
    id int primary key,
    maxSpeed int,
    ...
  ) with tags ("domain.unit.maxSpeed" = 'kph');
}

-- Basis: a physical schema — module-backed tables plus index materialized views.
declare schema Y {
  table CarCore (id int primary key, ...) using mem();
  table CarPerf (id int primary key, speed int, ...) using mem();
  create materialized view ix_carperf_speed as
    select speed, id from CarPerf order by speed;   -- clustered index over CarPerf
}

-- Lens: binds logical X to basis Y; supplies sparse overrides.
declare lens for X over Y {
  view Car as
    select id, speed as maxSpeed              -- rename override
    from Y.CarCore join Y.CarPerf using (id);  -- other Car columns gap-filled
  view Audit as
    select id, who, upper(who) as label         -- compute override; other Audit columns gap-filled
    from Y.AuditLog;
  -- tables of X not mentioned here are auto-mapped against Y entirely
}
```

- `declare logical schema X { ... }` — `kind: 'logical'`, declarative end-state, diffed by the schema differ.
- `declare lens for X over Y { ... }` — names the logical schema (`for X`) and the **explicit basis** (`over Y`), and populates lens slots. It is a **sibling statement of `declare schema`, not a variant** of it. Unmentioned tables are auto-mapped; columns unmentioned within a mentioned table are gap-filled. The basis binding lives on the lens, never on the logical schema — that is what keeps the logical schema embodiment-free and lets one logical schema target multiple bases across deployments. Re-declaring a lens for X replaces the prior block; two `view T as` for the same logical table within one block is an error. The lens must be declared **before** `apply schema X` (it is re-read from source on every apply).

## Background

- **Codd, E. F. (1970); ANSI-SPARC three-schema architecture.** The external / conceptual / internal separation. Quereus's logical / mapping / basis layering is this separation expressed over virtual, key-addressed relations.
- **Bohannon, A., Pierce, B. C., & Vaughan, J. A. (2006). "Relational Lenses: A Language for Updatable Views."** Types the canonical `select` / `project` / `join` lenses with FD-and-predicate annotations and proves GetPut / PutGet *compositionally, per operator* — the direct lineage of Quereus's FD-annotated per-operator backward walk. See also [view updateability § Background](view-updateability.md#background).
- **Foster et al. (2007). "Combinators for Bidirectional Tree Transformations" (lenses).** The `get` / `put` formulation and the GetPut / PutGet laws. Quereus realizes lenses without a dedicated combinator language — relational algebra is the lens vocabulary, and the laws become the completeness checks the lens prover discharges.
- **Date & Darwen, "The Third Manifesto."** Any relation expression is a first-class mutation target — the basis on which a logical table can be an inlined, mutable view.
- **Dataphor (Alphora, D4).** Precedent for view-as-first-class-target with mapping metadata; Quereus extends it with FD/EC-driven default recovery and the sparse-override-over-generated-baseline authoring model.

## Departures and Non-Goals

| Topic | Quereus | Rationale |
|---|---|---|
| Logical-table indexes | Not allowed. | Indexes are basis-layer materialized views; logical is embodiment-free. |
| Auto-index for `unique` / PK | Physical schemas only; logical schemas never. | The eager auto-index (`LayerManager.ensureUniqueConstraintIndexes`) is gated on the one-bit `Schema.kind`: a *physical* (basis) table keeps the eager auto-index + implicit covering-structure descriptor; a *logical* table builds **nothing** — its `unique`/PK contributes only a key/FD to the optimizer plus an enforced boundary constraint, and any covering index is a separate basis-layer materialized view. Logical tables are never module-backed, so the path was already unreachable for them; the gate enforces the separation at the source. |
| `with check option` on a lens | Not a separate feature. | Constraints are attached from the logical spec and enforced at the lens boundary; predicates remain read-time filters. |
| Separate lens algebra | None. | Relational algebra is the lens vocabulary in both directions. |
| Deployment orchestration | Out of scope. | Quereus exposes generate / diff / hash / emit-DDL ingredients; the application assembles the deployment. |

## Implementation Map

The lens layer introduces no new runtime: at execution time a logical table is an inlined view, driven by the existing optimizer, [view updateability](view-updateability.md), and [materialized-view](materialized-views.md) machinery. All lens-specific behavior is compile-time **validate / generate / attach**. The principal source files:

| Concern | Location |
|---|---|
| Schema kind + per-schema lens-slot registry | `src/schema/schema.ts` (`Schema.kind: 'physical' \| 'logical'`) |
| Logical-table spec (optional `vtabModule`, `isLogical`) | `src/schema/table.ts` |
| The lens slot (logical spec, basis binding, compiled body, attached constraints, obligations, injected INDs, advertisement) | `src/schema/lens.ts` (`LensSlot`) |
| Parse `declare logical schema` / `declare lens for X over Y` + DDL round-trip | `src/parser/parser.ts`, `src/parser/ast.ts`, `src/emit/ast-stringify.ts` |
| Default name-based aligner, sparse-override merger, basis binding, n-way `get` synthesis (`compileDecompositionBody`), advertisement resolution (`resolveAdvertisement`), existence-anchor IND injection | `src/schema/lens-compiler.ts` |
| `put` fan-out + surrogate threading (DELETE / UPDATE / INSERT over a decomposition) | `src/planner/mutation/decomposition.ts` |
| Shared backward-walk consumer (single / multi-source / decomposition) | `src/planner/mutation/backward-body.ts` |
| Lens prover: FD/key/type/nullability conformance, constraint classification, coverage checklist | `src/schema/lens-prover.ts` (`proveLens`, `computeLensAssertedKeyFds`) |
| Live per-write enforcement (row-local check rewrite, child/parent-side FK, set-level) | `src/planner/mutation/lens-enforcement.ts`, `src/planner/building/view-mutation-builder.ts` |
| Advisory acknowledgment / fingerprint / escalation governance | `src/schema/lens-ack.ts` (`applyAckGovernance`, `computeAdvisoryFingerprint`) |
| Reserved-tag registry (single source of truth for `quereus.*`) | `src/schema/reserved-tags.ts`, `src/schema/reserved-tags-policy.ts` |
| Module mapping advertisement protocol + tag builder | `src/vtab/mapping-advertisement.ts`, `src/schema/mapping-advertisement-tags.ts` |
| Auxiliary-access read-path routing | `src/planner/rules/access/lens-access-form-matcher.ts`, `rule-lens-auxiliary-access`, `LensAuxiliaryAccessNode` |
| Asserted-keys boundary marker | `src/planner/nodes/asserted-keys-node.ts`, wired in `src/planner/building/select.ts` |
| Kind-aware diff + hash (logical removals never drop basis) | `src/schema/schema-differ.ts`, `src/schema/schema-hasher.ts` |
| Lens deployment snapshot, rotation, capture; re-decomposition backfill classifier | `src/schema/lens.ts` (`LensDeploymentSnapshot`), `src/schema/basis-backfill.ts` (`computeBasisBackfill`) |
| Module deployment notification hook | `src/vtab/module.ts` (`notifyLensDeployment`), fired in `src/runtime/emit/schema-declarative.ts` |
| Introspection TVFs (`quereus_effective_lens`, `quereus_lens_advisories`, `quereus_basis_backfill`) | `src/func/builtins/explain.ts` |

The exported surface (`deployLogicalSchema`, `LensDeploymentSnapshot`, `LensTableSnapshot`, `LensRelationBacking`, `LensDeployReport`) is re-exported from the `@quereus/quereus` package root; the AST types those reference (`SelectStmt`, `DeclareSchemaStmt`) are reachable from `@quereus/quereus/parser`.

> **Logical-table representation.** The compiled effective body of each logical table is registered as a **`ViewSchema`** (`Schema.addView`), so `select` from `Logical.T` resolves through the standard view path and mutation rides view updateability with zero new runtime. The logical spec itself (columns / types / constraints — the surface a `ViewSchema` cannot carry) lives in the **lens slot**, keyed by logical table name on the owning `Schema`. Read/write resolution goes through `ViewSchema` / `getView()`, not `TableSchema.viewDefinition`.

## Current Limitations

The design above is realized except for the following, each deferred onto substrate not yet present and each raised at compile or mutation time with a precise diagnostic rather than silently mis-handled:

- **DELETE/UPDATE `WHERE` referencing a genuine non-anchor member** (an EAV pivot column, an embedded subquery) — needs snapshot-consistent multi-member base-op execution, the same substrate the predicate-honest multi-side join delete defers onto. Each case raises its own accurate message.
- **Shared-key (identity) column UPDATE through a decomposition** — a key write is an identity change, not a value write. (The **optional-member and EAV value-write** dual — null→non-null materializes a component, non-null→all-null deletes it — is now **supported** as anchor-keyed base ops; see *The Default Mapper* § UPDATE. The identity write stays deferred.)
- **Captured optional-columnar UPDATE over an *invisible* logical row** (a malformed base state — an anchor row whose **mandatory** member is missing, so the row is dropped by the body's inner join and never surfaces through the view) — the value capture is built over the get body (`anchor ⋈ members`), so an invisible row is **absent from the capture**, but the matched UPDATE / materialize INSERT filter off the **anchor** subquery, which **includes** it. The captured read-back therefore misses (returns null): for a *nullable* optional column this writes null (PutGet still holds — the row stays invisible, no widen); for a **NOT NULL** optional column it raises a base NOT NULL constraint error (atomic). This diverges from the constant / anchor / self paths, which write the value to the invisible row's component. The divergence is confined to malformed states (a mandatory member should always be present) and never silently corrupts — it writes null or fails atomically — so it is a documented boundary, not a runtime guard. (A future tightening could key the matched UPDATE off `__vmupd_keys` membership instead of the anchor subquery, excluding invisible rows on all value shapes.)
- **Captured EAV UPDATE writing a null over a NOT-NULL pivot value column** — the matched UPDATE of a captured EAV cell is **unfiltered**, so a captured null on a matched triple (`set p = q + 1` over an entity that has `p` but lacks `q`) writes `val = null`. With a **nullable** pivot value column that is a benign physical divergence (the null triple reads identically to an absent one through the get-side correlated subquery, so PutGet holds — never a widen); with a **NOT NULL** pivot value column it instead hits the base NOT NULL constraint and raises atomically (the EAV analogue of the captured optional-columnar invisible-row boundary above). The materialize INSERT's runtime non-null filter means a captured null on an *absent* entity never springs a phantom triple, so only the matched-triple-null case reaches this boundary. Never silently corrupts — it writes null (nullable) or fails atomically (NOT NULL).
- **Composite shared keys** — the insert fan-out threads a single-column shared key. (The surrogate's *value source* is now an ordinary column `default`, so non-integer / non-deterministic allocators — `uuid7()`, a custom UDF — are fully supported; only the multi-column shape remains deferred.)
- **NULL-safe stitch gate reads *declared* nullability** — an accepted tradeoff, not a defect: under `pragma default_column_nullability = nullable` every stitch key is declared nullable, so every decomposition get body takes the disjunctive NULL-safe join ON, which yields no equi-pairs (the join falls back to nested-loop and loses its key-coverage proofs) on the read path of every select over the lens. Correct but potentially slow (code-site pointer: the `NOTE:` at `buildKeyEquiJoin`, `src/schema/lens-compiler.ts`); revisit — narrowing the gate to *reachable* nullability (a NOT NULL check on the key column, or a body predicate that excludes NULL) — if lens reads under that pragma ever show up in profiles.
- **Materializing an optional component for a NULL-keyed row under a *mixed*-nullability stitch key** — when the anchor key is nullable but the member's stitch column is NOT NULL, the NULL-safe gate is deliberately off (a member row keyed NULL could not exist, so nothing is unreachable on the read side). Assigning that member's cell on the NULL-keyed logical row then finds no matched component and falls to the **materialize INSERT**, which threads the anchor's NULL into the member's NOT NULL key and raises a base NOT NULL constraint error, atomically. The alternative — silently filtering the materialize to non-NULL anchor keys — would drop a requested write with no signal, so the loud failure is kept. Never silently corrupts.
- **True per-logical-key conflict-action honoring** — a row-time key honoring an `on conflict replace` / `ignore` its basis UC does not itself carry would need a per-statement, per-constraint conflict-override channel threaded planner→memory/isolation/store. Today such a mismatch is rejected at deploy (the sound floor). A partial logical `UNIQUE` on a commit-time key is likewise rejected, since the O(n) count scan cannot scope by the partial predicate.
- **Predicate-honest round-trip prover** — the GetPut / PutGet completeness predicates are currently caught at mutation time and by key-reconstructibility, not computed as deploy-time predicates. The seam is encapsulated for the tightening.
- **Auxiliary-access refinements** — a lossy / refinement-required access form that must retain its predicate as a residual; routing through an auxiliary keyed only by a non-logical surrogate (the join-interior surrogate rewrite); and crediting a routable auxiliary in the `lens.no-answering-structure` advisory's answering-structure check.
- **GC of detached prior basis storage** — a logical removal detaches the mapping and retains the basis column; reclaiming it is application-driven and out of scope here. (For the synced-deployment retirement policy that consumes this boundary — three-state basis classification, retention horizons — see [Migration § Retirement](migration.md#4-contract--retire-the-old-table).)
