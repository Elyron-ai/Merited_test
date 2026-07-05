import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ObjectStore } from './object-store.js';

/**
 * FakeObjectStore (PH1-21, §2.2 adapter+fake rule): the local-filesystem
 * stand-in for S3 — CI's store, and the `verify-chain --against-heads <dir>`
 * target for local audits. Keys are constrained to a safe charset so a key
 * can never traverse outside the root.
 */
const SAFE_KEY = /^[A-Za-z0-9._/-]+$/;

export class FakeObjectStore implements ObjectStore {
  constructor(private readonly root: string) {}

  private resolve(key: string): string {
    if (!SAFE_KEY.test(key) || key.includes('..')) {
      throw new Error(`unsafe object key: '${key}'`);
    }
    return path.join(this.root, key);
  }

  async put(key: string, body: string): Promise<void> {
    const file = this.resolve(key);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, body, 'utf8');
  }

  async get(key: string): Promise<string | null> {
    try {
      return await readFile(this.resolve(key), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async list(prefix: string): Promise<string[]> {
    // prefix is a key prefix, not necessarily a directory — walk its dir part
    const dirPart = prefix.includes('/') ? prefix.slice(0, prefix.lastIndexOf('/') + 1) : '';
    const dir = dirPart ? this.resolve(dirPart) : this.root;
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    return entries
      .map((entry) => `${dirPart}${entry}`)
      .filter((key) => key.startsWith(prefix))
      .sort();
  }
}
