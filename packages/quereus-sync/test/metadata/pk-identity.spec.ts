/**
 * Tests for pk-identity keying resolution (`metadata/pk-identity.ts`) — the
 * bridge between a table's schema and the identity its sync metadata files
 * under. The end-to-end convergence consequences live in
 * `test/sync/pk-key-identity.spec.ts`; these pin the resolver's own contract.
 */

import { expect } from 'chai';
import { Database, type TableSchema } from '@quereus/quereus';
import { StoreModule, StoreEventEmitter, type KVStoreProvider } from '@quereus/store';
import { createPkKeyingResolver, resolvePkKeying, makePkIdentityEncoder } from '../../src/metadata/pk-identity.js';
import { encodePkIdentity, encodeRawPkIdentity, RAW_PK_KEYING } from '../../src/metadata/keys.js';
import { createInMemoryProvider } from '../sync/_peer-harness.js';

describe('pk-identity keying', () => {
	let db: Database;
	let provider: KVStoreProvider;

	const schemaOf = (table: string): TableSchema => {
		const schema = db.schemaManager.getTable('main', table);
		expect(schema, `table ${table} registered`).to.not.be.undefined;
		return schema!;
	};

	beforeEach(() => {
		db = new Database();
		provider = createInMemoryProvider().provider;
		db.registerModule('store', new StoreModule(provider, new StoreEventEmitter()));
	});

	afterEach(async () => {
		await db.close();
		await provider.closeAll();
	});

	describe('resolvePkKeying', () => {
		it('folds a nocase text pk to one identity', async () => {
			await db.exec(`create table t (k text collate nocase primary key, v text) using store`);
			const keying = resolvePkKeying(schemaOf('t'), db.getKeyNormalizerResolver());

			expect(encodePkIdentity(['APPLE'], keying)).to.equal(encodePkIdentity(['apple'], keying));
			expect(encodePkIdentity(['APPLE'], keying)).to.not.equal(encodeRawPkIdentity(['APPLE']));
		});

		it('leaves a binary text pk case-sensitive', async () => {
			await db.exec(`create table t (k text collate binary primary key, v text) using store`);
			const keying = resolvePkKeying(schemaOf('t'), db.getKeyNormalizerResolver());

			expect(encodePkIdentity(['APPLE'], keying)).to.not.equal(encodePkIdentity(['apple'], keying));
			expect(encodePkIdentity(['APPLE'], keying)).to.equal(encodeRawPkIdentity(['APPLE']));
		});

		it('collapses equal-elapsed timespan pk spellings via the semantic transform', async () => {
			await db.exec(`create table t (d timespan primary key, v text) using store`);
			const keying = resolvePkKeying(schemaOf('t'), db.getKeyNormalizerResolver());

			expect(encodePkIdentity(['PT1H'], keying)).to.equal(encodePkIdentity(['PT60M'], keying));
		});

		it('applies each position of a composite pk independently', async () => {
			await db.exec(
				`create table t (a text collate nocase, b text collate binary, v text, primary key (a, b)) using store`,
			);
			const keying = resolvePkKeying(schemaOf('t'), db.getKeyNormalizerResolver());

			expect(encodePkIdentity(['X', 'y'], keying)).to.equal(encodePkIdentity(['x', 'y'], keying));
			expect(encodePkIdentity(['x', 'Y'], keying)).to.not.equal(encodePkIdentity(['x', 'y'], keying));
		});

		it('keys an integer pk by numeric class, so a bigint matches its number twin', async () => {
			await db.exec(`create table t (id integer primary key, v text) using store`);
			const keying = resolvePkKeying(schemaOf('t'), db.getKeyNormalizerResolver());

			expect(encodePkIdentity([5n], keying)).to.equal(encodePkIdentity([5], keying));
			expect(() => encodePkIdentity([9007199254740993n], keying)).to.not.throw();
		});
	});

	describe('createPkKeyingResolver', () => {
		it('keys raw for every table when no schema oracle is wired (relay-only deployment)', () => {
			const resolve = createPkKeyingResolver(undefined, undefined);
			expect(resolve('main', 'anything')).to.equal(RAW_PK_KEYING);
		});

		it('throws for an unknown table when an oracle IS wired', async () => {
			await db.exec(`create table t (k text primary key) using store`);
			const resolve = createPkKeyingResolver(
				(s, t) => db.schemaManager.getTable(s, t),
				db.getKeyNormalizerResolver(),
			);

			expect(() => resolve('main', 't')).to.not.throw();
			expect(() => resolve('main', 'missing')).to.throw(/No table schema for main\.missing/);
		});

		it('re-resolves after DDL replaces the table schema object', async () => {
			await db.exec(`create table t (k text collate binary primary key, v text) using store`);
			const resolve = createPkKeyingResolver(
				(s, t) => db.schemaManager.getTable(s, t),
				db.getKeyNormalizerResolver(),
			);
			const before = encodePkIdentity(['A'], resolve('main', 't'));
			expect(before).to.equal(encodeRawPkIdentity(['A']));

			await db.exec(`drop table t`);
			await db.exec(`create table t (k text collate nocase primary key, v text) using store`);

			// The cache is keyed by TableSchema OBJECT, so the fresh schema resolves fresh.
			expect(encodePkIdentity(['A'], resolve('main', 't'))).to.equal(
				encodePkIdentity(['a'], resolve('main', 't')),
			);
		});
	});

	describe('makePkIdentityEncoder', () => {
		it('agrees with the resolver form for the same schema', async () => {
			await db.exec(`create table t (k text collate nocase primary key, v text) using store`);
			const encode = makePkIdentityEncoder(schemaOf('t'), db.getKeyNormalizerResolver());

			expect(encode(['APPLE'])).to.equal(
				encodePkIdentity(['apple'], resolvePkKeying(schemaOf('t'), db.getKeyNormalizerResolver())),
			);
		});
	});
});
