import { createHash, timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { FlowError, type OAuthFlow } from '../feishu/flow.js';
import { generateApiKey, hashApiKey, keyPrefixForEnv } from './keys.js';
import {
  NotFoundError,
  type AdminRepository,
  type AuditFilters,
  type AuditSource,
  type TenantAuditPolicyPatch,
  type TenantDefenderPolicyPatch,
} from './repo.js';
import { isRecord } from './util.js';

export interface AdminAppConfig {
  repo: AdminRepository;
  /** Platform admin key (separate from tenant keys); all /admin routes require it. */
  adminKey: string;
  /** Key prefix: tt_live_ in production, tt_dev_ otherwise. */
  production?: boolean;
  /**
   * The Feishu OAuth flow (T6). When absent the oauth routes are not
   * registered.
   */
  oauth?: OAuthFlow;
  /**
   * Encrypts tenant secrets before storage (issue #15). When absent,
   * secrets are stored as given (test/dev convenience only; the server
   * entry always wires the real cipher).
   */
  secretCipher?: { encrypt(tenantId: string, plaintext: string): string };
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
    // Encrypt at rest with the per-tenant key when the cipher is wired
    // (issue #15); the plaintext never reaches the repository.
    const storedSecret = config.secretCipher
      ? config.secretCipher.encrypt(c.req.param('tenantId'), body.appSecret)
      : body.appSecret;
    await repo.setFeishuCreds(c.req.param('tenantId'), {
      appId: body.appId,
      appSecret: storedSecret,
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

  app.get('/admin/tenants/:tenantId/audit-policy', async (c) => {
    const policy = await repo.getAuditPolicy(c.req.param('tenantId'));
    return c.json(policy);
  });

  app.put('/admin/tenants/:tenantId/audit-policy', async (c) => {
    const body = await readJson(c);
    if (!isRecord(body) || !isAuditPolicyPatch(body)) {
      return badRequest(
        c,
        'body must be an object with optional "retentionDays" (integer 1–3650), "errorOnly" and "captureBody" (booleans)',
      );
    }
    const policy = await repo.setAuditPolicy(c.req.param('tenantId'), body);
    return c.json(policy);
  });

  app.get('/admin/tenants/:tenantId/defender-policy', async (c) => {
    const policy = await repo.getDefenderPolicy(c.req.param('tenantId'));
    return c.json(policy);
  });

  app.put('/admin/tenants/:tenantId/defender-policy', async (c) => {
    const body = await readJson(c);
    if (!isRecord(body) || !isDefenderPolicyPatch(body)) {
      return badRequest(
        c,
        'body must be an object with optional "enabled" and "blockHighRisk" (booleans)',
      );
    }
    const policy = await repo.setDefenderPolicy(c.req.param('tenantId'), body);
    return c.json(policy);
  });

  app.post('/admin/tenants/:tenantId/audit/purge', async (c) => {
    const { deleted } = await repo.purgeAudit(c.req.param('tenantId'));
    return c.json({ deleted });
  });

  app.post('/admin/tenants/:tenantId/oauth/start', async (c) => {
    if (!config.oauth) return notFound(c, 'route not found');
    const body = await readJson(c);
    const redirectUri =
      isRecord(body) && typeof body.redirectUri === 'string' && body.redirectUri !== ''
        ? body.redirectUri
        : process.env.TOTEM_OAUTH_REDIRECT_URI;
    if (!redirectUri) {
      return badRequest(c, 'body must include "redirectUri" (or set TOTEM_OAUTH_REDIRECT_URI)');
    }
    const connectionId =
      isRecord(body) && typeof body.connectionId === 'string' && body.connectionId !== ''
        ? body.connectionId
        : undefined;
    try {
      const { authorizationUrl } = await config.oauth.start(
        c.req.param('tenantId'),
        redirectUri,
        connectionId !== undefined ? { connectionId } : undefined,
      );
      return c.json({ authorizationUrl });
    } catch (err) {
      if (err instanceof FlowError) return c.json({ error: err.message }, flowStatus(err));
      throw err;
    }
  });

  app.get('/admin/tenants/:tenantId/connections', async (c) => {
    const connections = await repo.listConnections(c.req.param('tenantId'));
    return c.json({ connections });
  });

  // Public callback: Feishu redirects the user's browser here after
  // authorization. State validation is the flow's job; no admin key is
  // involved (the browser cannot carry one).
  app.get('/oauth/callback/feishu', async (c) => {
    if (!config.oauth) return notFound(c, 'route not found');
    const code = c.req.query('code') ?? '';
    const state = c.req.query('state') ?? '';
    if (code === '' || state === '') {
      return badRequest(c, 'missing "code" or "state" query parameters');
    }
    try {
      await config.oauth.handleCallback(code, state);
    } catch (err) {
      if (err instanceof FlowError) return c.json({ error: err.message }, flowStatus(err));
      throw err;
    }
    return c.html(
      '<html><body><h2>Authorization complete</h2>' +
        '<p>You can close this window and return to the terminal.</p></body></html>',
    );
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

function isAuditPolicyPatch(value: unknown): value is TenantAuditPolicyPatch {
  if (!isRecord(value)) return false;
  const { retentionDays, errorOnly, captureBody } = value;
  if (retentionDays !== undefined) {
    if (typeof retentionDays !== 'number' || !Number.isInteger(retentionDays)) return false;
    if (retentionDays < 1 || retentionDays > 3650) return false;
  }
  if (errorOnly !== undefined && typeof errorOnly !== 'boolean') return false;
  if (captureBody !== undefined && typeof captureBody !== 'boolean') return false;
  for (const key of Object.keys(value)) {
    if (key !== 'retentionDays' && key !== 'errorOnly' && key !== 'captureBody') return false;
  }
  return true;
}

function isDefenderPolicyPatch(value: unknown): value is TenantDefenderPolicyPatch {
  if (!isRecord(value)) return false;
  const { enabled, blockHighRisk } = value;
  if (enabled !== undefined && typeof enabled !== 'boolean') return false;
  if (blockHighRisk !== undefined && typeof blockHighRisk !== 'boolean') return false;
  for (const key of Object.keys(value)) {
    if (key !== 'enabled' && key !== 'blockHighRisk') return false;
  }
  return true;
}

function badRequest(c: Context, message: string): Response {
  return c.json({ error: message }, 400);
}

function notFound(c: Context, message: string): Response {
  return c.json({ error: message }, 404);
}

function flowStatus(err: FlowError): ContentfulStatusCode {
  return err.status >= 500 ? 500 : 400;
}
