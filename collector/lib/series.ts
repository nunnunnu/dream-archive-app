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
import type { SeriesHintKind } from './reports.ts';
import { topicOf, type FeedTopic } from './topics.ts';
import { ROOT } from './store.ts';
import { seriesName } from './tags.ts';
import type { Video } from './youtube.ts';

export interface SeriesVideo { id: string; title: string; url: string; thumb: string; date: string; ep: number | null; members: string[] }
interface SeriesEpisode { date: string; time: string | null; title: string; step: string; members: string[]; url?: string; thumb?: string }
export interface SeriesPage {
  id: string;
  type: '자체 콘텐츠 시리즈' | 'NCT 단체' | '종류별 모아보기' | '고정 출연' | '반복 활동' | '외부활동' | '광고' | '화보' | '드라마' | '라디오'
    | '콘서트·팬미팅 비하인드' | '시상식·연말 무대';
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

interface SeriesGroup {
  id: string; name: string; match: string[]; singleSeason?: boolean; channels?: string[]; videoIds?: string[];
  type?: '종류별 모아보기' | '광고' | '콘서트·팬미팅 비하인드';
  behindOnly?: boolean;
  shortEpisodes?: boolean;
  seasons?: { name: string; videoIds: string[] }[];
}
const CONFIG: { seriesGroups?: SeriesGroup[] } = JSON.parse(readFileSync(join(ROOT, 'config', 'tags.json'), 'utf8'));
// 공식 업로드로 확인한 영상. 제목에 'Cover'가 없거나 제작사 채널이 수집 목록에 없어도 모아보기에 연결한다.
const VERIFIED = JSON.parse(readFileSync(join(ROOT, 'config', 'verified-series-videos.json'), 'utf8')) as {
  covers: string[];
  standalone: string[];
};
const STANDALONE_VIDEOS = new Set(VERIFIED.standalone);
const MEMBER_RECORDS = JSON.parse(readFileSync(join(ROOT, 'config', 'member-records.json'), 'utf8')) as
  { id: string; name: string; type?: '라디오'; records: Omit<SeriesEpisode, 'time'>[] }[];
const CATALOG = JSON.parse(readFileSync(join(ROOT, 'config', 'series-catalog.json'), 'utf8')) as {
  id: string; name: string; type: HintType; publishers: string[]; match?: string[];
  records: (Pick<SeriesEpisode, 'date' | 'title' | 'members'> & { url: string })[];
}[];
// 수집된 단서로 자동으로 만드는 시리즈 종류와 페이지 id 앞머리
type HintType = '광고' | '화보' | '외부활동' | '드라마';
const HINT_TYPE: Record<SeriesHintKind, HintType> = { 광고: '광고', 화보: '화보', 예능: '외부활동', 외부콘텐츠: '외부활동', 드라마: '드라마' };
const HINT_PREFIX: Record<HintType, string> = { 광고: 'ad', 화보: 'pic', 외부활동: 'x', 드라마: 'd' };
// 단서 칸 없는 소식은 이미 아는 이름이 제목에 있고 주제가 맞을 때만 붙인다 (새 이름은 만들지 않음)
const APPEAR_RE = /출연|게스트|녹화|등장|합류|방송|촬영/;
const topicFits: Record<HintType, (title: string, topic?: FeedTopic) => boolean> = {
  광고: (_, topic) => topic === '광고',
  화보: (_, topic) => topic === '브랜드·화보',
  외부활동: (title) => APPEAR_RE.test(title),
  드라마: () => false, // 드라마 기사는 드라마 아카이브(활동 묶기)가 이미 모은다
};
// 너무 짧은 이름은 다른 말 속에 잘못 걸린다 (영문 'Lee' 등)
const matchable = (k: string) => (/[가-힣]/.test(k) ? k.length >= 2 : k.length >= 4);
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
const PROMO_VIDEO_RE = /\b(?:trailer|teaser|preview|sneak\s*peek)\b|트레일러|티저|프리뷰|예고(?:편|\s*영상)/i;
const DANCE_PRACTICE_RE = /\b(?:dance|performance|choreography)\s+(?:practice|rehearsal)\b|\bchoreography\s+video\b|(?:안무|댄스)\s*(?:연습|리허설|영상)/i;
const STAGE_VIDEO_RE = /\b(?:stage clip|performance stage|NCT DREAM THE STAGE|DREAM STAGE\s*:\s*GLITCH MODE)\b|@[^|]*?(?:THE\s+DREAM\s+SHOW|NCT\s*DREAM\s*10TH\s*ANNIVERSARY\s*PARTY)/i;
const EVENT_BEHIND_RE = /\bVCR\s+Shooting\b|\bDREAM PIECE\b.*\b(?:REHEARSAL|D-DAY)\b/i;
const CONCERT_BEHIND_RE = /\b(?:behind|recap|lookbook|ticketing|takes japan)\b|\bpage\s*#?\s*\d+|\bposter\s+shoot|비하인드|티켓팅|리캡|촬영\s*현장/i;
const AWARD_EVENT_RE = /가요\s*대(?:전|축제|제전)|뮤직뱅크\s*글로벌\s*페스티벌|골든\s*디스크|서울\s*가요\s*대상|시상식|연말\s*무대|year[\s-]*end\s*(?:stage|award)|\b(?:MMA|MAMA|AAA|GDA|TMA|Melon Music Awards|Golden Disc Awards|Asian Artist Awards|Asia Artist Awards|The Fact Music Awards)\b/i;
const AUDIO_RE = /\(\s*Official Audio\s*\)|공식\s*오디오/i;
const FANMEETING_RE = /\bfan\s*meeting\b|팬\s*미팅/i;
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
  ['성쇼 오늘 무해?!', /성쇼\s*오늘\s*무해/i],
];
const nctProjectOf = (v: Video) => NCT_PROJECTS.find(([, re]) => re.test(v.title))?.[0];
const seriesVideoKind = (v: Video): VideoKind => {
  const title = v.title.normalize('NFKC');
  const kind = videoKind(v);
  if (kind === '비하인드' || EVENT_BEHIND_RE.test(title)) return '비하인드';
  if (STAGE_VIDEO_RE.test(title) && !PROMO_VIDEO_RE.test(title)) return '퍼포먼스';
  return kind;
};

const RECORDING_BEHIND_RE = /recording\s*behind|recording\s*diary|녹음\s*비하인드/i;
const COLLECTIONS: [string, RegExp][] = [
  ['MV·자켓 비하인드', /behind the scenes|비하인드|making film|jacket/i],
  ['Dance Practice', DANCE_PRACTICE_RE],
  // 커버: "Cover | RENJUN - …", "'Soda Pop' Cover Stage", "YOUTH Cover Behind", "커버" (album cover·Undercover 는 아님)
  // 커버 비하인드는 커버가 아니라 비하인드 (MV·자켓 비하인드 쪽)
  ['Cover', /^(?!.*album\s*cover)(?!.*cover\s*behind)(?:.*(?:^|[|｜]\s*)cover\s*[|｜:]|.*[)'’"]\s*cover\b|.*\bcover\s*(?:stage|ver)|.*\bdance\s+cover\b|.*커버)/i],
  ['Live Clip', /live\s*clip/i],
  ['응원법', /응원법|cheering\s*guide/i],
];
const CHANNEL_COLLECTIONS: { id: string; name: string; kinds: VideoKind[] }[] = [
  { id: 'channel-behind', name: '비하인드·리액션', kinds: ['비하인드'] },
  { id: 'channel-live', name: '라이브', kinds: ['라이브'] },
  { id: 'channel-other', name: '기타 채널 영상', kinds: ['기타', '자컨 시리즈', '응원법'] },
];

/**
 * 회차 번호 없는 자체 콘텐츠: "… | BOOGIE WOOGIE MAN" 처럼 끝 칸 이름이 같은 영상이 2개 이상이면 한 시리즈로 본다.
 * 비하인드·리액션·언박싱·노래 플레이리스트 모음은 시리즈가 아니라서 뺀다. (NCT 프로젝트는 따로 모아서 여기서 안 씀)
 */
const NOT_PROGRAM_SUFFIX_RE = /(?:behind(?:\s+the\s+scenes?)?|비하인드|reaction|리액션|unboxing|언박싱|teaser|trailer|티저|MV|playlist|플레이리스트)\s*[!?.]*$/i;
export function sharedSuffixSeries(list: Pick<Video, 'videoId' | 'title'>[]): Map<string, string> {
  const byKey = new Map<string, { name: string; ids: Set<string> }>();
  for (const v of list) {
    const segs = v.title.normalize('NFKC').split(/\s*[|｜]\s*/).map((x) => x.trim()).filter(Boolean);
    if (segs.length < 2) continue;
    const name = segs.at(-1)!.replace(/#\S+/g, '').replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu, '').trim();
    if (sq(name).length < 3 || NOT_PROGRAM_SUFFIX_RE.test(name)) continue;
    const entry = byKey.get(sq(name)) ?? { name, ids: new Set() };
    entry.ids.add(v.videoId);
    byKey.set(sq(name), entry);
  }
  const out = new Map<string, string>();
  for (const { name, ids } of byKey.values()) if (ids.size >= 2) for (const id of ids) out.set(id, name);
  return out;
}

/**
 * 다른 유튜브 채널 출연: 일정에 "유튜브 ○○"(또는 제목에 채널 이름)으로 들어오고 그 채널 영상이 근거로 붙은 것.
 * 공식 채널 영상과 고정 출연으로 따로 묶이는 회차는 뺀다. 채널 이름은 영상 근거의 채널, 없으면 제보 제목 "채널: 제목"의 앞부분.
 */
export function youtubeAppearances(events: PublicEvent[], skipEventIds: ReadonlySet<string> = new Set()) {
  const out = new Map<string, { channel: string; name: string; titles: string[]; eventIds: string[]; records: { url: string; title: string; date: string; members: string[]; image?: string }[] }>();
  for (const e of events) {
    if (skipEventIds.has(e.id) || e.kind === '기념일') continue;
    const yt = e.sources.find((src) => src.type === 'youtube' && youtubeId(src.url) && src.publisher && !OWN.has(src.publisher))
      ?? e.sources.find((src) => src.type === 'submission' && youtubeId(src.url) && /^[^:]{2,40}:\s/.test(src.title ?? ''));
    if (!yt) continue;
    const channel = yt.publisher ?? yt.title!.split(':')[0].trim();
    if (OWN.has(channel)) continue;
    const program = e.title.replace(/^유튜브\s+/, '').trim();
    if (!/^유튜브\s/.test(e.title) && !(e.kind === '발매' && sq(e.title).includes(sq(channel)))) continue;
    const key = sq(channel);
    const entry = out.get(key) ?? { channel, name: channel, titles: [], eventIds: [], records: [] };
    entry.titles.push(program);
    entry.eventIds.push(e.id);
    const raw = yt.title || e.step;
    const title = raw.startsWith(`${channel}:`) ? raw.slice(channel.length + 1).trim() : raw;
    entry.records.push({ url: `https://www.youtube.com/watch?v=${youtubeId(yt.url)}`, title, date: yt.publishedAt ? kst(yt.publishedAt) : e.date, members: e.members });
    out.set(key, entry);
  }
  // 카드 이름: 일정 제목에 자주 나온 프로그램 이름(짧을 때), 아니면 채널 이름
  for (const entry of out.values()) {
    const counts = new Map<string, number>();
    for (const t of entry.titles) counts.set(t, (counts.get(t) ?? 0) + 1);
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    if (top && top.length <= 24) entry.name = top;
  }
  return out;
}

export function buildSeries(videos: Video[], events: PublicEvent[], acts: Activity[], eras: EraPage[], feed: FeedItem[] = [], hidden: NewsHide[] = [], unavailableIds: ReadonlySet<string> = new Set()): SeriesPage[] {
  const groups = (CONFIG.seriesGroups ?? []).map((group) => ({ ...group, match: group.match.map(sq) }));
  const configuredByVideo = new Map<string, SeriesGroup>();
  // 공식 채널 영상은 수집할 때 이미 드림 관련(제목·설명 해시태그)만 받았다 → 제목에 이름이 없어도(천지의 이것저것 등) 시리즈에 쓴다
  const own = videos.filter((v) => {
    if (!OWN.has(v.channel)) return false;
    if (nctProjectOf(v) === '어색하지만 괜찮아' && !mentionedMembers(v.title).members.length) return false;
    const title = sq(v.title);
    const group = groups.find((g) => g.videoIds?.includes(v.videoId) ||
      ((!g.channels || g.channels.includes(v.channel)) && g.match.some((key) => title.includes(key))
        && (!g.behindOnly || CONCERT_BEHIND_RE.test(v.title) || seriesVideoKind(v) === '비하인드')));
    if (group) configuredByVideo.set(v.videoId, group);
    return Boolean(group) || STANDALONE_VIDEOS.has(v.videoId) || v.channel === GROUP.name ||
      (isDreamRelated(`${v.title}\n${v.description ?? ''}`) && !/react|리액션/i.test(v.title));
  });
  const musicVideos = new Map(own.filter((v) => {
    const title = v.title.normalize('NFKC');
    const kind = seriesVideoKind(v);
    const countdown = /\bD-\d+\s*$/i.test(title) && (v.duration ?? Infinity) <= 60;
    return kind === 'MV·티저' || (kind !== '비하인드' && (countdown || PROMO_VIDEO_RE.test(title)) && !/촬영\s*현장/.test(title));
  }).map((v) => [v.videoId, v]));
  const trackVideos = new Map(own.filter((v) => TRACK_VIDEO_RE.test(v.title) && videoKind(v) === '퍼포먼스')
    .map((v) => [v.videoId, v]));
  const shortVideos = new Map(own.filter((v) => v.channel === GROUP.name || configuredByVideo.has(v.videoId) || STANDALONE_VIDEOS.has(v.videoId))
    .filter((v) => !trackVideos.has(v.videoId) && !musicVideos.has(v.videoId)
      && (/#(?:shorts?\b|쇼츠)/i.test(v.title) ||
        (!configuredByVideo.get(v.videoId)?.shortEpisodes && ['쇼츠', '챌린지'].includes(videoKind(v)))))
    .map((v) => [v.videoId, v]));
  const audio = own.filter((v) => AUDIO_RE.test(v.title.normalize('NFKC')));
  const audioIds = new Set(audio.map((v) => v.videoId));
  const available = own.filter((v) => !audioIds.has(v.videoId) && !trackVideos.has(v.videoId) &&
    !musicVideos.has(v.videoId) && !shortVideos.has(v.videoId));
  const awards = available.filter((v) => AWARD_EVENT_RE.test(v.title.normalize('NFKC')));
  const awardBehind = awards.filter((v) => seriesVideoKind(v) === '비하인드' || CONCERT_BEHIND_RE.test(v.title));
  const awardIds = new Set(awardBehind.map((v) => v.videoId));
  const awardPractice = awards.filter((v) => !awardIds.has(v.videoId) && DANCE_PRACTICE_RE.test(v.title.normalize('NFKC')));
  for (const v of awardPractice) awardIds.add(v.videoId);
  const awardStages = awards.filter((v) => !awardIds.has(v.videoId) && seriesVideoKind(v) === '퍼포먼스');
  for (const v of awardStages) awardIds.add(v.videoId);
  const seriesVideos = available.filter((v) => !awardIds.has(v.videoId));
  const pages: SeriesPage[] = [];
  const videoById = new Map(videos.map((v) => [v.videoId, v]));

  // 1) 자체 콘텐츠 시리즈
  const programVideos = seriesVideos.filter((v) => !(seriesVideoKind(v) === '퍼포먼스' || (seriesVideoKind(v) !== '비하인드' && DANCE_PRACTICE_RE.test(v.title.normalize('NFKC')))));
  const suffixSeries = sharedSuffixSeries(programVideos.filter((v) => !configuredByVideo.has(v.videoId) && !seriesName(v.title) && !nctProjectOf(v)));
  const byFamily = new Map<string, { name: string; type?: SeriesGroup['type']; seasons: Map<string, Video[]> }>();
  for (const v of programVideos) {
    // 설정 묶음은 제목 전체에서 찾는다 (회차 표시가 없는 "[Dream VS Dream] …"도)
    const cfg = configuredByVideo.get(v.videoId);
    const configuredSeason = cfg?.seasons?.find((season) => season.videoIds.includes(v.videoId))?.name;
    const s = configuredSeason ?? (cfg?.singleSeason ? cfg.name : seriesName(v.title) ?? cfg?.name ?? suffixSeries.get(v.videoId));
    if (!s || (!cfg && /NCT\s*DREAM|엔시티/i.test(s))) continue;
    if (!cfg && /^(?:\[.+?\]\s*)?TODAY[!:]/i.test(s) && /#shorts?\b/i.test(v.title)) continue;
    // 시즌 표시를 뗀 이름이 같으면 한 시리즈의 시즌 (천지의 이것저것 / 시즌2 / 시즌3)
    const base = s.replace(/\s*(시즌|season)\s*\d+|\s+S\d+\b/gi, '').trim();
    // 앞 단어가 같은 시즌 (7llin’ in the DREAM, 7llin’ in our Youth …) → "7llin'" 가족
    const root = sq(base.split(/\s+/)[0]);
    //   첫 단어가 연도·숫자("2026 NCT JNJM …" / "2026 RENJUN&CHENLE …")면 다른 시리즈라서 쓰지 않는다
    const famKey = cfg ? `cfg:${cfg.id}` : root.length >= 4 && !/^\d+$/.test(root) ? `root:${root}` : `name:${sq(base)}`;
    const fam = byFamily.get(famKey) ?? { name: cfg?.name ?? base, type: cfg?.type, seasons: new Map() };
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
    const type = fam.type ?? (FANMEETING_RE.test(name) ? '콘서트·팬미팅 비하인드' : all.some(nctProjectOf) ? 'NCT 단체' : '자체 콘텐츠 시리즈');
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
  const recordings = new Map(seriesVideos.filter((v) => RECORDING_BEHIND_RE.test(v.title.normalize('NFKC'))).map((v) => [v.videoId, v]));
  addVideoCollection('Recording Behind', [...recordings.values()].map(toVid));
  for (const [name, re] of COLLECTIONS) {
    const list = new Map(seriesVideos.filter((v) => re.test(v.title.normalize('NFKC')) &&
      (name !== 'MV·자켓 비하인드' || !recordings.has(v.videoId)) &&
      (name !== 'Dance Practice' || seriesVideoKind(v) !== '비하인드')).map((v) => [v.videoId, v]));
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
  addVideoCollection('공식 오디오', audio.map(toVid), [], 'channel-audio');
  addVideoCollection('시상식·연말 무대 안무', awardPractice.map(toVid), [], 'award-practice', '시상식·연말 무대');
  addVideoCollection('시상식·연말 무대 비하인드', awardBehind.map(toVid), [], 'award-behind', '시상식·연말 무대');
  addVideoCollection('시상식·연말 무대 영상', awardStages.map(toVid), [], 'award-stages', '시상식·연말 무대');

  for (const era of eras) {
    const seasons = SHOWCASE_GROUPS.map(([group, name]) => ({
      name, videos: era.own.filter((v) => v.group === group).map((v) => ({
        id: v.id, title: v.title, url: v.url, thumb: v.thumb, date: v.date, members: v.members, ep: null,
      })),
    })).filter((season) => season.videos.length);
    const clips = seasons.flatMap((season) => season.videos);
    if (!clips.length) continue;
    pages.push({
      id: `showcase-${era.id}`, name: `${era.title} 컴백 쇼케이스`, type: '종류별 모아보기', count: clips.length,
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
  const performance = seriesVideos.filter((v) => !grouped.has(v.videoId) && seriesVideoKind(v) === '퍼포먼스');
  addVideoCollection('퍼포먼스 영상', performance.map(toVid), [], 'channel-performance');
  for (const v of performance) grouped.add(v.videoId);
  const ungrouped = [...videoById.values()].filter((v) =>
    (v.channel === GROUP.name || STANDALONE_VIDEOS.has(v.videoId)) && !grouped.has(v.videoId));
  const kinds = new Map(ungrouped.map((v) => [v.videoId, seriesVideoKind(v)]));
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

  // 고정 출연(일주일 넘게 이어진 외부 예능)으로 따로 보여 줄 활동. 공식 채널 자체 콘텐츠는 외부 출연이 아니라서 뺀다
  const byId = new Map(events.map((e) => [e.id, e]));
  const ownOnly = (a: Activity) => a.eventIds.every((id) => (byId.get(id)?.sources ?? []).every((src) => src.type === 'youtube' && OWN.has(src.publisher ?? '')));
  const fixedActs = acts.filter((x) => x.kind === '예능' && Date.parse(x.to) - Date.parse(x.from) > 7 * 864e5 && !ownOnly(x));
  const appearances = youtubeAppearances(events, new Set(fixedActs.flatMap((a) => a.eventIds)));

  // 제작사·브랜드 원문과 검증한 기존 기록을 프로그램별로 모은다.
  const hiddenKeys = new Set(hidden.flatMap((entry) => [entry.url, ...entry.urls]).map(sourceKey));
  const originals = feed.filter((f) => (f.type === 'youtube' || f.type === 'sns') && f.publisher && f.members.length);

  // 시리즈 단서: 제보(seriesKind·seriesName), 일정의 짧은 외부 예능, 이미 아는 이름이 든 소식 → (종류, 이름)으로 묶는다
  type Rec = { url: string; title: string; date: string; members: string[]; image?: string };
  const hints = new Map<string, { type: HintType; names: string[]; records: Rec[] }>();
  const hint = (type: HintType, name: string, rec: Rec) => {
    const k = sq(name);
    if (!k) return;
    const h = hints.get(`${type}|${k}`) ?? { type, names: [], records: [] };
    h.names.push(name.trim());
    h.records.push(rec);
    hints.set(`${type}|${k}`, h);
  };
  const feedRec = (f: FeedItem): Rec => ({ url: f.url, title: f.title, date: kst(f.publishedAt), members: f.members, image: f.image });
  for (const f of feed) if (f.series && HINT_TYPE[f.series.kind]) hint(HINT_TYPE[f.series.kind], f.series.name, feedRec(f));
  // 기간 1주 이하 외부 예능 (1주 넘으면 아래 고정 출연, 유튜브 채널 출연은 채널 카드가 맡는다)
  const appearanceEvents = new Set([...appearances.values()].flatMap((a) => a.eventIds));
  const fixedIds = new Set(fixedActs.map((a) => a.id));
  for (const a of acts) {
    if (a.kind !== '예능' || fixedIds.has(a.id) || ownOnly(a)) continue;
    for (const e of a.eventIds.map((id) => byId.get(id))) {
      if (!e || appearanceEvents.has(e.id)) continue;
      const src = e.sources.find((x) => youtubeId(x.url)) ?? e.sources.find((x) => /^https?:/.test(x.url));
      if (src) hint('외부활동', a.name, { url: src.url, title: e.title, date: e.date, members: e.members });
    }
  }
  // 이름 → 설정 목록 시리즈 (제보 단서는 출처 이름으로도 찾는다)
  const catalogOf = new Map<string, string>();
  for (const c of CATALOG) for (const n of [c.name, ...c.publishers, ...(c.match ?? [])]) catalogOf.set(`${c.type}|${sq(n)}`, c.id);
  // 단서 칸 없는 소식: 설정 목록 이름(광고는 브랜드 이름까지)과 단서로 생긴 이름
  const knownNames = new Map<string, { type: HintType; name: string }>();
  for (const c of CATALOG) for (const n of [c.name, ...(c.match ?? []), ...(c.type === '광고' || c.type === '화보' ? c.publishers : [])]) knownNames.set(`${c.type}|${sq(n)}`, { type: c.type, name: n });
  for (const [key, h] of hints) knownNames.set(key, { type: h.type, name: h.names[0] });
  const nameList = [...knownNames.entries()].filter(([key]) => matchable(key.split('|')[1]));
  for (const f of feed) {
    if (f.series || f.type === 'weverse-notice') continue;
    const title = sq(f.title);
    const topic = f.topic ?? topicOf(f.title);
    const hit = nameList.find(([key, { type }]) => title.includes(key.split('|')[1]) && topicFits[type](f.title, topic));
    if (hit) hint(hit[1].type, hit[1].name, feedRec(f));
  }
  const hintsFor = (catalogId: string) => [...hints].filter(([key]) => catalogOf.get(key) === catalogId).flatMap(([key, h]) => (hints.delete(key), h.records));

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
    for (const record of hintsFor(id)) if (!bySource.has(sourceKey(record.url))) add(record);
    // 일정에 들어온 같은 채널 출연 영상도 (match 가 있으면 그 프로그램 이름이 제목에 있을 때만)
    for (const [key, app] of appearances) {
      if (!channelPrefixes.some((p) => sq(app.channel).startsWith(p))) continue;
      const fit = app.records.filter((r) => bySource.has(sourceKey(r.url)) || !keywords || keywords.some((k) => sq(r.title).includes(k)));
      for (const r of fit) if (!bySource.has(sourceKey(r.url))) add(r); // 설정에 적은 기록(다듬은 제목)이 먼저
      if (fit.length === app.records.length) appearances.delete(key);
      else app.records = app.records.filter((r) => !fit.includes(r));
    }
    const episodes = [...bySource.values()].sort((a, b) => b.date.localeCompare(a.date));
    if (!episodes.length) continue;
    pages.push({ id, name, type, count: episodes.length, ...range(episodes.map((e) => e.date)), thumb: episodes.find((e) => e.thumb)?.thumb,
      members: [...new Set(episodes.flatMap((e) => e.members))], seasons: [], episodes });
  }
  // 같은 이름의 채널 출연 카드가 있으면 단서도 거기에
  for (const [key, h] of hints) {
    const k = key.split('|')[1];
    const app = h.type === '외부활동' && [...appearances.values()].find((a) => sq(a.name) === k || sq(a.channel) === k);
    if (!app) continue;
    app.records.push(...h.records);
    hints.delete(key);
  }
  const episodeOf = ({ image, ...r }: Rec): SeriesEpisode => {
    const yt = youtubeId(r.url);
    return { ...r, time: null, step: r.title, thumb: image ?? (yt ? `https://i.ytimg.com/vi/${yt}/mqdefault.jpg` : undefined) };
  };
  // 설정 목록에 없는 채널 출연은 채널별로 새로 만든다 (새 채널에 나오면 다음 수집 때 바로 생김)
  const usedIds = new Set(pages.map((p) => p.id));
  for (const app of appearances.values()) {
    const bySource = new Map<string, SeriesEpisode>();
    for (const r of app.records) {
      const key = sourceKey(r.url);
      if (hiddenKeys.has(key) || unavailableIds.has(key) || bySource.has(key)) continue;
      bySource.set(key, episodeOf(r));
    }
    const episodes = [...bySource.values()].sort((a, b) => b.date.localeCompare(a.date));
    if (!episodes.length) continue;
    let id = `x-${slug(app.channel)}`;
    while (usedIds.has(id)) id += '-y';
    usedIds.add(id);
    pages.push({ id, name: app.name, type: '외부활동', count: episodes.length, ...range(episodes.map((e) => e.date)), thumb: episodes.find((e) => e.thumb)?.thumb,
      members: [...new Set(episodes.flatMap((e) => e.members))], seasons: [], episodes });
  }

  // 3) 고정 출연: 일주일 넘게 이어진 외부 예능
  const appearancesByShow = new Map<string, SeriesPage>();
  for (const a of fixedActs) {
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
  // 남은 단서: 같은 이름의 고정 출연에 더하거나, 새 시리즈 페이지로 (1건부터)
  // 이미 다른 종류로 있는 이름(자체 콘텐츠 'Cafe 7 DREAM' 등)은 외부 시리즈로 새로 만들지 않는다
  const builtNames = new Set(pages.map((p) => sq(p.name)));
  for (const [key, h] of hints) {
    const k = key.split('|')[1];
    if (builtNames.has(k)) continue;
    const fixed = h.type === '외부활동' && [...appearancesByShow.values()].find((p) => sq(p.name) === k);
    const bySource = new Map<string, SeriesEpisode>();
    for (const e of fixed ? fixed.episodes ?? [] : []) bySource.set(e.url ? sourceKey(e.url) : `${e.date}|${e.step}`, e);
    for (const r of h.records) {
      const sk = sourceKey(r.url);
      if (hiddenKeys.has(sk) || unavailableIds.has(sk) || bySource.has(sk)) continue;
      bySource.set(sk, episodeOf(r));
    }
    const episodes = [...bySource.values()].sort((a, b) => (fixed ? a.date.localeCompare(b.date) : b.date.localeCompare(a.date)));
    if (!episodes.length) continue;
    const members = [...new Set(episodes.flatMap((e) => e.members))];
    if (fixed) {
      Object.assign(fixed, { count: episodes.length, ...range([fixed.from, fixed.to, ...episodes.map((e) => e.date)]), thumb: fixed.thumb ?? episodes.find((e) => e.thumb)?.thumb,
        members: [...new Set([...fixed.members, ...members])], episodes });
      continue;
    }
    // 이름: 가장 많이 쓰인 표기
    const counts = new Map<string, number>();
    for (const n of h.names) counts.set(n, (counts.get(n) ?? 0) + 1);
    const name = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
    let id = `${HINT_PREFIX[h.type]}-${slug(name)}`;
    while (usedIds.has(id)) id += '-y';
    usedIds.add(id);
    // 드라마는 같은 이름의 드라마 아카이브(활동 묶기)를 함께 건다
    const era = h.type === '드라마' ? eras.find((e) => e.kind === '드라마' && sq(e.title) === k) : undefined;
    pages.push({ id, name, type: h.type, count: episodes.length, ...range(episodes.map((e) => e.date)), thumb: episodes.find((e) => e.thumb)?.thumb ?? era?.thumb,
      members, seasons: [], episodes,
      ...(era ? { activities: [{ id: era.id, title: era.title, kind: era.kind, owner: era.owner.label, from: era.from, to: era.to, cover: era.cover, thumb: era.thumb }] } : {}) });
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
      id: `r-${slug(name)}`, type: name === '시상식' ? '시상식·연말 무대' : '반복 활동', name, count: list.length, ...range(list.flatMap((e) => [e.from, e.to])), thumb: list.find((e) => e.thumb)?.thumb,
      members: [...new Set(list.flatMap((e) => e.owner.members))], seasons: [], activities: list.map(card),
    });
  }
  return pages;
}
