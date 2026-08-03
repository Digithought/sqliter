/**
 * Wires the CLI up to load plugins from `https://` URLs.
 *
 * Node cannot `import()` an https URL, so the loader delegates to a resolver
 * that fetches the module to a temp file first. Installing it here also gives us
 * the one place where a remote fetch becomes visible: every load of a saved
 * plugin re-downloads and re-executes remote code, and that should never happen
 * silently.
 */

import chalk from 'chalk';
import { hashRemoteModule, installNodeRemoteModuleResolver } from '@quereus/plugin-loader/node';
import type { RemoteModuleFetch } from '@quereus/plugin-loader';

/**
 * Most recent fetch per requested URL. Read back by the `.plugin` commands so an
 * installed plugin's recorded hash can be compared against what was actually
 * served this time.
 *
 * Keyed by {@link normalizeUrlKey}, not the raw string: the loader hands the
 * resolver a parsed `URL`, so what arrives here is already normalized, while a
 * plugin record holds whatever the user typed.
 */
const lastFetchByUrl = new Map<string, RemoteModuleFetch>();

/**
 * Expected hashes derived from the plugin records in `~/.quoomb/plugins.json`.
 * Keyed by {@link normalizeUrlKey}, for the same reason {@link lastFetchByUrl}
 * is: a record holds whatever the user typed, the resolver is handed the parsed
 * href.
 */
const pinnedHashByUrl = new Map<string, string>();

let installed = false;

/**
 * Replaces the record-derived pin table wholesale, so removing or unpinning a
 * plugin drops its pin. Re-synced whenever the records change, which is what
 * makes an unpin take effect in the same session rather than at the next start.
 *
 * Callers pass only the records that are actually pinned *and* have a recorded
 * hash; a URL held by both a pinned and an unpinned record is therefore pinned.
 * The pin table is per-URL and there is no honest way to apply two policies to
 * one download.
 *
 * NOTE: two pinned records for the same URL with *different* hashes cannot both
 * be satisfied. The first entry wins, so the outcome is at least deterministic
 * (record order in `plugins.json`). Only reachable by hand-editing that file —
 * `.plugin install` refuses a URL that is already installed.
 *
 * A second source — hashes declared in `quoomb.config.json` — is planned; when it
 * lands it takes precedence over these, which is why {@link lookupPin} stays
 * private.
 */
export function setRecordPinnedHashes(pins: Iterable<{ url: string; sha256: string }>): void {
	pinnedHashByUrl.clear();
	for (const pin of pins) {
		const key = normalizeUrlKey(pin.url);
		if (!pinnedHashByUrl.has(key)) {
			pinnedHashByUrl.set(key, pin.sha256);
		}
	}
}

/**
 * The hash `url` must serve, or undefined when it is not pinned. Deliberately
 * not exported: the resolver asks through the closure below, so a second pin
 * source can slot in ahead of the record source without touching callers.
 */
function lookupPin(url: string): string | undefined {
	return pinnedHashByUrl.get(normalizeUrlKey(url));
}

/**
 * Installs the Node remote-module resolver. Called from every CLI entry point
 * (`bin/quoomb.ts` and the package index) before any plugin load — config
 * autoload, saved-plugin autoload, and the interactive `.plugin` commands all go
 * through the same loader. Repeat calls are ignored.
 */
export function installRemotePluginResolver(): void {
	if (installed) return;
	installed = true;

	installNodeRemoteModuleResolver({
		expectedHash: (url: string) => lookupPin(url),
		onFetched: (info: RemoteModuleFetch) => {
			lastFetchByUrl.set(normalizeUrlKey(info.url), info);
			console.log(chalk.gray(
				`Fetched plugin ${info.url} (${formatBytes(info.bytes)}, sha256 ${info.sha256})`
			));
		}
	});
}

/**
 * SHA-256 of the bytes last fetched for `url`, or undefined when this URL has
 * not been fetched in this process (a `file:` plugin, for instance, never is).
 */
export function getLastFetchedHash(url: string): string | undefined {
	return lastFetchByUrl.get(normalizeUrlKey(url))?.sha256;
}

/**
 * Fetches `url` and reports what it serves right now — same transport checks and
 * size cap as a load, but nothing is written to disk and nothing is imported.
 * `.plugin trust` uses it to adopt a new version without running it first.
 *
 * This is a *separate* fetch from any load that follows, so the bytes can change
 * in between and a pinned load then fails. That fails closed and is acceptable;
 * the digest is not a promise about the next load.
 *
 * Wrapped here rather than imported at the call site so the Node-only
 * `@quereus/plugin-loader/node` subpath stays confined to this module.
 */
export async function fetchRemoteModuleHash(url: string): Promise<RemoteModuleFetch> {
	return await hashRemoteModule(new URL(url));
}

/**
 * Canonical form of a plugin URL, so `https://Example.com:443/p.mjs` and
 * `https://example.com/p.mjs` are recognized as the same fetch. Unparseable
 * input falls through unchanged — it never matches a recorded fetch anyway.
 */
function normalizeUrlKey(url: string): string {
	try {
		return new URL(url).href;
	} catch {
		return url;
	}
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
