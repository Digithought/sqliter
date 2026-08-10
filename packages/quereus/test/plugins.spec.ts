/* eslint-disable @typescript-eslint/no-explicit-any */
import { expect } from 'chai';
import { Database } from '../src/index.js';
import { dynamicLoadModule } from '@quereus/plugin-loader';

function fileUrlFromHere(relative: string): string {
  return new URL(relative, import.meta.url).toString();
}

describe('Sample plugins (package.json–centric)', () => {
  let db: Database;

  beforeEach(() => {
    db = new Database();
  });

  afterEach(async () => {
    await db.close();
  });

  it('loads string-functions and executes reverse()', async () => {
    const url = fileUrlFromHere('../../sample-plugins/string-functions/index.js');
    // `db as any`: @quereus/plugin-loader's published types resolve `@quereus/quereus`
    // to `dist/`, while this test's `Database` comes from `src/` — two structurally
    // identical classes with distinct module identities. The cast bridges them without
    // making the test depend on a freshly-built `dist/` artifact. See review handoff.
    const manifest = await dynamicLoadModule(url, db as any, {});
    expect(manifest?.name ?? 'String Functions').to.be.a('string');

    const rows: any[] = [];
    for await (const row of db.eval("SELECT reverse('hello') AS r")) {
      rows.push(row);
    }
    expect(rows).to.have.length(1);
    expect(rows[0].r).to.equal('olleh');
  });

  it('loads custom-collations and sorts naturally with NUMERIC', async () => {
    const url = fileUrlFromHere('../../sample-plugins/custom-collations/index.js');
    await dynamicLoadModule(url, db as any, {});

    await db.exec('CREATE TABLE files(name TEXT)');
    await db.exec("INSERT INTO files(name) VALUES ('file10'), ('file2'), ('file1')");

    const names: any[] = [];
    for await (const row of db.eval('SELECT name FROM files ORDER BY name COLLATE NUMERIC')) {
      names.push(row.name);
    }
    expect(names).to.deep.equal(['file1', 'file2', 'file10']);
  });

  // json-table vtable is adapted to new module API; end-to-end JSON fetch is covered in integration.

  it('loads comprehensive-demo and operates key_value_store', async () => {
    const url = fileUrlFromHere('../../sample-plugins/comprehensive-demo/index.js');
    await dynamicLoadModule(url, db as any, { enable_debug: false });

    await db.exec("CREATE TABLE kv (key TEXT, value TEXT) USING key_value_store(store = 'test')");
    await db.exec("INSERT INTO kv(key, value) VALUES ('a', '1')");
    await db.exec("INSERT INTO kv(key, value) VALUES ('b', '2')");

    const values: any[] = [];
    for await (const row of db.eval('SELECT value FROM kv ORDER BY key')) {
      values.push(row.value);
    }
    expect(values).to.deep.equal(['1', '2']);
  });
});
