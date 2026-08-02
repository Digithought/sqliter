import { Database } from './packages/quereus/dist/src/core/database.js';
const db = new Database();
await db.exec("create table s (id integer primary key, k integer null)");
await db.exec("create table big (id integer primary key, v integer, w integer)");
await db.exec("create index idx_v on big(v)");
await db.exec("insert into s values (1, 5), (2, 7), (3, 9), (4, null)");
let ins = [];
for (let i = 1; i <= 200; i++) ins.push(`(${i}, ${i}, ${i % 10})`);
await db.exec("insert into big values " + ins.join(', '));
for await (const _ of db.eval("analyze")) { void _; }
async function rows(q) { const out = []; for await (const r of db.eval(q)) out.push(r); return out; }
async function planOps(q) { const out = []; for await (const r of db.eval(`select * from query_plan('${q.replace(/'/g, "''")}')`)) out.push(r.op + (r.detail && r.op.includes('SEEK') ? '[' + r.detail + ']' : '')); return out; }

// ordering-load-bearing shape
const olb = "select s.id, z.v from s join (select * from big order by v) z on z.id = s.k";
console.log('OLB PLAN:', (await planOps(olb)).join(','));

// existence flag via left join
const ex = "select s.id, b_exists from s left join big b on b.id = s.k exists right as b_exists order by s.id";
console.log('EXISTS PLAN:', (await planOps(ex)).join(','));
console.log('EXISTS ROWS:', JSON.stringify(await rows(ex)));

// secondary index
const sec = "select s.id, big.id as bid from s join big on big.v = s.k order by s.id";
console.log('SEC PLAN:', (await planOps(sec)).join(','));
console.log('SEC ROWS:', JSON.stringify(await rows(sec)));

// composite: two-pair key over composite index
await db.exec("create table c2 (a integer, b integer, val text, primary key (a, b))");
let ins2 = [];
for (let i = 1; i <= 100; i++) ins2.push(`(${i % 10}, ${i}, 'c${i}')`);
await db.exec("insert into c2 values " + ins2.join(', '));
await db.exec("create table s2 (id integer primary key, x integer null, y integer null)");
await db.exec("insert into s2 values (1, 5, 15), (2, 3, 13), (3, 9, 999)");
for await (const _ of db.eval("analyze")) { void _; }
const comp = "select s2.id, c2.val from s2 join c2 on c2.a = s2.x and c2.b = s2.y order by s2.id";
console.log('COMP PLAN:', (await planOps(comp)).join(','));
console.log('COMP ROWS:', JSON.stringify(await rows(comp)));

// partial composite (only a covered)
const part = "select s2.id, c2.val from s2 join c2 on c2.a = s2.x and c2.val = 'c5' order by s2.id, c2.val";
console.log('PART PLAN:', (await planOps(part)).join(','));
await db.close();
