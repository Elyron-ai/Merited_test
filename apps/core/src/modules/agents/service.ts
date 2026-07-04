import { randomUUID } from 'node:crypto';
import { newId, type MeritedId } from '@merited/contracts';
import { appendEvent } from '@merited/events';
import type pg from 'pg';
import { inTx } from '../../db.js';
import { generateApiKey, hashesEqual, hashKey } from './keys.js';

export interface RegisterAgentInput {
  name: string;
  contact: string;
  /** Reserved Phase-1 field (Ed25519 request signing) — stored, never used in Phase 0. */
  public_key?: string;
}

export interface RegisteredAgent {
  agent_id: MeritedId<'agt'>;
  api_key: string;
}

/**
 * Agent registry (CORE-3, B4/§5.2). Keys are stored as SHA-256 digests
 * with a last-4 display fragment; authentication hashes the presented key
 * and compares digests in constant time. Revocation and agent suspension
 * take effect on the very next request — nothing is cached.
 */
export class AgentsService {
  constructor(private readonly pool: pg.Pool) {}

  async register(input: RegisterAgentInput): Promise<RegisteredAgent> {
    const agentId = newId('agt');
    const key = generateApiKey();
    const registeredAt = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
    await inTx(this.pool, async (tx) => {
      await tx.query(
        `INSERT INTO core.agents (agent_id, name, contact) VALUES ($1, $2, $3)`,
        [agentId, input.name, input.contact],
      );
      await tx.query(
        `INSERT INTO core.agent_keys (key_id, agent_id, key_hash, key_last4, public_key)
         VALUES ($1, $2, $3, $4, $5)`,
        [`akey_${randomUUID()}`, agentId, key.key_hash, key.key_last4, input.public_key ?? null],
      );
      await appendEvent(tx, 'AgentRegistered', {
        agent_id: agentId,
        name: input.name,
        registered_at: registeredAt,
      });
    });
    return { agent_id: agentId, api_key: key.api_key };
  }

  /** Presented key → agent id, or null (never throws for bad credentials). */
  async authenticate(presentedKey: string): Promise<MeritedId<'agt'> | null> {
    const digest = hashKey(presentedKey);
    const { rows } = await this.pool.query<{ agent_id: MeritedId<'agt'>; key_hash: string }>(
      `SELECT k.agent_id, k.key_hash
         FROM core.agent_keys k
         JOIN core.agents a USING (agent_id)
        WHERE k.key_hash = $1 AND k.revoked_at IS NULL AND a.status = 'active'`,
      [digest],
    );
    const candidate = rows[0];
    if (!candidate) return null;
    return hashesEqual(digest, candidate.key_hash) ? candidate.agent_id : null;
  }

  /** Revoke every live key for an agent (effective immediately). */
  async revokeKeys(agentId: string): Promise<number> {
    const { rowCount } = await this.pool.query(
      `UPDATE core.agent_keys SET revoked_at = now() WHERE agent_id = $1 AND revoked_at IS NULL`,
      [agentId],
    );
    return rowCount ?? 0;
  }
}
