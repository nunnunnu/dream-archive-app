import assert from 'node:assert/strict';
import { test } from 'node:test';
import { gradeOf, histogram, Judger, judgeOf, maxScoreFor, missSections } from '../../site/src/scripts/game/judge.ts';

const cfg = { perfectMs: 80, goodMs: 150, clearAccuracy: 0.7 };

test('판정 창 경계 80/150ms', () => {
  assert.equal(judgeOf(80, cfg), 'perfect');
  assert.equal(judgeOf(-80, cfg), 'perfect');
  assert.equal(judgeOf(81, cfg), 'good');
  assert.equal(judgeOf(-150, cfg), 'good');
  assert.equal(judgeOf(151, cfg), null);
});

test('탭: 가장 가까운 미처리 큐 하나, 창 밖 허공 탭은 무시(콤보 유지)', () => {
  const j = new Judger([{ t: 1 }, { t: 1.2 }, { t: 3 }], cfg);
  assert.equal(j.tap(1.05)?.index, 0);
  assert.equal(j.tap(1.04), null); // 1.2 까지 160ms (창 밖)
  assert.equal(j.tap(2.0), null);
  assert.equal(j.combo, 1);
  const r = j.tap(1.13)!;
  assert.equal(r.index, 1);
  assert.equal(r.judge, 'perfect');
  assert.equal(r.deltaMs, -70);
});

test('자동 MISS 는 +150ms 지나서, 콤보 리셋', () => {
  const j = new Judger([{ t: 1 }, { t: 2 }], cfg);
  j.tap(1);
  assert.deepEqual(j.advance(2.15), []);
  assert.deepEqual(j.advance(2.151), [1]);
  assert.equal(j.combo, 0);
  assert.equal(j.done, true);
});

test('점수·만점 공식, 등급 컷', () => {
  const j = new Judger([{ t: 1 }, { t: 2 }, { t: 3 }], cfg);
  j.tap(1); j.tap(2); j.tap(3);
  assert.equal(j.score, maxScoreFor(3));
  assert.equal(maxScoreFor(3), 3000 + 60);
  const g = new Judger([{ t: 1 }, { t: 2 }], cfg);
  assert.equal(g.tap(1.1)!.points, 500 + 5);
  assert.equal(gradeOf(0.95), 'SS');
  assert.equal(gradeOf(0.949), 'S');
  assert.equal(gradeOf(0.7), 'B');
  assert.equal(gradeOf(0.59), 'D');
});

test('건너뛴 큐는 분모에서 빠지고 클리어 판정', () => {
  const j = new Judger([{ t: 1 }, { t: 2 }, { t: 3 }, { t: 4 }], cfg);
  j.skip((t) => t < 2.5);
  j.tap(3);
  j.finish();
  const s = j.summary();
  assert.equal(s.total, 2);
  assert.equal(s.skipped, 2);
  assert.equal(s.miss, 1);
  assert.equal(s.accuracy, 0.5);
  assert.equal(s.cleared, false);
  assert.equal(s.maxScore, maxScoreFor(2));
});

test('평균 편차 부호: 빠른 탭은 음수', () => {
  const j = new Judger([{ t: 1 }, { t: 2 }], cfg);
  j.tap(0.95); j.tap(1.97);
  assert.equal(j.summary().avgDeltaMs, -40);
  assert.deepEqual(histogram([-150, 0, 150, 149], 150, 3), [1, 1, 2]);
});

test('놓친 구간: 8초 안끼리 묶고 MISS 많은 순', () => {
  const cues = [{ t: 10, text: 'a' }, { t: 12, text: 'b' }, { t: 30, text: 'c', section: '후렴' }, { t: 31, text: 'd' }, { t: 32, text: 'e' }];
  const j = new Judger(cues, cfg);
  j.tap(12);
  j.finish();
  const g = missSections(cues, j.results, 8, 3);
  assert.equal(g.length, 2);
  assert.equal(g[0].from, 30);
  assert.equal(g[0].miss, 3);
  assert.equal(g[0].label, '후렴');
  assert.equal(g[1].label, 'a');
});
