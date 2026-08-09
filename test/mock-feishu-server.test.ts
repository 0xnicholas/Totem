import { serve, type ServerType } from '@hono/node-server';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MockFeishuServer } from '../src/testing/mock-feishu-server.js';

/**
 * Seam B (T6): the mock Feishu HTTP server the connector tests run against.
 * This file pins the mock's own contract — authorize redirect, token
 * envelopes, revocation, error injection — so T7-T9 action tests can rely
 * on it without re-deriving the behavior.
 */
describe('MockFeishuServer', () => {
  let server: ServerType;
  let baseUrl: string;
  let mock: MockFeishuServer;

  beforeAll(async () => {
    mock = new MockFeishuServer({ appId: 'cli_app_id', appSecret: 'cli_app_secret' });
    server = serve({ fetch: mock.app.fetch, port: 0 });
    await new Promise((resolve) => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  it('redirects the authorize endpoint to the redirect_uri with a code and the same state', async () => {
    const res = await fetch(
      `${baseUrl}/open-apis/authen/v1/authorize?app_id=cli_app_id&redirect_uri=${encodeURIComponent('https://totem.example.com/oauth/callback/feishu')}&state=flow-123`,
      { redirect: 'manual' },
    );
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get('location')!);
    expect(location.origin + location.pathname).toBe(
      'https://totem.example.com/oauth/callback/feishu',
    );
    expect(location.searchParams.get('state')).toBe('flow-123');
    expect(location.searchParams.get('code')).toBeTruthy();
  });

  it('exchanges an issued code for a token pair with the Feishu envelope', async () => {
    const pair = await tokenCall(baseUrl, {
      grant_type: 'authorization_code',
      client_id: 'cli_app_id',
      client_secret: 'cli_app_secret',
      code: await authorizeCode(baseUrl, 'flow-abc'),
      redirect_uri: 'https://totem.example.com/oauth/callback/feishu',
    });
    expect(pair.code).toBe(0);
    expect(pair.data!.access_token).toBeTruthy();
    expect(pair.data!.refresh_token).toBeTruthy();
    expect(pair.data!.expires_in).toBeGreaterThan(0);
    expect(mock.exchangeRequestCount).toBe(1);
  });

  it('rejects an unknown code with an error envelope', async () => {
    const pair = await tokenCall(baseUrl, {
      grant_type: 'authorization_code',
      client_id: 'cli_app_id',
      client_secret: 'cli_app_secret',
      code: 'never-issued',
      redirect_uri: 'https://totem.example.com/oauth/callback/feishu',
    });
    expect(pair.code).not.toBe(0);
  });

  it('rejects wrong client credentials', async () => {
    const pair = await tokenCall(baseUrl, {
      grant_type: 'authorization_code',
      client_id: 'cli_app_id',
      client_secret: 'wrong-secret',
      code: 'x',
      redirect_uri: 'https://totem.example.com/oauth/callback/feishu',
    });
    expect(pair.code).not.toBe(0);
  });

  it('refreshes a valid refresh token and revokes on demand', async () => {
    const issued = await tokenCall(baseUrl, {
      grant_type: 'authorization_code',
      client_id: 'cli_app_id',
      client_secret: 'cli_app_secret',
      code: await authorizeCode(baseUrl, 'flow-rev'),
      redirect_uri: 'https://totem.example.com/oauth/callback/feishu',
    });
    const refreshToken = issued.data!.refresh_token;

    const refreshed = await tokenCall(baseUrl, {
      grant_type: 'refresh_token',
      client_id: 'cli_app_id',
      client_secret: 'cli_app_secret',
      refresh_token: refreshToken,
    });
    expect(refreshed.code).toBe(0);
    expect(refreshed.data!.access_token).toBeTruthy();
    expect(mock.refreshRequestCount).toBe(1);

    mock.revokeRefreshToken(refreshToken);
    const afterRevoke = await tokenCall(baseUrl, {
      grant_type: 'refresh_token',
      client_id: 'cli_app_id',
      client_secret: 'cli_app_secret',
      refresh_token: refreshToken,
    });
    expect(afterRevoke.code).not.toBe(0);
  });

  it('injects a scripted failure for the next refresh (revoked-token simulation)', async () => {
    mock.failNextRefresh({ code: 10666, msg: 'refresh token revoked' });
    const issued = await tokenCall(baseUrl, {
      grant_type: 'refresh_token',
      client_id: 'cli_app_id',
      client_secret: 'cli_app_secret',
      refresh_token: 'any-token',
    });
    expect(issued).toEqual({ code: 10666, msg: 'refresh token revoked' });
  });
});

async function authorizeCode(baseUrl: string, state: string): Promise<string> {
  const res = await fetch(
    `${baseUrl}/open-apis/authen/v1/authorize?app_id=cli_app_id&redirect_uri=${encodeURIComponent('https://totem.example.com/oauth/callback/feishu')}&state=${state}`,
    { redirect: 'manual' },
  );
  return new URL(res.headers.get('location')!).searchParams.get('code')!;
}

async function tokenCall(
  baseUrl: string,
  body: Record<string, string>,
): Promise<{ code: number; msg?: string; data?: { access_token: string; refresh_token: string; expires_in: number } }> {
  const res = await fetch(`${baseUrl}/open-apis/authen/v2/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body),
  });
  return (await res.json()) as never;
}
