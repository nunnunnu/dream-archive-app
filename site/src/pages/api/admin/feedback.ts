/**
 * 어드민 물어보기 👎 확인 (로그인한 운영자만, middleware.ts가 확인)
 *  GET  /api/admin/feedback?days=14   최근 👎 평가를 같은 질문끼리 묶어서
 *  POST /api/admin/feedback {id, mark: 'seen'|'eval'|'clear'}
 *       eval = 평가 세트 후보로 (npm run ask:feedback -- --to-eval 이 이것만 모은다), seen = 확인함
 */
import type { APIRoute } from 'astro';
import { questionKey } from '../../../lib/ask-shared';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
interface Item { id: string; rating: 'up' | 'down'; at: string; reason: string; note: string; question: string; answer: string; sources: { id: string; url: string }[] }
const TTL = 180 * 86400;

export const GET: APIRoute = async ({ url, locals }) => {
  const kv = locals.runtime?.env?.REPORTS;
  if (!kv) return json({ ok: false, error: 'KV가 없어요' }, 503);
  const days = Math.min(60, Math.max(1, Number(url.searchParams.get('days') ?? 14) || 14));
  const keys: string[] = [];
  for (let i = 0; i < days; i++) {
    const day = new Date(Date.now() - i * 864e5).toISOString().slice(0, 10);
    let cursor: string | undefined;
    do {
      const page = await kv.list({ prefix: `askfb:${day}:`, limit: 1000, cursor });
      keys.push(...page.keys.map((k) => k.name));
      cursor = page.list_complete ? undefined : page.cursor;
    } while (cursor);
  }
  const items = (await Promise.all(keys.map((k) => kv.get<Item>(k, 'json').catch(() => null)))).filter((x): x is Item => Boolean(x?.id));
  const down = items.filter((x) => x.rating === 'down');
  const marks = await Promise.all(down.map((x) => kv.get(`askfb-review:${x.id}`)));
  const groups = new Map<string, { qk: string; question: string; items: (Item & { mark: string | null })[] }>();
  for (const [i, x] of down.entries()) {
    const qk = await questionKey(x.question || x.id);
    const g = groups.get(qk) ?? { qk, question: x.question, items: [] };
    g.items.push({ ...x, mark: marks[i] });
    groups.set(qk, g);
  }
  const list = [...groups.values()]
    .map((g) => ({ ...g, items: g.items.sort((a, b) => b.at.localeCompare(a.at)) }))
    .sort((a, b) => Number(a.items.every((x) => x.mark)) - Number(b.items.every((x) => x.mark)) || b.items[0].at.localeCompare(a.items[0].at));
  return json({ ok: true, days, total: items.length, up: items.length - down.length, down: down.length, groups: list });
};

export const POST: APIRoute = async ({ request, locals }) => {
  const kv = locals.runtime?.env?.REPORTS;
  if (!kv) return json({ ok: false, error: 'KV가 없어요' }, 503);
  let b: { id?: unknown; ids?: unknown; mark?: unknown };
  try { b = await request.json(); } catch { return json({ ok: false, error: '형식이 올바르지 않아요' }, 400); }
  const ids = (Array.isArray(b.ids) ? b.ids : [b.id]).filter((v): v is string => typeof v === 'string' && /^[\w-]{8,40}$/.test(v)).slice(0, 50);
  const mark = b.mark === 'seen' || b.mark === 'eval' || b.mark === 'clear' ? b.mark : null;
  if (!ids.length || !mark) return json({ ok: false, error: '형식이 올바르지 않아요' }, 400);
  await Promise.all(ids.map((id) => (mark === 'clear' ? kv.delete(`askfb-review:${id}`) : kv.put(`askfb-review:${id}`, mark, { expirationTtl: TTL }))));
  return json({ ok: true });
};
