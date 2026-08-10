# Mutation Context

> **Stability: Beta** — see [Stability Tiers](stability.md#tiers).

Part of [View Updateability](view-updateability.md) — see there for the overview and the update-site model.

The `with context` envelope (see [Sequential ID Generation](architecture.md#sequential-id-generation)) wraps the entire view-mediated mutation. It is also the mechanism by which **generated values enter at the propagation boundary while DML stays deterministic**.

Determinism in Quereus means a statement's effect is a pure function of database state and *captured context* — non-deterministic inputs are not forbidden; they are captured once at the envelope, recorded, and replayed identically. A view-mediated mutation frequently needs a value present at neither the user-visible relation nor the inserted row: a surrogate key that several base tables share, a sequence value, a creation timestamp. Such a value is supplied by a **generated default** on the base column (a sequence, a surrogate allocator, a clock read), evaluated through the context envelope and recorded with the statement. The propagation is therefore deterministic-given-context, and the generation is a context concern, identical to how sequential IDs and captured timestamps already work.

Bindings have two cadences:

- **Per-statement** — a captured `now`, a bound parameter. Evaluated once; stable across every row and every base operation the statement emits (transaction-time semantics).
- **Per-row** — a sequence, a surrogate allocator. Evaluated once *per top-level row produced*, so a multi-row insert mints a distinct value per row. The captured context records the per-row values, preserving replay.

## Forwarding: one envelope, many base tables

A view-mediated write decomposes into one statement per underlying base table, and the
statement's `with context` envelope is forwarded **verbatim** to every one of them. The
base tables need not agree on what they declare, so each member resolves the envelope
against its own `with context (...)` declaration:

- Names the member **declares** take their value from the envelope.
- Names the envelope supplies that the member does **not** declare are **ignored**, not
  rejected. This leniency is load-bearing — it is what lets one envelope serve members
  with different declarations. The cost is that a mistyped name reads as NULL instead of
  being reported.
- Names the member declares that the envelope **omits** read NULL if declared `null`. A
  NOT NULL one that any of the member's defaults or constraints reads fails at plan time,
  and the message names the **member table** that requires it — not the view the user
  named, which does not declare context variables at all.

The per-variable rules themselves are the ordinary ones; see
[§2.6.2 Mutation Context](sql-ddl.md#262-mutation-context-table-level-parameters).

## Shared keys are ordinary defaults — the engine chooses no ID policy

> **Invariant:** [VU-007](invariants.md#vu-007--a-shared-key-is-evaluated-once-and-threaded-to-every-member)

A multi-source `insert` (and an n-way lens decomposition insert) needs a shared key that lives in neither the logical row nor any single base table. **The engine does not invent it.** The basis author declares whatever generator they want as the **declared `default` on the anchor's key column**; the engine evaluates that default **once per produced logical row at the envelope** and threads the single value into every member's key column via the **equivalence class** the synthesized (or authored) join establishes (`on k.rid = c.rid` puts the members' key columns in one EC, and the insert-defaulting EC propagation — § [Projection](vu-operators.md#projection) step 4 — carries the captured value to every branch). There is one policy: *source the value from the anchor key column's default, then EC-thread it.* A `surrogate` key (distinct from any logical column) is sourced this way; a `logical-tuple` key (the key IS a supplied logical column) threads the supplied value with no default; and a `not null` key with neither a default nor a supplied value raises the ordinary `no-default` diagnostic.

The envelope is realized as a **materialized augmented source**: it holds the per-row supplied view columns, drains them once into an array, appends the **default-evaluated** key per row, and stashes the rows in the runtime context; each base op reads them back through an envelope-scan leaf (the recursive-CTE working-table pattern), so every branch observes the identical row — there is no "which branch generates first" question. Because the materialization happens **before any base write**, a `max()` subquery inside the default observes the **pre-mutation** state for every row; the per-row ordinal (below) is what distinguishes the rows of a multi-row insert. Multi-source `update` / `delete` do not need the envelope — they address existing rows by a subquery over the join, not by sourcing a shared key.

**The `mutation_ordinal()` context primitive.** `mutation_ordinal()` is a nullary, **deterministic** builtin returning the 1-based ordinal of the row being produced within the current statement. It is the column-`default`-position analogue of `row_number()` (§ [Sequential ID Generation](architecture.md#sequential-id-generation)), reaching where a window function cannot — inside a column default. It is valid only during INSERT-default / mutation-context evaluation and errors elsewhere. Being deterministic, a default that uses only it plus deterministic state passes the schema-determinism gate with no `nondeterministic_schema` opt-out. The envelope sets it per row before evaluating the anchor default; it is equally reachable from an ordinary single-source insert's column default.

Bindings have two cadences (a general mutation-context property, independent of the shared-key mechanism):

- **Per-statement** — a captured `now`, a bound parameter. Evaluated once; stable across every row and every base operation the statement emits (transaction-time semantics).
- **Per-row** — the anchor-default shared key, a per-row allocator. Evaluated once *per top-level row produced*, so a multi-row insert produces a distinct value per row.

> **Intentional behavior change.** A surrogate decomposition previously worked with **zero configuration** — the engine fabricated integer keys (`seed + ordinal`, `seed = max(anchor.key)`). It no longer does: the basis author **must declare a `default`** on the anchor's surrogate key column (or expose the key as a supplied logical column). This is the point — the engine stops choosing an ID policy it has no business choosing. The **migration recipe** that reconstructs the old monotonic-integer behavior as ordinary SQL is `default (coalesce((select max(<key>) from <anchor>), 0) + mutation_ordinal())`.

**Worked example.** A logical `User(name, email)` is decomposed over two base relations that share a surrogate `rid`. The surrogate has nowhere to come from in the logical row, so the **anchor declares its default**; the second relation inherits the value through the join-key equivalence class:

```sql
-- basis: two relations sharing a surrogate `rid`; the anchor declares its allocator
create table u_core    (rid int primary key
                          default (coalesce((select max(rid) from u_core), 0) + mutation_ordinal()),
                        name text) using mem();
create table u_contact (rid int primary key, email text) using mem();

-- the lens get
create view User as
  select c.name, k.email
  from u_core c
  join u_contact k on k.rid = c.rid;
```

Now a two-row insert through the lens:

```sql
insert into User (name, email)
  values ('Ada', 'ada@x.io'), ('Lin', 'lin@x.io');
```

Propagation, per top-level row:

1. The envelope evaluates `u_core`'s `default` once per produced row, *before* any base write. `max(rid)` observes the pre-mutation state (0 for an empty table), and `mutation_ordinal()` is `1` for Ada, `2` for Lin — so `rid = 1`, then `2`.
2. The join predicate `k.rid = c.rid` puts `u_core.rid` and `u_contact.rid` in one equivalence class, so the captured `rid` is the value used for *both* base inserts of that row. The default fires once per row, not once per member.
3. The emitted base operations are therefore `u_core(rid=1, name='Ada')` + `u_contact(rid=1, email='ada@x.io')`, then the `2` pair for Lin.

A non-deterministic allocator (`uuid7()`, a clock read) works identically under `pragma nondeterministic_schema`: the default is evaluated **once per row at the envelope** and the single captured value threads to every member, so the members never disagree on the key — the load-bearing evaluate-once-and-thread guarantee, the same way captured timestamps replay. Had the example also carried `created int default now_ms()` with a per-statement binding, that value would stamp the same on both rows, whereas `rid` differs per row. Context bindings evaluate per their cadence and are reused across every per-base operation that consumes them.

## A default may read the in-flight row via `new.<col>` — minting vs. resolving a key

A column `default` can read the **other supplied values of the same row** through `new.<col>`. Only INSERT-supplied (or already-defaulted) siblings are visible — an omitted column raises a resolution error rather than reading a not-yet-evaluated default, so there is no evaluation-order race. The `new.`-qualified form is always available; the bare form resolves too unless a same-named mutation-context variable shadows it. On the single-source insert path this is the same row scope `mutation_ordinal()` participates in, surfaced as ordinary column references at plan-build time (no runtime-context plumbing).

The **anchor key default at the shared-key envelope** reads `new.<col>` too — e.g. `default (coalesce((select max(rid) from anchor), 0) + new.seq)` derives the minted shared key from a supplied view column. Because the key default is evaluated standalone per row (not as part of a row-producing projection), its `new.<col>` refs are bound to fresh attributes and resolved through a per-row **row slot** the envelope emitter installs over each source row — *before* the `__shared_key` is appended — for the duration of that row's evaluation.

A **member insert** of the decomposition / multi-source fan-out reaches the same `new.<col>` context — and crucially the **produced *logical* row's** context, not just the member's own supplied columns. Each member insert is re-planned through the ordinary base-table builder, and the fan-out threads the produced row's NEW context (every supplied logical column registered as `new.<col>` over the shared envelope attributes) as the **parent** of that member insert's default-build scope. So a member's column default can correlate on a sibling logical column the member's own base table does not carry — the key case being an **anchor key column whose surrogate default resolves a parent from an inserted FK** (`default (select … where parent.key = new.<fk>)`, where `<fk>` lives on a *different* member). This covers both default sites of the member insert: the row-expansion default (omitted columns) and the NOT NULL / `or replace` substitution default (which is built unconditionally for every NOT NULL column with a declared default). The envelope attributes stay resolvable through the whole member-insert pipeline because the narrowing envelope projection keeps its source row bound while downstream rows are produced. The member's own supplied columns (and any mutation context) shadow the threaded names, so a name the member carries itself still wins. One mechanism, three sites (single-source insert, envelope anchor key, envelope member); the member site now resolves against the produced logical row, not only the member's slice of it.

The two flavours of generated key follow directly:

- **Minting** a fresh surrogate — the `max() + mutation_ordinal()` recipe above; the default ignores the row's values.
- **Resolving** an existing key — the default reads `new.<col>` to look an existing parent row up. This is the natural shape for a **PK-is-FK extension table** (or lens basis relation) whose surrogate *adopts the parent's* rather than minting its own:

```sql
-- parent identity table
create table h0_users_id (rowId int primary key, value int) using mem();

-- extension relation: its rowId resolves the parent's via the supplied `value`
create table h2_uprof (
  rowId int primary key
          default (select rowId from h0_users_id h0 where h0.value = new.value),
  value int
) using mem();

insert into h2_uprof (value) values (200);   -- rowId is resolved to the matching parent row
```

The default's correlated subquery reads `new.value` (the row's supplied value), so `h2_uprof.rowId` adopts the parent `h0_users_id.rowId` whose `value` matches. Such a default is deterministic *given install state* — it resolves an existing row and introduces no nondeterminism beyond the basis read it already performs, so it needs no `nondeterministic_schema` opt-out.

The same resolving default works as a **decomposition anchor key** through a lens logical-view insert: the anchor holds only the surrogate, its `default (select rowId from h0_users_id h0 where h0.value = new.value)` resolves the parent per produced row, and the resolved surrogate EC-threads into every member — even though the correlated `new.value` is a logical column carried by a *different* member than the anchor (it reaches the anchor key default through the produced-row NEW context the fan-out threads).
