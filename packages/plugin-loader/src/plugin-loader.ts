import type { Database, SqlValue } from '@quereus/quereus';
import { registerPlugin } from '@quereus/quereus';
import type { PluginManifest, PluginRegistrations } from './manifest.js';
import debug from 'debug';

const log = debug('quereus:plugin-loader');

/**
 * Protocols a plugin module may be loaded from. Enforced inside
 * {@link dynamicLoadModule} (the single choke point every load path funnels
 * through) so no caller can reach the loader with a disallowed protocol, and
 * re-used by {@link validatePluginUrl} for pre-flight UI validation.
 */
const ALLOWED_PLUGIN_PROTOCOLS = ['https:', 'file:'];

/**
 * Plugin module interface - what we expect from a plugin module
 */
export interface PluginModule {
	/** Default export - the plugin registration function */
	default: (db: Database, config?: Record<string, SqlValue>) => Promise<PluginRegistrations> | PluginRegistrations;
}

/** What a host learns about a plugin module it fetched over the network. */
export interface RemoteModuleFetch {
	/** The URL that was requested (before any redirects). */
	url: string;
	/** SHA-256 of the fetched bytes, lowercase hex. */
	sha256: string;
	/** Size of the fetched module, in bytes. */
	bytes: number;
}

/**
 * Fetched plugin bytes did not match the SHA-256 the host pinned for that URL.
 *
 * Lives here rather than in `node-remote.ts` so a host can `instanceof` it
 * without importing the Node-only subpath: it is a plain `Error` subclass with
 * no `node:` imports.
 */
export class PluginHashMismatchError extends Error {
	/** The module URL that was requested, normalized (`new URL(x).href`). */
	readonly url: string;
	/** Lowercase hex the host required. */
	readonly expected: string;
	/** Lowercase hex of what was actually served. */
	readonly actual: string;

	constructor(url: string, expected: string, actual: string) {
		super(
			`Plugin module at ${url} does not match its pinned SHA-256. ` +
			`Expected ${expected}, got ${actual}. Refusing to load it.`
		);
		this.name = 'PluginHashMismatchError';
		this.url = url;
		this.expected = expected;
		this.actual = actual;
	}
}

/**
 * Turns an `https:` module URL into a specifier this runtime's `import()` can
 * load — under Node, a `file:` URL for a locally fetched copy.
 *
 * Node hosts must install one (see `@quereus/plugin-loader/node`), because
 * Node's ESM loader accepts only `file:` and `data:` URLs. Browsers and workers
 * need none — `import('https://…')` works there natively.
 */
export type RemoteModuleResolver = (url: URL) => Promise<string>;

/**
 * Module-level singleton rather than a `dynamicLoadModule` option: the loader
 * has many call sites across the CLI and the web worker, and threading a
 * resolver through all of them buys nothing over the host installing it once at
 * startup.
 */
let remoteModuleResolver: RemoteModuleResolver | null = null;

/** Installs (or, with `null`, clears) the resolver used for `https:` module loads. */
export function setRemoteModuleResolver(resolver: RemoteModuleResolver | null): void {
	remoteModuleResolver = resolver;
}

interface PackageJson {
	name?: string;
	version?: string;
	author?: string;
	description?: string;
	quereus?: {
		pragmaPrefix?: string;
		settings?: PluginManifest['settings'];
		provides?: PluginManifest['provides'];
		capabilities?: string[];
	};
}

/**
 * Extracts plugin manifest from package.json metadata
 */
function extractManifestFromPackageJson(pkg: PackageJson): PluginManifest {
	const quereus = pkg.quereus ?? {};

	return {
		name: pkg.name ?? 'Unknown Plugin',
		version: pkg.version ?? '0.0.0',
		author: pkg.author,
		description: pkg.description,
		pragmaPrefix: quereus.pragmaPrefix,
		settings: quereus.settings,
		provides: quereus.provides,
		capabilities: quereus.capabilities
	};
}

/**
 * Validates that a plugin module has the expected structure.
 */
function assertValidPluginModule(mod: unknown, source: string): asserts mod is PluginModule {
	const m = mod as Record<string, unknown>;
	if (typeof m.default !== 'function') {
		throw new Error(`Module at ${source} has no default export function`);
	}
}

/**
 * Attempts to load a package.json manifest from a URL.
 * Returns undefined when the manifest is unavailable.
 */
async function tryLoadManifestFromUrl(moduleUrl: URL): Promise<PluginManifest | undefined> {
	try {
		const packageJsonUrl = new URL('package.json', moduleUrl);
		const response = await fetch(packageJsonUrl.toString());
		if (response.ok) {
			const pkg = await response.json() as PackageJson;
			return extractManifestFromPackageJson(pkg);
		}
	} catch {
		log('Could not load package.json for plugin at %s', moduleUrl);
	}
	return undefined;
}

/**
 * Dynamically loads and registers a plugin module
 *
 * @param url The URL to the ES module (can be https:// or file:// URL)
 * @param db The Database instance to register the module with
 * @param config Configuration values to pass to the module
 * @returns The plugin's manifest if available
 */
export async function dynamicLoadModule(
	url: string,
	db: Database,
	config: Record<string, SqlValue> = {}
): Promise<PluginManifest | undefined> {
	try {
		const moduleUrl = new URL(url);

		// Enforce the protocol allowlist here, at the loader itself, so a caller
		// that reaches dynamicLoadModule without going through validatePluginUrl
		// (e.g. the web worker's loadModule) still cannot load an arbitrary scheme.
		if (!ALLOWED_PLUGIN_PROTOCOLS.includes(moduleUrl.protocol)) {
			throw new Error(
				`Unsupported plugin URL protocol '${moduleUrl.protocol}'. ` +
				`Allowed: ${ALLOWED_PLUGIN_PROTOCOLS.join(', ')}.`
			);
		}

		const specifier = await resolveImportSpecifier(moduleUrl);

		// Dynamic import with Vite ignore comment for bundler compatibility
		const mod: unknown = await import(/* @vite-ignore */ specifier);

		assertValidPluginModule(mod, url);

		await registerPlugin(db, mod.default, config);
		log('Loaded plugin from %s', url);

		// Deliberately the *original* URL, not `specifier`: a remote resolver
		// hands back a local temp file, and resolving 'package.json' against that
		// would look in the temp directory instead of beside the plugin.
		return await tryLoadManifestFromUrl(moduleUrl);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		// `cause` keeps the original class reachable — without it every failure
		// flattens to a bare Error and a caller cannot tell a hash mismatch
		// (see {@link PluginHashMismatchError}) from a 404.
		throw new Error(`Failed to load plugin from ${url}: ${message}`, { cause: error });
	}
}

/**
 * Turns a validated plugin module URL into a specifier this runtime's `import()`
 * can actually load.
 *
 * Never mutates `moduleUrl` — the caller still needs the original to resolve the
 * plugin's `package.json` against.
 *
 * @internal Exported for tests only — the browser/worker branch cannot be
 * reached through {@link dynamicLoadModule} under Node, since the import it
 * returns a specifier for would then be attempted for real.
 */
export async function resolveImportSpecifier(moduleUrl: URL): Promise<string> {
	if (moduleUrl.protocol === 'file:') {
		return withCacheBuster(moduleUrl);
	}

	// Only `https:` reaches here (the allowlist rejected everything else).
	// A host-installed resolver wins wherever one exists; failing that, Node
	// cannot import the URL at all, while browsers and workers do it natively.
	if (remoteModuleResolver) {
		return await remoteModuleResolver(moduleUrl);
	}
	if (isNodeRuntime()) {
		throw new Error(
			`Loading a plugin over https:// is not supported by Node's ESM loader. ` +
			`Install the Node resolver (installNodeRemoteModuleResolver() from ` +
			`'@quereus/plugin-loader/node'), or load the plugin from an installed npm ` +
			`package or a file:// URL.`
		);
	}

	// Browser or worker: `import('https://…')` is native. Cache-bust a local dev
	// server so a rebuilt plugin is picked up without a hard reload.
	return moduleUrl.hostname === 'localhost' ? withCacheBuster(moduleUrl) : moduleUrl.toString();
}

/**
 * True when this runtime is Node, whose ESM loader accepts only `file:` and
 * `data:` specifiers.
 *
 * {@link resolveEnvironment} is defined in terms of this rather than "no
 * `document`": a Web Worker — which is where quoomb-web loads its plugins —
 * has no `document` yet is not Node, and should be treated as a browser. A
 * bundler's `process` shim declares no `versions.node`, so it does not trip
 * this either.
 *
 * @internal Exported for tests only — see {@link resolveEnvironment}.
 */
export function isNodeRuntime(): boolean {
	const proc = (globalThis as { process?: { versions?: { node?: string } } }).process;
	return typeof proc?.versions?.node === 'string';
}

/**
 * Returns `moduleUrl` with a fresh `?t=` stamp, so a reload re-evaluates the
 * module instead of getting the copy already in the module registry.
 *
 * NOTE: each reload therefore imports a distinct specifier, so Node keeps every
 * prior version of the module in its registry. Harmless for a CLI or a dev
 * session; if a long-lived host starts reloading plugins in a loop, it needs a
 * real unload story rather than a new query string per load.
 */
function withCacheBuster(moduleUrl: URL): string {
	const busted = new URL(moduleUrl.href);
	busted.searchParams.set('t', Date.now().toString());
	return busted.toString();
}

/**
 * Validates that a URL is likely to be a valid plugin module
 *
 * @param url The URL to validate
 * @returns true if the URL appears valid
 */
export function validatePluginUrl(url: string): boolean {
	try {
		const parsed = new URL(url);

		// Only allow secure protocols (shared with the loader's enforced allowlist)
		if (!ALLOWED_PLUGIN_PROTOCOLS.includes(parsed.protocol)) {
			return false;
		}

		// Must end with .js or .mjs
		if (!/\.(m?js)$/i.test(parsed.pathname)) {
			return false;
		}

		return true;
	} catch {
		return false;
	}
}


/** Loader options for loadPlugin */
export interface LoadPluginOptions {
	/**
	 * Environment hint. Defaults to auto-detection.
	 * 'browser' enables optional CDN resolution when allowCdn is true.
	 */
	env?: 'auto' | 'browser' | 'node';
	/**
	 * Allow resolving npm: specs to a public CDN in browser contexts.
	 * Disabled by default (opt-in).
	 */
	allowCdn?: boolean;
	/** Which CDN to use when allowCdn is true. Defaults to 'jsdelivr'. */
	cdn?: 'jsdelivr' | 'unpkg' | 'esm.sh';
}

/**
 * High-level plugin loader that accepts npm specs or direct URLs.
 *
 * Examples:
 * - npm:@scope/quereus-plugin-foo@^1
 * - @scope/quereus-plugin-foo (npm package name)
 * - https://raw.githubusercontent.com/user/repo/main/plugin.js
 * - file:///path/to/plugin.js (Node only)
 */
export async function loadPlugin(
	spec: string,
	db: Database,
	config: Record<string, SqlValue> = {},
	options: LoadPluginOptions = {}
): Promise<PluginManifest | undefined> {
	const env = resolveEnvironment(options.env);

	// Direct URL or file path via dynamicLoadModule
	if (isUrlLike(spec)) {
		return await dynamicLoadModule(spec, db, config);
	}

	// Interpret as npm spec or bare package name
	const npm = parseNpmSpec(spec);
	if (!npm) {
		throw new Error(
			`Invalid plugin spec: ${spec}. Use a URL, file://, or npm package (e.g., npm:@scope/name@version).`
		);
	}

	if (env === 'node') {
		return await loadFromNodePackage(npm, db, config);
	}

	// Browser path: npm spec requires CDN; only if explicitly allowed
	if (!options.allowCdn) {
		throw new Error(
			`Loading npm packages in the browser requires allowCdn=true. Received spec '${spec}'. ` +
			`Either provide a direct https:// URL to the ESM plugin or enable CDN resolution.`
		);
	}

	const cdnUrl = toCdnUrl(npm, options.cdn ?? 'jsdelivr');
	return await dynamicLoadModule(cdnUrl, db, config);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * NOTE: auto-detection is binary — anything that is not Node is treated as a
 * browser, so React Native / NativeScript answer `'browser'` and an npm spec
 * there fails asking for `allowCdn` rather than attempting a package import.
 * Neither path actually works on those runtimes (they must register plugins
 * statically — see the package README); if one ever gains a real dynamic
 * loading story, this needs a third environment rather than a wider `if`.
 *
 * @internal Exported for tests only — not re-exported from `index.js`, so it is
 * not part of the package's public API.
 */
export function resolveEnvironment(env?: 'auto' | 'browser' | 'node'): 'browser' | 'node' {
	if (env && env !== 'auto') return env;
	return isNodeRuntime() ? 'node' : 'browser';
}

/**
 * True when a spec should be handled as a URL rather than an npm package.
 * Any parseable absolute URL qualifies — *including* disallowed schemes, so that
 * {@link dynamicLoadModule}'s allowlist names the offending protocol instead of
 * the spec falling through to the package branch and failing as an unresolvable
 * package name. `npm:` is the one scheme that means "package", so it is exempt.
 */
function isUrlLike(s: string): boolean {
	try {
		return new URL(s).protocol !== 'npm:';
	} catch {
		return false;
	}
}

/** @internal Exported for tests only — see {@link resolveEnvironment}. */
export interface NpmSpec {
	name: string;
	version?: string;
	subpath?: string;
}

/**
 * Parses an npm spec (`npm:@scope/name@version/subpath`, or a bare package
 * name) into its parts. Returns null for input that cannot be a package spec
 * (empty, or containing whitespace); it does *not* attempt full npm name
 * validation — resolution failures surface from the import itself.
 *
 * @internal Exported for tests only — see {@link resolveEnvironment}.
 */
export function parseNpmSpec(input: string): NpmSpec | null {
	const raw = input.startsWith('npm:') ? input.slice(4) : input;
	if (!raw || /\s/.test(raw)) return null;

	const { nameAndVersion, subpath } = splitSubpath(raw);
	return splitVersion(nameAndVersion, subpath);
}

function splitSubpath(raw: string): { nameAndVersion: string; subpath?: string } {
	if (raw.startsWith('@')) {
		const secondSlash = raw.indexOf('/', raw.indexOf('/') + 1);
		if (secondSlash !== -1) {
			return { nameAndVersion: raw.slice(0, secondSlash), subpath: raw.slice(secondSlash) };
		}
	} else {
		const firstSlash = raw.indexOf('/');
		if (firstSlash !== -1) {
			return { nameAndVersion: raw.slice(0, firstSlash), subpath: raw.slice(firstSlash) };
		}
	}
	return { nameAndVersion: raw };
}

function splitVersion(nameAndVersion: string, subpath?: string): NpmSpec {
	const atIndex = nameAndVersion.lastIndexOf('@');
	const startsWithScope = nameAndVersion.startsWith('@');

	if (atIndex > (startsWithScope ? 0 : -1)) {
		const name = nameAndVersion.slice(0, atIndex);
		const version = nameAndVersion.slice(atIndex + 1) || undefined;
		return { name, version, subpath };
	}
	return { name: nameAndVersion, subpath };
}

async function loadFromNodePackage(
	npm: NpmSpec,
	db: Database,
	config: Record<string, SqlValue>
): Promise<PluginManifest | undefined> {
	const subpathImport = `${npm.name}/plugin${npm.subpath ?? ''}`;
	const candidates = [subpathImport, `${npm.name}${npm.subpath ?? ''}`];

	const mod = await resolveFirstModule(candidates, npm.name);
	assertValidPluginModule(mod, npm.name);

	await registerPlugin(db, mod.default, config);
	log('Loaded plugin from package %s', npm.name);

	return await tryLoadManifestFromPackage(npm.name);
}

async function resolveFirstModule(candidates: string[], packageName: string): Promise<unknown> {
	let lastErr: unknown;
	for (const target of candidates) {
		try {
			return await import(/* @vite-ignore */ target);
		} catch (e) {
			lastErr = e;
		}
	}
	throw new Error(
		`Failed to resolve plugin package '${packageName}'. ` +
		`Ensure it exports './plugin' or a default module. ` +
		`Last error: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`
	);
}

async function tryLoadManifestFromPackage(packageName: string): Promise<PluginManifest | undefined> {
	try {
		const pkg = await import(/* @vite-ignore */ `${packageName}/package.json`, { with: { type: 'json' } });
		return extractManifestFromPackageJson(pkg.default as PackageJson);
	} catch {
		log('Could not load package.json for plugin %s', packageName);
		return undefined;
	}
}

/** @internal Exported for tests only — see {@link resolveEnvironment}. */
export function toCdnUrl(spec: NpmSpec, cdn: 'jsdelivr' | 'unpkg' | 'esm.sh'): string {
	const versionSegment = spec.version ? `@${spec.version}` : '';
	const subpath = spec.subpath ? spec.subpath.replace(/^\//, '') : 'plugin';
	switch (cdn) {
		case 'unpkg':
			return `https://unpkg.com/${spec.name}${versionSegment}/${subpath}`;
		case 'esm.sh':
			return `https://esm.sh/${spec.name}${versionSegment}/${subpath}`;
		case 'jsdelivr':
		default:
			return `https://cdn.jsdelivr.net/npm/${spec.name}${versionSegment}/${subpath}`;
	}
}
