/**
 * Tests for the npm-spec side of the loader: parsing `npm:@scope/name@ver/sub`
 * into parts, turning those parts into a CDN URL, detecting the environment,
 * and `loadPlugin`'s dispatch between direct-URL, Node-package and browser/CDN
 * paths.
 *
 * The CDN and Node-package branches are checked at the "builds the right URL /
 * refuses the right input" level — nothing here reaches the network.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import type { Database } from '@quereus/quereus';
import { loadPlugin } from '../src/index.js';
import { parseNpmSpec, toCdnUrl, resolveEnvironment } from '../src/plugin-loader.js';
import {
	writeTempModule,
	cleanupTempModules,
	capturePluginSource,
	readCapturedConfig,
	clearCapturedConfig
} from './helpers/plugin-fixtures.js';

const CAPTURE_KEY = '__quereusNpmSpecSpecReceived';

const db = {} as unknown as Database;

/** A package name that cannot resolve, so the Node branch fails without I/O. */
const MISSING_PACKAGE = '@quereus/__no-such-plugin-fixture__';

describe('parseNpmSpec', () => {
	it('parses a bare package name', () => {
		expect(parseNpmSpec('quereus-plugin-foo')).toEqual({ name: 'quereus-plugin-foo' });
	});

	it('strips the npm: prefix', () => {
		expect(parseNpmSpec('npm:quereus-plugin-foo')).toEqual({ name: 'quereus-plugin-foo' });
	});

	it('parses a scoped package without treating the scope @ as a version', () => {
		expect(parseNpmSpec('@scope/quereus-plugin-foo')).toEqual({ name: '@scope/quereus-plugin-foo' });
		expect(parseNpmSpec('npm:@scope/quereus-plugin-foo')).toEqual({ name: '@scope/quereus-plugin-foo' });
	});

	it('splits a version off an unscoped name', () => {
		expect(parseNpmSpec('foo@1.2.3')).toEqual({ name: 'foo', version: '1.2.3' });
		expect(parseNpmSpec('npm:foo@^1')).toEqual({ name: 'foo', version: '^1' });
		expect(parseNpmSpec('foo@latest')).toEqual({ name: 'foo', version: 'latest' });
	});

	it('splits a version off a scoped name', () => {
		expect(parseNpmSpec('@scope/foo@1.2.3')).toEqual({ name: '@scope/foo', version: '1.2.3' });
		expect(parseNpmSpec('npm:@scope/foo@~2.0.0')).toEqual({ name: '@scope/foo', version: '~2.0.0' });
	});

	it('treats an empty version as absent', () => {
		expect(parseNpmSpec('foo@')).toEqual({ name: 'foo' });
	});

	it('splits a subpath off an unscoped name at the first slash', () => {
		expect(parseNpmSpec('foo/dist/plugin.js')).toEqual({ name: 'foo', subpath: '/dist/plugin.js' });
	});

	it('splits a subpath off a scoped name at the second slash, not the first', () => {
		expect(parseNpmSpec('@scope/foo/dist/plugin.js'))
			.toEqual({ name: '@scope/foo', subpath: '/dist/plugin.js' });
	});

	it('parses version and subpath together', () => {
		expect(parseNpmSpec('npm:@scope/foo@1.2.3/sub'))
			.toEqual({ name: '@scope/foo', version: '1.2.3', subpath: '/sub' });
		expect(parseNpmSpec('foo@1.2.3/dist/plugin.mjs'))
			.toEqual({ name: 'foo', version: '1.2.3', subpath: '/dist/plugin.mjs' });
	});

	it('does not read a version out of the subpath', () => {
		// The `@` lives past the subpath split, so it is not a version marker.
		expect(parseNpmSpec('foo/dist@weird')).toEqual({ name: 'foo', subpath: '/dist@weird' });
	});

	it('returns null for input that cannot be a spec', () => {
		expect(parseNpmSpec('')).toBeNull();
		expect(parseNpmSpec('npm:')).toBeNull();
		expect(parseNpmSpec('has space')).toBeNull();
		expect(parseNpmSpec('npm:foo bar')).toBeNull();
	});

	it('does not attempt full npm name validation', () => {
		// Documenting current leniency: a bare scope parses, and the resulting
		// resolution failure is what reports the problem.
		expect(parseNpmSpec('@scope')).toEqual({ name: '@scope' });
	});
});

describe('toCdnUrl', () => {
	it('defaults the subpath to /plugin when the spec has none', () => {
		expect(toCdnUrl({ name: 'foo' }, 'jsdelivr')).toBe('https://cdn.jsdelivr.net/npm/foo/plugin');
		expect(toCdnUrl({ name: 'foo' }, 'unpkg')).toBe('https://unpkg.com/foo/plugin');
		expect(toCdnUrl({ name: 'foo' }, 'esm.sh')).toBe('https://esm.sh/foo/plugin');
	});

	it('omits the version segment when the spec has no version', () => {
		expect(toCdnUrl({ name: '@scope/foo' }, 'jsdelivr'))
			.toBe('https://cdn.jsdelivr.net/npm/@scope/foo/plugin');
	});

	it('pins the version when the spec has one', () => {
		expect(toCdnUrl({ name: 'foo', version: '1.2.3' }, 'jsdelivr'))
			.toBe('https://cdn.jsdelivr.net/npm/foo@1.2.3/plugin');
		expect(toCdnUrl({ name: '@scope/foo', version: '^1' }, 'unpkg'))
			.toBe('https://unpkg.com/@scope/foo@^1/plugin');
	});

	it('strips the leading slash off the subpath so the URL has no double slash', () => {
		expect(toCdnUrl({ name: 'foo', subpath: '/dist/plugin.mjs' }, 'jsdelivr'))
			.toBe('https://cdn.jsdelivr.net/npm/foo/dist/plugin.mjs');
		expect(toCdnUrl({ name: '@scope/foo', version: '2.0.0', subpath: '/dist/plugin.mjs' }, 'esm.sh'))
			.toBe('https://esm.sh/@scope/foo@2.0.0/dist/plugin.mjs');
	});

	it('always produces an https URL the loader will accept', () => {
		const url = toCdnUrl({ name: '@scope/foo', version: '1.0.0', subpath: '/dist/plugin.mjs' }, 'unpkg');
		expect(new URL(url).protocol).toBe('https:');
	});
});

describe('resolveEnvironment', () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('honours an explicit environment', () => {
		expect(resolveEnvironment('node')).toBe('node');
		expect(resolveEnvironment('browser')).toBe('browser');
	});

	it('auto-detects Node from the runtime, not from a DOM global', () => {
		expect(resolveEnvironment('auto')).toBe('node');
		expect(resolveEnvironment(undefined)).toBe('node');
	});

	it('auto-detects a browser when there is no Node process', () => {
		vi.stubGlobal('process', { env: {} });
		expect(resolveEnvironment('auto')).toBe('browser');
		expect(resolveEnvironment()).toBe('browser');
	});

	it('treats a DOM-less Web Worker as a browser, not Node', () => {
		// A worker has no `document` but is also not Node — quoomb-web loads
		// plugins from exactly this environment. Detecting by DOM absence would
		// misclassify it as Node.
		vi.stubGlobal('document', undefined);
		vi.stubGlobal('process', { env: {} });
		expect(resolveEnvironment('auto')).toBe('browser');
	});
});

describe('loadPlugin dispatch', () => {
	afterEach(async () => {
		vi.unstubAllGlobals();
		clearCapturedConfig(CAPTURE_KEY);
		await cleanupTempModules();
	});

	it('routes a file:// spec straight to the module loader', async () => {
		const { url } = await writeTempModule(capturePluginSource(CAPTURE_KEY));

		await loadPlugin(url, db, { from: 'direct-url' });

		expect(readCapturedConfig(CAPTURE_KEY)?.from).toBe('direct-url');
	});

	it('reports the protocol for a parseable URL outside the allowlist', async () => {
		// A disallowed scheme must not fall through to the package branch, where it
		// would be reported as an unresolvable package name.
		await expect(loadPlugin('http://example.com/plugin.js', db, {}, { env: 'node' }))
			.rejects.toThrow(/Unsupported plugin URL protocol 'http:'/);
		await expect(loadPlugin('data:text/javascript,export default () => ({})', db, {}, { env: 'node' }))
			.rejects.toThrow(/Unsupported plugin URL protocol 'data:'/);
	});

	it('still treats an npm: spec as a package, not a URL', async () => {
		// `npm:` parses as a URL, so it is the one scheme the URL branch must skip.
		await expect(loadPlugin(`npm:${MISSING_PACKAGE}`, db, {}, { env: 'node' }))
			.rejects.toThrow(/Failed to resolve plugin package/);
	});

	it('rejects a spec that is neither a URL nor a package name', async () => {
		await expect(loadPlugin('', db)).rejects.toThrow(/Invalid plugin spec/);
		await expect(loadPlugin('has space', db)).rejects.toThrow(/Invalid plugin spec/);
	});

	it('refuses npm specs in the browser unless CDN resolution is opted into', async () => {
		await expect(loadPlugin('npm:@scope/foo', db, {}, { env: 'browser' }))
			.rejects.toThrow(/requires allowCdn=true/);
		await expect(loadPlugin('npm:@scope/foo', db, {}, { env: 'browser', allowCdn: false }))
			.rejects.toThrow(/Received spec 'npm:@scope\/foo'/);
	});

	it('reports which package failed to resolve on the Node path', async () => {
		await expect(loadPlugin(MISSING_PACKAGE, db, {}, { env: 'node' }))
			.rejects.toThrow(new RegExp(`Failed to resolve plugin package '${MISSING_PACKAGE}'`));
	});

	it('tells the Node path user which export shape is expected', async () => {
		await expect(loadPlugin(`npm:${MISSING_PACKAGE}@1.0.0`, db, {}, { env: 'node' }))
			.rejects.toThrow(/Ensure it exports '\.\/plugin' or a default module/);
	});

	it('asks for allowCdn on an npm spec auto-detected in a DOM-less, non-Node runtime (e.g. a Web Worker), instead of attempting a package import', async () => {
		vi.stubGlobal('document', undefined);
		vi.stubGlobal('process', { env: {} });

		await expect(loadPlugin(`npm:${MISSING_PACKAGE}`, db, {}))
			.rejects.toThrow(/requires allowCdn=true/);
	});
});
