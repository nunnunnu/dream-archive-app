/**
 * 위버스 공지 본문에서 일정(날짜·시간)을 뽑는다.
 *
 * 지원하는 표기 예:
 *   2026. 11. 13 (금) 11:40AM
 *   2026. 11. 11 (수) 7:00 PM 부터 ~ 7:10 PM 까지 (KST)
 *   2026. 10. 13 (TUE) 15:00 ~ 10. 19 (MON) 23:59
 *   11월 15일(일) 3PM (KST)
 *   11월 13일 (금) 오후 6시 30분
 *
 * 일정으로 보지 않는 것: 요일·시간 없이 붙여 쓴 날짜(예: "2011.11.11 이전 출생"), 공지 날짜와 1년 넘게 떨어진 날짜.
 */
import { GROUP_NAME_RE } from './group.ts';
import { kstDate, kstTime, toKstParts } from './time.ts';

export type EventKind =
  | '기념일'
  | '본인 확인'
  | '당첨 발표'
  | '신청'
  | '녹화'
  | '투표'
  | '판매'
  | '발매'
  | '모임'
  | '방송'
  | '행사'
  | '기타';

export interface ParsedEvent {
  date: string;
  time?: string;
  endDate?: string;
  endTime?: string;
  /** 일정 이름 (예: "신청 기간", "본인 확인 시간 · 당첨 번호 1 ~ 150번") */
  label: string;
  kind: EventKind;
  /** 일정이 나온 원문 줄 */
  detail: string;
  /** 한국 시간이 아닌 경우 현지 시간대 표기 (예: "PHT", "PDT"). 시간은 변환하지 않고 현지 시간 그대로 둔다. */
  timezone?: string;
  /** 요일이 날짜와 안 맞는 등 확신이 낮은 경우 */
  uncertain?: boolean;
}

interface DateTok {
  t: 'date';
  index: number;
  end: number;
  year?: number;
  month: number;
  day: number;
  /** "May 02-04, 2024"처럼 한 토큰 안에 끝 날짜가 있는 경우 */
  endDay?: number;
  weekday?: number;
  /** "2026. 11. 13"처럼 숫자 사이에 공백이 있는 표기 */
  spaced: boolean;
  numeric: boolean;
}

interface TimeTok {
  t: 'time';
  index: number;
  end: number;
  hour: number;
  minute: number;
}

type Tok = DateTok | TimeTok;

const WEEKDAYS: Record<string, number> = {
  일: 0, 월: 1, 화: 2, 수: 3, 목: 4, 금: 5, 토: 6,
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
};

function parseWeekday(s: string | undefined): number | undefined {
  if (!s) return undefined;
  const key = s.trim().toLowerCase();
  return WEEKDAYS[key] ?? WEEKDAYS[key.slice(0, 3)] ?? WEEKDAYS[key.charAt(0)];
}

const NUMERIC_DATE_RE = /(?<![\d.])(?:(\d{4})\s*\.\s*)?(\d{1,2})\s*\.\s*(\d{1,2})(?![\d])\.?(?:\s*\(([^)\d]{1,9})\))?/g;
const KOREAN_DATE_RE = /(?:(\d{4})\s*년\s*)?(\d{1,2})\s*월\s*(\d{1,2})\s*일(?:\s*\(([^)\d]{1,9})\))?/g;
/** "7/19 (토)": 분수 등과 헷갈리지 않게 요일이 붙은 경우만 */
const SLASH_DATE_RE = /(?<![\d/])(\d{1,2})\/(\d{1,2})(?![\d/])\s*\(([^)\d]{1,9})\)/g;
/** "May 02-04, 2024", "June 02, 2024" */
const ENGLISH_DATE_RE =
  /\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?\s+(\d{1,2})(?:\s*[-–~]\s*(\d{1,2}))?(?!\d)(?:\s*,\s*(\d{4}))?(?:\s*\(([^)\d]{1,9})\))?/gi;
const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
// 초 단위(5:59:59PM)는 읽되 버린다
const AMPM_TIME_RE = /(?<![\d:])(\d{1,2})(?::(\d{2}))?(?::\d{2})?\s*(AM|PM|A\.M\.|P\.M\.)/gi;
const KOREAN_TIME_RE = /(오전|오후|낮|밤|저녁|새벽|아침)\s*(\d{1,2})\s*시(?:\s*(\d{1,2})\s*분|\s*(반))?/g;
const CLOCK_TIME_RE = /(?<![\d:.])(\d{1,2}):(\d{2})(?::\d{2})?(?![\d:])/g;
/** 시간 뒤의 시간대 표기: "(KST)", "[KST]", "(PHT)", "까지 (KST)" */
const TIMEZONE_RE = /^\s*(?:까지|부터)?\s*[(\[]\s*([A-Z]{2,5})\s*[)\]]/;

function to24(hour: number, marker: string | undefined): number {
  const m = marker?.toLowerCase().replace(/\./g, '');
  if (m === 'pm' || m === '오후' || m === '저녁' || m === '밤' || (m === '낮' && hour < 6)) return hour < 12 ? hour + 12 : hour;
  if (m === 'am' || m === '오전' || m === '새벽' || m === '아침') return hour === 12 ? 0 : hour;
  return hour;
}

function tokenize(line: string): Tok[] {
  const toks: Tok[] = [];
  for (const m of line.matchAll(NUMERIC_DATE_RE)) {
    toks.push({
      t: 'date', index: m.index, end: m.index + m[0].length,
      year: m[1] ? Number(m[1]) : undefined, month: Number(m[2]), day: Number(m[3]),
      weekday: parseWeekday(m[4]), spaced: /\.\s/.test(m[0]), numeric: true,
    });
  }
  for (const m of line.matchAll(KOREAN_DATE_RE)) {
    toks.push({
      t: 'date', index: m.index, end: m.index + m[0].length,
      year: m[1] ? Number(m[1]) : undefined, month: Number(m[2]), day: Number(m[3]),
      weekday: parseWeekday(m[4]), spaced: true, numeric: false,
    });
  }
  for (const m of line.matchAll(SLASH_DATE_RE)) {
    toks.push({
      t: 'date', index: m.index, end: m.index + m[0].length,
      month: Number(m[1]), day: Number(m[2]), weekday: parseWeekday(m[3]), spaced: true, numeric: false,
    });
  }
  for (const m of line.matchAll(ENGLISH_DATE_RE)) {
    toks.push({
      t: 'date', index: m.index, end: m.index + m[0].length,
      year: m[4] ? Number(m[4]) : undefined, month: MONTHS[m[1].slice(0, 3).toLowerCase()], day: Number(m[2]),
      endDay: m[3] ? Number(m[3]) : undefined, weekday: parseWeekday(m[5]), spaced: true, numeric: false,
    });
  }
  for (const m of line.matchAll(AMPM_TIME_RE)) {
    toks.push({ t: 'time', index: m.index, end: m.index + m[0].length, hour: to24(Number(m[1]), m[3]), minute: Number(m[2] ?? 0) });
  }
  for (const m of line.matchAll(KOREAN_TIME_RE)) {
    const minute = m[4] ? 30 : Number(m[3] ?? 0);
    toks.push({ t: 'time', index: m.index, end: m.index + m[0].length, hour: to24(Number(m[2]), m[1]), minute });
  }
  for (const m of line.matchAll(CLOCK_TIME_RE)) {
    toks.push({ t: 'time', index: m.index, end: m.index + m[0].length, hour: Number(m[1]), minute: Number(m[2]) });
  }

  // 겹치는 토큰은 먼저 시작하고 더 긴 쪽만 남긴다 (예: "11:40AM"과 "11:40")
  toks.sort((a, b) => a.index - b.index || b.end - a.end);
  const out: Tok[] = [];
  for (const tok of toks) {
    const last = out[out.length - 1];
    if (last && tok.index < last.end) continue;
    if (tok.t === 'date' && (tok.month < 1 || tok.month > 12 || tok.day < 1 || tok.day > 31)) continue;
    if (tok.t === 'time' && (tok.hour > 24 || tok.minute > 59)) continue;
    out.push(tok);
  }
  return out;
}

const gapIsTight = (line: string, from: number, to: number) => /^[\s,]*$/.test(line.slice(from, to));
const gapIsRange = (line: string, from: number, to: number) =>
  /^\s*([(\[]KST[)\]])?\s*(부터)?\s*[~～〜–]\s*$/i.test(line.slice(from, to));

const HALF_YEAR_MS = 183 * 24 * 60 * 60 * 1000;
const preferred = (c: { distance: number; weekdayOk: boolean }) => c.weekdayOk && c.distance <= HALF_YEAR_MS;

/** 연도 없는 날짜는 공지 작성일과 가장 가까운 해로, 요일이 있으면 요일이 맞는 해를 우선한다 */
function resolveYear(tok: DateTok, posted: { year: number; month: number; day: number }): { year: number; uncertain: boolean } | null {
  const candidates = tok.year ? [tok.year] : [posted.year - 1, posted.year, posted.year + 1];
  const postedTime = Date.UTC(posted.year, posted.month - 1, posted.day);
  const scored = candidates
    .filter((y) => Math.abs(y - posted.year) <= 1)
    .map((y) => {
      const d = new Date(Date.UTC(y, tok.month - 1, tok.day));
      return { year: y, distance: Math.abs(d.getTime() - postedTime), weekdayOk: tok.weekday === undefined || d.getUTCDay() === tok.weekday };
    })
    // 요일이 맞는 해를 우선하되, 반년 넘게 떨어진 해는 요일이 맞아도 우선하지 않는다 (공지 요일 오타 대비)
    .sort((a, b) => Number(preferred(b)) - Number(preferred(a)) || a.distance - b.distance);
  const best = scored[0];
  if (!best) return null;
  // 연도 없이 쓴 날짜가 공지와 반년 넘게 떨어져 있고 요일 근거도 없으면 다른 숫자일 가능성이 크다
  if (!tok.year && tok.weekday === undefined && best.distance > HALF_YEAR_MS) return null;
  return { year: best.year, uncertain: !best.weekdayOk };
}

const BULLET_RE = /^[\s■□●○◆◇▶▷►•·*※\-–—>└ㄴ]+|^\s*(\d{1,2}[).]|[①-⑳])\s*/u;
const EMOJI_RE = /[\p{Extended_Pictographic}\u{FE0F}\u{200D}\u{20E3}]/gu;

function cleanLabel(s: string): string {
  let out = s.replace(EMOJI_RE, '').trim();
  let prev;
  do {
    prev = out;
    out = out.replace(BULLET_RE, '').trim();
  } while (out !== prev);
  return out.replace(/[\s:：|\-–—,(]+$/, '').replace(/\s{2,}/g, ' ').trim();
}

function truncate(s: string, max = 40): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

const KIND_RULES: [EventKind, RegExp][] = [
  ['본인 확인', /본인\s*확인/],
  ['당첨 발표', /당첨\s*(여부|발표|자\s*발표|자\s*확인|확인)|당첨자/],
  ['녹화', /녹화/],
  ['투표', /투표/],
  ['신청', /신청|응모|접수|모집|인증/],
  ['판매', /판매|sales|예약|예매|구매|티켓|pre-?order/i],
  ['발매', /발매|음원|OST|뮤직비디오|\bMV\b|티저|release/i],
  ['모임', /재모임|모임 시간|집합/],
  ['방송', /생방송|방송|출연|라이브|live/i],
  ['행사', /공연|콘서트|concert|팬미팅|fanmeeting|투어|tour|쇼케이스|리스닝|팝업|사인회|이벤트|event/i],
];

export function classify(text: string): EventKind {
  return KIND_RULES.find(([, re]) => re.test(text))?.[0] ?? '기타';
}

/** "스케줄 참여 신청하신 분은"처럼 일정 이름으로 쓰기 어색한 주어 문구 */
const SUBJECT_PHRASE_RE = /(하신|하실|되신)?\s*분(들)?(은|께서는|께서)?$/;
const KIND_DEFAULT_LABEL: Partial<Record<EventKind, string>> = {
  '당첨 발표': '당첨 여부 확인',
  '본인 확인': '본인 확인',
  신청: '신청 마감',
};

const SENTENCE_END_RE = /(니다|세요|해요|됩니다)[.!]?$/;

/** 공지 제목에서 일정 이름으로 쓸 부분: "[공지] NCT DREAM: The Harvest Day – DREAM AFTER DREAM 진행 안내" → "The Harvest Day – DREAM AFTER DREAM" */
export function noticeTopic(title: string): string {
  return shortNoticeTitle(title)
    .replace(/^[:：]\s*/, '')
    .replace(/\s*(진행|참여|초대 이벤트|이벤트)?\s*안내(드립니다)?[!.]?$/, '')
    .trim();
}

/** 위버스 버전 표시 등 본문 끝의 잡음 줄 */
const NOISE_LINE_RE = /^\d+\.\d+\.\d+(-[\w.]+)?$/;

/** 시간 바로 뒤의 시간대 표기. 한국 시간(KST)이면 undefined */
function timezoneAfter(line: string, index: number): string | undefined {
  const tz = line.slice(index).match(TIMEZONE_RE)?.[1];
  return tz && tz !== 'KST' ? tz : undefined;
}

/**
 * @param noticeTitle 줄 내용만으로 종류를 못 정할 때 공지 제목으로 판단한다 (예: 투어 일정 공지)
 */
export function parseScheduleFromBody(body: string, postedAtIso: string, noticeTitle = ''): ParsedEvent[] {
  const posted = toKstParts(new Date(postedAtIso));
  const events: ParsedEvent[] = [];
  let parentLabel = ''; // "■ 본인 확인 시간 :"처럼 날짜 없이 콜론으로 끝나는 머리 줄
  let contextLabel = ''; // 날짜가 없는 바로 앞 줄 (예: "📌Sales Notice")
  let paragraphHeader = ''; // 문단 맨 위의 "[SEOUL]" 같은 대괄호 머리 줄
  let lastLineEvent: ParsedEvent | null = null; // 시간만 다음 줄에 따로 쓴 경우를 위해

  for (const rawLine of body.split('\n')) {
    const line = rawLine.trim();
    // "※ 팬 카드는 11월 23일(월)부터 KWANGYA SEOUL에서 …" 같은 참고 문장은 일정이 아니다 (음악중심 사전녹화가 23일로 잡히던 문제)
    if (!line || NOISE_LINE_RE.test(line) || /^[※*＊]/.test(line)) {
      parentLabel = '';
      contextLabel = '';
      paragraphHeader = '';
      lastLineEvent = null;
      continue;
    }
    const isHeader = /^[■\[【]/.test(line);
    if (isHeader) parentLabel = '';

    const toks = tokenize(line);
    const lineEvents: ParsedEvent[] = [];
    let i = 0;
    while (i < toks.length) {
      const tok = toks[i];
      if (tok.t === 'time') {
        const prevInLine = lineEvents[lineEvents.length - 1];
        if (prevInLine?.time) {
          // "11월 13일 (금) 2PM, 6PM"처럼 같은 날 시간을 여러 개 쓴 경우
          lineEvents.push({ ...prevInLine, time: kstTime(tok.hour, tok.minute), endDate: undefined, endTime: undefined });
        } else if (prevInLine && !prevInLine.time) {
          prevInLine.time = kstTime(tok.hour, tok.minute);
        } else if (!lineEvents.length && lastLineEvent && !lastLineEvent.time) {
          lastLineEvent.time = kstTime(tok.hour, tok.minute);
        }
        i++;
        continue;
      }

      let j = i + 1;
      const startTime = toks[j]?.t === 'time' && gapIsTight(line, tok.end, toks[j].index) ? (toks[j++] as TimeTok) : undefined;
      // 붙여 쓴 숫자 날짜는 요일이나 시간이 함께 있을 때만 일정으로 본다
      if (tok.numeric && tok.weekday === undefined && !startTime && !(tok.year && tok.spaced)) {
        i = j;
        continue;
      }
      const resolved = resolveYear(tok, posted);
      if (!resolved) {
        i = j;
        continue;
      }

      const event: ParsedEvent = {
        date: kstDate(resolved.year, tok.month, tok.day),
        time: startTime ? kstTime(startTime.hour, startTime.minute) : undefined,
        endDate: tok.endDay ? kstDate(resolved.year, tok.month, tok.endDay) : undefined,
        label: '',
        kind: '기타',
        detail: line,
        timezone: startTime ? timezoneAfter(line, startTime.end) : undefined,
        uncertain: resolved.uncertain || undefined,
      };

      const prevEnd = startTime ? startTime.end : tok.end;
      const next = toks[j];
      if (next && gapIsRange(line, prevEnd, next.index)) {
        if (next.t === 'date') {
          const endResolved = resolveYear(next, { year: resolved.year, month: tok.month, day: tok.day });
          if (endResolved) event.endDate = kstDate(endResolved.year, next.month, next.day);
          j++;
          const endTime = toks[j]?.t === 'time' && gapIsTight(line, next.end, toks[j].index) ? (toks[j++] as TimeTok) : undefined;
          if (endTime) {
            event.endTime = kstTime(endTime.hour, endTime.minute);
            event.timezone ??= timezoneAfter(line, endTime.end);
          }
        } else {
          event.endTime = kstTime(next.hour, next.minute);
          event.timezone ??= timezoneAfter(line, next.end);
          j++;
        }
      }
      lineEvents.push(event);
      i = j;
    }

    if (lineEvents.length) {
      const before = cleanLabel(line.slice(0, toks[0].index));
      const after = cleanLabel(
        line.slice(toks[toks.length - 1].end).replace(/^[\s,]*([(\[][A-Z]{2,5}[)\]])?\s*(부터|까지|이후|이전)?[\s,]*/i, ''),
      );
      let label = before;
      if (!label && contextLabel) {
        // "[SEOUL]" 다음 줄 "📍GOCHEOK SKY DOME" 다음 줄이 날짜인 경우 → "SEOUL · GOCHEOK SKY DOME"
        label = paragraphHeader && paragraphHeader !== contextLabel ? `${paragraphHeader} · ${contextLabel}` : contextLabel;
      }
      // 날짜 뒤가 "큐브컨벤션센터에서 진행됩니다."처럼 문장이면 공지 제목이 더 나은 이름이다
      if (!label) label = after && !SENTENCE_END_RE.test(after) ? after : noticeTitle ? noticeTopic(noticeTitle) : after || '일정';
      if (parentLabel && !isHeader && label !== parentLabel) label = `${parentLabel} · ${label}`;

      let kind = classify(`${label} ${line}`);
      if (kind === '기타' && noticeTitle) kind = classify(noticeTitle);
      if (SUBJECT_PHRASE_RE.test(label)) label = KIND_DEFAULT_LABEL[kind] ?? (after || label);

      for (const e of lineEvents) {
        e.label = truncate(label);
        e.kind = kind;
        events.push(e);
      }
      lastLineEvent = lineEvents[lineEvents.length - 1];
    } else {
      lastLineEvent = toks.length ? lastLineEvent : null;
      const cleaned = cleanLabel(line);
      const bracketOnly = line.match(/^[\[【]([^\]】]+)[\]】]$/);
      if (bracketOnly) paragraphHeader = cleanLabel(bracketOnly[1]);
      if (/[:：]\s*$/.test(line)) parentLabel = cleaned;
      if (cleaned && cleaned.length <= 40) contextLabel = bracketOnly ? paragraphHeader : cleaned;
    }
  }

  // 같은 공지 안에서 같은 일정이 반복되면 하나만 남긴다 (예: 한/영 병기)
  const seen = new Set<string>();
  return events.filter((e) => {
    const key = [e.date, e.time, e.endDate, e.endTime, e.kind].join('|');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const MUSIC_SHOW_RE = /뮤직뱅크|음악중심|인기가요|엠카운트다운|쇼챔피언|더 ?쇼|방송/;

/** 공지 제목의 "261113 (금)" 또는 "7/19 (토)" 날짜로 출연·행사 일정을 만든다 */
export function parseScheduleFromTitle(title: string, postedAtIso: string): ParsedEvent | null {
  const posted = toKstParts(new Date(postedAtIso));
  let date: string;
  let uncertain: boolean | undefined;

  const compact = title.match(/(?<!\d)(\d{2})(\d{2})(\d{2})(?!\d)\s*(?:\(([^)\d]{1,9})\))?/);
  const slash = title.match(/(?<![\d/])(\d{1,2})\/(\d{1,2})(?![\d/])\s*\(([^)\d]{1,9})\)/);
  if (compact) {
    const [year, month, day] = [2000 + Number(compact[1]), Number(compact[2]), Number(compact[3])];
    if (month < 1 || month > 12 || day < 1 || day > 31 || Math.abs(year - posted.year) > 1) return null;
    const weekday = parseWeekday(compact[4]);
    date = kstDate(year, month, day);
    uncertain = weekday !== undefined && new Date(Date.UTC(year, month - 1, day)).getUTCDay() !== weekday ? true : undefined;
  } else if (slash) {
    const tok: DateTok = {
      t: 'date', index: 0, end: 0, month: Number(slash[1]), day: Number(slash[2]),
      weekday: parseWeekday(slash[3]), spaced: true, numeric: false,
    };
    if (tok.month < 1 || tok.month > 12 || tok.day < 1 || tok.day > 31) return null;
    const resolved = resolveYear(tok, posted);
    if (!resolved) return null;
    date = kstDate(resolved.year, tok.month, tok.day);
    uncertain = resolved.uncertain || undefined;
  } else {
    return null;
  }

  const label = shortNoticeTitle(title);
  const kind = classify(label);
  return {
    date,
    label: truncate(label, 60),
    kind: kind === '녹화' || MUSIC_SHOW_RE.test(label) ? '방송' : kind,
    detail: title,
    uncertain,
  };
}

/**
 * "[공지] 261113 (금) NCT DREAM KBS 뮤직뱅크 <…> 사전녹화 참여 안내" → "KBS 뮤직뱅크 <…> 사전녹화 참여 안내"
 * "[공지] NCT DREAM “7/19 (토) MBC 쇼! 음악중심 ‘BTTF’ 사전녹화” 참여 안내" → "MBC 쇼! 음악중심 ‘BTTF’ 사전녹화 참여 안내"
 */
export function shortNoticeTitle(title: string): string {
  return title
    .replace(/^\s*\[[^\]]*\]\s*/, '')
    .replace(/(?<!\d)\d{6}(?!\d)\s*(\([^)]*\))?\s*/, '')
    .replace(/(?<![\d/])\d{1,2}\/\d{1,2}(?![\d/])\s*(\([^)]*\))?\s*/, '')
    .replace(/[“”"]/g, '')
    .replace(new RegExp(`^(${GROUP_NAME_RE.source})\\s*`, 'i'), '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}
