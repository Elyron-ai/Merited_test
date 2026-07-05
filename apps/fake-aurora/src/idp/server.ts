import { createHash, randomBytes } from 'node:crypto';
import formbody from '@fastify/formbody';
import Fastify, { type FastifyInstance } from 'fastify';
import { exportJWK, generateKeyPair, SignJWT, type KeyLike } from 'jose';
import { AURORA_IDP_MEMBERS, claimsForScopes, memberBySub, memberByUsername } from './members.js';

/**
 * FakeAurora OIDC IdP (PH1-10, B27). Standards-compliant-enough: discovery,
 * authorize (login + scope-consent — on camera in Act 2), token (auth-code
 * grant with PKCE S256 ENFORCED), userinfo, revocation, JWKS. In-memory
 * grant state — it is a demo/test IdP, not a production auth server. The
 * `sub` is stable per seeded member so a linked account resolves the same
 * identity end to end.
 */
const b64urlSha256 = (input: string): string =>
  createHash('sha256').update(input).digest('base64url');

interface AuthCode {
  sub: string;
  clientId: string;
  redirectUri: string;
  scopes: string[];
  codeChallenge: string;
  nonce: string | undefined;
  expiresAt: number;
}

interface AccessToken {
  sub: string;
  scopes: string[];
  expiresAt: number;
}

interface RefreshToken {
  sub: string;
  scopes: string[];
  revoked: boolean;
}

export interface FakeAuroraIdpOptions {
  /** The IdP's public issuer URL (must equal where it is reached). */
  issuer: string;
  clientId: string;
  clientSecret: string;
  clock?: { now(): Date };
}

export interface FakeAuroraIdp {
  app: FastifyInstance;
  listen(): Promise<string>;
  close(): Promise<void>;
}

export const createFakeAuroraIdp = async (options: FakeAuroraIdpOptions): Promise<FakeAuroraIdp> => {
  const now = () => (options.clock ?? { now: () => new Date() }).now().getTime();
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const kid = 'aurora-idp-1';
  const jwk = { ...(await exportJWK(publicKey)), kid, use: 'sig', alg: 'RS256' };

  const codes = new Map<string, AuthCode>();
  const accessTokens = new Map<string, AccessToken>();
  const refreshTokens = new Map<string, RefreshToken>();

  const app = Fastify();
  await app.register(formbody); // OAuth token/consent posts are form-encoded

  // ── discovery ──────────────────────────────────────────────────────────
  app.get('/.well-known/openid-configuration', async () => ({
    issuer: options.issuer,
    authorization_endpoint: `${options.issuer}/authorize`,
    token_endpoint: `${options.issuer}/token`,
    userinfo_endpoint: `${options.issuer}/userinfo`,
    revocation_endpoint: `${options.issuer}/revoke`,
    jwks_uri: `${options.issuer}/jwks`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    subject_types_supported: ['public'],
    id_token_signing_alg_values_supported: ['RS256'],
    scopes_supported: ['openid', 'profile', 'balance', 'tier'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic'],
  }));

  app.get('/jwks', async () => ({ keys: [jwk] }));

  // ── authorize: consent screen ────────────────────────────────────────────
  app.get('/authorize', async (req, reply) => {
    const q = req.query as Record<string, string>;
    if (q['client_id'] !== options.clientId) return reply.code(400).send('invalid client_id');
    if (!q['redirect_uri']) return reply.code(400).send('missing redirect_uri');
    // PKCE is mandatory (§ enforced): reject a request without S256 challenge
    if (!q['code_challenge'] || q['code_challenge_method'] !== 'S256') {
      return reply.code(400).send('PKCE S256 required');
    }
    const scopes = (q['scope'] ?? 'openid').split(' ').filter(Boolean);
    const consentScopes = scopes.filter((s) => s !== 'openid');
    // consent screen lists EXACTLY the requested (non-openid) scopes
    const scopeList = consentScopes.map((s) => `<li class="scope">${s}</li>`).join('');
    const memberOptions = AURORA_IDP_MEMBERS.filter((m) => m.status === 'active')
      .map((m) => `<option value="${m.username}">${m.name} (${m.loyalty_tier})</option>`)
      .join('');
    void reply.header('content-type', 'text/html');
    return reply.send(`<!doctype html><html><body>
      <h1>Aurora Club — sign in</h1>
      <p>Merited is requesting access to:</p>
      <ul class="scopes">${scopeList}</ul>
      <form method="post" action="/authorize/consent">
        <input type="hidden" name="state" value="${q['state'] ?? ''}"/>
        <input type="hidden" name="scope" value="${scopes.join(' ')}"/>
        <input type="hidden" name="redirect_uri" value="${q['redirect_uri']}"/>
        <input type="hidden" name="code_challenge" value="${q['code_challenge']}"/>
        <input type="hidden" name="nonce" value="${q['nonce'] ?? ''}"/>
        <select name="username">${memberOptions}</select>
        <input type="password" name="password" placeholder="password"/>
        <button type="submit" name="decision" value="approve">Approve</button>
        <button type="submit" name="decision" value="deny">Deny</button>
      </form></body></html>`);
  });

  // ── authorize: consent submit → auth code ──────────────────────────────────
  app.post('/authorize/consent', async (req, reply) => {
    const form = req.body as Record<string, string>;
    const redirectUri = form['redirect_uri']!;
    const state = form['state'] ?? '';
    if (form['decision'] !== 'approve') {
      return reply.redirect(`${redirectUri}?error=access_denied&state=${state}`);
    }
    const member = memberByUsername(form['username'] ?? '');
    // the fake password is 'aurora'; a wrong one fails login (not a code)
    if (!member || member.status !== 'active' || form['password'] !== 'aurora') {
      return reply.code(401).send('invalid credentials');
    }
    const code = randomBytes(24).toString('base64url');
    codes.set(code, {
      sub: member.sub,
      clientId: options.clientId,
      redirectUri,
      scopes: (form['scope'] ?? 'openid').split(' ').filter(Boolean),
      codeChallenge: form['code_challenge']!,
      nonce: form['nonce'] || undefined,
      expiresAt: now() + 60_000,
    });
    return reply.redirect(`${redirectUri}?code=${code}&state=${state}`);
  });

  // ── token: auth-code grant (PKCE S256) + refresh ──────────────────────────
  app.post('/token', async (req, reply) => {
    const body = req.body as Record<string, string>;
    const auth = parseClientAuth(req.headers['authorization'], body);
    if (auth.clientId !== options.clientId || auth.clientSecret !== options.clientSecret) {
      return reply.code(401).send({ error: 'invalid_client' });
    }

    if (body['grant_type'] === 'authorization_code') {
      const record = codes.get(body['code'] ?? '');
      if (!record || record.expiresAt < now()) return reply.code(400).send({ error: 'invalid_grant' });
      codes.delete(body['code']!); // single-use
      if (record.redirectUri !== body['redirect_uri']) {
        return reply.code(400).send({ error: 'invalid_grant', error_description: 'redirect_uri mismatch' });
      }
      // PKCE S256 verification — THE enforced check
      const verifier = body['code_verifier'];
      if (!verifier || b64urlSha256(verifier) !== record.codeChallenge) {
        return reply.code(400).send({ error: 'invalid_grant', error_description: 'PKCE verification failed' });
      }
      return reply.send(await issueTokens(record.sub, record.scopes, record.nonce));
    }

    if (body['grant_type'] === 'refresh_token') {
      const record = refreshTokens.get(body['refresh_token'] ?? '');
      if (!record || record.revoked) return reply.code(400).send({ error: 'invalid_grant' });
      return reply.send(await issueTokens(record.sub, record.scopes, undefined, body['refresh_token']));
    }

    return reply.code(400).send({ error: 'unsupported_grant_type' });
  });

  // ── userinfo (Bearer) ─────────────────────────────────────────────────────
  app.get('/userinfo', async (req, reply) => {
    const bearer = (req.headers['authorization'] ?? '').replace(/^Bearer /i, '');
    const token = accessTokens.get(bearer);
    if (!token || token.expiresAt < now()) return reply.code(401).send({ error: 'invalid_token' });
    const member = memberBySub(token.sub);
    if (!member) return reply.code(401).send({ error: 'invalid_token' });
    return reply.send(claimsForScopes(member, token.scopes));
  });

  // ── revocation (RFC 7009): invalidate a refresh token ─────────────────────
  app.post('/revoke', async (req, reply) => {
    const body = req.body as Record<string, string>;
    const record = refreshTokens.get(body['token'] ?? '');
    if (record) record.revoked = true;
    return reply.code(200).send({}); // RFC 7009: always 200
  });

  const issueTokens = async (
    sub: string,
    scopes: string[],
    nonce: string | undefined,
    reuseRefresh?: string,
  ): Promise<Record<string, unknown>> => {
    const accessToken = randomBytes(24).toString('base64url');
    accessTokens.set(accessToken, { sub, scopes, expiresAt: now() + 3600_000 });
    const refreshToken = reuseRefresh ?? randomBytes(24).toString('base64url');
    if (!reuseRefresh) refreshTokens.set(refreshToken, { sub, scopes, revoked: false });
    const idToken = await new SignJWT({ ...(nonce ? { nonce } : {}) })
      .setProtectedHeader({ alg: 'RS256', kid })
      .setIssuer(options.issuer)
      .setSubject(sub)
      .setAudience(options.clientId)
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(privateKey as KeyLike);
    return {
      access_token: accessToken,
      refresh_token: refreshToken,
      id_token: idToken,
      token_type: 'Bearer',
      expires_in: 3600,
      scope: scopes.join(' '),
    };
  };

  return {
    app,
    listen: () => app.listen({ port: 0, host: '127.0.0.1' }),
    close: () => app.close(),
  };
};

/** client_secret_basic (Authorization header) or client_secret_post (body). */
const parseClientAuth = (
  authHeader: string | undefined,
  body: Record<string, string>,
): { clientId: string | undefined; clientSecret: string | undefined } => {
  if (authHeader?.startsWith('Basic ')) {
    const [clientId, clientSecret] = Buffer.from(authHeader.slice(6), 'base64').toString('utf8').split(':');
    return { clientId, clientSecret };
  }
  return { clientId: body['client_id'], clientSecret: body['client_secret'] };
};
