/**
 * 응원법 채보를 KV에서 바로 읽고 쓰기 (저장하면 1분 안에 공개 게임에 반영)
 *  - chart:<곡ID>      어드민이 저장한 채보 (초안 포함)
 *  - fanchant-index    공개(verified) 곡 목록. 어드민이 저장·삭제할 때 같이 고친다 (KV 목록 조회는 하루 1,000번 한도라 매번 훑지 않음)
 * 공개 쪽 읽기는 cacheTtl 60초로 엣지에서 캐시한다.
 */
import { indexEntry, publicChart, SONG_ID, type FanchantChart, type FanchantIndexSong } from './fanchant.ts';

/** 여기서 쓰는 KV 기능만 (사이트 env.d.ts 의 KV 와 같은 모양, 수집기 테스트에서도 쓰려고 따로 적음) */
export interface KvStore {
  get(key: string): Promise<string | null>;
  get<T>(key: string, type: 'json'): Promise<T | null>;
  get<T>(key: string, opts: { type: 'json'; cacheTtl?: number }): Promise<T | null>;
  put(key: string, value: string): Promise<void>;
  list(opts: { prefix: string; limit?: number; cursor?: string }): Promise<{ keys: { name: string }[]; list_complete: boolean; cursor?: string }>;
}
type KV = KvStore;

export const INDEX_KEY = 'fanchant-index';
const CACHE = 60;
interface IndexDoc { songs: FanchantIndexSong[]; updatedAt: string }

async function allCharts(kv: KV): Promise<FanchantChart[]> {
  const names: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await kv.list({ prefix: 'chart:', limit: 1000, cursor });
    names.push(...page.keys.map((k) => k.name));
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return (await Promise.all(names.map((n) => kv.get<FanchantChart>(n, 'json').catch(() => null)))).filter((c): c is FanchantChart => Boolean(c?.songId));
}

const sortSongs = (songs: FanchantIndexSong[]) => songs.sort((a, b) => a.title.localeCompare(b.title, 'ko'));

/** 곡 목록을 처음부터 다시 만든다 (목록 키가 없을 때 한 번) */
export async function rebuildIndex(kv: KV): Promise<FanchantIndexSong[]> {
  const songs = sortSongs((await allCharts(kv)).filter((c) => c.verified).map(indexEntry));
  await kv.put(INDEX_KEY, JSON.stringify({ songs, updatedAt: new Date().toISOString() } satisfies IndexDoc));
  return songs;
}

/** 공개 곡 목록 */
export async function readIndex(kv: KV | undefined): Promise<FanchantIndexSong[]> {
  if (!kv) return [];
  const doc = await kv.get<IndexDoc>(INDEX_KEY, { type: 'json', cacheTtl: CACHE }).catch(() => null);
  if (doc?.songs) return doc.songs;
  return rebuildIndex(kv).catch(() => []);
}

/** 공개된 채보 하나 (verified 가 아니면 null) */
export async function readPublicChart(kv: KV | undefined, songId: string): Promise<FanchantChart | null> {
  if (!kv || !SONG_ID.test(songId)) return null;
  const c = await kv.get<FanchantChart>(`chart:${songId}`, { type: 'json', cacheTtl: CACHE }).catch(() => null);
  return c?.verified ? publicChart(c) : null;
}

/** 어드민 저장·삭제 뒤: 그 곡만 목록에서 바꾼다 (chart 가 null 이면 삭제) */
export async function updateIndex(kv: KV, songId: string, chart: FanchantChart | null): Promise<void> {
  const doc = await kv.get<IndexDoc>(INDEX_KEY, 'json').catch(() => null);
  if (!doc?.songs) { await rebuildIndex(kv); return; }
  const songs = doc.songs.filter((s) => s.songId !== songId);
  if (chart?.verified) songs.push(indexEntry(chart));
  await kv.put(INDEX_KEY, JSON.stringify({ songs: sortSongs(songs), updatedAt: new Date().toISOString() } satisfies IndexDoc));
}
