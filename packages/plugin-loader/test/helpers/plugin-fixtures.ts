/**
 * Shared fixtures for the plugin-loader specs: temp ESM modules on disk (the
 * loader's `file://` path needs a real file to import) and a "capture" plugin
 * that records the config it was handed.
 */

import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const createdDirs: string[] = [];

export interface TempModule {
	/** Absolute path of the written module. */
	path: string;
	/** `file://` URL of the written module — what the loader is given. */
	url: string;
}

/**
 * Writes `source` into a fresh temp directory as an ES module and returns its
 * path and `file://` URL. Always use the `.mjs` extension so Node treats the
 * file as ESM regardless of any enclosing package.json.
 */
export async function writeTempModule(source: string, filename = 'plugin.mjs'): Promise<TempModule> {
	const dir = await mkdtemp(join(tmpdir(), 'ql-plugin-loader-'));
	createdDirs.push(dir);
	const path = join(dir, filename);
	await writeFile(path, source, 'utf8');
	return { path, url: pathToFileURL(path).href };
}

/** Removes every directory made by {@link writeTempModule}. Call from `afterEach`. */
export async function cleanupTempModules(): Promise<void> {
	await Promise.all(createdDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
}

/**
 * Source of a minimal plugin whose default export stashes the config it was
 * given on `globalThis[key]`, letting a test observe what crossed the channel.
 * Each spec file picks its own key so concurrently-running files can't collide.
 */
export function capturePluginSource(key: string): string {
	return `
export default function register(_db, config) {
	globalThis[${JSON.stringify(key)}] = config;
	return {};
}
`;
}

/** Reads back what {@link capturePluginSource}'s plugin recorded, if it ran. */
export function readCapturedConfig(key: string): Record<string, unknown> | undefined {
	return (globalThis as Record<string, unknown>)[key] as Record<string, unknown> | undefined;
}

/** Clears a capture key between tests. */
export function clearCapturedConfig(key: string): void {
	delete (globalThis as Record<string, unknown>)[key];
}
