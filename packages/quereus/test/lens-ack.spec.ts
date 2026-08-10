/**
 * Lens advisory acknowledgment & escalation governance (ticket
 * `lens-advisory-acknowledgment`, docs/lens.md § Acknowledging advisories).
 *
 * Sits atop the prover's advisory list: a developer acknowledges a coded+sited
 * advisory in source via the reserved `quereus.lens.ack.<code>[:<target>]` tag
 * (with a required rationale and an optional recorded `#fp=` fingerprint); the
 * deploy summary tallies `acknowledged: N`; the advisory re-surfaces flagged when
 * its fingerprint changes; and a per-table escalation policy (`error-on` /
 * `require-ack`) promotes specific codes to hard errors.
 *
 * Each scenario gets a fresh Database and goes through the full `apply schema`
 * pipeline so governance runs exactly as in production. The default basis is
 * inferred (one physical schema `y`), so no explicit `declare lens` is needed.
 */

import { expect } from 'chai';
import { Database } from '../src/core/database.js';
import { computeAdvisoryFingerprint } from '../src/schema/lens-ack.js';
import type { LensDeployReport } from '../src/schema/lens-prover.js';
import { ACKNOWLEDGEABLE_ADVISORY_CODES } from '../src/schema/lens-prover.js';
import { astToString } from '../src/emit/ast-stringify.js';

async function rows(db: Database, sql: string): Promise<Array<Record<string, unknown>>> {
	const out: Array<Record<string, unknown>> = [];
	for await (const r of db.eval(sql)) out.push(r as Record<string, unknown>);
	return out;
}

async function expectThrows(fn: () => Promise<unknown>, matcher?: RegExp): Promise<void> {
	let threw = false;
	try {
		await fn();
	} catch (e) {
		threw = true;
		if (matcher) {
			const msg = e instanceof Error ? e.message : String(e);
			expect(msg, `error message should match ${matcher}`).to.match(matcher);
		}
	}
	expect(threw, 'expected the operation to throw').to.be.true;
}

function report(db: Database): LensDeployReport {
	const r = db.declaredSchemaManager.getDeployedLensReport('x');
	expect(r, 'deploy report for x').to.not.be.undefined;
	return r!;
}

function warningCodes(db: Database): string[] {
	return report(db).warnings.map(w => w.code);
}

describe('lens ack: suppression + tally + expand', () => {
	it('an ack suppresses the advisory, tallies acknowledged: 1, and is omitted from the default rows', async () => {
		const db = new Database();
		try {
			await db.exec('declare schema y { table u (id integer primary key, email text null) }');
			await db.exec('apply schema y');
			await db.exec(`declare logical schema x { table u (id integer primary key, email text null, unique (email)) with tags ("quereus.lens.ack.no-backing-index" = 'low-write table; commit-time scan accepted') }`);
			await db.exec('apply schema x');

			const r = report(db);
			expect(r.acknowledged.length, 'acknowledged: 1').to.equal(1);
			expect(r.acknowledged[0].code).to.equal('lens.no-backing-index');
			expect(r.acknowledged[0].unconditional, 'no recorded fingerprint ⇒ unconditional').to.equal(true);
			// Default rows omit the acknowledged advisory.
			expect(warningCodes(db)).to.not.include('lens.no-backing-index');

			// Expand on demand: the introspection TVF lists it.
			const adv = await rows(db, "select * from quereus_lens_advisories('x')");
			const acked = adv.filter(a => a.status === 'acknowledged-unconditional');
			expect(acked.length, 'TVF expands the acknowledged advisory').to.equal(1);
			expect(acked[0].code).to.equal('lens.no-backing-index');
			expect(String(acked[0].rationale)).to.match(/commit-time scan accepted/);
		} finally {
			await db.close();
		}
	});

	it('an empty ack rationale surfaces a meta-warning through the deploy report (not just logs)', async () => {
		const db = new Database();
		try {
			await db.exec('declare schema y { table u (id integer primary key, email text null) }');
			await db.exec('apply schema y');
			await db.exec(`declare logical schema x { table u (id integer primary key, email text null, unique (email)) with tags ("quereus.lens.ack.no-backing-index" = '') }`);
			await db.exec('apply schema x');

			const r = report(db);
			// The advisory is still acknowledged (suppression happens)...
			expect(r.acknowledged.length).to.equal(1);
			// ...but the empty rationale itself surfaces as a report warning.
			const meta = r.warnings.filter(w => /empty rationale/i.test(w.message));
			expect(meta.length, 'empty-rationale meta warning surfaces in the report').to.equal(1);
		} finally {
			await db.close();
		}
	});

	it('a targeted ack acks only its column; the other instance still surfaces', async () => {
		const db = new Database();
		try {
			await db.exec('declare schema y { table u (id integer primary key, email text null, vin text null) }');
			await db.exec('apply schema y');
			await db.exec(`declare logical schema x { table u (id integer primary key, email text null, vin text null, unique (email), unique (vin)) with tags ("quereus.lens.ack.no-backing-index:email" = 'email scan accepted') }`);
			await db.exec('apply schema x');

			const r = report(db);
			expect(r.acknowledged.length, 'only the email advisory acked').to.equal(1);
			expect(r.acknowledged[0].target).to.equal('email');

			const surfaced = r.warnings.filter(w => w.code === 'lens.no-backing-index');
			expect(surfaced.length, 'the vin advisory still surfaces').to.equal(1);
			expect(surfaced[0].fingerprintInputs?.constraintColumns).to.deep.equal(['vin']);
		} finally {
			await db.close();
		}
	});
});

describe('lens ack: fingerprint re-surface + stability', () => {
	it('records on first sight, stays acknowledged when the fingerprint matches, and re-surfaces when constraint columns change', async () => {
		const db = new Database();
		try {
			await db.exec('declare schema y { table u (id integer primary key, email text null, region text null) }');
			await db.exec('apply schema y');

			// Deploy A — ack with no recorded fingerprint (record-on-first-sight).
			await db.exec(`declare logical schema x { table u (id integer primary key, email text null, region text null, unique (email)) with tags ("quereus.lens.ack.no-backing-index:email" = 'accepted') }`);
			await db.exec('apply schema x');
			const fpA = report(db).acknowledged[0].currentFingerprint;
			expect(fpA, 'a fingerprint was computed').to.be.a('string').and.not.equal('');

			// Deploy B — same facts, ack now records fpA. Still acknowledged (stable),
			// NOT re-surfaced: ordinary re-apply with matching facts does not churn.
			await db.exec(`declare logical schema x { table u (id integer primary key, email text null, region text null, unique (email)) with tags ("quereus.lens.ack.no-backing-index:email" = 'accepted #fp=${fpA}') }`);
			await db.exec('apply schema x');
			const rB = report(db);
			expect(rB.acknowledged.length, 'still acknowledged with a matching fingerprint').to.equal(1);
			expect(rB.acknowledged[0].unconditional, 'fingerprint recorded ⇒ conditional').to.equal(false);
			expect(rB.warnings.some(w => w.resurfaced), 'nothing re-surfaced').to.equal(false);

			// Deploy C — constraint columns evolve (email → email, region), so the
			// fingerprint changes; the stale-fp ack re-surfaces, flagged.
			await db.exec(`declare logical schema x { table u (id integer primary key, email text null, region text null, unique (email, region)) with tags ("quereus.lens.ack.no-backing-index:email" = 'accepted #fp=${fpA}') }`);
			await db.exec('apply schema x');
			const rC = report(db);
			expect(rC.acknowledged.length, 'no longer acknowledged after the fact change').to.equal(0);
			const resurfaced = rC.warnings.filter(w => w.code === 'lens.no-backing-index' && w.resurfaced);
			expect(resurfaced.length, 'the advisory re-surfaced').to.equal(1);
			expect(resurfaced[0].message).to.match(/previously acknowledged; situation changed/);
		} finally {
			await db.close();
		}
	});

	it('the fingerprint is band-stable: equal within a cardinality band, distinct across bands and across constraint columns', () => {
		const site = { table: 'u', constraint: 'unique' } as const;
		// Same band + same columns (any order/case) ⇒ identical fingerprint.
		const a = computeAdvisoryFingerprint('lens.no-backing-index', site, {
			constraintColumns: ['email'], hasCoveringStructure: false, cardinalityBand: 'small', basisRelation: 'y.u',
		});
		const aSameBand = computeAdvisoryFingerprint('lens.no-backing-index', site, {
			constraintColumns: ['EMAIL'], hasCoveringStructure: false, cardinalityBand: 'small', basisRelation: 'y.u',
		});
		expect(aSameBand, 'row-count drift within a band does not move the fingerprint').to.equal(a);

		// Crossing a band ⇒ different fingerprint.
		const aBigBand = computeAdvisoryFingerprint('lens.no-backing-index', site, {
			constraintColumns: ['email'], hasCoveringStructure: false, cardinalityBand: 'large', basisRelation: 'y.u',
		});
		expect(aBigBand, 'a band crossing moves the fingerprint').to.not.equal(a);

		// Different constraint columns ⇒ different fingerprint.
		const aOtherCols = computeAdvisoryFingerprint('lens.no-backing-index', site, {
			constraintColumns: ['email', 'region'], hasCoveringStructure: false, cardinalityBand: 'small', basisRelation: 'y.u',
		});
		expect(aOtherCols, 'a constraint-column change moves the fingerprint').to.not.equal(a);
	});
});

describe('lens ack: constraint-scoped acks', () => {
	it('an ack placed on the constraint (not the table) suppresses that constraint\'s advisory', async () => {
		const db = new Database();
		try {
			await db.exec('declare schema y { table u (id integer primary key, email text null) }');
			await db.exec('apply schema y');
			// The ack tag rides the constraint's own `with tags`, not the table's.
			await db.exec(`declare logical schema x { table u (id integer primary key, email text null, constraint uq unique (email) with tags ("quereus.lens.ack.no-backing-index" = 'constraint-scoped ack')) }`);
			await db.exec('apply schema x');

			const r = report(db);
			expect(r.acknowledged.length, 'the constraint-scoped ack suppressed its advisory').to.equal(1);
			expect(r.acknowledged[0].code).to.equal('lens.no-backing-index');
			expect(r.acknowledged[0].rationale).to.match(/constraint-scoped ack/);
			expect(warningCodes(db)).to.not.include('lens.no-backing-index');
		} finally {
			await db.close();
		}
	});

	it('a constraint-scoped ack suppresses only its own constraint; a sibling constraint still surfaces', async () => {
		const db = new Database();
		try {
			await db.exec('declare schema y { table u (id integer primary key, email text null, vin text null) }');
			await db.exec('apply schema y');
			// Ack on the `email` unique only; the `vin` unique is left un-acked.
			await db.exec(`declare logical schema x { table u (id integer primary key, email text null, vin text null, constraint uqe unique (email) with tags ("quereus.lens.ack.no-backing-index" = 'email accepted'), unique (vin)) }`);
			await db.exec('apply schema x');

			const r = report(db);
			expect(r.acknowledged.length, 'only the email constraint acked').to.equal(1);
			const surfaced = r.warnings.filter(w => w.code === 'lens.no-backing-index');
			expect(surfaced.length, 'the vin advisory still surfaces').to.equal(1);
			expect(surfaced[0].fingerprintInputs?.constraintColumns).to.deep.equal(['vin']);
		} finally {
			await db.close();
		}
	});
});

describe('lens ack: escalation policy', () => {
	it('require-ack — an un-acked instance blocks the deploy; a valid ack clears it', async () => {
		const db = new Database();
		try {
			await db.exec('declare schema y { table u (id integer primary key, email text null) }');
			await db.exec('apply schema y');

			// Un-acknowledged + require-ack ⇒ deploy errors atomically.
			await db.exec(`declare logical schema x { table u (id integer primary key, email text null, unique (email)) with tags ("quereus.lens.policy.require-ack" = 'lens.no-backing-index') }`);
			await expectThrows(() => db.exec('apply schema x'), /require-ack|lens\.no-backing-index/);
			expect(db.declaredSchemaManager.getDeployedLensReport('x'), 'no report after a blocked deploy').to.be.undefined;

			// Add a valid ack ⇒ the require-ack obligation clears, deploy succeeds.
			await db.exec(`declare logical schema x { table u (id integer primary key, email text null, unique (email)) with tags ("quereus.lens.policy.require-ack" = 'lens.no-backing-index', "quereus.lens.ack.no-backing-index" = 'commit-time scan accepted') }`);
			await db.exec('apply schema x');
			expect(report(db).acknowledged.length, 'the ack clears require-ack').to.equal(1);
		} finally {
			await db.close();
		}
	});

	it('a policy code may be written bare (no `lens.` prefix), mirroring the ack tag remainder', async () => {
		const db = new Database();
		try {
			await db.exec('declare schema y { table u (id integer primary key, email text null) }');
			await db.exec('apply schema y');
			// The bare `no-backing-index` form (matching the ack tag remainder) must
			// escalate identically to the fully-qualified `lens.no-backing-index`.
			await db.exec(`declare logical schema x { table u (id integer primary key, email text null, unique (email)) with tags ("quereus.lens.policy.require-ack" = 'no-backing-index') }`);
			await expectThrows(() => db.exec('apply schema x'), /require-ack|no-backing-index/);
		} finally {
			await db.close();
		}
	});

	it('error-on — even a valid ack does not suppress; the deploy errors', async () => {
		const db = new Database();
		try {
			await db.exec('declare schema y { table u (id integer primary key, email text null) }');
			await db.exec('apply schema y');
			await db.exec(`declare logical schema x { table u (id integer primary key, email text null, unique (email)) with tags ("quereus.lens.policy.error-on" = 'lens.no-backing-index', "quereus.lens.ack.no-backing-index" = 'I tried to accept it') }`);
			await expectThrows(() => db.exec('apply schema x'), /error-on|lens\.no-backing-index/);
		} finally {
			await db.close();
		}
	});

	it('error-on naming an unknown advisory code is a hard deploy error (anti fail-open), not a silent no-op', async () => {
		const db = new Database();
		try {
			await db.exec('declare schema y { table u (id integer primary key, email text null) }');
			await db.exec('apply schema y');
			// Typo'd code: the author intends to escalate `lens.no-backing-index` but
			// misspells it. The escalation would silently fail open — so it must throw.
			await db.exec(`declare logical schema x { table u (id integer primary key, email text null, unique (email)) with tags ("quereus.lens.policy.error-on" = 'lens.no-backing-indx') }`);
			await expectThrows(
				() => db.exec('apply schema x'),
				/unknown advisory code 'lens\.no-backing-indx'.*never match/s,
			);
			// A blocked deploy records no report (mirrors the require-ack case).
			expect(db.declaredSchemaManager.getDeployedLensReport('x'), 'no report after a blocked deploy').to.be.undefined;
		} finally {
			await db.close();
		}
	});

	it('require-ack naming an unknown advisory code is a hard deploy error too', async () => {
		const db = new Database();
		try {
			await db.exec('declare schema y { table u (id integer primary key, email text null) }');
			await db.exec('apply schema y');
			await db.exec(`declare logical schema x { table u (id integer primary key, email text null, unique (email)) with tags ("quereus.lens.policy.require-ack" = 'lens.bogus-code') }`);
			await expectThrows(
				() => db.exec('apply schema x'),
				/quereus\.lens\.policy\.require-ack.*unknown advisory code 'lens\.bogus-code'/s,
			);
			expect(db.declaredSchemaManager.getDeployedLensReport('x'), 'no report after a blocked deploy').to.be.undefined;
		} finally {
			await db.close();
		}
	});

	it('a recognized code (bare or `lens.`-prefixed) is NOT treated as unknown — the throw is the escalation error', async () => {
		const db = new Database();
		try {
			await db.exec('declare schema y { table u (id integer primary key, email text null) }');
			await db.exec('apply schema y');
			// Both forms must pass the unknown-code check and throw the *escalation*
			// error (require-ack), never an unknown-code error.
			for (const code of ['no-backing-index', 'lens.no-backing-index']) {
				await db.exec(`declare logical schema x { table u (id integer primary key, email text null, unique (email)) with tags ("quereus.lens.policy.require-ack" = '${code}') }`);
				let msg = '';
				try {
					await db.exec('apply schema x');
				} catch (e) {
					msg = e instanceof Error ? e.message : String(e);
				}
				expect(msg, `recognized code '${code}' throws`).to.not.equal('');
				expect(msg, `recognized code '${code}' is not an unknown-code error`).to.not.match(/unknown advisory code/);
				expect(msg, `recognized code '${code}' is the escalation error`).to.match(/require-ack|no-backing-index/);
			}
		} finally {
			await db.close();
		}
	});

	it('validates per-code: a valid sibling in the CSV cannot mask a typo (both error-on entries checked)', async () => {
		const db = new Database();
		try {
			await db.exec('declare schema y { table u (id integer primary key, email text null) }');
			await db.exec('apply schema y');
			// One recognized code + one typo in a single CSV. The recognized code must
			// not short-circuit validation — the typo still blocks the deploy, named.
			await db.exec(`declare logical schema x { table u (id integer primary key, email text null, unique (email)) with tags ("quereus.lens.policy.error-on" = 'lens.no-backing-index,lens.no-backing-indx') }`);
			await expectThrows(
				() => db.exec('apply schema x'),
				/unknown advisory code 'lens\.no-backing-indx'.*never match/s,
			);
			expect(db.declaredSchemaManager.getDeployedLensReport('x'), 'no report after a blocked deploy').to.be.undefined;
		} finally {
			await db.close();
		}
	});

	it('lens.pk-not-reconstructible is a recognized policy code even where it is not currently emitted', async () => {
		const db = new Database();
		try {
			await db.exec('declare schema y { table u (id integer primary key, email text null) }');
			await db.exec('apply schema y');
			// A plain pass-through table emits no pk-not-reconstructible advisory, but
			// pre-empting the (recognized) code with error-on must NOT raise unknown-code.
			await db.exec(`declare logical schema x { table u (id integer primary key, email text null) with tags ("quereus.lens.policy.error-on" = 'lens.pk-not-reconstructible') }`);
			await db.exec('apply schema x'); // succeeds: recognized, not currently triggered
			expect(report(db).warnings.some(w => /unknown advisory code/.test(w.message)), 'no unknown-code diagnostic').to.equal(false);
		} finally {
			await db.close();
		}
	});
});

describe('lens ack: advisory vocabulary (drift guard)', () => {
	it('ACKNOWLEDGEABLE_ADVISORY_CODES is exactly the six governable warning codes', () => {
		expect([...ACKNOWLEDGEABLE_ADVISORY_CODES].sort()).to.deep.equal([
			'lens.getput-lossy',
			'lens.no-answering-structure',
			'lens.no-backing-index',
			'lens.over-restrictive-basis-key',
			'lens.partial-override',
			'lens.pk-not-reconstructible',
		]);
	});
});

describe('lens ack: fingerprint domain sensitivity (lens.getput-lossy)', () => {
	const site = { table: 't', column: 'grp' };

	it('a CHECK in-list change moves the fingerprint (the ack re-surfaces)', () => {
		const a = computeAdvisoryFingerprint('lens.getput-lossy', site, {
			constraintColumns: ['grp'], domainValues: [`'A'`, `'B'`],
		});
		const b = computeAdvisoryFingerprint('lens.getput-lossy', site, {
			constraintColumns: ['grp'], domainValues: [`'A'`, `'B'`, `'C'`],
		});
		expect(a).to.not.equal(b);
	});

	it('the domain is order-insensitive (canonicalized) and only serialized when present', () => {
		const a = computeAdvisoryFingerprint('lens.getput-lossy', site, {
			constraintColumns: ['grp'], domainValues: [`'B'`, `'A'`],
		});
		const b = computeAdvisoryFingerprint('lens.getput-lossy', site, {
			constraintColumns: ['grp'], domainValues: [`'A'`, `'B'`],
		});
		expect(a).to.equal(b);

		// Absent domain ⇒ the key is omitted entirely, so pre-existing advisory
		// fingerprints (every code without a domain) are unchanged by the new field.
		const without = computeAdvisoryFingerprint('lens.getput-lossy', site, { constraintColumns: ['grp'] });
		expect(without).to.not.equal(a);
	});
});

describe('lens ack: fingerprint basis-key sensitivity (lens.over-restrictive-basis-key)', () => {
	const site = { table: 't', constraint: 'unique' };

	it('a governing basis-key change moves the fingerprint (the ack re-surfaces)', () => {
		// Widening the basis key (a) → (a, b) changes the advisory's truth, so its
		// fingerprint must move and re-surface a prior acknowledgment.
		const a = computeAdvisoryFingerprint('lens.over-restrictive-basis-key', site, {
			constraintColumns: ['a', 'b'], basisRelation: 'y.t', basisKeyColumns: ['a'],
		});
		const b = computeAdvisoryFingerprint('lens.over-restrictive-basis-key', site, {
			constraintColumns: ['a', 'b'], basisRelation: 'y.t', basisKeyColumns: ['a', 'b'],
		});
		expect(a).to.not.equal(b);
	});

	it('the basis key is order/case-insensitive (canonicalized) and only serialized when present', () => {
		const a = computeAdvisoryFingerprint('lens.over-restrictive-basis-key', site, {
			constraintColumns: ['a', 'b'], basisRelation: 'y.t', basisKeyColumns: ['B', 'A'],
		});
		const b = computeAdvisoryFingerprint('lens.over-restrictive-basis-key', site, {
			constraintColumns: ['a', 'b'], basisRelation: 'y.t', basisKeyColumns: ['a', 'b'],
		});
		expect(a, 'order + case canonicalized').to.equal(b);

		// Absent basisKeyColumns ⇒ the key is omitted entirely, so pre-existing advisory
		// fingerprints (every code without a basis key) are unchanged by the new field.
		const without = computeAdvisoryFingerprint('lens.over-restrictive-basis-key', site, {
			constraintColumns: ['a', 'b'], basisRelation: 'y.t',
		});
		expect(without).to.not.equal(a);
	});
});

describe('lens ack: in-DDL fingerprint round-trips', () => {
	it('the ack tag + recorded fingerprint survive schema export and re-import without re-surfacing', async () => {
		const basis = 'declare schema y { table u (id integer primary key, email text null) }';

		const db = new Database();
		let fp: string;
		try {
			await db.exec(basis);
			await db.exec('apply schema y');
			await db.exec(`declare logical schema x { table u (id integer primary key, email text null, unique (email)) with tags ("quereus.lens.ack.no-backing-index" = 'accepted') }`);
			await db.exec('apply schema x');
			fp = report(db).acknowledged[0].currentFingerprint;
		} finally {
			await db.close();
		}

		// Author the recorded fingerprint into the logical DDL and export it through
		// the engine's own serializer (astToString) — proving in-DDL storage.
		const db2 = new Database();
		try {
			await db2.exec(basis);
			await db2.exec('apply schema y');
			const logicalDdl = `declare logical schema x { table u (id integer primary key, email text null, unique (email)) with tags ("quereus.lens.ack.no-backing-index" = 'accepted #fp=${fp}') }`;
			await db2.exec(logicalDdl);
			await db2.exec('apply schema x');
			expect(report(db2).acknowledged.length, 'acknowledged with the recorded fingerprint').to.equal(1);

			// Export round-trips the fingerprint through DDL serialization.
			const exported = astToString(db2.declaredSchemaManager.getDeclaredSchema('x')!);
			expect(exported, 'exported DDL carries the recorded fingerprint').to.include(`#fp=${fp}`);
		} finally {
			await db2.close();
		}

		// Re-import the exported-shape DDL in a fresh database: still acknowledged,
		// not re-surfaced (the recorded fingerprint matches the recomputed one).
		const db3 = new Database();
		try {
			await db3.exec(basis);
			await db3.exec('apply schema y');
			await db3.exec(`declare logical schema x { table u (id integer primary key, email text null, unique (email)) with tags ("quereus.lens.ack.no-backing-index" = 'accepted #fp=${fp}') }`);
			await db3.exec('apply schema x');
			const r3 = report(db3);
			expect(r3.acknowledged.length, 're-import stays acknowledged').to.equal(1);
			expect(r3.warnings.some(w => w.resurfaced), 'nothing re-surfaced on re-import').to.equal(false);
		} finally {
			await db3.close();
		}
	});
});
