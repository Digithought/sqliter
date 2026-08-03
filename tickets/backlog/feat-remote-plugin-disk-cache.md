----
description: Every time the command-line tool starts, it re-downloads each plugin it loads from the web, so startup needs a network connection and takes as long as the downloads do. Keep a local copy instead.
files:
  - packages/plugin-loader/src/node-remote.ts (`createNodeRemoteResolver`, `ensureModuleDir`, `writeModuleFile`)
  - packages/quoomb-cli/src/plugins/remote-resolver.ts
difficulty: medium
----

## The problem

A plugin installed from an `https:` URL is downloaded again on every start of the
CLI. There is no cache: the resolver fetches the module, writes it to a temp
directory that is deleted when the process exits, and starts over next time.

Consequences:

- Startup blocks on one network round trip per remote plugin.
- An offline or captive-portal machine cannot load remote plugins at all — and,
  because a failed startup load currently disables the plugin record, may lose
  them (see `bug-cli-corrupt-plugins-file-silently-wipes-plugins`, Arm B).
- The download is a repeated opportunity for the served bytes to differ from what
  the user approved. Verification (`feat-plugin-loader-hash-pinning` and
  `feat-cli-plugin-pinning`) closes the safety side of that, but it does not
  remove the round trip.

## Expected behavior

Bytes that were fetched and verified once should be reusable without fetching
again:

- A cached copy keyed by content hash, so "is this the code the user approved?"
  is answered by the cache key itself rather than by a fresh download.
- A cache hit loads without touching the network; startup works offline for any
  plugin whose approved version is already local.
- An explicit way to bypass or clear the cache — accepting a new version has to
  reach the network.

## Open questions for whoever picks this up

- Where the cache lives, and whether it is the loader package's concern or the
  host's. The temp-directory logic is in `node-remote.ts`, but a durable cache
  wants a real per-user directory, which is a host decision.
- Whether an unpinned plugin should be cached at all. Caching an unpinned plugin
  means the user stops seeing the "this changed" warning that is today's only
  signal.
- Eviction and staleness: how a user learns a newer version exists if the tool
  stops looking.
- Interaction with the `?t=` cache-buster and the per-load temp filename, both of
  which exist to force re-evaluation and would need to keep working.

## Provenance

Split out of `feat-remote-plugin-verify-before-execute`, which asked whether an
on-disk cache should replace the per-start re-download. It should not block the
verification work: verification is a correctness/safety gate, this is a startup
latency and offline-availability concern, and the two have separate designs.
