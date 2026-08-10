import type { Database } from '../../core/database.js';
import type { AnyVirtualTableModule } from '../../vtab/module.js';
import type { DdlTransactionality } from '../../vtab/capabilities.js';
import { QuereusError } from '../../common/errors.js';
import { StatusCode } from '../../common/types.js';

/**
 * Resolve a module's declared DDL-transactionality tier, applying the engine-side
 * default (`'non-transactional'`) when the module omits the flag or has no
 * `getCapabilities` at all. A module must EXPLICITLY claim `'transactional'`.
 */
export function resolveDdlTransactionality(
	module: AnyVirtualTableModule | undefined,
): DdlTransactionality {
	return module?.getCapabilities?.().ddlTransactionality ?? 'non-transactional';
}

/**
 * Whether an EXPLICIT (`BEGIN`-opened) transaction is currently open.
 *
 * This must NOT be confused with "any transaction is open". A DDL statement in
 * autocommit mode lazily starts an *implicit* transaction (via
 * `_ensureTransaction()`), and nested DDL a statement issues during that implicit
 * transaction (e.g. the ALTER-rebuild path's `_execWithinTransaction`) sees
 * `getAutocommit() === false` even though no `BEGIN` was ever issued. Keying off
 * autocommit alone would wrongly gate that autocommit-mode DDL. Combining the two
 * signals — not autocommit AND not an implicit transaction — is exactly "an
 * explicit BEGIN is open", the only case the strict gate targets.
 */
export function isExplicitTransactionOpen(db: Database): boolean {
	return !db.getAutocommit() && !db._isImplicitTransaction();
}

/**
 * Whether the strict DDL-transaction policy is in effect. Cheap option read;
 * emitters that must do extra work to resolve the owning module (e.g. the
 * `drop index` schema scan) guard that work behind this so the default
 * `'permissive'` path stays free.
 */
export function isDdlPolicyStrict(db: Database): boolean {
	return db.options.getStringOption('ddl_transaction_policy') === 'strict';
}

/**
 * Strict-mode gate for module-dispatching DDL. Under `ddl_transaction_policy =
 * 'strict'`, a schema change that dispatches to a module DDL surface while an
 * explicit transaction is open is refused with a sited error UNLESS the owning
 * module declares `ddlTransactionality: 'transactional'` — because on every other
 * tier the schema change escapes the transaction (survives rollback), and on
 * `'auto-commit'` it also force-commits the module's buffered DML.
 *
 * Under the default `'permissive'` policy this is a no-op — behavior is unchanged.
 *
 * MUST be called at the top of the emitter's `run()`, BEFORE `_ensureTransaction()`
 * and before any catalog mutation or module method call: on refusal the enclosing
 * transaction (and any savepoints) must remain fully open and usable.
 *
 * @param module the module that would own/execute the DDL (undefined ⇒ treated as
 *   the `'non-transactional'` default, so strict still refuses).
 * @param moduleName the module's registered name, for the message.
 * @param statementLabel a human-readable statement label, e.g. `CREATE INDEX foo`.
 */
export function assertDdlTransactionPolicy(
	db: Database,
	module: AnyVirtualTableModule | undefined,
	moduleName: string | undefined,
	statementLabel: string,
): void {
	if (!isDdlPolicyStrict(db)) return;
	if (!isExplicitTransactionOpen(db)) return;

	const tier = resolveDdlTransactionality(module);
	if (tier === 'transactional') return;

	const modLabel = moduleName ? `module '${moduleName}'` : 'the backing module';
	throw new QuereusError(
		`${statementLabel} is not allowed inside an explicit transaction under `
			+ `ddl_transaction_policy = strict: ${modLabel} declares ddlTransactionality = '${tier}', `
			+ `so the schema change would escape the transaction (it survives rollback`
			+ `${tier === 'auto-commit' ? ' and force-commits buffered writes' : ''}). `
			+ `Run it in autocommit mode, or set ddl_transaction_policy = permissive.`,
		StatusCode.ERROR,
	);
}
