/**
 * `ColumnSchema.declaredType` — the raw DDL type token (e.g. 'BIGINT', 'GEOMETRY')
 * carried forward alongside the flattened `logicalType` (see schema/column.ts).
 * `inferType` flattens BIGINT onto the shared INTEGER_TYPE (same object as plain
 * INTEGER) and an unregistered token with no affinity keyword (e.g. GEOMETRY) onto
 * BLOB_TYPE, erasing the distinction a host consuming the projected TableSchema
 * (not the CREATE TABLE AST) may still need; `declaredType` preserves it
 * regardless of where `logicalType` lands.
 */

import { expect } from 'chai';
import { parse } from '../src/parser/index.js';
import { columnDefToSchema } from '../src/schema/table.js';
import type { CreateTableStmt } from '../src/parser/ast.js';

function columnDef(sql: string, columnName: string) {
	const stmt = parse(sql) as CreateTableStmt;
	expect(stmt.type).to.equal('createTable');
	const col = stmt.columns.find(c => c.name === columnName);
	if (!col) throw new Error(`column ${columnName} not found`);
	return col;
}

describe('ColumnSchema.declaredType', () => {
	it('preserves BIGINT verbatim while logicalType flattens to INTEGER', () => {
		const schema = columnDefToSchema(columnDef('create table t (id BIGINT)', 'id'));
		expect(schema.declaredType).to.equal('BIGINT');
		expect(schema.logicalType.name).to.equal('INTEGER');
	});

	it('preserves TIMESTAMP verbatim; logicalType resolves to the registered TIMESTAMP type', () => {
		const schema = columnDefToSchema(columnDef('create table t (created TIMESTAMP)', 'created'));
		expect(schema.declaredType).to.equal('TIMESTAMP');
		expect(schema.logicalType.name).to.equal('TIMESTAMP');
	});

	it('preserves an unregistered token (GEOMETRY) verbatim while logicalType falls back to BLOB (no registry entry, no affinity keyword)', () => {
		const schema = columnDefToSchema(columnDef('create table t (shape GEOMETRY)', 'shape'));
		expect(schema.declaredType).to.equal('GEOMETRY');
		expect(schema.logicalType.name).to.equal('BLOB');
	});

	it('leaves declaredType undefined when no type is declared', () => {
		const schema = columnDefToSchema(columnDef('create table t (id)', 'id'));
		expect(schema.declaredType).to.be.undefined;
	});
});
