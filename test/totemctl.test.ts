import { describe, expect, it, vi } from 'vitest';
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

  it('set-allowlist PUTs the actions', async () => {
    const fetchMock = vi.fn<FetchLike>(() => okJson({ ok: true }));
    const { io, stdout } = makeHarness(fetchMock);

    const code = await run(['set-allowlist', 'conn-1', 'create_doc', 'read_doc'], io);
    expect(code).toBe(0);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://api.test/admin/connections/conn-1/allowlist',
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({ actions: ['create_doc', 'read_doc'] }),
      }),
    );
    expect(stdout[0]).toBe('Allowlist for connection conn-1: create_doc, read_doc');
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
