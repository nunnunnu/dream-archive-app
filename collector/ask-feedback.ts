/**
 * 사이트 질문 답변 평가(👍/👎) 모아 보기: npm run ask:feedback [-- --days=7] [--to-eval]
 *   --to-eval  👎 받은 질문을 eval/feedback-candidates.json 에 모은다 (정답을 채워 eval/ask-questions.json 으로 옮기면 평가 세트가 된다)
 * 필요한 값(.env): CLOUDFLARE_ACCOUNT_ID, CF_KV_REPORTS_ID, KV 읽기 권한이 있는 토큰(CF_API_TOKEN 또는 CLOUDFLARE_API_TOKEN)
 */
import './lib/env.ts';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './lib/store.ts';

const account = process.env.CF_ACCOUNT_ID ?? process.env.CLOUDFLARE_ACCOUNT_ID;
const token = process.env.CF_API_TOKEN ?? process.env.CLOUDFLARE_API_TOKEN;
const ns = process.env.CF_KV_REPORTS_ID;
if (!account || !token || !ns) {
  console.error('CLOUDFLARE_ACCOUNT_ID, CF_KV_REPORTS_ID, KV 권한 토큰이 필요해요 (.env)');
  process.exit(1);
}
const days = Number(process.argv.find((a) => a.startsWith('--days='))?.split('=')[1] ?? 7);
const kv = (path: string) => fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/storage/kv/namespaces/${ns}${path}`, { headers: { Authorization: `Bearer ${token}` } });

interface Item { id: string; rating: 'up' | 'down'; at: string; reason: string; note: string; question: string; answer: string; sources: { id: string; url: string }[] }
const items: Item[] = [];
for (let i = 0; i < days; i++) {
  const day = new Date(Date.now() - i * 864e5).toISOString().slice(0, 10);
  let cursor = '';
  do {
    const res = await kv(`/keys?prefix=${encodeURIComponent(`askfb:${day}:`)}${cursor ? `&cursor=${cursor}` : ''}`);
    const d = (await res.json()) as { result: { name: string }[]; result_info?: { cursor?: string } };
    for (const k of d.result ?? []) {
      const v = await kv(`/values/${encodeURIComponent(k.name)}`);
      if (v.ok) items.push((await v.json()) as Item);
    }
    cursor = d.result_info?.cursor ?? '';
  } while (cursor);
}
const up = items.filter((x) => x.rating === 'up').length;
const down = items.filter((x) => x.rating === 'down');
console.log(`최근 ${days}일 평가 ${items.length}개 · 👍 ${up} · 👎 ${down.length}${items.length ? ` (만족 ${Math.round((up / items.length) * 100)}%)` : ''}`);
const reasons = new Map<string, number>();
for (const x of down) reasons.set(x.reason || '이유 없음', (reasons.get(x.reason || '이유 없음') ?? 0) + 1);
if (down.length) console.log(`👎 이유: ${[...reasons].map(([r, n]) => `${r} ${n}`).join(' · ')}`);
for (const x of down.slice(0, 20)) console.log(`\n👎 ${x.at.slice(0, 16)} [${x.reason || '-'}] ${x.question}${x.note ? `\n   의견: ${x.note}` : ''}\n   답: ${x.answer.slice(0, 160).replace(/\n/g, ' ')}`);

if (process.argv.includes('--to-eval') && down.length) {
  const file = join(ROOT, 'eval', 'feedback-candidates.json');
  const prev = existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as { id: string }[]) : [];
  const seen = new Set(prev.map((p) => p.id));
  const add = down.filter((x) => !seen.has(x.id)).map((x) => ({ id: x.id, q: x.question, reason: x.reason, note: x.note, badAnswer: x.answer, at: x.at, todo: '정답 조건(all/any/unknown)을 채워 ask-questions.json 으로 옮기기' }));
  writeFileSync(file, JSON.stringify([...prev, ...add], null, 1));
  console.log(`\n평가 후보 ${add.length}개 추가 → eval/feedback-candidates.json`);
}
