import type { EmissionContext } from '../emission-context.js';
import type { TransactionNode } from '../../planner/nodes/transaction-node.js';
import type { Instruction, RuntimeContext } from '../types.js';
import { asRun } from '../types.js';
import type { SqlValue } from '../../common/types.js';
import { createLogger } from '../../common/logger.js';
import { quereusError } from '../../common/errors.js';
import { StatusCode } from '../../common/types.js';

const log = createLogger('runtime:emit:transaction');

export function emitTransaction(plan: TransactionNode, _ctx: EmissionContext): Instruction {
	// Select the operation function at emit time
	let run: (ctx: RuntimeContext) => Promise<SqlValue>;
	let note: string;

	switch (plan.operation) {
		case 'begin': {
			run = async (rctx: RuntimeContext) => {
				log('BEGIN: Starting explicit transaction');
				await rctx.db._beginTransaction('explicit');
				return null;
			};
			note = 'BEGIN';
			break;
		}

		case 'commit': {
			run = async (rctx: RuntimeContext) => {
				log('COMMIT: Committing transaction');
				await rctx.db._commitTransaction();
				return null;
			};
			note = 'COMMIT';
			break;
		}

		case 'rollback': {
			if (plan.savepoint) {
				const savepointName = plan.savepoint;
				run = async (rctx: RuntimeContext) => {
					log(`ROLLBACK TO SAVEPOINT ${savepointName}`);
					await rctx.db._rollbackToSavepointBroadcast(savepointName);
					return null;
				};
				note = `ROLLBACK TO SAVEPOINT ${plan.savepoint}`;
			} else {
				run = async (rctx: RuntimeContext) => {
					log('ROLLBACK: Rolling back transaction');
					await rctx.db._rollbackTransaction();
					return null;
				};
				note = 'ROLLBACK';
			}
			break;
		}

		case 'savepoint': {
			if (!plan.savepoint) {
				quereusError('Savepoint name is required for SAVEPOINT operation', StatusCode.MISUSE);
			}
			const savepointName = plan.savepoint;
			run = async (rctx: RuntimeContext) => {
				// Ensure we're in a transaction first (savepoints require transaction context)
				await rctx.db._ensureTransaction();

				// Upgrade implicit transaction to explicit - savepoints mean the user
				// wants transaction control, so we shouldn't auto-commit
				rctx.db._upgradeToExplicitTransaction();

				const depth = await rctx.db._createSavepointBroadcast(savepointName);
				log(`SAVEPOINT ${savepointName} (depth ${depth})`);
				return null;
			};
			note = `SAVEPOINT ${plan.savepoint}`;
			break;
		}

		case 'release': {
			if (!plan.savepoint) {
				quereusError('Savepoint name is required for RELEASE operation', StatusCode.MISUSE);
			}
			const savepointName = plan.savepoint;
			run = async (rctx: RuntimeContext) => {
				log(`RELEASE SAVEPOINT ${savepointName}`);
				await rctx.db._releaseSavepointBroadcast(savepointName);
				return null;
			};
			note = `RELEASE SAVEPOINT ${plan.savepoint}`;
			break;
		}

		default:
			quereusError(
				`Unsupported transaction operation: ${plan.operation}`,
				StatusCode.UNSUPPORTED
			);
	}

	return {
		params: [],
		run: asRun(run),
		note
	};
}
