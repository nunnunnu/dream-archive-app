/**
 * 매년 반복되는 일정 (멤버 생일·데뷔 기념일): config/anniversaries.json → 작년~내년 일정.
 * 수집한 문서가 아니라 설정에서 만든 일정이라 출처는 없고, 종류는 '기념일'.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PublicEvent } from './consolidate.ts';
import { ROOT } from './store.ts';

interface Anniversary { date: string; title: string; step: string; member?: string; since?: number }

export function anniversaryEvents(today: string): PublicEvent[] {
  const { items } = JSON.parse(readFileSync(join(ROOT, 'config', 'anniversaries.json'), 'utf8')) as { items: Anniversary[] };
  const year = Number(today.slice(0, 4));
  const out: PublicEvent[] = [];
  for (const a of items) {
    for (const y of [year - 1, year, year + 1]) {
      if (a.since && y <= a.since) continue;
      const date = `${y}-${a.date}`;
      out.push({
        id: createHash('sha1').update(`anniv|${date}|${a.title}`).digest('hex').slice(0, 12),
        date, time: null, endDate: null, endTime: null, timezone: null,
        title: a.title, step: a.step.replace('{n}', String(a.since ? y - a.since : '')),
        kind: '기념일', members: a.member ? [a.member] : [], scope: a.member ? '멤버' : '단체',
        status: 'confirmed', evidence: '매년 같은 날 (설정)', sources: [], extractedBy: 'rule',
        category: '공식', calendars: ['공식'], audience: 'all',
      });
    }
  }
  return out;
}
