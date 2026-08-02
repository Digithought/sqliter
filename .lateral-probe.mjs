import { Database } from './packages/quereus/dist/src/core/database.js';
const db = new Database();
await db.exec("create table t (k integer primary key, v integer)");
await db.exec("create table u (k integer primary key, v integer)");
await db.exec("insert into t values (1, 10), (2, 20)");
await db.exec("insert into u values (1, 10), (2, 99)");
try {
  const rows = [];
  for await (const r of db.eval("select t.k as tk, x.k as xk, x.v as xv from t join lateral (select * from u where u.k = t.k) x on x.v = t.v")) rows.push(r);
  console.log('ROWS:', JSON.stringify(rows));
} catch (e) {
  console.log('ERROR:', e.message);
}
try {
  const plan = [];
  for await (const r of db.eval("select * from query_plan('select t.k as tk, x.k as xk from t join lateral (select * from u where u.k = t.k) x on x.v = t.v')")) plan.push(r);
  console.log('PLAN:', JSON.stringify(plan.map(p => ({ op: p.op ?? p.node_type, detail: p.detail ?? p.extra })), null, 1));
} catch (e) {
  console.log('PLAN ERROR:', e.message);
}
await db.close();
