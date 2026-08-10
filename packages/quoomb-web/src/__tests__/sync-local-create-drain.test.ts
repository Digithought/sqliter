import { describe, it, expect, vi } from 'vitest';

import {
	createLocalCreateDrainListener,
	type LocalCreateDrainTarget,
} from '../worker/sync-local-create-drain.js';
import type { DatabaseSchemaChangeEvent } from '@quereus/quereus';

function makeTarget(): { target: LocalCreateDrainTarget; calls: Array<{ schema?: string; table?: string }> } {
	const calls: Array<{ schema?: string; table?: string }> = [];
	const target: LocalCreateDrainTarget = {
		drainHeldChanges: (schema?: string, table?: string) => {
			calls.push({ schema, table });
			return Promise.resolve(0);
		},
	};
	return { target, calls };
}

function makeEvent(
	overrides: Partial<DatabaseSchemaChangeEvent> = {},
): DatabaseSchemaChangeEvent {
	return {
		type: 'create',
		objectType: 'table',
		moduleName: 'store',
		schemaName: 'main',
		objectName: 'orders',
		remote: false,
		...overrides,
	};
}

describe('createLocalCreateDrainListener', () => {
	it('fires drainHeldChanges with schemaName and objectName for a local create table', async () => {
		const { target, calls } = makeTarget();
		const log = vi.fn();
		const listener = createLocalCreateDrainListener(() => target, log);

		listener(makeEvent({ schemaName: 'main', objectName: 'orders' }));
		await Promise.resolve(); // flush the void promise

		expect(calls).toHaveLength(1);
		expect(calls[0]).toEqual({ schema: 'main', table: 'orders' });
		expect(log).not.toHaveBeenCalled();
	});

	it('ignores remote:true (remote create_table is drained reactively inside the library)', () => {
		const { target, calls } = makeTarget();
		const log = vi.fn();
		const listener = createLocalCreateDrainListener(() => target, log);

		listener(makeEvent({ remote: true }));

		expect(calls).toHaveLength(0);
		expect(log).not.toHaveBeenCalled();
	});

	it('ignores type:alter', () => {
		const { target, calls } = makeTarget();
		const listener = createLocalCreateDrainListener(() => target, vi.fn());

		listener(makeEvent({ type: 'alter' }));

		expect(calls).toHaveLength(0);
	});

	it('ignores type:drop', () => {
		const { target, calls } = makeTarget();
		const listener = createLocalCreateDrainListener(() => target, vi.fn());

		listener(makeEvent({ type: 'drop' }));

		expect(calls).toHaveLength(0);
	});

	it('ignores objectType:index', () => {
		const { target, calls } = makeTarget();
		const listener = createLocalCreateDrainListener(() => target, vi.fn());

		listener(makeEvent({ objectType: 'index' }));

		expect(calls).toHaveLength(0);
	});

	it('ignores objectType:column', () => {
		const { target, calls } = makeTarget();
		const listener = createLocalCreateDrainListener(() => target, vi.fn());

		listener(makeEvent({ objectType: 'column' }));

		expect(calls).toHaveLength(0);
	});

	it('is a clean no-op when getTarget returns null', () => {
		const log = vi.fn();
		const listener = createLocalCreateDrainListener(() => null, log);

		expect(() => listener(makeEvent())).not.toThrow();
		expect(log).not.toHaveBeenCalled();
	});

	it('swallows a rejected drainHeldChanges and logs it — listener never throws', async () => {
		const boom = new Error('drain failure');
		const target: LocalCreateDrainTarget = {
			drainHeldChanges: () => Promise.reject(boom),
		};
		const log = vi.fn();
		const listener = createLocalCreateDrainListener(() => target, log);

		expect(() => listener(makeEvent({ schemaName: 'main', objectName: 'orders' }))).not.toThrow();

		// Wait for the microtask to settle so the .catch runs.
		await new Promise((r) => setTimeout(r, 0));

		expect(log).toHaveBeenCalledTimes(1);
		expect(log).toHaveBeenCalledWith('main', 'orders', boom);
	});

	it('re-reads the target each event: goes no-op once getTarget is cleared', async () => {
		const { target, calls } = makeTarget();
		let current: LocalCreateDrainTarget | null = target;
		const listener = createLocalCreateDrainListener(() => current, vi.fn());

		listener(makeEvent());
		await Promise.resolve();
		expect(calls).toHaveLength(1);

		current = null;
		listener(makeEvent());
		await Promise.resolve();
		expect(calls).toHaveLength(1); // unchanged
	});
});
