# Stability Tiers

Quereus is one version across seventeen packages, fourteen of which publish to npm
(the list `yarn pub` walks — see [Releasing](releasing.md)). Some of them are a
battle-tested SQL core; others are research tracks that are nowhere near settled.
This document says which is which, so a user can tell what they are allowed to build
on and a maintainer has a declared boundary to point at.

Every user-facing feature area is assigned one of four tiers — **Stable**, **Beta**,
**Experimental**, **Internal** — and every doc describing one carries a banner naming
its tier. Every package that publishes carries the same banner at the top of its
`README.md`, so the tier is visible on the npm page and not only here.

## What a tier measures

A tier says **how much a future release may break you**. It says nothing about
whether the feature computes the right answer today. **A wrong answer is a bug at
every tier, including Experimental.**

This is not a technicality. Two optimizer rules from the Experimental parallel track
— `rule-fanout-lookup-join.ts` and `rule-async-gather-zip-by-key.ts` — are registered
in `planner/optimizer.ts` and fire on ordinary user queries. Someone running a plain
`select` cannot opt in or out of them. If "Experimental" meant "may return wrong
rows", the Stable tier would be a lie. It does not. For the parallel track,
Experimental covers the plan-node shapes, the runtime primitives, and their
TypeScript APIs — not the correctness of the rows a query returns. An experimental
optimizer rule that changes a result set is a bug, not an exercise of its tier.

The same split is why the functional-dependency framework is **Internal** rather than
carrying a user tier of its own. It has no public API; it surfaces only through
`query_plan()` properties, which is itself Internal. Its *soundness* is guarded by the
Key Soundness property tests — that is a correctness guarantee, and correctness is not
what a tier measures.

## Tiers

All packages share one version and follow semver, so the promises below are phrased
against release types. See [Releasing](releasing.md).

| | **Stable** | **Beta** | **Experimental** | **Internal** |
| --- | --- | --- | --- | --- |
| A breaking change may land in | a major release only | a minor release | **any** release, including a patch | any release |
| Deprecation notice before removal | yes, one major cycle | called out in the release notes | none | none |
| Stored / on-the-wire format | stable across majors, with a documented upgrade path | may change, with a documented upgrade path | may change with no upgrade path; a stored artifact may be unreadable by the next version | n/a |
| Bug priority | a regression blocks a release | fixed, behind Stable | logged; a fix competes with the track's own roadmap | report the user-visible symptom instead |
| Build on it? | yes | yes, and read the release notes | prototype on it, and tell us what broke | no — it has no user-facing contract |

### Stable

SQL accepted today keeps its meaning; the exported TypeScript surface keeps its
shape. Correcting behavior that violates the documented semantics is a bug fix, not a
breaking change, and may land in a minor or patch release.

### Beta

Complete, tested, and used in earnest, but the surface is still being shaped. Build on
it, and read the release notes before upgrading.

### Experimental

A research track. It exists to be learned from. Anything may change or disappear
without notice — the API, the plan shapes, the stored bytes, the feature itself.

### Internal

Engine internals, documented so contributors can work on the engine, not so consumers
can depend on them. Some are reachable from SQL — the `query_plan()`,
`scheduler_program()`, and `execution_trace()` functions — but those are debugging
aids and their output shape is not a contract. When Internal behavior bites you,
report the user-visible symptom, not the internal detail.

## Assignment

| Feature area | Tier | Docs |
| --- | --- | --- |
| Core SQL — queries, DML, joins, aggregates, subqueries, CTEs, set operations, `diff`, `returning` | Stable | [sql.md](sql.md) |
| Window functions | Stable | [window-functions.md](window-functions.md) |
| Type system, including temporal and custom types | Stable | [types.md](types.md), [datetime.md](datetime.md) |
| Built-in function library | Stable | [functions.md](functions.md) |
| Constraints and assertions — `not null`, `check`, foreign keys, `create assertion`, the `committed.` pseudo-schema, conflict resolution | Stable | [sql.md](sql.md) |
| Transactions and savepoints | Stable | [usage.md](usage.md) |
| Virtual-table framework — `VirtualTableModule`, async cursors, `getBestAccessPlan` | Stable | [module-authoring.md](module-authoring.md) |
| Read-only views | Stable | [sql.md](sql.md), [schema.md](schema.md) |
| `MemoryTable` | Stable | [memory-table.md](memory-table.md) |
| Core `Database` / `Statement` API, parameter binding | Stable | [usage.md](usage.md) |
| Plugin system — `registerPlugin`, custom functions, collations, custom types, `@quereus/plugin-loader` | Stable | [plugins.md](plugins.md) |
| Error types and status codes | Stable | [errors.md](errors.md) |
| Materialized views | Beta | [materialized-views.md](materialized-views.md), [mv-maintenance.md](mv-maintenance.md), [mv-constraints.md](mv-constraints.md), [mv-ingestion.md](mv-ingestion.md), [mv-schema-change.md](mv-schema-change.md), [mv-backing-host.md](mv-backing-host.md) |
| View updateability — write-through for views, CTEs, and subqueries-in-`from` | Beta | [view-updateability.md](view-updateability.md) |
| Declarative schema — `declare schema` / `apply schema` | Beta | [sql-ddl.md](sql-ddl.md) § 2.0 (section banner) |
| Change-scope introspection and `Database.watch` | Beta | [change-scope.md](change-scope.md), [usage.md](usage.md) § Change-scope (section banner) |
| Database event hooks — `onDataChange`, `onSchemaChange` | Beta | [module-events.md](module-events.md), [schema.md](schema.md) |
| `SchemaManager` API and DDL generation | Beta | [schema.md](schema.md) |
| Persistent store — `@quereus/store` and the LevelDB / IndexedDB / React-Native-LevelDB / NativeScript-SQLite plugins. Its on-disk key encoding is **not** frozen, carries no format-version marker, and has no in-place upgrade tooling today: a format change would be published with a documented migration procedure, not applied for you. | Beta | [store.md](store.md) |
| Isolation layer — `@quereus/isolation` | Beta | [store.md](store.md#isolation-gap), [design-isolation-layer.md](design-isolation-layer.md) |
| Tooling — `quoomb-cli`, `quoomb-web`, `@quereus/planviz`, `@quereus/shared-ui`, the VS Code extension | Beta | [usage.md](usage.md) |
| Lenses and layered schemas | Experimental | [lens.md](lens.md) |
| Schema migration in a synced database | Experimental | [migration.md](migration.md) |
| Parallel runtime — `ParallelDriver`, `EagerPrefetchNode`, `AsyncGatherNode`, `FanOutLookupJoinNode`, `VirtualTableModule.concurrencyMode` | Experimental | [runtime.md](runtime.md) § ParallelDriver (section banner), [module-authoring.md](module-authoring.md) § Concurrency Mode (section banner), [optimizer-parallel.md](optimizer-parallel.md) |
| Sync — `@quereus/sync`, `@quereus/sync-client`, `sync-coordinator`. The wire protocol carries no version handshake and may change without notice. | Experimental | [sync.md](sync.md), [sync-coordinator.md](sync-coordinator.md), [coordinator.md](coordinator.md) |
| Optimizer — rules, cost model, passes, framework | Internal | [optimizer.md](optimizer.md) and the `optimizer-*.md` topic docs |
| Functional dependencies and equivalence classes | Internal | [optimizer-fd.md](optimizer-fd.md) |
| Plan-node tree, `PlanNodeType`, emitters, `Instruction` / `Scheduler` runtime | Internal | [runtime.md](runtime.md) |
| `DeltaExecutor` incremental-maintenance kernel | Internal | [incremental-maintenance.md](incremental-maintenance.md) |
| `query_plan()` / `scheduler_program()` / `execution_trace()` introspection | Internal | [runtime.md](runtime.md), [optimizer.md](optimizer.md) |

A deep dive inherits its hub's tier: the `mv-*.md` docs are Beta with
`materialized-views.md`; the `optimizer-*.md` docs are Internal with `optimizer.md`.
Where an area genuinely differs from its doc's tier, it carries a **section banner**
rather than a row of its own.

Contributor and process docs — [architecture.md](architecture.md),
[doc-conventions.md](doc-conventions.md), [invariants.md](invariants.md),
[releasing.md](releasing.md), [todo.md](todo.md), this document, and the design notes —
describe how the project is built rather than what it promises, and carry no tier.
`docs/review.md` and `docs/review.html` are frozen review artifacts and are exempt from
every doc check.

The machine-readable form of this table is [`docs/.stability.json`](.stability.json), which
carries a `docs` map for the per-doc banners and a `packages` map for the per-package ones.
`yarn docs:check` fails the build when either map, its banners, or the set of packages
`yarn pub` publishes fall out of agreement — see
[Documentation Conventions](doc-conventions.md#in-a-package-readme).

## Three edge calls

**Views split in two.** Read-only views are Stable; **view updateability** — the
write-through path — is Beta. Calling it Stable would promise semantics for
multi-source write routing that only just landed, and its acceptance boundary (which
view bodies are writeable) is still widening. Materialized views, lenses, and
migration all sit on it, so a Beta base under a Beta feature and an Experimental one
is coherent; a Stable base would not have been.

**Declarative schema is Beta, not Stable**, even though it is documented inside the
Stable `sql-ddl.md`. It carries a real equivalence harness
(`test/declarative-equivalence.spec.ts` plus a property suite), but that harness was
shaped against three found round-trip defects, and the `declare schema` grammar is
still growing — seeds, imports, versioning, hashing. It takes a section banner inside
`sql-ddl.md` rather than changing that doc's header banner.

**The functional-dependency framework is Internal, not a user tier**, for the reason
given under [What a tier measures](#what-a-tier-measures): it has no public surface,
and the property tests that guard it guarantee correctness, which is orthogonal to
compatibility.

## How a doc names its tier

Every tiered doc carries one banner line, immediately below its `#` heading:

```markdown
> **Stability: Experimental** — see [Stability Tiers](stability.md#tiers).
```

A section may override its doc's tier by carrying the same banner under that
section's heading. The header banner states the doc's predominant tier; section
banners are the exceptions. See [Documentation Conventions](doc-conventions.md) for
the convention, and [`docs/.stability.json`](.stability.json) for the map a doc's
banner must agree with.
