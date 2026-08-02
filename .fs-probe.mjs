import { Database } from './packages/quereus/dist/src/core/database.js';
const db = new Database();
await db.exec('CREATE TABLE o (id INTEGER PRIMARY KEY, cat TEXT, qty INTEGER, rid INTEGER) USING memory');
await db.exec('CREATE TABLE r (id INTEGER PRIMARY KEY, cat TEXT, qty INTEGER) USING memory');
for (let i = 1; i <= 100; i++) await db.exec(`INSERT INTO o VALUES (${i}, '${['a','b','c','d'][i%4]}', ${i%3}, ${1+(i%20)})`);
for (let i = 1; i <= 20; i++) await db.exec(`INSERT INTO r VALUES (${i}, '${['x','y','z'][i%3]}', ${i%5})`);
for await (const _ of db.eval('ANALYZE o')) {}
for await (const _ of db.eval('ANALYZE r')) {}
const sql = "SELECT * FROM o JOIN (SELECT id, cat FROM r UNION ALL SELECT id, cat FROM r) z ON z.id = o.id WHERE o.cat = 'a' AND z.cat = 'x'";
const plan = db.getPlan(sql);
function walk(n, d) {
  const sel = n.selectivity;
  console.log(' '.repeat(d) + n.nodeType + (n.nodeType === 'Filter' ? ' sel=' + sel : '') + ' phys=' + (n.physical && n.physical.estimatedRows));
  for (const c of n.getChildren()) walk(c, d + 1);
}
walk(plan, 0);
await db.close();
