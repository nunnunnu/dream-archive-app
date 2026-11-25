import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BATCH_JOBS, BATCH_STATE, collectBatches, submitBatch, type BatchArticle, type BatchJob } from './batch.ts';
import { Budget } from './budget.ts';
import type { ArticleRecord, ExtractionRecord, Repo } from './repo.ts';

// 실제 키로 OpenAI를 부르지 않게: 테스트용 키, 모든 테스트에서 fetch를 바꿔 끼운다
process.env.OPENAI_API_KEY = 'test';

function fakeRepo(articles: ArticleRecord[]) {
  const state = new Map<string, unknown>();
  const extractions: ExtractionRecord[] = [];
  const repo = {
    getState: async (k: string, d: unknown) => (state.has(k) ? structuredClone(state.get(k)) : d),
    putState: async (k: string, v: unknown) => { state.set(k, structuredClone(v)); },
    getBody: async () => '12월 3일 오후 8시 아는 형님 출연',
    putExtraction: async (r: ExtractionRecord) => { extractions.push(r); },
    listArticles: async () => articles,
    putArticles: async (list: ArticleRecord[]) => { for (const a of list) Object.assign(articles.find((x) => x.guid === a.guid)!, a); },
  } as unknown as Repo;
  return { repo, state, extractions };
}

const responseBody = (text: string) => ({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text }] }], usage: { input_tokens: 1000, output_tokens: 200 } });

test('배치: 대기열을 묶음 하나로 보내고, 결과가 오면 저장하고 실패한 것은 다시 보낼 수 있게 둔다', async () => {
  const articles = [{ guid: 'g1', title: '기사1', status: 'pending' }, { guid: 'g2', title: '기사2', status: 'pending' }] as ArticleRecord[];
  const { repo, state, extractions } = fakeRepo(articles);
  const now = new Date('2026-11-25T20:30:00Z');
  await repo.putState(BATCH_STATE, {
    g1: { queuedAt: now.toISOString(), title: '기사1', writtenAt: '2026-11-01T03:00:00Z', url: 'https://a.example/1', publisher: '어떤일보' },
    g2: { queuedAt: now.toISOString(), title: '기사2', writtenAt: '2026-11-02T03:00:00Z', url: 'https://a.example/2' },
  } satisfies Record<string, BatchArticle>);
  const budget = await new Budget(repo, now).load();

  const original = globalThis.fetch;
  let uploaded = '';
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (u.endsWith('/files') && init?.method === 'POST') { uploaded = await ((init.body as FormData).get('file') as Blob).text(); return Response.json({ id: 'file1' }); }
    if (u.endsWith('/batches') && init?.method === 'POST') return Response.json({ id: 'batch1' });
    if (u.endsWith('/batches/batch1')) return Response.json({ status: 'completed', output_file_id: 'out1' });
    if (u.endsWith('/files/out1/content')) return new Response([
      JSON.stringify({ custom_id: 'article:g1', response: { status_code: 200, body: responseBody('{"events":[]}') } }),
      JSON.stringify({ custom_id: 'article:g2', response: { status_code: 500, body: {} }, error: { message: 'server' } }),
    ].join('\n'));
    throw new Error(`예상 못 한 요청 ${u}`);
  }) as typeof fetch;
  try {
    assert.match((await submitBatch(repo, budget, now))[0], /기사 2개/);
    const lines = uploaded.split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(lines.map((l) => [l.custom_id, l.url]), [['article:g2', '/v1/responses'], ['article:g1', '/v1/responses']]);
    assert.equal(lines[0].body.model, 'gpt-5-mini');
    assert.deepEqual((state.get(BATCH_JOBS) as BatchJob[]).map((j) => j.id), ['batch1']);

    const log = await collectBatches(repo, budget, now);
    assert.match(log[0], /반영 1개 · 실패 1개 · 다시 보낼 것 1개/);
    assert.equal(extractions.length, 1);
    assert.equal(extractions[0].docId, 'g1');
    assert.equal(extractions[0].source.publisher, '어떤일보');
    assert.equal(articles[0].status, 'processed');
    assert.equal(articles[1].status, 'pending');
    const queue = state.get(BATCH_STATE) as Record<string, BatchArticle>;
    assert.deepEqual(Object.keys(queue), ['g2']);
    assert.equal(queue.g2.jobId, undefined);
    assert.equal(queue.g2.tries, 1);
    assert.deepEqual(state.get(BATCH_JOBS), []);
    assert.ok(budget.monthCostUsd > 0); // 배치 값(절반)으로 비용 기록
  } finally { globalThis.fetch = original; }
});

test('배치: 월 상한이 거의 차면 보내지 않는다', async () => {
  const { repo } = fakeRepo([]);
  const now = new Date('2026-11-25T20:30:00Z');
  await repo.putState(BATCH_STATE, { g1: { queuedAt: now.toISOString(), title: '기사', writtenAt: '2026-11-01T03:00:00Z', url: 'https://a.example/1' } });
  // 노트북에서는 개발 묶음('dev', 상한 $35), Actions에서는 달 묶음 ($5)
  await repo.putState('usage', { '2026-11': { costUsd: 4.9999, calls: 1 }, dev: { costUsd: 34.9999, calls: 1 } });
  const budget = await new Budget(repo, now).load();
  const original = globalThis.fetch;
  let called = false;
  globalThis.fetch = (async () => { called = true; return new Response('{}'); }) as typeof fetch;
  try {
    assert.match((await submitBatch(repo, budget, now))[0], /상한이 거의 차서/);
    assert.equal(called, false);
  } finally { globalThis.fetch = original; }
});

test('배치: 결과를 못 받을 때 — 404면 다시 보내고, 잠깐 오류면 다음 날 다시 확인, 사흘 넘게 안 끝나면 취소하고 다시 보낸다', async () => {
  const { repo, state } = fakeRepo([]);
  const now = new Date('2026-11-25T20:30:00Z');
  const item = (jobId: string): BatchArticle => ({ queuedAt: now.toISOString(), title: '기사', writtenAt: '2026-11-01T03:00:00Z', url: 'https://a.example/1', jobId });
  await repo.putState(BATCH_STATE, { gone: item('b-gone'), flaky: item('b-flaky'), slow: item('b-slow'), stuck: item('b-stuck') });
  await repo.putState(BATCH_JOBS, [
    { id: 'b-gone', createdAt: '2026-11-24T20:30:00Z', count: 1 },
    { id: 'b-flaky', createdAt: '2026-11-24T20:30:00Z', count: 1 },
    { id: 'b-slow', createdAt: '2026-11-24T20:30:00Z', count: 1 },
    { id: 'b-stuck', createdAt: '2026-11-21T20:30:00Z', count: 1 },
  ] satisfies BatchJob[]);
  const budget = await new Budget(repo, now).load();
  const original = globalThis.fetch;
  const cancelled: string[] = [];
  globalThis.fetch = (async (url: string | URL | Request) => {
    const u = String(url);
    if (u.endsWith('/b-gone')) return new Response('not found', { status: 404 });
    if (u.endsWith('/b-flaky')) throw new TypeError('fetch failed');
    if (u.endsWith('/cancel')) { cancelled.push(u); return Response.json({}); }
    if (u.endsWith('/b-slow') || u.endsWith('/b-stuck')) return Response.json({ status: 'in_progress', request_counts: { completed: 0, failed: 0, total: 1 } });
    throw new Error(`예상 못 한 요청 ${u}`);
  }) as typeof fetch;
  try {
    await collectBatches(repo, budget, now);
    const queue = state.get(BATCH_STATE) as Record<string, BatchArticle>;
    assert.equal(queue.gone.jobId, undefined); // 다시 보낼 수 있게
    assert.equal(queue.stuck.jobId, undefined);
    assert.equal(queue.flaky.jobId, 'b-flaky'); // 그대로 두고 다음 날 확인
    assert.equal(queue.slow.jobId, 'b-slow');
    assert.deepEqual((state.get(BATCH_JOBS) as BatchJob[]).map((j) => j.id), ['b-flaky', 'b-slow']);
    assert.equal(cancelled.length, 1);
  } finally { globalThis.fetch = original; }
});
