import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ExtractionRecord } from './repo.ts';
import type { Overrides } from './overrides.ts';
import { closeDuplicateReports, decideReport, isOfficialReportSource, reportTarget, type Report } from './reports.ts';

const extraction = (url: string, title: string) => ({
  source: { type: 'submission', id: 'x', url, title, publishedAt: '2026-11-20T00:00:00Z' },
} as ExtractionRecord);

test('제보 자동 승인 출처는 위버스와 등록된 유튜브 채널로 제한한다', () => {
  assert.equal(isOfficialReportSource(extraction('https://weverse.io/nctdream/notice/1', '공지')), true);
  assert.equal(isOfficialReportSource(extraction('https://youtube.com/watch?v=123', 'NCT DREAM: 영상')), true);
  assert.equal(isOfficialReportSource(extraction('https://youtube.com/watch?v=123', '팬 채널: 영상')), false);
  assert.equal(isOfficialReportSource(extraction('https://example.com/post', '임의 게시물')), false);
});


const report = (over: Partial<Report>): Report => ({
  id: 'r1', type: 'delete', url: '', message: '드림 일정 아님', eventId: 'e1', eventTitle: '11. 20 한터 차트 · 발표', date: '', time: '', members: [],
  status: 'pending', createdAt: '2026-11-20T00:00:00Z', ...over,
});
const now = new Date('2026-11-22T03:00:00Z');
const empty = (): Overrides => ({ hide: [], patch: [] });

test('운영자 거절은 상태만 바꾼다', () => {
  const r = report({});
  const o = empty();
  assert.equal(decideReport(r, { action: 'reject', at: now.toISOString() }, o, now).applied, true);
  assert.equal(r.status, 'rejected');
  assert.equal(r.reviewMode, 'manual');
  assert.deepEqual(o, empty());
});

test('운영자 삭제 승인은 숨기기에 넣고, 제보 일정 정보가 있으면 그걸로 찾는다', () => {
  const r = report({ eventSnapshot: { id: 'e9', date: '2026-11-20', title: '한터 차트', step: '발표' } });
  const o = empty();
  decideReport(r, { action: 'approve', at: now.toISOString() }, o, now);
  assert.equal(r.status, 'approved');
  assert.deepEqual(o.hide.map((h) => [h.id, h.date, h.title, h.reportId]), [['e9', '2026-11-20', '한터 차트 발표', 'r1']]);
  // 같은 제보를 두 번 적용해도 하나만
  decideReport({ ...r, status: 'pending' }, { action: 'approve', at: now.toISOString() }, o, now);
  assert.equal(o.hide.length, 1);
});

test('일정 정보가 없으면 "11. 20 제목 · 단계"에서 날짜·제목을 꺼낸다', () => {
  const t = reportTarget(report({}), '2026');
  assert.deepEqual([t.id, t.date, t.title], ['e1', '2026-11-20', '한터 차트 발표']);
});

test('운영자 보완 승인은 고치기에 넣는다', () => {
  const r = report({ type: 'fix', date: '2026-11-21', time: '18:00', members: ['재민'] });
  const o = empty();
  decideReport(r, { action: 'approve', at: now.toISOString(), note: '확인함' }, o, now);
  assert.deepEqual(o.patch[0].set, { date: '2026-11-21', time: '18:00', members: ['재민'] });
  assert.match(r.reviewReason ?? '', /메모: 확인함/);
});

test('링크 없는 추가 요청은 승인해도 대기로 남고, 링크가 있으면 제보 대기열로', () => {
  const noLink = report({ type: 'add' });
  assert.equal(decideReport(noLink, { action: 'approve', at: now.toISOString() }, empty(), now).applied, false);
  assert.equal(noLink.status, 'pending');
  const withLink = report({ type: 'add', url: 'https://x.com/a/status/1' });
  const out = decideReport(withLink, { action: 'approve', at: now.toISOString() }, empty(), now);
  assert.equal(out.submit, 'https://x.com/a/status/1');
  assert.equal(withLink.status, 'approved');
});

test('같은 종류·같은 링크 제보는 먼저 온 것만 남기고 나중 대기 제보는 닫는다', () => {
  const rs = Object.fromEntries([
    report({ id: 'a', type: 'news', url: 'https://x.com/A/status/1?utm_source=x', createdAt: '2026-11-24T01:00:00Z' }),
    report({ id: 'b', type: 'news', url: 'https://x.com/A/status/1', createdAt: '2026-11-24T02:00:00Z' }),
    report({ id: 'c', type: 'add', url: 'https://x.com/A/status/1', createdAt: '2026-11-24T03:00:00Z' }), // 종류가 다르면 따로
    report({ id: 'd', type: 'news', url: 'https://x.com/B/status/2', status: 'rejected', createdAt: '2026-11-24T01:00:00Z' }),
    report({ id: 'e', type: 'news', url: 'https://x.com/B/status/2', createdAt: '2026-11-24T02:00:00Z' }), // 먼저 것이 거절이면 다시 본다
  ].map((r) => [r.id, r]));
  const log = closeDuplicateReports(rs, now);
  assert.equal(log.length, 1);
  assert.equal(rs.b.status, 'rejected');
  assert.match(rs.b.reviewReason!, /\(a\)/);
  assert.equal(rs.a.status, 'pending');
  assert.equal(rs.c.status, 'pending');
  assert.equal(rs.e.status, 'pending');
});
