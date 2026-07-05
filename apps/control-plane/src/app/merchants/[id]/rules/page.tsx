import { RulesStore } from '@merited/core';
import { SEGMENTS } from '@merited/contracts';
import Link from 'next/link';
import { getPool } from '../../../../lib/db';

export const dynamic = 'force-dynamic';

/**
 * PH1-3: thin exclusion-rule authoring (B13 0→1 continuation). Three rule
 * kinds, one form each — deny an agent, a tier/segment, or a SKU. Rules
 * apply on the very next read (stage 5 of the §5.4 chain).
 */
export default async function MerchantRules({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const rules = await new RulesStore(getPool()).list(id as `mer_${string}`);

  return (
    <main>
      <p><Link href={`/merchants/${id}`}>← Merchant</Link></p>
      <h1>Exclusion rules</h1>
      <p>
        Deny rules for the §5.4 eligibility chain — a matching offer is
        excluded as <code>MERCHANT_EXCLUDED</code> on the next agent read.
      </p>

      <table cellPadding={6}>
        <thead>
          <tr><th align="left">Rule</th><th align="left">Matches</th><th align="left">Note</th><th align="left">Created</th><th /></tr>
        </thead>
        <tbody>
          {rules.map((rule) => (
            <tr key={rule.rule_id}>
              <td><code>{rule.type}</code></td>
              <td>
                {rule.type === 'merchant_agent_exclusion' ? <code>{rule.agent_id}</code> : null}
                {rule.type === 'merchant_tier_exclusion'
                  ? `${rule.tier ?? '—'} / ${rule.segment ?? '—'}`
                  : null}
                {rule.type === 'merchant_sku_exclusion' ? <code>{rule.sku_ref}</code> : null}
              </td>
              <td>{rule.note ?? '—'}</td>
              <td>{rule.created_at.slice(0, 10)}</td>
              <td>
                <form method="post" action={`/api/merchants/${id}/rules/${rule.rule_id}/delete`}>
                  <button type="submit">Remove</button>
                </form>
              </td>
            </tr>
          ))}
          {rules.length === 0 ? (
            <tr><td colSpan={5}><em>No rules — every eligible offer is distributed.</em></td></tr>
          ) : null}
        </tbody>
      </table>

      <h2>Add a rule</h2>
      <form method="post" action={`/api/merchants/${id}/rules`} style={{ display: 'grid', gap: '0.5rem', maxWidth: '28rem' }}>
        <label>
          Kind{' '}
          <select name="type" defaultValue="merchant_agent_exclusion">
            <option value="merchant_agent_exclusion">Exclude an agent</option>
            <option value="merchant_tier_exclusion">Exclude a tier / segment</option>
            <option value="merchant_sku_exclusion">Exclude a SKU</option>
          </select>
        </label>
        <label>Agent id (agent rules) <input name="agent_id" placeholder="agt_…" /></label>
        <label>
          Tier (tier rules){' '}
          <select name="tier" defaultValue="">
            <option value="">—</option>
            <option value="T1">T1</option>
            <option value="T2">T2</option>
            <option value="T3">T3</option>
          </select>
        </label>
        <label>
          Segment (tier rules){' '}
          <select name="segment" defaultValue="">
            <option value="">—</option>
            {SEGMENTS.map((segment) => (
              <option key={segment} value={segment}>{segment}</option>
            ))}
          </select>
        </label>
        <label>SKU (SKU rules) <input name="sku_ref" placeholder="sku_…" /></label>
        <label>Note <input name="note" /></label>
        <button type="submit">Add rule</button>
      </form>
    </main>
  );
}
