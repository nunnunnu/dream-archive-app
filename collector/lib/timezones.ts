/**
 * 해외 일정 시간대 정리: 공지의 현지 시간(19:00 WIB)을 시간대(Asia/Jakarta)로 정하고 한국 시간을 함께 계산한다.
 *  - 약어가 있으면 config/timezones.json abbr 로, 없거나 모르는 약어(예: TWS)면 제목·단계·근거의 도시 이름으로
 *  - 근거에 "KST"가 적힌 일정(예매·신청)은 한국 시간이므로 건드리지 않는다
 * 캘린더 구독(ics)은 한국 시간으로 넣고, 화면은 "현지 19:00 WIB · 한국 21:00"으로 보여 준다.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PublicEvent } from './consolidate.ts';
import { ROOT } from './store.ts';

const CFG: { abbr: Record<string, string>; cities: Record<string, string> } = JSON.parse(readFileSync(join(ROOT, 'config', 'timezones.json'), 'utf8'));
const ABBR_OF: Record<string, string> = Object.fromEntries(Object.entries(CFG.abbr).filter(([a]) => !a.includes('(')).map(([a, z]) => [z, a]).reverse());
ABBR_OF['Asia/Taipei'] ??= 'TST';
ABBR_OF['Asia/Macau'] ??= 'CST';
ABBR_OF['Asia/Tokyo'] ??= 'JST';

/** 그 날짜의 시간대 차이(분): Asia/Jakarta → 420 */
export function offsetMinutes(tzid: string, date: string): number {
  const name = new Intl.DateTimeFormat('en-US', { timeZone: tzid, timeZoneName: 'longOffset' }).formatToParts(new Date(`${date}T12:00:00Z`)).find((p) => p.type === 'timeZoneName')?.value ?? 'GMT';
  const m = name.match(/GMT([+-])(\d{2}):?(\d{2})?/);
  return m ? (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] ?? 0)) : 0;
}

/** 현지 날짜·시각 → 한국 날짜·시각 */
export function toKst(date: string, time: string, tzid: string): { date: string; time: string } {
  const utc = Date.parse(`${date}T${time}:00Z`) - offsetMinutes(tzid, date) * 60000;
  const k = new Date(utc + 9 * 3600000).toISOString();
  return { date: k.slice(0, 10), time: k.slice(11, 16) };
}

export function cityTz(text: string): string | undefined {
  return cityOf(text)?.[1];
}
/** 텍스트에 나온 도시 [이름, 시간대] */
export function cityOf(text: string): [string, string] | undefined {
  const up = text.toUpperCase();
  return Object.entries(CFG.cities).find(([c]) => up.includes(c.toUpperCase()));
}

export function localizeEvents(events: PublicEvent[]): { fixed: string[] } {
  const fixed: string[] = [];
  for (const e of events) {
    const text = `${e.title} ${e.step} ${e.evidence ?? ''}`;
    const saysKst = /KST|한국\s*시간/i.test(e.evidence ?? '');
    // 출국·입국(인천·김포 공항)은 한국에서 일어나는 일이라 도시 이름이 있어도 한국 시간
    const inKorea = /출국|입국|귀국|인천|김포|공항/.test(`${e.title} ${e.step}`);
    // 해외 일정 표시 (출국·입국 자체는 한국에서 일어나니 빼고): 질문 "언제 입국해?"를 다음 국내 일정으로 추정할 때 쓴다
    const where = cityOf(text);
    if (where && !inKorea && where[1] !== 'Asia/Seoul') e.abroad = where[0];
    if (inKorea && !e.timezone) continue;
    let tzid = e.timezone ? CFG.abbr[e.timezone.toUpperCase()] : undefined;
    const city = cityTz(text);
    // 약어가 없거나 모르는 약어인 해외 공연·행사 → 도시로
    if (!tzid && city && !saysKst && (e.timezone || e.kind === '행사')) tzid = city;
    if (!tzid || tzid === 'Asia/Seoul') {
      if (e.timezone && !tzid) fixed.push(`${e.date} ${e.title.slice(0, 30)}: 모르는 시간대 ${e.timezone}`);
      continue;
    }
    // 표시 약어: 서머타임이 있는 곳은 그 날짜 기준(PDT/PST), 나머지는 공지에서 흔히 쓰는 약어
    const short = new Intl.DateTimeFormat('en-US', { timeZone: tzid, timeZoneName: 'short' }).formatToParts(new Date(`${e.date}T12:00:00Z`)).find((p) => p.type === 'timeZoneName')?.value ?? '';
    const off = offsetMinutes(tzid, e.date);
    const BY_OFFSET: Record<string, string> = { 'Europe/London:0': 'GMT', 'Europe/London:60': 'BST', 'Europe/Paris:60': 'CET', 'Europe/Paris:120': 'CEST', 'Europe/Rome:60': 'CET', 'Europe/Rome:120': 'CEST', 'Australia/Sydney:600': 'AEST', 'Australia/Sydney:660': 'AEDT' };
    const label = /^[A-Z]{3,4}$/.test(short) ? short : (BY_OFFSET[`${tzid}:${off}`] ?? ABBR_OF[tzid] ?? tzid.split('/')[1]);
    if (e.timezone !== label) fixed.push(`${e.date} ${e.title.slice(0, 30)}: ${e.timezone ?? '시간대 없음'} → ${label}`);
    e.timezone = label;
    e.tzid = tzid;
    if (e.time) e.kst = toKst(e.date, e.time, tzid);
  }
  return { fixed };
}
