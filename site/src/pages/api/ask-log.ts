/**
 * 최근 질문 목록 (공개): GET /api/ask-log[?cursor=]
 *  - /api/ask 가 KV에 남긴 asklog:* 를 최신순으로 읽고, 같은 질문(qk)은 가장 최근 답 하나로 합친다
 *  - 질문마다 물어본 횟수(askcount), 👍/👎(askvote), 지난 일정 여부(until < 오늘)
 *  - 첫 쪽에는 "오늘 기준 데이터" 카드용 통계(ask:stats)도 같이
 */
import type { APIRoute } from 'astro';
import type { KV } from '../../lib/ask-shared';

interface Log { id?: string; qk?: string; q: string; a: string; at: string; category?: string; sources?: { title: string; url: string; kind?: string; date?: string }[]; until?: string | null; notFound?: boolean; warn?: boolean; cached?: boolean }
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'public, max-age=30' } });

export const GET: APIRoute = async ({ url, locals }) => {
  const kv = (locals.runtime?.env as { REPORTS?: KV } | undefined)?.REPORTS;
  if (!kv?.list) return json({ items: [], next: null, stats: null });
  const cursor = url.searchParams.get('cursor') ?? undefined;
  const page = await kv.list({ prefix: 'asklog:', limit: 60, cursor });
  const logs = (await Promise.all(page.keys.map((k) => kv.get(k.name)))).flatMap((v) => {
    try { return v ? [JSON.parse(v) as Log] : []; } catch { return []; }
  });
  // 같은 질문은 가장 최근 것 하나만 (예전 기록은 qk가 없어서 질문 글자로)
  const seen = new Set<string>();
  const groups = logs.filter((l) => { const k = l.qk ?? l.q; if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 30);
  const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
  const items = await Promise.all(groups.map(async (l) => {
    const [count, up, down] = l.qk ? await Promise.all([kv.get(`askcount:${l.qk}`), kv.get(`askvote:${l.qk}:up`), kv.get(`askvote:${l.qk}:down`)]) : [null, null, null];
    const ups = Number(up ?? 0), downs = Number(down ?? 0);
    return {
      q: l.q, a: l.a, at: l.at, category: l.category ?? '기타', sources: l.sources ?? [], count: Math.max(1, Number(count ?? 1)), ups, downs,
      state: l.notFound ? 'notfound' : l.until && l.until < today ? 'expired' : downs >= 3 && downs > ups ? 'check' : 'ai',
      warn: Boolean(l.warn),
    };
  }));
  const stats = cursor ? null : await kv.get('ask:stats').then((v) => (v ? JSON.parse(v) : null)).catch(() => null);
  return json({ items, next: page.list_complete ? null : page.cursor ?? null, stats });
};
