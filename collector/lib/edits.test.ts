import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyEraPage, applyEvents, applyFeed, applySeriesList, applySeriesPage, applyToFile, eventTarget, normalizeEvent, type Edit } from './edits.ts';

const at = '2026-11-24T00:00:00Z';
const ev = (id: string, date: string, title: string, step = '공개', time: string | null = '20:00') => ({ id, date, time, title, step, kind: '발매', members: [] as string[], sources: [] as { url: string }[] });
const edit = (e: Partial<Edit> & Pick<Edit, 'kind' | 'op'>): Edit => ({ id: Math.random().toString(36).slice(2), target: {}, at, ...e });

test('일정: 고치기·숨기기·만들기, 날짜를 옮기면 옮긴 달 파일에, 두 번 적용해도 같다', () => {
  const a = ev('a', '2026-11-23', '유튜브 안될과학');
  const b = ev('b', '2026-11-24', 'Lele\'s Show 2', '판매');
  const c = ev('c', '2026-11-25', '원데이 이벤트', '행사');
  const moved = normalizeEvent({ date: '2026-12-01', title: a.title, step: a.step, kind: '발매', members: ['지성'] }, a, 7, 'e1', at);
  const made = normalizeEvent({ date: '2026-11-26', time: '18:00', title: '새 일정', step: '공개', kind: '방송', members: [], url: 'https://youtu.be/AAAAAAAAAAA' }, undefined, 7, 'e3', at);
  const edits = [
    edit({ kind: 'event', op: 'patch', target: eventTarget(a), data: moved }),
    edit({ kind: 'event', op: 'hide', target: eventTarget(b) }),
    edit({ kind: 'event', op: 'add', data: made }),
  ];
  const nov = applyEvents([a, b, c], edits, '2026-11');
  assert.deepEqual(nov.map((e) => e.id), ['c', 'm-e3']);
  assert.deepEqual(applyEvents([] as Record<string, any>[] as typeof nov, edits, '2026-12').map((e) => [e.id, e.date, (e as Record<string, unknown>).scope]), [['a', '2026-12-01', '멤버']]);
  const once = applyEvents([a, b, c], edits);
  assert.deepEqual(applyEvents(once, edits), once);
  // 수집기가 id를 새로 매겨도 날짜·제목·단계로 원래 일정을 찾는다
  assert.deepEqual(applyEvents([{ ...a, id: 'a2' }], edits).map((e) => e.id), ['m-e3', 'a']);
  assert.equal(made.sources[0].url, 'https://youtu.be/AAAAAAAAAAA');
  assert.equal(made.category, '공식');
});

test('소식: 고친 것은 원래 주소 자리를 대신하고, 숨긴 소식은 묶인 기사 주소로도 빠진다', () => {
  const items = [
    { type: 'youtube', title: '크래시2 소개', url: 'https://www.youtube.com/watch?v=FeO1FLlWUXw', publishedAt: '2026-11-23T22:30:00Z', members: ['지성'] },
    { type: 'news', title: '묶음 기사', url: 'https://a.com/1', publishedAt: '2026-11-22T00:00:00Z', members: [], articles: [{ url: 'https://b.com/2?utm_source=x' }] },
    { type: 'news', title: '그대로', url: 'https://c.com/3', publishedAt: '2026-11-21T00:00:00Z', members: [] },
  ];
  const edits = [
    edit({ kind: 'feed', op: 'hide', target: { url: 'https://youtu.be/FeO1FLlWUXw'.replace('youtu.be/', 'www.youtube.com/watch?v=') } }),
    edit({ kind: 'feed', op: 'hide', target: { url: 'https://b.com/2' } }),
    edit({ kind: 'feed', op: 'patch', target: { url: 'https://c.com/3' }, data: { ...items[2], title: '고친 제목' } }),
    edit({ kind: 'feed', op: 'add', data: { type: 'sns', title: '새 소식', url: 'https://x.com/p/1', publishedAt: '2026-11-24T00:00:00Z', members: [] } }),
  ];
  const once = applyFeed(items, edits);
  assert.deepEqual(once.map((f) => f.title), ['새 소식', '고친 제목']);
  assert.deepEqual(applyFeed(once, edits), once);
});

test('시리즈: 영상 빼기·넣기·이름 바꾸기, 손으로 만든 시리즈, 숨기기', () => {
  const page = {
    id: 's-x', name: '옛 이름', type: '자체 콘텐츠 시리즈', count: 2, from: '2026-01-01', to: '2026-02-01', members: [],
    seasons: [{ name: '시즌1', videos: [
      { id: 'AAAAAAAAAAA', url: 'https://www.youtube.com/watch?v=AAAAAAAAAAA', title: '1화', thumb: '', date: '2026-01-01', ep: 1, members: [] },
      { id: 'BBBBBBBBBBB', url: 'https://www.youtube.com/watch?v=BBBBBBBBBBB', title: '2화', thumb: '', date: '2026-02-01', ep: 2, members: [] },
    ] }],
  };
  const added = { id: 'CCCCCCCCCCC', url: 'https://www.youtube.com/watch?v=CCCCCCCCCCC', title: '3화', thumb: '', date: '2026-03-01', members: [] };
  const edits = [
    edit({ kind: 'series', op: 'patch', target: { id: 's-x' }, data: { name: '새 이름', removeVideos: ['BBBBBBBBBBB'], addVideos: [added] } }),
    edit({ kind: 'series', op: 'add', target: { id: 'm-1' }, data: { id: 'm-1', name: '안될과학', type: '외부활동', addVideos: [{ ...added, id: '2CvEPsI13N4', url: 'https://www.youtube.com/watch?v=2CvEPsI13N4' }] } }),
    edit({ kind: 'series', op: 'hide', target: { id: 's-hide' } }),
  ];
  const out = applySeriesPage(page, 's-x', edits)!;
  assert.equal(out.name, '새 이름');
  assert.deepEqual(out.seasons.map((s) => [s.name, s.videos.map((v) => v.title)]), [['시즌1', ['1화']], ['추가한 영상', ['3화']]]);
  assert.equal(out.count, 2);
  assert.deepEqual(applySeriesPage(out, 's-x', edits), out);
  const made = applySeriesPage(null, 'm-1', edits)!;
  assert.equal(made.episodes?.length, 1);
  assert.equal(applySeriesPage({ ...page, id: 's-hide' }, 's-hide', edits), null);
  const list = applySeriesList([{ ...page, id: 's-hide' }, page], edits);
  assert.deepEqual(list.map((s) => [s.id, s.name]), [['s-x', '새 이름'], ['m-1', '안될과학']]);
  assert.equal(applyToFile('series/m-1.json', null, edits)?.name, '안될과학');
});

test('아카이브: 제목·기간 고치기, 엉뚱한 영상 빼기, 영상 넣기', () => {
  const era = {
    id: '2026-크래시2', title: '크래시2', from: '2026-11-16', to: '2026-12-22', cover: { from: '2026-11-16', to: '2026-12-22', text: '' },
    counts: { official: 0, stages: 0, fancams: 0, own: 0, shorts: 0, outside: 0, events: 3 },
    official: [], own: [], stages: [], fancams: [], shorts: [], outside: [], news: [], ownGroups: [],
    related: [{ id: 'FeO1FLlWUXw', title: '크래시2 소개', url: 'https://www.youtube.com/watch?v=FeO1FLlWUXw', thumb: '', date: '2026-11-23', channel: 'Midnight Cinema Trailers', members: ['지성'], group: '예고' }],
  };
  const edits = [edit({ kind: 'era', op: 'patch', target: { id: era.id }, data: {
    title: '크래시2: 분노의 도로', to: '2026-12-30', removeVideos: ['FeO1FLlWUXw'],
    addVideos: [{ id: 'DDDDDDDDDDD', url: 'https://www.youtube.com/watch?v=DDDDDDDDDDD', title: '공식 예고', thumb: '', date: '2026-11-10', members: ['지성'], to: 'official' }],
  } })];
  const out = applyEraPage(era, edits)!;
  assert.equal(out.title, '크래시2: 분노의 도로');
  assert.deepEqual([out.to, out.cover.to], ['2026-12-30', '2026-12-30']);
  assert.deepEqual(out.related, []);
  assert.deepEqual(out.official.map((v: { title: string }) => v.title), ['공식 예고']);
  assert.equal(out.counts.official, 1);
  assert.deepEqual(applyEraPage(out, edits), out);
});
