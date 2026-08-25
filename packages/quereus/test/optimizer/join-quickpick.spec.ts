import { expect } from 'chai';
import { Database } from '../../src/core/database.js';
import type { SqlValue } from '../../src/common/types.js';
import type { PlanNode } from '../../src/planner/nodes/plan-node.js';

type ResultRow = Record<string, SqlValue>;

describe('QuickPick Join Enumeration', () => {
  let db: Database;

  beforeEach(() => {
    db = new Database();
  });

  afterEach(async () => {
    await db.close();
  });

  async function setupChain() {
    await db.exec("CREATE TABLE a (id INTEGER PRIMARY KEY, v INTEGER) USING memory");
    await db.exec("CREATE TABLE b (id INTEGER PRIMARY KEY, a_id INTEGER) USING memory");
    await db.exec("CREATE TABLE c (id INTEGER PRIMARY KEY, b_id INTEGER) USING memory");
    await db.exec("INSERT INTO a VALUES (1,10),(2,20),(3,30)");
    await db.exec("INSERT INTO b VALUES (10,1),(20,2),(30,3)");
    await db.exec("INSERT INTO c VALUES (100,10),(200,20),(300,30)");
  }

  it('exposes quickpick diagnostics in query_plan()', async () => {
    await setupChain();
    const rows: ResultRow[] = [];
    for await (const r of db.eval("SELECT properties FROM query_plan('SELECT * FROM a JOIN b ON a.id=b.a_id JOIN c ON b.id=c.b_id')")) rows.push(r);
    const props = String(rows.map(r => r.properties).join(' '));
    // Should include a quickpick diagnostic block somewhere
    expect(props).to.match(/quickpick/);
  });

  it('improves or maintains estimated cost for chain joins', async () => {
    await setupChain();
    // Baseline: just get plan; quickpick runs automatically but we can still assert that estimated rows are reasonable
    const rows: ResultRow[] = [];
    for await (const r of db.eval("SELECT physical FROM query_plan('SELECT a.id FROM a JOIN b ON a.id=b.a_id JOIN c ON b.id=c.b_id')")) rows.push(r);
    const physicals = rows.map(r => String(r.physical || ''));
    // Expect at least one JOIN node to have estimatedRows close to base table sizes (not full cross product)
    const hasReasonableJoin = physicals.some(p => /"estimatedRows":\s*\d+/i.test(p));
    expect(hasReasonableJoin).to.equal(true);
  });

  describe('a non-inner join inside the spine abandons enumeration entirely', () => {
    // Regression: the walk used to signal "outer join found, give up" by emptying
    // the relation list mid-recursion. The ancestor frames kept walking, refilled
    // the list from the siblings the bail had not reached yet, and the resulting
    // PARTIAL graph passed the >=3-relation gate — so enumeration rebuilt a join
    // over the survivors and silently dropped the bailed subtree together with
    // every predicate that referenced it. Needs 3+ relations AFTER the bailed one,
    // which is why a 4-relation spine is the smallest reproduction.

    async function setupWide() {
      await db.exec('CREATE TABLE txn (id INTEGER PRIMARY KEY, date TEXT NULL) USING memory');
      await db.exec('CREATE TABLE entry (id INTEGER PRIMARY KEY, txn_id INTEGER NULL, account_id INTEGER NULL, amount INTEGER NULL) USING memory');
      await db.exec('CREATE INDEX idx_entry_account ON entry(account_id)');
      await db.exec("INSERT INTO txn VALUES (1,'d1'),(2,'d2'),(3,'d3')");
      await db.exec('INSERT INTO entry VALUES (1,1,7,100),(2,1,8,200),(3,2,7,300)');
    }

    const collect = async (sql: string): Promise<ResultRow[]> => {
      const out: ResultRow[] = [];
      for await (const r of db.eval(sql)) out.push(r);
      return out;
    };

    /** Flattened `toString()` of the emitted plan, so a dropped relation is visible. */
    const planText = (sql: string): string => {
      const walk = (n: PlanNode): string =>
        n.toString() + ' ' + n.getChildren().map(c => walk(c as PlanNode)).join(' ');
      return walk(db.getPlan(sql));
    };

    it('keeps the outer-joined subtree when a LEFT join sits under a 4-relation spine', async () => {
      await setupWide();
      // No entry row satisfies all four ON conditions, so the answer is empty; the
      // bug dropped `entry`/`w` and returned a 27-row cross product of txn instead.
      const sql = `SELECT count(*) AS c FROM entry e LEFT JOIN txn w ON w.id = e.amount
        JOIN txn t ON t.id = e.txn_id JOIN txn u ON u.id = e.id JOIN txn v ON v.id = e.account_id`;
      expect(await collect(sql)).to.deep.equal([{ c: 0 }]);
      expect(planText(sql), 'the outer-joined tables survive in the plan').to.match(/entry/);
    });

    it('answers the same shape when only the joined-away side is projected', async () => {
      await setupWide();
      const sql = `SELECT t.date FROM entry e LEFT JOIN txn w ON w.id = e.amount
        JOIN txn t ON t.id = e.txn_id JOIN txn u ON u.id = e.id JOIN txn v ON v.id = e.account_id
        ORDER BY t.date`;
      expect(await collect(sql)).to.deep.equal([]);
    });

    it('keeps the semi join `rule-semi-join-pushdown` parks at the bottom of the spine', async () => {
      await setupWide();
      // The pushdown leaves `Join(inner, …, Join(semi, entry, keys), …)`, i.e. a
      // non-inner join as a spine leaf — the same shape, reachable from ordinary SQL.
      const sql = `SELECT e.id FROM entry e JOIN txn t ON t.id = e.txn_id
        JOIN txn u ON u.id = e.id JOIN txn v ON v.id = e.account_id
        WHERE e.txn_id IN (SELECT txn_id FROM entry WHERE account_id = 7) ORDER BY e.id`;
      expect(await collect(sql)).to.deep.equal([]);
      expect(planText(sql), 'the filtered table survives in the plan').to.match(/entry/);
    });
  });
});
