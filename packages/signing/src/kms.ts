import { randomBytes } from 'node:crypto';
import { SecretBytes } from './secret-bytes.js';

/**
 * KMS port (PH1-30, SYN-32): the two operations envelope encryption needs.
 * Implementations: `LocalAwsKms` (the compose `fake-kms` container — a
 * local clone of the AWS KMS JSON protocol; a real AWS deployment swaps in
 * the AWS SDK client behind this same port) and `InMemoryKms` for unit
 * tests. Data-key PLAINTEXT is wrapped in `SecretBytes` — it never
 * serialises or logs.
 */
export interface DataKey {
  plaintext: SecretBytes;
  /** Opaque encrypted blob — safe at rest; only KMS can open it. */
  ciphertextBlob: Buffer;
}

export interface Kms {
  generateDataKey(): Promise<DataKey>;
  decryptDataKey(ciphertextBlob: Buffer): Promise<SecretBytes>;
}

interface LocalAwsKmsOptions {
  /** e.g. http://localhost:4599 (the compose fake-kms). */
  baseUrl: string;
  /** KMS master key id; `ensureMasterKey` can mint one for dev. */
  keyId: string;
}

const kmsCall = async (baseUrl: string, target: string, body: unknown): Promise<unknown> => {
  const response = await fetch(baseUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-amz-json-1.1',
      'x-amz-target': `TrentService.${target}`,
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`KMS ${target} failed: ${response.status} ${await response.text()}`);
  }
  return response.json();
};

export class LocalAwsKms implements Kms {
  constructor(private readonly options: LocalAwsKmsOptions) {}

  async generateDataKey(): Promise<DataKey> {
    const result = (await kmsCall(this.options.baseUrl, 'GenerateDataKey', {
      KeyId: this.options.keyId,
      KeySpec: 'AES_256',
    })) as { Plaintext: string; CiphertextBlob: string };
    return {
      plaintext: new SecretBytes(Buffer.from(result.Plaintext, 'base64')),
      ciphertextBlob: Buffer.from(result.CiphertextBlob, 'base64'),
    };
  }

  async decryptDataKey(ciphertextBlob: Buffer): Promise<SecretBytes> {
    const result = (await kmsCall(this.options.baseUrl, 'Decrypt', {
      CiphertextBlob: ciphertextBlob.toString('base64'),
    })) as { Plaintext: string };
    return new SecretBytes(Buffer.from(result.Plaintext, 'base64'));
  }
}

/** Mint (or reuse) a master key on the local fake-kms — dev/test setup
 * only; real deployments configure MERITED_KMS_KEY_ID from the KMS console. */
export const ensureMasterKey = async (baseUrl: string): Promise<string> => {
  const result = (await kmsCall(baseUrl, 'CreateKey', {
    Description: 'merited-dev-master',
  })) as { KeyMetadata: { KeyId: string } };
  return result.KeyMetadata.KeyId;
};

/** Unit-test KMS: real AES data keys, 'encryption' by table lookup. */
export class InMemoryKms implements Kms {
  private readonly issued = new Map<string, Buffer>();

  async generateDataKey(): Promise<DataKey> {
    const plaintext = randomBytes(32);
    const handle = randomBytes(16).toString('hex');
    this.issued.set(handle, plaintext);
    return {
      plaintext: new SecretBytes(plaintext),
      ciphertextBlob: Buffer.from(`inmem:${handle}`, 'utf8'),
    };
  }

  async decryptDataKey(ciphertextBlob: Buffer): Promise<SecretBytes> {
    const handle = ciphertextBlob.toString('utf8').replace(/^inmem:/, '');
    const plaintext = this.issued.get(handle);
    if (!plaintext) throw new Error('InMemoryKms: unknown data key');
    return new SecretBytes(plaintext);
  }
}
