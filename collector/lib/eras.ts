/**
 * 활동 페이지 데이터: 자동으로 묶은 활동(activities.ts)마다 data/public/eras/{id}.json 을 만든다.
 *  - 활동 타임라인: 첫 티저 → 발매 → 쇼케이스 → 첫 음방 → 팬사인회 → 마지막 음방 (일정에서 자동)
 *  - 뮤비·공식 영상 / 자체 콘텐츠: 공식 채널 영상을 제목으로 나눈다
 *  - 음방 무대: 방송사 채널의 무대 영상을 프로그램별로
 *  - 외부 콘텐츠: 다른 채널 출연 영상 + 외부 출연 일정
 * 썸네일은 유튜브 썸네일 주소를 그대로 쓴다 (저장하지 않음).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PublicEvent } from './consolidate.ts';
import { GROUP } from './group.ts';
import { ROOT } from './store.ts';
import { isAppearance, isFanMade, originalAirDate, videoMembers, PRESS_COVERAGE_RE, STAGE_RE as STAGE_CLIP_RE, type Video } from './youtube.ts';
import type { Activity } from './activities.ts';

interface EraConfig {
  id: string; name: string; from: string; to: string; keywords: string[];
  kind?: string; title?: string; subtitle?: string; titleSong?: string; release?: string;
  cover?: { from: string; to: string; text: string };
}
export interface EraVideo { id: string; title: string; url: string; thumb: string; date: string; channel: string; members: string[]; group?: string }
export interface EraPage {
  id: string; kind: string; title: string; subtitle?: string; titleSong?: string; release?: string;
  owner: { scope: string; members: string[]; label: string };
  keys: string[];
  /** 합쳐진 작은 활동 (예: "팝업 WELCOME, DREAMERS") */
  parts: string[];
  from: string; to: string; cover: { from: string; to: string; text: string }; status: '활동 중' | '종료' | '예정';
  /** 표지 썸네일 (유튜브): 컴백은 MV, 공연·팬미팅은 공연 영상, 없으면 이 활동의 대표 영상 */
  thumb?: string;
  counts: { official: number; stages: number; fancams: number; own: number; shorts: number; outside: number; events: number };
  /** 쇼츠 (챌린지 · 멤버 쇼츠) */
  shorts: (EraVideo & { group: '챌린지' | '멤버 쇼츠' })[];
  timeline: { date: string; label: string; sub: string }[];
  /** 이 활동의 일정 (공연 날짜·예매 등) */
  schedule: { date: string; time: string | null; endDate: string | null; title: string; step: string; kind: string; url?: string; group: string }[];
  /** 활동 가이드: 팬이 해야 할 일(투표·앨범 구매·응모·예매·라디오)과 마감 */
  guide?: GuideItem[];
  /** 자체 콘텐츠 묶음 순서 */
  ownGroups: string[];
  official: EraVideo[];
  stages: { program: string; videos: EraVideo[] }[];
  /** 다른 채널의 관련 영상 (드라마 예고·클립·OST, 제작발표회 등). 컴백이 아닌 활동만 */
  related: (EraVideo & { group: string })[];
  /** 음방 직캠: 단체 → 멤버 순 */
  fancams: { member: string; videos: EraVideo[] }[];
  own: EraVideo[];
  outside: { date: string; title: string; sub: string; members: string[]; url?: string; thumb?: string }[];
  /** 이 활동 기사 (지난 기사 포함, 제목에 활동·곡 이름이 있는 것) */
  news: { date: string; title: string; url: string; publisher: string }[];
}

const SONG_ALIASES: Record<string, string[]> = JSON.parse(readFileSync(join(ROOT, 'config', 'song-aliases.json'), 'utf8')).aliases;
const CONFIG: { eras: EraConfig[] } = JSON.parse(readFileSync(join(ROOT, 'config', 'tags.json'), 'utf8'));
const PROGRAMS: { names: string[] }[] = JSON.parse(readFileSync(join(ROOT, 'config', 'programs.json'), 'utf8')).programs;
const OWN = new Set(GROUP.youtube.channels.filter((c) => !c.guest).map((c) => c.name));
const AGENCY = new Set([...OWN, ...(GROUP.youtube.agencyChannels ?? [])]);
const BROADCASTERS = new Set([...GROUP.youtube.channels.filter((c) => c.guest).map((c) => c.name), ...(GROUP.youtube.stageChannels ?? [])]);
/** 교차편집·스페셜 편집은 무대 원본이 아니라서 뺀다 */
const STAGE_MIX_RE = /교차\s*편집|stage\s*mix|special\s*edit/i;
const FANCAM_RE = /직캠|fan\s*cam|풀캠|full\s*cam|세로\s*캠|vertical|face\s*cam|페이스캠|focus\s*cam/i;
/** 직캠 주인: 제목에 멤버가 한 명만 나오면 그 멤버, 아니면 단체 */
const MEMBER_ALIASES = GROUP.members.map((m) => ({ name: m.name, re: new RegExp(m.aliases.map((a) => (/^[A-Z]+$/.test(a) ? `\\b${a}\\b` : a)).join('|'), 'i') }));
const fancamOwner = (title: string) => { const hit = MEMBER_ALIASES.filter((m) => m.re.test(title)); return hit.length === 1 ? hit[0].name : '단체'; };
const OFFICIAL_RE = /M\/?V|뮤직비디오|teaser|티저|trailer|트레일러|performance|dance\s*practice|안무|track\s*video|live\s*clip|lyric|highlight\s*medley|concept|album|spoiler|preview/i;
const STAGE_RE = /무대|stage|직캠|fancam|comeback|컴백|뮤직뱅크|music\s*bank|음악중심|music\s*core|인기가요|inkigayo|엠카운트다운|m\s*countdown|쇼\s*챔피언|show\s*champion|더\s*쇼|the\s*show/i;

/** 쇼츠: 1분 이하, 또는 3분 이하에 해시태그 여럿·#shorts */
const isShortVid = (v: { title: string; duration?: number }) => (v.duration !== undefined && v.duration <= 60) || /#shorts|쇼츠/i.test(v.title) || ((v.duration ?? 999) <= 180 && (v.title.match(/#\S+/g) ?? []).length >= 2);
/** 예고·티저·선공개·커밍순 */
const isTeaserVid = (v: { title: string }) => /예고|티저|teaser|trailer|트레일러|선공개|preview|coming\s*soon|커밍\s*순|미리\s*보기/i.test(v.title.normalize('NFKC'));
const kstDate = (iso: string) => new Date(new Date(iso).getTime() + 9 * 3600 * 1000).toISOString().slice(0, 10);
const toVid = (v: Video): EraVideo => ({
  id: v.videoId, title: v.title, url: v.url, thumb: `https://i.ytimg.com/vi/${v.videoId}/mqdefault.jpg`,
  date: originalAirDate(v) ?? kstDate(v.publishedAt), channel: v.channel, members: videoMembers(v),
});
const programName = (title: string) => PROGRAMS.find((p) => p.names.some((n) => title.toLowerCase().includes(n.toLowerCase())))?.names[0];

/**
 * 영상 분류: 순서가 중요하다 (비하인드를 MV·안무보다 먼저 본다 — "MV Behind the Scenes"는 비하인드)
 *  공식 = MV·티저·트레일러, 퍼포먼스 / 자체 콘텐츠 = 비하인드, 라이브, 챌린지, 응원법, 자컨 시리즈, 쇼츠, 기타
 */
export type VideoKind = 'MV·티저' | '퍼포먼스' | '비하인드' | '라이브' | '챌린지' | '응원법' | '자컨 시리즈' | '쇼츠' | '기타';
export function videoKind(v: { title: string; duration?: number }): VideoKind {
  const t = v.title.normalize('NFKC');
  if (/응원법|cheering\s*guide/i.test(t)) return '응원법';
  if (/behind|비하인드|making|메이킹|commentary|커멘터리|코멘터리|unboxing|언박싱|listening|recording|녹음|대기실|reaction|리액션/i.test(t)) return '비하인드';
  const isShortForm = v.duration !== undefined ? v.duration <= 60 || (v.duration <= 180 && /#\S+/.test(t)) : undefined;
  if (/\bwith\s+#|challenge|챌린지/i.test(t)) return '챌린지';
  if (/countdown\s*live|comeback\s*live|컴백\s*라이브|\[replay\]|\blive\b(?!\s*clip)|라이브|생방송/i.test(t)) return '라이브';
  if (/M\/?V\b|뮤직비디오|teaser|티저|trailer|트레일러|concept\s*film|spoiler|highlight\s*medley|preview/i.test(t)) return 'MV·티저';
  if (/dance\s*practice|안무\s*영상|performance\s*video|퍼포먼스|track\s*video|live\s*clip|relay\s*dance|릴레이\s*댄스/i.test(t)) return '퍼포먼스';
  // 짧은 영상이라도 MV 티저·안무 영상은 위에서 먼저 공식으로 간다
  if (isShortForm === true && !/\bEP\.?\s*\d/i.test(t)) return '쇼츠';
  if (/\bEP\.?\s*\d|\| ?ep ?\d|page\s*#?\d/i.test(t)) return '자컨 시리즈';
  // 쇼츠: 길이를 알면 3분 이하 + 해시태그 제목, 모르면 해시태그가 제목 대부분인 짧은 제목
  const tags = (t.match(/#\S+/g) ?? []).length;
  const words = t.replace(/#\S+/g, '').trim();
  if ((v.duration !== undefined && v.duration <= 180 && tags > 0) || (v.duration === undefined && tags >= 2 && words.length <= 25)) return '쇼츠';
  return '기타';
}
const OFFICIAL_KINDS: VideoKind[] = ['MV·티저', '퍼포먼스'];
const OWN_ORDER: VideoKind[] = ['비하인드', '라이브', '응원법', '자컨 시리즈', '기타'];
/** 쇼츠 칸 (자체 콘텐츠와 따로): 챌린지 + 멤버 쇼츠 */
const SHORT_KINDS: VideoKind[] = ['챌린지', '쇼츠'];
const ownGroupOf = (title: string, duration?: number) => videoKind({ title, duration });

export type GuideType = '투표' | '앨범 구매' | '응모·신청' | '예매' | '라디오';
export interface GuideItem {
  id: string; type: GuideType; title: string;
  /** 시작(그날부터 할 수 있음)과 마감 */
  start: string; startTime: string | null; due: string; dueTime: string | null;
  source: string; auto: boolean; url?: string;
  /** "사전투표 시작"처럼 시작만 알고 마감은 모름 */
  openEnded?: boolean;
  /** 근거와 숫자가 안 맞는 등 확인이 필요한 일정 */
  check?: boolean;
}
const SOURCE_LABEL: Record<string, string> = { 'weverse-notice': '위버스 공지', news: '기사', youtube: '유튜브', sns: '공식 SNS', submission: '팬 제보' };
/** 활동 일정 → 할 일. 공연 관람·녹화처럼 가서 보는 일정은 빼고, 미리 해야 하는 일만 */
export function guideOf(e: PublicEvent): GuideItem | null {
  const text = `${e.title} ${e.step}`;
  let type: GuideType | null = null;
  if (/라디오|radio|컬투쇼|FM\b|파워타임|볼륨을 높여요|두시탈출/i.test(text)) type = '라디오';
  else if (e.kind === '투표' || /투표|vote/i.test(text)) type = '투표';
  else if (/예매|티켓|ticket|선예매|사전\s*인증|팬클럽\s*인증/i.test(text)) type = '예매';
  else if (e.kind === '판매' || /구매|예약\s*판매|추가\s*판매|pre-?order/i.test(text)) type = '앨범 구매';
  else if (e.kind === '신청' || e.kind === '당첨 발표' || e.kind === '본인 확인' || /응모|신청|당첨/.test(text)) type = '응모·신청';
  if (!type || e.audience !== 'all') return null;
  // 라디오는 듣는 일정(방송)도 할 일로, 나머지는 참여 일정만
  if (type !== '라디오' && e.category !== '참여') return null;
  if (/공연\s*일시|녹화$|^녹화|본인\s*확인\s*모임|입장|부스|주의/.test(e.step)) return null;
  const src = e.sources.find((x) => x.type !== 'submission') ?? e.sources[0];
  return {
    id: e.id, type, title: e.step.includes(e.title) ? e.step : `${e.title} · ${e.step}`,
    start: e.date, startTime: e.time, due: e.endDate ?? e.date, dueTime: e.endDate ? e.endTime : (e.endTime ?? e.time),
    source: SOURCE_LABEL[src?.type ?? ''] ?? '기타', auto: e.sources.some((x) => x.type !== 'submission'), url: src?.url,
    ...(!e.endDate && !e.endTime && /시작|오픈|open/i.test(e.step) ? { openEnded: true } : {}),
    ...(e.status === 'needs-check' ? { check: true } : {}),
  };
}

/** 활동 일정 묶음: 합쳐진 작은 활동(팝업 등) 이름 → 음악방송 → 팬사인회·이벤트 → 예매·판매 → 공연·행사 → 공개·발매 → 방송 → 기타 */
function scheduleGroupOf(e: PublicEvent, parts: string[]): string {
  const text = `${e.title} ${e.step}`;
  const part = parts.find((p) => sq(e.title).includes(sq(p.replace(/^(팝업|곡|앨범)\s+/, ''))) && !/^곡\s/.test(p));
  if (part) return part;
  if (programName(e.title) || /사전\s*녹화|사전\s*투표|음악\s*방송/.test(e.title)) return '음악방송';
  if (/사인회|팬사인|video\s*call|영상\s*통화|럭키\s*드로우|특전|이벤트|event|미니\s*팬미팅/i.test(text)) return '팬사인회·이벤트';
  if (e.kind === '판매' || /예매|티켓|선예매|구매/.test(text)) return '예매·판매';
  if (e.kind === '행사') return '공연·행사';
  if (e.kind === '발매') return '공개·발매';
  if (e.kind === '방송') return '방송';
  if (e.kind === '투표') return '투표';
  return '신청·기타';
}

/** 활동 종류별 기본 표지 색 */
const KIND_COVER: Record<string, { from: string; to: string; text: string }> = {
  컴백: { from: '#c5f03a', to: '#10180a', text: '#c5f03a' },
  팬미팅: { from: '#f6a6c1', to: '#2a0f1a', text: '#ffd1e1' },
  '콘서트·투어': { from: '#6ee7ff', to: '#071a24', text: '#b8f3ff' },
  드라마: { from: '#ffb35c', to: '#241307', text: '#ffd29c' },
  팝업: { from: '#b9a6ff', to: '#140f2a', text: '#ddd2ff' },
  시상식: { from: '#ffe066', to: '#1f1a05', text: '#ffe066' },
  페스티벌: { from: '#ff8a65', to: '#24100a', text: '#ffc2ad' },
};
const sq = (t: string) => t.normalize('NFKC').replace(/[^\p{L}\p{N}]+/gu, '').toLowerCase();

/**
 * 활동 페이지: 자동으로 묶은 활동(findActivities)마다 영상·일정을 모은다.
 * config/tags.json eras 에 같은 이름(키워드)이 있으면 표지 색·타이틀곡·부제만 덧씌운다.
 */
export function buildEraPages(events: PublicEvent[], videos: Video[], acts: Activity[], today: string, articles: { title: string; link: string; source: string; publishedAt: string }[] = []): EraPage[] {
  const articlesFor = (keys: string[], from: string, to: string) => {
    const ks = keys.map(sq).filter((k) => k.length >= 3);
    const seen = new Set<string>();
    return articles
      .filter((a) => { const d = kstDate(a.publishedAt); return d >= new Date(Date.parse(from) - 21 * 864e5).toISOString().slice(0, 10) && d <= new Date(Date.parse(to) + 31 * 864e5).toISOString().slice(0, 10); })
      .filter((a) => ks.some((k) => sq(a.title).includes(k)))
      .filter((a) => (seen.has(sq(a.title).slice(0, 20)) ? false : (seen.add(sq(a.title).slice(0, 20)), true)))
      .sort((a, b) => a.publishedAt.localeCompare(b.publishedAt))
      .slice(0, 40)
      .map((a) => ({ date: kstDate(a.publishedAt), title: a.title, url: a.link, publisher: a.source }));
  };
  const byId = new Map(events.map((e) => [e.id, e]));
  // 어느 활동에도 안 묶인 일정 (제목에 곡 이름이 없는 "KBS 뮤직뱅크 사전녹화"·"인기가요 사전투표" 등) → 컴백 활동 가이드에 넣는다
  const assigned = new Set(acts.flatMap((a) => a.eventIds));
  // 다른 활동(드라마·팬미팅·고정 예능 등)으로 묶인 일정은 컴백의 외부 출연에서 뺀다. 며칠짜리 단발 예능은 홍보 출연이라 남긴다
  const claimed = new Set(acts.filter((a) => a.kind !== '예능' || Date.parse(a.to) - Date.parse(a.from) > 7 * 864e5).flatMap((a) => a.eventIds));
  // 활동 이름으로 정확히 걸린 영상 (예: #DUALITY) → 다른 활동이 보조 구절로 가져가지 못하게
  const primaryHit = new Set<string>();
  for (const a of acts) {
    const ks = a.keys.map(sq).filter((k) => k.length >= 3);
    for (const v of videos) if (ks.some((k) => sq(`${v.title} ${(v.description ?? '').slice(0, 300)}`).includes(k))) primaryHit.add(v.videoId);
  }
  const noTags = (t: string) => t.split(/\s+/).filter((w) => !w.startsWith('#')).join(' ');
  const pages: EraPage[] = [];
  // 예능 출연은 활동 페이지로 만들지 않는다 (단발 출연은 컴백의 "활동 기간 중 출연", 고정 예능은 시리즈 쪽)
  for (const act of acts.filter((a) => a.kind !== '예능')) {
    const cfg = CONFIG.eras.find((e) => [e.title ?? '', ...e.keywords].some((k) => act.keys.some((ak) => sq(ak) === sq(k))));
    // 활동 이름 + 설정의 다른 표기(한글 표기 "붐" = BOOM 등). 한글 표기는 짧아도 쓴다 (활동 기간 안의 영상에만 적용)
    // 활동 이름 + 다른 표기(config/song-aliases.json: "붐" = BOOM) + 설정 키워드. 한글 표기는 짧아도 쓴다 (활동 기간 안의 영상에만 적용)
    const aliasKeys = Object.entries(SONG_ALIASES).filter(([name]) => act.keys.some((k) => sq(k).includes(sq(name)))).flatMap(([, a]) => a);
    const keys = [...act.keys.map(sq).filter((k) => k.length >= 3), ...[...(cfg?.keywords ?? []), ...aliasKeys].map(sq).filter((k) => k.length >= 3 || /[가-힣]/.test(k))];
    const hasKey = (t: string) => keys.some((k) => sq(t).includes(k));
    // 보조 구절("10TH ANNIVERSARY PARTY")은 해시태그를 뺀 제목에서만, 다른 활동 이름으로 걸린 영상은 제외
    const extraKeys = act.videoKeys.map(sq).filter((k) => k.length >= 8);
    const matches = (v: Video) =>
      hasKey(`${v.title} ${(v.description ?? '').slice(0, 300)}`) || (!primaryHit.has(v.videoId) && extraKeys.some((k) => sq(noTags(v.title)).includes(k)));
    const from = new Date(Date.parse(act.from) - 21 * 864e5).toISOString().slice(0, 10);
    const inRange = (d: string) => d >= from && d <= act.to;
    // 영상은 활동이 끝난 뒤 한 달까지 (공연 라이브·비하인드가 나중에 올라온다)
    const videoTo = new Date(Date.parse(act.to) + 31 * 864e5).toISOString().slice(0, 10);
    // 지난 방송을 다시 올린 영상("MBC 190731 방송")은 올린 날이 아니라 원래 방송 날짜로 활동을 정한다
    const vids = videos.filter((v) => { const d = originalAirDate(v) ?? kstDate(v.publishedAt); return d >= from && d <= videoTo; })
      .filter(matches).sort((a, b) => a.publishedAt.localeCompare(b.publishedAt));
    // 시리즈 채우기: EP.n 영상이 하나라도 붙었으면 같은 채널·같은 형식의 앞뒤 편도 (EP.2만 붙고 EP.1이 빠지는 일 방지)
    const seriesKey = (v: Video) => { const m = v.title.match(/^(.*?)\bEP\.?\s*\d+/i); return m ? `${v.channel}|${sq(m[1]).slice(0, 40)}|${sq(v.title.replace(/^.*?\bEP\.?\s*\d+/i, '')).length > 0 ? 'named' : ''}` : null; };
    const seriesKeys = new Set(vids.map(seriesKey).filter(Boolean));
    const siblings = videos.filter((v) => {
      const k = seriesKey(v);
      if (!k || !seriesKeys.has(k) || vids.includes(v)) return false;
      return vids.some((x) => seriesKey(x) === k && Math.abs(Date.parse(x.publishedAt) - Date.parse(v.publishedAt)) < 21 * 864e5);
    });
    vids.push(...siblings);
    vids.sort((a, b) => a.publishedAt.localeCompare(b.publishedAt));
    // 트레일러: 기사·공지의 "트레일러/티저 공개" 일정에 연결된 영상과 같은 시리즈
    const trailerIds = new Set(events.filter((e) => /트레일러|trailer|티저|teaser/i.test(`${e.title} ${e.step}`)).flatMap((e) => e.sources.map((s) => s.url.match(/(?:v=|youtu\.be\/)([\w-]{11})/)?.[1]).filter(Boolean) as string[]));
    const trailerSeries = new Set(vids.filter((v) => trailerIds.has(v.videoId)).map(seriesKey).filter(Boolean));
    const isTrailer = (v: Video) => trailerIds.has(v.videoId) || (seriesKey(v) !== null && trailerSeries.has(seriesKey(v)));
    const ownVids = vids.filter((v) => OWN.has(v.channel) && !/react|reaction|리액션/i.test(v.title));
    const isOfficial = (v: Video) => isTrailer(v) || OFFICIAL_KINDS.includes(videoKind(v));
    const official = ownVids.filter(isOfficial);
    const isShort = (v: Video) => SHORT_KINDS.includes(videoKind(v));
    const shorts = ownVids.filter((v) => !isOfficial(v) && isShort(v));
    const own = ownVids.filter((v) => !isOfficial(v) && !isShort(v));
    const isBroadcaster = (ch: string) => BROADCASTERS.has(ch);
    const allStage = vids.filter((v) => isBroadcaster(v.channel) && STAGE_RE.test(v.title) && !STAGE_MIX_RE.test(v.title) && !/🔴|라이브\]|LIVE\s*[|ㅣ]/i.test(v.title));
    const fancamVids = allStage.filter((v) => FANCAM_RE.test(v.title));
    const stageVids = allStage.filter((v) => !FANCAM_RE.test(v.title));
    const byMember = new Map<string, EraVideo[]>();
    for (const v of fancamVids) { const m = fancamOwner(v.title); byMember.set(m, [...(byMember.get(m) ?? []), toVid(v)]); }
    const fancams = ['단체', ...GROUP.members.map((m) => m.name)].filter((m) => byMember.has(m)).map((member) => ({ member, videos: byMember.get(member)! }));
    const byProg = new Map<string, EraVideo[]>();
    for (const v of stageVids) {
      const p = programName(v.title) ?? v.channel;
      byProg.set(p, [...(byProg.get(p) ?? []), toVid(v)]);
    }
    const actEvents = act.eventIds.map((id) => byId.get(id)!).filter(Boolean).sort((a, b) => `${a.date} ${a.time ?? ''}`.localeCompare(`${b.date} ${b.time ?? ''}`));

    // 관련 영상 (컴백이 아닌 활동): 다른 채널 영상 중 팬 영상이 아니고 방송사·큰 채널인 것
    const relatedGroup = (t: string) => (/\bOST\b/i.test(t) ? 'OST' : /예고|선공개|티저|teaser|trailer|하이라이트|highlight|\d+\s*[회화]|\bEP\.?\s*\d+|클립|clip|메이킹|making|비하인드/i.test(t) ? '예고·클립' : PRESS_COVERAGE_RE.test(t) || /제작\s*발표|쇼케이스|인터뷰|interview/i.test(t) ? '현장·인터뷰' : '기타');
    const related = act.kind === '컴백' ? [] : vids
      .filter((v) => !AGENCY.has(v.channel) && !isFanMade(v.title) && (BROADCASTERS.has(v.channel) || v.guest || (v.channelSubscribers ?? 0) >= 100_000))
      .map((v) => ({ ...toVid(v), group: relatedGroup(v.title) }))
      .reverse();
    // 활동 기간 중 외부 출연 (컴백만): 다른 활동으로 묶인 것(드라마·고정 예능)은 빼고, 주인 멤버가 나오는 것만
    // 지난 활동은 일정이 없으니, 검색으로 찾은 다른 채널 출연 영상(무대·공식 채널 제외)을 출연 목록에
    // 출연 영상만: 노래방·커버·안무 재업로드·가사·리액션 등(isAppearance), 다른 채널의 뮤비·티저 재업로드, 무대·직캠은 뺀다
    const guestVids = act.kind !== '컴백' ? [] : vids.filter((v) => !AGENCY.has(v.channel) && !isBroadcaster(v.channel) && v.guest
      && isAppearance(v.title, v.description ?? '') && !STAGE_CLIP_RE.test(v.title) && !/\bM\/?V\b|뮤직비디오|뮤비|teaser|티저/i.test(v.title));
    // 출연 칸은 "출연 하나 = 한 줄": 같은 채널·3일 안의 영상(본편·쇼츠·예고)은 한 줄로 묶고, 대표는 본 영상(쇼츠·예고가 아닌 가장 긴 것)
    const vidById = new Map(videos.map((v) => [v.videoId, v]));
    const idOf = (u = '') => u.match(/(?:v=|youtu\.be\/|shorts\/|live\/)([\w-]{11})/)?.[1];
    const near = (a: string, b: string) => Math.abs(Date.parse(a) - Date.parse(b)) <= 3 * 864e5;
    const pickMain = (list: Video[]) => [...list].sort((a, b) => Number(isTeaserVid(a)) - Number(isTeaserVid(b)) || Number(isShortVid(a)) - Number(isShortVid(b)) || (b.duration ?? 0) - (a.duration ?? 0))[0];
    const outsideEvents = act.kind !== '컴백' ? [] : events
      .filter((e) => e.date >= act.from && e.date <= act.to && !claimed.has(e.id) && (e.tags ?? []).includes('type:외부 출연')
        && !new RegExp(`${GROUP.name}\\s*(공식\\s*)?(유튜브\\s*)?채널`, 'i').test(e.title)
        && (act.owner.scope === '단체' || e.members.some((m) => act.owner.members.includes(m))));
    const used = new Set<string>();
    const outside = outsideEvents.map((e) => {
      // 일정 출처 영상 + 같은 채널·가까운 날짜의 출연 영상을 모아 대표를 고른다
      const own = e.sources.map((s) => vidById.get(idOf(s.url) ?? '')).filter((v): v is Video => Boolean(v));
      const channels = new Set(own.map((v) => v.channel));
      const extra = guestVids.filter((v) => channels.has(v.channel) && near(kstDate(v.publishedAt), e.date));
      const all = [...new Map([...own, ...extra].map((v) => [v.videoId, v])).values()];
      for (const v of all) used.add(v.videoId);
      const main = all.length ? pickMain(all) : undefined;
      const url = main?.url ?? e.sources.find((s) => /youtu/.test(s.url))?.url ?? e.sources[0]?.url;
      const id = main?.videoId ?? idOf(url);
      return { date: e.date, title: e.title.replace(/^유튜브\s+/, ''), sub: e.step, members: e.members, url, thumb: id ? `https://i.ytimg.com/vi/${id}/mqdefault.jpg` : undefined };
    });
    // 일정이 없는 출연(지난 활동): 채널·3일 묶음마다 한 줄, 쇼츠·예고만 있는 묶음은 뺀다
    const groups: Video[][] = [];
    for (const v of guestVids.filter((x) => !used.has(x.videoId)).sort((a, b) => a.publishedAt.localeCompare(b.publishedAt))) {
      const g = groups.find((l) => l[0].channel === v.channel && near(kstDate(l[0].publishedAt), kstDate(v.publishedAt)));
      if (g) g.push(v); else groups.push([v]);
    }
    const outsideFromVideos = groups.map(pickMain).filter((v) => !isShortVid(v) && !isTeaserVid(v))
      .map((v) => ({ date: originalAirDate(v) ?? kstDate(v.publishedAt), title: v.channel, sub: v.title.slice(0, 60), members: v.who.members, url: v.url, thumb: `https://i.ytimg.com/vi/${v.videoId}/mqdefault.jpg` }));

    // 타임라인
    const text = (e: PublicEvent) => `${e.title} ${e.step}`;
    const first = (pred: (e: PublicEvent) => boolean) => actEvents.find(pred);
    const marks: { date: string; label: string; sub: string }[] = [];
    const push = (e: PublicEvent | undefined, label: string, sub?: string) => { if (e && !marks.some((m) => m.label === label)) marks.push({ date: e.date, label, sub: (sub ?? e.step).slice(0, 30) }); };
    if (act.kind === '컴백') {
      const teaserVid = official.find((v) => /teaser|티저|trailer|트레일러/i.test(v.title));
      const teaserEv = events.find((e) => inRange(e.date) && e.kind === '발매' && /티저|teaser|트레일러|trailer/i.test(text(e)) && hasKey(text(e)));
      const tDates = [teaserVid && kstDate(teaserVid.publishedAt), teaserEv?.date].filter(Boolean).sort() as string[];
      if (tDates[0]) marks.push({ date: tDates[0], label: '첫 티저', sub: teaserEv?.date === tDates[0] ? teaserEv.step : teaserVid!.title.slice(0, 30) });
      const rel = cfg?.release ?? events.find((e) => e.kind === '발매' && inRange(e.date) && hasKey(text(e)) && /발매|음원|앨범|정규|미니/.test(text(e)) && !/티저|teaser|트레일러|preview|특전/i.test(text(e)))?.date;
      if (rel) marks.push({ date: rel, label: '발매', sub: cfg?.titleSong ? `타이틀곡 ${cfg.titleSong}` : '앨범 발매' });
      push(first((e) => /쇼케이스|showcase|harvest/i.test(text(e))), '쇼케이스', undefined);
      push(first((e) => Boolean(programName(e.title)) && (e.kind === '방송' || e.kind === '녹화')), '음방', '음악방송 활동');
      push(first((e) => /사인회|video\s*call|영상\s*통화/i.test(text(e))), '팬사인회');
    } else {
      push(first((e) => e.kind === '판매' || /예매|티켓/.test(text(e))), '예매');
      for (const e of actEvents.filter((x) => x.kind === '행사' || x.kind === '방송' || x.kind === '발매')) {
        if (marks.length >= 7) break;
        if (!marks.some((m) => m.date === e.date)) marks.push({ date: e.date, label: e.kind === '방송' ? (e.episode ? `${e.episode}회` : '방송') : e.kind === '발매' ? '공개' : '공연', sub: e.title.slice(0, 30) });
      }
    }
    marks.sort((a, b) => a.date.localeCompare(b.date));

    // 표지 썸네일 고르기
    const pickThumb = (): string | undefined => {
      const mv = official.find((v) => /M\/?V\b|뮤직비디오/i.test(v.title) && !/teaser|티저|behind|비하인드|reaction/i.test(v.title));
      const notTeaser = (v: Video) => !/예고|티저|teaser|trailer|트레일러|선공개|preview/i.test(v.title);
      const stage = [...official, ...own].find((v) => /vcr|opening|오프닝|concert|콘서트|live\b|stage|무대|공연|highlight/i.test(v.title) && notTeaser(v));
      const anyOfficial = official.find((v) => !/behind|비하인드/i.test(v.title) && notTeaser(v)) ?? official.find((v) => !/behind|비하인드/i.test(v.title)) ?? official[0];
      const other = vids.find((v) => !/react|리액션|shorts/i.test(v.title));
      // 예고·티저는 다른 영상이 하나도 없을 때만 표지로
      const firstReal = [...official, ...own].find((x) => notTeaser(x) && !/behind|비하인드/i.test(x.title));
      const v = act.kind === '컴백' ? (mv ?? anyOfficial ?? stage ?? other) : (stage ?? firstReal ?? anyOfficial ?? own[0] ?? other);
      return v ? `https://i.ytimg.com/vi/${v.videoId}/mqdefault.jpg` : undefined;
    };
    pages.push({
      thumb: pickThumb(),
      id: act.id, kind: act.kind, title: cfg?.title ?? act.name, subtitle: cfg?.subtitle ?? act.subtitle, titleSong: cfg?.titleSong, release: cfg?.release,
      owner: act.owner, keys: act.keys, parts: act.parts, from: act.from, to: act.to,
      cover: cfg?.cover ?? KIND_COVER[act.kind] ?? { from: '#cccccc', to: '#1a1a1a', text: '#ffffff' },
      status: today < act.from ? '예정' : today > act.to ? '종료' : '활동 중',
      counts: { official: official.length, stages: stageVids.length, fancams: fancamVids.length, own: own.length, shorts: shorts.length, outside: outside.length, events: actEvents.length },
      shorts: shorts.map((v) => ({ ...toVid(v), group: videoKind(v) === '챌린지' ? ('챌린지' as const) : ('멤버 쇼츠' as const) })).reverse(),
      timeline: marks,
      schedule: actEvents.filter((e) => e.audience === 'all').map((e) => ({ date: e.date, time: e.time, endDate: e.endDate, title: e.title, step: e.step, kind: e.kind, url: e.sources[0]?.url, group: scheduleGroupOf(e, act.parts) })),
      guide: (() => {
        const live = today >= act.from && today <= act.to;
        const until = live ? [act.to, new Date(Date.parse(today) + 14 * 864e5).toISOString().slice(0, 10)].sort()[1] : act.to;
        const loose = act.kind !== '컴백' ? [] : events.filter((e) => !assigned.has(e.id) && e.date >= act.from && e.date <= until
          && (programName(e.title) || /사전\s*녹화|사전\s*투표|음악\s*방송/.test(`${e.title} ${e.step}`))
          && (act.owner.scope === '단체' ? e.scope === '단체' : e.members.some((m) => act.owner.members.includes(m))));
        return [...actEvents, ...loose].map(guideOf).filter((g): g is GuideItem => g !== null)
          .sort((a, b) => `${a.due} ${a.dueTime ?? '99'}`.localeCompare(`${b.due} ${b.dueTime ?? '99'}`));
      })(),
      ownGroups: OWN_ORDER.filter((g) => own.some((v) => ownGroupOf(v.title, v.duration) === g)),
      stages: [...byProg.entries()].map(([program, videos]) => ({ program, videos })),
      fancams,
      related,
      own: own.map((v) => ({ ...toVid(v), group: ownGroupOf(v.title, v.duration) })).reverse(),
      official: official.map((v) => ({ ...toVid(v), group: isTrailer(v) ? 'MV·티저' : videoKind(v) })).reverse(),
      outside: [...outside, ...outsideFromVideos].sort((a, b) => b.date.localeCompare(a.date)),
      news: articlesFor(act.keys, act.from, act.to),
    });
  }
  return pages;
}

/** 사이트 설정: 그룹 이름(표기 변형), 멤버, 음방 줄임말, 활동 이름·키워드 */
export function siteConfig() {
  const programs = JSON.parse(readFileSync(join(ROOT, 'config', 'programs.json'), 'utf8')).programs as { names: string[]; short?: string }[];
  return {
    group: { id: GROUP.id, name: GROUP.name, nameVariants: GROUP.nameVariants, parentNames: GROUP.parentNames },
    members: GROUP.members.map((m) => ({ name: m.name, slug: m.slug })),
    programs: programs.map((p) => ({ names: p.names, short: p.short ?? p.names[0] })),
    eras: CONFIG.eras.map((e) => ({ id: e.id, title: e.title ?? e.name, keywords: e.keywords, titleSong: e.titleSong })),
  };
}
