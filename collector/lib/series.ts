/**
 * 시리즈 페이지 데이터: 컴백·투어와 상관없이 이어지는 것 모아보기.
 *  1) 자체 콘텐츠 시리즈: 공식 채널 영상 제목의 "OO EP.n" → 같은 앞 단어(7llin' …)는 시즌으로 묶고,
 *     제목 표기가 제각각인 경우 config/tags.json seriesGroups 로 같은 프로그램끼리 묶는다.
 *  2) 종류별 모아보기: MV·자켓 비하인드, Dance Practice, Recording Behind, Live Clip & Cover, 응원법
 *  3) 고정 출연: 여러 회 이어지는 외부 예능 (활동 묶기에서 '예능'으로 나온 것)
 *  4) 해마다 반복되는 활동: 생일, 시상식, 개인·유닛 활동 (아카이브 활동을 다시 묶음)
 */
import { originalAirDate, videoMembers } from './youtube.ts';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Activity } from './activities.ts';
import type { PublicEvent } from './consolidate.ts';
import { SHOWCASE_GROUPS, videoKind, type EraPage, type VideoKind } from './eras.ts';
import { GROUP } from './group.ts';
import { mentionedMembers } from './members.ts';
import { isDreamRelated } from './news.ts';
import { normUrl, type NewsHide } from './newsHide.ts';
import type { FeedItem } from './publish.ts';
import { ROOT } from './store.ts';
import { seriesName } from './tags.ts';
import type { Video } from './youtube.ts';

export interface SeriesVideo { id: string; title: string; url: string; thumb: string; date: string; ep: number | null; members: string[] }
interface SeriesEpisode { date: string; time: string | null; title: string; step: string; members: string[]; url?: string; thumb?: string }
export interface SeriesPage {
  id: string;
  type: '자체 콘텐츠 시리즈' | 'NCT 단체' | '종류별 모아보기' | '고정 출연' | '반복 활동' | '외부활동' | '광고' | '라디오';
  name: string;
  count: number;
  from: string;
  to: string;
  thumb?: string;
  members: string[];
  seasons: { name: string; videos: SeriesVideo[] }[];
  episodes?: SeriesEpisode[];
  activities?: { id: string; title: string; kind: string; owner: string; from: string; to: string; cover: EraPage['cover']; thumb?: string }[];
}

interface SeriesGroup { id: string; name: string; match: string[]; singleSeason?: boolean; channels?: string[]; videoIds?: string[] }
const CONFIG: { seriesGroups?: SeriesGroup[] } = JSON.parse(readFileSync(join(ROOT, 'config', 'tags.json'), 'utf8'));
// 공식 업로드로 확인한 영상. 제목에 'Cover'가 없거나 제작사 채널이 수집 목록에 없어도 모아보기에 연결한다.
const VERIFIED = JSON.parse(readFileSync(join(ROOT, 'config', 'verified-series-videos.json'), 'utf8')) as {
  covers: string[];
};
const MEMBER_RECORDS = JSON.parse(readFileSync(join(ROOT, 'config', 'member-records.json'), 'utf8')) as
  { id: string; name: string; type?: '라디오'; records: Omit<SeriesEpisode, 'time'>[] }[];
const CATALOG = JSON.parse(readFileSync(join(ROOT, 'config', 'series-catalog.json'), 'utf8')) as {
  id: string; name: string; type: '외부활동' | '광고'; publishers: string[]; match?: string[];
  records: (Pick<SeriesEpisode, 'date' | 'title' | 'members'> & { url: string })[];
}[];
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
const youtubeId = (url: string) => url.match(/^https?:\/\/(?:www\.|m\.)?(?:youtube\.com\/(?:watch\?v=|shorts\/|live\/)|youtu\.be\/)([\w-]{11})(?=$|[?&#/])/i)?.[1];
const sourceKey = (url: string) => youtubeId(url) ?? normUrl(url);
const TRACK_VIDEO_RE = /\btrack\s*video\b|트랙\s*비디오/i;
const PROMO_VIDEO_RE = /\b(?:trailer|teaser)\b|트레일러|티저/i;
const NCT_PROJECTS: [string, RegExp][] = [
  ['THE NCT SHOW', /\bTHE NCT SHOW\b/i],
  ['NCT NATION', /\bNCT NATION\b/i],
  ['NCT WORLD 2.0', /\bNCT WORLD 2\.0\b/i],
  ['NCT 2018', /\bNCT\s*2018\b/i],
  ['NCT 2020', /\bNCT\s*2020\b/i],
  ['NCT 2021', /\bNCT\s*2021\b/i],
  ['NCT 2023', /\bNCT\s*2023\b/i],
  ['NCT 24hr RELAY CAM', /\bNCT\s*24\s*hr\s*RELAY\s*CAM\b/i],
  ['NCT 중국어 특급 비책', /NCT\s*중국어\s*특급\s*비책/i],
  ['NCT in CHILE', /\bNCT\s+in\s+CHILE\b/i],
  ['어색하지만 괜찮아', /어색하지만\s*괜찮아|\bAWSAZ\b/i],
  ['QUESTION BUCKET', /\bQUESTION BUCKET\b/i],
];
const nctProjectOf = (v: Video) => NCT_PROJECTS.find(([, re]) => re.test(v.title))?.[0];

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
const CHANNEL_COLLECTIONS: { id: string; name: string; kinds: VideoKind[] }[] = [
  { id: 'channel-performance', name: '퍼포먼스 영상', kinds: ['퍼포먼스'] },
  { id: 'channel-behind', name: '비하인드·리액션', kinds: ['비하인드'] },
  { id: 'channel-live', name: '라이브', kinds: ['라이브'] },
  { id: 'channel-other', name: '기타 채널 영상', kinds: ['기타', '자컨 시리즈', '응원법'] },
];

export function buildSeries(videos: Video[], events: PublicEvent[], acts: Activity[], eras: EraPage[], feed: FeedItem[] = [], hidden: NewsHide[] = [], unavailableIds: ReadonlySet<string> = new Set()): SeriesPage[] {
  const groups = (CONFIG.seriesGroups ?? []).map((group) => ({ ...group, match: group.match.map(sq) }));
  const configuredByVideo = new Map<string, SeriesGroup>();
  // 공식 채널 영상은 수집할 때 이미 드림 관련(제목·설명 해시태그)만 받았다 → 제목에 이름이 없어도(천지의 이것저것 등) 시리즈에 쓴다
  const own = videos.filter((v) => {
    if (!OWN.has(v.channel)) return false;
    if (nctProjectOf(v) === '어색하지만 괜찮아' && !mentionedMembers(v.title).members.length) return false;
    const title = sq(v.title);
    const group = groups.find((g) => g.videoIds?.includes(v.videoId) ||
      ((!g.channels || g.channels.includes(v.channel)) && g.match.some((key) => title.includes(key))));
    if (group) configuredByVideo.set(v.videoId, group);
    return Boolean(group) || v.channel === GROUP.name ||
      (isDreamRelated(`${v.title}\n${v.description ?? ''}`) && !/react|리액션/i.test(v.title));
  });
  const musicVideos = new Map(own.filter((v) => {
    const kind = videoKind(v);
    return kind === 'MV·티저' || (kind !== '비하인드' && PROMO_VIDEO_RE.test(v.title) && !/촬영\s*현장/.test(v.title));
  }).map((v) => [v.videoId, v]));
  const trackVideos = new Map(own.filter((v) => TRACK_VIDEO_RE.test(v.title) && videoKind(v) === '퍼포먼스')
    .map((v) => [v.videoId, v]));
  const shortVideos = new Map(own.filter((v) => v.channel === GROUP.name || configuredByVideo.has(v.videoId))
    .filter((v) => !trackVideos.has(v.videoId) && !musicVideos.has(v.videoId)
      && (/#(?:shorts?\b|쇼츠)/i.test(v.title) || ['쇼츠', '챌린지'].includes(videoKind(v))))
    .map((v) => [v.videoId, v]));
  const seriesVideos = own.filter((v) => !trackVideos.has(v.videoId) && !musicVideos.has(v.videoId) && !shortVideos.has(v.videoId));
  const pages: SeriesPage[] = [];
  const videoById = new Map(videos.map((v) => [v.videoId, v]));

  // 1) 자체 콘텐츠 시리즈
  const byFamily = new Map<string, { name: string; seasons: Map<string, Video[]> }>();
  for (const v of seriesVideos) {
    // 설정 묶음은 제목 전체에서 찾는다 (회차 표시가 없는 "[Dream VS Dream] …"도)
    const cfg = configuredByVideo.get(v.videoId);
    const s = cfg?.singleSeason ? cfg.name : seriesName(v.title) ?? cfg?.name;
    if (!s || (!cfg && /NCT\s*DREAM|엔시티/i.test(s))) continue;
    if (!cfg && /^(?:\[.+?\]\s*)?TODAY[!:]/i.test(s) && /#shorts?\b/i.test(v.title)) continue;
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
    // 가족 이름: 시즌이 여럿이면 가장 영상이 많은 시즌 이름의 앞 단어 기준, 설정 묶음은 설정 이름
    const seasons = [...fam.seasons.entries()].map(([name, vs]) => ({ name, videos: sortVids(vs.map(toVid)) })).sort((a, b) => a.videos[0].date.localeCompare(b.videos[0].date));
    const name = key.startsWith('cfg:') ? fam.name : seasons.length > 1 ? seasons.slice().sort((a, b) => b.videos.length - a.videos.length)[0].name : fam.name;
    const r = range(all.map((v) => kst(v.publishedAt)));
    const latest = all.slice().sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))[0];
    const type = all.some(nctProjectOf) ? 'NCT 단체' : '자체 콘텐츠 시리즈';
    pages.push({ id: `s-${slug(name)}`, type, name, count: all.length, ...r, thumb: `https://i.ytimg.com/vi/${latest.videoId}/mqdefault.jpg`, members: [], seasons });
  }

  // 2) 종류별 모아보기 (연도별로 나눠 보여 준다)
  const addVideoCollection = (name: string, videos: SeriesVideo[], members: string[] = [], id = `c-${slug(name)}`, type: SeriesPage['type'] = '종류별 모아보기') => {
    if (!videos.length) return;
    const byYear = new Map<string, SeriesVideo[]>();
    for (const v of videos) {
      const year = v.date.slice(0, 4);
      byYear.set(year, [...(byYear.get(year) ?? []), v]);
    }
    const sorted = sortVids(videos).reverse();
    pages.push({
      id, type, name, count: sorted.length,
      ...range(sorted.map((v) => v.date)), thumb: sorted[0].thumb, members,
      seasons: [...byYear.entries()].sort(([a], [b]) => b.localeCompare(a))
        .map(([year, group]) => ({ name: `${year}년`, videos: sortVids(group).reverse() })),
    });
  };
  for (const [name, re] of COLLECTIONS) {
    const list = new Map(seriesVideos.filter((v) => re.test(v.title)).map((v) => [v.videoId, v]));
    if (name === 'Cover') for (const id of VERIFIED.covers) {
      const v = videoById.get(id);
      if (v) list.set(id, v);
    }
    if (list.size < 3) continue;
    const clips = [...list.values()].map(toVid);
    addVideoCollection(name, clips, name === 'Cover' ? [...new Set(clips.flatMap((clip) => clip.members))] : []);
  }
  addVideoCollection('트랙 비디오', [...trackVideos.values()].map(toVid), [], 'channel-track-video');
  addVideoCollection('뮤직비디오·티저', [...musicVideos.values()].map(toVid), [], 'channel-music');
  addVideoCollection('쇼츠·챌린지', [...shortVideos.values()].map(toVid), [], 'channel-shorts');

  for (const era of eras) {
    const seasons = SHOWCASE_GROUPS.map(([group, name]) => ({
      name, videos: era.own.filter((v) => v.group === group).map((v) => ({
        id: v.id, title: v.title, url: v.url, thumb: v.thumb, date: v.date, members: v.members, ep: null,
      })),
    })).filter((season) => season.videos.length);
    const clips = seasons.flatMap((season) => season.videos);
    if (!clips.length) continue;
    pages.push({
      id: `showcase-${era.id}`, name: `${era.title} 컴백 쇼케이스`, type: '자체 콘텐츠 시리즈', count: clips.length,
      ...range(clips.map((v) => v.date)), thumb: clips[0].thumb, members: [], seasons,
    });
  }

  // 고유 시리즈나 종류별 모아보기에 들어가지 않은 공식 채널 영상도 유형과 연도별로 볼 수 있다.
  const named = new Set(pages.filter((page) => page.id.startsWith('s-')).flatMap((page) => page.seasons.flatMap((season) => season.videos.map((v) => v.id))));
  for (const [name] of NCT_PROJECTS) {
    const clips = seriesVideos.filter((v) => !named.has(v.videoId) && nctProjectOf(v) === name).map(toVid);
    addVideoCollection(name, clips, [], `nct-${slug(name)}`, 'NCT 단체');
  }
  const grouped = new Set(pages.flatMap((page) => page.seasons.flatMap((season) => season.videos.map((v) => v.id))));
  const ungrouped = [...videoById.values()].filter((v) => v.channel === GROUP.name && !grouped.has(v.videoId));
  const kinds = new Map(ungrouped.map((v) => [v.videoId, videoKind(v)]));
  for (const { id, name, kinds: includedKinds } of CHANNEL_COLLECTIONS) {
    const list = ungrouped.filter((v) => includedKinds.includes(kinds.get(v.videoId)!)).map(toVid);
    addVideoCollection(name, list, [], id, '자체 콘텐츠 시리즈');
  }
  for (const { id, name, type = '종류별 모아보기', records } of MEMBER_RECORDS) {
    const episodes = records.map((record) => ({ ...record, time: null })).sort((a, b) => b.date.localeCompare(a.date));
    pages.push({
      id, type, name, count: episodes.length, ...range(episodes.map((e) => e.date)),
      thumb: episodes.find((e) => e.thumb)?.thumb, members: [...new Set(episodes.flatMap((e) => e.members))], seasons: [], episodes,
    });
  }

  // 제작사·브랜드 원문과 검증한 기존 기록을 프로그램별로 모은다.
  const hiddenKeys = new Set(hidden.flatMap((entry) => [entry.url, ...entry.urls]).map(sourceKey));
  const originals = feed.filter((f) => (f.type === 'youtube' || f.type === 'sns') && f.publisher && f.members.length);
  for (const { id, name, type, publishers, match, records } of CATALOG) {
    const bySource = new Map<string, SeriesEpisode>();
    const add = ({ image, ...record }: { url: string; title: string; date: string; members: string[]; image?: string }) => {
      const key = sourceKey(record.url);
      if (hiddenKeys.has(key) || unavailableIds.has(key)) return;
      const yt = youtubeId(record.url);
      bySource.set(key, { ...record, time: null, step: record.title, thumb: image ?? (yt ? `https://i.ytimg.com/vi/${yt}/mqdefault.jpg` : bySource.get(key)?.thumb) });
    };
    const channelPrefixes = publishers.map(sq);
    const keywords = match?.map(sq);
    for (const f of originals) {
      if (!channelPrefixes.some((p) => sq(f.publisher!).startsWith(p)) || (keywords && !keywords.some((k) => sq(f.title).includes(k)))) continue;
      add({ url: f.url, title: f.title, date: kst(f.publishedAt), members: f.members, image: f.image });
    }
    for (const record of records) add(record);
    const episodes = [...bySource.values()].sort((a, b) => b.date.localeCompare(a.date));
    if (!episodes.length) continue;
    pages.push({ id, name, type, count: episodes.length, ...range(episodes.map((e) => e.date)), thumb: episodes.find((e) => e.thumb)?.thumb,
      members: [...new Set(episodes.flatMap((e) => e.members))], seasons: [], episodes });
  }

  // 3) 고정 출연: 일주일 넘게 이어진 외부 예능
  const byId = new Map(events.map((e) => [e.id, e]));
  const appearancesByShow = new Map<string, SeriesPage>();
  // (공식 채널 자체 콘텐츠는 외부 출연이 아니라서 뺀다)
  const ownOnly = (a: Activity) => a.eventIds.every((id) => (byId.get(id)?.sources ?? []).every((src) => src.type === 'youtube' && OWN.has(src.publisher ?? '')));
  for (const a of acts.filter((x) => x.kind === '예능' && Date.parse(x.to) - Date.parse(x.from) > 7 * 864e5 && !ownOnly(x))) {
    const eps = a.eventIds.map((id) => byId.get(id)!).filter(Boolean).sort((x, y) => x.date.localeCompare(y.date)).map((e) => {
      const yt = e.sources.find((s) => s.type === 'youtube' || /youtu/.test(s.url));
      const id = yt?.url.match(/(?:v=|youtu\.be\/|shorts\/|live\/)([\w-]{11})/)?.[1];
      return { date: e.date, time: e.time, title: e.title.replace(/^유튜브\s+/, ''), step: e.step, members: e.members, url: yt?.url ?? e.sources[0]?.url, thumb: id ? `https://i.ytimg.com/vi/${id}/mqdefault.jpg` : undefined };
    });
    const id = `a-${slug(a.name)}`;
    const previous = appearancesByShow.get(id);
    const episodes = [...new Map([...(previous?.episodes ?? []), ...eps]
      .map((e) => [`${e.date}|${e.step}`, e] as const)).values()].sort((x, y) => x.date.localeCompare(y.date));
    appearancesByShow.set(id, { id, type: '고정 출연', name: a.name, count: episodes.length, ...range([a.from, a.to, ...(previous ? [previous.from, previous.to] : [])]),
      thumb: episodes.find((x) => x.thumb)?.thumb, members: [...new Set([...(previous?.members ?? []), ...a.owner.members])], seasons: [], episodes });
  }
  pages.push(...appearancesByShow.values());

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
