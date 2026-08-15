import type {
  ApiKeyScope,
  AuditFilters,
  AuditRow,
  ConnectionView,
  Tenant,
  TenantAuditPolicy,
  TenantAuditPolicyPatch,
  TenantDefenderPolicy,
  TenantDefenderPolicyPatch,
} from './repo.js';
import { isRecord } from './util.js';

export interface AdminApiClientOptions {
  baseUrl: string;
  apiKey: string;
  /** Injectable for tests (mocked at the HTTP boundary). */
  fetch?: typeof fetch;
}

export interface IssuedKey {
  key: string;
  id: string;
  scope: ApiKeyScope;
  prefix: string;
}

/** Non-2xx admin API response. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/**
 * HTTP client for the admin API, used by totemctl. Thin: one method per
 * route, JSON in/out, `Authorization: Bearer <admin key>` on every request.
 */
export class AdminApiClient {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: AdminApiClientOptions) {
    this.fetchImpl = options.fetch ?? fetch;
  }

  createTenant(name: string): Promise<Tenant> {
    return this.request('POST', '/admin/tenants', { name });
  }

  createKey(tenantId: string, scope: ApiKeyScope): Promise<IssuedKey> {
    return this.request('POST', `/admin/tenants/${encodeURIComponent(tenantId)}/keys`, { scope });
  }

  disableKey(tenantId: string, keyId: string): Promise<{ changed: boolean }> {
    return this.request(
      'POST',
      `/admin/tenants/${encodeURIComponent(tenantId)}/keys/${encodeURIComponent(keyId)}/disable`,
    );
  }

  setFeishuCreds(tenantId: string, appId: string, appSecret: string): Promise<{ ok: true }> {
    return this.request('POST', `/admin/tenants/${encodeURIComponent(tenantId)}/feishu-creds`, {
      appId,
      appSecret,
    });
  }

  setDingTalkCreds(
    tenantId: string,
    appKey: string,
    appSecret: string,
    robotCode?: string,
  ): Promise<{ ok: true }> {
    return this.request('POST', `/admin/tenants/${encodeURIComponent(tenantId)}/dingtalk-creds`, {
      appKey,
      appSecret,
      ...(robotCode !== undefined ? { robotCode } : {}),
    });
  }

  setAllowlist(
    connectionId: string,
    actions: string[],
    acknowledge?: { allowDestructive?: boolean },
  ): Promise<{ ok: true }> {
    return this.request('PUT', `/admin/connections/${encodeURIComponent(connectionId)}/allowlist`, {
      actions,
      ...(acknowledge?.allowDestructive === true ? { allowDestructive: true } : {}),
    });
  }

  suspendConnection(connectionId: string): Promise<{ ok: true }> {
    return this.request(
      'POST',
      `/admin/connections/${encodeURIComponent(connectionId)}/suspend`,
    );
  }

  resumeConnection(connectionId: string): Promise<{ ok: true }> {
    return this.request('POST', `/admin/connections/${encodeURIComponent(connectionId)}/resume`);
  }

  startOAuth(
    tenantId: string,
    redirectUri?: string,
    connectionId?: string,
    connectorId?: string,
  ): Promise<{ authorizationUrl: string }> {
    const body: Record<string, string> = {};
    if (redirectUri !== undefined) body.redirectUri = redirectUri;
    if (connectionId !== undefined) body.connectionId = connectionId;
    if (connectorId !== undefined) body.connectorId = connectorId;
    return this.request(
      'POST',
      `/admin/tenants/${encodeURIComponent(tenantId)}/oauth/start`,
      body,
    );
  }

  listConnections(tenantId: string): Promise<{ connections: ConnectionView[] }> {
    return this.request('GET', `/admin/tenants/${encodeURIComponent(tenantId)}/connections`);
  }

  queryAudit(tenantId: string, filters: AuditFilters): Promise<{ rows: AuditRow[] }> {
    const params = new URLSearchParams();
    if (filters.userId !== undefined) params.set('user', filters.userId);
    if (filters.action !== undefined) params.set('action', filters.action);
    if (filters.since !== undefined) params.set('since', filters.since);
    if (filters.source !== undefined) params.set('source', filters.source);
    if (filters.success !== undefined) params.set('success', String(filters.success));
    if (filters.destructive !== undefined) params.set('destructive', String(filters.destructive));
    const query = params.toString();
    return this.request(
      'GET',
      `/admin/tenants/${encodeURIComponent(tenantId)}/audit${query ? `?${query}` : ''}`,
    );
  }

  getAuditPolicy(tenantId: string): Promise<TenantAuditPolicy> {
    return this.request(
      'GET',
      `/admin/tenants/${encodeURIComponent(tenantId)}/audit-policy`,
    );
  }

  setAuditPolicy(tenantId: string, patch: TenantAuditPolicyPatch): Promise<TenantAuditPolicy> {
    return this.request(
      'PUT',
      `/admin/tenants/${encodeURIComponent(tenantId)}/audit-policy`,
      patch,
    );
  }

  getDefenderPolicy(tenantId: string): Promise<TenantDefenderPolicy> {
    return this.request(
      'GET',
      `/admin/tenants/${encodeURIComponent(tenantId)}/defender-policy`,
    );
  }

  setDefenderPolicy(
    tenantId: string,
    patch: TenantDefenderPolicyPatch,
  ): Promise<TenantDefenderPolicy> {
    return this.request(
      'PUT',
      `/admin/tenants/${encodeURIComponent(tenantId)}/defender-policy`,
      patch,
    );
  }

  purgeAudit(tenantId: string): Promise<{ deleted: number }> {
    return this.request('POST', `/admin/tenants/${encodeURIComponent(tenantId)}/audit/purge`);
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await this.fetchImpl(`${this.options.baseUrl}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.options.apiKey}`,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let payload: unknown = null;
    try {
      payload = await response.json();
    } catch {
      // No body; leave payload null.
    }
    if (!response.ok) {
      const message =
        isRecord(payload) && typeof payload.error === 'string'
          ? payload.error
          : `HTTP ${response.status}`;
      throw new ApiError(response.status, message);
    }
    return payload as T;
  }
}
