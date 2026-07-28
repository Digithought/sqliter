import { expect } from 'chai';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	SQLLOGIC_CAPABILITIES,
	parseRequiredCapabilities,
	missingCapability,
	MEMORY_BACKEND_CAPABILITIES,
	STORE_BACKEND_CAPABILITIES,
	type SqllogicCapability,
} from './logic-capabilities.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Mirror logic.spec.ts: when running from dist/test the corpus is two levels up.
const isInDist = __dirname.includes(path.join('dist', 'test'));
const projectRoot = isInDist ? path.resolve(__dirname, '..', '..') : path.resolve(__dirname, '..');
const logicTestDir = path.join(projectRoot, 'test', 'logic');

const INDEX_DDL: SqllogicCapability = 'standalone-index-ddl';

/** Sorted token array, for order-independent set comparison. */
function tokens(set: ReadonlySet<SqllogicCapability>): string[] {
	return [...set].sort();
}

describe('sqllogic capability directive', () => {
	describe('parseRequiredCapabilities', () => {
		it('returns an empty set when no directive is present', () => {
			const content = [
				'-- A file with a normal header and no directive.',
				'',
				'create table t (id integer primary key);',
				'-- run',
			].join('\n');
			expect(tokens(parseRequiredCapabilities('t.sqllogic', content))).to.deep.equal([]);
		});

		it('parses a single token', () => {
			const content = '-- requires-capability: standalone-index-ddl\n\nselect 1;\n';
			expect(tokens(parseRequiredCapabilities('t.sqllogic', content))).to.deep.equal([INDEX_DDL]);
		});

		it('parses a directive on the very first line with no preceding prose', () => {
			const content = '-- requires-capability: standalone-index-ddl\nselect 1;\n';
			expect(tokens(parseRequiredCapabilities('t.sqllogic', content))).to.deep.equal([INDEX_DDL]);
		});

		it('parses a directive on line 1 of a BOM-prefixed file', () => {
			const content = '\uFEFF-- requires-capability: standalone-index-ddl\nselect 1;\n';
			expect(tokens(parseRequiredCapabilities('t.sqllogic', content))).to.deep.equal([INDEX_DDL]);
		});

		it('accepts comma-separated, whitespace-separated, and repeated-line forms alike', () => {
			// Only one capability exists today, so exercise the separator forms by repeating it —
			// duplicates union, which is also the documented behavior.
			const comma = '-- requires-capability: standalone-index-ddl,standalone-index-ddl\nselect 1;\n';
			const space = '-- requires-capability: standalone-index-ddl standalone-index-ddl\nselect 1;\n';
			const repeated = [
				'-- requires-capability: standalone-index-ddl',
				'-- requires-capability: standalone-index-ddl',
				'',
				'select 1;',
			].join('\n');

			expect(tokens(parseRequiredCapabilities('t.sqllogic', comma))).to.deep.equal([INDEX_DDL]);
			expect(tokens(parseRequiredCapabilities('t.sqllogic', space))).to.deep.equal([INDEX_DDL]);
			expect(tokens(parseRequiredCapabilities('t.sqllogic', repeated))).to.deep.equal([INDEX_DDL]);
		});

		it('matches the directive name case-insensitively and lowercases tokens', () => {
			const content = '-- Requires-Capability: STANDALONE-INDEX-DDL\nselect 1;\n';
			expect(tokens(parseRequiredCapabilities('t.sqllogic', content))).to.deep.equal([INDEX_DDL]);
		});

		it('parses CRLF content', () => {
			const content = '-- header\r\n-- requires-capability: standalone-index-ddl\r\n\r\nselect 1;\r\n';
			expect(tokens(parseRequiredCapabilities('t.sqllogic', content))).to.deep.equal([INDEX_DDL]);
		});

		it('treats blank lines inside the leading comment block as non-terminating', () => {
			const content = [
				'-- Prose header.',
				'',
				'-- More prose after a blank line.',
				'',
				'-- requires-capability: standalone-index-ddl',
				'',
				'select 1;',
			].join('\n');
			expect(tokens(parseRequiredCapabilities('t.sqllogic', content))).to.deep.equal([INDEX_DDL]);
		});

		it('leaves -- error:, -- params: and -- run markers alone', () => {
			const content = [
				'-- requires-capability: standalone-index-ddl',
				'',
				'create table t (id integer primary key);',
				'-- run',
				'select * from t where id = ?;',
				'-- params: [1]',
				'insert into t values (1);',
				'-- error: UNIQUE constraint failed',
			].join('\n');
			expect(tokens(parseRequiredCapabilities('t.sqllogic', content))).to.deep.equal([INDEX_DDL]);
		});

		it('throws on an unknown token, naming the token and the vocabulary', () => {
			const content = '-- requires-capability: frobnicate\nselect 1;\n';
			const parse = () => parseRequiredCapabilities('bad.sqllogic', content);
			expect(parse).to.throw(/frobnicate/);
			expect(parse).to.throw(/standalone-index-ddl/);
			expect(parse).to.throw(/bad\.sqllogic/);
		});

		it('throws on a directive with no tokens', () => {
			const content = '-- requires-capability:\nselect 1;\n';
			expect(() => parseRequiredCapabilities('bad.sqllogic', content)).to.throw(/no tokens/i);
		});

		it('throws on a trailing comment after the tokens', () => {
			// Documented: no trailing comment on a directive line — the whole remainder is tokens.
			const content = '-- requires-capability: standalone-index-ddl -- why\nselect 1;\n';
			expect(() => parseRequiredCapabilities('bad.sqllogic', content)).to.throw(/unknown capability/i);
		});

		for (const nearMiss of ['-- require-capability:', '-- requires_capability:', '-- requires capability:']) {
			it(`throws on the near-miss spelling "${nearMiss}"`, () => {
				const content = `${nearMiss} standalone-index-ddl\nselect 1;\n`;
				expect(() => parseRequiredCapabilities('bad.sqllogic', content))
					.to.throw(/canonical form/i);
			});
		}

		it('throws on a near-miss appearing after the first SQL line', () => {
			const content = 'select 1;\n-- requires_capability: standalone-index-ddl\n';
			expect(() => parseRequiredCapabilities('bad.sqllogic', content)).to.throw(/canonical form/i);
		});

		it('throws when a canonical directive appears after the first SQL line', () => {
			const content = 'select 1;\n-- requires-capability: standalone-index-ddl\n';
			expect(() => parseRequiredCapabilities('bad.sqllogic', content))
				.to.throw(/leading comment block/i);
		});

		it('accepts a directive with no space after the comment marker', () => {
			const content = '--requires-capability:standalone-index-ddl\nselect 1;\n';
			expect(tokens(parseRequiredCapabilities('t.sqllogic', content))).to.deep.equal([INDEX_DDL]);
		});

		it('tolerates redundant separators around the tokens', () => {
			const content = '-- requires-capability:  ,standalone-index-ddl,\t\nselect 1;\n';
			expect(tokens(parseRequiredCapabilities('t.sqllogic', content))).to.deep.equal([INDEX_DDL]);
		});

		it('returns an empty set for an empty file and for a comment-only file', () => {
			expect(tokens(parseRequiredCapabilities('t.sqllogic', ''))).to.deep.equal([]);
			expect(tokens(parseRequiredCapabilities('t.sqllogic', '-- just prose.\n\n-- more prose.\n')))
				.to.deep.equal([]);
		});

		it('names the offending line number in the error', () => {
			const content = '-- header\n-- more header\n-- requires-capability: frobnicate\nselect 1;\n';
			expect(() => parseRequiredCapabilities('bad.sqllogic', content)).to.throw(/bad\.sqllogic:3/);
		});
	});

	describe('missingCapability', () => {
		it('returns the token when the backend set is empty', () => {
			const required = new Set<SqllogicCapability>([INDEX_DDL]);
			expect(missingCapability(required, new Set())).to.equal(INDEX_DDL);
		});

		it('returns undefined when the backend set is full', () => {
			const required = new Set<SqllogicCapability>([INDEX_DDL]);
			expect(missingCapability(required, MEMORY_BACKEND_CAPABILITIES)).to.be.undefined;
			expect(missingCapability(required, STORE_BACKEND_CAPABILITIES)).to.be.undefined;
		});

		it('returns undefined for an empty required set against an empty backend set', () => {
			expect(missingCapability(new Set(), new Set())).to.be.undefined;
		});
	});

	describe('backend capability sets', () => {
		it('cover the whole vocabulary, so quereus itself skips nothing', () => {
			const all = Object.keys(SQLLOGIC_CAPABILITIES).sort();
			expect(tokens(MEMORY_BACKEND_CAPABILITIES)).to.deep.equal(all);
			expect(tokens(STORE_BACKEND_CAPABILITIES)).to.deep.equal(all);
		});
	});

	describe('the real corpus', () => {
		const files = fs.readdirSync(logicTestDir).filter(f => f.endsWith('.sqllogic'));

		it('has files to check', () => {
			expect(files.length).to.be.greaterThan(0);
		});

		// The guard that catches a typo'd directive added months from now.
		it('parses every .sqllogic file without error', () => {
			for (const file of files) {
				const content = fs.readFileSync(path.join(logicTestDir, file), 'utf-8');
				expect(() => parseRequiredCapabilities(file, content), `parsing ${file}`).to.not.throw();
			}
		});

		it('returns an empty set for every file that does not mention the directive', () => {
			// Zero behavior change for the un-annotated bulk of the corpus. A regression here
			// would skip or fail files wholesale. The count of annotated files is expected to
			// grow, so assert only that unannotated files exist — never a magic threshold.
			const unannotated = files.filter(
				file => !/requires-capability/i.test(fs.readFileSync(path.join(logicTestDir, file), 'utf-8')),
			);
			expect(unannotated.length, 'corpus should still contain unannotated files').to.be.greaterThan(0);

			for (const file of unannotated) {
				const content = fs.readFileSync(path.join(logicTestDir, file), 'utf-8');
				expect([...parseRequiredCapabilities(file, content)], `for ${file}`).to.deep.equal([]);
			}
		});

		// Pins the corpus to the mechanism: quereus's own backends produce no skips, so without
		// this a broken directive on the one annotated file would go unnoticed locally.
		it('skips 10.1.2-ddl-in-transaction.sqllogic on a backend without standalone index DDL', () => {
			const file = '10.1.2-ddl-in-transaction.sqllogic';
			const content = fs.readFileSync(path.join(logicTestDir, file), 'utf-8');
			const required = parseRequiredCapabilities(file, content);

			expect([...required]).to.include(INDEX_DDL);
			expect(missingCapability(required, new Set())).to.equal(INDEX_DDL);
			expect(missingCapability(required, MEMORY_BACKEND_CAPABILITIES)).to.be.undefined;
		});

		// Pins the corpus-sweep ticket's result: files whose *subject* is index DDL (not
		// merely a scenario that reaches for an index) carry the directive. A regression here
		// means the sweep's annotations were lost or a file was renamed without updating them.
		it('declares standalone-index-ddl on every file whose subject is index DDL', () => {
			const subjectFiles = [
				'06.3-schema.sqllogic',
				'06.9.3-json-index-range-seek.sqllogic',
				'10.1.3-ddl-drop-in-transaction.sqllogic',
				'10.5-indexes.sqllogic',
				'10.5.1-partial-indexes.sqllogic',
				'10.5.2-expression-indexes.sqllogic',
				'10.5.3-desc-index-ordering.sqllogic',
				'10.5.4-composite-pk-index-update-phantom.sqllogic',
				'10.5.5-index-name-uniqueness.sqllogic',
				'47.3.1-upsert-conflict-index-derived-collation.sqllogic',
				'drop-unique-index.sqllogic',
			];

			for (const file of subjectFiles) {
				// Named explicitly: a rename would otherwise surface as a bare ENOENT.
				expect(files, `${file} was renamed or removed; update this list`).to.include(file);

				const content = fs.readFileSync(path.join(logicTestDir, file), 'utf-8');
				const required = parseRequiredCapabilities(file, content);
				expect([...required], `${file} should declare standalone-index-ddl`).to.include(INDEX_DDL);
			}
		});
	});
});
