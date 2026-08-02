import { Database } from './packages/quereus/dist/src/core/database.js';
const db = new Database();
await db.exec("create table s (id integer primary key, k integer)");
await db.exec("insert into s values (1, 5), (2, 7), (3, 9)");
const res = [];
for await (const r of db.eval("analyze")) res.push(r);
console.log('analyze rows:', JSON.stringify(res));
const t = db.schemaManager._findTable('s', 'main');
console.log('stats:', t && t.statistics ? t.statistics.rowCount : 'none', 'estimatedRows:', t && t.estimatedRows);
const plan = db.getPlan("select * from s");
function walk(n, d) { console.log(' '.repeat(d) + n.nodeType, 'logical=' + n.estimatedRows, 'phys=' + (n.physical && n.physical.estimatedRows)); for (const c of n.getChildren()) if (c.getAttributes) walk(c, d+1); }
walk(plan, 0);
await db.close();
