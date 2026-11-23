/**
 * 시리즈 페이지 데이터: 컴백·투어와 상관없이 이어지는 것 모아보기.
 *  1) 자체 콘텐츠 시리즈: 공식 채널 영상 제목의 "OO EP.n" → 같은 앞 단어(7llin' …)는 시즌으로 묶고,
 *     이름이 제각각인 것은 config/tags.json seriesGroups 로 묶는다 (여행 자컨)
 *  2) 종류별 모아보기: MV·자켓 비하인드, Dance Practice, Recording Behind, Live Clip & Cover, 응원법
 *  3) 고정 출연: 여러 회 이어지는 외부 예능 (활동 묶기에서 '예능'으로 나온 것)
 *  4) 해마다 반복되는 활동: 생일, 시상식, 개인·유닛 활동 (아카이브 활동을 다시 묶음)
 */
import { originalAirDate, videoMembers } from './youtube.ts';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Activity } from './activities.ts';
import type { PublicEvent } from './consolidate.ts';
import type { EraPage } from './eras.ts';
import { GROUP } from './group.ts';
import { isDreamRelated } from './news.ts';
import { ROOT } from './store.ts';
import { seriesName } from './tags.ts';
import type { Video } from './youtube.ts';

export interface SeriesVideo { id: string; title: string; url: string; thumb: string; date: string; ep: number | null; members: string[] }
export interface SeriesPage {
  id: string;
  type: '자체 콘텐츠 시리즈' | '종류별 모아보기' | '고정 출연' | '반복 활동';
  name: string;
  count: number;
  from: string;
  to: string;
  thumb?: string;
  members: string[];
  seasons: { name: string; videos: SeriesVideo[] }[];
  episodes?: { date: string; time: string | null; title: string; step: string; members: string[]; url?: string; thumb?: string }[];
  activities?: { id: string; title: string; kind: string; owner: string; from: string; to: string; cover: EraPage['cover']; thumb?: string }[];
}

const CONFIG: { seriesGroups?: { id: string; name: string; match: string[] }[] } = JSON.parse(readFileSync(join(ROOT, 'config', 'tags.json'), 'utf8'));
const OWN = new Set(GROUP.youtube.channels.filter((c) => !c.guest).map((c) => c.name));
const sq = (t: string) => t.normalize('NFKC').replace(/[^\p{L}\p{N}]+/gu, '').toLowerCase();
const slug = (t: string) => sq(t).replace(/[^a-z0-9가-힣]/g, '').slice(0, 30) || 'series';
const kst = (iso: string) => new Date(new Date(iso).getTime() + 9 * 3600 * 1000).toISOString().slice(0, 10);
const epOf = (t: string) => Number(t.match(/\bEP\.?\s*(\d+)|#\s*(\d+)\b|page\s*#?\s*(\d+)/i)?.slice(1).find(Boolean) ?? NaN) || null;
const toVid = (v: Video): SeriesVideo => ({
  id: v.videoId, title: v.title, url: v.url, thumb: `https://i.ytimg.com/vi/${v.videoId}/mqdefault.jpg`, date: originalAirDate(v) ?? kst(v.publishedAt), ep: epOf(v.title), members: videoMembers(v),
});
const sortVids = (list: SeriesVideo[]) => list.sort((a, b) => a.date.localeCompare(b.date) || (a.ep ?? 0) - (b.ep ?? 0));
const range = (dates: string[]) => { const s = [...dates].sort(); return { from: s[0], to: s.at(-1)! }; };

const COLLECTIONS: [string, RegExp][] = [
  ['MV·자켓 비하인드', /behind the scenes|비하인드|making film|jacket/i],
  ['Dance Practice', /dance\s*practice/i],
  ['Recording Behind', /recording\s*behind|recording\s*diary|녹음\s*비하인드/i],
  // 커버: "Cover | RENJUN - …", "'Soda Pop' Cover Stage", "YOUTH Cover Behind", "커버" (album cover·Undercover 는 아님)
  // 커버 비하인드는 커버가 아니라 비하인드 (MV·자켓 비하인드 쪽)
  ['Cover', /^(?!.*album\s*cover)(?!.*cover\s*behind)(?:.*(?:^|[|｜]\s*)cover\s*[|｜:]|.*[)'’"]\s*cover\b|.*\bcover\s*(?:stage|ver)|.*커버)/i],
  ['Live Clip', /live\s*clip/i],
  ['응원법', /응원법|cheering\s*guide/i],
];

export function buildSeries(videos: Video[], events: PublicEvent[], acts: Activity[], eras: EraPage[]): SeriesPage[] {
  // 공식 채널 영상은 수집할 때 이미 드림 관련(제목·설명 해시태그)만 받았다 → 제목에 이름이 없어도(천지의 이것저것 등) 시리즈에 쓴다
  const own = videos.filter((v) => OWN.has(v.channel) && (v.channel === GROUP.name || isDreamRelated(`${v.title}\n${v.description ?? ''}`)) && !/react|리액션/i.test(v.title));
  const pages: SeriesPage[] = [];

  // 1) 자체 콘텐츠 시리즈
  const groups = CONFIG.seriesGroups ?? [];
  const byFamily = new Map<string, { name: string; seasons: Map<string, Video[]> }>();
  for (const v of own) {
    // 설정 묶음은 제목 전체에서 찾는다 (회차 표시가 없는 "[Dream VS Dream] …"도)
    const cfg = groups.find((g) => g.match.some((m) => sq(v.title).includes(sq(m))));
    const s = seriesName(v.title) ?? (cfg ? cfg.name : null);
    if (!s || (!cfg && /NCT\s*DREAM|엔시티/i.test(s))) continue;
    // 시즌 표시를 뗀 이름이 같으면 한 시리즈의 시즌 (천지의 이것저것 / 시즌2 / 시즌3)
    const base = s.replace(/\s*(시즌|season)\s*\d+|\s+S\d+\b/gi, '').trim();
    // 앞 단어가 같은 시즌 (7llin’ in the DREAM, 7llin’ in our Youth …) → "7llin'" 가족
    const root = sq(base.split(/\s+/)[0]);
    //   첫 단어가 연도·숫자("2026 NCT JNJM …" / "2026 RENJUN&CHENLE …")면 다른 시리즈라서 쓰지 않는다
    const famKey = cfg ? `cfg:${cfg.id}` : root.length >= 4 && !/^\d+$/.test(root) ? `root:${root}` : `name:${sq(base)}`;
    const fam = byFamily.get(famKey) ?? { name: cfg?.name ?? base, seasons: new Map() };
    fam.seasons.set(s, [...(fam.seasons.get(s) ?? []), v]);
    byFamily.set(famKey, fam);
  }
  // 이름 하나가 다른 이름의 앞부분이면 같은 시리즈 ("… To The World" ⊂ "… To The World in OSAKA")
  const nameKeys = [...byFamily.keys()].filter((k) => k.startsWith('name:')).sort((a, b) => a.length - b.length);
  for (const long of nameKeys) {
    const short = nameKeys.find((k) => k !== long && k.length >= 5 + 10 && long.startsWith(k) && byFamily.has(k));
    if (!short || !byFamily.has(long)) continue;
    const into = byFamily.get(short)!;
    for (const [n, vs] of byFamily.get(long)!.seasons) into.seasons.set(n, [...(into.seasons.get(n) ?? []), ...vs]);
    byFamily.delete(long);
  }
  for (const [key, fam] of byFamily) {
    const all = [...fam.seasons.values()].flat();
    if (all.length < 3) continue;
    // 가족 이름: 시즌이 여럿이면 가장 영상이 많은 시즌 이름의 앞 단어 기준, 설정 묶음은 설정 이름
    const seasons = [...fam.seasons.entries()].map(([name, vs]) => ({ name, videos: sortVids(vs.map(toVid)) })).sort((a, b) => a.videos[0].date.localeCompare(b.videos[0].date));
    const name = key.startsWith('cfg:') ? fam.name : seasons.length > 1 ? seasons.slice().sort((a, b) => b.videos.length - a.videos.length)[0].name : fam.name;
    const r = range(all.map((v) => kst(v.publishedAt)));
    const latest = all.slice().sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))[0];
    pages.push({ id: `s-${slug(name)}`, type: '자체 콘텐츠 시리즈', name, count: all.length, ...r, thumb: `https://i.ytimg.com/vi/${latest.videoId}/mqdefault.jpg`, members: [], seasons });
  }

  // 2) 종류별 모아보기 (연도별로 나눠 보여 준다)
  for (const [name, re] of COLLECTIONS) {
    const list = own.filter((v) => re.test(v.title));
    if (list.length < 3) continue;
    const byYear = new Map<string, Video[]>();
    const yearOf = (v: Video) => (originalAirDate(v) ?? kst(v.publishedAt)).slice(0, 4);
    for (const v of list) byYear.set(yearOf(v), [...(byYear.get(yearOf(v)) ?? []), v]);
    const latest = list.slice().sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))[0];
    pages.push({
      id: `c-${slug(name)}`, type: '종류별 모아보기', name, count: list.length, ...range(list.map((v) => kst(v.publishedAt))),
      thumb: `https://i.ytimg.com/vi/${latest.videoId}/mqdefault.jpg`, members: [],
      seasons: [...byYear.entries()].sort((a, b) => b[0].localeCompare(a[0])).map(([y, vs]) => ({ name: `${y}년`, videos: sortVids(vs.map(toVid)).reverse() })),
    });
  }

  // 3) 고정 출연: 일주일 넘게 이어진 외부 예능
  const byId = new Map(events.map((e) => [e.id, e]));
  // (공식 채널 자체 콘텐츠는 외부 출연이 아니라서 뺀다)
  const ownOnly = (a: Activity) => a.eventIds.every((id) => (byId.get(id)?.sources ?? []).every((src) => src.type === 'youtube' && OWN.has(src.publisher ?? '')));
  for (const a of acts.filter((x) => x.kind === '예능' && Date.parse(x.to) - Date.parse(x.from) > 7 * 864e5 && !ownOnly(x))) {
    const eps = a.eventIds.map((id) => byId.get(id)!).filter(Boolean).sort((x, y) => x.date.localeCompare(y.date)).map((e) => {
      const yt = e.sources.find((s) => s.type === 'youtube' || /youtu/.test(s.url));
      const id = yt?.url.match(/(?:v=|youtu\.be\/|shorts\/|live\/)([\w-]{11})/)?.[1];
      return { date: e.date, time: e.time, title: e.title.replace(/^유튜브\s+/, ''), step: e.step, members: e.members, url: yt?.url ?? e.sources[0]?.url, thumb: id ? `https://i.ytimg.com/vi/${id}/mqdefault.jpg` : undefined };
    });
    pages.push({ id: `a-${slug(a.name)}`, type: '고정 출연', name: a.name, count: eps.length, from: a.from, to: a.to, thumb: eps.find((x) => x.thumb)?.thumb, members: a.owner.members, seasons: [], episodes: eps });
  }

  // 4) 해마다 반복되는 활동
  const card = (e: EraPage) => ({ id: e.id, title: e.title, kind: e.kind, owner: e.owner.label, from: e.from, to: e.to, cover: e.cover, thumb: e.thumb });
  const recurring: [string, (e: EraPage) => boolean][] = [
    ['생일', (e) => /b-?day|생일|생파|happy\s+\S+\s+day|lele/i.test(`${e.title} ${e.keys.join(' ')}`)],
    ['시상식', (e) => e.kind === '시상식'],
    ['개인 활동', (e) => e.owner.scope === '멤버'],
    ['유닛 활동', (e) => e.owner.scope === '유닛'],
  ];
  for (const [name, pred] of recurring) {
    const list = eras.filter(pred).sort((a, b) => b.from.localeCompare(a.from));
    if (!list.length) continue;
    pages.push({
      id: `r-${slug(name)}`, type: '반복 활동', name, count: list.length, ...range(list.flatMap((e) => [e.from, e.to])), thumb: list.find((e) => e.thumb)?.thumb,
      members: [...new Set(list.flatMap((e) => e.owner.members))], seasons: [], activities: list.map(card),
    });
  }
  return pages;
}
