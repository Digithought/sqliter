---
description: |
  Let a shared SQL test file declare which database features it needs, so a database backend that
  deliberately lacks one of those features can skip the file automatically instead of every backend
  hand-maintaining its own list of files to skip.
files:
  - packages/quereus/test/logic-capabilities.ts        # NEW — directive parser + capability vocabulary
  - packages/quereus/test/logic-capabilities.spec.ts   # NEW — unit tests + corpus-wide parse guard
  - packages/quereus/test/logic.spec.ts                # harness wiring; MEMORY_ONLY_FILES stays
  - packages/quereus/test/logic/10.1.2-ddl-in-transaction.sqllogic  # the one file annotated in this pass
  - packages/quereus/test/README.md                    # § Logic-test conventions — format spec lives here
  - docs/architecture.md                               # § SQL Logic Tests — one-line pointer only
difficulty: medium
---

# `-- requires-capability:` directive for the `.sqllogic` corpus

## Background

`packages/quereus/test/logic/*.sqllogic` is a **shared corpus**: other projects run the same 281 files
against their own storage engine. When a file's subject is a feature a backend deliberately does not
implement, the file fails there — not because anything is broken, but because that backend made a design
choice.

Today each consumer re-derives, by hand, which files its backend can't run: quereus keeps a
`MEMORY_ONLY_FILES` set in `logic.spec.ts`; downstream consumers keep their own known-failure lists. That is
duplicated, drifting knowledge — and it grows with the corpus.

This ticket adds a machine-readable declaration to the **file** ("this file needs feature X") so each harness
only has to declare, once, **which features its backend has**. A per-backend capability set is a handful of
semantic tokens that changes rarely; a per-backend file list is O(corpus) and changes constantly.

## Format

A `.sqllogic` file may declare required capabilities with a comment line in its **leading comment block** —
before the first line that is neither blank nor a `--` comment:

```
-- Row-validating DDL inside an open transaction.
-- requires-capability: standalone-index-ddl

create table ddl_tx_a (id integer primary key, v text);
```

Grammar:

- Canonical line shape, after trimming: `-- requires-capability: <tokens>`. The directive name is matched
  case-insensitively; tokens are lowercased before lookup.
- `<tokens>` is one or more tokens separated by whitespace and/or commas.
- The directive may appear on several lines; the declared sets **union**.
- Granularity is **whole file**. There is no section-scoped form. If only part of a file needs a capability
  and the rest is worth running elsewhere, **split the file** (`10.5.2-…` style decimal sub-numbering) rather
  than inventing a scoped directive.

Every one of the following is a **hard error** that fails that one file's test — never a silent skip and never
a silent pass:

- an unknown capability token,
- a directive with no tokens,
- a canonical directive appearing after the file's first SQL line,
- a **near-miss spelling** of the directive name that isn't the canonical form — e.g. `-- require-capability:`,
  `-- requires_capability:`, `-- requires capability:`. This matters because `logic.spec.ts`'s main loop
  `continue`s past every unrecognized `--` line, so without an explicit guard a typo'd directive would vanish
  and the file would run (or, downstream, fail) with nobody the wiser. Match the near-miss guard on
  `/^--\s*require[sd]?[-_ ]?capabilit/i` and reject anything matching it that isn't canonical.

## Vocabulary

Exactly one member in this pass:

| Token | Meaning |
|---|---|
| `standalone-index-ddl` | Backend accepts `create index`, `create unique index`, and `drop index` as standalone statements. |

Named `standalone-index-ddl` rather than the `standalone-index-creation` floated in the source ticket, because
a backend that has no standalone `create index` has no standalone `drop index` either — one token covers both.

Vocabulary rules, to be documented in `test/README.md`:

- The set is **closed** — unknown tokens are errors. Adding a member is a deliberate quereus change: one entry
  in the vocabulary constant, one row in the README table, and at least one file annotated with it. This is on
  purpose: the value of the mechanism is that every consumer of the corpus agrees on what the tokens mean, so
  a downstream backend cannot mint private tokens.
- Group by "a feature a backend would realistically choose to omit wholesale". Do **not** mint a capability per
  test.

## What this is NOT

Two adjacent concepts already exist; the docs must keep them apart or readers will conflate them.

- **`ModuleCapabilities`** (`packages/quereus/src/vtab/capabilities.ts`) is a *runtime* interface a virtual-table
  module advertises to the engine (`isolation`, `savepoints`, `secondaryIndexes`, `ddlTransactionality`, …).
  This directive is a *test-harness* concept about whole SQL statements a backend accepts. Deliberately do not
  derive one from the other: `secondaryIndexes: true` means "supports secondary indexes", which a backend can
  satisfy through declared schema or covering materialized views while still having no standalone `create index`
  statement. Different question, different answer. Use a distinct type name (`SqllogicCapability`) so the two
  never read as the same thing.

- **`MEMORY_ONLY_FILES`** (`logic.spec.ts`) stays exactly as it is. Its entries were reviewed during planning and
  **none of them migrate** — every one is a memory-engine quirk (`10.2.2-default-collation-memory`), a cost-model
  choice (`83-merge-join`), a harness-config assertion (`103-database-options-edge-cases`), white-box internals
  (`105-vtab-memory-mutation-kills`), or a tracked store bug (`41.2.1-…`, `41.7.5-…`). None is capability-shaped.
  Add a comment above the constant stating the split rule: *capability-shaped divergence → file directive;
  backend-quirk / cost-model / white-box / known-bug divergence → this set.*

## Interfaces

New module `packages/quereus/test/logic-capabilities.ts` — pure string-in/data-out, **no engine imports**, so it
stays trivially portable and unit-testable. (Precedent for a non-`.spec` helper at this level:
`test/emit-roundtrip-comparator.ts`.)

```ts
/** Capability tokens a .sqllogic file may declare. Closed set — see test/README.md. */
export const SQLLOGIC_CAPABILITIES = {
	'standalone-index-ddl':
		'`create index` / `create unique index` / `drop index` as standalone statements',
} as const;

export type SqllogicCapability = keyof typeof SQLLOGIC_CAPABILITIES;

/**
 * Parse every `-- requires-capability:` directive in the file's leading comment block.
 * @throws Error with `fileName` in the message on any malformed or unknown directive.
 */
export function parseRequiredCapabilities(
	fileName: string,
	content: string,
): ReadonlySet<SqllogicCapability>;

/** First capability in `required` that `supported` lacks, else undefined. */
export function missingCapability(
	required: ReadonlySet<SqllogicCapability>,
	supported: ReadonlySet<SqllogicCapability>,
): SqllogicCapability | undefined;

/**
 * What quereus's own backends accept. Both ship standalone index DDL — memory via
 * MemoryModule.createIndex, store via the isolation layer's createIndex — so both sets are
 * full today and this mechanism produces NO local skips. That is expected: the payoff is
 * downstream. Downstream harnesses declare their own set; they do not read these.
 */
export const MEMORY_BACKEND_CAPABILITIES: ReadonlySet<SqllogicCapability>;
export const STORE_BACKEND_CAPABILITIES: ReadonlySet<SqllogicCapability>;
```

## Harness wiring (`logic.spec.ts`)

Per file, at `describe`-registration time (where `MEMORY_ONLY_FILES` is consulted today, around line 480):

1. Read the file content **before** the skip decisions (today content is read only for non-skipped files).
2. Parse the directive. **Wrap the parse in try/catch.** A throw at module-registration time would abort the
   whole suite; instead register `describe(\`File: ${file}\`)` with a single failing `it` that rethrows, so a
   malformed directive fails exactly one file.
3. If `missingCapability(required, BACKEND_CAPABILITIES)` returns a token, register a skipped `it` naming the
   token — mirror the existing memory-only skip shape:
   `it.skip('skipped: backend lacks capability "standalone-index-ddl"', () => {})`.
4. Otherwise fall through to the existing `MEMORY_ONLY_FILES` check and normal execution. Capability skip is
   evaluated **first** so its more specific message wins when a file is in both.

`BACKEND_CAPABILITIES` selects on the existing `USE_STORE_MODULE` flag.

## Annotate the driving case

`10.1.2-ddl-in-transaction.sqllogic` exists entirely to test row-validating DDL inside an open transaction:
`create unique index` and `alter table … add constraint … unique` must see the issuing transaction's uncommitted
rows and stay enforced afterward. Backends that retired standalone index creation cannot run any of it, and there
is no honest rewrite — the DDL *is* the subject. Add `-- requires-capability: standalone-index-ddl` to its header
block.

Note while doing so: the file's §3–4 test `alter table … add constraint … unique`, which is a *different*
statement from `create index`. Whole-file granularity means it rides along under the same token. That is the
right call today — no evidence any backend supports one and not the other. Leave a `NOTE:` comment at the top of
the file recording it: *if a backend ever reports it supports `alter table … add constraint … unique` but not
standalone index DDL, split this file rather than adding a second token speculatively.*

## Edge cases & interactions

- **CRLF line endings.** The corpus is edited on Windows. Split on `/\r?\n/` in the pre-scan, and trim `\r`
  before matching — a `\r` sneaking into the token would make a valid token look unknown.
- **UTF-8 BOM** on the first line must not break the directive when it sits on line 1.
- **Directive on the very first line** (no preceding prose comment) — must work.
- **No directive at all** (the 280 other files) — returns an empty set, zero behavior change. Assert this
  explicitly; a regression here would skip or fail the whole corpus.
- **Blank lines inside the leading comment block** do not terminate it; the first non-blank non-`--` line does.
- **`-- error:` / `-- params:` / `-- run` lines are untouched.** They are also `--` comments; confirm the new
  pre-scan does not consume, reorder, or reject them, and that the main execution loop still ignores the
  `requires-capability` line (it starts with `--`, so the existing `continue` already handles it — verify, don't
  assume).
- **A capability line *after* SQL** must fail loudly (see Format), not be silently treated as file-level.
- **Duplicate token** across two directive lines — union, no error.
- **Trailing comment on the directive line**, e.g. `-- requires-capability: standalone-index-ddl -- why` — decide
  and document: simplest is to treat the whole remainder as tokens, so `--` and `why` become unknown tokens and
  error. That is acceptable and loud; document "no trailing comment on a directive line".
- **A skipped file must do no setup**: no `Database`, no LevelDB temp dir. Because the decision happens at
  registration time and `beforeEach` never runs for a skipped `it`, this falls out — confirm it in store mode
  rather than assuming.
- **Both skip mechanisms on one file** — capability message wins, exactly one `it` registered, no duplicate
  `describe`.
- **Corpus-wide guard**: every `.sqllogic` file must parse cleanly. This is the test that catches a typo'd
  directive added months from now.
- **`yarn lint` type-checks test files** via `tsconfig.test.json --noEmit`, so the new `.ts` files are covered by
  the normal lint run — no extra wiring, but do run it.

## Key tests

`packages/quereus/test/logic-capabilities.spec.ts`:

- No directive → empty set.
- Single token → `Set{'standalone-index-ddl'}`.
- Comma-separated, whitespace-separated, and repeated-line forms → same union.
- Mixed case directive name (`-- Requires-Capability:`) and mixed-case token → parsed.
- CRLF content → parsed.
- Unknown token `frobnicate` → throws; message names both `frobnicate` and the valid vocabulary.
- Empty token list (`-- requires-capability:`) → throws.
- Near-miss spellings `-- require-capability:`, `-- requires_capability:`, `-- requires capability:` → each throws.
- Canonical directive after the first SQL line → throws, message says it must be in the leading comment block.
- `missingCapability`: returns the token when the backend set is empty; returns `undefined` when the backend set
  is full; returns `undefined` for an empty required set against an empty backend set.
- **Synthetic-backend integration**: read the real `10.1.2-ddl-in-transaction.sqllogic` from disk, assert its
  parsed set contains `standalone-index-ddl`, and assert `missingCapability(required, new Set())` returns it —
  this is what pins the corpus to the mechanism, since quereus's own backends produce no skips.
- **Corpus guard**: `parseRequiredCapabilities` over every file in `test/logic/` throws for none of them.

Expected outcome of `yarn test`: identical pass/fail counts to before this ticket, plus the new
`logic-capabilities` suite. Zero `.sqllogic` files newly skipped — if any file skips locally, the capability
sets or the directive are wrong.

## Docs

- `packages/quereus/test/README.md` § Logic-test conventions — add the directive to the marker bullets, then a
  short subsection carrying: grammar, vocabulary table, whole-file-granularity/split-the-file rule, how to add a
  vocabulary member, and the two "what this is NOT" distinctions above. This file is the **format spec**; the
  format is the cross-repo contract, not the code — downstream harnesses reimplement the ~10-line parse against
  it. (Quereus does not publish its test tree: `package.json` `files` excludes `dist/test`.)
- `docs/architecture.md` § SQL Logic Tests (the bullet at ~line 216 listing the `→` and `-- error:` markers) —
  add `-- requires-capability:` with a one-line gloss and a pointer to `test/README.md`. Stay DRY: pointer only,
  no second copy of the spec.

## TODO

- Add `packages/quereus/test/logic-capabilities.ts`: vocabulary constant, `SqllogicCapability` type,
  `parseRequiredCapabilities`, `missingCapability`, the two backend capability sets.
- Wire `logic.spec.ts`: read content before skip decisions; parse in try/catch → failing `it` on error;
  capability skip before `MEMORY_ONLY_FILES`; select the backend set on `USE_STORE_MODULE`.
- Add the split-rule comment above `MEMORY_ONLY_FILES`; migrate no entries.
- Annotate `10.1.2-ddl-in-transaction.sqllogic` with the directive plus the `NOTE:` about the
  `add constraint … unique` half.
- Add `packages/quereus/test/logic-capabilities.spec.ts` covering the cases above, including the corpus guard.
- Update `packages/quereus/test/README.md` and the one-line pointer in `docs/architecture.md`.
- Run `yarn test` and `yarn lint`; confirm pass/fail counts unchanged and zero new skips. Run `yarn test:store`
  if time permits — it is the only way to exercise the store-mode branch of the capability-set selection.
