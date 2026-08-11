import { serve, type ServerType } from '@hono/node-server';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DingTalkApiError,
  createDingTalkOAuthClient,
  type DingTalkOAuthClient,
} from '../src/dingtalk/oauth.js';
import { MockDingTalkServer } from '../src/testing/mock-dingtalk-server.js';

const APP_KEY = 'cli_app_key';
const APP_SECRET = 'cli_app_secret';
const REDIRECT_URI = 'https://totem.example.com/oauth/callback/dingtalk';
const CREDS = { appKey: APP_KEY, appSecret: APP_SECRET };

/**
 * The DingTalk OAuth client (T17a, Seam B consumer): authorization URL
 * building and the userAccessToken endpoint (code exchange + refresh)
 * against the mock DingTalk server — no real DingTalk credentials in CI.
 */
describe('DingTalkOAuthClient', () => {
  let server: ServerType;
  let baseUrl: string;
  let mock: MockDingTalkServer;
  let oauth: DingTalkOAuthClient;

  beforeAll(async () => {
    mock = new MockDingTalkServer({ appKey: APP_KEY, appSecret: APP_SECRET });
    server = serve({ fetch: mock.app.fetch, port: 0 });
    await new Promise((resolve) => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    oauth = createDingTalkOAuthClient({ apiBaseUrl: baseUrl, authorizeBaseUrl: baseUrl });
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  it('builds the authorization URL with DingTalk OAuth 2.0 parameters', () => {
    const url = new URL(
      oauth.buildAuthorizationUrl({ appKey: APP_KEY, redirectUri: REDIRECT_URI, state: 'st-1' }),
    );
    expect(url.pathname).toBe('/oauth2/auth');
    expect(url.searchParams.get('client_id')).toBe(APP_KEY);
    expect(url.searchParams.get('redirect_uri')).toBe(REDIRECT_URI);
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('scope')).toBe('openid');
    expect(url.searchParams.get('state')).toBe('st-1');
    expect(url.searchParams.get('prompt')).toBe('consent');
  });

  it('exchanges an authorization code for a token pair', async () => {
    const code = await mock.authorizeCode(REDIRECT_URI, 'st-1');
    const pair = await oauth.exchangeCode({ creds: CREDS, code });
    expect(pair.accessToken).toBeTruthy();
    expect(pair.refreshToken).toBeTruthy();
    expect(new Date(pair.expiresAt).getTime()).toBeGreaterThan(Date.now());
    expect(mock.exchangeRequestCount).toBe(1);
  });

  it('classifies a rejected code as an invalid grant', async () => {
    await expect(oauth.exchangeCode({ creds: CREDS, code: 'not-a-code' })).rejects.toBeInstanceOf(
      DingTalkApiError,
    );
    await expect(oauth.exchangeCode({ creds: CREDS, code: 'not-a-code' })).rejects.toMatchObject({
      invalidGrant: true,
    });
  });

  it('rejects unknown client credentials', async () => {
    const code = await mock.authorizeCode(REDIRECT_URI, 'st-2');
    await expect(
      oauth.exchangeCode({ creds: { appKey: 'nope', appSecret: 'nope' }, code }),
    ).rejects.toMatchObject({ invalidGrant: true });
  });

  it('refreshes with a refresh token', async () => {
    const code = await mock.authorizeCode(REDIRECT_URI, 'st-3');
    const pair = await oauth.exchangeCode({ creds: CREDS, code });
    const refreshed = await oauth.refreshToken({ creds: CREDS, refreshToken: pair.refreshToken });
    expect(refreshed.accessToken).toBeTruthy();
    expect(mock.refreshRequestCount).toBe(1);
  });

  it('classifies a revoked refresh token as an invalid grant', async () => {
    const code = await mock.authorizeCode(REDIRECT_URI, 'st-4');
    const pair = await oauth.exchangeCode({ creds: CREDS, code });
    mock.revokeRefreshToken(pair.refreshToken);
    await expect(
      oauth.refreshToken({ creds: CREDS, refreshToken: pair.refreshToken }),
    ).rejects.toMatchObject({ invalidGrant: true });
  });

  it('keeps the previous refresh token when the refresh response omits one', async () => {
    const code = await mock.authorizeCode(REDIRECT_URI, 'st-5');
    const pair = await oauth.exchangeCode({ creds: CREDS, code });
    mock.omitRefreshTokenNext();
    const refreshed = await oauth.refreshToken({ creds: CREDS, refreshToken: pair.refreshToken });
    expect(refreshed.accessToken).toBeTruthy();
    expect(refreshed.refreshToken).toBe(pair.refreshToken);
  });

  it('surfaces a rate limit with httpStatus 429 and no invalid-grant flag', async () => {
    mock.failNext({ code: 'TooManyRequests', message: 'slow down', httpStatus: 429 });
    const code = await mock.authorizeCode(REDIRECT_URI, 'st-6');
    const pair = await oauth.exchangeCode({ creds: CREDS, code });
    await expect(
      oauth.refreshToken({ creds: CREDS, refreshToken: pair.refreshToken }),
    ).rejects.toMatchObject({ httpStatus: 429, invalidGrant: false });
  });

  it('does not mark a 5xx token-endpoint failure as an invalid grant', async () => {
    mock.failNext({ code: 'InternalError', message: 'boom', httpStatus: 500 });
    const code = await mock.authorizeCode(REDIRECT_URI, 'st-7');
    const pair = await oauth.exchangeCode({ creds: CREDS, code });
    await expect(
      oauth.refreshToken({ creds: CREDS, refreshToken: pair.refreshToken }),
    ).rejects.toMatchObject({ httpStatus: 500, invalidGrant: false });
  });

  it('fails with a generic error when the endpoint is unreachable', async () => {
    const dead = createDingTalkOAuthClient({ apiBaseUrl: 'http://127.0.0.1:1' });
    await expect(dead.exchangeCode({ creds: CREDS, code: 'x' })).rejects.toMatchObject({
      invalidGrant: false,
    });
  });
});
