---
description: |
  Some shared SQL conformance test files require features that a given database backend deliberately does not
  support, so those files fail on that backend even though nothing is actually broken. Today each backend
  hand-maintains its own private list of files to skip. Give the test files a small machine-readable tag that
  declares which capabilities they need, so any backend can skip the ones it can't run without keeping a
  separate list.
files:
  - packages/quereus/test/logic.spec.ts   # MEMORY_ONLY_FILES — the hand-maintained per-backend skip list this would supersede for capability-shaped cases
  - packages/quereus/test/logic/10.1.2-ddl-in-transaction.sqllogic  # concrete case: whole file's subject is CREATE UNIQUE INDEX / ADD CONSTRAINT ... UNIQUE
---

# Machine-readable backend-capability directive for the `.sqllogic` corpus

## Problem

The `packages/quereus/test/logic/*.sqllogic` corpus is shared: other projects (notably the `lamina` backend)
consume this directory verbatim and run the same files against their own storage engine. When a file's
subject is a feature a backend deliberately doesn't implement, the file fails there — not because anything is
wrong, but because the backend chose not to support that feature.

The current coping mechanism is a **per-backend private skip list**: quereus keeps a `MEMORY_ONLY_FILES` set
in `logic.spec.ts`; lamina keeps its own `known-failures` allow-list. Each downstream re-derives, by hand,
which files its backend can't run. That is duplicated knowledge that drifts.

The lever this ticket proposes: let each test **file declare, in a machine-readable way, which backend
capabilities it requires** (e.g. "needs standalone `CREATE [UNIQUE] INDEX`"). A harness then reads the
declaration and skips files whose required capabilities its backend lacks — no per-backend file list.

## Concrete driving case

`10.1.2-ddl-in-transaction.sqllogic` exists entirely to test row-validating DDL inside an open transaction:
`create unique index` and `alter table ... add constraint ... unique` must see the issuing transaction's
uncommitted rows and stay enforced afterward. Backends that retired first-class standalone index creation
(covering materialized views replace it) cannot run any of it. There is no honest way to migrate the file —
the DDL *is* the subject. So it needs a capability declaration, not a rewrite.

(Note for whoever picks this up: the parent plan asserted 10.1.2 is *already* excluded via
`MEMORY_ONLY_FILES`. It is **not** — verify the current set in `logic.spec.ts`. 10.1.2 runs against every
backend today; the isolation-side store behavior is tracked separately under
`isolation-ddl-validation-ignores-overlay-rows`.)

## Design considerations (for whoever plans this)

- **Directive shape.** A comment-embedded header the existing line parser can pick up without a real parser
  change, e.g. `-- requires-capability: standalone-index-creation`. Keep it greppable and one-capability-
  per-token so files can list several.
- **Capability vocabulary.** Needs a small, named, documented set (start with `standalone-index-creation`).
  Avoid inventing a capability per test; group by the feature a backend would realistically choose to omit.
- **Not a wholesale replacement for `MEMORY_ONLY_FILES`.** That set is heterogeneous — some entries are
  memory-engine quirks (`10.2.2-default-collation-memory`), cost-model choices (`83-merge-join`), or
  white-box internals (`105-vtab-memory-mutation-kills`), which are **not** capability-shaped. A capability
  directive should *supersede the capability-shaped subset* and coexist with the rest, not delete the whole
  constant. Decide during planning which existing entries (if any) migrate.
- **Local payoff is limited.** quereus ships only memory + store backends, both of which support
  `create unique index`; so a `standalone-index-creation` directive has no *local* skip effect and is hard to
  test locally beyond "the harness parses it and applies it correctly to a synthetic capability set". The
  real consumer is downstream (lamina). Weigh whether the mechanism earns its keep now or waits for a second
  capability that quereus itself needs.

## Why backlog / not urgent

Nothing is red downstream today: lamina holds the affected files green via fingerprint-pinned known-failures
that self-retire the moment a file starts passing. This is cross-backend corpus portability and de-
duplication of skip knowledge, not a correctness fix. Bundle with any broader corpus-portability pass; the
narrow `47.3` carve-out is handled separately by `sqllogic-split-47.3-index-derived-collation`.
