import assert from 'node:assert/strict';
import { test } from 'node:test';
import { seriesDates } from './recurrence.ts';

test('회차 날짜: 첫 방송 월요일부터 월·화, 회차 수까지', () => {
  const eps = seriesDates('2026-11-16', [1, 2], { episodes: 4, until: '2026-12-31' });
  assert.deepEqual(eps, [
    { date: '2026-11-16', episode: 1 },
    { date: '2026-11-17', episode: 2 },
    { date: '2026-11-23', episode: 3 },
    { date: '2026-11-24', episode: 4 },
  ]);
  // 회차 수를 모르면 정해진 날까지만
  assert.equal(seriesDates('2026-11-16', [1, 2], { until: '2026-12-10' }).length, 8);
});
