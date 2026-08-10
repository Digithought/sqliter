/**
 * Tests for the config-file side of the loader: `${VAR}` interpolation, config
 * structure validation, and how `loadPluginsFromConfig` reports failures.
 *
 * `toPluginSqlConfig` and the config→plugin round-trip live in
 * `config-channel.spec.ts`; this file deliberately does not repeat them.
 */

import { describe, it, expect, afterEach } from 'vitest';
import type { Database } from '@quereus/quereus';
import {
	interpolateEnvVars,
	interpolateConfigEnvVars,
	validateConfig,
	loadPluginsFromConfig
} from '../src/index.js';
import {
	writeTempModule,
	cleanupTempModules,
	capturePluginSource,
	readCapturedConfig,
	clearCapturedConfig
} from './helpers/plugin-fixtures.js';

const CAPTURE_KEY = '__quereusConfigLoaderSpecReceived';

const db = {} as unknown as Database;

describe('interpolateEnvVars', () => {
	it('substitutes a ${VAR} placeholder', () => {
		expect(interpolateEnvVars('${HOST}', { HOST: 'db.local' })).toBe('db.local');
	});

	it('substitutes placeholders embedded in surrounding text', () => {
		expect(interpolateEnvVars('https://${HOST}:${PORT}/db', { HOST: 'db.local', PORT: '5432' }))
			.toBe('https://db.local:5432/db');
	});

	it('falls back to the ${VAR:-default} default when the var is absent', () => {
		expect(interpolateEnvVars('${MISSING:-fallback}', {})).toBe('fallback');
		expect(interpolateEnvVars('${MISSING:-}', {})).toBe('');
	});

	it('prefers a set var over its default, including when the value is empty', () => {
		expect(interpolateEnvVars('${HOST:-fallback}', { HOST: 'real' })).toBe('real');
		// An explicitly empty env var is a value, not an absence — it wins.
		expect(interpolateEnvVars('${HOST:-fallback}', { HOST: '' })).toBe('');
	});

	it('keeps a default that itself contains ":-"', () => {
		// Only the first `:-` separates name from default.
		expect(interpolateEnvVars('${MISSING:-a:-b}', {})).toBe('a:-b');
		expect(interpolateEnvVars('${MISSING:-https://host/p.js}', {})).toBe('https://host/p.js');
	});

	it('does not resolve inherited Object.prototype members as variables', () => {
		expect(interpolateEnvVars('${constructor}', {})).toBe('${constructor}');
		expect(interpolateEnvVars('${toString}', {})).toBe('${toString}');
		expect(interpolateEnvVars('${__proto__}', {})).toBe('${__proto__}');
		expect(interpolateEnvVars('${hasOwnProperty:-fallback}', {})).toBe('fallback');
	});

	it('leaves the placeholder text in place when there is no var and no default', () => {
		expect(interpolateEnvVars('${MISSING}', {})).toBe('${MISSING}');
		expect(interpolateEnvVars('prefix-${MISSING}-suffix', {})).toBe('prefix-${MISSING}-suffix');
	});

	it('defaults to an empty environment when none is given', () => {
		expect(interpolateEnvVars('${MISSING}')).toBe('${MISSING}');
		expect(interpolateEnvVars('${MISSING:-d}')).toBe('d');
	});

	it('trims whitespace around the variable name', () => {
		expect(interpolateEnvVars('${ HOST }', { HOST: 'db.local' })).toBe('db.local');
	});

	it('leaves strings with no placeholder untouched', () => {
		expect(interpolateEnvVars('plain string', { HOST: 'db.local' })).toBe('plain string');
		expect(interpolateEnvVars('', {})).toBe('');
	});

	it('passes non-string primitives through unchanged', () => {
		expect(interpolateEnvVars(42, { A: 'x' })).toBe(42);
		expect(interpolateEnvVars(true, { A: 'x' })).toBe(true);
		expect(interpolateEnvVars(null, { A: 'x' })).toBeNull();
	});

	it('recurses into arrays', () => {
		expect(interpolateEnvVars(['${A}', 2, false, null], { A: 'one' }))
			.toEqual(['one', 2, false, null]);
	});

	it('recurses into nested objects and arrays', () => {
		const result = interpolateEnvVars(
			{ outer: { list: ['${A}', { deep: '${B:-fallback}' }], keep: 7 } },
			{ A: 'alpha' }
		);
		expect(result).toEqual({ outer: { list: ['alpha', { deep: 'fallback' }], keep: 7 } });
	});

	it('does not mutate the input object', () => {
		const input = { source: '${A}' };
		const result = interpolateEnvVars(input, { A: 'expanded' });
		expect(input.source).toBe('${A}');
		expect(result).toEqual({ source: 'expanded' });
	});
});

describe('interpolateConfigEnvVars', () => {
	afterEach(() => {
		delete process.env.QUEREUS_PLUGIN_LOADER_TEST_VAR;
	});

	it('interpolates plugin sources and configs from the supplied environment', () => {
		const result = interpolateConfigEnvVars(
			{
				autoload: true,
				plugins: [{ source: 'file://${PLUGIN_DIR}/plugin.mjs', config: { key: '${API_KEY:-none}' } }]
			},
			{ PLUGIN_DIR: '/opt/plugins' }
		);

		expect(result.plugins?.[0].source).toBe('file:///opt/plugins/plugin.mjs');
		expect(result.plugins?.[0].config).toEqual({ key: 'none' });
		expect(result.autoload).toBe(true);
	});

	it('reads process.env when no environment is supplied', () => {
		process.env.QUEREUS_PLUGIN_LOADER_TEST_VAR = 'from-process-env';
		const result = interpolateConfigEnvVars({
			plugins: [{ source: '${QUEREUS_PLUGIN_LOADER_TEST_VAR}' }]
		});
		expect(result.plugins?.[0].source).toBe('from-process-env');
	});

	it('interpolates a ${VAR} placeholder inside sha256', () => {
		const result = interpolateConfigEnvVars(
			{ plugins: [{ source: 'https://example.test/p.mjs', sha256: '${PLUGIN_SHA}' }] },
			{ PLUGIN_SHA: 'a'.repeat(64) }
		);
		expect(result.plugins?.[0].sha256).toBe('a'.repeat(64));
	});
});

describe('validateConfig', () => {
	it('accepts an empty or minimal config', () => {
		expect(validateConfig({})).toBe(true);
		expect(validateConfig({ plugins: [] })).toBe(true);
		expect(validateConfig({ $schema: './schema.json' })).toBe(true);
	});

	it('accepts well-formed plugin entries', () => {
		expect(validateConfig({ plugins: [{ source: 'npm:@scope/foo' }] })).toBe(true);
		expect(validateConfig({ plugins: [{ source: 'x', config: {} }] })).toBe(true);
		expect(validateConfig({ plugins: [{ source: 'x', config: { nested: { a: 1 } } }] })).toBe(true);
		// An explicit null config is treated as "no config", not as malformed.
		expect(validateConfig({ plugins: [{ source: 'x', config: null }] })).toBe(true);
	});

	it('accepts a boolean autoload and rejects any other type', () => {
		expect(validateConfig({ autoload: true })).toBe(true);
		expect(validateConfig({ autoload: false })).toBe(true);
		expect(validateConfig({ autoload: 'yes' })).toBe(false);
		expect(validateConfig({ autoload: 1 })).toBe(false);
		expect(validateConfig({ autoload: null })).toBe(false);
	});

	it('rejects anything that is not an object', () => {
		expect(validateConfig(null)).toBe(false);
		expect(validateConfig(undefined)).toBe(false);
		expect(validateConfig('config')).toBe(false);
		expect(validateConfig(42)).toBe(false);
	});

	it('rejects a plugins value that is not an array', () => {
		expect(validateConfig({ plugins: 'npm:@scope/foo' })).toBe(false);
		expect(validateConfig({ plugins: { source: 'x' } })).toBe(false);
	});

	it('rejects a plugin entry without a string source', () => {
		expect(validateConfig({ plugins: [{}] })).toBe(false);
		expect(validateConfig({ plugins: [{ source: 42 }] })).toBe(false);
		expect(validateConfig({ plugins: [null] })).toBe(false);
		expect(validateConfig({ plugins: ['npm:@scope/foo'] })).toBe(false);
	});

	it('rejects a plugin config that is not a plain object', () => {
		expect(validateConfig({ plugins: [{ source: 'x', config: 'not-an-object' }] })).toBe(false);
		expect(validateConfig({ plugins: [{ source: 'x', config: [1, 2] }] })).toBe(false);
		expect(validateConfig({ plugins: [{ source: 'x', config: 7 }] })).toBe(false);
	});

	it('rejects when only one entry of several is malformed', () => {
		expect(validateConfig({ plugins: [{ source: 'ok' }, { source: 42 }] })).toBe(false);
	});

	it('accepts a string sha256 and rejects any other type', () => {
		expect(validateConfig({ plugins: [{ source: 'x', sha256: 'a'.repeat(64) }] })).toBe(true);
		// Shape validation only checks the type here — 64-hex and https-only are
		// enforced by the host at seed time, not by validateConfig.
		expect(validateConfig({ plugins: [{ source: 'x', sha256: 'not-64-hex' }] })).toBe(true);
		expect(validateConfig({ plugins: [{ source: 'x', sha256: 12345 }] })).toBe(false);
		expect(validateConfig({ plugins: [{ source: 'x', sha256: {} }] })).toBe(false);
		expect(validateConfig({ plugins: [{ source: 'x', sha256: null }] })).toBe(false);
	});
});

describe('loadPluginsFromConfig failure handling', () => {
	afterEach(async () => {
		clearCapturedConfig(CAPTURE_KEY);
		await cleanupTempModules();
	});

	it('does nothing when there are no plugins', async () => {
		await expect(loadPluginsFromConfig(db, {})).resolves.toBeUndefined();
		await expect(loadPluginsFromConfig(db, { plugins: [] })).resolves.toBeUndefined();
	});

	it('loads every good plugin even when another entry fails', async () => {
		const { url } = await writeTempModule(capturePluginSource(CAPTURE_KEY));

		await expect(loadPluginsFromConfig(db, {
			plugins: [
				{ source: 'bad spec with spaces' },
				{ source: url, config: { loaded: true } }
			]
		})).rejects.toThrow(/Failed to load 1 plugin\(s\)/);

		expect(readCapturedConfig(CAPTURE_KEY)?.loaded).toBe(true);
	});

	it('forwards loader options to each plugin load', async () => {
		// The browser+npm refusal only fires if `env` reached `loadPlugin`.
		await expect(loadPluginsFromConfig(db, { plugins: [{ source: 'npm:@scope/foo' }] }, { env: 'browser' }))
			.rejects.toThrow(/requires allowCdn=true/);
	});

	it('aggregates every failure, naming each source and its reason', async () => {
		let error: unknown;
		try {
			await loadPluginsFromConfig(db, {
				plugins: [{ source: 'bad spec one' }, { source: 'bad spec two' }]
			});
		} catch (e) {
			error = e;
		}

		expect(error).toBeInstanceOf(Error);
		const message = (error as Error).message;
		expect(message).toMatch(/Failed to load 2 plugin\(s\)/);
		expect(message).toMatch(/- bad spec one: Invalid plugin spec: bad spec one/);
		expect(message).toMatch(/- bad spec two: Invalid plugin spec: bad spec two/);
	});
});
