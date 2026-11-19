/**
 * 빈칸 채우기: 합친 결과에서 비어 있는 정보를 찾을 검색어를 만든다.
 * 찾은 기사·영상은 다른 문서와 똑같은 흐름(AI 추출 → 검증 → 합치기)으로 들어가서 빈칸이 채워진다.
 *
 *  - 시간이 없는 다가오는 일정 → "{대상} {M월 D일}" 기사, 유튜브에서 "{대상}" 영상 (공개 시각)
 *  - 날짜 미정 소식 → "{대상} 날짜", "{대상} 일정"
 *  - 다가오는 행사(시상식·공연) → "{대상} 티켓", "{대상} 생중계" (관련 일정)
 *  - 투표·예매 기간에서 빠진 쪽 → "{대상} 마감" / "{대상} 시작"
 * 같은 검색은 12시간(관련 일정은 24시간)에 한 번만. 일정이 지나면 그만 찾는다.
 */
import { BROADCASTER_PREFIX_RE } from './broadcasters.ts';
import { PERIOD_KINDS, type PendingItem, type PublicEvent, type RumorItem } from './consolidate.ts';
import type { NewsQuery } from './news.ts';
import type { Repo } from './repo.ts';
import { trackedQueries, type Tracked } from './tracked.ts';
import { kstDate, toKstParts } from './time.ts';

export interface FillPlan {
  news: NewsQuery[];
  youtube: { focus: string; after: Date }[];
}

const MAX_NEWS = 12;
const MAX_YOUTUBE = 4;
const BROADCASTER_RE = BROADCASTER_PREFIX_RE;
const core = (title: string) => title.replace(BROADCASTER_RE, '').trim();
const md = (date: string) => `${Number(date.slice(5, 7))}월 ${Number(date.slice(8, 10))}일`;

export async function planFill(
  repo: Repo, events: PublicEvent[], pending: PendingItem[], now: Date, tracked: Tracked[] = [], rumors: RumorItem[] = [], review: PublicEvent[] = [],
): Promise<FillPlan> {
  const state = await repo.getState<Record<string, string>>('fill', {});
  const p = toKstParts(now);
  const today = kstDate(p.year, p.month, p.day);
  const s30 = toKstParts(new Date(now.getTime() + 30 * 24 * 3600 * 1000));
  const soon = kstDate(s30.year, s30.month, s30.day);
  const due = (key: string, hours: number) => !state[key] || now.getTime() - Date.parse(state[key]) > hours * 3600 * 1000;
  const plan: FillPlan = { news: [], youtube: [] };
  const mark = (key: string) => (state[key] = now.toISOString());

  // 시간이 빈 다가오는 일정 (한 달 안)
  for (const e of events) {
    if (e.time || e.date < today || e.date > soon || e.seriesId) continue;
    const key = `time:${core(e.title)}:${e.date}`;
    if (!due(key, 12)) continue;
    if (plan.news.length < MAX_NEWS) plan.news.push({ q: `${core(e.title)} ${md(e.date)}`, days: 30, focus: e.title });
    if ((e.kind === '방송' || e.kind === '발매') && plan.youtube.length < MAX_YOUTUBE) {
      plan.youtube.push({ focus: core(e.title), after: new Date(new Date(`${e.date}T00:00:00+09:00`).getTime() - 2 * 24 * 3600 * 1000) });
    }
    mark(key);
  }

  // 영상 링크가 아직 없는 방송·공개 일정은 시간이 있어도 유튜브 검색 (공개되면 링크·실제 시각 채우기)
  // 공개 예정일 3일 전부터, 공개가 늦어지는 경우를 위해 7일 뒤까지
  const d3 = toKstParts(new Date(now.getTime() + 3 * 24 * 3600 * 1000));
  const yday = toKstParts(new Date(now.getTime() - 7 * 24 * 3600 * 1000));
  for (const e of events) {
    if (e.kind !== '방송' && e.kind !== '발매') continue;
    if (e.date < kstDate(yday.year, yday.month, yday.day) || e.date > kstDate(d3.year, d3.month, d3.day)) continue;
    if (e.sources.some((s) => s.type === 'youtube') || e.seriesId) continue;
    const key = `link:${core(e.title)}:${e.date}`;
    if (!due(key, 6) || plan.youtube.length >= MAX_YOUTUBE + 4) continue;
    plan.youtube.push({ focus: core(e.title), after: new Date(new Date(`${e.date}T00:00:00+09:00`).getTime() - 24 * 3600 * 1000) });
    mark(key);
  }

  // 투표·예매·신청 기간에서 빠진 쪽 찾기: 시작만 있으면 "마감", 마감만 있으면 "시작"
  for (const e of events) {
    if (!PERIOD_KINDS.includes(e.kind) || e.endDate || e.flowId) continue;
    const isEnd = /(마감|종료)\s*$/.test(e.step);
    // 시작만 있는 건 시작이 지나도 마감 전까지 찾는다 (최근 30일 안), 마감만 있는 건 마감 전까지
    if (isEnd ? e.date < today : e.date < kstDate(yday.year, yday.month, yday.day)) continue;
    const key = `period:${core(e.title)}:${e.step}`;
    if (!due(key, 24) || plan.news.length >= MAX_NEWS) continue;
    plan.news.push({ q: `${core(e.title)} ${isEnd ? '시작' : '마감'}`, days: 45, focus: e.title });
    mark(key);
  }

  // 확인 대기: 다가오는(또는 지난 3일) 일정의 두 번째 출처 찾기
  const back3 = toKstParts(new Date(now.getTime() - 3 * 24 * 3600 * 1000));
  for (const e of review) {
    if (e.date < kstDate(back3.year, back3.month, back3.day) || e.date > soon) continue;
    const key = `review:${core(e.title)}:${e.date}`;
    if (!due(key, 12) || plan.news.length >= MAX_NEWS) continue;
    plan.news.push({ q: `${core(e.title)} ${md(e.date)}`, days: 30, focus: e.title });
    mark(key);
  }

  // 추측·예고: 예고일 3일 전부터 7일 뒤까지 유튜브에서 프로그램 이름으로 (티저·본편 설명에 멤버가 나오면 확정)
  for (const r of rumors) {
    const d = Date.parse(`${r.date}T00:00:00+09:00`);
    if (now.getTime() < d - 3 * 864e5 || now.getTime() > d + 7 * 864e5) continue;
    const key = `rumor:${core(r.title)}:${r.date}`;
    if (!due(key, 3) || plan.youtube.length >= MAX_YOUTUBE + 6) continue;
    plan.youtube.push({ focus: core(r.title), after: new Date(d - 5 * 864e5) });
    mark(key);
  }

  // 날짜 미정 소식
  for (const x of pending) {
    const key = `date:${core(x.title)}`;
    if (!due(key, 12) || plan.news.length >= MAX_NEWS) continue;
    plan.news.push({ q: `${core(x.title)} 날짜`, days: 60, focus: x.title }, { q: `${core(x.title)} 일정`, days: 60, focus: x.title });
    mark(key);
  }

  // 다가오는 행사의 관련 일정 (티켓·생중계)
  const seen = new Set<string>();
  for (const e of events) {
    if (e.kind !== '행사' || e.date < today || seen.has(core(e.title))) continue;
    seen.add(core(e.title));
    const key = `related:${core(e.title)}`;
    if (!due(key, 24) || plan.news.length >= MAX_NEWS) continue;
    plan.news.push({ q: `${core(e.title)} 티켓`, days: 90, focus: e.title }, { q: `${core(e.title)} 생중계`, days: 30, focus: e.title });
    mark(key);
  }

  // 추적 목록(고정 출연): 하루 한 번 결방·종영·방송 시간 기사 확인
  for (const t of trackedQueries(tracked)) {
    if (!due(t.key, 24)) continue;
    plan.news.push(...t.queries);
    mark(t.key);
  }

  // 오래된 기록 정리 (60일)
  for (const [k, at] of Object.entries(state)) if (now.getTime() - Date.parse(at) > 60 * 24 * 3600 * 1000) delete state[k];
  await repo.putState('fill', state);
  return plan;
}
