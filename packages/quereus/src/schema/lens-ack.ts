import type { SqlValue } from '../common/types.js';
import type { TableSchema } from './table.js';
import type { LensSlot, LogicalConstraint } from './lens.js';
import type { LensDiagnostic, LensDiagnosticSite, FingerprintInputs } from './lens-prover.js';
import { ACKNOWLEDGEABLE_ADVISORY_CODES } from './lens-prover.js';
import { getReservedTag, getReservedTagByTemplate } from './reserved-tags.js';
import { fnv1aHash, toBase64Url } from '../util/hash.js';

/**
 * Lens advisory acknowledgment & escalation governance — the anti-fatigue half
 * of the lens capstone (`docs/lens.md` § Acknowledging advisories).
 *
 * Sits **atop** the advisory list the prover (`lens-prover.ts`) produces: that
 * module proves write-soundness and emits coded, sited, fingerprint-bearing
 * advisories; this module lets a developer consciously accept those advisories
 * in source (the reserved `quereus.lens.ack.<code>` tag), **re-surfaces** them
 * when the underlying facts change (fingerprint mismatch), and lets a project
 * escalate specific codes to hard requirements (`error-on` / `require-ack`).
 * No new enforcement semantics — pure governance over the advisory channel.
 *
 * The three mechanics the doc locks (and this module realizes):
 *  - **Coded + sited + targeted.** An ack `quereus.lens.ack.<code>[:<target>]`
 *    on the logical table or a constraint suppresses exactly the advisory whose
 *    `(code, site[, target])` it names — never a class by accident.
 *  - **Fingerprinted (anti-fatigue).** Each ack records the coarse facts behind
 *    its advisory ({@link FingerprintInputs}, banded so ordinary churn is
 *    invisible). When the recorded fingerprint no longer matches the freshly
 *    computed one, the advisory re-surfaces flagged "previously acknowledged;
 *    situation changed." A first-write ack with no recorded fingerprint is
 *    honored *unconditionally* (record-on-first-sight; the author opted out of
 *    re-surfacing).
 *  - **Escalation policy.** `error-on: [code]` makes the code a hard error an ack
 *    cannot suppress; `require-ack: [code]` makes an *un*-acknowledged instance a
 *    hard error a valid ack clears. Default-empty (projects opt in).
 */

/**
 * Advisory codes are spelled `lens.<x>` ({@link LensCheckCode}); the ack tag
 * `quereus.lens.ack.<code>` carries only the `<x>` remainder (the `quereus.lens.`
 * literal already encodes the `lens.` prefix). So `lens.no-backing-index` is
 * acknowledged by `quereus.lens.ack.no-backing-index`.
 */
const ADVISORY_CODE_PREFIX = 'lens.';
const ACK_TEMPLATE = 'quereus.lens.ack.<code>';

/**
 * In-DDL fingerprint storage (resolved-lean): the recorded fingerprint rides the
 * ack tag *value* as a trailing `#fp=<hash>` token, so it survives schema export
 * round-trip, is version-controlled, and shows up in review alongside the
 * rationale (the same reason the lens doc keeps acks in source). This is the
 * least-noisy shape that round-trips through `reserved-tags.ts` validation: the
 * value is still a single non-empty TEXT rationale (validation unchanged), and no
 * sibling key collides with the `quereus.lens.ack.<code>` template. The anchored
 * suffix keeps an ordinary rationale (which may contain `#`) unambiguous.
 */
const FINGERPRINT_SUFFIX_RE = /\s*#fp=([A-Za-z0-9_-]+)\s*$/;

/** The per-(logical-table) escalation policy. Default-empty ⇒ no code escalated. */
export interface EscalationPolicy {
	/** Codes always a hard error — an ack cannot suppress them. */
	readonly errorOn: ReadonlySet<string>;
	/** Codes whose un-acknowledged instance errors; a valid ack clears. */
	readonly requireAck: ReadonlySet<string>;
}

/** The default policy: nothing escalated (out of the box). */
export const EMPTY_ESCALATION_POLICY: EscalationPolicy = {
	errorOn: new Set<string>(),
	requireAck: new Set<string>(),
};

/**
 * Resolves the escalation policy for one logical table from its reserved policy
 * tags (`quereus.lens.policy.error-on` / `quereus.lens.policy.require-ack`, each a
 * CSV of advisory codes). Default-empty when neither tag is present — out of the
 * box no code is escalated; a project opts in per logical table. (A schema-wide
 * policy is expressed by tagging each table; see `docs/lens.md` § Escalation
 * policy.)
 */
export function resolveEscalationPolicy(logicalTable: TableSchema): EscalationPolicy {
	return {
		errorOn: parseCodeCsv(getReservedTag(logicalTable.tags, 'quereus.lens.policy.error-on')),
		requireAck: parseCodeCsv(getReservedTag(logicalTable.tags, 'quereus.lens.policy.require-ack')),
	};
}

/**
 * Parses a CSV of advisory codes into a set of **code bases** (empty when
 * absent). Each entry is normalized through {@link advisoryCodeBase}, so a policy
 * may name a code either fully (`lens.no-backing-index`) or bare
 * (`no-backing-index`, mirroring the ack tag remainder) — both resolve to the
 * same base the governance compares against. Without this, the bare form would
 * silently no-op the escalation.
 */
function parseCodeCsv(value: string | undefined): Set<string> {
	const set = new Set<string>();
	if (!value) return set;
	for (const part of value.split(',')) {
		const code = part.trim().toLowerCase();
		if (code.length > 0) set.add(advisoryCodeBase(code));
	}
	return set;
}

/**
 * One advisory that an in-source ack suppressed from the default report. Recorded
 * on the {@link LensDeployReport} so the deploy summary can tally `acknowledged: N`
 * and the `quereus_lens_advisories` TVF can expand them on demand.
 */
export interface AcknowledgedAdvisory {
	/** The advisory's stable code (e.g. `lens.no-backing-index`). */
	readonly code: string;
	/** The logical site the advisory (and its ack) concerns. */
	readonly site: LensDiagnosticSite;
	/** The original advisory message. */
	readonly message: string;
	/** The ack's rationale (the tag value, minus any `#fp=` suffix). */
	readonly rationale: string;
	/** The `:<target>` segment that narrowed the ack, when present. */
	readonly target?: string;
	/** The fingerprint freshly computed from the advisory's facts at this deploy. */
	readonly currentFingerprint: string;
	/** The fingerprint recorded in the ack tag, or undefined (record-on-first-sight). */
	readonly recordedFingerprint?: string;
	/** No recorded fingerprint ⇒ the ack never re-surfaces (the author opted out). */
	readonly unconditional: boolean;
}

/** What {@link applyAckGovernance} resolves for one lens slot. */
export interface AckGovernanceResult {
	/**
	 * Advisories still shown by default after ack-suppression — un-acknowledged
	 * ones plus any that **re-surfaced** (`resurfaced: true`, message flagged) plus
	 * the empty-rationale meta-warnings. These flow to the deploy report.
	 */
	readonly warnings: LensDiagnostic[];
	/** Advisories an ack (with a valid/first-sight fingerprint) suppressed. */
	readonly acknowledged: AcknowledgedAdvisory[];
	/** Blocking errors the escalation policy promoted (thrown atomically by the caller). */
	readonly errors: LensDiagnostic[];
}

// ---------------------------------------------------------------------------
// Fingerprint
// ---------------------------------------------------------------------------

/**
 * Computes the stable fingerprint of an advisory from the coarse facts behind it
 * ({@link FingerprintInputs}) plus its code + site. Canonicalized (columns
 * lowercased + sorted, cardinality already **banded** by the prover) so ordinary
 * row-count drift within a band does not churn the hash — only a band crossing,
 * a covering-structure change, or a constraint-column change moves it. The result
 * is a short base64url FNV-1a digest, suitable for embedding in the ack tag value.
 *
 * **Cardinality bands** (`lens-prover.ts:cardinalityBand`): `empty` (0 rows),
 * `small` (<1e3), `medium` (<1e6), `large` (≥1e6), `unknown` (no estimate). An
 * ack survives any row-count change that stays within one band; crossing a band
 * boundary re-surfaces it.
 */
export function computeAdvisoryFingerprint(
	code: string,
	site: LensDiagnosticSite,
	inputs: FingerprintInputs | undefined,
): string {
	const canonical = JSON.stringify({
		code,
		table: site.table.toLowerCase(),
		constraint: site.constraint?.toLowerCase() ?? null,
		column: site.column?.toLowerCase() ?? null,
		cols: inputs?.constraintColumns
			? [...inputs.constraintColumns].map(c => c.toLowerCase()).sort()
			: null,
		cover: inputs?.hasCoveringStructure ?? null,
		band: inputs?.cardinalityBand ?? null,
		basis: inputs?.basisRelation ?? null,
		// Conditionally serialized: advisories carrying no domain (every code
		// before `lens.getput-lossy`) keep their pre-existing hashes, while a
		// CHECK `in (...)` list change moves a round-trip advisory's fingerprint
		// and re-surfaces its acknowledgment.
		...(inputs?.domainValues ? { domain: [...inputs.domainValues].sort() } : {}),
		// Conditionally serialized (same as `domain`): only `lens.over-restrictive-basis-key`
		// carries a governing basis key, so every other advisory keeps its existing hash. A
		// basis-key change (tightened to match the logical key, or loosened) moves the hash
		// and re-surfaces the acknowledgment.
		...(inputs?.basisKeyColumns ? { basisKey: [...inputs.basisKeyColumns].map(c => c.toLowerCase()).sort() } : {}),
	});
	return toBase64Url(fnv1aHash(canonical)).slice(0, 12);
}

// ---------------------------------------------------------------------------
// Ack parsing
// ---------------------------------------------------------------------------

/** One parsed `quereus.lens.ack.<code>[:<target>]` tag, with its scope. */
interface ParsedAck {
	/** The advisory code base (the `<code>` segment, e.g. `no-backing-index`). */
	readonly codeBase: string;
	/** The optional `:<target>` refinement (a constraint name or column). */
	readonly target?: string;
	/** The rationale (tag value minus any `#fp=` suffix). */
	readonly rationale: string;
	/** The recorded fingerprint from the value's `#fp=` suffix, when present. */
	readonly recordedFingerprint?: string;
	/** Empty / whitespace rationale ⇒ surfaces a meta-warning (still suppresses). */
	readonly emptyRationale: boolean;
	/** `'table'` ack (table-scoped) or a `'constraint'` ack (scoped to its columns). */
	readonly scope: 'table' | 'constraint';
	/** For a constraint-scoped ack, that constraint's columns (lowercased). */
	readonly constraintColumns?: readonly string[];
}

/** Splits an ack tag value into `{ rationale, recordedFingerprint }`. */
function parseAckValue(value: string): { rationale: string; recordedFingerprint?: string } {
	const m = FINGERPRINT_SUFFIX_RE.exec(value);
	if (!m) return { rationale: value.trim() };
	return { rationale: value.slice(0, m.index).trim(), recordedFingerprint: m[1] };
}

/** Splits an ack template segment `<code>[:<target>]` into its parts. */
function splitAckSegment(segment: string): { codeBase: string; target?: string } {
	const colon = segment.indexOf(':');
	if (colon < 0) return { codeBase: segment.toLowerCase() };
	return { codeBase: segment.slice(0, colon).toLowerCase(), target: segment.slice(colon + 1).toLowerCase() };
}

/** Collects every ack on the logical table's tags. */
function collectTableAcks(tags: Record<string, SqlValue> | undefined): ParsedAck[] {
	return getReservedTagByTemplate(tags, ACK_TEMPLATE).map(inst => {
		const { codeBase, target } = splitAckSegment(inst.segment);
		const { rationale, recordedFingerprint } = parseAckValue(inst.value);
		return { codeBase, target, rationale, recordedFingerprint, emptyRationale: rationale.length === 0, scope: 'table' as const };
	});
}

/** Collects every ack on one constraint's tags (scoped to that constraint's columns). */
function collectConstraintAcks(constraint: LogicalConstraint, columnNames: ReadonlyMap<number, string>): ParsedAck[] {
	if (constraint.kind === 'primaryKey') return []; // a PK carries no tag surface
	const tags = constraint.constraint.tags;
	const cols = constraintColumns(constraint, columnNames);
	return getReservedTagByTemplate(tags, ACK_TEMPLATE).map(inst => {
		const { codeBase, target } = splitAckSegment(inst.segment);
		const { rationale, recordedFingerprint } = parseAckValue(inst.value);
		return {
			codeBase, target, rationale, recordedFingerprint,
			emptyRationale: rationale.length === 0, scope: 'constraint' as const, constraintColumns: cols,
		};
	});
}

/** The lowercased column names a constraint covers (best-effort by kind). */
function constraintColumns(constraint: LogicalConstraint, columnNames: ReadonlyMap<number, string>): string[] {
	const idx = (i: number): string => (columnNames.get(i) ?? `#${i}`).toLowerCase();
	switch (constraint.kind) {
		case 'primaryKey': return constraint.columns.map(c => idx(c.index));
		case 'unique': return constraint.constraint.columns.map(idx);
		case 'foreignKey': return constraint.constraint.columns.map(idx);
		case 'check': return [];
	}
}

/** Reads every ack on a slot (table tags + each constraint's tags). */
function collectAcks(slot: LensSlot): ParsedAck[] {
	const columnNames = new Map<number, string>();
	slot.logicalTable.columns.forEach((c, i) => columnNames.set(i, c.name));
	const acks = collectTableAcks(slot.logicalTable.tags);
	for (const c of slot.attachedConstraints) acks.push(...collectConstraintAcks(c, columnNames));
	return acks;
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

/** The advisory-code base an ack must name to suppress this advisory. */
function advisoryCodeBase(code: string): string {
	return code.startsWith(ADVISORY_CODE_PREFIX) ? code.slice(ADVISORY_CODE_PREFIX.length) : code;
}

/** Does `target` (an ack refinement) name this advisory's constraint / column / one of its columns? */
function targetMatches(target: string, advisory: LensDiagnostic): boolean {
	const cols = advisory.fingerprintInputs?.constraintColumns ?? [];
	return target === advisory.site.constraint?.toLowerCase()
		|| target === advisory.site.column?.toLowerCase()
		|| cols.some(c => c.toLowerCase() === target);
}

/** Do an ack's constraint columns (set) equal the advisory's constraint columns (set)? */
function constraintColumnsMatch(ackColumns: readonly string[] | undefined, advisory: LensDiagnostic): boolean {
	const advCols = advisory.fingerprintInputs?.constraintColumns;
	if (!ackColumns || !advCols || ackColumns.length !== advCols.length) return false;
	const advSet = new Set(advCols.map(c => c.toLowerCase()));
	return ackColumns.every(c => advSet.has(c.toLowerCase()));
}

/** Finds the ack (if any) that suppresses `advisory`. See § Coded + sited + targeted. */
function matchAck(advisory: LensDiagnostic, acks: readonly ParsedAck[]): ParsedAck | undefined {
	const base = advisoryCodeBase(advisory.code);
	for (const ack of acks) {
		if (ack.codeBase !== base) continue;
		if (ack.target !== undefined) {
			if (targetMatches(ack.target, advisory)) return ack;
			continue;
		}
		// Untargeted: a table ack suppresses the class for that table; a
		// constraint ack only its own constraint (matched by its column set).
		if (ack.scope === 'table') return ack;
		if (constraintColumnsMatch(ack.constraintColumns, advisory)) return ack;
	}
	return undefined;
}

// ---------------------------------------------------------------------------
// Governance
// ---------------------------------------------------------------------------

/**
 * The recognized escalation-policy code bases — every advisory code that can flow
 * through governance, normalized through {@link advisoryCodeBase} so it compares
 * against a policy's bare/`lens.`-prefixed forms exactly as the resolved policy set
 * stores them. A policy entry whose base is absent here names no real advisory and
 * would silently fail open, so {@link applyAckGovernance} rejects it.
 */
const RECOGNIZED_ADVISORY_BASES: ReadonlySet<string> =
	new Set([...ACKNOWLEDGEABLE_ADVISORY_CODES].map(advisoryCodeBase));

/** The recognized advisory codes (full `lens.<base>` form), for diagnostics. */
const RECOGNIZED_ADVISORY_CODES_DISPLAY = [...ACKNOWLEDGEABLE_ADVISORY_CODES].join(', ');

/**
 * Emits one error {@link LensDiagnostic} for each policy code that names no real
 * advisory — a typo'd or stale escalation entry that would otherwise silently fail
 * open (the deploy stays advisory while the author believes they hardened it). The
 * resolved policy holds normalized bases; the full `lens.<base>` form is
 * reconstructed for the message. Validated against the *vocabulary*, independent of
 * whether any advisory currently fires (pre-empting a not-yet-triggered but
 * recognized code is valid and must NOT error).
 */
function validatePolicyCodes(slot: LensSlot, policy: EscalationPolicy): LensDiagnostic[] {
	const errors: LensDiagnostic[] = [];
	const check = (bases: ReadonlySet<string>, tag: 'error-on' | 'require-ack'): void => {
		for (const base of bases) {
			if (RECOGNIZED_ADVISORY_BASES.has(base)) continue;
			errors.push(unknownPolicyCodeError(slot, tag, base));
		}
	};
	check(policy.errorOn, 'error-on');
	check(policy.requireAck, 'require-ack');
	return errors;
}

/** The deploy-blocking diagnostic for an unrecognized escalation policy code. */
function unknownPolicyCodeError(slot: LensSlot, tag: 'error-on' | 'require-ack', base: string): LensDiagnostic {
	const table = slot.logicalTable.name;
	return {
		code: 'lens.unknown-policy-code',
		severity: 'error',
		site: { table },
		message: `lens: escalation policy tag 'quereus.lens.policy.${tag}' on '${table}' references unknown advisory code '${ADVISORY_CODE_PREFIX}${base}' — it will never match and the escalation silently does nothing; recognized codes: ${RECOGNIZED_ADVISORY_CODES_DISPLAY}`,
		resurfaced: false,
	};
}

/**
 * Applies ack-suppression, fingerprint re-surfacing, and the escalation policy to
 * one slot's prover warnings. Pure analysis — does not mutate the slot or report.
 *
 * First validates the policy codes against the advisory vocabulary
 * ({@link validatePolicyCodes}) — an unrecognized code is a deploy-blocking error,
 * never a silent no-op. Then, order per advisory:
 *  1. **error-on** wins first — the code is a hard error regardless of any ack.
 *  2. Otherwise match an ack. No ack ⇒ the advisory stays in the default report.
 *  3. A matched ack with a recorded fingerprint that *mismatches* the freshly
 *     computed one ⇒ the advisory **re-surfaces** (flagged), counted as
 *     un-acknowledged. A matching (or first-sight, unconditional) fingerprint ⇒
 *     acknowledged + suppressed. An empty rationale additionally surfaces a
 *     meta-warning (the ack still suppresses).
 *  4. **require-ack**: an advisory of a require-ack code that is not validly
 *     acknowledged (no ack, or re-surfaced) becomes a hard error.
 */
export function applyAckGovernance(
	slot: LensSlot,
	warnings: readonly LensDiagnostic[],
	policy: EscalationPolicy,
): AckGovernanceResult {
	const acks = collectAcks(slot);
	const outWarnings: LensDiagnostic[] = [];
	const acknowledged: AcknowledgedAdvisory[] = [];
	// Up front: reject policy entries naming no real advisory code (a typo/stale
	// code that would silently fail open). Validated against the vocabulary,
	// independent of whether any advisory below actually fires.
	const errors: LensDiagnostic[] = validatePolicyCodes(slot, policy);

	for (const w of warnings) {
		const codeBase = advisoryCodeBase(w.code);
		if (policy.errorOn.has(codeBase)) {
			errors.push(escalationError(w, 'error-on'));
			continue; // an ack cannot suppress an error-on code
		}

		const ack = matchAck(w, acks);
		let validlyAcked = false;
		if (ack) {
			const currentFp = computeAdvisoryFingerprint(w.code, w.site, w.fingerprintInputs);
			if (ack.emptyRationale) outWarnings.push(emptyRationaleWarning(w));
			if (ack.recordedFingerprint !== undefined && ack.recordedFingerprint !== currentFp) {
				outWarnings.push(resurface(w, ack.recordedFingerprint, currentFp));
			} else {
				acknowledged.push({
					code: w.code,
					site: w.site,
					message: w.message,
					rationale: ack.rationale,
					target: ack.target,
					currentFingerprint: currentFp,
					recordedFingerprint: ack.recordedFingerprint,
					unconditional: ack.recordedFingerprint === undefined,
				});
				validlyAcked = true;
			}
		} else {
			outWarnings.push(w);
		}

		if (policy.requireAck.has(codeBase) && !validlyAcked) {
			errors.push(escalationError(w, 'require-ack'));
		}
	}

	return { warnings: outWarnings, acknowledged, errors };
}

/** Flags a re-surfaced advisory: kept in the report, message annotated. */
function resurface(w: LensDiagnostic, recorded: string, current: string): LensDiagnostic {
	return {
		...w,
		resurfaced: true,
		message: `${w.message} [previously acknowledged; situation changed — recorded fingerprint '${recorded}' no longer matches '${current}'; re-acknowledge to suppress again]`,
	};
}

/** The meta-warning for an ack whose rationale is empty (docs/lens.md:211). */
function emptyRationaleWarning(w: LensDiagnostic): LensDiagnostic {
	return {
		code: w.code,
		severity: 'warning',
		site: w.site,
		message: `lens: acknowledgment of '${w.code}' on '${w.site.table}' has an empty rationale — every suppression should carry its justification (set the ack tag value to a non-empty reason)`,
		resurfaced: false,
	};
}

/** Promotes an advisory to a blocking error under the named escalation policy. */
function escalationError(w: LensDiagnostic, kind: 'error-on' | 'require-ack'): LensDiagnostic {
	const detail = kind === 'error-on'
		? `escalated to a hard error by the 'error-on' policy (an ack cannot suppress it)`
		: `un-acknowledged but required by the 'require-ack' policy (add a 'quereus.lens.ack.${advisoryCodeBase(w.code)}' tag with a rationale to clear it)`;
	return { ...w, severity: 'error', message: `${w.message} [${detail}]` };
}
