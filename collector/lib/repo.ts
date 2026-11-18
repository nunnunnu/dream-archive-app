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
}

export type DocType = 'notice' | 'article' | 'submission' | 'video' | 'post';

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

export class JsonRepo implements Repo {
  getBody(kind: DocType, id: string) {
    return readRaw(`${kind}/${fileId(id)}.txt`);
  }
  putBody(kind: DocType, id: string, text: string) {
    return writeRaw(`${kind}/${fileId(id)}.txt`, text);
  }

  async listNotices() {
    return Object.values(await readJson<Record<string, NoticeRecord>>('state/notices.json', {}));
  }
  async putNotices(notices: NoticeRecord[]) {
    const sorted = [...notices].sort((a, b) => Number(b.id) - Number(a.id));
    await writeJson('state/notices.json', Object.fromEntries(sorted.map((n) => [n.id, n])));
  }

  async listArticles(sinceIso: string) {
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

  getExtraction(docType: DocType, docId: string) {
    return readJson<ExtractionRecord | null>(`state/extractions/${docType}/${fileId(docId)}.json`, null);
  }
  putExtraction(rec: ExtractionRecord) {
    return writeJson(`state/extractions/${rec.docType}/${fileId(rec.docId)}.json`, rec);
  }
  async listExtractions(docType: DocType) {
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

  getState<T>(key: string, fallback: T) {
    return readJson<T>(`state/${key}.json`, fallback);
  }
  putState(key: string, value: unknown) {
    return writeJson(`state/${key}.json`, value);
  }

  publish(name: string, value: unknown) {
    return typeof value === 'string' ? writeText(`public/${name}`, value) : writeJson(`public/${name}`, value);
  }
}
