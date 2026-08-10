import type { ViewMutationNode } from '../../planner/nodes/view-mutation-node.js';
import { isRelationalNode } from '../../planner/nodes/plan-node.js';
import type { Instruction, RuntimeContext } from '../types.js';
import { asRun } from '../types.js';
import type { RuntimeValue, OutputValue, Row, SqlValue, SubProgram } from '../../common/types.js';
import type { EmissionContext } from '../emission-context.js';
import { emitCallFromPlan } from '../emitters.js';
import { isAsyncIterable } from '../utils.js';
import { createRowSlot } from '../context-helpers.js';
import type { RowDescriptor, TableDescriptor } from '../../planner/nodes/plan-node.js';


/**
 * Emit a view-/MV-mediated mutation.
 *
 * Each base op is a fully-built base-table DML subtree (Sink-topped for the
 * non-RETURNING spine). They are emitted as **callbacks** (`emitCallFromPlan`
 * wraps each subtree in its own sub-program) rather than bare params, then this
 * instruction's `run` invokes them **sequentially**, awaiting each to completion
 * before starting the next.
 *
 * This sequencing is load-bearing for multi-source decomposition: the scheduler
 * kicks off sibling params concurrently (it does not await one before starting
 * the next — see `Scheduler.runAsyncLoop`), so a bare-param fan-out would interleave
 * the base writes and lose the FK-parent-before-child ordering the decomposition
 * decided. Driving the callbacks in list order here makes the emitted order the
 * executed order. For the single-source spine there is exactly one base op, so
 * this degenerates to driving that one to completion.
 *
 * **Shared-surrogate envelope (multi-source insert).** When `plan.envelope` is
 * present, before any base op runs this:
 *   1. materializes the augmented source once into an array (every supplied view
 *      column, in projection order);
 *   2. if `keyDefault` is set, evaluates the anchor key column's `default` **once per
 *      produced row** — with `rctx.mutationOrdinal` set to the row's 1-based ordinal so
 *      `mutation_ordinal()` resolves, and any `max()` subquery observing pre-mutation
 *      state — and appends the value as the last column of each row (the
 *      evaluate-once-per-row, thread-everywhere shared key); and
 *   3. stashes the rows in `rctx.tableContexts` under the envelope descriptor.
 * The base ops (run with this same `rctx`) each read those rows back through an
 * `EnvelopeScanNode`, so the shared key is identical across the fan-out. The
 * context entry is removed in a `finally` so it never leaks past the statement.
 *
 * **RETURNING-through-view.** When the mutation has a `returning` clause the node
 * is relational and this emitter yields the view-projected rows (materialized
 * eagerly, so the base writes fire inside `run` regardless of the node's position
 * in a block — matching the void path's eager drain). Two shapes:
 *   - *single-source*: the RETURNING clause was rewritten onto the (sole) base op,
 *     which plans to a relational `ReturningNode`. `run` drains every base op and
 *     surfaces that one's rows (NEW for insert/update, OLD for delete).
 *   - *multi-source* update/delete: `plan.returning` is a separate re-query. A
 *     delete captures it **before** the base ops fire (`returningTiming === 'pre'` —
 *     the rows are about to disappear). An update (`'post'`) reads the post-mutation
 *     join body restricted to the `plan.identityCapture` identities (so a row the
 *     update pushed out of the view filter, or whose predicate column it rewrote, is
 *     still returned).
 *
 * **Up-front identity capture (multi-source update / multi-side delete).** When
 * `plan.identityCapture` is present, before any base op runs this materializes each
 * affected view row's base-PK identities into `rctx.tableContexts` under the capture
 * descriptor — read back by descriptor by the multi-side base ops' identifying
 * subqueries (`<pk> in (select k<side> from __vmupd_keys)`) and/or the post-mutation
 * RETURNING re-query. Wrapped across all branches (a both-sides update / multi-side
 * delete without RETURNING still needs it) and removed in a `finally`. Mutually
 * exclusive with the insert envelope.
 *
 * **Chained nested captures (set-op multi-source leg compose).** `plan.nestedCaptures`
 * adds further captures materialized AFTER the primary, in list order, before the base
 * ops. A nested capture's source may scan a strictly-earlier capture's rows (e.g. an
 * inner base-PK capture whose `memberExists` probe reads the outer set-op capture's
 * `__vmupd_keys`), so they are materialized primary → nested[0] → nested[1] → … and torn
 * down in REVERSE in a `finally` (so a throw mid-statement leaks no context entry).
 *
 * Without a `returning` clause every base op is a side-effect statement that
 * yields nothing and this node yields nothing; the block emitter treats it like a
 * Sink for result selection.
 */
export function emitViewMutation(plan: ViewMutationNode, ctx: EmissionContext): Instruction {
	const baseOpInstructions = plan.baseOps.map(op => emitCallFromPlan(op, ctx));
	const baseOpCount = baseOpInstructions.length;

	const envelope = plan.envelope;
	const descriptor = envelope?.descriptor;
	// When set, the anchor key column's `default` is evaluated once per produced row at
	// the envelope (with `mutation_ordinal()` in scope) and appended as the shared key.
	const hasKeyDefault = !!envelope?.keyDefault;

	// The relational base op carrying a single-source RETURNING (the rewritten,
	// view-projected clause), or -1. Mutually exclusive with `plan.returning`.
	const relationalBaseIdx = plan.baseOps.findIndex(op => isRelationalNode(op));
	const returningTiming = plan.returningTiming;

	// The up-front identity-capture side input for a multi-source UPDATE / multi-side
	// DELETE fan-out: its rows (each affected view row's base-PK identities) are
	// materialized into context (under this descriptor) BEFORE the base ops run, and
	// read back by descriptor by the multi-side base ops' identifying subqueries
	// and/or the post-mutation RETURNING re-query. Present for a both-sides update
	// (with or without RETURNING), a single-side update with RETURNING, and a
	// multi-side delete fan-out (with or without RETURNING).
	const capture = plan.identityCapture;
	const captureDescriptor = capture?.descriptor;

	// Nested identity captures (set-op multi-source leg compose): materialized AFTER the
	// primary capture, in list order, BEFORE the base ops. Each nested source may scan a
	// strictly-earlier capture's materialized rows (the primary, or an earlier nested
	// entry), so the materialization order is load-bearing.
	const nestedCaptures = plan.nestedCaptures ?? [];

	// Params follow the same order `ViewMutationNode.getChildren` threads them in:
	// base-op callbacks, then the optional RETURNING re-query, then the optional
	// identity-capture source, then the nested-capture sources (in list order), then the
	// envelope source + optional surrogate seed — so the scheduler resolves every
	// sub-program before `run`.
	const params: Instruction[] = [...baseOpInstructions];
	let cursor = baseOpCount;
	let returningIdx = -1;
	if (plan.returning) { returningIdx = cursor++; params.push(emitCallFromPlan(plan.returning, ctx)); }
	let captureIdx = -1;
	if (capture) { captureIdx = cursor++; params.push(emitCallFromPlan(capture.source, ctx)); }
	// One param slot per nested capture source, in list order, immediately after the
	// primary capture and before the envelope source — matching `getChildren`.
	const nestedCaptureIdxs: number[] = [];
	for (const nested of nestedCaptures) {
		nestedCaptureIdxs.push(cursor++);
		params.push(emitCallFromPlan(nested.source, ctx));
	}
	let envSourceIdx = -1;
	if (envelope) { envSourceIdx = cursor++; params.push(emitCallFromPlan(envelope.source, ctx)); }
	let keyDefaultIdx = -1;
	if (envelope?.keyDefault) { keyDefaultIdx = cursor++; params.push(emitCallFromPlan(envelope.keyDefault, ctx)); }

	async function drainBaseOps(rctx: RuntimeContext, baseCbs: RuntimeValue[]): Promise<void> {
		for (const cb of baseCbs) {
			const result = (cb as SubProgram)(rctx);
			const resolved = result instanceof Promise ? await result : result;
			// A Sink-topped base op resolves to null; defensively drain a relational
			// result so its writes fire before the next op.
			if (isAsyncIterable(resolved)) {
				for await (const _row of resolved) { /* drain side effects */ }
			}
		}
	}

	/** Drain a base-op / re-query callback result fully into a materialized row array. */
	async function collectRows(value: OutputValue): Promise<Row[]> {
		const resolved = value instanceof Promise ? await value : value;
		const rows: Row[] = [];
		if (isAsyncIterable(resolved)) {
			for await (const row of resolved as AsyncIterable<Row>) rows.push(row);
		}
		return rows;
	}

	async function materializeEnvelope(
		rctx: RuntimeContext,
		sourceCb: SubProgram,
		keyDefaultCb: SubProgram | undefined,
		keyDefaultRowDescriptor: RowDescriptor | undefined,
	): Promise<Row[]> {
		const rows: Row[] = [];
		const sourceResult = sourceCb(rctx);
		const resolved = sourceResult instanceof Promise ? await sourceResult : sourceResult;
		if (isAsyncIterable(resolved)) {
			// Save/restore the ambient ordinal so a nested mutation never sees a stale
			// value and it does not leak past the envelope.
			const savedOrdinal = rctx.mutationOrdinal;
			// When the key default reads supplied siblings via `new.<col>`, expose THIS
			// row (the supplied columns, before the `__shared_key` is appended) to those
			// column refs through a row slot over the key default's descriptor. Installed
			// once, updated by reference per row, torn down in `finally`.
			const keySlot = keyDefaultCb && keyDefaultRowDescriptor
				? createRowSlot(rctx, keyDefaultRowDescriptor)
				: undefined;
			let ordinal = 0;
			try {
				for await (const row of resolved as AsyncIterable<Row>) {
					ordinal += 1;
					if (keyDefaultCb) {
						// Evaluate the anchor key column's `default` once for THIS row, with
						// `mutation_ordinal()` resolving to its 1-based ordinal and any `max()`
						// subquery observing pre-mutation state (no base write has fired). The
						// single value threads into every member's key column via the EC.
						rctx.mutationOrdinal = ordinal;
						keySlot?.set(row as Row);
						// Resolve without a per-row microtask hop (see runtime/async-util.ts).
						const rawMinted = keyDefaultCb(rctx);
						const minted = rawMinted instanceof Promise ? await rawMinted : rawMinted;
						rows.push([...row, minted as SqlValue] as Row);
					} else {
						rows.push(row as Row);
					}
				}
			} finally {
				rctx.mutationOrdinal = savedOrdinal;
				keySlot?.close();
			}
		}
		return rows;
	}

	async function run(rctx: RuntimeContext, ...args: RuntimeValue[]): Promise<RuntimeValue> {
		const baseCbs = args.slice(0, baseOpCount);

		// Identity captures (multi-source UPDATE / multi-side DELETE fan-out, and the
		// set-op leg compose's chained captures): materialize each affected-row capture's
		// rows into context BEFORE any base op runs, then run the body. This wraps ALL
		// branches — the multi-side base ops (which read `__vmupd_keys` by descriptor) and
		// the post-mutation RETURNING re-query both read the captured set, and a multi-side
		// mutation WITHOUT RETURNING still needs it for the base ops.
		//
		// The captures are materialized in a load-bearing order: the primary
		// `identityCapture` first, then each nested capture in list order. A nested
		// capture's source may scan a STRICTLY-earlier capture's rows (read back by
		// descriptor), so the earlier `tableContexts` entry must already be set when the
		// nested source runs. Each entry set is removed in `finally`, in REVERSE order, so
		// a partially-run statement (a base op — or a later nested capture's
		// materialization — throwing) never leaks a context entry into a sibling statement.
		//
		// Ordered off whatever captures are present (primary-then-nested), so a statement
		// with nested captures but no primary is handled cleanly too.
		const orderedCaptureIdxs: { descriptor: TableDescriptor; idx: number }[] = [];
		if (captureIdx >= 0 && captureDescriptor) {
			orderedCaptureIdxs.push({ descriptor: captureDescriptor, idx: captureIdx });
		}
		for (let i = 0; i < nestedCaptureIdxs.length; i++) {
			orderedCaptureIdxs.push({ descriptor: nestedCaptures[i].descriptor, idx: nestedCaptureIdxs[i] });
		}

		if (orderedCaptureIdxs.length === 0) {
			return runBody(rctx, args, baseCbs);
		}

		// Teardown stack: only the descriptors actually set are removed (in reverse), so a
		// throw mid-materialization tears down exactly what was installed.
		const setDescriptors: TableDescriptor[] = [];
		try {
			for (const { descriptor: capDescriptor, idx } of orderedCaptureIdxs) {
				const captureRows = await collectRows((args[idx] as SubProgram)(rctx));
				rctx.tableContexts.set(capDescriptor, () => arrayIterable(captureRows));
				setDescriptors.push(capDescriptor);
			}
			return await runBody(rctx, args, baseCbs);
		} finally {
			for (let i = setDescriptors.length - 1; i >= 0; i--) {
				rctx.tableContexts.delete(setDescriptors[i]);
			}
		}
	}

	async function runBody(rctx: RuntimeContext, args: RuntimeValue[], baseCbs: RuntimeValue[]): Promise<RuntimeValue> {
		// (1) Multi-source RETURNING via a separate re-query of the view.
		if (returningIdx >= 0) {
			const returningCb = args[returningIdx] as SubProgram;
			if (returningTiming === 'pre') {
				// delete: capture the to-be-deleted view rows before the base ops fire.
				const rows = await collectRows(returningCb(rctx));
				await drainBaseOps(rctx, baseCbs);
				return arrayIterable(rows);
			}
			// update (post): the identity capture (if any) was already materialized by
			// `run`'s wrapper; mutate, then the re-query reads the post-mutation image
			// restricted to those captured identities (robust against an update that
			// rewrites its own predicate column).
			await drainBaseOps(rctx, baseCbs);
			return arrayIterable(await collectRows(returningCb(rctx)));
		}

		// (2) Single-source RETURNING rewritten onto the (sole) relational base op.
		// Drain every base op in list order (firing writes); surface the relational
		// one's view-projected rows.
		if (relationalBaseIdx >= 0) {
			let resultRows: Row[] = [];
			for (let i = 0; i < baseCbs.length; i++) {
				const rows = await collectRows((baseCbs[i] as SubProgram)(rctx));
				if (i === relationalBaseIdx) resultRows = rows;
			}
			return arrayIterable(resultRows);
		}

		// (3) Void mutation (no RETURNING): drive the base ops, yield nothing. A
		// both-sides update / multi-side delete fan-out without RETURNING lands here
		// with its identity capture already materialized by `run`, so the base ops read
		// `__vmupd_keys`.
		if (!descriptor) {
			await drainBaseOps(rctx, baseCbs);
			return null;
		}

		const sourceCb = args[envSourceIdx] as SubProgram;
		const keyDefaultCb = hasKeyDefault ? (args[keyDefaultIdx] as SubProgram) : undefined;
		const rows = await materializeEnvelope(rctx, sourceCb, keyDefaultCb, envelope?.keyDefaultRowDescriptor);
		rctx.tableContexts.set(descriptor, () => arrayIterable(rows));
		try {
			await drainBaseOps(rctx, baseCbs);
		} finally {
			rctx.tableContexts.delete(descriptor);
		}
		return null;
	}

	const retNote = plan.returning ? ` +returning(${returningTiming}${capture ? '+capture' : ''})` : relationalBaseIdx >= 0 ? ' +returning' : '';
	const nestedNote = nestedCaptures.length > 0 ? ` +nested(${nestedCaptures.length})` : '';
	return {
		params,
		run: asRun(run),
		note: `viewMutation(${baseOpCount} base op${baseOpCount === 1 ? '' : 's'}${envelope ? ' +envelope' : ''}${retNote}${nestedNote})`,
	};
}

async function* arrayIterable(rows: Row[]): AsyncIterable<Row> {
	for (const row of rows) yield row;
}
