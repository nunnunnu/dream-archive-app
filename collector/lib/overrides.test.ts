import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PublicEvent } from './consolidate.ts';
import { applyOverrides } from './overrides.ts';

const ev = (id: string, date: string, title: string, step: string): PublicEvent => ({
  id, date, time: '15:20', endDate: null, endTime: null, timezone: null, title, step, kind: '방송', members: [], scope: '단체', status: 'needs-check',
  evidence: '', sources: [], category: '공식', calendars: ['공식'], audience: 'all', extractedBy: 'ai',
} as unknown as PublicEvent);

test('승인한 삭제·보완 제보: id가 바뀌어도 날짜·제목으로 찾아 숨기고 고친다', () => {
  const events = [ev('a', '2026-11-22', 'SBS 인기가요', '출연'), ev('b', '2026-11-14', "MBC '쇼! 음악중심'", '쇼! 음악중심 출연'), ev('c', '2026-11-15', '기타', '기타')];
  const r = applyOverrides(events, {
    hide: [{ id: 'old-id', date: '2026-11-15', title: '기타' }],
    patch: [{ id: 'b', date: '2026-11-14', title: '쇼! 음악중심', set: { time: '15:25', members: ['재민'] } }],
  });
  assert.deepEqual(r, { hidden: 1, patched: 1 });
  assert.equal(events.length, 2);
  const b = events.find((e) => e.id === 'b')!;
  assert.deepEqual([b.time, b.members, b.status], ['15:25', ['재민'], 'confirmed']);
});
