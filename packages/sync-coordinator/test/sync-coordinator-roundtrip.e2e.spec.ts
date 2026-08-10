/**
 * End-to-end sync round-trip through the live coordinator.
 *
 * Boots the real coordinator WebSocket server, connects two real-engine
 * `SyncClient`s over the wire, and asserts that a write on one client's engine
 * lands on the other — the check that catches client/coordinator protocol skew
 * (the wire codecs have drifted once before; see the sync-protocol work in
 * `tickets/complete/`).
 *
 * `service.spec.ts` pokes `CoordinatorService` in-process (no socket, no
 * client) and `sync-client.spec.ts` drives the client against a mock socket.
 * Neither exercises the two across a real WebSocket; this spec does.
 */

import { expect } from 'chai';
import { SyncClient } from '@quereus/sync-client';
import {
  bootCoordinator,
  makeClientPeer,
  collect,
  waitFor,
  tick,
  type BootedCoordinator,
  type ClientPeer,
} from './_e2e-harness.js';

// Valid per the coordinator's default database-id validator (`org:type_id`).
const DB_ID = 'default:s_roundtrip';
// Both peers start from the SAME base-table DDL so neither bootstrap fights the
// first replicated change (three columns, so row fidelity is more than the key).
const DDL = 'create table orders (id integer primary key, note text, qty integer) using store';

describe('sync-coordinator WebSocket round-trip (e2e)', () => {
  let coordinator: BootedCoordinator;
  let peerA: ClientPeer;
  let peerB: ClientPeer;
  let clientA: SyncClient;
  let clientB: SyncClient;

  beforeEach(async () => {
    coordinator = await bootCoordinator();

    peerA = await makeClientPeer(DDL);
    peerB = await makeClientPeer(DDL);

    // autoReconnect: false so no backoff timer fires after teardown; tiny debounce
    // so a local write flushes to the server promptly.
    clientA = new SyncClient({
      syncManager: peerA.syncManager,
      syncEvents: peerA.syncEvents,
      autoReconnect: false,
      localChangeDebounceMs: 10,
    });
    clientB = new SyncClient({
      syncManager: peerB.syncManager,
      syncEvents: peerB.syncEvents,
      autoReconnect: false,
      localChangeDebounceMs: 10,
    });

    await clientA.connect(coordinator.url, DB_ID);
    await clientB.connect(coordinator.url, DB_ID);

    // connect() resolves on handshake_ack; the local-change subscription is set
    // up in the post-ack continuation. Let that settle before any write so the
    // first onLocalChange is not missed.
    await tick(50);
  });

  afterEach(async () => {
    // Deterministic teardown even on failure: disconnect clients (stops their
    // reconnect/debounce timers), close both engines, then stop the server +
    // service and remove the tmpdir store.
    for (const c of [clientA, clientB]) {
      try { await c?.disconnect(); } catch { /* ignore teardown races */ }
    }
    for (const p of [peerA, peerB]) {
      try { await p?.close(); } catch { /* ignore teardown races */ }
    }
    await coordinator?.stop();
  });

  it('relays a write on A to B through the live coordinator (A→B)', async () => {
    await peerA.db.exec(`insert into orders (id, note, qty) values (1, 'from-A', 42)`);

    await waitFor(
      async () => (await collect(peerB.db, 'select id from orders where id = 1')).length === 1,
      { label: 'row 1 to arrive on B' },
    );

    const rows = await collect(peerB.db, 'select id, note, qty from orders where id = 1');
    expect(rows).to.have.length(1);
    expect(rows[0].note).to.equal('from-A');
    expect(Number(rows[0].qty)).to.equal(42);
  });

  it('relays a write on B to A through the live coordinator (B→A)', async () => {
    // The reverse direction — a one-directional codec bug can't pass both.
    await peerB.db.exec(`insert into orders (id, note, qty) values (2, 'from-B', 7)`);

    await waitFor(
      async () => (await collect(peerA.db, 'select id from orders where id = 2')).length === 1,
      { label: 'row 2 to arrive on A' },
    );

    const rows = await collect(peerA.db, 'select id, note, qty from orders where id = 2');
    expect(rows).to.have.length(1);
    expect(rows[0].note).to.equal('from-B');
    expect(Number(rows[0].qty)).to.equal(7);
  });

  it('cross-replicates concurrent writes on the same pair of connections', async () => {
    await peerA.db.exec(`insert into orders (id, note, qty) values (10, 'a-ten', 100)`);
    await peerB.db.exec(`insert into orders (id, note, qty) values (20, 'b-twenty', 200)`);

    await waitFor(
      async () => {
        const onB = await collect(peerB.db, 'select id from orders where id = 10');
        const onA = await collect(peerA.db, 'select id from orders where id = 20');
        return onB.length === 1 && onA.length === 1;
      },
      { label: 'both rows to cross-replicate' },
    );

    const [bRow] = await collect(peerB.db, 'select note, qty from orders where id = 10');
    const [aRow] = await collect(peerA.db, 'select note, qty from orders where id = 20');
    expect(bRow.note).to.equal('a-ten');
    expect(Number(bRow.qty)).to.equal(100);
    expect(aRow.note).to.equal('b-twenty');
    expect(Number(aRow.qty)).to.equal(200);
  });

  it('relays update and delete changes A→B (distinct non-insert wire codecs)', async () => {
    // Insert exercises only the upsert-of-a-fresh-row codec. Update (column
    // change on an existing row) and delete (tombstone) are separate wire ops;
    // a codec skew that only bites those would slip past the insert-only tests.
    await peerA.db.exec(`insert into orders (id, note, qty) values (30, 'v1', 1)`);
    await waitFor(
      async () => (await collect(peerB.db, 'select id from orders where id = 30')).length === 1,
      { label: 'row 30 to arrive on B' },
    );

    await peerA.db.exec(`update orders set note = 'v2', qty = 9 where id = 30`);
    await waitFor(
      async () => {
        const [r] = await collect(peerB.db, 'select note, qty from orders where id = 30');
        return r?.note === 'v2' && Number(r?.qty) === 9;
      },
      { label: 'update on A to propagate to B' },
    );

    await peerA.db.exec(`delete from orders where id = 30`);
    await waitFor(
      async () => (await collect(peerB.db, 'select id from orders where id = 30')).length === 0,
      { label: 'delete on A to propagate to B' },
    );
  });
});
