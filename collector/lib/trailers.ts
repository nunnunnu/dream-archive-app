/**
 * 트레일러 잇기: 기사·공지의 "트레일러 공개"(시간 없음)와 같은 날 공식 채널의 회차 영상(EP.1 …)은 같은 일정이다.
 *  - 합치면 기사 이름(정규 6집 … 트레일러)을 살리고, 영상의 공개 시각·링크를 붙인다
 *  - 같은 시리즈의 다음 회차(EP.2 …)도 "트레일러"로 이름을 맞춘다 (활동 페이지가 트레일러로 분류할 수 있게)
 */
import type { PublicEvent } from './consolidate.ts';
import { GROUP } from './group.ts';

const OFFICIAL = new Set(GROUP.youtube.channels.filter((c) => !c.guest).map((c) => c.name));
const TRAILER_RE = /트레일러|trailer/i;
const EP_RE = /\bEP\.?\s*(\d+)/i;
/** 영상 제목에서 EP 앞부분 (같은 시리즈인지 볼 때): "NCT DREAM 엔시티 드림 EP.2 …" → "nctdream엔시티드림" */
const seriesOf = (e: PublicEvent) => (e.sources[0]?.title ?? '').split(/\bEP\.?\s*\d+/i)[0].normalize('NFKC').replace(/[^\p{L}\p{N}]+/gu, '').toLowerCase();
const isOfficialVideoEvent = (e: PublicEvent) => e.kind === '발매' && e.sources.length > 0 && e.sources.every((s) => s.type === 'youtube' && OFFICIAL.has(s.publisher ?? ''));

export function linkTrailers(events: PublicEvent[]): { merged: number; renamed: number } {
  let merged = 0, renamed = 0;
  const trailers = events.filter((e) => e.kind === '발매' && TRAILER_RE.test(`${e.title} ${e.step}`) && e.sources.some((s) => s.type !== 'youtube'));
  for (const t of trailers) {
    const v = events.find((x) => x !== t && x.date === t.date && isOfficialVideoEvent(x) && EP_RE.test(`${x.step} ${x.sources[0].title ?? ''}`));
    if (!v) continue;
    t.time ??= v.time;
    for (const s of v.sources) if (!t.sources.some((x) => x.url === s.url)) t.sources.push(s);
    const ep = `${v.step} ${v.sources[0].title ?? ''}`.match(EP_RE)![1];
    if (!EP_RE.test(t.step)) t.step = `${t.step} (EP.${ep})`;
    events.splice(events.indexOf(v), 1);
    merged++;
    // 같은 시리즈(EP 앞 제목이 같은 영상)·2주 안의 다음 회차도 트레일러로
    const base = t.title.replace(/첫\s*번째\s*|두\s*번째\s*|세\s*번째\s*/g, '').trim();
    const series = seriesOf(v);
    for (const n of events.filter((x) => isOfficialVideoEvent(x) && seriesOf(x) === series && series.length > 0 && x.date > t.date && Date.parse(x.date) - Date.parse(t.date) <= 14 * 864e5 && EP_RE.test(`${x.step} ${x.sources[0].title ?? ''}`))) {
      if (TRAILER_RE.test(`${n.title} ${n.step}`)) continue;
      n.title = base;
      n.step = `트레일러 ${n.step}`;
      renamed++;
    }
  }
  return { merged, renamed };
}
