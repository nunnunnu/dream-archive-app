/** 모든 날짜는 한국 시간(KST, UTC+9) 기준으로 다룬다. */
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

export interface KstParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

export function toKstParts(d: Date): KstParts {
  const k = new Date(d.getTime() + KST_OFFSET_MS);
  return {
    year: k.getUTCFullYear(),
    month: k.getUTCMonth() + 1,
    day: k.getUTCDate(),
    hour: k.getUTCHours(),
    minute: k.getUTCMinutes(),
  };
}

const pad = (n: number) => String(n).padStart(2, '0');

export function kstDate(year: number, month: number, day: number): string {
  return `${year}-${pad(month)}-${pad(day)}`;
}

export function kstTime(hour: number, minute: number): string {
  return `${pad(hour)}:${pad(minute)}`;
}

/** KST 기준 날짜·시각을 `2026-11-11T15:55:00+09:00` 형태로 */
export function kstIso(p: KstParts): string {
  return `${kstDate(p.year, p.month, p.day)}T${kstTime(p.hour, p.minute)}:00+09:00`;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
