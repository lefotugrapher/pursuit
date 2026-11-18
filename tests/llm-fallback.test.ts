// Provider fallback tests: OpenRouter -> Gemini -> Groq -> local Ollama, and the daily-cap skip.
// globalThis.fetch is stubbed per URL: no network, no real Ollama.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, beforeEach, describe, test } from 'node:test';
import { z } from 'zod';

process.env.PURSUIT_SKIP_ENV_FILE = '1';
process.env.PURSUIT_LOG_SILENT = '1';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pursuit-llm-fallback-test-'));
process.env.PURSUIT_DB_PATH = path.join(TMP, 'fallback.db');

const llm = await import('../src/lib/llm');
const dbm = await import('../src/lib/db');
const envm = await import('../src/lib/env');

const realFetch = globalThis.fetch;
type Handler = (url: string, body: Record<string, unknown>) => Response | Promise<Response>;
let urls: string[] = [];
let bodies: Record<string, unknown>[] = [];

function stub(handler: Handler): void {
  urls = [];
  bodies = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    urls.push(url);
    bodies.push(body);
    return handler(url, body);
  }) as typeof fetch;
}

const json = (obj: unknown, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
const completion = (content: string) => json({ choices: [{ message: { content }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 3 } });
const ollamaReply = (content: string) => json({ message: { role: 'assistant', content }, done: true, done_reason: 'stop', prompt_eval_count: 40, eval_count: 9 });
const dailyCap = () => json({ error: { message: 'Rate limit exceeded: free-models-per-day. Add 10 credits to unlock 1000 free model requests per day', code: 429 } }, 429);

const isOR = (u: string) => u === llm.OPENROUTER_URL;
const isGemini = (u: string) => u === llm.GEMINI_URL;
const isGroq = (u: string) => u === llm.GROQ_URL;
const isOllama = (u: string) => u.endsWith('/api/chat');
const isOrca = (u: string) => u === llm.ORCAROUTER_URL;

const Schema = z.object({ ok: z.boolean() });
const base = { purpose: 'fb.test', system: 'You judge.', user: 'Go.', schema: Schema };

function usage(): { purpose: string; model: string; ok: number; cost_usd: number | null }[] {
  return dbm.db().prepare('SELECT purpose, model, ok, cost_usd FROM llm_usage ORDER BY id').all().map((r) => ({ ...r })) as never;
}

beforeEach(() => {
  process.env.OPENROUTER_API_KEY = 'sk-or-test-key-123456';
  process.env.LLM_MODELS = 'a/one:free,b/two:free';
  process.env.GEMINI_API_KEY = '';
  process.env.GROQ_API_KEY = '';
  process.env.ORCAROUTER_API_KEY = '';
  delete process.env.ORCAROUTER_MODELS;
  process.env.LLM_LOCAL = '0';
  process.env.OLLAMA_URL = 'http://ollama.test:11434';
  delete process.env.OLLAMA_MODEL;
  delete process.env.LLM_MODEL;
  delete process.env.LLM_ALLOW_PAID;
  llm.LLM_TUNING.backoffMs = 1;
  llm.LLM_TUNING.retries = 2;
  llm.resetLLMState();
  dbm.db().exec('DELETE FROM llm_usage; DELETE FROM events;');
});
afterEach(() => {
  globalThis.fetch = realFetch;
});
after(() => {
  dbm.closeDb();
  fs.rmSync(TMP, { recursive: true, force: true });
});

describe('daily cap', () => {
  test('cap 429 skips remaining OpenRouter models and retries, hands over to Gemini', async () => {
    process.env.GEMINI_API_KEY = 'gem-test-key-123456';
    stub((u) => (isOR(u) ? dailyCap() : completion('{"ok":true}')));
    assert.deepEqual(await llm.llmJSON(base), { ok: true });
    assert.deepEqual(urls, [llm.OPENROUTER_URL, llm.GEMINI_URL]); // one OR call: no retries, no second model
    assert.ok(llm.openRouterCappedUntil() > Date.now());
    assert.equal(llm.openRouterCappedUntil(), llm.nextUtcMidnight());
    assert.equal(usage()[0].model, 'gemini/gemini-2.5-flash');
    assert.equal(usage()[0].cost_usd, 0);
  });

  test('later calls skip OpenRouter entirely until the cap expires', async () => {
    process.env.GEMINI_API_KEY = 'gem-test-key-123456';
    stub((u) => (isOR(u) ? dailyCap() : completion('{"ok":true}')));
    await llm.llmJSON(base);
    stub((u) => (isOR(u) ? dailyCap() : completion('{"ok":true}')));
    await llm.llmJSON(base);
    await llm.llmText(base);
    assert.deepEqual(urls, [llm.GEMINI_URL, llm.GEMINI_URL]);

    // The state is shared through kv: expire it and OpenRouter is tried again.
    llm.resetLLMState(); // clears the in-memory copy too
    dbm.kvSet('llm.openrouter_capped_until', Date.now() - 1000);
    stub((u) => (isOR(u) ? completion('{"ok":true}') : completion('{"ok":false}')));
    assert.deepEqual(await llm.llmJSON(base), { ok: true });
    assert.deepEqual(urls, [llm.OPENROUTER_URL]);
  });

  test('a generic 429 is retried and does not set the daily-cap flag', async () => {
    llm.LLM_TUNING.retries = 1;
    process.env.LLM_MODELS = 'a/one:free';
    stub(() => json({ error: { message: 'slow down' } }, 429));
    assert.equal(await llm.llmJSON(base), null);
    assert.equal(urls.length, 2);
    assert.equal(llm.openRouterCappedUntil(), 0);
  });
});

describe('provider order', () => {
  test('OpenRouter first when healthy: nothing else is called', async () => {
    process.env.GEMINI_API_KEY = 'gem-test-key-123456';
    process.env.LLM_LOCAL = '1';
    stub(() => completion('{"ok":true}'));
    await llm.llmJSON(base);
    assert.deepEqual(urls, [llm.OPENROUTER_URL]);
    assert.equal(usage()[0].model, 'a/one:free');
  });

  test('OpenRouter all-fail, then Gemini, then Groq, then Ollama', async () => {
    llm.LLM_TUNING.retries = 0;
    process.env.GEMINI_API_KEY = 'gem-test-key-123456';
    process.env.GROQ_API_KEY = 'groq-test-key-123456';
    process.env.LLM_LOCAL = '1';
    stub((u) => (isOllama(u) ? ollamaReply('{"ok":true}') : json({ error: { message: 'down' } }, 503)));
    assert.deepEqual(await llm.llmJSON(base), { ok: true });
    assert.deepEqual(urls, [llm.OPENROUTER_URL, llm.OPENROUTER_URL, llm.GEMINI_URL, llm.GROQ_URL, 'http://ollama.test:11434/api/chat']);
    assert.equal(usage()[0].model, 'ollama/qwen3-14b-abl:latest');
    assert.equal(usage()[0].cost_usd, 0);
    // Not a daily cap: OpenRouter is not remembered as capped.
    assert.equal(llm.openRouterCappedUntil(), 0);
  });

  test('Gemini and Groq are skipped without keys; Gemini 429 cools down and Groq answers', async () => {
    llm.LLM_TUNING.retries = 0;
    process.env.OPENROUTER_API_KEY = '';
    process.env.GEMINI_API_KEY = 'gem-test-key-123456';
    process.env.GROQ_API_KEY = 'groq-test-key-123456';
    stub((u) => (isGemini(u) ? json({ error: { message: 'quota' } }, 429) : completion('{"ok":true}')));
    assert.deepEqual(await llm.llmJSON(base), { ok: true });
    assert.deepEqual(urls, [llm.GEMINI_URL, llm.GROQ_URL]);
    assert.equal(usage()[0].model, 'groq/llama-3.3-70b-versatile');
    await llm.llmJSON(base);
    assert.deepEqual(urls, [llm.GEMINI_URL, llm.GROQ_URL, llm.GROQ_URL]); // Gemini cooling down
    assert.equal((bodies[1].response_format as { type: string }).type, 'json_object');
  });

  test('Gemini request disables reasoning and uses its bearer key', async () => {
    process.env.OPENROUTER_API_KEY = '';
    process.env.GEMINI_API_KEY = 'gem-test-key-123456';
    let auth = '';
    globalThis.fetch = (async (_u: unknown, init?: RequestInit) => {
      auth = (init?.headers as Record<string, string>).Authorization;
      return completion('{"ok":true}');
    }) as typeof fetch;
    await llm.llmJSON(base);
    assert.equal(auth, 'Bearer gem-test-key-123456');
  });

  test('configured provider keys are redacted from prompts', async () => {
    process.env.OPENROUTER_API_KEY = '';
    process.env.GROQ_API_KEY = 'groq-test-key-123456';
    stub(() => completion('{"ok":true}'));
    await llm.llmJSON({ ...base, user: 'my key is groq-test-key-123456 ok' });
    assert.ok(!JSON.stringify(bodies[0]).includes('groq-test-key-123456'));
  });
});

describe('local Ollama', () => {
  beforeEach(() => {
    process.env.OPENROUTER_API_KEY = '';
    process.env.LLM_LOCAL = '1';
  });

  test('native chat request: think off, json format, no streaming, options', async () => {
    stub(() => ollamaReply('{"ok":true}'));
    await llm.llmJSON({ ...base, maxTokens: 123, temperature: 0.3 });
    const b = bodies[0] as { model: string; think: boolean; stream: boolean; format?: string; options: Record<string, number> };
    assert.equal(b.model, 'qwen3-14b-abl:latest');
    assert.equal(b.think, false);
    assert.equal(b.stream, false);
    assert.equal(b.format, 'json');
    assert.equal(b.options.num_predict, 123);
    assert.equal(b.options.temperature, 0.3);
    await llm.llmText(base);
    assert.equal((bodies[1] as { format?: string }).format, undefined);
    assert.deepEqual(usage().map((u) => u.ok), [1, 1]);
  });

  test('OLLAMA_MODEL override, and <think> blocks are stripped', async () => {
    process.env.OLLAMA_MODEL = 'qwen3-4b-abl:latest';
    stub(() => ollamaReply('<think>hmm</think>\n{"ok":true}'));
    assert.deepEqual(await llm.llmJSON(base), { ok: true });
    assert.equal((bodies[0] as { model: string }).model, 'qwen3-4b-abl:latest');
  });

  test('requests run one at a time', async () => {
    let active = 0;
    let maxActive = 0;
    stub(async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 15));
      active--;
      return ollamaReply('hello');
    });
    const out = await Promise.all([llm.llmText(base), llm.llmText(base), llm.llmText(base)]);
    assert.deepEqual(out, ['hello', 'hello', 'hello']);
    assert.equal(maxActive, 1);
  });

  test('a failed local call does not block the queue', async () => {
    let n = 0;
    stub(() => (++n === 1 ? json({ error: 'model not found' }, 404) : ollamaReply('fine')));
    const [a, b] = await Promise.all([llm.llmText(base), llm.llmText(base)]);
    assert.equal(a, null);
    assert.equal(b, 'fine');
  });
});

describe('hasLLM', () => {
  test('true for any provider, false when none', () => {
    process.env.OPENROUTER_API_KEY = '';
    process.env.LLM_LOCAL = '0';
    assert.equal(envm.hasLLM(), false);
    process.env.GEMINI_API_KEY = 'gem-test-key-123456';
    assert.equal(envm.hasLLM(), true);
    process.env.GEMINI_API_KEY = '';
    process.env.GROQ_API_KEY = 'groq-test-key-123456';
    assert.equal(envm.hasLLM(), true);
    process.env.GROQ_API_KEY = '';
    process.env.LLM_LOCAL = '1';
    assert.equal(envm.hasLLM(), true);
  });

  test('local Ollama is never used unless LLM_LOCAL=1, even when it is running', async () => {
    process.env.OPENROUTER_API_KEY = '';
    delete process.env.LLM_LOCAL;
    stub(() => json({ models: [] }));
    assert.equal(envm.localLLMEnabled(), false);
    assert.equal(envm.hasLLM(), false);
    process.env.LLM_LOCAL = '0';
    assert.equal(envm.localLLMEnabled(), false);
    delete process.env.LLM_LOCAL;
  });

  test('the /api/tags probe reports whether Ollama answers', async () => {
    process.env.OPENROUTER_API_KEY = '';
    delete process.env.LLM_LOCAL;
    stub(() => json({ models: [] }));
    assert.equal(await envm.refreshLocalProbe(), true);
    assert.deepEqual(urls, ['http://ollama.test:11434/api/tags']);
    stub(() => { throw new Error('connection refused'); });
    assert.equal(await envm.refreshLocalProbe(), false);
  });
});

describe('OrcaRouter', () => {
  const orcaLocked = () => json({ error: { code: 'free_rate_limited', message: 'Free models are not available to this account yet.' } }, 429);

  test('only -free models are ever sent, and it runs after OpenRouter is capped', async () => {
    process.env.ORCAROUTER_API_KEY = 'sk-orca-test-123456';
    process.env.ORCAROUTER_MODELS = 'deepseek/deepseek-v4.1-flash-free,openai/gpt-paid';
    assert.deepEqual(llm.orcaModelChain(), ['deepseek/deepseek-v4.1-flash-free']);
    stub((u) => (isOR(u) ? dailyCap() : completion('{"ok":true}')));
    assert.deepEqual(await llm.llmJSON(base), { ok: true });
    assert.deepEqual(urls, [llm.OPENROUTER_URL, llm.ORCAROUTER_URL]);
    assert.equal(bodies[1].model, 'deepseek/deepseek-v4.1-flash-free');
    assert.deepEqual(bodies[1].reasoning, { enabled: false });
    assert.equal(usage()[0].model, 'orcarouter/deepseek/deepseek-v4.1-flash-free');
  });

  test('a locked free tier pauses OrcaRouter instead of retrying every call', async () => {
    process.env.ORCAROUTER_API_KEY = 'sk-orca-test-123456';
    process.env.GROQ_API_KEY = 'gsk-test-123456';
    stub((u) => (isOR(u) ? dailyCap() : isOrca(u) ? orcaLocked() : completion('{"ok":true}')));
    assert.deepEqual(await llm.llmJSON(base), { ok: true });
    assert.deepEqual(urls, [llm.OPENROUTER_URL, llm.ORCAROUTER_URL, llm.GROQ_URL]); // one Orca call, no other Orca models
    stub((u) => (isOrca(u) ? orcaLocked() : completion('{"ok":true}')));
    await llm.llmJSON(base);
    assert.deepEqual(urls, [llm.GROQ_URL]); // OpenRouter capped, OrcaRouter paused
  });
});
