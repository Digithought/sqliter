----
description: Measure how much slower a random row read is than a sequential one on the LevelDB storage backend, so its declared cost numbers come from a benchmark instead of an assumption.
prereq: store-backend-cost-profile
files:
  - packages/quereus-plugin-leveldb/src/provider.ts (where a measured profile would be declared)
  - packages/quereus-plugin-indexeddb/bench/ (the IndexedDB equivalent — shape to copy)
  - packages/quereus-store/src/common/cost-profile.ts (the two knobs and their units)
tradeoffs: LevelDB's block cache probably does put a point read close to a sequential read, so the measurement may well confirm the parity default it would replace — and a benchmark that changes nothing is still a benchmark someone has to maintain.
----

# Why

Storage backends declare how expensive their basic operations are, relative to reading one
row sequentially during a full scan. Two numbers: the cost of a random point read of one row,
and the cost of one seek key in a multi-key lookup.

IndexedDB's numbers come from a real browser benchmark. LevelDB's do not exist — it declares
nothing and therefore takes the framework's parity default ("a random read costs about what a
sequential read costs"), which was chosen for it years ago by assumption, never measured.
That default is probably about right — LevelDB reads in-process through a block cache — but
"probably about right" is what the whole cost-profile mechanism exists to stop relying on.

# What would settle it

A small Node-side harness, in the spirit of `packages/quereus-plugin-indexeddb/bench/` but far
simpler (no browser, no server, no HTML):

- Seed a LevelDB store with a realistic row shape (the IndexedDB bench uses 200-byte values;
  match it so the two backends' numbers are comparable).
- Time a full sequential iterate over N rows → milliseconds per row.
- Time N random point reads (via the batched `getMany` path the index resolver actually uses,
  not a naive `get` loop) → milliseconds per row.
- Time N single-key seeks → milliseconds per key.
- Two dataset sizes, one comfortably inside the OS page cache and one well outside it — the
  IndexedDB run showed the small size hid the effect entirely, and cold-versus-warm is the
  whole question for a disk-backed store.

The output is two ratios. If they come back near 1.0 and 0.5, declare nothing and record the
measurement in the plugin's README so the next person does not re-ask. If they come back far
from parity, declare the measured profile on `LevelDBProvider`.

The same harness would answer the question for the React Native LevelDB and NativeScript
SQLite backends, which are in the same undeclared position, though each needs its own runtime
to run in.
