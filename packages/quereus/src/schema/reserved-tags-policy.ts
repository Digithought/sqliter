import { QuereusError } from '../common/errors.js';
import { StatusCode } from '../common/types.js';
import type { TagDiagnostic } from './reserved-tags.js';

/**
 * The shared caller-policy for reserved-tag diagnostics.
 *
 * {@link validateReservedTags} (in `./reserved-tags.ts`) is deliberately
 * policy-free: it returns sited {@link TagDiagnostic}s with per-diagnostic
 * severity and never throws. Every consumer that wants to *act* on those
 * diagnostics shares one policy:
 *
 * > first `severity:'error'` diagnostic (unknown / mis-sited / malformed key)
 * > ⇒ throw a {@link QuereusError} with its sited message; `severity:'warning'`
 * > diagnostics (e.g. an empty `quereus.lens.ack` rationale) ⇒ log, never block.
 *
 * This is that single helper, replacing four hand-copied raise loops
 * (`lens-compiler.validateLensTags`, `mapping-advertisement-tags
 * .buildAdvertisementsFromTags`, `mutation/mutation-tags.raiseTagDiagnostics`,
 * and the declarative differ). It lives in this sibling module — not in
 * `reserved-tags.ts` — so the registry itself keeps its "never throws, no
 * QuereusError dependency" guarantee.
 */
export function raiseReservedTagDiagnostics(
	diagnostics: readonly TagDiagnostic[],
	opts?: {
		/** Prepended to the thrown error message (e.g. a view-context prefix). */
		messagePrefix?: string;
		/** Source location threaded into the QuereusError for a sited diagnostic. */
		loc?: { line?: number; column?: number };
		/** Per-warning sink; called for every diagnostic only when none is an error. */
		log?: (diagnostic: TagDiagnostic) => void;
	},
): void {
	if (diagnostics.length === 0) return;
	const firstError = diagnostics.find(d => d.severity === 'error');
	if (firstError) {
		throw new QuereusError(
			`${opts?.messagePrefix ?? ''}${firstError.message}`,
			StatusCode.ERROR,
			undefined,
			opts?.loc?.line,
			opts?.loc?.column,
		);
	}
	if (opts?.log) {
		for (const diagnostic of diagnostics) opts.log(diagnostic);
	}
}
