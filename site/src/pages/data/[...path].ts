// /data/events.json 등: Supabase 공개 버킷의 최신 파일을 그대로 넘긴다 (배포 없이 최신 데이터)
import type { APIRoute } from 'astro';
import { fetchPublic } from '../../lib/data';

export const GET: APIRoute = async ({ params, locals }) => {
  const res = await fetchPublic(locals, String(params.path ?? '')).catch(() => null);
  if (!res) return new Response('없는 데이터예요', { status: 404 });
  return new Response(res.body, { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'public, max-age=60' } });
};
