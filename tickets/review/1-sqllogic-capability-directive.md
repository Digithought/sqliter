---
description: |
  A shared SQL test file can now declare which database features it needs, so a database backend
  that deliberately lacks one of those features skips the file automatically instead of every
  backend hand-maintaining its own list of files to skip. Review the implementation.
files:
  - packages/quereus/test/logic-capabilities.ts        # NEW — directive parser + capability vocabulary
  - packages/quereus/test/logic-capabilities.spec.ts   # NEW — 25 unit tests + corpus-wide parse guard
  - packages/quereus/test/logic.spec.ts                # harness wiring (imports, BACKEND_CAPABILITIES, per-file loop)
  - packages/quereus/test/logic/10.1.2-ddl-in-transaction.sqllogic  # the one annotated file
  - packages/quereus/test/README.md                    # § Logic-test conventions → new subsection = format spec
  - docs/architecture.md                               # § Testing Strategy, SQL Logic Tests bullet — pointer only
difficulty: medium
---

# Review: `-- requires-capability:` directive for the `.sqllogic` corpus

## What landed

`packages/quereus/test/logic/*.sqllogic` is a shared corpus — other projects run the same 281 files
against their own storage engine. Previously each consumer hand-maintained a list of file names its
backend can't run. Now a file can declare the feature it needs, and each harness declares once which
features its backend has.

**New module `test/logic-capabilities.ts`** — pure string-in / data-out, no engine imports:

- `SQLLOGIC_CAPABILITIES` — closed vocabulary, exactly one member today:
  `standalone-index-ddl` = "backend accepts `create index` / `create unique index` / `drop index` as
  standalone statements".
- `SqllogicCapability` type — deliberately distinct from `src/vtab/capabilities.ts`'s runtime
  `ModuleCapabilities`, so the two never read as the same thing.
- `parseRequiredCapabilities(fileName, content)` → `ReadonlySet<SqllogicCapability>`; throws on malformed
  input.
- `missingCapability(required, supported)` → first missing token or `undefined`.
- `MEMORY_BACKEND_CAPABILITIES` / `STORE_BACKEND_CAPABILITIES` — both full today (memory has
  `MemoryModule.createIndex`, store has the isolation layer's `createIndex`), so **the mechanism produces
  zero local skips**. That is by design; the payoff is downstream.

**Harness wiring in `logic.spec.ts`** — per file, at `describe`-registration time: read content, parse the
directive inside a try/catch (a throw registers one failing `it` so a bad directive fails exactly one file
instead of aborting suite registration), then the capability skip, then the existing `MEMORY_ONLY_FILES`
check. `MEMORY_ONLY_FILES` is unchanged — no entries migrated — and now carries a comment stating the split
rule: capability-shaped divergence → file directive; memory-engine quirk / cost-model choice /
harness-config assertion / white-box internals / known-bug → that set.

**Format spec** lives in `packages/quereus/test/README.md` § `-- requires-capability:` directive (the format
is the cross-repo contract, not the code — downstream harnesses reimplement the ~10-line parse against it).
`docs/architecture.md` carries a one-line pointer only.

## Format (as implemented)

Directive must sit in the leading comment block — before the first line that is neither blank nor `--`:

```
-- Row-validating DDL inside an open transaction.
-- requires-capability: standalone-index-ddl

create table ddl_tx_a (id integer primary key, v text);
```

- Directive name matched case-insensitively; tokens lowercased before lookup.
- Tokens separated by whitespace and/or commas; multiple directive lines union; duplicates fine.
- Whole-file granularity. No section-scoped form — split the file instead.

Hard errors (fail exactly one file's test, never a silent skip or pass): unknown token, no tokens,
canonical directive after the first SQL line, and near-miss spellings matched by
`/^--\s*require[sd]?[-_ ]?capabilit/i` that aren't canonical (`-- require-capability:`,
`-- requires_capability:`, `-- requires capability:`). The near-miss guard matters because the runner's
main loop `continue`s past every unrecognized `--` line, so a typo'd directive would otherwise vanish.

Documented non-feature: **no trailing comment on a directive line** — the whole remainder is read as
tokens, so `-- requires-capability: x -- why` errors on `--` and `why`. Loud, and documented in the README.

## Validation performed

| Command | Result |
|---|---|
| `node … mocha packages/quereus/test/logic-capabilities.spec.ts` | 25 passing |
| `yarn test` (root, all workspaces) | 0 failing. quereus: **7546 passing, 13 pending** — pending unchanged (no `lacks capability` line in the log) |
| `yarn test:store` | 0 failing. **7539 passing, 20 pending** — 13 base + the 7 `MEMORY_ONLY_FILES` entries; zero capability skips, as expected |
| `yarn lint` (root, fans out; quereus runs eslint + `tsc -p tsconfig.test.json --noEmit`) | clean |

**Skip path proved end-to-end, not assumed.** Because both quereus backends are capability-complete,
nothing in the normal run exercises the skip. So `MEMORY_BACKEND_CAPABILITIES` was temporarily set to an
empty set and `logic.spec.ts --grep "10\.1\.2"` was run: output was
`- skipped: backend lacks capability "standalone-index-ddl"`, `0 passing, 1 pending`, in 19ms — i.e. the
`describe` registered one skipped `it`, `beforeEach` never ran, and no `Database` / LevelDB temp dir was
created. The file was then restored (verified back to `ALL_CAPABILITIES`).

## Use cases to exercise when reviewing

1. **A downstream backend without standalone index DDL.** Construct
   `missingCapability(parseRequiredCapabilities(f, content), new Set())` for
   `10.1.2-ddl-in-transaction.sqllogic` — should return `standalone-index-ddl`. Covered by a spec test.
2. **Typo'd directive months from now.** Add `-- requires_capability: standalone-index-ddl` to any
   `.sqllogic` file and run the suite — that one file must fail loudly, everything else unaffected.
3. **Unknown token.** `-- requires-capability: frobnicate` → that file fails with a message naming both
   `frobnicate` and the valid vocabulary.
4. **Directive after SQL.** Move the directive below the first `create table` in 10.1.2 → must fail with
   "leading comment block", not be honored.
5. **No regression for the un-annotated 280.** Spec test walks every corpus file that does not mention the
   directive and asserts an empty set.

## Known gaps / things to poke at

- **Zero local coverage of the skip branch in a normal run.** Both backend sets are full, so the
  `it.skip` registration path only runs under the manual temporary-edit experiment described above. If the
  reviewer wants that permanently covered, the options are (a) an env-var override for the backend set, or
  (b) accepting the manual proof. Deliberately not added an env hook — it is test-only surface the spec did
  not ask for, and the branch is four lines mirroring the existing `MEMORY_ONLY_FILES` shape.
- **Corpus-guard test does not run inside `logic.spec.ts`.** It lives in `logic-capabilities.spec.ts`, so a
  malformed directive is caught twice (once as that file's own failing `it`, once by the corpus guard).
  Intentional, but worth confirming the reviewer agrees the guard belongs where it is.
- **Near-miss regex is heuristic.** `/^--\s*require[sd]?[-_ ]?capabilit/i` catches the spellings the spec
  named plus close relatives (`-- requires-capabilities:`, `-- requires-capability` with no colon). It will
  not catch a wilder mangling (`-- needs-capability:`). Judged good enough; the vocabulary is closed so a
  *wrong token* is always caught — only a wrong *directive name* can slip, and only if it doesn't start
  with `require`.
- **`STORE_BACKEND_CAPABILITIES` and `MEMORY_BACKEND_CAPABILITIES` are the same object** (both alias
  `ALL_CAPABILITIES`). Correct today; a reviewer may prefer two independent `new Set(...)` literals so
  divergence is a one-line edit rather than a de-aliasing. Left as-is because the shared alias makes "both
  are full" self-evident.
- **`10.1.2` §3 and §5 test `alter table … add constraint … unique`**, a different statement from
  `create index`, riding along under the same token because granularity is whole-file. A `NOTE:` comment at
  the top of that file records this and says to split the file — not mint a second token — if a backend ever
  reports supporting one and not the other. This is a tripwire, parked in the file, not a ticket.
- **`13 pending` in memory mode is pre-existing** (unrelated `it.skip`s elsewhere in the quereus suite);
  this change adds none. Store mode's 20 = 13 + 7 `MEMORY_ONLY_FILES`. Worth an independent recount.

## Review findings

_(reviewer fills in)_
