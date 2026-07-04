import {
  AttributionTokenClaims,
  Brief,
  EntrySet,
  pence,
  type ErrandState,
} from '@merited/contracts';
import pg from 'pg';
import { ErrandDriver } from './errand/driver.js';
import { EventsPackageMirror } from './errand/ledger-mirror.js';
import { ErrandStore } from './errand/store.js';
import { AutoSkipGate } from './ports/approval-gate.js';
import { FakeShopRail, shopCatalogueSkuResolver } from './ports/checkout-rail.js';
import { PostgresCredentialsStore } from './ports/credentials.js';
import { QuoteClient } from './ports/quote-client.js';
import { VerdictPoller } from './ports/verdict-poller.js';

/**
 * The `valet` CLI (VAL-7, B18): brief → REST quote → FakeShop checkout with
 * the token → poll verdict → print settlement lines. UK English copy; money
 * printed as pounds formatted from integer pence, never floats.
 */

export interface CliEnv {
  coreUrl: string;
  shopUrl: string;
  databaseUrl: string;
  valetDatabaseUrl: string;
}

export const envFromProcess = (): CliEnv => ({
  coreUrl: process.env['MERITED_API_URL'] ?? 'http://localhost:3000',
  shopUrl: process.env['FAKESHOP_URL'] ?? 'http://localhost:4600',
  databaseUrl:
    process.env['DATABASE_URL'] ?? 'postgres://merited_app:merited_app_dev@localhost:5432/merited',
  valetDatabaseUrl:
    process.env['VALET_DATABASE_URL'] ??
    'postgres://merited_valet:merited_valet_dev@localhost:5432/merited',
});

const formatPence = (amount: number): string => {
  const sign = amount < 0 ? '−' : '';
  const absolute = Math.abs(amount);
  return `${sign}£${Math.floor(absolute / 100)}.${String(absolute % 100).padStart(2, '0')}`;
};

const decodeTokenClaims = (token: string): AttributionTokenClaims | null => {
  try {
    return AttributionTokenClaims.parse(
      JSON.parse(Buffer.from(token.split('.')[3]!, 'base64url').toString('utf8')),
    );
  } catch {
    return null;
  }
};

/** The §10 step 6 print: merchant −£12.00 · agent +£7.20 · Merited +£2.40 ·
 * reserve £2.40 (unsigned — held, neither owed nor earned). */
const settlementLines = (entries: EntrySet): string[] => {
  const label = (account: string): string =>
    account.startsWith('merchant_payable:')
      ? 'merchant'
      : account.startsWith('agent_receivable:')
        ? 'agent'
        : account === 'platform_revenue'
          ? 'Merited'
          : account.startsWith('reserve:')
            ? 'reserve'
            : account;
  return entries.lines.map((line) => {
    const pounds = `£${Math.floor(line.amount.amount / 100)}.${String(line.amount.amount % 100).padStart(2, '0')}`;
    const name = label(line.account);
    const shown = name === 'reserve' ? pounds : `${line.side === 'dr' ? '−' : '+'}${pounds}`;
    return `  ${name.padEnd(8)} ${shown}`;
  });
};

export interface CliDeps {
  driver: ErrandDriver;
  quotes: QuoteClient;
  store: ErrandStore;
  print(line: string): void;
}

export const buildCliDeps = (env: CliEnv, print: (line: string) => void): CliDeps & { close(): Promise<void> } => {
  const pool = new pg.Pool({ connectionString: env.databaseUrl, max: 5 });
  pool.on('error', () => {});
  const valetPool = new pg.Pool({ connectionString: env.valetDatabaseUrl, max: 3 });
  valetPool.on('error', () => {});
  const store = new ErrandStore(pool);
  const quotes = new QuoteClient({
    baseUrl: env.coreUrl,
    store: new PostgresCredentialsStore(pool),
    name: 'Valet',
    contact: 'valet@merited.test',
  });
  const driver = new ErrandDriver({
    store,
    mirror: new EventsPackageMirror(valetPool),
    quotes,
    rail: new FakeShopRail(env.shopUrl),
    gate: new AutoSkipGate(),
    poller: new VerdictPoller({ client: quotes }),
    resolveSku: shopCatalogueSkuResolver(env.shopUrl),
  });
  return {
    driver,
    quotes,
    store,
    print,
    close: async () => {
      await pool.end();
      await valetPool.end();
    },
  };
};

const printQuoteAndClaims = async (deps: CliDeps, errandId: string): Promise<void> => {
  const stored = (await deps.store.get(errandId))!;
  if (!stored.errand.quote_id) return;
  const status = await deps.quotes.getQuote(stored.errand.quote_id);
  deps.print(`Quote ${status.quote.quote_id}`);
  deps.print(`  list  ${status.quote.price.list.amount} pence (${formatPence(status.quote.price.list.amount)})`);
  deps.print(`  final ${status.quote.price.final.amount} pence (${formatPence(status.quote.price.final.amount)})`);
  deps.print(`  expires ${status.quote.expires_at}`);
  const claims = stored.errand.token ? decodeTokenClaims(stored.errand.token) : null;
  if (claims) {
    deps.print('Token claims');
    deps.print(`  jti ${claims.jti}`);
    deps.print(`  cid ${claims.cid}`);
    deps.print(`  qid ${claims.qid}`);
    deps.print(`  aid ${claims.aid}`);
    deps.print(`  tier ${claims.tier}`);
    deps.print(`  sid ${claims.sid}`);
    deps.print(`  apr ${claims.apr === null ? 'null' : claims.apr}`);
  }
};

const printVerdict = async (deps: CliDeps, errandId: string): Promise<void> => {
  const stored = (await deps.store.get(errandId))!;
  if (!stored.errand.quote_id) return;
  const claim = await deps.quotes.getQuoteClaim(stored.errand.quote_id).catch(() => null);
  if (!claim) return;
  deps.print(`Verdict: ${claim.status}${claim.reason_code ? ` (${claim.reason_code})` : ''}`);
  if (claim.entries_preview) {
    deps.print('Settlement lines');
    for (const line of settlementLines(claim.entries_preview)) deps.print(line);
  }
};

/** Drive an errand to rest, narrating each transition as it happens.
 * VALET_PAUSE_AT=<STATE> is VAL-8's deterministic pause hook: entering the
 * named state parks the process BEFORE that state's side effect runs, so a
 * durability test can SIGKILL at an exact boundary — no racy timing. */
const driveNoisily = async (deps: CliDeps, errandId: string): Promise<ErrandState> => {
  for (;;) {
    const before = (await deps.store.get(errandId))!;
    const next = await deps.driver.step(errandId);
    if (!next) return before.state;
    deps.print(`${before.state} → ${next.state}`);
    if (before.state === 'SEARCHING' && next.state === 'QUOTED') {
      await printQuoteAndClaims(deps, errandId);
    }
    if (process.env['VALET_PAUSE_AT'] === next.state) {
      deps.print(`PAUSED_AT ${next.state}`);
      await new Promise(() => {}); // held until the test kills the process
    }
  }
};

export const runCli = async (
  argv: string[],
  deps: CliDeps,
): Promise<number> => {
  const [command, ...rest] = argv;

  if (command === 'brief') {
    const text = rest.find((a) => !a.startsWith('--'));
    if (!text) {
      deps.print('Usage: valet brief "<text>" [--sub-hash <hash>] [--max-pence <n>]');
      return 1;
    }
    const flag = (name: string): string | undefined => {
      const index = rest.indexOf(`--${name}`);
      return index >= 0 ? rest[index + 1] : undefined;
    };
    const maxPence = flag('max-pence');
    const brief = Brief.parse({
      text,
      max_price: maxPence ? pence(Number(maxPence)) : null,
      sub_hash: flag('sub-hash') ?? null,
    });
    const started = await deps.driver.startErrand({ brief });
    deps.print(`Errand ${started.errand.errand_id} briefed: "${brief.text}"`);
    const finalState = await driveNoisily(deps, started.errand.errand_id);
    await printVerdict(deps, started.errand.errand_id);
    deps.print(`Errand finished in state ${finalState}.`);
    return finalState === 'CONFIRMED' ? 0 : 1;
  }

  if (command === 'resume') {
    const errandId = rest[0];
    if (!errandId) {
      deps.print('Usage: valet resume <ern_id>');
      return 1;
    }
    const finalState = await driveNoisily(deps, errandId);
    await printVerdict(deps, errandId);
    deps.print(`Errand finished in state ${finalState}.`);
    return finalState === 'CONFIRMED' ? 0 : 1;
  }

  if (command === 'status') {
    const errandId = rest[0];
    if (!errandId) {
      deps.print('Usage: valet status <ern_id>');
      return 1;
    }
    const stored = await deps.store.get(errandId);
    if (!stored) {
      deps.print(`No errand ${errandId} found.`);
      return 1;
    }
    deps.print(`Errand ${errandId}: ${stored.state}`);
    await printQuoteAndClaims(deps, errandId);
    await printVerdict(deps, errandId);
    return 0;
  }

  deps.print('Usage: valet <brief|resume|status> …');
  return 1;
};

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  const deps = buildCliDeps(envFromProcess(), (line) => console.log(line));
  runCli(process.argv.slice(2), deps)
    .then(async (code) => {
      await deps.close();
      process.exitCode = code;
    })
    .catch(async (error) => {
      console.error('valet failed:', error instanceof Error ? error.message : error);
      await deps.close();
      process.exitCode = 1;
    });
}
