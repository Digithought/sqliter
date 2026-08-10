/**
 * The `idxStr` wire format: one encoder, one decoder.
 *
 * `FilterInfo.idxStr` is the text the planner hands a module's runtime to say which
 * index it chose and how it means to walk it. Its shape is:
 *
 *     idx=<indexName>(<nameArg>);plan=<code>[;<key>=<value>]*
 *
 * plus two sentinels — `fullscan` (no index) and `empty` (provably no rows). Every
 * producer and consumer in the engine goes through this module, so the format is
 * defined in exactly one place. The structured, typed form of the same information
 * is `FilterInfo.accessPath` (see `index-descriptor.ts`); prefer that when you need
 * to know *what the index is* rather than what to hand a module runtime.
 */

import { quereusError } from '../common/errors.js';
import { StatusCode } from '../common/types.js';
import type { IndexPlanKind } from './index-descriptor.js';

/** Parsed form of an `idx=name(n);plan=N;…` string. */
export interface IdxStrSpec {
	readonly indexName: string;
	/** The `(n)` group after the name. The planner always emits 0; aliasing modules may not. */
	readonly nameArg: number;
	/** The numeric `plan=` code. Not narrowed to {@link IndexPlanKind}: unknown codes round-trip. */
	readonly plan: number;
	/**
	 * Remaining `k=v` parameters in source order (inCount, seekWidth, prefixLen,
	 * rangeCount, rangeOps, argvMap, ordCons, …). Insertion-ordered so that
	 * `encodeIdxStr(decodeIdxStr(s))` reproduces `s` byte-for-byte.
	 */
	readonly params: ReadonlyMap<string, string>;
}

const IDX_NAME_ARG_RE = /^(.*?)\((\d+)\)$/;

/** No parameters — shared to avoid allocating an empty Map per decode. */
const NO_PARAMS: ReadonlyMap<string, string> = new Map();

/** The two sentinel `idxStr` values, which name no index. */
const FULL_SCAN_SENTINEL = 'fullscan';
const EMPTY_SENTINEL = 'empty';

const PLAN_CODE_BY_KIND: ReadonlyMap<IndexPlanKind, number> = new Map<IndexPlanKind, number>([
	['scan', 0],
	['eqSeek', 2],
	['rangeSeek', 3],
	['multiSeek', 5],
	['multiRangeSeek', 6],
	['prefixRangeSeek', 7],
]);

const PLAN_KIND_BY_CODE: ReadonlyMap<number, IndexPlanKind> = new Map<number, IndexPlanKind>(
	[...PLAN_CODE_BY_KIND].map(([kind, code]) => [code, kind]),
);

/** The {@link IndexPlanKind} for a `plan=` code, or undefined for a code this engine never emits. */
export function planKindFromCode(code: number): IndexPlanKind | undefined {
	return PLAN_KIND_BY_CODE.get(code);
}

/** The `plan=` code for an {@link IndexPlanKind}. Total — every kind has a code. */
export function planCodeFromKind(kind: IndexPlanKind): number {
	const code = PLAN_CODE_BY_KIND.get(kind);
	if (code === undefined) {
		quereusError(`Unknown index plan kind '${kind}'`, StatusCode.INTERNAL);
	}
	return code;
}

/**
 * Distinguish the two sentinel strings from a genuine index string.
 * Returns null for `null`, `''`, and anything that is not a sentinel.
 */
export function idxStrSentinel(idxStr: string | null): 'fullScan' | 'empty' | null {
	if (idxStr === FULL_SCAN_SENTINEL) return 'fullScan';
	if (idxStr === EMPTY_SENTINEL) return 'empty';
	return null;
}

/** Render an {@link IdxStrSpec} to its wire form. */
export function encodeIdxStr(spec: IdxStrSpec): string {
	const parts = [`idx=${spec.indexName}(${spec.nameArg})`, `plan=${spec.plan}`];
	for (const [key, value] of spec.params) {
		if (key === 'idx' || key === 'plan') {
			quereusError(`idxStr parameter '${key}' is reserved and cannot appear in params`, StatusCode.INTERNAL);
		}
		parts.push(`${key}=${value}`);
	}
	return parts.join(';');
}

/**
 * Parse an `idxStr`.
 *
 * Returns null for `null`, `''`, the `fullscan` / `empty` sentinels, and any string
 * without a parseable `idx=<name>(<n>)` term — i.e. exactly the cases where no index
 * is named. Use {@link idxStrSentinel} to tell the two sentinels apart from garbage.
 *
 * A parameter's value may contain `=`, `:` and `,` (e.g. `rangeOps=ge:lt,gt`); only the
 * FIRST `=` in each `;`-separated term separates key from value.
 */
export function decodeIdxStr(idxStr: string | null): IdxStrSpec | null {
	if (!idxStr || idxStrSentinel(idxStr) !== null) return null;

	let indexTerm: string | undefined;
	let planTerm: string | undefined;
	const params = new Map<string, string>();

	for (const part of idxStr.split(';')) {
		const sep = part.indexOf('=');
		if (sep <= 0) continue;
		const key = part.slice(0, sep);
		const value = part.slice(sep + 1);
		if (key === 'idx') {
			indexTerm = value;
		} else if (key === 'plan') {
			planTerm = value;
		} else {
			params.set(key, value);
		}
	}

	if (indexTerm === undefined) return null;
	const match = IDX_NAME_ARG_RE.exec(indexTerm);
	if (!match) return null;

	const plan = planTerm === undefined ? 0 : Number.parseInt(planTerm, 10);
	return {
		indexName: match[1],
		nameArg: Number.parseInt(match[2], 10),
		plan: Number.isNaN(plan) ? 0 : plan,
		params: params.size === 0 ? NO_PARAMS : params,
	};
}

/**
 * Rename the index inside an `idxStr`, preserving `plan`, `nameArg`, and every parameter
 * verbatim — including parameters and plan codes this engine does not understand. Strings
 * that name no index (sentinels, null, garbage) are returned unchanged.
 *
 * Implemented as decode → swap name → encode, so it cannot corrupt what it cannot read.
 */
export function retargetIdxStr(idxStr: string | null, newIndexName: string): string | null {
	const spec = decodeIdxStr(idxStr);
	if (!spec) return idxStr;
	if (spec.indexName === newIndexName) return idxStr;
	return encodeIdxStr({ ...spec, indexName: newIndexName });
}

/** Build an {@link IdxStrSpec} for a plan the engine itself chose. `nameArg` is always 0. */
export function makeIdxStrSpec(
	indexName: string,
	plan: IndexPlanKind,
	params?: ReadonlyMap<string, string>,
): IdxStrSpec {
	return { indexName, nameArg: 0, plan: planCodeFromKind(plan), params: params ?? NO_PARAMS };
}
