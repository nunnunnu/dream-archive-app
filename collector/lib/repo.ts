/**
 * 저장소 창구. 수집·처리 코드는 이 인터페이스로만 읽고 쓴다.
 * 지금은 JSON 파일 구현(JsonRepo)이고, 사이트 구조가 정해지면 Supabase·D1 구현으로 바꿔 끼우면 된다.
 *
 * JSON 구현의 파일 위치
 *  - data/state/notices.json                    위버스 공지 목록 (본문 제외)
 *  - data/state/articles/YYYY-MM.json           기사 목록 (월별)
 *  - data/state/extractions/{notice|article}/…  AI가 문서에서 뽑은 일정
 *  - data/state/{key}.json                      기타 상태 (번호 커서, 비용, 재검색 기록 …)
 *  - data/public/…                              사이트가 읽는 결과
 *  - .cache/raw/{notice|article}/…              원문 본문 (Git에 올리지 않음)
 */
import { createHash } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { SourceRef } from './consolidate.ts';
import type { CheckedEvent, LlmEvent } from './llm.ts';
import { pgClean, pgSelect, pgUpsert, usePg } from './pg.ts';
import { DATA_DIR, readJson, readRaw, writeJson, writeRaw, writeText } from './store.ts';
import { toKstParts } from './time.ts';

export interface NoticeRecord {
  id: string;
  community: string;
  url: string;
  title: string;
  /** 위버스에 표시된 작성 시각 (KST ISO) */
  postedAt: string;
  bodyHash: string;
  firstFetchedAt: string;
  lastChangedAt: string;
  /** 본문 속 큰 이미지 주소 (없으면 아직 확인 안 함) */
  images?: string[];
}

export interface ArticleRecord {
  guid: string;
  title: string;
  link: string;
  source: string;
  publishedAt: string;
  firstSeenAt: string;
  /** search: NCT DREAM 검색, followup: 빈칸 채우기 검색 */
  origin: 'search' | 'followup';
  /** 기사 페이지에 적힌 작성 시각 (구글 뉴스 날짜와 다를 때가 있다. 있으면 이것을 쓴다) */
  pagePublishedAt?: string;
  /** followup일 때 무엇을 찾으려던 검색인지 (예: "MMA 2026") */
  focus?: string;
  clusterId?: string;
  /** 본문 처리 상태 */
  status?: 'pending' | 'skipped' | 'processed' | 'failed';
  note?: string;
  /** Google News 중계가 아닌 실제 언론사 주소와 대표 이미지 (파일은 저장하지 않음) */
  originalUrl?: string;
  image?: string;
  imageCheckedAt?: string;
}

export type DocType = 'namu' | 'notice' | 'article' | 'submission' | 'video' | 'post' | 'notice-image';

export interface ExtractionRecord {
  docType: DocType;
  docId: string;
  model: string;
  promptVersion: number;
  /** 처리한 본문의 해시. 본문이 바뀌면 다시 뽑는다 */
  contentHash: string;
  /** AI가 낸 그대로 */
  events: LlmEvent[];
  /** 원문 대조를 통과한 일정 (본문 없이도 다시 쓸 수 있게 저장) */
  checked: CheckedEvent[];
  dropped: { reason: string; event: LlmEvent }[];
  /** 어떤 문서에서 뽑았는지 (사이트 출처 표시용) */
  source: SourceRef;
  usage: { input: number; output: number; costUsd: number };
  createdAt: string;
}

export interface Repo {
  getBody(kind: DocType, id: string): Promise<string | null>;
  putBody(kind: DocType, id: string, text: string): Promise<void>;

  listNotices(): Promise<NoticeRecord[]>;
  putNotices(notices: NoticeRecord[]): Promise<void>;

  listArticles(sinceIso: string): Promise<ArticleRecord[]>;
  putArticles(articles: ArticleRecord[]): Promise<void>;

  getExtraction(docType: DocType, docId: string): Promise<ExtractionRecord | null>;
  putExtraction(rec: ExtractionRecord): Promise<void>;
  listExtractions(docType: DocType): Promise<ExtractionRecord[]>;

  getState<T>(key: string, fallback: T): Promise<T>;
  putState(key: string, value: unknown): Promise<void>;

  /** 사이트용 결과. 문자열이면 그대로(.ics 등), 아니면 JSON */
  publish(name: string, value: unknown): Promise<void>;
}

/** 파일 이름으로 쓸 수 있게 긴 id(구글 뉴스 guid 등)를 줄인다 */
export const fileId = (id: string) => (/^[\w-]{1,40}$/.test(id) ? id : createHash('sha1').update(id).digest('hex').slice(0, 20));

const monthKey = (iso: string) => {
  const p = toKstParts(new Date(iso));
  return `${p.year}-${String(p.month).padStart(2, '0')}`;
};

const enc = encodeURIComponent;
const now = () => new Date().toISOString();
// DB 모드: 원문·AI 추출 결과는 처음 한 번 통째로 읽어 메모리에 둔다 (문서마다 묻으면 요청이 수백 번 오가서 느림)
const bodyCache = new Map<string, Map<string, string>>();
const extractionCache = new Map<string, Map<string, ExtractionRecord>>();
async function bodiesOf(kind: string) {
  if (!bodyCache.has(kind)) bodyCache.set(kind, new Map((await pgSelect<{ id: string; text: string }>('bodies', `select=id,text&kind=eq.${kind}`)).map((r) => [r.id, r.text])));
  return bodyCache.get(kind)!;
}
async function extractionsOf(type: string) {
  if (!extractionCache.has(type)) extractionCache.set(type, new Map((await pgSelect<{ doc_id: string; data: ExtractionRecord }>('extractions', `select=doc_id,data&doc_type=eq.${type}`)).map((r) => [r.doc_id, r.data])));
  return extractionCache.get(type)!;
}

/**
 * 수집 상태 저장 창구. STORE=pg 면 Supabase Postgres(db/state.sql·state2.sql), 아니면 data/state 의 JSON 파일.
 * (이름은 예전 그대로 JsonRepo. 부르는 쪽 코드는 저장 방식을 몰라도 된다)
 */
export class JsonRepo implements Repo {
  async getBody(kind: DocType, id: string) {
    if (usePg()) return (await bodiesOf(kind)).get(fileId(id)) ?? null;
    return readRaw(`${kind}/${fileId(id)}.txt`);
  }
  async putBody(kind: DocType, id: string, text: string) {
    if (usePg()) { (await bodiesOf(kind)).set(fileId(id), text); return pgUpsert('bodies', [{ kind, id: fileId(id), text: pgClean(text), updated_at: now() }], 'kind,id'); }
    return writeRaw(`${kind}/${fileId(id)}.txt`, text);
  }

  async listNotices() {
    if (usePg()) return (await pgSelect<{ data: NoticeRecord }>('notices', 'select=data')).map((r) => r.data);
    return Object.values(await readJson<Record<string, NoticeRecord>>('state/notices.json', {}));
  }
  async putNotices(notices: NoticeRecord[]) {
    if (usePg()) return pgUpsert('notices', notices.map((n) => ({ id: n.id, posted_at: n.postedAt, title: n.title, url: n.url, data: pgClean(n), updated_at: now() })), 'id');
    const sorted = [...notices].sort((a, b) => Number(b.id) - Number(a.id));
    await writeJson('state/notices.json', Object.fromEntries(sorted.map((n) => [n.id, n])));
  }

  async listArticles(sinceIso: string) {
    if (usePg()) return (await pgSelect<{ data: ArticleRecord }>('articles', `select=data&published_at=gte.${enc(sinceIso)}&order=published_at.desc,guid.asc`)).map((r) => r.data);
    const months: string[] = [];
    const d = new Date(sinceIso);
    const end = monthKey(new Date().toISOString());
    for (let m = monthKey(d.toISOString()); m <= end; ) {
      months.push(m);
      const [y, mm] = m.split('-').map(Number);
      m = mm === 12 ? `${y + 1}-01` : `${y}-${String(mm + 1).padStart(2, '0')}`;
    }
    const out: ArticleRecord[] = [];
    for (const m of months) out.push(...Object.values(await readJson<Record<string, ArticleRecord>>(`state/articles/${m}.json`, {})));
    return out.filter((a) => a.publishedAt >= sinceIso);
  }
  async putArticles(articles: ArticleRecord[]) {
    if (usePg()) return pgUpsert('articles', articles.map((a) => ({ guid: a.guid, published_at: a.publishedAt, title: a.title, status: a.status ?? null, data: pgClean(a), updated_at: now() })), 'guid');
    const byMonth = new Map<string, ArticleRecord[]>();
    for (const a of articles) byMonth.set(monthKey(a.publishedAt), [...(byMonth.get(monthKey(a.publishedAt)) ?? []), a]);
    for (const [m, list] of byMonth) {
      const path = `state/articles/${m}.json`;
      const stored = await readJson<Record<string, ArticleRecord>>(path, {});
      for (const a of list) stored[a.guid] = a;
      const sorted = Object.entries(stored).sort(([, a], [, b]) => b.publishedAt.localeCompare(a.publishedAt));
      await writeJson(path, Object.fromEntries(sorted));
    }
  }

  async getExtraction(docType: DocType, docId: string) {
    if (usePg()) return (await extractionsOf(docType)).get(fileId(docId)) ?? null;
    return readJson<ExtractionRecord | null>(`state/extractions/${docType}/${fileId(docId)}.json`, null);
  }
  async putExtraction(rec: ExtractionRecord) {
    if (usePg()) (await extractionsOf(rec.docType)).set(fileId(rec.docId), rec);
    if (usePg()) return pgUpsert('extractions', [{ doc_type: rec.docType, doc_id: fileId(rec.docId), prompt_version: rec.promptVersion, content_hash: rec.contentHash, data: pgClean(rec), created_at: rec.createdAt }], 'doc_type,doc_id');
    return writeJson(`state/extractions/${rec.docType}/${fileId(rec.docId)}.json`, rec);
  }
  async listExtractions(docType: DocType) {
    if (usePg()) return [...(await extractionsOf(docType)).values()];
    let files: string[] = [];
    try {
      files = await readdir(join(DATA_DIR, 'state', 'extractions', docType));
    } catch {
      return [];
    }
    const out: ExtractionRecord[] = [];
    for (const f of files) if (f.endsWith('.json') && !f.startsWith('.')) out.push(await readJson<ExtractionRecord>(`state/extractions/${docType}/${f}`, null as never));
    return out.filter(Boolean);
  }

  async getState<T>(key: string, fallback: T): Promise<T> {
    if (!usePg()) return readJson<T>(`state/${key}.json`, fallback);
    // 제보·출처 링크·AI 비용은 정식 테이블, 나머지는 app_state(jsonb)
    if (key === 'usage') {
      const rows = await pgSelect<{ bucket: string; cost_usd: string; calls: number }>('llm_usage', 'select=bucket,cost_usd,calls');
      return (rows.length ? Object.fromEntries(rows.map((r) => [r.bucket, { costUsd: Number(r.cost_usd), calls: r.calls }])) : fallback) as T;
    }
    if (key === 'reports') {
      const rows = await pgSelect<ReportRow>('reports', 'select=*');
      return (rows.length ? Object.fromEntries(rows.map((r) => [r.id, reportFromRow(r)])) : fallback) as T;
    }
    if (key === 'submissions') {
      const rows = await pgSelect<{ data: unknown }>('submissions', 'select=data&order=added_at.asc');
      return (rows.length ? rows.map((r) => r.data) : fallback) as T;
    }
    const rows = await pgSelect<{ value: T }>('app_state', `select=value&key=eq.${enc(key)}`);
    return rows.length ? rows[0].value : fallback;
  }
  async putState(key: string, value: unknown) {
    if (!usePg()) return writeJson(`state/${key}.json`, value);
    if (key === 'usage') {
      return pgUpsert('llm_usage', Object.entries(value as Record<string, { costUsd: number; calls: number }>).map(([bucket, u]) => ({ bucket, cost_usd: u.costUsd, calls: u.calls, updated_at: now() })), 'bucket');
    }
    if (key === 'reports') return pgUpsert('reports', Object.values(value as Record<string, Record<string, unknown>>).map(reportToRow), 'id');
    if (key === 'submissions') {
      return pgUpsert('submissions', (value as { id: string; url: string; note?: string; status?: string; addedAt?: string }[]).map((x) => ({ id: x.id, url: x.url, note: x.note ?? null, status: x.status ?? null, added_at: x.addedAt ?? now(), data: pgClean(x) })), 'id');
    }
    return pgUpsert('app_state', [{ key, value: pgClean(value), updated_at: now() }], 'key');
  }

  publish(name: string, value: unknown) {
    return typeof value === 'string' ? writeText(`public/${name}`, value) : writeJson(`public/${name}`, value);
  }
}

/** 제보 ↔ reports 테이블 행: 알려진 값은 열로, 일정 당시 모습은 스냅샷, 나머지 제안 값은 proposed_changes */
interface ReportRow { id: string; type: string; event_id: string | null; event_snapshot: Record<string, unknown> | null; title: string | null; source_url: string | null; proposed_changes: Record<string, unknown> | null; message: string | null; status: string; review_reason: string | null; created_at: string; reviewed_at: string | null }
function reportToRow(r: Record<string, unknown>): Record<string, unknown> {
  const { id, type, url, message, eventId, eventTitle, status, createdAt, reviewedAt, reviewReason, ...rest } = r as Record<string, unknown> & { id: string };
  return {
    id, type, event_id: eventId ?? null, title: eventTitle ?? null, source_url: url ?? null, message: message ?? null,
    event_snapshot: eventId ? pgClean({ eventTitle, date: rest.date, time: rest.time, members: rest.members }) : null,
    proposed_changes: pgClean(rest), status: status ?? 'pending', review_reason: reviewReason ?? null,
    created_at: createdAt ?? new Date().toISOString(), reviewed_at: reviewedAt ?? null,
  };
}
function reportFromRow(r: ReportRow): Record<string, unknown> {
  return {
    ...(r.proposed_changes ?? {}), id: r.id, type: r.type, url: r.source_url ?? '', message: r.message ?? '', eventId: r.event_id ?? undefined, eventTitle: r.title ?? undefined,
    status: r.status, createdAt: r.created_at, ...(r.reviewed_at ? { reviewedAt: r.reviewed_at } : {}), ...(r.review_reason ? { reviewReason: r.review_reason } : {}),
  };
}
