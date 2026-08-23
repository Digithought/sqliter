# Materialized Views

> **Stability: Beta** — see [Stability Tiers](stability.md#tiers).

A **materialized view** in Quereus is a *transparent materialization cache*: a query body stored once into a keyed table and kept consistent with its sources **synchronously, inside the writing transaction**. Where a plain [view](schema.md#viewschema) re-evaluates its body on every reference, a materialized view serves reads from stored rows — but those rows are maintained at every source row-write, so a materialized view is observably **indistinguishable from the plain view it derives from, only faster**.

There is exactly one maintenance model — **row-time** — and no refresh-policy knob. A materialized view always reflects its sources, including a write the same transaction just made (reads-own-writes); maintenance commits and rolls back in lockstep with the source write. The user never reasons about *when* the view is consistent.

This document is the **overview**: what a materialized view is, how to declare one, how a query resolves against one, and how a write to one is routed. The subsystems that grew large enough to read on their own live in the topic documents below.

## Topic documents

<!-- NOTE: the sections below that moved into a topic document left a stub behind under their
     original heading, so their old anchors still resolve here. `yarn docs:check` therefore
     cannot tell a deliberately-kept link to a stub from one that should have been retargeted
     and wasn't. If a doc ever needs to link at real content that lives in a topic document,
     link the topic document — not the stub. -->

| Document | Covers | Written for |
| --- | --- | --- |
| [Materialized-View Maintenance](mv-maintenance.md) | Strategy selection, the four bounded-delta arms, the full-rebuild floor, MV-over-MV cascade, the per-statement contract. | An engine developer changing how a view is kept fresh. |
| [Derived-Row Constraints and Covering Structures](mv-constraints.md) | Declared CHECK / FK / secondary UNIQUE on a maintained table, parent-side referential enforcement, the coverage prover, enforcement through a covering view. | An engine developer working on constraint enforcement. |
| [External row-change ingestion](mv-ingestion.md) | `Database.ingestExternalRowChanges` — facets, trust boundary, visibility contract, DML replay versus the seam. | A sync or replication developer. |
| [Schema-change staleness](mv-schema-change.md) | Staleness marking, recompile-in-place, rename propagation, `ALTER TABLE` on the maintained table itself. | An engine developer touching DDL. |
| [Backing-host capability](mv-backing-host.md) | The `BackingHost` contract, the store host, cross-module atomicity and the adopt-without-refill fast path. | A **module author** implementing the capability. |

## Why one model

> **Invariant:** [MV-001](invariants.md#mv-001--a-materialized-view-is-a-faster-plain-view), [MV-002](invariants.md#mv-002--maintenance-rides-the-writing-statements-transaction)

A materialized view exists to be a *correctness-free* optimization: the user adds it for speed and nothing about query results should change. That requires the view to be consistent with its sources from a reader's point of view at all times — the same guarantee a plain view gives. Only synchronous, in-transaction (row-time) maintenance provides it:

- It is **semantically transparent** — MV ≡ faster view, reads-own-writes. A model that lagged within a transaction would itself be a semantic "switch" the user has to model.
- It is **transactional** — maintenance is part of the writing statement, so a failed maintain simply rolls back with the write. There is no post-commit window, no asynchronous drift, and therefore no divergence / self-heal machinery to reason about.

Synchronous per-write maintenance is cheapest when the backing delta is a bounded projection of the changed row, but it is **never restricted to those shapes**: every body is maintainable. The **incremental arms** (projection/filter, aggregate, lateral-TVF fan-out, 1:1 join) keep the common shapes a bounded per-row delta; an always-correct **full-rebuild floor** maintains everything else by re-evaluating the body once per writing statement. A backward (maintenance-direction) cost gate picks the cheapest sound strategy. So no body is *rejected for its shape* — the only create-time rejections are a **non-deterministic** body (which no maintenance could keep equal to the view), a **bag** body with no provable unique key (no row identity to materialize on), a body with **no relational output**, a body that **reads no source table** (`select 42` — no source write could ever maintain it), and a **full-rebuild-only** body over a source past the configurable size threshold (where synchronous per-statement rebuild would be pathological). See [Maintenance strategy](mv-maintenance.md#maintenance-strategy).

## Substrate: a maintained table

> **Invariant:** [MV-009](invariants.md#mv-009--a-materialized-view-is-exactly-one-schema-object)

A table is a stored relation; a *derivation* is an optional maintenance contract attached to it. A materialized view is realized as exactly **one** schema object — an ordinary `TableSchema`, registered under the view's own name, carrying a `derivation` (`TableDerivation`, `schema/derivation.ts`). One `TableSchema`, one catalog name, one physical incarnation:

```
CREATE MATERIALIZED VIEW mv [USING <module>(...)] AS <body>
        │
        └─ TableSchema   "mv"        ← stored rows, real virtual table — the name users reference
              derivation: TableDerivation
                (selectAst, logicalKey, bodyHash, sourceTables, ordering,
                 columns? / coarsenedKey? / covers?;
                 runtime: stale? / sourceScope?)
              # the `with defaults (…)` clause rides inside selectAst (SelectStmt.defaults)
```

- **The maintained table.** The materialized rows live in the table itself — there is no separate hidden backing object; the "backing table" the [backing-host capability](mv-backing-host.md#backing-host-capability) operates on *is* the maintained table. The hosting module is **pluggable**: `USING <module>(...)` places the table in any registered module that implements the capability; omitting the clause keeps the in-memory default. The module identity is the table's own `vtabModuleName`/`vtabArgs` (an explicit `using memory()` normalizes via `normalizeBackingModule` to the same record as an omitted clause), emitted by the DDL generator, honored on catalog import, and preserved across refresh shape-rebuilds; the declarative differ does **not** track it (a module move is destructive and out of scope — see [§ Declarative-schema integration](#declarative-schema-integration)), so a `using` change is a silent no-op there, the same posture a plain table takes. The engine never reaches into the hosting module's internals: every privileged operation (maintenance writes, the wholesale create/refresh fill, the enforcement scan) routes through the module-neutral [backing-host capability](mv-backing-host.md#backing-host-capability), for which the memory module is the default and reference implementation; all MV semantics (row-time maintenance, reads-own-writes, commit/rollback lockstep, MV-over-MV cascade, covering-UNIQUE enforcement, refresh, rename propagation, drop) hold regardless of the hosting module. See the [cross-module atomicity note](mv-backing-host.md#cross-module-atomicity) for the one durability caveat.

- **The derivation record.** `TableDerivation` retains the parsed body AST (`selectAst` — which itself carries the trailing `with defaults (…)` clause on `SelectStmt.defaults` — plus the explicit column list when present), the body's logical key (`logicalKey`), the `bodyHash` (`computeBodyHash` over the canonical definition), the qualified source-table dependencies (`sourceTables`), the captured body `ordering`, and runtime maintenance state (`stale`, `sourceScope`). `MaintainedTableSchema = TableSchema & { derivation: TableDerivation }`. Identity (name/schema), storage (module/args), tags, and the physical primary key all live on the owning table; the canonical `create materialized view` DDL is rendered on demand from the unified record (`generateMaterializedViewDDL`). `SchemaManager` accessors: `getMaintainedTable(schemaName, name)`, `getAllMaintainedTables()`, `attachDerivation(schemaName, tableName, derivation)`.

- **One namespace.** A maintained table occupies the ordinary table namespace under the view's own name: `create materialized view x` over an existing table or view errors, and `create table x` over a maintained table errors ("Table main.x already exists"). The `schema()` TVF lists a maintained table exactly once, as `type = 'materialized_view'`, with its canonical `create materialized view` DDL and top-level tags.

### Primary key inference

> **Invariant:** [MV-010](invariants.md#mv-010--the-maintained-relation-is-always-a-set)

The maintained table's logical key is the body's own key, so each body row maps to exactly one stored row and the materialized relation is **always a set**:

- For the bounded-delta arms the key is structural: the **covering-index** shape maps `T`'s primary key through the projection (the gate requires every PK column to be a passthrough output column); the **aggregate** arm keys on the group key; the **lateral-TVF** arm keys on the composite product key `(T.pk ∪ tvf-key)`; the **1:1-join** arm keys on the driving table's PK.
- For the **full-rebuild floor** the key is the body's **provable unique key** (`keysOf` over the optimized body root — a set operation over keyed legs, a multi-way 1:1 join, a `distinct`, etc. all carry one).

A body with **no** provable unique key is offered one more derivation before rejection — the [coarsened backing key](#coarsened-backing-keys) below. When that does not apply either, the body is a *bag* — e.g. a key-dropping projection or a `union all` of overlapping inputs — with no row identity to key a materialization on, and is **rejected** at create (a relational reject, not a shape reject; a multiplicity-keyed bag materialization is a [future](#current-limitations)). The create-time fill guards duplicate backing keys defensively (the transactional replace and the backing host's `replaceContents` carry an `onDuplicateKey` factory raising a "must be a set" diagnostic); for a body with a sound key that guard never fires.

> **Physical vs logical key.** The maintained table's *physical* `primaryKeyDefinition` may lead with the body's `order by` columns (so a btree scan reproduces the body order), appending the logical key as a uniqueness-preserving tiebreaker. `TableDerivation.logicalKey` keeps the logical identity. The covering-structure work generalizes this into a proper materialized index.

#### Coarsened backing keys

> **Invariant:** [MV-011](invariants.md#mv-011--a-coarsened-backing-key-is-derived-once-and-read-by-both-sides)

The collation-weakening migration shape ([migration.md § Convergence hazards](migration.md#convergence-hazards)) — `select handle collate nocase as handle, email from Contact_v1` over a BINARY-keyed source — has **no provable key**: the collation-weakening projection correctly drops the source key from `keysOf`, since two source rows (`'Bob'`, `'bob'`) can collide under the output collation. Yet the projected source key is the *intended backing identity*. At create, when `keysOf` is empty, `deriveCoarsenedBackingKey` (`planner/analysis/coarsened-key.ts`) recognizes this shape:

- the body is a **row-preserving single-source chain** (Project / Filter / Sort / physical access nodes, plus the probe side of a semi/anti join — which is a filter written as a join, so it yields each probe row verbatim at most once and publishes only that side's attributes; this is what an uncorrelated `where col in (select …)` optimizes to — over exactly one base table; no row-combining joins, set ops, aggregates, `DISTINCT`, window functions, TVFs, or row caps; a collapsing or fanning node would make a lineage-covered source key a *false* identity, e.g. `group by b collate nocase` holds many rows per `b`), and
- every source primary-key column is reachable from an output column through a **value-preserving passthrough chain** — a bare column reference, `collate`, or a no-op `cast` (the `traceInvertibleColumn` passthrough subset with no inverse steps).

The corresponding output columns then form the **coarsened backing key K'**, which keys the backing under the **output** collations. When the same source key column is covered by several outputs, a non-coarsening output is preferred (it yields a true unique key); ties break to the first covering output. K' is deliberately *not* a planner key fact — it never enters `keysOf` / `RelationType.keys` (it is not a key of the body relation); it is an MV-create policy with these runtime semantics:

- **Create-fill / REFRESH are loud.** The backing host's duplicate guard raises the "must be a set" diagnostic when the source rows collide under K' — at create this is the at-deploy rejection the migration pattern specifies, and a `refresh` during a collision window fails the same way (it is a re-fill).
- **Row-time maintenance merges last-writer-wins.** A colliding source insert/update upserts into the shared backing key, replacing the sibling's image; each sibling edit re-asserts its own image (the deterministic oscillation migration.md describes), until the source rows are merged. Each realized merge fires the runtime **collision telemetry** below.
- **The delete anomaly.** A source delete (or key-changing update) of one colliding sibling deletes the **shared** derived row even while the other sibling source row lives. The surviving sibling's next edit, or a `REFRESH` / full rebuild, re-asserts it — the full-rebuild paths are the correctness backstop.
- **The key-coarsening warning.** When any K' column's output collation is strictly coarser than the source key column's enforcement collation (`BINARY` is the finest — refinement to it, or an equal collation, derives a genuine unique key and is accepted silently; any other difference is conservatively coarser), the create emits the warning — *"backing key (…) is coarser than the source primary key (…); colliding source rows will last-write-win until they are merged"* — on the structured logger's warn channel, and stamps `TableDerivation.coarsenedKey` (informational; recomputed wherever the shape is re-derived, never serialized). Warn, don't reject: merge-on-coarsen is often exactly what the migration intends. The stamp is programmatic-only — no SQL or introspection-TVF surface exposes it.
- **Runtime collision telemetry** is the *operational* complement to the create-time warning: the warning says the hazard exists, telemetry says it is happening. Whenever row-time maintenance LWW-merges two distinct source-key tuples under K' (a maintenance `update` whose replaced backing row differs from the incoming row under the *source*, pre-coarsening collation — local DML **or** the `ingestExternalRowChanges` ingest seam), the engine fires a host-observable `db.onMaintenanceCollision((e) => …)` event and increments a cumulative per-table counter exposed by `db.getMaterializedViewCollisionStats()` (a `ReadonlyMap` keyed by lowercased `schema.table`). The event payload is `{ schemaName, tableName, key (the K' key values), weakenedColumns (the diverged names), oldRow, newRow }`. It rides the same transaction batching as the data/schema change events, so a collision inside a rolled-back transaction (or rolled-back savepoint) reports nothing and is not counted; the counter reflects only *committed* merges and is maintained whether or not a listener was ever subscribed. `tableName` is as-of-delivery, like the data channel's: renaming the view mid-transaction (`alter table … rename to`, the one ALTER a maintained table accepts) relabels the collisions the transaction has already recorded, and the counter keys on the new name. Detection is **zero-overhead for a non-coarsened MV** (a provable-key / refining-lineage-key MV builds no watch list and never scans the maintenance delta) and **observe-only** (it never perturbs the MV-over-MV cascade). It is an operational signal, not an exact invariant: a single source row's in-place key-case change on a *weakened* key column (`update contact_v1 set handle = 'bob' where handle = 'Bob'`) IS flagged even though only one source identity exists — the source UPDATE arrives as one replacing `update` (the maintained backing key is unchanged under the coarsened collation, so it is not a delete + insert), and the weakened column's bytes differ under the source collation. This is an **accepted heuristic limit**: distinguishing it from a genuine two-row merge would need source-PK provenance plumbing, deliberately out of scope. An out-of-scope `remote` provenance field is likewise reserved on the payload but unset. Both maintenance arms report identically: the bounded-delta inverse-projection upsert and the full-rebuild floor's collation-keyed `replace-all` diff both surface the merge as an `update`. The telemetry is programmatic-only (no SQL surface), and the REFRESH path is **not** a collision site — it re-fills and rejects duplicate K' keys loudly (a re-fill, not a silent merge).

A **coarsening** K' is also the backing's *physical* key exactly — the ordering seed (see the physical-vs-logical note above) is suppressed for it. The loud fill and the LWW merge both rest on the backing btree equating colliding source keys; leading the physical key with the body's `order by` columns would widen uniqueness past K', letting colliding siblings coexist silently. The only cost is the clustering optimization; a non-coarsening lineage key is a true key and keeps the seed.

Row-time maintenance for the canonical shape rides the ordinary [covering-index arm](mv-maintenance.md#maintenance-strategy): a `collate` / no-op-`cast` wrapped column copies the source **value** verbatim, so it classifies as a passthrough projector, and the per-row upsert keyed under the backing PK's output collation realizes the LWW merge with no dedicated machinery. A coarsened body the arm declines (e.g. an uncompilable `WHERE`) falls to the [full-rebuild floor](mv-maintenance.md#full-rebuild-floor), whose collation-keyed `replace-all` diff is likewise last-writer-wins.


### Backing-host capability

> **Invariant:** [MV-014](invariants.md#mv-014--every-privileged-operation-routes-through-the-backing-host)

Every privileged operation on the maintained table — the maintenance write, the wholesale create/refresh fill, the covering-UNIQUE enforcement scan — routes through a module-neutral capability, `BackingHost` (`vtab/backing-host.ts`), which any registered module may implement. The memory module is the default and reference implementation; the store module makes `using store` a persistent backing. Because the engine never reaches into a hosting module's internals, every MV semantic below holds regardless of which module hosts the rows.

See [Backing-host capability](mv-backing-host.md) for the member-by-member contract, the store host, and the cross-module atomicity window.

## DDL statements

A maintained table has two equivalent authoring surfaces — the declared-shape **table form** and the `create materialized view` **sugar** — plus the lifecycle verbs that attach and detach a derivation on an existing table (the [migration pattern's](migration.md) flip and contract phases stand on these). `MAINTAINED`, `MATERIALIZED`, and `REFRESH` are contextual keywords — no new reserved words are introduced.

Every statement below creates, drops, or rewrites a real module-backed table, so all of them — including `REFRESH` — are refused inside an explicit `begin … commit` under the opt-in `ddl_transaction_policy = 'strict'` setting, on any backing module that does not declare `ddlTransactionality: 'transactional'` (no built-in module does). The module consulted is the backing host (`using <module>(…)`, else `memory`). Under the default `permissive` policy nothing is refused. See [module-capabilities.md § DDL transactionality tiers](module-capabilities.md#ddl-transactionality-tiers).

**No mutation context on a maintained table.** A maintained table's rows are derived by the engine, not written by a user statement, so a `with context (…)` declaration on one is rejected — both authoring surfaces, `create table … maintained as … with context (…)` and `alter table … set maintained as …` over a table that already declares context variables. See [sql-ddl.md § 2.6.2 Mutation Context](sql-ddl.md#262-mutation-context-table-level-parameters).

**Home-schema body resolution.** The stored body's unqualified names resolve against the maintained table's **own schema first**, then the session default path — never the calling statement's `with schema` path. The same rule applies at every seam that re-plans the body: create-time validation, refresh, staleness re-validation, backing-shape derivation, and row-time maintenance compilation. So `create materialized view temp.mv as select … from t` finds `temp.t`, and `refresh materialized view` succeeds regardless of the session's `schema_path` at refresh time. See [schema.md § Schema Path](schema.md#schema-path).

### `CREATE TABLE … MAINTAINED AS` (declared-shape form)

```sql
create table X (
  handle text collate nocase primary key,
  email text
) [using <module>(...)]
  maintained [(columns)] as <body … [with defaults (col = expr, ...)]>
  [with tags (...)];
```

The declared column/PK layout is the **frozen basis** and the body must derive exactly that shape — column names (alias body outputs to match, *unless* a `maintained (columns)` rename list is present — see below), logical types, nullability (exact, both directions), collations, and the physical primary key (column order, direction, per-component collation; note a body `order by` seeds the derived key) — or the create errors **before any catalog registration**, naming the first mismatching component. `if not exists` with an existing table skips entirely — never a half-attach. Clause order is fixed: `(columns) → using → maintained [(columns)] as <body … with defaults> → with tags` — the `with defaults (…)` clause is a trailing clause of the body select, not the DDL statement. On success the create runs attach-to-empty through the same verify-by-diff core as [`SET MAINTAINED`](#alter-table--set-maintained-as-attach--re-attach) below (a diff against an empty table is the fill, applied to the connection's pending transaction state, so it commits in lockstep with the statement). Any later failure — duplicate derived keys, a maintenance gate — rolls the whole record back; the create is all-or-nothing.

**Declared collation vs a backing module's own.** A backing module may key a column under a collation of its own when the column declares none — the store module keys an undecorated text primary key under its table-level key collation (`NOCASE` by default). The declared shape wins where it speaks: `handle text collate binary primary key` keys BINARY, and the body's matching implicit-BINARY output still satisfies the strict check above. Only an *undeclared* collation takes the module's. See [module-authoring.md § `normalizeCreateSchema`](module-authoring.md#normalizecreateschema--what-would-this-schema-become).

**The `maintained (columns)` rename list.** The optional column list before `as` is the live-create analogue of the MV-sugar `(a, b)` renames, and the single source of truth for `derivation.columns` on **every** consumption channel — live exec, catalog import, and the declarative differ all agree on it:

- **Omitted (implicit).** The body must derive the declared column **names** exactly (the strict check above). `derivation.columns` is recorded as `undefined`, so the canonical DDL stays clause-free and a `select *` body **reshapes** its source on reopen (the widened shape is adopted, not rejected).
- **Present (explicit).** The list must match the declared column names **positionally and case-insensitively** — a wrong-arity or mis-named list is a **sited error**, never a silent drop, and an empty list (`maintained () as`) is rejected at parse time. The list is then the authoritative output-name vector: the body outputs are renamed positionally to it (so the body need not be aliased to the declared names — `maintained (key_id, val) as select id, v from src` is valid), while types, nullability, collations, and the physical primary key stay strict. The list is recorded as `derivation.columns` in the **declared casing**, so presence **arity-locks** the table — a source widened between sessions is a sited error, not a reshape.

Because the clause is the one source of truth, live exec and catalog import of the same canonical DDL agree on both `derivation.columns` and the body hash: live-create → persist → reopen → re-persist is a byte-identical fixed point, and a migration script replaying canonical catalog DDL (including the renamed-MV form) consumes live exactly as import does.

**Canonical DDL.** The table form is the one canonical persistence/export rendering for **every** maintained table regardless of authoring surface (`generateMaintainedTableDDL`): catalog persistence, `schema()` output, and schema export all emit `create table … maintained [(columns)] as`, and the import path consumes it (an MV-sugar entry still imports, normalizing identically). A sugar MV's explicit column list (renames) becomes the table's declared column names; the body keeps its original output names. The rename list **also rides the `maintained (columns)` clause** — that presence is the lossless signal distinguishing an explicit rename (arity-locked: a source widened between sessions is a sited error, the durable backing preserved) from an implicit `select *` body (the clause is omitted, so a widened source **reshapes** on reopen to follow the new shape). Import recovers `derivation.columns` from the clause, never from the declared column list (which is always present and so cannot carry that distinction).

### `ALTER TABLE … SET MAINTAINED AS` (attach / re-attach)

```sql
alter table X set maintained [(col, ...)] as <body … [with defaults (col = expr, ...)]>;
```

Attaches a derivation to a plain table — or atomically replaces an already-maintained table's derivation (the body-change primitive). There is deliberately **no** `using` clause: the module is the table's identity and never changes via attach. The optional `(cols)` rename list (mirroring the `maintained (columns)` create form) renames the body outputs positionally to the authored names and records them explicitly — the differ's lossless encoding of an MV-sugar `(a, c)` rename. Attach **verifies by diff** — it never trusts existing rows blindly and never refills wholesale:

1. the body plans (rewrite-suppressed) and the create-time gates run — determinism, keyed-or-coarsened body, relational output, full-rebuild size threshold — identical to create;
2. the derived shape is reconciled against the table's shape — the verb **reshapes the backing in place** rather than erroring on a shape change (see *Reshape-on-attach* below): a **bare** re-attach follows the body's natural names, a `set maintained (cols) as` re-attach renames the backing to the authored names on a same-arity name drift. A count/type/physical-PK change keeps the strict error naming the first mismatching component, an authored list whose arity disagrees with the body is a sited error, and a reorder/swap is an inexpressible reshape — none mutates catalog or data;
3. a body that would close a **derivation cycle** — `alter table A set maintained as select … from B` where B's derivation transitively reads A, including the degenerate self-reference — is rejected with the cycle path in the diagnostic (the maintenance cascade's depth guard stays as defense-in-depth);
4. the body is evaluated once, and duplicate derived keys (a [coarsened-key](#coarsened-backing-keys) collision present in the source) reject loudly naming the key, with table and catalog untouched;
5. the table's current effective contents are reconciled against the derived contents by **keyed diff** — the same collation-aware pairing and byte-faithful identical-row skip as the full-rebuild floor's `'replace-all'` op: identical derivable content ⇒ **zero row writes and zero reported changes**; divergence ⇒ **derived content wins** (changed rows upsert, extra rows delete), reporting only the genuine per-row changes — which cascade to consumer maintained tables exactly like source writes. The writes land in the connection's pending transaction state, committing/rolling back in lockstep with the statement.

On success the derivation is stamped, row-time maintenance registers, covering links re-prove, and `materialized_view_added` (fresh attach) / `materialized_view_modified` (re-attach) fires so store catalogs persist the canonical form; the key-coarsening warning fires exactly as on create. Blind trust remains the *rehydrate* fast path's domain, where clean-shutdown attestation gates it — the verb has no such attestation, attach is a rare lifecycle event, and one body evaluation deterministically heals any lag while staying non-destructive to row identity (the property a future sync change-log opt-in depends on).

The optional `(cols)` rename list selects how `derivation.columns` is recorded — the single source of truth for the implicit/explicit signal across every channel: **present** ⇒ the authored list is recorded **explicit** (body outputs renamed positionally to it), exactly as the `maintained (columns)` create form; **absent** ⇒ the **implicit** form (`undefined`), identical to what an MV-sugar/`maintained as` create records. A sugar MV re-attached by the bare verb keeps its clause-free canonical DDL and its `bodyHash`, so the next [declarative diff](#declarative-schema-integration) of the unchanged declaration computes the same implicit hash and does not churn a phantom re-attach; a differ that re-attaches an **explicit** MV carries the list so the explicit `bodyHash` round-trips and the declaration converges.

**Reshape-on-attach.** The verb is the reshape-permitting path — create and catalog import keep the strict declared-shape error. When the derived shape differs from the live table the backing reshapes **in place** rather than erroring, the same "the body owns the shape" contract the refresh reshape and the implicit table form's reopen already honor. Two modes:

- **Bare re-attach (no rename list)** follows the **body's natural names**. This is now permitted over a prior-**explicit** record too: `set maintained as <body>` over an `(a, b)` table abandons the authored list, relabels the backing to the body's names, and records an implicit derivation — the deliberate "go implicit" re-attach (the use the plan-free differ emits when a declaration drops its rename list, or for a renamed output column on a bare sugar MV).
- **`set maintained (cols) as`** renames the body outputs positionally to the list and relabels the backing to those names on a same-arity output-**name** drift `(a, b) → (a, c)` — rows are relabeled, not rebuilt. A renamed **primary-key** output column is allowed (matched through the reshape's rename map, so it is *not* a key change). This is the form a differ emits to converge an explicit MV whose rename list changed.

Mechanics (shared by both modes):

- the delta classifies through the refresh path's classifier (`classifyBackingReshape`): any combination of **trailing** adds, drops, positional renames, and per-column attribute (type/collation/not-null) changes, with the physical primary key unchanged, is expressible; an **interleaving** reorder, a **reorder/swap**, or a **physical-PK definition change** raises the sited inexpressible-reshape error with the table untouched (a maintained table's PK is its replicated row identity — never silently re-keyed). An authored `(cols)` list whose arity disagrees with the body's output count is a sited error *before* anything is recorded;
- the structural, data-lossless ops (rename/add/loosen/drop) apply *before* the verify-by-diff reconcile; the reconcile then reports only the **genuine per-row value changes** (a pure relabel reports zero — the rename op carries the old values and the keyed diff skips byte-identical rows); the data-validating attribute ops (retype/recollate/tighten-NOT-NULL) apply *after*, validating the reconciled body rows rather than the stale backing — mirroring the refresh reshape's two-phase split;
- because the module's `alterTable` validates **committed** contents, a reshape that carries data-validating attribute ops commits the reconcile **eagerly** before applying them (refresh-parity commit-first semantics). The structural module ops are non-transactional regardless, so a reshaping attach is DDL-grade — not DML-grade — atomicity: a mid-reshape failure leaves the table coherent and re-runnable (catalog tracking the module; on a re-attach the prior derivation is restored **stale** over the reshaped backing, recoverable by refresh), but is not rolled back wholesale;
- a reshape changes the table's column **shape**, so in addition to the ordinary `materialized_view_modified`/`materialized_view_added`, one **`table_modified`** fires (exactly as the refresh reshape does): consumer maintained tables over the reshaped table go stale and re-derive on their own refresh, and cached plans scanning the table recompile. A same-shape attach still fires no table event.

### `ALTER TABLE … DROP MAINTAINED` (detach)

```sql
alter table X drop maintained;
```

Removes the derivation — catalog-only, nothing physical changes: the table keeps its rows (and name, module, indexes, tags), row-time maintenance stops, staleness state leaves with the derivation (detaching a *stale* maintained table is allowed), covering-structure links un-stamp (UNIQUE enforcement falls back to the auto-index), and the table becomes ordinary and user-writable. One `materialized_view_removed` fires — store catalogs delete the persisted maintained entry (a store-hosted table's plain bundle is already clause-free) and cached statement plans over the table invalidate (a cached write-through plan must not survive the flip). Deliberately **no** `table_modified`: the table's shape and rows are unchanged, so consumer maintained tables reading X stay live — subsequent user writes to X drive their maintenance exactly like any source writes.

### `CREATE MATERIALIZED VIEW` (sugar)

```sql
create materialized view mv [if not exists] [(col, ...)]
  [using <module>(...)]
  as <body>
  [with tags (...)];
```

Normalization sugar for the table form: the declared shape is *derived* from the body instead of authored (the explicit column list supplies renames). Semantically identical to a `create table … maintained as` whose declared columns are the derived shape.

- `<body>` is any relation-producing `QueryExpr` with a provable unique key (see [Maintenance strategy](mv-maintenance.md#maintenance-strategy)). An explicit column list renames the body's output columns (arity must match).
- `using <module>(...)` places the maintained table in the named [backing-host](mv-backing-host.md#backing-host-capability) module; omitted ⇒ the in-memory default (`mem` is an alias for `memory`). An unknown module or one without the capability is rejected at build time. An explicit `using memory()` with no args normalizes to the same schema record as an omitted clause.
- There is **no** `with refresh = '...'` clause. Every materialized view is row-time maintained.
- A body that references the view's **own name** is rejected at create and at catalog import ("body may not reference the view itself") — lexically expressible, since the table registers under the view's name before the fill, but with no defined semantics.
- The body is evaluated immediately and the result stored. On any failure during the fill — or if the body is rejected (see [Maintenance strategy](mv-maintenance.md#maintenance-strategy)) — the table is rolled back (from the named module) and the MV is **not** registered; a create is all-or-nothing.
- `refresh materialized view` and `drop materialized view` work on **any** maintained table, however it was authored.

### `REFRESH MATERIALIZED VIEW`

```sql
refresh materialized view mv;
```

Re-evaluates the body against current source data and atomically replaces the maintained table's contents via the backing host's `replaceContents` (in the memory module, `replaceBaseLayer` builds a fresh base layer and swaps it under the schema-change latch; readers use start-of-call snapshot isolation, so a concurrent scan sees either the old contents or the new — never a torn state). A table-form maintained table that declares an applicable CHECK or (enforcement-on) child-side FK instead routes the swap through `applyMaintenance('replace-all')` + the bulk constraint scan + a commit-first commit, so a stale-refresh re-validates the recomputed set before committing it (see *Derived-row constraint validation*) — observably the same atomic replace, with declared-constraint enforcement added.

**Shape-aware.** Refresh first re-derives the backing *shape* (columns/types/PK/ordering) from the re-planned body (`deriveBackingShape`) and compares it to the live table (`backingShapeMatches`):

- **Unchanged shape (the fast path):** the data-only swap above runs (constraint-less via `replaceContents`; a constraint-bearing table-form table via the validating `applyMaintenance('replace-all')` path), so the `TableSchema` identity is preserved and cached prepared plans / the optimizer's MV-body-root cache stay warm. This is the common periodic-refresh case.
- **Shifted shape (identity-preserving reshape):** a source `alter` can shift the body's output shape. Refresh reconciles the live maintained table to the re-planned body **in place** — the *same table incarnation throughout* — by computing the column-level delta old→new (`classifyBackingReshape`) and applying it through the host module's `alterTable` around the data reconcile (`reshapeBacking` → `rebuildBacking`). An **expressible** delta is any combination of **trailing** column adds, dropped columns, positionally renamed columns, and per-column attribute (type / collation / not-null) changes, **with the surviving columns' relative order and the physical primary key preserved**. The reshape runs in **two phases around the reconcile**, split by whether an op can throw on the data it touches: the **structural, data-lossless** ops (renames, adds — always NULLABLE, drops, NOT NULL *loosenings*) apply *before* the reconcile and the reshaped schema re-registers; then the body reconcile swaps in fresh rows (the insert paths do not re-validate values against the column schema); then the **data-validating** ops — a narrowing *retype*, a *recollate*, and every NOT NULL *tightening* — apply *after* the reconcile, so they validate the **reconciled body rows** (which satisfy the new attribute) rather than the about-to-be-discarded backing. This is why a passthrough column whose source type/collation narrows reshapes cleanly even when the table went **stale** on an earlier source change and the stale backing still holds pre-narrowing values: the deferral validates the clean re-derived body, not those discarded rows, so no spurious MISMATCH/CONSTRAINT fires. No `table_removed`/`table_added` fires — only one `table_modified` on the table's own name, which invalidates any cached prepared plan scanning it directly and cascades staleness to consumer MVs (they go stale and recover by their own refresh, exactly as for any source alter — they are **not** incarnation-cascaded). Because only the structural ops run before the schema re-registers, the catalog schema and the module's live schema cannot diverge on a partial failure; a genuine post-reconcile failure (a body the new attribute still cannot satisfy, or the reshaped body duplicate-producing under the PK) throws *after* the catalog is consistently re-registered with the reconciled body, leaving the MV `stale` over a coherent, re-runnable table that converges once the underlying data is fixed.
- **Inexpressible shape (sited error):** an **interleaving** column reorder — most visibly a `select *` *join* body whose new source column lands *mid-output*, before existing columns (append-only `addColumn` cannot place it; renaming survivors to fake it would silently re-map values) — or a **physical-PK definition change** (the key's column set, order, direction, collation, or a key column's logical type) is a **sited error**: *"the derivation's output shape changed incompatibly with table `<name>`; alter the table to the new shape and re-attach, or drop and recreate"*. The table and its rows are left **untouched** and the derivation stays `stale`, recoverable by the declarative detach→alter→attach route or an explicit drop + recreate. A maintained table's PK and positional layout are its replicated row identity, so an incompatible reshape is an actionable error rather than an identity-destroying drop+recreate. A host module **without** `alterTable` raises the same sited error (parity with rename propagation — never drop a durable module's table to reshape it).

> NOTE: `deriveBackingShape` reads the backing column list positionally off the **optimized** body plan, so an optimizer rewrite that changes a body's output column order changes what a fresh backing stores. `rule-groupby-fd-simplification`'s order-restoring cap did exactly that: a grouped body whose FD simplification permutes (`select g, v, count(*) from pk group by g, v`, `v` the primary key) used to derive a backing in the shifted order and now derives it in select-list order — the new order is the correct one, matching the body's select list. A backing **persisted before that fix** therefore holds the old order; which `classifyBackingReshape` arm a pure permutation lands on (expressible positional rename vs. inexpressible interleave) has not been analyzed, and no migration exists. Only reachable via a durable store module — the memory module re-derives on open — and only for MVs created before the fix; if pre-fix persisted MVs ever need to survive a version bump, this is the site to start from.

An MV with an **explicit column list** (`mv(a, b, c)`) whose body output *count* shifts under a source change is **not** silently reshaped — refresh errors with a "drop and recreate" diagnostic, since the column list is a declared interface. After an in-place reshape, row-time maintenance is re-registered against the new backing shape (see [Schema-change staleness](mv-schema-change.md#schema-change-staleness)).

**Attribute-sensitive constraints are enforced under the FINAL column attributes.** A *retype* (`set data type`) and a *recollate* are both **post-reconcile** ops, and must stay there — they convert/re-key **stored** rows, so running them before the reconcile would scan the about-to-be-discarded backing and throw spuriously. But a SQL comparison takes its **affinity** and its **collation** from the column's *declared* attributes, so a constraint scan against the live (pre-op) catalog record would resolve a declared CHECK under the attributes the reshape is *replacing*: `check (v < '9')` on a column moving `TEXT → INTEGER` would compare lexicographically (`'10' < '9'` is true) rather than numerically (`10 < 9` is false), and `check (v <> 'abc')` on a column moving `BINARY → NOCASE` would admit a row `'ABC'`. The fix is not a reordering: the constraint-bearing `rebuildBacking` scan is handed a **preview of the reshaped columns** (`previewReshapedColumns` — the live columns with only `logicalType` and `collation` overridden from the target shape), so it resolves every comparison under the attributes the reshape is about to land while still running at exactly the same point in the sequence. Consequences: an offending row is **rejected before the commit** with the maintained-table-attributed diagnostic, nothing is written, the pre-refresh contents survive, and the table stays `stale` — the same guarantee the non-reshape arm gives. **Commit-first ordering is preserved unchanged** (the scan still precedes `conn.commit()`, and the post-reconcile ops still scan committed contents), and the **attach reshape** path passes the same preview at its own call site, so `refresh` and `set maintained as` reject identically. Because the post-reconcile ops never run on a rejected refresh, the catalog column keeps its **old** type/collation after a rejection; correcting the offending source data and refreshing again completes the reshape. Two attributes are deliberately **not** previewed: `notNull` (the tighten-NOT-NULL op keeps validating post-reconcile — declaring it early would let the optimizer fold a nullability-sensitive CHECK into a vacuous pass) and `defaultValue` / generated-column attributes (a reshape never moves them). Pinned in `maintained-table-refresh-revalidation.spec.ts` § *reshape arm: collation-sensitive CHECK* / *reshape arm: type-sensitive CHECK*, each with an attribute-**insensitive** control proving the ordinary validation path is undisturbed.

**Known limitation — NULL into a NOT-NULL ordering-seeded PK column.** A body `order by <col>` seeds `<col>` into the backing's *physical* primary key (`computeBackingPrimaryKey`), and a NOT-NULL source column becomes a NOT-NULL physical-PK backing column. An MV backing keeps its physical-PK columns NOT NULL — a backing *policy* the refresh reshape enforces by masking the loosening rather than emitting it (`isPhysicalPkColumn`), not an engine constraint: `alter column … drop not null` on a key column is permitted in general ([Schema § Primary-key nullability](schema.md#columnschema)). So once the source column drops NOT NULL and later produces a NULL row, maintenance whose recomputed body holds that NULL would store it into a column the backing still declares NOT NULL. **Both maintenance vectors reject this loudly** (`CONSTRAINT`, naming the column and the MV) rather than storing the contradiction — the trade-off being that the offending write **fails** while a source NULL would land in the seeded column; recreate the view without `order by <col>` (or excluding `<col>` from the ordering) to allow nullable values. The two vectors:

- **Row-time write-through (the primary vector).** On a plain projection MV, `alter … drop not null` does *not* mark the MV stale — the body recompiles live and the row-time plan stays attached — so a NULL source insert/update would be maintained straight into the seeded PK column at the source write, *before* any refresh. This is guarded by `assertNoNullInNotNullSeededPkRowTime` (`database-materialized-views-apply.ts`), called from both `maintainRowTime` (the per-row inverse-projection arm) and `flushDeferredMaintenance` (the deferred residual/full-rebuild flush) *before* the MV-over-MV cascade. The offending skew — a NOT-NULL physical-PK backing column whose re-derived body output turned nullable — is precomputed once at plan build into `plan.nullGuardColumns` (`undefined`, hence zero per-write cost, for nearly every MV; the body-nullability term is the discriminator that keeps the common NOT-NULL logical-key PK out of the guarded set), and re-derived at exactly the moment the skew can appear because `drop not null` re-runs `buildMaintenancePlan`.
- **Refresh rebuild.** A `refresh` whose recomputed body holds the NULL is rejected by `rebuildBacking` → `assertNoNullInNotNullSeededPk` (`runtime/emit/materialized-view-helpers.ts`), so the MV **cannot be refreshed** while a source NULL persists in the seeded column. Retained as defense-in-depth: because the row-time guard now rejects the NULL at the source write, a non-stale MV's backing can no longer reach a NULL-in-seeded-PK state through DML; the refresh guard still covers a stale MV whose reshape-arm refresh recomputes the NULL, plus catalog-import / future-bypass paths.

Scope caveat: the create/import path is unaffected (it derives the backing NOT-NULL flag from the source at that moment, so a nullable-source ordering column seeds a *nullable* PK column that self-consistently stores NULL — the permitted case, not rejected). The lasting fix that removes the pinned-NOT-NULL column entirely — expressing body order as a materialized secondary index instead of seeding the physical PK — is `backlog/debt-mv-ordering-seed-to-materialized-index`. Pinned in `materialized-view-refresh-reshape.spec.ts` § *NOT-NULL ordering-seeded PK guard* (both the refresh and row-time sub-describes).

Because row-time maintenance keeps the backing consistent continuously, `REFRESH` is **not required for currency**. It is retained as an explicit resync verb — useful to recover a [`stale`](mv-schema-change.md#schema-change-staleness) MV after a source schema change (including a body-shape shift, which the rebuild above repairs), and as the mechanism behind declarative drop-and-recreate on a body change.

### `DROP MATERIALIZED VIEW`

```sql
drop materialized view [if exists] mv;
```

Drops the maintained table — one record, one drop: the table, its rows, and its derivation go together (maintenance is detached, covering links are unlinked, and `table_removed` + `materialized_view_removed` both fire so persisted catalogs forget both entries). Because the MV *is* a table, `drop table mv` performs the **same** whole-record drop. `DROP VIEW` rejects a materialized-view name and redirects to `DROP MATERIALIZED VIEW`; conversely `DROP MATERIALIZED VIEW` on a plain table/view name redirects to the right statement. Either spelling is **refused** while a stored rule can still reach the MV — an assertion's CHECK body, or another table's CHECK constraint / column `default` / `generated always as` body — directly or through a chain of view / materialized-view bodies, in which case the refusal quotes the chain. See [sql-ddl.md § 2.6.1](sql-ddl.md#261-createdrop-assertion-global-integrity-constraints) for the assertion arm and [sql-ddl.md § CHECK Constraints](sql-ddl.md#26-create-table-statement) for the expression arm.


## Maintenance strategy

> **Invariant:** [MV-006](invariants.md#mv-006--no-body-is-rejected-for-its-shape), [MV-007](invariants.md#mv-007--the-strategy-gate-can-be-slow-never-wrong)

Every materialized-view body is maintainable; the only question is *how cheaply*. At create the manager picks the cheapest **structurally-sound** strategy via a backward (maintenance-direction) cost gate, falling back to an always-correct **full-rebuild floor**. **No body is rejected for its shape.** Five create-time rejections remain, none shape-based: a non-deterministic body, a bag body with no provable unique key, a body with no relational output, a body that reads no source table, and a full-rebuild-only body over a source past the configurable size threshold.

See [Materialized-View Maintenance](mv-maintenance.md#maintenance-strategy) for the four bounded-delta shapes, the [full-rebuild floor](mv-maintenance.md#full-rebuild-floor), the host-conditional replicable-determinism gate, and the size threshold.

## Query resolution

A reference to `mv` in a query resolves through the **ordinary table path** — the table *is* the materialization, so the reference is a plain `TableReferenceNode` against it, not a body expansion. Reads therefore go straight to the stored rows and cost like a table scan, not like re-running the body. The one derivation-specific step is the build-time [`stale`](mv-schema-change.md#schema-change-staleness) re-validation guard, which still runs on a derivation-bearing table reference. (An unqualified MV reference resolves against the current schema; a materialized view in a non-current schema must be qualified.)

### Automatic query rewrite (read side)

The above is the *named* read path. There is also an **automatic** path: the optimizer recognizes when an *arbitrary* scan-projection-filter query — one that **never names** the MV — is *answered from* a covering MV, and rewrites it to scan the maintained table itself with a residual projection/filter instead of recomputing the body against the base tables (a plan shows a scan of `mv`, the table's own name). This is the read-side dual of the [coverage prover](mv-constraints.md#explicit-covering-structures-the-coverage-prover) (which proves a base-table `UNIQUE` constraint is covered, on the write/enforcement side).

```sql
create materialized view recent as
  select id, customer_id, amt from sales where amt > 0;

-- never names `recent`, but the optimizer answers from it:
select customer_id, amt from sales where amt > 0 and customer_id = 7;
--   → scan recent, residual filter (customer_id = 7), residual project (customer_id, amt)
```

The matcher (`planner/analysis/query-rewrite-matcher.ts`) asks **output-relation subsumption**: does the MV's stored rows contain a superset of the rows the fragment produces, keyed so a bounded residual recovers exactly the fragment's output? It reuses the coverage prover's entailment vocabulary (`recognizeConjunctiveClauses` / `guardClausesEntail`), so NULL semantics are identical. Soundness mirrors the prover exactly — **a false NotMatch only forgoes a speedup; a false Match would return wrong rows** — so every check forgoes the rewrite on doubt. The rule (`planner/rules/cache/rule-materialized-view-rewrite.ts`) only ever *replaces* the correct recompute-over-base plan with a provably row-equivalent backing scan, so it is non-regressing (a no-op when nothing matches or the cost gate declines, byte-identical rows when it fires). See [docs/optimizer-rule-families.md](optimizer-rule-families.md#materialized-view-query-rewrite-read-side) for the matcher shape rules, the gates (stale / deterministic / source-schema), the cost gate, and pass placement.

The matcher handles three shapes: **projection + filter subsumption** (above), **aggregate rollup**, and **join subsumption** (both below). The rewrite is **suppressed while planning an MV's own body** to (re)compute or maintain its backing (create / refresh / row-time-maintenance compile), so a body matching a registered MV is never re-pointed at the backing it is populating (`SchemaManager.withSuppressedMaterializedViewRewrite`).

#### Aggregate rollup (indexed-view matching)

The headline case: a `group by g₁,…,gₖ agg(…)` query answered from a **grouped** MV. The matcher (`matchAggregateFragmentToMv`) fires when the fragment root is a logical `Aggregate(Filter?(scan(T)))` and the MV body is `select g…, agg(…) … group by g…` over the same single source `T`. The query GROUP BY and MV GROUP BY are mapped to **bare source-column** sets (a computed group key on either side ⇒ forgo); the query key must be a **subset** of the MV key (⊄ ⇒ NotMatch). Two sub-cases:

```sql
create materialized view daily as
  select d, sum(amt) as total, count(*) as cnt from sales group by d;

select d, sum(amt) from sales group by d;   -- exact-key  → scan daily, residual project (no re-aggregation)
select sum(amt) from sales;                  -- rollup     → scan daily, re-aggregate sum(total) into one group
```

- **Exact-key** — query key == MV key. The backing rows *are* the answer: scan the backing directly with an optional residual `Filter` on the group-key columns (a range `where g ≥ …`) and a residual `Project`. No re-aggregation, so any query aggregate that is *exactly* a stored MV aggregate (same function, argument, and `distinct`) is admitted as a passthrough — including `count(distinct)` / `group_concat`. `avg` under exact-key requires a stored `avg`.
- **Superset-key (rollup)** — query key ⊊ MV key (incl. the empty global key, the degenerate "re-aggregate every backing row into one group" case). The backing partials are **re-aggregated** down to the query's coarser key. Soundness is decided by each fragment aggregate's **declared [`AggregateAlgebra`](aggregate-algebra.md)** (`recipeForRollup`) — *not* a builtin-name list — so a built-in aggregate and a UDAF that declares the same algebra roll up through the one code path (default-deny — an aggregate with no usable algebra ⇒ forgo). A DISTINCT aggregate always forgoes (a distinct aggregate is never a plain merge of partials):

  | fragment aggregate declares | recombine over the MV's stored partials |
  |---|---|
  | **directly mergeable** — `merge` + `decode` (`sum`, `count`, `min`, `max`, and any abelian-group UDAF) | re-aggregate the aggregate's **own** stored partial by folding each stored value through the aggregate's `merge ∘ decode`, then its `finalize`. `sum`←sum-of-sums, `count`←sum-of-counts, `min`/`max`←tightening. The empty-group value falls out of `finalize(identity)` (`count`→0, `sum`/`min`/`max`→NULL), so there is no name-specific `coalesce`. |
  | **decomposable** — `decompose` (`avg` ≡ `sum(x)/count(x)`) | re-aggregate each sibling partial (each itself directly-mergeable) and apply the declared `combine` over their finalized values. avg needs the MV to store both `sum(x)` **and** a count; the count must exclude the same NULLs `avg` does — a stored `count(x)` always qualifies, a stored `count(*)` only when `x` is declared `not null`. avg's NULL/0-over-zero-rows ⇒ NULL guard lives inside `combine`. |
  | **no usable algebra**, or any `distinct` | **forgo** — `total` / `group_concat` / `var_*` / `stddev_*` (residual-only, declare no algebra) and `count(distinct …)` (the classic rollup trap: a partial `count(distinct)` cannot be re-summed). |

**Function identity.** Both sub-cases trust a stored value only while its name still resolves to the **same registration that produced it**. Function registration overwrites by `(name, argument count)`, so `db.createAggregateFunction('sum', …)` re-points `sum/1` for every later query while the backing keeps the previous function's numbers. `registerMaterializedView` therefore records the schemas the body's calls resolved to (`TableDerivation.bodyFunctions`, runtime-only — object identity cannot be serialized) and the matcher compares the live resolution against that capture by identity; a mismatch, or no capture at all, ⇒ forgo (`function-rebound`). A view built over a UDAF that is still the live registration keeps matching. Two limits: across a reopen the capture is re-taken from whatever is registered then, so a *user* function's sameness across process boundaries cannot be verified; and the **maintenance** side still runs the plan compiled at registration, so writes after a takeover are maintained with the previous semantics until refresh/re-registration.

**Soundness witnesses.** The backing's primary key must equal the MV's group key (`backingPkIsGroupKey`) — the schema-level form of the coverage prover's `proveEffectiveKeyUnique`, certifying the backing is one row per MV group, so the exact-key scan returns one row per query group and the rollup re-aggregates a *set*, not a bag. A residual `Filter` may reference only MV group-key columns (it partitions whole groups, commuting with the rollup); a `where` on a non-group column ⇒ NotMatch (the MV already aggregated those rows away).

A **rollup with a residual** is sound and admitted: the residual references only MV group-key columns (per the soundness witnesses above), so it partitions whole backing groups and the rule builds a residual `Filter` on the backing scan *before* the re-aggregate, commuting with it. That shape — `group by k` re-aggregating a composite-PK backing under `where j = const` on a non-grouped key — is covered by the equivalence harness.

#### Join subsumption

A query whose join is the **same 1:1 row-preserving inner/cross join** as an MV body's join (the row-time [`'join-residual'`](mv-maintenance.md#join-residual-11-innercross-join-shape) shape — eligibility shape 4) is answered from the maintained table, **eliminating the join at read time**.

```sql
create materialized view enriched as
  select o.id, o.customer_id, o.amt, c.name
  from orders o join customers c on o.customer_id = c.id;   -- 1:1 (NOT-NULL FK → PK)

select o.id, o.amt, c.name
from orders o join customers c on o.customer_id = c.id
where o.amt > 100;                                          -- → scan enriched, residual filter + project
```

The hard soundness question — "does this join contribute *exactly one* row per governed `T` row?" — is the coverage prover's shared `proveOneToOneJoin` (no-row-loss descent + `proveJoinNoFanout`). A 1:1 join's output relation is in bijection with `T`'s governed rows, so two 1:1 joins over the *same tables, same equi-pairs, same join type* produce the same row set. The matcher (`matchJoinFragmentToMv`) therefore:

- **proves both joins 1:1 over the same `(T, lookup)`** — runs `proveOneToOneJoin` on *both* the fragment join and the MV body join (the rule plans the MV body once, suppressed, and caches its optimized root). It requires the **same driving table `T`**, the **same lookup table**, an **inner/cross** top join on each side (outer is deferred — its null-extended rows make the stored relation differ from an inner-join query), and **equi-pair equivalence** in `(driving-col, lookup-col)` terms (a mismatch — e.g. a join on a *second* FK to the same lookup — ⇒ NotMatch, the soundness-critical guard);
- **proves projection coverage** over the joined output — every fragment output column (including lookup-side columns) must be a bare passthrough the MV stores, mapped through stable attribute ids;
- **carries the post-join WHERE as a residual**. A join MV body has **no WHERE** (the row-time create gate rejects a partial join body), so predicate entailment is trivial: the whole fragment WHERE becomes the residual `Filter` over the backing. **Read-side relaxation:** a WHERE term on a *lookup-side* column is allowed here (unlike the row-time arm's partial-WHERE restriction) — we are only *reading* the already-materialized join, so the residual filters the stored joined rows directly. The residual re-binds onto the backing by **source attribute id** (a base-column index is ambiguous across a join), and every residual column must be a stored backing column.

The replacement is the foundation's emission unchanged — backing scan → residual `Filter` → residual `Project` — because once both joins are proven equal the joined output relations are equal. The cost gate's recompute estimate now includes both base scans **plus the join cost**, so the backing scan wins decisively; cheapest-wins with the same stable-name tiebreak.

**Out of scope (deferred):** outer-join 1:1 bodies (the row-time arm defers them too); multi-join MV bodies covering a sub-join of the query (partial join matching); rollup over a join MV.

## Write boundary (write-through)

> **Invariant:** [MV-012](invariants.md#mv-012--a-maintained-table-is-read-only-to-user-dml)

`INSERT` / `UPDATE` / `DELETE` targeting an MV *name* is **rewritten to target the MV's source table `T`** and re-planned through the ordinary base-table builder — the identical AST-level rewrite plain-view mutation performs, reached via the same view dispatch wired into all three DML builders: each resolves the target with `SchemaManager.findSchemaItem(…)` — one search-path entry at a time, that schema's tables and views together — then routes a view straight through, or a maintained table through the `maintainedTableViewLike` adapter (`schema/derivation.ts`), which presents the derivation's body AST / column list / insert-defaults to the view-mutation rewrite. So an unqualified MV name resolves exactly as an unqualified table name does. The plain-table DML path checks for a `derivation` **before** treating the name as an ordinary writable table — at name dispatch and again on the schema-path-**resolved** table, a redundant second net in case the two resolvers ever diverge. Every MV is (post row-time consolidation) a single-source projection-and-filter — a strict subset of the [view-updateability](view-updateability.md) projection-and-filter shape — so write-through is pure routing, with no MV-specific propagation code. The rewritten write hits `T`, which fires the row-time maintenance hook, so the backing is brought into sync **inside the same statement / transaction**: a subsequent `select … from mv` sees the write (reads-own-writes) and a rollback reverts source + backing in lockstep. A write-through to an MV is observably **indistinguishable from writing the source and reading the MV**.

Behind this dispatch sits an engine-level **READONLY backstop** in the runtime DML executor (`runtime/emit/dml-executor.ts` `assertNotMaintainedTableTarget`): it rejects, at emit time, any mutation plan whose target still carries a derivation. The dispatch above (name check + resolved-schema backstop) is the primary path; the backstop is the defense-in-depth second net, converting a hypothetical plan-time mis-dispatch — a direct-write plan that would silently diverge the derived contents from the source — into a loud error keyed structurally on `derivation` presence (never on the table name). It is deliberately unreachable from SQL on the supported path; the privileged maintenance surface bypasses it by construction (see [§ Read-only to user DML](mv-backing-host.md#backing-host-capability)).

Per-column writeability is inherited verbatim from [view updateability](view-updateability.md):

- a **passthrough / rename** column routes the assignment/value to its base column;
- a **deterministic-expression** column (e.g. `x + 1 as y`) is **read-only** — a write to it raises the `no-inverse` diagnostic; reads are unaffected and the column is re-derived by maintenance on a passthrough write;
- an omitted column pinned by an equality selection predicate (`… where color = 'green'`) is defaulted on the base via the constant-FD path; an insert that provably contradicts the predicate is rejected (`predicate-contradiction`); an update carrying a row out of the predicate scope succeeds in `T` and the maintenance update arm removes it from the MV.

This per-column reality is **introspectable**: `column_info('mv')` derives each column's `is_updatable` / `base_table` / `base_column` from the **derivation body** through the same lineage classification the write-through rewrite applies (passthrough/rename → updatable, tracing to its source base column; invertible expression → updatable through the inverse; non-invertible expression → read-only with null trace) — not as plain writable base columns. `view_info` deliberately excludes maintained tables (they list as tables in `schema()`; its per-view surface stays plain-view-only). See [view updateability § Information Schema Surface](view-updateability.md).

Two cases are **rejected** (also inherited):

- **RETURNING through an MV** raises the `returning-through-view` diagnostic (RETURNING through views is not surfaced for the MV path yet).
- **MV-over-MV write-through** — DML against an MV whose body's source is *itself* a materialized view — is rejected (`its body reads a materialized view`): its rewrite would target the inner MV's read-only maintained table. The source→backing maintenance *cascade* ([§ MV-over-MV cascade](mv-maintenance.md#mv-over-mv-cascade)) is the read/maintain direction and is unaffected; only the MV-name *write* direction one level down is deferred.

There is no `with check option` and no `instead of` trigger — the body `where` is a read-time filter, not a write-time invariant (same stance as view updateability). The *source* tables remain fully writable directly, and a source write propagates to the MV synchronously regardless of which boundary the write entered through.


## Maintenance (row-time, per-statement)

Maintenance is driven from the runtime DML write boundary, immediately after each source row is recorded, and applies inside the writing statement's savepoint. Five arms are wired — `'inverse-projection'` (per-row-immediate), `'residual-recompute'`, `'prefix-delete'`, `'join-residual'` (per-statement key-batched: affected keys dedup across the statement and recompute once each at the end-of-statement flush), and `'full-rebuild'` (deferred to the same flush) — and a maintenance write into one maintained table cascades into every materialized view reading it.

See [Materialized-View Maintenance](mv-maintenance.md#maintenance-row-time-per-statement) for each arm's per-row delta, [value-identical write suppression](mv-maintenance.md#value-identical-no-op-write-suppression), the [MV-over-MV cascade](mv-maintenance.md#mv-over-mv-cascade), and the [per-statement / enforcement-visibility contract](mv-maintenance.md#synchronous-transactional-per-statement).

## Derived-row constraint validation (declared CHECK / FK / secondary UNIQUE)

> **Invariant:** [MV-017](invariants.md#mv-017--declared-constraints-are-validated-against-derived-rows-before-the-cascade)

A `create table … maintained as` table may declare CHECK, FOREIGN KEY, and secondary UNIQUE constraints. Derivation writes bypass the DML constraint pipeline, so those constraints are validated by their own mechanisms — a bulk scan on the create/attach/refresh paths, a compiled per-row validator in steady state — and the writing statement fails, attributed to the maintained table, when a derived row violates one. A maintained table may also be an FK *target*, which gets its own parent-side hook.

See [Derived-Row Constraints and Covering Structures](mv-constraints.md#derived-row-constraint-validation-declared-check--fk--secondary-unique).

## External row-change ingestion

> **Invariant:** [MV-021](invariants.md#mv-021--the-ingestion-seam-trusts-its-origin-and-re-validates-nothing)

`Database.ingestExternalRowChanges(changes, options?)` is the batch seam by which a host that has applied row changes **directly to module storage** — sync-inbound replication, a direct row-store write — reports them so the post-write pipeline (materialized-view maintenance, watch capture, optional foreign-key actions) runs anyway, inside the coordinated transaction. The seam re-validates nothing: it trusts the origin.

See [External row-change ingestion](mv-ingestion.md) for the facets, the trust boundary, the transaction and visibility contract, and when to prefer DML replay instead.

## Schema-change staleness

> **Invariant:** [MV-022](invariants.md#mv-022--a-stale-view-serves-its-snapshot-and-propagates-nothing)

Row-time maintenance keeps a materialized view consistent with its sources' *data*. A *schema* change to a source can break the body outright, so the manager marks affected views **stale** — serving their last snapshot, propagating no writes — until a `refresh` (or a drop-and-recreate) recovers them. Changes a body provably cannot observe recompile in place instead, and a rename rewrites the body rather than staling it.

See [Schema-change staleness](mv-schema-change.md) for the recompile-in-place rules, rename propagation, and which `ALTER TABLE` actions a maintained table accepts on itself.

## Change-scope projection

A `select` from a materialized view is an ordinary table reference, so `Statement.getChangeScope()` would naively report the maintained table itself. A watcher on a view usually means "tell me when the data behind it moves", which is *source* granularity, so the manager caches a **source-union change-scope** on the derivation at registration (`TableDerivation.sourceScope`, a `full` watch per source via `buildSourceUnionScope`), and change-scope analysis substitutes it for a maintained-table reference — a watch projects to sources (see [change-scope.md](change-scope.md#materialized-view-reference-projection)). A `Database.watch` on such an MV therefore fires on a **source** mutation.

The substitution **widens** granularity; it is not what makes the watch fire. A maintained table is change-logged in its own right — row-time maintenance records each realized backing delta (see [incremental-maintenance.md § Recording changes](incremental-maintenance.md#recording-changes)) — so a watch left on the maintained table would fire too. That is also why a chain works: the projection is one level deep, so `scope(mv2)` for `mv2` over `mv1` names `main.mv1`, which fires only because `mv1` is itself change-logged.

A precise per-source row/group scope, mirroring the maintenance projection the manager already derives, is a future refinement.

## Declarative-schema integration

> **Invariant:** [MV-013](invariants.md#mv-013--bodyhash-is-the-identity-of-the-definition)

Maintained tables participate in the [declarative-schema](schema.md#declarative-schema) pipeline. A `declare schema { ... }` block accepts a `materialized view` item — or the equivalent `create table … maintained as` table form; both normalize to the **same** declared record, so they compare equal against the same live maintained table:

```sql
declare schema main {
  table t { id integer primary key, x integer not null }
  materialized view mv as select id, x from t
}
apply schema main;
```

Because a maintained table **is** a table ([substrate](#substrate-a-maintained-table)), the differ compares it in the **table category** — one comparison per table name, no separate materialized-view diff bucket. The derivation is one more dimension of that per-name comparison, recognized via the [lifecycle verbs](#ddl-statements) (`set maintained as` / `drop maintained`) as **non-destructive alter ops** — never an incarnation-destroying drop+recreate, which would mint a new [backing-host](mv-backing-host.md#backing-host-capability) incarnation and so destroy a replicated table's row identity.

- **DDL round-trip.** `apply schema` and schema export emit canonical DDL via `ast-stringify`, so a schema survives `schema → DDL → parse → schema` with no shape change.
- **Definition-change re-attach (refresh, not rebuild).** The differ keys derivation-change detection on `bodyHash` (`toBase64Url(fnv1aHash(<canonical definition>))` — the explicit column-rename list + canonical body SQL, where the body SQL itself carries the trailing `with defaults` clause, rendered by `viewDefinitionToCanonicalString`; shared by MV creation, the rename-propagation rewrite, and the differ). When a declared maintained table's body hash differs from the live `derivation.bodyHash` **and** its declared shape is unchanged, the differ schedules a single [`alter table X set maintained as <new body>`](#alter-table--set-maintained-as-attach--re-attach) — a **re-attach**. This is a *content refresh*: the new body re-derives and reconciles by keyed diff (derived content wins), preserving the table's physical incarnation and any unrelated rows' identity. No `table_removed`/`table_added` fires. An in-diff source table/column rename is reconciled before the hash compare so a pure rename never churns a spurious re-attach (see [schema.md](schema.md)). An unchanged definition produces an **empty diff** — no phantom re-attach.
- **`table → maintained` (attach).** Declaring a `maintained as` clause (or a `materialized view`) over a name currently registered as a plain table schedules [`alter table X set maintained as <body>`](#alter-table--set-maintained-as-attach--re-attach) — an **attach**. The verb reconciles the live table's rows against the derived content by keyed diff: zero row writes when the content is already derivable, derived-wins otherwise. A plain table whose columns differ from the body (a sugar fresh-attach carries no column ops on the diff) reshapes via the verb's reshape-on-attach — the plain rows are discarded by the reconcile anyway, so following the body is correct.
- **Sugar-MV output-column rename ⇒ re-attach reshape.** A declared sugar MV normalizes with `columns: []` (the body owns the shape), so the **plan-free** differ cannot derive the body's output shape to see that a rename needs a reshape — it detects only the `bodyHash` drift and emits a `set maintained` re-attach. The differ carries the **declared** rename list verbatim onto that op (`undefined` for an implicit/sugar-without-list MV; the authored names for an explicit `mv (a, b)`), and `generateMigrationPlan` renders it as the `set maintained (cols) as` form (or the bare `set maintained as` when absent). So both forms converge in a single `apply schema`: an **implicit** MV whose output column is renamed in the body relabels the backing to the body's natural names (going implicit) via the verb's reshape-on-attach, and an **explicit** MV whose rename list changes (`mv (a, b)` → `mv (a, c)`) is relabeled in place by the `set maintained (a, c) as` verb (the backing column `b → c` is renamed, `derivation.columns` re-records `(a, c)`) — rows are relabeled, not rebuilt, and the table incarnation survives. The differ never compares or synthesizes the rename; it simply hands the verb the authored list, and the verb's strict count/arity check (so a body whose *output count* shifted under an explicit list stays a sited error, never a silent widen/narrow) does the reshape.
- **`maintained → table` (detach).** Declaring the same name as a plain table (dropping the `maintained` clause) schedules [`alter table X drop maintained`](#alter-table--drop-maintained-detach) — a **detach**. The table keeps its rows and becomes an ordinary writable table; nothing physical moves.
- **Body change *with* a concurrent declared-shape change.** When the body drifts *and* the declared column/PK/constraint shape also drifts, the differ emits `drop maintained` → the column ops → `set maintained as` (detach → reshape → re-attach). The new column's values arrive via the attach reconcile.
- **Undeclared live maintained table ⇒ `drop table`.** A maintained table present live but absent from the declaration is dropped like any undeclared table — it *is* a table.
- **Tags-only change ⇒ `set tags`, never a re-attach.** Tags are excluded from the canonical definition, so a tag-only drift takes the in-place tag alter.
- **Apply ordering.** In `generateMigrationPlan`, `drop maintained` (detach) ops run **early** — where MV drops ran before, ahead of table alters/drops — so a detach precedes column ops on that table and may precede a drop of its former source. `set maintained as` (attach/re-attach) ops run **late** — after table creates/alters — so the target's final shape and the body's sources all exist. The flip's cross-table pair (detach the producer, attach the consumer) falls out of this ordering naturally.
- **Backing-module change ⇒ destructive drop+recreate (ack-gated).** A `using <module>(args)` change on a maintained table **is** detected and migrated. Both sides of the comparison are normalized (`normalizeBackingModuleName` — absent/`mem` ⇒ `memory`, lowercased — and `canonicalBackingModuleArgs` — stable sorted-key render, absent ⇒ `''`), and the live module is carried on the catalog entry (`CatalogTable.maintained.backingModuleName` / `.backingModuleArgs`), so the two spellings of the memory default never drift. A backing-module move physically relocates the table to a different store with no in-place primitive, so the differ schedules a **destructive `drop table` + `create materialized view … using <newmodule>`** (recorded in `SchemaDiff.maintainedModuleMigrations`): the recreate re-materializes the body into the new module, **minting a new incarnation** (`materialized_view_removed` then `materialized_view_added` fire) — distinct from the non-destructive body re-attach above, which preserves the incarnation. Because a new incarnation changes row identity for a replicated/synced table, `apply schema` **refuses** the migration unless acknowledged via `options (allow_destructive = true)`; the whole apply aborts before any DDL runs if the flag is absent. `diff schema` surfaces the full DROP/recreate DDL unconditionally (it is a read-only preview). When the module move coincides with a body and/or shape change, the recreate subsumes them — exactly one drop+recreate, no separate `set maintained as`. A `using` change on a **plain** (non-maintained) table is still undetected — plain tables track no backing module.


## Covering structures

A UNIQUE constraint is *logical*; the structure that enforces it is *optional* and may take more than one physical shape — the auto-built secondary BTree, or a user-declared materialized view whose shape the **coverage prover** admits. Quereus describes both in one vocabulary, the **covering structure**, so the enforcement layer and the [lens layer](lens.md) above it pattern-match a single surface.

See [Derived-Row Constraints and Covering Structures](mv-constraints.md#covering-structures) for the prover's rules and how a covering materialized view answers a UNIQUE conflict.

## Current limitations

What a materialized view does **not** do today. The design detail for each — what would have to
be built, and what makes it hard — lives in [`docs/todo.md` § Materialized views](todo.md#materialized-views).

- **No bounded-delta arm for a fanning join, an outer 1:1 join, or a scalar aggregate.** They are maintained correctly by the [full-rebuild floor](mv-maintenance.md#full-rebuild-floor); a bounded-delta arm would only make them cheaper.
- **The `'inverse-projection'` arm applies per source row, never coalesced across a statement** — its per-row backing visibility is load-bearing for covering-UNIQUE enforcement. The [residual arms and the full-rebuild floor](mv-maintenance.md#synchronous-transactional-per-statement) flush once per statement (their backings are never read by enforcement mid-statement).
- **A body with no provable unique key — and no [coarsened lineage key](#coarsened-backing-keys) — is rejected at create.** There is no row identity to materialize on. Bag (multiplicity-keyed) backings would lift this.
- **No concurrent refresh** beyond the current atomic base-layer swap.
- **No MV-over-MV write-through.** DML against a materialized view whose source is itself a materialized view is rejected.
- **A covering materialized view with a non-binary leading key falls back to a full backing scan**, not the prefix scan.
- **`Database.watch` on a materialized view projects to a `full` watch per source**, not a per-source row/group scope.
- **No host declares `requiresReplicableDerivations` yet.** The create-time replicable-determinism gate exists and is [wired](mv-maintenance.md#maintenance-strategy), but stays inert until a replicating backing host (the future sync-store) turns it on. See [Migration § Determinism requirements](migration.md#determinism-requirements).
- **Lens / layered schemas** — indexes and set-level constraint enforcement expressed as covering materialized views in the basis layer — are their own subject. See [Lenses and Layered Schemas](lens.md).
