/**
 * SyncClient - WebSocket-based sync client for Quereus.
 *
 * Handles:
 * - WebSocket connection and handshake
 * - Message dispatch (changes, push_changes, apply_result, error, pong)
 * - Reconnection with exponential backoff
 * - Local change debouncing
 * - Delta sync tracking (lastSentHLC + per-request pending watermarks)
 */

import {
  siteIdToBase64,
  siteIdFromBase64,
  maxHLC,
  compareHLC,
  serializeChangeSet,
  deserializeChangeSet,
  serializeHLCForTransport,
  deserializeHLCFromTransport,
  serializeSnapshotCheckpoint,
  PROTOCOL_VERSION,
  type SyncManager,
  type SyncEventEmitter,
  type HLC,
  type SiteId,
  type ClientMessage,
  type GetSnapshotMessage,
  type ResumeSnapshotMessage,
  type SerializedChangeSet,
  type SerializedSnapshotChunk,
  type SnapshotProgress,
} from '@quereus/sync';

import type {
  SyncClientOptions,
  SyncStatus,
  SyncEvent,
} from './types.js';
import { SnapshotStreamReader } from './snapshot-reader.js';

// Default configuration values
const DEFAULT_RECONNECT_DELAY_MS = 1000;
const DEFAULT_MAX_RECONNECT_DELAY_MS = 60_000;
const DEFAULT_LOCAL_CHANGE_DEBOUNCE_MS = 50;
const DEFAULT_SNAPSHOT_CHUNK_TIMEOUT_MS = 60_000;

/**
 * WebSocket sync client for Quereus.
 *
 * Connects to a sync server and handles bidirectional synchronization
 * of changes with automatic reconnection and local change batching.
 */
export class SyncClient {
  private readonly syncManager: SyncManager;
  private readonly syncEvents: SyncEventEmitter;
  private readonly options: Required<Pick<SyncClientOptions,
    'autoReconnect' | 'reconnectDelayMs' | 'maxReconnectDelayMs' | 'localChangeDebounceMs'
    | 'bootstrapOnEmpty' | 'snapshotChunkTimeoutMs'
  >> & SyncClientOptions;

  // WebSocket state
  private ws: WebSocket | null = null;
  private serverSiteId: SiteId | null = null;

  // Connection state
  private _status: SyncStatus = { status: 'disconnected' };
  private connectionUrl: string | null = null;
  private connectionDatabaseId: string | null = null;
  private connectionToken: string | undefined = undefined;

  // Reconnection state
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  // True only when the client itself called disconnect(). Never set by a
  // server error — see stopReconnect for server-driven shutdown.
  private intentionalDisconnect = false;
  // True when the server told us to stop reconnecting (a fatal error). Kept
  // separate from intentionalDisconnect so a transient server error can never
  // masquerade as a deliberate client disconnect.
  private stopReconnect = false;

  /**
   * Server error codes that are fatal even when the server does not send the
   * `fatal` flag (coordinators predating it). These correspond to sendError
   * calls where the coordinator also closes the socket or leaves the session
   * unrecoverable, so reconnecting as-is cannot succeed.
   */
  private static readonly FATAL_ERROR_CODES: ReadonlySet<string> = new Set([
    'AUTH_FAILED',
    'MISSING_DATABASE_ID',
    'ALREADY_AUTHENTICATED',
  ]);

  // Delta sync tracking. `lastSentHLC` is the high-water mark of local changes
  // the server has acknowledged. It is durably persisted per peer on each
  // confirmed ack (SyncManager.updatePeerSentState) and re-seeded on handshake,
  // so a process restart resumes delta-push instead of replaying local history.
  // Each in-flight push is tracked by its request id → the HLC that ack would
  // promote `lastSentHLC` to; keying by request id correlates each
  // `apply_result` to the exact batch that produced it, so a stale, duplicate,
  // or out-of-order ack can't mis-advance the watermark.
  private lastSentHLC: HLC | null = null;
  // NOTE: bounded by in-flight pushes — every successful ack prunes itself plus
  // any batch its watermark subsumes (see promoteWatermark), and disconnect
  // clears it. If a server ever accepts apply_changes but never acks them, this
  // would grow one entry per push; cap it (evict oldest) only if that shows up.
  private readonly pendingSentHLCs = new Map<string, HLC>();
  // Monotonic per-client counter backing apply-request ids. Deterministic (no
  // Date.now / Math.random) so tests can predict the ids. Intentionally NOT
  // reset on disconnect: pendingSentHLCs is cleared there instead, so a stale
  // ack redelivered after a reconnect carries an id we no longer hold (dropped)
  // rather than colliding with a freshly-reused id and crediting the wrong batch.
  private applyRequestSeq = 0;

  // Local change debouncing
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingLocalChangeCount = 0;

  // Local change listener cleanup
  private localChangeUnsubscribe: (() => void) | null = null;

  // Snapshot bootstrap state. `activeSnapshotReader` routes incoming
  // snapshot_chunk messages; `snapshotTransferPromise` is the whole in-flight
  // transfer (request → stream → apply → watermark), resolving to the failure
  // Error or null on success — it never rejects, so an unobserved automatic
  // bootstrap can't surface an unhandled rejection. Both are null when no
  // transfer is active.
  private activeSnapshotReader: SnapshotStreamReader | null = null;
  private snapshotTransferPromise: Promise<Error | null> | null = null;
  private snapshotStallTimer: ReturnType<typeof setTimeout> | null = null;
  // Last tablesProcessed a sync event was emitted for — progress fires once per
  // column-versions chunk and would flood an event log; events are throttled to
  // table boundaries. -1 = none yet this transfer.
  private snapshotEventTablesProcessed = -1;
  // One dropped-chunk warning per transfer gap, not one per chunk — an aborted
  // stream can trail thousands of late chunks.
  private droppedChunkWarned = false;

  // Pending connect() promise settlement — allows handshake_ack / server error
  // to resolve or reject the promise returned by connect().
  private _connectResolve: (() => void) | null = null;
  private _connectReject: ((error: Error) => void) | null = null;

  constructor(options: SyncClientOptions) {
    this.syncManager = options.syncManager;
    this.syncEvents = options.syncEvents;
    this.options = {
      ...options,
      autoReconnect: options.autoReconnect ?? true,
      reconnectDelayMs: options.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS,
      maxReconnectDelayMs: options.maxReconnectDelayMs ?? DEFAULT_MAX_RECONNECT_DELAY_MS,
      localChangeDebounceMs: options.localChangeDebounceMs ?? DEFAULT_LOCAL_CHANGE_DEBOUNCE_MS,
      bootstrapOnEmpty: options.bootstrapOnEmpty ?? true,
      snapshotChunkTimeoutMs: options.snapshotChunkTimeoutMs ?? DEFAULT_SNAPSHOT_CHUNK_TIMEOUT_MS,
    };
  }

  /** Current connection status */
  get status(): SyncStatus {
    return this._status;
  }

  /** Whether the client is connected and synced */
  get isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  /** Whether the client is fully synced */
  get isSynced(): boolean {
    return this._status.status === 'synced';
  }

  /**
   * Whether a snapshot transfer (bootstrap or resume) is in flight. While true
   * the local database is partial: incoming deltas are dropped (re-fetched by
   * the post-bootstrap catch-up), local pushes are held, and the application
   * should not write to the database.
   */
  get isBootstrapping(): boolean {
    return this.snapshotTransferPromise !== null;
  }

  /**
   * Whether the local store holds a pending snapshot checkpoint — i.e. a
   * previous snapshot apply was interrupted and the database is PARTIAL.
   * Usable before connecting (e.g. at app startup, to gate reads); the next
   * connect resumes the transfer automatically.
   */
  async hasPendingSnapshot(): Promise<boolean> {
    const checkpoints = await this.syncManager.listSnapshotCheckpoints();
    return checkpoints.length > 0;
  }

  /**
   * Connect to a sync server.
   *
   * @param url - WebSocket URL of the sync server
   * @param databaseId - Database ID for multi-tenant routing
   * @param token - Optional authentication token
   * @returns Promise that resolves after handshake is acknowledged, rejects on
   *          WebSocket failure or server error/rejection.
   */
  async connect(url: string, databaseId: string, token?: string): Promise<void> {
    // Store connection params for reconnection
    this.connectionUrl = url;
    this.connectionDatabaseId = databaseId;
    this.connectionToken = token;
    this.intentionalDisconnect = false;
    this.stopReconnect = false;

    // Clear any pending reconnect timer
    this.clearReconnectTimer();

    // Abandon any prior unsettled connect promise
    this.settleConnect(new Error('Superseded by new connect() call'));

    // Close existing connection. Detach its handlers first so a late event
    // from the dead socket (e.g. its deferred onclose) can't drive this client
    // — only the live socket should.
    if (this.ws) {
      this.detachSocketHandlers(this.ws);
      this.ws.close();
      this.ws = null;
    }

    this.setStatus({ status: 'connecting' });

    return new Promise((resolve, reject) => {
      this._connectResolve = resolve;
      this._connectReject = reject;

      try {
        this.ws = new WebSocket(url);

        this.ws.onopen = () => {
          this.reconnectAttempts = 0;
          this.sendHandshake(databaseId, token);
          this.setStatus({ status: 'syncing', progress: 0 });
          this.emitSyncEvent('state-change', 'Connected to sync server, handshake sent');
          // Don't resolve yet — wait for handshake_ack (or server error).
        };

        this.ws.onclose = () => {
          // A transfer interrupted by a socket drop aborts here; the saved
          // checkpoint makes the reconnect below resume it via resume_snapshot.
          this.abortSnapshotTransfer(new Error('Connection closed during snapshot transfer'));
          const wasError = this._status.status === 'error';
          if (!wasError) {
            this.setStatus({ status: 'disconnected' });
          }
          this.emitSyncEvent('state-change', 'Disconnected from sync server');
          this.settleConnect(new Error('Connection closed before handshake'));
          this.scheduleReconnect();
        };

        this.ws.onerror = () => {
          const error = new Error('WebSocket connection failed');
          this.setStatus({ status: 'error', message: error.message });
          this.emitSyncEvent('error', error.message);
          this.settleConnect(error);
        };

        this.ws.onmessage = (event) => {
          this.handleMessage(event.data).catch(err => {
            console.error('Error handling sync message:', err);
            this.emitSyncEvent('error', `Sync error: ${err instanceof Error ? err.message : 'Unknown'}`);
          });
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : 'Connection failed';
        this.setStatus({ status: 'error', message: msg });
        this.settleConnect(error instanceof Error ? error : new Error(msg));
      }
    });
  }

  /** Settle the pending connect() promise (no-op if already settled). */
  private settleConnect(error?: Error): void {
    if (error) {
      const reject = this._connectReject;
      this._connectResolve = null;
      this._connectReject = null;
      reject?.(error);
    } else {
      const resolve = this._connectResolve;
      this._connectResolve = null;
      this._connectReject = null;
      resolve?.();
    }
  }

  /**
   * Disconnect from the sync server.
   * Stops reconnection attempts.
   */
  async disconnect(): Promise<void> {
    this.intentionalDisconnect = true;

    // Abort any in-flight snapshot transfer. Its promise settles (resolved with
    // the abort error — it never rejects), and the checkpoint saved by the
    // interrupted apply lets a later connect resume.
    this.abortSnapshotTransfer(new Error('Disconnected'));

    // Reject any pending connect() promise
    this.settleConnect(new Error('Disconnected'));

    // Clear timers
    this.clearReconnectTimer();
    this.clearDebounceTimer();

    // Remove local change listener
    if (this.localChangeUnsubscribe) {
      this.localChangeUnsubscribe();
      this.localChangeUnsubscribe = null;
    }

    // Close WebSocket. Detach handlers first so its deferred onclose can't
    // fire back into the client after we've torn down.
    if (this.ws) {
      this.detachSocketHandlers(this.ws);
      this.ws.close();
      this.ws = null;
    }

    this.serverSiteId = null;
    // Clear only the in-memory watermark. The persisted per-peer sent watermark
    // (SyncManager.updatePeerSentState) is intentionally left intact so a later
    // reconnect resumes delta-push instead of replaying local history.
    this.lastSentHLC = null;
    this.pendingSentHLCs.clear();
    this.setStatus({ status: 'disconnected' });
    this.emitSyncEvent('state-change', 'Disconnected from sync server (manual)');
  }

  // ==========================================================================
  // Private: Message Handlers
  // ==========================================================================

  private async handleMessage(data: string): Promise<void> {
    const message = JSON.parse(data);

    switch (message.type) {
      case 'handshake_ack':
        await this.handleHandshakeAck(message);
        break;

      case 'changes':
        // Ordered reply to an explicit get_changes: server-ordered, gap-free.
        // Safe to advance the received watermark.
        await this.handleChanges(message.changeSets || [], true);
        break;

      case 'push_changes':
        // Fire-and-forget broadcast relaying a peer's change. Delivery is not
        // acked, so a dropped broadcast is invisible to the coordinator. Apply
        // it eagerly, but do NOT advance the watermark — otherwise a missed
        // earlier broadcast would never be redelivered on the next catch-up.
        // The change is re-fetched (and idempotently re-applied) by the next
        // get_changes since the watermark stays below it.
        await this.handleChanges(message.changeSets || [], false);
        break;

      case 'apply_result':
        await this.handleApplyResult(message);
        break;

      case 'snapshot_chunk':
        // MUST stay synchronous: handleMessage is invoked from ws.onmessage
        // without serialization, so two messages can be in-flight through it at
        // once and anything after an `await` may interleave. Reaching push()
        // with no intervening await is what preserves chunk order — the whole
        // transfer's correctness rests on it.
        this.handleSnapshotChunk(message);
        break;

      case 'snapshot_complete':
        this.handleSnapshotComplete();
        break;

      case 'error':
        this.handleServerError(message);
        break;

      case 'pong':
        // Heartbeat response - no action needed
        break;

      case 'request_changes':
        // Server is requesting changes (for peer-to-peer relay)
        await this.handleRequestChanges(message);
        break;

      default:
        if (this.options.onUnhandledMessage) {
          this.options.onUnhandledMessage(message);
        } else {
          console.warn('Unknown sync message type:', message.type);
        }
    }
  }

  /**
   * Handle a server `error` message.
   *
   * Default behavior keeps the session alive: a per-request (transient) error
   * is surfaced but does not stop the connection or its auto-reconnect. Only a
   * fatal error (server rejected the session and typically closed the socket)
   * flips `stopReconnect` and puts the client into a lasting `error` status.
   */
  private handleServerError(message: { code: string; message: string; fatal?: boolean }): void {
    // Always surface the error to listeners.
    this.emitSyncEvent('error', `Server error: ${message.message} (${message.code})`);
    this.options.onError?.(new Error(message.message));

    // Trust the server's `fatal` flag when present; fall back to the known
    // fatal-code set for coordinators that predate it.
    const fatal = message.fatal ?? SyncClient.FATAL_ERROR_CODES.has(message.code);

    // A snapshot-stream failure (or any fatal error) kills the transfer. For
    // SNAPSHOT_ERROR the failure path closes the socket and the reconnect
    // resumes from the checkpoint; for a fatal error the stopReconnect set
    // below wins — no reconnect, no resume.
    if (fatal || message.code === 'SNAPSHOT_ERROR') {
      this.abortSnapshotTransfer(new Error(`Server error during snapshot: ${message.message}`));
    }

    if (fatal) {
      // Unrecoverable — a bare reconnect would just fail again. Stop reconnect
      // and settle any pending connect(). Note: NOT intentionalDisconnect,
      // which means only "the client called disconnect()".
      this.stopReconnect = true;
      this.setStatus({ status: 'error', message: message.message });
      this.settleConnect(new Error(message.message));
    }
    // Transient: keep the connection and auto-reconnect intact. Deliberately do
    // not set a lingering 'error' status — a per-request failure shouldn't
    // masquerade as connection death (onclose keys its disconnected transition
    // off status === 'error').
  }

  private async handleHandshakeAck(
    message: { serverSiteId?: string; connectionId?: string; protocolVersion?: number }
  ): Promise<void> {
    // Wire-version gate. A coordinator on a different protocol version — or one
    // predating versioning, so the ack carries none — would silently
    // misinterpret us. Treat any mismatch (strict equality; absent counts as
    // mismatch) as fatal: stop reconnecting, surface a lasting error, and reject
    // the pending connect(). Reuses the same stop-reconnect path as a fatal
    // server error, so auto-reconnect does not resume.
    if (message.protocolVersion !== PROTOCOL_VERSION) {
      const serverPart = message.protocolVersion === undefined
        ? 'server sent none (pre-versioning coordinator)'
        : `server speaks v${message.protocolVersion}`;
      const errMsg = `Sync protocol version mismatch: client speaks v${PROTOCOL_VERSION}, ${serverPart}`;
      this.stopReconnect = true;
      this.setStatus({ status: 'error', message: errMsg });
      this.emitSyncEvent('error', errMsg);
      this.options.onError?.(new Error(errMsg));
      this.settleConnect(new Error(errMsg));
      // Drop the incompatible socket. Detach first so its deferred onclose can't
      // fire back into the client (scheduleReconnect is already guarded by
      // stopReconnect, but we don't want the disconnected-status churn either).
      if (this.ws) {
        this.detachSocketHandlers(this.ws);
        this.ws.close();
        this.ws = null;
      }
      return;
    }

    if (message.serverSiteId) {
      this.serverSiteId = siteIdFromBase64(message.serverSiteId);
    }

    this.emitSyncEvent(
      'state-change',
      `Authenticated with server (connection: ${message.connectionId?.slice(0, 8) ?? 'unknown'})`
    );

    // Handshake accepted — resolve the connect() promise.
    this.settleConnect();

    // Bootstrap is decided and FINISHED before the incremental path starts, so
    // the post-snapshot get_changes below carries the snapshot's HLC and the
    // local-change subscription never sees a partial database. A failed
    // transfer has already closed the socket — stop here and let the reconnect
    // (which finds the saved checkpoint) resume it.
    const bootstrapOk = await this.maybeBootstrap();
    if (!bootstrapOk) return;

    // Request changes from server since our last sync with this peer
    await this.requestChangesFromServer();

    // Seed the sent watermark from durable per-peer state so a fresh process
    // (or a reconnect) resumes delta-push where it left off instead of
    // replaying the entire local history to the server.
    await this.seedSentWatermark();

    // In read-only (pull-only) mode, skip push entirely
    if (!this.options.readOnly) {
      // Subscribe to local changes for pushing to server
      this.subscribeToLocalChanges();

      // Push any existing local changes to server (changes made while offline)
      await this.pushLocalChanges();
    }
  }

  /**
   * Apply received changesets to the local store, optionally advancing the
   * received watermark (`lastSyncHLC`).
   *
   * @param advanceWatermark Only the ordered `changes` reply is contiguous and
   *   gap-free, so only it may advance the watermark. A `push_changes`
   *   broadcast is applied (idempotently) but must leave the watermark unmoved,
   *   so a broadcast the client never received is still redelivered by the next
   *   `get_changes sinceHLC=<watermark>`.
   */
  private async handleChanges(
    serializedChangeSets: SerializedChangeSet[],
    advanceWatermark: boolean
  ): Promise<void> {
    // While a snapshot is streaming, incoming deltas are DROPPED, not applied:
    // applyChanges would interleave with the snapshot's clear-and-rewrite of
    // the same cv:/tb:/cl: records. Nothing is lost — the watermark is not
    // advanced here, so the get_changes catch-up that runs right after
    // bootstrap re-fetches everything past the snapshot HLC.
    if (this.isBootstrapping) {
      this.emitSyncEvent(
        'info',
        `Dropped ${serializedChangeSets.length} incoming change set(s) during snapshot bootstrap (re-fetched afterwards)`
      );
      return;
    }

    const changeSets = serializedChangeSets.map(cs => deserializeChangeSet(cs));
    const result = await this.syncManager.applyChanges(changeSets);

    // Advance peer sync state with the max HLC from received changes — but only
    // on the ordered path, where contiguity guarantees nothing below maxHlc was
    // missed.
    if (advanceWatermark && changeSets.length > 0 && this.serverSiteId) {
      const maxHlc = maxHLC(changeSets.map(cs => cs.hlc));
      if (maxHlc) {
        await this.syncManager.updatePeerSyncState(this.serverSiteId, maxHlc);
      }
    }

    // Emit events
    if (result.applied > 0 || result.conflicts > 0 || result.skipped > 0) {
      const conflictText = result.conflicts > 0 ? ` (${result.conflicts} conflicts resolved)` : '';
      const skippedText = result.skipped > 0 ? `, ${result.skipped} skipped` : '';
      this.emitSyncEvent(
        'remote-change',
        `Applied ${result.applied} column changes${conflictText}${skippedText}`,
        { changeCount: result.applied, conflicts: result.conflicts, skipped: result.skipped }
      );
    }

    this.options.onRemoteChanges?.(result, changeSets);
    this.setStatus({ status: 'synced', lastSyncTime: Date.now() });
  }

  private async handleApplyResult(message: {
    requestId?: string;
    applied?: number;
    rejected?: Array<{ reason: string; code?: string }>;
  }): Promise<void> {
    await this.promoteWatermark(message.requestId);

    this.emitSyncEvent('info', `Server applied ${message.applied ?? 0} change(s)`);

    if (message.rejected?.length) {
      for (const r of message.rejected) {
        this.emitSyncEvent('rejected', r.reason, { rejections: [r] });
      }
    }
  }

  /**
   * Advance `lastSentHLC` for the acknowledged push identified by `requestId`.
   *
   * Only the push whose id we recorded in {@link pushLocalChanges} promotes the
   * watermark, and only ever forward — never regressing past a newer batch a
   * later ack already promoted. Acks we can't correlate are dropped:
   *  - a `requestId` we don't hold → a stale or duplicate ack (e.g. redelivered
   *    across a reconnect, or the server double-acked); logged, then ignored.
   *  - no `requestId` → an untracked push (a peer-relay `apply_changes`) or a
   *    legacy coordinator that doesn't echo the id; nothing to promote.
   */
  private async promoteWatermark(requestId: string | undefined): Promise<void> {
    if (requestId === undefined) return;

    const promoted = this.pendingSentHLCs.get(requestId);
    if (!promoted) {
      this.emitSyncEvent('info', `Ignoring apply_result for unknown push (requestId: ${requestId})`);
      return;
    }

    this.pendingSentHLCs.delete(requestId);

    // Never move the watermark backward: an out-of-order ack for an older batch
    // must not undo a newer batch a prior ack already promoted.
    if (!this.lastSentHLC || compareHLC(promoted, this.lastSentHLC) > 0) {
      this.lastSentHLC = promoted;
      // Persist the confirmed watermark per peer so a restart resumes delta-push
      // from here instead of replaying local history. Only written on a real
      // forward advance, and only for a correlated ack (so we persist a
      // watermark we actually confirmed sent).
      if (this.serverSiteId) {
        await this.syncManager.updatePeerSentState(this.serverSiteId, this.lastSentHLC);
      }
    }

    // Drop any still-pending batches the new watermark now subsumes (a later
    // push re-sends everything since the last ack, so its range covers theirs),
    // so their late/duplicate acks can't re-promote an already-covered HLC.
    for (const [id, hlc] of this.pendingSentHLCs) {
      if (compareHLC(hlc, this.lastSentHLC) <= 0) {
        this.pendingSentHLCs.delete(id);
      }
    }
  }

  private async handleRequestChanges(message: { siteId?: string; sinceHLC?: string }): Promise<void> {
    // Server is relaying a request for changes from another peer
    if (!message.siteId) return;
    // No pushes while a snapshot is landing — local data is partial.
    if (this.isBootstrapping) return;

    const peerSiteId = siteIdFromBase64(message.siteId);
    const sinceHLC = message.sinceHLC ? deserializeHLCFromTransport(message.sinceHLC) : undefined;

    const changes = await this.syncManager.getChangesSince(peerSiteId, sinceHLC);
    if (changes.length > 0) {
      const serialized = changes.map(cs => serializeChangeSet(cs));
      this.send({
        type: 'apply_changes',
        changes: serialized,
      });
    }
  }

  // ==========================================================================
  // Snapshot bootstrap
  // ==========================================================================
  //
  // NOTE: this file is ~1170 lines; this section is ~300 of them and is the
  // natural extraction seam — it touches the rest of the client only through
  // `send`, `setStatus`, `emitSyncEvent`, `syncManager` and `ws`. If the file
  // grows much further, lift it into a `SnapshotBootstrap` collaborator that
  // takes those five as its interface rather than splitting elsewhere.

  /**
   * Explicitly request a full snapshot of the database from the server.
   *
   * CONTRACT: do not write to the database while the snapshot is landing. The
   * apply clears sync metadata and rewrites cell records unconditionally — a
   * concurrent local write is silently overwritten and never pushed. Hold
   * application writes until this resolves (watch {@link isBootstrapping} /
   * the `bootstrapping` status).
   *
   * Idempotent while a transfer is in flight: a second call joins the same
   * transfer instead of starting another stream. Rejects when not connected /
   * handshaken, or when the transfer fails (the socket is then closed and the
   * normal reconnect path resumes from the saved checkpoint).
   */
  async requestSnapshot(): Promise<void> {
    if (this.snapshotTransferPromise) {
      const error = await this.snapshotTransferPromise;
      if (error) throw error;
      return;
    }
    if (!this.isConnected || !this.serverSiteId) {
      throw new Error('Cannot request a snapshot: not connected to a sync server');
    }
    const error = await this.runSnapshotTransfer({ type: 'get_snapshot' });
    if (error) throw error;
  }

  /**
   * Decide, on handshake, whether to run a snapshot transfer before the
   * incremental path: resume a pending checkpoint, bootstrap an empty replica,
   * or neither.
   *
   * @returns false when a transfer failed — the socket has been closed and the
   *          caller must stop the handshake flow (reconnect resumes it).
   */
  private async maybeBootstrap(): Promise<boolean> {
    // A transfer from the PREVIOUS socket can still be unwinding (its abort has
    // to propagate through the apply). This handshake belongs to a new socket,
    // so joining that dead transfer would report its failure as this
    // connection's and stop the handshake with nothing scheduled to retry it.
    // Wait for it to settle, then decide fresh off the checkpoint it left.
    if (this.snapshotTransferPromise) await this.snapshotTransferPromise;

    // NOTE: checkpoints carry no server identity (the apply stamps the
    // RECEIVER's site id into them), so a replica that syncs one database to
    // two different coordinators would resume server A's checkpoint against
    // server B — B skips the tables A already completed, silently. One
    // coordinator per database today; key checkpoints by peer before that
    // changes.
    const pending = await this.syncManager.listSnapshotCheckpoints();

    if (pending.length > 0) {
      // A checkpoint means the database is PARTIAL: a prior apply cleared sync
      // metadata and never reached its footer. Resume the newest; clear the
      // rest — the client tracks one transfer, so they are unreachable and
      // would otherwise accumulate forever.
      const newest = pending.reduce((a, b) => (b.createdAt > a.createdAt ? b : a));
      for (const checkpoint of pending) {
        if (checkpoint.snapshotId !== newest.snapshotId) {
          await this.syncManager.clearSnapshotCheckpoint(checkpoint.snapshotId);
        }
      }
      this.emitSyncEvent('state-change', 'Resuming interrupted snapshot transfer');
      const error = await this.runSnapshotTransfer({
        type: 'resume_snapshot',
        checkpoint: serializeSnapshotCheckpoint(newest),
      });
      return error === null;
    }

    if (this.options.bootstrapOnEmpty && await this.isReplicaEmpty()) {
      this.emitSyncEvent('state-change', 'Empty replica: requesting full snapshot from server');
      const error = await this.runSnapshotTransfer({ type: 'get_snapshot' });
      return error === null;
    }

    return true;
  }

  /**
   * A replica is "empty" — safe to bootstrap wholesale — only when BOTH hold
   * against the server learned at handshake:
   *
   * - no peer sync state (never synced with this server), and
   * - no local change facts of our own.
   *
   * The first alone would also match a device holding real local data that is
   * merely meeting this server for the first time — bootstrapping it would
   * clear its sync metadata while leaving its rows in place (divergence). The
   * second alone would match a device whose entire contents came from this
   * server. Requiring both admits only the genuinely new device. A device that
   * pre-created its schema locally still counts as empty: schema migration
   * records are not consulted, and replicated DDL applies idempotently.
   */
  private async isReplicaEmpty(): Promise<boolean> {
    if (!this.serverSiteId) return false;

    const peerState = await this.syncManager.getPeerSyncState(this.serverSiteId);
    if (peerState !== undefined) return false;

    // NOTE: this arm materializes every local change set when it runs. It runs
    // only when no peer sync state exists — in practice once, on a device with
    // nothing to materialize. If some future caller runs the probe on a
    // populated replica, replace it with a cheap existence scan over the `cv:`
    // prefix.
    const localChanges = await this.syncManager.getChangesSince(this.serverSiteId);
    return localChanges.length === 0;
  }

  /**
   * Run one snapshot transfer: send the request, stream chunks through the
   * reader into `applySnapshotStream`, then write the peer watermark.
   *
   * Resolves to null on success or the failure Error — never rejects, so the
   * automatic bootstrap path (which nobody awaits externally) cannot surface
   * an unhandled rejection. On failure the socket is closed WITHOUT detaching
   * handlers: onclose firing is the retry mechanism (status → disconnected,
   * scheduleReconnect, and the next handshake finds the pending checkpoint and
   * sends resume_snapshot). No lingering `error` status and no stopReconnect —
   * a snapshot failure is transient by construction.
   */
  private runSnapshotTransfer(msg: GetSnapshotMessage | ResumeSnapshotMessage): Promise<Error | null> {
    if (this.snapshotTransferPromise) {
      return this.snapshotTransferPromise;
    }

    // Cleanup rides on the returned promise rather than a `finally` INSIDE the
    // transfer body: the body can settle synchronously (a send that fails
    // before its first await), and an inner finally would then null the field
    // before the assignment below ever set it — pinning isBootstrapping true
    // for the life of the client. A .finally() callback always runs a microtask
    // later, i.e. after the assignment.
    const promise = this.executeSnapshotTransfer(msg).finally(() => {
      this.clearSnapshotStallTimer();
      this.activeSnapshotReader = null;
      this.snapshotTransferPromise = null;
    });
    this.snapshotTransferPromise = promise;
    return promise;
  }

  /** The transfer body itself; state setup/teardown belongs to {@link runSnapshotTransfer}. */
  private async executeSnapshotTransfer(
    msg: GetSnapshotMessage | ResumeSnapshotMessage
  ): Promise<Error | null> {
    // The socket this transfer belongs to. A reconnect can replace `this.ws`
    // while the apply unwinds, and the failure path below must not close the
    // fresh socket in the dead one's name.
    const socket = this.ws;
    const reader = new SnapshotStreamReader();
    this.activeSnapshotReader = reader;
    this.snapshotEventTablesProcessed = -1;
    this.droppedChunkWarned = false;

    try {
      this.setStatus({
        status: 'bootstrapping',
        tablesProcessed: 0, totalTables: 0,
        entriesProcessed: 0, totalEntries: 0,
      });

      if (!this.send(msg)) {
        // Socket died before the request left — abandon without starting the
        // apply; the reconnect path retries.
        throw new Error('Snapshot request could not be sent (socket not open)');
      }

      this.resetSnapshotStallTimer();
      // NOTE: the apply returns only when the stream ENDS, and only
      // snapshot_complete ends it — a socket drop between the footer and that
      // message fails a transfer whose data already landed and whose
      // checkpoint the footer already cleared, so the next connect
      // re-bootstraps from scratch. Correct (idempotent), just wasteful; if it
      // ever shows up in practice, end the stream on the footer instead.
      await this.syncManager.applySnapshotStream(
        reader.chunks(),
        progress => this.reportSnapshotProgress(progress)
      );

      // The snapshot delivered everything up to its header HLC; record that
      // as the received watermark so the follow-up get_changes asks for
      // changes AFTER the snapshot point instead of replaying from nothing.
      // (applySnapshotStream merges the HLC into the local clock but writes
      // no peer state — the client owns that.) On a RESUMED transfer this is
      // conservative: the header carries the original snapshot's HLC while
      // the data served was read live, so the watermark is older than some
      // applied data and the catch-up re-fetches a little. That is correct —
      // re-application is idempotent — and cheaper than the alternative; do
      // not "fix" it by advancing past the header HLC.
      if (reader.headerHLC && this.serverSiteId) {
        await this.syncManager.updatePeerSyncState(this.serverSiteId, reader.headerHLC);
      }

      this.emitSyncEvent('state-change', 'Snapshot bootstrap complete');
      this.setStatus({ status: 'syncing', progress: 0 });
      return null;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      // A transfer torn down by our own disconnect() is not a failure to
      // report — the caller asked for it, and onError means "needs attention".
      if (!this.intentionalDisconnect) {
        this.emitSyncEvent('error', `Snapshot transfer failed: ${error.message}`);
        this.options.onError?.(error);
      }
      // Close (handlers attached — see doc comment) unless the socket is
      // already closed, in which case onclose has fired or is in flight.
      // `socket.OPEN`, not the global `WebSocket.OPEN`: this runs long after
      // the transfer started, and a teardown that has since removed the global
      // (an environment shim, a test harness) would turn this cleanup into a
      // ReferenceError and break the "never rejects" contract above.
      if (socket && socket.readyState === socket.OPEN) {
        socket.close();
      }
      return error;
    }
  }

  /** Route one snapshot_chunk to the active transfer. Synchronous — see the dispatch comment. */
  private handleSnapshotChunk(message: { chunk?: SerializedSnapshotChunk }): void {
    if (!this.activeSnapshotReader) {
      // A late chunk from an aborted stream must never leak into the next
      // transfer. Warn once per gap, not per chunk — a dead stream can trail
      // thousands.
      if (!this.droppedChunkWarned) {
        this.droppedChunkWarned = true;
        console.warn('Dropping snapshot_chunk with no active snapshot transfer');
        this.emitSyncEvent('info', 'Dropped snapshot chunk(s) received with no active transfer');
      }
      return;
    }
    if (!message.chunk) return;
    this.activeSnapshotReader.push(message.chunk);
    this.resetSnapshotStallTimer();
  }

  /** End the active transfer's stream (no-op when none). */
  private handleSnapshotComplete(): void {
    if (!this.activeSnapshotReader) return;
    this.clearSnapshotStallTimer();
    this.activeSnapshotReader.complete();
  }

  /**
   * Abort the in-flight transfer, if any. The reader throws into
   * `applySnapshotStream`, which lands in the transfer's failure path.
   */
  private abortSnapshotTransfer(error: Error): void {
    this.activeSnapshotReader?.abort(error);
  }

  /**
   * Stall watchdog: a server that stops sending mid-stream without closing the
   * socket would otherwise hang the bootstrap forever with no reconnect. Reset
   * on every chunk; cleared on complete and when the transfer settles.
   */
  private resetSnapshotStallTimer(): void {
    this.clearSnapshotStallTimer();
    const timeoutMs = this.options.snapshotChunkTimeoutMs;
    this.snapshotStallTimer = setTimeout(() => {
      this.snapshotStallTimer = null;
      this.abortSnapshotTransfer(new Error(`Snapshot transfer stalled: no chunk within ${timeoutMs}ms`));
    }, timeoutMs);
  }

  private clearSnapshotStallTimer(): void {
    if (this.snapshotStallTimer) {
      clearTimeout(this.snapshotStallTimer);
      this.snapshotStallTimer = null;
    }
  }

  /**
   * Forward apply progress: every tick to `onSnapshotProgress` and the status,
   * but a human-readable sync event only when `tablesProcessed` changes —
   * progress fires once per column-versions chunk and would flood an event log.
   */
  private reportSnapshotProgress(progress: SnapshotProgress): void {
    this.options.onSnapshotProgress?.(progress);
    this.setStatus({
      status: 'bootstrapping',
      tablesProcessed: progress.tablesProcessed,
      totalTables: progress.totalTables,
      entriesProcessed: progress.entriesProcessed,
      totalEntries: progress.totalEntries,
      currentTable: progress.currentTable,
    });
    if (progress.tablesProcessed !== this.snapshotEventTablesProcessed) {
      this.snapshotEventTablesProcessed = progress.tablesProcessed;
      this.emitSyncEvent(
        'info',
        `Snapshot: ${progress.tablesProcessed} of ${progress.totalTables} tables`,
        { changeCount: progress.entriesProcessed }
      );
    }
  }

  // ==========================================================================
  // Private: Message Sending
  // ==========================================================================

  private sendHandshake(databaseId: string, token?: string): void {
    const siteId = this.syncManager.getSiteId();
    this.send({
      type: 'handshake',
      databaseId,
      siteId: siteIdToBase64(siteId),
      token,
      // Stamp the wire version so the coordinator can reject a drifted client
      // before authenticating. See handleHandshakeAck for the reverse check.
      protocolVersion: PROTOCOL_VERSION,
    });
  }

  private async requestChangesFromServer(): Promise<void> {
    if (!this.serverSiteId) return;

    const lastSyncHLC = await this.syncManager.getPeerSyncState(this.serverSiteId);

    if (lastSyncHLC) {
      this.send({ type: 'get_changes', sinceHLC: serializeHLCForTransport(lastSyncHLC) });
    } else {
      this.send({ type: 'get_changes' });
    }
  }

  /**
   * Seed `lastSentHLC` from the durable per-peer sent watermark. Called on every
   * handshake so a fresh process resumes delta-push from the last confirmed HLC
   * rather than re-sending its whole local history.
   *
   * Takes the persisted value only when it is ahead of the in-memory one, so an
   * auto-reconnect that still holds an advanced in-memory watermark (its
   * in-flight pushes may have promoted memory past the last durable write) is
   * never dragged backward.
   */
  private async seedSentWatermark(): Promise<void> {
    if (!this.serverSiteId) return;
    const persisted = await this.syncManager.getPeerSentState(this.serverSiteId);
    if (persisted && (!this.lastSentHLC || compareHLC(persisted, this.lastSentHLC) > 0)) {
      this.lastSentHLC = persisted;
    }
  }

  /**
   * Send a message to the server.
   *
   * @returns true if the bytes were handed to the socket, false if the send was
   *          dropped (socket not open) or threw. Callers that advance state on a
   *          send (e.g. the delta-sync watermark) must check this — a dropped
   *          send is not success.
   */
  private send(message: ClientMessage): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) {
      // NOTE: warns on every send attempted while the socket is down; if reconnect
      // windows ever get chatty, downgrade this to debug or rate-limit per type.
      console.warn(`Sync send skipped, socket not open: ${message.type}`);
      return false;
    }
    try {
      this.ws.send(JSON.stringify(message));
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'unknown error';
      console.error(`Sync send failed for ${message.type}:`, err);
      this.emitSyncEvent('error', `Failed to send ${message.type}: ${msg}`);
      return false;
    }
  }

  /** Detach a socket's event handlers so it can no longer drive this client. */
  private detachSocketHandlers(ws: WebSocket): void {
    ws.onopen = null;
    ws.onclose = null;
    ws.onerror = null;
    ws.onmessage = null;
  }


  // ==========================================================================
  // Private: Local Change Handling
  // ==========================================================================

  private subscribeToLocalChanges(): void {
    // Unsubscribe from previous if any
    if (this.localChangeUnsubscribe) {
      this.localChangeUnsubscribe();
    }

    // Subscribe to local changes via SyncEventEmitter
    this.localChangeUnsubscribe = this.syncEvents.onLocalChange(() => {
      this.pendingLocalChangeCount++;
      this.debouncePushLocalChanges();
    });
  }

  private debouncePushLocalChanges(): void {
    this.clearDebounceTimer();

    this.debounceTimer = setTimeout(async () => {
      this.debounceTimer = null;
      await this.pushLocalChanges();
    }, this.options.localChangeDebounceMs);
  }

  private async pushLocalChanges(): Promise<void> {
    if (this.options.readOnly) return;
    if (!this.isConnected || !this.serverSiteId) return;
    // No pushes while a snapshot is landing — local data is partial.
    if (this.isBootstrapping) return;

    // Get changes since lastSentHLC (delta sync)
    // Use serverSiteId to filter out changes that originated from the server
    // (which we already have), keeping our local changes to send
    const changes = await this.syncManager.getChangesSince(
      this.serverSiteId,
      this.lastSentHLC ?? undefined
    );

    if (changes.length === 0) return;

    // Serialize and send
    const serialized = changes.map(cs => serializeChangeSet(cs));

    this.emitSyncEvent('local-change', `Sending ${changes.length} change set(s) to server`, {
      changeCount: changes.length,
    });

    // Correlate this push with its ack: the server echoes requestId back on the
    // apply_result, so we promote lastSentHLC only when the matching ack returns.
    const requestId = this.nextApplyRequestId();
    const sent = this.send({
      type: 'apply_changes',
      requestId,
      changes: serialized,
    });

    // Only advance delta-sync state if the bytes actually left. A dropped send
    // must be retried on the next push, so register no pending watermark and
    // leave the pending count untouched.
    if (!sent) return;

    // Record the max HLC this batch carries against its request id; the matching
    // apply_result promotes lastSentHLC to it (see promoteWatermark).
    const batchHLC = maxHLC(changes.map(cs => cs.hlc));
    if (batchHLC) {
      this.pendingSentHLCs.set(requestId, batchHLC);
    }
    this.pendingLocalChangeCount = 0;
  }

  /** Next monotonic apply-request id. Deterministic for test predictability. */
  private nextApplyRequestId(): string {
    return `apply-${++this.applyRequestSeq}`;
  }

  // ==========================================================================
  // Private: Reconnection
  // ==========================================================================

  private scheduleReconnect(): void {
    if (this.intentionalDisconnect || this.stopReconnect || !this.connectionUrl || !this.options.autoReconnect) {
      return;
    }

    // Exponential backoff: 1s, 2s, 4s, 8s, ... up to max
    const delay = Math.min(
      this.options.reconnectDelayMs * Math.pow(2, this.reconnectAttempts),
      this.options.maxReconnectDelayMs
    );

    this.reconnectAttempts++;

    this.emitSyncEvent(
      'state-change',
      `Reconnecting in ${Math.round(delay / 1000)}s (attempt ${this.reconnectAttempts})`
    );

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect(this.connectionUrl!, this.connectionDatabaseId!, this.connectionToken).catch(() => {
        // Error already handled in connect, reconnect will be scheduled by onclose
      });
    }, delay);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private clearDebounceTimer(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }

  // ==========================================================================
  // Private: Status & Events
  // ==========================================================================

  private setStatus(status: SyncStatus): void {
    this._status = status;
    this.options.onStatusChange?.(status);
  }

  private emitSyncEvent(
    type: SyncEvent['type'],
    message: string,
    details?: SyncEvent['details']
  ): void {
    const event: SyncEvent = {
      type,
      timestamp: Date.now(),
      message,
      details,
    };
    this.options.onSyncEvent?.(event);
  }
}
