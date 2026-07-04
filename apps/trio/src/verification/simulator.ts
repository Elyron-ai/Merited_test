import {
  AttributionTokenClaims,
  MintRequest,
  newId,
  type MintResponse,
  type TokenMintService,
} from '@merited/contracts';
import { appendEvent, canonicalJson, sha256hex } from '@merited/events';
import { CommitmentSimulator } from '../commitment/simulator.js';
import { inTx, PLATFORM_MINT_KEY, TrioHttpError, type TrioDeps } from '../shared/deps.js';

const DEFAULT_TOKEN_TTL_S = 600; // ~10 min (§2.3), capped by the attribution window

const base64url = (input: string): string => Buffer.from(input, 'utf8').toString('base64url');

/**
 * Token Mint SIMULATOR (TRIO-5, §7.2 mint half; the verify pipeline is
 * TRIO-8) — replaced file-for-file by PH1-25 (real PASETO v4.public).
 * The pseudo-token is deliberately opaque downstream:
 *   v4.public.fake.<base64url(canonical_json(claims))>.<FakeSigner sig>
 * Claims are ONLY read from the mint response (keeps every consumer honest
 * against the real PASETO swap).
 *
 * Re-mint (B26/SYN-8): same qid, fresh jti, apr set. Walletless: apr null.
 * Mint enforces quote.expires_at ≤ token exp — Core clamps before calling
 * (CORE-10); a snapshot beyond the token's life is a caller bug, rejected 422.
 */
export class MintSimulator implements TokenMintService {
  constructor(
    private readonly deps: TrioDeps,
    private readonly commitments: CommitmentSimulator,
  ) {}

  async mint(requestInput: MintRequest): Promise<MintResponse> {
    const request = MintRequest.parse(requestInput);

    const status = await this.commitments.status(request.cid).catch(() => null);
    if (!status) throw new TrioHttpError(404, 'COMMITMENT_NOT_FOUND');
    if (status.status !== 'live') throw new TrioHttpError(409, 'COMMITMENT_NOT_LIVE');
    const cor = (await this.commitments.load(request.cid))!;

    const iat = Math.floor(this.deps.clock.now().getTime() / 1000);
    const exp = iat + Math.min(DEFAULT_TOKEN_TTL_S, cor.terms.attribution_window_s);
    if (Math.floor(Date.parse(request.quote.expires_at) / 1000) > exp) {
      throw new TrioHttpError(422, 'QUOTE_EXPIRY_EXCEEDS_TOKEN', 'quote.expires_at must be ≤ token exp (§3)');
    }

    const claims = AttributionTokenClaims.parse({
      jti: newId('atk'),
      cid: request.cid,
      qid: request.qid,
      aid: request.aid,
      tier: request.tier,
      sid: sha256hex(request.session_nonce),
      apr: request.apr ?? null,
      iat,
      exp,
    });

    const canonicalClaims = canonicalJson(claims);
    const signature = await this.deps.signer.sign(PLATFORM_MINT_KEY, canonicalClaims);
    const token = `v4.public.fake.${base64url(canonicalClaims)}.${signature}`;

    await inTx(this.deps.pool, async (tx) => {
      await tx.query(
        `INSERT INTO trio.minted_tokens (jti, cid, qid, aid, tier, sid, apr, iat, exp, quote_expires_at, mandate_ref)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [
          claims.jti,
          claims.cid,
          claims.qid,
          claims.aid,
          claims.tier,
          claims.sid,
          claims.apr,
          claims.iat,
          claims.exp,
          request.quote.expires_at,
          request.quote.mandate_ref,
        ],
      );
      await appendEvent(tx, 'TokenMinted', { claims });
    });

    return { token, claims };
  }
}
