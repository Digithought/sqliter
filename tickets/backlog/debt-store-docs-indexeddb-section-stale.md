description: The storage design document still describes the browser (IndexedDB) storage backend the way it worked before it was rebuilt, telling readers it cannot do something it has been able to do for a while.
files:
  - docs/store.md                                    # "IndexedDB Backend" and "IndexedDB Architecture Gap" sections
  - packages/quereus-plugin-indexeddb/src/provider.ts # what actually shipped
  - packages/quereus-plugin-indexeddb/src/manager.ts  # the single shared database
difficulty: easy
tradeoffs: Documentation-only — nothing misbehaves, and a reader who opens the plugin source sees the truth immediately; a maintainer could reasonably decide the whole design document needs a sweep rather than one section patched.
----

## What is wrong

`docs/store.md` has two adjacent sections, "IndexedDB Backend" and "IndexedDB Architecture
Gap", that describe a design the plugin no longer uses:

- They say each table gets **its own IndexedDB database** (`quereus_main_users`,
  `quereus_main_orders`). It does not: `IndexedDBProvider` opens **one** database and creates
  one object store per logical store inside it.
- They offer a `database='shared_name'` option for putting several tables in one database.
  `IndexedDBProviderOptions` has no such option — only `databaseName` and `cache`.
- The "Architecture Gap" section states as a **current limitation** that writes spanning two
  tables cannot be atomic, then proposes consolidating to a single database as the
  "preferred direction". That consolidation already shipped, and with it
  `IndexedDBProvider.beginAtomicBatch`, which commits across object stores in one native
  IndexedDB transaction. The comparison table contrasting "single database" against
  "multiple databases (current)" is describing a decision that was already made.

The naming examples are stale in a second way: physical store names now come from the shared
builders, so an IndexedDB object store is named `main.users`, not `quereus_main_users`.

## Why it is worth fixing

`docs/store.md` is the design document a contributor reads before touching storage. Someone
reading these sections would conclude that cross-table atomicity is unavailable in the
browser and either work around a problem that no longer exists or re-propose work that is
done. The sections immediately following ("Isolation Gap") are accurate and depend on the
reader having a correct picture of what atomicity the backend does provide.

## Expected outcome

The two sections describe what the plugin does today: one database, one object store per
logical store, cross-store atomicity via `beginAtomicBatch`, and the naming that the
"Store Naming Convention" section already documents. The still-open limitation (isolation, not
atomicity) stays clearly separated from the closed one, so a reader can tell which is which.
