/**
 * 팬 질문 에이전트 평가: eval/ask-questions.json 의 질문을 모두 물어보고 규칙으로 채점한다.
 *   npm run eval:ask [-- --label=baseline] [--only=q07,q09] [--model=gpt-5-nano]
 * 결과는 eval/results/{label}-{시각}.json 에 남기고, 통과율·출처 포함률·확인 안 된 날짜·비용을 출력한다.
 */
import './lib/env.ts';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { askQuestion, type AskResult } from './lib/ask.ts';
import { Budget } from './lib/budget.ts';
import { JsonRepo } from './lib/repo.ts';
import { ROOT } from './lib/store.ts';

interface Q { id: string; cat: string; q: string; history?: { q: string; a: string }[]; all?: string[]; any?: string[]; any2?: string[][]; none?: string[]; cite?: string[]; unknown?: boolean }
const set = JSON.parse(readFileSync(join(ROOT, 'eval', 'ask-questions.json'), 'utf8')) as { today: string; questions: Q[] };
const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split('=')[1];
const label = arg('label') ?? 'run';
const only = arg('only')?.split(',');
const model = arg('model');
const retrieval = (arg('retrieval') ?? 'hybrid') as 'keyword' | 'hybrid';
const UNKNOWN_RE = /자료에[^.\n]{0,40}(없|않)|공지 전|확인되지 않|찾을 수 없|정보가 없|나와 있지 않|일정 없음|없습니다|없어요/;
/** 채점용 정규화: 2026-11-24·2026.11.24 → 11/24, 8:00PM → 20:00 도 함께 붙여서 표기 차이로 틀리지 않게 */
function normalize(a: string): string {
  const extra: string[] = [];
  for (const m of a.matchAll(/(?:\d{4})[-.]\s?(\d{1,2})[-.]\s?(\d{1,2})/g)) extra.push(`${Number(m[1])}/${Number(m[2])} ${Number(m[2])}일`);
  for (const m of a.matchAll(/(\d{1,2})(?::(\d{2}))?\s*(AM|PM)/gi)) { let h = Number(m[1]) % 12; if (/pm/i.test(m[3])) h += 12; extra.push(`${String(h).padStart(2, '0')}:${m[2] ?? '00'}`); }
  return `${a}\n${extra.join(' ')}`;
}

function grade(q: Q, r: AskResult): string[] {
  const fails: string[] = [];
  const re = (p: string) => new RegExp(p, 'i');
  r = { ...r, answer: normalize(r.answer) };
  for (const p of q.all ?? []) if (!re(p).test(r.answer)) fails.push(`빠짐 ${p}`);
  if (q.any && !q.any.some((p) => re(p).test(r.answer))) fails.push(`하나도 없음 ${q.any.join('|')}`);
  for (const g of q.any2 ?? []) if (!g.some((p) => re(p).test(r.answer))) fails.push(`하나도 없음 ${g.join('|')}`);
  for (const p of q.none ?? []) if (re(p).test(r.answer)) fails.push(`나오면 안 됨 ${p}`);
  if (q.cite && !r.sources.some((s) => q.cite!.some((c) => s.url.includes(c)))) fails.push(`출처 없음 ${q.cite.join('|')}`);
  if (q.unknown && !UNKNOWN_RE.test(r.answer)) fails.push('모른다고 하지 않음');
  return fails;
}

const repo = new JsonRepo();
const budget = await new Budget(repo, new Date()).load();
const questions = set.questions.filter((q) => !only || only.includes(q.id));
const rows: { id: string; cat: string; q: string; pass: boolean; fails: string[]; answer: string; sources: AskResult['sources']; unverified: string[]; costUsd: number; query: AskResult['query']; recall?: { candidates: boolean; final: boolean } }[] = [];
// 3개씩 동시에
// --gap=60: 문항 사이를 60초 띄우고 한 문항씩 (Groq 무료 분당 한도 안에서 재려고)
const GAP = Number(process.argv.find((a) => a.startsWith('--gap='))?.split('=')[1] ?? 0);
for (let i = 0; i < questions.length; i += GAP ? 1 : 3) {
  const batch = questions.slice(i, i + (GAP ? 1 : 3));
  if (GAP && i > 0) await new Promise((r) => setTimeout(r, GAP * 1000));
  const results = await Promise.all(batch.map((q) => askQuestion(q.q, { repo, budget, today: set.today, model, history: q.history, retrieval }).catch((e) => ({ error: (e as Error).message }) as const)));
  batch.forEach((q, j) => {
    const r = results[j];
    if ('error' in r) {
      rows.push({ id: q.id, cat: q.cat, q: q.q, pass: false, fails: [`오류 ${r.error}`], answer: '', sources: [], unverified: [], costUsd: 0, query: { from: null, to: null, programs: [], members: [], keywords: [] } });
      return;
    }
    const fails = grade(q, r);
    // 검색 정확도: 정답 출처(cite)가 리랭킹 전 후보 / 최종 자료(일정 출처 포함) 안에 있는지
    const inList = (l: string[]) => (q.cite ?? []).some((c) => l.some((u) => u.includes(c)));
    const recall = q.cite && r.retrieval ? { candidates: inList([...r.retrieval.candidates, ...r.retrieval.events]), final: inList([...r.retrieval.final, ...r.retrieval.events]) } : undefined;
    rows.push({ id: q.id, cat: q.cat, q: q.q, pass: fails.length === 0, fails, answer: r.answer, sources: r.sources, unverified: r.unverified, costUsd: r.stats.costUsd, query: r.query, recall });
    console.log(`${fails.length ? '✗' : '✓'} ${q.id} [${q.cat}] ${q.q}${fails.length ? `\n    ${fails.join(' / ')}` : ''}${r.unverified.length ? `\n    ⚠ 확인 안 됨: ${r.unverified.join(', ')}` : ''}`);
  });
}
await budget.save();

const n = rows.length;
const pass = rows.filter((r) => r.pass).length;
const cited = rows.filter((r) => r.sources.length > 0).length;
const unverified = rows.filter((r) => r.unverified.length > 0).length;
const cost = rows.reduce((s, r) => s + r.costUsd, 0);
const byCat = [...new Set(rows.map((r) => r.cat))].map((c) => { const rs = rows.filter((r) => r.cat === c); return `${c} ${rs.filter((r) => r.pass).length}/${rs.length}`; });
console.log(`\n통과 ${pass}/${n} (${Math.round((pass / n) * 100)}%) · ${byCat.join(' · ')}`);
const withCite = rows.filter((r) => r.recall);
console.log(`검색 정확도(정답 출처 포함): 후보 ${withCite.filter((r) => r.recall!.candidates).length}/${withCite.length} · 최종 ${withCite.filter((r) => r.recall!.final).length}/${withCite.length}`);
console.log(`출처 단 답 ${cited}/${n} · 확인 안 된 날짜·시간이 나온 답 ${unverified}/${n} · 비용 약 ${Math.round(cost * 1400)}원`);
mkdirSync(join(ROOT, 'eval', 'results'), { recursive: true });
const file = join(ROOT, 'eval', 'results', `${label}-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '')}.json`);
writeFileSync(file, JSON.stringify({ label, retrieval, today: set.today, model: model ?? process.env.ASK_MODEL ?? 'gpt-5-mini', pass, n, cited, unverified, costUsd: cost, rows }, null, 1));
console.log(`결과: ${file.replace(`${ROOT}/`, '')}`);
