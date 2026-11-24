import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Activity } from './activities.ts';
import type { PublicEvent } from './consolidate.ts';
import { buildSeries, sharedSuffixSeries, youtubeAppearances } from './series.ts';

const ev = (id: string, title: string, sources: Partial<PublicEvent['sources'][number]>[], extra: Partial<PublicEvent> = {}) => ({
  id, date: '2026-11-23', time: '20:00', endDate: null, endTime: null, timezone: null, title, step: '공개', kind: '발매', members: [], scope: '단체',
  status: 'confirmed', evidence: '', sources: sources.map((s, i) => ({ id: `${id}-${i}`, type: 'youtube', url: '', title: '', publishedAt: '2026-11-23T11:00:00Z', ...s })), ...extra,
}) as PublicEvent;

test('외부 유튜브 출연: 일정에 들어온 새 채널 출연은 채널별 외부활동 카드가 된다', () => {
  const events = [
    ev('a', '유튜브 안될과학 Unrealscience', [{ type: 'submission', url: 'https://youtu.be/2CvEPsI13N4?si=x', title: '안될과학 Unrealscience: 꿈에서 깼는데 또 꿈이라고?' },
      { url: 'https://www.youtube.com/watch?v=2CvEPsI13N4', title: '꿈에서 깼는데 또 꿈이라고?', publisher: '안될과학 Unrealscience' }]),
    // 제보만 있는 경우는 제보 제목 "채널: 제목"에서 채널을 읽는다
    ev('b', '유튜브 새채널', [{ type: 'submission', url: 'https://youtu.be/AAAAAAAAAAA', title: '새채널: 첫 출연' }], { members: ['지성'] }),
    // 공식 채널 영상, 음악방송 클립(제목에 유튜브·채널 이름 없음)은 출연이 아니다
    ev('c', '유튜브 NCT DREAM 공식 영상', [{ url: 'https://www.youtube.com/watch?v=BBBBBBBBBBB', publisher: 'NCT DREAM' }]),
    ev('d', 'KBS 뮤직뱅크 사전녹화', [{ url: 'https://www.youtube.com/watch?v=CCCCCCCCCCC', publisher: 'THE KEY-POP' }], { kind: '방송' }),
  ];
  const apps = youtubeAppearances(events);
  assert.deepEqual([...apps.values()].map((a) => [a.name, a.records.map((r) => r.title)]), [
    ['안될과학 Unrealscience', ['꿈에서 깼는데 또 꿈이라고?']],
    ['새채널', ['첫 출연']],
  ]);
  const pages = buildSeries([], events, [], []).filter((p) => p.type === '외부활동' && p.id.startsWith('x-') && /안될과학|새채널/.test(p.name));
  assert.equal(pages.length, 2);
  assert.equal(pages[0].episodes?.[0].thumb, 'https://i.ytimg.com/vi/2CvEPsI13N4/mqdefault.jpg');
  assert.deepEqual(pages[1].members, ['지성']);
});

test('외부 유튜브 출연: 설정 목록에 있는 채널은 그 카드에 합치고, 고정 출연 회차는 빼고, 같은 영상은 한 번만', () => {
  const events = [
    // series-catalog.json 의 나나기획 · 쩜오야(채널십오야) 기록과 같은 영상
    ev('n', '유튜브 채널십오야', [{ url: 'https://www.youtube.com/watch?v=mCeUNjUlGhQ', title: 'To. 지나가는 시즈니들아!', publisher: '채널십오야' }]),
    ev('l', '유튜브 슈퍼댄서 LEE리정', [{ type: 'submission', url: 'https://youtu.be/ZZZZZZZZZZZ', title: '슈퍼댄서 LEE리정: 두 번째 놀러 올래?' }]),
    ev('f', '유튜브 집대성 빈집대성', [{ url: 'https://www.youtube.com/watch?v=DDDDDDDDDDD', publisher: '집대성' }]),
  ];
  const fixed = { id: 'act', name: '빈집대성', kind: '예능', keys: [], parts: [], videoKeys: [], owner: { scope: '단체', members: [], label: 'NCT DREAM' },
    from: '2026-10-23', to: '2026-11-20', eventIds: ['f'] } as unknown as Activity;
  const pages = buildSeries([], events, [fixed], []);
  const nana = pages.find((p) => p.id === 'x-nana')!;
  assert.equal(nana.episodes?.filter((e) => e.url?.includes('mCeUNjUlGhQ')).length, 1);
  assert.equal(nana.episodes?.find((e) => e.url?.includes('mCeUNjUlGhQ'))?.title, '쩜오야 · 런쥔·제노 출연');
  assert.ok(pages.find((p) => p.id === 'x-leejung')!.episodes?.some((e) => e.title === '두 번째 놀러 올래?'));
  assert.ok(!pages.some((p) => p.type === '외부활동' && /채널십오야|리정|집대성/.test(p.name) && !['x-nana', 'x-leejung'].includes(p.id)));
});

test('회차 번호 없는 자체 콘텐츠: 끝 칸 이름이 같은 영상이 2개면 시리즈, 하나거나 비하인드 모음이면 아님', () => {
  const v = (videoId: string, title: string) => ({ videoId, title });
  const got = sharedSuffixSeries([
    v('1', '히어로계 3대장 | BOOGIE WOOGIE MAN🦸'),
    v('2', '부기우기맨 두 번째 출동 | BOOGIE WOOGIE MAN'),
    v('3', '기다렸어 어서와 | 825-9번지 Home Sweet DREAM🏠'),
    v('4', '함께 가봅시다 | SMTOWN LIVE 2025 in TOKYO Behind'),
    v('5', '시즈니 놀아봅시다 | SMTOWN LIVE 2025 in TOKYO Behind'),
    v('6', "HAECHAN 해찬 'Grey Rain' | TASTE Playlist"),
    v('7', "HAECHAN 해찬 'Talented' | TASTE Playlist"),
    v('8', "[Un Cut] Take #1 | 'Golden Age' MV Behind the Scene"),
    v('9', "[Un Cut] Take #2 | 'Golden Age' MV Behind the Scene"),
  ]);
  assert.deepEqual([...got.entries()], [['1', 'BOOGIE WOOGIE MAN'], ['2', 'BOOGIE WOOGIE MAN']]);
});
