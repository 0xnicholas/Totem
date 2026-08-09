import { serve, type ServerType } from '@hono/node-server';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  FeishuApiError,
  createFeishuOAuthClient,
  type FeishuOAuthClient,
} from '../src/feishu/oauth.js';
import { MockFeishuServer } from '../src/testing/mock-feishu-server.js';

const APP_ID = 'cli_app_id';
const APP_SECRET = 'cli_app_secret';
const REDIRECT_URI = 'https://totem.example.com/oauth/callback/feishu';
const CREDS = { appId: APP_ID, appSecret: APP_SECRET };

/**
 * The Feishu OAuth client (Seam B consumer): authorization URL building and
 * the v2 token endpoint (code exchange + refresh) against the mock server —
 * no real Feishu credentials in CI.
 */
describe('FeishuOAuthClient', () => {
  let server: ServerType;
  let baseUrl: string;
  let mock: MockFeishuServer;
  let oauth: FeishuOAuthClient;

  beforeAll(async () => {
    mock = new MockFeishuServer({ appId: APP_ID, appSecret: APP_SECRET });
    server = serve({ fetch: mock.app.fetch, port: 0 });
    await new Promise((resolve) => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    oauth = createFeishuOAuthClient(baseUrl);
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  it('builds the authorize URL with app_id, redirect_uri and state', () => {
    const url = new URL(
      oauth.buildAuthorizationUrl({ appId: APP_ID, redirectUri: REDIRECT_URI, state: 'st-1' }),
    );
    expect(url.pathname).toBe('/open-apis/authen/v1/authorize');
    expect(url.searchParams.get('app_id')).toBe(APP_ID);
    expect(url.searchParams.get('redirect_uri')).toBe(REDIRECT_URI);
    expect(url.searchParams.get('state')).toBe('st-1');
  });

  it('exchanges an authorization code for a token pair with an expiry', async () => {
    const pair = await oauth.exchangeCode({ creds: CREDS, code: await mockAuthorize(mock), redirectUri: REDIRECT_URI });
    expect(pair.accessToken).toBeTruthy();
    expect(pair.refreshToken).toBeTruthy();
    expect(new Date(pair.expiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  it('refreshes with a refresh token and returns a fresh pair', async () => {
    const issued = await oauth.exchangeCode({ creds: CREDS, code: await mockAuthorize(mock), redirectUri: REDIRECT_URI });
    const refreshed = await oauth.refreshToken({ creds: CREDS, refreshToken: issued.refreshToken });
    expect(refreshed.accessToken).toBeTruthy();
    expect(refreshed.accessToken).not.toBe(issued.accessToken);
    expect(mock.refreshRequestCount).toBe(1);
  });

  it('classifies a revoked refresh token as invalid grant (auth_expired material)', async () => {
    const issued = await oauth.exchangeCode({ creds: CREDS, code: await mockAuthorize(mock), redirectUri: REDIRECT_URI });
    mock.revokeRefreshToken(issued.refreshToken);

    await expect(oauth.refreshToken({ creds: CREDS, refreshToken: issued.refreshToken })).rejects.toMatchObject({
      name: 'FeishuApiError',
      invalidGrant: true,
    });
  });

  it('classifies a scripted HTTP 429 as rate limited', async () => {
    mock.failNextRefresh({ code: 99991, msg: 'rate limit hit', httpStatus: 429 });
    const err = await oauth.refreshToken({ creds: CREDS, refreshToken: 'whatever' }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(FeishuApiError);
    expect((err as FeishuApiError).httpStatus).toBe(429);
  });

  it('classifies an unknown code as invalid grant', async () => {
    await expect(
      oauth.exchangeCode({ creds: CREDS, code: 'never-issued', redirectUri: REDIRECT_URI }),
    ).rejects.toMatchObject({ name: 'FeishuApiError', invalidGrant: true });
  });
});

async function mockAuthorize(mock: MockFeishuServer): Promise<string> {
  return mock.authorizeCode(REDIRECT_URI, 'state-x');
}
