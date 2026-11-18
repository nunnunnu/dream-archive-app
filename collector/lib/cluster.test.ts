import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clusterArticles, looksLikeSchedule, similarity } from './cluster.ts';
import type { ArticleRecord } from './repo.ts';

const art = (guid: string, title: string, iso = '2026-11-12T00:00:00Z'): ArticleRecord => ({
  guid, title, link: `https://n/${guid}`, source: 's', publishedAt: iso, firstSeenAt: iso, origin: 'search',
});

test('같은 소식 기사는 묶고 다른 소식은 나눈다', () => {
  const list = [
    art('a', "NCT DREAM 재민 ‘전과자’ 등판, 엑소 카이와 찐형제 케미"),
    art('b', "엔시티 드림 재민, ‘전과자’ 깜짝 출연"),
    art('c', "NCT DREAM 재민, 예능 ‘전과자’ 합류…카이와 가천대 방사선학과 체험"),
    art('d', "'꼬꼬무' NCT DREAM 제노 출연...신촌 대학생 살인사건 추적"),
  ];
  const clusters = clusterArticles(list);
  const ofA = clusters.find((c) => c.articles.some((x) => x.guid === 'a'))!;
  assert.ok(ofA.articles.some((x) => x.guid === 'b'), '전과자 기사끼리 묶임');
  assert.ok(!ofA.articles.some((x) => x.guid === 'd'), '꼬꼬무는 따로');
  assert.ok(similarity(list[0].title, list[3].title) < 0.2);
});

test('사진·차트 기사는 본문을 읽지 않는다', () => {
  assert.equal(looksLikeSchedule({ id: 'x', articles: [art('p', '[포토] NCT DREAM 박지성 ‘카리스마 눈빛’')] }), false);
  assert.equal(looksLikeSchedule({ id: 'y', articles: [art('q', 'NCT 드림 정규 6집, 음반·음원 차트 1위')] }), false);
  assert.equal(looksLikeSchedule({ id: 'z', articles: [art('r', "'꼬꼬무' NCT DREAM 제노 출연")] }), true);
});

test('제목 끝 (프로그램명)은 방송 후기라 읽고, 위버스 팬 글 번역본은 건너뛴다', () => {
  assert.equal(looksLikeSchedule({ id: 'h', articles: [art('h', '엔시티 드림 런쥔, 속옷 노출된 줄 알고 화들짝 “죄송해요, 다 봤어요?”(가짜 김효연)')] }), true);
  assert.equal(looksLikeSchedule({ id: 'w', articles: [art('w', 'NCT DREAM社区帖子 - 해찬아 지금 뭐해?!')] }), false);
});

test('빈칸 채우기 검색은 대상 이름이 통째로 있는 기사만 받는다', async () => {
  const { titleHasFocus } = await import('./news.ts');
  assert.equal(titleHasFocus("MMA2026 투표·예매, 멜론 유료 회원에 하루 3표·선예매", 'MMA2026'), true);
  assert.equal(titleHasFocus("'크래시2' 결방 없이 정상 방송", 'ENA 크래시2 : 분노의 도로'), true);
  assert.equal(titleHasFocus("듀스(DEUX), 31년 만의 정규 4집 '프리 리스닝 파티' 성공적 개최", '리스닝 파티 (서울)'), false);
  assert.equal(titleHasFocus('르노, 새 라이브 앨범 발매 기념 파리에서 무료 사인회', '팬사인회'), false);
});
