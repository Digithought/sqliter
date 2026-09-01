import { transpileQuereusAstToMermaidEr } from '../dist/src/qsql-to-mermaid.js';
import { ast } from './qsql-to-typeql.spec.js';

declare const describe: (title: string, fn: () => void) => void;
declare const it: (title: string, fn: () => void) => void;
declare const before: (fn: () => void) => void;

function assertOk(value: boolean, message?: string): void {
	if (!value) {
		throw new Error(message ?? 'Assertion failed');
	}
}

function assertEqual(actual: unknown, expected: unknown, message?: string): void {
	if (actual !== expected) {
		throw new Error(message ?? `Expected ${String(expected)} but received ${String(actual)}`);
	}
}

function assertMatch(value: string, pattern: RegExp, message?: string): void {
	if (!pattern.test(value)) {
		throw new Error(message ?? `Expected value to match ${pattern}`);
	}
}

describe('qsql-to-mermaid', () => {
	let mermaid: string;

	before(() => {
		mermaid = transpileQuereusAstToMermaidEr(ast);
		// console.log(mermaid);
	});

	describe('structure', () => {
		it('starts with erDiagram', () => {
			assertMatch(mermaid.trimStart(), /^erDiagram/);
		});

		it('contains an entity block for each table', () => {
			assertOk(mermaid.includes('  authority {'));
			assertOk(mermaid.includes('  network {'));
			assertOk(mermaid.includes('  admin {'));
			assertOk(mermaid.includes('  officer {'));
			assertOk(mermaid.includes('  user_key {'));
		});

		it('closes every entity block', () => {
			const opens = (mermaid.match(/\{$/gm) ?? []).length;
			const closes = (mermaid.match(/^\s+\}$/gm) ?? []).length;
			assertEqual(closes, opens);
		});
	});

	describe('primary keys', () => {
		it('marks single-column PK with PK annotation', () => {
			assertMatch(mermaid, /authority \{[\s\S]*?string id PK/);
			assertMatch(mermaid, /admin_signing \{[\s\S]*?string nonce PK/);
			assertMatch(mermaid, /invite_slot \{[\s\S]*?string cid PK/);
		});

		it('emits surrogate key with PK for composite or missing primary key', () => {
			assertOk(mermaid.includes('    string network_key PK'));
			assertOk(mermaid.includes('    string admin_key PK'));
			assertOk(mermaid.includes('    string officer_key PK'));
			assertOk(mermaid.includes('    string user_key_key PK'));
		});
	});

	describe('foreign keys', () => {
		it('marks FK columns with FK annotation', () => {
			assertMatch(mermaid, /admin \{[\s\S]*?string authority_id FK/);
			assertMatch(mermaid, /officer \{[\s\S]*?string authority_id FK/);
			assertMatch(mermaid, /officer \{[\s\S]*?string user_id FK/);
			assertMatch(mermaid, /user_key \{[\s\S]*?string user_id FK/);
		});
	});

	describe('type mapping', () => {
		it('maps integer columns to int', () => {
			assertOk(mermaid.includes('    int number_required_tsas'));
		});

		it('maps datetime columns to datetime', () => {
			assertMatch(mermaid, /admin \{[\s\S]*?datetime effective_at/);
		});

		it('maps boolean columns to boolean', () => {
			assertMatch(mermaid, /invite_result \{[\s\S]*?boolean is_accepted/);
		});

		it('maps text columns to string', () => {
			assertMatch(mermaid, /authority \{[\s\S]*?string name/);
		});
	});

	describe('relationships', () => {
		it('emits one-to-many line for admin → authority', () => {
			assertOk(mermaid.includes('  admin }o--|| authority : "admin_authority"'));
		});

		it('emits one-to-many line for officer → authority', () => {
			assertOk(mermaid.includes('  officer }o--|| authority : "officer_authority"'));
		});

		it('emits one-to-many line for officer → user', () => {
			assertOk(mermaid.includes('  officer }o--|| user : "officer_user"'));
		});

		it('emits one-to-many line for user_key → user', () => {
			assertOk(mermaid.includes('  user_key }o--|| user : "user_key_user"'));
		});
	});
});
