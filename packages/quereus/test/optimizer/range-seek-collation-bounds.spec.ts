import { expect } from 'chai';
import { Database } from '../../src/core/database.js';
import type { SqlValue } from '../../src/common/types.js';

type ResultRow = Record<string, SqlValue>;

/**
 * Coverage for `memory-range-seek-collation-bounds`: the memory vtab range/prefix
 * seek used to filter range bounds (and prefix-equality keys) with a BINARY
 * comparator regardless of the index column's declared collation, so the planner
 * conservatively DECLINED every non-BINARY range seek. The runtime now threads the
 * index column collation into the bound filter and early-termination (scan-plan →
 * plan-filter / scan-layer), and the access path's `classifyConstraintCover` range
 * arm allows a seek when the predicate's effective collation equals the index
 * collation. These tests assert BOTH that the seek is actually chosen (plan) AND
 * that it returns exactly the rows a sequential scan would (a twin un-indexed table).
 */
describe('memory range/prefix seek honours index collation (memory-range-seek-collation-bounds)', () => {
	let db: Database;

	beforeEach(() => {
		db = new Database();
	});

	afterEach(async () => {
		await db.close();
	});

	async function planOps(q: string): Promise<string> {
		const planRows: ResultRow[] = [];
		for await (const r of db.eval("SELECT json_group_array(op) AS ops FROM query_plan(?)", [q])) {
			planRows.push(r);
		}
		expect(planRows).to.have.lengthOf(1);
		return planRows[0].ops as string;
	}

	async function rows(q: string): Promise<ResultRow[]> {
		const out: ResultRow[] = [];
		for await (const r of db.eval(q)) out.push(r);
		return out;
	}

	// --- single-column NOCASE range over a NOCASE index ----------------------
	describe('single-column NOCASE range over a NOCASE index', () => {
		// `name` is NOCASE at the column level, so both the predicate's effective
		// collation and the (inherited) index collation are NOCASE — a match.
		// Case variants ('Banana'/'BANANA') sort by NOCASE but their BINARY bytes
		// (0x42 < 0x62) differ from the lowercase bound, which is exactly what the
		// old BINARY bound filter got wrong (it under-fetched them).
		async function setup(): Promise<void> {
			await db.exec("CREATE TABLE cn_idx (id INTEGER PRIMARY KEY, name TEXT COLLATE NOCASE) USING memory");
			await db.exec("CREATE TABLE cn_scan (id INTEGER PRIMARY KEY, name TEXT COLLATE NOCASE) USING memory");
			const data = "(1, 'apple'), (2, 'Banana'), (3, 'CHERRY'), (4, 'date'), (5, 'BANANA')";
			await db.exec(`INSERT INTO cn_idx VALUES ${data}`);
			await db.exec(`INSERT INTO cn_scan VALUES ${data}`);
			await db.exec("CREATE INDEX idx_cn ON cn_idx (name)");
		}

		async function expectSeekMatchesScan(where: string, expectedIds: number[]): Promise<void> {
			const idxQ = `SELECT id FROM cn_idx WHERE ${where} ORDER BY id`;
			const scanQ = `SELECT id FROM cn_scan WHERE ${where} ORDER BY id`;

			// The indexed table uses a (name) index seek; the un-indexed twin must
			// not — it falls back to a full scan (here a primary IndexScan, since
			// `ORDER BY id` is satisfied by the PK) + residual Filter.
			expect(await planOps(idxQ)).to.match(/INDEXSEEK|INDEX SEEK|IndexSeek/i);
			expect(await planOps(scanQ)).to.not.match(/INDEXSEEK|INDEX SEEK|IndexSeek/i);

			const idxRows = (await rows(idxQ)).map(r => r.id);
			const scanRows = (await rows(scanQ)).map(r => r.id);
			expect(idxRows).to.deep.equal(scanRows);
			expect(idxRows).to.deep.equal(expectedIds);
		}

		it("> bound: seek matches scan, NOCASE-greater rows only", async () => {
			await setup();
			// NOCASE: apple<banana, Banana==BANANA==banana (excluded by >), CHERRY/date >
			await expectSeekMatchesScan("name > 'banana'", [3, 4]);
		});

		it(">= bound: includes both case variants of the bound", async () => {
			await setup();
			await expectSeekMatchesScan("name >= 'banana'", [2, 3, 4, 5]);
		});

		it("BETWEEN: both bounds honour NOCASE, includes CHERRY at the upper edge", async () => {
			await setup();
			await expectSeekMatchesScan("name between 'banana' and 'cherry'", [2, 3, 5]);
		});

		it("explicit COLLATE NOCASE on a BINARY-default column also seeks", async () => {
			// Column is BINARY here; the predicate's own COLLATE NOCASE matches the
			// NOCASE index, so the seek is still usable.
			await db.exec("CREATE TABLE cn2 (id INTEGER PRIMARY KEY, name TEXT) USING memory");
			await db.exec("INSERT INTO cn2 VALUES (1, 'apple'), (2, 'Banana'), (3, 'CHERRY'), (4, 'date'), (5, 'BANANA')");
			await db.exec("CREATE INDEX idx_cn2 ON cn2 (name COLLATE NOCASE)");
			const q = "SELECT id FROM cn2 WHERE name > 'banana' COLLATE NOCASE ORDER BY id";
			expect(await planOps(q)).to.match(/INDEXSEEK|INDEX SEEK|IndexSeek/i);
			expect((await rows(q)).map(r => r.id)).to.deep.equal([3, 4]);
		});
	});

	// --- DESC non-BINARY index range (direction × collation) -----------------
	describe('DESC NOCASE index range', () => {
		// Collation governs magnitude; DESC governs physical walk direction. The two
		// are orthogonal — the seek must position and early-terminate correctly under
		// both. Regression against a future change that conflates them.
		it("name > 'banana' over a DESC NOCASE index seeks and matches the scan", async () => {
			await db.exec("CREATE TABLE dn_idx (id INTEGER PRIMARY KEY, name TEXT COLLATE NOCASE) USING memory");
			await db.exec("CREATE TABLE dn_scan (id INTEGER PRIMARY KEY, name TEXT COLLATE NOCASE) USING memory");
			const data = "(1, 'apple'), (2, 'Banana'), (3, 'CHERRY'), (4, 'date'), (5, 'BANANA')";
			await db.exec(`INSERT INTO dn_idx VALUES ${data}`);
			await db.exec(`INSERT INTO dn_scan VALUES ${data}`);
			await db.exec("CREATE INDEX idx_dn ON dn_idx (name DESC)");

			const idxQ = "SELECT id FROM dn_idx WHERE name > 'banana' ORDER BY id";
			const scanQ = "SELECT id FROM dn_scan WHERE name > 'banana' ORDER BY id";
			expect(await planOps(idxQ)).to.match(/INDEXSEEK|INDEX SEEK|IndexSeek/i);
			const idxRows = (await rows(idxQ)).map(r => r.id);
			expect(idxRows).to.deep.equal((await rows(scanQ)).map(r => r.id));
			expect(idxRows).to.deep.equal([3, 4]);
		});
	});

	// --- single-column RTRIM range over an RTRIM index -----------------------
	describe('single-column RTRIM range over an RTRIM index', () => {
		async function setup(): Promise<void> {
			await db.exec("CREATE TABLE cr_idx (id INTEGER PRIMARY KEY, val TEXT COLLATE RTRIM) USING memory");
			await db.exec("CREATE TABLE cr_scan (id INTEGER PRIMARY KEY, val TEXT COLLATE RTRIM) USING memory");
			const data = "(1, 'cat'), (2, 'cat  '), (3, 'dog'), (4, 'doe '), (5, 'ant')";
			await db.exec(`INSERT INTO cr_idx VALUES ${data}`);
			await db.exec(`INSERT INTO cr_scan VALUES ${data}`);
			await db.exec("CREATE INDEX idx_cr ON cr_idx (val)");
		}

		async function expectSeekMatchesScan(where: string, expectedIds: number[]): Promise<void> {
			const idxQ = `SELECT id FROM cr_idx WHERE ${where} ORDER BY id`;
			const scanQ = `SELECT id FROM cr_scan WHERE ${where} ORDER BY id`;
			expect(await planOps(idxQ)).to.match(/INDEXSEEK|INDEX SEEK|IndexSeek/i);
			expect(await planOps(scanQ)).to.not.match(/INDEXSEEK|INDEX SEEK|IndexSeek/i);
			const idxRows = (await rows(idxQ)).map(r => r.id);
			const scanRows = (await rows(scanQ)).map(r => r.id);
			expect(idxRows).to.deep.equal(scanRows);
			expect(idxRows).to.deep.equal(expectedIds);
		}

		it("> bound: trailing spaces ignored ('cat  ' == 'cat' so excluded by >)", async () => {
			await setup();
			await expectSeekMatchesScan("val > 'cat'", [3, 4]);
		});

		it("BETWEEN: 'cat'/'cat  ' included at lower edge, 'doe ' inside the window", async () => {
			await setup();
			await expectSeekMatchesScan("val between 'cat' and 'dog'", [1, 2, 3, 4]);
		});
	});

	// --- prefix-range: NOCASE leading column + trailing integer range --------
	describe('prefix-range with a non-BINARY leading column', () => {
		// Composite index (name COLLATE NOCASE, year). The prefix-equality on `name`
		// must match every case variant under NOCASE before the trailing `year`
		// range is applied — the prefix compare is now collation-aware too.
		async function setup(): Promise<void> {
			await db.exec("CREATE TABLE pc_idx (id INTEGER PRIMARY KEY, name TEXT COLLATE NOCASE, year INTEGER) USING memory");
			await db.exec("CREATE TABLE pc_scan (id INTEGER PRIMARY KEY, name TEXT COLLATE NOCASE, year INTEGER) USING memory");
			const data = "(1, 'Bob', 2020), (2, 'BOB', 2024), (3, 'bob', 2025), (4, 'Alice', 2024), (5, 'CAROL', 2024), (6, 'bob', 2019)";
			await db.exec(`INSERT INTO pc_idx VALUES ${data}`);
			await db.exec(`INSERT INTO pc_scan VALUES ${data}`);
			await db.exec("CREATE INDEX idx_pc ON pc_idx (name, year)");
		}

		it("name = 'bob' AND year >= 2024: prefix-range seek matches the scan", async () => {
			await setup();
			const where = "name = 'bob' AND year >= 2024";
			const idxQ = `SELECT id FROM pc_idx WHERE ${where} ORDER BY id`;
			const scanQ = `SELECT id FROM pc_scan WHERE ${where} ORDER BY id`;

			expect(await planOps(idxQ)).to.match(/INDEXSEEK|INDEX SEEK|IndexSeek/i);
			expect(await planOps(scanQ)).to.not.match(/INDEXSEEK|INDEX SEEK|IndexSeek/i);

			const idxRows = (await rows(idxQ)).map(r => r.id);
			const scanRows = (await rows(scanQ)).map(r => r.id);
			expect(idxRows).to.deep.equal(scanRows);
			// NOCASE 'bob' ⊇ {Bob, BOB, bob, bob} (id 1,2,3,6); year>=2024 keeps 2,3.
			expect(idxRows).to.deep.equal([2, 3]);
		});

		it("name = 'bob' AND year BETWEEN 2019 AND 2024: includes the lower-year variants", async () => {
			await setup();
			const where = "name = 'bob' AND year between 2019 and 2024";
			const idxQ = `SELECT id FROM pc_idx WHERE ${where} ORDER BY id`;
			const scanQ = `SELECT id FROM pc_scan WHERE ${where} ORDER BY id`;
			expect(await planOps(idxQ)).to.match(/INDEXSEEK|INDEX SEEK|IndexSeek/i);
			const idxRows = (await rows(idxQ)).map(r => r.id);
			expect(idxRows).to.deep.equal((await rows(scanQ)).map(r => r.id));
			expect(idxRows).to.deep.equal([1, 2, 6]);
		});

		it("BINARY leading + NOCASE trailing range column: trailing bound honours NOCASE", async () => {
			// Index (year, name COLLATE NOCASE): the prefix-equality is on the BINARY
			// `year`, the trailing range is on the NOCASE `name` — so `boundCollation`
			// must resolve to the TRAILING column's collation, not the leading one.
			await db.exec("CREATE TABLE pt_idx (id INTEGER PRIMARY KEY, year INTEGER, name TEXT COLLATE NOCASE) USING memory");
			await db.exec("CREATE TABLE pt_scan (id INTEGER PRIMARY KEY, year INTEGER, name TEXT COLLATE NOCASE) USING memory");
			const data = "(1, 2024, 'apple'), (2, 2024, 'Banana'), (3, 2024, 'CHERRY'), (4, 2024, 'BANANA'), (5, 2023, 'date')";
			await db.exec(`INSERT INTO pt_idx VALUES ${data}`);
			await db.exec(`INSERT INTO pt_scan VALUES ${data}`);
			await db.exec("CREATE INDEX idx_pt ON pt_idx (year, name)");

			const where = "year = 2024 AND name > 'banana'";
			const idxQ = `SELECT id FROM pt_idx WHERE ${where} ORDER BY id`;
			const scanQ = `SELECT id FROM pt_scan WHERE ${where} ORDER BY id`;
			expect(await planOps(idxQ)).to.match(/INDEXSEEK|INDEX SEEK|IndexSeek/i);
			const idxRows = (await rows(idxQ)).map(r => r.id);
			expect(idxRows).to.deep.equal((await rows(scanQ)).map(r => r.id));
			// year=2024 keeps {apple,Banana,CHERRY,BANANA}; NOCASE name>'banana' keeps CHERRY (id 3).
			expect(idxRows).to.deep.equal([3]);
		});
	});

	// --- NULL rows must be excluded by a bound seek (no residual to catch them) --
	describe('NULL rows in a nullable column are excluded by the bound seek', () => {
		// When the seek covers the predicate the planner drops the residual `Filter`,
		// so the scan layer's bound filter is solely responsible for NULL semantics
		// (`NULL <op> v` is never true). A pure upper-bound (`<`/`<=`) ascending seek
		// walks the leading NULL block, so this is exactly where a missing NULL guard
		// leaks rows. Exercised for both a NOCASE and a BINARY index (the latter guards
		// the pre-existing path the collation work newly routes non-BINARY ranges onto).
		async function expectSeekMatchesScan(
			collation: string, where: string, expectedIds: number[],
		): Promise<void> {
			const colDef = `name TEXT ${collation} NULL`;
			await db.exec(`CREATE TABLE nn_idx (id INTEGER PRIMARY KEY, ${colDef}) USING memory`);
			await db.exec(`CREATE TABLE nn_scan (id INTEGER PRIMARY KEY, ${colDef}) USING memory`);
			await db.exec("INSERT INTO nn_idx VALUES (1, 'apple'), (2, 'Banana'), (4, 'date')");
			await db.exec("INSERT INTO nn_idx VALUES (3, NULL), (5, NULL)");
			await db.exec("INSERT INTO nn_scan SELECT * FROM nn_idx");
			await db.exec("CREATE INDEX idx_nn ON nn_idx (name)");

			const idxQ = `SELECT id FROM nn_idx WHERE ${where} ORDER BY id`;
			const scanQ = `SELECT id FROM nn_scan WHERE ${where} ORDER BY id`;
			expect(await planOps(idxQ)).to.match(/INDEXSEEK|INDEX SEEK|IndexSeek/i);
			const idxRows = (await rows(idxQ)).map(r => r.id);
			expect(idxRows).to.deep.equal((await rows(scanQ)).map(r => r.id));
			expect(idxRows).to.deep.equal(expectedIds);
		}

		it("NOCASE upper-bound (< 'cherry') seek excludes NULLs", async () => {
			await expectSeekMatchesScan('COLLATE NOCASE', "name < 'cherry'", [1, 2]);
		});

		it("BINARY upper-bound (< 'cherry') seek excludes NULLs", async () => {
			await expectSeekMatchesScan('COLLATE BINARY', "name < 'cherry'", [1, 2]);
		});

		it("NOCASE BETWEEN with NULLs present excludes them", async () => {
			await expectSeekMatchesScan('COLLATE NOCASE', "name between 'apple' and 'cherry'", [1, 2]);
		});

		it("prefix-range with a NULL trailing range value excludes that row", async () => {
			// Composite (name, year NULL): rows sharing the prefix but with a NULL trailing
			// `year` must not pass the `year >= 2024` bound (NULL is never > a value).
			await db.exec("CREATE TABLE pn_idx (id INTEGER PRIMARY KEY, name TEXT COLLATE NOCASE, year INTEGER NULL) USING memory");
			await db.exec("CREATE TABLE pn_scan (id INTEGER PRIMARY KEY, name TEXT COLLATE NOCASE, year INTEGER NULL) USING memory");
			await db.exec("INSERT INTO pn_idx VALUES (1, 'bob', 2025), (2, 'BOB', 2020)");
			await db.exec("INSERT INTO pn_idx VALUES (3, 'Bob', NULL)");
			await db.exec("INSERT INTO pn_scan SELECT * FROM pn_idx");
			await db.exec("CREATE INDEX idx_pn ON pn_idx (name, year)");

			const where = "name = 'bob' AND year >= 2024";
			const idxQ = `SELECT id FROM pn_idx WHERE ${where} ORDER BY id`;
			const scanQ = `SELECT id FROM pn_scan WHERE ${where} ORDER BY id`;
			expect(await planOps(idxQ)).to.match(/INDEXSEEK|INDEX SEEK|IndexSeek/i);
			const idxRows = (await rows(idxQ)).map(r => r.id);
			expect(idxRows).to.deep.equal((await rows(scanQ)).map(r => r.id));
			expect(idxRows).to.deep.equal([1]);
		});
	});

	// --- the relaxed guard must NOT enable a genuine mismatch ----------------
	describe('collation-mismatched range still declines the seek', () => {
		it('NOCASE predicate over a BINARY index falls back to scan + residual', async () => {
			await db.exec("CREATE TABLE mm (id INTEGER PRIMARY KEY, name TEXT) USING memory");
			await db.exec("INSERT INTO mm VALUES (1, 'apple'), (2, 'Banana'), (3, 'CHERRY'), (4, 'date'), (5, 'BANANA')");
			await db.exec("CREATE INDEX idx_mm ON mm (name)"); // BINARY index
			const q = "SELECT id FROM mm WHERE name > 'banana' COLLATE NOCASE ORDER BY id";
			const ops = await planOps(q);
			// predColl=NOCASE, indexColl=BINARY → mismatch → decline to scan + residual.
			expect(ops).to.match(/SEQSCAN|SEQ SCAN|SeqScan/i);
			expect(ops).to.match(/FILTER/i);
			// NOCASE: CHERRY, date are > 'banana'.
			expect((await rows(q)).map(r => r.id)).to.deep.equal([3, 4]);
		});
	});
});
