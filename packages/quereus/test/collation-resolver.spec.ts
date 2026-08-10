import { expect } from 'chai';
import { Database } from '../src/index.js';
import { MisuseError, QuereusError } from '../src/common/errors.js';
import {
	BINARY_COLLATION,
	NOCASE_COLLATION,
	RTRIM_COLLATION,
	builtinCollationResolver,
} from '../src/util/comparison.js';
import type { DatabaseInternal } from '../src/core/database-internal.js';

/** Reverse-string comparator, used as a stand-in for an embedder's custom collation. */
const reverse = (a: string, b: string): number => {
	const ra = a.split('').reverse().join('');
	const rb = b.split('').reverse().join('');
	return ra < rb ? -1 : ra > rb ? 1 : 0;
};

describe('Database.getCollationResolver', () => {
	let db: Database;

	beforeEach(() => {
		db = new Database();
	});

	afterEach(async () => {
		await db.close();
	});

	it('resolves the built-in collations', () => {
		const resolve = db.getCollationResolver();
		expect(resolve('BINARY')).to.equal(BINARY_COLLATION);
		expect(resolve('NOCASE')).to.equal(NOCASE_COLLATION);
		expect(resolve('RTRIM')).to.equal(RTRIM_COLLATION);
	});

	it('resolves names case-insensitively', () => {
		const resolve = db.getCollationResolver();
		expect(resolve('nocase')).to.equal(NOCASE_COLLATION);
		expect(resolve('rTrIm')).to.equal(RTRIM_COLLATION);
		expect(resolve('binary')).to.equal(BINARY_COLLATION);
	});

	it('throws on an unregistered collation rather than falling back to BINARY', () => {
		const resolve = db.getCollationResolver();
		expect(() => resolve('NOPE')).to.throw(QuereusError, /no such collation sequence: NOPE/);
	});

	it('throws on an empty or whitespace-only name', () => {
		const resolve = db.getCollationResolver();
		expect(() => resolve('')).to.throw(QuereusError, /no such collation sequence:/);
		expect(() => resolve('   ')).to.throw(QuereusError, /no such collation sequence:/);
	});

	it('tolerates surrounding whitespace on a resolvable name', () => {
		const resolve = db.getCollationResolver();
		expect(resolve('  nocase  ')).to.equal(NOCASE_COLLATION);
		expect(resolve(' BINARY ')).to.equal(BINARY_COLLATION);
	});

	it('has stable identity across calls', () => {
		expect(db.getCollationResolver()).to.equal(db.getCollationResolver());
	});

	it('sees a collation registered after the resolver was obtained', () => {
		const resolve = db.getCollationResolver();
		expect(() => resolve('REVERSE')).to.throw(QuereusError);
		db.registerCollation('REVERSE', reverse);
		expect(resolve('REVERSE')).to.equal(reverse);
	});

	it('honors a per-database override of a non-BINARY built-in', () => {
		const resolve = db.getCollationResolver();
		db.registerCollation('NOCASE', reverse);
		expect(resolve('NOCASE')).to.equal(reverse);
	});

	it('rejects an attempt to override BINARY, whatever its spelling', () => {
		// The exact-'BINARY' fast path would bypass such an override for the canonical
		// spelling while honoring it for any other, so the registration is refused
		// outright rather than half-applied.
		expect(() => db.registerCollation('BINARY', reverse)).to.throw(MisuseError, /BINARY cannot be overridden/);
		expect(() => db.registerCollation('binary', reverse)).to.throw(MisuseError, /BINARY cannot be overridden/);
		const resolve = db.getCollationResolver();
		expect(resolve('BINARY')).to.equal(BINARY_COLLATION);
		expect(resolve('binary')).to.equal(BINARY_COLLATION);
	});

	it('is reachable through the DatabaseInternal seam', () => {
		const internal = db as unknown as DatabaseInternal;
		expect(internal.getCollationResolver()('BINARY')).to.equal(BINARY_COLLATION);
	});
});

describe('collation resolver isolation between databases', () => {
	it('gives each database only its own registration for a shared name', async () => {
		const db1 = new Database();
		const db2 = new Database();
		const forward = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

		db1.registerCollation('REVERSE', reverse);
		db2.registerCollation('REVERSE', forward);

		const resolve1 = db1.getCollationResolver();
		const resolve2 = db2.getCollationResolver();

		expect(resolve1('REVERSE')).to.equal(reverse);
		expect(resolve2('REVERSE')).to.equal(forward);
		expect(resolve1('REVERSE')).to.not.equal(resolve2('REVERSE'));

		await db1.close();
		await db2.close();
	});

	it('does not leak a registration to a database that never made it', async () => {
		const db1 = new Database();
		const db2 = new Database();
		db1.registerCollation('REVERSE', reverse);

		expect(db1.getCollationResolver()('REVERSE')).to.equal(reverse);
		expect(() => db2.getCollationResolver()('REVERSE'))
			.to.throw(QuereusError, /no such collation sequence: REVERSE/);

		await db1.close();
		await db2.close();
	});
});

describe('builtinCollationResolver', () => {
	it('resolves the three built-ins, case-insensitively', () => {
		expect(builtinCollationResolver('BINARY')).to.equal(BINARY_COLLATION);
		expect(builtinCollationResolver('nocase')).to.equal(NOCASE_COLLATION);
		expect(builtinCollationResolver('RTrim')).to.equal(RTRIM_COLLATION);
		expect(builtinCollationResolver('  rtrim ')).to.equal(RTRIM_COLLATION);
	});

	it('returns undefined for anything else', () => {
		expect(builtinCollationResolver('REVERSE')).to.be.undefined;
		expect(builtinCollationResolver('')).to.be.undefined;
	});

	it('ignores a database-level override of a built-in', async () => {
		const db = new Database();
		db.registerCollation('NOCASE', reverse);
		expect(builtinCollationResolver('NOCASE')).to.equal(NOCASE_COLLATION);
		await db.close();
	});
});
