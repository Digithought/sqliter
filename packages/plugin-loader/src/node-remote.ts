/**
 * Node support for loading plugin modules over `https:`.
 *
 * Node's ESM loader accepts only `file:` and `data:` URLs, so `import('https://…')`
 * fails with `ERR_UNSUPPORTED_ESM_URL_SCHEME`. This module supplies the missing
 * step: fetch the module, hash it, drop it in a temp file, and hand the loader a
 * `file:` URL it can import.
 *
 * It lives behind the `@quereus/plugin-loader/node` subpath — and is *not*
 * re-exported from the package index — so a browser or React Native bundle never
 * pulls in `node:fs`.
 */

import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import debug from 'debug';
import { setRemoteModuleResolver } from './plugin-loader.js';
import type { RemoteModuleFetch, RemoteModuleResolver } from './plugin-loader.js';

const log = debug('quereus:plugin-loader:node-remote');

/** Ceiling on a fetched plugin module, unless the host raises it. */
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;

/** Media types we expect a JavaScript module to be served as. */
const JS_MEDIA_TYPE = /(java|ecma)script/i;

export interface NodeRemoteResolverOptions {
	/**
	 * Called after each successful fetch, before the module is imported. Hosts
	 * use it to tell the user what was downloaded and to record the hash.
	 * Awaited, so a host may persist from here.
	 */
	onFetched?: (info: RemoteModuleFetch) => void | Promise<void>;
	/** Reject modules larger than this. Defaults to 5 MiB. */
	maxBytes?: number;
	/** Injected by tests; defaults to the global `fetch`. */
	fetchImpl?: typeof fetch;
}

/**
 * Builds a resolver that fetches an `https:` plugin module to a temp file and
 * returns that file's `file:` URL.
 *
 * Fetching happens on every load — there is no on-disk cache — so a plugin
 * saved by URL re-downloads and re-executes remote code each time the host
 * starts. That is why {@link NodeRemoteResolverOptions.onFetched} exists: the
 * host is expected to make it visible rather than silent.
 */
export function createNodeRemoteResolver(options: NodeRemoteResolverOptions = {}): RemoteModuleResolver {
	const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
	const fetchImpl = options.fetchImpl ?? globalThis.fetch;

	return async (url: URL): Promise<string> => {
		const response = await fetchImpl(url.toString());
		if (!response.ok) {
			throw new Error(
				`Failed to fetch plugin module from ${url.href}: HTTP ${response.status}` +
				(response.statusText ? ` ${response.statusText}` : '')
			);
		}

		assertSecureFinalUrl(response, url);
		logUnexpectedMediaType(response, url);

		const bytes = await readCappedBody(response, maxBytes, url.href);
		const sha256 = createHash('sha256').update(bytes).digest('hex');
		const path = writeModuleFile(bytes, sha256);

		await options.onFetched?.({ url: url.href, sha256, bytes: bytes.byteLength });

		log('Fetched %s to %s (%d bytes, sha256 %s)', url.href, path, bytes.byteLength, sha256);
		return pathToFileURL(path).href;
	};
}

/** Creates a resolver and installs it as the process-wide one. */
export function installNodeRemoteModuleResolver(options: NodeRemoteResolverOptions = {}): void {
	setRemoteModuleResolver(createNodeRemoteResolver(options));
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * `fetch` follows redirects across protocols, so an https → http hop would
 * otherwise downgrade the transport silently. Re-check where the request
 * actually landed.
 */
function assertSecureFinalUrl(response: Response, requested: URL): void {
	// A response with no `url` came from a fetch implementation that does not
	// report one (some test doubles); there is no redirect to check.
	if (!response.url) return;

	let finalUrl: URL;
	try {
		finalUrl = new URL(response.url);
	} catch {
		throw new Error(
			`Fetching plugin module ${requested.href} ended at an unparseable URL '${response.url}'.`
		);
	}

	if (finalUrl.protocol !== 'https:') {
		throw new Error(
			`Fetching plugin module ${requested.href} was redirected to ${finalUrl.protocol}//` +
			`${finalUrl.host}${finalUrl.pathname}, which is not https:. Refusing to load it.`
		);
	}
}

/**
 * Plenty of raw-file hosts serve JavaScript as `text/plain` or
 * `application/octet-stream`, so an unexpected media type is a debug note, not a
 * failure.
 */
function logUnexpectedMediaType(response: Response, url: URL): void {
	const contentType = response.headers?.get('content-type');
	if (contentType && !JS_MEDIA_TYPE.test(contentType)) {
		log('Plugin module at %s served as %s, not a JavaScript media type', url.href, contentType);
	}
}

/**
 * Reads the response body, refusing anything over `maxBytes`. Both the declared
 * `content-length` and the bytes actually received are checked, so neither a
 * missing nor a lying header can get past the limit.
 */
async function readCappedBody(response: Response, maxBytes: number, url: string): Promise<Uint8Array> {
	const declared = Number(response.headers?.get('content-length') ?? Number.NaN);
	if (Number.isFinite(declared)) {
		assertWithinLimit(declared, maxBytes, url, 'declares');
	}

	if (!response.body) {
		// Bodyless response (some fetch implementations and test doubles): buffer
		// it, then apply the same limit to the real byte count.
		const buffered = new Uint8Array(await response.arrayBuffer());
		assertWithinLimit(buffered.byteLength, maxBytes, url, 'is');
		return buffered;
	}

	return await readStreamCapped(response.body, maxBytes, url);
}

/** Streams a body, bailing out as soon as the running total exceeds the limit. */
async function readStreamCapped(
	body: ReadableStream<Uint8Array>,
	maxBytes: number,
	url: string
): Promise<Uint8Array> {
	const reader = body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;

	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			total += value.byteLength;
			assertWithinLimit(total, maxBytes, url, 'is');
			chunks.push(value);
		}
	} catch (error) {
		// Stop the transfer rather than leaving the socket draining a body we
		// have already decided to reject.
		await reader.cancel().catch(cancelError => log('Cancelling %s after a read failure: %O', url, cancelError));
		throw error;
	}

	reader.releaseLock();
	return concatChunks(chunks, total);
}

function assertWithinLimit(bytes: number, maxBytes: number, url: string, verb: 'is' | 'declares'): void {
	if (bytes > maxBytes) {
		throw new Error(
			`Plugin module at ${url} ${verb} ${bytes} bytes, over the ${maxBytes}-byte limit.`
		);
	}
}

function concatChunks(chunks: Uint8Array[], total: number): Uint8Array {
	const joined = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		joined.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return joined;
}

/** Temp directory holding this process's fetched modules; created on first use. */
let moduleDir: string | undefined;

/** Distinguishes successive fetches — see {@link writeModuleFile}. */
let moduleCounter = 0;

/**
 * Creates this process's temp directory on first use and arranges for it to be
 * removed at exit.
 *
 * NOTE: `process.on('exit')` does not run when the process dies abruptly —
 * SIGKILL, or a worker thread that the host terminates (a vitest pool worker
 * does exactly this, leaving one directory per run). The OS reclaims temp space
 * eventually, so this is not worth a cleanup daemon; if a long-lived host ever
 * loads plugins often enough for the leftovers to matter, sweep stale
 * `quereus-plugins-*` directories at startup.
 */
function ensureModuleDir(): string {
	if (moduleDir === undefined) {
		moduleDir = mkdtempSync(join(tmpdir(), `quereus-plugins-${process.pid}-`));
		const dir = moduleDir;
		process.once('exit', () => rmSync(dir, { recursive: true, force: true }));
	}
	return moduleDir;
}

/**
 * Writes fetched module bytes to a `.mjs` file (so Node treats them as ESM
 * whatever the enclosing directory says) and returns its path.
 *
 * The counter in the filename matters: without it, a second load of an unchanged
 * URL would produce the same specifier and Node would serve the module from its
 * registry instead of re-evaluating it — the very thing the loader's `?t=`
 * cache-buster exists to avoid.
 *
 * Files stay for the life of the process rather than being unlinked after
 * import, so stack traces from inside the plugin still resolve.
 *
 * NOTE: as with the `?t=` cache-buster, every reload leaves the prior module
 * version in Node's registry. Fine for a CLI; a long-lived host that reloads
 * plugins in a loop needs a real unload story.
 */
function writeModuleFile(bytes: Uint8Array, sha256: string): string {
	const path = join(ensureModuleDir(), `${sha256.slice(0, 16)}-${moduleCounter++}.mjs`);
	writeFileSync(path, bytes);
	return path;
}
