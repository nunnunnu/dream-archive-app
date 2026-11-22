/**
 * 사이트용 결과 내보내기 (data/public/). 데이터 형식은 data/public/README.md 참고.
 *  - events.json        일정 (합친 결과)
 *  - pending.json       날짜 미정 소식
 *  - rumors.json        추측·예고 (멤버 미확인. 캘린더에는 넣지 않음)
 *  - feed.json          최근 소식 (공지·기사·영상)
 *  - calendar/*.ics     캘린더 구독 파일 (전체, 단체, 멤버별)
 *  - meta.json          만든 시각·개수
 */
import { GROUP_NAME_RE, PARENT_RE } from './group.ts';
import { isNegative } from './topics.ts';
import { topicOf, type FeedTopic } from './topics.ts';
import { toKst } from './timezones.ts';
import { PERIOD_KINDS, type PendingItem, type PublicEvent, type ReviewItem, type RumorItem } from './consolidate.ts';
import { readJson } from './store.ts';
import type { TagInfo } from './tags.ts';
import { GROUP } from './group.ts';
import { MEMBERS, mentionedMembers } from './members.ts';
import type { Repo } from './repo.ts';
import type { Video } from './youtube.ts';

export interface FeedItem {
  type: 'weverse-notice' | 'news' | 'youtube' | 'sns';
  title: string;
  url: string;
  publishedAt: string;
  publisher?: string;
  members: string[];
  /** 소식 주제 (공항·브랜드·화보) */
  topic?: FeedTopic;
  /** 같은 소식 기사 수 (기사일 때) */
  count?: number;
  /** 같은 소식으로 묶인 매체별 기사 (펼쳐 보기용, 시간순) */
  articles?: { title: string; url: string; publisher: string; publishedAt: string }[];
  /** 다른 가수가 주인공일 수 있는 기사 (제목 첫 주어에 그룹·멤버 이름이 없음): 사진을 쓰지 않고 사진 칸에서 뺀다 */
  shared?: boolean;
  /** 영상 길이(초)·라이브 여부 */
  duration?: number;
  live?: boolean;
  /** 모아보기 태그 */
  tags?: string[];
  /** 원문이 공개한 대표 이미지 주소 (이미지 파일은 저장하지 않음) */
  image?: string;
}

const MEMBER_SLUG: Record<string, string> = Object.fromEntries(GROUP.members.map((m) => [m.name, m.slug]));

// ── iCalendar (.ics) ────────────────────────────────────────────

const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
/** 한 줄 75바이트 제한: 한글이 있어서 글자 수 기준으로 넉넉히 자른다 */
const fold = (line: string) => line.match(/.{1,60}/gu)!.join('\r\n ');
const ymd = (d: string) => d.replace(/-/g, '');
const nextDay = (d: string) => {
  const x = new Date(`${d}T00:00:00Z`);
  x.setUTCDate(x.getUTCDate() + 1);
  return x.toISOString().slice(0, 10);
};
const addHour = (time: string) => `${String((Number(time.slice(0, 2)) + 1) % 24).padStart(2, '0')}${time.slice(3, 5)}`;

const REGISTERED = new Set(GROUP.youtube.channels.map((c) => c.name));

export interface ChangeReport {
  at: string;
  added: { date: string; time: string | null; title: string; step: string }[];
  removed: { date: string; time: string | null; title: string; step: string }[];
  changed: { title: string; step: string; from: string; to: string }[];
}

/** 이번 실행에서 새로 생기거나 빠지거나 시간이 바뀐 일정 (지난 일정은 빼고) */
function diffEvents(before: PublicEvent[], after: PublicEvent[], now: Date): ChangeReport {
  const today = new Date(now.getTime() + 9 * 3600 * 1000).toISOString().slice(0, 10);
  const brief = (e: PublicEvent) => ({ date: e.date, time: e.time, title: e.title, step: e.step });
  const prev = new Map(before.map((e) => [e.id, e]));
  const next = new Map(after.map((e) => [e.id, e]));
  const when = (e: PublicEvent) => `${e.date} ${e.time ?? '시간 미정'}`;
  return {
    at: now.toISOString(),
    added: after.filter((e) => !prev.has(e.id) && e.date >= today).map(brief),
    removed: before.filter((e) => !next.has(e.id) && e.date >= today).map(brief),
    changed: after.filter((e) => e.date >= today && prev.has(e.id) && when(prev.get(e.id)!) !== when(e)).map((e) => ({ title: e.title, step: e.step, from: when(prev.get(e.id)!), to: when(e) })),
  };
}

function ics(name: string, events: PublicEvent[], now: Date): string {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', `PRODID:-//${GROUP.id}-archive//KO`, 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    `X-WR-CALNAME:${esc(name)}`, 'X-WR-TIMEZONE:Asia/Seoul',
    'BEGIN:VTIMEZONE', 'TZID:Asia/Seoul', 'BEGIN:STANDARD', 'DTSTART:19700101T000000', 'TZOFFSETFROM:+0900', 'TZOFFSETTO:+0900', 'TZNAME:KST', 'END:STANDARD', 'END:VTIMEZONE',
  ];
  for (const e of events) {
    const who = e.members.length ? `[${e.members.join('·')}] ` : '';
    const localNote = e.timezone ? ` (현지 ${e.time ?? ''} ${e.timezone})`.replace('  ', ' ') : '';
    // 여러 날에 걸친 투표·예매·신청은 시작과 마감을 따로 넣는다 (중요한 건 열리는 순간과 닫히는 순간)
    const split = PERIOD_KINDS.includes(e.kind) && e.endDate && e.endDate !== e.date;
    const entries = split
      ? [
          { uid: `${e.id}-start`, date: e.date, time: e.time, endDate: null, endTime: null, point: false, suffix: ' 시작' },
          { uid: `${e.id}-end`, date: e.endDate!, time: e.endTime, endDate: null, endTime: null, point: true, suffix: ' 마감' },
        ]
      : e.endDate && e.endDate !== e.date
        // 여러 날 이어지는 일정(팝업 운영 등)은 하루 종일 기간으로 (시간은 제목에)
        ? [{ uid: e.id, date: e.date, time: null, endDate: e.endDate, endTime: null, point: false, suffix: e.time ? ` (${e.time}${e.endTime ? `~${e.endTime}` : ''})` : '' }]
        : [{ uid: e.id, date: e.date, time: e.time, endDate: e.endDate, endTime: e.endTime, point: false, suffix: '' }];
    for (let x of entries) {
      lines.push('BEGIN:VEVENT', `UID:${x.uid}@${GROUP.id}-archive`, `DTSTAMP:${stamp}`);
      if (x.time && e.timezone && !e.tzid) {
        // 시간대를 모르는 현지 시각은 하루 종일로 (제목에 현지 시각 표시)
        lines.push(`DTSTART;VALUE=DATE:${ymd(x.date)}`, `DTEND;VALUE=DATE:${ymd(nextDay(x.date))}`);
      } else if (x.time) {
        // 해외 현지 시각은 한국 시각으로 바꿔 넣는다 (예: 자카르타 19:00 WIB → 21:00 KST)
        const tz = ';TZID=Asia/Seoul';
        const k = e.tzid ? toKst(x.date, x.time, e.tzid) : { date: x.date, time: x.time };
        x = { ...x, date: k.date, time: k.time, endTime: x.endTime && e.tzid ? toKst(x.endDate ?? x.date, x.endTime, e.tzid).time : x.endTime };
        const start = `${ymd(x.date)}T${x.time!.replace(':', '')}00`;
        lines.push(`DTSTART${tz}:${start}`);
        lines.push(`DTEND${tz}:${x.point ? start : `${ymd(x.endDate ?? x.date)}T${x.endTime ? x.endTime.replace(':', '') : addHour(x.time!)}00`}`);
      } else {
        lines.push(`DTSTART;VALUE=DATE:${ymd(x.date)}`, `DTEND;VALUE=DATE:${ymd(nextDay(x.endDate ?? x.date))}`);
      }
      lines.push(
        fold(`SUMMARY:${esc(`${who}${e.title} · ${e.step}${x.suffix}${localNote}${e.status === 'needs-check' ? ' (확인 필요)' : ''}`)}`),
        fold(`DESCRIPTION:${esc(`${e.evidence}\n\n출처: ${e.sources.map((s) => s.url).join(' ')}`)}`),
        fold(`URL:${e.sources[0]?.url ?? ''}`),
        'END:VEVENT',
      );
    }
  }
  lines.push('END:VCALENDAR');
  return lines.join('\r\n') + '\r\n';
}

export async function publishAll(
  repo: Repo,
  data: { events: PublicEvent[]; pending: PendingItem[]; rumors: RumorItem[]; review: ReviewItem[]; feed: FeedItem[]; tags: TagInfo[] },
  now: Date,
): Promise<ChangeReport> {
  const generatedAt = now.toISOString();
  const before = await readJson<{ events: PublicEvent[] }>('public/events.json', { events: [] });
  const report = diffEvents(before.events, data.events, now);
  await repo.putState('changes', report);
  await repo.publish('events.json', { generatedAt, events: data.events });
  // 일정 화면용 달별 파일: 그 달에 걸친 일정만 (화면은 보는 달 앞뒤만 받는다). 기간 일정은 걸친 달마다 (최대 3달)
  const byMonth = new Map<string, PublicEvent[]>();
  for (const e of data.events) {
    const end = e.endDate && e.endDate > e.date ? e.endDate : e.date;
    for (let ym = e.date.slice(0, 7), n = 0; ym <= end.slice(0, 7) && n < 3; n++) {
      byMonth.set(ym, [...(byMonth.get(ym) ?? []), e]);
      const [y, m] = ym.split('-').map(Number);
      ym = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
    }
  }
  for (const [ym, list] of byMonth) await repo.publish(`events/${ym}.json`, { generatedAt, month: ym, events: list });
  await repo.publish('events/months.json', { generatedAt, months: Object.fromEntries([...byMonth].sort().map(([ym, l]) => [ym, l.length])) });
  // 확인 대기: 출처가 하나뿐인 일정 (캘린더에는 넣지 않음)
  await repo.publish('review.json', { generatedAt, items: data.review });
  await repo.publish('pending.json', { generatedAt, items: data.pending });
  // 추측·예고는 캘린더(.ics)에 넣지 않고 따로
  await repo.publish('rumors.json', { generatedAt, items: data.rumors });
  await repo.publish('feed.json', { generatedAt, items: data.feed });
  await repo.publish('tags.json', { generatedAt, tags: data.tags });

  // 기본 구독에는 당첨자만 가는 단계(본인 확인·녹화·재모임 등)를 넣지 않는다
  const common = data.events.filter((e) => e.audience === 'all');
  await repo.publish('calendar/all.ics', ics(`${GROUP.name} 일정`, common, now));
  const official = data.events
    .filter((e) => (e.audience === 'all' || e.kind === '녹화') && (e.calendars ?? [e.category]).includes('공식'))
    .map((e) => (e.kind === '녹화' ? { ...e, step: `${e.step} (사전녹화 · 당첨자 입장)` } : e));
  await repo.publish('calendar/official.ics', ics(`${GROUP.name} 공식 일정 (방송·공연·행사·공개)`, official, now));
  await repo.publish('calendar/participate.ics', ics(`${GROUP.name} 참여 일정 (사전 예약·티켓팅·본인 인증·신청·투표)`, common.filter((e) => (e.calendars ?? [e.category]).includes('참여')), now));
  await repo.publish('calendar/group.ics', ics(`${GROUP.name} 단체 일정`, common.filter((e) => e.scope === '단체'), now));
  for (const m of MEMBERS) {
    const slug = MEMBER_SLUG[m.name];
    if (!slug) continue;
    // 멤버 캘린더 = 그 멤버 일정 + 단체 일정
    const list = common.filter((e) => e.members.includes(m.name) || e.scope === '단체');
    await repo.publish(`calendar/${slug}.ics`, ics(`${GROUP.name} ${m.name} 일정`, list, now));
  }
  // 신청이 있는 일정 묶음별: 당첨된 사람이 남은 단계를 한 번에 추가하는 용도
  const flows = new Map<string, PublicEvent[]>();
  for (const e of data.events) if (e.flowId) flows.set(e.flowId, [...(flows.get(e.flowId) ?? []), e]);
  for (const [id, list] of flows) await repo.publish(`calendar/flows/${id}.ics`, ics(`${list[0].title} (당첨자용)`, list, now));
  await repo.publish('meta.json', {
    generatedAt,
    counts: { events: data.events.length, pending: data.pending.length, rumors: data.rumors.length, feed: data.feed.length },
    calendars: ['all', 'official', 'participate', 'group', ...Object.values(MEMBER_SLUG)].map((s) => `calendar/${s}.ics`),
  });
  return report;
}

/** 최근 소식 피드: 공지(60일), 같은 소식 묶음별 대표 기사(14일), 영상(30일) */
/** 제목의 첫 주어(첫 쉼표·가운뎃점·말줄임·따옴표 앞)에 그룹·멤버 이름이 있나 */
const MEMBER_ALIAS_RE = new RegExp(MEMBERS.flatMap((m) => m.aliases).map((a) => a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'i');
export const leadsWithGroup = (title: string) => {
  const head = title.replace(/^\s*\[[^\]]*\]\s*/, '').split(/[,，…·|]|\.{2,}|\s-\s/)[0];
  return GROUP_NAME_RE.test(head) || MEMBER_ALIAS_RE.test(head) || (PARENT_RE.test(head) && MEMBER_ALIAS_RE.test(title));
};

export function buildFeed(
  notices: { title: string; url: string; postedAt: string }[],
  articleClusters: { title: string; url: string; publishedAt: string; publisher: string; count: number; image?: string; articles?: FeedItem['articles'] }[],
  videos: Video[],
  now: Date,
  posts: { title: string; link?: string; label?: string; postedAt: string; members: string[] }[] = [],
): FeedItem[] {
  const items: FeedItem[] = [
    ...notices.map((n) => ({ type: 'weverse-notice' as const, title: n.title, url: n.url, publishedAt: n.postedAt, members: mentionedMembers(n.title).members })),
    ...articleClusters.map((a) => ({ type: 'news' as const, title: a.title, url: a.url, publishedAt: a.publishedAt, publisher: a.publisher, count: a.count, members: mentionedMembers(a.title).members, image: a.image, ...(a.articles && a.articles.length > 1 ? { articles: a.articles } : {}) })),
    ...posts.filter((p) => p.link).map((p) => ({ type: 'sns' as const, title: p.title.replace(/^\s*\[[^\]]{1,40}\]\s*/, ''), url: p.link!, publishedAt: p.postedAt, publisher: p.label, members: p.members })),
    ...videos.filter((v) => REGISTERED.has(v.channel) || v.guest).map((v) => ({ type: 'youtube' as const, title: v.title, url: v.url, publishedAt: v.publishedAt, publisher: v.channel, members: v.who.members, ...(v.duration ? { duration: v.duration } : {}), ...(/🔴|\bLIVE\b|라이브/i.test(v.title) ? { live: true } : {}) })),
  ];
  for (const it of items) { const t = topicOf(it.title); if (t) it.topic = t; }
  // 다른 가수 이름이 앞에 나오는 기사("아일릿, 한터차트 미국 1위…NCT DREAM …")는 대표 사진이 다른 가수일 수 있다 → 사진 빼고 표시
  for (const it of items) if (it.type === 'news' && !leadsWithGroup(it.title)) { it.shared = true; delete it.image; }
  // 부정적인 기사(논란·가십)는 올리지 않는다
  return items.filter((it) => it.type !== 'news' || !isNegative(it.title)).sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
}
