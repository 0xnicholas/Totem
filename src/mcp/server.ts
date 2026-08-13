import { randomUUID } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { Hono } from 'hono';
import {
  getCaller,
  getConnectionId,
  requireConnectionId,
  requireTenantKey,
} from '../auth.js';
import { isRecord } from '../admin/util.js';
import { TOTEM_VERSION } from '../version.js';
import type { McpAdapter } from './adapter.js';
import type { MCPKeyStore } from './key-store.js';

/** Per-request caller identity resolved by the auth middleware (tenant from the API key, connection from `x-connection-id`). */
interface CallerContext {
  tenantId: string;
  connectionId: string;
}

export interface McpAppConfig {
  adapter: McpAdapter;
  keys: MCPKeyStore;
}

/**
 * The MCP exposure layer (T5): a Streamable HTTP transport
 * (`@modelcontextprotocol/sdk`) mounted as a Hono app, authenticating every
 * request with a tenant API key (Bearer, verified against the hashed
 * store) and selecting the connection via the `x-connection-id` header
 * (query-param fallback). Tools and calls are resolved per (tenant,
 * connection) before anything reaches the protocol handlers (ADR-0002).
 *
 * Error mapping:
 * - missing/invalid/disabled/admin-scoped keys → HTTP 401, no MCP surface;
 * - unknown connection → HTTP 400 (the key is valid; the request is not);
 * - unknown tool → JSON-RPC `-32602` (per the MCP spec, a stale tool list);
 * - action failures → tool results with `isError: true`, with the ADR-0005
 *   vocabulary (code/message/retryable/upstream/details) in the message
 *   (StackOne's "tool failures are results, not JSON-RPC errors" pattern).
 */
export function createMcpApp(config: McpAppConfig): Hono {
  const { adapter, keys } = config;
  const sessions = new McpSessionManager(() => createSessionServer(adapter));
  const app = new Hono();

  // Caller identity resolves in the auth module (tenant from the API key,
  // connection from x-connection-id); this handler only wires the session.
  app.use('*', requireTenantKey(keys), requireConnectionId());
  app.all('*', async (c) => {
    const caller = getCaller(c);
    const connectionId = getConnectionId(c);

    const connection = await adapter.resolveConnection(caller.tenantId, connectionId);
    if (!connection) {
      return c.json({ error: `unknown connection "${connectionId}" for this tenant` }, 400);
    }

    const authInfo: AuthInfo = {
      token: caller.presented,
      clientId: caller.tenantId,
      scopes: ['actions'],
      extra: { tenantId: caller.tenantId, connectionId },
    };
    return sessions.handleRequest(c.req.raw, authInfo);
  });

  app.onError((err, c) => {
    console.error(err);
    return c.json({ error: 'internal_error' }, 500);
  });

  return app;
}

/**
 * One MCP server per session (the SDK allows a single transport per
 * `Server`), all sharing the same adapter. The handlers read the caller
 * context from `authInfo.extra`, which the auth middleware attaches to
 * every message of the request, so a session always acts on the
 * (tenant, connection) of the request that carried the message.
 */
function createSessionServer(adapter: McpAdapter): Server {
  const server = new Server(
    { name: 'totem', version: TOTEM_VERSION },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async (_request, extra) => {
    const ctx = callerContext(extra);
    const tools = await adapter.listTools(ctx.tenantId, ctx.connectionId);
    return { tools: tools as unknown as Tool[] };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const ctx = callerContext(extra);
    const actionName = request.params.name;

    const tool = await adapter.getTool(ctx.tenantId, ctx.connectionId, actionName);
    if (!tool) {
      // The tool list is a per-connection contract (ADR-0002); calling
      // something else is a stale client, which the spec maps to
      // invalid params.
      throw new McpError(ErrorCode.InvalidParams, `Unknown tool "${actionName}"`);
    }

    const result = await adapter.callTool(
      ctx.tenantId,
      ctx.connectionId,
      actionName,
      request.params.arguments ?? {},
    );

    if (result.ok) {
      return {
        content: [{ type: 'text', text: JSON.stringify(result.output) }],
        ...(isRecord(result.output) ? { structuredContent: result.output } : {}),
      };
    }
    // Tool-level failures are results, not JSON-RPC errors (StackOne
    // research); the unified error vocabulary (ADR-0005) rides in the
    // message so the agent's error handling stays uniform.
    return {
      content: [{ type: 'text', text: JSON.stringify(result.error.toJSON()) }],
      isError: true,
    };
  });

  return server;
}

/**
 * The only `RequestHandlerExtra` surface the handlers read: the auth
 * context the middleware attaches to every message.
 */
interface HandlerExtra {
  authInfo?: AuthInfo;
}

function callerContext(extra: HandlerExtra): CallerContext {
  const data = extra.authInfo?.extra;
  const tenantId = data?.tenantId;
  const connectionId = data?.connectionId;
  if (typeof tenantId !== 'string' || typeof connectionId !== 'string') {
    // Unreachable through the HTTP surface (the middleware always attaches
    // the context); guards against direct misuse of the Server.
    throw new McpError(ErrorCode.InternalError, 'Missing caller context');
  }
  return { tenantId, connectionId };
}

interface McpSession {
  transport: WebStandardStreamableHTTPServerTransport;
  server: Server;
  /** The tenant that created the session; reuse by another tenant is rejected. */
  tenantId: string;
}

/**
 * Owns the transport-per-session map for Streamable HTTP. A request
 * without an `Mcp-Session-Id` creates a session (the transport generates
 * the id on initialize); later requests with that id reuse it — but only
 * for the tenant that created it (session ids are unguessable UUIDs; the
 * tenant check is defense in depth against cross-tenant session reuse).
 * Sessions are removed on close (DELETE), transport teardown, and — for
 * requests that never initialized — immediately after the response.
 * Sessions never expire in v1 (a v2 concern alongside retention).
 */
class McpSessionManager {
  private readonly sessions = new Map<string, McpSession>();

  constructor(private readonly createServer: () => Server) {}

  async handleRequest(req: Request, authInfo: AuthInfo): Promise<Response> {
    const sessionId = req.headers.get('mcp-session-id');
    if (sessionId) {
      const session = this.sessions.get(sessionId);
      // Unknown session ids are 404 per the Streamable HTTP spec — as are
      // sessions owned by another tenant.
      if (!session || session.tenantId !== authInfo.extra?.tenantId) {
        return new Response('Session not found', { status: 404 });
      }
      return session.transport.handleRequest(req, { authInfo });
    }

    const server = this.createServer();
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      // The transport reports session close (DELETE) itself; the transport
      // teardown hook below covers every other path.
      onsessionclosed: (closedId) => {
        this.sessions.delete(closedId);
      },
    });
    // Runs before `server.connect` chains its own onclose, so this fires
    // first on any transport teardown.
    transport.onclose = () => {
      const closedId = transport.sessionId;
      if (closedId) this.sessions.delete(closedId);
    };
    await server.connect(transport);

    try {
      const response = await transport.handleRequest(req, { authInfo });
      const createdId = transport.sessionId;
      if (createdId) {
        const tenantId = authInfo.extra?.tenantId;
        if (typeof tenantId !== 'string') {
          await server.close().catch(() => {});
          throw new McpError(ErrorCode.InternalError, 'Missing caller context');
        }
        this.sessions.set(createdId, { transport, server, tenantId });
      } else {
        // No session was created (e.g. a malformed first request): the
        // pair is useless, tear it down so nothing leaks.
        await server.close().catch(() => {});
      }
      return response;
    } catch (err) {
      if (!transport.sessionId) await server.close().catch(() => {});
      throw err;
    }
  }
}
