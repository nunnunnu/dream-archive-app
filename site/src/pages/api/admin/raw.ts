/**
 * 어드민 "데이터 고치기"용: 수집기가 올린 데이터 파일 그대로 (운영자 수정 없이). 어드민 화면이 수정을 직접 덧씌워 보여 준다.
 *  GET /api/admin/raw?path=events.json
 */
import type { APIRoute } from 'astro';
import { fetchPublic } from '../../../lib/data';
import { isEditablePath } from '../../../lib/edits';

export const GET: APIRoute = async ({ url, locals }) => {
  const path = url.searchParams.get('path') ?? '';
  if (!isEditablePath(path) && path !== 'members.json') return new Response(JSON.stringify({ ok: false, error: '고칠 수 없는 파일이에요' }), { status: 400 });
  const res = await fetchPublic(locals, path).catch(() => null);
  if (!res) return new Response('null', { headers: { 'content-type': 'application/json; charset=utf-8' } });
  return new Response(res.body, { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
};
