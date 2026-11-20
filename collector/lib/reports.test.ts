import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ExtractionRecord } from './repo.ts';
import { isOfficialReportSource } from './reports.ts';

const extraction = (url: string, title: string) => ({
  source: { type: 'submission', id: 'x', url, title, publishedAt: '2026-11-20T00:00:00Z' },
} as ExtractionRecord);

test('제보 자동 승인 출처는 위버스와 등록된 유튜브 채널로 제한한다', () => {
  assert.equal(isOfficialReportSource(extraction('https://weverse.io/nctdream/notice/1', '공지')), true);
  assert.equal(isOfficialReportSource(extraction('https://youtube.com/watch?v=123', 'NCT DREAM: 영상')), true);
  assert.equal(isOfficialReportSource(extraction('https://youtube.com/watch?v=123', '팬 채널: 영상')), false);
  assert.equal(isOfficialReportSource(extraction('https://example.com/post', '임의 게시물')), false);
});
