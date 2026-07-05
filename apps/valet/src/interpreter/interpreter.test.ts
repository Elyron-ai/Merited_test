import { Brief, pence } from '@merited/contracts';
import { describe, expect, it } from 'vitest';
import {
  AnthropicInterpreter,
  interpreterFromEnv,
  priceCeilingFrom,
  ScriptedInterpreter,
} from './index.js';

/**
 * PH2-5: the scripted path is BYTE-DETERMINISTIC (the recorded demo's
 * guarantee under VALET_DETERMINISTIC=1); the LLM path parses to a valid
 * Brief or FAILS CLOSED to the scripted result — never a stall, never an
 * invalid brief, never a leaked key.
 */

const toolResponse = (input: unknown, status = 200): Response =>
  new Response(JSON.stringify({ content: [{ type: 'tool_use', input }] }), {
    status,
    headers: { 'content-type': 'application/json' },
  });

describe('priceCeilingFrom (integer maths only)', () => {
  it.each([
    ['spa day under £120', 12000],
    ['book me dinner max £95.50', 9550],
    ['gift under £95.5', 9550],
    ['£20 treat', 2000],
  ])('%s → %d pence', (text, expected) => {
    expect(priceCeilingFrom(text)).toEqual(pence(expected));
  });

  it('no price → null; digits without £ are not a ceiling', () => {
    expect(priceCeilingFrom('a nice spa day')).toBeNull();
    expect(priceCeilingFrom('table for 4 at 8pm')).toBeNull();
  });
});

describe('ScriptedInterpreter (VALET_DETERMINISTIC=1 path)', () => {
  it('is byte-deterministic: same input, same Brief JSON, every time', async () => {
    const interpreter = new ScriptedInterpreter();
    const first = await interpreter.interpret('spa day under £120', { sub_hash: 'a'.repeat(64) });
    const second = await interpreter.interpret('spa day under £120', { sub_hash: 'a'.repeat(64) });
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(first).toEqual({
      text: 'spa day under £120',
      max_price: pence(12000),
      sub_hash: 'a'.repeat(64),
    });
    expect(Brief.parse(first)).toEqual(first);
  });
});

describe('AnthropicInterpreter (flag off: valid Brief or fail closed)', () => {
  const nl = 'find me a relaxing spa day, budget about £90';

  it('a well-formed tool response becomes a valid Brief', async () => {
    const interpreter = new AnthropicInterpreter({
      apiKey: 'sk-ant-stub-not-a-real-key',
      fetchImpl: (async () => toolResponse({ search_text: 'spa day', max_price_pence: 9000 })) as typeof fetch,
    });
    const brief = await interpreter.interpret(nl, { sub_hash: null });
    expect(brief).toEqual({ text: 'spa day', max_price: pence(9000), sub_hash: null });
    expect(Brief.parse(brief)).toEqual(brief);
  });

  it('null ceiling from the model is honoured', async () => {
    const interpreter = new AnthropicInterpreter({
      apiKey: 'sk-ant-stub',
      fetchImpl: (async () => toolResponse({ search_text: 'spa day', max_price_pence: null })) as typeof fetch,
    });
    expect((await interpreter.interpret(nl)).max_price).toBeNull();
  });

  it.each([
    ['HTTP error', async () => new Response('overloaded', { status: 529 })],
    ['network failure', async () => { throw new Error('ECONNREFUSED'); }],
    ['no tool block', async () => new Response(JSON.stringify({ content: [{ type: 'text' }] }), { status: 200 })],
    ['empty search_text', async () => toolResponse({ search_text: '', max_price_pence: 9000 })],
    ['float pence', async () => toolResponse({ search_text: 'spa', max_price_pence: 90.5 })],
    ['negative pence', async () => toolResponse({ search_text: 'spa', max_price_pence: -1 })],
  ])('FAILS CLOSED to the scripted result on %s', async (_name, impl) => {
    const interpreter = new AnthropicInterpreter({
      apiKey: 'sk-ant-stub',
      fetchImpl: impl as typeof fetch,
    });
    const brief = await interpreter.interpret(nl, { sub_hash: null });
    // exactly what the scripted path produces for the same input
    expect(brief).toEqual(await new ScriptedInterpreter().interpret(nl, { sub_hash: null }));
    expect(brief.max_price).toEqual(pence(9000)); // '£90' extracted deterministically
  });

  it('sends the key in the header and the errand text in the body — nothing else leaves', async () => {
    let captured: { headers: Headers; body: string } | null = null;
    const interpreter = new AnthropicInterpreter({
      apiKey: 'sk-ant-stub-key',
      fetchImpl: (async (_url: RequestInfo | URL, init?: RequestInit) => {
        captured = { headers: new Headers(init?.headers), body: String(init?.body) };
        return toolResponse({ search_text: 'spa', max_price_pence: null });
      }) as typeof fetch,
    });
    await interpreter.interpret(nl, { sub_hash: 's'.repeat(64) });
    expect(captured!.headers.get('x-api-key')).toBe('sk-ant-stub-key');
    expect(captured!.body).toContain(nl);
    expect(captured!.body).not.toContain('s'.repeat(64)); // the identity handle NEVER goes to the model
  });
});

describe('interpreterFromEnv (§6.6 selection)', () => {
  it('VALET_DETERMINISTIC=1 pins scripted even with a key configured', () => {
    expect(
      interpreterFromEnv({ VALET_DETERMINISTIC: '1', MERITED_ANTHROPIC_API_KEY: 'sk-ant-x' }),
    ).toBeInstanceOf(ScriptedInterpreter);
  });

  it('no key → scripted; key without the flag → the LLM path', () => {
    expect(interpreterFromEnv({})).toBeInstanceOf(ScriptedInterpreter);
    expect(interpreterFromEnv({ MERITED_ANTHROPIC_API_KEY: 'sk-ant-x' })).toBeInstanceOf(
      AnthropicInterpreter,
    );
  });
});
