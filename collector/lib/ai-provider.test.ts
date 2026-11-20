import assert from 'node:assert/strict';
import test from 'node:test';
import { AiHttpError, callAi } from './ai-provider.ts';

const openAiResponse = (text: string) => ({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text }] }], usage: { input_tokens: 10, output_tokens: 2 } });

test('Groq 성공이면 OpenAI를 호출하지 않는다', async () => {
  const original = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = (async (url: string | URL | Request) => {
    urls.push(String(url));
    return Response.json({ choices: [{ message: { content: '{"ok":true}' } }], usage: { prompt_tokens: 4, completion_tokens: 2 } });
  }) as typeof fetch;
  try {
    const r = await callAi({ GROQ_API_KEY: 'g', OPENAI_API_KEY: 'o' }, { instructions: 'x', input: 'y', schema: { name: 't', schema: { type: 'object' } } });
    assert.equal(r.provider, 'groq');
    assert.equal(r.usage.costUsd, 0);
    assert.equal(urls.length, 1);
  } finally { globalThis.fetch = original; }
});

test('Groq 429면 OpenAI 예비 모델을 호출한다', async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => ++calls === 1
    ? new Response('limit', { status: 429 })
    : Response.json(openAiResponse('답'))) as typeof fetch;
  try {
    const r = await callAi({ GROQ_API_KEY: 'g', OPENAI_API_KEY: 'o' }, { instructions: 'x', input: 'y' });
    assert.equal(r.provider, 'openai');
    assert.equal(calls, 2);
  } finally { globalThis.fetch = original; }
});

test('Groq 키 오류에서는 유료 fallback을 호출하지 않는다', async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => { calls++; return new Response('bad key', { status: 401 }); }) as typeof fetch;
  try {
    await assert.rejects(() => callAi({ GROQ_API_KEY: 'bad', OPENAI_API_KEY: 'o' }, { instructions: 'x', input: 'y' }), (e) => e instanceof AiHttpError && e.status === 401);
    assert.equal(calls, 1);
  } finally { globalThis.fetch = original; }
});
