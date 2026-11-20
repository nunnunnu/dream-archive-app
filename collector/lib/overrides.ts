/**
 * 운영자 덮어쓰기 (config/overrides.json): 승인한 삭제·보완 제보를 합친 결과에 적용한다.
 * 일정 id는 내용이 바뀌면 달라질 수 있어서, id가 없으면 날짜 + 제목(또는 단계)으로 찾는다.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PublicEvent } from './consolidate.ts';
import { ROOT } from './store.ts';

export interface OverrideTarget { id: string; date: string; title: string; reason?: string; reportId?: string }
export interface Overrides {
  hide: OverrideTarget[];
  patch: (OverrideTarget & { set: { date?: string; time?: string | null; members?: string[]; url?: string; step?: string } })[];
}
const PATH = join(ROOT, 'config', 'overrides.json');
export const loadOverrides = (): Overrides => ({ hide: [], patch: [], ...JSON.parse(readFileSync(PATH, 'utf8')) });
export const mergeOverrides = (base: Overrides, extra: Overrides): Overrides => ({
  hide: [...base.hide, ...extra.hide].filter((x, i, all) => all.findIndex((y) => (x.reportId && y.reportId === x.reportId) || (!x.reportId && y.id === x.id)) === i),
  patch: [...base.patch, ...extra.patch].filter((x, i, all) => all.findIndex((y) => (x.reportId && y.reportId === x.reportId) || (!x.reportId && y.id === x.id)) === i),
});
export const saveOverrides = (o: Overrides) => {
  const raw = JSON.parse(readFileSync(PATH, 'utf8'));
  writeFileSync(PATH, JSON.stringify({ ...raw, hide: o.hide, patch: o.patch }, null, 2) + '\n');
};

const sq = (t: string) => t.normalize('NFKC').replace(/[^\p{L}\p{N}]+/gu, '').toLowerCase();
const matches = (e: PublicEvent, t: OverrideTarget) =>
  e.id === t.id || (Boolean(t.date) && e.date === t.date && Boolean(t.title) && (sq(`${e.title}${e.step}`).includes(sq(t.title)) || sq(t.title).includes(sq(e.step))));

/** 숨기기·고치기 적용. 적용된 개수를 돌려준다 */
export function applyOverrides(events: PublicEvent[], o: Overrides = loadOverrides()): { hidden: number; patched: number } {
  let hidden = 0;
  let patched = 0;
  for (let i = events.length - 1; i >= 0; i--) if (o.hide.some((t) => matches(events[i], t))) { events.splice(i, 1); hidden++; }
  for (const e of events) {
    const p = o.patch.find((t) => matches(e, t));
    if (!p) continue;
    if (p.set.date) e.date = p.set.date;
    if (p.set.time !== undefined) e.time = p.set.time;
    if (p.set.members) e.members = p.set.members;
    if (p.set.step) e.step = p.set.step;
    if (p.set.url && !e.sources.some((s) => s.url === p.set.url)) e.sources.unshift({ type: 'submission', id: p.reportId ?? 'override', url: p.set.url, title: '운영자 확인', publishedAt: new Date().toISOString() });
    e.status = 'confirmed';
    patched++;
  }
  return { hidden, patched };
}
