// 사이트 데이터는 수집기가 Supabase 공개 버킷(site-data)에 올린다 (npm run publish:site).
// 요청이 오면 manifest.json(짧게 캐시)으로 최신 파일 이름(내용 지문)을 찾고, 그 파일은 오래 캐시해서 읽는다.
// → 수집만 하면 배포 없이 사이트에 반영된다.
interface Manifest { version: string; updatedAt: string; files: Record<string, string> }
type Locals = { runtime?: { env?: { SITE_DATA_URL?: string } } };
const cfFetch = (url: string, cacheTtl: number) => fetch(url, { cf: { cacheTtl, cacheEverything: true } } as RequestInit);

let manifestCache: { at: number; base: string; value: Manifest } | null = null;
const parsed = new Map<string, unknown>();

export function dataBase(locals: Locals): string {
  const base = locals.runtime?.env?.SITE_DATA_URL;
  if (!base) throw new Error('SITE_DATA_URL 이 설정되지 않았어요 (site/wrangler.toml [vars])');
  return base.replace(/\/$/, '');
}

export async function manifest(locals: Locals): Promise<Manifest> {
  const base = dataBase(locals);
  if (manifestCache && manifestCache.base === base && Date.now() - manifestCache.at < 30_000) return manifestCache.value;
  const res = await cfFetch(`${base}/manifest.json`, 30);
  if (!res.ok) throw new Error(`데이터 목록을 읽지 못했어요 ${res.status}`);
  const value = (await res.json()) as Manifest;
  manifestCache = { at: Date.now(), base, value };
  return value;
}

/** 원래 이름(events.json, eras/xxx.json)의 최신 파일 응답 (지문 이름이라 오래 캐시) */
export async function fetchPublic(locals: Locals, path: string): Promise<Response | null> {
  const m = await manifest(locals);
  const hashed = m.files[path.normalize('NFC')];
  if (!hashed) return null;
  const res = await cfFetch(`${dataBase(locals)}/${hashed}`, 31536000);
  return res.ok ? res : null;
}

export async function loadPublic<T>(locals: Locals, path: string, fallback: T): Promise<T> {
  const m = await manifest(locals).catch(() => null);
  const hashed = m?.files[path.normalize('NFC')];
  if (!hashed) return fallback;
  if (parsed.has(hashed)) return parsed.get(hashed) as T;
  const res = await fetchPublic(locals, path);
  if (!res) return fallback;
  const value = (await res.json()) as T;
  if (parsed.size > 60) parsed.clear();
  parsed.set(hashed, value);
  return value;
}

export interface EraVideo { id: string; title: string; url: string; thumb: string; date: string; channel: string; members: string[]; group?: string }
export interface EraPage {
  id: string; kind: string; title: string; subtitle?: string; titleSong?: string; release?: string;
  owner: { scope: string; members: string[]; label: string };
  keys: string[];
  from: string; to: string; cover: { from: string; to: string; text: string }; status: '활동 중' | '종료' | '예정';
  thumb?: string;
  counts: { official: number; stages: number; fancams?: number; own: number; shorts?: number; outside: number; events: number };
  shorts?: (EraVideo & { group: string })[];
  news?: { date: string; title: string; url: string; publisher: string }[];
  timeline: { date: string; label: string; sub: string }[];
  schedule: { date: string; time: string | null; endDate: string | null; title: string; step: string; kind: string; url?: string; group: string }[];
  ownGroups: string[];
  parts?: string[];
  official: EraVideo[];
  stages: { program: string; videos: EraVideo[] }[];
  fancams?: { member: string; videos: EraVideo[] }[];
  related?: (EraVideo & { group: string })[];
  own: EraVideo[];
  outside: { date: string; title: string; sub: string; members: string[]; url?: string; thumb?: string }[];
}
export type EraSummary = Omit<EraPage, 'official' | 'stages' | 'fancams' | 'related' | 'own' | 'shorts' | 'outside' | 'timeline' | 'schedule' | 'ownGroups' | 'news'>;

export const md = (d: string) => `${d.slice(5, 7)}.${d.slice(8, 10)}`;
export const ymd = (d: string) => d.replaceAll('-', '.');

export interface SiteConfig {
  group: { id: string; name: string; nameVariants: string[]; parentNames: string[] };
  members: { name: string; slug: string }[];
  programs: { names: string[]; short: string }[];
  eras: { id: string; title: string; keywords: string[]; titleSong?: string }[];
}
export const loadSite = (locals: Locals): Promise<SiteConfig> =>
  loadPublic<SiteConfig>(locals, 'site.json', { group: { id: '', name: '', nameVariants: [], parentNames: [] }, members: [], programs: [], eras: [] });
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** 그룹 이름 표기 변형 정규식 (띄어쓰기 유연) */
export const groupNameRe = (c: SiteConfig) => new RegExp(c.group.nameVariants.map((n) => esc(n).replace(/\s+/g, '\\s*')).join('|'), 'gi');

export interface SeriesVideo { id: string; title: string; url: string; thumb: string; date: string; ep: number | null; members: string[] }
export interface SeriesPage {
  id: string; type: string; name: string; count: number; from: string; to: string; thumb?: string; members: string[];
  seasons: { name: string; videos: SeriesVideo[] }[];
  episodes?: { date: string; time: string | null; title: string; step: string; members: string[]; url?: string; thumb?: string }[];
  activities?: { id: string; title: string; kind: string; owner: string; from: string; to: string; cover: { from: string; to: string; text: string }; thumb?: string }[];
}
export type SeriesSummary = Omit<SeriesPage, 'seasons' | 'episodes' | 'activities'>;
