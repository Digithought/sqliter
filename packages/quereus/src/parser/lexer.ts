export enum TokenType {
	// Literals
	INTEGER = 'INTEGER',
	FLOAT = 'FLOAT',
	STRING = 'STRING',
	IDENTIFIER = 'IDENTIFIER',
	BLOB = 'BLOB',

	// Keywords
	SELECT = 'SELECT',
	FROM = 'FROM',
	WHERE = 'WHERE',
	INSERT = 'INSERT',
	UPDATE = 'UPDATE',
	DELETE = 'DELETE',
	CREATE = 'CREATE',
	DROP = 'DROP',
	ALTER = 'ALTER',
	TABLE = 'TABLE',
	INDEX = 'INDEX',
	VIEW = 'VIEW',
	ASSERTION = 'ASSERTION',
	TEMP = 'TEMP',
	TEMPORARY = 'TEMPORARY',
	VIRTUAL = 'VIRTUAL',
	USING = 'USING',
	INTO = 'INTO',
	NULL = 'NULL',
	TRUE = 'TRUE',
	FALSE = 'FALSE',
	NOT = 'NOT',
	AND = 'AND',
	OR = 'OR',
	IN = 'IN',
	LIKE = 'LIKE',
	BETWEEN = 'BETWEEN',
	IS = 'IS',
	AS = 'AS',
	DISTINCT = 'DISTINCT',
	GROUP = 'GROUP',
	BY = 'BY',
	HAVING = 'HAVING',
	ORDER = 'ORDER',
	ASC = 'ASC',
	DESC = 'DESC',
	LIMIT = 'LIMIT',
	OFFSET = 'OFFSET',
	UNION = 'UNION',
	INTERSECT = 'INTERSECT',
	EXCEPT = 'EXCEPT',
	DIFF = 'DIFF',
	ALL = 'ALL',
	PRIMARY = 'PRIMARY',
	CONSTRAINT = 'CONSTRAINT',
	GENERATED = 'GENERATED',
	COLLATE = 'COLLATE',
	KEY = 'KEY',
	UNIQUE = 'UNIQUE',
	DEFAULT = 'DEFAULT',
	CHECK = 'CHECK',
	FOREIGN = 'FOREIGN',
	REFERENCES = 'REFERENCES',
	AUTOINCREMENT = 'AUTOINCREMENT',
	ON = 'ON',
	CONFLICT = 'CONFLICT',
	CASCADE = 'CASCADE',
	RESTRICT = 'RESTRICT',
	SET = 'SET',
	NO = 'NO',
	ACTION = 'ACTION',
	RENAME = 'RENAME',
	COLUMN = 'COLUMN',
	TO = 'TO',
	ADD = 'ADD',
	ALWAYS = 'ALWAYS',
	ABORT = 'ABORT',
	FAIL = 'FAIL',
	IGNORE = 'IGNORE',
	BEGIN = 'BEGIN',
	COMMIT = 'COMMIT',
	ROLLBACK = 'ROLLBACK',
	TRANSACTION = 'TRANSACTION',
	DEFERRED = 'DEFERRED',
	IMMEDIATE = 'IMMEDIATE',
	JOIN = 'JOIN',
	INNER = 'INNER',
	LEFT = 'LEFT',
	RIGHT = 'RIGHT',
	FULL = 'FULL',
	CROSS = 'CROSS',
	OUTER = 'OUTER',
	NATURAL = 'NATURAL',
	REPLACE = 'REPLACE',
	VALUES = 'VALUES',
	EXISTS = 'EXISTS',
	IF = 'IF',
	DEFERRABLE = 'DEFERRABLE',
	INITIALLY = 'INITIALLY',
	STORED = 'STORED',
	RETURNING = 'RETURNING',
	SAVEPOINT = 'SAVEPOINT',
	RELEASE = 'RELEASE',
	PRAGMA = 'PRAGMA',
	ANALYZE = 'ANALYZE',
	WITH = 'WITH',
	RECURSIVE = 'RECURSIVE',
	XOR = 'XOR',
	CASE = 'CASE',
	WHEN = 'WHEN',
	THEN = 'THEN',
	ELSE = 'ELSE',
	END = 'END',
	CAST = 'CAST',
	OVER = 'OVER',
	PARTITION = 'PARTITION',
	LATERAL = 'LATERAL',
	ROW = 'ROW',
	ROWS = 'ROWS',
	RANGE = 'RANGE',
	UNBOUNDED = 'UNBOUNDED',
	PRECEDING = 'PRECEDING',
	FOLLOWING = 'FOLLOWING',
	CURRENT = 'CURRENT',

	// Declarative schema
	DECLARE = 'DECLARE',
	SCHEMA = 'SCHEMA',
	APPLY = 'APPLY',
	EXPLAIN = 'EXPLAIN',
	VERSION = 'VERSION',
	SEED = 'SEED',

	// Operators and punctuation
	PLUS = 'PLUS',               // +
	MINUS = 'MINUS',             // -
	ASTERISK = 'ASTERISK',       // *
	SLASH = 'SLASH',             // /
	PERCENT = 'PERCENT',         // %
	EQUAL = 'EQUAL',             // =
	EQUAL_EQUAL = 'EQUAL_EQUAL', // == (SQLite allows both = and ==)
	NOT_EQUAL = 'NOT_EQUAL',     // != or <>
	LESS = 'LESS',               // <
	LESS_EQUAL = 'LESS_EQUAL',   // <=
	GREATER = 'GREATER',         // >
	GREATER_EQUAL = 'GREATER_EQUAL', // >=
	LPAREN = 'LPAREN',           // (
	RPAREN = 'RPAREN',           // )
	COMMA = 'COMMA',             // ,
	DOT = 'DOT',                 // .
	SEMICOLON = 'SEMICOLON',     // ;
	TILDE = 'TILDE',             // ~ (for REGEXP)
	PIPE = 'PIPE',               // | (for concatenation or UNION)
	PIPE_PIPE = 'PIPE_PIPE',     // || (for concatenation)
	AMPERSAND = 'AMPERSAND',     // &
	AMPERSAND_AMPERSAND = 'AMPERSAND_AMPERSAND', // &&
	QUESTION = 'QUESTION',       // ? (for parameters)
	COLON = 'COLON',             // : (for named parameters)
	DOLLAR = 'DOLLAR',           // $ (for named parameters)
	ARROW = 'ARROW',             // -> (JSON operator)
	DARROW = 'DARROW',           // ->> (JSON scalar operator)
	LBRACE = 'LBRACE',           // {
	RBRACE = 'RBRACE',           // }

	// Special
	EOF = 'EOF',
	ERROR = 'ERROR'
}

/**
 * The parsed value a token carries beyond its raw {@link Token.lexeme}:
 * - STRING / quoted IDENTIFIER → the unescaped text (`string`)
 * - INTEGER → `number` (safe range) or `bigint` (overflow)
 * - FLOAT → the original numeric text (`string`; parsed to a number at AST build)
 * - BLOB → the decoded bytes (`Uint8Array`)
 *
 * All other token types carry no literal (`undefined`).
 */
export type TokenLiteral = string | number | bigint | Uint8Array;

// Token represents a lexical token from the SQL input
export interface Token {
	type: TokenType;
	lexeme: string;
	literal?: TokenLiteral;
	startLine: number;
	startColumn: number;
	startOffset: number;
	endLine: number;
	endColumn: number;
	endOffset: number;
}

// Reserved keywords mapping
export const KEYWORDS: Record<string, TokenType> = {
	'select': TokenType.SELECT,
	'from': TokenType.FROM,
	'where': TokenType.WHERE,
	'insert': TokenType.INSERT,
	'update': TokenType.UPDATE,
	'delete': TokenType.DELETE,
	'create': TokenType.CREATE,
	'drop': TokenType.DROP,
	'alter': TokenType.ALTER,
	'table': TokenType.TABLE,
	'index': TokenType.INDEX,
	'view': TokenType.VIEW,
	'assertion': TokenType.ASSERTION,
	'virtual': TokenType.VIRTUAL,
	'using': TokenType.USING,
	'null': TokenType.NULL,
	'true': TokenType.TRUE,
	'false': TokenType.FALSE,
	'not': TokenType.NOT,
	'and': TokenType.AND,
	'or': TokenType.OR,
	'in': TokenType.IN,
	'like': TokenType.LIKE,
	'between': TokenType.BETWEEN,
	'is': TokenType.IS,
	'as': TokenType.AS,
	'distinct': TokenType.DISTINCT,
	'group': TokenType.GROUP,
	'by': TokenType.BY,
	'having': TokenType.HAVING,
	'order': TokenType.ORDER,
	'asc': TokenType.ASC,
	'desc': TokenType.DESC,
	'limit': TokenType.LIMIT,
	'offset': TokenType.OFFSET,
	'union': TokenType.UNION,
	'diff': TokenType.DIFF,
	'all': TokenType.ALL,
	'primary': TokenType.PRIMARY,
	'constraint': TokenType.CONSTRAINT,
	'key': TokenType.KEY,
	'unique': TokenType.UNIQUE,
	'default': TokenType.DEFAULT,
	'check': TokenType.CHECK,
	'collate': TokenType.COLLATE,
	'generated': TokenType.GENERATED,
	'foreign': TokenType.FOREIGN,
	'references': TokenType.REFERENCES,
	'on': TokenType.ON,
	'conflict': TokenType.CONFLICT,
	'cascade': TokenType.CASCADE,
	'restrict': TokenType.RESTRICT,
	'set': TokenType.SET,
	'autoincrement': TokenType.AUTOINCREMENT,
	'no': TokenType.NO,
	'action': TokenType.ACTION,
	'begin': TokenType.BEGIN,
	'commit': TokenType.COMMIT,
	'rollback': TokenType.ROLLBACK,
	'transaction': TokenType.TRANSACTION,
	'deferred': TokenType.DEFERRED,
	'immediate': TokenType.IMMEDIATE,
	'deferrable': TokenType.DEFERRABLE,
	'initially': TokenType.INITIALLY,
	'stored': TokenType.STORED,
	'returning': TokenType.RETURNING,
	'join': TokenType.JOIN,
	'inner': TokenType.INNER,
	'left': TokenType.LEFT,
	'right': TokenType.RIGHT,
	'full': TokenType.FULL,
	'cross': TokenType.CROSS,
	'outer': TokenType.OUTER,
	'natural': TokenType.NATURAL,
	'replace': TokenType.REPLACE,
	'values': TokenType.VALUES,
	'exists': TokenType.EXISTS,
	'if': TokenType.IF,
	'into': TokenType.INTO,
	'temp': TokenType.TEMP,
	'temporary': TokenType.TEMPORARY,
	'rename': TokenType.RENAME,
	'to': TokenType.TO,
	'add': TokenType.ADD,
	'always': TokenType.ALWAYS,
	'abort': TokenType.ABORT,
	'fail': TokenType.FAIL,
	'ignore': TokenType.IGNORE,
	'savepoint': TokenType.SAVEPOINT,
	'release': TokenType.RELEASE,
	'pragma': TokenType.PRAGMA,
	'analyze': TokenType.ANALYZE,
	'with': TokenType.WITH,
	'recursive': TokenType.RECURSIVE,
	'xor': TokenType.XOR,
	'case': TokenType.CASE,
	'when': TokenType.WHEN,
	'then': TokenType.THEN,
	'else': TokenType.ELSE,
	'end': TokenType.END,
	'cast': TokenType.CAST,
	'over': TokenType.OVER,
	'partition': TokenType.PARTITION,
	'lateral': TokenType.LATERAL,
	'row': TokenType.ROW,
	'rows': TokenType.ROWS,
	'range': TokenType.RANGE,
	'unbounded': TokenType.UNBOUNDED,
	'preceding': TokenType.PRECEDING,
	'following': TokenType.FOLLOWING,
	'current': TokenType.CURRENT,
	'intersect': TokenType.INTERSECT,
	'except': TokenType.EXCEPT,
	'declare': TokenType.DECLARE,
	// Note: schema, version, seed deliberately NOT reserved here - treated as contextual keywords
	// to avoid breaking schema() function calls and column names like 'version', 'seed'
	'apply': TokenType.APPLY,
	'explain': TokenType.EXPLAIN,
};

/**
 * Reserved words that the lexer tokenizes specially but which SQL still permits as
 * identifiers in most contexts (table/column/alias names, function names, etc.).
 * Shared by the parser (the many `consumeIdentifier(CONTEXTUAL_KEYWORDS, …)` sites)
 * and the emitter (which must know that, e.g., `like(…)` re-parses bare so it should
 * not be quoted). Lives next to KEYWORDS so the two classifications stay together;
 * callers needing extras spread it, e.g. `[...CONTEXTUAL_KEYWORDS, 'replace']`.
 */
export const CONTEXTUAL_KEYWORDS = ['key', 'action', 'set', 'default', 'check', 'unique', 'references', 'on', 'cascade', 'restrict', 'like'] as const;

/**
 * Lexer class for tokenizing SQL statements
 */
export class Lexer {
	private source: string;
	private tokens: Token[] = [];
	private start = 0;
	private current = 0;
	private line = 1;
	private column = 1;
	private startLine = 1;
	private startColumn = 1;

	constructor(source: string) {
		this.source = source;
	}

	/**
	 * Scans the input and returns all tokens.
	 */
	scanTokens(): Token[] {
		while (!this.isAtEnd()) {
			this.start = this.current;
			this.startLine = this.line;
			this.startColumn = this.column;
			this.scanToken();
		}

		this.tokens.push({
			type: TokenType.EOF,
			lexeme: '',
			startLine: this.line,
			startColumn: this.column,
			startOffset: this.source.length,
			endLine: this.line,
			endColumn: this.column,
			endOffset: this.source.length,
		});

		return this.tokens;
	}

	private isAtEnd(): boolean {
		return this.current >= this.source.length;
	}

	private scanToken(): void {
		const c = this.advance();

		switch (c) {
			// Single-character tokens
			case '(': this.addToken(TokenType.LPAREN); break;
			case ')': this.addToken(TokenType.RPAREN); break;
			case '{': this.addToken(TokenType.LBRACE); break;
			case '}': this.addToken(TokenType.RBRACE); break;
			case ',': this.addToken(TokenType.COMMA); break;
			case '.': this.addToken(TokenType.DOT); break;
			case ';': this.addToken(TokenType.SEMICOLON); break;
			case '+': this.addToken(TokenType.PLUS); break;
			case '-':
				if (this.match('-')) {
					// SQL-style line comment
					while (this.peek() !== '\n' && !this.isAtEnd()) {
						this.advance();
					}
				} else if (this.match('>')) {
					this.addToken(this.match('>') ? TokenType.DARROW : TokenType.ARROW);
				} else {
					this.addToken(TokenType.MINUS);
				}
				break;
			case '*': this.addToken(TokenType.ASTERISK); break;
			case '/':
				if (this.match('/')) {
					// Single line comment
					while (this.peek() !== '\n' && !this.isAtEnd()) {
						this.advance();
					}
				} else if (this.match('*')) {
					// Multiline comment
					this.multilineComment();
				} else {
					this.addToken(TokenType.SLASH);
				}
				break;
			case '%': this.addToken(TokenType.PERCENT); break;
			case '~': this.addToken(TokenType.TILDE); break;
			case '?': this.addToken(TokenType.QUESTION); break;
			case ':': this.addToken(TokenType.COLON); break;
			case '$': this.addToken(TokenType.DOLLAR); break;

			// One or two character tokens
			case '=':
				this.addToken(this.match('=') ? TokenType.EQUAL_EQUAL : TokenType.EQUAL);
				break;
			case '!':
				this.addToken(this.match('=') ? TokenType.NOT_EQUAL : TokenType.ERROR);
				break;
			case '<':
				if (this.match('=')) {
					this.addToken(TokenType.LESS_EQUAL);
				} else if (this.match('>')) {
					this.addToken(TokenType.NOT_EQUAL);
				} else {
					this.addToken(TokenType.LESS);
				}
				break;
			case '>':
				this.addToken(this.match('=') ? TokenType.GREATER_EQUAL : TokenType.GREATER);
				break;
			case '|':
				this.addToken(this.match('|') ? TokenType.PIPE_PIPE : TokenType.PIPE);
				break;
			case '&':
				this.addToken(this.match('&') ? TokenType.AMPERSAND_AMPERSAND : TokenType.AMPERSAND);
				break;

			// String literals
			case '\'': this.string('\''); break;
			// Double-quoted strings are identifiers in SQL standard and SQLite
			case '"': this.doubleQuotedIdentifier(); break;
			case '`': this.backtickIdentifier(); break;
			case '[': this.bracketIdentifier(); break;

			// Blob literals
			case 'x':
			case 'X':
				if (this.match('\'')) {
					this.blobLiteral();
				} else {
					this.identifier();
				}
				break;

			// Whitespace
			case ' ':
			case '\r':
			case '\t':
				// Ignore whitespace
				break;
			case '\n':
				// Newline handling already done in advance()
				break;

			// Default - handle identifiers and numbers
			default:
				if (this.isDigit(c)) {
					this.number();
				} else if (this.isAlpha(c)) {
					this.identifier();
				} else {
					this.addErrorToken(`Unexpected character: ${c}`);
				}
				break;
		}
	}

	private advance(): string {
		const char = this.source.charAt(this.current);
		this.current++;
		if (char === '\n') {
			this.line++;
			this.column = 1;
		} else {
			this.column++;
		}
		return char;
	}

	private match(expected: string): boolean {
		if (this.isAtEnd()) return false;
		if (this.source.charAt(this.current) !== expected) return false;

		this.current++;
		this.column++;
		return true;
	}

	private peek(): string {
		if (this.isAtEnd()) return '\0';
		return this.source.charAt(this.current);
	}

	private peekNext(): string {
		if (this.current + 1 >= this.source.length) return '\0';
		return this.source.charAt(this.current + 1);
	}

	private string(quote: string): void {
		// SQL standard: characters between the quotes are preserved verbatim,
		// with one exception — a doubled quote ('') represents a single literal
		// quote. Backslash has no special meaning.
		//
		// Each unbroken run (no doubled quote) is taken in a single slice rather than
		// accumulated character-by-character; the common no-escape string is one slice.
		// `advance()` still walks each char so line/column tracking stays exact across
		// embedded newlines.
		let value = '';

		while (true) {
			const runStart = this.current;
			while (!this.isAtEnd() && this.peek() !== quote) {
				this.advance();
			}
			value += this.source.substring(runStart, this.current);

			if (this.isAtEnd()) {
				this.addErrorToken("Unterminated string.");
				return;
			}

			// Consume the closing quote
			this.advance();

			// Doubled quote: append a literal quote and keep scanning.
			if (this.peek() === quote) {
				value += quote;
				this.advance();
			} else {
				break;
			}
		}

		this.addToken(TokenType.STRING, value);
	}

	private backtickIdentifier(): void {
		// No escape sequence — the whole run is a single slice.
		const contentStart = this.current;

		while (!this.isAtEnd() && this.peek() !== '`') {
			this.advance();
		}

		if (this.isAtEnd()) {
			this.addErrorToken("Unterminated identifier.");
			return;
		}

		const value = this.source.substring(contentStart, this.current);

		// Consume the closing backtick
		this.advance();

		this.addToken(TokenType.IDENTIFIER, value);
	}

	/**
	 * Parse double-quoted identifiers.
	 * In SQL standard and SQLite, double quotes delimit identifiers (not strings).
	 * Supports "" escape for embedded double quotes.
	 */
	private doubleQuotedIdentifier(): void {
		// Each run up to a `"` is taken in one slice; a doubled `""` is a literal
		// quote and continues the identifier (the common no-escape case is one slice).
		let value = '';

		while (!this.isAtEnd()) {
			const runStart = this.current;
			while (!this.isAtEnd() && this.peek() !== '"') {
				this.advance();
			}
			value += this.source.substring(runStart, this.current);

			if (this.isAtEnd()) break; // Unterminated — handled below.

			// At a `"`. A doubled `""` is an escaped literal quote; otherwise it ends.
			if (this.peekNext() === '"') {
				value += '"';
				this.advance(); // First "
				this.advance(); // Second "
			} else {
				break; // End of identifier
			}
		}

		if (this.isAtEnd()) {
			this.addErrorToken("Unterminated identifier.");
			return;
		}

		// Consume the closing double quote
		this.advance();

		this.addToken(TokenType.IDENTIFIER, value);
	}

	private bracketIdentifier(): void {
		// No escape sequence — the whole run is a single slice.
		const contentStart = this.current;

		while (!this.isAtEnd() && this.peek() !== ']') {
			this.advance();
		}

		if (this.isAtEnd()) {
			this.addErrorToken("Unterminated identifier.");
			return;
		}

		const value = this.source.substring(contentStart, this.current);

		// Consume the closing bracket
		this.advance();

		this.addToken(TokenType.IDENTIFIER, value);
	}

	private blobLiteral(): void {
		let value = '';

		while (!this.isAtEnd() && this.peek() !== '\'') {
			if (this.isHexDigit(this.peek())) {
				value += this.advance();
			} else if (this.isWhitespace(this.peek())) {
				this.advance(); // Skip whitespace in blob literals
			} else {
				this.addErrorToken("Invalid character in blob literal.");
				return;
			}
		}

		if (this.isAtEnd()) {
			this.addErrorToken("Unterminated blob literal.");
			return;
		}

		// Consume the closing quote
		this.advance();

		// Validate hex string length
		if (value.length % 2 !== 0) {
			this.addErrorToken("Blob literal must have an even number of hex digits.");
			return;
		}

		// Convert hex string to Uint8Array
		try {
			const bytes = new Uint8Array(value.length / 2);
			for (let i = 0; i < value.length; i += 2) {
				bytes[i / 2] = parseInt(value.substring(i, i + 2), 16);
			}
			this.addToken(TokenType.BLOB, bytes);
		} catch {
			this.addErrorToken("Invalid blob literal.");
		}
	}

	private number(): void {
		let isFloat = false;
		// Capture original lexeme starting from the first digit
		const start = this.start; // Use the start offset saved before scanToken called number()

		// Consume digits before decimal point
		while (this.isDigit(this.peek())) {
			this.advance();
		}

		// Check for decimal point
		if (this.peek() === '.' && this.isDigit(this.peekNext())) {
			isFloat = true;
			this.advance(); // Consume the '.'

			// Consume digits after decimal point
			while (this.isDigit(this.peek())) {
				this.advance();
			}
		}

		// Check for exponent part
		if (this.peek().toLowerCase() === 'e') {
			isFloat = true;
			this.advance(); // Consume the 'e' or 'E'

			// Optional sign
			if (this.peek() === '+' || this.peek() === '-') {
				this.advance();
			}

			// Exponent digits
			if (!this.isDigit(this.peek())) {
				this.addErrorToken("Invalid number literal: expected digits after exponent.");
				return;
			}

			while (this.isDigit(this.peek())) {
				this.advance();
			}
		}

		const lexeme = this.source.substring(start, this.current);

		if (isFloat) {
			// Store original string as literal for FLOAT
			this.addToken(TokenType.FLOAT, lexeme);
		} else {
			// For integers, parse now to handle potential BigInt. `lexeme` is an
			// all-digit run, so `parseInt` never returns NaN or throws — only the
			// safe-integer overflow into BigInt needs guarding.
			const num = parseInt(lexeme, 10);
			if (!Number.isSafeInteger(num)) {
				try {
					this.addToken(TokenType.INTEGER, BigInt(lexeme));
				} catch {
					this.addErrorToken("Integer literal too large.");
				}
			} else {
				this.addToken(TokenType.INTEGER, num);
			}
		}
	}

	private identifier(): void {
		while (this.isAlphaNumeric(this.peek())) {
			this.advance();
		}

		// Check if the identifier is a keyword
		const text = this.source.substring(this.start, this.current).toLowerCase();
		const type = KEYWORDS[text] || TokenType.IDENTIFIER;

		this.addToken(type);
	}

	private multilineComment(): void {
		let nesting = 1;  // Support nested comments

		while (nesting > 0 && !this.isAtEnd()) {
			if (this.peek() === '/' && this.peekNext() === '*') {
				this.advance(); // Consume '/'
				this.advance(); // Consume '*'
				nesting++;
			} else if (this.peek() === '*' && this.peekNext() === '/') {
				this.advance(); // Consume '*'
				this.advance(); // Consume '/'
				nesting--;
			} else {
				// Advance one character and let advance() maintain line/column
				this.advance();
			}
		}

		if (nesting > 0) {
			this.addErrorToken("Unterminated comment.");
		}
	}

	private isDigit(c: string): boolean {
		return c >= '0' && c <= '9';
	}

	private isHexDigit(c: string): boolean {
		return (c >= '0' && c <= '9') ||
			(c >= 'a' && c <= 'f') ||
			(c >= 'A' && c <= 'F');
	}

	private isAlpha(c: string): boolean {
		return (c >= 'a' && c <= 'z') ||
			(c >= 'A' && c <= 'Z') ||
			c === '_';
	}

	private isAlphaNumeric(c: string): boolean {
		return this.isAlpha(c) || this.isDigit(c);
	}

	private isWhitespace(c: string): boolean {
		return c === ' ' || c === '\r' || c === '\n' || c === '\t';
	}

	private addToken(type: TokenType, literal?: TokenLiteral): void {
		const lexeme = this.source.substring(this.start, this.current);
		this.tokens.push({
			type,
			lexeme, // Ensure lexeme is always the original string
			literal,
			startLine: this.startLine,
			startColumn: this.startColumn,
			startOffset: this.start,
			endLine: this.line,
			endColumn: this.column -1,
			endOffset: this.current,
		});
	}

	private addErrorToken(message: string): void {
		this.tokens.push({
			type: TokenType.ERROR,
			lexeme: message,
			startLine: this.line,
			startColumn: this.column -1,
			startOffset: this.current -1,
			endLine: this.line,
			endColumn: this.column -1,
			endOffset: this.current,
		});
	}
}
