/**
 * Tests for plugin URL handling:
 * - `validatePluginUrl`, the pre-flight check a UI runs before offering to install.
 * - The protocol allowlist inside `dynamicLoadModule`, which is the enforcement
 *   point every load path funnels through (a caller that skips the pre-flight
 *   check still cannot reach `import()` with an arbitrary scheme).
 *
 * The rejection cases below must all fail *before* any import is attempted, so
 * none of them touch the network.
 */

import { describe, it, expect, afterEach } from 'vitest';
import type { Database } from '@quereus/quereus';
import { validatePluginUrl, dynamicLoadModule } from '../src/index.js';
import {
	writeTempModule,
	cleanupTempModules,
	capturePluginSource,
	readCapturedConfig,
	clearCapturedConfig
} from './helpers/plugin-fixtures.js';

const CAPTURE_KEY = '__quereusPluginUrlSpecReceived';

// `registerPlugin` only touches `db` for registrations the plugin returns, and
// these fixtures return none — so a bare object stands in for a real Database.
const db = {} as unknown as Database;

describe('validatePluginUrl', () => {
	it('accepts https and file URLs ending in .js or .mjs', () => {
		expect(validatePluginUrl('https://example.com/plugin.js')).toBe(true);
		expect(validatePluginUrl('https://example.com/dist/plugin.mjs')).toBe(true);
		expect(validatePluginUrl('file:///home/user/plugin.js')).toBe(true);
		expect(validatePluginUrl('file:///C:/plugins/plugin.mjs')).toBe(true);
	});

	it('ignores query strings and ports when checking the extension', () => {
		expect(validatePluginUrl('https://example.com:8443/plugin.js?v=2')).toBe(true);
		expect(validatePluginUrl('https://example.com/plugin.mjs#frag')).toBe(true);
	});

	it('matches the extension case-insensitively', () => {
		expect(validatePluginUrl('https://example.com/Plugin.JS')).toBe(true);
		expect(validatePluginUrl('https://example.com/Plugin.MJS')).toBe(true);
	});

	it('rejects protocols outside the allowlist', () => {
		expect(validatePluginUrl('http://example.com/plugin.js')).toBe(false);
		expect(validatePluginUrl('ftp://example.com/plugin.js')).toBe(false);
		expect(validatePluginUrl('data:text/javascript,export default () => ({})')).toBe(false);
		expect(validatePluginUrl('blob:https://example.com/1234')).toBe(false);
		expect(validatePluginUrl('javascript:alert(1)')).toBe(false);
		// `npm:` parses as a URL with an opaque path, so it is the allowlist —
		// not the URL parser — that turns it away here.
		expect(validatePluginUrl('npm:@scope/quereus-plugin-foo')).toBe(false);
	});

	it('rejects paths that do not end in .js or .mjs', () => {
		expect(validatePluginUrl('https://example.com/plugin.ts')).toBe(false);
		expect(validatePluginUrl('https://example.com/plugin.json')).toBe(false);
		expect(validatePluginUrl('https://example.com/plugin')).toBe(false);
		expect(validatePluginUrl('https://example.com/')).toBe(false);
		// The extension must be in the path, not the query.
		expect(validatePluginUrl('https://example.com/load?file=plugin.js')).toBe(false);
	});

	it('rejects strings that are not absolute URLs at all', () => {
		expect(validatePluginUrl('')).toBe(false);
		expect(validatePluginUrl('not a url')).toBe(false);
		expect(validatePluginUrl('/absolute/path/plugin.js')).toBe(false);
		expect(validatePluginUrl('./relative/plugin.js')).toBe(false);
		expect(validatePluginUrl('example.com/plugin.js')).toBe(false);
	});
});

describe('dynamicLoadModule', () => {
	afterEach(async () => {
		clearCapturedConfig(CAPTURE_KEY);
		await cleanupTempModules();
	});

	describe('protocol allowlist', () => {
		it('refuses http:// without attempting a load', async () => {
			await expect(dynamicLoadModule('http://example.com/plugin.js', db))
				.rejects.toThrow(/Unsupported plugin URL protocol 'http:'/);
		});

		it('names the allowed protocols in the error', async () => {
			await expect(dynamicLoadModule('http://example.com/plugin.js', db))
				.rejects.toThrow(/Allowed: https:, file:/);
		});

		it('refuses a data: URL even though import() would otherwise accept one', async () => {
			const dataUrl = 'data:text/javascript,export default () => ({})';
			await expect(dynamicLoadModule(dataUrl, db))
				.rejects.toThrow(/Unsupported plugin URL protocol 'data:'/);
		});

		it('refuses other schemes (ftp, blob)', async () => {
			await expect(dynamicLoadModule('ftp://example.com/plugin.js', db))
				.rejects.toThrow(/Unsupported plugin URL protocol 'ftp:'/);
			await expect(dynamicLoadModule('blob:https://example.com/abc', db))
				.rejects.toThrow(/Unsupported plugin URL protocol 'blob:'/);
		});

		it('wraps a malformed URL in the load-failure message', async () => {
			await expect(dynamicLoadModule('not a url', db))
				.rejects.toThrow(/Failed to load plugin from not a url:/);
		});
	});

	describe('file:// loads', () => {
		it('imports the module and hands it the config', async () => {
			const { url } = await writeTempModule(capturePluginSource(CAPTURE_KEY));

			await dynamicLoadModule(url, db, { setting: 'on', count: 3 });

			const received = readCapturedConfig(CAPTURE_KEY);
			expect(received, 'plugin register() should have been invoked').toBeDefined();
			expect(received!.setting).toBe('on');
			expect(received!.count).toBe(3);
		});

		it('returns no manifest when no fetchable package.json sits beside the module', async () => {
			const { url } = await writeTempModule(capturePluginSource(CAPTURE_KEY));
			await expect(dynamicLoadModule(url, db)).resolves.toBeUndefined();
		});

		it('rejects a module with no default export', async () => {
			const { url } = await writeTempModule('export const notDefault = () => ({});\n');
			await expect(dynamicLoadModule(url, db))
				.rejects.toThrow(/has no default export function/);
		});

		it('rejects a module whose default export is not a function', async () => {
			const { url } = await writeTempModule('export default 42;\n');
			await expect(dynamicLoadModule(url, db))
				.rejects.toThrow(/has no default export function/);
		});

		it('surfaces an error thrown by the plugin itself, tagged with the source', async () => {
			const { url } = await writeTempModule(
				'export default function register() { throw new Error("plugin exploded"); }\n'
			);
			await expect(dynamicLoadModule(url, db)).rejects.toThrow(/plugin exploded/);
			await expect(dynamicLoadModule(url, db)).rejects.toThrow(/Failed to load plugin from file:/);
		});
	});
});
