import assert from 'node:assert/strict';
import { test } from 'node:test';
import { activeOffset, checkChart, FANCHANT_DEFAULTS, judgeWindow, songTimeAt, suggestSongId, videoTimeAt, youtubeIdFrom, youtubeStartFrom } from '../../site/src/lib/fanchant.ts';
import { buildFanchantFiles } from './fanchant-publish.ts';

const base = () => ({
  songId: 'test-song', title: '테스트 곡', durationSec: 180, difficulty: 3, author: '@me', verified: false,
  cues: [{ t: 12.3456, text: '런쥔!', member: 'renjun' }, { t: 10, text: 'Hey!' }],
  videos: [{ mode: 'guide', youtubeId: 'https://youtu.be/AAAAAAAAAAA', offset: 0.84 }],
});

test('유튜브 주소에서 ID 꺼내기', () => {
  assert.equal(youtubeIdFrom('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=10'), 'dQw4w9WgXcQ');
  assert.equal(youtubeIdFrom('https://youtu.be/dQw4w9WgXcQ?si=x'), 'dQw4w9WgXcQ');
  assert.equal(youtubeIdFrom('https://www.youtube.com/shorts/dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
  assert.equal(youtubeIdFrom('dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
  assert.equal(youtubeIdFrom('https://example.com/watch?v=dQw4w9WgXcQ'), null);
  assert.equal(youtubeIdFrom('짧음'), null);
});

test('유튜브 링크의 시작 위치', () => {
  assert.equal(youtubeStartFrom('https://youtu.be/dQw4w9WgXcQ?t=40'), 40);
  assert.equal(youtubeStartFrom('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=1m5s'), 65);
  assert.equal(youtubeStartFrom('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42s'), 42);
  assert.equal(youtubeStartFrom('https://www.youtube.com/embed/dQw4w9WgXcQ?start=12'), 12);
  assert.equal(youtubeStartFrom('https://youtu.be/dQw4w9WgXcQ'), null);
  assert.equal(youtubeStartFrom('dQw4w9WgXcQ'), null);
});

test('곡 ID 제안', () => {
  assert.equal(suggestSongId('When I’m With You'), 'when-im-with-you');
  assert.equal(suggestSongId('사랑한단 뜻이야'), '');
});

test('채보 검사: 정리·정렬·반올림, 뮤비 없으면 경고', () => {
  const r = checkChart(base(), { memberSlugs: ['renjun'] });
  assert.deepEqual(r.errors, []);
  assert.equal(r.chart!.cues[0].t, 10);
  assert.equal(r.chart!.cues[1].t, 12.346);
  assert.equal(r.chart!.videos[0].youtubeId, 'AAAAAAAAAAA');
  assert.equal(r.chart!.cover?.youtubeId, 'AAAAAAAAAAA');
  assert.equal(r.chart!.difficultyLabel, '보통');
  assert.ok(r.warnings.some((w) => w.includes('실전')));
});

test('채보 검사: 막는 것', () => {
  assert.ok(checkChart({ ...base(), songId: 'Bad ID' }).errors.length);
  assert.ok(checkChart({ ...base(), songId: 'index' }).errors.length);
  assert.ok(checkChart({ ...base(), videos: [] }).errors.some((e) => e.includes('가이드')));
  assert.ok(checkChart({ ...base(), videos: [{ mode: 'guide', youtubeId: 'AAAAAAAAAAA', offset: 0, segments: [{ from: 5, to: 20, offset: 1 }, { from: 10, to: 30, offset: 2 }] }] }).errors.some((e) => e.includes('겹쳐')));
  // 공개하려면 모든 큐에 문구
  const r = checkChart({ ...base(), verified: true, cues: [{ t: 1, text: '' }] });
  assert.ok(r.errors.some((e) => e.includes('공개')));
});

test('채보 검사: 가까운 큐·모르는 멤버·길게 누르기 겹침은 경고만', () => {
  const r = checkChart({ ...base(), cues: [{ t: 1, text: 'a', member: 'nobody' }, { t: 1.05, text: 'b' }, { t: 3, text: 'c', hold: 2.5 }, { t: 4, text: 'd' }] }, { memberSlugs: ['renjun'] });
  assert.deepEqual(r.errors, []);
  assert.ok(r.warnings.some((w) => w.includes('80ms')));
  assert.ok(r.warnings.some((w) => w.includes('nobody')));
  assert.ok(r.warnings.some((w) => w.includes('홀드')));
  assert.deepEqual([r.chart!.cues[2].type, r.chart!.cues[2].duration], ['hold', 2.5]); // 예전 형식 hold 도 읽음
  assert.equal(r.chart!.cues[3].type, undefined);
  const n = checkChart({ ...base(), cues: [{ t: 1, text: '드~림', type: 'hold', duration: 0.8 }] });
  assert.deepEqual(n.chart!.cues[0], { t: 1, text: '드~림', type: 'hold', duration: 0.8 });
  assert.ok(checkChart({ ...base(), cues: [{ t: 1, text: 'x', type: 'hold' }] }).errors.length);
});

test('노래 시각 ↔ 영상 시각 (구간 오프셋 포함)', () => {
  const v = { offset: 2, segments: [{ from: 87, to: 101.5, offset: 8.4 }] };
  assert.equal(activeOffset(v, 50), 2);
  assert.equal(activeOffset(v, 90), 8.4);
  assert.equal(activeOffset(v, 101.5), 2);
  assert.equal(songTimeAt(v, 12.4), 10.4);
  assert.equal(videoTimeAt(v, 10.4), 12.4);
  assert.ok(Math.abs(videoTimeAt(v, 82) - 90.4) < 1e-9); // 82+8.4 는 구간 안
  assert.equal(videoTimeAt({ offset: 0.84 }, 11.56), 12.4);
});

test('공개 파일: verified 이고 검사 통과한 것만, index 에 설정과 곡 요약', () => {
  const ok = { ...base(), verified: true, updatedAt: '2026-11-22T00:00:00Z', updatedBy: 'a@b.c' };
  const draft = { ...base(), songId: 'draft-song' };
  const broken = { ...base(), songId: 'broken', verified: true, cues: [{ t: 1, text: '' }] };
  const { files, log } = buildFanchantFiles([ok, draft, broken], FANCHANT_DEFAULTS);
  assert.deepEqual(Object.keys(files).sort(), ['index.json', 'test-song.json']);
  const song = JSON.parse(files['test-song.json']);
  assert.equal(song.updatedBy, undefined);
  const index = JSON.parse(files['index.json']);
  assert.equal(index.config.goodMs, 150);
  assert.equal(index.songs[0].noteCount, 2);
  assert.equal(index.songs[0].hasMv, false);
  assert.ok(log.some((l) => l.includes('broken')));
});

test('실전만 판정 창이 넓다', () => {
  assert.deepEqual(judgeWindow(FANCHANT_DEFAULTS, 'step1'), { perfectMs: 80, goodMs: 150, goodReleaseMs: 220 });
  assert.deepEqual(judgeWindow(FANCHANT_DEFAULTS, 'live'), { perfectMs: 100, goodMs: 200, goodReleaseMs: 270 });
});
