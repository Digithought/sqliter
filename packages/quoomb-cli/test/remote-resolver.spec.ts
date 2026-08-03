/**
 * Tests the CLI's remote-plugin wiring
 * (packages/quoomb-cli/src/plugins/remote-resolver.ts): that installing the
 * resolver makes an `https:` plugin load work under Node at all, that the fetch
 * is announced, and that the recorded hash can be read back by the URL a plugin
 * record holds — which is whatever the user typed, not the normalized form the
 * loader hands the resolver.
 *
 * The `pinning` block covers the other direction: hashes pushed *in* via
 * `setRecordPinnedHashes` gate the fetch, under the same typed-vs-normalized URL
 * rule, and a pin that is dropped from the table stops applying immediately.
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
import { dynamicLoadModule, PluginHashMismatchError } from '@quereus/plugin-loader';
import {
	installRemotePluginResolver,
	getLastFetchedHash,
	setRecordPinnedHashes,
} from '../src/plugins/remote-resolver.js';

/** Normalized form of MODULE_URL_AS_TYPED — what `new URL(…).href` produces. */
const MODULE_URL = 'https://plugins.example.test/dist/plugin.mjs';
/** Same module, spelled the way a user might type it into `.plugin install`. */
const MODULE_URL_AS_TYPED = 'https://Plugins.Example.test:443/dist/plugin.mjs';

const PLUGIN_SOURCE = 'export default function register() { return {}; }\n';
const PLUGIN_SHA256 = createHash('sha256').update(Buffer.from(PLUGIN_SOURCE, 'utf8')).digest('hex');
/** A digest the served bytes do not have — stands in for "the module changed". */
const OTHER_SHA256 = createHash('sha256').update('a different plugin').digest('hex');

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
		// The pin table is process-wide, like the resolver itself.
		setRecordPinnedHashes([]);
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

	describe('pinning', () => {
		/** The mismatch `dynamicLoadModule` wrapped, or undefined if it loaded. */
		const loadAndCatchMismatch = async (url: string): Promise<PluginHashMismatchError | undefined> => {
			try {
				await dynamicLoadModule(url, db, {});
				return undefined;
			} catch (error) {
				const cause = error instanceof Error ? error.cause : undefined;
				expect(cause).toBeInstanceOf(PluginHashMismatchError);
				return cause as PluginHashMismatchError;
			}
		};

		it('loads a pinned module whose bytes still match', async () => {
			setRecordPinnedHashes([{ url: MODULE_URL, sha256: PLUGIN_SHA256 }]);

			await expect(dynamicLoadModule(MODULE_URL, db, {})).resolves.toBeUndefined();
		});

		it('refuses a pinned module whose bytes changed, announcing nothing', async () => {
			setRecordPinnedHashes([{ url: MODULE_URL, sha256: OTHER_SHA256 }]);

			const mismatch = await loadAndCatchMismatch(MODULE_URL);
			expect(mismatch?.expected).toBe(OTHER_SHA256);
			expect(mismatch?.actual).toBe(PLUGIN_SHA256);
			// onFetched never fires for refused bytes, so nothing is reported either.
			expect(logSpy.mock.calls.flat().join('\n')).not.toContain('Fetched plugin');
		});

		it('applies a pin recorded under the URL as typed to the normalized fetch', async () => {
			// A record holds whatever the user typed; the resolver is asked with the
			// parsed href. Keying either raw would leave the pin silently inert.
			setRecordPinnedHashes([{ url: MODULE_URL_AS_TYPED, sha256: OTHER_SHA256 }]);

			expect(await loadAndCatchMismatch(MODULE_URL)).toBeDefined();
		});

		it('pins a fetch of the URL as typed from a record holding its normalized form', async () => {
			setRecordPinnedHashes([{ url: MODULE_URL, sha256: OTHER_SHA256 }]);

			expect(await loadAndCatchMismatch(MODULE_URL_AS_TYPED)).toBeDefined();
		});

		it('keeps the first entry when one URL is pinned twice', async () => {
			// Two pinned records for one URL cannot both be satisfied; the outcome is
			// at least deterministic — record order in plugins.json.
			setRecordPinnedHashes([
				{ url: MODULE_URL, sha256: PLUGIN_SHA256 },
				{ url: MODULE_URL_AS_TYPED, sha256: OTHER_SHA256 },
			]);

			await expect(dynamicLoadModule(MODULE_URL, db, {})).resolves.toBeUndefined();
		});

		it('drops a pin that is no longer supplied', async () => {
			setRecordPinnedHashes([{ url: MODULE_URL, sha256: OTHER_SHA256 }]);
			expect(await loadAndCatchMismatch(MODULE_URL)).toBeDefined();

			// What `.plugin unpin` (and `.plugin remove`) rely on: the table is
			// replaced wholesale, so the pin is gone in the same session.
			setRecordPinnedHashes([]);
			await expect(dynamicLoadModule(MODULE_URL, db, {})).resolves.toBeUndefined();
		});

		it('fails closed on a pin that is not 64 hex characters', async () => {
			setRecordPinnedHashes([{ url: MODULE_URL, sha256: 'not-a-hash' }]);

			await expect(dynamicLoadModule(MODULE_URL, db, {})).rejects.toThrow(/not 64 hex characters/);
		});
	});
});
