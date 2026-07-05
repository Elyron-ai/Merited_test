import type { IdentityProviderAdapter } from '@merited/contracts';

/**
 * `IdentityProviderAdapter` over the FakeAurora OIDC IdP (PH1-12, §2.2).
 * All five methods speak the standard OIDC/OAuth wire; a real Auth0/Cognito/
 * merchant-native IdP slots in behind this same interface via the registry
 * with no contract change. Plus the brand-initiated revocation SURFACE
 * (poll fallback + inbound-webhook parse) the row calls for.
 *
 * `sub` after exchange/refresh comes from the id_token's subject — the token
 * endpoint is an authenticated back-channel, so decoding the payload for the
 * subject is standard (full JWKS verification is the wallet's job at link
 * time; PH1-13). userinfo is a live verified round-trip.
 */
export interface FakeAuroraIdpAdapterOptions {
  issuer: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  fetchImpl?: typeof fetch;
}

const decodeJwtSub = (jwt: string): string => {
  const payload = jwt.split('.')[1];
  if (!payload) throw new Error('malformed id_token');
  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { sub?: string };
  if (!claims.sub) throw new Error('id_token missing sub');
  return claims.sub;
};

export class FakeAuroraIdpAdapter implements IdentityProviderAdapter {
  constructor(private readonly options: FakeAuroraIdpAdapterOptions) {}

  private get fetch(): typeof fetch {
    return this.options.fetchImpl ?? fetch;
  }

  async authorize(input: {
    state: string;
    code_challenge: string;
    scopes: string[];
  }): Promise<{ url: string }> {
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: this.options.clientId,
      redirect_uri: this.options.redirectUri,
      scope: input.scopes.join(' '),
      state: input.state,
      code_challenge: input.code_challenge,
      code_challenge_method: 'S256',
    });
    return { url: `${this.options.issuer}/authorize?${params.toString()}` };
  }

  async exchange(input: { code: string; code_verifier: string }): Promise<{
    sub: string;
    access_token: string;
    refresh_token?: string;
    expires_in_s: number;
  }> {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code: input.code,
      code_verifier: input.code_verifier,
      redirect_uri: this.options.redirectUri,
      client_id: this.options.clientId,
      client_secret: this.options.clientSecret,
    });
    const tokens = await this.tokenRequest(body);
    return {
      sub: decodeJwtSub(tokens.id_token),
      access_token: tokens.access_token,
      ...(tokens.refresh_token ? { refresh_token: tokens.refresh_token } : {}),
      expires_in_s: tokens.expires_in,
    };
  }

  async refresh(refreshToken: string): Promise<{
    access_token: string;
    refresh_token?: string;
    expires_in_s: number;
  }> {
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: this.options.clientId,
      client_secret: this.options.clientSecret,
    });
    const tokens = await this.tokenRequest(body);
    return {
      access_token: tokens.access_token,
      ...(tokens.refresh_token ? { refresh_token: tokens.refresh_token } : {}),
      expires_in_s: tokens.expires_in,
    };
  }

  async userinfo(accessToken: string): Promise<{ sub: string; claims: Record<string, unknown> }> {
    const response = await this.fetch(`${this.options.issuer}/userinfo`, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    if (!response.ok) throw new Error(`userinfo failed: ${response.status}`);
    const claims = (await response.json()) as Record<string, unknown> & { sub: string };
    return { sub: claims.sub, claims };
  }

  async revoke(token: string): Promise<void> {
    await this.fetch(`${this.options.issuer}/revoke`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token }),
    });
  }

  // ── brand-initiated revocation surface (poll fallback + webhook parse) ────

  /** Poll the brand for members it has unlinked (returns their subs). */
  async pollRevocations(): Promise<string[]> {
    const response = await this.fetch(`${this.options.issuer}/revocations`);
    if (!response.ok) throw new Error(`revocation poll failed: ${response.status}`);
    return ((await response.json()) as { revoked_subs: string[] }).revoked_subs;
  }

  /** Parse an inbound brand revocation webhook → the revoked subject. */
  parseRevocationNotice(payload: unknown): string | null {
    if (payload && typeof payload === 'object' && 'sub' in payload) {
      const sub = (payload as { sub: unknown }).sub;
      return typeof sub === 'string' ? sub : null;
    }
    return null;
  }

  private async tokenRequest(body: URLSearchParams): Promise<{
    access_token: string;
    refresh_token?: string;
    id_token: string;
    expires_in: number;
  }> {
    const response = await this.fetch(`${this.options.issuer}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });
    if (!response.ok) {
      const detail = (await response.json().catch(() => ({}))) as { error?: string };
      throw new Error(`token request failed: ${response.status} ${detail.error ?? ''}`);
    }
    return response.json() as Promise<{
      access_token: string;
      refresh_token?: string;
      id_token: string;
      expires_in: number;
    }>;
  }
}
