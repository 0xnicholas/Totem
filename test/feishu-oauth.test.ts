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

  it('builds the authorize URL with app_id, redirect_uri, state and offline_access', () => {
    const url = new URL(
      oauth.buildAuthorizationUrl({ appId: APP_ID, redirectUri: REDIRECT_URI, state: 'st-1' }),
    );
    expect(url.pathname).toBe('/open-apis/authen/v1/authorize');
    expect(url.searchParams.get('app_id')).toBe(APP_ID);
    expect(url.searchParams.get('redirect_uri')).toBe(REDIRECT_URI);
    expect(url.searchParams.get('state')).toBe('st-1');
    // Feishu's scope parameter DEFINES the grant (T9 demo pass finding):
    // offline_access for the refresh design (ADR-0004) plus the v1 action
    // set's business scopes — requesting only offline_access yields a token
    // with no business permissions.
    expect(url.searchParams.get('scope')).toBe(
      'offline_access docx:document:readonly docx:document:create docx:document ' +
        'drive:drive:readonly drive:drive drive:export:readonly ' +
        'sheets:spreadsheet:readonly sheets:spreadsheet bitable:app:readonly bitable:app',
    );
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

describe('Feishu v2 token endpoint live-shape regressions (T9 demo pass)', () => {
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

  it('accepts the flat success body (token fields at top level, no envelope)', async () => {
    const pair = await oauth.exchangeCode({
      creds: CREDS,
      code: await mock.authorizeCode(REDIRECT_URI, 'flat-shape'),
      redirectUri: REDIRECT_URI,
    });
    expect(pair.accessToken).toBeTruthy();
    expect(pair.refreshToken).toBeTruthy();
    expect(pair.expiresAt).toBeTruthy();
  });

  it('explains a missing refresh_token as an app-configuration problem', async () => {
    mock.omitRefreshTokenNext();
    await expect(
      oauth.exchangeCode({
        creds: CREDS,
        code: await mock.authorizeCode(REDIRECT_URI, 'no-refresh'),
        redirectUri: REDIRECT_URI,
      }),
    ).rejects.toThrow(/no refresh_token/);
  });
});
