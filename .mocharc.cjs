// Repo-wide Mocha defaults.
//
// Every workspace that runs Mocha directly (quereus-sync, quereus-store,
// quereus-isolation, the storage plugins, sync-coordinator, ...) invokes it
// from the repo root, so this file is the one place their shared options live.
//
// timeout: Mocha's 2s default is too tight for these suites. They do real
// async setup in hooks — spinning up databases, synced peer pairs, LevelDB
// handles — which nominally takes a few hundred ms but is easily starved past
// 2s when the machine is under concurrent load (a parallel `yarn test` fan-out,
// a background ticket runner). 10s keeps genuine hangs detectable while
// absorbing contention. Override per-run with `--timeout <ms>`; an explicit
// flag or an explicit `--config` both take precedence over this file.
module.exports = {
	timeout: 10000,
};
