---
description: |
  A shared SQL test file can now declare which database features it needs, so a database backend
  that deliberately lacks one of those features skips the file automatically instead of every
  backend hand-maintaining its own list of files to skip.
files:
  - packages/quereus/test/logic-capabilities.ts        # directive parser + capability vocabulary
  - packages/quereus/test/logic-capabilities.spec.ts   # 29 unit tests + corpus-wide parse guard
  - packages/quereus/test/logic.spec.ts                # harness wiring (BACKEND_CAPABILITIES, per-file loop)
  - packages/quereus/test/logic/10.1.2-ddl-in-transaction.sqllogic  # the one annotated file
  - packages/quereus/test/README.md                    # § `-- requires-capability:` directive = format spec
  - docs/architecture.md                               # § Testing Strategy — pointer only
difficulty: medium
---

# Complete: `-- requires-capability:` directive for the `.sqllogic` corpus

## What shipped

`packages/quereus/test/logic/*.sqllogic` is a corpus shared with other projects that run the same
281 files against their own storage engine. Previously each consumer hand-maintained a list of file
names its backend can't run. Now a file declares the feature it needs and each harness declares once
which features its backend has.

- **`test/logic-capabilities.ts`** — pure string-in/data-out, no engine imports.
  `SQLLOGIC_CAPABILITIES` is a closed vocabulary with one member today, `standalone-index-ddl`
  ("backend accepts `create index` / `create unique index` / `drop index` as standalone statements").
  `parseRequiredCapabilities(fileName, content)` returns the required set and throws on malformed
  input; `missingCapability(required, supported)` returns the first missing token.
- **`logic.spec.ts` wiring** — per file at `describe`-registration time: parse inside a try/catch
  (a throw registers one failing `it`, so a bad directive fails exactly one file rather than aborting
  suite registration), then the capability skip, then the pre-existing `MEMORY_ONLY_FILES` check.
  `MEMORY_ONLY_FILES` is unchanged and now documents the split rule against the new directive.
- **Format spec** lives in `packages/quereus/test/README.md` — the format, not the code, is the
  cross-repo contract. `docs/architecture.md` carries a one-line pointer.

Both quereus backends are capability-complete, so the mechanism produces **zero local skips**. That is
by design; the payoff is downstream. Annotating the rest of the corpus is
`tickets/implement/2-sqllogic-capability-corpus-sweep.md` (already queued, prereq'd on this).

## Review findings

### Fixed in this pass (minor)

- **Brittle corpus assertion that would have broken the very next ticket.**
  `logic-capabilities.spec.ts`'s "every file that does not mention the directive parses to an empty
  set" test ended with `expect(checked).to.be.greaterThan(files.length - 5)` — a magic threshold that
  passes today only because exactly one of 281 files is annotated. The queued corpus sweep annotates
  more than four more files, at which point `checked` drops below the threshold and this test fails for
  no real reason. Replaced with: build the unannotated list, assert it is non-empty, then check each.
  Same guarantee, no coupling to how many files are annotated.
- **`catch (parseError: any)` in `logic.spec.ts`** — AGENTS.md bans `any`. Changed to `unknown`; the
  following `instanceof Error` narrowing already handled it. Lint and the test typecheck pass.
- **Four parser tests added** for input shapes the format admits but nothing exercised: no space after
  the comment marker (`--requires-capability:x`), redundant/leading/trailing separators, empty file and
  comment-only file, and an assertion that the error message names the offending **line number** (only
  the file name was previously asserted). Suite is now 29 passing.

### Checked and found sound

- **Parser correctness.** Leading-comment-block boundary (blank lines do not terminate it, first SQL
  line does), BOM, CRLF, case-insensitive directive name with lowercased tokens, multi-line union,
  and the four hard-error paths (unknown token, no tokens, canonical directive after the first SQL
  line, near-miss spelling). `isCapability` uses `hasOwnProperty`, so `-- requires-capability: toString`
  is correctly rejected rather than matching a prototype key.
- **Skip branch proved end-to-end, independently of the implementer's run.** Temporarily set
  `MEMORY_BACKEND_CAPABILITIES` to an empty set and ran `logic.spec.ts --grep "10\.1\.2"`:
  `- skipped: backend lacks capability "standalone-index-ddl"`, `0 passing, 1 pending` in 15ms —
  `beforeEach` never ran, no `Database` or temp store created. Reverted.
- **Malformed-directive isolation proved end-to-end.** Temporarily broke the directive in
  `10.1.2-ddl-in-transaction.sqllogic` to `-- requires_capability:` and ran `--grep "10\.1\."`:
  `3 passing, 1 failing` — exactly that one file failed, with the file name and line number in the
  message; its three siblings ran normally. Reverted.
- **Docs match reality.** Read every touched doc and the claims inside them. `test/README.md`'s
  assertion that the test tree is not published checks out (`package.json` `files` is
  `["dist","!dist/test","!**/*.tsbuildinfo"]`). `docs/architecture.md`'s testing section is the only
  other place that enumerates `.sqllogic` markers and it was updated. `docs/sqlite-test-crosscheck-process.md`
  mentions `-- error:` only in the context of porting SQLite fixtures — not a directive index, left alone.
  No other doc lists the corpus markers.
- **No other in-repo consumer of the corpus.** The `.sqllogic` files are read only by `logic.spec.ts`;
  other packages' specs merely reference file names in comments. Nothing else needed wiring.
- **New spec file is actually collected.** `test-runner.mjs` globs `test/**/*.spec.ts`, so
  `logic-capabilities.spec.ts` runs under both `yarn test` and `yarn test:store` — not only under the
  ad-hoc mocha invocation the implementer used.

### Accepted as-is (raised, judged correct)

- **No permanent coverage of the harness's four-line skip branch.** Covering it needs either an env-var
  override or a subprocess mocha run — new test-only surface for four lines that mirror the existing
  `MEMORY_ONLY_FILES` shape. The manual proof above is recorded instead. Agreed with the implementer.
- **`MEMORY_BACKEND_CAPABILITIES` and `STORE_BACKEND_CAPABILITIES` alias the same set.** Makes "both are
  full" self-evident; de-aliasing is a one-line edit when they diverge. Keep.
- **Corpus-path resolution (`isInDist` / `projectRoot` / `logicTestDir`) is duplicated** between
  `logic.spec.ts` and `logic-capabilities.spec.ts`. Three lines; extracting them would mean a second
  shared test module, and `logic-capabilities.ts` itself must stay filesystem-free to remain portable.
  Not worth the indirection.
- **Only one of 45 index-DDL-using files is annotated.** By design — the corpus sweep is a separate
  queued ticket with an explicit classification rule, precisely so files that use an index only as
  scenario setup are not blanket-annotated into a silent coverage hole.

### Tripwire (recorded, not ticketed)

- `NEAR_MISS_RE` is deliberately loose enough to fire on prose that merely opens a comment line with
  "requires capability" / "required capability" — no colon required. No corpus file does that today.
  Parked as a `NOTE:` comment at the regex in `logic-capabilities.ts` saying to rephrase the prose
  rather than narrow the regex, since narrowing it lets a real typo through silently.

### New tickets filed

None. The one gap worth its own work — annotating the rest of the corpus — was already filed at plan
stage as `tickets/implement/2-sqllogic-capability-corpus-sweep.md` with
`tickets/backlog/feat-sqllogic-split-incidental-index-ddl.md` behind it. Filing a duplicate would have
split the same work across two tickets.

## Validation

| Command | Result |
|---|---|
| `yarn lint` (root, fans out; quereus runs eslint + `tsc -p tsconfig.test.json --noEmit`) | clean |
| `yarn test` (root, all workspaces) | 0 failing. quereus **7550 passing, 13 pending** (7546 + the 4 tests added here; pending unchanged, no `lacks capability` line) |
| `yarn test:store` | 0 failing. **7543 passing, 20 pending** = 13 base + the 7 `MEMORY_ONLY_FILES` entries; zero capability skips, as expected |
| `logic-capabilities.spec.ts` alone | 29 passing |

No pre-existing failures surfaced; `tickets/.pre-existing-error.md` not written.
