## General

- Lowercase SQL reserved words (e.g., `select * from Table`)
- No inline `import()` unless dynamic load
- No summary docs; update existing docs instead
- Stay DRY
- No lengthy summaries
- Backwards compat: don't worry yet
- Use yarn
- Prefix unused args `_`
- Brace `case` blocks if consts/vars inside
- Prefix unused promise calls (micro-tasks) `void`
- ES Modules
- No `any` — type it right
- Don't eat exceptions silent; log at least. Exceptions exceptional, not control flow
- Small single-purpose funcs/methods. Decomposed sub-funcs > grouped sections
- No janky half-baked parsers; full parser or brainstorm alt approach w/ dev
- Think cross-platform (browser, node, RN, etc.)
- `.editorconfig` = formatting source (tabs for code)

## Tickets (tess)

Project uses [tess](tess/) for AI ticket mgmt.
Read + follow ticket workflow rules in tess/agent-rules/tickets.md.
Tickets in [tickets/](tickets/) dir.
If asked to "tend the garden" or similar, see tess/agent-rules/tend.md.

## Launch process tool (if under PowerShell)

`launch-process` wraps cmds in `powershell -Command ...` — strips inner quotes, parses parens as subexpressions. Makes `git commit -m "task(review): ..."` impossible — no escape works.
Workaround: file or pipe pattern. e.g. `git commit -F .git/COMMIT_EDITMSG`

## Project Structure

Yarn 4 monorepo. All packages under `packages/`.

```
quereus/                   # Main SQL engine — see its README for detailed src/ layout
├── src/                   #   core/ parser/ planner/ runtime/ emit/ schema/ types/ func/ vtab/ common/ util/
│   ├── planner/           #   building/ nodes/ rules/{access,aggregate,cache,distinct,join,predicate,retrieve,subquery}/
│   │                      #   framework/ cost/ analysis/ stats/ validation/ scopes/ cache/
│   └── runtime/emit/      #   Instruction emitters — mirrors planner/nodes/ 1:1
├── test/                  #   logic/*.sqllogic (primary), plan/, optimizer/, planner/, vtab/
└── docs/                  #   runtime.md, types.md, sql.md, optimizer.md, schema.md, ...
quoomb-cli/                # CLI tool
quoomb-web/                # Web UI
quereus-store/             # Persistent key-value store abstraction
quereus-isolation/         # Transaction isolation layer (read-your-own-writes; not snapshot isolation)
quereus-sync/              # Sync engine
quereus-sync-client/       # Sync client
sync-coordinator/          # Sync server/coordinator
plugin-loader/             # Plugin loading infrastructure
quereus-plugin-leveldb/    # LevelDB storage plugin
quereus-plugin-indexeddb/  # IndexedDB storage plugin
quereus-plugin-react-native-leveldb/
quereus-plugin-nativescript-sqlite/
quereus-vscode/            # VS Code extension
shared-ui/                 # Shared UI components
sample-plugins/            # Example plugins
```

Task workflow in `tickets/` folder (see `tickets/AGENTS.md`).

## Build & Test
- `yarn build` compiles all library packages via `tsc -b tsconfig.build.json` (project references — dependency-ordered, incremental, skips unchanged), then builds the 3 bundled apps (shared-ui, vscode, quoomb-web)
- `yarn test` runs all workspace tests — **default for agents**; fast, memory-backed vtab
- `yarn test:store` re-runs `packages/quereus` logic tests vs LevelDB store module (slower; exercises store path for ALTER, constraints, transactions, etc.)
- `yarn test:full` runs both — **only for store-specific diagnosis or release prep**
- `yarn lint` fans out across **every** package (`workspaces foreach ... run lint`). Only `packages/quereus` has a real lint (eslint **+** type-checks test files via `tsc -p tsconfig.test.json --noEmit`, catches signature drift in spec call sites too; ~adds tsc pass, slower than eslint alone). Every other package ships an intentional `echo 'No lint configured'` no-op so foreach reaches it instead of silently skipping — each package has a `lint` script, so `yarn check` can't miss one
- `yarn typecheck` fans out too, and runs inside `yarn check` **after** `yarn build` (a package whose typecheck covers its test files — e.g. `plugin-loader`'s `tsconfig.test.json` pass — resolves workspace deps via their built `dist` types). Put a test-file type pass in `typecheck`, not `lint`, for that reason. Every package needs a `typecheck` script (same reason as `lint`: foreach silently skips a workspace missing it), and every `tsconfig.test.json` must repeat `"exclude": ["node_modules", "dist"]` — `extends` inherits the base `exclude`, and a base that excludes `test` silently filters the test `include` back out, so the pass compiles zero files and reports success. Verify with `tsc -p tsconfig.test.json --noEmit --listFiles` — a zero-file config looks identical to a clean one otherwise
- Windows: lint globs must single-quote, avoid cmd-line-too-long errors
- Tests: Mocha + ts-node/esm for quereus, Vitest for other packages
- Default cwd = repo root. Already `cd packages/quereus` in prior Bash call? cwd persists — don't re-prefix `cd packages/quereus &&`. Chain in one Bash call, or use absolute paths / `yarn workspace @quereus/quereus run <script>` from root.
- Streaming long output: `2>&1 | tee /tmp/foo.log` recommended, but Windows+Git Bash `| tee | tail` pipeline can drop stdout silently. `tee` empty? Don't rebuild — chain separate read: `yarn test 2>&1 | tee /tmp/test.log; tail -n 80 /tmp/test.log`. PowerShell: use `Tee-Object` not `tee`.

## Key Architecture Notes
- All tables virtual tables (VTab-centric design)
- Async core: cursors `AsyncIterable<Row>`
- Key-based addressing (no rowids)
- Type system: logical/physical split w/ temporal types
- Pipeline: SQL → parser → AST → planner/building → PlanNode tree → optimizer rules → emit → Instructions

## Docs
- **Start here for engine internals:** `docs/architecture.md` — pipeline, src layout, extension patterns, design decisions, constraints, test strategy
- **Package overview / user-facing:** `packages/quereus/README.md` — quick start, platform/storage, docs index, current status
- Deeper topic docs in `docs/` (runtime.md, types.md, sql.md, optimizer.md, schema.md, usage.md, etc.)

----

Any non-trivial ask: read + maintain relevant docs alongside work.

## Code search (tess)

**First tool** for "where/how/why" Q on codebase: local code-aware index wired to `mcp__code-search__*`. `grep`/`Glob` only when filename or literal string already known. Pick right sub-tool — not interchangeable.

**Decision rule:**

- Identifier-shaped query (single symbol, camelCase, snake_case, or name list like `fooBar bazQux`)? → `find_references`.
- Prose query ("where do we evict pages", "what handles JWT refresh", identifier unknown)? → `search_code`.
- About to run 2+ `grep` to rebuild context? → `search_code` first instead. Pays off even w/ known identifier.

`search_code` embeds query as NL. Identifier-bag queries can work if identifiers co-locate in real code, but prose phrasing more reliable. Weak-top warning from `search_code` → relative-% ranking unreliable — switch to `find_references` or rephrase as prose. Don't trust ordering on noisy results.

**Tools:**

- `search_code(query, k?, path_filter?)` — semantic search. Scores relative within result set, not absolute. `k` default 5 (max 50) — raise for broad sweeps, lower when top hit enough. `path_filter` = SQL LIKE pattern, e.g. `"packages/lamina/%"`.
- `find_references(symbol, max?, path_filter?)` — literal substring; `|` ORs alternatives (`Foo|Bar`). Returns every hit (capped by `max`, default 50, max 500). Indexed replacement for `grep` on identifiers.
- `read_chunk(path, start_line, end_line)` — expand snippet from either tool, no separate `Read` needed.

**Fallbacks:**

- `grep`/`Glob` only for filename patterns, regex w/ anchors/lookarounds, or need *every* literal hit (index chunk-granular, may miss adjacent matches in one chunk).
- Never fall back to `grep` when `find_references` suffices — strictly slower, pulls more bytes.

**What's indexed:** project source files tracked by git, minus `node_modules/`, `dist/`, `build/`, `.git/`, `tickets/`, `team/`, `docs/`, few cache dirs. Prose-heavy query (long-form arch docs, design notes, nested READMEs) returns nothing → file likely outside indexed set — fall back to `Read`/`Glob` for those paths. Projects can override filter via `tickets/index-config.json` (see tess README § Customize what gets indexed).

## Caveman

Respond terse like smart caveman. All technical substance stay. Only fluff die.

Rules:
- Drop: articles (a/an/the), filler (just/really/basically), pleasantries, hedging
- Fragments OK. Short synonyms. Technical terms exact. Code unchanged.
- Pattern: [thing] [action] [reason]. [next step].
- Not: "Sure! I'd be happy to help you with that."
- Yes: "Bug in auth middleware. Fix:"

Switch level: /caveman lite|full|ultra|wenyan
Stop: "stop caveman" or "normal mode"

Auto-Clarity: drop caveman for security warnings, irreversible actions, user confused. Resume after.

Boundaries: code/commits/PRs written normal.
