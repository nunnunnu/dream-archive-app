/**
 * 유튜브 영상 수집 (채널 RSS, 키 없이 무료)
 * 채널 RSS는 채널마다 최근 15개만 주므로 자주 돌려서 쌓는다. 과거 영상 채우기는 YouTube Data API(키 필요)가 있어야 한다.
 */
import './env.ts';
import { coreNames } from './consolidate.ts';
import { GROUP } from './group.ts';
import { decodeEntities } from './googleNews.ts';
import { isHidden, mentionedMembers, type Who } from './members.ts';
import { isDreamRelated } from './news.ts';
import { readJson, writeJson } from './store.ts';
import { sleep, toKstParts } from './time.ts';

export interface Channel {
  id: string;
  name: string;
  /** true면 NCT DREAM 관련 제목만 가져온다 (음악방송 등 여러 가수가 올라오는 채널) */
  filter: boolean;
  /** true면 방송사·제작사 채널: 영상이 출연 콘텐츠일 수 있어 AI가 해석한다 (소속사·공식 채널은 false) */
  guest?: boolean;
}

export const YOUTUBE_CHANNELS: Channel[] = GROUP.youtube.channels;

export interface Video {
  videoId: string;
  title: string;
  url: string;
  channel: string;
  publishedAt: string;
  firstSeenAt: string;
  who: Who;
  /** 출연 탐색으로 찾은 다른 채널의 출연 영상이면 true (일정으로도 쓴다) */
  guest?: boolean;
  /** 채널 구독자 수 (출연 탐색일 때) */
  channelSubscribers?: number;
  /** 영상 설명 (출연 탐색 영상을 AI가 해석할 때 씀) */
  description?: string;
  /** 댄스 챌린지 검색으로 찾은 다른 채널 영상 (출연 영상으로 쓰지 않음) */
  challengeSearch?: boolean;
  /** 프리미어·예약 공개 전이면 true (publishedAt은 공개 예정 시각) */
  upcoming?: boolean;
  /** 비공개·삭제되어 더 볼 수 없는 영상 (확인한 시각). 사이트·활동·질문 자료에서 뺀다 */
  unavailableAt?: string;
  /** 영상 길이(초). 쇼츠 판별에 쓴다 */
  duration?: number;
}

/** ISO 8601 길이 (PT1H2M3S) → 초 */
export const parseDuration = (iso: string) => {
  const m = iso.match(/P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  return m ? Number(m[1] ?? 0) * 86400 + Number(m[2] ?? 0) * 3600 + Number(m[3] ?? 0) * 60 + Number(m[4] ?? 0) : undefined;
};

/** 저장된 영상 중 길이를 모르는 것 채우기 (50개당 할당량 1) */
export async function fillDurations(filter: (v: Video) => boolean = () => true): Promise<number> {
  if (!process.env.YOUTUBE_API_KEY) return 0;
  const { readdir } = await import('node:fs/promises');
  const { DATA_DIR } = await import('./store.ts');
  let filled = 0;
  for (const f of (await readdir(`${DATA_DIR}/state/youtube`)).filter((x) => /^20\d\d-\d\d\.json$/.test(x))) {
    const file = `state/youtube/${f}`;
    const stored = await readJson<Record<string, Video>>(file, {});
    const need = Object.values(stored).filter((v) => v.duration === undefined && filter(v));
    for (let i = 0; i < need.length; i += 50) {
      const batch = need.slice(i, i + 50);
      const d = await ytGet<{ items: { id: string; contentDetails: { duration: string } }[] }>('videos', { part: 'contentDetails', id: batch.map((v) => v.videoId).join(',') });
      for (const it of d.items) if (stored[it.id]) { stored[it.id].duration = parseDuration(it.contentDetails.duration); filled++; }
    }
    if (need.length) await writeJson(file, stored);
  }
  return filled;
}

function tag(xml: string, name: string): string {
  const m = xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`));
  return m ? decodeEntities(m[1]).trim() : '';
}

/** 영상 제목으로 멤버·단체 판단. 공식 채널에서 멤버 이름이 없으면 단체 */
function whoOfVideo(title: string): Who {
  const { members, unit } = mentionedMembers(title);
  if (members.length === 0 || members.length >= 5) return { scope: '단체', members: [], label: '단체' };
  if (unit) return { scope: '유닛', members, label: `${members.join('·')} (${unit})` };
  return { scope: '멤버', members, label: members.join('·') };
}

type RawVideo = Omit<Video, 'firstSeenAt'>;

const toVideo = (channel: Channel, videoId: string, title: string, publishedAt: string): RawVideo => ({
  videoId,
  title,
  url: `https://www.youtube.com/watch?v=${videoId}`,
  channel: channel.name,
  publishedAt: new Date(publishedAt).toISOString(),
  who: whoOfVideo(title),
});

/** 채널 RSS (키 없음, 최근 15개) */
async function fetchViaRss(channel: Channel): Promise<RawVideo[]> {
  const res = await fetch(`https://www.youtube.com/feeds/videos.xml?channel_id=${channel.id}`);
  if (!res.ok) throw new Error(`YouTube RSS ${res.status}`);
  const xml = await res.text();
  return [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map(([, e]) => toVideo(channel, tag(e, 'yt:videoId'), tag(e, 'title'), tag(e, 'published')));
}

/**
 * 공식 YouTube Data API (키 필요). 채널의 업로드 재생목록(UC… → UU…)을 읽는다.
 * pages를 늘리면 과거 영상도 채울 수 있다 (한 페이지 50개).
 */
async function fetchViaApi(channel: Channel, apiKey: string, pages = 1): Promise<RawVideo[]> {
  const out: RawVideo[] = [];
  let pageToken = '';
  for (let i = 0; i < pages; i++) {
    const params = new URLSearchParams({ part: 'snippet', playlistId: `UU${channel.id.slice(2)}`, maxResults: '50', key: apiKey });
    if (pageToken) params.set('pageToken', pageToken);
    const res = await fetch(`https://www.googleapis.com/youtube/v3/playlistItems?${params}`);
    if (!res.ok) throw new Error(`YouTube Data API ${res.status}`);
    const data = (await res.json()) as {
      nextPageToken?: string;
      items: { snippet: { title: string; description?: string; publishedAt: string; resourceId: { videoId: string } } }[];
    };
    for (const it of data.items) out.push({ ...toVideo(channel, it.snippet.resourceId.videoId, it.snippet.title, it.snippet.publishedAt), description: it.snippet.description });
    if (!data.nextPageToken) break;
    pageToken = data.nextPageToken;
  }
  return out;
}

/** 키가 있으면 공식 API, 없으면 RSS */
export async function fetchChannel(channel: Channel, pages = 1): Promise<RawVideo[]> {
  const apiKey = process.env.YOUTUBE_API_KEY;
  const list = apiKey ? await fetchViaApi(channel, apiKey, pages) : await fetchViaRss(channel);
  // 여러 그룹이 올라오는 채널(NCT·NCT DAILY·SMTOWN 등)은 제목이나 설명(유닛 해시태그 #NCTDREAM 등)에 드림·멤버가 있는 것만
  return list.filter((v) => v.videoId && !isHidden(v.title) && (!channel.filter || isDreamRelated(`${v.title}\n${v.description ?? ''}`)));
}

const monthFile = (iso: string) => {
  const p = toKstParts(new Date(iso));
  return `state/youtube/${p.year}-${String(p.month).padStart(2, '0')}.json`;
};

/** 공식 채널(소속사·그룹) 이름: 여기 영상은 어떤 경로로 들어와도 출연 후보가 아니다 */
const OFFICIAL_NAMES = new Set(YOUTUBE_CHANNELS.filter((c) => !c.guest).map((c) => c.name));

export async function storeVideos(list: Video[]): Promise<Video[]> {
  list = list.map((v) => (OFFICIAL_NAMES.has(v.channel) && v.guest ? { ...v, guest: false } : v));
  const byFile = new Map<string, Video[]>();
  for (const v of list) byFile.set(monthFile(v.publishedAt), [...(byFile.get(monthFile(v.publishedAt)) ?? []), v]);
  const added: Video[] = [];
  for (const [file, vids] of byFile) {
    const stored = await readJson<Record<string, Video>>(file, {});
    for (const v of vids) {
      if (stored[v.videoId]) {
        // 제목이 바뀌는 경우(프리미어 → 공개 등) 갱신
        if (stored[v.videoId].title !== v.title) stored[v.videoId] = { ...stored[v.videoId], title: v.title, who: v.who };
        // 예전에 구독자 수 없이 저장된 영상은 이번에 확인한 구독자 수·후보 판정으로 갱신
        if (stored[v.videoId].channelSubscribers == null && v.channelSubscribers != null) {
          stored[v.videoId] = { ...stored[v.videoId], channelSubscribers: v.channelSubscribers, guest: v.guest };
        }
        // 다른 검색에서 "출연 아님"으로 저장됐어도, 확인된 일정으로 다시 찾아 후보가 되면 올린다 (내리지는 않음)
        if (!stored[v.videoId].guest && v.guest) {
          stored[v.videoId] = { ...stored[v.videoId], guest: true, description: v.description ?? stored[v.videoId].description };
          added.push(stored[v.videoId]);
        }
        continue;
      }
      stored[v.videoId] = v;
      added.push(v);
    }
    await writeJson(file, Object.fromEntries(Object.entries(stored).sort(([, a], [, b]) => b.publishedAt.localeCompare(a.publishedAt))));
  }
  return added;
}

/** 정해 둔 채널의 새 영상 */
export async function collectVideos(now: Date, pages = 1): Promise<{ added: Video[]; failed: string[] }> {
  const nowIso = now.toISOString();
  const list: Video[] = [];
  const failed: string[] = [];
  for (const ch of YOUTUBE_CHANNELS) {
    try {
      for (const v of await fetchChannel(ch, pages)) list.push({ ...v, firstSeenAt: nowIso, guest: isChannelGuest(ch, v.title) });
    } catch (err) {
      failed.push(`${ch.name}: ${(err as Error).message}`);
    }
    await sleep(500);
  }
  return { added: await storeVideos(list), failed };
}

/**
 * 빈칸 채우기용 유튜브 검색 (공식 API 키 필요). 어느 채널이든 제목에 대상 이름이 있는 영상만 받는다.
 * 예: "가짜 김효연" → 효연 채널의 NCT DREAM 출연 영상과 공개 시각
 */
export async function searchVideos(focus: string, publishedAfter: Date, now: Date): Promise<Video[]> {
  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey) return [];
  // 대상의 핵심 이름으로 검색하고, 제목에 그 이름이 있는 영상만 받는다 ("'전과자' (ootb STUDIO 공식 유튜브 채널)" → "전과자")
  const names = coreNames(focus);
  if (!names.length) return [];
  const params = new URLSearchParams({
    part: 'snippet', type: 'video', order: 'date', maxResults: '15', q: names.slice(0, 2).join(' '),
    publishedAfter: publishedAfter.toISOString(), regionCode: 'KR', key: apiKey,
  });
  const res = await fetch(`https://www.googleapis.com/youtube/v3/search?${params}`);
  if (!res.ok) throw new Error(`YouTube 검색 ${res.status}`);
  const data = (await res.json()) as { items: { id: { videoId: string }; snippet: { title: string; description: string; channelId: string; channelTitle: string; publishedAt: string } }[] };
  const nowIso = now.toISOString();
  const norm = (t: string) => t.replace(/[^\p{L}\p{N}]+/gu, '').toLowerCase();
  const subs = await channelSubscribers(data.items.map((it) => it.snippet.channelId));
  if (data.items.length) {
    const full = await ytGet<{ items: { id: string; snippet: { description: string } }[] }>('videos', { part: 'snippet', id: data.items.map((it) => it.id.videoId).join(',') });
    const desc = new Map(full.items.map((x) => [x.id, x.snippet.description]));
    for (const it of data.items) it.snippet.description = desc.get(it.id.videoId) ?? it.snippet.description;
  }
  const list = data.items
    .map((it) => {
      const title = decodeEntities(it.snippet.title);
      const description = decodeEntities(it.snippet.description);
      const sub = subs.get(it.snippet.channelId) ?? 0;
      return {
        ...toVideo({ id: it.snippet.channelId, name: it.snippet.channelTitle, filter: false }, it.id.videoId, title, it.snippet.publishedAt),
        firstSeenAt: nowIso, description, channelSubscribers: sub,
        // 이미 확인된 일정의 프로그램 이름으로 찾은 영상은 구독자 수와 상관없이 후보 (예: 술 빚는 윤주모 3만).
        // 이름이 제목·채널에 있어야 하고, 팬 채널·팬 영상·무대 영상은 뺀다
        guest: !OWN_CHANNELS.has(it.snippet.channelId) && (isOutsideCandidate(title, description, sub, it.snippet.channelTitle)
          || (names.some((n) => norm(`${title} ${it.snippet.channelTitle}`).includes(n)) && !FAN_CHANNEL_RE.test(it.snippet.channelTitle) && isAppearance(title, description) && !STAGE_RE.test(title))),
      };
    })
    .filter((v) => !isHidden(v.title) && isDreamRelated(`${v.title} ${v.description}`) && names.some((n) => norm(`${v.title} ${v.description}`).includes(n)));
  return storeVideos(list);
}

/** 최근 N개월치 영상 */
export async function loadRecentVideos(now: Date, months = 3): Promise<Video[]> {
  const out: Video[] = [];
  const p = toKstParts(now);
  for (let i = 0; i < months; i++) {
    let y = p.year;
    let m = p.month - i;
    while (m < 1) { m += 12; y -= 1; }
    out.push(...Object.values(await readJson<Record<string, Video>>(`state/youtube/${y}-${String(m).padStart(2, '0')}.json`, {})));
  }
  return out.filter((v) => !isHidden(v.title) && !v.unavailableAt).sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
}

// ── 출연 탐색: 다른 채널(예능·웹예능·라디오 등)에 나온 영상 찾기 ──────────────

/** 리액션·가사·플레이리스트·팬 편집 등 출연 영상이 아닌 것 */
const NOT_APPEARANCE_RE = /(thai|indo|viet|kurdish|spanish|arabic|turkish|russian|português|español)\s*-?\s*sub|subtitulado|legendado|react|reaction|리액션|first\s*time\s*(watching|listening|hearing)|watching\s+(nct|their)|reacting|playlist|플레이리스트|노래\s*모음|lyrics|가사|easy\s*lyrics|fancam|직캠\s*모음|교차편집|stage\s*mix|compilation|tiktok|틱톡|노래방|karaoke|\bKY\.\d|dance\s*practice|안무\s*(연습|거울)|mirror(ed)?|tutorial|dance\s*cover|커버\s*댄스|\bcover\b|커버|kpop\s*in\s*public|line\s*distribution|color\s*coded|歌詞|字幕|traducida|piano|피아노|unboxing|언박싱|mashup|매시업|댓글\s*모음|\bstudy\b|review|리뷰|breakdown|analysis|special\s*edit|플리(?![가-힣])|\(\s*[^()]*\bver\.?\s*\)|gave\s+me\b/i;
/** 언론사 취재 영상(제작발표회·현장·포토타임 등)은 출연이 아니라 소식이다 → 일정으로 만들지 않는다 */
export const PRESS_COVERAGE_RE = /제작발표회|쇼케이스\s*현장|기자간담회|포토\s*타임|포토월|출국|입국|공항|\[풀영상\]|\[현장\]|\[4K\]|직캠/i;
/** 원래 방송 날짜 표기: "MBC 190731 방송", "2019.07.31 방송" */
const BROADCAST_DATE_RE = /(?<!\d)(\d{2})(\d{2})(\d{2})\s*(?:방송|방영|on\s*air)|(\d{4})[.\-/]\s*(\d{1,2})[.\-/]\s*(\d{1,2})\.?\s*(?:방송|방영)/i;

/**
 * 지난 방송을 다시 올린 영상(하이라이트·다시보기)인지: 제목·설명의 원래 방송 날짜가 영상 공개보다 일주일 넘게 앞서면 지금 일정이 아니다.
 * 예: "[하이라이트] NCT DREAM 붐은 왔다 … | MBC 190731 방송" (2026-11-09 공개) → 2019년 방송
 */
/** 지난 방송을 다시 올린 영상이면 원래 방송 날짜(YYYY-MM-DD), 아니면 null */
export function originalAirDate(v: { title: string; description?: string; publishedAt: string }): string | null {
  if (!isArchiveClip(v.title, v.description ?? '', v.publishedAt)) return null;
  const m = `${v.title}\n${v.description ?? ''}`.match(BROADCAST_DATE_RE)!;
  const [y, mo, d] = m[1] ? [2000 + Number(m[1]), Number(m[2]), Number(m[3])] : [Number(m[4]), Number(m[5]), Number(m[6])];
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

export function isArchiveClip(title: string, description: string, publishedAt: string): boolean {
  const m = `${title}\n${description}`.match(BROADCAST_DATE_RE);
  if (!m) return false;
  const [y, mo, d] = m[1] ? [2000 + Number(m[1]), Number(m[2]), Number(m[3])] : [Number(m[4]), Number(m[5]), Number(m[6])];
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return false;
  return Date.parse(publishedAt) - Date.UTC(y, mo - 1, d) > 7 * 24 * 3600 * 1000;
}

/** 음악방송 무대·직캠·교차편집: 방송 일정의 영상 링크로만 쓰고 따로 일정으로 만들지 않는다 */
export const STAGE_RE = /직캠|fancam|full\s*cam|교차편집|stage\s*mix|무대|\bstage\b|뮤직뱅크|music\s*bank|음악중심|music\s*core|인기가요|inkigayo|엠카운트다운|m\s*countdown|더\s*쇼|the\s*show|쇼\s*챔피언|show\s*champion|세로\s*캠|vertical/i;

/** 등록 채널 영상이 출연 후보인지: 우리 그룹 공식 채널(filter 없음)은 소식, 방송사·제작사 채널은 무대 영상만 빼고 후보 */
export const isChannelGuest = (channel: Channel, title: string) => Boolean(channel.guest) && isAppearance(title, '') && !STAGE_RE.test(title);

/** 등록 채널 밖에서 찾은 영상은 한글 제목·설명이 있어야 후보 (해외 뉴스 채널의 보도 영상 제외) */
const HANGUL_RE = /[가-힣]/;
export const isOutsideCandidate = (title: string, description: string, subs: number, channelName = '') =>
  (subs >= MIN_SUBSCRIBERS || isSmallShowChannel(title, subs, channelName)) && HANGUL_RE.test(`${title} ${description}`) && isAppearance(title, description) && !STAGE_RE.test(title) && !/\bPL\]|special\s*pl|플리(?![가-힣])|플레이리스트/i.test(title);

/**
 * 구독자 10만 미만이어도 출연 후보로 보는 작은 예능 채널 (예: "술 빚는 윤주모" 3만): 구독자 1만 이상,
 * 채널 이름에 그룹·멤버·팬덤 이름이 없고(팬 채널 제외), 제목에 그룹이나 멤버가 나올 때
 */
const escRe = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const FAN_CHANNEL_RE = new RegExp([...GROUP.nameVariants, ...GROUP.fandom, ...GROUP.nicknames, ...GROUP.members.flatMap((m) => m.aliases)]
  .map((n) => escRe(n).replace(/\s+/g, '\\s*')).join('|'), 'i');
const MIN_SMALL_SUBSCRIBERS = Number(process.env.YOUTUBE_MIN_SMALL_SUBSCRIBERS ?? 10_000);
/** 채널 자체 프로그램이라는 표시: 회차·출연·게스트 표기, 또는 채널 이름 해시태그(#술빚는윤주모) */
const squashName = (t: string) => t.normalize('NFKC').replace(/[^\p{L}\p{N}]+/gu, '').toLowerCase();
const ownShowSignal = (title: string, channelName: string) => {
  if (/\bEP\.?\s*\d+|에피소드|\d+\s*화\b|출연|게스트|\bguest\b|\bwith\s/i.test(title)) return true;
  const ch = squashName(channelName);
  return [...title.matchAll(/#([^\s#]+)/g)].map((m) => squashName(m[1])).some((h) => h.length >= 3 && ch.includes(h) && h.length / ch.length >= 0.6);
};
export const isSmallShowChannel = (title: string, subs: number, channelName: string) =>
  subs >= MIN_SMALL_SUBSCRIBERS && channelName !== '' && !FAN_CHANNEL_RE.test(channelName)
  && (isDreamRelated(title) || mentionedMembers(title).members.length >= 2) && ownShowSignal(title, channelName);

/** 채널 구독자 수 (모듈 안에서 한 번 실행 동안 기억) */
const subsCache = new Map<string, number>();
async function channelSubscribers(ids: string[]): Promise<Map<string, number>> {
  const need = [...new Set(ids)].filter((id) => id && !subsCache.has(id));
  for (let i = 0; i < need.length; i += 50) {
    const d = await ytGet<{ items: { id: string; statistics: { subscriberCount?: string } }[] }>('channels', { part: 'statistics', id: need.slice(i, i + 50).join(',') });
    for (const c of d.items) subsCache.set(c.id, Number(c.statistics.subscriberCount ?? 0));
  }
  return subsCache;
}

/** 공식 채널은 따로 수집하므로 출연 탐색에서 뺀다 */
const OWN_CHANNELS = new Set(YOUTUBE_CHANNELS.map((c) => c.id));
const MIN_SUBSCRIBERS = Number(process.env.YOUTUBE_MIN_SUBSCRIBERS ?? 100_000);
const DISCOVERY_HOURS = 6;

const MEMBER_QUERIES = GROUP.members.map((m) => `${GROUP.parentNames[0]} ${m.name}`);
export const DISCOVERY_QUERIES = [GROUP.nameVariants[0], GROUP.nameVariants[2] ?? GROUP.nameVariants[0], ...MEMBER_QUERIES];

interface SearchItem { id: { videoId: string }; snippet: { title: string; description: string; channelId: string; channelTitle: string; publishedAt: string } }

async function ytGet<T>(path: string, params: Record<string, string>): Promise<T> {
  const res = await fetch(`https://www.googleapis.com/youtube/v3/${path}?${new URLSearchParams({ ...params, key: process.env.YOUTUBE_API_KEY! })}`);
  if (!res.ok) throw new Error(`YouTube ${path} ${res.status}`);
  return (await res.json()) as T;
}

/** 출연 영상인지: NCT DREAM·멤버·팬덤(시즈니) 언급이 제목이나 설명에 있고, 리액션 등이 아님 */
export function isAppearance(title: string, description: string): boolean {
  if (NOT_APPEARANCE_RE.test(title)) return false;
  const text = `${title}\n${description}`;
  // 팬덤 이름(시즈니·NCTzen)은 상위 그룹 전체 팬덤이라 후보 기준으로 쓰지 않는다
  return isDreamRelated(text);
}

/**
 * 6시간마다 그룹·멤버 이름으로 유튜브를 검색해 큰 채널(구독자 10만 이상)의 4분 이상 출연 영상을 찾는다.
 * 검색은 할당량을 많이 쓰므로 간격을 둔다. 채널 구독자 수는 일주일 동안 기억한다.
 */
export async function discoverVideos(repo: { getState<T>(k: string, f: T): Promise<T>; putState(k: string, v: unknown): Promise<void> }, now: Date): Promise<{ added: Video[]; ran: boolean }> {
  if (!process.env.YOUTUBE_API_KEY) return { added: [], ran: false };
  const state = await repo.getState<{ lastRunAt?: string; channels: Record<string, { subs: number; checkedAt: string }> }>('youtube/discovery', { channels: {} });
  if (state.lastRunAt && now.getTime() - Date.parse(state.lastRunAt) < DISCOVERY_HOURS * 3600 * 1000) return { added: [], ran: false };
  const after = new Date((state.lastRunAt ? Date.parse(state.lastRunAt) : now.getTime() - 30 * 24 * 3600 * 1000) - 24 * 3600 * 1000);

  const found = new Map<string, SearchItem['snippet'] & { videoId: string }>();
  for (const q of DISCOVERY_QUERIES) {
    for (const videoDuration of ['medium', 'long']) {
      const d = await ytGet<{ items: SearchItem[] }>('search', {
        part: 'snippet', type: 'video', order: 'relevance', maxResults: '50', q, videoDuration,
        publishedAfter: after.toISOString(), regionCode: 'KR', relevanceLanguage: 'ko',
      });
      for (const it of d.items) if (!OWN_CHANNELS.has(it.snippet.channelId)) found.set(it.id.videoId, { ...it.snippet, videoId: it.id.videoId });
    }
  }

  // 채널 구독자 수 (일주일 지난 것만 다시)
  const week = 7 * 24 * 3600 * 1000;
  const need = [...new Set([...found.values()].map((v) => v.channelId))].filter((id) => !state.channels[id] || now.getTime() - Date.parse(state.channels[id].checkedAt) > week);
  for (let i = 0; i < need.length; i += 50) {
    const d = await ytGet<{ items: { id: string; statistics: { subscriberCount?: string } }[] }>('channels', { part: 'statistics', id: need.slice(i, i + 50).join(',') });
    for (const c of d.items) state.channels[c.id] = { subs: Number(c.statistics.subscriberCount ?? 0), checkedAt: now.toISOString() };
  }

  const nowIso = now.toISOString();
  const list: Video[] = [];
  for (const v of found.values()) {
    const subs = state.channels[v.channelId]?.subs ?? 0;
    const title = decodeEntities(v.title);
    const description = decodeEntities(v.description);
    if (isHidden(title) || !isOutsideCandidate(title, description, subs, v.channelTitle)) continue;
    const base = toVideo({ id: v.channelId, name: v.channelTitle, filter: false }, v.videoId, title, v.publishedAt);
    const who = mentionedMembers(`${title}\n${description}`).members.length ? whoOfVideo(`${title}\n${description}`) : base.who;
    // 출연 콘텐츠인지 행사 취재인지는 AI가 제목·설명을 보고 판단한다
    list.push({ ...base, who, firstSeenAt: nowIso, guest: true, channelSubscribers: subs, description });
  }
  state.lastRunAt = nowIso;
  await repo.putState('youtube/discovery', state);
  return { added: await storeVideos(list), ran: true };
}

/** 출연 탐색 영상의 설명 전문 (검색 결과의 설명은 잘려 있다). 영상 50개당 할당량 1 */
export async function fillVideoDetails(videos: Video[]): Promise<void> {
  if (!process.env.YOUTUBE_API_KEY) return;
  const need = videos.filter((v) => v.guest && (!v.description || v.description.length < 200));
  for (let i = 0; i < need.length; i += 50) {
    const batch = need.slice(i, i + 50);
    const d = await ytGet<{ items: { id: string; snippet: { description: string; publishedAt: string } }[] }>('videos', { part: 'snippet', id: batch.map((v) => v.videoId).join(',') });
    for (const it of d.items) {
      const v = batch.find((x) => x.videoId === it.id);
      if (v) v.description = decodeEntities(it.snippet.description);
    }
  }
  // 월별 파일에 설명 저장
  const byFile = new Map<string, Video[]>();
  for (const v of need) byFile.set(monthFile(v.publishedAt), [...(byFile.get(monthFile(v.publishedAt)) ?? []), v]);
  for (const [file, list] of byFile) {
    const stored = await readJson<Record<string, Video>>(file, {});
    for (const v of list) if (stored[v.videoId]) stored[v.videoId].description = v.description;
    await writeJson(file, stored);
  }
}

/**
 * 최근 영상과 공개 전 영상의 실제 공개 시각을 다시 확인한다 (영상 50개당 할당량 1).
 * 프리미어는 영상 페이지가 먼저 만들어져서 처음 잡힌 시각이 등록 시각이다. 예: 전과자 11/11 21:25 등록 → 11/12 17:59 공개
 */
export async function refreshVideoTimes(now: Date): Promise<string[]> {
  const log: string[] = [];
  if (!process.env.YOUTUBE_API_KEY) return log;
  const recent = (await loadRecentVideos(now, 2)).filter((v) => v.upcoming || now.getTime() - Date.parse(v.publishedAt) < 3 * 24 * 3600 * 1000);
  const updates = new Map<string, Partial<Video>>();
  for (let i = 0; i < recent.length; i += 50) {
    const batch = recent.slice(i, i + 50);
    const d = await ytGet<{ items: { id: string; snippet: { publishedAt: string; liveBroadcastContent: string; description: string }; liveStreamingDetails?: { scheduledStartTime?: string; actualStartTime?: string }; contentDetails?: { duration: string } }[] }>(
      'videos', { part: 'snippet,liveStreamingDetails,contentDetails', id: batch.map((v) => v.videoId).join(',') },
    );
    for (const it of d.items) {
      const v = batch.find((x) => x.videoId === it.id)!;
      const live = it.liveStreamingDetails;
      const upcoming = it.snippet.liveBroadcastContent === 'upcoming';
      const at = new Date(live?.actualStartTime ?? (upcoming ? live?.scheduledStartTime : undefined) ?? it.snippet.publishedAt).toISOString();
      const patch: Partial<Video> = {};
      if (at !== v.publishedAt) patch.publishedAt = at;
      if (Boolean(v.upcoming) !== upcoming) patch.upcoming = upcoming;
      if (v.guest && (!v.description || v.description.length < 200)) patch.description = decodeEntities(it.snippet.description);
      if (v.duration === undefined && it.contentDetails) patch.duration = parseDuration(it.contentDetails.duration);
      if (Object.keys(patch).length) updates.set(v.videoId, patch);
      if (patch.publishedAt) log.push(`영상 공개 시각 갱신: ${v.title.slice(0, 40)} ${new Date(v.publishedAt).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })} → ${new Date(at).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })}${upcoming ? ' (공개 예정)' : ''}`);
    }
  }
  if (!updates.size) return log;
  // 월별 파일에 반영 (공개 달이 바뀌면 파일도 옮긴다)
  const files = new Map<string, Record<string, Video>>();
  const load = async (f: string) => files.get(f) ?? files.set(f, await readJson<Record<string, Video>>(f, {})).get(f)!;
  for (const v of recent) {
    const patch = updates.get(v.videoId);
    if (!patch) continue;
    const from = await load(monthFile(v.publishedAt));
    const next = { ...(from[v.videoId] ?? v), ...patch };
    delete from[v.videoId];
    (await load(monthFile(next.publishedAt)))[v.videoId] = next;
  }
  for (const [f, d] of files) await writeJson(f, Object.fromEntries(Object.entries(d).sort(([, a], [, b]) => b.publishedAt.localeCompare(a.publishedAt))));
  return log;
}

/** 팬이 만든 영상(가사·리액션·커버·노래방·교차편집 등)인지 */
export const isFanMade = (title: string) => NOT_APPEARANCE_RE.test(title);

export interface ActivityQuery { id: string; q: string; from: string; to: string }

/**
 * 진행 중인 드라마처럼 그룹 이름 없이 올라오는 영상(예고·클립·OST·제작발표회)을 활동 이름으로 검색한다.
 * 활동마다 하루 한 번(할당량 약 102). 찾은 영상은 아카이브용으로만 저장한다 (guest 아님 → AI 해석 안 함).
 */
export async function searchActivityVideos(
  repo: { getState<T>(k: string, f: T): Promise<T>; putState(k: string, v: unknown): Promise<void> },
  now: Date,
): Promise<Video[]> {
  if (!process.env.YOUTUBE_API_KEY) return [];
  const queries = await repo.getState<ActivityQuery[]>('youtube/activity-queries', []);
  const last = await repo.getState<Record<string, string>>('youtube/activity-search', {});
  const sqz = (t: string) => t.normalize('NFKC').replace(/[^\p{L}\p{N}]+/gu, '').toLowerCase();
  const added: Video[] = [];
  for (const a of queries) {
    if (last[a.id] && now.getTime() - Date.parse(last[a.id]) < 24 * 3600 * 1000) continue;
    const after = last[a.id] ? new Date(Date.parse(last[a.id]) - 24 * 3600 * 1000) : new Date(Date.parse(a.from) - 30 * 864e5);
    const s = await ytGet<{ items: SearchItem[] }>('search', { part: 'snippet', type: 'video', order: 'date', maxResults: '50', q: a.q, publishedAfter: after.toISOString(), regionCode: 'KR' });
    const ids = s.items.map((x) => x.id.videoId).filter((id) => id);
    if (ids.length) {
      const full = await ytGet<{ items: { id: string; snippet: SearchItem['snippet']; contentDetails: { duration: string } }[] }>('videos', { part: 'snippet,contentDetails', id: ids.join(',') });
      const subs = await channelSubscribers(full.items.map((x) => x.snippet.channelId));
      const list: Video[] = [];
      for (const x of full.items) {
        const title = decodeEntities(x.snippet.title);
        const description = decodeEntities(x.snippet.description);
        const n = subs.get(x.snippet.channelId) ?? 0;
        // 활동 이름이 제목·설명에 있고, 큰 채널(방송사·제작사·언론)이며, 팬 영상이 아닌 것
        if (!sqz(`${title} ${description.slice(0, 500)}`).includes(sqz(a.q)) || n < MIN_SUBSCRIBERS || isFanMade(title) || isHidden(title)) continue;
        const base = toVideo({ id: x.snippet.channelId, name: x.snippet.channelTitle, filter: false }, x.id, title, x.snippet.publishedAt);
        list.push({ ...base, firstSeenAt: now.toISOString(), description, duration: parseDuration(x.contentDetails.duration), channelSubscribers: n });
      }
      added.push(...(await storeVideos(list)));
    }
    last[a.id] = now.toISOString();
    await repo.putState('youtube/activity-search', last);
  }
  return added;
}

/**
 * 저장된 영상이 아직 볼 수 있는지 하루 한 번 확인한다 (50개당 할당량 1).
 * API가 돌려주지 않으면 비공개·삭제 → unavailableAt 표시, 다시 공개되면 지운다. 일부 공개(unlisted)는 링크로 볼 수 있어 그대로 둔다.
 */
export async function checkAvailability(repo: { getState<T>(k: string, f: T): Promise<T>; putState(k: string, v: unknown): Promise<void> }, now: Date, opts: { force?: boolean } = {}): Promise<{ checked: number; gone: Video[]; back: number } | null> {
  if (!process.env.YOUTUBE_API_KEY) return null;
  const state = await repo.getState<{ lastRunAt?: string }>('youtube/availability', {});
  if (!opts.force && state.lastRunAt && now.getTime() - Date.parse(state.lastRunAt) < 24 * 3600 * 1000) return null;
  const { readdir } = await import('node:fs/promises');
  const { DATA_DIR } = await import('./store.ts');
  let checked = 0, back = 0;
  const gone: Video[] = [];
  for (const f of (await readdir(`${DATA_DIR}/state/youtube`)).filter((x) => /^20\d\d-\d\d\.json$/.test(x))) {
    const file = `state/youtube/${f}`;
    const stored = await readJson<Record<string, Video>>(file, {});
    const ids = Object.keys(stored);
    let changed = false;
    for (let i = 0; i < ids.length; i += 50) {
      const batch = ids.slice(i, i + 50);
      const d = await ytGet<{ items: { id: string; status: { privacyStatus: string } }[] }>('videos', { part: 'status', id: batch.join(',') });
      const ok = new Map(d.items.map((it) => [it.id, it.status.privacyStatus]));
      for (const id of batch) {
        const v = stored[id];
        const visible = ok.has(id) && ok.get(id) !== 'private';
        if (!visible && !v.unavailableAt) { v.unavailableAt = now.toISOString(); gone.push(v); changed = true; }
        if (visible && v.unavailableAt) { delete v.unavailableAt; back++; changed = true; }
      }
      checked += batch.length;
    }
    if (changed) await writeJson(file, stored);
  }
  await repo.putState('youtube/availability', { lastRunAt: now.toISOString() });
  return { checked, gone, back };
}

/** 볼 수 없는 영상 ID (일정 출처에서 빼려고) */
export async function unavailableVideoIds(): Promise<Set<string>> {
  const { readdir } = await import('node:fs/promises');
  const { DATA_DIR } = await import('./store.ts');
  const out = new Set<string>();
  for (const f of (await readdir(`${DATA_DIR}/state/youtube`)).filter((x) => /^20\d\d-\d\d\.json$/.test(x))) {
    for (const v of Object.values(await readJson<Record<string, Video>>(`state/youtube/${f}`, {}))) if (v.unavailableAt) out.add(v.videoId);
  }
  return out;
}

/**
 * 영상에 나오는 멤버: 제목 + 설명(해시태그 #CHENLE #JISUNG 등)으로 정한다. 제목에 이름이 없는 자컨(천지의 이것저것 등)도 잡히게.
 * 다섯 명 이상이면 단체 영상이라 멤버 전원.
 */
export function videoMembers(v: { title: string; description?: string; who: Who }): string[] {
  const found = mentionedMembers(`${v.title}\n${(v.description ?? '').slice(0, 800)}`).members;
  if (found.length >= 5 || (found.length === 0 && v.who.scope === '단체')) return GROUP.members.map((m) => m.name);
  return found.length ? found : v.who.members;
}

// ── 댄스 챌린지: 다른 가수 채널에 올라온 챌린지 (#Lucifer #챌린지 with #JENO) ──────────────
/**
 * 멤버별 "○○ challenge" 검색 (처음 한 번 + 이후 하루 한 번 최근 것만). 다른 가수·회사 공식 채널(구독자 10만 이상)만,
 * 팬 채널·팬 영상은 뺀다. 출연 영상(guest)으로 쓰지 않고 챌린지 모아보기에만 쓴다.
 */
export async function searchChallengeVideos(now: Date, publishedAfter?: Date): Promise<Video[]> {
  if (!process.env.YOUTUBE_API_KEY) return [];
  const nowIso = now.toISOString();
  const found: Video[] = [];
  const people = GROUP.members.map((m) => ({ name: m.name, en: m.aliases.find((a) => /^[A-Za-z]+$/.test(a)) ?? m.name, aliases: m.aliases }));
  for (const p of people) {
    const data = await ytGet<{ items: { id: { videoId: string }; snippet: { title: string; channelId: string; channelTitle: string; publishedAt: string } }[] }>('search', {
      part: 'snippet', type: 'video', maxResults: '25', q: `${p.en} challenge`, order: publishedAfter ? 'date' : 'relevance',
      ...(publishedAfter ? { publishedAfter: publishedAfter.toISOString() } : {}),
    }).catch(() => ({ items: [] }));
    const items = data.items.filter((it) => {
      const t = decodeEntities(it.snippet.title);
      return /challenge|챌린지|with\s+#/i.test(t) && new RegExp(p.aliases.join('|'), 'i').test(t) && !OWN_CHANNELS.has(it.snippet.channelId) && !FAN_CHANNEL_RE.test(it.snippet.channelTitle);
    });
    const subs = await channelSubscribers(items.map((it) => it.snippet.channelId));
    for (const it of items) {
      if ((subs.get(it.snippet.channelId) ?? 0) < 100_000) continue;
      const title = decodeEntities(it.snippet.title);
      if (/reaction|리액션|cover\s*dance|커버\s*댄스|tutorial|mirror|교차편집|compilation|모음/i.test(title)) continue;
      found.push({ ...toVideo({ id: it.snippet.channelId, name: it.snippet.channelTitle, filter: false }, it.id.videoId, title, it.snippet.publishedAt), firstSeenAt: nowIso, channelSubscribers: subs.get(it.snippet.channelId), challengeSearch: true } as Video);
    }
  }
  return found.length ? storeVideos(found) : [];
}
