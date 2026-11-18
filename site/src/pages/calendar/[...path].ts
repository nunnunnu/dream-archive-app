// 캘린더 구독(.ics): 구독 주소는 그대로 두고 최신 파일을 넘긴다
import type { APIRoute } from 'astro';
import { fetchPublic } from '../../lib/data';

export const GET: APIRoute = async ({ params, locals }) => {
  const res = await fetchPublic(locals, `calendar/${params.path ?? ''}`).catch(() => null);
  if (!res) return new Response('없는 캘린더예요', { status: 404 });
  return new Response(res.body, { headers: { 'content-type': 'text/calendar; charset=utf-8', 'cache-control': 'public, max-age=300' } });
};
