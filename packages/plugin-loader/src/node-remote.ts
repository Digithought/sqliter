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
import { PluginHashMismatchError, setRemoteModuleResolver } from './plugin-loader.js';
import type { RemoteModuleFetch, RemoteModuleResolver } from './plugin-loader.js';

const log = debug('quereus:plugin-loader:node-remote');

/** Ceiling on a fetched plugin module, unless the host raises it. */
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;

/** Media types we expect a JavaScript module to be served as. */
const JS_MEDIA_TYPE = /(java|ecma)script/i;

/** A SHA-256 as the host must supply it: 64 hex characters. */
const SHA256_HEX = /^[0-9a-f]{64}$/;

export interface NodeRemoteResolverOptions {
	/**
	 * The SHA-256 (hex) this URL's module bytes must hash to, or undefined when
	 * the host does not pin this URL. Consulted on every fetch; a mismatch aborts
	 * the load before the module is written to disk or imported.
	 *
	 * Receives the *normalized* URL (what `new URL(x).href` produces), because
	 * that is what the loader hands the resolver — a host keyed by the raw
	 * user-typed string must normalize on its side.
	 *
	 * Pinning covers only `https:` loads: a `file:` URL never reaches the
	 * resolver, so a pin on one is inert.
	 */
	expectedHash?: (url: string) => string | undefined | Promise<string | undefined>;
	/**
	 * Called after each successful fetch, before the module is imported. Hosts
	 * use it to tell the user what was downloaded and to record the hash.
	 * Awaited, so a host may persist from here.
	 *
	 * Not called when {@link NodeRemoteResolverOptions.expectedHash} rejects the
	 * bytes — a refused load reports nothing and writes nothing.
	 */
	onFetched?: (info: RemoteModuleFetch) => void | Promise<void>;
	/** Reject modules larger than this. Defaults to 5 MiB. */
	maxBytes?: number;
	/** Injected by tests; defaults to the global `fetch`. */
	fetchImpl?: typeof fetch;
}

/** What {@link fetchModuleBytes} produces: the bytes served, plus their digest. */
interface FetchedModule {
	/** Module bytes exactly as served. */
	data: Uint8Array;
	/** SHA-256 of {@link FetchedModule.data}, lowercase hex. */
	sha256: string;
}

/**
 * Builds a resolver that fetches an `https:` plugin module to a temp file and
 * returns that file's `file:` URL.
 *
 * Fetching happens on every load — there is no on-disk cache — so a plugin
 * saved by URL re-downloads and re-executes remote code each time the host
 * starts. That is why {@link NodeRemoteResolverOptions.onFetched} exists: the
 * host is expected to make it visible rather than silent, and why
 * {@link NodeRemoteResolverOptions.expectedHash} exists for hosts that want the
 * fetch gated rather than merely reported.
 */
export function createNodeRemoteResolver(options: NodeRemoteResolverOptions = {}): RemoteModuleResolver {
	return async (url: URL): Promise<string> => {
		const { data, sha256 } = await fetchModuleBytes(url, options);

		// Before anything touches disk or the module registry: bytes that fail the
		// pin must never be written, reported, or imported.
		await verifyExpectedHash(url, sha256, options.expectedHash);

		const path = writeModuleFile(data, sha256);
		await options.onFetched?.({ url: url.href, sha256, bytes: data.byteLength });

		log('Fetched %s to %s (%d bytes, sha256 %s)', url.href, path, data.byteLength, sha256);
		return pathToFileURL(path).href;
	};
}

/** Creates a resolver and installs it as the process-wide one. */
export function installNodeRemoteModuleResolver(options: NodeRemoteResolverOptions = {}): void {
	setRemoteModuleResolver(createNodeRemoteResolver(options));
}

/**
 * Fetches a remote plugin module and returns its digest — same transport checks
 * and size cap as the resolver, but nothing is written to disk and nothing is
 * imported. Hosts use it to answer "what does this URL serve right now?" so a
 * user can adopt a new version deliberately instead of running the new code to
 * find out what it is.
 *
 * This is a *separate* fetch from any load that follows it: the bytes can change
 * in between, and a pinned load then fails. That fails closed, which is the right
 * direction, but a host must not present the digest as a promise about the next
 * load.
 */
export async function hashRemoteModule(
	url: URL,
	options: Pick<NodeRemoteResolverOptions, 'maxBytes' | 'fetchImpl'> = {}
): Promise<RemoteModuleFetch> {
	const { data, sha256 } = await fetchModuleBytes(url, options);
	return { url: url.href, sha256, bytes: data.byteLength };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * The transport half both {@link createNodeRemoteResolver} and
 * {@link hashRemoteModule} run: fetch, refuse a redirect off `https:`, cap the
 * body, hash it. Neither writes anything — that is the caller's business.
 */
async function fetchModuleBytes(
	url: URL,
	options: Pick<NodeRemoteResolverOptions, 'maxBytes' | 'fetchImpl'>
): Promise<FetchedModule> {
	const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;

	// Resolved per call, not at construction: a host installs the resolver at
	// startup, which may be before a `fetch` polyfill (or a test double) exists.
	const fetchImpl = options.fetchImpl ?? globalThis.fetch;
	const response = await fetchImpl(url.toString());
	try {
		if (!response.ok) {
			throw new Error(
				`Failed to fetch plugin module from ${url.href}: HTTP ${response.status}` +
				(response.statusText ? ` ${response.statusText}` : '')
			);
		}

		assertSecureFinalUrl(response, url);
		logUnexpectedMediaType(response, url);

		const data = await readCappedBody(response, maxBytes, url.href);
		return { data, sha256: createHash('sha256').update(data).digest('hex') };
	} catch (error) {
		await discardBody(response);
		throw error;
	}
}

/**
 * Releases the connection behind a response we are rejecting without reading.
 * A body left unread keeps its socket occupied until the response is collected.
 */
async function discardBody(response: Response): Promise<void> {
	// Locked means a reader already owns (and has cancelled) the stream —
	// cancelling it again throws.
	if (!response.body || response.body.locked) return;
	await response.body.cancel().catch(error => log('Discarding a rejected body failed: %O', error));
}

/**
 * Compares the fetched digest against what the host pinned for this URL, if
 * anything.
 *
 * An expected value that is not 64 hex characters is a host bug and fails
 * closed: silently reading it as "not pinned" would turn a typo into an
 * unprotected load. Likewise, an `expectedHash` that throws propagates rather
 * than degrading to "not pinned".
 */
async function verifyExpectedHash(
	url: URL,
	sha256: string,
	expectedHash: NodeRemoteResolverOptions['expectedHash']
): Promise<void> {
	if (!expectedHash) return;

	const expected = await expectedHash(url.href);
	// Only "no pin at all" is a pass; an empty or malformed string is not.
	if (expected === undefined || expected === null) return;

	const normalized = String(expected).trim().toLowerCase();
	if (!SHA256_HEX.test(normalized)) {
		throw new Error(
			`Expected SHA-256 for plugin module at ${url.href} is not 64 hex characters: ` +
			`'${expected}'. Refusing to load it.`
		);
	}

	if (normalized !== sha256) {
		throw new PluginHashMismatchError(url.href, normalized, sha256);
	}
}

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
 *
 * NOTE: `expectedHash` verifies the bytes in memory, but the import reads them
 * back off disk — safe only because {@link ensureModuleDir} uses `mkdtemp`, so
 * the directory is private to this user and this process. If fetched modules
 * ever move to a shared or predictable location (a disk cache, say), the pin
 * would be guaranteeing bytes that another writer could have replaced; verify
 * again on read, or keep the path unguessable.
 */
function writeModuleFile(bytes: Uint8Array, sha256: string): string {
	const path = join(ensureModuleDir(), `${sha256.slice(0, 16)}-${moduleCounter++}.mjs`);
	writeFileSync(path, bytes);
	return path;
}
