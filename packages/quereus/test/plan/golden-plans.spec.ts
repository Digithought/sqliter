/**
 * Golden plan tests for Quereus optimizer.
 * Captures the optimized plan structure of each `.sql` case as a committed JSON
 * snapshot for regression testing. See README.md for the file convention.
 */
import { describe, it } from 'mocha';
import { expect } from 'chai';
import { promises as fs, readdirSync } from 'fs';
import * as path from 'path';
import { Database } from '../../src/core/database.js';
import { serializePlanForGolden, withDeterministicPlanIds } from './_helpers.js';
import { fileURLToPath } from 'node:url';

// ESM equivalent for __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const UPDATE_PLANS = process.env.UPDATE_PLANS === 'true';

interface PlanTestCase {
	/** Test display name, e.g. `basic/simple-select`. */
	name: string;
	/** Absolute path to the `.sql` input. */
	sqlFile: string;
	/** Absolute path to the committed `.plan.json` golden. */
	goldenFile: string;
}

/**
 * Synchronously discover every `.sql` test case under test/plan/ (recursing into
 * `basic/`, `joins/`, `aggregates/`, …). Must be synchronous so the `it()`s can
 * be registered while the `describe` callback is still on the stack — Mocha
 * fixes a suite's test list when that callback returns, so tests added later
 * (e.g. from a `before` hook) attach to the suite but never run.
 */
function findTestCases(): PlanTestCase[] {
	const testCases: PlanTestCase[] = [];

	function scan(dir: string, prefix: string): void {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const fullPath = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				if (!entry.name.startsWith('.') && entry.name !== 'node_modules') {
					scan(fullPath, prefix + entry.name + '/');
				}
			} else if (entry.name.endsWith('.sql')) {
				const baseName = entry.name.slice(0, -4);
				testCases.push({
					name: prefix + baseName,
					sqlFile: fullPath,
					goldenFile: path.join(dir, baseName + '.plan.json'),
				});
			}
		}
	}

	scan(__dirname, '');
	return testCases;
}

async function readFileIfExists(filePath: string): Promise<string | undefined> {
	try {
		return await fs.readFile(filePath, 'utf-8');
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
		throw error;
	}
}

/** Normalize line endings so git autocrlf checkouts don't spuriously fail. */
function normalizeEol(text: string): string {
	return text.replace(/\r\n/g, '\n');
}

/**
 * Plan SQL against the standard test schema and serialize the optimized tree.
 * `getPlan()` already returns the optimized plan, so there is a single artifact
 * per case (see README for why logical-vs-physical is currently collapsed).
 */
async function getPlanSnapshot(sql: string): Promise<string> {
	// Reset the global id counters around the whole plan so snapshots are
	// byte-identical regardless of how many ids earlier specs allocated.
	return withDeterministicPlanIds(async () => {
		const db = new Database();
		try {
			await db.exec(`
				CREATE TABLE users (
					id INTEGER PRIMARY KEY,
					name TEXT NOT NULL,
					age INTEGER,
					dept_id INTEGER
				) USING memory();

				CREATE TABLE departments (
					id INTEGER PRIMARY KEY,
					name TEXT NOT NULL,
					budget REAL
				) USING memory();
			`);
			return serializePlanForGolden(db.getPlan(sql));
		} finally {
			await db.close();
		}
	});
}

async function writeGolden(filePath: string, content: string): Promise<void> {
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	await fs.writeFile(filePath, content);
}

describe('Golden Plan Tests', () => {
	const testCases = findTestCases();

	// Fail loudly rather than passing vacuously if the corpus is empty.
	it('discovers at least one golden plan test case', () => {
		expect(testCases.length, 'no .sql files found under test/plan/').to.be.greaterThan(0);
	});

	for (const testCase of testCases) {
		it(`should match golden plan for ${testCase.name}`, async function () {
			this.timeout(10000);

			const sql = await fs.readFile(testCase.sqlFile, 'utf-8');
			const actual = await getPlanSnapshot(sql);

			if (UPDATE_PLANS) {
				await writeGolden(testCase.goldenFile, actual);
				console.log(`Updated golden file for ${testCase.name}`);
				return;
			}

			const expected = await readFileIfExists(testCase.goldenFile);
			if (expected === undefined) {
				throw new Error(
					`Missing golden file for ${testCase.name}. ` +
					`Run with UPDATE_PLANS=true to generate it.`
				);
			}

			const actualEol = normalizeEol(actual);
			const expectedEol = normalizeEol(expected);
			if (actualEol !== expectedEol) {
				console.log(`\nPlan mismatch for ${testCase.name}`);
				console.log('Expected:\n' + expectedEol);
				console.log('Actual:\n' + actualEol);
			}
			expect(actualEol).to.equal(expectedEol);
		});
	}
});

/**
 * Utility to (re)generate golden files for a directory of SQL files.
 */
export async function generateGoldenFiles(sqlDir: string): Promise<void> {
	for (const entry of await fs.readdir(sqlDir, { withFileTypes: true })) {
		if (entry.isFile() && entry.name.endsWith('.sql')) {
			const baseName = entry.name.slice(0, -4);
			const sql = await fs.readFile(path.join(sqlDir, entry.name), 'utf-8');
			console.log(`Generating golden file for ${entry.name}`);
			await writeGolden(path.join(sqlDir, baseName + '.plan.json'), await getPlanSnapshot(sql));
		}
	}
}
