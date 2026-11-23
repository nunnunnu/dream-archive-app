/**
 * 여러 문서에서 뽑은 일정을 하나로 합쳐 사이트용 일정을 만든다.
 *
 *  - 같은 일정: 날짜가 같고, 종류가 맞고, 멤버가 맞고, 시간이 어긋나지 않고, 대상 이름이 비슷하면 하나로 합친다.
 *    (같은 문서 안의 일정끼리는 합치지 않는다: 같은 공지의 09:00·10:00 본인 확인 등)
 *  - 합칠 때는 출처 우선순위(위버스 공지 > 제보 > 기사 > 영상)대로 이름을 정하고, 비어 있는 값(시간 등)은 다른 출처로 채운다.
 *  - 반복 방송(recurrence)은 회차별 일정으로 펼친다.
 *  - 날짜를 모르는 확정 소식은 "날짜 미정" 목록으로 보낸다.
 *  - 같은 날 올라온 유튜브 영상이 있으면 그 공개 시각으로 빈 시간을 채운다.
 */
import { BRAND_RE } from './topics.ts';
import { BROADCASTER_PREFIX_RE, stripBroadcaster } from './broadcasters.ts';
import { showKey } from './tracked.ts';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './store.ts';
import type { CheckedEvent, Recurrence } from './llm.ts';
import { GROUP, GROUP_NAME_RE } from './group.ts';
import { MEMBERS } from './members.ts';

/** 대상 이름의 핵심 단어로 쓰지 않을 그룹 이름 조각 (nct, 드림 …) */
const GROUP_WORDS = new Set([...GROUP.nameVariants, ...GROUP.parentNames].flatMap((n) => n.toLowerCase().split(/\s+/)).map((w) => w.replace(/[^\p{L}\p{N}]+/gu, '')));
import { seriesDates, WEEKDAY_INDEX } from './recurrence.ts';
import type { EventKind } from './scheduleParser.ts';
import { kstDate, kstTime, toKstParts } from './time.ts';

export interface SourceRef {
  /** sns: 공식 SNS·유튜브 원 게시물 (팬 커뮤니티에서 찾은 것. 커뮤니티 주소는 남기지 않는다) */
  type: 'weverse-notice' | 'news' | 'youtube' | 'submission' | 'sns';
  id: string;
  url: string;
  title: string;
  publisher?: string;
  publishedAt: string;
}

/** 문서 하나에서 뽑아 검증까지 마친 일정 */
export interface ExtractedItem extends CheckedEvent {
  source: SourceRef;
  /** AI가 뽑았는지 규칙(AI를 못 쓸 때)으로 뽑았는지 */
  by: 'ai' | 'rule';
  /** 이미 있는 일정의 빈칸(시간·링크)만 채우고 새 일정은 만들지 않는 항목 (그룹이 안 나오는 관련 기사) */
  fillOnly?: boolean;
}

/** 확인 대기: 기사 한 곳이나 탐색 영상 하나에만 나온 일정. 다른 출처가 하나 더 맞으면 일정으로 옮겨진다 */
export interface ReviewItem extends PublicEvent {
  reason: string;
}

/** 바로 믿는 출처: 위버스 공지, 제보(사용자가 고른 글), 등록된 방송사 채널 영상, 추적 목록 */
const REGISTERED_GUEST_CHANNELS = new Set(GROUP.youtube.channels.filter((c) => c.guest).map((c) => c.name));
const OWN_CHANNEL_NAMES = new Set(GROUP.youtube.channels.filter((c) => !c.guest).map((c) => c.name));
const isStrong = (s: SourceRef) =>
  s.type === 'weverse-notice' || s.type === 'submission' || (s.type === 'youtube' && (REGISTERED_GUEST_CHANNELS.has(s.publisher ?? '') || OWN_CHANNEL_NAMES.has(s.publisher ?? '')));
/** 출처의 발행처 (같은 회사 여러 채널은 하나로: "KoreaFilm 코리아필름", "TVBS NEWS" → 첫 단어) */
const publisherKey = (s: SourceRef) => `${s.type === 'news' ? 'n' : 'y'}:${(s.publisher ?? s.url).trim().split(/[\s/·|]+/)[0].toLowerCase()}`;

export type Scope = '단체' | '멤버' | '유닛';

export interface PublicEvent {
  id: string;
  date: string;
  time: string | null;
  endDate: string | null;
  endTime: string | null;
  timezone: string | null;
  /** 해외 일정의 시간대 (Asia/Jakarta). timezones.ts 가 채운다 */
  tzid?: string;
  /** 해외 일정이면 도시 (제목·단계·근거에 나온 도시 이름). 질문 답변에서 입국·출국 추정에 쓴다 */
  abroad?: string;
  /** 해외 일정의 한국 날짜·시각 */
  kst?: { date: string; time: string };
  /** 무엇의 일정 (예: "SBS 꼬꼬무") */
  title: string;
  /** 그 안의 단계 (예: "제노 출연", "3회") */
  step: string;
  kind: EventKind;
  members: string[];
  scope: Scope;
  /** 근거가 원문과 맞으면 confirmed, 숫자가 안 맞는 등 확인이 필요하면 needs-check */
  status: 'confirmed' | 'needs-check';
  evidence: string;
  sources: SourceRef[];
  /** 반복 방송이면 시리즈 id와 회차 */
  seriesId?: string;
  episode?: number;
  extractedBy: 'ai' | 'rule';
  /** 보기: 방송·음방·공개·출연 / 참여: 팬이 직접 신청·예매·투표·현장 방문하는 일정 */
  /** 공식: 멤버가 실제로 나오는 일정(방송·공연·행사·공개). 참여: 팬이 미리 해야 하는 일(신청·예매·본인 확인·폼·투표·판매·팝업 방문 등) */
  category: '공식' | '참여';
  /** 보여 줄 캘린더. 콘서트·팬미팅처럼 드림이 나오고 팬이 예매해서 가는 일정은 둘 다 */
  calendars: ('공식' | '참여')[];
  /** 신청이 있는 일정 묶음(사녹·초대 이벤트 등)에서 당첨자만 가는 단계면 winners */
  audience: 'all' | 'winners';
  /** 신청이 있는 일정 묶음 id (신청 → 당첨 발표 → 본인 확인 → 녹화) */
  flowId?: string;
  /** 모아보기 태그 (예: "era:boogie-woogie", "project:crash2", "type:외부 출연", "member:지성") */
  tags?: string[];
}

const PARTICIPATE_KINDS: EventKind[] = ['신청', '당첨 발표', '본인 확인', '녹화', '판매', '투표', '모임'];
const WINNER_KINDS: EventKind[] = ['본인 확인', '녹화', '모임'];
/** 팬이 할 일(예약·예매·신청·인증·폼·구매)이나 멤버 없이 팬이 가는 곳(팝업·전시·카페 운영)은 참여 일정 */
const PARTICIPATE_RE = /사전\s*녹화|사녹|예약|예매|티켓|신청|응모|폼|본인\s*(확인|인증)|인증|당첨|입금|결제|구매|판매|선예매|팝업|POP-?UP|전시|카페|운영\s*(기간|시간|일자)|방문|대기\s*예약|개인정보|환불|취소/i;
export const categoryOf = (kind: EventKind, text: string): '공식' | '참여' =>
  kind === '방송' ? '공식' : PARTICIPATE_KINDS.includes(kind) || PARTICIPATE_RE.test(text) ? '참여' : '공식';
/** 드림이 나오고 팬이 직접 가는 공연·행사 (두 캘린더 모두) */
const ATTEND_RE = /콘서트|공연|팬미팅|팬\s*콘|투어|TOUR|SHOW|쇼케이스|사인회|팬사인|생일\s*파티|B-day|PARTY|파티|페스티벌|FESTIVAL|시상식|어워즈|AWARDS|MMA|MAMA/i;
export const calendarsOf = (e: { kind: EventKind; title: string; step: string; category: '공식' | '참여' }): ('공식' | '참여')[] =>
  // 사전녹화의 녹화 시간은 멤버가 실제로 있는 일정이라 공식에도 (당첨자 입장 표시)
  e.kind === '녹화' ? ['공식', '참여']
  : /출국|입국|공항/.test(`${e.title} ${e.step}`) ? [e.category]
  : e.kind === '행사' && e.category === '공식' && ATTEND_RE.test(`${e.title} ${e.step}`) && !/팝업|POP-?UP|전시|사전\s*녹화/i.test(`${e.title} ${e.step}`) ? ['공식', '참여'] : [e.category];

/**
 * 신청이 있는 공지(사녹·초대 이벤트 등)의 일정을 한 묶음으로 보고,
 * 당첨 발표 뒤의 본인 확인·녹화·재모임·현장 이벤트는 당첨자만 가는 단계로 표시한다.
 */
export function markFlows(events: PublicEvent[]): void {
  const bySource = new Map<string, PublicEvent[]>();
  for (const e of events) {
    const s = e.sources[0];
    if (s?.type !== 'weverse-notice') continue;
    bySource.set(s.id, [...(bySource.get(s.id) ?? []), e]);
  }
  for (const [noticeId, list] of bySource) {
    if (!list.some((e) => e.kind === '신청')) continue;
    const announce = list.filter((e) => e.kind === '당첨 발표').map((e) => e.date).sort()[0];
    for (const e of list) {
      e.flowId = `notice-${noticeId}`;
      const afterAnnounce = announce ? e.date > announce || (e.date === announce && e.kind !== '당첨 발표') : false;
      if (WINNER_KINDS.includes(e.kind) || (e.kind === '행사' && afterAnnounce)) e.audience = 'winners';
      // 신청 절차 안의 안내·발송 같은 단계(기타)는 팬이 할 일이라 참여 일정
      if (e.kind === '기타') e.category = '참여';
    }
  }
}

export interface PendingItem {
  id: string;
  title: string;
  step: string;
  whenText: string;
  members: string[];
  scope: Scope;
  evidence: string;
  sources: SourceRef[];
}

/** 멤버가 확인되지 않은 예고·추측 (캘린더에 넣지 않고 따로 보여준다) */
export interface RumorItem {
  id: string;
  date: string;
  time: string | null;
  title: string;
  /** "(추측: …)"을 뺀 단계 이름 */
  step: string;
  /** 추측되는 멤버 */
  guessMembers: string[];
  evidence: string;
  sources: SourceRef[];
}

const GUESS_RE = /\s*\(추측:\s*([^)]+)\)/;
const isGuess = (step: string) => GUESS_RE.test(step) || /미공개/.test(step);

export interface VideoLite {
  title: string;
  url: string;
  channel: string;
  publishedAt: string;
}

const PRIORITY: Record<SourceRef['type'], number> = { 'weverse-notice': 4, submission: 3, news: 2, sns: 0.5, youtube: 1 };
const MEMBER_ORDER = MEMBERS.map((m) => m.name);

/** 같은 행사의 다른 이름 (영어·한글·약칭) → 하나로 */
const ALIASES: [RegExp, string][] = [
  [/coachella(\s*valley\s*music\s*(and|&)\s*arts\s*festival)?/gi, '코첼라'],
  [/melon\s*music\s*awards?|멜론\s*뮤직\s*어워드?/gi, 'MMA'],
  [/mama\s*awards?|마마\s*어워즈/gi, 'MAMA'],
  [/golden\s*disc\s*awards?|골든\s*디스크(\s*어워즈)?/gi, '골든디스크'],
];

const BROADCASTER_RE = BROADCASTER_PREFIX_RE;
export function normTarget(t: string): string {
  let x = t;
  for (const [re, name] of ALIASES) x = x.replace(re, name);
  return x
    .replace(BROADCASTER_RE, '')
    .replace(new RegExp(GROUP_NAME_RE.source, 'gi'), '')
    .replace(/(?<!\d)20\d{2}(?!\d)/g, '') // "2027 코첼라" = "코첼라"
    .replace(/[^\p{L}\p{N}]+/gu, '')
    .toLowerCase();
}

/** 대상 이름의 핵심: 따옴표 속 이름('전과자'), 없으면 방송사·채널 말을 뺀 단어들 */
export function coreNames(t: string): string[] {
  const quoted = [...t.matchAll(/[‘'"“「<《]([^’'"”」>》]{2,20})[’'"”」>》]/g)].map((m) => m[1]);
  const words = quoted.length ? quoted : t.replace(/\([^)]*\)/g, ' ').split(/\s+/);
  return words
    .map((w) => w.replace(/[^\p{L}\p{N}]+/gu, '').toLowerCase())
    .filter((w) => w.length >= 2 && !/^(kbs2?|mbc|sbs|jtbc|ena|tvn|mnet|유튜브|웹예능|공식|채널|20\d{2})$/.test(w) && !GROUP_WORDS.has(w));
}

function bigrams(s: string): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2));
  return out;
}

export function similarTarget(a: string, b: string): boolean {
  const na = normTarget(a);
  const nb = normTarget(b);
  if (!na || !nb) return false;
  if (na.includes(nb) || nb.includes(na)) return true;
  // 따옴표 속 이름(앨범·프로그램명)이 상대 쪽에 그대로 있으면 같은 대상 ("정규 6집 'DREAM AFTER DREAM'" ↔ "DREAM AFTER DREAM 음반 발매")
  const sq = (t: string) => t.replace(/[^\p{L}\p{N}]+/gu, '').toLowerCase();
  const quotedIn = (x: string, y: string) => [...x.matchAll(/[‘'"“「<《\[]([^’'"”」>》\]]{4,30})[’'"”」>》\]]/g)].some((m) => sq(m[1]).length >= 4 && sq(y).includes(sq(m[1])));
  if (quotedIn(a, b) || quotedIn(b, a)) return true;
  const A = bigrams(na);
  const B = bigrams(nb);
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter >= 2 && inter / Math.min(A.size, B.size) >= 0.5;
}

const membersKey = (m: string[]) => MEMBER_ORDER.filter((x) => m.includes(x)).join('·');
const scopeOf = (m: string[]): Scope =>
  m.length === 0 || m.length >= Math.max(2, MEMBER_ORDER.length - 1)
    ? '단체'
    : GROUP.units.some((u) => u.members.length === m.length && u.members.every((x) => m.includes(x)))
      ? '유닛'
      : '멤버';
// 방송·공개·행사(출연)는 출처마다 다르게 분류되곤 해서 같은 묶음으로 본다
const KIND_FAMILY: Partial<Record<EventKind, string>> = { 방송: 'show', 발매: 'show', 행사: 'show' };
const kindCompatible = (a: EventKind, b: EventKind) => a === b || (KIND_FAMILY[a] !== undefined && KIND_FAMILY[a] === KIND_FAMILY[b]);
const minutes = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
/** 시간이 같거나 한쪽이 비어 있으면 같은 일정 후보. 유튜브 영상은 예고 시간과 실제 공개 시각이 조금 달라서 90분까지 허용 */
const timeCompatible = (a: string | null, b: string | null, tolerance = 0) => !a || !b || a === b || Math.abs(minutes(a) - minutes(b)) <= tolerance;

function sameEvent(a: ExtractedItem, b: ExtractedItem): boolean {
  if (a.source.type === b.source.type && a.source.id === b.source.id) return false;
  const tolerance = a.source.type === 'youtube' || b.source.type === 'youtube' ? 90 : 0;
  if (a.date !== b.date || !kindCompatible(a.kind, b.kind) || !timeCompatible(a.time, b.time, tolerance)) return false;
  const ma = membersKey(a.members);
  const mb = membersKey(b.members);
  if (ma && mb && ma !== mb) return false;
  if (similarTarget(a.target, b.target)) return true;
  // 이름이 달라도 같은 멤버·같은 시각이면 같은 일정 ("SBS 꼬꼬무" vs "꼬리에 꼬리를 무는 그날 이야기")
  return Boolean(a.time && a.time === b.time && ma && ma === mb);
}

const stableId = (...parts: string[]) => createHash('sha1').update(parts.join('|')).digest('hex').slice(0, 12);

/** 우선순위: 출처 → 검증 통과 → AI */
const rank = (x: ExtractedItem) => PRIORITY[x.source.type] * 10 + (x.verified ? 2 : 0) + (x.by === 'ai' ? 1 : 0);

function mergeGroup(group: ExtractedItem[]): PublicEvent {
  const sorted = [...group].sort((a, b) => Number(Boolean(a.fillOnly)) - Number(Boolean(b.fillOnly)) || Number(isGuess(a.step)) - Number(isGuess(b.step)) || rank(b) - rank(a));
  const rep = sorted[0];
  const first = <K extends keyof ExtractedItem>(k: K) => sorted.map((x) => x[k]).find((v) => v !== null && v !== undefined && v !== '') ?? null;
  const own = sorted.filter((x) => !x.fillOnly);
  const firstOwn = <K extends keyof ExtractedItem>(k: K) => own.map((x) => x[k]).find((v) => v !== null && v !== undefined && v !== '') ?? null;
  // 대표 출처가 멤버를 적었으면 다른 출처의 멤버도 합치고(같은 출연을 기사마다 일부씩 언급), 대표가 단체면 단체
  const groupVotes = sorted.filter((x) => !x.members.length).length;
  const members = rep.members.length && groupVotes * 2 < sorted.length ? MEMBER_ORDER.filter((m) => sorted.some((x) => x.members.includes(m))) : [];
  const sources: SourceRef[] = [];
  for (const x of sorted) if (!sources.some((s) => s.url === x.source.url)) sources.push(x.source);
  return {
    id: stableId(rep.date!, normTarget(rep.target), membersKey(members), rep.kind, normTarget(rep.step)),
    date: rep.date!,
    time: ((): string | null => {
      const ytTimes = own.filter((x) => x.source.type === 'youtube' && x.time).map((x) => x.time!).sort();
      if (rep.kind === '행사') return (own.find((x) => x.source.type !== 'youtube' && x.time)?.time ?? ytTimes[0] ?? first('time')) as string | null;
      return (ytTimes[0] ?? first('time')) as string | null;
    })(),
    endDate: (firstOwn('end_date') as string | null) && firstOwn('end_date') !== rep.date ? (firstOwn('end_date') as string) : null,
    endTime: firstOwn('end_time') as string | null,
    timezone: ((t) => (t && t !== 'KST' ? t : null))(first('timezone') as string | null),
    title: rep.target,
    step: rep.step,
    kind: rep.kind,
    members,
    scope: scopeOf(members),
    status: sorted.some((x) => x.verified) ? 'confirmed' : 'needs-check',
    evidence: rep.evidence,
    sources,
    extractedBy: rep.by,
    category: categoryOf(rep.kind, `${rep.target} ${rep.step}`),
    calendars: [],
    audience: 'all',
  };
}

function mergeRecurrence(group: ExtractedItem[]): Recurrence | null {
  const recs = group.map((x) => x.recurrence).filter((r): r is Recurrence => Boolean(r && r.weekdays.length));
  if (!recs.length) return null;
  return {
    weekdays: recs[0].weekdays,
    episodes: recs.find((r) => r.episodes)?.episodes ?? null,
    end_date: recs.find((r) => r.end_date)?.end_date ?? null,
  };
}

/** 같은 날 올라온 영상 제목에 대상 이름이 있으면 그 공개 시각 */
const squashName = (t: string) => t.normalize('NFKC').replace(/[^\p{L}\p{N}]+/gu, '').toLowerCase();

/** 고정 편성 프로그램 (config/programs.json) */
const PROGRAMS: { names: string[]; weekday: string; time: string }[] = JSON.parse(readFileSync(join(ROOT, 'config', 'programs.json'), 'utf8')).programs;
const programOf = (title: string) => PROGRAMS.find((p) => p.names.some((n) => title.toLowerCase().includes(n.toLowerCase())));
const weekdayOf = (date: string) => ['일', '월', '화', '수', '목', '금', '토'][new Date(`${date}T00:00:00Z`).getUTCDay()];

/** 소속사·공식 채널 (그룹 자체 콘텐츠: 트레일러·MV·자체 예능) */
const OWN_CHANNELS = new Set(GROUP.youtube.channels.filter((c) => !c.guest).map((c) => c.name));
const VIDEO_RELEASE_RE = /트레일러|trailer|티저|teaser|뮤직비디오|MV|영상|에피소드|EP\.?\s*\d/i;

/**
 * 같은 날 올라온 영상에서 공개 시각 찾기
 *  1) 일정 이름·단계에 있는 이름(따옴표 속 제목 등)이 영상 제목에 있으면 그 영상
 *  2) 영상 공개 일정(트레일러·MV 등)인데 그날 공식 채널에 올라온 영상이 하나뿐이면 그 영상
 *     예: 기사 "3일 첫 번째 트레일러 공개" + 공식 채널 11/03 00:00 "EP.1 WE’RE DREAM AFTER SERVICE!" → 00:00
 */
function timeFromVideos(e: PublicEvent, videos: VideoLite[]): { time: string; video: VideoLite } | null {
  // 영상 업로드 시각은 영상 공개·방송(유튜브 회차) 일정에만 맞다. 녹화·촬영·행사·출국은 영상이 나중에 올라오므로 쓰지 않는다
  if (!(e.kind === '발매' || e.kind === '방송') || /녹화|사녹|촬영|녹음|출국|입국|참석|개막/.test(`${e.step} ${e.title}`)) return null;
  const sameDay = videos.filter((v) => {
    const p = toKstParts(new Date(v.publishedAt));
    return kstDate(p.year, p.month, p.day) === e.date;
  });
  const at = (v: VideoLite) => {
    const p = toKstParts(new Date(v.publishedAt));
    return { time: kstTime(p.hour, p.minute), video: v };
  };
  const names = coreNames(`${e.title} ${e.step}`);
  if (names.length) {
    for (const v of sameDay) {
      const vt = v.title.replace(/[^\p{L}\p{N}]+/gu, '').toLowerCase();
      if (names.some((n) => vt.includes(n))) return at(v);
    }
  }
  if (e.kind === '발매' && VIDEO_RELEASE_RE.test(e.step)) {
    const own = sameDay.filter((v) => OWN_CHANNELS.has(v.channel));
    if (own.length === 1) return at(own[0]);
  }
  return null;
}

/** 날짜 미정 소식으로 쓸 만한 시기 표현인지: 지난 해는 버리고, 시기 정보(월·내년·상반기 …)가 있어야 */
export function usefulWhen(whenText: string, today: string): boolean {
  const fullDates = [...whenText.matchAll(/(20\d{2})-(\d{2})-(\d{2})/g)].map((m) => m[0]);
  if (fullDates.length && fullDates.every((d) => d < today)) return false;
  const years = [...whenText.matchAll(/(?<!\d)(20\d{2})(?!\d)/g)].map((m) => Number(m[1]));
  if (years.length && Math.max(...years) < Number(today.slice(0, 4))) return false;
  return /\d|내년|올해|연내|상반기|하반기|봄|여름|가을|겨울|초|중순|말|예정/.test(whenText);
}

/**
 * 시기 표현에 구체적인 날짜가 있으면 그 날짜들: "2027년 4월 10일과 17일" → [2027-04-10, 2027-04-17]
 * 연도가 없으면 오늘 이후 가장 가까운 해.
 */
export function datesFromWhen(when: string, today: string): string[] {
  const m = when.match(/(?:(20\d{2})\s*년\s*)?(\d{1,2})\s*월\s*(\d{1,2})\s*일((?:\s*(?:과|와|및|,|·|~|-)\s*\d{1,2}\s*일)*)/);
  if (!m) return [];
  const month = Number(m[2]);
  const days = [Number(m[3]), ...[...(m[4] ?? '').matchAll(/(\d{1,2})\s*일/g)].map((d) => Number(d[1]))];
  let year = m[1] ? Number(m[1]) : Number(today.slice(0, 4));
  const pad = (n: number) => String(n).padStart(2, '0');
  if (!m[1] && `${year}-${pad(month)}-${pad(days[0])}` < today) year++;
  return days.filter((d) => d >= 1 && d <= 31).map((d) => `${year}-${pad(month)}-${pad(d)}`);
}

/** 시작·마감이 의미 있는 기간 일정 (투표·예매·신청) */
export const PERIOD_KINDS: EventKind[] = ['투표', '판매', '신청'];
const START_RE = /\s*(시작|오픈|open)\s*$/i;
const END_RE = /\s*(마감|종료|끝)\s*$/;
const stepCore = (step: string) => step.replace(START_RE, '').replace(END_RE, '').replace(/\s+/g, '');

export function pairPeriods(events: PublicEvent[]): void {
  for (let i = events.length - 1; i >= 0; i--) {
    const end = events[i];
    if (!PERIOD_KINDS.includes(end.kind) || end.endDate || !END_RE.test(end.step)) continue;
    // 이미 같은 날 끝나는 기간 일정이 있으면 그쪽 출처로 합친다
    const period = events.find((p) => p !== end && p.kind === end.kind && p.endDate === end.date && similarTarget(p.title, end.title));
    if (period) {
      for (const src of end.sources) if (!period.sources.some((x) => x.url === src.url)) period.sources.push(src);
      events.splice(i, 1);
      continue;
    }
    const candidates = events.filter(
      (s) => s !== end && s.kind === end.kind && !s.endDate && !END_RE.test(s.step) && s.date <= end.date
        && similarTarget(s.title, end.title) && membersKey(s.members) === membersKey(end.members),
    );
    // 단계 이름이 같으면 그것, 아니면 후보가 하나뿐일 때만 (여러 투표가 섞이지 않게)
    const same = candidates.filter((s) => stepCore(s.step) === stepCore(end.step) || stepCore(end.step).includes(stepCore(s.step)) || stepCore(s.step).includes(stepCore(end.step)));
    const start = same.length === 1 ? same[0] : candidates.length === 1 ? candidates[0] : null;
    if (!start) continue;
    start.endDate = end.date;
    start.endTime = end.time;
    start.step = start.step.replace(START_RE, '').trim() || start.step;
    if (!start.evidence.includes(end.evidence)) start.evidence = `${start.evidence} / ${end.evidence}`;
    for (const src of end.sources) if (!start.sources.some((x) => x.url === src.url)) start.sources.push(src);
    events.splice(i, 1);
  }
}

/** "매주 화요일 저녁 8시" 같은 정기 편성 → 글 작성일 이후 첫 회 날짜·시간과 반복 정보 */
export function weeklyFromWhen(when: string, writtenAt: string): { date: string; time: string | null; recurrence: Recurrence } | null {
  const m = when.normalize('NFKC').match(/매주\s*([월화수목금토일])요일/);
  if (!m) return null;
  const start = new Date(new Date(writtenAt).getTime() + 9 * 3600 * 1000);
  const target = WEEKDAY_INDEX[m[1]];
  const d = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()));
  while (d.getUTCDay() !== target) d.setUTCDate(d.getUTCDate() + 1);
  const t = when.normalize('NFKC').match(/(오전|오후|저녁|밤|낮|새벽)?\s*(\d{1,2})\s*시(?:\s*(\d{1,2})\s*분)?|(\d{1,2}):(\d{2})/);
  let time: string | null = null;
  if (t) {
    let h = Number(t[2] ?? t[4]);
    const min = Number(t[3] ?? t[5] ?? 0);
    if (t[1] && /오후|저녁|밤/.test(t[1]) && h < 12) h += 12;
    time = `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
  }
  return { date: d.toISOString().slice(0, 10), time, recurrence: { weekdays: [m[1]], episodes: null, end_date: null } };
}

export function consolidate(
  rawItems: ExtractedItem[],
  opts: {
    today: string;
    videos?: VideoLite[];
    /** false면 출처 하나뿐인 일정도 캘린더에 (테스트용) */
    corroborate?: boolean;
    /** 구독자가 많은 채널의 출연 영상 주소: 영상 공개 일정은 영상 자체가 증거라 바로 믿는다 */
    trustedVideoUrls?: Set<string>;
    /** 고정 출연 회차에 붙일 영상 (프로그램 채널의 회차 클립: "[IDOL'S TABLE/EP.06] …") */
    seriesVideos?: (VideoLite & { duration?: number })[];
  },
): { events: PublicEvent[]; pending: PendingItem[]; rumors: RumorItem[]; review: ReviewItem[] } {
  // 날짜 미정으로 왔지만 시기 표현에 날짜가 적혀 있으면 날짜 일정으로
  const items = rawItems.flatMap((x) => {
    if (x.date || !x.when_text) return [x];
    // "매주 화요일 저녁 8시" → 글 작성일 다음 그 요일부터 매주 반복 (예: 아이돌스 테이블)
    // 회차마다 출연자가 바뀔 수 있어서 반복 일정으로 펼치지 않고 다음 회 하나만 만든다 (고정 출연은 recurrence로 따로 온다)
    const weekly = weeklyFromWhen(x.when_text, x.source.publishedAt);
    if (weekly) return [{ ...x, date: weekly.date, time: x.time ?? weekly.time, when_text: null }];
    const dates = datesFromWhen(x.when_text, opts.today);
    return dates.length ? dates.map((d) => ({ ...x, date: d, when_text: null })) : [x];
  });
  // 0) 한 문서 안의 중복: 똑같은 일정이 두 번 나오거나, 같은 날 같은 대상인데 하나만 시간이 있으면 시간 있는 것만
  //    (공지 본문 글과 이미지 속 글에 같은 일정이 함께 있을 때)
  const srcKey = (x: ExtractedItem) => `${x.source.type}:${x.source.id}`;
  for (let i = items.length - 1; i >= 0; i--) {
    const x = items[i];
    if (!x.date) continue;
    const twin = items.find((y, j) => j !== i && y.date === x.date && srcKey(y) === srcKey(x) && kindCompatible(y.kind, x.kind) && similarTarget(y.target, x.target)
      && ((y.time === x.time && normTarget(y.step) === normTarget(x.step) && j < i) || (!x.time && y.time && !y.end_date === !x.end_date)));
    if (twin) items.splice(i, 1);
  }

  // 1) 날짜 있는 일정끼리 묶기 (우선순위 높은 것부터 대표로)
  const tie = (x: ExtractedItem) => `${x.source.publishedAt}|${x.source.id}|${x.date}|${x.time ?? ''}|${x.step}`;
  const dated = items.filter((x) => x.date).sort((a, b) => rank(b) - rank(a) || tie(a).localeCompare(tie(b)));
  const groups: ExtractedItem[][] = [];
  for (const x of dated) {
    const g = groups.find((grp) => grp.some((y) => sameEvent(x, y)) && !grp.some((y) => y.source.type === x.source.type && y.source.id === x.source.id));
    if (g) g.push(x);
    else groups.push([x]);
  }

  // 2) 합치고, 반복 방송은 회차로 펼치고, 빈 시간은 영상으로 채우기
  const until = (() => {
    const d = new Date(`${opts.today}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + 28);
    return d.toISOString().slice(0, 10);
  })();
  // 결방 소식: 그날 회차는 빼고 이후 회차 번호를 민다 (결방 일정 자체는 따로 남는다)
  const cancellations = items.filter((x) => x.date && /결방/.test(`${x.step} ${x.evidence}`));
  const isCancelled = (title: string, date: string) => cancellations.some((c) => c.date === date && similarTarget(c.target, title));

  // 일정이 되게 한 출처 (채우기 전용 출처는 신뢰 판단에 세지 않는다)
  const counted = new Set(items.filter((x) => !x.fillOnly).map((x) => x.source.url));
  const manualShows = new Set(items.filter((x) => x.evidence.startsWith('추적 목록')).map((x) => showKey(x.target)));
  const events: PublicEvent[] = [];
  for (const g of groups) {
    if (g.every((x) => x.fillOnly)) continue;
    const e = mergeGroup(g);
    if (!e.time && opts.videos?.length) {
      const v = timeFromVideos(e, opts.videos);
      if (v) {
        e.time = v.time;
        e.sources.push({ type: 'youtube', id: v.video.url, url: v.video.url, title: v.video.title, publisher: v.video.channel, publishedAt: v.video.publishedAt });
      }
    }
    const rec = mergeRecurrence(g);
    if (!rec) {
      events.push(e);
      continue;
    }
    // 직접 등록한 고정 출연(추적 목록)이 있으면 같은 프로그램의 기사 속 반복 정보로 또 펼치지 않는다 (아이돌스 테이블이 화·수 두 개로 생기던 문제)
    if (!g.some((x) => x.evidence.startsWith('추적 목록')) && manualShows.has(showKey(e.title))) continue;
    const weekdays = rec.weekdays.map((w) => WEEKDAY_INDEX[w]).filter((n) => n !== undefined);
    // 결방이 있으면 그만큼 회차가 뒤로 밀리므로 넉넉히 만든 뒤 결방일을 빼고 번호를 다시 매긴다
    const extra = cancellations.length;
    const eps = seriesDates(e.date, weekdays, { episodes: rec.episodes ? rec.episodes + extra : null, endDate: rec.end_date, until })
      .filter((ep) => !isCancelled(e.title, ep.date))
      .slice(0, rec.episodes ?? undefined)
      .map((ep, i) => ({ ...ep, episode: i + 1 }));
    for (const ep of eps) {
      const last = rec.episodes ? ep.episode === rec.episodes : rec.end_date === ep.date;
      events.push({
        ...e,
        id: `${e.id}-${ep.episode}`,
        date: ep.date,
        step: `${ep.episode}회${ep.episode === 1 ? ' (첫 방송)' : last ? ' (마지막 회)' : ''}`,
        kind: '방송',
        seriesId: e.id,
        episode: ep.episode,
        // 회차마다 출처 목록을 따로 (한 회차에 붙인 영상이 다른 회차에 섞이지 않게)
        sources: [...e.sources],
      });
    }
  }

  const squash = (t: string) => t.replace(/[^\p{L}\p{N}]+/gu, '').toLowerCase();
  const programNamed = (title: string, v: PublicEvent) => {
    const names = coreNames(title).filter((n) => !/studio|채널|channel|공식/.test(n));
    const hay = squash(`${v.title} ${v.step} ${v.sources.filter((s) => s.type === 'youtube').map((s) => s.title).join(' ')}`);
    return names.length > 0 && names.some((n) => hay.includes(n));
  };
  // 2-0) 고정 편성 프로그램(음악방송): 시간이 없으면 요일이 맞을 때 편성 시간으로.
  //      사전녹화 공지가 있으면 그날 방송 출연 일정도 만든다 (공지가 믿는 출처라 바로 캘린더에)
  for (const e of [...events]) {
    const prog = programOf(e.title);
    // 방영일은 공지 제목에 적혀 있다 ("… 녹화 참여 안내(261122 방송)")
    const aired = [e.title, ...e.sources.map((s) => s.title)].join(' ').match(/(\d{2})(\d{2})(\d{2})\s*방송/);
    if (prog && aired && /사전\s*녹화|녹화/.test(e.title) && e.sources.some((s) => s.type === 'weverse-notice')) {
      const d = `20${aired[1]}-${aired[2]}-${aired[3]}`;
      if (!events.some((x) => x.date === d && x.kind === '방송' && programOf(x.title) === prog)) {
        events.push({
          ...e, id: stableId(d, prog.names[0], 'broadcast'), date: d, time: prog.time, endDate: null, endTime: null,
          title: prog.names[0], step: '출연 (방송)', kind: '방송', category: '공식', calendars: ['공식'], audience: 'all', flowId: undefined,
          evidence: `${e.title} → ${d} 방송`,
        });
      }
      continue;
    }
    if (!prog || weekdayOf(e.date) !== prog.weekday) continue;
    if (!e.time && e.kind === '방송') e.time = prog.time;
    if (/사전\s*녹화|사녹/.test(e.title) && e.sources.some((s) => s.type === 'weverse-notice')
      && !events.some((x) => x.date === e.date && x.kind === '방송' && programOf(x.title) === prog)) {
      events.push({
        ...e, id: stableId(e.date, prog.names[0], 'broadcast'), time: prog.time, endDate: null, endTime: null,
        title: prog.names[0], step: '출연 (방송)', kind: '방송', category: '공식', calendars: ['공식'], audience: 'all', flowId: undefined,
        evidence: `${e.title} → 같은 날 ${prog.names[0]} 방송 (${prog.weekday} ${prog.time} 편성)`,
      });
    }
  }

  // 2-0a) 음악방송 무대 영상이 "○○회 출연분 공개"로 따로 잡히면 같은 날 그 프로그램 방송 일정에 출처로 합친다
  //       (2026-11-22 인기가요 15:20 방송 + SBSKPOP 영상 15:47 "1332회 NCT DREAM 출연분 공개"가 두 줄로 떴음)
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    const prog = e.kind === '발매' ? programOf(e.title) : undefined;
    if (!prog || !e.sources.every((s) => s.type === 'youtube')) continue;
    const host = events.find((x) => x !== e && x.date === e.date && x.kind === '방송' && programOf(x.title) === prog);
    if (!host) continue;
    for (const src of e.sources) if (!host.sources.some((s) => s.url === src.url)) host.sources.push(src);
    events.splice(i, 1);
  }

  // 2-0b) 음악방송 출연 일정에 같은 날 그 프로그램 무대 영상을 출처로 붙인다 (▶ 무대 영상 링크)
  for (const e of events) {
    const prog = e.kind === '방송' ? programOf(e.title) : undefined;
    if (!prog) continue;
    for (const v of opts.videos ?? []) {
      const p = toKstParts(new Date(v.publishedAt));
      if (kstDate(p.year, p.month, p.day) !== e.date || programOf(v.title) !== prog || e.sources.some((s) => s.url === v.url)) continue;
      e.sources.push({ type: 'youtube', id: v.url, url: v.url, title: v.title, publisher: v.channel, publishedAt: v.publishedAt });
    }
  }

  // 2-0c) 고정 출연 회차에 같은 회차 영상 붙이기: 프로그램 이름 + "EP.06" (예고·선공개 포함, 긴 영상 먼저 3개까지)
  for (const e of events) {
    if (!e.seriesId || !e.episode) continue;
    const show = squashName(stripBroadcaster(e.title).split(/\s*[:：]\s*/)[0]);
    if (show.length < 4) continue;
    const clips = (opts.seriesVideos ?? [])
      .filter((v) => squashName(v.title).includes(show) && Number(v.title.match(/EP\.?\s*0*(\d+)/i)?.[1]) === e.episode && !/off\s*the\s*table/i.test(v.title))
      .sort((a, b) => (b.duration ?? 0) - (a.duration ?? 0))
      .slice(0, 3);
    e.sources = [...e.sources, ...clips.filter((v) => !e.sources.some((s) => s.url === v.url)).map((v) => ({ type: 'youtube' as const, id: v.url, url: v.url, title: v.title, publisher: v.channel, publishedAt: v.publishedAt }))];
  }

  // 2-1) 예고(기사) 날짜와 실제 영상 공개가 하루 안쪽으로 어긋나면 실제 공개를 따른다
  //      예: 기사 "12일 공개" + 영상 11일 21:25 공개 → 11일 21:25 일정 하나 (기사는 출처로)
  const dayDiff = (a: string, b: string) => Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.time || e.seriesId || e.sources.some((s) => s.type === 'youtube') || !KIND_FAMILY[e.kind]) continue;
    const video = events.find(
      (v) => v !== e && v.sources.some((s) => s.type === 'youtube') && kindCompatible(v.kind, e.kind) && dayDiff(v.date, e.date) <= 1
        && similarTarget(v.title, e.title) && (!e.members.length || !v.members.length || e.members.some((m) => v.members.includes(m)))
        && programNamed(e.title, v),
    );
    if (!video) continue;
    for (const s of e.sources) if (!video.sources.some((x) => x.url === s.url)) video.sources.push(s);
    video.members = MEMBER_ORDER.filter((m) => video.members.includes(m) || e.members.includes(m));
    video.scope = scopeOf(video.members);
    events.splice(i, 1);
  }

  // 2-1b) 같은 날 같은 유튜브 영상을 출처로 가진 일정은 같은 일정 (기사 "첫 번째 트레일러 공개" + 공식 채널 EP.1 영상)
  const ytId = (u: string) => u.match(/(?:v=|youtu\.be\/|shorts\/|live\/)([\w-]{11})/)?.[1];
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    const ids = new Set(e.sources.map((s) => ytId(s.url)).filter(Boolean));
    if (!ids.size || e.seriesId) continue;
    const twin = events.find((x, j) => j < i && x.date === e.date && !x.seriesId && x.sources.some((s) => ids.has(ytId(s.url))));
    if (!twin) continue;
    for (const src of e.sources) if (!twin.sources.some((x) => x.url === src.url)) twin.sources.push(src);
    twin.time ??= e.time;
    events.splice(i, 1);
  }

  // 2-1c) 트레일러 시리즈 이름 붙이기: 트레일러로 확인된 영상(EP.1)과 같은 형식의 다음 편(EP.2)도 트레일러
  const epPrefix = (t: string) => t.match(/^(.*?)\bEP\.?\s*\d+/i)?.[1]?.trim();
  const trailerOf = new Map<string, string>();
  for (const e of events) {
    if (!/트레일러|trailer/i.test(`${e.title} ${e.step}`)) continue;
    for (const s of e.sources) if (s.type === 'youtube' && epPrefix(s.title)) trailerOf.set(`${s.publisher}|${epPrefix(s.title)}`, e.title.replace(/\s*(첫|두|세|네|다섯)\s*번째|\s*\d+\s*번째/g, '').replace(/\s{2,}/g, ' ').trim());
  }
  for (const e of events) {
    if (/트레일러|trailer/i.test(`${e.title} ${e.step}`)) continue;
    const s = e.sources.find((x) => x.type === 'youtube' && epPrefix(x.title) && trailerOf.has(`${x.publisher}|${epPrefix(x.title)}`));
    if (!s) continue;
    const ep = s.title.match(/\bEP\.?\s*(\d+)\s*(.*)$/i);
    e.title = trailerOf.get(`${s.publisher}|${epPrefix(s.title)}`)!;
    e.step = `트레일러 EP.${ep?.[1]}${ep?.[2] ? ` '${ep[2].trim()}'` : ''} 공개`;
  }

  // 2-2) 기간 일정의 시작·마감이 따로 왔으면 하나로 (예: "팬 투표 시작 10/30" + "팬 투표 마감 11/13" → 10/30 ~ 11/13)
  pairPeriods(events);

  // 3) 날짜 미정 소식: 대상·멤버가 같은 것끼리 묶기. 같은 대상의 날짜 있는 일정이 생기면 빼기
  const pending: PendingItem[] = [];
  // 반년 넘은 글의 "날짜 미정" 소식은 이미 지나갔거나 바뀌었을 가능성이 커서 쓰지 않는다
  const halfYearAgo = new Date(Date.parse(`${opts.today}T00:00:00+09:00`) - 180 * 24 * 3600 * 1000).toISOString();
  for (const x of items.filter((i) => !i.date && !i.fillOnly).sort((a, b) => rank(b) - rank(a))) {
    if (!usefulWhen(x.when_text ?? '', opts.today)) continue;
    if (x.source.publishedAt < halfYearAgo) continue;
    if (events.some((e) => similarTarget(e.title, x.target) && e.date >= opts.today)) continue;
    const found = pending.find((p) => similarTarget(p.title, x.target) && membersKey(p.members) === membersKey(x.members));
    if (found) {
      if (!found.sources.some((s) => s.url === x.source.url)) found.sources.push(x.source);
      continue;
    }
    pending.push({
      id: stableId('pending', normTarget(x.target), membersKey(x.members)),
      title: x.target,
      step: x.step,
      whenText: x.when_text ?? '',
      members: MEMBER_ORDER.filter((m) => x.members.includes(m)),
      scope: scopeOf(x.members),
      evidence: x.evidence,
      sources: [x.source],
    });
  }

  // 3-1) 신뢰 단계: 바로 믿는 출처가 있거나, 서로 다른 발행처 두 곳 이상이 같은 일정을 말할 때만 캘린더에.
  //      아니면 확인 대기 (기사 한 곳·탐색 영상 하나뿐인 일정)
  const review: ReviewItem[] = [];
  for (let i = events.length - 1; opts.corroborate !== false && i >= 0; i--) {
    const e = events[i];
    // 일정을 만든 출처 + 공개 시각을 채워 준 공식 채널 영상
    const srcs = e.sources.filter((s) => counted.has(s.url) || (s.type === 'youtube' && OWN_CHANNEL_NAMES.has(s.publisher ?? '')));
    if (e.seriesId && srcs.length === 0) continue; // 추적 목록에서 펼친 회차
    if (srcs.some(isStrong) || srcs.length === 0) continue;
    // 믿는 출처가 없는 일정이 캘린더의 다른 일정과 같은 것이면 그쪽 출처로 합친다 (크래시2 회차 중복 등)
    const hasYt = (x: PublicEvent) => x.sources.some((s) => s.type === 'youtube');
    const dup = events.find((c) =>
      c !== e && c.date === e.date && kindCompatible(c.kind, e.kind)
      && timeCompatible(c.time, e.time, hasYt(c) || hasYt(e) ? 90 : 0)
      && similarTarget(c.title, e.title)
      && (!c.members.length || !e.members.length || c.members.some((m) => e.members.includes(m))));
    if (dup) {
      for (const src of e.sources) if (!dup.sources.some((x) => x.url === src.url)) dup.sources.push(src);
      events.splice(i, 1);
      continue;
    }

    if ((e.kind === '발매' || e.kind === '방송') && srcs.some((s) => opts.trustedVideoUrls?.has(s.url))) continue;
    // 같은 날 같은 대상의 믿는 일정이 있으면 확인된 것 (예: 뮤직뱅크 출연 기사 + 같은 날 뮤직뱅크 사전녹화 공지)
    const strongTwin = events.some((c) => c !== e && c.date === e.date && similarTarget(c.title, e.title) && c.sources.some(isStrong));
    if (strongTwin) continue;
    const pubs = new Set(srcs.map(publisherKey));
    if (pubs.size >= 2) continue;
    // 기사는 한 곳뿐이어도 바로 캘린더에 (참여 문장 확인을 통과한 기사). 확인 대기는 작은 채널 영상 하나뿐인 일정만
    // 기사·SNS가 하나라도 있으면 기사 한 곳만 있는 일정과 같게 본다 (예: 윤주모 = 유튜브 커뮤니티 공지 + 본편·쇼츠 영상)
    if (srcs.some((s) => s.type === 'news' || s.type === 'sns')) continue;
    // 멤버 미확인 예고는 추측 목록에서 따로 다룬다
    if (isGuess(e.step) && !e.members.length) continue;
    review.push({ ...e, reason: srcs[0].type === 'youtube' ? '영상 하나에만 나옴' : `기사 한 곳(${srcs[0].publisher ?? '언론사'})에만 나옴` });
    events.splice(i, 1);
  }
  review.sort((a, b) => `${a.date} ${a.time ?? ''}`.localeCompare(`${b.date} ${b.time ?? ''}`));

  // 4) 멤버가 확인되지 않은 예고·추측은 일정에서 빼서 따로 (확정되면 다음 합치기 때 일정으로 들어온다)
  const rumors: RumorItem[] = [];
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (!isGuess(e.step) || e.members.length) continue;
    const guess = e.step.match(GUESS_RE)?.[1] ?? '';
    rumors.push({
      id: e.id, date: e.date, time: e.time, title: e.title,
      step: e.step.replace(GUESS_RE, '').trim(),
      guessMembers: MEMBER_ORDER.filter((m) => guess.includes(m)),
      evidence: e.evidence, sources: e.sources,
    });
    events.splice(i, 1);
  }
  // 확정된 일정의 단계 이름에 남은 "(추측: …)"은 지운다
  for (const e of events) e.step = e.step.replace(GUESS_RE, '').trim();

  // 광고 모델·화보·브랜드 소식은 일정이 아니라 소식 (소식 화면에서 보여 줌). 실제로 가는 행사(팝업·사인회 등)는 남긴다
  for (let i = events.length - 1; i >= 0; i--) if (events[i].kind !== '행사' && BRAND_RE.test(`${events[i].title} ${events[i].step}`)) events.splice(i, 1);
  markFlows(events);
  for (const e of events) e.calendars = calendarsOf(e);
  events.sort((a, b) => `${a.date} ${a.time ?? '99:99'}`.localeCompare(`${b.date} ${b.time ?? '99:99'}`));
  rumors.sort((a, b) => a.date.localeCompare(b.date));
  return { events, pending, rumors, review };
}

/**
 * 한 회차 공개("트레일러 공개 (EP.1)")인데 기사 문장("11월 3~4일 트레일러")으로 기간이 붙은 경우 → 공식 채널 영상 공개일 하루로.
 * 영상 출처는 합친 뒤에도 붙으니(내보내기 직전) 마지막에 부른다.
 */
export function fixSingleEpisodeRanges(events: PublicEvent[]): number {
  let n = 0;
  for (const e of events) {
    if (e.kind !== '발매' || !e.endDate || e.endDate === e.date || !/EP\.?\s*\d+/i.test(`${e.title} ${e.step}`)) continue;
    const own = e.sources.find((s) => s.type === 'youtube' && OWN_CHANNEL_NAMES.has(s.publisher ?? ''));
    if (!own) continue;
    const p = toKstParts(new Date(own.publishedAt));
    e.date = kstDate(p.year, p.month, p.day);
    e.endDate = null;
    e.endTime = null;
    n++;
  }
  return n;
}
