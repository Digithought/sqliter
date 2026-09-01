/**
 * ALTER-conformance matrix — the "no silent divergence" contract.
 *
 * The hard rule (docs/module-authoring-schema-changes.md § "Schema Changes"): a
 * `VirtualTableModule` that cannot honor an invoked `alterTable` arm MUST throw
 * `QuereusError` with a sited message — never silently no-op. A statement that
 * "succeeds but changes nothing" is the divergence signature this suite forbids
 * (it is how the store PK-collation gap escaped review: a real mandate quietly
 * became a schema-only update).
 *
 * Each (module × arm) cell must resolve to exactly one of:
 *   - **honored** — the ALTER applies AND a post-ALTER read-back proves the
 *     change is in force (a `table_info` probe or a behavioral probe), OR
 *   - **clean reject** — a `QuereusError` whose `code` is one of the arm's
 *     declared codes (`UNSUPPORTED`, or the data-dependent `CONSTRAINT` /
 *     `MISMATCH`) with a non-empty, table/column-sited message.
 *
 * The forbidden third outcome — "did not throw, but the change never took
 * effect" — is caught by running the honored arm's `confirm` read-back AFTER a
 * non-throwing ALTER: if the ALTER silently no-op'd, `confirm` fails.
 *
 * This file covers the **memory** module (engine-native) and a stub module that
 * omits `alterTable` entirely (asserting the engine's sited `UNSUPPORTED`). The
 * store leg lives in `@quereus/store`'s test suite and the isolation-wrapped
 * memory leg in `@quereus/isolation`'s — `@quereus/quereus` cannot depend on
 * either (they depend on it), so the matrix is split across the three packages
 * by necessity (see each leg's spec header).
 */

import { expect } from 'chai';
import { Database } from '../src/index.js';
import { QuereusError } from '../src/common/errors.js';
import { StatusCode, type SqlValue } from '../src/common/types.js';
import { generateTableDDL } from '../src/schema/ddl-generator.js';
import { makeNoAlterModule } from './no-alter-module.js';

// ── Outcome contract ────────────────────────────────────────────────────────

type Expectation =
	| { kind: 'honored' }
	| { kind: 'reject'; codes: StatusCode[]; site?: RegExp };

/**
 * One conformance arm: the seed SQL (parameterized by the `using` clause so the
 * same arm runs against any module), the ALTER under test, its expected outcome,
 * and a read-back probe that proves the post-state. For an honored arm `confirm`
 * asserts the change is in force (failing on a silent no-op); for a reject arm it
 * asserts the table is unchanged.
 *
 * `stubUnsupported` marks arms that surface the engine's sited `UNSUPPORTED`
 * when `module.alterTable` is absent — i.e. arms with NO engine-side fallback.
 * Exempt (false): ADD CHECK routes through the module when present but keeps an
 * engine-side fallback for modules without `alterTable`; ALTER PRIMARY KEY has a rebuild
 * fallback; RENAME COLUMN degrades to a documented engine-side schema-only
 * rename. The memory leg runs every arm regardless; this flag only gates the
 * no-`alterTable` stub leg.
 */
interface Arm {
	label: string;
	seed: (using: string) => string[];
	alter: string;
	memory: Expectation;
	stubUnsupported: boolean;
	confirm: (db: Database, outcome: 'honored' | 'rejected') => Promise<void>;
}

// ── Read-back helpers (the teeth: prove the change actually took effect) ──────

async function rows(db: Database, sql: string, params?: SqlValue[]): Promise<Record<string, SqlValue>[]> {
	const out: Record<string, SqlValue>[] = [];
	for await (const r of db.eval(sql, params)) out.push(r);
	return out;
}

async function columnNames(db: Database, table = 't'): Promise<string[]> {
	return (await rows(db, `select name from table_info('${table}') order by cid`)).map(r => String(r.name));
}

async function columnInfo(db: Database, column: string, table = 't'): Promise<Record<string, SqlValue> | undefined> {
	const all = await rows(db, `select name, type, notnull, pk, collation, dflt_value from table_info('${table}')`);
	return all.find(r => String(r.name).toLowerCase() === column.toLowerCase());
}

async function pkColumns(db: Database, table = 't'): Promise<string[]> {
	return (await rows(db, `select name from table_info('${table}') where pk > 0 order by pk`)).map(r => String(r.name));
}

/**
 * Asserts the two records of a table's key agree: the authoritative
 * `primaryKeyDefinition` and the per-column `primaryKey` / `pkOrder` flags (a
 * CREATE-time mirror feeding the planner's uniqueness hints and the `ColumnDef` AST
 * that RENAME COLUMN reconstructs). ALTER PRIMARY KEY is the only operation that can
 * break the agreement — each producer must rebuild both, via `rekeySchemaPrimaryKey`.
 */
function expectKeyFlagsAgreeWithDefinition(db: Database, table = 't'): void {
	const schema = db.schemaManager.findTable(table)!;
	const expected = schema.columns.map((_, i) => {
		const pos = schema.primaryKeyDefinition.findIndex(pk => pk.index === i);
		return { primaryKey: pos >= 0, pkOrder: pos >= 0 ? pos + 1 : 0 };
	});
	const actual = schema.columns.map(c => ({ primaryKey: c.primaryKey, pkOrder: c.pkOrder }));
	expect(actual, `per-column PK flags must mirror primaryKeyDefinition on '${table}'`).to.deep.equal(expected);
}

/** Runs an ALTER, returning the thrown QuereusError or null. Re-throws non-Quereus errors (a crash is not a clean reject). */
async function attemptAlter(db: Database, sql: string): Promise<QuereusError | null> {
	try {
		await db.exec(sql);
		return null;
	} catch (e) {
		if (e instanceof QuereusError) return e;
		throw e;
	}
}

/** Asserts the given DML throws a CONSTRAINT (used by `confirm` to prove forward enforcement is live). */
async function expectConstraint(db: Database, sql: string, label: string): Promise<void> {
	const err = await attemptAlter(db, sql);
	expect(err, `${label}: expected forward enforcement to reject "${sql}"`).to.be.instanceOf(QuereusError);
	expect(err!.code, `${label}: enforcement error code`).to.equal(StatusCode.CONSTRAINT);
}

// ── The matrix ───────────────────────────────────────────────────────────────

const ARMS: Arm[] = [
	{
		label: 'addColumn (nullable)',
		seed: u => [`create table t (id integer primary key, name text)${u}`, `insert into t values (1, 'a'), (2, 'b')`],
		alter: `alter table t add column note text null`,
		memory: { kind: 'honored' },
		stubUnsupported: true,
		confirm: async (db, outcome) => {
			const names = await columnNames(db);
			if (outcome === 'honored') {
				expect(names, 'new column present').to.include('note');
				const r = await rows(db, `select note from t where id = 1`);
				expect(r[0].note, 'existing row backfilled NULL').to.equal(null);
			} else {
				expect(names, 'table unchanged on reject').to.not.include('note');
			}
		},
	},
	{
		label: 'addColumn (with literal DEFAULT)',
		seed: u => [`create table t (id integer primary key, name text)${u}`, `insert into t values (1, 'a'), (2, 'b')`],
		alter: `alter table t add column qty integer default 7`,
		memory: { kind: 'honored' },
		stubUnsupported: true,
		confirm: async (db, outcome) => {
			if (outcome === 'honored') {
				const r = await rows(db, `select qty from t order by id`);
				expect(r.map(x => x.qty), 'existing rows backfilled with DEFAULT').to.deep.equal([7, 7]);
			} else {
				expect(await columnNames(db), 'table unchanged on reject').to.not.include('qty');
			}
		},
	},
	{
		label: 'addColumn NOT NULL, no DEFAULT, non-empty → CONSTRAINT',
		seed: u => [`create table t (id integer primary key, name text)${u}`, `insert into t values (1, 'a'), (2, 'b')`],
		alter: `alter table t add column req text not null`,
		memory: { kind: 'reject', codes: [StatusCode.CONSTRAINT], site: /\breq\b|not null/i },
		stubUnsupported: true,
		confirm: async (db) => {
			expect(await columnNames(db), 'rejected add leaves the column absent').to.not.include('req');
		},
	},
	{
		label: 'dropColumn',
		seed: u => [`create table t (id integer primary key, name text, extra text)${u}`, `insert into t values (1, 'a', 'x'), (2, 'b', 'y')`],
		alter: `alter table t drop column extra`,
		memory: { kind: 'honored' },
		stubUnsupported: true,
		confirm: async (db, outcome) => {
			const names = await columnNames(db);
			if (outcome === 'honored') expect(names, 'dropped column gone').to.not.include('extra');
			else expect(names, 'table unchanged on reject').to.include('extra');
		},
	},
	{
		label: 'renameColumn',
		seed: u => [`create table t (id integer primary key, name text)${u}`, `insert into t values (1, 'a'), (2, 'b')`],
		alter: `alter table t rename column name to title`,
		memory: { kind: 'honored' },
		stubUnsupported: false, // engine degrades RENAME COLUMN to a schema-only rename when alterTable is absent
		confirm: async (db, outcome) => {
			const names = await columnNames(db);
			if (outcome === 'honored') {
				expect(names, 'new name present').to.include('title');
				expect(names, 'old name gone').to.not.include('name');
				const r = await rows(db, `select title from t where id = 1`);
				expect(r[0].title, 'data preserved under new name').to.equal('a');
			} else {
				expect(names, 'table unchanged on reject').to.include('name');
			}
		},
	},
	{
		// Memory honors this natively (in-place re-key of its trees, indexes and pending layers).
		label: 'alterPrimaryKey',
		seed: u => [`create table t (id integer primary key, code integer not null)${u}`, `insert into t values (1, 100), (2, 200)`],
		alter: `alter table t alter primary key (code)`,
		memory: { kind: 'honored' },
		// A module with no `alterTable` AND no `renameTable` cannot take the shadow-rebuild
		// fallback either — the rebuild ends in a RENAME the module would never hear about — so
		// the engine refuses with a sited UNSUPPORTED. The rebuild leg is covered separately
		// below, with a stub that keeps `renameTable`.
		stubUnsupported: true,
		confirm: async (db, outcome) => {
			if (outcome === 'honored') {
				expect(await pkColumns(db), 'PK re-keyed to code').to.deep.equal(['code']);
				const r = await rows(db, `select id from t where code = 100`);
				expect(r[0]?.id, 'point lookup under new PK').to.equal(1);
			} else {
				expect(await pkColumns(db), 'PK unchanged on reject').to.deep.equal(['id']);
			}
			// Both legs of this arm (memory's native re-key and the refused no-hook stub) must
			// leave the per-column flags mirroring the definition, honored or rejected.
			expectKeyFlagsAgreeWithDefinition(db);
		},
	},
	{
		label: 'addConstraint UNIQUE',
		seed: u => [`create table t (id integer primary key, email text)${u}`, `insert into t values (1, 'a@x'), (2, 'b@x')`],
		alter: `alter table t add constraint u_email unique (email)`,
		memory: { kind: 'honored' },
		stubUnsupported: true,
		confirm: async (db, outcome) => {
			if (outcome === 'honored') await expectConstraint(db, `insert into t values (3, 'a@x')`, 'UNIQUE');
			else await db.exec(`insert into t values (3, 'a@x')`); // not enforced → no throw
		},
	},
	{
		label: 'addConstraint FOREIGN KEY',
		seed: u => [
			`pragma foreign_keys = true`,
			`create table parent (pid integer primary key)${u}`,
			`insert into parent values (1), (2)`,
			`create table t (id integer primary key, pa integer)${u}`,
			`insert into t values (1, 1), (2, 2)`,
		],
		alter: `alter table t add constraint fk_pa foreign key (pa) references parent(pid)`,
		memory: { kind: 'honored' },
		stubUnsupported: true,
		confirm: async (db, outcome) => {
			if (outcome === 'honored') await expectConstraint(db, `insert into t values (3, 99)`, 'FK');
			else await db.exec(`insert into t values (3, 99)`); // not enforced
		},
	},
	{
		// ADD CHECK routes through module.alterTable when the module supports it (so the
		// module-cached schema stays in lock-step with the catalog for later DROP/RENAME),
		// and falls back to the engine emitter (runtime/emit/add-constraint.ts) for modules
		// that omit alterTable — so it is honored for EVERY module, memory and store alike.
		// Hence `stubUnsupported: false` (the engine-side fallback covers the stub case).
		label: 'addConstraint CHECK',
		seed: u => [`create table t (id integer primary key, v integer)${u}`, `insert into t values (1, 5), (2, 9)`],
		alter: `alter table t add constraint pos check (v > 0)`,
		memory: { kind: 'honored' },
		stubUnsupported: false,
		confirm: async (db, outcome) => {
			if (outcome === 'honored') await expectConstraint(db, `insert into t values (3, -1)`, 'CHECK');
			else await db.exec(`insert into t values (3, -1)`);
		},
	},
	{
		label: 'dropConstraint',
		seed: u => [
			`create table t (id integer primary key, email text, constraint u_email unique (email))${u}`,
			`insert into t values (1, 'a@x'), (2, 'b@x')`,
		],
		alter: `alter table t drop constraint u_email`,
		memory: { kind: 'honored' },
		stubUnsupported: true,
		confirm: async (db, outcome) => {
			if (outcome === 'honored') {
				await db.exec(`insert into t values (3, 'a@x')`); // dup now allowed
				const cnt = await rows(db, `select count(*) as c from t where email = 'a@x'`);
				expect(cnt[0].c, 'UNIQUE no longer enforced after drop').to.equal(2);
			} else {
				await expectConstraint(db, `insert into t values (3, 'a@x')`, 'dropConstraint-unchanged');
			}
		},
	},
	{
		label: 'renameConstraint',
		seed: u => [
			`create table t (id integer primary key, email text, constraint u_email unique (email))${u}`,
			`insert into t values (1, 'a@x'), (2, 'b@x')`,
		],
		alter: `alter table t rename constraint u_email to u2`,
		memory: { kind: 'honored' },
		stubUnsupported: true,
		confirm: async (db, outcome) => {
			const names = (await rows(db, `select name from unique_constraint_info('t')`)).map(r => String(r.name));
			if (outcome === 'honored') {
				expect(names, 'constraint addressable under new name').to.include('u2');
				expect(names, 'old name gone').to.not.include('u_email');
			} else {
				expect(names, 'name unchanged on reject').to.include('u_email');
			}
		},
	},
	{
		label: 'alterColumn SET NOT NULL (data conforms)',
		seed: u => [`create table t (id integer primary key, v integer null)${u}`, `insert into t values (1, 5), (2, 9)`],
		alter: `alter table t alter column v set not null`,
		memory: { kind: 'honored' },
		stubUnsupported: true,
		confirm: async (db, outcome) => {
			const info = await columnInfo(db, 'v');
			if (outcome === 'honored') {
				expect(info?.notnull, 'column tightened to NOT NULL').to.equal(1);
				await expectConstraint(db, `insert into t values (3, null)`, 'SET NOT NULL');
			} else {
				expect(info?.notnull, 'nullability unchanged on reject').to.equal(0);
			}
		},
	},
	{
		label: 'alterColumn SET NOT NULL (existing NULL) → CONSTRAINT',
		seed: u => [`create table t (id integer primary key, v integer null)${u}`, `insert into t values (1, null), (2, 9)`],
		alter: `alter table t alter column v set not null`,
		memory: { kind: 'reject', codes: [StatusCode.CONSTRAINT], site: /\bv\b|not null/i },
		stubUnsupported: true,
		confirm: async (db) => {
			const info = await columnInfo(db, 'v');
			expect(info?.notnull, 'nullability unchanged after rejected tighten').to.equal(0);
		},
	},
	{
		label: 'alterColumn DROP NOT NULL',
		seed: u => [`create table t (id integer primary key, v integer not null)${u}`, `insert into t values (1, 5)`],
		alter: `alter table t alter column v drop not null`,
		memory: { kind: 'honored' },
		stubUnsupported: true,
		confirm: async (db, outcome) => {
			const info = await columnInfo(db, 'v');
			if (outcome === 'honored') {
				expect(info?.notnull, 'column relaxed to nullable').to.equal(0);
				await db.exec(`insert into t values (3, null)`); // now permitted
			} else {
				expect(info?.notnull, 'nullability unchanged on reject').to.equal(1);
			}
		},
	},
	{
		label: 'alterColumn SET DATA TYPE (lossy) → MISMATCH',
		seed: u => [`create table t (id integer primary key, v text)${u}`, `insert into t values (1, 'abc'), (2, 'xyz')`],
		alter: `alter table t alter column v set data type integer`,
		memory: { kind: 'reject', codes: [StatusCode.MISMATCH], site: /\bv\b|convert/i },
		stubUnsupported: true,
		confirm: async (db) => {
			const info = await columnInfo(db, 'v');
			expect(String(info?.type).toLowerCase(), 'type unchanged after lossy reject').to.contain('text');
		},
	},
	{
		// Same physical storage class (both TEXT), so nothing is rewritten — but TIMESPAN ranks by
		// elapsed time, so the index over `v` has to be re-keyed. An honored-but-not-re-keyed ALTER
		// is exactly the silent divergence this matrix forbids, and `confirm` probes it
		// behaviorally: a lookup by a DIFFERENT spelling of the stored duration must find the row.
		label: 'alterColumn SET DATA TYPE (same storage class, semantic retype) re-keys',
		seed: u => [
			`create table t (id integer primary key, v text, constraint u_v unique (v))${u}`,
			`insert into t values (1, 'PT1H'), (2, 'PT2H')`,
		],
		alter: `alter table t alter column v set data type timespan`,
		memory: { kind: 'honored' },
		stubUnsupported: true,
		confirm: async (db, outcome) => {
			const info = await columnInfo(db, 'v');
			if (outcome === 'honored') {
				expect(String(info?.type).toLowerCase(), 'declared type now TIMESPAN').to.contain('timespan');
				// The index answers by elapsed time: 60 minutes locates the row stored as 'PT1H'.
				const r = await rows(db, `select id from t where v = 'PT60M'`);
				expect(r.map(x => x.id), 'lookup by an equal-elapsed spelling finds the row').to.deep.equal([1]);
				// ...and UNIQUE enforces by elapsed time too: 120 minutes duplicates 'PT2H'.
				await expectConstraint(db, `insert into t values (3, 'PT120M')`, 'semantic retype revalidate');
			} else {
				expect(String(info?.type).toLowerCase(), 'type unchanged on reject').to.contain('text');
			}
		},
	},
	{
		// The collision half: 'PT1H' and 'PT60M' are distinct text but ONE timespan, so the
		// existing rows violate the UNIQUE the moment the comparator moves. Must be rejected
		// before anything mutates — leaving values, declared type and writability intact.
		label: 'alterColumn SET DATA TYPE (semantic retype, UNIQUE collision) → CONSTRAINT',
		seed: u => [
			`create table t (id integer primary key, v text, constraint u_v unique (v))${u}`,
			`insert into t values (1, 'PT1H'), (2, 'PT60M')`,
		],
		alter: `alter table t alter column v set data type timespan`,
		memory: { kind: 'reject', codes: [StatusCode.CONSTRAINT], site: /unique/i },
		stubUnsupported: true,
		confirm: async (db) => {
			const info = await columnInfo(db, 'v');
			expect(String(info?.type).toLowerCase(), 'type unchanged after collision reject').to.contain('text');
			const r = await rows(db, `select id, v from t order by id`);
			expect(r.map(x => x.v), 'both spellings survive').to.deep.equal(['PT1H', 'PT60M']);
			// Still writable, still enforcing TEXTUAL uniqueness under the unchanged type.
			await db.exec(`insert into t values (3, 'PT3600S')`);
		},
	},
	{
		// Same physical storage class (both TEXT) is NOT a free pass on value validation:
		// DATE refuses 'hello', so the retype must reject with MISMATCH exactly as a
		// class-changing lossy retype does — the column must never declare DATE while
		// holding a value no INSERT could have produced.
		label: 'alterColumn SET DATA TYPE (same storage class, narrowing, illegal value) → MISMATCH',
		seed: u => [`create table t (id integer primary key, v text)${u}`, `insert into t values (1, 'hello')`],
		alter: `alter table t alter column v set data type date`,
		memory: { kind: 'reject', codes: [StatusCode.MISMATCH], site: /\bv\b|convert/i },
		stubUnsupported: true,
		confirm: async (db) => {
			const info = await columnInfo(db, 'v');
			expect(String(info?.type).toLowerCase(), 'type unchanged after narrowing reject').to.contain('text');
			const r = await rows(db, `select v from t`);
			expect(r.map(x => x.v), 'value untouched after narrowing reject').to.deep.equal(['hello']);
		},
	},
	{
		// An accepted same-class retype REWRITES each value to the new type's canonical
		// spelling — the state an INSERT would have produced. DATE compares BINARY over
		// the stored text, so without the rewrite the row is invisible to an equality
		// lookup for the canonical date (the silent divergence this matrix forbids).
		label: 'alterColumn SET DATA TYPE (same storage class) normalizes values',
		seed: u => [`create table t (id integer primary key, v text)${u}`, `insert into t values (1, '2024-06-05T00:00:00Z')`],
		alter: `alter table t alter column v set data type date`,
		memory: { kind: 'honored' },
		stubUnsupported: true,
		confirm: async (db, outcome) => {
			const info = await columnInfo(db, 'v');
			if (outcome === 'honored') {
				expect(String(info?.type).toLowerCase(), 'declared type now DATE').to.contain('date');
				const r = await rows(db, `select v from t`);
				expect(r.map(x => x.v), 'value rewritten to canonical form').to.deep.equal(['2024-06-05']);
				const hit = await rows(db, `select id from t where v = '2024-06-05'`);
				expect(hit.map(x => x.id), 'equality lookup finds the normalized row').to.deep.equal([1]);
			} else {
				expect(String(info?.type).toLowerCase(), 'type unchanged on reject').to.contain('text');
			}
		},
	},
	{
		// The combined value-rewrite + comparator-move path: normalization collapses two
		// previously-distinct spellings ('2024-06-05' and '2024-06-05T00:00:00Z' are one
		// DATE), so the UNIQUE re-validation over the CONVERTED rows must reject before
		// anything mutates — leaving values, declared type and writability intact.
		label: 'alterColumn SET DATA TYPE (same storage class, normalization collides under UNIQUE) → CONSTRAINT',
		seed: u => [
			`create table t (id integer primary key, v text, constraint u_v unique (v))${u}`,
			`insert into t values (1, '2024-06-05'), (2, '2024-06-05T00:00:00Z')`,
		],
		alter: `alter table t alter column v set data type date`,
		memory: { kind: 'reject', codes: [StatusCode.CONSTRAINT], site: /unique/i },
		stubUnsupported: true,
		confirm: async (db) => {
			const info = await columnInfo(db, 'v');
			expect(String(info?.type).toLowerCase(), 'type unchanged after collision reject').to.contain('text');
			const r = await rows(db, `select id, v from t order by id`);
			expect(r.map(x => x.v), 'both spellings survive').to.deep.equal(['2024-06-05', '2024-06-05T00:00:00Z']);
			// Still writable, still enforcing TEXTUAL uniqueness under the unchanged type.
			await db.exec(`insert into t values (3, '2024-06-05T06:00:00Z')`);
		},
	},
	{
		// SET DATA TYPE keeps the column's collation, so the NEW type has to accept it. DATE
		// declares `supportedCollations: []` (BINARY only), so `text collate nocase → date` must
		// reject — otherwise the ALTER mints `d DATE COLLATE NOCASE`, a shape CREATE TABLE would
		// refuse and whose generated DDL does not re-parse (on a store-backed database the table
		// is dropped on reopen). `stubUnsupported: false`: this guard is engine-side and fires
		// BEFORE module.alterTable is dispatched, so the stub leg would see this same collation
		// error rather than the sited UNSUPPORTED that leg asserts.
		label: 'alterColumn SET DATA TYPE into a collation-less type with an illegal collation → ERROR',
		seed: u => [`create table t (id integer primary key, d text collate nocase)${u}`, `insert into t values (1, '2024-01-01')`],
		alter: `alter table t alter column d set data type date`,
		memory: { kind: 'reject', codes: [StatusCode.ERROR], site: /Unknown collation/ },
		stubUnsupported: false,
		confirm: async (db) => {
			const info = await columnInfo(db, 'd');
			expect(String(info?.type).toLowerCase(), 'type unchanged after collation reject').to.contain('text');
			expect(String(info?.collation).toUpperCase(), 'collation unchanged after reject').to.equal('NOCASE');
		},
	},
	{
		// Guard is engine-side (`runAlterColumn` in runtime/emit/alter-table.ts refuses this
		// before `module.alterTable` is ever dispatched — see docs/module-authoring.md), same
		// shape as the collation-less-type arm above. `stubUnsupported: false`: the stub leg
		// (no `alterTable`) sees this same engine-side CONSTRAINT, not the sited UNSUPPORTED
		// that leg otherwise asserts for arms with no engine-side fallback.
		label: 'alterColumn SET DATA TYPE on a PRIMARY KEY column → CONSTRAINT',
		seed: u => [`create table t (id text primary key, v text)${u}`, `insert into t values ('1', 'a')`],
		alter: `alter table t alter column id set data type integer`,
		memory: { kind: 'reject', codes: [StatusCode.CONSTRAINT], site: /primary key/i },
		stubUnsupported: false,
		confirm: async (db) => {
			const info = await columnInfo(db, 'id');
			expect(String(info?.type).toLowerCase(), 'type unchanged after PK retype reject').to.contain('text');
			const r = await rows(db, `select id from t`);
			expect(r.map(x => x.id), 'value untouched').to.deep.equal(['1']);
		},
	},
	{
		label: 'alterColumn SET DEFAULT',
		seed: u => [`create table t (id integer primary key, v integer null)${u}`, `insert into t values (1, 5)`],
		alter: `alter table t alter column v set default 99`,
		memory: { kind: 'honored' },
		stubUnsupported: true,
		confirm: async (db, outcome) => {
			if (outcome === 'honored') {
				await db.exec(`insert into t (id) values (2)`);
				const r = await rows(db, `select v from t where id = 2`);
				expect(r[0].v, 'new insert picks up the SET DEFAULT').to.equal(99);
			}
		},
	},
	{
		label: 'alterColumn SET COLLATE (non-PK UNIQUE, no collision) revalidates',
		seed: u => [
			`create table t (id integer primary key, name text, constraint u_name unique (name))${u}`,
			`insert into t values (1, 'abc'), (2, 'xyz')`,
		],
		alter: `alter table t alter column name set collate nocase`,
		memory: { kind: 'honored' },
		stubUnsupported: true,
		confirm: async (db, outcome) => {
			const info = await columnInfo(db, 'name');
			if (outcome === 'honored') {
				expect(String(info?.collation).toUpperCase(), 'collation now NOCASE').to.equal('NOCASE');
				// Forward UNIQUE is now collation-aware: 'ABC' collides with 'abc' under NOCASE.
				await expectConstraint(db, `insert into t values (3, 'ABC')`, 'SET COLLATE revalidate');
			} else {
				expect(String(info?.collation).toUpperCase(), 'collation unchanged on reject').to.not.equal('NOCASE');
			}
		},
	},
];

// ── Drivers ──────────────────────────────────────────────────────────────────

async function runArm(db: Database, arm: Arm, using: string, expectation: Expectation): Promise<void> {
	for (const stmt of arm.seed(using)) await db.exec(stmt);
	const err = await attemptAlter(db, arm.alter);

	if (expectation.kind === 'honored') {
		expect(err, `${arm.label}: expected honored, but ALTER threw: ${err?.message}`).to.equal(null);
		await arm.confirm(db, 'honored');
		return;
	}

	expect(
		err,
		`${arm.label}: expected a clean reject, but the ALTER succeeded — a statement that succeeds without taking effect is the silent-divergence signature this matrix forbids`,
	).to.be.instanceOf(QuereusError);
	expect(expectation.codes, `${arm.label}: reject code was ${err!.code} (${err!.message})`).to.include(err!.code);
	expect(err!.message.trim().length, `${arm.label}: clean reject must carry a non-empty, sited message`).to.be.greaterThan(0);
	if (expectation.site) expect(err!.message, `${arm.label}: reject message should be sited`).to.match(expectation.site);
	await arm.confirm(db, 'rejected');
}

describe('ALTER conformance matrix — memory module', () => {
	let db: Database;

	afterEach(async () => {
		if (db) await db.close();
	});

	for (const arm of ARMS) {
		it(arm.label, async () => {
			db = new Database();
			await runArm(db, arm, '', arm.memory);
		});
	}
});

describe('ALTER conformance matrix — module without alterTable (sited UNSUPPORTED)', () => {
	let db: Database;

	afterEach(async () => {
		if (db) await db.close();
	});

	// Only arms with NO engine-side fallback. Two arms are exempt because they WOULD be
	// (legitimately) honored without alterTable, and are covered separately below: ADD CHECK is
	// enforced engine-side, and RENAME COLUMN degrades to a documented schema-only rename.
	// ALTER PRIMARY KEY is NOT exempt — it has a rebuild fallback, but this stub also omits
	// `renameTable`, which the rebuild's closing RENAME requires.
	for (const arm of ARMS.filter(a => a.stubUnsupported)) {
		it(`${arm.label} → UNSUPPORTED`, async () => {
			db = new Database();
			db.registerModule('noalter', makeNoAlterModule());
			await runArm(db, arm, ' using noalter', {
				kind: 'reject',
				codes: [StatusCode.UNSUPPORTED],
				site: /does not support|not support/i,
			});
		});
	}

	// RENAME COLUMN is documented to degrade to an engine-side schema-only rename
	// when the module omits alterTable (module.ts: "renameColumn degrades to an
	// engine-side schema-only rename instead"). Assert that contract explicitly —
	// it is honored, and the read-back proves it is not a silent no-op.
	// ALTER PRIMARY KEY's honored leg needs the `renameTable`-keeping stub, because the
	// rebuild finishes with DROP + RENAME: a module that omits `renameTable` would leave its
	// internal table map keyed under the shadow name and the rebuilt table could not be
	// connected at all, which is why the engine refuses that shape outright (the sweep above).
	// With the hook present the rebuild runs, ending at a PARSER-built schema, so its
	// per-column PK flags come out consistent with the definition for free — assert it
	// rather than assume, since it is the third producer of a re-keyed schema (after the
	// memory module and the store) and the only one not routed through
	// `rekeySchemaPrimaryKey`.
	it('alterPrimaryKey → honored via engine-side shadow rebuild, flags consistent', async () => {
		db = new Database();
		db.registerModule('noalter', makeNoAlterModule({ withRenameTable: true }));
		await db.exec(`create table t (id integer primary key, code integer not null) using noalter`);
		await db.exec(`insert into t values (1, 100), (2, 200)`);
		await db.exec(`alter table t alter primary key (code)`);

		expect(await pkColumns(db), 'PK re-keyed to code by the rebuild').to.deep.equal(['code']);
		const r = await rows(db, `select id from t where code = 100`);
		expect(r[0]?.id, 'rows survived the rebuild and are reachable under the new key').to.equal(1);
		expectKeyFlagsAgreeWithDefinition(db);
	});

	it('renameColumn → honored via engine-side schema-only fallback', async () => {
		db = new Database();
		db.registerModule('noalter', makeNoAlterModule());
		await db.exec(`create table t (id integer primary key, name text) using noalter`);
		await db.exec(`insert into t values (1, 'a')`);
		await db.exec(`alter table t rename column name to title`);
		const names = await columnNames(db);
		expect(names, 'new name present').to.include('title');
		expect(names, 'old name gone').to.not.include('name');
		const r = await rows(db, `select title from t where id = 1`);
		expect(r[0].title, 'data preserved under the renamed column').to.equal('a');
	});
});

// ── ALTER PRIMARY KEY via the engine-side shadow rebuild ─────────────────────
//
// For a module with no native `alterPrimaryKey`, the engine falls back to a
// shadow rebuild (runtime/emit/alter-table.ts): CREATE a shadow table, copy the
// rows into it, DROP the original, RENAME the shadow over it, re-create the user
// indexes. The shadow's CREATE TABLE is rendered by `generateTableDDL` over the
// real `TableSchema` with only the name and key substituted, so everything the
// table declares has to survive that round trip. Anything the shadow DDL fails
// to render does not merely look different — it stops being enforced, which is
// the silent divergence this file exists to forbid.
//
// These arms assert survival BEHAVIORALLY (the constraint still rejects a
// violating write) rather than by reading DDL text; the closing arm is the
// general subsumer that compares the canonical DDL before and after.

describe('ALTER PRIMARY KEY — shadow rebuild preserves the table definition', () => {
	let db: Database;

	afterEach(async () => {
		if (db) await db.close();
	});

	/**
	 * A database whose 'noalter' module omits `alterTable` (so ALTER PRIMARY KEY must
	 * take the rebuild fallback) but keeps `renameTable` (which the rebuild's closing
	 * RENAME requires), and optionally `createIndex`/`dropIndex`.
	 */
	function openRebuildDb(opts: { withCreateIndex?: boolean } = {}): Database {
		const fresh = new Database();
		fresh.registerModule('noalter', makeNoAlterModule({ withRenameTable: true, ...opts }));
		return fresh;
	}

	it('a table-level CHECK still rejects a violating insert after the rebuild', async () => {
		db = openRebuildDb();
		await db.exec(`create table t (id integer primary key, code integer not null, v integer not null, constraint pos check (v > 0)) using noalter`);
		await db.exec(`insert into t values (1, 100, 5)`);
		await db.exec(`alter table t alter primary key (code)`);

		expect(await pkColumns(db), 'PK re-keyed by the rebuild').to.deep.equal(['code']);
		await expectConstraint(db, `insert into t values (2, 200, -1)`, 'CHECK after rebuild');
		// The satisfying insert still works — the CHECK survived as a CHECK, not as a wall.
		await db.exec(`insert into t values (2, 200, 1)`);
	});

	it('a UNIQUE constraint still rejects a duplicate after the rebuild', async () => {
		db = openRebuildDb();
		await db.exec(`create table t (id integer primary key, code integer not null, email text not null, constraint u_email unique (email)) using noalter`);
		await db.exec(`insert into t values (1, 100, 'a@x')`);
		await db.exec(`alter table t alter primary key (code)`);

		await expectConstraint(db, `insert into t values (2, 200, 'a@x')`, 'UNIQUE after rebuild');
		await db.exec(`insert into t values (2, 200, 'b@x')`);
	});

	it('a declared FOREIGN KEY is still enforced after the rebuild', async () => {
		db = openRebuildDb();
		await db.exec(`pragma foreign_keys = true`);
		await db.exec(`create table parent (pid integer primary key) using noalter`);
		await db.exec(`insert into parent values (1), (2)`);
		await db.exec(`create table t (id integer primary key, code integer not null, pa integer not null, constraint fk_pa foreign key (pa) references parent(pid)) using noalter`);
		await db.exec(`insert into t values (1, 100, 1)`);
		await db.exec(`alter table t alter primary key (code)`);

		const schema = db.schemaManager.findTable('t')!;
		expect((schema.foreignKeys ?? []).length, 'FK survives in the rebuilt schema').to.equal(1);
		await expectConstraint(db, `insert into t values (2, 200, 99)`, 'FK after rebuild');
		await db.exec(`insert into t values (2, 200, 2)`);
	});

	it('table tags survive the rebuild', async () => {
		db = openRebuildDb();
		await db.exec(`create table t (id integer primary key, code integer not null) using noalter with tags (owner = 'ops')`);
		await db.exec(`insert into t values (1, 100)`);
		await db.exec(`alter table t alter primary key (code)`);

		const schema = db.schemaManager.findTable('t')!;
		expect(schema.tags?.owner, 'table tag survives the rebuild').to.equal('ops');
	});

	it('the key ON CONFLICT REPLACE action survives the rebuild (behaviorally)', async () => {
		db = openRebuildDb();
		await db.exec(`create table t (a integer not null, b integer not null, v text, primary key (a) on conflict replace) using noalter`);
		await db.exec(`insert into t values (1, 10, 'x')`);
		await db.exec(`alter table t alter primary key (b)`);

		expect(await pkColumns(db), 'PK re-keyed to b').to.deep.equal(['b']);
		// Same b as the existing row: REPLACE means the insert takes over, not an error.
		await db.exec(`insert into t values (2, 10, 'y')`);
		const r = await rows(db, `select a, b, v from t`);
		expect(r, 'duplicate key replaced rather than erroring').to.deep.equal([{ a: 2, b: 10, v: 'y' }]);
	});

	it('user indexes survive the rebuild and a UNIQUE index still enforces', async () => {
		db = openRebuildDb({ withCreateIndex: true });
		await db.exec(`create table t (id integer primary key, code integer not null, name text not null, tag text not null) using noalter`);
		await db.exec(`create index idx_name on t (name)`);
		await db.exec(`create unique index u_tag on t (tag)`);
		await db.exec(`insert into t values (1, 100, 'a', 'x')`);
		await db.exec(`alter table t alter primary key (code)`);

		const names = (db.schemaManager.findTable('t')!.indexes ?? []).map(i => i.name.toLowerCase());
		expect(names, 'plain index re-created on the rebuilt table').to.include('idx_name');
		expect(names, 'unique index re-created on the rebuilt table').to.include('u_tag');
		await expectConstraint(db, `insert into t values (2, 200, 'b', 'x')`, 'UNIQUE INDEX after rebuild');
		await db.exec(`insert into t values (2, 200, 'b', 'y')`);
	});

	it('refuses up front — leaving the table untouched — when the module cannot re-create the indexes', async () => {
		// A module that cannot `createIndex` also cannot have had an index created on it
		// through SQL (SchemaManager.createIndex refuses first), so the shape this guard
		// exists for is reached the other way round: a table arriving with indexes already
		// attached (a store-backed catalog rehydrate). Simulated here by dropping the hook
		// after setup — what the engine sees at ALTER time is identical.
		const mod = makeNoAlterModule({ withRenameTable: true, withCreateIndex: true });
		db = new Database();
		db.registerModule('noalter', mod);
		await db.exec(`create table t (id integer primary key, code integer not null, name text not null) using noalter`);
		await db.exec(`create index idx_name on t (name)`);
		await db.exec(`insert into t values (1, 100, 'a')`);

		delete (mod as { createIndex?: unknown }).createIndex;

		const err = await attemptAlter(db, `alter table t alter primary key (code)`);
		expect(err, 'refused rather than silently dropping the index').to.be.instanceOf(QuereusError);
		expect(err!.code, 'refusal code').to.equal(StatusCode.UNSUPPORTED);
		expect(err!.message, 'refusal names the missing capability').to.match(/createIndex/);
		expect(err!.message, 'refusal is sited on the table').to.match(/'t'/);

		// Untouched: same key, same index, same rows.
		expect(await pkColumns(db), 'PK unchanged after the refusal').to.deep.equal(['id']);
		expect((db.schemaManager.findTable('t')!.indexes ?? []).map(i => i.name.toLowerCase()), 'index unchanged').to.include('idx_name');
		expect(await rows(db, `select id, code, name from t`), 'rows unchanged').to.deep.equal([{ id: 1, code: 100, name: 'a' }]);
	});

	it('alter primary key () yields the empty singleton key on a one-row table', async () => {
		db = openRebuildDb();
		await db.exec(`create table t (id integer primary key, code integer not null) using noalter`);
		await db.exec(`insert into t values (1, 100)`);
		await db.exec(`alter table t alter primary key ()`);

		expect(db.schemaManager.findTable('t')!.primaryKeyDefinition, 'singleton key').to.deep.equal([]);
		expect(await pkColumns(db), 'no column reported as key member').to.deep.equal([]);
		expectKeyFlagsAgreeWithDefinition(db);
		expect(await rows(db, `select id, code from t`), 'the row survived').to.deep.equal([{ id: 1, code: 100 }]);
	});

	it('alter primary key () rejects when existing rows would collide under the singleton key', async () => {
		db = openRebuildDb();
		await db.exec(`create table t (id integer primary key, code integer not null) using noalter`);
		await db.exec(`insert into t values (1, 100), (2, 200)`);

		const err = await attemptAlter(db, `alter table t alter primary key ()`);
		expect(err, 'two rows cannot share the singleton key').to.be.instanceOf(QuereusError);
		expect(err!.message, 'rejection cites the collision').to.match(/unique|collide/i);
		expect(await pkColumns(db), 'PK unchanged after the failed rebuild').to.deep.equal(['id']);
		expect(await rows(db, `select id from t order by id`), 'rows unchanged').to.deep.equal([{ id: 1 }, { id: 2 }]);
	});

	it('a self-referencing FOREIGN KEY survives the rebuild and is still enforced', async () => {
		db = openRebuildDb();
		await db.exec(`pragma foreign_keys = true`);
		await db.exec(`create table t (code integer primary key, parent_code integer null, constraint fk_self foreign key (parent_code) references t(code)) using noalter`);
		await db.exec(`insert into t values (1, null), (2, 1)`);
		// Genuine re-key that keeps `code` as the (still unique) FK target: flip to descending.
		await db.exec(`alter table t alter primary key (code desc)`);

		const schema = db.schemaManager.findTable('t')!;
		expect(schema.primaryKeyDefinition.map(pk => pk.desc), 'key is now descending').to.deep.equal([true]);
		const fk = (schema.foreignKeys ?? [])[0];
		expect(fk, 'the self-FK survived').to.not.be.undefined;
		expect(fk?.referencedTable.toLowerCase(), 'self-FK still points at the table itself').to.equal('t');
		expect(await rows(db, `select code from t order by code`), 'rows survived').to.deep.equal([{ code: 1 }, { code: 2 }]);

		await db.exec(`insert into t values (3, 2)`);
		await expectConstraint(db, `insert into t values (4, 999)`, 'self-FK after rebuild');
	});

	it('another table FOREIGN KEY into the rebuilt table survives, referencing rows and all', async () => {
		db = openRebuildDb();
		await db.exec(`pragma foreign_keys = true`);
		await db.exec(`create table parent (id integer primary key, label text) using noalter`);
		await db.exec(`insert into parent values (1, 'a'), (2, 'b')`);
		await db.exec(`create table child (cid integer primary key, pid integer not null, constraint fk_p foreign key (pid) references parent(id)) using noalter`);
		await db.exec(`insert into child values (10, 1)`);
		// The rebuild internally DROPs `parent` while `child` still references it; the drop
		// guard is suppressed for exactly that statement, matching the in-place re-key path
		// (which never breaks such children). The re-key keeps `id` as the FK target.
		await db.exec(`alter table parent alter primary key (id desc)`);

		expect(await rows(db, `select id from parent order by id`), 'parent rows survived').to.deep.equal([{ id: 1 }, { id: 2 }]);
		expect(await rows(db, `select cid, pid from child`), 'child rows untouched').to.deep.equal([{ cid: 10, pid: 1 }]);
		await db.exec(`insert into child values (11, 2)`);
		await expectConstraint(db, `insert into child values (12, 99)`, 'child FK after parent rebuild');
	});

	it('the canonical DDL before and after a rebuild differs ONLY in the PRIMARY KEY clause', async () => {
		// The general subsumer for every arm above: whatever `generateTableDDL` renders is
		// what a store-backed catalog persists and re-parses, so if the two texts agree
		// outside the key clause, nothing the table declares was dropped by the rebuild.
		db = openRebuildDb();
		await db.exec(`create table t (
			id integer primary key,
			code integer not null,
			name text not null collate nocase default 'x',
			v integer not null default 7,
			dbl integer null generated always as (v * 2) stored,
			constraint pos check (v > 0),
			constraint u_name unique (name)
		) using noalter with tags (owner = 'ops')`);
		await db.exec(`insert into t (id, code, name, v) values (1, 100, 'a', 5)`);

		const before = generateTableDDL(db.schemaManager.findTable('t')!);
		await db.exec(`alter table t alter primary key (code)`);
		const after = generateTableDDL(db.schemaManager.findTable('t')!);

		expect(before, 'sanity: the pre-rebuild DDL names the old key').to.match(/"id"[^,]*PRIMARY KEY/);
		expect(after, 'sanity: the post-rebuild DDL names the new key').to.match(/"code"[^,]*PRIMARY KEY/);
		expect(after, 'the two texts are not trivially identical').to.not.equal(before);
		// Non-vacuity: the comparison below is only worth anything if the captured text
		// actually carries every feature the rebuild could drop.
		for (const feature of [/CHECK/i, /UNIQUE/i, /COLLATE/i, /DEFAULT/i, /GENERATED ALWAYS AS/i, /TAGS/i, /USING/i]) {
			expect(before, `sanity: captured DDL carries ${feature}`).to.match(feature);
		}

		// Strip every PRIMARY KEY clause (inline and table-level) plus the comma it leaves
		// behind, then the remainders must be byte-identical.
		const withoutKey = (ddl: string) => ddl
			.replace(/\s*PRIMARY KEY(\s*\([^)]*\))?(\s+ON CONFLICT\s+\w+)?/g, '')
			.replace(/,\s*,/g, ',')
			.replace(/\(\s*,/g, '(');
		expect(withoutKey(after), 'rebuild changed nothing but the key').to.equal(withoutKey(before));

		// And the generated column still computes on the rebuilt table.
		expect(await rows(db, `select dbl from t`), 'generated column recomputes').to.deep.equal([{ dbl: 10 }]);
	});
});
