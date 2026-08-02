import { Database } from './packages/quereus/dist/src/core/database.js';
const db = new Database();
// lateral: should now nested-loop and return correct rows
await db.exec("create table t (k integer primary key, v integer)");
await db.exec("create table u (k integer primary key, v integer)");
await db.exec("insert into t values (1, 10), (2, 20)");
await db.exec("insert into u values (1, 10), (2, 99)");
try {
  const rows = [];
  for await (const r of db.eval("select t.k as tk, x.k as xk, x.v as xv from t join lateral (select * from u where u.k = t.k) x on x.v = t.v")) rows.push(r);
  console.log('LATERAL ROWS:', JSON.stringify(rows));
} catch (e) { console.log('LATERAL ERROR:', e.message); }

// index-NL shape: small outer, big indexed inner
await db.exec("create table s (id integer primary key, k integer)");
await db.exec("create table big (id integer primary key, val text)");
await db.exec("insert into s values (1, 5), (2, 7), (3, 9)");
let ins = [];
for (let i = 1; i <= 200; i++) ins.push(`(${i}, 'v${i}')`);
await db.exec("insert into big values " + ins.join(', '));
const q = "select s.id, big.val from s join big on big.id = s.k";
const plan = [];
for await (const r of db.eval(`select * from query_plan('${q.replace(/'/g, "''")}')`)) plan.push(r);
console.log('PLAN:', JSON.stringify(plan.map(p => p.op + ' :: ' + (p.detail ?? '')), null, 1));
const rows = [];
for await (const r of db.eval(q)) rows.push(r);
console.log('ROWS:', JSON.stringify(rows));
await db.close();
