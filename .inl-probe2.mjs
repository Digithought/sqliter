import { Database } from './packages/quereus/dist/src/core/database.js';
const db = new Database();
await db.exec("create table s (id integer primary key, k integer)");
await db.exec("create table big (id integer primary key, val text)");
await db.exec("insert into s values (1, 5), (2, 7), (3, 9)");
let ins = [];
for (let i = 1; i <= 200; i++) ins.push(`(${i}, 'v${i}')`);
await db.exec("insert into big values " + ins.join(', '));
for await (const _ of db.eval("analyze")) { void _; }
const q = "select s.id, big.val from s join big on big.id = s.k";
const plan = [];
for await (const r of db.eval(`select * from query_plan('${q.replace(/'/g, "''")}')`)) plan.push(r);
console.log('PLAN:', JSON.stringify(plan.map(p => p.op + ' :: ' + (p.detail ?? '')), null, 1));
const rows = [];
for await (const r of db.eval(q)) rows.push(r);
console.log('ROWS:', JSON.stringify(rows));
// left join + null key handling
await db.exec("insert into s values (4, null), (5, 999)");
for await (const _ of db.eval("analyze")) { void _; }
const q2 = "select s.id, big.val from s left join big on big.id = s.k order by s.id";
const rows2 = [];
for await (const r of db.eval(q2)) rows2.push(r);
console.log('LEFT ROWS:', JSON.stringify(rows2));
const plan2 = [];
for await (const r of db.eval(`select * from query_plan('${q2.replace(/'/g, "''")}')`)) plan2.push(r);
console.log('LEFT PLAN:', JSON.stringify(plan2.map(p => p.op), null, 0));
await db.close();
