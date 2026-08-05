/**
 * AbortSignal combination for paths that must honor more than one cancellation
 * source (e.g. a caller's signal plus the database-close signal on the
 * mutex-free committed-read path). Implemented with a plain AbortController
 * rather than `AbortSignal.any` for cross-platform reach (Hermes / older
 * runtimes).
 */

export interface CombinedAbortSignal {
	/** Fires when ANY input signal fires; undefined when no input was supplied. */
	readonly signal: AbortSignal | undefined;
	/**
	 * Detach the combiner's listeners from the input signals. Call on every exit
	 * path (a `finally`) so a long-lived input signal does not accumulate one
	 * listener per execution.
	 */
	dispose(): void;
}

const noop = () => { /* nothing attached */ };

/**
 * Combine any number of possibly-undefined signals into one. Zero defined
 * inputs yields `signal: undefined`; exactly one is passed through untouched
 * (nothing to dispose); two or more are joined via a fresh controller that
 * aborts as soon as any input aborts (or immediately if one already has).
 */
export function combineAbortSignals(...signals: Array<AbortSignal | undefined>): CombinedAbortSignal {
	const live = signals.filter((s): s is AbortSignal => s !== undefined);
	if (live.length === 0) return { signal: undefined, dispose: noop };
	if (live.length === 1) return { signal: live[0], dispose: noop };
	const controller = new AbortController();
	const onAbort = () => controller.abort();
	const attached: AbortSignal[] = [];
	for (const s of live) {
		if (s.aborted) {
			controller.abort();
			break;
		}
		s.addEventListener('abort', onAbort, { once: true });
		attached.push(s);
	}
	return {
		signal: controller.signal,
		dispose: () => {
			for (const s of attached) s.removeEventListener('abort', onAbort);
		},
	};
}
