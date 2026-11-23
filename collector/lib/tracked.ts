/**
 * 추적 목록: 주기적으로 확인해야 하는 고정 출연(드라마·고정 예능·라디오 고정 코너 등)
 *
 *  - 자동 등록: 합치기 결과에서 매주 반복 방송(seriesId)이 나오면 올린다
 *  - 직접 등록: npm run track -- "ENA 크래시2" --members 지성 --days 월,화 --time 22:00 --start 2026-11-16
 *  - 하루 한 번 "결방", "종영", "방송 시간" 기사를 찾아 같은 흐름(AI 해석 → 검증 → 합치기)으로 반영한다
 *  - 종영일이나 마지막 회가 지나면 추적을 멈춘다
 */
import { stripBroadcaster } from './broadcasters.ts';
import type { ExtractedItem, PublicEvent, SourceRef } from './consolidate.ts';
import type { NewsQuery } from './news.ts';
import type { Repo } from './repo.ts';

export interface Tracked {
  id: string;
  title: string;
  members: string[];
  /** 방송 요일 ("월", "화" …) */
  weekdays: string[];
  time: string | null;
  startDate: string;
  episodes: number | null;
  endDate: string | null;
  status: 'active' | 'ended';
  origin: 'auto' | 'manual';
  sources: SourceRef[];
  addedAt: string;
}

const STATE_KEY = 'tracked';
const core = (t: string) => stripBroadcaster(t).split(/\s*[:：]\s*/)[0].trim();
export const showKey = (t: string) => core(t).replace(/[^\p{L}\p{N}]+/gu, '').toLowerCase();

export const loadTracked = (repo: Repo) => repo.getState<Tracked[]>(STATE_KEY, []);

/** 직접 등록한 고정 출연을 합치기 단계의 입력으로 (반복 정보가 있는 일정 하나) */
export function itemsFromTracked(list: Tracked[]): ExtractedItem[] {
  return list
    .filter((t) => t.origin === 'manual' && t.status === 'active')
    .map((t) => ({
      date: t.startDate, time: t.time, end_date: null, end_time: null, timezone: null,
      target: t.title, step: '첫 방송', kind: '방송' as const, members: t.members,
      evidence: `추적 목록: 매주 ${t.weekdays.join('·')} ${t.time ?? ''}`.trim(), verified: true, problems: [],
      recurrence: { weekdays: t.weekdays, episodes: t.episodes, end_date: t.endDate },
      source: t.sources[0] ?? { type: 'submission' as const, id: `tracked-${t.id}`, url: '', title: `추적 목록: ${t.title}`, publishedAt: t.addedAt },
      by: 'rule' as const,
    }));
}

/** 합치기 결과의 반복 방송을 추적 목록에 올리고, 끝난 것은 멈춘다 */
export async function syncTracked(repo: Repo, events: PublicEvent[], today: string, now: Date): Promise<Tracked[]> {
  const list = await loadTracked(repo);
  const bySeries = new Map<string, PublicEvent[]>();
  for (const e of events) if (e.seriesId) bySeries.set(e.seriesId, [...(bySeries.get(e.seriesId) ?? []), e]);
  const seen = new Set<Tracked>();

  for (const [seriesId, eps] of bySeries) {
    const first = eps.reduce((a, b) => (a.date < b.date ? a : b));
    const weekdays = [...new Set(eps.map((e) => '일월화수목금토'[new Date(`${e.date}T00:00:00Z`).getUTCDay()]))];
    const existing = list.find((t) => t.id === seriesId || showKey(t.title) === showKey(first.title));
    const t: Tracked = existing ?? {
      id: seriesId, title: first.title, members: first.members, weekdays, time: first.time, startDate: first.date,
      episodes: null, endDate: null, status: 'active', origin: 'auto', sources: first.sources.slice(0, 3), addedAt: now.toISOString(),
    };
    if (t.origin === 'auto') Object.assign(t, { title: first.title, members: first.members, weekdays, time: first.time ?? t.time, startDate: first.date });
    const last = eps.find((e) => /마지막 회/.test(e.step));
    if (last) t.endDate = last.date;
    if (!existing) list.push(t);
    seen.add(t);
  }
  for (const t of list) {
    if (t.endDate && t.endDate < today) t.status = 'ended';
    // 근거 없는 자동 반복이 사라지면 해당 편성 검색도 중단한다.
    if (t.origin === 'auto' && !seen.has(t) && !t.endDate && !t.episodes) t.status = 'ended';
  }
  // 직접 등록한 것과 같은 프로그램의 자동 등록은 지운다 (직접 등록이 기준)
  const manual = new Set(list.filter((t) => t.origin === 'manual').map((t) => showKey(t.title)));
  const kept = list.filter((t) => t.origin === 'manual' || !manual.has(showKey(t.title)));
  await repo.putState(STATE_KEY, kept);
  return kept;
}

/** 진행 중인 고정 출연마다 하루 한 번 확인할 기사 검색어 */
export function trackedQueries(list: Tracked[]): { key: string; queries: NewsQuery[] }[] {
  return list
    .filter((t) => t.status === 'active')
    .map((t) => ({
      key: `tracked:${t.id}`,
      queries: ['결방', '종영', '방송 시간', '회차'].map((w) => ({ q: `${core(t.title)} ${w}`, days: 14, focus: t.title })),
    }));
}

export async function addTracked(repo: Repo, t: Omit<Tracked, 'status' | 'origin' | 'sources' | 'addedAt'>, now: Date): Promise<Tracked> {
  const list = await loadTracked(repo);
  const rec: Tracked = { ...t, status: 'active', origin: 'manual', sources: [], addedAt: now.toISOString() };
  await repo.putState(STATE_KEY, [...list.filter((x) => x.id !== t.id), rec]);
  return rec;
}
