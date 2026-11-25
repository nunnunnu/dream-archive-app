import assert from 'node:assert/strict';
import test from 'node:test';
import { AiHttpError, aiStats, callAi, retryAfterMs } from './ai-provider.ts';

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

test('Groq 하루 한도(TPD)에 걸린 모델은 풀릴 때까지 부르지 않고 바로 예비로', async () => {
  assert.equal(retryAfterMs('Please try again in 7m2.496s.'), 422_496);
  assert.equal(retryAfterMs('try again in 1h2m3s'), 3_723_000);
  const original = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = (async (url: string | URL | Request) => {
    urls.push(String(url));
    return String(url).includes('groq')
      ? new Response('Rate limit reached on tokens per day (TPD): Limit 200000. Please try again in 7m2s.', { status: 429 })
      : Response.json(openAiResponse('답'));
  }) as typeof fetch;
  try {
    const req = { instructions: 'x', input: 'y', primaryModel: 'tpd-test-model' };
    await callAi({ GROQ_API_KEY: 'g', OPENAI_API_KEY: 'o' }, req);
    await callAi({ GROQ_API_KEY: 'g', OPENAI_API_KEY: 'o' }, req);
    assert.equal(urls.filter((u) => u.includes('groq')).length, 1);
    assert.equal(urls.filter((u) => u.includes('api.openai.com')).length, 2);
  } finally { globalThis.fetch = original; }
});

// 잔액 없음 상태는 10분 동안 남으니 이 파일 맨 끝에 둔다
test('OpenAI 잔액 없음이면 그 뒤로는 OpenAI를 부르지 않고 바로 실패하고, 시도는 실패도 센다', async () => {
  const original = globalThis.fetch;
  let openaiCalls = 0;
  globalThis.fetch = (async (url: string | URL | Request) => {
    if (String(url).includes('groq')) return new Response('limit', { status: 429 });
    openaiCalls++;
    return new Response('{"error":{"message":"You have no credits remaining.","type":"insufficient_quota"}}', { status: 429 });
  }) as typeof fetch;
  try {
    const before = aiStats.attempts;
    for (let i = 0; i < 3; i++) await assert.rejects(callAi({ GROQ_API_KEY: 'g', OPENAI_API_KEY: 'o' }, { instructions: 'x', input: 'y', primaryModel: 'quota-test-model' }), AiHttpError);
    assert.equal(openaiCalls, 1);
    assert.equal(aiStats.attempts - before, 3);
  } finally { globalThis.fetch = original; }
});
