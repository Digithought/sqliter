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
import { readdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Database } from '@quereus/quereus';
import { dynamicLoadModule, setRemoteModuleResolver, PluginHashMismatchError } from '../src/index.js';
import { isNodeRuntime, resolveImportSpecifier } from '../src/plugin-loader.js';
import { createNodeRemoteResolver, hashRemoteModule, installNodeRemoteModuleResolver } from '../src/node-remote.js';
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

/**
 * A response whose body is a stream that is never closed, so cancelling it
 * really does reach the underlying source. A closed stream's `cancel()` returns
 * without calling it, which would make the cleanup assertion vacuous.
 */
function unclosedStreamResponse(body: string, init: ResponseInit, onCancel: () => void): Response {
	const stream = new ReadableStream<Uint8Array>({
		start: controller => { controller.enqueue(new TextEncoder().encode(body)); },
		cancel: onCancel
	});
	return new Response(stream, init);
}

/** Source of a plugin that counts how many times its module body evaluated. */
const COUNTING_PLUGIN_SOURCE = `
globalThis[${JSON.stringify(COUNT_KEY)}] = (globalThis[${JSON.stringify(COUNT_KEY)}] ?? 0) + 1;
export default function register() { return {}; }
`;

function readEvaluationCount(): number {
	return ((globalThis as Record<string, unknown>)[COUNT_KEY] as number | undefined) ?? 0;
}

/** The digest a host would have to pin for `source` to be accepted. */
function sha256Of(source: string): string {
	return createHash('sha256').update(Buffer.from(source, 'utf8')).digest('hex');
}

/** SHA-256 of zero bytes — what an empty response body hashes to. */
const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

/** A well-formed digest that matches nothing these fixtures serve. */
const WRONG_SHA256 = 'f'.repeat(64);

/**
 * Directory the resolver writes fetched modules into, discovered by doing one
 * successful fetch — the resolver's temp directory is a module-private singleton
 * with no accessor.
 *
 * NOTE: the "wrote no temp file" assertions compare entry counts in whatever
 * directory this returns. If the resolver ever writes somewhere other than the
 * directory of the path it returns, those assertions would compare an unrelated
 * directory and pass vacuously; expose the directory and assert on it directly
 * if that happens.
 */
async function moduleTempDir(): Promise<string> {
	const resolver = createNodeRemoteResolver({
		fetchImpl: fetchAnswering(() => jsResponse('export default () => ({});'))
	});
	return dirname(fileURLToPath(await resolver(new URL(MODULE_URL))));
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

	// The specifier a load will be handed, without performing the load — the only
	// way to observe the browser/worker branch from a Node test runner.
	describe('specifier routing', () => {
		it('imports an https URL directly in a browser or worker', async () => {
			vi.stubGlobal('process', { env: {} });   // not Node: no versions.node

			expect(await resolveImportSpecifier(new URL(MODULE_URL))).toBe(MODULE_URL);
		});

		it('cache-busts a localhost dev server in a browser or worker', async () => {
			vi.stubGlobal('process', { env: {} });

			const specifier = await resolveImportSpecifier(new URL('https://localhost:5173/plugin.mjs'));
			expect(specifier).toMatch(/^https:\/\/localhost:5173\/plugin\.mjs\?t=\d+$/);
		});

		it('cache-busts a file URL without consulting a resolver', async () => {
			setRemoteModuleResolver(() => {
				throw new Error('a file: URL must not reach the remote resolver');
			});

			expect(await resolveImportSpecifier(new URL('file:///plugins/plugin.mjs')))
				.toMatch(/^file:\/\/\/plugins\/plugin\.mjs\?t=\d+$/);
		});

		it('prefers an installed resolver over the native import, even outside Node', async () => {
			vi.stubGlobal('process', { env: {} });
			setRemoteModuleResolver(async () => 'file:///tmp/from-resolver.mjs');

			expect(await resolveImportSpecifier(new URL(MODULE_URL))).toBe('file:///tmp/from-resolver.mjs');
		});

		it('leaves the caller\'s URL untouched, so the manifest still resolves beside it', async () => {
			const moduleUrl = new URL('file:///plugins/dist/plugin.mjs');

			await resolveImportSpecifier(moduleUrl);

			expect(moduleUrl.href).toBe('file:///plugins/dist/plugin.mjs');
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

		it('rejects a final URL it cannot parse', async () => {
			const resolver = createNodeRemoteResolver({
				fetchImpl: fetchAnswering(() => responseRedirectedTo('export default () => ({});', 'not a url'))
			});

			await expect(resolver(new URL(MODULE_URL))).rejects.toThrow(/unparseable URL 'not a url'/);
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

		it('cancels the body of a response it refuses to read', async () => {
			let cancelled = false;
			const resolver = createNodeRemoteResolver({
				fetchImpl: fetchAnswering(() =>
					unclosedStreamResponse('nope', { status: 404 }, () => { cancelled = true; }))
			});

			await expect(resolver(new URL(MODULE_URL))).rejects.toThrow(/HTTP 404/);

			// Left unread, the body would hold its socket until the response is
			// garbage collected.
			expect(cancelled).toBe(true);
		});

		it('keeps the original error reachable as `cause`', async () => {
			installNodeRemoteModuleResolver({
				fetchImpl: fetchAnswering(() => new Response('nope', { status: 500 }))
			});

			const error = await dynamicLoadModule(MODULE_URL, db).catch((e: unknown) => e);

			expect((error as Error).cause).toBeInstanceOf(Error);
			expect(((error as Error).cause as Error).message).toMatch(/HTTP 500/);
		});
	});

	describe('expectedHash pinning', () => {
		it('loads and runs the plugin when the pin matches', async () => {
			const source = capturePluginSource(CAPTURE_KEY);
			stubGlobalFetch(source);
			installNodeRemoteModuleResolver({
				fetchImpl: fetchAnswering(() => jsResponse(source)),
				expectedHash: () => sha256Of(source)
			});

			await dynamicLoadModule(MODULE_URL, db, { setting: 'on' });

			expect(readCapturedConfig(CAPTURE_KEY)?.setting).toBe('on');
		});

		it('accepts a pin the host stored uppercase and padded', async () => {
			const source = capturePluginSource(CAPTURE_KEY);
			const resolver = createNodeRemoteResolver({
				fetchImpl: fetchAnswering(() => jsResponse(source)),
				expectedHash: () => `  ${sha256Of(source).toUpperCase()}\n`
			});

			await expect(resolver(new URL(MODULE_URL))).resolves.toMatch(/^file:/);
		});

		it('resolves the pin asynchronously, per call', async () => {
			const source = capturePluginSource(CAPTURE_KEY);
			const asked: string[] = [];
			const resolver = createNodeRemoteResolver({
				fetchImpl: fetchAnswering(() => jsResponse(source)),
				expectedHash: async url => {
					asked.push(url);
					return sha256Of(source);
				}
			});

			await resolver(new URL(MODULE_URL));
			await resolver(new URL(MODULE_URL));

			expect(asked).toEqual([MODULE_URL, MODULE_URL]);
		});

		it('is asked with the normalized URL', async () => {
			const source = capturePluginSource(CAPTURE_KEY);
			const asked: string[] = [];
			const resolver = createNodeRemoteResolver({
				fetchImpl: fetchAnswering(() => jsResponse(source)),
				expectedHash: url => {
					asked.push(url);
					return sha256Of(source);
				}
			});

			await resolver(new URL('https://Plugins.Example.Test/dist/plugin.mjs'));

			expect(asked).toEqual(['https://plugins.example.test/dist/plugin.mjs']);
		});

		it('names the URL and both hashes when the pin does not match', async () => {
			const source = capturePluginSource(CAPTURE_KEY);
			const resolver = createNodeRemoteResolver({
				fetchImpl: fetchAnswering(() => jsResponse(source)),
				expectedHash: () => WRONG_SHA256
			});

			const error = await resolver(new URL(MODULE_URL)).catch((e: unknown) => e);

			expect(error).toBeInstanceOf(PluginHashMismatchError);
			const mismatch = error as PluginHashMismatchError;
			expect(mismatch.url).toBe(MODULE_URL);
			expect(mismatch.expected).toBe(WRONG_SHA256);
			expect(mismatch.actual).toBe(sha256Of(source));
			expect(mismatch.message).toContain(MODULE_URL);
			expect(mismatch.message).toContain(WRONG_SHA256);
			expect(mismatch.message).toContain(sha256Of(source));
		});

		it('never evaluates the module, calls onFetched, or writes a temp file on a mismatch', async () => {
			const tempDir = await moduleTempDir();
			const before = readdirSync(tempDir).length;

			stubGlobalFetch(COUNTING_PLUGIN_SOURCE);
			const seen: RemoteModuleFetch[] = [];
			installNodeRemoteModuleResolver({
				fetchImpl: fetchAnswering(() => jsResponse(COUNTING_PLUGIN_SOURCE)),
				expectedHash: () => WRONG_SHA256,
				onFetched: info => { seen.push(info); }
			});

			await expect(dynamicLoadModule(MODULE_URL, db)).rejects.toThrow(/pinned SHA-256/);

			// A test that only asserted on the message would still pass if the
			// import had run.
			expect(readEvaluationCount()).toBe(0);
			expect(seen).toHaveLength(0);
			expect(readdirSync(tempDir).length).toBe(before);
		});

		it('surfaces a mismatch through dynamicLoadModule without losing its class', async () => {
			stubGlobalFetch(COUNTING_PLUGIN_SOURCE);
			installNodeRemoteModuleResolver({
				fetchImpl: fetchAnswering(() => jsResponse(COUNTING_PLUGIN_SOURCE)),
				expectedHash: () => WRONG_SHA256
			});

			const error = await dynamicLoadModule(MODULE_URL, db).catch((e: unknown) => e);

			expect((error as Error).message).toContain(`Failed to load plugin from ${MODULE_URL}:`);
			expect((error as Error).cause).toBeInstanceOf(PluginHashMismatchError);
		});

		it('refuses a malformed pin rather than treating it as unpinned', async () => {
			const source = capturePluginSource(CAPTURE_KEY);
			for (const bad of ['deadbeef', 'z'.repeat(64), '', `${sha256Of(source)}00`]) {
				const resolver = createNodeRemoteResolver({
					fetchImpl: fetchAnswering(() => jsResponse(source)),
					expectedHash: () => bad
				});

				await expect(resolver(new URL(MODULE_URL)))
					.rejects.toThrow(new RegExp(`not 64 hex characters: '${bad}'`));
			}
		});

		it('lets a failing expectedHash propagate instead of loading unpinned', async () => {
			stubGlobalFetch(COUNTING_PLUGIN_SOURCE);
			installNodeRemoteModuleResolver({
				fetchImpl: fetchAnswering(() => jsResponse(COUNTING_PLUGIN_SOURCE)),
				expectedHash: () => { throw new Error('plugin record store is unreadable'); }
			});

			await expect(dynamicLoadModule(MODULE_URL, db))
				.rejects.toThrow(/plugin record store is unreadable/);
			expect(readEvaluationCount()).toBe(0);
		});

		it('compares an empty body like any other, rather than short-circuiting', async () => {
			const pinned = createNodeRemoteResolver({
				fetchImpl: fetchAnswering(() => new Response('', { status: 200 })),
				expectedHash: () => EMPTY_SHA256
			});
			const mispinned = createNodeRemoteResolver({
				fetchImpl: fetchAnswering(() => new Response('', { status: 200 })),
				expectedHash: () => WRONG_SHA256
			});

			await expect(pinned(new URL(MODULE_URL))).resolves.toMatch(/^file:/);
			await expect(mispinned(new URL(MODULE_URL))).rejects.toThrow(PluginHashMismatchError);
		});

		it('reports an HTTP failure rather than a hash mismatch', async () => {
			const resolver = createNodeRemoteResolver({
				fetchImpl: fetchAnswering(() => new Response('nope', { status: 404, statusText: 'Not Found' })),
				expectedHash: () => WRONG_SHA256
			});

			await expect(resolver(new URL(MODULE_URL))).rejects.toThrow(/HTTP 404/);
		});

		it('is not consulted at all when the fetch never produced bytes', async () => {
			// There is nothing to compare yet, and asking a host's record store on
			// every failed fetch is work it did not ask for.
			const asked: string[] = [];
			const resolver = createNodeRemoteResolver({
				fetchImpl: fetchAnswering(() => new Response('nope', { status: 404 })),
				expectedHash: url => { asked.push(url); return WRONG_SHA256; }
			});

			await expect(resolver(new URL(MODULE_URL))).rejects.toThrow(/HTTP 404/);

			expect(asked).toEqual([]);
		});

		it('lets the redirect and size guards win over a pin', async () => {
			const redirected = createNodeRemoteResolver({
				fetchImpl: fetchAnswering(() =>
					responseRedirectedTo('export default () => ({});', 'http://plugins.example.test/plugin.mjs')),
				expectedHash: () => WRONG_SHA256
			});
			const oversized = createNodeRemoteResolver({
				maxBytes: 32,
				fetchImpl: fetchAnswering(() => new Response('x'.repeat(4096), { status: 200 })),
				expectedHash: () => WRONG_SHA256
			});

			await expect(redirected(new URL(MODULE_URL))).rejects.toThrow(/not https:/);
			await expect(oversized(new URL(MODULE_URL))).rejects.toThrow(/over the 32-byte limit/);
		});

		it('leaves an unpinned load exactly as it was', async () => {
			const source = capturePluginSource(CAPTURE_KEY);
			stubGlobalFetch(source);
			const seen: RemoteModuleFetch[] = [];
			installNodeRemoteModuleResolver({
				fetchImpl: fetchAnswering(() => jsResponse(source)),
				onFetched: info => { seen.push(info); }
			});

			await dynamicLoadModule(MODULE_URL, db, { setting: 'on' });

			expect(readCapturedConfig(CAPTURE_KEY)?.setting).toBe('on');
			expect(seen).toHaveLength(1);
			expect(seen[0].sha256).toBe(sha256Of(source));
		});

		it('treats an expectedHash that returns undefined as unpinned', async () => {
			const source = capturePluginSource(CAPTURE_KEY);
			stubGlobalFetch(source);
			installNodeRemoteModuleResolver({
				fetchImpl: fetchAnswering(() => jsResponse(source)),
				expectedHash: () => undefined
			});

			await dynamicLoadModule(MODULE_URL, db, { setting: 'on' });

			expect(readCapturedConfig(CAPTURE_KEY)?.setting).toBe('on');
		});
	});

	describe('hashRemoteModule', () => {
		it('reports the same digest and size the resolver would, without importing', async () => {
			const fetchImpl = fetchAnswering(() => jsResponse(COUNTING_PLUGIN_SOURCE));

			const info = await hashRemoteModule(new URL(MODULE_URL), { fetchImpl });

			expect(info.url).toBe(MODULE_URL);
			expect(info.sha256).toBe(sha256Of(COUNTING_PLUGIN_SOURCE));
			expect(info.bytes).toBe(Buffer.byteLength(COUNTING_PLUGIN_SOURCE, 'utf8'));
			expect(readEvaluationCount()).toBe(0);

			// Same bytes, same digest as the load path would have pinned against.
			const resolver = createNodeRemoteResolver({ fetchImpl, expectedHash: () => info.sha256 });
			await expect(resolver(new URL(MODULE_URL))).resolves.toMatch(/^file:/);
		});

		it('writes no temp file', async () => {
			const tempDir = await moduleTempDir();
			const before = readdirSync(tempDir).length;

			await hashRemoteModule(new URL(MODULE_URL), {
				fetchImpl: fetchAnswering(() => jsResponse(COUNTING_PLUGIN_SOURCE))
			});

			expect(readdirSync(tempDir).length).toBe(before);
		});

		it('enforces maxBytes', async () => {
			await expect(hashRemoteModule(new URL(MODULE_URL), {
				maxBytes: 32,
				fetchImpl: fetchAnswering(() => new Response('x'.repeat(4096), { status: 200 }))
			})).rejects.toThrow(/over the 32-byte limit/);
		});

		it('refuses a redirect that leaves https:', async () => {
			await expect(hashRemoteModule(new URL(MODULE_URL), {
				fetchImpl: fetchAnswering(() =>
					responseRedirectedTo('export default () => ({});', 'http://plugins.example.test/plugin.mjs'))
			})).rejects.toThrow(/not https:/);
		});
	});
});
