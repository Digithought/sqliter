/**
 * Configuration loader for Quoomb
 * Handles loading, parsing, and interpolating quoomb.config.json files
 */

import type { Database, SqlValue } from '@quereus/quereus';
import { loadPlugin } from './plugin-loader.js';
import debug from 'debug';

const log = debug('quereus:config-loader');

/**
 * Plugin configuration from config file
 */
export interface PluginConfig {
	source: string;
	config?: Record<string, unknown>;
	/**
	 * SHA-256 (hex) the module at `source` must hash to. Enforced before the
	 * module is imported; a mismatch refuses the load. Only applies to `https:`
	 * sources fetched by the Node remote resolver.
	 */
	sha256?: string;
}

/**
 * Quoomb configuration file format
 */
export interface QuoombConfig {
	$schema?: string;
	plugins?: PluginConfig[];
	autoload?: boolean;
}

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

/**
 * Interpolate environment variables in a value.
 * Supports ${VAR_NAME} and ${VAR_NAME:-default} syntax.
 */
export function interpolateEnvVars(value: JsonValue, env: Record<string, string> = {}): JsonValue {
	if (typeof value === 'string') {
		return value.replace(/\$\{([^}]+)\}/g, (match, varSpec: string) => {
			const { name, defaultValue } = parsePlaceholder(varSpec);
			// Own properties only: without this, `${constructor}` or `${toString}`
			// would resolve to an inherited Object.prototype member.
			if (Object.hasOwn(env, name)) return env[name];
			return defaultValue ?? match;
		});
	}
	if (typeof value === 'object' && value !== null) {
		if (Array.isArray(value)) {
			return value.map(v => interpolateEnvVars(v, env));
		}
		const result: Record<string, JsonValue> = {};
		for (const [key, val] of Object.entries(value)) {
			result[key] = interpolateEnvVars(val, env);
		}
		return result;
	}
	return value;
}

/**
 * Splits a `${...}` body into its variable name and optional default. Only the
 * *first* `:-` separates, so a default may itself contain `:-` (e.g. a URL).
 */
function parsePlaceholder(varSpec: string): { name: string; defaultValue?: string } {
	const separator = varSpec.indexOf(':-');
	if (separator === -1) return { name: varSpec.trim() };
	return { name: varSpec.slice(0, separator).trim(), defaultValue: varSpec.slice(separator + 2) };
}

/**
 * Interpolate environment variables in a config object
 */
export function interpolateConfigEnvVars(config: QuoombConfig, env?: Record<string, string>): QuoombConfig {
	const envVars = env ?? buildProcessEnv();
	return interpolateEnvVars(config as unknown as JsonValue, envVars) as unknown as QuoombConfig;
}

function buildProcessEnv(): Record<string, string> {
	if (typeof process === 'undefined' || !process.env) return {};
	return Object.fromEntries(
		Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)
	);
}

/**
 * Convert a plugin's config object (as read from a config file or settings —
 * already JSON-compatible) into the `SqlValue`-typed config the plugin channel
 * carries.
 *
 * Nested objects/arrays are valid {@link SqlValue}s (the `JsonSqlValue` arm) and
 * are passed through **unchanged**, NOT flattened to JSON strings. Plugins
 * receive the structured config they declare (e.g. IndexedDB's
 * `cache: CacheOptions`). Flattening here would silently deliver a *string* to a
 * plugin that casts the value straight to an object, dropping the setting.
 *
 * This is the single encode step for the plugin config channel; the decode side
 * is the plugin reading `config.<key>` directly, so the round-trip is symmetric.
 */
export function toPluginSqlConfig(config: Record<string, unknown> | undefined): Record<string, SqlValue> {
	const sqlConfig: Record<string, SqlValue> = {};
	for (const [key, value] of Object.entries(config ?? {})) {
		// JSON values (primitives, arrays, plain objects) are all valid SqlValues.
		sqlConfig[key] = value === undefined ? null : (value as SqlValue);
	}
	return sqlConfig;
}

/**
 * Load plugins from a config object.
 * Collects all load failures and throws an aggregate error when any plugins fail.
 *
 * NOTE: this is the shared direct-import config-load loop; the CLI (bin + repl)
 * calls it directly. The web app cannot reuse it because it must load plugins
 * through the Comlink worker (`api.loadModule`) rather than importing in-process,
 * so it re-implements the loop over that boundary — but shares the config→SqlValue
 * encoding via `toPluginSqlConfig` (the part that was actually duplicated and buggy).
 * Unifying the loop bodies too would force a worker-boundary dependency edge.
 */
export async function loadPluginsFromConfig(
	db: Database,
	config: QuoombConfig,
	options?: { allowCdn?: boolean; env?: 'auto' | 'browser' | 'node' }
): Promise<void> {
	if (!config.plugins || config.plugins.length === 0) {
		return;
	}

	const failures: Array<{ source: string; error: Error }> = [];

	for (const pluginConfig of config.plugins) {
		try {
			await loadPlugin(pluginConfig.source, db, toPluginSqlConfig(pluginConfig.config), options);
		} catch (error) {
			const err = error instanceof Error ? error : new Error(String(error));
			log('Failed to load plugin from %s: %s', pluginConfig.source, err.message);
			failures.push({ source: pluginConfig.source, error: err });
		}
	}

	if (failures.length > 0) {
		const details = failures.map(f => `  - ${f.source}: ${f.error.message}`).join('\n');
		throw new Error(
			`Failed to load ${failures.length} plugin(s):\n${details}`
		);
	}
}

/**
 * Validate a config object structure
 */
export function validateConfig(config: unknown): config is QuoombConfig {
	if (typeof config !== 'object' || config === null) return false;

	const obj = config as Record<string, unknown>;

	if (obj.plugins !== undefined) {
		if (!Array.isArray(obj.plugins)) return false;
		for (const plugin of obj.plugins) {
			if (!isValidPluginEntry(plugin)) return false;
		}
	}

	if (obj.autoload !== undefined && typeof obj.autoload !== 'boolean') return false;

	return true;
}

function isValidPluginEntry(plugin: unknown): boolean {
	if (typeof plugin !== 'object' || plugin === null) return false;
	const p = plugin as Record<string, unknown>;
	if (typeof p.source !== 'string') return false;
	if (p.config !== undefined && p.config !== null && (typeof p.config !== 'object' || Array.isArray(p.config))) return false;
	if (p.sha256 !== undefined && typeof p.sha256 !== 'string') return false;
	return true;
}
