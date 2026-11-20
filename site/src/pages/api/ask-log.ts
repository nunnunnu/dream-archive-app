/**
 * 최근 질문 목록 (공개): /api/ask 가 KV에 남긴 asklog:* 를 최신순으로 30개씩.
 * 키가 거꾸로 쓴 시각이라 KV 목록 순서(오름차순)가 곧 최신순이다. ?cursor= 로 다음 쪽.
 */
import type { APIRoute } from 'astro';

interface KV {
  get(key: string): Promise<string | null>;
  list(opts: { prefix: string; limit?: number; cursor?: string }): Promise<{ keys: { name: string }[]; list_complete: boolean; cursor?: string }>;
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'public, max-age=30' } });

export const GET: APIRoute = async ({ url, locals }) => {
  const kv = (locals.runtime?.env as { REPORTS?: KV } | undefined)?.REPORTS;
  if (!kv) return json({ items: [], next: null });
  const page = await kv.list({ prefix: 'asklog:', limit: 30, cursor: url.searchParams.get('cursor') ?? undefined });
  const items = (await Promise.all(page.keys.map((k) => kv.get(k.name)))).flatMap((v) => {
    try { return v ? [JSON.parse(v) as { q: string; a: string; at: string; sources?: { title: string; url: string }[] }] : []; } catch { return []; }
  });
  return json({ items, next: page.list_complete ? null : page.cursor ?? null });
};
