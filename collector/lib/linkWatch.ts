/**
 * 공개 직후 영상 링크 찾기.
 * 외부 콘텐츠는 "기사·SNS로 출연 소식 → '11/22 18:00 공개' 일정 (링크 없음) → 공개 뒤 영상" 순서라,
 * 시각이 정해진 방송·공개 일정 중 유튜브 링크가 없는 것을 공개 시각 +5분, +20분, +60분에 유튜브에서 찾는다.
 *  - 수집할 때마다 다음 찾을 시각 목록을 app_state 'wake/links'에 올린다 → 예약 작업(cron/, 5분마다)이 그 시각에 links 실행을 띄운다
 *  - 유튜브 검색은 하루 사용량이 커서 일정 하나에 3번, 하루 20번까지
 * 상태: app_state 'link-watch' = { 일정 id: 찾은 횟수 }, 'link-watch/day' = { 날짜: 검색 수 }
 */
import { BROADCASTER_PREFIX_RE } from './broadcasters.ts';
import type { PublicEvent } from './consolidate.ts';
import type { Repo } from './repo.ts';
import { toKstParts, kstDate } from './time.ts';
import { searchVideos } from './youtube.ts';

const OFFSETS_MIN = [5, 20, 60];
const DAILY_MAX = 20;
const at = (e: PublicEvent) => Date.parse(`${e.date}T${e.time}:00+09:00`);
const core = (title: string) => title.replace(BROADCASTER_PREFIX_RE, '').trim();

/** 지켜볼 일정: 시각이 있는 방송·공개 일정, 유튜브 링크 없음, 공개 2시간 전 ~ 공개 2시간 뒤 (그 뒤는 빈칸 채우기가 6시간마다) */
export function watchedEvents(events: PublicEvent[], now: Date): PublicEvent[] {
  return events.filter((e) => (e.kind === '방송' || e.kind === '발매') && e.time && !e.sources.some((s) => s.type === 'youtube')
    && at(e) - now.getTime() <= 48 * 3600e3 && now.getTime() - at(e) <= 2 * 3600e3);
}

/** 이번에 찾을 일정을 찾아 유튜브 검색. 찾은 영상 수를 돌려준다 */
export async function runLinkWatch(repo: Repo, events: PublicEvent[], now: Date): Promise<{ searched: number; found: number }> {
  const tries = await repo.getState<Record<string, number>>('link-watch', {});
  const p = toKstParts(now);
  const today = kstDate(p.year, p.month, p.day);
  const day = await repo.getState<Record<string, number>>('link-watch/day', {});
  let searched = 0;
  let found = 0;
  for (const e of watchedEvents(events, now)) {
    const n = tries[e.id] ?? 0;
    if (n >= OFFSETS_MIN.length || now.getTime() < at(e) + OFFSETS_MIN[n] * 60e3) continue;
    if ((day[today] ?? 0) >= DAILY_MAX) break;
    const videos = await searchVideos(core(e.title), new Date(at(e) - 24 * 3600e3), now).catch((err) => { console.log(`영상 링크 찾기 실패: ${e.title} (${(err as Error).message})`); return null; });
    if (!videos) continue;
    tries[e.id] = n + 1;
    day[today] = (day[today] ?? 0) + 1;
    searched++;
    found += videos.length;
    console.log(`영상 링크 찾기 ${n + 1}번째: ${e.date} ${e.time} ${e.title} → 영상 ${videos.length}개`);
  }
  for (const id of Object.keys(tries)) if (!events.some((e) => e.id === id && now.getTime() - at(e) <= 3 * 3600e3)) delete tries[id];
  for (const d of Object.keys(day)) if (d < today) delete day[d];
  await repo.putState('link-watch', tries);
  await repo.putState('link-watch/day', day);
  return { searched, found };
}

/** 다음에 찾을 시각들을 app_state 'wake/links'에 올린다 (예약 작업 cron/ 이 5분마다 읽음) */
export async function publishLinkWake(repo: Repo, events: PublicEvent[], now: Date): Promise<number> {
  const tries = await repo.getState<Record<string, number>>('link-watch', {});
  const times = watchedEvents(events, now)
    .map((e) => { const n = tries[e.id] ?? 0; return n < OFFSETS_MIN.length ? at(e) + OFFSETS_MIN[n] * 60e3 : null; })
    .filter((t): t is number => t !== null)
    .sort((a, b) => a - b)
    .map((t) => new Date(t).toISOString());
  // 바뀌었을 때만 쓴다
  const next = [...new Set(times)];
  const prev = await repo.getState<{ times?: string[] }>('wake/links', {});
  if (JSON.stringify(prev.times ?? []) !== JSON.stringify(next)) {
    await repo.putState('wake/links', { updatedAt: now.toISOString(), times: next }).catch((err) => console.log(`영상 링크 찾기 시각 올리기 실패: ${(err as Error).message}`));
  }
  return times.length;
}
