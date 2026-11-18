/** 반복 방송(드라마·고정 예능) 회차 날짜 계산 */

export const WEEKDAY_INDEX: Record<string, number> = { 일: 0, 월: 1, 화: 2, 수: 3, 목: 4, 금: 5, 토: 6 };

/**
 * 첫 방송일부터 방송 요일마다 회차 날짜를 만든다.
 * 회차 수나 종영일을 알면 거기까지, 모르면 until까지만 (수집할 때마다 늘어난다).
 */
export function seriesDates(
  startDate: string,
  weekdays: number[],
  opts: { episodes?: number | null; endDate?: string | null; until: string },
): { date: string; episode: number }[] {
  const out: { date: string; episode: number }[] = [];
  const d = new Date(`${startDate}T00:00:00Z`);
  const limit = opts.endDate ?? (opts.episodes ? '9999-12-31' : opts.until);
  for (let i = 0; i < 400 && out.length < (opts.episodes ?? 999); i++) {
    const ds = d.toISOString().slice(0, 10);
    if (ds > limit) break;
    if (weekdays.includes(d.getUTCDay())) out.push({ date: ds, episode: out.length + 1 });
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}
