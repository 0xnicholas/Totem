import { serve, type ServerType } from '@hono/node-server';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWeComOAuthClient } from '../src/wecom/oauth.js';
import { MockWeComServer } from '../src/testing/mock-wecom-server.js';

const CORP_ID = 'wc_corp_id';
const SECRET = 'wc_secret';
const START = Date.parse('2026-01-01T00:00:00Z');
const CREDS = { corpId: CORP_ID, secret: SECRET, agentId: '1000002' };

/**
 * The WeCom OAuth client (#48, ADR-0017): WeCom self-built apps have no
 * user OAuth — the only token flow is gettoken (corpid+secret → app access
 * token). This suite pins the wire contract: the errcode envelope (HTTP
 * 200 + errcode !== 0 is the failure signal — the WeCom profile's
 * convention), the ISO expiry computed from expires_in, and the error
 * families the token cell classifies.
 */
describe('WeCom OAuth client (gettoken)', () => {
  let server: ServerType;
  let baseUrl: string;
  let mock: MockWeComServer;

  beforeAll(async () => {
    mock = new MockWeComServer({ corpId: CORP_ID, secret: SECRET });
    server = serve({ fetch: mock.app.fetch, port: 0 });
    await new Promise((resolve) => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  it('fetches an app access token and computes the ISO expiry from expires_in', async () => {
    const client = createWeComOAuthClient({ apiBaseUrl: baseUrl, now: () => START });
    const pair = await client.appAccessToken({ creds: CREDS });
    expect(pair.accessToken).toMatch(/^wc_access_/);
    // 7200s TTL (the mock's documented default) at the injected now.
    expect(pair.expiresAt).toBe(new Date(START + 7200 * 1000).toISOString());
    expect(mock.gettokenRequestCount).toBe(1);
  });

  it('sends corpid and corpsecret as query parameters (no auth header)', async () => {
    // The mock validates the query params itself: a bad corpid or secret is
    // the 40001 path, so a 2nd successful call proves the params arrived.
    await createWeComOAuthClient({ apiBaseUrl: baseUrl, now: () => START }).appAccessToken({
      creds: CREDS,
    });
    expect(mock.gettokenRequestCount).toBe(2);
  });

  it('maps invalid credentials to WeComApiError (HTTP 200 + errcode 40001)', async () => {
    const client = createWeComOAuthClient({ apiBaseUrl: baseUrl, now: () => START });
    await expect(
      client.appAccessToken({ creds: { ...CREDS, secret: 'rotated-away' } }),
    ).rejects.toMatchObject({ errcode: 40001, httpStatus: 200 });
  });

  it('maps a non-2xx gettoken response to WeComApiError with the HTTP status as the code', async () => {
    mock.failNext({ message: 'gateway blew up', httpStatus: 502 });
    const client = createWeComOAuthClient({ apiBaseUrl: baseUrl, now: () => START });
    await expect(client.appAccessToken({ creds: CREDS })).rejects.toMatchObject({
      errcode: 502,
      httpStatus: 502,
    });
  });

  it('maps a network failure to upstream_error through the kernel', async () => {
    const dead = createWeComOAuthClient({ apiBaseUrl: 'http://127.0.0.1:1' });
    await expect(dead.appAccessToken({ creds: CREDS })).rejects.toMatchObject({
      code: 'upstream_error',
    });
  });
});
