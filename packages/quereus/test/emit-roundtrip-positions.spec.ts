/**
 * Deterministic, position-by-position reserved-word round-trip suite.
 *
 * The AST round-trip *property* test (`emit-roundtrip-property.spec.ts`) is
 * structurally blind to "reserved word used as an identifier": its `identArb`
 * generator deliberately avoids keywords via a hand-maintained denylist, so an
 * emit site that forgets `quoteIdentifier` slips through (this is exactly how
 * `release to` shipped broken — `to` leaked the denylist by accident).
 *
 * This suite closes that gap directly. For every identifier position in the SQL
 * surface it asserts two invariants, driving the reserved-word set straight off
 * the lexer `KEYWORDS` table so the suite can never drift from the lexer the way
 * the denylist did:
 *
 *   1. Reserved-word round-trip — an identifier whose name is a reserved word
 *      survives `parse(sql) → astToString → parse` with a structurally-equal AST
 *      (reuse `emit-roundtrip-comparator.ts`). The input uses the *quoted* form
 *      (`create table "select" (x integer)`) so it parses; the emitter must
 *      re-quote it or the re-parse fails / diverges.
 *
 *   2. No over-quoting — an ordinary, bare-valid name (`foo`) emits *without*
 *      quotes at that position, pinning `quoteIdentifier`'s "quote only when
 *      necessary" policy against a future always-quote regression.
 *
 * Templates are SQL strings with a single `{ID}` hole, so each case tests the
 * whole parse → emit → parse loop per site rather than hand-built ASTs.
 */

import { expect } from 'chai';
import { parse } from '../src/parser/index.js';
import { astToString } from '../src/emit/ast-stringify.js';
import { KEYWORDS } from '../src/parser/lexer.js';
import { assertAstEquivalent } from './emit-roundtrip-comparator.js';
import type { AstNode } from '../src/parser/ast.js';

/** Every reserved word, taken straight from the lexer so the suite can't drift. */
const RESERVED_WORDS = Object.keys(KEYWORDS);

/** A non-reserved, bare-valid identifier used for the no-over-quoting check. */
const ORDINARY = 'foo';

interface Position {
	label: string;
	/** SQL carrying exactly one `{ID}` identifier hole at the position under test. */
	template: string;
}

/**
 * Every place the emitter applies (or should apply) `quoteIdentifier`. Each
 * `{ID}` sits at a single identifier position; the surrounding SQL is the
 * minimal context the parser accepts.
 */
const POSITIONS: Position[] = [
	// --- table ---
	{ label: 'create table name', template: 'create table {ID} (x integer)' },
	{ label: 'create table schema-qualified name', template: 'create table {ID}.t (x integer)' },
	{ label: 'alter table target', template: 'alter table {ID} rename to t2' },
	{ label: 'alter table rename-to target', template: 'alter table t rename to {ID}' },
	{ label: 'alter table add column name', template: 'alter table t add column {ID} integer' },
	{ label: 'alter table rename column old name', template: 'alter table t rename column {ID} to b' },
	{ label: 'alter table rename column new name', template: 'alter table t rename column a to {ID}' },
	{ label: 'alter table drop column name', template: 'alter table t drop column {ID}' },
	{ label: 'alter table add constraint name', template: 'alter table t add constraint {ID} unique (a)' },
	{ label: 'alter table alter column name', template: 'alter table t alter column {ID} set not null' },
	{ label: 'alter table alter primary key column', template: 'alter table t alter primary key ({ID})' },
	{ label: 'drop table name', template: 'drop table {ID}' },
	{ label: 'insert target', template: 'insert into {ID} values (1)' },
	{ label: 'update target', template: 'update {ID} set x = 1' },
	{ label: 'delete target', template: 'delete from {ID}' },
	{ label: 'from source', template: 'select * from {ID}' },
	{ label: 'foreign key references table', template: 'create table t (a integer references {ID}(id))' },

	// --- column ---
	{ label: 'column definition name', template: 'create table t ({ID} integer)' },
	{ label: 'bare column reference', template: 'select {ID} from t' },
	{ label: 'qualified column reference (t.c)', template: 'select t.{ID} from t' },
	{ label: 'result column alias', template: 'select x as {ID} from t' },
	{ label: 'index column', template: 'create index i on t ({ID})' },
	{ label: 'foreign key child columns', template: 'create table t (a integer, foreign key ({ID}) references u(b))' },
	{ label: 'foreign key parent columns', template: 'create table t (a integer references u({ID}))' },
	{ label: 'group by term', template: 'select x from t group by {ID}' },
	{ label: 'order by term', template: 'select x from t order by {ID}' },
	{ label: 'partition by term', template: 'select row_number() over (partition by {ID}) from t' },
	{ label: 'using join columns', template: 'select * from t join u using ({ID})' },
	{ label: 'returning column', template: 'insert into t values (1) returning {ID}' },
	{ label: 'insert column list', template: 'insert into t ({ID}) values (1)' },
	{ label: 'update set column', template: 'update t set {ID} = 1' },
	{ label: 'upsert conflict target', template: 'insert into t values (1) on conflict ({ID}) do nothing' },
	{ label: 'upsert update-set column', template: 'insert into t (a) values (1) on conflict (a) do update set {ID} = 1' },
	{ label: 'insert with-context name', template: 'insert into t with context {ID} = 1 values (1)' },

	// --- alias ---
	{ label: 'table alias', template: 'select * from t as {ID}' },
	{ label: 'subquery-source alias', template: 'select * from (select 1) as {ID}' },
	{ label: 'subquery-source column alias', template: 'select * from (select 1) as s ({ID})' },

	// --- schema ---
	{ label: 'schema-qualified table (s.t)', template: 'select * from {ID}.t' },
	{ label: 'table within schema-qualified ref', template: 'select * from main.{ID}' },
	{ label: 'committed pseudo-schema table', template: 'select * from committed.{ID}' },
	{ label: 'schema-qualified column (s.t.c)', template: 'select {ID}.t.c from t' },
	{ label: 'declare schema name', template: 'declare schema {ID} { table t (a integer) }' },
	{ label: 'diff schema name', template: 'diff schema {ID}' },
	{ label: 'apply schema name', template: 'apply schema {ID}' },
	{ label: 'explain schema name', template: 'explain schema {ID}' },
	{ label: 'declare lens logical schema', template: 'declare lens for {ID} over base { view t as select 1 }' },
	{ label: 'declare lens basis schema', template: 'declare lens for logical over {ID} { view t as select 1 }' },
	{ label: 'declare lens override table', template: 'declare lens for logical over base { view {ID} as select 1 }' },

	// --- declare-schema items ---
	{ label: 'declared table name', template: 'declare schema main { table {ID} (a integer) }' },
	{ label: 'declared view name', template: 'declare schema main { view {ID} as select 1 }' },

	// --- index ---
	{ label: 'create index name', template: 'create index {ID} on t (a)' },
	{ label: 'drop index name', template: 'drop index {ID}' },

	// --- view / materialized view ---
	{ label: 'create view name', template: 'create view {ID} as select 1' },
	{ label: 'create view column list', template: 'create view v ({ID}) as select 1' },
	{ label: 'drop view name', template: 'drop view {ID}' },
	{ label: 'create materialized view name', template: 'create materialized view {ID} as select 1' },
	{ label: 'refresh materialized view name', template: 'refresh materialized view {ID}' },
	{ label: 'drop materialized view name', template: 'drop materialized view {ID}' },

	// --- assertion ---
	{ label: 'create assertion name', template: 'create assertion {ID} check (1 > 0)' },
	{ label: 'drop assertion name', template: 'drop assertion {ID}' },

	// --- savepoint (the `release to` regression class) ---
	{ label: 'savepoint name', template: 'savepoint {ID}' },
	{ label: 'release savepoint name', template: 'release {ID}' },
	{ label: 'rollback-to savepoint name', template: 'rollback to {ID}' },

	// --- CTE ---
	{ label: 'CTE name', template: 'with {ID} as (select 1) select 1' },
	{ label: 'CTE column list', template: 'with c ({ID}) as (select 1) select 1' },

	// --- collation ---
	{ label: 'collate expression', template: 'select x collate {ID} from t' },
	{ label: 'collate column constraint', template: 'create table t (a integer collate {ID})' },
	{ label: 'collate index column', template: 'create index i on t (a collate {ID})' },

	// --- pragma ---
	{ label: 'pragma name', template: 'pragma {ID} = 1' },

	// --- using <module> ---
	{ label: 'create table using module', template: 'create table t (a integer) using {ID}' },
	{ label: 'create materialized view using module', template: 'create materialized view v using {ID} as select 1' },

	// --- function ---
	{ label: 'scalar function name', template: 'select {ID}(x) from t' },
	{ label: 'table-valued function name', template: 'select * from {ID}(1)' },
];

/** Substitute every `{ID}` hole with `id`. */
function fill(template: string, id: string): string {
	return template.split('{ID}').join(id);
}

function errText(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

describe('Emit: reserved word survives every identifier emit position', function () {
	// Each `it` exercises one position across the full KEYWORDS table; a generous
	// timeout keeps the whole-table sweep safe under the slower store harness.
	this.timeout(30000);

	for (const pos of POSITIONS) {
		it(pos.label, () => {
			const failures: string[] = [];

			for (const kw of RESERVED_WORDS) {
				const input = fill(pos.template, `"${kw}"`);

				let ast1: AstNode;
				try {
					ast1 = parse(input);
				} catch (e) {
					// A quoted identifier tokenizes as IDENTIFIER, so any position that
					// rejects it here is a *parser* gap, not an emit bug — flag it.
					failures.push(`[${kw}] input failed to parse (parser gap): ${errText(e)}\n      sql: ${input}`);
					continue;
				}

				let emitted: string;
				try {
					emitted = astToString(ast1);
				} catch (e) {
					failures.push(`[${kw}] emit threw: ${errText(e)}\n      sql: ${input}`);
					continue;
				}

				let ast2: AstNode;
				try {
					ast2 = parse(emitted);
				} catch (e) {
					failures.push(`[${kw}] re-parse failed (emit forgot to quote?): ${errText(e)}\n      emitted: ${emitted}`);
					continue;
				}

				try {
					assertAstEquivalent(ast1, ast2);
				} catch (e) {
					failures.push(`[${kw}] round-trip AST mismatch: ${errText(e)}\n      sql: ${input}\n      emitted: ${emitted}`);
				}
			}

			expect(failures, `\n${failures.join('\n')}\n`).to.have.length(0);
		});
	}
});

describe('Emit: ordinary identifiers are never over-quoted', () => {
	for (const pos of POSITIONS) {
		it(pos.label, () => {
			const input = fill(pos.template, ORDINARY);
			const emitted = astToString(parse(input));
			expect(emitted, `ordinary name should be present in emitted SQL: ${emitted}`).to.include(ORDINARY);
			expect(emitted, `ordinary name should NOT be quoted in emitted SQL: ${emitted}`).to.not.include(`"${ORDINARY}"`);
		});
	}
});
