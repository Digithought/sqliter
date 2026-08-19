description: One benchmark definition file has grown to about ten times the size of its siblings, and its own header says the point at which it should be broken apart has now been reached.
files:
  - packages/quereus/bench/suites/store.bench.mjs   # 1635 lines; the file to break apart
  - packages/quereus/bench/lib/discover.mjs         # why the split cannot be into sibling *.bench.mjs files
  - docs/benchmarking.md                            # § The `store` suite describes the groups
difficulty: medium
tradeoffs: Splitting changes no measurement and fixes no bug — a maintainer could reasonably say a long, heavily commented file that reads top-to-bottom in three clearly labelled sections is easier to follow than three files plus a re-export, and that the churn costs more review attention than the organization buys.

---

# What is oversized

`packages/quereus/bench/suites/store.bench.mjs` is 1 635 lines
(`wc -l packages/quereus/bench/suites/*.bench.mjs`, measured 2026-08-19). The other four
suite files in that directory are 78, 96, 150 and 170 lines. It holds 27 benchmarks where
the others hold four to fifteen.

The file's own header anticipated this and wrote down the trigger and the remedy: it said
the two halves were left whole deliberately, and that **if a third group ever landed**, the
groups should move into a `suites/store/` directory that `store.bench.mjs` re-exports. That
trigger has now tripped — the read-cost group (`leveldb-read-cost-*`) is the third — and the
header records that the split is due and points here.

# The three groups

Each is a self-contained section already, with its own section comment, its own constants
and its own factory functions:

- **key encoding** — 11 benchmarks that call `@quereus/store`'s key functions directly, with
  no database and no storage traffic.
- **store hot paths** — 14 benchmarks driven through a `Database` over the store module,
  each asserting exact storage round-trip counts alongside its timing.
- **read cost on real disk** — 2 benchmarks that drive a LevelDB `KVStore` with no
  `Database` above it, to price a random read against a sequential one.

# The constraint that shapes the fix

`bench/lib/discover.mjs` names a suite after its **file**: it reads `bench/suites/`
non-recursively and treats every `*.bench.mjs` it finds as one suite, named for the file
minus the extension. So splitting into sibling `keys.bench.mjs` / `hot-paths.bench.mjs` /
`read-cost.bench.mjs` would turn one `store` suite into three, and **every published row
name would change** — which breaks comparison against every existing baseline file in
`bench/results/`.

The shape that does not: a `bench/suites/store/` subdirectory holding the three modules
under names that do **not** end in `.bench.mjs` (so `discover.mjs` never sees them as
suites), with `store.bench.mjs` reduced to imports and one `export const benchmarks` array
that concatenates the three groups in today's order. Row names, and therefore baselines,
are untouched.

# What must still hold afterwards

- The benchmark **order** inside the exported array stays as it is; the run order is what
  every recorded results file was produced under.
- `@quereus/store` keeps exactly **one** dynamic import site
  (`bench/lib/store-counters.mjs`) and `@quereus/plugin-leveldb` exactly one
  (`bench/lib/leveldb-backend.mjs`). Three files must not become three import sites — the
  parent process imports every suite file just to enumerate names, and an unbuilt `dist`
  reaching one of them would kill the whole `yarn bench` run.
- `store.bench.mjs` currently type-checks clean under `packages/quereus/tsconfig.test.json`
  even though `bench/suites/**` is outside that pass (see
  `debt-bench-suites-outside-type-pass`); the split files should too.
- `docs/benchmarking.md` § The `store` suite describes the groups and their counts, and needs
  to keep matching.
