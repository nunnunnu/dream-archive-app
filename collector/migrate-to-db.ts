/**
 * 한 번만: data/state 의 JSON 파일과 .cache/raw 원문을 Postgres(db/state.sql·state2.sql)로 옮긴다.
 * 다시 돌려도 같은 키는 덮어써서 괜찮다. 사용: npm run migrate:db
 */
import './lib/env.ts';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { pgClean, pgCount, pgUpsert } from './lib/pg.ts';
import { JsonRepo, type ArticleRecord, type ExtractionRecord, type NoticeRecord } from './lib/repo.ts';
import { CACHE_DIR, DATA_DIR, readJson } from './lib/store.ts';
import { readVideoMonth, videoMonths, writeVideoMonth } from './lib/videoStore.ts';

const repo = new JsonRepo();
const asPg = async (fn: () => Promise<unknown>) => { process.env.STORE = 'pg'; try { await fn(); } finally { delete process.env.STORE; } };
const walk = async (dir: string): Promise<string[]> => (await readdir(dir, { withFileTypes: true }).catch(() => [])).flatMap((d) => (d.isDirectory() ? [] : [join(dir, d.name)])).concat(
  ...(await Promise.all((await readdir(dir, { withFileTypes: true }).catch(() => [])).filter((d) => d.isDirectory()).map((d) => walk(join(dir, d.name))))));

delete process.env.STORE;
// 1) 공지
const notices = Object.values(await readJson<Record<string, NoticeRecord>>('state/notices.json', {}));
await asPg(() => repo.putNotices(notices));
// 2) 기사
const articles: ArticleRecord[] = [];
for (const f of (await readdir(join(DATA_DIR, 'state', 'articles')).catch(() => [])).filter((x) => /^\d{4}-\d{2}\.json$/.test(x))) articles.push(...Object.values(await readJson<Record<string, ArticleRecord>>(`state/articles/${f}`, {})));
await asPg(() => repo.putArticles(articles));
// 3) AI 추출 결과 (파일 이름 = doc_id)
let extractions = 0;
for (const type of await readdir(join(DATA_DIR, 'state', 'extractions')).catch(() => [] as string[])) {
  const rows: Record<string, unknown>[] = [];
  for (const f of (await readdir(join(DATA_DIR, 'state', 'extractions', type))).filter((x) => x.endsWith('.json') && !x.startsWith('.'))) {
    const rec = await readJson<ExtractionRecord | null>(`state/extractions/${type}/${f}`, null);
    if (rec) rows.push({ doc_type: type, doc_id: f.slice(0, -5), prompt_version: rec.promptVersion, content_hash: rec.contentHash, data: pgClean(rec), created_at: rec.createdAt });
  }
  await pgUpsert('extractions', rows, 'doc_type,doc_id', 100);
  extractions += rows.length;
}
// 4) 원문 (.cache/raw/<종류>/<id>.txt)
const bodyRows: Record<string, unknown>[] = [];
for (const file of (await walk(CACHE_DIR)).filter((f) => f.endsWith('.txt'))) {
  const [kind, name] = relative(CACHE_DIR, file).split('/');
  if (!name) continue;
  bodyRows.push({ kind, id: name.slice(0, -4), text: pgClean(await readFile(file, 'utf8')), updated_at: new Date().toISOString() });
}
await pgUpsert('bodies', bodyRows, 'kind,id', 40);
// 5) 영상 (달마다)
let videos = 0;
for (const ym of await videoMonths()) {
  const rec = await readVideoMonth(ym);
  videos += Object.keys(rec).length;
  await asPg(() => writeVideoMonth(ym, rec));
}
// 6) 그 밖의 상태 → app_state (제보·출처 링크·비용은 정식 테이블로)
const states: string[] = [];
for (const file of await walk(join(DATA_DIR, 'state'))) {
  const key = relative(join(DATA_DIR, 'state'), file).replace(/\.json$/, '');
  if (!file.endsWith('.json') || key === 'notices' || key.startsWith('articles/') || key.startsWith('extractions/') || /^youtube\/\d{4}-\d{2}$/.test(key) || /(^|\/)\./.test(key)) continue;
  const value = JSON.parse(await readFile(file, 'utf8'));
  await asPg(() => repo.putState(key, value));
  states.push(key);
}
console.log(`옮김: 공지 ${notices.length} · 기사 ${articles.length} · AI 추출 ${extractions} · 원문 ${bodyRows.length} · 영상 ${videos} · 상태 ${states.length}개 (${states.join(', ')})`);
const tables = ['notices', 'articles', 'extractions', 'bodies', 'videos', 'app_state', 'reports', 'submissions', 'llm_usage'];
console.log('DB 행 수:', Object.fromEntries(await Promise.all(tables.map(async (t) => [t, await pgCount(t)]))));
