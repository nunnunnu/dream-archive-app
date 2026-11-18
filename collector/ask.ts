/**
 * 팬 질문 에이전트 시험판: npm run ask -- "다음주 음중 사녹 어떻게 가?" [--today=2026-11-17]
 */
import './lib/env.ts';
import { askQuestion } from './lib/ask.ts';
import { Budget } from './lib/budget.ts';
import { JsonRepo } from './lib/repo.ts';

const question = process.argv.slice(2).filter((a) => !a.startsWith('--')).join(' ').trim();
const today = process.argv.find((a) => a.startsWith('--today='))?.split('=')[1];
if (!question) {
  console.error('사용: npm run ask -- "질문" [--today=YYYY-MM-DD]');
  process.exit(1);
}
const repo = new JsonRepo();
const budget = await new Budget(repo, new Date()).load();
if (!budget.canSpend()) {
  console.error('이번 달 AI 예산을 다 써서 답할 수 없어요');
  process.exit(1);
}
const r = await askQuestion(question, { repo, budget, today, log: console.log });
await budget.save();
console.log(`\n${r.answer}\n\n출처`);
for (const s of r.sources) console.log(`  [${s.id}] ${s.title} → ${s.url}`);
if (r.unverified.length) console.log(`\n⚠ 자료에서 확인되지 않은 날짜·시간: ${r.unverified.join(', ')} (공지 확인 필요)`);
console.log(`\n(검색: 일정 ${r.stats.events}개 · 문서 ${r.stats.docs}개 (문단 ${r.stats.chunks}개) · AI 2번 약 ${Math.round(r.stats.costUsd * 1400 * 10) / 10}원 · ${r.stats.model})`);
