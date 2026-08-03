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
import type { RemoteModuleFetch, QuoombConfig } from '@quereus/plugin-loader';

/** A SHA-256 as a config entry or plugin record must supply it: 64 hex characters. */
const SHA256_HEX = /^[0-9a-f]{64}$/i;

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

/**
 * Expected hashes declared directly in `quoomb.config.json`. Keyed the same way
 * as {@link pinnedHashByUrl}. Takes precedence over it in {@link lookupPin}: the
 * config file is the explicit, reviewed declaration, while a record hash is only
 * what happened to be served the first time someone ran `.plugin install`.
 */
const configPinnedHashByUrl = new Map<string, string>();

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
 * A config-declared hash for the same URL takes precedence over these — see
 * {@link setConfigPinnedHashes} — which is why {@link lookupPin} stays private.
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
 * Expected hashes declared in `quoomb.config.json`. Seeded once per process,
 * before any config plugin loads. Takes precedence over hashes derived from
 * `~/.quoomb/plugins.json` (see {@link setRecordPinnedHashes}): the config file
 * is the explicit, reviewed declaration, and a record hash is only what happened
 * to be served once.
 *
 * When a URL is pinned by both sources to *different* hashes, warns once here
 * (not on every subsequent lookup) naming the URL and both values, so a user is
 * not left wondering why their `.plugin trust` had no effect.
 */
export function setConfigPinnedHashes(pins: Iterable<{ url: string; sha256: string }>): void {
	configPinnedHashByUrl.clear();
	for (const pin of pins) {
		configPinnedHashByUrl.set(normalizeUrlKey(pin.url), pin.sha256);
	}
	for (const [url, configHash] of configPinnedHashByUrl) {
		const recordHash = pinnedHashByUrl.get(url);
		if (recordHash && recordHash !== configHash) {
			console.warn(chalk.yellow(
				`Plugin ${url} is pinned to different hashes by quoomb.config.json (${configHash}) ` +
				`and its saved plugin record (${recordHash}); the config file's hash wins.`
			));
		}
	}
}

/**
 * The hash `url` must serve, or undefined when it is not pinned. Deliberately
 * not exported: the resolver asks through the closure below, so a caller cannot
 * bypass the config → record precedence.
 */
function lookupPin(url: string): string | undefined {
	const key = normalizeUrlKey(url);
	return configPinnedHashByUrl.get(key) ?? pinnedHashByUrl.get(key);
}

/**
 * Validates every `sha256` a `QuoombConfig` declares on its plugins and seeds
 * the config pin table from it. Called once per config load, before
 * `loadPluginsFromConfig` — a config that believes it is pinning but cannot be
 * enforced is worse than no pin, so this throws rather than loading unverified.
 *
 * Hard errors, naming the offending entry:
 * - `sha256` on a source that is not an `https:` URL (`npm:`, a bare package
 *   name, `file:`) — it never reaches the remote resolver, so the hash could
 *   never be checked.
 * - `sha256` that is not 64 hex characters.
 *
 * `config` must already be env-interpolated — a `${PLUGIN_SHA}` placeholder is
 * validated after substitution, not before.
 */
export function seedConfigPluginPins(config: QuoombConfig): void {
	const pins: Array<{ url: string; sha256: string }> = [];
	for (const plugin of config.plugins ?? []) {
		if (!plugin.sha256) continue;

		if (!isHttpsUrl(plugin.source)) {
			throw new Error(
				`Config plugin '${plugin.source}' declares sha256 but is not an https: source; ` +
				`its hash can never be checked. Remove sha256, or serve it over https:.`
			);
		}
		if (!SHA256_HEX.test(plugin.sha256)) {
			throw new Error(
				`Config plugin '${plugin.source}' declares sha256 '${plugin.sha256}', ` +
				`which is not 64 hex characters.`
			);
		}
		pins.push({ url: plugin.source, sha256: plugin.sha256.toLowerCase() });
	}
	setConfigPinnedHashes(pins);
}

/** True when `url` is an `https:` source — the only kind the remote resolver, and so a pin, can ever act on. */
function isHttpsUrl(url: string): boolean {
	try {
		return new URL(url).protocol === 'https:';
	} catch {
		return false;
	}
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
