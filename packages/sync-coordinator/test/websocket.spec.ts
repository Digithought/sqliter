/**
 * Integration tests for WebSocket handler.
 */

import { expect } from 'chai';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import WebSocket from 'ws';
import {
  PROTOCOL_VERSION,
  createHLC,
  siteIdFromBase64,
  serializeSnapshotCheckpoint,
} from '@quereus/sync';
import { createCoordinatorServer, loadConfig, type CoordinatorServer } from '../src/index.js';

// Test database ID in <org_id>:<type>_<id> format
const TEST_DATABASE_ID = 'default:s_test-scenario';

// Valid 22-character base64url site IDs (16 bytes each)
const TEST_SITE_ID_1 = 'AAAAAAAAAAAAAAAAAAAAAA'; // 16 zero bytes
const TEST_SITE_ID_2 = 'AAAAAAAAAAAAAAAAAAAAAB'; // slightly different

describe('WebSocket Handler', () => {
  let server: CoordinatorServer;
  let wsUrl: string;
  let testDataDir: string;

  before(async () => {
    testDataDir = join(tmpdir(), `sync-ws-test-${randomUUID()}`);
    const config = loadConfig({
      overrides: {
        port: 0,
        dataDir: testDataDir,
        basePath: '/sync',
      },
    });

    server = await createCoordinatorServer({ config });
    await server.start();

    const address = server.app.server.address();
    const port = typeof address === 'object' && address ? address.port : 3000;
    wsUrl = `ws://127.0.0.1:${port}/sync/ws`;
  });

  after(async () => {
    await server.stop();
    try {
      await rm(testDataDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  /**
   * Helper to create a WebSocket and wait for connection.
   */
  function connectWs(): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      ws.on('open', () => resolve(ws));
      ws.on('error', reject);
    });
  }

  /**
   * Helper to send a message and wait for response.
   */
  function sendAndReceive(ws: WebSocket, message: object): Promise<object> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Timeout')), 5000);
      ws.once('message', (data) => {
        clearTimeout(timeout);
        resolve(JSON.parse(data.toString()));
      });
      ws.send(JSON.stringify(message));
    });
  }

  describe('Handshake', () => {
    it('should complete handshake with valid databaseId and siteId', async () => {
      const ws = await connectWs();
      try {
        const response = await sendAndReceive(ws, {
          type: 'handshake',
          databaseId: TEST_DATABASE_ID,
          siteId: TEST_SITE_ID_1,
          protocolVersion: PROTOCOL_VERSION,
        }) as { type: string; databaseId: string; serverSiteId: string; connectionId: string; protocolVersion: number };

        expect(response.type).to.equal('handshake_ack');
        expect(response.databaseId).to.equal(TEST_DATABASE_ID);
        expect(response.serverSiteId).to.be.a('string');
        expect(response.connectionId).to.be.a('string');
        // The ack echoes the server's wire version for the client's reverse check.
        expect(response.protocolVersion).to.equal(PROTOCOL_VERSION);
      } finally {
        ws.close();
      }
    });

    it('should reject a handshake whose protocolVersion mismatches (fatal, closes socket)', async () => {
      const ws = await connectWs();
      try {
        const closed = new Promise<number>((resolve) => ws.on('close', (code) => resolve(code)));
        const response = await sendAndReceive(ws, {
          type: 'handshake',
          databaseId: TEST_DATABASE_ID,
          siteId: TEST_SITE_ID_1,
          protocolVersion: PROTOCOL_VERSION + 1,
        }) as { type: string; code: string; fatal: boolean };

        expect(response.type).to.equal('error');
        expect(response.code).to.equal('PROTOCOL_VERSION_MISMATCH');
        expect(response.fatal).to.be.true;
        // The coordinator also closes the socket on a version mismatch.
        expect(await closed).to.equal(4003);
      } finally {
        ws.close();
      }
    });

    it('should reject a handshake with no protocolVersion (pre-versioning client)', async () => {
      const ws = await connectWs();
      try {
        const response = await sendAndReceive(ws, {
          type: 'handshake',
          databaseId: TEST_DATABASE_ID,
          siteId: TEST_SITE_ID_1,
        }) as { type: string; code: string; fatal: boolean };

        expect(response.type).to.equal('error');
        expect(response.code).to.equal('PROTOCOL_VERSION_MISMATCH');
        expect(response.fatal).to.be.true;
      } finally {
        ws.close();
      }
    });

    it('should reject handshake without databaseId', async () => {
      const ws = await connectWs();
      try {
        const response = await sendAndReceive(ws, {
          type: 'handshake',
          siteId: TEST_SITE_ID_1,
          protocolVersion: PROTOCOL_VERSION,
        }) as { type: string; code: string; fatal: boolean };

        expect(response.type).to.equal('error');
        expect(response.code).to.equal('MISSING_DATABASE_ID');
        expect(response.fatal).to.be.true;
      } finally {
        ws.close();
      }
    });

    it('should reject handshake without siteId', async () => {
      const ws = await connectWs();
      try {
        const response = await sendAndReceive(ws, {
          type: 'handshake',
          databaseId: TEST_DATABASE_ID,
          protocolVersion: PROTOCOL_VERSION,
        }) as { type: string; code: string; fatal: boolean };

        expect(response.type).to.equal('error');
        expect(response.code).to.equal('AUTH_FAILED');
        expect(response.fatal).to.be.true;
      } finally {
        ws.close();
      }
    });
  });

  describe('Ping/Pong', () => {
    it('should respond to ping', async () => {
      const ws = await connectWs();
      try {
        // Handshake first
        await sendAndReceive(ws, {
          type: 'handshake',
          databaseId: TEST_DATABASE_ID,
          siteId: TEST_SITE_ID_1,
          protocolVersion: PROTOCOL_VERSION,
        });

        const response = await sendAndReceive(ws, {
          type: 'ping',
        }) as { type: string };

        expect(response.type).to.equal('pong');
      } finally {
        ws.close();
      }
    });
  });

  describe('Get Changes', () => {
    it('should require authentication', async () => {
      const ws = await connectWs();
      try {
        const response = await sendAndReceive(ws, {
          type: 'get_changes',
        }) as { type: string; code: string };

        expect(response.type).to.equal('error');
        expect(response.code).to.equal('NOT_AUTHENTICATED');
      } finally {
        ws.close();
      }
    });

    it('should return changes after handshake', async () => {
      const ws = await connectWs();
      try {
        await sendAndReceive(ws, {
          type: 'handshake',
          databaseId: TEST_DATABASE_ID,
          siteId: TEST_SITE_ID_1,
          protocolVersion: PROTOCOL_VERSION,
        });

        const response = await sendAndReceive(ws, {
          type: 'get_changes',
        }) as { type: string; changeSets: unknown[] };

        expect(response.type).to.equal('changes');
        expect(response.changeSets).to.be.an('array');
      } finally {
        ws.close();
      }
    });
  });

  describe('Duplicate handshake', () => {
    it('should reject duplicate handshake with ALREADY_AUTHENTICATED', async () => {
      const ws = await connectWs();
      try {
        // First handshake
        await sendAndReceive(ws, {
          type: 'handshake',
          databaseId: TEST_DATABASE_ID,
          siteId: TEST_SITE_ID_1,
          protocolVersion: PROTOCOL_VERSION,
        });

        // Second handshake on same connection
        const response = await sendAndReceive(ws, {
          type: 'handshake',
          databaseId: TEST_DATABASE_ID,
          siteId: TEST_SITE_ID_1,
          protocolVersion: PROTOCOL_VERSION,
        }) as { type: string; code: string; fatal: boolean };

        expect(response.type).to.equal('error');
        expect(response.code).to.equal('ALREADY_AUTHENTICATED');
        expect(response.fatal).to.be.true;
      } finally {
        ws.close();
      }
    });
  });

  describe('Unknown message type', () => {
    it('should return UNKNOWN_MESSAGE for unrecognized type', async () => {
      const ws = await connectWs();
      try {
        // Handshake first
        await sendAndReceive(ws, {
          type: 'handshake',
          databaseId: TEST_DATABASE_ID,
          siteId: TEST_SITE_ID_1,
          protocolVersion: PROTOCOL_VERSION,
        });

        const response = await sendAndReceive(ws, {
          type: 'totally_unknown',
        }) as { type: string; code: string; fatal: boolean };

        expect(response.type).to.equal('error');
        expect(response.code).to.equal('UNKNOWN_MESSAGE');
        // Transient: one bad message shouldn't kill the client's reconnect.
        expect(response.fatal).to.be.false;
      } finally {
        ws.close();
      }
    });
  });

  describe('Apply Changes via WS', () => {
    it('should require authentication for apply_changes', async () => {
      const ws = await connectWs();
      try {
        const response = await sendAndReceive(ws, {
          type: 'apply_changes',
          changes: [],
        }) as { type: string; code: string };

        expect(response.type).to.equal('error');
        expect(response.code).to.equal('NOT_AUTHENTICATED');
      } finally {
        ws.close();
      }
    });

    it('should apply empty changes array', async () => {
      const ws = await connectWs();
      try {
        await sendAndReceive(ws, {
          type: 'handshake',
          databaseId: TEST_DATABASE_ID,
          siteId: TEST_SITE_ID_1,
          protocolVersion: PROTOCOL_VERSION,
        });

        const response = await sendAndReceive(ws, {
          type: 'apply_changes',
          changes: [],
        }) as { type: string; applied: number };

        expect(response.type).to.equal('apply_result');
        expect(response.applied).to.equal(0);
      } finally {
        ws.close();
      }
    });
  });

  describe('Get Snapshot via WS', () => {
    it('should require authentication for get_snapshot', async () => {
      const ws = await connectWs();
      try {
        const response = await sendAndReceive(ws, {
          type: 'get_snapshot',
        }) as { type: string; code: string };

        expect(response.type).to.equal('error');
        expect(response.code).to.equal('NOT_AUTHENTICATED');
      } finally {
        ws.close();
      }
    });

    it('should stream snapshot after handshake', async function () {
      const ws = await connectWs();
      try {
        await sendAndReceive(ws, {
          type: 'handshake',
          databaseId: TEST_DATABASE_ID,
          siteId: TEST_SITE_ID_1,
          protocolVersion: PROTOCOL_VERSION,
        });

        // Collect all snapshot messages until snapshot_complete
        const messages = await new Promise<object[]>((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error('Timeout waiting for snapshot')), 5000);
          const received: object[] = [];
          ws.send(JSON.stringify({ type: 'get_snapshot' }));
          ws.on('message', (data) => {
            const msg = JSON.parse(data.toString()) as { type: string };
            received.push(msg);
            if (msg.type === 'snapshot_complete' || msg.type === 'error') {
              clearTimeout(timeout);
              resolve(received);
            }
          });
        });

        // Should have at least a header chunk and snapshot_complete
        const types = messages.map((m: any) => m.type);
        expect(types).to.include('snapshot_chunk');
        expect(types[types.length - 1]).to.equal('snapshot_complete');

        // Verify header chunk has serialized fields (strings, not BigInt/Uint8Array)
        const headerMsg = messages.find((m: any) => m.type === 'snapshot_chunk') as any;
        expect(headerMsg.chunk).to.be.an('object');
        expect(headerMsg.chunk.type).to.equal('header');
        expect(headerMsg.chunk.siteId).to.be.a('string');
        expect(headerMsg.chunk.hlc).to.be.a('string');
      } finally {
        ws.close();
        // Wait for server-side session cleanup
        await new Promise(resolve => setTimeout(resolve, 300));
      }
    });
  });

  describe('Resume Snapshot via WS', () => {
    /**
     * A checkpoint in its JSON-safe wire form. Built through the shared codec so
     * the test speaks exactly what a client would send: the raw checkpoint holds
     * a Uint8Array siteId and a bigint HLC wallTime, neither of which survives
     * JSON on its own.
     */
    function makeWireCheckpoint(snapshotId: string) {
      return serializeSnapshotCheckpoint({
        snapshotId,
        siteId: siteIdFromBase64(TEST_SITE_ID_1),
        hlc: createHLC(BigInt(1700000000000), 0, siteIdFromBase64(TEST_SITE_ID_1), 0),
        lastTableIndex: 0,
        lastEntryIndex: 0,
        completedTables: [],
        entriesProcessed: 0,
        createdAt: 1700000000000,
      });
    }

    it('should require authentication for resume_snapshot', async () => {
      const ws = await connectWs();
      try {
        const response = await sendAndReceive(ws, {
          type: 'resume_snapshot',
          checkpoint: makeWireCheckpoint('test'),
        }) as { type: string; code: string };

        expect(response.type).to.equal('error');
        expect(response.code).to.equal('NOT_AUTHENTICATED');
      } finally {
        ws.close();
      }
    });

    it('should resume a snapshot from a serialized checkpoint after handshake', async function () {
      const ws = await connectWs();
      try {
        await sendAndReceive(ws, {
          type: 'handshake',
          databaseId: TEST_DATABASE_ID,
          siteId: TEST_SITE_ID_1,
          protocolVersion: PROTOCOL_VERSION,
        });

        // The checkpoint must survive JSON.stringify on the way out and be
        // decoded back to its binary shape by the coordinator; a raw checkpoint
        // would throw here on the bigint, and an undecoded one would hand the
        // service a base64 string where it expects a Uint8Array siteId.
        const messages = await new Promise<object[]>((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error('Timeout waiting for resumed snapshot')), 5000);
          const received: object[] = [];
          ws.send(JSON.stringify({
            type: 'resume_snapshot',
            checkpoint: makeWireCheckpoint('snap-resume-ws'),
          }));
          ws.on('message', (data) => {
            const msg = JSON.parse(data.toString()) as { type: string };
            received.push(msg);
            if (msg.type === 'snapshot_complete' || msg.type === 'error') {
              clearTimeout(timeout);
              resolve(received);
            }
          });
        });

        const types = messages.map((m) => (m as { type: string }).type);
        expect(types, `unexpected resume response: ${JSON.stringify(messages)}`).to.not.include('error');
        expect(types[types.length - 1]).to.equal('snapshot_complete');

        // The resumed stream reuses the checkpoint's snapshotId — proof the
        // decoded checkpoint (not a corrupt one) reached the stream generator.
        const header = messages.find(
          (m) => (m as { type: string; chunk?: { type: string } }).chunk?.type === 'header',
        ) as { chunk: { snapshotId: string; siteId: string; hlc: string } } | undefined;
        expect(header, 'no header chunk in resumed stream').to.not.be.undefined;
        expect(header!.chunk.snapshotId).to.equal('snap-resume-ws');
        expect(header!.chunk.siteId).to.equal(TEST_SITE_ID_1);
      } finally {
        ws.close();
        await new Promise(resolve => setTimeout(resolve, 300));
      }
    });
  });

  describe('Connection tracking', () => {
    it('should track connected clients', async function () {
      // Allow any lingering connections from previous tests to fully close
      await new Promise(resolve => setTimeout(resolve, 300));
      const ws1 = await connectWs();
      const ws2 = await connectWs();

      try {
        // Handshake both with different site IDs
        await sendAndReceive(ws1, {
          type: 'handshake',
          databaseId: TEST_DATABASE_ID,
          siteId: TEST_SITE_ID_1,
          protocolVersion: PROTOCOL_VERSION,
        });
        await sendAndReceive(ws2, {
          type: 'handshake',
          databaseId: TEST_DATABASE_ID,
          siteId: TEST_SITE_ID_2,
          protocolVersion: PROTOCOL_VERSION,
        });

        // Check status
        const address = server.app.server.address();
        const port = typeof address === 'object' && address ? address.port : 3000;
        const response = await fetch(`http://127.0.0.1:${port}/sync/status`);
        const body = await response.json() as { data: { connectedClients: number } };

        expect(body.data.connectedClients).to.equal(2);
      } finally {
        ws1.close();
        ws2.close();
      }
    });
  });
});

