/**
 * HTTP routes for sync operations.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { siteIdFromBase64, deserializeHLC, type HLC, type ChangeSet, type SerializedChangeSet } from '@quereus/sync';
import type { CoordinatorService } from '../service/coordinator-service.js';
import type { AuthContext, ClientIdentity } from '../service/types.js';
import { httpLog } from '../common/logger.js';
import { serializeChangeSet, deserializeChangeSet, serializeSnapshotChunk } from '../common/index.js';

/**
 * Register sync HTTP routes.
 */
export function registerRoutes(
  app: FastifyInstance,
  service: CoordinatorService,
  basePath: string
): void {
  // Helper to extract auth context from request
  const getAuthContext = (request: FastifyRequest, databaseId: string): AuthContext => {
    const authHeader = request.headers.authorization;
    const token = authHeader?.startsWith('Bearer ')
      ? authHeader.slice(7)
      : authHeader;

    const siteIdRaw = request.headers['x-site-id'] as string | undefined;

    return {
      databaseId,
      token,
      siteIdRaw,
      siteId: siteIdRaw ? siteIdFromBase64(siteIdRaw) : undefined,
      request,
    };
  };

  // Helper for error responses
  const errorResponse = (reply: FastifyReply, code: string, message: string, status = 400) => {
    return reply.status(status).send({
      ok: false,
      error: { code, message },
    });
  };

  // Validate database ID from path parameter
  const validateDatabaseId = (request: FastifyRequest, reply: FastifyReply): string | null => {
    const params = request.params as { databaseId?: string };
    const databaseId = params.databaseId;
    if (!databaseId || !service.isValidDatabaseId(databaseId)) {
      errorResponse(reply, 'INVALID_DATABASE_ID', `Invalid database ID: ${databaseId}`, 400);
      return null;
    }
    return databaseId;
  };

  // Authenticate and get client identity
  const authenticate = async (request: FastifyRequest, reply: FastifyReply, databaseId: string): Promise<ClientIdentity | null> => {
    try {
      const context = getAuthContext(request, databaseId);
      return await service.authenticate(context);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Authentication failed';
      errorResponse(reply, 'AUTH_FAILED', message, 401);
      return null;
    }
  };

  // GET /status - Health check and stats
  app.get(`${basePath}/status`, async (_request, reply) => {
    httpLog('GET %s/status', basePath);
    const status = service.getStatus();
    return reply.send({ ok: true, data: status });
  });

  // GET /metrics - Prometheus metrics
  app.get(`${basePath}/metrics`, async (_request, reply) => {
    httpLog('GET %s/metrics', basePath);
    const metrics = service.getMetrics();
    const output = metrics.registry.format();
    return reply
      .header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
      .send(output);
  });

  // GET /:databaseId/changes - Get changes since HLC
  app.get(`${basePath}/:databaseId/changes`, async (request, reply) => {
    const databaseId = validateDatabaseId(request, reply);
    if (!databaseId) return;

    httpLog('GET %s/%s/changes', basePath, databaseId);

    const client = await authenticate(request, reply, databaseId);
    if (!client) return;

    try {
      const query = request.query as { sinceHLC?: string };
      let sinceHLC: HLC | undefined;

      if (query.sinceHLC) {
        // HLC is passed as base64-encoded serialized form
        const hlcBytes = Buffer.from(query.sinceHLC, 'base64');
        sinceHLC = deserializeHLC(hlcBytes);
      }

      const changes = await service.getChangesSince(databaseId, client, sinceHLC);
      const serializedChanges = changes.map(cs => serializeChangeSet(cs));

      return reply.send({ ok: true, data: { changes: serializedChanges } });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to get changes';
      httpLog('GET /%s/changes error: %s', databaseId, message);
      return errorResponse(reply, 'GET_CHANGES_FAILED', message, 500);
    }
  });

  // POST /:databaseId/changes - Apply changes from client
  app.post(`${basePath}/:databaseId/changes`, async (request, reply) => {
    const databaseId = validateDatabaseId(request, reply);
    if (!databaseId) return;

    httpLog('POST %s/%s/changes', basePath, databaseId);

    const client = await authenticate(request, reply, databaseId);
    if (!client) return;

    try {
      const body = request.body as { changes: unknown[] };
      if (!body.changes || !Array.isArray(body.changes)) {
        return errorResponse(reply, 'INVALID_BODY', 'Request body must contain changes array');
      }

      // Untrusted HTTP JSON: cast to the wire shape at the codec boundary. The
      // codec reads defensively, so malformed input degrades the same way it did
      // before this codec was shared.
      // NOTE: unlike the WebSocket path, these REST endpoints carry no
      // protocolVersion and run no version gate — a purely-HTTP client on a
      // drifted PROTOCOL_VERSION is not detected here. Fine while all first-party
      // clients sync over WebSocket (which IS gated); if a REST-only client ever
      // ships, add version negotiation to these routes (header or body field).
      const changes: ChangeSet[] = body.changes.map(cs => deserializeChangeSet(cs as SerializedChangeSet));

      const result = await service.applyChanges(databaseId, client, changes);
      return reply.send({ ok: true, data: result });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to apply changes';
      httpLog('POST /%s/changes error: %s', databaseId, message);
      return errorResponse(reply, 'APPLY_CHANGES_FAILED', message, 500);
    }
  });

  // GET /:databaseId/snapshot - Stream full snapshot
  app.get(`${basePath}/:databaseId/snapshot`, async (request, reply) => {
    const databaseId = validateDatabaseId(request, reply);
    if (!databaseId) return;

    httpLog('GET %s/%s/snapshot', basePath, databaseId);

    const client = await authenticate(request, reply, databaseId);
    if (!client) return;

    try {
      // Stream snapshot as newline-delimited JSON
      reply.raw.setHeader('Content-Type', 'application/x-ndjson');
      reply.raw.setHeader('Transfer-Encoding', 'chunked');

      for await (const chunk of service.getSnapshotStream(databaseId, client)) {
        const serialized = JSON.stringify(serializeSnapshotChunk(chunk)) + '\n';
        reply.raw.write(serialized);
      }

      reply.raw.end();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to get snapshot';
      httpLog('GET /%s/snapshot error: %s', databaseId, message);
      // Write an error chunk so NDJSON clients can detect the failure
      reply.raw.write(JSON.stringify({ error: message }) + '\n');
      reply.raw.end();
    }
  });
}

