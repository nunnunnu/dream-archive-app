import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Activity } from './activities.ts';
import type { PublicEvent } from './consolidate.ts';
import type { FeedItem } from './publish.ts';
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

const news = (title: string, url: string, extra: Partial<FeedItem> = {}): FeedItem =>
  ({ type: 'sns', title, url, publishedAt: '2026-11-24T03:00:00.000Z', publisher: '팬 제보 · x.com', members: ['재민'], reported: true, ...extra });
const act = (id: string, name: string, from: string, to: string, eventIds: string[]) => ({ id, name, kind: '예능', keys: [], parts: [], videoKeys: [],
  owner: { scope: '단체', members: [], label: 'NCT DREAM' }, from, to, eventIds }) as unknown as Activity;

test('시리즈 단서: 제보는 설정 목록 시리즈에 붙고, 없는 이름은 새 페이지가 되고, 같은 이름 기사도 따라온다', () => {
  const feed = [
    news('재민 차백도 새 광고', 'https://x.com/a/status/1', { series: { kind: '광고', name: '차백도' } }),
    news('재민 보그 12월호', 'https://x.com/a/status/2', { series: { kind: '화보', name: '보그' } }),
    news('재민, 보그 화보서 깊은 눈빛', 'https://news.example.com/1', { type: 'news', publisher: '어떤일보', reported: undefined }),
    // 이름만 같고 주제가 다른 기사는 붙지 않는다
    news('보그 코리아 독자 설문에 재민 이름', 'https://news.example.com/2', { type: 'news', publisher: '어떤일보', reported: undefined }),
    news('숨긴 제보', 'https://x.com/a/status/3', { series: { kind: '화보', name: '보그' } }),
  ];
  const pages = buildSeries([], [], [], [], feed, [{ url: 'https://x.com/a/status/3', urls: [] } as never]);
  const cha = pages.find((p) => p.id === 'ad-chabaidao')!;
  assert.ok(cha.episodes?.some((e) => e.title === '재민 차백도 새 광고'));
  const vogue = pages.find((p) => p.id === 'pic-보그')!;
  assert.equal(vogue.type, '화보');
  assert.deepEqual(vogue.episodes?.map((e) => e.title).sort(), ['재민 보그 12월호', '재민, 보그 화보서 깊은 눈빛']);
  assert.ok(!pages.some((p) => p.id.startsWith('ad-') && p.id !== 'ad-chabaidao' && p.id !== 'ad-lee'));
});

test('시리즈 단서: 하루짜리 외부 예능은 외부활동 페이지, 1주 넘으면 고정 출연, 같은 이름 제보는 고정 출연에 합친다', () => {
  const events = [
    ev('k1', 'JTBC 아는 형님', [{ type: 'news', url: 'https://news.example.com/k1' }], { kind: '방송', date: '2026-11-21' }),
    ev('t1', 'IDOL’S TABLE', [{ type: 'news', url: 'https://news.example.com/t1' }], { kind: '방송', date: '2026-09-16' }),
    ev('t2', 'IDOL’S TABLE', [{ type: 'news', url: 'https://news.example.com/t2' }], { kind: '방송', date: '2026-10-16' }),
  ];
  const acts = [act('k', '아는 형님', '2026-11-21', '2026-11-21', ['k1']), act('t', 'IDOL’S TABLE', '2026-09-16', '2026-10-16', ['t1', 't2'])];
  const feed = [news('IDOL’S TABLE 3회 예고', 'https://x.com/a/status/9', { series: { kind: '예능', name: 'IDOL’S TABLE' } })];
  const pages = buildSeries([], events, acts, [], feed);
  const knowing = pages.find((p) => p.id === 'x-아는형님')!;
  assert.equal(knowing.type, '외부활동');
  assert.equal(knowing.episodes?.[0].url, 'https://news.example.com/k1');
  const table = pages.find((p) => p.id === 'a-idolstable')!;
  assert.equal(table.type, '고정 출연');
  assert.equal(table.count, 3);
  assert.ok(!pages.some((p) => p.id.startsWith('x-idolstable')));
});

test('시리즈 단서: 설정 목록 시리즈는 단서가 없어도 그대로 10개', () => {
  const ids = buildSeries([], [], [], []).filter((p) => p.type === '외부활동' || p.type === '광고').map((p) => p.id);
  assert.equal(ids.length, 10);
});
