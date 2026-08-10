import { expect } from 'chai';
import { Database } from '../src/index.js';
import { createTableValuedFunction } from '../src/func/registration.js';
import { INTEGER_TYPE, TEXT_TYPE } from '../src/types/builtin-types.js';
import type { Row } from '../src/common/types.js';

// Declares 5 columns but only yields rows with 2 values.
// This exercises the TVF row-padding fix: the engine must pad short rows
// to the declared width so downstream ArrayIndex (e.g. row_number() slot)
// lands at the correct offset.
function makeShortRowTvf(data: Array<[number, string]>) {
	return createTableValuedFunction(
		{
			name: 'short_row_tvf',
			numArgs: 0,
			deterministic: false,
			returnType: {
				typeClass: 'relation',
				isReadOnly: true,
				isSet: false,
				columns: [
					{ name: 'row_index', type: { typeClass: 'scalar', logicalType: INTEGER_TYPE, nullable: false, isReadOnly: true }, generated: true },
					{ name: 'col_0',     type: { typeClass: 'scalar', logicalType: TEXT_TYPE,    nullable: true,  isReadOnly: true }, generated: true },
					{ name: 'col_1',     type: { typeClass: 'scalar', logicalType: TEXT_TYPE,    nullable: true,  isReadOnly: true }, generated: true },
					{ name: 'col_2',     type: { typeClass: 'scalar', logicalType: TEXT_TYPE,    nullable: true,  isReadOnly: true }, generated: true },
					{ name: 'col_3',     type: { typeClass: 'scalar', logicalType: TEXT_TYPE,    nullable: true,  isReadOnly: true }, generated: true },
				],
				keys: [],
				rowConstraints: [],
			},
		},
		async function* (): AsyncIterable<Row> {
			// Intentionally yield only 2 values despite declaring 5 columns.
			for (const [idx, val] of data) {
				yield [idx, val];
			}
		},
	);
}

describe('TVF row padding', () => {
	let db: Database;

	beforeEach(() => {
		db = new Database();
		db.registerFunction(makeShortRowTvf([[0, 'alpha'], [1, 'beta'], [2, 'gamma']]));
	});

	afterEach(async () => {
		await db.close();
	});

	it('plain SELECT returns NULL for undeclared columns', async () => {
		const rows: Record<string, unknown>[] = [];
		for await (const row of db.eval('select row_index, col_0, col_1, col_2, col_3 from short_row_tvf()')) {
			rows.push(row);
		}
		expect(rows).to.have.length(3);
		expect(rows[0]).to.deep.equal({ row_index: 0, col_0: 'alpha', col_1: null, col_2: null, col_3: null });
		expect(rows[1]).to.deep.equal({ row_index: 1, col_0: 'beta',  col_1: null, col_2: null, col_3: null });
		expect(rows[2]).to.deep.equal({ row_index: 2, col_0: 'gamma', col_1: null, col_2: null, col_3: null });
	});

	it('INSERT…SELECT with row_number() over a short-row TVF succeeds and inserts correct rows', async () => {
		await db.exec(`
			create table dest (
				id      integer primary key,
				name    text,
				extra_a text null,
				extra_b text null,
				extra_c text null,
				extra_d text null
			)
		`);

		// This is the shape that crashed before the fix.
		// row_number() is a window function whose slot is at index = sourceColumnCount (5).
		// Without padding, the TVF yields 2-wide rows so the slot index is out of bounds.
		await db.exec(`
			insert into dest (id, name, extra_a, extra_b, extra_c, extra_d)
			select row_number() over (order by row_index) as id,
			       coalesce(col_0, 'row ' || row_index) as name,
			       col_1, col_2, col_3, null
			from short_row_tvf()
		`);

		const rows: Record<string, unknown>[] = [];
		for await (const row of db.eval('select * from dest order by id')) {
			rows.push(row);
		}

		expect(rows).to.have.length(3);
		expect(rows[0]).to.deep.include({ id: 1, name: 'alpha', extra_a: null, extra_b: null, extra_c: null });
		expect(rows[1]).to.deep.include({ id: 2, name: 'beta',  extra_a: null, extra_b: null, extra_c: null });
		expect(rows[2]).to.deep.include({ id: 3, name: 'gamma', extra_a: null, extra_b: null, extra_c: null });
	});
});
