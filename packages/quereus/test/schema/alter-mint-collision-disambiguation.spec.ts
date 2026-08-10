import { expect } from 'chai';
import { buildCheckConstraintSchema, buildForeignKeyConstraintSchema } from '../../src/schema/constraint-builder.js';
import type * as AST from '../../src/parser/ast.js';

/**
 * Unit-level rules behind the ALTER-path constraint-name mints. The end-to-end
 * behavior (each minted name individually droppable, the survivor still
 * enforcing) is corpus-covered in
 * `test/logic/10.1.5-alter-add-constraint-minted-name-disambiguation.sqllogic`,
 * on both the memory and the store backend. What is pinned HERE is the naming
 * rule itself, directly on the two shared builders every backend calls — the
 * thing three modules would otherwise each re-derive.
 *
 * Two properties matter and pull against each other:
 *
 *  - a mint must never repeat a name the table already holds (else one
 *    `DROP CONSTRAINT` removes two constraints), and
 *  - a NON-colliding mint must stay byte-identical to the historical spelling
 *    (else every persisted name and corpus assertion churns).
 */
describe('ALTER-path constraint-name mints', () => {
	const checkCon: AST.TableConstraint = {
		type: 'check',
		expr: { type: 'literal', value: 1 } as AST.Expression,
	};

	const mintCheck = (existingCount: number, taken: readonly string[]): string | undefined =>
		buildCheckConstraintSchema(checkCon, existingCount, new Set(taken)).name;

	describe('CHECK — `check_<n>`', () => {
		it('keeps the historical count-seeded spelling when it is free', () => {
			expect(mintCheck(0, [])).to.equal('check_0');
			expect(mintCheck(2, ['check_0', 'check_1'])).to.equal('check_2');
		});

		it('seeds from the CHECK count, not from the lowest free index', () => {
			// The table's one CHECK is user-named, so `check_0` is free — but the
			// historical mint said `check_1` and a non-colliding name must not move.
			expect(mintCheck(1, ['ck_user'])).to.equal('check_1');
		});

		it('bumps the index past a live name a drop left behind', () => {
			// `check_0` dropped, `check_1` still live: the count says 1, which is taken.
			expect(mintCheck(1, ['check_1'])).to.equal('check_2');
		});

		it('bumps past a whole run of taken indices', () => {
			expect(mintCheck(1, ['check_1', 'check_2', 'check_3'])).to.equal('check_4');
		});

		it('bumps past a taken name whatever constraint class holds it', () => {
			// The set is built by `collectTableConstraintNames`, which spans CHECK /
			// UNIQUE / FK — so `check_0` blocks the mint whether a CHECK, a UNIQUE or an
			// FK answers to it. The builder sees only names, so one fixture covers all
			// three; DROP CONSTRAINT resolving across classes is what makes that right.
			expect(mintCheck(0, ['check_0'])).to.equal('check_1');
		});

		it('never overrides a user-written name', () => {
			const named: AST.TableConstraint = { ...checkCon, name: 'check_0' };
			expect(buildCheckConstraintSchema(named, 0, new Set(['check_0'])).name).to.equal('check_0');
		});
	});

	describe('FOREIGN KEY — `_fk_<table>_<cols>`', () => {
		const columnIndexMap = new Map([['x', 1]]);
		const fkCon: AST.TableConstraint = {
			type: 'foreignKey',
			columns: [{ name: 'x' }],
			foreignKey: { table: 'P', columns: ['y'] },
		} as AST.TableConstraint;

		// The taken-set is CASE-FOLDED by contract (`collectTableConstraintNames`
		// builds it that way, and `disambiguateAutoConstraintName` folds only the
		// candidate side), so these fixtures fold too — a set of raw spellings would
		// silently miss every collision.
		const mintFk = (taken?: readonly string[]): string | undefined =>
			buildForeignKeyConstraintSchema(
				fkCon, columnIndexMap, 'C', 'main',
				taken === undefined ? undefined : new Set(taken.map(n => n.toLowerCase())),
			).name;

		it('keeps the bare mint when the name is free', () => {
			expect(mintFk([])).to.equal('_fk_C_x');
			expect(mintFk(['_fk_C_w'])).to.equal('_fk_C_x');
		});

		it('adds a collision-only `_<N>` suffix when the table already holds the name', () => {
			expect(mintFk(['_fk_c_x'])).to.equal('_fk_C_x_2');
			expect(mintFk(['_fk_C_x', '_fk_C_x_2'])).to.equal('_fk_C_x_3');
		});

		it('collides across constraint classes, case-folded', () => {
			expect(mintFk(['_FK_C_X'])).to.equal('_fk_C_x_2');
		});

		it('mints the historical bare name when no taken-set is supplied', () => {
			// The omitted-set arm is the pre-fix behavior and the reason every ALTER
			// caller now passes one; it stays supported for a caller with no table to
			// disambiguate against.
			expect(mintFk(undefined)).to.equal('_fk_C_x');
		});

		it('never overrides a user-written name', () => {
			const named = { ...fkCon, name: '_fk_C_x' } as AST.TableConstraint;
			expect(
				buildForeignKeyConstraintSchema(named, columnIndexMap, 'C', 'main', new Set(['_fk_c_x'])).name,
			).to.equal('_fk_C_x');
		});
	});
});
