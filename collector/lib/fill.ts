/**
 * 빈칸 채우기: 합친 결과에서 비어 있는 정보를 찾을 검색어를 만든다.
 * 찾은 기사·영상은 다른 문서와 똑같은 흐름(AI 추출 → 검증 → 합치기)으로 들어가서 빈칸이 채워진다.
 *
 *  - 시간이 없는 다가오는 일정 → "{대상} {M월 D일}" 기사, 유튜브에서 "{대상}" 영상 (공개 시각)
 *  - 날짜 미정 소식 → "{대상} 날짜", "{대상} 일정"
 *  - 다가오는 행사(시상식·공연) → "{대상} 티켓", "{대상} 생중계" (관련 일정)
 *  - 투표·예매 기간에서 빠진 쪽 → "{대상} 마감" / "{대상} 시작"
 * 같은 검색은 12시간(관련 일정은 24시간)에 한 번만. 일정이 지나면 그만 찾는다.
 * 확인 대기·날짜 미정은 찾을 때마다 검색어를 바꾼다 (기사마다 표기가 달라서): 원래 이름 → AI가 만든 다른 표기(한글·영어·줄임말)
 *  → "그룹 이름 + 대상" → "그룹 이름 + 단계(출국 등)". 기사 검색은 실제로 검색했을 때만 "찾았음"으로 남긴다 (구글이 막혀 못 찾은 건 다음 실행에서 다시).
 */
import type { Budget } from './budget.ts';
import { GROUP } from './group.ts';
import { callModel, hasLlmKey } from './llm.ts';
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

/** 대상 이름의 다른 표기 (AI, 무료 Groq 작은 모델 → 막히면 nano). 한 번 만든 건 저장해 두고 다시 묻지 않는다 */
async function altNames(repo: Repo, names: string[], budget?: Budget): Promise<Record<string, string[]>> {
  const cache = await repo.getState<Record<string, string[]>>('fill/alt', {});
  const todo = [...new Set(names)].filter((n) => !cache[n]).slice(0, 30);
  if (todo.length && budget?.canSpend() && hasLlmKey()) {
    const r = await callModel({
      model: 'gpt-5-nano', effort: 'low',
      instructions: [
        '아이돌 일정(행사·방송·공연) 이름마다, 한국 기사 제목에서 쓸 법한 다른 표기를 최대 3개 만든다.',
        '- 영어 이름은 한글 표기로, 한글 이름은 영어 표기로, 긴 이름은 흔한 줄임말로 (예: "TV Asahi Dream Festival 2026" → "TV아사히 드림 페스티벌", "드림페스").',
        '- 그룹·멤버 이름은 넣지 않는다. 원래 이름과 같은 표기는 빼고, 확실하지 않으면 적게.',
      ].join('\n'),
      input: todo.map((n, i) => `[${i}] ${n}`).join('\n'),
      schema: { name: 'alts', schema: { type: 'object', additionalProperties: false, required: ['items'], properties: { items: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['i', 'alts'], properties: { i: { type: 'integer' }, alts: { type: 'array', items: { type: 'string' } } } } } } } },
    }).catch(() => null);
    if (r) {
      budget.record(r.usage.costUsd);
      for (const it of (JSON.parse(r.value) as { items: { i: number; alts: string[] }[] }).items) {
        const name = todo[it.i];
        if (name) cache[name] = it.alts.map((a) => a.trim()).filter((a) => a.length >= 2 && a !== name).slice(0, 3);
      }
      for (const n of todo) cache[n] ??= [];
      await repo.putState('fill/alt', cache);
    }
  }
  return cache;
}

/** 찾을 때마다 바꿔 쓸 검색어 목록 */
const groupName = () => GROUP.nameVariants[0] ?? GROUP.name;
const stripGroup = (s: string) => GROUP.nameVariants.reduce((t, n) => t.replace(n, ''), s).replace(/\s+/g, ' ').trim();

/** 실제로 검색한 빈칸 채우기 기사 검색을 기록한다 (다음 검색은 12·24시간 뒤, 검색어는 다음 것으로) */
export async function markFillDone(repo: Repo, keys: Iterable<string>, now: Date) {
  const list = [...new Set(keys)];
  if (!list.length) return;
  const state = await repo.getState<Record<string, string>>('fill', {});
  const tries = await repo.getState<Record<string, number>>('fill/try', {});
  for (const k of list) { state[k] = now.toISOString(); tries[k] = (tries[k] ?? 0) + 1; }
  await repo.putState('fill', state);
  await repo.putState('fill/try', tries);
}

export async function planFill(
  repo: Repo, events: PublicEvent[], pending: PendingItem[], now: Date, tracked: Tracked[] = [], rumors: RumorItem[] = [], review: PublicEvent[] = [], budget?: Budget,
): Promise<FillPlan> {
  const tries = await repo.getState<Record<string, number>>('fill/try', {});
  /** 이번에 쓸 검색어 n개 (지난번 다음 것부터 돌아가며) */
  const pick = <T,>(key: string, list: T[], n: number) => Array.from({ length: Math.min(n, list.length) }, (_, i) => list[((tries[key] ?? 0) * n + i) % list.length]);
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
    if (due(key, 12) && plan.news.length < MAX_NEWS) plan.news.push({ q: `${core(e.title)} ${md(e.date)}`, days: 30, focus: e.title, fillKey: key });
    if ((e.kind === '방송' || e.kind === '발매') && plan.youtube.length < MAX_YOUTUBE && due(`yt:${key}`, 12)) {
      plan.youtube.push({ focus: core(e.title), after: new Date(new Date(`${e.date}T00:00:00+09:00`).getTime() - 2 * 24 * 3600 * 1000) });
      mark(`yt:${key}`);
    }
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
    plan.news.push({ q: `${core(e.title)} ${isEnd ? '시작' : '마감'}`, days: 45, focus: e.title, fillKey: key });
  }

  // 확인 대기: 다가오는(또는 지난 3일) 일정의 두 번째 출처 찾기. 날짜 미정 소식도 같이 다른 표기를 만든다
  const back3 = toKstParts(new Date(now.getTime() - 3 * 24 * 3600 * 1000));
  const reviewNow = review.filter((e) => e.date >= kstDate(back3.year, back3.month, back3.day) && e.date <= soon);
  const alts = await altNames(repo, [...reviewNow.map((e) => core(e.title)), ...pending.map((x) => core(x.title))], budget);
  for (const e of reviewNow) {
    const key = `review:${core(e.title)}:${e.date}`;
    if (!due(key, 12) || plan.news.length >= MAX_NEWS) continue;
    const stepCore = stripGroup(e.step);
    const variants: NewsQuery[] = [
      { q: `${core(e.title)} ${md(e.date)}`, days: 30, focus: e.title },
      ...(alts[core(e.title)] ?? []).map((a) => ({ q: a, days: 30, focus: a })),
      { q: `${groupName()} ${core(e.title)}`, days: 30, focus: e.title },
      // "NCT DREAM 출국"처럼 단계로: 대상 이름이 제목에 없어도 그룹 관련 기사면 받는다 (날짜 가까운 것만)
      ...(stepCore && stepCore !== core(e.title) ? [{ q: `${groupName()} ${stepCore}`, days: 7 }] : []),
    ];
    for (const v of pick(key, variants, 2)) plan.news.push({ ...v, fillKey: key });
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

  // 날짜 미정 소식: 찾을 때마다 다른 검색어 2개
  for (const x of pending) {
    const key = `date:${core(x.title)}`;
    if (!due(key, 12) || plan.news.length >= MAX_NEWS) continue;
    const variants: NewsQuery[] = [
      { q: `${core(x.title)} 날짜`, days: 60, focus: x.title },
      { q: `${core(x.title)} 일정`, days: 60, focus: x.title },
      ...(alts[core(x.title)] ?? []).map((a) => ({ q: `${a} 일정`, days: 60, focus: a })),
      { q: `${groupName()} ${core(x.title)}`, days: 60, focus: x.title },
    ];
    for (const v of pick(key, variants, 2)) plan.news.push({ ...v, fillKey: key });
  }

  // 다가오는 행사의 관련 일정 (티켓·생중계)
  const seen = new Set<string>();
  for (const e of events) {
    if (e.kind !== '행사' || e.date < today || seen.has(core(e.title))) continue;
    seen.add(core(e.title));
    const key = `related:${core(e.title)}`;
    if (!due(key, 24) || plan.news.length >= MAX_NEWS) continue;
    plan.news.push({ q: `${core(e.title)} 티켓`, days: 90, focus: e.title, fillKey: key }, { q: `${core(e.title)} 생중계`, days: 30, focus: e.title, fillKey: key });
  }

  // 추적 목록(고정 출연): 하루 한 번 결방·종영·방송 시간 기사 확인
  for (const t of trackedQueries(tracked)) {
    if (!due(t.key, 24)) continue;
    plan.news.push(...t.queries.map((q) => ({ ...q, fillKey: t.key })));
  }

  // 오래된 기록 정리 (60일)
  for (const [k, at] of Object.entries(state)) if (now.getTime() - Date.parse(at) > 60 * 24 * 3600 * 1000) { delete state[k]; delete tries[k]; }
  await repo.putState('fill/try', tries);
  await repo.putState('fill', state);
  return plan;
}
