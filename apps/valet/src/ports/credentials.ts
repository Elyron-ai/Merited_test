import type { MeritedId } from '@merited/contracts';
import type pg from 'pg';

export interface AgentCredentials {
  agent_id: MeritedId<'agt'>;
  api_key: string;
}

/** Where Valet keeps its OWN agent identity between runs (VAL-5: "register
 * → persist agt_valet_* + API key locally"). */
export interface CredentialsStore {
  load(): Promise<AgentCredentials | null>;
  save(credentials: AgentCredentials): Promise<void>;
}

/**
 * Valet-schema credential row. Holding the agent's own api key readable in
 * Valet's own database is ordinary client-credential storage (a CLI keychain
 * equivalent) — it grants nothing over anyone else's data.
 */
export class PostgresCredentialsStore implements CredentialsStore {
  constructor(
    private readonly pool: pg.Pool,
    private readonly profile: string = 'default',
  ) {}

  async load(): Promise<AgentCredentials | null> {
    const { rows } = await this.pool.query<AgentCredentials>(
      `SELECT agent_id, api_key FROM valet.agent_credentials WHERE profile = $1`,
      [this.profile],
    );
    return rows[0] ?? null;
  }

  async save(credentials: AgentCredentials): Promise<void> {
    await this.pool.query(
      `INSERT INTO valet.agent_credentials (profile, agent_id, api_key)
       VALUES ($1, $2, $3)
       ON CONFLICT (profile) DO UPDATE SET agent_id = $2, api_key = $3`,
      [this.profile, credentials.agent_id, credentials.api_key],
    );
  }
}
