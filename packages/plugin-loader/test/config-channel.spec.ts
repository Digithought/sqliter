/**
 * Tests for the plugin config channel (config-loader `toPluginSqlConfig` +
 * `loadPluginsFromConfig`).
 *
 * Regression guard for the bug where a structured config value (e.g. IndexedDB's
 * `cache`) was flattened to a JSON *string* on the way to the plugin, which then
 * cast it straight to an object — silently dropping the user's setting. The
 * channel must deliver config objects to the plugin as objects.
 */

import { describe, it, expect, afterEach } from 'vitest';
import type { Database } from '@quereus/quereus';
import { toPluginSqlConfig, loadPluginsFromConfig } from '../src/index.js';
import {
	writeTempModule,
	cleanupTempModules,
	capturePluginSource,
	readCapturedConfig,
	clearCapturedConfig
} from './helpers/plugin-fixtures.js';

const CAPTURE_KEY = '__quereusPluginConfigReceived';

describe('plugin config channel', () => {
	afterEach(async () => {
		clearCapturedConfig(CAPTURE_KEY);
		await cleanupTempModules();
	});

	describe('toPluginSqlConfig', () => {
		it('passes nested objects through unflattened (not JSON strings)', () => {
			const cache = { enabled: false, maxEntries: 42 };
			const sqlConfig = toPluginSqlConfig({ cache, databaseName: 'mydb', isolation: true });

			expect(sqlConfig.cache).toEqual(cache);
			expect(typeof sqlConfig.cache).toBe('object');
			// The scalars round-trip untouched.
			expect(sqlConfig.databaseName).toBe('mydb');
			expect(sqlConfig.isolation).toBe(true);
		});

		it('preserves arrays and normalizes undefined to null', () => {
			const sqlConfig = toPluginSqlConfig({ list: [1, 2, 3], missing: undefined });
			expect(sqlConfig.list).toEqual([1, 2, 3]);
			expect(sqlConfig.missing).toBeNull();
		});
	});

	describe('loadPluginsFromConfig round-trip', () => {
		it('delivers a structured cache config to the plugin as an object', async () => {
			const { url: source } = await writeTempModule(capturePluginSource(CAPTURE_KEY), 'capture-plugin.mjs');

			const cache = { enabled: false, maxEntries: 7, maxBytes: 4096 };

			// db is only forwarded to the plugin's register(); our capture plugin ignores it.
			await loadPluginsFromConfig({} as unknown as Database, {
				plugins: [{ source, config: { cache, databaseName: 'user-db' } }],
			});

			const received = readCapturedConfig(CAPTURE_KEY);
			expect(received, 'plugin register() should have been invoked').toBeDefined();
			expect(typeof received!.cache).toBe('object');
			expect(received!.cache).toEqual(cache);
			expect(received!.databaseName).toBe('user-db');
		});
	});
});
