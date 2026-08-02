import { Database } from './packages/quereus/dist/src/core/database.js';
const db = new Database();
await db.exec("create table s (id integer primary key, k integer)");
await db.exec("create table big (id integer primary key, val text)");
await db.exec("insert into s values (1, 5), (2, 7), (3, 9)");
let ins = [];
for (let i = 1; i <= 200; i++) ins.push(`(${i}, 'v${i}')`);
await db.exec("insert into big values " + ins.join(', '));
const plan = db.getPlan("select s.id, big.val from s join big on big.id = s.k");
function walk(n, d) {
  console.log(' '.repeat(d) + n.nodeType, 'logicalRows=' + n.estimatedRows, 'physRows=' + (n.physical && n.physical.estimatedRows));
  for (const c of n.getChildren()) if (c.getAttributes) walk(c, d + 1);
}
walk(plan, 0);
await db.close();
