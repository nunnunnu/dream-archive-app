/**
 * 아카이브에 빠진 활동을 이름으로 채우기: config/archive-seeds.json 의 이름·기간으로 구글 뉴스를 찾아 기사를 넣고,
 * 평소 흐름(AI 추출 → 검증 → 합치기)으로 일정을 만든다. 활동 페이지는 일정에서 자동으로 묶인다.
 *   STORE=pg npm run backfill:seeds [-- --only=부퀘스트 --minutes=30]
 * 개발 비용(dev 누적)으로 센다. 구글이 막으면 기다렸다 다시 묻고, 그래도 막히면 멈춘다 (우회하지 않음)
 */
import './lib/env.ts';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { Budget } from './lib/budget.ts';
import { GROUP } from './lib/group.ts';
import { googleNewsBlocked, searchGoogleNews } from './lib/googleNews.ts';
import { isDreamRelated, stripPublisher } from './lib/news.ts';
import { processArticles } from './lib/process.ts';
import { JsonRepo, type ArticleRecord } from './lib/repo.ts';
import { ROOT } from './lib/store.ts';

process.env.LLM_BUDGET_BUCKET ??= 'dev';
process.env.LLM_MAX_CALLS_PER_RUN ??= '100000';
const arg = (n: string, d: string) => process.argv.find((a) => a.startsWith(`--${n}=`))?.split('=')[1] ?? d;
const only = arg('only', '');
const deadline = Date.now() + Number(arg('minutes', '40')) * 60_000;

interface Seed { name: string; keywords: string[]; query?: string; from: string; to: string }
const { items } = JSON.parse(readFileSync(join(ROOT, 'config', 'archive-seeds.json'), 'utf8')) as { items: Seed[] };
const seeds = items.filter((s) => !only || s.name.includes(only));

const repo = new JsonRepo();
const now = new Date();
const norm = (s: string) => s.normalize('NFKC').replace(/[^\p{L}\p{N}]+/gu, '').toLowerCase();
const known = await repo.listArticles('2016-01-01T00:00:00Z');
const seen = new Set([...known.map((a) => a.guid), ...known.map((a) => norm(a.title))]);
const members = GROUP.members.flatMap((m) => m.aliases);
const related = (t: string) => isDreamRelated(t) || members.some((a) => t.includes(a));

let earliest = now.toISOString();
for (const s of seeds) {
  const q = s.query ?? `"${GROUP.nameVariants[0]}" (${s.keywords.map((k) => `"${k}"`).join(' OR ')})`;
  const r = await searchGoogleNews(`${q} after:${s.from} before:${s.to}`).catch((e) => { console.log(`검색 실패 ${s.name}: ${(e as Error).message.slice(0, 80)}`); return null; });
  if (!r) { if (googleNewsBlocked()) break; continue; }
  const batch: ArticleRecord[] = [];
  for (const it of r) {
    const title = stripPublisher(it.title, it.source);
    if (/weverse|youtube/i.test(it.source) || seen.has(it.guid) || seen.has(norm(title))) continue;
    if (!related(title) || !s.keywords.some((k) => norm(title).includes(norm(k)))) continue;
    seen.add(it.guid);
    seen.add(norm(title));
    batch.push({ guid: it.guid, title, link: it.link, source: it.source, publishedAt: it.publishedAt.toISOString(), firstSeenAt: now.toISOString(), origin: 'search', status: 'pending' });
  }
  if (batch.length) await repo.putArticles(batch);
  if (s.from < earliest) earliest = s.from;
  console.log(`${s.name}: 검색 ${r.length}건 → 새 기사 ${batch.length}개`);
}

const budget = await new Budget(repo, now).load();
const browser = await chromium.launch();
try {
  const days = Math.ceil((now.getTime() - Date.parse(earliest)) / 864e5) + 1;
  for (const l of await processArticles(repo, () => browser.newPage({ locale: 'ko-KR', timezoneId: 'Asia/Seoul' }), budget, now, { windowDays: days, concurrency: 6, deadline })) console.log(l);
} finally {
  await browser.close();
  await budget.save();
  console.log(budget.summary());
}
