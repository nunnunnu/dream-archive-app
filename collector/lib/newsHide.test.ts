import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findFeedItem, hideNews, normUrl } from './newsHide.ts';
import { decideReport, type Report } from './reports.ts';
import type { FeedItem } from './publish.ts';

const feed: FeedItem[] = [
  { type: 'news', title: '묶인 기사', url: 'https://a.com/1', publishedAt: '2026-11-22T00:00:00Z', members: [], articles: [{ title: 'b', url: 'https://www.b.com/2/?utm_source=x', publisher: 'B', publishedAt: '' }] },
  { type: 'youtube', title: '영상', url: 'https://youtu.be/xyz', publishedAt: '2026-11-21T00:00:00Z', members: [] },
];

test('주소 비교: www·끝 슬래시·utm·# 무시', () => {
  assert.equal(normUrl('https://www.B.com/2/?utm_source=x#top'), normUrl('https://b.com/2'));
});

test('묶음 안의 기사 주소로도 소식을 찾고, 그 묶음째 숨긴다', () => {
  assert.equal(findFeedItem(feed, 'https://b.com/2')?.title, '묶인 기사');
  const shown = hideNews(feed, [{ url: 'https://b.com/2', urls: [], title: '', reason: '', at: '' }]);
  assert.deepEqual(shown.map((f) => f.title), ['영상']);
  assert.equal(hideNews(feed, []).length, 2);
});

test('운영자가 소식 삭제를 승인하면 숨김 목록에 들어가고 일정 숨기기는 안 건드린다', () => {
  const r = { id: 'r1', type: 'delete', target: 'news', newsUrl: 'https://youtu.be/xyz', newsTitle: '영상', url: '', message: '', eventId: '', eventTitle: '소식 · 영상', date: '', time: '', members: [], status: 'pending', createdAt: '' } as unknown as Report;
  const overrides = { hide: [], patch: [] };
  const hidden: Parameters<typeof decideReport>[4] = [];
  const out = decideReport(r, { action: 'approve', at: '' }, overrides, new Date(), hidden);
  assert.equal(out.applied, true);
  assert.equal(r.status, 'approved');
  assert.equal(overrides.hide.length, 0);
  assert.equal(hidden.length, 1);
  assert.deepEqual(hideNews(feed, hidden!).map((f) => f.title), ['묶인 기사']);
});
