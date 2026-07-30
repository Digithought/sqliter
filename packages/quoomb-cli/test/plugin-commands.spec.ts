/**
 * Round-trips `.plugin` subcommands (packages/quoomb-cli/src/commands/dot-commands.ts)
 * through `handleDotCommand` for a plugin whose `package.json` 404s beside the
 * module — the case bug-cli-plugin-commands-unusable-without-manifest.md fixes.
 * Without a manifest name, every subcommand used to match on
 * `plugin.manifest?.name`, which is `undefined`, so nothing installed that way
 * could ever be found again. Also checks the pre-existing manifest-name path
 * still works unchanged.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import os from 'node:os';
import { Database } from '@quereus/quereus';
import { handleDotCommand } from '../src/commands/dot-commands.js';
import { installRemotePluginResolver } from '../src/plugins/remote-resolver.js';
import type { Interface as ReadlineInterface } from 'node:readline';

const PLUGIN_SOURCE = 'export default function register() { return {}; }\n';

const MODULE_URL_NO_MANIFEST = 'https://plugins.example.test/dist/plain.mjs';
const MODULE_URL_WITH_MANIFEST = 'https://plugins.example.test/dist/named/plugin.mjs';
const MANIFEST_URL = new URL('package.json', MODULE_URL_WITH_MANIFEST).toString();

const readlineStub = {} as unknown as ReadlineInterface;

describe('.plugin subcommands', () => {
	let db: Database;
	let homeDir: string;
	let logSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(async () => {
		homeDir = await mkdtemp(join(tmpdir(), 'quoomb-cli-plugins-'));
		vi.spyOn(os, 'homedir').mockReturnValue(homeDir);

		db = new Database();
		logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		vi.stubGlobal('fetch', (async (input: unknown) => {
			const url = String(input);
			if (url === MODULE_URL_NO_MANIFEST || url === MODULE_URL_WITH_MANIFEST) {
				return new Response(PLUGIN_SOURCE, { status: 200, headers: { 'content-type': 'text/javascript' } });
			}
			if (url === MANIFEST_URL) {
				return new Response(JSON.stringify({ name: 'named-plugin', version: '1.0.0' }), {
					status: 200,
					headers: { 'content-type': 'application/json' },
				});
			}
			return new Response('not found', { status: 404 });
		}) as unknown as typeof fetch);
		installRemotePluginResolver();
	});

	afterEach(async () => {
		logSpy.mockRestore();
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
		await db.close();
		await rm(homeDir, { recursive: true, force: true });
	});

	const output = () => logSpy.mock.calls.flat().join('\n');

	it('installs, lists, disables, enables, reloads, configures and removes a manifest-less plugin by its derived name', async () => {
		await handleDotCommand(`.plugin install ${MODULE_URL_NO_MANIFEST}`, db, readlineStub);
		expect(output()).toContain('Successfully installed plugin: plain');
		expect(output()).not.toContain('Unknown');
		logSpy.mockClear();

		await handleDotCommand('.plugin list', db, readlineStub);
		expect(output()).toContain('plain');
		expect(output()).not.toContain('Unknown');
		logSpy.mockClear();

		await handleDotCommand('.plugin disable plain', db, readlineStub);
		expect(output()).toContain('Disabled plugin: plain');
		expect(output()).not.toContain('not found');
		logSpy.mockClear();

		await handleDotCommand('.plugin enable plain', db, readlineStub);
		expect(output()).toContain('Enabled plugin: plain');
		expect(output()).not.toContain('not found');
		logSpy.mockClear();

		await handleDotCommand('.plugin reload plain', db, readlineStub);
		expect(output()).toContain('Reloaded plugin: plain');
		expect(output()).not.toContain('not found');
		logSpy.mockClear();

		await handleDotCommand('.plugin config plain', db, readlineStub);
		expect(output()).not.toContain('not found');
		logSpy.mockClear();

		await handleDotCommand('.plugin remove plain', db, readlineStub);
		expect(output()).toContain('Removed plugin: plain');
		logSpy.mockClear();

		await handleDotCommand('.plugin list', db, readlineStub);
		expect(output()).toContain('No plugins installed');
	});

	it('still finds a plugin by its manifest name when package.json resolves', async () => {
		await handleDotCommand(`.plugin install ${MODULE_URL_WITH_MANIFEST}`, db, readlineStub);
		expect(output()).toContain('Successfully installed plugin: named-plugin');
		logSpy.mockClear();

		await handleDotCommand('.plugin disable named-plugin', db, readlineStub);
		expect(output()).toContain('Disabled plugin: named-plugin');
		logSpy.mockClear();

		await handleDotCommand('.plugin enable named-plugin', db, readlineStub);
		expect(output()).toContain('Enabled plugin: named-plugin');
	});
});
