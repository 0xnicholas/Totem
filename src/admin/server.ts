import { createHash, timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import type { Context } from 'hono';
import { generateApiKey, hashApiKey, keyPrefixForEnv } from './keys.js';
import { NotFoundError, type AdminRepository, type AuditFilters, type AuditSource } from './repo.js';
import { isRecord } from './util.js';

export interface AdminAppConfig {
  repo: AdminRepository;
  /** Platform admin key (separate from tenant keys); all /admin routes require it. */
  adminKey: string;
  /** Key prefix: tt_live_ in production, tt_dev_ otherwise. */
  production?: boolean;
}

/**
 * Admin HTTP API (T3): the operator surface backed by `AdminRepository`.
 * Authenticates with `Authorization: Bearer` — either the bootstrap admin
 * key (env `TOTEM_ADMIN_KEY`, compared constant-time against its SHA-256)
 * or any enabled admin-scoped tenant key (`create-key --scope admin`).
 * Every mutation is audited by the repository.
 */
export function createAdminApp(config: AdminAppConfig): Hono {
  const { repo } = config;
  const adminKeyHash = createHash('sha256').update(config.adminKey).digest();
  const production = config.production ?? false;

  const app = new Hono();

  app.use('/admin/*', async (c, next) => {
    const header = c.req.header('authorization');
    const presented = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : undefined;
    if (!presented) return c.json({ error: 'unauthorized' }, 401);
    const presentedHash = createHash('sha256').update(presented).digest();
    if (timingSafeEqual(presentedHash, adminKeyHash)) {
      await next();
      return;
    }
    // Admin-scoped tenant keys are also admin credentials (T3 amendment).
    const adminKey = await repo.findAdminKey(hashApiKey(presented));
    if (!adminKey) return c.json({ error: 'unauthorized' }, 401);
    await next();
  });

  app.get('/healthz', (c) => c.json({ status: 'ok' }));

  app.post('/admin/tenants', async (c) => {
    const body = await readJson(c);
    if (!isRecord(body) || typeof body.name !== 'string' || body.name.trim() === '') {
      return badRequest(c, 'body must include a non-empty "name"');
    }
    const tenant = await repo.createTenant(body.name.trim());
    return c.json(tenant, 201);
  });

  app.post('/admin/tenants/:tenantId/keys', async (c) => {
    const body = await readJson(c);
    const scope = isRecord(body) ? body.scope : undefined;
    if (scope !== 'actions' && scope !== 'admin') {
      return badRequest(c, '"scope" must be "actions" or "admin"');
    }
    const generated = generateApiKey(keyPrefixForEnv(production), scope);
    const record = await repo.createApiKey(c.req.param('tenantId'), scope, {
      prefix: generated.prefix,
      keyHash: generated.keyHash,
    });
    return c.json(
      { key: generated.plaintext, id: record.id, scope: record.scope, prefix: record.prefix },
      201,
    );
  });

  app.post('/admin/tenants/:tenantId/keys/:keyId/disable', async (c) => {
    const tenantId = c.req.param('tenantId');
    const keyId = c.req.param('keyId');
    const key = await repo.getApiKey(tenantId, keyId);
    if (!key) return notFound(c, `Key "${keyId}" not found for tenant "${tenantId}"`);
    const changed = await repo.disableApiKey(tenantId, keyId);
    return c.json({ changed });
  });

  app.post('/admin/tenants/:tenantId/feishu-creds', async (c) => {
    const body = await readJson(c);
    if (
      !isRecord(body) ||
      typeof body.appId !== 'string' ||
      body.appId === '' ||
      typeof body.appSecret !== 'string' ||
      body.appSecret === ''
    ) {
      return badRequest(c, 'body must include non-empty "appId" and "appSecret"');
    }
    await repo.setFeishuCreds(c.req.param('tenantId'), {
      appId: body.appId,
      appSecret: body.appSecret,
    });
    return c.json({ ok: true });
  });

  app.put('/admin/connections/:connectionId/allowlist', async (c) => {
    const body = await readJson(c);
    if (
      !isRecord(body) ||
      !Array.isArray(body.actions) ||
      !body.actions.every((a) => typeof a === 'string')
    ) {
      return badRequest(c, 'body must include an "actions" array of strings');
    }
    await repo.setAllowlist(c.req.param('connectionId'), body.actions);
    return c.json({ ok: true });
  });

  app.post('/admin/connections/:connectionId/suspend', async (c) => {
    await repo.suspendConnection(c.req.param('connectionId'), true);
    return c.json({ ok: true });
  });

  app.post('/admin/connections/:connectionId/resume', async (c) => {
    await repo.suspendConnection(c.req.param('connectionId'), false);
    return c.json({ ok: true });
  });

  app.get('/admin/tenants/:tenantId/audit', async (c) => {
    const query = c.req.query();
    const filters: AuditFilters = {};
    if (query.user !== undefined && query.user !== '') filters.userId = query.user;
    if (query.action !== undefined && query.action !== '') filters.action = query.action;
    if (query.since !== undefined && query.since !== '') filters.since = query.since;
    if (query.source !== undefined && query.source !== '') {
      if (!isAuditSource(query.source)) return badRequest(c, '"source" must be mcp, admin_api or cli');
      filters.source = query.source;
    }
    if (query.success !== undefined && query.success !== '') {
      if (query.success !== 'true' && query.success !== 'false') {
        return badRequest(c, '"success" must be true or false');
      }
      filters.success = query.success === 'true';
    }
    const rows = await repo.queryAudit(c.req.param('tenantId'), filters);
    return c.json({ rows });
  });

  app.notFound((c) => notFound(c, 'route not found'));

  app.onError((err, c) => {
    if (err instanceof NotFoundError) return notFound(c, err.message);
    console.error(err);
    return c.json({ error: 'internal_error' }, 500);
  });

  return app;
}

async function readJson(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return undefined;
  }
}

function isAuditSource(value: string): value is AuditSource {
  return value === 'mcp' || value === 'admin_api' || value === 'cli';
}

function badRequest(c: Context, message: string): Response {
  return c.json({ error: message }, 400);
}

function notFound(c: Context, message: string): Response {
  return c.json({ error: message }, 404);
}
