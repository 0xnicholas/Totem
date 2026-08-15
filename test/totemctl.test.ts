import { afterEach, describe, expect, it, vi } from 'vitest';
import { AdminApiClient } from '../src/admin/client.js';
import { run, type CommandIO } from '../src/cli/commands.js';

const ADMIN_KEY = 'test-admin-key';

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** JSON response helper so mocks don't need `async`/`await`. */
function okJson(payload: unknown, status = 200): Promise<Response> {
  return Promise.resolve(
    new Response(JSON.stringify(payload), {
      status,
      headers: { 'content-type': 'application/json' },
    }),
  );
}

function makeHarness(fetchImpl: FetchLike) {
  const client = new AdminApiClient({
    baseUrl: 'http://api.test',
    apiKey: ADMIN_KEY,
    fetch: fetchImpl,
  });
  const stdout: string[] = [];
  const stderr: string[] = [];
  const io: CommandIO = {
    client,
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line),
  };
  return { io, stdout, stderr };
}

describe('totemctl commands (HTTP boundary mocked)', () => {
  it('create-tenant POSTs the name and prints the tenant id', async () => {
    const tenantId = '11111111-1111-4111-8111-111111111111';
    const fetchMock = vi.fn<FetchLike>(() => okJson({ id: tenantId, name: 'acme' }, 201));
    const { io, stdout } = makeHarness(fetchMock);

    const code = await run(['create-tenant', 'acme'], io);

    expect(code).toBe(0);
    expect(fetchMock).toHaveBeenCalledWith('http://api.test/admin/tenants', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${ADMIN_KEY}`,
      },
      body: JSON.stringify({ name: 'acme' }),
    });
    expect(stdout).toEqual([tenantId]);
  });

  it('create-key defaults to scope actions and prints the plaintext key once', async () => {
    const fetchMock = vi.fn<FetchLike>(() =>
      okJson({ key: 'tt_dev_secret123', id: 'key-1', scope: 'actions', prefix: 'tt_dev_' }, 201),
    );
    const { io, stdout } = makeHarness(fetchMock);

    const code = await run(['create-key', 'tenant-1'], io);

    expect(code).toBe(0);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://api.test/admin/tenants/tenant-1/keys',
      expect.objectContaining({ body: JSON.stringify({ scope: 'actions' }) }),
    );
    expect(stdout).toEqual(['tt_dev_secret123']);
  });

  it('create-key --scope admin passes the scope through', async () => {
    const fetchMock = vi.fn<FetchLike>(() =>
      okJson({ key: 'k', id: 'key-1', scope: 'admin', prefix: 'tt_dev_' }, 201),
    );
    const { io } = makeHarness(fetchMock);

    const code = await run(['create-key', 'tenant-1', '--scope', 'admin'], io);
    expect(code).toBe(0);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://api.test/admin/tenants/tenant-1/keys',
      expect.objectContaining({ body: JSON.stringify({ scope: 'admin' }) }),
    );
  });

  it('disable-key and revoke-key both hit the disable route', async () => {
    for (const command of ['disable-key', 'revoke-key']) {
      const fetchMock = vi.fn<FetchLike>(() => okJson({ changed: true }));
      const { io, stdout } = makeHarness(fetchMock);

      const code = await run([command, 'tenant-1', 'key-1'], io);
      expect(code).toBe(0);
      expect(fetchMock).toHaveBeenCalledWith(
        'http://api.test/admin/tenants/tenant-1/keys/key-1/disable',
        expect.objectContaining({ method: 'POST' }),
      );
      expect(stdout[0]).toBe('Key key-1 disabled');
    }
  });

  it('set-feishu-creds POSTs appId and appSecret', async () => {
    const fetchMock = vi.fn<FetchLike>(() => okJson({ ok: true }));
    const { io, stdout } = makeHarness(fetchMock);

    const code = await run(['set-feishu-creds', 'tenant-1', 'cli_app_id', 's3cret'], io);
    expect(code).toBe(0);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://api.test/admin/tenants/tenant-1/feishu-creds',
      expect.objectContaining({
        body: JSON.stringify({ appId: 'cli_app_id', appSecret: 's3cret' }),
      }),
    );
    expect(stdout[0]).toContain('tenant-1');
  });

  it('set-dingtalk-creds POSTs appKey and appSecret (T17a)', async () => {
    const fetchMock = vi.fn<FetchLike>(() => okJson({ ok: true }));
    const { io, stdout } = makeHarness(fetchMock);

    const code = await run(['set-dingtalk-creds', 'tenant-1', 'cli_app_key', 's3cret'], io);
    expect(code).toBe(0);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://api.test/admin/tenants/tenant-1/dingtalk-creds',
      expect.objectContaining({
        body: JSON.stringify({ appKey: 'cli_app_key', appSecret: 's3cret' }),
      }),
    );
    expect(stdout[0]).toContain('tenant-1');
  });

  it('set-dingtalk-creds POSTs the optional robotCode (#49)', async () => {
    const fetchMock = vi.fn<FetchLike>(() => okJson({ ok: true }));
    const { io } = makeHarness(fetchMock);

    const code = await run(
      ['set-dingtalk-creds', 'tenant-1', 'cli_app_key', 's3cret', 'robot-1'],
      io,
    );
    expect(code).toBe(0);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://api.test/admin/tenants/tenant-1/dingtalk-creds',
      expect.objectContaining({
        body: JSON.stringify({ appKey: 'cli_app_key', appSecret: 's3cret', robotCode: 'robot-1' }),
      }),
    );
  });

  it('set-allowlist PUTs the actions', async () => {
    const fetchMock = vi.fn<FetchLike>(() => okJson({ ok: true }));
    const { io, stdout } = makeHarness(fetchMock);

    const code = await run(['set-allowlist', 'conn-1', 'create_doc', 'get_doc_content'], io);
    expect(code).toBe(0);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://api.test/admin/connections/conn-1/allowlist',
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({ actions: ['create_doc', 'get_doc_content'] }),
      }),
    );
    expect(stdout[0]).toBe('Allowlist for connection conn-1: create_doc, get_doc_content');
  });

  it('set-allowlist --allow-destructive true acknowledges the destructive class (ADR-0018)', async () => {
    const fetchMock = vi.fn<FetchLike>(() => okJson({ ok: true }));
    const { io, stdout } = makeHarness(fetchMock);

    const code = await run(
      ['set-allowlist', 'conn-1', 'delete_doc', '--allow-destructive', 'true'],
      io,
    );
    expect(code).toBe(0);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://api.test/admin/connections/conn-1/allowlist',
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({ actions: ['delete_doc'], allowDestructive: true }),
      }),
    );
    expect(stdout[0]).toBe('Allowlist for connection conn-1: delete_doc (destructive acknowledged)');
  });

  it('suspend-connection and resume-connection hit their routes', async () => {
    const fetchMock = vi.fn<FetchLike>(() => okJson({ ok: true }));
    const { io } = makeHarness(fetchMock);

    expect(await run(['suspend-connection', 'conn-1'], io)).toBe(0);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://api.test/admin/connections/conn-1/suspend',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(await run(['resume-connection', 'conn-1'], io)).toBe(0);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://api.test/admin/connections/conn-1/resume',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('query-audit sends filters as query params and prints tab-separated rows', async () => {
    const rows = [
      {
        id: 'a1',
        tenantId: 't1',
        connectionId: null,
        userId: 'admin',
        actionName: 'admin.tenant_created',
        paramHash: 'h',
        source: 'admin_api',
        success: true,
        errorCode: null,
        durationMs: 0,
        createdAt: '2026-08-09T10:00:00.000Z',
      },
    ];
    const fetchMock = vi.fn<FetchLike>(() => okJson({ rows }));
    const { io, stdout } = makeHarness(fetchMock);

    const code = await run(
      [
        'query-audit',
        'tenant-1',
        '--user',
        'admin',
        '--action',
        'admin.tenant_created',
        '--since',
        '2026-08-01T00:00:00Z',
        '--source',
        'admin_api',
        '--success',
        'true',
      ],
      io,
    );

    expect(code).toBe(0);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://api.test/admin/tenants/tenant-1/audit?user=admin&action=admin.tenant_created&since=2026-08-01T00%3A00%3A00Z&source=admin_api&success=true',
      expect.objectContaining({ method: 'GET' }),
    );
    expect(stdout[0]).toBe('2026-08-09T10:00:00.000Z\tadmin.tenant_created\tadmin\tadmin_api\tok\t');
  });

  it('query-audit --destructive filters and marks destructive rows (ADR-0018)', async () => {
    const rows = [
      {
        id: 'd1',
        tenantId: 't1',
        connectionId: 'c1',
        userId: null,
        actionName: 'delete_doc',
        paramHash: 'h',
        source: 'mcp',
        success: true,
        errorCode: null,
        durationMs: 3,
        createdAt: '2026-08-15T09:00:00.000Z',
        metadata: { effects: 'destructive' },
      },
      {
        id: 'd2',
        tenantId: 't1',
        connectionId: 'c1',
        userId: null,
        actionName: 'create_doc',
        paramHash: 'h',
        source: 'mcp',
        success: true,
        errorCode: null,
        durationMs: 3,
        createdAt: '2026-08-15T09:01:00.000Z',
      },
    ];
    const fetchMock = vi.fn<FetchLike>(() => okJson({ rows }));
    const { io, stdout } = makeHarness(fetchMock);

    const code = await run(
      ['query-audit', 'tenant-1', '--destructive', 'true'],
      io,
    );
    expect(code).toBe(0);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://api.test/admin/tenants/tenant-1/audit?destructive=true',
      expect.objectContaining({ method: 'GET' }),
    );
    // The destructive row carries the prominent marker; the plain row does not.
    expect(stdout[0]).toBe('2026-08-15T09:00:00.000Z\tdelete_doc\t-\tmcp\tok\t\tDESTRUCTIVE');
    expect(stdout[1]).toBe('2026-08-15T09:01:00.000Z\tcreate_doc\t-\tmcp\tok\t');
  });

  it('propagates API errors to stderr with exit code 1', async () => {
    const fetchMock = vi.fn<FetchLike>(() =>
      okJson({ error: 'Tenant "nope" not found' }, 404),
    );
    const { io, stderr } = makeHarness(fetchMock);

    const code = await run(['set-feishu-creds', 'nope', 'a', 'b'], io);
    expect(code).toBe(1);
    expect(stderr).toEqual(['error: Tenant "nope" not found']);
  });

  it('reports usage errors with exit code 2', async () => {
    const fetchMock = vi.fn<FetchLike>(() => okJson({}));
    const { io, stderr } = makeHarness(fetchMock);
    expect(await run(['create-tenant'], io)).toBe(2);
    expect(stderr[0]).toContain('usage:');
    expect(await run(['frobnicate'], io)).toBe(2);
  });

  it('help prints usage and exits 0', async () => {
    const fetchMock = vi.fn<FetchLike>(() => okJson({}));
    const { io, stdout } = makeHarness(fetchMock);
    expect(await run(['help'], io)).toBe(0);
    expect(stdout[0]).toContain('totemctl');
  });
});

describe('totemctl oauth + connections (T6)', () => {
  it('oauth-start prints the authorization URL for the operator', async () => {
    const fetchMock = vi.fn<FetchLike>(() =>
      okJson({ authorizationUrl: 'https://open.feishu.cn/open-apis/authen/v1/authorize?app_id=a' }),
    );
    const { io, stdout } = makeHarness(fetchMock);

    const code = await run(
      ['oauth-start', 'tenant-1', 'https://totem.example.com/oauth/callback/feishu'],
      io,
    );
    expect(code).toBe(0);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://api.test/admin/tenants/tenant-1/oauth/start',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ redirectUri: 'https://totem.example.com/oauth/callback/feishu' }),
      }),
    );
    expect(stdout[0]).toContain('https://open.feishu.cn/');
    expect(stdout[1]).toContain('Open the URL above');
  });

  it('oauth-start --connector dingtalk_docs requests the DingTalk flow (T17a)', async () => {
    const fetchMock = vi.fn<FetchLike>(() =>
      okJson({ authorizationUrl: 'https://login.dingtalk.com/oauth2/auth?client_id=a' }),
    );
    const { io, stdout } = makeHarness(fetchMock);

    const code = await run(
      ['oauth-start', 'tenant-1', 'https://totem.example.com/oauth/callback/dingtalk', '--connector', 'dingtalk_docs'],
      io,
    );
    expect(code).toBe(0);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://api.test/admin/tenants/tenant-1/oauth/start',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          redirectUri: 'https://totem.example.com/oauth/callback/dingtalk',
          connectorId: 'dingtalk_docs',
        }),
      }),
    );
    expect(stdout[0]).toContain('https://login.dingtalk.com/');
    expect(stdout[1]).toContain('DingTalk');
  });

  it('oauth-start rejects an unknown --connector value', async () => {
    const { io, stderr } = makeHarness(vi.fn<FetchLike>());
    const code = await run(
      ['oauth-start', 'tenant-1', 'https://totem.example.com/oauth/callback/x', '--connector', 'nope'],
      io,
    );
    expect(code).toBe(2);
    expect(stderr[0]).toContain('--connector');
  });

  it('oauth-start without a redirect-uri is a usage error', async () => {
    const { io, stderr } = makeHarness(vi.fn<FetchLike>());
    const code = await run(['oauth-start', 'tenant-1'], io);
    expect(code).toBe(2);
    expect(stderr[0]).toContain('redirect-uri');
  });

  it('list-connections prints id, name, connector and auth state', async () => {
    const fetchMock = vi.fn<FetchLike>(() =>
      okJson({
        connections: [
          {
            id: 'conn-1',
            tenantId: 'tenant-1',
            connectorId: 'feishu_docs',
            name: 'feishu',
            status: 'active',
            ownerId: 'tenant-1',
            oauthRedirectUri: 'https://totem.example.com/oauth/callback/feishu',
            createdAt: '2026-01-01T00:00:00.000Z',
          },
          {
            id: 'conn-2',
            tenantId: 'tenant-1',
            connectorId: 'feishu_docs',
            name: 'feishu',
            status: 'auth_expired',
            ownerId: 'tenant-1',
            oauthRedirectUri: null,
            createdAt: '2026-01-02T00:00:00.000Z',
          },
        ],
      }),
    );
    const { io, stdout } = makeHarness(fetchMock);

    const code = await run(['list-connections', 'tenant-1'], io);
    expect(code).toBe(0);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://api.test/admin/tenants/tenant-1/connections',
      expect.objectContaining({ method: 'GET' }),
    );
    expect(stdout).toEqual([
      'conn-1\tfeishu\tfeishu_docs\tactive',
      'conn-2\tfeishu\tfeishu_docs\tauth_expired',
    ]);
  });
});

describe('totemctl oauth-start env fallback + re-auth flag (T6 review follow-up)', () => {
  const saved = process.env.TOTEM_OAUTH_REDIRECT_URI;

  afterEach(() => {
    if (saved === undefined) delete process.env.TOTEM_OAUTH_REDIRECT_URI;
    else process.env.TOTEM_OAUTH_REDIRECT_URI = saved;
  });

  it('falls back to TOTEM_OAUTH_REDIRECT_URI when the positional is missing', async () => {
    process.env.TOTEM_OAUTH_REDIRECT_URI = 'https://totem.example.com/oauth/callback/feishu';
    const fetchMock = vi.fn<FetchLike>(() => okJson({ authorizationUrl: 'https://open.feishu.cn/a' }));
    const { io, stdout } = makeHarness(fetchMock);

    const code = await run(['oauth-start', 'tenant-1'], io);
    expect(code).toBe(0);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://api.test/admin/tenants/tenant-1/oauth/start',
      expect.objectContaining({
        body: JSON.stringify({ redirectUri: 'https://totem.example.com/oauth/callback/feishu' }),
      }),
    );
    expect(stdout[0]).toContain('https://open.feishu.cn/');
  });

  it('passes --connection for in-place re-authorization', async () => {
    const fetchMock = vi.fn<FetchLike>(() => okJson({ authorizationUrl: 'https://open.feishu.cn/a' }));
    const { io } = makeHarness(fetchMock);

    const code = await run(
      ['oauth-start', 'tenant-1', 'https://totem.example.com/oauth/callback/feishu', '--connection', 'conn-9'],
      io,
    );
    expect(code).toBe(0);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://api.test/admin/tenants/tenant-1/oauth/start',
      expect.objectContaining({
        body: JSON.stringify({
          redirectUri: 'https://totem.example.com/oauth/callback/feishu',
          connectionId: 'conn-9',
        }),
      }),
    );
  });

  it('get-audit-policy prints the tenant policy (T11)', async () => {
    const fetchMock = vi.fn<FetchLike>(() =>
      okJson({ retentionDays: 30, errorOnly: true, captureBody: false }),
    );
    const { io, stdout } = makeHarness(fetchMock);

    const code = await run(['get-audit-policy', 'tenant-1'], io);
    expect(code).toBe(0);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://api.test/admin/tenants/tenant-1/audit-policy',
      expect.objectContaining({ method: 'GET' }),
    );
    expect(stdout).toEqual(['retentionDays=30\terrorOnly=true\tcaptureBody=false']);
  });

  it('set-audit-policy sends only the given flags and prints the result (T11)', async () => {
    const fetchMock = vi.fn<FetchLike>(() =>
      okJson({ retentionDays: 7, errorOnly: true, captureBody: false }),
    );
    const { io, stdout } = makeHarness(fetchMock);

    const code = await run(
      ['set-audit-policy', 'tenant-1', '--retention-days', '7', '--error-only', 'true'],
      io,
    );
    expect(code).toBe(0);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://api.test/admin/tenants/tenant-1/audit-policy',
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({ retentionDays: 7, errorOnly: true }),
      }),
    );
    expect(stdout).toEqual(['retentionDays=7\terrorOnly=true\tcaptureBody=false']);
  });

  it('set-audit-policy rejects bad flag values (T11)', async () => {
    const fetchMock = vi.fn<FetchLike>(() => okJson({}));
    const { io, stderr } = makeHarness(fetchMock);

    for (const argv of [
      ['set-audit-policy', 'tenant-1', '--retention-days', '0'],
      ['set-audit-policy', 'tenant-1', '--error-only', 'yes'],
      ['set-audit-policy', 'tenant-1', '--nope', '1'],
    ]) {
      const code = await run(argv, io);
      expect(code).toBe(2);
    }
    expect(stderr.length).toBe(3);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('purge-audit POSTs and prints the deleted count (T11)', async () => {
    const fetchMock = vi.fn<FetchLike>(() => okJson({ deleted: 42 }));
    const { io, stdout } = makeHarness(fetchMock);

    const code = await run(['purge-audit', 'tenant-1'], io);
    expect(code).toBe(0);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://api.test/admin/tenants/tenant-1/audit/purge',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(stdout).toEqual(['Deleted 42 expired audit rows for tenant tenant-1']);
  });
});
