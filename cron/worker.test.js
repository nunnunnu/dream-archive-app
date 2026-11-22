import assert from 'node:assert/strict';
import test from 'node:test';
import worker, { modeFor, needsPendingReport } from './worker.js';

test('정각은 full, 30분은 fast, 50분 backfill이다', () => {
  assert.equal(modeFor('0,15,30,45 * * * *', Date.UTC(2026, 10, 20, 0, 0)), 'full');
  assert.equal(modeFor('0,15,30,45 * * * *', Date.UTC(2026, 10, 20, 0, 30)), 'fast');
  assert.equal(modeFor('50 */3 * * *', Date.UTC(2026, 10, 20, 0, 50)), 'backfill');
});

test('15·45분만 pending 제보가 있어야 실행한다', () => {
  const cron = '0,15,30,45 * * * *';
  assert.equal(needsPendingReport(cron, Date.UTC(2026, 10, 20, 0, 15)), true);
  assert.equal(needsPendingReport(cron, Date.UTC(2026, 10, 20, 0, 45)), true);
  assert.equal(needsPendingReport(cron, Date.UTC(2026, 10, 20, 0, 0)), false);
  assert.equal(needsPendingReport(cron, Date.UTC(2026, 10, 20, 0, 30)), false);
  assert.equal(needsPendingReport('50 */3 * * *', Date.UTC(2026, 10, 20, 0, 50)), false);
});

test('제보가 없으면 dispatch하지 않는다', async () => {
  const originalFetch = globalThis.fetch;
  let dispatched = false;
  globalThis.fetch = async () => { dispatched = true; return new Response(null, { status: 204 }); };
  try {
    await worker.scheduled(
      { cron: '0,15,30,45 * * * *', scheduledTime: Date.UTC(2026, 10, 20, 0, 15) },
      { REPORTS: { get: async () => null } },
    );
    assert.equal(dispatched, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('제보 dispatch 성공 뒤 같은 신호만 지운다', async () => {
  const originalFetch = globalThis.fetch;
  let deleted = false;
  globalThis.fetch = async () => new Response(null, { status: 204 });
  try {
    await worker.scheduled(
      { cron: '0,15,30,45 * * * *', scheduledTime: Date.UTC(2026, 10, 20, 0, 45) },
      { REPORTS: { get: async () => 'report-1', delete: async () => { deleted = true; } }, GH_DISPATCH_TOKEN: 'test' },
    );
    assert.equal(deleted, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('5분 단위는 정기 실행 없이 링크 찾기만, 찾을 시각은 지난 10분 안의 것만', async () => {
  const { dueLinkTimes } = await import('./worker.js');
  assert.equal(modeFor('*/5 * * * *', Date.UTC(2026, 10, 20, 0, 5)), null);
  assert.equal(modeFor('*/5 * * * *', Date.UTC(2026, 10, 20, 0, 0)), 'full');
  const wake = { times: ['2026-11-20T00:05:00.000Z', '2026-11-20T01:00:00.000Z'] };
  assert.deepEqual(dueLinkTimes(wake, Date.UTC(2026, 10, 20, 0, 10)), ['2026-11-20T00:05:00.000Z']);
  assert.deepEqual(dueLinkTimes(wake, Date.UTC(2026, 10, 20, 0, 20)), []);
});

test('링크 찾기 시각이 되면 links를 한 번만 띄운다', async () => {
  const originalFetch = globalThis.fetch;
  const modes = [];
  globalThis.fetch = async (_url, init) => { modes.push(JSON.parse(init.body).inputs.mode); return new Response(null, { status: 204 }); };
  const store = new Map([['wake:links', JSON.stringify({ times: ['2026-11-20T00:05:00.000Z'] })]]);
  const REPORTS = {
    get: async (k, type) => (store.has(k) ? (type === 'json' ? JSON.parse(store.get(k)) : store.get(k)) : null),
    put: async (k, v) => { store.set(k, v); },
    delete: async (k) => { store.delete(k); },
  };
  try {
    await worker.scheduled({ cron: '*/5 * * * *', scheduledTime: Date.UTC(2026, 10, 20, 0, 5) }, { REPORTS });
    await worker.scheduled({ cron: '*/5 * * * *', scheduledTime: Date.UTC(2026, 10, 20, 0, 10) }, { REPORTS });
    assert.deepEqual(modes, ['links']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
