import type { AsofScanNode } from '../../planner/nodes/asof-scan-node.js';
import type { Instruction, RuntimeContext } from '../types.js';
import { asRun } from '../types.js';
import { emitPlanNode } from '../emitters.js';
import type { Row } from '../../common/types.js';
import type { EmissionContext } from '../emission-context.js';
import { createLogger } from '../../common/logger.js';
import { buildRowDescriptor } from '../../util/row-descriptor.js';
import { createRowSlot } from '../context-helpers.js';
import { compareSqlValuesFast } from '../../util/comparison.js';
import type { CollationFunction } from '../../util/comparison.js';
import { serializeRowKey } from '../../util/key-serializer.js';
import { effectiveCollationOfTypes, hashKeyCollationName } from '../../planner/analysis/comparison-collation.js';
import { joinOutputRow } from './join-output.js';

const log = createLogger('runtime:emit:asof-scan');

/**
 * Resolved emitter setup shared by hash and merge variants. Computes
 * attribute indices, collations, projection, and join-type discriminator
 * from the plan node — handed to the strategy-specific emitter below.
 */
interface AsofScanSetup {
	leftMatchIdx: number;
	rightMatchIdx: number;
	matchCollation: CollationFunction;
	leftPartitionIndices: number[];
	rightPartitionIndices: number[];
	partitionCollations: CollationFunction[];
	keyNormalizers: ((s: string) => string)[];
	rightOutputColumnIndices: readonly number[];
	projectedRightColCount: number;
	outerJoinType: 'left' | 'inner';
	strict: boolean;
	direction: 'asc' | 'desc';
	leftRowDescriptor: ReturnType<typeof buildRowDescriptor>;
	rightRowDescriptor: ReturnType<typeof buildRowDescriptor>;
	projectRight: (row: Row) => Row;
}

function resolveSetup(plan: AsofScanNode, ctx: EmissionContext): AsofScanSetup {
	const leftAttrs = plan.left.getAttributes();
	const rightAttrs = plan.right.getAttributes();

	const leftRowDescriptor = buildRowDescriptor(leftAttrs);
	const rightRowDescriptor = buildRowDescriptor(rightAttrs);

	const leftIndex = plan.left.getAttributeIndex();
	const rightIndex = plan.right.getAttributeIndex();

	const leftMatchIdx = leftIndex.get(plan.matchAttr.leftAttrId) ?? -1;
	const rightMatchIdx = rightIndex.get(plan.matchAttr.rightAttrId) ?? -1;
	if (leftMatchIdx === -1 || rightMatchIdx === -1) {
		throw new Error(`AsofScan: could not resolve match-attr ids ${plan.matchAttr.leftAttrId}/${plan.matchAttr.rightAttrId}`);
	}
	// Resolve the match column's comparison collation through the shared provenance
	// lattice (explicit > declared > default > BINARY), so a declared NOCASE on
	// either side governs the asof match regardless of which side spells it. Throws
	// on an explicit/declared conflict — a loud backstop. LOCKSTEP (merge strategy):
	// the asof co-stream needs both inputs ordered under THIS collation;
	// `rule-asof-strategy-select` validates the (collation-blind) physical ordering,
	// sound only while both match attrs share their declared sort collation — the
	// same alignment `equi-pair-extractor` enforces for merge join.
	const matchCollationName = effectiveCollationOfTypes(leftAttrs[leftMatchIdx].type, rightAttrs[rightMatchIdx].type);
	const matchCollation: CollationFunction = ctx.resolveCollation(matchCollationName);
	// NOTE: AS OF match/partition compares are storage-class + collation, not
	// semantic-ordering-aware. Correct for the canonical AS OF column types
	// (DATE/DATETIME — canonical ISO text order IS their semantic order). A TIMESPAN
	// or JSON match column would order by text here, disagreeing with `<`/ORDER BY.
	// The equi-join rule (docs/types-ordering.md § "Semantic ordering": a physical key pair is
	// admissible only when both sides agree on semantic ordering, else it demotes to
	// the residual) does NOT apply here — AS OF has no residual to demote into, so a
	// declining gate would only make the query unplannable. Fixing this means
	// resolving a typed comparator for a same-type pair and rejecting the plan for a
	// mixed one; tracked as
	// `tickets/backlog/bug-asof-match-column-ignores-semantic-ordering`.

	const leftPartitionIndices: number[] = [];
	const rightPartitionIndices: number[] = [];
	const partitionCollations: CollationFunction[] = [];
	const keyNormalizers: ((s: string) => string)[] = [];
	for (const p of plan.partitionAttrs) {
		const leftIdx = leftIndex.get(p.leftAttrId) ?? -1;
		const rightIdx = rightIndex.get(p.rightAttrId) ?? -1;
		if (leftIdx === -1 || rightIdx === -1) {
			throw new Error(`AsofScan: could not resolve partition-attr ids ${p.leftAttrId}/${p.rightAttrId}`);
		}
		leftPartitionIndices.push(leftIdx);
		rightPartitionIndices.push(rightIdx);
		// Same provenance-lattice resolution as the match column: a partition column
		// declared NOCASE on either side groups case-variant keys together regardless
		// of which side declares it; the comparator and the hash-bucket normalizer
		// both key off the one resolved name so they cannot disagree.
		const leftType = leftAttrs[leftIdx].type;
		const rightType = rightAttrs[rightIdx].type;
		const collationName = effectiveCollationOfTypes(leftType, rightType);
		partitionCollations.push(ctx.resolveCollation(collationName));
		keyNormalizers.push(ctx.resolveKeyNormalizer(hashKeyCollationName(collationName, [leftType, rightType])));
	}

	const rightOutputColumnIndices = plan.getRightOutputColumnIndices();
	const projectedRightColCount = rightOutputColumnIndices.length;

	const projectRight = (row: Row): Row => {
		const out: Row = new Array(projectedRightColCount);
		for (let i = 0; i < projectedRightColCount; i++) {
			out[i] = row[rightOutputColumnIndices[i]];
		}
		return out;
	};

	return {
		leftMatchIdx,
		rightMatchIdx,
		matchCollation,
		leftPartitionIndices,
		rightPartitionIndices,
		partitionCollations,
		keyNormalizers,
		rightOutputColumnIndices,
		projectedRightColCount,
		outerJoinType: plan.outer ? 'left' : 'inner',
		strict: plan.strict,
		direction: plan.direction,
		leftRowDescriptor,
		rightRowDescriptor,
		projectRight,
	};
}

/**
 * Dispatch on `plan.strategy` to the appropriate emitter. The strategy is
 * chosen by `rule-asof-strategy-select` during optimization; runtime carries
 * it through verbatim.
 */
export function emitAsofScan(plan: AsofScanNode, ctx: EmissionContext): Instruction {
	return plan.strategy === 'merge'
		? emitAsofScanMerge(plan, ctx)
		: emitAsofScanHash(plan, ctx);
}

/**
 * Hash-bucketed asof scan.
 *
 * Algorithm:
 * 1. Bucket the right input by partition key (single bucket if no partition).
 *    Within each bucket, rows arrive in monotonicOn(matchAttr, asc) order from
 *    the right access plan. Right rows with NULL match values are dropped.
 * 2. For each left row:
 *    - Look up its partition's bucket. If absent, emit NULL-padded (outer) or
 *      drop (inner).
 *    - 'desc' direction (latest right ≤ left.match): cursor starts at -1 and
 *      advances forward while the next bucket row's match still qualifies
 *      (≤ left.match, or < when strict). The cursor sits on the last
 *      qualifying row.
 *    - 'asc' direction (earliest right ≥ left.match): cursor starts at 0 and
 *      advances forward while the current bucket row's match is too small
 *      (< left.match, or ≤ when strict). The cursor sits on the first
 *      qualifying row, or past-the-end when no row qualifies.
 *    - Emit (left, projected right) when the cursor lands on a match;
 *      otherwise NULL-pad (outer) or drop (inner).
 * 3. Left rows with NULL match values are NULL-padded (outer) or dropped.
 *
 * Memory: O(R). Latency: all R right rows must arrive before the first emit.
 */
function emitAsofScanHash(plan: AsofScanNode, ctx: EmissionContext): Instruction {
	const setup = resolveSetup(plan, ctx);
	const {
		leftMatchIdx, rightMatchIdx, matchCollation,
		leftPartitionIndices, rightPartitionIndices,
		keyNormalizers,
		projectedRightColCount,
		outerJoinType, strict, direction,
		leftRowDescriptor, rightRowDescriptor,
		projectRight,
	} = setup;

	async function* run(
		rctx: RuntimeContext,
		leftSource: AsyncIterable<Row>,
		rightSource: AsyncIterable<Row>,
	): AsyncIterable<Row> {
		log('Starting %s asof scan [hash]: direction=%s, %d partition keys, strict=%s',
			plan.outer ? 'LEFT' : 'INNER', direction, plan.partitionAttrs.length, strict);

		const leftSlot = createRowSlot(rctx, leftRowDescriptor, `AsofScan#${plan.id}:left`);
		const rightSlot = createRowSlot(rctx, rightRowDescriptor, `AsofScan#${plan.id}:right`);

		try {
			// Bucket right rows by partition key. Right rows with NULL match are dropped;
			// those with NULL partition values are dropped (sentinel null key).
			const buckets = new Map<string, Row[]>();
			let rightCount = 0;
			for await (const row of rightSource) {
				if (row[rightMatchIdx] === null) continue;
				const pk = serializeRowKey(row, rightPartitionIndices, keyNormalizers);
				if (pk === null) continue; // NULL partition value — never matches
				let bucket = buckets.get(pk);
				if (!bucket) {
					bucket = [];
					buckets.set(pk, bucket);
				}
				bucket.push(row);
				rightCount++;
			}
			log('Right side bucketed: %d rows in %d buckets', rightCount, buckets.size);

			// Per-bucket cursor positions (the index of the latest row whose match ≤ current left.match).
			// -1 means "before the first row" (no match yet).
			const cursors = new Map<string, number>();

			for await (const leftRow of leftSource) {
				leftSlot.set(leftRow);

				const leftMatch = leftRow[leftMatchIdx];
				if (leftMatch === null) {
					// Left match is NULL — three-valued logic excludes it from any match.
					const padding = joinOutputRow(outerJoinType, false, false, leftRow, projectedRightColCount, rightSlot);
					if (padding) yield padding;
					continue;
				}

				const pk = serializeRowKey(leftRow, leftPartitionIndices, keyNormalizers);
				if (pk === null) {
					// NULL partition value — bucket can't be matched.
					const padding = joinOutputRow(outerJoinType, false, false, leftRow, projectedRightColCount, rightSlot);
					if (padding) yield padding;
					continue;
				}

				const bucket = buckets.get(pk);
				if (!bucket || bucket.length === 0) {
					const padding = joinOutputRow(outerJoinType, false, false, leftRow, projectedRightColCount, rightSlot);
					if (padding) yield padding;
					continue;
				}

				const initialCursor = direction === 'desc' ? -1 : 0;
				let cursor = cursors.get(pk) ?? initialCursor;
				let matchedRight: Row | undefined;

				if (direction === 'desc') {
					// Cursor is the index of the last qualifying row (or -1 before any).
					// Advance while bucket[cursor+1].match still qualifies (≤ left.match, or <).
					while (cursor + 1 < bucket.length) {
						const candidate = bucket[cursor + 1];
						const cmp = compareSqlValuesFast(candidate[rightMatchIdx], leftMatch, matchCollation);
						if (strict ? cmp < 0 : cmp <= 0) cursor++;
						else break;
					}
					cursors.set(pk, cursor);
					if (cursor >= 0) matchedRight = bucket[cursor];
				} else {
					// 'asc': cursor is the index of the first qualifying row (or bucket.length when none).
					// Advance while bucket[cursor].match is still too small (< left.match, or ≤).
					while (cursor < bucket.length) {
						const candidate = bucket[cursor];
						const cmp = compareSqlValuesFast(candidate[rightMatchIdx], leftMatch, matchCollation);
						if (strict ? cmp <= 0 : cmp < 0) cursor++;
						else break;
					}
					cursors.set(pk, cursor);
					if (cursor < bucket.length) matchedRight = bucket[cursor];
				}

				if (!matchedRight) {
					// No row in this bucket qualifies for the current left.match.
					const padding = joinOutputRow(outerJoinType, false, false, leftRow, projectedRightColCount, rightSlot);
					if (padding) yield padding;
					continue;
				}
				rightSlot.set(matchedRight);

				const projectedRight = projectRight(matchedRight);
				yield [...leftRow, ...projectedRight] as Row;
			}
		} finally {
			leftSlot.close();
			rightSlot.close();
		}
	}

	const leftInstruction = emitPlanNode(plan.left, ctx);
	const rightInstruction = emitPlanNode(plan.right, ctx);

	return {
		params: [leftInstruction, rightInstruction],
		run: asRun(run),
		note: `${plan.outer ? 'left' : 'inner'} asof scan [hash]${strict ? ' strict' : ''}`,
	};
}

/**
 * Co-streaming (merge-by-partition-key) asof scan.
 *
 * Both inputs must be pre-ordered by `[partition cols..., matchAttr]` —
 * `rule-asof-strategy-select` validates this against the children's
 * `physical.ordering` before promoting the strategy.
 *
 * Algorithm:
 * 1. Walk both iterators with peek-1 lookahead.
 * 2. For each left row in turn:
 *    - Skip (padding/drop) NULL-match or NULL-partition left rows.
 *    - On entering a new partition: drain right of NULLs and rows in earlier
 *      partitions; reset the per-partition `descMatched` state.
 *    - Run the per-row inner loop:
 *      • `'desc'` (latest right ≤ left.match): consume right rows while
 *        next.matchAttr still qualifies. The most recently consumed
 *        qualifier persists across left rows in the same partition.
 *      • `'asc'`  (earliest right ≥ left.match): consume right rows while
 *        next.matchAttr is too small; the first qualifier is read off peek
 *        but NOT consumed (it may match subsequent left rows).
 * 3. Emit (left, projected right) on a match; pad/drop on miss.
 *
 * Memory: O(1) (one row of state per side plus one saved partition match).
 * Latency: emits as left rows arrive.
 */
function emitAsofScanMerge(plan: AsofScanNode, ctx: EmissionContext): Instruction {
	const setup = resolveSetup(plan, ctx);
	const {
		leftMatchIdx, rightMatchIdx, matchCollation,
		leftPartitionIndices, rightPartitionIndices,
		partitionCollations,
		projectedRightColCount,
		outerJoinType, strict, direction,
		leftRowDescriptor, rightRowDescriptor,
		projectRight,
	} = setup;

	const partitionLen = plan.partitionAttrs.length;
	// All ordering positions in the recognized merge case agree on direction
	// across left and right; the rule validated this. We need the per-position
	// direction to invert comparisons so "right is behind" remains consistent
	// under descending partition ordering. Read off the left-side ordering
	// positions [0..partitionLen) directly at emit time; if the rule promoted
	// to merge, they exist.
	const leftOrdering = plan.left.physical.ordering ?? [];
	const partitionDescending: boolean[] = [];
	for (let i = 0; i < partitionLen; i++) {
		partitionDescending.push(leftOrdering[i]?.desc ?? false);
	}

	function hasNullPartitionLeft(row: Row): boolean {
		for (const idx of leftPartitionIndices) {
			if (row[idx] === null) return true;
		}
		return false;
	}
	function hasNullPartitionRight(row: Row): boolean {
		for (const idx of rightPartitionIndices) {
			if (row[idx] === null) return true;
		}
		return false;
	}

	/**
	 * Compare partition tuples drawn from a left row and a right row, using
	 * per-position collations and the agreed direction. Returns negative when
	 * left's partition is "before" right's in the agreed direction, positive
	 * when "after", zero when equal.
	 */
	function comparePartitions(leftRow: Row, rightRow: Row): number {
		for (let i = 0; i < partitionLen; i++) {
			const a = leftRow[leftPartitionIndices[i]];
			const b = rightRow[rightPartitionIndices[i]];
			let c = compareSqlValuesFast(a, b, partitionCollations[i]);
			if (partitionDescending[i]) c = -c;
			if (c !== 0) return c;
		}
		return 0;
	}

	/** Variant of `comparePartitions` for two left rows (e.g. tracking the active partition). */
	function compareLeftPartitions(a: Row, b: Row): number {
		for (let i = 0; i < partitionLen; i++) {
			const idx = leftPartitionIndices[i];
			let c = compareSqlValuesFast(a[idx], b[idx], partitionCollations[i]);
			if (partitionDescending[i]) c = -c;
			if (c !== 0) return c;
		}
		return 0;
	}

	async function* run(
		rctx: RuntimeContext,
		leftSource: AsyncIterable<Row>,
		rightSource: AsyncIterable<Row>,
	): AsyncIterable<Row> {
		log('Starting %s asof scan [merge]: direction=%s, %d partition keys, strict=%s',
			plan.outer ? 'LEFT' : 'INNER', direction, partitionLen, strict);

		const leftSlot = createRowSlot(rctx, leftRowDescriptor, `AsofScan#${plan.id}:left`);
		const rightSlot = createRowSlot(rctx, rightRowDescriptor, `AsofScan#${plan.id}:right`);

		const leftIter = peekableAsyncIterator(leftSource);
		const rightIter = peekableAsyncIterator(rightSource);

		// Per-partition state. `activePartitionRow` is the left row that
		// established the current partition's identity; on a partition change
		// we reset `descMatched` and drain right.
		let activePartitionRow: Row | undefined;
		let descMatched: Row | undefined;

		try {
			while (true) {
				const leftRow = await leftIter.peek();
				if (!leftRow) break;

				// NULL match or partition on left: pad/drop and advance.
				if (leftRow[leftMatchIdx] === null || hasNullPartitionLeft(leftRow)) {
					leftSlot.set(leftRow);
					const padding = joinOutputRow(outerJoinType, false, false, leftRow, projectedRightColCount, rightSlot);
					if (padding) yield padding;
					leftIter.consume();
					continue;
				}

				// Partition transition?
				const partitionChanged = !activePartitionRow ||
					compareLeftPartitions(activePartitionRow, leftRow) !== 0;
				if (partitionChanged) {
					descMatched = undefined;
					activePartitionRow = leftRow;
					// Drain right of NULLs and rows in earlier partitions.
					while (true) {
						const r = await rightIter.peek();
						if (!r) break;
						if (r[rightMatchIdx] === null || hasNullPartitionRight(r)) {
							rightIter.consume();
							continue;
						}
						const cmpP = comparePartitions(leftRow, r);
						if (cmpP > 0) {
							rightIter.consume();
							continue;
						}
						break;
					}
				}

				// Run the per-leftRow inner loop.
				leftSlot.set(leftRow);
				const leftMatch = leftRow[leftMatchIdx];
				let matched: Row | undefined;

				if (direction === 'desc') {
					// Advance while next-right's matchAttr still qualifies (≤, or < when strict).
					// `descMatched` persists across consecutive same-partition left rows.
					while (true) {
						const r = await rightIter.peek();
						if (!r) break;
						if (r[rightMatchIdx] === null || hasNullPartitionRight(r)) {
							rightIter.consume();
							continue;
						}
						const cmpP = comparePartitions(leftRow, r);
						if (cmpP !== 0) break; // partition advanced past current
						const cmpM = compareSqlValuesFast(r[rightMatchIdx], leftMatch, matchCollation);
						if (!(strict ? cmpM < 0 : cmpM <= 0)) break;
						descMatched = r;
						rightIter.consume();
					}
					matched = descMatched;
				} else {
					// 'asc': advance while peek's matchAttr is too small. The first
					// qualifier is the answer; do NOT consume it (it may match
					// subsequent left rows in the same partition).
					while (true) {
						const r = await rightIter.peek();
						if (!r) break;
						if (r[rightMatchIdx] === null || hasNullPartitionRight(r)) {
							rightIter.consume();
							continue;
						}
						const cmpP = comparePartitions(leftRow, r);
						if (cmpP !== 0) break;
						const cmpM = compareSqlValuesFast(r[rightMatchIdx], leftMatch, matchCollation);
						if (strict ? cmpM <= 0 : cmpM < 0) {
							rightIter.consume();
							continue;
						}
						matched = r;
						break;
					}
				}

				if (matched) {
					rightSlot.set(matched);
					const projectedRight = projectRight(matched);
					// The right scan's own rowSlot (created when its iterator started)
					// holds the cursor's *current* peek — by the time we land here
					// it's the row that broke the desc loop / first qualifier of asc,
					// not necessarily `matched`. Reclaim our descriptor so
					// downstream attribute-index lookups for the right's attr ids
					// resolve through *our* slot rather than the scan's cursor.
					rightSlot.reactivate();
					yield [...leftRow, ...projectedRight] as Row;
				} else {
					const padding = joinOutputRow(outerJoinType, false, false, leftRow, projectedRightColCount, rightSlot);
					if (padding) {
						// Same shadowing concern as the matched branch: ensure NULL
						// padding wins the attributeIndex race against the still-
						// running right scan's slot.
						rightSlot.reactivate();
						yield padding;
					}
				}

				leftIter.consume();
			}
		} finally {
			leftSlot.close();
			rightSlot.close();
			await leftIter.close();
			await rightIter.close();
		}
	}

	const leftInstruction = emitPlanNode(plan.left, ctx);
	const rightInstruction = emitPlanNode(plan.right, ctx);

	return {
		params: [leftInstruction, rightInstruction],
		run: asRun(run),
		note: `${plan.outer ? 'left' : 'inner'} asof scan [merge]${strict ? ' strict' : ''}`,
	};
}

/**
 * Peek-1 wrapper over an `AsyncIterable<Row>`. `peek()` lazily fetches and
 * caches the head row; `consume()` discards it; `close()` returns the
 * iterator if it has a `return` method.
 */
interface PeekableAsyncIter {
	peek(): Promise<Row | undefined>;
	consume(): void;
	close(): Promise<void>;
}

function peekableAsyncIterator(source: AsyncIterable<Row>): PeekableAsyncIter {
	const it = source[Symbol.asyncIterator]();
	let head: Row | undefined;
	let hasHead = false;
	let done = false;

	return {
		async peek(): Promise<Row | undefined> {
			if (hasHead) return head;
			if (done) return undefined;
			const r = await it.next();
			if (r.done) {
				done = true;
				return undefined;
			}
			head = r.value;
			hasHead = true;
			return head;
		},
		consume(): void {
			head = undefined;
			hasHead = false;
		},
		async close(): Promise<void> {
			if (it.return) {
				try { await it.return(); } catch { /* ignore */ }
			}
		},
	};
}
