import { expect } from 'chai';
import { Database } from '../../src/core/database.js';
import type { SqlValue } from '../../src/common/types.js';

type ResultRow = Record<string, SqlValue>;

describe('Predicate push-down (supported-only fragments)', () => {
  let db: Database;

  beforeEach(() => {
    db = new Database();
  });

  afterEach(async () => {
    await db.close();
  });

  async function setup(): Promise<void> {
    await db.exec("CREATE TABLE ptab (id INTEGER PRIMARY KEY, name TEXT) USING memory");
    await db.exec("INSERT INTO ptab VALUES (1, 'Alice'), (2, 'Bob'), (3, 'Charlie')");
  }

  it('keeps residual FILTER above Retrieve when only part of predicate is supported', async () => {
    await setup();
    // id = 1 is supported (equality on PK) but LIKE is not handled by memory index planning
    const q = "SELECT name FROM ptab WHERE id = 1 AND name LIKE '%li%'";
    const rows: ResultRow[] = [];
    for await (const r of db.eval("SELECT COUNT(*) AS filters FROM query_plan(?) WHERE op = 'FILTER'", [q])) {
      rows.push(r);
    }
    expect(rows).to.have.lengthOf(1);
    expect(rows[0].filters).to.equal(1);

    const access: ResultRow[] = [];
    for await (const r of db.eval("SELECT COUNT(*) AS accesses FROM query_plan(?) WHERE op IN ('SEQSCAN','INDEXSCAN','INDEXSEEK')", [q])) {
      access.push(r);
    }
    expect(access).to.have.lengthOf(1);
    expect(access[0].accesses).to.equal(1);
  });

  it('pushes predicate through AliasNode (view boundary)', async () => {
    await setup();
    await db.exec("CREATE VIEW v AS SELECT id, name FROM ptab");
    // id = 2 should push through Alias → Project → into Retrieve pipeline
    const q = "SELECT * FROM v WHERE id = 2";
    const rows: ResultRow[] = [];
    for await (const r of db.eval(q)) {
      rows.push(r);
    }
    expect(rows).to.have.lengthOf(1);
    expect(rows[0].name).to.equal('Bob');

    // Verify the predicate was pushed down (no residual FILTER above Alias)
    const filters: ResultRow[] = [];
    for await (const r of db.eval("SELECT COUNT(*) AS filters FROM query_plan(?) WHERE op = 'FILTER'", [q])) {
      filters.push(r);
    }
    expect(filters[0].filters).to.equal(0);
    await db.exec("DROP VIEW v");
  });

  it('pushes predicate through AliasNode with qualified column references', async () => {
    await setup();
    await db.exec("CREATE VIEW v AS SELECT id, name FROM ptab");
    const q = "SELECT v.name FROM v WHERE v.id = 1";
    const rows: ResultRow[] = [];
    for await (const r of db.eval(q)) {
      rows.push(r);
    }
    expect(rows).to.have.lengthOf(1);
    expect(rows[0].name).to.equal('Alice');
    await db.exec("DROP VIEW v");
  });

  it('handles key-equality with residual arithmetic, keeping residual filter above index seek', async () => {
    await setup();
    const q = "SELECT name FROM ptab WHERE id = 2 AND (id + 0) > 0";
    const rows: ResultRow[] = [];
    for await (const r of db.eval("SELECT COUNT(*) AS filters FROM query_plan(?) WHERE op = 'FILTER'", [q])) {
      rows.push(r);
    }
    expect(rows).to.have.lengthOf(1);
    // IndexSeek handles id = 2 internally; residual (id + 0) > 0 stays as FILTER
    expect(rows[0].filters).to.equal(1);
  });
});

/**
 * Regression guard for `bug-correlated-subquery-cannot-read-outer-computed-column`.
 *
 * `canPushAcrossProject` used to build the predicate's dependency set from its own
 * scalar tree only, stopping at relational children. A correlated reference inside
 * an `exists (...)` operand lives in exactly that relational subtree, so the set came
 * back empty and the Filter was pushed BELOW the Project that computes the column the
 * reference reads — "No row context found for column d" at runtime.
 *
 * Row-set coverage lives in test/logic/07.7.8-correlated-ref-to-computed-column.sqllogic.
 */
describe('Predicate push-down across a computing Project (correlated references)', () => {
  let db: Database;

  /** Plan ops that make up the relational spine, in the order query_plan reports them. */
  const SPINE_OPS = new Set(['PROJECT', 'FILTER', 'ALIAS', 'INDEXSCAN', 'INDEXSEEK', 'SEQSCAN']);

  beforeEach(async () => {
    db = new Database();
    await db.exec('CREATE TABLE gt (id INTEGER PRIMARY KEY, x INTEGER) USING memory');
    await db.exec('CREATE TABLE side (tag TEXT PRIMARY KEY) USING memory');
    await db.exec('INSERT INTO gt VALUES (1, 10), (2, 20), (3, 0), (4, -5)');
    await db.exec("INSERT INTO side VALUES ('one')");
  });

  afterEach(async () => {
    await db.close();
  });

  /**
   * The chain of relational nodes hanging below the sub-select's Alias, walking the
   * first spine child at each step. Reading it off `parent_id` rather than the flat op
   * list keeps the correlated sub-query's own Project/Filter/scan out of the answer.
   */
  async function spineBelowAlias(sql: string): Promise<string[]> {
    const nodes: Array<{ id: number; parent_id: number | null; op: string }> = [];
    for await (const r of db.eval('SELECT id, parent_id, op FROM query_plan(?) ORDER BY id', [sql])) {
      nodes.push(r as unknown as { id: number; parent_id: number | null; op: string });
    }
    const alias = nodes.find(n => n.op === 'ALIAS');
    expect(alias, 'plan must contain the sub-select Alias').to.not.equal(undefined);

    const spine: string[] = [];
    let current = alias!.id;
    for (;;) {
      const child = nodes.find(n => n.parent_id === current && SPINE_OPS.has(n.op));
      if (!child) break;
      spine.push(child.op);
      current = child.id;
    }
    return spine;
  }

  async function allRows(sql: string): Promise<ResultRow[]> {
    const rows: ResultRow[] = [];
    for await (const r of db.eval(sql)) rows.push(r as ResultRow);
    return rows;
  }

  it('keeps the FILTER above the Project when a sub-query correlates to a computed column', async () => {
    const q = 'select id, d from (select id, x, x * 2 as d from gt) t '
      + 'where exists (select 1 from side where t.d > 0)';

    expect(await allRows(q)).to.deep.equal([{ id: 1, d: 20 }, { id: 2, d: 40 }]);
    expect(await spineBelowAlias(q), 'Filter must stay above the Project that mints `d`')
      .to.deep.equal(['FILTER', 'PROJECT', 'INDEXSCAN']);
  });

  it('still pushes the FILTER below the Project when the correlation is on a pass-through column', async () => {
    // Same Project — it computes `d` and passes `x` through. `x` exists below, so the
    // push is safe and must still happen; a blanket "refuse on any correlation" would
    // fail here.
    const q = 'select id, d from (select id, x, x * 2 as d from gt) t '
      + 'where exists (select 1 from side where t.x > 0)';

    expect(await allRows(q)).to.deep.equal([{ id: 1, d: 20 }, { id: 2, d: 40 }]);
    expect(await spineBelowAlias(q), 'Filter must be pushed below the Project')
      .to.deep.equal(['PROJECT', 'FILTER', 'INDEXSCAN']);
  });

  it('keeps the FILTER above the Project for a correlated SCALAR sub-query too', async () => {
    // `side` has one row, so `max(t.d)` over it is `t.d` — the correlation lives under a
    // ScalarSubquery rather than an Exists.
    const q = 'select id, d from (select id, x, x * 2 as d from gt) t '
      + 'where (select max(t.d) from side) > 0';

    expect(await allRows(q)).to.deep.equal([{ id: 1, d: 20 }, { id: 2, d: 40 }]);
    expect(await spineBelowAlias(q), 'Filter must stay above the Project that mints `d`')
      .to.deep.equal(['FILTER', 'PROJECT', 'INDEXSCAN']);
  });
});


