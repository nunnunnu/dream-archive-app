import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildFeed } from './publish.ts';
import { isFillerArticle, isNegative, topicOf } from './topics.ts';

test('화보: 룩북·잡지 커버는 화보로, 매체 이름·노래 커버는 아님', () => {
  assert.equal(topicOf("'리 x NCT 재민' 가을 룩북 공개"), '브랜드·화보');
  assert.equal(topicOf('NCT 제노, 엘르 12월호 커버 장식'), '브랜드·화보');
  assert.equal(topicOf('NCT 마크, 새 출발 – 마리끌레르 코리아'), undefined);
  assert.equal(topicOf('NCT 천러→페더 엘리아스 커버'), undefined);
});

test('잡다한 기사: 라인업, 한 매체 근황은 빼고 티저·콘셉트·여러 매체 기사는 남김', () => {
  assert.equal(isFillerArticle('[인기가요 라인업] 하이키·NCT 드림', 3), true);
  assert.equal(isFillerArticle('NCT 재민, 촬영장 비하인드 셀카', 1), true);
  assert.equal(isFillerArticle('NCT 천러, 콘셉트 사진 공개…강렬 눈빛', 1), false);
  assert.equal(isFillerArticle('NCT 재민 셀카', 4), false);
  assert.equal(isFillerArticle('NCT 재민 셀카 화보', 1, '브랜드·화보'), false);
});

test('소식 만들기: 드림·멤버 이름이 없는 다른 가수 기사는 빼고, 이름이 있으면 남김', () => {
  const a = (title: string, count = 1) => ({ title, url: `https://n.com/${encodeURIComponent(title)}`, publishedAt: '2026-11-20T00:00:00Z', publisher: 'N', count });
  const feed = buildFeed([], [a('규현, 뮤직뱅크서 신곡 공개'), a('10년 함께한 꿈, 다시 시작…NCT 드림 정규 6집으로 컴백'), a('NCT DREAM, 정규 6집 쇼케이스 개최', 4), a('NCT 재민, 거울 셀카로 전한 근황')], [], new Date('2026-11-22'));
  assert.deepEqual(feed.map((f) => f.title).sort(), ['10년 함께한 꿈, 다시 시작…NCT 드림 정규 6집으로 컴백', 'NCT DREAM, 정규 6집 쇼케이스 개최'].sort());
});

test('주가·실적 기사는 빼고, 차트 기사는 남김', () => {
  assert.equal(isNegative('[에스엠 주가전망] 엔시티 드림 4분기 컴백 앞두고 한중 FTA 타결 다시 봐야 할 이유'), true);
  assert.equal(isNegative("NCT 제노...'스타 마케팅 효과' 마뗑킴 매출 150% 증가"), true);
  assert.equal(isNegative('에스엠, 3분기 영업이익 개선…엔시티 드림 효과'), true);
  assert.equal(isNegative('엔시티 드림, 한터 11월 2주 차 1위'), false);
  assert.equal(isNegative('NCT DREAM 정규 6집 초동 판매량 100만 장'), false);
});
