/**
 * 유튜브 영상 저장: 달(한국 시간 기준 'YYYY-MM')마다 { 영상 id: Video }.
 * STORE=pg 면 Postgres videos 테이블, 아니면 data/state/youtube/YYYY-MM.json
 */
import { readdir } from 'node:fs/promises';
import { pgClean, pgSelect, pgUpsert, usePg } from './pg.ts';
import { DATA_DIR, readJson, writeJson } from './store.ts';
import { toKstParts } from './time.ts';
import type { Video } from './youtube.ts';

export const monthOf = (iso: string) => { const p = toKstParts(new Date(iso)); return `${p.year}-${String(p.month).padStart(2, '0')}`; };

// DB 모드: 영상 전체(수천 개)를 처음 한 번 읽어 달마다 나눠 둔다 (달마다 묻으면 130번 넘게 오가서 느림)
let all: Map<string, Record<string, Video>> | null = null;
async function loadAll() {
  if (!all) {
    all = new Map();
    for (const r of await pgSelect<{ data: Video }>('videos', 'select=data&order=published_at.desc')) {
      const ym = monthOf(r.data.publishedAt);
      all.set(ym, { ...(all.get(ym) ?? {}), [r.data.videoId]: r.data });
    }
  }
  return all;
}

/** 영상이 있는 달 목록 */
export async function videoMonths(): Promise<string[]> {
  if (usePg()) return [...(await loadAll()).keys()].sort();
  return (await readdir(`${DATA_DIR}/state/youtube`).catch(() => [] as string[])).filter((x) => /^20\d\d-\d\d\.json$/.test(x)).map((x) => x.slice(0, 7)).sort();
}

export async function readVideoMonth(ym: string): Promise<Record<string, Video>> {
  if (usePg()) return { ...((await loadAll()).get(ym) ?? {}) };
  return readJson<Record<string, Video>>(`state/youtube/${ym}.json`, {});
}

export async function writeVideoMonth(ym: string, rec: Record<string, Video>): Promise<void> {
  if (usePg()) {
    (await loadAll()).set(ym, { ...rec });
    await pgUpsert('videos', Object.values(rec).map((v) => ({
      video_id: v.videoId, published_at: v.publishedAt, channel: v.channel, title: v.title, unavailable_at: v.unavailableAt ?? null, data: pgClean(v), updated_at: new Date().toISOString(),
    })), 'video_id');
    return;
  }
  await writeJson(`state/youtube/${ym}.json`, Object.fromEntries(Object.entries(rec).sort(([, a], [, b]) => b.publishedAt.localeCompare(a.publishedAt))));
}
