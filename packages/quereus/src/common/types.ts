import type { RuntimeContext } from '../runtime/types.js';
import type { JSONValue } from './json-types.js';

export type MaybePromise<T> = T | Promise<T>;

export type DeepReadonly<T> =
	T extends string | number | bigint | boolean | symbol | null | undefined | ((...args: never[]) => unknown) | Uint8Array
		? T
		: T extends JSONValue
			? T // Stop recursing into JSON values (recursive type)
			: { readonly [P in keyof T]: DeepReadonly<T[P]> };

/**
 * A JSON-compatible object or array stored natively as a SQL value.
 * Distinguishes JSON objects from other `object` types (Uint8Array, Date, etc.).
 */
export type JsonSqlValue = { [key: string]: JSONValue } | JSONValue[];

/**
 * Represents the primitive scalar types Quereus can handle internally in this implementation.
 * These are the values that can be stored in Quereus columns and passed as parameters.
 */
export type SqlValue = string | number | bigint | boolean | Uint8Array | JsonSqlValue | null;

/**
 * Represents a row of data, which is an array of SqlValue.
 */
export type Row = SqlValue[];

/**
 * A sub-program handed to an instruction as one of its params: invoke it to run the
 * child program against the current runtime context. Emitters that receive one
 * conditionally must declare it as a trailing rest tuple, not an optional param —
 * see `asRun` in `runtime/types.ts`.
 */
export type SubProgram = (ctx: RuntimeContext) => OutputValue;

/**
 * Represents a value that can be expected as an input in the runtime environment.
 * This type can be a scalar value, an async iterable of rows (cursor), or a sub-program.
 */
export type RuntimeValue = SqlValue | Row | AsyncIterable<Row> | SubProgram

/** Represents a value that can be output from an instruction or program. */
export type OutputValue = MaybePromise<RuntimeValue>;

export type SqlParameters = Record<string, SqlValue> | SqlValue[];

/**
 * Per-call options for statement execution. Accepted by the database-level
 * entry points (`Database.exec`, `Database.eval`, `Database.get`) and the
 * prepared-statement methods (`Statement.run`, `Statement.get`,
 * `Statement.iterateRows`, `Statement.all`).
 */
export interface StatementOptions {
	/**
	 * Cooperative cancellation. When the signal aborts, in-flight execution is
	 * interrupted at the next row or statement boundary and the call rejects with
	 * an `AbortError`. A signal that is already aborted causes an immediate reject
	 * before any work is performed.
	 */
	signal?: AbortSignal;
	/**
	 * Read concurrency for this execution.
	 *
	 * - `'serialized'` (default) — queue behind the execution mutex. The read
	 *   sees whatever an already-queued write left behind, exactly as today.
	 * - `'committed'` — when the statement is eligible (a read-only query in
	 *   autocommit mode whose every table's module declares
	 *   `readCommittedSnapshot`), run WITHOUT the mutex against each table's last
	 *   committed state, so the read completes even while another statement is
	 *   blocked in its virtual-table commit. An ineligible statement silently
	 *   falls back to `'serialized'` — never an error.
	 *
	 * `'committed'` deliberately gives up the ordering guarantee that
	 * `void db.exec(insert); await db.get(select)` shows the insert — the read
	 * may serve the pre-insert state. That is why it is opt-in per call.
	 * Honored by the row-returning entry points (`Database.get`, `Database.eval`,
	 * `Statement.get/all/iterateRows/run`); `Database.exec` ignores it.
	 *
	 * A second, subtler loss for a module that fetches its state from somewhere
	 * else (peers, a server, another process): the state a committed read serves is
	 * pinned when that read starts, so a write arriving from elsewhere WHILE it
	 * runs cannot appear in its rows. The NEXT committed read picks that write up —
	 * a conformant module re-pins per read, which is what makes a poll converge
	 * (see `VirtualTableModule.readCommittedSnapshot` for the obligation). A module
	 * that instead pins one state per connection or per process and never re-pins
	 * is NOT conformant, and a caller polling through `'committed'` against it
	 * would never converge at all.
	 *
	 * So before trusting a module on this path, run `runCommittedReadConformance`
	 * against it: it checks both that a committed read stays coherent across
	 * another connection's commit and that it advances once that commit lands.
	 * How much staleness a read tolerates stays the caller's call, not the
	 * engine's — reading normally except where the latency actually hurts is a
	 * perfectly reasonable policy.
	 */
	readConcurrency?: 'serialized' | 'committed';
}

/**
 * Standard status/error codes that significantly match SQLite.
 * Used for error handling and determining operation results.
 */
export enum StatusCode {
	OK = 0,
	ERROR = 1,
	INTERNAL = 2,
	PERM = 3,
	ABORT = 4,
	BUSY = 5,
	LOCKED = 6,
	NOMEM = 7,
	READONLY = 8,
	INTERRUPT = 9,
	IOERR = 10,
	CORRUPT = 11,
	NOTFOUND = 12,
	FULL = 13,
	CANTOPEN = 14,
	PROTOCOL = 15,
	EMPTY = 16,
	SCHEMA = 17,
	TOOBIG = 18,
	CONSTRAINT = 19,
	MISMATCH = 20,
	MISUSE = 21,
	NOLFS = 22,
	AUTH = 23,
	FORMAT = 24,
	RANGE = 25,
	NOTADB = 26,
	NOTICE = 27,
	WARNING = 28,
	SYNTAX = 29,
	UNSUPPORTED = 30,
}

/**
 * Fundamental SQLite compatible datatypes/affinity types.
 * These determine how values are stored and compared within the database.
 */
export enum SqlDataType {
	NULL = 0,
	INTEGER = 1,
	REAL = 2,
	TEXT = 3,
	BLOB = 4,
	NUMERIC = 6, // For DECIMAL, NUMERIC with precision/scale
	BOOLEAN = 7, // For explicit BOOLEAN columns (future, not standard SQLite)
}

export type CompareFn = (a: SqlValue, b: SqlValue) => number;

export type RowOp = 'insert' | 'update' | 'delete';

/**
 * Constraint types that can be reported via UpdateResult.
 * These represent expected constraint violations that modules should signal
 * without throwing exceptions.
 */
export type ConstraintType = 'unique' | 'check' | 'not_null' | 'foreign_key';

/**
 * Result of a VirtualTable.update() operation.
 * Replaces exception-based constraint signaling to distinguish expected
 * constraint violations from unexpected errors (network issues, bugs, etc.).
 *
 * `row` present means a row really was written/removed; absent means nothing
 * changed and the executor skips the post-write pipeline entirely. For an
 * INSERT/UPDATE it is the row the module STORED — the proposed values after the
 * module's own coercion to the declared column logical types — and the DML
 * executor reports it, not the proposed row, to every post-write consumer. For a
 * DELETE only its presence is read, never its contents. See
 * `VirtualTable.update`'s doc comment for the module-author contract and
 * docs/runtime.md § per-row post-write pipeline.
 *
 * Two REPLACE-displacement channels, both consumed by the DML executor so the
 * single post-write pipeline (change-tracking, row-time MV maintenance, FK
 * cascade, auto-events) runs uniformly across substrates:
 *
 * - `replacedRow` — the row displaced at the *same PK* by a PK-collision REPLACE.
 *   The executor models it as an update-in-place of that PK slot (an
 *   `update(replacedRow → newRow)` on the INSERT path, a `delete(replacedRow)` on
 *   the UPDATE move path), firing FK actions as a *delete* of the old image.
 * - `evictedRows` — rows at *other PKs* fully removed because REPLACE resolved a
 *   non-PK UNIQUE conflict for this same `update()` call, in user-facing schema
 *   (no overlay tombstone column). The executor models **each** as a full DELETE
 *   (`_recordDelete` + row-time maintenance + `executeForeignKeyActions('delete')`
 *   + a delete auto-event), fired **before** the new row's own bookkeeping to match
 *   the substrate's evict-then-write journal order.
 *
 * Both fields are optional and additive: a module that reports neither behaves
 * exactly as a module would have before they existed. `replacedRow` and
 * `evictedRows` are independent and may both be present in principle (today's
 * memory/store INSERT paths short-circuit on a PK collision before the secondary
 * UNIQUE check, so they do not co-occur there — but the executor handles both
 * cleanly regardless).
 */
export type UpdateResult =
	| { status: 'ok'; row?: Row; replacedRow?: Row; evictedRows?: readonly Row[] }
	| { status: 'constraint'; constraint: ConstraintType; message?: string; existingRow?: Row };

/**
 * Type guard to check if an UpdateResult indicates success.
 */
export function isUpdateOk(result: UpdateResult): result is { status: 'ok'; row?: Row; replacedRow?: Row; evictedRows?: readonly Row[] } {
	return result.status === 'ok';
}

/**
 * Type guard to check if an UpdateResult indicates a constraint violation.
 */
export function isConstraintViolation(result: UpdateResult): result is { status: 'constraint'; constraint: ConstraintType; message?: string; existingRow?: Row } {
	return result.status === 'constraint';
}

/**
 * Checks whether a value is a valid SqlValue at runtime.
 */
export function isSqlValue(value: unknown): value is SqlValue {
	if (value === null) return true;
	const t = typeof value;
	if (t === 'string' || t === 'number' || t === 'bigint' || t === 'boolean') return true;
	if (value instanceof Uint8Array) return true;
	// Accept plain objects and arrays as JSON values
	if (t === 'object' && (Array.isArray(value) || Object.getPrototypeOf(value) === Object.prototype)) return true;
	return false;
}

/**
 * Describes a non-SqlValue for error messages.
 */
export function describeSqlValueViolation(value: unknown): string {
	const t = typeof value;
	if (t === 'object' && value !== null) {
		if (value instanceof Uint8Array) return 'Uint8Array';
		if (Array.isArray(value)) return 'Array (JSON)';
		if (Object.getPrototypeOf(value) === Object.prototype) return 'Object (JSON)';
		return (value as object).constructor?.name ?? 'object';
	}
	return t;
}

export type { JSONValue } from './json-types.js';
