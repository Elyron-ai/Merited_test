import { inspect } from 'node:util';

const REDACTED = '[redacted:secret-bytes]';

/**
 * Key-material container (PH1-30 accept: "key material never
 * logged/serialised"). The bytes are reachable ONLY through `use()` —
 * JSON.stringify, util.inspect (console.log), string coercion and spread
 * all yield a redaction marker, so an accidental log line or serialised
 * error can never carry the secret.
 */
export class SecretBytes {
  readonly #bytes: Buffer;

  constructor(bytes: Buffer) {
    this.#bytes = Buffer.from(bytes); // defensive copy
  }

  /** The ONLY doorway to the material. */
  use<T>(fn: (bytes: Buffer) => T): T {
    return fn(this.#bytes);
  }

  toJSON(): string {
    return REDACTED;
  }

  toString(): string {
    return REDACTED;
  }

  [inspect.custom](): string {
    return REDACTED;
  }
}
