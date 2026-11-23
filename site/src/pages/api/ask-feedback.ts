/**
 * 질문 답변 평가 (Astro API, Cloudflare에서 실행): POST /api/ask-feedback
 *   { id, rating: 'up' | 'down', reason?, note?, question, answer, sources }
 * 평가는 KV(REPORTS)에 180일 동안 보관한다. 모아서 평가 세트(eval/ask-questions.json)에 넣는다 (npm run ask:feedback).
 * 개인정보는 받지 않는다. 같은 IP는 1분에 20번까지.
 */
import type { APIRoute } from 'astro';
import { questionKey } from '../../lib/ask-shared';
interface KV {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>;
}
interface Env { REPORTS?: KV }

const REASONS = ['틀린 정보', '날짜·시간 오류', '자료에 있는데 모른대요', '출처가 엉뚱해요', '답이 너무 길어요', '기타'];
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
const clip = (v: unknown, n: number) => (typeof v === 'string' ? v.trim().slice(0, n) : '');

async function sha(text: string) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
}

export const POST: APIRoute = async ({ request, locals }) => {
  const env = (locals.runtime?.env ?? {}) as Env;
  if (!env.REPORTS) return json({ ok: false, error: '지금은 평가를 받을 수 없어요' }, 503);
  let b: Record<string, unknown>;
  try {
    b = await request.json();
  } catch {
    return json({ ok: false, error: '형식이 올바르지 않아요' }, 400);
  }
  const rating = b.rating === 'up' || b.rating === 'down' ? b.rating : null;
  const id = clip(b.id, 40);
  if (!rating || !/^[\w-]{8,40}$/.test(id)) return json({ ok: false, error: '형식이 올바르지 않아요' }, 400);
  const ip = await sha(request.headers.get('cf-connecting-ip') ?? 'unknown');
  const rateKey = `askfb:rate:${ip}:${new Date().toISOString().slice(0, 16)}`;
  const count = Number((await env.REPORTS.get(rateKey)) ?? 0);
  if (count >= 20) return json({ ok: false, error: '잠시 뒤에 다시 시도해 주세요' }, 429);
  await env.REPORTS.put(rateKey, String(count + 1), { expirationTtl: 120 });

  const sources = Array.isArray(b.sources) ? b.sources.slice(0, 10).map((s) => ({ id: clip((s as { id?: unknown }).id, 6), url: clip((s as { url?: unknown }).url, 300) })) : [];
  const item = {
    id, rating, at: new Date().toISOString(),
    reason: REASONS.includes(clip(b.reason, 30)) ? clip(b.reason, 30) : '',
    note: clip(b.note, 300),
    question: clip(b.question, 200),
    answer: clip(b.answer, 3000),
    sources,
  };
  await env.REPORTS.put(`askfb:${item.at.slice(0, 10)}:${id}`, JSON.stringify(item), { expirationTtl: 180 * 86400 });
  // 질문별 👍/👎 개수 (최근 질문 목록 표시, 👎 3개 넘게 쌓이면 "답변 확인 필요" + 재사용 대신 새로 답함). 같은 답에는 한 번만
  if (item.question) {
    const once = `askvote:once:${id}`;
    if (!(await env.REPORTS.get(once))) {
      const vk = `askvote:${await questionKey(item.question)}:${rating}`;
      const n = Number((await env.REPORTS.get(vk)) ?? 0) + 1;
      await Promise.all([env.REPORTS.put(vk, String(n), { expirationTtl: 90 * 86400 }), env.REPORTS.put(once, '1', { expirationTtl: 90 * 86400 })]);
    }
  }
  return json({ ok: true });
};
