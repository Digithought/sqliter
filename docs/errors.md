# Error Handling in Quereus

> **Stability: Stable** — see [Stability Tiers](stability.md#tiers).

Quereus employs a structured approach to error handling to provide context and aid debugging. Errors are generally propagated as instances of `QuereusError` (or its subclasses) found in `src/common/errors.ts`.

## Error Class Hierarchy

*   **`QuereusError`** — Base error class for all Quereus-specific errors. Extends `Error` with status code, line/column location, and cause chaining.
*   **`ParseError`** — Thrown by the parser for SQL syntax errors. Extends `QuereusError` with the offending `Token`.

    Constructor: `new ParseError(token: Token, message: string)` — extracts `line`/`column` from `token.startLine` and `token.startColumn`. The `token` property is available on the error instance for inspecting the offending token's type, value, and position.

    ```typescript
    import { ParseError } from 'quereus';

    try {
    	await db.exec('select * form users'); // typo: "form" instead of "from"
    } catch (err) {
    	if (err instanceof ParseError) {
    		console.log(err.token);  // the Token that caused the parse failure
    		console.log(err.line);   // 1-based line number
    		console.log(err.column); // 1-based column number
    	}
    }
    ```
*   **`ConstraintError`** — Thrown when a database constraint (UNIQUE, NOT NULL, CHECK) is violated. Uses `StatusCode.CONSTRAINT`.
*   **`MisuseError`** — Thrown when the API is used incorrectly (e.g., operating on a closed database or finalized statement). Uses `StatusCode.MISUSE`.
*   **`RelationNotFoundError`** — Thrown when a statement names a table or view that does not resolve: the object is absent, or the schema qualifying it is not attached. Uses `StatusCode.NOTFOUND` and sets `name = 'RelationNotFoundError'`. Raised from both arms of `resolveTableSchema` (qualified `schema.table`, and the search-path scan) plus the two DDL sites that report `no such table:` (`CREATE INDEX`, `ALTER TABLE … SET MAINTAINED`). Deliberately scoped to *relations* only — a missing column, function, parameter, or tag stays a plain `QuereusError`, because consumers use this class to conclude that "no such row" is an observed fact rather than a failed lookup, and widening it would make that conclusion wrong. Match on the class or `name`, not on `code`: `StatusCode.NOTFOUND` is shared with several unrelated absent-object errors (missing named parameter, missing assertion, missing tag key, missing lens slot).
*   **`AbortError`** — Thrown when an in-flight statement is cancelled via an `AbortSignal` passed through the `{ signal }` option. Every execution entry point accepts it: the database-level `Database.exec` / `eval` / `get`, and the prepared-statement `Statement.run` / `get` / `iterateRows` / `all`. Uses `StatusCode.ABORT`, and sets `name = 'AbortError'` so a downstream classifier that keys on the platform `AbortError` name recognizes it. It extends `QuereusError` deliberately: the engine's error-wrapping catches pass a `QuereusError` through unchanged, so cancellation survives them with its `name`/`code` identity intact. The free function `throwIfAborted(signal?)` is the cooperative poll used at the engine's yield seams — the physical table-access row-loop, the statement output-row boundary, the DML drain loop (per source row of an `INSERT` / `UPDATE` / `DELETE`, which reaches scan-less bulk mutations), and `Database.exec`'s own discard-drain of a row-returning statement — plus a pre-flight check at the public-API entry; it throws an `AbortError` when the signal is aborted and is a no-op otherwise (including when `signal` is `undefined`). The type guard `isAbortError(e)` returns true for an `AbortError` or any foreign error whose `name` is `'AbortError'` (e.g. a platform `DOMException`). Abort cancels *execution*, not an already-started commit — an abort that races a commit is a no-op, so it can never leave a partially-committed state. Work inside a single instruction with no `await` seam (a tight CPU loop, an in-memory sort, a single heavy DDL op) is not interruptible: the engine deliberately does not poll between scheduler instructions (the synchronous path cannot observe an abort, and a between-instruction poll cannot reach an intra-instruction loop), so such a statement runs to completion once past the pre-flight check.

All subclasses support error cause chaining via the `cause` parameter.

## Error Propagation Flow

1.  **Lexer/Parser Errors:**
    *   Syntax errors detected during lexing or parsing generate a `ParseError`.
    *   `ParseError` extends `QuereusError` and includes the specific `Token` that caused the error, providing line and column information.

2.  **Planner Errors:**
    *   The planner builds a `PlanNode` tree from the AST.
    *   Semantic errors (e.g., "ambiguous column", "type mismatch") throw `QuereusError` using the `quereusError()` helper, which extracts line/column from AST node `loc` properties.
    *   These errors include `StatusCode.ERROR` by default. The exception is an unresolvable table or view, which throws `RelationNotFoundError` with `StatusCode.NOTFOUND` so callers can recognize it without matching message text.

3.  **Runtime Errors:**
    *   The runtime executes the emitted instruction graph.
    *   Calls to potentially error-prone operations are wrapped in `try-catch` blocks:
        *   User-Defined Functions (UDFs) via function calls.
        *   Virtual Table methods (`query`, `update`, `disconnect`, etc.) via runtime emitters.
    *   If an error occurs within a UDF or VTab method:
        *   The runtime catches the exception.
        *   If it's not already a `QuereusError`, it's wrapped in one.
        *   Contextual information (e.g., "Error in function X:", "Error in VTab Y.query:", location) is added to the error message.
        *   The original caught error is attached as the `cause` property.
        *   The scheduler halts execution and surfaces the `QuereusError`.
    *   Constraint violations return `ConstraintError` with `StatusCode.CONSTRAINT`.

## QuereusError Structure

The base `QuereusError` class provides the following properties:

*   `message`: (String) The primary error description. Enhanced with location info if available.
*   `code`: (Number) A `StatusCode` enum value indicating the error type (e.g., `ERROR`, `CONSTRAINT`, `MISUSE`, `UNSUPPORTED`).
*   `cause`: (Error | undefined) The original underlying error object, if the `QuereusError` is wrapping another exception.
*   `line`: (Number | undefined) The 1-based line number where the error originated (if available from AST/token).
*   `column`: (Number | undefined) The 1-based column number where the error originated (if available from AST/token).

## StatusCode Reference

The `StatusCode` enum (from `src/common/types.ts`) mirrors SQLite's result codes. These are the numeric codes carried by `QuereusError.code`.

### Commonly Used Codes

| Code | Name | Value | Description |
|------|------|------:|-------------|
| `OK` | Success | 0 | Operation completed successfully. |
| `ERROR` | Generic error | 1 | Default code for general errors (planner failures, unclassified issues). |
| `INTERNAL` | Internal error | 2 | Indicates a bug — an invariant violation or unexpected state inside the engine. |
| `BUSY` | Busy | 5 | Concurrent update conflict. Retry the transaction. |
| `READONLY` | Read-only | 8 | Attempted write on a read-only table or layer. |
| `NOTFOUND` | Not found | 12 | Table, schema, assertion, or other named entity not found. |
| `CONSTRAINT` | Constraint violation | 19 | UNIQUE, NOT NULL, or CHECK constraint violated. Used by `ConstraintError`. |
| `MISMATCH` | Type mismatch | 20 | Value cannot be coerced to the required type (e.g., cast failures, type validation). |
| `MISUSE` | API misuse | 21 | Consumer violated API contract (e.g., using a finalized statement). Used by `MisuseError`. |
| `SYNTAX` | Syntax error | 29 | SQL syntax error (usually surfaced as `ParseError`). |
| `UNSUPPORTED` | Unsupported | 30 | Feature or SQL construct not implemented in Quereus. |
| `FORMAT` | Format error | 24 | Malformed VTab access plan output (invalid constraint usage, negative costs). |

### Reserved / Rare Codes

These codes exist for SQLite compatibility but are uncommon in practice:

| Code | Name | Value | Description |
|------|------|------:|-------------|
| `PERM` | Permission denied | 3 | Access permission denied. |
| `ABORT` | Abort | 4 | Operation aborted. |
| `LOCKED` | Locked | 6 | Resource locked. |
| `NOMEM` | Out of memory | 7 | Memory allocation failed. |
| `INTERRUPT` | Interrupted | 9 | Operation interrupted. |
| `IOERR` | I/O error | 10 | Disk or storage I/O failure. |
| `CORRUPT` | Corrupt | 11 | Database or data structure corruption detected. |
| `FULL` | Full | 13 | Storage full. |
| `CANTOPEN` | Cannot open | 14 | Unable to open a resource. |
| `PROTOCOL` | Protocol error | 15 | Protocol-level error. |
| `EMPTY` | Empty | 16 | Internal: empty result. |
| `SCHEMA` | Schema changed | 17 | Schema has changed since the statement was prepared. |
| `TOOBIG` | Too big | 18 | Value or result exceeds size limits. |
| `NOLFS` | No large file support | 22 | Large file support unavailable. |
| `AUTH` | Authorization | 23 | Authorization denied. |
| `RANGE` | Range error | 25 | Parameter index out of range. |
| `NOTADB` | Not a database | 26 | File is not a valid database. |
| `NOTICE` | Notice | 27 | Informational notice. |
| `WARNING` | Warning | 28 | Non-fatal warning. |

## Error Utilities

*   **`quereusError(message, code?, cause?, astNode?)`** — Helper that throws a `QuereusError`, automatically extracting `line`/`column` from an AST node's `loc` property.
*   **`unwrapError(error)`** — Recursively unwraps an error and its causes into an `ErrorInfo[]` chain.
*   **`formatErrorChain(chain, includeStack?)`** — Formats an error chain for display, showing "Error: ..." / "Caused by: ..." lines.
*   **`getPrimaryError(error)`** — Gets the `ErrorInfo` for the primary (outermost) error.

This structure allows consumers to access specific details about the error, including its origin and potential root cause, facilitating better error reporting and debugging. For practical error handling patterns in application code, see the [Usage Guide](usage.md#error-handling).

## Error Chain Examples

Quereus errors support cause chaining — when the engine wraps an external or lower-level error, the original is preserved as `cause`. The utility functions in `src/common/errors.ts` make it easy to inspect the full chain.

### Unwrapping an Error Chain

```typescript
import { unwrapError } from 'quereus';

try {
	await db.exec('insert into users (id, name) values (1, "Alice")');
} catch (err) {
	if (err instanceof Error) {
		const chain = unwrapError(err);
		for (const info of chain) {
			console.log(`[${info.name}] ${info.message}`);
			if (info.code !== undefined) console.log(`  code: ${info.code}`);
			if (info.line !== undefined) console.log(`  at line ${info.line}, column ${info.column}`);
		}
	}
}
```

`unwrapError()` returns an `ErrorInfo[]` array starting with the outermost error and walking down through each `cause`.

### Formatting for Display

```typescript
import { unwrapError, formatErrorChain } from 'quereus';

try {
	await stmt.run();
} catch (err) {
	if (err instanceof Error) {
		const chain = unwrapError(err);
		console.error(formatErrorChain(chain));
		// Error: Error in VTab users.update: UNIQUE constraint failed
		// Caused by: UNIQUE constraint failed: users.id

		// Include stack traces:
		console.error(formatErrorChain(chain, true));
	}
}
```

### Getting the Primary Error

```typescript
import { getPrimaryError } from 'quereus';

try {
	await db.exec(query);
} catch (err) {
	if (err instanceof Error) {
		const primary = getPrimaryError(err);
		console.log(primary.message); // outermost error message
		console.log(primary.code);    // StatusCode value
	}
}
```

### Wrapping External Errors with Context

When implementing UDFs or VTab methods, wrap external errors to preserve the chain:

```typescript
import { QuereusError, StatusCode } from 'quereus';

function myFunction(args) {
	try {
		return externalLibrary.compute(args[0]);
	} catch (err) {
		throw new QuereusError(
			'Failed to compute value in myFunction',
			StatusCode.ERROR,
			err instanceof Error ? err : new Error(String(err))
		);
	}
}
```

The engine automatically wraps errors thrown by UDFs and VTab methods, but explicit wrapping lets you add domain-specific context messages.

## Common Error Patterns

### Syntax Errors (Parsing Phase)

Thrown as `ParseError` when the SQL text cannot be parsed. The error carries the offending `Token` with position info.

```typescript
import { ParseError } from 'quereus';

try {
	await db.exec('selec * from users');
} catch (err) {
	if (err instanceof ParseError) {
		// err.token — the token where parsing failed
		// err.line, err.column — position in the SQL text
		// err.code === StatusCode.ERROR
	}
}
```

### Semantic Errors (Planning Phase)

Thrown as `QuereusError` with `StatusCode.ERROR` when the planner detects issues like missing tables, ambiguous column references, or type mismatches. These include line/column from the AST node when available.

```typescript
try {
	await db.exec('select * from nonexistent_table');
} catch (err) {
	// QuereusError: Table 'nonexistent_table' not found (at line 1, column 15)
	// err.code === StatusCode.ERROR
}
```

### Constraint Violations (Data Layer)

Thrown as `ConstraintError` with `StatusCode.CONSTRAINT` when a UNIQUE, NOT NULL, or CHECK constraint is violated during insert/update.

```typescript
import { ConstraintError, StatusCode } from 'quereus';

try {
	await db.exec('insert into users (id, name) values (1, "Duplicate")');
} catch (err) {
	if (err instanceof ConstraintError) {
		// err.code === StatusCode.CONSTRAINT
		console.log(err.message); // "UNIQUE constraint failed: users.id"
	}
}
```

### API Misuse (Contract Violations)

Thrown as `MisuseError` with `StatusCode.MISUSE` when the consumer violates the API contract — for example, calling methods on a finalized statement or closed database.

```typescript
import { MisuseError } from 'quereus';

try {
	await stmt.finalize();
	await stmt.run(); // statement already finalized
} catch (err) {
	if (err instanceof MisuseError) {
		// err.code === StatusCode.MISUSE
	}
}
```

### Runtime Errors from UDFs and VTabs

When an error occurs inside a User-Defined Function or Virtual Table method, the runtime wraps it in a `QuereusError` with a context message like `"Error in function X:"` or `"Error in VTab Y.query:"`. The original error is preserved as `cause`.

```typescript
import { unwrapError, formatErrorChain } from 'quereus';

try {
	await db.exec('select my_udf(col) from data');
} catch (err) {
	if (err instanceof Error) {
		const chain = unwrapError(err);
		// chain[0]: QuereusError "Error in function my_udf: ..."
		// chain[1]: original error thrown inside the UDF
		console.error(formatErrorChain(chain));
	}
}
```
