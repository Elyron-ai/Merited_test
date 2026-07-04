import {
  Statement,
  pence,
  type Balance,
  type NettingEventRef,
  type Position,
  type StatementLine,
} from '@merited/contracts';
import { chromium } from 'playwright-core';
import type pg from 'pg';
import { TrioHttpError } from '../shared/deps.js';

/**
 * Statements, positions and party mapping (TRIO-11, §7.3) — RETAINED into
 * production (TRIO-16's retained-module list). Pure arithmetic + read-side
 * SQL; nothing here is simulated.
 *
 * Party ↔ account mapping (SYN-36): accounts are one-per-party by design
 * (arch §2.5) — `merchant_payable:<mer>` and `agent_receivable:<agt>` map to
 * the id parties, `platform_revenue` to `platform`, and `reserve:*` folds
 * into the single holding party `reserve` (the platform's clawback buffer is
 * a counterparty view of its own, matching the demo's four-line print).
 * Signed convention: credit positive — a party's balance ≥ 0 is receivable
 * (the platform owes them), < 0 is payable (they owe the platform).
 */
export const partyForAccount = (account: string): string => {
  if (account === 'platform_revenue') return 'platform';
  if (account.startsWith('reserve:')) return 'reserve';
  const separator = account.indexOf(':');
  return separator === -1 ? account : account.slice(separator + 1);
};

export const signedPence = (side: 'dr' | 'cr', amountPence: number): number =>
  side === 'cr' ? amountPence : -amountPence;

export const balanceOf = (signed: number): Balance => ({
  direction: signed >= 0 ? 'receivable' : 'payable',
  amount: pence(Math.abs(signed)),
});

/** Fold per-account signed sums into per-party positions (zero folds omitted). */
export const foldPositions = (rows: Array<{ account: string; signed: number }>): Position[] => {
  const byParty = new Map<string, number>();
  for (const row of rows) {
    const party = partyForAccount(row.account);
    byParty.set(party, (byParty.get(party) ?? 0) + row.signed);
  }
  return [...byParty.entries()]
    .filter(([, signed]) => signed !== 0)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([party, signed]) => ({ party, ...balanceOf(signed) }));
};

/** Live net position = Σ of the party's account lines (netted or not). */
export const livePosition = async (
  client: pg.Pool | pg.ClientBase,
  party: string,
): Promise<Position> => {
  const { rows } = await client.query<{ account: string; signed: string }>(
    `SELECT account,
            SUM(CASE WHEN side = 'cr' THEN amount_pence ELSE -amount_pence END) AS signed
       FROM trio.entry_lines
      GROUP BY account`,
  );
  const signed = rows
    .filter((r) => partyForAccount(r.account) === party)
    .reduce((sum, r) => sum + Number(r.signed), 0);
  return { party, ...balanceOf(signed) };
};

const PERIOD_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

export const periodBounds = (period: string): { start: Date; end: Date } => {
  if (!PERIOD_PATTERN.test(period)) {
    throw new TrioHttpError(400, 'INVALID_PERIOD', 'period must be YYYY-MM');
  }
  const [year, month] = period.split('-').map(Number) as [number, number];
  return {
    start: new Date(Date.UTC(year, month - 1, 1)),
    end: new Date(Date.UTC(year, month, 1)),
  };
};

const describeEntrySet = (entrySetId: string): string => {
  if (entrySetId.startsWith('set_rev_')) {
    return `Reversal of conversion ${entrySetId.slice('set_rev_'.length)}`;
  }
  if (entrySetId.startsWith('set_')) return `Conversion ${entrySetId.slice('set_'.length)}`;
  return entrySetId;
};

/**
 * Statement for a party and YYYY-MM period: opening balance (all lines before
 * the period), the party's entry lines within it, the netting runs that
 * folded any of the party's entries during it, and the closing balance
 * (opening + period lines — netting moves nothing in Phase 0/1;
 * SimulatedPayouts is statements-only, spec §2.2).
 */
export const buildStatement = async (
  client: pg.Pool | pg.ClientBase,
  party: string,
  period: string,
): Promise<Statement> => {
  const { start, end } = periodBounds(period);

  const opening = await client.query<{ account: string; signed: string }>(
    `SELECT el.account,
            SUM(CASE WHEN el.side = 'cr' THEN el.amount_pence ELSE -el.amount_pence END) AS signed
       FROM trio.entry_lines el
       JOIN trio.entry_sets es USING (entry_set_id)
      WHERE es.created_at < $1
      GROUP BY el.account`,
    [start],
  );
  const openingSigned = opening.rows
    .filter((r) => partyForAccount(r.account) === party)
    .reduce((sum, r) => sum + Number(r.signed), 0);

  const periodLines = await client.query<{
    entry_set_id: string;
    account: string;
    side: 'dr' | 'cr';
    amount_pence: string;
  }>(
    `SELECT el.entry_set_id, el.account, el.side, el.amount_pence
       FROM trio.entry_lines el
       JOIN trio.entry_sets es USING (entry_set_id)
      WHERE es.created_at >= $1 AND es.created_at < $2
      ORDER BY es.created_at, el.line_id`,
    [start, end],
  );
  const lines: StatementLine[] = periodLines.rows
    .filter((r) => partyForAccount(r.account) === party)
    .map((r, index) => ({
      seq: index + 1,
      description: describeEntrySet(r.entry_set_id),
      side: r.side,
      amount: pence(Number(r.amount_pence)),
    }));

  const nettingRows = await client.query<{
    netting_run_id: string;
    created_at: Date;
    account: string;
    signed: string;
  }>(
    `SELECT nr.netting_run_id, nr.created_at, el.account,
            SUM(CASE WHEN el.side = 'cr' THEN el.amount_pence ELSE -el.amount_pence END) AS signed
       FROM trio.netting_runs nr
       JOIN trio.netted_sets ns USING (netting_run_id)
       JOIN trio.entry_lines el USING (entry_set_id)
      WHERE nr.created_at >= $1 AND nr.created_at < $2
      GROUP BY nr.netting_run_id, nr.created_at, el.account
      ORDER BY nr.created_at`,
    [start, end],
  );
  const byRun = new Map<string, { at: Date; signed: number; touchesParty: boolean }>();
  for (const row of nettingRows.rows) {
    const run = byRun.get(row.netting_run_id) ?? {
      at: row.created_at,
      signed: 0,
      touchesParty: false,
    };
    if (partyForAccount(row.account) === party) {
      run.signed += Number(row.signed);
      run.touchesParty = true;
    }
    byRun.set(row.netting_run_id, run);
  }
  const netting_events: NettingEventRef[] = [...byRun.entries()]
    .filter(([, run]) => run.touchesParty)
    .sort(([, a], [, b]) => a.at.getTime() - b.at.getTime())
    .map(([netting_run_id, run]) => ({
      netting_run_id,
      at: run.at.toISOString().replace(/\.\d{3}Z$/, 'Z'),
      position: balanceOf(run.signed),
    }));

  const closingSigned =
    openingSigned + lines.reduce((sum, l) => sum + signedPence(l.side, l.amount.amount), 0);

  return Statement.parse({
    party,
    period,
    opening: balanceOf(openingSigned),
    lines,
    netting_events,
    closing: balanceOf(closingSigned),
  });
};

const gbp = (amountPence: number): string => `£${(amountPence / 100).toFixed(2)}`;
const escapeHtml = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** UK-English statement document; the party name sits in the title and body. */
export const statementHtml = (statement: Statement): string => {
  const party = escapeHtml(statement.party);
  const balance = (b: Balance): string =>
    `${gbp(b.amount.amount)} ${b.direction === 'receivable' ? 'receivable' : 'payable'}`;
  const rows = statement.lines
    .map(
      (l) =>
        `<tr><td>${l.seq}</td><td>${escapeHtml(l.description)}</td>` +
        `<td>${l.side === 'dr' ? gbp(l.amount.amount) : ''}</td>` +
        `<td>${l.side === 'cr' ? gbp(l.amount.amount) : ''}</td></tr>`,
    )
    .join('');
  const netting = statement.netting_events
    .map(
      (n) =>
        `<li>Netting run ${escapeHtml(n.netting_run_id)} at ${n.at}: ` +
        `${balance(n.position)} folded to net position</li>`,
    )
    .join('');
  return `<!doctype html><html><head><meta charset="utf-8">
<title>Merited statement - ${party} - ${statement.period}</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 2.5rem; color: #111; }
  h1 { font-size: 1.4rem; } table { border-collapse: collapse; width: 100%; margin: 1rem 0; }
  th, td { border-bottom: 1px solid #ccc; padding: 0.4rem 0.6rem; text-align: left; }
  .balance { font-weight: 600; }
</style></head><body>
<h1>Merited settlement statement</h1>
<p>Party: <strong>${party}</strong> · Period: <strong>${statement.period}</strong></p>
<p class="balance">Opening balance: ${balance(statement.opening)}</p>
<table><thead><tr><th>#</th><th>Description</th><th>Debit</th><th>Credit</th></tr></thead>
<tbody>${rows || '<tr><td colspan="4">No entries this period</td></tr>'}</tbody></table>
${netting ? `<ul>${netting}</ul>` : ''}
<p class="balance">Closing balance: ${balance(statement.closing)}</p>
</body></html>`;
};

/**
 * Render the statement PDF via Playwright/Chromium (spec §7.3). Pass
 * `executablePath` when the environment supplies its own Chromium (e.g. a
 * pre-installed browser at a known path); otherwise Playwright's standard
 * browser discovery applies.
 */
export const renderStatementPdf = async (
  statement: Statement,
  options: { executablePath?: string } = {},
): Promise<Buffer> => {
  const browser = await chromium.launch(
    options.executablePath ? { executablePath: options.executablePath } : {},
  );
  try {
    const page = await browser.newPage();
    await page.setContent(statementHtml(statement), { waitUntil: 'load' });
    return await page.pdf({ format: 'A4' });
  } finally {
    await browser.close();
  }
};
