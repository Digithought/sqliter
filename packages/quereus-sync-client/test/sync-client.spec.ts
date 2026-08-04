import { expect } from 'chai';
import { SyncClient } from '../src/sync-client.js';
import type { SyncStatus, SyncEvent } from '../src/types.js';
import {
  generateSiteId,
  siteIdToBase64,
  SyncEventEmitterImpl,
  serializeChangeSet,
  serializeHLCForTransport,
  serializeSnapshotChunk,
  deserializeSnapshotCheckpoint,
  PROTOCOL_VERSION,
  SNAPSHOT_WIRE_FORMAT_VERSION,
  type SyncManager,
  type HLC,
  type ChangeSet,
  type ApplyResult,
  type Snapshot,
  type SnapshotChunk,
  type SnapshotCheckpoint,
  type SnapshotProgress,
  type SiteId,
  type BasisTableLifecycleRecord,
  type ClientMessage,
  type SerializedSnapshotChunk,
  type SerializedSnapshotCheckpoint,
} from '@quereus/sync';
import type { Database, LensDeploymentSnapshot } from '@quereus/quereus';

// ============================================================================
// Mock WebSocket
// ============================================================================

type WSListener = (event: { data: string }) => void;

class MockWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;

  readyState = MockWebSocket.CONNECTING;
  url: string;
  sentMessages: string[] = [];

  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: WSListener | null = null;

  constructor(url: string) {
    this.url = url;
    // Track instance for test access
    MockWebSocket.lastInstance = this;
    MockWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sentMessages.push(data);
  }

  close(): void {
    this.readyState = MockWebSocket.CLOSED;
    // Fire onclose asynchronously like real WebSocket
    if (this.onclose) {
      setTimeout(() => this.onclose?.(), 0);
    }
  }

  // Test helpers
  simulateOpen(): void {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.();
  }

  simulateMessage(data: object): void {
    this.onmessage?.({ data: JSON.stringify(data) });
  }

  simulateClose(): void {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.();
  }

  simulateError(): void {
    this.onerror?.();
  }

  getSentMessages(): ClientMessage[] {
    return this.sentMessages.map(m => JSON.parse(m));
  }

  // Static tracking
  static lastInstance: MockWebSocket | null = null;
  static instances: MockWebSocket[] = [];

  static reset(): void {
    MockWebSocket.lastInstance = null;
    MockWebSocket.instances = [];
  }
}

// Install mock WebSocket globally
function installMockWebSocket(): void {
  (globalThis as any).WebSocket = MockWebSocket as any;
}

function uninstallMockWebSocket(): void {
  delete (globalThis as any).WebSocket;
}

// ============================================================================
// Mock SyncManager
// ============================================================================

class MockSyncManager implements SyncManager {
  siteId = generateSiteId();
  getChangesSinceResult: ChangeSet[] = [];
  applyChangesResult: ApplyResult = { applied: 0, skipped: 0, conflicts: 0, transactions: 0 };
  peerSyncState: HLC | undefined = undefined;
  peerSentState: HLC | undefined = undefined;
  applyChangesCalls: ChangeSet[][] = [];
  updatePeerSyncStateCalls: { peerSiteId: SiteId; hlc: HLC }[] = [];
  updatePeerSentStateCalls: { peerSiteId: SiteId; hlc: HLC }[] = [];
  getChangesSinceCalls: { peerSiteId: SiteId; sinceHLC?: HLC }[] = [];
  /**
   * Stands in for the durable `sc:` records. A real map rather than a fixed
   * `[]` / `undefined`: a test can seed a checkpoint here to make this mock look
   * like a replica interrupted mid-bootstrap, and the get/list/clear methods
   * below then agree with each other the way the real manager's do.
   */
  checkpoints = new Map<string, SnapshotCheckpoint>();

  getSiteId(): SiteId {
    return this.siteId;
  }

  getCurrentHLC(): HLC {
    return { wallTime: BigInt(Date.now()), counter: 0, siteId: this.siteId, opSeq: 0 };
  }

  async getChangesSince(peerSiteId: SiteId, sinceHLC?: HLC): Promise<ChangeSet[]> {
    this.getChangesSinceCalls.push({ peerSiteId, sinceHLC });
    return this.getChangesSinceResult;
  }

  async applyChanges(changes: ChangeSet[]): Promise<ApplyResult> {
    this.applyChangesCalls.push(changes);
    return this.applyChangesResult;
  }

  async canDeltaSync(_peerSiteId: SiteId, _sinceHLC: HLC): Promise<boolean> {
    return true;
  }

  async getSnapshot(): Promise<Snapshot> {
    return {
      siteId: this.siteId,
      hlc: this.getCurrentHLC(),
      snapshotFormat: SNAPSHOT_WIRE_FORMAT_VERSION,
      tables: [],
      schemaMigrations: [],
      tombstones: [],
    };
  }

  async applySnapshot(_snapshot: Snapshot): Promise<void> {}

  async updatePeerSyncState(peerSiteId: SiteId, hlc: HLC): Promise<void> {
    this.updatePeerSyncStateCalls.push({ peerSiteId, hlc });
    // Mirror the durable store: a confirmed advance is what a later
    // getPeerSyncState / get_changes catch-up reads back.
    this.peerSyncState = hlc;
  }

  async getPeerSyncState(_peerSiteId: SiteId): Promise<HLC | undefined> {
    return this.peerSyncState;
  }

  async updatePeerSentState(peerSiteId: SiteId, hlc: HLC): Promise<void> {
    this.updatePeerSentStateCalls.push({ peerSiteId, hlc });
    this.peerSentState = hlc;
  }

  async getPeerSentState(_peerSiteId: SiteId): Promise<HLC | undefined> {
    return this.peerSentState;
  }

  async *getSnapshotStream(_chunkSize?: number): AsyncIterable<SnapshotChunk> {}

  /** Chunks actually consumed by applySnapshotStream, in consumption order. */
  appliedSnapshotChunks: SnapshotChunk[] = [];
  /** When set, applySnapshotStream throws before consuming anything — models the engine's pre-apply gates (wire-format mismatch, clock drift). */
  applySnapshotStreamError: Error | null = null;
  /** Monotonic createdAt for mock checkpoints, so "newest" is deterministic. */
  private checkpointSeq = 0;

  /**
   * Really drains the iterable — chunk ordering and abort assertions in the
   * specs are only meaningful because consumption is real, not vacuous.
   * Mirrors the real engine's checkpoint lifecycle: a checkpoint exists from
   * the header for the whole duration of the apply and is cleared only when
   * the footer lands, so an interrupted apply leaves one behind (the resume
   * marker) and a pre-apply gate failure leaves none.
   */
  async applySnapshotStream(
    chunks: AsyncIterable<SnapshotChunk>,
    onProgress?: (progress: SnapshotProgress) => void
  ): Promise<void> {
    if (this.applySnapshotStreamError) throw this.applySnapshotStreamError;

    let snapshotId = '';
    let totalTables = 0;
    let tablesProcessed = 0;
    let entriesProcessed = 0;
    let currentTable: string | undefined;

    for await (const chunk of chunks) {
      this.appliedSnapshotChunks.push(chunk);
      switch (chunk.type) {
        case 'header': {
          snapshotId = chunk.snapshotId;
          totalTables = chunk.tableCount;
          this.checkpoints.set(snapshotId, {
            snapshotId,
            siteId: chunk.siteId,
            hlc: chunk.hlc,
            lastTableIndex: 0,
            lastEntryIndex: 0,
            completedTables: [],
            entriesProcessed: 0,
            createdAt: ++this.checkpointSeq,
          });
          break;
        }
        case 'table-start': {
          currentTable = chunk.table;
          break;
        }
        case 'column-versions': {
          entriesProcessed += chunk.entries.length;
          onProgress?.({ snapshotId, tablesProcessed, totalTables, entriesProcessed, totalEntries: 0, currentTable });
          break;
        }
        case 'table-end': {
          tablesProcessed++;
          onProgress?.({ snapshotId, tablesProcessed, totalTables, entriesProcessed, totalEntries: 0, currentTable });
          break;
        }
        case 'footer': {
          this.checkpoints.delete(chunk.snapshotId);
          break;
        }
        default:
          break;
      }
    }
  }

  async getSnapshotCheckpoint(snapshotId: string): Promise<SnapshotCheckpoint | undefined> {
    return this.checkpoints.get(snapshotId);
  }

  async listSnapshotCheckpoints(): Promise<SnapshotCheckpoint[]> {
    return [...this.checkpoints.values()];
  }

  async clearSnapshotCheckpoint(snapshotId: string): Promise<void> {
    this.checkpoints.delete(snapshotId);
  }

  async pruneTombstones(): Promise<number> {
    return 0;
  }

  async pruneQuarantine(): Promise<number> {
    return 0;
  }

  async repairChangeLog(): Promise<number> {
    return 0;
  }

  async drainHeldChanges(_schema?: string, _table?: string): Promise<number> {
    return 0;
  }

  async recordLensDeployment(
    _db: Database,
    _logicalSchemaName: string,
    _snapshot: LensDeploymentSnapshot,
  ): Promise<void> {}

  async getBasisTableLifecycle(): Promise<BasisTableLifecycleRecord[]> {
    return [];
  }

  async evictExpiredBasisTables(_now?: number): Promise<number> {
    return 0;
  }

  getUnknownTableStats(): { ignored: number; quarantined: number; forwarded: number; relayed: number; byTable: Map<string, number> } {
    return { ignored: 0, quarantined: 0, forwarded: 0, relayed: 0, byTable: new Map() };
  }

  async *resumeSnapshotStream(_checkpoint: SnapshotCheckpoint): AsyncIterable<SnapshotChunk> {}
}

// ============================================================================
// Helper to create a connected client
// ============================================================================

// Clients created via createClient(); disconnected in afterEach so leaked
// reconnect timers (autoReconnect: true keeps firing connect() on a timer)
// don't pollute later tests' assertions.
const activeClients: SyncClient[] = [];

function createClient(opts?: {
  syncManager?: MockSyncManager;
  syncEvents?: SyncEventEmitterImpl;
  autoReconnect?: boolean;
  bootstrapOnEmpty?: boolean;
  snapshotChunkTimeoutMs?: number;
  readOnly?: boolean;
  onSnapshotProgress?: (progress: SnapshotProgress) => void;
  statusChanges?: SyncStatus[];
  syncEventsLog?: SyncEvent[];
  errors?: Error[];
}) {
  const syncManager = opts?.syncManager ?? new MockSyncManager();
  const syncEvents = opts?.syncEvents ?? new SyncEventEmitterImpl();
  const statusChanges = opts?.statusChanges ?? [];
  const syncEventsLog = opts?.syncEventsLog ?? [];
  const errors = opts?.errors ?? [];

  const client = new SyncClient({
    syncManager,
    syncEvents,
    autoReconnect: opts?.autoReconnect ?? false,
    // Production default is TRUE; the harness defaults to false because the
    // legacy incremental-path tests all use an empty MockSyncManager, which
    // would otherwise auto-bootstrap on every connect. The bootstrap suite
    // opts in explicitly (and one test covers the default via a raw client).
    bootstrapOnEmpty: opts?.bootstrapOnEmpty ?? false,
    snapshotChunkTimeoutMs: opts?.snapshotChunkTimeoutMs,
    readOnly: opts?.readOnly,
    onSnapshotProgress: opts?.onSnapshotProgress,
    reconnectDelayMs: 100,
    maxReconnectDelayMs: 1000,
    localChangeDebounceMs: 10,
    onStatusChange: (s) => statusChanges.push(s),
    onSyncEvent: (e) => syncEventsLog.push(e),
    onError: (e) => errors.push(e),
  });

  activeClients.push(client);

  return { client, syncManager, syncEvents, statusChanges, syncEventsLog, errors };
}

/** Send a handshake_ack so connect() resolves. Must be called after simulateOpen(). */
function simulateHandshakeAck(ws: MockWebSocket): void {
  ws.simulateMessage({
    type: 'handshake_ack',
    serverSiteId: siteIdToBase64(generateSiteId()),
    connectionId: 'conn-123',
    protocolVersion: PROTOCOL_VERSION,
  });
}

/** Connect a client and simulate the WebSocket opening + handshake ack. */
async function connectAndHandshake(
  client: SyncClient,
  serverSiteId?: SiteId,
): Promise<MockWebSocket> {
  const connectPromise = client.connect('ws://localhost:8080/sync', 'test-db');
  const ws = MockWebSocket.lastInstance!;
  ws.simulateOpen();

  // Simulate handshake ack BEFORE awaiting Ã¢â‚¬â€ connect() waits for handshake_ack
  const sId = serverSiteId ?? generateSiteId();
  ws.simulateMessage({
    type: 'handshake_ack',
    serverSiteId: siteIdToBase64(sId),
    connectionId: 'conn-123',
    protocolVersion: PROTOCOL_VERSION,
  });

  await connectPromise;

  // Let async handlers settle
  await new Promise(r => setTimeout(r, 10));
  return ws;
}

describe('SyncClient', () => {
  beforeEach(() => {
    activeClients.length = 0;
    MockWebSocket.reset();
    installMockWebSocket();
  });

  afterEach(async () => {
    // Disconnect any client the test created to stop its reconnect/debounce
    // timers before the next test runs.
    for (const c of activeClients) {
      await c.disconnect();
    }
    activeClients.length = 0;
    uninstallMockWebSocket();
  });

  // ==========================================================================
  // Constructor
  // ==========================================================================

  describe('constructor', () => {
    it('should create a SyncClient with required options', () => {
      const syncManager = new MockSyncManager();
      const syncEvents = new SyncEventEmitterImpl();

      const client = new SyncClient({ syncManager, syncEvents });

      expect(client).to.be.instanceOf(SyncClient);
      expect(client.status).to.deep.equal({ status: 'disconnected' });
      expect(client.isConnected).to.be.false;
      expect(client.isSynced).to.be.false;
    });

    it('should accept optional configuration', () => {
      const { client } = createClient();
      expect(client).to.be.instanceOf(SyncClient);
    });
  });

  // ==========================================================================
  // Connection
  // ==========================================================================

  describe('connect', () => {
    it('should create a WebSocket and transition to connecting', async () => {
      const { client, statusChanges } = createClient();
      const connectPromise = client.connect('ws://localhost:8080/sync', 'test-db');

      expect(MockWebSocket.lastInstance).to.not.be.null;
      expect(statusChanges.some(s => s.status === 'connecting')).to.be.true;

      // Simulate open + handshake_ack to resolve promise
      MockWebSocket.lastInstance!.simulateOpen();
      simulateHandshakeAck(MockWebSocket.lastInstance!);
      await connectPromise;
    });

    it('should transition to syncing after WebSocket opens', async () => {
      const { client, statusChanges } = createClient();
      const connectPromise = client.connect('ws://localhost:8080/sync', 'test-db');
      MockWebSocket.lastInstance!.simulateOpen();
      simulateHandshakeAck(MockWebSocket.lastInstance!);
      await connectPromise;

      expect(statusChanges.some(s => s.status === 'syncing')).to.be.true;
    });

    it('should send handshake message on open', async () => {
      const { client, syncManager } = createClient();
      const connectPromise = client.connect('ws://localhost:8080/sync', 'test-db');
      const ws = MockWebSocket.lastInstance!;
      ws.simulateOpen();
      simulateHandshakeAck(ws);
      await connectPromise;

      const messages = ws.getSentMessages();
      expect(messages.length).to.be.greaterThanOrEqual(1);
      const handshake = messages.find(m => m.type === 'handshake');
      expect(handshake).to.exist;
      expect(handshake!.databaseId).to.equal('test-db');
      expect(handshake!.siteId).to.equal(siteIdToBase64(syncManager.getSiteId()));
      // The client stamps its wire version so the coordinator can gate on it.
      expect((handshake as { protocolVersion?: number }).protocolVersion).to.equal(PROTOCOL_VERSION);
    });

    it('should not include token in URL, sending it in the handshake body instead', async () => {
      const { client } = createClient();
      const connectPromise = client.connect('ws://localhost:8080/sync', 'test-db', 'my-token');
      const ws = MockWebSocket.lastInstance!;
      expect(ws.url).to.not.include('token=my-token');
      ws.simulateOpen();
      simulateHandshakeAck(ws);
      await connectPromise;

      const handshake = ws.getSentMessages().find(m => m.type === 'handshake');
      expect((handshake as { token?: string })?.token).to.equal('my-token');
    });

    it('should reject on WebSocket error during first attempt', async () => {
      const { client } = createClient();
      const connectPromise = client.connect('ws://localhost:8080/sync', 'test-db');
      const ws = MockWebSocket.lastInstance!;
      ws.simulateError();

      try {
        await connectPromise;
        expect.fail('should have rejected');
      } catch (err: any) {
        expect(err.message).to.include('WebSocket connection failed');
      }
    });

    it('should close existing connection before creating new one', async () => {
      const { client } = createClient();

      // First connection
      const p1 = client.connect('ws://localhost:8080/sync', 'db1');
      const ws1 = MockWebSocket.lastInstance!;
      ws1.simulateOpen();
      simulateHandshakeAck(ws1);
      await p1;

      // Second connection
      const p2 = client.connect('ws://localhost:8080/sync', 'db2');
      expect(ws1.readyState).to.equal(MockWebSocket.CLOSED);
      const ws2 = MockWebSocket.lastInstance!;
      ws2.simulateOpen();
      simulateHandshakeAck(ws2);
      await p2;
    });
  });

  // ==========================================================================
  // Disconnect
  // ==========================================================================

  describe('disconnect', () => {
    it('should disconnect cleanly when not connected', async () => {
      const { client } = createClient();
      await client.disconnect();
      expect(client.status).to.deep.equal({ status: 'disconnected' });
    });

    it('should close WebSocket and set status to disconnected', async () => {
      const { client } = createClient();
      const ws = await connectAndHandshake(client);

      await client.disconnect();

      expect(ws.readyState).to.equal(MockWebSocket.CLOSED);
      expect(client.status.status).to.equal('disconnected');
      expect(client.isConnected).to.be.false;
    });

    it('should emit disconnected status change', async () => {
      const { client, statusChanges } = createClient();
      await connectAndHandshake(client);
      statusChanges.length = 0; // Clear previous

      await client.disconnect();

      expect(statusChanges.some(s => s.status === 'disconnected')).to.be.true;
    });

    it('should emit sync event on manual disconnect', async () => {
      const { client, syncEventsLog } = createClient();
      await connectAndHandshake(client);
      syncEventsLog.length = 0;

      await client.disconnect();

      expect(syncEventsLog.some(e => e.message.includes('manual'))).to.be.true;
    });
  });

  // ==========================================================================
  // Status tracking
  // ==========================================================================

  describe('status tracking', () => {
    it('should report disconnected initially', () => {
      const { client } = createClient();
      expect(client.status.status).to.equal('disconnected');
    });

    it('should report isConnected when WebSocket is open', async () => {
      const { client } = createClient();
      await connectAndHandshake(client);
      expect(client.isConnected).to.be.true;
    });

    it('should report isSynced after receiving changes', async () => {
      const { client } = createClient();
      const ws = await connectAndHandshake(client);

      // Simulate receiving changes (empty set triggers synced status)
      ws.simulateMessage({ type: 'changes', changeSets: [] });
      await new Promise(r => setTimeout(r, 10));

      expect(client.isSynced).to.be.true;
    });
  });

  // ==========================================================================
  // Message handling
  // ==========================================================================

  describe('message handling', () => {
    it('should request changes from server after handshake ack', async () => {
      const { client } = createClient();
      const ws = await connectAndHandshake(client);

      const messages = ws.getSentMessages();
      const getChanges = messages.find(m => m.type === 'get_changes');
      expect(getChanges).to.exist;
    });

    it('should apply remote changes via syncManager', async () => {
      const syncManager = new MockSyncManager();
      syncManager.applyChangesResult = { applied: 2, skipped: 0, conflicts: 0, transactions: 1 };
      const { client } = createClient({ syncManager });
      const ws = await connectAndHandshake(client);

      // Create a serialized change set
      const hlc: HLC = { wallTime: BigInt(Date.now()), counter: 1, siteId: generateSiteId(), opSeq: 0 };
      const cs: ChangeSet = {
        siteId: generateSiteId(),
        transactionId: 'tx-1',
        hlc,
        changes: [{ type: 'column', schema: 'main', table: 'users', pk: [1], column: 'name', value: 'Bob', hlc }],
        schemaMigrations: [],
      };
      const serialized = serializeChangeSet(cs);

      ws.simulateMessage({ type: 'changes', changeSets: [serialized] });
      await new Promise(r => setTimeout(r, 20));

      expect(syncManager.applyChangesCalls.length).to.be.greaterThanOrEqual(1);
    });

    it('applies push_changes but does not advance the received watermark', async () => {
      // push_changes is a fire-and-forget broadcast — it must be applied
      // (idempotently) but must NOT move the received watermark, so a missed
      // earlier broadcast is still recoverable on the next catch-up.
      const syncManager = new MockSyncManager();
      syncManager.applyChangesResult = { applied: 1, skipped: 0, conflicts: 0, transactions: 1 };
      const { client } = createClient({ syncManager });
      const ws = await connectAndHandshake(client);
      syncManager.updatePeerSyncStateCalls.length = 0;

      const hlc: HLC = { wallTime: BigInt(Date.now()), counter: 1, siteId: generateSiteId(), opSeq: 0 };
      const cs: ChangeSet = {
        siteId: generateSiteId(),
        transactionId: 'tx-push',
        hlc,
        changes: [{ type: 'delete', schema: 'main', table: 'users', pk: [5], hlc }],
        schemaMigrations: [],
      };

      ws.simulateMessage({ type: 'push_changes', changeSets: [serializeChangeSet(cs)] });
      await new Promise(r => setTimeout(r, 20));

      // Applied…
      expect(syncManager.applyChangesCalls.length).to.be.greaterThanOrEqual(1);
      // …but watermark unmoved.
      expect(syncManager.updatePeerSyncStateCalls.length).to.equal(0);
    });

    it('should call onRemoteChanges callback', async () => {
      const syncManager = new MockSyncManager();
      syncManager.applyChangesResult = { applied: 1, skipped: 0, conflicts: 0, transactions: 1 };
      let remoteResult: ApplyResult | null = null;
      const { client } = createClient({ syncManager });
      // Patch onRemoteChanges
      (client as any).options.onRemoteChanges = (result: ApplyResult) => { remoteResult = result; };

      const ws = await connectAndHandshake(client);

      ws.simulateMessage({ type: 'changes', changeSets: [] });
      await new Promise(r => setTimeout(r, 10));

      expect(remoteResult).to.not.be.null;
    });

    it('should handle apply_result and emit info event', async () => {
      const { client, syncEventsLog } = createClient();
      const ws = await connectAndHandshake(client);
      syncEventsLog.length = 0;

      ws.simulateMessage({ type: 'apply_result', applied: 5 });
      await new Promise(r => setTimeout(r, 10));

      expect(syncEventsLog.some(e => e.type === 'info' && e.message.includes('5'))).to.be.true;
    });

    it('should handle error messages from server', async () => {
      const { client, errors, syncEventsLog } = createClient();
      const ws = await connectAndHandshake(client);
      errors.length = 0;
      syncEventsLog.length = 0;

      ws.simulateMessage({ type: 'error', code: 'AUTH_FAILED', message: 'Invalid token' });
      await new Promise(r => setTimeout(r, 10));

      expect(errors.length).to.be.greaterThanOrEqual(1);
      expect(errors[0].message).to.include('Invalid token');
      expect(syncEventsLog.some(e => e.type === 'error')).to.be.true;
    });

    it('should handle pong messages without error', async () => {
      const { client } = createClient();
      const ws = await connectAndHandshake(client);

      // Should not throw
      ws.simulateMessage({ type: 'pong' });
      await new Promise(r => setTimeout(r, 10));
    });

    it('should warn on unknown message types', async () => {
      const { client } = createClient();
      const ws = await connectAndHandshake(client);

      // Should not throw
      ws.simulateMessage({ type: 'unknown_type' });
      await new Promise(r => setTimeout(r, 10));
    });
  });

  // ==========================================================================
  // Received watermark: broadcast vs ordered reply
  // ==========================================================================

  describe('received watermark advancement', () => {
    /** A one-column ChangeSet stamped with the given HLC. */
    function changeSet(site: SiteId, txId: string, hlc: HLC): ChangeSet {
      return {
        siteId: site,
        transactionId: txId,
        hlc,
        changes: [{ type: 'column', schema: 'main', table: 'items', pk: [1], column: 'n', value: txId, hlc }],
        schemaMigrations: [],
      };
    }

    it('advances the watermark on an ordered `changes` reply', async () => {
      const syncManager = new MockSyncManager();
      syncManager.applyChangesResult = { applied: 1, skipped: 0, conflicts: 0, transactions: 1 };
      const { client } = createClient({ syncManager });
      const ws = await connectAndHandshake(client);
      syncManager.updatePeerSyncStateCalls.length = 0;

      const site = generateSiteId();
      const hlc5: HLC = { wallTime: 5000n, counter: 1, siteId: site, opSeq: 0 };
      ws.simulateMessage({ type: 'changes', changeSets: [serializeChangeSet(changeSet(site, 'tx5', hlc5))] });
      await new Promise(r => setTimeout(r, 20));

      expect(syncManager.applyChangesCalls.length).to.be.greaterThanOrEqual(1);
      expect(syncManager.updatePeerSyncStateCalls.length).to.equal(1);
      expect(syncManager.updatePeerSyncStateCalls[0].hlc).to.deep.equal(hlc5);
    });

    it('does not lose a change when a later broadcast arrives before the ordered reply', async () => {
      // Reproduces the fire-and-forget change-loss bug: a broadcast at HLC 6 is
      // received, but an earlier broadcast at HLC 5 was dropped. If HLC 6 were
      // allowed to advance the watermark, the next get_changes would start at 6
      // and HLC 5 would be lost forever. With the fix, the broadcast leaves the
      // watermark at 5 (set by the ordered reply), so HLC 5 stays fetchable.
      const syncManager = new MockSyncManager();
      syncManager.applyChangesResult = { applied: 1, skipped: 0, conflicts: 0, transactions: 1 };
      const { client } = createClient({ syncManager });
      const ws = await connectAndHandshake(client);
      syncManager.updatePeerSyncStateCalls.length = 0;
      ws.sentMessages.length = 0;

      const site = generateSiteId();
      const hlc5: HLC = { wallTime: 5000n, counter: 1, siteId: site, opSeq: 0 };
      const hlc6: HLC = { wallTime: 6000n, counter: 1, siteId: site, opSeq: 0 };

      // A delivered broadcast at HLC 6 (an earlier HLC 5 broadcast was dropped).
      ws.simulateMessage({ type: 'push_changes', changeSets: [serializeChangeSet(changeSet(site, 'tx6', hlc6))] });
      await new Promise(r => setTimeout(r, 20));

      // Applied, but the watermark must NOT jump to 6.
      expect(syncManager.applyChangesCalls.length).to.be.greaterThanOrEqual(1);
      expect(syncManager.updatePeerSyncStateCalls.length).to.equal(0);

      // The ordered catch-up reply carries HLC 5 and advances the watermark to 5.
      ws.simulateMessage({ type: 'changes', changeSets: [serializeChangeSet(changeSet(site, 'tx5', hlc5))] });
      await new Promise(r => setTimeout(r, 20));
      expect(syncManager.updatePeerSyncStateCalls.length).to.equal(1);
      expect(syncManager.updatePeerSyncStateCalls[0].hlc).to.deep.equal(hlc5);

      // A subsequent catch-up requests get_changes sinceHLC=5 (not 6): the
      // dropped HLC 5 is still within reach and will be redelivered.
      ws.sentMessages.length = 0;
      await (client as any).requestChangesFromServer();
      const getChanges = ws.getSentMessages().find(m => m.type === 'get_changes') as { sinceHLC?: string };
      expect(getChanges, 'a get_changes should be sent').to.exist;
      // sinceHLC is the transport-serialized watermark. It must equal HLC 5, NOT
      // the broadcast's HLC 6 — proving the broadcast did not advance the watermark.
      expect(getChanges.sinceHLC).to.equal(serializeHLCForTransport(hlc5));
      expect(getChanges.sinceHLC).to.not.equal(serializeHLCForTransport(hlc6));
    });
  });

  // ==========================================================================
  // Local change pushing
  // ==========================================================================

  describe('local change pushing', () => {
    it('should subscribe to local changes after handshake', async () => {
      const syncEvents = new SyncEventEmitterImpl();
      const syncManager = new MockSyncManager();
      const { client } = createClient({ syncManager, syncEvents });
      await connectAndHandshake(client);

      // Trigger a local change
      const hlc: HLC = { wallTime: BigInt(Date.now()), counter: 1, siteId: syncManager.getSiteId(), opSeq: 0 };
      syncManager.getChangesSinceResult = [{
        siteId: syncManager.getSiteId(),
        transactionId: 'tx-local',
        hlc,
        changes: [{ type: 'column', schema: 'main', table: 'items', pk: [1], column: 'name', value: 'X', hlc }],
        schemaMigrations: [],
      }];

      // Emit local change event
      (syncEvents as any).localChangeListeners.forEach((fn: any) => fn({ table: 'items' }));

      // Wait for debounce
      await new Promise(r => setTimeout(r, 50));

      // Should have sent apply_changes
      const ws = MockWebSocket.lastInstance!;
      const messages = ws.getSentMessages();
      const applyMsg = messages.find(m => m.type === 'apply_changes');
      expect(applyMsg).to.exist;
    });

    it('should not push changes when disconnected', async () => {
      const syncEvents = new SyncEventEmitterImpl();
      const syncManager = new MockSyncManager();
      const { client } = createClient({ syncManager, syncEvents });
      await connectAndHandshake(client);
      await client.disconnect();

      // Trigger a local change after disconnect
      syncManager.getChangesSinceResult = [{
        siteId: syncManager.getSiteId(),
        transactionId: 'tx-offline',
        hlc: { wallTime: BigInt(Date.now()), counter: 1, siteId: syncManager.getSiteId(), opSeq: 0 },
        changes: [],
        schemaMigrations: [],
      }];

      // The listener should have been unsubscribed
      // No error should occur
    });

    it('should not send when there are no changes', async () => {
      const syncEvents = new SyncEventEmitterImpl();
      const syncManager = new MockSyncManager();
      syncManager.getChangesSinceResult = []; // No changes
      const { client } = createClient({ syncManager, syncEvents });
      const ws = await connectAndHandshake(client);

      const msgCountBefore = ws.sentMessages.length;

      // Emit local change
      (syncEvents as any).localChangeListeners.forEach((fn: any) => fn({ table: 'items' }));
      await new Promise(r => setTimeout(r, 50));

      // No new apply_changes should have been sent (only handshake + get_changes)
      const newMessages = ws.getSentMessages().slice(msgCountBefore);
      const applyMsg = newMessages.find(m => m.type === 'apply_changes');
      expect(applyMsg).to.be.undefined;
    });
  });

  // ==========================================================================
  // Reconnection
  // ==========================================================================

  describe('reconnection', () => {
    it('should not reconnect when autoReconnect is false', async () => {
      const { client } = createClient({ autoReconnect: false });
      const connectPromise = client.connect('ws://localhost:8080/sync', 'test-db');
      const ws = MockWebSocket.lastInstance!;
      ws.simulateOpen();
      simulateHandshakeAck(ws);
      await connectPromise;

      const instanceCount = MockWebSocket.instances.length;
      ws.simulateClose();
      await new Promise(r => setTimeout(r, 200));

      // No new WebSocket should have been created
      expect(MockWebSocket.instances.length).to.equal(instanceCount);
    });

    it('should not reconnect after intentional disconnect', async () => {
      const { client } = createClient({ autoReconnect: true });
      const connectPromise = client.connect('ws://localhost:8080/sync', 'test-db');
      const ws = MockWebSocket.lastInstance!;
      ws.simulateOpen();
      simulateHandshakeAck(ws);
      await connectPromise;

      await client.disconnect();
      const instanceCount = MockWebSocket.instances.length;

      await new Promise(r => setTimeout(r, 200));
      expect(MockWebSocket.instances.length).to.equal(instanceCount);
    });

    it('should attempt reconnect with autoReconnect enabled', async () => {
      const { client } = createClient({ autoReconnect: true });
      const connectPromise = client.connect('ws://localhost:8080/sync', 'test-db');
      const ws = MockWebSocket.lastInstance!;
      ws.simulateOpen();
      simulateHandshakeAck(ws);
      await connectPromise;

      const instanceCount = MockWebSocket.instances.length;
      ws.simulateClose();

      // Wait for reconnect timer (100ms base delay)
      await new Promise(r => setTimeout(r, 200));

      // A new WebSocket should have been created
      expect(MockWebSocket.instances.length).to.be.greaterThan(instanceCount);
    });

    it('should keep session and reconnect alive after a transient server error', async () => {
      const { client } = createClient({ autoReconnect: true });
      const ws = await connectAndHandshake(client);

      // A per-request (transient) error — no `fatal` flag, code not in the
      // fatal fallback set.
      ws.simulateMessage({ type: 'error', code: 'APPLY_CHANGES_ERROR', message: 'one apply failed' });
      await new Promise(r => setTimeout(r, 10));

      // Session survives: not flagged for shutdown, socket still open.
      expect((client as any).intentionalDisconnect).to.be.false;
      expect((client as any).stopReconnect).to.be.false;
      expect(client.isConnected).to.be.true;

      // And a subsequent drop still triggers a reconnect.
      const instanceCount = MockWebSocket.instances.length;
      ws.simulateClose();
      await new Promise(r => setTimeout(r, 200));
      expect(MockWebSocket.instances.length).to.be.greaterThan(instanceCount);
    });

    it('should stop reconnect after a fatal server error', async () => {
      const { client } = createClient({ autoReconnect: true });
      const ws = await connectAndHandshake(client);

      ws.simulateMessage({ type: 'error', code: 'AUTH_FAILED', message: 'bad token', fatal: true });
      await new Promise(r => setTimeout(r, 10));

      expect((client as any).stopReconnect).to.be.true;
      // Fatal server error must NOT be conflated with a manual disconnect.
      expect((client as any).intentionalDisconnect).to.be.false;
      expect(client.status.status).to.equal('error');

      // No reconnect should be scheduled even after the socket closes.
      const instanceCount = MockWebSocket.instances.length;
      ws.simulateClose();
      await new Promise(r => setTimeout(r, 200));
      expect(MockWebSocket.instances.length).to.equal(instanceCount);
    });

    it('should treat known fatal codes as fatal even without the fatal flag (legacy server)', async () => {
      const { client } = createClient({ autoReconnect: true });
      const ws = await connectAndHandshake(client);

      // Legacy coordinator: fatal code, but no `fatal` field on the message.
      ws.simulateMessage({ type: 'error', code: 'AUTH_FAILED', message: 'bad token' });
      await new Promise(r => setTimeout(r, 10));

      expect((client as any).stopReconnect).to.be.true;

      const instanceCount = MockWebSocket.instances.length;
      ws.simulateClose();
      await new Promise(r => setTimeout(r, 200));
      expect(MockWebSocket.instances.length).to.equal(instanceCount);
    });

    it('should not schedule a reconnect from a stale socket after connect() replaced it', async () => {
      const { client } = createClient({ autoReconnect: true });
      const ws1 = await connectAndHandshake(client);

      // Replace the socket with a fresh connect(); this detaches ws1's handlers.
      const p2 = client.connect('ws://localhost:8080/sync', 'test-db');
      const ws2 = MockWebSocket.lastInstance!;
      ws2.simulateOpen();
      simulateHandshakeAck(ws2);
      await p2;

      const instanceCount = MockWebSocket.instances.length;
      // Fire the dead socket's onclose — it must be detached and a no-op.
      ws1.simulateClose();
      await new Promise(r => setTimeout(r, 200));
      expect(MockWebSocket.instances.length).to.equal(instanceCount);
    });
  });

  // ==========================================================================
  // Protocol version handshake
  // ==========================================================================

  describe('protocol version handshake', () => {
    it('proceeds normally when the ack version matches', async () => {
      const { client } = createClient({ syncManager: new MockSyncManager() });
      const ws = await connectAndHandshake(client);

      expect(client.isConnected).to.be.true;
      expect((client as any).stopReconnect).to.be.false;
      // Reached the post-ack flow (requested changes from the server).
      const getChanges = ws.getSentMessages().find(m => m.type === 'get_changes');
      expect(getChanges).to.exist;
    });

    it('rejects a handshake_ack whose protocolVersion mismatches (fatal, no reconnect)', async () => {
      const { client, errors } = createClient({ autoReconnect: true });
      const connectPromise = client.connect('ws://localhost:8080/sync', 'test-db');
      const ws = MockWebSocket.lastInstance!;
      ws.simulateOpen();
      ws.simulateMessage({
        type: 'handshake_ack',
        serverSiteId: siteIdToBase64(generateSiteId()),
        connectionId: 'conn-123',
        protocolVersion: PROTOCOL_VERSION + 1,
      });

      // connect() rejects with a version-mismatch error.
      let rejected: Error | null = null;
      try { await connectPromise; } catch (e) { rejected = e as Error; }
      expect(rejected, 'connect() should reject on version mismatch').to.not.be.null;
      expect(rejected!.message).to.match(/protocol version mismatch/i);

      // Fatal: lasting error status + stop-reconnect, but NOT a manual disconnect.
      expect(client.status.status).to.equal('error');
      expect((client as any).stopReconnect).to.be.true;
      expect((client as any).intentionalDisconnect).to.be.false;
      expect(errors.some(e => /protocol version mismatch/i.test(e.message))).to.be.true;

      // Auto-reconnect must not resume, even after the socket closes.
      const instanceCount = MockWebSocket.instances.length;
      ws.simulateClose();
      await new Promise(r => setTimeout(r, 200));
      expect(MockWebSocket.instances.length).to.equal(instanceCount);
    });

    it('rejects a handshake_ack with no protocolVersion (pre-versioning coordinator)', async () => {
      const { client } = createClient({ autoReconnect: true });
      const connectPromise = client.connect('ws://localhost:8080/sync', 'test-db');
      const ws = MockWebSocket.lastInstance!;
      ws.simulateOpen();
      // Old coordinator: the ack carries no protocolVersion at all.
      ws.simulateMessage({
        type: 'handshake_ack',
        serverSiteId: siteIdToBase64(generateSiteId()),
        connectionId: 'conn-123',
      });

      let rejected: Error | null = null;
      try { await connectPromise; } catch (e) { rejected = e as Error; }
      expect(rejected, 'connect() should reject when the ack has no version').to.not.be.null;
      expect((client as any).stopReconnect).to.be.true;
      expect(client.status.status).to.equal('error');

      const instanceCount = MockWebSocket.instances.length;
      ws.simulateClose();
      await new Promise(r => setTimeout(r, 200));
      expect(MockWebSocket.instances.length).to.equal(instanceCount);
    });
  });

  // ==========================================================================
  // send() failure handling
  // ==========================================================================

  describe('send failure', () => {
    it('should not register a pending watermark when the send throws', async () => {
      const syncEvents = new SyncEventEmitterImpl();
      const syncManager = new MockSyncManager();
      const { client, syncEventsLog } = createClient({ syncManager, syncEvents });
      const ws = await connectAndHandshake(client);

      // Queue a local change to push.
      const hlc: HLC = { wallTime: BigInt(Date.now()), counter: 1, siteId: syncManager.getSiteId(), opSeq: 0 };
      syncManager.getChangesSinceResult = [{
        siteId: syncManager.getSiteId(),
        transactionId: 'tx-local',
        hlc,
        changes: [{ type: 'column', schema: 'main', table: 'items', pk: [1], column: 'name', value: 'X', hlc }],
        schemaMigrations: [],
      }];

      // Make the underlying socket send throw.
      ws.send = () => { throw new Error('socket write failed'); };
      syncEventsLog.length = 0;

      // Trigger the debounced push.
      (syncEvents as any).localChangeListeners.forEach((fn: any) => fn({ table: 'items' }));
      await new Promise(r => setTimeout(r, 50));

      // Failed send must not register a pending watermark (nothing to promote).
      expect((client as any).pendingSentHLCs.size).to.equal(0);
      // And the failure is surfaced, not swallowed.
      expect(syncEventsLog.some(e => e.type === 'error' && e.message.includes('Failed to send'))).to.be.true;
    });
  });

  // ==========================================================================
  // apply_result correlation (requestId)
  // ==========================================================================

  describe('apply_result correlation', () => {
    /** A one-column ChangeSet stamped with the given HLC. */
    function changeSet(site: SiteId, txId: string, hlc: HLC): ChangeSet {
      return {
        siteId: site,
        transactionId: txId,
        hlc,
        changes: [{ type: 'column', schema: 'main', table: 'items', pk: [1], column: 'n', value: txId, hlc }],
        schemaMigrations: [],
      };
    }

    it('stamps each apply_changes push with a monotonic requestId', async () => {
      const syncManager = new MockSyncManager();
      const { client } = createClient({ syncManager });
      const ws = await connectAndHandshake(client);
      ws.sentMessages.length = 0;

      const site = syncManager.getSiteId();
      syncManager.getChangesSinceResult = [changeSet(site, 'tx1', { wallTime: 1000n, counter: 1, siteId: site, opSeq: 0 })];
      await (client as any).pushLocalChanges();
      syncManager.getChangesSinceResult = [changeSet(site, 'tx2', { wallTime: 2000n, counter: 1, siteId: site, opSeq: 0 })];
      await (client as any).pushLocalChanges();

      const pushes = ws.getSentMessages().filter(m => m.type === 'apply_changes') as Array<{ requestId?: string }>;
      expect(pushes.map(p => p.requestId)).to.deep.equal(['apply-1', 'apply-2']);
    });

    it('advances lastSentHLC only for the matching apply_result requestId', async () => {
      const syncManager = new MockSyncManager();
      const { client } = createClient({ syncManager });
      const ws = await connectAndHandshake(client);
      ws.sentMessages.length = 0;

      const site = syncManager.getSiteId();
      const hlc: HLC = { wallTime: 1000n, counter: 1, siteId: site, opSeq: 0 };
      syncManager.getChangesSinceResult = [changeSet(site, 'tx1', hlc)];
      await (client as any).pushLocalChanges();

      const push = ws.getSentMessages().find(m => m.type === 'apply_changes') as { requestId?: string };
      expect(push.requestId).to.be.a('string');
      // Pending until acked — nothing promoted yet.
      expect((client as any).lastSentHLC).to.be.null;
      expect((client as any).pendingSentHLCs.size).to.equal(1);

      // A non-matching ack (stale / duplicate / unknown push) must NOT promote.
      ws.simulateMessage({ type: 'apply_result', requestId: 'apply-999', applied: 0 });
      await new Promise(r => setTimeout(r, 5));
      expect((client as any).lastSentHLC).to.be.null;
      expect((client as any).pendingSentHLCs.size).to.equal(1);

      // The matching ack promotes exactly once and clears the pending entry.
      ws.simulateMessage({ type: 'apply_result', requestId: push.requestId, applied: 1 });
      await new Promise(r => setTimeout(r, 5));
      expect((client as any).lastSentHLC).to.deep.equal(hlc);
      expect((client as any).pendingSentHLCs.size).to.equal(0);
    });

    it('does not regress lastSentHLC on an out-of-order or duplicate apply_result', async () => {
      const syncManager = new MockSyncManager();
      const { client } = createClient({ syncManager });
      const ws = await connectAndHandshake(client);
      ws.sentMessages.length = 0;

      const site = syncManager.getSiteId();
      const hlc1: HLC = { wallTime: 1000n, counter: 1, siteId: site, opSeq: 0 };
      const hlc2: HLC = { wallTime: 2000n, counter: 1, siteId: site, opSeq: 0 };

      // Two pushes in flight (second re-sends a superset, as delta sync does
      // when the first has not yet been acked).
      syncManager.getChangesSinceResult = [changeSet(site, 'tx1', hlc1)];
      await (client as any).pushLocalChanges();
      syncManager.getChangesSinceResult = [changeSet(site, 'tx1', hlc1), changeSet(site, 'tx2', hlc2)];
      await (client as any).pushLocalChanges();

      const pushes = ws.getSentMessages().filter(m => m.type === 'apply_changes') as Array<{ requestId?: string }>;
      const [id1, id2] = [pushes[0].requestId!, pushes[1].requestId!];
      expect(id1).to.not.equal(id2);

      // Ack the newer push first.
      ws.simulateMessage({ type: 'apply_result', requestId: id2, applied: 2 });
      await new Promise(r => setTimeout(r, 5));
      expect((client as any).lastSentHLC).to.deep.equal(hlc2);

      // The older push's ack arrives late — must NOT drag the watermark back.
      ws.simulateMessage({ type: 'apply_result', requestId: id1, applied: 1 });
      await new Promise(r => setTimeout(r, 5));
      expect((client as any).lastSentHLC).to.deep.equal(hlc2);

      // A duplicate of the newer ack is also inert.
      ws.simulateMessage({ type: 'apply_result', requestId: id2, applied: 2 });
      await new Promise(r => setTimeout(r, 5));
      expect((client as any).lastSentHLC).to.deep.equal(hlc2);
    });

    it('relays a peer request as an apply_changes with no requestId, whose ack never promotes', async () => {
      const syncManager = new MockSyncManager();
      const { client } = createClient({ syncManager });
      const ws = await connectAndHandshake(client);
      ws.sentMessages.length = 0;

      // A peer-relay push: the server relays another peer's request_changes.
      // The changes carry an HLC, but this push is NOT our local delta — its ack
      // must never move our watermark, so it goes out with no requestId.
      const peerSite = generateSiteId();
      const hlc: HLC = { wallTime: 5000n, counter: 1, siteId: peerSite, opSeq: 0 };
      syncManager.getChangesSinceResult = [changeSet(peerSite, 'tx-relay', hlc)];

      ws.simulateMessage({ type: 'request_changes', siteId: siteIdToBase64(peerSite) });
      await new Promise(r => setTimeout(r, 5));

      const relayPush = ws.getSentMessages().find(m => m.type === 'apply_changes') as { requestId?: string };
      expect(relayPush).to.exist;
      expect(relayPush.requestId).to.be.undefined;
      // Nothing recorded to promote.
      expect((client as any).pendingSentHLCs.size).to.equal(0);

      // The server echoes no requestId back; the ack must leave the watermark untouched.
      ws.simulateMessage({ type: 'apply_result', applied: 1 });
      await new Promise(r => setTimeout(r, 5));
      expect((client as any).lastSentHLC).to.be.null;
      expect((client as any).pendingSentHLCs.size).to.equal(0);
    });
  });

  // ==========================================================================
  // Sent watermark persistence (restart resume)
  // ==========================================================================

  describe('sent watermark persistence', () => {
    /** A one-column ChangeSet stamped with the given HLC. */
    function changeSet(site: SiteId, txId: string, hlc: HLC): ChangeSet {
      return {
        siteId: site,
        transactionId: txId,
        hlc,
        changes: [{ type: 'column', schema: 'main', table: 'items', pk: [1], column: 'n', value: txId, hlc }],
        schemaMigrations: [],
      };
    }

    it('seeds lastSentHLC from the persisted watermark on handshake, so a restart does not replay history', async () => {
      const syncManager = new MockSyncManager();
      const site = syncManager.getSiteId();
      // Simulate a fresh process whose store already holds a confirmed watermark.
      const persisted: HLC = { wallTime: 7000n, counter: 3, siteId: site, opSeq: 0 };
      syncManager.peerSentState = persisted;

      const { client } = createClient({ syncManager });
      await connectAndHandshake(client);

      // The post-handshake delta push must query getChangesSince with the
      // persisted watermark, NOT undefined (undefined re-sends everything).
      const delta = syncManager.getChangesSinceCalls.find(c => c.sinceHLC !== undefined);
      expect(delta, 'delta-push should query getChangesSince with a watermark').to.exist;
      expect(delta!.sinceHLC).to.deep.equal(persisted);
      expect((client as any).lastSentHLC).to.deep.equal(persisted);
    });

    it('persists the sent watermark on a confirmed ack, and only then', async () => {
      const syncManager = new MockSyncManager();
      const { client } = createClient({ syncManager });
      const ws = await connectAndHandshake(client);
      ws.sentMessages.length = 0;
      syncManager.updatePeerSentStateCalls.length = 0;

      const site = syncManager.getSiteId();
      const hlc: HLC = { wallTime: 1000n, counter: 1, siteId: site, opSeq: 0 };
      syncManager.getChangesSinceResult = [changeSet(site, 'tx1', hlc)];
      await (client as any).pushLocalChanges();

      const push = ws.getSentMessages().find(m => m.type === 'apply_changes') as { requestId?: string };
      // In-flight: nothing persisted until the matching ack lands.
      expect(syncManager.updatePeerSentStateCalls.length).to.equal(0);

      ws.simulateMessage({ type: 'apply_result', requestId: push.requestId, applied: 1 });
      await new Promise(r => setTimeout(r, 5));

      expect(syncManager.updatePeerSentStateCalls.length).to.equal(1);
      expect(syncManager.updatePeerSentStateCalls[0].hlc).to.deep.equal(hlc);
      expect(syncManager.peerSentState).to.deep.equal(hlc);
    });

    it('does not persist on an uncorrelated (stale/unknown) ack', async () => {
      const syncManager = new MockSyncManager();
      const { client: _client } = createClient({ syncManager });
      const ws = await connectAndHandshake(_client);
      syncManager.updatePeerSentStateCalls.length = 0;

      ws.simulateMessage({ type: 'apply_result', requestId: 'apply-999', applied: 0 });
      await new Promise(r => setTimeout(r, 5));

      expect(syncManager.updatePeerSentStateCalls.length).to.equal(0);
    });

    it('retains the persisted watermark across a manual disconnect (resume, not replay)', async () => {
      const syncManager = new MockSyncManager();
      const { client } = createClient({ syncManager });
      const ws = await connectAndHandshake(client);

      const site = syncManager.getSiteId();
      const hlc: HLC = { wallTime: 4000n, counter: 2, siteId: site, opSeq: 0 };
      syncManager.getChangesSinceResult = [changeSet(site, 'tx1', hlc)];
      await (client as any).pushLocalChanges();
      const push = ws.getSentMessages().find(m => m.type === 'apply_changes') as { requestId?: string };
      ws.simulateMessage({ type: 'apply_result', requestId: push.requestId, applied: 1 });
      await new Promise(r => setTimeout(r, 5));
      expect(syncManager.peerSentState).to.deep.equal(hlc);

      await client.disconnect();
      // In-memory watermark cleared…
      expect((client as any).lastSentHLC).to.be.null;
      // …but the durable per-peer watermark survives the disconnect.
      expect(syncManager.peerSentState).to.deep.equal(hlc);

      // Reconnect re-seeds from the durable watermark and resumes from there.
      syncManager.getChangesSinceCalls.length = 0;
      await connectAndHandshake(client);
      expect((client as any).lastSentHLC).to.deep.equal(hlc);
      const delta = syncManager.getChangesSinceCalls.find(c => c.sinceHLC !== undefined);
      expect(delta!.sinceHLC).to.deep.equal(hlc);
    });

    it('never drags an ahead-of-persisted in-memory watermark backward when seeding', async () => {
      // Models an auto-reconnect: in-flight pushes advanced the in-memory
      // watermark past the last durable write. Seeding must keep the higher
      // in-memory value, not regress to the stale persisted one.
      const syncManager = new MockSyncManager();
      const site = syncManager.getSiteId();
      const { client } = createClient({ syncManager });
      await connectAndHandshake(client);

      const ahead: HLC = { wallTime: 9000n, counter: 5, siteId: site, opSeq: 0 };
      const stale: HLC = { wallTime: 3000n, counter: 1, siteId: site, opSeq: 0 };
      (client as any).lastSentHLC = ahead;
      syncManager.peerSentState = stale;

      await (client as any).seedSentWatermark();

      expect((client as any).lastSentHLC).to.deep.equal(ahead);
    });
  });

  // ==========================================================================
  // Sync events
  // ==========================================================================

  describe('sync events', () => {
    it('should emit state-change events during connection lifecycle', async () => {
      const { client, syncEventsLog } = createClient();
      const connectPromise = client.connect('ws://localhost:8080/sync', 'test-db');
      MockWebSocket.lastInstance!.simulateOpen();
      simulateHandshakeAck(MockWebSocket.lastInstance!);
      await connectPromise;

      const stateChanges = syncEventsLog.filter(e => e.type === 'state-change');
      expect(stateChanges.length).to.be.greaterThanOrEqual(1);
      expect(stateChanges.some(e => e.message.includes('Connected'))).to.be.true;
    });

    it('should include timestamp in sync events', async () => {
      const { client, syncEventsLog } = createClient();
      const before = Date.now();
      const connectPromise = client.connect('ws://localhost:8080/sync', 'test-db');
      MockWebSocket.lastInstance!.simulateOpen();
      simulateHandshakeAck(MockWebSocket.lastInstance!);
      await connectPromise;

      for (const event of syncEventsLog) {
        expect(event.timestamp).to.be.greaterThanOrEqual(before);
        expect(event.timestamp).to.be.lessThanOrEqual(Date.now());
      }
    });

    it('should emit remote-change events with details', async () => {
      const syncManager = new MockSyncManager();
      syncManager.applyChangesResult = { applied: 3, skipped: 1, conflicts: 1, transactions: 1 };
      const { client, syncEventsLog } = createClient({ syncManager });
      const ws = await connectAndHandshake(client);
      syncEventsLog.length = 0;

      ws.simulateMessage({ type: 'changes', changeSets: [] });
      await new Promise(r => setTimeout(r, 10));

      const remoteEvents = syncEventsLog.filter(e => e.type === 'remote-change');
      expect(remoteEvents.length).to.be.greaterThanOrEqual(1);
      expect(remoteEvents[0].details?.changeCount).to.equal(3);
      expect(remoteEvents[0].details?.conflicts).to.equal(1);
      expect(remoteEvents[0].details?.skipped).to.equal(1);
    });
  });

  // ==========================================================================
  // send() guard
  // ==========================================================================

  describe('send guard', () => {
    it('should not send messages when WebSocket is not open', async () => {
      const { client } = createClient();
      // Don't connect - just create
      // Access private send via message handling that would trigger send
      // The client should silently skip sends when not connected
      expect(client.isConnected).to.be.false;
    });
  });

  // ==========================================================================
  // Snapshot bootstrap
  // ==========================================================================

  describe('snapshot bootstrap', () => {
    /** A serialized 4-chunk snapshot (header, table-start, table-end, footer). */
    function snapshotChunks(serverSite: SiteId, hlc: HLC, snapshotId = 'snap-1'): SerializedSnapshotChunk[] {
      return [
        serializeSnapshotChunk({
          type: 'header', siteId: serverSite, hlc,
          snapshotFormat: SNAPSHOT_WIRE_FORMAT_VERSION,
          tableCount: 1, migrationCount: 0, snapshotId,
        }),
        serializeSnapshotChunk({ type: 'table-start', schema: 'main', table: 'items', estimatedEntries: 0 }),
        serializeSnapshotChunk({ type: 'table-end', schema: 'main', table: 'items', entriesWritten: 0 }),
        serializeSnapshotChunk({ type: 'footer', snapshotId, totalTables: 1, totalEntries: 0, totalMigrations: 0 }),
      ];
    }

    /** Deliver a whole snapshot stream, then snapshot_complete. */
    function streamSnapshot(ws: MockWebSocket, chunks: SerializedSnapshotChunk[]): void {
      for (const chunk of chunks) {
        ws.simulateMessage({ type: 'snapshot_chunk', chunk });
      }
      ws.simulateMessage({ type: 'snapshot_complete' });
    }

    /** A one-column ChangeSet stamped with the given HLC. */
    function changeSet(site: SiteId, txId: string, hlc: HLC): ChangeSet {
      return {
        siteId: site,
        transactionId: txId,
        hlc,
        changes: [{ type: 'column', schema: 'main', table: 'items', pk: [1], column: 'n', value: txId, hlc }],
        schemaMigrations: [],
      };
    }

    function hlcAt(wallTime: bigint, site: SiteId): HLC {
      return { wallTime, counter: 1, siteId: site, opSeq: 0 };
    }

    it('bootstraps a fresh empty device: get_snapshot before get_changes, watermark = header HLC', async () => {
      const syncManager = new MockSyncManager();
      const { client } = createClient({ syncManager, bootstrapOnEmpty: true });
      const serverSite = generateSiteId();
      const ws = await connectAndHandshake(client, serverSite);

      // Transfer is in flight: the snapshot request went out and the
      // incremental path has NOT started yet.
      expect(client.isBootstrapping).to.be.true;
      let types = ws.getSentMessages().map(m => m.type);
      expect(types).to.include('get_snapshot');
      expect(types).to.not.include('get_changes');

      const hlc = hlcAt(9000n, serverSite);
      streamSnapshot(ws, snapshotChunks(serverSite, hlc));
      await new Promise(r => setTimeout(r, 30));

      expect(client.isBootstrapping).to.be.false;
      // The apply really consumed the chunks, in order.
      expect(syncManager.appliedSnapshotChunks.map(c => c.type))
        .to.deep.equal(['header', 'table-start', 'table-end', 'footer']);
      // The received watermark was written from the header HLC…
      expect(syncManager.updatePeerSyncStateCalls.length).to.equal(1);
      expect(syncManager.updatePeerSyncStateCalls[0].hlc).to.deep.equal(hlc);

      // …and the follow-up get_changes (a) came after get_snapshot and
      // (b) carries the snapshot HLC, not a from-nothing request.
      const messages = ws.getSentMessages();
      types = messages.map(m => m.type);
      const snapshotIndex = types.indexOf('get_snapshot');
      const getChangesIndex = types.indexOf('get_changes');
      expect(getChangesIndex).to.be.greaterThan(snapshotIndex);
      expect((messages[getChangesIndex] as { sinceHLC?: string }).sinceHLC)
        .to.equal(serializeHLCForTransport(hlc));
    });

    it('bootstrapOnEmpty defaults to true on a raw client', async () => {
      const syncManager = new MockSyncManager();
      const syncEvents = new SyncEventEmitterImpl();
      const client = new SyncClient({ syncManager, syncEvents, autoReconnect: false });
      activeClients.push(client);

      const connectPromise = client.connect('ws://localhost:8080/sync', 'test-db');
      const ws = MockWebSocket.lastInstance!;
      ws.simulateOpen();
      simulateHandshakeAck(ws);
      await connectPromise;
      await new Promise(r => setTimeout(r, 10));

      expect(ws.getSentMessages().some(m => m.type === 'get_snapshot')).to.be.true;
    });

    it('does not bootstrap a device holding local data it never synced (divergence guard)', async () => {
      const syncManager = new MockSyncManager();
      const site = syncManager.getSiteId();
      // Never synced with this server (no peer state), but holds local facts.
      syncManager.getChangesSinceResult = [changeSet(site, 'tx-local', hlcAt(1000n, site))];
      const { client } = createClient({ syncManager, bootstrapOnEmpty: true });
      const ws = await connectAndHandshake(client);

      const types = ws.getSentMessages().map(m => m.type);
      expect(types).to.not.include('get_snapshot');
      expect(types).to.include('get_changes');
      expect(client.isBootstrapping).to.be.false;
    });

    it('does not bootstrap a device with prior peer sync state', async () => {
      const syncManager = new MockSyncManager();
      const serverSite = generateSiteId();
      syncManager.peerSyncState = hlcAt(5000n, serverSite);
      const { client } = createClient({ syncManager, bootstrapOnEmpty: true });
      const ws = await connectAndHandshake(client, serverSite);

      const types = ws.getSentMessages().map(m => m.type);
      expect(types).to.not.include('get_snapshot');
      expect(types).to.include('get_changes');
    });

    it('bootstrapOnEmpty: false skips auto-bootstrap but requestSnapshot() still works', async () => {
      const syncManager = new MockSyncManager();
      const serverSite = generateSiteId();
      const { client } = createClient({ syncManager, bootstrapOnEmpty: false });
      const ws = await connectAndHandshake(client, serverSite);

      expect(ws.getSentMessages().some(m => m.type === 'get_snapshot')).to.be.false;

      const requestPromise = client.requestSnapshot();
      expect(client.isBootstrapping).to.be.true;
      expect(ws.getSentMessages().some(m => m.type === 'get_snapshot')).to.be.true;

      streamSnapshot(ws, snapshotChunks(serverSite, hlcAt(9000n, serverSite)));
      await requestPromise;
      expect(client.isBootstrapping).to.be.false;
      expect(syncManager.appliedSnapshotChunks.length).to.equal(4);
    });

    it('rejects requestSnapshot() when not connected', async () => {
      const { client } = createClient();
      let thrown: Error | null = null;
      try {
        await client.requestSnapshot();
      } catch (e) {
        thrown = e as Error;
      }
      expect(thrown?.message).to.match(/not connected/i);
    });

    it('sends exactly one get_snapshot for a double requestSnapshot()', async () => {
      const syncManager = new MockSyncManager();
      const serverSite = generateSiteId();
      const { client } = createClient({ syncManager });
      const ws = await connectAndHandshake(client, serverSite);

      const p1 = client.requestSnapshot();
      const p2 = client.requestSnapshot();

      expect(ws.getSentMessages().filter(m => m.type === 'get_snapshot').length).to.equal(1);

      streamSnapshot(ws, snapshotChunks(serverSite, hlcAt(9000n, serverSite)));
      await p1;
      await p2;
      // One transfer: the chunks were applied once.
      expect(syncManager.appliedSnapshotChunks.length).to.equal(4);
    });

    it('resumes a pending checkpoint on connect (resume_snapshot, round-tripped through the codec)', async () => {
      const syncManager = new MockSyncManager();
      const serverSite = generateSiteId();
      const checkpoint: SnapshotCheckpoint = {
        snapshotId: 'snap-A',
        siteId: serverSite,
        hlc: hlcAt(7000n, serverSite),
        lastTableIndex: 1,
        lastEntryIndex: 42,
        completedTables: ['main.items'],
        entriesProcessed: 42,
        createdAt: 1000,
      };
      syncManager.checkpoints.set('snap-A', checkpoint);
      expect(await new SyncClient({ syncManager, syncEvents: new SyncEventEmitterImpl() }).hasPendingSnapshot()).to.be.true;

      // NOTE: harness default bootstrapOnEmpty=false — a resume must run
      // regardless of the bootstrap-on-empty setting.
      const { client } = createClient({ syncManager });
      const ws = await connectAndHandshake(client, serverSite);

      const messages = ws.getSentMessages();
      expect(messages.some(m => m.type === 'get_snapshot')).to.be.false;
      const resume = messages.find(m => m.type === 'resume_snapshot') as { checkpoint: SerializedSnapshotCheckpoint } | undefined;
      expect(resume, 'a resume_snapshot should be sent').to.exist;
      // The wire checkpoint survives the codec round-trip intact.
      expect(deserializeSnapshotCheckpoint(resume!.checkpoint)).to.deep.equal(checkpoint);

      // Completing the resumed stream clears the checkpoint (footer) and the
      // partial-data flag with it.
      streamSnapshot(ws, snapshotChunks(serverSite, hlcAt(9000n, serverSite), 'snap-A'));
      await new Promise(r => setTimeout(r, 30));
      expect(client.isBootstrapping).to.be.false;
      expect(await client.hasPendingSnapshot()).to.be.false;
    });

    it('resumes the newest of several checkpoints and clears the rest', async () => {
      const syncManager = new MockSyncManager();
      const serverSite = generateSiteId();
      const older: SnapshotCheckpoint = {
        snapshotId: 'snap-old', siteId: serverSite, hlc: hlcAt(1000n, serverSite),
        lastTableIndex: 0, lastEntryIndex: 0, completedTables: [], entriesProcessed: 0, createdAt: 100,
      };
      const newer: SnapshotCheckpoint = {
        snapshotId: 'snap-new', siteId: serverSite, hlc: hlcAt(2000n, serverSite),
        lastTableIndex: 0, lastEntryIndex: 0, completedTables: [], entriesProcessed: 0, createdAt: 200,
      };
      syncManager.checkpoints.set('snap-old', older);
      syncManager.checkpoints.set('snap-new', newer);

      const { client } = createClient({ syncManager });
      const ws = await connectAndHandshake(client, serverSite);

      const resume = ws.getSentMessages().find(m => m.type === 'resume_snapshot') as { checkpoint: SerializedSnapshotCheckpoint };
      expect(deserializeSnapshotCheckpoint(resume.checkpoint).snapshotId).to.equal('snap-new');
      // The superseded checkpoint was cleared; the resumed one survives until
      // its footer lands.
      expect(syncManager.checkpoints.has('snap-old')).to.be.false;
      expect(syncManager.checkpoints.has('snap-new')).to.be.true;
      expect(client.isBootstrapping).to.be.true;
    });

    it('resumes an interrupted transfer across a reconnect', async () => {
      const syncManager = new MockSyncManager();
      const serverSite = generateSiteId();
      const { client } = createClient({ syncManager, bootstrapOnEmpty: true, autoReconnect: true });
      const ws = await connectAndHandshake(client, serverSite);
      expect(ws.getSentMessages().some(m => m.type === 'get_snapshot')).to.be.true;

      // Header arrives (the apply saves its checkpoint), then the socket drops
      // mid-stream.
      const chunks = snapshotChunks(serverSite, hlcAt(9000n, serverSite));
      ws.simulateMessage({ type: 'snapshot_chunk', chunk: chunks[0] });
      await new Promise(r => setTimeout(r, 10));
      ws.simulateClose();
      await new Promise(r => setTimeout(r, 10));

      expect(client.isBootstrapping).to.be.false;
      // Interrupted apply left its checkpoint — the durable partial-data marker.
      expect(await client.hasPendingSnapshot()).to.be.true;
      // No watermark was written for the failed transfer.
      expect(syncManager.updatePeerSyncStateCalls.length).to.equal(0);

      // Reconnect fires (100ms base delay), handshake again — the client must
      // resume, not restart.
      await new Promise(r => setTimeout(r, 200));
      const ws2 = MockWebSocket.lastInstance!;
      expect(ws2).to.not.equal(ws);
      ws2.simulateOpen();
      simulateHandshakeAck(ws2);
      await new Promise(r => setTimeout(r, 20));

      const types = ws2.getSentMessages().map(m => m.type);
      expect(types).to.include('resume_snapshot');
      expect(types).to.not.include('get_snapshot');
      const resume = ws2.getSentMessages().find(m => m.type === 'resume_snapshot') as { checkpoint: SerializedSnapshotCheckpoint };
      expect(deserializeSnapshotCheckpoint(resume.checkpoint).snapshotId).to.equal('snap-1');
    });

    it('drops a snapshot_chunk with no active transfer without starting one', async () => {
      const syncManager = new MockSyncManager();
      const serverSite = generateSiteId();
      const { client } = createClient({ syncManager });
      const ws = await connectAndHandshake(client, serverSite);

      const [header] = snapshotChunks(serverSite, hlcAt(9000n, serverSite));
      ws.simulateMessage({ type: 'snapshot_chunk', chunk: header });
      await new Promise(r => setTimeout(r, 10));

      expect(client.isBootstrapping).to.be.false;
      expect(syncManager.appliedSnapshotChunks.length).to.equal(0);
      // A late chunk must not poison a subsequent transfer either.
      const requestPromise = client.requestSnapshot();
      streamSnapshot(ws, snapshotChunks(serverSite, hlcAt(9500n, serverSite)));
      await requestPromise;
      expect(syncManager.appliedSnapshotChunks.map(c => c.type))
        .to.deep.equal(['header', 'table-start', 'table-end', 'footer']);
    });

    it('ignores snapshot_complete with no active transfer', async () => {
      const { client } = createClient();
      const ws = await connectAndHandshake(client);
      ws.simulateMessage({ type: 'snapshot_complete' });
      await new Promise(r => setTimeout(r, 10));
      expect(client.isBootstrapping).to.be.false;
    });

    it('aborts the transfer on a SNAPSHOT_ERROR and leaves reconnect intact', async () => {
      const syncManager = new MockSyncManager();
      const { client, errors } = createClient({ syncManager, bootstrapOnEmpty: true, autoReconnect: true });
      const ws = await connectAndHandshake(client);
      expect(client.isBootstrapping).to.be.true;
      errors.length = 0;

      ws.simulateMessage({ type: 'error', code: 'SNAPSHOT_ERROR', message: 'stream broke' });
      await new Promise(r => setTimeout(r, 20));

      expect(client.isBootstrapping).to.be.false;
      expect(errors.length).to.be.greaterThanOrEqual(1);
      // Transient by construction: no lasting error status, no stop-reconnect.
      expect((client as any).stopReconnect).to.be.false;
      expect(client.status.status).to.not.equal('error');
      // The failure path closed the socket so the reconnect machinery takes over.
      expect(ws.readyState).to.equal(MockWebSocket.CLOSED);
      await new Promise(r => setTimeout(r, 200));
      expect(MockWebSocket.lastInstance).to.not.equal(ws);
    });

    it('aborts the transfer on a fatal server error and stops reconnecting', async () => {
      const syncManager = new MockSyncManager();
      const { client } = createClient({ syncManager, bootstrapOnEmpty: true, autoReconnect: true });
      const ws = await connectAndHandshake(client);
      expect(client.isBootstrapping).to.be.true;

      ws.simulateMessage({ type: 'error', code: 'AUTH_FAILED', message: 'bad token', fatal: true });
      await new Promise(r => setTimeout(r, 20));

      expect(client.isBootstrapping).to.be.false;
      expect((client as any).stopReconnect).to.be.true;
      expect(client.status.status).to.equal('error');

      const instanceCount = MockWebSocket.instances.length;
      await new Promise(r => setTimeout(r, 200));
      expect(MockWebSocket.instances.length).to.equal(instanceCount);
    });

    it('aborts a stalled transfer via the chunk watchdog', async () => {
      const syncManager = new MockSyncManager();
      const serverSite = generateSiteId();
      const { client, syncEventsLog } = createClient({
        syncManager, bootstrapOnEmpty: true, snapshotChunkTimeoutMs: 30,
      });
      const ws = await connectAndHandshake(client, serverSite);
      expect(client.isBootstrapping).to.be.true;

      // Header arrives, then the server goes silent without closing the socket.
      const [header] = snapshotChunks(serverSite, hlcAt(9000n, serverSite));
      ws.simulateMessage({ type: 'snapshot_chunk', chunk: header });

      await new Promise(r => setTimeout(r, 150));
      expect(client.isBootstrapping).to.be.false;
      expect(syncEventsLog.some(e => e.type === 'error' && /stalled/.test(e.message))).to.be.true;
    });

    it('settles cleanly when disconnect() lands mid-transfer', async () => {
      const syncManager = new MockSyncManager();
      const { client } = createClient({ syncManager, bootstrapOnEmpty: true, autoReconnect: true });
      await connectAndHandshake(client);
      expect(client.isBootstrapping).to.be.true;

      await client.disconnect();
      await new Promise(r => setTimeout(r, 20));

      expect(client.isBootstrapping).to.be.false;
      expect(client.status.status).to.equal('disconnected');
      // No reconnect after a manual disconnect, even from a failed transfer.
      const instanceCount = MockWebSocket.instances.length;
      await new Promise(r => setTimeout(r, 200));
      expect(MockWebSocket.instances.length).to.equal(instanceCount);
    });

    it('still bootstraps a readOnly client (and never pushes)', async () => {
      const syncManager = new MockSyncManager();
      const serverSite = generateSiteId();
      const { client } = createClient({ syncManager, bootstrapOnEmpty: true, readOnly: true });
      const ws = await connectAndHandshake(client, serverSite);

      streamSnapshot(ws, snapshotChunks(serverSite, hlcAt(9000n, serverSite)));
      await new Promise(r => setTimeout(r, 30));

      expect(client.isBootstrapping).to.be.false;
      expect(syncManager.appliedSnapshotChunks.length).to.equal(4);
      expect(ws.getSentMessages().some(m => m.type === 'apply_changes')).to.be.false;
    });

    it('drops incoming changes and push_changes during a transfer, leaving the watermark untouched', async () => {
      const syncManager = new MockSyncManager();
      const serverSite = generateSiteId();
      const { client, syncEventsLog } = createClient({ syncManager, bootstrapOnEmpty: true });
      const ws = await connectAndHandshake(client, serverSite);
      expect(client.isBootstrapping).to.be.true;
      syncEventsLog.length = 0;

      const cs = changeSet(generateSiteId(), 'tx-mid', hlcAt(8000n, serverSite));
      ws.simulateMessage({ type: 'push_changes', changeSets: [serializeChangeSet(cs)] });
      ws.simulateMessage({ type: 'changes', changeSets: [serializeChangeSet(cs)] });
      await new Promise(r => setTimeout(r, 10));

      // Neither was applied; neither advanced the watermark; both surfaced as
      // info (they are re-fetched by the post-bootstrap catch-up).
      expect(syncManager.applyChangesCalls.length).to.equal(0);
      expect(syncManager.updatePeerSyncStateCalls.length).to.equal(0);
      expect(syncEventsLog.filter(e => e.type === 'info' && /Dropped/.test(e.message)).length).to.equal(2);
    });

    it('surfaces an engine-gate rejection without leaving a checkpoint or spinning', async () => {
      const syncManager = new MockSyncManager();
      syncManager.applySnapshotStreamError = new Error('snapshot wire-format mismatch');
      const { client, errors } = createClient({ syncManager, bootstrapOnEmpty: true });
      const ws = await connectAndHandshake(client);
      await new Promise(r => setTimeout(r, 20));

      expect(client.isBootstrapping).to.be.false;
      expect(errors.some(e => /wire-format mismatch/.test(e.message))).to.be.true;
      // The gate fired before any local state was touched — no checkpoint, so
      // the next connect retries a FRESH get_snapshot (paced only by the
      // reconnect backoff).
      expect(await client.hasPendingSnapshot()).to.be.false;
      expect((client as any).stopReconnect).to.be.false;
      expect(ws.readyState).to.equal(MockWebSocket.CLOSED);
    });

    it('preserves chunk order when other message types interleave mid-stream', async () => {
      const syncManager = new MockSyncManager();
      const serverSite = generateSiteId();
      const { client } = createClient({ syncManager, bootstrapOnEmpty: true });
      const ws = await connectAndHandshake(client, serverSite);

      // Interleave non-snapshot traffic between chunks. The chunk push is
      // synchronous in handleMessage, so order must survive the concurrent
      // (non-serialized) message handling.
      const chunks = snapshotChunks(serverSite, hlcAt(9000n, serverSite));
      ws.simulateMessage({ type: 'snapshot_chunk', chunk: chunks[0] });
      ws.simulateMessage({ type: 'pong' });
      ws.simulateMessage({ type: 'snapshot_chunk', chunk: chunks[1] });
      ws.simulateMessage({ type: 'changes', changeSets: [] });
      ws.simulateMessage({ type: 'snapshot_chunk', chunk: chunks[2] });
      ws.simulateMessage({ type: 'snapshot_chunk', chunk: chunks[3] });
      ws.simulateMessage({ type: 'snapshot_complete' });
      await new Promise(r => setTimeout(r, 30));

      expect(syncManager.appliedSnapshotChunks.map(c => c.type))
        .to.deep.equal(['header', 'table-start', 'table-end', 'footer']);
    });

    it('reports progress via onSnapshotProgress, status, and table-boundary events', async () => {
      const syncManager = new MockSyncManager();
      const serverSite = generateSiteId();
      const progressTicks: SnapshotProgress[] = [];
      const { client, statusChanges, syncEventsLog } = createClient({
        syncManager, bootstrapOnEmpty: true,
        onSnapshotProgress: p => progressTicks.push(p),
      });
      const ws = await connectAndHandshake(client, serverSite);
      syncEventsLog.length = 0;

      streamSnapshot(ws, snapshotChunks(serverSite, hlcAt(9000n, serverSite)));
      await new Promise(r => setTimeout(r, 30));

      // The mock emits one progress tick at the table-end boundary.
      expect(progressTicks.length).to.be.greaterThanOrEqual(1);
      expect(progressTicks[progressTicks.length - 1].tablesProcessed).to.equal(1);
      // Status mirrored the transfer.
      expect(statusChanges.some(s => s.status === 'bootstrapping')).to.be.true;
      // Human-readable event at the table boundary.
      expect(syncEventsLog.some(e => e.type === 'info' && /1 of 1 tables/.test(e.message))).to.be.true;
    });
  });
});

