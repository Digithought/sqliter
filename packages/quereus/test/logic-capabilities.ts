/**
 * `-- requires-capability:` directive support for the `.sqllogic` corpus.
 *
 * `test/logic/*.sqllogic` is a shared corpus: other projects run the same files against
 * their own storage engine. When a file's *subject* is a feature a backend deliberately
 * does not implement, that backend should skip the file — without every consumer
 * hand-maintaining an O(corpus) list of file names.
 *
 * So the declaration lives in the file ("this file needs feature X") and each harness
 * declares once which features its backend has. The format is the cross-repo contract and
 * is specified in `test/README.md` § `-- requires-capability:` directive; downstream
 * harnesses reimplement this parse against that spec.
 *
 * This module is deliberately pure string-in / data-out with no engine imports, so it stays
 * trivially portable and unit-testable.
 *
 * NOT to be confused with `src/vtab/capabilities.ts`'s `ModuleCapabilities` — that is a
 * *runtime* interface a virtual-table module advertises to the engine. This is a
 * *test-harness* concept about whole SQL statements a backend accepts. See test/README.md.
 */

/**
 * Capability tokens a `.sqllogic` file may declare. Closed set — an unknown token is a hard
 * error, so a downstream backend cannot mint private tokens and every consumer of the corpus
 * agrees on what the tokens mean. See test/README.md for how to add a member.
 */
export const SQLLOGIC_CAPABILITIES = {
	'standalone-index-ddl':
		'`create index` / `create unique index` / `drop index` as standalone statements',
} as const;

export type SqllogicCapability = keyof typeof SQLLOGIC_CAPABILITIES;

/** Canonical directive line, e.g. `-- requires-capability: standalone-index-ddl`. */
const DIRECTIVE_RE = /^--\s*requires-capability\s*:\s*(.*)$/i;

/**
 * Anything that *looks* like the directive. `logic.spec.ts`'s main loop `continue`s past every
 * unrecognized `--` line, so without this guard a typo'd directive (`-- require-capability:`,
 * `-- requires_capability:`) would vanish silently and the file would run with nobody the wiser.
 * Matches on the canonical form too — check `DIRECTIVE_RE` first.
 *
 * NOTE: deliberately loose, so it also fires on prose that merely opens a comment line with
 * "requires capability" / "required capability" (no colon needed). No corpus file trips it today,
 * but the split-out sibling files (`06.3.6-schema-views`, `10.1.2.1-add-constraint-in-transaction`,
 * `10.1.3.1-drop-constraint-in-transaction`) name the directive in their header prose and stay
 * clear only because they backtick-quote it — dropping the backticks would hard-error the file.
 * If a legitimate header comment ever trips it, rephrase the prose — do not narrow this regex,
 * since a narrower one lets a real typo through silently.
 */
const NEAR_MISS_RE = /^--\s*require[sd]?[-_ ]?capabilit/i;

/** Byte-order mark; some corpus files are saved with one. */
const UTF8_BOM = '\uFEFF';

function isCapability(token: string): token is SqllogicCapability {
	return Object.prototype.hasOwnProperty.call(SQLLOGIC_CAPABILITIES, token);
}

function vocabularyList(): string {
	return Object.keys(SQLLOGIC_CAPABILITIES).join(', ');
}

function fail(fileName: string, lineNumber: number, message: string): never {
	throw new Error(`[${fileName}:${lineNumber}] ${message}`);
}

/**
 * Parse every `-- requires-capability:` directive in the file's leading comment block.
 *
 * Granularity is whole-file; there is no section-scoped form. Multiple directive lines union.
 *
 * @throws Error naming `fileName` on an unknown token, an empty token list, a directive after
 *   the first SQL line, or a near-miss spelling of the directive name.
 */
export function parseRequiredCapabilities(
	fileName: string,
	content: string,
): ReadonlySet<SqllogicCapability> {
	const required = new Set<SqllogicCapability>();
	// Strip a UTF-8 BOM so a directive sitting on line 1 still matches.
	const body = content.startsWith(UTF8_BOM) ? content.slice(UTF8_BOM.length) : content;
	// The corpus is edited on Windows; trim() below also clears any stray \r.
	const lines = body.split(/\r?\n/);

	// The leading comment block ends at the first line that is neither blank nor a `--` comment.
	// Blank lines inside it do not terminate it.
	let inLeadingBlock = true;
	let lineNumber = 0;

	for (const line of lines) {
		lineNumber++;
		const trimmed = line.trim();

		if (trimmed === '') continue;

		if (!trimmed.startsWith('--')) {
			// First SQL line — the block is over, but keep scanning so a late directive
			// (or a near miss) still fails loudly rather than being silently ignored.
			inLeadingBlock = false;
			continue;
		}

		const match = DIRECTIVE_RE.exec(trimmed);
		if (match) {
			if (!inLeadingBlock) {
				fail(fileName, lineNumber,
					`\`-- requires-capability:\` must appear in the leading comment block, before the first SQL line.`);
			}
			addTokens(fileName, lineNumber, match[1], required);
			continue;
		}

		if (NEAR_MISS_RE.test(trimmed)) {
			fail(fileName, lineNumber,
				`\`${trimmed}\` looks like a capability directive but is not the canonical form. Use \`-- requires-capability: <tokens>\`.`);
		}
	}

	return required;
}

/** Split a directive's token list and fold each token into `required`. */
function addTokens(
	fileName: string,
	lineNumber: number,
	rest: string,
	required: Set<SqllogicCapability>,
): void {
	// Tokens are separated by whitespace and/or commas. There is no trailing-comment form —
	// the whole remainder is tokens, so `-- requires-capability: x -- why` errors on `--`/`why`.
	const tokens = rest.split(/[\s,]+/).filter(t => t !== '');

	if (tokens.length === 0) {
		fail(fileName, lineNumber,
			`\`-- requires-capability:\` declares no tokens. Valid capabilities: ${vocabularyList()}.`);
	}

	for (const raw of tokens) {
		const token = raw.toLowerCase();
		if (!isCapability(token)) {
			fail(fileName, lineNumber,
				`unknown capability "${raw}". Valid capabilities: ${vocabularyList()}.`);
		}
		required.add(token);
	}
}

/** First capability in `required` that `supported` lacks, else undefined. */
export function missingCapability(
	required: ReadonlySet<SqllogicCapability>,
	supported: ReadonlySet<SqllogicCapability>,
): SqllogicCapability | undefined {
	for (const capability of required) {
		if (!supported.has(capability)) return capability;
	}
	return undefined;
}

const ALL_CAPABILITIES: ReadonlySet<SqllogicCapability> =
	new Set(Object.keys(SQLLOGIC_CAPABILITIES) as SqllogicCapability[]);

/**
 * What quereus's own backends accept. Both ship standalone index DDL — memory via
 * `MemoryModule.createIndex`, store via the isolation layer's `createIndex` — so both sets are
 * full today and this mechanism produces NO local skips. That is expected: the payoff is
 * downstream. Downstream harnesses declare their own set; they do not read these.
 */
export const MEMORY_BACKEND_CAPABILITIES: ReadonlySet<SqllogicCapability> = ALL_CAPABILITIES;
export const STORE_BACKEND_CAPABILITIES: ReadonlySet<SqllogicCapability> = ALL_CAPABILITIES;
