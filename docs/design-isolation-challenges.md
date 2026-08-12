# Isolation Layer — Challenges and Mitigations

The six hard problems the overlay-merge design has to solve, and what the layer does about each:
merging two ordered row streams, cursor validity while a transaction writes, recovering from a
commit that fails partway through, the per-read cost of the overlay check, storage for a large
transaction's staged rows, and DDL against a table other connections hold open overlays on.
A satellite of [Isolation Layer Design](design-isolation-layer.md).

---

## 1. Merge Iteration Complexity

**Challenge:** Merging two ordered streams while handling inserts, updates, and deletes is error-prone.

**Mitigation:**
- Implement as a standalone, well-tested `MergeIterator` utility
- Use property-based testing (fast-check) to verify invariants:
  - Output is correctly ordered
  - All overlay changes appear in output
  - Deleted rows never appear
  - Updates replace originals exactly once
- Keep stateless: input two async iterables, output one

## 2. Cursor Invalidation During Mutation

**Challenge:** If a query is iterating and a write occurs, the cursor may be invalid.

**Mitigation:**
- Writes go to overlay module, which has its own cursor safety semantics
- If overlay module supports snapshot isolation (memory vtab does), iteration is safe
- Document behavior based on overlay module's capabilities

## 3. Commit Failure Recovery

**Challenge:** If a commit that spans several tables fails partway through, some tables must
not be left committed while others roll back (a *torn* transaction).

**Mitigation — apply-all, then commit-all (see [§ Commit](design-isolation-layer.md#commit)).** The flush is transaction-wide and
two-phase: Phase 1 begins every touched underlying table and applies its overlay rows *without*
committing; Phase 2 commits them only once **all** have applied. All the fallible data work
(constraint re-checks, injected/IO write errors) happens in Phase 1, before any commit, so a
data-driven failure aborts cleanly — Phase 1 rolls back every begun table and nothing was
committed. The overlays remain intact, so the ensuing transaction rollback discards them and the
user can retry.

**Atomicity contract — depends on the underlying's commit domain.**
- **Shared atomic commit domain (full crash-atomicity).** When the underlying commits its tables
  through one shared atomic domain — the `quereus-store` module-wide `TransactionCoordinator`
  plus a provider that exposes `beginAtomicBatch` (IndexedDB, LevelDB) — Phase 2's first
  `commit()` writes *every* table's ops in a single atomic batch and the rest no-op. The
  multi-table commit is then fully atomic even against a crash mid-commit.
- **Per-table commit domains (data-driven-clean only).** For an underlying whose tables commit
  independently (the default memory vtab), Phase 2 commits each table in turn. Because all
  fallible work already completed in Phase 1, a *data-driven* abort is still clean (nothing
  committed). But a bare infrastructure/IO failure *during the commit phase itself* can still
  leave earlier tables committed — the isolation layer cannot prevent this without an atomic
  underlying. Full crash-atomicity is therefore **contingent on the underlying's capability**;
  the isolation layer does not attempt distributed two-phase commit or capability negotiation.

This is distinct from the deliberately out-of-scope cross-*connection* "last writer wins / no
write-write conflict detection" behavior documented in
[§ Isolation Level Provided](design-isolation-layer.md#isolation-level-provided) — that concerns two different
connections racing on the same row, not atomicity within a single connection's own commit.

## 4. Performance Overhead

**Challenge:** Every read now goes through overlay check + merge.

**Mitigation:**
- Fast path: if overlay is empty, delegate directly to underlying
- Track "has changes" flag to skip merge when unnecessary
- For point lookups: check overlay first (O(log n)), only hit underlying if not found
- Accept some overhead in exchange for correctness and simplicity

## 5. Large Transaction Storage

**Challenge:** Large transactions may accumulate many uncommitted changes in the overlay.

**Mitigation:**
- The overlay module is configurable—use memory vtab for small/fast transactions
- For large transactions, use a persistent overlay module (e.g., temp LevelDB instance)
- This is a deployment/configuration choice, not a limitation of the architecture

## 6. Schema Operations (DDL)

**Challenge:** CREATE INDEX, ALTER TABLE, DROP TABLE don't fit the row-based overlay model.

**Mitigation:**
- DDL mutates the shared underlying module directly — it is not transaction-scoped and the underlying auto-commits immediately, so it is not isolated in the same way as DML.
- Schema changes may have their own transactional semantics.
- **Open overlays are migrated in place, not bypassed and not rebuilt.** Any per-connection overlay holding staged rows in the *old* column layout would be structurally inconsistent with the post-DDL schema, so `IsolationModule` carries each affected overlay forward rather than ignoring it. Every path does that **in place** — through the overlay module's own `alterSchema` / `createIndex` / `dropIndex`, or through ordinary overlay writes — never by copying the staged rows into a freshly created staging table. That distinction is load-bearing: a copy flattens the overlay's layer chain, so the transaction's savepoint stack is replayed *above* the copied rows and a later `rollback to savepoint` discards rows staged **before** the savepoint. `createIndex` / `dropIndex` adopt the structure into the open overlay, so a new index is both usable by a merged secondary-index scan and *enforced* against the rest of the transaction's writes. `alterTable` forwards per change type: ADD / DROP / RENAME COLUMN reshape the open layers (ADD COLUMN backfills each staged row exactly as the committed path does; tombstone rows get NULL); `alter column … set data type` / `set collate` / `set default` forward straight through, with one preparation step: a `set collate` that re-keys the **primary key** first discards the deletion markers the new key collapses onto another staged row (a marker and a live row that become one key are that row's before- and after-image, not two rows — see *SET COLLATE on a primary key* below); `alter column … set not null` is withheld from the overlay (tombstones carry placeholder NULLs the overlay module would wrongly backfill or reject) and the staged live rows' NULLs are filled by ordinary overlay writes instead; `add constraint … unique` lands as a tombstone-narrowed unique **index**; `add constraint … check` forwards verbatim (schema-only — enforcement is engine-side, and the copy exists so a later DROP / RENAME resolves it); `add constraint … foreign key` does not forward at all (enforcement is engine-side and the unregistered `_overlay_*` staging table cannot serve the underlying's catalog-query validation), so DROP / RENAME CONSTRAINT is presence-guarded and no-ops for a constraint the overlay never carried. `alter primary key` is the one change no overlay can follow — see below. See *ALTER / DROP overlay poison* below.
- **The overlay's tombstone column name is reserved against ALTER.** Every overlay carries one extra column (`_tombstone` by default, host-configurable) as its deletion marker, so `add column` / `rename column` targeting that name is rejected `UNSUPPORTED` *before* `underlying.alterTable` runs. Forwarding it would make the overlay module raise a duplicate-name `ERROR` — not a data condition, so it rethrows — after the underlying had irreversibly applied, leaving the catalog a column behind the base and the next write landing values against the wrong columns. The check is unconditional, so the answer does not depend on whether a transaction happens to be open. (A `create table` declaring the name is *not* rejected: it produces a duplicate entry in the overlay's column list that every consumer reaches past by index. See the `NOTE` on `createOverlaySchema`.)
- **Row-validating DDL judges the issuer's rows, not the underlying's.** `create unique index` and `alter table … add constraint … unique` (and `alter column … set collate`, plus the value-rewriting `alter column … set data type` / `set not null`, whose rewrite can collapse two distinct values onto one) must see the rows the *issuing* connection can see — committed rows merged with its own overlay. The underlying module holds only committed rows, so `IsolationModule` hands it that merged stream through the optional `EffectiveRowSource` parameter. A *foreign* connection's overlay never contributes: its staged duplicates are its own problem at commit, exactly as a concurrent duplicate insert would be. See [module-authoring.md](module-authoring.md) § "When the pending rows live outside your module".
- **Open overlays are never orphaned, and never silently discarded.** `destroy` (DROP TABLE) discards the dropping connection's own overlay and every clean one, and **poisons** any foreign overlay holding staged rows; `renameTable` re-connects an underlying under the new name whenever it re-keys an overlay onto it. See [*Invariant: every staged overlay resolves to an underlying table at commit*](design-isolation-layer.md#invariant-every-staged-overlay-resolves-to-an-underlying-table-at-commit) — a residual miss on a staged, un-poisoned overlay is an `INTERNAL` error, never a silent discard.

### ALTER / DROP overlay poison

A **poisoned** overlay is one a cross-connection DDL left permanently unflushable. `ConnectionOverlayState.poison = { message }` records why. Three DDLs poison — `alterTable` (staged rows stuck in the pre-alter column layout, or keyed by a primary key the table no longer has), `createIndex` (a foreign overlay's staged rows violate the UNIQUE index another connection just declared, so the overlay cannot adopt it), and `destroy` (the table itself is gone) — and all raise the same `StatusCode.CONSTRAINT`; the **message**, not the code, distinguishes them. The common guarantee: **no connection loses staged writes without being told.**

An adoption that a staged row rejects never leaves a half-changed overlay: the overlay module validates its rows *before* mutating anything, so the overlay stays whole, in its pre-DDL shape, alongside its poison flag. One preparation step is the exception, and only for a *foreign* overlay: a primary-key re-keying `set collate` drops the deletion markers the new key collapses (below), and a refusal *after* that leaves them dropped — the issuer's are restored, a foreign overlay's are not. Inert because poison is terminal: the only exit is a rollback that discards the overlay whole. Making poison recoverable means restoring those markers first. For the **issuing** connection the same failure is an `INTERNAL` error rather than poison — the DDL's own validation pass judged a superset of exactly those rows and accepted them, so a rejection means validation and migration have drifted. The one exception is a retryable `BUSY`, which the overlay module raises for a re-key its own layer chain cannot physically represent — a condition the isolation layer's validation pass never claimed to judge. That is rethrown verbatim for the issuer (not dressed as drift) and poisons a foreign overlay.

#### ALTER: migrate, or poison

`alterTable` is the one DDL that can change row shape (ADD/DROP COLUMN) *and* rewrite row values (`alter column … set not null` filling staged NULLs from the column's DEFAULT, `alter column … set data type` converting every staged value), so its overlay handling is the most involved. The underlying converts only its own committed rows, so each of those value rewrites has an overlay-side half here — without it an accepted retype would commit staged rows still holding the OLD physical type. Because the underlying base auto-commits irreversibly, the blast radius is made **isolation-faithful**: an ALTER never depends on another connection's uncommitted data.

The machinery that does the carrying — deriving the per-change-type constants, dry-running one overlay against them, reshaping it forward, and building the poison message — lives in `alter-migration.ts` as free functions over one overlay. `IsolationModule.alterTable` in `isolation-module.ts` owns the surrounding lifecycle: which overlays are in scope, the issuer/foreign tiering below, error routing, and the `alter primary key` overlay swap.

The affected overlays are partitioned into the **issuer's own** (the connection that ran the ALTER) and **foreign** ones, handled in three tiers:

1. **Partition.** Compare each affected overlay's key against the issuer's `makeConnectionOverlayKey(db, …)`. Foreign overlays already marked poisoned (from an earlier ALTER) are skipped entirely — they hold pre-alter rows and must not be re-read or re-migrated.
2. **Validate issuer-own first (atomic abort).** The issuer's own overlay is dry-run validated (per-row `NOT NULL` backfill, per-value `set data type` conversion, primary-key collision under a new collation, tombstone-present guard) **before** the irreversible `underlying.alterTable`. A primary-key re-keying `set collate` additionally **pre-flights the overlay module's own `alterSchema`** in validate-only mode (`VirtualTable.alterSchema(change, true)`), because that call is itself fallible and would otherwise run in tier 3, after the underlying had already re-keyed. Any throw in this tier leaves underlying + catalog + every overlay untouched — the issuer's ALTER fails clean or fully applies. (The issuer staged both the data and the DDL, so rejecting up front is least-surprising and matches the engine's own pre-mutation `validateNotNullBackfill` — though that engine-side probe only ever sees the ISSUING connection's rows (committed + its own staged), never a foreign connection's, which is why tier 3 below re-validates NOT NULL per foreign overlay rather than trusting the engine to have already caught it.)
3. **Mutate, then per-foreign migrate-or-poison.** After the underlying is altered, the issuer's own overlay migrates forward in place — reshaped to the new column layout *and* value-rewritten (NOT NULL backfill / retype conversion / marker collapse) to match what the underlying did to its committed rows. Each foreign overlay is then validated individually: a per-row `NOT NULL` (`CONSTRAINT`) failure — either an `add column … default new.<col>` evaluator producing NULL for a staged row, or a mandatory `add column` with no usable DEFAULT for a staged row to inherit — or an unconvertible value under a retype (`MISMATCH`) **poisons** that one overlay (`ConnectionOverlayState.poison = { message }`) and leaves its pre-alter rows in place; a healthy foreign overlay migrates forward. A foreign overlay whose own `alterSchema` refuses the change — `CONSTRAINT`, or the retryable `BUSY` an unrepresentable re-key raises — is poisoned too. All of these poison rather than rethrow because the underlying has already been mutated by this point — rethrowing would abort the issuer's ALTER after the fact, exactly the divergence the tiering exists to prevent. A layer-invariant failure (`INTERNAL`, e.g. a missing tombstone column) is **rethrown** loud for everyone rather than poisoned. Validation is per overlay, so one bad foreign overlay poisons only itself.

#### SET COLLATE on a primary key: collapsing deletion markers

Changing the collation of a primary-key column re-keys the table, and two old keys can become one new key (`'A'` and `'a'` under `NOCASE`). Inside a transaction that deleted a row and re-inserted a case-variant replacement, the overlay stages a **deletion marker** for the old key and a **live row** for the new one — and under the re-keyed primary key those two land on the same key. They are one logical row's before- and after-image, not two rows: the live row's flush write already subsumes the delete, so the marker is dropped before the re-key is forwarded to the overlay. Markers alone together on one key are one deletion, so all but one are dropped. **Two live rows** on one key stay a genuine duplicate and are refused (`CONSTRAINT`, with the same message the memory module raises).

The drops go through the overlay's ordinary write path, so its layer chain and savepoint snapshots survive — a `rollback to savepoint` taken before the ALTER restores the marker. Because they must happen *before* the pre-flight in tier 2, but the underlying's own row-content check must still judge the pre-drop view (a dropped marker un-shadows the committed row it deletes), the issuer's effective rows are snapshotted first, and any refusal reinserts the dropped marker rows verbatim so the ALTER is net-untouched.

Some shapes remain unrepresentable and are refused as retryable `BUSY` — notably when a savepoint could restore both a marker and its replacement at one re-keyed key. That refusal comes from the overlay module's own representability check, is the same answer a plain (non-isolated) memory table gives for the equivalent statement sequence, and — thanks to the tier-2 pre-flight — arrives before the shared table mutates, leaving the transaction intact.

Because that check runs against the overlay's *own* staging table, its message names `_overlay_<table>_<id>`, which means nothing to the caller. **No user-facing error may name an overlay staging table.** Messages the layer composes itself already carry the real schema-qualified name; the risk is an overlay module's own text reaching a user unedited, which happens at two points — the tier-2 pre-flight refusal, thrown verbatim, and the foreign-overlay poison message (and the issuer drift error), which quote it. Both rewrite it first, via `IsolationModule.renameOverlayInError`. Any future path that lets an overlay's error text escape owes the same treatment.

The **underlying** can raise `BUSY` for the same statement too, and for the mirror-image reason: the transaction staged only a deletion marker, so the underlying still holds both committed rows a `rollback` must restore and cannot re-key them onto one key. The memory module answers from its layer chain and the store from its committed rows (`StoreTable.validateRekeyedPrimaryKey`; see [store.md](store.md) § `ALTER COLUMN … SET COLLATE` on a PK column). Both are pre-mutation, so this `BUSY` also leaves the transaction usable — it is the issuer-facing refusal referenced above as "a retryable `BUSY` … a condition the isolation layer's validation pass never claimed to judge".

#### ALTER PRIMARY KEY: the one change no overlay can follow

An overlay's layer trees are keyed by the table's **old** primary key, and a staged deletion marker identifies the row it deletes *by that key* — under a new key its identity columns may be placeholder NULLs, i.e. garbage. So `alter primary key` cannot be forwarded to an overlay at all, and gets its own three-way handling:

- **Issuer with staged rows** — rejected `BUSY` (retryable, not `UNSUPPORTED` — the engine treats `UNSUPPORTED` from `alterTable` as "fall back to a shadow-table rebuild", which copies committed rows only and would silently drop this transaction's staged writes) **before** `underlying.alterTable` runs, so the ALTER fails atomically rather than stranding rows it cannot re-key. The connection commits or rolls back first, then retries.
- **Foreign overlay with staged rows** — poisoned, exactly as an unconvertible retype poisons one.
- **Clean overlay (nothing staged)** — swapped for a fresh empty staging table built from the post-alter schema, so the rest of the transaction's writes key by the new primary key. There are no pre-existing staged rows to lose, and the fresh table's connection registers on its first write, which replays the active savepoint stack onto it.

The bundled `MemoryTableModule` now re-keys `alter primary key` in place (as the store always has), so this path is reachable with either built-in underlying. The refusal for an issuer with staged rows is about the OVERLAY's representation — a staged tombstone's identity columns are meaningless under the new key — not about the underlying's capability.

#### DROP TABLE: discard, or poison

`destroy` cannot migrate anything — the table is gone. It decides per overlay key (see the `destroy()` bullet under [*Invariant: every staged overlay resolves to an underlying table at commit*](design-isolation-layer.md#invariant-every-staged-overlay-resolves-to-an-underlying-table-at-commit)): the **dropping connection's own** overlay is discarded silently, a **foreign dirty** overlay is poisoned and kept, a **foreign clean** overlay is discarded. Poisoning a kept overlay is what makes the commit path work unchanged: `commitConnectionOverlays` checks `state.poison` *before* the `underlyingTables` lookup, so the surviving overlay raises its poison message rather than the `INTERNAL` orphan error. An already-poisoned overlay keeps its **original** message — the first cause is the one worth reporting.

The drop poison is deliberately over-strict for a connection that unwinds all its staged rows past the drop and could arguably commit clean: the poison rides on the `ConnectionOverlayState`, not on the rows. The table is gone either way, so failing is the safe answer.

The own-overlay branch discards the state whether or not it was already poisoned, so a connection carrying an ALTER poison escapes it for the table it drops. That is the intended reading — the rows it discards belong to a table it just asked to remove — and it clears the poison only for that table; an overlay poisoned on any other table still aborts the commit.

#### Observing poison

A poisoned overlay always has `hasChanges === true`, so `IsolatedTable` errors (`QuereusError`, `CONSTRAINT`) at the data-op chokepoints — `update` (before staging), the *merged* branch of `query`, and the commit flush (`flushAndClearOverlay`) — but never on the committed-snapshot (`readCommitted`) read path, which bypasses the overlay and stays usable. This means a poisoned connection fails its next read/write/commit even if it never touches the table again, while a `committed.<table>` reader keeps working.

#### Poison lifecycle

Poison is cleared only by discarding the `ConnectionOverlayState`: a **full rollback** (`onConnectionRollback`) or a rollback to a **pre-overlay savepoint** drops the overlay (and its poison). A rollback to a savepoint taken **after** the overlay existed does *not* replace the state, so poison correctly persists — the DDL is permanent (pre-alter rows, or a table that no longer exists), so even if the offending row was rolled back the overlay stays unflushable until the transaction ends. Identical for both poison sources.

A poisoned overlay must also never be carried through the layer's other overlay-migration paths, which would reshape its layout-mismatched rows and — where the path replaces the state object, as the `alter primary key` clean-overlay swap does — silently un-poison a connection that must still roll back. All such paths therefore **skip** a poisoned overlay, leaving it poisoned: `alterTable` skips it *before* the issuer/foreign split (so even the poisoned connection's own later ALTER does not migrate it), and `createIndex` / `dropIndex` skip it in their post-DDL adoption loop. `renameTable` is safe as-is — it re-keys the state object in place, carrying the `poison` field along.
