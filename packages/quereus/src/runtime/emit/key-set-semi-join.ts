import type { KeySetSemiJoinNode, KeySetPushdown } from '../../planner/nodes/key-set-semi-join-node.js';
import type { Instruction, RuntimeContext } from '../types.js';
import { asRun } from '../types.js';
import { emitPlanNode } from '../emitters.js';
import { emitSeqScan } from './scan.js';
import type { EmissionContext } from '../emission-context.js';
import type { Row, SqlValue } from '../../common/types.js';
import { StatusCode } from '../../common/types.js';
import { QuereusError, throwIfAborted } from '../../common/errors.js';
import { IndexConstraintOp } from '../../common/constants.js';
import { encodeIdxStr, makeIdxStrSpec } from '../../vtab/idx-str.js';
import type { FilterInfo } from '../../vtab/filter-info.js';
import { buildJoinKeyExtractor } from './join-key-extractor.js';
import { compareSqlValuesFast, normalizeCollationName } from '../../util/comparison.js';
import { createLogger } from '../../common/logger.js';

const log = createLogger('runtime:emit:key-set-semi-join');

interface KeySetState {
	/** Serialized+normalized keys, for the probe. */
	readonly probe: ReadonlySet<string>;
	/** Raw seek values in index order, or null when the runtime chose to scan. */
	readonly seekKeys: readonly SqlValue[] | null;
}

/**
 * Rewrite a full-scan FilterInfo into the single-column `plan=5` multi-seek the
 * literal-IN arm of `rule-select-access-path` produces for `where col in (…)` —
 * one EQ constraint per key, `argvIndex` 1…K, `inCount=<K>` in the idxStr
 * (`seekWidth` omitted ⇒ 1). Every downstream consumer
 * (`StoreTable.scanMultiSeek`, the memory vtab's scan-plan builder,
 * `IsolatedTable.buildConstraintMatcher`) consumes it unchanged because it
 * cannot be told apart from a literal list.
 *
 * Exported for the plan-time/runtime shape-equivalence unit test.
 */
export function stampMultiSeek(
	base: FilterInfo,
	pushdown: KeySetPushdown,
	keys: readonly SqlValue[],
): FilterInfo {
	const constraints = keys.map((_v, i) => ({
		constraint: { iColumn: pushdown.seekColumnIndex, op: IndexConstraintOp.EQ, usable: true },
		argvIndex: i + 1,
	}));
	const idxStr = encodeIdxStr(makeIdxStrSpec(pushdown.indexName, 'multiSeek',
		new Map([['inCount', String(keys.length)]])));
	return {
		...base,
		idxStr,
		constraints,
		args: keys,
		accessPath: pushdown.accessPath,
		indexInfoOutput: {
			...base.indexInfoOutput,
			idxStr,
			nConstraint: constraints.length,
			aConstraint: constraints.map(c => c.constraint),
			aConstraintUsage: constraints.map(c => ({ argvIndex: c.argvIndex, omit: true })),
			estimatedRows: BigInt(keys.length),
			// An ordering-only leaf stamps orderByConsumed vacuously (nothing above
			// the replaced hash join consumed its order); the multi-seek is not an
			// ordering plan, so report false — matching the literal-IN arm's shape.
			orderByConsumed: false,
		},
	};
}

/**
 * Emit a KeySetSemiJoin: drain the key source once into a set, decide
 * seek-vs-scan, then stream the target probing every row against the set.
 *
 * The probe is unconditional — the pushdown only changes how many rows the
 * target emits. The target leaf is emitted through `emitSeqScan`'s
 * `FilterInfoOverride` hook (the OrdinalSlice pattern): the override reads the
 * per-execution state this run() stamped and either leaves the full-scan
 * FilterInfo untouched or replaces it with the multi-seek.
 */
export function emitKeySetSemiJoin(plan: KeySetSemiJoinNode, ctx: EmissionContext): Instruction {
	const targetAttributes = plan.target.getAttributes();
	const keyAttributes = plan.keySource.getAttributes();

	const targetColIdx = plan.target.getAttributeIndex().get(plan.targetAttrId) ?? -1;
	const keyColIdx = plan.keySource.getAttributeIndex().get(plan.keyAttrId) ?? -1;
	if (targetColIdx === -1 || keyColIdx === -1) {
		throw new QuereusError(
			`KeySetSemiJoin: could not resolve join attr IDs ${plan.targetAttrId}=${plan.keyAttrId}`,
			StatusCode.INTERNAL);
	}

	// Same serialized-key pipeline as the bloom join it replaces — both sides
	// MUST agree bit-for-bit (see join-key-extractor.ts).
	const extractKey = buildJoinKeyExtractor(
		[[targetAttributes[targetColIdx].type, keyAttributes[keyColIdx].type]],
		ctx,
	);
	const targetIndices = [targetColIdx];
	const keyIndices = [keyColIdx];

	// Seek keys are sorted under the INDEX's leading-key-column collation so the
	// stamped multi-seek arrives in index-key order — required by the isolation
	// overlay's ascending-merge assumption and what makes emission deterministic.
	// NOTE: both memory-table branches (scan-layer.ts) and the persistent store
	// (store-table-scan.ts) now also sort a multiSeek's keys into index order
	// themselves (fix/bug-isolation-multiseek-merge-order), so this sort is
	// redundant against those backends today. It is NOT dead: it is the only sort
	// for a backend that does not, and dropping it would silently reintroduce an
	// ordering dependency on backend internals. Keep it.
	const seekCollation = ctx.resolveCollation(
		normalizeCollationName(plan.pushdown.accessPath.index.keyColumns[0].collation ?? 'BINARY'));
	const seekSign = plan.pushdown.seekDescending ? -1 : 1;

	const stateByCtx = new WeakMap<RuntimeContext, KeySetState>();

	const targetInstruction = emitSeqScan(plan.target, ctx, (base, rctx) => {
		const state = stateByCtx.get(rctx);
		if (!state) {
			// The scheduler always runs the target as a child of this node's
			// run(), so a missing state entry is a scheduling bug. A silent
			// full-scan fallback here would be correct but would hide that bug
			// indefinitely — mirrors OrdinalSlice's guard.
			throw new QuereusError(
				'KeySetSemiJoin target executed without key-set initialization',
				StatusCode.INTERNAL);
		}
		if (!state.seekKeys) return base; // scan fallback — unchanged FilterInfo
		return stampMultiSeek(base, plan.pushdown, state.seekKeys);
	});
	const keySourceInstruction = emitPlanNode(plan.keySource, ctx);

	async function* run(
		rctx: RuntimeContext,
		targetRows: AsyncIterable<Row>,
		keyRows: AsyncIterable<Row>,
	): AsyncIterable<Row> {
		// === Drain the key source completely into the probe set. Per distinct
		// probe string, keep the FIRST raw value seen as the seek value.
		// NOTE: under a nested-loop rescan this re-drains the key source each
		// pass. Correct but wasteful; the right side is uncorrelated by rule
		// construction, so caching it is a pure optimization that only matters
		// if this shape ever shows up under an NLJ inner.
		const probe = new Set<string>();
		const seekByProbe = new Map<string, SqlValue>();
		for await (const keyRow of keyRows) {
			throwIfAborted(rctx.signal);
			const key = extractKey(keyRow, keyIndices);
			if (key === null) continue; // NULL keys can't match
			if (!probe.has(key)) {
				probe.add(key);
				seekByProbe.set(key, keyRow[keyColIdx]);
			}
		}

		// An empty build side means the semi join emits nothing — the target
		// must not be opened at all.
		if (probe.size === 0) {
			log('Key set empty — target not opened');
			return;
		}

		const push = probe.size <= Math.min(plan.pushdown.maxKeys, plan.pushdown.breakEvenKeys);
		let seekKeys: SqlValue[] | null = null;
		if (push) {
			seekKeys = [...seekByProbe.values()]
				.sort((a, b) => seekSign * compareSqlValuesFast(a, b, seekCollation));
		}
		log('Key set drained: %d distinct keys, %s (breakEven=%d, max=%d)',
			probe.size, push ? 'seeking' : 'scanning', plan.pushdown.breakEvenKeys, plan.pushdown.maxKeys);

		stateByCtx.set(rctx, { probe, seekKeys });
		try {
			for await (const targetRow of targetRows) {
				const key = extractKey(targetRow, targetIndices);
				if (key !== null && probe.has(key)) {
					yield targetRow;
				}
			}
		} finally {
			stateByCtx.delete(rctx);
		}
	}

	return {
		params: [targetInstruction, keySourceInstruction],
		run: asRun(run),
		note: `key-set semi join (${plan.pushdown.indexName})`,
	};
}
