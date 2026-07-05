import { createServer } from 'node:http';
import * as client from 'openid-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFakeAuroraIdp, type FakeAuroraIdp } from './server.js';

/** Grab a free TCP port so the IdP's issuer URL is known before it boots
 * (discovery + id_token issuer must match the address it is reached at). */
const freePort = async (): Promise<number> =>
  new Promise((resolve) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as { port: number }).port;
      srv.close(() => resolve(port));
    });
  });

/**
 * PH1-10 accept: a GENERIC OIDC client library (openid-client) completes
 * code+PKCE against the IdP; missing/wrong code_verifier errors per RFC; the
 * consent screen lists exactly the requested scopes; revocation invalidates
 * refresh tokens.
 */
const CLIENT_ID = 'merited-wallet';
const CLIENT_SECRET = 'aurora-idp-secret';
const REDIRECT_URI = 'https://wallet.merited.test/v1/links/callback';

let idp: FakeAuroraIdp;
let issuer: string;
let config: client.Configuration;

beforeAll(async () => {
  const port = await freePort();
  issuer = `http://127.0.0.1:${port}`;
  idp = await createFakeAuroraIdp({ issuer, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
  await idp.app.listen({ port, host: '127.0.0.1' });
  config = await client.discovery(new URL(issuer), CLIENT_ID, CLIENT_SECRET, undefined, {
    execute: [client.allowInsecureRequests], // plain-HTTP local IdP
  });
});

afterAll(async () => {
  await idp.close();
});

describe('FakeAurora OIDC IdP (PH1-10)', () => {
  it('a generic OIDC client completes code + PKCE S256 end to end', async () => {
    const codeVerifier = client.randomPKCECodeVerifier();
    const codeChallenge = await client.calculatePKCECodeChallenge(codeVerifier);
    const state = client.randomState();
    const nonce = client.randomNonce();
    const authUrl = client.buildAuthorizationUrl(config, {
      redirect_uri: REDIRECT_URI,
      scope: 'openid profile balance tier',
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      state,
      nonce,
    });

    // consent screen lists EXACTLY the requested (non-openid) scopes
    const page = await (await fetch(authUrl)).text();
    for (const scope of ['profile', 'balance', 'tier']) {
      expect(page).toContain(`<li class="scope">${scope}</li>`);
    }
    expect(page).not.toContain('<li class="scope">openid</li>');

    // approve as Ada → redirect carrying the code
    const consent = await fetch(`${issuer}/authorize/consent`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      redirect: 'manual',
      body: new URLSearchParams({
        state,
        scope: 'openid profile balance tier',
        redirect_uri: REDIRECT_URI,
        code_challenge: codeChallenge,
        nonce,
        username: 'ada',
        password: 'aurora',
        decision: 'approve',
      }),
    });
    const callbackUrl = new URL(consent.headers.get('location')!);
    expect(callbackUrl.searchParams.get('state')).toBe(state);

    // the client exchanges the code (verifies id_token vs JWKS, checks PKCE)
    const tokens = await client.authorizationCodeGrant(config, callbackUrl, {
      pkceCodeVerifier: codeVerifier,
      expectedState: state,
      expectedNonce: nonce,
    });
    expect(tokens.access_token).toBeTruthy();
    expect(tokens.refresh_token).toBeTruthy();
    const claims = tokens.claims()!;
    expect(claims.sub).toBe('am_seed_ada'); // stable sub per seeded member
    expect(claims.iss).toBe(issuer);

    // userinfo returns scope-gated claims
    const userinfo = await client.fetchUserInfo(config, tokens.access_token, claims.sub);
    expect(userinfo.name).toBe('Ada Aurora');
    expect(userinfo['loyalty_tier']).toBe('Member');
    expect(userinfo['points_balance']).toBe(1250);
  });

  it('a WRONG code_verifier is rejected per RFC (invalid_grant)', async () => {
    const codeVerifier = client.randomPKCECodeVerifier();
    const codeChallenge = await client.calculatePKCECodeChallenge(codeVerifier);
    const authUrl = client.buildAuthorizationUrl(config, {
      redirect_uri: REDIRECT_URI,
      scope: 'openid profile',
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      state: client.randomState(),
    });
    const consent = await fetch(`${issuer}/authorize/consent`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      redirect: 'manual',
      body: new URLSearchParams({
        state: authUrl.searchParams.get('state') ?? '',
        scope: 'openid profile',
        redirect_uri: REDIRECT_URI,
        code_challenge: codeChallenge,
        username: 'ada',
        password: 'aurora',
        decision: 'approve',
      }),
    });
    const code = new URL(consent.headers.get('location')!).searchParams.get('code')!;
    // exchange with the WRONG verifier → 400 invalid_grant
    const response = await fetch(`${issuer}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT_URI,
        code_verifier: 'a-different-verifier-entirely-wrong-value',
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
      }),
    });
    expect(response.status).toBe(400);
    expect((await response.json() as { error: string }).error).toBe('invalid_grant');
  });

  it('a MISSING code_verifier is rejected (PKCE mandatory)', async () => {
    // an authorize request without a challenge is refused up front
    const noPkce = await fetch(
      `${issuer}/authorize?client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&scope=openid`,
    );
    expect(noPkce.status).toBe(400);
    expect(await noPkce.text()).toContain('PKCE');
  });

  it('the consent screen lists exactly the requested scopes — no more, no less', async () => {
    const codeChallenge = await client.calculatePKCECodeChallenge(client.randomPKCECodeVerifier());
    const page = await (
      await fetch(
        `${issuer}/authorize?client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
          `&scope=${encodeURIComponent('openid tier')}&code_challenge=${codeChallenge}&code_challenge_method=S256`,
      )
    ).text();
    expect(page).toContain('<li class="scope">tier</li>');
    expect(page).not.toContain('<li class="scope">profile</li>');
    expect(page).not.toContain('<li class="scope">balance</li>');
  });

  it('revocation invalidates the refresh token (RFC 7009)', async () => {
    const codeVerifier = client.randomPKCECodeVerifier();
    const codeChallenge = await client.calculatePKCECodeChallenge(codeVerifier);
    const authUrl = client.buildAuthorizationUrl(config, {
      redirect_uri: REDIRECT_URI,
      scope: 'openid profile',
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      state: client.randomState(),
    });
    const consent = await fetch(`${issuer}/authorize/consent`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      redirect: 'manual',
      body: new URLSearchParams({
        state: authUrl.searchParams.get('state') ?? '',
        scope: 'openid profile',
        redirect_uri: REDIRECT_URI,
        code_challenge: codeChallenge,
        username: 'cyn',
        password: 'aurora',
        decision: 'approve',
      }),
    });
    const callbackUrl = new URL(consent.headers.get('location')!);
    const expectedState = authUrl.searchParams.get('state') ?? undefined;
    const tokens = await client.authorizationCodeGrant(config, callbackUrl, {
      pkceCodeVerifier: codeVerifier,
      ...(expectedState ? { expectedState } : {}),
    });
    const refreshToken = tokens.refresh_token!;

    // refresh works BEFORE revocation
    const before = await fetch(`${issuer}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: CLIENT_ID, client_secret: CLIENT_SECRET }),
    });
    expect(before.status).toBe(200);

    // revoke, then the same refresh token is dead
    const revoke = await fetch(`${issuer}/revoke`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: refreshToken }),
    });
    expect(revoke.status).toBe(200); // RFC 7009: always 200
    const after = await fetch(`${issuer}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: CLIENT_ID, client_secret: CLIENT_SECRET }),
    });
    expect(after.status).toBe(400);
  });

  it('a denied consent redirects with error=access_denied', async () => {
    const codeChallenge = await client.calculatePKCECodeChallenge(client.randomPKCECodeVerifier());
    const consent = await fetch(`${issuer}/authorize/consent`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      redirect: 'manual',
      body: new URLSearchParams({
        state: 'st',
        scope: 'openid profile',
        redirect_uri: REDIRECT_URI,
        code_challenge: codeChallenge,
        username: 'ada',
        password: 'aurora',
        decision: 'deny',
      }),
    });
    expect(new URL(consent.headers.get('location')!).searchParams.get('error')).toBe('access_denied');
  });
});
