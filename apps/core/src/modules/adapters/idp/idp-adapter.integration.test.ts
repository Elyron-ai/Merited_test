import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { createFakeAuroraIdp, type FakeAuroraIdp } from '@merited/fake-aurora';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FakeAuroraIdpAdapter } from './fake-aurora.js';
import { IdpRegistry } from './registry.js';

/**
 * PH1-12 accept: the adapter contract suite drives all FIVE
 * IdentityProviderAdapter methods + the revocation notification against the
 * FakeAurora impl; the registry resolves `aurora-club` → FakeAurora from
 * config.
 */
const CLIENT_ID = 'merited-wallet';
const CLIENT_SECRET = 'aurora-idp-secret';
const REDIRECT_URI = 'https://wallet.merited.test/v1/links/callback';

let idp: FakeAuroraIdp;
let issuer: string;
let adapter: FakeAuroraIdpAdapter;

const freePort = async (): Promise<number> =>
  new Promise((resolve) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as { port: number }).port;
      srv.close(() => resolve(port));
    });
  });

const b64urlSha256 = (input: string): string => createHash('sha256').update(input).digest('base64url');

/** Drive the IdP's consent screen to obtain an auth code for `username`. */
const getAuthCode = async (codeChallenge: string, scope: string, username: string): Promise<string> => {
  const consent = await fetch(`${issuer}/authorize/consent`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    redirect: 'manual',
    body: new URLSearchParams({
      state: 'st',
      scope,
      redirect_uri: REDIRECT_URI,
      code_challenge: codeChallenge,
      username,
      password: 'aurora',
      decision: 'approve',
    }),
  });
  return new URL(consent.headers.get('location')!).searchParams.get('code')!;
};

beforeAll(async () => {
  const port = await freePort();
  issuer = `http://127.0.0.1:${port}`;
  idp = await createFakeAuroraIdp({ issuer, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
  await idp.app.listen({ port, host: '127.0.0.1' });
  adapter = new FakeAuroraIdpAdapter({
    issuer,
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    redirectUri: REDIRECT_URI,
  });
});

afterAll(async () => {
  await idp.close();
});

describe('IdentityProviderAdapter contract — FakeAurora (PH1-12)', () => {
  it('authorize() builds a standards-shaped authorization URL', async () => {
    const { url } = await adapter.authorize({
      state: 'xyz',
      code_challenge: 'challenge-value',
      scopes: ['openid', 'profile', 'tier'],
    });
    const parsed = new URL(url);
    expect(parsed.pathname).toBe('/authorize');
    expect(parsed.searchParams.get('client_id')).toBe(CLIENT_ID);
    expect(parsed.searchParams.get('code_challenge_method')).toBe('S256');
    expect(parsed.searchParams.get('scope')).toBe('openid profile tier');
    expect(parsed.searchParams.get('state')).toBe('xyz');
  });

  it('exchange() → sub + tokens; userinfo() and refresh() round-trip; revoke() invalidates', async () => {
    const verifier = randomBytes(32).toString('base64url');
    const code = await getAuthCode(b64urlSha256(verifier), 'openid profile tier', 'ada');

    // exchange
    const exchanged = await adapter.exchange({ code, code_verifier: verifier });
    expect(exchanged.sub).toBe('am_seed_ada');
    expect(exchanged.access_token).toBeTruthy();
    expect(exchanged.refresh_token).toBeTruthy();
    expect(exchanged.expires_in_s).toBeGreaterThan(0);

    // userinfo
    const info = await adapter.userinfo(exchanged.access_token);
    expect(info.sub).toBe('am_seed_ada');
    expect(info.claims['name']).toBe('Ada Aurora');
    expect(info.claims['loyalty_tier']).toBe('Member');

    // refresh
    const refreshed = await adapter.refresh(exchanged.refresh_token!);
    expect(refreshed.access_token).toBeTruthy();
    expect(refreshed.expires_in_s).toBeGreaterThan(0);
    // the refreshed access token works
    expect((await adapter.userinfo(refreshed.access_token)).sub).toBe('am_seed_ada');

    // revoke the refresh token → a subsequent refresh fails
    await adapter.revoke(exchanged.refresh_token!);
    await expect(adapter.refresh(exchanged.refresh_token!)).rejects.toThrow(/token request failed/);
  });

  it('a wrong code_verifier makes exchange() throw (PKCE enforced end to end)', async () => {
    const verifier = randomBytes(32).toString('base64url');
    const code = await getAuthCode(b64urlSha256(verifier), 'openid', 'bea');
    await expect(
      adapter.exchange({ code, code_verifier: 'the-wrong-verifier' }),
    ).rejects.toThrow(/token request failed/);
  });

  it('revocation notification: pollRevocations() surfaces brand-unlinked members; webhook parses', async () => {
    // 'eve' is the seeded revoked member (brand-initiated unlink)
    expect(await adapter.pollRevocations()).toContain('am_seed_eve');
    // inbound push parse
    expect(adapter.parseRevocationNotice({ sub: 'am_seed_dev' })).toBe('am_seed_dev');
    expect(adapter.parseRevocationNotice({ nothing: true })).toBeNull();
  });
});

describe('IdP registry (PH1-12)', () => {
  it('resolves aurora-club → the FakeAurora adapter from config; unknown → null', () => {
    const registry = new IdpRegistry().register('aurora-club', adapter);
    expect(registry.resolve('aurora-club')).toBe(adapter);
    expect(registry.has('aurora-club')).toBe(true);
    expect(registry.resolve('some-other-brand')).toBeNull();
    expect(registry.programmes()).toEqual(['aurora-club']);
  });
});
