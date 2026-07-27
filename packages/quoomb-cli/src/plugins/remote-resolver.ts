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
import { installNodeRemoteModuleResolver } from '@quereus/plugin-loader/node';
import type { RemoteModuleFetch } from '@quereus/plugin-loader';

/**
 * Most recent fetch per requested URL. Read back by the `.plugin` commands so an
 * installed plugin's recorded hash can be compared against what was actually
 * served this time.
 */
const lastFetchByUrl = new Map<string, RemoteModuleFetch>();

/**
 * Installs the Node remote-module resolver. Call once at startup, before any
 * plugin load — config autoload, saved-plugin autoload, and the interactive
 * `.plugin` commands all go through the same loader.
 */
export function installRemotePluginResolver(): void {
	installNodeRemoteModuleResolver({
		onFetched: (info: RemoteModuleFetch) => {
			lastFetchByUrl.set(info.url, info);
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
	return lastFetchByUrl.get(url)?.sha256;
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
