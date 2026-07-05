import {
  createHash,
  createPrivateKey,
  generateKeyPairSync,
  randomBytes,
  sign as edSign,
  type KeyObject,
} from 'node:crypto';
import {
  AGENT_SIGNATURE_HEADERS,
  agentCanonicalString,
  type MeritedId,
} from '@merited/contracts';

/**
 * SDK signing client (PH1-5, B4 upgrade). The agent holds its OWN Ed25519
 * key — generated here, public half registered at `POST /v1/agents/register`
 * — and signs every request over the shared canonical string from
 * contracts (single source; the server rebuilds the identical string).
 */

/** Generate an agent keypair; register `publicKey`, keep `privateKey`. */
export const generateAgentKeypair = (): { publicKey: string; privateKeyPkcs8: string } => {
  const pair = generateKeyPairSync('ed25519');
  return {
    publicKey: `ed25519-pub:${(pair.publicKey.export({ format: 'der', type: 'spki' }) as Buffer).toString('base64url')}`,
    privateKeyPkcs8: (pair.privateKey.export({ format: 'der', type: 'pkcs8' }) as Buffer).toString(
      'base64url',
    ),
  };
};

export interface SignRequestInput {
  method: string;
  /** Path + query exactly as it will be sent. */
  pathWithQuery: string;
  /** Raw body string; '' for bodyless requests. */
  body?: string;
}

export class AgentRequestSigner {
  private readonly privateKey: KeyObject;

  constructor(
    private readonly agentId: MeritedId<'agt'>,
    privateKeyPkcs8: string,
    private readonly clock: { now(): Date } = { now: () => new Date() },
  ) {
    this.privateKey = createPrivateKey({
      key: Buffer.from(privateKeyPkcs8, 'base64url'),
      format: 'der',
      type: 'pkcs8',
    });
  }

  /** The four signature headers for one request (fresh nonce every call). */
  headersFor(input: SignRequestInput): Record<string, string> {
    const timestamp = String(Math.floor(this.clock.now().getTime() / 1000));
    const nonce = randomBytes(16).toString('base64url');
    const canonical = agentCanonicalString({
      method: input.method,
      pathWithQuery: input.pathWithQuery,
      bodySha256: createHash('sha256').update(input.body ?? '', 'utf8').digest('hex'),
      timestamp,
      nonce,
    });
    const signature = edSign(null, Buffer.from(canonical, 'utf8'), this.privateKey);
    return {
      [AGENT_SIGNATURE_HEADERS.agentId]: this.agentId,
      [AGENT_SIGNATURE_HEADERS.timestamp]: timestamp,
      [AGENT_SIGNATURE_HEADERS.nonce]: nonce,
      [AGENT_SIGNATURE_HEADERS.signature]: `ed25519:${signature.toString('base64url')}`,
    };
  }
}
