import { Database } from './packages/quereus/dist/src/core/database.js';
const db = new Database();
await db.exec("create table s (id integer primary key, k integer null)");
await db.exec("create table big (id integer primary key, val text)");
await db.exec("insert into s values (1, 5), (2, 7), (3, 9), (4, null), (5, 999)");
let ins = [];
for (let i = 1; i <= 200; i++) ins.push(`(${i}, 'v${i}')`);
await db.exec("insert into big values " + ins.join(', '));
for await (const _ of db.eval("analyze")) { void _; }
async function rows(q) { const out = []; for await (const r of db.eval(q)) out.push(r); return out; }
async function planOps(q) { const out = []; for await (const r of db.eval(`select * from query_plan('${q.replace(/'/g, "''")}')`)) out.push(r.op); return out; }

const inner = "select s.id, big.val from s join big on big.id = s.k order by s.id";
console.log('INNER PLAN:', (await planOps(inner)).join(','));
console.log('INNER:', JSON.stringify(await rows(inner)));

const left = "select s.id, big.val from s left join big on big.id = s.k order by s.id";
console.log('LEFT PLAN:', (await planOps(left)).join(','));
console.log('LEFT:', JSON.stringify(await rows(left)));

const semi = "select s.id from s where exists (select 1 from big where big.id = s.k) order by s.id";
console.log('SEMI PLAN:', (await planOps(semi)).join(','));
console.log('SEMI:', JSON.stringify(await rows(semi)));

const anti = "select s.id from s where not exists (select 1 from big where big.id = s.k) order by s.id";
console.log('ANTI PLAN:', (await planOps(anti)).join(','));
console.log('ANTI:', JSON.stringify(await rows(anti)));
await db.close();
