/**
 * Tests the CLI's remote-plugin wiring
 * (packages/quoomb-cli/src/plugins/remote-resolver.ts): that installing the
 * resolver makes an `https:` plugin load work under Node at all, that the fetch
 * is announced, and that the recorded hash can be read back by the URL a plugin
 * record holds — which is whatever the user typed, not the normalized form the
 * loader hands the resolver.
 *
 * Importing from `@quereus/plugin-loader/node` also exercises that package's
 * `./node` subpath export, which the loader's own specs (they import `../src/`)
 * do not.
 *
 * No network: the global `fetch` is stubbed for both the module and the
 * package.json probe that follows a successful load.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { Database } from '@quereus/quereus';
import { dynamicLoadModule } from '@quereus/plugin-loader';
import { installRemotePluginResolver, getLastFetchedHash } from '../src/plugins/remote-resolver.js';

/** Normalized form of MODULE_URL_AS_TYPED — what `new URL(…).href` produces. */
const MODULE_URL = 'https://plugins.example.test/dist/plugin.mjs';
/** Same module, spelled the way a user might type it into `.plugin install`. */
const MODULE_URL_AS_TYPED = 'https://Plugins.Example.test:443/dist/plugin.mjs';

const PLUGIN_SOURCE = 'export default function register() { return {}; }\n';
const PLUGIN_SHA256 = createHash('sha256').update(Buffer.from(PLUGIN_SOURCE, 'utf8')).digest('hex');

describe('CLI remote plugin resolver', () => {
	let db: Database;
	let logSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		db = new Database();
		logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		vi.stubGlobal('fetch', (async (input: unknown) => (
			String(input) === MODULE_URL
				? new Response(PLUGIN_SOURCE, { status: 200, headers: { 'content-type': 'text/javascript' } })
				: new Response('not found', { status: 404 })
		)) as unknown as typeof fetch);
		installRemotePluginResolver();
	});

	afterEach(async () => {
		logSpy.mockRestore();
		vi.unstubAllGlobals();
		await db.close();
	});

	it('loads an https plugin module, which bare import() cannot do under Node', async () => {
		await expect(dynamicLoadModule(MODULE_URL, db, {})).resolves.toBeUndefined();
	});

	it('announces the fetch with size and hash', async () => {
		await dynamicLoadModule(MODULE_URL, db, {});

		const output = logSpy.mock.calls.flat().join('\n');
		expect(output).toContain(MODULE_URL);
		expect(output).toContain(PLUGIN_SHA256);
		expect(output).toMatch(/\d+ B/);
	});

	it('records the fetched hash', async () => {
		await dynamicLoadModule(MODULE_URL, db, {});

		expect(getLastFetchedHash(MODULE_URL)).toBe(PLUGIN_SHA256);
	});

	it('finds the hash by the URL as typed, not only its normalized form', async () => {
		await dynamicLoadModule(MODULE_URL_AS_TYPED, db, {});

		// A plugin record stores the typed string; the resolver only ever sees the
		// parsed URL. Keying on either raw form would lose change detection.
		expect(getLastFetchedHash(MODULE_URL_AS_TYPED)).toBe(PLUGIN_SHA256);
		expect(getLastFetchedHash(MODULE_URL)).toBe(PLUGIN_SHA256);
	});

	it('reports no hash for a URL that was never fetched', () => {
		expect(getLastFetchedHash('file:///plugins/local.mjs')).toBeUndefined();
	});
});
