/**
 * Smoke test for DotCommands — the CLI's real logic beyond argv wrapping:
 * table listing/schema dump, and the CSV import path's column-type inference
 * (packages/quoomb-cli/src/commands/dot-commands.ts). Not exhaustive; guards
 * against the dispatch and import path silently breaking.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from '@quereus/quereus';
import { DotCommands } from '../src/commands/dot-commands.js';

describe('DotCommands smoke', () => {
	let db: Database;
	let dotCommands: DotCommands;
	let logSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		db = new Database();
		dotCommands = new DotCommands(db);
		logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
	});

	afterEach(async () => {
		logSpy.mockRestore();
		await db.close();
	});

	it('lists tables created via SQL', async () => {
		await db.exec('create table foo (id integer, name text)');
		await dotCommands.listTables();
		const output = logSpy.mock.calls.flat().join('\n');
		expect(output).toContain('foo');
	});

	it('shows schema and columns for a specific table', async () => {
		await db.exec('create table bar (id integer primary key, label text)');
		await dotCommands.showSchema('bar');
		const output = logSpy.mock.calls.flat().join('\n');
		expect(output).toContain('bar');
		expect(output).toContain('label');
	});

	it('dumps all table DDL without the built-in function signatures', async () => {
		await db.exec('create table qux (id integer primary key, note text)');
		await dotCommands.showSchema();
		const output = logSpy.mock.calls.flat().join('\n');
		expect(output).toContain('qux');
		// schema() emits a row per built-in function; `.schema` must exclude them.
		expect(output).not.toContain('FUNCTION');
	});

	it('imports a CSV file, inferring column types and preserving row values', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'quoomb-cli-import-'));
		const csvPath = join(dir, 'people.csv');
		await writeFile(csvPath, 'id,name,age\n1,Alice,30\n2,Bob,25\n', 'utf-8');

		try {
			await dotCommands.importCsv(csvPath);

			const rows: Record<string, unknown>[] = [];
			for await (const row of db.eval('select id, name, age from people order by id')) {
				rows.push(row);
			}

			expect(rows).toEqual([
				{ id: 1, name: 'Alice', age: 30 },
				{ id: 2, name: 'Bob', age: 25 },
			]);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it('exports query results to a JSON file', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'quoomb-cli-export-'));
		const outPath = join(dir, 'out.json');
		await db.exec("create table baz (id integer, name text)");
		await db.exec("insert into baz values (1, 'Alice')");

		try {
			await dotCommands.exportQuery('select * from baz', outPath);
			const written = JSON.parse(await readFile(outPath, 'utf-8'));
			expect(written).toEqual([{ id: 1, name: 'Alice' }]);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
