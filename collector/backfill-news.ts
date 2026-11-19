/**
 * 과거 기사 채우기: 상시 수집(2026-11-12~) 전 기간의 활동(개인·유닛·드라마·영화·팬미팅 등 위버스 공지로 안 오는 것)을 찾는다.
 *   1) 달마다 구글 뉴스 RSS 검색 (그룹 이름 / 멤버 이름 묶음, after:·before:) → 관련 기사 제목만 저장
 *   2) 평소 기사 처리(processArticles)로 일정 추출 — 일정과 무관해 보이는 묶음은 AI 없이 건너뛴다
 * 개발 비용은 운영 월 상한과 따로 센다 (LLM_BUDGET_BUCKET=dev). 끊겨도 이어서 한다 (state/backfill/news).
 * 사용: npm run backfill:news -- [--from=2016-08] [--to=2026-10] [--minutes=40]
 */
import './lib/env.ts';
import { chromium } from 'playwright';
import { Budget } from './lib/budget.ts';
import { searchGoogleNews } from './lib/googleNews.ts';
import { GROUP } from './lib/group.ts';
import { isDreamRelated, stripPublisher } from './lib/news.ts';
import { processArticles } from './lib/process.ts';
import { JsonRepo, type ArticleRecord } from './lib/repo.ts';

process.env.LLM_BUDGET_BUCKET ??= 'dev';
process.env.LLM_MAX_CALLS_PER_RUN ??= '100000';
const arg = (n: string, d: string) => process.argv.find((a) => a.startsWith(`--${n}=`))?.split('=')[1] ?? d;
const FROM = arg('from', '2016-08');
const TO = arg('to', '2026-10');
const started = Date.now();
const deadline = started + Number(arg('minutes', '40')) * 60_000;
// 기사 처리까지 합쳐 이 시간 안에 끝낸다 (Actions 작업 제한 150분, 뒤의 올리기·색인 몫을 남김)
const processUntil = started + Number(arg('total-minutes', '110')) * 60_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const repo = new JsonRepo();
const now = new Date();
const state = await repo.getState<{ done: string[] }>('backfill/news', { done: [] });

const people = [...GROUP.members, ...GROUP.formerMembers];
const nameOf = (m: { name: string }) => m.name;
// 그룹 이름 1번 + 멤버 이름 묶음 2번 (OR는 괄호로)
const QUERIES = [
  `"${GROUP.nameVariants[0]}" OR "${GROUP.nameVariants[2]}"`,
  `${GROUP.parentNames[0]} (${people.slice(0, 4).map(nameOf).join(' OR ')})`,
  `${GROUP.parentNames[0]} (${people.slice(4).map(nameOf).join(' OR ')})`,
];
const PERSON_RE = new RegExp(people.flatMap((m) => m.aliases).join('|'), 'i');
const related = (t: string) => isDreamRelated(t) || (/NCT|엔시티/i.test(t) && PERSON_RE.test(t));

const months: string[] = [];
for (let d = new Date(`${FROM}-01T00:00:00Z`); d.toISOString().slice(0, 7) <= TO; d.setUTCMonth(d.getUTCMonth() + 1)) months.push(d.toISOString().slice(0, 7));
const todo = months.filter((m) => !state.done.includes(m)).reverse(); // 최근 달부터

const known = await repo.listArticles('2016-01-01T00:00:00Z');
const seen = new Set([...known.map((a) => a.guid), ...known.map((a) => a.title.replace(/\s+/g, ''))]);
let added = 0;
let blocked = false;
for (const m of todo) {
  if (Date.now() > deadline) break;
  const end = new Date(`${m}-01T00:00:00Z`);
  end.setUTCMonth(end.getUTCMonth() + 1);
  const range = `after:${m}-01 before:${end.toISOString().slice(0, 10)}`;
  const batch: ArticleRecord[] = [];
  let ok = true;
  for (const q of QUERIES) {
    // 요청 제한(429)이면 우회하지 않고 이번 실행은 여기서 멈춘다 (다음 실행에서 이어서)
    const r = await searchGoogleNews(`${q} ${range}`).catch((e) => { if (/429/.test((e as Error).message)) blocked = true; else console.log(`검색 실패 ${m}: ${(e as Error).message.slice(0, 60)}`); return null; });
    if (!r) { ok = false; break; }
    for (const it of r) {
      const title = stripPublisher(it.title, it.source);
      if (/weverse|youtube/i.test(it.source) || !related(title) || seen.has(it.guid) || seen.has(title.replace(/\s+/g, ''))) continue;
      seen.add(it.guid);
      seen.add(title.replace(/\s+/g, ''));
      batch.push({ guid: it.guid, title, link: it.link, source: it.source, publishedAt: it.publishedAt.toISOString(), firstSeenAt: now.toISOString(), origin: 'search', status: 'pending' });
    }
    await sleep(6000);
  }
  if (batch.length) await repo.putArticles(batch);
  added += batch.length;
  if (!ok) break;
  state.done.push(m);
  await repo.putState('backfill/news', state);
  console.log(`${m}: 기사 ${batch.length}개`);
}
console.log(`과거 기사 ${added}개 저장 · 끝난 달 ${state.done.length}/${months.length}${blocked ? ' · 구글 뉴스 요청 제한(429)으로 멈춤 → 다음 실행에서 이어서' : ''}`);

// 저장한 과거 기사에서 일정 뽑기 (남은 시간만큼, 일정과 무관해 보이는 묶음은 AI 없이 건너뜀)
const budget = await new Budget(repo, now).load();
const browser = await chromium.launch();
try {
  const days = Math.ceil((now.getTime() - Date.parse(`${FROM}-01`)) / 864e5);
  for (const l of await processArticles(repo, () => browser.newPage({ locale: 'ko-KR', timezoneId: 'Asia/Seoul' }), budget, now, { windowDays: days, concurrency: 6, deadline: processUntil })) console.log(l);
} finally {
  await browser.close();
  await budget.save();
  console.log(budget.summary());
}
