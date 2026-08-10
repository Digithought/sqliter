import { StatusCode } from './types.js';

/**
 * Base class for Quereus specific errors
 * Provides location information and status code support
 */
export class QuereusError extends Error {
	public code: number;
	public line?: number;
	public column?: number;

	constructor(message: string, code: number = StatusCode.ERROR, cause?: Error, line?: number, column?: number) {
		super(message, { cause });
		this.code = code;
		this.name = 'QuereusError';
		this.line = line;
		this.column = column;

		// Enhance message with location if available
		if (line !== undefined && column !== undefined) {
			this.message = `${message} (at line ${line}, column ${column})`;
		}

		// Maintain stack trace in V8
		if (Error.captureStackTrace) {
			Error.captureStackTrace(this, QuereusError);
		}
	}
}

/**
 * Error thrown when a database constraint is violated
 */
export class ConstraintError extends QuereusError {
	constructor(message: string, code: number = StatusCode.CONSTRAINT, cause?: Error) {
		super(message, code, cause);
		this.name = 'ConstraintError';
		Object.setPrototypeOf(this, ConstraintError.prototype);
	}
}

/**
 * Constraint violation that resolved to OR FAIL.
 *
 * Per SQLite OR FAIL semantics: rows successfully processed before the
 * violation must remain inserted/updated even though the statement aborts.
 * The iterator-level cleanup recognizes this subclass and commits prior
 * rows (in autocommit mode) instead of rolling back.
 */
export class FailConflictError extends ConstraintError {
	constructor(message: string, code: number = StatusCode.CONSTRAINT, cause?: Error) {
		super(message, code, cause);
		this.name = 'FailConflictError';
		Object.setPrototypeOf(this, FailConflictError.prototype);
	}
}

/**
 * Constraint violation that resolved to OR ROLLBACK.
 *
 * Per SQLite OR ROLLBACK semantics: the violation aborts the entire
 * enclosing transaction (explicit or implicit). The iterator-level cleanup
 * recognizes this subclass and unconditionally rolls back the transaction.
 */
export class RollbackConflictError extends ConstraintError {
	constructor(message: string, code: number = StatusCode.CONSTRAINT, cause?: Error) {
		super(message, code, cause);
		this.name = 'RollbackConflictError';
		Object.setPrototypeOf(this, RollbackConflictError.prototype);
	}
}

/**
 * Error thrown when a statement names a table or view that does not resolve —
 * the object is absent, or the schema qualifying it is not attached.
 *
 * Distinct from the generic `QuereusError` so callers can positively recognise
 * "the relation is not there" without matching message text. Deliberately scoped
 * to *relations* only: a missing column, function, parameter, or tag is a
 * different failure and must not be reported through this class, since callers
 * use it to decide that "no such row" is an observed fact rather than a failed
 * lookup.
 *
 * Carries `StatusCode.NOTFOUND`, but note that code is shared with several
 * unrelated absent-object errors — the class / `name` is the discriminator.
 */
export class RelationNotFoundError extends QuereusError {
	constructor(message: string, cause?: Error, line?: number, column?: number) {
		super(message, StatusCode.NOTFOUND, cause, line, column);
		this.name = 'RelationNotFoundError';
		Object.setPrototypeOf(this, RelationNotFoundError.prototype);
	}
}

/**
 * Error thrown when an in-flight statement is cancelled via an `AbortSignal`
 * (e.g. a request-timeout). Extends `QuereusError` (so it survives the engine's
 * `instanceof QuereusError` re-throw paths unchanged) while exposing the web
 * convention `name === 'AbortError'` for callers that match on that.
 */
export class AbortError extends QuereusError {
	constructor(message: string = 'Operation aborted', cause?: Error) {
		super(message, StatusCode.ABORT, cause);
		this.name = 'AbortError';
		Object.setPrototypeOf(this, AbortError.prototype);
	}
}

/**
 * Cooperative-cancellation checkpoint. Throws an {@link AbortError} when the
 * supplied signal has already been aborted; a no-op when the signal is absent
 * or still active. Called at row and statement boundaries during execution.
 *
 * The signal's `reason` (if any) is preserved: an `Error` reason becomes the
 * thrown error's `cause`, and a string reason becomes its message.
 */
export function throwIfAborted(signal?: AbortSignal): void {
	if (!signal?.aborted) return;
	const reason = (signal as { reason?: unknown }).reason;
	if (reason instanceof Error) {
		throw new AbortError(reason.message, reason);
	}
	throw new AbortError(typeof reason === 'string' ? reason : 'Operation aborted');
}

/**
 * Type guard recognizing cancellation errors. Returns `true` for our own
 * {@link AbortError} and for any foreign error that follows the web convention
 * `name === 'AbortError'` (e.g. a platform `DOMException` raised by a fetch /
 * stream abort), so callers can classify cancellation uniformly regardless of
 * which layer produced it.
 */
export function isAbortError(e: unknown): boolean {
	return e instanceof AbortError || (e instanceof Error && e.name === 'AbortError');
}

/**
 * Error thrown when the API is used incorrectly
 */
export class MisuseError extends QuereusError {
	constructor(message: string = 'API misuse', cause?: Error) {
		super(message, StatusCode.MISUSE, cause);
		this.name = 'MisuseError';
		Object.setPrototypeOf(this, MisuseError.prototype);
	}
}

/**
 * Helper function to throw a QuereusError with optional location information from AST nodes
 * @param message Error message
 * @param code Status code (defaults to ERROR)
 * @param cause Optional underlying error
 * @param astNode Optional AST node or object with location information
 * @returns Never (always throws)
 */
export function quereusError(
	message: string,
	code: StatusCode = StatusCode.ERROR,
	cause?: Error,
	astNode?: { loc?: { start: { line: number; column: number }, end?: { line: number; column: number } } }
): never {
	throw new QuereusError(
		message,
		code,
		cause,
		astNode?.loc?.start.line,
		astNode?.loc?.start.column
	);
}

/**
 * Information about an error in the error chain
 */
export interface ErrorInfo {
	message: string;
	code?: number;
	line?: number;
	column?: number;
	name: string;
	stack?: string;
}

/**
 * Recursively unwraps a QuereusError (or any Error) and its causes
 * @param error The error to unwrap
 * @returns Array of ErrorInfo objects, with the root error first
 */
export function unwrapError(error: Error): ErrorInfo[] {
	const errorChain: ErrorInfo[] = [];
	let currentError: Error | undefined = error;

	while (currentError) {
		const errorInfo: ErrorInfo = {
			message: currentError.message,
			name: currentError.name,
			stack: currentError.stack,
		};

		// Add QuereusError-specific fields if available
		if (currentError instanceof QuereusError) {
			errorInfo.code = currentError.code;
			errorInfo.line = currentError.line;
			errorInfo.column = currentError.column;
		}

		errorChain.push(errorInfo);

		// Move to the next error in the chain
		currentError = (currentError as Error & { cause?: Error }).cause;
	}

	return errorChain;
}

/**
 * Formats an error chain for display
 * @param errorChain Array of ErrorInfo objects
 * @param includeStack Whether to include stack traces
 * @returns Formatted error message
 */
export function formatErrorChain(errorChain: ErrorInfo[], includeStack: boolean = false): string {
	if (errorChain.length === 0) {
		return 'Unknown error';
	}

	const lines: string[] = [];

	errorChain.forEach((errorInfo, index) => {
		const prefix = index === 0 ? 'Error' : `Caused by`;
		let line = `${prefix}: ${errorInfo.message}`;

		if (errorInfo.line !== undefined && errorInfo.column !== undefined) {
			line += ` (at line ${errorInfo.line}, column ${errorInfo.column})`;
		}

		lines.push(line);

		if (includeStack && errorInfo.stack) {
			lines.push(errorInfo.stack);
		}
	});

	return lines.join('\n');
}

/**
 * Gets the primary error info (the first error in the chain)
 * @param error The error to analyze
 * @returns ErrorInfo for the primary error
 */
export function getPrimaryError(error: Error): ErrorInfo {
	const chain = unwrapError(error);
	return chain[0] || {
		message: 'Unknown error',
		name: 'Error',
	};
}
