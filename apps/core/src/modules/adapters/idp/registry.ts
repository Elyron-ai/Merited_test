import type { IdentityProviderAdapter } from '@merited/contracts';

/**
 * Per-programme IdP registry (PH1-12): a `programme` string → its
 * `IdentityProviderAdapter`. FakeAurora is `aurora-club` today; Auth0,
 * Cognito or a merchant-native IdP register under their own programme keys
 * later with no contract change (the adapter interface is the seam). The
 * account-linking flow (PH1-13) resolves the adapter by the programme on
 * the `LinkStartRequest`.
 */
export class IdpRegistry {
  private readonly adapters = new Map<string, IdentityProviderAdapter>();

  register(programme: string, adapter: IdentityProviderAdapter): this {
    this.adapters.set(programme, adapter);
    return this;
  }

  /** Resolve the adapter for a programme, or null if none is configured. */
  resolve(programme: string): IdentityProviderAdapter | null {
    return this.adapters.get(programme) ?? null;
  }

  has(programme: string): boolean {
    return this.adapters.has(programme);
  }

  programmes(): string[] {
    return [...this.adapters.keys()];
  }
}
