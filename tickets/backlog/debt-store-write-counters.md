description: The benchmark suite can report how many times a query read from storage, but has no equivalent number for writes — so a change that made every insert write twice as much would not show up anywhere.
files:
  - packages/quereus-store/src/testing/kv-counting-store.ts   # CountingKVStore — counts reads only today
  - packages/quereus/bench/lib/store-counters.mjs             # where the bench block is assembled; carries the NOTE naming this
  - docs/benchmarking.md                                      # § "Storage round trips: what a store-mem row counts"
difficulty: easy
tradeoffs: The read counts already catch the regression class that motivated the whole metric (row resolution that stops batching); adding write counters widens a test-support class's public surface for a signal nobody has yet needed, and every existing bench baseline gains new counter paths on the run it lands.
----

# Count writes, not only reads, in the storage counters

## The situation

`yarn bench` measures each query and write workload twice — once on the in-memory table
module and once on the persistent-storage path — and for the storage runs it reports how
many times the engine went to storage. That number is the durable, machine-independent
part of the measurement: a wall-clock figure depends on the laptop, but "this query issued
one batched read carrying ten keys" is the same everywhere, and a change that turned it
into ten separate reads is a regression you can see without trusting a stopwatch.

That reporting is **reads only**. The counting store double the harness wraps around each
key-value store counts single reads, batched reads and scan volume, and has no counter for
writes or deletes at all. So a write-heavy benchmark's storage block describes the *reads*
its writes provoked — index maintenance, uniqueness probes, read-then-write — and never
the writes themselves.

Concretely: the bulk-insert benchmark reports 30 000 single reads for 10 000 inserted
rows, which is a real and useful number (three reads per inserted row, and a diff would
show it moving). It is simply not the cost of an insert. A change that doubled how many
key-value writes each inserted row costs would move the wall-clock number — which is noisy
and machine-dependent — and move nothing else.

## What's wanted

Write counters alongside the read counters, on the same footing: counted at the same
boundary, reported per physical store in the same block, and compared exactly like every
other counter. The natural set is writes issued, deletes issued, and batched-write round
trips, mirroring how reads already distinguish "how many calls" from "how many keys".

Two constraints worth stating up front:

- The counting store is **shared test-support**, used by the storage package's own tests as
  well as by the benchmark harness. Existing tests assert on the read counters only, so
  adding fields is additive and should not disturb them — but the change lands in that
  package's public testing surface, not in the benchmark harness alone. That crossing is
  the reason the benchmark work stopped short of doing it.
- Every recorded benchmark baseline gains new counter paths the run this lands. The
  comparison reports an appeared counter path as loudly as a changed count, so the first
  run after it will be noisy by design; that is expected, not a defect.

## Why it is filed rather than done

The read counters were built because one specific regression had no coverage: secondary
index lookups that stop batching their row fetches. They cover it. Nobody has yet had a
write-path question the read counters could not answer, so this is a known partial view
with the fix already named at the code site, not a defect. It is worth doing the next time
someone needs to pin a write-path regression to a count rather than to a timing.
