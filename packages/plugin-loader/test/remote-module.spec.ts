/**
 * Tests for `https:` plugin module loads under Node.
 *
 * Node's ESM loader cannot import an https URL, so the loader delegates to a
 * host-installed resolver (`@quereus/plugin-loader/node`) that fetches the
 * module to a temp file first.
 *
 * Nothing here touches the network. Two different fetches are in play and both
 * are stubbed: the resolver's own (injectable via `fetchImpl`) and the global
 * one `dynamicLoadModule` uses afterwards to look for the plugin's package.json.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { createHash } from 'node:crypto';
import type { Database } from '@quereus/quereus';
import { dynamicLoadModule, setRemoteModuleResolver } from '../src/index.js';
import { isNodeRuntime } from '../src/plugin-loader.js';
import { createNodeRemoteResolver, installNodeRemoteModuleResolver } from '../src/node-remote.js';
import type { RemoteModuleFetch } from '../src/index.js';
import { capturePluginSource, readCapturedConfig, clearCapturedConfig } from './helpers/plugin-fixtures.js';

const CAPTURE_KEY = '__quereusRemoteModuleSpecReceived';
const COUNT_KEY = '__quereusRemoteModuleSpecEvaluations';
const MODULE_URL = 'https://plugins.example.test/dist/plugin.mjs';

// `registerPlugin` only touches `db` for registrations the plugin returns, and
// these fixtures return none — so a bare object stands in for a real Database.
const db = {} as unknown as Database;

/** 200 response carrying `source` as a JavaScript module. */
function jsResponse(source: string): Response {
	return new Response(source, { status: 200, headers: { 'content-type': 'text/javascript' } });
}

/**
 * A fetch that answers every request by calling `respond`. The input is typed
 * `unknown` because the DOM's `RequestInfo` is not in scope here (lib: ES2022);
 * every caller passes a string or a URL, and `String()` handles both.
 */
function fetchAnswering(respond: (url: string) => Response): typeof fetch {
	return (async (input: unknown) => respond(String(input))) as unknown as typeof fetch;
}

/**
 * Serves `source` for the module URL and 404s everything else — notably the
 * `package.json` probe `dynamicLoadModule` makes through the *global* fetch
 * after a successful load. Installed globally so both fetches are covered.
 */
function stubGlobalFetch(source: string): void {
	vi.stubGlobal('fetch', fetchAnswering(url =>
		url === MODULE_URL ? jsResponse(source) : new Response('not found', { status: 404 })));
}

/**
 * Builds a Response reporting `finalUrl` as where the request landed.
 * `Response.url` is a read-only accessor, so a redirect has to be stood up by
 * overriding the property.
 */
function responseRedirectedTo(body: string, finalUrl: string): Response {
	const response = jsResponse(body);
	Object.defineProperty(response, 'url', { value: finalUrl, configurable: true });
	return response;
}

/** Source of a plugin that counts how many times its module body evaluated. */
const COUNTING_PLUGIN_SOURCE = `
globalThis[${JSON.stringify(COUNT_KEY)}] = (globalThis[${JSON.stringify(COUNT_KEY)}] ?? 0) + 1;
export default function register() { return {}; }
`;

function readEvaluationCount(): number {
	return ((globalThis as Record<string, unknown>)[COUNT_KEY] as number | undefined) ?? 0;
}

describe('https module loads under Node', () => {
	afterEach(() => {
		// The resolver is a module-level singleton; leaving one installed would
		// leak into every spec that follows.
		setRemoteModuleResolver(null);
		vi.unstubAllGlobals();
		clearCapturedConfig(CAPTURE_KEY);
		delete (globalThis as Record<string, unknown>)[COUNT_KEY];
	});

	describe('runtime detection', () => {
		it('reports Node here', () => {
			expect(isNodeRuntime()).toBe(true);
		});

		it('does not treat a DOM-less Web Worker as Node', () => {
			// quoomb-web loads plugins from a worker: no `document`, but
			// `import('https://…')` works natively. Detecting Node by the absence
			// of a DOM would send that path down the "install a resolver" error.
			vi.stubGlobal('document', undefined);
			expect(isNodeRuntime()).toBe(true);   // still Node — `process` decides

			vi.stubGlobal('process', { env: {} });   // a bundler's process shim
			expect(isNodeRuntime()).toBe(false);
		});
	});

	describe('without a resolver installed', () => {
		it('explains what to do instead of failing with ERR_UNSUPPORTED_ESM_URL_SCHEME', async () => {
			await expect(dynamicLoadModule(MODULE_URL, db))
				.rejects.toThrow(/not supported by Node's ESM loader/);
		});

		it('names the Node resolver entry point', async () => {
			await expect(dynamicLoadModule(MODULE_URL, db))
				.rejects.toThrow(/installNodeRemoteModuleResolver/);
		});
	});

	describe('with the Node resolver installed', () => {
		it('loads the fetched module and hands it the config', async () => {
			const source = capturePluginSource(CAPTURE_KEY);
			stubGlobalFetch(source);
			installNodeRemoteModuleResolver({ fetchImpl: fetchAnswering(() => jsResponse(source)) });

			await dynamicLoadModule(MODULE_URL, db, { setting: 'on', count: 3 });

			const received = readCapturedConfig(CAPTURE_KEY);
			expect(received, 'plugin register() should have been invoked').toBeDefined();
			expect(received!.setting).toBe('on');
			expect(received!.count).toBe(3);
		});

		it('re-evaluates the module on a second load of the same URL', async () => {
			stubGlobalFetch(COUNTING_PLUGIN_SOURCE);
			installNodeRemoteModuleResolver({ fetchImpl: fetchAnswering(() => jsResponse(COUNTING_PLUGIN_SOURCE)) });

			await dynamicLoadModule(MODULE_URL, db);
			await dynamicLoadModule(MODULE_URL, db);

			// A stable temp path would make the second import a registry hit.
			expect(readEvaluationCount()).toBe(2);
		});

		it('probes for the manifest beside the original URL, not the temp file', async () => {
			const source = capturePluginSource(CAPTURE_KEY);
			const requested: string[] = [];
			vi.stubGlobal('fetch', fetchAnswering(url => {
				requested.push(url);
				return new Response('not found', { status: 404 });
			}));
			installNodeRemoteModuleResolver({ fetchImpl: fetchAnswering(() => jsResponse(source)) });

			await dynamicLoadModule(MODULE_URL, db);

			expect(requested).toContain('https://plugins.example.test/dist/package.json');
		});

		it('reports the sha256 and size of the fetched bytes, and awaits onFetched', async () => {
			const source = capturePluginSource(CAPTURE_KEY);
			const expectedHash = createHash('sha256').update(Buffer.from(source, 'utf8')).digest('hex');
			stubGlobalFetch(source);

			const seen: RemoteModuleFetch[] = [];
			let settled = false;
			installNodeRemoteModuleResolver({
				fetchImpl: fetchAnswering(() => jsResponse(source)),
				onFetched: async info => {
					await Promise.resolve();
					seen.push(info);
					settled = true;
				}
			});

			await dynamicLoadModule(MODULE_URL, db);

			expect(settled, 'onFetched should have been awaited before the import').toBe(true);
			expect(seen).toHaveLength(1);
			expect(seen[0].url).toBe(MODULE_URL);
			expect(seen[0].sha256).toBe(expectedHash);
			expect(seen[0].bytes).toBe(Buffer.byteLength(source, 'utf8'));
		});
	});

	describe('resolver rejections', () => {
		it('names the status when the fetch is not ok', async () => {
			const resolver = createNodeRemoteResolver({
				fetchImpl: fetchAnswering(() => new Response('nope', { status: 404, statusText: 'Not Found' }))
			});

			await expect(resolver(new URL(MODULE_URL))).rejects.toThrow(/HTTP 404/);
		});

		it('refuses a redirect that lands on http:', async () => {
			const resolver = createNodeRemoteResolver({
				fetchImpl: fetchAnswering(() =>
					responseRedirectedTo('export default () => ({});', 'http://plugins.example.test/plugin.mjs'))
			});

			await expect(resolver(new URL(MODULE_URL))).rejects.toThrow(/not https:/);
		});

		it('accepts a redirect that stays on https:', async () => {
			const resolver = createNodeRemoteResolver({
				fetchImpl: fetchAnswering(() =>
					responseRedirectedTo('export default () => ({});', 'https://cdn.example.test/plugin.mjs'))
			});

			await expect(resolver(new URL(MODULE_URL))).resolves.toMatch(/^file:/);
		});

		it('rejects a body over maxBytes', async () => {
			const resolver = createNodeRemoteResolver({
				maxBytes: 32,
				fetchImpl: fetchAnswering(() => new Response('x'.repeat(4096), { status: 200 }))
			});

			await expect(resolver(new URL(MODULE_URL))).rejects.toThrow(/over the 32-byte limit/);
		});

		it('rejects on a content-length over maxBytes even when the body is small', async () => {
			const resolver = createNodeRemoteResolver({
				maxBytes: 32,
				fetchImpl: fetchAnswering(() =>
					new Response('tiny', { status: 200, headers: { 'content-length': '999999' } }))
			});

			await expect(resolver(new URL(MODULE_URL))).rejects.toThrow(/declares 999999 bytes/);
		});

		it('surfaces the failure through dynamicLoadModule, tagged with the source URL', async () => {
			installNodeRemoteModuleResolver({
				fetchImpl: fetchAnswering(() => new Response('nope', { status: 500, statusText: 'Server Error' }))
			});

			await expect(dynamicLoadModule(MODULE_URL, db))
				.rejects.toThrow(new RegExp(`Failed to load plugin from ${MODULE_URL.replace(/[.]/g, '\\.')}`));
		});
	});
});
