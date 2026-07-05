import {
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';

/**
 * ObjectStore port (PH1-21, §2.2 adapter+fake rule): put/get/list, nothing
 * cleverer — the head-publication format is part of the future open spec
 * (PH3-7/8), so the surface stays dumb and stable. `FakeObjectStore` (local
 * filesystem) backs CI; this S3 adapter is exercised by the go-live smoke
 * test. Credentials are env configuration (stub values in dev — a real key
 * is an env change, never a code change).
 */
export interface ObjectStore {
  put(key: string, body: string): Promise<void>;
  get(key: string): Promise<string | null>;
  /** Keys under a prefix, sorted ascending (dates sort correctly). */
  list(prefix: string): Promise<string[]>;
}

export interface S3ObjectStoreOptions {
  bucket: string;
  /** Key prefix inside the bucket (e.g. 'merited/'). */
  prefix?: string;
  region?: string;
  /** Non-AWS endpoints (MinIO/localstack) for pre-production environments. */
  endpoint?: string;
  credentials?: { accessKeyId: string; secretAccessKey: string };
}

export class S3ObjectStore implements ObjectStore {
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly prefix: string;

  constructor(options: S3ObjectStoreOptions) {
    this.bucket = options.bucket;
    this.prefix = options.prefix ?? '';
    this.client = new S3Client({
      region: options.region ?? 'eu-west-2',
      ...(options.endpoint ? { endpoint: options.endpoint, forcePathStyle: true } : {}),
      ...(options.credentials ? { credentials: options.credentials } : {}),
    });
  }

  async put(key: string, body: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: `${this.prefix}${key}`,
        Body: body,
        ContentType: 'application/json',
      }),
    );
  }

  async get(key: string): Promise<string | null> {
    try {
      const response = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: `${this.prefix}${key}` }),
      );
      return (await response.Body?.transformToString()) ?? null;
    } catch (error) {
      if ((error as { name?: string }).name === 'NoSuchKey') return null;
      throw error;
    }
  }

  async list(prefix: string): Promise<string[]> {
    const keys: string[] = [];
    let token: string | undefined;
    do {
      const response = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: `${this.prefix}${prefix}`,
          ...(token ? { ContinuationToken: token } : {}),
        }),
      );
      for (const object of response.Contents ?? []) {
        if (object.Key) keys.push(object.Key.slice(this.prefix.length));
      }
      token = response.NextContinuationToken;
    } while (token);
    return keys.sort();
  }
}
