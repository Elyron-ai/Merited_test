import { Brief, pence, type Money } from '@merited/contracts';

/**
 * Brief interpretation (PH2-5, §6.6): natural language → the structured
 * `Brief` contract. Two implementations behind one interface:
 *
 * - `ScriptedInterpreter` — PURE and deterministic: same input, same Brief,
 *   byte for byte, no IO. `VALET_DETERMINISTIC=1` (the spec's literal flag)
 *   pins it so the recorded demo never depends on model nondeterminism.
 * - `AnthropicInterpreter` — the optional LLM path (plain fetch, no SDK;
 *   key only via `MERITED_ANTHROPIC_API_KEY` — a real key is an env change,
 *   never a code change). ANY failure — network, refusal, malformed output,
 *   invalid schema — FAILS CLOSED to the scripted result, so the errand
 *   pipeline never stalls on a model.
 */

export interface InterpretContext {
  sub_hash?: string | null;
}

export interface BriefInterpreter {
  interpret(text: string, ctx?: InterpretContext): Promise<Brief>;
}

/** "under £95" / "max £95.50" / "£20" → integer pence via INTEGER maths
 * (pounds and pence parsed separately — no parseFloat near money). */
export const priceCeilingFrom = (text: string): Money | null => {
  const match = text.match(/£\s*(\d+)(?:\.(\d{1,2}))?/);
  if (!match) return null;
  const pounds = parseInt(match[1]!, 10);
  const penceDigits = match[2] ? match[2].padEnd(2, '0') : '00';
  return pence(pounds * 100 + parseInt(penceDigits, 10));
};

export class ScriptedInterpreter implements BriefInterpreter {
  async interpret(text: string, ctx: InterpretContext = {}): Promise<Brief> {
    return Brief.parse({
      text,
      max_price: priceCeilingFrom(text),
      sub_hash: ctx.sub_hash ?? null,
    });
  }
}

export interface AnthropicInterpreterOptions {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  fetchImpl?: typeof fetch;
}

const BRIEF_TOOL = {
  name: 'structured_brief',
  description: 'The structured shopping brief extracted from the errand text.',
  input_schema: {
    type: 'object',
    properties: {
      search_text: { type: 'string', description: 'What to search the offer catalogue for.' },
      max_price_pence: {
        type: ['integer', 'null'],
        description: 'Budget ceiling in integer pence of GBP; null when no ceiling was given.',
      },
    },
    required: ['search_text', 'max_price_pence'],
  },
} as const;

export class AnthropicInterpreter implements BriefInterpreter {
  private readonly fallback = new ScriptedInterpreter();

  constructor(private readonly options: AnthropicInterpreterOptions) {}

  async interpret(text: string, ctx: InterpretContext = {}): Promise<Brief> {
    try {
      const doFetch = this.options.fetchImpl ?? fetch;
      const response = await doFetch(`${this.options.baseUrl ?? 'https://api.anthropic.com'}/v1/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': this.options.apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: this.options.model ?? 'claude-haiku-4-5-20251001',
          max_tokens: 256,
          tools: [BRIEF_TOOL],
          tool_choice: { type: 'tool', name: 'structured_brief' },
          messages: [{ role: 'user', content: `Extract the structured brief from this shopping errand: ${text}` }],
        }),
      });
      if (!response.ok) return this.fallback.interpret(text, ctx);
      const payload = (await response.json()) as {
        content?: Array<{ type: string; input?: { search_text?: unknown; max_price_pence?: unknown } }>;
      };
      const tool = payload.content?.find((block) => block.type === 'tool_use');
      const searchText = tool?.input?.search_text;
      const maxPence = tool?.input?.max_price_pence;
      if (typeof searchText !== 'string' || searchText.length === 0) {
        return this.fallback.interpret(text, ctx);
      }
      if (maxPence !== null && (!Number.isInteger(maxPence) || (maxPence as number) < 0)) {
        return this.fallback.interpret(text, ctx);
      }
      return Brief.parse({
        text: searchText,
        max_price: maxPence === null ? null : pence(maxPence as number),
        sub_hash: ctx.sub_hash ?? null,
      });
    } catch {
      // fail closed: the scripted path always produces a valid Brief
      return this.fallback.interpret(text, ctx);
    }
  }
}

/** §6.6 selection: `VALET_DETERMINISTIC=1` pins the scripted path even when
 * a key is configured; no key = scripted; otherwise the LLM path (which
 * itself fails closed to scripted). */
export const interpreterFromEnv = (
  source: Record<string, string | undefined> = process.env,
): BriefInterpreter => {
  if (source['VALET_DETERMINISTIC'] === '1') return new ScriptedInterpreter();
  const apiKey = source['MERITED_ANTHROPIC_API_KEY'];
  if (!apiKey) return new ScriptedInterpreter();
  return new AnthropicInterpreter({ apiKey });
};
