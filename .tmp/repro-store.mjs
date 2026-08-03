import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { Database } from '@quereus/quereus';
import { createIsolatedStoreModule } from '@quereus/store';
import { createLevelDBProvider } from '@quereus/plugin-leveldb';

const dir = path.join(os.tmpdir(), `quereus-repro-${Date.now()}`);
fs.mkdirSync(dir, { recursive: true });

const db = new Database();
const provider = createLevelDBProvider({ basePath: dir.replace(/\\/g, '/') });
db.registerModule('store', createIsolatedStoreModule({ provider }));
db.setOption('default_vtab_module', 'store');

await db.exec(`
create table txn (id text primary key, entity_id text, date text);
create table account_group (id text primary key, account_type text);
create table account (id text primary key, entity_id text, account_group_id text);
create table entry (id text primary key, txn_id text, account_id text, amount integer);
`);

const TYPES = ['ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE'];
await db.exec('begin');
for (let i = 0; i < TYPES.length; i++) await db.exec(`insert into account_group values ('g${i}','${TYPES[i]}')`);
for (let i = 0; i < 20; i++) await db.exec(`insert into account values ('a${i}','e1','g${i % 5}')`);
for (let i = 0; i < 200; i++) await db.exec(`insert into txn values ('t${i}','e1','2024-01-01')`);
const vals = [];
for (let i = 0; i < 2001; i++) vals.push(`('n${i}','t${i % 200}','a${i % 20}',${(i % 7) - 3})`);
await db.exec(`insert into entry values ${vals.join(',')}`);
await db.exec('commit');

async function show(label, sql, params) {
	try {
		const rows = params ? await db.eval(sql, params) : await db.eval(sql);
		const out = [];
		for await (const r of rows) out.push(r);
		console.log(label, JSON.stringify(out));
	} catch (e) {
		console.log(label, 'ERROR', e.message);
	}
}

const j4 = `
from entry e
join txn t on t.id = e.txn_id
join account a on a.id = e.account_id
join account_group ag on ag.id = a.account_group_id`;

await show('4join +WHERE +GB :', `select ag.account_type as type, sum(e.amount) as tot ${j4} where a.entity_id = 'e1' group by ag.account_type`);
await show('4join +PARAM  +GB :', `select ag.account_type as type, sum(e.amount) as tot ${j4} where a.entity_id = ? group by ag.account_type`, ['e1']);
await show('4join noWHERE +GB :', `select ag.account_type as type, sum(e.amount) as tot ${j4} group by ag.account_type`);
await show('3join +WHERE +GB :', `select ag.account_type as type, sum(e.amount) as tot from entry e join account a on a.id = e.account_id join account_group ag on ag.id = a.account_group_id where a.entity_id = 'e1' group by ag.account_type`);
await show('4join +WHERE noGB :', `select count(*) as c, sum(e.amount) as s ${j4} where a.entity_id = 'e1'`);

await db.close();
fs.rmSync(dir, { recursive: true, force: true });
