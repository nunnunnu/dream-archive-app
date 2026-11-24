// /data/events.json 등: Supabase 공개 버킷의 최신 파일을 넘긴다 (배포 없이 최신 데이터)
// 일정·소식·시리즈·아카이브 파일은 운영자 수정(어드민 "데이터 고치기")을 덧씌워서 준다
import type { APIRoute } from 'astro';
import { fetchPublic, loadPublic } from '../../lib/data';
import { isEditablePath } from '../../lib/edits';

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'public, max-age=60' };

export const GET: APIRoute = async ({ params, locals }) => {
  const path = String(params.path ?? '');
  if (isEditablePath(path)) {
    const data = await loadPublic<unknown>(locals, path, null).catch(() => null);
    if (data == null) return new Response('없는 데이터예요', { status: 404 });
    return new Response(JSON.stringify(data), { headers: JSON_HEADERS });
  }
  const res = await fetchPublic(locals, path).catch(() => null);
  if (!res) return new Response('없는 데이터예요', { status: 404 });
  return new Response(res.body, { headers: JSON_HEADERS });
};
