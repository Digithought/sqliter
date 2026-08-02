import { expect } from 'chai';
import { astToString } from '../src/emit/ast-stringify.js';
import { parse } from '../src/parser/index.js';
import type {
	AlterTableStmt,
	AlterViewStmt,
	AlterMaterializedViewStmt,
	AlterIndexStmt,
	AnalyzeStmt,
	CreateAssertionStmt,
	SubquerySource,
	IdentifierExpr,
	ColumnDef,
	TableConstraint,
	DeleteStmt,
	FromClause,
} from '../src/parser/ast.js';

// Helper to build an IdentifierExpr
function ident(name: string, schema?: string): IdentifierExpr {
	return { type: 'identifier', name, ...(schema ? { schema } : {}) };
}

describe('Emit: missing statement types', () => {

	describe('alterTable', () => {
		it('should stringify renameTable action', () => {
			const node: AlterTableStmt = {
				type: 'alterTable',
				table: ident('users'),
				action: { type: 'renameTable', newName: 'accounts' },
			};
			const result = astToString(node);
			// Currently falls through to default — should NOT be a placeholder
			expect(result).to.not.equal('[alterTable]');
			expect(result).to.include('alter table');
			expect(result).to.include('rename to');
		});

		it('should stringify renameColumn action', () => {
			const node: AlterTableStmt = {
				type: 'alterTable',
				table: ident('users'),
				action: { type: 'renameColumn', oldName: 'name', newName: 'full_name' },
			};
			const result = astToString(node);
			expect(result).to.not.equal('[alterTable]');
			expect(result).to.include('rename column');
		});

		it('should stringify addColumn action', () => {
			const col: ColumnDef = {
				name: 'email',
				dataType: 'text',
				constraints: [],
			};
			const node: AlterTableStmt = {
				type: 'alterTable',
				table: ident('users'),
				action: { type: 'addColumn', column: col },
			};
			const result = astToString(node);
			expect(result).to.not.equal('[alterTable]');
			expect(result).to.include('add column');
		});

		it('should stringify dropColumn action', () => {
			const node: AlterTableStmt = {
				type: 'alterTable',
				table: ident('users'),
				action: { type: 'dropColumn', name: 'legacy_field' },
			};
			const result = astToString(node);
			expect(result).to.not.equal('[alterTable]');
			expect(result).to.include('drop column');
		});

		it('should stringify addConstraint action', () => {
			const constraint: TableConstraint = {
				type: 'unique',
				columns: [{ name: 'email' }],
			};
			const node: AlterTableStmt = {
				type: 'alterTable',
				table: ident('users'),
				action: { type: 'addConstraint', constraint },
			};
			const result = astToString(node);
			expect(result).to.not.equal('[alterTable]');
			expect(result).to.include('add');
		});

		it('should stringify schema-qualified table', () => {
			const node: AlterTableStmt = {
				type: 'alterTable',
				table: ident('users', 'myschema'),
				action: { type: 'renameTable', newName: 'accounts' },
			};
			const result = astToString(node);
			expect(result).to.not.equal('[alterTable]');
			expect(result).to.include('myschema');
		});
	});

	describe('alterView / alterMaterializedView / alterIndex (SET TAGS)', () => {
		it('should stringify ALTER VIEW ... SET TAGS', () => {
			const node: AlterViewStmt = {
				type: 'alterView',
				name: ident('v'),
				action: { type: 'setTags', mode: 'replace', tags: { cacheable: true } },
			};
			const result = astToString(node);
			expect(result).to.equal(`alter view v set tags (cacheable = true)`);
		});

		it('should stringify ALTER MATERIALIZED VIEW ... SET TAGS', () => {
			const node: AlterMaterializedViewStmt = {
				type: 'alterMaterializedView',
				name: ident('mv'),
				action: { type: 'setTags', mode: 'replace', tags: { owner: 'analytics' } },
			};
			const result = astToString(node);
			expect(result).to.equal(`alter materialized view mv set tags (owner = 'analytics')`);
		});

		it('should stringify ALTER INDEX ... SET TAGS with the clear-all form', () => {
			const node: AlterIndexStmt = {
				type: 'alterIndex',
				name: ident('idx'),
				action: { type: 'setTags', mode: 'replace', tags: {} },
			};
			const result = astToString(node);
			expect(result).to.equal(`alter index idx set tags ()`);
		});

		it('should round-trip parse → stringify → parse for each kind (canonical SQL is stable)', () => {
			const cases = [
				`alter view v set tags (a = 1, b = 'x')`,
				`alter materialized view mv set tags (owner = 'analytics')`,
				`alter index idx set tags (purpose = 'search')`,
				`alter index idx set tags ()`,
			];
			for (const sql of cases) {
				const canonical = astToString(parse(sql));
				const reCanonical = astToString(parse(canonical));
				expect(reCanonical).to.equal(canonical, `round-trip mismatch for: ${sql}`);
			}
		});
	});

	describe('analyze', () => {
		it('should stringify bare analyze', () => {
			const node: AnalyzeStmt = { type: 'analyze' };
			const result = astToString(node);
			expect(result).to.not.equal('[analyze]');
			expect(result).to.equal('analyze');
		});

		it('should stringify analyze with table', () => {
			const node: AnalyzeStmt = { type: 'analyze', tableName: 'users' };
			const result = astToString(node);
			expect(result).to.not.equal('[analyze]');
			expect(result).to.include('users');
		});

		it('should stringify analyze with schema.table', () => {
			const node: AnalyzeStmt = { type: 'analyze', schemaName: 'main', tableName: 'users' };
			const result = astToString(node);
			expect(result).to.not.equal('[analyze]');
			expect(result).to.include('main');
			expect(result).to.include('users');
		});

		it('should stringify schema-only analyze as schema.* (round-trippable)', () => {
			const node: AnalyzeStmt = { type: 'analyze', schemaName: 'main' };
			const result = astToString(node);
			// Emits `analyze main.*` — the `.*` surface is what re-parses to the
			// schema-only shape (not `analyze main`, which would parse as a table).
			expect(result).to.not.equal('[analyze]');
			expect(result).to.include('main');
			expect(result).to.include('.*');
		});
	});

	describe('createAssertion', () => {
		it('should stringify create assertion', () => {
			const node: CreateAssertionStmt = {
				type: 'createAssertion',
				name: { type: 'identifier', name: 'positive_balance' },
				check: {
					type: 'binary',
					operator: '>',
					left: { type: 'column', name: 'balance' },
					right: { type: 'literal', value: 0 },
				},
			};
			const result = astToString(node);
			expect(result).to.not.equal('[createAssertion]');
			expect(result).to.include('create assertion');
			expect(result).to.include('positive_balance');
			expect(result).to.include('check');
		});
	});

	describe('mutating DML in subquerySource via fromClauseToString', () => {
		it('should stringify a DML body (DELETE w/ RETURNING) as a FROM subquery', () => {
			// The folded SubquerySource carries any QueryExpr in `subquery`,
			// including a DML statement with RETURNING. The emitter dispatches
			// on the inner discriminator so the body emits correctly.
			const deleteStmt: DeleteStmt = {
				type: 'delete',
				table: ident('old_logs'),
				returning: [{ type: 'all' }],
			};
			const mutSource: SubquerySource = {
				type: 'subquerySource',
				subquery: deleteStmt,
				alias: 'deleted',
			};
			const selectNode = {
				type: 'select' as const,
				columns: [{ type: 'all' as const }],
				from: [mutSource as unknown as FromClause],
			};
			const result = astToString(selectNode);
			expect(result).to.not.include('[unknown_from]');
			expect(result).to.include('deleted');
			expect(result).to.include('delete from');
			expect(result).to.include('returning');
		});
	});
});
