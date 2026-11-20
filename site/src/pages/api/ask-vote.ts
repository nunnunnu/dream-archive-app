/**
 * 최근 질문 👍/👎 (다른 팬도 누를 수 있음): POST /api/ask-vote { qk, rating: 'up' | 'down' }
 *  - 같은 사람(IP 해시)은 질문 하나에 하루 한 번만. IP는 해시로만, 하루 뒤 사라짐
 *  - 👎가 3개 넘게(👍보다 많이) 쌓이면 /api/ask 가 "답변 확인 필요"로 보고 저장된 답 대신 새로 답한다
 */
import type { APIRoute } from 'astro';
import { sha, type KV } from '../../lib/ask-shared';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });

export const POST: APIRoute = async ({ request, locals }) => {
  const kv = (locals.runtime?.env as { REPORTS?: KV } | undefined)?.REPORTS;
  if (!kv) return json({ ok: false, error: '아직 준비 중이에요' }, 503);
  let b: { qk?: unknown; rating?: unknown };
  try { b = await request.json(); } catch { return json({ ok: false, error: '형식이 올바르지 않아요' }, 400); }
  const qk = typeof b.qk === 'string' && /^[0-9a-f]{16}$/.test(b.qk) ? b.qk : null;
  const rating = b.rating === 'up' || b.rating === 'down' ? b.rating : null;
  if (!qk || !rating) return json({ ok: false, error: '형식이 올바르지 않아요' }, 400);
  const day = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
  const ip = await sha(request.headers.get('cf-connecting-ip') ?? 'unknown');
  const once = `askvote:ip:${ip}:${qk}:${day}`;
  const read = async () => ({ ups: Number((await kv.get(`askvote:${qk}:up`)) ?? 0), downs: Number((await kv.get(`askvote:${qk}:down`)) ?? 0) });
  if (await kv.get(once)) return json({ ok: false, error: '오늘은 이미 평가했어요', ...(await read()) }, 409);
  const key = `askvote:${qk}:${rating}`;
  const n = Number((await kv.get(key)) ?? 0) + 1;
  await Promise.all([kv.put(key, String(n), { expirationTtl: 90 * 86400 }), kv.put(once, '1', { expirationTtl: 86400 })]);
  return json({ ok: true, ...(await read()) });
};
