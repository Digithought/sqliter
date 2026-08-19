import { collectSnapshots } from './work-counter-stability-shared.js';

/**
 * Child-process runner for the cross-process leg of
 * work-counter-stability.spec.ts. Forked with a warmup count in argv[2] and
 * reports over IPC (`process.send`), NOT stdout — ts-node may chat on stdio.
 */

const warmup = Number(process.argv[2] ?? '0');

collectSnapshots(warmup).then(
	(snapshots) => {
		process.send!({ ok: true, snapshots });
		process.disconnect?.();
	},
	(error: unknown) => {
		process.send!({ ok: false, error: String(error instanceof Error ? error.stack ?? error.message : error) });
		process.disconnect?.();
	},
);
