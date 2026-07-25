/**
 * WebSocket handler for real-time sync.
 */

import type { FastifyInstance, FastifyRequest, RouteShorthandOptions } from 'fastify';
import type { WebSocket, RawData } from 'ws';
import '@fastify/websocket';
import {
  siteIdFromBase64,
  siteIdToBase64,
  deserializeHLC,
  PROTOCOL_VERSION,
  type HLC,
  type ChangeSet,
  type ClientMessage,
  type HandshakeMessage,
  type GetChangesMessage,
  type ApplyChangesMessage,
  type ResumeSnapshotMessage,
} from '@quereus/sync';
import type { CoordinatorService } from '../service/coordinator-service.js';
import type { ClientIdentity, ClientSession } from '../service/types.js';
import { wsLog, serializeChangeSet, deserializeChangeSet, serializeSnapshotChunk, deserializeSnapshotCheckpoint } from '../common/index.js';

// The ClientMessage union and its per-message interfaces are the shared wire
// definitions from @quereus/sync (`sync/wire.ts`), the single source of truth
// this coordinator and the sync client both speak.

// ============================================================================
// WebSocket Handler
// ============================================================================

/**
 * Register WebSocket handler.
 */
export function registerWebSocket(
  app: FastifyInstance,
  service: CoordinatorService,
  basePath: string
): void {
  // @fastify/websocket augments RouteShorthandMethod to accept (socket, request) handlers
  // when { websocket: true } is set, but portal-linked consumers may resolve fastify types
  // from a different instance, breaking the augmentation merge.  Cast both opts and handler.
  const wsOpts: RouteShorthandOptions & { websocket: true } = { websocket: true };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app.get(`${basePath}/ws`, wsOpts, ((socket: WebSocket, request: FastifyRequest) => {
    wsLog('New WebSocket connection from %s', request.ip);

    let session: ClientSession | null = null;
    let socketClosed = false;

    // `fatal` tells the client whether to stop auto-reconnecting. Fatal errors
    // are ones where the session is unrecoverable and we typically also close
    // the socket; transient per-request errors leave the session intact.
    const sendError = (code: string, message: string, fatal = false) => {
      socket.send(JSON.stringify({ type: 'error', code, message, fatal }));
    };

    const sendMessage = (msg: object) => {
      socket.send(JSON.stringify(msg));
    };

    socket.on('message', async (data: RawData) => {
      try {
        const message = JSON.parse(data.toString()) as ClientMessage;
        wsLog('Received message: %s', message.type);

        switch (message.type) {
          case 'handshake':
            await handleHandshake(message);
            break;
          case 'get_changes':
            await handleGetChanges(message);
            break;
          case 'apply_changes':
            await handleApplyChanges(message);
            break;
          case 'get_snapshot':
            await handleGetSnapshot();
            break;
          case 'resume_snapshot':
            await handleResumeSnapshot(message);
            break;
          case 'ping':
            sendMessage({ type: 'pong' });
            break;
          default:
            sendError('UNKNOWN_MESSAGE', `Unknown message type: ${(message as { type: string }).type}`);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Message processing failed';
        wsLog('Message error: %s', msg);
        sendError('MESSAGE_ERROR', msg);
      }
    });

    socket.on('close', () => {
      socketClosed = true;
      wsLog('WebSocket closed: %s', session?.connectionId?.slice(0, 8) || 'no-session');
      if (session) {
        service.unregisterSession(session.connectionId);
      }
    });

    socket.on('error', (err) => {
      wsLog('WebSocket error: %O', err);
    });

    // Handler functions
    async function handleHandshake(msg: HandshakeMessage) {
      // Wire-version gate — checked FIRST, before the session guard and before
      // authenticating, so a peer on an incompatible protocol is rejected
      // without touching the store. Strict integer equality; an absent version
      // (a pre-versioning client) counts as a mismatch — that drift is exactly
      // what this guards against, so it is not silently accepted.
      if (msg.protocolVersion !== PROTOCOL_VERSION) {
        const clientPart = msg.protocolVersion === undefined
          ? 'client sent none (pre-versioning client)'
          : `client speaks v${msg.protocolVersion}`;
        sendError(
          'PROTOCOL_VERSION_MISMATCH',
          `Sync protocol version mismatch: server speaks v${PROTOCOL_VERSION}, ${clientPart}`,
          true,
        );
        socket.close(4003, 'Protocol version mismatch');
        return;
      }

      if (session) {
        sendError('ALREADY_AUTHENTICATED', 'Already authenticated', true);
        return;
      }

      if (!msg.databaseId) {
        sendError('MISSING_DATABASE_ID', 'databaseId is required', true);
        socket.close(4002, 'Missing databaseId');
        return;
      }

      try {
        const authContext = {
          databaseId: msg.databaseId,
          token: msg.token,
          siteIdRaw: msg.siteId,
          siteId: siteIdFromBase64(msg.siteId),
          socket,
          request,
        };
        const identity: ClientIdentity = await service.authenticate(authContext);

        session = await service.registerSession(msg.databaseId, socket, identity, authContext);

        // If socket closed during registration, the close handler couldn't
        // call unregisterSession because `session` wasn't assigned yet.
        // Clean up now that we have the connectionId.
        if (socketClosed) {
          service.unregisterSession(session.connectionId);
          session = null;
          return;
        }

        const serverSiteId = await service.getSiteId(msg.databaseId, identity);
        sendMessage({
          type: 'handshake_ack',
          databaseId: msg.databaseId,
          serverSiteId: siteIdToBase64(serverSiteId),
          connectionId: session.connectionId,
          // Echo the version so the client can run the same check in reverse.
          protocolVersion: PROTOCOL_VERSION,
        });

        wsLog('Handshake complete: %s (db: %s)', session.connectionId.slice(0, 8), msg.databaseId);
      } catch (err) {
        // If registerSession succeeded but a subsequent step threw,
        // clean up the registered session to release the store reference.
        if (session) {
          service.unregisterSession(session.connectionId);
          session = null;
        }
        const errMsg = err instanceof Error ? err.message : 'Authentication failed';
        sendError('AUTH_FAILED', errMsg, true);
        socket.close(4001, 'Authentication failed');
      }
    }

    async function handleGetChanges(msg: GetChangesMessage) {
      if (!session) {
        sendError('NOT_AUTHENTICATED', 'Must handshake first');
        return;
      }

      try {
        let sinceHLC: HLC | undefined;
        if (msg.sinceHLC) {
          sinceHLC = deserializeHLC(Buffer.from(msg.sinceHLC, 'base64'));
        }

        const changes = await service.getChangesSince(session.databaseId, session.identity, sinceHLC);

        // Serialize for JSON transport
        const serializedChanges = changes.map(cs => serializeChangeSet(cs));

        sendMessage({ type: 'changes', changeSets: serializedChanges });
      } catch (err) {
        const msg2 = err instanceof Error ? err.message : 'Failed to get changes';
        wsLog('get_changes error: %s', msg2);
        sendError('GET_CHANGES_ERROR', msg2);
      }
    }

    async function handleApplyChanges(msg: ApplyChangesMessage) {
      if (!session) {
        sendError('NOT_AUTHENTICATED', 'Must handshake first');
        return;
      }

      try {
        // Deserialize from JSON transport
        const changes: ChangeSet[] = msg.changes.map(cs => deserializeChangeSet(cs));

        const result = await service.applyChanges(session.databaseId, session.identity, changes);

        // Echo the client's correlation id so it can tie this ack to the exact
        // batch it sent. `requestId: undefined` is dropped by JSON.stringify, so
        // a push without one (or a legacy client) simply gets no id back.
        sendMessage({ type: 'apply_result', requestId: msg.requestId, ...result });
      } catch (err) {
        const msg2 = err instanceof Error ? err.message : 'Failed to apply changes';
        wsLog('apply_changes error: %s', msg2);
        sendError('APPLY_CHANGES_ERROR', msg2);
      }
    }

    async function handleGetSnapshot() {
      if (!session) {
        sendError('NOT_AUTHENTICATED', 'Must handshake first');
        return;
      }

      try {
        for await (const chunk of service.getSnapshotStream(session.databaseId, session.identity)) {
          sendMessage({ type: 'snapshot_chunk', chunk: serializeSnapshotChunk(chunk) });
        }
        sendMessage({ type: 'snapshot_complete' });
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Snapshot streaming failed';
        wsLog('get_snapshot error: %s', msg);
        sendError('SNAPSHOT_ERROR', msg);
      }
    }

    async function handleResumeSnapshot(msg: ResumeSnapshotMessage) {
      if (!session) {
        sendError('NOT_AUTHENTICATED', 'Must handshake first');
        return;
      }

      try {
        // The checkpoint arrives from JSON.parse in its serialized form (base64
        // siteId/HLC); decode before handing it to the service, which expects the
        // binary in-memory shape.
        const checkpoint = deserializeSnapshotCheckpoint(msg.checkpoint);
        for await (const chunk of service.resumeSnapshotStream(session.databaseId, session.identity, checkpoint)) {
          sendMessage({ type: 'snapshot_chunk', chunk: serializeSnapshotChunk(chunk) });
        }
        sendMessage({ type: 'snapshot_complete' });
      } catch (err) {
        const msg2 = err instanceof Error ? err.message : 'Snapshot resume failed';
        wsLog('resume_snapshot error: %s', msg2);
        sendError('SNAPSHOT_ERROR', msg2);
      }
    }
  }) as any);
}


