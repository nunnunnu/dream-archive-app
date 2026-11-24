/**
 * 운영자 수정 (어드민 "데이터 고치기"): 일정·소식·시리즈·아카이브를 손으로 만들고 고치고 숨긴다.
 *  - 수정 목록은 KV `edits` 한 곳에 저장한다.
 *  - 사이트는 데이터 파일을 읽을 때 이 목록을 덧씌워서 바로(1분 안) 보여 준다 (lib/data.ts).
 *  - 수집기도 다음 수집 때 같은 함수로 결과에 넣는다 (달력 ics·물어보기·멤버 페이지까지 맞춰짐).
 * 두 번 적용해도 결과가 같게 만든다 (수집기가 이미 넣은 파일에 사이트가 또 덧씌움).
 */

export type EditKind = 'event' | 'feed' | 'series' | 'era';
export type EditOp = 'add' | 'patch' | 'hide';
export interface EditTarget { id?: string; date?: string; title?: string; step?: string; url?: string }
export interface Edit {
  id: string;
  kind: EditKind;
  op: EditOp;
  /** 고칠·숨길 원래 항목 (일정: id + 날짜·제목·단계, 소식: 주소, 시리즈·아카이브: id) */
  target: EditTarget;
  /** 일정·소식: 고친 뒤 전체 모양 · 시리즈·아카이브: 바꿀 값 */
  data?: any;
  note?: string;
  at: string;
  by?: string;
}
export interface EditsDoc { rev: number; items: Edit[] }
export const EDITS_KEY = 'edits';

/** 넣은 영상 (시리즈·아카이브) */
export interface AddedVideo { id: string; title: string; url: string; thumb: string; date: string; members: string[]; to?: 'official' | 'own' | 'related'; group?: string }
export interface SeriesEditData { name?: string; type?: string; thumb?: string; removeVideos?: string[]; addVideos?: AddedVideo[] }
export interface EraEditData { title?: string; subtitle?: string; from?: string; to?: string; thumb?: string; removeVideos?: string[]; addVideos?: AddedVideo[] }

export const EVENT_KINDS = ['방송', '발매', '행사', '신청', '당첨 발표', '본인 확인', '녹화', '모임', '판매', '투표', '기념일', '기타'] as const;
const PARTICIPATE_KINDS = ['신청', '당첨 발표', '본인 확인', '녹화', '판매', '투표', '모임'];

const sq = (t = '') => t.normalize('NFKC').replace(/[^\p{L}\p{N}]+/gu, '').toLowerCase();
export const youtubeIdOf = (url = '') => url.match(/^https?:\/\/(?:www\.|m\.)?(?:youtube\.com\/(?:watch\?v=|shorts\/|live\/)|youtu\.be\/)([\w-]{11})(?=$|[?&#/])/i)?.[1];
export function normUrl(u = ''): string {
  try {
    const x = new URL(u.trim());
    x.hash = '';
    for (const k of [...x.searchParams.keys()]) if (/^utm_|^fbclid$|^gclid$|^si$/i.test(k)) x.searchParams.delete(k);
    x.hostname = x.hostname.toLowerCase().replace(/^www\./, '');
    return x.toString().replace(/\/$/, '');
  } catch {
    return u.trim();
  }
}
/** 영상·링크 비교 열쇠: 유튜브면 영상 id, 아니면 정리한 주소 */
export const linkKey = (u = '') => youtubeIdOf(u) ?? normUrl(u);
const videoKeys = (v: { id?: string; url?: string }) => [v.id, v.url ? linkKey(v.url) : undefined].filter(Boolean) as string[];

const byKind = (edits: Edit[], kind: EditKind) => edits.filter((e) => e.kind === kind);

// ── 일정 ──
type Ev = { id: string; date: string; time?: string | null; title: string; step: string; [k: string]: any };
export const eventTarget = (e: Ev): EditTarget => ({ id: e.id, date: e.date, title: e.title, step: e.step });
export const matchesEvent = (e: Ev, t: EditTarget) =>
  Boolean(t.id && e.id === t.id) || (Boolean(t.date && t.title) && e.date === t.date && sq(e.title) === sq(t.title) && sq(e.step) === sq(t.step ?? ''));
const sortEvents = <T extends Ev>(list: T[]) => list.sort((a, b) => a.date.localeCompare(b.date) || (a.time ?? '99:99').localeCompare(b.time ?? '99:99'));

/** 일정 목록에 덧씌우기. month(YYYY-MM)를 주면 그 달 파일용 (날짜를 옮긴 일정은 옮긴 달에 나온다) */
export function applyEvents<T extends Ev>(list: T[], edits: Edit[], month?: string): T[] {
  const ev = byKind(edits, 'event');
  if (!ev.length) return list;
  const snaps = ev.filter((x) => x.op !== 'hide' && x.data?.id).map((x) => x.data as T);
  const snapIds = new Set(snaps.map((s) => s.id));
  const out = list.filter((e) => !snapIds.has(e.id) && !ev.some((x) => x.op !== 'add' && matchesEvent(e, x.target)));
  for (const s of snaps) if (!month || s.date.startsWith(month) || (s.endDate && s.date.slice(0, 7) < month && s.endDate.slice(0, 7) >= month)) out.push(s);
  return sortEvents(out);
}
/** events/months.json: 손으로 넣은 일정이 있는 달도 목록에 */
export function applyMonths(months: Record<string, number>, edits: Edit[]): Record<string, number> {
  const out = { ...months };
  for (const x of byKind(edits, 'event')) if (x.op !== 'hide' && x.data?.date) out[x.data.date.slice(0, 7)] ??= 1;
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}

/** 어드민에서 받은 일정 모양을 사이트 일정 형식으로 채운다 (원래 일정이 있으면 그 위에) */
export function normalizeEvent(input: Partial<Ev> & { url?: string }, base: Partial<Ev> | undefined, memberCount: number, editId: string, now: string): Ev {
  const members: string[] = Array.isArray(input.members) ? input.members : base?.members ?? [];
  const kind = input.kind ?? base?.kind ?? '기타';
  const category = base?.kind === kind && base?.category ? base.category : PARTICIPATE_KINDS.includes(kind) ? '참여' : '공식';
  const sources = [...(base?.sources ?? [])].filter((s: { id?: string }) => s.id !== `edit-${editId}`);
  if (input.url && !sources.some((s: { url: string }) => linkKey(s.url) === linkKey(input.url))) sources.unshift({ type: 'submission', id: `edit-${editId}`, url: input.url, title: '운영자 입력', publishedAt: now });
  return {
    timezone: null, extractedBy: 'rule', audience: 'all', evidence: '운영자 입력',
    ...base,
    id: base?.id ?? `m-${editId}`,
    date: input.date ?? base?.date ?? now.slice(0, 10),
    time: input.time === undefined ? base?.time ?? null : input.time || null,
    endDate: input.endDate === undefined ? base?.endDate ?? null : input.endDate || null,
    endTime: input.endTime === undefined ? base?.endTime ?? null : input.endTime || null,
    title: input.title ?? base?.title ?? '',
    step: input.step ?? base?.step ?? '',
    kind,
    members,
    scope: members.length === 0 || members.length >= memberCount ? '단체' : members.length === 1 ? '멤버' : '유닛',
    status: 'confirmed',
    category,
    calendars: base?.kind === kind && base?.calendars ? base.calendars : [category],
    sources,
  };
}

// ── 소식 ──
type Feed = { url: string; title: string; publishedAt: string; [k: string]: any };
export function applyFeed<T extends Feed>(items: T[], edits: Edit[]): T[] {
  const fx = byKind(edits, 'feed');
  if (!fx.length) return items;
  const gone = new Set(fx.filter((x) => x.op !== 'add' && x.target.url).map((x) => normUrl(x.target.url)));
  const snaps = fx.filter((x) => x.op !== 'hide' && x.data?.url).map((x) => x.data as T);
  const snapUrls = new Set(snaps.map((s) => normUrl(s.url)));
  const urlsOf = (f: T) => [f.url, ...((f.articles as { url: string }[] | undefined) ?? []).map((a) => a.url)].map(normUrl);
  const out = items.filter((f) => !snapUrls.has(normUrl(f.url)) && !urlsOf(f).some((u) => gone.has(u)));
  out.push(...snaps);
  return out.sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
}

// ── 시리즈 ──
type SeriesSummaryLike = { id: string; name: string; type: string; count: number; from: string; to: string; thumb?: string; members: string[] };
type SeriesPageLike = SeriesSummaryLike & {
  seasons: { name: string; videos: { id: string; url: string; title: string; thumb: string; date: string; ep: number | null; members: string[] }[] }[];
  episodes?: { date: string; time: string | null; title: string; step: string; members: string[]; url?: string; thumb?: string }[];
  activities?: unknown[];
};
const ADDED_SEASON = '추가한 영상';
const range = (dates: string[]) => { const s = dates.filter(Boolean).sort(); return { from: s[0] ?? '', to: s.at(-1) ?? '' }; };

function seriesFromAdd(x: Edit): SeriesPageLike {
  const d = x.data as SeriesEditData & { id: string };
  const vids = d.addVideos ?? [];
  const episodes = vids.map((v) => ({ date: v.date, time: null, title: v.title, step: v.title, members: v.members, url: v.url, thumb: v.thumb })).sort((a, b) => b.date.localeCompare(a.date));
  return { id: d.id, name: d.name ?? '', type: d.type ?? '외부활동', count: episodes.length, ...range(episodes.map((e) => e.date)), thumb: d.thumb ?? episodes[0]?.thumb,
    members: [...new Set(episodes.flatMap((e) => e.members))], seasons: [], episodes };
}
const seriesEdits = (edits: Edit[], id: string) => byKind(edits, 'series').filter((x) => x.target.id === id || x.data?.id === id);

export function applySeriesList<T extends SeriesSummaryLike>(list: T[], edits: Edit[]): T[] {
  const sx = byKind(edits, 'series');
  if (!sx.length) return list;
  const hidden = new Set(sx.filter((x) => x.op === 'hide').map((x) => x.target.id));
  const out = list.filter((s) => !hidden.has(s.id)).map((s) => {
    const p = sx.find((x) => x.op === 'patch' && x.target.id === s.id)?.data as SeriesEditData | undefined;
    return p ? { ...s, ...(p.name ? { name: p.name } : {}), ...(p.type ? { type: p.type } : {}), ...(p.thumb ? { thumb: p.thumb } : {}) } : s;
  });
  for (const x of sx.filter((x) => x.op === 'add' && !hidden.has(x.data?.id))) {
    if (out.some((s) => s.id === x.data.id)) continue;
    const { seasons, episodes, activities, ...summary } = seriesFromAdd(x);
    out.push(summary as unknown as T);
  }
  return out;
}

/** 시리즈 한 페이지에 덧씌우기 (손으로 만든 시리즈는 원래 파일이 없어도 만든다) */
export function applySeriesPage<T extends SeriesPageLike>(page: T | null, id: string, edits: Edit[]): T | null {
  const sx = seriesEdits(edits, id);
  if (!sx.length) return page;
  if (sx.some((x) => x.op === 'hide')) return null;
  const add = sx.find((x) => x.op === 'add');
  if (add) return seriesFromAdd(add) as T;
  if (!page) return null;
  const p = sx.find((x) => x.op === 'patch')?.data as SeriesEditData | undefined;
  if (!p) return page;
  const remove = new Set(p.removeVideos ?? []);
  const keep = (v: { id?: string; url?: string }) => !videoKeys(v).some((k) => remove.has(k));
  let seasons = page.seasons.map((s) => ({ ...s, videos: s.videos.filter(keep) })).filter((s) => s.videos.length);
  let episodes = page.episodes?.filter(keep);
  const have = new Set([...seasons.flatMap((s) => s.videos.flatMap(videoKeys)), ...(episodes ?? []).flatMap(videoKeys)]);
  const added = (p.addVideos ?? []).filter((v) => !videoKeys(v).some((k) => have.has(k)) && !remove.has(v.id));
  if (added.length) {
    if (episodes || !seasons.length) {
      episodes = [...(episodes ?? []), ...added.map((v) => ({ date: v.date, time: null, title: v.title, step: v.title, members: v.members, url: v.url, thumb: v.thumb }))]
        .sort((a, b) => b.date.localeCompare(a.date));
    } else {
      const extra = { name: ADDED_SEASON, videos: added.map((v) => ({ id: v.id, url: v.url, title: v.title, thumb: v.thumb, date: v.date, ep: null, members: v.members })) };
      seasons = [...seasons.filter((s) => s.name !== ADDED_SEASON), extra];
    }
  }
  const all = [...seasons.flatMap((s) => s.videos), ...(episodes ?? [])];
  return {
    ...page,
    ...(p.name ? { name: p.name } : {}), ...(p.type ? { type: p.type } : {}), ...(p.thumb ? { thumb: p.thumb } : {}),
    seasons, ...(episodes ? { episodes } : {}),
    count: page.activities ? page.count : all.length,
    ...(all.length && !page.activities ? range(all.map((v) => v.date)) : {}),
  };
}
/** 손으로 만든 시리즈 페이지들 (수집기가 결과에 더할 때) */
export const addedSeriesPages = (edits: Edit[]) => byKind(edits, 'series')
  .filter((x) => x.op === 'add' && x.data?.id && !byKind(edits, 'series').some((h) => h.op === 'hide' && h.target.id === x.data.id))
  .map(seriesFromAdd);

// ── 아카이브(활동) ──
type EraSummaryLike = { id: string; title: string; subtitle?: string; from: string; to: string; thumb?: string; [k: string]: any };
const ERA_VIDEO_LISTS = ['official', 'own', 'related', 'shorts', 'outside', 'news'] as const;

export function applyEraList<T extends EraSummaryLike>(list: T[], edits: Edit[]): T[] {
  const ex = byKind(edits, 'era');
  if (!ex.length) return list;
  const hidden = new Set(ex.filter((x) => x.op === 'hide').map((x) => x.target.id));
  return list.filter((e) => !hidden.has(e.id)).map((e) => {
    const p = ex.find((x) => x.op === 'patch' && x.target.id === e.id)?.data as EraEditData | undefined;
    return p ? eraFields(e, p) : e;
  });
}
const eraFields = <T extends EraSummaryLike>(e: T, p: EraEditData): T => {
  const out: any = { ...e, ...(p.title ? { title: p.title } : {}), ...(p.subtitle !== undefined ? { subtitle: p.subtitle || undefined } : {}), ...(p.thumb ? { thumb: p.thumb } : {}) };
  if (p.from || p.to) {
    out.from = p.from || e.from;
    out.to = p.to || e.to;
    if (e.cover) out.cover = { ...e.cover, from: out.from, to: out.to };
  }
  return out as T;
};

export function applyEraPage<T extends EraSummaryLike>(page: T | null, edits: Edit[]): T | null {
  if (!page) return page;
  const ex = byKind(edits, 'era').filter((x) => x.target.id === page.id);
  if (!ex.length) return page;
  if (ex.some((x) => x.op === 'hide')) return null;
  const p = ex.find((x) => x.op === 'patch')?.data as EraEditData | undefined;
  if (!p) return page;
  const out: any = eraFields(page, p);
  const remove = new Set(p.removeVideos ?? []);
  const keep = (v: { id?: string; url?: string }) => !videoKeys(v).some((k) => remove.has(k));
  if (remove.size) {
    for (const k of ERA_VIDEO_LISTS) if (Array.isArray(out[k])) out[k] = out[k].filter(keep);
    if (Array.isArray(out.stages)) out.stages = out.stages.map((s: { videos: unknown[] }) => ({ ...s, videos: (s.videos as { id: string }[]).filter(keep) })).filter((s: { videos: unknown[] }) => s.videos.length);
    if (Array.isArray(out.fancams)) out.fancams = out.fancams.map((s: { videos: unknown[] }) => ({ ...s, videos: (s.videos as { id: string }[]).filter(keep) })).filter((s: { videos: unknown[] }) => s.videos.length);
  }
  const have = new Set(ERA_VIDEO_LISTS.flatMap((k) => (Array.isArray(out[k]) ? out[k] : []).flatMap(videoKeys)));
  for (const v of p.addVideos ?? []) {
    if (videoKeys(v).some((k) => have.has(k)) || remove.has(v.id)) continue;
    const to = v.to ?? 'related';
    const video = { id: v.id, title: v.title, url: v.url, thumb: v.thumb, date: v.date, channel: '', members: v.members, ...(to !== 'official' ? { group: v.group || '추가한 영상' } : {}) };
    out[to] = [...(Array.isArray(out[to]) ? out[to] : []), video];
    if (to === 'own' && Array.isArray(out.ownGroups) && !out.ownGroups.includes(video.group)) out.ownGroups = [...out.ownGroups, video.group];
  }
  if (out.counts) out.counts = { ...out.counts, official: out.official?.length ?? 0, own: out.own?.length ?? 0, outside: out.outside?.length ?? 0, stages: (out.stages ?? []).reduce((n: number, s: { videos: unknown[] }) => n + s.videos.length, 0) };
  return out;
}

// ── 데이터 파일 하나에 덧씌우기 (사이트) ──
const EDITABLE_PATH = /^(?:events\.json|events\/(?:\d{4}-\d{2}|months)\.json|feed\.json|series\.json|series\/.+\.json|eras\.json|eras\/.+\.json)$/;
export const isEditablePath = (path: string) => EDITABLE_PATH.test(path);

export function applyToFile(path: string, data: any, edits: Edit[]): any {
  if (!edits.length || !isEditablePath(path)) return data;
  if (path === 'events.json') return data && { ...data, events: applyEvents(data.events ?? [], edits) };
  if (path === 'events/months.json') return data && { ...data, months: applyMonths(data.months ?? {}, edits) };
  const month = path.match(/^events\/(\d{4}-\d{2})\.json$/)?.[1];
  if (month) {
    const base = data ?? { month, events: [] };
    return { ...base, events: applyEvents(base.events ?? [], edits, month) };
  }
  if (path === 'feed.json') return data && { ...data, items: applyFeed(data.items ?? [], edits) };
  if (path === 'series.json') return data && { ...data, series: applySeriesList(data.series ?? [], edits) };
  if (path === 'eras.json') return data && { ...data, eras: applyEraList(data.eras ?? [], edits) };
  const seriesId = path.match(/^series\/(.+)\.json$/)?.[1];
  if (seriesId) return applySeriesPage(data, seriesId, edits);
  if (path.startsWith('eras/')) return applyEraPage(data, edits);
  return data;
}
