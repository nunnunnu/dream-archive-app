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
